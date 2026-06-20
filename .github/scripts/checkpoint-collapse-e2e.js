'use strict';

// END-TO-END headless validation for the "checkpoint flags drag the round out" fix.
//
// Unlike checkpoint-collapse-repro.js (which unit-tests checkForWinners() as a pure
// function of player flags), this boots the REAL server room and drives the REAL
// engine tick loop with NO hand-set state:
//
//   * pins a real committed map that carries a Second Wind totem (the checkpoint
//     flag) and starts a race, so the totem loads into the live hazardList;
//   * places 3 racers on the flag and TICKS — the engine attunes them via the real
//     collision handleHit path (player.secondWind set by game code, not the test);
//   * kills each racer through the real killPlayer() — which routes to the death-beat
//     (beginSecondWind), then Player.update's beat timer fires finishSecondWind ->
//     reviveAtSecondWind, latching secondWindRespawned through real code;
//   * then leaves them camped on the flag and keeps ticking — checkForWinners (run
//     every tick by the live state machine) must now trip the last-stand par
//     collapse, drive startCollapse, burn the totem, and end the round at overview.
//
// Wall-clock is mocked into a clock advanced one tick per frame (a tight synchronous
// tick loop freezes Date.now, so the revive beat and the 15s collapse timer would
// otherwise never fire — see the headless-harness notes in CLAUDE.md).
//
// Run: node .github/scripts/checkpoint-collapse-e2e.js   (not wired into CI)

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

const DT = config.serverTickSpeed / 1000;
const TOTEM_ID = config.boons.secondWindTotem.id; // 954
const RACING = config.stateMap.racing;
const COLLAPSING = config.stateMap.collapsing;
const OVERVIEW = config.stateMap.overview;

let failures = 0;
function check(cond, msg) {
    console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + msg);
    if (!cond) failures++;
}

const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

// --- mock clock: Date.now + setTimeout/clearTimeout backed by a manual clock ----
let mockNow = 1700000000000;
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
let timerQueue = [];
function installClock() {
    Date.now = () => mockNow;
    global.setTimeout = function (fn, delay) {
        const args = Array.prototype.slice.call(arguments, 2);
        const t = { fn, due: mockNow + (delay || 0), args, cancelled: false };
        timerQueue.push(t);
        return t;
    };
    global.clearTimeout = function (t) { if (t) t.cancelled = true; };
}
function restoreClock() {
    Date.now = realNow; global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout;
}
// Advance the clock by `ms`, firing any timers that come due along the way.
function advance(ms) {
    const target = mockNow + ms;
    while (true) {
        let next = null;
        for (const t of timerQueue) if (!t.cancelled && t.due <= target && (next == null || t.due < next.due)) next = t;
        if (next == null) break;
        mockNow = next.due;
        next.cancelled = true;
        next.fn.apply(null, next.args);
    }
    mockNow = target;
}

// No committed map ships a Second Wind totem, so inject one into a real racing map
// at an existing author-placed (drivable, in-world) coordinate. The totem still
// loads through the real boon-build registry into the live hazardList — only the
// map JSON is synthesized, exactly as the editor would produce it.
function loadTotemMap() {
    const file = 'Duality.json';
    let map = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', file), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }
    const existing = Array.isArray(map.hazards) ? map.hazards : [];
    const anchor = existing.length ? existing[0] : { x: config.worldWidth / 2, y: config.worldHeight / 2 };
    // Single totem, no other hazards, so the camp/collapse is uncluttered.
    map.hazards = [{ id: TOTEM_ID, x: anchor.x, y: anchor.y, angle: 0 }];
    return { file, map };
}

const picked = loadTotemMap();
console.log('Using map: ' + picked.file + ' (Second Wind totem injected at a drivable spot)\n');

const room = game.getRoom('e2e-checkpoint', 8);
room.game.gameBoard.isPreview = true;
room.game.gameBoard.previewMap = picked.map;
room.game.startLobby();
room.game.startGated();
room.game.startRace();

// Grab the live totem entity the engine built from the map (room.hazardList is the
// shared list handed to the engine, world and gameBoard).
let totem = null;
for (const id in room.hazardList) {
    if (room.hazardList[id].id === TOTEM_ID) { totem = room.hazardList[id]; break; }
}
check(totem != null, 'the map\'s Second Wind totem is a live entity in the hazardList');
if (totem == null) { process.exit(1); }
check(totem.safe === true, 'totem starts safe (revives are live)');

