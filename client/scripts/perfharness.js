// On-device render-performance harness (dev-only). Ports the desktop live-perf
// sweep methodology (autonomous in-page rAF sampler + bot driver + gated windows)
// so render FPS per cosmetic id / perf tier can be measured on a REAL device
// (iPad / Android) with zero operator involvement beyond opening the URL.
//
// Activation requires BOTH:
//   1. ?perfharness=1 in the page URL, and
//   2. config.perfHarness === true from the server (set only when the server was
//      started with PERF_HARNESS=1 — see server/utils.js), so this can never run
//      against prod even though the script ships in the bundle.
//
// What it does once active:
//   - Driver (150ms): in lobby, requests 8 bots (setLobbyAI) and steers onto the
//     start button with a wander-escape when wedged; in rounds it jiggles (defeats
//     the AFK kick; bots do the racing) and, if a round drags past 90s (wedged
//     bots — no global round failsafe exists), drives itself to the goal to force
//     the next round.
//   - Sampler (own rAF chain): walks a queue of scenarios (baseline / hot-spot
//     cosmetic ids / worst-combo / random unknowns, per perf tier), forcing the
//     scenario's cosmetics onto every kart EVERY frame, and records mean FPS +
//     worst single frame ms per window. Every window is gated at start AND end
//     (tab visible, state in {gated,racing,collapsing}, 9 karts alive, ice on
//     the map, pinned tier label in effect) and auto-requeued when a gate fails,
//     so samples stay comparable.
//   - Keep-awake: a muted inline looping <video> started on the first touch
//     (NoSleep technique — the Screen Wake Lock API needs a secure context,
//     which a plain-http LAN URL is not), plus the real Wake Lock API when
//     available. Backgrounding/screen-off still poisons windows; the gates
//     catch it and requeue.
//   - Reporting: POSTs one JSON row per completed/skipped sample plus a final
//     summary to /__perf/report (dev-only sink in index.js, written as JSONL).
//   - Resume: completed scenario labels persist in localStorage, so a reload
//     (e.g. a serverKick redirect) re-installs and skips finished work.
(function () {
    "use strict";

    var urlOn = false;
    try { urlOn = /[?&]perfharness=1\b/.test(window.location.search || ""); } catch (e) { /* no location */ }
    if (!urlOn) { return; }

    var PH_VERSION = "ph1";
    var REPORT_URL = "/__perf/report";
    var STORAGE_KEY = "perfHarnessState";
    var SLOT_KEYS = ["cart", "pattern", "trailFx", "border"];
    var SETTLE_MS = 350;
    var SAMPLE_MS = 1700;
    var BASELINE_MS = 3000;
    var MAX_ATTEMPTS = 8;
    // ~10s 2x2 black h264 mp4 (~1.8KB). Muted+playsinline+loop video playback is
    // what keeps iOS Safari / Android Chrome from sleeping the screen over http.
    var WAKE_VIDEO = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOzbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAJxAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAt10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAJxAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAACcQAACAAAABAAAAAAJVbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAACgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACAG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAcBzdGJsAAAAwHN0c2QAAAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANmF2Y0MBZAAK/+EAGWdkAAqs2V+IiMBEAAADAAQAAAMACDxIllgBAAZo6+PLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAApgAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAoAAEAAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAABgY3R0cwAAAAAAAAAKAAAAAQAAgAAAAAABAAFAAAAAAAEAAIAAAAAAAQAAAAAAAAABAABAAAAAAAEAAUAAAAAAAQAAgAAAAAABAAAAAAAAAAEAAEAAAAAAAQAAgAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAoAAAABAAAAPHN0c3oAAAAAAAAAAAAAAAoAAALFAAAADAAAAAwAAAAMAAAADAAAABIAAAAOAAAADAAAAAwAAAASAAAAFHN0Y28AAAAAAAAAAQAAA+MAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMQAAAAhmcmVlAAADR21kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABBliIQAF//+99S3zLLuByOBAAAACEGaJGxBf/7wAAAACEGeQniC34yBAAAACAGeYXRBX5KAAAAACAGeY2pBX5KBAAAADkGaaEmoQWiZTAgt//7xAAAACkGehkURLBb/jIEAAAAIAZ6ldEFfkoEAAAAIAZ6nakFfkoAAAAAOQZqpSahBbJlMCCv//vA=";

    // The pre-fix collapse drivers / shadow-and-filter-heavy ids from the desktop
    // rounds — all passed on desktop post-PR#259; the device sweep confirms the
    // fixes hold on mobile GPUs at the tier Auto actually picks.
    var HOT = {
        cart: ["pizza", "golden_champion", "wheel_of_fortune", "firetruck", "compass", "coin", "dartboard", "clock"],
        pattern: ["nebula"],
        trailFx: ["comet", "founders_flare", "bolt", "aurora", "neon", "ripple", "guardian"],
        border: ["border_runes"]
    };
    var WORST_COMBO = { cart: "warlord", pattern: "nebula", trailFx: "comet", border: "border_runes" };
    // Shorter confirmation list for the non-optimal pinned tiers.
    var SUBSET = [
        ["cart", "pizza"], ["cart", "golden_champion"],
        ["trailFx", "comet"], ["trailFx", "founders_flare"], ["trailFx", "aurora"],
        ["pattern", "nebula"], ["border", "border_runes"]
    ];

    var hudEl = null, queue = [], results = [], doneSet = {}, glCalls = 0;
    var device = null, optTier = null, originalPref = null, finished = false;
    var drv = { lastPos: null, stuckMs: 0, wanderUntil: 0, wanderMv: null, lastLobbyCfg: 0, lastState: null, stateSince: 0 };
    var S = { phase: "next", item: null, expectedLabel: null, t0: 0, frames: 0, sum: 0, worst: 0, gl0: 0, gate0: null, lastTs: 0, idx: 0 };

    // ---------- utilities ----------

    function report(row) {
        row.t = Date.now();
        row.v = PH_VERSION;
        try {
            fetch(REPORT_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(row),
                keepalive: true
            }).catch(function () { /* dev sink unreachable — rows also live in `results` */ });
        } catch (e) { /* fetch unavailable */ }
    }

    function hud(msg) {
        if (!hudEl && document.body) {
            hudEl = document.createElement("div");
            hudEl.id = "perfHarnessHud";
            hudEl.style.cssText = "position:fixed;bottom:6px;left:6px;z-index:99999;" +
                "font:bold 11px monospace;background:rgba(0,0,0,.7);color:#7df;" +
                "padding:4px 7px;border-radius:4px;pointer-events:none;white-space:pre;max-width:92vw;";
            document.body.appendChild(hudEl);
        }
        if (hudEl) { hudEl.textContent = msg; }
    }

    // Deterministic PRNG so the "random unknowns" picks are reproducible run-to-run.
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            var t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                v: PH_VERSION, optTier: optTier, originalPref: originalPref, done: doneSet
            }));
        } catch (e) { /* storage disabled */ }
    }

    function loadState() {
        try {
            var s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
            return (s && s.v === PH_VERSION) ? s : null;
        } catch (e) { return null; }
    }

    // ---------- queue construction ----------

    function ovFor(slot, id) {
        var ov = { cart: null, pattern: null, trailFx: null, border: null };
        ov[slot] = id;
        return ov;
    }

    function item(label, tier, ov, dur, gate) {
        return { label: label, tier: tier, ov: ov, dur: dur || SAMPLE_MS, gate: gate || "race", attempts: 0 };
    }

    function buildQueue(tier) {
        var q = [], rand = mulberry32(1337), nBase = 0;
        function baseline(t) { q.push(item(t + "|__none__#" + (++nBase), t, { cart: null, pattern: null, trailFx: null, border: null }, BASELINE_MS)); }

        // Display-cap probe: visible-only gate so it completes immediately (in the
        // lobby), calibrating the device's rAF ceiling before any gated work.
        q.push(item("cap_probe", null, "server", BASELINE_MS, "visible"));

        // Phase 1 — full hot-spot list on the device's OPTIMAL (Auto-resolved) tier.
        baseline(tier);
        var n = 0;
        SLOT_KEYS.forEach(function (slot) {
            (HOT[slot] || []).forEach(function (id) {
                q.push(item(tier + "|" + slot + ":" + id, tier, ovFor(slot, id)));
                if (++n % 5 === 0) { baseline(tier); }
            });
        });
        q.push(item(tier + "|combo:worst", tier, WORST_COMBO));
        q.push(item(tier + "|random_mix", tier, "server"));
        baseline(tier);

        // Phase 2 — confirmation subset on the other pinned tiers.
        ["high", "balanced", "low"].forEach(function (t) {
            if (t === tier) { return; }
            baseline(t);
            SUBSET.forEach(function (s) {
                q.push(item(t + "|" + s[0] + ":" + s[1], t, ovFor(s[0], s[1])));
            });
            q.push(item(t + "|combo:worst", t, WORST_COMBO));
        });

        // Phase 3 — random unknowns on the optimal tier (device-specific surprises
        // the desktop rounds couldn't catch), seeded so reruns pick the same ids.
        baseline(tier);
        var m = 0;
        SLOT_KEYS.forEach(function (slot) {
            var pool = SKINS.filter(function (s) {
                var sslot = (s.slot === "trail") ? "trailFx" : s.slot;
                return sslot === slot && (HOT[slot] || []).indexOf(s.id) === -1 && s.id !== WORST_COMBO[slot];
            }).map(function (s) { return s.id; });
            for (var i = pool.length - 1; i > 0; i--) {
                var j = Math.floor(rand() * (i + 1)), tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
            }
            pool.slice(0, 4).forEach(function (id) {
                q.push(item(tier + "|rnd|" + slot + ":" + id, tier, ovFor(slot, id)));
                if (++m % 5 === 0) { baseline(tier); }
            });
        });
        for (var k = 0; k < 2; k++) {
            var combo = {};
            SLOT_KEYS.forEach(function (slot) {
                var pool = SKINS.filter(function (s) { return ((s.slot === "trail") ? "trailFx" : s.slot) === slot; });
                combo[slot] = pool[Math.floor(rand() * pool.length)].id;
            });
            q.push(item(tier + "|rnd|combo#" + (k + 1), tier, combo));
        }
        baseline(tier);
        return q;
    }

    // ---------- cosmetic override ----------

    // Force the current scenario's cosmetics onto every kart every frame — beats
    // any server packet reset, and only REAL playerList karts hit the ice-reflection
    // path (synthetic karts lie; desktop round 1 lesson). The first value seen per
    // slot (and any later server-side rewrite, detected as "differs from what we
    // last forced") is remembered in __phOrig so the random-mix scenario can hand
    // the kart back to its server-assigned (dev-patch random) outfit.
    function applyOverride(it) {
        if (!it || !it.ov || typeof playerList !== "object" || !playerList) { return; }
        var serverMode = (it.ov === "server");
        for (var id in playerList) {
            var p = playerList[id];
            if (!p || typeof p !== "object") { continue; }
            if (!p.__phOrig) {
                p.__phOrig = {};
                for (var i = 0; i < SLOT_KEYS.length; i++) { p.__phOrig[SLOT_KEYS[i]] = p[SLOT_KEYS[i]]; }
            }
            if (serverMode) { continue; }
            if (!p.__phForced) { p.__phForced = {}; }
            for (var j = 0; j < SLOT_KEYS.length; j++) {
                var k = SLOT_KEYS[j];
                var want = (it.ov[k] !== undefined) ? it.ov[k] : null;
                if (p[k] !== want) {
                    if (p.__phForced[k] !== undefined && p[k] !== p.__phForced[k]) {
                        p.__phOrig[k] = p[k]; // a server packet rewrote it since our last force
                    }
                    p[k] = want;
                }
                p.__phForced[k] = want;
            }
        }
    }

    function restoreServerCosmetics() {
        if (typeof playerList !== "object" || !playerList) { return; }
        for (var id in playerList) {
            var p = playerList[id];
            if (p && p.__phOrig) {
                for (var i = 0; i < SLOT_KEYS.length; i++) { p[SLOT_KEYS[i]] = p.__phOrig[SLOT_KEYS[i]]; }
                p.__phForced = null;
            }
        }
    }

    // ---------- gating ----------

    function gateSnapshot() {
        var alive = 0, karts = 0;
        if (typeof playerList === "object" && playerList) {
            for (var id in playerList) {
                if (!playerList[id]) { continue; }
                karts++;
                if (playerList[id].alive !== false) { alive++; }
            }
        }
        return {
            vis: (typeof document !== "undefined") ? document.visibilityState === "visible" : true,
            state: (typeof currentState === "number") ? currentState : -1,
            alive: alive,
            karts: karts,
            ice: (typeof terrainFX === "object" && terrainFX && terrainFX.ice) ? terrainFX.ice.length : 0,
            label: (typeof perfProfileLabel === "function") ? perfProfileLabel() : ""
        };
    }

    function gateFail(g, it, expectedLabel) {
        if (!g.vis) { return "hidden"; }
        if (it.gate === "visible") { return null; }
        var SM = config.stateMap;
        if (g.state !== SM.gated && g.state !== SM.racing && g.state !== SM.collapsing) { return "state:" + g.state; }
        if (g.alive !== 9) { return "alive:" + g.alive; }
        if (g.ice < 1) { return "no-ice"; }
        if (expectedLabel && g.label !== expectedLabel) { return "label:" + g.label; }
        return null;
    }

    // ---------- sampler ----------

    function nextItem() {
        while (S.idx < queue.length && doneSet[queue[S.idx].label]) { S.idx++; }
        if (S.idx >= queue.length) { finish(); return; }
        S.item = queue[S.idx];
        if (S.item.tier && typeof getPerfPref === "function" && getPerfPref() !== S.item.tier) {
            setPerfPref(S.item.tier);
            applyPerfProfile();
        }
        if (S.item.ov === "server") { restoreServerCosmetics(); }
        S.expectedLabel = S.item.tier ? PERF_LABEL[S.item.tier] : null;
        S.phase = "settle";
        S.t0 = 0;
        S.waitMs = 0;
    }

    function requeue(reason) {
        var it = S.item;
        it.attempts++;
        if (it.attempts >= MAX_ATTEMPTS) {
            doneSet[it.label] = 1;
            saveState();
            report({ kind: "skip", label: it.label, tier: it.tier, reason: reason, attempts: it.attempts, idx: S.idx, total: queue.length });
            results.push({ label: it.label, skipped: reason });
        } else {
            queue.push(it); // retry later (likely a different round); keep the sweep moving now
        }
        S.idx++;
        S.phase = "next";
    }

    function completeItem(g1) {
        var it = S.item;
        var fps = (S.sum > 0) ? 1000 * S.frames / S.sum : 0;
        var row = {
            kind: "sample", label: it.label, tier: it.tier,
            tierLabel: g1.label, fps: Math.round(fps * 10) / 10,
            worstMs: Math.round(S.worst * 10) / 10, frames: S.frames,
            durMs: Math.round(S.sum), state0: S.gate0.state, state1: g1.state,
            alive: g1.alive, ice: g1.ice,
            gl: (S.frames > 0) ? Math.round((glCalls - S.gl0) / S.frames * 100) / 100 : 0,
            attempt: it.attempts, idx: S.idx, total: queue.length
        };
        report(row);
        results.push(row);
        doneSet[it.label] = 1;
        saveState();
        S.idx++;
        S.phase = "next";
    }

    function finish() {
        if (finished) { return; }
        finished = true;
        restoreServerCosmetics();
        if (originalPref && typeof setPerfPref === "function") {
            setPerfPref(originalPref);
            applyPerfProfile();
        }
        report({ kind: "summary", device: device, optTier: optTier, n: results.length, results: results });
        hud("PERF HARNESS DONE — " + results.length + " rows. You can close this page.");
    }

    function samplerTick(ts) {
        if (!finished) { requestAnimationFrame(samplerTick); }
        var dt = S.lastTs ? ts - S.lastTs : 0;
        S.lastTs = ts;
        if (finished) { return; }
        if (S.phase === "next") { nextItem(); return; }
        if (!S.item) { return; }
        applyOverride(S.item);
        if (S.phase === "settle") {
            if (!S.t0) { S.t0 = ts; }
            if (ts - S.t0 >= SETTLE_MS) {
                var g = gateSnapshot();
                var bad = gateFail(g, S.item, S.expectedLabel);
                if (bad) {
                    // Pre-window failure = WAIT, don't burn an attempt — sitting out
                    // the lobby/overview between rounds is normal, not a bad sample.
                    // Attempts are only consumed by windows that started and then got
                    // poisoned (state flip / stall / hidden), plus this wait budget so
                    // one pathological scenario can't stall the sweep forever.
                    S.waitMs += ts - S.t0;
                    S.t0 = ts;
                    hud("PERF " + (S.idx + 1) + "/" + queue.length + " " + S.item.label +
                        " waiting (" + bad + ") " + Math.round(S.waitMs / 1000) + "s");
                    if (S.waitMs > 180000) { S.waitMs = 0; requeue("wait-timeout:" + bad); }
                    return;
                }
                S.gate0 = g;
                S.phase = "window";
                S.t0 = ts; S.frames = 0; S.sum = 0; S.worst = 0; S.gl0 = glCalls;
            }
            return;
        }
        if (S.phase === "window") {
            if (dt > 0) {
                S.frames++;
                S.sum += dt;
                if (dt > S.worst) { S.worst = dt; }
            }
            // A multi-second "frame" is a background/sleep stall, not rendering —
            // the whole window is poisoned.
            if (dt > 2000) { requeue("stall:" + Math.round(dt)); return; }
            var liveFps = (S.sum > 0) ? Math.round(1000 * S.frames / S.sum) : 0;
            hud("PERF " + (S.idx + 1) + "/" + queue.length + " " + S.item.label +
                " try" + (S.item.attempts + 1) + "  " + liveFps + "fps worst " + Math.round(S.worst) + "ms");
            if (ts - S.t0 >= S.item.dur) {
                var g1 = gateSnapshot();
                var bad1 = gateFail(g1, S.item, S.expectedLabel);
                if (!bad1 && S.item.gate === "race" && g1.state !== S.gate0.state) { bad1 = "state-change:" + S.gate0.state + ">" + g1.state; }
                if (bad1) { requeue(bad1); return; }
                completeItem(g1);
            }
        }
    }

    // ---------- driver ----------

    function driverTick() {
        if (typeof server !== "object" || !server || !myID ||
            typeof playerList !== "object" || !playerList || !playerList[myID]) { return; }
        var SM = config.stateMap;
        var me = playerList[myID];
        var now = Date.now();
        if (currentState !== drv.lastState) { drv.lastState = currentState; drv.stateSince = now; }
        var mv = { turnLeft: false, moveForward: false, turnRight: false, moveBackward: false, attack: false };
        var target = null;
        if (currentState === SM.lobby) {
            if (now - drv.lastLobbyCfg > 2000) {
                drv.lastLobbyCfg = now;
                // 8 bots + me = 9 karts. Default map rotation (no playlist pin):
                // most rotation maps carry some ice for the ice gate, and the AI can
                // actually FINISH them — pinning the all-ice playlist stalled rounds
                // forever (bots wedge on ice; no global round failsafe exists).
                try { server.emit("setLobbyAI", { enabled: true, count: 8 }); } catch (e) { /* socket mid-reconnect */ }
            }
            target = (typeof lobbyStartButton === "object" && lobbyStartButton) ? lobbyStartButton : null;
        } else if ((currentState === SM.racing || currentState === SM.collapsing) &&
            now - drv.stateSince > 90000) {
            // Round watchdog: bots can wedge on hostile maps and never reach the
            // goal, and nothing else ends a racing round. After 90s of the same
            // round, finish it ourselves — drive to the nearest goal.
            var pts = (typeof worldGoalPoints === "function") ? worldGoalPoints() : [];
            var bd = Infinity;
            for (var i = 0; i < pts.length; i++) {
                var d2 = (pts[i].x - me.x) * (pts[i].x - me.x) + (pts[i].y - me.y) * (pts[i].y - me.y);
                if (d2 < bd) { bd = d2; target = pts[i]; }
            }
        }
        if (target) {
            if (now < drv.wanderUntil && drv.wanderMv) {
                mv = drv.wanderMv;
            } else {
                // Movement is screen-relative omnidirectional: turnLeft = left,
                // moveForward = up. Steer by dx/dy sign with a deadzone.
                var dx = target.x - me.x, dy = target.y - me.y;
                if (dx > 12) { mv.turnRight = true; } else if (dx < -12) { mv.turnLeft = true; }
                if (dy > 12) { mv.moveBackward = true; } else if (dy < -12) { mv.moveForward = true; }
            }
            // Wedge escape: commanded movement but the kart hasn't budged for
            // >1.2s (water pockets / walls wedge a straight-line driver) —
            // wander in a random direction briefly, then resume seeking.
            var wantsMove = mv.turnLeft || mv.turnRight || mv.moveForward || mv.moveBackward;
            if (wantsMove && drv.lastPos) {
                var moved = Math.abs(me.x - drv.lastPos.x) + Math.abs(me.y - drv.lastPos.y);
                drv.stuckMs = (moved < 2) ? drv.stuckMs + 150 : 0;
                if (drv.stuckMs > 1200) {
                    drv.stuckMs = 0;
                    drv.wanderUntil = now + 700;
                    var dirs = [
                        { turnLeft: true }, { turnRight: true }, { moveForward: true }, { moveBackward: true },
                        { turnLeft: true, moveForward: true }, { turnRight: true, moveBackward: true },
                        { turnRight: true, moveForward: true }, { turnLeft: true, moveBackward: true }
                    ];
                    var d = dirs[Math.floor(Math.random() * dirs.length)];
                    drv.wanderMv = {
                        turnLeft: !!d.turnLeft, moveForward: !!d.moveForward,
                        turnRight: !!d.turnRight, moveBackward: !!d.moveBackward, attack: false
                    };
                    mv = drv.wanderMv;
                }
            }
        } else {
            // Jiggle through every other state: defeats the AFK kick and keeps
            // rounds cycling (the bots race; we idle near the gate).
            mv.moveForward = (Math.floor(now / 450) % 2) === 0;
            mv.moveBackward = !mv.moveForward;
        }
        drv.lastPos = { x: me.x, y: me.y };
        try { server.emit("movement", mv); } catch (e) { /* socket mid-reconnect */ }
    }

    // ---------- keep-awake ----------

    function installKeepAwake() {
        var v = document.createElement("video");
        v.setAttribute("playsinline", "");
        v.muted = true;
        v.loop = true;
        v.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;";
        v.src = WAKE_VIDEO;
        document.body.appendChild(v);
        var started = false;
        function start() {
            if (started) { return; }
            var p = v.play();
            if (p && p.then) {
                p.then(function () { started = true; report({ kind: "note", note: "wake-video playing" }); })
                    .catch(function () { /* needs another gesture */ });
            }
        }
        // Gesture-gated: mobile browsers only allow play() from a user gesture.
        ["touchstart", "pointerdown", "click", "keydown"].forEach(function (ev) {
            document.addEventListener(ev, start, { passive: true });
        });
        // Belt and braces: some browsers stop tiny looping videos; restart it.
        v.addEventListener("pause", function () { if (started) { try { v.play(); } catch (e) { } } });
        // Real Wake Lock API too, for when the page is served over https.
        function reqWakeLock() {
            try {
                if (navigator.wakeLock && navigator.wakeLock.request) {
                    navigator.wakeLock.request("screen").catch(function () { /* insecure context */ });
                }
            } catch (e) { /* unsupported */ }
        }
        reqWakeLock();
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible") { reqWakeLock(); }
        });
    }

    // ---------- install ----------

    function install() {
        var nav = navigator || {};
        originalPref = (typeof getPerfPref === "function") ? getPerfPref() : "auto";
        var saved = loadState();
        if (saved) {
            optTier = saved.optTier;
            originalPref = saved.originalPref || originalPref;
            doneSet = saved.done || {};
        } else {
            optTier = (typeof detectPerfTier === "function") ? detectPerfTier() : "high";
        }
        device = {
            ua: (nav.userAgent || "").slice(0, 200),
            platform: nav.platform || "",
            dpr: window.devicePixelRatio || 1,
            iw: window.innerWidth, ih: window.innerHeight,
            sw: (screen && screen.width) || 0, sh: (screen && screen.height) || 0,
            cores: nav.hardwareConcurrency || 0, mem: nav.deviceMemory || 0,
            touch: (typeof isTouchScreen !== "undefined") ? isTouchScreen : null,
            autoTier: optTier, storedPref: originalPref, resumed: !!saved
        };
        queue = buildQueue(optTier);
        saveState();
        report({ kind: "hello", device: device, queued: queue.length });
        console.log("[perfHarness] installed — " + queue.length + " scenarios, optimal tier '" + optTier + "'" + (saved ? " (resumed)" : ""));

        // Wrap gameLoop to count calls per rAF frame — the duplicate-render-chain
        // detector (a healthy client reads 1.0).
        var origGameLoop = gameLoop;
        gameLoop = function (dt) { glCalls++; return origGameLoop(dt); };

        installKeepAwake();
        hud("PERF HARNESS armed — tap once to start keep-awake. " + queue.length + " scenarios.");
        setInterval(driverTick, 150);
        requestAnimationFrame(samplerTick);
    }

    // Socket globals (config/myID/playerList) arrive async after page load; poll
    // until everything the harness touches exists. config.perfHarness===false
    // (i.e. a server not started with PERF_HARNESS=1) refuses to activate.
    var installTimer = setInterval(function () {
        if (typeof config !== "object" || !config || !config.stateMap) { return; }
        if (config.perfHarness !== true) {
            clearInterval(installTimer);
            console.warn("[perfHarness] ?perfharness=1 set but the server was not started with PERF_HARNESS=1 — not activating.");
            return;
        }
        if (typeof playerList === "object" && playerList && myID &&
            typeof server === "object" && server &&
            typeof gameLoop === "function" && typeof SKINS !== "undefined") {
            clearInterval(installTimer);
            install();
        }
    }, 400);
})();
