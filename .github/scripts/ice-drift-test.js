'use strict';

// Headless behaviour test for ice drifting (the Smooth Operator feature): holding a
// punch charge on ice blends grip toward normal terrain (slight slowdown, real
// steering), and the distance drifted banks toward the Smooth Operator medal ONLY
// when the drift stays clean — a charge whose punch lands on (or clashes with)
// someone is a wind-up, not a drift, and burning up in lava voids the run.
// Boots the REAL server modules — no network, no browser — like smoke-test.js, and
// mocks Date.now into a clock we advance so charge/linger timing is deterministic.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const progression = require(path.join(repoRoot, 'server', 'progression.js'));
const { Punch } = require(path.join(repoRoot, 'server', 'entities', 'punch.js'));

const RACING = config.stateMap.racing;
const ICE = config.tileMap.ice;
const NORMAL = config.tileMap.normal;
const LAVA = config.tileMap.lava;

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
    const sig = 'drift-test-room';
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

// Mocked clock for charge/linger timing.
const realNow = Date.now;
let clock = 100000;
Date.now = () => clock;

// Map-cell stand-ins carrying the tile physics handleMapCellHit reads off the cell.
const iceCell = { isMapCell: true, id: ICE.id, acel: ICE.acel, brakeCoeff: ICE.brakeCoeff, dragCoeff: ICE.dragCoeff };
const lavaCell = { isMapCell: true, id: LAVA.id, acel: LAVA.acel, brakeCoeff: LAVA.brakeCoeff, dragCoeff: LAVA.dragCoeff };

function freshA(state) {
    A.alive = true; A.enabled = true; A.isZombie = false; A.infected = false;
    A.currentState = (state == null) ? RACING : state;
    A.dt = config.serverTickSpeed / 1000;
    A.stamina = config.punchStamina.max; A.staminaExhausted = false;
    A.punchedTimer = null; A.charging = false; A.exhaustLockUntil = 0;
    A.attack = false; A.attackQueued = false; A.ability = null; A.punch = null;
    A.onFire = 0; A.fireTimer = null; A.punchedBy = null; A.burnedBy = null;
    A.pendingDriftDistance = 0; A.driftPunchRef = null; A.driftPunchPending = 0;
    A.driftDistanceTravelled = 0; A.iceDistanceTravelled = 0; A.onIce = false;
    A.velX = 100; A.velY = 0; A.angle = 0;
    clock += config.playerPunchCooldown + 1;
}

