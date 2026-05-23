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
var GP_BTN_RT = 7;    // right trigger (analog) -> attack
var GP_BTN_START = 9; // fullscreen

// --- per-frame remembered state (so we only emit on change) ---
var gpPrevMove = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
var gpHadMoveInput = false; // did the pad drive movement on the previous frame?
var gpAimActive = false;    // is the right stick currently aiming?
var gpPrevAimAngle = null;
var gpLastAimEmit = 0;
var gpPrevButtons = [];     // pressed-state per button, for edge detection

// --- prompt overlay ---
var gamepadPromptEl = null;
var gpPromptTimer = null;

function initGamepad() {
    window.addEventListener("gamepadconnected", onGamepadConnected, false);
    window.addEventListener("gamepaddisconnected", onGamepadDisconnected, false);
    buildGamepadPromptUI();
}

function onGamepadConnected(e) {
    gamepadConnected = true;
    gamepadIndex = e.gamepad.index;
    gamepadType = detectGamepadType(e.gamepad.id);
    gpPrevButtons = [];
    showGamepadPrompts(true);
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
    showGamepadPrompts(false);
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
                showGamepadPrompts(true);
            }
            return pads[i];
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
    // Aim first so movement knows whether the right stick owns the facing angle.
    pollAim(pad);
    pollMovementAndAttack(pad);
    pollEdgeButtons(pad);
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
    var lx = pad.axes[0] || 0;
    var ly = pad.axes[1] || 0;
    var mag = Math.sqrt(lx * lx + ly * ly);

    var mf = false, mb = false, tl = false, tr = false;
    var moveActive = mag >= GP_MOVE_DEADZONE;
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

function pollEdgeButtons(pad) {
    if (buttonPressedThisFrame(pad, GP_BTN_START)) {
        goFullScreen();
    }
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

// --- on-screen glyphs / prompts (in-game) ---

function buildGamepadPromptUI() {
    if (gamepadPromptEl || typeof document === "undefined" || !document.body) {
        return;
    }
    var el = document.createElement("div");
    el.id = "gamepadPrompts";
    el.className = "gamepad-prompts hidden";
    document.body.appendChild(el);
    gamepadPromptEl = el;
}

function attackGlyph() {
    return gamepadType === "playstation" ? "✕" : "A"; // PlayStation cross vs Xbox A
}

function showGamepadPrompts(connected) {
    if (!gamepadPromptEl) {
        buildGamepadPromptUI();
    }
    if (!gamepadPromptEl) {
        return;
    }
    if (!connected) {
        gamepadPromptEl.className = "gamepad-prompts hidden";
        return;
    }
    gamepadPromptEl.innerHTML =
        '<span class="gp-toast">🎮 Controller connected</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-stick">L</span>Move</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-stick">R</span>Aim</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-face">' + attackGlyph() + '</span>/<span class="gp-glyph gp-trigger">RT</span>Attack</span>' +
        '<span class="gp-hint"><span class="gp-glyph gp-menu">☰</span>Fullscreen</span>';
    gamepadPromptEl.className = "gamepad-prompts visible";
    // Drop the "connected" toast after a few seconds; keep the control hints.
    clearTimeout(gpPromptTimer);
    gpPromptTimer = setTimeout(function () {
        if (gamepadPromptEl) {
            gamepadPromptEl.className = "gamepad-prompts visible compact";
        }
    }, 4000);
}
