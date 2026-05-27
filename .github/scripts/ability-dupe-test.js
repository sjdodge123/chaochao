'use strict';

// Regression test for the ABILITY-TILE DUPLICATION bug.
//
// Picking up an ability is a check-then-act split across two tick phases: the
// ability is *acquired* during checkCollisions (engine checkCollideCells ->
// player.tryAcquireAbility), but the tile is only *consumed* (rewritten to
// normal ground) later in the same tick by updatePlayers' changeTile. When an
// explosion or a punch flings two karts onto the same ability tile in one tick,
// every player resolving that cell during the collision pass saw it as still an
// ability tile and each acquired from it -> one tile, two pickups.
//
// The fix consumes the cell the instant it's claimed, inside checkCollideCells,
// so any other player resolving the same cell that tick sees plain ground. This
// test boots the REAL engine (no network/browser) and asserts that exactly ONE
// of two co-located players ends up holding an ability, two ways:
//
//   A. engine-level: two players on one ability cell, checkCollideCells called
//      for each in sequence -> exactly one acquires, and the cell is consumed
//      to normal immediately (not just after updatePlayers).
//   B. full tick: a preview room pinned to racing with both players relocated
//      onto the ability cell, run one room.update(dt) -> exactly one acquires.
//
// On the pre-fix code both players acquire and this test fails (exit 1).
//
// Run: node .github/scripts/ability-dupe-test.js

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const game = require(path.join(repoRoot, 'server', 'game.js'));
const _engine = require(path.join(repoRoot, 'server', 'engine.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

const DT = config.serverTickSpeed / 1000;
const NORMAL = config.tileMap.normal.id;
const BOMB = config.tileMap.abilities.bomb.id; // a specific ability-tile id
const RACING = config.stateMap.racing;
const W = config.worldWidth, H = config.worldHeight;

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok: ' + msg); }

// Deterministic Math.random so any incidental shuffles are reproducible.
(function seedRandom(seed) {
    let s = seed >>> 0;
    Math.random = function () {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
})(0xABCDEF);

// socket.io io stand-in so messenger room broadcasts (abilityAcquired, etc.)
// don't throw.
require(path.join(repoRoot, 'server', 'messenger.js')).build({
    to() { return { emit() { } }; },
    sockets: { emit() { } }
});

// Clone a real committed map (valid Voronoi geometry) and return it plus a chosen
// interior cell to turn into an ability tile.
const sampleMapFile = fs.readdirSync(path.join(repoRoot, 'client', 'maps'))
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))[0];
const baseMap = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', sampleMapFile), 'utf8'));

// The cell whose site sits nearest world-center: interior (away from gates/edges),
// so two players parked on its site reliably resolve to it.
function centerCellIndex(map) {
    let best = Infinity, idx = -1;
    for (let i = 0; i < map.cells.length; i++) {
        const s = map.cells[i].site;
        if (!s) { continue; }
        const dx = s.x - W / 2, dy = s.y - H / 2;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; idx = i; }
    }
    return idx;
}

function parkOnCell(player, cell) {
    player.x = player.newX = cell.site.x;
    player.y = player.newY = cell.site.y;
    player.velX = 0;
    player.velY = 0;
    player.moveForward = false;
    player.moveBackward = false;
    player.turnLeft = false;
    player.turnRight = false;
    player.attack = false;
    player.alive = true;
    player.enabled = true;
    player.isZombie = false;
    player.currentState = RACING;
}

function countHolders(players) {
    let n = 0;
    for (const p of players) { if (p.ability != null) { n++; } }
    return n;
}

// ---- Test A: engine-level, two players resolve the same ability cell in one pass.
(function testEngineLevel() {
    console.log('\n[A] engine checkCollideCells: two players on one ability tile');
    const map = JSON.parse(JSON.stringify(baseMap));
    const room = game.getRoom('dupe-engine', 12);
    const cellIdx = centerCellIndex(map);
    const cell = map.cells[cellIdx];
    cell.id = BOMB; // make it an ability tile

    const p1 = room.world.createNewPlayer('dupe-engine-p1');
    const p2 = room.world.createNewPlayer('dupe-engine-p2');
    parkOnCell(p1, cell);
    parkOnCell(p2, cell);

    if (p1.ability != null || p2.ability != null) {
        fail('A: a player already held an ability before the collision pass');
        return;
    }

    // Same order checkCollisions visits players in: one full resolve each.
    _engine.checkCollideCells(p1, map);
    _engine.checkCollideCells(p2, map);

    const holders = countHolders([p1, p2]);
    if (holders !== 1) {
        fail('A: expected exactly 1 player to acquire the ability, got ' + holders +
            ' (duplication: both players resolved the same ability tile before it was consumed)');
    } else {
        ok('exactly one player acquired the ability');
    }
    if (cell.id !== NORMAL) {
        fail('A: the ability cell was not consumed to normal ground in-pass (still id ' + cell.id + ')');
    } else {
        ok('ability cell was consumed to normal ground the instant it was claimed');
    }
})();

// ---- Test B: full room tick — both karts relocated onto the ability tile, as if
// an explosion/punch flung them there in the same frame.
(function testFullTick() {
    console.log('\n[B] full room.update tick: two players flung onto one ability tile');
    const map = JSON.parse(JSON.stringify(baseMap));
    map.id = 'dupe-tick-map';
    const room = game.getRoom('dupe-tick', 12);
    const gb = room.game.gameBoard;
    gb.isPreview = true;
    gb.previewMap = map;
    gb.chanceOfBrutalRound = 0; // no brutal ability round handing out free abilities
    gb.brutalRound = false;

    const ids = ['dupe-tick-p1', 'dupe-tick-p2'];
    for (const id of ids) {
        const player = room.world.createNewPlayer(id);
        room.playerList[id] = player;
        room.game.determineGameState(player);
    }

    try {
        room.game.startLobby();
        room.game.startGated();
        room.game.startRace();
    } catch (e) {
        fail('B: threw during racing setup: ' + e.message + '\n' + e.stack);
        return;
    }

    // Inject the ability tile AFTER setup so nothing in generateAbilities/race-start
    // can overwrite it, then park both karts on it (the "launched into the cell"
    // moment). currentMap is the live preview map object.
    const liveMap = gb.currentMap;
    const cell = liveMap.cells[centerCellIndex(liveMap)];
    cell.id = BOMB;
    const players = ids.map(id => room.playerList[id]);
    for (const p of players) { parkOnCell(p, cell); }

    if (countHolders(players) !== 0) {
        fail('B: a player already held an ability before the tick (setup handed one out)');
        return;
    }

    try {
        room.game.currentState = RACING; // pin so the wall-clock timer can't flip state
        room.update(DT);
    } catch (e) {
        fail('B: threw during the racing tick: ' + e.message + '\n' + e.stack);
        return;
    }

    const holders = countHolders(players);
    if (holders !== 1) {
        fail('B: expected exactly 1 player to acquire the ability, got ' + holders +
            ' (duplication across one full tick)');
    } else {
        ok('exactly one player acquired the ability across a full tick');
    }
})();

if (failures > 0) {
    console.log('\nability-dupe test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nability-dupe test passed: one ability tile grants exactly one pickup, even with two karts on it in one tick.');
process.exit(0);
