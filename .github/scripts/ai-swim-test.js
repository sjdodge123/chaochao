'use strict';

// Real-engine headless test for "AI punch-swims across water" (water-tile follow-up).
//
// Two claims, both on synthetic grid maps built here so the geometry is exact:
//
//   [A] Dry-lane preference (pathfinding, deterministic). Two equal-length corridors
//       run from a shared start to a shared goal — one ALL GRASS, one ALL WATER —
//       walled apart by empty cells. cellGraph.findPathToNearestGoal (noise off) must
//       return the grass corridor: water is a real lane now, but a clearly-faster dry
//       lane still wins (tileWeight water 3.0 > grass 1.0 at equal length).
//
//   [B] Water-only crossing completes (full live tick loop). A map whose ONLY route
//       from the left gate to the right goal crosses a full-height water band (no dry
//       detour). A bot must punch-swim across and finish — the round reaches gameOver —
//       proving a pinned water playlist can't stall the way the all-ice playlist did.
//
// Like ai-telegraph-engine-test.js this boots the REAL server modules and drives
// room.update(dt) with Date.now mocked into a per-tick clock (a tight synchronous loop
// freezes wall-clock, so cooldowns/stamina regen never advance). Math.random is seeded
// (a deterministic PRNG) for the whole run so the bot-brain jitter can't make [B] flaky
// — ai-telegraph-engine-test.js is ~5% flaky precisely because it leaves it unseeded.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const cellGraph = require(path.join(repoRoot, 'server', 'cellGraph.js'));

const T = config.tileMap;
const GRASS = T.fast.id;     // 2
const WATER = T.water.id;    // 11
const EMPTY = T.empty.id;    // 10
const GOAL = T.goal.id;      // 6
const DT = config.serverTickSpeed / 1000;

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('  ok  - ' + msg); }
    else { failures++; console.log('::error::FAIL - ' + msg); }
}

// Deterministic PRNG (mulberry32) installed over Math.random for the whole run so the
// AI brain's per-race jitter (skill, wander, off-moments) is reproducible.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Recording fake io so messageRoomBySig() doesn't throw (we don't assert on emits here).
const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

// Build a full (reconstructed) map from a regular grid of sites. `tileAt(col,row)`
// returns the tile id for each grid cell. startEdges/name carried through.
const COLS = [76, 228, 380, 532, 684, 836, 988, 1140, 1290]; // ~152px spacing across 1366
const ROWS = [77, 230, 384, 538, 691];                        // ~153px spacing across 768
function buildMap(name, startEdges, tileAt) {
    const sites = [];
    for (let col = 0; col < COLS.length; col++) {
        for (let row = 0; row < ROWS.length; row++) {
            sites.push({ x: COLS[col], y: ROWS[row], id: tileAt(col, row) });
        }
    }
    return mapFormat.reconstruct({
        bbox: { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight },
        sites: sites, hazards: [], startEdges: startEdges, name: name, author: 'test', id: 'swimtest-' + name
    });
}

function tileIdAt(map, x, y) {
    let best = Infinity, id = -1;
    for (let i = 0; i < map.cells.length; i++) {
        const cl = map.cells[i];
        if (!cl || !cl.site) { continue; }
        const dx = cl.site.x - x, dy = cl.site.y - y, d = dx * dx + dy * dy;
        if (d < best) { best = d; id = cl.id; }
    }
    return id;
}
// voronoiId -> tile id, so we can inspect a returned path (a list of voronoiIds).
function idByVoronoi(map) {
    const m = {};
    for (let i = 0; i < map.cells.length; i++) {
        if (map.cells[i] && map.cells[i].site) { m[map.cells[i].site.voronoiId] = map.cells[i].id; }
    }
    return m;
}

const realNow = Date.now;
const realRandom = Math.random;
let clock = 1000000;

function bootRoom(sig, map, profile) {
    const game = require(path.join(repoRoot, 'server', 'game.js'));
    const room = game.getRoom(sig, 8);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    const bid = sig + '-bot0';
    const bot = room.world.createNewBot(bid, profile);
    room.playerList[bid] = bot;
    room.game.determineGameState(bot);
    room.game.startLobby(); room.game.startGated(); room.game.startRace();
    return { room, bot };
}

