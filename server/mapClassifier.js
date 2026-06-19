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
var segmentsCross = require('./geometry.js').segmentsCross;
var mapDifficulty = require('./mapDifficulty.json');

// Resolve a tileMap name -> numeric id from the live config (don't hardcode).
function tileId(config, name) {
    var t = config && config.tileMap && config.tileMap[name];
    return (t && typeof t.id === 'number') ? t.id : -1;
}

// Boons share the map's hazards[] array (they unify with hazards at runtime), but
// they're HELPFUL — they must never count as difficulty or be routed around in
// pathing. Set of config.boons ids so the difficulty/avoidance passes can skip
// them. Returns {} when no boons are configured. Memoized by config object (the
// production caller always passes the same `config`, and classify() resolves the
// set in two places per call) — cf. utils.getKnownIdSets.
var _boonIdSetCache = null;
var _boonIdSetConfig = null;
function boonIdSet(config) {
    if (_boonIdSetConfig === config && _boonIdSetCache != null) {
        return _boonIdSetCache;
    }
    var set = {};
    if (config && config.boons) {
        for (var k in config.boons) {
            if (config.boons[k] && typeof config.boons[k].id === 'number') {
                set[config.boons[k].id] = true;
            }
        }
    }
    _boonIdSetCache = set;
    _boonIdSetConfig = config;
    return set;
}

function bal(config, key, dflt) {
    var b = config && config.balance;
    return (b && b[key] != null) ? b[key] : dflt;
}

function startEdgesOf(map) {
    return (Array.isArray(map.startEdges) && map.startEdges.length > 0) ? map.startEdges : ['left'];
}

// Squared distance from point (px,py) to segment a->b. Shared by the *TrapSeverity
// on-racing-line tests (a pad on a long straight between two waypoints is still "on the
// line" even when far from either endpoint, so test point-to-SEGMENT, not point-to-cell).
function distToSegSq(px, py, a, b) {
    var abx = b.x - a.x, aby = b.y - a.y;
    var len2 = abx * abx + aby * aby;
    var t = (len2 < 1e-6) ? 0 : (((px - a.x) * abx + (py - a.y) * aby) / len2);
    if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
    var cx = a.x + abx * t, cy = a.y + aby * t;
    var dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy;
}

