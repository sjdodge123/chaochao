/* ============================================================================
 * chaochao — TRAIL EFFECT RENDERERS  (PORT-READY — approved 2026-05-30)
 * ----------------------------------------------------------------------------
 * Output of the trails asset-design session (docs/asset-prototypes/trails.html).
 * These are the finished per-effect renderers for the main session to wire into
 * the trail-effect switch in client/scripts/draw.js (drawTrail, ~line 3211).
 *
 * THE COLOR RULE (locked): a trail is ALWAYS rendered in the player's color.
 * What an equipped trail changes is the EFFECT/shape, never the color. Every
 * function below takes `color` (= player.color) and renders entirely in it; the
 * only non-color pixels are small white "hot-core"/specular highlights, exactly
 * like the existing kart-skin specular dots.
 *
 * CONTRACT (call one per frame, per kart, in place of the basic stroke):
 *
 *     drawSparkleTrail(ctx, verts, color, now, fadeMs, anim)
 *
 *   ctx     — the canvas context (gameContext in draw.js).
 *   verts   — player.trail.vertices: [{x,y,t}], NEWEST LAST. t is a Date.now()
 *             ms timestamp. A vertex is dropped once (now - t) > fadeMs. These
 *             are world coords AFTER the camera offset has been applied by the
 *             caller (drawTrail already strokes raw verts.x/​.y), so pass them
 *             through unchanged — do NOT add camera offset again.
 *   color   — player.color (CSS string).
 *   now     — Date.now() (drawTrail already computes this).
 *   fadeMs  — TRAIL_FADE_MS (drawTrail already resolves this).
 *   anim    — a rolling clock in MILLISECONDS. Pass `cartSkinAnimTime * 1000`
 *             (cartSkinAnimTime is the seconds accumulator in draw.js). Do NOT
 *             pass the speed-scaled skin-painter `anim` — trails shouldn't speed
 *             up their shimmer. now/.t and anim are independent on purpose.
 *
 * Particle effects derive ALL jitter deterministically from the vertex
 * timestamp (tfxHash(v.t + salt)) — never Math.random per frame — so particles
 * are stable frame-to-frame, matching how the real buffer carries a fixed .t.
 *
 * PERF (already validated): glow (shadowBlur) is the dominant cost and is gated
 * behind tfxGlow() → perfGlow(), the same flag draw.js uses elsewhere. Radial
 * gradients are cached per-color (one unit gradient positioned by transform).
 * Comet/Aurora bound their per-segment work with a stride. With glow off these
 * run at vsync; 18 simultaneous distinct effects (more than a real ≤16 room)
 * stayed comfortable.
 *
 * NON-LOCAL DIMMING: draw.js draws other players' trails fainter
 * (NONLOCAL_TRAIL_ALPHA). Each function routes alpha through tfxAlpha(ctx, a),
 * which multiplies by the module-level tfxBaseAlpha. The integrator sets that
 * once before each call (see the wiring example at the bottom); default 1.
 * ============================================================================ */

var TFX_TAU = 6.2831853;
var TFX_BUCKETS = 6;            // mirrors draw.js TRAIL_DRAW_BUCKETS
var tfxBaseAlpha = 1;           // set by drawTrail per kart (1 local, dim non-local)

// perfGlow() if present (draw.js), else assume on (e.g. headless tests)
function tfxGlow() { return (typeof perfGlow === "function") ? perfGlow() : true; }
// every alpha goes through here so non-local trails dim uniformly
function tfxAlpha(ctx, a) { ctx.globalAlpha = a * tfxBaseAlpha; }

// Shared dispatch for "static-context" trail renders (overview standings, recap montage,
// lobby skin-cell preview). Each caller builds its own timestamped vert path (a straight
// score line, a real recorded track, an arced cell preview) then hands it here. Resolves
// the effect, sets the module-level tfxBaseAlpha, and invokes the TRAIL_FX renderer in a
// guarded block so one bad effect can't break the surrounding screen. Returns true if an
// effect was drawn, false if the caller should fall back to its plain stroke.
//   effectId  — a skin trail id (run through getTrailEffect) OR an already-resolved key.
//   verts     — [{x,y,t}] newest-last, in the caller's current transform.
//   opts      — {fadeMs, anim, baseAlpha} all optional.
function paintTrailFx(ctx, effectId, verts, color, opts) {
    if (ctx == null || verts == null || verts.length < 2) { return false; }
    if (typeof TRAIL_FX === "undefined") { return false; }
    var key = effectId;
    if (typeof getTrailEffect === "function" && effectId) {
        var resolved = getTrailEffect(effectId);
        if (resolved && TRAIL_FX[resolved]) { key = resolved; }
    }
    var fx = key ? TRAIL_FX[key] : null;
    if (fx == null) { return false; }
    opts = opts || {};
    var fadeMs = (opts.fadeMs != null) ? opts.fadeMs
        : ((typeof TRAIL_FADE_MS !== "undefined") ? TRAIL_FADE_MS : 1700);
    // `now` is the clock the effect reads vertex ages against. Defaults to wall-clock,
    // but the recap montage drives its own playback timeline (frameT), so it overrides.
    var now = (opts.now != null) ? opts.now : Date.now();
    var anim = (opts.anim != null) ? opts.anim
        : ((typeof cartSkinAnimTime !== "undefined") ? cartSkinAnimTime * 1000 : now);
    var prevBase = tfxBaseAlpha;
    tfxBaseAlpha = (opts.baseAlpha != null) ? opts.baseAlpha : 1;
    try { fx(ctx, verts, color, now, fadeMs, anim); } catch (e) { /* effect glitch — caller already drew its base */ }
    tfxBaseAlpha = prevBase; // restore so we don't leak a dim/forced value to later draws
    return true;
}
// Per-effect tuning param: returns the baked default in-game (window.TFX_PARAMS undefined),
// or a live-tuned value in the trails-review prototype (which sets window.TFX_PARAMS[effect]).
function TP(effect, key, def) {
  var P = (typeof window !== "undefined") ? window.TFX_PARAMS : null;
  return (P && P[effect] && P[effect][key] != null) ? P[effect][key] : def;
}

