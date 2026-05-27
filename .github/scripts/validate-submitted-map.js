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
const GATE_DEPTH = 75;           // mirrors server/game.js GATE_DEPTH
const SIM_MAX_SECONDS = 90;      // playability sim budget ceiling (per attempt)
const SIM_ATTEMPTS = 3;          // retry with fresh bot RNG before giving up (AI is chaotic)
const PAR_MISMATCH_FRAC = 0.5;   // warn if embedded parTime drifts >50% from recompute

// Competing-lines analysis — uses the SAME pathing the AI racers use
// (server/aiController.js): cellGraph.findPathToNearestGoal with a per-racer
// noiseSeed for route diversity, a skill-derived noiseAmount, and a hazard-cell
// penalty set. We fix the seeds (the AI randomises them per bot) so the review
// artifact is reproducible across re-pushes.
const MAX_ROUTES = 3;
const AI_HAZARD_PENALTY = 12;                       // aiController HAZARD_PATH_PENALTY
const AI_SKILL = 0.7;                               // aiController default skill
const AI_NOISE = 0.15 + (1 - AI_SKILL) * 0.2;       // aiController noiseAmount formula
const ROUTE_SEEDS = [101, 211, 337, 449, 577, 691]; // fixed per-racer route-diversity seeds
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
const config = require(path.join(repoRoot, 'server', 'config.json'));
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const { renderMapToPng, ROUTE_COLORS } = require(path.join(__dirname, 'lib', 'render-map.js'));

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
function effectiveStartEdges(map) {
    // The edges to check reachability / sample origins from. deepValidate runs
    // utils.validateMap FIRST and gates this on v.valid, so any malformed startEdges
    // (bad length, unknown edge, repeat, non-opposite pair) has already been rejected
    // by validateStartEdges — we only apply the absent/empty => ["left"] default that
    // the engine's resolveStartEdges also applies. (We deliberately don't re-run the
    // engine's sanitisation here; by this point the array is already known-valid.)
    return (Array.isArray(map.startEdges) && map.startEdges.length > 0) ? map.startEdges : ['left'];
}

function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }

// Sample a handful of start positions along an edge's gate (inset from the edge
// and its ends), mirroring where racers actually gate. ~half of GATE_DEPTH in.
function gateOrigins(edge) {
    const W = config.worldWidth, H = config.worldHeight, IN = 40, N = 6;
    const lin = (a, b) => { const out = []; for (let i = 0; i < N; i++) { out.push(a + (b - a) * (i / (N - 1))); } return out; };
    switch (edge) {
        case 'right':  return lin(IN, H - IN).map(y => ({ x: W - IN, y }));
        case 'top':    return lin(IN, W - IN).map(x => ({ x, y: IN }));
        case 'bottom': return lin(IN, W - IN).map(x => ({ x, y: H - IN }));
        case 'left':
        default:       return lin(IN, H - IN).map(y => ({ x: IN, y }));
    }
}

// Cells holding a hazard, penalised in pathing exactly as the AI does (the
// nearest cell to each hazard — aiController's static-bumper branch). Returns a
// Set of voronoiIds, or null if the map has no hazards.
function buildHazardCells(map) {
    if (!Array.isArray(map.hazards) || map.hazards.length === 0) { return null; }
    const set = new Set();
    for (const hz of map.hazards) {
        if (!hz || !isFiniteNum(hz.x) || !isFiniteNum(hz.y)) { continue; }
        let bestI = -1, bestD = Infinity;
        for (let i = 0; i < map.cells.length; i++) {
            const c = map.cells[i];
            if (!c || !c.site) { continue; }
            const dx = c.site.x - hz.x, dy = c.site.y - hz.y, d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; bestI = i; }
        }
        if (bestI >= 0) { set.add(map.cells[bestI].site.voronoiId); }
    }
    return set.size ? set : null;
}

// A few DISTINCT competing lines a racer would take, using the AI's own path
// planner + cost model, each timed by the engine's physics-walk (estimatePathTime,
// the same routine that produces par time). Returns up to MAX_ROUTES, fastest
// first: [{ label, seconds, color, points:[{x,y}] }].
function competingPaths(map) {
    if (!Array.isArray(map.cells) || map.cells.length === 0) { return []; }
    const hazardCells = buildHazardCells(map);
    const siteById = {};
    for (const c of map.cells) { if (c && c.site) { siteById[c.site.voronoiId] = { x: c.site.x, y: c.site.y }; } }

    const origins = [];
    for (const edge of effectiveStartEdges(map)) { origins.push(...gateOrigins(edge)); }

    const cands = [];
    for (let i = 0; i < origins.length; i++) {
        let route;
        try {
            route = cellGraph.findPathToNearestGoal(map, origins[i], {
                noiseSeed: ROUTE_SEEDS[i % ROUTE_SEEDS.length],
                noiseAmount: AI_NOISE,
                penaltySet: hazardCells || undefined,
                penaltyMult: hazardCells ? AI_HAZARD_PENALTY : 1
            });
        } catch (e) { route = null; }
        if (route && Array.isArray(route.path) && route.path.length >= 2) {
            let secs = 0;
            try { secs = cellGraph.estimatePathTime(map, route.path) || 0; } catch (e) { secs = 0; }
            if (secs > 0) { cands.push({ path: route.path, seconds: secs }); }
        }
    }

    // Keep the fastest, then add only lines that are spatially distinct from the
    // ones already chosen (so we show genuinely different routes, not 6 near-copies).
    cands.sort((a, b) => a.seconds - b.seconds);
    const chosen = [];
    for (const c of cands) {
        const setC = new Set(c.path);
        let dup = false;
        for (const ch of chosen) {
            let inter = 0;
            for (const v of setC) { if (ch.set.has(v)) { inter++; } }
            const uni = setC.size + ch.set.size - inter;
            if (uni > 0 && inter / uni > ROUTE_DEDUPE_OVERLAP) { dup = true; break; }
        }
        if (!dup) { chosen.push({ path: c.path, seconds: c.seconds, set: setC }); }
        if (chosen.length >= MAX_ROUTES) { break; }
    }

    return chosen.map((c, i) => ({
        label: i === 0 ? 'Fastest line' : 'Alt ' + String.fromCharCode(64 + i), // Alt A, Alt B…
        seconds: +c.seconds.toFixed(1),
        color: ROUTE_COLORS[i % ROUTE_COLORS.length].name,
        points: c.path.map(id => siteById[id]).filter(Boolean)
    }));
}

function deepValidate(map) {
    const errors = [];
    const warnings = [];

    // Boundary check the live submit path runs (cells / goal tile / hazards, plus
    // start-edge reachability *when startEdges is set*).
    const v = utils.validateMap(map, config);
    if (!v.valid) { errors.push(v.reason); }

    // Reachability for the effective start edge(s). validateMap skips this when
    // startEdges is absent (every legacy map defaults to left), so a goal walled
    // off by lava from the left gate would otherwise pass. reachableFromEdge is
    // the same graph check the engine trusts for par time.
    if (v.valid && Array.isArray(map.cells)) {
        for (const edge of effectiveStartEdges(map)) {
            const reason = 'No goal is reachable from the ' + edge + ' start.';
            if (!cellGraph.reachableFromEdge(map, edge) && errors.indexOf(reason) === -1) {
                errors.push(reason);
            }
        }
    }

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
}
console.log('\nOverall: ' + (out.overallPass ? 'PASS' : 'REJECT') + ' (' + results.length + ' map(s))');
process.exit(out.overallPass ? 0 : 1);
