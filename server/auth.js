// Auth foundation — resolves a Socket.IO connection to a Supabase user id and
// keeps a durable per-user `progression` row. This is pure identity infra: it
// does NOT touch gameplay (game.js / engine.js / config.json) and writes only
// via the service-role key, which must never reach the browser.
//
// If the Supabase env vars are absent the module degrades to no-op stubs so the
// server still boots and everyone connects as a guest (local dev without creds).
//
// Env vars (server-only secrets are loaded here, never sent to the client):
//   SUPABASE_URL                — project URL (also exposed to the browser)
//   SUPABASE_SERVICE_ROLE_KEY   — bypasses RLS; writes progression. SERVER ONLY.
//   SUPABASE_JWT_SECRET         — verify access tokens locally (no network hop). SERVER ONLY.

var SUPABASE_URL = process.env.SUPABASE_URL || null;
var SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
var JWT_SECRET = process.env.SUPABASE_JWT_SECRET || null;

var supabase = null;
var jwt = null;
var enabled = false;

if (SUPABASE_URL && SERVICE_ROLE_KEY) {
    try {
        var createClient = require('@supabase/supabase-js').createClient;
        supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
            auth: { autoRefreshToken: false, persistSession: false }
        });
        enabled = true;
    } catch (e) {
        console.log('[auth] @supabase/supabase-js unavailable, auth disabled:', e.message);
    }
}

if (JWT_SECRET) {
    try {
        jwt = require('jsonwebtoken');
    } catch (e) {
        console.log('[auth] jsonwebtoken unavailable, will fall back to network verify:', e.message);
    }
}

if (enabled) {
    console.log('[auth] Supabase auth ENABLED (' + (jwt && JWT_SECRET ? 'local JWT verify' : 'network verify') + ').');
} else {
    console.log('[auth] Supabase env vars absent — auth DISABLED, all clients are guests.');
}

// Short-lived cache of token -> { userId, expiresAt }. Lets repeated handshakes
// for the same token (reconnects, and the network-verify path that asymmetric-key
// projects always take) skip a Supabase round-trip, and caps how often the same
// token re-hits the network. userId may be null (a verified-bad result is cached
// briefly too, to blunt repeated bad tokens).
// Short-lived cache of token -> { userId, expiresAt }. Lets repeated handshakes
// for the same token (reconnects, and the network-verify path that asymmetric-key
// projects always take) skip a Supabase round-trip. userId may be null when a token
// is VERIFIED bad (so repeated identical bad tokens are cheap) — but transient
// failures (timeout/exception) are NEVER cached, so a Supabase blip can't lock a
// valid user out as a guest for the bad-TTL window.
var tokenCache = new Map();
var VERIFY_OK_TTL_MS = 60 * 1000;   // re-verify a good token at most once a minute
var VERIFY_BAD_TTL_MS = 30 * 1000;  // remember a verified-bad token briefly
var VERIFY_TIMEOUT_MS = 4000;       // never let a hung getUser() stall the handshake
var TOKEN_CACHE_MAX = 5000;

// Read a JWT's `exp` (seconds) without verifying — for clamping the cache TTL so a
// near-expiry token isn't honored long after it actually expires.
function tokenExpSeconds(token) {
    try {
        var part = String(token).split('.')[1];
        if (!part) { return null; }
        var json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        var payload = JSON.parse(json);
        return (payload && typeof payload.exp === 'number') ? payload.exp : null;
    } catch (e) {
        return null;
    }
}

function cachePut(token, userId, ttl) {
    var expiresAt = Date.now() + ttl;
    if (userId) {
        // Never cache a good token past its own expiry.
        var exp = tokenExpSeconds(token);
        if (exp) { expiresAt = Math.min(expiresAt, exp * 1000); }
    }
    // Bounded LRU-ish: drop the OLDEST entry rather than clearing the whole cache
    // (a full wipe would force a thundering-herd re-verify of every live session).
    if (tokenCache.size >= TOKEN_CACHE_MAX) {
        var oldest = tokenCache.keys().next().value;
        if (oldest !== undefined) { tokenCache.delete(oldest); }
    }
    tokenCache.set(token, { userId: userId, expiresAt: expiresAt });
    return userId;
}

function audIsAuthenticated(decoded) {
    var aud = decoded && decoded.aud;
    if (Array.isArray(aud)) { return aud.indexOf('authenticated') !== -1; }
    return aud === 'authenticated' || (decoded && decoded.role === 'authenticated');
}

