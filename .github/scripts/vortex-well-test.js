'use strict';

// Real-engine headless test for the Batch 2 FORCE-ZONE hazard: the Vortex Well
// (config.hazards.vortexWell, id 908). The new primitive vs the bumper/geyser/mine
// punch hazards: a CONTINUOUS force applied to karts INSIDE a region — not a
// one-shot Punch. The force is applied ONCE PER TICK by gameBoard.updateHazards
// (a dedicated force-zone pass over the player list), NOT in handleHit (which the
// collision system calls up to twice per overlapping pair).
//
//   [A] Vortex Well (pure). A circular pull with a CALM-EYE profile (zero at the
//       dead centre AND the rim, peak in the mid-ring); applyForce pulls inward;
//       protected/finished karts skipped; nothing past the rim; handleHit is inert.
//   [B] Wire (compressor). Static, so the per-tick row stays 3 fields (no
//       streamAngle / netState); newHazards carries it.
//   [C] Live tick loop. The well spawns from a map entry; force is applied ONCE
//       per tick (not 2x); a parked kart is drawn toward the core; and — the key
//       playability guarantee — a kart flooring outward from the dead centre can
//       drive its way clear (the well is not a roach motel).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { VortexWell, vortexWellRadius } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const VW = config.hazards.vortexWell;  // id 908

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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'vortextest-' + name
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

