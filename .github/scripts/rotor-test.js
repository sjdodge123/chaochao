'use strict';

// Real-engine headless test for the Rotor hazard (config.hazards.rotor): a bumper
// head that orbits a fixed pivot at a constant angular speed, flinging karts/pucks
// off the head via the same map-owned punch the round bumpers use. First consumer
// of the framework's streamAngle wire slot.
//
//   [A] Geometry + advance(dt) (pure). The head is seeded onto the orbit at the
//       starting angle; advance(dt) rotates the sweep by angularSpeed*dt and keeps
//       the head exactly orbitRadius from the pivot; the angle wraps in [0,360);
//       handleHit spawns a map-owned bumper punch at the head for players/pucks.
//
//   [B] Wire (compressor). sendHazardUpdates emits a 4-field row [ownerId,x,y,angle]
//       for the rotor (streamAngle slot), where bumpers stay at 3 fields; the angle
//       advances tick over tick. newHazards carries the rotor as a creation row.
//
//   [C] Spawn + live tick (full loop). The rotor spawns from a map entry, sweeps
//       (its head x/y changes over ticks while staying on the orbit), and a kart
//       parked under the sweep gets bonked (punch emit + kicked back).
//
// Boots the REAL server modules and drives room.update(dt) with Date.now mocked
// into a per-tick clock, Math.random seeded (mulberry32), and setTimeout queued
// against the mocked clock (so the 100ms punch linger expires between bonks).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { Rotor } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const ROT = config.hazards.rotor; // id 903

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

function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

const events = [];
const fakeIo = {
    to() { return { emit(name, data) { events.push({ name: name, data: data }); } }; },
    sockets: { emit(name, data) { events.push({ name: name, data: data }); } }
};
messenger.build(fakeIo);

