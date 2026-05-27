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
    if (!mapIsSitesOnly(map)) { return map; }
    var siteObjs = new Array(map.sites.length);
    for (var i = 0; i < map.sites.length; i++) {
        siteObjs[i] = { x: map.sites[i].x, y: map.sites[i].y };
    }
    var diagram = new Voronoi().compute(siteObjs, map.bbox);
    for (var j = 0; j < map.sites.length; j++) {
        var vid = siteObjs[j].voronoiId;
        if (vid == null || diagram.cells[vid] == null) { continue; }
        diagram.cells[vid].id = map.sites[j].id;
    }
    diagram.hazards = map.hazards || [];
    if (map.startEdges != null) { diagram.startEdges = map.startEdges; }
    if (map.parTime != null) { diagram.parTime = map.parTime; }
    if (map.lobbyOnly) { diagram.lobbyOnly = map.lobbyOnly; }
    if (map.name != null) { diagram.name = map.name; }
    if (map.author != null) { diagram.author = map.author; }
    if (map.id != null) { diagram.id = map.id; }
    if (map.email != null) { diagram.email = map.email; }
    return diagram;
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
    grass:  { sat: 0.60, light: 0.90, contrast: 0.92 }, // kill the neon lime
    dirt:   { sat: 0.90, light: 0.98, contrast: 0.96 }, // anchor tone, barely touched
    sand:   { sat: 0.92, light: 0.86, contrast: 0.95 }, // drop the bright glow
    ice:    { sat: 0.82, light: 0.97, contrast: 1.00, tint: [120, 200, 236], tintAmt: 0.20 }, // deepen blue via tint, mute sparkle noise
    lava:   { sat: 0.92, light: 0.96, contrast: 1.00 }, // still hot, a touch less fluorescent
    poison: { sat: 0.92, light: 0.96, contrast: 1.00 }  // lava's infection-round swap
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