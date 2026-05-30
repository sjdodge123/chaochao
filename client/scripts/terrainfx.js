// terrainfx.js — animated terrain overlays drawn each frame AFTER the map-cache
// blit and UNDER the karts (called from drawObjects, right after drawMap()).
//
// Effects, all in world space (every coord adds camera.getCameraX/Y(), the same
// convention drawPlayer uses, so they stay glued to the karts and the terrain):
//   - Goal beacon     : breathing bright core + an expanding pulse ring, clipped
//                       to each goal-cell cluster. Cheap + a gameplay signal, so
//                       it runs on EVERY perf profile.
//   - Lava convection : slow rolling hot patches (additive) clipped to lava.
//   - Ice reflections : a flipped, squashed, low-alpha (blurred on glow profiles)
//                       echo of each kart, clipped to ice — a glossy-floor look.
//   - Ability icons   : float/bob the pickup icon above the tile (always on).
// The two ambient ones (lava/ice) are gated to perfExtraFx() — on Low the flat
// graded texture (+ baked AO) stands on its own. The per-map dataset
// (cells-by-type, goal clusters, lava seeds) is rebuilt only when the terrain
// changes (mapCacheRev), never per frame.

var terrainFX = {
    rev: -1,            // mapCacheRev the cell sets were built for
    ice: [], lava: [], goal: [], ability: [],
    goalClusters: [],
    lavaSeeds: [],
    abilityIcons: null   // lazily-built map: ability tile id -> icon Image
};
// Map each ability tile id to its icon image (the same Images loadPatterns uses).
function tfxBuildAbilityIcons() {
    var m = {};
    var ab = config.tileMap.abilities;
    if (ab == null) { return m; }
    function set(name, ic) { if (ab[name] != null && typeof ic !== "undefined" && ic != null) { m[ab[name].id] = ic; } }
    set("blindfold", typeof blindfoldIcon !== "undefined" ? blindfoldIcon : null);
    set("swap", typeof transferIcon !== "undefined" ? transferIcon : null);
    set("bomb", typeof bombIcon !== "undefined" ? bombIcon : null);
    set("speedBuff", typeof windIcon !== "undefined" ? windIcon : null);
    set("speedDebuff", typeof hourglassIcon !== "undefined" ? hourglassIcon : null);
    set("tileSwap", typeof copyIcon !== "undefined" ? copyIcon : null);
    set("iceCannon", typeof snowFlakeIcon !== "undefined" ? snowFlakeIcon : null);
    set("cut", typeof scissorsIcon !== "undefined" ? scissorsIcon : null);
    return m;
}

function terrainFXActive() {
    if (typeof config === "undefined" || config == null) { return false; }
    if (typeof currentMap === "undefined" || currentMap == null || currentMap.cells == null) { return false; }
    if (typeof world === "undefined" || world == null) { return false; }
    var s = (typeof currentState !== "undefined") ? currentState : null;
    var sm = config.stateMap;
    // Include the lobby: the tutorial lobby has real ability pickup tiles (ids
    // 100-108) that need their hovering icon. The AI/skin hub zones are a separate
    // `stations` payload (string ids "ai"/"skin"), NOT cells, so they don't go
    // through here — no collision.
    return s === sm.lobby || s === sm.gated || s === sm.racing || s === sm.collapsing;
}