// ---- color helpers (parse any CSS color → rgb once, cached) ----------------
// Parse hex/rgb()/hsl() in pure JS. The old "paint one pixel and read it back"
// trick forced a synchronous GPU pipeline flush per getImageData — every NEW
// colour (each 🎲 randomize picks one) stalled the frame several ms per painter,
// which stacked into a visible hitch with multiple couch-co-op panels open.
function tfxParseColorFast(color) {
  if (typeof color !== "string") return null;
  var s = color.trim(), m;
  if (s.charAt(0) === "#") {
    if (s.length === 4 || s.length === 5) { // #rgb / #rgba
      var r3 = parseInt(s.charAt(1) + s.charAt(1), 16), g3 = parseInt(s.charAt(2) + s.charAt(2), 16), b3 = parseInt(s.charAt(3) + s.charAt(3), 16);
      return (r3 >= 0 && g3 >= 0 && b3 >= 0) ? { r: r3, g: g3, b: b3 } : null;
    }
    if (s.length === 7 || s.length === 9) { // #rrggbb / #rrggbbaa
      var n = parseInt(s.slice(1, 7), 16);
      return isNaN(n) ? null : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
  if (m) { return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) }; }
  m = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/.exec(s);
  if (m) {
    var h = (((+m[1]) % 360) + 360) % 360 / 360, sl = (+m[2]) / 100, l = (+m[3]) / 100;
    var q = l < 0.5 ? l * (1 + sl) : l + sl - l * sl, p = 2 * l - q;
    var hue = function (t) {
      t = ((t % 1) + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: Math.round(hue(h + 1 / 3) * 255), g: Math.round(hue(h) * 255), b: Math.round(hue(h - 1 / 3) * 255) };
  }
  return null;
}
var _tfxRGB = {};
var _tfxParseCv = null; // shared fallback canvas for exotic colours (named etc.) — created once
function tfxRGB(color) {
  if (_tfxRGB[color] != null) return _tfxRGB[color];
  var rgb = tfxParseColorFast(color);
  if (rgb == null) { // exotic colour string: one readback on a persistent canvas
    if (_tfxParseCv == null) {
      _tfxParseCv = document.createElement("canvas"); _tfxParseCv.width = _tfxParseCv.height = 1;
    }
    var cx = _tfxParseCv.getContext("2d", { willReadFrequently: true });
    cx.fillStyle = "#000"; cx.fillStyle = color; cx.fillRect(0, 0, 1, 1);
    var d = cx.getImageData(0, 0, 1, 1).data;
    rgb = { r: d[0], g: d[1], b: d[2] };
  }
  _tfxRGB[color] = rgb; return rgb;
}
// tfxRGBA/tfxHot/tfxDark build an rgba STRING from (color, t, a). They're called per-particle
// with constant args inside the renderers' hot loops, so allocating a fresh string every call
// churned the GC (the trail "lag spike"). Memoize each result on the per-colour RGB object
// (already cached) under a NUMERIC composite key — after warm-up they return the cached string
// with zero allocation, and the lookup key never allocates either.
function _tfxKey(t, a) { return (((t * 1000) | 0) * 100000) + (((a == null ? 1 : a) * 1000) | 0); }
function tfxRGBA(color, a) {
  var c = tfxRGB(color);
  var cache = c._rgba || (c._rgba = {});
  var k = ((a == null ? 1 : a) * 1000) | 0;
  var s = cache[k]; if (s != null) return s;
  s = "rgba(" + c.r + "," + c.g + "," + c.b + "," + a + ")";
  cache[k] = s; return s;
}
// mix toward WHITE by t (hot cores / specular highlights)
function tfxHot(color, t, a) {
  var c = tfxRGB(color);
  var cache = c._hot || (c._hot = {});
  var k = _tfxKey(t, a);
  var s = cache[k]; if (s != null) return s;
  s = "rgba(" + Math.round(c.r + (255 - c.r) * t) + "," +
    Math.round(c.g + (255 - c.g) * t) + "," +
    Math.round(c.b + (255 - c.b) * t) + "," + (a == null ? 1 : a) + ")";
  cache[k] = s; return s;
}
// mix toward BLACK by t (ribbon back-face shading)
function tfxDark(color, t, a) {
  var c = tfxRGB(color);
  var cache = c._dark || (c._dark = {});
  var k = _tfxKey(t, a);
  var s = cache[k]; if (s != null) return s;
  s = "rgba(" + Math.round(c.r * (1 - t)) + "," + Math.round(c.g * (1 - t)) +
    "," + Math.round(c.b * (1 - t)) + "," + (a == null ? 1 : a) + ")";
  cache[k] = s; return s;
}
// deterministic 0..1 hash from a numeric seed
function tfxHash(seed) {
  var x = Math.sin(seed * 0.0001 * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
function tfxClamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function tfxAgeAlpha(t, now, fadeMs) { return tfxClamp01(1 - (now - t) / fadeMs); }
function tfxTangent(verts, i) {
  var a = verts[Math.max(0, i - 1)], b = verts[Math.min(verts.length - 1, i + 1)];
  var dx = b.x - a.x, dy = b.y - a.y;
  var len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

// ---- STABLE particle sampling (flicker fix) --------------------------------
// Index-striding the vertex buffer (`for i+=floor(n/DENSITY)`) re-selects a
// DIFFERENT subset of vertices every frame as the buffer slides (a vertex is
// pushed at the head and shifted off the tail), so a glyph tied to a vertex
// blinks in and out — the flicker on hearts/notes/etc. Instead we quantise each
// vertex's ABSOLUTE timestamp into fixed `intervalMs` buckets and emit exactly
// one particle per bucket, anchored to the OLDEST vertex in that bucket and
// seeded by the bucket's canonical time. A given particle is therefore drawn at
// the same place with the same jitter on every frame from spawn until it
// expires — no popping. (The oldest vertex of a bucket only changes once it
// ages off the front, by which point that particle has already faded out.)
// cb(v, ts, age, i): v = anchor vertex {x,y,t}, ts = canonical bucket time (use
// as the deterministic hash seed), age = now - ts in ms, i = anchor vertex index
// (for tfxTangent etc.).
function tfxForEachParticle(verts, now, fadeMs, intervalMs, cb) {
  var n = verts.length;
  var lastBucket = null;
  for (var i = 0; i < n; i++) {
    var v = verts[i];
    var bucket = Math.floor(v.t / intervalMs);
    if (bucket === lastBucket) continue;   // one particle per bucket → frame-stable set
    lastBucket = bucket;
    var ts = bucket * intervalMs;
    var age = now - ts; if (age < 0) age = 0;
    if (age >= fadeMs) continue;
    cb(v, ts, age, i);
  }
}

// ---- two-phase trail-particle motion (hug-the-path, THEN drift + fade) ------
// All floating glyph trails used to drift the moment they spawned, so they never
// actually traced the path you walked. tfxParticlePhase splits a particle's life
// into: (1) a HOLD phase where it sits ON the trail vertex at full opacity (after
// a quick fade-in so it doesn't pop), then (2) a DRIFT phase where it floats off
// (up/down, effect's choice) AND fades to nothing. Effects multiply `drift`
// (0→1 across the drift phase) into their rise/fall + sway offsets, and use
// `alpha` directly (peaks at 1, falls to 0). Returns a SHARED scratch object
// (read it immediately; do not retain) to stay allocation-free in the hot loop.
var TFX_HOLD_MS = 1500;         // ms a glyph hugs the walked path before it starts drifting off
var TFX_FADE_IN_MS = 130;       // quick ramp-in so a freshly-spawned glyph doesn't pop on
var _tfxPh = { drift: 0, alpha: 0, prog: 0, life: 0 };
function tfxParticlePhase(age, fadeMs, holdFrac) {
  var life = age / fadeMs;
  _tfxPh.life = life;
  // Default hold is an absolute time (clamped below the fade window so there's always a
  // sliver of drift+fade at the end); callers may still pass an explicit fraction.
  if (holdFrac == null) holdFrac = Math.min(0.98, TFX_HOLD_MS / fadeMs);
  var fadeIn = age < TFX_FADE_IN_MS ? age / TFX_FADE_IN_MS : 1;
  if (life <= holdFrac) {
    _tfxPh.drift = 0; _tfxPh.prog = 0; _tfxPh.alpha = fadeIn;   // anchored on the path
  } else {
    var p = (life - holdFrac) / (1 - holdFrac);                 // 0→1 through the drift phase
    _tfxPh.drift = p; _tfxPh.prog = p; _tfxPh.alpha = fadeIn * (1 - p);
  }
  return _tfxPh;
}

// ---- cached unit gradients (origin, radius 1; positioned via translate+scale) ----
var _tfxBlob = {};   // hot core → transparent (comet head flare, survivor embers)
function tfxBlobGrad(ctx, color) {
  if (_tfxBlob[color]) return _tfxBlob[color];
  var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, tfxHot(color, 0.6, 1));
  g.addColorStop(0.45, tfxRGBA(color, 0.8));
  g.addColorStop(1, tfxRGBA(color, 0));
  _tfxBlob[color] = g; return g;
}
var _tfxHalo = {};   // hollow ring glow (guardian halo)
function tfxHaloGrad(ctx, color) {
  if (_tfxHalo[color]) return _tfxHalo[color];
  var g = ctx.createRadialGradient(0, 0, 0.45, 0, 0, 1);
  g.addColorStop(0, tfxRGBA(color, 0));
  g.addColorStop(0.7, tfxRGBA(color, 0.18));
  g.addColorStop(0.92, tfxRGBA(color, 0.6));
  g.addColorStop(1, tfxRGBA(color, 0));
  _tfxHalo[color] = g; return g;
}
var _tfxPuff = {};   // soft uniform puff, no hot core (smoke)
function tfxPuffGrad(ctx, color) {
  if (_tfxPuff[color]) return _tfxPuff[color];
  var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, tfxRGBA(color, 0.65));
  g.addColorStop(0.6, tfxRGBA(color, 0.28));
  g.addColorStop(1, tfxRGBA(color, 0));
  _tfxPuff[color] = g; return g;
}
// Scratch-glow compositor for the shadowBlur-heavy trail painters. Painting dozens
// of fills/strokes per trail per frame WITH ctx.shadowBlur set renders an
// intermediate blurred surface per op — with several wearers on screen that alone
// collapsed High-profile frame rate. Instead: paint the geometry UNSHADOWED into a
// shared scratch sized to the verts' on-screen bbox (device resolution, clamped to
// the viewport), then draw the scratch ONCE onto ctx with the colored shadow. One
// shadowed composite replaces the per-op surfaces; the halo follows the union
// silhouette, which reads the same. The viewport clamp also stops fully off-screen
// trails from painting at all. Only called on glow profiles (tfxGlow()); the
// no-glow path keeps painting straight to the main canvas.
var _tfxGlowScratch = null;
var _tfxGlowScratch2 = null; // small intermediate for the downsampled-glow path (glowScale < 1)
function tfxGlowBlit(ctx, verts, color, glowR, margin, composite, body) {
  // Geometry bbox in the CALLER's coordinate space (+margin for overhang like
  // ribbon half-widths / ember rise). The shadow is applied at blit time on the
  // main canvas and bleeds outside the image freely, so it needs no scratch pad.
  var n = verts.length;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < n; i++) {
    var v = verts[i];
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;
  // Map the bbox through the caller's CURRENT transform (board scale, world zoom,
  // screen shake, or a preview's translate/scale all compose here) into device
  // space, where the scratch renders 1:1 — so this works under ANY transform.
  var t = ctx.getTransform();
  var xs = [], ys = [];
  var corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]];
  for (var ci = 0; ci < 4; ci++) {
    xs.push(t.a * corners[ci][0] + t.c * corners[ci][1] + t.e);
    ys.push(t.b * corners[ci][0] + t.d * corners[ci][1] + t.f);
  }
  var dMinX = Math.floor(Math.min.apply(null, xs)), dMaxX = Math.ceil(Math.max.apply(null, xs));
  var dMinY = Math.floor(Math.min.apply(null, ys)), dMaxY = Math.ceil(Math.max.apply(null, ys));
  // Clamp to the real canvas (+glow bleed) — off-screen geometry can't show, and
  // the clamp bounds the scratch (and its per-frame texture upload) to canvas size.
  var bleed = glowR + 4;
  if (dMinX < -bleed) dMinX = -bleed;
  if (dMinY < -bleed) dMinY = -bleed;
  if (dMaxX > ctx.canvas.width + bleed) dMaxX = ctx.canvas.width + bleed;
  if (dMaxY > ctx.canvas.height + bleed) dMaxY = ctx.canvas.height + bleed;
  var w = dMaxX - dMinX, h = dMaxY - dMinY;
  if (w < 1 || h < 1) return;
  // Glow resolution (perf knob). The gaussian shadowBlur at blit time runs over the
  // DESTINATION-sized rect, so at full res a long trail costs a near-screen-sized
  // blur per blit — ×9 wearers ×(1-2 blits each) that is the fill-rate collapse the
  // 2026-06-04 device sweep measured on phone-class GPUs (founders_flare/aurora
  // ~27 FPS on Balanced). gs < 1 renders the body at gs scale, runs the blur over a
  // small intermediate (gs² of the pixels), then does ONE plain smoothed upscale —
  // the halo is soft by nature so the upscale doesn't read. gs === 1 keeps the
  // original single-blit path bit-for-bit (HIGH's no-op promise).
  var gs = (typeof perfGlowScale === "function") ? perfGlowScale() : 1;
  var w1 = (gs < 1) ? Math.max(1, Math.ceil(w * gs)) : w;
  var h1 = (gs < 1) ? Math.max(1, Math.ceil(h * gs)) : h;
  if (_tfxGlowScratch == null) { _tfxGlowScratch = document.createElement("canvas"); }
  var s = _tfxGlowScratch;
  if (s.width < w1) { s.width = w1; }
  if (s.height < h1) { s.height = h1; }
  var sc = s.getContext("2d");
  // The scratch CONTEXT is shared across effects and frames, so isolate each use:
  // a body that flips composite mode (aurora's 'lighter') must not leak it into the
  // next effect's scratch render. save/restore plus explicit defaults — the canvas
  // is grow-only, so a resize reset can't be relied on.
  sc.save();
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.clearRect(0, 0, w1, h1);
  sc.globalCompositeOperation = "source-over";
  sc.globalAlpha = 1;
  sc.shadowBlur = 0;
  if ("filter" in sc) { sc.filter = "none"; }
  sc.setLineDash([]);
  // Caller's full transform (scaled by the glow resolution), shifted so the device
  // bbox lands at the scratch origin.
  sc.setTransform(t.a * gs, t.b * gs, t.c * gs, t.d * gs, (t.e - dMinX) * gs, (t.f - dMinY) * gs);
  body(sc);
  sc.restore();
  if (gs >= 1) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);   // blit 1:1 in device space
    ctx.globalAlpha = 1;                  // body alphas are baked into the scratch
    ctx.shadowColor = color;
    ctx.shadowBlur = glowR;               // shadowBlur ignores the CTM, same as per-op
    if (composite) { ctx.globalCompositeOperation = composite; }
    ctx.drawImage(s, 0, 0, w, h, dMinX, dMinY, w, h);
    ctx.restore();
    return;
  }
  // Downsampled path: shadow-composite body+halo into a small second scratch (the
  // blur runs HERE, over gs² of the pixels), then ONE plain upscale to the canvas.
  var pad = Math.ceil(glowR * gs) + 4;    // room for the halo bleed at scratch scale
  var w2 = w1 + pad * 2, h2 = h1 + pad * 2;
  if (_tfxGlowScratch2 == null) { _tfxGlowScratch2 = document.createElement("canvas"); }
  var s2 = _tfxGlowScratch2;
  if (s2.width < w2) { s2.width = w2; }
  if (s2.height < h2) { s2.height = h2; }
  var sc2 = s2.getContext("2d");
  sc2.save();                             // same shared-context isolation as above
  sc2.setTransform(1, 0, 0, 1, 0, 0);
  sc2.clearRect(0, 0, w2, h2);
  sc2.globalCompositeOperation = "source-over";
  sc2.globalAlpha = 1;
  if ("filter" in sc2) { sc2.filter = "none"; }
  sc2.shadowColor = color;
  sc2.shadowBlur = glowR * gs;            // halo radius in scratch units = glowR on screen
  sc2.drawImage(s, 0, 0, w1, h1, pad, pad, w1, h1);
  sc2.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (composite) { ctx.globalCompositeOperation = composite; }
  // Map the padded scratch back to device space (pad/gs of halo bleed each side).
  ctx.drawImage(s2, 0, 0, w2, h2, dMinX - pad / gs, dMinY - pad / gs, w2 / gs, h2 / gs);
  ctx.restore();
}
// Glow dispatch shared by the heavy painters: no glow -> draw straight to ctx;
// glow -> scratch + single shadowed blit (transform-aware). The per-op shadow
// fallback only remains for ancient contexts without getTransform().
function tfxGlowPaint(ctx, verts, color, glowR, margin, composite, body) {
  if (!tfxGlow()) {
    if (composite) { ctx.save(); ctx.globalCompositeOperation = composite; body(ctx); ctx.restore(); }
    else { body(ctx); }
    return;
  }
  if (typeof ctx.getTransform === "function") {
    tfxGlowBlit(ctx, verts, color, glowR, margin, composite, body);
    return;
  }
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = glowR;
  if (composite) { ctx.globalCompositeOperation = composite; }
  body(ctx);
  ctx.restore();
}
// unit glyph paths, filled by the caller
function tfxHeartPath(ctx, sz) {
  ctx.beginPath();
  ctx.moveTo(0, sz * 0.35);
  ctx.bezierCurveTo(sz, -sz * 0.3, sz * 0.5, -sz, 0, -sz * 0.25);
  ctx.bezierCurveTo(-sz * 0.5, -sz, -sz, -sz * 0.3, 0, sz * 0.35);
  ctx.closePath();
}
function tfxNoteGlyph(ctx, sz) {
  ctx.beginPath(); ctx.ellipse(0, 0, sz * 0.55, sz * 0.4, -0.4, 0, TFX_TAU); ctx.fill();
  ctx.fillRect(sz * 0.36, -sz * 1.7, sz * 0.16, sz * 1.7);
  ctx.beginPath();
  ctx.moveTo(sz * 0.52, -sz * 1.7);
  ctx.quadraticCurveTo(sz * 1.2, -sz * 1.35, sz * 0.52, -sz * 0.8);
  ctx.quadraticCurveTo(sz * 0.9, -sz * 1.25, sz * 0.52, -sz * 1.35);
  ctx.closePath(); ctx.fill();
}

