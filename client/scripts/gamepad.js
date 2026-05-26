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
var LEAVE_HOLD_MS = 5000;            // hold the Leave button this long to confirm (anti-misfire)
var LEAVE_CONFIRM_TIMEOUT_MS = 8000; // idle auto-cancel of the "Leave?" confirm; kept > LEAVE_HOLD_MS so a hold started late in the window can't race the cancel (and it's paused while actively holding)

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

    // The centre leave modal (used when solo, or when the primary has no inline
    // block) owns the keyboard while open, in any mode: arrows / A-D move between
    // Leave and Cancel, Enter or Space confirms, Esc closes.
    if (leaveModalIsOpen()) {
        if (e.key === "Escape" || e.keyCode === 27) {
            closeLeaveModal();
        } else if (e.keyCode === 37 || e.keyCode === 65 || e.key === "ArrowLeft") {
            setLeaveFocus(0); // Leave
            e.preventDefault();
        } else if (e.keyCode === 39 || e.keyCode === 68 || e.key === "ArrowRight") {
            setLeaveFocus(1); // Cancel
            e.preventDefault();
        } else if (e.keyCode === 13 || e.keyCode === 32 || e.key === "Enter" || e.key === " ") {
            var btns = leaveButtons();
            if (btns[leaveFocusIdx]) {
                btns[leaveFocusIdx].click();
            }
            e.preventDefault();
        }
        return;
    }

    var primary = localPlayers[primarySlot];
    // Multiplayer WITH a visible P1 block: the keyboard player leaves via the same
    // inline "Leave?" confirm in their block that controllers use. (Only when the
    // block actually exists — otherwise fall through to the visible centre modal,
    // so we never arm an invisible confirm.)
    if (hintUiMode === "blocks" && primary && padBlocks[primarySlot]) {
        if (primary.leaveConfirm) {
            if (e.keyCode === 13 || e.key === "Enter") {
                if (primary.leaveConfirmTimer) {
                    clearTimeout(primary.leaveConfirmTimer);
                    primary.leaveConfirmTimer = null;
                }
                primary.leaveConfirm = false;
                dropLocalPlayer(primarySlot);
                e.preventDefault();
            } else if (e.key === "Escape" || e.keyCode === 27) {
                cancelLeaveConfirm(primary);
                e.preventDefault();
            }
            return;
        }
        if (e.key === "Escape" || e.keyCode === 27) {
            openLeaveConfirm(primary);
            e.preventDefault();
            return;
        }
        if (e.key === "h" || e.key === "H" || e.keyCode === 72) {
            toggleHintFade();
        }
        return;
    }

    // Solo, or multiplayer with no visible P1 block: the centre modal (visible).
    if (e.key === "Escape" || e.keyCode === 27) {
        openLeaveModal();
    } else if (e.key === "h" || e.key === "H" || e.keyCode === 72) {
        toggleHintFade(); // hide/show the control hints
    }
}

function onGamepadConnected(e) {
    var type = detectGamepadType(e.gamepad.id);
    debugLog("gamepad connected:", e.gamepad.id, "->", type, "idx", e.gamepad.index);
    // The pad hot-joins as a local player on its first button press (pollGamepad);
    // browsers only reliably surface an idle pad after a press anyway. Prompt for it.
    showJoinToast(type);
}

