'use strict';

// Map-submission review gate.
//
// Runs on the map JSON file(s) changed by a pull request (the in-browser editor
// opens these as auto-PRs from `mapchange-*` branches). It goes well beyond the
// shallow structural check the live submit path runs, and produces the artifacts
// the workflow posts back to the PR for a human to eyeball:
//
//   A. Deep static validation — reuses server utils.validateMap (cells / goal /
//      hazards / start-edge reachability when startEdges is set) and ADDS the
//      checks that matter for a stranger's submission: goal reachability from the
//      DEFAULT left start (validateMap skips reachability when startEdges is
//      absent — every legacy map), in-world bounds, finite coordinates, a cell
//      count cap (anti-DoS / anti-garbage), required author/name, and a par-time
//      recompute.
//   C. Playability sim — boots a real preview room with AI racers (the editor's
//      own play-test path) and ticks the live engine until a racer reaches the
//      goal. A throw/NaN mid-tick is a hard fail; reachable-but-not-scored is a
//      soft warning (could be AI flakiness, not the map), surfaced for the human.
//   Image — renders the map from the AUTHORITATIVE reconstructed cells
//      (render-map.js) for the reviewer to eyeball (e.g. inappropriate imagery).
//      Maps no longer carry an editor thumbnail, so there's nothing to compare.
//
// Writes <output>/result.json (machine-readable verdict, read by the workflow to
// build the PR comment) plus the two image files per map. Exits non-zero if any
// map hard-fails, but always writes result.json first so the workflow can still
// post the explanation + images on a rejection.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const OUTPUT_DIR = process.env.MAP_REVIEW_OUTPUT || path.join(repoRoot, 'map-review-out');

// --- tunables ---------------------------------------------------------------
const MAX_CELLS = 2500;          // largest committed map is 470; this is generous headroom
const SIM_MAX_SECONDS = 90;      // playability sim budget ceiling (per attempt)
const SIM_ATTEMPTS = 3;          // retry with fresh bot RNG before giving up (AI is chaotic)
const DIFFICULTY_WINDOWS = 8;    // 120s all-bot sim windows measuring perRoundFrac (same count as the balance sweep)
const PAR_MISMATCH_FRAC = 0.5;   // warn if embedded parTime drifts >50% from recompute

// Competing-lines analysis is delegated to mapClassifier.competingLines — the SAME
// fairness machinery that drives the editor's balance overlay and the `fairness`
// deduction (hazard-aware safe-seeded edge sampling + smoothed racing lines). The
// review artifact thus matches exactly what the author saw in the editor; the only
// knobs we pass are how many distinct lines to show and the "same line" threshold.
const MAX_ROUTES = 3;
const ROUTE_DEDUPE_OVERLAP = 0.6;                   // two routes sharing >60% of cells are "the same line"

const inputFiles = process.argv.slice(2).filter(f => f.endsWith('.json'));

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// --- phase 1: parse every changed map ourselves (clean errors, no require yet)
const parsed = []; // { file, name, map } or { file, fatal }
for (const file of inputFiles) {
    const abs = path.join(repoRoot, file);
    let map;
    try {
        map = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
        parsed.push({ file, fatal: 'Invalid JSON — ' + e.message });
        continue;
    }
    parsed.push({ file, map });
}

