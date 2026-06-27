"use strict";

// ============================================================================
// Headless test for the mobile touch WALKTHROUGH overlay (client/scripts/hudOverlay.js).
// ----------------------------------------------------------------------------
// hudOverlay.js is a DOM/requestAnimationFrame IIFE gated on isTouchScreen, so the
// server-only smoke-test can't reach it. This harness stands up a *minimal* fake DOM +
// window + a step-able requestAnimationFrame, loads the real hudOverlay module against
// them, and drives its public hooks to assert the decision logic we care about:
//
//   1. First-run gating: a guest builds the overlay (and stays suppressed once "seen");
//      a signed-in player DEFERS until the account flag arrives (resolve(false) builds,
//      resolve(true) tears down).
//   2. Auto-dismiss on race start: once currentState >= config.stateMap.gated the overlay
//      fades/removes — and only persists "seen" if the player ENGAGED (advanced a step).
//   3. Perf: placeStep rebuilds bubble innerHTML only ONCE across frames on the same step,
//      while the Skip button repositions EVERY frame (the rotate/resize regression fix).
//   4. Replay: __replayTouchWalkthrough rebuilds from step 1 even after the overlay
//      finished, and is exempt from both the race auto-dismiss and a late resolve(true).
//
// Pure visual/touch/timing behaviour (fade feel, real rotation, FPS, the Settings UI row)
// is NOT covered here — that needs a real device. This locks down the logic.
//
// No test framework / no new dependency: hand-rolled stubs, asserts count failures, and
// a non-zero exit on any failure (so it can gate in pr-validation.yml like the other
// *-test.js harnesses).
// ============================================================================

var path = require("path");

var HUD_PATH = path.join(__dirname, "..", "..", "client", "scripts", "hudOverlay.js");
var WALK_ID = "touch-walk-layer";
var WALK_KEY = "touchWalkthroughSeen";
var STATE = { waiting: 0, lobby: 1, overview: 2, gated: 3, racing: 4, collapsing: 5, gameOver: 6 };

var failures = 0;
function assert(cond, msg) {
    if (!cond) { failures++; console.log("  ✗ " + msg); }
    else { console.log("  ✓ " + msg); }
}

// ---- Minimal DOM node ------------------------------------------------------
function makeNode(tag) {
    var node = {
        tagName: tag, id: "", type: "", textContent: "",
        children: [], parentNode: null,
        style: {}, _listeners: {},
        offsetWidth: 120, offsetHeight: 40,
        _rect: null,
        _innerHTML: "", innerHTMLWrites: 0,
        _classSet: {}
    };
    node.classList = {
        add: function (c) { node._classSet[c] = true; },
        remove: function (c) { delete node._classSet[c]; },
        contains: function (c) { return !!node._classSet[c]; },
        toggle: function (c, f) { if (f === undefined) f = !node._classSet[c]; if (f) node._classSet[c] = true; else delete node._classSet[c]; }
    };
    node.appendChild = function (c) { c.parentNode = node; node.children.push(c); return c; };
    node.removeChild = function (c) { var i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; };
    node.addEventListener = function (t, fn) { (node._listeners[t] = node._listeners[t] || []).push(fn); };
    node.removeEventListener = function (t, fn) { var a = node._listeners[t]; if (a) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } };
    node.getBoundingClientRect = function () { return node._rect || { left: 0, top: 0, width: 360, height: 640, right: 360, bottom: 640 }; };
    node.querySelector = function () { return null; };
    node.querySelectorAll = function () { return []; };
    node.setAttribute = function () {};
    Object.defineProperty(node, "className", {
        get: function () { return Object.keys(node._classSet).join(" "); },
        set: function (v) { node._classSet = {}; String(v || "").split(/\s+/).forEach(function (c) { if (c) node._classSet[c] = true; }); }
    });
    Object.defineProperty(node, "innerHTML", {
        get: function () { return node._innerHTML; },
        set: function (v) { node._innerHTML = v; node.innerHTMLWrites++; }
    });
    return node;
}

