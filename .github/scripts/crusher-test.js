'use strict';

// Real-engine headless test for the Crusher hazard (config.hazards.crusher): a heavy
// slab that slides back and forth across a corridor on a rail — a Thwomp. It rides
// the same parametric rail the moving bumper does (owning its motion via advance(dt)
// so the broadside slab keeps a fixed orientation) and collides with the bumper
// wall's rotated-rect machinery. Mid-rail contact is a hard directional SHOVE (a
// map-owned punch); the slab slamming home in the outer pinch zone is a lethal PINCH.
//
//   [A] Rail motion + geometry + contact (pure). advance/move oscillate the slab
//       along [0, railLength] (reflecting at both ends, never leaving the rail) and
//       refresh the rotated-rect vertices + centerline each tick. handleHit CRUSHES
//       (killSelf) in the outer pinch zone moving outward, SHOVES (map-owned punch)
//       elsewhere, and skips protected / star-power karts. scaleSpeed (lightning).
//
//   [B] Wire (compressor). It's railed, so newHazards ships the RAIL's origin/angle
//       (slots [4]/[5]/[6]); per-tick rows stay 3 fields (no streamAngle, no netState).
//
//   [C] Spawn + shove + crush (full tick loop). The crusher spawns from a map entry;
//       a kart caught at the slam point (outer rail, moving outward) is crushed, and a
//       kart bumped mid-rail is shoved (flung) but survives.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { hazardKindById } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const CR = config.hazards.crusher; // id 910
const KIND = hazardKindById(CR.id);

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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'crushertest-' + name
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

function fakeKart(over) {
    return Object.assign({
        isPlayer: true, alive: true, currentState: config.stateMap.racing,
        x: 0, y: 0, newX: 0, newY: 0, velX: 0, velY: 0,
        killed: null, isProtected() { return false; }, hasStarPower() { return false; },
        killSelf(cause) { this.killed = cause; this.alive = false; }
    }, over);
}

