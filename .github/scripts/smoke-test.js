'use strict';

// Runtime smoke test for PRs into main.
//
// `node --check` and the bundle build prove the code *parses*; they cannot tell
// you the game still *runs*. A change to game.js / engine.js / compressor.js can
// pass both and then throw on the first tick (undefined deref, NaN physics, a
// compressor/decoder shape change). This script actually boots the server-side
// game and ticks it, with no network layer and no real browser:
//
//   Session A — full stack on one room: drives the REAL messenger socket
//     handlers (enterGame, movement, mousemove) for 3 fake clients, forces a
//     race, and ticks hostess.updateRooms(dt) with random input. Exercises
//     messenger + hostess + game state machine + engine + compressor together.
//
//   Session B — engine coverage on EVERY committed map: injects each map via the
//     play-test (preview) path, forces a race, and ticks the engine so a
//     structurally-valid-but-engine-breaking map (degenerate geometry, etc.) is
//     caught here rather than in production.
//
// Any throw, or a malformed compressor payload, fails the run (exit 1).

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const hostess = require(path.join(repoRoot, 'server', 'hostess.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

const DT = config.serverTickSpeed / 1000; // same fixed step the live loop uses
const MOVES = ['moveForward', 'moveBackward', 'turnLeft', 'turnRight', 'attack'];

let failures = 0;
function fail(msg) {
    failures++;
    console.log('::error::' + msg);
}

// A socket.io socket stand-in: records .on() handlers so the test can fire the
// real messenger handlers, and no-ops every outbound call (emit/join/broadcast).
function makeFakeSocket(id) {
    const handlers = {};
    return {
        id: id,
        handlers: handlers,
        on(event, fn) { handlers[event] = fn; },
        emit() { },
        join() { },
        leave() { },
        broadcast: { to() { return { emit() { } }; } },
        fire(event, payload) {
            if (handlers[event]) handlers[event](payload);
        }
    };
}

// io stand-in so messenger.messageRoomBySig()/messageClientBySig() don't throw.
const fakeIo = {
    to() { return { emit() { } }; },
    sockets: { emit() { } }
};

function randomInput() {
    const packet = { moveForward: false, moveBackward: false, turnLeft: false, turnRight: false, attack: false };
    for (const m of MOVES) {
        if (Math.random() < 0.5) packet[m] = true;
    }
    return packet;
}

// The four compacted arrays a client decoder expects every tick. If any isn't an
// array, client.js' update*List() decoders would break — catch it here.
function assertUpdatesWellFormed(room, label) {
    const checks = {
        playerList: compressor.sendPlayerUpdates(room.playerList),
        projList: compressor.sendProjUpdates(room.projectileList),
        aimerList: compressor.sendAimerUpdates(room.aimerList),
        hazardList: compressor.sendHazardUpdates(room.hazardList)
    };
    for (const key in checks) {
        if (!Array.isArray(checks[key])) {
            fail(label + ': compressor.' + key + ' returned a non-array (' + typeof checks[key] + ')');
        }
    }
}

// ---------------------------------------------------------------------------
// Session A: full stack through the real messenger handlers on one room.
// ---------------------------------------------------------------------------
function sessionFullStack() {
    const sockets = [];
    for (let i = 0; i < 3; i++) {
        const s = makeFakeSocket('smoke-player-' + i);
        sockets.push(s);
        messenger.addMailBox(s.id, s); // registers handlers + emits welcome/contentDelivery
        s.fire('enterGame', -1);       // real join + matchmake + player spawn
    }

    // The players are now in exactly one room; grab it for state forcing/ticks.
    const sigs = Object.keys(hostess.getRooms());
    if (sigs.length === 0) {
        fail('Session A: enterGame created no joinable room');
        return;
    }
    const room = hostess.getRoomBySig(sigs[0]);
    if (room == null) {
        fail('Session A: could not resolve the room created by enterGame');
        return;
    }

    // Tick a bit in the natural (waiting/lobby) state with random input.
    for (let f = 0; f < 60; f++) {
        for (const s of sockets) {
            s.fire('movement', randomInput());
            s.fire('mousemove', Math.random() * 360);
        }
        hostess.updateRooms(DT);
        assertUpdatesWellFormed(room, 'Session A (pre-race) frame ' + f);
        if (failures > 0) return;
    }

    // Force the race so the engine's collision/physics path actually runs
    // (the live timers are wall-clock + lobby-button driven; we don't wait).
    room.game.startGated();
    room.game.startRace();

    for (let f = 0; f < 400; f++) {
        for (const s of sockets) {
            s.fire('movement', randomInput());
            s.fire('mousemove', Math.random() * 360);
        }
        hostess.updateRooms(DT);
        assertUpdatesWellFormed(room, 'Session A (racing) frame ' + f);
        if (failures > 0) return;
    }

    // Drive the collapse path too — that's where the map tears down to lava.
    room.game.startCollapse(config.worldWidth / 2, config.worldHeight / 2);
    for (let f = 0; f < 120; f++) {
        hostess.updateRooms(DT);
        assertUpdatesWellFormed(room, 'Session A (collapsing) frame ' + f);
        if (failures > 0) return;
    }

    // Clean up so Session B starts from an empty room registry.
    for (const s of sockets) {
        hostess.kickFromRoom(s.id);
        messenger.removeMailBox(s.id);
    }
    console.log('Session A passed: full-stack room ticked waiting -> racing -> collapsing.');
}

// ---------------------------------------------------------------------------
// Session B: run the engine on every committed map via the play-test path.
// ---------------------------------------------------------------------------
function sessionEveryMap() {
    const mapsDir = path.join(repoRoot, 'client', 'maps');
    const files = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'));
    let ran = 0;

    for (const file of files) {
        const map = JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8'));
        const sig = 'smoke-map-' + ran;
        const room = game.getRoom(sig, 4);

        // Pin map selection to this map (determineNextMap honors previewMap),
        // exactly like the editor's solo play-test does.
        room.game.gameBoard.isPreview = true;
        room.game.gameBoard.previewMap = map;

        // Spawn a couple of players directly (no socket needed for this path).
        for (let i = 0; i < 2; i++) {
            const id = sig + '-p' + i;
            const player = room.world.createNewPlayer(id);
            room.playerList[id] = player;
            room.game.determineGameState(player);
        }

        try {
            room.game.startLobby(); // world.resize() here builds the engine quadTree
            room.game.startGated();
            room.game.startRace();
            for (let f = 0; f < 60; f++) {
                for (const id in room.playerList) {
                    const p = room.playerList[id];
                    const packet = randomInput();
                    p.moveForward = packet.moveForward;
                    p.moveBackward = packet.moveBackward;
                    p.turnLeft = packet.turnLeft;
                    p.turnRight = packet.turnRight;
                    p.attack = packet.attack;
                    p.angle = Math.random() * 360;
                }
                room.update(DT);
            }
            assertUpdatesWellFormed(room, 'map ' + file);
        } catch (e) {
            fail('map ' + file + ' broke the engine: ' + e.message + '\n' + e.stack);
        }
        ran++;
        if (failures > 0) return;
    }
    console.log('Session B passed: engine ran on ' + ran + ' map(s).');
}

messenger.build(fakeIo);
try {
    sessionFullStack();
    if (failures === 0) sessionEveryMap();
} catch (e) {
    fail('Unhandled exception during smoke test: ' + e.message + '\n' + e.stack);
}

if (failures > 0) {
    console.log('\nSmoke test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nSmoke test passed: game booted and ticked without crashing.');
process.exit(0);
