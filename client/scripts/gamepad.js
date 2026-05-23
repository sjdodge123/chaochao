"use strict";

// Gamepad (controller) support for in-game play.
//
// Polled once per frame from gameLoop(). A standard-mapping controller is
// mapped onto the same movement/aim/attack channels already used by the
// keyboard/mouse/touch paths, so the server needs no changes:
//   - left stick  -> the existing 4 movement booleans, quantized to 8-way
//   - right stick -> the facing/aim angle (twin-stick), sent via 'mousemove'
//   - A / right trigger -> attack (which also fires the held ability)
//   - Start -> fullscreen
//
// The rest of the game is event-driven and only emits on input change, so the
// poll loop here is careful to do the same: it diffs against the pad's own
// previous reading and only touches the socket when something actually changed.

// --- connection state (the PRIMARY slot's pad, single-player path) ---
var gamepadConnected = false;
var gamepadIndex = null;
var gamepadType = "generic"; // "xbox" | "playstation" | "generic"

// --- tuning ---
var GP_MOVE_DEADZONE = 0.30;     // left stick: ignore drift below this
var GP_AIM_DEADZONE = 0.35;      // right stick: only re-aim when pushed past this
var GP_TRIGGER_THRESHOLD = 0.5;  // analog trigger counts as "pressed" past this
var GP_AIM_MIN_DELTA = 2;        // deg; skip aim emits smaller than this
var GP_AIM_MIN_INTERVAL = 50;    // ms; cap aim emits at ~20 Hz

// --- standard-mapping button indices ---
var GP_BTN_A = 0;     // attack / confirm
var GP_BTN_B = 1;     // cancel (emoji wheel)
var GP_BTN_EMOJI = 2; // X / Square -> open emoji wheel
var GP_BTN_RT = 7;    // right trigger (analog) -> attack
var GP_BTN_SELECT = 8; // Select/Back/View -> restore faded hint bar
var GP_BTN_START = 9; // fullscreen
var GP_DPAD_UP = 12;
var GP_DPAD_DOWN = 13;
var GP_DPAD_LEFT = 14;
var GP_DPAD_RIGHT = 15;

// --- per-frame remembered state ---
// The per-pad edge/aim/move state that used to be single globals now lives in
// each local player's `lp.gp` (game.js makeLocalPlayer), so multiple pads don't
// clobber each other. These two remain global because the emoji wheel is a
// single shared DOM element owned by the PRIMARY slot only (§6.16 MVP).
var gpEmojiIndex = 0;       // highlighted slot while the emoji wheel is open
var gpEmojiStepAt = 0;      // last d-pad step time (for repeat throttling)

// --- prompt overlay ---
var hintBarEl = null;          // single hint bar; its glyphs swap per active input
var activeInputMethod = null;  // "kbm" | "pad" | "touch" — whichever was used last
var lastTouchAt = 0;           // to ignore the synthetic mouse events a tap emits
var lastPadInputAt = 0;        // to ignore stray mouse motion during active pad play
var gpPromptTimer = null;      // drops the toast a few seconds after a scheme change
var gpFadeTimer = null;        // dims the hint bar after a period of no scheme change
var HINT_FADE_MS = 60000;      // ~60s on screen, then fade to mostly transparent

// --- leave-game confirmation modal ---
var leaveModalEl = null;
var leaveFocusIdx = 1;   // 0 = Leave, 1 = Cancel (default to the safe choice)
var gpLeaveStepAt = 0;

function initGamepad() {
    window.addEventListener("gamepadconnected", onGamepadConnected, false);
    window.addEventListener("gamepaddisconnected", onGamepadDisconnected, false);
    // Esc opens (and closes) the leave-game modal for keyboard players.
    window.addEventListener("keydown", onGamepadKeyDown, false);
    // Detect which input method is actually in use and swap the glyphs to match.
    // mousedown is deliberate (switch); mousemove is noisy (guarded so a stray
    // bump during controller play doesn't flip the glyphs).
    window.addEventListener("mousedown", markKbmUsed, false);
    window.addEventListener("mousemove", markKbmMoved, false);
    window.addEventListener("touchstart", markTouchUsed, false);
    buildHintBar();
    buildLeaveModalUI();
    buildPadPlayersUI();
    // Start on the device's most likely method; live usage swaps it.
    setInputMethod((typeof isTouchScreen !== "undefined" && isTouchScreen) ? "touch" : "kbm");
}

function markKbmUsed() {
    // Touchscreens emit synthetic mouse events shortly after a tap; ignore those
    // so a tap doesn't immediately flip touch -> keyboard/mouse. Real mouse use
    // on a hybrid device isn't preceded by a touch, so it still registers.
    if (Date.now() - lastTouchAt < 700) {
        return;
    }
    setInputMethod("kbm");
}

function markKbmMoved() {
    // Same touch guard, plus: ignore mouse motion while the pad is actively in
    // use, so a nudged mouse / trackpad twitch doesn't flicker the glyphs.
    if (Date.now() - lastTouchAt < 700 || Date.now() - lastPadInputAt < 1000) {
        return;
    }
    setInputMethod("kbm");
}

