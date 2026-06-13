'use strict';

// Real-engine headless test for the Proximity Mine hazard (config.hazards.mine):
// armed and quiet until a kart enters its trigger radius, then a short fuse and a
// strong radial map-owned punch that flings the nearby pack. One-shot (spent after
// it blows). Second netState consumer (after the geyser).
//
//   [A] Trip/fuse/spent machine (pure). handleHit from a player arms the fuse (and
//       only the first trip counts; non-players never trip it); update(dt) past the
//       fuse spawns one map-owned punch at the mine, goes spent, and one-shots
//       (alive=false) so it can't re-trigger.
//
//   [B] Wire (compressor). sendHazardUpdates emits a 5-field row ([3] null, [4]
//       phase); newHazards carries the phase in the trailing slot.
//
//   [C] Spawn + trip + boom (full tick loop). The mine spawns from a map entry; a
//       kart sitting in the trigger radius trips it, gets flung when the fuse burns
//       down, and the mine is spent afterward (a second kart doesn't re-detonate).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { Mine } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const M = config.hazards.mine; // id 905

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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'minetest-' + name
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
    console.log('[A] Mine trip/fuse/spent machine + one-shot');
    {
        const mine = new Mine(500, 400, M.radius, M.color, 'mine-a', 'sig-a');
        check(mine.phase === 0 && mine.netState === 0, 'starts armed (phase/netState 0)');

        mine.update(DT);
        check(mine.phase === 0 && mine.punch == null, 'armed mine with nobody near just waits');

        mine.handleHit({ isProjectile: true, x: 500, y: 400 });
        check(mine.phase === 0, 'a non-player object does not trip the mine');

        mine.handleHit({ isPlayer: true, x: 500, y: 400 });
        check(mine.phase === 1 && mine.netState === 1, 'a kart entering the trigger radius lights the fuse');
        check(mine.punch == null, 'no boom the instant it trips (the fuse has to burn)');

        // A second trip during the fuse must not reset it.
        mine.timer = 999; // pretend the fuse is about to blow
        mine.handleHit({ isPlayer: true, x: 500, y: 400 });
        check(mine.timer === 999, 'a second trip during the fuse does not restart it');
        mine.timer = 0;

        let guard = 0;
        while (mine.phase === 1 && guard++ < 1000) { mine.update(DT); }
        check(mine.phase === 2 && mine.netState === 2, 'goes spent when the fuse burns down');
        check(mine.alive === false, 'one-shot: the mine is inert (alive=false) after detonating');
        check(mine.punch != null && mine.punch.mapOwned === true && mine.punch.type === 'bumper'
            && Math.abs(mine.punch.radius - M.attackRadius) < 1e-6,
            'detonation spawns a map-owned punch at the mine with the blast reach');

        // Spent mines ignore everything.
        mine.punch = null;
        mine.handleHit({ isPlayer: true, x: 500, y: 400 });
        mine.update(DT);
        check(mine.punch == null && mine.phase === 2, 'a spent mine never triggers again');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire: netState row (compressor)');
    {
        const mine = new Mine(500, 400, M.radius, M.color, 'mine-wire', 'sig-b');
        mine.phase = 1; mine.netState = 1;
        const list = {}; list[mine.ownerId] = mine;
        const row = compressor.sendHazardUpdates(list)[0];
        check(row.length === 5, 'mine per-tick row has 5 fields (netState after a null angle slot)');
        check(row[3] === null && row[4] === 1, 'row[3] null (no angle), row[4] carries the phase');
        const created = JSON.parse(compressor.newHazards(list));
        check(created.length === 1 && created[0][1] === M.id && created[0][7] === 1,
            'newHazards carries the mine (id ' + M.id + ') with the phase in the trailing slot');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Spawn from map + trip + boom flings the kart (live loop)');
    {
        const MX = COLS[4], MY = ROWS[1];
        const map = buildMap('trap', [{ id: M.id, x: MX, y: MY }], [0, 1, 2]);
        const { room, bot } = bootRoom('mine-trap', map, { id: 'step', name: 'Step', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const ids = Object.keys(room.game.gameBoard.hazardList);
        check(ids.length === 1, 'the mine spawned from the map hazard entry');
        const hz = room.game.gameBoard.hazardList[ids[0]];
        check(hz != null && hz.id === M.id && hz.moveable === false, 'the spawned hazard is a stationary Mine');

        // Sit the kart on the mine; it trips, fuses, then the boom flings it.
        bot.isAI = false;
        bot.x = bot.newX = MX; bot.y = bot.newY = MY;
        bot.velX = 0; bot.velY = 0;
        events.length = 0;
        let tripped = false, boomed = false;
        const fuseTicks = Math.round(M.fuseMs / config.serverTickSpeed) + 8;
        for (let f = 0; f < fuseTicks + 6; f++) {
            if (!boomed) { bot.x = bot.newX = MX; bot.y = bot.newY = MY; bot.velX = 0; bot.velY = 0; }
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (hz.netState === 1) { tripped = true; }
            for (const e of events) { if (e.name === 'punch') { boomed = true; } }
            if (boomed) { break; }
        }
        check(tripped, 'the kart tripped the mine (fuse phase observed)');
        check(boomed, 'the fuse burned down and the mine detonated (punch emit)');
        check(hz.netState === 2 && hz.alive === false, 'the mine is spent + inert after the boom');

        // The lingering blast punch flings the (now released) kart clear.
        let maxDist = 0;
        for (let f = 0; f < 12; f++) {
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            maxDist = Math.max(maxDist, Math.hypot(bot.x - MX, bot.y - MY));
        }
        check(maxDist > M.bodyRadius, 'the blast flung the kart off the mine (dist ' + maxDist.toFixed(1) + 'px)');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Mine test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Mine test passed.');
process.exit(0);
