// audience.js — a live crowd in the letterbox.
//
// The play area is a fixed 16:9 arena (1366x768 logical), fitted + centred inside
// #gameWindow by resize(). On any screen that isn't exactly 16:9 the fit leaves
// empty "letterbox"/"pillarbox" bars around the arena (today just flat
// --board-bg). This module fills those bars with a tightly-packed stadium of fans
// — and ONLY those bars, so the play area is never covered or shrunk. When the
// viewport happens to be ~16:9 there are no bars and nothing is drawn ("off
// camera -> don't render").
//
// Seats are always present, but EMPTY during the lobby round — the crowd files in
// once a race is underway (gated/racing/collapsing/overview/gameOver). The crowd
// mirrors the AUDIO audience (audio.js): a calm collective sway whose energy
// tracks audienceIntensity, plus reactions in lockstep with the same cues that
// fire crowd sounds — a stadium wave for light cheers/tension (priority 1) and a
// full eruption + confetti for big moments (priority 2). Reactions are detected by
// watching audienceReactionUntil jump, so the visual fires even when SFX are muted.
//
// PERFORMANCE: it draws to its own canvas (#audienceCanvas) behind the play canvas
// and is built to be cheap —
//   * disabled entirely on phones/tablets (isTouchScreen);
//   * static seats are rendered ONCE to an offscreen layer and blitted each frame;
//   * fans are PRE-RENDERED sprites (palette x depth bucket x arms) so each fan is
//     a single drawImage per frame, not paths + fills + per-fan state changes;
//   * the whole crowd is throttled to ~30fps (the play canvas stays 60);
//   * the fan count scales with the actual letterbox area.

var audienceCanvas = null;
var audienceCtx = null;
var audienceDpr = 1;
var audienceInited = false;
var audienceTime = 0;            // accumulated ms (drives the idle sway)
var audienceRegions = [];        // [{ rect, dir, fans: [], confetti: [] }]
var audienceLayoutW = 0;         // gameWindow size the current layout was built for
var audienceLayoutH = 0;

// ~30fps throttle for the crowd canvas (the play canvas runs at full rate).
var AUDIENCE_FRAME_MS = 33;
var audienceAccum = 0;

// Offscreen layers (built on resize / once).
var audienceSeatCanvas = null;   // all static seats, pre-rendered; blitted per frame
var audienceSprites = null;      // [colorIdx][bucket] = { normal, arms } fan sprites
var AUDIENCE_DEPTH_BUCKETS = 5;
var AUDIENCE_SPRITE_SS = 2;      // supersample for crisp sprites on hi-DPR

// Reaction state, mirrored from audio.js cues.
var audienceTrackedUntil = 0;    // last audienceReactionUntil we've reacted to
var audienceReactionAge = 0;     // ms since the current reaction fired
var audienceReactionPriority = 0;
var audienceReacting = false;

// A small fixed palette of vibrant jersey colours that read on both the light
// (#ffffff) and dark (#15171a) board backgrounds.
var AUDIENCE_PALETTE = [
    "#e74c3c", "#3498db", "#f1c40f", "#2ecc71",
    "#9b59b6", "#e67e22", "#1abc9c", "#ff6fae"
];

// Sprite geometry, in nominal "fan size" units (a fan of size SPRITE_BASE).
var SPRITE_BASE = 36;
var SPRITE_W = Math.round(SPRITE_BASE * 1.5);   // box width  (room for spread arms)
var SPRITE_H = Math.round(SPRITE_BASE * 2.2);   // box height (room for raised arms)
var SPRITE_ANCHOR_X = SPRITE_W / 2;             // where the fan's centre line sits
var SPRITE_ANCHOR_Y = Math.round(SPRITE_BASE * 1.3); // where the fan's base 'y' sits

function audienceClamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

function initAudience() {
    if (audienceInited) {
        return true;
    }
    audienceCanvas = document.getElementById("audienceCanvas");
    if (audienceCanvas == null) {
        return false;
    }
    audienceCtx = audienceCanvas.getContext("2d");
    audienceInited = true;
    return true;
}