function markTouchUsed() {
    lastTouchAt = Date.now();
    setInputMethod("touch");
}

function onGamepadKeyDown(e) {
    setInputMethod("kbm"); // a key press means keyboard/mouse is in use
    if (e.key === "Escape" || e.keyCode === 27) {
        if (leaveModalIsOpen()) {
            closeLeaveModal();
        } else {
            openLeaveModal();
        }
    } else if (e.key === "h" || e.key === "H" || e.keyCode === 72) {
        toggleHintFade(); // hide/show the control hints
    }
}

function onGamepadConnected(e) {
    var type = detectGamepadType(e.gamepad.id);
    debugLog("gamepad connected:", e.gamepad.id, "->", type, "idx", e.gamepad.index);
    if (!localMultiplayerEnabled()) {
        // Single-player: adopt this pad onto the primary slot (today's behavior).
        gamepadConnected = true;
        gamepadIndex = e.gamepad.index;
        gamepadType = type;
        var p = localPlayers[primarySlot];
        if (p) {
            p.padIndex = e.gamepad.index;
            p.padType = type;
            p.gp.prevButtons = [];
        }
        // Don't swap the glyphs yet — wait until the pad is actually used, so a
        // connected-but-idle pad doesn't override a player still on keyboard.
        return;
    }
    // Local multiplayer: the pad hot-joins as a NEW local player on its first
    // button press (pollGamepad). Browsers only reliably surface an idle pad
    // after a press anyway, so we wait for that rather than joining on connect.
    debugLog("[localmp] controller detected — press a button to join");
    showJoinToast(type);
}

function onGamepadDisconnected(e) {
    if (!localMultiplayerEnabled()) {
        var p = localPlayers[primarySlot];
        if (!p || e.gamepad.index !== p.padIndex) {
            return;
        }
        gamepadConnected = false;
        gamepadIndex = null;
        p.padIndex = null;
        if (p.gp.hadMoveInput) {
            cancelMovement();
            p.gp.hadMoveInput = false;
        }
        p.gp.prevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
        if (activeInputMethod === "pad") {
            setInputMethod((typeof isTouchScreen !== "undefined" && isTouchScreen) ? "touch" : "kbm");
        }
        debugLog("gamepad disconnected");
        return;
    }
    // Local multiplayer: a pad's controller was unplugged.
    var lp = localPlayerForPadIndex(e.gamepad.index);
    if (lp && !lp.isPrimary) {
        // A pad player (P2+) unplugged — stop and drop just that slot.
        debugLog("[localmp] pad", e.gamepad.index, "unplugged — dropping slot", lp.slot);
        cancelMovementForSlot(lp);
        dropLocalPlayer(lp.slot);
    } else if (lp && lp.isPrimary) {
        // The pad driving P1 (pad-only) unplugged — keep the primary player alive
        // (keyboard, or a re-pressed pad, can drive it) but release the binding
        // and clear its block.
        debugLog("[localmp] P1 pad", e.gamepad.index, "unplugged — releasing binding");
        cancelMovementForSlot(lp);
        lp.padIndex = null;
        lp.gp.hadMoveInput = false;
        gamepadConnected = false;
        gamepadIndex = null;
        if (activeInputMethod === "pad") {
            setInputMethod((typeof isTouchScreen !== "undefined" && isTouchScreen) ? "touch" : "kbm");
        }
        if (typeof onLocalPlayerDropped === "function") {
            onLocalPlayerDropped(lp.slot);
        }
    }
}

function detectGamepadType(id) {
    var s = (id || "").toLowerCase();
    if (s.indexOf("xbox") !== -1 || s.indexOf("xinput") !== -1) {
        return "xbox";
    }
    if (s.indexOf("playstation") !== -1 || s.indexOf("dualshock") !== -1 ||
        s.indexOf("dualsense") !== -1 || s.indexOf("054c") !== -1) {
        return "playstation";
    }
    return "generic";
}

// Chrome only surfaces a pad after the first button press, and a pad held at
// page load never fires 'gamepadconnected'. So in single-player we adopt the
// first live pad onto the primary slot while polling.
function adoptFirstPadToPrimary(pads) {
    var p = localPlayers[primarySlot];
    if (!p) {
        return null;
    }
    if (p.padIndex != null && pads[p.padIndex]) {
        return pads[p.padIndex];
    }
    for (var i = 0; i < pads.length; i++) {
        if (pads[i]) {
            p.padIndex = i;
            p.padType = detectGamepadType(pads[i].id);
            gamepadConnected = true;
            gamepadIndex = i;
            gamepadType = p.padType;
            return pads[i];
        }
    }
    // No pad present. If we thought one was connected, it vanished without a
    // 'gamepaddisconnected' event — release any held movement so the player
    // doesn't keep drifting, and fall back to keyboard/touch hints.
    if (p.padIndex != null) {
        p.padIndex = null;
        gamepadConnected = false;
        gamepadIndex = null;
        if (p.gp.hadMoveInput && typeof cancelMovement === "function") {
            cancelMovement();
            p.gp.hadMoveInput = false;
        }
        if (activeInputMethod === "pad") {
            setInputMethod((typeof isTouchScreen !== "undefined" && isTouchScreen) ? "touch" : "kbm");
        }
    }
    return null;
}

