'use strict';

// Headless test for the STAR POWER ability (config.tileMap.abilities.starPower).
//
// Star Power makes its holder temporarily invulnerable to everything — punches/
// pucks, explosion + cut knockback, speed buffs/debuffs, swaps, the blindfold
// (bot-side), and lava itself — while the holder can still punch others.
//
// This boots the REAL server modules (no network/browser, same technique as
// smoke-test.js) and asserts each gate directly:
//
//   1. use() -> checkAbilities stamps starPowerUntil and emits "starPower"
//   2. a starred victim ignores a punch (no knockback, no zombie infection)
//   3. a starred victim ignores explosion knockback (applyExplosionForce)
//   4. a starred victim ignores cut knockback (cutPlayers)
//   5. a starred player is skipped by speedDebuff (and leaves no phantom
//      deltaList entry to "restore" later)
//   6. a starred player is skipped by a rival's speedBuff, and removeSpeedBuff
//      unwinds drag ONLY for the players that actually got it (no drift)
//   7. the starred player's own punches still land on others
//   8. swap re-rolls/fizzles rather than yanking a starred player
//   9. lava can't kill a starred player (control player still dies)
//  10. expiry: once starPowerUntil passes, punches land again
//
// Run: node .github/scripts/star-power-test.js

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const game = require(path.join(repoRoot, 'server', 'game.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const { StarPower } = require(path.join(repoRoot, 'server', 'entities', 'abilities.js'));

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok: ' + msg); }
function assert(cond, msg) { if (cond) { ok(msg); } else { fail(msg); } }

// io stand-in that RECORDS room emits so we can assert on the "starPower" /
// "fizzle" events the ability flow sends.
const emitted = [];
require(path.join(repoRoot, 'server', 'messenger.js')).build({
    to() { return { emit(event, payload) { emitted.push({ event: event, payload: payload }); } }; },
    sockets: { emit() { } }
});

// A real committed map so the room boots with valid geometry.
const sampleMapFile = fs.readdirSync(path.join(repoRoot, 'client', 'maps'))
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))[0];
const baseMap = mapFormat.hydrate(JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', sampleMapFile), 'utf8')));

const room = game.getRoom('star-power-test', 12);
room.game.gameBoard.isPreview = true;
room.game.gameBoard.previewMap = baseMap;

// Three players: A (the star), B (a rival/caster), C (a control victim).
const ids = ['star-A', 'rival-B', 'control-C'];
for (const id of ids) {
    const player = room.world.createNewPlayer(id);
    room.playerList[id] = player;
    room.game.determineGameState(player);
}
const gb = room.game.gameBoard;
const A = room.playerList['star-A'];
const B = room.playerList['rival-B'];
const C = room.playerList['control-C'];
room.game.startLobby();
room.game.startGated();
room.game.startRace();

// Park everyone at known interior spots, velocities zeroed.
function park(p, x, y) { p.x = x; p.y = y; p.newX = x; p.newY = y; p.velX = 0; p.velY = 0; }
function moved(p) { return p.velX !== 0 || p.velY !== 0; }
const cx = config.worldWidth / 2, cy = config.worldHeight / 2;

// Minimal punch object: the fields handlePunchHit/_engine.punchPlayer read.
function fakePunch(owner, x, y, infected) {
    return { ownerId: owner, x: x, y: y, clashed: false, mapOwned: false, ownerInfected: !!infected, chargeFrac: 0, getBonus() { return 1; } };
}

// --- 1. activation: use() + checkAbilities stamp starPowerUntil + emit -------
A.ability = new StarPower(A.id, room.sig);
gb.abilityList[A.id] = A.ability;
A.ability.use();
gb.checkAbilities();
assert(A.starPowerUntil > Date.now(), 'use() + checkAbilities stamps starPowerUntil in the future');
assert(A.hasStarPower() === true, 'hasStarPower() is live right after activation');
assert(emitted.some(e => e.event === 'starPower' && e.payload === A.id), 'room got the "starPower" event for the owner');
assert(gb.abilityList[A.id] == null && A.ability == null, 'spent ability is cleared from player + abilityList');

// --- 2. punch immunity (incl. zombie infection) ------------------------------
park(A, cx, cy); park(B, cx + 200, cy); park(C, cx + 220, cy);
A.handlePunchHit(fakePunch(B.id, A.x - 10, A.y, true));
assert(!moved(A), 'starred victim takes no punch knockback');
assert(A.isZombie !== true, 'starred victim is not infected by a zombie punch');
assert(A.punchedBy == null, 'starred victim gets no punchedBy attribution');

// --- 3. explosion immunity ----------------------------------------------------
park(A, cx, cy); park(C, cx + 30, cy);
gb.applyExplosionForce({ x: cx + 15, y: cy }, B.id);
assert(!moved(A), 'starred player ignores explosion knockback');
assert(moved(C), 'control player IS flung by the same explosion');

// --- 4. cut immunity ----------------------------------------------------------
park(A, cx, cy); park(B, cx + 10, cy); park(C, cx - 10, cy);
gb.cutPlayers(B.id);
assert(!moved(A), 'starred player ignores cut knockback');
assert(moved(C), 'control player IS flung by the same cut');

// --- 5. speedDebuff immunity ---------------------------------------------------
const dragA0 = A.dragMultiplier, dragC0 = C.dragMultiplier;
const deltaList = gb.applySpeedDebuff(B.id);
assert(A.dragMultiplier === dragA0, 'starred player keeps their dragMultiplier through a rival speedDebuff');
assert(deltaList[A.id] === undefined, 'starred player is absent from the debuff deltaList (no phantom restore)');
assert(C.dragMultiplier > dragC0, 'control player IS slowed by the same speedDebuff');
gb.removeSpeedDebuff({ playerList: room.playerList, deltaList: deltaList });
assert(C.dragMultiplier === dragC0, 'debuff removal restores the control player exactly');

// --- 6. rival speedBuff skips the star; removal unwinds only the buffed -------
const buffedIds = gb.applySpeedBuff(B.id);
assert(buffedIds.indexOf(A.id) === -1, "starred player is skipped by a rival's speedBuff");
assert(A.dragMultiplier === dragA0, "starred player's drag is untouched by the rival speedBuff");
assert(buffedIds.indexOf(C.id) !== -1, 'control player IS buffed by the same speedBuff');
gb.removeSpeedBuff({ id: B.id, playerList: room.playerList, buffedIds: buffedIds });
assert(A.dragMultiplier === dragA0 && C.dragMultiplier === dragC0 && B.dragMultiplier === 1,
    'buff removal leaves every player at their pre-buff drag (no drift on the skipped star)');

// --- 7. the star can still punch others ---------------------------------------
park(A, cx, cy); park(C, cx + 12, cy);
C.handlePunchHit(fakePunch(A.id, C.x - 10, C.y, false));
assert(moved(C), "the starred player's own punch still lands on a rival");

// --- 8. swap can't target a starred player ------------------------------------
emitted.length = 0;
park(A, cx, cy); park(B, cx + 50, cy);
const aimer = { alive: true, id: B.id, targetList: {} };
aimer.targetList[A.id] = A; // the ONLY candidate is starred -> must fizzle
gb.aimerList[B.id] = aimer;
const posA = { x: A.x, y: A.y }, posB = { x: B.x, y: B.y };
gb.swapOwnerWithRandomPlayer({ context: gb, aimer: aimer, owner: B.id });
assert(emitted.some(e => e.event === 'fizzle' && e.payload === B.id), 'swap with only a starred candidate fizzles');
assert(A.x === posA.x && A.y === posA.y && B.x === posB.x && B.y === posB.y, 'nobody was teleported by the fizzled swap');

// --- 9. lava immunity ----------------------------------------------------------
// killPlayer only fires in racing/collapsing, and player.currentState is stamped
// by ticks this test doesn't run — stamp it so the control death is REAL (and the
// starred survival therefore meaningful, not a state no-op).
const lavaCell = { id: config.tileMap.lava.id, isMapCell: true, acel: 100, dragCoeff: 5, brakeCoeff: 5 };
A.currentState = config.stateMap.racing; C.currentState = config.stateMap.racing;
A.alive = true; C.alive = true; C.onFire = 0;
A.handleMapCellHit(lavaCell);
assert(A.alive === true, 'starred player survives driving on lava');
C.handleMapCellHit(lavaCell);
assert(C.alive === false, 'control player dies on the same lava');

// --- 10. expiry -----------------------------------------------------------------
A.starPowerUntil = Date.now() - 1;
assert(A.hasStarPower() === false, 'hasStarPower() turns off once the timestamp passes');
park(A, cx, cy);
A.handlePunchHit(fakePunch(B.id, A.x - 10, A.y, false));
assert(moved(A), 'after expiry, punches land on the former star again');

if (failures > 0) {
    console.log('star-power-test FAILED (' + failures + ' assertion(s))');
    process.exit(1);
}
console.log('star-power-test passed: all Star Power gates verified.');
