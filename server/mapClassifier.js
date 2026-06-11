'use strict';

// Boot-time map classifier. Derives a `meta` object from a map's GEOMETRY
// (deterministic, no telemetry) the same way par-time is derived in
// utils.loadMaps(). Two outputs matter downstream:
//
//   - character tags (length / dominantTrait) — power the themed playlists.
//   - a balanceScore + tier (featured|community) — the auto-quality gate.
//
// Featured = "balanced, fair, sensible-length" maps; everything else is still
// playable, it just routes to a themed or Wild playlist instead of being
// rejected. The same score drives the editor's soft submit-warning, so authors
// see exactly which deduction sank their map.
//
// Thresholds live in config.balance so they're tunable without a code change;
// every read falls back to a sane default so an older/partial config still
// classifies. See docs/spikes/map-playlists-and-ratings.md for the rationale.

var cellGraph = require('./cellGraph.js');

// Resolve a tileMap name -> numeric id from the live config (don't hardcode).
function tileId(config, name) {
    var t = config && config.tileMap && config.tileMap[name];
    return (t && typeof t.id === 'number') ? t.id : -1;
}

function bal(config, key, dflt) {
    var b = config && config.balance;
    return (b && b[key] != null) ? b[key] : dflt;
}

function startEdgesOf(map) {
    return (Array.isArray(map.startEdges) && map.startEdges.length > 0) ? map.startEdges : ['left'];
}

// Every drivable terrain tile the balance model grades the COMPOSITION of: its
// share of the board feeds traits, the interest/blandness check, and the hazard
// deductions. background/empty (the non-drivable void) are excluded on purpose.
// This is the authoritative "which tiles does fairness understand" list for the
// composition layer — unbalancedTiles() checks every config.tileMap tile against
// it (paired with cellGraph's routing-cost coverage) so a newly-added tile that
// nobody balanced is caught by CI instead of silently scoring as if it weren't
// there. ADD A NEW TILE HERE (and give it a tileWeight in cellGraph) when you add
// one to config.tileMap.
var COMPOSITION_TILES = ['slow', 'normal', 'fast', 'lava', 'ice', 'water', 'ability', 'goal', 'bumper', 'random'];

// Tile-composition ratios over DRIVABLE cells (background/empty excluded), plus
// the drivable fraction of the whole board.
function composition(map, config) {
    var bg = tileId(config, 'background'), empty = tileId(config, 'empty');
    var names = COMPOSITION_TILES;
    var idOf = {};
    names.forEach(function (n) { idOf[n] = tileId(config, n); });

    var counts = {}, total = 0, drivable = 0;
    var cells = Array.isArray(map.cells) ? map.cells : [];
    for (var i = 0; i < cells.length; i++) {
        var id = cells[i].id;
        counts[id] = (counts[id] || 0) + 1;
        total++;
        if (id !== bg && id !== empty) { drivable++; }
    }
    var ratios = {};
    var denom = Math.max(1, drivable);
    names.forEach(function (n) { ratios[n] = (counts[idOf[n]] || 0) / denom; });
    return { ratios: ratios, total: total, drivable: drivable, drivableFrac: drivable / Math.max(1, total) };
}

// Audit which paintable terrain tiles in config.tileMap the balance model does NOT
// yet account for. A tile is "balanced" only when BOTH layers cover it: its
// composition share (COMPOSITION_TILES) AND its routing cost
// (cellGraph.BALANCE_WEIGHTED_TILES, which feeds par times + the fairness spread).
// background/empty are the non-drivable void and are skipped; the nested `abilities`
// container has no top-level numeric id and is skipped too. The content-validation
// CI calls this to WARN when someone adds a tile to config.tileMap but forgets to
// balance it — so an unbalanced tile can't silently skew (or be ignored by) the
// fairness score. Returns [{ name, id, missing: ['composition'|'routing'] }].
function unbalancedTiles(config) {
    var tm = (config && config.tileMap) || {};
    var skip = { background: true, empty: true };
    var comp = {}; COMPOSITION_TILES.forEach(function (n) { comp[n] = true; });
    var weighted = {};
    (cellGraph.BALANCE_WEIGHTED_TILES || []).forEach(function (n) { weighted[n] = true; });
    var out = [];
    for (var name in tm) {
        if (!Object.prototype.hasOwnProperty.call(tm, name) || skip[name]) { continue; }
        var t = tm[name];
        if (!t || typeof t.id !== 'number') { continue; } // not a paintable tile (e.g. the abilities container)
        var missing = [];
        if (!comp[name]) { missing.push('composition'); }
        if (!weighted[name]) { missing.push('routing'); }
        if (missing.length) { out.push({ name: name, id: t.id, missing: missing }); }
    }
    return out;
}

