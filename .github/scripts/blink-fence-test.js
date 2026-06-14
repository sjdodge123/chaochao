'use strict';

// Real-engine headless test for the Blink Fence hazard (config.hazards.blinkFence):
// a laser barrier strung between two pylons that cycles OPEN (passable) -> WARN (a
// shimmer telegraph, still passable) -> SOLID (a wall you can't cross) -> back to
// OPEN. The framework's first TIMED PASSABILITY GATE — collision turns on and off,
// and SOLID is a non-lethal BOUNCE (engine.bounceOffFence), not a kill.
//
//   [A] Phase machine + bounce (pure). update(dt) walks open -> warn -> solid ->
//       open on the configured durations, publishing the phase as netState and the
//       `blocking` (warn|solid) AI flag. handleHit BOUNCES a crossing kart only while
//       SOLID (reverts the move + reflects the normal velocity); open/warn are no-ops.
//
//   [B] Wire (compressor). sendHazardUpdates emits a 5-field row whose [3] is null
//       (no streamAngle) and [4] is the phase int (netState); newHazards carries the
//       fence as a creation row with its angle at [4] and the phase in slot [7].
//
//   [C] Spawn + block vs pass (full tick loop). The fence spawns from a map entry; a
//       kart driving into the beam line is STOPPED on the near side while the beam is
//       solid (bounced), and crosses freely while it's open.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { BlinkFence } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const F = config.hazards.blinkFence; // id 909
const OPEN = 0, WARN = 1, SOLID = 2;

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