// Build a clean roster of 3 racers parked ON the totem (drop bots/spawns so the
// counts are deterministic; the totem attune + revive + collapse are all real).
for (const id in room.playerList) { delete room.playerList[id]; }
const ids = ['e2e-p0', 'e2e-p1', 'e2e-p2'];
for (const id of ids) {
    const p = room.world.createNewPlayer(id);
    p.alive = true; p.awake = true; p.enabled = true;
    p.isSpectator = false; p.isZombie = false; p.infected = false;
    p.reachedGoal = false; p.secondWind = null; p.secondWindRespawned = false;
    p.x = totem.x; p.y = totem.y; p.newX = totem.x; p.newY = totem.y; p.velX = 0; p.velY = 0;
    room.playerList[id] = p;
}
room.game.getPlayerCount();
room.game.firstPlaceSig = null; room.game.secondPlaceSig = null;
room.game.collapseInitated = false; room.game.currentState = RACING;

installClock();
mockNow = realNow(); // align the mock clock to wall-clock so timestamps are sane

// Keep the racers camped on the flag and awake every tick (they're stalling, not
// driving for the goal). This does NOT touch alive/enabled/secondWind* — only the
// real engine/revive code mutates those.
function tick() {
    advance(DT * 1000);
    room.update(DT);
    for (const id of ids) {
        const p = room.playerList[id];
        if (p == null) continue;
        p.awake = true;
        if (!p.isReviving()) { p.x = totem.x; p.y = totem.y; p.newX = totem.x; p.newY = totem.y; p.velX = 0; p.velY = 0; }
    }
}

try {
    // [1] Real engine attune: one tick with the racers sitting on the totem.
    tick();
    const attuned = ids.filter(id => room.playerList[id].secondWind === totem).length;
    console.log('[1] Engine attune (drive onto the flag):');
    check(attuned === 3, 'all 3 racers attuned to the totem via the real collision handleHit (' + attuned + '/3)');

    // [2] Real death -> death-beat. killPlayer is exactly what a lava tile calls.
    console.log('\n[2] Real death routes to the Second Wind beat (no real death yet):');
    for (const id of ids) room.playerList[id].killPlayer(room.playerList[id], 'lava');
    const reviving = ids.filter(id => room.playerList[id].isReviving()).length;
    check(reviving === 3, 'all 3 entered the revive beat (isReviving) instead of dying (' + reviving + '/3)');
    check(ids.every(id => !room.playerList[id].secondWindRespawned), 'secondWindRespawned still false — they have not respawned yet');

    // [3] Beat timer elapses -> real revive latches secondWindRespawned.
    console.log('\n[3] Beat elapses -> real reviveAtSecondWind latches the respawn:');
    for (let i = 0; i < 120 && ids.some(id => room.playerList[id].isReviving()); i++) tick();
    check(ids.every(id => room.playerList[id].alive), 'all 3 revived and are alive again');
    check(ids.every(id => room.playerList[id].secondWindRespawned), 'secondWindRespawned latched true on all 3 (real revive path)');
    check(room.game.currentState === RACING && room.game.collapseInitated === false,
        'still racing, no collapse yet — the respawn alone did not end the round');

    // [4] Now they camp. checkForWinners (every tick) must trip the last-stand collapse.
    console.log('\n[4] Camping respawned racers trip the last-stand par collapse:');
    for (let i = 0; i < 60 && !room.game.collapseInitated; i++) { tick(); }
    check(room.game.collapseInitated === true, 'last-stand collapse was scheduled while every racer is a respawn-camper');

    // [5] Drive the loop to resolution: the collapse engages, burns the totem, ends the round.
    console.log('\n[5] Round actually resolves (no drag): collapse -> totem burns -> overview:');
    let sawCollapsing = (room.game.currentState === COLLAPSING);
    let sawTotemBurned = (totem.safe === false);
    let resolvedTick = -1;
    for (let i = 0; i < 8000; i++) {
        tick();
        if (room.game.currentState === COLLAPSING) sawCollapsing = true;
        if (totem.safe === false) sawTotemBurned = true;
        if (room.game.currentState === OVERVIEW) { resolvedTick = i; break; }
    }
    check(sawCollapsing, 'the board entered the collapsing state (par collapse engaged)');
    check(sawTotemBurned, 'the collapsing lava consumed the totem (totem.safe -> false)');
    check(resolvedTick >= 0, 'the round ended at overview instead of dragging on'
        + (resolvedTick >= 0 ? ' (after ' + resolvedTick + ' collapse ticks, ~' + Math.round(resolvedTick * DT) + 's)' : ''));
} catch (e) {
    failures++;
    console.log('  ✗ FAIL: unhandled exception: ' + e.message + '\n' + e.stack);
} finally {
    restoreClock();
}

console.log('');
if (failures > 0) { console.log('E2E validation FAILED with ' + failures + ' failed assertion(s).'); process.exit(1); }
console.log('E2E validation passed: real engine attune -> real respawn -> last-stand collapse -> round resolved.');
process.exit(0);
