'use strict';

// Phase 2 regression harness for seamless-reconnect: room roster + standings
// snapshot -> (simulated restart) -> restore into the live registry -> re-seat a
// returning player by identity with standings intact. Uses the in-memory store and
// drives the REAL hostess/messenger/enterGame path; the Supabase store is a thin
// wrapper over the same serialize/restore logic (validated separately against a DB).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const hostess = require(path.join(repoRoot, 'server', 'hostess.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const reconnect = require(path.join(repoRoot, 'server', 'reconnect.js'));
const roomSnapshot = require(path.join(repoRoot, 'server', 'roomSnapshot.js'));

messenger.build({ to() { return { emit() {} }; }, sockets: { emit() {} } });

let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.log('::error::' + msg); } else { console.log('  ok: ' + msg); } }

// Mock the clock so the snapshot/restore times and the enterGame re-seat path (which
// reads Date.now()) share one timeline — otherwise the parked seat's TTL, set in fake
// time, reads as expired against real wall-clock.
const realNow = Date.now;
let fakeNow = 5000000;
Date.now = () => fakeNow;
const NOW = fakeNow;
const SIG = 555;

// --- 1. Build a room (the "old process") with two human players + standings -------
// Built via game.getRoom directly (NOT in hostess.roomList), so after we snapshot it
// the sig is free for the restore to re-create — exactly the post-restart situation.
const oldRoom = game.getRoom(SIG, 8);
const a = oldRoom.world.createNewPlayer(SIG + '-a');
a.deviceId = 'dev-recon-A'; a.notches = 3; a.teamId = 0; a.name = 'Alice'; a.cart = 'firetruck';
oldRoom.playerList[a.id] = a;
const b = oldRoom.world.createNewPlayer(SIG + '-b');
b.deviceId = 'dev-recon-B'; b.notches = 1; b.teamId = 1; b.name = 'Bob';
oldRoom.playerList[b.id] = b;
// A bot — must NOT be snapshotted (refills fresh).
const bot = oldRoom.world.createNewPlayer(SIG + '-bot'); bot.isAI = true; oldRoom.playerList[bot.id] = bot;
oldRoom.game.notchesToWin = 5;
oldRoom.game.gameBoard.gameModeId = 'standard_ffa';

const snap = roomSnapshot.serializeRoom(oldRoom, reconnect, NOW);
check(snap != null, 'serializeRoom produced a snapshot');
check(snap && snap.sig === SIG, 'snapshot carries the room sig');
check(snap && snap.players.length === 2, 'snapshot excludes the bot (2 humans, not 3)');
check(snap && snap.notchesToWin === 5 && snap.gameModeId === 'standard_ffa', 'snapshot carries match config (notchesToWin/gameMode)');
const aSnap = snap && snap.players.filter(function (p) { return p.key === reconnect.reconnectKey(null, 'dev-recon-A', 0); })[0];
check(aSnap && aSnap.notches === 3 && aSnap.teamId === 0 && aSnap.cart === 'firetruck', "Alice's notches/team/cosmetics captured");

// Regression (a real-restart e2e caught this): snapshotAllRooms must iterate the RAW
// room list (hostess.getAllRooms), NOT the join-page-curated getRooms() view, or live
// rooms get silently skipped at SIGTERM. Inject the room into the live list and assert
// snapshotAllRooms finds it, then remove it so the restore step's sig stays free.
check(typeof hostess.getAllRooms === 'function', 'hostess.getAllRooms() exists (raw room list for snapshotting)');
hostess.getAllRooms()[SIG] = oldRoom;
const allSnaps = roomSnapshot.snapshotAllRooms(hostess, reconnect, NOW);
check(allSnaps.some(function (s) { return s.sig === SIG; }), 'snapshotAllRooms finds the live room via the raw list');
delete hostess.getAllRooms()[SIG];

// --- 2. Persist to the (cross-process) store, then SIMULATE A RESTART -------------
const store = roomSnapshot.makeMemoryStore();
store.writeAll([snap]); // the snapshot survives the process death (the store does)
// "New process": the seat-index is empty (process-local), roomList has no sig 555.
check(hostess.getRoomBySig(SIG) == null, 'after restart the room is gone (sig free)');

