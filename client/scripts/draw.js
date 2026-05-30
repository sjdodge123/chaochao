var scale = 0.035;
var spreadScale = 0.15;
var bombScale = 0.025;
var complexPatternScale = 0.1;

// --- Visibility tuning ---
// During the race, other players' kart bodies and trails are drawn fainter so
// your own kart(s) read clearly in a crowded pack (your kart already carries a
// pulsing halo via drawLocalPlayerHighlight). Threat FX (fire, ability rings,
// punches) are NOT dimmed — danger always stays full strength.
var NONLOCAL_KART_ALPHA = 0.55;
var NONLOCAL_TRAIL_ALPHA = 0.3;
// Other players' emote bubbles draw fainter than your own and fade out over the
// back half of their lifetime, so chat clutter doesn't crowd the action.
var NONLOCAL_EMOJI_ALPHA = 0.5;

// --- Colour-blind assist ---
// When colorblindEnabled (navbar toggle, persisted) is on, every kart is remapped
// to the Okabe-Ito palette — eight colours chosen to stay distinguishable under
// the common forms of colour-blindness. We mutate player.color in place (keeping
// the server's colour in player._serverColor) so every existing draw site — kart
// sprite, trail, ability rings, scoreboard icons — picks it up with no extra
// threading. Assignment is stable per player id and greedily maximises distance
// among the colours already handed out.
var CB_PALETTE = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#000000'];
var cbAssigned = {}; // player id -> CVD-safe colour

function cbHexToRgb(hex) {
    if (typeof hex !== "string") {
        return null;
    }
    var m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) {
        return null;
    }
    var h = m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function cbColorDist(a, b) {
    var ca = cbHexToRgb(a), cb = cbHexToRgb(b);
    if (ca == null || cb == null) {
        return Infinity;
    }
    var rmean = (ca.r + cb.r) / 2, dr = ca.r - cb.r, dg = ca.g - cb.g, db = ca.b - cb.b;
    return Math.sqrt((((512 + rmean) * dr * dr) / 256) + 4 * dg * dg + (((767 - rmean) * db * db) / 256));
}
function cbAssignColor(id) {
    if (cbAssigned[id] != null) {
        return cbAssigned[id];
    }
    var used = [];
    for (var k in cbAssigned) {
        used.push(cbAssigned[k]);
    }
    var best = null, bestScore = -1;
    for (var i = 0; i < CB_PALETTE.length; i++) {
        if (used.indexOf(CB_PALETTE[i]) !== -1) {
            continue; // hand out each palette colour once before repeating
        }
        var minDist = Infinity;
        for (var j = 0; j < used.length; j++) {
            var d = cbColorDist(CB_PALETTE[i], used[j]);
            if (d < minDist) {
                minDist = d;
            }
        }
        if (minDist > bestScore) {
            bestScore = minDist;
            best = CB_PALETTE[i];
        }
    }
    if (best == null) {
        // More than 8 karts: the CVD palette is exhausted. Return null (don't
        // cache) so the caller keeps this kart's already-max-distinct SERVER
        // colour instead of handing out a duplicate CVD colour. Re-resolves on a
        // later frame once a palette slot frees up.
        return null;
    }
    cbAssigned[id] = best;
    return best;
}
// Per-frame, cheap: keep every player's display colour in sync with the toggle.
// Idempotent — only writes when a colour actually needs to change.
function syncColorblind() {
    if (typeof playerList === "undefined" || !playerList) {
        return;
    }
    var on = (typeof colorblindEnabled !== "undefined" && colorblindEnabled);
    if (on) {
        // Drop assignments for players who have left so the 8-colour palette
        // doesn't appear "used up" over a session with lots of joins/leaves.
        for (var aid in cbAssigned) {
            if (playerList[aid] == null) {
                delete cbAssigned[aid];
            }
        }
    }
    for (var id in playerList) {
        var p = playerList[id];
        if (p == null) {
            continue;
        }
        if (on) {
            if (p._serverColor == null) {
                p._serverColor = p.color;
            }
            var cb = cbAssignColor(id);
            // cb == null => palette exhausted; keep the server colour (already set).
            if (cb != null && p.color !== cb) {
                p.color = cb;
            }
        } else if (p._serverColor != null && p.color !== p._serverColor) {
            p.color = p._serverColor;
        }
    }
}

// Theme-aware colours for canvas elements that sit on the board surface and
// must stay readable in dark mode (playfield fill/border + on-board text).
// theme.js keeps window.themePalette in sync with the active theme; the
// fallbacks match the original light-mode literals so this degrades safely if
// theme.js hasn't run yet. Intrinsic colours (player/tile/podium/hazard) are
// left untouched on purpose.
function themeColor(key, fallback) {
    var pal = (typeof window !== 'undefined') ? window.themePalette : null;
    return (pal && pal[key]) ? pal[key] : fallback;
}

var patterns = {};
var brutalPatterns = {};
var brutalRoundImages = {};

// Spawn-gate / start-line timing. Set by client.js state handlers (startGated /
// startRace); read by drawGateLine to ramp the countdown pulse and fire the
// green release flash. Declared here so they exist before any round begins.
var gatedStartTime = null;
var raceStartTime = null;

// Arena floor theme — flip to compare looks. 'water' = ocean + island
// reflections/shallows; 'space' = starfield void. The inactive theme's code is
// left in place so switching back is a one-line change.
var ARENA_FLOOR_THEME = 'space';
var exitIcon = new Image(576, 512);
exitIcon.src = "../assets/img/times-circle.svg";
var fullscreenIcon = new Image(576, 512);
fullscreenIcon.src = "../assets/img/expand-alt.svg";
var commentIconSolid = new Image(576, 512);
commentIconSolid.src = "../assets/img/comment-alt.svg";
var exitIconWhite = new Image(576, 512);
exitIconWhite.src = "../assets/img/white-esc.png";
var fullscreenIconWhite = new Image(576, 512);
fullscreenIconWhite.src = "../assets/img/white-expand.png";
var commentIconWhite = new Image(576, 512);
commentIconWhite.src = "../assets/img/white-chat.png";

var blindfoldIcon = new Image(576, 512);
blindfoldIcon.src = "../assets/img/low-vision.svg";
var blindfoldLargeIcon = new Image(576, 512);
blindfoldLargeIcon.src = "../assets/img/low-vision.svg";
blindfoldLargeIcon.scale = .5;

var transferIcon = new Image(576, 512);
transferIcon.src = "../assets/img/random.svg";
// Question-mark icon for un-resolved random tiles in the next-map preview
// thumbnail (the live map never has them — they're replaced before rendering —
// but `maps[i]` keeps the original ids that the thumbnail draws from).
var randomTileIcon = new Image(576, 512);
randomTileIcon.src = "../assets/img/question-solid.svg";
var copyIcon = new Image(576, 512);
copyIcon.src = "../assets/img/copy-regular.svg";
var bombIcon = new Image(576, 512);
bombIcon.src = "../assets/img/bomb.svg";
var snowFlakeIcon = new Image(576, 512);
snowFlakeIcon.src = "../assets/img/snowflake-solid.svg";


var windIcon = new Image(576, 512);
windIcon.src = "../assets/img/wind-solid.svg";
var hourglassIcon = new Image(576, 512);
hourglassIcon.src = "../assets/img/hourglass-start-solid.svg";

var lightningIcon = new Image(576, 512);
lightningIcon.src = "../assets/img/bolt-solid.svg";
var cloudyIcon = new Image(576, 512);
cloudyIcon.src = "../assets/img/cloud-solid.svg";
var infinityIcon = new Image(576, 512);
infinityIcon.src = "../assets/img/infinity-solid.svg";
var fiestaIcon = new Image(576, 512);
fiestaIcon.src = "../assets/img/cake-candles-solid.svg";
var toolBoxIcon = new Image(576, 512);
toolBoxIcon.src = "../assets/img/toolbox-solid.svg";
var moneyIcon = new Image(576, 512);
moneyIcon.src = "../assets/img/sack-dollar-solid.svg";
var volcanoIcon = new Image(576, 512);
volcanoIcon.src = "../assets/img/volcano-solid.svg";
var bombImage = new Image();
bombImage.src = "../assets/img/bomb.svg";
var snowFlakeImage = new Image(576, 512);
snowFlakeImage.src = "../assets/img/snowflake-solid.svg";
snowFlakeImage.scale = 0.05;
var cloudImage = new Image();
cloudImage.src = "../assets/img/cloud.svg";
cloudImage.scale = 1;
var infectionIcon = new Image(576, 512);
infectionIcon.src = "../assets/img/biohazard-solid.svg";
var puckIcon = new Image(576, 512);
puckIcon.src = "../assets/img/hockey-puck-solid.svg";
var explosionIcon = new Image(576, 512);
explosionIcon.src = "../assets/img/explosion-solid.svg";
var moonIcon = new Image(576, 512);
moonIcon.src = "../assets/img/moon-solid.svg";
var scissorsIcon = new Image(576, 512);
scissorsIcon.src = "../assets/img/scissors-solid.svg";

//TileTextures
var lava = new Image(256, 256);
lava.src = "../assets/img/lava.png";
var poison = new Image(128, 128);
poison.src = "../assets/img/poison.jpg";
poison.scale = 0.5;
var grass = new Image(256, 256);
grass.src = "../assets/img/grass.png";
grass.scale = 0.5;
var dirt = new Image(256, 256);
dirt.src = "../assets/img/dirt.png";
dirt.scale = 0.25;
var ice = new Image(256, 256);
ice.src = "../assets/img/ice.png";
ice.scale = 0.75;
var sand = new Image(256, 256)
sand.src = "../assets/img/sand.png";
sand.scale = 0.25;

var playerAnimating = null;

var mapCanvas = null;
var mapCtx = null;
var mapDirty = true;
var mapCanvasPad = 8;
// Bumped every time the terrain cache is re-rendered, so derived caches (the
// space island-depth FX) know to rebuild only when the terrain actually changed.
var mapCacheRev = 0;
// Offscreen cache for the space theme: the whole arena interior (starfield floor
// + island depth + terrain) baked into one canvas and blitted in a single pass
// per frame — see ensureArenaCache.
var arenaCanvas = null;
function invalidateMapCache() {
    mapDirty = true;
}
function discardMapCache() {
    mapCanvas = null;
    mapCtx = null;
    mapDirty = true;
    arenaCanvas = null;
}

// --- Persistent sand-trench (composited into the map cache) ---
// A kart trudging through sand carves a trench that lasts the whole round. Each
// segment is recorded and STAMPED INTO THE MAP CACHE (mapCanvas) — the texture
// that's already blitted under the karts every frame — so the trench costs ZERO
// extra per-frame work. (An earlier version kept a SECOND world-sized canvas and
// blitted it every frame; in the headless software-raster perf gate that doubled
// scripting ms/frame, and a per-frame full-world blit is exactly the fill-rate /
// re-upload pattern that hurts weak GPUs.) Segments live in `trenchSegments` and
// are replayed whenever the cache is rebuilt (a tile change, or a profile/scale
// switch). LOW never stamps (the extraFx gate upstream skips the whole trench).
// Stamping dirties the map texture (one GPU re-upload), but it's throttled by
// distance travelled (spawnSandTrail) to a few times a second.
var trenchSegments = [];
var TRENCH_SEGMENT_MAX = 800; // bound memory + cache-rebuild replay cost; oldest drop
function discardTrenchDecal() {
    if (trenchSegments.length > 0) {
        trenchSegments = [];
        invalidateMapCache(); // drop the baked-in trench on the next cache rebuild
    }
}
// Paint one trench segment (world coords) with the map-cache transform already
// applied: a recessed shadow groove flanked by two pale berms (sand shoved up to
// each lip). Shared by the live stamp and the cache-rebuild replay. Cumulative —
// a spot trudged repeatedly darkens, reading as well-worn sand.
function paintTrenchSegment(ctx, s) {
    var perp = s.dir + Math.PI / 2, off = s.r * 0.7;
    var ox = Math.cos(perp) * off, oy = Math.sin(perp) * off;
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = (typeof sandTrenchColor === "function") ? sandTrenchColor() : "rgba(120, 92, 52, 1)";
    ctx.lineWidth = off * 2;
    ctx.beginPath();
    ctx.moveTo(s.bx, s.by);
    ctx.lineTo(s.ex, s.ey);
    ctx.stroke();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = (typeof sandColor === "function") ? sandColor() : "rgba(250, 238, 205, 1)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.bx + ox, s.by + oy);
    ctx.lineTo(s.ex + ox, s.ey + oy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.bx - ox, s.by - oy);
    ctx.lineTo(s.ex - ox, s.ey - oy);
    ctx.stroke();
}
// Replay every recorded trench segment onto the map cache. Called from
// renderMapToCache while its world->cache transform is active.
//
// First drop any segment whose ground is no longer sand: a bomb/ice/tileSwap/collapse,
// an ability pickup, or the lobby idle-reset (restoreLobbyMap) can flip a sand tile
// back to something else, and the carved groove must not linger on a tile that isn't
// sand anymore. Every tile-change path invalidates the map cache, so pruning here —
// on the rebuild that follows — clears stale grooves no matter what changed the tile.
function paintTrenchSegments(ctx) {
    if (currentMap != null && currentMap.cells != null && trenchSegments.length > 0) {
        var sandId = config.tileMap.slow.id;
        var cells = currentMap.cells;
        // Build voronoiId -> current tile id ONCE (O(cells)), then drop any segment whose
        // stamped cell is no longer sand via an O(1) lookup. The previous per-segment
        // nearest-site scan was O(segments x cells) and, on tile-change-heavy rounds (a
        // brutal round rebuilds the cache most ticks, with up to TRENCH_SEGMENT_MAX
        // segments), measurably spiked per-frame scripting time.
        var idByVid = {};
        for (var c2 = 0; c2 < cells.length; c2++) {
            idByVid[cells[c2].site.voronoiId] = cells[c2].id;
        }
        var kept = [];
        for (var k = 0; k < trenchSegments.length; k++) {
            var s = trenchSegments[k];
            // s.vid is the sand cell the segment was stamped on; keep a legacy segment
            // without one rather than risk dropping a valid groove.
            if (s.vid == null || idByVid[s.vid] === sandId) {
                kept.push(s);
            }
        }
        trenchSegments = kept;
    }
    for (var i = 0; i < trenchSegments.length; i++) {
        paintTrenchSegment(ctx, trenchSegments[i]);
    }
}
// Record a trench segment and stamp it straight into the live map cache so it shows
// immediately (without waiting for the next cache rebuild). `vid` is the voronoiId of
// the sand cell the segment sits on, used for O(1) pruning when the tile changes.
function stampSandTrench(bx, by, ex, ey, dir, radius, vid) {
    trenchSegments.push({ bx: bx, by: by, ex: ex, ey: ey, dir: dir, r: radius, vid: vid });
    if (trenchSegments.length > TRENCH_SEGMENT_MAX) {
        trenchSegments.shift();
    }
    if (mapCanvas == null || mapCtx == null || world == null) {
        return; // not cached yet — the segment paints on the next cache rebuild
    }
    var scale = mapCanvas._mapScale || 1;
    var last = trenchSegments[trenchSegments.length - 1];
    // World -> map-cache transform, matching renderMapToCache's mapping.
    var tx = (-world.x + mapCanvasPad) * scale, ty = (-world.y + mapCanvasPad) * scale;
    mapCtx.save();
    mapCtx.setTransform(scale, 0, 0, scale, tx, ty);
    paintTrenchSegment(mapCtx, last);
    mapCtx.restore();
    // In the space theme drawMap blits the arena COMPOSITE (arenaCanvas), not
    // mapCanvas, and that composite only rebuilds on a full mapCacheRev bump — so a
    // live stamp into mapCanvas alone is invisible while driving (it only surfaced on
    // the next tile-change rebuild). arenaCanvas shares mapCanvas's dimensions and
    // pixel mapping, so mirror the stroke straight onto it (over the baked terrain)
    // so the trench shows immediately, exactly like the plain/water floor that blits
    // mapCanvas. A later full rebuild repaints arenaCanvas from the (pruned) mapCanvas.
    if (arenaCanvas != null) {
        var actx = arenaCanvas.getContext('2d');
        actx.save();
        actx.setTransform(scale, 0, 0, scale, tx, ty);
        paintTrenchSegment(actx, last);
        actx.restore();
    }
}

var playerSpriteCache = {};

var blackoutHoleSprite = null;
function getBlackoutHoleSprite() {
    if (blackoutHoleSprite != null) return blackoutHoleSprite;
    var size = 512;
    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    ctx.filter = "blur(50px)";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 50, 0, 2 * Math.PI);
    ctx.fillStyle = "white";
    ctx.fill();
    blackoutHoleSprite = canvas;
    return canvas;
}

// ---- Cart skins (procedural overlay, drawn on top of the colored cart) ----
// drawCartSkin builds a local coordinate space centered on the cart, rotated to
// the player's heading and scaled so the cart radius == 1.0; "forward" (travel
// direction) is +X. Each painter draws in that normalized space. Callers pass the
// already-camera-adjusted screen center, so the camera offset is never double-applied.
// Resolve any CSS colour (palette name/hex/colour-blind remap) to {r,g,b} by
// painting one pixel and reading it back — works for ANY colour without parsing.
// Cached; the palette is ~22 colours so this stays tiny.
var _cartSkinRGB = {};
function cartSkinRGB(color) {
    if (_cartSkinRGB[color] != null) {
        return _cartSkinRGB[color];
    }
    var c = document.createElement("canvas");
    c.width = c.height = 1;
    var cx = c.getContext("2d");
    cx.fillStyle = "#000";   // fallback if `color` is invalid
    cx.fillStyle = color;
    cx.fillRect(0, 0, 1, 1);
    var d = cx.getImageData(0, 0, 1, 1).data;
    var rgb = { r: d[0], g: d[1], b: d[2] };
    _cartSkinRGB[color] = rgb;
    return rgb;
}
// Lighten (amt>0, toward white) / darken (amt<0, toward black) a colour by a 0..1
// fraction, so one picked colour fans out into body/outline/leg shades.
function cartSkinShade(color, amt) {
    var c = cartSkinRGB(color);
    var t = amt < 0 ? 0 : 255;
    var f = amt < 0 ? -amt : amt;
    return "rgb(" +
        Math.round(c.r + (t - c.r) * f) + "," +
        Math.round(c.g + (t - c.g) * f) + "," +
        Math.round(c.b + (t - c.b) * f) + ")";
}

function getCartHeading(player) {
    var vx = player.velX || 0;
    var vy = player.velY || 0;
    if (vx * vx + vy * vy > 0.01) {
        return Math.atan2(vy, vx);
    }
    if (typeof player.angle === "number") {
        // player.angle is in DEGREES on the client (cf. drawFire / aimers), but the
        // velocity branch above returns radians — convert so an idle skinned kart
        // faces its heading. 0° (due east) is a valid heading, not "missing".
        return player.angle * Math.PI / 180;
    }
    return -Math.PI / 2; // default: face up
}

function getCartSpeed(player) {
    var vx = player.velX || 0;
    var vy = player.velY || 0;
    return Math.sqrt(vx * vx + vy * vy);
}

// Single source of truth for cart-skin dispatch. A skin name maps to its
// procedural painter; null means "no skin" (plain colour disc). Add future
// skins HERE and they automatically work everywhere this is consulted: the live
// kart, the scoreboard notch icon, and the ice reflection.
function cartSkinPainter(name) {
    if (name === "firetruck") { return drawFiretruckSkin; }
    if (name === "dino") { return drawDinoSkin; }
    return null;
}
// Draw a kart's core appearance (skin or plain colour disc) centred at screen
// (sx,sy). No highlights/avatar/FX — just the body — so callers like the ice
// reflection get a faithful, skin-aware image for any current or future skin.
function drawKartAppearance(player, sx, sy, headingOverride) {
    var painter = cartSkinPainter(player.cartSkin);
    if (painter != null) {
        drawCartSkin(player, sx, sy, player.radius, painter, headingOverride);
        return;
    }
    var sprite = getPlayerSprite(player.color, player.radius, null);
    if (sprite != null) {
        gameContext.drawImage(sprite, sx - sprite.halfSize, sy - sprite.halfSize);
    }
}

function drawCartSkin(player, centerX, centerY, radius, painter, headingOverride) {
    var ctx = gameContext;
    // headingOverride pins the skin to a fixed angle (used by the overview scoreboard, a
    // static display — otherwise it'd freeze at whatever heading the kart had when the
    // race ended). A pinned heading also implies an idle pose (no movement-driven anim).
    var pinned = (typeof headingOverride === "number");
    var heading = pinned ? headingOverride : getCartHeading(player);
    var speed = pinned ? 0 : getCartSpeed(player);
    // Animation runs faster while moving, but always ticks a little when idle.
    var anim = cartSkinAnimTime * (0.6 + Math.min(speed, 6) * 0.5);
    // Punch animation: a quick forward lunge + scale "pop" when this kart throws a
    // melee punch (seeded by the server "punch" event -> player.punchAnimAt). Sharp
    // attack (peak at 30% of the window) and gentler settle, so it reads as an impact
    // rather than a pulse; applies to every skin since it lives here in drawCartSkin.
    var punchK = 0;
    if (player && player.punchAnimAt != null) {
        var pe = (Date.now() - player.punchAnimAt) / 220;
        if (pe >= 0 && pe < 1) {
            punchK = (pe < 0.3) ? (pe / 0.3) : (1 - (pe - 0.3) / 0.7);
        }
    }
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(heading);
    ctx.scale(radius, radius);
    if (punchK > 0) {
        ctx.translate(punchK * 0.12, 0);                    // lunge forward (heading is local +X)
        ctx.scale(1 + punchK * 0.14, 1 + punchK * 0.14);    // impact pop
    }
    var paint = (player && player.color) ? player.color : null;
    // While burning, tint the skin toward glowing hot-orange (NOT black) so it reads as
    // the skin itself on fire while staying recognizable — charring toward black just
    // turned the small kart into an unreadable dark blob ("looks like a regular cart").
    if (paint && player.onFire > 0) {
        var hc = cartSkinRGB(paint), hf = 0.6;
        paint = "rgb(" + Math.round(hc.r + (255 - hc.r) * hf) + "," +
            Math.round(hc.g + (90 - hc.g) * hf) + "," +
            Math.round(hc.b + (10 - hc.b) * hf) + ")";
    }
    painter(ctx, anim, paint, !!(player && player.onFire > 0));
    ctx.restore();
}

// Rounded-rect path helper (CanvasRenderingContext2D.roundRect isn't available on
// every target we support).
function cartRoundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

function drawFiretruckSkin(ctx, anim, paint, hot) {
    // Normalized space (radius == 1), forward == +X. Five-Alarm monster truck,
    // painted in the player's chosen cart colour (tinted body + darker outline),
    // white "5" badge, ladder, big wheels with spinning spokes.
    paint = paint || "#d11f1f";
    var wheelR = 0.42;
    var wheels = [
        [0.5, 0.72],
        [0.5, -0.72],
        [-0.5, 0.72],
        [-0.5, -0.72],
    ];
    for (var i = 0; i < wheels.length; i++) {
        ctx.save();
        ctx.translate(wheels[i][0], wheels[i][1]);
        ctx.beginPath();
        ctx.arc(0, 0, wheelR, 0, Math.PI * 2);
        ctx.fillStyle = "#1a1a1a";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, wheelR * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = "#cfcfcf";
        ctx.fill();
        ctx.rotate(anim * 3); // spinning spokes
        ctx.strokeStyle = "#555";
        ctx.lineWidth = 0.06;
        for (var s = 0; s < 4; s++) {
            var a = (s * Math.PI) / 2;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a) * wheelR * 0.85, Math.sin(a) * wheelR * 0.85);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Body (player colour) with a darker outline of the same hue — or a bright glowing
    // outline while burning, so the hot-orange truck reads as molten-hot.
    ctx.fillStyle = cartSkinShade(paint, -0.05);
    ctx.strokeStyle = hot ? "#ffe27a" : cartSkinShade(paint, -0.45);
    ctx.lineWidth = 0.07;
    cartRoundRectPath(ctx, -0.78, -0.52, 1.56, 1.04, 0.18);
    ctx.fill();
    ctx.stroke();

    // Cab window (front, toward +X).
    ctx.fillStyle = "#bfe6ff";
    cartRoundRectPath(ctx, 0.28, -0.34, 0.4, 0.68, 0.08);
    ctx.fill();

    // Ladder rails + rungs.
    ctx.strokeStyle = "#e8e8e8";
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(-0.55, -0.18);
    ctx.lineTo(0.15, -0.18);
    ctx.moveTo(-0.55, 0.18);
    ctx.lineTo(0.15, 0.18);
    ctx.stroke();
    for (var r = 0; r < 4; r++) {
        var lx = -0.5 + r * 0.18;
        ctx.beginPath();
        ctx.moveTo(lx, -0.18);
        ctx.lineTo(lx, 0.18);
        ctx.stroke();
    }

    // White "5" badge.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(-0.32, 0, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cartSkinShade(paint, -0.05);
    ctx.save();
    ctx.font = "0.3px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.translate(-0.32, 0);
    ctx.fillText("5", 0, 0.02);
    ctx.restore();
}