function anyButtonPressed(pad) {
    for (var i = 0; i < pad.buttons.length; i++) {
        if (pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > GP_TRIGGER_THRESHOLD)) {
            return true;
        }
    }
    return false;
}

function snapshotButtons(pad) {
    var out = [];
    for (var i = 0; i < pad.buttons.length; i++) {
        out[i] = pad.buttons[i].pressed;
    }
    return out;
}

// Browsers pause rAF/gamepad polling while the tab is hidden and may zero gamepad
// state across a focus change. On refocus, re-baseline each pad's button
// edge-state from the live reading so a button held across the focus change isn't
// seen as a fresh press (no phantom attacks/menu-opens, §6.18). Set on `focus`,
// consumed on the next poll.
var padEdgeResetPending = false;
function onTabRefocus() {
    padEdgeResetPending = true;
}
function rebaselinePadEdges(pads) {
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (lp && lp.padIndex != null && pads[lp.padIndex]) {
            lp.gp.prevButtons = snapshotButtons(pads[lp.padIndex]);
            lp.gp.prevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
            lp.gp.hadMoveInput = false;
        }
    }
}

// An unclaimed pad pressed a button — claim a slot for it.
function tryClaimPadSlot(padIndex, pad) {
    var primary = localPlayers[primarySlot];
    // Pad-only P1: if no keyboard is being used to play and the primary slot has
    // no pad yet, the FIRST controller drives P1 (the existing primary
    // connection) so no keyboard is required. This reuses the existing player, so
    // there's no new join and no capacity check.
    if (primary && primary.padIndex == null && !keyboardClaimedPrimary) {
        bindPadToPrimary(padIndex, pad);
        return;
    }
    // Otherwise the pad becomes a new local player (P2+). Joining by gameId
    // bypasses the server's hasSpace()/isLocked() checks (§5.4), so guard here.
    var slot = nextFreeSlot();
    if (slot == null) {
        showPadToast("All " + LOCAL_PLAYER_CAP + " local player slots are full", 3000);
        return;
    }
    if (typeof gameID === "undefined" || gameID == null) {
        return; // primary hasn't confirmed a room yet
    }
    if (roomIsFull()) {
        showPadToast("Room is full — can't add another player", 3000);
        return;
    }
    var lp = addLocalPlayer(slot, padIndex);
    if (lp) {
        lp.gp.prevButtons = snapshotButtons(pad); // don't let the join press = attack
        if (joinWouldSpectate()) {
            showPadToast("P" + (slot + 1) + " joining — spectator until next round", 3500);
        }
    }
}

// Bind a pad to the existing primary slot (pad-only P1). Drives the primary
// player via the same path the single-player pad uses.
function bindPadToPrimary(padIndex, pad) {
    var primary = localPlayers[primarySlot];
    if (!primary) {
        return;
    }
    primary.padIndex = padIndex;
    primary.padType = detectGamepadType(pad.id);
    primary.gp.prevButtons = snapshotButtons(pad);
    gamepadType = primary.padType; // the bottom hint bar's attack glyph
    if (typeof onLocalPlayerJoined === "function") {
        onLocalPlayerJoined(primary); // give P1 a color-dot block too
    }
}

// True when the room already holds its max players. Counts the live playerList
// plus any local players that have joined but whose playerJoin hasn't reflected
// on the primary yet, so two quick joins can't both slip past.
function roomIsFull() {
    if (typeof config === "undefined" || !config || !config.maxPlayersInRoom) {
        return false;
    }
    if (typeof playerList === "undefined" || !playerList) {
        return false;
    }
    var count = Object.keys(playerList).length;
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (lp && lp.myID != null && !playerList[lp.myID]) {
            count++;
        }
    }
    return count >= config.maxPlayersInRoom;
}

// True if a join right now would land mid-race (server makes them a spectator
// until the next round, §6.15).
function joinWouldSpectate() {
    return typeof config !== "undefined" && config && typeof currentState !== "undefined" &&
        (currentState === config.stateMap.racing || currentState === config.stateMap.collapsing);
}

// Called once per frame from gameLoop().
function pollGamepad(dt) {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (padEdgeResetPending) {
        // First poll after refocus: establish a clean edge baseline and skip
        // edge-triggered actions for this frame (movement resumes next frame).
        rebaselinePadEdges(pads);
        padEdgeResetPending = false;
        return;
    }
    if (!localMultiplayerEnabled()) {
        // Single-player: one pad drives the primary slot, exactly as before.
        var pad = adoptFirstPadToPrimary(pads);
        if (pad) {
            pollPadForSlot(pad, localPlayers[primarySlot]);
        }
        return;
    }
    // Keep each pad player's color dot in sync with their server-assigned color.
    refreshPadBlocks();
    // Local multiplayer: keyboard owns the primary slot; each connected pad drives
    // its own claimed slot, and an unclaimed pad hot-joins as a new local player
    // on its first button press.
    for (var i = 0; i < pads.length; i++) {
        var pad = pads[i];
        if (!pad) {
            continue;
        }
        var lp = localPlayerForPadIndex(i);
        if (!lp) {
            if (anyButtonPressed(pad)) {
                tryClaimPadSlot(i, pad);
            }
            continue; // wait until the slot has joined (myID set) before polling
        }
        if (lp.myID == null) {
            continue;
        }
        pollPadForSlot(pad, lp);
    }
}

