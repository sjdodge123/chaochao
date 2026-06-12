'use strict';

// Real-engine headless test for the Bumper Wall hazard (config.hazards.bumperWall):
// a static pinball-slingshot line that flings karts away on contact via the same
// map-owned punch machinery the round bumpers use.
//
//   [A] Geometry (pure). BumperWall's rotated corners, quadtree extents, and
//       nearest-point-on-centerline math are correct, and handleHit spawns a
//       map-owned bumper punch at the contact point for players/pucks only.
//
//   [B] Bounce (full live tick loop). A kart driven straight into a vertical wall
//       gated across a corridor gets a "punch" emit + the playerPunched cue, is
//       kicked back (velX flips negative), never ends up on the far side of the
//       wall, and tallies a pinball bonk (bumperHitCount).
//
//   [C] Bots route around (full live tick loop). On a corridor whose upper lane is
//       walled but whose lower half stays open, a bot still finishes the race —
//       the wall's staticHazardCells penalty + repulsion don't trap it.
//
// Like ai-bumper-cross-test.js this boots the REAL server modules and drives
// room.update(dt) with Date.now mocked into a per-tick clock, Math.random seeded
// (mulberry32), and setTimeout queued against the mocked clock (so the 100ms
// punch linger actually expires and the wall can bounce more than once).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { BumperWall } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));
const { Circle } = require(path.join(repoRoot, 'server', 'entities', 'shapes.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const WALL = config.hazards.bumperWall; // id 902
const WALL_LEN = WALL.width;

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

// Recording fake io: every room emit lands in `events` so the test can assert on
// the punch / playerPunched traffic the wall produces.
const events = [];
const fakeIo = {
    to() { return { emit(name, data) { events.push({ name: name, data: data }); } }; },
    sockets: { emit(name, data) { events.push({ name: name, data: data }); } }
};
messenger.build(fakeIo);

// Same single-corridor grid as ai-bumper-cross-test.js: walkable rows from
// `lanes`, goal in the rightmost column of each lane, everything else a hole.
const COLS = [76, 228, 380, 532, 684, 836, 988, 1140, 1290];
const ROWS = [77, 280, 384, 488, 691];
const WALL_X = COLS[4];                          // 684 — mid-corridor column
const CORRIDOR_TOP = (ROWS[1] + ROWS[2]) / 2;    // 332
function buildMap(name, hazards, lanes) {
    const sites = [];
    for (let col = 0; col < COLS.length; col++) {
        for (let row = 0; row < ROWS.length; row++) {
            let id = EMPTY;
            if (lanes.indexOf(row) !== -1) { id = (col === 8) ? GOAL : GRASS; }
            sites.push({ x: COLS[col], y: ROWS[row], id: id });
        }
    }
    return mapFormat.reconstruct({
        bbox: { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight },
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'walltest-' + name
    });
}

const realNow = Date.now;
const realRandom = Math.random;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
let clock = 1000000;
let timers = [];
function fireDueTimers() {
    const due = [];
    timers = timers.filter(t => { if (t.at <= clock) { due.push(t); return false; } return true; });
    for (const t of due) { t.fn.apply(null, t.args); }
}

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
    Math.random = mulberry32(0x9A11);
    global.setTimeout = function (fn, ms) {
        const handle = { at: clock + (ms || 0), fn: fn, args: Array.prototype.slice.call(arguments, 2) };
        timers.push(handle);
        return handle;
    };
    global.clearTimeout = function (handle) { timers = timers.filter(t => t !== handle); };

    // ----------------------------------------------------------------------
    console.log('[A] BumperWall geometry + handleHit');
    {
        // Vertical wall: anchor (500,300), angle 90 -> centerline down to (500, 300+len).
        const wall = new BumperWall(500, 300, WALL.width, WALL.height, 90, WALL.color, 'wall-a', 'sig-a');
        const ext = wall.getExtents();
        check(Math.abs(ext.minX - (500 - WALL.height / 2)) < 0.001 && Math.abs(ext.maxX - (500 + WALL.height / 2)) < 0.001,
            'extents span the wall thickness on x (' + ext.minX.toFixed(1) + '..' + ext.maxX.toFixed(1) + ')');
        check(Math.abs(ext.minY - 300) < 0.001 && Math.abs(ext.maxY - (300 + WALL_LEN)) < 0.001,
            'extents span the wall length on y (' + ext.minY.toFixed(1) + '..' + ext.maxY.toFixed(1) + ')');
        const mid = wall.closestOnLine(450, 300 + WALL_LEN / 2);
        check(Math.abs(mid.x - 500) < 0.001 && Math.abs(mid.y - (300 + WALL_LEN / 2)) < 0.001,
            'closestOnLine projects onto the face');
        const below = wall.closestOnLine(500, 300 + WALL_LEN + 200);
        check(Math.abs(below.y - (300 + WALL_LEN)) < 0.001, 'closestOnLine clamps to the end cap');

        // A kart-sized circle overlapping the face collides; a distant one doesn't.
        // (488: 3px of overlap — the rect-circle test is strict, so exact tangency
        // doesn't count, which is fine for continuous per-tick motion.)
        const kart = new Circle(488, 360, config.playerBaseRadius, 'red');
        kart.isPlayer = true;
        check(kart.inBounds(wall) === true, 'a kart touching the face is in bounds');
        const far = new Circle(560, 360, config.playerBaseRadius, 'red');
        check(far.inBounds(wall) === false, 'a kart ' + (560 - 500) + 'px off the face is not in bounds');

        wall.handleHit(kart);
        check(wall.punch != null, 'handleHit on a player spawns a punch');
        if (wall.punch != null) {
            check(wall.punch.mapOwned === true && wall.punch.type === 'bumper',
                'the punch is map-owned with the bumper type (pinball tally + no team gate)');
            check(Math.abs(wall.punch.x - 500) < 0.001 && Math.abs(wall.punch.y - 360) < 0.001,
                'the punch sits at the nearest point on the centerline (perpendicular kick)');
        }
        const wall2 = new BumperWall(500, 300, WALL.width, WALL.height, 90, WALL.color, 'wall-a2', 'sig-a');
        wall2.handleHit({ isProjectile: true, x: 500, y: 320 });
        check(wall2.punch == null, 'a non-player/non-puck object does not trigger the wall');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] a kart driven into the wall is flung back (live tick loop)');
    {
        // Wall gates the single corridor lane (row 2, y 332..436): anchored at the
        // corridor top edge, angle 90 spans past its floor. No way around on purpose —
        // this lane exists to measure the bounce, not to finish the race.
        const map = buildMap('wallgate', [{ id: WALL.id, x: WALL_X, y: CORRIDOR_TOP, angle: 90 }], [2]);
        const { room, bot } = bootRoom('wall-bounce', map, { id: 'crash', name: 'Crash', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const hazardIds = Object.keys(room.game.gameBoard.hazardList);
        check(hazardIds.length === 1, 'the wall spawned from the map hazard entry');
        const hz = room.game.gameBoard.hazardList[hazardIds[0]];
        check(hz != null && hz.isWall === true && hz.id === WALL.id, 'the spawned hazard is a BumperWall (id ' + WALL.id + ')');

        // The full-state payload (newHazards) must carry [ownerId, id, x, y, angle]
        // so the client can draw the wall from its anchor + angle.
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === WALL.id && packet[0][2] === WALL_X &&
            packet[0][3] === CORRIDOR_TOP && packet[0][4] === 90,
            'compressor.newHazards carries the wall as [ownerId, ' + WALL.id + ', x, y, angle]');

        // Hand-drive the kart: park it mid-lane and shove it at the wall every tick
        // until contact. isAI=false detaches the bot brain so nothing steers around.
        bot.isAI = false;
        bot.x = bot.newX = 560; bot.y = bot.newY = 384;
        bot.velX = 0; bot.velY = 0;

        events.length = 0;
        let punchTick = -1, punchedCue = false, kickedBack = false, maxX = -Infinity, minXAfterHit = Infinity;
        for (let f = 0; f < 240; f++) { // ~8s game time
            if (punchTick < 0) { bot.velX = 150; bot.velY = 0; } // approach at cruise-ish speed
            room.update(DT);
            clock += config.serverTickSpeed;
            fireDueTimers();
            if (bot.x > maxX) { maxX = bot.x; }
            if (punchTick < 0) {
                for (const e of events) {
                    if (e.name === 'punch') { punchTick = f; }
                    if (e.name === 'playerPunched') { punchedCue = true; }
                }
                events.length = 0;
            } else {
                for (const e of events) { if (e.name === 'playerPunched') { punchedCue = true; } }
                events.length = 0;
                if (bot.x < minXAfterHit) { minXAfterHit = bot.x; }
                if (bot.velX < 0) { kickedBack = true; }
                if (f > punchTick + 45) { break; } // ~1.5s of post-bounce coasting is plenty
            }
        }
        check(punchTick >= 0, 'driving into the wall emitted a map punch (tick ' + punchTick + ')');
        check(punchedCue, 'the victim got the playerPunched hit cue');
        check(kickedBack, 'the kart was kicked back off the face (velX flipped negative)');
        check(maxX < WALL_X, 'the kart never ended a tick past the wall line (max x=' + maxX.toFixed(1) + ' < ' + WALL_X + ')');
        check(minXAfterHit < maxX - 10, 'the kick produced real displacement (fell back ' + (maxX - minXAfterHit).toFixed(1) + 'px)');
        check(bot.bumperHitCount >= 1, 'the bounce tallied a pinball bonk (bumperHitCount=' + bot.bumperHitCount + ')');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] a bot routes around a half-corridor wall and still finishes');
    {
        // Three walkable lanes (rows 1-3, y ~178..540). The wall hangs from the
        // corridor ceiling (anchor y=178.5, angle 90, spans ~120px), leaving the
        // bottom ~240px open: the wall must read as "route around", never "trap".
        const topEdge = (ROWS[0] + ROWS[1]) / 2; // 178.5
        const map = buildMap('wallhalf', [{ id: WALL.id, x: WALL_X, y: topEdge, angle: 90 }], [1, 2, 3]);
        const { room, bot } = bootRoom('wall-route', map, { id: 'router', name: 'Router', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const maxTicks = 2400; // ~80s; an unobstructed run takes a fraction of this
        let reachedGoalAt = -1;
        for (let f = 0; f < maxTicks; f++) {
            room.game.notchesToWin = 0; // first finish = outright win -> gameOver on goal touch
            room.update(DT);
            clock += config.serverTickSpeed;
            fireDueTimers();
            if (reachedGoalAt < 0 && bot.reachedGoal) { reachedGoalAt = f; }
            if (room.game.currentState === config.stateMap.gameOver) { break; }
        }
        check(bot.reachedGoal === true, 'the bot finished past the half-corridor wall (tick ' + reachedGoalAt + ')');
        check(room.game.currentState === config.stateMap.gameOver,
            'the round reached gameOver (state=' + room.game.currentState + ') — a walled corridor does not stall the race');
    }

    // ----------------------------------------------------------------------
    console.log('\n[D] hazards whose coordinates sum to the same total all spawn');
    {
        // Regression (review finding): the per-hazard mapID used to hash only the
        // coordinate SUM, so (560,400) and (600,360) — or two same-kind hazards at
        // (500,300) and (450,350) — collided and one silently vanished at spawn.
        const map = buildMap('wallidsum', [
            { id: config.hazards.bumper.id, x: 560, y: 400 },
            { id: WALL.id, x: 600, y: 360, angle: 90 },
            { id: config.hazards.bumper.id, x: 500, y: 300 },
            { id: config.hazards.bumper.id, x: 450, y: 350 }
        ], [2]);
        const { room } = bootRoom('wall-idsum', map, { id: 'idsum', name: 'IdSum', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        const spawned = Object.values(room.game.gameBoard.hazardList);
        check(spawned.length === 4, 'all 4 hazards spawned despite equal x+y sums (got ' + spawned.length + ')');
        check(spawned.filter(h => h.isWall).length === 1 && spawned.filter(h => !h.isWall).length === 3,
            'the survivor mix is right: 1 wall + 3 bumpers');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Bumper-wall test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Bumper-wall test passed.');
process.exit(0);
