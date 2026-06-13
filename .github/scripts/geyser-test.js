'use strict';

// Real-engine headless test for the Geyser hazard (config.hazards.geyser): a
// stationary vent that cycles dormant -> charging (telegraph) -> erupt, launching
// anyone near it with a strong radial map-owned punch, then back to dormant.
// First consumer of the framework's netState wire slot.
//
//   [A] Phase machine (pure). update(dt) walks dormant -> charging -> erupting ->
//       dormant on the configured durations; the charging->erupting edge spawns
//       exactly one map-owned bumper-type punch at the vent; touch is harmless.
//
//   [B] Wire (compressor). sendHazardUpdates emits a 5-field row whose [3] is null
//       (no streamAngle) and [4] is the phase int (netState); newHazards carries
//       the geyser as a creation row with the phase in the trailing slot.
//
//   [C] Spawn + erupt + launch (full tick loop). The geyser spawns from a map
//       entry; a kart parked on the vent is flung (punch emit + knocked off the
//       vent) once the cycle reaches eruption, and is unharmed before then.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { Geyser } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const G = config.hazards.geyser; // id 904

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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'geysertest-' + name
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
    console.log('[A] Geyser phase machine + eruption punch');
    {
        const gy = new Geyser(500, 400, G.radius, G.color, 'gy-a', 'sig-a');
        check(gy.phase === 0 && gy.netState === 0, 'starts dormant (phase/netState 0)');
        check(gy.moveable === false, 'is stationary (not moveable)');

        // Touch is harmless between eruptions.
        gy.handleHit({ isPlayer: true, x: 500, y: 400 });
        check(gy.punch == null, 'touching a dormant geyser does not punch');

        // Walk the timer just past dormant -> charging.
        const step = () => { gy.update(DT); };
        let guard = 0;
        while (gy.phase === 0 && guard++ < 1000) { step(); }
        check(gy.phase === 1 && gy.netState === 1, 'enters charging after the dormant window');
        check(gy.punch == null, 'no punch while merely charging (telegraph only)');

        // ...through charging -> erupting, which must spawn one map-owned punch.
        guard = 0;
        while (gy.phase === 1 && guard++ < 1000) { step(); }
        check(gy.phase === 2 && gy.netState === 2, 'enters erupting after the charge window');
        check(gy.punch != null && gy.punch.mapOwned === true && gy.punch.type === 'bumper',
            'the charge->erupt edge spawns a map-owned bumper-type punch');
        check(gy.punch != null && Math.abs(gy.punch.x - 500) < 1e-6 && Math.abs(gy.punch.y - 400) < 1e-6,
            'the eruption punch is centered on the vent');
        check(Math.abs(gy.punch.radius - G.attackRadius) < 1e-6,
            'the eruption punch uses the geyser attackRadius (radial launch reach)');

        // ...and erupting -> dormant closes the cycle.
        guard = 0;
        gy.punch = null; // (gameBoard would have consumed it)
        while (gy.phase === 2 && guard++ < 1000) { step(); }
        check(gy.phase === 0 && gy.netState === 0, 'returns to dormant, completing the cycle');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire: netState row (compressor)');
    {
        const gy = new Geyser(500, 400, G.radius, G.color, 'gy-wire', 'sig-b');
        gy.phase = 1; gy.netState = 1;
        const list = {}; list[gy.ownerId] = gy;
        const row = compressor.sendHazardUpdates(list)[0];
        check(row.length === 5, 'geyser per-tick row has 5 fields (netState after a null angle slot)');
        check(row[3] === null, 'row[3] is null — the geyser does not stream an angle');
        check(row[4] === 1, 'row[4] carries the phase (netState)');

        const created = JSON.parse(compressor.newHazards(list));
        check(created.length === 1 && created[0][1] === G.id && created[0][7] === 1,
            'newHazards carries the geyser (id ' + G.id + ') with the phase in the trailing slot');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Spawn from map + erupt launches a parked kart (live loop)');
    {
        const VX = COLS[4], VY = ROWS[1];
        const map = buildMap('vent', [{ id: G.id, x: VX, y: VY }], [0, 1, 2]);
        const { room, bot } = bootRoom('geyser-vent', map, { id: 'soak', name: 'Soak', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const ids = Object.keys(room.game.gameBoard.hazardList);
        check(ids.length === 1, 'the geyser spawned from the map hazard entry');
        const hz = room.game.gameBoard.hazardList[ids[0]];
        check(hz != null && hz.id === G.id && hz.moveable === false, 'the spawned hazard is a stationary Geyser');

        // Park the kart on the vent and hold it there; before the first eruption it
        // is unharmed, and the eruption flings it off.
        bot.isAI = false;
        bot.x = bot.newX = VX; bot.y = bot.newY = VY;
        bot.velX = 0; bot.velY = 0;
        events.length = 0;
        let erupted = false, prePunch = false, sawCharge = false;
        const cycleTicks = Math.round((G.dormantMs + G.chargeMs + G.eruptMs) / config.serverTickSpeed) + 20;
        for (let f = 0; f < cycleTicks; f++) {
            if (!erupted) { bot.x = bot.newX = VX; bot.y = bot.newY = VY; bot.velX = 0; bot.velY = 0; } // pin until it blows
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (hz.netState === 1) { sawCharge = true; }
            for (const e of events) {
                if (e.name === 'punch') {
                    if (hz.phase === 2 || hz.netState === 2) { erupted = true; } else { prePunch = true; }
                }
            }
            if (erupted) { break; }
        }
        check(sawCharge, 'the geyser telegraphed (charging phase observed) before erupting');
        check(!prePunch, 'no punch fired before the eruption (dormant/charging are safe)');
        check(erupted, 'the eruption fired a punch while the kart was on the vent');

        // After release, the lingering eruption punch flings the kart off the vent.
        let maxDist = 0;
        for (let f = 0; f < 12; f++) {
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            maxDist = Math.max(maxDist, Math.hypot(bot.x - VX, bot.y - VY));
        }
        check(maxDist > G.radius, 'the kart was launched clear of the vent (dist ' + maxDist.toFixed(1) + 'px)');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Geyser test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Geyser test passed.');
process.exit(0);