function drawDinoSkin(ctx, anim, paint, hot) {
    // Top-down dino painted in the player's chosen cart colour (tinted body/limbs,
    // darker legs + spine of the same hue). Head toward +X, tail toward -X.
    paint = paint || "#43b047";
    var legSwing = Math.sin(anim * 4) * 0.22;
    // Scale the whole dino up so its body fills more of the cart's circle (it read
    // small next to the plain disc). The tail tip and head front are pulled in below
    // so that even after this scale the silhouette stays inside radius 1.0 (the cart
    // boundary) — nothing extends past where the regular cart would.
    ctx.save();
    ctx.scale(1.12, 1.12);
    // Contrasting dark outline traced around every part (not just the body/head, and
    // not the old low-contrast darkened-hue line) so the dino's silhouette reads
    // clearly against any terrain or kart colour — same idea as the regular cart's
    // black rim. Round joins/caps keep the outline clean at the leg/tail/spine points.
    // When burning, glow the outline bright and barely darken the limbs/spine, so the
    // hot-orange dino reads as molten-hot instead of a dark silhouette in the flames.
    var outline = hot ? "#ffe27a" : "#141414";
    var outlineW = 0.11;
    var shadeDeep = hot ? -0.1 : -0.35;
    var shadeTail = hot ? -0.04 : -0.12;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = outline;
    ctx.lineWidth = outlineW;

    // Legs (under body).
    ctx.fillStyle = cartSkinShade(paint, shadeDeep);
    var legs = [
        [0.28, 0.55, legSwing],
        [-0.3, 0.55, -legSwing],
        [0.28, -0.55, -legSwing],
        [-0.3, -0.55, legSwing],
    ];
    for (var i = 0; i < legs.length; i++) {
        ctx.beginPath();
        ctx.ellipse(legs[i][0] + legs[i][2], legs[i][1], 0.16, 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }

    // Tail.
    ctx.fillStyle = cartSkinShade(paint, shadeTail);
    ctx.beginPath();
    ctx.moveTo(-0.55, -0.18);
    ctx.lineTo(-0.88, 0); // tail tip pulled in: -0.88 * 1.12 ≈ -0.99, inside the boundary
    ctx.lineTo(-0.55, 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Body.
    ctx.fillStyle = paint;
    ctx.beginPath();
    ctx.ellipse(-0.05, 0, 0.6, 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Spine plates.
    ctx.fillStyle = cartSkinShade(paint, shadeDeep);
    for (var p = 0; p < 3; p++) {
        var px = -0.3 + p * 0.28;
        ctx.beginPath();
        ctx.moveTo(px - 0.1, 0);
        ctx.lineTo(px, -0.22);
        ctx.lineTo(px + 0.1, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    // Head.
    ctx.fillStyle = paint;
    ctx.beginPath();
    ctx.ellipse(0.58, 0, 0.3, 0.26, 0, 0, Math.PI * 2); // head pulled in: front 0.88 * 1.12 ≈ 0.99
    ctx.fill();
    ctx.stroke();

    // Eye.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(0.68, -0.12, 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(0.70, -0.12, 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}
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
    explosionIcon, moonIcon, scissorsIcon, randomTileIcon,
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
    // Random tiles are replaced (applyRandomTiles) before any cell in the LIVE
    // map renders, so this pattern is only used by the next-map preview
    // thumbnail (buildMapThumbnailCanvas), which draws straight from maps[i]'s
    // un-replaced cell ids. Without it the thumbnail fell back to flat purple.
    patterns[config.tileMap.random.id] = makePattern(randomTileIcon, config.tileMap.random.color);



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

var notchDistanceApart = 0,
    decodedColorName = '';
// Timestamp (ms) of the most recent overview entry, so the per-player notch-delta
// floats ("+2"/"+1"/"−1") can pop and fade off a wall-clock timer that's re-armed
// each round (in calculateNotchMoveAmt) and never replays once the window passes.
var notchFloatStart = null;
var NOTCH_FLOAT_DURATION = 1200; // ms — quick pop, in step with the notch-fill anim

function drawObjects(dt) {
    if (config == null) {
        return;
    }
    syncColorblind();

    // Ease entity render positions toward their latest 30Hz server targets, so
    // motion is smooth at 60fps instead of stepping at the tick rate. Runs before
    // the camera so it tracks the smoothed local kart. (see gameboard.js)
    if (typeof smoothEntities === "function") {
        smoothEntities(dt);
    }

    updateWorldCamera(dt);
    applyCanvasTransform();
    drawBackground(dt);
    if (currentState == config.stateMap.overview) {
        shakeTrauma = 0;
        drawOverviewBoard();
        return;
    }
    // After the overview early-return (which skips drawEffects): only spawn death
    // pings in states where the effect will actually be rendered this frame, so a
    // press never burns its cooldown invisibly.
    updateDeathPings();

    // ---- WORLD PASS: zoomed/panned by the dynamic camera (touch); identity
    // elsewhere. Everything positioned in world coords goes here. ----
    applyWorldTransform();
    preShake();
    drawWorld(dt);
    cameraOnMyPlayer();
    if (currentState == config.stateMap.lobby) {
        // Map first: for space it's the single arena composite (floor baked in),
        // so the lobby grid + props must overlay it rather than be painted under.
        drawMap();
        drawLobbyFloor();
        drawLobbyArrows();
        drawLobbyStartButton();
        if (typeof drawLobbyStationZones === "function") {
            drawLobbyStationZones();
        }
    }
    if (currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing) {
        // Map (the space arena composite carries the floor) first, then the gate
        // on top of it.
        drawMap();
        drawGate();
        drawArenaVignette();
        drawPendingSwap();
        drawPingCircles();
        drawCollapseShockwaves();
    }
    if (currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing) {
        // gated: pulsing red countdown line. racing: brief green release flash.
        drawGateLine();
    }
    // Animated terrain overlays (goal beacon, lava convection, ice reflections,
    // swaying/kart-pushed grass blades). Drawn over the terrain and UNDER the
    // karts; self-gates by state + perf profile.
    if (typeof drawTerrainFX === "function") {
        drawTerrainFX(dt);
    }
    drawPlayers(dt);
    drawProjectiles(dt);
    drawRecordFloats();
    drawEffects();
    drawAbilties();
    drawOverlay();
    postShake();

    // ---- HUD PASS: screen space, never zoomed (score, map title, touch
    // controls, mode indicators, game-over). ----
    applyCanvasTransform();
    if (currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing) {
        drawMapTitle();
    }
    drawSpectatorBanner();
    drawHUD();
    drawMouseDriveIndicator();
    drawOffscreenGoalIndicator();
    if (typeof drawLobbyHubHud === "function") {
        drawLobbyHubHud();
    }

    if (currentState == config.stateMap.gameOver) {
        drawGameOverScreen(dt);
    }

}

// Scale the device-resolution backing store back onto the fixed 1366x768
// logical drawing space, so every game/HUD/touch coordinate stays in logical
// units yet renders at full device resolution. setTransform is absolute, so
// calling it once per frame also resets any stray transform from a prior frame.
function applyCanvasTransform() {
    if (gameContext) {
        gameContext.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
    }
    if (overlayContext) {
        overlayContext.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
    }
}

// --- dynamic touch camera (world zoom) ---------------------------------------
// World coordinates are the logical 1366x768 space (drawn 1:1 today), so the
// "whole map" view is identity: centre at LOGICAL/2, scale 1. While racing we
// frame a tight box on the player (high resolution on a phone) and grow it to
// include the nearest goal as the player approaches it. The view is smoothed
// toward its target each frame; applyWorldTransform composes it with the DPR
// scale so the world zooms but the HUD/touch controls (drawn under the base
// transform) stay put. Enabled via cameraZoomEnabled (the navbar camera toggle;
// defaults on for touch, off but toggleable otherwise). Mouse aiming is
// inverse-mapped through this transform in calcMousePos, so it stays correct
// when the camera is enabled on desktop.

function worldGoalPoints() {
    var pts = [];
    if (typeof currentMap !== "undefined" && currentMap && currentMap.cells &&
        config && config.tileMap && config.tileMap.goal) {
        var gid = config.tileMap.goal.id;
        for (var i = 0; i < currentMap.cells.length; i++) {
            var c = currentMap.cells[i];
            if (c && c.id === gid && c.site) {
                pts.push({ x: c.site.x, y: c.site.y });
            }
        }
    }
    return pts;
}

// When the dynamic camera is zoomed in and no goal is on-screen, pin an arrow to
// the edge of the screen pointing toward the nearest goal so players always know
// which way to race. Drawn in the HUD pass (screen space), so it hugs the edge
// regardless of world zoom. No-ops at the whole-map view since a goal is then
// visible (anyVisible) and outside the live race states.
function drawOffscreenGoalIndicator() {
    if (currentState !== config.stateMap.gated &&
        currentState !== config.stateMap.racing &&
        currentState !== config.stateMap.collapsing) {
        return;
    }
    if (!worldView || myPlayer == null || myPlayer.alive == false) {
        return;
    }
    var goals = worldGoalPoints();
    if (goals.length === 0) {
        return;
    }
    var s = worldView.scale || 1;
    // Only when actually zoomed in. At the whole-map view (scale 1) the entire
    // arena — and every goal — already fits on screen, so an edge arrow would be
    // wrong (and the visMargin inset below could otherwise mislabel an
    // edge-of-arena goal as off-screen).
    if (s <= 1) {
        return;
    }
    var cx = LOGICAL_WIDTH / 2, cy = LOGICAL_HEIGHT / 2;
    var nearest = null, nd = Infinity, anyVisible = false;
    var visMargin = 36;
    for (var i = 0; i < goals.length; i++) {
        var sx = cx + (goals[i].x - worldView.cx) * s;
        var sy = cy + (goals[i].y - worldView.cy) * s;
        if (sx >= visMargin && sx <= LOGICAL_WIDTH - visMargin &&
            sy >= visMargin && sy <= LOGICAL_HEIGHT - visMargin) {
            anyVisible = true;
        }
        var dx = goals[i].x - myPlayer.x, dy = goals[i].y - myPlayer.y;
        var d = dx * dx + dy * dy;
        if (d < nd) { nd = d; nearest = goals[i]; }
    }
    if (anyVisible || nearest == null) {
        return;
    }
    // Edge point along the direction from screen centre to the nearest goal,
    // clamped to an inset rectangle so the arrow sits just inside the viewport.
    var gsx = cx + (nearest.x - worldView.cx) * s;
    var gsy = cy + (nearest.y - worldView.cy) * s;
    var ang = Math.atan2(gsy - cy, gsx - cx);
    var inset = 48;
    var hw = LOGICAL_WIDTH / 2 - inset, hh = LOGICAL_HEIGHT / 2 - inset;
    var ca = Math.cos(ang), sa = Math.sin(ang);
    var tX = Math.abs(ca) > 1e-4 ? hw / Math.abs(ca) : Infinity;
    var tY = Math.abs(sa) > 1e-4 ? hh / Math.abs(sa) : Infinity;
    var rr = Math.min(tX, tY);
    var ex = cx + ca * rr, ey = cy + sa * rr;
    var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
    var bob = Math.sin(Date.now() / 260) * 6;           // gentle float along the aim, beckoning toward the goal
    var goalColor = (config.tileMap.goal && config.tileMap.goal.color) ? config.tileMap.goal.color : "#FFE23A";
    gameContext.save();
    gameContext.globalAlpha = 0.92;
    gameContext.translate(ex, ey);
    gameContext.rotate(ang);                            // tip (+x) points outward toward the goal
    gameContext.translate(bob, 0);                      // local +x = toward the goal, so it bobs along the aim
    gameContext.shadowColor = goalColor;
    // Skip the per-frame glow on profiles that disable it (the arrow still reads
    // via its bright fill + dark outline).
    gameContext.shadowBlur = (typeof perfGlow !== "function" || perfGlow()) ? (12 + 12 * pulse) : 0;
    // Same chunky block arrow as the lobby arrows, tip at origin pointing +x.
    gameContext.beginPath();
    gameContext.moveTo(0, 0);
    gameContext.lineTo(-26, -22);
    gameContext.lineTo(-26, -9);
    gameContext.lineTo(-50, -9);
    gameContext.lineTo(-50, 9);
    gameContext.lineTo(-26, 9);
    gameContext.lineTo(-26, 22);
    gameContext.closePath();
    gameContext.fillStyle = goalColor;
    gameContext.fill();
    gameContext.shadowBlur = 0;
    gameContext.lineWidth = 4;
    gameContext.lineJoin = "round";
    gameContext.strokeStyle = "#C24B00";
    gameContext.stroke();
    gameContext.restore();
}

// Clamp a view centre so the visible window never reveals outside the world
// bounds (at scale 1 the whole world fits, so it locks to the world centre).
function clampViewToWorld(cx, cy, scale) {
    var visHalfW = LOGICAL_WIDTH / (2 * scale), visHalfH = LOGICAL_HEIGHT / (2 * scale);
    cx = (world.width <= visHalfW * 2) ? (world.x + world.width / 2)
        : Math.max(world.x + visHalfW, Math.min(world.x + world.width - visHalfW, cx));
    cy = (world.height <= visHalfH * 2) ? (world.y + world.height / 2)
        : Math.max(world.y + visHalfH, Math.min(world.y + world.height - visHalfH, cy));
    return { cx: cx, cy: cy, scale: scale };
}

// World positions of every LIVING local player (so split-on-one-screen co-op
// keeps everyone framed). Reuses livingLocalPlayers() so dead / mid-round
// spectating local players — parked off-arena at (-100,-100) by the server —
// don't drag the camera. Only local players are followed (remote/online players
// live elsewhere on the map). Falls back to the primary myPlayer only when it's
// alive; if nobody local is alive, returns empty (computeFocusedView -> whole map
// so a dead/spectating cohort can watch the action).
function focusWorldPoints() {
    var pts = [];
    var living = livingLocalPlayers();
    for (var i = 0; i < living.length; i++) {
        pts.push({ x: living[i].x, y: living[i].y });
    }
    if (pts.length === 0 && myPlayer && myPlayer.alive) {
        pts.push({ x: myPlayer.x, y: myPlayer.y });
    }
    return pts;
}

// The fully-focused view: the DESIRED (unclamped) centre + zoom that frames every
// live local player (local co-op widens the zoom as players spread, tightens as
// they cluster), growing toward the nearest goal as the group approaches it. A
// single player gets a tight WORLD_ZOOM_MAX framing exactly as before, since each
// player contributes a max-zoom half-box. Centre is kept separate from the zoom
// so a transition can ramp only the zoom (players can't slide out of frame).
function computeFocusedView() {
    var wholeMap = { cx: LOGICAL_WIDTH / 2, cy: LOGICAL_HEIGHT / 2, scale: 1 };
    var pts = focusWorldPoints();
    if (pts.length === 0) {
        // Nobody local alive to follow -> whole map (watch the action). Drop the
        // goal latch so it can't carry stale engagement into the next round/map.
        worldGoalEngaged = false;
        return wholeMap;
    }
    var halfX = LOGICAL_WIDTH / (2 * WORLD_ZOOM_MAX);
    var halfY = LOGICAL_HEIGHT / (2 * WORLD_ZOOM_MAX);
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
        minX = Math.min(minX, pts[i].x - halfX);
        maxX = Math.max(maxX, pts[i].x + halfX);
        minY = Math.min(minY, pts[i].y - halfY);
        maxY = Math.max(maxY, pts[i].y + halfY);
    }
    // Pull the nearest goal (to any framed player) into frame as the group gets
    // close to it -> the view zooms out to keep players and the goal visible.
    var goals = worldGoalPoints();
    var ng = null, nd = Infinity;
    for (var g = 0; g < goals.length; g++) {
        for (var p = 0; p < pts.length; p++) {
            var dx = goals[g].x - pts[p].x, dy = goals[g].y - pts[p].y;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < nd) { nd = d; ng = goals[g]; }
        }
    }
    // Hysteresis: engage the goal framing once within ENGAGE, but don't let go
    // until clearly past RELEASE. Otherwise a player drifting at the ENGAGE edge
    // (e.g. circling the spawn gate beside the goal) flips the framing every few
    // frames, which the gate-countdown ramp follows directly (a=1) and jerks.
    if (!ng) {
        worldGoalEngaged = false;
    } else if (worldGoalEngaged) {
        if (nd > WORLD_ZOOM_RELEASE) { worldGoalEngaged = false; }
    } else if (nd <= WORLD_ZOOM_ENGAGE) {
        worldGoalEngaged = true;
    }
    if (ng && worldGoalEngaged) {
        minX = Math.min(minX, ng.x - WORLD_ZOOM_PAD);
        maxX = Math.max(maxX, ng.x + WORLD_ZOOM_PAD);
        minY = Math.min(minY, ng.y - WORLD_ZOOM_PAD);
        maxY = Math.max(maxY, ng.y + WORLD_ZOOM_PAD);
    }
    var boxW = Math.max(1, maxX - minX), boxH = Math.max(1, maxY - minY);
    var scale = Math.min(LOGICAL_WIDTH / boxW, LOGICAL_HEIGHT / boxH);
    scale = Math.max(1, Math.min(WORLD_ZOOM_MAX, scale)); // never zoom out past the whole map
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    // Defensive: a NaN coordinate would poison setTransform and blank the canvas.
    if (!isFinite(cx) || !isFinite(cy) || !isFinite(scale)) {
        return wholeMap;
    }
    return { cx: cx, cy: cy, scale: scale };
}

function computeWorldViewTarget(dt) {
    // Whole-map (identity) baseline — exactly today's view.
    var wholeMap = { cx: LOGICAL_WIDTH / 2, cy: LOGICAL_HEIGHT / 2, scale: 1 };
    if (!cameraZoomEnabled || myPlayer == null || typeof world === "undefined" || world == null) {
        worldViewFocusedElapsed = 0;
        worldGoalEngaged = false;
        return wholeMap;
    }
    // Focus once the round is live (gate countdown + race); plus the LOBBY whenever
    // the dynamic camera is on (cameraZoomEnabled, checked above) — a follow camera
    // keeps the player readable while they walk to a station instead of a tiny dot on
    // the whole-map view. Applies on desktop too now (camera toggle on), matching the
    // race behaviour and touch: the lobby hub panel is drawn in HUD/screen space (so it
    // doesn't zoom and its hit-testing is unaffected) and mouse-walk is inverse-mapped
    // through the zoom in calcMousePos, so walking to stations still lines up.
    var inLobby = (currentState === config.stateMap.lobby);
    var focused = (currentState === config.stateMap.gated ||
        currentState === config.stateMap.racing ||
        currentState === config.stateMap.collapsing ||
        inLobby);
    if (!focused) {
        worldViewFocusedElapsed = 0;
        worldGoalEngaged = false;
        return wholeMap;
    }
    // Advance the focus-phase clock by the (already-clamped) frame dt rather than
    // wall-clock, so backgrounding the tab pauses the ramp (rAF stops) and the
    // catch-up frame on refocus can't snap the zoom to the end.
    worldViewFocusedElapsed += (dt || 16);
    var focusedView = computeFocusedView();

    // During the gate countdown, run a slow, eased zoom timed to the countdown:
    // whole-map at the start (take in the arena + goal), arriving at the focused
    // zoom right as the gate opens. Crucially we ONLY ramp the zoom and keep the
    // centre anchored on the player (clamped to the world) the whole time — at
    // scale 1 the clamp shows the whole map, and it homes in on the player as it
    // zooms, so the player can never slide out of frame mid-transition.
    if (currentState === config.stateMap.gated) {
        var dur = ((config.gatedWaitTime || 9) * 1000) - WORLD_ZOOM_HOLD_MS;
        var elapsed = worldViewFocusedElapsed - WORLD_ZOOM_HOLD_MS;
        var p = (dur > 0) ? Math.max(0, Math.min(1, elapsed / dur)) : 1;
        var e = p * p * (3 - 2 * p); // smoothstep: gentle in (see the map) and out (settle)
        var scale = 1 + (focusedView.scale - 1) * e;
        return clampViewToWorld(focusedView.cx, focusedView.cy, scale);
    }
    // Back the camera off while aiming/throwing an aimed ability (bomb/ice) so
    // it's easier to aim and follow the shot; the smoothing eases it out and back.
    var racingScale = focusedView.scale;
    if (localAimedAbilityActive()) {
        racingScale = Math.max(1, racingScale * AIM_ZOOM_OUT_FACTOR);
    }
    return clampViewToWorld(focusedView.cx, focusedView.cy, racingScale);
}

function updateWorldCamera(dt) {
    // Clamp the frame delta so a long stall / tab-refocus catch-up frame can't
    // snap the camera (drives both the gate ramp and the exponential smoothing).
    var cdt = Math.min(dt || 16, 100);
    var target = computeWorldViewTarget(cdt);
    if (worldView == null) {
        worldView = { cx: target.cx, cy: target.cy, scale: target.scale };
        return;
    }
    // During the gate countdown the target is already a precise, eased time-ramp,
    // so follow it directly (a=1) for the arc to finish exactly as the gate opens.
    // Everywhere else, smooth exponentially for natural player/goal tracking.
    var gatedNow = (cameraZoomEnabled && typeof config !== "undefined" && config && currentState === config.stateMap.gated);
    var a = gatedNow ? 1 : (1 - Math.exp(-cdt / WORLD_ZOOM_TAU));
    worldView.cx += (target.cx - worldView.cx) * a;
    worldView.cy += (target.cy - worldView.cy) * a;
    worldView.scale += (target.scale - worldView.scale) * a;
}

// True while a local player is dealing with an aimed ability — holding a bomb /
// ice cannon (lining up the throw), or with its projectile/explosion aimer still
// live after firing (until it detonates). Drives a sustained camera back-off so
// the wider view makes aiming and tracking the shot easier.
function localAimedAbilityActive() {
    if (typeof config === "undefined" || !config || !config.tileMap || !config.tileMap.abilities) {
        return false;
    }
    if (typeof localPlayers === "undefined" || !localPlayers) {
        return false;
    }
    var bombId = config.tileMap.abilities.bomb.id;
    var iceId = config.tileMap.abilities.iceCannon.id;
    for (var i = 0; i < localPlayers.length; i++) {
        var lp = localPlayers[i];
        if (!lp || lp.myID == null) {
            continue;
        }
        var id = lp.myID;
        var p = (typeof playerList !== "undefined" && playerList) ? playerList[id] : null;
        if (p && (p.ability === bombId || p.ability === iceId)) {
            return true; // holding / aiming
        }
        // fired and in flight: only the bomb/snowFlake projectile (NOT a hockey
        // puck or cloud, which are also owner/round-keyed in projectileList).
        var proj = (typeof projectileList !== "undefined" && projectileList) ? projectileList[id] : null;
        if (proj && (proj.type === "bomb" || proj.type === "snowFlake")) {
            return true;
        }
        // detonating: the bomb's explosion telegraph (NOT the swap aimer, which is
        // also keyed by owner and uses startSwapCountDown instead).
        var aim = (typeof aimerList !== "undefined" && aimerList) ? aimerList[id] : null;
        if (aim && aim.startExplosionCountDown) {
            return true;
        }
    }
    return false;
}

function applyWorldTransform() {
    if (!worldView || !LOGICAL_WIDTH) {
        applyCanvasTransform();
        return;
    }
    var s = worldView.scale;
    var ex = LOGICAL_WIDTH / 2 - worldView.cx * s;
    var ey = LOGICAL_HEIGHT / 2 - worldView.cy * s;
    if (gameContext) {
        gameContext.setTransform(s * canvasScaleX, 0, 0, s * canvasScaleY, ex * canvasScaleX, ey * canvasScaleY);
    }
    if (overlayContext) {
        overlayContext.setTransform(s * canvasScaleX, 0, 0, s * canvasScaleY, ex * canvasScaleX, ey * canvasScaleY);
    }
}

// True when the floating-arena sky backdrop should sit behind the play field.
// (Overview paints its own black board and gameOver its winner-colour fill, so
// they opt out; waiting is a transient pre-lobby blank.)
function arenaBackdropActive() {
    if (config == null) { return false; }
    return currentState == config.stateMap.lobby ||
        currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing;
}

function isDarkTheme() {
    return (typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-theme') === 'dark');
}

// Water floor: the play field's surface is open water so the terrain reads as
// islands floating on it (with shallows + reflections added under the terrain in
// drawMap). Drawn in world space (clipped to the world rect at x,y,w,h) so it
// pans/zooms with the arena. Animated with gentle drifting ripple lines + soft
// caustic light patches — calm, not busy.
function drawWaterFloor(x, y, w, h) {
    var dark = isDarkTheme();
    var now = Date.now();
    gameContext.save();
    gameContext.beginPath();
    gameContext.rect(x, y, w, h);
    gameContext.clip();

    // Base water gradient (deeper toward the bottom).
    var base = gameContext.createLinearGradient(0, y, 0, y + h);
    if (dark) {
        base.addColorStop(0, '#0a3a55');
        base.addColorStop(1, '#062537');
    } else {
        base.addColorStop(0, '#3bb0e0');
        base.addColorStop(1, '#1c7fb6');
    }
    gameContext.fillStyle = base;
    gameContext.fillRect(x, y, w, h);

    // Soft drifting caustic light patches.
    gameContext.globalCompositeOperation = 'lighter';
    var patch = dark ? 'rgba(90,180,230,' : 'rgba(255,255,255,';
    var t = now / 1000;
    var PATCHES = [
        [0.20, 0.30, 0.34, 0.07], [0.62, 0.18, 0.42, 0.06],
        [0.80, 0.62, 0.30, 0.07], [0.38, 0.74, 0.38, 0.05]
    ];
    for (var i = 0; i < PATCHES.length; i++) {
        var p = PATCHES[i];
        var px = x + (((p[0] + t * 0.012 * (i + 1)) % 1) * (w + 200)) - 100;
        var py = y + p[1] * h + Math.sin(t * 0.5 + i) * 10;
        var pr = Math.min(w, h) * p[2];
        var rg = gameContext.createRadialGradient(px, py, 0, px, py, pr);
        rg.addColorStop(0, patch + (p[3]) + ')');
        rg.addColorStop(1, patch + '0)');
        gameContext.fillStyle = rg;
        gameContext.fillRect(x, y, w, h);
    }

    // Gentle ripple lines drifting upward, with a slow sine wobble in opacity.
    gameContext.strokeStyle = dark ? 'rgba(150,210,245,0.10)' : 'rgba(255,255,255,0.16)';
    gameContext.lineWidth = 1.5;
    var rstep = 70;
    var drift = (now / 28) % rstep;
    for (var ry = y - rstep + (rstep - drift); ry <= y + h; ry += rstep) {
        var amp = 5, wl = 130;
        gameContext.beginPath();
        for (var rx = x; rx <= x + w; rx += 16) {
            var yy = ry + Math.sin((rx / wl) + now / 1300) * amp;
            if (rx === x) { gameContext.moveTo(rx, yy); } else { gameContext.lineTo(rx, yy); }
        }
        gameContext.stroke();
    }
    gameContext.globalCompositeOperation = 'source-over';

    // Light edge vignette for depth (subtle).
    var cx = x + w / 2, cy = y + h / 2;
    var vig = gameContext.createRadialGradient(cx, cy, Math.min(w, h) * 0.5, cx, cy, Math.max(w, h) * 0.72);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,20,35,0.30)');
    gameContext.fillStyle = vig;
    gameContext.fillRect(x, y, w, h);

    gameContext.restore();
}

// Deterministic starfield (positions as fractions of the field), built once via
// a tiny seeded PRNG so the stars stay put across cache rebuilds. The whole field
// (stars + objects) is baked into the arena composite, never drawn per-frame, so we
// can afford a dense field with glow + diffraction spikes on the headline stars.
var spaceStars = null;
// A handful of star tints — mostly white/blue with the odd warm or cyan giant.
var STAR_TINTS = ['#ffffff', '#ffffff', '#ffffff', '#cfe3ff', '#cfe3ff', '#bfe0ff', '#ffe6c4', '#d6fbff'];
function getSpaceStars() {
    if (spaceStars) { return spaceStars; }
    var arr = [], seed = 1337;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var i = 0; i < 360; i++) {
        var roll = rnd();
        var bright = roll > 0.95;            // ~5% headline stars: glow + diffraction spikes
        var mid = !bright && roll > 0.74;    // ~21% medium pinpoints
        arr.push({
            fx: rnd(), fy: rnd(),
            r: bright ? (1.6 + rnd() * 1.5)  // radius (world units)
               : mid   ? (0.85 + rnd() * 0.8)
               :         (0.35 + rnd() * 0.65),
            b: bright ? (0.85 + rnd() * 0.15) // base brightness
               : mid   ? (0.55 + rnd() * 0.35)
               :         (0.28 + rnd() * 0.4),
            tint: STAR_TINTS[(rnd() * STAR_TINTS.length) | 0],
            big: bright
        });
    }
    spaceStars = arr;
    return arr;
}

// Paint the static starfield void (base gradient + nebula washes + spiral galaxy
// + stars + foreground space objects + neon rim) into context `c` over a W×H area
// at the origin. Baked into the arena composite once per terrain change (see
// ensureArenaCache), never per-frame — so the layering can be lavish for free.
function paintStarfield(c, W, H) {
    var maxWH = Math.max(W, H), minWH = Math.min(W, H);

    // Deep-space base.
    var base = c.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#070611');
    base.addColorStop(0.55, '#0c0a1f');
    base.addColorStop(1, '#120a24');
    c.fillStyle = base;
    c.fillRect(0, 0, W, H);

    // Faint nebula washes (additive).
    c.globalCompositeOperation = 'lighter';
    var NEB = [
        [0.26, 0.30, 0.45, 'rgba(90,70,200,0.10)'],
        [0.72, 0.62, 0.50, 'rgba(40,120,200,0.09)'],
        [0.55, 0.18, 0.34, 'rgba(150,60,170,0.07)'],
        [0.12, 0.80, 0.40, 'rgba(60,160,180,0.07)'],
        [0.88, 0.86, 0.30, 'rgba(150,70,140,0.06)']
    ];
    for (var n = 0; n < NEB.length; n++) {
        var nb = NEB[n];
        var ncx = nb[0] * W, ncy = nb[1] * H, nr = maxWH * nb[2];
        var ng = c.createRadialGradient(ncx, ncy, 0, ncx, ncy, nr);
        ng.addColorStop(0, nb[3]);
        ng.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = ng;
        c.fillRect(0, 0, W, H);
    }

    // Distant spiral galaxy (faint, additive) — a stretched, rotated glow disc.
    var galX = W * 0.40, galY = H * 0.52, galR = minWH * 0.16;
    c.save();
    c.translate(galX, galY);
    c.rotate(-0.5);
    c.scale(1, 0.42);
    var gal = c.createRadialGradient(0, 0, 0, 0, 0, galR);
    gal.addColorStop(0, 'rgba(190,185,220,0.09)');
    gal.addColorStop(0.35, 'rgba(130,120,180,0.05)');
    gal.addColorStop(1, 'rgba(60,40,120,0)');
    c.fillStyle = gal;
    c.beginPath();
    c.arc(0, 0, galR, 0, 2 * Math.PI);
    c.fill();
    c.restore();
    c.globalCompositeOperation = 'source-over';

    // Stars (drawn under the foreground objects so planets occlude them).
    var stars = getSpaceStars();
    for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var sx = s.fx * W, sy = s.fy * H;
        if (s.big) {
            // Soft halo + four-point diffraction spikes for the headline stars.
            c.globalCompositeOperation = 'lighter';
            var halo = c.createRadialGradient(sx, sy, 0, sx, sy, s.r * 5);
            halo.addColorStop(0, 'rgba(200,220,255,0.5)');
            halo.addColorStop(1, 'rgba(200,220,255,0)');
            c.fillStyle = halo;
            c.fillRect(sx - s.r * 5, sy - s.r * 5, s.r * 10, s.r * 10);
            c.globalAlpha = 0.55;
            c.strokeStyle = s.tint;
            c.lineWidth = 0.7;
            var spike = s.r * 4.5;
            c.beginPath();
            c.moveTo(sx - spike, sy); c.lineTo(sx + spike, sy);
            c.moveTo(sx, sy - spike); c.lineTo(sx, sy + spike);
            c.stroke();
            c.globalCompositeOperation = 'source-over';
        }
        c.globalAlpha = s.b;
        c.fillStyle = s.tint;
        c.beginPath();
        c.arc(sx, sy, s.r, 0, 2 * Math.PI);
        c.fill();
    }
    c.globalAlpha = 1;

    // Foreground space objects (occlude the stars behind them).
    paintSpaceObjects(c, W, H, minWH);

    // Neon rim baked in.
    c.save();
    c.strokeStyle = 'rgba(170,195,255,0.7)';
    c.shadowColor = 'rgba(120,160,255,0.7)';
    c.shadowBlur = 10;
    c.lineWidth = 4;
    c.strokeRect(2, 2, W - 4, H - 4);
    c.restore();
}

// Deterministic foreground bodies for the space void: the main glowing planet and
// an asteroid cluster. All positions are fixed fractions of the field so the scene
// is stable across cache rebuilds, and the whole pass is baked once (see
// paintStarfield), so it costs nothing per-frame.
function paintSpaceObjects(c, W, H, minWH) {
    // --- Main planet (upper-right) + atmosphere glow. ---
    var px = W * 0.82, py = H * 0.20, pr = minWH * 0.10;
    c.globalCompositeOperation = 'lighter';
    var glow = c.createRadialGradient(px, py, pr * 0.8, px, py, pr * 1.7);
    glow.addColorStop(0, 'rgba(120,160,255,0.11)');
    glow.addColorStop(1, 'rgba(120,160,255,0)');
    c.fillStyle = glow;
    c.fillRect(px - pr * 1.7, py - pr * 1.7, pr * 3.4, pr * 3.4);
    c.globalCompositeOperation = 'source-over';
    var pg = c.createRadialGradient(px - pr * 0.4, py - pr * 0.4, pr * 0.1, px, py, pr);
    pg.addColorStop(0, '#3d4a78');
    pg.addColorStop(1, '#161a30');
    c.fillStyle = pg;
    c.beginPath();
    c.arc(px, py, pr, 0, 2 * Math.PI);
    c.fill();

    // --- Asteroid cluster (lower-mid-right) — small rim-lit rocks. ---
    var aSeed = 7919;
    function arnd() { aSeed = (aSeed * 1103515245 + 12345) & 0x7fffffff; return aSeed / 0x7fffffff; }
    var acx = W * 0.63, acy = H * 0.84, aSpread = minWH * 0.10;
    for (var a = 0; a < 9; a++) {
        var axx = acx + (arnd() - 0.5) * aSpread * 2;
        var ayy = acy + (arnd() - 0.5) * aSpread;
        var asz = minWH * (0.006 + arnd() * 0.012);
        c.save();
        c.translate(axx, ayy);
        c.rotate(arnd() * Math.PI * 2);
        c.beginPath();
        var verts = 6 + ((arnd() * 3) | 0);
        for (var v = 0; v < verts; v++) {
            var ang = (v / verts) * Math.PI * 2;
            var rad = asz * (0.7 + arnd() * 0.5);
            var vx = Math.cos(ang) * rad, vy = Math.sin(ang) * rad;
            if (v === 0) { c.moveTo(vx, vy); } else { c.lineTo(vx, vy); }
        }
        c.closePath();
        c.fillStyle = '#32323b';
        c.fill();
        c.strokeStyle = 'rgba(150,160,185,0.28)';   // rim light (upper-left bias)
        c.lineWidth = asz * 0.18;
        c.stroke();
        c.restore();
    }

    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
}

function drawBackground() {
    gameContext.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    overlayContext.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    // The sky vista is painted as the play-field floor in drawWorld (the world
    // rect fills the whole canvas, so there's no separate backdrop layer).
}
// Pick a text colour + contrasting outline that stays readable on an arbitrary
// background. The gameOver screen paints its backdrop in the winner's kart
// colour (anything from near-black navy to bright yellow), so the old hard-coded
// black text vanished on dark winners — this keys the ink off the backdrop's
// perceived luminance and always strokes the opposite tone behind it.
function gameOverInk(bgHex) {
    var r = 0, g = 0, b = 0;
    if (typeof bgHex === "string" && bgHex.charAt(0) === "#") {
        var h = bgHex.slice(1);
        if (h.length === 3) { h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2); }
        r = parseInt(h.substr(0, 2), 16) || 0;
        g = parseInt(h.substr(2, 2), 16) || 0;
        b = parseInt(h.substr(4, 2), 16) || 0;
    }
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55
        ? { fill: "#000000", stroke: "rgba(255,255,255,0.92)" }
        : { fill: "#ffffff", stroke: "rgba(0,0,0,0.92)" };
}
function drawGameOverScreen(dt) {
    // playerList[playerWon] can be gone if the winner was an AI racer that
    // removeBots() cleared at the gameOver->waiting transition — guard the deref.
    if (playerWon == null || playerList[playerWon] == null) {
        return;
    }
    gameContext.save();
    gameContext.fillStyle = playerList[playerWon].color;
    gameContext.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    gameContext.fill();
    gameContext.restore();

    // Readable ink for everything drawn over the winner-coloured backdrop.
    var ink = gameOverInk(playerList[playerWon].color);

    gameContext.save();
    gameContext.fillStyle = ink.fill;
    gameContext.strokeStyle = ink.stroke;
    gameContext.lineWidth = 4;
    gameContext.lineJoin = "round";
    gameContext.font = '48px serif';
    var winString = decodedColorName + " won the game.";
    // When a recap montage is showing, lift the header so the header + clip
    // block is vertically centred (recap.js owns the shared layout). No recap
    // (or recap.js absent) -> the usual vertical-centre baseline.
    var goHeaderY = (typeof recapHeaderBaseline === "function") ? recapHeaderBaseline() : (LOGICAL_HEIGHT + 48) / 2;
    gameContext.strokeText(winString, LOGICAL_WIDTH / 2 - 400, goHeaderY);
    gameContext.fillText(winString, LOGICAL_WIDTH / 2 - 400, goHeaderY);
    gameContext.restore();

    if (achievements != null) {
        var xOffset = 200;
        var yOffset = -200;
        var startingHeight = (LOGICAL_HEIGHT + 48) / 2;
        gameContext.save();
        gameContext.fillStyle = ink.fill;
        gameContext.strokeStyle = ink.stroke;
        gameContext.lineWidth = 3;
        gameContext.lineJoin = "round";
        gameContext.font = '28px serif';
        gameContext.strokeText("-- Medals -- ", (LOGICAL_WIDTH / 2) + xOffset, startingHeight + yOffset);
        gameContext.fillText("-- Medals -- ", (LOGICAL_WIDTH / 2) + xOffset, startingHeight + yOffset);


        var lineHeight = 40;
        var count = 1;
        for (var medal in achievements) {
            if (achievements[medal].ids.length == 0) {
                continue;
            }
            // Re-assert the ink each title: the medalist-dot loop below overwrites
            // strokeStyle (to the dot's colour), so without this the 2nd+ title would
            // be outlined in a leftover dot colour instead of the readable ink.
            gameContext.fillStyle = ink.fill;
            gameContext.strokeStyle = ink.stroke;
            gameContext.strokeText(achievements[medal].title, (LOGICAL_WIDTH / 2) + xOffset, startingHeight + (lineHeight * count) + yOffset);
            gameContext.fillText(achievements[medal].title, (LOGICAL_WIDTH / 2) + xOffset, startingHeight + (lineHeight * count) + yOffset);
            count++;
            for (var i = 0; i < achievements[medal].ids.length; i++) {
                var player = playerList[achievements[medal].ids[i]];

                gameContext.beginPath();
                gameContext.arc((LOGICAL_WIDTH / 2) + (xOffset + (35 * (i + 1))), startingHeight + (lineHeight * count) - 15 + yOffset, 15, 0, 2 * Math.PI);
                if (player != null) {
                    gameContext.fillStyle = player.color;
                    gameContext.strokeStyle = "black";
                } else {
                    gameContext.fillStyle = "grey";
                    gameContext.strokeStyle = "grey";
                }
                gameContext.lineWidth = 3;
                gameContext.fill();
                gameContext.stroke();
            }
            count++;
        }
        gameContext.restore();
    }

    // Recap montage overlay. Guarded so a replay-render error can never break
    // the (load-bearing) gameOver screen — worst case the medals show alone.
    try {
        recapDraw(dt || 0);
    } catch (e) {
        debugLog("recap draw error", e);
    }

}
function preShake() {
    if (currentState == config.stateMap.gameOver || currentState == config.stateMap.overview) {
        return;
    }
    if (shakeTrauma > 0) {
        gameContext.save();
        // Offset scales with trauma^2 so small hits barely nudge while big ones
        // really kick, and it's bidirectional (the old code only ever drifted
        // down-right). Runs under the world transform, so divide by the camera
        // zoom to keep a constant on-screen magnitude at any scale.
        var s = (worldView && worldView.scale) ? worldView.scale : 1;
        var mag = maxShakeOffset * shakeTrauma * shakeTrauma / s;
        var dx = (Math.random() * 2 - 1) * mag;
        var dy = (Math.random() * 2 - 1) * mag;
        gameContext.translate(dx, dy);
    }
}
function postShake() {
    if (currentState == config.stateMap.gameOver || currentState == config.stateMap.overview) {
        return;
    }
    if (shakeTrauma > 0) {
        gameContext.restore();
    }
}

// Walk the effects list and render each one with its own normalized progress
// (t in 0..1). drawEffects runs inside the world transform (camera zoom/pan +
// shake), which is correct for world-anchored effects — they follow the camera
// like the players and projectiles do. Screen-space effects (full-screen
// flashes) must ignore all of that and cover the viewport at any zoom/pan.
function drawEffects() {
    if (effectsList.length === 0) {
        return;
    }
    for (var i = 0; i < effectsList.length; i++) {
        var e = effectsList[i];
        var t = clamp01(e.age / e.maxAge);
        gameContext.save();
        // For screen-space effects, reset ONLY this context to the logical HUD
        // matrix. We can't call applyCanvasTransform() here: it also resets
        // overlayContext, which drawOverlay() (blackout) still needs in world
        // space later this same pass. The enclosing save/restore undoes this.
        if (e.screen) {
            gameContext.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
        }
        e.draw(gameContext, t, e);
        gameContext.restore();
    }
}

// Seeded by the server "punch" event (the punch object itself only lives
// ~100ms). A two-part radial burst: a quick impact pop + an expanding
// shockwave ring (nothing exceeds ~1.6x the real punch radius). The punch is
// omnidirectional, so the visual is too — no aimed sweep.
function spawnPunchEffect(punch) {
    if (punch == null) {
        return;
    }
    var owner = playerList[punch.ownerId];
    var infected = owner != null && owner.infected === true;
    var baseRadius = infected ? config.brutalRounds.infection.punchRadius : punch.radius;
    // Scale the impact FX by the punch's momentum bonus so a hard, committed punch
    // visibly reads bigger than a standing tap (matches the server knockback). Maps
    // the floor..ceil bonus range onto ~0.8x..1.45x of the base hit. Bumper/hazard
    // punches carry an unrelated bonus, so leave them at their base FX size.
    var mapOwned = owner == null;
    if (!mapOwned && punch.bonus != null && config.punchMomentum != null) {
        var pm = config.punchMomentum;
        var power = (pm.ceil > pm.floor) ? clamp01((punch.bonus - pm.floor) / (pm.ceil - pm.floor)) : 0;
        baseRadius *= 0.8 + 0.65 * power;
    }
    var color = infected ? "#7CFC00" : punch.color;
    var px = punch.x;
    var py = punch.y;
    addEffect({
        x: px,
        y: py,
        maxAge: 220,
        draw: function (ctx, t) {
            var grow = easeOutCubic(t);
            ctx.lineCap = "round";
            // Impact pop — a disc that scales up and fades fast (tops ~1.3x).
            ctx.globalAlpha = (1 - t) * 0.5;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(px, py, baseRadius * (0.55 + 0.75 * grow), 0, 2 * Math.PI);
            ctx.fill();
            // Expanding shockwave ring (tops ~1.6x).
            ctx.globalAlpha = (1 - t);
            ctx.lineWidth = 2 * (1 - t) + 1;
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.arc(px, py, baseRadius * (0.8 + 0.8 * grow), 0, 2 * Math.PI);
            ctx.stroke();
        }
    });
}

// Parry "clang" when two punches clash — a bright gold star-burst plus a double
// shockwave at the midpoint, so a successful counter reads distinctly from a
// normal landed hit (which is a single white ring via spawnHitEffect).
function spawnClashEffect(x, y) {
    addEffect({
        x: x,
        y: y,
        maxAge: 320,
        draw: function (ctx, t) {
            var p = easeOutCubic(t);
            ctx.save();
            ctx.translate(x, y);
            ctx.lineCap = "round";
            // Two expanding rings, offset in time, gold over white.
            ctx.globalAlpha = (1 - t) * 0.9;
            ctx.strokeStyle = "#ffd34d";
            ctx.lineWidth = 3 * (1 - t) + 1.5;
            ctx.beginPath();
            ctx.arc(0, 0, 4 + 26 * p, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.globalAlpha = (1 - t) * 0.7;
            ctx.strokeStyle = "white";
            ctx.lineWidth = 2 * (1 - t) + 1;
            ctx.beginPath();
            ctx.arc(0, 0, 2 + 16 * p, 0, 2 * Math.PI);
            ctx.stroke();
            // Four-point spark star that snaps out and fades.
            ctx.globalAlpha = (1 - t);
            ctx.strokeStyle = "#fff4c2";
            ctx.lineWidth = 2 * (1 - t) + 1;
            var reach = 8 + 20 * p;
            for (var i = 0; i < 4; i++) {
                var a = (Math.PI / 4) + i * (Math.PI / 2);
                ctx.beginPath();
                ctx.moveTo(Math.cos(a) * reach * 0.35, Math.sin(a) * reach * 0.35);
                ctx.lineTo(Math.cos(a) * reach, Math.sin(a) * reach);
                ctx.stroke();
            }
            ctx.restore();
        }
    });
}
// Burst at the point of contact when a punch connects — a white flash ring
// plus radiating sparks, so a landed hit has a visible payoff.
function spawnHitEffect(x, y, color) {
    addEffect({
        x: x,
        y: y,
        maxAge: 220,
        draw: function (ctx, t) {
            var p = easeOutCubic(t);
            ctx.save();
            ctx.translate(x, y);
            ctx.lineCap = "round";
            ctx.globalAlpha = (1 - t);
            ctx.strokeStyle = "white";
            ctx.lineWidth = 3 * (1 - t) + 1;
            ctx.beginPath();
            ctx.arc(0, 0, 6 + 22 * p, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.strokeStyle = color || "white";
            ctx.lineWidth = 2 * (1 - t) + 1;
            for (var i = 0; i < 6; i++) {
                var a = (i / 6) * Math.PI * 2 + 0.3;
                var r0 = 2.8 + 8.4 * p;
                var r1 = 8.4 + 18.2 * p;
                ctx.beginPath();
                ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
                ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
                ctx.stroke();
            }
            ctx.restore();
        }
    });
}

// Teleport flash for the swap ability — an expanding ring plus particles
// spiralling outward, so a swap reads as a "poof" instead of a silent blink.
function spawnTeleportPuff(x, y, color) {
    addEffect({
        x: x,
        y: y,
        maxAge: 360,
        draw: function (ctx, t) {
            var p = easeOutCubic(t);
            ctx.save();
            ctx.translate(x, y);
            ctx.globalAlpha = (1 - t) * 0.9;
            ctx.strokeStyle = color || "white";
            ctx.lineWidth = 3 * (1 - t) + 1;
            ctx.beginPath();
            ctx.arc(0, 0, 8 + 38 * p, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.fillStyle = color || "white";
            for (var i = 0; i < 8; i++) {
                var a = (i / 8) * Math.PI * 2 + t * 3;
                var r = 6 + 30 * p;
                ctx.globalAlpha = (1 - t);
                ctx.beginPath();
                ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.5 * (1 - t) + 0.5, 0, 2 * Math.PI);
                ctx.fill();
            }
            ctx.restore();
        }
    });
}

// Bright slash streak along the cut axis (both directions through the cutter),
// a white core inside a coloured glow that flashes and fades quickly.
function spawnSlashEffect(x, y, angleDeg, color) {
    var a = angleDeg * Math.PI / 180;
    var len = config.worldWidth;
    var dx = Math.cos(a) * len;
    var dy = Math.sin(a) * len;
    addEffect({
        x: x,
        y: y,
        maxAge: 280,
        draw: function (ctx, t) {
            ctx.save();
            ctx.lineCap = "round";
            ctx.globalAlpha = (1 - t) * 0.6;
            ctx.strokeStyle = color || "white";
            ctx.lineWidth = (10 * (1 - t)) + 2;
            ctx.shadowColor = color || "white";
            ctx.shadowBlur = (typeof perfGlow !== "function" || perfGlow()) ? (12 * (1 - t)) : 0;
            ctx.beginPath();
            ctx.moveTo(x - dx, y - dy);
            ctx.lineTo(x + dx, y + dy);
            ctx.stroke();
            ctx.globalAlpha = (1 - t);
            ctx.strokeStyle = "white";
            ctx.lineWidth = (4 * (1 - t)) + 1;
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.moveTo(x - dx, y - dy);
            ctx.lineTo(x + dx, y + dy);
            ctx.stroke();
            ctx.restore();
        }
    });
}

// A small fireball at a blast site — a hot radial flash, a white shock ring,
// and a scatter of debris sparks. Used by bombs (and reused, tinted, for ice).
function spawnExplosion(x, y, radius, color) {
    color = color || "#ff7a18";
    radius = radius || 70;
    addEffect({
        x: x,
        y: y,
        maxAge: 430,
        draw: function (ctx, t) {
            var p = easeOutCubic(t);
            ctx.save();
            ctx.translate(x, y);
            // Hot core: a radial gradient that blooms then fades.
            var coreR = radius * (0.4 + 0.9 * p);
            var grad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
            grad.addColorStop(0, "rgba(255,245,200," + (1 - t) + ")");
            grad.addColorStop(0.5, color);
            grad.addColorStop(1, "rgba(0,0,0,0)");
            ctx.globalAlpha = (1 - t) * 0.85;
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(0, 0, coreR, 0, 2 * Math.PI);
            ctx.fill();
            // Shock ring.
            ctx.globalAlpha = (1 - t);
            ctx.strokeStyle = "rgba(255,255,255,0.9)";
            ctx.lineWidth = 3 * (1 - t) + 1;
            ctx.beginPath();
            ctx.arc(0, 0, radius * (0.6 + 1.0 * p), 0, 2 * Math.PI);
            ctx.stroke();
            // Debris sparks — count scales with the performance profile.
            ctx.fillStyle = color;
            var sparks = (typeof perfExplosionSparks === "function") ? perfExplosionSparks() : 10;
            for (var i = 0; i < sparks; i++) {
                var a = (i / sparks) * Math.PI * 2 + 0.2;
                var r = radius * (0.3 + 1.1 * p);
                ctx.globalAlpha = (1 - t);
                ctx.beginPath();
                ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.5 * (1 - t) + 0.5, 0, 2 * Math.PI);
                ctx.fill();
            }
            ctx.restore();
        }
    });
}

// Brief full-screen colour wash (e.g. the red flash when a Brutal Round
// begins). Drawn in screen space, so it ignores world coordinates.
function spawnScreenFlash(color, peakAlpha, maxAge) {
    addEffect({
        screen: true,
        keep: true,   // gameplay telegraph (e.g. brutal-round start) — never evicted by the perf cap
        x: 0,
        y: 0,
        maxAge: maxAge || 250,
        draw: function (ctx, t) {
            ctx.save();
            ctx.globalAlpha = (1 - t) * (peakAlpha || 0.35);
            ctx.fillStyle = color || "red";
            // drawEffects resets screen effects to the logical HUD matrix, so
            // fill the logical viewport (a small margin guards against rounding).
            ctx.fillRect(-40, -40, LOGICAL_WIDTH + 80, LOGICAL_HEIGHT + 80);
            ctx.restore();
        }
    });
}

// Muzzle flash when a bomb/ice cannon is fired — a bright forward cone with a
// couple of streaks, at the player's front edge in the facing direction. The
// "recoil kick" is a small screen shake added for the local shooter.
function spawnMuzzleFlash(x, y, angleDeg, color) {
    var a = angleDeg * Math.PI / 180;
    addEffect({
        x: x,
        y: y,
        maxAge: 160,
        draw: function (ctx, t) {
            var p = easeOutCubic(t);
            var reach = 8 + 20 * p;
            var spread = 6 * (1 - t) + 3;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(a);
            // Flash cone.
            ctx.globalAlpha = (1 - t) * 0.9;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(reach, -spread);
            ctx.lineTo(reach + 6, 0);
            ctx.lineTo(reach, spread);
            ctx.closePath();
            ctx.fill();
            // Hot white streaks down the middle.
            ctx.globalAlpha = (1 - t);
            ctx.strokeStyle = "white";
            ctx.lineCap = "round";
            ctx.lineWidth = 2 * (1 - t) + 0.5;
            for (var i = -1; i <= 1; i++) {
                ctx.beginPath();
                ctx.moveTo(2, i * 3);
                ctx.lineTo(reach * 0.8, i * 4);
                ctx.stroke();
            }
            ctx.restore();
        }
    });
}

// Detonator feedback when the bomb-trigger ability is pressed — a quick ring +
// inner flash at the player (the blast itself fireballs at the bomb's location).
function spawnTriggerPulse(x, y, color) {
    addEffect({
        x: x,
        y: y,
        maxAge: 200,
        draw: function (ctx, t) {
            var p = easeOutCubic(t);
            ctx.save();
            ctx.globalAlpha = (1 - t);
            ctx.strokeStyle = color || "white";
            ctx.lineWidth = 3 * (1 - t) + 1;
            ctx.beginPath();
            ctx.arc(x, y, 6 + 18 * p, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.globalAlpha = (1 - t) * 0.5;
            ctx.fillStyle = color || "white";
            ctx.beginPath();
            ctx.arc(x, y, 5 * (1 - t), 0, 2 * Math.PI);
            ctx.fill();
            ctx.restore();
        }
    });
}

function drawAbilties() {

    if (Object.keys(aimerList).length > 0) {
        for (var id in aimerList) {
            drawAimer(aimerList[id]);
        }
    }

    if (blindfold.color != null) {
        gameContext.save();
        gameContext.globalAlpha = blindfoldAlpha();
        gameContext.beginPath();
        gameContext.fillStyle = blindfold.color;
        gameContext.rect(world.x, world.y, world.width, world.height);
        gameContext.fill();
        gameContext.restore();
    }
}

// Ease the blindfold in and out instead of snapping the solid fill on/off.
function blindfoldAlpha() {
    if (blindfold.start == null || !blindfold.duration) {
        return 1;
    }
    var e = Date.now() - blindfold.start;
    var fadeIn = 200;
    var fadeOut = 500;
    if (e < fadeIn) {
        return clamp01(e / fadeIn);
    }
    if (e > blindfold.duration - fadeOut) {
        return clamp01((blindfold.duration - e) / fadeOut);
    }
    return 1;
}

// The player objects for every LOCAL player (slot) that is currently alive. On a
// shared couch screen there can be several, so blackout cuts a vision hole around
// each (not just the primary). At N=1 this is just [myPlayer] when alive, so the
// behaviour is identical to before.
function livingLocalPlayers() {
    var out = [];
    if (typeof localPlayers === "undefined" || typeof playerList === "undefined" || !playerList) {
        return out;
    }
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (!lp || lp.myID == null) {
            continue;
        }
        var p = playerList[lp.myID];
        if (p != null && p.alive) {
            out.push(p);
        }
    }
    return out;
}

function drawOverlay() {
    if (brutalRound == true && blackout == true) {
        // Cut a vision hole around each living local player. If none are alive
        // (everyone local is dead/spectating) we draw no overlay, so spectators
        // see the whole map — same as the single-player behaviour when dead.
        var living = livingLocalPlayers();
        if (living.length === 0) {
            return;
        }
        overlayContext.save();
        overlayContext.fillStyle = "black";
        overlayContext.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
        overlayContext.restore();

        overlayContext.save();
        overlayContext.globalCompositeOperation = 'destination-out';
        var sprite = getBlackoutHoleSprite();
        var scale = blackoutHoleScale();
        var w = sprite.width * scale;
        var h = sprite.height * scale;
        for (var i = 0; i < living.length; i++) {
            var p = living[i];
            overlayContext.drawImage(sprite, p.x - w / 2, p.y - h / 2, w, h);
        }
        overlayContext.restore();
    }
}

// The blackout hole starts wide and irises in over ~700ms (the darkness
// "closes in"), then gently breathes so it feels alive rather than static.
function blackoutHoleScale() {
    var breathe = 0.06 * Math.sin(Date.now() / 600);
    var base = 1;
    if (blackoutStart != null) {
        var e = Date.now() - blackoutStart;
        var irisMs = 700;
        if (e < irisMs) {
            base = lerp(2.6, 1, easeOutCubic(e / irisMs));
        }
    }
    return base + breathe;
}

// How far through its warn-up a countdown aimer is, 0..1. Set when the
// countdown starts (swapUsed / spawnExplosionAimer handlers).
function aimerCountdownProgress(aimer) {
    if (aimer.countdownStart == null || !aimer.countdownDuration) {
        return 0;
    }
    return clamp01((Date.now() - aimer.countdownStart) / aimer.countdownDuration);
}

function drawAimer(aimer) {
    if (aimer.startSwapCountDown && aimer.hide == false) {
        // Continuous sine pulse that speeds up and reddens as the swap nears,
        // instead of the old once-a-second single-frame flash.
        var prog = aimerCountdownProgress(aimer);
        var phase = (Date.now() / 1000) * (2 + 5 * prog) * Math.PI * 2;
        var pulse = 0.5 + 0.5 * Math.sin(phase);
        gameContext.save();
        gameContext.beginPath();
        gameContext.arc(aimer.x, aimer.y, aimer.radius, 0, 2 * Math.PI);
        gameContext.setLineDash([15, 3, 3, 3]);
        gameContext.lineWidth = lerp(2, 10, pulse * (0.4 + 0.6 * prog));
        gameContext.strokeStyle = prog > 0.66 ? "red" : "black";
        gameContext.globalAlpha = 0.45 + 0.55 * pulse;
        gameContext.stroke();
        gameContext.restore();
    }
    if (aimer.startExplosionCountDown && aimer.hide == false) {
        var prog2 = aimerCountdownProgress(aimer);
        var phase2 = (Date.now() / 1000) * (2 + 5 * prog2) * Math.PI * 2;
        var pulse2 = 0.5 + 0.5 * Math.sin(phase2);
        gameContext.save();
        // Fill intensity swells with the pulse and the countdown so the blast
        // radius "charges up" before it goes off.
        gameContext.beginPath();
        gameContext.arc(aimer.x, aimer.y, aimer.radius, 0, 2 * Math.PI);
        gameContext.fillStyle = aimer.color;
        gameContext.globalAlpha = (0.12 + 0.5 * prog2) * pulse2;
        gameContext.fill();
        gameContext.globalAlpha = 1;
        gameContext.setLineDash([15, 3, 3, 3]);
        gameContext.lineWidth = lerp(2, 7, pulse2);
        gameContext.strokeStyle = aimer.color;
        gameContext.stroke();
        gameContext.restore();
    }
}

function drawMapTitle() {
    if (currentMap != null) {
        gameContext.save();
        gameContext.strokeStyle = themeColor('inkOutline', 'white');
        gameContext.lineWidth = 4;
        gameContext.fillStyle = themeColor('ink', 'black');
        gameContext.font = "14px Arial";
        gameContext.strokeText('"' + currentMap.name + '"', 5, LOGICAL_HEIGHT - 25);
        gameContext.strokeText('~' + currentMap.author, 5, LOGICAL_HEIGHT - 10);
        gameContext.fillText('"' + currentMap.name + '"', 5, LOGICAL_HEIGHT - 25);
        gameContext.fillText('~' + currentMap.author, 5, LOGICAL_HEIGHT - 10);
        gameContext.restore();
    }
}

// Accumulated time (seconds) driving cart-skin animation (fire-truck wheel spin,
// dino leg cycle). Advanced once per frame in drawPlayers, NOT per player.
var cartSkinAnimTime = 0;
// Set of player ids currently targeted by some aimer (telegraph). Rebuilt once
// per frame in drawPlayers so drawPlayer can do an O(1) lookup instead of an
// O(aimers) for-in + targetList.indexOf per kart per frame.
// Nearest-cell id for a player, cached on the player. The map is a Voronoi
// diagram so the cell a point sits in is the one whose site is nearest — an
// O(cells) scan. The on-fire-on-lava flash needs it every frame for every
// burning kart (worst case a whole pack in a volcano round), so cache it and
// only rescan when the kart has moved appreciably or the cache is stale (cells
// mutate to lava during collapse, so refresh on a short interval too).
function nearestCellIdCached(player) {
    if (currentMap == null || currentMap.cells == null) { return -1; }
    var now = Date.now();
    var hasCache = (player._nearCellId !== undefined);
    var dx = hasCache ? (player.x - player._nearCellX) : 1e9;
    var dy = hasCache ? (player.y - player._nearCellY) : 1e9;
    if (hasCache && dx * dx + dy * dy <= 64 && now - player._nearCellAt < 150) {
        return player._nearCellId;
    }
    var cells = currentMap.cells, nearestId = -1, nd = Infinity;
    for (var ci = 0; ci < cells.length; ci++) {
        var cdx = player.x - cells[ci].site.x;
        var cdy = player.y - cells[ci].site.y;
        var cd = cdx * cdx + cdy * cdy;
        if (cd < nd) { nd = cd; nearestId = cells[ci].id; }
    }
    player._nearCellId = nearestId;
    player._nearCellX = player.x;
    player._nearCellY = player.y;
    player._nearCellAt = now;
    return nearestId;
}
var targetedPlayerIds = {};
function rebuildTargetedPlayerIds() {
    targetedPlayerIds = {};
    for (var aid in aimerList) {
        var a = aimerList[aid];
        var tl = a != null ? a.targetList : null;
        if (tl == null) { continue; }
        for (var ti = 0; ti < tl.length; ti++) {
            targetedPlayerIds[tl[ti]] = true;
        }
    }
}
function drawPlayers(dt) {
    cartSkinAnimTime += (dt || 0) / 1000; // dt is milliseconds; this accumulator is seconds
    rebuildTargetedPlayerIds();
    // Draw remote players first, then ALL local players (the primary plus any
    // couch co-op slots) on top — so your own karts always read clearly over
    // other players' floating emojis and name labels.
    for (var id in playerList) {
        if (isLocalId(id)) {
            continue;
        }
        checkDrawPlayer(playerList[id], dt);
    }
    for (var lid in playerList) {
        if (!isLocalId(lid)) {
            continue;
        }
        checkDrawPlayer(playerList[lid], dt);
    }
}
function checkDrawPlayer(player, dt) {
    if (player == null) {
        return;
    }
    // Phantom-entry guard: inactive players are parked at (-100,-100) so
    // camera.inBounds skips them, but a stale entry sitting at the exact origin
    // (0,0) — or one with a missing/NaN coordinate — otherwise slips through as
    // an alive, in-bounds "ghost" circle with no collisions. A real kart never
    // rests at exactly (0,0) under the physics, so treat that as invalid.
    if (player.x == null || player.y == null ||
        isNaN(player.x) || isNaN(player.y) ||
        (player.x === 0 && player.y === 0)) {
        return;
    }
    if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
        drawTrail(player);
    }
    if (player.alive == false) {
        drawDeathMessage(player);
        return;
    }
    if (camera.inBounds(player)) {
        drawPlayer(player, dt);
    }
}
function drawPlayer(player, dt) {

    if (player.infected == true) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = 1;
        gameContext.arc(player.x, player.y, config.brutalRounds.infection.radius, 0, 2 * Math.PI);
        gameContext.fillStyle = patterns[config.brutalRounds.infection.id];
        gameContext.fill();
        gameContext.strokeStyle = "green";
        gameContext.stroke();
        gameContext.restore();
    }
    if (DEBUG_FORCE_FIRE && player.id == myID) {
        player.onFire = 500;
    }
    // Burn flame is drawn BEHIND the kart body/skin: the flame sprite (55px) is far
    // bigger than the kart (~15px), so on top it fully engulfs the kart and every cart
    // looks the same. Behind, the scorched skin stays visible/recognizable on top of
    // the flames — reading as "this skin is on fire" rather than a generic blaze.
    if (player.onFire > 0) {
        drawFire(player);
    }
    drawSpeedFx(player);
    // Draw a halo behind your own kart(s) — the primary plus every couch co-op
    // slot — so you can always find yourself in a crowded pack.
    if (isLocalId(player.id)) {
        drawLocalPlayerHighlight(player);
        drawStaminaMeter(player);
    }
    // Charge "fist": a telegraph on every winding-up kart (so you can see a haymaker
    // coming), plus a momentum self-preview on your own idle kart.
    drawPunchCharge(player);

    var playerStrokeColor = targetedPlayerIds[player.id] ? "red" : "black";
    var sprite = getPlayerSprite(player.color, player.radius, playerStrokeColor);
    // Lobby respawn invulnerability: pulse the sprite's alpha so the grace window is
    // legible. The sprite is a cached image with no alpha, so wrap the blit.
    var timedInvuln = (player.invulnUntil != null && Date.now() < player.invulnUntil);
    // Mirror the server's start-circle hold (server/game.js updateLobbyInvulnHold): a
    // player parked in the start circle stays invulnerable until they leave, so reflect
    // that in the flash. Same deterministic latch off the same inputs (position + timer).
    if (currentState == config.stateMap.lobby && lobbyStartButton != null) {
        var ix = player.x - lobbyStartButton.x;
        var iy = player.y - lobbyStartButton.y;
        var ireach = lobbyStartButton.radius + player.radius;
        if (ix * ix + iy * iy > ireach * ireach) {
            player.invulnHeldInCircle = false;
        } else if (timedInvuln) {
            player.invulnHeldInCircle = true;
        }
    } else {
        player.invulnHeldInCircle = false;
    }
    // An on-fire player is immune to lava — flash ONLY while they're actually standing
    // on lava (the moment damage is being negated), not just whenever they're on fire.
    // Voronoi: the cell a point sits in is the one whose site is nearest, so we only scan
    // cells when on fire (cheap/rare). The flash ramps with the fire timer below.
    var onFireOnLava = false;
    if (player.onFire != null && player.onFire > 0 && currentMap != null && currentMap.cells != null) {
        onFireOnLava = (nearestCellIdCached(player) == config.tileMap.lava.id);
    }
    // Flash while immune to fire/lava damage: lobby respawn-invuln (timed or held in the
    // start circle), or on-fire-on-lava. The pulse quickens over the final 2s of whichever
    // protection is about to expire — the timed respawn grace or the fire timer
    // (player.onFire is the live remaining ms). A circle-held player has no expiry, so it
    // stays a steady pulse.
    var immune = timedInvuln || player.invulnHeldInCircle || onFireOnLava;
    if (immune) {
        var remaining = Infinity;
        if (timedInvuln) { remaining = Math.min(remaining, player.invulnUntil - Date.now()); }
        if (onFireOnLava) { remaining = Math.min(remaining, player.onFire); }
        var pulsePeriod = 130;
        if (remaining < 2000) {
            pulsePeriod = 35 + (130 - 35) * (remaining / 2000);
        }
        gameContext.save();
        gameContext.globalAlpha = 0.35 + 0.45 * Math.abs(Math.sin(Date.now() / pulsePeriod));
    }
    // Fade other players' kart bodies during the race so yours pops. Never dims
    // a flashing (immune) kart — that flash carries its own alpha — and never
    // your own. Threat FX drawn elsewhere (fire/ability rings) stay full.
    var dimKart = !isLocalId(player.id) && !immune &&
        (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing);
    if (dimKart) {
        gameContext.save();
        gameContext.globalAlpha = NONLOCAL_KART_ALPHA;
    }
    // A cart skin fully replaces the kart body, so skip the base colour disc (and the
    // avatar overlay that rides it) — otherwise the round sprite pokes out around the
    // irregular skin silhouette and reads as an unwanted "background". The skin is
    // tinted with the player's colour, so their identity still carries.
    var hasCartSkin = cartSkinPainter(player.cartSkin) != null;
    // try/finally so a thrown drawImage (e.g. an undecoded sprite -> InvalidStateError)
    // can't skip the restore() and leak the dimmed/flash alpha onto the rest of the frame.
    try {
        if (!hasCartSkin) {
            gameContext.drawImage(
                sprite,
                player.x + camera.getCameraX() - sprite.halfSize,
                player.y + camera.getCameraY() - sprite.halfSize
            );
            // Opt-in avatar skin: the player's picture, shrunk inside a distinct border,
            // overlaid on the kart so it reads as an external (not earned) skin. Drawn
            // INSIDE the dim/immune alpha scope so it fades/flashes with the kart body
            // (non-local karts dim during a race; immune karts pulse) instead of popping.
            drawAvatarSkin(player, sprite);
        }
        // Cosmetic cart skin (procedural overlay). Uses the SAME screen anchor as the
        // sprite blit (player.x/y + camera offset), so the camera offset is applied once.
        var bodyPainter = cartSkinPainter(player.cartSkin);
        if (bodyPainter != null) {
            drawCartSkin(player, player.x + camera.getCameraX(), player.y + camera.getCameraY(), player.radius, bodyPainter);
        }
        // The base sprite (skipped for skinned karts) is where the "you're being
        // targeted" red rim lives, so re-draw that tell around the skin when this kart
        // is in an aimer's target list (swap/explosive).
        if (hasCartSkin && playerStrokeColor === "red") {
            gameContext.save();
            gameContext.beginPath();
            gameContext.lineWidth = 3;
            gameContext.strokeStyle = "red";
            gameContext.arc(player.x + camera.getCameraX(), player.y + camera.getCameraY(), player.radius + 1, 0, 2 * Math.PI);
            gameContext.stroke();
            gameContext.restore();
        }
    } finally {
        if (dimKart) {
            gameContext.restore();
        }
        if (immune) {
            gameContext.restore();
        }
    }

    if (player.ability != null) {
        drawAbilityIndicator(player.x, player.y, player);
    }
    drawEmoji(player);
    if (player.name != null) {
        drawBotName(player);
    }
    if (player.awake == false) {
        gameContext.save();
        gameContext.drawImage(commentIconSolid, player.x, player.y - 40, commentIconSolid.width * 0.07, commentIconSolid.height * 0.07);
        gameContext.font = '20px Times New Roman';
        gameContext.fillText("😴", player.x + 8, player.y - 17);
        gameContext.restore();
    }
}

