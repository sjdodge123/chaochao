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
// Shared segment geometry (same implementation the engine uses for collision).
// Required lazily-safe: cellGraph only calls these at query time, so even under the
// utils<->cellGraph circular require, geometry is fully loaded before first use.
var segmentsCross = require('./geometry.js').segmentsCross;
var sideOf = require('./geometry.js').sideOf;

// Does a barrier touch a cell-border segment? Proper crossing PLUS the collinear-
// overlap case segmentsCross misses — a wall laid exactly ALONG a doorway (e.g. an
// axis-aligned wall over an axis-aligned grid border) covers it without "crossing,"
// yet still seals it. Used only by the barrier-block test (drawing wants proper
// crossings, so it keeps plain segmentsCross).
function barrierTouchesBorder(ax, ay, bx, by, cx, cy, dx, dy) {
    if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) { return true; }
    var EPS = 1e-6;
    function collinearOn(px, py, x1, y1, x2, y2) {
        var area = sideOf(x1, y1, x2, y2, px, py);
        var scale = Math.max(1, Math.abs(x2 - x1) + Math.abs(y2 - y1));
        if (area > EPS * scale || area < -EPS * scale) { return false; } // not collinear
        return px >= Math.min(x1, x2) - EPS && px <= Math.max(x1, x2) + EPS &&
               py >= Math.min(y1, y2) - EPS && py <= Math.max(y1, y2) + EPS;
    }
    // Overlap (or touch) iff an endpoint of either segment lies on the other.
    return collinearOn(cx, cy, ax, ay, bx, by) || collinearOn(dx, dy, ax, ay, bx, by) ||
           collinearOn(ax, ay, cx, cy, dx, dy) || collinearOn(bx, by, cx, cy, dx, dy);
}


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
// Ice is near-frictionless (drag 0.0075): its steady-state speed (~2000) is just
// behind grass (~2333) and well above dirt (~1200) — a real "glide" lane once you
// enter it carrying speed. Its raw time-cost ratio is ~1.17x grass, so a flat 1.4
// (a small control-risk bump on top) keeps ice clearly preferred over dirt/sand,
// letting bots route onto grass→ice glides instead of avoiding them — while still
// just behind grass so they don't dive onto ice from a standstill, where ice's
// dismal accel (15) would bog them down.
// Every drivable tile whose traversal COST the router has deliberately tuned —
// either an explicit weight below or the considered 1.0 default (goal/ability/
// random). A drivable tile outside this list has no thought-through routing cost,
// so par times and the fairness time-spread that cross it are untrustworthy. This
// is the authoritative "which tiles does the router understand" list for the
// timing layer; mapClassifier.unbalancedTiles() pairs it with the composition list
// so CI warns when a newly-added config.tileMap tile hasn't been balanced. ADD A
// NEW TILE HERE (give it a weight in tileWeight) when you add one to config.
var BALANCE_WEIGHTED_TILES = ['fast', 'normal', 'slow', 'ice', 'bumper', 'water', 'lava', 'goal', 'ability', 'random'];

function tileWeight(id) {
    switch (id) {
        case c.tileMap.fast.id: return 1.0;   // grass — fastest (baseline)
        case c.tileMap.normal.id: return 1.9; // dirt — ~2x grass time
        case c.tileMap.slow.id: return 3.7;   // sand — ~3.7x grass time (avoid unless clearly shorter)
        case c.tileMap.ice.id: return 1.4;    // near-frictionless glide — prefer over dirt/sand
        case c.tileMap.bumper.id: return 3.0; // knockback hazard
        // Water: bots now PUNCH-SWIM across (aiController strokes toward the carrot, the
        // same swimImpulse a human gets), so water is a real lane, not the dead-crawl the
        // old 13.0 modelled. But swimming is stamina-gated for everyone — once the bar is
        // spent you stroke only as fast as it regens (regenPerSec/punchCost ≈ 0.4 strokes/s,
        // each stroke a short lunge the high water drag bleeds off) — so the SUSTAINED swim
        // speed is only ~11-13 px/s vs grass ~78, even carrying entry momentum. Measured
        // bot crossings (headless, short and wide bands) land at ~6x grass-time, so 6.5 is
        // the honest cost: bots route THROUGH water only when it's a genuine shortcut (the
        // dry detour is much longer) or the only way across, and otherwise take a dry lane —
        // matching how slow water really is. Never blocked, so maps stay reachable/par-valid
        // and a water-only crossing is a slow slog, not a stall.
        case (c.tileMap.water != null ? c.tileMap.water.id : -999): return 6.5;
        default: return 1.0; // goal, ability, random
    }
}

// Doorway model. A kart is playerBaseRadius*2 wide (15px):
//  - a shared border narrower than the kart is a WALL — physically impossible,
//    so routes, par times, the editor overlay, and goal reachability all refuse
//    it (a goal whose only entrance is a pin-point reads as unreachable);
//  - a border the kart fits through but without comfortable clearance
//    (< MIN_DOORWAY) is heavily penalized, so routes only thread a tight gap
//    when no wider lane exists (committed maps like TheIsland/Shortcut have
//    mandatory tight doors that players really do squeeze — those stay valid).
var KART_WIDTH = (c.playerBaseRadius || 7.5) * 2;       // 15px: hard physical limit
var MIN_DOORWAY = KART_WIDTH + 11;                       // 26px: comfortable clearance
var TIGHT_DOORWAY_PENALTY = 8;                           // cost x for kart-fits-but-tight

function buildAdjacency(map) {
    var cells = map.cells;
    var idToIndex = {};
    for (var i = 0; i < cells.length; i++) {
        if (cells[i] && cells[i].site && typeof cells[i].site.voronoiId === "number") {
            idToIndex[cells[i].site.voronoiId] = i;
        }
    }
    var neighbors = new Array(cells.length);
    var doorways = new Array(cells.length); // parallel: shared-border length per neighbor
    for (var ci = 0; ci < cells.length; ci++) {
        var cell = cells[ci];
        var set = {};
        var list = [];
        var widths = [];
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
                    // The crossing width is the shared border's length. Missing
                    // vertices (degenerate data) count as wide so nothing breaks.
                    if (edge.va && edge.vb) {
                        var wx = edge.va.x - edge.vb.x, wy = edge.va.y - edge.vb.y;
                        widths.push(Math.sqrt(wx * wx + wy * wy));
                    } else {
                        widths.push(Infinity);
                    }
                }
            }
        }
        neighbors[ci] = list;
        doorways[ci] = widths;
    }
    // idToIndex (voronoiId -> cell index) is built above for adjacency and exposed here
    // so callers needing the same lookup (e.g. the locked-door AI resolving a door's home
    // cell) reuse this cached table instead of rebuilding it per tick.
    return { neighbors: neighbors, doorways: doorways, idToIndex: idToIndex };
}

function getAdjacency(map) {
    var key = (map.id != null ? map.id : "anon") + ":" + map.cells.length;
    var entry = adjacencyCache.get(key);
    if (entry && entry.count === map.cells.length) {
        return entry.adj;
    }
    var adj = buildAdjacency(map);
    adjacencyCache.set(key, { adj: adj, count: map.cells.length });
    return adj;
}

// Author-placed barriers (engine.bounceOffBarriers) are solid segments the cell
// graph doesn't otherwise know about — they block travel ACROSS a cell boundary,
// not occupancy of a cell, so they're modelled as blocked adjacency EDGES, not
// penalized cells. An edge u<->v is "barrier-crossed" when a barrier segment cuts
// the SHARED VORONOI BORDER between the two cells (edge.va–edge.vb) — the doorway
// the kart actually drives through. (It used to test the site-to-site centroid
// line, which a barrier can cross while leaving the real border wide open — a
// false seal that wrongly rejected maps whose author left lane-gaps between wall
// segments — confirmed against a free-space flood-fill: the centroid test sealed
// maps a kart can physically drive through.) `barrierTouchesBorder` also catches the
// collinear case a wall laid exactly ALONG a doorway (axis-aligned wall over an
// axis-aligned border) where a proper crossing test reads "no cross." Sub-kart-width
// gaps are handled by the KART_WIDTH pin-point gate in findPathToNearestGoal. Bot
// routes apply a heavy SOFT penalty to these edges (steer around the open ends);
// validation/reachability HARD-blocks them (a wall that seals every route makes the
// goal unreachable). Computed once per map object and cached on it (non-enumerable) —
// barriers never change within a loaded map, and currentMap is a fresh per-round
// copy, so no signature/global cache is needed. (Limitation: a wall running through a
// cell PARALLEL to its borders blocks transit the per-edge border test can't see;
// real editor maps don't place walls exactly on cell centres, and the engine's
// bounceOffBarriers stops a bot physically regardless, so routing self-corrects.)
function getBarrierBlockedEdges(map) {
    if (!map || !Array.isArray(map.cells)) { return null; }
    if (map._barrierBlockedEdges !== undefined) { return map._barrierBlockedEdges; }
    var result = null;
    if (Array.isArray(map.barriers) && map.barriers.length > 0) {
        var adj = getAdjacency(map);
        var idToIndex = adj.idToIndex;
        var cells = map.cells;
        var bars = map.barriers;
        var blocked = new Set();
        for (var ci = 0; ci < cells.length; ci++) {
            var cell = cells[ci];
            if (!cell || !cell.site || !Array.isArray(cell.halfedges)) { continue; }
            var own = cell.site.voronoiId;
            for (var h = 0; h < cell.halfedges.length; h++) {
                var he = cell.halfedges[h];
                var edge = he && he.edge;
                // Need the shared-border segment (va–vb) to test against; skip
                // boundary edges (one null site) and degenerate ones (no verts).
                if (!edge || !edge.va || !edge.vb) { continue; }
                var otherId = null;
                if (edge.lSite && edge.lSite.voronoiId !== own) { otherId = edge.lSite.voronoiId; }
                else if (edge.rSite && edge.rSite.voronoiId !== own) { otherId = edge.rSite.voronoiId; }
                if (otherId == null) { continue; }
                var ni = idToIndex[otherId];
                if (ni == null || ni === ci || ni < ci) { continue; } // each undirected pair once
                for (var bi = 0; bi < bars.length; bi++) {
                    var bar = bars[bi];
                    if (bar == null) { continue; }
                    if (barrierTouchesBorder(edge.va.x, edge.va.y, edge.vb.x, edge.vb.y, bar.x1, bar.y1, bar.x2, bar.y2)) {
                        blocked.add(ci + "|" + ni);
                        blocked.add(ni + "|" + ci);
                        break;
                    }
                }
            }
        }
        if (blocked.size > 0) { result = blocked; }
    }
    Object.defineProperty(map, '_barrierBlockedEdges', { value: result, enumerable: false, writable: true, configurable: true });
    return result;
}

