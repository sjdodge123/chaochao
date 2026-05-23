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

// --- connection state ---
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

// --- per-frame remembered state (so we only emit on change) ---
var gpPrevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
var gpHadMoveInput = false; // did the pad drive movement on the previous frame?
var gpAimActive = false;    // is the right stick currently aiming?
var gpPrevAimAngle = null;
var gpLastAimEmit = 0;
var gpPrevButtons = [];     // pressed-state per button, for edge detection
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
    gamepadConnected = true;
    gamepadIndex = e.gamepad.index;
    gamepadType = detectGamepadType(e.gamepad.id);
    gpPrevButtons = [];
    // Don't swap the glyphs yet — wait until the pad is actually used (see
    // padHasInput in pollGamepad), so a connected-but-idle pad doesn't override
    // a player still on keyboard/mouse.
    debugLog("gamepad connected:", e.gamepad.id, "->", gamepadType);
}

function onGamepadDisconnected(e) {
    if (e.gamepad.index !== gamepadIndex) {
        return;
    }
    gamepadConnected = false;
    gamepadIndex = null;
    // Release anything the pad was holding so the player doesn't keep moving.
    if (gpHadMoveInput) {
        cancelMovement();
        gpHadMoveInput = false;
    }
    gpPrevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
    // The pad is gone — fall back to the device's other input method.
    if (activeInputMethod === "pad") {
        setInputMethod((typeof isTouchScreen !== "undefined" && isTouchScreen) ? "touch" : "kbm");
    }
    debugLog("gamepad disconnected");
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
// page load never fires 'gamepadconnected'. So we also adopt the first live
// pad we see while polling.
function getActiveGamepad() {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (gamepadIndex != null && pads[gamepadIndex]) {
        return pads[gamepadIndex];
    }
    for (var i = 0; i < pads.length; i++) {
        if (pads[i]) {
            gamepadIndex = i;
            if (!gamepadConnected) {
                gamepadConnected = true;
                gamepadType = detectGamepadType(pads[i].id);
            }
            return pads[i];
        }
    }
    // No pad present. If we thought one was connected, it vanished without a
    // 'gamepaddisconnected' event — release any held movement so the player
    // doesn't keep drifting, and fall back to keyboard/touch hints.
    if (gamepadConnected) {
        gamepadConnected = false;
        gamepadIndex = null;
        if (gpHadMoveInput && typeof cancelMovement === "function") {
            cancelMovement();
            gpHadMoveInput = false;
        }
        if (activeInputMethod === "pad") {
            setInputMethod((typeof isTouchScreen !== "undefined" && isTouchScreen) ? "touch" : "kbm");
        }
    }
    return null;
}

// Called once per frame from gameLoop().
function pollGamepad(dt) {
    var pad = getActiveGamepad();
    if (!pad) {
        return;
    }

    // Using the pad swaps the glyphs to the controller scheme.
    if (padHasInput(pad)) {
        lastPadInputAt = Date.now();
        setInputMethod("pad");
    }

    // Select toggles the hint bar between hidden (transparent) and shown.
    if (buttonPressedThisFrame(pad, GP_BTN_SELECT)) {
        toggleHintFade();
    }

    if (leaveModalIsOpen()) {
        // The confirm modal owns input while it's up.
        pollLeaveModal(pad);
    } else if (typeof menuOpen !== "undefined" && menuOpen) {
        // The emoji wheel owns input while it's up.
        pollEmojiWheel(pad);
    } else if (buttonPressedThisFrame(pad, GP_BTN_B)) {
        openLeaveModal();
    } else if (buttonPressedThisFrame(pad, GP_BTN_EMOJI)) {
        openEmojiFromPad();
    } else {
        // Aim first so movement knows whether the right stick owns the facing.
        pollAim(pad);
        pollMovementAndAttack(pad);
        if (buttonPressedThisFrame(pad, GP_BTN_START)) {
            goFullScreen();
        }
    }

    rememberButtons(pad);
}

function pollAim(pad) {
    var rx = pad.axes[2] || 0;
    var ry = pad.axes[3] || 0;
    var mag = Math.sqrt(rx * rx + ry * ry);
    gpAimActive = mag >= GP_AIM_DEADZONE;
    if (!gpAimActive) {
        return;
    }
    if (typeof playerList === "undefined" || !playerList || myID == null || !playerList[myID]) {
        return;
    }

    // Same angle convention as utils.angle(): 0=right, 90=down, 180=left, 270=up.
    var deg = Math.atan2(ry, rx) * 180 / Math.PI;
    if (deg < 0) {
        deg += 360;
    }

    // Throttle: skip tiny changes and cap the emit rate so we don't flood the socket.
    if (gpPrevAimAngle != null) {
        var delta = Math.abs(deg - gpPrevAimAngle);
        if (delta > 180) {
            delta = 360 - delta;
        }
        if (delta < GP_AIM_MIN_DELTA) {
            return;
        }
    }
    var now = Date.now();
    if (now - gpLastAimEmit < GP_AIM_MIN_INTERVAL) {
        return;
    }

    playerList[myID].angle = deg;
    if (server) {
        server.emit('mousemove', deg);
    }
    gpPrevAimAngle = deg;
    gpLastAimEmit = now;
}

function pollMovementAndAttack(pad) {
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
    applyInputState(mf, mb, tl, tr, atk, moveActive);
}

function readAttack(pad) {
    var a = pad.buttons[GP_BTN_A] && pad.buttons[GP_BTN_A].pressed;
    var rt = pad.buttons[GP_BTN_RT] && pad.buttons[GP_BTN_RT].value > GP_TRIGGER_THRESHOLD;
    return !!(a || rt);
}

function applyInputState(mf, mb, tl, tr, atk, moveActive) {
    // Only let the pad drive when it is actually providing input, or when it is
    // releasing input it held last frame. This keeps keyboard/mouse usable while
    // the pad sits idle.
    var padDriving = moveActive || atk || gpHadMoveInput;
    if (padDriving) {
        var changed = (mf !== gpPrevMove.moveForward) ||
            (mb !== gpPrevMove.moveBackward) ||
            (tl !== gpPrevMove.turnLeft) ||
            (tr !== gpPrevMove.turnRight) ||
            (atk !== gpPrevMove.attack);

        if (changed) {
            moveForward = mf;
            moveBackward = mb;
            turnLeft = tl;
            turnRight = tr;
            attack = atk;
            // When the right stick isn't aiming, face the movement direction
            // (mirrors the keyboard behaviour).
            if (!gpAimActive && typeof playerList !== "undefined" && playerList && myID != null && playerList[myID]) {
                calcAngleFromKeys(playerList[myID]);
                if (server) {
                    server.emit('mousemove', playerList[myID].angle);
                }
            }
            emitMovement();
            gpPrevMove = { moveForward: mf, moveBackward: mb, turnLeft: tl, turnRight: tr, attack: atk };
        }
    }
    gpHadMoveInput = moveActive || atk;
}

function emitMovement() {
    if (server) {
        server.emit('movement', {
            turnLeft: turnLeft,
            moveForward: moveForward,
            turnRight: turnRight,
            moveBackward: moveBackward,
            attack: attack
        });
    }
}

function rememberButtons(pad) {
    gpPrevButtons = [];
    for (var i = 0; i < pad.buttons.length; i++) {
        gpPrevButtons[i] = pad.buttons[i].pressed;
    }
}

function buttonPressedThisFrame(pad, idx) {
    var now = pad.buttons[idx] && pad.buttons[idx].pressed;
    var was = gpPrevButtons[idx] || false;
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

function openEmojiFromPad() {
    // Stop driving the player while the wheel is up.
    if (gpHadMoveInput) {
        cancelMovement();
        gpHadMoveInput = false;
    }
    gpPrevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
    gpEmojiIndex = 0;
    var w = window.innerWidth || 800;
    var h = window.innerHeight || 600;
    openEmojiWindow(w / 2 - 50, h / 2 - 50);
}

function pollEmojiWheel(pad) {
    var items = emojiItems();
    if (items.length === 0) {
        return;
    }
    if (gpEmojiIndex < 0 || gpEmojiIndex >= items.length) {
        gpEmojiIndex = 0;
    }

    // Confirm sends the highlighted emoji; B / X cancels.
    if (buttonPressedThisFrame(pad, GP_BTN_A)) {
        var chosen = items[gpEmojiIndex].innerHTML;
        clearEmojiHighlight(items);
        closeEmojiWindow(chosen);
        return;
    }
    if (buttonPressedThisFrame(pad, GP_BTN_B) || buttonPressedThisFrame(pad, GP_BTN_EMOJI)) {
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
    if (buttonPressedThisFrame(pad, GP_DPAD_RIGHT) || buttonPressedThisFrame(pad, GP_DPAD_DOWN)) {
        gpEmojiIndex = (gpEmojiIndex + 1) % items.length;
        gpEmojiStepAt = now;
    } else if (buttonPressedThisFrame(pad, GP_DPAD_LEFT) || buttonPressedThisFrame(pad, GP_DPAD_UP)) {
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
    gpHadMoveInput = false;
    gpPrevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
    leaveModalEl.className = "confirm-modal visible";
    setLeaveFocus(1); // default to Cancel
}

function closeLeaveModal() {
    if (leaveModalEl) {
        leaveModalEl.className = "confirm-modal hidden";
    }
}

function doLeaveGame() {
    // Navigating away drops the socket; the server kicks us from the room.
    window.location.href = "./index.html";
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

function pollLeaveModal(pad) {
    if (buttonPressedThisFrame(pad, GP_BTN_B)) {
        closeLeaveModal();
        return;
    }
    if (buttonPressedThisFrame(pad, GP_BTN_A)) {
        var btns = leaveButtons();
        if (btns[leaveFocusIdx]) {
            btns[leaveFocusIdx].click();
        }
        return;
    }
    if (buttonPressedThisFrame(pad, GP_DPAD_LEFT)) {
        setLeaveFocus(0);
    } else if (buttonPressedThisFrame(pad, GP_DPAD_RIGHT)) {
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