// Pre-baked halo sprites keyed by colour+radius. shadowBlur is expensive per
// frame, so — like getPlayerSprite — we render the ring and its glow into an
// offscreen canvas exactly once per kart colour and reuse it every frame. The
// palette + radius are fixed, so this cache stays tiny.
var playerHighlightCache = {};
function getPlayerHighlightSprite(color, radius) {
    var key = color + '|' + radius;
    var cached = playerHighlightCache[key];
    if (cached != null) {
        return cached;
    }
    var ringRadius = radius + 5;   // mid-pulse offset from the kart centre
    var lineWidth = 3;
    var blur = 13;                 // baked glow (the old mid-pulse shadowBlur)
    var pad = blur + lineWidth + 2;
    var size = (ringRadius + pad) * 2;
    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    ctx.translate(size / 2, size / 2);
    ctx.beginPath();
    ctx.arc(0, 0, ringRadius, 0, 2 * Math.PI);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.stroke();
    canvas.halfSize = size / 2;
    playerHighlightCache[key] = canvas;
    return canvas;
}

// Highlight every kart the player controls so you can pick yourself out of the
// pack — works for the primary kart and each couch co-op slot. A glowing ring
// pulses just behind the sprite (drawn before the blit so it reads as an aura)
// and uses the same camera offset as the sprite blit so it stays attached when
// the dynamic camera is active. The ring takes the player's own kart colour so
// couch co-op players can tell their halos apart, and the glow spills past the
// kart so it reads against both the light and dark canvas surfaces. The breathe
// rides on a cheap alpha+scale blit of the pre-baked sprite — no per-frame
// shadowBlur in this hot path.
function drawLocalPlayerHighlight(player) {
    var ringColor = (player.color != null) ? player.color : "rgb(255, 215, 0)";
    var halo = getPlayerHighlightSprite(ringColor, player.radius);
    var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 350);
    var x = player.x + camera.getCameraX();
    var y = player.y + camera.getCameraY();
    var s = 0.97 + pulse * 0.06;   // subtle size breathe via the blit, not a re-stroke
    var w = halo.width * s;
    var h = halo.height * s;
    gameContext.save();
    gameContext.globalAlpha = 0.6 + 0.35 * pulse;
    gameContext.drawImage(halo, x - w / 2, y - h / 2, w, h);
    gameContext.restore();
}

