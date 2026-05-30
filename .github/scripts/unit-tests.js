'use strict';

// Edge-case unit tests for the pure, side-effect-free helpers that the rest of
// the game leans on. These are the functions where a future refactor can quietly
// change a boundary (an off-by-one tier, a reordered compressor field, a dropped
// validation branch) and pass `node --check` + the build + even the smoke test —
// because the smoke test exercises the happy path with random input, not the
// edges. This suite pins the edges:
//
//   • utils.autoBotsForHumans   — triangular bot-fill tiers + clamps
//   • utils.validateStartEdges  — the 1/2-edge + opposite-pair rules
//   • utils.validateMap         — every structural rejection branch
//   • mapFormat round-trip      — toSitesOnly <-> reconstruct determinism + guards
//   • compressor wire layout    — array shape/order (client decoders are lockstep)
//   • utils math + hash + color — geometry helpers, cyrb53 bounds, color picker
//
// No network, no browser, no timers — just call the functions. Any failed
// assertion fails the run (exit 1), same convention as smoke-test.js.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

// --- tiny assertion harness -------------------------------------------------
let failures = 0;
let passed = 0;
let currentGroup = '';
const groupStats = [];

function group(name, fn) {
    currentGroup = name;
    const before = failures;
    const beforePass = passed;
    fn();
    groupStats.push({ name, pass: passed - beforePass, fail: failures - before });
}

function check(cond, label) {
    if (cond) { passed++; return; }
    failures++;
    console.log('::error::' + currentGroup + ': ' + label);
}

function eq(actual, expected, label) {
    check(actual === expected, label + ' (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')');
}

function approx(actual, expected, label, tol) {
    tol = tol == null ? 1e-9 : tol;
    check(Math.abs(actual - expected) <= tol, label + ' (got ' + actual + ', expected ~' + expected + ')');
}

function throws(fn, label) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    check(threw, label + ' (expected a throw)');
}

// ---------------------------------------------------------------------------
// utils.autoBotsForHumans — triangular tiers: bots = n where n(n+1)/2 >= humans,
// then a straight fill at 17+ humans, all clamped by capLeft.
// ---------------------------------------------------------------------------
group('autoBotsForHumans', function () {
    eq(utils.autoBotsForHumans(0, 10), 0, '0 humans => 0 bots');
    eq(utils.autoBotsForHumans(-5, 10), 0, 'negative humans => 0 bots');
    eq(utils.autoBotsForHumans(5, 0), 0, 'capLeft 0 => 0 bots regardless of humans');
    eq(utils.autoBotsForHumans(5, -3), 0, 'negative capLeft => 0 bots');

    // tier boundaries — every edge of every triangular band
    eq(utils.autoBotsForHumans(1, 10), 1, '1 human => 1');
    eq(utils.autoBotsForHumans(2, 10), 2, '2 humans => 2 (band start)');
    eq(utils.autoBotsForHumans(3, 10), 2, '3 humans => 2 (band end)');
    eq(utils.autoBotsForHumans(4, 10), 3, '4 humans => 3 (band start)');
    eq(utils.autoBotsForHumans(6, 10), 3, '6 humans => 3 (band end)');
    eq(utils.autoBotsForHumans(7, 10), 4, '7 humans => 4 (band start)');
    eq(utils.autoBotsForHumans(10, 10), 4, '10 humans => 4 (band end)');
    eq(utils.autoBotsForHumans(11, 10), 5, '11 humans => 5 (band start)');
    eq(utils.autoBotsForHumans(15, 10), 5, '15 humans => 5 (band end)');
    eq(utils.autoBotsForHumans(16, 10), 6, '16 humans => 6 (last triangular tier)');

    // 17+ => fill remaining slots
    eq(utils.autoBotsForHumans(17, 10), 10, '17 humans => fill capLeft');
    eq(utils.autoBotsForHumans(99, 4), 4, '99 humans => fill capLeft');

    // clamp: a tier that exceeds capLeft is capped
    eq(utils.autoBotsForHumans(16, 3), 3, 'tier 6 clamped to capLeft 3');
    eq(utils.autoBotsForHumans(1, 1), 1, 'tier 1 with capLeft 1');
});

