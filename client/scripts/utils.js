function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Maps are stored/shipped in the compact sites-only format ({bbox, sites:[{x,y,id}]}
// + metadata); the full voronoi geometry (cells/halfedges/edges) is regenerated on
// the client the same deterministic way the server does it (server/mapFormat.js).
// Both the play and create bundles include rhill-voronoi-core.js, so Voronoi is a
// global here. Legacy full-geometry maps pass through unchanged.
function mapIsSitesOnly(map) {
    return map != null && Array.isArray(map.sites) && !Array.isArray(map.cells);
}
function reconstructSitesOnlyMap(map) {
    if (!mapIsSitesOnly(map) || map.bbox == null) { return map; }
    try {
        var siteObjs = new Array(map.sites.length);
        for (var i = 0; i < map.sites.length; i++) {
            siteObjs[i] = { x: map.sites[i].x, y: map.sites[i].y };
        }
        var diagram = new Voronoi().compute(siteObjs, map.bbox);
        // Drop rhill's vestigial top-level `site` (null, never read) — matches server.
        delete diagram.site;
        for (var j = 0; j < map.sites.length; j++) {
            var vid = siteObjs[j].voronoiId;
            if (vid == null || diagram.cells[vid] == null) { continue; }
            diagram.cells[vid].id = map.sites[j].id;
        }
        diagram.hazards = map.hazards || [];
        // Carry every non-geometry field by denylist (matches server mapFormat.js):
        // an allowlist silently drops map-type fields like the lobby map's
        // spawnPad/stations. bbox/sites are the sites-only representation;
        // cells/edges/vertices/execTime are regenerated above.
        var GEOMETRY_KEYS = { cells: 1, edges: 1, vertices: 1, execTime: 1, thumbnail: 1, sites: 1, bbox: 1, hazards: 1 };
        for (var key in map) {
            if (GEOMETRY_KEYS[key]) { continue; }
            if (diagram[key] === undefined) { diagram[key] = map[key]; }
        }
        return diagram;
    } catch (e) {
        // A malformed sites-only map must not throw out of the $.getJSON callback
        // that loads every map (that would abort loading the others). Return it
        // unchanged so just this one map is unusable.
        if (typeof console !== "undefined") { console.warn("map reconstruction failed", map && map.id, e); }
        return map;
    }
}

Colors = {};
Colors.names = {
    Red: '#e6194B',
    Green: '#3cb44b',
    Yellow: '#ffe119',
    Blue: '#4363d8',
    Orange: '#f58231',
    Purple: '#911eb4',
    Cyan: '#42d4f4',
    Magenta: '#f032e6',
    Lime: '#bfef45',
    Pink: '#fabed4',
    Teal: '#469990',
    Lavender: '#dcbeff',
    Brown: '#9A6324',
    Beige: '#fffac8',
    Maroon: '#800000',
    Mint: '#aaffc3',
    Olive: '#808000',
    Apricot: '#ffd8b1',
    Navy: '#000075',
    Grey: '#8A8A8A',
    White: '#ffffff',
    DarkGrey: '#454545'
};
Colors.random = function () {
    var result;
    var count = 0;
    for (var prop in this.names) {
        if (Math.random() < 1 / ++count) {
            result = this.names[prop];
        }
    }
    return result;
};
Colors.decode = function (input) {
    for (var prop in this.names) {
        if (input == this.names[prop]) {
            return prop;
        }
    }
    return "A player";
}
// Display label for a player. AI racers keep their personality name; human
// players (name === null) are labelled by the colour they're playing — decoded
// from the authoritative server hex, since colour-blind assist may remap .color
// off-palette (same convention as the "X won the game." headline).
Colors.nameFor = function (player) {
    if (player == null) { return "Someone"; }
    if (player.name != null) { return player.name; }
    var hex = (player._serverColor != null) ? player._serverColor : player.color;
    return this.decode(hex);
}

function getColor() {
    return 'hsl(' + Math.floor(Math.random() * 360) + ', 100%, 50%)';
};

function getMagSq(x1, y1, x2, y2) {
    return Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2);
}
function getMagSquared(x, y) {
    return Math.pow(x, 2) + Math.pow(y, 2);
}