function tfxCellVerts(cell) {
    var he = cell.halfedges;
    if (!he || he.length === 0) { return null; }
    var verts = [];
    var v = getStartpoint(he[0]);
    verts.push({ x: v.x, y: v.y });
    for (var i = 0; i < he.length; i++) {
        v = getEndpoint(he[i]);
        verts.push({ x: v.x, y: v.y });
    }
    return verts;
}
function tfxCentroid(verts) {
    var cx = 0, cy = 0;
    for (var i = 0; i < verts.length; i++) { cx += verts[i].x; cy += verts[i].y; }
    return { x: cx / verts.length, y: cy / verts.length };
}
function tfxMaxRadius(verts, cx, cy) {
    var r = 0;
    for (var i = 0; i < verts.length; i++) {
        var dx = verts[i].x - cx, dy = verts[i].y - cy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) { r = d; }
    }
    return r;
}
// Axis-aligned bounds of a verts polygon (world coords). Precomputed per cell at
// build time so tfxPathCells can frustum-cull without re-scanning verts.
function tfxBBox(verts) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < verts.length; i++) {
        var p = verts[i];
        if (p.x < minX) { minX = p.x; }
        if (p.x > maxX) { maxX = p.x; }
        if (p.y < minY) { minY = p.y; }
        if (p.y > maxY) { maxY = p.y; }
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}
// Path a list of cells' polygons into the current ctx path (world coords + cam),
// ready for clip() or fill(). Each cell is a verts array (or a record with a
// `.verts` field plus a precomputed bbox). On a big/collapsing map the lava/ice
// lists can be most of the board; the camera is pure translation (scale === 1,
// visible world span === LOGICAL_WIDTH/HEIGHT), so cells whose bbox is fully off
// the screen contribute nothing to a clip/fill and are skipped. Records without a
// bbox (e.g. goal clusters, a handful) are always included.
function tfxPathCells(ctx, cells, camX, camY) {
    var W = (typeof LOGICAL_WIDTH === "number") ? LOGICAL_WIDTH : 0;
    var H = (typeof LOGICAL_HEIGHT === "number") ? LOGICAL_HEIGHT : 0;
    var cull = (W > 0 && H > 0);
    var M = 96; // margin so partial-edge cells never pop
    var loX = -camX - M, hiX = -camX + W + M;
    var loY = -camY - M, hiY = -camY + H + M;
    ctx.beginPath();
    for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var verts = cell.verts || cell;
        if (cull && cell.maxX !== undefined &&
            (cell.maxX < loX || cell.minX > hiX || cell.maxY < loY || cell.minY > hiY)) {
            continue;
        }
        ctx.moveTo(verts[0].x + camX, verts[0].y + camY);
        for (var v = 1; v < verts.length; v++) {
            ctx.lineTo(verts[v].x + camX, verts[v].y + camY);
        }
        ctx.closePath();
    }
}

