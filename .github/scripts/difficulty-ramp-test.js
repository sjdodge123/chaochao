'use strict';

// Difficulty-ramped map selection check.
//
// Exercises GameBoard's selection methods (determineNextMap / difficultyPhase /
// pickByDifficultyWeight) directly against the REAL classified map pool, the
// same way playlist-selection-test.js does — no full room/world boot (the
// selection logic reads none of it) and no timers (selection is synchronous,
// so the smoke-test Date.now/setTimeout clock mock isn't needed here).
//
// Simulates many 8-round matches and asserts the phase distribution:
//   - rounds 1-2 ("early") NEVER draw a brutal-tier map and skew easy,
//   - mid-match draws stay approximately uniform (today's behavior),
//   - once a player is at match point ("late"), draws skew hard/brutal,
//   - a single-map playlist still draws (all-zero weights fall back to uniform),
//   - the preview path and no-repeat cycling are untouched,
//   - disabling the ramp restores the uniform draw.
//
// Deliberately DATA-DRIVEN: tier expectations come from server/mapDifficulty.json
// + the live cutoffs, and distribution thresholds are computed from the actual
// pool's tier mix and the configured weights — so adding/renaming/re-measuring
// maps never breaks this test unless the ramp itself misbehaves. Any failure
// exits 1.

const fs = require('fs');
const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
// Require game.js first so the game<->gameBoard circular dependency fully resolves
// before we destructure GameBoard (otherwise it can be undefined mid-cycle).
require(path.join(repoRoot, 'server', 'game.js'));
const { GameBoard } = require(path.join(repoRoot, 'server', 'entities', 'gameBoard.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const mapClassifier = require(path.join(repoRoot, 'server', 'mapClassifier.js'));
const config = utils.loadConfig();
const mapDifficulty = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'mapDifficulty.json'), 'utf8'));

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok: ' + msg); }
function pct(n, d) { return d > 0 ? Math.round(n / d * 1000) / 10 : 0; }

const fullMaps = utils.loadMaps().filter(function (m) { return !m.lobbyOnly; });
// Selection only reads id + meta; determineNextMap deep-copies the chosen map,
// so handing boards the full hydrated geometry costs ~4ms per draw across the
// ~19k draws below (>1min of CI). Slim stubs keep the assertions identical.
const slimMaps = fullMaps.map(function (m) { return { id: m.id, name: m.name, meta: m.meta }; });
const byId = {};
slimMaps.forEach(function (m) { byId[m.id] = m; });
function tierOf(id) { return byId[id] && byId[id].meta && byId[id].meta.difficulty; }

// A minimal GameBoard with only the fields the selection logic reads.
function makeBoard(playlistId) {
    const gb = Object.create(GameBoard.prototype);
    gb.maps = slimMaps;
    gb.mapsPlayed = [];
    gb.isPreview = false;
    gb.previewMap = null;
    gb.playlistId = playlistId || 'all';
    gb.round = 0;
    gb.playerList = { p1: { nearVictory: false }, p2: { nearVictory: false } };
    return gb;
}
function draw(gb) {
    const id = gb.determineNextMap();
    gb.round++;             // mimic loadNextMap recording the round + played map
    gb.mapsPlayed.push(id);
    return id;
}

// Pool tier counts + the share of draws each tier should get under a weights row
// (weighted) or under uniform (weights all 1).
const poolCount = { easy: 0, mid: 0, hard: 0, brutal: 0 };
slimMaps.forEach(function (m) { poolCount[m.meta.difficulty]++; });
const poolTotal = slimMaps.length;
function expectedShare(row, tiers) {
    let want = 0, total = 0;
    Object.keys(poolCount).forEach(function (t) {
        const w = (row && typeof row[t] === 'number') ? row[t] : 1;
        total += w * poolCount[t];
        if (tiers.indexOf(t) !== -1) { want += w * poolCount[t]; }
    });
    return total > 0 ? want / total : 0;
}
const W = config.difficultyRamp.weights;