// One wide open lane so the rotor (placed mid-lane) has karts to catch.
const COLS = [76, 228, 380, 532, 684, 836, 988, 1140, 1290];
const ROWS = [280, 384, 488];
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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'rotortest-' + name
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
    console.log('[A] Rotor geometry + advance(dt) + handleHit');
    {
        const PX = 500, PY = 400;
        const rotor = new Rotor(PX, PY, ROT.radius, ROT.color, 'rot-a', 'sig-a', 0);
        check(Math.abs(rotor.x - (PX + ROT.orbitRadius)) < 1e-6 && Math.abs(rotor.y - PY) < 1e-6,
            'head seeded onto the orbit at angle 0 (east of pivot)');
        check(Math.abs(dist(rotor.x, rotor.y, PX, PY) - ROT.orbitRadius) < 1e-6,
            'head sits exactly orbitRadius from the pivot');

        // One second of advancing should rotate by ~angularSpeed degrees and keep
        // the head on the orbit the whole way.
        let onOrbit = true;
        const steps = Math.round(1 / DT);
        for (let i = 0; i < steps; i++) {
            rotor.advance(DT);
            rotor.move(); // commit (gameBoard does this via hazard.update())
            if (Math.abs(dist(rotor.x, rotor.y, PX, PY) - ROT.orbitRadius) > 1e-6) { onOrbit = false; }
        }
        check(onOrbit, 'head stays exactly on the orbit across a full second of ticks');
        check(Math.abs(rotor.angle - ROT.angularSpeed) < 1.0,
            'one second of advance() ~= angularSpeed degrees (got ' + rotor.angle.toFixed(1) + ')');

        // Angle wraps into [0,360).
        const wrapRotor = new Rotor(PX, PY, ROT.radius, ROT.color, 'rot-w', 'sig-a', 350);
        for (let i = 0; i < Math.round(1 / DT); i++) { wrapRotor.advance(DT); }
        check(wrapRotor.angle >= 0 && wrapRotor.angle < 360, 'angle stays in [0,360) after wrapping past 360');

        // A non-finite start angle (crafted map: JSON 1e309 -> Infinity) is
        // sanitized to 0, not fed into Math.cos/sin to make NaN coordinates.
        const inf = new Rotor(PX, PY, ROT.radius, ROT.color, 'rot-inf', 'sig-a', Infinity);
        check(Number.isFinite(inf.x) && Number.isFinite(inf.y) && inf.angle === 0,
            'a non-finite start angle is sanitized to 0 (finite head coords)');

        // Lightning scales the sweep rate (rotor has no along-rail speed).
        const fast = new Rotor(PX, PY, ROT.radius, ROT.color, 'rot-fast', 'sig-a', 0);
        const base = fast.angularSpeed;
        fast.scaleSpeed(3);
        check(Math.abs(fast.angularSpeed - base * 3) < 1e-6, 'scaleSpeed multiplies the angular sweep (Lightning hook)');

        // handleHit spawns a map-owned bumper punch at the head, for players/pucks only.
        rotor.punch = null;
        rotor.handleHit({ isPlayer: true, x: rotor.x, y: rotor.y });
        check(rotor.punch != null && rotor.punch.mapOwned === true && rotor.punch.type === 'bumper',
            'handleHit on a player spawns a map-owned bumper punch (pinball tally)');
        check(rotor.punch != null && Math.abs(rotor.punch.x - rotor.x) < 1e-6 && Math.abs(rotor.punch.y - rotor.y) < 1e-6,
            'the punch sits at the head (the moving contact point)');
        const r2 = new Rotor(PX, PY, ROT.radius, ROT.color, 'rot-x', 'sig-a', 0);
        r2.handleHit({ isProjectile: true, x: r2.x, y: r2.y });
        check(r2.punch == null, 'a non-player/non-puck object does not trigger the rotor');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire: streamAngle row (compressor)');
    {
        const rotor = new Rotor(500, 400, ROT.radius, ROT.color, 'rot-wire', 'sig-b', 0);
        rotor.advance(DT); rotor.move();
        const list = {};
        list[rotor.ownerId] = rotor;
        const row = compressor.sendHazardUpdates(list)[0];
        check(row.length === 4, 'rotor per-tick row has 4 fields [ownerId,x,y,angle] (streamAngle slot)');
        check(Math.abs(row[3] - rotor.angle) < 1e-6, 'row[3] carries the live sweep angle');
        const a0 = row[3];
        rotor.advance(DT); rotor.move();
        const a1 = compressor.sendHazardUpdates(list)[0][3];
        check(a1 !== a0, 'the streamed angle advances tick over tick');

        const created = JSON.parse(compressor.newHazards(list));
        check(created.length === 1 && created[0][1] === ROT.id, 'newHazards carries the rotor as a creation row (id ' + ROT.id + ')');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Spawn from map + sweep + bonk (live tick loop)');
    {
        // Pivot mid-lane (row 1, y=384) at column 4. The head orbits 70px, so it
        // sweeps through the lane above/below the pivot.
        const PX = COLS[4], PY = ROWS[1];
        const map = buildMap('sweep', [{ id: ROT.id, x: PX, y: PY, angle: 0 }], [0, 1, 2]);
        const { room, bot } = bootRoom('rotor-sweep', map, { id: 'spin', name: 'Spin', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const ids = Object.keys(room.game.gameBoard.hazardList);
        check(ids.length === 1, 'the rotor spawned from the map hazard entry');
        const hz = room.game.gameBoard.hazardList[ids[0]];
        check(hz != null && hz.id === ROT.id && hz.moveable === true && typeof hz.advance === 'function',
            'the spawned hazard is a moveable Rotor with an advance() hook');

        // Let it sweep a few ticks; the head must move while staying on the orbit.
        const h0x = hz.x, h0y = hz.y;
        let stillOnOrbit = true;
        for (let f = 0; f < 30; f++) {
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (Math.abs(dist(hz.x, hz.y, PX, PY) - ROT.orbitRadius) > 0.5) { stillOnOrbit = false; }
        }
        check(dist(hz.x, hz.y, h0x, h0y) > 5, 'the head swept to a new position over 30 ticks');
        check(stillOnOrbit, 'the head stayed on its orbit throughout the sweep');

        // Park the bot right on the orbit circle in the rotor's path and hold it
        // there; within a full revolution the sweeping head must bonk it.
        bot.isAI = false;
        bot.x = bot.newX = PX + ROT.orbitRadius; bot.y = bot.newY = PY; // due east — on the orbit
        bot.velX = 0; bot.velY = 0;
        events.length = 0;
        let punched = false;
        const revTicks = Math.round((360 / ROT.angularSpeed) / DT) + 10;
        for (let f = 0; f < revTicks; f++) {
            bot.velX = 0; bot.velY = 0; // keep it parked on the orbit
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            for (const e of events) { if (e.name === 'punch') { punched = true; } }
            if (punched) { break; }
        }
        check(punched, 'a kart parked on the orbit gets bonked within one revolution');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Rotor test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Rotor test passed.');
process.exit(0);
