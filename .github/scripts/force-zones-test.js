'use strict';

// Real-engine headless test for the Batch 2 FORCE-ZONE hazards: the Gust Fan
// (config.hazards.gustFan, id 908) and the Vortex Well (config.hazards.vortexWell,
// id 909). The new primitive vs the bumper/geyser/mine punch hazards: a CONSTANT
// per-tick force applied to any kart inside a region — not a one-shot Punch. The
// force lands in handleHit, which the collision system (engine.narrowBase) calls
// every tick a kart overlaps the zone (the Dash Arrows boon's continuous-contact
// trick), so it reads as a steady wind / pull, not a bonk.
//
//   [A] Gust Fan (pure). A centre-anchored rotated rect; applyForce pushes the
//       victim's velocity ALONG the wind by a fixed increment when inside the zone;
//       outside / protected / finished karts are skipped.
//   [B] Vortex Well (pure). A circular pull with a CALM-EYE profile (zero at the
//       dead centre AND the rim, peak in the mid-ring); applyForce pulls inward;
//       protected karts skipped; nothing past the rim.
//   [C] Wire (compressor). Both are static, so the per-tick row stays 3 fields
//       (no streamAngle / netState); newHazards carries the gust's wind angle.
//   [D] Live tick loop. The hazards spawn from map entries; force is applied ONCE
//       per tick by gameBoard.updateHazards (not 2x via handleHit). A parked kart
//       drifts downwind through the gust; a parked kart is drawn toward the well;
//       and — the key playability guarantee — a kart flooring outward from the
//       dead centre can drive its way out (the well is not a roach motel).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { GustFan, VortexWell } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const GF = config.hazards.gustFan;     // id 908
const VW = config.hazards.vortexWell;  // id 909

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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'forcetest-' + name
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
    console.log('[A] Gust Fan force (pure)');
    {
        // Wind blowing straight down (+y), centred at (500,400).
        const g = new GustFan(500, 400, GF.width, GF.height, 90, GF.color, 'g-a', 'sig-a');
        check(g.moveable === false, 'is stationary (not moveable)');
        check(g.isGust === true, 'flags isGust (AI counter-steers the wind)');
        check(Math.abs(g.windX) < 1e-9 && Math.abs(g.windY - 1) < 1e-9, 'wind vector points along angle (+y here)');
        check(g.vertices.length === 4, 'is a rotated rect (4 corners)');

        check(g.forceZone === true, 'flags forceZone (gameBoard applies the force once/tick, not via handleHit)');
        check(g.handleHit({ isPlayer: true, x: 500, y: 400, velX: 0, velY: 0 }) === undefined, 'handleHit is a no-op (force is not applied on contact)');

        // A kart inside the zone gets the steady push along the wind.
        const p = { isPlayer: true, alive: true, reachedGoal: false, x: 500, y: 400, velX: 0, velY: 0 };
        g.applyForce(p);
        check(Math.abs(p.velX) < 1e-9 && Math.abs(p.velY - GF.force) < 1e-9, 'pushes a kart inside the zone downwind by exactly force per tick');
        g.applyForce(p);
        check(Math.abs(p.velY - 2 * GF.force) < 1e-9, 'each tick accumulates (continuous force)');

        // A kart OUTSIDE the rotated rect gets nothing.
        const outside = { isPlayer: true, alive: true, reachedGoal: false, x: 500, y: 400 + GF.height, velX: 0, velY: 0 };
        check(g.applyForce(outside) === false && outside.velY === 0, 'a kart outside the zone (across-wind beyond half-height) is not pushed');

        // Protected / star-power / finished karts are immune (same policy as explosion force).
        const prot = { isPlayer: true, alive: true, reachedGoal: false, x: 500, y: 400, velX: 0, velY: 0, isProtected: () => true };
        check(g.applyForce(prot) === false && prot.velY === 0, 'a protected (spawn-shield/invuln) kart is not pushed');
        const star = { isPlayer: true, alive: true, reachedGoal: false, x: 500, y: 400, velX: 0, velY: 0, hasStarPower: () => true };
        check(g.applyForce(star) === false && star.velY === 0, 'a Star Power kart is not pushed');
        const done = { isPlayer: true, alive: true, reachedGoal: true, x: 500, y: 400, velX: 0, velY: 0 };
        check(g.applyForce(done) === false && done.velY === 0, 'a finished kart is not pushed');

        // Regression (review #1): a non-finite angle is sanitized BEFORE the Rect
        // builds its corners, so the zone still has finite vertices rather than NaN
        // corners that silently never register.
        const bad = new GustFan(500, 400, GF.width, GF.height, NaN, GF.color, 'g-nan', 'sig-a');
        check(bad.angle === 0 && bad.vertices.every(v => Number.isFinite(v.x) && Number.isFinite(v.y)),
            'a non-finite wind angle falls back to 0 with finite rotated corners');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Vortex Well force (pure)');
    {
        const v = new VortexWell(500, 400, VW.radius, VW.color, 'v-b', 'sig-b');
        check(v.moveable === false, 'is stationary (not moveable)');
        check(v.forceZone === true, 'flags forceZone (gameBoard applies the pull once/tick)');
        check(v.isVortex === true, 'flags isVortex (AI routes around the core)');
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

        // No pull past the rim.
        const out = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + VW.radius + 30, y: 400, velX: 0, velY: 0 };
        check(v.applyForce(out) === false && out.velX === 0 && out.velY === 0, 'a kart outside the pull radius is untouched');

        // Protected kart immune.
        const prot = { isPlayer: true, alive: true, reachedGoal: false, x: 550, y: 400, velX: 0, velY: 0, isProtected: () => true };
        check(v.applyForce(prot) === false && prot.velX === 0, 'a protected kart is not pulled');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Wire: static rows (compressor)');
    {
        const g = new GustFan(500, 400, GF.width, GF.height, 45, GF.color, 'g-wire', 'sig-c');
        const v = new VortexWell(700, 400, VW.radius, VW.color, 'v-wire', 'sig-c');
        const list = {}; list[g.ownerId] = g; list[v.ownerId] = v;
        const rows = compressor.sendHazardUpdates(list);
        check(rows.every(r => r.length === 3), 'per-tick rows stay 3 fields (no streamAngle / netState — force zones are static)');

        const created = JSON.parse(compressor.newHazards(list));
        const gRow = created.find(r => r[1] === GF.id);
        const vRow = created.find(r => r[1] === VW.id);
        check(gRow != null && Math.abs(gRow[4] - 45) < 1e-9, 'newHazards carries the gust fan (id ' + GF.id + ') with its wind angle');
        check(vRow != null && vRow[1] === VW.id, 'newHazards carries the vortex well (id ' + VW.id + ')');
    }

    // ----------------------------------------------------------------------
    console.log('\n[D] Live tick loop: spawn + drift + pull + escape');
    {
        // --- Gust: a parked kart drifts downwind ---
        const GX = COLS[3], GY = ROWS[1];   // gust centre on a grass lane cell
        const gmap = buildMap('gust', [{ id: GF.id, x: GX, y: GY, angle: 90 }], [0, 1, 2]); // wind +y (down)
        const { room: gRoom, bot: gBot } = bootRoom('fz-gust', gmap, SOAK);
        const gIds = Object.keys(gRoom.game.gameBoard.hazardList);
        check(gIds.length === 1, 'the gust fan spawned from the map hazard entry');
        const ghz = gRoom.game.gameBoard.hazardList[gIds[0]];
        check(ghz != null && ghz.id === GF.id && ghz.isGust === true, 'the spawned hazard is a stationary GustFan');

        // Park the kart at the gust centre, no input (human, braking) — let the wind
        // work. Force is applied once/tick by gameBoard.updateHazards, not 2x.
        gBot.isAI = false;
        gBot.x = gBot.newX = GX; gBot.y = gBot.newY = GY; gBot.velX = 0; gBot.velY = 0;
        const startY = gBot.y;
        for (let f = 0; f < 20; f++) {
            gBot.moveForward = gBot.moveBackward = gBot.turnLeft = gBot.turnRight = false;
            gRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        }
        check(gBot.velY > 0, 'the wind built a downwind velocity on the parked kart (velY ' + gBot.velY.toFixed(1) + ')');
        check(gBot.y > startY + 5, 'the parked kart drifted downwind (dy ' + (gBot.y - startY).toFixed(1) + 'px)');
        check(Math.abs(gBot.x - GX) < Math.abs(gBot.y - startY), 'the drift is along the wind axis, not across it');
        // Single-application guarantee: one tick adds exactly `force` to velY, not 2x.
        const gBot2 = gBot; gBot2.x = gBot2.newX = GX; gBot2.y = gBot2.newY = GY; gBot2.velX = 0; gBot2.velY = 0;
        gBot2.moveForward = gBot2.moveBackward = gBot2.turnLeft = gBot2.turnRight = false;
        gRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        check(Math.abs(gBot2.velY - GF.force) < 0.5, 'exactly one wind push per tick (velY ' + gBot2.velY.toFixed(1) + ' ~= force ' + GF.force + ', not doubled)');

        // --- Vortex: a parked kart is drawn inward; a stopped kart in the centre can
        //     drive its way out (the key playability guarantee) ---
        const VX = COLS[2], VY = ROWS[1];   // col 2 leaves room to drive out toward the goal
        const vmap = buildMap('vortex', [{ id: VW.id, x: VX, y: VY }], [0, 1, 2]);
        const { room: vRoom, bot: vBot } = bootRoom('fz-vortex', vmap, SOAK);
        const vhz = vRoom.game.gameBoard.hazardList[Object.keys(vRoom.game.gameBoard.hazardList)[0]];
        check(vhz != null && vhz.id === VW.id && vhz.isVortex === true, 'the vortex well spawned as a stationary VortexWell');

        // Parked kart in the mid-ring, no input — drawn toward the core.
        vBot.isAI = false;
        const PARK = VW.radius * 0.5;
        vBot.x = vBot.newX = VX + PARK; vBot.y = vBot.newY = VY; vBot.velX = 0; vBot.velY = 0;
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
        const { room: eRoom, bot: eBot } = bootRoom('fz-escape', vmap, SOAK);
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
    console.log('Force-zones test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Force-zones test passed.');
process.exit(0);
