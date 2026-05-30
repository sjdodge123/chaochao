// ============================================================================
// chaochao — APPROVED pattern painters (locked 2026-05-30)
// ============================================================================
// 17 equippable pattern overlays, each a texture drawn ON the cart body that
// MUST tint to the player's chosen color (`paint`). Signature is the same as the
// existing draw.js pattern stubs:
//
//     function drawXxxPattern(ctx, anim, paint) { ... }
//
//   • Normalized space: radius == 1, forward == +X.
//   • Fill the body interior rect ~ [-0.85..0.85] x [-0.6..0.6]; the integrator
//     clips to the equipped cart silhouette, so don't draw wheels/windshield.
//   • paint = player CSS color string. anim = rolling seconds (subtle motion).
//   • Everything tints via cartSkinShade(paint, ±) / cartSkinShadeA — no fixed
//     color schemes.
//
// OPERATOR SCOPE NOTE (2026-05-30): patterns are intended for the DEFAULT SPHERE
// cart, not the shaped skins. So the integrator only needs to composite these on
// the default cart; the shaped-skin coverage concerns from the prototype don't
// apply.
//
// PORTING:
//   1. These functions drop straight into client/scripts/draw.js, replacing the
//      7 existing placeholder stubs (same names) and adding the 10 new ones.
//   2. `P(key, def)` below is a slider shim that just returns the approved
//      default — inline each `P("x", v)` to its literal `v` when porting (the
//      value is already the approved one).
//   3. cartSkinShade already exists in draw.js. cartSkinShadeA (the rgba twin)
//      may need adding — definition included below for reference.
//   4. _nebStars is a module-level cache — declare it beside the other draw.js
//      caches.
//   5. OPACITY: the `opaque: true` patterns (PATTERN_DEFS below) are full-repaint
//      textures. Give each pattern id an `opacity` in the registry and have the
//      pattern-overlay renderer set ctx.globalAlpha before invoking the painter
//      (default 0.6 for opaque, 1 for the rest) so the cart shows through. The
//      painters themselves are NOT changed for opacity — it's applied around the
//      call.
// ============================================================================

// --- Shims / helpers already present in draw.js (here for standalone use) ----
function P(_key, def) { return def; }   // PORT: inline the literal `def` per call

// cartSkinShade exists in draw.js. cartSkinShadeA is its rgba twin (add if absent):
// function cartSkinShadeA(color, amt, a) {
//   var c = cartSkinRGB(color);
//   var t = amt < 0 ? 0 : 255, f = amt < 0 ? -amt : amt;
//   return "rgba(" + Math.round(c.r + (t - c.r) * f) + "," +
//     Math.round(c.g + (t - c.g) * f) + "," + Math.round(c.b + (t - c.b) * f) + "," + a + ")";
// }

// Deterministic RNG so blotchy/scattered patterns don't shimmer frame to frame.
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
  var w = 0.10 + 0.20 * P("st_w", 0.4);      // stripe width
  var gap = 0.04 + 0.30 * P("st_gap", 0.34); // gap between the two inner edges
  var dark = cartSkinShade(paint, -0.42);    // the racing stripe color
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
  var r = 0.045 + 0.07 * P("pk_size", 0.42);
  var sp = 0.18 + 0.18 * P("pk_gap", 0.46);
  var dot = cartSkinShade(paint, 0.62);
  var hi = cartSkinShade(paint, 0.85);
  var rim = cartSkinShadeA(paint, -0.25, 0.5);  // darker rim so dots read on light bases
  var drift = (anim * 0.06) % sp;
  var breathe = 1 + 0.06 * Math.sin(anim * 2.2);
  var row = 0;
  ctx.lineWidth = r * 0.18;
  for (var dy = -0.6; dy <= 0.6; dy += sp) {
    var off = (row % 2) ? sp / 2 : 0;
    for (var dx = -0.95; dx <= 0.95; dx += sp) {
      var x = dx + off + drift;
      ctx.beginPath(); ctx.arc(x, dy, r * breathe, 0, Math.PI * 2);
      ctx.fillStyle = dot; ctx.fill();
      ctx.strokeStyle = rim; ctx.stroke();
      ctx.beginPath(); ctx.arc(x - r * 0.32, dy - r * 0.32, r * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = hi; ctx.fill();
    }
    row++;
  }
}