// White -> orange -> red as punch charge rises, so the colour itself reads "how
// hard". frac 0..1.
// Cached by quantized level (11 buckets) so the per-frame telegraph never allocates a
// fresh "rgb(...)" string for every charging kart (hot path with 25 karts on screen).
var _punchChargeColorCache = [];
function punchChargeColor(frac) {
    var key = frac < 0 ? 0 : (frac > 1 ? 10 : Math.round(frac * 10));
    var cached = _punchChargeColorCache[key];
    if (cached) { return cached; }
    var f = key / 10, out;
    if (f < 0.5) {
        var t = f / 0.5;               // white -> orange
        out = "rgb(255," + Math.round(255 - 90 * t) + "," + Math.round(255 - 235 * t) + ")";
    } else {
        var t2 = (f - 0.5) / 0.5;      // orange -> red
        out = "rgb(255," + Math.round(165 - 110 * t2) + ",20)";
    }
    _punchChargeColorCache[key] = out;
    return out;
}

// A radial halo around a kart that's winding up a punch. Two roles:
//  - While CHARGING (player.charge > 0, sent for every player): a growing, brightening
//    ring so opponents can SEE a haymaker winding up and back off / counter it.
//  - On your OWN idle kart: a preview of how hard you'd hit right now from your raw
//    momentum (greys out when you're too tired to punch). Local-only, since other
//    players' momentum potential would just be noise.
// The punch is omnidirectional, so the telegraph is too — no aimed arc.
function drawPunchCharge(player) {
    var chargeLevel = player.charge || 0;
    var ocLevel = player.overcharge || 0;
    var isCharging = chargeLevel > 0.001;
    var isLocal = isLocalId(player.id);
    // Fast path: a non-charging REMOTE kart has nothing to show. In a 25-kart race this
    // bails almost everyone before any state check or canvas work. Only your own kart
    // (preview + charge shake) and karts actively winding up (telegraph) do work.
    if (!isCharging && !isLocal) { return; }
    if (config.punchMomentum == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing
        && currentState != config.stateMap.gated && currentState != config.stateMap.lobby) { return; }
    // Slight screenshake while YOU charge, escalating into the dark-red overcharge danger.
    // The moment you tip into exhaustion (overcharge present but no longer charging = the
    // locked penalty), cut the shake dead instead of decaying through the lesser shakes.
    if (isLocal) {
        var ocBuilding = isCharging && ocLevel > 0.001;
        var ocLocked = !isCharging && ocLevel > 0.001;
        if (ocBuilding) { chargeRumble(0.18 + 0.3 * ocLevel); }
        else if (isCharging) { chargeRumble(0.1 + 0.14 * chargeLevel); }
        if (ocLocked && !player._wasOcLocked) {
            shakeTrauma = 0;
            shakeSustainUntil = 0;
            shakeSustainFloor = 0;
        }
        player._wasOcLocked = ocLocked;
    }
    var level, exhausted = false;
    if (isCharging) {
        level = chargeLevel; // telegraph (all players)
    } else if (isLocal && player.ability == null) {
        // Raw speed magnitude — calcPunchBonus uses the same on the server.
        var speed = Math.sqrt((player.velX || 0) * (player.velX || 0) + (player.velY || 0) * (player.velY || 0));
        var refSpeed = config.playerMaxSpeed * config.punchMomentum.refFrac;
        level = refSpeed > 0 ? clamp01(speed / refSpeed) : 0;
        if (level < 0.08) { return; } // barely moving -> no preview worth a per-frame draw
        exhausted = player._tired === true;
    } else {
        return; // local kart that's exhausted-locked / holding an ability -> nothing
    }
    var x = player.x + camera.getCameraX();
    var y = player.y + camera.getCameraY();
    var grow = isCharging ? (0.45 + 0.55 * level) : (0.5 + 0.4 * level);
    var radius = player.radius + 3 + player.radius * 0.6 * grow;
    var color = exhausted ? "rgb(150,150,150)" : punchChargeColor(level);
    gameContext.save();
    gameContext.lineCap = "round";
    // The aura ring — the primary tell, drawn for everyone winding up.
    gameContext.globalAlpha = (isCharging ? 0.32 : 0.16) + 0.55 * level;
    gameContext.strokeStyle = color;
    gameContext.lineWidth = 1.5 + (isCharging ? 1.8 : 1.2) * level;
    gameContext.beginPath();
    gameContext.arc(x, y, radius, 0, 2 * Math.PI);
    gameContext.stroke();
    // An inner fill glow at peak charge — only on YOUR kart, so a crowd of charging bots
    // stays cheap. Reads as "fully wound up" without obscuring your own sprite.
    if (isLocal && !exhausted && level > 0.4) {
        gameContext.globalAlpha = 0.08 + 0.25 * (level - 0.4) / 0.6;
        gameContext.fillStyle = color;
        gameContext.beginPath();
        gameContext.arc(x, y, radius, 0, 2 * Math.PI);
        gameContext.fill();
    }
    gameContext.restore();
}

// Stamina meter: a curved bar hugging the bottom of your kart. Hidden when full
// (i.e. you've recovered), it appears the moment a punch drains it, shrinks as
// stamina drops, and shifts green -> yellow -> red so "getting tired" is legible.
function drawStaminaMeter(player) {
    if (config.punchStamina == null || player.stamina == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing
        && currentState != config.stateMap.gated && currentState != config.stateMap.lobby) { return; }
    var max = config.punchStamina.max;
    var oc = player.overcharge || 0;
    // Normal stamina meter is hidden when full; the overcharge danger meter always shows.
    if (oc <= 0.001 && player.stamina >= max) { return; }
    var x = player.x + camera.getCameraX();
    var y = player.y + camera.getCameraY();
    var r = player.radius + 6;
    var span = Math.PI * 0.95;             // ~170deg arc, centred at the bottom
    var startA = Math.PI / 2 - span / 2;
    var fillFrac, color;
    if (oc > 0.001) {
        // Overcharge / lock: a dark-red bar that fills as you over-hold and drains over
        // the forced-exhaustion penalty — distinct from the normal green->red meter.
        fillFrac = clamp01(oc);
        color = "#7a0b0b";
    } else {
        fillFrac = clamp01(player.stamina / max);
        color = fillFrac > 0.5 ? "#43d676" : (fillFrac > 0.25 ? "#f2c14e" : "#e2533b");
    }
    gameContext.save();
    gameContext.lineCap = "round";
    // Faint full-width track.
    gameContext.globalAlpha = 0.3;
    gameContext.strokeStyle = "rgba(0,0,0,0.7)";
    gameContext.lineWidth = 4.5;
    gameContext.beginPath();
    gameContext.arc(x, y, r, startA, startA + span);
    gameContext.stroke();
    // Filled portion.
    gameContext.globalAlpha = 0.95;
    gameContext.strokeStyle = color;
    gameContext.lineWidth = 3.5;
    gameContext.beginPath();
    gameContext.arc(x, y, r, startA, startA + span * fillFrac);
    gameContext.stroke();
    gameContext.restore();
}

