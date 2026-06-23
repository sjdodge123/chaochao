"use strict";

// ============================================================================
// Tactile DOM touch HUD (rudimentary prototype)
// ----------------------------------------------------------------------------
// A purely-VISUAL overlay that makes the touch controls read clearly as a
// gamepad (filled base pad, glossy thumb-knob, directional chevrons, a glossy
// punch button) plus a first-time, GATED WALKTHROUGH that teaches the controls
// by making the player actually perform each one. It does NOT handle input: the
// overlay is `pointer-events:none` (except the Skip button), so every touch
// falls through to the canvas and the existing, battle-tested input path
// (input.js onTouch*, joystick.js) drives the game exactly as before. Each frame
// we READ the live control state (joystickMovement / attackButton) and paint a
// matching DOM control on top, then suppress the canvas-drawn rings
// (window.__touchHudDom).
//
// Toggle: ?domhud=0 disables it (falls back to the canvas rings) for A/B.
// Only activates on touch devices (isTouchScreen).
// ============================================================================

(function () {
    var STYLE_ID = "touch-hud-style";
    var ROOT_ID = "touch-hud-root";
    // New key (v2): the gated walkthrough supersedes the old one-shot hint, so it
    // shows again even to players who saw the previous "touchHudHintSeen" hint.
    var WALK_KEY = "touchWalkthroughSeen";

    // Attack tap-vs-hold thresholds (ms). A quick press+release is a "punch"; a
    // press held past HOLD_MS is a "kick" (the charged punch). See the
    // kick-equals-hold-punch convention.
    var HOLD_MS = 350;
    var TAP_MAX = 280;

    var root = null;
    var elJoyBase, elJoyKnob, elAtk;
    var started = false;

    // ---- Walkthrough state ----
    var walk = null;            // the walkthrough DOM wrapper (null once finished)
    var walkSteps = [];         // resolved, ordered step list
    var walkIdx = 0;
    var walkDone = false;
    var walkPlaced = false;     // first frame() has positioned the active step (anti-flash + gates taps)
    var advanceLock = false;    // brief lockout so one gesture advances exactly one step
    // Attack press tracking (for tap vs hold detection across frames).
    var atkPressStart = 0;      // ms when the current press began (0 = not pressed)
    var atkWasPressed = false;

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
            // ---- walkthrough: highlight ring + pointer + bubble + directional arrow ----
            "#" + ROOT_ID + " .wt-ring{position:absolute;border-radius:50%;border:3px solid #fff;transform:translate(-50%,-50%);animation:thcRing 1.4s ease-out infinite;}",
            "@keyframes thcRing{0%{opacity:.9;transform:translate(-50%,-50%) scale(.8);}100%{opacity:0;transform:translate(-50%,-50%) scale(1.25);}}",
            "#" + ROOT_ID + " .wt-finger{position:absolute;transform:translate(-50%,-50%);animation:thcTap 1.1s ease-in-out infinite;}",
            "@keyframes thcTap{0%,100%{transform:translate(-50%,-50%) scale(1);}50%{transform:translate(-50%,-42%) scale(.82);}}",
            "#" + ROOT_ID + " .wt-arrow{position:absolute;transform:translate(-50%,-50%);color:#7fe3ff;font-weight:900;",
            "text-shadow:0 2px 6px rgba(0,0,0,.7);line-height:1;}",
            "@keyframes wtUp{0%,100%{transform:translate(-50%,-30%);}50%{transform:translate(-50%,-90%);}}",
            "@keyframes wtDown{0%,100%{transform:translate(-50%,-70%);}50%{transform:translate(-50%,-10%);}}",
            "@keyframes wtLeft{0%,100%{transform:translate(-30%,-50%);}50%{transform:translate(-90%,-50%);}}",
            "@keyframes wtRight{0%,100%{transform:translate(-70%,-50%);}50%{transform:translate(-10%,-50%);}}",
            "#" + ROOT_ID + " .wt-arrow.up{animation:wtUp 1s ease-in-out infinite;}",
            "#" + ROOT_ID + " .wt-arrow.down{animation:wtDown 1s ease-in-out infinite;}",
            "#" + ROOT_ID + " .wt-arrow.left{animation:wtLeft 1s ease-in-out infinite;}",
            "#" + ROOT_ID + " .wt-arrow.right{animation:wtRight 1s ease-in-out infinite;}",
            "#" + ROOT_ID + " .bubble{position:absolute;transform:translate(-50%,-50%);background:rgba(15,18,24,.9);color:#fff;",
            "padding:9px 14px;border-radius:12px;font-weight:700;white-space:nowrap;border:1px solid rgba(255,255,255,.18);",
            "box-shadow:0 6px 20px rgba(0,0,0,.5);text-align:center;}",
            "#" + ROOT_ID + " .bubble .step{display:block;font-weight:600;opacity:.55;font-size:.72em;letter-spacing:.5px;margin-bottom:2px;}",
            "#" + ROOT_ID + " .bubble small{display:block;font-weight:500;opacity:.82;}",
            // ---- Skip button (the ONLY interactive element in the overlay) ----
            "#" + ROOT_ID + " .wt-skip{position:absolute;pointer-events:auto;background:rgba(15,18,24,.82);color:#cfe3ff;",
            "border:1px solid rgba(255,255,255,.22);border-radius:999px;font-weight:700;cursor:pointer;",
            "box-shadow:0 4px 14px rgba(0,0,0,.4);-webkit-tap-highlight-color:transparent;}",
            "#" + ROOT_ID + " .wt-wrap{transition:opacity .4s ease;}",
            "#" + ROOT_ID + " .wt-wrap.gone{opacity:0;}"
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

    // ---- Walkthrough step list -------------------------------------------------
    // Movement (gated on a real joystick push), punch (tap), kick (hold/charge),
    // then the corner buttons (pointed out, advance on a tap — actually pressing
    // them would open their menus). Corner steps are included only when their
    // control exists; fullscreen is auto-skipped where unsupported (e.g. Discord).
    var STEP_TEMPLATES = [
        { id: "up", kind: "dir", dir: "up", glyph: "▲", title: "Move up", sub: "push the stick up" },
        { id: "down", kind: "dir", dir: "down", glyph: "▼", title: "Move down", sub: "push the stick down" },
        { id: "left", kind: "dir", dir: "left", glyph: "◀", title: "Move left", sub: "push the stick left" },
        { id: "right", kind: "dir", dir: "right", glyph: "▶", title: "Move right", sub: "push the stick right" },
        { id: "punch", kind: "tap", title: "Punch", sub: "tap the button" },
        { id: "kick", kind: "hold", title: "Kick", sub: "hold the button to charge" },
        { id: "settings", kind: "point", target: "settings", title: "Settings", sub: "tap to continue" },
        { id: "emoji", kind: "point", target: "emoji", title: "Emotes", sub: "tap to continue" },
        { id: "fullscreen", kind: "point", target: "fullscreen", title: "Fullscreen", sub: "tap to continue" }
    ];
    function buildSteps() {
        return STEP_TEMPLATES.filter(function (s) {
            if (s.target === "fullscreen") {
                return typeof fullscreenSupported === "function" && fullscreenSupported();
            }
            return true; // dir/tap/hold always; settings/emoji re-checked at render and tap-advanceable
        });
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
        elAtk.style.visibility = "hidden"; // until first frame() positions it (anti-flash)

        root.appendChild(elJoyBase);
        root.appendChild(elJoyKnob);
        root.appendChild(elAtk);

        // First-run gated walkthrough.
        if (!walkSeen()) {
            walkSteps = buildSteps();
            walk = el("wt-wrap");
            walk._ring = el("wt-ring");
            walk._finger = el("wt-finger", "👆");
            walk._arrow = el("wt-arrow");
            walk._bubble = el("bubble");
            walk._skip = document.createElement("button");
            walk._skip.type = "button";
            walk._skip.className = "wt-skip";
            walk._skip.textContent = "Skip ✕";
            walk._skip.addEventListener("click", function (e) {
                if (e && e.preventDefault) e.preventDefault();
                finishWalk();
            });
            walk.appendChild(walk._ring);
            walk.appendChild(walk._finger);
            walk.appendChild(walk._arrow);
            walk.appendChild(walk._bubble);
            walk.appendChild(walk._skip);
            walk.style.visibility = "hidden"; // until first frame() places the active step
            root.appendChild(walk);
            // Tap-to-continue for the "point" steps (settings/emoji/fullscreen):
            // any touch advances. Ignored for action steps, which are gated on the
            // real control instead. Only after the step is actually on screen.
            window.addEventListener("touchstart", onWalkTouch, { passive: true });
        }

        // Parent INTO the fullscreen target (#gameWindow) so the overlay renders in
        // the fullscreen top layer (and stays visible in fullscreen).
        var host = document.getElementById("gameWindow") || document.body;
        host.appendChild(root);
    }

    function walkSeen() {
        // ?walkthrough=1 force-shows it (no devtools needed to replay on a phone); harmless
        // opt-in in prod, like ?domhud. Otherwise honor the once-only localStorage flag.
        try {
            if (/[?&]walkthrough=1\b/.test((window.location && window.location.search) || "")) { return false; }
        } catch (e) { /* ignore */ }
        try { return localStorage.getItem(WALK_KEY) === "1"; } catch (e) { return false; }
    }
    // A tap advances ONLY the "point" steps, and only once the step is on screen.
    function onWalkTouch() {
        if (walkDone || !walk || !walkPlaced || advanceLock) return;
        var step = walkSteps[walkIdx];
        if (step && step.kind === "point") { advanceStep(); }
    }
    function advanceStep() {
        if (advanceLock || walkDone) return;
        advanceLock = true;
        atkPressStart = 0; atkWasPressed = false; // reset attack tracking between steps
        setTimeout(function () { advanceLock = false; }, 320); // debounce one gesture -> one step
        walkIdx++;
        if (walkIdx >= walkSteps.length) { finishWalk(); }
    }
    function finishWalk() {
        if (walkDone) return;
        walkDone = true;
        window.removeEventListener("touchstart", onWalkTouch);
        try { localStorage.setItem(WALK_KEY, "1"); } catch (e) { /* ignore */ }
        if (walk) {
            walk.classList.add("gone");
            var w = walk;
            setTimeout(function () { if (w && w.parentNode) w.parentNode.removeChild(w); }, 450);
            walk = null;
        }
    }

    // Map a logical (canvas-space) coordinate to a viewport CSS-px coordinate.
    function mapper() {
        var rect = gameCanvas.getBoundingClientRect();
        var sx = rect.width / (LOGICAL_WIDTH || rect.width || 1);
        var sy = rect.height / (LOGICAL_HEIGHT || rect.height || 1);
        return {
            x: function (lx) { return rect.left + lx * sx; },
            y: function (ly) { return rect.top + ly * sy; },
            s: (sx + sy) / 2,
            rect: rect
        };
    }

    function place(node, cx, cy, diameter) {
        node.style.left = (cx - diameter / 2) + "px";
        node.style.top = (cy - diameter / 2) + "px";
        node.style.width = diameter + "px";
        node.style.height = diameter + "px";
    }

    // Viewport-px center of a "point" step target, or null if it isn't on screen now.
    function targetRect(target, m) {
        try {
            if (target === "settings") {
                var g = document.getElementById("touchSettingsBtn");
                if (g && g.offsetParent !== null) {
                    var r = g.getBoundingClientRect();
                    if (r.width > 0) return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, d: Math.max(r.width, r.height) + 18 };
                }
                return null;
            }
            if (target === "emoji") {
                if (typeof chatButton !== "undefined" && chatButton && chatButton.isVisible && chatButton.isVisible()) {
                    var d1 = (chatButton.radius || 30) * 2 * m.s;
                    return { cx: m.x(chatButton.baseX), cy: m.y(chatButton.baseY), d: d1 + 14 };
                }
                return null;
            }
            if (target === "fullscreen") {
                if (typeof exitButton !== "undefined" && exitButton && exitButton.isVisible && exitButton.isVisible() &&
                    typeof fullscreenSupported === "function" && fullscreenSupported()) {
                    var d2 = (exitButton.radius || 30) * 2 * m.s;
                    return { cx: m.x(exitButton.baseX), cy: m.y(exitButton.baseY), d: d2 + 14 };
                }
                return null;
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    function frame() {
        if (!root) return;
        try {
            if (typeof gameCanvas === "undefined" || !gameCanvas) { requestAnimationFrame(frame); return; }
            var m = mapper();
            var capFont = Math.round(Math.max(13, Math.min(30, 13 / (fitRatio || 1))));
            var jm = (typeof joystickMovement !== "undefined") ? joystickMovement : null;
            var ab = (typeof attackButton !== "undefined") ? attackButton : null;

            // ---- Joystick (floating: visible only while the thumb is down) ----
            if (jm && jm.pressed) {
                place(elJoyBase, m.x(jm.baseX), m.y(jm.baseY), jm.baseRadius * 2 * m.s);
                place(elJoyKnob, m.x(jm.stickX), m.y(jm.stickY), jm.stickRadius * 2 * m.s);
                elJoyBase.style.display = "";
                elJoyKnob.style.display = "";
            } else {
                elJoyBase.style.display = "none";
                elJoyKnob.style.display = "none";
            }

            // ---- Attack button (always anchored lower-right) ----
            if (ab && ab.radius) {
                var atkD = ab.radius * 2 * m.s;
                place(elAtk, m.x(ab.baseX), m.y(ab.baseY), atkD);
                elAtk.style.fontSize = Math.round(atkD * 0.42) + "px";
                if (ab.pressed) elAtk.classList.add("pressed"); else elAtk.classList.remove("pressed");
                elAtk.style.display = "";
                elAtk.style.visibility = "";
            } else {
                elAtk.style.display = "none";
            }

            // ---- Gated walkthrough: detect completion of the active step + place it ----
            if (walk && !walkDone) {
                var step = walkSteps[walkIdx];
                if (step) {
                    detectStep(step, jm, ab);
                    placeStep(step, jm, ab, m, capFont);
                    walk.style.visibility = "";
                    walkPlaced = true;
                }
            }
        } catch (e) { /* never let the HUD break the game */ }
        requestAnimationFrame(frame);
    }

    // Advance the active step when the player performs its gesture.
    function detectStep(step, jm, ab) {
        if (advanceLock) return;
        if (step.kind === "dir") {
            if (jm && jm.pressed) {
                var dx = jm.stickX - jm.baseX, dy = jm.stickY - jm.baseY;
                var thr = (jm.maxPullRadius || jm.baseRadius * 0.5) * 0.5;
                var ok = false;
                if (step.dir === "up") ok = dy < -thr && Math.abs(dy) >= Math.abs(dx);
                else if (step.dir === "down") ok = dy > thr && Math.abs(dy) >= Math.abs(dx);
                else if (step.dir === "left") ok = dx < -thr && Math.abs(dx) >= Math.abs(dy);
                else if (step.dir === "right") ok = dx > thr && Math.abs(dx) >= Math.abs(dy);
                if (ok) advanceStep();
            }
            return;
        }
        if (step.kind === "tap" || step.kind === "hold") {
            var pressed = !!(ab && ab.pressed);
            var now = Date.now();
            if (pressed && !atkWasPressed) { atkPressStart = now; }        // press begins
            if (step.kind === "hold" && pressed && atkPressStart && (now - atkPressStart) >= HOLD_MS) {
                advanceStep();                                              // held long enough = kick
            }
            if (!pressed && atkWasPressed) {                                // released
                var held = atkPressStart ? (now - atkPressStart) : 0;
                if (step.kind === "tap" && held > 0 && held < TAP_MAX) { advanceStep(); } // quick tap = punch
                atkPressStart = 0;
            }
            atkWasPressed = pressed;
            return;
        }
        // "point" steps advance via onWalkTouch (tap to continue), or auto-skip if
        // their control isn't on screen at all.
        if (step.kind === "point") {
            // handled in placeStep (auto-skip when target is unavailable)
        }
    }

    function placeStep(step, jm, ab, m, capFont) {
        var ring = walk._ring, finger = walk._finger, arrow = walk._arrow, bubble = walk._bubble;
        var stepLabel = "Step " + (walkIdx + 1) + " / " + walkSteps.length;
        bubble.innerHTML = '<span class="step">' + stepLabel + "</span>" + step.title +
            "<small>" + step.sub + "</small>";
        bubble.style.fontSize = capFont + "px";

        // Skip button: top-center, pushed clear of the notch / Discord header via the
        // device safe-area inset (the same env() the page's safe-area vars build on).
        walk._skip.style.left = (m.rect.left + m.rect.width / 2) + "px";
        walk._skip.style.transform = "translateX(-50%)";
        walk._skip.style.top = "calc(" + m.rect.top + "px + env(safe-area-inset-top, 0px) + 6px)";
        walk._skip.style.fontSize = Math.max(12, capFont - 2) + "px";
        walk._skip.style.padding = "6px 14px";

        function showArrow(dir, cx, cy, sizePx) {
            arrow.className = "wt-arrow " + dir;
            arrow.textContent = step.glyph || "";
            arrow.style.left = cx + "px"; arrow.style.top = cy + "px";
            arrow.style.fontSize = sizePx + "px";
            arrow.style.display = "";
        }
        function hideArrow() { arrow.style.display = "none"; }
        function setRing(cx, cy, d) {
            ring.style.left = cx + "px"; ring.style.top = cy + "px";
            ring.style.width = d + "px"; ring.style.height = d + "px"; ring.style.display = "";
        }
        function setFinger(cx, cy, sizePx) {
            finger.style.left = cx + "px"; finger.style.top = cy + "px";
            finger.style.fontSize = sizePx + "px"; finger.style.display = "";
        }
        function setBubble(cx, cy) { bubble.style.left = cx + "px"; bubble.style.top = cy + "px"; }

        if (step.kind === "dir") {
            // Anchor at the thumb-friendly resting spot in the lower-left; if the
            // player already has the stick down, follow the live base instead.
            var ax = (jm && jm.pressed) ? m.x(jm.baseX) : (m.rect.left + m.rect.width * 0.16);
            var ay = (jm && jm.pressed) ? m.y(jm.baseY) : (m.rect.top + m.rect.height * 0.74);
            var ringD = (jm ? jm.baseRadius * 2 * m.s : 140);
            setRing(ax, ay, ringD);
            finger.style.display = "none";
            showArrow(step.dir, ax, ay, Math.round(ringD * 0.5));
            setBubble(ax, ay - ringD * 0.85);
            return;
        }
        if (step.kind === "tap" || step.kind === "hold") {
            var bx = ab ? m.x(ab.baseX) : (m.rect.right - 90);
            var by = ab ? m.y(ab.baseY) : (m.rect.bottom - 90);
            var ringA = (ab && ab.radius ? ab.radius * 2 * m.s : 120);
            setRing(bx, by, ringA);
            hideArrow();
            setFinger(bx, by, Math.round(ringA * 0.32));
            setBubble(bx, by - ringA * 0.85);
            return;
        }
        if (step.kind === "point") {
            var tr = targetRect(step.target, m);
            if (!tr) { advanceStep(); return; } // control not on screen — skip this step
            setRing(tr.cx, tr.cy, tr.d);
            hideArrow();
            setFinger(tr.cx, tr.cy, Math.round(tr.d * 0.34));
            // Keep the bubble on-screen: below the control if it's near the top.
            var below = tr.cy < (m.rect.top + m.rect.height * 0.4);
            setBubble(tr.cx, tr.cy + (below ? tr.d * 0.85 : -tr.d * 0.85));
            return;
        }
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