/* ============================================================================
 * EFFECT RENDERERS  (id → display)
 *   basic→Basic  dashes→Dashes  sparkle→Sparkle  comet→Comet  bubbles→Bubbles
 *   aurora→Aurora  guardian→Guardian  survivor→Survivor
 *   ribbon→Ribbon  bolt→Lightning  hearts→Hearts  smoke→Smoke  confetti→Confetti
 *   snow→Crystals  tracks→Tire Tracks  notes→Music Notes  neon→Neon Wall
 *   ripple→Ripples
 * ============================================================================ */

// basic — solid fading stroke. This equals the EXISTING drawTrail bucketed
// stroke; included only so a 'basic' id can route through the same dispatch. The
// real drawTrail keeps near-victory dashing + dim handling around it.
function drawBasicTrail(ctx, verts, color, now, fadeMs, anim) {
  if (verts.length < 2) return;
  ctx.save();
  ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  var bucketMs = fadeMs / TFX_BUCKETS;
  var segBucket = new Array(verts.length); segBucket[0] = -1;
  for (var i = 1; i < verts.length; i++) {
    var age = now - verts[i].t;
    segBucket[i] = (age >= fadeMs) ? TFX_BUCKETS : Math.floor(age / bucketMs);
  }
  for (var b = 0; b < TFX_BUCKETS; b++) {
    var bucketAlpha = 1 - (b + 0.5) / TFX_BUCKETS;
    if (bucketAlpha <= 0.01) continue;
    tfxAlpha(ctx, bucketAlpha);
    var runStart = -1;
    for (var j = 1; j <= verts.length; j++) {
      var inBucket = (j < verts.length) && (segBucket[j] === b);
      if (inBucket) {
        if (runStart === -1) { runStart = j - 1; ctx.beginPath(); ctx.moveTo(verts[runStart].x, verts[runStart].y); }
        ctx.lineTo(verts[j].x, verts[j].y);
      } else if (runStart !== -1) { ctx.stroke(); runStart = -1; }
    }
  }
  ctx.restore();
}

// dashes (Lv4) — uniform marching dashes (arc-length offset keeps them even).
function drawDashesTrail(ctx, verts, color, now, fadeMs, anim) {
  if (verts.length < 2) return;
  var DASH = TP('dashes','DASH',7), GAP = TP('dashes','GAP',23), WIDTH = TP('dashes','WIDTH',4);
  ctx.save();
  ctx.lineWidth = WIDTH; ctx.lineCap = "butt"; ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.setLineDash([DASH, GAP]);
  var cumLen = new Array(verts.length); cumLen[0] = 0;
  for (var k = 1; k < verts.length; k++)
    cumLen[k] = cumLen[k - 1] + Math.hypot(verts[k].x - verts[k - 1].x, verts[k].y - verts[k - 1].y);
  var bucketMs = fadeMs / TFX_BUCKETS;
  var segBucket = new Array(verts.length); segBucket[0] = -1;
  for (var i = 1; i < verts.length; i++) {
    var age = now - verts[i].t;
    segBucket[i] = (age >= fadeMs) ? TFX_BUCKETS : Math.floor(age / bucketMs);
  }
  for (var b = 0; b < TFX_BUCKETS; b++) {
    var bucketAlpha = 1 - (b + 0.5) / TFX_BUCKETS;
    if (bucketAlpha <= 0.01) continue;
    tfxAlpha(ctx, bucketAlpha);
    var runStart = -1;
    for (var j = 1; j <= verts.length; j++) {
      var inBucket = (j < verts.length) && (segBucket[j] === b);
      if (inBucket) {
        if (runStart === -1) { runStart = j - 1; ctx.lineDashOffset = cumLen[runStart]; ctx.beginPath(); ctx.moveTo(verts[runStart].x, verts[runStart].y); }
        ctx.lineTo(verts[j].x, verts[j].y);
      } else if (runStart !== -1) { ctx.stroke(); runStart = -1; }
    }
  }
  ctx.restore();
}

// sparkle (Lv10) — scattered 4-point stars twinkling in place ON the path.
function drawSparkleTrail(ctx, verts, color, now, fadeMs, anim) {
  if (verts.length < 2) return;
  var DENSITY = TP('sparkle','DENSITY',32), SIZE = TP('sparkle','SIZE',4), TWINKLE = TP('sparkle','TWINKLE',0.75), SPREAD = TP('sparkle','SPREAD',16);
  var interval = Math.max(20, fadeMs / DENSITY);
  ctx.save();
  ctx.lineCap = "round";
  tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age, i) {
    var a0 = tfxClamp01(1 - age / fadeMs);
    if (a0 <= 0.02) return;
    var tan = tfxTangent(verts, i);
    var nx = -tan.y, ny = tan.x;
    for (var s = 0; s < 2; s++) {
      var seed = ts + s * 9301;
      var off = (tfxHash(seed) - 0.5) * 2 * SPREAD;
      var along = (tfxHash(seed + 7) - 0.5) * 6;
      var px = v.x + nx * off + tan.x * along;
      var py = v.y + ny * off + tan.y * along;
      var phase = tfxHash(seed + 3) * TFX_TAU;
      var tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(anim * 0.001 * (4 + TWINKLE * 8) + phase));
      var alpha = a0 * tw;
      if (alpha <= 0.03) continue;
      var sz = SIZE * (0.5 + tfxHash(seed + 5) * 0.8) * (0.4 + 0.6 * tw);
      tfxAlpha(ctx, alpha);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.6, sz * 0.18);
      ctx.beginPath();
      ctx.moveTo(px - sz, py); ctx.lineTo(px + sz, py);
      ctx.moveTo(px, py - sz); ctx.lineTo(px, py + sz);
      ctx.stroke();
      tfxAlpha(ctx, alpha);
      ctx.fillStyle = tfxHot(color, 0.6, 1);
      ctx.beginPath(); ctx.arc(px, py, Math.max(0.6, sz * 0.22), 0, TFX_TAU); ctx.fill();
    }
  });
  ctx.restore();
}

