'use strict';

// Reconnect identity index + seat tokens — Phase 0 of seamless-reconnect.
//
// Keeps player.id == socket.id (NO wire/compressor change). This is a PARALLEL
// association from a STABLE identity (verifiedUserId for signed-in players, or the
// handshake deviceId for guests, plus a co-op slot) to the room SEAT that identity
// currently holds — so a reconnecting socket (which gets a brand-new socket.id) can
// be re-seated into the same room. Phase 2 adds the cross-process (Supabase)
// snapshot; this module is the in-process foundation + the security primitive
// (an HMAC seat token) so a guest can't spoof another guest's deviceId to steal a
// seat. Self-contained: requires only `crypto`, no game/socket deps, no side effects
// on require — safe to unit-test in isolation.

var crypto = require('crypto');

// HMAC secret. Mirror the Discord-ticket derivation (auth.js): prefer an explicit
// RECONNECT_SECRET, else derive deterministically from the service-role key so all
// dynos agree, else fall back to an ephemeral per-process key (tokens then only
// verify within this process lifetime — fine, since without a shared secret there's
// no cross-dyno reconnect anyway).
var SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
var SECRET = process.env.RECONNECT_SECRET ||
    (SERVICE_ROLE_KEY
        ? crypto.createHash('sha256').update('chaochao-reconnect|' + SERVICE_ROLE_KEY).digest('hex')
        : crypto.randomBytes(32).toString('hex'));

// How long a seat stays claimable after its socket drops. A transient blip re-adopts
// within this window; a true leave releases immediately (see onDisconnect).
var GRACE_MS = 45 * 1000;
// During a maintenance/restart window the whole room is coming back, so hold seats
// longer (covers the reload + new-dyno boot). Matches the restart grace ballpark.
var MAINTENANCE_GRACE_MS = 2 * 60 * 1000;

// Stable reconnect key. Signed-in -> userId (account-durable, cross-device); guest
// -> deviceId (localStorage-durable, single-device). The co-op slot disambiguates
// multiple seats sharing ONE device/account (couch co-op). Identity-less sockets and
// bots (no userId AND no deviceId) return null and are never indexed.
function reconnectKey(userId, deviceId, slot) {
    var base = userId ? ('u:' + userId) : (deviceId ? ('d:' + deviceId) : null);
    if (base == null) { return null; }
    return base + '|s:' + (slot == null ? 0 : slot);
}

// key -> { roomSig, seat, expiresAt }. expiresAt null = live (socket connected);
// a number = parked, reclaimable until that wall-clock ms.
var seatIndex = {};

// Record/refresh the seat an identity holds (called on join and, later, as standings
// change). No-op for null keys (guests without a deviceId, bots).
function recordSeat(key, roomSig, seat) {
    if (key == null) { return; }
    seatIndex[key] = { roomSig: roomSig, seat: (seat != null ? seat : null), expiresAt: null };
}

// Park a seat on disconnect instead of dropping it, so a quick reconnect re-adopts it.
function parkSeat(key, nowMs, graceMs) {
    if (key == null) { return; }
    var e = seatIndex[key];
    if (!e) { return; }
    e.expiresAt = nowMs + (graceMs != null ? graceMs : GRACE_MS);
}

// Look up a (still-valid) seat for a returning identity. Lazily evicts an expired one.
function lookupSeat(key, nowMs) {
    if (key == null) { return null; }
    var e = seatIndex[key];
    if (!e) { return null; }
    if (e.expiresAt != null && nowMs > e.expiresAt) { delete seatIndex[key]; return null; }
    return e;
}

// Drop a seat outright (a deliberate leave, or once successfully re-seated).
function releaseSeat(key) {
    if (key == null) { return; }
    delete seatIndex[key];
}

// Disconnect policy: during maintenance keep the seat for the long window (the room
// is restarting and the player will reload); otherwise a normal disconnect parks it
// briefly so a network blip re-adopts, then it self-evicts. duringMaintenance is the
// caller's maintenance.isRaceBlocked() read.
function onDisconnect(key, nowMs, duringMaintenance) {
    if (key == null) { return; }
    parkSeat(key, nowMs, duringMaintenance ? MAINTENANCE_GRACE_MS : GRACE_MS);
}

// Sweep expired parked seats (call opportunistically; lookupSeat also self-evicts).
function sweep(nowMs) {
    for (var k in seatIndex) {
        var e = seatIndex[k];
        if (e.expiresAt != null && nowMs > e.expiresAt) { delete seatIndex[k]; }
    }
}

// --- HMAC seat token ------------------------------------------------------------
// Binds key + roomSig + seat + expiry so a returning client proves it owns the seat
// without us trusting the raw (spoofable) deviceId. Compact base64url(payload).mac.

function mintToken(key, roomSig, seat, expiresAtMs) {
    var payload = JSON.stringify({ k: key, r: roomSig, s: (seat != null ? seat : null), e: expiresAtMs });
    var body = Buffer.from(payload, 'utf8').toString('base64url');
    var mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 32);
    return body + '.' + mac;
}

function verifyToken(token, nowMs) {
    if (typeof token !== 'string') { return null; }
    var dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) { return null; }
    var body = token.slice(0, dot);
    var mac = token.slice(dot + 1);
    var expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 32);
    var a = Buffer.from(mac);
    var b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { return null; }
    var data;
    try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
    if (data && data.e != null && nowMs > data.e) { return null; } // expired
    return data; // { k, r, s, e }
}

module.exports = {
    reconnectKey: reconnectKey,
    recordSeat: recordSeat,
    parkSeat: parkSeat,
    lookupSeat: lookupSeat,
    releaseSeat: releaseSeat,
    onDisconnect: onDisconnect,
    sweep: sweep,
    mintToken: mintToken,
    verifyToken: verifyToken,
    GRACE_MS: GRACE_MS,
    MAINTENANCE_GRACE_MS: MAINTENANCE_GRACE_MS,
    _seatIndex: seatIndex // test-only access
};