try {
    Date.now = () => clock;
    Math.random = mulberry32(0xC0FFEE);

    // ----------------------------------------------------------------------
    console.log('[A] bot routes through a GRASS lane over an equal-length WATER lane');
    {
        // col 0 = shared start (grass, all rows connected vertically).
        // col 8 = shared goal (all rows goal).
        // row 0 (top)    cols 1..7 = grass  -> the dry corridor
        // row 4 (bottom) cols 1..7 = water  -> the wet corridor (same length)
        // rows 1..3 cols 1..7 = empty walls -> the two corridors only meet at col0/col8
        const map = buildMap('drylane', ['left'], (col, row) => {
            if (col === 0) { return GRASS; }
            if (col === 8) { return GOAL; }
            if (row === 0) { return GRASS; }
            if (row === 4) { return WATER; }
            return EMPTY;
        });
        // Query from the left-middle (col0, row2). Noise OFF for a deterministic route.
        const start = { x: COLS[0], y: ROWS[2] };
        const route = cellGraph.findPathToNearestGoal(map, start, { noiseAmount: 0 });
        check(route != null, 'a route to the goal exists');
        if (route != null) {
            const idOf = idByVoronoi(map);
            const waterHops = route.path.filter(vid => idOf[vid] === WATER).length;
            const grassHops = route.path.filter(vid => idOf[vid] === GRASS).length;
            check(waterHops === 0, 'the chosen route uses ZERO water cells (took the dry lane); water hops=' + waterHops);
            check(grassHops > 0, 'the chosen route runs through the grass lane; grass hops=' + grassHops);
        }

        // Sanity: with the grass corridor turned to EMPTY (walled off), the SAME query now
        // routes through the water corridor — proving water is a usable lane, not blocked.
        const wetOnly = buildMap('wetonly', ['left'], (col, row) => {
            if (col === 0) { return GRASS; }
            if (col === 8) { return GOAL; }
            if (row === 4) { return WATER; }
            return EMPTY; // top corridor removed
        });
        const wetRoute = cellGraph.findPathToNearestGoal(wetOnly, { x: COLS[0], y: ROWS[2] }, { noiseAmount: 0 });
        check(wetRoute != null, 'water remains a routable lane when it is the only option');
        if (wetRoute != null) {
            const idOf = idByVoronoi(wetOnly);
            check(wetRoute.path.some(vid => idOf[vid] === WATER), 'that fallback route does cross water');
        }
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] a bot punch-swims across a water-only crossing and the round ends');
    {
        // Left gate -> right goal. A full-height water band (cols 4 & 5, every row) is the
        // ONLY way across: cols 0..3 grass, cols 6..7 grass, col 8 goal. No dry detour.
        const map = buildMap('swimcross', ['left'], (col) => {
            if (col === 8) { return GOAL; }
            if (col === 4 || col === 5) { return WATER; }
            return GRASS;
        });

        // Confirm the map really is water-only: the optimal route must cross water.
        const probe = cellGraph.findPathToNearestGoal(map, { x: COLS[0], y: ROWS[2] }, { noiseAmount: 0 });
        const idOf = idByVoronoi(map);
        check(probe != null && probe.path.some(vid => idOf[vid] === WATER),
            'the test map has no dry detour (optimal route crosses water)');

        const { room, bot } = bootRoom('swim-cross', map, { id: 'fish', name: 'Fish', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        // Single racer: make the first finish win outright so reaching the goal drives the
        // state machine all the way to gameOver (proves the round concludes, no stall).
        const maxTicks = 2400; // ~80s game time; the stamina-paced crossing finishes well under this
        let stroked = false, everOnWater = false, reachedGoalAt = -1;
        let f = 0;
        for (; f < maxTicks; f++) {
            room.game.notchesToWin = 0; // first finish = outright win -> gameOver on goal touch
            room.update(DT);
            clock += config.serverTickSpeed;
            if (bot.onWater) { everOnWater = true; }
            if (bot.attack || bot.charging) { stroked = true; }
            if (reachedGoalAt < 0 && bot.reachedGoal) { reachedGoalAt = f; }
            if (room.game.currentState === config.stateMap.gameOver) { break; }
        }
        check(everOnWater, 'the bot actually entered the water band');
        check(stroked, 'the bot threw swim strokes (punched) while crossing');
        check(bot.reachedGoal === true, 'the bot reached the goal across the water (reachedGoal at tick ' + reachedGoalAt + ')');
        check(room.game.currentState === config.stateMap.gameOver,
            'the round reached gameOver (state=' + room.game.currentState + ') — a water-only playlist does not stall');
        if (reachedGoalAt >= 0) {
            console.log('  ..  - crossing completed in ' + reachedGoalAt + ' ticks (~' + (reachedGoalAt * DT).toFixed(1) + 's)');
        }
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
}

console.log('');
if (failures > 0) {
    console.log('AI-swim test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('AI-swim test passed.');
process.exit(0);
