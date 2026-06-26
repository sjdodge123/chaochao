'use strict';

// Focused regression harness for the Bunker lava fixes (Task 4). Boots a real room
// on a committed map, forces a Bunker round, and asserts:
//   (1) START DELAY  — the ring stays fully open (no lava) until startDelay seconds.
//   (2) CREEP RATE   — once the delay passes, the ring closes by exactly ringSpeed/tick.
//   (3) WALKABLE GOAL — reproduces a lava-ringed survivor (no path to the buried goal),
//                       then proves emergeBunker carves a corridor so a path EXISTS.
// Uses smoke-test techniques: pin a map via the preview path, force states, and drive a
// mocked Date.now clock (a tight synchronous loop freezes wall-clock).

const fs = require('fs');
const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const game = require(path.join(repoRoot, 'server', 'game.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const cellGraph = require(path.join(repoRoot, 'server', 'cellGraph.js'));
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));

messenger.build({ to() { return { emit() {} }; }, sockets: { emit() {} } });

const BUNKER = config.brutalRounds.bunker;
const RACING = config.stateMap.racing;
let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.log('::error::' + msg); } else { console.log('  ok: ' + msg); } }

// Boot a room on a committed map (preview path) and force a Bunker round on it.
function bootBunkerRoom(mapFile) {
    let map = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', mapFile), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }
    const room = game.getRoom('bunker-test', 4);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    const p = room.world.createNewPlayer('surv');
    room.playerList['surv'] = p;
    room.game.determineGameState(p);
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();
    const gb = room.game.gameBoard;
    gb.brutalRound = true;
    gb.brutalConfig = { brutal: true, brutalTypes: [BUNKER.id] };
    gb.applyBrutalBunkerRound();
    return { room: room, gb: gb, player: p, map: gb.currentMap };
}

// Pick the first committed map that yields a usable buried-goal island.
function pickBunkerMap() {
    const files = fs.readdirSync(path.join(repoRoot, 'client', 'maps')).filter(f => f.endsWith('.json'));
    for (const f of files) {
        try {
            const ctx = bootBunkerRoom(f);
            if (ctx.gb.bunkerRingActive && ctx.gb.bunkerLidIds && ctx.gb.bunkerLidIds.length > 0) {
                return { file: f, ctx: ctx };
            }
        } catch (e) { /* try next map */ }
    }
    return null;
}

const realNow = Date.now;
let clock = 1000000;
Date.now = () => clock;
try {
    const picked = pickBunkerMap();
    if (picked == null) { check(false, 'could not set up a Bunker round on any committed map'); throw new Error('no map'); }
    console.log('Bunker round pinned on ' + picked.file);
    const gb = picked.ctx.gb;
    const player = picked.ctx.player;
    const map = picked.ctx.map;

    // ---- (1) START DELAY: ring holds fully open for startDelay seconds ----
    // Baseline lava = whatever the MAP authored (some maps have lava terrain); the ring
    // must not ADD any while the grace window holds the front fully open.
    const lavaId = config.tileMap.lava.id;
    const countLava = () => { let n = 0; for (let i = 0; i < map.cells.length; i++) { if (map.cells[i].id === lavaId) n++; } return n; };
    const baselineLava = countLava();
    const openLine = gb.collapseLine;            // opening value = maxDist + 50
    gb.bunkerRingTick(RACING);                   // first tick stamps bunkerStartTime = clock
    check(gb.collapseLine === openLine, '(1) ring stays fully open at t=0 (no early creep)');
    clock += (BUNKER.startDelay - 1) * 1000;     // still inside the grace window
    gb.bunkerRingTick(RACING);
    check(gb.collapseLine === openLine, '(1) ring still open at t=' + (BUNKER.startDelay - 1) + 's (< startDelay ' + BUNKER.startDelay + 's)');
    check(countLava() === baselineLava, '(1) no NEW lava forms during the start delay (baseline ' + baselineLava + ' authored cells unchanged)');

    // ---- (2) CREEP RATE: after the delay, one tick shrinks by exactly ringSpeed ----
    clock += 2 * 1000;                            // now past startDelay
    const before = gb.collapseLine;
    gb.bunkerRingTick(RACING);
    const delta = before - gb.collapseLine;
    check(Math.abs(delta - BUNKER.ringSpeed) < 1e-9, '(2) ring creeps by exactly ringSpeed (' + BUNKER.ringSpeed + ') once the delay passes; saw ' + delta.toFixed(4));

    // ---- (3) WALKABLE GOAL: lava-ring the survivor, then prove emerge carves a path ----
    // Close the ring fully so everything outside the tiny island is lava.
    gb.collapseLine = gb.bunkerArenaRadius;
    clock += 1000;
    gb.bunkerRingTick(RACING);
    // Strand the survivor: take the lava cell FARTHEST from the island and turn it back to
    // a lone safe patch, ringed by lava (the exact unwinnable case the fix targets).
    let far = null, farD = -1;
    for (let i = 0; i < map.cells.length; i++) {
        const cell = map.cells[i];
        if (cell.id !== lavaId) { continue; }
        const d = Math.hypot(gb.bunkerLoc.x - cell.site.x, gb.bunkerLoc.y - cell.site.y);
        if (d > farD) { farD = d; far = cell; }
    }
    check(far != null, '(3) found a lava-ringed patch to strand the survivor on');
    far.id = config.tileMap.normal.id;
    player.x = far.site.x; player.y = far.site.y;
    player.alive = true; player.reachedGoal = false; player.isZombie = false;

    const preCarve = cellGraph.findPathToNearestGoal(map, { x: player.x, y: player.y }, { goalSet: gb.bunkerLidIds });
    check(preCarve == null, '(3) BUG reproduced: no non-lava path from the survivor to the buried goal');

    gb.emergeBunker(); // raises the goal AND carves the guaranteed corridor

    const postCarve = cellGraph.findPathToNearestGoal(map, { x: player.x, y: player.y }, { goalSet: gb.bunkerLidIds });
    check(postCarve != null, '(3) FIX: a walkable path from the survivor to the risen goal now EXISTS');
    if (postCarve != null) {
        // Sanity: the carved corridor cells were registered as bunker-safe so a griefer's
        // instant tileSwap/ability can't re-lava them out from under the survivor.
        check(Object.keys(gb.bunkerSafeIds).length > gb.bunkerLidIds.length, '(3) carved corridor cells added to bunkerSafeIds (instant-relava protection)');
    }
} finally {
    Date.now = realNow;
}

if (failures > 0) { console.log('\nBunker-lava test FAILED (' + failures + ').'); process.exit(1); }
console.log('\nBunker-lava test passed.');
process.exit(0);