// Read the audience mood as a 0..1 "energy" — calm in the early match, restless
// near a win. Falls back gracefully if audio.js globals aren't present yet.
function audienceEnergy() {
    var t = (typeof audienceIntensity === "number") ? audienceIntensity : 0;
    return 0.4 + 0.6 * t;
}

// Are the seats occupied this frame? Empty in the lobby/waiting; the crowd files
// in once the race is underway. The demo override fills them everywhere.
function audiencePopulated() {
    if (typeof config === "undefined" || config == null || config.stateMap == null) {
        return false;
    }
    if (typeof currentState === "undefined") {
        return false;
    }
    var s = currentState, sm = config.stateMap;
    return s === sm.gated || s === sm.racing || s === sm.collapsing ||
        s === sm.overview || s === sm.gameOver;
}

// Skip the crowd entirely on phones/tablets — the play canvas already owns their
// frame budget, and a near-16:9 fullscreen phone has little/no letterbox anyway.
// isTouchScreen is the game's shared touch/coarse-pointer flag (input.js).
function audienceDisabled() {
    if (typeof isTouchScreen !== "undefined" && isTouchScreen === true) {
        return true;
    }
    // Low-end performance profiles drop the crowd to reclaim its frame budget
    // (e.g. a small desktop window that auto-resolved to LOW).
    if (typeof perfAudienceAllowed === "function" && !perfAudienceAllowed()) {
        return true;
    }
    return false;
}

// Pre-render the fan sprites once: every palette colour x depth bucket x
// {normal, arms-up}. Depth dimming AND alpha are baked into the pixels, so the
// per-frame draw is a single drawImage with no state changes.
function buildFanSprites() {
    if (audienceSprites != null) {
        return;
    }
    audienceSprites = [];
    for (var c = 0; c < AUDIENCE_PALETTE.length; c++) {
        var perBucket = [];
        for (var b = 0; b < AUDIENCE_DEPTH_BUCKETS; b++) {
            var depth = AUDIENCE_DEPTH_BUCKETS > 1 ? b / (AUDIENCE_DEPTH_BUCKETS - 1) : 0;
            var dim = 1 - depth * 0.4;
            var alpha = 0.6 + 0.4 * (1 - depth);
            perBucket.push({
                normal: paintFanSprite(AUDIENCE_PALETTE[c], dim, alpha, false),
                arms: paintFanSprite(AUDIENCE_PALETTE[c], dim, alpha, true)
            });
        }
        audienceSprites.push(perBucket);
    }
}

function paintFanSprite(color, dim, alpha, armsUp) {
    var cv = document.createElement("canvas");
    cv.width = SPRITE_W * AUDIENCE_SPRITE_SS;
    cv.height = SPRITE_H * AUDIENCE_SPRITE_SS;
    var ctx = cv.getContext("2d");
    ctx.setTransform(AUDIENCE_SPRITE_SS, 0, 0, AUDIENCE_SPRITE_SS, 0, 0);
    ctx.globalAlpha = alpha;

    var size = SPRITE_BASE;
    var x = SPRITE_ANCHOR_X, y = SPRITE_ANCHOR_Y;
    var headR = size * 0.42;
    var bodyW = size * 0.95;
    var bodyH = size * 1.0;
    var headY = y - bodyH * 0.5;

    ctx.fillStyle = shadeColor(color, dim);
    roundRectPath(ctx, x - bodyW / 2, y - bodyH * 0.2, bodyW, bodyH, bodyW * 0.3);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, headY, headR, 0, Math.PI * 2);
    ctx.fillStyle = shadeColor("#f0c27b", dim);
    ctx.fill();

    if (armsUp) {
        ctx.strokeStyle = shadeColor(color, dim);
        ctx.lineWidth = Math.max(1, size * 0.16);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x - bodyW * 0.35, y - bodyH * 0.15);
        ctx.lineTo(x - bodyW * 0.6, headY - headR * 0.8);
        ctx.moveTo(x + bodyW * 0.35, y - bodyH * 0.15);
        ctx.lineTo(x + bodyW * 0.6, headY - headR * 0.8);
        ctx.stroke();
    }
    return cv;
}