function angle(originX, originY, targetX, targetY) {
    var dx = originX - targetX;
    var dy = originY - targetY;
    var theta = Math.atan2(-dy, -dx);
    theta *= 180 / Math.PI;
    if (theta < 0) theta += 360;
    return theta;
}
function pos(point, length, angle) {
    var a = angle * Math.PI / 180;
    var x = point.x + length * Math.cos(a);
    var y = point.y + length * Math.sin(a);
    return { x, y };
}

// --- Animation easing + small render helpers (client render only) ---
// Used by the effects/particle system, screen-shake trauma, the brutal-round
// title entrance, and the tileSwap telegraph. All take/return normalized t in
// [0,1] unless noted.
function clamp01(t) {
    // NaN-safe: a NaN here (e.g. a 0/0 from a zero-duration fade) would otherwise
    // slip through both comparisons and poison globalAlpha, hiding every draw in
    // the context. Clamp it to 0 so a bad input degrades to "invisible", not "NaN".
    if (!(t > 0)) return 0;   // false for t<=0 AND for NaN
    if (t > 1) return 1;
    return t;
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
// Smoothstep: the classic 0..1 cubic with zero slope at both ends (camera
// blends, gate-intro arc). Clamps t NaN-safely via clamp01, so out-of-range or
// 0/0 inputs degrade to the nearest endpoint instead of poisoning a transform.
function smoothstep(t) {
    t = clamp01(t);
    return t * t * (3 - 2 * t);
}
function easeOutQuad(t) {
    return 1 - (1 - t) * (1 - t);
}
function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}
// Overshoots past 1 then settles — gives the title card a little "pop".
function easeOutBack(t) {
    var c1 = 1.70158;
    var c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// --- Terrain texture colour grading -------------------------------------
// Shared by the game (draw.js) and the map editor (create.js) so both render
// terrain from the same palette. The six terrain textures (grass/dirt/sand/
// lava/ice/poison) were authored independently, so their saturation and
// brightness clash hard — neon-lime grass beside washed-out pale sand and ice.
// gradeTexture() bakes them ONCE at load into a shared band: tame saturation,
// pull the over-bright tiles down, gently flatten contrast. HUE IS PRESERVED,
// so every tile stays just as recognisable (green is still green, lava red).
//
// Per-texture knobs: sat = saturation multiplier, light = lightness
// multiplier, contrast = pull toward mid (<1 = calmer/flatter); optional
// tint = [r,g,b] master colour and tintAmt = 0..1 blend toward it (in RGB,
// after the HSL pass). Applied per pixel; alpha untouched. Live-tunable.
//
// NOTE on ice: it's a near-white texture with tiny coloured sparkle pixels
// baked in. MULTIPLYING saturation amplifies those into rainbow confetti, so
// ice instead REDUCES saturation (to mute the speckles) and deepens its blue
// with a tint blend — averaging toward one colour smooths noise out.
var TILE_GRADE_ENABLED = true;
var TILE_GRADE = {
    grass:  { sat: 0.85, light: 0.92, contrast: 1.05, tint: [80, 140, 70], tintAmt: 0.10 },   // richer meadow green (still no neon)
    dirt:   { sat: 1.06, light: 0.98, contrast: 1.04, tint: [150, 95, 50], tintAmt: 0.12 },    // warm rich soil
    sand:   { sat: 1.04, light: 0.90, contrast: 1.05, tint: [205, 160, 90], tintAmt: 0.10 },   // warm sun-baked gold
    ice:    { sat: 0.85, light: 0.95, contrast: 1.05, tint: [90, 180, 230], tintAmt: 0.28 },   // deeper blue, mute sparkle noise
    lava:   { sat: 1.05, light: 0.95, contrast: 1.12, tint: [210, 70, 20], tintAmt: 0.10 },    // hotter, higher contrast
    poison: { sat: 0.92, light: 0.96, contrast: 1.00 }  // lava's infection-round swap (unchanged)
};

function _rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) {
        h = s = 0;
    } else {
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            default: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h, s, l];
}
function _hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}
function _hslToRgb(h, s, l) {
    var r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        r = _hue2rgb(p, q, h + 1 / 3);
        g = _hue2rgb(p, q, h);
        b = _hue2rgb(p, q, h - 1 / 3);
    }
    return [r * 255, g * 255, b * 255];
}