// Build the racing-line context the warp/zip/launch trap-severity passes share: a
// driveTime(x,y) (pure-driving seconds to the nearest goal under `pathOpts`) and an
// onRacingLine(x,y,radius) test against the polyline of every gate sample's route under the
// same options. `pathOpts` is passed straight to cellGraph.findPathToNearestGoal: the warp
// pass uses {noWarp:true} (zip still credited), the zip/launch passes use {noWarp:true,
// noZip:true} (no shortcut credit at all) and therefore share one context. Pricing mirrors
// the options: noZip => estimatePathTime's 4-arg no-zip-credit form. Build it ONCE per
// distinct options per classify() (the caller memoizes) and only when a map actually has
// the relevant placeable, so trap-free maps pay nothing.
function racingLineContext(map, config, pathOpts) {
    var idToCell = {};
    for (var ci = 0; ci < map.cells.length; ci++) {
        var s = map.cells[ci] && map.cells[ci].site;
        if (s != null) { idToCell[s.voronoiId] = map.cells[ci]; }
    }
    var noZip = !!pathOpts.noZip;
    // Author barriers are respected automatically via the nav graph (findPathToNearestGoal),
    // so trap-line geometry already weaves around walls — no extra options needed.
    var opts = pathOpts;
    function driveTime(x, y) {
        var r = cellGraph.findPathToNearestGoal(map, { x: x, y: y }, opts);
        if (r == null) { return Infinity; }
        var t = noZip ? cellGraph.estimatePathTime(map, r.path, true, true)
                      : cellGraph.estimatePathTime(map, r.path, true);
        return (t > 0) ? t : 0;
    }
    var lineSegs = [];
    var edges = startEdgesOf(map);
    for (var e = 0; e < edges.length; e++) {
        var samples = cellGraph.edgeSampleOrigins(edges[e]);
        for (var s2 = 0; s2 < samples.length; s2++) {
            var rr = cellGraph.findPathToNearestGoal(map, samples[s2], opts);
            if (rr == null) { continue; }
            var pts = [];
            for (var pi = 0; pi < rr.path.length; pi++) {
                var cell = idToCell[rr.path[pi]];
                if (cell != null && cell.site != null) { pts.push(cell.site); }
            }
            for (var pj = 0; pj + 1 < pts.length; pj++) { lineSegs.push([pts[pj], pts[pj + 1]]); }
        }
    }
    function onRacingLine(x, y, radius) {
        var r2 = radius * radius;
        for (var si = 0; si < lineSegs.length; si++) {
            if (distToSegSq(x, y, lineSegs[si][0], lineSegs[si][1]) <= r2) { return true; }
        }
        return false;
    }
    return { driveTime: driveTime, onRacingLine: onRacingLine };
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
    // background/empty/door are the non-drivable void/walls — never painted as terrain
    // (a door is placed as an entity and stamped at runtime), so they're outside the
    // composition + routing fairness model by design.
    var skip = { background: true, empty: true, door: true };
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

// The boundary segment {va, vb} that cellA shares with the cell whose voronoiId is
// bId, or null when no shared edge with usable vertices exists.
function sharedEdgeSegment(cellA, bId) {
    if (cellA == null || !Array.isArray(cellA.halfedges)) { return null; }
    for (var h = 0; h < cellA.halfedges.length; h++) {
        var edge = cellA.halfedges[h] && cellA.halfedges[h].edge;
        if (!edge || !edge.va || !edge.vb) { continue; }
        if ((edge.lSite && edge.lSite.voronoiId === bId) || (edge.rSite && edge.rSite.voronoiId === bId)) {
            return { va: edge.va, vb: edge.vb };
        }
    }
    return null;
}

// True if segment a->b clears every author barrier (doesn't cut a solid wall).
function legClearsBarriers(a, b, barriers) {
    if (!barriers || barriers.length === 0) { return true; }
    for (var i = 0; i < barriers.length; i++) {
        var bar = barriers[i];
        if (bar == null) { continue; }
        if (segmentsCross(a.x, a.y, b.x, b.y, bar.x1, bar.y1, bar.x2, bar.y2)) { return false; }
    }
    return true;
}

// Pick the point on the shared border (va..vb) the drawn line should cross between
// two cell centres. Defaults to the midpoint, but a barrier can jut INTO a cell the
// route legitimately passes through (its border with the neighbour is open, so the
// cells are connected, yet a straight centre->midpoint leg clips the wall). The
// border itself is barrier-free, so scan along it for a crossing point whose legs to
// BOTH adjoining centres clear every barrier; fall back to the midpoint when none
// does (degenerate geometry — the smoother/segmentSafe still guards straightenings).
function borderCrossing(prevCentre, nextCentre, seg, barriers) {
    var mid = { x: Math.round((seg.va.x + seg.vb.x) / 2), y: Math.round((seg.va.y + seg.vb.y) / 2) };
    if (!barriers || barriers.length === 0) { return mid; }
    if (legClearsBarriers(prevCentre, mid, barriers) &&
        (nextCentre == null || legClearsBarriers(mid, nextCentre, barriers))) {
        return mid;
    }
    // Sample inward from the border ends (keep off the exact vertices, where cells
    // pinch): t in (0,1), nearest-to-centre first so the line stays natural.
    var SAMPLES = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];
    for (var si = 0; si < SAMPLES.length; si++) {
        var t = SAMPLES[si];
        var pt = { x: Math.round(seg.va.x + (seg.vb.x - seg.va.x) * t), y: Math.round(seg.va.y + (seg.vb.y - seg.va.y) * t) };
        if (legClearsBarriers(prevCentre, pt, barriers) &&
            (nextCentre == null || legClearsBarriers(pt, nextCentre, barriers))) {
            return pt;
        }
    }
    return mid;
}