function audienceSprite(colorIdx, depth, armsUp) {
    var b = audienceClamp(Math.round(depth * (AUDIENCE_DEPTH_BUCKETS - 1)), 0, AUDIENCE_DEPTH_BUCKETS - 1);
    var s = audienceSprites[colorIdx][b];
    return armsUp ? s.arms : s.normal;
}

// Build the letterbox bar regions (in CSS px relative to #gameWindow) and fill
// each with a grid of seats/fans. Called from resize() and lazily when the layout
// size changes. The arena is the fitted newWidth x newHeight box, flex-centred
// inside #gameWindow, so the bars are simply gameWindow minus that centred box.
function resizeAudience() {
    if (!initAudience()) {
        return;
    }
    if (audienceDisabled()) {
        audienceRegions = [];
        return;
    }
    var gw = typeof canvasWindow !== "undefined" && canvasWindow ? canvasWindow.clientWidth : 0;
    var gh = typeof canvasWindow !== "undefined" && canvasWindow ? canvasWindow.clientHeight : 0;
    if (gw <= 0 || gh <= 0 || !newWidth || !newHeight) {
        return;
    }
    buildFanSprites();

    audienceDpr = Math.min(window.devicePixelRatio || 1, 2);
    audienceCanvas.width = Math.round(gw * audienceDpr);
    audienceCanvas.height = Math.round(gh * audienceDpr);
    audienceCanvas.style.width = gw + "px";
    audienceCanvas.style.height = gh + "px";

    audienceLayoutW = gw;
    audienceLayoutH = gh;

    var aw = newWidth, ah = newHeight;
    var ax = (gw - aw) / 2;
    var ay = (gh - ah) / 2;

    var BAR_MIN = 24; // a bar thinner than this can't hold a readable row of fans
    var bars = [
        { rect: { x: 0, y: 0, w: ax, h: gh }, dir: "right" },                       // left pillar
        { rect: { x: ax + aw, y: 0, w: gw - (ax + aw), h: gh }, dir: "left" },       // right pillar
        { rect: { x: ax, y: 0, w: aw, h: ay }, dir: "down" },                        // top bar
        { rect: { x: ax, y: ay + ah, w: aw, h: gh - (ay + ah) }, dir: "up" }         // bottom bar
    ];

    // Scale the fan cap to the actual empty area (device-independent CSS px) so a
    // tiny bar stays sparse and a huge ultrawide pillar can't explode the count.
    var totalArea = 0;
    for (var t = 0; t < bars.length; t++) {
        var rr = bars[t].rect;
        if (rr.w >= BAR_MIN && rr.h >= BAR_MIN) {
            totalArea += rr.w * rr.h;
        }
    }
    var maxFans = audienceClamp(Math.round(totalArea / 520), 60, 900);

    audienceRegions = [];
    var totalFans = 0;
    for (var b = 0; b < bars.length; b++) {
        var r = bars[b].rect;
        if (r.w < BAR_MIN || r.h < BAR_MIN) {
            continue; // no meaningful free space on this side -> render nothing
        }
        var fans = buildFans(r, bars[b].dir, gw);
        if (totalFans + fans.length > maxFans) {
            fans = fans.slice(0, Math.max(0, maxFans - totalFans));
        }
        totalFans += fans.length;
        audienceRegions.push({ rect: r, dir: bars[b].dir, fans: fans, confetti: [] });
        if (totalFans >= maxFans) {
            break;
        }
    }

    buildSeatLayer();
}

