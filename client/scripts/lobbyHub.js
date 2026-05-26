// Lobby "hub stations" — walk-up zones in the lobby that open a per-slot panel
// (AI control, skins). Server places the zones and emits a per-PLAYER enter/exit
// edge to each player's own socket; the client renders the zones, a per-slot
// "press to open" prompt near each kart, and a per-slot panel driven seamlessly by
// keyboard / mouse / touch (primary) and per-controller (any slot). See
// docs/spikes/lobby-hub-architecture.md §3–§7.

// Decoded station zones for the current lobby: [{id, kind, x, y, radius, color}].
// Static for the lobby's life (sent once on startLobby / in the mid-join snapshot).
var lobbyStations = [];
// Room-wide AI override mirrored from the server: null = Auto (fill toward target),
// {enabled:false} = off, {enabled:true, count:N} = exactly N bots next race.
var lobbyAISetting = null;
// When WE last stepped the dial locally. The lobbyAIChanged broadcast echoes our own
// emits back a few ms later; without this, an echo of an earlier step can land
// mid-burst and reset the dial to a stale value (so 4 quick steps net only 2). We
// ignore broadcasts within this window of a local change — our optimistic value is
// authoritative while actively stepping, and the server agrees (last-writer-wins).
var lobbyAILocalAt = 0;
var LOBBY_AI_ECHO_MS = 600;
// Per-slot HUD hit areas, rebuilt every frame in drawLobbyHubHud (logical coords).
// slot -> { prompt: rect|null, options: [{rect, action}], close: rect|null }.
var stationHudHit = {};

// --- decode / lifecycle ------------------------------------------------------

// Decode the lobbyStations payload ([id, kind, x, y, r, color] tuples) into the
// render-friendly list. Tolerates a null/empty payload (plain lobby, no stations).
function applyLobbyStations(payload) {
    lobbyStations = [];
    if (payload == null) {
        return;
    }
    var arr = (typeof payload === "string") ? JSON.parse(payload) : payload;
    if (!Array.isArray(arr)) {
        return;
    }
    for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        lobbyStations.push({ id: s[0], kind: s[1], x: s[2], y: s[3], radius: s[4], color: s[5] });
    }
}

// Tear the hub down when the lobby ends (startGated/startWaiting, or any state
// change away from the lobby): drop the zones, clear every slot's proximity latch
// and close any open panel so a stale prompt/panel can't survive into the race.
function lobbyHubReset() {
    lobbyStations = [];
    stationHudHit = {};
    if (typeof localPlayers === "undefined") {
        return;
    }
    for (var s = 0; s < localPlayers.length; s++) {
        if (localPlayers[s]) {
            localPlayers[s].nearStation = null;
            localPlayers[s].stationPanel = null;
        }
    }
}

function stationById(id) {
    for (var i = 0; i < lobbyStations.length; i++) {
        if (lobbyStations[i].id === id) {
            return lobbyStations[i];
        }
    }
    return null;
}

// --- per-slot enter/exit (set from the stationEnter/stationExit handlers) -----

function setSlotNearStation(slot, id) {
    var lp = localPlayers[slot];
    if (lp) {
        lp.nearStation = id;
    }
}
// Clear only if the exit is for the station the slot is currently latched to, so a
// late exit can't clobber a fresh enter into an adjacent zone. A null id force-clears.
function clearSlotNearStation(slot, id) {
    var lp = localPlayers[slot];
    if (!lp) {
        return;
    }
    if (id == null || lp.nearStation === id) {
        lp.nearStation = null;
    }
    if (lp.stationPanel && (id == null || lp.stationPanel.id === id)) {
        closeStationPanel(lp);
    }
}

// --- panel open / close / navigate / confirm (input-agnostic) ----------------