// ---- per-map dataset builders -----------------------------------------
function tfxBuildCells() {
    var tm = config.tileMap;
    if (terrainFX.abilityIcons == null) { terrainFX.abilityIcons = tfxBuildAbilityIcons(); }
    terrainFX.ice = []; terrainFX.lava = []; terrainFX.goal = []; terrainFX.ability = [];
    var cells = currentMap.cells;
    for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var verts = tfxCellVerts(cell);
        if (!verts) { continue; }
        var c = tfxCentroid(verts);
        var bb = tfxBBox(verts);
        var rec = { verts: verts, cx: c.x, cy: c.y, vid: (cell.site ? cell.site.voronoiId : i),
            minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY };
        if (cell.id === tm.ice.id) { terrainFX.ice.push(rec); }
        else if (cell.id === tm.lava.id) { terrainFX.lava.push(rec); }
        else if (cell.id === tm.goal.id) { terrainFX.goal.push(rec); }
        else if (terrainFX.abilityIcons[cell.id] != null) {
            rec.id = cell.id;
            rec.r = tfxMaxRadius(verts, c.x, c.y);
            terrainFX.ability.push(rec);
        }
    }
    tfxBuildGoalClusters();
    tfxBuildLavaSeeds();
}
// Group touching goal cells into clusters (union-find over voronoi adjacency) so
// a multi-cell goal reads as ONE beacon centred on the cluster, not a beacon per
// tile. Each cluster stores its centroid, radius and member polygons (for clip).
function tfxBuildGoalClusters() {
    terrainFX.goalClusters = [];
    var goals = terrainFX.goal;
    var n = goals.length;
    if (n === 0) { return; }
    var vid2idx = {};
    for (var i = 0; i < n; i++) { vid2idx[goals[i].vid] = i; }
    var parent = [];
    for (i = 0; i < n; i++) { parent[i] = i; }
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { parent[find(a)] = find(b); }
    var cells = currentMap.cells, goalId = config.tileMap.goal.id;
    for (i = 0; i < cells.length; i++) {
        var cell = cells[i];
        if (cell.id !== goalId || cell.site == null) { continue; }
        var myIdx = vid2idx[cell.site.voronoiId];
        if (myIdx == null) { continue; }
        var he = cell.halfedges;
        for (var h = 0; h < he.length; h++) {
            var e = he[h].edge;
            var nb = compareSite(e.lSite, he[h].site) ? e.rSite : e.lSite;
            if (nb != null && vid2idx[nb.voronoiId] != null) { union(myIdx, vid2idx[nb.voronoiId]); }
        }
    }
    var groups = {};
    for (i = 0; i < n; i++) { var root = find(i); (groups[root] = groups[root] || []).push(i); }
    for (var key in groups) {
        var idxs = groups[key], cx = 0, cy = 0, verts = [];
        for (var k = 0; k < idxs.length; k++) { var g = goals[idxs[k]]; cx += g.cx; cy += g.cy; verts.push(g.verts); }
        cx /= idxs.length; cy /= idxs.length;
        var r = 0;
        for (k = 0; k < idxs.length; k++) {
            var gv = goals[idxs[k]].verts;
            var rr = tfxMaxRadius(gv, cx, cy);
            if (rr > r) { r = rr; }
        }
        terrainFX.goalClusters.push({ cx: cx, cy: cy, r: r, cells: verts });
    }
}
// One bubbling hotspot per lava cell (at its centroid), capped so a full-map
// collapse doesn't spawn thousands. Subset by stride when over the cap.
function tfxBuildLavaSeeds() {
    terrainFX.lavaSeeds = [];
    var lava = terrainFX.lava;
    if (!lava.length) { return; }
    var MAX = 70;
    var stride = Math.max(1, Math.floor(lava.length / MAX));
    for (var i = 0; i < lava.length; i += stride) {
        var c = lava[i];
        var r = tfxMaxRadius(c.verts, c.cx, c.cy);
        terrainFX.lavaSeeds.push({
            x: c.cx, y: c.cy,
            r: Math.min(r * 0.9, 46) + 10,
            ph: Math.random() * 6.28,
            sp: 0.7 + Math.random() * 0.7
        });
    }
}
// ---- per-frame draw ----------------------------------------------------
function drawTerrainFX(dtIgnored) {
    if (!terrainFXActive()) { return; }
    if (terrainFX.rev !== mapCacheRev) { tfxBuildCells(); terrainFX.rev = mapCacheRev; }

    var t = Date.now() / 1000;
    var camX = camera.getCameraX(), camY = camera.getCameraY();
    var extra = (typeof perfExtraFx === "function") ? perfExtraFx() : true;

    if (extra) {
        tfxDrawLavaConvection(t, camX, camY);
        tfxDrawIceReflections(camX, camY);
    }
    tfxDrawGoalBeacon(t, camX, camY);    // always — cheap + gameplay-critical
    tfxDrawAbilityIcons(t, camX, camY);  // always — gameplay-critical pickup markers
}

