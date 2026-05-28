'use strict';

// SPIKE validation for the lobby "hub station" architecture (server slice).
//
// Boots the REAL server modules (no network, no browser) exactly like
// .github/scripts/smoke-test.js, drives a room into the lobby through the real
// messenger handlers, and asserts the new station plumbing:
//
//   1. Stations spawn in the lobby (skin + ai) and join the lobby collision set.
//   2. Per-player ENTER/EXIT edges fire to that player's OWN socket as the player
//      moves onto / off of a station (the per-slot signal local co-op relies on).
//   3. setSkin changes the player's color, broadcasts playerSkinChanged, and is
//      rejected for an off-palette color and for a color another player holds.
//   4. botOverride (set via the setLobbyAI handler) is honored by fillGridWithBots:
//      enabled:false => 0 bots; enabled:true,count:N => exactly N bots.
//
// Any failed assertion exits non-zero. Run: node docs/spikes/lobby-hub-spike-test.js

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const hostess = require(path.join(repoRoot, 'server', 'hostess.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

const DT = config.serverTickSpeed / 1000;
let failures = 0;
function check(cond, msg) {
    if (cond) {
        console.log('  ok  - ' + msg);
    } else {
        failures++;
        console.log('  FAIL- ' + msg);
    }
}

// A socket.io stand-in that RECORDS outbound emits so we can assert on them.
function makeRecordingSocket(id) {
    const handlers = {};
    const sent = [];
    return {
        id, handlers, sent,
        on(event, fn) { handlers[event] = fn; },
        emit(event, payload) { sent.push({ event, payload }); },
        join() { }, leave() { },
        broadcast: { to() { return { emit() { } }; } },
        fire(event, payload) { if (handlers[event]) handlers[event](payload); },
        lastOf(event) {
            for (let i = sent.length - 1; i >= 0; i--) { if (sent[i].event === event) return sent[i].payload; }
            return undefined;
        },
        countOf(event) { return sent.filter(s => s.event === event).length; }
    };
}

// io stand-in: records room broadcasts (messageRoomBySig => io.to(sig).emit()).
const roomBroadcasts = [];
const fakeIo = {
    to() { return { emit(event, payload) { roomBroadcasts.push({ event, payload }); } }; },
    sockets: { emit() { } }
};
function lastBroadcast(event) {
    for (let i = roomBroadcasts.length - 1; i >= 0; i--) { if (roomBroadcasts[i].event === event) return roomBroadcasts[i].payload; }
    return undefined;
}

messenger.build(fakeIo);

// --- Boot a room with one human and drive it into the lobby ------------------
const sock = makeRecordingSocket('spike-p0');
messenger.addMailBox(sock.id, sock);
sock.fire('enterGame', -1);

const sig = Object.keys(hostess.getRooms())[0];
const room = hostess.getRoomBySig(sig);
const game = room.game;
const board = game.gameBoard;

// Tick until we reach the lobby (waiting -> lobby on the first tick with >= 1 player).
for (let f = 0; f < 10 && game.currentState !== config.stateMap.lobby; f++) {
    hostess.updateRooms(DT);
}
check(game.currentState === config.stateMap.lobby, 'room reaches lobby state');

// --- 1. Stations exist + are in the lobby collision set ----------------------
const stationIds = (board.lobbyStations || []).map(s => s.stationId);
check(stationIds.indexOf('skin') !== -1, 'skin station spawned in lobby');
check(stationIds.indexOf('ai') !== -1, 'ai station spawned in lobby');

const collisionArr = [];
board.collectLobbyCollisionObjects(config.stateMap.lobby, collisionArr);
const stationsInCollision = collisionArr.filter(o => o && o.isStation).length;
check(stationsInCollision === stationIds.length, 'all stations join the lobby collision set (' + stationsInCollision + ')');

// Phase 0 (§9.1): the lobby map authors stations[] on verified-clear ground, so the
// stations come from the map JSON, not the code defaults.
const aiStation = board.lobbyStations.find(s => s.stationId === 'ai');
check(aiStation != null && aiStation.x === 450 && aiStation.y === 384,
    'ai station uses the authored map position (450,384), not the code default');

// Mid-join rehydration (§9.2): a player joining mid-lobby gets the stations + the
// live AI setting in the gameState snapshot, not just via the startLobby broadcast.
const sock2 = makeRecordingSocket('spike-p1');
messenger.addMailBox(sock2.id, sock2);
sock2.fire('enterGame', sig);
const gs2 = sock2.lastOf('gameState');
check(gs2 != null && gs2.lobbyStations != null, 'mid-join gameState carries lobbyStations');
const decoded = gs2 ? JSON.parse(gs2.lobbyStations) : [];
check(decoded.length === stationIds.length && decoded.some(s => s[0] === 'ai'),
    'mid-join lobbyStations decode to the same station set');
check(gs2 != null && 'lobbyAI' in gs2, 'mid-join gameState carries the lobbyAI setting field');
hostess.kickFromRoom(sock2.id);
messenger.removeMailBox(sock2.id);

// --- 2. Per-player ENTER / EXIT edges to the player's own socket -------------
const player = room.playerList[sock.id];
const skin = board.lobbyStations.find(s => s.stationId === 'skin');

const enterBefore = sock.countOf('stationEnter');
// Park the player dead-center on the skin station and tick once.
player.x = player.newX = skin.x;
player.y = player.newY = skin.y;
player.velX = player.velY = 0;
hostess.updateRooms(DT);
const enterPayload = sock.lastOf('stationEnter');
check(sock.countOf('stationEnter') === enterBefore + 1, 'stationEnter fired once on entering the skin zone');
check(enterPayload && enterPayload.id === 'skin' && enterPayload.kind === 'skin', 'stationEnter carries {id:skin, kind:skin}');
check(player.nearStation === 'skin', 'player.nearStation latched to skin while inside');

// Staying inside must NOT re-fire enter.
hostess.updateRooms(DT);
check(sock.countOf('stationEnter') === enterBefore + 1, 'stationEnter does not repeat while still inside');

// Move far away (onto the spawn pad) and tick: exit fires once.
const exitBefore = sock.countOf('stationExit');
const pad = board.currentMap.spawnPad;
player.x = player.newX = pad.cx;
player.y = player.newY = pad.cy;
player.velX = player.velY = 0;
hostess.updateRooms(DT);
const exitPayload = sock.lastOf('stationExit');
check(sock.countOf('stationExit') === exitBefore + 1, 'stationExit fired once on leaving the skin zone');
check(exitPayload && exitPayload.id === 'skin', 'stationExit carries {id:skin}');
check(player.nearStation == null, 'player.nearStation cleared after leaving');

// --- 3. setSkin: apply, broadcast, and the two rejections --------------------
const palette = utils.getColorPalette();
// Pick a palette color the player does NOT already have.
const targetColor = palette.find(c => c !== player.color);
sock.fire('setSkin', { color: targetColor });
check(player.color === targetColor, 'setSkin updated player.color to the chosen palette color');
const skinBc = lastBroadcast('playerSkinChanged');
check(skinBc && skinBc.id === sock.id && skinBc.color === targetColor, 'playerSkinChanged broadcast carries {id, color}');

// Off-palette request is ignored (no color change).
sock.fire('setSkin', { color: '#123456' });
check(player.color === targetColor, 'off-palette setSkin is ignored');

// A color held by another player is rejected with skinRejected.
const other = room.world.createNewPlayer('spike-other');
other.color = palette.find(c => c !== targetColor);
room.playerList['spike-other'] = other;
const rejBefore = sock.countOf('skinRejected');
sock.fire('setSkin', { color: other.color });
check(sock.countOf('skinRejected') === rejBefore + 1, 'taken color is rejected with skinRejected');
check(player.color === targetColor, 'rejected setSkin leaves color unchanged');
delete room.playerList['spike-other'];

// --- 4. botOverride honored by fillGridWithBots ------------------------------
function botCount() {
    let n = 0;
    for (const id in room.playerList) { if (room.playerList[id].isAI) n++; }
    return n;
}
// enabled:false => no bots next race.
sock.fire('setLobbyAI', { enabled: false, count: 0 });
check(game.botOverride && game.botOverride.enabled === false, 'setLobbyAI stored {enabled:false} override');
game.startGated();
check(botCount() === 0, 'fillGridWithBots spawns 0 bots when AI disabled (got ' + botCount() + ')');
game.removeBots();

// Back to lobby to flip the override on (handler is lobby-only).
game.startLobby();
sock.fire('setLobbyAI', { enabled: true, count: 3 });
check(game.botOverride.enabled === true && game.botOverride.count === 3, 'setLobbyAI stored {enabled:true, count:3}');
game.startGated();
check(botCount() === 3, 'fillGridWithBots spawns exactly 3 bots when count=3 (got ' + botCount() + ')');

// AI hub listing: getRooms surfaces the bots so the join page can show "+N AI".
const listing = hostess.getRooms()[sig];
check(listing != null && listing.aiCount === 3, 'getRooms reports the live bot count (aiCount=3)');
check(listing != null && listing.aiPlanned === 3, 'getRooms reports the planned AI setting (aiPlanned=3)');
check(listing != null && listing.aiAuto === false, 'getRooms flags an explicit override as not-auto');

// Toggle back to Auto: setLobbyAI {auto:true} clears the override, so the next race
// uses the triangular-tier auto fill (1H -> 1 bot for the only human in this room).
game.removeBots();
game.startLobby();
sock.fire('setLobbyAI', { auto: true });
check(game.botOverride == null, 'setLobbyAI {auto:true} clears the override back to Auto (null)');
const autoListing = hostess.getRooms()[sig];
const humansNow = Object.keys(room.playerList).filter(id => !room.playerList[id].isAI).length;
const expectedAuto = humansNow === 1 ? 1 : 0;  // this test only ever has one human in the room
check(autoListing != null && autoListing.aiAuto === true, 'getRooms flags Auto mode (aiAuto=true)');
check(autoListing != null && autoListing.aiPlanned === expectedAuto,
    'getRooms reports the Auto fill count (triangular-tier: ' + humansNow + ' human -> ' + expectedAuto + ' bot, got ' + autoListing.aiPlanned + ')');
game.startGated();
check(botCount() === expectedAuto,
    'Auto fills with the triangular-tier count after toggling back (got ' + botCount() + ')');

// --- bots yield to humans: humans + bots never exceed the room cap ------------
// Stuff the room past capacity with bots, then add humans directly (bypassing the
// match lock that blocks this in normal flow) and confirm trimBotsToCapacity keeps
// total <= cap while preserving every human.
game.removeBots();
const cap = config.maxPlayersInRoom;
const botIdentity = { id: 'racer', name: 'Racer', title: 'Racer' };
for (let b = 0; b < cap; b++) { room.playerList['fakebot-' + b] = room.world.createNewBot('fakebot-' + b, botIdentity); }
const humanIds = [sock.id];
for (let hn = 0; hn < 8; hn++) { var hid = 'fakehuman-' + hn; room.playerList[hid] = room.world.createNewPlayer(hid); humanIds.push(hid); }
game.trimBotsToCapacity();
function totalCounts() { let h = 0, b = 0; for (const id in room.playerList) { if (room.playerList[id].isAI) b++; else h++; } return { h, b, total: h + b }; }
const tc = totalCounts();
check(tc.total <= cap, 'trimBotsToCapacity keeps humans+bots within cap (' + tc.total + ' <= ' + cap + ')');
check(humanIds.every(id => room.playerList[id] != null), 'trimBotsToCapacity never despawns a human (' + tc.h + ' humans kept)');
// Clean up the synthetic players.
for (const id in room.playerList) { if (id !== sock.id) { delete room.playerList[id]; } }

// --- result ------------------------------------------------------------------
hostess.kickFromRoom(sock.id);
messenger.removeMailBox(sock.id);
if (failures > 0) {
    console.log('\nLOBBY-HUB SPIKE TEST FAILED (' + failures + ' assertion(s)).');
    process.exit(1);
}
console.log('\nLobby-hub spike test passed: stations spawn, enter/exit edges fire per-socket, setSkin + botOverride work.');
process.exit(0);
