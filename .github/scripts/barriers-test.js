'use strict';

// Headless test for author-placed barriers (the editor's 2-point fence/wall tool).
// Barriers are static {x1,y1,x2,y2,style} segments players can't cross but slide
// along — the SAME deflection as the water/lava stone seam (engine.bounceOffBarriers).
//
//   [A] Block + slide (pure). A move that would cross a barrier keeps only the
//       component ALONG it (perpendicular dropped); a move that doesn't cross is
//       untouched; a move past the segment's end (around it) is NOT blocked.
//   [B] Map round-trip. A map authored with a `barriers` array survives the
//       sites-only compact/reconstruct round trip mapFormat does at load.
//   [C] Validation. utils.validateMap accepts well-formed barriers and rejects
//       malformed / oversized ones.
//
// Pure-engine where possible (no room boot needed) — bounceOffBarriers only reads
// player.x/y/newX/newY/velX/velY and map.barriers.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const engine = require(path.join(repoRoot, 'server', 'engine.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const config = utils.loadConfig();

let failures = 0;
function check(name, cond) {
    if (cond) { console.log('  ok  - ' + name); }
    else { console.error('  FAIL - ' + name); failures++; }
}

// A fresh player-like object. Each call clears the per-map barrier cache so a new
// barriers array takes effect.
function mkPlayer(x, y, newX, newY, velX, velY) {
    return { x: x, y: y, newX: newX, newY: newY, velX: velX, velY: velY, bounced: false };
}
function mkMap(barriers) {
    return { barriers: barriers }; // _barrierEdges built lazily on first call
}

// --- [A] Block + slide ------------------------------------------------------
console.log('[A] block + slide (pure)');
{
    // Vertical wall at x=100 spanning y in [0,200].
    const map = mkMap([{ x1: 100, y1: 0, x2: 100, y2: 200, style: 'wall' }]);

    // Head-on from the left (pure horizontal). Should be fully stopped on x
    // (perpendicular dropped), velX killed, and never reach the far side.
    const p1 = mkPlayer(90, 100, 110, 100, 50, 0);
    engine.bounceOffBarriers(p1, map);
    check('head-on does not cross the wall (newX <= 100)', p1.newX <= 100 + 1e-6);
    check('head-on perpendicular velocity dropped (velX ~ 0)', Math.abs(p1.velX) < 1e-6);
    check('head-on flagged bounced', p1.bounced === true);

    // Diagonal into the wall (right + down): blocked on x, but slides DOWN along it.
    const p2 = mkPlayer(90, 100, 110, 130, 50, 30);
    engine.bounceOffBarriers(p2, map);
    check('diagonal blocked on x (newX <= 100)', p2.newX <= 100 + 1e-6);
    check('diagonal slides along wall (newY advanced past start)', p2.newY > 100 + 1e-6);
    check('diagonal keeps tangential velocity (velY > 0)', p2.velY > 1e-6);

    // A move that doesn't reach the wall is untouched.
    const p3 = mkPlayer(10, 100, 30, 100, 50, 0);
    engine.bounceOffBarriers(p3, map);
    check('non-crossing move untouched (newX == 30)', p3.newX === 30 && p3.bounced === false);

    // Going AROUND the end (the wall stops at y=200; cross at y=260 is open).
    const p4 = mkPlayer(90, 260, 110, 260, 50, 0);
    engine.bounceOffBarriers(p4, map);
    check('crossing past the segment end is NOT blocked', p4.newX === 110 && p4.bounced === false);

    // A map with no barriers is a no-op.
    const p5 = mkPlayer(90, 100, 110, 100, 50, 0);
    engine.bounceOffBarriers(p5, mkMap([]));
    check('empty barriers array is a no-op', p5.newX === 110 && p5.bounced === false);

    // A fence style blocks identically to a wall (style is visual-only).
    const fenceMap = mkMap([{ x1: 100, y1: 0, x2: 100, y2: 200, style: 'fence' }]);
    const p6 = mkPlayer(90, 100, 110, 100, 50, 0);
    engine.bounceOffBarriers(p6, fenceMap);
    check('fence style blocks the same as wall', p6.newX <= 100 + 1e-6 && p6.bounced === true);
}