const events = [];
const fakeIo = {
    to() { return { emit(name, data) { events.push({ name: name, data: data }); } }; },
    sockets: { emit(name, data) { events.push({ name: name, data: data }); } }
};
messenger.build(fakeIo);

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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'fencetest-' + name
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
    Math.random = mulberry32(0x5E11);
    global.setTimeout = function (fn, ms) {
        const handle = { at: clock + (ms || 0), fn: fn, args: Array.prototype.slice.call(arguments, 2) };
        timers.push(handle);
        return handle;
    };
    global.clearTimeout = function (handle) { timers = timers.filter(t => t !== handle); };

    // ----------------------------------------------------------------------
    console.log('[A] Blink-fence phase machine + bounce');
    {
        // Horizontal beam from (100,100) along +x.
        const fn = new BlinkFence(100, 100, 0, 'bf-a', 'sig-a');
        check(fn.phase === OPEN && fn.netState === OPEN, 'starts open (phase/netState 0)');
        check(fn.moveable === false, 'is stationary (not moveable)');
        check(fn.blocking === false, 'open => not blocking');
        check(Math.abs(fn.ax - 100) < 1e-6 && Math.abs(fn.bx - (100 + F.width)) < 1e-6, 'beam centerline runs anchor -> anchor+width along angle');

        const step = () => fn.update(DT);
        let guard = 0;
        while (fn.phase === OPEN && guard++ < 2000) { step(); }
        check(fn.phase === WARN && fn.netState === WARN, 'enters warn after the open window');
        check(fn.blocking === true, 'warn => blocking (AI starts clearing the beam)');
        guard = 0;
        while (fn.phase === WARN && guard++ < 2000) { step(); }
        check(fn.phase === SOLID && fn.netState === SOLID, 'enters solid after the warn window');
        check(fn.blocking === true, 'solid => blocking');
        guard = 0;
        while (fn.phase === SOLID && guard++ < 2000) { step(); }
        check(fn.phase === OPEN && fn.netState === OPEN, 'returns to open, completing the cycle');

        // Bounce: a kart whose move would cross the SOLID beam is reverted to its side
        // and its normal velocity reflected. Player above the beam (y<100) driving down.
        fn.phase = SOLID;
        const cross = { isPlayer: true, alive: true, x: 150, y: 90, newX: 150, newY: 112, velX: 0, velY: 40, radius: 10 };
        fn.handleHit(cross);
        check(cross.newY < 100, 'solid beam reverts the crossing move (kart stays on its side, newY ' + cross.newY.toFixed(1) + ')');
        check(cross.velY < 0, 'solid beam reflects the inward velocity (velY now ' + cross.velY.toFixed(1) + ')');
        check(cross.bounced === true, 'the bounced kart is flagged');

        // Open / warn are passable — handleHit is a no-op.
        fn.phase = OPEN;
        const pass = { isPlayer: true, alive: true, x: 150, y: 90, newX: 150, newY: 112, velX: 0, velY: 40, radius: 10 };
        fn.handleHit(pass);
        check(pass.newY === 112 && pass.velY === 40, 'open beam lets the kart pass (no bounce)');
        fn.phase = WARN;
        const warnPass = { isPlayer: true, alive: true, x: 150, y: 90, newX: 150, newY: 112, velX: 0, velY: 40, radius: 10 };
        fn.handleHit(warnPass);
        check(warnPass.newY === 112, 'warn beam is still passable (telegraph only)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire: netState row + creation row (compressor)');
    {
        const fn = new BlinkFence(120, 140, 30, 'bf-wire', 'sig-b');
        fn.phase = SOLID; fn.netState = SOLID;
        const list = {}; list[fn.ownerId] = fn;
        const row = compressor.sendHazardUpdates(list)[0];
        check(row.length === 5, 'fence per-tick row has 5 fields (netState after a null angle slot)');
        check(row[3] === null, 'row[3] is null — the fence does not stream an angle');
        check(row[4] === SOLID, 'row[4] carries the phase (netState)');

        const created = JSON.parse(compressor.newHazards(list));
        check(created.length === 1 && created[0][1] === F.id, 'newHazards carries the fence (id ' + F.id + ')');
        check(created[0][4] === 30, 'created[4] carries the fence angle (drawn from anchor along it)');
        check(created[0][7] === SOLID, 'created[7] carries the phase (netState)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Spawn from map + block-vs-pass (live loop)');
    {
        // Vertical beam at x=VX spanning the lane band; the kart drives +x into it.
        const VX = COLS[4], VY = ROWS[0] - 40;
        const map = buildMap('barrier', [{ id: F.id, x: VX, y: VY, angle: 90 }], [0, 1, 2]);
        const { room, bot } = bootRoom('fence-barrier', map, { id: 'pusher', name: 'Pusher', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const ids = Object.keys(room.game.gameBoard.hazardList);
        check(ids.length === 1, 'the fence spawned from the map hazard entry');
        const hz = room.game.gameBoard.hazardList[ids[0]];
        check(hz != null && hz.id === F.id && hz.isFence === true, 'the spawned hazard is a stationary BlinkFence');

        // Drive the kart straight at the beam (non-AI so the steering doesn't fight us;
        // turnRight maps to dir +x in updatePlayers).
        function driveInto(pinPhase, ticks) {
            bot.isAI = false;
            bot.alive = true;
            bot.x = bot.newX = VX - 120; bot.y = bot.newY = ROWS[1];
            bot.velX = 0; bot.velY = 0;
            bot.moveForward = false; bot.moveBackward = false; bot.turnLeft = false; bot.turnRight = true;
            // Pin the fence phase for the whole run so the test is deterministic.
            hz.update = function () { this.phase = pinPhase; this.netState = pinPhase; this.blocking = (pinPhase !== OPEN); };
            let maxX = bot.x;
            for (let f = 0; f < ticks; f++) {
                room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
                maxX = Math.max(maxX, bot.x);
            }
            return maxX;
        }

        const blockedMaxX = driveInto(SOLID, 70);
        check(blockedMaxX < VX, 'a kart driving into the SOLID beam is stopped on the near side (reached x ' + blockedMaxX.toFixed(0) + ' < beam ' + VX + ')');

        const passedMaxX = driveInto(OPEN, 70);
        check(passedMaxX > VX + 30, 'the same kart drives clean THROUGH the OPEN beam (reached x ' + passedMaxX.toFixed(0) + ' > beam ' + VX + ')');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Blink-fence test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Blink-fence test passed.');
process.exit(0);
