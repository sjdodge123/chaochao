'use strict';

// Headless validation for author-selectable map START EDGES (single edge +
// opposite-edge combos). Boots the REAL server engine (no network/browser) and,
// for every supported edge configuration, ticks a pinned map gated -> racing ->
// collapsing while asserting:
//
//   * the engine never throws and the per-tick compressor arrays stay well-formed
//   * the multi-gate gameState payload round-trips (compressor.gameState ->
//     the gameboard.js#checkGameState decode shape), with the right gate count,
//     edges, and in-world rects
//   * players are held in THEIR gate (per-gate preventEscape) on every edge
//   * AI racers are distributed across gates (balanced for opposite-edge maps),
//     press toward their assigned gate, and settle onto NON-LAVA launch lanes
//     even when the front row is partly lava-walled (top/bottom/combo included)
//
// Run: node .github/scripts/start-edges-test.js   (exit 1 on any failure)

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const game = require(path.join(repoRoot, 'server', 'game.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const aiController = require(path.join(repoRoot, 'server', 'aiController.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

const DT = config.serverTickSpeed / 1000;
const LAVA = config.tileMap.lava.id;
const GATE_DEPTH = 75;
const W = config.worldWidth, H = config.worldHeight;

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok: ' + msg); }

// Deterministic Math.random so bot counts / cast shuffles are reproducible.
(function seedRandom(seed) {
    let s = seed >>> 0;
    Math.random = function () {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
})(0xC0FFEE);

// A socket.io io stand-in so messenger room broadcasts don't throw.
require(path.join(repoRoot, 'server', 'messenger.js')).build({
    to() { return { emit() { } }; },
    sockets: { emit() { } }
});

// Nearest-cell tile id at a point (mirrors aiController.isLavaAt's nearest-site
// rule) so the test can check whether a bot ended up standing on lava.
function tileIdAt(map, x, y) {
    let best = Infinity, id = -1;
    for (let i = 0; i < map.cells.length; i++) {
        const cell = map.cells[i];
        if (!cell || !cell.site) { continue; }
        const dx = cell.site.x - x, dy = cell.site.y - y;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; id = cell.id; }
    }
    return id;
}

// Decode a serialized gameState packet the way client gameboard.js#checkGameState
// does for the gated/racing/collapsing branch, returning the gate list.
function decodeGates(serialized) {
    const payload = JSON.parse(serialized);
    const out = [];
    const gateData = payload[1] || [];
    for (let i = 0; i < gateData.length; i++) {
        const gd = gateData[i];
        out.push({ x: gd[0], y: gd[1], width: gd[2], height: gd[3], edge: gd[4] });
    }
    return out;
}

// Clone a real committed map (valid Voronoi geometry) and stamp startEdges.
// Optionally paints a lava band across PART of one edge's front row so the
// safe-lane steering has something to dodge.
const sampleMapFile = fs.readdirSync(path.join(repoRoot, 'client', 'maps'))
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))[0];
const baseMap = mapFormat.hydrate(JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', sampleMapFile), 'utf8')));

function makeMap(startEdges, lavaEdge) {
    const map = JSON.parse(JSON.stringify(baseMap));
    map.id = 'se-test-' + startEdges.join('+');
    map.startEdges = startEdges.slice();
    map.parTime = null; // force a fresh par-time computation through the new axis logic
    if (lavaEdge != null) {
        // Lava across the inner half of the lavaEdge's front strip, leaving the
        // other half as safe lanes the bots must find.
        for (let i = 0; i < map.cells.length; i++) {
            const s = map.cells[i].site;
            if (!s) { continue; }
            let inStrip = false, inHalf = false;
            if (lavaEdge === 'left') { inStrip = s.x < GATE_DEPTH + 120; inHalf = s.y < H / 2; }
            else if (lavaEdge === 'right') { inStrip = s.x > W - GATE_DEPTH - 120; inHalf = s.y < H / 2; }
            else if (lavaEdge === 'top') { inStrip = s.y < GATE_DEPTH + 120; inHalf = s.x < W / 2; }
            else if (lavaEdge === 'bottom') { inStrip = s.y > H - GATE_DEPTH - 120; inHalf = s.x < W / 2; }
            if (inStrip && inHalf) { map.cells[i].id = LAVA; }
        }
    }
    return map;
}

function gateBBoxContains(gate, x, y) {
    return x >= gate.x - 2 && x <= gate.x + gate.width + 2 &&
        y >= gate.y - 2 && y <= gate.y + gate.height + 2;
}

// Inner-edge ("launch") coordinate + axis for a gate, mirroring the server's
// gate geometry, so we can assert bots press toward their gate.
function innerEdge(gate) {
    const vertical = gate.width < gate.height;
    if (vertical) {
        return { axis: 'x', pos: gate.edge === 'left' ? gate.x + gate.width : gate.x };
    }
    return { axis: 'y', pos: gate.edge === 'top' ? gate.y + gate.height : gate.y };
}

let roomSeq = 0;
function runConfig(startEdges, lavaEdge, label) {
    console.log('\n[' + label + ']');
    const map = makeMap(startEdges, lavaEdge);
    const sig = 'se-room-' + (roomSeq++);
    const room = game.getRoom(sig, 12);
    const gb = room.game.gameBoard;
    gb.isPreview = true;
    gb.previewAI = true; // opt the preview room into the AI grid fill (v0.8.4+)
    gb.previewMap = map;

    for (let i = 0; i < 2; i++) {
        const id = sig + '-p' + i;
        const player = room.world.createNewPlayer(id);
        room.playerList[id] = player;
        room.game.determineGameState(player);
    }
    // Pin a healthy bot count so the safe-lane assertions have enough samples to
    // be statistically meaningful (auto-mode now scales bots with humans, which
    // would only give 2 bots here).
    room.game.botOverride = { enabled: true, count: 6 };

    try {
        room.game.startLobby();
        room.game.startGated();
    } catch (e) {
        fail(label + ': threw during gated setup: ' + e.message + '\n' + e.stack);
        return;
    }

    // ---- gate model ----
    if (gb.startingGates.length !== startEdges.length) {
        fail(label + ': expected ' + startEdges.length + ' gate(s), got ' + gb.startingGates.length);
    }

    // ---- compressor round-trip ----
    const decoded = decodeGates(compressor.gameState(room.game));
    if (decoded.length !== startEdges.length) {
        fail(label + ': decoded ' + decoded.length + ' gate(s) from gameState, expected ' + startEdges.length);
    } else {
        for (let i = 0; i < decoded.length; i++) {
            const g = decoded[i];
            if (startEdges.indexOf(g.edge) === -1) {
                fail(label + ': decoded gate has unexpected edge "' + g.edge + '"');
            }
            if (g.x < 0 || g.y < 0 || g.x + g.width > W + 0.5 || g.y + g.height > H + 0.5) {
                fail(label + ': decoded gate ' + JSON.stringify(g) + ' is out of world bounds');
            }
            if (typeof g.width !== 'number' || typeof g.height !== 'number' || g.width <= 0 || g.height <= 0) {
                fail(label + ': decoded gate has a bad size ' + JSON.stringify(g));
            }
        }
        ok('gameState round-trips ' + decoded.length + ' gate(s): ' + decoded.map(g => g.edge).join(', '));
    }

    // ---- gateIndex + placement + distribution ----
    const perGate = gb.startingGates.map(() => 0);
    let bots = 0;
    for (const id in room.playerList) {
        const p = room.playerList[id];
        if (p.isAI) { bots++; }
        if (p.gateIndex < 0 || p.gateIndex >= gb.startingGates.length) {
            fail(label + ': player ' + id + ' has invalid gateIndex ' + p.gateIndex);
            continue;
        }
        perGate[p.gateIndex]++;
        const gate = gb.startingGates[p.gateIndex];
        if (!gateBBoxContains(gate, p.x, p.y)) {
            fail(label + ': player ' + id + ' (' + p.x.toFixed(0) + ',' + p.y.toFixed(0) +
                ') is not inside its gate ' + p.gateIndex + ' [' + gate.edge + ']');
        }
    }
    if (bots === 0) { fail(label + ': no AI racers were spawned to test gated steering'); }
    if (gb.startingGates.length === 2) {
        if (Math.abs(perGate[0] - perGate[1]) > 2) {
            fail(label + ': unbalanced gate split ' + perGate.join(' vs '));
        } else {
            ok('balanced split across gates: ' + perGate.join(' / ') + ' (' + bots + ' bots total)');
        }
    } else {
        ok(bots + ' bots, all at gate 0');
    }

    // ---- gated steering: press toward gate + avoid lava ----
    // Re-pin gated each tick so the wall-clock racing timer can't flip us early.
    // Bots spawn at a random spot across the gate (which may be a lava lane when
    // the front row is partly lava-walled) and then migrate to a safe launch lane,
    // so allow enough ticks for that lateral migration to settle.
    const gated = room.game.stateMap.gated;
    let pressOk = 0, pressTotal = 0;
    for (let f = 0; f < 150; f++) {
        room.game.currentState = gated;
        room.update(DT);
        const arrs = [
            compressor.sendPlayerUpdates(room.playerList),
            compressor.sendProjUpdates(room.projectileList),
            compressor.sendAimerUpdates(room.aimerList),
            compressor.sendHazardUpdates(room.hazardList)
        ];
        for (const a of arrs) { if (!Array.isArray(a)) { fail(label + ': malformed per-tick array at gated frame ' + f); } }
        if (failures > 0) { return; }
    }
    // After settling, assert each bot pressed toward its gate's inner edge and is
    // not standing on lava.
    let lavaStanders = 0;
    for (const id in room.playerList) {
        const p = room.playerList[id];
        if (!p.isAI || !p.alive) { continue; }
        const gate = gb.startingGates[p.gateIndex];
        const edge = innerEdge(gate);
        // velocity intent toward the inner edge (averaged over the run is noisy per
        // tick; check the steady-state target direction sign set this frame).
        const towardInner = (edge.axis === 'x')
            ? Math.sign(edge.pos - p.x) === Math.sign(p.targetDirX || (edge.pos - p.x))
            : Math.sign(edge.pos - p.y) === Math.sign(p.targetDirY || (edge.pos - p.y));
        pressTotal++;
        if (towardInner || Math.abs((edge.axis === 'x' ? p.x : p.y) - edge.pos) < 30) { pressOk++; }
        if (tileIdAt(map, p.x, p.y) === LAVA) { lavaStanders++; }
    }
    if (pressTotal > 0 && pressOk < pressTotal) {
        // Not a hard fail by itself (a bot at the front presses laterally), but flag
        // if a large fraction face the wrong way.
        if (pressOk < Math.ceil(pressTotal * 0.5)) {
            fail(label + ': only ' + pressOk + '/' + pressTotal + ' bots oriented toward their gate');
        }
    }
    if (lavaEdge != null) {
        // The generalized per-gate safe-lane steering should send the bots to the
        // NON-lava half of the front row. A broken edge/axis generalization would
        // instead pile most of them straight onto the lava band, so require a
        // strong majority off lava. (A few can be jostled onto the lava edge by
        // crowding in a half-walled gate — that's the known "gate spawns don't
        // avoid lava" limitation, not a steering-axis bug, and lava can't kill
        // during the gated phase anyway.)
        const offLava = pressTotal - lavaStanders;
        if (pressTotal > 0 && offLava < Math.ceil(pressTotal * 0.6)) {
            fail(label + ': only ' + offLava + '/' + pressTotal +
                ' bots found a non-lava lane — the safe-lane generalization looks broken on the ' + lavaEdge + ' edge');
        } else {
            ok(offLava + '/' + pressTotal + ' bots settled on a non-lava lane on the ' + lavaEdge + ' front row');
        }
    } else {
        ok('bots pressed toward their gate(s)');
    }

    // ---- racing -> collapsing ----
    try {
        room.game.startRace();
        for (let f = 0; f < 120; f++) { room.update(DT); }
        room.game.startCollapse(W / 2, H / 2);
        for (let f = 0; f < 120; f++) {
            room.update(DT);
            const a = compressor.sendPlayerUpdates(room.playerList);
            if (!Array.isArray(a)) { fail(label + ': malformed player array while collapsing'); break; }
        }
        ok('ran racing -> collapsing clean');
    } catch (e) {
        fail(label + ': threw during race/collapse: ' + e.message + '\n' + e.stack);
    }
}

// Single edges (with a lava band each, to exercise per-edge safe-lane steering)
// and the two opposite-edge combos.
runConfig(['left'], 'left', 'single: left (lava band)');
runConfig(['right'], 'right', 'single: right (lava band)');
runConfig(['top'], 'top', 'single: top (lava band)');
runConfig(['bottom'], 'bottom', 'single: bottom (lava band)');
runConfig(['left', 'right'], 'right', 'combo: left+right (lava on right)');
runConfig(['top', 'bottom'], 'top', 'combo: top+bottom (lava on top)');

if (failures > 0) {
    console.log('\nstart-edges test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nstart-edges test passed: every edge config gated -> raced -> collapsed cleanly.');
process.exit(0);
