'use strict';

// Real-engine headless test for the Sentry Turret hazard (config.hazards.sentryTurret):
// a stationary emplacement that tracks the nearest racer inside its firing arc, charges
// with a telegraph, then fires an aimed shot. The framework's FIRST projectile-emitting
// map element — the shot rides the iceCannon ability's projectile wire (type
// "snowFlake") but resolves as a recoverable SHOVE, NOT the iceCannon's terrain freeze.
//
//   [A] Aim + state machine (pure). acquireTarget honors range/arc and skips
//       protected/finished karts; serve() eases the barrel toward the target and walks
//       idle -> charging -> firing (loaded -> lock-on telegraph -> fire), publishing the
//       phase as netState, raising fireRequest on the firing edge, and ABORTING the
//       charge if the target jukes out of the arc (baiting). muzzle() geometry.
//
//   [B] Wire (compressor). It opts into BOTH framework slots: sendHazardUpdates emits a
//       5-field row whose [3] is the live barrel angle (streamAngle) and [4] is the phase
//       (netState); newHazards carries the mount angle at [4] and the phase in slot [7].
//
//   [C] Spawn + fire + shove vs no terrain change (full tick loop). The turret spawns
//       from a map entry; a kart sitting in its arc is fired on (spawnTurretShot), the
//       shot rides projectileList as a "snowFlake", detonates and SHOVES the kart
//       (snowFlakeExploded + the kart gains velocity) while leaving the terrain UNFROZEN
//       (no tileChanges). A kart sitting OUTSIDE the arc is never fired on.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { Turret } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));
const { TurretShot } = require(path.join(repoRoot, 'server', 'entities', 'projectiles.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const ICE = T.ice.id;
const DT = config.serverTickSpeed / 1000;
const S = config.hazards.sentryTurret; // id 911
const IDLE = 0, CHARGING = 1, FIRING = 2;

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

// A minimal targetable kart for the pure acquireTarget/serve tests.
function fakeKart(x, y, opts) {
    opts = opts || {};
    return {
        x: x, y: y, alive: opts.alive !== false, reachedGoal: !!opts.reachedGoal,
        isProtected: function () { return !!opts.protected; },
        hasStarPower: function () { return !!opts.star; }
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
function buildMap(name, hazards, lanes, barriers) {
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
        sites: sites, hazards: hazards, barriers: barriers || [], startEdges: ['left'], name: name, author: 'test', id: 'turrettest-' + name
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
    Math.random = mulberry32(0x7117);
    global.setTimeout = function (fn, ms) {
        const handle = { at: clock + (ms || 0), fn: fn, args: Array.prototype.slice.call(arguments, 2) };
        timers.push(handle);
        return handle;
    };
    global.clearTimeout = function (handle) { timers = timers.filter(t => t !== handle); };

    // ----------------------------------------------------------------------
    console.log('[A] Turret aim + state machine (pure)');
    {
        // Turret at (200,200) mounted facing +x (angle 0), arc S.arc.
        const tr = new Turret(200, 200, 0, 'tr-a', 'sig-a');
        check(tr.phase === IDLE && tr.netState === IDLE, 'starts idle (phase/netState 0)');
        check(tr.moveable === false, 'is stationary (not moveable)');
        check(tr.streamAngle === true && tr.isTurret === true, 'streams its barrel angle and is flagged isTurret');
        check(tr.mountAngle === 0 && tr.angle === 0, 'barrel rests at the mount facing');
        // A non-normalized authored angle (crafted/hand-edited map) is folded into
        // [0,360) so the single-mod arc-membership math stays correct.
        check(new Turret(0, 0, 720, 'tr-n1', 'sig-n').mountAngle === 0, 'mountAngle 720 normalizes to 0');
        check(new Turret(0, 0, -90, 'tr-n2', 'sig-n').mountAngle === 270, 'mountAngle -90 normalizes to 270');
        const trN = new Turret(200, 200, 360 + 0, 'tr-n3', 'sig-n'); // mounts east, like angle 0
        check(trN.acquireTarget({ a: fakeKart(360, 205) }) != null && trN.acquireTarget({ a: fakeKart(40, 200) }) == null,
            'arc test still correct after normalization (hits ahead, misses behind)');

        // acquireTarget: in-arc within range hits; out-of-arc / out-of-range / protected / finished miss.
        check(tr.acquireTarget({ a: fakeKart(360, 210) }) != null, 'acquires a racer dead ahead in the arc');
        check(tr.acquireTarget({ a: fakeKart(40, 200) }) == null, 'ignores a racer BEHIND it (outside the arc)');
        check(tr.acquireTarget({ a: fakeKart(200 + S.range + 60, 200) }) == null, 'ignores a racer beyond range');
        check(tr.acquireTarget({ a: fakeKart(360, 210, { protected: true }) }) == null, 'ignores a protected (spawn-invuln) racer');
        check(tr.acquireTarget({ a: fakeKart(360, 210, { reachedGoal: true }) }) == null, 'ignores a racer already across the goal');

        // Antlions (the chasing brutal-round hazard) are valid targets too — passed in
        // by gameBoard during the antlion round. Same arc/range/LoS rules as racers.
        const antlionAhead = [{ isAntlion: true, alive: true, x: 360, y: 205 }];
        check(tr.acquireTarget({}, null, antlionAhead) != null, 'acquires an antlion in the arc (no racers present)');
        check(tr.acquireTarget({}, null, [{ isAntlion: true, alive: true, x: 40, y: 200 }]) == null, 'ignores an antlion behind it (outside the arc)');
        check(tr.acquireTarget({}, null, null) == null, 'null antlion list is safe (targets only racers)');
        // A racer closer than the antlion wins (nearest target, racer or antlion).
        const aimRacer = tr.acquireTarget({ a: fakeKart(250, 200) }, null, [{ isAntlion: true, alive: true, x: 460, y: 200 }]);
        check(aimRacer != null && Math.abs(aimRacer.angle) < 1, 'aims at the nearer racer over a farther antlion');

        // The bolt detonates on contact with an antlion (gameBoard.shoveAntlions then
        // knocks it back via the impulse channel), not just on racers.
        const boltA = new TurretShot(0, 0, S.shotRadius, 'black', 'b-a', 'sig-a', 0);
        boltA.handleHit({ isAntlion: true, alive: true });
        check(boltA.shove === true && boltA.alive === false, 'the bolt detonates on an antlion it touches');
        const boltB = new TurretShot(0, 0, S.shotRadius, 'black', 'b-b', 'sig-a', 0);
        boltB.handleHit({ isMapCell: true, id: 1 });
        check(boltB.shove === false, 'the bolt still passes through terrain cells (no detonation)');

        // Barrel eases toward an off-centre target rather than snapping.
        const tr2 = new Turret(200, 200, 0, 'tr-aim', 'sig-a2');
        tr2.serve({ a: fakeKart(360, 320) }, DT, true); // target up-and-right of mount 0
        check(tr2.angle > 0 && tr2.angle <= S.turnSpeed * DT + 1e-6, 'barrel rotates toward the target, clamped to turnSpeed*dt');

        // Full cycle: loaded -> charge -> fire. Step with a steady in-arc target.
        const tr3 = new Turret(200, 200, 0, 'tr-fire', 'sig-a3');
        const tgt = { a: fakeKart(360, 200) };
        tr3.serve(tgt, DT, true);
        check(tr3.phase === CHARGING, 'with a target and a loaded cooldown it begins charging');
        let guard = 0, fired = false;
        while (guard++ < 2000) {
            tr3.serve(tgt, DT, true);
            if (tr3.fireRequest) { fired = true; break; }
        }
        check(fired && tr3.phase === FIRING, 'completes the charge and raises fireRequest (phase firing)');

        // Bait: a target that leaves the arc DURING the charge aborts the shot.
        const tr4 = new Turret(200, 200, 0, 'tr-bait', 'sig-a4');
        tr4.serve(tgt, DT, true);                 // -> charging
        check(tr4.phase === CHARGING, 'charging on a held target');
        tr4.serve({ a: fakeKart(40, 200) }, DT, true); // target now behind it
        check(tr4.phase === IDLE && tr4.fireRequest === false, 'juking out of the arc aborts the charge (no shot)');

        // Idle when nothing is live (karts penned outside racing).
        const tr5 = new Turret(200, 200, 0, 'tr-pen', 'sig-a5');
        tr5.serve(tgt, DT, false);
        check(tr5.phase === IDLE, 'stays idle while not live (no charge before the race)');

        // muzzle() sits barrelLength out along the barrel.
        const m = tr.muzzle();
        check(Math.abs(m.x - (200 + S.barrelLength)) < 1e-6 && Math.abs(m.y - 200) < 1e-6, 'muzzle is barrelLength out along the barrel facing');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire: streamAngle + netState row + creation row (compressor)');
    {
        const tr = new Turret(120, 140, 25, 'tr-wire', 'sig-b');
        check(tr.mountAngle === 25 && tr.angle === 25, 'a fresh turret rests its barrel at the authored mount angle (25)');
        // At spawn the barrel == the mount, so the creation row seeds the mount facing.
        const freshCreated = JSON.parse(compressor.newHazards((function () { const l = {}; l[tr.ownerId] = tr; return l; })()));
        check(freshCreated[0][4] === 25, 'at spawn created[4] = the mount angle (barrel rests there)');

        tr.angle = 47; tr.netState = CHARGING; // barrel has since swung to track + locked on
        const list = {}; list[tr.ownerId] = tr;
        const row = compressor.sendHazardUpdates(list)[0];
        check(row.length === 5, 'turret per-tick row has 5 fields (streamAngle + netState)');
        check(row[3] === 47, 'row[3] carries the LIVE barrel angle (streamAngle)');
        check(row[4] === CHARGING, 'row[4] carries the phase (netState)');

        const created = JSON.parse(compressor.newHazards(list));
        check(created.length === 1 && created[0][1] === S.id, 'newHazards carries the turret (id ' + S.id + ')');
        check(created[0][4] === 47, 'created[4] ships the CURRENT barrel facing (seeds a late joiner; = mount at spawn)');
        check(created[0][7] === CHARGING, 'created[7] carries the phase (netState)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Spawn from map + fire/shove vs no-fire (live loop)');
    {
        const TX = COLS[2], TY = ROWS[1];      // turret on the middle lane, facing +x
        const map = buildMap('arc', [{ id: S.id, x: TX, y: TY, angle: 0 }], [0, 1, 2]);
        const { room, bot } = bootRoom('turret-arc', map, { id: 'sitter', name: 'Sitter', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const ids = Object.keys(room.game.gameBoard.hazardList);
        check(ids.length === 1, 'the turret spawned from the map hazard entry');
        const turretId = ids[0];
        const hz = room.game.gameBoard.hazardList[turretId];
        check(hz != null && hz.id === S.id && hz.isTurret === true, 'the spawned hazard is a stationary Turret');

        // Park the kart in the arc, east of the turret, well within range. No AI/input so
        // it sits there until the shot shoves it; strip spawn protection so it's a target.
        function parkKart(x, y) {
            bot.isAI = false;
            bot.alive = true;
            bot.reachedGoal = false;
            bot.invulnUntil = 0; bot.invulnHeldInCircle = false; bot.onSanctuary = false; bot.starPowerUntil = 0;
            bot.x = bot.newX = x; bot.y = bot.newY = y;
            bot.velX = 0; bot.velY = 0;
            bot.moveForward = false; bot.moveBackward = false; bot.turnLeft = false; bot.turnRight = false;
        }

        // (1) Kart sitting IN the arc -> fired on + shoved, terrain left unfrozen.
        parkKart(TX + 150, TY);
        const startX = bot.x, startY = bot.y;
        events.length = 0;
        let sawTurretShotProj = false, sawProjOwner = false;
        for (let f = 0; f < 90; f++) {
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            // keep it a sitting target (cancel any residual drift BEFORE the shove lands)
            const proj = room.game.gameBoard.projectileList[turretId];
            if (proj != null) { sawProjOwner = true; if (proj.type === 'turretShot') { sawTurretShotProj = true; } }
        }
        const fired = events.filter(e => e.name === 'spawnTurretShot');
        check(fired.length >= 1, 'the turret fires on a kart sitting in its arc (spawnTurretShot x' + fired.length + ')');
        check(fired[0].data != null && typeof fired[0].data.angle === 'number', 'spawnTurretShot ships the fire angle (for the oriented bolt visual)');
        check(sawProjOwner && sawTurretShotProj, 'the shot rides projectileList keyed by the turret, with its own "turretShot" type (not snowFlake)');
        check(events.some(e => e.name === 'turretShotBurst'), 'the shot detonates with the turret\'s OWN burst event (turretShotBurst, not snowFlakeExploded)');
        const moved = Math.hypot(bot.x - startX, bot.y - startY);
        check(moved > 5, 'the kart is SHOVED off its spot (moved ' + moved.toFixed(1) + 'px)');
        check(!events.some(e => e.name === 'tileChanges'), 'NO terrain freeze — the shove emits no tileChanges (unlike an iceCannon hit)');
        // The cells around the detonation are still grass, not ice.
        const cells = room.game.gameBoard.currentMap.cells;
        let icedNearby = 0;
        for (let i = 0; i < cells.length; i++) {
            const s = cells[i].site;
            if (Math.hypot(s.x - (TX + 150), s.y - TY) < 110 && cells[i].id === ICE) { icedNearby++; }
        }
        check(icedNearby === 0, 'no cell near the impact was turned to ice (' + icedNearby + ' iced)');

        // (2) Kart sitting OUTSIDE the arc (behind the turret) -> never fired on.
        parkKart(TX - 150, TY);
        events.length = 0;
        for (let f = 0; f < 90; f++) {
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            // re-park so it can't drift into the arc
            bot.x = bot.newX = TX - 150; bot.y = bot.newY = TY; bot.velX = 0; bot.velY = 0;
        }
        check(!events.some(e => e.name === 'spawnTurretShot'), 'a kart BEHIND the turret (outside the arc) is never fired on');
    }

    // ----------------------------------------------------------------------
    console.log('\n[D] A barrier (wall/fence) shields a kart from the turret');
    {
        // Same setup as [C]'s in-arc kart, but with a vertical wall between the turret
        // and the kart — the turret's line of sight is blocked, so it never fires.
        const TX = COLS[2], TY = ROWS[1];
        const wallX = TX + 70;
        const map = buildMap('walled', [{ id: S.id, x: TX, y: TY, angle: 0 }], [0, 1, 2],
            [{ x1: wallX, y1: TY - 80, x2: wallX, y2: TY + 80, style: 'wall' }]);
        const { room, bot } = bootRoom('turret-walled', map, { id: 'hider', name: 'Hider', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        const turretId = Object.keys(room.game.gameBoard.hazardList)[0];
        const hz = room.game.gameBoard.hazardList[turretId];
        check(hz != null && hz.isTurret === true, 'the turret spawned on the walled map');

        // Park the kart in the arc, behind the wall (east of it), stripped of protection.
        bot.isAI = false; bot.alive = true; bot.reachedGoal = false;
        bot.invulnUntil = 0; bot.invulnHeldInCircle = false; bot.onSanctuary = false; bot.starPowerUntil = 0;
        events.length = 0;
        for (let f = 0; f < 90; f++) {
            bot.x = bot.newX = TX + 150; bot.y = bot.newY = TY; bot.velX = 0; bot.velY = 0;
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        }
        check(!events.some(e => e.name === 'spawnTurretShot'), 'the turret never fires at a kart shielded behind a wall (line of sight blocked)');

        // Sanity: the SAME kart in the SAME arc spot, but no wall, IS fired on (proving
        // it's the wall that protects, not the geometry).
        const openMap = buildMap('open', [{ id: S.id, x: TX, y: TY, angle: 0 }], [0, 1, 2]);
        const open = bootRoom('turret-open', openMap, { id: 'hider2', name: 'Hider2', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        const obot = open.bot;
        obot.isAI = false; obot.alive = true; obot.reachedGoal = false;
        obot.invulnUntil = 0; obot.invulnHeldInCircle = false; obot.onSanctuary = false; obot.starPowerUntil = 0;
        events.length = 0;
        for (let f = 0; f < 90; f++) {
            obot.x = obot.newX = TX + 150; obot.y = obot.newY = TY; obot.velX = 0; obot.velY = 0;
            open.room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        }
        check(events.some(e => e.name === 'spawnTurretShot'), 'control: with NO wall, the same kart in the arc IS fired on');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Sentry-turret test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Sentry-turret test passed.');
process.exit(0);
