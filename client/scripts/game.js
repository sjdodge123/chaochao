// DEBUG: set to true to log network events and state changes. Defaults to false.
var DEBUG_NETWORK = false;
function debugLog() {
    if (!DEBUG_NETWORK) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[debug]");
    console.log.apply(console, args);
}

var server = null,
    interval = null,
    gameLength = null,
    clientList = null,
    playerList = null,
    myPlayer = null,
    myID = null,
    gameContext = null,
    gameCanvas = null,
    overlayCanvas = null,
    overlayContext = null,
    newWidth = 0,
    newHeight = 0,
    // The fixed logical drawing space (the canvas' initial backing-store size,
    // 1366x768). All gameplay/HUD/touch coords live in this space; the canvas
    // backing store is sized to device pixels and scaled back to it each frame
    // (see resize() + applyCanvasTransform), so high-DPR displays render crisp.
    LOGICAL_WIDTH = 0,
    LOGICAL_HEIGHT = 0,
    // Immutable 16:9 base (the canvas HTML attrs). LOGICAL_WIDTH may be WIDENED past this
    // to fill a wide frame (fillViewport); restored to BASE on every non-fill resize so a
    // context flip (e.g. touch->kbm, HMR) can't leave it stuck wide. See resize().
    BASE_LOGICAL_WIDTH = 0,
    fitRatio = 1,   // logical->CSS px scale, for stable physical label sizes
    canvasScaleX = 1,  // logical->backing-store scale applied per frame (DPR-aware)
    canvasScaleY = 1,
    // --- dynamic touch camera (world zoom) ---
    // Smoothed view {cx, cy, scale} in world coords; null until the first frame.
    // Whole-map = identity (centre LOGICAL/2, scale 1); racing focuses on the
    // player and pulls the nearest goal into frame as it's approached.
    worldView = null,
    // Dynamic camera on/off. Defaults ON for every input method (set true in
    // initEventHandlers), toggleable by anyone via the navbar camera button.
    // Auto-falls back to whole-map when >1 local player shares the screen.
    cameraZoomEnabled = false,
    // Colour-blind assist: when on, draw.js remaps every kart to a CVD-safe
    // palette. Persisted in localStorage (see the #colorblindControl wiring).
    colorblindEnabled = false,
    worldViewFocusedElapsed = 0,  // ms accumulated in the focus phase (frame-dt based, not wall-clock)
    // Second Wind death-beat camera pan: while set, computeWorldViewTarget slow-pans the
    // local view from the death spot to the flag over the respawn delay, then releases.
    // { fromX, fromY, toX, toY, ms, startedAt }. Set by the secondWindPending handler
    // (local + solo only), cleared when the pan completes or on a new round.
    secondWindCam = null,
    // Warp pad camera pan: when the LOCAL player drives onto a warp pad, the camera
    // slow-pans from the entrance to the exit over the transit, then HOLDS on the exit
    // until the emerge (warpEnd) releases it. { fromX, fromY, toX, toY, ms, startedAt,
    // endAt }. Set by the warpStart handler (local only), cleared on warpEnd / failsafe /
    // new round. (computeWorldViewTarget in draw.js consumes it.)
    warpCam = null,
    // Second Wind flag claim: localPlayerId -> the flag (hazard ownerId) that local
    // player is CURRENTLY anchored to. A flag draws in a local player's colour only
    // while it's that player's active anchor, so re-anchoring to a new flag repaints the
    // old one neutral (matches the server's single moving checkpoint). Reset each round.
    secondWindClaimByPlayer = {},
    // Per-player smoothed look-ahead vectors keyed by player id (see
    // computeFocusedView). Smoothing the lead itself keeps steering wiggle,
    // punches and bounces from snapping the camera; cleared whenever the
    // camera leaves the focused states so no stale lead carries over.
    worldLeadSmooth = {},
    WORLD_ZOOM_MAX = 2.05,     // tightest cruise focus while racing (close enough to read the skin, far enough to navigate)
    WORLD_ZOOM_MOBILE_MULT = 1.2, // touch devices zoom 20% closer (smaller screens read better tight); 1 on desktop
    WORLD_ZOOM_ENGAGE = 460,   // world-units: nearest goal is FULLY framed within this
    WORLD_ZOOM_RELEASE = 620,  // world-units: goal framing fades smoothly to nothing by here (continuous blend, no pop)
    WORLD_ZOOM_PAD = 120,      // world-units padding around framed points
    WORLD_ZOOM_TAU = 620,      // smoothing time-constant (ms); higher = slower, gentler glide
    WORLD_ZOOM_HOLD_MS = 1100, // gate intro: hold the opening spawn close-up this long before panning out
    // Gate-intro arc shape, as fractions of the countdown after HOLD: pan OUT
    // from the spawn over OUT_FRAC, sit on the whole map for the remainder,
    // then ease back IN over the final IN_FRAC, landing as the gate opens.
    WORLD_ZOOM_GATE_OUT_FRAC = 0.34,
    WORLD_ZOOM_GATE_IN_FRAC = 0.40,
    worldViewGatedPrev = false, // was last frame in the gated STATE? (edge-detects gate entry, camera-toggle-independent)
    // True only when the camera was ON at the moment the gated state began —
    // the one frame where the intro's snap cut is hidden (overview scoreboard /
    // map swap). Toggling the camera off mid-countdown disarms the intro so a
    // re-enable can never replay the cut with the world visible.
    worldGatedIntroActive = false,
    // Goal-approach intensity zoom: once the goal is engaged, the zoom cap ramps
    // from WORLD_ZOOM_MAX up to (MAX + BOOST) as the group closes from ENGAGE
    // down to GOAL_FULL world-units — a finish-line punch-in. The framing box
    // still includes every living local player AND the goal, so the close-up
    // only lands when everyone has converged on it; the boost can never push a
    // local player off-screen.
    WORLD_ZOOM_GOAL_BOOST = 0.55,
    WORLD_ZOOM_GOAL_FULL = 140,
    // Velocity look-ahead: each player's framing box shifts ahead along their
    // velocity, up to LEAD_MAX world-units at/above LEAD_REF speed (≈ top speed
    // on normal tiles, measured ~83 u/s), so the tighter cruise zoom never costs
    // forward visibility — at speed the camera leads the kart; parked, you get
    // the tight skin-admiring view centred on it. The lead vector itself is
    // smoothed per player with LEAD_TAU (ms) so direction flips sway gently.
    WORLD_ZOOM_LEAD_REF = 80,
    WORLD_ZOOM_LEAD_MAX = 110,
    WORLD_ZOOM_LEAD_TAU = 700,
    // LOAD-BEARING screen-edge guarantee: the lead is additionally capped at this
    // fraction of the (zoom-dependent) half-box, so at least (1 - this) of the
    // half-box always stays behind a fast kart — i.e. it can never be led off
    // screen, no matter how the zoom caps above are retuned.
    WORLD_ZOOM_LEAD_BOX_FRAC = 0.55,
    // Max zoom-scale change per second while GATED (the countdown follows its
    // eased arc directly, with no exponential smoothing) — the designed arc
    // peaks ~0.6/s mid-smoothstep, so this only catches abrupt target shifts
    // mid-countdown (fast slide across the goal blend band, a death reshaping
    // the framed group), never the arc itself.
    WORLD_ZOOM_GATE_RATE = 0.8,
    // Sustained camera back-off while holding/throwing an aimed ability (bomb/ice)
    // until it detonates, so it's easier to aim. Multiplies the focused scale
    // (0.62 => ~38% wider); the smoothing eases it out and back.
    AIM_ZOOM_OUT_FACTOR = 0.62,
    // Sustained camera back-off while a LOCAL player's Star Power is live
    // (0.82 => ~22% wider FOV) with a slow breathing wobble on top; the
    // WORLD_ZOOM_TAU smoothing curves it gently in and back out.
    STAR_ZOOM_OUT_FACTOR = 0.82,
    // Warp-pad camera pan: how far to pull the zoom OUT at the midpoint of the journey
    // (a sine bump, 0 at the ends) so you can see the ground between the two pads. 0.35 =>
    // ~35% wider FOV at the middle of the sweep, easing back to tight on the exit.
    WARP_ZOOM_OUT = 0.35,
    maps = [],
    oldNotches = {},
    camera,
    nextMapPreview = null,
    nextMapThumbnail = null,
    // Server-published map-leaderboard data. Three slots, each cleared at
    // round-restart so a stale board doesn't flash:
    //   * mapLeaderboardData       — NEXT map's global top 10 (overview card).
    //   * mapLeaderboardJustPlayed — in-room rank+time on the just-played map
    //                                (drawn inline beside each notch row).
    //   * mapLeaderboardCurrent    — CURRENT (racing) map's global top 10
    //                                (spectator mini-widget during the race).
    mapLeaderboardData = null,
    mapLeaderboardJustPlayed = null,
    mapLeaderboardCurrent = null,
    // Server-authoritative race-start timestamp (ms, Date.now() basis). Set on
    // every startRace; the HUD timer reads it. Null between rounds.
    raceStartedAt = null,
    // Local-player timer freeze. Stamped when the local racer goes !alive
    // (either crosses the goal — uses timeReached — or dies — uses Date.now()).
    // Null = timer is still running. Reset on each startRace.
    localTimerStopAt = null,
    // Whether the timer froze because of a death (true) vs. a goal finish
    // (false). Drives the HUD timer color: red on death, gold on finish.
    localTimerStopByDeath = false,
    // Active per-player NEW PERSONAL / WORLD RECORD floats, anchored to a
    // player id. Pushed on playerPbResult; drained when their animation ends.
    recordFloats = [],
    // Screen-space WORLD-record banner: { displayName, mapName, finishMs,
    // startedAt }. Single slot — a fresh WR replaces the active banner so the
    // most recent wins (rare enough that queueing isn't worth the code).
    worldRecordBanner = null,
    // Server-pushed maintenance notice: { reason: 'drain'|'restart', deadline,
    // expiresAt } (ms timestamps). 'restart' renders a live countdown banner,
    // 'drain' a static "new races paused" notice; null = no banner.
    serverMaintenance = null,
    round = 0,
    timeOutChecker = null,
    currentState = null,
    inLobby = false,
    loading = true,
    previewMode = false,
    gameRunning = null;


