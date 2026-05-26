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
var tokenCache = new Map();
var VERIFY_OK_TTL_MS = 60 * 1000;   // re-verify a good token at most once a minute
var VERIFY_BAD_TTL_MS = 30 * 1000;  // remember a bad token briefly
var VERIFY_TIMEOUT_MS = 4000;       // never let a hung getUser() stall the handshake

function cachePut(token, userId, ttl) {
    tokenCache.set(token, { userId: userId, expiresAt: Date.now() + ttl });
    // Cheap cap so the cache can't grow without bound under random-token spam.
    if (tokenCache.size > 5000) {
        tokenCache.clear();
    }
    return userId;
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
            if (decoded && decoded.sub &&
                (decoded.aud === 'authenticated' || decoded.role === 'authenticated')) {
                return cachePut(token, decoded.sub, VERIFY_OK_TTL_MS);
            }
            // Signed but not an authenticated user token (e.g. an API key JWT).
            return cachePut(token, null, VERIFY_BAD_TTL_MS);
        } catch (e) {
            // Fall through to network verification (covers asymmetric signing keys).
        }
    }
    try {
        var res = await Promise.race([
            supabase.auth.getUser(token),
            new Promise(function (resolve) {
                setTimeout(function () { resolve({ error: { message: 'verify timeout' } }); }, VERIFY_TIMEOUT_MS);
            })
        ]);
        if (res && res.data && res.data.user && !res.error) {
            return cachePut(token, res.data.user.id, VERIFY_OK_TTL_MS);
        }
    } catch (e) {
        console.log('[auth] verifyToken network fallback failed:', e.message);
    }
    return cachePut(token, null, VERIFY_BAD_TTL_MS);
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