// --- [B] Map round-trip -----------------------------------------------------
console.log('[B] sites-only round trip preserves barriers');
{
    // Minimal full-geometry map (one cell is enough for compact/reconstruct's
    // carryMeta denylist path — we only assert the barriers field survives).
    const sites = [];
    for (let i = 0; i < 12; i++) {
        sites.push({ x: 50 + (i % 4) * 200, y: 50 + Math.floor(i / 4) * 200, id: config.tileMap.fast.id });
    }
    const bbox = { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight };
    const full = mapFormat.reconstruct({ bbox: bbox, sites: sites, barriers: [{ x1: 120, y1: 30, x2: 120, y2: 400, style: 'fence' }] });
    check('reconstruct carries the barriers field', Array.isArray(full.barriers) && full.barriers.length === 1);
    const compact = mapFormat.toSitesOnly(full);
    check('toSitesOnly carries the barriers field', Array.isArray(compact.barriers) && compact.barriers.length === 1);
    check('round-tripped barrier geometry intact', compact.barriers[0].x1 === 120 && compact.barriers[0].style === 'fence');
}

// --- [C] Validation ---------------------------------------------------------
console.log('[C] validateMap barrier rules');
{
    // Build a valid base map via the editor's compact form -> reconstruct so it has
    // real cells + a goal, then attach barriers and validate.
    const sites = [];
    const cols = 8, rows = 6;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const isGoal = (c === cols - 1 && r === Math.floor(rows / 2));
            sites.push({
                x: 60 + c * ((config.worldWidth - 120) / (cols - 1)),
                y: 60 + r * ((config.worldHeight - 120) / (rows - 1)),
                id: isGoal ? config.tileMap.goal.id : config.tileMap.fast.id
            });
        }
    }
    const bbox = { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight };
    function baseMap(barriers) {
        const m = mapFormat.reconstruct({ bbox: bbox, sites: sites.map(s => ({ x: s.x, y: s.y, id: s.id })) });
        m.startEdges = ['left'];
        if (barriers !== undefined) { m.barriers = barriers; }
        return m;
    }

    const good = utils.validateMap(baseMap([{ x1: 200, y1: 100, x2: 200, y2: 400, style: 'wall' }]), config);
    check('valid barrier accepted', good.valid === true);

    const noBar = utils.validateMap(baseMap(undefined), config);
    check('absent barriers field accepted (legacy maps)', noBar.valid === true);

    const malformed = utils.validateMap(baseMap([{ x1: 200, y1: 100, x2: 'oops', y2: 400 }]), config);
    check('non-finite endpoint rejected', malformed.valid === false);

    const zeroLen = utils.validateMap(baseMap([{ x1: 200, y1: 100, x2: 200, y2: 100 }]), config);
    check('zero-length barrier rejected', zeroLen.valid === false);

    const tooLong = utils.validateMap(baseMap([{ x1: 0, y1: 0, x2: config.worldWidth, y2: config.worldHeight }]), config);
    check('over-max-length barrier rejected', tooLong.valid === false);

    const outOfBounds = utils.validateMap(baseMap([{ x1: -50, y1: 100, x2: 100, y2: 100 }]), config);
    check('out-of-world barrier rejected', outOfBounds.valid === false);

    const tooMany = [];
    for (let i = 0; i < (config.barriers.maxCount + 5); i++) { tooMany.push({ x1: 10 + i, y1: 10, x2: 30 + i, y2: 30 }); }
    const overCount = utils.validateMap(baseMap(tooMany), config);
    check('over-max-count barriers rejected', overCount.valid === false);
}