try {
    // -----------------------------------------------------------------------
    // 1) Traction: charging on ice blends grip toward normal terrain.
    // -----------------------------------------------------------------------
    console.log('\n[1] drift traction blend');
    freshA();
    A.handleMapCellHit(iceCell);
    check(A.dragCoeff === ICE.dragCoeff && A.brakeCoeff === ICE.brakeCoeff && A.acel === ICE.acel,
        'no charge -> pure ice physics');
    check(A.onIce === true, 'footing stamped onIce on an ice cell');

    A.attack = true; A.checkAttack(RACING); // press: start charge
    A.handleMapCellHit(iceCell);
    check(A.dragCoeff > ICE.dragCoeff && A.dragCoeff < NORMAL.dragCoeff,
        'charging -> drag blended between ice and normal (' + A.dragCoeff.toFixed(4) + ')');
    check(A.brakeCoeff > ICE.brakeCoeff && A.brakeCoeff < NORMAL.brakeCoeff,
        'charging -> brake blended (' + A.brakeCoeff.toFixed(4) + ')');
    check(A.acel > ICE.acel && A.acel < NORMAL.acel,
        'charging -> accel blended (' + A.acel.toFixed(1) + ')');
    const g = config.iceDrift.grip;
    check(Math.abs(A.dragCoeff - (ICE.dragCoeff + (NORMAL.dragCoeff - ICE.dragCoeff) * g)) < 1e-9,
        'blend follows iceDrift.grip = ' + g);

    // -----------------------------------------------------------------------
    // 2) Pending accrual: only while charging, only in real play.
    // -----------------------------------------------------------------------
    console.log('\n[2] pending drift accrual');
    check(A.pendingDriftDistance > 0, 'charging on ice accrues pending drift (' + A.pendingDriftDistance.toFixed(2) + ')');
    const speedDt = Math.sqrt(A.velX * A.velX + A.velY * A.velY) * A.dt;
    check(Math.abs(A.pendingDriftDistance - speedDt) < 1e-9, 'accrual = speed x dt per tick');
    check(A.iceDistanceTravelled > 0, 'Ice Skater distance still clocks alongside the drift');

    freshA(config.stateMap.lobby);
    A.attack = true; A.checkAttack(config.stateMap.lobby);
    A.handleMapCellHit(iceCell);
    check(A.pendingDriftDistance === 0, 'lobby ice is a teaching prop: no drift credit');
    check(A.dragCoeff > ICE.dragCoeff, 'but the traction blend still works in the lobby');
    A.attack = false; A.checkAttack(config.stateMap.lobby); // discharge

    // -----------------------------------------------------------------------
    // 3) A charge dropped without a throw banks its drift (cancelCharge).
    // -----------------------------------------------------------------------
    console.log('\n[3] bank on cancel');
    freshA();
    A.attack = true; A.checkAttack(RACING);
    A.handleMapCellHit(iceCell);
    const pend3 = A.pendingDriftDistance;
    check(pend3 > 0, 'drift pending before the cancel (' + pend3.toFixed(2) + ')');
    A.cancelCharge();
    check(A.driftDistanceTravelled === pend3 && A.pendingDriftDistance === 0,
        'cancelCharge banks the pending drift');

    // -----------------------------------------------------------------------
    // 4) A thrown charge rides escrow: a clean whiff banks, a hit voids,
    //    a clash voids.
    // -----------------------------------------------------------------------
    console.log('\n[4] punch escrow (whiff banks / hit voids / clash voids)');
    function driftAndThrow() {
        freshA();
        A.attack = true; A.checkAttack(RACING);     // press
        clock += 300;                                // hold to a real charge
        A.attack = true; A.checkAttack(RACING);
        A.handleMapCellHit(iceCell);                 // drift a tick on ice
        const pending = A.pendingDriftDistance;
        A.attack = false; A.checkAttack(RACING);     // release: throw
        return pending;
    }

    // 4a) clean whiff -> banked once the linger settles
    const pendWhiff = driftAndThrow();
    check(pendWhiff > 0 && A.punch != null, 'drift-charge threw a punch with pending credit');
    check(A.driftPunchRef === A.punch && A.driftPunchPending === pendWhiff && A.pendingDriftDistance === 0,
        'credit moved into punch escrow on the throw');
    A.checkDriftEscrow();
    check(A.driftDistanceTravelled === 0, 'escrow not judged before resolveMs');
    clock += config.iceDrift.resolveMs + 1;
    A.checkDriftEscrow();
    check(A.driftDistanceTravelled === pendWhiff && A.driftPunchRef == null,
        'a clean whiff banks the escrowed drift (' + pendWhiff.toFixed(2) + ')');

    // 4b) punch lands on someone -> voided
    const pendHit = driftAndThrow();
    B.alive = true; B.currentState = RACING; B.invulnUntil = 0; B.invulnHeldInCircle = false;
    B.x = A.x + 2; B.y = A.y; B.velX = 0; B.velY = 0;
    B.handlePunchHit(A.punch); // victim takes the hit -> punch.landed
    check(A.punch.landed === true, 'victim hit stamps the punch landed');
    clock += config.iceDrift.resolveMs + 1;
    A.checkDriftEscrow();
    check(A.driftDistanceTravelled === 0 && A.driftPunchRef == null,
        'a landed punch voids the drift credit (' + pendHit.toFixed(2) + ' lost)');

    // 4c) clashed punch -> voided too (you engaged, even if it landed on no one)
    driftAndThrow();
    A.punch.clashed = true;
    clock += config.iceDrift.resolveMs + 1;
    A.checkDriftEscrow();
    check(A.driftDistanceTravelled === 0, 'a clashed punch voids the drift credit');

    // -----------------------------------------------------------------------
    // 5) Burning up in lava voids everything pending.
    // -----------------------------------------------------------------------
    console.log('\n[5] lava death voids');
    freshA();
    A.attack = true; A.checkAttack(RACING);
    A.handleMapCellHit(iceCell);
    check(A.pendingDriftDistance > 0, 'drifting toward doom (' + A.pendingDriftDistance.toFixed(2) + ')');
    A.handleMapCellHit(lavaCell); // slides into lava mid-drift -> death
    check(A.alive === false, 'lava kills the drifting kart');
    check(A.pendingDriftDistance === 0 && A.driftDistanceTravelled === 0,
        'lava death voids the pending drift (killPlayer\'s cancelCharge banks nothing)');
    check(A.driftPunchRef == null && A.driftPunchPending === 0, 'escrow cleared too');

    // -----------------------------------------------------------------------
    // 6) keepMomentumOnRelease playtest toggle.
    // -----------------------------------------------------------------------
    console.log('\n[6] keepMomentumOnRelease toggle');
    function releaseSpeed(onIceFooting, keep) {
        const prev = config.iceDrift.keepMomentumOnRelease;
        config.iceDrift.keepMomentumOnRelease = keep;
        freshA();
        A.velX = 200; A.velY = 0;
        A.attack = true; A.checkAttack(RACING);
        clock += 200;
        A.attack = true; A.checkAttack(RACING);
        A.onIce = onIceFooting;
        A.attack = false; A.checkAttack(RACING); // release
        config.iceDrift.keepMomentumOnRelease = prev;
        return A.velX;
    }
    check(Math.abs(releaseSpeed(true, false) - 200 * config.punchThrowBrake) < 1e-6,
        'toggle OFF: releasing on ice still brakes (default ship behaviour)');
    check(releaseSpeed(true, true) === 200,
        'toggle ON: releasing on ice keeps the glide');
    check(Math.abs(releaseSpeed(false, true) - 200 * config.punchThrowBrake) < 1e-6,
        'toggle ON but on solid ground: normal punch brake still applies');

    // -----------------------------------------------------------------------
    // 7) Medal + achievement wiring.
    // -----------------------------------------------------------------------
    console.log('\n[7] Smooth Operator medal + Powder unlock');
    freshA();
    B.isAI = false; A.isAI = false;
    A.driftDistanceTravelled = 120.4; B.driftDistanceTravelled = 40;
    const medals = room.game.gatherAchievements();
    check(medals.smoothOperator != null, 'gatherAchievements emits a smoothOperator medal');
    check(medals.smoothOperator.title === 'Smooth Operator', 'medal titled from MEDAL_TITLES');
    check(medals.smoothOperator.ids.length === 1 && medals.smoothOperator.ids[0] === A.id,
        'the furthest drifter holds the medal');
    check(medals.smoothOperator.value === 120, 'distance rounded like Ice Skater');

    const powder = progression.ACHIEVEMENT_UNLOCKS.find(u => u.id === 'powder');
    check(powder != null && powder.slot === 'trail' && powder.stat === 'smoothOperator',
        'Powder trail gates on the smoothOperator stat');
    const unlocked = progression.achievementsUnlocked({ smoothOperator: powder.threshold }, 0);
    check(unlocked.indexOf('powder') !== -1, 'enough medals unlock Powder');
    const notYet = progression.achievementsUnlocked({ smoothOperator: powder.threshold - 1 }, 0);
    check(notYet.indexOf('powder') === -1, 'one short does not');

    // -----------------------------------------------------------------------
    // 8) Registry lockstep: powder exists server-side, client-side, and has a
    //    renderer (string checks — client scripts are browser globals).
    // -----------------------------------------------------------------------
    console.log('\n[8] skin registry lockstep');
    const srvReg = require(path.join(repoRoot, 'server', 'skinRegistry.js'));
    check(srvReg.getSkinSlot('powder') === 'trail', 'server skinRegistry knows the powder trail');
    const clientReg = fs.readFileSync(path.join(repoRoot, 'client', 'scripts', 'skinRegistry.js'), 'utf8');
    check(/id:\s*'powder'[^\n]*effect:\s*'powder'/.test(clientReg), 'client skinRegistry maps powder -> powder effect');
    const trailFx = fs.readFileSync(path.join(repoRoot, 'client', 'scripts', 'trailEffects.js'), 'utf8');
    check(/function drawPowderTrail\(/.test(trailFx) && /powder:\s*drawPowderTrail/.test(trailFx),
        'trailEffects has the powder renderer registered in TRAIL_FX');
} finally {
    Date.now = realNow;
}

console.log('');
if (failures > 0) {
    console.log('Ice-drift test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Ice-drift test passed.');
process.exit(0);