// comet (Lv16) — wide glowing tapered streak; bright head → thin tail.
function drawCometTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length;
  if (n < 2) return;
  var WIDTH = TP('comet','WIDTH',22), GLOW = TP('comet','GLOW',22), TAPER = TP('comet','TAPER',0.8);
  var stride = Math.max(1, Math.floor(n / 50));
  var idx = [];
  for (var i = 0; i < n; i += stride) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  var m = idx.length;
  var hw = new Array(m), nx = new Array(m), ny = new Array(m), af = new Array(m);
  for (var j = 0; j < m; j++) {
    var ii = idx[j];
    var f = tfxAgeAlpha(verts[ii].t, now, fadeMs);
    af[j] = f;
    hw[j] = (WIDTH * 0.5) * Math.pow(f, TAPER);
    var tan = tfxTangent(verts, ii);
    nx[j] = -tan.y; ny[j] = tan.x;
  }
  ctx.save();
  ctx.lineJoin = "round";
  // Ribbon body: ~50 alpha-faded quad fills. Per-op shadowBlur here was the comet's
  // frame killer — route the glow through ONE shadowed scratch blit instead.
  var cometRibbon = function (c) {
    c.lineJoin = "round";
    c.fillStyle = color;
    for (var s = 1; s < m; s++) {
      var alpha = af[s] * 0.5;
      if (alpha <= 0.02) continue;
      var p0 = verts[idx[s - 1]], p1 = verts[idx[s]];
      tfxAlpha(c, alpha);
      c.beginPath();
      c.moveTo(p0.x + nx[s - 1] * hw[s - 1], p0.y + ny[s - 1] * hw[s - 1]);
      c.lineTo(p1.x + nx[s] * hw[s],         p1.y + ny[s] * hw[s]);
      c.lineTo(p1.x - nx[s] * hw[s],         p1.y - ny[s] * hw[s]);
      c.lineTo(p0.x - nx[s - 1] * hw[s - 1], p0.y - ny[s - 1] * hw[s - 1]);
      c.closePath();
      c.fill();
    }
  };
  tfxGlowPaint(ctx, verts, color, GLOW, WIDTH, null, cometRibbon);
  // Core stroke: route its halo through the SAME scratch+blit the body ribbon uses (one
  // shadowed blit, downsampled by perfGlowScale on Balanced/Low) instead of a direct
  // full-res main-canvas gaussian. tfxGlowBlit's gs===1 path is bit-for-bit the old direct
  // shadow on HIGH, and gs<1 keeps the halo SIZE (only the blur resolution drops) — so the
  // core looks identical on every tier, just cheaper. Low (no glow) draws straight, as before.
  var coreStart = -1;
  for (var c = 0; c < m; c++) { if (af[c] > 0.35) { coreStart = c; break; } }
  if (coreStart >= 0 && coreStart < m - 1) {
    var coreBody = function (cx) {
      tfxAlpha(cx, 0.85);
      cx.strokeStyle = tfxHot(color, 0.55, 1);
      cx.lineCap = "round";
      cx.lineWidth = Math.max(0.8, WIDTH * 0.18);
      cx.beginPath();
      cx.moveTo(verts[idx[coreStart]].x, verts[idx[coreStart]].y);
      for (var cc = coreStart + 1; cc < m; cc++) cx.lineTo(verts[idx[cc]].x, verts[idx[cc]].y);
      cx.stroke();
    };
    tfxGlowPaint(ctx, verts, color, GLOW * 0.5, WIDTH, null, coreBody);
  }
  var head = verts[n - 1];
  var R = WIDTH * 0.9;
  tfxAlpha(ctx, 1);
  if (tfxGlow()) ctx.shadowBlur = 0;
  ctx.save();
  ctx.translate(head.x, head.y); ctx.scale(R, R);
  ctx.fillStyle = tfxBlobGrad(ctx, color);
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TFX_TAU); ctx.fill();
  ctx.restore();
  ctx.restore();
}

// bubbles (Lv22) — bubbles cling to the path, then drift up + fade and pop.
function drawBubblesTrail(ctx, verts, color, now, fadeMs, anim) {
  if (verts.length < 2) return;
  var DENSITY = TP('bubbles','DENSITY',15);   // particles along the trail (fewer = lighter)
  var SIZE = TP('bubbles','SIZE',8);      // base bubble radius (px)
  var RISE = TP('bubbles','RISE',28);     // total rise during the drift phase (px)
  var PEAK = TP('bubbles','PEAK',0.7);   // max opacity (lower = subtler)
  var interval = Math.max(20, fadeMs / DENSITY);
  ctx.save();
  ctx.lineWidth = 1.2;
  // Constant colours/styles hoisted out of the per-bubble loop (only globalAlpha varies).
  ctx.strokeStyle = color;
  ctx.fillStyle = tfxHot(color, 0.75, 1);
  tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
    var ph = tfxParticlePhase(age, fadeMs);
    for (var k = 0; k < 2; k++) {
      var seed = ts + k * 6151;
      var rise = RISE * ph.drift * (0.6 + tfxHash(seed + 2) * 0.7);
      var drift = Math.sin(ph.life * 5 + tfxHash(seed) * TFX_TAU) * 4 * ph.drift; // gentle wobble as it rises
      var px = v.x + drift + (tfxHash(seed + 1) - 0.5) * 8;
      var py = v.y - rise;
      var r = SIZE * (0.45 + tfxHash(seed + 4) * 0.7);             // ~ up to 5.7px
      var alpha = ph.alpha * PEAK * (0.55 + 0.45 * tfxHash(seed + 6));
      if (alpha <= 0.03) continue;
      tfxAlpha(ctx, alpha);
      ctx.beginPath(); ctx.arc(px, py, r, 0, TFX_TAU); ctx.stroke();
      tfxAlpha(ctx, alpha * 0.85);
      ctx.beginPath(); ctx.arc(px - r * 0.35, py - r * 0.35, Math.max(0.5, r * 0.22), 0, TFX_TAU); ctx.fill();
    }
  });
  ctx.restore();
}

// aurora (Lv28) — soft SINGLE waving band (concentric layers, same phase).
function drawAuroraTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length;
  if (n < 2) return;
  var AMP = TP('aurora','AMP',7), FREQ = TP('aurora','FREQ',32), GLOW = TP('aurora','GLOW',27), SOFT = TP('aurora','SOFT',2);
  var layers = Math.max(1, Math.round(SOFT));
  // Stride the STROKE geometry to ~50 samples (the soft 7px wave is heavily oversampled,
  // so the ~dozen bucketed strokes ran over the full buffer for no visible gain). The wave
  // PHASE still accumulates the true per-vertex arc length (cum over ALL n, then sampled at
  // the strided vertices via cum[vi]) so the wave-along-path is unchanged vs origin/main —
  // accumulating chord lengths between strided samples instead would shift the phase.
  var stride = Math.max(1, Math.floor(n / 50));
  var idx = [];
  for (var si = 0; si < n; si += stride) idx.push(si);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  var m = idx.length;
  var cum = new Array(n); cum[0] = 0;
  for (var k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(verts[k].x - verts[k - 1].x, verts[k].y - verts[k - 1].y);
  var bucketMs = fadeMs / TFX_BUCKETS;
  var wx = new Array(m), wy = new Array(m), bk = new Array(m);
  for (var i = 0; i < m; i++) {
    var vi = idx[i];
    var w = AMP * Math.sin(cum[vi] * (FREQ * 0.01) - anim * 0.003);
    var tn = tfxTangent(verts, vi);
    wx[i] = verts[vi].x - tn.y * w;
    wy[i] = verts[vi].y + tn.x * w;
    var age = now - verts[vi].t;
    bk[i] = (age >= fadeMs) ? TFX_BUCKETS : Math.floor(age / bucketMs);
  }
  ctx.save();
  // All the wavy layer strokes, additive between themselves. Per-stroke shadowBlur
  // (GLOW 27, ~a dozen long strokes) was the cost — paint them unshadowed and let
  // tfxGlowBlit add the glow on the single 'lighter' composite, which keeps the
  // additive-vs-background look.
  var auroraBody = function (c) {
    c.globalCompositeOperation = "lighter";
    c.lineCap = "round"; c.lineJoin = "round";
    for (var L = 0; L < layers; L++) {
      var inner = layers > 1 ? L / (layers - 1) : 1;
      c.lineWidth = (5 + AMP * 0.55) * (1 - inner * 0.72);
      c.strokeStyle = (L === layers - 1) ? tfxHot(color, 0.35, 1) : color;
      var layerA = 0.12 + 0.20 * inner;
      for (var b = 0; b < TFX_BUCKETS; b++) {
        tfxAlpha(c, layerA * (1 - (b + 0.5) / TFX_BUCKETS));
        var run = false;
        for (var vv = 1; vv < m; vv++) {
          if (bk[vv] !== b) { if (run) { c.stroke(); run = false; } continue; }
          if (!run) { c.beginPath(); c.moveTo(wx[vv - 1], wy[vv - 1]); run = true; }
          c.lineTo(wx[vv], wy[vv]);
        }
        if (run) c.stroke();
      }
    }
  };
  tfxGlowPaint(ctx, verts, color, GLOW, AMP + 12, "lighter", auroraBody);
  ctx.restore();
}