// --- [D] AI routing awareness ----------------------------------------------
// Bots route AROUND barriers: a barrier walling the direct line forces the cell-
// graph path to detour, instead of plowing through it (engine collision then just
// slides them). cellGraph.getBarrierBlockedEdges marks the cut adjacency edges and
// findPathToNearestGoal applies a heavy soft penalty to them.
console.log('[D] AI cell-graph routes around barriers');
{
    const cellGraph = require(path.join(repoRoot, 'server', 'cellGraph.js'));
    const W = config.worldWidth, H = config.worldHeight;
    const cols = 9, rows = 7;
    const sites = [];
    for (let r = 0; r < rows; r++) {
        for (let cc = 0; cc < cols; cc++) {
            const isGoal = (cc === cols - 1 && r === (rows >> 1));
            sites.push({
                x: 60 + cc * ((W - 120) / (cols - 1)),
                y: 60 + r * ((H - 120) / (rows - 1)),
                id: isGoal ? config.tileMap.goal.id : config.tileMap.fast.id
            });
        }
    }
    const bbox = { xl: 0, xr: W, yt: 0, yb: H };
    // Vertical wall across the middle band, gaps top + bottom. Placed on the column
    // BORDER (between col 4 and col 5), not on the column centres at x=W/2: barriers
    // block an adjacency edge by cutting the cells' shared BORDER (the doorway), so a
    // wall laid through cell centres parallel to the borders wouldn't model as a
    // routable block (and no real editor map puts a wall exactly on a cell centre).
    const step = (W - 120) / (cols - 1);
    const wallX = 60 + 4.5 * step; // midpoint between column 4 and column 5 sites
    const wall = { x1: wallX, y1: H * 0.25, x2: wallX, y2: H * 0.75, style: 'wall' };

    function freshMap(withBarrier) {
        const map = mapFormat.reconstruct({ bbox: bbox, sites: sites.map(s => ({ x: s.x, y: s.y, id: s.id })) });
        if (withBarrier) { map.barriers = [wall]; }
        return map;
    }
    function siteOf(map, vid) {
        for (let i = 0; i < map.cells.length; i++) { if (map.cells[i].site.voronoiId === vid) { return map.cells[i].site; } }
        return null;
    }
    function side(ax, ay, bx, by, px, py) { return (bx - ax) * (py - ay) - (by - ay) * (px - ax); }
    function cross(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
        const d1 = side(q0x, q0y, q1x, q1y, p0x, p0y), d2 = side(q0x, q0y, q1x, q1y, p1x, p1y);
        const d3 = side(p0x, p0y, p1x, p1y, q0x, q0y), d4 = side(p0x, p0y, p1x, p1y, q1x, q1y);
        return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
    }
    function pathCrossesWall(map, route) {
        for (let i = 0; i < route.path.length - 1; i++) {
            const a = siteOf(map, route.path[i]), b = siteOf(map, route.path[i + 1]);
            if (a && b && cross(a.x, a.y, b.x, b.y, wall.x1, wall.y1, wall.x2, wall.y2)) { return true; }
        }
        return false;
    }

    const start = { x: 60, y: H / 2 };
    const plainMap = freshMap(false);
    const plain = cellGraph.findPathToNearestGoal(plainMap, start);
    check('baseline path to goal exists', plain != null);
    check('baseline (no barrier) path runs straight through the wall line', plain != null && pathCrossesWall(plainMap, plain));

    const walledMap = freshMap(true);
    const edges = cellGraph.getBarrierBlockedEdges(walledMap);
    check('getBarrierBlockedEdges finds cut edges', edges != null && edges.size > 0);
    const aware = cellGraph.findPathToNearestGoal(walledMap, start, { barrierEdges: edges, barrierMult: 45 });
    check('barrier-aware path still reaches the goal', aware != null);
    check('barrier-aware path detours AROUND the wall (no crossing)', aware != null && !pathCrossesWall(walledMap, aware));

    // Caching returns the same set instance for the same barriers.
    check('blocked-edge set is cached', cellGraph.getBarrierBlockedEdges(walledMap) === edges);
    // No barriers => null (nothing to penalize).
    check('no-barrier map yields null blocked set', cellGraph.getBarrierBlockedEdges(plainMap) == null);
}

// --- [E] validation rejects a barrier that seals off the goal -----------------
// reachableFromEdge hard-blocks barrier edges, so a wall that fully separates the
// start edge from the goal makes validateMap reject the map (not just the offline
// playability sim).
console.log('[E] validateMap rejects a goal sealed off by a barrier');
{
    const W = config.worldWidth, H = config.worldHeight;
    const cols = 8, rows = 6;
    const sites = [];
    for (let r = 0; r < rows; r++) {
        for (let cc = 0; cc < cols; cc++) {
            const isGoal = (cc === cols - 1 && r === (rows >> 1));
            sites.push({
                x: 60 + cc * ((W - 120) / (cols - 1)),
                y: 60 + r * ((H - 120) / (rows - 1)),
                id: isGoal ? config.tileMap.goal.id : config.tileMap.fast.id
            });
        }
    }
    const bbox = { xl: 0, xr: W, yt: 0, yb: H };
    function build(barriers) {
        const m = mapFormat.reconstruct({ bbox: bbox, sites: sites.map(s => ({ x: s.x, y: s.y, id: s.id })) });
        m.startEdges = ['left'];
        if (barriers) { m.barriers = barriers; }
        return m;
    }
    check('open map is valid (goal reachable from left)', utils.validateMap(build(null), config).valid === true);
    var wall = [{ x1: W / 2, y1: 0, x2: W / 2, y2: H, style: 'wall' }];
    check('full-height mid wall makes the goal unreachable -> rejected', utils.validateMap(build(wall), config).valid === false);
}

if (failures > 0) {
    console.error('\nbarriers-test FAILED (' + failures + ' assertion(s)).');
    process.exit(1);
}
console.log('\nbarriers-test passed.');