// Poll one pad and apply it to its local player `lp`. The primary slot also owns
// the emoji wheel / leave modal / hint bar; non-primary pads do movement only, so
// the primary opening a modal never freezes pad players (§6.16).
function pollPadForSlot(pad, lp) {
    if (lp.isPrimary) {
        // Using the pad swaps the glyphs to the controller scheme.
        if (padHasInput(pad)) {
            lastPadInputAt = Date.now();
            setInputMethod("pad");
        }
        // Select toggles the hint bar between hidden (transparent) and shown.
        if (buttonPressedThisFrame(pad, GP_BTN_SELECT, lp)) {
            toggleHintFade();
        }
        if (leaveModalIsOpen()) {
            pollLeaveModal(pad, lp);
        } else if (typeof menuOpen !== "undefined" && menuOpen) {
            pollEmojiWheel(pad, lp);
        } else if (buttonPressedThisFrame(pad, GP_BTN_B, lp)) {
            openLeaveModal();
        } else if (buttonPressedThisFrame(pad, GP_BTN_EMOJI, lp)) {
            openEmojiFromPad(lp);
        } else {
            pollAim(pad, lp);
            pollMovementAndAttack(pad, lp);
            if (buttonPressedThisFrame(pad, GP_BTN_START, lp)) {
                goFullScreen();
            }
        }
    } else {
        pollAim(pad, lp);
        pollMovementAndAttack(pad, lp);
        if (buttonPressedThisFrame(pad, GP_BTN_START, lp)) {
            goFullScreen();
        }
    }
    rememberButtons(pad, lp);
}

function pollAim(pad, lp) {
    var gp = lp.gp;
    var rx = pad.axes[2] || 0;
    var ry = pad.axes[3] || 0;
    var mag = Math.sqrt(rx * rx + ry * ry);
    gp.aimActive = mag >= GP_AIM_DEADZONE;
    if (!gp.aimActive) {
        return;
    }
    if (typeof playerList === "undefined" || !playerList || lp.myID == null || !playerList[lp.myID]) {
        return;
    }

    // Same angle convention as utils.angle(): 0=right, 90=down, 180=left, 270=up.
    var deg = Math.atan2(ry, rx) * 180 / Math.PI;
    if (deg < 0) {
        deg += 360;
    }

    // Throttle: skip tiny changes and cap the emit rate so we don't flood the socket.
    if (gp.prevAimAngle != null) {
        var delta = Math.abs(deg - gp.prevAimAngle);
        if (delta > 180) {
            delta = 360 - delta;
        }
        if (delta < GP_AIM_MIN_DELTA) {
            return;
        }
    }
    var now = Date.now();
    if (now - gp.lastAimEmit < GP_AIM_MIN_INTERVAL) {
        return;
    }

    playerList[lp.myID].angle = deg;
    if (lp.socket) {
        lp.socket.emit('mousemove', deg);
    }
    gp.prevAimAngle = deg;
    gp.lastAimEmit = now;
}

function pollMovementAndAttack(pad, lp) {
    var mf = false, mb = false, tl = false, tr = false;
    var moveActive = false;

    // The d-pad maps straight onto the 4 movement booleans (and their diagonals),
    // so it gives exact 8-way control with no deadzone. It takes priority over the
    // left stick when held.
    var dUp = pad.buttons[GP_DPAD_UP] && pad.buttons[GP_DPAD_UP].pressed;
    var dDown = pad.buttons[GP_DPAD_DOWN] && pad.buttons[GP_DPAD_DOWN].pressed;
    var dLeft = pad.buttons[GP_DPAD_LEFT] && pad.buttons[GP_DPAD_LEFT].pressed;
    var dRight = pad.buttons[GP_DPAD_RIGHT] && pad.buttons[GP_DPAD_RIGHT].pressed;

    if (dUp || dDown || dLeft || dRight) {
        mf = !!dUp;
        mb = !!dDown;
        tl = !!dLeft;
        tr = !!dRight;
        moveActive = true;
    } else {
        var lx = pad.axes[0] || 0;
        var ly = pad.axes[1] || 0;
        var mag = Math.sqrt(lx * lx + ly * ly);
        moveActive = mag >= GP_MOVE_DEADZONE;
        if (moveActive) {
            // Quantize the stick into 8 octants (45 deg each) to match the engine's
            // 8-way movement. Screen coords: -y is up/forward, +y is down/backward.
            var deg = Math.atan2(ly, lx) * 180 / Math.PI; // 0=right, 90=down
            if (deg < 0) {
                deg += 360;
            }
            switch (Math.round(deg / 45) % 8) {
                case 0: tr = true; break;             // E
                case 1: tr = true; mb = true; break;  // SE
                case 2: mb = true; break;             // S
                case 3: tl = true; mb = true; break;  // SW
                case 4: tl = true; break;             // W
                case 5: tl = true; mf = true; break;  // NW
                case 6: mf = true; break;             // N
                case 7: tr = true; mf = true; break;  // NE
            }
        }
    }

    var atk = readAttack(pad);
    applyInputState(lp, mf, mb, tl, tr, atk, moveActive);
}

