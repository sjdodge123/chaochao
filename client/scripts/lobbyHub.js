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
// Rapid dial steps update lobbyAISetting locally (optimistic) but COALESCE into a
// single debounced emit once stepping settles. That way the server sees one change
// per burst and its echo can't race the dial back to a stale mid-burst value — while
// incoming lobbyAIChanged is ALWAYS applied, so another player's change shows at once.
var aiEmitTimer = null;
var aiEmitSock = null;
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
        // Open the picker "here": on the avatar cell if it's equipped, else on the
        // player's current colour.
        if (playerHasAvatarSkin(lp) && avatarSkinProfile(lp)) {
            cursor = skinPalette().length;
        } else {
            var pal = skinPalette();
            var idx = pal.indexOf(skinCurrentColor(lp));
            cursor = (idx >= 0) ? idx : 0;
        }
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
        skinPanelNav(lp, dx, dy);
    }
}

// Keyboard/gamepad nav over the skin panel's flat option space: the swatch+avatar
// grid (SKIN_COLS wide) occupies [0, base-1], then the cart-skin row occupies
// [base, base+cartN-1]. This keeps the cart cells reachable by pad/keyboard, not
// just by pointer.
function skinPanelNav(lp, dx, dy) {
    var sp = lp.stationPanel;
    var base = skinOptionCount(lp);
    if (!base) { return; }
    var cartN = CART_SKIN_OPTIONS.length;
    var cols = SKIN_COLS;
    var cur = sp.cursor || 0;
    var maxRow = Math.floor((base - 1) / cols);

    if (cur >= base) {
        // Cursor is in the cart-skin row.
        var cidx = cur - base;
        if (dx !== 0) {
            cidx += dx;
            if (cidx < 0) { cidx = cartN - 1; }
            if (cidx >= cartN) { cidx = 0; }
        }
        if (dy < 0) {
            var up = maxRow * cols + cidx;        // back up into the grid's last row
            sp.cursor = (up >= base) ? base - 1 : up;
            return;
        }
        sp.cursor = base + cidx;                  // down keeps us in the (bottom) cart row
        return;
    }

    // Cursor is in the swatch/avatar grid.
    var row = Math.floor(cur / cols);
    var col = cur % cols;
    if (dx !== 0) {
        col += dx;
        if (col < 0) { col = cols - 1; }
        if (col >= cols) { col = 0; }
    }
    if (dy > 0 && row === maxRow) {
        sp.cursor = base + Math.min(col, cartN - 1); // drop into the cart row
        return;
    }
    if (dy !== 0) {
        row += dy;
        if (row < 0) { row = 0; }
        if (row > maxRow) { row = maxRow; }
    }
    var idx = row * cols + col;
    if (idx >= base) { idx = base - 1; }         // last grid row may be partially filled
    sp.cursor = idx;
}

// Commit the cell under the cursor: colour swatch, avatar, or cart skin.
function skinPanelConfirm(lp) {
    var sp = lp.stationPanel;
    var base = skinOptionCount(lp);
    var cur = sp.cursor || 0;
    if (cur >= base) {
        var opt = CART_SKIN_OPTIONS[cur - base];
        if (opt) { stationPickCartSkin(lp, opt.id); } // id === null clears to the plain cart
        return;
    }
    if (isAvatarIndex(lp, cur)) {
        stationPickAvatar(lp);
        return;
    }
    var pal = skinPalette();
    if (cur >= 0 && cur < pal.length) {
        stationPickSkin(lp, pal[cur]);
    }
}