function openStationPanel(lp) {
    if (!lp || !lp.nearStation) {
        return;
    }
    var st = stationById(lp.nearStation);
    if (!st) {
        return;
    }
    var cursor = 0;
    if (st.kind === "skin") {
        // Start the cursor on the player's current colour so the picker opens "here".
        var pal = skinPalette();
        var cur = skinCurrentColor(lp);
        var idx = pal.indexOf(cur);
        cursor = (idx >= 0) ? idx : 0;
    }
    lp.stationPanel = { id: st.id, kind: st.kind, cursor: cursor };
    // Stop driving while configuring (mirrors the emoji-wheel open), and emit the
    // stop on this slot's own socket so the kart doesn't coast off the zone.
    if (typeof cancelMovementForSlot === "function") {
        cancelMovementForSlot(lp);
    }
}

function closeStationPanel(lp) {
    if (lp) {
        lp.stationPanel = null;
    }
}

// dx: -1/+1 horizontal step, dy: -1/+1 vertical (rows). The AI panel is a single
// horizontal stepper; the skin panel moves a cursor over the swatch grid.
function stationPanelNav(lp, dx, dy) {
    if (!lp || !lp.stationPanel) {
        return;
    }
    if (lp.stationPanel.kind === "ai") {
        if (dx !== 0) {
            adjustAILevel(lp, dx > 0 ? 1 : -1);
        }
        return;
    }
    if (lp.stationPanel.kind === "skin") {
        var pal = skinPalette();
        if (!pal.length) {
            return;
        }
        var i = lp.stationPanel.cursor || 0;
        i += dx + dy * SKIN_COLS;
        if (i < 0) { i = 0; }
        if (i > pal.length - 1) { i = pal.length - 1; }
        lp.stationPanel.cursor = i;
    }
}

// Confirm (A / Enter): AI changes apply live as you step, so confirm just
// dismisses; for the skin picker it commits the colour under the cursor.
function stationPanelConfirm(lp) {
    if (lp && lp.stationPanel && lp.stationPanel.kind === "skin") {
        var pal = skinPalette();
        stationPickSkin(lp, pal[lp.stationPanel.cursor || 0]);
        return;
    }
    closeStationPanel(lp);
}

// Map a pointer-hit action token to its effect. "pick:<hex>" commits a skin colour.
function stationPanelAction(lp, action) {
    if (action === "inc") {
        stationPanelNav(lp, 1, 0);
    } else if (action === "dec") {
        stationPanelNav(lp, -1, 0);
    } else if (action === "close") {
        closeStationPanel(lp);
    } else if (action != null && action.indexOf("pick:") === 0) {
        stationPickSkin(lp, action.slice(5));
    }
}

// --- AI station model --------------------------------------------------------

// Count the humans currently in the room (the lobby has no bots yet — they spawn
// at the race start — but exclude any named/AI entry defensively).
function lobbyHumanCount() {
    var n = 0;
    if (typeof playerList !== "undefined" && playerList) {
        for (var id in playerList) {
            if (playerList[id] && !playerList[id].isAI) { n++; }
        }
    }
    return n;
}
// Most bots you can request right now: the AI grid cap, but never more than the
// room has space for (humans + bots must fit maxPlayersInRoom). The server clamps
// the same way at spawn, so this just keeps the picker honest.
function aiMaxBots() {
    var hard = (typeof config !== "undefined" && config && config.aiRacers && config.aiRacers.maxGrid)
        ? config.aiRacers.maxGrid : 10;
    var cap = (typeof config !== "undefined" && config && config.maxPlayersInRoom) ? config.maxPlayersInRoom : 25;
    var room = cap - lobbyHumanCount();
    if (room < 0) { room = 0; }
    return Math.min(hard, room);
}
// Current dial position: null = Auto (untouched), 0 = Off, N = N bots.
function currentAILevel() {
    if (lobbyAISetting == null) {
        return null;
    }
    if (!lobbyAISetting.enabled) {
        return 0;
    }
    return lobbyAISetting.count;
}
function aiLevelLabel() {
    var lvl = currentAILevel();
    if (lvl == null) {
        return "Auto";
    }
    if (lvl <= 0) {
        return "Off";
    }
    return lvl + (lvl === 1 ? " bot" : " bots");
}
// The dial is an ordered scale so every state is reachable by stepping left/right:
//   index 0 = Auto, 1 = Off, 2 = 1 bot, 3 = 2 bots, … (max+2 positions total).
// This is what lets a player return to Auto after picking a number.
function aiDialIndex() {
    var lvl = currentAILevel(); // null = Auto, 0 = Off, N = N bots
    if (lvl == null) { return 0; }   // Auto
    if (lvl <= 0) { return 1; }      // Off
    return lvl + 1;                  // N bots
}
// Step the dial and push the resulting setting to the server on this slot's socket.
// Last-writer-wins; the lobbyAIChanged broadcast re-syncs every open panel + the
// join page, but we also update locally so the change reads instantly.
function adjustAILevel(lp, dir) {
    var max = aiMaxBots();
    var idx = aiDialIndex() + dir;
    if (idx < 0) { idx = 0; }
    if (idx > max + 1) { idx = max + 1; } // Auto, Off, then 1..max
    var payload;
    if (idx === 0) {
        payload = { auto: true };                          // Auto
        lobbyAISetting = null;
    } else if (idx === 1) {
        payload = { enabled: false, count: 0 };            // Off
        lobbyAISetting = payload;
    } else {
        payload = { enabled: true, count: idx - 1 };       // N bots
        lobbyAISetting = payload;
    }
    lobbyAILocalAt = Date.now(); // mark a local change so the echo doesn't reset us
    var sock = (lp && lp.socket) ? lp.socket : (typeof server !== "undefined" ? server : null);
    if (sock) {
        sock.emit("setLobbyAI", payload);
    }
}