// Every character trait a map qualifies for (a map can be both ice AND pinball).
// Bumper/pinball identity comes from EITHER bumper tiles OR a high density of
// bumper hazards (BumperCity & friends place bumpers as hazards, not tiles, so
// a tile-only check misses them). dominantTrait is just traits[0] for display.
function deriveTraits(ratios, hazardDensity, config) {
    var th = bal(config, 'traitThresholds', { ice: 0.20, lava: 0.20, water: 0.15, bumper: 0.12, ability: 0.10, bumperHazardDensity: 0.20 });
    var traits = [];
    var bumperish = (ratios.bumper || 0) >= th.bumper || hazardDensity >= (th.bumperHazardDensity || 0.20);
    if (bumperish) { traits.push('bumper'); }
    if (ratios.ice >= th.ice) { traits.push('ice'); }
    if (ratios.lava >= th.lava) { traits.push('lava'); }
    if (th.water != null && (ratios.water || 0) >= th.water) { traits.push('water'); }
    if (ratios.ability >= th.ability) { traits.push('ability'); }
    if (traits.length === 0) { traits.push('standard'); } // no hazard trait crossed its threshold
    return traits;
}

function lengthClass(par, config) {
    if (par < bal(config, 'lengthSprintMax', 14)) { return 'sprint'; }
    if (par > bal(config, 'lengthMarathonMin', 45)) { return 'marathon'; }
    return 'standard';
}

// Centroid of all goal tiles' sites, or null when the map has no goal.
function goalCentroid(map, config) {
    var goalId = tileId(config, 'goal');
    var cells = Array.isArray(map.cells) ? map.cells : [];
    var gx = 0, gy = 0, gn = 0;
    for (var i = 0; i < cells.length; i++) {
        if (cells[i].id === goalId && cells[i].site) { gx += cells[i].site.x; gy += cells[i].site.y; gn++; }
    }
    if (gn === 0) { return null; }
    return { x: gx / gn, y: gy / gn };
}

// How centered the goal is between a pair of opposite start edges, 0..1 (1 =
// dead centre, 0 = right against one edge). For top/bottom starts it measures the
// goal centroid's Y; for left/right, its X. Used to flag unfair off-centre goals
// on 2-edge maps. Returns 1 (no penalty) if there's no goal to locate.
function goalCentrality(map, edges, config) {
    var g = goalCentroid(map, config);
    if (g == null) { return 1; }
    var W = config.worldWidth || 1366, H = config.worldHeight || 768;
    var vertical = (edges.indexOf('top') !== -1 || edges.indexOf('bottom') !== -1);
    var c = vertical ? (1 - Math.abs(2 * g.y / H - 1)) : (1 - Math.abs(2 * g.x / W - 1));
    return (c < 0) ? 0 : (c > 1 ? 1 : c);
}

// Midpoint of the boundary cellA shares with the cell whose voronoiId is bId, or
// null when no shared edge with usable vertices exists.
function sharedEdgeMidpoint(cellA, bId) {
    if (cellA == null || !Array.isArray(cellA.halfedges)) { return null; }
    for (var h = 0; h < cellA.halfedges.length; h++) {
        var edge = cellA.halfedges[h] && cellA.halfedges[h].edge;
        if (!edge || !edge.va || !edge.vb) { continue; }
        if ((edge.lSite && edge.lSite.voronoiId === bId) || (edge.rSite && edge.rSite.voronoiId === bId)) {
            return { x: Math.round((edge.va.x + edge.vb.x) / 2), y: Math.round((edge.va.y + edge.vb.y) / 2) };
        }
    }
    return null;
}

