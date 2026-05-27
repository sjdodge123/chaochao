// Migration safety net for the sites-only map format (server/mapFormat.js).
//
// For every original full-geometry map it: reduces to sites-only, reconstructs,
// and asserts the rebuilt diagram is equivalent to the original in every way the
// engine, cellGraph (adjacency / par-time / AI pathing) and renderer depend on:
//   - same cell count and same set of voronoiIds
//   - same site coordinate + tile id per voronoiId
//   - identical clipped polygon vertices (collision + rendering geometry)
//   - identical neighbor sets (the adjacency graph cellGraph builds from edges)
//   - identical computed par-time (end-to-end proof AI pathing is unchanged)
//
// Run against client/maps/ (the originals, before migration) or maps-archive/.
// Exits non-zero on any divergence; such a map must stay in full format.

const fs = require('fs');
const path = require('path');
const mapFormat = require('../../server/mapFormat.js');
const cellGraph = require('../../server/cellGraph.js');

const EPS = 1e-6;
const dir = process.argv[2] || path.join(__dirname, '../../client/maps');

// Neighbor voronoiId set per cell, derived straight from halfedges the same way
// cellGraph.buildAdjacency does — the structure AI pathing/par-time rely on.
function neighborSets(map) {
    const out = {};
    for (const cell of map.cells) {
        const own = cell.site.voronoiId;
        const set = new Set();
        for (const he of cell.halfedges) {
            const edge = he.edge;
            if (!edge) { continue; }
            if (edge.lSite && edge.lSite.voronoiId !== own) { set.add(edge.lSite.voronoiId); }
            else if (edge.rSite && edge.rSite.voronoiId !== own) { set.add(edge.rSite.voronoiId); }
        }
        out[own] = set;
    }
    return out;
}

// Polygon vertices via the engine's getStartpoint convention. Order doesn't
// matter for the comparison below, so they're returned as-is.
function ringPoints(cell) {
    const pts = [];
    for (const he of cell.halfedges) {
        const e = he.edge;
        const sameLeft = e.lSite && he.site && e.lSite.x === he.site.x && e.lSite.y === he.site.y &&
            e.lSite.voronoiId === he.site.voronoiId;
        const sp = sameLeft ? e.va : e.vb;
        if (sp) { pts.push(sp); }
    }
    return pts;
}

// Order-independent vertex-set equality: same count, and every point has a
// counterpart within EPS. Voronoi vertices are separated by >> EPS, so this is a
// true multiset match — and it tolerates the ~1e-13 px float dust the clipper
// emits at bbox boundaries (75 vs 74.99999999999999), which a sorted element-wise
// compare would spuriously misalign.
function ringsMatch(a, b) {
    if (a.length !== b.length) { return false; }
    for (const pa of a) {
        let found = false;
        for (const pb of b) {
            if (Math.abs(pa.x - pb.x) <= EPS && Math.abs(pa.y - pb.y) <= EPS) { found = true; break; }
        }
        if (!found) { return false; }
    }
    return true;
}

function compare(name, orig) {
    const sitesOnly = mapFormat.toSitesOnly(orig);
    const reb = mapFormat.reconstruct(sitesOnly);

    if (reb.cells.length !== orig.cells.length) {
        return `cell count ${reb.cells.length} != ${orig.cells.length}`;
    }
    const byVid = (m) => { const o = {}; for (const c of m.cells) { o[c.site.voronoiId] = c; } return o; };
    const oV = byVid(orig), rV = byVid(reb);
    const oKeys = Object.keys(oV).sort(), rKeys = Object.keys(rV).sort();
    if (oKeys.join(',') !== rKeys.join(',')) { return 'voronoiId set differs'; }

    for (const vid of oKeys) {
        const oc = oV[vid], rc = rV[vid];
        if (oc.site.x !== rc.site.x || oc.site.y !== rc.site.y) { return `site moved at vid ${vid}`; }
        if (oc.id !== rc.id) { return `tile id ${rc.id} != ${oc.id} at vid ${vid}`; }
        if (!ringsMatch(ringPoints(oc), ringPoints(rc))) { return `polygon geometry differs at vid ${vid}`; }
    }

    const oN = neighborSets(orig), rN = neighborSets(reb);
    for (const vid of oKeys) {
        const a = [...oN[vid]].sort((x, y) => x - y).join(',');
        const b = [...rN[vid]].sort((x, y) => x - y).join(',');
        if (a !== b) { return `adjacency differs at vid ${vid}`; }
    }

    // Par-time: distinct ids so cellGraph's adjacency cache (keyed by id+count)
    // can't serve one map's graph to the other and mask a difference.
    const oc = JSON.parse(JSON.stringify(orig)); oc.id = 'eqtest-orig-' + name;
    const rc = JSON.parse(JSON.stringify(reb)); rc.id = 'eqtest-reb-' + name;
    const oPar = cellGraph.computeMapParTime(oc);
    const rPar = cellGraph.computeMapParTime(rc);
    if (!(Number.isFinite(oPar) && Number.isFinite(rPar)) || Math.abs(oPar - rPar) > EPS) {
        return `par-time ${rPar} != ${oPar}`;
    }
    return null; // equivalent
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
let failed = 0;
for (const f of files) {
    const name = f.replace(/\.json$/, '');
    const orig = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!Array.isArray(orig.cells)) { console.log(`SKIP  ${name} (already sites-only / no cells)`); continue; }
    let reason;
    try { reason = compare(name, orig); } catch (e) { reason = 'threw: ' + e.message; }
    if (reason) { console.log(`FAIL  ${name}: ${reason}`); failed++; }
    else { console.log(`ok    ${name} (${orig.cells.length} cells)`); }
}
console.log(`\n${files.length - failed}/${files.length} maps reconstruct equivalently.`);
if (failed) { console.error(`${failed} map(s) FAILED equivalence — they must stay in full format.`); process.exit(1); }
