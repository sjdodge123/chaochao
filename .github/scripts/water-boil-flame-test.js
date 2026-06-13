'use strict';

// Headless test for the water slow-boil + fire-walk water-crossing feature.
//
// Boots the real server engine (no network/browser), like smoke-test.js, and asserts:
//
//   Session 1 — fire-walk: a kart carrying a killstreak fire shield STRIDES across water
//     (walking grip, no swim) while the shield rides down exactly like on lava, and only
//     drops into the swim once the shield burns out (with a flameExtinguished cue).
//
//   Session 2 — slow-boil: during a collapse, water does NOT flash straight to lava. Each
//     water cell the front reaches sits in gameBoard.boilingWater for ~collapseBoilMs
//     (emitting tiered 'waterBoiling' warnings) before it converts.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

const TICK_MS = config.serverTickSpeed;

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok: ' + msg); }

// Recording io: messageRoomBySig() -> io.to(sig).emit(header, payload). Capture every
// room broadcast so we can assert on flameExtinguished / waterBoiling.
const events = [];
const recordingIo = {
    to() { return { emit(header, payload) { events.push({ header: header, payload: payload }); } }; },
    emit() { },
    sockets: { emit() { } }
};
messenger.build(recordingIo);

function approxEq(a, b) { return Math.abs(a - b) < 1e-6; }

// ---------------------------------------------------------------------------
// Session 1: fire-walk across water on the killstreak shield.
// ---------------------------------------------------------------------------
function sessionFireWalk() {
    const water = config.tileMap.water;
    const normal = config.tileMap.normal;
    const waterCell = {
        id: water.id, acel: water.acel, dragCoeff: water.dragCoeff,
        brakeCoeff: water.brakeCoeff, voronoiId: 1
    };

    const room = game.getRoom('boil-firewalk', 4);
    const p = room.world.createNewPlayer('fw-p');
    room.playerList['fw-p'] = p;
    p.currentState = config.stateMap.racing;
    p.isZombie = false;

    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
        // (a) NOT on fire: water is deep water -> swim physics, onWater true.
        p.onFire = 0; p.fireTimer = null; p.onWater = false;
        p.handleMapCellHit(waterCell);
        if (p.onWater !== true) fail('Session 1a: a non-burning kart on water should have onWater=true (swim)');
        else if (!approxEq(p.acel, water.acel)) fail('Session 1a: swimmer should take deep-water acel, got ' + p.acel);
        else ok('non-burning kart swims (onWater=true, deep-water grip)');

        // (b) On fire: strides — walking grip, onWater cleared, shield still alive.
        p.onFire = 1000; p.fireTimer = null;
        const t0 = clock;
        p.handleMapCellHit(waterCell);
        if (p.onWater !== false) fail('Session 1b: a fire-walker should have onWater=false (no swim)');
        else if (!approxEq(p.acel, normal.acel)) fail('Session 1b: fire-walker should take solid (normal) grip, got ' + p.acel);
        else if (!(p.onFire > 0)) fail('Session 1b: the shield must NOT extinguish on contact (full-shield crossing)');
        else if (p.fireTimer == null) fail('Session 1b: fire-walking should arm the shield timer (ride it down like lava)');
        else ok('fire-walker strides across water (walking grip, shield rides down, no instant douse)');

        // (c) Shield burns out over water: extinguished + douse cue, then back to swimming.
        const beforeExtinguish = events.length;
        clock = t0 + 1200; // past the 1000ms shield
        p.handleMapCellHit(waterCell);
        if (p.onFire !== 0) fail('Session 1c: shield should be fully spent after its duration, onFire=' + p.onFire);
        const doused = events.slice(beforeExtinguish).some(e => e.header === 'flameExtinguished' && e.payload && e.payload.owner === 'fw-p');
        if (!doused) fail('Session 1c: a flameExtinguished cue should fire when the shield boils away over water');
        if (failures === 0) ok('shield boils away over water -> extinguished with a steam cue');

        // (d) Next tick with the shield gone: deep-water swim resumes.
        p.handleMapCellHit(waterCell);
        if (p.onWater !== true || !approxEq(p.acel, water.acel)) fail('Session 1d: with the shield gone the kart should swim again');
        else ok('shield gone -> kart drops back into the swim');
    } finally {
        Date.now = realNow;
    }
    if (failures === 0) console.log('Session 1 passed: fire-walk water crossing.');
}