// The shared border segment {va,vb} between two cells (cellA's halfedge facing cellB).
function sharedBorderSeg(cellA, cellB) {
    if (!cellA || !cellB || !cellB.site || !Array.isArray(cellA.halfedges)) { return null; }
    var other = cellB.site.voronoiId;
    for (var h = 0; h < cellA.halfedges.length; h++) {
        var e = cellA.halfedges[h] && cellA.halfedges[h].edge;
        if (!e || !e.va || !e.vb) { continue; }
        if ((e.lSite && e.lSite.voronoiId === other) || (e.rSite && e.rSite.voronoiId === other)) {
            return e;
        }
    }
    return null;
}

// A barrier draws/collides as a 14px bar (engine.bounceOffBarriers BARRIER_HALF_WIDTH = 7);
// a kart's centre is held BARRIER_HALF_WIDTH + radius off the wall centre line. Topology
// decisions here use that same half-width so the route only threads gaps a real kart fits.
var BARRIER_HALF_WIDTH = 7;

// Crossing-number point-in-cell test over the cell's halfedge boundary segments (va–vb).
// Order-independent (works on the raw, unsorted halfedge list): true when (x,y) lies inside
// the Voronoi polygon. Used to find a barrier's FREE END — the endpoint terminating inside a
// cell.
function pointInCell(cell, x, y) {
    if (!cell || !Array.isArray(cell.halfedges)) { return false; }
    var inside = false;
    for (var h = 0; h < cell.halfedges.length; h++) {
        var e = cell.halfedges[h] && cell.halfedges[h].edge;
        if (!e || !e.va || !e.vb) { continue; }
        var x1 = e.va.x, y1 = e.va.y, x2 = e.vb.x, y2 = e.vb.y;
        if ((y1 > y) !== (y2 > y)) {
            var xint = x1 + (y - y1) / (y2 - y1) * (x2 - x1);
            if (x < xint) { inside = !inside; }
        }
    }
    return inside;
}

// Clearance to "round" a barrier's free end F (the endpoint inside the cell): shoot a ray
// from F continuing along the wall axis (away from the boundary it entered through, i.e.
// F - otherEnd) and return the distance to the cell boundary it next hits — how much room a
// kart has to slip PAST the tip and reach the wall's far side without leaving this cell. A
// small gap means the wall nearly touches the far boundary, so a thick kart can't round it
// inside the cell and it bisects the cell like a full crossing. Infinity if the ray exits no
// edge (degenerate) — treated as roundable.
function freeEndRoundGap(cell, fx, fy, ox, oy) {
    var dx = fx - ox, dy = fy - oy, L = Math.hypot(dx, dy) || 1;
    var ux = dx / L, uy = dy / L;
    var best = Infinity;
    for (var h = 0; h < cell.halfedges.length; h++) {
        var e = cell.halfedges[h] && cell.halfedges[h].edge;
        if (!e || !e.va || !e.vb) { continue; }
        var sx = e.va.x, sy = e.va.y, sdx = e.vb.x - e.va.x, sdy = e.vb.y - e.va.y;
        var den = ux * sdy - uy * sdx;
        if (Math.abs(den) < 1e-9) { continue; } // ray parallel to this edge
        var t = ((sx - fx) * sdy - (sy - fy) * sdx) / den; // distance along the ray
        var u = ((sx - fx) * uy - (sy - fy) * ux) / den;   // param along the edge
        if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) { best = t; }
    }
    return best;
}

// Min distance from (x,y) to any author barrier's centre line (Infinity if none).
function barrierMinDist(x, y, barriers) {
    var m = Infinity;
    for (var i = 0; i < barriers.length; i++) {
        var b = barriers[i];
        if (b == null) { continue; }
        var d = ptSegDist(x, y, b.x1, b.y1, b.x2, b.y2).d;
        if (d < m) { m = d; }
    }
    return m;
}

// Does a kart (centre x,y, radius R) overlap any non-drivable cell (lava/empty/shut door)?
// Tested on the rim, the way the engine keeps a kart's body out of lava — so a doorway's
// crossing point can't sit where the kart would hang into the lava.
function kartDiscHitsBlocked(map, x, y) {
    if (!pointDrivable(map, x, y)) { return true; }
    var R = c.playerBaseRadius || 7.5;
    for (var a = 0; a < 8; a++) {
        var ang = a / 8 * Math.PI * 2;
        if (!pointDrivable(map, x + Math.cos(ang) * R, y + Math.sin(ang) * R)) { return true; }
    }
    return false;
}

// Effective passable doorway across a shared border {va,vb}, thickness-aware. The Voronoi
// border LENGTH is the wrong gap measure once walls exist: it overstates a gap a wall
// bisects, and UNDERSTATES one where two cells merely touch at a short edge while the free
// space around it is open (so a real kart crosses through a "narrow" border). Instead sample
// the border, keep the points whose kart disc clears lava, and take the one with the most
// room to the nearest wall: width = 2*(clearance - BARRIER_HALF_WIDTH) is the kart diameter
// that fits there (>= KART_WIDTH exactly when the kart centre sits a full radius clear of the
// wall body). The argmax point {x,y} is the crossing the drawn line and the bot thread —
// always kart-clear of the wall, so the leg through it never overlaps the bar. width 0 (no
// kart-safe point) means a wall/lava seals the doorway.
//
// NOTE the returned `width` is a CLEARANCE-derived diameter, not the Voronoi border length —
// so the downstream KART_WIDTH (cut) and MIN_DOORWAY (tight) gates read a doorway's real
// kart-fit, which is the point: a short border with open space is NOT tight, and a wall body
// eating into a wide border IS. (Lava only seals — width 0 when no rim-clear sample exists;
// it doesn't otherwise shrink the width, since lava is already a cell-level block in routing.)
function doorwayCrossing(map, border) {
    var barriers = map.barriers;
    var ax = border.va.x, ay = border.va.y, bx = border.vb.x, by = border.vb.y;
    var mx = (ax + bx) / 2, my = (ay + by) / 2;
    var len = Math.hypot(bx - ax, by - ay);
    // Fast path: when the WHOLE border sits well clear of every wall (the nearest barrier to
    // the midpoint is farther than half the border plus a comfortable doorway), no wall
    // constrains any point of it — every point is wide-open, so the midpoint is a valid widest
    // crossing and one lava-disc test there is enough. Skips the per-sample sweep (the costly
    // 9x-nearestCell-per-step part) for the many open doorways far from any author wall.
    if (barrierMinDist(mx, my, barriers) - len / 2 > BARRIER_HALF_WIDTH + MIN_DOORWAY / 2 && !kartDiscHitsBlocked(map, mx, my)) {
        return { width: 2 * (barrierMinDist(mx, my, barriers) - BARRIER_HALF_WIDTH), x: Math.round(mx), y: Math.round(my) };
    }
    var steps = Math.max(2, Math.ceil(len / 2));
    var best = -Infinity, bcx = mx, bcy = my;
    for (var s = 0; s <= steps; s++) {
        var t = s / steps;
        var px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        if (kartDiscHitsBlocked(map, px, py)) { continue; }
        var clr = barrierMinDist(px, py, barriers) - BARRIER_HALF_WIDTH;
        if (clr > best) { best = clr; bcx = px; bcy = py; }
    }
    if (best === -Infinity) { return { width: 0, x: Math.round(bcx), y: Math.round(bcy) }; }
    return { width: best * 2, x: Math.round(bcx), y: Math.round(bcy) };
}

