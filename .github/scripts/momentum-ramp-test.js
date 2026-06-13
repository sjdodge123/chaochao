'use strict';

// Focused regression test for the human-player momentum ramp (engine.updatePlayers
// + config.momentumRamp). Boots the real engine headlessly and drives a single
// player object tick-by-tick — no network, no map needed (updatePlayers only reads
// the player's drive/drag fields).
//
// Asserts the intended feel:
//   * a human starts at the `floor` drive factor and winds up to full top speed
//     over rampTime seconds (so the START is slower; the old top speed is the cap);
//   * a hard turn/reverse AT SPEED dumps the momentum back to the floor;
//   * a gentle (45°) steering nudge keeps it;
//   * AI bots are EXEMPT — they keep the old full-thrust physics from tick 1
//     (the ramp's floor + jittery-heading reset would freeze them on slow terrain;
//     see ai-fitness.js).
//
// Any failed assertion exits 1.

const fs = require('fs');
const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const engineMod = require(path.join(repoRoot, 'server', 'engine.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const c = require(path.join(repoRoot, 'server', 'config.json'));

// io stand-in so room/world emits (worldResize, startRace, …) don't throw.
messenger.build({ to() { return { emit() { } }; }, sockets: { emit() { } } });

const DT = c.serverTickSpeed / 1000;
const ramp = c.momentumRamp;

if (ramp == null) {
    console.log('::error::config.momentumRamp is missing — the momentum ramp was removed?');
    process.exit(1);
}

function makePlayer(isAI) {
    return {
        alive: true, isAI: !!isAI,
        moveForward: false, moveBackward: false, turnLeft: false, turnRight: false,
        staminaExhausted: false, dripUntil: null,
        velX: 0, velY: 0, newX: 0, newY: 0,
        acel: c.playerBaseAcel, brakeCoeff: c.playerBrakeCoeff, dragCoeff: c.playerDragCoeff,
        maxVelocity: c.playerMaxSpeed, dragMultiplier: 1, currentSpeedBonus: 0,
        momentum: 0, lastMoveDirX: 0, lastMoveDirY: 0, targetDirX: 0, targetDirY: 0, braking: false,
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
let fails = 0;
function check(cond, msg) {
    if (!cond) { fails++; console.log('::error::' + msg); }
    else { console.log('ok: ' + msg); }
}

// --- Human holds UP from a standstill: floor start, winds up to full cap ---
const human = makePlayer(false);
const eng = engineMod.getEngine({ p: human }, {}, {});
human.moveForward = true;

let t = 0;
while (t < 0.6) { eng.update(DT); t += DT; } // < rampTime
const earlySpeed = speed(human);
const earlyFactor = human.getMomentumFactor();

while (t < ramp.rampTime + 1.0) { eng.update(DT); t += DT; } // past rampTime
const fullSpeed = speed(human);

check(human.momentum >= 0.999, 'momentum reaches 1 after rampTime');
check(earlyFactor >= ramp.floor - 1e-6 && earlyFactor < 1, 'early drive factor sits near floor, below full');
check(fullSpeed > earlySpeed + 1, 'kart winds up: full-ramp cruise faster than the early cruise');
check(fullSpeed * ramp.floor < earlySpeed + 5, 'early cruise ≈ floor * full cruise (the start is genuinely slower)');

// --- Hard reverse (180°) at speed dumps momentum ---
human.moveForward = false; human.moveBackward = true;
eng.update(DT);
check(human.momentum === 0, 'hard reverse at speed dumps momentum to the floor');

// --- 45° steering nudge at full momentum keeps it ---
const human2 = makePlayer(false);
const eng2 = engineMod.getEngine({ p: human2 }, {}, {});
human2.moveForward = true;
let t2 = 0;
while (t2 < ramp.rampTime + 1.0) { eng2.update(DT); t2 += DT; }
human2.turnLeft = true; // UP -> UP-LEFT, 45° (dot .707 > resetDot)
eng2.update(DT);
check(human2.momentum > 0.9, '45° steering nudge preserves momentum');

// --- AI bot is exempt: full thrust from tick 1 ---
const bot = makePlayer(true);
const engBot = engineMod.getEngine({ b: bot }, {}, {});
bot.targetDirX = 0; bot.targetDirY = -1;
engBot.update(DT);
const botFirst = speed(bot);

const human3 = makePlayer(false);
const engHuman = engineMod.getEngine({ h: human3 }, {}, {});
human3.moveForward = true;
engHuman.update(DT);
const humanFirst = speed(human3);

check(bot.momentum === 0, 'bot momentum field stays untouched (engine forces factor 1 for AI)');
check(botFirst > humanFirst, 'bot accelerates at full thrust while a human starts at the floor');

// --- Integration: the gated countdown must NOT pre-charge momentum ---
// The engine ticks through every state, so a human holding a direction behind
// the start gate would build momentum to full before the race opens and skip
// the slow start. startRace() resets it; this drives a real room to prove it.
(function gatedStartGuard() {
    const mapsDir = path.join(repoRoot, 'client', 'maps');
    const file = fs.readdirSync(mapsDir).find(f => f.endsWith('.json'));
    let map = JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }

    const room = game.getRoom('momentum-gate-test', 4);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;

    const id = 'momentum-gate-test-p0';
    const player = room.world.createNewPlayer(id);
    room.playerList[id] = player;
    room.game.determineGameState(player);

    room.game.startLobby();
    room.game.startGated();

    // Hold a steady heading through the countdown (engine keeps integrating).
    player.moveForward = true;
    for (let f = 0; f < 120; f++) { room.update(DT); }
    const gatedMomentum = player.momentum;

    room.game.startRace();
    const startMomentum = player.momentum;

    check(gatedMomentum > 0.5, 'momentum does build while ticking behind the gate (proves the risk is real)');
    check(startMomentum === 0, 'startRace resets momentum to the floor — no pre-charge through the gate');
})();

console.log(fails === 0
    ? 'Momentum ramp test passed.'
    : `Momentum ramp test FAILED (${fails}).`);
process.exit(fails === 0 ? 0 : 1);
