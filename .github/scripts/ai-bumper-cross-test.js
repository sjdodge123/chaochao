'use strict';

// Real-engine headless test for "bots can time a moving-bumper rail crossing".
//
// Repro for the field report: on maps where a moving bumper's rail spans the only
// corridor to the goal, bots lined up in front of the rail and oscillated forever —
// hazardRepulsion treated the WHOLE swept segment as a permanent wall, so the gap
// never "opened" for them and they never attempted the crossing.
//
//   [A] Window predicate (pure, deterministic). railCrossingOpen must say CLOSED when
//       the bumper is bearing down on the bot's crossing point, and OPEN when the
//       bumper has just swept past it / is parked at the far end — including the
//       reflect-at-the-ends round trip in the prediction.
//
//   [B] Rail-only crossing completes (full live tick loop). A single-corridor map
//       whose ONLY route to the goal crosses a moving-bumper rail that sweeps the
//       corridor's full height. A bot must wait out the bumper and dart across —
//       the round reaches gameOver — instead of lining up at the rail forever.
//
// Like ai-swim-test.js this boots the REAL server modules and drives room.update(dt)
// with Date.now mocked into a per-tick clock and Math.random seeded (mulberry32) so
// the bot-brain jitter can't make [B] flaky.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const aiController = require(path.join(repoRoot, 'server', 'aiController.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const SLOW = T.slow.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const MOVING_BUMPER = config.hazards.movingBumper.id; // 901

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('  ok  - ' + msg); }
    else { failures++; console.log('::error::FAIL - ' + msg); }
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Recording fake io so messageRoomBySig() doesn't throw (no emit assertions here).
const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