var musicControl = $('#musicControl');
var masterControl = $('#masterControl');
var progressContainer = $('#progressContainer');
var progressBar = document.getElementById("progressBar");
var emojiMenu = document.getElementById("emojiMenu");
// Read available space from #gameWindow (the section-filling flex
// container); #mapContainer is sized inside it to match the canvas.
var canvasWindow = document.getElementById("gameWindow");
var mapContainer = document.getElementById("mapContainer");
var exitIconID = document.getElementById("exitIcon");

//Input Vars
var attack = false,
    moveForward = false,
    moveBackward = false,
    turnLeft = false,
    turnRight = false,
    drawChatWheel = false,
    mousex = null,
    mousey = null;

// --- Local multiplayer (Approach A): one Socket.IO connection per local player ---
//
// Each local player ("slot") owns its OWN socket + server identity, and — for pad
// players — its own input state and gamepad mapping. To the server these are just
// N independent players, so no server changes are needed.
//
// Slot 0 is the PRIMARY: it is the page's original connection and the
// keyboard/mouse player, and it alone owns ALL rendering, audio, UI and one-shot/
// timer handling (every socket receives every room broadcast, so running those on
// each socket would fire them N times). The globals `server`, `myID`, `myPlayer`,
// the movement booleans and `menuOpen` are ALIASES for the primary slot, so every
// existing render/input path keeps driving the primary player unchanged. This is
// also why N=1 behaves exactly as before: there is only the primary slot.
//
// Non-primary slots (pad players, slot >= 1) are pure input/identity channels:
// their sockets handle only welcome/gameState(identity)/lifecycle, and their input
// lives in `lp.input` and emits on `lp.socket`.
var LOCAL_PLAYER_CAP = 4;   // ship default; raise toward 8 once hardware + the
                            // server color-palette fix (getUniqueColorR) land.
