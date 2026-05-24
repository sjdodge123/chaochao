"use strict";

// Lightweight, self-contained controller-detection header for the pages that
// don't have an in-game player header (index / join / create). It shows how many
// controllers the browser is detecting and a "press A to join" hint per pad, so
// you can glance at the header on any page to see what's plugged in. It is purely
// informational here — there is no game/socket on these pages, so actual joining
// happens in-game (play.html has its own real per-player header).
//
// Note: browsers only surface a gamepad after its first button press, so a pad
// appears here once it's been pressed (same as in-game).

(function () {
    if (typeof document === "undefined" || typeof navigator === "undefined") {
        return;
    }

    function detectType(id) {
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
    function attackGlyph(type) {
        return type === "playstation" ? "✕" : "A";
    }

    var el = null;
    function ensureEl() {
        if (el || !document.body) {
            return el;
        }
        el = document.createElement("div");
        el.id = "controllerHeader";
        document.body.appendChild(el);
        return el;
    }

    var lastSig = "";
    function render() {
        var box = ensureEl();
        if (!box) {
            return;
        }
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        var present = [];
        for (var i = 0; i < pads.length; i++) {
            if (pads[i]) {
                present.push(detectType(pads[i].id));
            }
        }
        // Only touch the DOM when the set of controllers changes.
        var sig = present.join(",");
        if (sig === lastSig) {
            return;
        }
        lastSig = sig;
        if (present.length === 0) {
            box.innerHTML = "";
            box.classList.remove("visible");
            return;
        }
        var html = '<span class="ch-count">🎮 ' + present.length + " " +
            (present.length === 1 ? "controller" : "controllers") + "</span>";
        for (var j = 0; j < present.length; j++) {
            html += '<span class="ch-pad">' +
                '<span class="pp-label">P' + (j + 1) + '</span>' +
                '<span class="gp-glyph gp-face">' + attackGlyph(present[j]) + '</span>' +
                '<span class="ch-join">press to join</span>' +
                '</span>';
        }
        box.innerHTML = html;
        box.classList.add("visible");
    }

    function start() {
        ensureEl();
        render();
        // A detection indicator doesn't need 60fps; poll a few times a second.
        setInterval(render, 250);
        window.addEventListener("gamepadconnected", render, false);
        window.addEventListener("gamepaddisconnected", render, false);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