// Resolve a route's voronoiIds back to drawable points (rounded — these go over
// the wire to the editor overlay, so keep the payload compact). The polyline runs
// centre -> shared-border midpoint -> next centre rather than centre -> centre:
// Voronoi cells are convex, so each leg provably stays inside its own (safe) cell,
// where a straight centre-to-centre segment can visually clip across a lava
// neighbour's polygon even though the route never enters it.
function pathPoints(map, path) {
    var cells = map.cells, idToIndex = {};
    for (var i = 0; i < cells.length; i++) {
        if (cells[i] && cells[i].site) { idToIndex[cells[i].site.voronoiId] = i; }
    }
    var pts = [];
    for (var p = 0; p < path.length; p++) {
        var ci = idToIndex[path[p]];
        if (ci == null) { continue; }
        pts.push({ x: Math.round(cells[ci].site.x), y: Math.round(cells[ci].site.y) });
        if (p + 1 < path.length) {
            var mid = sharedEdgeMidpoint(cells[ci], path[p + 1]);
            if (mid != null) { pts.push(mid); }
        }
    }
    return pts;
}

// Cells a real racer must route around: every cell holding (or, for a moving
// bumper, swept by) a bumper hazard. Hazards aren't tiles, so the cell graph
// can't see them — this mirrors aiController's hazardCells/HAZARD_PATH_PENALTY
// so the overlay's routes dodge the same obstacles the bots do. Returns null
// when the map has no hazards. Built from the raw map JSON (anchor + angle +
// config rail width), not live hazard objects — balanceDebug runs pre-game.
var HAZARD_PATH_PENALTY = 12; // cost x — matches aiController's STATIC bumper penalty
                              // (bots price MOVING rails milder — RAIL_PATH_PENALTY 4,
                              //  they time the gaps; the overlay stays conservative)
var HAZARD_CLEARANCE = 40;    // px a drawn racing line keeps from a bumper point
                              // (~attackRadius 15 + player radius + dodge pad,
                              //  mirroring aiController's BUMPER_DANGER_PAD idea)
// { penalty: [voronoiId...] | null, points: [{x,y}...] } — the cells to penalize
// in pathing AND the raw hazard points the smoothed line must keep clear of. A
// bumper can stand ON a cell border, so each point penalizes a ring of cells
// around it (centre + 8 samples at HAZARD_CLEARANCE), not just its own cell.
function hazardAvoidance(map, config) {
    var hazards = Array.isArray(map.hazards) ? map.hazards : [];
    if (hazards.length === 0) { return { penalty: null, points: [] }; }
    var cells = map.cells;
    function nearestVid(x, y) {
        var best = Infinity, vid = null;
        for (var i = 0; i < cells.length; i++) {
            var s = cells[i] && cells[i].site;
            if (!s) { continue; }
            var dx = s.x - x, dy = s.y - y;
            if (dx * dx + dy * dy < best) { best = dx * dx + dy * dy; vid = s.voronoiId; }
        }
        return vid;
    }
    var seen = {}, set = [], points = [];
    function add(vid) { if (vid != null && !seen[vid]) { seen[vid] = true; set.push(vid); } }
    function addAround(x, y) {
        points.push({ x: x, y: y });
        add(nearestVid(x, y));
        for (var a = 0; a < 8; a++) {
            var ang = a * Math.PI / 4;
            add(nearestVid(x + Math.cos(ang) * HAZARD_CLEARANCE, y + Math.sin(ang) * HAZARD_CLEARANCE));
        }
    }
    var movingId = (config.hazards && config.hazards.movingBumper) ? config.hazards.movingBumper.id : null;
    var railLen = (config.hazards && config.hazards.movingBumper && config.hazards.movingBumper.width) || 100;
    for (var h = 0; h < hazards.length; h++) {
        var hz = hazards[h];
        if (hz == null || typeof hz.x !== "number" || typeof hz.y !== "number") { continue; }
        addAround(hz.x, hz.y);
        if (hz.id === movingId) {
            // A railed bumper sweeps from its anchor along `angle` for the rail
            // length (engine.js confines it parametrically) — penalize the swept lane.
            var rad = (hz.angle || 0) * Math.PI / 180;
            for (var t = 25; t <= railLen; t += 25) {
                addAround(hz.x + Math.cos(rad) * t, hz.y + Math.sin(rad) * t);
            }
        }
    }
    return { penalty: set, points: points };
}

