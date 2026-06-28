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
    // The walkthrough lives in its OWN top layer (above the corner buttons — the settings
    // gear is a z-index:3001 DOM button), separate from the control art (#ROOT_ID, z-30,
    // which must stay BELOW the settings modal). See injectStyle / buildDom.
    var WALK_ID = "touch-walk-layer";
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
    var walkBuilt = false;      // the walkthrough DOM has been created this session (idempotency)
    var walkDeferred = false;   // signed-in: deferred at buildDom, waiting on the account flag
    var dirArmed = true;        // dir-step gate: a deferred build on a held stick must re-center first
    var walkFallbackTimer = null; // grace-period build if the account flag never arrives
    var advanceLock = false;    // brief lockout so one gesture advances exactly one step
    // Per-step chrome (bubble HTML, Skip-button text scale) is static for the life of a
    // step, so we rebuild it only when the step index or text scale changes — not every
    // frame. -1 = nothing rendered yet. (Re-parsing innerHTML + reading offsetWidth at
    // 60fps was the walkthrough's dominant per-frame cost.)
    var walkRenderedIdx = -1;
    var walkRenderedCap = -1;
    // Set when the player explicitly replays the tutorial from Settings. A deliberate
    // replay (like a dev force-show) is exempt from the race auto-dismiss — they asked to
    // watch it now, even mid-round.
    var walkUserReplay = false;
    // Inter-step breather: after a step is completed we hold the NEXT step's visuals for a
    // short beat so the tutorial doesn't snap from one to the next too fast. stepReadyAt is
    // the earliest time (ms) the active step may render/advance; 0 = ready now (first step).
    var STEP_GAP_MS = 450;
    var stepReadyAt = 0;
    // Attack press tracking (for tap vs hold detection across frames).
    var atkPressStart = 0;      // ms when the current press began (0 = not pressed)
    var atkWasPressed = false;
    // Entering/leaving fullscreen fires a resize + releases held touches; for a short
    // window after a fullscreenchange we freeze step detection + the point-step auto-skip
    // so the toggle can't spuriously cancel/advance the active step (see start()).
    var fsGuardUntil = 0;

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
            // ---- walkthrough layer (own stacking context ABOVE the corner buttons) ----
            "#" + WALK_ID + "{position:fixed;inset:0;z-index:3100;pointer-events:none;transition:opacity .4s ease;}",
            "#" + WALK_ID + ".gone{opacity:0;}",
            "#" + WALK_ID + " .wt-ring{position:absolute;border-radius:50%;border:3px solid #fff;transform:translate(-50%,-50%);animation:thcRing 1.4s ease-out infinite;}",
            "@keyframes thcRing{0%{opacity:.9;transform:translate(-50%,-50%) scale(.8);}100%{opacity:0;transform:translate(-50%,-50%) scale(1.25);}}",
            "#" + WALK_ID + " .wt-finger{position:absolute;transform:translate(-50%,-50%);animation:thcTap 1.1s ease-in-out infinite;}",
            "@keyframes thcTap{0%,100%{transform:translate(-50%,-50%) scale(1);}50%{transform:translate(-50%,-42%) scale(.82);}}",
            "#" + WALK_ID + " .wt-arrow{position:absolute;transform:translate(-50%,-50%);color:#7fe3ff;font-weight:900;",
            "text-shadow:0 2px 6px rgba(0,0,0,.7);line-height:1;}",
            "@keyframes wtUp{0%,100%{transform:translate(-50%,-30%);}50%{transform:translate(-50%,-90%);}}",
            "@keyframes wtDown{0%,100%{transform:translate(-50%,-70%);}50%{transform:translate(-50%,-10%);}}",
            "@keyframes wtLeft{0%,100%{transform:translate(-30%,-50%);}50%{transform:translate(-90%,-50%);}}",
            "@keyframes wtRight{0%,100%{transform:translate(-70%,-50%);}50%{transform:translate(-10%,-50%);}}",
            "#" + WALK_ID + " .wt-arrow.up{animation:wtUp 1s ease-in-out infinite;}",
            "#" + WALK_ID + " .wt-arrow.down{animation:wtDown 1s ease-in-out infinite;}",
            "#" + WALK_ID + " .wt-arrow.left{animation:wtLeft 1s ease-in-out infinite;}",
            "#" + WALK_ID + " .wt-arrow.right{animation:wtRight 1s ease-in-out infinite;}",
            "#" + WALK_ID + " .bubble{position:absolute;transform:translate(-50%,-50%);background:rgba(15,18,24,.92);color:#fff;",
            "padding:9px 14px;border-radius:12px;font-weight:700;white-space:nowrap;border:1px solid rgba(255,255,255,.18);",
            "box-shadow:0 6px 20px rgba(0,0,0,.5);text-align:center;}",
            "#" + WALK_ID + " .bubble .step{display:block;font-weight:600;opacity:.55;font-size:.72em;letter-spacing:.5px;margin-bottom:2px;}",
            "#" + WALK_ID + " .bubble small{display:block;font-weight:500;opacity:.82;}",
            // ---- Skip button (the ONLY interactive element in the walkthrough) ----
            "#" + WALK_ID + " .wt-skip{position:absolute;pointer-events:auto;background:rgba(15,18,24,.82);color:#cfe3ff;",
            "border:1px solid rgba(255,255,255,.22);border-radius:999px;font-weight:700;cursor:pointer;",
            "min-height:44px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;",
            "box-shadow:0 4px 14px rgba(0,0,0,.4);-webkit-tap-highlight-color:transparent;}"
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
        // Corner buttons last. Fullscreen is LAST: tapping it toggles fullscreen and ENDS
        // the walkthrough, so a later fullscreen-exit has no remaining step to cancel.
        { id: "settings", kind: "point", target: "settings", title: "Settings", sub: "tap the gear" },
        { id: "emoji", kind: "point", target: "emoji", title: "Emotes", sub: "tap the button" },
        { id: "fullscreen", kind: "point", target: "fullscreen", title: "Fullscreen", sub: "tap the button" }
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

        // Parent the control art INTO the fullscreen target (#gameWindow) so the overlay
        // renders in the fullscreen top layer. The control art (root, z-30) and the
        // walkthrough (its own z-3100 layer, above the corner buttons) are SIBLINGS — the
        // walkthrough must not nest under root's z-30 stacking context or it'd hide behind
        // the gear (buildWalkthrough parents it into the same host).
        var host = document.getElementById("gameWindow") || document.body;
        host.appendChild(root);

        // First-run walkthrough. localStorage is the GUEST store only; a signed-in player is
        // decided by the server account flag (delivered via progressionUpdate). DEFER the build
        // for them until that flag arrives — this avoids leaking a shared-device guest's
        // localStorage onto a different account AND avoids flashing the walkthrough on every
        // load before the flag is known. Force-show (?walkthrough=1 / dev) always builds.
        if (forceShowWalkthrough()) {
            buildWalkthrough();
        } else if (isWalkthroughSignedIn() || inDiscordActivity()) {
            // Signed-in, OR in a Discord Activity where the auth token bridge is still settling
            // (isSignedIn can read false for a beat) — either way the account flag is the
            // authority, so DEFER rather than risk the guest branch flashing the overlay before
            // auth lands.
            var acctState = window.__walkthroughAccountState; // "seen" | "unseen" | undefined
            if (acctState === "unseen") { buildWalkthrough(); }
            else if (acctState !== "seen") {
                walkDeferred = true; // the resolve hook builds/suppresses once the flag arrives
                // Safety net: if the account flag never arrives (a dropped progressionUpdate, or a
                // true guest in an Activity whose token never lands), fall back to the GUEST rule
                // after a grace period — build unless this device's localStorage already says seen
                // — so a first-run player still gets the tutorial without re-showing it to someone
                // who finished it here. A late progressionUpdate(seen) self-corrects by dismissing.
                walkFallbackTimer = setTimeout(function () {
                    walkFallbackTimer = null;
                    if (walkDeferred && !walkBuilt && !walkDone && !guestWalkSeen()) { buildWalkthrough(); }
                }, 8000);
            }
        } else if (!guestWalkSeen()) {
            buildWalkthrough();
        }
    }

    function inDiscordActivity() {
        try { return typeof isDiscordActivity === "function" && isDiscordActivity(); } catch (e) { return false; }
    }

    // Build the walkthrough overlay + wire it up, parenting it into the fullscreen host.
    // Eager for guests / force-show; lazy for a signed-in first-run player once
    // progressionUpdate confirms "unseen". Idempotent and a no-op once finished.
    function buildWalkthrough() {
        if (walkBuilt || walkDone) { return; }
        walkBuilt = true;
        if (walkFallbackTimer) { clearTimeout(walkFallbackTimer); walkFallbackTimer = null; }
        // A deferred (signed-in/Activity) build can land while the player is already holding the
        // joystick from lobby movement — require a fresh re-centered gesture before the first
        // 'Move' step counts, so the held direction can't auto-satisfy and skip it. Eager guest /
        // force-show builds happen at load before any gesture, so they start armed.
        dirArmed = !walkDeferred;
        walkSteps = buildSteps();
        walk = document.createElement("div");
        walk.id = WALK_ID;
        walk._ring = el("wt-ring");
        walk._finger = el("wt-finger", "👆");
        walk._arrow = el("wt-arrow");
        walk._bubble = el("bubble");
        walk._skip = document.createElement("button");
        walk._skip.type = "button";
        walk._skip.id = "wtSkipBtn"; // for the button-gate reach allowlist (touch-only control)
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
        // Advance the "point" steps when the player touches the real target button.
        window.addEventListener("touchstart", onWalkTouch, { passive: true });
        var wHost = document.getElementById("gameWindow") || document.body;
        wHost.appendChild(walk);
    }

    // Public hook for the Settings "Replay controls tutorial" button: tear down any
    // current/finished overlay and rebuild it from step 1. An explicit user replay, so it
    // BYPASSES the seen-gating (calls buildWalkthrough directly, not buildDom's gated
    // paths) and is exempt from the race auto-dismiss via walkUserReplay. No-op off touch
    // / before the HUD started. Re-running finishWalk on completion re-persists "seen" —
    // an idempotent latch for a signed-in player, and harmless localStorage for a guest.
    function replayWalkthrough() {
        if (!started || !enabled()) { return; }
        if (walkFallbackTimer) { clearTimeout(walkFallbackTimer); walkFallbackTimer = null; }
        window.removeEventListener("touchstart", onWalkTouch);
        if (walk && walk.parentNode) { walk.parentNode.removeChild(walk); }
        walk = null;
        // Reset every walkthrough flag back to first-run.
        walkBuilt = false; walkDone = false; walkDeferred = false;
        walkIdx = 0; walkPlaced = false;
        walkRenderedIdx = -1; walkRenderedCap = -1;
        advanceLock = false; atkPressStart = 0; atkWasPressed = false;
        dirArmed = true; fsGuardUntil = 0; stepReadyAt = 0;
        walkUserReplay = true;
        buildWalkthrough();
    }
    window.__replayTouchWalkthrough = replayWalkthrough;

    function forceShowWalkthrough() {
        // Dev server (NODE_ENV!=production) injects __DEV_FORCE_WALKTHROUGH__ so it always
        // shows on :3700 for iteration; never set in prod. ?walkthrough=1 also force-shows
        // (handy on a phone, no devtools needed). A force-show is never auto-dismissed by the
        // account flag — a signed-in dev/QA tester can still re-watch it.
        try { if (window.__DEV_FORCE_WALKTHROUGH__) { return true; } } catch (e) { /* ignore */ }
        try {
            if (/[?&]walkthrough=1\b/.test((window.location && window.location.search) || "")) { return true; }
        } catch (e) { /* ignore */ }
        return false;
    }
    function isWalkthroughSignedIn() {
        try {
            return !!(window.chaochaoAuth && typeof window.chaochaoAuth.isSignedIn === "function" &&
                window.chaochaoAuth.isSignedIn());
        } catch (e) { return false; }
    }
    // GUEST-only "seen" flag. Signed-in players are decided by the account flag, never this —
    // localStorage is shared across accounts on a device, so reading it for a signed-in user
    // would leak a prior guest's/user's state onto them.
    function guestWalkSeen() {
        try { return localStorage.getItem(WALK_KEY) === "1"; } catch (e) { return false; }
    }
    // For the "point" steps, advance only when the touch lands ON the actual button
    // (its mapped hit area, with a forgiving pad) — not anywhere on screen. The button's
    // own handler still fires (settings/emoji/fullscreen open/toggle), which is fine.
    function onWalkTouch(e) {
        if (walkDone || !walk || !walkPlaced || advanceLock) return;
        var step = walkSteps[walkIdx];
        if (!step || step.kind !== "point") return;
        var t = e && e.changedTouches && e.changedTouches[0];
        if (!t) return;
        var tr;
        try { tr = targetRect(step.target, mapper()); } catch (err) { tr = null; }
        if (!tr) { advanceStep(); return; } // control vanished — don't trap the player
        var pad = tr.d * 0.45; // generous, but still localized to the button
        if (Math.abs(t.clientX - tr.cx) <= tr.d / 2 + pad && Math.abs(t.clientY - tr.cy) <= tr.d / 2 + pad) {
            advanceStep();
        }
    }
    function advanceStep() {
        if (advanceLock || walkDone) return;
        advanceLock = true;
        atkPressStart = 0; atkWasPressed = false; // reset attack tracking between steps
        setTimeout(function () { advanceLock = false; }, 320); // debounce one gesture -> one step
        walkIdx++;
        walkPlaced = false;                 // new step isn't tap-advanceable until it's placed
        stepReadyAt = Date.now() + STEP_GAP_MS; // brief breather before the next step appears
        if (walkIdx >= walkSteps.length) { finishWalk(); }
    }
    // The active step is "held" — don't render/detect/advance it yet — during the brief
    // inter-step breather, OR while the emoji wheel (#emojiMenu) is open. The emoji step
    // advances on the tap that OPENS the wheel, so without this the next step would pop up
    // on top of the open wheel; wait for the player to close it first.
    function stepHeld() {
        if (Date.now() < stepReadyAt) return true;
        try { if (typeof menuOpen !== "undefined" && menuOpen) return true; } catch (e) { /* ignore */ }
        return false;
    }
    // True once the round is live (countdown or beyond). The walkthrough is a lobby/
    // pre-game teacher; once gameplay starts we tear it down so it can't linger over the
    // race (visually AND as per-frame work). currentState is a numeric stateMap id and
    // config arrives via socket — read both defensively.
    function gameStarted() {
        try {
            if (typeof currentState !== "number" || typeof config === "undefined" || !config || !config.stateMap) return false;
            var gated = config.stateMap.gated;
            if (typeof gated !== "number") return false; // missing key -> don't silently no-op via `>= undefined`
            return currentState >= gated; // gated/racing/collapsing/gameOver
        } catch (e) { return false; }
    }
    // noPersist = tear down WITHOUT recording "seen" anywhere (account or localStorage).
    // Used when the race forces the overlay away but the player never engaged with it, so
    // a brand-new player who loaded into the tail of a lobby still gets taught next time.
    function finishWalk(fromAccount, noPersist) {
        if (walkDone) return;
        walkDone = true;
        walkUserReplay = false;
        if (walkFallbackTimer) { clearTimeout(walkFallbackTimer); walkFallbackTimer = null; }
        window.removeEventListener("touchstart", onWalkTouch);
        if (noPersist) {
            // skip all persistence — fall straight through to the fade-out below
        } else if (isWalkthroughSignedIn()) {
            // Signed-in: persist to the account on a real completion/skip so it follows the player
            // cross-device / into the Activity — but NOT to localStorage (guest-only, so it can't
            // suppress a different account on a shared device). SKIP during a force-show
            // (?walkthrough=1 / dev): a re-watch must not flip a real production account flag.
            // fromAccount = the account flag itself drove this teardown, nothing new to persist.
            try {
                if (!fromAccount && !forceShowWalkthrough() && typeof window.__markTouchWalkthroughSeen === "function") {
                    window.__markTouchWalkthroughSeen();
                }
            } catch (e) { /* ignore */ }
        } else {
            // Guest: localStorage is their only store. Written even on a force-show — matches
            // origin/main (a guest who completes ?walkthrough=1 isn't re-shown on a normal load),
            // and is harmless on the dev :3700 force build (the force flag re-shows regardless).
            try { localStorage.setItem(WALK_KEY, "1"); } catch (e) { /* ignore */ }
        }
        if (walk) {
            walk.classList.add("gone");
            var w = walk;
            setTimeout(function () { if (w && w.parentNode) w.parentNode.removeChild(w); }, 450);
            walk = null;
        }
    }
    // client.js calls this on every progressionUpdate (signed-in only) with the account's
    // walkthroughSeen. seen=true  -> ensure it never shows (tear down a deferred/built overlay,
    // unless a force-show is active). seen=false -> a genuine first-run signed-in player, so
    // build it now if buildDom deferred (and we haven't already shown/finished it). Handles
    // either event order: if progressionUpdate beat buildDom, buildDom reads the cached
    // window.__walkthroughAccountState instead.
    window.__touchHudResolveWalkthrough = function (seen) {
        if (seen) {
            // Don't let a late account-flag(seen) tear down a deliberate replay / force-show
            // the player is actively watching.
            if (!forceShowWalkthrough() && !walkUserReplay) { finishWalk(true); }
        } else if (walkDeferred && !walkBuilt && !walkDone) {
            buildWalkthrough();
        }
    };

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
                // NOTE: the gear (#touchSettingsBtn) is position:fixed, so offsetParent is
                // ALWAYS null even when it's visible — don't gate on it (that silently skipped
                // this whole step). A hidden (display:none) button reports a zero-size rect,
                // which is the reliable visibility test here.
                var g = document.getElementById("touchSettingsBtn");
                if (g) {
                    var r = g.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, d: Math.max(r.width, r.height) + 18 };
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
                if (gameStarted() && !walkUserReplay && !forceShowWalkthrough()) {
                    // Race has begun — fade it out, don't render over gameplay. Only burn the
                    // 'seen' flag if the player actually ENGAGED (advanced past the first step);
                    // someone who loaded into the tail of a lobby and saw it for a frame or two
                    // shouldn't be denied the tutorial forever. A deliberate replay / dev
                    // force-show is exempt (handled above) — they asked to watch it now.
                    finishWalk(false, walkIdx === 0);
                } else if (stepHeld()) {
                    // Inter-step breather, or waiting for the emoji wheel to close — hide the
                    // step visuals (instant, no opacity fade) so nothing flashes over the wheel,
                    // and don't detect/advance. walkPlaced stays false so a stray tap (e.g. on
                    // the open wheel) can't advance the held step.
                    walk.style.visibility = "hidden";
                    walkPlaced = false;
                } else {
                    var step = walkSteps[walkIdx];
                    if (step) {
                        detectStep(step, jm, ab);
                        // detectStep may have ADVANCED walkIdx this frame. `step` is the old
                        // object, but placeStep's label/memo key on the new index — rendering
                        // it now would cache stale text against the new step (showing the
                        // previous step's wording, and masking which gesture is really wanted).
                        // After an advance stepHeld() is true (the breather), so hold instead;
                        // the next render rebuilds the bubble for the correct new step.
                        if (stepHeld()) {
                            walk.style.visibility = "hidden";
                            walkPlaced = false;
                        } else {
                            placeStep(step, jm, ab, m, capFont);
                            walk.style.visibility = "";
                            walkPlaced = true;
                        }
                    }
                }
            }
        } catch (e) { /* never let the HUD break the game */ }
        requestAnimationFrame(frame);
    }

    // Advance the active step when the player performs its gesture.
    function detectStep(step, jm, ab) {
        if (advanceLock || Date.now() < fsGuardUntil) return; // frozen briefly across a fullscreen toggle
        if (step.kind === "dir") {
            if (!jm || !jm.pressed) { dirArmed = true; return; } // released -> armed for a fresh push
            var dx = jm.stickX - jm.baseX, dy = jm.stickY - jm.baseY;
            var thr = (jm.maxPullRadius || jm.baseRadius * 0.5) * 0.5;
            if (!dirArmed) {
                // A deferred build landed on a held stick — wait until it re-centers so the
                // already-held direction can't auto-satisfy (and skip) this teach step.
                if (dx * dx + dy * dy < thr * thr) { dirArmed = true; }
                return;
            }
            var ok = false;
            if (step.dir === "up") ok = dy < -thr && Math.abs(dy) >= Math.abs(dx);
            else if (step.dir === "down") ok = dy > thr && Math.abs(dy) >= Math.abs(dx);
            else if (step.dir === "left") ok = dx < -thr && Math.abs(dx) >= Math.abs(dy);
            else if (step.dir === "right") ok = dx > thr && Math.abs(dx) >= Math.abs(dy);
            if (ok) advanceStep();
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

        // The bubble TEXT and the Skip-button text scale are constant for the life of a
        // step, so rebuild them only when the step index or text scale (capFont, which
        // tracks resize/fullscreen) changes — NOT every frame (the innerHTML reparse was
        // the dominant cost). We also cache the bubble's measured size here so setBubble
        // can clamp without forcing a reflow per frame.
        if (walkIdx !== walkRenderedIdx || capFont !== walkRenderedCap) {
            walkRenderedIdx = walkIdx;
            walkRenderedCap = capFont;
            var stepLabel = "Step " + (walkIdx + 1) + " / " + walkSteps.length;
            bubble.innerHTML = '<span class="step">' + stepLabel + "</span>" + step.title +
                "<small>" + step.sub + "</small>";
            bubble.style.fontSize = capFont + "px";
            walk._skip.style.fontSize = Math.max(12, capFont - 2) + "px";
            walk._skip.style.padding = "6px 14px";
            walk._bw = bubble.offsetWidth || 0;  // measured once per step (one reflow, then cached)
            walk._bh = bubble.offsetHeight || 0;
        }

        // Skip-button POSITION derives from the live canvas rect, which moves on resize/
        // rotation/URL-bar collapse WITHOUT necessarily changing the clamped capFont — so it
        // must update every frame, or the player's only dismiss control can drift off-screen.
        // Top-center, pushed clear of the notch / Discord header via the device safe-area
        // inset (the same env() the page's safe-area vars build on).
        walk._skip.style.left = (m.rect.left + m.rect.width / 2) + "px";
        walk._skip.style.transform = "translateX(-50%)";
        walk._skip.style.top = "calc(" + m.rect.top + "px + env(safe-area-inset-top, 0px) + 6px)";

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
        function setBubble(cx, cy) {
            // The bubble is nowrap + center-anchored (translate(-50%,-50%)), so near an
            // edge (e.g. above the bottom-right attack button) it would run off-screen.
            // Clamp its center so the whole box stays inside the canvas with a margin.
            // Use the cached per-step dims only — never fall back to offsetWidth here, or a
            // step that happened to measure 0 would force a synchronous reflow every frame
            // (the very cost the cache exists to avoid). A 0 dim just skips the clamp below.
            var w = walk._bw || 0, h = walk._bh || 0, margin = 8;
            var minX = m.rect.left + margin + w / 2, maxX = m.rect.right - margin - w / 2;
            var minY = m.rect.top + margin + h / 2, maxY = m.rect.bottom - margin - h / 2;
            if (minX <= maxX) cx = Math.max(minX, Math.min(maxX, cx));
            if (minY <= maxY) cy = Math.max(minY, Math.min(maxY, cy));
            bubble.style.left = cx + "px"; bubble.style.top = cy + "px";
        }

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
            if (!tr) {
                // Control not on screen — skip it, but NOT during the brief post-
                // fullscreen-toggle window (the button is mid-relayout, not really gone).
                if (Date.now() >= fsGuardUntil) { advanceStep(); }
                return;
            }
            setRing(tr.cx, tr.cy, tr.d);
            hideArrow();
            setFinger(tr.cx, tr.cy, Math.round(tr.d * 0.34));
            // Bubble in a CLEAR central spot — the corners are crowded (the fullscreen
            // button and the settings gear stack in the top-right), so anchoring the
            // bubble on the button would clip its neighbor. The ring + finger mark the
            // actual button; the text sits in the open upper-middle. Keep it clear of the
            // top-center Skip button: in landscape the 32%-height anchor collides with it,
            // and Skip's exact bottom depends on the env() safe-area inset (unknown to JS),
            // so MEASURE Skip and drop the bubble below it when needed.
            var pointBubbleY = m.rect.top + m.rect.height * 0.32;
            try {
                var sr = walk._skip.getBoundingClientRect();
                if (sr && sr.bottom) {
                    pointBubbleY = Math.max(pointBubbleY, sr.bottom + 14 + (walk._bh || 0) / 2);
                }
            } catch (e) { /* ignore — fall back to the 32% anchor */ }
            setBubble(m.rect.left + m.rect.width / 2, pointBubbleY);
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
        // Freeze walkthrough detection briefly across a fullscreen toggle (resize + touch
        // release) so entering/EXITING fullscreen can't cancel/skip the active step.
        function onFsChange() { fsGuardUntil = Date.now() + 700; }
        document.addEventListener("fullscreenchange", onFsChange, false);
        document.addEventListener("webkitfullscreenchange", onFsChange, false);
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