// ---------------------------------------------------------------------------
// utils.validateStartEdges — 1 or 2 edges; a 2-edge set must be an OPPOSITE pair.
// ---------------------------------------------------------------------------
group('validateStartEdges', function () {
    ['left', 'right', 'top', 'bottom'].forEach(function (e) {
        check(utils.validateStartEdges([e]).valid, 'single edge "' + e + '" is valid');
    });
    check(utils.validateStartEdges(['left', 'right']).valid, 'left+right opposite pair valid');
    check(utils.validateStartEdges(['top', 'bottom']).valid, 'top+bottom opposite pair valid');
    check(utils.validateStartEdges(['right', 'left']).valid, 'order-independent: right+left valid');
    check(utils.validateStartEdges(['bottom', 'top']).valid, 'order-independent: bottom+top valid');

    check(!utils.validateStartEdges([]).valid, 'empty list invalid');
    check(!utils.validateStartEdges(['left', 'right', 'top']).valid, '3 edges invalid');
    check(!utils.validateStartEdges(['middle']).valid, 'unknown edge invalid');
    check(!utils.validateStartEdges(['left', 'left']).valid, 'repeated edge invalid');
    check(!utils.validateStartEdges(['left', 'top']).valid, 'adjacent (non-opposite) pair invalid');
    check(!utils.validateStartEdges(null).valid, 'null invalid');
    check(!utils.validateStartEdges('left').valid, 'non-array string invalid');
});

// ---------------------------------------------------------------------------
// utils.validateMap — the trust boundary before a preview room is built. Each
// branch here is a distinct rejection a crafted/corrupt map could hit.
// ---------------------------------------------------------------------------
group('validateMap', function () {
    const c = config;
    const goalCell = function () { return { site: { x: 0, y: 0 }, halfedges: [], id: c.tileMap.goal.id }; };

    eq(utils.validateMap(null, c).valid, false, 'null map rejected');
    eq(utils.validateMap({}, c).valid, false, 'no cells array rejected');
    eq(utils.validateMap({ cells: [] }, c).valid, false, 'empty cells rejected');
    eq(utils.validateMap({ cells: new Array(mapFormat.MAX_MAP_CELLS + 1) }, c).valid, false, 'over MAX_MAP_CELLS rejected');

    eq(utils.validateMap({ cells: [null] }, c).valid, false, 'null cell rejected');
    eq(utils.validateMap({ cells: [{ halfedges: [], id: 0 }] }, c).valid, false, 'cell with no site rejected');
    eq(utils.validateMap({ cells: [{ site: { x: NaN, y: 0 }, halfedges: [], id: 0 }] }, c).valid, false, 'NaN site x rejected');
    eq(utils.validateMap({ cells: [{ site: { x: 0, y: Infinity }, halfedges: [], id: 0 }] }, c).valid, false, 'Infinity site y rejected');
    eq(utils.validateMap({ cells: [{ site: { x: 0, y: 0 }, id: 0 }] }, c).valid, false, 'cell with no halfedges rejected');
    eq(utils.validateMap({ cells: [{ site: { x: 0, y: 0 }, halfedges: [], id: '6' }] }, c).valid, false, 'non-numeric tile id rejected');

    // no goal tile anywhere
    eq(utils.validateMap({ cells: [{ site: { x: 0, y: 0 }, halfedges: [], id: 0 }] }, c).valid, false, 'map without goal rejected');

    // hazard branches (these run before the reachability check, so a 1-cell map suffices)
    eq(utils.validateMap({ cells: [goalCell()], hazards: 'nope' }, c).valid, false, 'non-array hazards rejected');
    eq(utils.validateMap({ cells: [goalCell()], hazards: [{ id: 99999, x: 0, y: 0 }] }, c).valid, false, 'unknown hazard id rejected');
    eq(utils.validateMap({ cells: [goalCell()], hazards: [{ id: c.hazards.bumper.id, x: NaN, y: 0 }] }, c).valid, false, 'NaN hazard position rejected');
    eq(utils.validateMap({ cells: [goalCell()], hazards: [{ id: c.hazards.movingBumper.id, x: 0, y: 0 }] }, c).valid, false, 'moving bumper without angle rejected');
    check(utils.validateMap({ cells: [goalCell()], hazards: [{ id: c.hazards.movingBumper.id, x: 0, y: 0, angle: 45 }] }, c).valid !== undefined, 'moving bumper with angle reaches reachability check');

    // bad startEdges short-circuits before reachability
    eq(utils.validateMap({ cells: [goalCell()], startEdges: ['nope'] }, c).valid, false, 'invalid startEdges rejected');

    // happy path: every committed map (loaded + reconstructed at boot) must validate
    const maps = utils.loadMaps();
    let validCount = 0;
    for (let i = 0; i < maps.length; i++) {
        if (utils.validateMap(maps[i], c).valid) validCount++;
    }
    check(maps.length > 0, 'committed maps were loaded');
    eq(validCount, maps.length, 'all ' + maps.length + ' committed maps validate');
});