// Resolve a route's voronoiIds back to drawable points (rounded — these go over
// the wire to the editor overlay, so keep the payload compact). The polyline runs
// centre -> shared-border crossing -> next centre rather than centre -> centre:
// Voronoi cells are convex, so each leg provably stays inside its own (safe) cell,
// where a straight centre-to-centre segment can visually clip across a lava
// neighbour's polygon even though the route never enters it. The border crossing is
// chosen barrier-aware (borderCrossing) so the drawn line threads the open gap a
// wall leaves rather than clipping the wall.
function pathPoints(map, path) {
    var cells = map.cells, idToIndex = {};
    for (var i = 0; i < cells.length; i++) {
        if (cells[i] && cells[i].site) { idToIndex[cells[i].site.voronoiId] = i; }
    }
    var barriers = Array.isArray(map.barriers) ? map.barriers : null;
    var pts = [];
    for (var p = 0; p < path.length; p++) {
        var ci = idToIndex[path[p]];
        if (ci == null) { continue; }
        var centre = { x: Math.round(cells[ci].site.x), y: Math.round(cells[ci].site.y) };
        pts.push(centre);
        if (p + 1 < path.length) {
            var seg = sharedEdgeSegment(cells[ci], path[p + 1]);
            if (seg != null) {
                var nci = idToIndex[path[p + 1]];
                var nextCentre = (nci != null && cells[nci] && cells[nci].site) ? cells[nci].site : null;
                pts.push(borderCrossing(centre, nextCentre, seg, barriers));
            }
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
    var boons = boonIdSet(config);
    var hazards = (Array.isArray(map.hazards) ? map.hazards : []).filter(function (hz) {
        // Boons aid the player — never route around them. This covers the Warp Pad (a
        // boon): it's a SHORTCUT the cellGraph adds to the par route, not an obstacle.
        return hz != null && !boons[hz.id];
    });
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
    var wallId = (config.hazards && config.hazards.bumperWall) ? config.hazards.bumperWall.id : null;
    var wallLen = (config.hazards && config.hazards.bumperWall && config.hazards.bumperWall.width) || 120;
    // Laser gate (a wall along the pylon axis) and crusher (a slab sweeping its rail)
    // both penalize a whole LANE from the anchor along `angle`, like the bumper wall /
    // moving bumper — the gate over its beam length, the crusher over its rail length.
    var gateId = (config.hazards && config.hazards.laserGate) ? config.hazards.laserGate.id : null;
    var gateLen = (config.hazards && config.hazards.laserGate && config.hazards.laserGate.width) || 150;
    var crusherId = (config.hazards && config.hazards.crusher) ? config.hazards.crusher.id : null;
    var crusherLen = (config.hazards && config.hazards.crusher && config.hazards.crusher.railLength) || 150;
    // Magpie drone (railed, like the moving bumper) sweeps its rail from the anchor along
    // `angle` for the rail length — penalize the whole lane, matching the live AI's railCells.
    var magpieId = (config.hazards && config.hazards.magpieDrone) ? config.hazards.magpieDrone.id : null;
    var magpieLen = (config.hazards && config.hazards.magpieDrone && config.hazards.magpieDrone.railLength) || 170;
    // Vortex well: keep the overlay/par estimate in lockstep with the live AI
    // (aiController) — routed around at its strong-pull core (radius * coreFraction),
    // not just a 40px ring at the anchor. coreFraction is shared via config so the
    // two never drift.
    var vortexId = (config.hazards && config.hazards.vortexWell) ? config.hazards.vortexWell.id : null;
    var vortexR = (config.hazards && config.hazards.vortexWell && config.hazards.vortexWell.radius) || 150;
    var vortexCoreFrac = (config.hazards && config.hazards.vortexWell && config.hazards.vortexWell.coreFraction) || 0.6;
    // Rotor: arms sweep a full circle out to orbitRadius, so the danger is the whole RING at
    // arm reach, not the hub cell — penalize that ring (mirrors the live AI's isRotor branch).
    var rotorId = (config.hazards && config.hazards.rotor) ? config.hazards.rotor.id : null;
    var rotorOrbit = (config.hazards && config.hazards.rotor && config.hazards.rotor.orbitRadius) || 70;
    // Sentry turret: penalize the firing CONE (mount arc, out to range) — sample the
    // centre line + both arc edges so the routed line bends out of the line of fire, in
    // lockstep with the live AI (aiController's isTurret cone branch).
    var turretId = (config.hazards && config.hazards.sentryTurret) ? config.hazards.sentryTurret.id : null;
    var turretRange = (config.hazards && config.hazards.sentryTurret && config.hazards.sentryTurret.range) || 300;
    var turretArc = (config.hazards && config.hazards.sentryTurret && config.hazards.sentryTurret.arc) || 110;
    for (var h = 0; h < hazards.length; h++) {
        var hz = hazards[h];
        if (hz == null || typeof hz.x !== "number" || typeof hz.y !== "number") { continue; }
        addAround(hz.x, hz.y);
        if (hz.id === movingId || hz.id === wallId || hz.id === gateId || hz.id === crusherId || hz.id === magpieId) {
            // A railed bumper / crusher / magpie drone sweeps from its anchor along `angle`
            // for the rail length (engine.js confines it parametrically), and a bumper wall /
            // laser gate stands along the same anchor->angle line — penalize the lane.
            var len = railLen;
            if (hz.id === wallId) { len = wallLen; }
            else if (hz.id === gateId) { len = gateLen; }
            else if (hz.id === crusherId) { len = crusherLen; }
            else if (hz.id === magpieId) { len = Number.isFinite(hz.railLength) ? hz.railLength : magpieLen; }
            var rad = (hz.angle || 0) * Math.PI / 180;
            for (var t = 25; t <= len; t += 25) {
                addAround(hz.x + Math.cos(rad) * t, hz.y + Math.sin(rad) * t);
            }
        } else if (hz.id === vortexId) {
            // The well drags karts toward its core across a wide radius — penalize a
            // ring out to the strong-pull core so the routed line bends around the
            // centre, not just the single anchor cell. Use the well's authored
            // (per-instance) radius, falling back to the config max.
            var core = (Number.isFinite(hz.radius) ? hz.radius : vortexR) * vortexCoreFrac;
            for (var ringA = 0; ringA < 8; ringA++) {
                var rr = ringA * Math.PI / 4;
                addAround(hz.x + Math.cos(rr) * core, hz.y + Math.sin(rr) * core);
            }
        } else if (hz.id === rotorId) {
            // Penalize the swept arm-ring at orbit radius (the arms reach the whole circle).
            var orbit = (Number.isFinite(hz.orbitRadius) ? hz.orbitRadius : rotorOrbit);
            for (var rotA = 0; rotA < 8; rotA++) {
                var ra = rotA * Math.PI / 4;
                addAround(hz.x + Math.cos(ra) * orbit, hz.y + Math.sin(ra) * orbit);
            }
        } else if (hz.id === turretId) {
            var mount = (hz.angle || 0) * Math.PI / 180;
            var halfArc = (turretArc / 2) * Math.PI / 180;
            var edges = [-halfArc, 0, halfArc];
            for (var e = 0; e < edges.length; e++) {
                var coneRad = mount + edges[e];
                for (var ct = 25; ct <= turretRange; ct += 25) {
                    addAround(hz.x + Math.cos(coneRad) * ct, hz.y + Math.sin(coneRad) * ct);
                }
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
    // A straightened leg must not cut through a solid author barrier — the
    // underlying Dijkstra route already goes around (barrier edges are hard-blocked),
    // but collapsing cell-centre dog-legs into one straight line could re-cross a
    // wall the route had skirted. Reuse the engine's segment-crossing test.
    var barriers = Array.isArray(map.barriers) ? map.barriers : null;
    function segClearsBarriers(a, b) {
        if (!barriers || barriers.length === 0) { return true; }
        for (var i = 0; i < barriers.length; i++) {
            var bar = barriers[i];
            if (bar == null) { continue; }
            if (segmentsCross(a.x, a.y, b.x, b.y, bar.x1, bar.y1, bar.x2, bar.y2)) { return false; }
        }
        return true;
    }
    function segmentSafe(a, b) {
        if (!segClearsHazards(a, b)) { return false; }
        if (!segClearsBarriers(a, b)) { return false; }
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
    // Author barriers are respected automatically: findPathToNearestGoal routes on the
    // nav graph, which drops wall-cut doorways and splits bisected cells — so these
    // overlay routes weave through the gaps instead of blasting through walls, matching
    // the validator. (Hazard penalties still need to be passed explicitly.)
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

// Warp pads can RUIN a map even when the optimal par looks fine. The optimal route takes a
// pair from its START side (a shortcut), so par never sees that the SAME pair's goal-side
// mouth — when it sits on the natural drive to the goal — flings a naive racer who just drives
// the line straight BACK toward the start. This measures that hazard. For each pair: the
// goal-side pad (the one with the smaller DRIVE-only time to goal) is the trap mouth; its
// SETBACK is how much longer your race gets if you hit it head-on (the far pad's drive time
// minus the goal-side's, plus the transit). It only counts if the goal-side pad actually sits
// within warpTrapRadius of a no-warp racing line — an off-line mouth (a side-pocket exit) is
// harmless because nobody drives over it. Returns { worst: seconds, count }. O(0) on warp-free
// maps (early return), and only runs the extra pathfinding when a map actually has pairs.
function warpTrapSeverity(map, config, getCtx) {
    var warpId = (config.boons && config.boons.warpPad) ? config.boons.warpPad.id : null;
    if (warpId == null || !Array.isArray(map.hazards) || !Array.isArray(map.cells)) { return { worst: 0, count: 0 }; }
    var byPair = {};
    for (var i = 0; i < map.hazards.length; i++) {
        var hz = map.hazards[i];
        if (hz == null || hz.id !== warpId || typeof hz.pair !== "number" || !isFinite(hz.pair)) { continue; }
        (byPair[hz.pair] || (byPair[hz.pair] = [])).push(hz);
    }
    var pairs = [];
    for (var pk in byPair) { if (byPair[pk].length === 2) { pairs.push(byPair[pk]); } }
    if (pairs.length === 0) { return { worst: 0, count: 0 }; }

    // Warp routes are measured WITH zip still credited (noWarp only): the warp is the only
    // shortcut being removed to expose the no-warp racing line. Built lazily, only now that
    // we know the map has pairs.
    var ctx = getCtx({ noWarp: true });
    var driveTime = ctx.driveTime, onRacingLine = ctx.onRacingLine;
    var trapRadius = bal(config, 'warpTrapRadius', 100);
    var lateralSec = bal(config, 'warpTrapLateralSec', 1.5);
    var worst = 0, count = 0;
    for (var pr = 0; pr < pairs.length; pr++) {
        var A = pairs[pr][0], B = pairs[pr][1];
        var tA = driveTime(A.x, A.y), tB = driveTime(B.x, B.y);
        if (!isFinite(tA) || !isFinite(tB)) { continue; }
        // A LATERAL pair (both pads ~equidistant from the goal) doesn't fling you backward —
        // it moves you sideways. Skip it: there's no meaningful goal-side mouth, and which pad
        // `tA <= tB` would pick is just hazard-order noise (Codex P2). Only a pair with a real
        // forward/backward asymmetry is a trap.
        if (Math.abs(tA - tB) < lateralSec) { continue; }
        var dxp = A.x - B.x, dyp = A.y - B.y;
        var transit = cellGraph.warpTransitMs(Math.sqrt(dxp * dxp + dyp * dyp)) / 1000;
        var goalSide = (tA <= tB) ? A : B;        // the mouth a forward racer drives into
        var setback = Math.abs(tA - tB) + transit; // far drive time - goal-side drive time + transit
        if (onRacingLine(goalSide.x, goalSide.y, trapRadius)) {
            if (setback > worst) { worst = setback; }
            count++;
        }
    }
    return { worst: worst, count: count };
}

// Zipline TRAP severity — the cable analog of warpTrapSeverity. A zipline AUTO-GRABS any
// racer who drives onto its start post and carries them SLOWLY to the far post. That's a boon
// when it spans something you couldn't drive (a lava chasm) — but a TRAP when the start post
// sits on the natural racing line over open ground: a racer driving the line gets snatched
// onto a slow ride and LOSES time vs just driving that span. The setback is rideTime minus the
// forward driving progress the ride actually buys (drive time saved by landing at the far post
// instead of the start). A zip whose far side is only reachable BY the cable (a real crossing)
// has an infinite no-cable drive time and is skipped — not a trap. Only counts when the start
// post is within ziplineTrapRadius of a no-shortcut racing line. Returns { worst, count }.
// O(0) on zip-free maps; only the extra pathfinding runs when a map actually has a cable.
function ziplineTrapSeverity(map, config, getCtx) {
    var zipId = (config.boons && config.boons.zipline) ? config.boons.zipline.id : null;
    if (zipId == null || !Array.isArray(map.hazards) || !Array.isArray(map.cells)) { return { worst: 0, count: 0 }; }
    var zips = [];
    for (var i = 0; i < map.hazards.length; i++) {
        var hz = map.hazards[i];
        if (hz == null || hz.id !== zipId) { continue; }
        if (typeof hz.x !== "number" || typeof hz.y !== "number") { continue; }
        if (typeof hz.length !== "number" || !isFinite(hz.length) || hz.length <= 0) { continue; }
        if (!isFinite(hz.angle)) { continue; }
        zips.push(hz);
    }
    if (zips.length === 0) { return { worst: 0, count: 0 }; }

    // Pure-driving time to goal with NO shortcuts (no warp, no zip) — shared with the launch
    // pass (same options), built lazily only now that we know the map has cables.
    var ctx = getCtx({ noWarp: true, noZip: true });
    var driveTime = ctx.driveTime, onRacingLine = ctx.onRacingLine;
    var trapRadius = bal(config, 'ziplineTrapRadius', 100);
    var speed = (config.boons.zipline.speed || 30);
    var worst = 0, count = 0;
    for (var zi = 0; zi < zips.length; zi++) {
        var z = zips[zi];
        var rad = (z.angle || 0) * (Math.PI / 180);
        var fx = z.x + Math.cos(rad) * z.length, fy = z.y + Math.sin(rad) * z.length;
        var tStart = driveTime(z.x, z.y), tFar = driveTime(fx, fy);
        if (!isFinite(tStart) || !isFinite(tFar)) { continue; } // far reachable only by cable => real crossing, not a trap
        var rideSec = (speed > 0) ? (z.length / speed) : 0;
        // The forced ride costs rideSec but moves you forward by (tStart - tFar) of drive time;
        // the net setback is how much SLOWER the forced ride is than just driving the span.
        var setback = rideSec - (tStart - tFar);
        if (setback > 0 && onRacingLine(z.x, z.y, trapRadius)) {
            if (setback > worst) { worst = setback; }
            count++;
        }
    }
    return { worst: worst, count: count };
}

// Launch-pad TRAP severity — the aimed-fling analog of warpTrapSeverity. A Launch Pad
// FLINGS any racer who drives over it on a committed, UN-STEERABLE airborne arc along the
// author-set facing for a fixed `distance`, landing them wherever the arc ends. That's a boon
// when the facing points forward (a shortcut over a chasm) — but a TRAP when the pad sits on
// the natural racing line and its facing points BACKWARD or off-line: a racer driving the line
// is flung away from the goal with no way to cancel. The setback is how much longer the race
// gets from the landing point vs from the pad (drive time at landing - drive time at pad). Only
// counts when the pad is within launcherTrapRadius of a no-shortcut racing line.
//
// A LETHAL pad is the worst case: an on-line pad whose fling lands in lava / off the world / a
// goal-less pocket (driveTime(landing) is non-finite) flings a line-driving racer to certain
// death or strands them, with no opt-out. Unlike a zip — whose far post is validated drivable
// and which you ride deliberately to cross a chasm — a launch pad's landing is NOT validated,
// so a non-finite landing is a death trap, not a "crossing." It's reported as `lethal` so
// classify() hard-fails the map outright. Returns { worst, count, lethal }. O(0) on pad-free maps.
//
// Only the Launch Pad is scored here — NOT the Barrel Cannon (its launch direction is a
// player-TIMED skill shot off a continuously sweeping barrel, not an author-fixed angle, so a
// well-placed barrel is fair) and NOT the Slingshot Rings (a capped-add axial speed pulse that
// "never brakes a faster kart" — a mis-aimed pass merely under-fires, it can't fling you back).
function launcherTrapSeverity(map, config, getCtx) {
    var padId = (config.boons && config.boons.launchPad) ? config.boons.launchPad.id : null;
    var dist = (config.boons && config.boons.launchPad && typeof config.boons.launchPad.distance === 'number')
        ? config.boons.launchPad.distance : 0;
    if (padId == null || dist <= 0 || !Array.isArray(map.hazards) || !Array.isArray(map.cells)) { return { worst: 0, count: 0, lethal: 0 }; }
    var pads = [];
    for (var i = 0; i < map.hazards.length; i++) {
        var hz = map.hazards[i];
        if (hz == null || hz.id !== padId) { continue; }
        if (typeof hz.x !== "number" || typeof hz.y !== "number" || !isFinite(hz.angle)) { continue; }
        pads.push(hz);
    }
    if (pads.length === 0) { return { worst: 0, count: 0, lethal: 0 }; }

    // Pure-driving, no-shortcut context (shared with the zip pass, same options), built lazily
    // only now that we know the map has pads.
    var ctx = getCtx({ noWarp: true, noZip: true });
    var driveTime = ctx.driveTime, onRacingLine = ctx.onRacingLine;
    var trapRadius = bal(config, 'launcherTrapRadius', 100);
    var worst = 0, count = 0, lethal = 0;
    for (var pi2 = 0; pi2 < pads.length; pi2++) {
        var p = pads[pi2];
        var tPad = driveTime(p.x, p.y);
        // A pad off the routable graph isn't on any racing line — nobody drives over it.
        if (!isFinite(tPad)) { continue; }
        if (!onRacingLine(p.x, p.y, trapRadius)) { continue; }
        var rad = (p.angle || 0) * (Math.PI / 180);
        var lx = p.x + Math.cos(rad) * dist, ly = p.y + Math.sin(rad) * dist;
        var tLand = driveTime(lx, ly);
        if (!isFinite(tLand)) {
            // Landing in lava / off-world / a goal-less pocket: an unavoidable death or
            // race-ender on the line. The most punishing placement — flag it lethal.
            lethal++;
            count++;
            continue;
        }
        var setback = tLand - tPad; // positive => the fling lands you FARTHER from goal (backward)
        if (setback > 0) {
            if (setback > worst) { worst = setback; }
            count++;
        }
    }
    return { worst: worst, count: count, lethal: lethal };
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
// Final safety net: route any leg that still cuts a solid barrier AROUND the wall's
// nearer endpoint. Catches the sub-cell case borderCrossing can't — a barrier END
// juts INTO a traversed cell, walling its centre off from the whole shared border,
// so the kart squeezes past the wall's open end but a straight drawn leg clips it.
// Insert a waypoint just past that endpoint (offset outward from the leg). Bounded,
// and only kept when it actually removes the crossing without adding a new one — so
// a wall it can't cleanly skirt is left as the lesser-evil straight leg.
function detourBarriers(map, pts) {
    var barriers = Array.isArray(map.barriers) ? map.barriers : null;
    if (!barriers || barriers.length === 0 || pts.length < 2) { return pts; }
    var CLEAR = 16; // push the waypoint a kart-radius past the wall end
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
        var a = out[out.length - 1], b = pts[i];
        if (!legClearsBarriers(a, b, barriers)) {
            var wp = barrierEndDetour(a, b, barriers, CLEAR);
            if (wp != null) { out.push(wp); }
        }
        out.push(b);
    }
    return out;
}

// Pick a waypoint that skirts the FIRST barrier leg a->b crosses, by going just past
// whichever of that barrier's endpoints is nearer the crossing, nudged perpendicular-
// away from the wall. Returns the waypoint only if a->wp and wp->b both clear ALL
// barriers; otherwise null (caller keeps the straight leg).
function barrierEndDetour(a, b, barriers, clear) {
    for (var i = 0; i < barriers.length; i++) {
        var bar = barriers[i];
        if (bar == null) { continue; }
        if (!segmentsCross(a.x, a.y, b.x, b.y, bar.x1, bar.y1, bar.x2, bar.y2)) { continue; }
        var ends = [{ x: bar.x1, y: bar.y1 }, { x: bar.x2, y: bar.y2 }];
        // Outward normal of the wall, oriented away from the leg's start.
        var wx = bar.x2 - bar.x1, wy = bar.y2 - bar.y1;
        var wlen = Math.sqrt(wx * wx + wy * wy) || 1;
        var nx = -wy / wlen, ny = wx / wlen;
        for (var e = 0; e < ends.length; e++) {
            var end = ends[e];
            // Push past the wall end ALONG the wall, then out along the normal, both
            // signs — first combination that clears wins.
            var alongx = (wx / wlen) * (e === 0 ? -clear : clear);
            var alongy = (wy / wlen) * (e === 0 ? -clear : clear);
            for (var s = -1; s <= 1; s += 2) {
                var wp = {
                    x: Math.round(end.x + alongx + nx * clear * s),
                    y: Math.round(end.y + alongy + ny * clear * s)
                };
                if (legClearsBarriers(a, wp, barriers) && legClearsBarriers(wp, b, barriers)) {
                    return wp;
                }
            }
        }
        return null; // crossed a wall we can't cleanly skirt — keep the straight leg
    }
    return null;
}

function routePolyline(map, config, route, penaltyLookup, avoid) {
    var pts = pathPoints(map, route.path);
    pts.unshift({ x: Math.round(route.origin.x), y: Math.round(route.origin.y) });
    return detourBarriers(map, smoothRoute(map, config, pts, penaltyLookup, avoid.points));
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

// Difficulty tier (easy|mid|hard|brutal) for the match-phase map ramp
// (gameBoard.determineNextMap). Primary source: the measured AI per-round
// finisher fraction in server/mapDifficulty.json (sweep documented in
// docs/spikes/gameplay-balance-analysis.md), graded against the cutoffs in
// config.difficultyRamp.tierCutoffs:
//
//   frac <  brutalMax (0.10) -> 'brutal'  (spawn-kill / attrition-lottery tail)
//   frac <  hardMax   (0.20) -> 'hard'
//   frac <  midMax    (0.35) -> 'mid'     (the healthy band)
//   frac >= midMax           -> 'easy'
//
// Maps with no sim entry (new editor submissions) or flagged as AI artifacts
// (mapDifficulty.aiArtifacts — their sim score measures bot pathing failure,
// not difficulty) fall back to a geometry heuristic: heavy lava (the
// signature of every measured hard map) reads 'hard', everything else 'mid'.
// The heuristic NEVER returns 'brutal' (a guess shouldn't exclude a map from
// early rounds) and never 'easy' (so unmeasured maps aren't over-served to
// fresh lobbies).
// The lookup key into mapDifficulty.json: the map name with whitespace removed
// (the balance sweep's naming). This is a cross-file contract — validate-content's
// orphan check and validate-submitted-map's paste-ready snippet must produce the
// SAME key the runtime looks up, so they all call this and never inline the format.
function difficultyKey(name) {
    return String(name || '').replace(/\s+/g, '');
}

// Grade a measured perRoundFrac against config.difficultyRamp.tierCutoffs. The
// single source of truth for the ladder (and its fallback cutoffs) — the
// submission CI grades its fresh measurements with this same function, so the
// tier shown in a PR review comment can never drift from what the live server
// assigns once the entry lands.
function gradeDifficultyFrac(frac, config) {
    var cuts = (config && config.difficultyRamp && config.difficultyRamp.tierCutoffs) || {};
    if (frac < ((cuts.brutalMax != null) ? cuts.brutalMax : 0.10)) { return 'brutal'; }
    if (frac < ((cuts.hardMax != null) ? cuts.hardMax : 0.20)) { return 'hard'; }
    if (frac < ((cuts.midMax != null) ? cuts.midMax : 0.35)) { return 'mid'; }
    return 'easy';
}

function difficultyTier(map, config, ratios) {
    var key = difficultyKey(map.name);
    var artifacts = mapDifficulty.aiArtifacts || [];
    var frac = (mapDifficulty.perRoundFrac || {})[key];
    if (typeof frac === 'number' && artifacts.indexOf(key) === -1) {
        return gradeDifficultyFrac(frac, config);
    }
    // `ratios` lets classify() pass the composition it already computed; only a
    // standalone call (no precomputed composition) pays for a fresh scan.
    var lavaFrac = (ratios || composition(map, config).ratios).lava;
    return (lavaFrac >= 0.30) ? 'hard' : 'mid';
}

// Main entry: map (reconstructed, full geometry) + config -> meta object.
// `parTime` is read from the map if already computed (loadMaps does this) and
// otherwise computed here, so the classifier is safe to call standalone.
function classify(map, config) {
    var comp = composition(map, config);
    var r = comp.ratios;
    var par = (map.parTime != null) ? map.parTime : cellGraph.computeMapParTime(map);
    var edges = startEdgesOf(map);
    // Boons live in hazards[] but aid the player, so they don't count as difficulty.
    var boonIds = boonIdSet(config);
    var hazardCount = Array.isArray(map.hazards)
        ? map.hazards.filter(function (hz) { return hz != null && !boonIds[hz.id]; }).length
        : 0;
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
    // The three trap-severity passes below share their no-shortcut racing-line context: the
    // warp pass measures with {noWarp:true} (zip still credited), the zip + launch passes share
    // {noWarp:true, noZip:true}. Memoize by options-key so a map carrying warp + zip + launch
    // builds each distinct context ONCE (not once per pass). The getter is only invoked from
    // inside a severity fn AFTER it confirms the map has that placeable, so a trap-free map
    // never builds a context (the expensive edge-sample pathfinding stays O(0)).
    var _racingCtxCache = {};
    function getRacingCtx(pathOpts) {
        var key = (pathOpts.noWarp ? 'W' : '') + (pathOpts.noZip ? 'Z' : '');
        if (_racingCtxCache[key] == null) { _racingCtxCache[key] = racingLineContext(map, config, pathOpts); }
        return _racingCtxCache[key];
    }
    // WARP-PAD TRAP: a teleport whose goal-side mouth sits on the racing line flings a naive
    // racer backward — invisible to the optimal-path par/fairness above (the optimal route
    // takes the pair from its start side). Strong soft deduction (so a bad teleport clearly
    // drops out of Featured and shows the author a 'warptrap' line), plus a hard-fail for a
    // catastrophic one (a setback that effectively resets the race). Zero cost on warp-free maps.
    {
        var warpTrap = warpTrapSeverity(map, config, getRacingCtx);
        if (warpTrap.worst > 0) {
            var wtTol = bal(config, 'warpTrapTolSec', 1.0);
            var wtPerSec = bal(config, 'warpTrapPerSec', 6);
            var wtMax = bal(config, 'warpTrapMax', 45);
            deduct(Math.min(wtMax, Math.round(Math.max(0, warpTrap.worst - wtTol) * wtPerSec)), 'warptrap');
            var wtHard = bal(config, 'warpTrapHardSec', 22);
            if (warpTrap.worst > wtHard) {
                hardFail.push('a warp pad on the racing line flings racers ~' + warpTrap.worst.toFixed(0) + 's backward (a trap)');
            }
        }
    }
    // ZIPLINE TRAP: a cable whose start post sits on the racing line over open ground snatches
    // a forward racer onto a slow ride that costs them time — invisible to the optimal-path par
    // (which only takes a zip when it genuinely shortcuts). Same soft-deduction + hard-fail
    // shape as the warp trap (it shows the author a 'ziptrap' line). Zero cost on zip-free maps.
    {
        var zipTrap = ziplineTrapSeverity(map, config, getRacingCtx);
        if (zipTrap.worst > 0) {
            var ztTol = bal(config, 'ziplineTrapTolSec', 1.0);
            var ztPerSec = bal(config, 'ziplineTrapPerSec', 6);
            var ztMax = bal(config, 'ziplineTrapMax', 45);
            deduct(Math.min(ztMax, Math.round(Math.max(0, zipTrap.worst - ztTol) * ztPerSec)), 'ziptrap');
            var ztHard = bal(config, 'ziplineTrapHardSec', 22);
            if (zipTrap.worst > ztHard) {
                hardFail.push('a zipline on the racing line forces racers onto a ~' + zipTrap.worst.toFixed(0) + 's slow ride (a trap)');
            }
        }
    }
    // LAUNCH-PAD TRAP: a Launch Pad on the racing line whose author-set facing flings racers
    // BACKWARD on an un-steerable arc — invisible to the optimal-path par (which only takes the
    // fling when it shortcuts). Same soft-deduction + hard-fail shape as the warp/zip traps (it
    // shows the author a 'launchtrap' line). Barrel Cannon (player-timed) and Slingshot Rings
    // (capped boost, never brakes) are deliberately excluded — see launcherTrapSeverity. Zero
    // cost on launch-pad-free maps.
    {
        var launchTrap = launcherTrapSeverity(map, config, getRacingCtx);
        // A LETHAL pad (flings a line-driving racer into lava / off-world with no opt-out) is the
        // worst placement — apply the max deduction AND hard-fail outright, regardless of the
        // backward-setback magnitude (which is undefined for a non-finite landing).
        if (launchTrap.lethal > 0) {
            deduct(bal(config, 'launcherTrapMax', 45), 'launchtrap');
            hardFail.push('a launch pad on the racing line flings racers into lava / off the map (instant death)');
        } else if (launchTrap.worst > 0) {
            var ltTol = bal(config, 'launcherTrapTolSec', 1.0);
            var ltPerSec = bal(config, 'launcherTrapPerSec', 6);
            var ltMax = bal(config, 'launcherTrapMax', 45);
            deduct(Math.min(ltMax, Math.round(Math.max(0, launchTrap.worst - ltTol) * ltPerSec)), 'launchtrap');
            var ltHard = bal(config, 'launcherTrapHardSec', 22);
            if (launchTrap.worst > ltHard) {
                hardFail.push('a launch pad on the racing line flings racers ~' + launchTrap.worst.toFixed(0) + 's backward (a trap)');
            }
        }
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
        difficulty: difficultyTier(map, config, r),
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
    resolvePlaylists: resolvePlaylists,
    difficultyTier: difficultyTier,
    difficultyKey: difficultyKey,
    gradeDifficultyFrac: gradeDifficultyFrac
};
