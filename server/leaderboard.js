// Per-map personal-best leaderboard. Server-only: reads + writes the
// `map_times` Supabase table via the service-role key. Bot finishes and
// anonymous finishes are filtered out by the callers in game.js — this module
// trusts the userIds it receives.
//
// Public surface:
//   upsertBestTime(userId, mapId, timeMs, displayName)
//     -> { wrote: bool, isNewRecord: bool, previousBestMs: number|null, newBestMs: number }
//        wrote == true ONLY when the row was inserted or the time improved.
//        isNewRecord matches `wrote` (it's the player-facing wording).
//        previousBestMs is null on the very first finish.
//
//   getLeaderboardForPlayers(mapId, userIds)
//     -> [{ userId, displayName, bestMs, rank }, ...]
//        One entry per userId that has a row for mapId; users with no PB are
//        omitted (the client renders them with a placeholder).
//
// Both functions are no-ops (resolve to neutral values) when auth is disabled
// so local dev without Supabase credentials still works.

var auth = require('./auth.js');

function noopUpsertResult(timeMs) {
    return { wrote: false, isNewRecord: false, previousBestMs: null, newBestMs: timeMs };
}

async function upsertBestTime(userId, mapId, timeMs, displayName) {
    if (!auth.enabled || !auth.supabase || !userId || !mapId) {
        return noopUpsertResult(timeMs);
    }
    if (!Number.isFinite(timeMs) || timeMs <= 0 || timeMs >= 86400000) {
        return noopUpsertResult(timeMs);
    }
    // Skip the write when no Supabase DB is configured (guest-only dev). The async
    // leaderboard pipeline still emits playerPbResult with isNewRecord=false here —
    // the client treats that as a slower-than-PB finish (no float, no banner), which
    // is the right UX when there's nowhere to record a PB.
    if (!auth.writesEnabled || !auth.supabase) {
        return noopUpsertResult(timeMs);
    }
    var rounded = Math.round(timeMs);
    var cleanName = (typeof displayName === 'string' && displayName.length) ? displayName : null;
    try {
        // Atomic conditional upsert via the migration 0002 RPC. The previous
        // read-then-write pattern raced on concurrent finishes of the same
        // (user_id, map_id) — both calls could read the same previous best and
        // the slower writer's upsert could overwrite the faster PB. The RPC
        // wraps INSERT ... ON CONFLICT DO UPDATE WHERE in one statement, so
        // a regression can't happen even with simultaneous writers.
        var res = await auth.supabase.rpc('upsert_map_time_if_better', {
            p_user_id: userId,
            p_map_id: mapId,
            p_best_ms: rounded,
            p_display_name: cleanName
        });
        if (res.error) {
            console.log('[leaderboard] upsert RPC failed:', res.error.message);
            return noopUpsertResult(timeMs);
        }
        var row = (res.data && res.data[0]) || {};
        var wrote = !!row.wrote;
        var prev = (row.previous_best_ms != null) ? row.previous_best_ms : null;
        var current = (row.current_best_ms != null) ? row.current_best_ms : rounded;
        return {
            wrote: wrote,
            isNewRecord: wrote,
            previousBestMs: prev,
            newBestMs: current
        };
    } catch (e) {
        console.log('[leaderboard] upsert error:', e.message);
        return noopUpsertResult(timeMs);
    }
}

// Pull all rows for the map, rank them locally by best_ms (ties share a rank),
// then return only the entries for the requested userIds. At the scales we
// have (hundreds of times per popular map, far fewer per niche map), one bulk
// SELECT per round-end is cheaper than N COUNT-rank queries. Swap to an RPC
// window-function if/when leaderboards balloon past a few thousand entries.
async function getLeaderboardForPlayers(mapId, userIds) {
    if (!auth.enabled || !auth.supabase || !mapId || !userIds || userIds.length === 0) {
        return [];
    }
    try {
        var res = await auth.supabase
            .from('map_times')
            .select('user_id, best_ms, display_name')
            .eq('map_id', mapId)
            .order('best_ms', { ascending: true });
        if (res.error) {
            console.log('[leaderboard] rank read failed:', res.error.message);
            return [];
        }
        var rows = res.data || [];
        // Standard SQL RANK() semantics: ties share a rank, leaving a gap after
        // (1, 2, 2, 4) — matches what a player would expect to see globally.
        var lastTime = null;
        var rank = 0;
        var ranked = rows.map(function (r, i) {
            if (lastTime == null || r.best_ms !== lastTime) {
                rank = i + 1;
                lastTime = r.best_ms;
            }
            return { userId: r.user_id, displayName: r.display_name, bestMs: r.best_ms, rank: rank };
        });
        var targets = {};
        for (var i = 0; i < userIds.length; i++) { targets[userIds[i]] = true; }
        return ranked.filter(function (r) { return targets[r.userId]; });
    } catch (e) {
        console.log('[leaderboard] rank error:', e.message);
        return [];
    }
}

// Global top-N for a map — what the "Times to beat for <map name>" card uses
// on the overview screen between rounds. One row per fastest unique user_id,
// ranked by best_ms ascending; ties share a rank (standard SQL RANK semantics).
async function getTopForMap(mapId, limit) {
    if (!auth.enabled || !auth.supabase || !mapId) { return []; }
    var cap = (typeof limit === 'number' && limit > 0) ? limit : 10;
    try {
        var res = await auth.supabase
            .from('map_times')
            .select('user_id, best_ms, display_name')
            .eq('map_id', mapId)
            .order('best_ms', { ascending: true })
            .limit(cap);
        if (res.error) {
            console.log('[leaderboard] top read failed:', res.error.message);
            return [];
        }
        var rows = res.data || [];
        var lastTime = null;
        var rank = 0;
        return rows.map(function (r, i) {
            if (lastTime == null || r.best_ms !== lastTime) {
                rank = i + 1;
                lastTime = r.best_ms;
            }
            return { userId: r.user_id, displayName: r.display_name, bestMs: r.best_ms, rank: rank };
        });
    } catch (e) {
        console.log('[leaderboard] top error:', e.message);
        return [];
    }
}

exports.upsertBestTime = upsertBestTime;
exports.getLeaderboardForPlayers = getLeaderboardForPlayers;
exports.getTopForMap = getTopForMap;
