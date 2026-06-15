'use strict';

// Headless test for the locked-door + key objective. Boots the real server engine
// (no network/browser), injects a door + key onto a committed map via the play-test
// preview path, and drives the room's checkLockedDoors pass tick-by-tick to assert:
//
//   A — init stamps the door cell to the barrier id; a racer touching the key carries
//       it (heldKey + keyPickedUp), and carrying it into the matching door UNLOCKS it
//       (door cell flips back to passable + doorUnlocked).
//   B — a carrier who dies DROPS the key on walkable ground (keyDropped, heldKey clear).
//   C — a loose key the collapse lava reaches is CONSUMED (keyConsumed).
//   D — doors are DECOUPLED from goals: a door map still has its goal and ticks a full
//       race without throwing (so brutal modes that target the real goal still work).
//
// Any failed assertion or throw exits 1.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const _engine = require(path.join(repoRoot, 'server', 'engine.js'));
const cellGraph = require(path.join(repoRoot, 'server', 'cellGraph.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

const DT = config.serverTickSpeed / 1000;
let failures = 0;
function fail(m) { failures++; console.log('::error::' + m); }
function ok(cond, m) { if (!cond) { fail(m); } }

const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

// Record room broadcasts so we can assert the key/door events fired.
let events = [];
const origMsg = messenger.messageRoomBySig;
messenger.messageRoomBySig = function (sig, name, payload) { events.push({ name: name, payload: payload }); return origMsg.apply(this, arguments); };
function countEvents(name) { let n = 0; for (let i = 0; i < events.length; i++) { if (events[i].name === name) { n++; } } return n; }

function walkable(id) {
    return id === config.tileMap.slow.id || id === config.tileMap.normal.id ||
        id === config.tileMap.fast.id || id === config.tileMap.ice.id;
}

// Load Duality, reconstruct full geometry, and inject one door + one key on distinct
// walkable cell sites.
function loadDoorMap(doorPick, keyPick) {
    let map = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', 'Duality.json'), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }
    const walk = [];
    for (let i = 0; i < map.cells.length; i++) {
        if (map.cells[i].site != null && walkable(map.cells[i].id)) { walk.push(map.cells[i]); }
    }
    const d = walk[doorPick % walk.length];
    const k = walk[keyPick % walk.length];
    map.doors = [{ x: d.site.x, y: d.site.y }];
    map.keys = [{ x: k.site.x, y: k.site.y }];
    return map;
}

function makeRoom(sig, map) {
    const room = game.getRoom(sig, 4);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    for (let i = 0; i < 2; i++) {
        const id = sig + '-p' + i;
        const p = room.world.createNewPlayer(id);
        room.playerList[id] = p;
        room.game.determineGameState(p);
    }
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();
    return room;
}

function prepRacer(p) {
    p.awake = true; p.isSpectator = false; p.alive = true; p.isZombie = false; p.reachedGoal = false; p.heldKey = null;
}

// --- Scenario A: init + pickup + unlock --------------------------------------
(function scenarioA() {
    const sig = 'ld-A';
    const room = makeRoom(sig, loadDoorMap(3, 12));
    const gb = room.game.gameBoard;
    ok(gb.hasLockedDoors === true, 'A: hasLockedDoors should be true on a door map');
    ok(gb.lockedDoors.length === 1 && gb.lockedKeys.length === 1, 'A: one door + one key built');
    if (gb.lockedDoors.length !== 1) { return; }
    const door = gb.lockedDoors[0], key = gb.lockedKeys[0];
    ok(door.shape === key.shape, 'A: paired door + key share a shape');
    ok(_engine.isOnCellOfType(door.x, door.y, gb.currentMap, config.tileMap.door.id),
        'A: door home cell stamped to the barrier tile id');
    // cellGraph routing treats the stamped (locked) door cell as a wall: a neighbour of
    // the door can still reach the goal, but the route never steps INTO the door cell
    // (bonus-orb racing lines + the deferred AI rely on this).
    var doorCell = _engine.cellAtPoint(door.x, door.y, gb.currentMap);
    if (doorCell != null && doorCell.halfedges && doorCell.halfedges.length > 0) {
        var startCell = null;
        for (var hh = 0; hh < doorCell.halfedges.length && startCell == null; hh++) {
            var edge = doorCell.halfedges[hh].edge;
            var nb = (edge.lSite && edge.lSite.voronoiId !== doorCell.site.voronoiId) ? edge.lSite : edge.rSite;
            if (nb == null) { continue; }
            for (var ci = 0; ci < gb.currentMap.cells.length; ci++) {
                var cc = gb.currentMap.cells[ci];
                if (cc.site.voronoiId === nb.voronoiId && cc.id !== config.tileMap.door.id &&
                    cc.id !== config.tileMap.lava.id && cc.id !== config.tileMap.empty.id) { startCell = cc; break; }
            }
        }
        if (startCell != null) {
            var route = cellGraph.findPathToNearestGoal(gb.currentMap, startCell);
            var crosses = route != null && Array.isArray(route.path) && route.path.indexOf(doorCell.site.voronoiId) !== -1;
            ok(!crosses, 'A: cellGraph routes around the locked door cell (never through it)');
        }
    }

    const p = room.playerList[sig + '-p0'];
    prepRacer(p);
    p.x = key.x; p.y = key.y;
    events = [];
    room.game.checkLockedDoors();
    ok(p.heldKey != null, 'A: racer on the key now holds it');
    ok(key.carriedBy === p.id, 'A: key latched to the carrier');
    ok(countEvents('keyPickedUp') === 1, 'A: keyPickedUp broadcast');

    p.x = door.x; p.y = door.y;
    events = [];
    room.game.checkLockedDoors();
    ok(door.unlocked === true, 'A: matching door unlocked');
    ok(p.heldKey == null, 'A: held key cleared on unlock');
    ok(!_engine.isOnCellOfType(door.x, door.y, gb.currentMap, config.tileMap.door.id),
        'A: door cell is passable (not the barrier id) after unlock');
    ok(countEvents('doorUnlocked') === 1, 'A: doorUnlocked broadcast');
    // Late-join sync: newMapPayload must reference the LIVE arrays, so a re-send to a
    // mid-round joiner reflects the unlock (not a stale round-start snapshot).
    ok(gb.newMapPayload.lockedDoors === gb.lockedDoors && gb.lockedDoors[0].unlocked === true,
        'A: newMapPayload reflects live unlocked-door state (late-join sync)');
})();

// --- Scenario B: drop on death -----------------------------------------------
(function scenarioB() {
    const sig = 'ld-B';
    const room = makeRoom(sig, loadDoorMap(6, 18));
    const gb = room.game.gameBoard;
    if (gb.lockedKeys.length !== 1) { fail('B: setup produced no key'); return; }
    const key = gb.lockedKeys[0];
    const p = room.playerList[sig + '-p0'];
    prepRacer(p);
    p.x = key.x; p.y = key.y;
    room.game.checkLockedDoors();
    ok(p.heldKey != null, 'B: racer picked up the key');

    p.alive = false; // killed
    events = [];
    room.game.checkLockedDoors();
    ok(key.carriedBy == null, 'B: dead carrier dropped the key');
    ok(p.heldKey == null, 'B: dead carrier no longer holds a key');
    ok(countEvents('keyDropped') === 1, 'B: keyDropped broadcast');
    const dropCell = _engine.cellAtPoint(key.x, key.y, gb.currentMap);
    ok(dropCell != null && walkable(dropCell.id), 'B: key dropped on walkable ground');
})();

// --- Scenario C: consumed by collapse lava -----------------------------------
(function scenarioC() {
    const sig = 'ld-C';
    const room = makeRoom(sig, loadDoorMap(9, 22));
    const gb = room.game.gameBoard;
    if (gb.lockedKeys.length !== 1) { fail('C: setup produced no key'); return; }
    const key = gb.lockedKeys[0];
    const cell = _engine.cellAtPoint(key.x, key.y, gb.currentMap);
    ok(cell != null, 'C: located the loose key cell');
    if (cell != null) { cell.id = config.tileMap.lava.id; } // the collapse front reached it
    room.game.currentState = config.stateMap.collapsing;
    events = [];
    room.game.checkLockedDoors();
    ok(key.consumed === true, 'C: loose key on lava is consumed');
    ok(countEvents('keyConsumed') === 1, 'C: keyConsumed broadcast');
})();

// --- Scenario D: doors decoupled from goals; full race ticks clean ------------
(function scenarioD() {
    const sig = 'ld-D';
    const room = makeRoom(sig, loadDoorMap(2, 14));
    let threw = false;
    try {
        for (let f = 0; f < 60; f++) {
            for (const id in room.playerList) {
                const p = room.playerList[id];
                p.moveForward = true; p.angle = (f * 37) % 360;
            }
            room.update(DT);
        }
    } catch (e) {
        threw = true;
        fail('D: door map threw during a live race: ' + e.message + '\n' + e.stack);
    }
    ok(!threw, 'D: door map ticked a full race without throwing');
    const cells = room.game.gameBoard.currentMap.cells;
    let hasGoal = false;
    for (let i = 0; i < cells.length; i++) { if (cells[i].id === config.tileMap.goal.id) { hasGoal = true; break; } }
    ok(hasGoal, 'D: the real goal still exists alongside the door (decoupled)');
})();

// --- Scenario E: a door painted over lava must still OPEN into walkable ground ----
(function scenarioE() {
    const sig = 'ld-E';
    const map = loadDoorMap(4, 16);
    // Paint lava under the door's cell before the round builds it.
    var dx = map.doors[0].x, dy = map.doors[0].y;
    for (var ci = 0; ci < map.cells.length; ci++) {
        if (map.cells[ci].site != null && map.cells[ci].site.x === dx && map.cells[ci].site.y === dy) {
            map.cells[ci].id = config.tileMap.lava.id; break;
        }
    }
    const room = makeRoom(sig, map);
    const gb = room.game.gameBoard;
    if (gb.lockedDoors.length !== 1) { fail('E: setup produced no door'); return; }
    const door = gb.lockedDoors[0], key = gb.lockedKeys[0];
    ok(door.originalId === config.tileMap.normal.id, 'E: door over lava opens into normal ground (not lava)');
    const p = room.playerList[sig + '-p0'];
    prepRacer(p);
    p.x = key.x; p.y = key.y; room.game.checkLockedDoors();
    p.x = door.x; p.y = door.y; room.game.checkLockedDoors();
    ok(door.unlocked === true, 'E: door unlocked');
    ok(_engine.isOnCellOfType(door.x, door.y, gb.currentMap, config.tileMap.normal.id),
        'E: revealed cell is walkable (normal) after unlock, not the painted lava');
})();

// --- Scenario F: bot-driven — AI fetches the key + opens the gating door ----------
// Builds a door-GATED map (the goal region's whole walkable frontier is lava except a
// single cell, which becomes the door; the matching key sits off on the start side) and
// drives a field of real bots. A bot that only knows how to path to the goal CANNOT
// finish — the cell graph proves the goal is unreachable while the door is shut (asserted
// below), which is exactly the baseline pre-this-feature behaviour. With key-awareness a
// bot fetches the key, carries it to the door, unlocks it, and finishes. We assert ≥1
// finish, plus that pickup/unlock events actually fired (it solved it, didn't luck across).
(function scenarioF() {
    const sig = 'ld-F';
    const GOAL = config.tileMap.goal.id, LAVA = config.tileMap.lava.id;

    // Mocked clock + scheduled timeouts, installed BEFORE driving the loop so AI
    // time-based logic (re-path throttle, anti-stuck, cooldowns) advances in sim time
    // and a tight synchronous tick loop doesn't freeze wall-clock (harness memo). Shared
    // primitives so this doesn't fork yet another copy of the clock/PRNG.
    const harness = require(path.join(repoRoot, '.github', 'scripts', 'headless-harness.js'));
    const tickClock = harness.installMockClock(5e6);
    Math.random = harness.mulberry32(0x10CCD0);

    let map = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', 'Duality.json'), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }
    const cells = map.cells;
    const adj = cellGraph.getAdjacency(map);
    const isWalk = walkable;

    // Goal region + its walkable, non-goal frontier (the cells you can enter the goal from).
    const goalSet = new Set();
    for (let i = 0; i < cells.length; i++) { if (cells[i].id === GOAL) { goalSet.add(i); } }
    const frontier = new Set();
    goalSet.forEach((gi) => {
        const nb = adj.neighbors[gi] || [];
        for (let k = 0; k < nb.length; k++) { if (!goalSet.has(nb[k]) && isWalk(cells[nb[k]].id)) { frontier.add(nb[k]); } }
    });
    const frontierArr = [...frontier];
    if (goalSet.size === 0 || frontierArr.length < 2) { fail('F: Duality lacks a multi-entry goal to gate (frontier=' + frontierArr.length + ')'); return; }

    // Start-edge gate point (the racers' launch line) for reachability + distance picks.
    const edges = (Array.isArray(map.startEdges) && map.startEdges.length) ? map.startEdges : ['left'];
    const gateSamples = [];
    for (const e of edges) { for (const s of cellGraph.edgeSampleOrigins(e)) { gateSamples.push(s); } }
    const gate0 = gateSamples[0];

    // Door = the frontier cell nearest the gate (faces the approach); lava every OTHER
    // frontier cell so the single door is the goal region's ONLY entrance.
    frontierArr.sort((a, b) => Math.hypot(cells[a].site.x - gate0.x, cells[a].site.y - gate0.y) - Math.hypot(cells[b].site.x - gate0.x, cells[b].site.y - gate0.y));
    const doorCellIdx = frontierArr[0];
    for (let i = 1; i < frontierArr.length; i++) { cells[frontierArr[i]].id = LAVA; }
    const dSite = cells[doorCellIdx].site;
    map.doors = [{ x: dSite.x, y: dSite.y }];

    // Reachable-from-gate flood over walkable ground with the door treated as the wall it
    // will become — this is exactly the start-side region a baseline bot can move through.
    const reach = new Set();
    const stack = [];
    for (const s of gateSamples) { const ci = cellGraph.nearestCellIndex(cells, s); if (!reach.has(ci) && (isWalk(cells[ci].id) || cells[ci].id === GOAL)) { reach.add(ci); stack.push(ci); } }
    while (stack.length) {
        const u = stack.pop();
        const nb = adj.neighbors[u] || [];
        for (let k = 0; k < nb.length; k++) {
            const v = nb[k];
            if (reach.has(v)) { continue; }
            if (v === doorCellIdx) { continue; } // door is shut — a wall
            if (isWalk(cells[v].id) || cells[v].id === GOAL) { reach.add(v); stack.push(v); }
        }
    }
    ok(!reach.has(doorCellIdx) && [...goalSet].every((g) => !reach.has(g)), 'F: with the door shut, the goal region is sealed off from the gate (baseline-impossible)');
    // The door must be approachable: at least one of its neighbours is start-side-reachable.
    const doorApproachable = (adj.neighbors[doorCellIdx] || []).some((n) => reach.has(n));
    ok(doorApproachable, 'F: the door has a start-side-reachable approach cell');

    // Key = the reachable walkable cell FARTHEST from the gate (a genuine detour off the
    // racing line, never behind the door), so the bot must seek it out, not stumble on it.
    let keyIdx = -1, keyD = -1;
    reach.forEach((i) => {
        if (i === doorCellIdx || !isWalk(cells[i].id)) { return; }
        const d = Math.hypot(cells[i].site.x - gate0.x, cells[i].site.y - gate0.y);
        if (d > keyD) { keyD = d; keyIdx = i; }
    });
    if (keyIdx < 0) { fail('F: no reachable walkable cell to host the key'); return; }
    map.keys = [{ x: cells[keyIdx].site.x, y: cells[keyIdx].site.y }];

    // Build the room with a field of bots (real engine, mocked clock, seeded RNG).
    const room = game.getRoom(sig, 6);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    const cast = (config.aiRacers && config.aiRacers.cast) || [];
    const bots = [];
    for (let i = 0; i < 5; i++) {
        const b = room.world.createNewBot(sig + '-bot' + i, cast.length ? cast[i % cast.length] : null);
        room.playerList[b.id] = b; bots.push(b);
    }
    room.game.determineGameState(bots[0]);
    room.game.startLobby(); room.game.startGated();
    for (let g = 0; g < 30; g++) { tickClock(config.serverTickSpeed); room.update(DT); }
    room.game.startRace();
    const gb = room.game.gameBoard;
    if (gb.lockedDoors.length !== 1 || gb.lockedKeys.length !== 1) { fail('F: gated map did not build exactly one door + key'); return; }

    // Live cell-graph invariants on the running map: goal unreachable while shut, reachable
    // once the door is treated as open. (Confirms the gate is real and the AI's own
    // "would-opening-doors-help?" probe will fire.)
    ok(cellGraph.findPathToNearestGoal(gb.currentMap, gate0) == null, 'F: live map — goal unreachable with the door shut');
    ok(cellGraph.findPathToNearestGoal(gb.currentMap, gate0, { passableDoors: true }) != null, 'F: live map — goal reachable if the door were open');

    // Drive the race. Count finish EDGES (rounds may cycle); keep notchesToWin high so a
    // finish doesn't end the match before others can also solve it. Reset the shared event
    // log first so the pickup/unlock assertions reflect THIS scenario, not leakage from A/B.
    events = [];
    const TICKS = Math.round(75 / DT);
    const prevGoal = {}; for (const b of bots) { prevGoal[b.id] = false; }
    let finishers = 0;
    let threw = false;
    for (let f = 0; f < TICKS; f++) {
        room.game.notchesToWin = 99;
        tickClock(config.serverTickSpeed);
        try { room.update(DT); } catch (e) { threw = true; fail('F: tick threw: ' + e.message + '\n' + e.stack); break; }
        for (const b of bots) { if (b.reachedGoal && !prevGoal[b.id]) { finishers++; } prevGoal[b.id] = !!b.reachedGoal; }
        if (gb.lockedDoors[0].unlocked && finishers > 0) { break; } // solved + at least one through
        if (room.game.currentState === config.stateMap.gameOver) { break; }
    }
    ok(!threw, 'F: door-gated race ticked without throwing');
    ok(countEvents('keyPickedUp') >= 1, 'F: a bot picked up the key');
    ok(gb.lockedDoors[0].unlocked === true || countEvents('doorUnlocked') >= 1, 'F: a bot carried the key to the door and unlocked it');
    ok(finishers >= 1, 'F: at least one bot reached the goal through the unlocked door (got ' + finishers + ')');
})();

// --- Scenario G: bot-driven — bots OPT INTO an optional shortcut (split behaviour) -----
// A controlled two-entrance goal: a door near the gate (the SHORT way in) and one far
// frontier cell left open (the LONG way around); every other entrance is lava'd so exactly
// those two exist. The goal is reachable WITHOUT the door (the long way), so a bot is never
// forced to fetch the key — but opening the near door is a much shorter route. This asserts
// the SHORTCUT DECISION: at least one bot chooses to detour for the key (it would otherwise
// never touch it on the long route), and the field still finishes. The carry->unlock->finish
// mechanics that follow a pickup are the SAME carrier code proven by scenario F, which runs
// it on a clean (non-lava-flanked) door; here the synthetic door is deliberately ringed by
// lava to force the long alternate, so we don't re-assert the unlock on this hostile approach.
(function scenarioG() {
    const sig = 'ld-G';
    const GOAL = config.tileMap.goal.id, LAVA = config.tileMap.lava.id;
    const harness = require(path.join(repoRoot, '.github', 'scripts', 'headless-harness.js'));
    const tickClock = harness.installMockClock(9e6);
    Math.random = harness.mulberry32(0xC0FFEE);

    let map = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', 'Duality.json'), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }
    const cells = map.cells;
    const adj = cellGraph.getAdjacency(map);

    const goalSet = new Set();
    for (let i = 0; i < cells.length; i++) { if (cells[i].id === GOAL) { goalSet.add(i); } }
    const frontier = [];
    goalSet.forEach((gi) => { (adj.neighbors[gi] || []).forEach((n) => { if (!goalSet.has(n) && walkable(cells[n].id) && frontier.indexOf(n) === -1) { frontier.push(n); } }); });
    if (frontier.length < 2) { fail('G: goal needs >=2 entrances (got ' + frontier.length + ')'); return; }

    const edges = (Array.isArray(map.startEdges) && map.startEdges.length) ? map.startEdges : ['left'];
    const gateSamples = [];
    for (const e of edges) { for (const s of cellGraph.edgeSampleOrigins(e)) { gateSamples.push(s); } }
    const gate0 = gateSamples[0];
    const dGate = (ci) => Math.hypot(cells[ci].site.x - gate0.x, cells[ci].site.y - gate0.y);

    // Door = entrance nearest the gate (short); FAR = entrance farthest (the long open way);
    // lava every other entrance so exactly those two remain.
    frontier.sort((a, b) => dGate(a) - dGate(b));
    const doorCellIdx = frontier[0];
    const farCellIdx = frontier[frontier.length - 1];
    for (const fi of frontier) { if (fi !== doorCellIdx && fi !== farCellIdx) { cells[fi].id = LAVA; } }
    map.doors = [{ x: cells[doorCellIdx].site.x, y: cells[doorCellIdx].site.y }];

    // Key near the gate (a small detour on the short side), so fetching it is clearly worth
    // it versus the long way around — and a bot on the long route would never pass over it.
    const reach = new Set(), stack = [];
    for (const s of gateSamples) { const ci = cellGraph.nearestCellIndex(cells, s); if (!reach.has(ci) && (walkable(cells[ci].id) || cells[ci].id === GOAL)) { reach.add(ci); stack.push(ci); } }
    while (stack.length) { const u = stack.pop(); for (const v of (adj.neighbors[u] || [])) { if (reach.has(v) || v === doorCellIdx) { continue; } if (walkable(cells[v].id) || cells[v].id === GOAL) { reach.add(v); stack.push(v); } } }
    let keyCellIdx = -1, keyBest = Infinity;
    reach.forEach((i) => { if (i === doorCellIdx || !walkable(cells[i].id)) { return; } const d = dGate(i); if (d > 40 && d < keyBest) { keyBest = d; keyCellIdx = i; } });
    if (keyCellIdx < 0) { fail('G: no reachable walkable cell to host the key'); return; }
    map.keys = [{ x: cells[keyCellIdx].site.x, y: cells[keyCellIdx].site.y }];

    const room = game.getRoom(sig, 6);
    room.game.gameBoard.isPreview = true; room.game.gameBoard.previewMap = map;
    const cast = (config.aiRacers && config.aiRacers.cast) || [];
    const bots = [];
    for (let i = 0; i < 5; i++) { const b = room.world.createNewBot(sig + '-bot' + i, cast.length ? cast[i % cast.length] : null); room.playerList[b.id] = b; bots.push(b); }
    room.game.determineGameState(bots[0]);
    room.game.startLobby(); room.game.startGated();
    for (let g = 0; g < 30; g++) { tickClock(config.serverTickSpeed); room.update(DT); }
    room.game.startRace();
    const gb = room.game.gameBoard;
    if (gb.lockedDoors.length !== 1 || gb.lockedKeys.length !== 1) { fail('G: setup did not build exactly one door + key'); return; }

    // The door is a genuine SHORTCUT on the LIVE map: goal reachable the long way, but the
    // door-open route much shorter — so a bot fetching the key is an OPTIONAL choice, not forced.
    const shutRoute = cellGraph.findPathToNearestGoal(gb.currentMap, gate0);
    const openRoute = cellGraph.findPathToNearestGoal(gb.currentMap, gate0, { passableDoors: true });
    ok(shutRoute != null, 'G: goal reachable with the door shut (the long way — shortcut is optional, not forced)');
    ok(openRoute != null && shutRoute != null && openRoute.distance < shutRoute.distance * 0.85,
        'G: opening the door is a real shortcut (much shorter than the long way)');

    events = [];
    const TICKS = Math.round(80 / DT);
    const prevGoal = {}; for (const b of bots) { prevGoal[b.id] = false; }
    let finishers = 0, threw = false;
    for (let f = 0; f < TICKS; f++) {
        room.game.notchesToWin = 99;
        tickClock(config.serverTickSpeed);
        try { room.update(DT); } catch (e) { threw = true; fail('G: tick threw: ' + e.message + '\n' + e.stack); break; }
        for (const b of bots) { if (b.reachedGoal && !prevGoal[b.id]) { finishers++; } prevGoal[b.id] = !!b.reachedGoal; }
        if (room.game.currentState === config.stateMap.gameOver) { break; }
    }
    ok(!threw, 'G: shortcut map ticked without throwing');
    // A bot CHOSE the optional shortcut: it detoured to fetch the key even though the goal was
    // reachable the long way (a bot on the long route never passes the key). Not every bot
    // will — the rest race the open route — which is the intended split.
    ok(countEvents('keyPickedUp') >= 1, 'G: at least one bot chose the optional shortcut (fetched the key)');
    ok(finishers >= 1, 'G: the field still finishes the race (got ' + finishers + ')');
})();

if (failures > 0) {
    console.log('\nLocked-door test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nLocked-door test passed: pickup -> carry -> unlock, drop-on-death, lava-consume, goal-decoupling, and bot key-solving all hold.');
process.exit(0);