// Straighten a route's waypoints into a racing line: from each point, greedily
// skip ahead to the farthest waypoint reachable by a straight, safe drive — no
// lava, no hole, no penalized bumper cell anywhere along the segment (sampled
// every ~15px against the containing Voronoi cell). A player drives straight
// across open same-terrain ground; only obstacles should bend the drawn line,
// not cell-centre dog-legs.
function smoothRoute(map, config, pts, penaltyLookup, hazardPoints) {
    if (!Array.isArray(pts) || pts.length <= 2) { return pts; }
    var lavaId = tileId(config, 'lava'), emptyId = tileId(config, 'empty');
    var cells = map.cells;
    function cellAt(x, y) {
        var best = Infinity, bc = null;
        for (var i = 0; i < cells.length; i++) {
            var s = cells[i] && cells[i].site;
            if (!s) { continue; }
            var dx = s.x - x, dy = s.y - y;
            if (dx * dx + dy * dy < best) { best = dx * dx + dy * dy; bc = cells[i]; }
        }
        return bc;
    }
    // Distance from segment ab to point p — a straightened leg must clear every
    // bumper point by HAZARD_CLEARANCE (a bumper can stand on a cell border, so
    // the cell checks alone can't guarantee clearance).
    function segClearsHazards(a, b) {
        if (!hazardPoints || hazardPoints.length === 0) { return true; }
        var abx = b.x - a.x, aby = b.y - a.y;
        var lenSq = abx * abx + aby * aby || 1;
        for (var i = 0; i < hazardPoints.length; i++) {
            var p = hazardPoints[i];
            var t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
            if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
            var dx = a.x + abx * t - p.x, dy = a.y + aby * t - p.y;
            if (dx * dx + dy * dy < HAZARD_CLEARANCE * HAZARD_CLEARANCE) { return false; }
        }
        return true;
    }
    function segmentSafe(a, b) {
        if (!segClearsHazards(a, b)) { return false; }
        var dx = b.x - a.x, dy = b.y - a.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        // Perpendicular half-tube: the leg must keep a kart's half-width (plus a
        // little) of clearance on BOTH sides, so the drawn line never threads a
        // lava pinch narrower than the kart physically fits. Legs through tight-
        // but-legal doors fall back to the door-midpoint waypoints instead.
        var halfTube = cellGraph.KART_WIDTH / 2 + 2;
        var nx = (-dy / len) * halfTube, ny = (dx / len) * halfTube;
        // 5px sampling: a straightened leg can graze a narrow lava wedge between
        // coarser samples (Voronoi corners come to a point). Brute-force nearest-
        // site lookups at this density are still fine for an on-demand, throttled
        // check (~a few ms on a 250-cell map).
        var steps = Math.max(2, Math.ceil(len / 5));
        for (var s = 1; s < steps; s++) {
            var t = s / steps;
            var px = a.x + dx * t, py = a.y + dy * t;
            for (var o = -1; o <= 1; o++) {
                var cell = cellAt(px + nx * o, py + ny * o);
                if (cell == null || cell.id === lavaId || cell.id === emptyId) { return false; }
                if (penaltyLookup && cell.site && penaltyLookup[cell.site.voronoiId]) { return false; }
            }
        }
        return true;
    }
    var out = [pts[0]];
    var i = 0;
    while (i < pts.length - 1) {
        var j = pts.length - 1;
        while (j > i + 1 && !segmentSafe(pts[i], pts[j])) { j--; }
        out.push(pts[j]);
        i = j;
    }
    return out;
}

