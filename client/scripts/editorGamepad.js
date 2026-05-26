// Controller support for the map editor (create.html). This page does NOT load
// menuGamepad.js — editorGamepad owns the pad here. It's polled each frame from
// create.js's animloop via pollEditorGamepad(), and reuses the editor's own
// state (mousex/mousey, drawPointerCircle, handleClick) so painting goes through
// the exact same paths as the mouse.
//
// Two modes, toggled with RB:
//   panel  - d-pad / left stick move a focus ring over the editor controls; A
//            activates (select a tile/tool/action; a text field opens the
//            on-screen keyboard).
//   canvas - left stick moves the paint cursor; A paints / places / selects
//            (synthesises a left click; hold to keep painting); B or RB goes
//            back to the panel.

var egConnected = false;
var egIndex = null;
var egType = "generic";
var egMode = "panel"; // "panel" | "canvas"
var egPrevButtons = [];
var egFocusEl = null;
var egCursorX = 683; // canvas/world coords (world is 1366 x 768)
var egCursorY = 384;
var egAttackHeld = false;
var egLastStepAt = 0;
var egPromptEl = null;

var EG_DEADZONE = 0.35;
var EG_CURSOR_SPEED = 14; // px/frame at full stick deflection
var EG_DPAD_NUDGE = 3;    // px/frame for fine d-pad cursor moves
var EG_REPEAT_DELAY = 220; // ms between focus steps while a stick is held

var EG_BTN_A = 0;
var EG_BTN_B = 1;
var EG_BTN_RB = 5; // toggle panel <-> canvas
var EG_DPAD_UP = 12;
var EG_DPAD_DOWN = 13;
var EG_DPAD_LEFT = 14;
var EG_DPAD_RIGHT = 15;

// Every actionable control in whichever window is visible. Hidden ones (the
// editor while the load grid is up, and vice versa) are filtered out by
// egItems() via offsetParent, so the same selector serves both screens.
var EG_NAV_SELECTOR = "#controlPanel button:not([disabled]), #controlPanel input, #loadWindow button:not([disabled])";

function initEditorGamepad() {
    window.addEventListener("gamepadconnected", egOnConnect, false);
    window.addEventListener("gamepaddisconnected", egOnDisconnect, false);
    egBuildPrompt();
}

function egOnConnect(e) {
    egConnected = true;
    // Prefer the controller the player was last using (persisted across pages by
    // controllerIdentity.js) so opening the editor doesn't hand control to a
    // different physical pad than the one driving everything else. Fall back to the
    // pad that just connected when there's no remembered match.
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    var want = (typeof preferredPadIndexForSlot === "function") ? preferredPadIndexForSlot(pads, 0) : null;
    egIndex = (want != null && pads[want]) ? want : e.gamepad.index;
    var active = pads[egIndex];
    egType = egDetectType((active && active.id) || e.gamepad.id);
    egPrevButtons = [];
    if (typeof rememberPrimaryController === "function" && active) {
        rememberPrimaryController(active);
    }
    egShowPrompt(true);
}

function egOnDisconnect(e) {
    if (e.gamepad.index !== egIndex) {
        return;
    }
    egConnected = false;
    egIndex = null;
    egReleaseBrush(); // don't leave the editor painting if the pad drops mid-stroke
    egShowPrompt(false);
}

function egDetectType(id) {
    var s = (id || "").toLowerCase();
    if (s.indexOf("playstation") !== -1 || s.indexOf("dualshock") !== -1 ||
        s.indexOf("dualsense") !== -1 || s.indexOf("054c") !== -1) {
        return "playstation";
    }
    return "generic";
}

function egGetPad() {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (egIndex != null && pads[egIndex]) {
        return pads[egIndex];
    }
    // No pad claimed yet (or the claimed one vanished): prefer the remembered host
    // controller, then fall back to the lowest connected index.
    var want = (typeof preferredPadIndexForSlot === "function") ? preferredPadIndexForSlot(pads, 0) : null;
    var pick = (want != null && pads[want]) ? want : -1;
    if (pick === -1) {
        for (var i = 0; i < pads.length; i++) {
            if (pads[i]) { pick = i; break; }
        }
    }
    if (pick !== -1 && pads[pick]) {
        egIndex = pick;
        if (!egConnected) {
            egConnected = true;
            egType = egDetectType(pads[pick].id);
            egShowPrompt(true);
        }
        if (typeof rememberPrimaryController === "function") {
            rememberPrimaryController(pads[pick]);
        }
        return pads[pick];
    }
    return null;
}

