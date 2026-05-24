// Cell adjacency graph + pathfinding over a map's Voronoi cells.
//
// Maps are player-made Voronoi diagrams. Adjacency is already encoded in the map
// JSON: each cell carries site{x,y,voronoiId}, a tile id, and halfedges[] whose
// edge.lSite/edge.rSite name the site on each side of the boundary. The neighbor
// across an edge is whichever side's voronoiId differs from the cell's own;
// boundary edges have a null lSite/rSite and are skipped (the world boundary is
// the only wall — see engine.bounceOffBoundry).
//
// This is the shared foundation for fair single-player lava (spawn->goal "par
// distance") and, later, bot navigation (A* to the nearest reachable goal).
//
// Passability is read LIVE from cell.id at query time (lava cells are blocked),
// because tiles flip to lava during a collapse and "random" tiles resolve at
// round start. Only the static adjacency (which cell borders which) is cached.

var c = require('./config.json');

// Cache adjacency (arrays of neighbor cell indices) keyed by map id + cell count.
// currentMap is a JSON deep-copy per round (server/game.js determineNextMap), so
// the cache can't live on the map object itself; geometry is identical for a
// given source map, and the +cellCount guard rebuilds if an edited preview map
// reuses an id with different geometry.
var adjacencyCache = new Map();

// Per-tile traversal cost multiplier ~ real travel TIME per unit distance, so the
// path minimizes time, not arbitrary preference: it favours grass but takes a
// direct sand shortcut when that's genuinely faster than a long grass detour.
// Steady-state speed on a tile ∝ acel/drag, so time/distance ∝ drag/acel,
// normalized to grass = 1.0: grass 2333, dirt 1200, sand 625 -> 1.0 / 1.9 / 3.7.
// Ice/bumper get a control-risk bump above their raw time. Lava is blocked.
//   grass = fast (id 2), dirt = normal (id 1), sand = slow (id 0).
function tileWeight(id) {
    switch (id) {
        case c.tileMap.fast.id: return 1.0;   // grass — fastest (baseline)
        case c.tileMap.normal.id: return 1.9; // dirt — ~2x grass time
        case c.tileMap.slow.id: return 3.7;   // sand — ~3.7x grass time (avoid unless clearly shorter)
        case c.tileMap.ice.id: return 2.5;    // fast but uncontrollable — penalize for control risk
        case c.tileMap.bumper.id: return 3.0; // knockback hazard
        default: return 1.0; // goal, ability, random
    }
}

function buildAdjacency(map) {
    var cells = map.cells;
    var idToIndex = {};
    for (var i = 0; i < cells.length; i++) {
        if (cells[i] && cells[i].site && typeof cells[i].site.voronoiId === "number") {
            idToIndex[cells[i].site.voronoiId] = i;
        }
    }
    var neighbors = new Array(cells.length);
    for (var ci = 0; ci < cells.length; ci++) {
        var cell = cells[ci];
        var set = {};
        var list = [];
        if (cell && cell.site && Array.isArray(cell.halfedges)) {
            var own = cell.site.voronoiId;
            for (var h = 0; h < cell.halfedges.length; h++) {
                var he = cell.halfedges[h];
                var edge = he && he.edge;
                if (!edge) {
                    continue;
                }
                // Exactly one of lSite/rSite is this cell's own site on an
                // interior edge; the other is the neighbor. Boundary edges have
                // a null on one side and are skipped.
                var otherId = null;
                if (edge.lSite && edge.lSite.voronoiId !== own) {
                    otherId = edge.lSite.voronoiId;
                } else if (edge.rSite && edge.rSite.voronoiId !== own) {
                    otherId = edge.rSite.voronoiId;
                }
                if (otherId == null) {
                    continue;
                }
                var ni = idToIndex[otherId];
                if (ni != null && ni !== ci && !set[ni]) {
                    set[ni] = true;
                    list.push(ni);
                }
            }
        }
        neighbors[ci] = list;
    }
    return neighbors;
}