// Resolve an access token (Supabase JWT) to a user id, or null if invalid/absent.
// Prefers local HS256 verification with the JWT secret (no round-trip per
// connection); falls back to supabase.auth.getUser() when the secret is missing
// or the local verify fails (e.g. asymmetric signing keys). Verifies the token is
// an actual user token (aud/role 'authenticated'), not an API key or other JWT.
async function verifyToken(token) {
    if (!enabled || !token) {
        return null;
    }
    var hit = tokenCache.get(token);
    if (hit && hit.expiresAt > Date.now()) {
        return hit.userId;
    }
    if (jwt && JWT_SECRET) {
        try {
            var decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
            if (decoded && decoded.sub && audIsAuthenticated(decoded)) {
                return cachePut(token, decoded.sub, VERIFY_OK_TTL_MS);
            }
            // Signed and valid, but not an authenticated user token (e.g. an API key JWT).
            return cachePut(token, null, VERIFY_BAD_TTL_MS);
        } catch (e) {
            // Fall through to network verification (covers asymmetric signing keys).
        }
    }
    // Network verification, bounded by a timeout. A timeout or thrown error is
    // TRANSIENT — return null WITHOUT caching, so a blip doesn't demote a valid user.
    var timer = null;
    try {
        var getUserP = supabase.auth.getUser(token);
        getUserP.catch(function () { }); // swallow a late rejection after the race resolves
        var res = await Promise.race([
            getUserP,
            new Promise(function (resolve) {
                timer = setTimeout(function () { resolve(null); }, VERIFY_TIMEOUT_MS);
            })
        ]);
        if (timer) { clearTimeout(timer); }
        if (res === null) {
            return null; // timed out — transient, not cached
        }
        if (res && res.data && res.data.user && !res.error) {
            return cachePut(token, res.data.user.id, VERIFY_OK_TTL_MS);
        }
        // getUser definitively returned no user → verified-bad, safe to cache briefly.
        return cachePut(token, null, VERIFY_BAD_TTL_MS);
    } catch (e) {
        if (timer) { clearTimeout(timer); }
        console.log('[auth] verifyToken network verify failed (transient, not cached):', e.message);
        return null;
    }
}

// Ensure a `progression` row exists for the user and record `deviceId` on it
// (dedup). Never resets existing progress — only creates the row if missing and
// appends the device id. Account-linking merges of guest progress happen later
// when progression mechanics exist; for now we just stamp the device.
//
// NOTE: this read-then-write isn't atomic — two simultaneous first-connections for
// the same user could both insert, or two new devices could race the append and
// drop one. It's benign (only device_ids dedup, and it self-heals on the next
// connect) and only touched off the gameplay path. The fully-atomic fix is a
// Postgres RPC doing `array_append` + dedup in one statement; left for when
// device tracking actually matters.
async function ensureProgressionRow(userId, deviceId) {
    if (!enabled || !userId) {
        return;
    }
    try {
        var existing = await supabase
            .from('progression')
            .select('device_ids')
            .eq('user_id', userId)
            .maybeSingle();

        if (existing.error) {
            console.log('[auth] ensureProgressionRow select failed:', existing.error.message);
            return;
        }

        if (!existing.data) {
            // No row yet — create it. Other columns take their DB defaults.
            var insertPayload = { user_id: userId };
            if (deviceId) {
                insertPayload.device_ids = [deviceId];
            }
            var ins = await supabase
                .from('progression')
                .upsert(insertPayload, { onConflict: 'user_id' });
            if (ins.error) {
                console.log('[auth] ensureProgressionRow create failed:', ins.error.message);
            }
            return;
        }

        // Row exists — append the device id only if it's new (avoids needless writes).
        var deviceIds = existing.data.device_ids || [];
        if (deviceId && deviceIds.indexOf(deviceId) === -1) {
            var merged = deviceIds.concat([deviceId]);
            var upd = await supabase
                .from('progression')
                .update({ device_ids: merged, updated_at: new Date().toISOString() })
                .eq('user_id', userId);
            if (upd.error) {
                console.log('[auth] ensureProgressionRow device append failed:', upd.error.message);
            }
        }
    } catch (e) {
        console.log('[auth] ensureProgressionRow error:', e.message);
    }
}

exports.enabled = enabled;
exports.supabase = supabase;
exports.verifyToken = verifyToken;
exports.ensureProgressionRow = ensureProgressionRow;
// Public, browser-safe config to inject into served pages. Returns null unless
// the server is fully able to VERIFY tokens (`enabled`) AND the anon key is
// present — otherwise the client would show a login UI and mint tokens the
// server silently can't validate, demoting every signed-in user to a guest. Tied
// to `enabled` so both sides agree. NEVER includes the service-role key or JWT secret.
exports.getPublicConfig = function () {
    var anonKey = process.env.SUPABASE_ANON_KEY || null;
    if (!enabled || !anonKey) {
        if (anonKey && !enabled) {
            console.log('[auth] SUPABASE_ANON_KEY is set but auth is DISABLED (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY) — hiding client login so users are not silently treated as guests.');
        }
        return null;
    }
    return { url: SUPABASE_URL, anonKey: anonKey };
};