// guardian (achievement) — pulsing halo + counter-rotating shield arcs + orbit dots.
function drawGuardianTrail(ctx, verts, color, now, fadeMs, anim) {
  if (verts.length < 2) return;
  var RADIUS = TP('guardian','RADIUS',20), PULSE = TP('guardian','PULSE',0.9), DOTS = TP('guardian','DOTS',3);
  var head = verts[verts.length - 1];
  ctx.save();
  ctx.lineCap = "round"; ctx.lineWidth = 3; ctx.strokeStyle = color;
  var bucketMs = fadeMs / TFX_BUCKETS;
  for (var b = 0; b < TFX_BUCKETS; b++) {
    tfxAlpha(ctx, (1 - (b + 0.5) / TFX_BUCKETS) * 0.35);
    var run = false;
    for (var i = 1; i < verts.length; i++) {
      var age = now - verts[i].t;
      var seg = (age >= fadeMs) ? TFX_BUCKETS : Math.floor(age / bucketMs);
      if (seg !== b) { if (run) { ctx.stroke(); run = false; } continue; }
      if (!run) { ctx.beginPath(); ctx.moveTo(verts[i - 1].x, verts[i - 1].y); run = true; }
      ctx.lineTo(verts[i].x, verts[i].y);
    }
    if (run) ctx.stroke();
  }
  var pulse = 0.5 + 0.5 * Math.sin(anim * 0.001 * (2 + PULSE * 5));
  var R = RADIUS * (0.85 + 0.15 * pulse);
  tfxAlpha(ctx, 0.6 + 0.4 * pulse);
  ctx.save();
  ctx.translate(head.x, head.y); ctx.scale(R, R);
  ctx.fillStyle = tfxHaloGrad(ctx, color);
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TFX_TAU); ctx.fill();
  ctx.restore();
  ctx.lineCap = "round";
  ctx.strokeStyle = tfxHot(color, 0.25, 1);
  if (tfxGlow()) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
  for (var s = 0; s < 2; s++) {
    var dir = s === 0 ? 1 : -1;
    var rot = anim * 0.001 * dir * 1.4;
    tfxAlpha(ctx, 0.55 + 0.25 * pulse);
    ctx.lineWidth = 2.5;
    var ar = R * (0.78 + s * 0.12);
    ctx.beginPath(); ctx.arc(head.x, head.y, ar, rot, rot + 1.7); ctx.stroke();
    ctx.beginPath(); ctx.arc(head.x, head.y, ar, rot + Math.PI, rot + Math.PI + 1.7); ctx.stroke();
  }
  var dots = Math.round(DOTS);
  if (tfxGlow()) ctx.shadowBlur = 6;
  for (var d = 0; d < dots; d++) {
    var ang = anim * 0.001 * 1.1 + (d / dots) * TFX_TAU;
    var dx = head.x + Math.cos(ang) * R * 0.95;
    var dy = head.y + Math.sin(ang) * R * 0.95;
    tfxAlpha(ctx, 0.65 + 0.3 * pulse);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(dx, dy, 2.6, 0, TFX_TAU); ctx.fill();
    ctx.fillStyle = tfxHot(color, 0.7, 1);
    ctx.beginPath(); ctx.arc(dx, dy, 1.1, 0, TFX_TAU); ctx.fill();
  }
  ctx.restore();
}

// survivor (achievement) — embers smoulder on the path, then rise, flicker + fade.
function drawSurvivorTrail(ctx, verts, color, now, fadeMs, anim) {
  if (verts.length < 2) return;
  var DENSITY = TP('survivor','DENSITY',20), SIZE = TP('survivor','SIZE',4), FLICK = TP('survivor','FLICK',0.1), RISE = TP('survivor','RISE',60);
  var interval = Math.max(20, fadeMs / DENSITY);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
    var ph = tfxParticlePhase(age, fadeMs);   // shared 1500ms hug like the other floaters
    for (var k = 0; k < 2; k++) {
      var seed = ts + k * 7193;
      var sway = Math.sin(age * 0.003 + tfxHash(seed + 1) * TFX_TAU) * 10 * ph.drift;
      var px = v.x + sway + (tfxHash(seed + 2) - 0.5) * 8;
      var py = v.y - RISE * ph.drift;
      var flick = 0.55 + 0.45 * Math.sin(anim * 0.001 * (6 + FLICK * 10) + tfxHash(seed + 3) * TFX_TAU);
      var alpha = ph.alpha * (0.4 + 0.6 * flick);
      if (alpha <= 0.03) continue;
      var r = SIZE * (0.5 + tfxHash(seed + 4) * 0.9) * (0.6 + 0.4 * flick);
      tfxAlpha(ctx, alpha);
      ctx.save();
      ctx.translate(px, py); ctx.scale(r, r);
      ctx.fillStyle = tfxBlobGrad(ctx, color);
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, TFX_TAU); ctx.fill();
      ctx.restore();
    }
  });
  ctx.restore();
}

// ribbon — flat banner that twists (back face shades darker).
function drawRibbonTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var WIDTH = TP('ribbon','WIDTH',13), TWIST = TP('ribbon','TWIST',8);
  var stride = Math.max(1, Math.floor(n / 60));
  var idx = []; for (var i = 0; i < n; i += stride) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  var m = idx.length;
  var cum = new Array(n); cum[0] = 0;
  for (var k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(verts[k].x - verts[k - 1].x, verts[k].y - verts[k - 1].y);
  ctx.save(); ctx.lineJoin = "round";
  var hw = WIDTH * 0.5;
  for (var s = 1; s < m; s++) {
    var i0 = idx[s - 1], i1 = idx[s];
    var f = tfxAgeAlpha(verts[i1].t, now, fadeMs); if (f <= 0.02) continue;
    var c0 = Math.cos(cum[i0] * (TWIST * 0.01) - anim * 0.004);
    var c1 = Math.cos(cum[i1] * (TWIST * 0.01) - anim * 0.004);
    var t0 = tfxTangent(verts, i0), t1 = tfxTangent(verts, i1);
    var p0 = verts[i0], p1 = verts[i1];
    var w0 = hw * Math.abs(c0) + 0.6, w1 = hw * Math.abs(c1) + 0.6;
    tfxAlpha(ctx, f * 0.9);
    ctx.fillStyle = (c0 + c1) < 0 ? tfxDark(color, 0.5, 1) : color;
    ctx.beginPath();
    ctx.moveTo(p0.x - t0.y * w0, p0.y + t0.x * w0);
    ctx.lineTo(p1.x - t1.y * w1, p1.y + t1.x * w1);
    ctx.lineTo(p1.x + t1.y * w1, p1.y - t1.x * w1);
    ctx.lineTo(p0.x + t0.y * w0, p0.y - t0.x * w0);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// bolt — jagged electric arc, re-randomizes each flicker quantum, with forks.
function drawBoltTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var AMP = TP('bolt','AMP',10), GLOW = TP('bolt','GLOW',12), FORKS = TP('bolt','FORKS',2);
  var fstep = Math.floor(anim / 55);
  var stride = Math.max(1, Math.floor(n / 40));
  var idx = []; for (var i = 0; i < n; i += stride) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  var m = idx.length;
  var px = new Array(m), py = new Array(m), af = new Array(m);
  for (var j = 0; j < m; j++) {
    var ii = idx[j]; af[j] = tfxAgeAlpha(verts[ii].t, now, fadeMs);
    var t = tfxTangent(verts, ii);
    var endpoint = (j === 0 || j === m - 1) ? 0.15 : 1;
    var jit = (tfxHash(verts[ii].t + fstep * 131 + j * 977) - 0.5) * 2 * AMP * endpoint;
    px[j] = verts[ii].x - t.y * jit; py[j] = verts[ii].y + t.x * jit;
  }
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  // Soft outer bolt: one polyline stroke, so a direct shadow stays cheap.
  if (tfxGlow()) { ctx.shadowColor = color; ctx.shadowBlur = GLOW; }
  ctx.strokeStyle = tfxRGBA(color, 0.5); ctx.lineWidth = 4; tfxAlpha(ctx, 0.55);
  ctx.beginPath(); ctx.moveTo(px[0], py[0]);
  for (var s = 1; s < m; s++) ctx.lineTo(px[s], py[s]);
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Hot core + forks: ~40 tiny per-segment strokes; per-op shadow here was the
  // bolt's frame cost — glow them via one scratch blit instead.
  var boltCore = function (c2) {
    c2.lineCap = "round"; c2.lineJoin = "round";
    c2.strokeStyle = tfxHot(color, 0.65, 1); c2.lineWidth = 1.6;
    for (var c = 1; c < m; c++) {
      if (af[c] <= 0.04) continue;
      tfxAlpha(c2, af[c]);
      c2.beginPath(); c2.moveTo(px[c - 1], py[c - 1]); c2.lineTo(px[c], py[c]); c2.stroke();
    }
    var forks = Math.round(FORKS);
    if (forks > 0) {
      c2.lineWidth = 1.1; c2.strokeStyle = tfxRGBA(color, 0.8);
      var gap = Math.max(2, Math.floor(m / (forks * 2 + 1)));
      for (var s2 = 2; s2 < m - 1; s2 += gap) {
        if (af[s2] < 0.3) continue;
        var t2 = tfxTangent(verts, idx[s2]);
        var dir = (tfxHash(verts[idx[s2]].t + fstep * 51) < 0.5) ? 1 : -1;
        var fl = 8 + tfxHash(verts[idx[s2]].t + fstep) * 12;
        tfxAlpha(c2, af[s2] * 0.7);
        c2.beginPath(); c2.moveTo(px[s2], py[s2]);
        c2.lineTo(px[s2] - t2.y * fl * dir + t2.x * fl * 0.4, py[s2] + t2.x * fl * dir + t2.y * fl * 0.4);
        c2.stroke();
      }
    }
  };
  tfxGlowPaint(ctx, verts, color, GLOW * 0.5, AMP + 24, null, boltCore);
  ctx.restore();
}

// hearts — hearts ride the path you walked, then float up + fade once aged.
function drawHeartsTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var DENSITY = TP('hearts','DENSITY',15), SIZE = TP('hearts','SIZE',8.5), RISE = TP('hearts','RISE',46);
  var interval = Math.max(20, fadeMs / DENSITY);
  ctx.save();
  tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
    var ph = tfxParticlePhase(age, fadeMs);
    var alpha = ph.alpha; if (alpha <= 0.03) return;
    var seed = ts;
    var sway = Math.sin(age * 0.002 + tfxHash(seed + 1) * TFX_TAU) * 10 * ph.drift;
    var x = v.x + sway + (tfxHash(seed + 2) - 0.5) * 6;
    var y = v.y - RISE * ph.drift;
    var sz = SIZE * (0.6 + tfxHash(seed + 3) * 0.7);
    var rot = Math.sin(age * 0.002 + tfxHash(seed + 4) * TFX_TAU) * 0.4 * (0.3 + 0.7 * ph.drift);
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); tfxAlpha(ctx, alpha);
    ctx.fillStyle = color; tfxHeartPath(ctx, sz); ctx.fill();
    tfxAlpha(ctx, alpha * 0.8); ctx.fillStyle = tfxHot(color, 0.6, 1);
    ctx.beginPath(); ctx.arc(-sz * 0.22, -sz * 0.32, sz * 0.14, 0, TFX_TAU); ctx.fill();
    ctx.restore();
  });
  ctx.restore();
}

