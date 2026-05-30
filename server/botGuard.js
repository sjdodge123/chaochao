// Central anti-bot honeypot module. Holds ALL bot-detection state and policy so the
// rest of the server only has to ask simple questions: shouldHardBlock(ip),
// shouldTarpit(id), noteMovement(id, player).
//
// Four layers, all togglable from server/botGuard.config.json (a SERVER-ONLY file —
// unlike server/config.json it is never shipped over the wire, so a bot can't read the
// thresholds and tune around them):
//   1. verified_human  — noteMovement() emits a one-shot signal once a kart has really
//                         travelled under its own server-simulated input. A pageview-only
//                         bot that never opens a socket / never drives a kart never fires
//                         it, so GA's verified_human becomes a trustworthy human KPI.
//                         (NOT a CAPTCHA against input-replay bots — those are caught by
//                         the datacenter / honeypot / tarpit layers below.)
//   2. datacenter      — register() flags connections from cloud/VPS ranges
//                         (server/data/datacenter-cidrs.json); shouldHardBlock() can
//                         reject them at the handshake when action='block'.
//   3. honeypot        — flag(id,'honeypot') when a client trips the invisible decoy.
//   4. tarpit          — shouldTarpit() reports flagged clients so hostess can divert
//                         them into a frozen room that never starts a game.
//
// Resilient by design: every query is null-safe for clients that were never register()ed
// (e.g. the headless smoke-test fires enterGame/movement directly), so it can never break
// the live tick loop.

var fs = require('fs');
var path = require('path');

function loadJson(relPath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, relPath), 'utf8'));
    } catch (e) {
        console.log('[botGuard] could not load ' + relPath + ': ' + e.message);
        return fallback;
    }
}

var cfg = loadJson('botGuard.config.json', {});
var dcData = loadJson(path.join('data', 'datacenter-cidrs.json'), { cidrs: [] });

var ENABLED = cfg.enabled !== false;
var DC = cfg.datacenter || {};
var DC_ENABLED = DC.enabled !== false;
var DC_ACTION = DC.action || 'tarpit';                 // 'tarpit' | 'block' | 'measure'
var DC_BYPASS_AUTHED = DC.bypassForAuthed !== false;   // signed-in users skip the DC check
var HP = cfg.honeypot || {};
var HP_ACTION = HP.action || 'tarpit';                 // 'tarpit' | 'measure'
var HV = cfg.humanVerify || {};
var HV_ENABLED = HV.enabled !== false;
var HV_MIN_TRAVEL = (typeof HV.minTravelPx === 'number') ? HV.minTravelPx : 600;

// ---- IPv4 CIDR matching (precomputed once at load) -------------------------------

function ipv4ToInt(ip) {
    var parts = ip.split('.');
    if (parts.length !== 4) { return null; }
    var n = 0;
    for (var i = 0; i < 4; i++) {
        var oct = Number(parts[i]);
        if (!Number.isInteger(oct) || oct < 0 || oct > 255) { return null; }
        n = (n * 256) + oct;
    }
    return n >>> 0;
}

function parseCidr(cidr) {
    if (typeof cidr !== 'string') { return null; }
    var slash = cidr.indexOf('/');
    if (slash === -1) { return null; }
    var base = ipv4ToInt(cidr.slice(0, slash));
    var bits = Number(cidr.slice(slash + 1));
    if (base == null || !Number.isInteger(bits) || bits < 0 || bits > 32) { return null; }
    var mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return { base: (base & mask) >>> 0, mask: mask };
}

var dcRanges = [];
(function () {
    var list = (dcData && dcData.cidrs) || [];
    for (var i = 0; i < list.length; i++) {
        var parsed = parseCidr(list[i]);
        if (parsed) { dcRanges.push(parsed); }
    }
    console.log('[botGuard] enabled=' + ENABLED + ' datacenter=' + DC_ENABLED + '/' + DC_ACTION +
        ' (' + dcRanges.length + ' CIDRs) honeypot=' + HP_ACTION + ' humanVerify=' + HV_ENABLED);
})();