function egPressed(pad, idx) {
    var now = pad.buttons[idx] && pad.buttons[idx].pressed;
    var was = egPrevButtons[idx] || false;
    return !!now && !was;
}

function egHeld(pad, idx) {
    return !!(pad.buttons[idx] && pad.buttons[idx].pressed);
}

function egRecord(pad) {
    egPrevButtons = [];
    for (var i = 0; i < pad.buttons.length; i++) {
        egPrevButtons[i] = pad.buttons[i].pressed;
    }
}

// Called every frame from create.js animloop().
function pollEditorGamepad() {
    var pad = egGetPad();
    if (!pad) {
        return;
    }

    if (typeof oskIsOpen === "function" && oskIsOpen()) {
        egHandleOsk(pad);
        egRecord(pad);
        return;
    }

    // B always goes back one screen (editor -> map list -> home), in any mode.
    if (egPressed(pad, EG_BTN_B)) {
        if (egAttackHeld && typeof handleUnClick === "function") {
            handleUnClick({ which: 1 }); // stop an in-progress paint
            egAttackHeld = false;
        }
        egBack();
        egRecord(pad);
        return;
    }

    var inEditor = document.body.classList.contains("editor-open");

    // RB toggles panel <-> canvas, but only once inside the editor.
    if (inEditor && egPressed(pad, EG_BTN_RB)) {
        egSetMode(egMode === "panel" ? "canvas" : "panel");
    }

    if (egMode === "canvas" && inEditor) {
        egPollCanvas(pad);
    } else {
        egPollPanel(pad);
    }

    egRecord(pad);
}

// Back one screen: from the editor to the map list, from the map list home.
function egBack() {
    egMode = "panel";
    if (document.body.classList.contains("editor-open")) {
        var lb = document.getElementById("loadButton");
        if (lb) {
            lb.click();
        }
        egShowPrompt(true);
    } else {
        location.href = "./index.html";
    }
}

// Release an in-progress paint (A held in canvas mode). Must run before we stop
// polling the canvas, or the editor's brushing flag stays true and paints forever.
function egReleaseBrush() {
    if (egAttackHeld) {
        if (typeof handleUnClick === "function") {
            handleUnClick({ which: 1 });
        }
        egAttackHeld = false;
    }
}

function egSetMode(mode) {
    if (mode !== "canvas") {
        egReleaseBrush(); // leaving the canvas — stop any held paint
    }
    egMode = mode;
    if (mode === "canvas") {
        if (egFocusEl) {
            egFocusEl.classList.remove("gp-focus");
        }
        if (typeof setMousePos === "function") {
            setMousePos(egCursorX, egCursorY);
        }
        dirty = true;
    } else {
        var items = egItems();
        if (items.length) {
            egSetFocus(egIndexOf(items) === -1 ? items[0] : egFocusEl);
        }
    }
    egShowPrompt(true);
}

// --- panel (DOM control) navigation ---

function egItems() {
    var all = document.querySelectorAll(EG_NAV_SELECTOR);
    var out = [];
    for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.offsetParent === null && el.getClientRects().length === 0) {
            continue; // hidden (wrong window, or panel collapsed on mobile)
        }
        out.push(el);
    }
    return out;
}

function egIndexOf(items) {
    for (var i = 0; i < items.length; i++) {
        if (items[i] === egFocusEl) {
            return i;
        }
    }
    return -1;
}

function egSetFocus(el) {
    if (egFocusEl && egFocusEl !== el) {
        egFocusEl.classList.remove("gp-focus");
    }
    egFocusEl = el;
    if (el) {
        el.classList.add("gp-focus");
        try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
    }
}