var RECONNECT_GRACE_MS = 12000; // keep a pad slot alive this long across a
                                // transient disconnect before dropping it.
var localPlayers = [];      // slot index -> local player entry (slot 0 = primary)
var primarySlot = 0;        // index in localPlayers of the render/audio owner
// Set once the keyboard OR mouse drives P1 (a movement key, a click, or
// mouse-move play). While false, the FIRST controller to give input claims the
// primary slot (P1) so the game is playable with controllers only; once kb/m is
// in use it owns P1 and controllers join as P2+.
var kbmClaimedPrimary = false;
// The emoji wheel is a single shared element; this is the slot that currently has
// it open (null = closed). Only that player navigates it (others keep playing),
// and the chosen emoji is emitted on that player's own socket so it's attributed
// to the right player.
var emojiOwnerSlot = null;

// Local multiplayer is always on: there is no URL flag. A solo player is simply
// the primary slot (P1); additional controllers join as their own players when
// they press a button. The hint UI is per-player top blocks (no single bottom
// bar to flip-flop between schemes).

// One local player's state. For the primary slot, `input` is unused (the keyboard
// writes the movement globals instead); for pad slots it is the per-slot input.
function makeLocalPlayer(slot, socket, isPrimary) {
    return {
        slot: slot,
        socket: socket,
        myID: null,
        isPrimary: !!isPrimary,
        joined: false,
        everJoined: false,        // has this slot ever confirmed a room? (drives auto-rejoin)
        // True when THIS slot joined a match already racing: the server parked it as
        // a temp spectator that races from the next round. Per-slot so a co-op seat
        // that joins mid-race gets the spectating banner while P1 keeps racing.
        // Drives drawSpectatorBanner; cleared for every slot at the next startGated.
        lateJoinSpectating: false,
        reconnectTimer: null,     // grace timer started on a transient disconnect
        leaveConfirm: false,      // showing the inline "leave?" confirm in this player's block
        leaveConfirmTimer: null,  // auto-cancel timer for the inline leave confirm
        // Lobby hub stations: nearStation is the zone this slot is currently inside
        // (set by the per-socket stationEnter/stationExit edges); stationPanel is the
        // open panel for this slot ({ id, kind, cursor }) or null. Per-slot so two
        // local players can configure two stations at once. See lobbyHub.js.
        nearStation: null,
        stationPanel: null,
        // pad mapping (null for the keyboard/primary slot)
        padIndex: null,
        padType: "generic",
        // per-slot input (pad slots only)
        input: { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false },
        // per-pad poll edge state (must be per-slot so pads don't clobber each other)
        gp: {
            prevMove: { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false },
            hadMoveInput: false,
            aimActive: false,
            prevAimAngle: null,
            lastAimEmit: 0,
            prevButtons: []
        }
    };
}
function localPlayerForPadIndex(idx) {
    for (var i = 0; i < localPlayers.length; i++) {
        if (localPlayers[i] && localPlayers[i].padIndex === idx) {
            return localPlayers[i];
        }
    }
    return null;
}
function nextFreeSlot() {
    // Any free slot except the current primary's (which always holds a player).
    // Scanning from 0 — rather than hard-coding slot 0 as primary — so a slot
    // freed by a primary failover (where primarySlot is no longer 0) is reusable.
    for (var s = 0; s < LOCAL_PLAYER_CAP; s++) {
        if (s === primarySlot) {
            continue;
        }
        if (!localPlayers[s]) {
            return s;
        }
    }
    return null;
}
function liveLocalPlayerCount() {
    var n = 0;
    for (var i = 0; i < localPlayers.length; i++) {
        if (localPlayers[i]) {
            n++;
        }
    }
    return n;
}

