// Christmas 2026 trail CANDIDATES — harness-only prototypes (NOT shipped; loaded by
// trails-review.html after the real trailEffects.js). Each registers itself into TRAIL_FX
// under an `xmas_*` id so it can be cycled next to the committed Yulefire. Once one is
// picked, port it into trailEffects.js as drawYulefireTrail and delete it here.
// All use the same helpers as shipping painters (tfxForEachParticle, tfxParticlePhase,
// tfxGlowPaint, TP knobs) so a port is a copy, not a rewrite.
(function () {
  if (typeof TRAIL_FX === 'undefined') { return; }
  var mixCache = {};
  function mixToward(color, target, m) {
    var k = color + '|' + target + '|' + m, s = mixCache[k];
    if (s) return s;
    var a = tfxRGB(color), b = tfxRGB(target);
    s = 'rgb(' + Math.round(a.r + (b.r - a.r) * m) + ',' + Math.round(a.g + (b.g - a.g) * m) + ',' + Math.round(a.b + (b.b - a.b) * m) + ')';
    mixCache[k] = s; return s;
  }
  // Shared tapered-ribbon prep (same as yulefire/ghostfire): returns sampled indices + per-sample
  // half-width/normal/age-alpha arrays.
  function ribbonPrep(verts, now, fadeEff, WIDTH, TAPER, flickFn) {
    var n = verts.length, stride = Math.max(1, Math.floor(n / 50)), idx = [];
    for (var i = 0; i < n; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    var m = idx.length, hw = new Array(m), nx = new Array(m), ny = new Array(m), af = new Array(m);
    for (var j = 0; j < m; j++) {
      var ii = idx[j], f = tfxAgeAlpha(verts[ii].t, now, fadeEff);
      af[j] = f;
      hw[j] = (WIDTH * 0.5) * Math.pow(f, TAPER) * (flickFn ? flickFn(verts[ii].t) : 1);
      var tan = tfxTangent(verts, ii); nx[j] = -tan.y; ny[j] = tan.x;
    }
    return { idx: idx, m: m, hw: hw, nx: nx, ny: ny, af: af };
  }
  function ribbonFill(c, verts, R, fillStyle, alphaScale) {
    c.fillStyle = fillStyle;
    for (var s = 1; s < R.m; s++) {
      var alpha = R.af[s] * alphaScale; if (alpha <= 0.02) continue;
      var p0 = verts[R.idx[s - 1]], p1 = verts[R.idx[s]];
      tfxAlpha(c, alpha);
      c.beginPath();
      c.moveTo(p0.x + R.nx[s - 1] * R.hw[s - 1], p0.y + R.ny[s - 1] * R.hw[s - 1]);
      c.lineTo(p1.x + R.nx[s] * R.hw[s], p1.y + R.ny[s] * R.hw[s]);
      c.lineTo(p1.x - R.nx[s] * R.hw[s], p1.y - R.ny[s] * R.hw[s]);
      c.lineTo(p0.x - R.nx[s - 1] * R.hw[s - 1], p0.y - R.ny[s - 1] * R.hw[s - 1]);
      c.closePath(); c.fill();
    }
  }
  function coreStroke(c, verts, R, style, width, alpha) {
    var cs = -1;
    for (var k = 0; k < R.m; k++) { if (R.af[k] > 0.35) { cs = k; break; } }
    if (cs < 0 || cs >= R.m - 1) return;
    tfxAlpha(c, alpha); c.strokeStyle = style; c.lineCap = 'round'; c.lineWidth = width;
    c.beginPath(); c.moveTo(verts[R.idx[cs]].x, verts[R.idx[cs]].y);
    for (var cc = cs + 1; cc < R.m; cc++) c.lineTo(verts[R.idx[cc]].x, verts[R.idx[cc]].y);
    c.stroke();
  }
  function headBlob(ctx, head, color, R, hotStyle, hotR) {
    tfxAlpha(ctx, 1);
    if (tfxGlow()) ctx.shadowBlur = 0;
    ctx.save(); ctx.translate(head.x, head.y); ctx.scale(R, R);
    ctx.fillStyle = tfxBlobGrad(ctx, color);
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TFX_TAU); ctx.fill();
    ctx.restore();
    if (hotStyle) {
      tfxAlpha(ctx, 0.95); ctx.fillStyle = hotStyle;
      ctx.beginPath(); ctx.arc(head.x, head.y, hotR, 0, TFX_TAU); ctx.fill();
    }
  }

  // ======================================================================================
  // A. CANDY CANE — the ribbon IS the cane: white body, red bands scrolling along it like a
  // barber pole, peppermint-swirl head, a few mint sparkles. Player colour = the glow + the
  // swirl's third stripe, so the kart's identity survives the white/red takeover.
  // ======================================================================================
  var CANE_WHITE = '#fbfdff', CANE_RED = '#e3142d', CANE_MINT = '#9ff5c9';
  TRAIL_FX.xmas_candycane = function (ctx, verts, color, now, fadeMs, anim) {
    var n = verts.length; if (n < 2) return;
    var WIDTH = TP('xmas_candycane', 'WIDTH', 16), GLOW = TP('xmas_candycane', 'GLOW', 16);
    var STRIPE = TP('xmas_candycane', 'STRIPE', 1.1), SPEED = TP('xmas_candycane', 'SPEED', 0.09);
    var SPARK = TP('xmas_candycane', 'SPARK', 6), TAPER = TP('xmas_candycane', 'TAPER', 0.75);
    // cumulative arc length so the dash phase is continuous across buckets
    var cum = new Array(n); cum[0] = 0;
    for (var i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(verts[i].x - verts[i - 1].x, verts[i].y - verts[i - 1].y);
    var bucketMs = fadeMs / TFX_BUCKETS;
    ctx.save(); ctx.lineJoin = 'round';
    var body = function (c) {
      c.lineJoin = 'round';
      for (var b = TFX_BUCKETS - 1; b >= 0; b--) {
        var t = (b + 0.5) / TFX_BUCKETS;
        var w = Math.max(1.5, WIDTH * Math.pow(1 - t, TAPER));
        // contiguous run of verts in this age bucket (+1 overlap for continuity)
        var first = -1, last = -1;
        for (var k = 0; k < n; k++) {
          var age = now - verts[k].t; var seg = age >= fadeMs ? TFX_BUCKETS : Math.floor(age / bucketMs);
          if (seg === b) { if (first < 0) first = k; last = k; }
        }
        if (first < 0) continue;
        var start = Math.max(0, first - 1);
        c.beginPath(); c.moveTo(verts[start].x, verts[start].y);
        for (var q = start + 1; q <= last; q++) c.lineTo(verts[q].x, verts[q].y);
        tfxAlpha(c, 0.95 * (1 - t * 0.6));
        c.setLineDash([]); c.lineCap = 'round'; c.strokeStyle = CANE_WHITE; c.lineWidth = w; c.stroke();
        c.lineCap = 'butt'; c.strokeStyle = CANE_RED; c.lineWidth = w;
        var dash = Math.max(2, WIDTH * STRIPE * 0.6);
        c.setLineDash([dash, dash]);
        c.lineDashOffset = -cum[start] + anim * SPEED;
        c.stroke();
        c.setLineDash([]);
      }
    };
    tfxGlowPaint(ctx, verts, color, GLOW, WIDTH, null, body);
    // mint sparkles: tiny 4-point twinkles that hug the cane then lift off
    var interval = Math.max(60, fadeMs / SPARK);
    tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
      var ph = tfxParticlePhase(age, fadeMs); if (ph.alpha <= 0.03) return;
      var h = tfxHash(ts), h2 = tfxHash(ts + 311);
      var x = v.x + (h2 - 0.5) * WIDTH * 1.6, y = v.y - 28 * ph.drift;
      var tw = 0.5 + 0.5 * Math.sin(anim * 0.025 + h * 40), s = 2.2 + h * 2.5;
      ctx.save(); ctx.translate(x, y); ctx.rotate(h2 * 1.2);
      tfxAlpha(ctx, ph.alpha * tw); ctx.fillStyle = CANE_MINT;
      ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.28, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.28, 0); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(0, s * 0.28); ctx.lineTo(s, 0); ctx.lineTo(0, -s * 0.28); ctx.closePath(); ctx.fill();
      ctx.restore();
    });
    // head: peppermint swirl (white disc, red + player-colour pinwheel, slow spin)
    var head = verts[n - 1], R = WIDTH * 0.95;
    ctx.save(); ctx.translate(head.x, head.y);
    if (tfxGlow()) ctx.shadowBlur = 0;
    tfxAlpha(ctx, 1); ctx.fillStyle = CANE_WHITE;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TFX_TAU); ctx.fill();
    ctx.rotate(anim * 0.0025);
    for (var wdg = 0; wdg < 4; wdg++) {
      ctx.fillStyle = (wdg % 2 === 0) ? CANE_RED : color;
      var a0 = wdg * Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, a0, a0 + Math.PI / 4); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = CANE_WHITE; ctx.beginPath(); ctx.arc(0, 0, R * 0.28, 0, TFX_TAU); ctx.fill();
    ctx.restore();
    ctx.restore();
  };

  // ======================================================================================
  // B. FAIRY LIGHTS — a dark-green wire traces the path with a string of blinking bulbs
  // (red / green / gold / blue / the player's colour) hanging off it, each with a soft
  // coloured halo. No glow blit at all: the halos are radial gradients, so it's the
  // cheapest candidate.
  // ======================================================================================
  var WIRE = '#0f3d22', BULBS = ['#ff3b3b', '#38d66b', '#ffd34d', '#4f8dff', '#ff7ad9'];
  TRAIL_FX.xmas_lights = function (ctx, verts, color, now, fadeMs, anim) {
    var n = verts.length; if (n < 2) return;
    var WIREW = TP('xmas_lights', 'WIRE', 2.4), BULB = TP('xmas_lights', 'BULB', 6), DENSITY = TP('xmas_lights', 'DENSITY', 14);
    var HALO = TP('xmas_lights', 'HALO', 3.2), BLINK = TP('xmas_lights', 'BLINK', 1);
    ctx.save();
    // wire: per-bucket alpha so it fades with the trail
    var bucketMs = fadeMs / TFX_BUCKETS;
    ctx.strokeStyle = WIRE; ctx.lineWidth = WIREW; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (var b = 0; b < TFX_BUCKETS; b++) {
      tfxAlpha(ctx, (1 - (b + 0.5) / TFX_BUCKETS) * 0.9);
      var run = false;
      ctx.beginPath();
      for (var i = 0; i < n; i++) {
        var age = now - verts[i].t; var seg = age >= fadeMs ? TFX_BUCKETS : Math.floor(age / bucketMs);
        if (seg !== b) { run = false; continue; }
        if (!run) { var p = verts[Math.max(0, i - 1)]; ctx.moveTo(p.x, p.y); run = true; }
        ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.stroke();
    }
    // bulbs: fixed along the path (no drift) — they just fade in place like the wire
    var interval = Math.max(40, fadeMs / DENSITY), bi = 0;
    tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age, i) {
      var a = tfxAgeAlpha(ts, now, fadeMs); if (a <= 0.03) return;
      var h = tfxHash(ts);
      var slot = Math.floor(h * 6);                       // 5 palette colours + the player colour
      var col = slot >= 5 ? color : BULBS[slot];
      var tan = tfxTangent(verts, i), side = (bi++ % 2 === 0) ? 1 : -1;
      var nx = -tan.y * side, ny = tan.x * side;
      var bright = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(anim * 0.004 * BLINK + h * TFX_TAU * 3));
      var cx = v.x + nx * BULB * 1.1, cy = v.y + ny * BULB * 1.1;
      // halo
      ctx.save(); ctx.translate(cx, cy); ctx.scale(BULB * HALO, BULB * HALO);
      tfxAlpha(ctx, a * bright * 0.55); ctx.fillStyle = tfxBlobGrad(ctx, col);
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, TFX_TAU); ctx.fill();
      ctx.restore();
      // bulb body (teardrop pointing away from the wire) + dark cap at the wire
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(ny, nx) + Math.PI / 2);
      tfxAlpha(ctx, a * (0.55 + 0.45 * bright)); ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(0, 0, BULB * 0.62, BULB * 0.95, 0, 0, TFX_TAU); ctx.fill();
      tfxAlpha(ctx, a * bright * 0.9); ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(-BULB * 0.18, -BULB * 0.25, BULB * 0.2, 0, TFX_TAU); ctx.fill();
      tfxAlpha(ctx, a); ctx.fillStyle = WIRE;
      ctx.fillRect(-BULB * 0.35, -BULB * 1.25, BULB * 0.7, BULB * 0.42);
      ctx.restore();
    });
    // head: a bright warm bulb on the kart
    var head = verts[n - 1];
    ctx.save(); ctx.translate(head.x, head.y); ctx.scale(BULB * 2.2, BULB * 2.2);
    tfxAlpha(ctx, 0.9); ctx.fillStyle = tfxBlobGrad(ctx, '#fff1b0');
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TFX_TAU); ctx.fill();
    ctx.restore();
    ctx.restore();
  };

  // ======================================================================================
  // C. HOLLY & BERRIES — evergreen ribbon (player colour pulled toward pine) with a gold
  // core; holly sprigs (two spiky leaves + three red berries) sit along the edges of the
  // path then drop away, with a dusting of snow. Reads "wreath".
  // ======================================================================================
  var PINE = '#1b6b3a', LEAF = '#2e9a55', LEAF_DARK = '#0f4a26', BERRY = '#e3142d', HOLLY_GOLD = '#ffd45c', SNOW = '#f4fbff';
  function hollyLeaf(ctx, L, W) {
    var pts = [[0, 0], [0.18, -0.55], [0.32, -0.3], [0.52, -0.62], [0.68, -0.32], [0.86, -0.5], [1, 0],
               [0.86, 0.5], [0.68, 0.32], [0.52, 0.62], [0.32, 0.3], [0.18, 0.55]];
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) { var x = pts[i][0] * L, y = pts[i][1] * W; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.closePath();
  }
  TRAIL_FX.xmas_holly = function (ctx, verts, color, now, fadeMs, anim) {
    var n = verts.length; if (n < 2) return;
    var WIDTH = TP('xmas_holly', 'WIDTH', 20), GLOW = TP('xmas_holly', 'GLOW', 18), TAPER = TP('xmas_holly', 'TAPER', 0.8);
    var DENSITY = TP('xmas_holly', 'DENSITY', 7), LEAFSZ = TP('xmas_holly', 'LEAF', 15), MIX = TP('xmas_holly', 'MIX', 0.6);
    var fadeEff = fadeMs * TP('xmas_holly', 'TAIL_PERSIST', 1.3);
    var green = mixToward(color, PINE, MIX);
    var R = ribbonPrep(verts, now, fadeEff, WIDTH, TAPER, function (t) { return 0.9 + 0.1 * Math.sin(anim * 0.008 + t * 0.015); });
    ctx.save(); ctx.lineJoin = 'round';
    tfxGlowPaint(ctx, verts, green, GLOW, WIDTH, null, function (c) {
      c.lineJoin = 'round';
      ribbonFill(c, verts, R, green, 0.7);
      coreStroke(c, verts, R, HOLLY_GOLD, Math.max(1.2, WIDTH * 0.16), 0.9);
    });
    var interval = Math.max(60, fadeMs / DENSITY), si = 0;
    tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age, i) {
      var ph = tfxParticlePhase(age, fadeMs); if (ph.alpha <= 0.03) return;
      var h = tfxHash(ts), h2 = tfxHash(ts + 977);
      if (h > 0.8) {
        // snow dust
        var sway = Math.sin(age * 0.002 + h * TFX_TAU) * 8 * ph.drift;
        tfxAlpha(ctx, ph.alpha * 0.85); ctx.fillStyle = SNOW;
        ctx.beginPath(); ctx.arc(v.x + (h2 - 0.5) * WIDTH * 2 + sway, v.y + 30 * ph.drift, 1.2 + h2 * 1.6, 0, TFX_TAU); ctx.fill();
        return;
      }
      var tan = tfxTangent(verts, i), side = (si++ % 2 === 0) ? 1 : -1;
      var nx = -tan.y * side, ny = tan.x * side;
      var off = WIDTH * 0.55;
      var x = v.x + nx * off + (h2 - 0.5) * 4, y = v.y + ny * off + 34 * ph.drift;
      var sz = LEAFSZ * (0.8 + h2 * 0.5);
      ctx.save(); ctx.translate(x, y);
      ctx.rotate(Math.atan2(ny, nx) + (h - 0.5) * 0.8 + Math.sin(anim * 0.003 + h * 9) * 0.25 * ph.drift);
      tfxAlpha(ctx, ph.alpha);
      // two leaves fanning outward from the berry cluster
      for (var L = -1; L <= 1; L += 2) {
        ctx.save(); ctx.rotate(L * 0.55);
        ctx.fillStyle = LEAF; hollyLeaf(ctx, sz, sz * 0.42); ctx.fill();
        ctx.strokeStyle = LEAF_DARK; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sz * 0.08, 0); ctx.lineTo(sz * 0.92, 0); ctx.stroke();
        ctx.restore();
      }
      // berries
      var br = sz * 0.17;
      var bp = [[0, 0], [br * 1.5, -br * 0.9], [br * 1.5, br * 0.9]];
      for (var k = 0; k < 3; k++) {
        ctx.fillStyle = BERRY; ctx.beginPath(); ctx.arc(bp[k][0], bp[k][1], br, 0, TFX_TAU); ctx.fill();
        ctx.fillStyle = '#ffffff'; tfxAlpha(ctx, ph.alpha * 0.8);
        ctx.beginPath(); ctx.arc(bp[k][0] - br * 0.3, bp[k][1] - br * 0.3, br * 0.3, 0, TFX_TAU); ctx.fill();
        tfxAlpha(ctx, ph.alpha);
      }
      ctx.restore();
    });
    headBlob(ctx, verts[n - 1], green, WIDTH * 0.95, HOLLY_GOLD, Math.max(1.2, WIDTH * 0.1));
    ctx.restore();
  };

  // ======================================================================================
  // D. SLEIGH DUST — Santa's-sleigh magic: a warm gold glitter ribbon (player colour pulled
  // toward gold), dense twinkling sparkle dust, with wrapped gift boxes tumbling off the
  // back and the odd jingle bell. The most "premium / limited" read of the four.
  // ======================================================================================
  var DUST_GOLD = '#ffcf5a', DUST_HOT = '#fff4c2', GIFT_RED = '#e3142d', GIFT_GREEN = '#2e9a55', GIFT_BLUE = '#4f8dff', BELL = '#f5c242', BELL_DARK = '#a8761a';
  function giftBox(ctx, s, bodyCol) {
    ctx.fillStyle = bodyCol; ctx.fillRect(-s, -s, s * 2, s * 2);
    ctx.fillStyle = DUST_GOLD; ctx.fillRect(-s * 0.18, -s, s * 0.36, s * 2); ctx.fillRect(-s, -s * 0.18, s * 2, s * 0.36);
    ctx.beginPath(); ctx.arc(-s * 0.35, -s * 1.15, s * 0.3, 0, TFX_TAU); ctx.arc(s * 0.35, -s * 1.15, s * 0.3, 0, TFX_TAU); ctx.fill();
  }
  function bell(ctx, s) {
    ctx.fillStyle = BELL;
    ctx.beginPath(); ctx.moveTo(-s * 0.75, s * 0.55); ctx.lineTo(-s * 0.55, -s * 0.1);
    ctx.arc(0, -s * 0.1, s * 0.55, Math.PI, 0); ctx.lineTo(s * 0.75, s * 0.55); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = BELL_DARK; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = BELL_DARK; ctx.beginPath(); ctx.arc(0, s * 0.62, s * 0.18, 0, TFX_TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -s * 0.7, s * 0.14, 0, TFX_TAU); ctx.fill();
  }
  TRAIL_FX.xmas_sleigh = function (ctx, verts, color, now, fadeMs, anim) {
    var n = verts.length; if (n < 2) return;
    var WIDTH = TP('xmas_sleigh', 'WIDTH', 20), GLOW = TP('xmas_sleigh', 'GLOW', 26), TAPER = TP('xmas_sleigh', 'TAPER', 0.7);
    var SPARK = TP('xmas_sleigh', 'SPARK', 18), PROPS = TP('xmas_sleigh', 'PROPS', 4), MIX = TP('xmas_sleigh', 'MIX', 0.85);
    var fadeEff = fadeMs * TP('xmas_sleigh', 'TAIL_PERSIST', 1.4);
    var gold = mixToward(color, DUST_GOLD, MIX);
    var R = ribbonPrep(verts, now, fadeEff, WIDTH, TAPER, function (t) { return 0.85 + 0.15 * Math.sin(anim * 0.01 + t * 0.02); });
    ctx.save(); ctx.lineJoin = 'round';
    tfxGlowPaint(ctx, verts, gold, GLOW, WIDTH, null, function (c) {
      c.lineJoin = 'round';
      ribbonFill(c, verts, R, gold, 0.6);
      coreStroke(c, verts, R, DUST_HOT, Math.max(1, WIDTH * 0.1), 0.8);
    });
    // sparkle dust: many small twinkles scattered across the ribbon, drifting up as they fade
    var si = Math.max(30, fadeMs / SPARK);
    tfxForEachParticle(verts, now, fadeMs, si, function (v, ts, age) {
      var ph = tfxParticlePhase(age, fadeMs); if (ph.alpha <= 0.03) return;
      var h = tfxHash(ts), h2 = tfxHash(ts + 311);
      var x = v.x + (h2 - 0.5) * WIDTH * 1.4 + Math.sin(age * 0.002 + h * TFX_TAU) * 6 * ph.drift;
      var y = v.y - 30 * ph.drift - (h - 0.5) * WIDTH;
      var tw = 0.35 + 0.65 * Math.abs(Math.sin(anim * 0.02 + h * 50)), s = 1.6 + h * 2.6;
      ctx.save(); ctx.translate(x, y); ctx.rotate(h2 * 1.4);
      tfxAlpha(ctx, ph.alpha * tw); ctx.fillStyle = h < 0.5 ? DUST_HOT : DUST_GOLD;
      ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.25, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.25, 0); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(0, s * 0.25); ctx.lineTo(s, 0); ctx.lineTo(0, -s * 0.25); ctx.closePath(); ctx.fill();
      ctx.restore();
    });
    // props: gifts + bells, sparse, tumbling and falling off the back
    var pi = Math.max(120, fadeMs / PROPS);
    tfxForEachParticle(verts, now, fadeMs, pi + 7, function (v, ts, age) {
      var ph = tfxParticlePhase(age, fadeMs); if (ph.alpha <= 0.03) return;
      var h = tfxHash(ts + 555), h2 = tfxHash(ts + 777);
      var x = v.x + (h2 - 0.5) * WIDTH * 1.2, y = v.y + 36 * ph.drift;
      ctx.save(); ctx.translate(x, y);
      ctx.rotate((h - 0.5) * 1.2 + Math.sin(anim * 0.003 + h * 12) * 0.5 * (0.3 + ph.drift));
      tfxAlpha(ctx, ph.alpha);
      if (h < 0.7) { giftBox(ctx, 6 + h2 * 4, h < 0.25 ? GIFT_RED : (h < 0.5 ? GIFT_GREEN : GIFT_BLUE)); }
      else { bell(ctx, 7 + h2 * 3); }
      ctx.restore();
    });
    headBlob(ctx, verts[n - 1], gold, WIDTH * 0.95, DUST_HOT, Math.max(1.2, WIDTH * 0.1));
    ctx.restore();
  };

  // ======================================================================================
  // E. YULEFIRE BOLD — the committed Yulefire with the dial turned up: pure holly-red body
  // (no player blend — player colour moves to the snowflake tint instead), wider + brighter
  // gold core, evergreen rim, bigger glyphs. For "I like it, it just needs more".
  // ======================================================================================
  TRAIL_FX.xmas_yulefire_bold = function (ctx, verts, color, now, fadeMs, anim) {
    var n = verts.length; if (n < 2) return;
    var WIDTH = TP('xmas_yulefire_bold', 'WIDTH', 26), GLOW = TP('xmas_yulefire_bold', 'GLOW', 30), TAPER = TP('xmas_yulefire_bold', 'TAPER', 0.8);
    var DENSITY = TP('xmas_yulefire_bold', 'DENSITY', 10), GLYPH = TP('xmas_yulefire_bold', 'GLYPH', 12), RISE = TP('xmas_yulefire_bold', 'RISE', 46);
    var fadeEff = fadeMs * TP('xmas_yulefire_bold', 'TAIL_PERSIST', 1.3);
    var red = '#d61a3c';
    var R = ribbonPrep(verts, now, fadeEff, WIDTH, TAPER, function (t) { return 0.82 + 0.18 * Math.sin(anim * 0.012 + t * 0.019); });
    ctx.save(); ctx.lineJoin = 'round';
    tfxGlowPaint(ctx, verts, red, GLOW, WIDTH, null, function (c) {
      c.lineJoin = 'round';
      ribbonFill(c, verts, R, red, 0.7);
      // evergreen rim: thin outline along both edges
      c.strokeStyle = PINE; c.lineWidth = 1.5; c.lineCap = 'round';
      for (var e = -1; e <= 1; e += 2) {
        c.beginPath();
        for (var s = 0; s < R.m; s++) {
          var p = verts[R.idx[s]], x = p.x + R.nx[s] * R.hw[s] * e, y = p.y + R.ny[s] * R.hw[s] * e;
          if (s === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        tfxAlpha(c, 0.6); c.stroke();
      }
      coreStroke(c, verts, R, '#ffd45c', Math.max(1.5, WIDTH * 0.22), 0.95);
      coreStroke(c, verts, R, '#fff4c2', Math.max(1, WIDTH * 0.08), 0.9);
    });
    var interval = Math.max(40, fadeMs / DENSITY);
    tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
      var ph = tfxParticlePhase(age, fadeMs); if (ph.alpha <= 0.03) return;
      var h = tfxHash(ts), h2 = tfxHash(ts + 977);
      var sway = Math.sin(age * 0.0021 + h * TFX_TAU) * 9 * ph.drift;
      var x = v.x + (h2 - 0.5) * WIDTH * 0.9 + sway;
      ctx.save();
      if (h < 0.5) {
        ctx.translate(x, v.y + RISE * 0.6 * ph.drift);
        var ss = GLYPH * (0.55 + h2 * 0.45);
        ctx.rotate(anim * 0.0012 * (h2 < 0.5 ? 1 : -1) + h * TFX_TAU);
        tfxAlpha(ctx, ph.alpha * 0.5); ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, ss * 0.3);
        tfxSnowflakeStroke(ctx, ss);
        tfxAlpha(ctx, ph.alpha); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, ss * 0.13);
        tfxSnowflakeStroke(ctx, ss);
      } else if (h < 0.78) {
        ctx.translate(x, v.y - RISE * 0.5 * ph.drift);
        var cs2 = GLYPH * (1.3 + h2 * 0.7);
        ctx.rotate((h - 0.64) * 2.4 + Math.sin(anim * 0.004 + h * 20) * 0.35);
        ctx.lineCap = 'round'; tfxAlpha(ctx, ph.alpha);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2.6, cs2 * 0.28);
        tfxCandyCanePath(ctx, cs2); ctx.stroke();
        ctx.strokeStyle = '#e8192c'; ctx.setLineDash([cs2 * 0.2, cs2 * 0.2]);
        tfxCandyCanePath(ctx, cs2); ctx.stroke(); ctx.setLineDash([]);
      } else {
        ctx.translate(x, v.y - RISE * ph.drift);
        var twinkle = 0.55 + 0.45 * Math.sin(anim * 0.02 + h * 31.0), sr = GLYPH * 0.42 * (0.7 + h2 * 0.6);
        ctx.rotate(h2 * TFX_TAU);
        tfxAlpha(ctx, ph.alpha * twinkle); ctx.fillStyle = '#ffd45c';
        tfxStarPath(ctx, Math.max(1.5, sr)); ctx.fill();
      }
      ctx.restore();
    });
    headBlob(ctx, verts[n - 1], red, WIDTH * 0.95, '#ffd45c', Math.max(1.5, WIDTH * 0.12));
    ctx.restore();
  };
})();
