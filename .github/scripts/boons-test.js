'use strict';

// Real-engine headless test for the Boon framework + its first kind, Dash Arrows
// (config.boons.dashArrows). Boons are the helpful counterpart to hazards: they
// reuse the hazard-kind registry, the runtime hazardList, the wire, and the editor
// pipeline, distinguished only by helpful:true (which gates the lightning speed-up,
// the AI's repulsion/cell-penalty, and the classifier's difficulty count).
//
//   [A] Registry + handleHit (pure). The dashArrows kind resolves by id, is
//       directional + helpful, builds a live boon (helpful flag set), and its
//       handleHit imparts a velocity impulse along the pad's angle for a
//       player/puck only.
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
//   [E] Slipstream (config.boons.slipstream). A directional wind corridor: a gentle
//       constant push along its axis up to currentSpeed, capped (never overshoots,
//       never brakes a faster kart), that fights a backward-driven kart. Players +
//       pucks only; ships on the wire as [ownerId, id, x, y, angle].
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

        // A 90deg pad pushes +y; a non-player/non-puck is ignored.
        const up = kind.build({ x: 0, y: 0, angle: 90 }, 'boon-a2', 'sig-a');
        const kart2 = { isPlayer: true, velX: 0, velY: 0 };
        up.handleHit(kart2);
        check(Math.abs(kart2.velX) < 0.001 && Math.abs(kart2.velY - DASH.boost) < 0.001,
            'a 90deg pad pushes along +y');
        const before = { x: 0, y: 0 };
        const proj = { isProjectile: true, velX: 0, velY: 0 };
        boon.handleHit(proj);
        check(proj.velX === 0 && proj.velY === 0, 'a non-player/non-puck object is not boosted');
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

        // A non-player/non-puck is ignored; a puck IS carried.
        const proj = { id: 'proj', isProjectile: true, velX: 0, velY: 0 };
        s.handleHit(proj);
        check(proj.velX === 0 && proj.velY === 0, 'a non-player/non-puck object is not pushed');
        const puck = { id: 'puck', isPuck: true, velX: 0, velY: 0, maxVelocity: config.playerMaxSpeed };
        s.handleHit(puck);
        check(Math.abs(puck.velX - STREAM.push) < 0.001, 'a puck IS carried by the current');

        // Wire: a slipstream ships as [ownerId, id, x, y, angle].
        const map = buildMap('stream', [{ id: STREAM.id, x: PAD_X, y: ROWS[2], angle: 0 }], [2]);
        const { room } = bootRoom('boon-stream', map, { id: 'racer', name: 'Racer', title: '', skill: 0.85, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        const packet = JSON.parse(compressor.newHazards(room.game.gameBoard.hazardList));
        check(packet.length === 1 && packet[0][1] === STREAM.id && packet[0][2] === PAD_X &&
            packet[0][3] === ROWS[2] && packet[0][4] === 0,
            'compressor.newHazards ships the slipstream as [ownerId, ' + STREAM.id + ', x, y, angle]');
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