// Per-cell transit model (navigation graph). A barrier that runs THROUGH a cell's
// interior — entering and leaving across its boundary — splits that cell into two
// pieces a kart can't drive between, even though neither the shared border with a
// neighbour nor the site-to-site line is cut. That's a property of transiting THROUGH
// a cell, not of any single doorway, so the per-edge block test (getBarrierBlockedEdges)
// can't express it. Here we model it directly: a split cell becomes multiple REGION
// nodes (one per piece), and a doorway connects the region of one cell to the region of
// its neighbour it actually touches. Doorways a wall cuts outright are dropped. Cells no
// barrier passes through stay a single node, so a barrier-free map yields a graph
// identical to the raw cell adjacency (findPathToNearestGoal behaves exactly as before).
// Result: { count, cellOf[node]->cellIdx (null = identity), regionsOfCell[cellIdx]->[node],
// neighbors[node]->[node], doorways[node]->[width], regionForPoint(cellIdx,x,y)->node }.
// Cached on the map object (non-enumerable), like adjacency.
function getNavGraph(map) {
    if (map._navGraph !== undefined) { return map._navGraph; }
    var adj = getAdjacency(map);
    var cells = map.cells;
    var bars = (Array.isArray(map.barriers) && map.barriers.length > 0) ? map.barriers : null;
    var nav;

    // Fast path: no barriers -> regions ARE cells, 1:1 (identity; allocation-free).
    if (bars == null) {
        nav = {
            count: cells.length, cellOf: null, regionsOfCell: null,
            neighbors: adj.neighbors, doorways: adj.doorways,
            cellPairCrossing: null,
            regionForPoint: function (ci) { return ci; }
        };
        Object.defineProperty(map, '_navGraph', { value: nav, enumerable: false, writable: true, configurable: true });
        return nav;
    }

    // Which barriers SPLIT each cell into pieces a thick kart can't drive between:
    //  - a barrier crossing the cell boundary >= 2 times runs clean through it; or
    //  - a PARTIAL wall (one free end inside the cell) whose tip reaches within KART_WIDTH of
    //    the far boundary — the gap to round the end is narrower than the kart, so it walls
    //    the cell off just like a full crossing. A partial wall with room to spare around its
    //    tip is NOT a split (the kart drives around it; the detour keeps the drawn line clear).
    // Matching the engine's capsule collision closes D Day's wall-ends-in-lava cluster, where
    // two doorways sat on opposite sides of a one-crossing wall and the straight line cut it.
    var splitBars = new Array(cells.length);
    for (var ci = 0; ci < cells.length; ci++) {
        var cell = cells[ci];
        var list = [];
        if (cell && Array.isArray(cell.halfedges)) {
            for (var bi = 0; bi < bars.length; bi++) {
                var bar = bars[bi];
                if (bar == null) { continue; }
                var hits = 0;
                for (var h = 0; h < cell.halfedges.length; h++) {
                    var e = cell.halfedges[h] && cell.halfedges[h].edge;
                    if (!e || !e.va || !e.vb) { continue; }
                    if (barrierTouchesBorder(e.va.x, e.va.y, e.vb.x, e.vb.y, bar.x1, bar.y1, bar.x2, bar.y2)) {
                        if (++hits >= 2) { break; }
                    }
                }
                if (hits >= 2) {
                    list.push(bi);
                } else if (hits === 1) {
                    // One crossing => exactly one endpoint sits inside the cell (the free end).
                    var in1 = pointInCell(cell, bar.x1, bar.y1);
                    var in2 = pointInCell(cell, bar.x2, bar.y2);
                    if (in1 !== in2) {
                        var fx = in1 ? bar.x1 : bar.x2, fy = in1 ? bar.y1 : bar.y2;
                        var ox = in1 ? bar.x2 : bar.x1, oy = in1 ? bar.y2 : bar.y1;
                        if (freeEndRoundGap(cell, fx, fy, ox, oy) < KART_WIDTH) { list.push(bi); }
                    }
                }
            }
        }
        splitBars[ci] = list;
    }

    // Side-label of a point within a cell: a sign string over the cell's splitting
    // barriers. Two points with the same label are in the same piece.
    function labelOf(ci, x, y) {
        var sb = splitBars[ci];
        if (sb.length === 0) { return ""; }
        var key = "";
        for (var i = 0; i < sb.length; i++) {
            var bar = bars[sb[i]];
            key += (sideOf(bar.x1, bar.y1, bar.x2, bar.y2, x, y) >= 0) ? "1" : "0";
        }
        return key;
    }

    var regionsOfCell = new Array(cells.length);
    var cellOf = [];
    var labelToRegion = new Array(cells.length); // ci -> { label -> nodeId }
    function regionId(ci, label) {
        var m = labelToRegion[ci];
        if (m == null) { m = labelToRegion[ci] = {}; }
        if (m[label] == null) {
            m[label] = cellOf.length;
            cellOf.push(ci);
            if (regionsOfCell[ci] == null) { regionsOfCell[ci] = []; }
            regionsOfCell[ci].push(m[label]);
        }
        return m[label];
    }
    // Every cell gets at least its site-region, so an unsplit cell maps cleanly and a
    // seed at the site always resolves.
    for (var cs = 0; cs < cells.length; cs++) {
        var s = cells[cs] && cells[cs].site;
        regionId(cs, s ? labelOf(cs, s.x, s.y) : "");
    }

    var neighbors = adj.neighbors;
    var rNeighbors = [], rDoorways = [];
    var cellPairCrossing = {}; // "ca|cb" (cell indices) -> {x,y,width} widest kart-fitting crossing
    var crossCache = {};       // unordered pair "min|max" -> doorwayCrossing (one per border, both directions reuse)
    function ensureNode(n) { while (rNeighbors.length <= n) { rNeighbors.push([]); rDoorways.push([]); } }
    for (var ca = 0; ca < cells.length; ca++) {
        var cellA = cells[ca];
        if (!cellA || !cellA.site) { continue; }
        var nbA = neighbors[ca];
        for (var k = 0; k < nbA.length; k++) {
            var cb = nbA[k];
            var border = sharedBorderSeg(cellA, cells[cb]);
            if (border == null) { continue; }
            // Thickness-aware passability: a wall (or lava) leaving no kart-wide gap on the
            // shared border SEALS the doorway (no edge between these pieces); otherwise the
            // kart threads the widest kart-clear point, which becomes this edge's crossing.
            // The crossing is a property of the undirected border, so compute it once and
            // reuse it for the reverse direction (cb->ca) instead of re-sampling.
            var pairKey = (ca < cb) ? (ca + "|" + cb) : (cb + "|" + ca);
            var cross = crossCache[pairKey];
            if (cross === undefined) { cross = crossCache[pairKey] = doorwayCrossing(map, border); }
            if (cross.width < KART_WIDTH) { continue; }
            // Label each piece by the side of its splitting walls the CROSSING POINT lies on
            // (not the border midpoint, which can fall on the wrong side of a partial wall).
            var rA = regionId(ca, labelOf(ca, cross.x, cross.y));
            var rB = regionId(cb, labelOf(cb, cross.x, cross.y));
            ensureNode(rA); ensureNode(rB);
            rNeighbors[rA].push(rB);
            rDoorways[rA].push(cross.width);
            var key = ca + "|" + cb, had = cellPairCrossing[key];
            if (had == null || cross.width > had.width) { cellPairCrossing[key] = { x: cross.x, y: cross.y, width: cross.width }; }
        }
    }
    ensureNode(cellOf.length - 1); // pad arrays for any site-only region with no doorways

    function regionForPoint(ci, x, y) {
        var m = labelToRegion[ci];
        var label = labelOf(ci, x, y);
        if (m != null && m[label] != null) { return m[label]; }
        var sp = cells[ci] && cells[ci].site; // pocket with no doorway: fall back to site-region
        return regionId(ci, sp ? labelOf(ci, sp.x, sp.y) : "");
    }

    nav = {
        count: cellOf.length, cellOf: cellOf, regionsOfCell: regionsOfCell,
        neighbors: rNeighbors, doorways: rDoorways,
        cellPairCrossing: cellPairCrossing, regionForPoint: regionForPoint
    };
    Object.defineProperty(map, '_navGraph', { value: nav, enumerable: false, writable: true, configurable: true });
    return nav;
}

// A barrier draws as a 14px bar (barrierArt bandHalf = 7), so a drawn/steered line that
// merely doesn't CROSS the centre line can still overlap the bar. Keep this much off the
// centre line — half the bar plus a hair for the line's own width — so the line clears
// the bar visually (and the bot steers through the gap, not along the wall). Matches the
// engine's barrier collision keeping a kart off the wall.
var BARRIER_DRAW_CLEAR = 9;

// Closest point on segment (x1,y1)-(x2,y2) to (px,py): { d, cx, cy }.
function ptSegDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy || 1;
    var t = ((px - x1) * dx + (py - y1) * dy) / l2;
    if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
    var cx = x1 + dx * t, cy = y1 + dy * t;
    return { d: Math.hypot(px - cx, py - cy), cx: cx, cy: cy };
}
function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
    if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) { return 0; }
    return Math.min(
        ptSegDist(ax, ay, cx, cy, dx, dy).d, ptSegDist(bx, by, cx, cy, dx, dy).d,
        ptSegDist(cx, cy, ax, ay, bx, by).d, ptSegDist(dx, dy, ax, ay, bx, by).d
    );
}