function egCenter(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// 2D spatial move: focus the nearest control in the pressed direction. This is
// what makes "down" go to the row below on the map grid instead of just to the
// next element in DOM order (which reads as "right").
function egMove(dir) {
    var items = egItems();
    if (!items.length) {
        return;
    }
    if (!egFocusEl || egIndexOf(items) === -1) {
        egSetFocus(items[0]);
        return;
    }
    var f = egCenter(egFocusEl);
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < items.length; i++) {
        if (items[i] === egFocusEl) {
            continue;
        }
        var p = egCenter(items[i]);
        var dx = p.x - f.x;
        var dy = p.y - f.y;
        var primary, secondary;
        if (dir === "right") { if (dx <= 2) { continue; } primary = dx; secondary = Math.abs(dy); }
        else if (dir === "left") { if (dx >= -2) { continue; } primary = -dx; secondary = Math.abs(dy); }
        else if (dir === "down") { if (dy <= 2) { continue; } primary = dy; secondary = Math.abs(dx); }
        else if (dir === "up") { if (dy >= -2) { continue; } primary = -dy; secondary = Math.abs(dx); }
        else { continue; }
        var score = primary + secondary * 2;
        if (score < bestScore) {
            bestScore = score;
            best = items[i];
        }
    }
    if (best) {
        egSetFocus(best);
    }
}

function egActivate() {
    var items = egItems();
    if (egIndexOf(items) === -1) {
        egSetFocus(items[0]);
        return;
    }
    if (!egFocusEl) {
        return;
    }
    if (egFocusEl.tagName.toLowerCase() === "input") {
        if (typeof oskOpen === "function") {
            oskOpen(egFocusEl);
        } else {
            egFocusEl.focus();
        }
        return;
    }
    egFocusEl.click();
    // Clicking a map tile / Create-new enters the editor; refresh the prompt so
    // it reflects the new screen (canvas toggle + back target).
    egShowPrompt(true);
}

function egPollPanel(pad) {
    if (egPressed(pad, EG_BTN_A)) {
        egActivate();
    }
    var now = Date.now();
    var ly = pad.axes[1] || 0;
    var lx = pad.axes[0] || 0;
    var dir = null;
    if (egPressed(pad, EG_DPAD_UP)) { dir = "up"; }
    else if (egPressed(pad, EG_DPAD_DOWN)) { dir = "down"; }
    else if (egPressed(pad, EG_DPAD_LEFT)) { dir = "left"; }
    else if (egPressed(pad, EG_DPAD_RIGHT)) { dir = "right"; }
    else if (now - egLastStepAt > EG_REPEAT_DELAY) {
        if (ly < -EG_DEADZONE) { dir = "up"; }
        else if (ly > EG_DEADZONE) { dir = "down"; }
        else if (lx < -EG_DEADZONE) { dir = "left"; }
        else if (lx > EG_DEADZONE) { dir = "right"; }
    }
    if (dir) {
        egMove(dir);
        egLastStepAt = now;
    }
}

// --- canvas (paint cursor) ---

// Remap a stick axis so motion starts at 0 at the deadzone edge and scales to 1
// at full deflection. Without this, stick drift just past the deadzone moves the
// cursor at a constant ~deadzone speed (and paints a streak if A is held).
function egAxis(v) {
    var a = Math.abs(v);
    if (a <= EG_DEADZONE) {
        return 0;
    }
    var scaled = (a - EG_DEADZONE) / (1 - EG_DEADZONE);
    return (v < 0 ? -scaled : scaled);
}