function readAttack(pad) {
    var a = pad.buttons[GP_BTN_A] && pad.buttons[GP_BTN_A].pressed;
    var rt = pad.buttons[GP_BTN_RT] && pad.buttons[GP_BTN_RT].value > GP_TRIGGER_THRESHOLD;
    return !!(a || rt);
}

function applyInputState(lp, mf, mb, tl, tr, atk, moveActive) {
    var gp = lp.gp;
    // Only let the pad drive when it is actually providing input, or when it is
    // releasing input it held last frame. This keeps keyboard/mouse usable while
    // the (primary) pad sits idle.
    var padDriving = moveActive || atk || gp.hadMoveInput;
    if (padDriving) {
        var prev = gp.prevMove;
        var changed = (mf !== prev.moveForward) ||
            (mb !== prev.moveBackward) ||
            (tl !== prev.turnLeft) ||
            (tr !== prev.turnRight) ||
            (atk !== prev.attack);

        if (changed) {
            // Primary slot writes the movement globals (shared with keyboard);
            // pad slots write their own per-slot input.
            if (lp.isPrimary) {
                moveForward = mf;
                moveBackward = mb;
                turnLeft = tl;
                turnRight = tr;
                attack = atk;
            } else {
                lp.input.moveForward = mf;
                lp.input.moveBackward = mb;
                lp.input.turnLeft = tl;
                lp.input.turnRight = tr;
                lp.input.attack = atk;
            }
            // When the right stick isn't aiming, face the movement direction
            // (mirrors the keyboard behaviour), per this slot's own input.
            if (!gp.aimActive && typeof playerList !== "undefined" && playerList && lp.myID != null && playerList[lp.myID]) {
                var ang = calcAngleFromInput(mf, mb, tl, tr, playerList[lp.myID].angle);
                playerList[lp.myID].angle = ang;
                if (lp.socket) {
                    lp.socket.emit('mousemove', ang);
                }
            }
            emitMovement(lp);
            gp.prevMove = { moveForward: mf, moveBackward: mb, turnLeft: tl, turnRight: tr, attack: atk };
        }
    }
    gp.hadMoveInput = moveActive || atk;
}

function emitMovement(lp) {
    if (!lp.socket) {
        return;
    }
    var inp = lp.isPrimary
        ? { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack }
        : { turnLeft: lp.input.turnLeft, moveForward: lp.input.moveForward, turnRight: lp.input.turnRight, moveBackward: lp.input.moveBackward, attack: lp.input.attack };
    lp.socket.emit('movement', inp);
}

function rememberButtons(pad, lp) {
    var buttons = [];
    for (var i = 0; i < pad.buttons.length; i++) {
        buttons[i] = pad.buttons[i].pressed;
    }
    lp.gp.prevButtons = buttons;
}

function buttonPressedThisFrame(pad, idx, lp) {
    var now = pad.buttons[idx] && pad.buttons[idx].pressed;
    var was = (lp.gp.prevButtons[idx]) || false;
    return !!now && !was;
}

// --- in-game lobby: emoji wheel navigation ---

function emojiItems() {
    // #emojiMenu's first <a> is the static close button (onclick=...'cancel');
    // setupEmojiWheel appends the real emoji anchors after it. Exclude the close
    // button from navigation — it's reached with B, never selected — so index 0
    // is a real emoji and A can't broadcast the close-icon markup as an emoji.
    var all = document.querySelectorAll("#emojiMenu a");
    var out = [];
    for (var i = 0; i < all.length; i++) {
        var onclick = all[i].getAttribute("onclick") || "";
        if (onclick.indexOf("cancel") !== -1) {
            continue;
        }
        out.push(all[i]);
    }
    return out;
}

// Index of the emoji whose on-screen direction from the wheel centre best
// matches the stick — aligns with the actual (scattered) CSS layout.
function nearestEmojiToDir(items, lx, ly) {
    var menu = document.getElementById("emojiMenu");
    if (!menu) {
        return gpEmojiIndex;
    }
    var mr = menu.getBoundingClientRect();
    var mcx = mr.left + mr.width / 2;
    var mcy = mr.top + mr.height / 2;
    var stickAng = Math.atan2(ly, lx);
    var best = gpEmojiIndex;
    var bestDiff = Infinity;
    for (var i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        var ia = Math.atan2((r.top + r.height / 2) - mcy, (r.left + r.width / 2) - mcx);
        var d = Math.abs(ia - stickAng);
        if (d > Math.PI) {
            d = 2 * Math.PI - d;
        }
        if (d < bestDiff) {
            bestDiff = d;
            best = i;
        }
    }
    return best;
}