// Representative per-edge par time + chosen route for every start edge, computed
// with the SAME hazard-aware, safe-seeded routing the overlay draws — so the
// fairness deduction grades the exact times shown on the map (raw computeMapParTime
// ignored bumper penalties and could even disagree on which side is faster).
// Returns { edges: [{ edge, par, route }], avoid }; par 0 / route null when no
// edge sample reaches the goal.
function edgeParTimes(map, config) {
    var edges = startEdgesOf(map);
    var lavaId = tileId(config, 'lava');
    var avoid = hazardAvoidance(map, config);
    var routeOpts = avoid.penalty ? { penaltySet: avoid.penalty, penaltyMult: HAZARD_PATH_PENALTY } : undefined;
    var nDraw = bal(config, 'fairnessRoutesPerEdge', 4);
    var result = [];
    for (var e = 0; e < edges.length; e++) {
        var samples = cellGraph.edgeSampleOrigins(edges[e]);
        var routes = [];
        for (var s = 0; s < samples.length; s++) {
            var r = cellGraph.findPathToNearestGoal(map, samples[s], routeOpts);
            if (r != null) {
                var t = cellGraph.estimatePathTime(map, r.path);
                if (t > 0) {
                    routes.push({
                        time: t, path: r.path, origin: samples[s],
                        // Dijkstra allows SEEDING from a lava cell (so a gate fronted
                        // by lava still reports reachability), but a player can't
                        // actually launch through lava — flag those for display.
                        safeSeed: map.cells[r.startIndex] != null && map.cells[r.startIndex].id !== lavaId
                    });
                }
            }
        }
        // FAIRNESS spread (`times`) counts EVERY routable sample — including ones
        // that launch onto lava (safeSeed=false). Players spawn uniformly across
        // the whole gate (Gate.getSafeLoc), so a lava-front start is a real, slower
        // spawn whose time belongs in the spread (Codex review P2: don't silently
        // drop unsafe spawns). Samples with NO route are deliberately excluded: the
        // nearest-cell test reads an empty/lava sliver at the gate lip as "dead"
        // even though a real player just drives off it — committed playable maps
        // show 70-80% such false nulls — and a fully-walled gate is already a
        // hard-fail via reachableFromEdge. DRAW/`par` prefer safe-seeded routes so
        // the fanned lines stay the ones a player would actually take.
        var safe = routes.filter(function (x) { return x.safeSeed; });
        var drawPool = safe.length ? safe : routes;
        var times = routes.map(function (x) { return x.time; });
        var drawTimes = drawPool.map(function (x) { return x.time; }).sort(function (a, b) { return a - b; });
        var par = drawTimes.length ? drawTimes[Math.floor(drawTimes.length / 2)] : 0;
        result.push({ edge: edges[e], par: par, times: times, draw: spreadPick(drawPool, nDraw) });
    }
    return { edges: result, avoid: avoid };
}

// Up to n items evenly spaced across the list by INDEX (gate position), always
// including the first and last so the fan spans the whole gate.
function spreadPick(list, n) {
    if (!Array.isArray(list) || list.length <= n) { return (list || []).slice(); }
    if (n <= 1) { return [list[0]]; }
    var out = [], seen = {};
    for (var i = 0; i < n; i++) {
        var idx = Math.round(i * (list.length - 1) / (n - 1));
        if (!seen[idx]) { seen[idx] = true; out.push(list[idx]); }
    }
    return out;
}

// Penalty-cell lookup ({ voronoiId: true }) from a hazardAvoidance() result, or
// null when the map has no hazards. Shared by the overlay and the competing-lines
// export so both penalise the same cells.
function penaltyLookupFrom(avoid) {
    if (!avoid || !avoid.penalty) { return null; }
    var lk = {};
    for (var i = 0; i < avoid.penalty.length; i++) { lk[avoid.penalty[i]] = true; }
    return lk;
}

// Turn a routed sample ({ path:[voronoiId...], origin:{x,y} }) into the drawable,
// straightened racing line: gate-side origin first, then the smoothed line. The ONE
// place this geometry is built, so the editor overlay (balanceDebug) and the CI
// "competing lines" artifact (competingLines) stay byte-identical.
function routePolyline(map, config, route, penaltyLookup, avoid) {
    var pts = pathPoints(map, route.path);
    pts.unshift({ x: Math.round(route.origin.x), y: Math.round(route.origin.y) });
    return smoothRoute(map, config, pts, penaltyLookup, avoid.points);
}

// Overlay geometry for the editor's "looks unbalanced" nudge: the representative
// (median-time) route from each start edge — the same per-edge times the fairness
// deduction grades — plus the goal centroid + centrality, so the author can SEE
// which side is faster and where the goal actually sits. Read-only; only computed
// for the scoreMap reply, never at boot.
function balanceDebug(map, config) {
    var ept = edgeParTimes(map, config);
    var avoid = ept.avoid;
    var penaltyLookup = penaltyLookupFrom(avoid);
    var out = { edges: [], goal: null };
    for (var e = 0; e < ept.edges.length; e++) {
        var entry = ept.edges[e];
        if (!entry.draw || entry.draw.length === 0) {
            // No reachable route from this edge (matches a hard-fail) — still report
            // the edge so the overlay can flag it instead of silently omitting it.
            out.edges.push({ edge: entry.edge, par: 0, routes: [] });
            continue;
        }
        // Draw every sampled start point's racing line: lead each polyline with its
        // real gate-side origin (so it launches from the gate), then straighten the
        // cell-centre dog-legs into the line a player would actually drive.
        var routes = [];
        for (var d = 0; d < entry.draw.length; d++) {
            var rt = entry.draw[d];
            routes.push({ par: Math.round(rt.time * 10) / 10, points: routePolyline(map, config, rt, penaltyLookup, avoid) });
        }
        var ts = entry.times.slice().sort(function (a, b) { return a - b; });
        out.edges.push({
            edge: entry.edge,
            par: Math.round(entry.par * 10) / 10,        // representative (median)
            lo: Math.round(ts[0] * 10) / 10,             // fastest start point on this gate
            hi: Math.round(ts[ts.length - 1] * 10) / 10, // slowest
            routes: routes
        });
    }
    var g = goalCentroid(map, config);
    if (g != null) {
        var edges = startEdgesOf(map);
        out.goal = {
            x: Math.round(g.x),
            y: Math.round(g.y),
            centrality: Math.round(goalCentrality(map, edges, config) * 100) / 100,
            vertical: (edges.indexOf('top') !== -1 || edges.indexOf('bottom') !== -1)
        };
    }
    return out;
}