// Single-corridor grid: row 2 is the only walkable lane (left start -> right goal),
// rows 1/3 squeezed in so the corridor is ~104px tall — fully swept by one 100px
// moving-bumper rail dropped at mid-corridor (origin at the corridor's top edge,
// angle 90 = sweeping straight down). No detour exists: time it or never finish.
const COLS = [76, 228, 380, 532, 684, 836, 988, 1140, 1290];
const ROWS = [77, 280, 384, 488, 691];
const RAIL_X = COLS[4];          // 684 — mid-corridor column
const CORRIDOR_TOP = (ROWS[1] + ROWS[2]) / 2;  // 332
function buildMap(name, hazards, tile) {
    const corridorTile = tile != null ? tile : GRASS;
    const sites = [];
    for (let col = 0; col < COLS.length; col++) {
        for (let row = 0; row < ROWS.length; row++) {
            let id = EMPTY;
            if (row === 2) { id = (col === 8) ? GOAL : corridorTile; }
            sites.push({ x: COLS[col], y: ROWS[row], id: id });
        }
    }
    return mapFormat.reconstruct({
        bbox: { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight },
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'bumpertest-' + name
    });
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
    Math.random = mulberry32(0xB0B0);

    // ----------------------------------------------------------------------
    console.log('[A] railCrossingOpen predicts the bumper, including end reflections');
    {
        const open = aiController._test.railCrossingOpen;
        check(typeof open === 'function', 'railCrossingOpen is exported for tests');
        if (typeof open === 'function') {
            // A vertical 100px rail at x=684, y 332..432, like map [B] below. The fake
            // bot sits 40px left of the rail line, level with the corridor middle.
            const rail = { x: RAIL_X, y: CORRIDOR_TOP, angle: 90, width: 100, lengthSq: 100 * 100 };
            const mkBumper = (t, outward) => ({
                x: RAIL_X, y: CORRIDOR_TOP + t, radius: 10,
                speed: config.hazards.movingBumper.speed,
                angle: outward ? 90 : -90, rail: rail, moveable: true
            });
            const bot = { x: RAIL_X - 40, y: CORRIDOR_TOP + 50, velX: 0, velY: 0 };
            // Bumper sitting right on the crossing point, heading at it -> closed.
            check(open(bot, mkBumper(50, true), DT) === false,
                'CLOSED with the bumper parked on the crossing point');
            // Bumper closing in from 30px up-rail -> closed.
            check(open(bot, mkBumper(20, true), DT) === false,
                'CLOSED with the bumper 30px away and closing');
            // Mid-rail, right behind the bumper as it sweeps away: on a 100px rail at
            // ~67px/s the bumper is back within strike of the midpoint ~0.7s after
            // passing it — quicker than any dash across — so mid-rail stays CLOSED.
            // (This is why the waiting behavior slides bots toward a rail END.)
            check(open(bot, mkBumper(78, true), DT) === false,
                'CLOSED mid-rail even right behind the bumper (round trip beats the dash)');
            // Crossing near a rail END while the bumper retreats into the long arm ->
            // the round trip back is the whole rail -> open.
            const botAtEnd = { x: RAIL_X - 40, y: CORRIDOR_TOP + 90, velX: 0, velY: 0 };
            check(open(botAtEnd, mkBumper(40, false), DT) === true,
                'OPEN near the rail end with the bumper retreating to the far end');
            // Same end-crossing but the bumper is heading FOR that end -> closed: the
            // prediction must include the reflection-free direct arrival.
            check(open(botAtEnd, mkBumper(60, true), DT) === false,
                'CLOSED near the rail end with the bumper inbound to that end');
        }
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] a bot times the rail and finishes a corridor only a bumper crossing serves');
    {
        // Rail origin at the corridor's top edge, sweeping down its full ~104px height:
        // there is no way around, only through — exactly the field-reported lineup spot.
        const map = buildMap('railgate', [{ id: MOVING_BUMPER, x: RAIL_X, y: CORRIDOR_TOP, angle: 90 }]);
        const { room, bot } = bootRoom('bumper-cross', map, { id: 'timer', name: 'Timer', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        check(Object.keys(room.game.gameBoard.hazardList).length > 0, 'the moving bumper spawned from the map hazard entry');

        const maxTicks = 2400; // ~80s game time; a timed crossing lands well under this
        let maxX = -Infinity, reachedGoalAt = -1, everNearRail = false, maxStallMs = 0;
        for (let f = 0; f < maxTicks; f++) {
            room.game.notchesToWin = 0; // first finish = outright win -> gameOver on goal touch
            room.update(DT);
            clock += config.serverTickSpeed;
            if (bot.x > maxX) { maxX = bot.x; }
            if (Math.abs(bot.x - RAIL_X) < 120) { everNearRail = true; }
            // Continuous no-headway time: the last-resort beeline fires at 4500ms of
            // this. A bot that TIMES the gap keeps moving (staging, sliding to the rail
            // end, darting) and never gets near it — pre-fix, the lineup blew past it.
            if (bot.alive && bot.ai && bot.ai.headwayAt != null) {
                const stall = clock - bot.ai.headwayAt;
                if (stall > maxStallMs) { maxStallMs = stall; }
            }
            if (reachedGoalAt < 0 && bot.reachedGoal) { reachedGoalAt = f; }
            if (room.game.currentState === config.stateMap.gameOver) { break; }
        }
        check(everNearRail, 'the bot reached the rail (drove the corridor)');
        check(maxX > RAIL_X + 60, 'the bot actually CROSSED the rail line (max x=' + maxX.toFixed(0) + ', rail at ' + RAIL_X + ')');
        check(maxStallMs < 4500, 'the crossing came from gap timing, not the stuck-beeline ram (max continuous stall ' + maxStallMs.toFixed(0) + 'ms < 4500ms)');
        check(bot.reachedGoal === true, 'the bot reached the goal beyond the bumper (reachedGoal at tick ' + reachedGoalAt + ')');
        check(room.game.currentState === config.stateMap.gameOver,
            'the round reached gameOver (state=' + room.game.currentState + ') — a rail-gated corridor does not stall');
        if (reachedGoalAt >= 0) {
            console.log('  ..  - crossing completed in ' + reachedGoalAt + ' ticks (~' + (reachedGoalAt * DT).toFixed(1) + 's)');
        }
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] SLOW-ground rail crossing darts behind the bumper (no stuck-beeline stall)');
    {
        // Codex-review repro: on slow tiles (terminal ~17px/s) no provably-safe
        // window exists on a 100px rail, and the original absolute dart bound was
        // unsatisfiable from the staging band — staged bots sat ~57s until the
        // 4.5s-stuck beeline rammed them through. The relative dart (go behind the
        // receding bumper while most of the pass's headroom remains) must cross
        // without ever needing the beeline.
        const map = buildMap('railgate-slow', [{ id: MOVING_BUMPER, x: RAIL_X, y: CORRIDOR_TOP, angle: 90 }], SLOW);
        const { room, bot } = bootRoom('bumper-cross-slow', map, { id: 'mud', name: 'Mud', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const maxTicks = 4200; // ~140s: the whole corridor is a ~17px/s crawl
        let maxX = -Infinity, reachedGoalAt = -1, maxStallMs = 0;
        for (let f = 0; f < maxTicks; f++) {
            room.game.notchesToWin = 0;
            room.update(DT);
            clock += config.serverTickSpeed;
            if (bot.x > maxX) { maxX = bot.x; }
            if (bot.alive && bot.ai && bot.ai.headwayAt != null) {
                const stall = clock - bot.ai.headwayAt;
                if (stall > maxStallMs) { maxStallMs = stall; }
            }
            if (reachedGoalAt < 0 && bot.reachedGoal) { reachedGoalAt = f; }
            if (room.game.currentState === config.stateMap.gameOver) { break; }
        }
        check(maxX > RAIL_X + 60, 'the bot CROSSED the rail line on slow ground (max x=' + maxX.toFixed(0) + ')');
        check(maxStallMs < 4500, 'no stuck-beeline was needed (max continuous stall ' + maxStallMs.toFixed(0) + 'ms < 4500ms)');
        check(bot.reachedGoal === true, 'the bot reached the goal (tick ' + reachedGoalAt + ', ~' + (reachedGoalAt * DT).toFixed(1) + 's)');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
}

console.log('');
if (failures > 0) {
    console.log('AI-bumper-cross test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('AI-bumper-cross test passed.');
process.exit(0);