// smoke — soft puffs settle on the path, then billow up + fade as they age.
function drawSmokeTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var DENSITY = TP('smoke','DENSITY',21), SIZE = TP('smoke','SIZE',14), RISE = TP('smoke','RISE',50);
  var interval = Math.max(20, fadeMs / DENSITY);
  ctx.save();
  tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
    var ph = tfxParticlePhase(age, fadeMs);
    for (var k = 0; k < 2; k++) {
      var seed = ts + k * 5333;
      var drift = Math.sin(age * 0.0015 + tfxHash(seed + 1) * TFX_TAU) * 12 * ph.drift;
      var x = v.x + drift + (tfxHash(seed + 2) - 0.5) * 10;
      var y = v.y - RISE * ph.drift;
      var r = SIZE * (0.4 + ph.life * 1.7) * (0.6 + tfxHash(seed + 3) * 0.6);
      var alpha = ph.alpha * 0.35 * (0.5 + tfxHash(seed + 4) * 0.6);
      if (alpha <= 0.02) continue;
      tfxAlpha(ctx, alpha);
      ctx.save(); ctx.translate(x, y); ctx.scale(r, r);
      ctx.fillStyle = tfxPuffGrad(ctx, color);
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, TFX_TAU); ctx.fill();
      ctx.restore();
    }
  });
  ctx.restore();
}

// confetti — flecks land on the path, then tumble + flutter down and fade.
function drawConfettiTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var DENSITY = TP('confetti','DENSITY',17), SIZE = TP('confetti','SIZE',3), SPIN = TP('confetti','SPIN',10), FALL = TP('confetti','FALL',34);
  var interval = Math.max(20, fadeMs / DENSITY);
  ctx.save();
  tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
    var ph = tfxParticlePhase(age, fadeMs);
    var alpha = ph.alpha; if (alpha <= 0.03) return;
    for (var k = 0; k < 2; k++) {
      var seed = ts + k * 8101;
      var sway = Math.sin(age * 0.003 + tfxHash(seed + 1) * TFX_TAU) * 14 * ph.drift;
      var x = v.x + sway + (tfxHash(seed + 2) - 0.5) * 12;
      var y = v.y + FALL * ph.drift;
      var w = SIZE * (0.6 + tfxHash(seed + 3) * 0.8), h = w * 0.5;
      var spin = anim * 0.001 * (SPIN * 0.06) + tfxHash(seed + 4) * TFX_TAU;
      var squash = Math.abs(Math.cos(spin * 2)) * 0.8 + 0.2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(spin); ctx.scale(1, squash);
      tfxAlpha(ctx, alpha);
      ctx.fillStyle = (k % 2 === 0) ? color : tfxHot(color, 0.5, 1);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
  });
  ctx.restore();
}

// snow (Crystals) — crystals rest on the path, then rotate + drift down and fade.
function drawSnowTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var DENSITY = TP('snow','DENSITY',15), SIZE = TP('snow','SIZE',5), SPIN = TP('snow','SPIN',30), FALL = TP('snow','FALL',24);
  var interval = Math.max(20, fadeMs / DENSITY);
  ctx.save(); ctx.lineCap = "round";
  tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
    var ph = tfxParticlePhase(age, fadeMs);
    var alpha = ph.alpha; if (alpha <= 0.03) return;
    var seed = ts;
    var sway = Math.sin(age * 0.0016 + tfxHash(seed + 1) * TFX_TAU) * 12 * ph.drift;
    var x = v.x + sway + (tfxHash(seed + 2) - 0.5) * 8;
    var y = v.y + FALL * ph.drift;
    var sz = SIZE * (0.6 + tfxHash(seed + 3) * 0.6);
    var rot = anim * 0.001 * (SPIN * 0.04) * (tfxHash(seed + 4) < 0.5 ? 1 : -1) + tfxHash(seed + 5) * TFX_TAU;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); tfxAlpha(ctx, alpha);
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.8, sz * 0.12);
    for (var a = 0; a < 3; a++) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(-sz, 0); ctx.lineTo(sz, 0);
      ctx.moveTo(sz * 0.55, 0); ctx.lineTo(sz * 0.4, sz * 0.18);
      ctx.moveTo(sz * 0.55, 0); ctx.lineTo(sz * 0.4, -sz * 0.18);
      ctx.moveTo(-sz * 0.55, 0); ctx.lineTo(-sz * 0.4, sz * 0.18);
      ctx.moveTo(-sz * 0.55, 0); ctx.lineTo(-sz * 0.4, -sz * 0.18);
      ctx.stroke();
    }
    ctx.fillStyle = tfxHot(color, 0.5, 1);
    ctx.beginPath(); ctx.arc(0, 0, sz * 0.16, 0, TFX_TAU); ctx.fill();
    ctx.restore();
  });
  ctx.restore();
}

// tracks (Tire Tracks) — two offset rails + cross-tread ticks at constant spacing.
function drawTracksTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var GAUGE = TP('tracks','GAUGE',4), TREAD = TP('tracks','TREAD',4);
  ctx.save(); ctx.strokeStyle = color; ctx.lineCap = "butt";
  var bucketMs = fadeMs / TFX_BUCKETS;
  for (var rail = -1; rail <= 1; rail += 2) {
    ctx.lineWidth = 2.4;
    for (var b = 0; b < TFX_BUCKETS; b++) {
      tfxAlpha(ctx, (1 - (b + 0.5) / TFX_BUCKETS) * 0.8);
      var run = false;
      for (var i = 1; i < n; i++) {
        var age = now - verts[i].t; var seg = (age >= fadeMs) ? TFX_BUCKETS : Math.floor(age / bucketMs);
        if (seg !== b) { if (run) { ctx.stroke(); run = false; } continue; }
        var t0 = tfxTangent(verts, i - 1), t1 = tfxTangent(verts, i);
        if (!run) { ctx.beginPath(); ctx.moveTo(verts[i - 1].x - t0.y * GAUGE * rail, verts[i - 1].y + t0.x * GAUGE * rail); run = true; }
        ctx.lineTo(verts[i].x - t1.y * GAUGE * rail, verts[i].y + t1.x * GAUGE * rail);
      }
      if (run) ctx.stroke();
    }
  }
  var cum = 0, nextTick = 0;
  ctx.lineWidth = 2;
  for (var j = 1; j < n; j++) {
    cum += Math.hypot(verts[j].x - verts[j - 1].x, verts[j].y - verts[j - 1].y);
    if (cum < nextTick) continue;
    nextTick = cum + TREAD;
    var f = tfxAgeAlpha(verts[j].t, now, fadeMs); if (f <= 0.05) continue;
    var t = tfxTangent(verts, j);
    tfxAlpha(ctx, f * 0.7);
    ctx.beginPath();
    ctx.moveTo(verts[j].x - t.y * (GAUGE + 2), verts[j].y + t.x * (GAUGE + 2));
    ctx.lineTo(verts[j].x + t.y * (GAUGE + 2), verts[j].y - t.x * (GAUGE + 2));
    ctx.stroke();
  }
  ctx.restore();
}

// notes (Music Notes) — notes ride the path you walked, then lift up + fade.
function drawNotesTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var SIZE = TP('notes','SIZE',3.5);
  var INTERVAL = TP('notes','INTERVAL',95);  // ms between notes — one per bucket (frame-stable)
  var RISE = TP('notes','RISE',38);          // total px the note lifts during its drift phase
  ctx.save();
  tfxForEachParticle(verts, now, fadeMs, INTERVAL, function (v, ts, age) {
    var ph = tfxParticlePhase(age, fadeMs);
    var alpha = ph.alpha; if (alpha <= 0.03) return;
    var seed = ts;
    var sway = Math.sin(age * 0.0018 + tfxHash(seed + 1) * TFX_TAU) * 6 * ph.drift;
    var x = v.x + sway + (tfxHash(seed + 2) - 0.5) * 6;
    var y = v.y - RISE * ph.drift;
    var sz = SIZE * (0.7 + tfxHash(seed + 3) * 0.6);
    var rot = Math.sin(age * 0.0018 + tfxHash(seed + 4) * TFX_TAU) * 0.3 * (0.3 + 0.7 * ph.drift);
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); tfxAlpha(ctx, alpha);
    ctx.fillStyle = color; tfxNoteGlyph(ctx, sz);
    ctx.restore();
  });
  ctx.restore();
}

