'use strict';

// Headless state-machine test for the Bunker (battle-royale) brutal round.
//
// Like smoke-test.js, this boots the REAL server modules (no network/browser) and
// drives the live tick loop, but it pins a single Bunker round (via the
// brutalTypesForce seam) and asserts the whole lifecycle the mode is built around:
//
//   setup      -> goal buried: no goal tiles remain, a single bunker cluster is
//                 carved into a safe ice island, every other goal sacrificed.
//   racing     -> the closing ring converts perimeter cells to lava over time.
//   1 survivor -> the goal emerges (lid cells restored to goal tiles).
//   claim      -> the survivor reaching the emerged goal wins (firstPlaceSig set).
//   0 alive    -> the round voids to overview with no winner.
//   stalemate  -> survivors camping past maxRoundTime void via the safety valve.
//
// Any failed assertion exits 1.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const cellGraph = require(path.join(repoRoot, 'server', 'cellGraph.js'));
const c = utils.loadConfig();

const DT = c.serverTickSpeed / 1000;
let failures = 0;
function check(cond, msg) {
    if (!cond) { failures++; console.log('::error::Bunker: ' + msg); }
    else { console.log('ok: ' + msg); }
}

const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

// Controllable clock — a tight synchronous tick loop freezes wall-clock, so
// bunkerStartTime / maxRoundTime would never advance.
const realNow = Date.now;
let fakeNow = 1000000;
Date.now = () => fakeNow;

function countId(gb, id) {
    let n = 0;
    const cells = gb.currentMap.cells;
    for (let i = 0; i < cells.length; i++) { if (cells[i].id === id) { n++; } }
    return n;
}

function pickMapWithGoal() {
    const dir = path.join(repoRoot, 'client', 'maps');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    for (const file of files) {
        let m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (mapFormat.isSitesOnly(m)) { m = mapFormat.reconstruct(m); }
        if (m.cells && m.cells.some(cell => cell.id === c.tileMap.goal.id)) { return { name: file, map: m }; }
    }
    return null;
}

function buildRoom(sig, nPlayers, map) {
    const room = game.getRoom(sig, 8);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    for (let i = 0; i < nPlayers; i++) {
        const id = sig + '-p' + i;
        const player = room.world.createNewPlayer(id);
        room.playerList[id] = player;
        room.game.determineGameState(player);
    }
    return room;
}

function tick(room) { fakeNow += Math.round(DT * 1000); room.update(DT); }

// Force every brutal roll to be a solo Bunker round.
c.brutalTypesForce = [c.brutalRounds.bunker.id];

const picked = pickMapWithGoal();
if (picked == null) { console.log('::error::Bunker: no committed map with goal tiles found'); process.exit(1); }
console.log('Using map: ' + picked.name);

// ---- P1 regression: ability tile-mutators must not throw on a FRESH board ----
// (lobby tutorial can fire bomb/iceCannon/lava/tileSwap before the first race, when
// bunker state hasn't been set up by clean()/applyBrutalBunkerRound yet).
(function freshBoardAbilities() {
    const room = buildRoom('bunker-fresh', 2, picked.map);
    const gb = room.game.gameBoard;
    room.game.startLobby(); // loads the lobby map; clean()/bunker setup has NOT run yet
    let threw = false;
    try {
        gb.swapTiles();
        gb.explodeLava({ x: 100, y: 100 }, 60);
    } catch (e) { threw = true; console.log('  (threw: ' + e.message + ')'); }
    check(!threw, 'tile-mutating abilities in the lobby (pre-race) do not throw');
})();

