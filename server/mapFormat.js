// Sites-only map format <-> full voronoi geometry.
//
// A map is fully determined by its voronoi sites + the bounding box they were
// computed in. The editor authors a map by running voronoi.compute(sites, bbox)
// and the OLD on-disk format stored that entire returned diagram (cells, edges,
// vertices, plus a per-halfedge copy of every shared edge) — ~1.3 MB per map.
//
// The compact format stores only what can't be regenerated:
//   { bbox:{xl,xr,yt,yb}, sites:[{x,y,id}], hazards, startEdges, name, author, id }
// and we recompute the diagram on load. Reconstruction is deterministic: same
// site coordinates + same bbox => identical cells/edges/voronoiId assignment, so
// adjacency (cellGraph), par-time, AI pathing, collision and rendering all see
// exactly the geometry the editor produced. The migration's equivalence test
// proves this per map before any original is replaced.
//
// rhill assigns voronoiId in the order sites are *processed* (sorted), not input
// order, and mutates each passed site object with its assigned voronoiId. So we
// reconstruct by tracking each site object through compute() and reading back the
// voronoiId it received — never by assuming input order equals voronoiId.

var Voronoi = require('../client/scripts/rhill-voronoi-core.js');

// "Sites-only" = has a sites array and NO full geometry. The `!cells` check keeps
// this identical to the client's mapIsSitesOnly: a map carrying both must be
// treated as full-geometry on both sides, never reconstructed on one and passed
// through on the other.
function isSitesOnly(map) {
    return map != null && Array.isArray(map.sites) && !Array.isArray(map.cells);
}

// The bbox is recoverable from a full map's clipped polygon vertices: voronoi
// clipping snaps boundary cells' edges exactly onto the bbox lines, so the
// min/max of every halfedge endpoint (va/vb) is the bbox. (The diagram's own
// `vertices` array is NOT usable here — it retains un-clipped circle-event points
// that lie far outside the box.)
function deriveBbox(fullMap) {
    var xl = Infinity, xr = -Infinity, yt = Infinity, yb = -Infinity;
    var cells = fullMap.cells;
    for (var i = 0; i < cells.length; i++) {
        var hes = cells[i].halfedges;
        for (var h = 0; h < hes.length; h++) {
            var edge = hes[h].edge;
            if (!edge) { continue; }
            var pts = [edge.va, edge.vb];
            for (var p = 0; p < pts.length; p++) {
                var v = pts[p];
                if (!v) { continue; }
                if (v.x < xl) { xl = v.x; }
                if (v.x > xr) { xr = v.x; }
                if (v.y < yt) { yt = v.y; }
                if (v.y > yb) { yb = v.y; }
            }
        }
    }
    return { xl: xl, xr: xr, yt: yt, yb: yb };
}

// Carry the non-geometry fields that travel with a map, in a stable key order.
// thumbnail is deliberately dropped — it's regenerated on demand client-side.
function carryMeta(dst, src) {
    if (src.startEdges != null) { dst.startEdges = src.startEdges; }
    if (src.parTime != null) { dst.parTime = src.parTime; }
    if (src.lobbyOnly) { dst.lobbyOnly = src.lobbyOnly; }
    if (src.name != null) { dst.name = src.name; }
    if (src.author != null) { dst.author = src.author; }
    if (src.id != null) { dst.id = src.id; }
    if (src.email != null) { dst.email = src.email; }
    return dst;
}

// Full geometry -> compact sites-only. Used by the migration and at the submit
// boundary so the editor's full in-memory diagram is reduced to one canonical
// stored shape.
function toSitesOnly(fullMap) {
    var sites = new Array(fullMap.cells.length);
    for (var i = 0; i < fullMap.cells.length; i++) {
        var c = fullMap.cells[i];
        sites[i] = { x: c.site.x, y: c.site.y, id: c.id };
    }
    var out = { bbox: deriveBbox(fullMap), sites: sites, hazards: fullMap.hazards || [] };
    return carryMeta(out, fullMap);
}

// Compact sites-only -> full geometry, by recomputing the voronoi diagram. The
// returned object is structurally identical to an old-format loaded map (cells
// with site/halfedges/edge/va/vb, plus the carried metadata), so every consumer
// is unchanged. Throws on a degenerate site set (a duplicate site produces no
// cell), which the migration treats as "keep this map in full format".
function reconstruct(sitesMap) {
    if (sitesMap.bbox == null || !Array.isArray(sitesMap.sites)) {
        throw new Error('reconstruct: map is missing bbox or sites');
    }
    var siteObjs = new Array(sitesMap.sites.length);
    for (var i = 0; i < sitesMap.sites.length; i++) {
        siteObjs[i] = { x: sitesMap.sites[i].x, y: sitesMap.sites[i].y };
    }
    var diagram = new Voronoi().compute(siteObjs, sitesMap.bbox);
    for (var j = 0; j < sitesMap.sites.length; j++) {
        var vid = siteObjs[j].voronoiId;
        if (vid == null || diagram.cells[vid] == null) {
            throw new Error('reconstruct: site ' + j + ' (' + sitesMap.sites[j].x + ',' +
                sitesMap.sites[j].y + ') produced no cell — duplicate or degenerate site');
        }
        diagram.cells[vid].id = sitesMap.sites[j].id;
    }
    diagram.hazards = sitesMap.hazards || [];
    return carryMeta(diagram, sitesMap);
}

// Convenience for code that reads a map file and needs full geometry regardless
// of which format it's in: reconstruct a sites-only map, pass a full map through.
function hydrate(map) {
    return isSitesOnly(map) ? reconstruct(map) : map;
}

module.exports = { isSitesOnly: isSitesOnly, reconstruct: reconstruct, toSitesOnly: toSitesOnly, deriveBbox: deriveBbox, hydrate: hydrate };