// Populate one bar with a tightly-packed, brick-staggered grid of seats — like
// stadium seating. Ordered back-to-front so nearer fans overdraw farther ones for
// a sense of depth. Each fan carries everything the per-frame draw needs.
function buildFans(rect, dir, gameWidth) {
    var fans = [];
    var thickness = (dir === "left" || dir === "right") ? rect.w : rect.h;
    var size = audienceClamp(thickness * 0.14, 6, 14);
    var stepX = size * 1.55;
    var stepY = size * 1.6;

    var cols = Math.max(1, Math.round(rect.w / stepX));
    var rows = Math.max(1, Math.round(rect.h / stepY));
    stepX = rect.w / cols;
    stepY = rect.h / rows;

    for (var j = 0; j < rows; j++) {
        // Brick stagger: shift every other row half a seat so the packing reads as
        // interlocking stadium rows rather than a rigid lattice.
        var rowShift = (j % 2 === 0) ? 0 : stepX * 0.5;
        for (var i = 0; i < cols; i++) {
            var cx = rect.x + (i + 0.5) * stepX + rowShift + (Math.random() - 0.5) * stepX * 0.1;
            var cy = rect.y + (j + 0.5) * stepY + (Math.random() - 0.5) * stepY * 0.1;
            // A staggered (odd) row's last seat overflows the bar — skip it rather
            // than clamping a denser column onto the edge.
            if (cx < rect.x + size * 0.5 || cx > rect.x + rect.w - size * 0.5) { continue; }
            if (cy < rect.y + size * 0.5 || cy > rect.y + rect.h - size * 0.5) { continue; }

            var depth;
            if (dir === "right") { depth = 1 - (cx - rect.x) / rect.w; }
            else if (dir === "left") { depth = (cx - rect.x) / rect.w; }
            else if (dir === "down") { depth = 1 - (cy - rect.y) / rect.h; }
            else { depth = (cy - rect.y) / rect.h; }
            depth = audienceClamp(depth, 0, 1);

            fans.push({
                cx: cx,
                cy: cy,
                size: size * (0.86 + 0.14 * (1 - depth)),
                depth: depth,
                colorIdx: Math.floor(Math.random() * AUDIENCE_PALETTE.length),
                // Coherent phase from position so neighbours sway TOGETHER (a slow
                // swell), not 600 independent jitters — much calmer to look at.
                phase: (cx + cy) * 0.012 + (Math.random() - 0.5) * 0.6,
                bobScale: 0.85 + Math.random() * 0.3,
                wavePos: audienceClamp(cx / Math.max(1, gameWidth), 0, 1),
                // pre-baked seat shading (depth-faded), used by the seat layer.
                seatAlpha: 0.16 + 0.22 * (1 - depth)
            });
        }
    }
    fans.sort(function (a, b) { return b.depth - a.depth; });
    return fans;
}

// Render every (static) seat ONCE into an offscreen layer. Blitted each frame so
// the lobby's empty stadium and the seats under the crowd cost a single drawImage.
function buildSeatLayer() {
    if (audienceSeatCanvas == null) {
        audienceSeatCanvas = document.createElement("canvas");
    }
    audienceSeatCanvas.width = Math.round(audienceLayoutW * audienceDpr);
    audienceSeatCanvas.height = Math.round(audienceLayoutH * audienceDpr);
    var ctx = audienceSeatCanvas.getContext("2d");
    ctx.setTransform(audienceDpr, 0, 0, audienceDpr, 0, 0);
    ctx.clearRect(0, 0, audienceLayoutW, audienceLayoutH);
    for (var g = 0; g < audienceRegions.length; g++) {
        var region = audienceRegions[g];
        ctx.save();
        ctx.beginPath();
        ctx.rect(region.rect.x, region.rect.y, region.rect.w, region.rect.h);
        ctx.clip();
        var fans = region.fans;
        for (var i = 0; i < fans.length; i++) {
            drawStadiumSeat(ctx, fans[i]);
        }
        ctx.restore();
    }
    ctx.globalAlpha = 1;
}

// A single front-facing stadium seat: a squarish, lightly-rounded backrest (lit,
// faces the viewer) with a darker seat pan tucked below it. Two tones give it a
// chair read instead of a flat pill. Drawn into the cached seat layer only.
function drawStadiumSeat(ctx, f) {
    var s = f.size;
    var bw = s * 0.92, bh = s * 0.86;
    var bx = f.cx - bw / 2, by = f.cy - bh * 0.5;
    ctx.globalAlpha = f.seatAlpha;

    // Seat pan / base (darker, in shadow at the bottom) — drawn first so the
    // backrest overlaps its top edge.
    ctx.fillStyle = "rgb(74,80,94)";
    roundRectPath(ctx, f.cx - bw * 0.46, by + bh * 0.55, bw * 0.92, bh * 0.45, s * 0.12);
    ctx.fill();

    // Backrest (lighter, faces us) — small corner radius so it reads square.
    ctx.fillStyle = "rgb(134,141,156)";
    roundRectPath(ctx, bx, by, bw, bh * 0.7, s * 0.18);
    ctx.fill();
}