// ---------------------------------------------------------------------------
// mapFormat — sites-only <-> full geometry. Reconstruction must be deterministic
// (same cell count + ids) and must reject every degenerate input rather than feed
// garbage to the voronoi compute on the shared server process.
// ---------------------------------------------------------------------------
group('mapFormat', function () {
    eq(mapFormat.isSitesOnly({ sites: [], }), true, 'sites + no cells => sites-only');
    eq(mapFormat.isSitesOnly({ sites: [], cells: [] }), false, 'sites + cells => NOT sites-only (treat as full both sides)');
    eq(mapFormat.isSitesOnly({ cells: [] }), false, 'cells only => not sites-only');
    eq(mapFormat.isSitesOnly(null), false, 'null => not sites-only');

    // a clean, well-separated site set reconstructs deterministically
    const sitesMap = {
        bbox: { xl: 0, xr: 100, yt: 0, yb: 100 },
        sites: [{ x: 25, y: 25, id: 1 }, { x: 75, y: 25, id: config.tileMap.goal.id }, { x: 25, y: 75, id: 2 }, { x: 75, y: 75, id: 3 }],
        hazards: []
    };
    const full = mapFormat.reconstruct(sitesMap);
    eq(full.cells.length, 4, 'reconstruct produces one cell per site');

    // round-trip: full -> sites-only -> full preserves cell count and tile ids
    full.name = 'RoundTrip';
    full.author = 'tester';
    full.spawnPad = { x: 1, y: 2 };       // a non-geometry field that MUST survive
    full.thumbnail = 'data:image/jpeg;base64,AAAA'; // geometry-ish drop
    const compact = mapFormat.toSitesOnly(full);
    eq(compact.sites.length, 4, 'toSitesOnly keeps every site');
    eq(compact.name, 'RoundTrip', 'toSitesOnly carries metadata (name)');
    eq(compact.author, 'tester', 'toSitesOnly carries metadata (author)');
    eq(JSON.stringify(compact.spawnPad), JSON.stringify({ x: 1, y: 2 }), 'toSitesOnly carries unknown metadata field (spawnPad)');
    eq(compact.thumbnail, undefined, 'toSitesOnly drops the thumbnail (regenerated on demand)');
    eq(compact.cells, undefined, 'toSitesOnly drops the heavy geometry (cells)');

    const reFull = mapFormat.reconstruct(compact);
    eq(reFull.cells.length, full.cells.length, 'round-trip preserves cell count');
    const idsBefore = full.cells.map(function (cl) { return cl.id; }).sort().join(',');
    const idsAfter = reFull.cells.map(function (cl) { return cl.id; }).sort().join(',');
    eq(idsAfter, idsBefore, 'round-trip preserves the set of tile ids');

    // reconstruct guards — each must throw, not silently produce garbage
    throws(function () { mapFormat.reconstruct({ sites: [{ x: 0, y: 0 }] }); }, 'missing bbox throws');
    throws(function () { mapFormat.reconstruct({ bbox: sitesMap.bbox }); }, 'missing sites throws');
    throws(function () { mapFormat.reconstruct({ bbox: sitesMap.bbox, sites: new Array(mapFormat.MAX_MAP_CELLS + 1) }); }, 'too many sites throws');
    throws(function () { mapFormat.reconstruct({ bbox: { xl: 0, xr: NaN, yt: 0, yb: 100 }, sites: [] }); }, 'non-finite bbox throws');
    throws(function () { mapFormat.reconstruct({ bbox: { xl: 100, xr: 0, yt: 0, yb: 100 }, sites: [] }); }, 'inverted bbox (xr<=xl) throws');
    throws(function () { mapFormat.reconstruct({ bbox: sitesMap.bbox, sites: [{ x: NaN, y: 0 }] }); }, 'non-finite site coords throw');
    throws(function () {
        mapFormat.reconstruct({ bbox: sitesMap.bbox, sites: [{ x: 50, y: 50, id: 0 }, { x: 50, y: 50, id: 0 }] });
    }, 'duplicate site (degenerate, no cell) throws');
});

