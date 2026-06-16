'use strict';

// Real-engine headless test for the Boon framework + its first kind, Dash Arrows
// (config.boons.dashArrows). Boons are the helpful counterpart to hazards: they
// reuse the hazard-kind registry, the runtime hazardList, the wire, and the editor
// pipeline, distinguished only by helpful:true (which gates the lightning speed-up,
// the AI's repulsion/cell-penalty, and the classifier's difficulty count).
//
//   [A] Registry + handleHit (pure). The dashArrows kind resolves by id, is
//       directional + helpful, builds a live boon (helpful flag set), and its
//       handleHit imparts a velocity impulse along the pad's angle for a RACER only
//       — a non-player and a zombie are both ignored (boons skip the infection side).
//   [B] Boost (full live tick loop). A kart coasting across a Dash Arrows pad is
//       flung to top speed along the arrow (a no-pad control stays slow); the boon
//       spawns into hazardList with helpful=true and ships on the wire as
//       [ownerId, id, x, y, angle].
//   [C] AI is blind to boons. hazardRepulsion returns zero push for a boon but a
//       real push for a bumper at the same spot, and a bot still finishes a
//       corridor that has a pad sitting in its lane (a boon never traps).
//   [D] Recharge Spring (config.boons.rechargeSpring). A drive-over pit stop:
//       handleHit refills the punch-stamina bar, clears the exhausted/overcharge
//       latch, and resets the punch cooldown. The spring is a GLOBAL shared charge —
//       the first needy racer consumes it, then it re-arms over cooldownMs and
//       telegraphs the refill via netState (0..100) on the wire; a full racer never
//       wastes a ready spring.
//   [F] Guard Halo (config.boons.guardHalo). A drive-over ring that grants a ONE-HIT
//       shield (Player.guardShield): it absorbs the next incoming hit from ANY source
//       — punch, bomb/ice (applyExplosionForce), cut (cutPlayers) — with no knockback,
//       then pops (guardShieldPopped). Global shared charge like the spring: re-arms
//       over cooldownMs with the netState telegraph; a shielded racer never wastes a
//       ready halo. RACERS only (a non-player + a zombie are ignored).
//   [G] Second Wind Totem (config.boons.secondWindTotem). Drive over to attune; EVERY
//       death that round plays a respawnDelayMs DEATH-BEAT (frozen + invuln at the death
//       spot, client slow-pans to the flag) then respawns you AT the flag (keeping your
//       notch, no playerDied) — indefinitely. CRUCIALLY a respawn is never a death: no
//       eliminatedAt stamp, so no team-points penalty and no kill credit. Those only land
//       on a REAL death — flag never attuned, already consumed at death, or burned DURING
//       the beat (finishSecondWind falls through to a real killPlayer). Excludes the
//       infection side; re-anchors to a different flag on contact; board keeps the
//       per-tick safe/netState fresh via tracksTileSafety.
//   [E] Slipstream (config.boons.slipstream). A directional wind corridor: a gentle
//       constant push along its axis up to currentSpeed, capped (never overshoots,
//       never brakes a faster kart), that fights a backward-driven kart. RACERS only —
//       a puck (projectile physics wouldn't carry the impulse) and a zombie are both
//       ignored; ships on the wire as [ownerId, id, x, y, angle].
//
// Harness mirrors bumper-wall-test.js: REAL server modules, room.update(dt) with
// Date.now mocked to a per-tick clock, Math.random seeded, setTimeout queued.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const aiController = require(path.join(repoRoot, 'server', 'aiController.js'));
const { hazardKindById, Bumper } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const DASH = config.boons.dashArrows; // id 950

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
const ROWS = [77, 280, 384, 488, 691];
const PAD_X = COLS[4]; // 684 — mid-corridor column
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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'boontest-' + name
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
    Math.random = mulberry32(0x80B1);
    global.setTimeout = function (fn, ms) {
        const handle = { at: clock + (ms || 0), fn: fn, args: Array.prototype.slice.call(arguments, 2) };
        timers.push(handle);
        return handle;
    };
    global.clearTimeout = function (handle) { timers = timers.filter(t => t !== handle); };

    // ----------------------------------------------------------------------
    console.log('[A] dashArrows registry + handleHit');
    {
        const kind = hazardKindById(DASH.id);
        check(kind != null, 'dashArrows resolves through the shared kind registry by id ' + DASH.id);
        check(kind != null && kind.helpful === true, 'the kind is flagged helpful (gates lightning/AI/classifier)');
        check(kind != null && kind.directional === true && kind.railed === false, 'the kind is directional + not railed');

        const boon = kind.build({ x: 300, y: 200, angle: 0 }, 'boon-a', 'sig-a');
        check(boon.id === DASH.id && boon.helpful === true && boon.moveable === false,
            'build() returns a live boon (helpful, static)');

        // angle 0 -> boost along +x. A player overlapping gains +x velocity.
        const kart = { isPlayer: true, velX: 0, velY: 0 };
        boon.handleHit(kart);
        check(Math.abs(kart.velX - DASH.boost) < 0.001 && Math.abs(kart.velY) < 0.001,
            'handleHit pushes a player along the arrow (+' + DASH.boost + 'x)');

        // A 90deg pad pushes +y; a non-player object is ignored.
        const up = kind.build({ x: 0, y: 0, angle: 90 }, 'boon-a2', 'sig-a');
        const kart2 = { isPlayer: true, velX: 0, velY: 0 };
        up.handleHit(kart2);
        check(Math.abs(kart2.velX) < 0.001 && Math.abs(kart2.velY - DASH.boost) < 0.001,
            'a 90deg pad pushes along +y');
        const before = { x: 0, y: 0 };
        const proj = { isProjectile: true, velX: 0, velY: 0 };
        boon.handleHit(proj);
        check(proj.velX === 0 && proj.velY === 0, 'a non-player object is not boosted');
        // A zombie is a player (isPlayer) but boons skip the infection side.
        const zombie = { id: 'z-a', isPlayer: true, isZombie: true, velX: 0, velY: 0 };
        boon.handleHit(zombie);
        check(zombie.velX === 0 && zombie.velY === 0, 'a zombie is not boosted (boons skip the infection side)');
        void before;
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] a kart coasting across a Dash Arrows pad is flung to top speed (live tick loop)');
    function coastAcross(label, withPad) {
        const hazards = withPad ? [{ id: DASH.id, x: PAD_X, y: ROWS[2], angle: 0 }] : [];
        const map = buildMap(label, hazards, [2]);
        const { room, bot } = bootRoom('boon-' + label, map, { id: 'coast', name: 'Coast', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });

        // Detach the bot brain and hand-drive: keep a gentle approach speed so it
        // reaches the pad, but never clamp DOWN (so a boost survives the next tick).
        bot.isAI = false;
        bot.x = bot.newX = PAD_X - 240; bot.y = bot.newY = ROWS[2];
        bot.velX = 150; bot.velY = 0;
        let peakVelX = 0, crossed = false;
        for (let f = 0; f < 180; f++) {
            if (bot.velX < 150 && bot.x < PAD_X) { bot.velX = 150; } // keep approaching, don't cap a boost
            room.update(DT);
            clock += config.serverTickSpeed;
            fireDueTimers();
            if (bot.velX > peakVelX) { peakVelX = bot.velX; }
            if (bot.x >= PAD_X) { crossed = true; }
        }
        return { room, bot, peakVelX, crossed };
    }
    {
        const padded = coastAcross('pad', true);
        const control = coastAcross('nopad', false);
        check(padded.crossed, 'the padded kart reached the pad column');

        const hazardIds = Object.keys(padded.room.game.gameBoard.hazardList);
        check(hazardIds.length === 1, 'the pad spawned from the map entry into hazardList');
        const hz = padded.room.game.gameBoard.hazardList[hazardIds[0]];
        check(hz != null && hz.id === DASH.id && hz.helpful === true,
            'the spawned object is a Dash Arrows boon with helpful=true');

        const packet = JSON.parse(compressor.newHazards(padded.room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === DASH.id && packet[0][2] === PAD_X &&
            packet[0][3] === ROWS[2] && packet[0][4] === 0,
            'compressor.newHazards ships the pad as [ownerId, ' + DASH.id + ', x, y, angle]');

        // Capped boost: the pad ramps the kart to ~boostCap along the arrow (below
        // the engine max), so peak lands near the cap, not at top speed.
        check(padded.peakVelX > DASH.boostCap - 40 && padded.peakVelX <= DASH.boostCap + 40,
            'crossing the pad pushed the kart to ~boostCap (peak velX=' + padded.peakVelX.toFixed(0) + ' ~ ' + DASH.boostCap + ')');
        check(control.peakVelX < 200,
            'the no-pad control kart stayed slow (peak velX=' + control.peakVelX.toFixed(0) + ' < 200)');
        check(padded.peakVelX > control.peakVelX + 120,
            'the pad is the cause (padded ' + padded.peakVelX.toFixed(0) + ' vs control ' + control.peakVelX.toFixed(0) + ')');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] the AI is blind to boons (no repulsion, no trap)');
    {
        const bot = { x: PAD_X - 30, y: ROWS[2], ai: {} };
        // build() returns a Boon whose base class already sets helpful=true — no
        // manual stamp needed (that's the property the AI gate below reads).
        const boon = hazardKindById(DASH.id).build({ x: PAD_X, y: ROWS[2], angle: 0 }, 'boon-c', 'sig-c');
        const bump = new Bumper(PAD_X, ROWS[2], config.hazards.bumper.radius, config.hazards.bumper.color, 'bump-c', 'sig-c');
        // desired heading drives straight at the object (into +x).
        const boonPush = aiController._test.hazardRepulsion(bot, { hazardList: { k: boon } }, 1, 0, DT);
        const bumpPush = aiController._test.hazardRepulsion(bot, { hazardList: { k: bump } }, 1, 0, DT);
        check(boonPush.x === 0 && boonPush.y === 0, 'hazardRepulsion ignores a boon (zero push)');
        check(Math.abs(bumpPush.x) + Math.abs(bumpPush.y) > 0.0001,
            'hazardRepulsion still pushes off a real bumper at the same spot (sanity)');

        // Live: a pad sitting in the only lane must not stall the race.
        const map = buildMap('inlane', [{ id: DASH.id, x: PAD_X, y: ROWS[2], angle: 0 }], [2]);
        const { room, bot: racer } = bootRoom('boon-inlane', map, { id: 'racer', name: 'Racer', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        let reachedAt = -1;
        for (let f = 0; f < 2400; f++) {
            room.game.notchesToWin = 0;
            room.update(DT);
            clock += config.serverTickSpeed;
            fireDueTimers();
            if (reachedAt < 0 && racer.reachedGoal) { reachedAt = f; }
            if (room.game.currentState === config.stateMap.gameOver) { break; }
        }
        check(racer.reachedGoal === true, 'a bot drove through the in-lane pad and finished (tick ' + reachedAt + ')');
    }

    // ----------------------------------------------------------------------
    console.log('\n[D] Recharge Spring refills a racer + has a global, telegraphed re-arm');
    {
        const SPRING = config.boons.rechargeSpring; // id 951
        const kind = hazardKindById(SPRING.id);
        check(kind != null && kind.helpful === true, 'rechargeSpring resolves through the registry + is helpful (id ' + SPRING.id + ')');
        check(kind != null && kind.directional === false && kind.railed === false, 'rechargeSpring is non-directional + not railed');

        const map = buildMap('spring', [{ id: SPRING.id, x: PAD_X, y: ROWS[2] }], [2]);
        const { room, bot } = bootRoom('boon-spring', map, { id: 'racer', name: 'Racer', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        const spring = room.game.gameBoard.hazardList[Object.keys(room.game.gameBoard.hazardList)[0]];
        check(spring != null && spring.id === SPRING.id && spring.helpful === true,
            'the spring spawned from the map entry into hazardList (helpful=true)');
        check(spring.netState === 100, 'a fresh spring is ready (netState 100)');
        // It ships on the wire WITH the netState telegraph slot ([7] in newHazards).
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === SPRING.id && packet[0][2] === PAD_X &&
            packet[0][3] === ROWS[2] && packet[0][7] === 100,
            'compressor.newHazards ships the spring with its ready netState (=100)');

        // Drain the kart: empty stamina, latch exhausted + overcharge lock, put the
        // punch on cooldown — then drive over the ready spring.
        bot.stamina = 0;
        bot.staminaExhausted = true;
        bot.overcharge = 0.5;
        bot.exhaustLockUntil = clock + 99999;
        bot.punchedTimer = clock;
        spring.handleHit(bot);
        check(bot.stamina === config.punchStamina.max, 'stamina refilled to max');
        check(bot.staminaExhausted === false, 'the exhausted latch is cleared');
        check(bot.overcharge === 0 && bot.exhaustLockUntil === 0, 'the overcharge lock is cleared');
        check(bot.punchedTimer === null, 'the punch cooldown is reset (punchedTimer cleared)');
        // The spring is now globally spent + telegraphs it (netState drains to 0).
        check(spring.rechargeReadyAt > clock, 'the spring went on its global re-arm cooldown');
        spring.update();
        check(spring.netState >= 0 && spring.netState < 100, 'a spent spring telegraphs refilling (netState < 100): ' + spring.netState);

        // Global cooldown: a SECOND racer touching the spent spring gets nothing.
        const bot2 = { isPlayer: true, stamina: 0, staminaExhausted: true, overcharge: 0, exhaustLockUntil: 0,
            punchedTimer: null, punchWaitTime: config.playerPunchCooldown, charging: false,
            rechargeFromSpring: bot.rechargeFromSpring };
        spring.handleHit(bot2);
        check(bot2.stamina === 0 && bot2.staminaExhausted === true,
            'a different racer gets nothing from the still-refilling spring (global cooldown)');

        // After cooldownMs the spring is ready again and refills.
        clock += SPRING.cooldownMs + 100;
        spring.update();
        check(spring.netState === 100, 'after cooldownMs the spring reads ready again (netState 100)');
        bot.stamina = 0; bot.staminaExhausted = true;
        spring.handleHit(bot);
        check(bot.stamina === config.punchStamina.max && bot.staminaExhausted === false,
            'the re-armed spring refills again');

        // A full racer driving over a ready spring does NOT waste its charge.
        clock += SPRING.cooldownMs + 100; spring.update();
        const ready = spring.rechargeReadyAt;
        const fullBot = { isPlayer: true, stamina: config.punchStamina.max, staminaExhausted: false,
            overcharge: 0, exhaustLockUntil: 0, punchedTimer: null, punchWaitTime: config.playerPunchCooldown,
            charging: false, rechargeFromSpring: bot.rechargeFromSpring };
        spring.handleHit(fullBot);
        check(spring.rechargeReadyAt === ready && spring.netState === 100,
            'a topped-up racer does not drain a ready spring');

        // A drained ZOMBIE gets nothing and does NOT drain the ready spring (boons skip
        // the infection side — no reset bite cooldown, no denying survivors the charge).
        const zspring = { isPlayer: true, isZombie: true, stamina: 0, staminaExhausted: true,
            overcharge: 0, exhaustLockUntil: 0, punchedTimer: null, punchWaitTime: config.playerPunchCooldown,
            charging: false, rechargeFromSpring: bot.rechargeFromSpring };
        spring.handleHit(zspring);
        check(zspring.stamina === 0 && zspring.staminaExhausted === true && spring.rechargeReadyAt === ready,
            'a zombie gets nothing and does not drain the spring');

        // A non-player object is ignored.
        const proj = { isProjectile: true, stamina: 0 };
        spring.handleHit(proj);
        check(proj.stamina === 0, 'a non-player object is ignored by the spring');
    }

    // ----------------------------------------------------------------------
    console.log('\n[E] Slipstream pushes along its axis + fights backward motion');
    {
        const STREAM = config.boons.slipstream; // id 952
        const kind = hazardKindById(STREAM.id);
        check(kind != null && kind.helpful === true, 'slipstream resolves through the registry + is helpful (id ' + STREAM.id + ')');
        check(kind != null && kind.directional === true && kind.railed === false, 'slipstream is directional + not railed');

        const s = kind.build({ x: 300, y: 200, angle: 0 }, 'stream-a', 'sig-e');
        check(s.id === STREAM.id && s.helpful === true && s.moveable === false,
            'build() returns a live boon (helpful, static)');

        // (Synthetic karts carry distinct ids: the engine double-dispatch guard
        // claimTickContact keys on id within a tick, so each must be unique here.)
        // A still kart on a +x current gains +push along +x.
        const k1 = { id: 'k1', isPlayer: true, velX: 0, velY: 0, maxVelocity: config.playerMaxSpeed };
        s.handleHit(k1);
        check(Math.abs(k1.velX - STREAM.push) < 0.001 && Math.abs(k1.velY) < 0.001,
            'a still kart gets +push along +x (+' + STREAM.push + ')');

        // Engine double-dispatch guard: a SECOND handleHit on the same kart in the
        // same tick is a no-op (the push lands exactly once per tick, not 2x).
        s.handleHit(k1);
        check(Math.abs(k1.velX - STREAM.push) < 0.001,
            'a repeat hit on the same kart in one tick does NOT push again (no 2x)');

        // A backward-driven kart: the current fights it (still adds +push forward).
        const k2 = { id: 'k2', isPlayer: true, velX: -100, velY: 0, maxVelocity: config.playerMaxSpeed };
        s.handleHit(k2);
        check(Math.abs(k2.velX - (-100 + STREAM.push)) < 0.001,
            'a backward-driven kart is pushed forward (the current fights it)');

        // Already above currentSpeed along the axis: not braked, not boosted.
        const k3 = { id: 'k3', isPlayer: true, velX: STREAM.currentSpeed + 50, velY: 0, maxVelocity: config.playerMaxSpeed };
        s.handleHit(k3);
        check(Math.abs(k3.velX - (STREAM.currentSpeed + 50)) < 0.001,
            'a kart already above currentSpeed is left alone (no brake)');

        // Just below the cap: only the remaining gap is added (never overshoots).
        const k4 = { id: 'k4', isPlayer: true, velX: STREAM.currentSpeed - 10, velY: 0, maxVelocity: config.playerMaxSpeed };
        s.handleHit(k4);
        check(Math.abs(k4.velX - STREAM.currentSpeed) < 0.001,
            'the push never overshoots currentSpeed (caps at the remaining gap)');

        // Racers only: a non-player, a puck (projectile physics wouldn't carry a raw
        // velocity impulse), and a zombie are all ignored.
        const proj = { id: 'proj', isProjectile: true, velX: 0, velY: 0 };
        s.handleHit(proj);
        check(proj.velX === 0 && proj.velY === 0, 'a non-player object is not pushed');
        const puck = { id: 'puck', isPuck: true, velX: 0, velY: 0, maxVelocity: config.playerMaxSpeed };
        s.handleHit(puck);
        check(puck.velX === 0 && puck.velY === 0, 'a puck is NOT pushed (projectile physics would not carry it)');
        const zstream = { id: 'z-e', isPlayer: true, isZombie: true, velX: 0, velY: 0, maxVelocity: config.playerMaxSpeed };
        s.handleHit(zstream);
        check(zstream.velX === 0 && zstream.velY === 0, 'a zombie is not pushed (boons skip the infection side)');

        // Wire: a slipstream ships as [ownerId, id, x, y, angle].
        const map = buildMap('stream', [{ id: STREAM.id, x: PAD_X, y: ROWS[2], angle: 0 }], [2]);
        const { room } = bootRoom('boon-stream', map, { id: 'racer', name: 'Racer', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === STREAM.id && packet[0][2] === PAD_X &&
            packet[0][3] === ROWS[2] && packet[0][4] === 0,
            'compressor.newHazards ships the slipstream as [ownerId, ' + STREAM.id + ', x, y, angle]');
    }

    const RACER = { id: 'racer', name: 'Racer', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' };
    function emittedSince(name, since) {
        for (let i = since; i < events.length; i++) { if (events[i].name === name) { return true; } }
        return false;
    }

    // ----------------------------------------------------------------------
    console.log('\n[F] Guard Halo grants a one-hit shield that absorbs across every hit source');
    {
        const HALO = config.boons.guardHalo; // id 953
        const kind = hazardKindById(HALO.id);
        check(kind != null && kind.helpful === true, 'guardHalo resolves through the registry + is helpful (id ' + HALO.id + ')');
        check(kind != null && kind.directional === false && kind.railed === false, 'guardHalo is non-directional + not railed');

        const map = buildMap('halo', [{ id: HALO.id, x: PAD_X, y: ROWS[2] }], [2]);
        const { room, bot } = bootRoom('boon-halo', map, RACER);
        const halo = room.game.gameBoard.hazardList[Object.keys(room.game.gameBoard.hazardList)[0]];
        check(halo != null && halo.id === HALO.id && halo.helpful === true,
            'the halo spawned from the map entry into hazardList (helpful=true)');
        check(halo.netState === 100, 'a fresh halo is ready (netState 100)');
        // Ships on the wire WITH the netState telegraph slot ([7] in newHazards).
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === HALO.id && packet[0][7] === 100,
            'compressor.newHazards ships the halo with its ready netState (=100)');

        // Neutralize any spawn-grace so the absorb assertions below test the shield, not invuln.
        bot.invulnUntil = 0; bot.invulnHeldInCircle = false; bot.onSanctuary = false;
        bot.starPowerUntil = 0; bot.teamId = null;
        bot.currentState = config.stateMap.racing;

        // Drive over a ready halo -> the racer takes the shield; the halo goes on its
        // global re-arm and telegraphs it.
        bot.guardShield = false;
        halo.handleHit(bot);
        check(bot.guardShield === true, 'driving over a ready halo grants the one-hit shield');
        check(halo.rechargeReadyAt > clock && halo.netState === 0, 'the halo went on its global re-arm (netState 0)');
        check(bot.grantGuardShield() === false, 'a racer who already holds a shield does not re-grant (no waste)');

        // Absorb a PUNCH (also covers bumper/bumper-wall/rotor — all reach handlePunchHit).
        bot.velX = 0; bot.velY = 0;
        let since = events.length;
        const punch = { x: bot.x + 5, y: bot.y, ownerId: 'attacker', mapOwned: true, getBonus: () => 800 };
        bot.handlePunchHit(punch);
        check(bot.guardShield === false, 'an incoming punch popped the shield');
        check(bot.velX === 0 && bot.velY === 0, 'the punch dealt no knockback (absorbed by the shield)');
        check(punch.landed === true, 'the absorbed punch is marked landed (kept out of clashes)');
        check(emittedSince('guardShieldPopped', since), 'a guardShieldPopped event fired for the client telegraph');
        // Pop grants brief i-frames so a lingering bumper/wall/rotor punch (which re-overlaps
        // across ticks) is absorbed as ONE hit, not popped-then-knocked the next tick.
        check(bot.isInvuln(), 'popping the shield grants brief i-frames (popGraceMs)');
        bot.velX = 0; bot.velY = 0;
        bot.handlePunchHit({ x: bot.x + 5, y: bot.y, ownerId: 'attacker', mapOwned: true, getBonus: () => 800 });
        check(bot.velX === 0 && bot.velY === 0, 'a re-hit DURING the pop grace is swallowed (no knockback slips through)');
        // After the grace, a punch lands normally (shield spent).
        clock += HALO.popGraceMs + 50; bot.invulnUntil = 0;
        bot.velX = 0; bot.velY = 0;
        bot.handlePunchHit({ x: bot.x + 5, y: bot.y, ownerId: 'attacker', mapOwned: true, getBonus: () => 800 });
        check(Math.abs(bot.velX) + Math.abs(bot.velY) > 0.0001, 'with no shield + grace expired the next punch knocks the racer back (sanity)');

        // Re-arm + re-grant for the bomb test.
        clock += HALO.cooldownMs + 100; halo.update();
        check(halo.netState === 100, 'after cooldownMs the halo reads ready again (netState 100)');
        halo.handleHit(bot);
        check(bot.guardShield === true, 'the re-armed halo grants again');

        // Absorb a BOMB blast (and the ice shot — both route through applyExplosionForce).
        bot.velX = 0; bot.velY = 0;
        room.game.gameBoard.applyExplosionForce({ x: bot.x, y: bot.y }, null);
        check(bot.guardShield === false, 'a bomb/ice blast popped the shield');
        check(bot.velX === 0 && bot.velY === 0, 'the blast dealt no knockback (absorbed by the shield)');

        // Re-arm + re-grant for the cut test (needs a second racer as the cutter).
        clock += HALO.cooldownMs + 100; halo.update(); halo.handleHit(bot);
        check(bot.guardShield === true, 're-armed halo grants again for the cut test');
        const cutterId = 'boon-halo-cutter';
        const cutter = room.world.createNewBot(cutterId, Object.assign({}, RACER, { id: 'cutter', name: 'Cutter' }));
        cutter.x = bot.x - 20; cutter.y = bot.y; cutter.angle = 0; cutter.currentState = config.stateMap.racing;
        room.playerList[cutterId] = cutter;
        bot.velX = 0; bot.velY = 0;
        room.game.gameBoard.cutPlayers(cutterId);
        check(bot.guardShield === false, 'a cut popped the shield');
        check(bot.velX === 0 && bot.velY === 0, 'the cut dealt no fling (absorbed by the shield)');
        delete room.playerList[cutterId];

        // Racers only: a ready halo ignores a non-player and a zombie (no grant, not spent).
        clock += HALO.cooldownMs + 100; halo.update();
        const proj = { isProjectile: true };
        halo.handleHit(proj);
        check(halo.netState === 100 && halo.rechargeReadyAt <= clock, 'a non-player does not claim the halo');
        const zombie = { isPlayer: true, isZombie: true };
        halo.handleHit(zombie);
        check(zombie.guardShield == null && halo.netState === 100,
            'a zombie does not claim the halo (boons skip the infection side)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[G] Second Wind Totem respawns a racer at the flag INDEFINITELY until lava eats it');
    {
        const TOTEM = config.boons.secondWindTotem; // id 954
        const kind = hazardKindById(TOTEM.id);
        check(kind != null && kind.helpful === true, 'secondWindTotem resolves through the registry + is helpful (id ' + TOTEM.id + ')');
        check(kind != null && kind.directional === false && kind.railed === false, 'secondWindTotem is non-directional + not railed');

        const map = buildMap('totem', [{ id: TOTEM.id, x: PAD_X, y: ROWS[2] }], [2]);
        const { room, bot } = bootRoom('boon-totem', map, RACER);
        const totem = room.game.gameBoard.hazardList[Object.keys(room.game.gameBoard.hazardList)[0]];
        check(totem != null && totem.id === TOTEM.id && totem.helpful === true,
            'the totem spawned from the map entry into hazardList (helpful=true)');
        check(totem.safe === true && totem.tracksTileSafety === true && totem.netState === 100,
            'the totem starts safe + standing (netState 100) + opts into per-tick tile-safety tracking');
        // Ships on the wire WITH the netState telegraph slot ([7] in newHazards).
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === TOTEM.id && packet[0][2] === PAD_X &&
            packet[0][3] === ROWS[2] && packet[0][7] === 100,
            'compressor.newHazards ships the totem with its standing netState (=100)');

        bot.currentState = config.stateMap.racing;

        // Attune (drive over). No server cue (the flag recolour/bump is client-side off
        // proximity); the death path now knows to revive here.
        bot.reset(config.stateMap.racing); bot.currentState = config.stateMap.racing;
        check(bot.attuneSecondWind(totem) === true, 'driving over the flag attunes the racer');
        check(bot.secondWind === totem, 'the racer is attuned to the flag');
        check(bot.attuneSecondWind(totem) === false, 're-driving over the SAME flag is a no-op');

        // INDEFINITE + DEATH-BEAT: each death starts a respawnDelayMs beat (frozen, invuln,
        // NOT yet teleported, NO death bookkeeping), then Player.update revives at the flag
        // when the delay elapses. The attunement is NOT spent — it repeats every death.
        const DELAY = TOTEM.respawnDelayMs;
        bot.notches = 2;
        for (let d = 1; d <= 3; d++) {
            bot.x = PAD_X - 300; bot.y = ROWS[1]; bot.velX = 200; bot.velY = -50;
            const deathX = bot.x, deathY = bot.y;
            let since = events.length;
            bot.killSelf('lava');
            // The beat: alive + pending + frozen at the death spot, no revive/death yet.
            check(bot.alive === true && bot.secondWindPendingUntil > clock,
                'death #' + d + ': enters the death-beat (still alive, pending)');
            check(bot.x === deathX && bot.y === deathY && bot.enabled === false,
                'death #' + d + ': frozen at the death spot (not yet teleported)');
            check(bot.eliminatedAt == null,
                'death #' + d + ': eliminatedAt NOT stamped during the beat (no team penalty / kill)');
            check(emittedSince('secondWindPending', since) && !emittedSince('secondWind', since)
                && !emittedSince('playerDied', since),
                'death #' + d + ': a secondWindPending fired; no revive/death cue yet');
            // The beat is invuln: a punch during the freeze is swallowed (handleHit guard).
            const beforeX = bot.x;
            bot.handleHit({ x: bot.x + 5, y: bot.y, ownerId: 'atk', mapOwned: true, getBonus: () => 900, isPunch: true });
            check(bot.x === beforeX && bot.velX === 0, 'death #' + d + ': frozen racer is immune mid-beat');
            // Advance past the delay -> the next update finishes the revive at the flag.
            clock += DELAY + 50; fireDueTimers();
            since = events.length;
            bot.update(config.stateMap.racing, DT);
            check(bot.alive === true && bot.secondWindPendingUntil === 0,
                'death #' + d + ': the beat completes and the racer is alive');
            check(bot.x === totem.x && bot.y === totem.y && bot.velX === 0 && bot.velY === 0,
                'death #' + d + ': respawned AT the flag with momentum zeroed');
            check(bot.enabled === true && bot.secondWind === totem,
                'death #' + d + ': back in play, attunement NOT spent (still armed)');
            check(emittedSince('secondWind', since) && !emittedSince('playerDied', since),
                'death #' + d + ': a secondWind event fired and NO playerDied was emitted');
        }
        check(bot.notches === 2, 'kept the notch across every revive (no removeNotch — and no team-points death)');
        check(bot.eliminatedAt == null, 'eliminatedAt still null after repeated respawns (a respawn is never a death)');
        check(bot.invulnUntil > clock, 'the latest respawn granted a brief invuln grace');

        // Re-anchor: driving over a DIFFERENT flag overwrites the attunement.
        const totem2 = kind.build({ x: PAD_X + 200, y: ROWS[3] }, 'm2', room.roomSig);
        check(bot.attuneSecondWind(totem2) === true && bot.secondWind === totem2,
            'driving over a different flag re-anchors the racer to it');
        bot.attuneSecondWind(totem); // restore for the remaining checks

        // Infection side excluded: an attuned racer who is infected dies for REAL (no beat).
        bot.reset(config.stateMap.racing); bot.currentState = config.stateMap.racing;
        bot.attuneSecondWind(totem);
        bot.infected = true;
        bot.killSelf(null);
        check(bot.alive === false && bot.secondWindPendingUntil === 0,
            'an infected racer is not revived — real death, no beat (boons skip the infection side)');

        // Already consumed at death: a flag the lava already ate (safe=false) revives no
        // one — immediate REAL death (this DOES charge the team penalty / kill).
        bot.reset(config.stateMap.racing); bot.currentState = config.stateMap.racing;
        bot.attuneSecondWind(totem);
        totem.safe = false; totem.netState = 0;
        let sinceReal = events.length;
        bot.killSelf('lava');
        check(bot.alive === false && bot.secondWindPendingUntil === 0,
            'a flag already consumed at death (safe=false) -> immediate real death');
        check(emittedSince('playerDied', sinceReal), 'the real death emits playerDied (charges the team penalty)');
        totem.safe = true;

        // Burned DURING the beat: safe at death, but the collapse reaches the flag before
        // the delay elapses -> finishSecondWind falls through to a REAL death. This is the
        // operator's "flag burned" case: the team penalty / kill land here, not on a revive.
        bot.reset(config.stateMap.racing); bot.currentState = config.stateMap.racing;
        bot.attuneSecondWind(totem); totem.safe = true; totem.netState = 100;
        bot.killSelf('lava');
        check(bot.alive === true && bot.secondWindPendingUntil > clock, 'beat begins (flag safe at death)');
        totem.safe = false; // collapse eats the flag mid-beat
        clock += DELAY + 50; fireDueTimers();
        sinceReal = events.length;
        bot.update(config.stateMap.racing, DT);
        check(bot.alive === false, 'a flag burned DURING the beat -> real death (no revive)');
        check(emittedSince('playerDied', sinceReal), 'the burned-mid-beat death emits playerDied (charges the penalty)');
        totem.safe = true;

        // The board keeps safe + netState fresh each tick (tracksTileSafety) — a flag on
        // solid ground reads safe/standing after a live update pass.
        room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        check(totem.safe === true && totem.netState === 100,
            'updateHazards keeps a solid-ground flag flagged safe + standing (netState 100)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[H] Launch Pad flings a racer on a committed airborne arc (tile/lava-immune aloft)');
    {
        const PAD = config.boons.launchPad; // id 955
        const kind = hazardKindById(PAD.id);
        check(kind != null && kind.helpful === true, 'launchPad resolves through the registry + is helpful (id ' + PAD.id + ')');
        check(kind != null && kind.directional === true && kind.railed === false, 'launchPad is directional + not railed');

        const map = buildMap('launch', [{ id: PAD.id, x: PAD_X, y: ROWS[2], angle: 0 }], [2]);
        const { room, bot } = bootRoom('boon-launch', map, RACER);
        const pad = room.game.gameBoard.hazardList[Object.keys(room.game.gameBoard.hazardList)[0]];
        check(pad != null && pad.id === PAD.id && pad.helpful === true,
            'the pad spawned from the map entry into hazardList (helpful=true)');
        // Ships on the wire as [ownerId, id, x, y, angle].
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === PAD.id && packet[0][2] === PAD_X &&
            packet[0][3] === ROWS[2] && packet[0][4] === 0,
            'compressor.newHazards ships the pad as [ownerId, ' + PAD.id + ', x, y, angle]');

        bot.reset(config.stateMap.racing); bot.currentState = config.stateMap.racing;
        bot.x = bot.newX = PAD_X; bot.y = bot.newY = ROWS[2]; bot.velX = 90; bot.velY = 0;
        const fromX = bot.x, fromY = bot.y;
        // An ability held BEFORE the launch must survive the flight (not be consumed).
        bot.ability = { id: 99, use: function () {} };
        // A Slingshot chain in progress must be broken by going airborne (the flight is an
        // untouchable pause, not a continued run of ring passes).
        bot.slingChainUntil = clock + 5000; bot.slingChainCount = 2;
        let since = events.length;
        pad.handleHit(bot);
        check(bot.isAirborne() && bot.isAloft() && bot.enabled === false,
            'driving over the pad flings the racer airborne (frozen + aloft)');
        check(bot.slingChainUntil === 0 && bot.slingChainCount === 0,
            'launching breaks any in-progress Slingshot chain');
        check(Math.abs(bot.airborneToX - (fromX + PAD.distance)) < 0.001 && Math.abs(bot.airborneToY - fromY) < 0.001,
            'the landing spot is distance px along the +x facing');
        check(bot.velX === 0 && bot.velY === 0, 'launch zeroes velocity (no mid-flight steering)');
        check(emittedSince('airbornePending', since), 'an airbornePending event fired for the client hop/camera');
        // Double-dispatch + already-aloft are no-ops (the landing spot doesn't move).
        const toX0 = bot.airborneToX;
        pad.handleHit(bot);
        check(bot.airborneToX === toX0, 'a second hit while already aloft is a no-op (no re-launch)');

        // Mid-flight: lava/punches can't kill (isAloft guard) and the kart lerps along the arc.
        bot.killSelf('lava');
        check(bot.alive === true && bot.isAirborne(), 'lava cannot kill a racer mid-flight (immune aloft)');
        clock += Math.floor(PAD.durationMs / 2);
        bot.update(config.stateMap.racing, DT);
        check(bot.isAirborne() && bot.x > fromX && bot.x < bot.airborneToX,
            'mid-arc the kart has lerped part-way to the landing spot');

        // Land: past the duration the next update finishes the flight at the arc end.
        clock += PAD.durationMs;
        since = events.length;
        bot.update(config.stateMap.racing, DT);
        check(!bot.isAloft() && bot.enabled === true, 'after the duration the racer lands + regains control');
        check(Math.abs(bot.x - toX0) < 0.001 && bot.velX === 0, 'landed exactly at the arc end with momentum zeroed');
        check(emittedSince('airborneLand', since), 'an airborneLand event fired on touchdown');
        check(bot.ability != null && bot.ability.id === 99, 'a held ability survives the launch (not consumed)');
        check(bot.attack === false && bot.attackQueued === false,
            'landing clears the punch latch so a held ability is not auto-spent on touchdown');
        bot.ability = null;

        // Racers only: a non-player and a zombie are ignored.
        const proj = { isProjectile: true };
        pad.handleHit(proj);
        check(proj.airborneUntil == null, 'a non-player object is not launched');
        const zombie = { isPlayer: true, isZombie: true };
        pad.handleHit(zombie);
        check(zombie.airborneUntil == null, 'a zombie is not launched (boons skip the infection side)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[I] Barrel Cannon loads a racer then fires a longer arc on punch / auto-fire');
    {
        const BARREL = config.boons.barrelCannon; // id 956
        const kind = hazardKindById(BARREL.id);
        check(kind != null && kind.helpful === true, 'barrelCannon resolves through the registry + is helpful (id ' + BARREL.id + ')');
        check(kind != null && kind.directional === true && kind.railed === false, 'barrelCannon is directional + not railed');
        check(BARREL.flightDistance >= 120 && BARREL.flightDistance <= 400,
            'the barrel fires a committed arc of a sane distance (' + BARREL.flightDistance + ' px)');

        const map = buildMap('barrel', [{ id: BARREL.id, x: PAD_X, y: ROWS[2], angle: 0 }], [2]);
        const { room, bot } = bootRoom('boon-barrel', map, RACER);
        const barrel = room.game.gameBoard.hazardList[Object.keys(room.game.gameBoard.hazardList)[0]];
        check(barrel != null && barrel.id === BARREL.id && barrel.helpful === true,
            'the barrel spawned from the map entry into hazardList (helpful=true)');
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === BARREL.id && packet[0][4] === 0,
            'compressor.newHazards ships the barrel as [ownerId, ' + BARREL.id + ', x, y, angle]');

        // LOAD: driving in captures the racer at the mouth (frozen, aiming at the author angle).
        bot.reset(config.stateMap.racing); bot.currentState = config.stateMap.racing;
        bot.x = bot.newX = PAD_X - 40; bot.y = bot.newY = ROWS[2]; bot.velX = 120; bot.velY = 30;
        // An ability picked up BEFORE entering must survive the barrel (not be consumed).
        bot.ability = { id: 99, use: function () {} };
        let since = events.length;
        barrel.handleHit(bot);
        check(bot.isBarreled() && bot.isAloft() && !bot.isAirborne() && bot.enabled === false,
            'driving in LOADS the racer (held in the barrel, not yet airborne)');
        check(bot.ability != null, 'loading into the barrel keeps the held ability');
        check(bot.x === PAD_X && bot.y === ROWS[2] && bot.velX === 0,
            'the loaded racer is pinned at the barrel mouth, momentum zeroed');
        check(bot.barrelAimAngle === 0 && bot.angle === 0,
            'the aim starts at the author facing + rides the streamed angle');
        check(emittedSince('barrelLoaded', since), 'a barrelLoaded event fired for the client');

        // ARM WINDOW: a punch (held OR a queued press-edge) in the first minAimMs does NOT
        // fire AND is discarded — not latched — so it can't force-fire the instant armAt opens.
        bot.attack = true; bot.attackQueued = true;
        bot.update(config.stateMap.racing, DT);
        check(bot.isBarreled(), 'a punch within the arming window does not fire');
        check(bot.attack === false && bot.attackQueued === false,
            'a punch in the arming window is discarded, not latched (no force-fire at armAt)');
        bot.attack = false;

        // AUTO-SPIN: with NO player input the barrel sweeps on its own (DK timing shot),
        // and the spinning aim rides the streamed angle.
        const a0 = bot.barrelAimAngle;
        clock += 50;
        for (let i = 0; i < 4; i++) { clock += config.serverTickSpeed; bot.update(config.stateMap.racing, DT); }
        check(bot.barrelAimAngle !== a0 && Math.abs(bot.angle - bot.barrelAimAngle) < 0.001,
            'the barrel auto-spins with no input (streamed via angle)');

        // FIRE on punch past the arming window, in whatever direction the barrel is pointing.
        clock += BARREL.minAimMs + 20;
        bot.attack = true;
        since = events.length;
        bot.update(config.stateMap.racing, DT);
        check(!bot.isBarreled() && bot.isAirborne(), 'a punch past the arming window fires the racer');
        // The launch direction is the barrel's CURRENT spin angle (retained on the bot),
        // and it lands flightDistance px away along it (no clamp at this spot).
        const frad = bot.barrelAimAngle * Math.PI / 180;
        check(Math.abs(bot.airborneToX - (PAD_X + Math.cos(frad) * BARREL.flightDistance)) < 1 &&
            Math.abs(bot.airborneToY - (ROWS[2] + Math.sin(frad) * BARREL.flightDistance)) < 1,
            'fires flightDistance px in the barrel\'s current spin direction');
        check(bot.barrelAimAngle !== 0, 'the fire direction is the spun aim, not the fixed author facing');
        check(emittedSince('airbornePending', since), 'firing emits airbornePending (the flight)');
        bot.attack = false;
        clock += BARREL.flightDurationMs + 10; bot.update(config.stateMap.racing, DT);
        check(!bot.isAloft(), 'the fired racer lands');
        check(bot.ability != null && bot.ability.id === 99, 'the held ability survives firing out of the barrel');
        check(bot.attack === false && bot.attackQueued === false,
            'landing clears the punch latch (held ability not auto-spent on touchdown)');
        bot.ability = null;

        // FIRE on fuse auto-timeout: load again, never punch, advance past autoFireMs.
        bot.reset(config.stateMap.racing); bot.currentState = config.stateMap.racing;
        bot.x = bot.newX = PAD_X - 40; bot.y = bot.newY = ROWS[2];
        barrel.handleHit(bot);
        check(bot.isBarreled(), 'loaded again for the auto-fire case');
        clock += BARREL.autoFireMs + 20;
        bot.update(config.stateMap.racing, DT);
        check(!bot.isBarreled() && bot.isAirborne(), 'the fuse auto-fires when it runs out (no punch needed)');
        const adx = bot.airborneToX - PAD_X, ady = bot.airborneToY - ROWS[2];
        check(Math.abs(Math.sqrt(adx * adx + ady * ady) - BARREL.flightDistance) < 2,
            'auto-fire launches flightDistance px in the current spin direction');
        clock += BARREL.flightDurationMs + 10; bot.update(config.stateMap.racing, DT);

        // Racers only.
        const zombie = { isPlayer: true, isZombie: true };
        barrel.handleHit(zombie);
        check(zombie.barreledUntil == null, 'a zombie is not loaded (boons skip the infection side)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[J] Slingshot Rings pulse along the axis, scaled by centeredness + chained');
    {
        const RING = config.boons.slingshotRings; // id 957
        const kind = hazardKindById(RING.id);
        check(kind != null && kind.helpful === true, 'slingshotRings resolves through the registry + is helpful (id ' + RING.id + ')');
        check(kind != null && kind.directional === true && kind.railed === false, 'slingshotRings is directional + not railed');

        const reach = RING.radius + config.playerBaseRadius;
        // A dead-centre pass on a +x ring gets the full pulse along +x.
        const r1 = kind.build({ x: 300, y: 200, angle: 0 }, 'ring-a', 'sig-j');
        const centered = { id: 'kc', isPlayer: true, x: 300, y: 200, velX: 0, velY: 0, maxVelocity: config.playerMaxSpeed };
        r1.handleHit(centered);
        check(Math.abs(centered.velX - RING.pulse) < 0.001 && Math.abs(centered.velY) < 0.001,
            'a dead-centre pass gets the full pulse along +x (+' + RING.pulse + ')');

        // A glancing pass near the rim barely boosts.
        const r2 = kind.build({ x: 300, y: 200, angle: 0 }, 'ring-b', 'sig-j');
        const glancing = { id: 'kg', isPlayer: true, x: 300, y: 200 + 0.9 * reach, velX: 0, velY: 0, maxVelocity: config.playerMaxSpeed };
        r2.handleHit(glancing);
        check(glancing.velX > 0 && glancing.velX < centered.velX * 0.4,
            'a glancing rim pass boosts much less than a centred one (velX=' + glancing.velX.toFixed(1) + ')');

        // Engine double-dispatch guard: a repeat hit on the same kart in one tick is a no-op.
        const v0 = centered.velX;
        r1.handleHit(centered);
        check(Math.abs(centered.velX - v0) < 0.001, 'a repeat hit on the same kart in one tick does NOT pulse again');

        // Chaining raises the cap: a kart already at a single ring's cap can't be pushed by
        // one ring, but a SECOND ring (a SEPARATE pass, >= chainMinGapMs later) lifts the cap.
        const atCap = { id: 'kk', isPlayer: true, x: 300, y: 200, velX: RING.pulseCap, velY: 0, maxVelocity: config.playerMaxSpeed };
        const ringA = kind.build({ x: 300, y: 200, angle: 0 }, 'ring-c', 'sig-j');
        ringA.handleHit(atCap);
        check(Math.abs(atCap.velX - RING.pulseCap) < 0.001, 'at a single ring cap, that ring adds nothing (no overshoot)');
        check(atCap.slingChainUntil > clock, 'the first ring armed the chain window');
        check(atCap.slingChainCount === 0, 'the first ring is not itself a chain link');
        // A SECOND ring hit in the SAME tick (a tight cluster) must NOT count as a chain link.
        const ringCluster = kind.build({ x: 300, y: 200, angle: 0 }, 'ring-cl', 'sig-j');
        ringCluster.handleHit(atCap);
        check(atCap.slingChainCount === 0,
            'a second ring overlapped in the SAME tick does not inflate the chain (min-gap)');
        // A real second pass, chainMinGapMs later, DOES chain and pushes past the single cap.
        clock += RING.chainMinGapMs + 20;
        const ringB = kind.build({ x: 300, y: 200, angle: 0 }, 'ring-d', 'sig-j');
        ringB.handleHit(atCap);
        check(atCap.slingChainCount >= 1 && atCap.velX > RING.pulseCap,
            'a chained second pass raised the cap and pushed past it (velX=' + atCap.velX.toFixed(1) + ' > ' + RING.pulseCap + ')');

        // Racers only: a non-player, a puck, and a zombie are ignored.
        const proj = { id: 'pj', isProjectile: true, x: 300, y: 200, velX: 0, velY: 0 };
        r1.handleHit(proj);
        check(proj.velX === 0, 'a non-player object is not pulsed');
        const puck = { id: 'pk', isPuck: true, x: 300, y: 200, velX: 0, velY: 0, maxVelocity: config.playerMaxSpeed };
        r1.handleHit(puck);
        check(puck.velX === 0, 'a puck is NOT pulsed (projectile physics would not carry it)');
        const zring = { id: 'zj', isPlayer: true, isZombie: true, x: 300, y: 200, velX: 0, velY: 0, maxVelocity: config.playerMaxSpeed };
        r1.handleHit(zring);
        check(zring.velX === 0, 'a zombie is not pulsed (boons skip the infection side)');

        // Wire: ships as [ownerId, id, x, y, angle].
        const map = buildMap('rings', [{ id: RING.id, x: PAD_X, y: ROWS[2], angle: 0 }], [2]);
        const { room } = bootRoom('boon-rings', map, RACER);
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === RING.id && packet[0][4] === 0,
            'compressor.newHazards ships the ring as [ownerId, ' + RING.id + ', x, y, angle]');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Boons test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Boons test passed.');
process.exit(0);