// True if segment a->b keeps clear of every author barrier — not just doesn't cut one,
// but stays the bar's half-width off it, so the drawn line never overlaps a wall.
function legClearsBarriers(a, b, barriers) {
    if (!barriers || barriers.length === 0) { return true; }
    for (var i = 0; i < barriers.length; i++) {
        var bar = barriers[i];
        if (bar == null) { continue; }
        if (segSegDist(a.x, a.y, b.x, b.y, bar.x1, bar.y1, bar.x2, bar.y2) < BARRIER_DRAW_CLEAR) { return false; }
    }
    return true;
}

// Nudge any route point sitting on/over a wall out to the bar's edge: push it to
// BARRIER_DRAW_CLEAR off the nearest barrier centre line, but only onto drivable ground
// (don't shove the line into lava to clear a wall). Leaves the gate origin + goal in
// place. The detour pass then fixes any crossing the nudge might introduce.
function pushOffBarriers(map, pts) {
    var barriers = map.barriers;
    if (!barriers || barriers.length === 0 || pts.length < 3) { return pts; }
    var out = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
        var p = pts[i];
        var best = null, bestD = Infinity;
        for (var b = 0; b < barriers.length; b++) {
            var bar = barriers[b];
            if (bar == null) { continue; }
            var r = ptSegDist(p.x, p.y, bar.x1, bar.y1, bar.x2, bar.y2);
            if (r.d < bestD) { bestD = r.d; best = r; }
        }
        if (best != null && bestD < BARRIER_DRAW_CLEAR && bestD > 1e-3) {
            var nx = (p.x - best.cx) / bestD, ny = (p.y - best.cy) / bestD;
            var np = { x: Math.round(best.cx + nx * BARRIER_DRAW_CLEAR), y: Math.round(best.cy + ny * BARRIER_DRAW_CLEAR) };
            if (pointDrivable(map, np.x, np.y)) { p = np; }
        }
        out.push(p);
    }
    out.push(pts[pts.length - 1]);
    return out;
}

// Is point (x,y) on ground a kart can actually sit on? A detour waypoint must land on
// drivable terrain — never lava, an empty hole, or a (shut) door cell — so skirting a
// wall whose END sits in lava doesn't route the line THROUGH the lava.
function pointDrivable(map, x, y) {
    var ci = nearestCellIndex(map.cells, { x: x, y: y });
    var cell = map.cells[ci];
    if (cell == null) { return false; }
    var DOOR = (c.tileMap.door != null) ? c.tileMap.door.id : -999;
    return cell.id !== c.tileMap.lava.id && cell.id !== c.tileMap.empty.id && cell.id !== DOOR;
}

// A waypoint that gets leg a->b clear of the FIRST barrier it isn't clear of — whether it
// CROSSES the wall or merely grazes within the bar's half-width. Crossing: route around
// the wall's nearer FREE END (extend past it along the wall axis, with a perpendicular
// off-step for tight clusters). Grazing: push the leg's closest-approach point straight
// out to the clearance off the wall. Either way the waypoint is accepted only if it lands
// on drivable ground and makes both new sub-legs clear of EVERY barrier — so a wall ending
// in lava is skirted at its WALKABLE end, never into the lava. null when nothing clean
// works (keep the straight leg as the lesser evil).
function barrierDetourPoint(a, b, map) {
    var barriers = map.barriers;
    for (var i = 0; i < barriers.length; i++) {
        var bar = barriers[i];
        if (bar == null) { continue; }
        var crosses = segmentsCross(a.x, a.y, b.x, b.y, bar.x1, bar.y1, bar.x2, bar.y2);
        if (!crosses && segSegDist(a.x, a.y, b.x, b.y, bar.x1, bar.y1, bar.x2, bar.y2) >= BARRIER_DRAW_CLEAR) { continue; }
        var cands = [];
        if (crosses) {
            var ends = [{ x: bar.x1, y: bar.y1 }, { x: bar.x2, y: bar.y2 }];
            var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            ends.sort(function (p, q) { return Math.hypot(p.x - mid.x, p.y - mid.y) - Math.hypot(q.x - mid.x, q.y - mid.y); });
            var REACH = [6, 10, 14, 20, 28, 40, 56];
            for (var e = 0; e < ends.length; e++) {
                var end = ends[e], other = ends[1 - e];
                var dxe = end.x - other.x, dye = end.y - other.y, le = Math.hypot(dxe, dye) || 1;
                var ux = dxe / le, uy = dye / le, ppx = -uy, ppy = ux;
                for (var r = 0; r < REACH.length; r++) {
                    for (var pp = 0; pp <= 2; pp++) {
                        var perp = pp === 0 ? 0 : (pp === 1 ? REACH[r] : -REACH[r]);
                        cands.push({ x: Math.round(end.x + ux * REACH[r] + ppx * perp), y: Math.round(end.y + uy * REACH[r] + ppy * perp) });
                    }
                }
            }
        } else {
            // Graze: lift the leg's closest-approach point off the wall, both normal signs.
            var t = ((((a.x + b.x) / 2) - bar.x1) * (bar.x2 - bar.x1) + (((a.y + b.y) / 2) - bar.y1) * (bar.y2 - bar.y1));
            var cp = ptSegDist((a.x + b.x) / 2, (a.y + b.y) / 2, bar.x1, bar.y1, bar.x2, bar.y2);
            var wlen = Math.hypot(bar.x2 - bar.x1, bar.y2 - bar.y1) || 1;
            var nlx = -(bar.y2 - bar.y1) / wlen, nly = (bar.x2 - bar.x1) / wlen;
            for (var sgn = -1; sgn <= 1; sgn += 2) {
                cands.push({ x: Math.round(cp.cx + nlx * sgn * (BARRIER_DRAW_CLEAR + 2)), y: Math.round(cp.cy + nly * sgn * (BARRIER_DRAW_CLEAR + 2)) });
            }
        }
        for (var ci2 = 0; ci2 < cands.length; ci2++) {
            var wp = cands[ci2];
            if (legClearsBarriers(a, wp, barriers) && legClearsBarriers(wp, b, barriers) && pointDrivable(map, wp.x, wp.y)) { return wp; }
        }
        return null;
    }
    return null;
}

// Insert skirt waypoints so every leg clears the walls (around a crossing, off a graze),
// kept only when they cleanly fix it on drivable ground. Bounded re-try per leg resolves
// a leg that violates more than one wall.
function detourBarriers(map, pts) {
    var barriers = (map && Array.isArray(map.barriers)) ? map.barriers : null;
    if (!barriers || barriers.length === 0 || pts.length < 2) { return pts; }
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
        var b = pts[i];
        var guard = 0;
        while (!legClearsBarriers(out[out.length - 1], b, barriers) && guard++ < 4) {
            var wp = barrierDetourPoint(out[out.length - 1], b, map);
            if (wp == null) { break; }
            out.push(wp);
        }
        out.push(b);
    }
    return out;
}

// Resolve a route's cell-id path to drivable WAYPOINTS — the SINGLE geometry both the
// AI steering (aiController) and the fairness/CI overlay (mapClassifier) follow, so the
// estimated racing line and the bots take the same line through a map. The waypoints are
// the DOORWAY crossings between consecutive cells, then the goal centre — NOT the
// intermediate cell centres, which can sit on the far side of a wall the route legitimately
// skirts. On a barrier map the crossing is the kart-clear point the nav graph already picked
// for that doorway (off any wall body, never the border midpoint, which can land on a wall);
// on a barrier-free map it's just the shared-border midpoint. The route runs on the nav graph
// (barrier-aware), so consecutive doorways of a shared region lie in one drivable piece, and a
// final detour pass skirts any wall END that juts into a traversed cell. Net: no leg crosses a
// barrier. (A barrier-free map has no doorway it needs to dodge, so this is just the
// corner-cutting apex line through the gates.)
function pathWaypoints(map, path) {
    if (!map || !Array.isArray(map.cells) || !Array.isArray(path) || path.length === 0) { return []; }
    var cells = map.cells;
    var idToIndex = getAdjacency(map).idToIndex;
    var hasBarriers = Array.isArray(map.barriers) && map.barriers.length > 0;
    var crossings = hasBarriers ? getNavGraph(map).cellPairCrossing : null;
    var pts = [];
    for (var p = 0; p + 1 < path.length; p++) {
        var ci = idToIndex[path[p]];
        var cn = idToIndex[path[p + 1]];
        if (ci == null || cn == null) { continue; }
        // Barrier map: the doorway's kart-clear crossing point (so the leg threads the real
        // gap, not a midpoint sitting over a wall). Fall back to the border midpoint.
        var cross = crossings ? crossings[ci + "|" + cn] : null;
        if (cross != null) {
            pts.push({ x: cross.x, y: cross.y });
            continue;
        }
        var seg = sharedBorderSeg(cells[ci], cells[cn]);
        if (seg != null && seg.va && seg.vb) {
            pts.push({ x: Math.round((seg.va.x + seg.vb.x) / 2), y: Math.round((seg.va.y + seg.vb.y) / 2) });
        }
    }
    var last = idToIndex[path[path.length - 1]];
    if (last != null && cells[last] && cells[last].site) {
        pts.push({ x: Math.round(cells[last].site.x), y: Math.round(cells[last].site.y) });
    }
    if (!Array.isArray(map.barriers) || map.barriers.length === 0) { return pts; }
    // Lift any point off a wall it overlaps, then skirt any leg that still cuts one.
    return detourBarriers(map, pushOffBarriers(map, pts));
}

