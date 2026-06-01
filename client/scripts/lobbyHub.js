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
// Room-wide map playlist mirrored from the server (lobbyPlaylistChanged). The
// hub "playlist board" station steps through config.playlists; like the AI dial
// it applies room-wide, last-writer-wins, and coalesces a step burst into one
// debounced emit. lobbyPlaylistInfo is the boot-time [{id,name,desc,count}]
// summary delivered in contentDelivery, used only for the map-count display.
var lobbyPlaylist = null;
var lobbyPlaylistInfo = [];
var plEmitTimer = null;
var plEmitSock = null;
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

// Tell the server the player is ACTIVELY using a hub station (open / navigate / tab /
// page / confirm / close, from key, touch, or pad). This "pressing keys" signal defers
// the lobby AFK kick — menu browsing emits no movement packets, so without it a player
// flipping through the skin shop reads as idle. Merely standing in a station zone does
// NOT call this, so a parked-and-walked-away kart still idles out normally.
function noteHubActivity(lp) {
    if (lp && lp.socket && typeof lp.socket.emit === "function") {
        lp.socket.emit("lobbyActivity");
    }
}

function openStationPanel(lp) {
    if (!lp || !lp.nearStation) {
        return;
    }
    var st = stationById(lp.nearStation);
    if (!st) {
        return;
    }
    noteHubActivity(lp);
    var cursor = 0;
    var tab = 'color';
    if (st.kind === "skin") {
        // Open on the Color tab "here": the avatar cell if equipped, else the current colour.
        if (playerHasAvatarSkin(lp) && avatarSkinProfile(lp)) {
            cursor = skinPalette().length;
        } else {
            var pal = skinPalette();
            var idx = pal.indexOf(skinCurrentColor(lp));
            cursor = (idx >= 0) ? idx : 0;
        }
    }
    lp.stationPanel = { id: st.id, kind: st.kind, tab: tab, region: 'grid', cursor: cursor };
    // Stop driving while configuring (mirrors the emoji-wheel open), and emit the
    // stop on this slot's own socket so the kart doesn't coast off the zone.
    if (typeof cancelMovementForSlot === "function") {
        cancelMovementForSlot(lp);
    }
}

function closeStationPanel(lp) {
    if (lp) {
        noteHubActivity(lp);
        lp.stationPanel = null;
    }
}

// dx: -1/+1 horizontal step, dy: -1/+1 vertical (rows). The AI panel is a single
// horizontal stepper; the skin panel moves a cursor over the swatch grid.
function stationPanelNav(lp, dx, dy) {
    if (!lp || !lp.stationPanel) {
        return;
    }
    noteHubActivity(lp);
    if (lp.stationPanel.kind === "ai") {
        if (dx !== 0) {
            adjustAILevel(lp, dx > 0 ? 1 : -1);
        }
        return;
    }
    if (lp.stationPanel.kind === "playlist") {
        if (dx !== 0) {
            adjustPlaylist(lp, dx > 0 ? 1 : -1);
        }
        return;
    }
    if (lp.stationPanel.kind === "skin") {
        skinPanelNav(lp, dx, dy);
    }
}

// Keyboard/gamepad nav over the tabbed/paged skin picker. Three focus regions:
//   'tabs' — the category row (◄► switch category, ▼ drops into the grid)
//   'grid' — the current page's cells (▲ from the top row → tabs, ▼ from the last row →
//            page arrows; ◄►/▲▼ move the cursor, crossing pages automatically)
//   'page' — the ◄ ► page arrows (◄► flip pages, ▲ back to the grid)
function skinPanelNav(lp, dx, dy) {
    var sp = lp.stationPanel;
    if (!sp) { return; }
    if (sp.region == null) { sp.region = 'grid'; }
    skinValidateTab(lp);
    var tabs = skinTabs(lp);
    var items = skinTabItems(lp, sp.tab);
    var cols = SKIN_PICKER_COLS, perPage = SKIN_PICKER_PER_PAGE;
    var pageCount = Math.max(1, Math.ceil(items.length / perPage));

    if (sp.region === 'tabs') {
        if (dx !== 0) {
            var ti = skinTabIndex(lp, sp.tab) + dx;
            if (ti < 0) { ti = tabs.length - 1; }
            if (ti >= tabs.length) { ti = 0; }
            sp.tab = tabs[ti].key; sp.cursor = 0;
        }
        if (dy > 0) { sp.region = 'grid'; sp.cursor = 0; }
        return;
    }
    if (sp.region === 'page') {
        if (dx !== 0) {
            var pg = Math.floor((sp.cursor || 0) / perPage) + dx;
            if (pg < 0) { pg = 0; }
            if (pg > pageCount - 1) { pg = pageCount - 1; }
            sp.cursor = Math.min(items.length - 1, pg * perPage);
        }
        if (dy < 0) { sp.region = 'grid'; }
        return;
    }
    // grid
    var cur = sp.cursor || 0;
    var posInPage = cur % perPage;
    var rowInPage = Math.floor(posInPage / cols);
    var pageStart = Math.floor(cur / perPage) * perPage;
    var lastRowInPage = Math.floor((Math.min(perPage, items.length - pageStart) - 1) / cols);
    if (dy < 0 && rowInPage === 0) { sp.region = 'tabs'; return; }
    if (dy > 0 && rowInPage === lastRowInPage) {
        if (pageCount > 1) { sp.region = 'page'; }
        return;
    }
    var nc = cur;
    if (dx !== 0) { nc += dx; }
    if (dy !== 0) { nc += dy * cols; }
    if (nc < 0) { nc = 0; }
    if (nc > items.length - 1) { nc = items.length - 1; }
    sp.cursor = nc;
}

// Commit the focused element: a tab switch, a page step, or the cell under the cursor.
function skinPanelConfirm(lp) {
    var sp = lp.stationPanel;
    if (!sp) { return; }
    skinValidateTab(lp);
    if (sp.region === 'tabs') { sp.region = 'grid'; sp.cursor = 0; return; }
    if (sp.region === 'page') { return; }
    var items = skinTabItems(lp, sp.tab);
    activateSkinItem(lp, items[sp.cursor || 0]);
}

// Confirm (A / Enter): AI changes apply live as you step, so confirm just
// dismisses; for the skin picker it commits the colour under the cursor.
function stationPanelConfirm(lp) {
    if (!lp || !lp.stationPanel) {
        return;
    }
    noteHubActivity(lp);
    if (lp.stationPanel.kind === "skin") {
        skinPanelConfirm(lp);
        return;
    }
    closeStationPanel(lp);
}

// Switch the open SKIN picker's tab/category by ±1, wrapping (controller bumpers). No-op on
// the AI panel. Pages stay on the d-pad ◄ ► region.
function stationPanelTab(lp, dir) {
    if (!lp || !lp.stationPanel || lp.stationPanel.kind !== "skin") { return; }
    noteHubActivity(lp);
    var sp = lp.stationPanel;
    var tabs = skinTabs(lp);
    var idx = skinTabIndex(lp, sp.tab) + (dir < 0 ? -1 : 1);
    if (idx < 0) { idx = tabs.length - 1; }
    if (idx >= tabs.length) { idx = 0; }
    sp.tab = tabs[idx].key;
    sp.cursor = 0;
    sp.region = 'grid';
}