// Distinct competing racing lines across the whole map, fastest first — built from
// the SAME fairness machinery the editor overlay and the `fairness` deduction use
// (edgeParTimes' hazard-aware safe-seeded sampling + smoothRoute's racing line), so
// a reviewer's "competing lines" view matches exactly what the author saw in the
// editor. The map-submission review CI calls this instead of re-deriving its own
// pathing. Flattens every gate's fanned sample lines into one pool, then keeps only
// lines spatially distinct from those already chosen (cell-path overlap > dedupe
// threshold = "the same line"). Returns up to maxRoutes: [{ seconds, points:[{x,y}] }].
function competingLines(map, config, opts) {
    opts = opts || {};
    var maxRoutes = (opts.maxRoutes != null) ? opts.maxRoutes : 3;
    var overlapThresh = (opts.dedupeOverlap != null) ? opts.dedupeOverlap : 0.6;
    if (!Array.isArray(map.cells) || map.cells.length === 0) { return []; }

    var ept = edgeParTimes(map, config);
    var avoid = ept.avoid;
    var penaltyLookup = penaltyLookupFrom(avoid);

    // Every fanned sample line from every edge (edgeParTimes already prefers the
    // safe-seeded, hazard-avoiding routes), with its cell path (for dedupe) and its
    // physics-walk time (the same estimatePathTime that produces par).
    var cands = [];
    for (var e = 0; e < ept.edges.length; e++) {
        var draw = ept.edges[e].draw || [];
        for (var d = 0; d < draw.length; d++) {
            var rt = draw[d];
            if (!rt || !Array.isArray(rt.path) || rt.path.length < 2 || !(rt.time > 0)) { continue; }
            cands.push({ seconds: rt.time, path: rt.path, origin: rt.origin });
        }
    }
    cands.sort(function (a, b) { return a.seconds - b.seconds; });

    var chosen = [];
    for (var c = 0; c < cands.length; c++) {
        var setC = {}, sizeC = 0;
        for (var pi = 0; pi < cands[c].path.length; pi++) {
            if (!setC[cands[c].path[pi]]) { setC[cands[c].path[pi]] = true; sizeC++; }
        }
        var dup = false;
        for (var ch = 0; ch < chosen.length; ch++) {
            var inter = 0;
            for (var v in setC) { if (chosen[ch].set[v]) { inter++; } }
            var uni = sizeC + chosen[ch].size - inter;
            if (uni > 0 && inter / uni > overlapThresh) { dup = true; break; }
        }
        if (!dup) { chosen.push({ cand: cands[c], set: setC, size: sizeC }); }
        if (chosen.length >= maxRoutes) { break; }
    }

    // Straighten each chosen route into the drawable racing line (shared with the
    // editor overlay via routePolyline).
    return chosen.map(function (entry) {
        var rt = entry.cand;
        return { seconds: Math.round(rt.seconds * 10) / 10, points: routePolyline(map, config, rt, penaltyLookup, avoid) };
    });
}