// A single arch hop, 0..1..0 over `dur` ms; <0 before it starts, 0 after it ends.
function audienceHop(age, dur) {
    if (age < 0 || age > dur) {
        return 0;
    }
    return Math.sin(Math.PI * (age / dur));
}

function spawnConfetti(region, count) {
    var r = region.rect;
    // Cap per region so back-to-back priority-2 cues (a multi-kill flurry) can't
    // pile confetti up unbounded.
    count = Math.min(count, Math.max(0, 26 - region.confetti.length));
    for (var k = 0; k < count; k++) {
        region.confetti.push({
            x: r.x + Math.random() * r.w,
            y: r.y + r.h * (0.15 + Math.random() * 0.5),
            vx: (Math.random() - 0.5) * 0.12,
            vy: -0.18 - Math.random() * 0.22,
            size: 2 + Math.random() * 3,
            color: AUDIENCE_PALETTE[Math.floor(Math.random() * AUDIENCE_PALETTE.length)],
            rot: Math.random() * Math.PI,
            spin: (Math.random() - 0.5) * 0.02,
            life: 0,
            maxLife: 900 + Math.random() * 700
        });
    }
}

// Kick off a crowd reaction. Shared by the audio-cue detector and the demo timer.
function triggerReaction(priority) {
    audienceReactionPriority = priority;
    audienceReactionAge = 0;
    audienceReacting = true;
    if (priority >= 2) {
        for (var ri = 0; ri < audienceRegions.length; ri++) {
            spawnConfetti(audienceRegions[ri], 14);
        }
    }
}

// Per-frame entry point, called from gameLoop after the play frame is drawn.
function drawAudience(dt) {
    if (!initAudience()) {
        return;
    }
    if (typeof inLobby === "undefined" || !inLobby) {
        return;
    }
    if (audienceDisabled()) {
        if (audienceCanvas.width > 0) {
            audienceCtx.setTransform(1, 0, 0, 1, 0, 0);
            audienceCtx.clearRect(0, 0, audienceCanvas.width, audienceCanvas.height);
        }
        return;
    }
    var gw = (typeof canvasWindow !== "undefined" && canvasWindow) ? canvasWindow.clientWidth : 0;
    var gh = (typeof canvasWindow !== "undefined" && canvasWindow) ? canvasWindow.clientHeight : 0;
    if (gw > 0 && gh > 0 && (gw !== audienceLayoutW || gh !== audienceLayoutH)) {
        resizeAudience();
    }
    if (audienceRegions.length === 0) {
        if (audienceCanvas.width > 0) {
            audienceCtx.setTransform(1, 0, 0, 1, 0, 0);
            audienceCtx.clearRect(0, 0, audienceCanvas.width, audienceCanvas.height);
        }
        return;
    }

    // Throttle the crowd to ~30fps. Between redraws the last frame stays on the
    // canvas (we simply don't clear), so the play canvas keeps 60fps for free.
    audienceAccum += dt;
    if (audienceAccum < AUDIENCE_FRAME_MS) {
        return;
    }
    // Cap the step so a backgrounded-tab dt spike can't teleport confetti or jump
    // the sway when the tab refocuses (game-wide dt is uncapped).
    var frameDt = Math.min(audienceAccum, 100);
    audienceAccum = 0;

    audienceTime += frameDt;
    var populated = audiencePopulated();
    var energy = audienceEnergy();

    if (populated) {
        var until = (typeof audienceReactionUntil === "number") ? audienceReactionUntil : 0;
        if (until > audienceTrackedUntil) {
            audienceTrackedUntil = until;
            triggerReaction((typeof audienceCurrentPriority === "number") ? audienceCurrentPriority : 1);
        }
        if (audienceReacting) {
            audienceReactionAge += frameDt;
            var reactionSpan = audienceReactionPriority >= 2 ? 900 : 1500;
            if (audienceReactionAge > reactionSpan) {
                audienceReacting = false;
            }
        }
    } else {
        audienceReacting = false;
        audienceTrackedUntil = (typeof audienceReactionUntil === "number") ? audienceReactionUntil : 0;
    }

    audienceCtx.setTransform(audienceDpr, 0, 0, audienceDpr, 0, 0);
    audienceCtx.globalAlpha = 1; // defensive: nothing below relies on a stale alpha
    audienceCtx.clearRect(0, 0, audienceLayoutW, audienceLayoutH);

    // Static seats: one blit.
    if (audienceSeatCanvas != null) {
        audienceCtx.drawImage(audienceSeatCanvas, 0, 0, audienceLayoutW, audienceLayoutH);
    }

    for (var g = 0; g < audienceRegions.length; g++) {
        var region = audienceRegions[g];
        audienceCtx.save();
        // Clip to the bar so hopping fans never spill onto the play area.
        audienceCtx.beginPath();
        audienceCtx.rect(region.rect.x, region.rect.y, region.rect.w, region.rect.h);
        audienceCtx.clip();
        if (populated) {
            drawRegionFans(region, energy);
            drawRegionConfetti(region, frameDt);
        }
        audienceCtx.restore();
    }
}