// The emoji wheel is owned by the PRIMARY slot only (§6.16 MVP), so `lp` here is
// always the primary; passing it keeps the per-pad edge state consistent.
function openEmojiFromPad(lp) {
    // Stop driving the player while the wheel is up.
    if (lp.gp.hadMoveInput) {
        cancelMovementForSlot(lp);
        lp.gp.hadMoveInput = false;
    }
    lp.gp.prevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
    gpEmojiIndex = 0;
    var w = window.innerWidth || 800;
    var h = window.innerHeight || 600;
    openEmojiWindow(w / 2 - 50, h / 2 - 50);
}

function pollEmojiWheel(pad, lp) {
    var items = emojiItems();
    if (items.length === 0) {
        return;
    }
    if (gpEmojiIndex < 0 || gpEmojiIndex >= items.length) {
        gpEmojiIndex = 0;
    }

    // Confirm sends the highlighted emoji; B / X cancels.
    if (buttonPressedThisFrame(pad, GP_BTN_A, lp)) {
        var chosen = items[gpEmojiIndex].innerHTML;
        clearEmojiHighlight(items);
        closeEmojiWindow(chosen);
        return;
    }
    if (buttonPressedThisFrame(pad, GP_BTN_B, lp) || buttonPressedThisFrame(pad, GP_BTN_EMOJI, lp)) {
        clearEmojiHighlight(items);
        closeEmojiWindow("cancel");
        return;
    }

    // Left stick points directly at the emoji in that direction; the d-pad
    // nudges one slot at a time.
    var lx = pad.axes[0] || 0;
    var ly = pad.axes[1] || 0;
    if (Math.sqrt(lx * lx + ly * ly) > 0.5) {
        gpEmojiIndex = nearestEmojiToDir(items, lx, ly);
    }
    var now = Date.now();
    if (buttonPressedThisFrame(pad, GP_DPAD_RIGHT, lp) || buttonPressedThisFrame(pad, GP_DPAD_DOWN, lp)) {
        gpEmojiIndex = (gpEmojiIndex + 1) % items.length;
        gpEmojiStepAt = now;
    } else if (buttonPressedThisFrame(pad, GP_DPAD_LEFT, lp) || buttonPressedThisFrame(pad, GP_DPAD_UP, lp)) {
        gpEmojiIndex = (gpEmojiIndex - 1 + items.length) % items.length;
        gpEmojiStepAt = now;
    }

    highlightEmoji(items, gpEmojiIndex);
}

function highlightEmoji(items, idx) {
    for (var i = 0; i < items.length; i++) {
        if (i === idx) {
            items[i].classList.add("gp-emoji-focus");
        } else {
            items[i].classList.remove("gp-emoji-focus");
        }
    }
}

function clearEmojiHighlight(items) {
    for (var i = 0; i < items.length; i++) {
        items[i].classList.remove("gp-emoji-focus");
    }
}

// --- leave-game confirmation modal ---

function buildLeaveModalUI() {
    if (leaveModalEl || typeof document === "undefined" || !document.body) {
        return;
    }
    var el = document.createElement("div");
    el.id = "leaveModal";
    el.className = "confirm-modal hidden";
    el.innerHTML =
        '<div class="confirm-dialog">' +
        '<div class="confirm-title">Leave the game?</div>' +
        '<div class="confirm-buttons">' +
        '<button type="button" class="confirm-btn confirm-leave">Leave</button>' +
        '<button type="button" class="confirm-btn confirm-cancel">Cancel</button>' +
        '</div></div>';
    document.body.appendChild(el);
    leaveModalEl = el;
    // Mouse users can click either button directly.
    el.querySelector(".confirm-leave").addEventListener("click", doLeaveGame);
    el.querySelector(".confirm-cancel").addEventListener("click", closeLeaveModal);
}

function leaveModalIsOpen() {
    return !!leaveModalEl && leaveModalEl.classList.contains("visible");
}

function openLeaveModal() {
    if (!leaveModalEl) {
        buildLeaveModalUI();
    }
    if (!leaveModalEl) {
        return;
    }
    // Stop the player while they decide — for both pad and keyboard. (keyDown in
    // input.js also bails while the modal is open, so WASD can't restart it.)
    if (typeof cancelMovement === "function") {
        cancelMovement();
    }
    var primary = localPlayers[primarySlot];
    if (primary) {
        primary.gp.hadMoveInput = false;
        primary.gp.prevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
    }
    leaveModalEl.className = "confirm-modal visible";
    setLeaveFocus(1); // default to Cancel
}

function closeLeaveModal() {
    if (leaveModalEl) {
        leaveModalEl.className = "confirm-modal hidden";
    }
}

function doLeaveGame() {
    // The leave modal is owned by the primary slot. Drop just that slot: with no
    // other local players this disconnects and navigates away as before (N=1);
    // with pad players still in the game it fails over to one of them instead of
    // ending the whole couch session (§6.17).
    if (typeof dropLocalPlayer === "function") {
        dropLocalPlayer(primarySlot);
    } else {
        window.location.href = "./index.html";
    }
}

function leaveButtons() {
    if (!leaveModalEl) {
        return [];
    }
    return [leaveModalEl.querySelector(".confirm-leave"), leaveModalEl.querySelector(".confirm-cancel")];
}