// An address may arrive as IPv4-mapped IPv6 ("::ffff:1.2.3.4") behind some proxies.
function normalizeIp(ip) {
    if (typeof ip !== 'string') { return null; }
    ip = ip.trim();
    var m = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return m ? m[1] : ip;
}

function isDatacenterIp(ip) {
    var n = ipv4ToInt(normalizeIp(ip) || '');
    if (n == null) { return false; } // unparseable / non-mapped IPv6 — treat as non-DC
    for (var i = 0; i < dcRanges.length; i++) {
        if (((n & dcRanges[i].mask) >>> 0) === dcRanges[i].base) { return true; }
    }
    return false;
}
exports.isDatacenterIp = isDatacenterIp;

// ---- per-client state ------------------------------------------------------------

var clients = {}; // id -> { ip, datacenter, authed, flagged, reason, verified, travelled, lastX, lastY }

function ensure(id) {
    if (clients[id] == null) {
        clients[id] = {
            ip: null, datacenter: false, authed: false,
            flagged: false, reason: null,
            verified: false, travelled: 0, lastX: null, lastY: null
        };
    }
    return clients[id];
}

// Called once per accepted connection. Records the resolved IP + datacenter verdict and,
// for action='tarpit', flags the client for diversion. Returns the verdict for logging.
exports.register = function (id, ip, authed) {
    var st = ensure(id);
    st.ip = ip || null;
    st.authed = !!authed;
    st.datacenter = ENABLED && DC_ENABLED && isDatacenterIp(ip) && !(DC_BYPASS_AUTHED && authed);
    if (st.datacenter && DC_ACTION === 'tarpit') {
        st.flagged = true;
        st.reason = 'datacenter';
    }
    return { datacenter: st.datacenter, action: DC_ACTION };
};

exports.unregister = function (id) { delete clients[id]; };

// Hard-reject decision for the handshake middleware (datacenter + action='block').
exports.shouldHardBlock = function (ip, authed) {
    if (!ENABLED || !DC_ENABLED || DC_ACTION !== 'block') { return false; }
    if (DC_BYPASS_AUTHED && authed) { return false; }
    return isDatacenterIp(ip);
};

// Trip the honeypot (or any future heuristic).
exports.flag = function (id, reason) {
    var st = ensure(id);
    st.flagged = true;
    st.reason = reason || 'flagged';
};

// Should this client be diverted into the tarpit on matchmaking?
exports.shouldTarpit = function (id) {
    if (!ENABLED) { return false; }
    var st = clients[id];
    if (st == null || !st.flagged) { return false; }
    if (st.reason === 'honeypot' && HP_ACTION !== 'tarpit') { return false; }
    return true;
};

exports.isFlagged = function (id) {
    var st = clients[id];
    return st != null && st.flagged;
};

exports.flagReason = function (id) {
    var st = clients[id];
    return st != null ? st.reason : null;
};

// Accumulate authentic gameplay displacement. Returns true EXACTLY ONCE — the tick the
// client first crosses HV_MIN_TRAVEL — so the caller can emit the one-shot 'verifiedHuman'
// signal. Null-safe for unregistered clients (lazily creates their state).
exports.noteMovement = function (id, player) {
    if (!ENABLED || !HV_ENABLED || player == null) { return false; }
    var st = ensure(id);
    if (st.verified) { return false; }
    if (st.lastX != null && st.lastY != null) {
        var dx = player.x - st.lastX;
        var dy = player.y - st.lastY;
        st.travelled += Math.sqrt(dx * dx + dy * dy);
    }
    st.lastX = player.x;
    st.lastY = player.y;
    if (st.travelled >= HV_MIN_TRAVEL) {
        st.verified = true;
        return true;
    }
    return false;
};

exports.isVerified = function (id) {
    var st = clients[id];
    return st != null && st.verified;
};