// Grade `image` by `key` into an offscreen canvas, memoised on the image so
// repeat loadPatterns() calls (infection toggle, theme change) don't re-grade.
// Returns the graded canvas — a drawable usable anywhere the raw image was. Any
// `image.scale` is copied onto the canvas so callers that scale by it (the
// editor's makeSeamlessPattern) keep working.
function gradeTexture(image, key) {
    var spec = TILE_GRADE_ENABLED ? TILE_GRADE[key] : null;
    if (image._gradeKey === key && image._gradeOn === !!spec && image._gradedCanvas != null) {
        return image._gradedCanvas;
    }
    // Size the tile by the DECLARED dimensions (image.width/height), matching the
    // original makeSeamlessPattern: the source PNGs can be larger than their
    // `new Image(256,256)` hint (grass/dirt/ice/sand are natively 512), and the
    // patterns were tuned for the declared size — naturalWidth here would double
    // the tiling. drawImage scales the larger source down into w×h.
    var w = image.width || image.naturalWidth || 0;
    var h = image.height || image.naturalHeight || 0;
    // A mid-game joiner can call loadPatterns() before the textures decode
    // (see draw.js comment near requiredImages). When not decoded, return an
    // un-memoised throwaway canvas so the tileImagesReady/newMap self-heal can
    // re-grade once the image lands — caching a blank here would be permanent.
    var ready = image.complete && image.naturalWidth > 0;
    var canvas = document.createElement("canvas");
    canvas.width = w || 1;
    canvas.height = h || 1;
    if (image.scale != null) {
        canvas.scale = image.scale;
    }
    var ctx = canvas.getContext("2d");
    if (ready && w > 0 && h > 0) {
        ctx.drawImage(image, 0, 0, w, h);
    }
    var finish = function () {
        // Only cache once the source is decoded; otherwise a later call must be
        // free to re-grade (don't pin a transparent canvas).
        if (ready) {
            image._gradeKey = key;
            image._gradeOn = !!spec;
            image._gradedCanvas = canvas;
        }
        return canvas;
    };
    if (spec == null || !ready || w === 0 || h === 0) {
        return finish();
    }
    var sat = spec.sat != null ? spec.sat : 1;
    var light = spec.light != null ? spec.light : 1;
    var contrast = spec.contrast != null ? spec.contrast : 1;
    var tint = spec.tint || null;
    var tintAmt = tint != null && spec.tintAmt != null ? spec.tintAmt : 0;
    var data;
    try {
        data = ctx.getImageData(0, 0, w, h);
    } catch (e) {
        // Tainted canvas (shouldn't happen for same-origin assets) — fall back
        // to the ungraded texture rather than breaking the board.
        return finish();
    }
    var px = data.data;
    for (var i = 0; i < px.length; i += 4) {
        var hsl = _rgbToHsl(px[i], px[i + 1], px[i + 2]);
        var s = clamp01(hsl[1] * sat);
        var l = clamp01(0.5 + (hsl[2] * light - 0.5) * contrast);
        var rgb = _hslToRgb(hsl[0], s, l);
        if (tintAmt > 0) {
            rgb[0] = rgb[0] * (1 - tintAmt) + tint[0] * tintAmt;
            rgb[1] = rgb[1] * (1 - tintAmt) + tint[1] * tintAmt;
            rgb[2] = rgb[2] * (1 - tintAmt) + tint[2] * tintAmt;
        }
        px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2];
        // alpha (px[i + 3]) left untouched
    }
    ctx.putImageData(data, 0, 0);
    return finish();
}