// Sustained speed-ability feedback driven by timestamps set on the player when
// a buff/debuff lands. Buff = wind streaks trailing the direction of travel;
// debuff = a slow sluggish ripple. Both expire on their own with no server
// state, and the dust system reinforces the buff via the player's higher speed.
function drawSpeedFx(player) {
    var now = Date.now();
    if (player.speedBuffUntil != null && now < player.speedBuffUntil) {
        var speed = Math.sqrt(player.velX * player.velX + player.velY * player.velY);
        if (speed > 0.5) {
            var dirA = Math.atan2(player.velY, player.velX);
            gameContext.save();
            gameContext.translate(player.x, player.y);
            gameContext.rotate(dirA);
            gameContext.strokeStyle = "rgba(255,255,255,0.6)";
            gameContext.lineCap = "round";
            gameContext.lineWidth = 2;
            var phase = (now / 60) % 12;
            for (var i = 0; i < 3; i++) {
                var off = (i - 1) * player.radius * 0.7;
                var back = player.radius + 4 + ((phase + i * 4) % 12);
                gameContext.beginPath();
                gameContext.moveTo(-back, off);
                gameContext.lineTo(-back - 10, off);
                gameContext.stroke();
            }
            gameContext.restore();
        }
    }
    if (player.speedDebuffUntil != null && now < player.speedDebuffUntil) {
        // "Drag" read: four chevrons converging INWARD on the kart (the opposite of the
        // speed-buff streaks that fly outward) plus a heavy saturated ring hugging the
        // body — so a slowed kart is obvious even when it's barely moving.
        var cp = (now / 600) % 1;                     // 0..1 convergence cycle
        var dist = player.radius + 16 - cp * 13;      // chevrons march inward over the cycle
        var chevAlpha = Math.sin(cp * Math.PI) * 0.85; // fade in as they appear, out as they close
        var arms = player.radius * 0.45;
        gameContext.save();
        gameContext.translate(player.x, player.y);
        gameContext.strokeStyle = "rgba(120,80,200," + chevAlpha.toFixed(3) + ")";
        gameContext.lineWidth = 2.5;
        gameContext.lineCap = "round";
        gameContext.lineJoin = "round";
        for (var ci = 0; ci < 4; ci++) {
            gameContext.save();
            gameContext.rotate(ci * Math.PI / 2 + Math.PI / 4); // 4 diagonals
            // ">" with its point aimed back at the kart (-X), arms flaring outward.
            gameContext.beginPath();
            gameContext.moveTo(dist + arms, -arms);
            gameContext.lineTo(dist, 0);
            gameContext.lineTo(dist + arms, arms);
            gameContext.stroke();
            gameContext.restore();
        }
        // Heavy saturated ring hugging the kart.
        gameContext.globalAlpha = 0.5;
        gameContext.strokeStyle = "rgba(95,70,150,1)";
        gameContext.lineWidth = 3;
        gameContext.beginPath();
        gameContext.arc(0, 0, player.radius + 3, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.restore();
    }
}


function drawEmoji(player) {
    if (player.chatMessage != null) {
        gameContext.save();
        // Other players' bubble + emoji read fainter and fade out over the back
        // half of their lifetime so they don't clutter the view; your own stays
        // full-strength and crisp.
        if (!isLocalId(player.id)) {
            var alpha = NONLOCAL_EMOJI_ALPHA;
            if (player.chatMessageAt != null && player.chatMessageDuration) {
                var elapsed = Date.now() - player.chatMessageAt;
                var fadeStart = player.chatMessageDuration * 0.5;
                if (elapsed > fadeStart) {
                    alpha *= clamp01(1 - (elapsed - fadeStart) / (player.chatMessageDuration - fadeStart));
                }
            }
            gameContext.globalAlpha = alpha;
        }
        gameContext.drawImage(commentIconSolid, player.x, player.y - 40, commentIconSolid.width * 0.07, commentIconSolid.height * 0.07);
        gameContext.font = '20px Times New Roman';
        gameContext.fillStyle = "white";
        gameContext.fillText(player.chatMessage, player.x + 8, player.y - 18);
        gameContext.restore();
    }
}

// --- avatar skin (opt-in) ----------------------------------------------------
// A signed-in player who equips the avatar skin in the lobby hub shows their
// Discord/Google picture on their kart for everyone. The picture fills the kart
// circle (it reads as an external skin simply by being a photo rather than a
// solid colour). Images load async and are cached per URL; until one is ready
// (or if it fails CORS/404) the kart just shows its base colour.
var avatarImageCache = {};
function preloadAvatarImage(url) {
    if (!url) {
        return null;
    }
    if (avatarImageCache[url] !== undefined) {
        return avatarImageCache[url];
    }
    var entry = { img: new Image(), ready: false, failed: false };
    // No crossOrigin: the game canvas is never read back (no getImageData/toDataURL),
    // so a tainted canvas is harmless — and this avoids the avatar failing to load
    // if an avatar CDN omits CORS headers.
    entry.img.onload = function () { entry.ready = true; };
    entry.img.onerror = function () { entry.failed = true; };
    entry.img.src = url;
    avatarImageCache[url] = entry;
    return entry;
}
function drawAvatarSkin(player, sprite) {
    if (!player || !player.avatarUrl) {
        return;
    }
    var entry = preloadAvatarImage(player.avatarUrl);
    if (!entry || !entry.ready || entry.failed) {
        return; // fall back to the base kart until the image is ready
    }
    // Sized off player.radius (the actual kart circle), NOT sprite.halfSize (=
    // radius + 8px of shadow/stroke padding), so it never spills past the kart edge
    // and inflates the apparent size. Skip entirely for a non-positive radius (a
    // kart mid-collapse/shrink) so a falsy 0 can't fall back to a full-size overlay.
    var r = player.radius;
    if (!(r > 0)) {
        return;
    }
    var cx = player.x + camera.getCameraX();
    var cy = player.y + camera.getCameraY();
    // Fill the kart circle with the picture. No frame border — at the correct kart
    // size it left too little room to see the photo; a thin edge outline gives
    // definition over busy backgrounds.
    gameContext.save();                            // try/finally so a thrown drawImage
    try {                                          // can't leak the clip onto later draws
        gameContext.beginPath();                   // clip to the kart circle
        gameContext.arc(cx, cy, r, 0, 2 * Math.PI);
        gameContext.closePath();
        gameContext.clip();
        gameContext.drawImage(entry.img, cx - r, cy - r, r * 2, r * 2);
    } finally {
        gameContext.restore();
    }
    gameContext.save();                            // thin edge outline for definition
    gameContext.beginPath();
    gameContext.arc(cx, cy, r, 0, 2 * Math.PI);
    gameContext.lineWidth = 1.5;
    gameContext.strokeStyle = "rgba(0,0,0,0.45)";
    gameContext.save();                            // thin edge outline for definition
    gameContext.beginPath();
    gameContext.arc(cx, cy, r, 0, 2 * Math.PI);
    gameContext.lineWidth = 1.5;
    gameContext.strokeStyle = "rgba(0,0,0,0.45)";
    gameContext.stroke();
    gameContext.restore();
}

// AI racers carry a visible name below the kart so each personality is
// recognizable. Aligned with the sprite's camera convention (camera offset is 0
// in the default desktop view). Humans have no name.
function drawBotName(player) {
    // Match the kart sprite / avatar / emote convention (player position + camera
    // offset) so the label stays attached to the kart in dynamic-camera/zoom mode
    // too. (getCameraX/Y is 0 in the default desktop view; non-zero on touch zoom.)
    var x = player.x + camera.getCameraX();
    var y = player.y + camera.getCameraY() + player.radius + 12;
    gameContext.save();
    gameContext.textAlign = "center";
    // Kept translucent so the labels read without obscuring the action underneath.
    gameContext.globalAlpha = 0.5;
    gameContext.lineWidth = 2;
    gameContext.strokeStyle = themeColor('inkOutline', 'white');
    gameContext.fillStyle = themeColor('ink', 'black');
    gameContext.font = '11px Times New Roman';
    gameContext.strokeText(player.name, x, y);
    gameContext.fillText(player.name, x, y);
    gameContext.restore();
}

function drawDeathMessage(player) {
    if (player.deathMessage != null) {
        // Fade the skull out over time so dead karts don't clutter the board
        // (a ping re-reveals them). deathAt is stamped on race deaths only; lobby
        // respawns leave it null and clear the message quickly on their own.
        var alpha = 1;
        if (player.deathAt != null) {
            var elapsed = Date.now() - player.deathAt;
            if (elapsed > DEATH_SKULL_HOLD_MS) {
                alpha = clamp01(1 - (elapsed - DEATH_SKULL_HOLD_MS) / DEATH_SKULL_FADE_MS);
            }
        }
        if (alpha <= 0.02) {
            return;
        }
        gameContext.save();
        gameContext.globalAlpha = alpha;
        gameContext.drawImage(commentIconSolid, player.x, player.y - 40, commentIconSolid.width * 0.07, commentIconSolid.height * 0.07);
        gameContext.font = '20px Times New Roman';
        // theme-aware so the message stays readable where it overflows the
        // bubble onto the (now theme-coloured) board; outline gives a contrast
        // halo in both themes, matching drawMapTitle.
        gameContext.lineWidth = 3;
        gameContext.strokeStyle = themeColor('inkOutline', 'white');
        gameContext.fillStyle = themeColor('ink', 'black');
        gameContext.strokeText(player.deathMessage, player.x + 8, player.y - 17);
        gameContext.fillText(player.deathMessage, player.x + 8, player.y - 17);
        gameContext.restore();
    }
}
function drawFire(player) {
    gameContext.save();
    // Offset the flame to the player's trailing edge based on facing. Computed
    // continuously from the angle so it works for ANY heading — the old 8-way
    // switch left the flame unplaced (invisible) for the AI racers and for
    // mouse-aimed players, whose angles aren't multiples of 45.
    var ar = player.angle * (Math.PI / 180);
    gameContext.translate(player.x - 5 * Math.cos(ar), player.y - 5 * Math.sin(ar));

    gameContext.rotate((player.angle - 90) * (Math.PI / 180));
    gameContext.beginPath();
    drawFlameColor(player, 55);
    gameContext.restore();
}

function drawFlameColor(player, size) {
    if (player.onFire < 1000) {
        redFire.spriteSheet.update(dt);
        redFire.spriteSheet.draw(size, size);
        return;
    }
    if (player.onFire >= 1000 && player.onFire < 2000) {
        orangeFire.spriteSheet.update(dt);
        orangeFire.spriteSheet.draw(size, size)
        return;
    }
    if (player.onFire >= 2000 && player.onFire < 3000) {
        yellowFire.spriteSheet.update(dt);
        yellowFire.spriteSheet.draw(size, size);
        return;
    }
    if (player.onFire >= 3000 && player.onFire < 4000) {
        greenFire.spriteSheet.update(dt);
        greenFire.spriteSheet.draw(size, size);
        return;
    }
    if (player.onFire >= 4000 && player.onFire < 5000) {
        blueFire.spriteSheet.update(dt);
        blueFire.spriteSheet.draw(size, size);
        return;
    }
    if (player.onFire >= 5000) {
        purpleFire.spriteSheet.update(dt);
        purpleFire.spriteSheet.draw(size, size);
        return;
    }
}



function drawProjectiles(dt) {
    // ~5 degrees per 60fps frame, but scaled by dt so the spin speed is the
    // same on a 144Hz monitor as on a 60Hz one.
    var spin = 0.3 * (dt || 16.67);
    for (var proj in projectileList) {

        if (projectileList[proj].type == 'bomb') {
            projectileList[proj].rotation += spin;
            const centerX = bombImage.width * 2;
            const centerY = bombImage.height * 2;
            gameContext.save();
            gameContext.translate(projectileList[proj].x, projectileList[proj].y);
            gameContext.rotate(projectileList[proj].rotation * (Math.PI / 180));
            gameContext.scale(bombScale, bombScale);
            gameContext.drawImage(bombImage, -centerX, -centerY);
            gameContext.restore();
        }
        if (projectileList[proj].type == 'puck') {
            gameContext.save();
            gameContext.beginPath();
            gameContext.fillStyle = projectileList[proj].color;
            gameContext.arc(projectileList[proj].x, projectileList[proj].y, projectileList[proj].radius, 0, 2 * Math.PI);
            gameContext.fill();
            gameContext.restore();
        }
        if (projectileList[proj].type == 'snowFlake') {
            projectileList[proj].rotation += spin;
            const centerX = snowFlakeImage.width / 2;
            const centerY = snowFlakeImage.height / 2;
            gameContext.save();
            gameContext.translate(projectileList[proj].x, projectileList[proj].y);
            gameContext.rotate(projectileList[proj].rotation * (Math.PI / 180));
            gameContext.scale(snowFlakeImage.scale, snowFlakeImage.scale);
            gameContext.drawImage(snowFlakeImage, -centerX, -centerY);
            gameContext.restore();
        }
        if (projectileList[proj].type == 'cloud') {
            const centerX = cloudImage.width / 2;
            const centerY = cloudImage.height / 2;
            gameContext.save();
            gameContext.translate(projectileList[proj].x, projectileList[proj].y);
            gameContext.rotate(projectileList[proj].rotation * (Math.PI / 180));
            gameContext.scale(cloudImage.scale, cloudImage.scale);
            gameContext.drawImage(cloudImage, -centerX, -centerY);
            gameContext.restore();
        }
    }
}

function drawAbilityIndicator(x, y, player) {
    switch (player.ability) {
        case config.tileMap.abilities.bomb.id:
            drawProjectileAimer(x, y, player.angle, "#ff8c3a", config.tileMap.abilities.bomb.aimerLength);
            break;
        case config.tileMap.abilities.iceCannon.id:
            drawProjectileAimer(x, y, player.angle, "#5ad0ff", config.tileMap.abilities.iceCannon.aimerLength);
            break;
        case config.tileMap.abilities.cut.id:
            drawCutAimer(x, y, player.angle, player.color);
            break;
        case config.tileMap.abilities.swap.id:
        case config.tileMap.abilities.bombTrigger.id:
        default:
            drawArmedRing(x, y, player.color, player.radius);
            break;
    }
}

// Directional throw indicator for bomb/ice cannon: a tinted line whose dashes
// march outward toward the throw direction, capped with a pulsing arrowhead.
// (It shows direction, not the physics landing spot, so no target/blast ring.)
function drawProjectileAimer(x, y, angle, color, length) {
    var now = Date.now();
    var aimerLength = (length != null) ? length : config.tileMap.abilities.bomb.aimerLength;
    var tip = pos({ x: x, y: y }, aimerLength, angle);
    gameContext.save();
    gameContext.lineCap = "round";
    gameContext.strokeStyle = color;
    gameContext.lineWidth = 2;
    gameContext.setLineDash([6, 5]);
    gameContext.lineDashOffset = -(now / 25) % 11;
    gameContext.beginPath();
    gameContext.moveTo(x, y);
    gameContext.lineTo(tip.x, tip.y);
    gameContext.stroke();
    // Pulsing arrowhead at the tip.
    gameContext.setLineDash([]);
    gameContext.globalAlpha = 0.6 + 0.4 * Math.sin(now / 150);
    gameContext.lineWidth = 2.5;
    var leftP = pos(tip, 8, angle + 140);
    var rightP = pos(tip, 8, angle - 140);
    gameContext.beginPath();
    gameContext.moveTo(leftP.x, leftP.y);
    gameContext.lineTo(tip.x, tip.y);
    gameContext.lineTo(rightP.x, rightP.y);
    gameContext.stroke();
    gameContext.restore();
}

// Cut telegraph: a short laser through the holder — a fixed fraction of the
// screen rather than the whole map — whose brightness falls off logarithmically
// from the centre out to soft tips. SCREEN_FRAC is the total on-screen length as
// a fraction of screen width; K sets the fade curvature (higher = quicker drop
// near the holder); STOPS is the gradient sample count along the beam.
var CUT_TELEGRAPH_SCREEN_FRAC = 0.10;
var CUT_FADE_K = 12;
var CUT_FADE_STOPS = 8;

// Cut telegraph: a soft glowing beam through the player both ways, with a white
// core whose dashes flow along it and a gentle pulse, plus a bright origin dot.
// Both layers fade logarithmically out from the holder via a linear gradient.
function drawCutAimer(x, y, angle, color) {
    var now = Date.now();
    var pulse = 0.5 + 0.5 * Math.sin(now / 250);
    // World coords scale by worldView.scale onto the logical screen, so divide
    // the target screen length by the live zoom to keep the beam ~SCREEN_FRAC of
    // the screen width at any zoom; half the length reaches each way from the holder.
    var camScale = (typeof worldView !== "undefined" && worldView && worldView.scale) ? worldView.scale : 1;
    var reach = (CUT_TELEGRAPH_SCREEN_FRAC * LOGICAL_WIDTH) / (2 * camScale);
    var fwd = pos({ x: x, y: y }, reach, angle);
    var bwd = pos({ x: x, y: y }, reach, angle - 180);
    var rgb = cbHexToRgb(color);   // null for hsl() fallback colours (full rooms)
    // Gradient along the beam (bwd -> holder -> fwd). The holder sits at the
    // midpoint, so distance from them is |2t - 1|; alpha = baseAlpha * logFade.
    function fadedBeam(baseAlpha, r, g, b) {
        var grad = gameContext.createLinearGradient(bwd.x, bwd.y, fwd.x, fwd.y);
        for (var i = 0; i <= CUT_FADE_STOPS; i++) {
            var t = i / CUT_FADE_STOPS;
            var frac = Math.abs(2 * t - 1);
            var fade = 1 - Math.log(1 + CUT_FADE_K * frac) / Math.log(1 + CUT_FADE_K);
            grad.addColorStop(t, "rgba(" + r + "," + g + "," + b + "," + (baseAlpha * fade).toFixed(3) + ")");
        }
        return grad;
    }
    gameContext.save();
    gameContext.lineCap = "round";
    // Glow beam. Hex colours get the faded gradient (alpha baked into the stops,
    // so globalAlpha stays 1); hsl() fallback colours (cbHexToRgb -> null) can't
    // build rgba stops, so stroke the raw colour at the peak alpha instead of
    // silently defaulting the beam to white.
    if (rgb) {
        gameContext.globalAlpha = 1;
        gameContext.strokeStyle = fadedBeam(0.22 + 0.22 * pulse, rgb.r, rgb.g, rgb.b);
    } else {
        gameContext.globalAlpha = 0.22 + 0.22 * pulse;
        gameContext.strokeStyle = color;
    }
    gameContext.shadowColor = color;
    gameContext.shadowBlur = (typeof perfGlow !== "function" || perfGlow()) ? 12 : 0;
    gameContext.lineWidth = 4;
    gameContext.beginPath();
    gameContext.moveTo(bwd.x, bwd.y);
    gameContext.lineTo(fwd.x, fwd.y);
    gameContext.stroke();
    // Flowing white core, faded the same way (white is always gradient-safe).
    gameContext.shadowBlur = 0;
    gameContext.globalAlpha = 1;
    gameContext.strokeStyle = fadedBeam(0.7 + 0.3 * pulse, 255, 255, 255);
    gameContext.lineWidth = 1.5;
    gameContext.setLineDash([10, 8]);
    gameContext.lineDashOffset = -(now / 20) % 18;
    gameContext.beginPath();
    gameContext.moveTo(bwd.x, bwd.y);
    gameContext.lineTo(fwd.x, fwd.y);
    gameContext.stroke();
    // Bright origin dot.
    gameContext.setLineDash([]);
    gameContext.globalAlpha = 0.8;
    gameContext.fillStyle = color;
    gameContext.beginPath();
    gameContext.arc(x, y, 3 + pulse, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.restore();
}

// "Ability armed" indicator for swap / bomb-trigger / anything else held: a
// slowly rotating dashed ring that pulses, in the player's colour. Sized off the
// kart radius so it orbits OUTSIDE the local-player halo (which sits at
// radius+5 and glows past it) — otherwise the two same-coloured rings merged
// into one smear when you held an ability. A thin dark backing keeps the dashes
// legible where they cross the halo's glow.
function drawArmedRing(x, y, color, radius) {
    var now = Date.now();
    var r = (radius != null ? radius : 6) + 9;
    gameContext.save();
    gameContext.translate(x, y);
    gameContext.rotate((now / 600) % (2 * Math.PI));
    gameContext.setLineDash([6, 4]);
    gameContext.globalAlpha = 0.55 + 0.45 * Math.sin(now / 200);
    gameContext.lineWidth = 3.5;
    gameContext.strokeStyle = "rgba(0,0,0,0.45)";
    gameContext.beginPath();
    gameContext.arc(0, 0, r, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.lineWidth = 2;
    gameContext.strokeStyle = color || "black";
    gameContext.beginPath();
    gameContext.arc(0, 0, r, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.restore();
}

// Render the kart's trail with each segment's alpha scaled by the segment's
// AGE — newest segments are full opacity, the head of the buffer (vertices
// approaching TRAIL_FADE_MS) fades to 0 and is dropped on the next update.
// Segments are bucketed by age so each kart costs ~TRAIL_DRAW_BUCKETS stroke
// calls per frame regardless of vertex count. Within each bucket, CONTIGUOUS
// runs of segments are emitted as one moveTo + many lineTo so the canvas dash
// pattern doesn't restart per segment — and lineDashOffset is set to the
// cumulative path length at each run start so dashes line up across runs too
// (matters for the near-victory dashed style; the codex review caught that the
// per-segment subpaths were killing the dash cue at our 30Hz sample cadence).
var TRAIL_DRAW_BUCKETS = 6;
function drawTrail(player) {
    var trail = player.trail;
    if (trail == null || trail.vertices == null || trail.vertices.length < 2) {
        return;
    }
    var fadeMs = (typeof TRAIL_FADE_MS !== "undefined") ? TRAIL_FADE_MS : 5000;
    var now = Date.now();
    // Defensive expiry: trim head verts past their fade window even if update
    // hasn't run this frame (e.g. dead karts whose trail still draws briefly).
    var verts = trail.vertices;
    while (verts.length > 0 && now - verts[0].t > fadeMs) {
        verts.shift();
    }
    if (verts.length < 2) {
        return;
    }
    var dim = !isLocalId(player.id);
    var baseAlpha = dim ? NONLOCAL_TRAIL_ALPHA : 1;
    var dashed = !!trail.wasNearVictory;
    gameContext.save();
    gameContext.lineWidth = dashed ? 6 : 3;
    gameContext.lineCap = "round";
    gameContext.lineJoin = "round";
    // Trail always uses the player's own colour, even with a cart skin equipped — the
    // colour is the player's identity, so a blue dino trails blue (not skin-themed).
    gameContext.strokeStyle = player.color;
    if (typeof perfGlow === "function" && perfGlow()) {
        gameContext.shadowBlur = 3;
        gameContext.shadowColor = "black";
    }
    if (dashed) {
        // Clean chunky dash (the old dotty tail read as noise once semi-transparent).
        gameContext.setLineDash([18, 10]);
    }
    // Cumulative segment lengths up to vertex i (cumLen[0] = 0). Needed only for
    // the dashed style — the offset is what makes the dash pattern continuous
    // across the run boundaries when a stroke starts mid-trail.
    var cumLen = null;
    if (dashed) {
        cumLen = new Array(verts.length);
        cumLen[0] = 0;
        for (var k = 1; k < verts.length; k++) {
            var dx = verts[k].x - verts[k - 1].x;
            var dy = verts[k].y - verts[k - 1].y;
            cumLen[k] = cumLen[k - 1] + Math.sqrt(dx * dx + dy * dy);
        }
    }
    var bucketMs = fadeMs / TRAIL_DRAW_BUCKETS;
    // Bucket-index for the segment ENDING at vertex i (the segment verts[i-1] →
    // verts[i] is in this bucket). >= TRAIL_DRAW_BUCKETS marks "expired".
    var segBucket = new Array(verts.length);
    segBucket[0] = -1;
    for (var ii = 1; ii < verts.length; ii++) {
        var age = now - verts[ii].t;
        segBucket[ii] = (age >= fadeMs) ? TRAIL_DRAW_BUCKETS : Math.floor(age / bucketMs);
    }
    for (var b = 0; b < TRAIL_DRAW_BUCKETS; b++) {
        var bucketAlpha = baseAlpha * (1 - (b + 0.5) / TRAIL_DRAW_BUCKETS);
        if (dashed) {
            // Keep the near-victory trail bold along its whole length — don't let the
            // age-fade dim it into near-invisibility; it's the "about to win" cue.
            bucketAlpha = Math.max(bucketAlpha, baseAlpha * 0.55);
        }
        if (bucketAlpha <= 0.01) {
            continue;
        }
        gameContext.globalAlpha = bucketAlpha;
        var runStart = -1;
        for (var i = 1; i <= verts.length; i++) {
            var inBucket = (i < verts.length) && (segBucket[i] === b);
            if (inBucket) {
                if (runStart === -1) {
                    runStart = i - 1;
                    if (dashed) {
                        gameContext.lineDashOffset = cumLen[runStart];
                    }
                    gameContext.beginPath();
                    gameContext.moveTo(verts[runStart].x, verts[runStart].y);
                }
                gameContext.lineTo(verts[i].x, verts[i].y);
            } else if (runStart !== -1) {
                gameContext.stroke();
                runStart = -1;
            }
        }
    }
    if (dashed) {
        // Animated shimmer: a single bright gold segment that sweeps along the whole
        // victory trail (~1/s), so the "about to win" dash visibly pulses with motion
        // instead of sitting static. One extra stroke — near-victory is rare.
        var totalLen = cumLen[verts.length - 1];
        var sweep = (now / 1000) % 1;
        gameContext.globalAlpha = baseAlpha * 0.9;
        gameContext.strokeStyle = "rgba(255,240,170,1)";
        gameContext.lineWidth = 3;
        gameContext.setLineDash([16, totalLen + 40]); // one lit segment, rest is gap
        gameContext.lineDashOffset = -sweep * (totalLen + 56);
        gameContext.beginPath();
        gameContext.moveTo(verts[0].x, verts[0].y);
        for (var sv = 1; sv < verts.length; sv++) {
            gameContext.lineTo(verts[sv].x, verts[sv].y);
        }
        gameContext.stroke();
    }
    gameContext.restore();
}

// --- Death ping ---
// Floating death skulls (drawDeathMessage) fade out a few seconds after a death
// so the board declutters. While you're dead, pressing attack pulses a sonar
// marker over EVERY dead player's spot (yours plus all others) so you can see
// the whole carnage at a glance. Local-only/visual — never sent to the server.
// Works for every local slot (couch co-op).
var DEATH_PING_COOLDOWN_MS = 900;
// Death-skull fade: fully visible for HOLD ms after death, then fades to gone
// over FADE ms (re-revealed by a ping's sonar pulse).
var DEATH_SKULL_HOLD_MS = 1500;
var DEATH_SKULL_FADE_MS = 4000;

function spawnDeathPingEffect(x, y, color) {
    var ringColor = color || "rgb(255, 215, 0)";
    addEffect({
        keep: true,   // deliberate death-spot reveal — never evicted by the perf cap
        x: x,
        y: y,
        maxAge: 1100,
        draw: function (ctx, t) {
            // World-space: add the camera offset so the ping stays pinned to the
            // death spot under the dynamic camera (same convention as the kart).
            var cx = x + camera.getCameraX();
            var cy = y + camera.getCameraY();
            ctx.save();
            ctx.lineCap = "round";
            // Three staggered sonar rings expanding outward.
            for (var k = 0; k < 3; k++) {
                var rt = t - k * 0.18;
                if (rt <= 0 || rt >= 1) {
                    continue;
                }
                var grow = easeOutCubic(rt);
                ctx.globalAlpha = (1 - rt) * 0.9;
                ctx.lineWidth = 3 * (1 - rt) + 1;
                ctx.strokeStyle = ringColor;
                ctx.beginPath();
                ctx.arc(cx, cy, 8 + grow * 70, 0, 2 * Math.PI);
                ctx.stroke();
            }
            // A skull marker holding at the spot, fading over the ping's life.
            ctx.globalAlpha = 0.85 * (1 - t);
            ctx.font = "22px Times New Roman";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("💀", cx, cy);
            ctx.restore();
        }
    });
}

// Pulse a sonar marker over every dead player's death spot (yours included),
// each in that player's colour — pressing punch while dead reveals the whole
// board's carnage at once. Cooldown-gated per local slot to prevent spam.
function pingAllDeathSpots(lp) {
    var now = Date.now();
    if (lp._lastDeathPingAt != null && now - lp._lastDeathPingAt < DEATH_PING_COOLDOWN_MS) {
        return;
    }
    lp._lastDeathPingAt = now;
    for (var id in playerList) {
        var p = playerList[id];
        if (p != null && p.alive === false && p.deathX != null) {
            spawnDeathPingEffect(p.deathX, p.deathY, p.color);
        }
    }
}

// Per-frame: detect a fresh attack press on each local slot whose player is
// dead, and fire that slot's death ping. The primary slot reads the shared
// movement globals (keyboard/mouse/primary pad); couch pad slots read their own
// per-slot input. Edge-triggered so holding the button doesn't spam pings.
function updateDeathPings() {
    if (typeof localPlayers === "undefined" || !localPlayers ||
        typeof playerList === "undefined" || !playerList) {
        return;
    }
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (!lp || lp.myID == null) {
            continue;
        }
        var atk = (s === primarySlot)
            ? (typeof attack !== "undefined" && !!attack)
            : !!(lp.input && lp.input.attack);
        var prev = !!lp._deadAttackPrev;
        lp._deadAttackPrev = atk;
        if (atk && !prev) {
            // Only a player who actually died this round (deathX set) can ping;
            // the ping then reveals ALL dead players' spots.
            var p = playerList[lp.myID];
            if (p != null && p.alive === false && p.deathX != null) {
                pingAllDeathSpots(lp);
            }
        }
    }
}

function drawWorld() {
    if (world != null) {
        var ox = world.x + camera.getCameraX();
        var oy = world.y + camera.getCameraY();
        var themed = arenaBackdropActive();
        var space = themed && ARENA_FLOOR_THEME === 'space';
        if (space) {
            // Space draws nothing here: its floor + islands + depth + rim are one
            // composite blitted in drawMap (one pass, ≤ base's fillRect + terrain
            // blit). Drawn after the gate via the reordered draw sequence.
            return;
        }
        if (themed) {
            // Open water as the floor: terrain reads as islands; blank gaps
            // (background cells) show the sea, with shallows + reflections under
            // the terrain (added in drawMap).
            drawWaterFloor(ox, oy, world.width, world.height);
        } else {
            gameContext.save();
            gameContext.beginPath();
            gameContext.fillStyle = themeColor('surface', '#F0F0F0');
            gameContext.rect(ox, oy, world.width, world.height);
            gameContext.fill();
            gameContext.restore();
        }

        // Rim (water/non-themed draw it live here; space bakes it into the composite).
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = 4;
        if (themed) {
            gameContext.strokeStyle = 'rgba(235,250,255,0.7)';
            gameContext.shadowColor = 'rgba(180,230,255,0.7)';
            gameContext.shadowBlur = 8;
        } else {
            gameContext.strokeStyle = themeColor('ink', 'black');
        }
        gameContext.rect(ox, oy, world.width, world.height);
        gameContext.stroke();
        gameContext.restore();
    }
}

// Lobby "start game" portal: concentric rings of rotating arc segments around a
// glowing core. Idle it turns slowly; as players gather to launch it revs up
// (velocity ramps toward maxVelocity), the rings counter-rotate faster, the arcs
// lengthen, and the core brightens/pulses — a vortex tightening before launch.
function drawLobbyStartButton() {
    if (lobbyStartButton == null || !camera.inBounds(lobbyStartButton)) {
        return;
    }
    // Velocity ramp (unchanged behaviour): spin up while starting, ease down otherwise.
    if (lobbyStartButton.startSpin == true) {
        if (lobbyStartButton.velocity < lobbyStartButton.maxVelocity) {
            lobbyStartButton.velocity += 0.1;
        }
    } else {
        if (lobbyStartButton.velocity != 0) {
            lobbyStartButton.velocity -= 0.25;
        }
        if (lobbyStartButton.velocity < 0) {
            lobbyStartButton.velocity = 0;
        }
    }
    lobbyStartButton.angle += lobbyStartButton.velocity;

    var now = Date.now();
    var R = lobbyStartButton.radius;
    // Keep rotation bounded (arcs are periodic, so mod 360 is identical) — a huge
    // start angle makes canvas arc() degenerate and the rings disappear.
    var spin = (lobbyStartButton.angle % 360) * (Math.PI / 180);
    var maxV = lobbyStartButton.maxVelocity || 60;
    var rev = Math.max(0, Math.min(1, lobbyStartButton.velocity / maxV)); // 0..1 intensity
    var idle = (now / 1600) % (Math.PI * 2); // gentle constant turn (bounded)
    var accent = lobbyStartButton.color || 'rgba(95,220,255,1)';

    gameContext.save();
    gameContext.translate(lobbyStartButton.x + camera.getCameraX(), lobbyStartButton.y + camera.getCameraY());

    // Outer glow ring (steady frame so it reads as a button at rest).
    gameContext.shadowColor = accent;
    gameContext.shadowBlur = 12 + 22 * rev;
    gameContext.strokeStyle = accent;
    gameContext.lineWidth = 3;
    gameContext.globalAlpha = 0.85;
    gameContext.beginPath();
    gameContext.arc(0, 0, R, 0, 2 * Math.PI);
    gameContext.stroke();

    // Concentric rings of arc segments, alternating rotation direction + colour.
    var rings = 4;
    for (var i = 0; i < rings; i++) {
        var rr = R * (0.32 + 0.17 * i);
        var dir = (i % 2 === 0) ? 1 : -1;
        var rot = (spin * (1 + 0.35 * i) + idle * (1 + 0.2 * i)) * dir;
        var segs = 3 + i;                       // more segments on outer rings
        var gap = (Math.PI * 2) / segs;
        var arcLen = gap * (0.32 + 0.34 * rev); // arcs lengthen as it revs up
        gameContext.strokeStyle = (i % 2 === 0) ? accent : 'rgba(220,250,255,1)';
        gameContext.shadowColor = gameContext.strokeStyle;
        gameContext.shadowBlur = 6 + 10 * rev;
        gameContext.lineWidth = 3.5;
        gameContext.globalAlpha = 0.55 + 0.35 * rev;
        for (var s = 0; s < segs; s++) {
            var a0 = rot + s * gap;
            gameContext.beginPath();
            gameContext.arc(0, 0, rr, a0, a0 + arcLen);
            gameContext.stroke();
        }
    }

    // Glowing core that pulses faster + bigger as it revs.
    var pulse = 0.5 + 0.5 * Math.sin(now / (340 - 180 * rev));
    var coreR = R * (0.12 + 0.06 * pulse * (0.4 + rev));
    gameContext.globalAlpha = 1;
    gameContext.shadowColor = 'rgba(230,252,255,1)';
    gameContext.shadowBlur = 12 + 18 * rev;
    var core = gameContext.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, accent);
    gameContext.fillStyle = core;
    gameContext.beginPath();
    gameContext.arc(0, 0, coreR, 0, 2 * Math.PI);
    gameContext.fill();

    gameContext.restore();
}
function drawGate() {
    if (gates == null || gates.length == 0) {
        return;
    }
    var collapsing = currentState == config.stateMap.collapsing;
    // Collapse keeps the lava fill; brutal rounds keep their mode pattern. Normal
    // rounds get the translucent energy containment field instead of a solid slab.
    if (collapsing || brutalRound) {
        var baseFill = collapsing
            ? patterns[config.tileMap.lava.id]
            : brutalPatterns[brutalRoundConfig.brutalTypes.toString()];
        gameContext.save();
        gameContext.fillStyle = baseFill;
        for (var i = 0; i < gates.length; i++) {
            var g = gates[i];
            gameContext.beginPath();
            gameContext.rect(g.x, g.y, g.width, g.height);
            gameContext.fill();
        }
        gameContext.restore();
        return;
    }
    drawGateField();
}

// Energy containment field: a translucent blue/cyan barrier (the starfield shows
// faintly through it) that brightens toward the inner launch edge and breathes
// with a slow pulse, ringed by a soft glowing outline. Ties into the portal
// spinner's glow; calm (no sweeping bands) so the red→green start line stays the
// focal point.
function drawGateField() {
    var now = Date.now();
    var gatedState = currentState == config.stateMap.gated;
    var pulse = 0.5 + 0.5 * Math.sin(now / 600); // slow, gentle
    var a = (gatedState ? 0.5 : 0.32) + 0.12 * pulse;
    gameContext.save();
    for (var i = 0; i < gates.length; i++) {
        var g = gates[i];
        gameContext.fillStyle = gateFieldGradient(g, a);
        gameContext.fillRect(g.x, g.y, g.width, g.height);
        // Bright containment edge. (No shadowBlur — it's drawn every frame in the
        // gated scene and software-raster blur is the costly bit; the translucent
        // gradient fill already reads as a glow.)
        gameContext.strokeStyle = 'rgba(180,235,255,' + (0.7 + 0.25 * pulse) + ')';
        gameContext.lineWidth = 2;
        gameContext.strokeRect(g.x + 1, g.y + 1, g.width - 2, g.height - 2);
    }
    gameContext.restore();
}

// Translucent field tint across the strip's thin axis, brightest at the inner
// (launch) edge so the barrier glows where players are pressed against it.
function gateFieldGradient(g, a) {
    var grad;
    if (g.edge == "right") {
        grad = gameContext.createLinearGradient(g.x + g.width, 0, g.x, 0);
    } else if (g.edge == "top") {
        grad = gameContext.createLinearGradient(0, g.y, 0, g.y + g.height);
    } else if (g.edge == "bottom") {
        grad = gameContext.createLinearGradient(0, g.y + g.height, 0, g.y);
    } else { // left (default): inner edge is the right side of the strip
        grad = gameContext.createLinearGradient(g.x, 0, g.x + g.width, 0);
    }
    grad.addColorStop(0, 'rgba(40,90,200,' + (a * 0.35) + ')');
    grad.addColorStop(0.5, 'rgba(80,170,255,' + (a * 0.7) + ')');
    grad.addColorStop(1, 'rgba(150,225,255,' + a + ')');
    return grad;
}

// Release line on the gate's inner (launch) edge. During the gated countdown it
// glows red and pulses faster/brighter as the start nears; on release it flashes
// green for ~0.6s while it fades (drawn briefly into the racing state).
function drawGateLine() {
    if (gates == null || gates.length == 0) {
        return;
    }
    var now = Date.now();
    var gatedState = currentState == config.stateMap.gated;
    var prog = 0;        // countdown progress 0..1
    var flash = 0;       // green release-flash strength 1..0
    if (gatedState) {
        if (gatedStartTime != null && config.gatedWaitTime) {
            prog = clamp01((now - gatedStartTime) / (config.gatedWaitTime * 1000));
        }
    } else {
        if (raceStartTime == null) { return; }
        flash = 1 - clamp01((now - raceStartTime) / 600);
        if (flash <= 0) { return; }
    }
    // Pulse accelerates as the countdown closes in (period 200ms -> 80ms).
    var pulse = 0.5 + 0.5 * Math.sin(now / Math.max(80, 200 - 120 * prog));
    // Keep the blur modest — it's drawn every frame in the (perf-gated) gated
    // scene and software-raster shadowBlur cost scales with the blur radius.
    var color, glow, width;
    if (gatedState) {
        glow = 4 + 9 * prog + 4 * pulse * prog;
        width = 5 + 3 * prog;
        var grn = Math.round(35 + 110 * prog); // red -> orange near the end
        color = 'rgba(255,' + grn + ',40,' + (0.7 + 0.3 * pulse) + ')';
    } else {
        glow = 14 * flash;
        width = 6;
        color = 'rgba(60,255,95,' + flash + ')';
    }
    gameContext.save();
    gameContext.lineCap = "round";
    gameContext.lineWidth = width;
    gameContext.strokeStyle = color;
    gameContext.shadowColor = color;
    gameContext.shadowBlur = glow;
    for (var i = 0; i < gates.length; i++) {
        var g = gates[i];
        gameContext.beginPath();
        // Release line on the gate's INNER edge (the side players launch toward).
        if (g.edge == "right") {
            gameContext.moveTo(g.x, g.y);
            gameContext.lineTo(g.x, g.y + g.height);
        } else if (g.edge == "top") {
            gameContext.moveTo(g.x, g.y + g.height);
            gameContext.lineTo(g.x + g.width, g.y + g.height);
        } else if (g.edge == "bottom") {
            gameContext.moveTo(g.x, g.y);
            gameContext.lineTo(g.x + g.width, g.y);
        } else {
            // left (default): inner edge is the right side of the strip.
            gameContext.moveTo(g.x + g.width, g.y);
            gameContext.lineTo(g.x + g.width, g.y + g.height);
        }
        gameContext.stroke();
    }
    gameContext.restore();
}
function drawPingCircles() {
    if (pingCircles.length == 0) {
        return;
    }
    gameContext.save();
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = config.tileMap.goal.color;
    gameContext.beginPath();
    for (var i = 0; i < pingCircles.length; i++) {
        var ping = pingCircles[i];
        gameContext.moveTo(ping.x + ping.radius, ping.y);
        gameContext.arc(ping.x, ping.y, ping.radius, 0, 2 * Math.PI);
    }
    gameContext.stroke();
    gameContext.restore();
}
function drawCollapseShockwaves() {
    if (collapseShockwaves.length == 0) {
        return;
    }
    gameContext.save();
    gameContext.lineWidth = 6;
    gameContext.strokeStyle = config.tileMap.lava.color;
    for (var i = 0; i < collapseShockwaves.length; i++) {
        var s = collapseShockwaves[i];
        if (s.radius <= 0) { continue; }
        gameContext.globalAlpha = 0.6 * (1 - s.radius / s.maxRadius);
        gameContext.beginPath();
        gameContext.arc(s.x, s.y, s.radius, 0, 2 * Math.PI);
        gameContext.stroke();
    }
    gameContext.restore();
}
// Lobby-only "practice room" floor treatment: a dashed inset frame over the
// arena. Races never draw this, so a returning player instantly reads the lobby
// as a distinct practice space (not a glitched race map) — without any text.
// Drawn after drawWorld (the plain fill) and before the islands.
function drawLobbyFloor() {
    if (world == null) {
        return;
    }
    var ox = world.x + camera.getCameraX();
    var oy = world.y + camera.getCameraY();
    // Dashed inset frame — a "this is a bounded practice area" cue (theme-aware).
    gameContext.save();
    gameContext.globalAlpha = 0.32;
    gameContext.strokeStyle = themeColor('ink', 'black');
    gameContext.lineWidth = 3;
    gameContext.setLineDash([14, 10]);
    var inset = 12;
    gameContext.strokeRect(ox + inset, oy + inset, world.width - inset * 2, world.height - inset * 2);
    gameContext.setLineDash([]);
    gameContext.restore();
}
// Purely-visual "go here!" pointer: a ring of chunky cartoon arrows around the
// lobby start button, all jabbing inward, with a pulsing neon glow and a comical
// bob. No collision / no gameplay — just attract-mode flair drawing the eye to the
// start button. Lobby-only.
// Arrow footprint samples as [radial-from-ring, perpendicular] in px. The tip
// sits on the ring and the body extends OUTWARD (away from the button), so we
// have to test along the shaft and across the head — a tip-only check left the
// body clipping lava. Mirrors the block-arrow path drawn in drawLobbyArrows.
var LOBBY_ARROW_SAMPLES = [
    [0, 0], [26, 22], [26, -22], [40, 9], [40, -9], [52, 9], [52, -9]
];
var LOBBY_ARROW_BOB = 8;   // how far the arrow floats INWARD from its rest radius
// Find an angle around the button's ring where the whole arrow footprint clears
// lava, starting from the default slot and fanning outward both ways. The lobby
// map can drop lava under the fixed diagonal slots, so an arrow on it slides
// along the ring to clear ground — it still points at the button from wherever
// it lands (drawLobbyArrows rotates each arrow back toward center). worldR is in
// world units (tileIdAt takes world coords, no camera offset).
function lobbyArrowClearAngle(baseAng, worldR) {
    if (config == null || config.tileMap == null || lobbyStartButton == null) {
        return baseAng;
    }
    var bx = lobbyStartButton.x, by = lobbyStartButton.y;
    var lavaId = config.tileMap.lava.id;
    // Cover the rest radius AND the full inward bob travel, so a clear angle stays
    // clear through the whole float cycle (lava can sit on the inward side too).
    var shifts = [0, -LOBBY_ARROW_BOB];
    function footprintOnLava(a) {
        var dx = Math.cos(a), dy = Math.sin(a);         // outward (tip -> body) direction
        var px = -dy, py = dx;                          // perpendicular across the arrow
        for (var b = 0; b < shifts.length; b++) {
            for (var s = 0; s < LOBBY_ARROW_SAMPLES.length; s++) {
                var rad = worldR + shifts[b] + LOBBY_ARROW_SAMPLES[s][0];
                var perp = LOBBY_ARROW_SAMPLES[s][1];
                if (tileIdAt(bx + dx * rad + px * perp, by + dy * rad + py * perp) == lavaId) {
                    return true;
                }
            }
        }
        return false;
    }
    if (!footprintOnLava(baseAng)) {
        return baseAng;
    }
    var step = Math.PI / 36;                            // 5deg increments
    for (var k = 1; k <= 18; k++) {                     // search out to ~90deg each way
        if (!footprintOnLava(baseAng + step * k)) { return baseAng + step * k; }
        if (!footprintOnLava(baseAng - step * k)) { return baseAng - step * k; }
    }
    return baseAng;                                     // ringed by lava: stay put
}
function drawLobbyArrows() {
    if (lobbyStartButton == null || world == null) {
        return;
    }
    var cx = lobbyStartButton.x + camera.getCameraX();
    var cy = lobbyStartButton.y + camera.getCameraY();
    var btnR = lobbyStartButton.radius || 70;
    var count = 4;
    var t = Date.now() / 1000;
    var baseR = btnR + 50;                              // ring radius used for the lava test
    gameContext.save();
    gameContext.globalAlpha = 0.5;                       // translucent: float over the map, don't hide it
    for (var i = 0; i < count; i++) {
        var slotAng = (i / count) * Math.PI * 2 + Math.PI / 4; // +45deg -> 4 corner (diagonal) slots
        var ang = lobbyArrowClearAngle(slotAng, baseR);  // slide off lava, still points at center
        // Float only INWARD (toward the button): lobbyArrowClearAngle cleared lava
        // at the rest radius baseR, so a symmetric bob would push the body back
        // out onto it each cycle. Pulling toward center keeps it clear and still
        // reads as a "go this way" nudge.
        var bob = -(0.5 + 0.5 * Math.sin(t * 2.5 - i * 0.9)) * LOBBY_ARROW_BOB;
        var ringR = baseR + bob;                        // arrow tip distance from button center
        var ax = cx + Math.cos(ang) * ringR;
        var ay = cy + Math.sin(ang) * ringR;
        var pulse = 0.5 + 0.5 * Math.sin(t * 4 - i * 0.9);
        gameContext.save();
        gameContext.translate(ax, ay);
        gameContext.rotate(ang + Math.PI);              // local +x now points at the button
        // glow ("glowing lights")
        gameContext.shadowColor = "rgba(255, 210, 30, " + (0.5 + 0.4 * pulse) + ")";
        gameContext.shadowBlur = 14 + 14 * pulse;
        // chunky cartoon block arrow pointing +x (tip at origin -> toward button)
        gameContext.beginPath();
        gameContext.moveTo(0, 0);                        // tip
        gameContext.lineTo(-26, -22);
        gameContext.lineTo(-26, -9);
        gameContext.lineTo(-50, -9);
        gameContext.lineTo(-50, 9);
        gameContext.lineTo(-26, 9);
        gameContext.lineTo(-26, 22);
        gameContext.closePath();
        gameContext.fillStyle = "#FFE23A";
        gameContext.fill();
        gameContext.shadowBlur = 0;                      // crisp outline on top of the glow
        gameContext.lineWidth = 4;
        gameContext.lineJoin = "round";
        gameContext.strokeStyle = "#C24B00";
        gameContext.stroke();
        // little bright "light" at the tip
        gameContext.beginPath();
        gameContext.arc(-6, 0, 3.5, 0, 2 * Math.PI);
        gameContext.fillStyle = "rgba(255, 255, 245, " + (0.55 + 0.45 * pulse) + ")";
        gameContext.fill();
        gameContext.restore();
    }
    gameContext.restore();
}
function drawMap() {
    if (currentMap == null || currentMap.cells == null || currentMap.cells.length === 0) {
        return;
    }
    if (mapDirty || mapCanvas == null) {
        renderMapToCache();
        mapDirty = false;
    }
    if (mapCanvas != null) {
        var mdx = world.x - mapCanvasPad, mdy = world.y - mapCanvasPad;
        var mdw = world.width + mapCanvasPad * 2, mdh = world.height + mapCanvasPad * 2;
        // Space blits a single composite (starfield floor + 3D depth + terrain) —
        // one full-canvas blit, fewer ops than base's floor fill + terrain blit.
        // Water draws shallows + a swaying reflection under the terrain, then the
        // terrain. Otherwise just terrain.
        // Stretch the (possibly reduced-resolution) cache back over the full world
        // region; at scale 1 this is a 1:1 blit (unchanged on High/Balanced).
        if (arenaBackdropActive() && ARENA_FLOOR_THEME === 'space') {
            var arenaCache = ensureArenaCache();
            gameContext.drawImage(arenaCache != null ? arenaCache : mapCanvas, mdx, mdy, mdw, mdh);
        } else {
            if (arenaBackdropActive()) {
                drawIslandWater(mdx, mdy, mdw, mdh);
            }
            gameContext.drawImage(mapCanvas, mdx, mdy, mdw, mdh);
        }
    }
    if (Object.keys(hazardList).length > 0) {
        for (var id in hazardList) {
            drawHazard(hazardList[id]);
        }
    }
}

// Shallows + reflection for the water floor, drawn UNDER the terrain blit (the
// real terrain is painted on top right after, so only the parts that extend past
// the island edges remain visible). Reuses the cached terrain image (mapCanvas).
//   - Shallows: the cache blitted with a light glow → a bright rim where land
//     meets water.
//   - Reflection: a faint copy offset south and gently swaying → each island
//     casts a watery reflection that peeks out below it.
function drawIslandWater(dx, dy, dw, dh) {
    if (mapCanvas == null) { return; }
    var now = Date.now();
    var sway = Math.sin(now / 950) * 4;

    // Reflection first (deepest layer).
    gameContext.save();
    gameContext.globalAlpha = 0.20;
    gameContext.drawImage(mapCanvas, dx + sway, dy + 16, dw, dh);
    gameContext.restore();

    // Shallows rim (light glow around the landmasses).
    gameContext.save();
    gameContext.globalAlpha = 0.55;
    gameContext.shadowColor = isDarkTheme() ? 'rgba(140,215,255,0.9)' : 'rgba(205,245,255,0.95)';
    gameContext.shadowBlur = 13;
    gameContext.drawImage(mapCanvas, dx, dy, dw, dh);
    gameContext.restore();
}

// The whole space arena interior baked into ONE canvas: starfield floor, then the
// island depth FX (extruded side + blue atmosphere rim), then a crisp copy of the
// terrain on top. drawMap blits this in a single pass per frame — fewer ops than
// the base flat-grey floor (fillRect) + terrain blit — so the per-frame render is
// no heavier than main. Rebuilt only when the terrain cache changes (mapCacheRev)
// or resizes; the floor is static but cheap to repaint at that (rare) cadence.
function ensureArenaCache() {
    if (mapCanvas == null) { return null; }
    if (arenaCanvas &&
        arenaCanvas._srcRev === mapCacheRev &&
        arenaCanvas.width === mapCanvas.width &&
        arenaCanvas.height === mapCanvas.height) {
        return arenaCanvas;
    }
    var cv = arenaCanvas;
    if (cv == null || cv.width !== mapCanvas.width || cv.height !== mapCanvas.height) {
        cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
        if (cv == null) { return null; }
        cv.width = mapCanvas.width;
        cv.height = mapCanvas.height;
    }
    var c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);

    // Starfield floor fills the whole arena (shows through the terrain's gaps).
    paintStarfield(c, cv.width, cv.height);

    // Extruded side wall (stack of offset dark silhouettes via shadow) over the floor.
    c.save();
    c.shadowColor = 'rgba(24,32,60,1)';
    c.shadowBlur = 1;
    c.shadowOffsetX = 0;
    c.globalAlpha = 0.7;
    for (var d = 3; d <= 15; d += 3) {
        c.shadowOffsetY = d;
        c.drawImage(mapCanvas, 0, 0);
    }
    c.restore();

    // Soft blue atmosphere rim on the lit top edge.
    c.save();
    c.globalAlpha = 0.6;
    c.shadowColor = 'rgba(120,170,255,0.95)';
    c.shadowOffsetX = 0;
    c.shadowOffsetY = 0;
    c.shadowBlur = 16;
    c.drawImage(mapCanvas, 0, 0);
    c.restore();

    // Crisp terrain on top, covering the dim/offset copies left by the FX passes.
    c.drawImage(mapCanvas, 0, 0);

    cv._srcRev = mapCacheRev;
    arenaCanvas = cv;
    return cv;
}

// Trace a voronoi cell's polygon into the current path (no fill/stroke).
function traceCellPath(ctx, cell) {
    var halfedges = cell.halfedges;
    if (halfedges.length == 0) {
        return false;
    }
    ctx.beginPath();
    var v = getStartpoint(halfedges[0]);
    ctx.moveTo(v.x, v.y);
    for (var i = 0; i < halfedges.length; i++) {
        v = getEndpoint(halfedges[i]);
        ctx.lineTo(v.x, v.y);
    }
    ctx.closePath();
    return true;
}

// --- Tile-swap telegraph (destination "ghost") ---
// pendingSwapCells marks every fast/ice tile the moment a tileSwap is queued, for
// the random 3-6s warn-up before they flip. Each tile crossfades in the texture it
// is about to BECOME (fast<->ice), so players can read the pending change. It fades
// in smoothly with no early pulse; only in the final phase before the swap does a
// slow pulse ramp in, so it never strobes. The pending region is outlined along its
// silhouette only (perimeter edges, like drawLavaBorders) — internal cell seams and
// fast<->ice boundaries are left undrawn. See markPendingSwap / tileSwapLanded
// (gameboard.js) for the lifecycle.
var SWAP_WARN_COLOR = "#ffcf57"; // fallback tint if a destination texture isn't decoded yet

function drawSwapTelegraphTile(cell, prog, now) {
    var ctx = gameContext;
    var fastId = config.tileMap.fast.id, iceId = config.tileMap.ice.id;
    var destId = (cell.id === fastId) ? iceId : (cell.id === iceId ? fastId : null);
    var pat = (destId != null) ? patterns[destId] : null;
    // 0 until the last ~40%, then ramps to 1 — gates how much the slow pulse shows.
    var lastPhase = clamp01((prog - 0.6) / 0.4);
    var pulse = 0.5 + 0.5 * Math.sin((now / 1000) * 0.6 * Math.PI * 2); // slow, ~1.7s
    var pulseMul = 1 - lastPhase * 0.45 * (1 - pulse); // steady early, gently throbs late
    ctx.save();
    if (!traceCellPath(ctx, cell)) { ctx.restore(); return; }
    // Fill the tile with the destination texture, ramping in as the swap nears.
    ctx.globalAlpha = (0.1 + 0.45 * prog) * pulseMul;
    ctx.fillStyle = (pat != null) ? pat : SWAP_WARN_COLOR;
    ctx.fill();
    // Outline only the PERIMETER of the pending region (like drawLavaBorders): skip
    // any edge whose neighbour is also pending, so internal seams (incl. fast<->ice
    // boundaries) aren't drawn — only the silhouette. Each perimeter edge has exactly
    // one pending owner, so the translucent line never doubles up.
    var set = pendingSwapCells.set;
    var hes = cell.halfedges;
    ctx.beginPath();
    for (var h = 0; h < hes.length; h++) {
        var he = hes[h];
        var neighbor = compareSite(he.edge.lSite, he.site) ? he.edge.rSite : he.edge.lSite;
        if (neighbor != null && set[neighbor.voronoiId] != null) {
            continue; // internal seam between two pending tiles
        }
        var sp = getStartpoint(he), ep = getEndpoint(he);
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(ep.x, ep.y);
    }
    // Lower-opacity line styled in the destination texture, grows slightly.
    ctx.globalAlpha = (0.15 + 0.2 * prog) * pulseMul;
    ctx.lineWidth = 2 + 4 * prog;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = (pat != null) ? pat : SWAP_WARN_COLOR;
    ctx.stroke();
    ctx.restore();
}

// Overlay drawn on top of the cached map. Cleared as tiles flip (see changeTilesBulk
// / tileSwapLanded) and self-expires if the swap never lands.
function drawPendingSwap() {
    if (pendingSwapCells == null || currentMap == null || currentMap.cells == null) {
        return;
    }
    var now = Date.now();
    var set = pendingSwapCells.set;
    gameContext.save();
    for (var i = 0; i < currentMap.cells.length; i++) {
        var cell = currentMap.cells[i];
        var tile = set[cell.site.voronoiId];
        if (tile == null) {
            continue;
        }
        // Fallback self-expiry: a tile whose flip is well past (e.g. it got
        // converted by something else and never cleared via tileSwapPerformed).
        if (now - tile.end > 1500) {
            delete set[cell.site.voronoiId];
            continue;
        }
        // Per-tile progress so overlapping swaps each ramp on their own clock.
        var span = tile.end - tile.start;
        var prog = span > 0 ? clamp01((now - tile.start) / span) : 1;
        drawSwapTelegraphTile(cell, prog, now);
    }
    gameContext.restore();
    // Once every tile has flipped/cleared/expired, drop the telegraph.
    if (Object.keys(set).length === 0) {
        pendingSwapCells = null;
    }
}

function renderMapToCache() {
    if (world == null) {
        return;
    }
    // The map cache is re-rendered AND re-uploaded to the GPU on every tile change
    // (ability pickup, bomb, tileSwap, collapse). On low-end GPUs that big-texture
    // upload is the dominant paint stutter, so render the cache at a reduced
    // resolution there (perfMapScale < 1) — fewer bytes per upload, slightly softer
    // terrain. Rebuild from scratch if the scale changed (profile toggled).
    var scale = (typeof perfMapScale === "function") ? perfMapScale() : 1;
    if (mapCanvas != null && mapCanvas._mapScale !== scale) {
        mapCanvas = null;
    }
    if (mapCanvas == null) {
        mapCanvas = document.createElement("canvas");
        mapCanvas.width = Math.max(1, Math.ceil((world.width + mapCanvasPad * 2) * scale));
        mapCanvas.height = Math.max(1, Math.ceil((world.height + mapCanvasPad * 2) * scale));
        mapCanvas._mapScale = scale;
        mapCtx = mapCanvas.getContext("2d");
    } else {
        mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    }
    mapCtx.save();
    if (scale !== 1) {
        mapCtx.scale(scale, scale);   // render world-coord cells into the smaller texture
    }
    mapCtx.translate(-world.x + mapCanvasPad, -world.y + mapCanvasPad);

    // Per-cell AO edge shading reads as depth, but it's an extra gradient fill
    // per cell on every cache rebuild — skip it on the reduced-resolution
    // (low-end) profile, where the flat graded texture already looks clean.
    var aoOn = (typeof perfMapScale === "function" ? perfMapScale() : 1) === 1;
    var cells = currentMap.cells;
    var aoIds = aoOn ? buildIdByVoronoi(cells) : null;
    var iCell = cells.length;
    while (iCell--) {
        mapCtx.beginPath();
        var cell = cells[iCell];
        // Transparent "background" cells render nothing, so the plain lobby shows
        // through and only the curated islands are visible.
        if (cell.id == config.tileMap.background.id) {
            continue;
        }
        // Empty "hole" cells render nothing either, so whatever sits below the map
        // (skybox / water) shows through. Their no-go rim is stroked separately by
        // drawEmptyBorders so players can see they can't drive in.
        if (cell.id == config.tileMap.empty.id) {
            continue;
        }
        var halfedges = cell.halfedges;
        var nHalfedges = halfedges.length;
        if (nHalfedges == 0) {
            continue;
        }
        var v = getStartpoint(halfedges[0]);
        mapCtx.moveTo(v.x, v.y);
        for (var i = 0; i < nHalfedges; i++) {
            v = getEndpoint(halfedges[i]);
            mapCtx.lineTo(v.x, v.y);
        }
        var color = null;

        if (cell.id > 99) {
            mapCtx.setLineDash([2, 2]);
            mapCtx.lineWidth = 5;
            mapCtx.strokeStyle = '#FFFF00';
            // Ability tiles: bake only the dirt underlay here; the ability icon is
            // drawn hovering per-frame (drawTerrainFX) instead of flat in the cache.
            // Fall back to the baked icon pattern if dirt isn't ready yet.
            var dirtPat = patterns[config.tileMap.normal.id];
            color = (dirtPat != null) ? dirtPat : patterns[cell.id];
        } else if (patterns[cell.id] != null) {
            color = patterns[cell.id];
            mapCtx.setLineDash([]);
            mapCtx.lineWidth = 1;
            mapCtx.strokeStyle = patterns[cell.id];
        } else if (cell.id == config.tileMap.goal.id) {
            mapCtx.setLineDash([0, 0]);
            mapCtx.lineWidth = 5;
            mapCtx.strokeStyle = '#756300';
            color = locateColor(cell.id);
        } else {
            color = locateColor(cell.id);
            mapCtx.setLineDash([]);
            mapCtx.lineWidth = 3;
            mapCtx.strokeStyle = color;
        }
        mapCtx.shadowBlur = 0;
        mapCtx.shadowColor = "transparent";
        mapCtx.fillStyle = color;
        mapCtx.fill();
        mapCtx.stroke();
        // Terrain depth: soft inner shadow only where this cell meets a different
        // terrain type, so same-type regions stay seamless. No-op for non-terrain
        // tiles. Baked into the cache, so it's free per frame.
        if (aoIds) { paintCellEdgeAO(mapCtx, cell, aoIds); }
    }
    drawTileBorders(mapCtx);
    drawLavaBorders(mapCtx);
    // Re-bake the persistent sand trench on top of the terrain (still under the
    // hazard pass + karts, which draw after the cache blit) — its world->cache
    // transform is the one active here.
    paintTrenchSegments(mapCtx);
    drawEmptyBorders(mapCtx);
    mapCtx.restore();
    // Terrain changed → derived FX caches (space island depth) must rebuild.
    mapCacheRev++;
}

// A subtle dark vignette over the play area, so the flat background reads as an
// intentional frame rather than dead space. Drawn in world coords right after
// the map (under players/FX) so it never dims karts. Cheap: one gradient fill.
function drawArenaVignette() {
    if (world == null) {
        return;
    }
    var cx = world.x + world.width / 2;
    var cy = world.y + world.height / 2;
    var inner = Math.min(world.width, world.height) * 0.45;
    var outer = Math.sqrt(world.width * world.width + world.height * world.height) / 2;
    var g = gameContext.createRadialGradient(cx, cy, inner, cx, cy, outer);
    g.addColorStop(0, "rgba(0, 0, 0, 0)");
    g.addColorStop(1, "rgba(8, 6, 14, 0.26)");
    gameContext.save();
    gameContext.fillStyle = g;
    gameContext.fillRect(world.x, world.y, world.width, world.height);
    gameContext.restore();
}

// Trace a dark-red rim around every lava grouping. The map is a Voronoi diagram
// so each edge knows the two cells it separates; we stroke only the edges where
// a lava cell meets a non-lava cell (or the map boundary), which outlines each
// island's perimeter without drawing the internal seams between adjacent lava
// tiles. Runs only on cache rebuilds (map load / tile change), so it's free
// per-frame. Keys off cell.id, so it tracks bombs/tileSwap/collapse and still
// works when lava renders as poison in infection rounds.
// Outline every terrain region's perimeter with a subtle dark edge so tiles
// read as crisp, designed shapes instead of soft Voronoi blobs. Like
// drawLavaBorders, each Voronoi edge knows the two cells it separates, so we
// stroke only edges where the tile TYPE changes (or the map/background edge) —
// internal seams between same-type cells are skipped, avoiding a busy mesh.
// Lava edges are left to drawLavaBorders (its red rim owns them). Runs only on
// cache rebuilds, so it's free per-frame.
var tileBorderColor = "rgba(18, 16, 24, 0.42)";
function drawTileBorders(ctx) {
    if (currentMap == null || currentMap.cells == null) {
        return;
    }
    var cells = currentMap.cells;
    var bgId = config.tileMap.background.id;
    var lavaId = config.tileMap.lava.id;
    var emptyId = config.tileMap.empty.id;
    var idByVoronoi = {};
    for (var i = 0; i < cells.length; i++) {
        idByVoronoi[cells[i].site.voronoiId] = cells[i].id;
    }
    ctx.save();
    ctx.beginPath();
    for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        if (cell.id == bgId || cell.id == lavaId || cell.id == emptyId) {
            continue; // background draws nothing; lava and empty holes have their own rim
        }
        var halfedges = cell.halfedges;
        for (var h = 0; h < halfedges.length; h++) {
            var he = halfedges[h];
            var neighbor = compareSite(he.edge.lSite, he.site) ? he.edge.rSite : he.edge.lSite;
            var nid = neighbor != null ? idByVoronoi[neighbor.voronoiId] : null;
            if (nid === cell.id || nid === lavaId || nid === emptyId) {
                continue; // same-type internal seam, or lava's / hole's own rim — skip
            }
            var sp = getStartpoint(he);
            var ep = getEndpoint(he);
            ctx.moveTo(sp.x, sp.y);
            ctx.lineTo(ep.x, ep.y);
        }
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = tileBorderColor;
    ctx.stroke();
    ctx.restore();
}

var lavaBorderColor = "#7a1500";
function drawLavaBorders(ctx) {
    if (currentMap == null || currentMap.cells == null) {
        return;
    }
    var lavaId = config.tileMap.lava.id;
    var cells = currentMap.cells;
    var idByVoronoi = {};
    for (var i = 0; i < cells.length; i++) {
        idByVoronoi[cells[i].site.voronoiId] = cells[i].id;
    }
    ctx.save();
    ctx.beginPath();
    for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        if (cell.id != lavaId) {
            continue;
        }
        var halfedges = cell.halfedges;
        for (var h = 0; h < halfedges.length; h++) {
            var he = halfedges[h];
            // The cell across this edge (null on the map boundary).
            var neighbor = compareSite(he.edge.lSite, he.site) ? he.edge.rSite : he.edge.lSite;
            if (neighbor != null && idByVoronoi[neighbor.voronoiId] == lavaId) {
                continue; // internal seam between two lava tiles — skip
            }
            var sp = getStartpoint(he);
            var ep = getEndpoint(he);
            ctx.moveTo(sp.x, sp.y);
            ctx.lineTo(ep.x, ep.y);
        }
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = lavaBorderColor;
    ctx.stroke();
    ctx.restore();
}
// The rim around an empty hole. Empty cells are non-walkable and draw nothing (the
// skybox/water below shows through), so this perimeter is the only cue that you'll
// bounce off the edge — given a beveled "ledge" look (dark outer lip + light inner
// highlight) to read as a drop-off rather than a tile seam.
var emptyBorderOuter = "#0c0c14";
var emptyBorderInner = "rgba(170, 190, 215, 0.85)";
function drawEmptyBorders(ctx) {
    if (currentMap == null || currentMap.cells == null) {
        return;
    }
    var emptyId = config.tileMap.empty.id;
    var cells = currentMap.cells;
    // Most maps have no holes — bail before the neighbour-index build + per-edge work.
    var anyEmpty = false;
    for (var e = 0; e < cells.length; e++) {
        if (cells[e].id === emptyId) { anyEmpty = true; break; }
    }
    if (!anyEmpty) {
        return;
    }
    var idByVoronoi = {};
    for (var i = 0; i < cells.length; i++) {
        idByVoronoi[cells[i].site.voronoiId] = cells[i].id;
    }
    ctx.save();
    ctx.beginPath();
    for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        if (cell.id != emptyId) {
            continue;
        }
        var halfedges = cell.halfedges;
        for (var h = 0; h < halfedges.length; h++) {
            var he = halfedges[h];
            // The cell across this edge (null on the map boundary).
            var neighbor = compareSite(he.edge.lSite, he.site) ? he.edge.rSite : he.edge.lSite;
            if (neighbor != null && idByVoronoi[neighbor.voronoiId] == emptyId) {
                continue; // internal seam between two empty cells — skip
            }
            var sp = getStartpoint(he);
            var ep = getEndpoint(he);
            ctx.moveTo(sp.x, sp.y);
            ctx.lineTo(ep.x, ep.y);
        }
    }
    ctx.setLineDash([]);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Dark outer lip first, then a thinner light highlight on top, for a ledge look.
    ctx.lineWidth = 5;
    ctx.strokeStyle = emptyBorderOuter;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = emptyBorderInner;
    ctx.stroke();
    ctx.restore();
}
function drawHazard(hazard) {
    if (hazard.id == config.hazards.bumper.id) {
        drawBumper(hazard.x, hazard.y);
    }
    if (hazard.id == config.hazards.movingBumper.id) {
        drawMovingBumper(hazard.x, hazard.y, hazard.railX, hazard.railY, hazard.angle);
    }
}