// ---- Lifecycle: bury -> ring -> emerge -> claim ----
(function lifecycle() {
    const room = buildRoom('bunker-life', 4, picked.map);
    const gb = room.game.gameBoard;

    room.game.startLobby();
    room.game.startGated(); // setupMap -> applyBrutalBunkerRound (bury)

    check(gb.goalBuried === true, 'goal is buried after setup');
    check(gb.bunkerLoc != null, 'bunker location chosen');
    check(countId(gb, c.tileMap.goal.id) === 0, 'no goal tiles exist while buried');
    check(Object.keys(gb.bunkerSafeIds).length > 0, 'safe ice island carved');
    check(countId(gb, c.tileMap.ice.id) > 0, 'ice tiles present');
    const lidCount = gb.bunkerLidIds.length;
    check(lidCount > 0, 'bunker lid remembered');

    // Bots must still find a route while the goal is buried: with no goal tiles,
    // the A* has to home on the bunker island via the goalSet option (otherwise it
    // returns null and bots idle).
    const far = { x: 30, y: 30 };
    const buriedRoute = cellGraph.findPathToNearestGoal(gb.currentMap, far, { goalSet: gb.bunkerSafeIds });
    const plainRoute = cellGraph.findPathToNearestGoal(gb.currentMap, far);
    check(buriedRoute != null, 'A* finds a route to the buried bunker via goalSet');
    check(plainRoute == null, 'A* finds NO route without goalSet (goal really is buried)');

    // tileSwap (ice<->fast) must not corrupt the ice bunker island.
    const islandIds = Object.keys(gb.bunkerSafeIds);
    gb.swapTiles();
    let islandStillIce = true;
    for (let i = 0; i < gb.currentMap.cells.length; i++) {
        const cell = gb.currentMap.cells[i];
        if (gb.bunkerSafeIds[cell.site.voronoiId] && cell.id !== c.tileMap.ice.id) { islandStillIce = false; }
    }
    check(islandStillIce, 'tileSwap leaves the bunker island ice intact');

    // A lava explosion (or bomb/iceCannon — same guard) must not alter the island.
    // Contained radius: covers the island + neighbours but leaves the far map for
    // the ring assertion below to still have cells to convert.
    gb.explodeLava({ x: gb.bunkerLoc.x, y: gb.bunkerLoc.y }, 120);
    let islandSurvivedBlast = true;
    for (let i = 0; i < gb.currentMap.cells.length; i++) {
        const cell = gb.currentMap.cells[i];
        if (gb.bunkerSafeIds[cell.site.voronoiId] && cell.id !== c.tileMap.ice.id) { islandSurvivedBlast = false; }
    }
    check(islandSurvivedBlast, 'explosions cannot lava/alter the bunker island');

    room.game.startRace();
    const lavaBefore = countId(gb, c.tileMap.lava.id);
    const lineBefore = gb.collapseLine;
    for (let f = 0; f < 90; f++) { tick(room); }
    check(gb.collapseLine < lineBefore, 'ring closed inward');
    check(countId(gb, c.tileMap.lava.id) > lavaBefore, 'ring converted cells to lava');
    check(countId(gb, c.tileMap.goal.id) === 0, 'goal still buried mid-race');

    const ids = Object.keys(room.playerList);
    const survivor = room.playerList[ids[0]];
    for (let i = 1; i < ids.length; i++) { room.playerList[ids[i]].alive = false; }
    tick(room); // alive==1 -> emergeBunker

    check(gb.goalBuried === false, 'goal emerged once one survivor remained');
    check(countId(gb, c.tileMap.goal.id) === lidCount, 'lid cells restored to goal');

    survivor.x = gb.bunkerLoc.x;
    survivor.y = gb.bunkerLoc.y;
    survivor.velX = 0; survivor.velY = 0;
    for (let f = 0; f < 5; f++) { tick(room); }
    check(room.game.firstPlaceSig != null || survivor.reachedGoal === true,
        'survivor on the emerged goal won the round');
})();

// ---- Void: everyone dies -> overview, no winner ----
(function voidAllDead() {
    const room = buildRoom('bunker-void', 4, picked.map);
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();
    for (let f = 0; f < 20; f++) { tick(room); }
    const ids = Object.keys(room.playerList);
    for (let i = 0; i < ids.length; i++) { room.playerList[ids[i]].alive = false; }
    tick(room);
    check(room.game.currentState === c.stateMap.overview, 'all-dead round voided to overview');
    check(room.game.firstPlaceSig == null, 'no winner on a voided round');
})();

// ---- Safety valve: campers past maxRoundTime -> void ----
(function stalemateVoid() {
    const room = buildRoom('bunker-stale', 4, picked.map);
    const gb = room.game.gameBoard;
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();
    const ids = Object.keys(room.playerList);
    room.playerList[ids[2]].alive = false;
    room.playerList[ids[3]].alive = false;
    for (let f = 0; f < 10; f++) { tick(room); } // stamp bunkerStartTime; ring freezes
    check(gb.goalBuried === true, 'still buried with 2 campers alive');
    fakeNow += (c.brutalRounds.bunker.maxRoundTime + 5) * 1000;
    tick(room);
    check(room.game.currentState === c.stateMap.overview, 'stalemate voided past maxRoundTime');
    check(room.game.firstPlaceSig == null, 'no winner on a stalemate void');
})();

Date.now = realNow;
if (failures > 0) { console.log('\nBunker test FAILED with ' + failures + ' error(s).'); process.exit(1); }
console.log('\nBunker test passed.');
process.exit(0);
