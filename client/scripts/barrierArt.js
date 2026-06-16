// Shared barrier art for the editor's fence/wall placeables. Concatenated into BOTH
// the play bundle (draw.js drawBarriers + offscreen cache) and the create bundle
// (create.js preview/ghost/swatch) so the in-game render and the editor render are
// drawn by ONE implementation — no more keeping two verbatim copies in sync. Pure
// canvas drawing: every function takes a 2D context, a {x1,y1,x2,y2} segment, and an
// alpha; no globals beyond these helpers.

// Per-segment deterministic noise so the SAME barrier always splinters/cracks the
// same way (no frame-to-frame flicker). Seeded purely from the endpoints.
function barrierSeed(b) {
    var s = Math.floor(b.x1 * 73856093 ^ b.y1 * 19349663 ^ b.x2 * 83492791 ^ b.y2 * 2654435761) >>> 0;
    return s || 1;
}
function makeBarrierRng(seed) {
    var s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
var FENCE_PLANKS = ["#cf9047", "#bd7c39", "#dca35a", "#ad6e30"];
var FENCE_POST = "#46290f";
var FENCE_POST_LIP = "#6b4322";
var FENCE_RAIL = "#8a5e2e";
var FENCE_SEAM = "rgba(28,16,5,0.6)";
var FENCE_EDGE = "rgba(30,18,6,0.7)";
var FENCE_GRAIN = "rgba(70,44,16,0.35)";
// Top-down wooden fence: a CONTINUOUS rail (stringer) runs the full length and the
// boards sit on top of it end-to-end (lengthwise grain + butt-joint seams), with
// chunky square posts standing proud at intervals/ends and varied wear (mismatched
// shades, the odd splintered/short board). The rail shows through any board gap so
// the fence ALWAYS reads as solid — collision is continuous, so a gap must never
// look squeeze-through-able. Looks DOWN onto the fence, not at its face (no cross-
// ties, which read as railroad track). Brightened + dark-outlined to pop on dirt.
function drawBarrierFenceArt(ctx, b, alpha) {
    var dx = b.x2 - b.x1, dy = b.y2 - b.y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-3) { return; }
    var ang = Math.atan2(dy, dx);
    var rng = makeBarrierRng(barrierSeed(b));
    ctx.save();
    ctx.globalAlpha = (alpha == null ? 1 : alpha);
    ctx.translate(b.x1, b.y1);
    ctx.rotate(ang);
    var bandHalf = 7; // the rail is 14px wide seen from above
    // Continuous rail first (dark outline + wood core), full length, so it shows
    // through board gaps and the barrier never looks passable.
    ctx.lineCap = "round";
    ctx.strokeStyle = FENCE_EDGE;
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, 0); ctx.stroke();
    ctx.strokeStyle = FENCE_RAIL;
    ctx.lineWidth = 4.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, 0); ctx.stroke();
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    var x = 0;
    while (x < len - 0.5) {
        var plankLen = Math.min(len - x, 22 + rng() * 12);
        var shade = FENCE_PLANKS[(rng() * FENCE_PLANKS.length) | 0];
        var roll = rng();
        if (roll < 0.12 && plankLen < len - 1) { x += plankLen; continue; } // gap (rail shows through)
        var seam = 1.4;
        var drawLen = plankLen - seam;
        var broken = roll > 0.86;
        ctx.fillStyle = shade;
        if (broken) {
            var bl = drawLen * (0.45 + rng() * 0.3);
            ctx.beginPath();
            ctx.moveTo(x, -bandHalf);
            ctx.lineTo(x + bl, -bandHalf);
            ctx.lineTo(x + bl - 2, 0);
            ctx.lineTo(x + bl + 1, bandHalf);
            ctx.lineTo(x, bandHalf);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = FENCE_EDGE;
            ctx.lineWidth = 1.2;
            ctx.stroke();
            drawLen = bl;
        } else {
            ctx.fillRect(x, -bandHalf, drawLen, bandHalf * 2);
            // dark outline per board: separates the rail from terrain + defines planks
            ctx.strokeStyle = FENCE_EDGE;
            ctx.lineWidth = 1.2;
            ctx.strokeRect(x + 0.6, -bandHalf + 0.6, drawLen - 1.2, bandHalf * 2 - 1.2);
        }
        // lengthwise grain (runs ALONG the board, not across)
        ctx.strokeStyle = FENCE_GRAIN;
        ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(x + 1.5, -bandHalf + 2.5); ctx.lineTo(x + drawLen - 1.5, -bandHalf + 2.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + 1.5, bandHalf - 2.5); ctx.lineTo(x + drawLen - 1.5, bandHalf - 2.5); ctx.stroke();
        x += plankLen;
    }
    // posts: ends + every ~52px, square caps standing proud of the rail
    var np = Math.max(1, Math.round(len / 52));
    var pstep = len / np, postHalf = 9, postW = 10;
    for (var i = 0; i <= np; i++) {
        var px = i * pstep;
        ctx.fillStyle = FENCE_EDGE;
        ctx.fillRect(px - postW / 2 - 1, -postHalf - 1, postW + 2, postHalf * 2 + 2);
        ctx.fillStyle = FENCE_POST;
        ctx.fillRect(px - postW / 2, -postHalf, postW, postHalf * 2);
        ctx.fillStyle = FENCE_POST_LIP;
        ctx.fillRect(px - postW / 2 + 1.5, -postHalf + 1.5, postW - 3, postHalf * 2 - 3);
        ctx.fillStyle = "rgba(255,225,180,0.22)";
        ctx.fillRect(px - postW / 2 + 1.5, -postHalf + 1.5, postW - 3, 2);
    }
    ctx.restore();
}
var CONC_BODY = "#bcc0c6";
var CONC_DARK = "#8e939a";
var CONC_SEAM = "rgba(70,72,78,0.45)";
var CONC_CRACK = "rgba(45,47,52,0.62)";
var HAZARD_Y = "#e8b800";
var HAZARD_K = "#26262a";
function barrierConcSlabPath(ctx, x0, x1, half, r) {
    r = Math.min(r, (x1 - x0) / 2, half);
    ctx.beginPath();
    ctx.moveTo(x0 + r, -half);
    ctx.lineTo(x1 - r, -half);
    ctx.arc(x1 - r, -half + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x1, half - r);
    ctx.arc(x1 - r, half - r, r, 0, Math.PI / 2);
    ctx.lineTo(x0 + r, half);
    ctx.arc(x0 + r, half - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x0, -half + r);
    ctx.arc(x0 + r, -half + r, r, Math.PI, Math.PI * 1.5);
    ctx.closePath();
}
// Highway Jersey barrier: a concrete slab with the sloped-profile shading (dark
// base lips, hazard-striped crown), modular segment seams, and per-module wear —
// jagged cracks and chipped corners showing the cement underneath.
function drawBarrierConcreteArt(ctx, b, alpha) {
    var dx = b.x2 - b.x1, dy = b.y2 - b.y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-3) { return; }
    var ang = Math.atan2(dy, dx);
    var rng = makeBarrierRng(barrierSeed(b));
    var half = 9;
    ctx.save();
    ctx.globalAlpha = (alpha == null ? 1 : alpha);
    ctx.translate(b.x1, b.y1);
    ctx.rotate(ang);
    barrierConcSlabPath(ctx, 0, len, half, 4);
    ctx.fillStyle = CONC_BODY;
    ctx.fill();
    ctx.save();
    barrierConcSlabPath(ctx, 0, len, half, 4);
    ctx.clip();
    // sloped-profile lips (top + bottom edges sit in shadow)
    ctx.fillStyle = CONC_DARK;
    ctx.fillRect(0, -half, len, 2.5);
    ctx.fillRect(0, half - 3, len, 3);
    // hazard stripe band across the crown
    ctx.save();
    ctx.beginPath(); ctx.rect(0, -4.5, len, 9); ctx.clip();
    ctx.fillStyle = HAZARD_K; ctx.fillRect(0, -4.5, len, 9);
    ctx.fillStyle = HAZARD_Y;
    for (var x = -18; x < len + 18; x += 18) {
        ctx.beginPath();
        ctx.moveTo(x, -4.5);
        ctx.lineTo(x + 9, -4.5);
        ctx.lineTo(x + 9 + 9, 4.5);
        ctx.lineTo(x + 9, 4.5);
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
    // modular segment seams
    var seg = 54, segs = Math.max(1, Math.round(len / seg)), sstep = len / segs;
    ctx.strokeStyle = CONC_SEAM;
    ctx.lineWidth = 1.5;
    for (var s = 1; s < segs; s++) {
        var sx = s * sstep;
        ctx.beginPath(); ctx.moveTo(sx, -half); ctx.lineTo(sx, half); ctx.stroke();
    }
    // per-module wear
    for (var m = 0; m < segs; m++) {
        var cx0 = m * sstep;
        if (rng() < 0.5) { drawBarrierConcCrack(ctx, cx0 + sstep * (0.2 + rng() * 0.6), half, rng); }
        if (rng() < 0.32) { drawBarrierConcChip(ctx, cx0 + sstep * (0.25 + rng() * 0.5), half, rng); }
    }
    ctx.restore();
    // outline
    barrierConcSlabPath(ctx, 0, len, half, 4);
    ctx.strokeStyle = "rgba(60,62,68,0.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
}
function drawBarrierConcCrack(ctx, x0, half, rng) {
    ctx.strokeStyle = CONC_CRACK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var x = x0, y = -half + 1;
    ctx.moveTo(x, y);
    var steps = 3 + ((rng() * 3) | 0);
    for (var k = 0; k < steps; k++) {
        x += (rng() - 0.5) * 9;
        y += (half * 2 - 2) / steps;
        ctx.lineTo(x, y);
    }
    ctx.stroke();
}
function drawBarrierConcChip(ctx, x0, half, rng) {
    var top = rng() < 0.5;
    var yEdge = top ? -half : half;
    var dir = top ? 1 : -1;
    var w = 4 + rng() * 5;
    ctx.fillStyle = CONC_DARK;
    ctx.beginPath();
    ctx.moveTo(x0, yEdge);
    ctx.lineTo(x0 + w, yEdge);
    ctx.lineTo(x0 + w * 0.5, yEdge + dir * (3 + rng() * 4));
    ctx.closePath();
    ctx.fill();
}