// Confirm (A / Enter): AI changes apply live as you step, so confirm just
// dismisses; for the skin picker it commits the colour under the cursor.
function stationPanelConfirm(lp) {
    if (lp && lp.stationPanel && lp.stationPanel.kind === "skin") {
        skinPanelConfirm(lp);
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
    } else if (action === "pickAvatar") {
        stationPickAvatar(lp);
    } else if (action != null && action.indexOf("cartskin:") === 0) {
        stationPickCartSkin(lp, action.slice("cartskin:".length) || null);
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
// Step the dial and update the room-wide setting (optimistic local + debounced emit).
function adjustAILevel(lp, dir) {
    var max = aiMaxBots();
    // Clamp the CURRENT position into range first, so stepping stays monotonic even
    // when the room filled up since the value was chosen (aiMaxBots can shrink below
    // the current count). Without this, a 'right' press on an over-cap value would
    // jump down to Off.
    var cur = aiDialIndex();
    if (cur > max + 1) { cur = max + 1; }
    var idx = cur + dir;
    if (idx < 0) { idx = 0; }
    if (idx > max + 1) { idx = max + 1; } // Auto, Off, then 1..max
    if (idx === 0) {
        lobbyAISetting = null;                              // Auto
    } else if (idx === 1) {
        lobbyAISetting = { enabled: false, count: 0 };      // Off
    } else {
        lobbyAISetting = { enabled: true, count: idx - 1 }; // N bots
    }
    // AI is room-wide, so the global `server` fallback is fine (attribution doesn't
    // matter); emit is debounced so a key burst sends one change, not one per step.
    aiEmitSock = (lp && lp.socket) ? lp.socket : (typeof server !== "undefined" ? server : null);
    if (aiEmitTimer) { clearTimeout(aiEmitTimer); }
    aiEmitTimer = setTimeout(flushLobbyAIEmit, 140);
}
// Send the settled dial value once stepping stops (see adjustAILevel).
function flushLobbyAIEmit() {
    aiEmitTimer = null;
    if (!aiEmitSock) { return; }
    var payload = (lobbyAISetting == null) ? { auto: true } : lobbyAISetting;
    aiEmitSock.emit("setLobbyAI", payload);
}

// --- skin station model ------------------------------------------------------

var SKIN_COLS = 6; // swatches per row in the picker grid
var CART_SKIN_CELL_H = 46; // height of a cart-skin picker cell
// Cosmetic cart skins (available to everyone). id null == plain colored cart.
var CART_SKIN_OPTIONS = [
    { id: null, label: "Default" },
    { id: "firetruck", label: "Fire Truck" },
    { id: "dino", label: "Dino" },
];

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
    // Skin is per-player, so it MUST go out on this slot's own socket (the server
    // attributes setSkin to the emitting socket id). No primary-socket fallback — that
    // would recolour the wrong player; if this slot has no live socket, drop it.
    if (lp.socket) {
        lp.socket.emit("setSkin", { color: color });
    }
}
// Flash a "taken" note on a slot's open skin panel for a short beat.
function flagSkinRejected(slot, color) {
    var lp = (typeof localPlayers !== "undefined") ? localPlayers[slot] : null;
    if (lp) {
        lp._skinRejectAt = Date.now();
    }
}

// --- avatar skin option ------------------------------------------------------
// The signed-in player's Discord/Google picture, offered as an extra skin in the
// station. Only the PRIMARY local seat carries the account (other seats are
// guests), so the option only shows there. Returns { name, avatarUrl } or null.
function avatarSkinProfile(lp) {
    if (!lp || !lp.isPrimary) {
        return null;
    }
    var auth = (typeof window !== "undefined") ? window.chaochaoAuth : null;
    if (!auth || typeof auth.isSignedIn !== "function" || !auth.isSignedIn()) {
        return null;
    }
    var profile = (typeof auth.getProfile === "function") ? auth.getProfile() : null;
    return (profile && profile.avatarUrl) ? profile : null;
}
// Selectable options = colour swatches + (the avatar option, when available). The
// avatar lives at grid index === palette length (one past the last colour).
function skinOptionCount(lp) {
    return skinPalette().length + (avatarSkinProfile(lp) ? 1 : 0);
}
function isAvatarIndex(lp, i) {
    return !!avatarSkinProfile(lp) && i === skinPalette().length;
}
// Is this player currently wearing the avatar skin? (server-set avatarUrl).
function playerHasAvatarSkin(lp) {
    var p = (lp && lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
    return !!(p && p.avatarUrl);
}
// Commit the avatar skin: emit on this slot's own socket (the server attributes
// it to the emitting, signed-in socket). The change lands via playerAvatarChanged.
function stationPickAvatar(lp) {
    var profile = avatarSkinProfile(lp);
    if (!profile || !lp.socket) {
        return;
    }
    lp.socket.emit("setAvatarSkin", { url: profile.avatarUrl, name: profile.name });
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
var HUB_ACCENT = "#FFCB30"; // goal gold (matches config.tileMap.goal.color) — the "interactive / active" accent
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
        // Full radius sum, matching the server's circle-overlap enter/exit test, so the
        // gold "lit" state and the "press to open" prompt toggle at the same distance.
        var reach = s.radius + pr;
        if (dx * dx + dy * dy <= reach * reach) {
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

// Triangular-tier auto fill: a few bots scale up with humans (1H→1, 2-3H→2,
// 4-6H→3, 7-10H→4, 11-15H→5, 16H→6). 17+ humans fills the remaining slots,
// clamped to whatever room space is left so the banner never overpromises.
function autoEffectiveBots() {
    var h = lobbyHumanCount();
    var capLeft = aiMaxBots();
    if (capLeft <= 0 || h <= 0) { return 0; }
    if (h >= 17) { return capLeft; }
    var n = 1, end = 1;
    while (end < h) { n++; end += n; }
    return n > capLeft ? capLeft : n;
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
        var rows = Math.max(1, Math.ceil(skinOptionCount(lp) / SKIN_COLS));
        w = 272;
        // base swatch grid height + an extra row for the cart-skin picker.
        h = 78 + rows * 34 + CART_SKIN_CELL_H + 8;
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
    var hasAvatar = playerHasAvatarSkin(lp); // wearing the avatar skin → no colour is "current"
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
        if (col === current && !hasAvatar) {
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
    // Avatar skin option (signed-in primary only): one extra cell at index ===
    // palette length, the player's picture in the same gold frame used in-game.
    var avProfile = avatarSkinProfile(lp);
    if (avProfile) {
        var ai = pal.length;
        var asx = x + pad + (ai % SKIN_COLS) * (cell + gap);
        var asy = top + Math.floor(ai / SKIN_COLS) * (cell + gap);
        var arect = { x: asx, y: asy, w: cell, h: cell };
        gameContext.fillStyle = "#f4c542"; // the "external skin" border colour
        lhRoundRect(gameContext, asx, asy, cell, cell, 5);
        gameContext.fill();
        var inset = 3;
        var av = (typeof preloadAvatarImage === "function") ? preloadAvatarImage(avProfile.avatarUrl) : null;
        if (av && av.ready && !av.failed) {
            gameContext.save();
            lhRoundRect(gameContext, asx + inset, asy + inset, cell - inset * 2, cell - inset * 2, 4);
            gameContext.clip();
            gameContext.drawImage(av.img, asx + inset, asy + inset, cell - inset * 2, cell - inset * 2);
            gameContext.restore();
        } else {
            gameContext.fillStyle = "#222";
            gameContext.textAlign = "center";
            gameContext.textBaseline = "middle";
            gameContext.font = "16px sans-serif";
            gameContext.fillText("👤", asx + cell / 2, asy + cell / 2 + 1);
        }
        if (hasAvatar) { // equipped — small check badge, top-right
            var bx = asx + cell - 8, by = asy + 8;
            gameContext.beginPath();
            gameContext.arc(bx, by, 7, 0, 2 * Math.PI);
            gameContext.fillStyle = "rgba(0,0,0,0.7)";
            gameContext.fill();
            gameContext.fillStyle = "#fff";
            gameContext.textAlign = "center";
            gameContext.textBaseline = "middle";
            gameContext.font = "bold 10px sans-serif";
            gameContext.fillText("✓", bx, by + 0.5);
        }
        if (cursor === ai) {
            gameContext.strokeStyle = "#fff";
            gameContext.lineWidth = 3;
            lhRoundRect(gameContext, asx - 1, asy - 1, cell + 2, cell + 2, 6);
            gameContext.stroke();
        }
        hit.options.push({ rect: arect, action: "pickAvatar" });
    }
    // "Taken!" flash after a rejected pick.
    if (lp._skinRejectAt && (Date.now() - lp._skinRejectAt) < 1500) {
        gameContext.fillStyle = "#ff6b6b";
        gameContext.textAlign = "center";
        gameContext.font = "bold 13px sans-serif";
        gameContext.fillText("Colour taken", x + w / 2, y + h - 12);
    }
    // Cart-skin picker row, one row below the swatch/avatar grid. Cart skins are
    // independent of colour/avatar and open to everyone, so this always shows.
    var gridRows = Math.ceil(skinOptionCount(lp) / SKIN_COLS);
    var csY = top + gridRows * (cell + gap) + gap;
    drawCartSkinRow(lp, x + pad, csY, w - pad * 2, hit);
}

// Default / Fire Truck / Dino cells with a tiny procedural preview + label. Each
// cell pushes a "cartskin:<id>" hit action, handled by stationPanelAction.
function drawCartSkinRow(lp, x, y, w, hit) {
    var ch = CART_SKIN_CELL_H;
    var n = CART_SKIN_OPTIONS.length;
    var cgap = 8;
    var cellW = (w - cgap * (n - 1)) / n;
    var current = currentCartSkin(lp);
    var currentColor = skinCurrentColor(lp);
    // Which cart cell the keyboard/gamepad cursor is on (-1 = cursor is up in the
    // swatch grid), so pad/keyboard users can see the highlighted cart option.
    var sp = lp.stationPanel || {};
    var cursorCart = (typeof sp.cursor === "number" && sp.cursor >= skinOptionCount(lp))
        ? (sp.cursor - skinOptionCount(lp)) : -1;
    for (var i = 0; i < n; i++) {
        var opt = CART_SKIN_OPTIONS[i];
        var cx = x + i * (cellW + cgap);
        var sel = current === opt.id;
        gameContext.fillStyle = sel ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
        lhRoundRect(gameContext, cx, y, cellW, ch, 6);
        gameContext.fill();
        gameContext.lineWidth = sel ? 2 : 1;
        gameContext.strokeStyle = sel ? "#ffd34d" : "rgba(255,255,255,0.2)";
        lhRoundRect(gameContext, cx, y, cellW, ch, 6);
        gameContext.stroke();
        if (i === cursorCart) {
            gameContext.strokeStyle = "#fff";
            gameContext.lineWidth = 2.5;
            lhRoundRect(gameContext, cx - 1, y - 1, cellW + 2, ch + 2, 7);
            gameContext.stroke();
        }
        drawCartSkinPreview(opt.id, cx + cellW / 2, y + ch * 0.34, ch * 0.22, currentColor);
        gameContext.fillStyle = "#fff";
        gameContext.font = "11px sans-serif";
        gameContext.textAlign = "center";
        gameContext.textBaseline = "middle";
        gameContext.fillText(opt.label, cx + cellW / 2, y + ch * 0.76);
        hit.options.push({ rect: { x: cx, y: y, w: cellW, h: ch }, action: "cartskin:" + (opt.id == null ? "" : opt.id) });
    }
}

// Tiny procedural preview swatch for a cart-skin cell.
function drawCartSkinPreview(id, cx, cy, r, paint) {
    // Preview in the player's own cart colour so the thumbnail matches what they'll
    // drive; fall back to representative colours when no colour is known.
    var canShade = (typeof cartSkinShade === "function" && paint);
    if (id === "firetruck") {
        gameContext.fillStyle = canShade ? cartSkinShade(paint, -0.05) : "#d11f1f";
        gameContext.fillRect(cx - r, cy - r * 0.6, r * 2, r * 1.2);
        gameContext.fillStyle = "#1a1a1a";
        gameContext.beginPath();
        gameContext.arc(cx - r * 0.6, cy + r * 0.6, r * 0.4, 0, Math.PI * 2);
        gameContext.arc(cx + r * 0.6, cy + r * 0.6, r * 0.4, 0, Math.PI * 2);
        gameContext.fill();
    } else if (id === "dino") {
        gameContext.fillStyle = paint || "#43b047";
        gameContext.beginPath();
        gameContext.ellipse(cx - r * 0.2, cy, r * 0.9, r * 0.6, 0, 0, Math.PI * 2);
        gameContext.fill();
        gameContext.beginPath();
        gameContext.ellipse(cx + r * 0.7, cy - r * 0.1, r * 0.4, r * 0.35, 0, 0, Math.PI * 2);
        gameContext.fill();
    } else {
        gameContext.fillStyle = "rgba(255,255,255,0.4)";
        gameContext.beginPath();
        gameContext.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
        gameContext.fill();
    }
}

// This local player's currently-equipped cart skin (server-authoritative), else null.
function currentCartSkin(lp) {
    var p = (lp && lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
    return (p && p.cartSkin) || null;
}

// Commit a cart-skin pick: emit on this slot's own socket. The change lands for
// everyone via playerCartSkinChanged. "" clears back to the plain colored cart.
function stationPickCartSkin(lp, skinId) {
    if (!lp || !lp.socket) {
        return;
    }
    lp.socket.emit("setCartSkin", { cartSkin: skinId || null });
    var p = (lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
    if (p) {
        p.cartSkin = skinId || null; // optimistic local update
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