var bumperRingColor = "#E5392B";
function drawBumper(x, y) {
    gameContext.save();
    gameContext.beginPath();
    gameContext.strokeStyle = bumperRingColor;
    gameContext.lineWidth = 3;
    gameContext.arc(x, y, config.hazards.bumper.attackRadius, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.beginPath();
    gameContext.arc(x, y, config.hazards.bumper.radius, 0, 2 * Math.PI);
    gameContext.fillStyle = config.hazards.bumper.color;
    gameContext.fill();
    gameContext.restore();
}
function drawMovingBumper(x, y, railX, railY, angle) {
    gameContext.save();
    gameContext.beginPath();
    gameContext.translate(railX, railY);
    gameContext.rotate(angle * (Math.PI / 180));
    gameContext.rect(0, -config.hazards.movingBumper.height / 2, config.hazards.movingBumper.width, config.hazards.movingBumper.height);
    gameContext.fillStyle = "black";
    gameContext.fill();
    gameContext.restore();

    gameContext.save();
    gameContext.beginPath();
    gameContext.strokeStyle = bumperRingColor;
    gameContext.lineWidth = 3;
    gameContext.arc(x, y, config.hazards.movingBumper.attackRadius, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.beginPath();
    gameContext.arc(x, y, config.hazards.movingBumper.radius, 0, 2 * Math.PI);
    gameContext.fillStyle = config.hazards.movingBumper.color;
    gameContext.fill();
    gameContext.restore();
}

function locateColor(id) {
    if (id == null) {
        return "purple";
    }
    if (id > 99) {
        return config.tileMap.ability.color;
    }
    for (var type in config.tileMap) {
        if (id == config.tileMap[type].id) {
            return config.tileMap[type].color;
        }
    }
}
function locateSymbol(id) {
    for (var type in config.tileMap.abilities) {
        if (id == config.tileMap.abilities[type].id) {
            return config.tileMap.abilities[type].symbol;
        }
    }
}

function getStartpoint(halfedge) {
    if (compareSite(halfedge.edge.lSite, halfedge.site)) {
        return halfedge.edge.va;
    }
    return halfedge.edge.vb;
}
function getEndpoint(halfedge) {
    if (compareSite(halfedge.edge.lSite, halfedge.site)) {
        return halfedge.edge.vb;
    }
    return halfedge.edge.va;
}

function compareSite(siteA, siteB) {
    if (siteA.voronoiId != siteB.voronoiId) {
        return false;
    }
    if (siteA.x != siteB.x) {
        return false;
    }
    if (siteA.y != siteB.y) {
        return false;
    }
    return true;
}

function drawHUD() {
    drawGameInfo();
    drawRaceTimer();
    drawBrutalBadges();
    drawSpectatorLeaderboard();
    drawWorldRecordBanner();
    drawVirtualButtons();
    drawTouchControls();
    drawTitle();
}

// Persistent top-right badge (just under the race timer) showing one icon per active
// brutal-round mode for the whole round — so a player who looked away, or who joined
// after the announcement card faded, can always tell which modes are live. Reuses the
// recap badge style (light tile + dark silhouette) so the icons read over any terrain.
function drawBrutalBadges() {
    if (brutalRound != true || brutalRoundConfig == null || brutalRoundConfig.brutalTypes == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) { return; }
    if (typeof brutalRoundImages === "undefined" || brutalRoundImages == null) { return; }
    var icons = [];
    for (var i = 0; i < brutalRoundConfig.brutalTypes.length; i++) {
        var img = brutalRoundImages[brutalRoundConfig.brutalTypes[i]];
        if (img != null) { icons.push(img); }
    }
    if (icons.length === 0) { return; }
    var bw = 30, bh = 28, gap = 5, topY = 56;
    var totalW = icons.length * bw + (icons.length - 1) * gap;
    var startX = LOGICAL_WIDTH - 20 - totalW; // right-aligned under the timer
    gameContext.save();
    for (var k = 0; k < icons.length; k++) {
        var bx = startX + k * (bw + gap);
        gameContext.fillStyle = "rgba(255,255,255,0.82)";
        gameContext.fillRect(bx, topY, bw, bh);
        gameContext.strokeStyle = "rgba(0,0,0,0.55)";
        gameContext.lineWidth = 1.5;
        gameContext.strokeRect(bx, topY, bw, bh);
        var ic = icons[k];
        if (ic.complete !== false && (ic.naturalWidth == null || ic.naturalWidth > 0)) {
            try {
                var ratio = (ic.width && ic.height) ? (ic.height / ic.width) : 0.88;
                var iw = bw - 8;
                var ih = iw * ratio;
                if (ih > bh - 6) { ih = bh - 6; iw = ih / ratio; }
                gameContext.drawImage(ic, bx + (bw - iw) / 2, topY + (bh - ih) / 2, iw, ih);
            } catch (e) { /* icon not decoded — badge tile still flags it */ }
        }
    }
    gameContext.restore();
}

// Screen-space banner that drops in when ANY player (you, an opponent, an
// off-screen finisher) sets a top-10 world record. Visible regardless of
// where the camera is so a WR happening across the map isn't missed. Slides
// down from the top, holds, fades up. Self-clears after the animation; a new
// WR mid-animation replaces it.
var WORLD_RECORD_BANNER_DURATION_MS = 4800;
function drawWorldRecordBanner() {
    if (worldRecordBanner == null) { return; }
    var t = (Date.now() - worldRecordBanner.startedAt) / WORLD_RECORD_BANNER_DURATION_MS;
    if (t >= 1) { worldRecordBanner = null; return; }

    // Slide-down + fade-in (first 12%), hold (12-78%), slide-up + fade-out (last 22%).
    var alpha, slide;
    if (t < 0.12) {
        var k = t / 0.12;
        alpha = k;
        slide = -40 * (1 - k); // start 40px above target, ease in
    } else if (t > 0.78) {
        var k2 = (t - 0.78) / 0.22;
        alpha = 1 - k2;
        slide = -40 * k2;
    } else {
        alpha = 1;
        slide = 0;
    }

    var cx = LOGICAL_WIDTH / 2;
    var by = 70 + slide;
    var rankSuffix = (worldRecordBanner.rank != null) ? ("  ·  #" + worldRecordBanner.rank + " global") : "";
    var line1 = "New world record";
    var line2 = worldRecordBanner.displayName + " — " + worldRecordBanner.mapName;
    var line3 = formatRaceTime(worldRecordBanner.finishMs) + rankSuffix;

    gameContext.save();
    gameContext.globalAlpha = alpha;
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    // Headline — magenta, subtle outline; no glow.
    gameContext.font = "bold 22px Arial";
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = "rgba(0,0,0,0.85)";
    gameContext.strokeText(line1, cx, by);
    gameContext.fillStyle = "#ff5fea";
    gameContext.fillText(line1, cx, by);
    // Who · where — white.
    gameContext.font = "15px Arial";
    gameContext.strokeText(line2, cx, by + 19);
    gameContext.fillStyle = "white";
    gameContext.fillText(line2, cx, by + 19);
    // Time + rank — gold.
    gameContext.font = "bold 16px Arial";
    gameContext.strokeText(line3, cx, by + 38);
    gameContext.fillStyle = "#ffd54a";
    gameContext.fillText(line3, cx, by + 38);
    gameContext.restore();
}

// Compact corner leaderboard shown while spectating (dead/finished during a
// race). Sources mapLeaderboardCurrent (server emits at startRace). Top-left
// of the HUD so the timer in the top-right and centered GameID row stay
// uncluttered. Renders even when the current map has no leaderboard rows yet
// — shows a "New map!" placeholder so the player understands the widget is
// alive, just unfilled. Hidden when the local racer is still actively racing.
function drawSpectatorLeaderboard() {
    if (mapLeaderboardCurrent == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) {
        return;
    }
    var local = (typeof myID !== "undefined" && playerList) ? playerList[myID] : null;
    if (local == null) { return; }
    // Only when the local racer is no longer active (died or finished).
    var spectating = (!local.alive) || local.reachedGoal || local.isSpectator;
    if (!spectating) { return; }

    var rows = mapLeaderboardCurrent.rows || [];
    var mapName = mapLeaderboardCurrent.mapName || "this map";
    var listX = 20;
    var listY = 50;
    var rowH = 18;

    gameContext.save();
    gameContext.fillStyle = "white";
    gameContext.font = "bold 14px Arial";
    gameContext.textBaseline = "alphabetic";
    gameContext.textAlign = "left";
    gameContext.fillText("Times to beat — " + mapName, listX, listY);

    if (rows.length === 0) {
        gameContext.font = "italic 13px Arial";
        gameContext.fillStyle = "#9b5";
        gameContext.fillText("New map!", listX, listY + 18);
        gameContext.restore();
        return;
    }

    gameContext.font = "12px Arial";
    var nameColX = listX + 38;
    var timeColX = listX + 240;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var rowY = listY + 16 + i * rowH;
        gameContext.textAlign = "left";
        gameContext.fillStyle = "white";
        gameContext.fillText("#" + row.rank, listX, rowY);
        // "Anon" placeholder for nameless rows (same convention as the main
        // overview card and WR banner).
        var label = row.displayName || "Anon";
        var maxNameW = (timeColX - nameColX) - 14;
        var truncated = label;
        if (gameContext.measureText(label).width > maxNameW) {
            while (truncated.length > 1 && gameContext.measureText(truncated + "…").width > maxNameW) {
                truncated = truncated.slice(0, -1);
            }
            truncated += "…";
        }
        gameContext.fillText(truncated, nameColX, rowY);
        gameContext.textAlign = "right";
        gameContext.fillText(formatRaceTime(row.bestMs), timeColX, rowY);
    }
    gameContext.restore();
}

// "NEW personal record!!" / "NEW WORLD record!!!" float for each player who
// just set a PB this round. Server pushes records via playerPbResult after the
// per-finish upsert + rank lookup, which means the last finisher's float can
// arrive AFTER startOverview has already begun (their finish triggered it).
//
// Rendered in two contexts:
//   * Race/collapse — anchored above the kart's world position (it's at the
//     goal cell when they finished). Drawn from the world-space pass.
//   * Overview      — anchored to the player's notch row on the standings
//     column, so a late-arriving float still surfaces visibly. Drawn from
//     drawOverviewBoard.
//
// `drainRecordFloats` runs every frame so expired entries are pruned even when
// no render branch fires, keeping the array bounded across rounds.
var RECORD_FLOAT_DURATION_MS = 2400;

function drainRecordFloats() {
    if (recordFloats.length === 0) { return; }
    var now = Date.now();
    var w = 0;
    for (var r = 0; r < recordFloats.length; r++) {
        if (now - recordFloats[r].startedAt < RECORD_FLOAT_DURATION_MS) {
            recordFloats[w++] = recordFloats[r];
        }
    }
    recordFloats.length = w;
}

// Animation envelope (alpha, vertical rise) shared by both render contexts.
function recordFloatEnvelope(now, startedAt) {
    var t = (now - startedAt) / RECORD_FLOAT_DURATION_MS;
    var alpha;
    if (t < 0.1) { alpha = t / 0.1; }
    else if (t > 0.6) { alpha = Math.max(0, (1 - t) / 0.4); }
    else { alpha = 1; }
    var rise = 50 * (1 - Math.pow(1 - t, 2));
    return { alpha: alpha, rise: rise, t: t };
}

function paintRecordFloat(f, x, y, alpha) {
    var label = f.isWorldRecord ? "NEW WORLD record!!!" : "NEW personal record!!";
    var color = f.isWorldRecord ? "#ff5fea" : "#ffd54a";
    gameContext.globalAlpha = alpha;
    gameContext.font = "bold 18px Arial";
    gameContext.lineWidth = 4;
    gameContext.strokeStyle = "rgba(0,0,0,0.85)";
    gameContext.shadowColor = color;
    gameContext.shadowBlur = 10;
    gameContext.strokeText(label, x, y);
    gameContext.fillStyle = color;
    gameContext.fillText(label, x, y);
    gameContext.font = "bold 22px Arial";
    gameContext.strokeText(formatRaceTime(f.finishMs), x, y + 22);
    gameContext.fillText(formatRaceTime(f.finishMs), x, y + 22);
}

// World-space rendering — used during the racing/collapsing draw pass.
function drawRecordFloats() {
    drainRecordFloats();
    if (recordFloats.length === 0) { return; }
    var now = Date.now();
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    for (var i = 0; i < recordFloats.length; i++) {
        var f = recordFloats[i];
        var player = playerList ? playerList[f.playerId] : null;
        if (player == null || player.x == null || player.y == null) { continue; }
        var env = recordFloatEnvelope(now, f.startedAt);
        var x = player.x + camera.getCameraX();
        var y = player.y + camera.getCameraY() - 40 - env.rise;
        paintRecordFloat(f, x, y, env.alpha);
    }
    gameContext.restore();
}

// Notch-row rendering — used during the overview-screen pass. The world-space
// anchor doesn't apply (camera detached, players unrendered), so the float
// drops onto the player's scoreboard row instead. Last-finisher records that
// arrive AFTER startOverview still surface here. Geometry mirrors
// drawOldNotches's iteration so the rows line up regardless of player count.
function drawRecordFloatsOverview() {
    drainRecordFloats();
    if (recordFloats.length === 0) { return; }
    if (playerList == null) { return; }
    // Map playerId -> row index, matching drawOldNotches's iteration order.
    var rowIdx = {};
    var count = 0;
    for (var pid in playerList) { rowIdx[pid] = count++; }
    if (count === 0) { return; }
    var distanceApart = 7;
    var rowH = config.playerBaseRadius * distanceApart;
    var offSetX = 80;
    var offSetY = LOGICAL_HEIGHT / 2 - (count * rowH * 0.5);
    // Drop the float a bit to the right of the notch column header and just
    // above the row so it doesn't collide with the notch icon or delta float.
    var notchColEndX = (gameLength + 1) * notchDistanceApart;

    var now = Date.now();
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    for (var i = 0; i < recordFloats.length; i++) {
        var f = recordFloats[i];
        if (!(f.playerId in rowIdx)) { continue; }
        var env = recordFloatEnvelope(now, f.startedAt);
        var x = offSetX + notchColEndX / 2;
        var y = offSetY + rowIdx[f.playerId] * rowH - 20 - env.rise;
        paintRecordFloat(f, x, y, env.alpha);
    }
    gameContext.restore();
}

// Race elapsed-time timer in the top-right HUD corner. Active during racing /
// collapsing. Stores the frozen elapsed value directly (not a wall-clock
// timestamp) so the display never depends on subtracting a server clock from
// the browser's clock. Three states:
//   * Running   -> Date.now() - raceStartedAt, white
//   * Finished  -> player.finishMs (server-authoritative), gold
//   * Died      -> elapsed-at-receipt (client-relative), red
// Latched on the first transition; later state changes (zombie respawn etc.)
// can't unfreeze it.
function drawRaceTimer() {
    if (raceStartedAt == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) {
        return;
    }
    var local = (typeof myID !== "undefined" && playerList) ? playerList[myID] : null;

    if (local != null && localTimerStopAt == null) {
        if (local.reachedGoal && typeof local.finishMs === 'number') {
            // Goal-cross: server tells us the elapsed delta directly. Pin
            // the display to that value so it reads identical to the
            // server-side leaderboard, regardless of any client clock drift.
            localTimerStopAt = local.finishMs;
            localTimerStopByDeath = false;
        } else if (local.alive === false) {
            // Death: no server time was sent. Client-relative elapsed is fine
            // here because both endpoints (raceStartedAt and Date.now()) come
            // from the same browser clock.
            localTimerStopAt = Date.now() - raceStartedAt;
            localTimerStopByDeath = true;
        }
    }

    var elapsed = (localTimerStopAt != null) ? localTimerStopAt : (Date.now() - raceStartedAt);
    if (!(elapsed >= 0)) { elapsed = 0; }

    var color = "white";
    if (localTimerStopAt != null) {
        color = localTimerStopByDeath ? "#ff5a5a" : "#ffd54a";
    }
    gameContext.save();
    gameContext.fillStyle = color;
    gameContext.font = "bold 28px Arial";
    gameContext.textAlign = "right";
    gameContext.textBaseline = "alphabetic";
    gameContext.fillText(formatRaceTime(elapsed), LOGICAL_WIDTH - 20, 40);
    gameContext.restore();
}

// Local players (slots) that joined this match mid-race and are still waiting:
// the server parked them as temp spectators who race from the next round. Covers
// the primary AND any co-op pad seat that joined after the gate. The per-slot
// lateJoinSpectating flag distinguishes a late joiner from a racer who just died
// this round (both are !alive during racing).
function spectatingLocalPlayers() {
    var out = [];
    if (typeof localPlayers === "undefined" || typeof playerList === "undefined" || !playerList) {
        return out;
    }
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (!lp || lp.myID == null || !lp.lateJoinSpectating) {
            continue;
        }
        var p = playerList[lp.myID];
        if (p != null && !p.alive) {
            out.push(p);
        }
    }
    return out;
}

