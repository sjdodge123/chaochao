// ============================================================================
// learnScenes.js — live mini-animations for the Codex cards (learn.html).
//
// FAITHFUL TO THE GAME: the effects here are PORTED VERBATIM from the real
// renderer, not re-invented. The effects engine (addEffect), the spawn functions
// (punch / hit / teleport-puff / slash / explosion / screen-flash / muzzle), the
// terrain dust system (spawnDustParticle / spawnTerrainParticle / spawnIceTrail /
// spawnEmber, coloured per surface), drawSpeedFx, and the fire SpriteSheet are
// copied from client/scripts/draw.js + client/scripts/gameboard.js with only
// these adaptations: the draw context is passed in (the game uses a global
// `gameContext`) and there's no camera transform. Each scene drives a fake kart
// (`p`) through the same code paths the game uses, so a card shows the ACTUAL
// in-game effect (e.g. grass/sand/ice kick up the real flecks/skate-marks; the
// fire uses the real flame sprite sheet; punch/swap/bomb use the real bursts).
//
// >>> KEEP IN SYNC: if those functions change in draw.js/gameboard.js, update the
//     ports below. They're marked "PORT:" with their source. <<<
//
// PERFORMANCE (~30 canvases, mobile/iPad): ONE shared rAF; an IntersectionObserver
// starts/stops each canvas as it scrolls in/out (filter-hidden display:none cards
// auto-stop); prefers-reduced-motion → one static frame, no loop; DPR capped at 2;
// logical canvas is small (W×H). Each card has its OWN effects list (its own `fx`).
//
// FIRE GOTCHA: the *Fire.png sheets are 32×128 = 4 frames stacked VERTICALLY
// (rows=4, columns=1). Slicing them horizontally produces garbage — use SpriteSheet.
// ============================================================================