// --- 3. Checkered (Lv14) ----------------------------------------------------
function drawCheckeredPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var n = Math.round(5 + 7 * P("ck_n", 0.42));   // squares across
  var dark = cartSkinShade(paint, -0.62);
  var cw = 1.9 / n, chh = 1.3 / n;
  for (var ix = 0; ix < n; ix++) {
    for (var iy = 0; iy < n; iy++) {
      if ((ix + iy) % 2) {
        ctx.fillStyle = dark;
        ctx.fillRect(-0.95 + ix * cw, -0.65 + iy * chh, cw + 0.01, chh + 0.01);
      }
    }
  }
  var sh = (anim * 0.6) % 2.2 - 1.1;
  var g = ctx.createLinearGradient(sh - 0.4, -0.6, sh + 0.4, 0.6);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(-0.95, -0.65, 1.9, 1.3);
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
  var inten = P("fl_int", 0.6);
  var ramp = P("fl_ramp", 0.62);
  var ug = ctx.createLinearGradient(-0.85, 0, 0.85, 0);
  ug.addColorStop(0, cartSkinShade(paint, 0.12));
  ug.addColorStop(1, cartSkinShade(paint, -0.30));
  ctx.fillStyle = ug; ctx.fillRect(-0.9, -0.65, 1.8, 1.3);

  var roots = [-0.46, -0.28, -0.10, 0.08, 0.26, 0.46];
  var baseLen = 0.7 + 0.55 * inten;
  var layers = [
    { lenK: 1.00, widK: 0.34, shade: -0.18 },
    { lenK: 0.74, widK: 0.24, shade: 0.20 + 0.3 * ramp },
    { lenK: 0.46, widK: 0.15, shade: 0.45 + 0.45 * ramp },
  ];
  for (var L = 0; L < layers.length; L++) {
    ctx.fillStyle = cartSkinShade(paint, layers[L].shade);
    for (var i = 0; i < roots.length; i++) {
      var flick = 0.8 + 0.2 * Math.sin(anim * 6 + i * 1.7) + 0.1 * Math.sin(anim * 11 + i);
      var len = baseLen * layers[L].lenK * flick;
      flameTongue(ctx, -0.9, roots[i], len, 0.30 * layers[L].widK / 0.34 + 0.04);
    }
  }
  ctx.fillStyle = cartSkinShade(paint, 0.7 + 0.25 * ramp);
  for (var c = 0; c < roots.length; c++) {
    var fl2 = 0.8 + 0.2 * Math.sin(anim * 8 + c);
    ctx.beginPath();
    ctx.ellipse(-0.86, roots[c], 0.05 * fl2, 0.045, 0, 0, Math.PI * 2); ctx.fill();
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
  var drift = P("nb_drift", 0.5);
  var density = P("nb_stars", 0.55);
  var g = ctx.createRadialGradient(-0.1, -0.05, 0.05, 0, 0, 1.0);
  g.addColorStop(0, cartSkinShade(paint, 0.35));
  g.addColorStop(0.55, cartSkinShade(paint, -0.15));
  g.addColorStop(1, cartSkinShade(paint, -0.6));
  ctx.fillStyle = g; ctx.fillRect(-0.95, -0.65, 1.9, 1.3);

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
    wg.addColorStop(0, cartSkinShadeA(paint, ws.sh, 0.5));
    wg.addColorStop(1, cartSkinShadeA(paint, ws.sh, 0));
    ctx.fillStyle = wg; ctx.fillRect(-0.95, -0.65, 1.9, 1.3);
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
  var menace = P("ex_menace", 0.55);
  var g = ctx.createRadialGradient(0, 0, 0.15, 0, 0, 1.05);
  g.addColorStop(0, cartSkinShade(paint, -0.2 - 0.2 * menace));
  g.addColorStop(1, cartSkinShade(paint, -0.62));
  ctx.fillStyle = g; ctx.fillRect(-0.95, -0.65, 1.9, 1.3);

  var bone = cartSkinShade(paint, 0.78);
  var boneSh = cartSkinShade(paint, -0.5);
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
  var bruise = P("pb_bruise", 0.55);
  var wobble = Math.sin(anim * 3) * 0.02;

  ctx.save();
  ctx.translate(wobble, Math.cos(anim * 2.4) * 0.015);

  var cxr = 0.06, cyr = -0.02;
  var rings = [0.5, 0.4, 0.3, 0.2, 0.1];
  for (var i = 0; i < rings.length; i++) {
    ctx.beginPath(); ctx.arc(cxr, cyr, rings[i], 0, Math.PI * 2);
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.55) : cartSkinShade(paint, -0.5);
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
  var cs = 0.085 + 0.075 * (1 - P("cf_scale", 0.5));
  var lite = cartSkinShade(paint, -0.16), dark = cartSkinShade(paint, -0.52);
  for (var iy = 0; iy * cs < 1.4; iy++) {
    for (var ix = 0; ix * cs < 2.0; ix++) {
      var x = -0.97 + ix * cs, y = -0.67 + iy * cs;
      var dir = (ix + iy) % 2;
      var g = dir ? ctx.createLinearGradient(x, y, x + cs, y + cs)
                  : ctx.createLinearGradient(x + cs, y, x, y + cs);
      g.addColorStop(0, lite); g.addColorStop(1, dark);
      ctx.fillStyle = g; ctx.fillRect(x, y, cs + 0.006, cs + 0.006);
    }
  }
  var sh = (anim * 0.4) % 2.4 - 1.2;
  var gg = ctx.createLinearGradient(sh - 0.5, -0.6, sh + 0.5, 0.6);
  gg.addColorStop(0, "rgba(255,255,255,0)");
  gg.addColorStop(0.5, "rgba(255,255,255,0.07)");
  gg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gg; ctx.fillRect(-0.95, -0.65, 1.9, 1.3);
}