var then = Date.now(),
    dt;

$(function () {
    // Wait for the Supabase session to settle before opening the socket, so a
    // freshly-signed-in token rides the FIRST handshake. The post-OAuth redirect
    // establishes the session asynchronously (a network code-exchange), so
    // connecting immediately would hand the server a tokenless (guest) handshake
    // even though the user just signed in. Cap the wait at 2s so a slow or
    // blocked auth init can never stall the game — we just connect as a guest.
    var auth = window.chaochaoAuth;
    if (auth && auth.ready && typeof auth.ready.then === "function") {
        var connected = false;
        var go = function () {
            if (connected) { return; }
            connected = true;
            server = clientConnect();
        };
        auth.ready.then(go, go);
        // Discord Activity (approach b): auth runs IN-FRAME (SDK handshake + authorize +
        // token exchange), which takes longer than a restored Supabase session — and the
        // socket MUST carry the token, so give it a generous cap. The bootstrap resolves
        // chaochaoAuth.ready (even on failure, as guest) well before this. Plain web keeps
        // the snappy 2s guest fallback. Detect via Discord's frame_id launch param.
        var discordCtx = false;
        try { discordCtx = /[?&]frame_id=/.test(window.location.search) || /[?&]discord=1(?:&|$)/.test(window.location.search); } catch (e) { discordCtx = false; }
        setTimeout(go, discordCtx ? 12000 : 2000);
    } else {
        server = clientConnect();
    }
})

function setupPage() {

    window.addEventListener('blur', cancelAllLocalMovement);
    window.addEventListener('focus', onTabRefocus);
    window.addEventListener('resize', onResizeEvent, false);
    window.requestAnimFrame = (function () {
        return window.requestAnimationFrame ||
            window.webkitRequestAnimationFrame ||
            window.mozRequestAnimationFrame ||
            function (callback) {
                window.setTimeout(callback, 1000 / 30);
            };
    })();

    musicControl.on("click", function (e) {
        if (musicVolume > 0) {
            musicVolume = 0;
            volumeChange();
            $("#musicControl").html('<i class="music-btn fas fa-music"></i>  [<i class="music-btn fa fa-ban" aria-hidden="true"></i>]');
        } else {
            musicVolume = 1;
            volumeChange();
            $("#musicControl").html('<i class="music-btn fas fa-music"></i>  [<i class="music-btn fa fa-volume-up" aria-hidden="true"></i>]');
        }
    });
    masterControl.on("click", function (e) {
        if (masterVolume > 0) {
            masterVolume = 0;
            volumeChange();
            $("#masterControl").html('<i class="music-btn fa fa-gamepad" aria-hidden="true"></i>  [<i class="music-btn fa fa-ban" aria-hidden="true"></i>]');
        } else {
            masterVolume = 1;
            volumeChange();
            $("#masterControl").html('<i class="music-btn fa fa-gamepad" aria-hidden="true"></i>  [<i class="music-btn fa fa-volume-up" aria-hidden="true"></i>]');
        }
    });
    // Keyboard activation for the navbar toggles (role="button" tabindex="0"):
    // Enter/Space fires the click. stopPropagation keeps Space from also
    // reaching the global gameplay keydown (Space = attack) while a toggle has
    // focus.
    function activateToggleOnKey(e) {
        if (e.key === "Enter" || e.key === " " || e.keyCode === 13 || e.keyCode === 32) {
            e.preventDefault();
            e.stopPropagation();
            $(e.currentTarget).click();
        }
    }
    musicControl.on("keydown", activateToggleOnKey);
    masterControl.on("keydown", activateToggleOnKey);
    $("#cameraControl").on("click", function () {
        cameraZoomEnabled = !cameraZoomEnabled;
        updateCameraToggleUI();
    });
    $("#cameraControl").on("keydown", activateToggleOnKey);
    updateCameraToggleUI();
    // Colour-blind assist toggle — persisted so the choice sticks across visits.
    try {
        colorblindEnabled = localStorage.getItem("colorblindPref") === "on";
    } catch (e) {
        colorblindEnabled = false;
    }
    $("#colorblindControl").on("click", function () {
        colorblindEnabled = !colorblindEnabled;
        try { localStorage.setItem("colorblindPref", colorblindEnabled ? "on" : "off"); } catch (e) {}
        updateColorblindToggleUI();
    });
    $("#colorblindControl").on("keydown", activateToggleOnKey);
    updateColorblindToggleUI();
    // Controller rumble toggle — default on, persisted (see haptics.js).
    if (typeof loadHapticsPref === "function") { loadHapticsPref(); }
    $("#hapticsControl").on("click", function () {
        if (typeof setHapticsEnabled === "function") { setHapticsEnabled(!hapticsEnabled); }
        if (typeof updateHapticsToggleUI === "function") { updateHapticsToggleUI(); }
    });
    $("#hapticsControl").on("keydown", activateToggleOnKey);
    if (typeof updateHapticsToggleUI === "function") { updateHapticsToggleUI(); }
    volumeChange();
    gameCanvas = document.getElementById('gameCanvas');
    overlayCanvas = document.getElementById('overlayCanvas');
    gameContext = gameCanvas.getContext('2d');
    overlayContext = overlayCanvas.getContext('2d');
    // Capture the logical drawing size from the initial backing store (the
    // 1366x768 width/height HTML attrs) BEFORE resize() repurposes the backing
    // store for device-pixel rendering.
    LOGICAL_WIDTH = gameCanvas.width;
    LOGICAL_HEIGHT = gameCanvas.height;
    BASE_LOGICAL_WIDTH = gameCanvas.width;
    init();
    // Use .always() (not .then()) so a single 404 / CORS error in the
    // preload list doesn't leave the lobby never being entered. Once
    // every XHR has settled (success or failure), wait on the image
    // decodes too — otherwise loadPatterns() in the gameState handler
    // builds empty CanvasPatterns and the board renders transparent for
    // mid-game joiners. animloop also surfaces a "still loading?" prompt
    // after LOADING_TIMEOUT_MS as a last-resort recovery path.
    $.when.apply($, promises).always(function () {
        tileImagesReady.then(enterLobby);
    });
}