// ---------------------------------------------------------------------------
// Session 2: water slow-boils for collapseBoilMs before converting to lava.
// ---------------------------------------------------------------------------
function sessionSlowBoil() {
    const water = config.tileMap.water;
    const lavaId = config.tileMap.lava.id;
    const boilMs = water.collapseBoilMs;

    // A committed water map (the collapse front must actually pass water cells).
    let map = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', 'TheFlow.json'), 'utf8'));
    if (mapFormat.isSitesOnly(map)) map = mapFormat.reconstruct(map);

    const room = game.getRoom('boil-collapse', 4);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    for (let i = 0; i < 2; i++) {
        const id = 'bc-p' + i;
        const player = room.world.createNewPlayer(id);
        room.playerList[id] = player;
        room.game.determineGameState(player);
    }

    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
        room.game.startLobby();
        room.game.startGated();
        room.game.startRace();

        // Drive the collapse mechanic DIRECTLY (not through the round state machine):
        // with idle players the round would end before the front sweeps the water, so we
        // sweep collapseLine across the whole board ourselves and tick collapseMap, which
        // takes the state as an arg and is the single water-boil path.
        const gb = room.game.gameBoard;
        const cx = config.worldWidth / 2, cy = config.worldHeight / 2;
        const cells = gb.currentMap.cells;
        const firstBoilAt = {};   // vid -> mock-time it entered boilingWater
        const convertAt = {};     // vid -> mock-time its cell flipped to lava
        const wasWater = {};
        let maxWaterDist = 0;
        for (let i = 0; i < cells.length; i++) {
            if (cells[i].id === water.id) {
                wasWater[cells[i].site.voronoiId] = true;
                const d = Math.hypot(cx - cells[i].site.x, cy - cells[i].site.y);
                if (d > maxWaterDist) maxWaterDist = d;
            }
        }
        const totalWater = Object.keys(wasWater).length;
        if (totalWater === 0) { fail('Session 2: TheFlow has no water cells to boil'); return; }

        gb.collapseLoc = { x: cx, y: cy };
        gb.collapseLine = maxWaterDist + 20;       // start the front right at the water band
        gb.firstPlaceSig = 'test-winner';          // game-concluded -> the fast sweep speed
        gb.soloMode = false;

        let sawBoilEvent = false;
        for (let f = 0; f < 900; f++) {
            clock += TICK_MS;               // advance the boil clock one tick
            const before = events.length;
            gb.collapseMap(config.stateMap.collapsing);
            for (let e = before; e < events.length; e++) {
                if (events[e].header === 'waterBoiling') sawBoilEvent = true;
            }
            const boiling = gb.boilingWater;
            for (const vid in boiling) {
                if (firstBoilAt[vid] == null) firstBoilAt[vid] = boiling[vid].startedAt;
            }
            for (let i = 0; i < cells.length; i++) {
                const vid = cells[i].site.voronoiId;
                if (wasWater[vid] && convertAt[vid] == null && cells[i].id === lavaId) {
                    convertAt[vid] = clock;
                }
            }
        }

        if (!sawBoilEvent) fail('Session 2: no waterBoiling tier events were emitted (water converted instantly?)');
        else ok('water emitted tiered boil warnings instead of flashing to lava');

        let measured = 0, badDelay = 0, remainingWater = 0;
        for (let i = 0; i < cells.length; i++) {
            if (cells[i].id === water.id) remainingWater++;
        }
        for (const vid in convertAt) {
            if (firstBoilAt[vid] == null) continue;
            const delay = convertAt[vid] - firstBoilAt[vid];
            measured++;
            // Convert fires on the first tick where elapsed >= boilMs, so the delay lands
            // in [boilMs, boilMs + a couple ticks]. Anything shorter means it skipped the boil.
            if (delay < boilMs - 1 || delay > boilMs + 3 * TICK_MS) {
                badDelay++;
                if (badDelay <= 3) fail('Session 2: cell ' + vid + ' converted after ' + Math.round(delay) + 'ms (expected ~' + boilMs + 'ms boil)');
            }
        }
        if (measured === 0) fail('Session 2: no water cell completed a boil->lava transition in the window');
        else if (badDelay === 0) ok('all ' + measured + ' boiled cell(s) waited ~' + boilMs + 'ms before converting');

        if (remainingWater > 0) {
            // Not a hard failure (the front may not reach every cell), just informational.
            console.log('  note: ' + remainingWater + '/' + totalWater + ' water cells were not reached by the collapse front');
        }
    } finally {
        Date.now = realNow;
    }
    if (failures === 0) console.log('Session 2 passed: water slow-boils ~' + boilMs + 'ms before lava.');
}

try {
    sessionFireWalk();
    if (failures === 0) sessionSlowBoil();
} catch (e) {
    fail('Unhandled exception: ' + e.message + '\n' + e.stack);
}

if (failures > 0) {
    console.log('\nWater-boil/flame test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nWater-boil/flame test passed.');
process.exit(0);