// 1) Tier sanity, derived from the shipped data (not hardcoded names): every
//    measured non-artifact map must classify to the grade of its own frac, and
//    AI-artifact maps must never infer brutal from sim data.
(function () {
    let checked = 0, untiered = 0;
    const artifacts = mapDifficulty.aiArtifacts || [];
    fullMaps.forEach(function (m) {
        const t = m.meta && m.meta.difficulty;
        if (poolCount[t] == null) { untiered++; return; }
        const key = mapClassifier.difficultyKey(m.name);
        const frac = (mapDifficulty.perRoundFrac || {})[key];
        if (artifacts.indexOf(key) !== -1) {
            if (t === 'brutal') { fail(m.name + ' is an AI-artifact map and must not infer brutal from sim data'); }
            return;
        }
        if (typeof frac === 'number') {
            checked++;
            const want = mapClassifier.gradeDifficultyFrac(frac, config);
            if (t !== want) { fail(m.name + ': meta.difficulty ' + t + ' != ' + want + ' (frac ' + frac + ')'); }
        }
    });
    if (untiered > 0) { fail(untiered + ' map(s) have no/unknown meta.difficulty'); }
    if (checked === 0) { fail('no measured maps found — mapDifficulty.json keys match no map names?'); }
    if (failures === 0) {
        ok('all ' + fullMaps.length + ' maps tiered ' + JSON.stringify(poolCount) + '; ' + checked +
            ' measured maps match their frac grade; ' + artifacts.length + ' artifacts excluded');
    }
    if (poolCount.brutal === 0 || poolCount.easy === 0) {
        fail('pool has no ' + (poolCount.brutal === 0 ? 'brutal' : 'easy') + ' maps — distribution assertions below are meaningless; re-check mapDifficulty.json');
    }
})();

// 2) Simulate many matches: rounds 1-2 fresh lobby, player hits match point
//    before rounds 7-8. Collect tier counts per phase bucket and compare to the
//    shares the configured weights predict for THIS pool.
(function () {
    const MATCHES = 1500;
    const buckets = {
        early: { easy: 0, mid: 0, hard: 0, brutal: 0, n: 0 },
        late: { easy: 0, mid: 0, hard: 0, brutal: 0, n: 0 }
    };
    for (let m = 0; m < MATCHES; m++) {
        const gb = makeBoard('all');
        for (let r = 1; r <= 8; r++) {
            if (r === 7) { gb.playerList.p1.nearVictory = true; }
            const t = tierOf(draw(gb));
            const bucket = r <= 2 ? buckets.early : (r >= 7 ? buckets.late : null);
            if (bucket) { bucket[t]++; bucket.n++; }
        }
    }
    const e = buckets.early, l = buckets.late;
    console.log('  early rounds (1-2): easy ' + pct(e.easy, e.n) + '% mid ' + pct(e.mid, e.n) +
        '% hard ' + pct(e.hard, e.n) + '% brutal ' + pct(e.brutal, e.n) + '%');
    console.log('  late rounds (match point): easy ' + pct(l.easy, l.n) + '% mid ' + pct(l.mid, l.n) +
        '% hard ' + pct(l.hard, l.n) + '% brutal ' + pct(l.brutal, l.n) + '%');
    // Brutal weight is 0 in the early row, and the full pool always has a
    // positive-weight map unplayed in rounds 1-2 — so this is exact, not statistical.
    if (e.brutal > 0) { fail('early rounds drew a brutal-tier map ' + e.brutal + '/' + e.n + ' times (must be 0)'); }
    else { ok('rounds 1-2 never draw a brutal map (' + e.n + ' draws)'); }
    // Distribution margins: ±8pp of the weight-predicted share (no-repeat
    // sampling without replacement inside a match skews a few pp; binomial noise
    // at n=3000 is <1pp).
    const MARGIN = 0.08;
    const earlyEasyWant = expectedShare(W.early, ['easy']);
    if (Math.abs(e.easy / e.n - earlyEasyWant) > MARGIN) {
        fail('early easy share ' + pct(e.easy, e.n) + '% is >' + (MARGIN * 100) + 'pp from the weight-predicted ' + Math.round(earlyEasyWant * 100) + '%');
    } else {
        ok('rounds 1-2 skew easy (' + pct(e.easy, e.n) + '% vs predicted ' + Math.round(earlyEasyWant * 100) + '%, uniform ' + Math.round(poolCount.easy / poolTotal * 100) + '%)');
    }
    const lateHardWant = expectedShare(W.late, ['hard', 'brutal']);
    const lateHard = (l.hard + l.brutal) / l.n;
    if (Math.abs(lateHard - lateHardWant) > MARGIN) {
        fail('match-point hard+brutal share ' + Math.round(lateHard * 100) + '% is >' + (MARGIN * 100) + 'pp from the weight-predicted ' + Math.round(lateHardWant * 100) + '%');
    } else {
        ok('match-point draws skew hard+brutal (' + Math.round(lateHard * 100) + '% vs predicted ' + Math.round(lateHardWant * 100) + '%, uniform ' + Math.round((poolCount.hard + poolCount.brutal) / poolTotal * 100) + '%)');
    }
    const lateEasyWant = expectedShare(W.late, ['easy']);
    if (l.easy / l.n > lateEasyWant + MARGIN) {
        fail('match-point draws are still ' + pct(l.easy, l.n) + '% easy (predicted ' + Math.round(lateEasyWant * 100) + '%)');
    } else { ok('match-point draws shed easy maps (' + pct(l.easy, l.n) + '%)'); }
})();