// Warp pads (a BOON, config.boons.warpPad, id 958) are PAIRED TELEPORTERS: driving
// onto pad A starts a (distance-based) transit to its partner pad B (and vice-versa),
// preserving velocity. Unlike a barrier (which BLOCKS an adjacency edge), a warp
// pair CREATES a new edge between two arbitrary, normally-unconnected cells — so a
// bot routes THROUGH a pad pair as a shortcut when it shortens the drive to goal,
// and never treats a pad as a dead end. Modelled as a cellIndex -> partnerCellIndex
// map (bidirectional): the teleport covers no ground (geo unchanged) but COSTS the
// transit freeze (transitMs of being stopped), so the edge carries a cost equal to
// the distance the kart could have driven in that time — the warp is only worth
// taking when it saves MORE driving than the freeze costs. Computed once per map
// object and cached (non-enumerable), like barriers.
// The transit freezes the kart for transitMs (distance-based — see warpTransitMs), so price
// the edge at the equivalent grass distance it could have driven in that time (tileWeight 1):
// cost = transitSecs·cruise. Dijkstra then routes through a pair only when the detour it skips
// is longer than that freeze. ~83 px/s is the measured cruise speed (the camera-zoom notes).
var WARP_CRUISE_PX_PER_S = 83;
// Transit duration (ms) for a warp of `dist` px: the kart/camera "travels" the gap at a
// constant warpSpeed px/s, clamped to [minTransitMs, maxTransitMs] — so a long hop reads as a
// longer journey and a short one is quick. This is the SINGLE source of the formula: the
// runtime (hazards.linkWarpPads), the AI edge cost (below), the par estimate (estimatePathTime),
// and the fairness trap check (mapClassifier) all call this, so they can never drift apart.
function warpTransitMs(dist) {
    var cfg = (c.boons && c.boons.warpPad) ? c.boons.warpPad : {};
    var ms = (dist / (cfg.warpSpeed || 380)) * 1000;
    var min = cfg.minTransitMs || 1000, max = cfg.maxTransitMs || 3200;
    return Math.max(min, Math.min(max, ms));
}
function getWarpLinks(map) {
    if (!map || !Array.isArray(map.cells)) { return null; }
    if (map._warpLinks !== undefined) { return map._warpLinks; }
    var result = null;
    var WARP = (c.boons && c.boons.warpPad != null) ? c.boons.warpPad.id : -99999;
    var hazards = Array.isArray(map.hazards) ? map.hazards : [];
    var byPair = {};
    for (var i = 0; i < hazards.length; i++) {
        var hz = hazards[i];
        if (hz == null || hz.id !== WARP) { continue; }
        if (typeof hz.x !== "number" || typeof hz.y !== "number") { continue; }
        // Integer pair ids only (matches WarpPad/linkWarpPads/validateMap) — a malformed
        // fractional pair (1.2 vs 1.8) must NOT truncate into a spurious link.
        if (!Number.isInteger(hz.pair)) { continue; }
        (byPair[hz.pair] || (byPair[hz.pair] = [])).push(hz);
    }
    var cells = map.cells;
    var links = null;
    for (var p in byPair) {
        var pads = byPair[p];
        if (pads.length !== 2) { continue; } // malformed pair (validateMap rejects) — no edge
        var a = nearestCellIndex(cells, pads[0]);
        var b = nearestCellIndex(cells, pads[1]);
        if (a === b) { continue; } // both pads snap to one cell — degenerate, no shortcut
        if (links == null) { links = {}; }
        if (links[a] == null) { links[a] = b; } // first link wins if two pairs overlap a cell
        if (links[b] == null) { links[b] = a; }
    }
    if (links != null) { result = links; }
    Object.defineProperty(map, '_warpLinks', { value: result, enumerable: false, writable: true, configurable: true });
    return result;
}

// Ziplines (a BOON, config.boons.zipline, id 959) are ONE-WAY carried cables: driving onto
// the START post carries you SLOWLY (config.boons.zipline.speed px/s — deliberately slower
// than driving) but UNTOUCHABLE + lava-immune to the FAR post, then drops you there with the
// rail-direction momentum. Like a warp pad it CREATES an edge between two normally-unconnected
// cells (so a bot routes THROUGH it as a shortcut, never a dead end), but it is DIRECTIONAL
// (start -> far only) and the edge COSTS the RIDE TIME (length/speed seconds) — large because
// the ride is slow — so Dijkstra only threads a zip when the driving detour it skips (e.g. the
// long way around a lava chasm the cable spans) is even longer. Modelled as
// startCellIndex -> { to: farCellIndex, rideSec }. Computed once per map and cached (non-enum).
var ZIP_CRUISE_PX_PER_S = 83; // same measured cruise as warp — converts ride seconds into the
// equivalent grass distance a kart could have driven in that time, so the edge cost is in the
// same units as Dijkstra's geo cost and compares apples-to-apples with the driving detour.
function ziplineRideSec(length) {
    var cfg = (c.boons && c.boons.zipline) ? c.boons.zipline : {};
    var speed = cfg.speed || 30;
    return (speed > 0 ? (length || 0) / speed : 0);
}
function ziplineFarPoint(hz) {
    var rad = (hz.angle || 0) * (Math.PI / 180);
    return { x: hz.x + Math.cos(rad) * hz.length, y: hz.y + Math.sin(rad) * hz.length };
}
// A point is "in world" if it's finite and inside the playfield bounds. nearestCellIndex snaps
// EVERY point to a real cell (even one far off-map → a bogus nearest), so off-world boon ends
// must be rejected by bounds, not by a nearestCellIndex sentinel (it never returns one).
function inWorld(x, y) {
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= c.worldWidth && y >= 0 && y <= c.worldHeight;
}
function getZiplineLinks(map) {
    if (!map || !Array.isArray(map.cells)) { return null; }
    if (map._ziplineLinks !== undefined) { return map._ziplineLinks; }
    var ZIP = (c.boons && c.boons.zipline != null) ? c.boons.zipline.id : -99999;
    var hazards = Array.isArray(map.hazards) ? map.hazards : [];
    var cells = map.cells;
    var links = null;
    for (var i = 0; i < hazards.length; i++) {
        var hz = hazards[i];
        if (hz == null || hz.id !== ZIP) { continue; }
        if (typeof hz.x !== "number" || typeof hz.y !== "number") { continue; }
        if (typeof hz.length !== "number" || !isFinite(hz.length) || hz.length <= 0) { continue; }
        if (!Number.isFinite(hz.angle)) { continue; }
        var far = ziplineFarPoint(hz);
        // nearestCellIndex SNAPS any point (even one off the map) to its closest cell — for an
        // off-world end that's a bogus cell, so reject an end outside the world explicitly here
        // (validateMap also rejects authored ones; this guards the fairness/non-validated paths).
        if (!inWorld(hz.x, hz.y) || !inWorld(far.x, far.y)) { continue; }
        var a = nearestCellIndex(cells, { x: hz.x, y: hz.y });
        var b = nearestCellIndex(cells, far);
        if (a === b) { continue; } // both ends snap to one cell — no shortcut edge
        if (links == null) { links = {}; }
        if (links[a] == null) { links[a] = { to: b, rideSec: ziplineRideSec(hz.length) }; } // first wins
    }
    Object.defineProperty(map, '_ziplineLinks', { value: links, enumerable: false, writable: true, configurable: true });
    return links;
}

// Lily pads (a BOON, config.boons.lilyPad, id 960) sit OVER water cells and make them SOLID to
// SKIM across (the swim physics are suppressed while you're on a pad) — so a chain of pads is a
// fast crossing of water that's otherwise a slow swim. Unlike a warp/zip they create NO new edge;
// they just make their own water cell much cheaper to drive. Modelled as a set of water cell
// INDICES that carry a pad, so both the Dijkstra weight and the par-time physics treat a padded
// cell as ~ground instead of deep water — and bots route ACROSS a pad path instead of avoiding
// the water. Cached non-enumerably. (A pad placed off water does nothing, so it's ignored here.)
var LILY_PADDED_WEIGHT = 2.0; // padded water ≈ dirt: far cheaper than open water (tileWeight 6.5),
// a touch above grass (1.0) because the pad sinks so you must keep moving — no camping a stone.
function getLilyPaddedCells(map) {
    if (!map || !Array.isArray(map.cells)) { return null; }
    if (map._lilyPaddedCells !== undefined) { return map._lilyPaddedCells; }
    var result = null;
    var LILY = (c.boons && c.boons.lilyPad != null) ? c.boons.lilyPad.id : -99999;
    var WATER = (c.tileMap.water != null) ? c.tileMap.water.id : -99999;
    var hazards = Array.isArray(map.hazards) ? map.hazards : [];
    var cells = map.cells;
    for (var i = 0; i < hazards.length; i++) {
        var hz = hazards[i];
        if (hz == null || hz.id !== LILY) { continue; }
        if (typeof hz.x !== "number" || typeof hz.y !== "number" || !inWorld(hz.x, hz.y)) { continue; }
        var ci = nearestCellIndex(cells, { x: hz.x, y: hz.y });
        if (cells[ci] == null || cells[ci].id !== WATER) { continue; } // off-water pad = inert
        if (result == null) { result = {}; }
        result[ci] = true;
    }
    Object.defineProperty(map, '_lilyPaddedCells', { value: result, enumerable: false, writable: true, configurable: true });
    return result;
}

