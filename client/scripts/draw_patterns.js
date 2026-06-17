// draw_patterns.js — pattern painters + sprite/texture loaders, extracted
// verbatim from draw.js (phase 2 of docs/spikes/client-refactor.md). Pure
// file split: no logic, naming, or order changes.
// IMPORTANT: loaded AFTER draw.js in the play bundle — `requiredImages`
// (below) reads the icon/terrain Image() globals declared at the top of
// draw.js at eval time, so this file must evaluate once draw.js has run.
// Contents: drawXxxPattern overlays, getPlayerSprite, the fire Image globals,
// requiredImages/tileImagesReady loading infra, loadPatterns/loadSpriteSheets/
// buildWaterTexture/makePattern* texture builders.

// Pattern painters — APPROVED, ported from docs/asset-prototypes/patterns.approved.js
// (2026-05-30). drawXxxPattern(ctx, anim, paint) texture overlays, tinted to paint,
// composited by drawPatternOverlay on the default sphere cart. Ppat() = inlined slider
// default shim. cartSkinShade/A + cartSkinRGB already exist in draw.js.
function Ppat(_key, def) { return def; }
function srnd(seed) {
  var s = (seed >>> 0) || 1;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ============================================================================
// LADDER + ACHIEVEMENT PATTERNS (the original 7)
// ============================================================================

// --- 1. Racing Stripes (Lv2) ------------------------------------------------
function drawStripesPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var w = 0.10 + 0.20 * Ppat("st_w", 0.4);      // stripe width
  var gap = 0.04 + 0.30 * Ppat("st_gap", 0.34); // gap between the two inner edges
  var dark = cartComp(paint, -0.10);   // racing stripe in the COMPLEMENTARY hue (contrast)
  var line = cartSkinShade(paint, 0.45);     // bright pinstripe edge

  for (var s = -1; s <= 1; s += 2) {
    var y0 = s > 0 ? gap / 2 : -gap / 2 - w;
    ctx.fillStyle = line;
    ctx.fillRect(-0.9, y0 - 0.022, 1.8, w + 0.044);
    ctx.fillStyle = dark;
    ctx.fillRect(-0.9, y0, 1.8, w);
  }
  var sh = (anim * 0.5) % 2 - 1;
  var g = ctx.createLinearGradient(sh - 0.5, 0, sh + 0.5, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,0.10)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-0.9, -gap / 2 - w, 1.8, gap + 2 * w);
}

// --- 2. Polka (Lv8) ---------------------------------------------------------
function drawPolkaPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var r = 0.045 + 0.07 * Ppat("pk_size", 0.42);
  var sp = 0.18 + 0.18 * Ppat("pk_gap", 0.46);
  var dot = cartComp(paint, 0.05);
  var hi = cartComp(paint, 0.5);
  var rim = cartSkinShadeA(paint, -0.25, 0.5);  // darker rim so dots read on light bases
  // Every dot (fill + rim + highlight) is identical bar position and a global breathe scale,
  // so render the UNIT dot once and blit it per cell instead of re-stamping ~50 arc+stroke+arc
  // paths every frame. span 1.2 leaves room for the rim stroke that extends past radius 1.
  var span = 1.2;
  var spr = getCachedGlyphSprite("polka|" + paint, span, function (c) {
    c.lineWidth = 0.18;
    c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2);
    c.fillStyle = dot; c.fill();
    c.strokeStyle = rim; c.stroke();
    c.beginPath(); c.arc(-0.32, -0.32, 0.38, 0, Math.PI * 2);
    c.fillStyle = hi; c.fill();
  });
  var drift = (anim * 0.06) % sp;
  var breathe = 1 + 0.06 * Math.sin(anim * 2.2);
  var R = r * breathe * span;   // blit half-extent: dot radius (×breathe) scaled out to the sprite box
  var d = 2 * R;
  var row = 0;
  for (var dy = -1.05; dy <= 1.05; dy += sp) {
    var off = (row % 2) ? sp / 2 : 0;
    for (var dx = -1.05; dx <= 1.05; dx += sp) {
      var x = dx + off + drift;
      ctx.drawImage(spr, x - R, dy - R, d, d);
    }
    row++;
  }
}

// --- 3. Checkered (Lv14) ----------------------------------------------------
function drawCheckeredPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var n = Math.round(5 + 7 * Ppat("ck_n", 0.42));   // squares across
  var dark = cartComp(paint, -0.10);
  var cell = 1.9 / n;                              // square cells tiled across the full disc
  for (var ix = 0; -1 + ix * cell < 1; ix++) {
    for (var iy = 0; -1 + iy * cell < 1; iy++) {
      if ((ix + iy) % 2) {
        ctx.fillStyle = dark;
        ctx.fillRect(-1 + ix * cell, -1 + iy * cell, cell + 0.01, cell + 0.01);
      }
    }
  }
  var sh = (anim * 0.6) % 2.2 - 1.1;
  var g = ctx.createLinearGradient(sh - 0.4, -0.6, sh + 0.4, 0.6);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2);
}

