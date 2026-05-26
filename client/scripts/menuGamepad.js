// Gamepad navigation for the DOM menu pages (landing + join).
//
// These pages have no game loop, so this module runs its own requestAnimationFrame
// poll. It collects the actionable elements on the page, lets the d-pad / left
// stick move a focus ring between them, and maps A -> activate, B -> back.
// Wrapped in an IIFE so it can be safely concatenated into the join bundle
// alongside join.js without leaking globals.
(function () {
    "use strict";

    // Actionable elements, in document order. Covers the landing buttons, the
    // join page's refresh / join-by-id / start-new controls, and the dynamically
    // rendered room "Join" buttons (a.join-btn is also a.btn).
    var NAV_SELECTOR = "a.btn, button.btn, input.form-control";

    var MOVE_DEADZONE = 0.5;   // stick must be pushed clearly to step focus
    var REPEAT_DELAY = 250;    // ms between focus steps while a direction is held

    // Standard-mapping indices
    var BTN_A = 0;        // activate
    var BTN_B = 1;        // back
    var DPAD_UP = 12;
    var DPAD_DOWN = 13;
    var DPAD_LEFT = 14;
    var DPAD_RIGHT = 15;

    var connected = false;
    var padIndex = null;
    var padType = "generic";
    var focusEl = null;        // the element we consider focused
    var prevButtons = [];
    var lastStepAt = 0;
    var rafId = null;
    var promptEl = null;

    function init() {
        window.addEventListener("gamepadconnected", onConnected, false);
        window.addEventListener("gamepaddisconnected", onDisconnected, false);
        buildPrompt();
        // Always poll: a pad held at load never fires 'connected' until a button
        // press, and Chrome only exposes pads while polling anyway.
        loop();
    }

    function onConnected(e) {
        connected = true;
        // Prefer the controller the player was last using (persisted across pages by
        // controllerIdentity.js) over whichever pad merely fired 'connected' first, so
        // the menu cursor stays on the host's pad instead of jumping to another one.
        // Fall back to the pad that just connected when there's no remembered match.
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        var want = (typeof preferredPadIndexForSlot === "function") ? preferredPadIndexForSlot(pads, 0) : null;
        padIndex = (want != null && pads[want]) ? want : e.gamepad.index;
        var active = pads[padIndex];
        padType = detectType((active && active.id) || e.gamepad.id);
        prevButtons = [];
        if (typeof rememberPrimaryController === "function" && active) {
            rememberPrimaryController(active);
        }
        showPrompt(true);
    }

    function onDisconnected(e) {
        if (e.gamepad.index !== padIndex) {
            return;
        }
        connected = false;
        padIndex = null;
        showPrompt(false);
    }

    function detectType(id) {
        var s = (id || "").toLowerCase();
        if (s.indexOf("playstation") !== -1 || s.indexOf("dualshock") !== -1 ||
            s.indexOf("dualsense") !== -1 || s.indexOf("054c") !== -1) {
            return "playstation";
        }
        return "generic";
    }

    function getPad() {
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        if (padIndex != null && pads[padIndex]) {
            return pads[padIndex];
        }
        // No pad claimed yet (or the claimed one vanished): prefer the remembered
        // host controller, then fall back to the lowest connected index.
        var want = (typeof preferredPadIndexForSlot === "function") ? preferredPadIndexForSlot(pads, 0) : null;
        var pick = (want != null && pads[want]) ? want : -1;
        if (pick === -1) {
            for (var i = 0; i < pads.length; i++) {
                if (pads[i]) { pick = i; break; }
            }
        }
        if (pick !== -1 && pads[pick]) {
            padIndex = pick;
            if (!connected) {
                connected = true;
                padType = detectType(pads[pick].id);
                showPrompt(true);
            }
            if (typeof rememberPrimaryController === "function") {
                rememberPrimaryController(pads[pick]);
            }
            return pads[pick];
        }
        return null;
    }

    // Visible, actionable elements in document order.
    function collectItems() {
        var all = document.querySelectorAll(NAV_SELECTOR);
        var items = [];
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            // skip hidden / zero-size elements (e.g. controls in a hidden panel)
            if (el.offsetParent === null && el.getClientRects().length === 0) {
                continue;
            }
            items.push(el);
        }
        return items;
    }

    function indexOfFocus(items) {
        for (var i = 0; i < items.length; i++) {
            if (items[i] === focusEl) {
                return i;
            }
        }
        return -1;
    }

    function setFocus(el) {
        if (focusEl && focusEl !== el) {
            focusEl.classList.remove("gp-focus");
        }
        focusEl = el;
        if (el) {
            el.classList.add("gp-focus");
            try { el.focus({ preventScroll: false }); } catch (err) { el.focus(); }
        }
    }

    function center(el) {
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    // 2D spatial move: focus the nearest item in the pressed direction, so
    // "down" goes to the element below rather than the next one in DOM order.
    function moveFocus(dir) {
        var items = collectItems();
        if (items.length === 0) {
            return;
        }
        if (!focusEl || indexOfFocus(items) === -1) {
            // nothing focused yet (or it was re-rendered away) — land on the first
            setFocus(items[0]);
            return;
        }
        var f = center(focusEl);
        var best = null;
        var bestScore = Infinity;
        for (var i = 0; i < items.length; i++) {
            if (items[i] === focusEl) {
                continue;
            }
            var p = center(items[i]);
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
            setFocus(best);
        }
    }

    function activate() {
        var items = collectItems();
        if (indexOfFocus(items) === -1) {
            setFocus(items[0]);
            return;
        }
        if (!focusEl) {
            return;
        }
        if (focusEl.tagName.toLowerCase() === "input") {
            // Pop the on-screen keyboard so the field is typeable with a pad;
            // fall back to a plain focus if the OSK module isn't present.
            if (typeof oskOpen === "function") {
                oskOpen(focusEl);
            } else {
                focusEl.focus();
            }
            return;
        }
        focusEl.click();
    }

    function back() {
        var path = location.pathname;
        if (/index\.html$/.test(path) || path === "/" || path === "") {
            return; // already at the top of the menu tree
        }
        location.href = "./index.html";
    }

    function pressed(pad, idx) {
        var now = pad.buttons[idx] && pad.buttons[idx].pressed;
        var was = prevButtons[idx] || false;
        return !!now && !was;
    }

    function recordButtons(pad) {
        prevButtons = [];
        for (var i = 0; i < pad.buttons.length; i++) {
            prevButtons[i] = pad.buttons[i].pressed;
        }
    }

    // While the on-screen keyboard is open, the d-pad/stick moves between keys
    // (2D spatial), A presses the key, B closes the keyboard.
    function handleOskInput(pad) {
        if (pressed(pad, BTN_A)) {
            oskActivateFocused();
        }
        if (pressed(pad, BTN_B)) {
            oskClose();
            return;
        }
        var now = Date.now();
        if (pressed(pad, DPAD_UP)) {
            oskMoveFocus("up");
        } else if (pressed(pad, DPAD_DOWN)) {
            oskMoveFocus("down");
        } else if (pressed(pad, DPAD_LEFT)) {
            oskMoveFocus("left");
        } else if (pressed(pad, DPAD_RIGHT)) {
            oskMoveFocus("right");
        } else if (now - lastStepAt > REPEAT_DELAY) {
            var ly = pad.axes[1] || 0;
            var lx = pad.axes[0] || 0;
            if (ly < -MOVE_DEADZONE) { oskMoveFocus("up"); lastStepAt = now; }
            else if (ly > MOVE_DEADZONE) { oskMoveFocus("down"); lastStepAt = now; }
            else if (lx < -MOVE_DEADZONE) { oskMoveFocus("left"); lastStepAt = now; }
            else if (lx > MOVE_DEADZONE) { oskMoveFocus("right"); lastStepAt = now; }
        }
    }

    function loop() {
        rafId = window.requestAnimationFrame(loop);
        var pad = getPad();
        if (!pad) {
            return;
        }

        if (typeof oskIsOpen === "function" && oskIsOpen()) {
            handleOskInput(pad);
            recordButtons(pad);
            return;
        }

        // Edge-triggered actions
        if (pressed(pad, BTN_A)) {
            activate();
        }
        if (pressed(pad, BTN_B)) {
            back();
        }

        // Directional focus movement: d-pad (edge) or left stick (with repeat).
        var now = Date.now();
        var ly = pad.axes[1] || 0;
        var lx = pad.axes[0] || 0;
        var dir = null;
        if (pressed(pad, DPAD_UP)) { dir = "up"; }
        else if (pressed(pad, DPAD_DOWN)) { dir = "down"; }
        else if (pressed(pad, DPAD_LEFT)) { dir = "left"; }
        else if (pressed(pad, DPAD_RIGHT)) { dir = "right"; }
        else if (now - lastStepAt > REPEAT_DELAY) {
            if (ly < -MOVE_DEADZONE) { dir = "up"; }
            else if (ly > MOVE_DEADZONE) { dir = "down"; }
            else if (lx < -MOVE_DEADZONE) { dir = "left"; }
            else if (lx > MOVE_DEADZONE) { dir = "right"; }
        }
        if (dir) {
            moveFocus(dir);
            lastStepAt = now;
        }

        recordButtons(pad);
    }

    // --- prompt overlay (reuses the .gamepad-prompts styles) ---
    function buildPrompt() {
        if (promptEl || !document.body) {
            return;
        }
        var el = document.createElement("div");
        el.id = "gamepadPrompts";
        el.className = "gamepad-prompts hidden";
        document.body.appendChild(el);
        promptEl = el;
    }

    function showPrompt(on) {
        if (!promptEl) {
            buildPrompt();
        }
        if (!promptEl) {
            return;
        }
        if (!on) {
            promptEl.className = "gamepad-prompts hidden";
            return;
        }
        var aGlyph = padType === "playstation" ? "✕" : "A";
        var bGlyph = padType === "playstation" ? "○" : "B";
        promptEl.innerHTML =
            '<span class="gp-toast">🎮 Controller connected</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-dpad">↕</span>Navigate</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-face">' + aGlyph + '</span>Select</span>' +
            '<span class="gp-hint"><span class="gp-glyph gp-face">' + bGlyph + '</span>Back</span>';
        promptEl.className = "gamepad-prompts visible";
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
