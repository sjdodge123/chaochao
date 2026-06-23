"use strict";

// ============================================================================
// Tactile DOM touch HUD (rudimentary prototype)
// ----------------------------------------------------------------------------
// A purely-VISUAL overlay that makes the touch controls read clearly as a
// gamepad (filled base pad, glossy thumb-knob, directional chevrons, a glossy
// punch button) plus a one-time first-time hint. It does NOT handle input: the
// overlay is `pointer-events:none`, so every touch falls through to the canvas
// and the existing, battle-tested input path (input.js onTouch*, joystick.js)
// drives the game exactly as before. Each frame we just READ the live control
// state (joystickMovement / attackButton) and paint a matching DOM control on
// top, then suppress the canvas-drawn rings (window.__touchHudDom).
//
// Toggle: ?domhud=0 disables it (falls back to the canvas rings) for A/B.
// Only activates on touch devices (isTouchScreen).
// ============================================================================

(function () {
    var STYLE_ID = "touch-hud-style";
    var ROOT_ID = "touch-hud-root";
    var HINT_KEY = "touchHudHintSeen";

    var root = null, hint = null;
    var elJoyBase, elJoyKnob, elAtk;
    var started = false;
    var hintDismissed = false;
    var hintPlaced = false;   // first frame() has positioned the hint (gates dismissal)

    function enabled() {
        // URL opt-out for A/B against the old canvas controls.
        try {
            var q = (window.location && window.location.search) || "";
            if (/[?&]domhud=0\b/.test(q)) return false;
        } catch (e) { /* ignore */ }
        return typeof isTouchScreen !== "undefined" && isTouchScreen === true;
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var css = [
            // position:fixed + viewport coords: fixed is viewport-relative both
            // windowed AND in fullscreen, and gameCanvas.getBoundingClientRect()
            // is too, so the two always agree (no containing-block math to drift).
            // The root is still parented INTO #gameWindow (below) so it renders in
            // the fullscreen top layer — a body-level overlay would vanish in
            // fullscreen since it's outside the fullscreen element's subtree.
            "#" + ROOT_ID + "{position:fixed;inset:0;z-index:30;pointer-events:none;}",
            "#" + ROOT_ID + " .thc{position:absolute;will-change:transform,left,top,width,height;}",
            // ---- joystick base pad ----
            "#" + ROOT_ID + " .joy-base{border-radius:50%;",
            "background:radial-gradient(circle at 50% 38%,rgba(255,255,255,.14),rgba(255,255,255,0) 60%),radial-gradient(circle,rgba(20,26,34,.42),rgba(20,26,34,.30));",
            "border:2px solid rgba(255,255,255,.40);",
            "box-shadow:inset 0 6px 18px rgba(0,0,0,.45),inset 0 -3px 8px rgba(255,255,255,.12),0 8px 22px rgba(0,0,0,.35);}",
            "#" + ROOT_ID + " .joy-base .chev{position:absolute;color:#fff;font-size:14px;opacity:.5;text-shadow:0 1px 2px rgba(0,0,0,.6);line-height:1;}",
            "#" + ROOT_ID + " .joy-base .chev.u{top:7%;left:50%;transform:translateX(-50%);}",
            "#" + ROOT_ID + " .joy-base .chev.d{bottom:7%;left:50%;transform:translateX(-50%);}",
            "#" + ROOT_ID + " .joy-base .chev.l{left:7%;top:50%;transform:translateY(-50%);}",
            "#" + ROOT_ID + " .joy-base .chev.r{right:7%;top:50%;transform:translateY(-50%);}",
            // ---- joystick knob ----
            "#" + ROOT_ID + " .joy-knob{border-radius:50%;",
            "background:radial-gradient(circle at 50% 30%,#6fe0ff,#2ad1ff 55%,#1199c6 100%);",
            "border:2px solid rgba(255,255,255,.55);",
            "box-shadow:0 8px 16px rgba(0,0,0,.5),inset 0 4px 8px rgba(255,255,255,.55),inset 0 -6px 10px rgba(0,0,0,.3);}",
            // ---- attack button ----
            "#" + ROOT_ID + " .atk{border-radius:50%;display:grid;place-items:center;color:#fff;",
            "background:radial-gradient(circle at 50% 30%,#ff7a6e,#ff4838 55%,#c92a1d 100%);",
            "border:3px solid rgba(255,255,255,.55);",
            "box-shadow:0 10px 22px rgba(201,42,29,.5),inset 0 5px 10px rgba(255,255,255,.5),inset 0 -8px 14px rgba(0,0,0,.32);",
            "text-shadow:0 2px 4px rgba(0,0,0,.45);transition:transform .06s ease,filter .06s ease,box-shadow .12s ease;}",
            "#" + ROOT_ID + " .atk .glyph{pointer-events:none;}",
            "#" + ROOT_ID + " .atk.pressed{transform:scale(.93);filter:brightness(1.12);",
            "box-shadow:0 4px 10px rgba(201,42,29,.6),inset 0 6px 14px rgba(0,0,0,.4);}",
            "#" + ROOT_ID + " .cap{position:absolute;left:50%;transform:translateX(-50%);color:#fff;font-weight:700;",
            "white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.8);letter-spacing:.3px;}",
            // ---- first-time hint ----
            "#" + ROOT_ID + " .hint-ring{position:absolute;border-radius:50%;border:3px solid #fff;transform:translate(-50%,-50%);animation:thcRing 1.4s ease-out infinite;}",
            "@keyframes thcRing{0%{opacity:.9;transform:translate(-50%,-50%) scale(.8);}100%{opacity:0;transform:translate(-50%,-50%) scale(1.25);}}",
            "#" + ROOT_ID + " .hint-finger{position:absolute;transform:translate(-50%,-50%);animation:thcSwipe 1.6s ease-in-out infinite;}",
            "@keyframes thcSwipe{0%,100%{transform:translate(-90%,-30%);}50%{transform:translate(10%,-80%);}}",
            "#" + ROOT_ID + " .hint-tap{position:absolute;transform:translate(-50%,-50%);animation:thcTap 1.1s ease-in-out infinite;}",
            "@keyframes thcTap{0%,100%{transform:translate(-50%,-50%) scale(1);}50%{transform:translate(-50%,-42%) scale(.82);}}",
            "#" + ROOT_ID + " .bubble{position:absolute;transform:translate(-50%,-50%);background:rgba(15,18,24,.88);color:#fff;",
            "padding:8px 12px;border-radius:12px;font-weight:700;white-space:nowrap;border:1px solid rgba(255,255,255,.18);",
            "box-shadow:0 6px 20px rgba(0,0,0,.45);text-align:center;}",
            "#" + ROOT_ID + " .bubble small{display:block;font-weight:500;opacity:.8;}",
            "#" + ROOT_ID + " .hint-wrap{transition:opacity .4s ease;}",
            "#" + ROOT_ID + " .hint-wrap.gone{opacity:0;}"
        ].join("");
        var s = document.createElement("style");
        s.id = STYLE_ID;
        s.textContent = css;
        document.head.appendChild(s);
    }

    function el(cls, html) {
        var d = document.createElement("div");
        d.className = cls;
        if (html != null) d.innerHTML = html;
        return d;
    }

    function buildDom() {
        root = document.createElement("div");
        root.id = ROOT_ID;

        elJoyBase = el("thc joy-base",
            '<span class="chev u">▲</span><span class="chev d">▼</span>' +
            '<span class="chev l">◀</span><span class="chev r">▶</span>');
        elJoyKnob = el("thc joy-knob");
        elAtk = el("thc atk", '<span class="glyph">👊</span>');

        elJoyBase.style.display = "none";
        elJoyKnob.style.display = "none";
        // Hidden until the first frame() positions it, so it can't flash at the
        // default top-left/static-flow spot before placement.
        elAtk.style.visibility = "hidden";

        root.appendChild(elJoyBase);
        root.appendChild(elJoyKnob);
        root.appendChild(elAtk);

        // First-time hint (shown once, dismissed on first touch).
        if (!hintSeen()) {
            hint = el("hint-wrap");
            hint._ringJoy = el("hint-ring");
            hint._ringAtk = el("hint-ring");
            hint._fingerJoy = el("hint-finger", "👆");
            hint._tapAtk = el("hint-tap", "👆");
            hint._bubbleJoy = el("bubble", "Drag to move<small>slide your thumb</small>");
            hint._bubbleAtk = el("bubble", "Tap to punch<small>hold to charge</small>");
            hint.appendChild(hint._ringJoy);
            hint.appendChild(hint._ringAtk);
            hint.appendChild(hint._fingerJoy);
            hint.appendChild(hint._tapAtk);
            hint.appendChild(hint._bubbleJoy);
            hint.appendChild(hint._bubbleAtk);
            // Hidden until the first frame() positions every node (anti-flash).
            hint.style.visibility = "hidden";
            root.appendChild(hint);
            // Dismiss only on a real interaction: a touch that lands inside the
            // game canvas, AFTER the hint has actually been shown. A global
            // "any touch" listener could burn the once-only flag on a tap on the
            // rotate prompt / loading UI before the player ever saw the HUD.
            window.addEventListener("touchstart", onHintTouch, { passive: true });
        }

        // Parent INTO the fullscreen target (#gameWindow) so the overlay renders in
        // the fullscreen top layer (and stays visible in fullscreen). Positioning is
        // viewport-fixed, so no positioning-context tweak to the host is needed.
        var host = document.getElementById("gameWindow") || document.body;
        host.appendChild(root);
    }

    function hintSeen() {
        try { return localStorage.getItem(HINT_KEY) === "1"; } catch (e) { return false; }
    }
    // Dismiss the first-time hint only on a genuine in-canvas touch, and only once
    // the hint has actually been placed on screen — so a stray early tap (loading
    // UI, rotate prompt, a tap outside the play area) can't permanently burn the
    // once-only HINT_KEY before the player has seen or used the controls.
    function onHintTouch(e) {
        if (hintDismissed) { window.removeEventListener("touchstart", onHintTouch); return; }
        if (!hintPlaced) return; // not visible yet — ignore
        var t = e.changedTouches && e.changedTouches[0];
        if (!t || typeof gameCanvas === "undefined" || !gameCanvas) return;
        var r = gameCanvas.getBoundingClientRect();
        if (t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom) {
            window.removeEventListener("touchstart", onHintTouch);
            dismissHint();
        }
    }
    function dismissHint() {
        if (hintDismissed) return;
        hintDismissed = true;
        window.removeEventListener("touchstart", onHintTouch);
        try { localStorage.setItem(HINT_KEY, "1"); } catch (e) { /* ignore */ }
        if (hint) {
            hint.classList.add("gone");
            setTimeout(function () { if (hint && hint.parentNode) hint.parentNode.removeChild(hint); hint = null; }, 450);
        }
    }

    // Map a logical (canvas-space) coordinate to a viewport CSS-px coordinate,
    // the inverse of input.js' canvasClientToLogical*. Controls are position:fixed
    // (viewport-relative), so these viewport coords place them correctly both
    // windowed and in fullscreen (the canvas rect is viewport-relative too).
    function mapper() {
        var rect = gameCanvas.getBoundingClientRect();
        var sx = rect.width / (LOGICAL_WIDTH || rect.width || 1);
        var sy = rect.height / (LOGICAL_HEIGHT || rect.height || 1);
        return {
            x: function (lx) { return rect.left + lx * sx; },
            y: function (ly) { return rect.top + ly * sy; },
            s: (sx + sy) / 2, // near-uniform; controls are circles
            rect: rect
        };
    }

    function place(node, cx, cy, diameter) {
        node.style.left = (cx - diameter / 2) + "px";
        node.style.top = (cy - diameter / 2) + "px";
        node.style.width = diameter + "px";
        node.style.height = diameter + "px";
    }

    function frame() {
        if (!root) return;
        try {
            if (typeof gameCanvas === "undefined" || !gameCanvas) { requestAnimationFrame(frame); return; }
            var m = mapper();
            var capFont = Math.round(Math.max(13, Math.min(34, 13 / (fitRatio || 1))));

            // ---- Joystick (floating: visible only while the thumb is down) ----
            var jm = (typeof joystickMovement !== "undefined") ? joystickMovement : null;
            if (jm && jm.pressed) {
                var baseD = jm.baseRadius * 2 * m.s;
                var knobD = jm.stickRadius * 2 * m.s;
                place(elJoyBase, m.x(jm.baseX), m.y(jm.baseY), baseD);
                place(elJoyKnob, m.x(jm.stickX), m.y(jm.stickY), knobD);
                elJoyBase.style.display = "";
                elJoyKnob.style.display = "";
            } else {
                elJoyBase.style.display = "none";
                elJoyKnob.style.display = "none";
            }

            // ---- Attack button (always anchored lower-right) ----
            var ab = (typeof attackButton !== "undefined") ? attackButton : null;
            if (ab && ab.radius) {
                var atkD = ab.radius * 2 * m.s;
                place(elAtk, m.x(ab.baseX), m.y(ab.baseY), atkD);
                elAtk.style.fontSize = Math.round(atkD * 0.42) + "px";
                if (ab.pressed) elAtk.classList.add("pressed"); else elAtk.classList.remove("pressed");
                elAtk.style.display = "";
                elAtk.style.visibility = ""; // now placed — safe to reveal (anti-flash)
            } else {
                elAtk.style.display = "none";
            }

            // ---- First-time hint placement (viewport px) ----
            if (hint && !hintDismissed) {
                // Joystick resting hint: a thumb-friendly spot in the lower-left.
                var hjx = m.rect.left + m.rect.width * 0.16;
                var hjy = m.rect.top + m.rect.height * 0.74;
                var ringD = (jm ? jm.baseRadius * 2 * m.s : 140);
                setRing(hint._ringJoy, hjx, hjy, ringD);
                setNode(hint._fingerJoy, hjx, hjy, Math.round(ringD * 0.28));
                setNode(hint._bubbleJoy, hjx, hjy - ringD * 0.75, capFont);
                // Attack hint: centred on the real punch button.
                var ax = ab ? m.x(ab.baseX) : m.rect.right - 90;
                var ay = ab ? m.y(ab.baseY) : m.rect.bottom - 90;
                var ringA = (ab && ab.radius ? ab.radius * 2 * m.s : 120);
                setRing(hint._ringAtk, ax, ay, ringA);
                setNode(hint._tapAtk, ax, ay, Math.round(ringA * 0.3));
                setNode(hint._bubbleAtk, ax, ay - ringA * 0.78, capFont);
                hint.style.visibility = ""; // placed — reveal (anti-flash)
                hintPlaced = true;          // now a real in-canvas touch may dismiss it
            }
        } catch (e) { /* never let the HUD break the game */ }
        requestAnimationFrame(frame);
    }

    function setRing(node, cx, cy, d) {
        node.style.left = cx + "px"; node.style.top = cy + "px";
        node.style.width = d + "px"; node.style.height = d + "px";
    }
    function setNode(node, cx, cy, fontPx) {
        node.style.left = cx + "px"; node.style.top = cy + "px";
        node.style.fontSize = fontPx + "px";
    }

    function start() {
        if (started || !enabled()) return;
        if (typeof gameCanvas === "undefined" || !gameCanvas || typeof LOGICAL_WIDTH !== "number" || LOGICAL_WIDTH <= 0) {
            return; // not ready yet; the poller will retry
        }
        started = true;
        window.__touchHudDom = true; // tell draw_hud.js to skip the canvas joystick/attack rings
        injectStyle();
        buildDom();
        requestAnimationFrame(frame);
    }

    // Poll until the game globals exist (init order: game.js sizes the canvas,
    // input.js builds joystickMovement/attackButton, then we attach).
    var tries = 0;
    function poll() {
        if (started) return;
        start();
        if (!started && tries++ < 200) {
            setTimeout(poll, 100);
        }
    }
    if (document.readyState === "complete" || document.readyState === "interactive") {
        poll();
    } else {
        window.addEventListener("DOMContentLoaded", poll);
        window.addEventListener("load", poll);
    }
})();
