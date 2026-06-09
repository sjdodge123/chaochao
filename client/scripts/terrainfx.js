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
// Bunker (battle-royale) silo-door state, set by the bunkerStart/bunkerEmerge
// socket handlers (client.js) and cleared each round (newMap). null when no
// Bunker round is active.
var bunkerFX = null;
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
    set("starPower", typeof starIcon !== "undefined" ? starIcon : null);
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
// World-space rect currently visible on screen, or null if it can't be computed
// (cull disabled). The active transform is applyWorldTransform (draw.js): a world
// point wx maps to logical `scale*(wx - worldView.cx) + LOGICAL_WIDTH/2`, so the
// visible half-extent is LOGICAL_W/H / (2*scale) centred on worldView.cx/cy. With
// no zoom (worldView null) world maps ~1:1 into the logical viewport, so the
// visible world rect is just [-cam, -cam + LOGICAL] (cam offset is 0 in practice,
// but kept for correctness). A margin keeps partial-edge cells from popping.
function tfxVisibleWorldRect(camX, camY) {
    var W = (typeof LOGICAL_WIDTH === "number") ? LOGICAL_WIDTH : 0;
    var H = (typeof LOGICAL_HEIGHT === "number") ? LOGICAL_HEIGHT : 0;
    if (!(W > 0 && H > 0)) { return null; }
    var M = 96;
    if (typeof worldView !== "undefined" && worldView != null && worldView.cx != null) {
        var s = worldView.scale || 1;
        var hw = W / (2 * s) + M, hh = H / (2 * s) + M;
        return { loX: worldView.cx - hw, hiX: worldView.cx + hw,
                 loY: worldView.cy - hh, hiY: worldView.cy + hh };
    }
    return { loX: -camX - M, hiX: -camX + W + M, loY: -camY - M, hiY: -camY + H + M };
}
// Path a list of cells' polygons into the current ctx path (world coords + cam),
// ready for clip() or fill(). Each cell is a verts array (or a record with a
// `.verts` field plus a precomputed bbox). On a big/collapsing map the lava/ice
// lists can be most of the board, so cells whose bbox is fully outside the visible
// world rect contribute nothing to a clip/fill and are skipped — the win shows up
// when zoomed in (scale > 1 shrinks the rect). Records without a bbox (e.g. goal
// clusters, a handful) are always included.
function tfxPathCells(ctx, cells, camX, camY) {
    var vr = tfxVisibleWorldRect(camX, camY);
    ctx.beginPath();
    for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var verts = cell.verts || cell;
        if (vr != null && cell.maxX !== undefined &&
            (cell.maxX < vr.loX || cell.minX > vr.hiX || cell.maxY < vr.loY || cell.minY > vr.hiY)) {
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
    tfxDrawBunker(t, camX, camY);        // battle-royale silo door (no-op when inactive)
    tfxDrawGoalBeacon(t, camX, camY);    // always — cheap + gameplay-critical
    tfxDrawAbilityIcons(t, camX, camY);  // always — gameplay-critical pickup markers
}

// Battle-royale silo door over the buried goal. An iris of metal blades closes
// over the goal at round start (sink), holds shut while the goal is buried (a warm
// glow leaks through to telegraph where it is), then snaps open for the lone
// survivor (emerge) — at which point the normal goal beacon takes back over.
// Fit the silo door to the buried goal's ACTUAL footprint (its cell polygons), so
// it hugs the goal tile(s) and never spills onto neighbours. Cached on fx — the
// geometry doesn't move once set. Falls back to the server-sent centre/radius.
function tfxComputeBunkerDoor(fx) {
    if (typeof currentMap === "undefined" || currentMap == null || currentMap.cells == null) { return false; }
    var lidSet = {};
    for (var i = 0; i < fx.lid.length; i++) { lidSet[fx.lid[i]] = true; }
    var doorCells = [], verts = [], sx = 0, sy = 0, n = 0;
    for (var i = 0; i < currentMap.cells.length; i++) {
        var cell = currentMap.cells[i];
        if (!lidSet[cell.site.voronoiId]) { continue; }
        var vv = tfxCellVerts(cell);
        if (!vv) { continue; }
        doorCells.push({ verts: vv }); // for clipping the door to the tile polygon
        for (var v = 0; v < vv.length; v++) { verts.push(vv[v]); sx += vv[v].x; sy += vv[v].y; n++; }
    }
    if (n === 0) { return false; }
    var cx = sx / n, cy = sy / n, r = 0;
    for (var v = 0; v < verts.length; v++) {
        var dx = verts[v].x - cx, dy = verts[v].y - cy, d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) { r = d; }
    }
    fx.doorCells = doorCells;
    fx.doorCx = cx; fx.doorCy = cy; fx.doorR = Math.max(r, 20);
    return true;
}
function tfxDrawBunker(t, camX, camY) {
    if (typeof bunkerFX === "undefined" || bunkerFX == null) { return; }
    var fx = bunkerFX;
    if (fx.doorR == null) { tfxComputeBunkerDoor(fx); }
    var EMERGE = 0.5;
    var door; // 1 = fully closed (goal hidden), 0 = fully open (goal exposed)
    if (fx.phase === "emerging") {
        var op = Math.min(1, (Date.now() - fx.animStart) / (EMERGE * 1000));
        door = 1 - op;
        if (op >= 1) { fx.phase = "done"; return; }
    } else if (fx.phase === "buried") {
        var racing = (typeof currentState !== "undefined") &&
            (currentState === config.stateMap.racing || currentState === config.stateMap.collapsing);
        if (racing) {
            door = 1; // race underway — the door is fully sealed over the buried goal
        } else if (fx.camCover != null) {
            // Camera-driven close: sealed during the gated whole-map beat so the player
            // actually watches it shut.
            door = fx.camCover;
        } else {
            // Dynamic camera off (whole map always in view) — fixed sink.
            door = Math.min(1, (Date.now() - fx.animStart) / 1200);
        }
    } else {
        return; // done — beacon handles the exposed goal
    }

    var ctx = gameContext;
    // Without the goal-tile polygon we can't clip the door to the tile bounds — skip
    // this frame rather than draw an oversized circle (geometry is retried next frame).
    if (fx.doorCells == null || fx.doorCells.length === 0) { return; }
    var cx = fx.doorCx + camX, cy = fx.doorCy + camY, R = fx.doorR;
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.0);
    var cover = door;

    ctx.save();
    // Clip EVERYTHING to the goal tile's actual polygon, so the door can never spill
    // past the tile edge — the iris/glow are sized to overshoot and the clip trims
    // them to the tile shape.
    tfxPathCells(ctx, fx.doorCells, camX, camY);
    ctx.clip();

    // Goal glow leaking through the iris — shrinks as the door closes, blooms as it opens.
    var glowR = Math.max(2, R * (0.5 + 0.8 * (1 - door)));
    var glow = ctx.createRadialGradient(cx, cy, 1, cx, cy, glowR);
    glow.addColorStop(0, "rgba(255,210,90," + (0.55 * (1 - door) + 0.10 + 0.06 * pulse) + ")");
    glow.addColorStop(1, "rgba(255,180,40,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // Iris blades: 6 wedges that converge on the center as the door closes. Sized to
    // overshoot the tile (bladeR > R); the clip above trims them to the tile polygon.
    var NB = 6;
    if (cover > 0.001) {
        var twist = (1 - cover) * 0.6;
        var inner = R * (1 - cover) * 0.95;
        var bladeR = R * 1.3;
        for (var b = 0; b < NB; b++) {
            var a0 = (b / NB) * Math.PI * 2 + twist;
            var a1 = a0 + (Math.PI * 2 / NB);
            ctx.beginPath();
            ctx.arc(cx, cy, bladeR, a0, a1);
            ctx.arc(cx, cy, inner, a1, a0, true);
            ctx.closePath();
            ctx.fillStyle = (b % 2 === 0) ? "rgba(64,70,78,0.92)" : "rgba(52,58,66,0.92)";
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(28,32,38,0.8)";
            ctx.stroke();
        }
        if (cover > 0.85) { // center bolt only when shut
            ctx.fillStyle = "rgba(150,158,168,0.9)";
            ctx.beginPath(); ctx.arc(cx, cy, Math.min(4, R * 0.18), 0, 2 * Math.PI); ctx.fill();
        }
    }

    // Silo rim = the goal tile's own boundary. Drawn INSIDE the clip with a doubled
    // line so only the inner half shows — the frame stays fully within the tile.
    tfxPathCells(ctx, fx.doorCells, camX, camY);
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(70,76,84,0.95)";
    ctx.stroke();
    tfxPathCells(ctx, fx.doorCells, camX, camY);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(150,158,168,0.55)";
    ctx.stroke();
    ctx.restore();
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

// Shared scratch for the glow-profile blurred reflection. The kart's appearance is
// painted UNFILTERED at device resolution into this small offscreen canvas, and only
// the single drawImage onto the main canvas goes through ctx.filter. Re-painting the
// full procedural skin (dozens of path/gradient ops for some carts) per kart per
// frame WITH the blur filter active pushed every op through a slow intermediate-
// surface path — a populated room in cosmetics collapsed to 2-5 FPS from this alone.
var _tfxReflScratch = null;
function tfxDrawIceReflections(camX, camY) {
    var ice = terrainFX.ice;
    if (!ice.length || typeof playerList === "undefined" || playerList == null) { return; }
    var ctx = gameContext;
    var vr = tfxVisibleWorldRect(camX, camY);
    var clipped = false;
    var useBlur = (typeof perfGlow === "function") ? perfGlow() : true;
    for (var id in playerList) {
        var p = playerList[id];
        if (p == null || p.alive === false) { continue; }
        var rad = p.radius || 16;
        // Half-extent of the painted appearance: borders ring out to ~1.4r and the
        // punch pop scales up to ~1.3x, so 2.2r covers every current cosmetic.
        var ext = rad * 2.2;
        // World bbox the reflection can touch (it casts BELOW the kart, see pivot
        // math under the blit): x +- ext, y .. y + ~4r, plus the 2.5px blur bleed.
        var rminX = p.x - ext - 4, rmaxX = p.x + ext + 4;
        var rminY = p.y, rmaxY = p.y + rad * 4 + 4;
        // Skip karts whose reflection is off-screen or can't overlap any ice cell —
        // the clip would discard every pixel, but the painter ops would still run
        // (previously EVERY alive kart paid the full filtered repaint each frame
        // whenever the map had any ice at all, even nowhere near it).
        if (vr != null && (rmaxX < vr.loX || rminX > vr.hiX || rmaxY < vr.loY || rminY > vr.hiY)) { continue; }
        var near = false;
        for (var ci = 0; ci < ice.length; ci++) {
            var cb = ice[ci];
            if (rmaxX >= cb.minX && rminX <= cb.maxX && rmaxY >= cb.minY && rminY <= cb.maxY) { near = true; break; }
        }
        if (!near) { continue; }
        if (!clipped) {
            // Defer the save+clip until a kart actually reflects (most frames none do).
            ctx.save();
            tfxPathCells(ctx, ice, camX, camY);
            ctx.clip();
            clipped = true;
        }
        var x = p.x + camX, y = p.y + camY;
        // Cast the reflection fully BELOW the kart so its top sits at the kart's
        // base (not hidden behind the body). Flip + squash about that pivot, and
        // render the kart's ACTUAL appearance (skin-aware via drawKartAppearance)
        // at low alpha + blur, so it stays faint and works for any current or
        // future skin.
        var pivot = y + rad * 1.95;
        ctx.save();
        ctx.globalAlpha = 0.38;
        if (useBlur && "filter" in ctx && typeof drawKartAppearance === "function") {
            // Glow profiles: paint the appearance into the scratch (no filter), then
            // blur only the one blit. Same transform state as the old direct path,
            // so the blur and squash read identically.
            var sx = (typeof canvasScaleX !== "undefined" && canvasScaleX) ? canvasScaleX : 1;
            var sy = (typeof canvasScaleY !== "undefined" && canvasScaleY) ? canvasScaleY : 1;
            var w = Math.ceil(ext * 2 * sx), h = Math.ceil(ext * 2 * sy);
            if (_tfxReflScratch == null) { _tfxReflScratch = document.createElement("canvas"); }
            var s = _tfxReflScratch;
            if (s.width < w) { s.width = w; }
            if (s.height < h) { s.height = h; }
            var sctx = s.getContext("2d");
            sctx.setTransform(1, 0, 0, 1, 0, 0);
            sctx.clearRect(0, 0, w, h);
            sctx.setTransform(sx, 0, 0, sy, 0, 0);
            // The skin painters draw through the gameContext global, so point it at
            // the scratch for the repaint and ALWAYS restore (try/finally) so a
            // throwing painter can't hijack the rest of the frame.
            var prevCtx = gameContext;
            gameContext = sctx;
            try { drawKartAppearance(p, ext, ext); } finally { gameContext = prevCtx; }
            ctx.filter = "blur(2.5px)";
            ctx.translate(x, pivot);
            ctx.scale(1.0, -0.85);
            ctx.drawImage(s, 0, 0, w, h, -ext, -ext, ext * 2, ext * 2);
        } else {
            // No-glow profiles never paid the filter, so keep the direct repaint.
            ctx.translate(x, pivot);
            ctx.scale(1.0, -0.85);
            ctx.translate(-x, -pivot);
            if (typeof drawKartAppearance === "function") {
                drawKartAppearance(p, x, pivot);
            }
        }
        ctx.restore();
    }
    if (clipped) {
        ctx.restore();
    }
}