var loadingStartedAt = Date.now();
var LOADING_TIMEOUT_MS = 20000;
var loadingTimeoutShown = false;

function enterLobby() {
    if (inLobby == true) {
        return;
    }
    inLobby = true;
    loading = false;
    progressContainer.hide();
    $('#main').hide();
    $('#gameWindow').css('display', 'flex');
    resize();
    // The loading gate (maps + tile images) has cleared — now kick off the
    // throttled background download of the rest of the audio library. Lobby
    // music was already loaded up front; gameplay music/SFX stream in behind us.
    if (typeof startBackgroundAudioPreload === "function") {
        startBackgroundAudioPreload();
    }
    var playParams = new URLSearchParams(window.location.search);
    // Preview launch: the editor stashed the unsaved map in sessionStorage.
    // Inject it into maps[] BEFORE enterGame so the server's newMap (which
    // carries only the id) resolves via the existing loadNewMap(id) lookup.
    if (playParams.get("preview") === "1") {
        var saved = sessionStorage.getItem('previewMap');
        if (saved != null) {
            try {
                var pMap = reconstructSitesOnlyMap(JSON.parse(saved));
                var alreadyLoaded = false;
                for (var i = 0; i < maps.length; i++) {
                    if (maps[i].id === pMap.id) { alreadyLoaded = true; break; }
                }
                if (!alreadyLoaded) maps.push(pMap);
                previewMode = true;
            } catch (e) {
                debugLog("preview map parse failed", e);
            }
        }
    }
    // Seamless reconnect (Phase 1): if this boot is a reload from a maintenance
    // restart, a stash (written in the disconnect handler before the reload) tells us
    // which room to rejoin and keeps the "Reconnecting…" banner up across the reload
    // (which wiped the canvas + the serverMaintenance global). Honour it only while
    // fresh — its own absolute TTL — and drop a stale one. An explicit ?gameid=/?new=1
    // navigation still wins (a deliberate user action), so this only replaces the
    // default matchmake.
    var reconnectSig = null;
    try {
        var rcRaw = sessionStorage.getItem("reconnecting");
        if (rcRaw != null) {
            var rc = JSON.parse(rcRaw);
            if (rc != null && rc.sig != null && rc.until != null && Date.now() <= rc.until) {
                reconnectSig = rc.sig;
                // Rehydrate the banner immediately, before any socket reply, by reusing the
                // maintenance renderer via a synthetic 'reconnecting' state that self-expires
                // at the same TTL. Cleared in the gameState handler once we're back in.
                serverMaintenance = { reason: "reconnecting", deadline: null, expiresAt: rc.until };
            } else {
                sessionStorage.removeItem("reconnecting");
            }
        }
    } catch (e) { try { sessionStorage.removeItem("reconnecting"); } catch (e2) {} }

    if (playParams.has("gameid")) {
        var paramGameID = playParams.get("gameid");
        clientSendStart(paramGameID);
    } else if (playParams.get("new") === "1") {
        // "Start a new game" (join page): -2 tells the server to always spin up
        // a fresh room instead of matchmaking into an existing one. Strip the
        // param afterwards so a mid-game refresh matchmakes normally instead of
        // stranding the player in yet another empty room.
        clientSendStart(-2);
        try {
            playParams.delete("new");
            var qs = playParams.toString();
            history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
        } catch (e) { /* ignore — cosmetic only */ }
    } else if (reconnectSig != null) {
        // Maintenance-reload reconnect: rejoin the stashed room directly (a literal sig
        // lands back in a started/locked room as a late-join spectator; matchmaking
        // would skip it). The stash is cleared on success in the gameState handler; if
        // the room was reaped, the server's roomNotFound path recovers.
        clientSendStart(reconnectSig);
    } else {
        clientSendStart(-1);
    }

}
function init() {
    if (loading == false) {
        // init() re-runs on every room (re)join (setupPage + each gameState, incl. a
        // Discord in-place re-entry), so clear any prior interval before arming a new one —
        // otherwise each rejoin leaks a second checkForTimeout ticker (it double-counts the
        // idle timer and, in a Discord Activity, can wrongly trip the parent-frame reload).
        if (timeOutChecker) { clearInterval(timeOutChecker); }
        timeOutChecker = setInterval(checkForTimeout, 1000);
    }
    // Schedule (never call animloop() synchronously): a direct call while a rAF
    // callback is already queued would clear animFramePending without consuming
    // that queued callback, forking a second permanent chain — the exact bug the
    // pending flag exists to prevent. init() runs twice (setupPage + gameState).
    scheduleAnimFrame();
    initEventHandlers();
    initGamepad();
}
// animloop is started from TWO places — setupPage()'s init() (loading screen)
// and the gameState handler's init() (gameplay). Both used to schedule their own
// requestAnimFrame chain, and a frame where BOTH gameRunning and loading were true
// scheduled twice — so any client whose gameState arrived before the asset preload
// finished ran 2+ permanent gameLoop chains forever, drawing every frame 2+ times
// (half the FPS for the whole session). Funnel all scheduling through ONE pending
// flag so exactly one rAF chain survives no matter how init() is re-entered.
var animFramePending = false;
function scheduleAnimFrame() {
    if (animFramePending) {
        return;
    }
    animFramePending = true;
    requestAnimFrame(animloop);
}
function animloop() {
    animFramePending = false;
    if (gameRunning) {
        var now = Date.now();
        dt = now - then;
        gameLoop(dt);
        then = now;
        scheduleAnimFrame();
    }
    if (loading == true) {
        var loadedCount = 0;
        for (var i = 0; i < promises.length; i++) {
            // readyState 4 = DONE for any settled XHR (200, 304, 404, etc).
            // Counting only status==200 would stall the bar on 304s and
            // mask CDN cache hits as "still loading".
            if (promises[i].readyState === 4) loadedCount++;
        }
        // Roll the tile/ability Image() decodes into the loading bar so
        // it reflects what we actually wait on before entering the game.
        loadedCount += requiredImagesLoaded;
        var totalToLoad = promises.length + requiredImages.length;
        progressBar.style.width = ((loadedCount / totalToLoad) * 100 + "%");
        if (loadedCount == totalToLoad) {
            enterLobby();
        } else if (!loadingTimeoutShown && Date.now() - loadingStartedAt > LOADING_TIMEOUT_MS) {
            loadingTimeoutShown = true;
            progressContainer.html('Loading is taking longer than usual. <a href="#" onclick="location.reload();return false;">Refresh the page</a> to retry.');
        }
        scheduleAnimFrame();
    }
}
function gameLoop(dt) {
    // performance.now() splits the frame into input / render / rest phases for the
    // perf diagnostics. Four now() calls/frame is negligible; the tick helpers
    // below no-op unless ?fps=1 / ?diag=1 is set, so normal play is unaffected.
    var t0 = performance.now();
    pollGamepad(dt);
    if (typeof updateHaptics === "function") { updateHaptics(dt); }
    var t1 = performance.now();
    drawObjects(dt);
    var t2 = performance.now();
    updateGameboard(dt);
    // Crowd in the letterbox (own canvas; no-op until audience.js is loaded).
    if (typeof drawAudience === "function") { drawAudience(dt); }
    var t3 = performance.now();
    // Diagnostic FPS/frame-time overlay (only when ?fps=1; no-op otherwise).
    if (typeof perfHudTick === "function") { perfHudTick(dt); }
    // Diagnostic perf telemetry to the server (only when ?diag=1; no-op otherwise).
    if (typeof perfDiagTick === "function") { perfDiagTick(dt, t1 - t0, t2 - t1, t3 - t2); }
}