// neon (Neon Wall) — crisp constant-width light ribbon (faint body + bright core).
function drawNeonTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var WIDTH = TP('neon','WIDTH',8), GLOW = TP('neon','GLOW',11);
  var bucketMs = fadeMs / TFX_BUCKETS;
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  // Each pass is ~TFX_BUCKETS alpha-faded strokes; with per-op shadowBlur the two
  // passes tanked with several wearers. Paint each pass unshadowed and glow it via
  // one scratch blit per pass.
  function strokeBuckets(c, width, style) {
    c.lineCap = "round"; c.lineJoin = "round";
    c.lineWidth = width; c.strokeStyle = style;
    for (var b = 0; b < TFX_BUCKETS; b++) {
      tfxAlpha(c, (1 - (b + 0.5) / TFX_BUCKETS));
      var run = false;
      for (var i = 1; i < n; i++) {
        var age = now - verts[i].t; var seg = (age >= fadeMs) ? TFX_BUCKETS : Math.floor(age / bucketMs);
        if (seg !== b) { if (run) { c.stroke(); run = false; } continue; }
        if (!run) { c.beginPath(); c.moveTo(verts[i - 1].x, verts[i - 1].y); run = true; }
        c.lineTo(verts[i].x, verts[i].y);
      }
      if (run) c.stroke();
    }
  }
  tfxGlowPaint(ctx, verts, color, GLOW, WIDTH, null, function (c) { strokeBuckets(c, WIDTH, tfxRGBA(color, 0.32)); });
  tfxGlowPaint(ctx, verts, color, GLOW * 0.4, WIDTH, null, function (c) { strokeBuckets(c, Math.max(1.5, WIDTH * 0.28), tfxHot(color, 0.7, 1)); });
  ctx.restore();
}

// ripple (Ripples) — sonar rings dropped along the path, expanding + fading.
function drawRippleTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var SPACING = TP('ripple','SPACING',21), GLOW = TP('ripple','GLOW',3);
  var interval = Math.max(20, fadeMs / SPACING);
  ctx.save();
  // ~20 expanding ring strokes per frame; even GLOW 3 per-op shadows added an
  // intermediate surface per ring. One scratch blit carries the glow instead.
  var rippleRings = function (c) {
    c.strokeStyle = color;
    tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
      var life = tfxClamp01(age / fadeMs);
      var R = 4 + life * 46;
      var alpha = tfxClamp01(1 - life) * 0.8; if (alpha <= 0.03) return;
      tfxAlpha(c, alpha); c.lineWidth = Math.max(1, 2.5 * (1 - life));
      c.beginPath(); c.arc(v.x, v.y, R, 0, TFX_TAU); c.stroke();
    });
  };
  tfxGlowPaint(ctx, verts, color, GLOW, 54, null, rippleRings);
  var head = verts[n - 1];
  // Head ping: single op, direct shadow stays cheap.
  if (tfxGlow()) { ctx.shadowColor = color; ctx.shadowBlur = GLOW; }
  tfxAlpha(ctx, 0.9); ctx.fillStyle = tfxHot(color, 0.5, 1);
  ctx.beginPath(); ctx.arc(head.x, head.y, 2.4, 0, TFX_TAU); ctx.fill();
  ctx.restore();
}

// powder (Powder) — the Smooth Operator drift unlock: kicked-up frost. Low, soft
// powder puffs (heavily whitened player colour) billow out sideways and settle,
// dusted with tiny bright ice flecks — reads as snow spray carving off an edge.
function drawPowderTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length; if (n < 2) return;
  var DENSITY = TP('powder','DENSITY',22), GLOW = TP('powder','GLOW',2), PUFF = TP('powder','PUFF',7);
  var interval = Math.max(20, fadeMs / DENSITY);
  ctx.save();
  // Soft puff pass under one scratch-blit glow (per-puff shadows would stack surfaces).
  var powderPuffs = function (c) {
    tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age) {
      var ph = tfxParticlePhase(age, fadeMs);
      var alpha = ph.alpha * 0.55; if (alpha <= 0.03) return;
      var seed = ts;
      var side = tfxHash(seed + 1) < 0.5 ? -1 : 1;          // billow out one flank
      var spread = (4 + tfxHash(seed + 2) * 10) * ph.drift;  // settle outward over life
      var x = v.x + side * spread + (tfxHash(seed + 3) - 0.5) * 5;
      var y = v.y + (tfxHash(seed + 4) - 0.5) * 6 + 2 * ph.drift;
      var r = PUFF * (0.45 + tfxHash(seed + 5) * 0.7) * (0.7 + 0.5 * ph.drift);
      tfxAlpha(c, alpha);
      c.fillStyle = tfxHot(color, 0.78, 1);                  // near-white, colour-kissed
      c.beginPath(); c.arc(x, y, r, 0, TFX_TAU); c.fill();
    });
  };
  tfxGlowPaint(ctx, verts, color, GLOW, PUFF * 2 + 8, null, powderPuffs);
  // Ice flecks: sparse, tiny, bright — the glitter on top of the powder.
  tfxForEachParticle(verts, now, fadeMs, interval * 1.8, function (v, ts, age) {
    var life = tfxClamp01(age / fadeMs);
    var alpha = tfxClamp01(1 - life) * 0.9; if (alpha <= 0.03) return;
    var seed = ts;
    var x = v.x + (tfxHash(seed + 6) - 0.5) * 16 * (0.4 + life);
    var y = v.y + (tfxHash(seed + 7) - 0.5) * 12 * (0.4 + life);
    tfxAlpha(ctx, alpha);
    ctx.fillStyle = tfxHot(color, 0.92, 1);
    var fs = 0.8 + tfxHash(seed + 8) * 1.1;
    ctx.beginPath(); ctx.arc(x, y, fs, 0, TFX_TAU); ctx.fill();
  });
  ctx.restore();
}

// ===========================================================================
// SEASONAL: Solar Flare — the Early Adopter (Summer 2026) claim trail.
// ---------------------------------------------------------------------------
// DESIGN EXCEPTION (iteration knob): every OTHER trail renders in the player's
// colour (the locked "color rule"). This one BLENDS gold with the player's colour
// so it reads as a premium founder badge from across the map while still carrying a
// hint of the player's identity. FOUNDERS_MIX = how far toward gold (0 = pure player
// colour, 1 = pure gold). FOUNDERS_TAIL_PERSIST > 1 keeps the tail visible longer
// (slower alpha falloff). FLARE_GOLD / FLARE_HOT are the iteration colours.
var FOUNDERS_MIX = 0.38;                   // 0 = pure player colour … 1 = pure gold (0.38 = player-colour-dominant, gold-kissed)
var FOUNDERS_TAIL_PERSIST = 1.6;           // >1 = tail fades out more slowly so the flare reads longer
var FLARE_GOLD = '#ffae1f';               // molten body / embers
var FLARE_HOT = '#fff3c8';               // white-hot core + specular
// Blend the player's colour toward FLARE_GOLD by FOUNDERS_MIX, returning an "rgb()" string.
// Memoised per player colour (one parse + one blend per colour, then zero-alloc) so the body
// fill / embers / head can all reuse it cheaply each frame.
var _foundersBlend = {};
function foundersGold(color) {
  var k = color + '|' + FOUNDERS_MIX;
  var s = _foundersBlend[k];
  if (s != null) return s;
  var pc = tfxRGB(color), gc = tfxRGB(FLARE_GOLD), m = FOUNDERS_MIX;
  s = "rgb(" + Math.round(pc.r + (gc.r - pc.r) * m) + "," +
    Math.round(pc.g + (gc.g - pc.g) * m) + "," +
    Math.round(pc.b + (gc.b - pc.b) * m) + ")";
  _foundersBlend[k] = s; return s;
}
// A radiant, sun-like flare: a tapered molten-gold ribbon body, a white-hot core
// stroke, drifting ember flecks (deterministic per vertex), and a glowing head blob.
// Structure mirrors drawCometTrail (sampled-vertex ribbon) so perf/feel match the set.
function drawFoundersFlareTrail(ctx, verts, color, now, fadeMs, anim) {
  var n = verts.length;
  if (n < 2) return;
  var gold = foundersGold(color); // gold blended with the player's colour
  // Slow the age-fade so the tail stays lit toward the buffer's end (reads as a longer flare).
  // Geometry still spans the real buffer; this only softens how fast each segment dims out.
  var fadeEff = fadeMs * TP('founders_flare', 'TAIL_PERSIST', FOUNDERS_TAIL_PERSIST);
  var WIDTH = TP('founders_flare', 'WIDTH', 24), GLOW = TP('founders_flare', 'GLOW', 26), TAPER = TP('founders_flare', 'TAPER', 0.75);
  var stride = Math.max(1, Math.floor(n / 50));
  var idx = [];
  for (var i = 0; i < n; i += stride) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  var m = idx.length;
  var hw = new Array(m), nx = new Array(m), ny = new Array(m), af = new Array(m);
  for (var j = 0; j < m; j++) {
    var ii = idx[j];
    var f = tfxAgeAlpha(verts[ii].t, now, fadeEff);
    af[j] = f;
    // Flicker the half-width slightly so the flare licks like fire (anim-driven, vertex-stable).
    var flick = 0.85 + 0.15 * Math.sin(anim * 0.012 + verts[ii].t * 0.02);
    hw[j] = (WIDTH * 0.5) * Math.pow(f, TAPER) * flick;
    var tan = tfxTangent(verts, ii);
    nx[j] = -tan.y; ny[j] = tan.x;
  }
  ctx.save();
  ctx.lineJoin = "round";
  // Molten body ribbon: ~50 alpha-faded quad fills. Painted into the SHARED glow scratch
  // together with the core + embers below and blitted ONCE (see the merged tfxGlowPaint).
  var flareRibbon = function (c) {
    c.lineJoin = "round";
    c.fillStyle = gold;
    for (var s = 1; s < m; s++) {
      var alpha = af[s] * 0.55;
      if (alpha <= 0.02) continue;
      var p0 = verts[idx[s - 1]], p1 = verts[idx[s]];
      tfxAlpha(c, alpha);
      c.beginPath();
      c.moveTo(p0.x + nx[s - 1] * hw[s - 1], p0.y + ny[s - 1] * hw[s - 1]);
      c.lineTo(p1.x + nx[s] * hw[s], p1.y + ny[s] * hw[s]);
      c.lineTo(p1.x - nx[s] * hw[s], p1.y - ny[s] * hw[s]);
      c.lineTo(p0.x - nx[s - 1] * hw[s - 1], p0.y - ny[s - 1] * hw[s - 1]);
      c.closePath();
      c.fill();
    }
  };
  // White-hot inner core + ember flecks.
  var flareCoreEmbers = function (c2) {
    var coreStart = -1;
    for (var c = 0; c < m; c++) { if (af[c] > 0.3) { coreStart = c; break; } }
    if (coreStart >= 0 && coreStart < m - 1) {
      tfxAlpha(c2, 0.9);
      c2.strokeStyle = FLARE_HOT;
      c2.lineCap = "round";
      c2.lineWidth = Math.max(0.9, WIDTH * 0.16);
      c2.beginPath();
      c2.moveTo(verts[idx[coreStart]].x, verts[idx[coreStart]].y);
      for (var cc = coreStart + 1; cc < m; cc++) c2.lineTo(verts[idx[cc]].x, verts[idx[cc]].y);
      c2.stroke();
    }
    // Drifting ember flecks — deterministic per vertex (tfxHash), rising as they age.
    c2.fillStyle = gold;
    for (var e = 1; e < m; e += 1) {
      var fe = af[e];
      if (fe <= 0.05) continue;
      var h1 = tfxHash(verts[idx[e]].t);
      if (h1 < 0.45) continue; // sparse — only some segments spit an ember
      var age = 1 - fe;
      var ev = verts[idx[e]];
      var perp = (h1 - 0.5) * WIDTH * 1.6;
      var rise = age * WIDTH * 1.1;
      var ex = ev.x + nx[e] * perp;
      var ey = ev.y + ny[e] * perp - rise;
      var twinkle = 0.5 + 0.5 * Math.sin(anim * 0.02 + h1 * 31.0);
      tfxAlpha(c2, fe * twinkle * 0.9);
      var er = Math.max(0.6, (1.8 * fe) * (0.6 + 0.4 * h1));
      c2.beginPath(); c2.arc(ex, ey, er, 0, TFX_TAU); c2.fill();
    }
  };
  // MERGED glow: paint the ribbon + core + embers into one shared scratch and blit ONCE at the
  // body's GLOW radius (margin WIDTH*2 contains the ember rise). Halves founders' glow cost (its
  // two bbox-overlapping blits -> one; ~1.9x cheaper render measured). The core/embers pick up
  // the body's wider, softer bloom instead of a separate tighter halo — visually near-identical.
  tfxGlowPaint(ctx, verts, gold, GLOW, WIDTH * 2, null, function (c) {
    flareRibbon(c);
    flareCoreEmbers(c);
  });
  // Radiant head — bright sun-like blob.
  var head = verts[n - 1];
  var R = WIDTH * 1.0;
  tfxAlpha(ctx, 1);
  if (tfxGlow()) ctx.shadowBlur = 0;
  ctx.save();
  ctx.translate(head.x, head.y); ctx.scale(R, R);
  ctx.fillStyle = tfxBlobGrad(ctx, gold);
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TFX_TAU); ctx.fill();
  ctx.restore();
  // Hot pinpoint at the very head.
  tfxAlpha(ctx, 0.95); ctx.fillStyle = FLARE_HOT;
  ctx.beginPath(); ctx.arc(head.x, head.y, Math.max(1.2, WIDTH * 0.1), 0, TFX_TAU); ctx.fill();
  ctx.restore();
}

