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

var progression = require('./progression.js');
var skinRegistry = require('./skinRegistry.js');

var SUPABASE_URL = process.env.SUPABASE_URL || null;
var SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
var JWT_SECRET = process.env.SUPABASE_JWT_SECRET || null;

// Global kill-switch for ALL Supabase WRITE paths (leaderboard upserts,
// progression-row writes, anything added later). Reads stay live so dev can
// still see prod's data. Default OFF so local dev never accidentally pollutes
// the prod database — Heroku/production must explicitly set this to "true".
// Add new writers here too: gate every write at the call site so this stays
// the one switch the operator flips.
var writesEnabled = (process.env.ALLOW_SUPABASE_WRITES === 'true');

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
    console.log('[auth] Supabase auth ENABLED (' + (jwt && JWT_SECRET ? 'local JWT verify' : 'network verify') + '), writes ' + (writesEnabled ? 'ENABLED' : 'BLOCKED (ALLOW_SUPABASE_WRITES != "true")') + '.');
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
    // Global Supabase-writes gate. Local dev defaults to blocked so test
    // sessions can sign in (reads still work) without seeding rows into the
    // shared/prod project.
    if (!writesEnabled) {
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

// Best-effort display-name lookup for a verified user_id. Used by the map-time
// leaderboard to denormalize a player label into the map_times row so the
// overview-screen card doesn't need to round-trip through auth.users on every
// render. The first lookup hits supabase.auth.admin.getUserById once; the
// result is cached for the lifetime of the process (display names rarely
// change, and a stale label on a leaderboard refreshes on the next PB write).
// Returns null when auth is disabled, the user is missing, or the call fails.
var displayNameCache = new Map();
var DISPLAY_NAME_TTL_MS = 30 * 60 * 1000; // 30 min — provider name changes are rare

function sanitizeDisplayName(raw) {
    if (typeof raw !== 'string') { return null; }
    // Same control/bidi strip as the avatar-skin name path in messenger.js so a
    // leaderboard row can't smuggle in zero-width or override characters.
    var s = raw.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '').trim();
    if (!s.length) { return null; }
    // Code-point cap so a surrogate pair (emoji name) is never split.
    return Array.from(s).slice(0, 24).join('');
}

async function getDisplayName(userId) {
    if (!enabled || !userId) { return null; }
    var hit = displayNameCache.get(userId);
    if (hit && hit.expiresAt > Date.now()) { return hit.name; }
    try {
        var res = await supabase.auth.admin.getUserById(userId);
        if (res.error || !res.data || !res.data.user) {
            displayNameCache.set(userId, { name: null, expiresAt: Date.now() + DISPLAY_NAME_TTL_MS });
            return null;
        }
        var u = res.data.user;
        var meta = u.user_metadata || {};
        // Never fall back to u.email — display_name is denormalized into the
        // publicly-readable map_times row, so a user with no name metadata
        // would have their email broadcast on the leaderboard. Null is fine;
        // the client renders "user <id-prefix>" as a placeholder for null
        // names.
        var raw = meta.full_name || meta.name || meta.user_name || null;
        var clean = sanitizeDisplayName(raw);
        displayNameCache.set(userId, { name: clean, expiresAt: Date.now() + DISPLAY_NAME_TTL_MS });
        return clean;
    } catch (e) {
        console.log('[auth] getDisplayName failed:', e.message);
        return null;
    }
}

// Read a user's progression row. A READ, so it works even when writes are gated
// off (local dev still sees prod data) — only `enabled` (can we talk to Supabase
// at all) gates it. Returns a normalized row, or null when auth is disabled / the
// user has no row yet (caller falls back to a default).
async function getProgression(userId) {
    if (!enabled || !userId || !supabase) {
        return null;
    }
    try {
        var res = await supabase
            .from('progression')
            .select('xp, level, unlocked_skins, medal_counts, wins, selected_cart, selected_pattern, selected_trail')
            .eq('user_id', userId)
            .maybeSingle();
        if (res.error) {
            console.log('[auth] getProgression failed:', res.error.message);
            return null;
        }
        if (!res.data) {
            return null;
        }
        return normalizeProgression(res.data);
    } catch (e) {
        console.log('[auth] getProgression error:', e.message);
        return null;
    }
}