function drawRegionFans(region, energy) {
    var fans = region.fans;
    var ctx = audienceCtx;
    for (var i = 0; i < fans.length; i++) {
        var f = fans[i];

        // Calm collective sway: gentle and slow; energy only nudges it.
        var freq = 0.0015 * (0.7 + 0.6 * energy);
        var bobAmp = f.size * (0.05 + 0.10 * energy) * f.bobScale;
        var bob = Math.sin(audienceTime * freq + f.phase) * bobAmp;

        // Reaction hop: stadium wave for light cues, synchronised eruption for big ones.
        var hop = 0;
        var armsUp = false;
        if (audienceReacting) {
            if (audienceReactionPriority >= 2) {
                var bigT = audienceReactionAge;
                hop = audienceHop(bigT, 480) + 0.45 * audienceHop(bigT - 460, 360);
                hop *= f.size * 1.5;
                armsUp = hop > f.size * 0.5;
            } else {
                var delay = f.wavePos * 650;
                var local = audienceReactionAge - delay;
                var w = audienceHop(local, 460);
                hop = w * f.size * 0.95;
                armsUp = w > 0.55;
            }
        }

        var yAnchor = f.cy - bob - hop;
        var scale = f.size / SPRITE_BASE;
        var dw = SPRITE_W * scale, dh = SPRITE_H * scale;
        ctx.drawImage(
            audienceSprite(f.colorIdx, f.depth, armsUp),
            f.cx - SPRITE_ANCHOR_X * scale,
            yAnchor - SPRITE_ANCHOR_Y * scale,
            dw, dh
        );
    }
}

function drawRegionConfetti(region, dt) {
    var c = region.confetti;
    for (var i = c.length - 1; i >= 0; i--) {
        var p = c[i];
        p.life += dt;
        p.vy += 0.0006 * dt;            // gravity
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        if (p.life >= p.maxLife || p.y > region.rect.y + region.rect.h + 10) {
            c.splice(i, 1);
            continue;
        }
        audienceCtx.save();
        audienceCtx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife);
        audienceCtx.translate(p.x, p.y);
        audienceCtx.rotate(p.rot);
        audienceCtx.fillStyle = p.color;
        audienceCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        audienceCtx.restore();
    }
}

// --- small local helpers -----------------------------------------------------

function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// Multiply a #rrggbb colour toward black by `mul` (1 = unchanged).
function shadeColor(hex, mul) {
    if (mul >= 1) {
        return hex;
    }
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    r = Math.round(r * mul);
    g = Math.round(g * mul);
    b = Math.round(b * mul);
    return "rgb(" + r + "," + g + "," + b + ")";
}