// --- 4. Flames (Lv20) — opaque ----------------------------------------------
function flameTongue(ctx, rx, ry, len, wid) {
  ctx.beginPath();
  ctx.moveTo(rx, ry - wid / 2);
  ctx.quadraticCurveTo(rx + len * 0.5, ry - wid * 0.55, rx + len, ry);
  ctx.quadraticCurveTo(rx + len * 0.5, ry + wid * 0.55, rx, ry + wid / 2);
  ctx.closePath();
  ctx.fill();
}
function drawFlamesPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var inten = Ppat("fl_int", 0.6);
  var ramp = Ppat("fl_ramp", 0.62);
  // player-colour base, darkest in the centre so the mirrored flames read on both edges
  var ug = ctx.createLinearGradient(-0.85, 0, 0.85, 0);
  ug.addColorStop(0, cartSkinShade(paint, -0.06));
  ug.addColorStop(0.5, cartSkinShade(paint, -0.34));
  ug.addColorStop(1, cartSkinShade(paint, -0.06));
  ctx.fillStyle = ug; ctx.fillRect(-1, -1, 2, 2);

  var roots = [-0.46, -0.28, -0.10, 0.08, 0.26, 0.46];
  var baseLen = 0.7 + 0.55 * inten;
  var layers = [
    { lenK: 1.00, widK: 0.34, shade: -0.10 },
    { lenK: 0.74, widK: 0.24, shade: 0.28 + 0.3 * ramp },
    { lenK: 0.46, widK: 0.15, shade: 0.55 + 0.4 * ramp },
  ];
  // flames lick inward from BOTH side edges (left set mirrored to the right)
  for (var side = -1; side <= 1; side += 2) {
    ctx.save();
    if (side > 0) ctx.scale(-1, 1);
    for (var L = 0; L < layers.length; L++) {
      ctx.fillStyle = cartComp(paint, layers[L].shade);   // COMPLEMENTARY flames
      for (var i = 0; i < roots.length; i++) {
        var flick = 0.8 + 0.2 * Math.sin(anim * 6 + i * 1.7 + side) + 0.1 * Math.sin(anim * 11 + i);
        var len = baseLen * layers[L].lenK * flick;
        flameTongue(ctx, -0.9, roots[i], len, 0.30 * layers[L].widK / 0.34 + 0.04);
      }
    }
    ctx.fillStyle = cartComp(paint, 0.7 + 0.25 * ramp);
    for (var c = 0; c < roots.length; c++) {
      var fl2 = 0.8 + 0.2 * Math.sin(anim * 8 + c + side);
      ctx.beginPath();
      ctx.ellipse(-0.86, roots[c], 0.05 * fl2, 0.045, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

// --- 5. Nebula (Lv26) — opaque ----------------------------------------------
var _nebStars = null;
function nebStars(n) {
  if (_nebStars && _nebStars.length >= n) return _nebStars;
  var out = [];
  for (var i = 0; i < n; i++) {
    var a = i * 2.39996323, r = Math.sqrt((i + 0.5) / n);
    out.push({
      x: Math.cos(a) * r * 0.92,
      y: Math.sin(a) * r * 0.62,
      base: 0.35 + 0.4 * ((i * 7) % 5) / 5,
      ph: (i * 1.7) % (Math.PI * 2),
      big: (i % 6 === 0),
    });
  }
  _nebStars = out; return out;
}
function sparkle(ctx, x, y, r, alpha) {
  ctx.fillStyle = "rgba(255,255,255," + alpha + ")";
  ctx.beginPath();
  for (var q = 0; q < 8; q++) {
    var rr = (q % 2) ? r * 0.32 : r, aa = q * Math.PI / 4;
    var X = x + Math.cos(aa) * rr, Y = y + Math.sin(aa) * rr;
    if (q === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  }
  ctx.closePath(); ctx.fill();
}
function drawNebulaPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var drift = Ppat("nb_drift", 0.5);
  var density = Ppat("nb_stars", 0.55);
  var g = ctx.createRadialGradient(-0.1, -0.05, 0.05, 0, 0, 1.0);
  g.addColorStop(0, cartSkinShade(paint, 0.35));
  g.addColorStop(0.55, cartSkinShade(paint, -0.15));
  g.addColorStop(1, cartComp(paint, -0.45));
  ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2);

  var wisps = [
    { x: -0.4, y: -0.25, r: 0.55, sh: 0.5, sp: 0.13 },
    { x: 0.45, y: 0.18, r: 0.6, sh: 0.3, sp: -0.09 },
    { x: 0.05, y: 0.35, r: 0.4, sh: 0.6, sp: 0.16 },
  ];
  for (var w = 0; w < wisps.length; w++) {
    var ws = wisps[w];
    var wx = ws.x + Math.sin(anim * ws.sp * (0.5 + drift) + w) * 0.12;
    var wy = ws.y + Math.cos(anim * ws.sp * (0.5 + drift) + w) * 0.08;
    var wg = ctx.createRadialGradient(wx, wy, 0.02, wx, wy, ws.r);
    wg.addColorStop(0, cartCompA(paint, ws.sh, 0.5));
    wg.addColorStop(1, cartCompA(paint, ws.sh, 0));
    ctx.fillStyle = wg; ctx.fillRect(-1, -1, 2, 2);
  }

  var n = Math.round(10 + 40 * density);
  var stars = nebStars(n);
  for (var i = 0; i < n; i++) {
    var s = stars[i];
    var tw = 0.5 + 0.5 * Math.sin(anim * 3 + s.ph);
    var alpha = s.base * (0.45 + 0.55 * tw);
    if (s.big && tw > 0.6) {
      sparkle(ctx, s.x, s.y, 0.035 + 0.03 * tw, alpha);
    } else {
      ctx.fillStyle = "rgba(255,255,255," + alpha + ")";
      ctx.beginPath(); ctx.arc(s.x, s.y, 0.014 + 0.01 * tw, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// --- 6. Executioner (achievement) -------------------------------------------
function bonePath(ctx, x0, y0, x1, y1, w) {
  var ang = Math.atan2(y1 - y0, x1 - x0);
  ctx.save(); ctx.translate(x0, y0); ctx.rotate(ang);
  var len = Math.hypot(x1 - x0, y1 - y0);
  ctx.beginPath();
  ctx.arc(0, -w * 0.6, w * 0.6, 0, Math.PI * 2);
  ctx.arc(0, w * 0.6, w * 0.6, 0, Math.PI * 2);
  ctx.arc(len, -w * 0.6, w * 0.6, 0, Math.PI * 2);
  ctx.arc(len, w * 0.6, w * 0.6, 0, Math.PI * 2);
  ctx.rect(0, -w * 0.5, len, w);
  ctx.fill();
  ctx.restore();
}
function drawExecutionerPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var menace = Ppat("ex_menace", 0.55);
  var g = ctx.createRadialGradient(0, 0, 0.15, 0, 0, 1.05);
  g.addColorStop(0, cartSkinShade(paint, -0.2 - 0.2 * menace));
  g.addColorStop(1, cartSkinShade(paint, -0.62));
  ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2);

  var bone = cartComp(paint, 0.55);
  var boneSh = cartComp(paint, -0.2);
  var pulse = 1 + 0.03 * Math.sin(anim * 2.5);

  ctx.save();
  ctx.rotate(-Math.PI / 2);
  ctx.scale(pulse, pulse);

  ctx.fillStyle = bone;
  bonePath(ctx, -0.5, 0.46, 0.5, 0.18, 0.10);
  bonePath(ctx, -0.5, 0.18, 0.5, 0.46, 0.10);

  ctx.fillStyle = bone;
  ctx.beginPath(); ctx.arc(0, -0.18, 0.34, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-0.30, -0.04); ctx.lineTo(-0.22, 0.26); ctx.lineTo(0.22, 0.26);
  ctx.lineTo(0.30, -0.04); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, 0.22, 0.18, 0.12, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = boneSh;
  for (var e = -1; e <= 1; e += 2) {
    ctx.save(); ctx.translate(e * 0.14, -0.2); ctx.rotate(e * -0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 0.13, 0.10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = cartSkinShade(paint, 0.1 + 0.3 * menace);
  for (var p = -1; p <= 1; p += 2) {
    ctx.beginPath(); ctx.arc(p * 0.14, -0.18, 0.035 + 0.015 * menace, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = boneSh;
  ctx.beginPath(); ctx.moveTo(0, -0.06); ctx.lineTo(-0.05, 0.06); ctx.lineTo(0.05, 0.06); ctx.closePath(); ctx.fill();
  ctx.fillStyle = boneSh; ctx.lineWidth = 0;
  for (var t = -2; t <= 2; t++) {
    ctx.fillRect(t * 0.07 - 0.012, 0.14, 0.024, 0.12);
  }
  ctx.restore();
}

// --- 7. Punching Bag (achievement) ------------------------------------------
function drawPunchingBagPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var bruise = Ppat("pb_bruise", 0.55);
  var wobble = Math.sin(anim * 3) * 0.02;

  ctx.save();
  ctx.translate(wobble, Math.cos(anim * 2.4) * 0.015);

  var cxr = 0.06, cyr = -0.02;
  var rings = [0.5, 0.4, 0.3, 0.2, 0.1];
  for (var i = 0; i < rings.length; i++) {
    ctx.beginPath(); ctx.arc(cxr, cyr, rings[i], 0, Math.PI * 2);
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.55) : cartComp(paint, -0.15);
    ctx.fill();
  }
  ctx.beginPath(); ctx.arc(cxr, cyr, 0.05, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.7); ctx.fill();

  var bruises = [[-0.55, 0.34], [0.5, 0.4], [-0.4, -0.42]];
  for (var b = 0; b < bruises.length; b++) {
    var bx = bruises[b][0], by = bruises[b][1];
    var bg = ctx.createRadialGradient(bx, by, 0.02, bx, by, 0.22);
    bg.addColorStop(0, cartSkinShadeA(paint, -0.55, 0.55 + 0.3 * bruise));
    bg.addColorStop(1, cartSkinShadeA(paint, -0.55, 0));
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.ellipse(bx, by, 0.22, 0.17, b, 0, Math.PI * 2); ctx.fill();
  }

  ctx.save();
  ctx.translate(-0.5, -0.3); ctx.rotate(0.5);
  ctx.fillStyle = cartSkinShade(paint, 0.6);
  ctx.fillRect(-0.04, -0.16, 0.08, 0.32);
  ctx.fillRect(-0.16, -0.04, 0.32, 0.08);
  ctx.fillStyle = cartSkinShade(paint, 0.35);
  for (var h = -1; h <= 1; h++) { ctx.fillRect(-0.025, h * 0.05 - 0.0, 0.05, 0.012); }
  ctx.restore();

  var pops = [[0.42, -0.34], [-0.18, 0.46]];
  for (var pI = 0; pI < pops.length; pI++) {
    var t = (anim * 1.3 + pI * 1.5) % 2;
    var amp = Math.max(0, Math.sin(t * Math.PI));
    if (amp < 0.05) continue;
    ctx.fillStyle = cartSkinShadeA(paint, 0.85, amp);
    var px = pops[pI][0], py = pops[pI][1], R = 0.07 + 0.05 * amp;
    ctx.beginPath();
    for (var q = 0; q < 10; q++) {
      var rr = (q % 2) ? R * 0.4 : R, aa = q * Math.PI / 5 - 0.3;
      var X = px + Math.cos(aa) * rr, Y = py + Math.sin(aa) * rr;
      if (q === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// ============================================================================
// EXTRA PATTERNS (10 more) — all opaque/full-repaint (see PATTERN_DEFS)
// ============================================================================

// --- 8. Carbon Fiber --------------------------------------------------------
function drawCarbonPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var cs = 0.085 + 0.075 * (1 - Ppat("cf_scale", 0.5));
  // The tiled carbon weave is identical every frame for a given (colour, scale): it was
  // creating ~hundreds of tile gradients per frame (this pattern measured ~10x the slot
  // median). Build the weave once into an offscreen layer and blit it.
  // drawPatternOverlay applies the registry opacity via ctx.globalAlpha. Bake that SAME
  // alpha into the cache's inter-layer compositing (set it on the cache ctx) and blit the
  // flattened layer at FULL alpha: compositing opaque layers at `op` into a transparent
  // cache then drawing the result at alpha 1 over the body is identical to drawing each
  // layer at `op` directly over the body, so translucent patterns look exactly as before.
  var op = ctx.globalAlpha;
  var cv = getCachedSkinLayer("carbon|" + paint + "|" + cs.toFixed(3) + "|" + op, function (c) {
    if (op !== 1) { c.globalAlpha = op; }
    var lite = cartSkinShade(paint, -0.16), dark = cartComp(paint, -0.4);
    for (var iy = 0; iy * cs < 2.0; iy++) {
      for (var ix = 0; ix * cs < 2.0; ix++) {
        var x = -1.0 + ix * cs, y = -1.0 + iy * cs;
        var dir = (ix + iy) % 2;
        var g = dir ? c.createLinearGradient(x, y, x + cs, y + cs)
                    : c.createLinearGradient(x + cs, y, x, y + cs);
        g.addColorStop(0, lite); g.addColorStop(1, dark);
        c.fillStyle = g; c.fillRect(x, y, cs + 0.006, cs + 0.006);
      }
    }
  });
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.drawImage(cv, -1, -1, 2, 2);
  ctx.restore();
  // Animated sheen sweep — one cheap gradient, drawn live over the cached weave at the
  // original overlay alpha (ctx.globalAlpha is back to `op` after the restore).
  var sh = (anim * 0.4) % 2.4 - 1.2;
  var gg = ctx.createLinearGradient(sh - 0.5, -0.6, sh + 0.5, 0.6);
  gg.addColorStop(0, "rgba(255,255,255,0)");
  gg.addColorStop(0.5, "rgba(255,255,255,0.07)");
  gg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gg; ctx.fillRect(-1, -1, 2, 2);
}

// --- 9. Camo ----------------------------------------------------------------
function drawCamoPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var scale = 0.7 + 0.9 * Ppat("cm_scale", 0.5);
  // Fully static (seeded RNG, no animation) — render once per (colour, scale) and blit,
  // instead of re-stamping the same ~21 blotches every frame. As with carbon, bake the
  // overlay opacity (ctx.globalAlpha) into the cache's inter-layer compositing and blit at
  // full alpha, so the semi-transparent base + overlapping blotches blend exactly as the
  // per-frame version did (over-operator associativity for opaque layers).
  var op = ctx.globalAlpha;
  var cv = getCachedSkinLayer("camo|" + paint + "|" + scale.toFixed(3) + "|" + op, function (c) {
    if (op !== 1) { c.globalAlpha = op; }
    c.fillStyle = cartSkinShade(paint, -0.05); c.fillRect(-1, -1, 2, 2);
    var shades = [cartComp(paint, -0.3), cartSkinShade(paint, 0.2), cartComp(paint, -0.55)];
    var rnd = srnd(1234);
    for (var s = 0; s < shades.length; s++) {
      c.fillStyle = shades[s];
      for (var b = 0; b < 7; b++) {
        var bx = -0.9 + rnd() * 1.8, by = -0.6 + rnd() * 1.2;
        var n = 4 + ((rnd() * 4) | 0);
        c.beginPath();
        for (var k = 0; k < n; k++) {
          var ox = bx + (rnd() - 0.5) * 0.34 * scale;
          var oy = by + (rnd() - 0.5) * 0.26 * scale;
          var rr = (0.07 + rnd() * 0.13) * scale;
          c.moveTo(ox + rr, oy); c.arc(ox, oy, rr, 0, Math.PI * 2);
        }
        c.fill();
      }
    }
  });
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.drawImage(cv, -1, -1, 2, 2);
  ctx.restore();
}

// --- 10. Hazard Stripes -----------------------------------------------------
function drawHazardPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var w = 0.12 + 0.18 * Ppat("hz_w", 0.5);
  var a = cartSkinShade(paint, 0.12), d = cartComp(paint, -0.10);
  ctx.save();
  ctx.rotate(-Math.PI / 4);
  var scroll = (anim * 0.3) % (2 * w);
  for (var x = -2.4 + scroll; x < 2.4; x += 2 * w) {
    ctx.fillStyle = a; ctx.fillRect(x, -2.2, w, 4.4);
    ctx.fillStyle = d; ctx.fillRect(x + w, -2.2, w, 4.4);
  }
  ctx.restore();
}

// --- 11. Circuit Board ------------------------------------------------------
function drawCircuitPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var glow = Ppat("ci_glow", 0.6);
  ctx.fillStyle = cartSkinShade(paint, -0.52); ctx.fillRect(-1, -1, 2, 2);
  var trace = cartComp(paint, 0.10), node = cartComp(paint, 0.4);
  var rnd = srnd(77);
  ctx.lineWidth = 0.022; ctx.lineCap = "round"; ctx.lineJoin = "round";
  var paths = [];
  for (var i = 0; i < 11; i++) {
    var x = -1.0 + rnd() * 2.0, y = -1.0 + rnd() * 2.0;
    var px = x, py = y, pts = [[px, py]];
    var segs = 2 + ((rnd() * 3) | 0);
    ctx.strokeStyle = trace; ctx.beginPath(); ctx.moveTo(px, py);
    for (var s = 0; s < segs; s++) {
      if (rnd() < 0.5) px += (rnd() - 0.5) * 0.7; else py += (rnd() - 0.5) * 0.7;
      px = Math.max(-0.9, Math.min(0.9, px)); py = Math.max(-0.6, Math.min(0.6, py));
      ctx.lineTo(px, py); pts.push([px, py]);
    }
    ctx.stroke();
    ctx.fillStyle = node;
    ctx.fillRect(x - 0.028, y - 0.028, 0.056, 0.056);
    ctx.fillRect(px - 0.028, py - 0.028, 0.056, 0.056);
    paths.push(pts);
  }
  ctx.fillStyle = cartSkinShadeA(paint, 0.85, 0.55 + 0.45 * glow);
  for (var p = 0; p < paths.length; p++) {
    var ps = paths[p]; if (ps.length < 2) continue;
    var t = (anim * 0.4 + p * 0.31) % 1;
    var seg = Math.floor(t * (ps.length - 1)), ft = t * (ps.length - 1) - seg;
    var a0 = ps[seg], a1 = ps[seg + 1];
    ctx.beginPath();
    ctx.arc(a0[0] + (a1[0] - a0[0]) * ft, a0[1] + (a1[1] - a0[1]) * ft, 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
}

// --- 12. Dragon Scales ------------------------------------------------------
function drawScalesPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var sz = 0.12 + 0.10 * Ppat("sc_size", 0.5);
  var rowH = sz * 0.72, row = 0;
  // Each scale's gradient is purely VERTICAL (x0===x1), so its colour mapping depends only
  // on y — every scale in a row is coloured identically regardless of x. Build the gradient
  // ONCE per row (and hoist the constant stroke style) instead of once per scale: ~cols×
  // fewer gradient objects per frame, pixel-for-pixel identical output.
  var dark = cartComp(paint, -0.30);
  ctx.strokeStyle = cartComp(paint, -0.5); ctx.lineWidth = 0.012;
  for (var y = -1.0; y < 1.06; y += rowH) {
    var off = (row % 2) ? sz : 0;
    var shimmer = 0.28 + 0.16 * Math.sin(anim * 2 + row * 0.6);
    var g = ctx.createLinearGradient(0, y, 0, y + sz);
    g.addColorStop(0, cartSkinShade(paint, shimmer));
    g.addColorStop(1, dark);
    ctx.fillStyle = g;
    for (var x = -1.0; x < 1.02; x += sz * 2) {
      var cx = x + off;
      ctx.beginPath(); ctx.arc(cx, y, sz, 0, Math.PI); ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    row++;
  }
}

// --- 13. Electric -----------------------------------------------------------
function drawElectricPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var inten = Ppat("lt_int", 0.6);
  var bg = ctx.createLinearGradient(0, -0.6, 0, 0.6);
  bg.addColorStop(0, cartSkinShade(paint, -0.32)); bg.addColorStop(1, cartSkinShade(paint, -0.6));
  ctx.fillStyle = bg; ctx.fillRect(-1, -1, 2, 2);
  var bolts = 6;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (var b = 0; b < bolts; b++) {
    var phase = anim * 2 + b * 1.3;
    if (Math.sin(phase * 1.7 + b) < (0.2 - 0.5 * inten)) continue;
    var rnd = srnd((b * 97 + Math.floor(phase * 3)) >>> 0);
    var x = -0.95 + (b / (bolts - 1)) * 1.9, y = -1.05;
    ctx.beginPath(); ctx.moveTo(x, y);
    while (y < 1.05) { y += 0.11 + rnd() * 0.1; x += (rnd() - 0.5) * 0.24; ctx.lineTo(x, y); }
    ctx.strokeStyle = cartCompA(paint, 0.4, 0.95); ctx.lineWidth = 0.045;
    ctx.shadowColor = cartComp(paint, 0.2); ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 0.014; ctx.stroke();
  }
}

// --- 14. Tiger --------------------------------------------------------------
function tigerStripe(ctx, x, edgeY, tipY, w) {
  ctx.beginPath();
  ctx.moveTo(x - w, edgeY);
  ctx.quadraticCurveTo(x - w * 0.3, (edgeY + tipY) * 0.5, x, tipY);
  ctx.quadraticCurveTo(x + w * 0.3, (edgeY + tipY) * 0.5, x + w, edgeY);
  ctx.closePath(); ctx.fill();
}
function drawTigerPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var bold = 0.7 + 0.7 * Ppat("tg_bold", 0.5);
  ctx.fillStyle = cartSkinShadeA(paint, 0.12, 0.35); ctx.fillRect(-1, -1, 2, 2);
  ctx.fillStyle = cartComp(paint, -0.12);
  var stripes = [
    [-0.66, -1, 0.62, 1.1], [-0.5, 1, 0.5, 0.8], [-0.4, -1, 0.85, 0.7],
    [-0.24, 1, 0.7, 1.2], [-0.12, -1, 0.55, 0.9], [0.02, 1, 0.9, 0.7],
    [0.12, -1, 0.78, 1.0], [0.28, 1, 0.5, 0.85], [0.36, -1, 0.6, 1.2],
    [0.52, 1, 0.82, 0.7], [0.62, -1, 0.7, 0.95], [0.78, 1, 0.55, 1.0],
  ];
  for (var i = 0; i < stripes.length; i++) {
    var s = stripes[i], edgeY = s[1] * 1.05;            // start at the orb edge, not 0.72
    var tipY = s[1] * (1.05 - 1.35 * s[2]);             // tips reach toward/past centre
    var sway = Math.sin(anim * 1.5 + i) * 0.015;
    tigerStripe(ctx, s[0] * 1.4 + sway, edgeY, tipY, 0.055 * bold * s[3]); // widen x to fill
  }
}

// --- 15. Waves --------------------------------------------------------------
function drawWavesPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var amp = 0.04 + 0.11 * Ppat("wv_amp", 0.5);
  var freq = 6, bandH = 0.17, drift = anim * 0.5, i = 0;
  for (var base = -1.05; base < 1.1; base += bandH) {
    ctx.beginPath();
    ctx.moveTo(-1.05, base + Math.sin(-1.05 * freq + drift + i * 0.5) * amp);
    for (var x = -1.05; x <= 1.05; x += 0.07) {
      ctx.lineTo(x, base + Math.sin(x * freq + drift + i * 0.5) * amp);
    }
    ctx.lineTo(1.05, 1.1); ctx.lineTo(-1.05, 1.1); ctx.closePath();
    ctx.fillStyle = (i % 2) ? cartComp(paint, 0.05) : cartSkinShade(paint, -0.26);
    ctx.fill(); i++;
  }
}

// --- 16. Honeycomb ----------------------------------------------------------
function hexPath(ctx, cx, cy, R) {
  ctx.beginPath();
  for (var k = 0; k < 6; k++) {
    var a = Math.PI / 180 * (60 * k - 90);
    var x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
function drawHoneycombPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var R = 0.10 + 0.09 * Ppat("hc_size", 0.5);
  var w = Math.sqrt(3) * R, hh = 1.5 * R, edge = cartComp(paint, 0.15), row = 0;
  // Hex vertex offsets are constant for a given R — compute them once instead of re-running
  // 6 cos/sin per cell every frame (~hundreds of trig calls/frame). The per-cell shimmer
  // (fill colour) still animates and is drawn live. Stroke style hoisted out of the loop.
  var hx = [], hy = [];
  for (var k = 0; k < 6; k++) {
    var a = Math.PI / 180 * (60 * k - 90);
    hx.push(Math.cos(a) * R); hy.push(Math.sin(a) * R);
  }
  ctx.strokeStyle = edge; ctx.lineWidth = 0.02;
  for (var y = -1.05; y < 1.1; y += hh) {
    var off = (row % 2) ? w / 2 : 0;
    for (var x = -1.02; x < 1.06; x += w) {
      var cx = x + off;
      ctx.beginPath();
      ctx.moveTo(cx + hx[0], y + hy[0]);
      for (var kk = 1; kk < 6; kk++) ctx.lineTo(cx + hx[kk], y + hy[kk]);
      ctx.closePath();
      var sh = 0.5 + 0.5 * Math.sin(anim * 2 - cx * 2 + y * 2);
      ctx.fillStyle = cartSkinShade(paint, -0.36 + 0.26 * sh);
      ctx.fill();
      ctx.stroke();
    }
    row++;
  }
}

// --- 17. Splatter -----------------------------------------------------------
function drawSplatterPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var dense = Ppat("sp_dense", 0.5);
  var rnd = srnd(909);
  var n = Math.round(6 + 12 * dense);
  for (var i = 0; i < n; i++) {
    var x = -1.0 + rnd() * 2.0, y = -1.0 + rnd() * 2.0;
    ctx.fillStyle = (rnd() < 0.5) ? cartSkinShade(paint, 0.5) : cartComp(paint, -0.18);
    var R = 0.05 + rnd() * 0.12, pts = 8;
    ctx.beginPath();
    for (var k = 0; k < pts; k++) {
      var a = k / pts * Math.PI * 2, rr = R * (0.6 + rnd() * 0.8);
      var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    var d = 3 + ((rnd() * 4) | 0);
    for (var j = 0; j < d; j++) {
      var da = rnd() * Math.PI * 2, dist = R + rnd() * 0.18;
      ctx.beginPath();
      ctx.arc(x + Math.cos(da) * dist, y + Math.sin(da) * dist, 0.01 + rnd() * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ============================================================================
// BORDER cosmetics — 18 painters ported from docs/asset-prototypes/borders.painters.js
// (approved 2026-05-30). drawXxxBorder(ctx, anim, paint). Normalized space: radius == 1 ==
// kart rim, forward = +X. The integrator (drawBorderOverlay) does translate/scale (NO rotate
// — borders are radial). Painters draw AROUND the rim (~1.0..1.4) and NEVER fill the interior
// (r < ~0.9) so a border composes over ANY cart (incl. the plain sphere) without hiding it.
// Borders ride the shared 2nd cosmetic slot (player.pattern); the registry slot:'border'
// disambiguates them from patterns. The source file's cartSkinRGBA(paint, a) is expressed
// here as cartSkinShadeA(paint, 0, a) (both already in draw.js); P is baked as BORDER_P.
// PERF: no gradient/object alloc inside element loops; same-style elements share ONE path +
// ONE fill/stroke; invariant shade strings hoisted. (See borders.HANDOFF.md "Perf".)
// ============================================================================
var TAU = Math.PI * 2;
// Border painters + BORDER_P now live in client/scripts/borderEffects.js (bundled after
// this file, before skinRegistry.js). Extracted so the borders-review prototype can load
// the live renderers. TAU (above) stays here — used elsewhere in draw.js too.

// ============================================================================
// REGISTRY HINT — id, painter, and overlay opacity.
//   opaque patterns render at ~0.6 so the cart shows through; the rest at 1.
//   The 4 ladder/achievement ids (stripes/polka/checkered/flames/nebula/
//   executioner/punching_bag) keep their existing registry ids; the 10 extras
//   are new ids to add.
// ============================================================================

function getPlayerSprite(color, radius, strokeColor) {
    var key = color + '|' + radius + '|' + strokeColor;
    var cached = playerSpriteCache[key];
    if (cached != null) {
        return cached;
    }
    var pad = 8;
    var size = (radius + pad) * 2;
    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    ctx.translate(size / 2, size / 2);

    // Base disc with a soft same-colour glow so the kart reads against dark tiles.
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0; // overlays below must not re-cast the glow

    // Shade the flat disc into a glossy sphere. Every overlay is pure white/black
    // alpha, so this works for ANY kart colour — including the colour-blind remaps
    // that mutate player.color — without ever parsing the colour string. Light is
    // fixed to the upper-left: the sprite is blitted un-rotated, so the highlight
    // stays put every frame instead of spinning with the kart.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.clip();

    // Body gradient: lit cap (upper-left) -> untouched base colour -> dark rim (AO).
    var body = ctx.createRadialGradient(
        -radius * 0.35, -radius * 0.40, radius * 0.10,
        -radius * 0.10, -radius * 0.10, radius * 1.25
    );
    body.addColorStop(0.00, "rgba(255,255,255,0.60)");
    body.addColorStop(0.30, "rgba(255,255,255,0.00)");
    body.addColorStop(0.62, "rgba(0,0,0,0.00)");
    body.addColorStop(1.00, "rgba(0,0,0,0.55)");
    ctx.fillStyle = body;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);

    // Specular reflection orb (echoes the favicon's gloss dot).
    var sx = -radius * 0.34, sy = -radius * 0.42, sr = radius * 0.40;
    var spec = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
    spec.addColorStop(0.00, "rgba(255,255,255,0.95)");
    spec.addColorStop(0.35, "rgba(255,255,255,0.45)");
    spec.addColorStop(1.00, "rgba(255,255,255,0.00)");
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();

    // Rim outline — also the "you are being targeted" tell (red + thicker).
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.lineWidth = (strokeColor === "red") ? 2.5 : 1.25;
    ctx.strokeStyle = strokeColor;
    ctx.stroke();

    canvas.halfSize = size / 2;
    playerSpriteCache[key] = canvas;
    return canvas;
}

//Flames
var redFire = new Image(32, 128);
redFire.src = "../assets/img/redFire.png";
var orangeFire = new Image(32, 128);
orangeFire.src = "../assets/img/orangeFire.png";
var yellowFire = new Image(32, 128);
yellowFire.src = "../assets/img/yellowFire.png";
var greenFire = new Image(32, 128);
greenFire.src = "../assets/img/greenFire.png";
var blueFire = new Image(32, 128);
blueFire.src = "../assets/img/blueFire.png";
var purpleFire = new Image(32, 128);
purpleFire.src = "../assets/img/purpleFire.png";


// Every Image() loadPatterns()/loadSpriteSheets()/HUD draws read from.
// We expose tileImagesReady so setupPage can gate enterLobby on them
// being fully decoded — otherwise a mid-game joiner runs loadPatterns()
// before .complete fires and gets non-null but empty CanvasPatterns, so
// the board renders mostly transparent until the next round's newMap
// rebuilds patterns. requiredImagesLoaded is exposed for the loading bar.
var requiredImages = [
    blindfoldIcon, blindfoldLargeIcon, transferIcon, copyIcon, bombIcon,
    snowFlakeIcon, windIcon, hourglassIcon, lightningIcon, cloudyIcon,
    infinityIcon, fiestaIcon, toolBoxIcon, moneyIcon, volcanoIcon,
    bombImage, snowFlakeImage, cloudImage, infectionIcon, puckIcon,
    explosionIcon, moonIcon, scissorsIcon, starIcon, orbitalBeamIcon, randomTileIcon,
    lava, poison, grass, dirt, ice, sand,
    redFire, orangeFire, yellowFire, greenFire, blueFire, purpleFire
];
var requiredImagesLoaded = 0;
var tileImagesReady = Promise.all(requiredImages.map(function (img) {
    if (img.complete && img.naturalWidth > 0) {
        requiredImagesLoaded++;
        return Promise.resolve();
    }
    return new Promise(function (resolve) {
        var done = function () { requiredImagesLoaded++; resolve(); };
        img.addEventListener('load', done, { once: true });
        // Treat decode failures as "done" too so one missing asset can't
        // hang the loading screen forever.
        img.addEventListener('error', done, { once: true });
    });
}));
// Belt and suspenders: setupPage waits on this Promise, but if anything
// renders before patterns are valid we self-heal once the images land.
tileImagesReady.then(function () {
    if (typeof config !== 'undefined' && config != null) {
        loadPatterns();
    }
    invalidateMapCache();
});


// Terrain texture colour grading (TILE_GRADE / gradeTexture) lives in
// client/scripts/utils.js so both the game (this file) and the map editor
// (create.js) grade from the same single source of truth.

function loadPatterns() {
    // Grade the terrain textures once into a shared palette (see TILE_GRADE),
    // then build every pattern from the graded canvases so the board reads as
    // one cohesive set (the dirt underlay for ability tiles included).
    var gGrass = gradeTexture(grass, "grass");
    var gDirt = gradeTexture(dirt, "dirt");
    var gSand = gradeTexture(sand, "sand");
    var gIce = gradeTexture(ice, "ice");
    var gLava = gradeTexture(lava, "lava");
    var gPoison = gradeTexture(poison, "poison");

    //Abilities
    patterns[config.tileMap.abilities.blindfold.id] = makePattern(blindfoldIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.swap.id] = makePattern(transferIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.bomb.id] = makePattern(bombIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.speedBuff.id] = makePattern(windIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.speedDebuff.id] = makePattern(hourglassIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.tileSwap.id] = makePattern(copyIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.iceCannon.id] = makePattern(snowFlakeIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.cut.id] = makePattern(scissorsIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.starPower.id] = makePattern(starIcon, makeSeamlessPattern(gDirt));
    patterns[config.tileMap.abilities.orbitalBeam.id] = makePattern(orbitalBeamIcon, makeSeamlessPattern(gDirt));
    patterns[config.brutalRounds.infection.id] = makePattern(infectionIcon, "red");

    //Tiles
    if (infection == true) {
        patterns[config.tileMap.lava.id] = makeSeamlessPattern(gPoison);
    } else {
        patterns[config.tileMap.lava.id] = makeSeamlessPattern(gLava);
    }
    patterns[config.tileMap.ice.id] = makeSeamlessPattern(gIce);
    patterns[config.tileMap.fast.id] = makeSeamlessPattern(gGrass);
    patterns[config.tileMap.normal.id] = makeSeamlessPattern(gDirt);
    patterns[config.tileMap.slow.id] = makeSeamlessPattern(gSand);
    if (config.tileMap.water != null) {
        patterns[config.tileMap.water.id] = makeSeamlessPattern(buildWaterTexture());
    }
    // Random tiles are replaced (applyRandomTiles) before any cell in the LIVE
    // map renders, so this pattern is only used by the next-map preview
    // thumbnail (buildMapThumbnailCanvas), which draws straight from maps[i]'s
    // un-replaced cell ids. Without it the thumbnail fell back to flat purple.
    patterns[config.tileMap.random.id] = makePattern(randomTileIcon, config.tileMap.random.color);
    // Likewise, committed maps store ability cells as the un-rolled ability.id
    // (applyAbilites swaps them to a specific ability id only on the LIVE map at
    // round start). The next-map preview thumbnail draws those un-rolled ids, so
    // without this it fell back to flat grey. Show the bomb icon over dirt,
    // matching the editor's map-list thumbnail (create.js).
    patterns[config.tileMap.ability.id] = makePattern(bombIcon, makeSeamlessPattern(gDirt));



    //Asociate images with their brutal round config id
    brutalRoundImages[config.brutalRounds.bomb.id] = bombIcon;
    brutalRoundImages[config.brutalRounds.lightning.id] = lightningIcon;
    brutalRoundImages[config.brutalRounds.cloudy.id] = cloudyIcon;
    brutalRoundImages[config.brutalRounds.ability.id] = toolBoxIcon;
    brutalRoundImages[config.brutalRounds.gravity.id] = infinityIcon;
    brutalRoundImages[config.brutalRounds.fiesta.id] = fiestaIcon;
    brutalRoundImages[config.brutalRounds.golden.id] = moneyIcon;
    brutalRoundImages[config.brutalRounds.volcano.id] = volcanoIcon;
    brutalRoundImages[config.brutalRounds.infection.id] = infectionIcon;
    brutalRoundImages[config.brutalRounds.hockey.id] = puckIcon;
    brutalRoundImages[config.brutalRounds.explosive.id] = explosionIcon;
    brutalRoundImages[config.brutalRounds.blackout.id] = moonIcon;
    brutalRoundImages[config.brutalRounds.bunker.id] = bunkerIcon;
    brutalRoundImages[config.brutalRounds.heatwave.id] = heatwaveIcon;
    brutalRoundImages[config.brutalRounds.antlion.id] = antlionIcon;

    if (brutalRoundConfig != null && brutalPatterns[brutalRoundConfig.brutalTypes.toString()] == null) {
        brutalPatterns[brutalRoundConfig.brutalTypes.toString()] = makeComplexPattern(brutalRoundConfig.brutalTypes);
    }
}

function loadSpriteSheets() {
    if (redFire.spriteSheet == null) {
        redFire.spriteSheet = new SpriteSheet(redFire, 0, 0, 32, 32, 4, 1, true);
    }
    if (orangeFire.spriteSheet == null) {
        orangeFire.spriteSheet = new SpriteSheet(orangeFire, 0, 0, 32, 32, 4, 1, true);
    }
    if (yellowFire.spriteSheet == null) {
        yellowFire.spriteSheet = new SpriteSheet(yellowFire, 0, 0, 32, 32, 4, 1, true);
    }
    if (greenFire.spriteSheet == null) {
        greenFire.spriteSheet = new SpriteSheet(greenFire, 0, 0, 32, 32, 4, 1, true);
    }
    if (blueFire.spriteSheet == null) {
        blueFire.spriteSheet = new SpriteSheet(blueFire, 0, 0, 32, 32, 4, 1, true);
    }
    if (purpleFire.spriteSheet == null) {
        purpleFire.spriteSheet = new SpriteSheet(purpleFire, 0, 0, 32, 32, 4, 1, true);
    }
}

// Procedural deep-water texture (no PNG asset): a vertical blue gradient with a few
// lighter caustic ripple bands. Built once into a tileable canvas and handed to
// makeSeamlessPattern so water tiles read as textured terrain, cohesive with the
// graded grass/dirt/ice rather than a flat fill. The swim ripples (drawTrail) and any
// terrain-FX shimmer layer on top per frame; this is just the static bed.
function buildWaterTexture() {
    // Render at HIGH resolution (512) and stamp it with many fine ripple bands, then
    // hand makeSeamlessPattern a small `scale` so the tile shrinks in world space — the
    // net effect is a crisp, "zoomed-out" water surface whose waves read small and
    // subtle rather than a few big bands.
    var size = 512;
    var cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    var x = cv.getContext("2d");
    var base = (config.tileMap.water && config.tileMap.water.color) ? config.tileMap.water.color : "#2f6fb0";
    var g = x.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, base);
    g.addColorStop(1, "#23578f");
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
    // Many tight, low-amplitude sine bands (full integer periods so the texture still
    // tiles seamlessly). More bands + smaller wiggle = finer waves.
    var BANDS = 14, PERIODS = 6, AMP = 3.5;
    x.strokeStyle = "rgba(160,205,240,0.13)";
    x.lineWidth = 2;
    x.lineCap = "round";
    for (var b = 0; b < BANDS; b++) {
        var yBase = (b + 0.5) * size / BANDS;
        x.beginPath();
        for (var px = 0; px <= size; px += 4) {
            var yy = yBase + Math.sin((px / size) * Math.PI * 2 * PERIODS) * AMP;
            if (px === 0) { x.moveTo(px, yy); } else { x.lineTo(px, yy); }
        }
        x.stroke();
    }
    cv.scale = 0.5; // makeSeamlessPattern shrinks the tile -> smaller waves, retains the 512 detail
    return cv;
}
function makeSeamlessPattern(image) {
    const canvasPattern = document.createElement("canvas");
    const ctxPattern = canvasPattern.getContext("2d");

    var iconWidth = image.width;
    var iconHeight = image.height;
    if (image.scale != null) {
        iconWidth = image.width * image.scale;
        iconHeight = image.height * image.scale;
    }
    canvasPattern.width = iconWidth;
    canvasPattern.height = iconHeight;
    ctxPattern.drawImage(image, 0, 0, iconWidth, iconHeight);
    return gameContext.createPattern(canvasPattern, 'repeat');
}

function makeSpreadPattern(image) {
    const canvasPadding = 300;
    const canvasPattern = document.createElement("canvas");
    const ctxPattern = canvasPattern.getContext("2d");
    var iconWidth = image.width * spreadScale;
    var iconHeight = image.height * spreadScale;
    canvasPattern.width = iconWidth + canvasPadding;
    canvasPattern.height = iconHeight + canvasPadding;
    ctxPattern.drawImage(image, canvasPadding / 2, canvasPadding / 2, iconWidth, iconHeight);
    return gameContext.createPattern(canvasPattern, 'repeat');
}

function makePattern(image, underPattern) {
    const canvasPadding = 3;
    const canvasPattern = document.createElement("canvas");
    const ctxPattern = canvasPattern.getContext("2d");

    var iconWidth = image.width;
    var iconHeight = image.height;
    if (image.scale != null) {
        iconWidth = image.width * image.scale;
        iconHeight = image.height * image.scale;
    } else {
        iconWidth = image.width * scale;
        iconHeight = image.height * scale;
    }
    canvasPattern.width = iconWidth + canvasPadding;
    canvasPattern.height = iconHeight + canvasPadding;
    ctxPattern.beginPath();
    ctxPattern.fillStyle = underPattern;
    ctxPattern.rect(0, 0, canvasPattern.width, canvasPattern.height);
    ctxPattern.fill();

    ctxPattern.drawImage(image, canvasPadding / 2, canvasPadding / 2, iconWidth, iconHeight);
    return gameContext.createPattern(canvasPattern, 'repeat');
}
function makeComplexPattern(ids) {
    var images = [];
    //Lookup associated images
    for (var i = 0; i < ids.length; i++) {
        var image = brutalRoundImages[ids[i]];
        if (image != null) {
            images.push(image);
            continue;
        }
        console.log("ERROR: Server provided brutalRound id (" + ids[i] + ") that is not referenced in LoadPatterns()");
    }

    const canvasPadding = 15;
    const canvasPattern = document.createElement("canvas");
    const ctxPattern = canvasPattern.getContext("2d");

    var iconWidth = images[0].width * complexPatternScale;
    var iconHeight = images[0].height * complexPatternScale;
    canvasPattern.width = iconWidth + canvasPadding;
    canvasPattern.height = (iconHeight * images.length) + canvasPadding;

    ctxPattern.globalAlpha = 0.1;
    for (var j = 0; j < images.length; j++) {
        ctxPattern.drawImage(images[j], canvasPadding / 2, canvasPadding + (j * iconHeight), iconWidth, iconHeight);
    }
    return gameContext.createPattern(canvasPattern, 'repeat');

}