// --- Boundary-only ambient-occlusion edge shading -----------------------
// A soft inner shadow drawn ONLY along edges where a terrain cell meets a
// DIFFERENT tile type (or the map's outer void). Edges shared with a same-type
// neighbour are skipped, so a contiguous grass/dirt/etc region stays seamless
// and only real terrain transitions read as depth. Shared by the game cache
// (draw.js), the editor (create.js) and the thumbnails (gameboard.js/create.js)
// so depth is identical everywhere. The shadow is tinted toward each tile's own
// dark so the crevice between two terrains feels natural.
var TILE_AO = {
    normal: { rgb: "20,12,4", a: 0.42 },   // dirt
    fast:   { rgb: "15,18,6", a: 0.40 },   // grass
    slow:   { rgb: "40,28,8", a: 0.40 },   // sand
    ice:    { rgb: "18,40,60", a: 0.38 },
    lava:   { rgb: "50,8,2", a: 0.45 }
};
var TILE_AO_DEPTH = 11; // how far the inner shadow reaches in from the edge
function tileAOEntry(id) {
    if (typeof config === "undefined" || config == null || config.tileMap == null) {
        return null;
    }
    var tm = config.tileMap;
    if (id === tm.normal.id) { return TILE_AO.normal; }
    if (id === tm.fast.id)   { return TILE_AO.fast; }
    if (id === tm.slow.id)   { return TILE_AO.slow; }
    if (id === tm.ice.id)    { return TILE_AO.ice; }
    if (id === tm.lava.id)   { return TILE_AO.lava; }
    return null; // goal / ability / bumper / random / background get no AO
}
// Map voronoiId -> tile id, so a cell's halfedge neighbours can be typed.
function buildIdByVoronoi(cells) {
    var m = {};
    for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        if (c != null && c.site != null) { m[c.site.voronoiId] = c.id; }
    }
    return m;
}
// Draw the boundary AO for one cell. `idByVoronoi` types its neighbours. Draws
// in whatever coords the caller's halfedge points use; leaves ctx unchanged.
function paintCellEdgeAO(ctx, cell, idByVoronoi) {
    if (cell == null || cell.site == null) { return; }
    var id = idByVoronoi[cell.site.voronoiId];
    var entry = tileAOEntry(id);
    if (entry == null) { return; }
    var he = cell.halfedges;
    if (!he || he.length === 0) { return; }
    var verts = [], i;
    var v = getStartpoint(he[0]);
    verts.push({ x: v.x, y: v.y });
    for (i = 0; i < he.length; i++) { v = getEndpoint(he[i]); verts.push({ x: v.x, y: v.y }); }
    var cx = 0, cy = 0;
    for (i = 0; i < verts.length; i++) { cx += verts[i].x; cy += verts[i].y; }
    cx /= verts.length; cy /= verts.length;
    // Collect only the EXPOSED edges (neighbour is a different type / the void).
    var exposed = [];
    for (i = 0; i < he.length; i++) {
        var e = he[i].edge;
        var nb = compareSite(e.lSite, he[i].site) ? e.rSite : e.lSite;
        var nbId = (nb != null) ? idByVoronoi[nb.voronoiId] : undefined;
        if (nbId === id) { continue; } // same-type seam — keep the region seamless
        exposed.push([getStartpoint(he[i]), getEndpoint(he[i])]);
    }
    if (exposed.length === 0) { return; }
    var depth = TILE_AO_DEPTH;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(verts[0].x, verts[0].y);
    for (i = 1; i < verts.length; i++) { ctx.lineTo(verts[i].x, verts[i].y); }
    ctx.closePath();
    ctx.clip();
    // Soft inner band built from a few concentric strokes of the exposed edges,
    // widening + fading outward. Strokes are centred on the edge (outer half is
    // clipped away), so only the interior darkens. Round caps/joins + one path
    // per pass mean no corner-doubling "triangles". Layering ≈ a smooth falloff.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    var passes = [
        { w: depth * 2.0, a: entry.a * 0.22 },
        { w: depth * 1.1, a: entry.a * 0.30 },
        { w: depth * 0.5, a: entry.a * 0.34 }
    ];
    for (var p = 0; p < passes.length; p++) {
        ctx.beginPath();
        for (i = 0; i < exposed.length; i++) {
            ctx.moveTo(exposed[i][0].x, exposed[i][0].y);
            ctx.lineTo(exposed[i][1].x, exposed[i][1].y);
        }
        ctx.lineWidth = passes[p].w;
        ctx.strokeStyle = "rgba(" + entry.rgb + "," + passes[p].a + ")";
        ctx.stroke();
    }
    ctx.restore();
}