function setLeaveFocus(idx) {
    var btns = leaveButtons();
    leaveFocusIdx = idx;
    for (var i = 0; i < btns.length; i++) {
        if (!btns[i]) {
            continue;
        }
        if (i === idx) {
            btns[i].classList.add("gp-focus");
            try { btns[i].focus(); } catch (e) { /* ignore */ }
        } else {
            btns[i].classList.remove("gp-focus");
        }
    }
}

function pollLeaveModal(pad, lp) {
    if (buttonPressedThisFrame(pad, GP_BTN_B, lp)) {
        closeLeaveModal();
        return;
    }
    if (buttonPressedThisFrame(pad, GP_BTN_A, lp)) {
        var btns = leaveButtons();
        if (btns[leaveFocusIdx]) {
            btns[leaveFocusIdx].click();
        }
        return;
    }
    if (buttonPressedThisFrame(pad, GP_DPAD_LEFT, lp)) {
        setLeaveFocus(0);
    } else if (buttonPressedThisFrame(pad, GP_DPAD_RIGHT, lp)) {
        setLeaveFocus(1);
    } else {
        var lx = pad.axes[0] || 0;
        var now = Date.now();
        if (Math.abs(lx) > 0.5 && now - gpLeaveStepAt > 250) {
            setLeaveFocus(lx < 0 ? 0 : 1);
            gpLeaveStepAt = now;
        }
    }
}

// --- input-method hint bar (one bar; glyphs swap to the active input) ---

function buildHintBar() {
    if (hintBarEl || typeof document === "undefined" || !document.body) {
        return;
    }
    var el = document.createElement("div");
    el.id = "inputHints";
    el.className = "gamepad-prompts hidden";
    document.body.appendChild(el);
    hintBarEl = el;
}

function attackGlyph() {
    return gamepadType === "playstation" ? "✕" : "A"; // PlayStation cross vs Xbox A
}

function emojiGlyph() {
    return gamepadType === "playstation" ? "□" : "X"; // PlayStation square vs Xbox X
}

function leaveGlyph() {
    return gamepadType === "playstation" ? "○" : "B"; // PlayStation circle vs Xbox B
}

function hintsForMethod(method) {
    if (method === "pad") {
        return '<span class="gp-toast">🎮 Controller</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-stick">L</span><span class="gp-glyph gp-dpad">✛</span>Move</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-stick">R</span>Aim</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-face">' + attackGlyph() + '</span>/<span class="gp-glyph gp-trigger">RT</span>Attack</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-face">' + emojiGlyph() + '</span>Emoji</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-face">' + leaveGlyph() + '</span>Leave</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-menu">☰</span>Fullscreen</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-menu">⧉</span>Hide</span>';
    }
    if (method === "touch") {
        return '<span class="gp-toast">📱 Touch</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-key">🕹️</span>Move</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-key">👆</span>Attack</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-key">💬</span>Emoji</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-key">⛶</span>Fullscreen</span>';
    }
    // keyboard / mouse
    return '<span class="gp-hint"><span class="gp-glyph gp-key">W</span><span class="gp-glyph gp-key">A</span><span class="gp-glyph gp-key">S</span><span class="gp-glyph gp-key">D</span>Move</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-key">🖱</span>Aim</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-key">Click</span>/<span class="gp-glyph gp-key">Space</span>Attack</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-key">Right-click</span>Emoji</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-key">Esc</span>Leave</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-key">H</span>Hide</span>';
}

// Swap the hint bar to the given input method ("kbm" | "pad" | "touch"). No-op
// when unchanged, so continuing to use the same input doesn't keep resetting the
// fade — only an actual scheme change (or Select) brings the bar back.
function setInputMethod(method) {
    if (method === activeInputMethod) {
        return;
    }
    activeInputMethod = method;
    if (!hintBarEl) {
        buildHintBar();
    }
    if (!hintBarEl) {
        return;
    }
    hintBarEl.innerHTML = hintsForMethod(method);
    hintBarEl.className = "gamepad-prompts visible";
    // Drop the toast (pad/touch) after a few seconds, keep the control hints.
    clearTimeout(gpPromptTimer);
    if (method === "pad" || method === "touch") {
        gpPromptTimer = setTimeout(function () {
            if (hintBarEl) {
                hintBarEl.classList.add("compact");
            }
        }, 4000);
    }
    scheduleHintFade();
}

// True if the pad is actively in use this frame (a button down or a stick past
// its deadzone) — used to swap the glyphs to the controller on real usage.
function padHasInput(pad) {
    var lx = pad.axes[0] || 0, ly = pad.axes[1] || 0;
    if (Math.sqrt(lx * lx + ly * ly) > GP_MOVE_DEADZONE) {
        return true;
    }
    var rx = pad.axes[2] || 0, ry = pad.axes[3] || 0;
    if (Math.sqrt(rx * rx + ry * ry) > GP_AIM_DEADZONE) {
        return true;
    }
    for (var i = 0; i < pad.buttons.length; i++) {
        if (pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > GP_TRIGGER_THRESHOLD)) {
            return true;
        }
    }
    return false;
}