try {
    Date.now = () => clock;
    Math.random = mulberry32(0xC411);
    global.setTimeout = function (fn, ms) {
        const handle = { at: clock + (ms || 0), fn: fn, args: Array.prototype.slice.call(arguments, 2) };
        timers.push(handle);
        return handle;
    };
    global.clearTimeout = function (handle) { timers = timers.filter(t => t !== handle); };

    // ----------------------------------------------------------------------
    console.log('[A] Crusher rail motion + geometry + contact');
    {
        // Vertical rail at x=400, sliding +y (angle 90); slab broadside (angle 180).
        const cr = KIND.build({ id: CR.id, x: 400, y: 200, angle: 90 }, 'cr-a', 'sig-a');
        check(cr.id === CR.id && cr.moveable === true && cr.rail != null, 'is a railed, moveable Crusher');
        check(cr.railLength === CR.railLength, 'rail length comes from config');
        check(Math.abs(((cr.angle % 360) + 360) % 360 - 180) < 1e-6, 'slab is broadside (rail.angle + 90)');
        check(cr.vertices.length === 4, 'slab has 4 rotated-rect corners');
        check(cr.t === 0 && Math.abs(cr.x - 400) < 1e-6 && Math.abs(cr.y - 200) < 1e-6, 'rests at the rail anchor (t=0)');

        // Oscillate: t stays within [0, railLength], the slab never leaves the rail
        // line (x pinned to 400), and direction flips at both ends.
        let minT = Infinity, maxT = -Infinity, offRail = 0, sawForward = false, sawBack = false, prevT = cr.t;
        for (let i = 0; i < 400; i++) {
            cr.advance(DT); cr.move();
            minT = Math.min(minT, cr.t); maxT = Math.max(maxT, cr.t);
            if (Math.abs(cr.x - 400) > 1e-6) { offRail++; }
            if (cr.t > prevT) { sawForward = true; } else if (cr.t < prevT) { sawBack = true; }
            prevT = cr.t;
        }
        check(minT >= 0 && maxT <= CR.railLength + 1e-6, 'slab stays clamped to its rail [0, railLength]');
        check(maxT > CR.railLength * 0.9, 'slab travels (nearly) the full rail');
        check(offRail === 0, 'slab never drifts off the rail line');
        check(sawForward && sawBack, 'slab reverses at the ends (slides both ways)');
        check(Math.abs((cr.bx - cr.ax)) > 1e-6 || Math.abs((cr.by - cr.ay)) > 1e-6, 'slab centerline is refreshed each tick');

        // Lightning speed-up.
        const before = cr.speed;
        cr.scaleSpeed(config.brutalRounds.lightning.movingHazardSpeedMod);
        check(cr.speed > before, 'scaleSpeed (lightning) speeds the slab up');

        // Contact — pinch at the slammed (outer) end moving outward kills, but ONLY
        // when the end is wall/lava-backed (lethalEnd). Default (open ground) is false.
        check(cr.lethalEnd === false, 'a crusher defaults to NON-lethal (shove-only) until its end is resolved against terrain');
        cr.t = CR.railLength; cr.dir = 1;
        cr.x = cr.newX = cr.rail.x + cr.railDirX * cr.t; cr.y = cr.newY = cr.rail.y + cr.railDirY * cr.t;
        cr.refreshGeometry();
        // Open-ground end: the slam only SHOVES, never crushes.
        cr.punch = null;
        const openEnd = fakeKart({ x: cr.x, y: cr.y, newX: cr.x, newY: cr.y });
        cr.handleHit(openEnd);
        check(openEnd.killed === null && openEnd.alive === true, 'an open-ground slam does NOT crush (only shoves)');
        check(cr.punch != null, 'the open-ground slam shoves instead (map-owned punch)');
        // Wall/lava-backed end (lethalEnd): the slam CRUSHES.
        cr.lethalEnd = true; cr.punch = null;
        const crushed = fakeKart({ x: cr.x, y: cr.y, newX: cr.x, newY: cr.y });
        cr.handleHit(crushed);
        check(crushed.killed === 'crush' && crushed.alive === false, 'a wall/lava-backed slam in the outer pinch zone CRUSHES (killSelf "crush")');
        cr.lethalEnd = true; // keep lethal for the remaining pinch-zone assertions below

        // Mid-rail contact shoves (map-owned punch), does not kill.
        cr.t = 12; cr.dir = 1; cr.punch = null;
        cr.x = cr.newX = cr.rail.x + cr.railDirX * cr.t; cr.y = cr.newY = cr.rail.y + cr.railDirY * cr.t;
        cr.refreshGeometry();
        const shoved = fakeKart({ x: cr.x + 4, y: cr.y, newX: cr.x + 4, newY: cr.y });
        cr.handleHit(shoved);
        check(shoved.killed === null && shoved.alive === true, 'mid-rail contact does not crush');
        check(cr.punch != null && cr.punch.mapOwned === true && cr.punch.type === 'bumper', 'mid-rail contact spawns a map-owned shove punch');

        // Protected / star-power karts are untouchable even at the pinch point.
        cr.t = CR.railLength; cr.dir = 1; cr.punch = null;
        cr.refreshGeometry();
        const invuln = fakeKart({ x: cr.x, y: cr.y, isProtected() { return true; } });
        cr.handleHit(invuln);
        check(invuln.killed === null && cr.punch == null, 'a protected kart is neither crushed nor shoved');
        const starred = fakeKart({ x: cr.x, y: cr.y, hasStarPower() { return true; } });
        cr.handleHit(starred);
        check(starred.killed === null, 'a star-power kart is immune to the crush');

        // resolveMapContext: the slam end is lethal ONLY when wall/lava-backed.
        const world = { x: 0, y: 0, width: config.worldWidth, height: config.worldHeight };
        const grassMap = buildMap('ctx', [], [0, 1, 2]); // all-grass, no holes/lava
        const edgeCr = KIND.build({ id: CR.id, x: COLS[4], y: config.worldHeight - 30, angle: 90 }, 'cr-edge', 'sig-a');
        edgeCr.resolveMapContext(grassMap, world);
        check(edgeCr.lethalEnd === true, 'far rail end past the world edge => lethal');
        const openCr = KIND.build({ id: CR.id, x: COLS[2], y: ROWS[1], angle: 0 }, 'cr-open', 'sig-a');
        openCr.resolveMapContext(grassMap, world);
        check(openCr.lethalEnd === false, 'far rail end in open ground => NOT lethal (shove-only)');
        const lavaMap = buildMap('ctxlava', [], [0, 1, 2]);
        for (let i = 0; i < lavaMap.cells.length; i++) { lavaMap.cells[i].id = config.tileMap.lava.id; }
        const lavaCr = KIND.build({ id: CR.id, x: COLS[2], y: ROWS[1], angle: 0 }, 'cr-lava', 'sig-a');
        lavaCr.resolveMapContext(lavaMap, world);
        check(lavaCr.lethalEnd === true, 'far rail end against lava => lethal');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire: railed creation row + 3-field per-tick row (compressor)');
    {
        const cr = KIND.build({ id: CR.id, x: 350, y: 260, angle: 0 }, 'cr-wire', 'sig-b');
        // Slide it off the anchor so the per-tick position differs from the rail origin.
        for (let i = 0; i < 20; i++) { cr.advance(DT); cr.move(); }
        const list = {}; list[cr.ownerId] = cr;
        const row = compressor.sendHazardUpdates(list)[0];
        check(row.length === 3, 'crusher per-tick row stays 3 fields (no streamAngle, no netState)');
        check(Math.abs(row[1] - cr.x) < 1e-6 && Math.abs(row[2] - cr.y) < 1e-6, 'per-tick row carries the live slab center');

        const created = JSON.parse(compressor.newHazards(list));
        check(created[0][1] === CR.id, 'newHazards carries the crusher (id ' + CR.id + ')');
        check(created[0][4] === 0, 'created[4] = rail angle (not the slab broadside angle)');
        check(Math.abs(created[0][5] - 350) < 1e-6 && Math.abs(created[0][6] - 260) < 1e-6, 'created[5]/[6] = rail origin (the slab is drawn from the rail, not its mid-slide spot)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Spawn from map + crush vs shove (live loop)');
    {
        const RX = COLS[4], RY = ROWS[1];
        const map = buildMap('slam', [{ id: CR.id, x: RX, y: RY, angle: 90 }], [0, 1, 2]);
        const { room, bot } = bootRoom('crusher-slam', map, { id: 'caught', name: 'Caught', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        const ids = Object.keys(room.game.gameBoard.hazardList);
        check(ids.length === 1, 'the crusher spawned from the map hazard entry');
        const hz = room.game.gameBoard.hazardList[ids[0]];
        check(hz != null && hz.id === CR.id && hz.isCrusher === true, 'the spawned hazard is a railed Crusher');

        // The crusher spawned in OPEN GROUND (lane grass), so resolveMapContext ran and
        // left it non-lethal: a slam there shoves, it does not crush.
        check(hz.lethalEnd === false, 'an open-ground crusher spawns NON-lethal (resolveMapContext)');
        const farX = hz.rail.x + hz.railDirX * hz.railLength, farY = hz.rail.y + hz.railDirY * hz.railLength;
        hz.advance = function () { this.t = this.railLength; this.dir = 1; this.newX = farX; this.newY = farY; this.velX = 0; this.velY = 0; this.refreshGeometry(); };
        bot.isAI = false;
        bot.x = bot.newX = farX; bot.y = bot.newY = farY; bot.velX = 0; bot.velY = 0;
        events.length = 0;
        let openSlamPunch = false, openSlamKilled = false;
        for (let f = 0; f < 4; f++) {
            bot.x = bot.newX = farX; bot.y = bot.newY = farY; bot.velX = 0; bot.velY = 0;
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            for (const e of events) { if (e.name === 'punch') { openSlamPunch = true; } }
            if (bot.alive === false) { openSlamKilled = true; }
        }
        check(!openSlamKilled, 'an open-ground slam does NOT crush the kart');
        check(openSlamPunch, 'an open-ground slam shoves the kart instead (punch)');

        // Now make the end wall/lava-backed: the same slam crushes.
        hz.lethalEnd = true;
        bot.alive = true; bot.enabled = true; bot.reachedGoal = false;
        let crushedLive = false;
        for (let f = 0; f < 6 && !crushedLive; f++) {
            bot.x = bot.newX = farX; bot.y = bot.newY = farY;
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (bot.alive === false) { crushedLive = true; }
        }
        check(crushedLive, 'a wall/lava-backed slam crushes a pinned kart in the live loop');

        // Reset; pin the slab mid-rail and bump a kart against the face: shoved, alive.
        // Clear any lingering shove-punch (the open-ground slam above leaves one in
        // punchList for ~100ms, which would block a fresh punch from emitting).
        for (const pid in room.game.gameBoard.punchList) { delete room.game.gameBoard.punchList[pid]; }
        hz.punch = null;
        bot.alive = true; bot.enabled = true; bot.reachedGoal = false;
        const midT = 20, midX = hz.rail.x + hz.railDirX * midT, midY = hz.rail.y + hz.railDirY * midT;
        hz.advance = function () { this.t = midT; this.dir = 1; this.newX = midX; this.newY = midY; this.velX = 0; this.velY = 0; this.refreshGeometry(); };
        bot.isAI = false;
        bot.x = bot.newX = midX + 8; bot.y = bot.newY = midY; bot.velX = 0; bot.velY = 0;
        events.length = 0;
        let sawPunch = false;
        // Hold the kart on the face for a few ticks (so contact fires past any cooldown).
        for (let f = 0; f < 8 && !sawPunch; f++) {
            bot.x = bot.newX = midX + 8; bot.y = bot.newY = midY; bot.velX = 0; bot.velY = 0;
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            for (const e of events) { if (e.name === 'punch') { sawPunch = true; } }
        }
        let flung = 0;
        for (let f = 0; f < 10; f++) {
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            flung = Math.max(flung, Math.hypot(bot.x - midX, bot.y - midY));
        }
        check(sawPunch, 'mid-rail contact emitted a shove punch in the live loop');
        check(bot.alive === true, 'the mid-rail kart survived the shove (not crushed)');
        check(flung > 8, 'the shove flung the kart off the slab face (dist ' + flung.toFixed(0) + 'px)');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Crusher test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Crusher test passed.');
process.exit(0);
