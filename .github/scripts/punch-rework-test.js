'use strict';

// Headless behaviour test for the punch rework: momentum-scaled power, hold-to-charge
// (charge is fuelled by stamina; punch fires on RELEASE), the counter/clash contest
// (near-tie reflects, otherwise the stronger punch wins), and the exhausted move-slow.
// Boots the REAL server modules — no network, no browser — like smoke-test.js, and
// mocks Date.now into a clock we advance so cooldown/charge timing is deterministic
// (a tight synchronous loop otherwise freezes wall-clock). See CLAUDE.md.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const { Punch } = require(path.join(repoRoot, 'server', 'entities', 'punch.js'));

const RACING = config.stateMap.racing;

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('  ok  - ' + msg); }
    else { failures++; console.log('::error::FAIL - ' + msg); }
}

const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

function bootRoom() {
    const mapsDir = path.join(repoRoot, 'client', 'maps');
    const file = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'))[0];
    const map = mapFormat.hydrate(JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8')));
    const sig = 'punch-test-room';
    const room = game.getRoom(sig, 4);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    for (let i = 0; i < 2; i++) {
        const id = sig + '-p' + i;
        const p = room.world.createNewPlayer(id);
        p.roomSig = sig;
        room.playerList[id] = p;
        room.game.determineGameState(p);
    }
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();
    return room;
}

const room = bootRoom();
const players = Object.values(room.playerList);
const A = players[0];
const B = players[1];

// Mocked clock for the charge/cooldown timing.
const realNow = Date.now;
let clock = 100000;
Date.now = () => clock;

// Throw a punch via the real press->(hold)->release flow. holdMs=0 is a tap.
function throwPunch(p, holdMs, directional) {
    p.punch = null;
    p.attack = true; p.checkAttack(RACING, directional);   // press: start charge
    if (holdMs > 0) {
        clock += holdMs;
        p.attack = true; p.checkAttack(RACING, directional); // continue charge
    }
    p.attack = false; p.checkAttack(RACING, directional);  // release: throw
    return p.punch;
}

try {
    // -----------------------------------------------------------------------
    // 1) Momentum-scaled bonus: scales with speed TOWARD the aim.
    // -----------------------------------------------------------------------
    console.log('\n[1] momentum-scaled punch bonus');
    A.angle = 0;
    A.velX = 0; A.velY = 0;
    const bonusStanding = A.calcPunchBonus(true);
    A.velX = A.maxVelocity; A.velY = 0;
    const bonusCharging = A.calcPunchBonus(true);
    A.velX = -A.maxVelocity; A.velY = 0;
    const bonusBackward = A.calcPunchBonus(true);
    const m = config.punchMomentum;
    check(Math.abs(bonusStanding - m.floor) < 1e-6, 'standing punch ~= floor (' + bonusStanding.toFixed(2) + ')');
    check(Math.abs(bonusCharging - m.ceil) < 1e-6, 'full-speed punch ~= ceil (' + bonusCharging.toFixed(2) + ')');
    check(bonusBackward <= bonusStanding + 1e-6, 'moving away clamps to floor (' + bonusBackward.toFixed(2) + ')');

    // -----------------------------------------------------------------------
    // 2) Hold-to-charge: a held punch hits harder than a tap and costs the bar.
    // -----------------------------------------------------------------------
    console.log('\n[2] hold-to-charge power + fuel');
    A.stamina = config.punchStamina.max; A.staminaExhausted = false;
    A.punchedTimer = null; A.charging = false;
    A.angle = 0; A.velX = A.maxVelocity; A.velY = 0; // full momentum toward aim

    clock += config.playerPunchCooldown + 1;
    const tap = throwPunch(A, 0, true);
    const tapBonus = tap ? tap.getBonus() : 0;
    const tapStaminaSpent = config.punchStamina.max - A.stamina;

    // Full charge from a fresh bar.
    A.stamina = config.punchStamina.max; A.staminaExhausted = false;
    A.punchedTimer = null; A.charging = false;
    clock += config.playerPunchCooldown + 1;
    const charged = throwPunch(A, config.punchCharge.maxChargeMs, true);
    const chargedBonus = charged ? charged.getBonus() : 0;

    check(tap != null && charged != null, 'both a tap and a full charge throw a punch');
    check(chargedBonus > tapBonus + 0.5, 'full charge hits harder than a tap (' + chargedBonus.toFixed(2) + ' vs ' + tapBonus.toFixed(2) + ')');
    check(chargedBonus > config.punchMomentum.ceil, 'charge pushes force past the momentum-only ceiling (' + chargedBonus.toFixed(2) + ' > ' + config.punchMomentum.ceil + ')');
    check(Math.abs(tapStaminaSpent - config.punchStamina.punchCost) < 1e-6, 'a tap costs punchCost (' + tapStaminaSpent.toFixed(0) + ')');
    check(A.stamina <= 0.001, 'a full charge empties the bar (' + A.stamina.toFixed(1) + ')');
    check(A.staminaExhausted === true, 'a full charge leaves you exhausted');
    check(charged != null && charged.chargeFrac >= config.punchCharge.chargedHitFrac, 'a full charge counts as a charged hit (frac ' + (charged ? charged.chargeFrac.toFixed(2) : 'n/a') + ')');
    check(tap != null && tap.chargeFrac < config.punchCharge.chargedHitFrac, 'a tap is NOT a charged hit');

    // -----------------------------------------------------------------------
    // 3) Stamina: two taps per burst, then blocked until a full recharge.
    // -----------------------------------------------------------------------
    console.log('\n[3] stamina gate (taps)');
    A.stamina = config.punchStamina.max; A.staminaExhausted = false;
    A.punchedTimer = null; A.charging = false;
    A.velX = 0; A.velY = 0;
    let thrown = 0;
    for (let i = 0; i < 5; i++) {
        clock += config.playerPunchCooldown + 1;
        if (throwPunch(A, 0, true) != null) { thrown++; }
    }
    check(thrown === Math.floor(config.punchStamina.max / config.punchStamina.punchCost),
        'threw ' + thrown + ' taps before running dry (max/cost = ' + (config.punchStamina.max / config.punchStamina.punchCost).toFixed(1) + ')');
    check(A.staminaExhausted === true, 'exhausted once drained');
    check(A.charging === false, 'a blocked press does not leave you stuck charging');

    // Regenerate back up: latched until exhaustRecover (a full bar here).
    A.regenStamina((config.punchStamina.exhaustRecover - A.stamina - 1) / config.punchStamina.regenPerSec);
    check(A.staminaExhausted === true, 'still tired just below exhaustRecover (' + A.stamina.toFixed(1) + ')');
    A.regenStamina(config.punchStamina.max / config.punchStamina.regenPerSec);
    check(A.staminaExhausted === false, 'recovered once the bar refills (' + A.stamina.toFixed(1) + ')');
    clock += config.playerPunchCooldown + 1;
    check(throwPunch(A, 0, true) != null, 'can punch again after recovery');

    // -----------------------------------------------------------------------
    // 4) Clash contest: near-tie reflects both; otherwise the stronger wins.
    // -----------------------------------------------------------------------
    console.log('\n[4] clash contest');
    const gb = room.game.gameBoard;
    function setupClash(bonusA, bonusB) {
        A.alive = true; B.alive = true;
        A.x = 100; A.y = 100; A.angle = 0;     // A faces +x toward B
        B.x = 130; B.y = 100; B.angle = 180;   // B faces -x toward A
        A.velX = 0; A.velY = 0; B.velX = 0; B.velY = 0;
        const pa = new Punch(A.x + config.punchReach, A.y, config.punchRadius, A.color, A.id, A.roomSig, bonusA, false);
        pa.directional = true; pa.angle = A.angle; pa.ox = A.x; pa.oy = A.y;
        const pb = new Punch(B.x - config.punchReach, B.y, config.punchRadius, B.color, B.id, B.roomSig, bonusB, false);
        pb.directional = true; pb.angle = B.angle; pb.ox = B.x; pb.oy = B.y;
        gb.punchList = {};
        gb.punchList[A.id] = pa;
        gb.punchList[B.id] = pb;
        return { pa, pb };
    }

    // 4a) Near-tie -> standoff, both flung back by their own momentum.
    const tie = setupClash(1.0, 1.0);
    gb.resolvePunchClashes();
    check(tie.pa.clashed === true && tie.pb.clashed === true, 'near-tie: both punches clash (standoff)');
    check(A.velX < -1 && B.velX > 1, 'standoff flings both owners apart');

    // 4b) Clearly stronger A -> A wins: B nullified, A left to land, neither reflected.
    const win = setupClash(2.5, 0.5);
    gb.resolvePunchClashes();
    check(win.pb.clashed === true, 'stronger wins: weaker punch is cancelled');
    check(win.pa.clashed !== true, 'stronger wins: winner punch left live to land');
    check(A.velX === 0 && B.velX === 0, 'stronger-wins applies no reflect (winner lands normally via collision)');

    // -----------------------------------------------------------------------
    // 5) Overcharge: holding past the danger window wastes the charge and locks
    //    you in the exhausted move penalty.
    // -----------------------------------------------------------------------
    console.log('\n[5] overcharge lock');
    const ch = config.punchCharge;
    A.stamina = config.punchStamina.max; A.staminaExhausted = false;
    A.punchedTimer = null; A.charging = false; A.exhaustLockUntil = 0;
    A.velX = 0; A.velY = 0; A.angle = 0;
    clock += config.playerPunchCooldown + 1;
    A.punch = null;
    A.attack = true; A.checkAttack(RACING, true);            // start charge
    clock += ch.overchargeAfterMs + ch.overchargeFillMs + 10; // hold WAY too long
    A.attack = true; A.checkAttack(RACING, true);            // -> overcharge lock
    check(A.charging === false, 'overcharge cancels the charge');
    check(A.punch == null, 'overcharge throws no punch (charge wasted)');
    check(A.staminaExhausted === true && A.exhaustLockUntil > clock, 'overcharge locks you exhausted');
    A.attack = false; A.checkAttack(RACING, true);
    check(A.punch == null, 'releasing after overcharge still throws nothing');
    A.regenStamina(10); // huge dt — but the lock pauses regen
    check(A.staminaExhausted === true, 'regen is paused during the lock');
    clock = A.exhaustLockUntil + 1;
    A.regenStamina(config.punchStamina.max / config.punchStamina.regenPerSec);
    check(A.staminaExhausted === false, 'recovers once the lock expires');

    // A clashed punch lands on no one.
    B.velX = 0; B.velY = 0;
    B.handlePunchHit(win.pb);
    check(B.velX === 0 && B.velY === 0, 'a clashed punch deals no normal knockback');
    // A normal punch still knocks back (regression guard).
    const fresh = new Punch(B.x - 2, B.y, config.punchRadius, A.color, A.id, A.roomSig, 1, false);
    fresh.directional = true;
    B.velX = 0; B.velY = 0;
    B.handlePunchHit(fresh);
    check(B.velX !== 0 || B.velY !== 0, 'a normal (un-clashed) punch still knocks back');

    // -----------------------------------------------------------------------
    // 6) AI charge policy: bots commit to charges on a good line but can NEVER
    //    hold into the overcharge lock, and tap (no charge) when it's unwise.
    // -----------------------------------------------------------------------
    console.log('\n[6] AI charge policy');
    const ai = require(path.join(repoRoot, 'server', 'aiController.js'));
    function fakeBot(agg, stamina, vx, braking) {
        return { ai: { aggression: agg }, braking: !!braking, stamina: stamina, velX: vx, velY: 0, x: 0, y: 0, maxVelocity: 500 };
    }
    const closing = { player: { x: 50, y: 0 } }; // rival straight ahead (+x)
    let maxHold = 0;
    for (let agg = 0; agg <= 1.001; agg += 0.1) {
        const h = ai._test.chargeHoldFor(fakeBot(agg, config.punchStamina.max, 1000, false), { collapsing: false }, closing);
        if (h > maxHold) { maxHold = h; }
    }
    check(maxHold > 0, 'aggressive bots commit to charges when closing fast (max hold ' + maxHold.toFixed(0) + 'ms)');
    check(maxHold < config.punchCharge.overchargeAfterMs - 500, 'bot charge holds stay well clear of the overcharge line (' + maxHold.toFixed(0) + ' < ' + (config.punchCharge.overchargeAfterMs - 500) + ')');
    check(ai._test.chargeHoldFor(fakeBot(1, 10, 1000, false), { collapsing: false }, closing) === 0, 'low stamina -> tap, not charge');
    check(ai._test.chargeHoldFor(fakeBot(1, config.punchStamina.max, 1000, false), { collapsing: true }, closing) === 0, 'collapsing -> tap (keep mobility)');
    check(ai._test.chargeHoldFor(fakeBot(1, config.punchStamina.max, 1000, true), { collapsing: false }, closing) === 0, 'braking at lava -> tap');
    check(ai._test.chargeHoldFor(fakeBot(1, config.punchStamina.max, 0, false), { collapsing: false }, closing) === 0, 'no closing momentum -> tap');

    // Live sim: two aggressive bots kept adjacent throw real punches under a clock
    // advancing per tick — and NONE ever holds a charge into the overcharge zone.
    const sig2 = 'punch-ai-room';
    const room2 = game.getRoom(sig2, 8);
    room2.game.gameBoard.isPreview = true;
    const mapsDir2 = path.join(repoRoot, 'client', 'maps');
    const f2 = fs.readdirSync(mapsDir2).filter(f => f.endsWith('.json'))[0];
    room2.game.gameBoard.previewMap = mapFormat.hydrate(JSON.parse(fs.readFileSync(path.join(mapsDir2, f2), 'utf8')));
    for (let i = 0; i < 2; i++) {
        const bid = sig2 + '-bot' + i;
        const bot = room2.world.createNewBot(bid, { id: 'tester' + i, name: 'T' + i, title: '', aggression: 0.9, skill: 0.8, tempo: 0.5, risk: 0.4, focus: 'combat' });
        room2.playerList[bid] = bot;
        room2.game.determineGameState(bot);
    }
    room2.game.startLobby(); room2.game.startGated(); room2.game.startRace();
    const bots = Object.values(room2.playerList);
    let botPunches = 0, overchargeViolation = false;
    const prevT = {};
    bots.forEach(b => { prevT[b.id] = b.punchedTimer; });
    const DT2 = config.serverTickSpeed / 1000;
    for (let f = 0; f < 300; f++) {
        if (f % 12 === 0) { // keep them in punching range so they engage
            bots[0].x = 500; bots[0].y = 360; bots[1].x = 528; bots[1].y = 360;
        }
        room2.update(DT2);
        clock += config.serverTickSpeed; // advance the mocked clock ~one tick
        bots.forEach(b => {
            if (b.charging && (clock - b.chargeStartedAt) >= config.punchCharge.overchargeAfterMs) { overchargeViolation = true; }
            if (b.punchedTimer != null && b.punchedTimer !== prevT[b.id]) { botPunches++; prevT[b.id] = b.punchedTimer; }
        });
    }
    check(!overchargeViolation, 'no bot ever held a charge into the overcharge zone');
    check(botPunches > 0, 'bots threw punches under live-paced ticking (' + botPunches + ')');

    // Emergency ice-brake: a bot sliding fast on ice (reduced grip) with steering
    // fighting its momentum should tap to brake; not on normal ground or when aligned.
    const iceBrake = config.playerBrakeCoeff * 0.3; // a slippery tile's grip
    function slider(brakeCoeff, vx, vy, tdx, tdy) {
        return { brakeCoeff: brakeCoeff, velX: vx, velY: vy, targetDirX: tdx, targetDirY: tdy, maxVelocity: 500 };
    }
    // On ice, sliding +x at speed but steering wants -x (turn away) -> brake.
    check(ai._test.emergencyBrakeNeeded(slider(iceBrake, 400, 0, -1, 0)) === true, 'ice slide fighting steering -> emergency brake');
    // Same slide on NORMAL grippy ground -> no wasted brake (normal braking handles it).
    check(ai._test.emergencyBrakeNeeded(slider(config.playerBrakeCoeff, 400, 0, -1, 0)) === false, 'normal ground -> no emergency brake');
    // On ice but momentum aligned with where we want to go (driving forward) -> no brake.
    check(ai._test.emergencyBrakeNeeded(slider(iceBrake, 400, 0, 1, 0)) === false, 'aligned momentum -> no brake');
    // On ice but slow -> no brake.
    check(ai._test.emergencyBrakeNeeded(slider(iceBrake, 30, 0, -1, 0)) === false, 'slow on ice -> no brake');

    // -----------------------------------------------------------------------
    // 7) Directional knockback follows your AIM, even point-blank (the hitbox
    //    sits ahead of you, so a close target must not get flung backward).
    // -----------------------------------------------------------------------
    console.log('\n[7] directional knockback aim');
    const engine = require(path.join(repoRoot, 'server', 'engine.js'));
    function aimedPunch(hitX) {
        const p = new Punch(hitX, 0, config.punchRadius, '#fff', 'att', 'sig', 1.5, false);
        p.directional = true; p.angle = 0; p.ox = 0; p.oy = 0; // puncher at origin facing +x
        return p;
    }
    // Target CLOSER than punchReach -> hitbox overshoots past it. Must still go +x (aim).
    var near = { x: 8, y: 0, velX: 0, velY: 0 };
    engine.punchPlayer(near, aimedPunch(config.punchReach));
    check(near.velX > 0, 'point-blank target shoved along the aim, not backward (velX ' + near.velX.toFixed(0) + ')');
    check(Math.abs(near.velY) < 0.001, 'knockback is straight along the aim');
    // Target beyond reach -> also +x.
    var far = { x: 30, y: 0, velX: 0, velY: 0 };
    engine.punchPlayer(far, aimedPunch(config.punchReach));
    check(far.velX > 0, 'in-front target shoved along the aim');
    // Aim up (angle -90 in degrees = -y): a target gets shoved -y regardless of its side.
    var up = new Punch(0, -config.punchReach, config.punchRadius, '#fff', 'att', 'sig', 1.5, false);
    up.directional = true; up.angle = -90; up.ox = 0; up.oy = 0;
    var aboveTarget = { x: 0, y: -8, velX: 0, velY: 0 }; // target above, closer than reach
    engine.punchPlayer(aboveTarget, up);
    check(aboveTarget.velY < 0, 'aiming up shoves an above target further up, not back down (velY ' + aboveTarget.velY.toFixed(0) + ')');

    // -----------------------------------------------------------------------
    // 8) Review fixes: free zombie bite, death clears charge, sub-tick tap.
    // -----------------------------------------------------------------------
    console.log('\n[8] review fixes');
    // Zombies bite for free (no stamina), even with an empty bar.
    A.isZombie = true; A.stamina = 5; A.staminaExhausted = false; A.charging = false;
    A.punchedTimer = null; A.exhaustLockUntil = 0; A.angle = 0; A.velX = 0; A.velY = 0;
    A.punch = null; A.attack = false; A.attackQueued = false; A.ability = null; A.alive = true;
    clock += config.playerPunchCooldown + 1;
    A.attack = true; A.checkAttack(RACING, true); // zombie bite is instant
    check(A.punch != null, 'zombie bites with a near-empty bar (free, ungated)');
    check(Math.abs(A.stamina - 5) < 1e-6, 'zombie bite consumes no stamina (' + A.stamina.toFixed(0) + ')');

    // killPlayer clears an in-progress charge so a revive can't inherit it.
    A.isZombie = false; A.alive = true; A.enabled = true; A.currentState = RACING; A.punchedBy = null;
    A.charging = true; A.chargeFrac = 0.5; A.overcharge = 0.3; A.exhaustLockUntil = clock + 5000; A.staminaExhausted = true;
    A.killPlayer(A);
    check(A.charging === false && A.overcharge === 0 && A.exhaustLockUntil === 0 && A.staminaExhausted === false,
        'killPlayer clears charge/overcharge/lock state');

    // Sub-tick tap rescue: a queued press with the button already released still throws.
    A.alive = true; A.enabled = true; A.isZombie = false; A.charging = false;
    A.stamina = config.punchStamina.max; A.staminaExhausted = false; A.punchedTimer = null; A.exhaustLockUntil = 0;
    A.punch = null; A.attack = false; A.attackQueued = true;
    clock += config.playerPunchCooldown + 1;
    A.checkAttack(RACING, true);
    check(A.punch != null, 'sub-tick tap (queued press, button already up) still throws');
    check(A.attackQueued === false, 'attackQueued is consumed');
} finally {
    Date.now = realNow;
}

console.log('');
if (failures > 0) {
    console.log('Punch-rework test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Punch-rework test passed.');
process.exit(0);