var LearnAnim = (function () {
    "use strict";

    var BASE = "assets/img/";
    var W = 240, H = 140;
    var MAXSPEED = 500;                 // mirrors config.playerMaxSpeed for dust thresholds
    var SCENES = {};
    var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

    // ---- lazy image cache ----
    var imgCache = {};
    function img(file) {
        if (imgCache[file] !== undefined) { return imgCache[file]; }
        var i = new Image();
        // In reduced-motion mode cards draw once; refresh them as images decode.
        i.addEventListener("load", function () { if (reduceMotion) { redrawVisibleStatic(); } });
        i.src = BASE + file; imgCache[file] = i; return i;
    }
    function ready(i) { return i && i.complete && i.naturalWidth > 0; }

    // ---- math (PORT: draw.js helpers) ----
    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function loop(t, period) { return (t % period) / period; }
    function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
    function ping(t, period) { var p = loop(t, period); return p < 0.5 ? p * 2 : (1 - p) * 2; }
    function rnd() { return Math.random(); }

    var BLUE = "#3a9bff", RED = "#ff5b5b", GREEN = "#54d18c", YELLOW = "#ffd23a", PURPLE = "#9b6bff";

    // ========================================================================
    // EFFECTS ENGINE (PORT: draw.js effectsList/addEffect/drawEffects). Each card
    // owns its list; addEffect targets the "active" list set before a scene runs.
    // ========================================================================
    function makeFX() { return { list: [] }; }
    var _fx = null;                     // active effects list (set per card per frame)
    function addEffect(e) { e.age = 0; if (_fx) { _fx.list.push(e); } }
    function updateFX(fx, dt) {
        for (var i = fx.list.length - 1; i >= 0; i--) {
            fx.list[i].age += dt;
            if (fx.list[i].age >= fx.list[i].maxAge) { fx.list.splice(i, 1); }
        }
    }
    function drawFX(fx, ctx) {
        for (var i = 0; i < fx.list.length; i++) {
            var e = fx.list[i];
            var t = clamp01(e.age / e.maxAge);
            ctx.save();
            e.draw(ctx, t, e);
            ctx.restore();
        }
    }

    // ---- terrain particles (PORT: gameboard.js) ----
    function spawnDustParticle(x, y, vx, vy, size, color) {
        addEffect({ x: x, y: y, maxAge: 430, draw: function (ctx, t, e) {
            var a = 1 - t, r = size * (1 - 0.35 * t);
            ctx.beginPath();
            ctx.arc(x + vx * e.age, y + vy * e.age, r, 0, 2 * Math.PI);
            ctx.globalAlpha = a * 0.85; ctx.fillStyle = color; ctx.fill();
            ctx.globalAlpha = a * 0.4; ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,1)"; ctx.stroke();
        } });
    }
    function spawnEmber(x, y) {
        var vx = (rnd() * 2 - 1) * 0.015, vy = -(0.03 + rnd() * 0.03);
        var hue = 18 + rnd() * 32, maxAge = 500 + rnd() * 300;
        addEffect({ x: x, y: y, maxAge: maxAge, draw: function (ctx, t, e) {
            ctx.globalAlpha = (1 - t) * 0.9;
            ctx.fillStyle = "hsl(" + hue + ", 100%, " + (62 - 22 * t) + "%)";
            ctx.beginPath(); ctx.arc(x + vx * e.age, y + vy * e.age, 2.5 * (1 - t) + 0.5, 0, 2 * Math.PI); ctx.fill();
        } });
    }
    function dustColor() { return "rgba(170, 150, 120, 1)"; }
    function grassColor() { return "rgba(150, 230, 70, 1)"; }
    function sandColor() { return "rgba(250, 238, 205, 1)"; }
    function iceColor() { return "rgba(70, 165, 220, 1)"; }
    function spawnTerrainParticle(p, color, minSize, count) {
        count = count || 1;
        var dir = Math.atan2(p.velY, p.velX);
        for (var i = 0; i < count; i++) {
            var bx = p.x - Math.cos(dir) * p.radius + (rnd() * 2 - 1) * p.radius * 0.5;
            var by = p.y - Math.sin(dir) * p.radius + (rnd() * 2 - 1) * p.radius * 0.5;
            var spread = (rnd() * 2 - 1) * 0.03;
            var vx = -Math.cos(dir) * 0.013 + Math.cos(dir + Math.PI / 2) * spread;
            var vy = -Math.sin(dir) * 0.013 + Math.sin(dir + Math.PI / 2) * spread;
            spawnDustParticle(bx, by, vx, vy, minSize + rnd() * 2, color);
        }
    }
    function addIceStreak(bx, by, ex, ey) {
        addEffect({ x: bx, y: by, maxAge: 700, draw: function (ctx, t) {
            ctx.globalAlpha = (1 - t) * 0.6; ctx.strokeStyle = iceColor(); ctx.lineWidth = 3; ctx.lineCap = "round";
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey); ctx.stroke();
        } });
    }
    function spawnIceTrail(p) {
        var dir = Math.atan2(p.velY, p.velX), len = p.radius * 1.7, perp = dir + Math.PI / 2, gap = p.radius * 0.5;
        for (var s = -1; s <= 1; s += 2) {
            var bx = p.x + Math.cos(perp) * gap * s, by = p.y + Math.sin(perp) * gap * s;
            addIceStreak(bx, by, bx - Math.cos(dir) * len, by - Math.sin(dir) * len);
        }
    }
    function sandTrenchColor() { return "rgba(120, 92, 52, 1)"; }
    function addSandTrench(bx, by, ex, ey, dir, radius) {
        var perp = dir + Math.PI / 2, off = radius * 0.7, ox = Math.cos(perp) * off, oy = Math.sin(perp) * off;
        addEffect({ x: bx, y: by, maxAge: 1300, draw: function (ctx, t) {
            ctx.save(); ctx.lineCap = "round";
            ctx.globalAlpha = (1 - t) * 0.3; ctx.strokeStyle = sandTrenchColor(); ctx.lineWidth = off * 2;
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey); ctx.stroke();
            ctx.globalAlpha = (1 - t) * 0.5; ctx.strokeStyle = sandColor(); ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(bx + ox, by + oy); ctx.lineTo(ex + ox, ey + oy); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(bx - ox, by - oy); ctx.lineTo(ex - ox, ey - oy); ctx.stroke();
            ctx.restore();
        } });
    }
    function spawnSandTrail(p) {
        if (p.trenchX == null) { p.trenchX = p.x; p.trenchY = p.y; return; }
        var dx = p.x - p.trenchX, dy = p.y - p.trenchY, d2 = dx * dx + dy * dy, step = p.radius * 0.5, maxGap = p.radius * 4;
        if (d2 < step * step) { return; }
        if (d2 <= maxGap * maxGap) { addSandTrench(p.trenchX, p.trenchY, p.x, p.y, Math.atan2(dy, dx), p.radius); }
        p.trenchX = p.x; p.trenchY = p.y;
    }
    function spawnSkid(p, color) {
        var dir = Math.atan2(p.prevVelY, p.prevVelX);
        for (var i = 0; i < 4; i++) {
            var spread = (rnd() * 2 - 1) * 0.04;
            var vx = Math.cos(dir) * 0.02 + Math.cos(dir + Math.PI / 2) * spread;
            var vy = Math.sin(dir) * 0.02 + Math.sin(dir + Math.PI / 2) * spread;
            spawnDustParticle(p.x, p.y, vx, vy, 2.5 + rnd() * 2, color);
        }
    }
    // PORT: gameboard.js updateMovementParticles — surface comes from p.surface
    // (the game does a Voronoi tile lookup; here each scene sets it explicitly).
    function updateMovementParticles(p, dt) {
        if (p.alive === false || p.velX == null) { return; }
        var fastThresh = MAXSPEED * 0.55, walkThresh = MAXSPEED * 0.08;
        var speed = Math.sqrt(p.velX * p.velX + p.velY * p.velY);
        if (p.dustCD == null) { p.dustCD = 0; } if (p.skidCD == null) { p.skidCD = 0; } if (p.emberCD == null) { p.emberCD = 0; }
        p.dustCD -= dt; p.skidCD -= dt; p.emberCD -= dt;
        if (p.prevVelX != null && p.skidCD <= 0 && speed > fastThresh * 0.5) {
            var prevSpeed = Math.sqrt(p.prevVelX * p.prevVelX + p.prevVelY * p.prevVelY);
            if (prevSpeed > 1) {
                var dot = (p.velX * p.prevVelX + p.velY * p.prevVelY) / (speed * prevSpeed);
                if (dot < 0.6) { spawnSkid(p, surfaceColor(p.surface)); p.skidCD = 140; }
            }
        }
        if (speed > walkThresh && p.dustCD <= 0) {
            if (p.surface === "ice") { if (speed > fastThresh) { spawnIceTrail(p); p.dustCD = 40; } else { p.dustCD = 60; } }
            else if (p.surface === "fast") { spawnTerrainParticle(p, grassColor(), 1.8, 2); p.dustCD = speed > fastThresh ? 45 : 70; }
            else if (p.surface === "slow") { spawnSandTrail(p); spawnTerrainParticle(p, sandColor(), 1.8, 1); p.dustCD = speed > fastThresh ? 90 : 130; }
            else if (speed > fastThresh) { spawnTerrainParticle(p, dustColor(), 2.5, 2); p.dustCD = 50; }
            else { p.dustCD = 60; }
        }
        if (p.onFire > 0 && p.emberCD <= 0) {
            spawnEmber(p.x + (rnd() * 2 - 1) * p.radius, p.y + (rnd() * 2 - 1) * p.radius); p.emberCD = 70;
        }
        p.prevVelX = p.velX; p.prevVelY = p.velY;
    }
    function surfaceColor(s) { return s === "fast" ? grassColor() : s === "slow" ? sandColor() : s === "ice" ? iceColor() : dustColor(); }

    // ---- ability / impact bursts (PORT: draw.js spawn* functions) ----
    // The punch is omnidirectional; the optional angleDeg arg is unused, kept for the
    // existing callsites that still pass one.
    function spawnPunchEffect(px, py, baseRadius, color) {
        addEffect({ x: px, y: py, maxAge: 220, draw: function (ctx, t) {
            var grow = easeOutCubic(t); ctx.lineCap = "round";
            ctx.globalAlpha = (1 - t) * 0.5; ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(px, py, baseRadius * (0.55 + 0.75 * grow), 0, 2 * Math.PI); ctx.fill();
            ctx.globalAlpha = (1 - t); ctx.lineWidth = 2 * (1 - t) + 1; ctx.strokeStyle = color;
            ctx.beginPath(); ctx.arc(px, py, baseRadius * (0.8 + 0.8 * grow), 0, 2 * Math.PI); ctx.stroke();
        } });
    }
    function spawnHitEffect(x, y, color) {
        addEffect({ x: x, y: y, maxAge: 220, draw: function (ctx, t) {
            var p = easeOutCubic(t); ctx.translate(x, y); ctx.lineCap = "round";
            ctx.globalAlpha = (1 - t); ctx.strokeStyle = "white"; ctx.lineWidth = 3 * (1 - t) + 1;
            ctx.beginPath(); ctx.arc(0, 0, 6 + 22 * p, 0, 2 * Math.PI); ctx.stroke();
            ctx.strokeStyle = color || "white"; ctx.lineWidth = 2 * (1 - t) + 1;
            for (var i = 0; i < 6; i++) { var a = (i / 6) * Math.PI * 2 + 0.3, r0 = 2.8 + 8.4 * p, r1 = 8.4 + 18.2 * p;
                ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke(); }
        } });
    }
    function spawnTeleportPuff(x, y, color) {
        addEffect({ x: x, y: y, maxAge: 360, draw: function (ctx, t) {
            var p = easeOutCubic(t); ctx.translate(x, y);
            ctx.globalAlpha = (1 - t) * 0.9; ctx.strokeStyle = color || "white"; ctx.lineWidth = 3 * (1 - t) + 1;
            ctx.beginPath(); ctx.arc(0, 0, 8 + 38 * p, 0, 2 * Math.PI); ctx.stroke();
            ctx.fillStyle = color || "white";
            for (var i = 0; i < 8; i++) { var a = (i / 8) * Math.PI * 2 + t * 3, r = 6 + 30 * p; ctx.globalAlpha = (1 - t);
                ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.5 * (1 - t) + 0.5, 0, 2 * Math.PI); ctx.fill(); }
        } });
    }
    function spawnSlashEffect(x, y, angleDeg, color) {
        var a = angleDeg * Math.PI / 180, len = W, dx = Math.cos(a) * len, dy = Math.sin(a) * len;
        addEffect({ x: x, y: y, maxAge: 280, draw: function (ctx, t) {
            ctx.lineCap = "round";
            ctx.globalAlpha = (1 - t) * 0.6; ctx.strokeStyle = color || "white"; ctx.lineWidth = (10 * (1 - t)) + 2;
            ctx.shadowColor = color || "white"; ctx.shadowBlur = 12 * (1 - t);
            ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
            ctx.globalAlpha = (1 - t); ctx.strokeStyle = "white"; ctx.lineWidth = (4 * (1 - t)) + 1; ctx.shadowBlur = 0;
            ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
        } });
    }
    function spawnExplosion(x, y, radius, color) {
        color = color || "#ff7a18"; radius = radius || 70;
        addEffect({ x: x, y: y, maxAge: 430, draw: function (ctx, t) {
            var p = easeOutCubic(t); ctx.translate(x, y);
            var coreR = radius * (0.4 + 0.9 * p);
            var grad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
            grad.addColorStop(0, "rgba(255,245,200," + (1 - t) + ")"); grad.addColorStop(0.5, color); grad.addColorStop(1, "rgba(0,0,0,0)");
            ctx.globalAlpha = (1 - t) * 0.85; ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(0, 0, coreR, 0, 2 * Math.PI); ctx.fill();
            ctx.globalAlpha = (1 - t); ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 3 * (1 - t) + 1;
            ctx.beginPath(); ctx.arc(0, 0, radius * (0.6 + 1.0 * p), 0, 2 * Math.PI); ctx.stroke();
            ctx.fillStyle = color;
            for (var i = 0; i < 10; i++) { var a = (i / 10) * Math.PI * 2 + 0.2, r = radius * (0.3 + 1.1 * p); ctx.globalAlpha = (1 - t);
                ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.5 * (1 - t) + 0.5, 0, 2 * Math.PI); ctx.fill(); }
        } });
    }
    function spawnScreenFlash(color, peakAlpha, maxAge) {
        addEffect({ x: 0, y: 0, maxAge: maxAge || 250, draw: function (ctx, t) {
            ctx.globalAlpha = (1 - t) * (peakAlpha || 0.35); ctx.fillStyle = color || "red";
            ctx.fillRect(-10, -10, W + 20, H + 20);
        } });
    }
    function spawnMuzzleFlash(x, y, angleDeg, color) {
        var a = angleDeg * Math.PI / 180;
        addEffect({ x: x, y: y, maxAge: 160, draw: function (ctx, t) {
            var p = easeOutCubic(t), reach = 8 + 20 * p, spread = 6 * (1 - t) + 3;
            ctx.translate(x, y); ctx.rotate(a);
            ctx.globalAlpha = (1 - t) * 0.9; ctx.fillStyle = color;
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(reach, -spread); ctx.lineTo(reach + 6, 0); ctx.lineTo(reach, spread); ctx.closePath(); ctx.fill();
            ctx.globalAlpha = (1 - t); ctx.strokeStyle = "white"; ctx.lineCap = "round"; ctx.lineWidth = 2 * (1 - t) + 0.5;
            for (var i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(2, i * 3); ctx.lineTo(reach * 0.8, i * 4); ctx.stroke(); }
        } });
    }
    // PORT: draw.js drawSpeedFx — buff wind-streaks / debuff ripple. now = elapsed ms.
    function drawSpeedFx(ctx, p, now) {
        if (p.speedBuffUntil != null && now < p.speedBuffUntil) {
            var speed = Math.sqrt(p.velX * p.velX + p.velY * p.velY);
            if (speed > 0.5) {
                var dirA = Math.atan2(p.velY, p.velX);
                ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(dirA);
                ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineCap = "round"; ctx.lineWidth = 2;
                var phase = (now / 60) % 12;
                for (var i = 0; i < 3; i++) { var off = (i - 1) * p.radius * 0.7, back = p.radius + 4 + ((phase + i * 4) % 12);
                    ctx.beginPath(); ctx.moveTo(-back, off); ctx.lineTo(-back - 10, off); ctx.stroke(); }
                ctx.restore();
            }
        }
        if (p.speedDebuffUntil != null && now < p.speedDebuffUntil) {
            var rp = (now / 700) % 1;
            ctx.save(); ctx.globalAlpha = (1 - rp) * 0.4; ctx.strokeStyle = "rgba(80,80,160,1)"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + 2 + rp * 12, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
        }
    }

    // ---- fire (PORT: draw.js SpriteSheet + drawFire/drawFlameColor) ----
    // Frame index is derived from a shared wall-clock (below), NOT a per-instance
    // accumulator: the sheets are module singletons shared by every fire card, so
    // a per-instance update(dt) called once per visible card would advance the
    // frame N× per tick (chatter). A clock-based index is idempotent across cards.
    var FIRE_FRAMES = 4, FIRE_FRAME_MS = 1000 / 24;
    function SpriteSheet(image, frameW, frameH, rows) {
        this.image = image; this.frameW = frameW; this.frameH = frameH; this.rows = rows;
    }
    SpriteSheet.prototype.draw = function (ctx, frameIdx, w, h) {
        if (!ready(this.image)) { return; }
        ctx.drawImage(this.image, 0, frameIdx * this.frameH, this.frameW, this.frameH, -w / 2, -h / 2, w, h);
    };
    var FIRE_FILES = ["redFire.png", "orangeFire.png", "yellowFire.png", "greenFire.png", "blueFire.png", "purpleFire.png"];
    var fireSheets = {};
    function fireSheet(idx) {
        var f = FIRE_FILES[idx];
        if (!fireSheets[f]) { fireSheets[f] = new SpriteSheet(img(f), 32, 32, 4); }
        return fireSheets[f];
    }
    // In-game (draw.js) the flame is drawn at 55px for the 7.5px player radius and
    // offset 5px to the trailing edge — keep those RATIOS so the flame scales with
    // our larger codex kart instead of looking shrunken.
    var FLAME_RATIO = 55 / 7.5;       // ≈ 7.33
    var FLAME_OFFSET = 5 / 7.5;       // ≈ 0.67
    function drawFlame(ctx, p) {
        var ms = p.onFire;
        var idx = ms < 1000 ? 0 : ms < 2000 ? 1 : ms < 3000 ? 2 : ms < 4000 ? 3 : ms < 5000 ? 4 : 5;
        var sh = fireSheet(idx); if (!ready(sh.image)) { return; }
        var frame = Math.floor(performance.now() / FIRE_FRAME_MS) % FIRE_FRAMES;  // shared clock
        var size = p.radius * FLAME_RATIO;
        ctx.save();
        var ar = p.angle * (Math.PI / 180);
        ctx.translate(p.x - p.radius * FLAME_OFFSET * Math.cos(ar), p.y - p.radius * FLAME_OFFSET * Math.sin(ar));
        ctx.rotate((p.angle - 90) * (Math.PI / 180));
        sh.draw(ctx, frame, size, size);
        ctx.restore();
    }

    // ---- floor + kart + tile primitives ----
    var TILE_FALLBACK = { "dirt.png": "#6b5640", "grass.png": "#4f9e57", "sand.png": "#c9b483", "ice.png": "#bfe9f0", "lava.png": "#cf1020" };
    function floor(ctx, file, tile) {
        var im = img(file);
        if (ready(im)) { for (var y = 0; y < H; y += tile) { for (var x = 0; x < W; x += tile) { ctx.drawImage(im, x, y, tile, tile); } } }
        else { ctx.fillStyle = TILE_FALLBACK[file] || "#555"; ctx.fillRect(0, 0, W, H); }
    }
    // PORT (look): getPlayerSprite — glossy procedural disc.
    function kart(ctx, x, y, r, color, opts) {
        opts = opts || {};
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 4; ctx.fill(); ctx.shadowBlur = 0;
        var g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.42, r * 0.1, x, y, r);
        g.addColorStop(0, "rgba(255,255,255,0.6)"); g.addColorStop(0.5, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(0,0,0,0.35)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
        ctx.lineWidth = Math.max(1, r * 0.18); ctx.strokeStyle = opts.outline || "#141414";
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
        ctx.restore();
    }
    // Infected kart (PORT look: draw.js drawPlayer infected branch) — a red disc
    // with the biohazard mark and a green outline, the game's infection artwork.
    function infectedKart(ctx, x, y, r) {
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = "#c0231b"; ctx.fill();
        var bio = img("biohazard-solid.svg");
        if (ready(bio)) { var sz = r * 1.5; ctx.drawImage(bio, x - sz / 2, y - sz / 2, sz, sz); }
        ctx.lineWidth = 2; ctx.strokeStyle = "green"; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
        ctx.restore();
    }
    function bumper(ctx, x, y, r) {
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, 2 * Math.PI); ctx.strokeStyle = "#E5392B"; ctx.lineWidth = 3; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = "orange"; ctx.fill();
        ctx.restore();
    }
    function goalZone(ctx, x, y, w, h) {
        ctx.save(); ctx.fillStyle = "#FFCB30"; ctx.strokeStyle = "#756300"; ctx.lineWidth = 4;
        ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); ctx.restore();
    }
    function pad(ctx, x, y, r, iconFile, dim) {
        ctx.save(); var d = img("dirt.png");
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.clip();
        if (ready(d)) { ctx.drawImage(d, x - r, y - r, r * 2, r * 2); } else { ctx.fillStyle = "#6b5640"; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
        ctx.restore();
        ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.strokeStyle = "#cfcfcf"; ctx.lineWidth = 2; ctx.stroke();
        var ic = iconFile && img(iconFile);
        if (ic && ready(ic)) { ctx.globalAlpha = dim ? 0.25 : 1; var s = r * 1.1; ctx.drawImage(ic, x - s / 2, y - s / 2, s, s); }
        ctx.restore();
    }

    // ---- helper: move a fake kart and set velocity for the dust thresholds ----
    // velMag drives the particle thresholds (vs MAXSPEED); visSpeed is how fast it
    // visibly crosses the canvas (decoupled so cards read at a calm pace).
    function drive(p, dirX, dirY, velMag, visSpeed, dt) {
        p.velX = dirX * velMag; p.velY = dirY * velMag;
        p.angle = Math.atan2(dirY, dirX) * 180 / Math.PI;
        p.x += dirX * visSpeed * dt / 1000; p.y += dirY * visSpeed * dt / 1000;
    }

    var env = { W: W, H: H, img: img, ready: ready, loop: loop, lerp: lerp, ease: ease, ping: ping, clamp: clamp,
        floor: floor, kart: kart, bumper: bumper, goalZone: goalZone, pad: pad, drive: drive, drawFlame: drawFlame,
        drawSpeedFx: drawSpeedFx, updateMovementParticles: updateMovementParticles,
        spawnPunchEffect: spawnPunchEffect, spawnHitEffect: spawnHitEffect, spawnTeleportPuff: spawnTeleportPuff,
        spawnSlashEffect: spawnSlashEffect, spawnExplosion: spawnExplosion, spawnScreenFlash: spawnScreenFlash,
        spawnMuzzleFlash: spawnMuzzleFlash,
        BLUE: BLUE, RED: RED, GREEN: GREEN, YELLOW: YELLOW, PURPLE: PURPLE };

    // Fire a one-shot spawn once per loop cycle. `key` namespaces each spawn so a
    // scene can schedule several (e.g. bomb's muzzle + explosion) without them
    // clobbering each other's last-cycle marker. `t` may be offset to fire mid-cycle.
    function onCycle(mem, t, period, key, fn) {
        var c = Math.floor(t / period), k = "_c_" + key;
        // Baseline on the first sighting (e.g. the t=0 attach frame, where a
        // negative offset gives c=-1) WITHOUT firing — otherwise a punch/bomb/
        // explosion burst pops at scene start before the karts are in position.
        // The next real cycle crossing fires at the intended beat.
        if (mem[k] === undefined) { mem[k] = c; return; }
        if (mem[k] !== c) { mem[k] = c; fn(); }
    }

    // ========================= SCENES =========================
    // s = { ctx, t, dt, mem, opts, p }. Background already cleared. Effects in
    // s' card list are advanced + drawn ON TOP after the scene returns.

    function terrain(surface, file, tile, velMag, visSpeed, wobble) {
        return function (s) {
            floor(s.ctx, file, tile);
            var p = s.p; p.surface = surface; p.radius = 12; p.alive = true;
            var span = W + 60;
            // wrap horizontally
            if (p.x == null || p.x > W + 30) { p.x = -30; p.y = H / 2; }
            drive(p, 1, 0, velMag, visSpeed, s.dt);
            if (wobble) { p.y = H / 2 + Math.sin(s.t / 180) * 16; p.velY = Math.cos(s.t / 180) * velMag * 0.5; }
            updateMovementParticles(p, s.dt);
            kart(s.ctx, p.x, p.y, p.radius, BLUE);
        };
    }
    SCENES["terrainNormal"] = terrain("normal", "dirt.png", 60, MAXSPEED * 0.62, 95, false);
    SCENES["terrainFast"] = terrain("fast", "grass.png", 70, MAXSPEED * 0.72, 120, false);
    SCENES["terrainSlow"] = terrain("slow", "sand.png", 60, MAXSPEED * 0.22, 42, false);
    SCENES["terrainIce"] = terrain("ice", "ice.png", 80, MAXSPEED * 0.72, 115, true);

    SCENES["terrainWater"] = function (s) {
        // Deep water (procedural in-game, no texture): flat blue with a kart
        // punch-swimming across — a stroke pulse every beat, ripples trailing.
        var ctx = s.ctx;
        ctx.fillStyle = "#2f6fb0";
        ctx.fillRect(0, 0, W, H);
        var p = s.p; p.radius = 12; p.alive = true; p.surface = "normal";
        if (p.x == null || p.x > W + 30) { p.x = -30; p.y = H / 2; }
        // Slow baseline drift; each "stroke" adds a surge that decays.
        var beat = loop(s.t, 900);
        var surge = Math.max(0, 1 - beat * 3);
        p.x += (8 + surge * 55) * (s.dt / 1000) * 4;
        onCycle(s.mem, s.t, 900, "stroke", function () {
            s.mem.ripples = s.mem.ripples || [];
            s.mem.ripples.push({ x: p.x, y: p.y, at: s.t });
        });
        var ripples = s.mem.ripples || [];
        ctx.save();
        for (var i = ripples.length - 1; i >= 0; i--) {
            var age = (s.t - ripples[i].at) / 1100;
            if (age > 1) { ripples.splice(i, 1); continue; }
            ctx.globalAlpha = 0.4 * (1 - age);
            ctx.strokeStyle = "#bcd9f5";
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(ripples[i].x, ripples[i].y, 6 + age * 26, 0, 2 * Math.PI); ctx.stroke();
        }
        ctx.restore();
        kart(ctx, p.x, p.y, p.radius, BLUE);
    };

    SCENES["lavaBurn"] = function (s) {
        floor(s.ctx, "lava.png", 80);
        var p = s.p; p.radius = 12; p.alive = true; p.surface = "normal";
        if (p.x == null || p.x > W * 0.7) { p.x = -22; p.y = H / 2; p.onFire = 0; }
        drive(p, 1, 0, MAXSPEED * 0.5, 70, s.dt);
        if (p.x > W * 0.4) { p.onFire = 4000; }       // ignite mid-screen
        updateMovementParticles(p, s.dt);
        // flame BEHIND the kart, matching draw.js drawPlayer (drawFire before sprite)
        if (p.onFire > 0) { drawFlame(s.ctx, p); }
        kart(s.ctx, p.x, p.y, p.radius, BLUE);
    };

    // The collapse: lava floods in from all edges; a lava-red shockwave ring
    // (PORT: draw.js drawCollapseShockwaves) pulses out; the kart scrambles for
    // the shrinking centre.
    SCENES["collapse"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var inset = lerp(0, 50, ease(ping(s.t, 5000)));
        var lv = img("lava.png");
        s.ctx.save();
        var pat = ready(lv) ? s.ctx.createPattern(lv, "repeat") : null;
        s.ctx.fillStyle = pat || "#cf1020";
        s.ctx.fillRect(0, 0, W, inset); s.ctx.fillRect(0, H - inset, W, inset);
        s.ctx.fillRect(0, 0, inset, H); s.ctx.fillRect(W - inset, 0, inset, H);
        s.ctx.strokeStyle = "#7a1500"; s.ctx.lineWidth = 3; s.ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
        s.ctx.restore();
        var sw = loop(s.t, 1600);                       // expanding shockwave ring
        s.ctx.save(); s.ctx.globalAlpha = 0.6 * (1 - sw); s.ctx.strokeStyle = "#cf1020"; s.ctx.lineWidth = 6;
        s.ctx.beginPath(); s.ctx.arc(W / 2, H / 2, sw * 90, 0, 2 * Math.PI); s.ctx.stroke(); s.ctx.restore();
        var safeW = Math.max(8, (W / 2 - inset) - 18), safeH = Math.max(6, (H / 2 - inset) - 14);
        kart(s.ctx, W / 2 + Math.cos(s.t / 420) * safeW, H / 2 + Math.sin(s.t / 320) * safeH, 12, BLUE);
    };

    SCENES["fire"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var p = s.p; p.radius = 12; p.alive = true; p.surface = "normal";
        if (p.x == null || p.x > W + 30) { p.x = -30; p.y = H / 2; }
        drive(p, 1, 0, MAXSPEED * 0.45, 70, s.dt);
        p.onFire = 500 + loop(s.t, 6000) * 5200;       // escalate red→purple
        updateMovementParticles(p, s.dt);
        drawFlame(s.ctx, p);                      // flame behind, kart on top (matches game)
        kart(s.ctx, p.x, p.y, p.radius, BLUE);
    };

    SCENES["goalRun"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        goalZone(s.ctx, W - 46, 18, 34, H - 36);
        var p = s.p; p.radius = 12; p.surface = "normal"; p.alive = true;
        if (p.x == null || p.x > W - 30) { p.x = -20; p.y = H / 2; }
        drive(p, 1, 0, MAXSPEED * 0.62, 95, s.dt);
        updateMovementParticles(p, s.dt);
        kart(s.ctx, p.x, p.y, p.radius, BLUE);
    };

    SCENES["pickup"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var p = s.p; p.radius = 12; p.surface = "normal"; p.alive = true;
        var ph = loop(s.t, 3000), grabbed = ph > 0.5;
        pad(s.ctx, W / 2, H / 2, 18, "bomb.svg", grabbed);
        if (p.x == null || p.x > W + 20) { p.x = -20; p.y = H / 2; }
        drive(p, 1, 0, MAXSPEED * 0.45, 80, s.dt);
        updateMovementParticles(p, s.dt);
        onCycle(s.mem, s.t, 3000, "grab", function () { spawnTeleportPuff(W / 2, H / 2, "#ffffff"); });
        kart(s.ctx, p.x, p.y, p.radius, BLUE);
    };

    SCENES["bumper"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var bx = W * 0.66, by = H / 2, p = s.p; p.radius = 11; p.surface = "normal"; p.alive = true;
        var ph = ping(s.t, 2400), x = lerp(-20, bx - 26, ease(ph));
        p.velX = (ph < 0.5 ? 1 : -1) * MAXSPEED * 0.5; p.velY = 0; p.angle = ph < 0.5 ? 0 : 180;
        p.x = x; p.y = by;
        updateMovementParticles(p, s.dt);
        kart(s.ctx, x, by, p.radius, BLUE);
        bumper(s.ctx, bx, by, 11);
        // fire the knockback burst at the bounce apex (ping peaks at t%2400 ≈ 1200)
        onCycle(s.mem, s.t - 1200, 2400, "bounce", function () { spawnPunchEffect(bx - 16, by, 14, "#E5392B", 180); });
    };

    SCENES["randomTile"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var tiles = ["grass.png", "ice.png", "sand.png"], which = Math.floor(s.t / 700) % tiles.length;
        var px = W / 2 - 28, py = H / 2 - 24, pw = 56, ph = 48, im = img(tiles[which]);
        s.ctx.save(); s.ctx.beginPath(); s.ctx.rect(px, py, pw, ph); s.ctx.clip();
        if (ready(im)) { s.ctx.drawImage(im, px, py, pw, ph); } else { s.ctx.fillStyle = "#888"; s.ctx.fillRect(px, py, pw, ph); }
        s.ctx.restore();
        s.ctx.save(); s.ctx.strokeStyle = "#7c3aed"; s.ctx.lineWidth = 3; s.ctx.strokeRect(px, py, pw, ph);
        s.ctx.fillStyle = "#7c3aed"; s.ctx.font = "bold 22px sans-serif"; s.ctx.textAlign = "center"; s.ctx.textBaseline = "middle";
        s.ctx.globalAlpha = 0.85; s.ctx.fillText("?", W / 2, H / 2); s.ctx.restore();
    };

    SCENES["punch"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ph = loop(s.t, 2400), hit = ease(clamp(ph / 0.5, 0, 1));
        var rx = lerp(W * 0.12, W * 0.44, hit), contact = ph >= 0.5;
        var bx = W * 0.56 + (contact ? ease(clamp((ph - 0.5) / 0.4, 0, 1)) * 38 : 0);
        kart(s.ctx, rx, H / 2, 12, RED); kart(s.ctx, bx, H / 2, 12, BLUE);
        onCycle(s.mem, s.t - 1200, 2400, "punch", function () {
            spawnPunchEffect(W * 0.5, H / 2, 14, RED, 0); spawnHitEffect(W * 0.5, H / 2, "#fff");
        });
    };

    SCENES["swap"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ph = loop(s.t, 3000), ax = W * 0.25, bx = W * 0.75, y = H / 2;
        var sMove = ph > 0.45 ? ease(clamp((ph - 0.45) / 0.4, 0, 1)) : 0;
        var x1 = lerp(ax, bx, sMove), x2 = lerp(bx, ax, sMove);
        if (ph < 0.5) { var rr = 8 + ease(loop(s.t, 1500)) * 18; s.ctx.save(); s.ctx.globalAlpha = 0.6; s.ctx.strokeStyle = RED; s.ctx.lineWidth = 2; s.ctx.beginPath(); s.ctx.arc(ax, y, rr, 0, 2 * Math.PI); s.ctx.stroke(); s.ctx.restore(); }
        onCycle(s.mem, s.t - 1350, 3000, "swap", function () { spawnTeleportPuff(ax, y, BLUE); spawnTeleportPuff(bx, y, RED); });
        kart(s.ctx, x1, y, 12, BLUE); kart(s.ctx, x2, y, 12, RED);
    };

    SCENES["bomb"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ph = loop(s.t, 3200), land = 0.5, bxp = W * 0.6, byp = H / 2;
        // After the blast the ground there is scorched into SLOW SAND (game:
        // explodeBomb sets cells to tileMap.slow). Bloom a sand patch post-explosion.
        if (ph >= land) {
            var se = clamp((ph - land) / 0.25, 0, 1), rr = ease(se) * 34, sand = img("sand.png");
            s.ctx.save(); s.ctx.beginPath(); s.ctx.arc(bxp, byp, rr, 0, 2 * Math.PI); s.ctx.clip();
            if (ready(sand)) { s.ctx.drawImage(sand, bxp - rr, byp - rr, rr * 2, rr * 2); } else { s.ctx.fillStyle = "#c9b483"; s.ctx.fillRect(bxp - rr, byp - rr, rr * 2, rr * 2); }
            s.ctx.restore();
        }
        if (ph < land) { var pp = ph / land, x = lerp(20, bxp, pp), y = lerp(H * 0.6, byp, pp) - Math.sin(pp * Math.PI) * 50;
            var bi = img("bomb.svg");                   // the real bomb art (draw.js bombImage)
            if (ready(bi)) { s.ctx.save(); s.ctx.translate(x, y); s.ctx.rotate(s.t / 200); var bs = 20; s.ctx.drawImage(bi, -bs / 2, -bs / 2, bs, bs); s.ctx.restore(); }
            else { s.ctx.fillStyle = "#222"; s.ctx.beginPath(); s.ctx.arc(x, y, 7, 0, 2 * Math.PI); s.ctx.fill(); }
            onCycle(s.mem, s.t, 3200, "fire", function () { spawnMuzzleFlash(20, H * 0.6, -60, "#ffd23a"); });
        } else { var e = (ph - land) / (1 - land); kart(s.ctx, lerp(bxp + 6, bxp + 40, ease(e)), byp, 11, RED);
            onCycle(s.mem, s.t - 1600, 3200, "boom", function () { spawnExplosion(bxp, byp, 60, "#ff7a18"); }); }
        kart(s.ctx, bxp, byp, 12, BLUE);
    };

    SCENES["speedBurst"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var p = s.p; p.radius = 12; p.surface = "normal"; p.alive = true; p.speedBuffUntil = 1e15;
        if (p.x == null || p.x > W + 30) { p.x = -30; p.y = H / 2; }
        drive(p, 1, 0, MAXSPEED * 0.9, 150, s.dt);
        updateMovementParticles(p, s.dt);
        drawSpeedFx(s.ctx, p, s.t);
        kart(s.ctx, p.x, p.y, p.radius, BLUE);
    };

    SCENES["slowdown"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var fast = loop(s.t, 1500), slow = loop(s.t, 5200);
        kart(s.ctx, lerp(-20, W + 20, fast), H * 0.32, 12, BLUE);
        var a = { x: lerp(-20, W + 20, slow), y: H * 0.6, radius: 11, velX: MAXSPEED * 0.2, velY: 0, speedDebuffUntil: 1e15 };
        var b = { x: lerp(-60, W - 20, slow), y: H * 0.82, radius: 11, velX: MAXSPEED * 0.2, velY: 0, speedDebuffUntil: 1e15 };
        drawSpeedFx(s.ctx, a, s.t); drawSpeedFx(s.ctx, b, s.t);
        kart(s.ctx, a.x, a.y, 11, RED); kart(s.ctx, b.x, b.y, 11, GREEN);
    };

    SCENES["tileSwap"] = function (s) {
        var ph = ping(s.t, 3400), a = img("grass.png"), b = img("ice.png");
        function half(im, x, alpha) { s.ctx.save(); s.ctx.globalAlpha = alpha; s.ctx.beginPath(); s.ctx.rect(x, 0, W / 2, H); s.ctx.clip();
            if (ready(im)) { for (var yy = 0; yy < H; yy += 70) { for (var xx = x; xx < x + W / 2; xx += 70) { s.ctx.drawImage(im, xx, yy, 70, 70); } } } s.ctx.restore(); }
        half(a, 0, 1 - ease(ph)); half(b, 0, ease(ph)); half(b, W / 2, 1 - ease(ph)); half(a, W / 2, ease(ph));
        s.ctx.strokeStyle = "rgba(255,255,255,0.5)"; s.ctx.lineWidth = 1; s.ctx.beginPath(); s.ctx.moveTo(W / 2, 0); s.ctx.lineTo(W / 2, H); s.ctx.stroke();
        kart(s.ctx, W / 2, H / 2, 12, BLUE);
    };

    SCENES["iceCannon"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ph = loop(s.t, 3200), land = 0.4, lx = W * 0.66, ly = H / 2;
        if (ph >= land) { var e = clamp((ph - land) / 0.3, 0, 1), rr = ease(e) * 30, ice = img("ice.png");
            s.ctx.save(); s.ctx.beginPath(); s.ctx.arc(lx, ly, rr, 0, 2 * Math.PI); s.ctx.clip();
            if (ready(ice)) { s.ctx.drawImage(ice, lx - rr, ly - rr, rr * 2, rr * 2); } else { s.ctx.fillStyle = "#bfe9f0"; s.ctx.fillRect(lx - rr, ly - rr, rr * 2, rr * 2); }
            s.ctx.restore();
            onCycle(s.mem, s.t - 1280, 3200, "ice", function () { spawnExplosion(lx, ly, 34, "#9fe8ff"); });
        } else { var pp = ph / land, sx = lerp(W * 0.2 + 8, lx, pp); s.ctx.fillStyle = "#9fe8ff"; s.ctx.beginPath(); s.ctx.arc(sx, ly - Math.sin(pp * Math.PI) * 22, 5, 0, 2 * Math.PI); s.ctx.fill();
            onCycle(s.mem, s.t, 3200, "fire", function () { spawnMuzzleFlash(W * 0.2 + 8, ly, 0, "#bfeaff"); }); }
        kart(s.ctx, W * 0.2, ly, 12, BLUE);
    };

    SCENES["cut"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        // One slash line through the cutter; rivals are flung AWAY from that line
        // (perpendicular), each to whichever side they were on.
        var ph = loop(s.t, 2600), ang = 18 * Math.PI / 180, perp = ang + Math.PI / 2;
        var push = ease(clamp((ph - 0.35) / 0.4, 0, 1)) * 40, cols = [RED, GREEN, YELLOW, PURPLE];
        var along = [-36, 36, -14, 14], side = [1, 1, -1, -1];
        for (var i = 0; i < 4; i++) {
            var bx = W / 2 + Math.cos(ang) * along[i], by = H / 2 + Math.sin(ang) * along[i], d = (10 + push) * side[i];
            kart(s.ctx, bx + Math.cos(perp) * d, by + Math.sin(perp) * d, 9, cols[i]);
        }
        onCycle(s.mem, s.t - 910, 2600, "cut", function () { spawnSlashEffect(W / 2, H / 2, 18, "#cfe"); });
        kart(s.ctx, W / 2, H / 2, 12, BLUE);
    };

    SCENES["starPower"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        // A rival kart sits in the lane; the starred kart plows straight through it
        // untouched (the rival is bumped aside as the star passes).
        var p = s.p; p.radius = 12; p.surface = "normal"; p.alive = true;
        if (p.x == null || p.x > W + 30) { p.x = -30; p.y = H / 2; }
        drive(p, 1, 0, MAXSPEED * 0.7, 120, s.dt);
        var hue = (s.t * 0.35) % 360;
        // Rainbow star trail behind the kart.
        for (var i = 1; i <= 6; i++) {
            var tx = p.x - i * 13;
            if (tx < -10) { continue; }
            var h2 = (hue + i * 40) % 360;
            var ty = p.y + Math.sin(s.t / 200 + i) * 5;
            var sz = 4.5 - i * 0.4;
            s.ctx.save();
            s.ctx.translate(tx, ty);
            s.ctx.rotate(s.t / 350 + i);
            s.ctx.globalAlpha = 1 - i * 0.13;
            s.ctx.fillStyle = "hsl(" + h2.toFixed(0) + ",100%,65%)";
            s.ctx.beginPath();
            for (var k = 0; k < 10; k++) {
                var a = -Math.PI / 2 + k * Math.PI / 5, r = (k % 2 === 0) ? sz : sz * 0.45;
                var x = Math.cos(a) * r, y = Math.sin(a) * r;
                if (k === 0) { s.ctx.moveTo(x, y); } else { s.ctx.lineTo(x, y); }
            }
            s.ctx.closePath(); s.ctx.fill();
            s.ctx.restore();
        }
        // Rival shoved aside as the invulnerable kart barrels past.
        var rx = W * 0.62, dx = p.x - rx;
        var shove = clamp(1 - Math.abs(dx) / 50, 0, 1) * (dx > -10 ? 1 : 0);
        kart(s.ctx, rx, H / 2 - 24 * ease(shove), 10, RED);
        // Rainbow aura + ring on the starred kart.
        s.ctx.save();
        s.ctx.globalAlpha = 0.35;
        s.ctx.fillStyle = "hsl(" + hue.toFixed(0) + ",100%,65%)";
        s.ctx.beginPath(); s.ctx.arc(p.x, p.y, p.radius * 2, 0, 2 * Math.PI); s.ctx.fill();
        s.ctx.globalAlpha = 0.9;
        s.ctx.strokeStyle = "hsl(" + hue.toFixed(0) + ",100%,60%)";
        s.ctx.lineWidth = 2;
        s.ctx.beginPath(); s.ctx.arc(p.x, p.y, p.radius + 4, 0, 2 * Math.PI); s.ctx.stroke();
        s.ctx.restore();
        kart(s.ctx, p.x, p.y, p.radius, BLUE);
    };

    SCENES["orbitalBeam"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ctx = s.ctx;
        var period = 4200, fire = 0.78;          // strike at 78% of the loop
        var ph = loop(s.t, period), struck = ph >= fire;
        var lx0 = W * 0.30, ly = H / 2, lx1 = W * 0.95, bw = 20; // beam band
        var icePatch = W * 0.52, sandPatch = W * 0.74, pw = 16;  // the two transmuted patches
        function patch(px, tex, fallback) {
            var im = img(tex);
            ctx.save(); ctx.beginPath(); ctx.rect(px - pw, ly - bw, pw * 2, bw * 2); ctx.clip();
            if (ready(im)) { for (var yy = ly - bw; yy < ly + bw; yy += 30) { for (var xx = px - pw; xx < px + pw; xx += 30) { ctx.drawImage(im, xx, yy, 30, 30); } } }
            else { ctx.fillStyle = fallback; ctx.fillRect(px - pw, ly - bw, pw * 2, bw * 2); }
            ctx.restore();
        }
        // Before the strike: ice + sand sitting in the line. After: water + lava.
        if (!struck) { patch(icePatch, "ice.png", "#bfe9f0"); patch(sandPatch, "sand.png", "#caa56a"); }
        else { ctx.save(); ctx.fillStyle = "#2f6fb0"; ctx.fillRect(icePatch - pw, ly - bw, pw * 2, bw * 2); ctx.restore(); patch(sandPatch, "lava.png", "#cf1020"); }
        if (!struck) {
            // Warning band + center line: pulses faster and reddens as the strike nears.
            var prog = ph / fire;
            var pulse = 0.5 + 0.5 * Math.sin(s.t / 1000 * (1.5 + 6 * prog) * Math.PI * 2);
            var hot = prog > 0.66;
            ctx.save();
            ctx.globalAlpha = (0.08 + 0.25 * prog) * (0.6 + 0.4 * pulse);
            ctx.fillStyle = hot ? "#ff5a2a" : "#b388ff";
            ctx.fillRect(lx0, ly - bw, lx1 - lx0, bw * 2);
            ctx.globalAlpha = 0.4 + 0.55 * pulse;
            ctx.strokeStyle = hot ? "#ffd24a" : "#e0c8ff";
            ctx.lineWidth = lerp(1.5, 5, prog); ctx.lineCap = "round";
            ctx.beginPath(); ctx.moveTo(lx0, ly); ctx.lineTo(lx1, ly); ctx.stroke();
            ctx.restore();
        } else {
            // Hot strike flash, fading out.
            var fade = 1 - clamp((ph - fire) / (1 - fire), 0, 1);
            ctx.save();
            ctx.globalAlpha = 0.5 * fade; ctx.fillStyle = "#ff6a1a"; ctx.fillRect(lx0, ly - bw, lx1 - lx0, bw * 2);
            ctx.globalAlpha = 0.85 * fade; ctx.fillStyle = "#fff3c0"; ctx.fillRect(lx0, ly - bw * 0.55, lx1 - lx0, bw * 1.1);
            ctx.restore();
            onCycle(s.mem, s.t - period * fire, period, "ob", function () {
                spawnExplosion(icePatch, ly, 24, "#9fe8ff"); spawnExplosion(sandPatch, ly, 24, "#ffb070");
            });
        }
        kart(ctx, lx0 - 6, ly, 11, BLUE); // the caster at the beam's source
    };

    SCENES["blindfold"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        kart(s.ctx, W * 0.3, H / 2, 11, RED); kart(s.ctx, W * 0.68, H * 0.6, 11, GREEN);
        var ux = W * 0.5, uy = H / 2; kart(s.ctx, ux, uy, 12, BLUE);
        var dark = ping(s.t, 3200);
        s.ctx.save(); s.ctx.globalAlpha = ease(dark) * 0.92;
        s.ctx.fillStyle = "#000"; s.ctx.fillRect(0, 0, W, H);
        s.ctx.globalCompositeOperation = "destination-out";
        var g = s.ctx.createRadialGradient(ux, uy, 14, ux, uy, 46); g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
        s.ctx.fillStyle = g; s.ctx.beginPath(); s.ctx.arc(ux, uy, 46, 0, 2 * Math.PI); s.ctx.fill(); s.ctx.restore();
    };

    SCENES["brutalIntro"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var icons = ["bolt-solid.svg", "cloud-solid.svg", "hockey-puck-solid.svg", "biohazard-solid.svg"], which = Math.floor(s.t / 800) % icons.length;
        onCycle(s.mem, s.t, 1600, "flash", function () { spawnScreenFlash("#b3261e", 0.4, 600); });
        var ic = img(icons[which]);
        if (ready(ic)) { s.ctx.save(); s.ctx.fillStyle = "rgba(255,255,255,0.9)"; s.ctx.beginPath(); s.ctx.arc(W / 2, H / 2, 30, 0, 2 * Math.PI); s.ctx.fill(); s.ctx.drawImage(ic, W / 2 - 22, H / 2 - 22, 44, 44); s.ctx.restore(); }
    };

    // EVERY racer starts the round already holding an ability (game:
    // applyBrutalAbilityRound gives each player one) — show karts with a held-
    // ability badge, and a power going off now and then.
    SCENES["abilityRain"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var icons = ["bomb.svg", "snowflake-solid.svg", "scissors-solid.svg"];
        var spots = [{ x: W * 0.25, y: H * 0.58, c: BLUE }, { x: W * 0.52, y: H * 0.4, c: RED }, { x: W * 0.78, y: H * 0.62, c: GREEN }];
        for (var i = 0; i < spots.length; i++) {
            var sp = spots[i]; kart(s.ctx, sp.x, sp.y, 12, sp.c);
            var ic = img(icons[i]), bob = Math.sin(s.t / 320 + i) * 3, by = sp.y - 24 + bob;
            s.ctx.save(); s.ctx.fillStyle = "rgba(255,255,255,0.92)"; s.ctx.beginPath(); s.ctx.arc(sp.x, by, 11, 0, 2 * Math.PI); s.ctx.fill();
            if (ready(ic)) { s.ctx.drawImage(ic, sp.x - 8, by - 8, 16, 16); } s.ctx.restore();
        }
        onCycle(s.mem, s.t, 1800, "fx", function () { spawnExplosion(W * 0.52, H * 0.4, 34, "#ff7a18"); });
    };

    SCENES["cloudy"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        kart(s.ctx, W * 0.4, H * 0.6, 11, BLUE); kart(s.ctx, W * 0.7, H * 0.4, 11, RED);
        var cl = img("cloud.svg");                      // the real cloud art (draw.js cloudImage)
        for (var i = 0; i < 3; i++) {
            var x = lerp(-80, W + 80, loop(s.t + i * 1700, 6500)), y = 22 + i * 42, cw = 96, ch = 60;
            if (ready(cl)) { s.ctx.save(); s.ctx.globalAlpha = 0.92; s.ctx.drawImage(cl, x - cw / 2, y - ch / 2, cw, ch); s.ctx.restore(); }
            else { s.ctx.save(); s.ctx.fillStyle = "rgba(225,228,235,0.85)"; s.ctx.beginPath(); s.ctx.ellipse(x, y, 38, 18, 0, 0, 2 * Math.PI); s.ctx.fill(); s.ctx.restore(); }
        }
    };

    SCENES["lightning"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        // EVERY racer is sped up (game: applyBrutalLightningRound gives all a big
        // speed bonus) — show the whole field tearing across with streaks.
        var lanes = [{ y: H * 0.3, c: BLUE, sp: 200 }, { y: H * 0.55, c: RED, sp: 230 }, { y: H * 0.8, c: GREEN, sp: 180 }];
        for (var i = 0; i < lanes.length; i++) {
            var x = lerp(-20, W + 20, loop(s.t + i * 700, 1100));
            s.ctx.save(); s.ctx.strokeStyle = "rgba(255,255,255,0.6)"; s.ctx.lineCap = "round"; s.ctx.lineWidth = 2;
            for (var k = 1; k <= 4; k++) { s.ctx.globalAlpha = 0.5 / k; s.ctx.beginPath(); s.ctx.moveTo(x - 12, lanes[i].y); s.ctx.lineTo(x - 12 - k * 11, lanes[i].y); s.ctx.stroke(); }
            s.ctx.restore();
            kart(s.ctx, x, lanes[i].y, 11, lanes[i].c);
        }
        onCycle(s.mem, s.t, 1800, "bolt", function () { spawnScreenFlash("#ffffff", 0.5, 180); });
        s.ctx.save(); s.ctx.strokeStyle = "#ffe23a"; s.ctx.lineWidth = 2; s.ctx.globalAlpha = loop(s.t, 1800) < 0.12 ? 1 : 0;
        s.ctx.beginPath(); s.ctx.moveTo(W * 0.5, 0); s.ctx.lineTo(W * 0.44, 40); s.ctx.lineTo(W * 0.54, 60); s.ctx.lineTo(W * 0.46, H); s.ctx.stroke(); s.ctx.restore();
    };

    SCENES["volcano"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ph = loop(s.t, 3600), cx = W / 2, cy = H / 2;
        if (ph < 0.45) { var rr = 6 + ease(ph / 0.45) * 26; s.ctx.save(); s.ctx.globalAlpha = 0.8; s.ctx.strokeStyle = "#ff8a3a"; s.ctx.lineWidth = 2; s.ctx.beginPath(); s.ctx.arc(cx, cy, rr, 0, 2 * Math.PI); s.ctx.stroke(); s.ctx.restore(); }
        onCycle(s.mem, s.t - 1620, 3600, "erupt", function () { spawnExplosion(cx, cy, 70, "#cf1020"); });
    };

    SCENES["bunker"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ph = loop(s.t, 4200), ctx = s.ctx, cx = W / 2, cy = H / 2;
        // The lava ring closes in from the edges toward the buried goal...
        var maxR = Math.min(W, H) * 0.62, minR = 44;
        var r = maxR - (maxR - minR) * ease(Math.min(1, ph / 0.75));
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = "#cf1020";
        ctx.lineWidth = 16;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
        ctx.restore();
        // ...over a sealed silo door that bursts gold for the lone survivor.
        var open = ph > 0.8;
        ctx.save();
        ctx.fillStyle = open ? "#e7c54a" : "#6b6f7a";
        ctx.beginPath(); ctx.arc(cx, cy, 26, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = "#2c2c33"; ctx.lineWidth = 3; ctx.stroke();
        if (!open) {
            ctx.strokeStyle = "#3a3e47"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(cx - 18, cy); ctx.lineTo(cx + 18, cy); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx, cy - 18); ctx.lineTo(cx, cy + 18); ctx.stroke();
        }
        ctx.restore();
    };

    SCENES["heatwave"] = function (s) {
        floor(s.ctx, "sand.png", 60);
        var ph = loop(s.t, 3000), ctx = s.ctx;
        var px = W * 0.5, py = H * 0.55, r = 34;
        // A patch of ground burns over: a hot flash, then a lingering scorched rim.
        if (ph > 0.3) {
            var burn = Math.min(1, (ph - 0.3) / 0.15);
            ctx.save();
            ctx.globalAlpha = 0.85 * burn;
            ctx.fillStyle = "#d8431f";
            ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI); ctx.fill();
            ctx.globalAlpha = 0.9 * burn;
            ctx.strokeStyle = "#1d130b";
            ctx.lineWidth = 5;
            ctx.stroke();
            ctx.restore();
        }
        if (ph > 0.3 && ph < 0.5) {
            var fl = 1 - (ph - 0.3) / 0.2;
            ctx.save();
            ctx.globalAlpha = 0.6 * fl;
            ctx.fillStyle = "#ffb24a";
            ctx.beginPath(); ctx.arc(px, py, r + 8, 0, 2 * Math.PI); ctx.fill();
            ctx.restore();
        }
        // Warm grade washes over the card while the heat is on.
        ctx.save();
        ctx.globalAlpha = 0.10 * (ph > 0.3 ? 1 : ph / 0.3);
        ctx.fillStyle = "#ff7a26";
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
    };

    SCENES["infection"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ph = loop(s.t, 4000), carrierX = lerp(W * 0.1, W * 0.9, ph);
        var spots = [{ x: W * 0.35, y: H * 0.4 }, { x: W * 0.6, y: H * 0.65 }, { x: W * 0.8, y: H * 0.4 }];
        for (var i = 0; i < spots.length; i++) { var turned = carrierX > spots[i].x; if (turned) { infectedKart(s.ctx, spots[i].x, spots[i].y, 12); } else { kart(s.ctx, spots[i].x, spots[i].y, 11, BLUE); } }
        infectedKart(s.ctx, carrierX, H * 0.55, 12);
    };

    SCENES["hockey"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var px = 20 + Math.abs(((s.t / 4) % (2 * (W - 40))) - (W - 40));
        var py = 18 + Math.abs(((s.t / 3.1) % (2 * (H - 36))) - (H - 36));
        kart(s.ctx, W * 0.5, H * 0.5, 11, BLUE);
        s.ctx.save(); s.ctx.fillStyle = "#111"; s.ctx.beginPath(); s.ctx.arc(px, py, 8, 0, 2 * Math.PI); s.ctx.fill(); s.ctx.strokeStyle = "rgba(255,255,255,0.6)"; s.ctx.lineWidth = 1; s.ctx.stroke(); s.ctx.restore();
    };

    SCENES["explosive"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ph = loop(s.t, 3000), cx = W / 2, cy = H / 2;
        // after the blast the crater is LAVA (game: explodeLava turns cells to lava on death)
        if (ph >= 0.45) {
            var le = clamp((ph - 0.45) / 0.25, 0, 1), lr = ease(le) * 40, lv = img("lava.png");
            s.ctx.save(); s.ctx.beginPath(); s.ctx.arc(cx, cy, lr, 0, 2 * Math.PI); s.ctx.clip();
            if (ready(lv)) { s.ctx.drawImage(lv, cx - lr, cy - lr, lr * 2, lr * 2); } else { s.ctx.fillStyle = "#cf1020"; s.ctx.fillRect(cx - lr, cy - lr, lr * 2, lr * 2); }
            s.ctx.restore();
            s.ctx.save(); s.ctx.strokeStyle = "#7a1500"; s.ctx.lineWidth = 2; s.ctx.beginPath(); s.ctx.arc(cx, cy, lr, 0, 2 * Math.PI); s.ctx.stroke(); s.ctx.restore();
        }
        if (ph < 0.45) { var rr = 6 + ease(ph / 0.45) * 20; s.ctx.save(); s.ctx.globalAlpha = 0.85; s.ctx.strokeStyle = "#ff5b3a"; s.ctx.lineWidth = 2; s.ctx.beginPath(); s.ctx.arc(cx, cy, rr, 0, 2 * Math.PI); s.ctx.stroke(); s.ctx.restore(); kart(s.ctx, cx, cy, 11, RED); }
        else { var e = (ph - 0.45) / 0.55, sp = ease(clamp(e, 0, 1)) * 44; kart(s.ctx, cx - 18 - sp, cy - 8, 10, BLUE); kart(s.ctx, cx + 18 + sp, cy + 8, 10, GREEN); }
        onCycle(s.mem, s.t - 1350, 3000, "boom", function () { spawnExplosion(cx, cy, 60, "#ff7a18"); });
    };

    SCENES["blackout"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        goalZone(s.ctx, W - 40, 30, 26, H - 60);
        var ux = lerp(W * 0.15, W * 0.7, ping(s.t, 4000)), uy = H / 2;
        kart(s.ctx, W * 0.5, H * 0.3, 10, RED); kart(s.ctx, ux, uy, 12, BLUE);
        s.ctx.save(); s.ctx.fillStyle = "rgba(0,0,0,0.93)"; s.ctx.fillRect(0, 0, W, H);
        s.ctx.globalCompositeOperation = "destination-out";
        var g = s.ctx.createRadialGradient(ux, uy, 8, ux, uy, 40); g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
        s.ctx.fillStyle = g; s.ctx.beginPath(); s.ctx.arc(ux, uy, 40, 0, 2 * Math.PI); s.ctx.fill(); s.ctx.restore();
    };

    SCENES["medalShine"] = function (s) {
        var ctx = s.ctx;
        var grd = ctx.createLinearGradient(0, 0, W, H); grd.addColorStop(0, "rgba(255,255,255,0.06)"); grd.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
        var glyph = (s.opts && s.opts.glyph) || "🏅", pulse = 1 + ping(s.t, 2200) * 0.08;
        ctx.font = Math.round(56 * pulse) + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(glyph, W / 2, H / 2 + 2);
        var sx = lerp(-30, W + 30, loop(s.t, 2600)); var sg = ctx.createLinearGradient(sx - 30, 0, sx + 30, 0);
        sg.addColorStop(0, "rgba(255,255,255,0)"); sg.addColorStop(0.5, "rgba(255,255,255,0.35)"); sg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = sg; ctx.fillRect(sx - 30, 0, 60, H);
        for (var i = 0; i < 4; i++) { var a = ping(s.t + i * 500, 2000); ctx.globalAlpha = a; ctx.fillStyle = "#ffe9a8";
            ctx.beginPath(); ctx.arc(W / 2 + Math.cos(i * 1.7) * 46, H / 2 + Math.sin(i * 2.3) * 34, 2 + a * 2, 0, 2 * Math.PI); ctx.fill(); ctx.globalAlpha = 1; }
    };

    SCENES["_blank"] = function (s) { floor(s.ctx, "dirt.png", 60); };

    // ========================= engine =========================
    var items = [];   // { canvas, ctx, scene, opts, fx, p, mem, t, last, visible }
    var rafId = null;

    function drawItem(it, ts) {
        if (!it.last) { it.last = ts; }
        var dt = clamp(ts - it.last, 0, 50); it.last = ts; it.t += dt;
        _fx = it.fx;
        var ctx = it.ctx;
        ctx.clearRect(0, 0, W, H);
        // save/restore isolates any canvas state a scene leaves (globalAlpha, font,
        // a stray transform) from the effects layer and the next frame.
        ctx.save();
        try { it.scene({ ctx: ctx, t: it.t, dt: dt, mem: it.mem, opts: it.opts, p: it.p }); } catch (err) { /* one bad scene must not kill the loop */ }
        ctx.restore();
        try { updateFX(it.fx, dt); drawFX(it.fx, ctx); } catch (err2) { /* */ }
        _fx = null;
    }
    // Reduced-motion draws each card only once (no rAF), so a texture/flame/icon
    // that decodes AFTER that single draw would never appear. Redraw visible cards
    // when an image finishes loading to fill them in.
    function redrawVisibleStatic() {
        if (!reduceMotion) { return; }
        for (var i = 0; i < items.length; i++) { if (items[i].visible) { drawItem(items[i], performance.now()); } }
    }
    function frame(ts) {
        rafId = null; var any = false;
        for (var i = 0; i < items.length; i++) { if (!items[i].visible) { continue; } any = true; drawItem(items[i], ts); }
        if (any && !reduceMotion) { rafId = requestAnimationFrame(frame); }
    }
    function ensureLoop() { if (rafId == null) { rafId = requestAnimationFrame(frame); } }
    function find(canvas) { for (var i = 0; i < items.length; i++) { if (items[i].canvas === canvas) { return items[i]; } } return null; }

    var io = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
            var it = find(entries[i].target); if (!it) { continue; }
            it.visible = entries[i].isIntersecting;
            if (it.visible) { if (reduceMotion) { it.last = 0; drawItem(it, performance.now()); } else { ensureLoop(); } }
        }
    }, { root: null, threshold: 0.05 }) : null;

    function attach(canvas, sceneName, opts) {
        if (!canvas) { return; }
        var scene = SCENES[sceneName] || SCENES["_blank"];
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        var ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
        var it = { canvas: canvas, ctx: ctx, scene: scene, opts: opts || {}, fx: makeFX(), p: { radius: 12, alive: true }, mem: {}, t: 0, last: 0, visible: false };
        items.push(it);
        drawItem(it, performance.now());          // one frame so it's never blank
        if (io) { io.observe(canvas); } else { it.visible = true; if (!reduceMotion) { ensureLoop(); } }
    }

    function staticIcon(canvas, name) {
        if (!canvas) { return; }
        var dpr = Math.min(2, window.devicePixelRatio || 1), size = 40;
        canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr);
        var ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, size, size);
        var c = size / 2;
        if (name === "bumper") {
            ctx.beginPath(); ctx.arc(c, c, 15, 0, 2 * Math.PI); ctx.strokeStyle = "#E5392B"; ctx.lineWidth = 3; ctx.stroke();
            ctx.beginPath(); ctx.arc(c, c, 9, 0, 2 * Math.PI); ctx.fillStyle = "orange"; ctx.fill();
        }
    }

    return { attach: attach, staticIcon: staticIcon, SCENES: SCENES, W: W, H: H };
})();
