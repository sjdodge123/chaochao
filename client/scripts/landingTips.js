// Minecraft-style "splash" tip line on the landing page. One tip at a time,
// fades to the next on a timer. Tips are intentionally a mix of practical
// hints and a little flavour — the practical ones lower the activation cost
// for a new player; the funny ones make the page feel alive.
//
// Stays cheap: no per-tip DOM, just swaps textContent inside an existing span
// while a CSS opacity transition runs. Pauses on tab hide (both the JS
// interval and the CSS bobble animation); advances on click or Enter/Space.
(function () {
    "use strict";
    var el = document.getElementById("tipBanner");
    var text = document.getElementById("tipText");
    if (!el || !text) { return; }

    // KEEP IN SYNC: matches the `.tip-banner` `transition: opacity 0.22s` rule
    // in styles.css — the fade-out must complete before the swap so the tip
    // change is invisible.
    var FADE_MS = 220;

    var TIPS = [
        "Try playing with a controller!",
        "Lava burns.",
        "Hold the punch button to charge a heavier hit.",
        "Punch your friends off the map.",
        "Bumpers send you flying — aim them at someone.",
        "Ice is slippery. Brake before the turn.",
        "Tiles can be swapped — keep moving!",
        "Bombs bounce. Plan accordingly.",
        "Up to 4 players on one screen with controllers.",
        "Last one standing scores the round.",
        "Stuck in lava? You may come back as a zombie.",
        "Make your own map in the Create tab.",
        "Some abilities are noisy — listen for them.",
        "Bots fill in when a lobby is short.",
        "Watch the edges. The arena gets smaller.",
        "Patience beats panic. Slow is fast here.",
        "The blue tile is fast. The grey tile is slow.",
        "If someone punches you, punch them back harder.",
        "You can spectate a match in progress from Join.",
        "Press Start to open Settings on a controller."
    ];

    // Stable shuffle so a refresh doesn't replay the same opener, but a player
    // who sticks around still sees every tip before any repeat.
    function shuffle(arr) {
        var a = arr.slice();
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
        }
        return a;
    }
    var queue = shuffle(TIPS);
    var idx = 0;

    // Pending fade-swap timer. Tracked so a rapid second click cancels its
    // predecessor instead of letting both fire — overlapping timers would
    // swap textContent mid-fade and flicker.
    var swapTimer = null;
    function show(tip) {
        // Fade out, swap, fade in. The CSS transition is on `.is-fading`.
        if (swapTimer) { clearTimeout(swapTimer); }
        el.classList.add("is-fading");
        swapTimer = setTimeout(function () {
            text.textContent = tip;
            el.classList.remove("is-fading");
            swapTimer = null;
        }, FADE_MS);
    }

    function next() {
        idx = (idx + 1) % queue.length;
        if (idx === 0) { queue = shuffle(TIPS); }
        show(queue[idx]);
    }

    // First tip: no fade in (just set it) so the page doesn't blink on load.
    text.textContent = queue[0];

    var rotateMs = 9000;
    var timer = null;
    function start() {
        if (timer) { return; }
        timer = setInterval(next, rotateMs);
        // Resume the CSS bobble. Paired with `stop()`, this keeps the
        // compositor idle while the tab is hidden.
        el.style.animationPlayState = "running";
    }
    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        el.style.animationPlayState = "paused";
    }
    start();

    function advance() {
        stop();
        next();
        start();
        if (typeof window.trackEvent === "function") {
            window.trackEvent("tip_click", { idx: idx });
        }
    }

    // Click/tap or Enter/Space = jump to the next tip and reset the timer (so
    // the player isn't left staring at the same line for another 9s after they
    // asked for more). The element is role="button" + tabindex="0" so keyboard
    // and controller (data-gp-nav → menuGamepad) users reach it too.
    el.addEventListener("click", advance);
    el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            e.preventDefault();
            advance();
        }
    });

    document.addEventListener("visibilitychange", function () {
        if (document.hidden) { stop(); } else { start(); }
    });
})();