// --- 9. Camo ----------------------------------------------------------------
function drawCamoPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var scale = 0.7 + 0.9 * P("cm_scale", 0.5);
  ctx.fillStyle = cartSkinShade(paint, -0.05); ctx.fillRect(-0.95, -0.65, 1.9, 1.3);
  var shades = [cartSkinShade(paint, -0.4), cartSkinShade(paint, 0.2), cartSkinShade(paint, -0.62)];
  var rnd = srnd(1234);
  for (var s = 0; s < shades.length; s++) {
    ctx.fillStyle = shades[s];
    for (var b = 0; b < 7; b++) {
      var bx = -0.9 + rnd() * 1.8, by = -0.6 + rnd() * 1.2;
      var n = 4 + ((rnd() * 4) | 0);
      ctx.beginPath();
      for (var k = 0; k < n; k++) {
        var ox = bx + (rnd() - 0.5) * 0.34 * scale;
        var oy = by + (rnd() - 0.5) * 0.26 * scale;
        var rr = (0.07 + rnd() * 0.13) * scale;
        ctx.moveTo(ox + rr, oy); ctx.arc(ox, oy, rr, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }
}

// --- 10. Hazard Stripes -----------------------------------------------------
function drawHazardPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var w = 0.12 + 0.18 * P("hz_w", 0.5);
  var a = cartSkinShade(paint, 0.12), d = cartSkinShade(paint, -0.55);
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
  var glow = P("ci_glow", 0.6);
  ctx.fillStyle = cartSkinShade(paint, -0.52); ctx.fillRect(-0.95, -0.65, 1.9, 1.3);
  var trace = cartSkinShade(paint, 0.32), node = cartSkinShade(paint, 0.55);
  var rnd = srnd(77);
  ctx.lineWidth = 0.022; ctx.lineCap = "round"; ctx.lineJoin = "round";
  var paths = [];
  for (var i = 0; i < 11; i++) {
    var x = -0.85 + rnd() * 1.7, y = -0.55 + rnd() * 1.1;
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
  var sz = 0.12 + 0.10 * P("sc_size", 0.5);
  var rowH = sz * 0.72, row = 0;
  for (var y = -0.66; y < 0.74; y += rowH) {
    var off = (row % 2) ? sz : 0;
    var shimmer = 0.28 + 0.16 * Math.sin(anim * 2 + row * 0.6);
    for (var x = -1.0; x < 1.02; x += sz * 2) {
      var cx = x + off;
      ctx.beginPath(); ctx.arc(cx, y, sz, 0, Math.PI); ctx.closePath();
      var g = ctx.createLinearGradient(cx, y, cx, y + sz);
      g.addColorStop(0, cartSkinShade(paint, shimmer));
      g.addColorStop(1, cartSkinShade(paint, -0.42));
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = cartSkinShade(paint, -0.55); ctx.lineWidth = 0.012; ctx.stroke();
    }
    row++;
  }
}

// --- 13. Electric -----------------------------------------------------------
function drawElectricPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var inten = P("lt_int", 0.6);
  var bg = ctx.createLinearGradient(0, -0.6, 0, 0.6);
  bg.addColorStop(0, cartSkinShade(paint, -0.32)); bg.addColorStop(1, cartSkinShade(paint, -0.6));
  ctx.fillStyle = bg; ctx.fillRect(-0.95, -0.65, 1.9, 1.3);
  var bolts = 5;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (var b = 0; b < bolts; b++) {
    var phase = anim * 2 + b * 1.3;
    if (Math.sin(phase * 1.7 + b) < (0.2 - 0.5 * inten)) continue;
    var rnd = srnd((b * 97 + Math.floor(phase * 3)) >>> 0);
    var x = -0.8 + (b / (bolts - 1)) * 1.6, y = -0.62;
    ctx.beginPath(); ctx.moveTo(x, y);
    while (y < 0.62) { y += 0.11 + rnd() * 0.1; x += (rnd() - 0.5) * 0.24; ctx.lineTo(x, y); }
    ctx.strokeStyle = cartSkinShadeA(paint, 0.75, 0.9); ctx.lineWidth = 0.045;
    ctx.shadowColor = cartSkinShade(paint, 0.6); ctx.shadowBlur = 8;
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
  var bold = 0.7 + 0.7 * P("tg_bold", 0.5);
  ctx.fillStyle = cartSkinShadeA(paint, 0.12, 0.35); ctx.fillRect(-0.95, -0.65, 1.9, 1.3);
  ctx.fillStyle = cartSkinShade(paint, -0.58);
  var stripes = [
    [-0.66, -1, 0.62, 1.1], [-0.5, 1, 0.5, 0.8], [-0.4, -1, 0.85, 0.7],
    [-0.24, 1, 0.7, 1.2], [-0.12, -1, 0.55, 0.9], [0.02, 1, 0.9, 0.7],
    [0.12, -1, 0.78, 1.0], [0.28, 1, 0.5, 0.85], [0.36, -1, 0.6, 1.2],
    [0.52, 1, 0.82, 0.7], [0.62, -1, 0.7, 0.95], [0.78, 1, 0.55, 1.0],
  ];
  for (var i = 0; i < stripes.length; i++) {
    var s = stripes[i], edgeY = s[1] * 0.72;
    var tipY = s[1] * (0.72 - 1.1 * s[2]);
    var sway = Math.sin(anim * 1.5 + i) * 0.015;
    tigerStripe(ctx, s[0] + sway, edgeY, tipY, 0.05 * bold * s[3]);
  }
}

// --- 15. Waves --------------------------------------------------------------
function drawWavesPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var amp = 0.04 + 0.11 * P("wv_amp", 0.5);
  var freq = 6, bandH = 0.17, drift = anim * 0.5, i = 0;
  for (var base = -0.78; base < 0.85; base += bandH) {
    ctx.beginPath();
    ctx.moveTo(-0.97, base + Math.sin(-0.97 * freq + drift + i * 0.5) * amp);
    for (var x = -0.97; x <= 0.97; x += 0.07) {
      ctx.lineTo(x, base + Math.sin(x * freq + drift + i * 0.5) * amp);
    }
    ctx.lineTo(0.97, 0.72); ctx.lineTo(-0.97, 0.72); ctx.closePath();
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.22) : cartSkinShade(paint, -0.26);
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
  var R = 0.10 + 0.09 * P("hc_size", 0.5);
  var w = Math.sqrt(3) * R, hh = 1.5 * R, edge = cartSkinShade(paint, 0.4), row = 0;
  for (var y = -0.72; y < 0.82; y += hh) {
    var off = (row % 2) ? w / 2 : 0;
    for (var x = -1.02; x < 1.06; x += w) {
      var cx = x + off;
      hexPath(ctx, cx, y, R);
      var sh = 0.5 + 0.5 * Math.sin(anim * 2 - cx * 2 + y * 2);
      ctx.fillStyle = cartSkinShade(paint, -0.36 + 0.26 * sh);
      ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = 0.013; ctx.stroke();
    }
    row++;
  }
}

// --- 17. Splatter -----------------------------------------------------------
function drawSplatterPattern(ctx, anim, paint) {
  paint = paint || "#888";
  var dense = P("sp_dense", 0.5);
  var rnd = srnd(909);
  var n = Math.round(6 + 12 * dense);
  for (var i = 0; i < n; i++) {
    var x = -0.85 + rnd() * 1.7, y = -0.55 + rnd() * 1.1;
    ctx.fillStyle = (rnd() < 0.5) ? cartSkinShade(paint, 0.5) : cartSkinShade(paint, -0.5);
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
// REGISTRY HINT — id, painter, and overlay opacity.
//   opaque patterns render at ~0.6 so the cart shows through; the rest at 1.
//   The 4 ladder/achievement ids (stripes/polka/checkered/flames/nebula/
//   executioner/punching_bag) keep their existing registry ids; the 10 extras
//   are new ids to add.
// ============================================================================
var PATTERN_DEFS = [
  { id: "stripes",      fn: drawStripesPattern,    opacity: 1   },
  { id: "polka",        fn: drawPolkaPattern,      opacity: 1   },
  { id: "checkered",    fn: drawCheckeredPattern,  opacity: 1   },
  { id: "flames",       fn: drawFlamesPattern,     opacity: 0.6 },
  { id: "nebula",       fn: drawNebulaPattern,     opacity: 0.6 },
  { id: "executioner",  fn: drawExecutionerPattern, opacity: 1  },
  { id: "punching_bag", fn: drawPunchingBagPattern, opacity: 1  },
  { id: "carbon",       fn: drawCarbonPattern,     opacity: 0.6 },
  { id: "camo",         fn: drawCamoPattern,       opacity: 0.6 },
  { id: "hazard",       fn: drawHazardPattern,     opacity: 0.6 },
  { id: "circuit",      fn: drawCircuitPattern,    opacity: 0.6 },
  { id: "scales",       fn: drawScalesPattern,     opacity: 0.6 },
  { id: "electric",     fn: drawElectricPattern,   opacity: 0.6 },
  { id: "tiger",        fn: drawTigerPattern,      opacity: 0.6 },
  { id: "waves",        fn: drawWavesPattern,      opacity: 0.6 },
  { id: "honeycomb",    fn: drawHoneycombPattern,  opacity: 0.6 },
  { id: "splatter",     fn: drawSplatterPattern,   opacity: 1   },
];