// --- skin station model ------------------------------------------------------

var SKIN_COLS = 6; // swatches per row in the picker grid

function skinPalette() {
    return (typeof config !== "undefined" && config && Array.isArray(config.colorPalette))
        ? config.colorPalette : [];
}
// A player's authoritative colour is _serverColor when set (colour-blind assist
// remaps the displayed .color), else the live .color.
function playerServerColor(p) {
    return (p._serverColor != null) ? p._serverColor : p.color;
}
function skinCurrentColor(lp) {
    var p = (lp && lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
    return p ? playerServerColor(p) : null;
}
// Colours held by OTHER players (so the picker can grey them out — uniqueness is
// what keeps karts distinguishable, matching the server's setSkin rejection).
function skinTakenColors(lp) {
    var taken = {};
    if (typeof playerList === "undefined" || !playerList) {
        return taken;
    }
    var myId = lp ? lp.myID : null;
    for (var id in playerList) {
        if (id === String(myId)) {
            continue;
        }
        var col = playerServerColor(playerList[id]);
        if (col != null) {
            taken[col] = true;
        }
    }
    return taken;
}
// Commit a colour: skip no-ops and taken colours (server re-checks); emit on the
// slot's own socket. The change lands via the playerSkinChanged broadcast.
function stationPickSkin(lp, color) {
    if (!lp || color == null) {
        return;
    }
    if (color === skinCurrentColor(lp)) {
        return; // already mine
    }
    if (skinTakenColors(lp)[color]) {
        flagSkinRejected(lp.slot, color); // locally taken — flash without a round-trip
        return;
    }
    var sock = (lp.socket) ? lp.socket : (typeof server !== "undefined" ? server : null);
    if (sock) {
        sock.emit("setSkin", { color: color });
    }
}
// Flash a "taken" note on a slot's open skin panel for a short beat.
function flagSkinRejected(slot, color) {
    var lp = (typeof localPlayers !== "undefined") ? localPlayers[slot] : null;
    if (lp) {
        lp._skinRejectAt = Date.now();
    }
}

// --- rendering ---------------------------------------------------------------

// Forward-project a world point to the logical 1366x768 screen space, inverting
// nothing — this matches applyWorldTransform (identity on desktop, the dynamic
// zoom on touch). Used to anchor the HUD prompt/panel over the kart.
function lobbyProjectToScreen(wx, wy) {
    if (typeof worldView !== "undefined" && worldView && worldView.scale) {
        return {
            x: LOGICAL_WIDTH / 2 + (wx - worldView.cx) * worldView.scale,
            y: LOGICAL_HEIGHT / 2 + (wy - worldView.cy) * worldView.scale
        };
    }
    return { x: wx, y: wy };
}

// Hub styling reuses the game's OWN visual language instead of a foreign neon:
// the idle ring echoes the lobby's theme-ink dashed "practice area" frame
// (drawLobbyFloor), and the interactive accent is the game's goal gold — warm,
// already part of the palette, and high-contrast on the green/brown/blue/ice map.
// Walking into a zone lights it up gold (see the active state below).
var HUB_ACCENT = "#FFD700"; // goal gold — the "interactive / active" accent
function hubInk() {
    return (typeof themeColor === "function") ? themeColor("ink", "#ffffff") : "#ffffff";
}
function hubInkOutline() {
    return (typeof themeColor === "function") ? themeColor("inkOutline", "#000000") : "#000000";
}
function hubSurface() {
    return (typeof themeColor === "function") ? themeColor("surface", "#101216") : "#101216";
}
// True when any player is standing in the zone — drives the "lights up" feedback.
function stationOccupied(s) {
    if (typeof playerList === "undefined" || !playerList) {
        return false;
    }
    for (var id in playerList) {
        var p = playerList[id];
        if (p == null || p.x == null) { continue; }
        var pr = (p.radius != null) ? p.radius : 12;
        var dx = p.x - s.x, dy = p.y - s.y;
        if (dx * dx + dy * dy <= (s.radius + pr * 0.5) * (s.radius + pr * 0.5)) {
            return true;
        }
    }
    return false;
}

function stationTitle(kind) {
    if (kind === "ai") { return "AI Bots"; }
    if (kind === "skin") { return "Skins"; }
    return "Station";
}
function stationGlyph(kind) {
    if (kind === "ai") { return "🤖"; }
    if (kind === "skin") { return "🎨"; }
    return "⚙";
}

// WORLD pass: the floor zone markers (camera-attached, like the start button).
function drawLobbyStationZones() {
    if (typeof config === "undefined" || config == null || currentState !== config.stateMap.lobby) {
        return;
    }
    if (!lobbyStations.length || typeof gameContext === "undefined" || !gameContext) {
        return;
    }
    var t = Date.now() / 1000;
    for (var i = 0; i < lobbyStations.length; i++) {
        var s = lobbyStations[i];
        if (!camera.inBounds({ x: s.x, y: s.y, radius: s.radius })) {
            continue;
        }
        var cx = s.x + camera.getCameraX();
        var cy = s.y + camera.getCameraY();
        var active = stationOccupied(s);
        var ink = hubInk();
        var outline = hubInkOutline();
        gameContext.save();
        // Filled disc: the panel surface tint at idle (reads as a defined area), warm
        // gold when a player is standing in it.
        gameContext.globalAlpha = active ? 0.22 : 0.10;
        gameContext.fillStyle = active ? HUB_ACCENT : hubSurface();
        gameContext.beginPath();
        gameContext.arc(cx, cy, s.radius, 0, 2 * Math.PI);
        gameContext.fill();
        // Ring. Idle: a theme-ink "marching-dashes" ring that matches the lobby's
        // dashed practice-area frame (so it reads as part of the room, not a UI
        // sticker). Active: a solid, glowing gold ring — the zone clearly lights up
        // the moment a player steps in.
        gameContext.globalAlpha = 1;
        if (active) {
            gameContext.shadowColor = HUB_ACCENT;
            gameContext.shadowBlur = 18;
            gameContext.strokeStyle = HUB_ACCENT;
            gameContext.lineWidth = 5;
            gameContext.setLineDash([]);
        } else {
            gameContext.shadowColor = outline;
            gameContext.shadowBlur = 6;
            gameContext.strokeStyle = ink;
            gameContext.lineWidth = 3.5;
            gameContext.setLineDash([14, 10]);
            gameContext.lineDashOffset = -(t * 22) % 24;
        }
        gameContext.beginPath();
        gameContext.arc(cx, cy, s.radius, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.setLineDash([]);
        gameContext.shadowBlur = 0;
        // Centre glyph — gently hovers (bobs) so it reads as a beckoning marker; a
        // wider bob + a soft gold under-glow when active. Label sits below, in the
        // game's ink/ink-outline text treatment (matches other on-board labels).
        var bob = Math.sin(t * 2.4 + i * 0.8) * (active ? 5 : 3);
        gameContext.globalAlpha = 1;
        gameContext.textAlign = "center";
        gameContext.textBaseline = "middle";
        if (active) {
            gameContext.shadowColor = HUB_ACCENT;
            gameContext.shadowBlur = 10;
        }
        gameContext.font = "27px sans-serif";
        gameContext.fillText(stationGlyph(s.kind), cx, cy - 8 + bob);
        gameContext.shadowBlur = 0;
        gameContext.font = "bold 15px sans-serif";
        gameContext.lineWidth = 3;
        gameContext.strokeStyle = outline;
        gameContext.strokeText(stationTitle(s.kind), cx, cy + 20);
        gameContext.fillStyle = ink;
        gameContext.fillText(stationTitle(s.kind), cx, cy + 20);
        gameContext.restore();
    }
}

// HUD pass (logical coords): per-slot prompt or open panel, anchored over each
// local kart. Rebuilds the per-slot hit areas each frame.
function drawLobbyHubHud() {
    stationHudHit = {};
    if (typeof config === "undefined" || config == null || currentState !== config.stateMap.lobby) {
        return;
    }
    if (typeof localPlayers === "undefined" || typeof gameContext === "undefined" || !gameContext) {
        return;
    }
    for (var slot = 0; slot < localPlayers.length; slot++) {
        var lp = localPlayers[slot];
        if (!lp) {
            continue;
        }
        var kart = (lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
        if (kart == null) {
            continue;
        }
        var sp = lobbyProjectToScreen(kart.x, kart.y);
        if (lp.stationPanel) {
            drawStationPanel(lp, sp);
        } else if (lp.nearStation) {
            drawStationPrompt(lp, sp);
        }
    }
    // The AI setting is room-wide, so show it persistently to the whole lobby (not
    // just inside an open panel) — everyone sees a change before the race starts.
    drawLobbyAIStatus();
}

// The grid total Auto fills toward (humans + bots ≈ autoTarget).
function aiAutoTarget() {
    return (typeof config !== "undefined" && config && config.aiRacers && config.aiRacers.autoTarget)
        ? config.aiRacers.autoTarget : 8;
}
// How many bots Auto will actually spawn for the current human count (what the
// banner shows so players see the count rise/fall as people join and leave).
function autoEffectiveBots() {
    var n = aiAutoTarget() - lobbyHumanCount();
    if (n < 0) { n = 0; }
    return Math.min(n, aiMaxBots());
}

// A fixed top-centre banner showing the live room-wide AI setting during the lobby.
// Synced to every client (lobbyAIChanged / the gameState snapshot), so all players
// read the same value. Styled with the game's own panel theme (surface + ink) so it
// sits in the world rather than reading as a foreign UI sticker.
function drawLobbyAIStatus() {
    var lvl = currentAILevel();
    var text;
    if (lvl == null) {
        var auto = autoEffectiveBots();
        text = "🤖 AI bots next race: " + auto + (auto === 1 ? " bot" : " bots") + " (auto)";
    } else if (lvl <= 0) {
        text = "🤖 AI bots next race: Off";
    } else {
        var eff = Math.min(lvl, aiMaxBots());
        text = "🤖 AI bots next race: " + eff + (eff === 1 ? " bot" : " bots");
    }
    var ink = hubInk();
    gameContext.save();
    gameContext.font = "bold 16px sans-serif";
    var tw = gameContext.measureText(text).width;
    var w = tw + 30;
    var h = 32;
    var x = (LOGICAL_WIDTH - w) / 2;
    var y = 92; // just under the GameID/Players/Round info row
    gameContext.globalAlpha = 0.92;
    gameContext.fillStyle = hubSurface();
    lhRoundRect(gameContext, x, y, w, h, 9);
    gameContext.fill();
    gameContext.globalAlpha = 1;
    gameContext.lineWidth = 2;
    gameContext.strokeStyle = ink;
    gameContext.stroke();
    gameContext.fillStyle = ink;
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    gameContext.fillText(text, LOGICAL_WIDTH / 2, y + h / 2);
    gameContext.restore();
}

function lhRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
function lhClamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
function lhPointIn(r, x, y) {
    return r != null && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
// The confirm-button glyph for a given pad type (Xbox A / PlayStation cross),
// reusing gamepad.js's mapping when present.
function padConfirmGlyph(type) {
    if (typeof attackGlyphFor === "function") {
        return attackGlyphFor(type);
    }
    return type === "playstation" ? "✕" : "A";
}
// The open hint for a slot, matched to the input method it's actually using:
// a controller shows its face-button glyph, touch shows "Tap", keyboard "Press E".
function slotOpenHint(lp) {
    var padActive = (typeof activeInputMethod !== "undefined" && activeInputMethod === "pad");
    // Non-primary slots are always pad players; the primary follows the live method.
    if (!lp.isPrimary || padActive) {
        var type = (lp && lp.padType) ? lp.padType : (typeof gamepadType !== "undefined" ? gamepadType : "generic");
        return padConfirmGlyph(type);
    }
    if (typeof activeInputMethod !== "undefined" && activeInputMethod === "touch") {
        return "Tap";
    }
    if (typeof isTouchScreen !== "undefined" && isTouchScreen) {
        return "Tap";
    }
    return "Press E";
}

function drawStationPrompt(lp, sp) {
    var st = stationById(lp.nearStation);
    if (!st) {
        return;
    }
    var hint = slotOpenHint(lp);
    var label = hint + "  •  " + stationTitle(st.kind);
    gameContext.save();
    gameContext.font = "bold 15px sans-serif";
    var tw = gameContext.measureText(label).width;
    var w = tw + 24;
    var h = 30;
    var x = lhClamp(sp.x - w / 2, 6, LOGICAL_WIDTH - w - 6);
    var y = lhClamp(sp.y - 78, 6, LOGICAL_HEIGHT - h - 6);
    gameContext.globalAlpha = 0.92;
    gameContext.fillStyle = "rgba(20,22,28,0.9)";
    lhRoundRect(gameContext, x, y, w, h, 8);
    gameContext.fill();
    gameContext.lineWidth = 2;
    gameContext.strokeStyle = HUB_ACCENT;
    gameContext.stroke();
    gameContext.globalAlpha = 1;
    gameContext.fillStyle = "#fff";
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    gameContext.fillText(label, x + w / 2, y + h / 2);
    gameContext.restore();
    // Only the primary opens via pointer (touch/mouse); pad slots open with Ⓐ.
    if (lp.isPrimary) {
        stationHudHit[lp.slot] = { prompt: { x: x, y: y, w: w, h: h }, options: [], close: null };
    }
}

function drawStationPanel(lp, sp) {
    var kind = lp.stationPanel.kind;
    var w = 250;
    var h = 132;
    if (kind === "skin") {
        var rows = Math.max(1, Math.ceil(skinPalette().length / SKIN_COLS));
        w = 272;
        h = 78 + rows * 34;
    }
    var x = lhClamp(sp.x - w / 2, 8, LOGICAL_WIDTH - w - 8);
    var y = lhClamp(sp.y - h - 46, 8, LOGICAL_HEIGHT - h - 8);
    var tint = (lp.myID != null && playerList && playerList[lp.myID]) ? playerList[lp.myID].color : "#fff";
    var hit = { prompt: null, options: [], close: null };

    gameContext.save();
    gameContext.globalAlpha = 0.96;
    gameContext.fillStyle = "rgba(18,20,26,0.96)";
    lhRoundRect(gameContext, x, y, w, h, 12);
    gameContext.fill();
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = tint;
    gameContext.stroke();
    gameContext.globalAlpha = 1;

    // Title.
    gameContext.fillStyle = "#fff";
    gameContext.textAlign = "left";
    gameContext.textBaseline = "middle";
    gameContext.font = "bold 18px sans-serif";
    gameContext.fillText(stationGlyph(kind) + "  " + stationTitle(kind), x + 14, y + 22);

    // Close (✕) — top-right.
    var cl = { x: x + w - 30, y: y + 8, w: 24, h: 24 };
    gameContext.font = "bold 18px sans-serif";
    gameContext.textAlign = "center";
    gameContext.fillStyle = "#bbb";
    gameContext.fillText("✕", cl.x + cl.w / 2, cl.y + cl.h / 2 + 1);
    hit.close = cl;

    if (kind === "ai") {
        drawAIPanelBody(x, y, w, h, hit);
    } else if (kind === "skin") {
        drawSkinPanelBody(lp, x, y, w, h, hit);
    } else {
        drawStubPanelBody(x, y, w, h, "Coming soon");
    }
    gameContext.restore();
    stationHudHit[lp.slot] = hit;
}

// AI panel body: a ◄ value ► stepper plus the "applies next race" caption.
function drawAIPanelBody(x, y, w, h, hit) {
    var midY = y + 70;
    // value text, centred
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    gameContext.fillStyle = "#fff";
    gameContext.font = "bold 24px sans-serif";
    gameContext.fillText(aiLevelLabel(), x + w / 2, midY);
    // ◄ / ► buttons
    var dec = { x: x + 16, y: midY - 20, w: 40, h: 40 };
    var inc = { x: x + w - 56, y: midY - 20, w: 40, h: 40 };
    gameContext.font = "bold 28px sans-serif";
    gameContext.fillStyle = "#9cdcff";
    gameContext.fillText("◄", dec.x + dec.w / 2, dec.y + dec.h / 2);
    gameContext.fillText("►", inc.x + inc.w / 2, inc.y + inc.h / 2);
    hit.options.push({ rect: dec, action: "dec" });
    hit.options.push({ rect: inc, action: "inc" });
    // caption
    gameContext.fillStyle = "#9aa";
    gameContext.font = "12px sans-serif";
    gameContext.fillText("applies next race", x + w / 2, y + h - 16);
}

// Skin picker body: a grid of palette swatches. The cursor is ringed white, the
// player's current colour gets a check, colours held by others are greyed +
// crossed and can't be picked. Each swatch is a "pick:<hex>" pointer hit target.
function drawSkinPanelBody(lp, x, y, w, h, hit) {
    var pal = skinPalette();
    if (!pal.length) {
        drawStubPanelBody(x, y, w, h, "No palette");
        return;
    }
    var taken = skinTakenColors(lp);
    var current = skinCurrentColor(lp);
    var cursor = lp.stationPanel.cursor || 0;
    var pad = 14;
    var gap = 6;
    var cell = (w - pad * 2 - gap * (SKIN_COLS - 1)) / SKIN_COLS;
    var top = y + 44;
    for (var i = 0; i < pal.length; i++) {
        var col = pal[i];
        var r = Math.floor(i / SKIN_COLS);
        var cIdx = i % SKIN_COLS;
        var sx = x + pad + cIdx * (cell + gap);
        var sy = top + r * (cell + gap);
        var rect = { x: sx, y: sy, w: cell, h: cell };
        var isTaken = !!taken[col];
        gameContext.globalAlpha = isTaken ? 0.32 : 1;
        gameContext.fillStyle = col;
        lhRoundRect(gameContext, sx, sy, cell, cell, 5);
        gameContext.fill();
        gameContext.globalAlpha = 1;
        if (col === current) {
            gameContext.fillStyle = "#000";
            gameContext.textAlign = "center";
            gameContext.textBaseline = "middle";
            gameContext.font = "bold 16px sans-serif";
            gameContext.fillText("✓", sx + cell / 2, sy + cell / 2 + 1);
        }
        if (isTaken) {
            gameContext.strokeStyle = "rgba(0,0,0,0.6)";
            gameContext.lineWidth = 2;
            gameContext.beginPath();
            gameContext.moveTo(sx + 4, sy + 4);
            gameContext.lineTo(sx + cell - 4, sy + cell - 4);
            gameContext.stroke();
        }
        if (i === cursor) {
            gameContext.strokeStyle = "#fff";
            gameContext.lineWidth = 3;
            lhRoundRect(gameContext, sx - 1, sy - 1, cell + 2, cell + 2, 6);
            gameContext.stroke();
        }
        // Taken swatches aren't pickable, but still consume the tap so it doesn't
        // fall through and dismiss the panel.
        hit.options.push({ rect: rect, action: isTaken ? "noop" : ("pick:" + col) });
    }
    // "Taken!" flash after a rejected pick.
    if (lp._skinRejectAt && (Date.now() - lp._skinRejectAt) < 1500) {
        gameContext.fillStyle = "#ff6b6b";
        gameContext.textAlign = "center";
        gameContext.font = "bold 13px sans-serif";
        gameContext.fillText("Colour taken", x + w / 2, y + h - 12);
    }
}

function drawStubPanelBody(x, y, w, h, msg) {
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    gameContext.fillStyle = "#ccc";
    gameContext.font = "16px sans-serif";
    gameContext.fillText(msg, x + w / 2, y + h / 2 + 6);
}

// --- pointer (mouse/touch, primary slot only) --------------------------------

// Returns true if the pointer (logical coords) was consumed by the hub: opening a
// panel from the prompt, clicking a panel control, or dismissing an open panel.
function lobbyHubHandlePrimaryPointer(lx, ly) {
    if (typeof config === "undefined" || config == null || currentState !== config.stateMap.lobby) {
        return false;
    }
    if (typeof localPlayers === "undefined") {
        return false;
    }
    var lp = localPlayers[primarySlot];
    if (!lp) {
        return false;
    }
    var hit = stationHudHit[lp.slot];
    if (lp.stationPanel) {
        if (hit) {
            if (lhPointIn(hit.close, lx, ly)) {
                closeStationPanel(lp);
                return true;
            }
            for (var i = 0; i < hit.options.length; i++) {
                if (lhPointIn(hit.options[i].rect, lx, ly)) {
                    stationPanelAction(lp, hit.options[i].action);
                    return true;
                }
            }
        }
        // Clicked/tapped away from the panel — dismiss it.
        closeStationPanel(lp);
        return true;
    }
    if (lp.nearStation && hit && lhPointIn(hit.prompt, lx, ly)) {
        openStationPanel(lp);
        return true;
    }
    return false;
}

// --- keyboard (primary slot only) --------------------------------------------

// Returns true if the key was consumed by the hub (so keyDown stops processing it
// as movement). Open with E/Enter near a station; once open, arrows/WASD step,
// Enter/E/Space confirm, Esc closes, and every other key is swallowed so movement
// keys don't drive the kart out from under the panel.
function lobbyHubHandlePrimaryKey(evt) {
    if (typeof config === "undefined" || config == null || currentState !== config.stateMap.lobby) {
        return false;
    }
    if (typeof localPlayers === "undefined") {
        return false;
    }
    var lp = localPlayers[primarySlot];
    if (!lp) {
        return false;
    }
    if (lp.stationPanel) {
        switch (evt.code) {
            case "Escape": closeStationPanel(lp); return true;
            case "Enter": case "NumpadEnter": case "KeyE": case "Space": stationPanelConfirm(lp); return true;
            case "ArrowLeft": case "KeyA": stationPanelNav(lp, -1, 0); return true;
            case "ArrowRight": case "KeyD": stationPanelNav(lp, 1, 0); return true;
            case "ArrowUp": case "KeyW": stationPanelNav(lp, 0, -1); return true;
            case "ArrowDown": case "KeyS": stationPanelNav(lp, 0, 1); return true;
        }
        return true; // panel open: swallow other keys so they don't drive movement
    }
    if (lp.nearStation && (evt.code === "KeyE" || evt.code === "Enter" || evt.code === "NumpadEnter")) {
        openStationPanel(lp);
        return true;
    }
    return false;
}