// ---------------------------------------------------------------------------
// compressor — the per-tick wire format. The client decoders in client.js /
// gameboard.js read these arrays purely by INDEX, so a reordered or resized
// field silently desyncs the client. Pin the shape + order here so any change
// to the layout trips this test (and the author updates the decoder in lockstep).
// ---------------------------------------------------------------------------
group('compressor', function () {
    const fakePlayer = {
        id: 'p1', x: 10, y: 20, velX: 1, velY: -2, angle: 90,
        stamina: 33.7, chargeFrac: 0.5, overcharge: 0.25,
        color: '#ff0000', alive: true, notches: 3, nearVictory: false,
        awake: true, onFire: false, name: null, title: null,
        avatarUrl: null, cartSkin: 'dino'
    };

    // per-tick player row
    const prow = compressor.sendPlayerUpdates({ p1: fakePlayer });
    check(Array.isArray(prow) && prow.length === 1, 'sendPlayerUpdates returns one row per player');
    eq(prow[0].length, 9, 'player row has 9 fields');
    eq(prow[0][0], 'p1', 'player[0] = id');
    eq(prow[0][1], 10, 'player[1] = x');
    eq(prow[0][2], 20, 'player[2] = y');
    eq(prow[0][3], 1, 'player[3] = velX');
    eq(prow[0][4], -2, 'player[4] = velY');
    eq(prow[0][5], 90, 'player[5] = angle');
    eq(prow[0][6], 34, 'player[6] = rounded stamina (33.7 -> 34)');
    eq(prow[0][7], 50, 'player[7] = chargeFrac*100');
    eq(prow[0][8], 25, 'player[8] = overcharge*100');

    // null/undefined charge fractions must not emit NaN onto the wire
    const noCharge = compressor.sendPlayerUpdates({ p1: { id: 'p', x: 0, y: 0, velX: 0, velY: 0, angle: 0, stamina: 0 } });
    eq(noCharge[0][7], 0, 'missing chargeFrac => 0, not NaN');
    eq(noCharge[0][8], 0, 'missing overcharge => 0, not NaN');

    // empty list => empty array (client maps over it)
    eq(compressor.sendPlayerUpdates({}).length, 0, 'empty player list => empty array');

    // proj / aimer / hazard row widths
    const projRow = compressor.sendProjUpdates({ a: { ownerId: 'o', type: 2, x: 1, y: 2 } });
    eq(projRow[0].length, 4, 'proj row has 4 fields [ownerId,type,x,y]');
    eq(projRow[0][1], 2, 'proj[1] = type');

    const aimRow = compressor.sendAimerUpdates({ a: { ownerId: 'o', targetListAry: ['x', 'y'], radius: 5, x: 1, y: 2 } });
    eq(aimRow[0].length, 5, 'aimer row has 5 fields');
    eq(aimRow[0][1], 'x,y', 'aimer[1] = targetListAry joined by comma');

    const hazRow = compressor.sendHazardUpdates({ a: { ownerId: 'o', x: 1, y: 2 } });
    eq(hazRow[0].length, 3, 'hazard row has 3 fields [ownerId,x,y]');

    // spawn/append packet (static fields, sent once)
    const spawn = JSON.parse(compressor.appendPlayer(fakePlayer));
    eq(spawn.length, 14, 'spawn packet has 14 fields');
    eq(spawn[0], 'p1', 'spawn[0] = id');
    eq(spawn[3], '#ff0000', 'spawn[3] = color');
    eq(spawn[4], true, 'spawn[4] = alive');
    eq(spawn[5], 3, 'spawn[5] = notches');
    eq(spawn[9], 90, 'spawn[9] = angle');
    eq(spawn[10], null, 'spawn[10] = name (null for humans)');
    eq(spawn[13], 'dino', 'spawn[13] = cartSkin');
});