// 3) Mid-match (no one near victory, past the early rounds) stays approximately
//    uniform — fresh boards so no-repeat consumption can't bias the sample.
(function () {
    const N = 4000;
    const counts = { easy: 0, mid: 0, hard: 0, brutal: 0 };
    for (let i = 0; i < N; i++) {
        const gb = makeBoard('all');
        gb.round = 3;
        counts[tierOf(draw(gb))]++;
    }
    let worst = 0, worstTier = '';
    Object.keys(counts).forEach(function (t) {
        const dev = Math.abs(counts[t] / N - poolCount[t] / poolTotal);
        if (dev > worst) { worst = dev; worstTier = t; }
    });
    if (worst > 0.05) {
        fail('mid-match draw drifted from uniform: ' + worstTier + ' off by ' + Math.round(worst * 1000) / 10 + 'pp over ' + N + ' draws');
    } else {
        ok('mid-match draws ~uniform (worst tier deviation ' + Math.round(worst * 1000) / 10 + 'pp over ' + N + ' draws)');
    }
})();

// 4) A single-map pool still draws — even a brutal map in the early phase
//    (all-zero weight row falls back to uniform; repeat unavoidable on size 1).
(function () {
    const brutalMap = slimMaps.find(function (m) { return m.meta.difficulty === 'brutal'; });
    const gb = makeBoard('all');
    gb.maps = [brutalMap];
    for (let r = 0; r < 3; r++) {
        const id = draw(gb);
        if (id !== brutalMap.id) { fail('single-map pool draw ' + r + ' returned ' + id + ' instead of the only map'); return; }
    }
    ok('single brutal-map pool keeps drawing in the early phase (uniform fallback)');
})();

// 5) Preview path is untouched by the ramp in every phase.
(function () {
    const gb = makeBoard('all');
    gb.isPreview = true;
    gb.previewMap = JSON.parse(JSON.stringify(slimMaps.find(function (m) { return m.meta.difficulty === 'brutal'; })));
    const phases = [function () { gb.round = 0; }, function () { gb.round = 5; }, function () { gb.playerList.p1.nearVictory = true; }];
    let bad = 0;
    phases.forEach(function (setup) { setup(); if (gb.determineNextMap() !== gb.previewMap.id) { bad++; } });
    if (bad > 0) { fail('preview map was not re-selected in ' + bad + ' phase(s)'); }
    else { ok('preview path always returns the injected map, all phases'); }
})();

// 6) Wildcard playlist (default) composes with the ramp: early draws still
//    never land on a brutal map, and picks stay eligible.
(function () {
    let brutalEarly = 0;
    for (let i = 0; i < 1000; i++) {
        const gb = makeBoard('default');
        if (tierOf(draw(gb)) === 'brutal') { brutalEarly++; }
    }
    if (brutalEarly > 0) { fail('wildcard playlist drew brutal in round 1 ' + brutalEarly + '/1000 times'); }
    else { ok('wildcard (default) playlist: 1000 round-1 draws, zero brutal'); }
})();

// 7) No-repeat cycling still holds with the ramp active.
(function () {
    const gb = makeBoard('all');
    gb.round = 3;
    let last = null, repeats = 0;
    for (let i = 0; i < 200; i++) {
        const id = gb.determineNextMap();
        gb.mapsPlayed.push(id);
        if (id === last) { repeats++; }
        last = id;
    }
    if (repeats > 0) { fail(repeats + ' back-to-back repeats with the ramp active'); }
    else { ok('no back-to-back repeats over 200 ramped draws'); }
})();

// 8) Killing the enabled flag restores plain uniform (brutal can appear round 1).
(function () {
    const saved = config.difficultyRamp.enabled;
    config.difficultyRamp.enabled = false;
    let brutalEarly = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
        const gb = makeBoard('all');
        if (tierOf(draw(gb)) === 'brutal') { brutalEarly++; }
    }
    config.difficultyRamp.enabled = saved;
    // Expect ~poolShare; accept anything above a third of it (binomial noise floor).
    const floor = Math.floor(poolCount.brutal / poolTotal * N / 3);
    if (brutalEarly < floor) { fail('ramp disabled but round-1 brutal draws were still suppressed (' + brutalEarly + '/' + N + ', expected ~' + Math.round(poolCount.brutal / poolTotal * N) + ')'); }
    else { ok('difficultyRamp.enabled=false restores uniform draws (' + brutalEarly + '/' + N + ' round-1 brutal)'); }
})();

if (failures > 0) {
    console.log('\ndifficulty-ramp-test FAILED with ' + failures + ' error(s)');
    process.exit(1);
}
console.log('\ndifficulty-ramp-test passed');
