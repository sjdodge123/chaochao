'use strict';

// Dependency-free server-side renderer for a submitted map.
//
// Why this exists: the map editor embeds a client-captured `thumbnail` JPEG in
// every submission, but that image is *client-supplied* — a crafted POST could
// pair an innocent thumbnail with cells that actually spell something obscene.
// This module redraws the map from the AUTHORITATIVE painted `cells` + the tile
// colours in config.json, so the reviewer sees exactly what will play. A
// mismatch between this render and the embedded thumbnail is itself a red flag.
//
// It is intentionally zero-dependency (Node's built-in `zlib` only): the PR
// validation CI is kept dependency-light on purpose (see pr-validation.yml), and
// a flat-colour Voronoi fill needs no canvas library — just a scanline polygon
// fill into an RGBA buffer and a hand-rolled PNG encoder.

const zlib = require('zlib');

// --- colour parsing ---------------------------------------------------------
// config tile colours are mostly hex (#RRGGBB / #RGB); "black" is the one named
// colour in use. Keep a tiny named table for safety against future edits.
const NAMED = {
    black: [0, 0, 0], white: [255, 255, 255],
    grey: [128, 128, 128], gray: [128, 128, 128], red: [255, 0, 0]
};
function parseColor(str) {
    if (typeof str !== 'string') { return [0, 0, 0]; }
    const s = str.trim().toLowerCase();
    if (NAMED[s]) { return NAMED[s].slice(); }
    let h = s.replace(/^#/, '');
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    if (h.length === 6 && /^[0-9a-f]{6}$/.test(h)) {
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return [0, 0, 0];
}

// Game-representative review palette, keyed by tile NAME. The literal config
// colours were chosen for the editor's flat-fill mode and read poorly as a
// standalone preview (slow/sand is "black", normal/dirt is near-white), which
// makes drawn imagery hard to read and the side-by-side against the in-game
// textured thumbnail confusing. These approximate the textured in-game tones so
// the render both reads naturally AND lines up visually with the thumbnail — a
// genuine geometry/layout mismatch between the two then stands out as the tell.
// Any tile NAME not listed falls back to its literal config colour, so this can
// only ever improve legibility, never hide a tile.
const REVIEW_PALETTE = {
    slow: '#C2B280',   // sand
    normal: '#8B6D5C', // dirt
    fast: '#5BB54B',   // grass
    lava: '#E8521E',
    ice: '#CFEFF5',
    ability: '#C8C8C8',
    goal: '#FFD700',
    bumper: '#FF7900',
    random: '#2C3EF0'
};
// id -> [r,g,b] from config.tileMap, preferring the review palette by tile name.
function buildTileColors(config) {
    const map = {};
    const tm = config.tileMap || {};
    for (const k in tm) {
        if (tm[k] && typeof tm[k].id === 'number') {
            const src = REVIEW_PALETTE[k] != null ? REVIEW_PALETTE[k] : tm[k].color;
            if (src != null) { map[tm[k].id] = parseColor(src); }
        }
    }
    return map;
}

// --- serialized-halfedge geometry (mirrors client/scripts/create.js) --------
// JSON carries no methods, so reimplement getStartpoint/getEndpoint. rhill's
// voronoi uses reference-equality `edge.lSite === site`; with a null lSite
// (world-boundary edge) that is false, so the endpoint falls through to vb/va.
function sameSite(a, b) {
    return a != null && b != null && a.voronoiId === b.voronoiId && a.x === b.x && a.y === b.y;
}
function startPoint(he) {
    return sameSite(he.edge.lSite, he.site) ? he.edge.va : he.edge.vb;
}

// Build the ordered polygon for a cell (array of {x,y} in world coords).
function cellPolygon(cell) {
    const pts = [];
    const hes = cell.halfedges;
    if (!Array.isArray(hes) || hes.length === 0) { return pts; }
    for (let i = 0; i < hes.length; i++) {
        const he = hes[i];
        if (he == null || he.edge == null) { continue; }
        const v = startPoint(he);
        if (v != null && typeof v.x === 'number' && typeof v.y === 'number') {
            pts.push({ x: v.x, y: v.y });
        }
    }
    return pts;
}

// --- raster -----------------------------------------------------------------
// Scanline-fill a polygon (even-odd) into an RGBA buffer at [r,g,b].
function fillPolygon(buf, W, H, pts, rgb) {
    if (pts.length < 3) { return; }
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    let y0 = Math.max(0, Math.ceil(minY));
    let y1 = Math.min(H - 1, Math.floor(maxY));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
        xs.length = 0;
        const yc = y + 0.5;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const a = pts[j], b = pts[i];
            if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
                xs.push(a.x + (yc - a.y) / (b.y - a.y) * (b.x - a.x));
            }
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            let xa = Math.max(0, Math.ceil(xs[k] - 0.5));
            let xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
            for (let x = xa; x <= xb; x++) {
                const o = (y * W + x) * 4;
                buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 255;
            }
        }
    }
}

// Box-downsample an RGBA buffer by integer factor `f` (cheap antialiasing).
function downsample(src, W, H, f) {
    const w = Math.floor(W / f), h = Math.floor(H / f);
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let dy = 0; dy < f; dy++) {
                for (let dx = 0; dx < f; dx++) {
                    const o = ((y * f + dy) * W + (x * f + dx)) * 4;
                    r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3];
                }
            }
            const n = f * f, oo = (y * w + x) * 4;
            out[oo] = (r / n) | 0; out[oo + 1] = (g / n) | 0;
            out[oo + 2] = (b / n) | 0; out[oo + 3] = (a / n) | 0;
        }
    }
    return { buf: out, w, h };
}

// --- PNG encode (RGBA, 8-bit) -----------------------------------------------
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
    return (~c) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    // filter byte 0 (None) prepended to each scanline.
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([
        sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
    ]);
}

// --- public -----------------------------------------------------------------
// Render `map` to a PNG Buffer. opts.width = target px width (default 683 =
// half the 1366 world). Renders at 2x then box-downsamples for light AA.
function renderMapToPng(map, config, opts) {
    opts = opts || {};
    const targetW = opts.width || 683;
    const SS = 2;
    const worldW = config.worldWidth, worldH = config.worldHeight;
    const scale = (targetW * SS) / worldW;
    const W = Math.round(worldW * scale);
    const H = Math.round(worldH * scale);
    const tileColors = buildTileColors(config);
    const bg = parseColor((config.tileMap.background && config.tileMap.background.color) || '#2b2b2b');

    const buf = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const o = i * 4; buf[o] = bg[0]; buf[o + 1] = bg[1]; buf[o + 2] = bg[2]; buf[o + 3] = 255;
    }
    const cells = Array.isArray(map.cells) ? map.cells : [];
    for (const cell of cells) {
        if (cell == null || typeof cell.id !== 'number') { continue; }
        const rgb = tileColors[cell.id];
        if (rgb == null) { continue; }
        const poly = cellPolygon(cell).map(p => ({ x: p.x * scale, y: p.y * scale }));
        fillPolygon(buf, W, H, poly, rgb);
    }
    const ds = downsample(buf, W, H, SS);
    return encodePng(ds.buf, ds.w, ds.h);
}

module.exports = { renderMapToPng, parseColor };
