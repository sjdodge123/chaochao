// Player map ratings (1-5 stars). Server-only: reads + writes the `map_ratings`
// Supabase table via the service-role key, and aggregates the `map_rating_summary`
// view into a per-map { count, avg, bayesian } that drives the Crowd Favorites
// playlist and the editor's per-card score.
//
// Anti-abuse / fairness baked in:
//   * One effective vote per voter per map (UPSERT on the (map_id, voter_id) PK).
//   * Voter id is namespaced — 'u:<uuid>' for signed-in players, 'd:<deviceId>'
//     for guests — so the two identity spaces can't collide. Bots are sockets-less
//     and additionally rejected by deriveVoter (no userId AND no deviceId, or isAI).
//   * Signed-in votes are weighted higher than guest votes (config.balance
//     .ratingAuthedWeight) and a Bayesian prior (ratingConfidenceFloor) keeps a map
//     with two 5-star votes from out-ranking one with hundreds averaging 4.6.
//
// Everything is a no-op (neutral values) when auth/writes are disabled, so local
// dev without Supabase still runs — ratings just stay empty.

var auth = require('./auth.js');

function w(config, key, dflt) {
    var b = config && config.balance;
    return (b && b[key] != null) ? b[key] : dflt;
}

// ---- pure helpers (no DB; unit-tested) --------------------------------------

// True for an integer 1..5.
function validStars(x) {
    return typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 5;
}

// Derive a namespaced voter id from a player, or null if this player may not vote
// (a bot, or an identity-less socket). Signed-in players vote as 'u:<uuid>' and are
// flagged authed; guests vote as 'd:<deviceId>'.
function deriveVoter(player) {
    if (!player || player.isAI) { return null; }
    if (player.verifiedUserId) { return { voterId: 'u:' + player.verifiedUserId, isAuthed: true }; }
    if (player.deviceId) { return { voterId: 'd:' + player.deviceId, isAuthed: false }; }
    return null;
}

// Fold the per-map split-vote summary rows into { mapId: {count, avg, bayesian,
// weightedCount} }. Authed votes count for `weight` each; the Bayesian prior pulls
// thin maps toward the global weighted mean C with confidence floor `m`.
function summarize(rows, config) {
    var weight = w(config, 'ratingAuthedWeight', 3);
    var m = w(config, 'ratingConfidenceFloor', 5);
    rows = Array.isArray(rows) ? rows : [];

    // Per-map weighted count + weighted star sum, and the global pool for C.
    var per = {};
    var totalWeightedCount = 0, totalWeightedSum = 0;
    rows.forEach(function (r) {
        var gv = +r.guest_votes || 0, gs = +r.guest_sum || 0;
        var av = +r.authed_votes || 0, as = +r.authed_sum || 0;
        var wCount = gv + weight * av;
        var wSum = gs + weight * as;
        if (wCount <= 0) { return; }
        per[r.map_id] = { count: gv + av, wCount: wCount, wSum: wSum };
        totalWeightedCount += wCount;
        totalWeightedSum += wSum;
    });
    var C = (totalWeightedCount > 0) ? (totalWeightedSum / totalWeightedCount) : 0;

    var out = {};
    Object.keys(per).forEach(function (mapId) {
        var p = per[mapId];
        var mean = p.wSum / p.wCount;
        var bayesian = (p.wCount * mean + m * C) / (p.wCount + m);
        out[mapId] = {
            count: p.count,
            avg: Math.round(mean * 100) / 100,
            bayesian: Math.round(bayesian * 100) / 100,
            weightedCount: p.wCount
        };
    });
    return out;
}

// ---- DB I/O (gated) ---------------------------------------------------------

// Record (or update) one vote. No-op unless auth + writes are enabled. Returns
// { wrote: bool }.
async function recordRating(mapId, voter, stars, config) {
    if (!validStars(stars) || !mapId || !voter || !voter.voterId) { return { wrote: false }; }
    if (!auth.enabled || !auth.supabase || !auth.writesEnabled) { return { wrote: false }; }
    try {
        var res = await auth.supabase
            .from('map_ratings')
            .upsert({
                map_id: mapId,
                voter_id: voter.voterId,
                stars: stars,
                is_authed: !!voter.isAuthed,
                updated_at: new Date().toISOString()
            }, { onConflict: 'map_id,voter_id' });
        if (res.error) {
            console.log('[ratings] upsert failed:', res.error.message);
            return { wrote: false };
        }
        return { wrote: true };
    } catch (e) {
        console.log('[ratings] upsert error:', e.message);
        return { wrote: false };
    }
}

// Pull the aggregate view and fold it into { mapId: rating }. No-op ({}) when auth
// is disabled, so local dev simply has no ratings.
// Returns {mapId: rating} on success (possibly empty = genuinely no votes yet),
// or null on a READ ERROR so the caller can keep the last good summaries instead
// of wiping every aggregate + Favorites membership on a transient blip. Auth-off
// is a real (empty) success, not an error.
async function loadSummaries(config) {
    if (!auth.enabled || !auth.supabase) { return {}; }
    try {
        var res = await auth.supabase.from('map_rating_summary').select('*');
        if (res.error) {
            console.log('[ratings] summary read failed:', res.error.message);
            return null;
        }
        return summarize(res.data, config);
    } catch (e) {
        console.log('[ratings] summary read error:', e.message);
        return null;
    }
}

module.exports = {
    validStars: validStars,
    deriveVoter: deriveVoter,
    summarize: summarize,
    recordRating: recordRating,
    loadSummaries: loadSummaries
};