// A centered hint for local players who joined a match mid-round: each races from
// the next round. Drawn in HUD (screen) space below the GameID/Players/Round row,
// ending with a mini kart per waiting player in the colour the server assigned it
// (same sprite + colour-blind remap as their real kart), so they know what
// they'll race as. State-gated to the live race so it never bleeds into the
// game-over / lobby screens. When a local player is actively RACING on this
// shared couch screen, the whole banner is faded so it doesn't obscure their run;
// at full strength only when everyone local is waiting.
function drawSpectatorBanner() {
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) {
        return;
    }
    var specs = spectatingLocalPlayers();
    if (specs.length === 0) {
        return;
    }
    var racingPresent = livingLocalPlayers().length > 0;

    var swatchR = 10;          // kart disc radius drawn in the banner
    var discGap = 6;           // spacing between multiple kart discs
    var sprites = [];
    for (var i = 0; i < specs.length; i++) {
        if (specs[i].color != null) {
            sprites.push(getPlayerSprite(specs[i].color, swatchR, "black"));
        }
    }
    var hasSwatch = sprites.length > 0;
    var text = hasSwatch ? "Spectating — you'll race next round as"
        : "Spectating — you'll race next round";
    var gap = hasSwatch ? 10 : 0;  // text -> first swatch spacing
    var swatchW = hasSwatch ? (sprites.length * swatchR * 2 + (sprites.length - 1) * discGap) : 0;

    gameContext.save();
    // Considerate fade when a local kart is still racing; full strength otherwise.
    gameContext.globalAlpha = racingPresent ? 0.6 : 1.0;
    gameContext.font = "bold 18px Arial";
    gameContext.textAlign = "left";
    gameContext.textBaseline = "alphabetic";
    var textW = gameContext.measureText(text).width;
    var padX = 14;
    var w = textW + gap + swatchW + padX * 2;
    var cx = LOGICAL_WIDTH / 2;
    var y = 52;
    var boxX = cx - w / 2;

    gameContext.fillStyle = "rgba(0, 0, 0, 0.55)";
    roundRectPath(gameContext, boxX, y - 19, w, 28, 8); // in the play bundle (audience.js)
    gameContext.fill();

    var textX = boxX + padX;
    gameContext.fillStyle = "white";
    gameContext.fillText(text, textX, y);

    var discCx = textX + textW + gap + swatchR;
    var discCy = y - 5; // vertical centre of the pill (top y-19, height 28)
    for (var j = 0; j < sprites.length; j++) {
        gameContext.drawImage(sprites[j], discCx - sprites[j].halfSize, discCy - sprites[j].halfSize);
        discCx += swatchR * 2 + discGap;
    }
    gameContext.restore();
}

function drawGameInfo() {
    // Drawn in the HUD pass (logical screen space), so centre on the logical
    // width, not the world width (they're equal today, but the HUD shouldn't
    // depend on world dims).
    var startX = LOGICAL_WIDTH / 2 - 125;
    gameContext.save();
    gameContext.font = "14px Arial";
    gameContext.strokeStyle = themeColor('inkOutline', 'white');
    gameContext.lineWidth = 4;
    gameContext.fillStyle = themeColor('ink', 'black');
    gameContext.strokeText("GameID: " + gameID, startX + 10, 20);
    gameContext.fillText("GameID: " + gameID, startX + 10, 20);
    gameContext.strokeText("Players: " + totalPlayers, startX + 100, 20);
    gameContext.fillText("Players: " + totalPlayers, startX + 100, 20);
    gameContext.strokeText("Round: " + round, startX + 190, 20);
    gameContext.fillText("Round: " + round, startX + 190, 20);
    gameContext.restore();
}

function drawVirtualButtons() {
    if (virtualButtonList == null) {
        return;
    }
    for (var i = 0; i < virtualButtonList.length; i++) {
        var bound = virtualButtonList[i].bound;
        if (bound.render == true) {
            gameContext.save();
            gameContext.beginPath();
            gameContext.strokeStyle = "rgba(255, 0, 0, 1)";
            gameContext.rect(bound.x, bound.y, bound.width, bound.height);
            gameContext.stroke();
            gameContext.restore();
        }
    }
}