function egPollCanvas(pad) {
    var lx = egAxis(pad.axes[0] || 0);
    var ly = egAxis(pad.axes[1] || 0);
    var moved = false;
    if (lx !== 0) { egCursorX += lx * EG_CURSOR_SPEED; moved = true; }
    if (ly !== 0) { egCursorY += ly * EG_CURSOR_SPEED; moved = true; }
    if (egHeld(pad, EG_DPAD_LEFT)) { egCursorX -= EG_DPAD_NUDGE; moved = true; }
    if (egHeld(pad, EG_DPAD_RIGHT)) { egCursorX += EG_DPAD_NUDGE; moved = true; }
    if (egHeld(pad, EG_DPAD_UP)) { egCursorY -= EG_DPAD_NUDGE; moved = true; }
    if (egHeld(pad, EG_DPAD_DOWN)) { egCursorY += EG_DPAD_NUDGE; moved = true; }

    if (egCursorX < 0) { egCursorX = 0; }
    if (egCursorX > 1366) { egCursorX = 1366; }
    if (egCursorY < 0) { egCursorY = 0; }
    if (egCursorY > 768) { egCursorY = 768; }

    if (moved) {
        if (typeof setMousePos === "function") {
            setMousePos(egCursorX, egCursorY);
        }
        dirty = true;
    }

    // A behaves like a left mouse button: press to paint/place/select, hold to
    // keep painting (the editor's brushing flag does the repeating).
    var aDown = egHeld(pad, EG_BTN_A);
    if (aDown && !egAttackHeld) {
        egAttackHeld = true;
        if (typeof handleClick === "function") {
            handleClick({ which: 1 });
        }
    } else if (!aDown && egAttackHeld) {
        egAttackHeld = false;
        if (typeof handleUnClick === "function") {
            handleUnClick({ which: 1 });
        }
    }
}

function egHandleOsk(pad) {
    if (egPressed(pad, EG_BTN_A)) {
        oskActivateFocused();
    }
    if (egPressed(pad, EG_BTN_B)) {
        oskClose();
        return;
    }
    var now = Date.now();
    if (egPressed(pad, EG_DPAD_UP)) {
        oskMoveFocus("up");
    } else if (egPressed(pad, EG_DPAD_DOWN)) {
        oskMoveFocus("down");
    } else if (egPressed(pad, EG_DPAD_LEFT)) {
        oskMoveFocus("left");
    } else if (egPressed(pad, EG_DPAD_RIGHT)) {
        oskMoveFocus("right");
    } else if (now - egLastStepAt > EG_REPEAT_DELAY) {
        var lx = pad.axes[0] || 0;
        var ly = pad.axes[1] || 0;
        if (ly < -EG_DEADZONE) { oskMoveFocus("up"); egLastStepAt = now; }
        else if (ly > EG_DEADZONE) { oskMoveFocus("down"); egLastStepAt = now; }
        else if (lx < -EG_DEADZONE) { oskMoveFocus("left"); egLastStepAt = now; }
        else if (lx > EG_DEADZONE) { oskMoveFocus("right"); egLastStepAt = now; }
    }
}

// --- prompt overlay (reuses .gamepad-prompts styles) ---

function egBuildPrompt() {
    if (egPromptEl || !document.body) {
        return;
    }
    var el = document.createElement("div");
    el.id = "gamepadPrompts";
    el.className = "gamepad-prompts hidden";
    document.body.appendChild(el);
    egPromptEl = el;
}

function egGlyphA() {
    return egType === "playstation" ? "✕" : "A";
}

function egGlyphB() {
    return egType === "playstation" ? "○" : "B";
}

function egShowPrompt(on) {
    if (!egPromptEl) {
        egBuildPrompt();
    }
    if (!egPromptEl) {
        return;
    }
    if (!on) {
        egPromptEl.className = "gamepad-prompts hidden";
        return;
    }
    var inEditor = document.body.classList.contains("editor-open");
    var backHint = '<span class="gp-hint"><span class="gp-glyph gp-face">' + egGlyphB() + '</span>Back</span>';
    var html = '<span class="gp-toast">🎮 Editor</span>';
    if (inEditor && egMode === "canvas") {
        html += '<span class="gp-hint"><span class="gp-glyph gp-stick">L</span>Cursor</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-face">' + egGlyphA() + '</span>Paint / Place</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-trigger">RB</span>Panel</span>' +
            backHint;
    } else if (inEditor) {
        html += '<span class="gp-hint"><span class="gp-glyph gp-dpad">✛</span>Navigate</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-face">' + egGlyphA() + '</span>Select</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-trigger">RB</span>Canvas</span>' +
            backHint;
    } else {
        // map-selection / load window
        html += '<span class="gp-hint"><span class="gp-glyph gp-dpad">✛</span>Navigate</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-face">' + egGlyphA() + '</span>Select</span>' +
            backHint;
    }
    egPromptEl.innerHTML = html;
    egPromptEl.className = "gamepad-prompts visible";
}