// --- 3. Boot restore ---------------------------------------------------------------
let restored = 0;
store.readAllFresh(NOW + 1000).then(function (snaps) {
    restored = roomSnapshot.restoreAll(snaps, { hostess: hostess, reconnect: reconnect }, NOW + 1000);
}); // memory store resolves synchronously enough; flush a microtask before asserting
setTimeout(function () {
    check(restored === 1, 'restoreAll restored 1 room');
    const rr = hostess.getRoomBySig(SIG);
    check(rr != null, 'room re-created at the saved sig');
    check(rr && rr.awaitingReconnect === true, 'restored room is awaitingReconnect (held for its players)');
    check(rr && rr.game.notchesToWin === 5, 'restored room kept notchesToWin');

    // Matchmaking must SKIP the held room.
    const mmSig = hostess.findARoom('stranger-1');
    check(String(mmSig) !== String(SIG), 'findARoom does NOT matchmake a stranger into the held room');

    // The reconnect index now has Alice's restore seat with her standings.
    const aKey = reconnect.reconnectKey(null, 'dev-recon-A', 0);
    const seat = reconnect.lookupSeat(aKey, NOW + 1000);
    check(seat != null && seat.roomSig === SIG && seat.seat && seat.seat.restore === true, "Alice's restore seat is indexed for the right room");

    // --- 4. Re-seat: Alice returns (new socket, same deviceId) WITH her HMAC seat token ---
    // A guest must now present the token (a spoofed deviceId alone no longer re-seats).
    const aTok = reconnect.mintToken(aKey, SIG, null, NOW + 10 * 60 * 1000);
    const sock = makeFakeSocket('alice-reconnect', 'dev-recon-A', null);
    sock.reconnectToken = aTok;
    messenger.addMailBox(sock.id, sock, { userId: null, deviceId: 'dev-recon-A' });
    sock.fire('enterGame', SIG); // route back to the held room by its sig
    const reRoom = hostess.getRoomBySig(SIG);
    const reAlice = reRoom && reRoom.playerList[sock.id];
    check(reAlice != null, 'Alice re-joined the restored room');
    check(reAlice && reAlice.notches === 3, "Alice's notches restored (3) onto her fresh kart");
    check(reAlice && reAlice.name === 'Alice', "Alice's name restored");
    // Held until ALL saved seats return: reopening on the FIRST return would let a stranger
    // fill Bob's still-saved seat, so the room must stay held while Bob is pending.
    check(reRoom && reRoom.awaitingReconnect === true, 'room STAYS held until every saved seat returns (not on first return)');

    // --- 4b. A tokenless imposter spoofing Bob's deviceId cannot claim Bob's held seat ---
    const imposter = makeFakeSocket('imposter', 'dev-recon-B', null); // no reconnectToken
    messenger.addMailBox(imposter.id, imposter, { userId: null, deviceId: 'dev-recon-B' });
    imposter.fire('enterGame', SIG);
    const impRoom = hostess.getRoomForClient(imposter.id);
    check(!impRoom || String(impRoom.sig) !== String(SIG), 'tokenless imposter is re-routed OUT of the held room (not seated in it)');
    const bSeatStill = reconnect.lookupSeat(reconnect.reconnectKey(null, 'dev-recon-B', 0), NOW + 1000);
    check(bSeatStill != null && bSeatStill.seat && bSeatStill.seat.restore === true, "Bob's saved seat survives the imposter (not clobbered)");
    hostess.kickFromRoom(imposter.id); messenger.removeMailBox(imposter.id);

    // --- 5. Bob returns with his token -> last saved seat fills -> room reopens ---
    const bKey = reconnect.reconnectKey(null, 'dev-recon-B', 0);
    const bTok = reconnect.mintToken(bKey, SIG, null, NOW + 10 * 60 * 1000);
    const bsock = makeFakeSocket('bob-reconnect', 'dev-recon-B', null);
    bsock.reconnectToken = bTok;
    messenger.addMailBox(bsock.id, bsock, { userId: null, deviceId: 'dev-recon-B' });
    bsock.fire('enterGame', SIG);
    const reBob = reRoom && reRoom.playerList[bsock.id];
    check(reBob != null && reBob.notches === 1, "Bob re-seated with his notches (1)");
    check(reRoom && reRoom.awaitingReconnect === false, 'room reopens once EVERY saved seat has returned');

    // cleanup
    hostess.kickFromRoom(sock.id); messenger.removeMailBox(sock.id);
    hostess.kickFromRoom(bsock.id); messenger.removeMailBox(bsock.id);

    if (failures > 0) { console.log('\nReconnect Phase 2 test FAILED (' + failures + ').'); process.exit(1); }
    console.log('\nReconnect Phase 2 test passed.');
    process.exit(0);
}, 30);

function makeFakeSocket(id, deviceId, userId) {
    const h = {};
    return { id: id, handlers: h, deviceId: deviceId, userId: userId,
        on(e, f) { h[e] = f; }, emit() {}, join() {}, leave() {}, broadcast: { to() { return { emit() {} }; } },
        fire(e, p) { if (h[e]) h[e](p); } };
}