function getAdjacency(map) {
    var key = (map.id != null ? map.id : "anon") + ":" + map.cells.length;
    var entry = adjacencyCache.get(key);
    if (entry && entry.count === map.cells.length) {
        return entry.neighbors;
    }
    var neighbors = buildAdjacency(map);
    adjacencyCache.set(key, { neighbors: neighbors, count: map.cells.length });
    return neighbors;
}

// Minimal binary min-heap of { node, cost }. A* / Dijkstra over ~250 cells is
// cheap, but bots re-path repeatedly so a heap keeps it linearithmic.
function Heap() {
    this.items = [];
}
Heap.prototype.push = function (node, cost) {
    var items = this.items;
    items.push({ node: node, cost: cost });
    var i = items.length - 1;
    while (i > 0) {
        var parent = (i - 1) >> 1;
        if (items[parent].cost <= items[i].cost) {
            break;
        }
        var tmp = items[parent]; items[parent] = items[i]; items[i] = tmp;
        i = parent;
    }
};
Heap.prototype.pop = function () {
    var items = this.items;
    var top = items[0];
    var last = items.pop();
    if (items.length > 0) {
        items[0] = last;
        var i = 0, n = items.length;
        while (true) {
            var l = 2 * i + 1, r = 2 * i + 2, smallest = i;
            if (l < n && items[l].cost < items[smallest].cost) smallest = l;
            if (r < n && items[r].cost < items[smallest].cost) smallest = r;
            if (smallest === i) break;
            var tmp = items[smallest]; items[smallest] = items[i]; items[i] = tmp;
            i = smallest;
        }
    }
    return top;
};
Heap.prototype.size = function () {
    return this.items.length;
};

function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// Index of the cell whose site is nearest to `point`. In a Voronoi diagram the
// region containing a point is exactly the nearest-site cell.
function nearestCellIndex(cells, point) {
    var best = Infinity, bestIdx = 0;
    for (var i = 0; i < cells.length; i++) {
        var s = cells[i].site;
        var dx = s.x - point.x, dy = s.y - point.y;
        var d = dx * dx + dy * dy;
        if (d < best) {
            best = d;
            bestIdx = i;
        }
    }
    return bestIdx;
}