// Main entry: map (reconstructed, full geometry) + config -> meta object.
// `parTime` is read from the map if already computed (loadMaps does this) and
// otherwise computed here, so the classifier is safe to call standalone.
function classify(map, config) {
    var comp = composition(map, config);
    var r = comp.ratios;
    var par = (map.parTime != null) ? map.parTime : cellGraph.computeMapParTime(map);
    var edges = startEdgesOf(map);
    var hazardCount = Array.isArray(map.hazards) ? map.hazards.length : 0;
    var hazardDensity = hazardCount / Math.max(1, comp.drivable);

    // --- hard gates: any failure => never Featured (but still playable) ---
    var hardFail = [];
    for (var e = 0; e < edges.length; e++) {
        if (!cellGraph.reachableFromEdge(map, edges[e])) {
            hardFail.push('goal unreachable from ' + edges[e] + ' start');
        }
    }
    var minDrive = bal(config, 'minDrivableFrac', 0.40);
    if (comp.drivableFrac < minDrive) {
        hardFail.push('only ' + Math.round(comp.drivableFrac * 100) + '% drivable (< ' + Math.round(minDrive * 100) + '%)');
    }
    var parMin = bal(config, 'parMin', 8), parMax = bal(config, 'parMax', 90);
    if (par < parMin) { hardFail.push('par ' + par.toFixed(1) + 's too short (< ' + parMin + 's)'); }
    if (par > parMax) { hardFail.push('par ' + par.toFixed(1) + 's too long (> ' + parMax + 's)'); }

    // --- spawn fairness: how close every start point's time-to-goal is ---
    // Graded on the ABSOLUTE spread in seconds across EVERY sampled start point on
    // EVERY gate (the same routes the overlay fans out), so an unlucky spawn lane —
    // whether between two gates or just across one wide gate — is what the penalty
    // sees. fairness (0..1) kept for meta as a ratio for back-compat; fairnessGap
    // (the spread) drives the deduction.
    var fairness = 1, fairnessGap = 0;
    var allTimes = [];
    var eptEdges = edgeParTimes(map, config).edges;
    for (var k = 0; k < eptEdges.length; k++) {
        for (var ti = 0; ti < eptEdges[k].times.length; ti++) {
            // Round to 0.1s — the precision the overlay shows — so the spread the
            // penalty grades is the spread the author can read off the route labels.
            allTimes.push(Math.round(eptEdges[k].times[ti] * 10) / 10);
        }
    }
    if (allTimes.length >= 2) {
        var lo = Math.min.apply(null, allTimes), hi = Math.max.apply(null, allTimes);
        fairnessGap = hi - lo;
        fairness = lo / hi;
    }

    // --- soft deductions from 100 ---
    var score = 100;
    var deductions = [];
    function deduct(amount, label) {
        if (amount > 0) { score -= amount; deductions.push(label + ' -' + amount); }
    }

    // Race LENGTH rides on the bot-line estimate (abilities/skill muddy it), so it
    // stays soft — see config.balance.lengthMax. Spawn FAIRNESS grades how even the
    // spawn-to-goal times are across every start point: within fairnessToleranceSec
    // (~0.2s) is the shown ideal, then a per-second ramp to the cap. The ramp is
    // gentle (config-tuned) because a wide gate inherently spreads spawn times by
    // a few seconds, so only broadly-uneven maps should actually lose the tier.
    {
        var tol = bal(config, 'fairnessToleranceSec', 0.2);
        var perSec = bal(config, 'fairnessPerSec', 8);
        var fairnessMax = bal(config, 'fairnessMax', 20);
        deduct(Math.min(fairnessMax, Math.round(Math.max(0, fairnessGap - tol) * perSec)), 'fairness');
    }
    // hazard sanity: heavy lava and bumper-walls punish; near-zero hazard is bland
    var hd = 0;
    if (r.lava > 0.30) { hd += Math.min(15, Math.round((r.lava - 0.30) * 60)); }
    if (r.lava > 0 && r.lava < 0.02) { hd += 4; }
    if (r.bumper > 0.22) { hd += Math.min(8, Math.round((r.bumper - 0.22) * 40)); }
    deduct(Math.min(20, hd), 'hazard');
    // length comfort: distance from the ideal par band
    var idealLow = bal(config, 'idealParLow', 18), idealHigh = bal(config, 'idealParHigh', 40);
    var lengthMax = bal(config, 'lengthMax', 15);
    if (par < idealLow) { deduct(Math.min(lengthMax, Math.round((idealLow - par) * 1.5)), 'length'); }
    else if (par > idealHigh) { deduct(Math.min(lengthMax, Math.round((par - idealHigh) * 0.6)), 'length'); }
    // whole-map ice (frictionless everywhere) is a coin-flip, not a race
    if (r.ice > 0.45) { deduct(Math.min(10, Math.round((r.ice - 0.45) * 30)), 'ice'); }
    // tiny boards collapse into a scrum
    if (comp.total < 120) { deduct(8, 'tiny'); }
    // BLANDNESS: the scorer otherwise only punishes EXCESS, so a featureless field
    // of one baseline tile with no hazards (a 2-second non-track) sailed through.
    // Penalize the ABSENCE of interest: "interest" = the share of drivable cells
    // that are non-baseline tiles (fast/lava/ice/ability/bumper/random) plus a
    // hazard-density boost. Every committed map clears the threshold by a wide
    // margin (min featureShare ~0.36), so this fires only on barren maps.
    var featureShare = r.fast + r.lava + r.ice + r.water + r.ability + r.bumper + r.random;
    var interest = featureShare + Math.min(0.40, hazardDensity * 2);
    var blandT = bal(config, 'blandnessThreshold', 0.30);
    if (interest < blandT) {
        deduct(Math.round((blandT - interest) / blandT * bal(config, 'blandnessMax', 70)), 'bland');
    }
    // GOAL PLACEMENT: on opposite-edge starts (top+bottom / left+right) the goal
    // should sit BETWEEN the two edges — jammed up against one side hands that
    // side a near-instant win. The par-ratio fairness above samples both edges but
    // averages out; this measures the goal's geometric position directly.
    if (edges.length > 1) {
        var centrality = goalCentrality(map, edges, config);
        deduct(Math.round((1 - centrality) * bal(config, 'goalCentralityMax', 30)), 'goal');
    }

    if (score < 0) { score = 0; }
    if (score > 100) { score = 100; }

    var featuredScore = bal(config, 'featuredScore', 85);
    var tier = (hardFail.length === 0 && score >= featuredScore) ? 'featured' : 'community';

    var traits = deriveTraits(r, hazardDensity, config);

    return {
        parTime: par,
        length: lengthClass(par, config),
        traits: traits,
        dominantTrait: traits[0],
        ratios: r,
        drivableFrac: comp.drivableFrac,
        cellCount: comp.total,
        hazardCount: hazardCount,
        hazardDensity: hazardDensity,
        startEdgeCount: edges.length,
        fairness: fairness,
        balanceScore: score,
        tier: tier,
        hardFail: hardFail,
        deductions: deductions,
        rating: null,      // filled by the ratings layer (Phase 4); null until then
        playlists: []      // filled by resolvePlaylists() once playlist defs are known
    };
}