// Mobile browsers fire 'resize' rapidly as the address bar shows/hides on scroll,
// and resize() reallocates two canvas backing stores + rebuilds the camera — doing
// that per event stutters. Coalesce a burst into one resize per animation frame.
// (resize() itself is still called directly for the initial/synchronous layout.)
var _resizePending = false;
function onResizeEvent() {
    if (_resizePending) { return; }
    _resizePending = true;
    var run = function () { _resizePending = false; resize(); };
    if (typeof requestAnimationFrame === "function") { requestAnimationFrame(run); }
    else { setTimeout(run, 16); }
}

function resize() {
    // LOGICAL_WIDTH/HEIGHT are captured in setupPage; if a resize fires before
    // that (early rotation/devtools), bail so we don't divide by 0 -> Infinity.
    if (!LOGICAL_WIDTH || !LOGICAL_HEIGHT) return;
    var gameWindowRect = canvasWindow.getBoundingClientRect();
    if (gameWindowRect.width === 0 || gameWindowRect.height === 0) return;
    var viewport = { width: gameWindowRect.width, height: gameWindowRect.height };
    // The arena is a fixed 16:9 world, so on a wider-than-16:9 frame (a phone in landscape
    // is ~2.2:1) a min() letterbox leaves big side voids. When fillViewport() (Discord
    // Activity OR a touch device), WIDEN the LOGICAL viewport to the frame's aspect so the
    // canvas FILLS — the camera shows a wider slice of the world while racing; whole-map
    // views (lobby/overview) keep the 16:9 arena centred. Never narrower than the 16:9 BASE
    // (so ≤16:9 frames like tablets are untouched) and never wider than 21:9. Outside
    // fillViewport() (desktop/laptop) ALWAYS restore BASE so a context flip can't leave it
    // stuck wide. Accepted tradeoff: touch/Discord see slightly more world than desktop.
    if ((typeof fillViewport === "function" && fillViewport()) && LOGICAL_HEIGHT > 0 && viewport.height > 0) {
        var maxLogicalW = Math.round(LOGICAL_HEIGHT * (21 / 9));
        LOGICAL_WIDTH = Math.min(maxLogicalW, Math.max(BASE_LOGICAL_WIDTH || LOGICAL_HEIGHT * 16 / 9,
            Math.round(LOGICAL_HEIGHT * (viewport.width / viewport.height))));
    } else if (BASE_LOGICAL_WIDTH > 0) {
        LOGICAL_WIDTH = BASE_LOGICAL_WIDTH;
    }
    // Fit the canvas to the available space at its native 16:9 aspect ratio,
    // scaling BOTH axes by the same factor so the game is never stretched. This
    // also covers fullscreen: on any screen that isn't exactly 16:9 the canvas
    // is letterboxed/pillarboxed — the #gameWindow flex container centres it and
    // its --board-bg shows in the bars. (Filling the raw fullscreen viewport
    // would scale X and Y independently and visibly distort the game — circles
    // became ovals on 16:10 / ultrawide / notched displays.)
    var optimalRatio = Math.min(viewport.width / LOGICAL_WIDTH, viewport.height / LOGICAL_HEIGHT);
    newWidth = LOGICAL_WIDTH * optimalRatio;
    newHeight = LOGICAL_HEIGHT * optimalRatio;

    // Logical->CSS scale; used to keep canvas-drawn labels a stable physical
    // size across phone/desktop widths (see drawTouchLabel).
    fitRatio = newWidth / LOGICAL_WIDTH;

    if (mapContainer != null) {
        mapContainer.style.width = newWidth + "px";
        mapContainer.style.height = newHeight + "px";
    }
    // CSS (layout) size: the fitted 16:9 box.
    gameCanvas.style.width = newWidth + "px";
    gameCanvas.style.height = newHeight + "px";
    overlayCanvas.style.width = newWidth + "px";
    overlayCanvas.style.height = newHeight + "px";

    // Backing store: render at device resolution so the game (and its text) is
    // sharp on Retina/phone displays. The dpr ceiling avoids over-rendering on
    // 3x phones; the active performance profile can drop it further on low-end
    // devices (perfDprCap, default 2). The logical 1366x768 space is unchanged;
    // applyCanvasTransform() scales drawing into the backing store each frame, so
    // no gameplay math moves to device pixels.
    var dprCap = (typeof perfDprCap === "function") ? perfDprCap() : 2;
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    var targetW = Math.round(newWidth * dpr);
    var targetH = Math.round(newHeight * dpr);
    // Nothing actually changed (a no-op resize event, e.g. mobile address-bar
    // toggle at a settled size): skip the backing-store realloc + camera rebuild.
    // Assigning canvas.width/height clears the backing store even when identical,
    // so guarding it avoids a needless full repaint + camera reset.
    if (gameCanvas.width === targetW && gameCanvas.height === targetH && camera != null) {
        return;
    }
    gameCanvas.width = targetW;
    gameCanvas.height = targetH;
    overlayCanvas.width = Math.round(newWidth * dpr);
    overlayCanvas.height = Math.round(newHeight * dpr);

    // Per-frame logical->backing-store transform (set here so applyCanvasTransform
    // doesn't have to re-read the backing-store size every frame).
    canvasScaleX = gameCanvas.width / LOGICAL_WIDTH;
    canvasScaleY = gameCanvas.height / LOGICAL_HEIGHT;

    // Re-flow the on-canvas touch controls to the new fit ratio so they keep a
    // constant physical size across resizes / orientation changes (no-op until
    // the controls exist on a touch device).
    if (typeof layoutTouchControls === "function") {
        layoutTouchControls();
    }
    // Keep the DOM settings gear pinned to the canvas's top-right as the letterbox
    // fit changes (orientation / fullscreen / URL-bar collapse). Also re-evaluate its
    // visibility here: in a Discord Activity no fullscreenchange event ever fires, so this
    // is what reveals the gear once the touch canvas is ready (positions before showing).
    if (typeof updateTouchSettingsButtonVisibility === "function") {
        updateTouchSettingsButtonVisibility();
    } else if (typeof positionTouchSettingsButton === "function") {
        positionTouchSettingsButton();
    }

    camera = {
        active: false,
        x: LOGICAL_WIDTH / 2,
        y: LOGICAL_HEIGHT / 2,
        width: LOGICAL_WIDTH,
        height: LOGICAL_HEIGHT,
        target: null,
        color: 'yellow',
        padding: 150,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        xOffset: LOGICAL_WIDTH / 2,
        yOffset: LOGICAL_HEIGHT / 2,

        centerOnObject: function (object) {
            if (!this.active) {
                return;
            }
            if (object == null) {
                return;
            }
            this.target = object;
        },

        draw: function () {
            if (!this.active) {
                return;
            }
            gameContext.save();
            gameContext.beginPath();
            gameContext.strokeStyle = this.color;
            gameContext.lineWidth = 5;
            gameContext.rect(this.padding, this.padding, this.width - this.padding * 2, this.height - this.padding * 2);
            gameContext.stroke();
            gameContext.restore();
        },

        getCameraX() {
            if (!this.active) {
                return 0;
            }
            if (this.target == null) {
                return this.xOffset;
            }
            return -this.target.x + this.xOffset;
        },
        getCameraY() {
            if (!this.active) {
                return 0;
            }
            if (this.target == null) {
                return this.yOffset;
            }
            return -this.target.y + this.yOffset;
        },

        inBounds: function (object) {
            if (!this.active) {
                return true;
            }
            if (object == null || object == undefined || this.target == null || this.target == undefined) {
                return false;
            }
            if (object.radius != null) {
                var dx = Math.abs(object.x - this.target.x);
                var dy = Math.abs(object.y - this.target.y);

                if (dx > (this.xOffset - this.padding + object.radius)) { return false; }
                if (dy > (this.yOffset - this.padding + object.radius)) { return false; }

                if (dx <= (this.xOffset - this.padding)) {
                    return true;
                }
                if (dy <= (this.yOffset - this.padding)) {
                    return true;
                }

                var cornerDsq = Math.pow(dx - (this.xOffset - this.padding), 2) + Math.pow(dy - (this.yOffset - this.padding), 2);

                return (cornerDsq <= Math.pow(object.radius, 2));
            }
            else {
                var leftBound = object.x + object.width >= this.target.x - this.xOffset + this.padding;
                var rightBound = object.x - object.width <= this.target.x - this.xOffset + this.width - this.padding;
                var topBound = object.y + object.width >= this.target.y - this.yOffset + this.padding;
                var bottomBound = object.y - object.width <= this.target.y - this.yOffset + this.height - this.padding;

                if (leftBound && rightBound && topBound && bottomBound) {
                    return true;
                }
                return false;
            }


        },
    }
    // Refit the letterbox crowd canvas to the new window/arena dimensions.
    if (typeof resizeAudience === "function") { resizeAudience(); }
}