// Ability pickups: float the icon above the tile (gentle bob + soft ground
// shadow), like the lobby hub glyphs, instead of sitting flat in the texture.
function tfxDrawAbilityIcons(t, camX, camY) {
    var list = terrainFX.ability;
    if (!list.length || terrainFX.abilityIcons == null) { return; }
    var ctx = gameContext;
    for (var i = 0; i < list.length; i++) {
        var a = list[i];
        var icon = terrainFX.abilityIcons[a.id];
        if (icon == null || !icon.complete || icon.naturalWidth === 0) { continue; }
        var cx = a.cx + camX, cy = a.cy + camY;
        var d = Math.max(16, Math.min(a.r * 0.7, 30));
        var bob = Math.sin(t * 2.4 + a.cx * 0.05) * 4;
        var lift = 6;
        // soft ground shadow (fainter/smaller as the icon rises)
        var rise = (bob + 4) / 8; // 0..1
        ctx.save();
        ctx.globalAlpha = 0.30 - 0.10 * rise;
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.ellipse(cx, cy + d * 0.34, d * 0.42 * (1 - 0.12 * rise), d * 0.16 * (1 - 0.12 * rise), 0, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
        // floating icon
        ctx.drawImage(icon, cx - d / 2, cy - d / 2 - lift - bob, d, d);
    }
}

function tfxDrawGoalBeacon(t, camX, camY) {
    var cl = terrainFX.goalClusters;
    if (!cl.length) { return; }
    var ctx = gameContext;
    var breath = 0.5 + 0.5 * Math.sin(t * 1.6);
    var ring = (t * 0.5) % 1;
    for (var i = 0; i < cl.length; i++) {
        var g = cl[i], cx = g.cx + camX, cy = g.cy + camY, s = g.r;
        ctx.save();
        tfxPathCells(ctx, g.cells, camX, camY);
        ctx.clip();
        var cr = s * (0.5 + 0.22 * breath);
        var core = ctx.createRadialGradient(cx, cy, 2, cx, cy, cr);
        core.addColorStop(0, "rgba(255,255,255," + (0.30 + 0.40 * breath) + ")");
        core.addColorStop(1, "rgba(255,232,154,0)");
        ctx.fillStyle = core;
        ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
        var rr = s * 0.25 + ring * s * 0.8;
        ctx.globalAlpha = (1 - ring) * 0.7;
        ctx.lineWidth = 3 + (1 - ring) * 3;
        ctx.strokeStyle = "#FFE89A";
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.restore();
    }
}

function tfxDrawLavaConvection(t, camX, camY) {
    var lava = terrainFX.lava, seeds = terrainFX.lavaSeeds;
    if (!lava.length || !seeds.length) { return; }
    var ctx = gameContext;
    ctx.save();
    tfxPathCells(ctx, lava, camX, camY);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < seeds.length; i++) {
        var s = seeds[i];
        var ph = Math.sin(t * s.sp + s.ph);
        var a = 0.18 * (0.6 + 0.4 * ph);
        var r = s.r * (0.7 + 0.4 * (0.5 + 0.5 * ph));
        var x = s.x + camX + Math.cos(t * s.sp * 0.7 + s.ph) * s.r * 0.15;
        var y = s.y + camY + Math.sin(t * s.sp * 0.7 + s.ph) * s.r * 0.15;
        var g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, "rgba(255,210,90," + a + ")");
        g.addColorStop(0.55, "rgba(255,120,25," + (a * 0.6) + ")");
        g.addColorStop(1, "rgba(255,90,10,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fill();
    }
    ctx.restore();
}

function tfxDrawIceReflections(camX, camY) {
    var ice = terrainFX.ice;
    if (!ice.length || typeof playerList === "undefined" || playerList == null) { return; }
    var ctx = gameContext;
    ctx.save();
    tfxPathCells(ctx, ice, camX, camY);
    ctx.clip();
    var useBlur = (typeof perfGlow === "function") ? perfGlow() : true;
    for (var id in playerList) {
        var p = playerList[id];
        if (p == null || p.alive === false) { continue; }
        var rad = p.radius || 16;
        var x = p.x + camX, y = p.y + camY;
        // Cast the reflection fully BELOW the kart so its top sits at the kart's
        // base (not hidden behind the body). Flip + squash about that pivot, and
        // render the kart's ACTUAL appearance (skin-aware via drawKartAppearance)
        // at low alpha + blur, so it stays faint and works for any current or
        // future skin.
        var pivot = y + rad * 1.95;
        ctx.save();
        ctx.globalAlpha = 0.38;
        if (useBlur && "filter" in ctx) { ctx.filter = "blur(2.5px)"; }
        ctx.translate(x, pivot);
        ctx.scale(1.0, -0.85);
        ctx.translate(-x, -pivot);
        if (typeof drawKartAppearance === "function") {
            drawKartAppearance(p, x, pivot);
        }
        ctx.restore();
    }
    ctx.restore();
}