// ---- Build a fresh environment + load a fresh hudOverlay instance ----------
function setup(opts) {
    opts = opts || {};
    var allNodes = [];
    function track(n) { allNodes.push(n); return n; }

    var hostRect = { left: 0, top: 0, width: 360, height: 640, right: 360, bottom: 640 };
    var canvas = track(makeNode("canvas")); canvas._rect = hostRect;
    var host = track(makeNode("div")); host.id = "gameWindow";

    var document = {
        readyState: "complete",
        head: makeNode("head"),
        body: makeNode("body"),
        createElement: function (tag) { return track(makeNode(tag)); },
        getElementById: function (id) {
            for (var i = allNodes.length - 1; i >= 0; i--) { if (allNodes[i].id === id && allNodes[i].parentNode !== null) return allNodes[i]; }
            if (id === "gameWindow") return host;
            return null;
        },
        addEventListener: function () {}
    };

    var store = {};
    if (opts.seedStore) { Object.keys(opts.seedStore).forEach(function (k) { store[k] = opts.seedStore[k]; }); }
    var localStorage = {
        getItem: function (k) { return (k in store) ? store[k] : null; },
        setItem: function (k, v) { store[k] = String(v); },
        removeItem: function (k) { delete store[k]; }
    };

    var winListeners = {};
    var window = {
        location: { search: opts.search || "" },
        addEventListener: function (t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
        removeEventListener: function (t, fn) { var a = winListeners[t]; if (a) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
        chaochaoAuth: opts.signedIn ? { available: true, isSignedIn: function () { return true; } } : null,
        __walkthroughAccountState: opts.acctState
    };

    var rafCb = null;
    var timers = [];

    // Install globals BEFORE require (the IIFE runs + polls on load).
    var g = global;
    var saved = {};
    var globals = {
        window: window, document: document, localStorage: localStorage,
        isTouchScreen: opts.touch === false ? false : true,
        gameCanvas: canvas, LOGICAL_WIDTH: 360, LOGICAL_HEIGHT: 640, fitRatio: 1,
        joystickMovement: null, attackButton: null,
        config: { stateMap: STATE }, currentState: (opts.state == null ? STATE.waiting : opts.state),
        chatButton: null, exitButton: null,
        fullscreenSupported: function () { return true; },
        isDiscordActivity: function () { return false; },
        requestAnimationFrame: function (fn) { rafCb = fn; return 1; },
        setTimeout: function (fn, delay) { var t = { fn: fn, delay: delay }; timers.push(t); return t; },
        clearTimeout: function (t) { var i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
    };
    Object.keys(globals).forEach(function (k) { saved[k] = g[k]; g[k] = globals[k]; });

    delete require.cache[require.resolve(HUD_PATH)];
    require(HUD_PATH);

    var api = {
        window: window, store: store, canvas: canvas, host: host,
        setState: function (s) { g.currentState = s; },
        setInput: function (jm, ab) { g.joystickMovement = jm; g.attackButton = ab; },
        setRect: function (r) { canvas._rect = r; },
        step: function () { var c = rafCb; rafCb = null; if (c) c(); },
        flush: function () { var p = timers.splice(0); p.forEach(function (t) { try { t.fn(); } catch (e) {} }); },
        walk: function () { for (var i = allNodes.length - 1; i >= 0; i--) { if (allNodes[i].id === WALK_ID) return allNodes[i]; } return null; },
        attached: function () { var w = api.walk(); return !!(w && w.parentNode !== null); },
        bubble: function () { var w = api.walk(); if (!w) return null; for (var i = 0; i < w.children.length; i++) { if (w.children[i]._classSet.bubble) return w.children[i]; } return null; },
        skip: function () { var w = api.walk(); if (!w) return null; for (var i = 0; i < w.children.length; i++) { if (w.children[i]._classSet["wt-skip"]) return w.children[i]; } return null; },
        teardown: function () { Object.keys(globals).forEach(function (k) { g[k] = saved[k]; }); }
    };
    return api;
}

// A joystick pushed firmly "up" (dy below -threshold) to advance the first dir step.
function stickUp() {
    return { pressed: true, baseX: 100, baseY: 400, stickX: 100, stickY: 360,
        baseRadius: 50, stickRadius: 25, maxPullRadius: 50 };
}

// ---------------------------------------------------------------------------
console.log("Walkthrough overlay test\n");

// Group 1 — first-run gating
(function () {
    console.log("1) first-run gating (guest vs signed-in account flag)");

    var guest = setup({});
    assert(guest.attached(), "guest with no localStorage flag builds the overlay");
    guest.teardown();

    var seen = setup({ seedStore: { touchWalkthroughSeen: "1" } });
    assert(!seen.attached(), "guest with localStorage 'seen' does NOT rebuild");
    seen.teardown();

    var signed = setup({ signedIn: true });
    assert(!signed.attached(), "signed-in player DEFERS the build until the account flag arrives");
    signed.window.__touchHudResolveWalkthrough(false);
    assert(signed.attached(), "resolve(false) [genuine first-run] builds the overlay");
    signed.teardown();

    var signed2 = setup({ signedIn: true });
    signed2.window.__touchHudResolveWalkthrough(false);
    signed2.window.__touchHudResolveWalkthrough(true);
    signed2.flush();
    assert(!signed2.attached(), "a later resolve(true) tears the overlay down");
    signed2.teardown();
})();

// Group 2 — auto-dismiss on race start + persistence gating
(function () {
    console.log("\n2) auto-dismiss when the round starts");

    var a = setup({ state: STATE.waiting });
    a.step();
    assert(a.attached(), "overlay renders during 'waiting'");
    a.setState(STATE.racing);
    a.step(); a.flush();
    assert(!a.attached(), "overlay is torn down once state reaches 'racing'");
    assert(a.store[WALK_KEY] !== "1", "un-engaged dismissal does NOT persist 'seen' (guest)");
    a.teardown();

    var b = setup({ state: STATE.waiting });
    b.setInput(stickUp(), null);
    b.step(); // detectStep advances the first 'up' dir step -> walkIdx = 1
    var bubble = b.bubble();
    assert(bubble && /Step 2 \//.test(bubble.innerHTML), "performing the gesture advances to step 2");
    b.setInput(null, null);
    b.setState(STATE.racing);
    b.step(); b.flush();
    assert(!b.attached(), "overlay dismisses on race start after engagement too");
    assert(b.store[WALK_KEY] === "1", "ENGAGED dismissal DOES persist 'seen' (guest)");
    b.teardown();

    var c = setup({ state: STATE.gated });
    c.step(); c.flush();
    assert(!c.attached(), "the 'gated' countdown also dismisses (>= stateMap.gated)");
    c.teardown();
})();

// Group 3 — perf memoization + per-frame Skip reposition
(function () {
    console.log("\n3) perf: memoized bubble vs per-frame Skip position");

    var p = setup({ state: STATE.waiting });
    p.step();
    var bubble = p.bubble();
    var afterFirst = bubble.innerHTMLWrites;
    p.step(); p.step(); p.step();
    assert(bubble.innerHTMLWrites === afterFirst, "bubble innerHTML is written ONCE across 4 same-step frames");

    var skip = p.skip();
    var leftA = skip.style.left;
    // Move the canvas (rotate/URL-bar) WITHOUT changing fitRatio (so capFont is unchanged).
    p.setRect({ left: 120, top: 0, width: 360, height: 640, right: 480, bottom: 640 });
    p.step();
    var leftB = skip.style.left;
    assert(leftA !== leftB, "Skip button repositions every frame when the canvas rect moves");
    p.teardown();
})();

// Group 4 — replay
(function () {
    console.log("\n4) replay from Settings");

    var r = setup({ state: STATE.waiting });
    r.setState(STATE.racing);
    r.step(); r.flush();
    assert(!r.attached(), "overlay finished first (race auto-dismiss)");
    r.window.__replayTouchWalkthrough();
    assert(r.attached(), "replay rebuilds the overlay after it had finished");
    r.step(); // still racing — a normal first-run would dismiss; a replay must NOT (and this paints the bubble)
    assert(r.attached(), "a deliberate replay is exempt from the race auto-dismiss");
    var bub = r.bubble();
    assert(bub && /Step 1 \//.test(bub.innerHTML), "replay restarts from step 1");
    r.window.__touchHudResolveWalkthrough(true);
    assert(r.attached(), "a late resolve(true) does not tear down an active replay");
    r.teardown();
})();

console.log("");
if (failures > 0) {
    console.log("Walkthrough overlay test FAILED (" + failures + " assertion(s)).");
    process.exit(1);
}
console.log("Walkthrough overlay test passed.");