// Speed boons — the config.boons that PROPEL a racer along the route (Dash Arrows, Launch
// Pad, Barrel Cannon = a strong directed launch; Slipstream, Slingshot Rings = sustained
// speed) — make their cell worth routing THROUGH, the mirror image of avoiding a hazard.
// They don't change connectivity (unlike warp/zip's new edges or a lily pad turning water
// solid); they just DISCOUNT their own cell's traversal cost (multiplier < 1), so Dijkstra
// leans the racing line + bots toward a boost when it isn't a big detour. Defensive boons
// (Guard Halo, Second Wind, Recharge Spring) don't speed the line and warp/zip/lily are
// modelled elsewhere, so those stay neutral (weight 1, no entry). cellIndex -> multiplier,
// cached non-enumerably. Applied structurally in findPathToNearestGoal so the fairness
// overlay AND the bots pick the same boost-leaning route. (estimatePathTime — the par clock —
// deliberately does NOT credit the transient boost: it walks the chosen path with honest tile
// physics, so a boon steers WHICH line par measures but never makes that line's par read
// artificially fast. The discount is mild — 0.7/0.8 — so it only diverts onto a boost that is
// barely a detour, keeping the par it then measures close to the bare line's.)
function boonRouteMult(id) {
    if (id == null) { return 1; } // malformed hazard with no id is not a boon
    var b = c.boons || {};
    var DASH = b.dashArrows && b.dashArrows.id, LAUNCH = b.launchPad && b.launchPad.id, CANNON = b.barrelCannon && b.barrelCannon.id;
    var SLIP = b.slipstream && b.slipstream.id, RINGS = b.slingshotRings && b.slingshotRings.id;
    if (id === DASH || id === LAUNCH || id === CANNON) { return 0.7; } // strong directed launch
    if (id === SLIP || id === RINGS) { return 0.8; }                   // sustained speed help
    return 1;                                                          // defensive / shortcut / not a boon
}
function getBoonRouteWeights(map) {
    if (!map || !Array.isArray(map.cells)) { return null; }
    if (map._boonRouteWeights !== undefined) { return map._boonRouteWeights; }
    var result = null;
    var hazards = Array.isArray(map.hazards) ? map.hazards : [];
    var cells = map.cells;
    for (var i = 0; i < hazards.length; i++) {
        var hz = hazards[i];
        if (hz == null || typeof hz.x !== "number" || typeof hz.y !== "number" || !inWorld(hz.x, hz.y)) { continue; }
        var m = boonRouteMult(hz.id);
        if (m >= 1) { continue; }
        var ci = nearestCellIndex(cells, { x: hz.x, y: hz.y });
        var cell = cells[ci];
        if (cell == null) { continue; }
        // A boon over a non-drivable cell (lava/empty/shut door) is inert — the cell is never
        // entered in routing — so don't record a (dead) discount for it (mirrors lily's water gate).
        var DOOR = (c.tileMap.door != null) ? c.tileMap.door.id : -999;
        if (cell.id === c.tileMap.lava.id || cell.id === c.tileMap.empty.id || cell.id === DOOR) { continue; }
        // Keep the boon's POINT, not just its cell: when a barrier SPLITS the cell, the discount
        // must reach only the region piece the boon actually sits in (getBoonRegionWeights resolves
        // it), never the walled-off side.
        if (result == null) { result = {}; }
        (result[ci] || (result[ci] = [])).push({ m: m, x: hz.x, y: hz.y });
    }
    Object.defineProperty(map, '_boonRouteWeights', { value: result, enumerable: false, writable: true, configurable: true });
    return result;
}