function normalizeProgression(row) {
    var def = progression.defaultProgression();
    return {
        xp: (row && typeof row.xp === 'number') ? row.xp : def.xp,
        level: (row && typeof row.level === 'number') ? row.level : def.level,
        unlocked_skins: (row && Array.isArray(row.unlocked_skins)) ? row.unlocked_skins : def.unlocked_skins,
        medal_counts: (row && row.medal_counts && typeof row.medal_counts === 'object') ? row.medal_counts : def.medal_counts,
        wins: (row && typeof row.wins === 'number') ? row.wins : def.wins,
        // Per-slot equipped cosmetic ids (null = the slot's default). Restored onto the
        // live Player so equips persist across sessions/devices.
        selected_cart: (row && typeof row.selected_cart === 'string') ? row.selected_cart : null,
        selected_pattern: (row && typeof row.selected_pattern === 'string') ? row.selected_pattern : null,
        selected_trail: (row && typeof row.selected_trail === 'string') ? row.selected_trail : null
    };
}

// Persist ONE cosmetic-slot equip (cart/pattern/trail) for a signed-in player. Behind the
// writes gate like every other writer — a no-op locally so dev never seeds the shared DB.
// `id` null clears the slot. Upserts so a player with no row yet still records the pick.
// Touches only the one selected_<slot> column; never the XP/medal columns.
var COSMETIC_SLOT_COLUMN = { cart: 'selected_cart', pattern: 'selected_pattern', trail: 'selected_trail' };
async function saveCosmetic(userId, slot, id) {
    var column = COSMETIC_SLOT_COLUMN[slot];
    if (!writesEnabled || !userId || !supabase || !column) {
        return null;
    }
    try {
        var payload = { user_id: userId, updated_at: new Date().toISOString() };
        payload[column] = (id == null || id === '') ? null : id;
        var upd = await supabase
            .from('progression')
            .upsert(payload, { onConflict: 'user_id' });
        if (upd.error) {
            console.log('[auth] saveCosmetic write failed:', upd.error.message);
            return null;
        }
        return true;
    } catch (e) {
        console.log('[auth] saveCosmetic error:', e.message);
        return null;
    }
}

