'use strict';

// Focused regression test for the FLUID kart-feel model (config.physicsFluid +
// engine.applyFluidSteering), which is default-ON for human players. Boots the
// real engine headlessly and drives single player objects tick-by-tick — no
// network, no map (updatePlayers only reads the player's drive/drag fields).
//
// Asserts the shipped behaviour (and the bugs fixed during review):
//   * eased steering carves an arc (heading rotates gradually toward input,
//     reaches a full reversal, and stays unit-length — never the old vector-lerp
//     antipode stall);
//   * a launch from a near-stop snaps the heading straight to intent;
//   * coming out of a coast re-seeds the heading from actual velocity (so a
//     mid-coast knockback can't leave you thrusting along a stale heading);
//   * a hard reverse costs a SOFT, graduated bit of momentum (it bleeds, it does
//     NOT dump to the floor like the classic ramp), while a gentle 45° nudge is
//     free;
//   * the release brake is capped per-tile so a slippery surface keeps sliding;
//   * bots NEVER enter the fluid branch (momentum untouched, factor forced 1);
//   * startRace clears the eased heading so it can't leak across the gun.
//
// The classic momentum ramp has its own coverage in momentum-ramp-test.js.
// Any failed assertion exits 1.

const fs = require('fs');
const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const engineMod = require(path.join(repoRoot, 'server', 'engine.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const c = require(path.join(repoRoot, 'server', 'config.json'));

// io stand-in so room/world emits don't throw.
messenger.build({ to() { return { emit() { } }; }, sockets: { emit() { } } });

const DT = c.serverTickSpeed / 1000;
const ramp = c.momentumRamp;
const fluid = c.physicsFluid;

if (fluid == null) {
    console.log('::error::config.physicsFluid is missing — the fluid model was removed?');
    process.exit(1);
}
// This test asserts the fluid default; make sure it is actually on.
fluid.enabled = true;

function makePlayer(isAI) {
    return {
        alive: true, isAI: !!isAI,
        moveForward: false, moveBackward: false, turnLeft: false, turnRight: false,
        staminaExhausted: false, dripUntil: null,
        velX: 0, velY: 0, newX: 0, newY: 0,
        acel: c.playerBaseAcel, brakeCoeff: c.playerBrakeCoeff, dragCoeff: c.playerDragCoeff,
        maxVelocity: c.playerMaxSpeed, dragMultiplier: 1, currentSpeedBonus: 0,
        momentum: 0, lastMoveDirX: 0, lastMoveDirY: 0, targetDirX: 0, targetDirY: 0, braking: false,
        driveHeadingX: 0, driveHeadingY: 0, wasBraking: false,
        getSpeedBonus() { return this.currentSpeedBonus; },
        getDragBonus() { return this.dragMultiplier; },
        getMomentumFactor() {
            if (c.momentumRamp == null) return 1;
            const floor = c.momentumRamp.floor;
            return floor + (1 - floor) * this.momentum;
        }
    };
}

const speed = (p) => Math.hypot(p.velX, p.velY);
const headMag = (p) => Math.hypot(p.driveHeadingX, p.driveHeadingY);
const finite = (p) => Number.isFinite(p.driveHeadingX) && Number.isFinite(p.driveHeadingY) && Number.isFinite(p.momentum);
let fails = 0;
function check(cond, msg) {
    if (!cond) { fails++; console.log('::error::' + msg); }
    else { console.log('ok: ' + msg); }
}

// Wind a human up to full momentum holding UP (dir = (0,-1)).
function windUp() {
    const h = makePlayer(false);
    const eng = engineMod.getEngine({ p: h }, {}, {});
    h.moveForward = true;
    let t = 0;
    while (t < ramp.rampTime + 1.0) { eng.update(DT); t += DT; }
    return { h, eng };
}

// --- Eased steering: gradual carve, clean reversal, unit-length, no NaN ---
(function easedCarve() {
    const { h, eng } = windUp();
    // Heading is ~UP after winding up holding UP.
    check(h.driveHeadingY < -0.9, 'after winding up, eased heading points along travel (UP)');
    // Now reverse the input (hold DOWN). The heading must rotate gradually.
    h.moveForward = false; h.moveBackward = true;
    eng.update(DT);
    const dotAfter1 = h.driveHeadingY * 1; // input DOWN = (0,+1); dot = headingY
    check(headMag(h) > 0.99 && headMag(h) < 1.01, 'heading stays unit-length mid-turn');
    check(finite(h), 'no NaN in the eased heading');
    check(dotAfter1 < 0.9, 'reversal is gradual — heading has NOT snapped straight to input after one tick');
    let unit = true;
    for (let i = 0; i < 14; i++) { eng.update(DT); if (headMag(h) < 0.99 || headMag(h) > 1.01) unit = false; }
    check(unit, 'heading stays unit-length through the whole reversal');
    check(h.driveHeadingY > 0.9, 'reversal completes — heading reaches the new (DOWN) input');
})();

// --- Near-stop launch snaps the heading straight to intent ---
(function snapLaunch() {
    const h = makePlayer(false);
    const eng = engineMod.getEngine({ p: h }, {}, {});
    h.moveForward = true; // UP from a dead stop
    eng.update(DT);
    check(h.driveHeadingY < -0.99 && Math.abs(h.driveHeadingX) < 1e-6, 'launch from near-stop snaps heading to intent');
})();

// --- Coast -> move re-seeds the heading from actual velocity (knockback safety) ---
(function coastReseed() {
    const { h, eng } = windUp(); // heading ~UP, moving UP fast
    h.moveForward = false; // release: coast
    eng.update(DT); eng.update(DT);
    check(h.wasBraking === true, 'releasing input flags a coast (wasBraking)');
    // Simulate a knockback that rotates our velocity to the RIGHT mid-coast.
    h.velX = 80; h.velY = 0;
    // Re-press UP. The eased heading should re-seed from velocity (RIGHT), not the
    // stale UP heading, then ease toward UP.
    h.moveForward = true;
    eng.update(DT);
    check(h.driveHeadingX > 0.5, 'coast->move re-seeds heading from velocity (RIGHT), not the stale UP heading');
})();

// --- Soft, graduated turn cost: hard reverse bleeds (not dumps); 45° is free ---
(function softPenalty() {
    const { h } = windUp();
    const eng = engineMod.getEngine({ p: h }, {}, {});
    check(h.momentum >= 0.999, 'momentum is full after winding up');
    // Hard reverse (180°) at speed.
    h.moveForward = false; h.moveBackward = true;
    eng.update(DT);
    check(h.momentum < 0.999, 'hard reverse costs momentum (a soft bleed begins)');
    check(h.momentum > 0.05, 'hard reverse does NOT dump momentum to the floor like the classic ramp');
    let minMom = h.momentum;
    for (let i = 0; i < 6; i++) { eng.update(DT); minMom = Math.min(minMom, h.momentum); }
    check(minMom < 0.7, 'sustained hard reverse bleeds a meaningful chunk of momentum');
    check(minMom > 0.0, 'but never a full instant dump');

    // 45° nudge at full momentum keeps it.
    const { h: h2 } = windUp();
    const eng2 = engineMod.getEngine({ p: h2 }, {}, {});
    h2.turnLeft = true; // UP -> UP-LEFT, 45° (dot .707 > turnPenaltyDot 0.4)
    eng2.update(DT);
    check(h2.momentum > 0.9, '45° nudge is free — no turn penalty above turnPenaltyDot');
})();

// --- Release brake is capped per-tile: ice (brakeCoeff ~0) keeps sliding ---
(function iceCoastCap() {
    const h = makePlayer(false);
    const eng = engineMod.getEngine({ p: h }, {}, {});
    h.velX = 80; h.velY = 0;               // moving fast
    h.driveHeadingX = 1; h.driveHeadingY = 0;
    h.brakeCoeff = c.tileMap.ice.brakeCoeff; // footing is ice (tile stamps this each tick)
    // No input -> coast/brake. min(iceBrake 0.0001, releaseBrakeCoeff 0.08) = iceBrake.
    eng.update(DT);
    check(speed(h) > 79.5, 'ice release-brake stays slippery (flat releaseBrakeCoeff would scrub ~6 u/s)');

    // Sanity: on normal ground the soft coast does bleed (cap = releaseBrakeCoeff).
    const g = makePlayer(false);
    const engG = engineMod.getEngine({ p: g }, {}, {});
    g.velX = 80; g.velY = 0; g.driveHeadingX = 1; g.driveHeadingY = 0;
    g.brakeCoeff = c.playerBrakeCoeff; // normal ground (0.235 > 0.08)
    engG.update(DT);
    check(speed(g) < 79.5 && speed(g) > 70, 'normal-ground coast bleeds on the soft releaseBrakeCoeff');
})();

// --- Bots never enter the fluid branch ---
(function botExempt() {
    const bot = makePlayer(true);
    const eng = engineMod.getEngine({ b: bot }, {}, {});
    bot.targetDirX = 0; bot.targetDirY = -1;
    for (let i = 0; i < 30; i++) eng.update(DT);
    bot.targetDirX = 0; bot.targetDirY = 1; // hard reverse
    eng.update(DT);
    check(bot.momentum === 0, 'bot momentum field stays untouched (no fluid bleed; engine forces factor 1)');
    check(bot.driveHeadingX === 0 && bot.driveHeadingY === 0, 'bot eased heading is never written');
})();

// --- startRace clears the eased heading (no leak across the gun) ---
(function gateReset() {
    const mapsDir = path.join(repoRoot, 'client', 'maps');
    const file = fs.readdirSync(mapsDir).find(f => f.endsWith('.json'));
    let map = JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }

    const room = game.getRoom('fluid-gate-test', 4);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;

    const id = 'fluid-gate-test-p0';
    const player = room.world.createNewPlayer(id);
    room.playerList[id] = player;
    room.game.determineGameState(player);

    room.game.startLobby();
    room.game.startGated();

    player.moveForward = true; // jukes a heading behind the countdown
    for (let f = 0; f < 120; f++) { room.update(DT); }
    const gatedHeadMag = Math.hypot(player.driveHeadingX, player.driveHeadingY);

    room.game.startRace();

    check(gatedHeadMag > 0.5, 'an eased heading does build while ticking behind the gate (proves the risk)');
    check(player.driveHeadingX === 0 && player.driveHeadingY === 0, 'startRace clears the eased heading — no diagonal launch off the line');
})();

console.log(fails === 0
    ? 'Fluid physics test passed.'
    : `Fluid physics test FAILED (${fails}).`);
process.exit(fails === 0 ? 0 : 1);
