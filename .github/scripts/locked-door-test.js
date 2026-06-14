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

if (failures > 0) {
    console.log('\nLocked-door test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nLocked-door test passed: pickup -> carry -> unlock, drop-on-death, lava-consume, and goal-decoupling all hold.');
process.exit(0);
