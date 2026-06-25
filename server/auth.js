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

var crypto = require('crypto');

var SUPABASE_URL = process.env.SUPABASE_URL || null;
var SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
var JWT_SECRET = process.env.SUPABASE_JWT_SECRET || null;

var supabase = null;
var jwt = null;
var enabled = false;

// jsonwebtoken is needed for BOTH the legacy Supabase HS256 verify (when a JWT secret
// is configured) AND the Discord Activity session ticket (below), so require it
// unconditionally rather than only when SUPABASE_JWT_SECRET is set.
try {
    jwt = require('jsonwebtoken');
} catch (e) {
    console.log('[auth] jsonwebtoken unavailable:', e.message);
}

// Discord Activity session ticket secret. The Activity bridge can't mint a real
// Supabase token (this project signs with asymmetric keys — there's no shared HS256
// secret to reproduce; the server already falls back to network getUser). So instead
// the bridge mints OUR OWN short-lived ticket, HS256-signed with this server-only
// secret, and verifyToken() accepts it (issuer-scoped) before the Supabase paths.
//
// PREFER an explicit DISCORD_TICKET_SECRET — that decouples the ticket lifecycle from
// any other credential. When it's unset we DERIVE one from the service-role key (so the
// common deploy needs no new env var and the secret is stable across restarts), but that
// couples two lifecycles: rotating the service-role key, or a multi-instance deploy with
// any key skew, silently invalidates live tickets (Activity players drop to guest on
// reconnect). We warn loudly in that case (below) so it's a known trade-off, not a
// surprise. A random fallback covers guest-only dev (no key), where tickets are never
// minted anyway.
var TICKET_ISSUER = 'chaochao-activity';
var TICKET_SECRET_EXPLICIT = !!process.env.DISCORD_TICKET_SECRET;
var TICKET_SECRET_DERIVED = !TICKET_SECRET_EXPLICIT && !!SERVICE_ROLE_KEY;
var TICKET_SECRET = process.env.DISCORD_TICKET_SECRET ||
    (SERVICE_ROLE_KEY
        ? crypto.createHash('sha256').update('chaochao-discord-ticket|' + SERVICE_ROLE_KEY).digest('hex')
        : crypto.randomBytes(32).toString('hex'));

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

// Decide whether Supabase WRITES are live. Pure + exported so unit tests can pin the full
// matrix without building a client. Writes are on wherever a service-role DB is configured
// (`dbConfigured`) — the old ALLOW_SUPABASE_WRITES kill-switch existed only to stop LOCAL
// dev from clobbering PROD, and local now points at the dedicated dev project. One automatic
// tripwire replaces that gate: never let a NON-production host write to the PROD project. The
// only expected prod writer is the Heroku dyno (Heroku sets DYNO on every dyno); if some other
// process is pointed at the prod URL — e.g. a local `.env` with stale copied prod creds —
// block writes rather than risk polluting prod. ALLOW_PROD_WRITES=true overrides. Normal paths
// need no flag: local-at-dev never trips it, Heroku-at-prod is recognised by DYNO.
var PROD_PROJECT_REF = 'spkwpkpiuzshrfwplzyg';
function resolveWritesEnabled(dbConfigured, supabaseUrl, env) {
    env = env || {};
    if (!dbConfigured) { return false; } // guest-only dev: no DB, in-memory fallbacks (game.js) apply
    var targetsProd = !!supabaseUrl && supabaseUrl.indexOf(PROD_PROJECT_REF) !== -1;
    if (targetsProd && !env.DYNO && env.ALLOW_PROD_WRITES !== 'true') { return false; }
    return true;
}
var writesEnabled = resolveWritesEnabled(enabled, SUPABASE_URL, process.env);
if (enabled && !writesEnabled) {
    console.log('[auth] WRITES BLOCKED: pointed at the PROD project from a non-Heroku host. ' +
        'Use the DEV project locally, or set ALLOW_PROD_WRITES=true to override.');
}

