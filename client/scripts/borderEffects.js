// ============================================================================
// chaochao — BORDER cosmetic painters (extracted from draw.js so the borders-review
// prototype can load the LIVE renderers standalone, mirroring trailEffects.js).
// Contract: drawXxxBorder(ctx, anim, paint) in normalized space (radius==1 == rim,
// forward +X); draw AROUND the rim (~1.0..1.4), never the interior. Bundled AFTER draw.js
// (which defines TAU / cartPolyPath / cartSkinShade / cartSkinShadeA / cartSkinRGB) and
// BEFORE skinRegistry.js (which references these painters). BORDER_P holds the tunable
// defaults; the borders-review prototype mutates it live.
// ============================================================================
// Operator-tuned border defaults (baked from the prototype's P slider object).
var BORDER_P = {
    ringThickness: 0.16, studCount: 14, dashCount: 10, glowRadius: 0.35,
    spikeLen: 0.34, spikeCount: 14, gearTeeth: 14, spinSpeed: 2
};

function drawRingBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var t = BORDER_P.ringThickness, mid = 1.0 + t * 0.5;
    ctx.beginPath(); ctx.arc(0, 0, mid, 0, TAU);
    ctx.lineWidth = t; ctx.strokeStyle = paint; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, mid + t * 0.5, 0, TAU);
    ctx.lineWidth = t * 0.22; ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, mid - t * 0.42, 0, TAU);
    ctx.lineWidth = t * 0.2; ctx.strokeStyle = cartSkinShade(paint, 0.5); ctx.stroke();
}

function drawStudsBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var r = 1.06, n = Math.max(4, Math.round(BORDER_P.studCount));
    var band = cartSkinShade(paint, -0.2), body = cartSkinShade(paint, 0.1);
    var edge = cartSkinShade(paint, -0.5), hi = cartSkinShade(paint, 0.6);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
    ctx.lineWidth = 0.1; ctx.strokeStyle = band; ctx.stroke();
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var a = (i / n) * TAU, x = Math.cos(a) * r, y = Math.sin(a) * r;
        ctx.moveTo(x + 0.075, y); ctx.arc(x, y, 0.075, 0, TAU);
    }
    ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = 0.018; ctx.strokeStyle = edge; ctx.stroke();
    ctx.beginPath();
    for (var j = 0; j < n; j++) {
        var a2 = (j / n) * TAU, x2 = Math.cos(a2) * r - 0.022, y2 = Math.sin(a2) * r - 0.022;
        ctx.moveTo(x2 + 0.03, y2); ctx.arc(x2, y2, 0.03, 0, TAU);
    }
    ctx.fillStyle = hi; ctx.fill();
}

function drawDashedBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var r = 1.08, n = Math.max(3, Math.round(BORDER_P.dashCount));
    var spin = anim * 0.6 * BORDER_P.spinSpeed, arc = (TAU / n) * 0.55;
    var alt = cartSkinShade(paint, 0.35);
    ctx.lineWidth = 0.12; ctx.lineCap = "round";
    for (var pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (var i = pass; i < n; i += 2) {
            var a0 = spin + (i / n) * TAU;
            ctx.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
            ctx.arc(0, 0, r, a0, a0 + arc);
        }
        ctx.strokeStyle = pass === 0 ? paint : alt; ctx.stroke();
    }
    ctx.lineCap = "butt";
}

function drawGlowBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var pulse = 0.5 + 0.5 * Math.sin(anim * 1.6 * BORDER_P.spinSpeed);
    var outer = 1.0 + BORDER_P.glowRadius * (0.7 + pulse * 0.5);
    var g = ctx.createRadialGradient(0, 0, 0.85, 0, 0, outer);
    g.addColorStop(0, cartSkinShadeA(paint, 0, 0));
    g.addColorStop(0.55, cartSkinShadeA(paint, 0, 0.32 + pulse * 0.25));
    g.addColorStop(1, cartSkinShadeA(paint, 0, 0));
    ctx.beginPath(); ctx.arc(0, 0, outer, 0, TAU);
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 0.99, 0, TAU);
    ctx.lineWidth = 0.05; ctx.strokeStyle = cartSkinShadeA(paint, 0, 0.5 + pulse * 0.35); ctx.stroke();
}

function drawSpikesBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var n = Math.max(4, Math.round(BORDER_P.spikeCount));
    var base = 1.0, tip = 1.0 + BORDER_P.spikeLen, half = (Math.PI / n) * 0.6;
    var fill = cartSkinShade(paint, 0.2), edge = cartSkinShade(paint, -0.5);
    var shine = cartSkinShade(paint, 0.6), collar = cartSkinShade(paint, -0.2);
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var a = (i / n) * TAU;
        ctx.moveTo(Math.cos(a - half) * base, Math.sin(a - half) * base);
        ctx.lineTo(Math.cos(a) * tip, Math.sin(a) * tip);
        ctx.lineTo(Math.cos(a + half) * base, Math.sin(a + half) * base);
        ctx.closePath();
    }
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 0.02; ctx.strokeStyle = edge; ctx.stroke();
    ctx.beginPath();
    for (var j = 0; j < n; j++) {
        var a2 = (j / n) * TAU;
        ctx.moveTo(Math.cos(a2) * base, Math.sin(a2) * base);
        ctx.lineTo(Math.cos(a2) * (tip - 0.03), Math.sin(a2) * (tip - 0.03));
    }
    ctx.lineWidth = 0.02; ctx.strokeStyle = shine; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 1.0, 0, TAU);
    ctx.lineWidth = 0.05; ctx.strokeStyle = collar; ctx.stroke();
}

function drawGearBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var n = Math.max(6, Math.round(BORDER_P.gearTeeth));
    var spin = anim * 0.5 * BORDER_P.spinSpeed;
    var rIn = 1.02, rOut = 1.16, step = TAU / n;
    var body = cartSkinShade(paint, -0.05), edge = cartSkinShade(paint, -0.5), hub = cartSkinShade(paint, 0.4);
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var a0 = spin + i * step, aTooth = a0 + step * 0.5, aNext = a0 + step;
        ctx.lineTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn);
        ctx.lineTo(Math.cos(a0) * rOut, Math.sin(a0) * rOut);
        ctx.lineTo(Math.cos(aTooth) * rOut, Math.sin(aTooth) * rOut);
        ctx.lineTo(Math.cos(aTooth) * rIn, Math.sin(aTooth) * rIn);
        ctx.lineTo(Math.cos(aNext) * rIn, Math.sin(aNext) * rIn);
    }
    ctx.closePath();
    ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = 0.025; ctx.strokeStyle = edge; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 0.99, 0, TAU);
    ctx.lineWidth = 0.06; ctx.strokeStyle = hub; ctx.stroke();
}

function drawElectricBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var bright = cartSkinShade(paint, 0.65), glow = cartSkinShadeA(paint, 0, 0.35), ring = cartSkinShadeA(paint, 0, 0.4);
    var arcs = 5, segs = 6;
    ctx.beginPath(); ctx.arc(0, 0, 1.04, 0, TAU);
    ctx.lineWidth = 0.03; ctx.strokeStyle = ring; ctx.stroke();
    ctx.lineCap = "round";
    ctx.beginPath();
    for (var k = 0; k < arcs; k++) {
        var phase = anim * (2.2 + k * 0.5) * BORDER_P.spinSpeed + k * 2.399;
        var center = phase % TAU, span = 0.5 + 0.3 * Math.sin(phase * 1.7);
        for (var s = 0; s <= segs; s++) {
            var f = s / segs, a = center - span / 2 + span * f;
            var jitter = Math.sin(phase * 9 + s * 4.3) * 0.07 * (s % 2 ? 1 : -1);
            var rr = 1.06 + jitter + 0.04 * Math.sin(f * Math.PI);
            var x = Math.cos(a) * rr, y = Math.sin(a) * rr;
            if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
    }
    ctx.lineWidth = 0.09; ctx.strokeStyle = glow; ctx.stroke();
    ctx.lineWidth = 0.03; ctx.strokeStyle = bright; ctx.stroke();
    ctx.beginPath();
    for (var m = 0; m < arcs; m++) {
        var ph = anim * (2.2 + m * 0.5) * BORDER_P.spinSpeed + m * 2.399;
        var ta = (ph % TAU) + (0.5 + 0.3 * Math.sin(ph * 1.7)) / 2;
        var sx = Math.cos(ta) * 1.06, sy = Math.sin(ta) * 1.06;
        ctx.moveTo(sx + 0.035, sy); ctx.arc(sx, sy, 0.035, 0, TAU);
    }
    ctx.fillStyle = bright; ctx.fill();
    ctx.lineCap = "butt";
}

function drawLaurelBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var leafDark = cartSkinShade(paint, -0.1), leafLite = cartSkinShade(paint, 0.45), edge = cartSkinShade(paint, -0.45);
    var leaves = 8, side, i, f, a, bx, by, size, lean, cx, cy;
    ctx.beginPath();
    for (side = -1; side <= 1; side += 2) {
        var aEnd = Math.PI * (side < 0 ? 0.02 : 0.98);
        for (i = 0; i < leaves; i++) {
            f = i / (leaves - 1);
            a = Math.PI * 0.5 + (aEnd - Math.PI * 0.5) * f;
            bx = Math.cos(a) * 1.05; by = Math.sin(a) * 1.05;
            size = 0.26 * (1 - f * 0.55); lean = a + side * 0.9;
            cx = bx + Math.cos(lean) * size * 0.7; cy = by + Math.sin(lean) * size * 0.7;
            ctx.moveTo(cx + Math.cos(lean) * size, cy + Math.sin(lean) * size);
            ctx.ellipse(cx, cy, size, size * 0.42, lean, 0, TAU);
        }
    }
    ctx.fillStyle = leafDark; ctx.fill();
    ctx.lineWidth = 0.012; ctx.strokeStyle = edge; ctx.stroke();
    ctx.beginPath();
    for (side = -1; side <= 1; side += 2) {
        var aEnd2 = Math.PI * (side < 0 ? 0.02 : 0.98);
        for (i = 0; i < leaves; i++) {
            f = i / (leaves - 1);
            a = Math.PI * 0.5 + (aEnd2 - Math.PI * 0.5) * f;
            bx = Math.cos(a) * 1.05; by = Math.sin(a) * 1.05;
            size = 0.26 * (1 - f * 0.55); lean = a + side * 0.9;
            cx = bx + Math.cos(lean) * size * 0.85; cy = by + Math.sin(lean) * size * 0.85;
            ctx.moveTo(cx + Math.cos(lean) * size * 0.5, cy + Math.sin(lean) * size * 0.5);
            ctx.ellipse(cx, cy, size * 0.5, size * 0.22, lean, 0, TAU);
        }
    }
    ctx.fillStyle = leafLite; ctx.fill();
    ctx.beginPath();
    for (side = -1; side <= 1; side += 2) {
        var s1 = Math.PI * (side < 0 ? 0.02 : 0.98);
        for (var j = 0; j <= 16; j++) {
            var aa = Math.PI * 0.5 + (s1 - Math.PI * 0.5) * (j / 16);
            var vx = Math.cos(aa) * 1.04, vy = Math.sin(aa) * 1.04;
            if (j === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
    }
    ctx.lineWidth = 0.035; ctx.strokeStyle = leafDark; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 1.05, 0.1, 0, TAU);
    ctx.fillStyle = leafLite; ctx.fill();
    ctx.lineWidth = 0.02; ctx.strokeStyle = edge; ctx.stroke();
}

function drawChevronsBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var n = 12, r = 1.12, drift = anim * 0.5 * BORDER_P.spinSpeed;
    var alt = cartSkinShade(paint, 0.4), w = 0.16, depth = 0.1;
    ctx.lineWidth = 0.07; ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (var pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (var i = pass; i < n; i += 2) {
            var a = drift + (i / n) * TAU, tan = a + Math.PI / 2;
            var cx = Math.cos(a) * r, cy = Math.sin(a) * r;
            var nx = Math.cos(a), ny = Math.sin(a), tx = Math.cos(tan), ty = Math.sin(tan);
            ctx.moveTo(cx - tx * w - nx * depth, cy - ty * w - ny * depth);
            ctx.lineTo(cx + tx * w, cy + ty * w);
            ctx.lineTo(cx - tx * w + nx * depth, cy - ty * w + ny * depth);
        }
        ctx.strokeStyle = pass === 0 ? paint : alt; ctx.stroke();
    }
    ctx.lineCap = "butt"; ctx.lineJoin = "miter";
}

function drawDoubleBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    ctx.beginPath(); ctx.arc(0, 0, 1.04, 0, TAU);
    ctx.lineWidth = 0.06; ctx.strokeStyle = paint; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 1.17, 0, TAU);
    ctx.lineWidth = 0.04; ctx.strokeStyle = cartSkinShade(paint, 0.4); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 1.105, 0, TAU);
    ctx.lineWidth = 0.012; ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.stroke();
}

function drawTicksBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var n = 32;
    ctx.beginPath(); ctx.arc(0, 0, 1.02, 0, TAU);
    ctx.lineWidth = 0.03; ctx.strokeStyle = cartSkinShade(paint, -0.2); ctx.stroke();
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        if (i % 4 === 0) continue;
        var a = (i / n) * TAU;
        ctx.moveTo(Math.cos(a) * 1.03, Math.sin(a) * 1.03);
        ctx.lineTo(Math.cos(a) * 1.11, Math.sin(a) * 1.11);
    }
    ctx.lineWidth = 0.022; ctx.strokeStyle = paint; ctx.stroke();
    ctx.beginPath();
    for (var j = 0; j < n; j += 4) {
        var a2 = (j / n) * TAU;
        ctx.moveTo(Math.cos(a2) * 1.03, Math.sin(a2) * 1.03);
        ctx.lineTo(Math.cos(a2) * 1.19, Math.sin(a2) * 1.19);
    }
    ctx.lineWidth = 0.04; ctx.strokeStyle = cartSkinShade(paint, 0.4); ctx.stroke();
}

function drawScalesBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var n = 16, r = 1.02, sc = 0.16;
    var body = cartSkinShade(paint, 0.05), edge = cartSkinShade(paint, -0.5), hi = cartSkinShade(paint, 0.45);
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var a = (i / n) * TAU, x = Math.cos(a) * r, y = Math.sin(a) * r, sa = a - Math.PI / 2;
        ctx.moveTo(x + Math.cos(sa) * sc, y + Math.sin(sa) * sc);
        ctx.arc(x, y, sc, sa, a + Math.PI / 2);
        ctx.closePath();
    }
    ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = 0.015; ctx.strokeStyle = edge; ctx.stroke();
    ctx.beginPath();
    for (var j = 0; j < n; j++) {
        var a2 = (j / n) * TAU, x2 = Math.cos(a2) * (r + 0.03), y2 = Math.sin(a2) * (r + 0.03);
        var sa2 = a2 - Math.PI / 2, sc2 = sc * 0.6;
        ctx.moveTo(x2 + Math.cos(sa2) * sc2, y2 + Math.sin(sa2) * sc2);
        ctx.arc(x2, y2, sc2, sa2, a2 + Math.PI / 2);
        ctx.closePath();
    }
    ctx.fillStyle = hi; ctx.fill();
}

function drawSawbladeBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var n = 18, spin = anim * 1.1 * BORDER_P.spinSpeed, step = TAU / n, rIn = 1.0, rOut = 1.18;
    var body = cartSkinShade(paint, 0.1), edge = cartSkinShade(paint, -0.5), hub = cartSkinShade(paint, 0.45);
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var a0 = spin + i * step;
        ctx.lineTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn);
        ctx.lineTo(Math.cos(a0) * rOut, Math.sin(a0) * rOut);
        var aMid = a0 + step * 0.5;
        ctx.lineTo(Math.cos(aMid) * rIn, Math.sin(aMid) * rIn);
    }
    ctx.closePath();
    ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = 0.02; ctx.strokeStyle = edge; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 0.98, 0, TAU);
    ctx.lineWidth = 0.05; ctx.strokeStyle = hub; ctx.stroke();
}

function drawFlamesBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var n = 14, w = 0.11, tipCol = cartSkinShade(paint, 0.6);
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var a = (i / n) * TAU;
        var flick = 0.22 + 0.16 * (0.5 + 0.5 * Math.sin(anim * 3 * BORDER_P.spinSpeed + i * 1.7));
        var bx = Math.cos(a), by = Math.sin(a), tan = a + Math.PI / 2, tx = Math.cos(tan), ty = Math.sin(tan);
        var lean = 0.12 * Math.sin(anim * 2 + i);
        var tipX = bx * (1.0 + flick) + tx * lean, tipY = by * (1.0 + flick) + ty * lean;
        var ctlX = bx + tx * lean, ctlY = by + ty * lean;
        ctx.moveTo(bx - tx * w, by - ty * w);
        ctx.quadraticCurveTo(ctlX, ctlY, tipX, tipY);
        ctx.quadraticCurveTo(ctlX, ctlY, bx + tx * w, by + ty * w);
        ctx.closePath();
    }
    ctx.fillStyle = paint; ctx.fill();
    ctx.beginPath();
    for (var j = 0; j < n; j++) {
        var a2 = (j / n) * TAU;
        var flick2 = 0.22 + 0.16 * (0.5 + 0.5 * Math.sin(anim * 3 * BORDER_P.spinSpeed + j * 1.7));
        var bx2 = Math.cos(a2), by2 = Math.sin(a2), tan2 = a2 + Math.PI / 2, tx2 = Math.cos(tan2), ty2 = Math.sin(tan2);
        var lean2 = 0.12 * Math.sin(anim * 2 + j);
        var tipX2 = bx2 * (1.0 + flick2) + tx2 * lean2, tipY2 = by2 * (1.0 + flick2) + ty2 * lean2;
        var mx = (bx2 + tipX2) / 2, my = (by2 + tipY2) / 2, w2 = 0.05;
        ctx.moveTo(mx - tx2 * w2, my - ty2 * w2);
        ctx.quadraticCurveTo(mx, my, tipX2, tipY2);
        ctx.quadraticCurveTo(mx, my, mx + tx2 * w2, my + ty2 * w2);
        ctx.closePath();
    }
    ctx.fillStyle = tipCol; ctx.fill();
}

var RUNE_GLYPHS = [
    [[-0.1, -0.1], [0, 0.1], [0.1, -0.1], null, [-0.06, 0], [0.06, 0]],
    [[0, -0.1], [0, 0.1], null, [-0.1, -0.03], [0.1, -0.03], null, [-0.06, 0.1], [0.06, 0.1]],
    [[-0.1, 0.1], [0, -0.1], [0.1, 0.1], null, [-0.1, -0.1], [0.1, 0.1]]
];
function drawRunesBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var pulse = 0.5 + 0.5 * Math.sin(anim * 1.5 * BORDER_P.spinSpeed), bright = cartSkinShade(paint, 0.6);
    ctx.beginPath(); ctx.arc(0, 0, 1.08, 0, TAU);
    ctx.lineWidth = 0.02; ctx.strokeStyle = cartSkinShadeA(paint, 0, 0.35); ctx.stroke();
    var n = 8, r = 1.08;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var a = (i / n) * TAU, rot = a + Math.PI / 2, cr = Math.cos(rot), sr = Math.sin(rot);
        var cx = Math.cos(a) * r, cy = Math.sin(a) * r, segs = RUNE_GLYPHS[i % 3], pen = false;
        for (var p = 0; p < segs.length; p++) {
            var seg = segs[p];
            if (seg === null) { pen = false; continue; }
            var wx = cx + seg[0] * cr - seg[1] * sr, wy = cy + seg[0] * sr + seg[1] * cr;
            if (!pen) { ctx.moveTo(wx, wy); pen = true; } else ctx.lineTo(wx, wy);
        }
    }
    ctx.lineWidth = 0.035; ctx.strokeStyle = bright;
    ctx.globalAlpha = 0.55 + pulse * 0.45; ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineCap = "butt"; ctx.lineJoin = "miter";
}

function drawOrbitBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var track = 1.22, sats = 3, base = anim * 1.2 * BORDER_P.spinSpeed;
    ctx.beginPath(); ctx.arc(0, 0, track, 0, TAU);
    ctx.lineWidth = 0.015; ctx.strokeStyle = cartSkinShadeA(paint, 0, 0.3); ctx.stroke();
    ctx.beginPath();
    for (var i = 0; i < sats; i++) {
        var a = base + (i / sats) * TAU;
        ctx.moveTo(Math.cos(a) * track, Math.sin(a) * track);
        ctx.arc(0, 0, track, a, a - 0.6, true);
    }
    ctx.lineWidth = 0.06; ctx.lineCap = "round"; ctx.strokeStyle = cartSkinShadeA(paint, 0, 0.35); ctx.stroke();
    ctx.lineCap = "butt";
    ctx.beginPath();
    for (var j = 0; j < sats; j++) {
        var a2 = base + (j / sats) * TAU, x = Math.cos(a2) * track, y = Math.sin(a2) * track;
        ctx.moveTo(x + 0.075, y); ctx.arc(x, y, 0.075, 0, TAU);
    }
    ctx.fillStyle = cartSkinShade(paint, 0.55); ctx.fill();
}

function drawCrownBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var n = 10, rIn = 1.02, rTip = 1.26, step = TAU / n;
    var body = cartSkinShade(paint, 0.2), edge = cartSkinShade(paint, -0.5), jewel = cartSkinShade(paint, 0.75);
    ctx.beginPath(); ctx.arc(0, 0, rIn, 0, TAU);
    ctx.lineWidth = 0.08; ctx.strokeStyle = paint; ctx.stroke();
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var a = (i / n) * TAU, aL = a - step * 0.5, aR = a + step * 0.5;
        ctx.moveTo(Math.cos(aL) * rIn, Math.sin(aL) * rIn);
        ctx.lineTo(Math.cos(a) * rTip, Math.sin(a) * rTip);
        ctx.lineTo(Math.cos(aR) * rIn, Math.sin(aR) * rIn);
        ctx.closePath();
    }
    ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = 0.015; ctx.strokeStyle = edge; ctx.stroke();
    ctx.beginPath();
    for (var j = 0; j < n; j++) {
        var a2 = (j / n) * TAU, jx = Math.cos(a2) * (rTip - 0.02), jy = Math.sin(a2) * (rTip - 0.02);
        ctx.moveTo(jx + 0.045, jy); ctx.arc(jx, jy, 0.045, 0, TAU);
    }
    ctx.fillStyle = jewel; ctx.fill();
}

function drawPlasmaBorder(ctx, anim, paint) {
    paint = paint || "#cf3030";
    var lobes = 7, steps = 56;
    function edge(rBase, amp, phase) {
        ctx.beginPath();
        for (var s = 0; s <= steps; s++) {
            var a = (s / steps) * TAU, r = rBase + amp * Math.sin(a * lobes + phase);
            var x = Math.cos(a) * r, y = Math.sin(a) * r;
            if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
    }
    var rGlow = 1.0 + 0.12 + 0.05 * Math.sin(anim * 1.3 * BORDER_P.spinSpeed);
    var g = ctx.createRadialGradient(0, 0, 0.9, 0, 0, rGlow + 0.18);
    g.addColorStop(0, cartSkinShadeA(paint, 0, 0));
    g.addColorStop(0.6, cartSkinShadeA(paint, 0, 0.3));
    g.addColorStop(1, cartSkinShadeA(paint, 0, 0));
    edge(rGlow, 0.1, anim * 1.6 * BORDER_P.spinSpeed);
    ctx.fillStyle = g; ctx.fill();
    edge(1.06, 0.07, anim * 2.0 * BORDER_P.spinSpeed);
    ctx.lineWidth = 0.04; ctx.strokeStyle = cartSkinShade(paint, 0.55); ctx.stroke();
    edge(1.02, 0.05, -anim * 1.4 * BORDER_P.spinSpeed);
    ctx.lineWidth = 0.025; ctx.strokeStyle = cartSkinShadeA(paint, 0, 0.6); ctx.stroke();
}