const SOAK = { id: 'soak', name: 'Soak', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' };

try {
    Date.now = () => clock;
    Math.random = mulberry32(0x60B2);
    global.setTimeout = function (fn, ms) {
        const handle = { at: clock + (ms || 0), fn: fn, args: Array.prototype.slice.call(arguments, 2) };
        timers.push(handle);
        return handle;
    };
    global.clearTimeout = function (handle) { timers = timers.filter(t => t !== handle); };

    // ----------------------------------------------------------------------
    console.log('[A] Vortex Well force (pure)');
    {
        const v = new VortexWell(500, 400, VW.radius, VW.color, 'v-a', 'sig-a');
        check(v.moveable === false, 'is stationary (not moveable)');
        check(v.forceZone === true, 'flags forceZone (gameBoard applies the pull once/tick)');
        check(v.isVortex === true, 'flags isVortex (AI routes around the core)');
        check(v.radius === VW.radius, 'pull reach is the configured radius');
        check(v.handleHit({ isPlayer: true, x: 550, y: 400, velX: 0, velY: 0 }) === undefined, 'handleHit is a no-op (pull is not applied on contact)');

        // A kart to the RIGHT of the core is pulled LEFT (toward the core).
        const near = { isPlayer: true, alive: true, reachedGoal: false, x: 550, y: 400, velX: 0, velY: 0 };
        v.applyForce(near);
        check(near.velX < 0 && Math.abs(near.velY) < 1e-9, 'pulls a kart toward the core (inward)');

        // Calm-eye profile: the pull peaks in the MID-RING and is WEAKER both near the
        // dead centre and near the rim — that's what makes the centre escapable.
        function pullMag(dist) {
            const o = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + dist, y: 400, velX: 0, velY: 0 };
            v.applyForce(o); return Math.abs(o.velX);
        }
        const mid = pullMag(VW.radius * 0.5);   // peak
        const nearCentre = pullMag(VW.radius * 0.12);
        const nearRim = pullMag(VW.radius * 0.9);
        check(mid > nearCentre && mid > nearRim, 'the pull peaks in the mid-ring (calm eye at the centre, calm at the rim)');
        check(nearCentre < mid * 0.6, 'the dead centre is a calm eye (much weaker pull than the ring)');
        check(mid <= VW.force + 1e-9, 'peak pull does not exceed force (stays escapable below kart thrust)');

        // No pull past the rim.
        const out = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + VW.radius + 30, y: 400, velX: 0, velY: 0 };
        check(v.applyForce(out) === false && out.velX === 0 && out.velY === 0, 'a kart outside the pull radius is untouched');

        // Protected / star-power / finished karts immune (applyExplosionForce policy).
        const prot = { isPlayer: true, alive: true, reachedGoal: false, x: 550, y: 400, velX: 0, velY: 0, isProtected: () => true };
        check(v.applyForce(prot) === false && prot.velX === 0, 'a protected kart is not pulled');
        const star = { isPlayer: true, alive: true, reachedGoal: false, x: 550, y: 400, velX: 0, velY: 0, hasStarPower: () => true };
        check(v.applyForce(star) === false && star.velX === 0, 'a Star Power kart is not pulled');
        const done = { isPlayer: true, alive: true, reachedGoal: true, x: 550, y: 400, velX: 0, velY: 0 };
        check(v.applyForce(done) === false && done.velX === 0, 'a finished kart is not pulled');
    }

    // ----------------------------------------------------------------------
    console.log('\n[A2] Per-instance size (authored radius + clamp)');
    {
        const mid = Math.round((VW.minRadius + VW.radius) / 2);
        check(vortexWellRadius({}) === mid, 'a sizeless entry defaults to the midpoint of [min,max] (' + mid + ')');
        check(vortexWellRadius({ radius: 90 }) === 90, 'an authored in-range radius is used as-is');
        check(vortexWellRadius({ radius: 5000 }) === VW.radius, 'an over-max radius clamps to the config max (' + VW.radius + ')');
        check(vortexWellRadius({ radius: 1 }) === VW.minRadius, 'a below-min radius clamps to minRadius (' + VW.minRadius + ')');
        check(vortexWellRadius({ radius: NaN }) === mid, 'a non-finite radius falls back to the default');

        // A smaller well only reaches within its smaller radius.
        const small = new VortexWell(500, 400, VW.minRadius, VW.color, 'v-small', 'sig-a2');
        check(small.radius === VW.minRadius, 'the instance carries its own (smaller) radius');
        const justOutside = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + VW.minRadius + 8, y: 400, velX: 0, velY: 0 };
        check(small.applyForce(justOutside) === false, 'a kart just past a small well\'s rim is not pulled (radius is per-instance)');
        const inside = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + VW.minRadius * 0.5, y: 400, velX: 0, velY: 0 };
        check(small.applyForce(inside) === true && inside.velX < 0, 'a kart inside the small well is still pulled inward');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire: static row (compressor)');
    {
        const v = new VortexWell(700, 400, 95, VW.color, 'v-wire', 'sig-b');
        const list = {}; list[v.ownerId] = v;
        const rows = compressor.sendHazardUpdates(list);
        check(rows.every(r => r.length === 3), 'per-tick row stays 3 fields (no streamAngle / netState — the well is static)');

        const created = JSON.parse(compressor.newHazards(list));
        check(created.length === 1 && created[0][1] === VW.id, 'newHazards carries the vortex well (id ' + VW.id + ')');
        check(created[0][8] === 95, 'newHazards ships the per-instance radius in slot [8]');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Live tick loop: spawn + pull + escape');
    {
        const VX = COLS[2], VY = ROWS[1];   // col 2 leaves room to drive out toward the goal
        const vmap = buildMap('well', [{ id: VW.id, x: VX, y: VY }], [0, 1, 2]);
        const { room: vRoom, bot: vBot } = bootRoom('vw-well', vmap, SOAK);
        const vIds = Object.keys(vRoom.game.gameBoard.hazardList);
        check(vIds.length === 1, 'the vortex well spawned from the map hazard entry');
        const vhz = vRoom.game.gameBoard.hazardList[vIds[0]];
        check(vhz != null && vhz.id === VW.id && vhz.isVortex === true, 'the spawned hazard is a stationary VortexWell');

        // An authored radius on the map entry flows into the spawned hazard (clamped).
        const sizedMap = buildMap('sized', [{ id: VW.id, x: COLS[5], y: ROWS[1], radius: 95 }], [0, 1, 2]);
        const { room: szRoom } = bootRoom('vw-sized', sizedMap, SOAK);
        const szHz = szRoom.game.gameBoard.hazardList[Object.keys(szRoom.game.gameBoard.hazardList)[0]];
        check(szHz != null && szHz.radius === 95, 'an authored map-entry radius (95) flows into the spawned well');

        // Single-application guarantee: one tick applies exactly the calm-eye pull,
        // not 2x. Pin a stopped kart at the mid-ring for one tick and compare velX to
        // the pure applyForce value at the same spot.
        const expectPull = (function () { const o = { isPlayer: true, alive: true, reachedGoal: false, x: VX + VW.radius * 0.5, y: VY, velX: 0, velY: 0 }; vhz.applyForce(o); return Math.abs(o.velX); })();
        vBot.isAI = false;
        vBot.x = vBot.newX = VX + VW.radius * 0.5; vBot.y = vBot.newY = VY; vBot.velX = 0; vBot.velY = 0;
        vBot.moveForward = vBot.moveBackward = vBot.turnLeft = vBot.turnRight = false;
        vRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        check(Math.abs(Math.abs(vBot.velX) - expectPull) < 0.5, 'exactly one pull per tick (velX ' + Math.abs(vBot.velX).toFixed(2) + ' ~= one applyForce ' + expectPull.toFixed(2) + ', not doubled)');

        // Parked kart in the mid-ring, no input — drawn toward the core.
        vBot.x = vBot.newX = VX + VW.radius * 0.5; vBot.y = vBot.newY = VY; vBot.velX = 0; vBot.velY = 0;
        const parkStartDist = Math.abs(vBot.x - VX);
        for (let f = 0; f < 40; f++) {
            vBot.moveForward = vBot.moveBackward = vBot.turnLeft = vBot.turnRight = false;
            vRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        }
        const parkEndDist = Math.hypot(vBot.x - VX, vBot.y - VY);
        check(parkEndDist < parkStartDist - 5, 'a parked kart in the ring is drawn toward the core (dist ' + parkStartDist.toFixed(0) + '->' + parkEndDist.toFixed(0) + 'px)');

        // ESCAPE REGRESSION: a kart stopped dead in the centre, flooring straight out,
        // must be able to drive clear of the pull radius (not a roach motel). This is
        // the case the original tuning failed — the well trapped you forever.
        const { room: eRoom, bot: eBot } = bootRoom('vw-escape', vmap, SOAK);
        eBot.isAI = false;
        eBot.x = eBot.newX = VX; eBot.y = eBot.newY = VY; eBot.velX = 0; eBot.velY = 0;
        let escaped = false, escTick = -1;
        for (let f = 0; f < 240; f++) { // up to 8s
            eBot.moveForward = false; eBot.moveBackward = false; eBot.turnLeft = false; eBot.turnRight = true; // floor +x
            eRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (!eBot.alive || eBot.reachedGoal) { escaped = true; escTick = f; break; }
            if (Math.hypot(eBot.x - VX, eBot.y - VY) > VW.radius) { escaped = true; escTick = f; break; }
        }
        check(escaped, 'a kart flooring outward from the dead centre drives clear of the well' + (escTick >= 0 ? ' (in ' + (escTick * DT).toFixed(1) + 's)' : ' — STILL TRAPPED after 8s'));
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Vortex-well test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Vortex-well test passed.');
process.exit(0);