// ---------------------------------------------------------------------------
// utils math + hash + color helpers.
// ---------------------------------------------------------------------------
group('utils math/hash/color', function () {
    // angle(): degrees in [0,360); +x => 0, +y => 90, -x => 180, -y => 270
    approx(utils.angle(0, 0, 10, 0), 0, 'angle to +x is 0deg');
    approx(utils.angle(0, 0, 0, 10), 90, 'angle to +y is 90deg');
    approx(utils.angle(0, 0, -10, 0), 180, 'angle to -x is 180deg');
    approx(utils.angle(0, 0, 0, -10), 270, 'angle to -y is 270deg');
    const aSame = utils.angle(5, 5, 5, 5);
    check(aSame >= 0 && aSame < 360 && !Number.isNaN(aSame), 'angle of a zero-length vector is finite in [0,360)');

    // pos(): walk `length` along `angle` degrees from a point
    const p0 = utils.pos({ x: 0, y: 0 }, 10, 0);
    approx(p0.x, 10, 'pos along 0deg moves +x'); approx(p0.y, 0, 'pos along 0deg keeps y');
    const p90 = utils.pos({ x: 0, y: 0 }, 10, 90);
    approx(p90.x, 0, 'pos along 90deg keeps x', 1e-6); approx(p90.y, 10, 'pos along 90deg moves +y');

    // magnitudes / dot / distance
    eq(utils.getMag(3, 4), 5, 'getMag(3,4) = 5');
    eq(utils.getMagSq(0, 0, 3, 4), 25, 'getMagSq = 25');
    eq(utils.getMag(0, 0), 0, 'getMag of zero vector is 0');
    eq(utils.dotProduct({ x: 1, y: 2 }, { x: 3, y: 4 }), 11, 'dotProduct = 11');
    eq(utils.dotProduct({ x: 1, y: 0 }, { x: 0, y: 1 }), 0, 'perpendicular dot = 0');
    approx(utils.distanceBetweenPoints({ x: 0, y: 0 }, { x: 3, y: 4 }), 5, 'distanceBetweenPoints = 5');

    // normalizedVectorFromAngle is unit-length for any angle
    const nv = utils.normalizedVectorFromAngle(Math.PI / 3);
    approx(Math.sqrt(nv.x * nv.x + nv.y * nv.y), 1, 'normalizedVectorFromAngle is unit length');

    // normalizedVectorFromPoint: unit-length for a real vector, and a SAFE zero
    // vector (not NaN) for a zero-length input — NaN here would corrupt a tick.
    const nvp = utils.normalizedVectorFromPoint({ x: 3, y: 4 });
    approx(Math.sqrt(nvp.x * nvp.x + nvp.y * nvp.y), 1, 'normalizedVectorFromPoint is unit length');
    const nvZero = utils.normalizedVectorFromPoint({ x: 0, y: 0 });
    check(nvZero.x === 0 && nvZero.y === 0, 'normalizedVectorFromPoint of zero vector is {0,0}, not NaN');
    check(!Number.isNaN(nvZero.x) && !Number.isNaN(nvZero.y), 'normalizedVectorFromPoint never emits NaN');

    // cyrb53 hash: deterministic, seed-sensitive, and bounded to a safe integer
    eq(utils.generateHash('chao', 0), utils.generateHash('chao', 0), 'hash is deterministic');
    check(utils.generateHash('chao', 0) !== utils.generateHash('chao', 1), 'hash varies with seed');
    check(utils.generateHash('a', 0) !== utils.generateHash('b', 0), 'hash varies with input');
    const hEmpty = utils.generateHash('', 0);
    check(Number.isSafeInteger(hEmpty) && hEmpty >= 0, 'hash of empty string is a non-negative safe integer');
    const hBig = utils.generateHash('a very long identifier string for hashing', 42);
    check(Number.isSafeInteger(hBig) && hBig >= 0, 'hash stays within MAX_SAFE_INTEGER');

    // getRandomInt: inclusive bounds, and min===max is a fixed point
    eq(utils.getRandomInt(7, 7), 7, 'getRandomInt(7,7) === 7');
    let inRange = true;
    for (let i = 0; i < 2000; i++) {
        const r = utils.getRandomInt(3, 5);
        if (r < 3 || r > 5 || !Number.isInteger(r)) { inRange = false; break; }
    }
    check(inRange, 'getRandomInt(3,5) stays in [3,5] over 2000 draws');
    // a swapped range must be normalized, not produce a value below min
    let swapInRange = true;
    for (let i = 0; i < 2000; i++) {
        const r = utils.getRandomInt(5, 3);
        if (r < 3 || r > 5 || !Number.isInteger(r)) { swapInRange = false; break; }
    }
    check(swapInRange, 'getRandomInt(5,3) (swapped) still stays in [3,5]');

    // getUniqueColor: palette pick when empty; avoids used + dodges look-alikes;
    // falls back to hsl() once the named palette is exhausted.
    const palette = utils.getColorPalette();
    check(palette.indexOf(utils.getUniqueColor({})) !== -1, 'empty room => a named palette color');
    const blue = '#4363d8', navy = '#000075';
    const pick = utils.getUniqueColor({ [blue]: true });
    check(pick !== blue, 'never re-hands a used color (Blue)');
    check(pick !== navy, 'avoids the perceptual look-alike (Navy) of a used Blue');
    check(palette.indexOf(pick) !== -1, 'pick is still a named palette color');
    const allUsed = {};
    palette.forEach(function (col) { allUsed[col] = true; });
    check(/^hsl\(/.test(utils.getUniqueColor(allUsed)), 'exhausted palette => hsl() fallback');
});

// ---------------------------------------------------------------------------
const total = passed + failures;
const summary = [
    '### Edge-case unit tests',
    '',
    failures ? ('❌ ' + failures + ' of ' + total + ' assertions failed') : ('✅ all ' + total + ' assertions passed'),
    '',
    '| group | pass | fail |',
    '| --- | --- | --- |',
].concat(groupStats.map(function (g) {
    return '| ' + g.name + ' | ' + g.pass + ' | ' + (g.fail ? '❌ ' + g.fail : '0') + ' |';
}));
console.log('\n' + summary.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
    try { require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n'); } catch (e) { }
}

if (failures > 0) {
    console.log('\nUnit tests FAILED with ' + failures + ' assertion failure(s).');
    process.exit(1);
}
console.log('\nUnit tests passed: ' + total + ' assertions across ' + groupStats.length + ' groups.');
process.exit(0);