// Reflect the dynamic-camera on/off state in the navbar toggle (matches the
// music/master pattern: an icon plus a bracketed status glyph).
function updateCameraToggleUI() {
    var el = document.getElementById("cameraControl");
    if (!el) {
        return;
    }
    var status = cameraZoomEnabled
        ? '[<i class="music-btn fa fa-check" aria-hidden="true"></i>]'
        : '[<i class="music-btn fa fa-ban" aria-hidden="true"></i>]';
    el.innerHTML = '<i class="music-btn fas fa-video" aria-hidden="true"></i> ' + status;
}

// Reflect the colour-blind assist on/off state in the navbar toggle.
function updateColorblindToggleUI() {
    var el = document.getElementById("colorblindControl");
    if (!el) {
        return;
    }
    var status = colorblindEnabled
        ? '[<i class="music-btn fa fa-check" aria-hidden="true"></i>]'
        : '[<i class="music-btn fa fa-ban" aria-hidden="true"></i>]';
    el.innerHTML = '<i class="music-btn fas fa-eye" aria-hidden="true"></i> ' + status;
}

// iOS Safari does NOT implement the Fullscreen API on arbitrary elements (only
// <video>), so requestFullscreen on #gameWindow silently rejects there. Detect
// support so we can hide the dead control and skip a doomed request rather than
// drawing a button that does nothing.
function fullscreenSupported() {
    // Inside a Discord Activity, Discord owns fullscreen (the iframe can't usefully
    // go fullscreen and the request is a no-op/blocked). Report unsupported so the
    // in-game Fullscreen button + its label don't draw and goFullScreen() no-ops —
    // a dead "Fullscreen" affordance just confused players (operator-reported).
    if (typeof isDiscordActivity === "function" && isDiscordActivity()) { return false; }
    return !!(document.fullscreenEnabled &&
        typeof gameWindow !== "undefined" && gameWindow &&
        gameWindow.requestFullscreen);
}

function goFullScreen() {
    if (!fullscreenSupported()) {
        return;
    }
    if (window.document.fullscreenElement) {
        window.document.exitFullscreen().then(function () {
            resize();
        });
    } else {
        gameWindow.requestFullscreen().then(function () {
            resize();
        }).catch(function (e) {
            console.log(e);
        });
    }

}


