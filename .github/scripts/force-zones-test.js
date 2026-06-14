'use strict';

// Real-engine headless test for the Batch 2 FORCE-ZONE hazards: the Gust Fan
// (config.hazards.gustFan, id 908) and the Vortex Well (config.hazards.vortexWell,
// id 909). The new primitive vs the bumper/geyser/mine punch hazards: a CONSTANT
// per-tick force applied to any kart inside a region — not a one-shot Punch. The
// force lands in handleHit, which the collision system (engine.narrowBase) calls
// every tick a kart overlaps the zone (the Dash Arrows boon's continuous-contact
// trick), so it reads as a steady wind / pull, not a bonk.
//
//   [A] Gust Fan (pure). A centre-anchored rotated rect; handleHit pushes the
//       victim's velocity ALONG the wind by a fixed increment each call; outside
//       karts / protected karts / pucks are handled correctly.
//   [B] Vortex Well (pure). A circular pull; handleHit pulls the victim toward the
//       core with strength ramping rim->core (zero past the rim); protected karts
//       skipped.
//   [C] Wire (compressor). Both are static, so the per-tick row stays 3 fields
//       (no streamAngle / netState); newHazards carries the gust's wind angle.
//   [D] Live tick loop. The hazards spawn from map entries; a parked kart drifts
//       downwind through the gust, a parked kart is sucked toward the well, and a
//       fast kart shoots through the well instead of being trapped.

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

        // A kart anywhere in the zone gets the SAME steady push along the wind.
        const p = { isPlayer: true, alive: true, reachedGoal: false, x: 500, y: 400, velX: 0, velY: 0 };
        g.handleHit(p);
        check(Math.abs(p.velX) < 1e-9 && Math.abs(p.velY - GF.force) < 1e-9, 'pushes the kart downwind by exactly force per tick');
        g.handleHit(p);
        check(Math.abs(p.velY - 2 * GF.force) < 1e-9, 'the push accumulates every overlap tick (continuous force)');

        // Protected / star-power karts are immune (same policy as explosion force).
        const prot = { isPlayer: true, alive: true, reachedGoal: false, x: 500, y: 400, velX: 0, velY: 0, isProtected: () => true };
        g.handleHit(prot);
        check(prot.velY === 0, 'a protected (spawn-shield/invuln) kart is not pushed');
        const star = { isPlayer: true, alive: true, reachedGoal: false, x: 500, y: 400, velX: 0, velY: 0, hasStarPower: () => true };
        g.handleHit(star);
        check(star.velY === 0, 'a Star Power kart is not pushed');

        // A finished/dead kart is left alone.
        const done = { isPlayer: true, alive: true, reachedGoal: true, x: 500, y: 400, velX: 0, velY: 0 };
        g.handleHit(done);
        check(done.velY === 0, 'a finished kart is not pushed');

        // A puck (hockey) rides the wind too.
        const puck = { isPuck: true, x: 500, y: 400, velX: 0, velY: 0 };
        g.handleHit(puck);
        check(Math.abs(puck.velY - GF.force) < 1e-9, 'a puck is carried by the wind');

        // Regression (review #1): a non-finite angle is sanitized BEFORE the Rect
        // builds its corners, so the zone still has finite vertices (collision-live)
        // rather than NaN corners that silently never overlap.
        const bad = new GustFan(500, 400, GF.width, GF.height, NaN, GF.color, 'g-nan', 'sig-a');
        check(bad.angle === 0 && bad.vertices.every(v => Number.isFinite(v.x) && Number.isFinite(v.y)),
            'a non-finite wind angle falls back to 0 with finite rotated corners');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Vortex Well force (pure)');
    {
        const v = new VortexWell(500, 400, VW.radius, VW.color, 'v-b', 'sig-b');
        check(v.moveable === false, 'is stationary (not moveable)');
        check(v.isVortex === true, 'flags isVortex (AI routes around the core)');
        check(v.radius === VW.radius, 'pull reach is the configured radius');

        // A kart to the RIGHT of the core is pulled LEFT (toward the core).
        const near = { isPlayer: true, alive: true, reachedGoal: false, x: 550, y: 400, velX: 0, velY: 0 };
        v.handleHit(near);
        check(near.velX < 0 && Math.abs(near.velY) < 1e-9, 'pulls a kart toward the core (inward)');

        // Strength ramps rim->core: a kart deep in pulls HARDER than one near the rim.
        const deep = { isPlayer: true, alive: true, reachedGoal: false, x: 530, y: 400, velX: 0, velY: 0 };  // dist 30
        const rim = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + VW.radius - 10, y: 400, velX: 0, velY: 0 }; // dist ~140
        v.handleHit(deep); v.handleHit(rim);
        check(Math.abs(deep.velX) > Math.abs(rim.velX), 'the pull is stronger near the core than near the rim');

        // No pull past the rim.
        const out = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + VW.radius + 30, y: 400, velX: 0, velY: 0 };
        v.handleHit(out);
        check(out.velX === 0 && out.velY === 0, 'a kart outside the pull radius is untouched');

        // Protected kart immune.
        const prot = { isPlayer: true, alive: true, reachedGoal: false, x: 550, y: 400, velX: 0, velY: 0, isProtected: () => true };
        v.handleHit(prot);
        check(prot.velX === 0, 'a protected kart is not pulled');

        // Regression (review #2): the pull PLATEAUS inside the (drawn) core radius —
        // a kart at half the core distance gets the same force as one at the core
        // edge, not an ever-spiking one as dist->0 (matches the art, no jitter trap).
        const atCore = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + VW.coreRadius, y: 400, velX: 0, velY: 0 };
        const inCore = { isPlayer: true, alive: true, reachedGoal: false, x: 500 + VW.coreRadius / 2, y: 400, velX: 0, velY: 0 };
        v.handleHit(atCore); v.handleHit(inCore);
        check(Math.abs(Math.abs(inCore.velX) - Math.abs(atCore.velX)) < 1e-9, 'the pull is flat (plateaued) inside the core radius');
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

        // Park the kart at the gust centre, no input (human, braking) — let the wind work.
        gBot.isAI = false;
        gBot.x = gBot.newX = GX; gBot.y = gBot.newY = GY; gBot.velX = 0; gBot.velY = 0;
        const startY = gBot.y;
        for (let f = 0; f < 14; f++) { gRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers(); }
        check(gBot.velY > 0, 'the wind built a downwind velocity on the parked kart (velY ' + gBot.velY.toFixed(1) + ')');
        check(gBot.y > startY + 5, 'the parked kart drifted downwind (dy ' + (gBot.y - startY).toFixed(1) + 'px)');
        check(Math.abs(gBot.x - GX) < Math.abs(gBot.y - startY), 'the drift is along the wind axis, not across it');

        // --- Vortex: a parked kart is sucked toward the core; a fast kart shoots through ---
        const VX = COLS[4], VY = ROWS[1];
        const vmap = buildMap('vortex', [{ id: VW.id, x: VX, y: VY }], [0, 1, 2]);
        const { room: vRoom, bot: vBot } = bootRoom('fz-vortex', vmap, SOAK);
        const vIds = Object.keys(vRoom.game.gameBoard.hazardList);
        const vhz = vRoom.game.gameBoard.hazardList[vIds[0]];
        check(vhz != null && vhz.id === VW.id && vhz.isVortex === true, 'the vortex well spawned as a stationary VortexWell');

        // Parked kart offset from the core, no input — it should be pulled inward.
        vBot.isAI = false;
        const PARK = 90; // px right of the core, inside the pull radius
        vBot.x = vBot.newX = VX + PARK; vBot.y = vBot.newY = VY; vBot.velX = 0; vBot.velY = 0;
        const parkStartDist = Math.abs(vBot.x - VX);
        for (let f = 0; f < 16; f++) { vRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers(); }
        const parkEndDist = Math.hypot(vBot.x - VX, vBot.y - VY);
        check(parkEndDist < parkStartDist - 5, 'the parked kart was pulled toward the well (dist ' + parkStartDist.toFixed(0) + '->' + parkEndDist.toFixed(0) + 'px)');

        // Fast kart crossing tangentially: it should NOT be trapped at the core —
        // it ends up clearly farther from the core than the parked kart did.
        const { room: v2Room, bot: v2Bot } = bootRoom('fz-vortex2', vmap, SOAK);
        const v2hz = v2Room.game.gameBoard.hazardList[Object.keys(v2Room.game.gameBoard.hazardList)[0]];
        v2Bot.isAI = false;
        // Enter the rim from the left, moving fast across the zone (+x).
        v2Bot.x = v2Bot.newX = VX - VW.radius + 8; v2Bot.y = v2Bot.newY = VY; v2Bot.velX = 480; v2Bot.velY = 0;
        let maxDist = 0;
        for (let f = 0; f < 16; f++) {
            v2Bot.velX = Math.max(v2Bot.velX, 200); // keep the racer committed across (human throttle proxy)
            v2Room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            maxDist = Math.max(maxDist, Math.hypot(v2Bot.x - VX, v2Bot.y - VY));
            if (!v2Bot.alive || v2Bot.reachedGoal) { break; }
        }
        check(maxDist > parkEndDist, 'a fast kart carried its speed through the well instead of being trapped (reached ' + maxDist.toFixed(0) + 'px out)');
        void v2hz; void v2Room;
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