// Apply a match's XP / medal / win deltas to a user's progression row and persist.
// Behind the global writes gate (ALLOW_SUPABASE_WRITES) like every other writer —
// a no-op locally so dev never seeds the shared DB. Re-reads the row so the stored
// value is authoritative (not the caller's possibly-stale cache), recomputes level
// + achievement unlocks via the pure progression helpers, and writes the whole
// columns back. Returns the new normalized row (so the caller can emit it), or null
// when writes are gated/disabled.
//
// Not atomic (read-modify-write) — but a user only finishes one match at a time, so
// contention is effectively nil; matches the same pragmatic stance as
// ensureProgressionRow. The fully-atomic fix is a Postgres RPC if this ever races.
async function addProgression(userId, opts) {
    opts = opts || {};
    if (!writesEnabled || !userId || !supabase) {
        return null;
    }
    try {
        var existing = await supabase
            .from('progression')
            .select('xp, level, unlocked_skins, medal_counts, wins, pending_toasts')
            .eq('user_id', userId)
            .maybeSingle();
        if (existing.error) {
            console.log('[auth] addProgression select failed:', existing.error.message);
            return null;
        }
        var cur = normalizeProgression(existing.data || {});
        var oldLevel = cur.level;
        var newXp = cur.xp + (opts.xpDelta || 0);
        var newWins = cur.wins + (opts.win ? 1 : 0);
        var newMedalCounts = progression.mergeMedalCounts(cur.medal_counts, opts.medalDeltas);
        var newLevel = progression.levelForXp(newXp);
        // Level skins aren't stored; unlocked_skins holds only achievement skins.
        var earned = progression.achievementsUnlocked(newMedalCounts, newWins);
        var unlocked = (cur.unlocked_skins || []).slice();
        var freshAchievementSkins = [];
        for (var i = 0; i < earned.length; i++) {
            if (unlocked.indexOf(earned[i]) === -1) { unlocked.push(earned[i]); freshAchievementSkins.push(earned[i]); }
        }
        // Build the celebration toasts for this match (shown on next lobby arrival, not
        // on the game-over screen). Appended to the durable pending_toasts queue.
        var newToasts = progression.buildToastEvents({
            xpDelta: opts.xpDelta || 0,
            oldLevel: oldLevel,
            newLevel: newLevel,
            levelSkinsUnlocked: skinRegistry.levelSkinsUnlockedBetween,
            freshAchievementSkins: freshAchievementSkins
        });
        var existingToasts = (existing.data && Array.isArray(existing.data.pending_toasts))
            ? existing.data.pending_toasts : [];
        var mergedToasts = existingToasts.concat(newToasts);
        var payload = {
            user_id: userId,
            xp: newXp,
            level: newLevel,
            wins: newWins,
            medal_counts: newMedalCounts,
            unlocked_skins: unlocked,
            pending_toasts: mergedToasts,
            updated_at: new Date().toISOString()
        };
        var upd = await supabase
            .from('progression')
            .upsert(payload, { onConflict: 'user_id' });
        if (upd.error) {
            console.log('[auth] addProgression write failed:', upd.error.message);
            return null;
        }
        var out = normalizeProgression(payload);
        out.newToasts = newToasts; // caller may use these; durable copy is in pending_toasts
        return out;
    } catch (e) {
        console.log('[auth] addProgression error:', e.message);
        return null;
    }
}

// Read and CLEAR a user's pending celebration toasts (shown on lobby arrival).
// A READ-then-clear: the read works whenever auth is enabled, but the clearing
// write is gated like every other writer. When writes are off (local dev) we still
// RETURN the toasts (so the UI is testable) but DON'T clear them — acceptable since
// dev never accumulates real rows. Returns [] when auth is off / no row / empty.
async function drainPendingToasts(userId) {
    if (!enabled || !userId || !supabase) {
        return [];
    }
    try {
        var res = await supabase
            .from('progression')
            .select('pending_toasts')
            .eq('user_id', userId)
            .maybeSingle();
        if (res.error || !res.data) {
            if (res.error) { console.log('[auth] drainPendingToasts read failed:', res.error.message); }
            return [];
        }
        var toasts = Array.isArray(res.data.pending_toasts) ? res.data.pending_toasts : [];
        if (toasts.length === 0) {
            return [];
        }
        if (writesEnabled) {
            var upd = await supabase
                .from('progression')
                .update({ pending_toasts: [], updated_at: new Date().toISOString() })
                .eq('user_id', userId);
            if (upd.error) {
                // Couldn't clear — return [] rather than risk showing the same toasts
                // forever on every lobby join.
                console.log('[auth] drainPendingToasts clear failed:', upd.error.message);
                return [];
            }
        }
        return toasts;
    } catch (e) {
        console.log('[auth] drainPendingToasts error:', e.message);
        return [];
    }
}

exports.enabled = enabled;
exports.writesEnabled = writesEnabled;
exports.supabase = supabase;
exports.verifyToken = verifyToken;
exports.ensureProgressionRow = ensureProgressionRow;
exports.getProgression = getProgression;
exports.addProgression = addProgression;
exports.saveCosmetic = saveCosmetic;
exports.drainPendingToasts = drainPendingToasts;
exports.getDisplayName = getDisplayName;
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
