'use strict';

// Phase 0 regression harness for seamless-reconnect: the reconnect identity index
// + seat tokens, and the messenger wiring that records a seat on join. No wire
// change — player.id stays the socket.id; this only proves the PARALLEL identity
// association works and that a no-identity socket/bot is never indexed.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const reconnect = require(path.join(repoRoot, 'server', 'reconnect.js'));
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const hostess = require(path.join(repoRoot, 'server', 'hostess.js'));

messenger.build({ to() { return { emit() {} }; }, sockets: { emit() {} } });

let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.log('::error::' + msg); } else { console.log('  ok: ' + msg); } }

// --- reconnectKey ---
check(reconnect.reconnectKey('u1', 'd1', 0) === 'u:u1|s:0', 'key prefers userId over deviceId');
check(reconnect.reconnectKey(null, 'd1', 2) === 'd:d1|s:2', 'guest key uses deviceId + co-op slot');
check(reconnect.reconnectKey(null, null, 0) === null, 'no identity (bot/anon) -> null key');

// --- record / lookup / park / expiry ---
reconnect.recordSeat('d:dev-A|s:0', 42, null);
check(reconnect.lookupSeat('d:dev-A|s:0', 1000) && reconnect.lookupSeat('d:dev-A|s:0', 1000).roomSig === 42, 'recorded seat is found with its roomSig');
reconnect.parkSeat('d:dev-A|s:0', 1000, 50);
check(reconnect.lookupSeat('d:dev-A|s:0', 1040) != null, 'parked seat valid before expiry');
check(reconnect.lookupSeat('d:dev-A|s:0', 1100) == null, 'parked seat evicted after expiry (lazy)');

// --- onDisconnect: maintenance window holds longer than a normal blip ---
reconnect.recordSeat('d:dev-B|s:0', 7, null);
reconnect.onDisconnect('d:dev-B|s:0', 1000, false); // normal -> GRACE_MS
check(reconnect.lookupSeat('d:dev-B|s:0', 1000 + reconnect.GRACE_MS - 1) != null, 'normal-drop grace holds within window');
check(reconnect.lookupSeat('d:dev-B|s:0', 1000 + reconnect.GRACE_MS + 1) == null, 'normal-drop grace expires after window');
reconnect.recordSeat('d:dev-C|s:0', 7, null);
reconnect.onDisconnect('d:dev-C|s:0', 1000, true); // maintenance -> longer
check(reconnect.lookupSeat('d:dev-C|s:0', 1000 + reconnect.GRACE_MS + 1) != null, 'maintenance-drop grace outlives the normal grace');

// --- HMAC seat token ---
const exp = 10000;
const tok = reconnect.mintToken('d:dev-D|s:0', 9, null, exp);
const v = reconnect.verifyToken(tok, 5000);
check(v && v.k === 'd:dev-D|s:0' && v.r === 9, 'valid token verifies and carries its payload');
check(reconnect.verifyToken(tok, exp + 1) == null, 'expired token is rejected');
check(reconnect.verifyToken(tok.slice(0, -1) + (tok.slice(-1) === 'A' ? 'B' : 'A'), 5000) == null, 'tampered MAC is rejected');
check(reconnect.verifyToken(tok.split('.')[0] + '.deadbeefdeadbeefdeadbeefdeadbeef', 5000) == null, 'forged MAC is rejected');
check(reconnect.verifyToken('not-a-token', 5000) == null, 'malformed token is rejected');

// --- single-use: a consumed token no longer verifies (replay protection) ---
const tokSU = reconnect.mintToken('d:dev-SU|s:0', 11, null, 50000);
check(reconnect.verifyToken(tokSU, 5000) != null, 'fresh token verifies before consume');
reconnect.consumeToken(tokSU, 5000);
check(reconnect.verifyToken(tokSU, 5000) == null, 'consumed token is rejected (single-use)');
const tokSU2 = reconnect.mintToken('d:dev-SU|s:0', 11, null, 50001); // different expiry -> different mac
check(reconnect.verifyToken(tokSU2, 5000) != null, 'a different (unconsumed) token for the same key still verifies');

// --- integration: the REAL enterGame records a guest's seat (messenger wiring) ---
function makeFakeSocket(id, deviceId, userId) {
    const h = {};
    return { id: id, handlers: h, deviceId: deviceId, userId: userId,
        on(e, f) { h[e] = f; }, emit() {}, join() {}, leave() {}, broadcast: { to() { return { emit() {} }; } },
        fire(e, p) { if (h[e]) h[e](p); } };
}
const s = makeFakeSocket('sock-int-1', 'dev-INT', null);
messenger.addMailBox(s.id, s, { userId: null, deviceId: 'dev-INT' });
s.fire('enterGame', -1);
const key = reconnect.reconnectKey(null, 'dev-INT', 0);
check(reconnect.lookupSeat(key, Date.now()) != null, 'enterGame recorded the guest seat (messenger wiring fired)');
hostess.kickFromRoom(s.id); messenger.removeMailBox(s.id);

// --- a no-identity socket (guest without deviceId / bot-like) is NOT indexed ---
const before = Object.keys(reconnect._seatIndex).length;
const s2 = makeFakeSocket('sock-int-2', null, null);
messenger.addMailBox(s2.id, s2, { userId: null, deviceId: null });
s2.fire('enterGame', -1);
check(Object.keys(reconnect._seatIndex).length === before, 'no-identity socket is NOT indexed (null key skipped)');
hostess.kickFromRoom(s2.id); messenger.removeMailBox(s2.id);

if (failures > 0) { console.log('\nReconnect Phase 0 test FAILED (' + failures + ').'); process.exit(1); }
console.log('\nReconnect Phase 0 test passed.');
process.exit(0);