if (enabled) {
    console.log('[auth] Supabase auth ENABLED (' + (jwt && JWT_SECRET ? 'local JWT verify' : 'network verify') + '), writes ' + (writesEnabled ? 'ENABLED' : 'BLOCKED') + ' (target: ' + SUPABASE_URL + ').');
    if (TICKET_SECRET_DERIVED) {
        console.log('[auth] Discord ticket secret is DERIVED from the service-role key. ' +
            'Set DISCORD_TICKET_SECRET to decouple it — otherwise rotating the service-role key ' +
            '(or a multi-instance deploy with key skew) silently demotes active Activity players to guests.');
    }
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

// Bounded-map insert shared by the token cache and the Discord snowflake cache: when at
// capacity, drop the OLDEST entry (FIFO) rather than clearing the whole map (a full wipe
// would force a thundering-herd re-verify of every live session). Overwriting an existing
// key doesn't grow the map, so it never evicts in that case.
function boundedMapSet(map, key, value, max) {
    if (map.size >= max && !map.has(key)) {
        var oldest = map.keys().next().value;
        if (oldest !== undefined) { map.delete(oldest); }
    }
    map.set(key, value);
}

function cachePut(token, userId, ttl) {
    var expiresAt = Date.now() + ttl;
    if (userId) {
        // Never cache a good token past its own expiry.
        var exp = tokenExpSeconds(token);
        if (exp) { expiresAt = Math.min(expiresAt, exp * 1000); }
    }
    boundedMapSet(tokenCache, token, { userId: userId, expiresAt: expiresAt }, TOKEN_CACHE_MAX);
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
    // Discord Activity session ticket (issuer-scoped, HS256 with our server secret).
    // Checked first — it's a cheap local verify, and a ticket would never validate on
    // the Supabase paths. A normal Supabase token has a different issuer/signature, so
    // jwt.verify throws here and we fall through. The ticket's sub is the already-
    // resolved Supabase user id, so it's a verified user id with no network hop.
    if (jwt) {
        try {
            var ticket = jwt.verify(token, TICKET_SECRET, { algorithms: ['HS256'], issuer: TICKET_ISSUER });
            if (ticket && ticket.sub) {
                return cachePut(token, ticket.sub, VERIFY_OK_TTL_MS);
            }
        } catch (e) {
            // Not our ticket (or expired/tampered) — fall through to the Supabase paths.
        }
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

// Read a user's progression row. Only `enabled` (can we talk to Supabase at all)
// gates it. Returns a normalized row, or null when auth is disabled / the user has
// no row yet (caller falls back to a default).
// Progression read column lists. touch_walkthrough_seen is the newest column; if a server
// build reaches a DB whose migration hasn't run yet, PostgREST 42703s on the missing column.
// We retry with the legacy list (the flag then reads false) rather than returning null — XP,
// level, unlocks and equipped cosmetics must NEVER depend on one additive column's migration
// timing, or a code-before-migration deploy would reset every signed-in player to defaults.
var PROGRESSION_COLS = 'xp, level, unlocked_skins, medal_counts, wins, selected_cart, selected_pattern, selected_trail, selected_border, touch_walkthrough_seen';
var PROGRESSION_COLS_LEGACY = 'xp, level, unlocked_skins, medal_counts, wins, selected_cart, selected_pattern, selected_trail, selected_border';
function isMissingColumnError(err) {
    return !!err && (err.code === '42703' || /column .* does not exist/i.test(err.message || ''));
}
async function getProgression(userId) {
    if (!enabled || !userId || !supabase) {
        return null;
    }
    try {
        var res = await supabase
            .from('progression')
            .select(PROGRESSION_COLS)
            .eq('user_id', userId)
            .maybeSingle();
        if (res.error && isMissingColumnError(res.error)) {
            // touch_walkthrough_seen migration hasn't reached this DB yet — load everything
            // else so the read degrades to "flag unseen" instead of nulling the whole payload.
            res = await supabase
                .from('progression')
                .select(PROGRESSION_COLS_LEGACY)
                .eq('user_id', userId)
                .maybeSingle();
        }
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
    var xp = (row && typeof row.xp === 'number') ? row.xp : def.xp;
    return {
        xp: xp,
        // Level is DERIVED from xp on every read, never trusted from the stored column.
        // The column is only a write-time cache (addProgression keeps it current for
        // analytics): after a curve retune the stored value goes stale until the
        // player's next match, which would leave the badge, equip gating, and the
        // recomputed xpThisLevel/nextUnlock fields in the same payload disagreeing.
        level: progression.levelForXp(xp),
        unlocked_skins: (row && Array.isArray(row.unlocked_skins)) ? row.unlocked_skins : def.unlocked_skins,
        medal_counts: (row && row.medal_counts && typeof row.medal_counts === 'object') ? row.medal_counts : def.medal_counts,
        wins: (row && typeof row.wins === 'number') ? row.wins : def.wins,
        // Per-slot equipped cosmetic ids (null = the slot's default). Restored onto the
        // live Player so equips persist across sessions/devices.
        selected_cart: (row && typeof row.selected_cart === 'string') ? row.selected_cart : null,
        selected_pattern: (row && typeof row.selected_pattern === 'string') ? row.selected_pattern : null,
        selected_trail: (row && typeof row.selected_trail === 'string') ? row.selected_trail : null,
        selected_border: (row && typeof row.selected_border === 'string') ? row.selected_border : null,
        // Account-backed "mobile touch walkthrough seen" latch — restored so a signed-in
        // player never re-sees the first-run walkthrough on a new device, or in the Discord
        // Activity whose iframe localStorage is partitioned/ephemeral. Preserve "absent" as
        // undefined rather than coercing to false: the legacy/missing-column getProgression
        // fallback AND the addProgression writer payload both omit this column, and a coerced
        // `false` would defeat buildProgressionPayload's typeof-boolean omission guard and
        // re-show the walkthrough to a returning player (during the migration window, or after
        // every match/XP write). Only a row that genuinely carries the boolean is authoritative.
        touch_walkthrough_seen: (row && typeof row.touch_walkthrough_seen === "boolean") ? row.touch_walkthrough_seen : undefined,
        // { cosmetic_id: ISO8601 } — when each cosmetic was first unlocked (adoption analytics).
        unlock_dates: (row && row.unlock_dates && typeof row.unlock_dates === 'object') ? row.unlock_dates : {}
    };
}

// Persist ONE cosmetic-slot equip (cart/pattern/trail) for a signed-in player. A no-op when
// no DB is configured (guest-only dev). `id` null clears the slot. Upserts so a player with
// no row yet still records the pick. Touches only the one selected_<slot> column; never the
// XP/medal columns. `border` persists to its own selected_border column (independent 4th slot).
var COSMETIC_SLOT_COLUMN = { cart: 'selected_cart', pattern: 'selected_pattern', trail: 'selected_trail', border: 'selected_border' };
async function saveCosmetic(userId, slot, id) {
    var column = COSMETIC_SLOT_COLUMN[slot];
    if (!userId || !supabase || !column) {
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

// Persist the "mobile touch walkthrough seen" latch for a signed-in player. Monotonic — only
// ever sets true (a player can't "un-see" the walkthrough). A no-op when no DB is configured
// (guest-only dev). Upserts so a player with no row yet still records it. Touches ONLY the one
// column. Mirrors saveCosmetic: gates on userId/supabase, NOT writesEnabled (that flag is only
// for irreversible new-user creation + join logging; this latch is harmless adoption state).
async function saveTouchWalkthroughSeen(userId) {
    if (!userId || !supabase) {
        return null;
    }
    try {
        var upd = await supabase
            .from('progression')
            .upsert({ user_id: userId, touch_walkthrough_seen: true, updated_at: new Date().toISOString() },
                { onConflict: 'user_id' });
        if (upd.error) {
            console.log('[auth] saveTouchWalkthroughSeen write failed:', upd.error.message);
            return null;
        }
        return true;
    } catch (e) {
        console.log('[auth] saveTouchWalkthroughSeen error:', e.message);
        return null;
    }
}

// Shared optimistic-concurrency writer for the single-row `progression` table. Reads the row
// (selectCols), lets `computeFn(existingDataOrNull, rowExists)` derive the new column values,
// then writes them CONDITIONED on updated_at being unchanged since the read — retrying on a
// concurrent write (0 rows updated) or an insert race (23505) up to 5 times. Centralises the
// subtle CAS/insert-race protocol so addProgression and grantSeasonalClaims can't drift apart.
//
// computeFn must return either:
//   null                 -> nothing to write; the helper returns null (a no-op).
//   { payload, result }  -> `payload` (must include user_id + updated_at) is written; `result`
//                           is returned to the caller on a successful write.
// computeFn is re-invoked with freshly-read data on every retry, so derived totals are always
// computed against the latest row. Returns the chosen `result`, or null when aborted/failed/no DB.
async function casUpdateProgression(userId, selectCols, computeFn) {
    if (!userId || !supabase) {
        return null;
    }
    var MAX_ATTEMPTS = 5;
    try {
        for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            var existing = await supabase
                .from('progression')
                .select(selectCols)
                .eq('user_id', userId)
                .maybeSingle();
            if (existing.error) {
                console.log('[auth] casUpdateProgression select failed:', existing.error.message);
                return null;
            }
            var rowExists = !!existing.data;
            var computed = computeFn(existing.data || null, rowExists);
            if (!computed) {
                return null; // computeFn decided there's nothing to write
            }
            if (rowExists) {
                // CAS: only succeeds if no one else wrote since our read.
                var upd = await supabase
                    .from('progression')
                    .update(computed.payload)
                    .eq('user_id', userId)
                    .eq('updated_at', existing.data.updated_at)
                    .select('user_id');
                if (upd.error) {
                    console.log('[auth] casUpdateProgression update failed:', upd.error.message);
                    return null;
                }
                if (upd.data && upd.data.length > 0) {
                    return computed.result;
                }
                // 0 rows updated -> a concurrent writer moved updated_at; retry against fresh values.
            } else {
                var ins = await supabase
                    .from('progression')
                    .insert(computed.payload)
                    .select('user_id');
                if (!ins.error) {
                    return computed.result;
                }
                // Unique-violation -> someone inserted the row first; retry as an update.
                if (ins.error.code === '23505' || /duplicate|unique/i.test(ins.error.message || '')) {
                    continue;
                }
                console.log('[auth] casUpdateProgression insert failed:', ins.error.message);
                return null;
            }
        }
        console.log('[auth] casUpdateProgression: gave up after', MAX_ATTEMPTS, 'contended attempts for', userId);
        return null;
    } catch (e) {
        console.log('[auth] casUpdateProgression error:', e.message);
        return null;
    }
}

// Apply a match's XP / medal / win deltas to a user's progression row and persist. A no-op when
// no DB is configured (guest-only dev). Recomputes level + achievement unlocks via the pure
// progression helpers against the freshly-read row (CAS-guarded by casUpdateProgression).
// Returns the new normalized row (so the caller can emit it) + newToasts, or null when no DB.
async function addProgression(userId, opts) {
    opts = opts || {};
    return casUpdateProgression(
        userId,
        'xp, level, unlocked_skins, medal_counts, wins, pending_toasts, unlock_dates, updated_at',
        function (existingData) {
            var cur = normalizeProgression(existingData || {});
            var oldLevel = cur.level;
            var newXp = cur.xp + (opts.xpDelta || 0);
            var newWins = cur.wins + (opts.win ? 1 : 0);
            var newMedalCounts = progression.mergeMedalCounts(cur.medal_counts, opts.medalDeltas);
            if (opts.win !== undefined) { progression.applyWinStreak(newMedalCounts, opts.win); } // match writes only; a bare medal bump (e.g. mapsSubmitted) must not reset the streak
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
            var builtToasts = progression.buildToastEvents({
                xpDelta: opts.xpDelta || 0,
                oldXp: cur.xp,
                oldLevel: oldLevel,
                newLevel: newLevel,
                levelSkinsUnlocked: skinRegistry.levelSkinsUnlockedBetween,
                freshAchievementSkins: freshAchievementSkins
            });
            // opts.suppressXpToast: the rewarded-XP claim announces the bonus with its OWN
            // `xpBonus` toast, so drop the duplicate "+N XP" event here — but KEEP any level-up
            // and newly-unlocked level-skin toasts the bonus crosses (those aren't duplicated
            // anywhere else and the player would otherwise gain them silently).
            var newToasts = opts.suppressXpToast
                ? builtToasts.filter(function (t) { return t.type !== 'xp'; })
                : builtToasts;
            var existingToasts = (existingData && Array.isArray(existingData.pending_toasts))
                ? existingData.pending_toasts : [];
            var mergedToasts = existingToasts.concat(newToasts);
            // Stamp the first-unlock date for every cosmetic newly earned this match (level
            // skins + achievement skins). Never overwrite an existing date. Analytics only.
            var unlockDates = (cur.unlock_dates && typeof cur.unlock_dates === 'object')
                ? Object.assign({}, cur.unlock_dates) : {};
            var nowIso = new Date().toISOString();
            var freshLevelSkins = skinRegistry.levelSkinsUnlockedBetween(oldLevel, newLevel);
            var allFresh = freshAchievementSkins.concat(freshLevelSkins);
            for (var f = 0; f < allFresh.length; f++) {
                if (!unlockDates[allFresh[f]]) { unlockDates[allFresh[f]] = nowIso; }
            }
            var payload = {
                user_id: userId,
                xp: newXp,
                level: newLevel,
                wins: newWins,
                medal_counts: newMedalCounts,
                unlocked_skins: unlocked,
                pending_toasts: mergedToasts,
                unlock_dates: unlockDates,
                updated_at: new Date().toISOString()
            };
            var out = normalizeProgression(payload);
            out.newToasts = newToasts; // durable copy is in pending_toasts
            return { payload: payload, result: out };
        }
    );
}

// Grant any OPEN seasonal-claim cosmetics (skinRegistry kind:'seasonal' whose window is
// live) to a signed-in user, ONCE. The id lands in unlocked_skins — permanent ownership,
// identical to an achievement skin — and a {type:'seasonal'} celebration toast is queued so
// the claim is announced on the player's next lobby arrival. Idempotent: an id already owned
// is skipped, so repeat sign-ins never re-toast. After a window's claimEnd the registry
// returns it no longer, so the grant simply stops — nothing is ever revoked. CAS-guarded against
// a concurrent match-end write (both via casUpdateProgression).
// Returns the array of newly granted ids (possibly empty), or null when no DB is configured.
async function grantSeasonalClaims(userId) {
    if (!userId || !supabase) {
        return null;
    }
    var open = skinRegistry.currentSeasonalClaims(Date.now());
    if (!open.length) {
        return [];
    }
    var granted = await casUpdateProgression(
        userId,
        'unlocked_skins, unlock_dates, pending_toasts, updated_at',
        function (existingData) {
            var unlocked = (existingData && Array.isArray(existingData.unlocked_skins))
                ? existingData.unlocked_skins.slice() : [];
            var fresh = [];
            for (var i = 0; i < open.length; i++) {
                if (unlocked.indexOf(open[i]) === -1) { unlocked.push(open[i]); fresh.push(open[i]); }
            }
            if (!fresh.length) {
                return null; // already claimed everything currently open — nothing to write
            }
            var unlockDates = (existingData && existingData.unlock_dates && typeof existingData.unlock_dates === 'object')
                ? Object.assign({}, existingData.unlock_dates) : {};
            var nowIso = new Date().toISOString();
            var claimToasts = [];
            for (var g = 0; g < fresh.length; g++) {
                if (!unlockDates[fresh[g]]) { unlockDates[fresh[g]] = nowIso; }
                claimToasts.push({ type: 'seasonal', id: fresh[g] });
            }
            var existingToasts = (existingData && Array.isArray(existingData.pending_toasts))
                ? existingData.pending_toasts : [];
            var payload = {
                user_id: userId,
                unlocked_skins: unlocked,
                unlock_dates: unlockDates,
                pending_toasts: existingToasts.concat(claimToasts),
                updated_at: new Date().toISOString()
            };
            return { payload: payload, result: fresh };
        }
    );
    return granted || []; // casUpdateProgression returns null on abort/failure; callers expect an array
}

// Read and CLEAR a user's pending celebration toasts (shown on lobby arrival).
// A READ-then-clear, CAS-guarded so a concurrent write can't drop a toast.
// Returns [] when auth is off / no row / empty.
async function drainPendingToasts(userId) {
    if (!enabled || !userId || !supabase) {
        return [];
    }
    try {
        for (var attempt = 0; attempt < 5; attempt++) {
            var res = await supabase
                .from('progression')
                .select('pending_toasts, updated_at')
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
            // Compare-and-swap clear: only wipe if no write landed since our read. If a
            // concurrent match-end addProgression appended NEW toasts (moving updated_at), the
            // clear touches 0 rows and we retry — the re-read then claims the fuller set, so an
            // appended toast is always delivered, never erased by a stale clear.
            var upd = await supabase
                .from('progression')
                .update({ pending_toasts: [], updated_at: new Date().toISOString() })
                .eq('user_id', userId)
                .eq('updated_at', res.data.updated_at)
                .select('user_id');
            if (upd.error) {
                console.log('[auth] drainPendingToasts clear failed:', upd.error.message);
                return [];
            }
            if (upd.data && upd.data.length) {
                return toasts; // cleared exactly what we read
            }
            // 0 rows updated -> a concurrent writer moved updated_at; retry.
        }
        console.log('[auth] drainPendingToasts: gave up after contended attempts for', userId);
        return [];
    } catch (e) {
        console.log('[auth] drainPendingToasts error:', e.message);
        return [];
    }
}

// Re-append toasts to the durable queue when delivery failed after a drain cleared them
// (socket vanished mid-drain). Best-effort, CAS-guarded. Older toasts go first.
async function requeuePendingToasts(userId, toasts) {
    if (!userId || !supabase || !toasts || !toasts.length) {
        return;
    }
    try {
        for (var attempt = 0; attempt < 5; attempt++) {
            var res = await supabase.from('progression').select('pending_toasts, updated_at').eq('user_id', userId).maybeSingle();
            if (res.error || !res.data) { return; }
            var cur = Array.isArray(res.data.pending_toasts) ? res.data.pending_toasts : [];
            var upd = await supabase.from('progression')
                .update({ pending_toasts: toasts.concat(cur), updated_at: new Date().toISOString() })
                .eq('user_id', userId).eq('updated_at', res.data.updated_at).select('user_id');
            if (upd.error) { return; }
            if (upd.data && upd.data.length) { return; }
        }
    } catch (e) {
        console.log('[auth] requeuePendingToasts error:', e.message);
    }
}

// --- Discord Activity bridge (Phase 4) -----------------------------------------
// In-frame Discord auth identifies a player WITHOUT a full-page OAuth redirect, then
// bridges that identity onto a REAL Supabase user so the existing cosmetic/progression
// path (which keys on a verified user_id) works unchanged. server/discordAuth.js owns
// the Discord HTTP exchange + the client secret; these two helpers own the Supabase
// side (the admin client + JWT secret live here and are never re-exported).

// mintAccessToken: sign a Discord Activity SESSION TICKET (HS256 with our server-only
// TICKET_SECRET, issuer-scoped) for a resolved Supabase user id. verifyToken() accepts
// it locally with NO Supabase round-trip — so the socket handshake treats a Discord
// player exactly like a signed-in web player. We mint our own ticket rather than a
// Supabase token because this project signs with asymmetric keys (no shared HS256
// secret to reproduce). Requires the jwt lib; returns null otherwise (then Discord
// auth degrades to guest rather than minting a ticket the server can't verify). 12h
// TTL: an Activity session can run long, and the ticket is reused across reconnects.
function mintAccessToken(userId, opts) {
    opts = opts || {};
    if (!jwt || !userId) {
        return null;
    }
    var ttl = opts.ttlSeconds || (12 * 60 * 60);
    var nowSec = Math.floor(Date.now() / 1000);
    var claims = {
        sub: userId,
        iss: TICKET_ISSUER,
        src: 'discord',
        iat: nowSec,
        exp: nowSec + ttl
    };
    try {
        return jwt.sign(claims, TICKET_SECRET, { algorithm: 'HS256' });
    } catch (e) {
        console.log('[auth] mintAccessToken failed:', e.message);
        return null;
    }
}

// Resolve a VALIDATED Discord identity ({ id, name, avatarUrl }) to a Supabase user id,
// reusing the existing account when one already owns this Discord snowflake (web login
// OR a prior Activity launch) and creating + linking a fresh one otherwise. Returns
// { userId, name, avatarUrl } or null (auth off / lookup+create both failed). Never
// throws. A short snowflake->userId cache spares repeat launches the admin round-trip.
var discordUserCache = new Map();
var DISCORD_USER_TTL_MS = 10 * 60 * 1000;
var DISCORD_USER_CACHE_MAX = 5000;
function cachePutDiscord(snowflake, userId) {
    boundedMapSet(discordUserCache, snowflake, { userId: userId, expiresAt: Date.now() + DISCORD_USER_TTL_MS }, DISCORD_USER_CACHE_MAX);
}
async function findOrCreateDiscordUser(discord) {
    if (!enabled || !supabase || !discord || !discord.id) {
        return null;
    }
    var snowflake = String(discord.id);
    var name = sanitizeDisplayName(discord.name) || null;
    var avatarUrl = (typeof discord.avatarUrl === 'string') ? discord.avatarUrl : null;

    var cached = discordUserCache.get(snowflake);
    if (cached && cached.expiresAt > Date.now()) {
        return { userId: cached.userId, name: name, avatarUrl: avatarUrl };
    }
    try {
        // Read side: an account already owns this Discord identity — reuse it so its
        // cosmetics/progression are exactly what the player sees in the Activity.
        var found = await supabase.rpc('find_user_by_discord_id', { p_discord_id: snowflake });
        if (found.error) {
            console.log('[auth] find_user_by_discord_id failed:', found.error.message);
        } else if (found.data) {
            cachePutDiscord(snowflake, found.data);
            return { userId: found.data, name: name, avatarUrl: avatarUrl };
        }

        // No existing account. Creating one is a WRITE (admin.createUser + the identity
        // link), so it must honor the same writesEnabled tripwire as every progression
        // write — otherwise a non-Heroku host accidentally pointed at the PROD project
        // would create real auth.users/auth.identities rows in prod, the exact pollution
        // writesEnabled exists to prevent. The read above still runs (an existing player
        // resolves fine); we only refuse to WRITE a new account when writes are blocked.
        if (!writesEnabled) {
            console.log('[auth] findOrCreateDiscordUser: writes BLOCKED — not creating a new Supabase user for Discord id ' + snowflake + '.');
            return null;
        }

        // Create one. The synthetic email + the discord_id stamped
        // into user_metadata both make this user re-findable (the latter is the fallback
        // the lookup uses if the identity link below didn't land).
        var meta = { provider: 'discord', discord_id: snowflake };
        if (name) { meta.full_name = name; meta.name = name; }
        if (avatarUrl) { meta.avatar_url = avatarUrl; }
        var created = await supabase.auth.admin.createUser({
            email: 'discord_' + snowflake + '@discord.chaochao.local',
            email_confirm: true,
            user_metadata: meta,
            app_metadata: { provider: 'discord', providers: ['discord'] }
        });
        if (created.error || !created.data || !created.data.user) {
            // A concurrent first-launch may have created it (email collision) — re-resolve.
            var retry = await supabase.rpc('find_user_by_discord_id', { p_discord_id: snowflake });
            if (!retry.error && retry.data) {
                cachePutDiscord(snowflake, retry.data);
                return { userId: retry.data, name: name, avatarUrl: avatarUrl };
            }
            console.log('[auth] createUser(discord) failed:', created.error && created.error.message);
            return null;
        }
        var userId = created.data.user.id;
        // Best-effort: link a provider='discord' identity so a LATER web Discord login
        // adopts this same account. A failure here doesn't block play (the metadata
        // stamp above still makes the user re-findable from the Activity side).
        var identityData = { sub: snowflake, provider_id: snowflake };
        if (name) { identityData.name = name; identityData.full_name = name; }
        if (avatarUrl) { identityData.avatar_url = avatarUrl; }
        var linked = await supabase.rpc('link_discord_identity', {
            p_user_id: userId, p_discord_id: snowflake, p_identity_data: identityData
        });
        if (linked.error) {
            console.log('[auth] link_discord_identity (best-effort) failed:', linked.error.message);
        }
        cachePutDiscord(snowflake, userId);
        return { userId: userId, name: name, avatarUrl: avatarUrl };
    } catch (e) {
        console.log('[auth] findOrCreateDiscordUser error:', e.message);
        return null;
    }
}

exports.mintAccessToken = mintAccessToken;
exports.findOrCreateDiscordUser = findOrCreateDiscordUser;
exports.requeuePendingToasts = requeuePendingToasts;
exports.enabled = enabled;
exports.writesEnabled = writesEnabled;
exports.resolveWritesEnabled = resolveWritesEnabled; // pure decision, exported for unit tests
exports.supabase = supabase;
exports.verifyToken = verifyToken;
exports.ensureProgressionRow = ensureProgressionRow;
exports.getProgression = getProgression;
exports.addProgression = addProgression;
exports.saveCosmetic = saveCosmetic;
exports.saveTouchWalkthroughSeen = saveTouchWalkthroughSeen;
exports.grantSeasonalClaims = grantSeasonalClaims;
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
