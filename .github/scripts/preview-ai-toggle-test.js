'use strict';

// Headless test for the map-editor "Enable AI racers" preview toggle.
//
// Boots REAL server modules (no network/browser) and exercises the preview
// path through the actual createPreviewRoom messenger handler, the way the
// editor does:
//
//   Phase A (AI OFF, the default): createPreviewRoom with enableAI:false -> a
//     lone human joins -> assert ZERO bots are added at startGated -> drive
//     gated -> racing -> collapsing -> overview, then force the documented win
//     condition and assert it reaches gameOver, all without throwing or
//     emitting a malformed compressor payload.
//
//   Phase B (AI ON): createPreviewRoom with enableAI:true -> a lone human joins
//     -> assert bots DO fill the grid (the toggle still works like before).
//
// Run: node .github/scripts/preview-ai-toggle-test.js   (from the repo root)

const fs = require('fs');
const path = require('path');

// Resolve the repo root from this file's location so the test runs from any
// checkout / worktree (.github/scripts/ -> repo root is two levels up).
const repoRoot = process.env.REPO_ROOT || path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const hostess = require(path.join(repoRoot, 'server', 'hostess.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

const DT = config.serverTickSpeed / 1000;
const MOVES = ['moveForward', 'moveBackward', 'turnLeft', 'turnRight', 'attack'];

// Seeded PRNG (mulberry32) so the driven input/aim is reproducible run-to-run,
// matching the repo's headless-test convention (CLAUDE.md). Override with
// SEED=<n> to reproduce a specific sequence. Pass/fail here doesn't hinge on the
// sequence, but determinism keeps coverage stable and any failure repeatable.
let rngState = (parseInt(process.env.SEED, 10) || 0x9e3779b9) >>> 0;
function rng() {
    rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok - ' + msg); }

// Fake socket that RECORDS outbound emits so we can read previewRoomCreated.
function makeFakeSocket(id) {
    const handlers = {};
    const emits = [];
    return {
        id, handlers, emits,
        on(event, fn) { handlers[event] = fn; },
        emit(event, payload) { emits.push({ event, payload }); },
        join() { }, leave() { },
        broadcast: { to() { return { emit() { } }; } },
        fire(event, payload) { if (handlers[event]) handlers[event](payload); },
        lastEmit(event) {
            for (let i = emits.length - 1; i >= 0; i--) if (emits[i].event === event) return emits[i].payload;
            return null;
        }
    };
}

const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };

function randomInput() {
    const p = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
    for (const m of MOVES) if (rng() < 0.5) p[m] = true;
    return p;
}

function assertUpdatesWellFormed(room, label) {
    const checks = {
        playerList: compressor.sendPlayerUpdates(room.playerList),
        projList: compressor.sendProjUpdates(room.projectileList),
        aimerList: compressor.sendAimerUpdates(room.aimerList),
        hazardList: compressor.sendHazardUpdates(room.hazardList)
    };
    for (const key in checks) {
        if (!Array.isArray(checks[key])) fail(label + ': compressor.' + key + ' non-array');
    }
}

function countPlayers(room) {
    let humans = 0, bots = 0;
    for (const id in room.playerList) {
        if (room.playerList[id].isAI) bots++; else humans++;
    }
    return { humans, bots };
}

// Pick the first committed map (any valid map works for the state-machine test).
function loadAMap() {
    const mapsDir = path.join(repoRoot, 'client', 'maps');
    const files = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'));
    return JSON.parse(fs.readFileSync(path.join(mapsDir, files[0]), 'utf8'));
}

// Create a preview room through the REAL messenger handler, then join one human.
function bootPreview(label, enableAI, map) {
    const editor = makeFakeSocket(label + '-editor');
    messenger.addMailBox(editor.id, editor);
    editor.fire('createPreviewRoom', JSON.stringify({ map, enableAI }));

    const created = editor.lastEmit('previewRoomCreated');
    if (created == null || created.gameID == null) {
        fail(label + ': createPreviewRoom did not emit previewRoomCreated');
        return null;
    }
    const sig = created.gameID;
    const room = hostess.getRoomBySig(sig);
    if (room == null) { fail(label + ': preview room not found for sig ' + sig); return null; }

    // A human joins the preview room (the editor's play page does this).
    const human = makeFakeSocket(label + '-human');
    messenger.addMailBox(human.id, human);
    human.fire('enterGame', sig);

    return { sig, room, human, editor };
}

function teardown(boot) {
    hostess.kickFromRoom(boot.human.id);
    messenger.removeMailBox(boot.human.id);
    messenger.removeMailBox(boot.editor.id);
}

// ---------------------------------------------------------------------------
// Phase A: AI OFF -> zero bots, full state machine runs clean.
// ---------------------------------------------------------------------------
function phaseAOff(map) {
    console.log('Phase A: preview with AI OFF (default)');
    const boot = bootPreview('A', false, map);
    if (boot == null) return;
    const { room, human } = boot;

    // Verify the flag landed on the gameBoard as "off".
    if (room.game.gameBoard.previewAI !== false) {
        fail('Phase A: gameBoard.previewAI should be false, got ' + room.game.gameBoard.previewAI);
    }

    // Drive the preview's race-start path. startLobby() first (world.resize builds
    // the engine quadTree), exactly like the live waiting->lobby->gated progression;
    // startGated() is where bots would fill.
    room.game.startLobby();
    room.game.startGated();
    let pc = countPlayers(room);
    if (pc.bots !== 0) fail('Phase A: expected 0 bots after startGated, got ' + pc.bots);
    else ok('0 bots added at startGated');
    if (pc.humans !== 1) fail('Phase A: expected 1 human, got ' + pc.humans);
    else ok('1 human present');

    // gated -> racing, tick a while.
    room.game.startRace();
    for (let f = 0; f < 200; f++) {
        human.fire('movement', randomInput());
        human.fire('mousemove', rng() * 360);
        hostess.updateRooms(DT);
        assertUpdatesWellFormed(room, 'Phase A racing frame ' + f);
        if (failures > 0) { teardown(boot); return; }
    }
    ok('racing ticked 200 frames, no throw / well-formed payloads');

    // racing -> collapsing: force the collapse (live path is a wall-clock timer).
    room.game.startCollapse(config.worldWidth / 2, config.worldHeight / 2);
    for (let f = 0; f < 400; f++) {
        human.fire('movement', randomInput());
        hostess.updateRooms(DT);
        assertUpdatesWellFormed(room, 'Phase A collapsing frame ' + f);
        if (failures > 0) { teardown(boot); return; }
        // The lone human eventually concludes (dies in lava) -> startOverview.
        if (room.game.currentState === config.stateMap.overview) break;
    }
    if (room.game.currentState === config.stateMap.overview) {
        ok('collapse concluded -> reached overview (no stall, no div-by-zero)');
    } else {
        // Not necessarily a failure (player may have survived the window), but
        // report it so we know whether the lone-player conclude path was hit.
        console.log('  note - did not reach overview within window; state=' + room.game.currentState +
            ' alive=' + countPlayers(room).humans);
    }

    // gameOver: force the documented win condition for the lone human and confirm
    // checkForWinners drives to gameOver without throwing / dividing by zero.
    let hid = null;
    for (const id in room.playerList) { if (!room.playerList[id].isAI) { hid = id; break; } }
    if (hid == null) { fail('Phase A: lost the human before gameOver test'); teardown(boot); return; }
    const p = room.playerList[hid];
    room.game.currentState = config.stateMap.racing;
    room.game.firstPlaceSig = null;
    room.game.secondPlaceSig = null;
    p.alive = true; p.awake = true; p.isSpectator = false; p.isZombie = false;
    p.reachedGoal = true;
    p.notches = room.game.notchesToWin;
    try {
        room.game.checkForWinners();
    } catch (e) {
        fail('Phase A: checkForWinners threw on lone-human win: ' + e.message + '\n' + e.stack);
        teardown(boot);
        return;
    }
    if (room.game.currentState === config.stateMap.gameOver) {
        ok('lone-human win -> reached gameOver cleanly');
    } else {
        fail('Phase A: expected gameOver, state=' + room.game.currentState);
    }

    teardown(boot);
}

// ---------------------------------------------------------------------------
// Phase B: AI ON -> bots fill the grid as before.
// ---------------------------------------------------------------------------
function phaseBOn(map) {
    console.log('Phase B: preview with AI ON');
    const boot = bootPreview('B', true, map);
    if (boot == null) return;
    const { room } = boot;

    if (room.game.gameBoard.previewAI !== true) {
        fail('Phase B: gameBoard.previewAI should be true, got ' + room.game.gameBoard.previewAI);
    }
    // The AI-ON path can only be verified if AI racers exist globally. If that's
    // ever disabled, "on -> bots" can't be distinguished from "toggle broken", so
    // fail loudly rather than passing vacuously — whoever disables AI must update
    // (or intentionally skip) this test.
    if (!config.aiRacers || !config.aiRacers.enabled) {
        fail('Phase B: config.aiRacers.enabled is false — cannot verify the AI-ON toggle. ' +
            'Update this test if AI racers were intentionally disabled.');
        teardown(boot);
        return;
    }
    room.game.startLobby();
    room.game.startGated();
    const pc = countPlayers(room);
    if (pc.bots <= 0) fail('Phase B: expected bots to fill the grid, got ' + pc.bots);
    else ok('bots filled the grid: ' + pc.bots + ' (humans ' + pc.humans + ')');

    teardown(boot);
}

// ---------------------------------------------------------------------------
// Phase C: legacy raw-map payload (no { map, enableAI } wrapper) must still work
// and default to AI off, so an older client can't break the handler.
// ---------------------------------------------------------------------------
function phaseCLegacy(map) {
    console.log('Phase C: legacy raw-map payload (no wrapper) -> AI off');
    const editor = makeFakeSocket('C-editor');
    messenger.addMailBox(editor.id, editor);
    // Pre-toggle payload: the bare map object, exactly as the old editor sent it.
    editor.fire('createPreviewRoom', JSON.stringify(map));
    const created = editor.lastEmit('previewRoomCreated');
    if (created == null || created.gameID == null) {
        fail('Phase C: legacy payload did not emit previewRoomCreated');
        messenger.removeMailBox(editor.id);
        return;
    }
    const room = hostess.getRoomBySig(created.gameID);
    if (room == null) { fail('Phase C: preview room not found'); messenger.removeMailBox(editor.id); return; }
    if (room.game.gameBoard.previewAI !== false) {
        fail('Phase C: legacy payload should default previewAI to false, got ' + room.game.gameBoard.previewAI);
    } else {
        ok('legacy raw-map payload accepted and defaulted AI off');
    }
    messenger.removeMailBox(editor.id);
}

// ---------------------------------------------------------------------------
// Phase D: malformed payloads (array / primitive) must be rejected gracefully,
// never mistaken for a { map, enableAI } wrapper and never creating a room.
// Guards the structural wrapper-detection in messenger.js's createPreviewRoom.
// ---------------------------------------------------------------------------
function phaseDMalformed() {
    console.log('Phase D: malformed payloads -> rejected, no room created');
    const cases = ['[1,2,3]', '5', '"hello"', 'null'];
    for (const body of cases) {
        const editor = makeFakeSocket('D-' + body);
        messenger.addMailBox(editor.id, editor);
        editor.fire('createPreviewRoom', body);
        const created = editor.lastEmit('previewRoomCreated');
        const rejected = editor.lastEmit('previewRejected');
        if (created != null) {
            fail('Phase D: payload ' + body + ' wrongly created a room');
        } else if (rejected == null) {
            fail('Phase D: payload ' + body + ' was neither created nor rejected');
        } else {
            ok('payload ' + body + ' rejected: ' + (rejected.reason || ''));
        }
        messenger.removeMailBox(editor.id);
    }
}

messenger.build(fakeIo);
const map = loadAMap();
try {
    phaseAOff(map);
    phaseBOn(map);
    phaseCLegacy(map);
    phaseDMalformed();
} catch (e) {
    fail('Unhandled exception: ' + e.message + '\n' + e.stack);
}

if (failures > 0) {
    console.log('\nPreview AI-toggle test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nPreview AI-toggle test passed.');
process.exit(0);