// Map a pointer-hit action token to its effect. "pick:<hex>" commits a skin colour.
function stationPanelAction(lp, action) {
    noteHubActivity(lp); // pointer/tap interaction on the panel is activity (some branches re-ping via nav/close — harmless)
    if (action === "inc") {
        stationPanelNav(lp, 1, 0);
    } else if (action === "dec") {
        stationPanelNav(lp, -1, 0);
    } else if (action === "close") {
        closeStationPanel(lp);
    } else if (action === "pickAvatar") {
        stationPickAvatar(lp);
    } else if (action != null && action.indexOf("tab:") === 0) {
        // Switch the picker's active category (pointer tap on a tab).
        if (lp.stationPanel) { lp.stationPanel.tab = action.slice(4); lp.stationPanel.cursor = 0; lp.stationPanel.region = 'grid'; }
    } else if (action != null && action.indexOf("page:") === 0) {
        // Step the page within the active tab (pointer tap on ◄ / ►).
        if (lp.stationPanel) {
            var dir = parseInt(action.slice(5), 10) || 0;
            var items = skinTabItems(lp, lp.stationPanel.tab);
            var perPage = SKIN_PICKER_PER_PAGE;
            var pc = Math.max(1, Math.ceil(items.length / perPage));
            var pg = Math.floor((lp.stationPanel.cursor || 0) / perPage) + dir;
            if (pg < 0) { pg = 0; }
            if (pg > pc - 1) { pg = pc - 1; }
            lp.stationPanel.cursor = Math.min(items.length - 1, pg * perPage);
            lp.stationPanel.region = 'grid';
        }
    } else if (action != null && action.indexOf("cosmetic:") === 0) {
        // "cosmetic:<slot>:<id>" (id may be empty for the slot default).
        var rest = action.slice("cosmetic:".length);
        var sep = rest.indexOf(":");
        var slot = sep >= 0 ? rest.slice(0, sep) : rest;
        var id = sep >= 0 ? rest.slice(sep + 1) : "";
        stationPickCosmetic(lp, { slot: slot, id: id || null });
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

// --- playlist station model --------------------------------------------------

// The configured playlists ride along on the `config` payload (server config.json),
// so the client already has their ids/names/filters. lobbyPlaylistInfo adds the
// per-playlist map count computed at boot.
function playlistDefList() {
    var all = (typeof config !== "undefined" && config && Array.isArray(config.playlists)) ? config.playlists : [];
    // Step only through the VISIBLE playlists (those the server included in the
    // summary — i.e. that met the minimum map count). Preserve config order; fall
    // back to the full list if the summary hasn't arrived yet.
    if (!lobbyPlaylistInfo || !lobbyPlaylistInfo.length) { return all; }
    var visible = {};
    lobbyPlaylistInfo.forEach(function (p) { visible[p.id] = true; });
    return all.filter(function (p) { return visible[p.id]; });
}
function defaultPlaylistId() {
    return (typeof config !== "undefined" && config && config.defaultPlaylist) ? config.defaultPlaylist : "featured";
}
function currentPlaylistId() {
    if (lobbyPlaylist) { return lobbyPlaylist; }
    return defaultPlaylistId();
}
function playlistDef(id) {
    var defs = playlistDefList();
    for (var i = 0; i < defs.length; i++) { if (defs[i].id === id) { return defs[i]; } }
    return null;
}
function playlistCount(id) {
    for (var i = 0; i < lobbyPlaylistInfo.length; i++) {
        if (lobbyPlaylistInfo[i].id === id) { return lobbyPlaylistInfo[i].count; }
    }
    return null;
}
function currentPlaylistLabel() {
    var def = playlistDef(currentPlaylistId());
    return def ? def.name : currentPlaylistId();
}
// Step the board to the prev/next playlist (wraps), update the room-wide setting
// optimistically, and debounce the emit so a key burst sends one change.
function adjustPlaylist(lp, dir) {
    var defs = playlistDefList();
    if (!defs.length) { return; }
    var idx = -1;
    for (var i = 0; i < defs.length; i++) { if (defs[i].id === currentPlaylistId()) { idx = i; break; } }
    if (idx < 0) { idx = 0; }
    idx = (idx + dir + defs.length) % defs.length;
    lobbyPlaylist = defs[idx].id;
    plEmitSock = (lp && lp.socket) ? lp.socket : (typeof server !== "undefined" ? server : null);
    if (plEmitTimer) { clearTimeout(plEmitTimer); }
    plEmitTimer = setTimeout(flushLobbyPlaylistEmit, 140);
}
function flushLobbyPlaylistEmit() {
    plEmitTimer = null;
    if (!plEmitSock) { return; }
    plEmitSock.emit("setLobbyPlaylist", { id: currentPlaylistId() });
}

// --- skin station model ------------------------------------------------------

var SKIN_COLS = 6; // swatches per row in the picker grid
var CART_SKIN_CELL_H = 40; // height of a cosmetic picker cell
// The three independent cosmetic slots, each its own labeled group with a "default"
// (slot-empty) option first, then its unlockables in ladder order — built from the
// registry (skinRegistry.js, concatenated before this file) so new cosmetics show up
// automatically. Order is cart → pattern → trail; the cursor/hit-test index is linear
// over this whole array (the layout groups them visually under headers). Each option:
//   { id, label, slot, effect? }   (id null = the slot's default; effect set for trails)
var COSMETIC_GROUPS = [
    { slot: 'cart', header: 'Carts' },
    { slot: 'pattern', header: 'Patterns' },
    { slot: 'trail', header: 'Trails' },
    // Borders are an INDEPENDENT 4th slot (player.border / selected_border) with their own tab
    // + "None" default; a border and a pattern can be equipped at the same time.
    { slot: 'border', header: 'Borders' }
];
var COSMETIC_OPTIONS = (function () {
    var out = [];
    var defaults = (typeof COSMETIC_SLOT_DEFAULT_NAME !== "undefined") ? COSMETIC_SLOT_DEFAULT_NAME : { cart: 'Plain', pattern: 'None', trail: 'Basic' };
    for (var g = 0; g < COSMETIC_GROUPS.length; g++) {
        var slot = COSMETIC_GROUPS[g].slot;
        out.push({ id: null, label: defaults[slot] || "Default", slot: slot });
        var list = (typeof getSkinsForSlot === "function") ? getSkinsForSlot(slot) : [];
        for (var i = 0; i < list.length; i++) {
            out.push({ id: list[i].id, label: list[i].name, slot: slot, effect: list[i].effect || null });
        }
    }
    return out;
})();

// --- per-slot localStorage persistence (instant re-equip; server re-validates) -------
// Keyed PER COUCH-PLAYER SLOT (lp.slot), not just the cosmetic slot — otherwise local
// co-op players on the same browser share one key and clobber each other (and the
// welcome-time re-equip then applies one player's saved pick to everyone).
function cosmeticStorageKey(lp, slot) {
    var who = (lp && lp.slot != null) ? lp.slot : 'p';
    // Signed-in players persist cosmetics to their ACCOUNT — the server's progression
    // row is the source of truth (restorePersistedCosmetics applies it on every join,
    // incl. mid-match and the moment they sign in). Namespace this browser's local
    // mirror by the account id for the primary couch slot so a previous guest session's
    // picks — or a different account's — can never be re-equipped and clobber the
    // signed-in account's saved cosmetics on sign-in. Guests + co-op extras keep the
    // plain per-couch-slot key (their only persistence is local).
    var auth = (typeof window !== "undefined") ? window.chaochaoAuth : null;
    if (lp && typeof primarySlot !== "undefined" && lp.slot === primarySlot &&
        auth && typeof auth.getUserId === "function") {
        var uid = auth.getUserId();
        if (uid) { who = "acct-" + uid; }
    }
    return "cc_cosmetic_" + who + "_" + slot;
}
function saveCosmeticLocal(lp, slot, id) {
    try {
        if (id == null) { localStorage.removeItem(cosmeticStorageKey(lp, slot)); }
        else { localStorage.setItem(cosmeticStorageKey(lp, slot), id); }
    } catch (e) { /* private mode / disabled storage — non-fatal */ }
}
function readCosmeticLocal(lp, slot) {
    try { return localStorage.getItem(cosmeticStorageKey(lp, slot)) || null; } catch (e) { return null; }
}
// Re-send each saved cosmetic slot for a local player on (re)join so their picks apply
// instantly without reopening the picker. The server re-validates + rejects silently if
// the player no longer qualifies (e.g. signed out of the account that unlocked it).
function reEquipSavedCosmetics(lp) {
    if (!lp || !lp.socket) { return; }
    for (var g = 0; g < COSMETIC_GROUPS.length; g++) {
        var slot = COSMETIC_GROUPS[g].slot;
        var id = readCosmeticLocal(lp, slot);
        if (!id) { continue; }
        lp.socket.emit("setCosmetic", { slot: slot, id: id });
        var p = (lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
        if (p && typeof COSMETIC_SLOT_FIELD !== "undefined" && COSMETIC_SLOT_FIELD[slot]) {
            p[COSMETIC_SLOT_FIELD[slot]] = id; // optimistic; server confirms via playerCosmeticChanged
        }
    }
}

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
    if (kind === "playlist") { return "Playlist"; }
    return "Station";
}
function stationGlyph(kind) {
    if (kind === "ai") { return "🤖"; }
    if (kind === "skin") { return "🎨"; }
    if (kind === "playlist") { return "🗺️"; }
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
    // The AI setting and playlist are both room-wide, so show them persistently to the
    // whole lobby (not just inside a panel) — everyone sees a change before the race
    // starts. Drawn FIRST so an open station panel layers on top of them, otherwise they
    // z-order over the picker near the top of the screen.
    // Resolve the active seasonal claim ONCE per HUD frame (it can't change within a frame);
    // all three banners read this cached value instead of re-scanning the registry each.
    lobbyBannerSeasonalClaim = activeSeasonalClaim();
    drawSeasonalClaimBanner(); // top slot when active; AI + playlist drop a row below it
    drawLobbyAIStatus();
    drawLobbyPlaylistStatus();
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
}

// The active seasonal claim for THIS HUD frame (or null), cached by drawLobbyHubHud so the
// registry isn't re-scanned by each banner. Read by all three lobby banners.
var lobbyBannerSeasonalClaim = null;

// Draws ONE fixed top-centre lobby banner (rounded pill, centered bold text) at row `y`. Backs
// all three lobby banners so their geometry stays identical. theme overrides the neutral hub
// panel look: { fill, ink (border), text (defaults to ink), alpha, pad, glow }.
function drawLobbyBanner(text, y, theme) {
    theme = theme || {};
    var ink = theme.ink || hubInk();
    var pad = (theme.pad != null) ? theme.pad : 30;
    gameContext.save();
    gameContext.font = "bold 16px sans-serif";
    var tw = gameContext.measureText(text).width;
    var w = tw + pad;
    var h = 32;
    var x = (LOGICAL_WIDTH - w) / 2;
    if (theme.glow) { gameContext.shadowColor = theme.glow; gameContext.shadowBlur = 14; }
    gameContext.globalAlpha = (theme.alpha != null) ? theme.alpha : 0.92;
    gameContext.fillStyle = theme.fill || hubSurface();
    lhRoundRect(gameContext, x, y, w, h, 9);
    gameContext.fill();
    gameContext.shadowBlur = 0;
    gameContext.globalAlpha = 1;
    gameContext.lineWidth = 2;
    gameContext.strokeStyle = ink;
    gameContext.stroke();
    gameContext.fillStyle = theme.text || ink;
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    gameContext.fillText(text, LOGICAL_WIDTH / 2, y + h / 2);
    gameContext.restore();
}

// A fixed top-centre banner showing the live room-wide playlist. Sits under the AI banner,
// dropping a row when the seasonal banner takes the top slot. Synced via lobbyPlaylistChanged.
function drawLobbyPlaylistStatus() {
    if (!playlistDefList().length) { return; }
    var count = playlistCount(currentPlaylistId());
    var text = "🗺️ Playlist: " + currentPlaylistLabel() + (count != null ? " (" + count + ")" : "");
    drawLobbyBanner(text, lobbyBannerSeasonalClaim ? 164 : 128);
}

// The seasonal claim the LOCAL player can still act on this frame — the first open claim they
// don't already own (mirrors the server, which grants ALL open claims, so if more than one
// season is live the banner advances past ones already claimed). null = nothing to advertise.
// Hidden once owned so it never nags a claimer.
function activeSeasonalClaim() {
    if (typeof currentSeasonalClaims !== "function") { return null; }
    var open = currentSeasonalClaims(Date.now());
    if (!open.length) { return null; }
    var prog = (typeof myProgression !== "undefined") ? myProgression : null;
    var owns = (prog && prog.unlocked_skins) ? prog.unlocked_skins : null;
    for (var i = 0; i < open.length; i++) {
        if (!owns || owns.indexOf(open[i].id) === -1) { return open[i]; }
    }
    return null; // every open claim already owned
}

// The player-facing noun for a cosmetic slot, used in the data-driven seasonal copy so a
// future non-trail season ('cart'/'border'/'pattern') reads correctly without a code edit.
function cosmeticSlotNoun(slot) {
    return (slot === "cart" || slot === "pattern" || slot === "trail" || slot === "border") ? slot : "cosmetic";
}

// A limited-time, eye-catching GOLD banner advertising the open seasonal claim (Early Adopter
// etc.), drawn as the TOP banner of the lobby stack (above the AI-bots banner) so the limited
// CTA gets first billing; the AI + playlist banners drop one row while it's showing. Copy is
// data-driven (season label + cosmetic name + slot noun) from the registry entry, so a future
// season needs no edit here. Sign-in nudge for guests; "claim it / Nd left" for signed-in.
function drawSeasonalClaimBanner() {
    var claim = lobbyBannerSeasonalClaim;
    if (!claim) { return; }
    var signedIn = !!((typeof myProgression !== "undefined") ? myProgression : null);
    var endMs = Date.parse(claim.unlock.claimEnd);
    var daysLeft = isNaN(endMs) ? null : Math.max(1, Math.ceil((endMs - Date.now()) / 86400000));
    var nm = (typeof skinDisplayName === "function") ? skinDisplayName(claim.id) : claim.name;
    var label = (claim.unlock && claim.unlock.label) ? claim.unlock.label : "Limited";
    var noun = cosmeticSlotNoun(claim.slot);
    var tail = (daysLeft != null ? " — " + daysLeft + "d left" : "");
    var text = signedIn
        ? ("🌟 Claim your " + label + " " + nm + " " + noun + tail)
        : ("🌟 Sign in to claim the limited " + label + " " + nm + " " + noun + tail);
    // Gold theme + soft glow so it reads as premium/limited, not a routine status band.
    drawLobbyBanner(text, 92, { fill: "#3a2b06", ink: "#ffb31f", text: "#ffe9a8", alpha: 0.96, pad: 34, glow: "rgba(255,179,31,0.7)" });
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
    // Under the GameID/Players/Round info row; +1 row when the seasonal banner takes the top slot.
    drawLobbyBanner(text, lobbyBannerSeasonalClaim ? 128 : 92);
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
// The controller type a slot is driving with (Xbox/PlayStation/generic), or null when it's
// on touch/keyboard. Shared by the close-glyph + bumper-glyph hints.
function slotPadType(lp) {
    var padActive = (typeof activeInputMethod !== "undefined" && activeInputMethod === "pad");
    if (!lp.isPrimary || padActive) {
        return (lp && lp.padType) ? lp.padType : (typeof gamepadType !== "undefined" ? gamepadType : "generic");
    }
    return null;
}
// The CLOSE/exit glyph for a slot when it's on a controller (Xbox B / PlayStation ○),
// else null (touch/keyboard use the ✕ button + Esc).
function slotCloseGlyph(lp) {
    var type = slotPadType(lp);
    if (type == null) { return null; }
    return (typeof leaveGlyphFor === "function") ? leaveGlyphFor(type) : (type === "playstation" ? "○" : "B");
}
// Left/right bumper labels for the skin-shop tab switch (PlayStation L1/R1 vs Xbox LB/RB).
function padBumperGlyphs(type) {
    return type === "playstation" ? { l: "L1", r: "R1" } : { l: "LB", r: "RB" };
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
    if (kind === "playlist") {
        w = 280;
        h = 150; // room for the playlist name + map count + one-line description
    }
    if (kind === "skin") {
        w = 300;
        // FIXED size (tabbed/paged picker) — independent of how many cosmetics exist, so
        // several of these fit on screen at once in couch co-op. See skinPanelHeight().
        h = skinPanelHeight();
    }
    var x = lhClamp(sp.x - w / 2, 8, LOGICAL_WIDTH - w - 8);
    var y = lhClamp(sp.y - h - 46, 8, LOGICAL_HEIGHT - h - 8);
    var tint = (lp.myID != null && playerList && playerList[lp.myID]) ? playerList[lp.myID].color : "#fff";
    var hit = { prompt: null, options: [], close: null };

    gameContext.save();
    // Solid, near-opaque panel + a soft drop shadow so it separates cleanly from the busy
    // lobby behind it (the old translucent fill let the terrain bleed through and washed it
    // out). Shadow is cleared before the border stroke so only the fill casts it.
    gameContext.globalAlpha = 1;
    gameContext.shadowColor = "rgba(0,0,0,0.55)";
    gameContext.shadowBlur = 18;
    gameContext.shadowOffsetY = 5;
    gameContext.fillStyle = "rgba(14,16,22,0.985)";
    lhRoundRect(gameContext, x, y, w, h, 12);
    gameContext.fill();
    gameContext.shadowColor = "transparent";
    gameContext.shadowBlur = 0;
    gameContext.shadowOffsetY = 0;
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = tint;
    gameContext.stroke();

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
    // Controller exit hint: the close-button glyph (Xbox B / PlayStation ○) in a small badge
    // just left of the ✕, so pad players know how to back out. Touch/keyboard see only the ✕.
    var closeGlyph = slotCloseGlyph(lp);
    if (closeGlyph) {
        var bcx = cl.x - 16, bcy = cl.y + cl.h / 2;
        gameContext.beginPath();
        gameContext.arc(bcx, bcy, 9, 0, 2 * Math.PI);
        gameContext.fillStyle = "rgba(0,0,0,0.45)";
        gameContext.fill();
        gameContext.lineWidth = 1.5;
        gameContext.strokeStyle = "rgba(255,255,255,0.55)";
        gameContext.stroke();
        gameContext.fillStyle = "#fff";
        gameContext.font = "bold 11px sans-serif";
        gameContext.textAlign = "center";
        gameContext.textBaseline = "middle";
        gameContext.fillText(closeGlyph, bcx, bcy + 0.5);
    }

    if (kind === "ai") {
        drawAIPanelBody(x, y, w, h, hit);
    } else if (kind === "playlist") {
        drawPlaylistPanelBody(x, y, w, h, hit);
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

// Playlist board body: a ◄ name ► stepper through config.playlists, with the
// map count and a one-line description. Selection is room-wide (last-writer-wins)
// and applies to the next round's map pick.
function drawPlaylistPanelBody(x, y, w, h, hit) {
    var id = currentPlaylistId();
    var def = playlistDef(id);
    var name = def ? def.name : id;
    var count = playlistCount(id);
    var midY = y + 62;
    // playlist name, centred
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    gameContext.fillStyle = "#fff";
    gameContext.font = "bold 22px sans-serif";
    gameContext.fillText(name, x + w / 2, midY);
    // ◄ / ► buttons
    var dec = { x: x + 12, y: midY - 20, w: 40, h: 40 };
    var inc = { x: x + w - 52, y: midY - 20, w: 40, h: 40 };
    gameContext.font = "bold 28px sans-serif";
    gameContext.fillStyle = HUB_ACCENT;
    gameContext.fillText("◄", dec.x + dec.w / 2, dec.y + dec.h / 2);
    gameContext.fillText("►", inc.x + inc.w / 2, inc.y + inc.h / 2);
    hit.options.push({ rect: dec, action: "dec" });
    hit.options.push({ rect: inc, action: "inc" });
    // map count
    if (count != null) {
        gameContext.fillStyle = "#cfd6dd";
        gameContext.font = "12px sans-serif";
        gameContext.fillText(count + (count === 1 ? " map" : " maps"), x + w / 2, midY + 24);
    }
    // one-line description
    if (def && def.desc) {
        gameContext.fillStyle = "#9aa";
        gameContext.font = "12px sans-serif";
        gameContext.fillText(def.desc, x + w / 2, y + h - 30);
    }
    // footer caption
    gameContext.fillStyle = "#9aa";
    gameContext.font = "12px sans-serif";
    gameContext.fillText("applies next race", x + w / 2, y + h - 14);
}

// === Tabbed/paged skin picker ================================================
// Fixed-size panel so 4-player couch co-op fits several of these on screen at once
// (paging bounds the size regardless of how many cosmetics exist). Per-player state in
// lp.stationPanel = { tab, region, cursor }: `tab` = active category, `cursor` = index into
// that tab's item list (page = floor(cursor/PER_PAGE)), `region` = 'tabs'|'grid'|'page' for
// keyboard/gamepad focus. Pointer (primary) taps tabs/cells/arrows directly.
var SKIN_PICKER_COLS = 4;
var SKIN_PICKER_ROWS = 3;
var SKIN_PICKER_CELLH = 54;
var SKIN_PICKER_PER_PAGE = SKIN_PICKER_COLS * SKIN_PICKER_ROWS;

function skinTabs(lp) {
    var tabs = [
        { key: 'color', label: 'Color' },
        { key: 'cart', label: 'Carts' }
    ];
    // Patterns only render on the plain/default cart (a shaped cart hides them), so drop the
    // Patterns tab whenever a cart shape is equipped. Borders read cleanly over ANY cart, so
    // they're always available.
    if (!currentCosmetic(lp, 'cart')) { tabs.push({ key: 'pattern', label: 'Patterns' }); }
    // Borders tab appears once any border cosmetic is registered (Phase B).
    if (typeof getSkinsForSlot === "function" && getSkinsForSlot('border').length > 0) {
        tabs.push({ key: 'border', label: 'Borders' });
    }
    tabs.push({ key: 'trail', label: 'Trails' });
    return tabs;
}
// Reset the active tab to a valid one if the current tab was just hidden (e.g. Patterns
// after a cart got equipped). Keeps the picker from showing items for an absent tab.
function skinValidateTab(lp) {
    var sp = lp.stationPanel; if (!sp) { return; }
    var tabs = skinTabs(lp);
    for (var i = 0; i < tabs.length; i++) { if (tabs[i].key === sp.tab) { return; } }
    sp.tab = 'cart'; sp.cursor = 0; sp.region = 'grid';
}
function skinTabIndex(lp, key) {
    var tabs = skinTabs(lp);
    for (var i = 0; i < tabs.length; i++) { if (tabs[i].key === key) { return i; } }
    return 0;
}
// Item list for a tab. color -> swatches (+ an avatar cell when available);
// cart/pattern/trail -> that slot's COSMETIC_OPTIONS (default + unlockables).
function skinTabItems(lp, tabKey) {
    var out = [];
    if (tabKey === 'color') {
        var pal = skinPalette();
        for (var i = 0; i < pal.length; i++) { out.push({ kind: 'color', color: pal[i] }); }
        if (avatarSkinProfile(lp)) { out.push({ kind: 'avatar' }); }
        return out;
    }
    var cosmetics = [];
    for (var j = 0; j < COSMETIC_OPTIONS.length; j++) {
        if (COSMETIC_OPTIONS[j].slot === tabKey) { cosmetics.push(COSMETIC_OPTIONS[j]); }
    }
    cosmetics.sort(function (a, b) { return cosmeticPickerCompare(lp, a, b); });
    for (var k = 0; k < cosmetics.length; k++) { out.push({ kind: 'cosmetic', opt: cosmetics[k] }); }
    return out;
}
// Picker grid order: slot DEFAULT first, then UNLOCKED items before locked ones, and within
// each group by unlock level ascending with achievement unlocks last. Re-evaluated on every
// build (cartSkinUnlock reads live progression), so an item jumps above the locked ones the
// moment it unlocks.
function cosmeticUnlockRank(opt) {
    if (opt.id == null) { return -1; } // slot default ("None"/"Plain") — always first
    var skin = (typeof getSkin === "function") ? getSkin(opt.id) : null;
    if (skin && skin.unlock) {
        if (skin.unlock.kind === "level") { return skin.unlock.level; }   // 2..100
        if (skin.unlock.kind === "achievement") { return 1000000; }       // after all levels
    }
    return 1000001;
}
function cosmeticPickerCompare(lp, a, b) {
    if ((a.id == null) !== (b.id == null)) { return a.id == null ? -1 : 1; }
    var la = cartSkinUnlock(a.id, lp).locked ? 1 : 0;
    var lb = cartSkinUnlock(b.id, lp).locked ? 1 : 0;
    if (la !== lb) { return la - lb; }                                     // unlocked before locked
    return cosmeticUnlockRank(a) - cosmeticUnlockRank(b);                  // then level asc, achievements last
}
// Full fixed panel height: title gap + tab row + grid + badge + page row.
function skinPanelHeight() {
    return 38 + 26 + 10 + SKIN_PICKER_ROWS * (SKIN_PICKER_CELLH + 6) + 20 + 24;
}

function drawSkinPanelBody(lp, x, y, w, h, hit) {
    var sp = lp.stationPanel;
    if (sp.tab == null) { sp.tab = 'color'; }
    if (sp.region == null) { sp.region = 'grid'; }
    skinValidateTab(lp);
    var pad = 14, gap = 6, cols = SKIN_PICKER_COLS;
    var tabs = skinTabs(lp);
    // tab row. On a controller, reserve a gutter on each side for the LB/RB bumper hints
    // (bumpers switch tabs); touch/keyboard get the full width with no gutters.
    var tabTop = y + 38, tabH = 26;
    var padType = slotPadType(lp);
    var gut = padType ? 22 : 0;
    if (padType) {
        var bg = padBumperGlyphs(padType);
        gameContext.fillStyle = "rgba(255,255,255,0.7)";
        gameContext.font = "bold 10px sans-serif";
        gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
        gameContext.fillText(bg.l, x + pad + gut / 2, tabTop + tabH / 2 + 1);
        gameContext.fillText(bg.r, x + w - pad - gut / 2, tabTop + tabH / 2 + 1);
    }
    var tabW = (w - pad * 2 - gut * 2) / tabs.length;
    for (var t = 0; t < tabs.length; t++) {
        var tx = x + pad + gut + t * tabW;
        var active = tabs[t].key === sp.tab;
        gameContext.fillStyle = active ? "rgba(255,211,77,0.22)" : "rgba(255,255,255,0.10)";
        lhRoundRect(gameContext, tx + 1, tabTop, tabW - 2, tabH, 6); gameContext.fill();
        if (sp.region === 'tabs' && active) {
            gameContext.strokeStyle = "#fff"; gameContext.lineWidth = 2;
            lhRoundRect(gameContext, tx + 1, tabTop, tabW - 2, tabH, 6); gameContext.stroke();
        }
        gameContext.fillStyle = active ? "#ffd34d" : "rgba(255,255,255,0.82)";
        gameContext.font = (active ? "bold " : "") + "11px sans-serif";
        gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
        gameContext.fillText(tabs[t].label, tx + tabW / 2, tabTop + tabH / 2 + 1);
        hit.options.push({ rect: { x: tx, y: tabTop, w: tabW, h: tabH }, action: "tab:" + tabs[t].key });
    }
    // grid for the active tab's current page
    var items = skinTabItems(lp, sp.tab);
    if (sp.cursor == null) { sp.cursor = 0; }
    if (sp.cursor > items.length - 1) { sp.cursor = Math.max(0, items.length - 1); }
    var perPage = SKIN_PICKER_PER_PAGE;
    var page = Math.floor(sp.cursor / perPage);
    var pageCount = Math.max(1, Math.ceil(items.length / perPage));
    var cellW = (w - pad * 2 - gap * (cols - 1)) / cols;
    var cellH = SKIN_PICKER_CELLH;
    var gridTop = tabTop + tabH + 10;
    var currentColor = skinCurrentColor(lp);
    for (var k = 0; k < perPage; k++) {
        var idx = page * perPage + k;
        if (idx >= items.length) { break; }
        var cx = x + pad + (k % cols) * (cellW + gap);
        var cy = gridTop + Math.floor(k / cols) * (cellH + gap);
        drawSkinCell(lp, items[idx], cx, cy, cellW, cellH, (sp.region === 'grid' && idx === sp.cursor), currentColor, hit);
    }
    // Lv/XP badge (or sign-in nudge)
    var badgeY = gridTop + SKIN_PICKER_ROWS * (cellH + gap) + 2;
    drawProgressionBadge(lp, x + pad, badgeY, w - pad * 2);
    // page controls
    var pgY = y + h - 22;
    if (pageCount > 1) {
        var arrowOn = (sp.region === 'page');
        var lrect = { x: x + pad, y: pgY - 11, w: 30, h: 22 };
        var rrect = { x: x + w - pad - 30, y: pgY - 11, w: 30, h: 22 };
        gameContext.fillStyle = arrowOn ? "#fff" : "#9cdcff";
        gameContext.font = "bold 18px sans-serif"; gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
        gameContext.fillText("◄", lrect.x + lrect.w / 2, pgY);
        gameContext.fillText("►", rrect.x + rrect.w / 2, pgY);
        hit.options.push({ rect: lrect, action: "page:-1" });
        hit.options.push({ rect: rrect, action: "page:1" });
        var dotGap = 12, dx0 = x + w / 2 - (pageCount - 1) * dotGap / 2;
        for (var d = 0; d < pageCount; d++) {
            gameContext.beginPath();
            gameContext.arc(dx0 + d * dotGap, pgY, d === page ? 3.5 : 2.5, 0, Math.PI * 2);
            gameContext.fillStyle = d === page ? "#ffd34d" : "rgba(255,255,255,0.4)";
            gameContext.fill();
        }
    }
    // transient "locked"/"colour taken" toast
    var msg = null;
    if (lp._cartLockAt && (Date.now() - lp._cartLockAt) < 1600 && lp._cartLockMsg) { msg = lp._cartLockMsg; }
    else if (lp._skinRejectAt && (Date.now() - lp._skinRejectAt) < 1500) { msg = "Colour taken"; }
    if (msg) {
        gameContext.fillStyle = "#ff6b6b"; gameContext.textAlign = "center"; gameContext.font = "bold 11px sans-serif";
        gameContext.fillText(msg, x + w / 2, badgeY + 14);
    }
}

// Draw one picker cell (colour swatch / avatar / cosmetic) + push its hit target.
function drawSkinCell(lp, item, cx, cy, cw, ch, focused, currentColor, hit) {
    if (item.kind === 'color') {
        var taken = skinTakenColors(lp);
        var isTaken = !!taken[item.color];
        var hasAvatar = playerHasAvatarSkin(lp);
        gameContext.globalAlpha = isTaken ? 0.32 : 1;
        gameContext.fillStyle = item.color;
        lhRoundRect(gameContext, cx, cy, cw, ch, 6); gameContext.fill();
        gameContext.globalAlpha = 1;
        if (item.color === skinCurrentColor(lp) && !hasAvatar) {
            gameContext.fillStyle = "#000"; gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
            gameContext.font = "bold 18px sans-serif"; gameContext.fillText("✓", cx + cw / 2, cy + ch / 2 + 1);
        }
        if (isTaken) {
            gameContext.strokeStyle = "rgba(0,0,0,0.6)"; gameContext.lineWidth = 2;
            gameContext.beginPath(); gameContext.moveTo(cx + 5, cy + 5); gameContext.lineTo(cx + cw - 5, cy + ch - 5); gameContext.stroke();
        }
        if (focused) { gameContext.strokeStyle = "#fff"; gameContext.lineWidth = 3; lhRoundRect(gameContext, cx - 1, cy - 1, cw + 2, ch + 2, 7); gameContext.stroke(); }
        hit.options.push({ rect: { x: cx, y: cy, w: cw, h: ch }, action: isTaken ? "noop" : ("pick:" + item.color) });
        return;
    }
    if (item.kind === 'avatar') {
        var hasAv = playerHasAvatarSkin(lp);
        var avProfile = avatarSkinProfile(lp);
        gameContext.fillStyle = "#f4c542";
        lhRoundRect(gameContext, cx, cy, cw, ch, 6); gameContext.fill();
        var inset = 3;
        var av = (avProfile && typeof preloadAvatarImage === "function") ? preloadAvatarImage(avProfile.avatarUrl) : null;
        if (av && av.ready && !av.failed) {
            gameContext.save();
            lhRoundRect(gameContext, cx + inset, cy + inset, cw - inset * 2, ch - inset * 2, 4); gameContext.clip();
            gameContext.drawImage(av.img, cx + inset, cy + inset, cw - inset * 2, ch - inset * 2);
            gameContext.restore();
        } else {
            gameContext.fillStyle = "#222"; gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
            gameContext.font = "16px sans-serif"; gameContext.fillText("👤", cx + cw / 2, cy + ch / 2 + 1);
        }
        if (hasAv) {
            gameContext.beginPath(); gameContext.arc(cx + cw - 8, cy + 8, 7, 0, 2 * Math.PI);
            gameContext.fillStyle = "rgba(0,0,0,0.7)"; gameContext.fill();
            gameContext.fillStyle = "#fff"; gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
            gameContext.font = "bold 10px sans-serif"; gameContext.fillText("✓", cx + cw - 8, cy + 8.5);
        }
        if (focused) { gameContext.strokeStyle = "#fff"; gameContext.lineWidth = 3; lhRoundRect(gameContext, cx - 1, cy - 1, cw + 2, ch + 2, 7); gameContext.stroke(); }
        hit.options.push({ rect: { x: cx, y: cy, w: cw, h: ch }, action: "pickAvatar" });
        return;
    }
    var opt = item.opt;
    var sel = currentCosmetic(lp, opt.slot) === opt.id;
    var lock = cartSkinUnlock(opt.id, lp);
    gameContext.fillStyle = sel ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
    lhRoundRect(gameContext, cx, cy, cw, ch, 6); gameContext.fill();
    gameContext.lineWidth = sel ? 2 : 1;
    gameContext.strokeStyle = sel ? "#ffd34d" : (lock.locked ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.2)");
    lhRoundRect(gameContext, cx, cy, cw, ch, 6); gameContext.stroke();
    // Seasonal-claim cosmetics (rarity:'seasonal') get a distinct GOLD frame so they read as
    // special/limited in the locker. Skipped when the gold "selected" ring already shows.
    var raritySkin = (typeof getSkin === "function") ? getSkin(opt.id) : null;
    if (!sel && raritySkin && raritySkin.rarity === "seasonal") {
        gameContext.lineWidth = 2; gameContext.strokeStyle = "#ffb31f";
        lhRoundRect(gameContext, cx, cy, cw, ch, 6); gameContext.stroke();
    }
    if (focused) { gameContext.strokeStyle = "#fff"; gameContext.lineWidth = 2.5; lhRoundRect(gameContext, cx - 1, cy - 1, cw + 2, ch + 2, 7); gameContext.stroke(); }
    drawCosmeticPreview(opt, cx + cw / 2, cy + ch * 0.34, ch * 0.22, currentColor, lock.locked, { x: cx, y: cy, w: cw, h: ch });
    gameContext.fillStyle = lock.locked ? "rgba(255,255,255,0.5)" : "#fff";
    gameContext.font = "8.5px sans-serif"; gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
    gameContext.fillText(opt.label, cx + cw / 2, cy + ch * 0.74);
    if (lock.locked && lock.text) {
        gameContext.fillStyle = "#ffd34d"; gameContext.font = "bold 8.5px sans-serif";
        gameContext.fillText("🔒 " + lock.text, cx + cw / 2, cy + ch * 0.93);
    }
    hit.options.push({ rect: { x: cx, y: cy, w: cw, h: ch }, action: "cosmetic:" + opt.slot + ":" + (opt.id == null ? "" : opt.id) });
}

// Activate the focused item (pad/keyboard confirm or pointer tap).
function activateSkinItem(lp, item) {
    if (!item) { return; }
    if (item.kind === 'color') { stationPickSkin(lp, item.color); }
    else if (item.kind === 'avatar') { stationPickAvatar(lp); }
    else if (item.kind === 'cosmetic') { stationPickCosmetic(lp, item.opt); }
}


// Procedural preview thumbnail for a cosmetic cell, rendered in the player's current
// colour and greyed when locked. Cart/pattern previews run the real registry painter
// (pattern over a tinted disc so it reads as "on a body"); trail previews draw a short
// stroke styled by the effect — so every cell previews close to how it drives.
function drawCosmeticPreview(opt, cx, cy, r, paint, locked, cell) {
    var slot = opt.slot;
    var color = paint || "#cccccc";
    gameContext.save();
    // Keep TRAIL previews inside their cell — particle trails (smoke/hearts/confetti/ripples)
    // emit well beyond the synthetic ±40 space and would otherwise spill into neighbouring
    // cells. Clip to the cell's content box, stopping above the label row (~0.62h). Only trails
    // overflow; cart/pattern/border previews are discs that already fit, so they're left
    // unclipped to avoid shaving a pattern disc's bottom edge.
    if (cell && slot === "trail") {
        var pad = 2;
        lhRoundRect(gameContext, cell.x + pad, cell.y + pad, cell.w - pad * 2, cell.h * 0.62 - pad, 5);
        gameContext.clip();
    }
    if (locked) { gameContext.globalAlpha = 0.4; }
    if (opt.id == null) {
        // Slot default: a plain disc (cart/pattern) or a plain short stroke (trail).
        if (slot === "trail") {
            gameContext.strokeStyle = color; gameContext.lineWidth = 2; gameContext.lineCap = "round";
            gameContext.beginPath(); gameContext.moveTo(cx - r, cy); gameContext.lineTo(cx + r, cy); gameContext.stroke();
        } else {
            gameContext.fillStyle = slot === "cart" ? color : "rgba(255,255,255,0.4)";
            gameContext.beginPath(); gameContext.arc(cx, cy, r * 0.7, 0, Math.PI * 2); gameContext.fill();
        }
        gameContext.restore();
        return;
    }
    if (slot === "trail") {
        var effect = (typeof getTrailEffect === "function") ? getTrailEffect(opt.id) : null;
        var fx = (effect && typeof TRAIL_FX !== "undefined") ? TRAIL_FX[effect] : null;
        if (fx) {
            // Trails are MOTION effects — a static stroke made them all look identical. Render
            // the REAL effect on a synthetic curved path (a kart flying right, trail behind it),
            // built in a virtual ±40px space and scaled down into the small cell (which clips).
            var nowMs = Date.now();
            var fadeMs = (typeof TRAIL_FADE_MS !== "undefined") ? TRAIL_FADE_MS : 1700;
            var animMs = (typeof cartSkinAnimTime !== "undefined") ? cartSkinAnimTime * 1000 : 0;
            gameContext.translate(cx, cy);
            gameContext.scale(r / 42, r / 42);
            var verts = [], STEPS = 26;
            for (var ti = 0; ti <= STEPS; ti++) {
                var u = ti / STEPS;                        // 0 = tail (oldest) .. 1 = kart (newest)
                verts.push({
                    x: (u * 2 - 1) * 40,                   // tail at left, kart head at right
                    y: Math.sin(u * Math.PI) * -14 + 6,    // gentle arc
                    t: nowMs - fadeMs * (1 - u)            // newest vertex at the kart end
                });
            }
            if (typeof tfxBaseAlpha !== "undefined") { tfxBaseAlpha = 1; }
            try { fx(gameContext, verts, color, nowMs, fadeMs, animMs); } catch (e) {}
            // Small kart head at the newest end so the trail reads as flowing behind a kart.
            var head = verts[verts.length - 1];
            gameContext.fillStyle = color;
            gameContext.beginPath(); gameContext.arc(head.x, head.y, 9, 0, Math.PI * 2); gameContext.fill();
            gameContext.restore();
            return;
        }
        // Fallback (unknown/missing effect): a plain stroke.
        gameContext.strokeStyle = color; gameContext.lineCap = "round"; gameContext.lineWidth = 2;
        gameContext.beginPath(); gameContext.moveTo(cx - r, cy + r * 0.3); gameContext.quadraticCurveTo(cx, cy - r * 0.6, cx + r, cy + r * 0.3); gameContext.stroke();
        gameContext.restore();
        return;
    }
    var painter = (typeof getSkinPainter === "function") ? getSkinPainter(opt.id) : null;
    if (!painter) {
        gameContext.fillStyle = "rgba(255,255,255,0.25)";
        gameContext.beginPath(); gameContext.arc(cx, cy, r * 0.7, 0, Math.PI * 2); gameContext.fill();
        gameContext.restore();
        return;
    }
    gameContext.translate(cx, cy);
    // Match the in-game orientation: drawCartSkin draws STATUE carts upright (native, no
    // heading rotation), and everything else faces "forward" (+X). Rotate −90° so forward
    // reads as up in the thumbnail — but NOT for statue carts, or they'd sit 90° off from
    // how they actually look in game.
    var previewSkin = (typeof getSkin === "function") ? getSkin(opt.id) : null;
    var previewStatue = !!(slot === "cart" && previewSkin && previewSkin.statue);
    if (!previewStatue) { gameContext.rotate(-Math.PI / 2); }
    var anim = (typeof cartSkinAnimTime !== "undefined") ? cartSkinAnimTime : 0;
    if (slot === "border") {
        // Borders ring the rim (~1.0..1.4 in normalized space) and compose over ANY cart.
        // Scale tighter than patterns/carts so the wider rim stays inside the cell; draw a
        // small tinted disc as a stand-in kart body, then the border painter UNCLIPPED.
        gameContext.scale(r, r);
        gameContext.fillStyle = color;
        gameContext.beginPath(); gameContext.arc(0, 0, 0.7, 0, Math.PI * 2); gameContext.fill();
        painter(gameContext, anim, color);
    } else if (slot === "pattern") {
        // Patterns are body overlays — draw a tinted disc base, then the texture clipped to it.
        gameContext.scale(r * 1.5, r * 1.5);
        gameContext.fillStyle = color;
        gameContext.beginPath(); gameContext.arc(0, 0, 0.95, 0, Math.PI * 2); gameContext.fill();
        gameContext.save();
        gameContext.beginPath(); gameContext.arc(0, 0, 0.95, 0, Math.PI * 2); gameContext.clip();
        painter(gameContext, anim, color);
        gameContext.restore();
    } else {
        gameContext.scale(r * 1.5, r * 1.5);
        painter(gameContext, anim, color);
    }
    gameContext.restore();
}

// This local player's currently-equipped id for a slot (server-authoritative), else null.
function currentCosmetic(lp, slot) {
    var p = (lp && lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
    var field = (typeof COSMETIC_SLOT_FIELD !== "undefined") ? COSMETIC_SLOT_FIELD[slot] : null;
    return (p && field && p[field]) || null;
}

// Commit a cosmetic pick for one slot: emit setCosmetic on this slot's socket. The change
// lands for everyone via playerCosmeticChanged; "" / null clears the slot to its default.
// Persisted to localStorage for instant re-equip on next join. The other two slots are
// untouched (three independent slots).
function stationPickCosmetic(lp, opt) {
    if (!lp || !lp.socket || !opt) {
        return;
    }
    // Don't burn a round-trip on a locked cosmetic — show the requirement (the server
    // re-validates on equip regardless; this is just UX).
    var lock = cartSkinUnlock(opt.id || null, lp);
    if (lock.locked) {
        lp._cartLockMsg = lock.text ? ("Unlock at " + lock.text) : "Locked";
        lp._cartLockAt = Date.now();
        return;
    }
    var id = opt.id || null;
    lp.socket.emit("setCosmetic", { slot: opt.slot, id: id });
    saveCosmeticLocal(lp, opt.slot, id);
    // Patterns and borders are INDEPENDENT slots (player.pattern vs player.border) — equipping
    // one no longer clears the other; both persist and re-equip on the next join.
    var p = (lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
    var field = (typeof COSMETIC_SLOT_FIELD !== "undefined") ? COSMETIC_SLOT_FIELD[opt.slot] : null;
    if (p && field) {
        p[field] = id; // optimistic local update
    }
}
// Cosmetic-picker layout: positions each option in one of three labeled groups —
// "Carts" / "Patterns" / "Trails" — each starting on a fresh row under a small header.
// Returns per-option {x,y} offsets (relative to the row's x/gridY origin), the group
// header positions, and total height. Shared by the panel-height calc and the renderer
// so they never disagree. cellW/ch are the cell size. Groups by COSMETIC_OPTIONS[i].slot.
var CART_GROUP_HEADER_H = 16;
var COSMETIC_GROUP_LABEL = { cart: 'Carts', pattern: 'Patterns', trail: 'Trails', border: 'Borders' };
function cartSkinLayout(innerW) {
    var cgap = 6;
    var minCellW = 46;
    var n = COSMETIC_OPTIONS.length;
    var cols = Math.max(1, Math.floor((innerW + cgap) / (minCellW + cgap)));
    if (cols > n) { cols = Math.max(1, n); }
    var cellW = (innerW - cgap * (cols - 1)) / cols;
    var ch = CART_SKIN_CELL_H;
    var cells = [];
    var headers = [];
    var yCursor = 0;
    var lastSlot = null;
    var colInGroup = 0;
    var rowTopY = 0;
    for (var i = 0; i < n; i++) {
        var slot = COSMETIC_OPTIONS[i].slot;
        if (slot !== lastSlot) {
            // New group: header line, then reset to the start of a fresh row.
            if (lastSlot !== null) { yCursor += cgap; }
            headers.push({ label: COSMETIC_GROUP_LABEL[slot] || slot, y: yCursor });
            yCursor += CART_GROUP_HEADER_H;
            rowTopY = yCursor;
            colInGroup = 0;
            lastSlot = slot;
        } else if (colInGroup >= cols) {
            colInGroup = 0;
            rowTopY += ch + cgap;
            yCursor = rowTopY;
        }
        cells.push({ x: colInGroup * (cellW + cgap), y: rowTopY });
        colInGroup++;
        yCursor = rowTopY + ch; // bottom of current row
    }
    return { cols: cols, cellW: cellW, ch: ch, cgap: cgap, cells: cells, headers: headers, height: yCursor };
}
// Unlock state for a cosmetic id, derived from the local progression cache.
// Display only — the server is authoritative and re-checks every equip.
function cartSkinUnlock(id, lp) {
    if (id == null) { return { locked: false }; }
    var skin = (typeof getSkin === "function") ? getSkin(id) : null;
    if (!skin) { return { locked: true, text: "?" }; }
    // Dev/testing seam (UNLOCK_ALL_COSMETICS): every cosmetic shows as unlocked locally.
    if (typeof config !== "undefined" && config && config.unlockAllCosmetics) { return { locked: false }; }
    // Per-seat: only the PRIMARY seat owns myProgression. Couch seats connect as guests, so
    // they must gate at guest level (prog=null => Lv1, no achievement skins) — otherwise a pad
    // player sees P1's unlocks, picks one, and the server just rejects it.
    var prog = (lp && !lp.isPrimary) ? null : ((typeof myProgression !== "undefined") ? myProgression : null);
    if (skin.unlock.kind === "open") { return { locked: false }; } // unlock-all-for-testing
    if (skin.unlock.kind === "level") {
        var lvl = prog ? (prog.level || 1) : 1;
        if (lvl >= skin.unlock.level) { return { locked: false }; }
        return { locked: true, text: "Lv " + skin.unlock.level };
    }
    if (skin.unlock.kind === "seasonal") {
        // Claimed seasonal cosmetics live in unlocked_skins (permanent). If not owned, show
        // whether it's still claimable (sign in during the window) or gone for good.
        var owns = !!(prog && prog.unlocked_skins && prog.unlocked_skins.indexOf(id) !== -1);
        if (owns) { return { locked: false }; }
        var open = (typeof isClaimWindowOpen === "function") && isClaimWindowOpen(skin.unlock, Date.now());
        return { locked: true, text: open ? "Sign in to claim" : "Expired" };
    }
    if (skin.unlock.kind !== "achievement") { return { locked: true, text: "?" }; }
    var owned = !!(prog && prog.unlocked_skins && prog.unlocked_skins.indexOf(id) !== -1);
    return owned ? { locked: false } : { locked: true, text: "🏆" };
}
// Lv badge + an XP-to-next-level bar for signed-in players; a sign-in nudge for guests.
function drawProgressionBadge(lp, x, y, w) {
    var prog = (typeof myProgression !== "undefined") ? myProgression : null;
    gameContext.textAlign = "left";
    gameContext.textBaseline = "middle";
    if (!prog) {
        gameContext.fillStyle = "rgba(255,255,255,0.85)";
        gameContext.font = "11px sans-serif";
        gameContext.fillText("Sign in to earn XP & unlock skins", x, y + 10);
        return;
    }
    gameContext.fillStyle = "#ffd34d";
    gameContext.font = "bold 12px sans-serif";
    gameContext.fillText("Lv " + (prog.level || 1), x, y + 10);
    var barX = x + 46, barW = Math.max(20, w - 46), barH = 7, barY = y + 5;
    var frac = 0;
    if (prog.xpForNextLevel) {
        frac = Math.max(0, Math.min(1, (prog.xpThisLevel || 0) / prog.xpForNextLevel));
    }
    gameContext.fillStyle = "rgba(255,255,255,0.15)";
    lhRoundRect(gameContext, barX, barY, barW, barH, 4); gameContext.fill();
    gameContext.fillStyle = "#ffd34d";
    lhRoundRect(gameContext, barX, barY, Math.max(2, barW * frac), barH, 4); gameContext.fill();
}
// Surface a server-side cosmetic rejection on the (lobby-)slot's open panel. `slot` here
// is the LOCAL-PLAYER slot (primary/couch), not the cosmetic slot; payload.slot/reason
// describe the cosmetic-slot + why it was rejected.
function flagCosmeticRejected(slot, payload) {
    var lp = (typeof localPlayers !== "undefined" && localPlayers) ? localPlayers[slot] : null;
    if (!lp) { return; }
    var msg = "Locked";
    if (payload && payload.reason === "level" && payload.required) {
        msg = "Unlock at Lv " + payload.required;
    } else if (payload && payload.reason === "achievement") {
        msg = "Earn the medal to unlock";
    } else if (payload && payload.reason === "seasonal") {
        // Seasonal claim the player never claimed in its window. Match the locker's own wording:
        // still claimable -> "Sign in to claim"; window closed -> "Expired".
        var sUnlock = (typeof getSkin === "function" && payload.id) ? (getSkin(payload.id) || {}).unlock : null;
        var stillOpen = !!(sUnlock && typeof isClaimWindowOpen === "function" && isClaimWindowOpen(sUnlock, Date.now()));
        msg = stillOpen ? "Sign in to claim" : "Expired";
    }
    lp._cartLockMsg = msg;
    lp._cartLockAt = Date.now();
    // Revert the optimistic re-equip: reEquipSavedCosmetics set the slot field immediately, but
    // the server rejected it (e.g. a cosmetic saved under a different account). Clear the field
    // so we render the server default (not a locked cosmetic peers don't see), and drop the
    // saved pick so it can't re-apply on the next join. Signed-in players' real picks live in
    // the DB (restorePersistedCosmetics), so nothing legit is lost.
    var cosmeticSlot = payload && payload.slot;
    if (cosmeticSlot && typeof COSMETIC_SLOT_FIELD !== "undefined" && COSMETIC_SLOT_FIELD[cosmeticSlot]) {
        var p = (lp.myID != null && typeof playerList !== "undefined" && playerList) ? playerList[lp.myID] : null;
        if (p) { p[COSMETIC_SLOT_FIELD[cosmeticSlot]] = null; }
        if (typeof saveCosmeticLocal === "function") { saveCosmeticLocal(lp, cosmeticSlot, null); }
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

// Read-only mirror of lobbyHubHandlePrimaryPointer: returns true if a pointer at
// (lx, ly) WOULD be consumed by the hub, WITHOUT mutating any panel state. Used by
// handleDblClick so a rapid double-click on a hub prompt/panel doesn't get treated
// as the desktop "toggle mouse-drive" gesture. While a panel is open every click is
// captured by the hub (control, close, or dismiss-away), so any point counts.
function lobbyHubPointHitsActive(lx, ly) {
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
        return true;
    }
    var hit = stationHudHit[lp.slot];
    return !!(lp.nearStation && hit && lhPointIn(hit.prompt, lx, ly));
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
