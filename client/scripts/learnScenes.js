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

    // ========================================================================
    // REAL PLACEABLE ART (PORT: draw.js hazard/boon drawers). The hazard/boon
    // cards must show the ACTUAL in-game art, not stand-ins — so the procedural
    // renderers from draw.js are ported here near-verbatim. Adaptations: the
    // game's `gameContext` global is aliased to a module var set per draw; the
    // config numbers/colours are baked into HZ/BN below (the learn page has no
    // live config); `boonOnWater(x,y)` is hard-false (Codex draws on land).
    // KEEP IN SYNC: if a drawer changes in draw.js, update the port here.
    // ========================================================================
    var gameContext = null;            // alias set to the active scene ctx per draw
    var bumperRingColor = "#E5392B";
    var BOON_HALO = "rgba(10,40,55,0.6)";
    var WARP_PAIR_COLORS = ["#C24DFF", "#36C5F0", "#F45D9C", "#7C6BFF", "#33D6C0", "#FF8A3D"];
    var ZIP_ROPE_DARK = "#C79A33", ZIP_ROPE_DARK_W = "#E6CF95";
    var ZIP_WOOD = "#6b4a26", ZIP_WOOD_DARK = "#4a3119", ZIP_STEEL = "#2a2018", ZIP_STRAP = "#2a2e33";
    var LILY_OUTLINE = "#16331d", LILY_RIMLIGHT = "#c8ffce", LILY_VEIN = "rgba(20,60,30,0.5)";
    var LILY_PETAL = "#f6b0cb", LILY_CENTER = "#ffd24a";
    // Baked config (mirrors server/config.json hazards/boons — art fields only).
    var HZ = {
        bumper: { attackRadius: 15, radius: 10, color: "#F07B36" },
        movingBumper: { height: 5, width: 100, attackRadius: 15, radius: 10, color: "#F07B36" },
        bumperWall: { width: 120, height: 10, color: "#F07B36" },
        rotor: { orbitRadius: 70, armWidth: 6, attackRadius: 15, radius: 10, color: "#F07B36" },
        geyser: { radius: 22, attackRadius: 40, color: "#F07B36" },
        mine: { bodyRadius: 11, color: "#F07B36" },
        vortexWell: { radius: 150, coreRadius: 18, color: "#A77BFF" },
        laserGate: { width: 150, height: 9, color: "#42E0FF" },
        crusher: { width: 92, height: 22, railLength: 150, color: "#9AA0A6" },
        sentryTurret: { barrelLength: 28, radius: 18, color: "#FF5C5C" },
        magpieDrone: { radius: 16, railLength: 170 }
    };
    // colorWater (the on-water palette) is intentionally omitted: the Codex always
    // draws on land (boonOnWater is hard-false), so no drawer reads it here.
    var BN = {
        warpPad: { radius: 30 },
        dashArrows: { width: 70, height: 46, color: "#3FC1C9" },
        rechargeSpring: { radius: 28, color: "#5BE3A0" },
        slipstream: { width: 110, height: 70, color: "#7FD8FF" },
        launchPad: { radius: 26, color: "#FF8C42" },
        barrelCannon: { radius: 30, color: "#C8743C" },
        slingshotRings: { radius: 34, color: "#C77DFF" },
        zipline: { minLength: 140, color: "#F2C14E" },
        lilyPad: { radius: 46, color: "#56D06A" },
        guardHalo: { radius: 26, color: "#FFD166" },
        secondWindTotem: { radius: 28, color: "#CBD2DC" }
    };

    // ---- Hazards (PORT: draw.js) ----
    function pl_bumper(x, y) {
        gameContext.save();
        gameContext.beginPath(); gameContext.strokeStyle = bumperRingColor; gameContext.lineWidth = 3;
        gameContext.arc(x, y, HZ.bumper.attackRadius, 0, 2 * Math.PI); gameContext.stroke();
        gameContext.beginPath(); gameContext.arc(x, y, HZ.bumper.radius, 0, 2 * Math.PI);
        gameContext.fillStyle = HZ.bumper.color; gameContext.fill();
        gameContext.restore();
    }
    function pl_movingBumper(x, y, railX, railY, angle) {
        gameContext.save();
        gameContext.beginPath(); gameContext.translate(railX, railY); gameContext.rotate(angle * (Math.PI / 180));
        gameContext.rect(0, -HZ.movingBumper.height / 2, HZ.movingBumper.width, HZ.movingBumper.height);
        gameContext.fillStyle = "black"; gameContext.fill(); gameContext.restore();
        gameContext.save();
        gameContext.beginPath(); gameContext.strokeStyle = bumperRingColor; gameContext.lineWidth = 3;
        gameContext.arc(x, y, HZ.movingBumper.attackRadius, 0, 2 * Math.PI); gameContext.stroke();
        gameContext.beginPath(); gameContext.arc(x, y, HZ.movingBumper.radius, 0, 2 * Math.PI);
        gameContext.fillStyle = HZ.movingBumper.color; gameContext.fill(); gameContext.restore();
    }
    function pl_bumperWall(x, y, angle) {
        var rad = (angle || 0) * (Math.PI / 180);
        var bx = x + Math.cos(rad) * HZ.bumperWall.width, by = y + Math.sin(rad) * HZ.bumperWall.width;
        gameContext.save(); gameContext.lineCap = "round";
        gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by);
        gameContext.strokeStyle = bumperRingColor; gameContext.lineWidth = HZ.bumperWall.height + 6; gameContext.stroke();
        gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by);
        gameContext.strokeStyle = HZ.bumperWall.color; gameContext.lineWidth = HZ.bumperWall.height; gameContext.stroke();
        gameContext.restore();
    }
    function pl_rotor(x, y, angle) {
        var rad = (angle || 0) * (Math.PI / 180);
        var px = x - Math.cos(rad) * HZ.rotor.orbitRadius, py = y - Math.sin(rad) * HZ.rotor.orbitRadius;
        gameContext.save(); gameContext.lineCap = "round";
        gameContext.beginPath(); gameContext.moveTo(px, py); gameContext.lineTo(x, y);
        gameContext.strokeStyle = "#222"; gameContext.lineWidth = HZ.rotor.armWidth; gameContext.stroke();
        gameContext.beginPath(); gameContext.arc(px, py, HZ.rotor.armWidth, 0, 2 * Math.PI); gameContext.fillStyle = "#222"; gameContext.fill();
        gameContext.beginPath(); gameContext.strokeStyle = bumperRingColor; gameContext.lineWidth = 3;
        gameContext.arc(x, y, HZ.rotor.attackRadius, 0, 2 * Math.PI); gameContext.stroke();
        gameContext.beginPath(); gameContext.arc(x, y, HZ.rotor.radius, 0, 2 * Math.PI); gameContext.fillStyle = HZ.rotor.color; gameContext.fill();
        gameContext.restore();
    }
    function pl_geyser(x, y, state) {
        var cfg = HZ.geyser, r = cfg.radius;
        gameContext.save();
        gameContext.beginPath(); gameContext.arc(x, y, r, 0, 2 * Math.PI); gameContext.fillStyle = "#3a2f2a"; gameContext.fill();
        gameContext.lineWidth = 3; gameContext.strokeStyle = "#6b5546"; gameContext.stroke();
        gameContext.beginPath(); gameContext.arc(x, y, r * 0.6, 0, 2 * Math.PI); gameContext.fillStyle = "#241c18"; gameContext.fill();
        if (state === 2) {
            gameContext.globalAlpha = 0.85; gameContext.fillStyle = cfg.color;
            gameContext.beginPath(); gameContext.arc(x, y, cfg.attackRadius, 0, 2 * Math.PI); gameContext.fill();
            gameContext.globalAlpha = 1; gameContext.fillStyle = "#FFD27B";
            for (var s = 0; s < 8; s++) { var a = (s / 8) * 2 * Math.PI;
                gameContext.beginPath(); gameContext.arc(x + Math.cos(a) * cfg.attackRadius, y + Math.sin(a) * cfg.attackRadius, 5, 0, 2 * Math.PI); gameContext.fill(); }
        } else if (state === 1) {
            var t = (Date.now() % 700) / 700, ringR = r + t * (cfg.attackRadius - r);
            gameContext.globalAlpha = 0.7 * (1 - t); gameContext.lineWidth = 4; gameContext.strokeStyle = cfg.color;
            gameContext.beginPath(); gameContext.arc(x, y, ringR, 0, 2 * Math.PI); gameContext.stroke();
            gameContext.globalAlpha = 0.9; gameContext.fillStyle = "#FFD27B";
            gameContext.beginPath(); gameContext.arc(x + (t - 0.5) * 6, y - t * r, 2.5, 0, 2 * Math.PI); gameContext.fill();
            gameContext.globalAlpha = 1;
        }
        gameContext.restore();
    }
    function pl_mine(x, y, state) {
        var r = HZ.mine.bodyRadius;
        gameContext.save();
        if (state === 2) { gameContext.beginPath(); gameContext.arc(x, y, r * 1.4, 0, 2 * Math.PI); gameContext.fillStyle = "rgba(20,16,14,0.55)"; gameContext.fill(); gameContext.restore(); return; }
        gameContext.strokeStyle = "#222"; gameContext.lineWidth = 3;
        for (var s = 0; s < 8; s++) { var a = (s / 8) * 2 * Math.PI;
            gameContext.beginPath(); gameContext.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); gameContext.lineTo(x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5)); gameContext.stroke(); }
        gameContext.beginPath(); gameContext.arc(x, y, r, 0, 2 * Math.PI); gameContext.fillStyle = "#2b2b2b"; gameContext.fill();
        var lit = (state === 1) ? ((Date.now() % 360) < 200) : true;
        if (lit) { gameContext.beginPath(); gameContext.arc(x, y, r * 0.4, 0, 2 * Math.PI); gameContext.fillStyle = (state === 1) ? "#ff2e2e" : "#ffc24b"; gameContext.fill(); }
        gameContext.restore();
    }
    var vortexHazeSprite = null;
    function getVortexHazeSprite() {
        if (vortexHazeSprite != null) { return vortexHazeSprite; }
        var cfg = HZ.vortexWell, R = cfg.radius, blurPx = Math.max(6, Math.round(R * 0.14)), pad = blurPx + 6, size = (R + pad) * 2;
        var cv = document.createElement("canvas"); cv.width = size; cv.height = size;
        var ctx = cv.getContext("2d"), cx = size / 2, cy = size / 2;
        ctx.filter = "blur(" + blurPx + "px)"; ctx.lineCap = "round"; ctx.strokeStyle = cfg.color; ctx.globalAlpha = 0.5;
        for (var a = 0; a < 3; a++) { var base = (a / 3) * Math.PI * 2; ctx.beginPath(); var first = true;
            for (var t = 0; t <= 1.001; t += 0.05) { var rr = R * (1 - t) + cfg.coreRadius * t, ang = base + t * Math.PI * 1.9, px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
                if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); } }
            ctx.lineWidth = 16; ctx.stroke(); }
        ctx.globalAlpha = 1;
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        g.addColorStop(0, "rgba(167,123,255,0.42)"); g.addColorStop(0.55, "rgba(150,110,235,0.16)"); g.addColorStop(1, "rgba(167,123,255,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
        vortexHazeSprite = cv; return cv;
    }
    function pl_vortexWell(x, y, radius) {
        var cfg = HZ.vortexWell, maxR = cfg.radius, R = (radius != null && radius > 0) ? radius : maxR, coreR = cfg.coreRadius * (R / maxR);
        var spin = (Date.now() / 1100) % (Math.PI * 2);
        gameContext.save();
        var sprite = getVortexHazeSprite();
        if (sprite != null) { var s = R / maxR; gameContext.save(); gameContext.translate(x, y); gameContext.rotate(spin); gameContext.scale(s, s); gameContext.drawImage(sprite, -sprite.width / 2, -sprite.height / 2); gameContext.restore(); }
        gameContext.beginPath(); gameContext.arc(x, y, R, 0, 2 * Math.PI); gameContext.strokeStyle = "rgba(167,123,255,0.22)"; gameContext.lineWidth = 2; gameContext.stroke();
        gameContext.lineCap = "round"; gameContext.globalAlpha = 0.6; gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 2.5;
        for (var a = 0; a < 2; a++) { var base = spin + (a / 2) * Math.PI * 2; gameContext.beginPath(); var first = true;
            for (var t = 0; t <= 1.001; t += 0.08) { var rr = R * (1 - t) + coreR * t, ang = base + t * Math.PI * 1.6, px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
                if (first) { gameContext.moveTo(px, py); first = false; } else { gameContext.lineTo(px, py); } }
            gameContext.stroke(); }
        gameContext.globalAlpha = 1;
        gameContext.beginPath(); gameContext.arc(x, y, coreR, 0, 2 * Math.PI); gameContext.fillStyle = "#2a1f44"; gameContext.fill();
        gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 2; gameContext.stroke();
        gameContext.restore();
    }
    function pl_laserGate(x, y, angle, state) {
        var cfg = HZ.laserGate, rad = (angle || 0) * (Math.PI / 180), bx = x + Math.cos(rad) * cfg.width, by = y + Math.sin(rad) * cfg.width;
        gameContext.save(); gameContext.lineCap = "round";
        for (var p = 0; p < 2; p++) { var px = p === 0 ? x : bx, py = p === 0 ? y : by;
            gameContext.beginPath(); gameContext.arc(px, py, 7, 0, 2 * Math.PI); gameContext.fillStyle = "#1d3a44"; gameContext.fill();
            gameContext.lineWidth = 2.5; gameContext.strokeStyle = cfg.color; gameContext.stroke(); }
        if (state === 2) {
            gameContext.globalAlpha = 0.35; gameContext.strokeStyle = cfg.color; gameContext.lineWidth = cfg.height + 8;
            gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke();
            gameContext.globalAlpha = 1; gameContext.strokeStyle = "#EAFBFF"; gameContext.lineWidth = cfg.height;
            gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke();
        } else if (state === 1) {
            var flick = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(Date.now() / 60));
            gameContext.globalAlpha = flick; gameContext.setLineDash([10, 8]); gameContext.lineDashOffset = -(Date.now() / 40) % 18;
            gameContext.strokeStyle = cfg.color; gameContext.lineWidth = cfg.height;
            gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke(); gameContext.setLineDash([]); gameContext.globalAlpha = 1;
        } else {
            gameContext.globalAlpha = 0.22; gameContext.setLineDash([3, 11]); gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 2;
            gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke(); gameContext.setLineDash([]); gameContext.globalAlpha = 1;
        }
        gameContext.restore();
    }
    function pl_crusher(x, y, railX, railY, angle) {
        var cfg = HZ.crusher, rad = (angle || 0) * (Math.PI / 180), dirX = Math.cos(rad), dirY = Math.sin(rad), hw = cfg.width / 2, hh = cfg.height / 2;
        gameContext.save(); gameContext.lineCap = "butt";
        gameContext.strokeStyle = "rgba(58,61,64,0.55)"; gameContext.lineWidth = 7;
        gameContext.beginPath(); gameContext.moveTo(railX, railY); gameContext.lineTo(railX + dirX * cfg.railLength, railY + dirY * cfg.railLength); gameContext.stroke();
        gameContext.strokeStyle = "rgba(120,126,132,0.5)"; gameContext.lineWidth = 1.5;
        gameContext.beginPath(); gameContext.moveTo(railX, railY); gameContext.lineTo(railX + dirX * cfg.railLength, railY + dirY * cfg.railLength); gameContext.stroke();
        gameContext.translate(railX, railY); gameContext.rotate(rad + Math.PI / 2); gameContext.fillStyle = "#33363a"; gameContext.fillRect(-hw - 4, -8, cfg.width + 8, 16);
        gameContext.restore();
        gameContext.save(); gameContext.translate(x, y); gameContext.rotate(rad + Math.PI / 2);
        gameContext.fillStyle = "#6c7176"; var teeth = 7, tw = cfg.width / teeth, tooth = 6;
        for (var ti = 0; ti < teeth; ti++) { var tx0 = -hw + ti * tw;
            gameContext.beginPath(); gameContext.moveTo(tx0, -hh); gameContext.lineTo(tx0 + tw, -hh); gameContext.lineTo(tx0 + tw / 2, -hh - tooth); gameContext.closePath(); gameContext.fill();
            gameContext.beginPath(); gameContext.moveTo(tx0, hh); gameContext.lineTo(tx0 + tw, hh); gameContext.lineTo(tx0 + tw / 2, hh + tooth); gameContext.closePath(); gameContext.fill(); }
        var grad = gameContext.createLinearGradient(0, -hh, 0, hh); grad.addColorStop(0, "#c4c9ce"); grad.addColorStop(0.45, cfg.color); grad.addColorStop(1, "#54585d");
        gameContext.fillStyle = grad; gameContext.fillRect(-hw, -hh, cfg.width, cfg.height);
        gameContext.strokeStyle = "#303336"; gameContext.lineWidth = 2; gameContext.strokeRect(-hw, -hh, cfg.width, cfg.height);
        gameContext.strokeStyle = "rgba(48,51,54,0.6)"; gameContext.lineWidth = 1; gameContext.strokeRect(-hw + 4, -hh + 4, cfg.width - 8, cfg.height - 8);
        gameContext.fillStyle = "#3c4044"; var rvx = hw - 6, rvy = hh - 5, corners = [[-rvx, -rvy], [rvx, -rvy], [rvx, rvy], [-rvx, rvy]];
        for (var ci = 0; ci < 4; ci++) { gameContext.beginPath(); gameContext.arc(corners[ci][0], corners[ci][1], 2.2, 0, 2 * Math.PI); gameContext.fill(); }
        gameContext.restore();
    }
    function pl_sentryTurret(x, y, angle, state) {
        var cfg = HZ.sentryTurret, rad = (angle || 0) * (Math.PI / 180);
        gameContext.save();
        if (state === 1) { var pulse = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(Date.now() / 70));
            gameContext.globalAlpha = pulse; gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 3;
            gameContext.beginPath(); gameContext.arc(x, y, cfg.radius + 7, 0, 2 * Math.PI); gameContext.stroke(); gameContext.globalAlpha = 1; }
        var bx = x + Math.cos(rad) * cfg.barrelLength, by = y + Math.sin(rad) * cfg.barrelLength;
        gameContext.lineCap = "round"; gameContext.strokeStyle = "#34383d"; gameContext.lineWidth = 9;
        gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke();
        if (state === 2) { gameContext.globalAlpha = 0.6; gameContext.fillStyle = cfg.color; gameContext.beginPath(); gameContext.arc(bx, by, 12, 0, 2 * Math.PI); gameContext.fill();
            gameContext.globalAlpha = 1; gameContext.fillStyle = "#fff2c8"; gameContext.beginPath(); gameContext.arc(bx, by, 6, 0, 2 * Math.PI); gameContext.fill(); }
        gameContext.fillStyle = "#5a6066"; gameContext.beginPath(); gameContext.arc(x, y, cfg.radius, 0, 2 * Math.PI); gameContext.fill();
        gameContext.lineWidth = 3; gameContext.strokeStyle = "#2b2f33"; gameContext.stroke();
        gameContext.fillStyle = cfg.color; gameContext.beginPath(); gameContext.arc(x, y, cfg.radius * 0.55, 0, 2 * Math.PI); gameContext.fill();
        gameContext.restore();
    }
    // Magpie bird shape (PORT: barrierArt.js magpieBirdShape/magpieWingShape).
    function magpieWingShape(ctx, R, side, flap) {
        ctx.save(); ctx.translate(0, -R * 0.1); ctx.rotate(side * (0.5 + (flap || 0)));
        var grd = ctx.createLinearGradient(0, 0, side * R * 1.7, R * 0.4); grd.addColorStop(0, "#23262f"); grd.addColorStop(1, "#0d0f15");
        ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(side * R * 1.3, -R * 0.5, side * R * 1.75, R * 0.15); ctx.quadraticCurveTo(side * R * 1.2, R * 0.55, 0, R * 0.45); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#eef1f7"; ctx.beginPath(); ctx.moveTo(side * R * 1.1, R * 0.05);
        ctx.quadraticCurveTo(side * R * 1.6, R * 0.1, side * R * 1.75, R * 0.15); ctx.quadraticCurveTo(side * R * 1.3, R * 0.45, side * R * 1.0, R * 0.4); ctx.closePath(); ctx.fill();
        ctx.restore();
    }
    function magpieBirdShape(ctx, R, flap, tailSway, beakOpen, shimmer) {
        for (var s = -1; s <= 1; s += 2) { ctx.save(); ctx.translate(0, R * 0.2); ctx.rotate(s * 0.18 + (tailSway || 0));
            var tl = R * 1.9, grd = ctx.createLinearGradient(0, 0, 0, tl); grd.addColorStop(0, "#1b2030"); grd.addColorStop(0.5, shimmer(s)); grd.addColorStop(1, "#0c1018");
            ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(R * 0.5 * s, tl * 0.6, R * 0.18 * s, tl); ctx.quadraticCurveTo(-R * 0.18 * s, tl * 0.7, 0, 0); ctx.closePath(); ctx.fill(); ctx.restore(); }
        magpieWingShape(ctx, R, -1, flap);
        ctx.fillStyle = "#15171f"; ctx.beginPath(); ctx.ellipse(0, R * 0.1, R * 0.82, R * 1.0, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#eef1f7"; ctx.beginPath(); ctx.ellipse(0, R * 0.35, R * 0.5, R * 0.62, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#15171f"; ctx.beginPath(); ctx.arc(0, -R * 0.7, R * 0.62, 0, Math.PI * 2); ctx.fill();
        var open = (beakOpen || 0) * R; ctx.fillStyle = "#f0a23a";
        ctx.beginPath(); ctx.moveTo(R * 0.55, -R * 0.78 - open); ctx.lineTo(R * 1.15, -R * 0.72); ctx.lineTo(R * 0.55, -R * 0.62 + open); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(R * 0.28, -R * 0.82, R * 0.17, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#101218"; ctx.beginPath(); ctx.arc(R * 0.33, -R * 0.82, R * 0.09, 0, Math.PI * 2); ctx.fill();
        magpieWingShape(ctx, R, 1, flap);
    }
    function drawMagpieBird(R, t, carrying) {
        magpieBirdShape(gameContext, R, Math.sin(t * 9) * 0.55, Math.sin(t * 2.2) * 0.05, carrying ? 0.16 : 0.05, function (s) { return (Math.sin(t * 1.5 + s) > 0.5) ? "#2f6df0" : "#1f8f7a"; });
    }
    // Magpie drone (PORT: draw.js drawMagpieDrone) — loot token simplified to a
    // white disc + bomb glyph (the real ability-icon Images aren't on this page).
    function pl_magpieDrone(x, y, railX, railY, angle, carrying, faceLeft, t) {
        var R = HZ.magpieDrone.radius, railLen = HZ.magpieDrone.railLength, rad = (angle || 0) * (Math.PI / 180);
        gameContext.save(); gameContext.strokeStyle = "rgba(91,108,196,0.30)"; gameContext.lineWidth = 3; gameContext.setLineDash([8, 8]);
        gameContext.beginPath(); gameContext.moveTo(railX, railY); gameContext.lineTo(railX + Math.cos(rad) * railLen, railY + Math.sin(rad) * railLen); gameContext.stroke(); gameContext.setLineDash([]); gameContext.restore();
        var bob = Math.sin(t * 2.2) * R * 0.06, face = faceLeft ? -1 : 1;
        if (carrying) { var pulse = 0.5 + 0.5 * Math.sin(t * 6);
            gameContext.beginPath(); gameContext.arc(x, y + bob, R + 6 + pulse * 3, 0, Math.PI * 2);
            gameContext.strokeStyle = "rgba(255,210,90," + (0.30 + 0.30 * pulse).toFixed(3) + ")"; gameContext.lineWidth = 2.5; gameContext.stroke(); }
        gameContext.save(); gameContext.translate(x, y + bob); gameContext.scale(face, 1); drawMagpieBird(R, t, carrying); gameContext.restore();
        if (carrying) { var lx = x + face * R * 1.5, ly = y + bob - R * 0.7, lr = R * 0.55;
            gameContext.beginPath(); gameContext.arc(lx, ly, lr, 0, Math.PI * 2); gameContext.fillStyle = "rgba(255,255,255,0.92)"; gameContext.fill();
            gameContext.lineWidth = 1.2; gameContext.strokeStyle = "rgba(0,0,0,0.35)"; gameContext.stroke();
            var bi = img("bomb.svg"); if (ready(bi)) { gameContext.drawImage(bi, lx - lr * 0.7, ly - lr * 0.7, lr * 1.4, lr * 1.4); } }
    }

    // ---- Boons (PORT: draw.js). boonOnWater() is hard-false on the Codex. ----
    function warpPairColor(pair) { var i = (typeof pair === "number" && isFinite(pair)) ? (((pair | 0) % WARP_PAIR_COLORS.length) + WARP_PAIR_COLORS.length) % WARP_PAIR_COLORS.length : 0; return WARP_PAIR_COLORS[i]; }
    function pl_warpPad(x, y, pair) {
        var R = BN.warpPad.radius, col = warpPairColor(pair), spin = (Date.now() / 700) % (Math.PI * 2);
        gameContext.save();
        gameContext.beginPath(); gameContext.arc(x, y, R, 0, 2 * Math.PI); gameContext.strokeStyle = col; gameContext.globalAlpha = 0.25; gameContext.lineWidth = 6; gameContext.stroke(); gameContext.globalAlpha = 1;
        gameContext.lineCap = "round"; gameContext.lineWidth = 3; gameContext.strokeStyle = col;
        for (var a = 0; a < 2; a++) { var dir = a === 0 ? 1 : -1, base = spin * dir + a * Math.PI; gameContext.beginPath(); gameContext.arc(x, y, R * 0.7, base, base + Math.PI * 1.1); gameContext.stroke(); }
        gameContext.globalAlpha = 0.55; gameContext.lineWidth = 2;
        for (var s = 0; s < 3; s++) { var ba = spin + (s / 3) * Math.PI * 2; gameContext.beginPath(); var first = true;
            for (var t = 0; t <= 1.001; t += 0.1) { var rr = R * 0.62 * (1 - t) + R * 0.12 * t, ang = ba + t * Math.PI * 1.4, px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
                if (first) { gameContext.moveTo(px, py); first = false; } else { gameContext.lineTo(px, py); } } gameContext.stroke(); }
        gameContext.globalAlpha = 1;
        gameContext.beginPath(); gameContext.arc(x, y, R * 0.2, 0, 2 * Math.PI); gameContext.fillStyle = "#FFFFFF"; gameContext.fill();
        gameContext.beginPath(); gameContext.arc(x, y, R * 0.32, 0, 2 * Math.PI); gameContext.strokeStyle = col; gameContext.lineWidth = 2.5; gameContext.stroke();
        gameContext.restore();
    }
    function pl_dashArrows(x, y, angle) {
        var cfg = BN.dashArrows, rad = (angle || 0) * (Math.PI / 180), w = cfg.width, hgt = cfg.height;
        gameContext.save(); gameContext.translate(x, y); gameContext.rotate(rad);
        gameContext.beginPath(); gameContext.rect(-w / 2, -hgt / 2, w, hgt); gameContext.fillStyle = "rgba(63,193,201,0.06)"; gameContext.fill();
        gameContext.strokeStyle = "rgba(63,193,201,0.12)"; gameContext.lineWidth = 1; gameContext.stroke();
        gameContext.lineCap = "round"; gameContext.lineJoin = "round"; var ch = hgt * 0.32;
        for (var i = 0; i < 2; i++) { var cx = -w * 0.16 + i * (w * 0.30);
            gameContext.beginPath(); gameContext.moveTo(cx - 8, -ch); gameContext.lineTo(cx + 8, 0); gameContext.lineTo(cx - 8, ch);
            gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 8; gameContext.stroke();
            gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 5; gameContext.stroke(); }
        gameContext.restore();
    }
    function pl_rechargeSpring(x, y, state) {
        var cfg = BN.rechargeSpring, r = cfg.radius, ready2 = (state == null || state >= 100), accent = cfg.color;
        gameContext.save(); gameContext.translate(x, y);
        gameContext.beginPath(); gameContext.arc(0, 0, r, 0, 2 * Math.PI); gameContext.fillStyle = "rgba(91,227,160,0.04)"; gameContext.fill();
        if (!ready2) {
            var frac = Math.max(0, Math.min(1, state / 100));
            gameContext.lineWidth = 3; gameContext.beginPath(); gameContext.arc(0, 0, r * 0.78, 0, 2 * Math.PI); gameContext.strokeStyle = accent; gameContext.globalAlpha = 0.18; gameContext.stroke();
            gameContext.beginPath(); gameContext.arc(0, 0, r * 0.78, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI); gameContext.globalAlpha = 0.9; gameContext.lineCap = "round";
            gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 5; gameContext.stroke(); gameContext.strokeStyle = accent; gameContext.lineWidth = 3; gameContext.stroke(); gameContext.globalAlpha = 1;
        } else {
            var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 320);
            gameContext.beginPath(); gameContext.arc(0, 0, r * (0.62 + 0.28 * pulse), 0, 2 * Math.PI); gameContext.strokeStyle = accent; gameContext.globalAlpha = 0.35 + 0.45 * (1 - pulse); gameContext.lineWidth = 3; gameContext.stroke(); gameContext.globalAlpha = 1;
        }
        var arm = r * 0.42; gameContext.globalAlpha = ready2 ? 1 : 0.3; gameContext.lineCap = "round";
        gameContext.beginPath(); gameContext.moveTo(-arm, 0); gameContext.lineTo(arm, 0); gameContext.moveTo(0, -arm); gameContext.lineTo(0, arm);
        gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 8; gameContext.stroke(); gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 5; gameContext.stroke(); gameContext.globalAlpha = 1;
        gameContext.restore();
    }
    function pl_slipstream(x, y, angle) {
        var cfg = BN.slipstream, rad = (angle || 0) * (Math.PI / 180), w = cfg.width, hgt = cfg.height, halo = BOON_HALO, flow = (Date.now() / 14) % 28;
        gameContext.save(); gameContext.translate(x, y); gameContext.rotate(rad);
        gameContext.beginPath(); gameContext.rect(-w / 2, -hgt / 2, w, hgt); gameContext.fillStyle = "rgba(127,216,255,0.03)"; gameContext.fill();
        gameContext.strokeStyle = "rgba(127,216,255,0.05)"; gameContext.lineWidth = 1; gameContext.stroke();
        var stroke = cfg.color; gameContext.lineCap = "round"; gameContext.lineJoin = "round"; var rows = [-hgt * 0.28, 0, hgt * 0.28], x0 = -w / 2 + 8, x1 = w / 2 - 16;
        for (var i = 0; i < rows.length; i++) { var ly = rows[i];
            gameContext.setLineDash([18, 10]); gameContext.lineDashOffset = -flow; gameContext.beginPath(); gameContext.moveTo(x0, ly); gameContext.lineTo(x1, ly);
            gameContext.strokeStyle = halo; gameContext.lineWidth = 6; gameContext.stroke(); gameContext.strokeStyle = stroke; gameContext.lineWidth = 3; gameContext.stroke(); gameContext.setLineDash([]);
            gameContext.beginPath(); gameContext.moveTo(w / 2 - 22, ly - 7); gameContext.lineTo(w / 2 - 10, ly); gameContext.lineTo(w / 2 - 22, ly + 7);
            gameContext.strokeStyle = halo; gameContext.lineWidth = 6; gameContext.stroke(); gameContext.strokeStyle = stroke; gameContext.lineWidth = 3; gameContext.stroke(); }
        gameContext.restore();
    }
    function drawKickerRamp(ctx, r, accent, light, mid, dark, bounce) {
        var hwBack = r * 0.5, hwFront = r * 0.82, frontX = r * 0.92;
        function rampPath() { ctx.beginPath(); ctx.moveTo(-r, -hwBack); ctx.lineTo(frontX, -hwFront); ctx.lineTo(frontX, hwFront); ctx.lineTo(-r, hwBack); ctx.closePath(); }
        rampPath(); var g = ctx.createLinearGradient(-r, 0, r, 0); g.addColorStop(0, dark); g.addColorStop(0.6, mid); g.addColorStop(1, light);
        ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = BOON_HALO; ctx.lineWidth = 2.5; ctx.stroke();
        ctx.lineCap = "round"; ctx.lineJoin = "round"; var cw1 = r * 0.2, cw2 = r * 0.15;
        for (var i = 0; i < 3; i++) { var cx = -r * 0.4 + i * r * 0.42, ch = r * (0.34 + i * 0.08);
            ctx.globalAlpha = 0.45 + 0.55 * bounce * ((i + 1) / 3); ctx.beginPath(); ctx.moveTo(cx - cw1, ch); ctx.lineTo(cx + cw2, 0); ctx.lineTo(cx - cw1, -ch);
            ctx.strokeStyle = accent; ctx.lineWidth = Math.max(3, r * 0.16); ctx.stroke(); }
        ctx.globalAlpha = 1; var lift = bounce * r * 0.06;
        ctx.beginPath(); ctx.moveTo(frontX, -hwFront - lift); ctx.lineTo(frontX, hwFront + lift);
        ctx.strokeStyle = BOON_HALO; ctx.lineWidth = 7; ctx.stroke(); ctx.strokeStyle = light; ctx.lineWidth = 4; ctx.stroke();
    }
    function pl_launchPad(x, y, angle) {
        var cfg = BN.launchPad, r = cfg.radius, rad = (angle || 0) * (Math.PI / 180), accent = cfg.color, light = "#ffc890", mid = "#c0651f", dark = "#7e3d14", bounce = 0.5 + 0.5 * Math.sin(Date.now() / 230);
        gameContext.save(); gameContext.translate(x, y); gameContext.rotate(rad); drawKickerRamp(gameContext, r, accent, light, mid, dark, bounce); gameContext.restore();
    }
    function barrelTones(cfg) { return { mid: cfg.color, light: "#e8a866", dark: "#7c4a25", bore: "#ffc24a" }; }
    function drawBarrelBody(ctx, r, tones, glow) {
        var ironHi = "#7a5e44", ironDk = "#22160b", iron = "#3a2614", bodyLen = r * 2.2, bodyW = r * 1.7, hx = bodyLen / 2, hy = bodyW / 2;
        function capsule(ax, ay) { var rr = ay; ctx.beginPath(); ctx.moveTo(-ax + rr, -ay); ctx.lineTo(ax - rr, -ay); ctx.arc(ax - rr, 0, rr, -Math.PI / 2, Math.PI / 2); ctx.lineTo(-ax + rr, ay); ctx.arc(-ax + rr, 0, rr, Math.PI / 2, -Math.PI / 2); ctx.closePath(); }
        capsule(hx, hy); var grad = ctx.createLinearGradient(0, -hy, 0, hy); grad.addColorStop(0, tones.light); grad.addColorStop(0.42, tones.mid); grad.addColorStop(1, tones.dark);
        ctx.fillStyle = grad; ctx.fill(); ctx.strokeStyle = ironDk; ctx.lineWidth = 2.5; ctx.stroke();
        var bands = [-bodyLen * 0.16, bodyLen * 0.0];
        for (var b = 0; b < bands.length; b++) { var bxh = bands[b];
            ctx.strokeStyle = ironDk; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(bxh, -hy + 1); ctx.lineTo(bxh, hy - 1); ctx.stroke();
            ctx.strokeStyle = ironHi; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(bxh - 1.4, -hy * 0.66); ctx.lineTo(bxh - 1.4, hy * 0.66); ctx.stroke();
            ctx.fillStyle = ironHi; for (var rv = -1; rv <= 1; rv += 2) { ctx.beginPath(); ctx.arc(bxh, rv * hy * 0.62, 1.6, 0, 2 * Math.PI); ctx.fill(); } }
        var mx = hx - hy * 0.28; ctx.beginPath(); ctx.ellipse(mx, 0, hy * 0.34, hy * 0.98, 0, 0, 2 * Math.PI); ctx.fillStyle = iron; ctx.fill(); ctx.strokeStyle = ironHi; ctx.lineWidth = 1.4; ctx.stroke();
        var g = (glow == null) ? 0.6 : glow; ctx.globalAlpha = g; ctx.beginPath(); ctx.ellipse(mx, 0, hy * 0.16, hy * 0.55, 0, 0, 2 * Math.PI); ctx.fillStyle = tones.bore; ctx.fill();
        ctx.globalAlpha = g * 0.55; ctx.beginPath(); ctx.ellipse(mx, 0, hy * 0.07, hy * 0.28, 0, 0, 2 * Math.PI); ctx.fillStyle = "#fff3c8"; ctx.fill(); ctx.globalAlpha = 1;
    }
    function pl_barrelCannon(x, y, angle) {
        var cfg = BN.barrelCannon, r = cfg.radius, rad = (angle || 0) * (Math.PI / 180), tones = barrelTones(cfg);
        gameContext.save(); gameContext.translate(x, y);
        gameContext.globalAlpha = 0.2; gameContext.fillStyle = "#000"; gameContext.beginPath(); gameContext.ellipse(0, r * 0.32, r * 1.2, r * 0.85, 0, 0, 2 * Math.PI); gameContext.fill(); gameContext.globalAlpha = 1;
        gameContext.rotate(rad); var glow = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(Date.now() / 320)); drawBarrelBody(gameContext, r, tones, glow); gameContext.restore();
    }
    function pl_slingshotRings(x, y, angle) {
        var cfg = BN.slingshotRings, r = cfg.radius, rad = (angle || 0) * (Math.PI / 180), accent = cfg.color, pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
        gameContext.save(); gameContext.translate(x, y); gameContext.rotate(rad);
        var rx = r * 0.42, ry = r * 0.95; gameContext.beginPath(); gameContext.ellipse(0, 0, rx, ry, 0, 0, 2 * Math.PI);
        gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 8; gameContext.stroke(); gameContext.strokeStyle = accent; gameContext.lineWidth = 4 + 1.5 * pulse; gameContext.stroke();
        gameContext.globalAlpha = 0.35 + 0.3 * pulse; gameContext.beginPath(); gameContext.ellipse(0, 0, rx * 0.5, ry * 0.66, 0, 0, 2 * Math.PI); gameContext.strokeStyle = accent; gameContext.lineWidth = 2; gameContext.stroke(); gameContext.globalAlpha = 1;
        gameContext.lineCap = "round"; gameContext.lineJoin = "round";
        for (var s = -1; s <= 1; s += 2) { var ax = s * r * 1.05; gameContext.beginPath(); gameContext.moveTo(ax - s * 7, -6); gameContext.lineTo(ax, 0); gameContext.lineTo(ax - s * 7, 6);
            gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 6; gameContext.stroke(); gameContext.strokeStyle = accent; gameContext.lineWidth = 3; gameContext.stroke(); }
        gameContext.restore();
    }
    function paintZiplineLook(cap, x, y, angle, length, accent, ropeDark) {
        var rad = (angle || 0) * (Math.PI / 180), dirX = Math.cos(rad), dirY = Math.sin(rad), ex = x + dirX * length, ey = y + dirY * length, perpX = -dirY, perpY = dirX;
        cap.save(); cap.lineCap = "round"; var sag = Math.min(20, length * 0.07), mx = (x + ex) / 2 + perpX * sag, my = (y + ey) / 2 + perpY * sag;
        cap.beginPath(); cap.moveTo(x, y); cap.quadraticCurveTo(mx, my, ex, ey); cap.strokeStyle = BOON_HALO; cap.lineWidth = 9; cap.stroke();
        for (var o = -1; o <= 1; o += 2) { cap.beginPath(); cap.moveTo(x + perpX * o * 2, y + perpY * o * 2); cap.quadraticCurveTo(mx + perpX * o * 2, my + perpY * o * 2, ex + perpX * o * 2, ey + perpY * o * 2); cap.strokeStyle = o < 0 ? accent : ropeDark; cap.lineWidth = 2.5; cap.stroke(); }
        for (var p = 0; p < 2; p++) { var px = p === 0 ? x : ex, py = p === 0 ? y : ey;
            cap.strokeStyle = ZIP_WOOD; cap.lineWidth = 8; cap.beginPath(); cap.moveTo(px - perpX * 16, py - perpY * 16); cap.lineTo(px + perpX * 16, py + perpY * 16); cap.stroke();
            cap.strokeStyle = ZIP_WOOD_DARK; cap.lineWidth = 8; cap.beginPath(); cap.moveTo(px + perpX * 16, py + perpY * 16); cap.lineTo(px + perpX * 22, py + perpY * 22); cap.stroke(); }
        cap.beginPath(); cap.arc(x, y, 6, 0, 2 * Math.PI); cap.fillStyle = ZIP_STEEL; cap.fill(); cap.strokeStyle = "#e9eef2"; cap.lineWidth = 2; cap.stroke();
        cap.beginPath(); cap.arc(x, y, 2, 0, 2 * Math.PI); cap.fillStyle = accent; cap.fill();
        var hx = x + perpX * 12, hy = y + perpY * 12; cap.strokeStyle = ZIP_STRAP; cap.lineWidth = 3; cap.beginPath(); cap.moveTo(x, y); cap.lineTo(hx, hy); cap.stroke();
        cap.strokeStyle = accent; cap.lineWidth = 2.5; cap.beginPath(); cap.arc(hx, hy, 4, 0.5, 5.6); cap.stroke(); cap.restore();
    }
    function pl_zipline(x, y, angle, length) {
        var cfg = BN.zipline, len = (typeof length === "number" && isFinite(length) && length > 0) ? length : cfg.minLength;
        paintZiplineLook(gameContext, x, y, angle, len, cfg.color, ZIP_ROPE_DARK);
    }
    function lilyLeafPath(cap, r) { cap.beginPath(); cap.arc(0, 0, r, 0.42, 2 * Math.PI - 0.42); cap.lineTo(0, 0); cap.closePath(); }
    function lilyHasFlower(angle) { return (Math.round(angle || 0) % 10 + 10) % 10 < 3; }
    function drawLilyBloom(cap, r, alpha) {
        if (alpha <= 0) { return; } cap.save(); cap.globalAlpha = alpha; var pr = r * 0.42; cap.fillStyle = LILY_PETAL;
        for (var p = 0; p < 6; p++) { cap.save(); cap.rotate(p / 6 * Math.PI * 2); cap.beginPath(); cap.ellipse(0, -pr * 0.55, pr * 0.34, pr * 0.62, 0, 0, 2 * Math.PI); cap.fill(); cap.restore(); }
        cap.fillStyle = LILY_CENTER; cap.beginPath(); cap.arc(0, 0, pr * 0.34, 0, 2 * Math.PI); cap.fill(); cap.restore();
    }
    function pl_lilyPad(x, y, state, radius, angle) {
        var cfg = BN.lilyPad, sink = Math.max(0, Math.min(100, state == null ? 0 : state)) / 100, baseR = (typeof radius === "number" && isFinite(radius) && radius > 0) ? radius : cfg.radius, r = baseR * (1 - 0.16 * sink);
        gameContext.save(); gameContext.translate(x, y);
        gameContext.beginPath(); gameContext.arc(0, 0, r + 2, 0, 2 * Math.PI); gameContext.fillStyle = "rgba(8,35,26,0.20)"; gameContext.fill();
        gameContext.rotate((angle || 0) * (Math.PI / 180));
        lilyLeafPath(gameContext, r); gameContext.fillStyle = cfg.color; gameContext.fill();
        gameContext.save(); gameContext.globalAlpha = 0.5; gameContext.strokeStyle = LILY_RIMLIGHT; gameContext.lineWidth = 3; gameContext.beginPath(); gameContext.arc(0, 0, r * 0.86, Math.PI * 1.05, Math.PI * 1.7); gameContext.stroke(); gameContext.restore();
        lilyLeafPath(gameContext, r); gameContext.strokeStyle = LILY_OUTLINE; gameContext.lineWidth = 4; gameContext.stroke();
        gameContext.fillStyle = "rgba(255,255,255,0.7)"; gameContext.beginPath(); gameContext.arc(-r * 0.32, -r * 0.34, r * 0.16, 0, 2 * Math.PI); gameContext.fill();
        gameContext.strokeStyle = LILY_VEIN; gameContext.lineWidth = 2; gameContext.beginPath(); gameContext.moveTo(0, 0); gameContext.lineTo(r * 0.8, r * 0.1); gameContext.stroke();
        if (lilyHasFlower(angle)) { drawLilyBloom(gameContext, r, Math.max(0, 1 - sink)); }
        if (sink > 0.5) { gameContext.globalAlpha = 0.55 * ((sink - 0.5) * 2); gameContext.beginPath(); gameContext.arc(0, 0, r, 0, 2 * Math.PI); gameContext.fillStyle = "#2f6fb0"; gameContext.fill(); gameContext.globalAlpha = 1; }
        gameContext.restore();
    }
    function pl_guardHalo(x, y, state) {
        var cfg = BN.guardHalo, r = cfg.radius, ready2 = (state == null || state >= 100), accent = cfg.color;
        gameContext.save(); gameContext.translate(x, y);
        gameContext.beginPath(); gameContext.arc(0, 0, r, 0, 2 * Math.PI); gameContext.fillStyle = "rgba(255,209,102,0.05)"; gameContext.fill();
        if (!ready2) {
            var frac = Math.max(0, Math.min(1, state / 100));
            gameContext.beginPath(); gameContext.arc(0, 0, r * 0.78, 0, 2 * Math.PI); gameContext.strokeStyle = accent; gameContext.globalAlpha = 0.18; gameContext.lineWidth = 3; gameContext.stroke();
            gameContext.beginPath(); gameContext.arc(0, 0, r * 0.78, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI); gameContext.globalAlpha = 0.9; gameContext.lineCap = "round";
            gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 5; gameContext.stroke(); gameContext.strokeStyle = accent; gameContext.lineWidth = 3; gameContext.stroke(); gameContext.globalAlpha = 1;
        } else {
            var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 340);
            gameContext.beginPath(); gameContext.arc(0, 0, r * (0.6 + 0.3 * pulse), 0, 2 * Math.PI); gameContext.strokeStyle = accent; gameContext.globalAlpha = 0.35 + 0.45 * (1 - pulse); gameContext.lineWidth = 3; gameContext.stroke(); gameContext.globalAlpha = 1;
        }
        var s = r * 0.5; gameContext.globalAlpha = ready2 ? 1 : 0.3; gameContext.lineCap = "round"; gameContext.lineJoin = "round";
        gameContext.beginPath(); gameContext.moveTo(0, -s); gameContext.lineTo(s * 0.8, -s * 0.45); gameContext.lineTo(s * 0.8, s * 0.2); gameContext.lineTo(0, s); gameContext.lineTo(-s * 0.8, s * 0.2); gameContext.lineTo(-s * 0.8, -s * 0.45); gameContext.closePath();
        gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 7; gameContext.stroke(); gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 4; gameContext.stroke(); gameContext.globalAlpha = 1;
        gameContext.restore();
    }
    function drawFlagShape(x, y, clothColor, bend, consumed) {
        var poleTopY = -30; gameContext.save(); gameContext.translate(x, y);
        gameContext.beginPath(); gameContext.ellipse(0, 4, 9, 4, 0, 0, 2 * Math.PI); gameContext.fillStyle = "rgba(18,28,42,0.30)"; gameContext.fill();
        gameContext.lineCap = "round"; gameContext.lineJoin = "round";
        if (consumed) { gameContext.strokeStyle = "rgba(45,32,30,0.75)"; gameContext.lineWidth = 3; gameContext.beginPath(); gameContext.moveTo(0, 4); gameContext.lineTo(0, -11); gameContext.stroke(); gameContext.restore(); return; }
        gameContext.strokeStyle = "rgba(28,34,46,0.92)"; gameContext.lineWidth = 3; gameContext.beginPath(); gameContext.moveTo(0, 4); gameContext.lineTo(0, poleTopY); gameContext.stroke();
        var len = 22, hgt = 13, tipX = len + bend, tipY = poleTopY + hgt * 0.5;
        gameContext.beginPath(); gameContext.moveTo(0, poleTopY); gameContext.quadraticCurveTo(len * 0.5 + bend * 0.6, poleTopY - 2, tipX, tipY); gameContext.lineTo(0, poleTopY + hgt); gameContext.closePath();
        gameContext.fillStyle = clothColor; gameContext.fill(); gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 1.5; gameContext.stroke(); gameContext.restore();
    }

    // ---- Thumper (PORT: draw.js buildThumperSprites + drawThumperHazard). The
    //      slam-cycle/repel values mirror config.brutalRounds.antlion
    //      (thumperPeriod/repelRadius) so the card's cadence + ring match the game. ----
    var THUMPER_SPAN = 122, THUMPER_WORLD_SPAN = 100, THUMPER_BULK = 1.22, THUMPER_HEAD_PX = 128;
    var THUMPER_PAL = { pad: "#6b6e72", padDark: "#44474b", metal: "#767e88", metalDark: "#454c55", slab: "#5f6873", stripe: "#c9a23a", stripeDark: "#26262a", rust: "#704832", light: "#ff7030", dust: "#a8a298", glow: "#ffb060" };
    var THUMP_CFG = { thumperPeriod: 1.9, repelRadius: 110 };
    var thumperPadSprite = null, thumperHeadSprite = null;
    function buildThumperSprites() {
        var P = THUMPER_PAL, B = THUMPER_BULK, E = 22 * B, PI = Math.PI;
        thumperPadSprite = document.createElement("canvas"); thumperPadSprite.width = THUMPER_HEAD_PX; thumperPadSprite.height = THUMPER_HEAD_PX;
        var ctx = thumperPadSprite.getContext("2d"); ctx.save(); ctx.translate(THUMPER_HEAD_PX / 2, THUMPER_HEAD_PX / 2); ctx.scale(THUMPER_HEAD_PX / THUMPER_SPAN, THUMPER_HEAD_PX / THUMPER_SPAN); ctx.lineJoin = "round"; ctx.lineCap = "round";
        var pg = ctx.createLinearGradient(0, -E, 0, E); pg.addColorStop(0, P.pad); pg.addColorStop(1, P.padDark); ctx.fillStyle = pg; ctx.strokeStyle = P.padDark; ctx.lineWidth = 1.2;
        ctx.beginPath(); if (ctx.roundRect) { ctx.roundRect(-E, -E, E * 2, E * 2, 7 * B); } else { ctx.rect(-E, -E, E * 2, E * 2); } ctx.fill(); ctx.stroke();
        ctx.save(); ctx.beginPath(); if (ctx.roundRect) { ctx.roundRect(-E + 2, -E + 2, E * 2 - 4, E * 2 - 4, 5 * B); } else { ctx.rect(-E + 2, -E + 2, E * 2 - 4, E * 2 - 4); } ctx.clip();
        var eys = [-E + 4, E - 8];
        for (var c = 0; c < 2; c++) { var ey = eys[c]; for (var i = 0; i < 9; i++) { var x = -E + 3 + i * (E * 2 - 6) / 9; ctx.fillStyle = (i % 2 === 0) ? P.stripe : P.stripeDark;
            ctx.beginPath(); ctx.moveTo(x, ey + 4); ctx.lineTo(x + 3, ey); ctx.lineTo(x + 8, ey); ctx.lineTo(x + 5, ey + 4); ctx.closePath(); ctx.fill(); } }
        ctx.restore();
        var signs = [1, -1];
        for (var sx = 0; sx < 2; sx++) { for (var sy = 0; sy < 2; sy++) { var kx = signs[sx], ky = signs[sy];
            ctx.strokeStyle = P.metalDark; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(kx * (E - 5), ky * (E - 5)); ctx.lineTo(kx * 8 * B, ky * 8 * B); ctx.stroke();
            ctx.strokeStyle = P.metal; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(kx * (E - 5), ky * (E - 5)); ctx.lineTo(kx * 8 * B, ky * 8 * B); ctx.stroke();
            ctx.fillStyle = P.metalDark; ctx.beginPath(); ctx.arc(kx * (E - 4), ky * (E - 4), 1.6, 0, PI * 2); ctx.fill(); } }
        ctx.strokeStyle = P.rust; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(-10 * B, 10 * B); ctx.quadraticCurveTo(-14 * B, 15 * B, -12 * B, E - 3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(12 * B, 8 * B); ctx.quadraticCurveTo(15 * B, 13 * B, 14 * B, E - 5); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.strokeStyle = P.metalDark; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(0, 0, 10 * B, 0, PI * 2); ctx.stroke(); ctx.restore();
        var R = 16 * B; thumperHeadSprite = document.createElement("canvas"); thumperHeadSprite.width = THUMPER_HEAD_PX; thumperHeadSprite.height = THUMPER_HEAD_PX;
        ctx = thumperHeadSprite.getContext("2d"); ctx.save(); ctx.translate(THUMPER_HEAD_PX / 2, THUMPER_HEAD_PX / 2); var headScale = THUMPER_HEAD_PX / (R * 2 + 14); ctx.scale(headScale, headScale);
        var hg = ctx.createRadialGradient(-R * 0.3, -R * 0.3, R * 0.15, 0, 0, R * 1.05); hg.addColorStop(0, P.metal); hg.addColorStop(1, P.metalDark); ctx.fillStyle = hg; ctx.strokeStyle = P.metalDark; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(0, 0, R, 0, PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = P.metalDark; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.arc(0, 0, R - 2.6, 0, PI * 2); ctx.stroke();
        ctx.fillStyle = P.slab; ctx.beginPath(); ctx.arc(0, 0, R * 0.66, 0, PI * 2); ctx.fill(); ctx.strokeStyle = P.metalDark; ctx.beginPath(); ctx.arc(0, 0, R * 0.66, 0, PI * 2); ctx.stroke();
        var cg = ctx.createRadialGradient(-2, -2, 1, 0, 0, R * 0.36); cg.addColorStop(0, P.metal); cg.addColorStop(1, P.metalDark); ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, R * 0.36, 0, PI * 2); ctx.fill();
        ctx.fillStyle = P.metalDark; ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, PI * 2); ctx.fill();
        ctx.strokeStyle = P.metal; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(-1.4, 0); ctx.lineTo(1.4, 0); ctx.stroke();
        ctx.fillStyle = P.metalDark; for (var rb = 0; rb < 6; rb++) { var ra = rb * PI / 3 + 0.26; ctx.beginPath(); ctx.arc(Math.cos(ra) * (R - 5), Math.sin(ra) * (R - 5), 1.3, 0, PI * 2); ctx.fill(); }
        ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1.1; for (var tk = 0; tk < 3; tk++) { ctx.beginPath(); ctx.moveTo(-R * 0.52 + tk * 3.4, -R * 0.78); ctx.lineTo(-R * 0.52 + tk * 3.4 + 1.6, -R * 0.62); ctx.stroke(); } ctx.restore();
    }
    // Static slam phase fed from a wall clock; mem carries the per-card slam timer.
    function pl_thumper(x, y, mem) {
        if (thumperPadSprite == null) { buildThumperSprites(); }
        var ctx = gameContext, now = Date.now(), cfg = THUMP_CFG, period = cfg.thumperPeriod * 1000;
        if (mem.nextSlamAt == null) { mem.nextSlamAt = now + period; mem.lastSlamAt = 0; }
        if (now - mem.nextSlamAt > period) { mem.nextSlamAt += Math.ceil((now - mem.nextSlamAt) / period) * period; }
        if (now >= mem.nextSlamAt) { mem.lastSlamAt = mem.nextSlamAt; mem.nextSlamAt += period; }
        var u = 1 - (mem.nextSlamAt - now) / period; if (u < 0) { u = 0; }
        var h; if (u < 0.82) { var k = u / 0.82; h = k * k * (3 - 2 * k); } else if (u < 0.93) { h = 1; } else { h = 1 - (u - 0.93) / 0.07; }
        var s2 = (mem.lastSlamAt > 0) ? (now - mem.lastSlamAt) / 1000 : 9, worldScale = THUMPER_WORLD_SPAN / THUMPER_SPAN, B = THUMPER_BULK, R = 16 * B * worldScale, E = 22 * B * worldScale;
        ctx.save(); ctx.translate(x, y);
        ctx.save(); ctx.setLineDash([6, 6]); ctx.strokeStyle = THUMPER_PAL.stripe; ctx.globalAlpha = 0.10 + 0.30 * Math.exp(-s2 * 3); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(0, 0, cfg.repelRadius, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        for (var w = 0; w < 2; w++) { var wr = 18 * B * worldScale + (s2 + w * 0.06) * 170; if (wr > cfg.repelRadius * 1.25) { continue; } var wa = Math.max(0, 0.5 * Math.exp(-s2 * 2.2) - w * 0.12); if (wa <= 0.01) { continue; }
            ctx.strokeStyle = "rgba(230,225,210," + wa.toFixed(3) + ")"; ctx.lineWidth = 2.5 - w; ctx.beginPath(); ctx.arc(0, 0, wr, 0, Math.PI * 2); ctx.stroke(); }
        var dustA = 0.35 * Math.exp(-s2 * 3.5);
        if (dustA > 0.02) { ctx.fillStyle = THUMPER_PAL.dust; for (var dp = 0; dp < 8; dp++) { var dpa = dp * Math.PI / 4 + 0.3, dpd = 19 * B * worldScale + s2 * 60; ctx.globalAlpha = dustA; ctx.beginPath(); ctx.arc(Math.cos(dpa) * dpd, Math.sin(dpa) * dpd, 2.2 + s2 * 3, 0, Math.PI * 2); ctx.fill(); } ctx.globalAlpha = 1; }
        var j = Math.exp(-s2 * 9) * 1.4; ctx.translate(Math.sin(s2 * 70) * j, Math.cos(s2 * 55) * j);
        ctx.drawImage(thumperPadSprite, -THUMPER_WORLD_SPAN / 2, -THUMPER_WORLD_SPAN / 2, THUMPER_WORLD_SPAN, THUMPER_WORLD_SPAN);
        var animT = now / 1000;
        for (var li = 0; li < 2; li++) { var ls = (li === 0) ? 1 : -1, on = Math.sin(animT * (4 + h * 6) + ls) > 0; ctx.fillStyle = THUMPER_PAL.light; ctx.globalAlpha = on ? 1 : 0.22; ctx.beginPath(); ctx.arc(ls * (E - 4 * worldScale * B), E - 4 * worldScale * B, 1.7, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
        ctx.fillStyle = "rgba(0,0,0," + (0.18 + h * 0.14).toFixed(3) + ")"; ctx.beginPath(); ctx.ellipse(h * 6, h * 8, R * (1 + 0.1 * h), R * (0.92 + 0.1 * h), 0, 0, Math.PI * 2); ctx.fill();
        var headSpan = (R * 2 + 14 * worldScale) * (1 + 0.22 * h); ctx.drawImage(thumperHeadSprite, -headSpan / 2, -headSpan / 2, headSpan, headSpan);
        ctx.strokeStyle = THUMPER_PAL.metalDark; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.arc(0, 0, R + 4.5, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = THUMPER_PAL.metal; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, R + 4.5, 0, Math.PI * 2); ctx.stroke();
        var cageAngles = [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4]; ctx.strokeStyle = THUMPER_PAL.metalDark; ctx.lineWidth = 2.2;
        for (var ca = 0; ca < 4; ca++) { var a = cageAngles[ca], den = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))); ctx.beginPath(); ctx.moveTo(Math.cos(a) * (R + 4.5), Math.sin(a) * (R + 4.5)); ctx.lineTo(Math.cos(a) * (E - 4 * worldScale) / den, Math.sin(a) * (E - 4 * worldScale) / den); ctx.stroke(); }
        ctx.restore();
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

    SCENES["barrier"] = function (s) {
        // A solid map barrier: a kart drives into a wall, can't pass, and slides
        // down along its face — the block + slide the editor's fence/wall tool adds.
        var ctx = s.ctx;
        floor(ctx, "dirt.png", 60);
        var p = s.p; p.radius = 12; p.alive = true; p.surface = "normal";
        var wallX = W * 0.64;
        if (p.x == null) { p.x = -20; p.y = H * 0.28; }
        var step = 70 * (s.dt / 1000) * 1.7;
        if (p.x < wallX - p.radius) {
            p.x += step;
            if (p.x > wallX - p.radius) { p.x = wallX - p.radius; }
        } else {
            p.x = wallX - p.radius;       // blocked: can't cross
            p.y += step;                  // slides along the face
            if (p.y > H + 22) { p.x = -20; p.y = H * 0.28; }
        }
        // A concrete Jersey barrier (the "wall" style): grey slab, hazard-striped
        // crown, modular seams and a crack or two.
        var top = 6, bot = H - 6, halfW = 9, cx = wallX;
        ctx.save();
        ctx.fillStyle = "#bcc0c6";
        ctx.fillRect(cx - halfW, top, halfW * 2, bot - top);
        ctx.save();
        ctx.beginPath(); ctx.rect(cx - halfW, top, halfW * 2, bot - top); ctx.clip();
        // sloped-profile lips (left/right edges in shadow, since it runs vertically)
        ctx.fillStyle = "#8e939a";
        ctx.fillRect(cx - halfW, top, 2.5, bot - top);
        ctx.fillRect(cx + halfW - 3, top, 3, bot - top);
        // hazard stripe band down the crown
        ctx.save();
        ctx.beginPath(); ctx.rect(cx - 4.5, top, 9, bot - top); ctx.clip();
        ctx.fillStyle = "#26262a"; ctx.fillRect(cx - 4.5, top, 9, bot - top);
        ctx.fillStyle = "#e8b800";
        for (var yy = top - 18; yy < bot + 18; yy += 18) {
            ctx.beginPath();
            ctx.moveTo(cx - 4.5, yy);
            ctx.lineTo(cx - 4.5, yy + 9);
            ctx.lineTo(cx + 4.5, yy + 9 + 9);
            ctx.lineTo(cx + 4.5, yy + 9);
            ctx.closePath(); ctx.fill();
        }
        ctx.restore();
        // a seam + a crack
        ctx.strokeStyle = "rgba(70,72,78,0.45)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx - halfW, (top + bot) / 2); ctx.lineTo(cx + halfW, (top + bot) / 2); ctx.stroke();
        ctx.strokeStyle = "rgba(45,47,52,0.62)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx - halfW + 1, top + 8); ctx.lineTo(cx - 2, top + 16); ctx.lineTo(cx + 4, top + 22); ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = "rgba(60,62,68,0.55)"; ctx.lineWidth = 1;
        ctx.strokeRect(cx - halfW, top, halfW * 2, bot - top);
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

    SCENES["lockedDoor"] = function (s) {
        floor(s.ctx, "dirt.png", 60);
        var ctx = s.ctx, p = s.p; p.radius = 12; p.surface = "normal"; p.alive = true;
        var ph = loop(s.t, 4200);
        var grabbed = ph > 0.34, opened = ph > 0.74;
        var keyX = W * 0.40, doorX = W * 0.74, midY = H / 2;
        // Door: a triangle silhouette, dark while locked, glowing open once unlocked.
        ctx.save();
        ctx.translate(doorX, midY);
        ctx.beginPath(); ctx.moveTo(0, -23); ctx.lineTo(21, 17); ctx.lineTo(-21, 17); ctx.closePath();
        if (opened) {
            ctx.globalAlpha = 0.28; ctx.fillStyle = "#ff7043"; ctx.fill();
            ctx.globalAlpha = 0.95; ctx.lineWidth = 3; ctx.strokeStyle = "#ff7043"; ctx.stroke();
        } else {
            ctx.fillStyle = "#2b2438"; ctx.fill();
            ctx.lineWidth = 3; ctx.strokeStyle = "#ff7043"; ctx.stroke();
        }
        ctx.restore();
        // Loose key (matching triangle) until the kart reaches it.
        if (!grabbed) {
            ctx.save(); ctx.translate(keyX, midY);
            ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(10, 9); ctx.lineTo(-10, 9); ctx.closePath();
            ctx.fillStyle = "#ff7043"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
            ctx.restore();
        }
        // Kart drives in, grabs the key, carries it to the door.
        var tx = opened ? doorX
            : grabbed ? lerp(keyX, doorX, ease(clamp((ph - 0.34) / 0.40, 0, 1)))
                : lerp(-20, keyX, ease(clamp(ph / 0.34, 0, 1)));
        p.x = tx; p.y = midY; p.angle = 0;
        updateMovementParticles(p, s.dt);
        kart(ctx, p.x, p.y, p.radius, BLUE);
        if (grabbed && !opened) {
            var a = s.t / 300, ox = p.x + Math.cos(a) * 22, oy = midY + Math.sin(a) * 22;
            ctx.save(); ctx.translate(ox, oy);
            ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(7, 6); ctx.lineTo(-7, 6); ctx.closePath();
            ctx.fillStyle = "#ff7043"; ctx.fill(); ctx.restore();
        }
        onCycle(s.mem, s.t - 3120, 4200, "open", function () { spawnTeleportPuff(doorX, midY, "#ffd54a"); });
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

    SCENES["antlion"] = function (s) {
        floor(s.ctx, "sand.png", 60);
        var ctx = s.ctx;
        var ph = loop(s.t, 4200);
        // Thumper sanctuary on the right: a gray pad whose dashed ring flashes on
        // every pound; the kart flees into it, the antlion gets bounced back out.
        var tx = W * 0.78, ty = H * 0.52, ringR = 46;
        var pulse = loop(s.t, 950); // one pound per 0.95s
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = "#c9a23a";
        ctx.globalAlpha = 0.25 + 0.5 * Math.max(0, 1 - pulse * 3);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(tx, ty, ringR, 0, 2 * Math.PI); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#6b6e72";
        ctx.fillRect(tx - 12, ty - 12, 24, 24);
        ctx.fillStyle = "#767e88";
        ctx.beginPath(); ctx.arc(tx, ty, 8 + Math.max(0, 1 - pulse * 4) * 3, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = "#454c55"; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
        // Kart dawdles on the sand, then bolts for the ring once the bug erupts.
        var kx = ph < 0.3 ? W * 0.25 : lerp(W * 0.25, tx - 18, ease(clamp((ph - 0.3) / 0.45, 0, 1)));
        var ky = H * 0.52;
        kart(ctx, kx, ky, 11, BLUE);
        // The antlion: erupts at ph 0.3 from a dune behind the kart, chases just
        // a bit slower, and gets held at (and bounced off) the sanctuary ring.
        if (ph > 0.3) {
            var ae = clamp((ph - 0.3) / 0.08, 0, 1); // pop-out scale
            var ax = lerp(W * 0.12, tx - ringR - 12, ease(clamp((ph - 0.34) / 0.55, 0, 1)));
            var bounce = Math.max(0, 1 - pulse * 2.5) * (ph > 0.78 ? 14 : 0);
            ax -= bounce;
            var ay = ky + Math.sin(s.t / 90) * 2;
            ctx.save();
            ctx.translate(ax, ay);
            ctx.scale(ae, ae);
            // legs
            ctx.strokeStyle = "#4e4734"; ctx.lineWidth = 2; ctx.lineCap = "round";
            for (var l = 0; l < 3; l++) {
                var lw = Math.sin(s.t / 60 + l * 2.1) * 2;
                ctx.beginPath(); ctx.moveTo(-4 + l * 4, -4); ctx.lineTo(-8 + l * 5 + lw, -11); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(-4 + l * 4, 4); ctx.lineTo(-8 + l * 5 - lw, 11); ctx.stroke();
            }
            // segmented body (tail to the left, head toward the kart)
            ctx.fillStyle = "#8e8560";
            ctx.beginPath(); ctx.ellipse(-9, 0, 6, 4.5, 0, 0, 2 * Math.PI); ctx.fill();
            ctx.fillStyle = "#cfc29a"; ctx.strokeStyle = "#8e8560"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.ellipse(-1, 0, 6.5, 5.5, 0, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
            ctx.fillStyle = "#a8bb8a";
            ctx.beginPath(); ctx.ellipse(2, 0, 4.5, 4, 0, 0, 2 * Math.PI); ctx.fill();
            // mandibles snapping
            var snap = Math.max(0, Math.sin(s.t / 140)) * 0.5;
            ctx.strokeStyle = "#4f3f2a"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(7, -2); ctx.quadraticCurveTo(13, -4 - snap * 4, 15, -1); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(7, 2); ctx.quadraticCurveTo(13, 4 + snap * 4, 15, 1); ctx.stroke();
            ctx.restore();
            // eruption dust on the pop
            if (ph < 0.42) {
                ctx.save();
                ctx.fillStyle = "#d9c9a0";
                ctx.globalAlpha = 1 - (ph - 0.3) / 0.12;
                for (var dd = 0; dd < 5; dd++) {
                    var da = dd * 1.26;
                    ctx.beginPath();
                    ctx.arc(W * 0.12 + Math.cos(da) * (8 + ae * 12), ay + Math.sin(da) * (6 + ae * 9), 2.5, 0, 2 * Math.PI);
                    ctx.fill();
                }
                ctx.restore();
            }
        }
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

    // ========================= HAZARDS =========================
    // These scenes render the REAL in-game art via the ported pl_* drawers above
    // (world units), scaled to fit the card, with a world-space kart (radius 7.5,
    // the game's playerBaseRadius) so proportions match the live game.
    // (hazard-bumper reuses SCENES["bumper"]; hazard-antlion reuses SCENES["antlion"].)

    SCENES["movingBumper"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.5, 1.5);
        kart(c, 0, lerp(45, -45, loop(s.t, 2600)), 7.5, BLUE);
        pl_movingBumper(-50 + 100 * ping(s.t, 2600), 0, -50, 0, 0);
        c.restore();
    };

    SCENES["bumperWall"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.3, 1.3);
        pl_bumperWall(-60, 0, 0);
        kart(c, lerp(-30, 30, ping(s.t, 3000)), lerp(42, 13, ease(ping(s.t, 2200))), 7.5, BLUE);
        c.restore();
    };

    SCENES["rotor"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(0.72, 0.72);
        var deg = (s.t / 12) % 360, rad = deg * Math.PI / 180, R = HZ.rotor.orbitRadius;
        kart(c, Math.cos(rad + Math.PI) * R, Math.sin(rad + Math.PI) * R, 7.5, BLUE);
        pl_rotor(Math.cos(rad) * R, Math.sin(rad) * R, deg);
        c.restore();
    };

    SCENES["geyser"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 84); c.scale(1.3, 1.3);
        var ph = loop(s.t, 3000), state = ph < 0.5 ? 0 : ph < 0.72 ? 1 : ph < 0.85 ? 2 : 0;
        var ky = state === 2 ? -ease(clamp((ph - 0.72) / 0.13, 0, 1)) * 42 : -HZ.geyser.radius - 6;
        kart(c, 0, ky, 7.5, BLUE);
        pl_geyser(0, 0, state);
        c.restore();
    };

    SCENES["mine"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.7, 1.7);
        var ph = loop(s.t, 3200), state = ph < 0.45 ? 0 : ph < 0.62 ? 1 : ph < 0.72 ? 2 : 0;
        var kx = ph < 0.62 ? lerp(-46, -18, ease(clamp(ph / 0.62, 0, 1))) : lerp(-18, -52, ease(clamp((ph - 0.62) / 0.38, 0, 1)));
        kart(c, kx, ph >= 0.62 && ph < 0.72 ? -10 : 0, 7.5, BLUE);
        pl_mine(0, 0, state);
        c.restore();
    };

    SCENES["thumper"] = function (s) {
        floor(s.ctx, "sand.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(0.82, 0.82);
        kart(c, 50, 0, 7.5, BLUE);          // a kart sheltering inside the repel ring
        pl_thumper(0, 0, s.mem);
        c.restore();
    };

    SCENES["vortexWell"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(0.34, 0.34);
        pl_vortexWell(0, 0, HZ.vortexWell.radius);
        kart(c, lerp(-360, 360, loop(s.t, 2600)), -HZ.vortexWell.radius - 18, 9, BLUE);  // slingshots past the rim
        c.restore();
    };

    SCENES["laserGate"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(0.62, 0.62);
        var ph = loop(s.t, 2800), state = ph < 0.5 ? 0 : ph < 0.62 ? 1 : 2;
        pl_laserGate(0, -75, 90, state);
        if (ph < 0.4) { kart(c, lerp(-110, 110, ease(ph / 0.4)), 0, 7.5, BLUE); }   // darts through while open
        c.restore();
    };

    SCENES["crusher"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(0.62, 0.62);
        pl_crusher(-75 + 150 * ease(ping(s.t, 2000)), 0, -75, 0, 0);
        c.restore();
    };

    SCENES["sentryTurret"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(78, 70); c.scale(1.2, 1.2);
        var ph = loop(s.t, 2800), kx = lerp(40, 120, ping(s.t, 4000)), ky = Math.sin(s.t / 600) * 30;
        var ang = Math.atan2(ky, kx) * 180 / Math.PI, state = ph < 0.45 ? 0 : ph < 0.62 ? 1 : ph < 0.7 ? 2 : 0;
        pl_sentryTurret(0, 0, ang, state);
        kart(c, kx, ky, 7.5, BLUE);
        c.restore();
    };

    SCENES["magpieDrone"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.35, 1.35);
        var t = s.t / 1000, carrying = loop(s.t, 4000) > 0.5;
        var dx = lerp(-55, 55, ping(s.t, 4000)), faceLeft = dx < lerp(-55, 55, ping(s.t - 16, 4000));
        kart(c, 0, 24, 7.5, BLUE);
        if (!carrying) { var bi = img("bomb.svg"); c.save(); c.beginPath(); c.arc(0, 8, 6, 0, 2 * Math.PI); c.fillStyle = "rgba(255,255,255,0.9)"; c.fill(); if (ready(bi)) { c.drawImage(bi, -4.5, 3.5, 9, 9); } c.restore(); }
        pl_magpieDrone(dx, -22, -55, -22, 0, carrying, faceLeft, t);
        c.restore();
    };

    // ========================= BOONS =========================

    SCENES["dashArrows"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.3, 1.3);
        pl_dashArrows(0, 0, 0);
        kart(c, lerp(-80, 80, loop(s.t, 1800)), 0, 7.5, BLUE);
        c.restore();
    };

    SCENES["rechargeSpring"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.4, 1.4);
        var ph = loop(s.t, 3600), state = ph < 0.45 ? 100 : Math.floor(clamp((ph - 0.45) / 0.5, 0, 1) * 100);
        pl_rechargeSpring(0, 0, state);
        kart(c, lerp(-80, 80, loop(s.t, 3600)), 0, 7.5, BLUE);
        c.restore();
    };

    SCENES["slipstream"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.2, 1.2);
        pl_slipstream(0, 0, 0);
        kart(c, lerp(-46, 46, loop(s.t, 2600)), 0, 7.5, BLUE);
        c.restore();
    };

    SCENES["guardHalo"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.4, 1.4);
        pl_guardHalo(0, 0, 100);
        kart(c, lerp(-80, 80, loop(s.t, 3600)), 0, 7.5, BLUE);
        c.restore();
    };

    SCENES["secondWindTotem"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 84); c.scale(1.6, 1.6);
        drawFlagShape(0, 0, BN.secondWindTotem.color, Math.sin(s.t / 300) * 2.5, false);
        kart(c, lerp(-42, -8, ease(ping(s.t, 4000))), 0, 7.5, BLUE);
        c.restore();
    };

    SCENES["launchPad"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(70, 92); c.scale(1.5, 1.5);
        pl_launchPad(0, 0, -40);
        var ph = loop(s.t, 3000), ang = -40 * Math.PI / 180, t = clamp((ph - 0.35) / 0.5, 0, 1), dist = ph < 0.35 ? 0 : t * 120;
        var kx = ph < 0.35 ? lerp(-42, 0, ease(ph / 0.35)) : Math.cos(ang) * dist;
        var ky = ph < 0.35 ? 0 : Math.sin(ang) * dist - Math.sin(t * Math.PI) * 12;
        kart(c, kx, ky, 7.5, BLUE);
        c.restore();
    };

    SCENES["barrelCannon"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.4, 1.4);
        pl_barrelCannon(0, 0, (s.t / 9) % 360);
        c.restore();
    };

    SCENES["slingshotRings"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.0, 1.0);
        pl_slingshotRings(-34, 0, 0); pl_slingshotRings(34, 0, 0);
        kart(c, lerp(-100, 100, loop(s.t, 2600)), 0, 7.5, BLUE);
        c.restore();
    };

    SCENES["warpPad"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(1.1, 1.1);
        pl_warpPad(-60, 18, 0); pl_warpPad(60, -18, 0);
        var ph = loop(s.t, 3600), inT = ph > 0.4 && ph < 0.62;
        if (ph <= 0.4) { kart(c, lerp(-100, -60, ease(ph / 0.4)), 18, 7.5, BLUE); }
        else if (!inT) { kart(c, lerp(60, 100, ease(clamp((ph - 0.62) / 0.38, 0, 1))), -18, 7.5, BLUE); }
        c.restore();
    };

    SCENES["zipline"] = function (s) {
        floor(s.ctx, "dirt.png", 60); gameContext = s.ctx;
        var c = s.ctx; c.save(); c.translate(120, 70); c.scale(0.8, 0.8);
        var len = BN.zipline.minLength, ang = 18 * Math.PI / 180, t = ease(loop(s.t, 3600));
        pl_zipline(-70, -22, 18, len);
        kart(c, -70 + Math.cos(ang) * len * t, -22 + Math.sin(ang) * len * t + 9, 7.5, BLUE);
        c.restore();
    };

    SCENES["lilyPad"] = function (s) {
        var c = s.ctx; c.fillStyle = "#2f6fb0"; c.fillRect(0, 0, W, H); gameContext = s.ctx;
        c.save(); c.translate(120, 70); c.scale(0.7, 0.7);
        var pads = [-90, 0, 90], kx = lerp(-120, 120, loop(s.t, 3000));
        for (var i = 0; i < pads.length; i++) { var on = Math.abs(kx - pads[i]) < 46, sink = on ? clamp(1 - Math.abs(kx - pads[i]) / 46, 0, 1) * 70 : 0;
            pl_lilyPad(pads[i], 0, sink, 46, pads[i] * 0.3 + 10); }
        kart(c, kx, 0, 7.5, BLUE);
        c.restore();
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

    // Static list icons. The placeable icons render the REAL art (the ported
    // pl_* drawers), centred + scaled into the 40px chip — so the icon matches
    // the card animation and the in-game object.
    function iconArt(ctx, c, scl, fn) { gameContext = ctx; ctx.save(); ctx.translate(c, c); ctx.scale(scl, scl); fn(); ctx.restore(); }
    function staticIcon(canvas, name) {
        if (!canvas) { return; }
        var dpr = Math.min(2, window.devicePixelRatio || 1), size = 40;
        canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr);
        var ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, size, size);
        var c = size / 2, t = (window.performance ? performance.now() : 0) / 1000;
        var rrad = HZ.rotor.orbitRadius, ra = 0.9;
        var A = {
            bumper: function () { iconArt(ctx, c, 1.0, function () { pl_bumper(0, 0); }); },
            movingBumper: function () { iconArt(ctx, c, 1.0, function () { pl_bumper(0, 0); }); },
            bumperWall: function () { iconArt(ctx, c, 0.3, function () { pl_bumperWall(-60, 0, 0); }); },
            rotor: function () { iconArt(ctx, c, 0.24, function () { pl_rotor(Math.cos(ra) * rrad, Math.sin(ra) * rrad, ra * 180 / Math.PI); }); },
            geyser: function () { iconArt(ctx, c, 0.4, function () { pl_geyser(0, 0, 2); }); },
            mine: function () { iconArt(ctx, c, 0.9, function () { pl_mine(0, 0, 0); }); },
            thumper: function () { iconArt(ctx, c, 0.2, function () { pl_thumper(0, 0, {}); }); },
            vortexWell: function () { iconArt(ctx, c, 0.1, function () { pl_vortexWell(0, 0, HZ.vortexWell.radius); }); },
            laserGate: function () { iconArt(ctx, c, 0.22, function () { pl_laserGate(0, -75, 90, 2); }); },
            crusher: function () { iconArt(ctx, c, 0.3, function () { pl_crusher(0, 0, -40, 0, 0); }); },
            sentryTurret: function () { iconArt(ctx, c, 0.5, function () { pl_sentryTurret(0, 0, 0, 0); }); },
            magpieDrone: function () { iconArt(ctx, c, 0.7, function () { drawMagpieBird(HZ.magpieDrone.radius, t, true); }); },
            dashArrows: function () { iconArt(ctx, c, 0.4, function () { pl_dashArrows(0, 0, 0); }); },
            rechargeSpring: function () { iconArt(ctx, c, 0.5, function () { pl_rechargeSpring(0, 0, 100); }); },
            slipstream: function () { iconArt(ctx, c, 0.3, function () { pl_slipstream(0, 0, 0); }); },
            guardHalo: function () { iconArt(ctx, c, 0.52, function () { pl_guardHalo(0, 0, 100); }); },
            secondWindTotem: function () { iconArt(ctx, c, 0.55, function () { drawFlagShape(0, 12, BN.secondWindTotem.color, Math.sin(t * 3) * 2, false); }); },
            launchPad: function () { iconArt(ctx, c, 0.52, function () { pl_launchPad(0, 0, -30); }); },
            barrelCannon: function () { iconArt(ctx, c, 0.4, function () { pl_barrelCannon(0, 0, -90); }); },
            slingshotRings: function () { iconArt(ctx, c, 0.42, function () { pl_slingshotRings(0, 0, 0); }); },
            warpPad: function () { iconArt(ctx, c, 0.5, function () { pl_warpPad(0, 0, 0); }); },
            zipline: function () { iconArt(ctx, c, 0.5, function () { pl_zipline(-30, -10, 18, 60); }); },
            lilyPad: function () { iconArt(ctx, c, 0.32, function () { pl_lilyPad(0, 0, 0, 46, 10); }); }
        };
        if (A[name]) { try { A[name](); } catch (e) { /* image/sprite not ready — icon fills in on next build */ } }
    }

    return { attach: attach, staticIcon: staticIcon, SCENES: SCENES, W: W, H: H };
})();