function drawTouchControls(ctx) {
    if (isTouchScreen == false) {
        return;
    }
    // Draw on the OVERLAY canvas (top layer) by default so the controls sit ABOVE
    // everything the game draws — including the blackout brutal round, which fills
    // the overlay with darkness. The control UI must never be hidden by a gameplay
    // effect. (Both canvases share the same transform; see applyCanvasTransform.)
    ctx = ctx || overlayContext;

    var exitToUse = exitIcon;
    var fullScreenToUse = fullscreenIcon;
    var chatToUse = commentIconSolid;

    // The default icons are dark (no SVG fill = black) and vanish on the dark
    // overview background or the dark-theme canvas surface, so swap in the white
    // PNG variants for both of those cases.
    var useWhiteIcons = currentState == config.stateMap.overview ||
        (typeof document !== 'undefined' &&
            document.documentElement.getAttribute('data-theme') === 'dark');
    if (useWhiteIcons) {
        exitToUse = exitIconWhite;
        fullScreenToUse = fullscreenIconWhite;
        chatToUse = commentIconWhite;
    }


    if (joystickMovement != null && joystickMovement.isVisible()) {
        ctx.save();
        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = themeColor('ink', 'black');
        ctx.arc(joystickMovement.baseX, joystickMovement.baseY, joystickMovement.baseRadius, 0, Math.PI * 2, false);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(joystickMovement.baseX, joystickMovement.baseY, joystickMovement.stickRadius, 0, Math.PI * 2, false);
        ctx.stroke();


        ctx.beginPath();
        ctx.arc(joystickMovement.stickX, joystickMovement.stickY, joystickMovement.stickRadius, 0, Math.PI * 2, true);
        ctx.fillStyle = "rgba(255, 0, 0, 0.2)";
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawTouchLabel("Move", joystickMovement.baseX, joystickMovement.baseY + joystickMovement.baseRadius + 20, ctx);
    }
    if (joystickCamera != null && joystickCamera.isVisible()) {
        ctx.save();

        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = themeColor('ink', 'black');
        ctx.arc(joystickCamera.baseX, joystickCamera.baseY, joystickCamera.baseRadius, 0, Math.PI * 2, false);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(joystickCamera.baseX, joystickCamera.baseY, joystickCamera.stickRadius, 0, Math.PI * 2, false);
        ctx.stroke();

        ctx.beginPath();
        ctx.fillStyle = "rgba(0, 255, 0, 0.2)";
        ctx.arc(joystickCamera.stickX, joystickCamera.stickY, joystickCamera.stickRadius, 0, Math.PI * 2, true);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }
    if (attackButton != null && attackButton.isVisible()) {
        ctx.save();
        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = themeColor('ink', 'black');
        // Punch-red so it reads as the attack control (mirrors the move ring on
        // the left); brighten the fill while held for tap/charge feedback.
        ctx.fillStyle = attackButton.pressed ? "rgba(255, 72, 56, 0.5)" : "rgba(255, 72, 56, 0.26)";
        ctx.arc(attackButton.baseX, attackButton.baseY, attackButton.radius, 0, Math.PI * 2, false);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawTouchLabel("Attack", attackButton.baseX, attackButton.baseY + attackButton.radius + 20, ctx);
    }
    if (exitButton != null && exitButton.isVisible() && fullscreenSupported()) {
        var exitSize = exitButton.iconSize || 34;
        if (window.document.fullscreenElement) {
            ctx.save();
            ctx.drawImage(exitToUse, exitButton.baseX - exitSize / 2, exitButton.baseY - exitSize / 2, exitSize, exitSize);
            ctx.restore();
        } else {
            ctx.save();
            ctx.drawImage(fullScreenToUse, exitButton.baseX - exitSize / 2, exitButton.baseY - exitSize / 2, exitSize, exitSize);
            ctx.restore();
        }
        drawTouchLabel(window.document.fullscreenElement ? "Exit" : "Fullscreen", exitButton.baseX, exitButton.baseY + exitSize / 2 + 16, ctx);
    }
    if (chatButton != null && chatButton.isVisible()) {
        var chatSize = chatButton.iconSize || 34;
        ctx.save();
        ctx.drawImage(chatToUse, chatButton.baseX - chatSize / 2, chatButton.baseY - chatSize / 2, chatSize, chatSize);
        ctx.restore();
        drawTouchLabel("Emoji", chatButton.baseX, chatButton.baseY + chatSize / 2 + 16, ctx);
    }
}

// Surface the otherwise-invisible double-click "mouse-drive" mode so players can
// tell it's on (and how to toggle it). Desktop/mouse only (item 8).
function drawMouseDriveIndicator() {
    if (typeof movingByMouse === "undefined" || !movingByMouse || isTouchScreen) {
        return;
    }
    gameContext.save();
    gameContext.font = "bold 15px Arial";
    gameContext.textAlign = "center";
    gameContext.lineWidth = 4;
    // Theme-aware halo so the pink label reads on the dark board too.
    gameContext.strokeStyle = themeColor('inkOutline', 'white');
    gameContext.fillStyle = "#c87f8a";
    var label = "Mouse-drive ON — double-click to toggle";
    gameContext.strokeText(label, LOGICAL_WIDTH / 2, 44);
    gameContext.fillText(label, LOGICAL_WIDTH / 2, 44);
    gameContext.restore();
}

// Small caption under a touch control so mobile players know what it does.
function drawTouchLabel(text, x, y, ctx) {
    ctx = ctx || overlayContext;
    ctx.save();
    // The 1366x768 logical space is scaled down a lot on a phone, so a fixed
    // 16px label would render only a few CSS px tall. Size up as the fit ratio
    // shrinks to hold a roughly constant physical size (~15 CSS px), clamped so
    // it never goes below the original 16px or balloons on large displays.
    var fontPx = Math.round(Math.max(16, Math.min(40, 15 / (fitRatio || 1))));
    ctx.font = "bold " + fontPx + "px Arial";
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    // Theme-aware so the captions read correctly on the dark board too (matches
    // the rest of the renderer + the adjacent touch-control rings).
    ctx.strokeStyle = themeColor('inkOutline', 'white');
    ctx.fillStyle = themeColor('ink', 'black');
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
}

function drawTitle() {

    if (brutalRound == true) {
        // Time-based entrance (so it plays the same on any refresh rate):
        // a quick scale-in with a little overshoot, a hold, then a fade. A
        // single red screen flash fires the moment the card appears.
        if (brutalRoundConfig.titleStart == null) {
            brutalRoundConfig.titleStart = Date.now();
            spawnScreenFlash("red", 0.4, 350);
        }
        var e = Date.now() - brutalRoundConfig.titleStart;
        var inMs = 350, holdMs = 2200, outMs = 1500;
        if (e <= inMs + holdMs + outMs) {
            var alpha, scale;
            if (e < inMs) {
                var ip = e / inMs;
                scale = lerp(0.4, 1, easeOutBack(ip));
                alpha = clamp01(ip);
            } else if (e < inMs + holdMs) {
                scale = 1;
                alpha = 1;
            } else {
                var fp = (e - inMs - holdMs) / outMs;
                scale = 1 + 0.06 * fp;
                alpha = clamp01(1 - fp);
            }
            gameContext.save();
            gameContext.textAlign = "center";
            // HUD/screen pass: anchor in logical space so it stays centered and
            // crisp at any DPR (this runs after applyCanvasTransform, not under
            // the world camera zoom/pan).
            gameContext.translate(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2 - 10);
            gameContext.scale(scale, scale);
            gameContext.strokeStyle = "rgba(255, 255, 255, " + alpha + ")";
            gameContext.lineWidth = 10;
            gameContext.fillStyle = "rgba(255, 0, 0, " + alpha + ")";
            gameContext.font = "50px Arial";
            gameContext.strokeText('Brutal Round', 0, 0);
            gameContext.fillText('Brutal Round', 0, 0);
            var titleRows = [];
            for (var i = 0; i < brutalRoundConfig.brutalTypes.length; i++) {
                for (var prop in config.brutalRounds) {
                    if (config.brutalRounds[prop].id == brutalRoundConfig.brutalTypes[i]) {
                        titleRows.push({ title: config.brutalRounds[prop].title, id: brutalRoundConfig.brutalTypes[i] });
                    }
                }
            }
            gameContext.font = "30px Arial";
            for (var j = 0; j < titleRows.length; j++) {
                var ty = 40 + (35 * j);
                gameContext.strokeText(titleRows[j].title, 0, ty);
                gameContext.fillText(titleRows[j].title, 0, ty);
                // Mode icon hugging the left edge of the title text — same iconography as
                // the recap badges + the persistent corner badge — fading with the card.
                var tImg = brutalRoundImages[titleRows[j].id];
                if (tImg != null && tImg.complete !== false && (tImg.naturalWidth == null || tImg.naturalWidth > 0)) {
                    var tw = gameContext.measureText(titleRows[j].title).width;
                    var iratio = (tImg.width && tImg.height) ? (tImg.height / tImg.width) : 0.88;
                    var iw2 = 30, ih2 = 30 * iratio;
                    var ix2 = -tw / 2 - 12 - iw2;
                    var iy2 = ty - 14 - ih2 / 2;
                    gameContext.save();
                    gameContext.globalAlpha = alpha;
                    gameContext.fillStyle = "rgba(255,255,255,0.85)";
                    gameContext.fillRect(ix2 - 3, iy2 - 3, iw2 + 6, ih2 + 6);
                    gameContext.strokeStyle = "rgba(0,0,0,0.55)";
                    gameContext.lineWidth = 1.5;
                    gameContext.strokeRect(ix2 - 3, iy2 - 3, iw2 + 6, ih2 + 6);
                    try { gameContext.drawImage(tImg, ix2, iy2, iw2, ih2); } catch (e) { /* icon not decoded — tile still flags it */ }
                    gameContext.restore();
                }
            }
            gameContext.restore();
        }
    }
    if (currentState == config.stateMap.waiting && lobbyStartButton == null) {
        gameContext.save();
        gameContext.fillStyle = themeColor('ink', 'black');
        gameContext.lineWidth = 3;
        gameContext.font = "30px Arial";
        gameContext.fillText('Waiting for more players..', (LOGICAL_WIDTH / 2) - 200, (LOGICAL_HEIGHT / 2) - 25);
        gameContext.restore();
    }
}

function drawOverviewBoard() {
    drawBlackBackground();
    drawOldNotches();
    drawNextMap();
    drawMapLeaderboardCard();
    // Late-arriving PB floats — the last finisher's playerPbResult lands
    // AFTER startOverview because the server's per-finish upsert + rank lookup
    // are async. The world-space drawRecordFloats in the race pass never sees
    // them; this overview-context render catches them anchored to notch rows.
    drawRecordFloatsOverview();
    drawHUD();
}

// Format an elapsed-race time (milliseconds) as "m:ss.SS" — minutes are only
// shown when >0 so a typical sub-minute finish reads as "32.17".
function formatRaceTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) { return "—"; }
    var totalCs = Math.floor(ms / 10);
    var cs = totalCs % 100;
    var s = Math.floor(totalCs / 100) % 60;
    var m = Math.floor(totalCs / 6000);
    var csStr = (cs < 10 ? "0" : "") + cs;
    var sStr = (s < 10 ? "0" : "") + s;
    return (m > 0 ? (m + ":" + sStr) : sStr) + "." + csStr;
}

// "Times to beat for <next map>" — overview-screen card under the next-map
// preview. Renders the global top 10 PB times for the upcoming map. If no one
// has finished it yet (rows empty), shows "New map!" as a placeholder so the
// blank space still says something. Plain text on the overview's black
// backdrop — no card chrome.
function drawMapLeaderboardCard() {
    if (mapLeaderboardData == null) { return; }
    var rows = mapLeaderboardData.rows || [];
    var mapName = mapLeaderboardData.mapName || "this map";
    var listX = LOGICAL_WIDTH / 2 + 100;
    var listY = (LOGICAL_HEIGHT / 2 - (world.height / 10)) - 100 + (world.height / 3) + 28;
    var listW = world.width / 3;
    var headerH = 28;
    var rowH = 26;

    gameContext.save();
    gameContext.fillStyle = "white";
    gameContext.font = "bold 18px Arial";
    gameContext.textBaseline = "alphabetic";
    gameContext.textAlign = "left";
    gameContext.fillText("Times to beat for " + mapName, listX, listY + 18);

    if (rows.length === 0) {
        // Empty-state placeholder where the rows would go.
        gameContext.font = "italic 18px Arial";
        gameContext.fillStyle = "#9b5";
        gameContext.fillText("New map!", listX, listY + headerH + 22);
        gameContext.restore();
        return;
    }

    var nameColX = listX + 50;
    var timeColX = listX + listW - 12;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var rowY = listY + headerH + i * rowH;
        var isYou = (row.playerId === myID);
        gameContext.fillStyle = "white";
        gameContext.font = (isYou ? "bold " : "") + "16px Arial";
        gameContext.textAlign = "left";
        gameContext.fillText("#" + row.rank, listX, rowY + 18);
        // Anonymous rows render as "Anon" — short, neutral, and consistent
        // with how the WR banner and spectator widget label nameless racers.
        var label = row.displayName || "Anon";
        if (isYou) { label += " (YOU)"; }
        // Truncate names that would collide with the time column.
        var maxNameW = (timeColX - nameColX) - 20;
        var truncated = label;
        if (gameContext.measureText(label).width > maxNameW) {
            while (truncated.length > 1 && gameContext.measureText(truncated + "…").width > maxNameW) {
                truncated = truncated.slice(0, -1);
            }
            truncated += "…";
        }
        gameContext.fillText(truncated, nameColX, rowY + 18);
        gameContext.textAlign = "right";
        gameContext.fillText(formatRaceTime(row.bestMs), timeColX, rowY + 18);
    }
    gameContext.restore();
}

function drawNextMap() {
    if (nextMapPreview != null) {
        var previewWindow = { x: LOGICAL_WIDTH / 2 + 100, y: (LOGICAL_HEIGHT / 2 - (world.height / 10)) - 100 };
        gameContext.save();
        gameContext.beginPath();
        gameContext.fillStyle = "white";
        gameContext.lineWidth = 1;
        gameContext.font = "32px Arial";
        gameContext.fillText("Next map", previewWindow.x, previewWindow.y - 35);
        gameContext.font = "20px Arial";
        gameContext.fillText(nextMapPreview.name, previewWindow.x, previewWindow.y - 5);
        gameContext.fillText(nextMapPreview.author, previewWindow.x + 300, previewWindow.y - 5);
        gameContext.drawImage(nextMapThumbnail, previewWindow.x, previewWindow.y, world.width / 3, world.height / 3);
        gameContext.fill();
        gameContext.restore();
    }

}
function drawBlackBackground() {
    gameContext.save();
    gameContext.beginPath();
    gameContext.fillStyle = "black";
    gameContext.rect(world.x, world.y, world.width, world.height);
    gameContext.fill();
    gameContext.restore();
}
function drawOldNotches() {
    var count = 0;
    for (var player in playerList) {
        count++;
    }
    var distanceApart = 7;
    var offSetX = 80;
    var offSetY = LOGICAL_HEIGHT / 2 - (count * config.playerBaseRadius * distanceApart * .5);


    gameContext.save();
    gameContext.translate(offSetX, offSetY);
    for (var player in playerList) {
        if (playerAnimating == null) {
            playerAnimating = player;
        }
        drawNotches(notchDistanceApart);
        drawPlayerIcon(playerList[player], notchDistanceApart);
        drawGoalPost(playerList[player], notchDistanceApart);
        drawEmoji(playerList[player]);
        drawNotchDeltaFloat(playerList[player]);
        drawNotchInlineLeaderboard(playerList[player], notchDistanceApart);
        gameContext.translate(0, config.playerBaseRadius * distanceApart);
    }
    gameContext.restore();
}
function drawPlayerIcon(player, notchDistanceApart) {
    var notchX = 0;
    var moveAmt = 0;
    gameContext.beginPath();
    gameContext.shadowColor = player.color;
    gameContext.shadowBlur = 10;
    if (player.distanceToMove > 0) {
        moveAmt = 2;
        notchX = player.distanceTraveled + (oldNotches[player.id] * notchDistanceApart);
    } else if (player.distanceToMove < 0) {
        moveAmt = -2;
        notchX = player.distanceTraveled + (oldNotches[player.id] * notchDistanceApart);
    } else {
        notchX = player.notches * notchDistanceApart;
        playerAnimating = null;
    }
    drawScoreBoardTrail(notchX, player);
    drawFireOverview(notchX, player);
    //drawAbiltiesOverview(notchX, player);

    if (playerAnimating === player.id) {
        if (player.distanceToMove - moveAmt < 0 && player.distanceToMove + moveAmt > 0) {
            player.distanceToMove = 0;
        } else {
            player.distanceToMove -= moveAmt;
            player.distanceTraveled += moveAmt;
        }
    }

    player.x = notchX;
    player.y = 0;
    var iconRadius = config.playerBaseRadius * 2;
    // Match the in-game look: a skinned kart shows its procedural skin (tinted by the
    // player's colour) instead of the plain colour disc + ring. Heading falls back to
    // the kart's angle since overview icons are static.
    var iconPainter = cartSkinPainter(player.cartSkin);
    if (iconPainter != null) {
        // Fixed heading (face right, toward the finish) so the scoreboard icon doesn't
        // freeze at the kart's last racing angle.
        drawCartSkin(player, notchX, 0, iconRadius, iconPainter, 0);
    } else {
        gameContext.beginPath();
        gameContext.arc(notchX, 0, iconRadius, 0, 2 * Math.PI);
        gameContext.fillStyle = player.color;
        gameContext.fill();
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = 5;
        gameContext.strokeStyle = "black";
        gameContext.arc(notchX, 0, iconRadius, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.restore();
    }
}

function drawFireOverview(x, player) {
    if (player.onFire > 0) {
        gameContext.save();
        gameContext.shadowColor = "rgba(0, 0, 0, 0)";
        gameContext.translate(x - 5, 0);
        gameContext.rotate(-90 * (Math.PI / 180));
        drawFlameColor(player, 90);
        gameContext.restore();
    }
}
/*
function drawAbiltiesOverview(notchX, player) {
    if (player.ability == null) {
        return;
    }

    gameContext.save();
    drawAbilityIndicator(notchX, 0, player);
    gameContext.restore();
}
*/

function drawNotches(distanceApart) {
    gameContext.beginPath();
    for (var i = 0; i < gameLength + 1; i++) {
        gameContext.arc(i * distanceApart, 0, 2, 0, 2 * Math.PI);
    }
    gameContext.fillStyle = "grey";
    gameContext.fill();
}

function drawScoreBoardTrail(x, player) {
    gameContext.save();
    gameContext.beginPath();
    gameContext.moveTo(0, 0);
    gameContext.lineTo(x, 0);
    gameContext.lineWidth = 10;
    gameContext.shadowBlur = 3;
    gameContext.shadowColor = player.color;
    gameContext.strokeStyle = player.color;
    if (player.nearVictory == true) {
        gameContext.setLineDash([20, 3, 3, 3, 3, 3, 3, 3]);
    } else {
        gameContext.setLineDash([]);
    }

    gameContext.stroke();
    gameContext.arc(0, 0, 8, 0, 2 * Math.PI);
    gameContext.fillStyle = player.color;
    gameContext.fill();
    gameContext.restore();
}
function drawGoalPost(player, distanceApart) {
    gameContext.beginPath();

    gameContext.rect(-15 + (gameLength + 1) * distanceApart, -15, 30, 30);
    gameContext.shadowColor = "gold";
    gameContext.fillStyle = "gold";
    gameContext.lineWidth = 1;
    gameContext.font = "40px Arial";
    if (player.firstPlace == true) {
        gameContext.fillText("🥇", 30 + (gameLength + 1) * distanceApart, 12.5);
    }
    gameContext.shadowColor = "silver";
    gameContext.fillStyle = "silver";
    if (player.secondPlace == true) {
        gameContext.fillText("🥈", 30 + (gameLength + 1) * distanceApart, 12.5);
    }
    gameContext.shadowColor = "red";
    gameContext.fillStyle = "red";
    if (player.downRank == true) {
        gameContext.fillText("💀", 30 + (gameLength + 1) * distanceApart, 12.5);
    }

    gameContext.fillStyle = "black";

    if (player.distanceToMove == 0 && playerAnimating !== player.id) {
        //Animation complete

        if (player.notches == gameLength) {
            if (player.nearVictory == false) {
                player.nearVictory = true;
                playSound(nearVictorySound);
            }
        }

        if (player.nearVictory == true) {
            gameContext.shadowColor = "gold";
            gameContext.shadowBlur = 10;
            gameContext.fillStyle = "gold";
            gameContext.fill();
        }
    }

    if (player.distanceToMove != 0 && playerAnimating === player.id) {
        //Animation occuring
        if (oldNotches[player.id] == gameLength && player.notches != gameLength) {
            if (player.nearVictory == true) {
                player.nearVictory = false;
                playSound(fallFromVictorySound);
            }
        }
    }
    if (player.distanceToMove != 0 && playerAnimating !== player.id) {
        //Animation pending
        if (oldNotches[player.id] == gameLength) {
            gameContext.shadowColor = "gold";
            gameContext.shadowBlur = 10;
            gameContext.fillStyle = "gold";
            gameContext.fill();
        }
    }
    gameContext.shadowColor = "grey";
    gameContext.strokeStyle = "grey";
    gameContext.fill();

}

// Small rising/fading "+2"/"+1"/"−1" above a player's notch icon on the standings
// board, showing how their score changed this round. Drawn in the same translated
// row space as drawPlayerIcon (so player.x is the icon's current track position),
// after the icon/emoji so it sits on top. Driven off notchFloatStart, set on
// overview entry; once the window elapses nothing draws, so a resize/redraw of the
// board won't replay it and it resets cleanly each round.
// Per-notch-row inline leaderboard tag — "#3  32.17" rendered just past the
// goal post on each player's notch row, sourced from mapLeaderboardJustPlayed.
// Lets the last finisher (who gets ~no overview time before the next round
// starts) still see how they landed on the map they just played. Local-player
// row is bolded. No tag for guests/bots or for logged-in players with no PB.
function drawNotchInlineLeaderboard(player, distanceApart) {
    if (mapLeaderboardJustPlayed == null || !mapLeaderboardJustPlayed.rows) { return; }
    if (player == null || !player.id) { return; }
    var row = null;
    var rows = mapLeaderboardJustPlayed.rows;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].playerId === player.id) { row = rows[i]; break; }
    }
    if (row == null) { return; }
    var x = (gameLength + 1) * distanceApart + 40; // just past the goal post
    var isYou = (player.id === myID);
    gameContext.save();
    gameContext.textBaseline = "middle";
    gameContext.textAlign = "left";
    gameContext.fillStyle = "white";
    gameContext.font = (isYou ? "bold " : "") + "16px Arial";
    gameContext.fillText("#" + row.rank, x, 0);
    gameContext.fillText(formatRaceTime(row.bestMs), x + 50, 0);
    gameContext.restore();
}

function drawNotchDeltaFloat(player) {
    var delta = player.deltaNotches;
    // !delta rejects 0, NaN, null and undefined in one go — NaN can slip in if a
    // playerList id is missing from the round's notchUpdates (a join/leave race),
    // and rendering "−NaN" would be worse than just skipping the float.
    if (!delta || notchFloatStart == null) {
        return;
    }
    var elapsed = Date.now() - notchFloatStart;
    if (elapsed < 0 || elapsed > NOTCH_FLOAT_DURATION) {
        return;
    }
    var t = elapsed / NOTCH_FLOAT_DURATION; // 0..1 across the float's lifetime

    // Pop in fast, hold, then fade — so it reads as a quick celebratory cue.
    var alpha;
    if (t < 0.15) {
        alpha = t / 0.15;
    } else if (t > 0.6) {
        alpha = Math.max(0, (1 - t) / 0.4);
    } else {
        alpha = 1;
    }

    // Ease-out rise above the icon, tracking it as the notch-fill animates.
    var rise = 34 * (1 - Math.pow(1 - t, 2));
    var baseY = -(config.playerBaseRadius * 2 + 8) - rise;

    var label = (delta > 0 ? "+" : "−") + Math.abs(delta);
    // +2 = gold (the round win), +1 = green, a lost notch = red.
    var fill = delta < 0 ? "#ff5a5a" : (delta >= 2 ? "#ffd54a" : "#5be36a");

    gameContext.save();
    gameContext.globalAlpha = alpha;
    gameContext.font = "bold 26px Arial";
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    // Dark outline + matching glow so it stays legible on the black overview backdrop.
    gameContext.lineWidth = 4;
    gameContext.strokeStyle = "rgba(0, 0, 0, 0.85)";
    gameContext.shadowColor = fill;
    gameContext.shadowBlur = 8;
    gameContext.strokeText(label, player.x, baseY);
    gameContext.fillStyle = fill;
    gameContext.fillText(label, player.x, baseY);
    gameContext.restore();
}

function createFirstRankSymbol(playerid) {
    var player = playerList[playerid];
    player.firstPlace = true;
    for (var prop in playerList) {
        if (playerid == prop) {
            continue;
        }
        playerList[prop].firstPlace = false;
    }
}
function createSecondRankSymbol(playerid) {
    var player = playerList[playerid];
    player.secondPlace = true;
    for (var prop in playerList) {
        if (playerid == prop) {
            continue;
        }
        playerList[prop].secondPlace = false;
    }
}
function createDownRankSymbol(playerid) {
    var player = playerList[playerid];
    player.downRank = true;
}

function resetPlayerRanks() {
    for (var prop in playerList) {
        playerList[prop].downRank = false;
        playerList[prop].secondPlace = false;
        playerList[prop].firstPlace = false;
    }
}
function calculateNotchMoveAmt() {
    notchDistanceApart = 75;//gameLength * 20;
    for (var id in playerList) {
        playerList[id].deltaNotches = playerList[id].notches - oldNotches[id];
        playerList[id].distanceToMove = playerList[id].deltaNotches * notchDistanceApart;
        playerList[id].distanceTraveled = 0;
    }
    // Arm the rising "+N"/"−1" floats for this round's standings board.
    notchFloatStart = Date.now();
}
function getBbox(cell) {
    var halfedges = cell.halfedges,
        iHalfedge = halfedges.length,
        xmin = Infinity,
        ymin = Infinity,
        xmax = -Infinity,
        ymax = -Infinity,
        v, vx, vy;
    while (iHalfedge--) {
        v = getStartpoint(halfedges[iHalfedge]);
        vx = v.x;
        vy = v.y;
        if (vx < xmin) { xmin = vx; }
        if (vy < ymin) { ymin = vy; }
        if (vx > xmax) { xmax = vx; }
        if (vy > ymax) { ymax = vy; }
    }
    return {
        x: xmin,
        y: ymin,
        width: xmax - xmin,
        height: ymax - ymin
    };
};

function cameraOnMyPlayer() {
    if (myPlayer != null) {
        recenterCamera(myPlayer);
    }
}

function recenterCamera(object) {
    camera.centerOnObject(object);
    camera.draw();
}
class SpriteSheet {
    constructor(image, x, y, frameWidth, frameHeight, rows, columns, loopAnimation) {
        this.image = image;
        this.x = x;
        this.y = y;
        this.frameWidth = frameWidth;
        this.frameHeight = frameHeight;
        this.frameIndex = [[], []];
        this.rows = rows;
        this.columns = columns;

        this.frameRate = 24;
        this.ticksPerFrame = 1 / this.frameRate;
        this.ticks = 0;
        this.loopAnimation = loopAnimation;
        this.animationComplete = false;

        for (var i = 0; i < rows; i++) {
            this.frameIndex[i] = [];
            for (var j = 0; j < columns; j++) {
                this.frameIndex[i][j] = { sx: j * frameWidth, sy: i * frameHeight };

            }
        }
        this.XframeIndex = 0;
        this.YframeIndex = 0;
    }
    move(x, y) {
        this.x = x;
        this.y = y;
    }
    changeFrame(x, y) {
        this.XframeIndex = x;
        this.YframeIndex = y;
    }
    update(dt) {
        this.ticks += dt / 1000;
        if (this.ticks > this.ticksPerFrame) {
            this.ticks = 0;
            if (this.XframeIndex < this.rows - 1) {
                this.XframeIndex += 1;
                return;
            }
            if (this.loopAnimation) {
                this.XframeIndex = 0;
            }
            else {
                this.animationComplete = true;
            }
        }
    }
    draw(width, height) {
        gameContext.drawImage(this.image, this.frameIndex[this.XframeIndex][this.YframeIndex].sx, this.frameIndex[this.XframeIndex][this.YframeIndex].sy, this.frameWidth, this.frameHeight, this.x - (width / 2), this.y - (height / 2), width, height);
    }
}