// Show the hint bar at full opacity and (re)start the ~60s countdown to fade.
function scheduleHintFade() {
    if (!hintBarEl) {
        return;
    }
    hintBarEl.classList.remove("faded");
    clearTimeout(gpFadeTimer);
    gpFadeTimer = setTimeout(function () {
        if (hintBarEl && hintBarEl.classList.contains("visible")) {
            hintBarEl.classList.add("faded");
        }
    }, HINT_FADE_MS);
}

// --- per-pad player overlay (local multiplayer, §5.3) ---
//
// One compact block per pad player, each carrying a color dot tinted with that
// player's server-assigned color — the readable link "this controller = the red
// player" — plus the player's slot label and that pad's own attack glyph (A on
// Xbox, ✕ on PlayStation, so mixed-brand pads show their real button). Built
// lazily; populated by the onLocalPlayerJoined/Dropped hooks (client.js) and kept
// in color-sync by refreshPadBlocks() each frame (the color arrives a beat after
// join via playerJoin/gameUpdates). The keyboard/primary player keeps the bottom
// hint bar; these blocks are for the pad players only.

var padPlayersEl = null;     // container element
var padBlocks = {};          // slot -> { el, dot, lastColor }
var padToastEl = null;
var padToastTimer = null;

function buildPadPlayersUI() {
    if (padPlayersEl || typeof document === "undefined" || !document.body) {
        return;
    }
    var el = document.createElement("div");
    el.id = "padPlayers";
    document.body.appendChild(el);
    padPlayersEl = el;
}

function attackGlyphFor(type) {
    return type === "playstation" ? "✕" : "A";
}

// Brief transient toast at the top of the screen (controller join prompts,
// room-full / spectator notices).
function showPadToast(html, ms) {
    if (typeof document === "undefined" || !document.body) {
        return;
    }
    if (!padToastEl) {
        padToastEl = document.createElement("div");
        padToastEl.id = "padToast";
        document.body.appendChild(padToastEl);
    }
    padToastEl.innerHTML = html;
    padToastEl.classList.add("visible");
    clearTimeout(padToastTimer);
    padToastTimer = setTimeout(function () {
        if (padToastEl) {
            padToastEl.classList.remove("visible");
        }
    }, ms || 4000);
}

// "Controller detected — press A to join" toast when a pad connects.
function showJoinToast(type) {
    showPadToast('🎮 Controller detected — press ' +
        '<span class="gp-glyph gp-face">' + attackGlyphFor(type) + '</span> to join', 4000);
}

// Hook (client.js addLocalPlayer): a pad player joined — create its block.
function onLocalPlayerJoined(lp) {
    if (!padPlayersEl) {
        buildPadPlayersUI();
    }
    if (!padPlayersEl || padBlocks[lp.slot]) {
        return;
    }
    var block = document.createElement("div");
    block.className = "pad-player";
    block.id = "padPlayer-" + lp.slot;

    var dot = document.createElement("span");
    dot.className = "gp-color-dot";
    var label = document.createElement("span");
    label.className = "pp-label";
    label.textContent = "P" + (lp.slot + 1);
    var move = document.createElement("span");
    move.className = "gp-glyph gp-stick";
    move.textContent = "L";
    var atk = document.createElement("span");
    atk.className = "gp-glyph gp-face";
    atk.textContent = attackGlyphFor(lp.padType);

    block.appendChild(dot);
    block.appendChild(label);
    block.appendChild(move);
    block.appendChild(atk);
    padPlayersEl.appendChild(block);
    padBlocks[lp.slot] = { el: block, dot: dot, lastColor: null };

    // A join just happened — drop the connect toast.
    if (padToastEl) {
        padToastEl.classList.remove("visible");
    }
}

// Hook (client.js dropLocalPlayer): a pad player left — remove its block.
function onLocalPlayerDropped(slot) {
    var b = padBlocks[slot];
    if (!b) {
        return;
    }
    if (b.el && b.el.parentNode) {
        b.el.parentNode.removeChild(b.el);
    }
    delete padBlocks[slot];
}

// Tint each pad player's dot with their current server-assigned color (which only
// arrives a moment after join). Cheap; only writes the DOM when the color changes.
function refreshPadBlocks() {
    if (typeof playerList === "undefined" || !playerList) {
        return;
    }
    for (var slot in padBlocks) {
        var lp = localPlayers[slot];
        var b = padBlocks[slot];
        if (!lp || !b) {
            continue;
        }
        var p = (lp.myID != null) ? playerList[lp.myID] : null;
        var color = (p && p.color) ? p.color : null;
        if (color && color !== b.lastColor) {
            b.dot.style.backgroundColor = color;
            b.lastColor = color;
        }
    }
}

// Manual toggle (Select button / H key): hide the bar now, or restore it.
function toggleHintFade() {
    if (!hintBarEl) {
        return;
    }
    if (hintBarEl.classList.contains("faded")) {
        scheduleHintFade(); // restore to full opacity + restart the auto-fade
    } else {
        clearTimeout(gpFadeTimer);
        hintBarEl.classList.add("faded"); // hide on demand
    }
}