/* ============================================================================
 * WIRING — how the main session ports these into draw.js drawTrail()
 * ----------------------------------------------------------------------------
 * 1) Dispatch map (id string from the trail registry → renderer). New ids
 *    (ribbon/bolt/hearts/smoke/confetti/snow/tracks/notes/neon/ripple) must be
 *    added to the trail registry by the registry owner; 'snow' displays as
 *    "Crystals", 'bolt' as "Lightning".
 *
 *      var TRAIL_FX = {
 *        dashes: drawDashesTrail, sparkle: drawSparkleTrail, comet: drawCometTrail,
 *        bubbles: drawBubblesTrail, aurora: drawAuroraTrail, guardian: drawGuardianTrail,
 *        survivor: drawSurvivorTrail, ribbon: drawRibbonTrail, bolt: drawBoltTrail,
 *        hearts: drawHeartsTrail, smoke: drawSmokeTrail, confetti: drawConfettiTrail,
 *        snow: drawSnowTrail, tracks: drawTracksTrail, notes: drawNotesTrail,
 *        neon: drawNeonTrail, ripple: drawRippleTrail
 *      };
 *
 * 2) Inside drawTrail(), AFTER it has computed `verts`, `now`, `fadeMs`, the
 *    `dashed` (near-victory) flag and `trailEffect`, and BEFORE the existing
 *    lightweight stroke-style block, branch to the rich renderer:
 *
 *      // near-victory dashing keeps priority for legibility (leave that path as-is)
 *      var fx = (!dashed && trailEffect) ? TRAIL_FX[trailEffect] : null;
 *      if (fx) {
 *        tfxBaseAlpha = isLocalId(player.id) ? 1 : NONLOCAL_TRAIL_ALPHA; // dim others
 *        fx(gameContext, verts, player.color, now, fadeMs, cartSkinAnimTime * 1000);
 *        tfxBaseAlpha = 1;
 *        gameContext.restore();   // matches the gameContext.save() at the top of drawTrail
 *        return;                  // the renderer drew the whole trail
 *      }
 *      // else fall through to the existing basic bucketed stroke.
 *
 *    The renderers do their own save()/restore() internally, so they won't leak
 *    state — but drawTrail already did one save() at the top; the early return
 *    above balances it with a restore(). (Or hoist the rich branch above that
 *    save(); either is fine as long as save/restore stay balanced.)
 *
 * 3) Delete the now-obsolete lightweight per-effect stroke tweaks (setLineDash/
 *    lineWidth/shadow keyed off trailEffect) — these renderers replace them. The
 *    `getSkinTrailColor` override is already gone per the locked design (color is
 *    always player.color).
 *
 * 4) BUILD: add this file to the play bundle in build.js AND a <script> tag in
 *    play.html's BUILD block, placed BEFORE draw.js (draw.js calls these).
 * ============================================================================ */

// ---------------------------------------------------------------------------
// Star Power (ability FX, not a cosmetic): rainbow 5-point stars while the
// ability is active. Deliberately NOT in TRAIL_FX / skinRegistry — drawTrail()
// branches here directly when player.starPowerUntil is live, overriding any
// equipped cosmetic trail for the duration. drawStarPowerFx (draw.js) reuses
// tfxStarPath for the orbiting stars around the kart.
function tfxStarPath(ctx, r) {
  // 5-point star centred on the origin, outer radius r.
  var inner = r * 0.45;
  ctx.beginPath();
  for (var i = 0; i < 10; i++) {
    var ang = -Math.PI / 2 + i * Math.PI / 5;
    var rad = (i % 2 === 0) ? r : inner;
    var x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
    if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
  }
  ctx.closePath();
}
function drawStarPowerTrail(ctx, verts, color, now, fadeMs, anim) {
  if (verts.length < 2) return;
  var interval = Math.max(20, fadeMs / 36);
  ctx.save();
  tfxForEachParticle(verts, now, fadeMs, interval, function (v, ts, age, i) {
    var a0 = tfxClamp01(1 - age / fadeMs);
    if (a0 <= 0.02) return;
    var tan = tfxTangent(verts, i);
    var nx = -tan.y, ny = tan.x;
    var seed = ts;
    var off = (tfxHash(seed) - 0.5) * 2 * 14;
    var px = v.x + nx * off;
    var py = v.y + ny * off;
    // Spawn-time hue: the rainbow runs ALONG the trail instead of the whole
    // tail strobing one colour per frame.
    var hue = (ts * 0.9) % 360;
    var spin = anim * 0.004 + tfxHash(seed + 3) * TFX_TAU;
    var sz = 5 * (0.6 + tfxHash(seed + 5) * 0.7) * (0.5 + 0.5 * a0);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(spin);
    tfxAlpha(ctx, a0 * 0.95);
    ctx.fillStyle = "hsl(" + hue + ",100%,62%)";
    tfxStarPath(ctx, sz);
    ctx.fill();
    // Bright core so the stars pop on dark terrain too.
    tfxAlpha(ctx, a0 * 0.5);
    ctx.fillStyle = "hsl(" + hue + ",100%,85%)";
    tfxStarPath(ctx, sz * 0.45);
    ctx.fill();
    ctx.restore();
  });
  ctx.restore();
}

// Dispatch map: trail-effect id (from the trail registry / getTrailEffect) → renderer.
// drawTrail() (draw.js) branches here for the rich effects; ids must match skinRegistry.
var TRAIL_FX = {
  basic: drawBasicTrail,
  dashes: drawDashesTrail, sparkle: drawSparkleTrail, comet: drawCometTrail,
  bubbles: drawBubblesTrail, aurora: drawAuroraTrail, guardian: drawGuardianTrail,
  survivor: drawSurvivorTrail, ribbon: drawRibbonTrail, bolt: drawBoltTrail,
  hearts: drawHeartsTrail, smoke: drawSmokeTrail, confetti: drawConfettiTrail,
  snow: drawSnowTrail, tracks: drawTracksTrail, notes: drawNotesTrail,
  neon: drawNeonTrail, ripple: drawRippleTrail, powder: drawPowderTrail,
  foundersFlare: drawFoundersFlareTrail
};