// Shared MAGPIE-DRONE bird shape, drawn centered at the current origin facing +x. Used by the
// in-game drawer (draw.js, animated) AND the editor preview/swatch (create.js, static) so the
// two never drift — same idiom as the barrier art above. The caller passes the animation phase:
// `flap` (wing-beat, added to the base 0.5 spread), `tailSway` (radians added to each tail
// feather), `beakOpen` (R-fraction the beak gapes), and `shimmer(side)` -> the mid-gradient
// colour for each tail feather (side = -1 | +1).
function magpieWingShape(ctx, R, side, flap) {
    ctx.save();
    ctx.translate(0, -R * 0.1);
    ctx.rotate(side * (0.5 + (flap || 0)));
    var grd = ctx.createLinearGradient(0, 0, side * R * 1.7, R * 0.4);
    grd.addColorStop(0, "#23262f"); grd.addColorStop(1, "#0d0f15");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(side * R * 1.3, -R * 0.5, side * R * 1.75, R * 0.15);
    ctx.quadraticCurveTo(side * R * 1.2, R * 0.55, 0, R * 0.45);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#eef1f7"; // white primary tips
    ctx.beginPath();
    ctx.moveTo(side * R * 1.1, R * 0.05);
    ctx.quadraticCurveTo(side * R * 1.6, R * 0.1, side * R * 1.75, R * 0.15);
    ctx.quadraticCurveTo(side * R * 1.3, R * 0.45, side * R * 1.0, R * 0.4);
    ctx.closePath(); ctx.fill();
    ctx.restore();
}
function magpieBirdShape(ctx, R, flap, tailSway, beakOpen, shimmer) {
    for (var s = -1; s <= 1; s += 2) { // iridescent tail — two long feathers
        ctx.save();
        ctx.translate(0, R * 0.2);
        ctx.rotate(s * 0.18 + (tailSway || 0));
        var tl = R * 1.9, grd = ctx.createLinearGradient(0, 0, 0, tl);
        grd.addColorStop(0, "#1b2030");
        grd.addColorStop(0.5, shimmer(s));
        grd.addColorStop(1, "#0c1018");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(R * 0.5 * s, tl * 0.6, R * 0.18 * s, tl);
        ctx.quadraticCurveTo(-R * 0.18 * s, tl * 0.7, 0, 0);
        ctx.closePath(); ctx.fill();
        ctx.restore();
    }
    magpieWingShape(ctx, R, -1, flap); // far wing
    ctx.fillStyle = "#15171f"; // body
    ctx.beginPath(); ctx.ellipse(0, R * 0.1, R * 0.82, R * 1.0, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#eef1f7"; // white breast
    ctx.beginPath(); ctx.ellipse(0, R * 0.35, R * 0.5, R * 0.62, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#15171f"; // head
    ctx.beginPath(); ctx.arc(0, -R * 0.7, R * 0.62, 0, Math.PI * 2); ctx.fill();
    var open = (beakOpen || 0) * R; // orange beak (gapes while carrying)
    ctx.fillStyle = "#f0a23a";
    ctx.beginPath();
    ctx.moveTo(R * 0.55, -R * 0.78 - open);
    ctx.lineTo(R * 1.15, -R * 0.72);
    ctx.lineTo(R * 0.55, -R * 0.62 + open);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(R * 0.28, -R * 0.82, R * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#101218"; ctx.beginPath(); ctx.arc(R * 0.33, -R * 0.82, R * 0.09, 0, Math.PI * 2); ctx.fill();
    magpieWingShape(ctx, R, 1, flap); // near wing
}
