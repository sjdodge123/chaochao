'use strict';

// Phase 4 check: map star-rating logic (pure parts + the write gate).
//
// The DB I/O needs Supabase, but the parts most worth protecting are pure: who may
// vote (deriveVoter), what's a valid vote (validStars), and the weighted Bayesian
// aggregation (summarize). Also asserts recordRating is a no-op with auth/writes off
// (local dev) and that the Crowd Favorites filter keys off the rating. Exits 1 on any
// failure.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const ratings = require(path.join(repoRoot, 'server', 'ratings.js'));
const mapClassifier = require(path.join(repoRoot, 'server', 'mapClassifier.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok: ' + msg); }
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 0.01); }

// 1) validStars
(function () {
    const good = [1, 2, 3, 4, 5];
    const bad = [0, 6, -1, 3.5, '3', null, undefined, NaN];
    if (!good.every(ratings.validStars)) { fail('validStars rejected a 1-5 integer'); }
    else { ok('validStars accepts 1-5'); }
    if (bad.some(ratings.validStars)) { fail('validStars accepted an invalid value'); }
    else { ok('validStars rejects out-of-range / non-integer / wrong-type'); }
})();

// 2) deriveVoter — bot blocked, authed namespaced+weighted-flagged, guest namespaced
(function () {
    if (ratings.deriveVoter({ isAI: true, verifiedUserId: 'x' }) !== null) { fail('a bot was allowed to vote'); }
    else { ok('deriveVoter blocks bots'); }
    if (ratings.deriveVoter({}) !== null) { fail('an identity-less socket was allowed to vote'); }
    else { ok('deriveVoter blocks identity-less sockets'); }
    const a = ratings.deriveVoter({ verifiedUserId: 'uuid-1' });
    if (!a || a.voterId !== 'u:uuid-1' || a.isAuthed !== true) { fail('authed voter id/flag wrong'); }
    else { ok('deriveVoter: authed -> u:<uuid>, isAuthed=true'); }
    const g = ratings.deriveVoter({ deviceId: 'dev-9' });
    if (!g || g.voterId !== 'd:dev-9' || g.isAuthed !== false) { fail('guest voter id/flag wrong'); }
    else { ok('deriveVoter: guest -> d:<deviceId>, isAuthed=false'); }
    // authed takes precedence when both present
    const both = ratings.deriveVoter({ verifiedUserId: 'uuid-2', deviceId: 'dev-2' });
    if (!both || both.voterId !== 'u:uuid-2') { fail('authed should win over deviceId'); }
    else { ok('deriveVoter: authed wins when both ids present'); }
})();

// 3) summarize — weighting + Bayesian pull
(function () {
    const rows = [
        { map_id: 'A', guest_votes: 10, guest_sum: 40, authed_votes: 0, authed_sum: 0 }, // mean 4.0, fat
        { map_id: 'B', guest_votes: 0, guest_sum: 0, authed_votes: 2, authed_sum: 10 },   // mean 5.0, thin (authed x3)
        { map_id: 'C', guest_votes: 1, guest_sum: 1, authed_votes: 0, authed_sum: 0 }     // mean 1.0, thin
    ];
    const s = ratings.summarize(rows, config);
    if (!s.A || !s.B || !s.C) { fail('summarize dropped a map'); return; }
    // counts are raw head-counts (not weighted)
    if (s.A.count !== 10 || s.B.count !== 2 || s.C.count !== 1) { fail('summarize count wrong'); }
    else { ok('summarize: raw vote counts correct'); }
    // weighted means
    if (!approx(s.A.avg, 4.0) || !approx(s.B.avg, 5.0) || !approx(s.C.avg, 1.0)) { fail('weighted avg wrong'); }
    else { ok('summarize: weighted averages correct (authed x' + config.balance.ratingAuthedWeight + ')'); }
    // Bayesian pulls the thin high map DOWN below its 5.0 and the thin low map UP above 1.0
    if (!(s.B.bayesian < 5.0 && s.B.bayesian > s.A.bayesian)) { fail('Bayesian did not pull thin-high map sensibly (B=' + s.B.bayesian + ')'); }
    else { ok('summarize: thin 5-star map pulled below 5 but still tops (B=' + s.B.bayesian + ')'); }
    if (!(s.C.bayesian > 1.0)) { fail('Bayesian did not pull thin-low map up (C=' + s.C.bayesian + ')'); }
    else { ok('summarize: thin 1-star map pulled up toward the mean (C=' + s.C.bayesian + ')'); }
    // empty input is safe
    if (Object.keys(ratings.summarize([], config)).length !== 0) { fail('summarize([]) not empty'); }
    else { ok('summarize([]) is empty'); }
})();

// 4) recordRating is a no-op with auth/writes off (local dev), and rejects bad input
(async function () {
    const voter = { voterId: 'd:test', isAuthed: false };
    const r1 = await ratings.recordRating('mapX', voter, 5, config);
    if (r1.wrote !== false) { fail('recordRating wrote with auth/writes disabled'); }
    else { ok('recordRating is a no-op when auth/writes are off'); }
    const r2 = await ratings.recordRating('mapX', voter, 9, config); // invalid stars
    if (r2.wrote !== false) { fail('recordRating accepted invalid stars'); }
    else { ok('recordRating rejects invalid stars'); }

    // 5) Crowd Favorites filter keys off rating.bayesian
    const fav = (config.playlists || []).find(function (p) { return p.id === 'favorites'; });
    if (!fav) { fail('no favorites playlist in config'); }
    else {
        const hi = { dominantTrait: 'pure', traits: ['pure'], length: 'standard', tier: 'featured', balanceScore: 95, rating: { bayesian: 4.2 } };
        const lo = { dominantTrait: 'pure', traits: ['pure'], length: 'standard', tier: 'featured', balanceScore: 95, rating: { bayesian: 2.0 } };
        const none = { dominantTrait: 'pure', traits: ['pure'], length: 'standard', tier: 'featured', balanceScore: 95, rating: null };
        if (!mapClassifier.matches(hi, fav.filter)) { fail('favorites excluded a high-rated map'); }
        else { ok('favorites includes a map above the rating threshold'); }
        if (mapClassifier.matches(lo, fav.filter)) { fail('favorites included a low-rated map'); }
        else { ok('favorites excludes a map below the rating threshold'); }
        if (mapClassifier.matches(none, fav.filter)) { fail('favorites included an unrated map'); }
        else { ok('favorites excludes an unrated map (cold start)'); }
    }

    if (failures > 0) {
        console.log('\nratings-test FAILED with ' + failures + ' error(s)');
        process.exit(1);
    }
    console.log('\nratings-test passed');
})();
