'use strict';

// Shared headless-test primitives: a mocked clock with a scheduled-timeout queue and a
// seedable PRNG. A tight synchronous tick loop freezes wall-clock, so AI time-based logic
// (re-path throttles, anti-stuck timers) and setTimeout callbacks (cooldowns, fuses) never
// fire unless Date.now is mocked and the clock is advanced per tick — see the
// headless-test-harness notes. Install the clock BEFORE requiring the game modules when the
// whole script needs it (ai-fitness drives a full window); a script that only needs it for a
// single late scenario can install it just before that scenario, since game code reads
// Date.now()/setTimeout dynamically at call time.
//
// installMockClock(startMs) overrides global Date.now/setTimeout/clearTimeout and returns a
// tickClock(ms) that advances sim time and drains every timeout whose deadline has passed.
function installMockClock(startMs) {
    var simNow = (startMs != null) ? startMs : 1e6;
    var pend = [];
    Date.now = function () { return simNow; };
    global.setTimeout = function (fn, d) {
        var a = Array.prototype.slice.call(arguments, 2);
        pend.push({ at: simNow + (d || 0), fn: fn, a: a });
        return pend.length;
    };
    global.clearTimeout = function () { };
    return function tickClock(ms) {
        simNow += ms;
        pend.sort(function (a, b) { return a.at - b.at; });
        while (pend.length && pend[0].at <= simNow) {
            var t = pend.shift();
            try { t.fn.apply(null, t.a); } catch (e) { /* match production: a thrown timeout never aborts the tick */ }
        }
    };
}

// Deterministic 32-bit PRNG (mulberry32) — assign to Math.random for a reproducible run.
function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

module.exports = { installMockClock: installMockClock, mulberry32: mulberry32 };
