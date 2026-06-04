// Headless geometry test for the lobby hub station panels (client/scripts/lobbyHub.js).
//
// Loads the REAL skinRegistry.js + lobbyHub.js in a node `vm` with the painter functions
// stubbed (they live in draw.js) and a no-op Proxy 2D context, then calls the real
// drawLobbyHubHud() with synthetic localPlayers/playerList and asserts on the geometry the
// adaptive-scale layout produced:
//   - scale tiers: 1 open panel = large (1.8x), 2 = medium (1.4x), 3-4 = compact (1x)
//   - every open panel's footprint (panel + the skin picker's Equipped preview) stays fully
//     on the 1366x768 logical screen
//   - 2-4 open co-op panels never overlap each other
//   - every open panel still publishes pointer hit rects (close + options) inside the screen
//   - single-open panels meet the readability floor (no panel font below 11px logical)
//
// Run: node .github/scripts/lobbyhub-geometry-test.js   (no network, no browser, <1s)
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "..");
const regSrc = fs.readFileSync(path.join(root, "client/scripts/skinRegistry.js"), "utf8");
const hubSrc = fs.readFileSync(path.join(root, "client/scripts/lobbyHub.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
    if (cond) { return; }
    failures++;
    console.error("  FAIL: " + msg);
}

// --- sandbox -----------------------------------------------------------------

// Record every font px set on the context so we can assert readability floors.
const fontSizes = [];
// A no-op 2D context: every method returns a permissive "anything" value so even
// gradient/pattern chains (createLinearGradient(...).addColorStop(...)) can't throw.
const anything = new Proxy(function () { }, {
    get: function (t, k) { return (k === Symbol.toPrimitive) ? (() => 0) : anything; },
    apply: function () { return anything; },
    set: function () { return true; },
});
function makeCtx() {
    return new Proxy({}, {
        get: function (t, k) {
            if (k === "measureText") { return (s) => ({ width: String(s).length * 7 }); }
            return function () { return anything; };
        },
        set: function (t, k, v) {
            if (k === "font" && typeof v === "string") {
                const m = v.match(/([\d.]+)px/);
                if (m) { fontSizes.push(parseFloat(m[1])); }
            }
            return true;
        },
    });
}

const sandbox = {
    console,
    LOGICAL_WIDTH: 1366,
    LOGICAL_HEIGHT: 768,
    config: {
        stateMap: { lobby: 1 },
        colorPalette: ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22", "#1abc9c", "#34495e"],
        playlists: [{ id: "featured", name: "Featured", desc: "The best maps" }],
        defaultPlaylist: "featured",
        maxPlayersInRoom: 25,
        aiRacers: { maxGrid: 10 },
    },
    currentState: 1,
    primarySlot: 0,
    localPlayers: [],
    playerList: {},
    gameContext: makeCtx(),
};
// Stub every draw.js painter referenced by the registry's array literal.
(regSrc.match(/draw[A-Z][A-Za-z0-9_]*/g) || []).forEach(function (name) {
    sandbox[name] = function () { };
});
vm.createContext(sandbox);
vm.runInContext(regSrc, sandbox, { filename: "skinRegistry.js" });
vm.runInContext(hubSrc, sandbox, { filename: "lobbyHub.js" });

// --- scenario driver -----------------------------------------------------------

// kinds[i] is a station kind for an open panel, or null for an idle pad seat (no panel)
// — idle seats exercise the "P<N> Ⓐ Join" chip pinned to another seat's open panel.
const SEAT_COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f"];
function runScenario(kinds, xs) {
    sandbox.playerList = {};
    sandbox.localPlayers = kinds.map(function (kind, i) {
        sandbox.playerList[i] = { color: SEAT_COLORS[i], x: (xs && xs[i] != null) ? xs[i] : 200 + i * 250, y: 300, radius: 12 };
        return {
            slot: i,
            isPrimary: i === 0,
            myID: i,
            socket: { emit: function () { } },
            nearStation: null,
            stationPanel: kind ? { id: i + 1, kind: kind, tab: "color", region: "grid", cursor: 0 } : null,
        };
    });
    fontSizes.length = 0;
    vm.runInContext("drawLobbyHubHud()", sandbox);
    return sandbox.localPlayers;
}

// The full on-screen footprint of a slot's drawn panel: the panel rect, unioned with the
// skin picker's Equipped preview rect when present (both stashed by the draw pass).
function footprint(lp) {
    let r = lp._panelRect;
    if (lp._equipRect) {
        const x = Math.min(r.x, lp._equipRect.x);
        const y = Math.min(r.y, lp._equipRect.y);
        const x2 = Math.max(r.x + r.w, lp._equipRect.x + lp._equipRect.w);
        const y2 = Math.max(r.y + r.h, lp._equipRect.y + lp._equipRect.h);
        r = { x: x, y: y, w: x2 - x, h: y2 - y };
    }
    return r;
}
function onScreen(r) {
    return r.x >= 0 && r.y >= 0 && r.x + r.w <= 1366 && r.y + r.h <= 768;
}
function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function fmt(r) {
    return r ? `[${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.w.toFixed(1)}x${r.h.toFixed(1)}]` : "<none>";
}

// --- scenarios -------------------------------------------------------------------

const SCENARIOS = [
    { kinds: ["skin"], scale: 1.8 },
    { kinds: ["ai"], scale: 1.8 },
    { kinds: ["playlist"], scale: 1.8 },
    { kinds: ["skin", "ai"], scale: 1.4 },
    { kinds: ["skin", "skin"], scale: 1.4 },
    { kinds: ["skin", "ai", "playlist"], scale: 1 },
    { kinds: ["skin", "ai", "playlist", "skin"], scale: 1 },
    // Idle pad seats (null) get a "join" chip pinned to the open panel instead.
    { kinds: ["skin", null], scale: 1.8 },
    { kinds: ["skin", null, null, null], scale: 1.8 },
    { kinds: ["skin", "playlist", null, null], scale: 1.4 },
    // Right-edge anchored panel + 3 chips: the chip row must wrap/clamp on screen
    // instead of running past LOGICAL_WIDTH (Codex review finding).
    { kinds: ["playlist", null, null, null], scale: 1.8, xs: [1340, 100, 100, 100], tag: "right-edge" },
];

for (const sc of SCENARIOS) {
    const openCount = sc.kinds.filter(Boolean).length;
    const label = openCount + " open (" + sc.kinds.map(k => k || "idle").join(",") + ")"
        + (sc.tag ? " [" + sc.tag + "]" : "");
    console.log("scenario: " + label);
    const lps = runScenario(sc.kinds, sc.xs);
    const rects = [];
    lps.forEach(function (lp, i) {
        if (!sc.kinds[i]) {
            // Idle pad seat: it must get an on-screen join chip and no panel.
            assert(!lp._panelRect, `${label} seat ${i}: idle seat drew a panel`);
            assert(lp._joinChipRect, `${label} seat ${i}: idle pad seat got no join chip`);
            if (lp._joinChipRect) {
                assert(onScreen(lp._joinChipRect), `${label} seat ${i}: join chip off screen ${fmt(lp._joinChipRect)}`);
            }
            return;
        }
        assert(Math.abs((lp._panelScale || 0) - sc.scale) < 1e-6,
            `${label} seat ${i}: scale ${lp._panelScale} != expected ${sc.scale}`);
        assert(lp._panelRect, `${label} seat ${i}: no panel rect drawn`);
        if (!lp._panelRect) { return; }
        const fp = footprint(lp);
        rects.push({ i: i, r: fp });
        assert(onScreen(fp), `${label} seat ${i}: footprint off screen ${fmt(fp)}`);
        // Hit rects: close button + at least one option, all inside the screen.
        const hit = sandbox.stationHudHit[i];
        assert(hit && hit.close, `${label} seat ${i}: no close hit rect`);
        assert(hit && hit.options.length > 0, `${label} seat ${i}: no option hit rects`);
        if (hit) {
            [hit.close].concat(hit.options.map(o => o.rect)).forEach(function (r, ri) {
                if (r) { assert(onScreen(r), `${label} seat ${i}: hit rect ${ri} off screen ${fmt(r)}`); }
            });
        }
        // The skin panel must keep its full control set reachable at every scale.
        if (sc.kinds[i] === "skin" && hit) {
            const acts = hit.options.map(o => o.action).join("|");
            assert(acts.indexOf("tab:") !== -1, `${label} seat ${i}: skin panel lost its tab hit rects`);
            assert(acts.indexOf("randomize") !== -1, `${label} seat ${i}: skin panel lost the Random button`);
        }
    });
    for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
            assert(!overlaps(rects[a].r, rects[b].r),
                `${label}: seats ${rects[a].i}+${rects[b].i} overlap ${fmt(rects[a].r)} vs ${fmt(rects[b].r)}`);
        }
    }
    // Readability floor: a lone panel must not render any text below 11px logical.
    // (Banners/prompt draw at >=15px, so the global font log is a safe proxy.)
    if (sc.kinds.length === 1) {
        const minFont = Math.min.apply(null, fontSizes);
        assert(minFont >= 11, `${label}: smallest font ${minFont}px < 11px readability floor`);
    }
}

if (failures) {
    console.error(failures + " geometry check(s) FAILED");
    process.exit(1);
}
console.log("all lobby-hub geometry checks passed");
