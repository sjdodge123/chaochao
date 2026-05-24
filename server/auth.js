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

// Resolve an access token (Supabase JWT) to a user id, or null if invalid/absent.
// Prefers local HS256 verification with the JWT secret (no round-trip per
// connection); falls back to supabase.auth.getUser() when the secret is missing
// or the local verify fails (e.g. asymmetric signing keys).
async function verifyToken(token) {
    if (!enabled || !token) {
        return null;
    }
    if (jwt && JWT_SECRET) {
        try {
            var decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
            if (decoded && decoded.sub) {
                return decoded.sub;
            }
        } catch (e) {
            // Fall through to network verification below.
        }
    }
    try {
        var res = await supabase.auth.getUser(token);
        if (res && res.data && res.data.user && !res.error) {
            return res.data.user.id;
        }
    } catch (e) {
        console.log('[auth] verifyToken network fallback failed:', e.message);
    }
    return null;
}

// Ensure a `progression` row exists for the user and record `deviceId` on it
// (dedup). Never resets existing progress — only creates the row if missing and
// appends the device id. Account-linking merges of guest progress happen later
// when progression mechanics exist; for now we just stamp the device.
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
// Public, browser-safe config to inject into served pages. Returns null when
// auth is disabled OR the anon key is absent so the client also treats everyone
// as a guest. NEVER includes the service-role key or the JWT secret.
exports.getPublicConfig = function () {
    var anonKey = process.env.SUPABASE_ANON_KEY || null;
    if (!SUPABASE_URL || !anonKey) {
        return null;
    }
    return { url: SUPABASE_URL, anonKey: anonKey };
};