// Does a map's meta satisfy a single playlist's filter? An empty filter matches
// everything ("Everything"). Unknown keys are ignored so new filters degrade to
// "match" rather than silently excluding every map.
function matches(meta, filter) {
    if (!filter) { return true; }
    if (filter.tier != null && meta.tier !== filter.tier) { return false; }
    if (filter.trait != null) {
        var traits = Array.isArray(meta.traits) ? meta.traits : [meta.dominantTrait];
        if (traits.indexOf(filter.trait) === -1) { return false; }
    }
    if (filter.length != null && meta.length !== filter.length) { return false; }
    if (filter.minScore != null && !(meta.balanceScore >= filter.minScore)) { return false; }
    if (filter.minRating != null) {
        // Crowd Favorites: requires a real rating aggregate. No data => excluded
        // (selection falls back to Featured when a playlist is too thin).
        if (!meta.rating || !(meta.rating.bayesian >= filter.minRating)) { return false; }
    }
    return true;
}

// Given a map's meta and the config.playlists[] defs, return the ids of every
// playlist it belongs to. A map can sit in several (e.g. featured + ice + sprint).
function resolvePlaylists(meta, playlistDefs) {
    var ids = [];
    if (!Array.isArray(playlistDefs)) { return ids; }
    for (var i = 0; i < playlistDefs.length; i++) {
        var def = playlistDefs[i];
        if (def && def.id && matches(meta, def.filter)) { ids.push(def.id); }
    }
    return ids;
}

module.exports = {
    classify: classify,
    balanceDebug: balanceDebug,
    competingLines: competingLines,
    unbalancedTiles: unbalancedTiles,
    COMPOSITION_TILES: COMPOSITION_TILES,
    matches: matches,
    resolvePlaylists: resolvePlaylists
};