// Shortest traversable route from `point` to the nearest reachable goal cell.
// Dijkstra over the live (lava-blocked) graph, edge cost = geometric site
// distance x tileWeight(destination). Returns:
//   { path: [voronoiId...], distance: <geometric path length>, goal: {x,y},
//     goalIndex, startIndex }
// or null if no goal is reachable. `distance` is the raw (unweighted) geometric
// length, used for the single-player par-time estimate.
//
// options.blocked: optional Set/array of voronoiIds to treat as impassable (e.g.
// already-collapsed cells a re-pathing bot must avoid).
function findPathToNearestGoal(map, point, options) {
    options = options || {};
    if (!map || !Array.isArray(map.cells) || map.cells.length === 0) {
        return null;
    }
    var cells = map.cells;
    var neighbors = getAdjacency(map);
    var LAVA = c.tileMap.lava.id;
    var GOAL = c.tileMap.goal.id;

    var blocked = null;
    if (options.blocked) {
        blocked = {};
        var src = options.blocked.forEach ? null : options.blocked;
        if (options.blocked.forEach) {
            options.blocked.forEach(function (id) { blocked[id] = true; });
        } else {
            for (var bi = 0; bi < src.length; bi++) { blocked[src[bi]] = true; }
        }
    }

    // Per-bot path diversity: a stable pseudo-random cost jitter keyed on the
    // cell's voronoiId and the caller's noiseSeed, so different bots (different
    // seeds) find different near-optimal routes instead of all taking the exact
    // same line. Deterministic per (cell,seed) so Dijkstra stays consistent in a
    // run. noiseAmount is the +/- fraction (e.g. 0.2 = +/-20%); 0 disables it.
    var noiseAmount = options.noiseAmount || 0;
    var noiseSeed = options.noiseSeed || 0;
    function cellJitter(voronoiId) {
        if (noiseAmount <= 0) { return 1; }
        // 32-bit integer hash via Math.imul — plain `*` overflows 2^53 and loses
        // precision (noiseSeed*668265263 ~ 6.7e17), mangling the mix.
        var h = (Math.imul(voronoiId | 0, 374761393) + Math.imul(noiseSeed | 0, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        h = (h ^ (h >>> 16)) >>> 0;
        var r = h / 0x100000000; // [0,1)
        return 1 + (r - 0.5) * 2 * noiseAmount;
    }

    // Soft penalty for cells the caller wants the route to avoid but still cross as
    // a last resort (e.g. cells holding bumper hazards, which aren't in the graph).
    // A multiplier (not a hard block) so a hazard in a chokepoint doesn't null the
    // path. options.penaltySet: Set/array of voronoiIds; options.penaltyMult: cost x.
    var penaltyMult = options.penaltyMult || 1;
    var penalty = null;
    if (options.penaltySet && penaltyMult > 1) {
        penalty = {};
        if (options.penaltySet.forEach) {
            options.penaltySet.forEach(function (id) { penalty[id] = true; });
        } else {
            for (var pj = 0; pj < options.penaltySet.length; pj++) { penalty[options.penaltySet[pj]] = true; }
        }
    }

    var start = nearestCellIndex(cells, point);

    var N = cells.length;
    var cost = new Array(N).fill(Infinity);
    var geo = new Array(N).fill(Infinity);
    var prev = new Array(N).fill(-1);
    var done = new Array(N).fill(false);
    cost[start] = 0;
    geo[start] = 0;

    var heap = new Heap();
    heap.push(start, 0);

    var goalIndex = -1;
    while (heap.size() > 0) {
        var top = heap.pop();
        var u = top.node;
        if (done[u]) {
            continue;
        }
        done[u] = true;
        // Goal found: Dijkstra pops nodes in cost order, so this is the
        // cheapest-cost reachable goal.
        if (cells[u].id === GOAL) {
            goalIndex = u;
            break;
        }
        var nbrs = neighbors[u];
        for (var k = 0; k < nbrs.length; k++) {
            var v = nbrs[k];
            if (done[v]) {
                continue;
            }
            // Lava is impassable; so are caller-blocked cells. The goal is always
            // enterable. The start cell is allowed even if it sits on lava.
            if (cells[v].id === LAVA && cells[v].id !== GOAL) {
                continue;
            }
            if (blocked && blocked[cells[v].site.voronoiId]) {
                continue;
            }
            var step = dist(cells[u].site, cells[v].site);
            var pen = (penalty && penalty[cells[v].site.voronoiId]) ? penaltyMult : 1;
            var nc = cost[u] + step * tileWeight(cells[v].id) * cellJitter(cells[v].site.voronoiId) * pen;
            if (nc < cost[v]) {
                cost[v] = nc;
                geo[v] = geo[u] + step;
                prev[v] = u;
                heap.push(v, nc);
            }
        }
    }

    if (goalIndex === -1) {
        return null;
    }

    var path = [];
    for (var node = goalIndex; node !== -1; node = prev[node]) {
        path.push(cells[node].site.voronoiId);
    }
    path.reverse();

    return {
        path: path,
        distance: geo[goalIndex],
        goal: { x: cells[goalIndex].site.x, y: cells[goalIndex].site.y },
        goalIndex: goalIndex,
        startIndex: start
    };
}

// Convenience: is any goal reachable (not lava-walled) from `point`?
function reachableGoalExists(map, point) {
    return findPathToNearestGoal(map, point) != null;
}

// Per-tile movement physics (accel + drag coefficient) from config.
function tilePhysics(id) {
    var tm = c.tileMap;
    for (var k in tm) {
        if (tm[k] && tm[k].id === id && tm[k].acel != null) {
            return { acel: tm[k].acel, drag: tm[k].dragCoeff };
        }
    }
    return { acel: tm.normal.acel, drag: tm.normal.dragCoeff };
}

// Estimate the seconds for the player's momentum car to drive `path` (voronoiIds)
// under the REAL in-race physics: per-tile accel/drag, the velocity cap, starting
// from rest, with NO gate speed bonus (it is zeroed the instant racing starts --
// server/game.js startRacing), and a cornering brake (a momentum car must slow
// for sharp turns). This is the honest "walk the A* path with the player's
// physics" par-time, replacing distance / a flat assumed speed.
function estimatePathTime(map, path) {
    if (!map || !Array.isArray(map.cells) || !Array.isArray(path) || path.length < 2) {
        return 0;
    }
    var cells = map.cells;
    var idToIndex = {};
    for (var i = 0; i < cells.length; i++) {
        idToIndex[cells[i].site.voronoiId] = i;
    }
    var pts = [];
    for (var p = 0; p < path.length; p++) {
        var ci = idToIndex[path[p]];
        if (ci == null) { continue; }
        var cell = cells[ci];
        var ph = tilePhysics(cell.id);
        pts.push({ x: cell.site.x, y: cell.site.y, acel: ph.acel, drag: ph.drag });
    }
    if (pts.length < 2) { return 0; }
    var dt = c.serverTickSpeed / 1000;
    var maxV = c.playerMaxSpeed;
    var v = 0, t = 0;
    for (var seg = 0; seg < pts.length - 1; seg++) {
        var a = pts[seg], b = pts[seg + 1];
        if (seg > 0) {
            // Brake for the turn at waypoint `seg`: keep less speed the sharper it is.
            var px = pts[seg - 1];
            var inx = a.x - px.x, iny = a.y - px.y;
            var oux = b.x - a.x, ouy = b.y - a.y;
            var im = Math.sqrt(inx * inx + iny * iny) || 1;
            var om = Math.sqrt(oux * oux + ouy * ouy) || 1;
            var dot = (inx * oux + iny * ouy) / (im * om);
            if (dot > 1) { dot = 1; } else if (dot < -1) { dot = -1; }
            var keep = Math.cos(Math.acos(dot) / 2); // 1 straight .. 0 u-turn
            if (keep < 0.2) { keep = 0.2; }
            v *= keep;
        }
        var dx = b.x - a.x, dy = b.y - a.y;
        var segLen = Math.sqrt(dx * dx + dy * dy);
        var traveled = 0, guard = 0;
        while (traveled < segLen && guard < 200000) {
            v = v + a.acel * dt - a.drag * v; // NO gate bonus in-race
            if (v > maxV) { v = maxV; }
            if (v < 5) { v = 5; }
            traveled += v * dt;
            t += dt;
            guard++;
        }
    }
    return t;
}

// Canonical per-map "par" time: the median real-physics drive time
// (estimatePathTime) from the start gate (left edge) to the nearest reachable
// goal, sampled down the gate height. A fixed property of a map's geometry, so
// it's computed once (at map submission or server boot) and stored as
// map.parTime rather than recomputed. Returns 0 if no goal is reachable.
// NOTE: a solo player spawns at a RANDOM y in the gate, so the live solo
// collapse still pars from the player's actual spawn; this canonical value is
// for map metadata and the volcano round's eruption timing.
function computeMapParTime(map) {
    if (!map || !Array.isArray(map.cells) || map.cells.length === 0) {
        return 0;
    }
    var H = c.worldHeight;
    var step = H / 10;
    if (step < 1) { step = 1; }
    var pars = [];
    for (var y = 40; y < H; y += step) {
        var route = findPathToNearestGoal(map, { x: 40, y: y });
        if (route != null) {
            var par = estimatePathTime(map, route.path);
            if (par > 0) { pars.push(par); }
        }
    }
    if (pars.length === 0) { return 0; }
    pars.sort(function (a, b) { return a - b; });
    return pars[Math.floor(pars.length / 2)];
}

module.exports = {
    getAdjacency: getAdjacency,
    buildAdjacency: buildAdjacency,
    findPathToNearestGoal: findPathToNearestGoal,
    reachableGoalExists: reachableGoalExists,
    tileWeight: tileWeight,
    estimatePathTime: estimatePathTime,
    computeMapParTime: computeMapParTime
};