// Requiring the server modules also loads every committed map; safe once we know
// the changed files at least parse (a broken changed file is reported above).
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const cellGraph = require(path.join(repoRoot, 'server', 'cellGraph.js'));
const mapClassifier = require(path.join(repoRoot, 'server', 'mapClassifier.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const { renderMapToPng, ROUTE_COLORS } = require(path.join(__dirname, 'lib', 'render-map.js'));
const simWindow = require(path.join(__dirname, 'lib', 'sim-window.js'));

const DT = config.serverTickSpeed / 1000;

// Submitted maps are stored in the compact sites-only format; rebuild the full
// voronoi geometry so every check below (validateMap/cells, reachability, render,
// playability sim) sees a real map — exactly as loadMaps does at server boot. A
// cheap sites-count guard runs first so a crafted huge-sites payload can't make
// voronoi.compute churn; a reconstruct throw becomes a clean fatal for that map.
for (const entry of parsed) {
    if (entry.fatal || !mapFormat.isSitesOnly(entry.map)) { continue; }
    if (!Array.isArray(entry.map.sites) || entry.map.sites.length > MAX_CELLS) {
        entry.fatal = 'Too many sites (' + (Array.isArray(entry.map.sites) ? entry.map.sites.length : 0) + ' > ' + MAX_CELLS + ').';
        continue;
    }
    try { entry.map = mapFormat.reconstruct(entry.map); }
    catch (e) { entry.fatal = 'Map geometry could not be reconstructed from its sites: ' + e.message; }
}

// io stand-in so the playability sim's room emits (bot joins, etc.) don't throw
// in this no-network harness — same stub the smoke test uses.
messenger.build({ to() { return { emit() { } }; }, sockets: { emit() { } } });

// --- helpers ----------------------------------------------------------------
function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }

// A few DISTINCT competing lines a racer would take. Delegated to
// mapClassifier.competingLines so the review uses the EXACT fairness machinery the
// editor's balance overlay and the `fairness` deduction use (hazard-aware,
// safe-seeded edge sampling + smoothed racing lines) — keeping the two in lockstep
// instead of a parallel re-implementation. We only add the display layer here
// (fastest-first labels + a colour per line). Returns up to MAX_ROUTES, fastest
// first: [{ label, seconds, color, points:[{x,y}] }].
function competingPaths(map) {
    const lines = mapClassifier.competingLines(map, config, {
        maxRoutes: MAX_ROUTES,
        dedupeOverlap: ROUTE_DEDUPE_OVERLAP
    });
    return lines.map((ln, i) => ({
        label: i === 0 ? 'Fastest line' : 'Alt ' + String.fromCharCode(64 + i), // Alt A, Alt B…
        seconds: +ln.seconds.toFixed(1),
        color: ROUTE_COLORS[i % ROUTE_COLORS.length].name,
        points: ln.points
    }));
}

function deepValidate(map) {
    const errors = [];
    const warnings = [];

    // Boundary check the live submit path runs (cells / goal tile / hazards). This
    // is the SAME engine the in-editor submit/preview reject on and the fairness
    // overlay routes through: utils.validateMap → cellGraph.firstUnreachableStartEdge
    // already proves a goal is reachable from every EFFECTIVE start edge (declared
    // startEdges, or the left gate when none are set), barrier-aware. So there is no
    // separate reachability pass here any more — the three surfaces share one check.
    const v = utils.validateMap(map, config);
    if (!v.valid) { errors.push(v.reason); }

    // Bounds + finiteness + cell cap (only meaningful once we know cells exist).
    if (Array.isArray(map.cells)) {
        if (map.cells.length > MAX_CELLS) {
            errors.push('Too many cells (' + map.cells.length + ' > ' + MAX_CELLS + ').');
        }
        const W = config.worldWidth, H = config.worldHeight, M = 5;
        let oob = 0, nonFinite = 0;
        for (const cell of map.cells) {
            if (cell == null || cell.site == null) { continue; }
            const sx = cell.site.x, sy = cell.site.y;
            if (!isFiniteNum(sx) || !isFiniteNum(sy)) { nonFinite++; continue; }
            if (sx < -M || sx > W + M || sy < -M || sy > H + M) { oob++; }
            if (Array.isArray(cell.halfedges)) {
                for (const he of cell.halfedges) {
                    if (he && he.edge) {
                        for (const vtx of [he.edge.va, he.edge.vb]) {
                            if (vtx && (!isFiniteNum(vtx.x) || !isFiniteNum(vtx.y))) { nonFinite++; }
                        }
                    }
                }
            }
        }
        if (nonFinite > 0) { errors.push(nonFinite + ' coordinate(s) are not finite numbers (NaN/Infinity).'); }
        if (oob > 0) { errors.push(oob + ' cell(s) sit outside the ' + W + '×' + H + ' world bounds.'); }
    }

    // Submission metadata. The live submit path requires all three; the committed
    // file should carry name + author (hard) and email (soft — the lobby tutorial
    // map legitimately omits it and isn't a user submission).
    if (!map.name || String(map.name).trim() === '') { errors.push('Map is missing a name.'); }
    if (!map.author || String(map.author).trim() === '') { errors.push('Map is missing an author.'); }
    if (!map.email || String(map.email).trim() === '') { warnings.push('Map has no submitter email.'); }

    // Par-time recompute (informational + drift warning).
    let parTime = 0;
    try { parTime = cellGraph.computeMapParTime(map) || 0; } catch (e) { warnings.push('Par-time recompute failed: ' + e.message); }
    if (parTime > 0 && isFiniteNum(map.parTime) && map.parTime > 0) {
        const drift = Math.abs(map.parTime - parTime) / parTime;
        if (drift > PAR_MISMATCH_FRAC) {
            warnings.push('Embedded parTime (' + map.parTime.toFixed(1) + 's) differs >' +
                (PAR_MISMATCH_FRAC * 100) + '% from recompute (' + parTime.toFixed(1) + 's).');
        }
    }

    return { errors, warnings, parTime };
}

// One playability attempt: boot a real preview room with AI racers and tick the
// live engine until a racer reaches the goal or the budget elapses.
function playabilityAttempt(game, map, maxTicks) {
    const sig = 'mapreview-' + Math.random().toString(36).slice(2);
    let room = null;
    try {
        room = game.getRoom(sig, config.maxPlayersInRoom || 8);
        room.game.gameBoard.isPreview = true;
        room.game.gameBoard.previewMap = map;
        room.game.gameBoard.previewAI = true; // line 676: preview rooms fill bots only when opted in

        // One idle human so fillGridWithBots engages (it no-ops with zero humans).
        const hid = sig + '-human';
        const human = room.world.createNewPlayer(hid);
        room.playerList[hid] = human;
        room.game.determineGameState(human);

        room.game.startLobby();  // world.resize() builds the engine quadTree
        room.game.startGated();  // bots fill the grid here
        room.game.startRace();

        let bots = 0;
        for (const id in room.playerList) { if (room.playerList[id].isAI) { bots++; } }

        let scoredAt = -1;
        for (let f = 0; f < maxTicks; f++) {
            room.update(DT);
            let scored = false;
            for (const id in room.playerList) {
                if (room.playerList[id].reachedGoal) { scored = true; break; }
            }
            if (scored) { scoredAt = f; break; }
            // The race can conclude (everyone dead/overview) before anyone scores.
            if (room.game.currentState === config.stateMap.overview ||
                room.game.currentState === config.stateMap.gameOver) { break; }
        }
        return { scored: scoredAt >= 0, seconds: scoredAt >= 0 ? +(scoredAt * DT).toFixed(1) : null, bots };
    } finally {
        // game.getRoom() constructs a standalone Room — it is NOT added to the hostess
        // registry — so dropping our reference is enough for GC; there's no cross-map
        // room collision. We clear playerList defensively to release the bot objects.
        if (room) { try { for (const id in room.playerList) { delete room.playerList[id]; } } catch (e) { /* best effort */ } }
    }
}

// Retry the attempt with fresh bot RNG before reporting a no-score: the racing
// brain is chaotic, so a single bad run isn't evidence the map is broken (static
// reachability already proved a goal IS reachable). Any THROW is fatal, though —
// that means the map breaks the engine, which is the real thing this catches.
function playabilitySim(map, parTime) {
    const game = require(path.join(repoRoot, 'server', 'game.js'));
    const budgetSec = Math.min(SIM_MAX_SECONDS, Math.max(30, (parTime || 0) * 6));
    const maxTicks = Math.ceil(budgetSec / DT);
    let last = null;
    try {
        for (let a = 0; a < SIM_ATTEMPTS; a++) {
            last = playabilityAttempt(game, map, maxTicks);
            if (last.scored) { break; }
        }
        return { scored: last.scored, seconds: last.seconds, bots: last.bots, budgetSec, attempts: SIM_ATTEMPTS };
    } catch (e) {
        return { scored: false, error: e.message + '\n' + e.stack };
    }
}

// Difficulty measurement for the match-phase map ramp. The methodology (all-bot
// 6-racer windows, mocked clock, seeded RNG — the balance sweep behind
// server/mapDifficulty.json) lives in lib/sim-window.js, SHARED with the
// catalog-wide regenerator so a submission is measured on the same ruler as the
// shipped data; the tier is graded by the same mapClassifier ladder the live
// server uses. Until the entry is added the map plays via the classifier's
// geometry heuristic, so this is data hygiene, not a gate — any failure here is
// a warning, never a rejection.
function difficultySim(map) {
    const game = require(path.join(repoRoot, 'server', 'game.js'));
    const m = simWindow.measurePerRoundFrac(game, config, map, DIFFICULTY_WINDOWS);
    if (m == null) { return null; }
    return {
        perRoundFrac: m.perRoundFrac,
        tier: mapClassifier.gradeDifficultyFrac(m.perRoundFrac, config),
        rounds: m.rounds,
        key: mapClassifier.difficultyKey(map.name)
    };
}

function safeName(file) {
    return path.basename(file).replace(/\.json$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

// --- run --------------------------------------------------------------------
ensureDir(OUTPUT_DIR);
const results = [];
let hardFail = false;

for (const entry of parsed) {
    // Prefix with the input index so two maps whose names collide after
    // safeName() sanitisation (e.g. "cool map" vs "cool+map") still get distinct
    // image files instead of silently overwriting each other.
    const name = results.length + '-' + safeName(entry.file);
    const outBase = path.join(OUTPUT_DIR, name);
    const result = { file: entry.file, mapName: null, verdict: 'reject', errors: [], warnings: [], parTime: 0, sim: null, serverImage: null, routes: [], routeImage: null };

    if (entry.fatal) {
        result.errors.push(entry.fatal);
        results.push(result);
        hardFail = true;
        continue;
    }

    const map = entry.map;
    result.mapName = map.name || '(unnamed)';

    const dv = deepValidate(map);
    result.errors = dv.errors;
    result.warnings = dv.warnings;
    result.parTime = dv.parTime;

    // Authoritative map image, rendered even on failure — the reviewer wants to
    // SEE a rejected map (e.g. to confirm it's spam/abuse, not a near-miss).
    try {
        const png = renderMapToPng(map, config, { width: 683 });
        const f = outBase + '.server.png';
        fs.writeFileSync(f, png);
        result.serverImage = path.basename(f);
    } catch (e) {
        result.warnings.push('Server render failed: ' + e.message);
    }

    // Competing-lines analysis + trail-overlay image (valid maps only — the routes
    // give a feel for how competitive the map is: tight times = many viable lines).
    if (result.errors.length === 0) {
        try {
            const routes = competingPaths(map);
            result.routes = routes.map(r => ({ label: r.label, seconds: r.seconds, color: r.color }));
            if (routes.length > 0) {
                // Draw slowest-first so the fastest line ends up on top.
                const overlay = routes.slice().reverse().map(r => {
                    const col = ROUTE_COLORS.find(c => c.name === r.color) || ROUTE_COLORS[0];
                    return { points: r.points, rgb: col.rgb };
                });
                const png = renderMapToPng(map, config, { width: 683, routes: overlay });
                const f = outBase + '.routes.png';
                fs.writeFileSync(f, png);
                result.routeImage = path.basename(f);
            }
        } catch (e) {
            result.warnings.push('Competing-paths analysis failed: ' + e.message);
        }
    }

    // Playability sim only when static validation passed (no point racing a map
    // we've already rejected; and a malformed map could throw misleadingly).
    if (result.errors.length === 0) {
        const sim = playabilitySim(map, dv.parTime);
        result.sim = sim;
        if (sim.error) {
            result.errors.push('Engine threw while playing the map: ' + sim.error.split('\n')[0]);
            hardFail = true;
        } else if (!sim.scored) {
            result.warnings.push('No racer reached the goal within ' + sim.budgetSec + 's of simulation ' +
                '(map is graph-reachable, so this may be AI flakiness — worth a manual look).');
        }
        // Difficulty-ramp measurement (estimate) — only when the engine survives
        // the map. Failure to measure is a warning, never a rejection: an
        // unmeasured map simply plays via the classifier's geometry heuristic.
        if (!sim.error) {
            try {
                result.difficulty = difficultySim(map);
                if (result.difficulty == null) {
                    result.warnings.push('Difficulty measurement produced no usable rounds — the map will use the geometry-heuristic tier until server/mapDifficulty.json gets an entry.');
                }
            } catch (e) {
                result.warnings.push('Difficulty measurement threw (' + e.message.split('\n')[0] + ') — the map will use the geometry-heuristic tier.');
            }
        }
    }

    result.verdict = result.errors.length === 0 ? 'pass' : 'reject';
    if (result.verdict === 'reject') { hardFail = true; }
    results.push(result);
}

const out = { generatedAt: new Date().toISOString(), overallPass: !hardFail, maps: results };
fs.writeFileSync(path.join(OUTPUT_DIR, 'result.json'), JSON.stringify(out, null, 2));

// Human-readable console summary (CI log).
for (const r of results) {
    console.log('\n=== ' + r.file + ' (' + r.mapName + ') -> ' + r.verdict.toUpperCase() + ' ===');
    for (const e of r.errors) { console.log('::error file=' + r.file + '::' + e); }
    for (const w of r.warnings) { console.log('  warning: ' + w); }
    if (r.routes && r.routes.length) {
        console.log('  competing lines: ' + r.routes.map(x => x.label + ' ' + x.seconds + 's').join(', '));
    }
    if (r.sim && !r.sim.error) {
        console.log('  sim: ' + (r.sim.scored ? ('racer reached goal in ' + r.sim.seconds + 's') : 'no score') +
            ' (' + r.sim.bots + ' bots, par ' + r.parTime.toFixed(1) + 's)');
    }
    if (r.difficulty) {
        console.log('  difficulty: ' + r.difficulty.tier + ' (perRoundFrac ~' + r.difficulty.perRoundFrac +
            ' over ' + r.difficulty.rounds + ' rounds / ' + DIFFICULTY_WINDOWS + ' windows) — add to ' +
            'server/mapDifficulty.json perRoundFrac: "' + r.difficulty.key + '": ' + r.difficulty.perRoundFrac);
    }
}
console.log('\nOverall: ' + (out.overallPass ? 'PASS' : 'REJECT') + ' (' + results.length + ' map(s))');
process.exit(out.overallPass ? 0 : 1);