function onGamepadDisconnected(e) {
    var lp = localPlayerForPadIndex(e.gamepad.index);
    if (!lp) {
        return;
    }
    cancelMovementForSlot(lp);
    lp.gp.hadMoveInput = false;
    if (lp.isPrimary) {
        // The pad driving P1 unplugged — keep the player (keyboard, or a re-pressed
        // pad, can drive it); just release the binding. Its block hints (if in
        // multiplayer) revert to keyboard on the next refresh.
        debugLog("[localmp] P1 pad", e.gamepad.index, "unplugged — releasing binding");
        lp.padIndex = null;
        gamepadConnected = false;
        gamepadIndex = null;
        if (activeInputMethod === "pad") {
            setInputMethod((typeof isTouchScreen !== "undefined" && isTouchScreen) ? "touch" : "kbm");
        }
    } else {
        // A pad player (P2+) unplugged — drop just that slot.
        debugLog("[localmp] pad", e.gamepad.index, "unplugged — dropping slot", lp.slot);
        dropLocalPlayer(lp.slot);
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

// Pad indices that must release all buttons before they can (re)join. Set when a
// player leaves, so the button they held to confirm the leave doesn't instantly
// re-join them — they have to release and press again. A brand-new pad isn't in
// this set, so its very first press still joins immediately.
var padNeedsRelease = {};
function markPadNeedsRelease(idx) {
    if (idx != null) {
        padNeedsRelease[idx] = true;
    }
}
// Per-pad-index "was A pressed last frame" for UNCLAIMED pads, so a controller
// joins on an A-press edge (not a held A).
var unclaimedAPrev = {};

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
    if (primary && primary.padIndex == null && !kbmClaimedPrimary) {
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
    gamepadType = primary.padType; // the (solo) bottom hint bar's attack glyph
    // Solo: the bottom bar will show the pad scheme on first input. In multiplayer
    // P1's block hints refresh to pad glyphs automatically (refreshPadBlocks).
}

// The keyboard/mouse started driving P1. Mark it claimed; and if a controller had
// grabbed P1 first (no kb/m yet), bump that controller to its own player (P2+) and
// give P1 back to kb/m — so "kb/m + controllers" works no matter who moved first.
function claimPrimaryForKbm() {
    if (kbmClaimedPrimary) {
        return;
    }
    kbmClaimedPrimary = true;
    var primary = localPlayers[primarySlot];
    if (!primary || primary.padIndex == null) {
        return; // no controller on P1 — nothing to bump
    }
    var padIdx = primary.padIndex;
    var padType = primary.padType;
    // kb/m takes over P1.
    primary.padIndex = null;
    if (typeof cancelMovementForSlot === "function") {
        cancelMovementForSlot(primary);
    }
    primary.gp.hadMoveInput = false;
    // Re-add the controller as its own player (P2+), if there's room.
    var slot = nextFreeSlot();
    if (slot != null && typeof gameID !== "undefined" && gameID != null && !roomIsFull()) {
        var lp = addLocalPlayer(slot, padIdx);
        if (lp) {
            lp.padType = padType;
            // Seed the new slot's button state from the live pad so a button held
            // during the bump isn't seen as a fresh press (phantom attack/menu).
            var pads = (typeof navigator !== "undefined" && navigator.getGamepads) ? navigator.getGamepads() : [];
            if (pads[padIdx]) {
                lp.gp.prevButtons = snapshotButtons(pads[padIdx]);
            }
        }
    } else {
        // No room to re-home the controller — require a release before it can
        // re-join, so a held button doesn't spam join attempts / room-full toasts.
        markPadNeedsRelease(padIdx);
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
    // Release any bound pad that vanished without a 'gamepaddisconnected' event so
    // the player doesn't keep drifting (a browser quirk the old single-pad path
    // guarded against).
    for (var v = 0; v < localPlayers.length; v++) {
        var lpv = localPlayers[v];
        if (lpv && lpv.padIndex != null && !pads[lpv.padIndex] && lpv.gp.hadMoveInput) {
            cancelMovementForSlot(lpv);
            lpv.gp.hadMoveInput = false;
        }
    }
    // Reconcile the header (player blocks + "press A to join" prompts) and keep
    // the color dots / hints in sync.
    onLocalPlayersChanged();
    refreshPadBlocks();
    // Each connected pad drives its claimed slot; an unclaimed controller shows a
    // "press A to join" prompt and joins on its A button (tryClaimPadSlot decides
    // whether it takes P1 — no kb/m player yet — or joins as P2+).
    for (var i = 0; i < pads.length; i++) {
        var pad = pads[i];
        if (!pad) {
            continue;
        }
        // A controller button is a user gesture too, but gamepad input fires no DOM
        // mouse/key events — so the audio-unlock listeners never see it. Resume blocked
        // music here on any button press (idempotent; only matters for the first one).
        if (typeof unlockAudio === "function" && anyButtonPressed(pad)) {
            unlockAudio();
        }
        var lp = localPlayerForPadIndex(i);
        if (!lp) {
            var aDown = !!(pad.buttons[GP_BTN_A] && pad.buttons[GP_BTN_A].pressed);
            // A pad that just left must go idle before it can (re)join.
            if (padNeedsRelease[i]) {
                if (!anyButtonPressed(pad)) {
                    delete padNeedsRelease[i];
                }
                unclaimedAPrev[i] = aDown;
                continue;
            }
            // Join on the A button (an edge, so a held A doesn't double-join).
            if (aDown && !unclaimedAPrev[i]) {
                tryClaimPadSlot(i, pad);
            }
            unclaimedAPrev[i] = aDown;
            continue; // wait until the slot has joined (myID set) before polling
        }
        delete unclaimedAPrev[i];
        if (lp.myID == null) {
            continue;
        }
        if (lp.socket && lp.socket.connected === false) {
            continue; // mid-reconnect — don't emit into a dropped socket
        }
        pollPadForSlot(pad, lp);
    }
}

// Poll one pad and apply it to its local player `lp`.
// - Emoji wheel: a single shared element owned by one slot at a time; only the
//   owner navigates it, everyone else keeps playing (§6.16).
// - Leave (B): in multiplayer it's an inline "Leave?" confirm in this player's own
//   block (per-slot); when solo it's the existing centre modal.
function pollPadForSlot(pad, lp) {
    var blocks = (hintUiMode === "blocks");
    var wheelOpen = (typeof menuOpen !== "undefined" && menuOpen);
    var iOwnWheel = wheelOpen && emojiOwnerSlot === lp.slot;

    // System/shared actions (hint show/hide) belong to the primary pad only, so
    // multiple players don't fight over the one shared overlay (§6.15).
    if (lp.isPrimary && buttonPressedThisFrame(pad, GP_BTN_SELECT, lp)) {
        toggleHintFade();
    }
    if (lp.isPrimary && padHasInput(pad)) {
        lastPadInputAt = Date.now();
        setInputMethod("pad");
    }

    if (lp.leaveConfirm) {
        // Confirming leave inline: keep steering (movement isn't halted), but A
        // confirms and B cancels, so attack is suppressed while the prompt is up.
        pollAim(pad, lp);
        pollMovementAndAttack(pad, lp, true);
        pollLeaveConfirm(pad, lp);
    } else if (!blocks && lp.isPrimary && leaveModalIsOpen()) {
        // Solo: navigate the centre leave modal.
        pollLeaveModal(pad, lp);
    } else if (iOwnWheel) {
        pollEmojiWheel(pad, lp);
    } else if (!wheelOpen && buttonPressedThisFrame(pad, GP_BTN_B, lp)) {
        if (blocks) {
            openLeaveConfirm(lp);  // inline confirm in this player's block
        } else if (lp.isPrimary) {
            openLeaveModal();      // solo: the centre modal
        }
    } else if (!wheelOpen && buttonPressedThisFrame(pad, GP_BTN_EMOJI, lp)) {
        openEmojiFromPad(lp);
    } else {
        // Normal play (also when another player owns the wheel).
        pollAim(pad, lp);
        pollMovementAndAttack(pad, lp);
        // Fullscreen is a shared-screen action — primary pad only.
        if (lp.isPrimary && buttonPressedThisFrame(pad, GP_BTN_START, lp)) {
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

function pollMovementAndAttack(pad, lp, ignoreAttack) {
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

    // During the leave-confirm A is the confirm button, so attack is suppressed
    // (the player can still steer with the stick/d-pad).
    var atk = ignoreAttack ? false : readAttack(pad);
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

// Any pad player can open the shared emoji wheel; that slot becomes its owner.
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
    openEmojiWindow(w / 2, h / 2); // centred on the viewport; sets menuOpen + default owner
    // This pad owns the wheel; tint its border with this player's color.
    emojiOwnerSlot = lp.slot;
    if (typeof emojiMenu !== "undefined" && emojiMenu && typeof playerList !== "undefined" &&
        playerList && lp.myID != null && playerList[lp.myID]) {
        emojiMenu.style.borderColor = playerList[lp.myID].color;
    }
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
    // Always close the modal first so it can't linger if we fail over instead of
    // navigating away (a primary leave with surviving pad players promotes one).
    closeLeaveModal();
    // Drop the primary slot: with no other local players this disconnects and
    // navigates away as before (N=1); with pad players still in the game it fails
    // over to one of them instead of ending the whole couch session (§6.17).
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
        '<span class="gp-hint"><span class="gp-glyph gp-key">Dbl-click</span>Mouse-drive</span>' +
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
    // With 2+ local players the single bottom bar can't represent everyone's
    // scheme at once, so it's replaced by per-player top blocks — don't show it.
    if (hintUiMode === "blocks") {
        return;
    }
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
// The hint UI is the bottom bar (single-player) and/or the per-player top blocks
// (local MP). Fade/hide apply to whichever exist.
function hintFadeEls() {
    var els = [];
    if (hintBarEl) {
        els.push(hintBarEl);
    }
    if (padPlayersEl) {
        els.push(padPlayersEl);
    }
    return els;
}

function scheduleHintFade() {
    var els = hintFadeEls();
    for (var i = 0; i < els.length; i++) {
        els[i].classList.remove("faded");
    }
    clearTimeout(gpFadeTimer);
    gpFadeTimer = setTimeout(function () {
        var e = hintFadeEls();
        // Keep the top header (padPlayersEl) up permanently while it carries co-op
        // blocks OR an active "press A to join" invitation — each player needs to see
        // which controller they are, and a friend needs the standing join prompt.
        // Only the solo bottom bar auto-fades.
        var pinHeader = (hintUiMode === "blocks") ||
            (Object.keys(joinPromptBlocks).length > 0);
        for (var j = 0; j < e.length; j++) {
            if (e[j] === padPlayersEl && pinHeader) {
                continue;
            }
            e[j].classList.add("faded");
        }
    }, HINT_FADE_MS);
}

// --- per-player hint overlay ---
//
// SOLO (one local player) keeps the single bottom hint bar, which adapts to the
// player's input (keyboard / pad / touch) — the behaviour people are used to.
// As soon as a SECOND local player joins we switch to per-player top blocks:
// each block carries a color dot tinted with that player's server-assigned color
// (the readable "this controller = the red player" link), the slot label, and
// that player's OWN compact hints (their pad's glyphs, or keyboard chips) — so a
// keyboard P1 + pad players don't fight over one bar. Dropping back to one local
// player restores the bottom bar. The blocks inherit the bar's fade/hide.

var padPlayersEl = null;     // container element for the top blocks
var padBlocks = {};          // slot -> { el, dot, hints, lastColor, lastMethod }
var joinPromptBlocks = {};   // pad index -> "press A to join" block element
var padToastEl = null;
var padToastTimer = null;
var hintUiMode = "bar";      // "bar" (solo, no controllers) | "blocks" (header up)

// A "press A to join" block for a connected controller that hasn't joined yet.
function ensureJoinPrompt(idx, type) {
    if (!padPlayersEl) {
        buildPadPlayersUI();
    }
    if (!padPlayersEl || joinPromptBlocks[idx]) {
        return;
    }
    var el = document.createElement("div");
    el.className = "pad-player join-prompt";
    el.innerHTML = '<span class="gp-glyph gp-face">' + attackGlyphFor(type) + '</span>' +
        '<span class="pp-join">press to join</span>';
    padPlayersEl.appendChild(el);
    joinPromptBlocks[idx] = el;
    // A new controller just got an invitation — make sure the header is visible and
    // restart the fade timer (which now pins the header while the prompt is up), in
    // case the bottom bar had already faded before the pad was plugged in.
    scheduleHintFade();
}
function removeJoinPrompt(idx) {
    var el = joinPromptBlocks[idx];
    if (!el) {
        return;
    }
    if (el.parentNode) {
        el.parentNode.removeChild(el);
    }
    delete joinPromptBlocks[idx];
}
function buildPadPlayersUI() {
    if (padPlayersEl || typeof document === "undefined" || !document.body) {
        return;
    }
    var el = document.createElement("div");
    el.id = "padPlayers";
    document.body.appendChild(el);
    padPlayersEl = el;
}

// Pure count -> hint-UI-mode decision (kept tiny + side-effect-free so it can be
// asserted in isolation): two or more ACTIVE local players -> the pinned per-player
// top "blocks"; otherwise the single bottom "bar". The mode is keyed strictly off
// how many local players are actually in the game, NOT how many controllers are
// plugged in.
function hintModeForPlayerCount(n) {
    return n >= 2 ? "blocks" : "bar";
}

// Persist the current local-player order (P1..Pn, primary first) as controller
// identities, so the menus and the map editor can keep the host on the SAME
// physical pad after a page change instead of grabbing whatever the browser
// enumerates first. Change-detected because this runs every frame (via
// onLocalPlayersChanged); only an actual order change touches localStorage. An
// all-keyboard frame (no pad-driven slots) is skipped rather than written, so it
// doesn't wipe a still-valid remembered controller.
var lastPersistedControllerSig = null;
function persistControllerOrder() {
    if (typeof saveControllerOrder !== "function") {
        return; // controllerIdentity.js not present (shouldn't happen in a real page)
    }
    var pads = (typeof navigator !== "undefined" && navigator.getGamepads) ? navigator.getGamepads() : [];
    var slots = [];
    if (typeof primarySlot === "number") {
        slots.push(primarySlot); // P1 first
    }
    for (var s = 0; s < localPlayers.length; s++) {
        if (s !== primarySlot) {
            slots.push(s);
        }
    }
    var order = [];
    for (var k = 0; k < slots.length; k++) {
        var lp = localPlayers[slots[k]];
        if (lp && lp.padIndex != null && pads[lp.padIndex]) {
            order.push({ id: pads[lp.padIndex].id || "", index: lp.padIndex });
        }
    }
    if (order.length === 0) {
        return; // no controller in play — keep the last remembered identity
    }
    var sig = JSON.stringify(order);
    if (sig === lastPersistedControllerSig) {
        return;
    }
    lastPersistedControllerSig = sig;
    saveControllerOrder(order);
}

// Reconciles the in-game header each frame (and on join/drop). Three states:
//   1. Solo, <2 controllers  -> bottom bar (keyboard, or one controller = P1).
//   2. Solo, 2+ controllers  -> bottom bar PLUS a "press A to join" prompt at the
//      top for each unjoined controller (the invitation to start local co-op).
//   3. 2+ joined local players -> per-player glyph blocks (bottom bar hidden), with
//      a join prompt for any still-unjoined controller.
// Bar-vs-blocks is driven by JOINED player count (so a lone controller stays on the
// bottom bar — the Bug-A fix); the join prompts are driven independently by how many
// controllers are CONNECTED, so the invitation shows while you're still solo and the
// view only flips to the co-op glyph blocks once a 2nd player actually presses join.
function onLocalPlayersChanged() {
    var pads = (typeof navigator !== "undefined" && navigator.getGamepads) ? navigator.getGamepads() : [];
    var nLocal = (typeof liveLocalPlayerCount === "function") ? liveLocalPlayerCount() : 1;
    var nControllers = 0;
    for (var i = 0; i < pads.length; i++) {
        if (pads[i]) {
            nControllers++;
        }
    }
    var showBlocks = (hintModeForPlayerCount(nLocal) === "blocks");
    persistControllerOrder(); // keep the cross-page host-controller identity current

    // --- bottom bar vs per-player blocks (driven by JOINED player count) ---
    if (showBlocks) {
        if (hintUiMode !== "blocks") {
            hintUiMode = "blocks";
            if (hintBarEl) {
                hintBarEl.className = "gamepad-prompts hidden"; // bottom bar off when the header is up
            }
            scheduleHintFade();
        }
        // A block per joined local player; drop blocks for slots that are gone.
        for (var s = 0; s < localPlayers.length; s++) {
            var lp = localPlayers[s];
            if (!lp) {
                continue;
            }
            // Don't show a phantom kb/m "P1" block when no one is actually using the
            // keyboard/mouse — so a controller-only player just sees their controller
            // (which becomes P1 when they press A). Once kb/m is used (kbmClaimedPrimary)
            // or a controller binds to P1, the block appears.
            if (lp.isPrimary && lp.padIndex == null && !kbmClaimedPrimary) {
                removeBlock(s);
                continue;
            }
            ensureBlock(lp);
        }
        for (var slot in padBlocks) {
            if (!localPlayers[slot]) {
                removeBlock(slot);
            }
        }
    } else if (hintUiMode === "blocks") {
        // Dropped back below 2 joined players — restore the bottom bar.
        hintUiMode = "bar";
        // Clear any in-progress inline leave-confirm (flag + timer) before their
        // blocks are removed, so nothing lingers with no visible UI.
        for (var c = 0; c < localPlayers.length; c++) {
            if (localPlayers[c]) {
                if (localPlayers[c].leaveConfirmTimer) {
                    clearTimeout(localPlayers[c].leaveConfirmTimer);
                    localPlayers[c].leaveConfirmTimer = null;
                }
                localPlayers[c].leaveConfirm = false;
            }
        }
        removeAllBlocks();
        var method = activeInputMethod || "kbm";
        activeInputMethod = null; // force setInputMethod to rebuild + show the bar
        setInputMethod(method);
    }

    // --- "press A to join" prompts (driven by CONNECTED controller count) ---
    // Show an invitation for every unjoined connected controller whenever 2+ pads
    // are plugged in — independent of bar/blocks mode, so a friend sees how to join
    // while you're still solo on the bottom bar. A single controller is just P1, so
    // it gets no prompt (keeps the solo bottom-bar behaviour).
    if (nControllers >= 2) {
        for (var j = 0; j < pads.length; j++) {
            if (!pads[j] || localPlayerForPadIndex(j)) {
                continue; // empty slot, or this pad has already joined
            }
            ensureJoinPrompt(j, detectGamepadType(pads[j].id));
        }
    }
    // Drop prompts for controllers that joined, vanished, or once we're back under 2.
    for (var key in joinPromptBlocks) {
        var idx = parseInt(key, 10);
        if (nControllers < 2 || !pads[idx] || localPlayerForPadIndex(idx)) {
            removeJoinPrompt(idx);
        }
    }
}

function attackGlyphFor(type) {
    return type === "playstation" ? "✕" : "A";
}

function emojiGlyphFor(type) {
    return type === "playstation" ? "□" : "X";
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

// Create a block for a local player if it doesn't already have one.
function ensureBlock(lp) {
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
    var hints = document.createElement("span");
    hints.className = "pp-hints";

    block.appendChild(dot);
    block.appendChild(label);
    block.appendChild(hints);
    padPlayersEl.appendChild(block);
    padBlocks[lp.slot] = { el: block, dot: dot, hints: hints, lastColor: null, lastMethod: null };
    setBlockHints(lp);

    // A join just happened — drop the connect toast.
    if (padToastEl) {
        padToastEl.classList.remove("visible");
    }
}

// The compact control hints for a player's CURRENT input method (keyboard, touch,
// or their own pad brand) — baked into each top block so every player sees their
// own scheme without the single bottom bar flip-flopping.
function blockMethodFor(lp) {
    if (lp.padIndex != null) {
        return "pad";
    }
    if (typeof isTouchScreen !== "undefined" && isTouchScreen) {
        return "touch";
    }
    return "kbm";
}

function miniHintsFor(method, padType) {
    if (method === "pad") {
        return '<span class="gp-glyph gp-stick">L</span>' +
            '<span class="gp-glyph gp-face">' + attackGlyphFor(padType) + '</span>' +
            '<span class="gp-glyph gp-face">' + emojiGlyphFor(padType) + '</span>' +
            '<span class="gp-glyph gp-face">' + leaveGlyphFor(padType) + '</span>';
    }
    if (method === "touch") {
        return '<span class="gp-glyph gp-key">🕹️</span>' +
            '<span class="gp-glyph gp-key">👆</span>' +
            '<span class="gp-glyph gp-key">💬</span>';
    }
    // keyboard / mouse
    return '<span class="gp-glyph gp-key">WASD</span>' +
        '<span class="gp-glyph gp-key">🖱</span>' +
        '<span class="gp-glyph gp-key">RMB</span>' +
        '<span class="gp-glyph gp-key">Esc</span>';
}

// (Re)set a block's hint glyphs to match the player's current method. No-op when
// unchanged, so a pad binding/unbinding only rewrites the DOM when needed.
function setBlockHints(lp) {
    var b = padBlocks[lp.slot];
    if (!b) {
        return;
    }
    var method = blockMethodFor(lp);
    var key = method + "|" + lp.padType;
    if (key === b.lastMethod) {
        return;
    }
    b.hints.innerHTML = miniHintsFor(method, lp.padType);
    b.lastMethod = key;
}

// Hook (client.js): grey a pad player's block while their socket is reconnecting,
// and restore it on recovery — so a transient blip shows as "reconnecting" rather
// than vanishing.
function onLocalPlayerReconnecting(slot, isReconnecting) {
    // Cancel any in-progress leave-confirm: while mid-reconnect the slot isn't
    // polled, so its A/B can't resolve the confirm — don't leave it frozen.
    if (isReconnecting) {
        cancelLeaveConfirm(localPlayers[slot]);
    }
    var b = padBlocks[slot];
    if (!b || !b.el) {
        return;
    }
    if (isReconnecting) {
        b.el.classList.add("reconnecting");
    } else {
        b.el.classList.remove("reconnecting");
    }
}

function removeBlock(slot) {
    var b = padBlocks[slot];
    if (!b) {
        return;
    }
    if (b.el && b.el.parentNode) {
        b.el.parentNode.removeChild(b.el);
    }
    delete padBlocks[slot];
}

function removeAllBlocks() {
    for (var slot in padBlocks) {
        removeBlock(slot);
    }
}

// Keep each block in sync each frame: tint its dot with the player's current
// server-assigned color (arrives a beat after join) and update its hint glyphs if
// the player's input method changed (e.g. a pad bound to / unbound from P1). Both
// only touch the DOM on an actual change.
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
        if (!lp.leaveConfirm) {
            setBlockHints(lp);
        }
        var p = (lp.myID != null) ? playerList[lp.myID] : null;
        var color = (p && p.color) ? p.color : null;
        if (color && color !== b.lastColor) {
            b.dot.style.backgroundColor = color;
            b.lastColor = color;
        }
    }
}

// --- per-player "leave game" confirm, inline in the block (controllers) ---

function leaveGlyphFor(type) {
    return type === "playstation" ? "○" : "B";
}

// B opens an inline "Leave?" confirm in this player's block; HOLDING B for
// LEAVE_HOLD_MS confirms (drops the player / disconnects), and an attack (A)
// press resumes play. Hold-to-confirm so a mashed attack can't leave by
// accident. Per-slot, so it never freezes the others. Opening the confirm does
// NOT halt movement (the player keeps steering while deciding, matching the
// keyboard Esc behavior). The block is highlighted, and the prompt auto-cancels
// after LEAVE_CONFIRM_TIMEOUT_MS with no hold.
function openLeaveConfirm(lp) {
    lp.leaveConfirm = true;
    // Re-anchor the hold clock so a freshly-opened confirm always starts the 5s
    // hold from zero — never inherits a stale _leaveHoldStart left behind when a
    // prior hold was aborted out-of-band (reconnect, blocks->bar), which would
    // otherwise make the first held frame fire an instant, accidental leave.
    lp._leaveHoldStart = null;
    setBlockLeaveConfirm(lp.slot, true);
    scheduleHintFade(); // un-fade the header so the "Leave?" prompt is readable
    if (lp.leaveConfirmTimer) {
        clearTimeout(lp.leaveConfirmTimer);
    }
    lp.leaveConfirmTimer = setTimeout(function () {
        cancelLeaveConfirm(lp);
    }, LEAVE_CONFIRM_TIMEOUT_MS);
}

// Cancel the inline confirm: clear the timeout, drop the flag, and un-highlight.
function cancelLeaveConfirm(lp) {
    if (!lp) {
        return;
    }
    if (lp.leaveConfirmTimer) {
        clearTimeout(lp.leaveConfirmTimer);
        lp.leaveConfirmTimer = null;
    }
    lp.leaveConfirm = false;
    lp._leaveHoldStart = null; // drop any in-progress hold so it can't carry over
    setBlockLeaveConfirm(lp.slot, false);
}

function pollLeaveConfirm(pad, lp) {
    // Confirm only on a sustained HOLD of the Leave button (B). A tap, or the
    // attack button (A) that players mash mid-fight, never leaves — that
    // accidental "B then A-mash" exit was the whole problem. Releasing B before
    // the hold completes, or pressing attack, cancels and resumes play.
    var bHeld = !!(pad.buttons[GP_BTN_B] && pad.buttons[GP_BTN_B].pressed);
    if (bHeld) {
        if (lp._leaveHoldStart == null) {
            lp._leaveHoldStart = Date.now();
            // Pause the idle auto-cancel while a hold is in progress, so the hold
            // (which can be as long as the idle timeout) never gets cut short.
            if (lp.leaveConfirmTimer) {
                clearTimeout(lp.leaveConfirmTimer);
                lp.leaveConfirmTimer = null;
            }
        }
        var held = Date.now() - lp._leaveHoldStart;
        setBlockLeaveProgress(lp.slot, held / LEAVE_HOLD_MS);
        if (held >= LEAVE_HOLD_MS) {
            if (lp.leaveConfirmTimer) {
                clearTimeout(lp.leaveConfirmTimer);
                lp.leaveConfirmTimer = null;
            }
            lp.leaveConfirm = false;
            lp._leaveHoldStart = null;
            dropLocalPlayer(lp.slot); // confirmed by a deliberate hold
        }
        return;
    }
    // Released before completing: reset progress and re-arm the idle auto-cancel.
    if (lp._leaveHoldStart != null) {
        lp._leaveHoldStart = null;
        if (lp.leaveConfirm && !lp.leaveConfirmTimer) {
            lp.leaveConfirmTimer = setTimeout(function () {
                cancelLeaveConfirm(lp);
            }, LEAVE_CONFIRM_TIMEOUT_MS);
        }
    }
    setBlockLeaveProgress(lp.slot, 0);
    // Not holding Leave: an attack press means "I want to keep playing" — resume.
    if (buttonPressedThisFrame(pad, GP_BTN_A, lp)) {
        cancelLeaveConfirm(lp);
    }
}

function setBlockLeaveConfirm(slot, confirming) {
    var b = padBlocks[slot];
    if (!b) {
        return;
    }
    if (confirming) {
        b.el.classList.add("confirming");
        var lp = localPlayers[slot];
        var confirmHints;
        var prompt;
        if (lp && lp.padIndex != null) {
            // controller: HOLD B to leave; attack (A) resumes. Hold-to-confirm so
            // a mashed attack can no longer leave the game by accident.
            prompt = "Hold to leave";
            confirmHints = '<span class="gp-glyph gp-face">' + leaveGlyphFor(lp.padType) + '</span>';
        } else {
            // keyboard: Enter confirms, Esc cancels
            prompt = "Leave?";
            confirmHints = '<span class="gp-glyph gp-key">Enter</span>' +
                '<span class="gp-glyph gp-key">Esc</span>';
        }
        b.hints.innerHTML = '<span class="pp-confirm">' + prompt + '</span>' + confirmHints;
    } else {
        b.el.classList.remove("confirming");
        b.lastMethod = null; // force a hint rebuild on the next refresh
        if (localPlayers[slot]) {
            setBlockHints(localPlayers[slot]);
        }
    }
}

// Live feedback while holding the Leave button: fills a small text bar in the
// "Hold to leave" prompt so the player sees the hold registering. No new CSS —
// just swaps the prompt label, and only when the bar actually changes.
function setBlockLeaveProgress(slot, progress) {
    var b = padBlocks[slot];
    if (!b || !b.hints) {
        return;
    }
    var span = b.hints.querySelector(".pp-confirm");
    if (!span) {
        return;
    }
    var p = progress < 0 ? 0 : (progress > 1 ? 1 : progress);
    var label;
    if (p <= 0) {
        label = "Hold to leave";
    } else {
        var filled = Math.round(p * 5);
        label = "Leaving " + "█".repeat(filled) + "░".repeat(5 - filled);
    }
    if (span.textContent !== label) {
        span.textContent = label;
    }
}

// Manual toggle (Select button / H key): hide the bar now, or restore it.
function toggleHintFade() {
    var els = hintFadeEls();
    if (els.length === 0) {
        return;
    }
    var anyFaded = false;
    for (var i = 0; i < els.length; i++) {
        if (els[i].classList.contains("faded")) {
            anyFaded = true;
        }
    }
    if (anyFaded) {
        scheduleHintFade(); // restore to full opacity + restart the auto-fade
    } else {
        clearTimeout(gpFadeTimer);
        for (var j = 0; j < els.length; j++) {
            els[j].classList.add("faded"); // hide on demand
        }
    }
}