// Speed-boon discounts keyed by nav-graph REGION NODE (not raw cell index): for a cell a
// barrier splits into pieces, the boost reaches only the piece that actually holds the boon —
// the kart on the walled-off side gets no pull toward a boost it can't reach. region node ->
// strongest (smallest) multiplier; cached non-enumerably. On a barrier-free map regionForPoint
// is the identity, so this is just the per-cell discount keyed by cell index.
function getBoonRegionWeights(map) {
    if (!map || !Array.isArray(map.cells)) { return null; }
    if (map._boonRegionWeights !== undefined) { return map._boonRegionWeights; }
    var cellW = getBoonRouteWeights(map);
    var result = null;
    if (cellW != null) {
        var nav = getNavGraph(map);
        for (var ci in cellW) {
            var entries = cellW[ci];
            for (var j = 0; j < entries.length; j++) {
                var en = entries[j];
                var node = nav.regionForPoint(+ci, en.x, en.y);
                if (result == null) { result = {}; }
                if (result[node] == null || en.m < result[node]) { result[node] = en.m; }
            }
        }
    }
    Object.defineProperty(map, '_boonRegionWeights', { value: result, enumerable: false, writable: true, configurable: true });
    return result;
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
    // Navigation graph: cells, but with any cell a barrier runs THROUGH split into
    // region-nodes so a wall bisecting a cell blocks transit across it (see getNavGraph).
    // Barrier-free maps return an identity (node === cell index), so behaviour is
    // unchanged there. cellOf=null means identity; cellAt/navCell handle both.
    var nav = getNavGraph(map);
    var neighbors = nav.neighbors;
    var doorways = nav.doorways;
    var navCellOf = nav.cellOf;
    function navCell(n) { return navCellOf ? navCellOf[n] : n; }
    function cellAt(n) { return cells[navCell(n)]; }
    function firstRegionOf(c) { return nav.regionsOfCell ? nav.regionsOfCell[c][0] : c; }
    // options.noWarp disables the warp-pad shortcut edges, so the route is the pure DRIVING
    // path — used by the fairness layer to measure each pad's drive-distance to goal (and
    // hence whether a warp is a backward TRAP) without the warp shortening it circularly.
    var warpLinks = options.noWarp ? null : getWarpLinks(map);
    // options.noZip disables the zipline shortcut edges (same role as noWarp) so the fairness
    // layer can measure the pure-driving route a racer would take WITHOUT a cable.
    var zipLinks = options.noZip ? null : getZiplineLinks(map);
    // Lily pads make their water cell cheap to skim — always on (a pad is better FOOTING, not a
    // shortcut edge, so it's part of the honest driving route even in the no-shortcut measure).
    var lilyCells = getLilyPaddedCells(map);
    var boonW = getBoonRegionWeights(map); // region node -> speed-boon discount (< 1); split-cell aware
    var LAVA = c.tileMap.lava.id;
    var GOAL = c.tileMap.goal.id;
    var EMPTY = c.tileMap.empty.id;
    // A LOCKED door cell carries tileMap.door.id and is a wall (the engine bounces karts
    // off it) until its key unlocks it (cell flips to normal). Block it like an empty hole
    // so runtime routing (bonus-orb racing lines, AI pathing) goes around a shut door. At
    // author/validation time doors are entities, not cells, so this never blocks the
    // submit-time reachability walk (the goal stays reachable through the future door).
    // options.passableDoors: treat door cells as walkable terrain instead (cost = normal).
    // The locked-door AI uses this to ask "would the goal be reachable if the doors were
    // open?" — and reads which door cells the resulting route crosses to learn WHICH doors
    // it must unlock (the keys to fetch). It never affects live racing routes.
    // options.openDoorIds: a narrower form — treat ONLY these door cells (by voronoiId) as
    // open, the rest stay walls. The shortcut AI uses it to cost the route a carrier of ONE
    // key would actually get (its single door open, others still shut) — passableDoors would
    // over-open every door and overstate the saving on a multi-door map.
    var DOOR = (c.tileMap.door != null) ? c.tileMap.door.id : -999;
    var allowDoors = options.passableDoors === true;
    var openDoorSet = null;
    if (options.openDoorIds != null) {
        openDoorSet = {};
        if (options.openDoorIds.forEach) { options.openDoorIds.forEach(function (id) { openDoorSet[id] = true; }); }
        else if (Array.isArray(options.openDoorIds)) { for (var od = 0; od < options.openDoorIds.length; od++) { openDoorSet[options.openDoorIds[od]] = true; } }
        else { for (var ok in options.openDoorIds) { if (options.openDoorIds[ok]) { openDoorSet[ok] = true; } } }
    }

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
    // A second independent pair (penaltySet2/penaltyMult2) lets a caller price two
    // hazard classes differently (e.g. static bumpers harsh, timeable moving rails
    // mild); on overlap the harsher multiplier wins.
    var penalty = null;
    function addPenalties(set, mult) {
        if (!set || !(mult > 1)) { return; }
        if (penalty == null) { penalty = {}; }
        var put = function (id) { if (!(penalty[id] >= mult)) { penalty[id] = mult; } };
        if (set.forEach) { set.forEach(put); }
        else { for (var pj = 0; pj < set.length; pj++) { put(set[pj]); } }
    }
    addPenalties(options.penaltySet, options.penaltyMult || 1);
    addPenalties(options.penaltySet2, options.penaltyMult2 || 1);

    // Soft ATTRACTION — the mirror of penaltySet: cells the caller wants the route to LEAN
    // toward, as a cost multiplier < 1 on the destination, so the route detours to one only
    // when it isn't a big backtrack (e.g. the AI pulling toward a Checkpoint flag it wants to
    // attune). options.preferCells: { voronoiId -> mult } with 0 < mult <= 1; strongest
    // (smallest) pull wins on overlap. Unset -> no attraction.
    var prefer = (options.preferCells && typeof options.preferCells === 'object') ? options.preferCells : null;

    // Author barriers are modelled structurally by the nav graph (getNavGraph): cut
    // doorways are absent and bisected cells are split, so reachability/validation are
    // correct without any per-edge option. options.barrierEdges/barrierMult remain a
    // purely OPTIONAL soft route-shaping hint (cell-index keyed "u|v" pairs) — keep a
    // passable edge near a wall a touch costlier so a route prefers open ground.
    var barrierEdges = options.barrierEdges || null;
    var barrierMult = (options.barrierMult > 1) ? options.barrierMult : 1;

    // Optional explicit goal cells (voronoiId set/array). When given, the search
    // homes on THESE cells instead of GOAL-id tiles — used by the Bunker round,
    // where the goal is buried (no goal tiles exist) but bots must still path to
    // the safe bunker island. Accepts a Set, an array, or an object map.
    var goalSet = null;
    if (options.goalSet) {
        goalSet = {};
        if (options.goalSet.forEach) {
            options.goalSet.forEach(function (id) { goalSet[id] = true; });
        } else if (Array.isArray(options.goalSet)) {
            for (var gs = 0; gs < options.goalSet.length; gs++) { goalSet[options.goalSet[gs]] = true; }
        } else {
            for (var gk in options.goalSet) { if (options.goalSet[gk]) { goalSet[gk] = true; } }
        }
    }

    var startCell = nearestCellIndex(cells, point);

    // An empty hole is a hard no-go surface (players bounce off it), so a route can't
    // originate inside one. Unlike lava — where a start gate may legitimately sit and
    // the seed is allowed — seeding Dijkstra from a hole would falsely "reach" the goal
    // via adjacent ground even though racers can't launch through that lane (a start
    // edge sampled into a hole must read as unreachable, not pathable).
    if (cells[startCell] != null && cells[startCell].id === EMPTY) {
        return null;
    }
    var start = nav.regionForPoint(startCell, point.x, point.y);

    var N = nav.count;
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
        // cheapest-cost reachable goal. An explicit goalSet (Bunker) overrides the
        // GOAL-id test, since the buried goal has no goal tiles to find.
        if (goalSet ? goalSet[cellAt(u).site.voronoiId] : cellAt(u).id === GOAL) {
            goalIndex = u;
            break;
        }
        var nbrs = neighbors[u];
        var doors = doorways[u];
        for (var k = 0; k < nbrs.length; k++) {
            var v = nbrs[k];
            if (done[v]) {
                continue;
            }
            var cellV = cellAt(v);
            // A pin-point doorway (shared border narrower than the kart itself)
            // is a wall: nobody can physically thread it, so routes — and goal
            // reachability — must not depend on it.
            if (doors[k] < KART_WIDTH) {
                continue;
            }
            // Lava and empty holes are impassable; so are caller-blocked cells. The
            // goal is always enterable. The start cell is allowed even if it sits on
            // lava. A door cell is a wall unless passableDoors opens all of them, or this
            // specific door is in openDoorIds.
            var doorOpen = allowDoors || (openDoorSet != null && openDoorSet[cellV.site.voronoiId]);
            if ((cellV.id === LAVA || cellV.id === EMPTY || (cellV.id === DOOR && !doorOpen)) && cellV.id !== GOAL) {
                continue;
            }
            if (blocked && blocked[cellV.site.voronoiId]) {
                continue;
            }
            // Author barriers are handled structurally by the nav graph (getNavGraph):
            // edges a wall cuts are absent, and a cell a wall bisects is split, so an
            // edge that survives here is genuinely traversable. No per-edge block needed.
            var step = dist(cellAt(u).site, cellV.site);
            var pen = (penalty && penalty[cellV.site.voronoiId]) || 1;
            // Kart fits but it's a squeeze: take it only when no wider lane exists.
            var tight = (doors[k] < MIN_DOORWAY) ? TIGHT_DOORWAY_PENALTY : 1;
            // Optional soft route-shaping hint: prefer to keep clear of a wall even on a
            // passable edge (cell-index keyed; harmless when unset).
            var barr = (barrierMult > 1 && barrierEdges != null && barrierEdges.has(navCell(u) + "|" + navCell(v))) ? barrierMult : 1;
            // A lily pad over this water cell makes it solid to skim — price it like ~ground
            // instead of deep water so bots route ACROSS a pad path rather than around the water.
            var tw = (lilyCells != null && lilyCells[navCell(v)]) ? LILY_PADDED_WEIGHT : tileWeight(cellV.id);
            // Speed boon in this cell -> discount its cost so the route leans toward the boost.
            var bw = (boonW != null && boonW[v] != null) ? boonW[v] : 1; // v is the region node
            // Caller attraction (e.g. AI pulling toward a Checkpoint): discount the cell so the
            // route leans through it when it isn't a big detour.
            var prf = (prefer != null && prefer[cellV.site.voronoiId] != null) ? prefer[cellV.site.voronoiId] : 1;
            var nc = cost[u] + step * tw * bw * prf * cellJitter(cellV.site.voronoiId) * pen * tight * barr;
            if (nc < cost[v]) {
                cost[v] = nc;
                geo[v] = geo[u] + step;
                prev[v] = u;
                heap.push(v, nc);
            }
        }
        // Warp pad shortcut: if `u` holds a pad, its partner pad's cell is reachable by
        // teleport — an edge that covers no ground (geo unchanged) and preserves speed, but
        // COSTS the transit freeze (transitMs of being stopped, distance-based on the gap).
        // Price it at the grass distance the kart could have driven in that time, so Dijkstra
        // threads the pair only when the detour it skips is longer. Respect the destination's
        // passability (a pad on lava/empty/door, or a caller-blocked cell, isn't a valid exit).
        if (warpLinks != null && warpLinks[navCell(u)] != null) {
            var wv = firstRegionOf(warpLinks[navCell(u)]);
            var cellW = cellAt(wv);
            if (!done[wv] && cellW != null && cellW.site != null &&
                !((cellW.id === LAVA || cellW.id === EMPTY || cellW.id === DOOR) && cellW.id !== GOAL) &&
                !(blocked && blocked[cellW.site.voronoiId])) {
                var warpCost = warpTransitMs(dist(cellAt(u).site, cellW.site)) / 1000 * WARP_CRUISE_PX_PER_S;
                var wnc = cost[u] + warpCost;
                if (wnc < cost[wv]) {
                    cost[wv] = wnc;
                    geo[wv] = geo[u]; // teleport covers no geometric ground
                    prev[wv] = u;
                    heap.push(wv, wnc);
                }
            }
        }
        // Zipline shortcut: a ONE-WAY slow carried edge from this start-post cell to the far-
        // post cell. Covers no ground (geo unchanged) but COSTS the ride time (length/speed),
        // priced at the grass distance the kart could have driven in that time — so Dijkstra
        // threads it only when the driving detour it skips is even longer. The ride is lava-
        // immune (the span between can be anything), but the LANDING (far cell) must be a valid
        // exit, just like a warp.
        if (zipLinks != null && zipLinks[navCell(u)] != null) {
            var zv = firstRegionOf(zipLinks[navCell(u)].to);
            var cellZ = cellAt(zv);
            if (!done[zv] && cellZ != null && cellZ.site != null &&
                !((cellZ.id === LAVA || cellZ.id === EMPTY || cellZ.id === DOOR) && cellZ.id !== GOAL) &&
                !(blocked && blocked[cellZ.site.voronoiId])) {
                var zipCost = zipLinks[navCell(u)].rideSec * ZIP_CRUISE_PX_PER_S;
                var znc = cost[u] + zipCost;
                if (znc < cost[zv]) {
                    cost[zv] = znc;
                    geo[zv] = geo[u]; // the cable covers no geometric ground in the graph
                    prev[zv] = u;
                    heap.push(zv, znc);
                }
            }
        }
    }

    if (goalIndex === -1) {
        return null;
    }

    // Resolve region-nodes back to cell voronoiIds, dropping any consecutive repeat
    // (a route can pass two pieces of one cell only via a detour through other cells,
    // never back-to-back — but guard anyway so downstream sees a clean cell path).
    var path = [];
    for (var node = goalIndex; node !== -1; node = prev[node]) {
        var vid = cellAt(node).site.voronoiId;
        if (path.length === 0 || path[path.length - 1] !== vid) { path.push(vid); }
    }
    path.reverse();

    return {
        path: path,
        distance: geo[goalIndex],
        goal: { x: cellAt(goalIndex).site.x, y: cellAt(goalIndex).site.y },
        goalIndex: navCell(goalIndex),
        startIndex: navCell(start)
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
function estimatePathTime(map, path, noWarp, noZip) {
    if (!map || !Array.isArray(map.cells) || !Array.isArray(path) || path.length < 2) {
        return 0;
    }
    var cells = map.cells;
    // noWarp: price the path as PURE DRIVING (no warp-hop credit). The fairness layer's
    // drive-time measurement passes this so two naturally-ADJACENT partner-pad cells on a
    // no-warp route can't be mistaken for a teleport hop (which would sneak transit time in).
    var warpLinks = noWarp ? null : getWarpLinks(map); // padA->padB hops, not driven
    // noZip: same, for the one-way zipline hops (so the pure-driving measurement never credits
    // a cable's slow carry as covered ground).
    var zipLinks = noZip ? null : getZiplineLinks(map);
    var zipSpeed = (c.boons && c.boons.zipline ? c.boons.zipline.speed : 30) || 30;
    // Lily-padded water cells are driven as ~ground (skim), not deep water — so par reflects the
    // faster crossing, matching the cheaper Dijkstra weight + the engine's solid-footing override.
    var lilyCells = getLilyPaddedCells(map);
    // Reuse the adjacency cache's voronoiId->index table instead of rebuilding it per call
    // (this runs in the AI's per-re-path shortcut hot path on door maps).
    var idToIndex = getAdjacency(map).idToIndex;
    var pts = [];
    for (var p = 0; p < path.length; p++) {
        var ci = idToIndex[path[p]];
        if (ci == null) { continue; }
        var cell = cells[ci];
        var ph = (lilyCells != null && lilyCells[ci]) ? tilePhysics(c.tileMap.normal.id) : tilePhysics(cell.id);
        pts.push({ x: cell.site.x, y: cell.site.y, acel: ph.acel, drag: ph.drag, idx: ci });
    }
    if (pts.length < 2) { return 0; }
    var dt = c.serverTickSpeed / 1000;
    var maxV = c.playerMaxSpeed;
    var v = 0, t = 0;
    for (var seg = 0; seg < pts.length - 1; seg++) {
        var a = pts[seg], b = pts[seg + 1];
        // A warp-pad hop (padA -> partner padB) covers no ground and preserves velocity,
        // but it COSTS the transit freeze: the kart is stopped for the (distance-based)
        // transit, then emerges at its pre-warp speed. So add the transit seconds to par
        // (no distance, v unchanged) and don't brake for it.
        if (warpLinks != null && a.idx != null && warpLinks[a.idx] === b.idx) {
            var hopDist = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
            t += warpTransitMs(hopDist) / 1000;
            continue;
        }
        // A zipline hop (start cell -> far cell) covers no driven ground but COSTS the slow
        // ride (length/speed = rideSec); the racer emerges at the slow carried speed, then
        // re-accelerates on the next segment. No braking into it (boarding zeroes velocity).
        if (zipLinks != null && a.idx != null && zipLinks[a.idx] != null && zipLinks[a.idx].to === b.idx) {
            t += zipLinks[a.idx].rideSec;
            v = zipSpeed;
            continue;
        }
        // Brake for the turn at waypoint `seg`: keep less speed the sharper it is. When
        // the kart ARRIVED at `seg` via a warp (pts[seg-1] -> a was a teleport), its
        // velocity is the PRE-warp heading (pts[seg-2] -> pts[seg-1]), preserved through
        // the portal — not the teleport vector — so the turn to brake for is that heading
        // vs the outgoing one. If the warp was the very first segment there's no prior
        // driven heading (the kart is at rest), so skip the brake. And if the PRE-warp
        // segment was ITSELF a warp (two pads sharing a cell → a back-to-back hop), there's
        // no driven heading to recover, so skip the brake there too rather than mis-use a
        // teleport endpoint.
        var incomingWarp = (seg > 0 && warpLinks != null && pts[seg - 1].idx != null && warpLinks[pts[seg - 1].idx] === a.idx);
        var prevSegWarp = (incomingWarp && seg >= 2 && warpLinks != null && pts[seg - 2].idx != null && warpLinks[pts[seg - 2].idx] === pts[seg - 1].idx);
        var doBrake = (seg > 0) && (!incomingWarp || (seg >= 2 && !prevSegWarp));
        if (doBrake) {
            var px = incomingWarp ? pts[seg - 2] : pts[seg - 1];
            var hx = incomingWarp ? pts[seg - 1].x : a.x;  // head point the incoming vector ends at
            var hy = incomingWarp ? pts[seg - 1].y : a.y;
            var inx = hx - px.x, iny = hy - px.y;
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
// Sample origin points spread along a start edge's inner row (the line racers
// launch from), used both for par-time and for goal-reachability checks.
function edgeSampleOrigins(edge) {
    var W = c.worldWidth, H = c.worldHeight;
    var pts = [];
    if (edge === "top" || edge === "bottom") {
        var fixedY = (edge === "top") ? 40 : H - 40;
        var stepX = W / 10; if (stepX < 1) { stepX = 1; }
        for (var x = 40; x < W; x += stepX) { pts.push({ x: x, y: fixedY }); }
    } else {
        var fixedX = (edge === "right") ? W - 40 : 40;
        var stepY = H / 10; if (stepY < 1) { stepY = 1; }
        for (var y = 40; y < H; y += stepY) { pts.push({ x: fixedX, y: y }); }
    }
    return pts;
}

// True if at least one goal is reachable from somewhere along the given start
// edge. validateMap uses this to reject a map whose goal is walled off from a
// gate (which would leave that side's racers unable to finish) — including a goal
// sealed off by a solid barrier (barriers are hard-blocked here).
function reachableFromEdge(map, edge) {
    var samples = edgeSampleOrigins(edge);
    // findPathToNearestGoal routes on the nav graph, which already drops wall-cut
    // doorways and splits cells a wall bisects — so a barrier that seals every route
    // to the goal makes this return false (validation rejects such maps).
    for (var s = 0; s < samples.length; s++) {
        if (findPathToNearestGoal(map, samples[s]) != null) { return true; }
    }
    return false;
}

// The start edge(s) a map actually launches from: its declared startEdges, or the
// left gate when none are set (gameBoard.resolveStartEdges' runtime default, the
// same fallback computeMapParTime uses). The SINGLE source of this rule so every
// validation surface — live submit (utils.validateMap), the map-submission CI gate
// (validate-submitted-map.js), and the fairness routes (mapClassifier) — resolves
// start edges identically.
function effectiveStartEdges(map) {
    return (Array.isArray(map.startEdges) && map.startEdges.length > 0) ? map.startEdges : ["left"];
}

// First effective start edge with NO goal reachable from it (a map that would
// leave that side's racers unable to finish), or null when every start edge can
// reach a goal. Barrier-aware via reachableFromEdge. This is the one reachability
// gate all three validation surfaces call, so they can never disagree.
function firstUnreachableStartEdge(map) {
    var edges = effectiveStartEdges(map);
    for (var i = 0; i < edges.length; i++) {
        if (!reachableFromEdge(map, edges[i])) { return edges[i]; }
    }
    return null;
}

function computeMapParTime(map) {
    if (!map || !Array.isArray(map.cells) || map.cells.length === 0) {
        return 0;
    }
    // Sample EVERY start edge (not just the first): opposite-edge combos with an
    // off-center goal have genuinely different routes per side, so pool the
    // path-times from all edges and take the median so par reflects both sides.
    var edges = (Array.isArray(map.startEdges) && map.startEdges.length > 0) ? map.startEdges : ["left"];
    var pars = [];
    for (var e = 0; e < edges.length; e++) {
        var samples = edgeSampleOrigins(edges[e]);
        for (var s = 0; s < samples.length; s++) {
            var route = findPathToNearestGoal(map, samples[s]);
            if (route != null) {
                var par = estimatePathTime(map, route.path);
                if (par > 0) { pars.push(par); }
            }
        }
    }
    if (pars.length === 0) { return 0; }
    pars.sort(function (a, b) { return a - b; });
    return pars[Math.floor(pars.length / 2)];
}

module.exports = {
    getAdjacency: getAdjacency,
    buildAdjacency: buildAdjacency,
    getBarrierBlockedEdges: getBarrierBlockedEdges,
    getWarpLinks: getWarpLinks,
    warpTransitMs: warpTransitMs,
    getZiplineLinks: getZiplineLinks,
    ziplineRideSec: ziplineRideSec,
    ziplineFarPoint: ziplineFarPoint,
    getLilyPaddedCells: getLilyPaddedCells,
    nearestCellIndex: nearestCellIndex,
    edgeSampleOrigins: edgeSampleOrigins,
    KART_WIDTH: KART_WIDTH,
    MIN_DOORWAY: MIN_DOORWAY,
    findPathToNearestGoal: findPathToNearestGoal,
    reachableGoalExists: reachableGoalExists,
    reachableFromEdge: reachableFromEdge,
    effectiveStartEdges: effectiveStartEdges,
    firstUnreachableStartEdge: firstUnreachableStartEdge,
    pathWaypoints: pathWaypoints,
    detourBarriers: detourBarriers,
    pushOffBarriers: pushOffBarriers,
    tileWeight: tileWeight,
    BALANCE_WEIGHTED_TILES: BALANCE_WEIGHTED_TILES,
    estimatePathTime: estimatePathTime,
    computeMapParTime: computeMapParTime
};
