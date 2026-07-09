'use strict';

// Identity-across-rejoin regression harness (the "mid-match rejoin lost my name/
// avatar" prod bug). Drives the REAL messenger/hostess/game enterGame path with fake
// sockets and asserts the three server-side guarantees that fix it:
//   1. RC1 fast-reconnect race — a rejoin that lands BEFORE the old socket's
//      disconnect fires must harvest identity/standings off the old live Player
//      (nothing was parked: live seats record seat=null) instead of destroying it.
//   2. RC2 — the parked-seat slow path must restore avatarUrl (captureStandings/
//      applyStandings carry the photo), with the equip-path URL allowlist enforced.
//   3. C7 — a server-side kick (AFK / Discord idle-reclaim) must park standings
//      before removing the Player, because the socket stays connected (the
//      disconnect-path park never runs) and the rejoin would otherwise restore nothing.

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

// Freeze the clock: the seat TTLs and enterGame's Date.now() reads must share one
// timeline (a tight synchronous test would otherwise race real wall-clock).
const realNow = Date.now;
let fakeNow = 9000000;
Date.now = () => fakeNow;

const AVATAR = 'https://cdn.discordapp.com/avatars/1234567890/abcdef.png';

function makeFakeSocket(id, deviceId, userId) {
    const h = {};
    return { id: id, handlers: h, deviceId: deviceId, userId: userId,
        on(e, f) { h[e] = f; }, emit() {}, join() {}, leave() {}, broadcast: { to() { return { emit() {} }; } },
        fire(e, p) { if (h[e]) h[e](p); } };
}

// --- 0. Unit guarantees: the standings snapshot carries + validates the photo ------
const unitStandings = roomSnapshot.captureStandings({ name: 'Roknua', avatarUrl: AVATAR, notches: 4 });
check(unitStandings.avatarUrl === AVATAR, 'captureStandings carries avatarUrl');
const unitPlayer = {};
roomSnapshot.applyStandings(unitPlayer, unitStandings);
check(unitPlayer.avatarUrl === AVATAR && unitPlayer.name === 'Roknua', 'applyStandings restores name + avatarUrl');
const evilPlayer = {};
roomSnapshot.applyStandings(evilPlayer, { name: 'X', avatarUrl: 'https://evil.example.com/pixel.png' });
check(evilPlayer.avatarUrl == null, 'applyStandings REJECTS a non-allowlisted avatar host');
const plainPlayer = {};
roomSnapshot.applyStandings(plainPlayer, { name: 'X', avatarUrl: 'http://cdn.discordapp.com/a.png' });
check(plainPlayer.avatarUrl == null, 'applyStandings REJECTS a non-https avatar URL');
check(messenger !== null && roomSnapshot.isAllowedAvatarUrl(AVATAR) === true, 'shared allowlist accepts the Discord CDN');

// --- 1. RC1: fast-reconnect race (rejoin BEFORE the old socket disconnects) --------
// Signed-in player joins, equips identity mid-session, then a NEW socket for the SAME
// verified identity enters the same room while the old player object still lives.
const sockA1 = makeFakeSocket('identityA-old', 'dev-idA', 'user-idA');
messenger.addMailBox(sockA1.id, sockA1, { userId: 'user-idA', deviceId: 'dev-idA' });
sockA1.fire('enterGame', -1); // matchmake into a fresh room; records the live seat
const roomA = hostess.getRoomForClient(sockA1.id);
check(roomA != null, 'player A seated in a room');
const oldA = roomA.playerList[sockA1.id];
check(oldA != null && oldA.verifiedUserId === 'user-idA', 'player A carries the verified userId');
// Simulate the mid-session identity + standings the avatar-skin equip + racing built up.
oldA.name = 'Roknua'; oldA.avatarUrl = AVATAR; oldA.notches = 4; oldA.teamId = 1;

fakeNow += 2000; // a 2s "Discord iframe suspend" — well inside the 35s zombie window
const sockA2 = makeFakeSocket('identityA-new', 'dev-idA', 'user-idA');
messenger.addMailBox(sockA2.id, sockA2, { userId: 'user-idA', deviceId: 'dev-idA' });
sockA2.fire('enterGame', roomA.sig); // the race: old socket NEVER disconnected

const newA = roomA.playerList[sockA2.id];
check(newA != null, 'rejoin re-seated the new socket in the same room');
check(roomA.playerList[sockA1.id] == null, 'one identity == one seat: the old live Player was evicted');
check(newA && newA.name === 'Roknua', 'RC1: display name harvested off the old Player before the dup-kick');
check(newA && newA.avatarUrl === AVATAR, 'RC1: avatarUrl harvested off the old Player before the dup-kick');
check(newA && newA.notches === 4 && newA.teamId === 1, 'RC1: notches + team harvested');
messenger.removeMailBox(sockA1.id);

// --- 2. RC2 slow path: disconnect parks the seat, rejoin restores the photo --------
// Mirror index.js's disconnect park exactly (recordSeat with captureStandings), then
// rejoin on a new socket and assert the photo came back through applyStandings.
const keyA = reconnect.reconnectKey('user-idA', 'dev-idA', 0);
reconnect.recordSeat(keyA, roomA.sig, { restore: false, standings: roomSnapshot.captureStandings(newA) });
// The old kart leaves with the disconnect (others — a bot here — keep the room alive).
delete roomA.playerList[sockA2.id];
messenger.removeMailBox(sockA2.id);
fakeNow += 10000; // 10s outage — inside the 45s seat grace
const sockA3 = makeFakeSocket('identityA-return', 'dev-idA', 'user-idA');
messenger.addMailBox(sockA3.id, sockA3, { userId: 'user-idA', deviceId: 'dev-idA' });
sockA3.fire('enterGame', roomA.sig);
const backA = roomA.playerList[sockA3.id];
check(backA != null, 'slow-path rejoin re-seated');
check(backA && backA.name === 'Roknua', 'RC2: name restored from the parked seat');
check(backA && backA.avatarUrl === AVATAR, 'RC2: avatarUrl restored from the parked seat (was dropped pre-fix)');
check(backA && backA.notches === 4, 'RC2: notches restored from the parked seat');

// --- 3. C7: a server-side kick parks standings before destroying the Player --------
backA.notches = 6; // progress since the last park — the kick must park CURRENT state
roomA.parkKickedStandings(sockA3.id);
const kickedSeat = reconnect.lookupSeat(keyA, fakeNow);
check(kickedSeat != null && kickedSeat.seat && kickedSeat.seat.standings != null, 'C7: kick parked a standings seat');
check(kickedSeat.seat.standings.name === 'Roknua' && kickedSeat.seat.standings.avatarUrl === AVATAR,
    'C7: parked standings carry name + avatarUrl');
check(kickedSeat.seat.standings.notches === 6, 'C7: parked standings are CURRENT (post-progress), not stale');
// And a bot/no-identity player must not park anything (no throw, no seat).
const botP = roomA.world.createNewPlayer('bot-x'); botP.isAI = true; roomA.playerList['bot-x'] = botP;
roomA.parkKickedStandings('bot-x');
roomA.parkKickedStandings('never-existed');
check(true, 'C7: bot/unknown ids are safely ignored by the kick park');

// cleanup + verdict
hostess.kickFromRoom(sockA3.id); messenger.removeMailBox(sockA3.id);
Date.now = realNow;
if (failures > 0) { console.log('\nReconnect identity test FAILED (' + failures + ').'); process.exit(1); }
console.log('\nReconnect identity test passed.');
process.exit(0);
