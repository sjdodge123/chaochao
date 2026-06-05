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
var starIcon = new Image(576, 512);
starIcon.src = "../assets/img/star-solid.svg";

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
// Throttle full map-cache re-bakes (see drawMap). A collapse streams tile changes
// roughly every server tick; without this the whole world-sized cache re-bakes +
// re-uploads up to 60×/s. Coalesce to ~25×/s — terrain lags a change by at most
// this interval (imperceptible; karts/effects still render every frame). A
// discarded cache (mapCanvas == null, e.g. perf-tier change) re-bakes immediately.
var MAP_BAKE_MIN_MS = 40;
var lastMapBakeAt = 0;
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
// Resolve any CSS colour (palette name/hex/colour-blind remap) to {r,g,b}.
// Pure-JS parse first (tfxParseColorFast, trailEffects.js) — the old paint-one-
// pixel-and-read-it-back trick forced a synchronous GPU flush per NEW colour,
// which made every 🎲 randomize hitch. Readback only remains as the fallback for
// exotic colour strings, on one persistent canvas. Cached per colour as before.
var _cartSkinRGB = {};
var _cartSkinParseCv = null;
function cartSkinRGB(color) {
    if (_cartSkinRGB[color] != null) {
        return _cartSkinRGB[color];
    }
    var rgb = (typeof tfxParseColorFast === "function") ? tfxParseColorFast(color) : null;
    if (rgb == null) {
        if (_cartSkinParseCv == null) {
            _cartSkinParseCv = document.createElement("canvas");
            _cartSkinParseCv.width = _cartSkinParseCv.height = 1;
        }
        var cx = _cartSkinParseCv.getContext("2d", { willReadFrequently: true });
        cx.fillStyle = "#000";   // fallback if `color` is invalid
        cx.fillStyle = color;
        cx.fillRect(0, 0, 1, 1);
        var d = cx.getImageData(0, 0, 1, 1).data;
        rgb = { r: d[0], g: d[1], b: d[2] };
    }
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

// HSL <-> RGB + complementary-hue accent. cartComp(color, amt) rotates the hue 180° for a
// vivid CONTRAST against the primary colour, then mixes toward white(amt>0)/black(amt<0) like
// cartSkinShade. For desaturated primaries (white/gray/black) a complementary hue is useless,
// so it falls back to a luminance flip — guaranteeing the pattern mark always stands out.
function _rgbToHsl(r, g, b) {
    r/=255; g/=255; b/=255; var mx=Math.max(r,g,b), mn=Math.min(r,g,b), h, sat, l=(mx+mn)/2;
    if (mx===mn) { h=0; sat=0; } else { var d=mx-mn; sat=l>0.5?d/(2-mx-mn):d/(mx+mn);
        if (mx===r) h=(g-b)/d+(g<b?6:0); else if (mx===g) h=(b-r)/d+2; else h=(r-g)/d+4; h/=6; }
    return [h, sat, l];
}
function _hslToRgb(h, sat, l) {
    if (sat===0) { var v=Math.round(l*255); return [v,v,v]; }
    function h2(p,q,t){ if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; }
    var q=l<0.5?l*(1+sat):l+sat-l*sat, pp=2*l-q;
    return [Math.round(h2(pp,q,h+1/3)*255), Math.round(h2(pp,q,h)*255), Math.round(h2(pp,q,h-1/3)*255)];
}
function cartCompRGB(color) {
    var c=cartSkinRGB(color), hsl=_rgbToHsl(c.r,c.g,c.b);
    if (hsl[1] < 0.12) { var v=hsl[2]>0.5?38:222; return {r:v,g:v,b:v}; } // gray/white/black -> luminance flip
    var rgb=_hslToRgb((hsl[0]+0.5)%1, Math.max(0.55,hsl[1]), Math.min(0.62,Math.max(0.42,hsl[2])));
    return {r:rgb[0], g:rgb[1], b:rgb[2]};
}
function cartComp(color, amt) {
    var c=cartCompRGB(color); amt=amt||0; var t=amt<0?0:255, f=amt<0?-amt:amt;
    return "rgb("+Math.round(c.r+(t-c.r)*f)+","+Math.round(c.g+(t-c.g)*f)+","+Math.round(c.b+(t-c.b)*f)+")";
}
function cartCompA(color, amt, alpha) {
    var c=cartCompRGB(color); amt=amt||0; var t=amt<0?0:255, f=amt<0?-amt:amt;
    return "rgba("+Math.round(c.r+(t-c.r)*f)+","+Math.round(c.g+(t-c.g)*f)+","+Math.round(c.b+(t-c.b)*f)+","+alpha+")";
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
    // Delegate to the cosmetics registry (resolves all ported cart bodies). Fallback to the
    // built-ins if the registry isn't loaded yet (bundled after draw.js, but this runs at
    // render time so the registry is normally present).
    if (typeof getSkinPainter === "function" && name) { return getSkinPainter(name); }
    if (name === "firetruck") { return drawFiretruckSkin; }
    if (name === "dino") { return drawDinoSkin; }
    return null;
}
// Draw a kart's core appearance (skin or plain colour disc) centred at screen
// (sx,sy). No highlights/avatar/FX — just the body — so callers like the ice
// reflection get a faithful, skin-aware image for any current or future skin.
function drawKartAppearance(player, sx, sy, headingOverride) {
    // Two INDEPENDENT body cosmetics: the BORDER (player.border) rings ANY cart from behind,
    // and the PATTERN (player.pattern) textures the plain sphere only. Both can be equipped at
    // once. Border FIRST — it rings from BEHIND so the cart body always sits on top (only the
    // rim past the body shows).
    var painter = cartSkinPainter(player.cart);
    var bid = player.border;
    var bskin = (typeof getSkin === "function" && bid) ? getSkin(bid) : null;
    if (bskin && bskin.slot === 'border') {
        var bp = (typeof getSkinPainter === "function") ? getSkinPainter(bid) : null;
        // Shaped carts render CART_SKIN_VISUAL_SCALE larger than the physics radius,
        // so the border ring scales with them or its inner edge would be swallowed.
        var br = player.radius * (painter != null ? CART_SKIN_VISUAL_SCALE : 1);
        if (bp != null) { drawBorderOverlay(player, sx, sy, br, bp); }
    }
    if (painter != null) {
        drawCartSkin(player, sx, sy, player.radius, painter, headingOverride);
    } else {
        var sprite = getPlayerSprite(player.color, player.radius, null);
        if (sprite != null) {
            gameContext.drawImage(sprite, sx - sprite.halfSize, sy - sprite.halfSize);
        }
        // Pattern overlay on the plain sphere cart (patterns are scoped to the sphere). Drawn
        // here in the shared chokepoint, so it shows in every kart path (live, overview, recap).
        var pid = player.pattern;
        var pskin = (typeof getSkin === "function" && pid) ? getSkin(pid) : null;
        if (pskin && pskin.slot === 'pattern') {
            var patPainter = (typeof getSkinPainter === "function") ? getSkinPainter(pid) : null;
            if (patPainter != null) {
                drawPatternOverlay(player, sx, sy, player.radius, patPainter);
            }
        }
    }
}

// Shaped cart bodies render 20% larger than the physics radius so they read
// slightly bigger than the base sphere cart. Pure presentation: the server's
// collision radius is untouched (the client never feeds this back). Applied at
// the drawCartSkin chokepoint so every path (live racing, overview scoreboard,
// lava-burn, recap, ice reflection) agrees on the size.
var CART_SKIN_VISUAL_SCALE = 1.2;

function drawCartSkin(player, centerX, centerY, radius, painter, headingOverride) {
    var ctx = gameContext;
    // headingOverride pins the skin to a fixed angle (used by the overview scoreboard, a
    // static display — otherwise it'd freeze at whatever heading the kart had when the
    // race ended). A pinned heading also implies an idle pose (no movement-driven anim).
    var pinned = (typeof headingOverride === "number");
    var heading = pinned ? headingOverride : getCartHeading(player);
    var speed = pinned ? 0 : getCartSpeed(player);
    // STATUE carts (clocks, 8-ball, lucky cat, …) are drawn UPRIGHT — they skip the heading
    // rotation; their heading-tracking features read `heading` (4th painter arg) instead.
    var skin = (typeof getSkin === "function" && player && player.cart) ? getSkin(player.cart) : null;
    var statue = !!(skin && skin.statue);
    // Frozen painters animate off real elapsed seconds, but keep the existing speed-driven
    // wheel-spin feel for the original carts; both are fine, so retain the speed scaling.
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
    if (!statue) { ctx.rotate(heading); }
    ctx.scale(radius * CART_SKIN_VISUAL_SCALE, radius * CART_SKIN_VISUAL_SCALE);
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
    // Contract: painter(ctx, anim, paint, heading, hot). The frozen carts read `heading`
    // (4th); the original firetruck/dino read `hot` (5th) for their burn glow. The hot-orange
    // paint tint above already applies to every cart.
    painter(ctx, anim, paint, heading, !!(player && player.onFire > 0));
    ctx.restore();
}

// Pattern overlay: paints the equipped pattern's texture (tinted to player colour) on the
// kart, clipped to a disc so it stays on the body. Patterns are scoped to the plain sphere
// cart (callers only invoke this when no cart shape is equipped). Reads a per-pattern
// `opacity` from the registry (Phase P) so opaque full-repaint patterns let the body show.
function drawPatternOverlay(player, centerX, centerY, radius, painter) {
    var ctx = gameContext;
    var anim = cartSkinAnimTime;
    var pskin = (typeof getSkin === "function" && player && player.pattern) ? getSkin(player.pattern) : null;
    var op = (pskin && typeof pskin.opacity === "number") ? pskin.opacity : 1;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(radius, radius);
    ctx.beginPath();
    ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
    ctx.clip();
    if (op !== 1) { ctx.globalAlpha = op; }
    painter(ctx, anim, (player && player.color) ? player.color : null);
    ctx.restore();
}

// Border overlay: paints the equipped border cosmetic AROUND the kart rim (r ~1.0..1.4),
// tinted to the player colour. Unlike patterns, borders draw OUTSIDE the rim (no disc clip)
// and compose over ANY cart (shaped body or the plain sphere), so there's NO heading rotate
// (borders are radial) and NO clip. Borders share the 2nd cosmetic slot with patterns and
// are disambiguated at the call sites via getSkin(id).slot === 'border'.
function drawBorderOverlay(player, centerX, centerY, radius, painter) {
    var ctx = gameContext;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(radius, radius);                 // NO clip (border draws outside the rim),
    painter(ctx, cartSkinAnimTime, (player && player.color) ? player.color : null); // NO heading rotate
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

function drawFiretruckSkin(ctx, anim, paint, heading, hot) {
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

function drawDinoSkin(ctx, anim, paint, heading, hot) {
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
// rgba twin of cartSkinShade (glows/auras) — used by the ported frozen cart painters.
function cartSkinShadeA(color, amt, a) {
    var c = cartSkinRGB(color);
    var t = amt < 0 ? 0 : 255;
    var f = amt < 0 ? -amt : amt;
    return "rgba(" + Math.round(c.r + (t - c.r) * f) + "," + Math.round(c.g + (t - c.g) * f) + "," + Math.round(c.b + (t - c.b) * f) + "," + a + ")";
}

// === Cart bodies — FROZEN approved painters ported from the carts asset-design session
// (docs/asset-prototypes/carts.painters.js, 2026-05-30). Contract:
// drawXxxSkin(ctx, anim, paint, heading, hot) — anim=seconds, paint=player colour (already
// hot-tinted by drawCartSkin while on fire), heading=travel radians (only heading-tracking
// carts read it), hot unused by these. drawCartSkin handles statue (upright) carts via the
// registry flags. PARAMS defaults inlined. cartPolyPath ships with this block.
// --- 1. Hoverbike (Lv24, epic, cosmic) --------------------------------------
// Sleek single-rider hover-bike: low elongated teardrop hull, narrow waist, a
// tinted canopy bubble over the rider, twin rear thrusters with a pulsing glow,
// and a soft hover underglow shadow. No wheels (it floats).
function drawHoverbikeSkin(ctx, anim, paint) {
  paint = paint || "#5ad0ff";
  var len = (0.86);   // nose reach (+X)
  var glow = (0.62);
  var pulse = 0.5 + 0.5 * Math.sin(anim * 5);

  // Hover underglow (soft elliptical shadow/cushion under the hull).
  ctx.save();
  var ug = ctx.createRadialGradient(0, 0.06, 0.1, 0, 0.06, len * 0.95);
  ug.addColorStop(0, cartSkinShadeA(paint, 0.2, 0.30));
  ug.addColorStop(1, cartSkinShadeA(paint, 0.2, 0));
  ctx.fillStyle = ug;
  ctx.beginPath(); ctx.ellipse(-0.05, 0.06, len * 0.95, 0.46, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Twin thruster glow plume (behind the hull, -X).
  ctx.save();
  for (var t = -1; t <= 1; t += 2) {
    var gy = t * 0.16;
    var pl = ctx.createRadialGradient(-len * 0.78, gy, 0.01, -len * 0.78 - 0.42, gy, 0.42);
    pl.addColorStop(0, cartSkinShadeA(paint, 0.55, 0.55 * glow + 0.25 * glow * pulse));
    pl.addColorStop(0.5, cartSkinShadeA(paint, 0.35, 0.28 * glow));
    pl.addColorStop(1, cartSkinShadeA(paint, 0.35, 0));
    ctx.fillStyle = pl;
    ctx.beginPath();
    ctx.ellipse(-len * 0.9 - 0.18, gy, 0.4 + 0.12 * pulse, 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Main hull — elongated teardrop: pointed nose (+X), pinched tail (-X).
  ctx.beginPath();
  ctx.moveTo(len, 0);                                  // nose tip
  ctx.bezierCurveTo(len * 0.55, -0.34, 0.1, -0.36, -0.4, -0.26);
  ctx.bezierCurveTo(-len * 0.72, -0.18, -len * 0.82, -0.1, -len * 0.82, 0);
  ctx.bezierCurveTo(-len * 0.82, 0.1, -len * 0.72, 0.18, -0.4, 0.26);
  ctx.bezierCurveTo(0.1, 0.36, len * 0.55, 0.34, len, 0);
  ctx.closePath();
  var hull = ctx.createLinearGradient(0, -0.36, 0, 0.36);
  hull.addColorStop(0, cartSkinShade(paint, 0.32));    // top sheen
  hull.addColorStop(0.5, paint);
  hull.addColorStop(1, cartSkinShade(paint, -0.34));   // shaded belly
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.05; ctx.stroke();

  // Forward fairing fins (small swept side blades near the nose).
  ctx.fillStyle = cartSkinShade(paint, -0.18);
  for (var f = -1; f <= 1; f += 2) {
    ctx.beginPath();
    ctx.moveTo(0.34, f * 0.24);
    ctx.lineTo(0.66, f * 0.5);
    ctx.lineTo(0.52, f * 0.22);
    ctx.closePath(); ctx.fill();
  }

  // Dorsal spine line.
  ctx.strokeStyle = cartSkinShade(paint, 0.4); ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.moveTo(-len * 0.6, 0); ctx.lineTo(len * 0.5, 0); ctx.stroke();

  // Canopy bubble over rider (tinted glass, toward front-centre).
  ctx.beginPath(); ctx.ellipse(0.16, 0, 0.3, 0.17, 0, 0, Math.PI * 2);
  var glass = ctx.createLinearGradient(0, -0.17, 0, 0.17);
  glass.addColorStop(0, "rgba(220,245,255,0.95)");
  glass.addColorStop(1, cartSkinShadeA(paint, -0.2, 0.7));
  ctx.fillStyle = glass; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.03; ctx.stroke();

  // Thruster nozzles (dark rings at the tail).
  for (var n = -1; n <= 1; n += 2) {
    ctx.beginPath(); ctx.arc(-len * 0.8, n * 0.16, 0.1, 0, Math.PI * 2);
    ctx.fillStyle = "#15171c"; ctx.fill();
    ctx.beginPath(); ctx.arc(-len * 0.8, n * 0.16, 0.05, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShadeA(paint, 0.6, 0.5 + 0.5 * pulse); ctx.fill();
  }
}

// --- 2. Starfighter (Lv30, legendary, cosmic capstone) ----------------------
// Swept-wing space fighter: long dagger fuselage with a sharp nose (+X), big
// swept-back delta wings, a glowing cockpit canopy, twin engine bells at the
// tail with an animated flaming glow, and blinking wingtip nav lights.
function drawStarfighterSkin(ctx, anim, paint) {
  paint = paint || "#b08bff";
  var sweep = (0.58); // 0=straight,1=hard swept
  var glow = (0.70);
  var flick = 0.7 + 0.3 * Math.sin(anim * 14) * Math.sin(anim * 5.3);
  var wingBackX = -0.2 - 0.45 * sweep;   // how far the wing trailing edge sweeps back

  // Engine exhaust plumes (behind, -X), animated.
  ctx.save();
  for (var e = -1; e <= 1; e += 2) {
    var ey = e * 0.17;
    var fl = ctx.createLinearGradient(-0.82, ey, -1.05 - 0.25 * flick, ey);
    fl.addColorStop(0, cartSkinShadeA(paint, 0.7, 0.9 * glow));
    fl.addColorStop(0.4, cartSkinShadeA(paint, 0.5, 0.55 * glow * flick));
    fl.addColorStop(1, cartSkinShadeA(paint, 0.5, 0));
    ctx.fillStyle = fl;
    ctx.beginPath();
    ctx.moveTo(-0.82, ey - 0.1);
    ctx.lineTo(-1.06 - 0.28 * flick, ey);
    ctx.lineTo(-0.82, ey + 0.1);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // Swept delta wings (drawn under the fuselage).
  ctx.beginPath();
  ctx.moveTo(0.18, 0.12);                 // wing root front
  ctx.lineTo(0.46, 0.16);                 // leading edge out
  ctx.lineTo(wingBackX, 0.92);            // swept wingtip
  ctx.lineTo(wingBackX - 0.16, 0.9);
  ctx.lineTo(-0.34, 0.16);                // trailing root
  ctx.closePath();
  ctx.moveTo(0.18, -0.12);
  ctx.lineTo(0.46, -0.16);
  ctx.lineTo(wingBackX, -0.92);
  ctx.lineTo(wingBackX - 0.16, -0.9);
  ctx.lineTo(-0.34, -0.16);
  ctx.closePath();
  var wingGrad = ctx.createLinearGradient(0.4, 0, wingBackX, 0.9);
  wingGrad.addColorStop(0, cartSkinShade(paint, -0.05));
  wingGrad.addColorStop(1, cartSkinShade(paint, -0.4));
  ctx.fillStyle = wingGrad;
  ctx.fill("evenodd");
  ctx.strokeStyle = cartSkinShade(paint, -0.55); ctx.lineWidth = 0.04; ctx.stroke();

  // Wing leading-edge accent stripes (bright hue).
  ctx.strokeStyle = cartSkinShade(paint, 0.45); ctx.lineWidth = 0.035;
  for (var w = -1; w <= 1; w += 2) {
    ctx.beginPath(); ctx.moveTo(0.44, w * 0.16); ctx.lineTo(wingBackX + 0.02, w * 0.88); ctx.stroke();
  }

  // Fuselage — long dagger with sharp nose.
  ctx.beginPath();
  ctx.moveTo(1.0, 0);                      // nose tip
  ctx.lineTo(0.5, -0.15);
  ctx.lineTo(-0.7, -0.2);
  ctx.lineTo(-0.86, -0.13);
  ctx.lineTo(-0.86, 0.13);
  ctx.lineTo(-0.7, 0.2);
  ctx.lineTo(0.5, 0.15);
  ctx.closePath();
  var fus = ctx.createLinearGradient(0, -0.2, 0, 0.2);
  fus.addColorStop(0, cartSkinShade(paint, 0.35));
  fus.addColorStop(0.5, paint);
  fus.addColorStop(1, cartSkinShade(paint, -0.32));
  ctx.fillStyle = fus; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.55); ctx.lineWidth = 0.045; ctx.stroke();

  // Nose accent + centre spine.
  ctx.fillStyle = cartSkinShade(paint, -0.4);
  ctx.beginPath(); ctx.moveTo(1.0, 0); ctx.lineTo(0.62, -0.06); ctx.lineTo(0.62, 0.06); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, 0.4); ctx.lineWidth = 0.025;
  ctx.beginPath(); ctx.moveTo(-0.6, 0); ctx.lineTo(0.55, 0); ctx.stroke();

  // Cockpit canopy (glowing).
  ctx.beginPath(); ctx.ellipse(0.28, 0, 0.22, 0.12, 0, 0, Math.PI * 2);
  var can = ctx.createLinearGradient(0.28, -0.12, 0.28, 0.12);
  can.addColorStop(0, "rgba(225,245,255,0.97)");
  can.addColorStop(1, cartSkinShadeA(paint, 0.1, 0.85));
  ctx.fillStyle = can; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.025; ctx.stroke();

  // Twin engine bells at the tail.
  for (var b = -1; b <= 1; b += 2) {
    ctx.beginPath(); ctx.arc(-0.84, b * 0.17, 0.11, 0, Math.PI * 2);
    ctx.fillStyle = "#16181e"; ctx.fill();
    ctx.beginPath(); ctx.arc(-0.84, b * 0.17, 0.06, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShadeA(paint, 0.7, 0.6 + 0.4 * flick); ctx.fill();
  }

  // Blinking wingtip nav lights.
  var blink = (Math.sin(anim * 6) > 0) ? 1 : 0.15;
  for (var L = -1; L <= 1; L += 2) {
    ctx.beginPath(); ctx.arc(wingBackX - 0.06, L * 0.9, 0.05, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShadeA(paint, 0.75, blink); ctx.fill();
  }
}

// --- 3. Golden Champion (achievement) ---------------------------------------
// A golden LUCKY-CAT STATUE (maneki-neko), seen top-down and facing "up" (-Y).
// It is cast in polished gold (champion prestige), with the player's colour as
// the bib/collar + koban accent so each player's statue is still tellable apart.
// TWO things make this cart special vs. the others:
//   1. It is a STATUE: it does NOT spin to face travel. It always stands upright.
//   2. Its eyes (and the raised beckoning paw) TRACK the player's movement —
//      the pupils slide toward the heading direction, so the cat "looks where
//      you're going".
// Because of that it needs the heading: signature is (ctx, anim, paint, heading)
// where `heading` is the travel angle in RADIANS (0 = +X / east). PORT NOTE for
// the main session: drawCartSkin must, for this skin only, SKIP the heading
// rotation and pass `heading` through as the 4th arg (the other painters ignore
// a 4th arg, so this is backward-compatible). See STATUE_CARTS in carts.painters.js.
var GOLD = "#ffd84d", GOLD_HI = "#fff3b0", GOLD_DK = "#9c7414";
// Vertical polished-gold fill (top-lit), with a slow travelling specular streak.
function goldStatueFill(ctx, anim, y0, y1, sheen) {
  var g = ctx.createLinearGradient(0, y0, 0, y1);
  var streak = 0.5 + 0.42 * Math.sin(anim * 0.8);   // 0.08..0.92 drifting hotspot
  g.addColorStop(0, GOLD_HI);
  g.addColorStop(Math.max(0.02, streak - 0.12), GOLD);
  g.addColorStop(streak, "rgba(255,252,222," + (0.85 + 0.15 * sheen) + ")");
  g.addColorStop(Math.min(0.98, streak + 0.12), GOLD);
  g.addColorStop(1, GOLD_DK);
  return g;
}
function drawGoldenChampionSkin(ctx, anim, paint, heading) {
  paint = paint || "#c0182b";
  if (typeof heading !== "number") heading = 0;
  var pawWave = (0.60);   // beckon speed/throw
  var sheen = (0.55);
  // Where the cat is "looking" — the heading direction in the statue's local space.
  var lookX = Math.cos(heading), lookY = Math.sin(heading);

  // Soft gold floor-glow under the statue (sells "object sitting on the track").
  var floor = ctx.createRadialGradient(0, 0.12, 0.1, 0, 0.12, 0.95);
  floor.addColorStop(0, "rgba(255,216,77,0.22)");
  floor.addColorStop(1, "rgba(255,216,77,0)");
  ctx.fillStyle = floor;
  ctx.beginPath(); ctx.ellipse(0, 0.12, 0.92, 0.78, 0, 0, Math.PI * 2); ctx.fill();

  // Curled tail (gold), resting around the right side of the body.
  ctx.save();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.15; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0.42, 0.34);
  ctx.quadraticCurveTo(0.78, 0.3, 0.74, -0.04);
  ctx.stroke();
  ctx.strokeStyle = GOLD; ctx.lineWidth = 0.09;
  ctx.beginPath();
  ctx.moveTo(0.42, 0.34);
  ctx.quadraticCurveTo(0.78, 0.3, 0.74, -0.04);
  ctx.stroke();
  ctx.restore();

  // Resting left paw at the base.
  ctx.fillStyle = GOLD; ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.ellipse(-0.26, 0.46, 0.14, 0.1, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // ---- Body (sitting, pear shape, gold) ----
  ctx.beginPath(); ctx.ellipse(0, 0.16, 0.5, 0.46, 0, 0, Math.PI * 2);
  ctx.fillStyle = goldStatueFill(ctx, anim, -0.3, 0.62, sheen); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.04; ctx.stroke();

  // Player-colour bib/chest oval (the tint that identifies the owner).
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0, 0.2, 0.3, 0.3, 0, 0, Math.PI * 2); ctx.clip();
  var bib = ctx.createLinearGradient(0, -0.1, 0, 0.5);
  bib.addColorStop(0, cartSkinShade(paint, 0.25));
  bib.addColorStop(1, cartSkinShade(paint, -0.25));
  ctx.fillStyle = bib; ctx.fillRect(-0.4, -0.2, 0.8, 0.8);
  ctx.restore();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.ellipse(0, 0.2, 0.3, 0.3, 0, 0, Math.PI * 2); ctx.stroke();

  // Koban (oval gold coin) held on the belly, with a player-colour glyph.
  ctx.save();
  ctx.translate(0, 0.26);
  ctx.beginPath(); ctx.ellipse(0, 0, 0.2, 0.13, 0, 0, Math.PI * 2);
  var koban = ctx.createLinearGradient(0, -0.13, 0, 0.13);
  koban.addColorStop(0, GOLD_HI); koban.addColorStop(1, GOLD);
  ctx.fillStyle = koban; ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.022; ctx.stroke();
  ctx.strokeStyle = cartSkinShade(paint, -0.2); ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.moveTo(-0.07, -0.04); ctx.lineTo(0.07, -0.04);
  ctx.moveTo(-0.05, 0.02); ctx.lineTo(0.05, 0.02); ctx.stroke();
  ctx.restore();

  // ---- Raised beckoning paw (right arm up by the head), waves, leans toward heading ----
  var beckon = (0.5 + 0.5 * Math.sin(anim * (1.5 + pawWave * 3))) * (0.06 + 0.08 * pawWave);
  ctx.save();
  ctx.translate(0.34, -0.34 - beckon);
  ctx.rotate(lookX * 0.18);                       // subtle lean toward travel direction
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.12; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-0.06, 0.34); ctx.lineTo(0, 0); ctx.stroke();
  ctx.fillStyle = goldStatueFill(ctx, anim, -0.16, 0.1, sheen);
  ctx.beginPath(); ctx.ellipse(0, -0.04, 0.13, 0.15, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.025; ctx.stroke();
  // toe lines
  ctx.lineWidth = 0.015;
  ctx.beginPath(); ctx.moveTo(-0.05, -0.12); ctx.lineTo(-0.05, -0.02);
  ctx.moveTo(0.05, -0.12); ctx.lineTo(0.05, -0.02); ctx.stroke();
  ctx.restore();

  // ---- Head (gold disc up top) ----
  var hy = -0.42;

  // Player-colour collar at the neck with a little gold bell (secondary colour).
  ctx.save();
  var collarY = -0.06;
  ctx.strokeStyle = cartSkinShade(paint, 0.05); ctx.lineWidth = 0.12; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(0, collarY, 0.36, -2.5, -0.64); ctx.stroke();
  ctx.strokeStyle = cartSkinShade(paint, -0.3); ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.arc(0, collarY, 0.36, -2.5, -0.64); ctx.stroke();
  // bell hanging at the front of the collar
  var bellY = collarY + 0.34;
  var bellG = ctx.createRadialGradient(-0.02, bellY - 0.03, 0.01, 0, bellY, 0.1);
  bellG.addColorStop(0, GOLD_HI); bellG.addColorStop(1, GOLD);
  ctx.fillStyle = bellG; ctx.beginPath(); ctx.arc(0, bellY, 0.085, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.018; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-0.055, bellY); ctx.lineTo(0.055, bellY); ctx.stroke();
  ctx.fillStyle = GOLD_DK; ctx.beginPath(); ctx.arc(0, bellY + 0.05, 0.02, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Ears with player-colour inners (the secondary colour).
  for (var e = -1; e <= 1; e += 2) {
    ctx.fillStyle = GOLD; ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.025;
    ctx.beginPath();
    ctx.moveTo(e * 0.12, hy - 0.24);
    ctx.lineTo(e * 0.34, hy - 0.5);
    ctx.lineTo(e * 0.4, hy - 0.18);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = cartSkinShade(paint, 0.12);   // bright player colour inner
    ctx.beginPath();
    ctx.moveTo(e * 0.17, hy - 0.27);
    ctx.lineTo(e * 0.3, hy - 0.42);
    ctx.lineTo(e * 0.32, hy - 0.24);
    ctx.closePath(); ctx.fill();
  }
  // Head disc.
  ctx.beginPath(); ctx.arc(0, hy, 0.36, 0, Math.PI * 2);
  ctx.fillStyle = goldStatueFill(ctx, anim, hy - 0.36, hy + 0.36, sheen); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.035; ctx.stroke();

  // Eyes — whites with dark pupils that SLIDE toward the heading direction.
  for (var i2 = -1; i2 <= 1; i2 += 2) {
    var ex = i2 * 0.14, ey = hy - 0.04;
    ctx.fillStyle = "#fffdf2";
    ctx.beginPath(); ctx.ellipse(ex, ey, 0.075, 0.09, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.014; ctx.stroke();
    // pupil tracks travel direction
    ctx.fillStyle = "#16100a";
    ctx.beginPath();
    ctx.arc(ex + lookX * 0.035, ey + lookY * 0.05, 0.04, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = GOLD_HI; // glint
    ctx.beginPath();
    ctx.arc(ex + lookX * 0.035 + 0.015, ey + lookY * 0.05 - 0.02, 0.012, 0, Math.PI * 2); ctx.fill();
  }
  // Nose + mouth.
  ctx.fillStyle = cartSkinShade(paint, -0.1);
  ctx.beginPath(); ctx.moveTo(-0.03, hy + 0.12); ctx.lineTo(0.03, hy + 0.12); ctx.lineTo(0, hy + 0.16); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.016;
  ctx.beginPath();
  ctx.moveTo(0, hy + 0.16); ctx.quadraticCurveTo(-0.06, hy + 0.21, -0.1, hy + 0.17);
  ctx.moveTo(0, hy + 0.16); ctx.quadraticCurveTo(0.06, hy + 0.21, 0.1, hy + 0.17);
  ctx.stroke();
  // Whiskers.
  ctx.strokeStyle = "rgba(156,116,20,0.8)"; ctx.lineWidth = 0.014;
  for (var ws = -1; ws <= 1; ws += 2) {
    ctx.beginPath(); ctx.moveTo(ws * 0.08, hy + 0.12); ctx.lineTo(ws * 0.42, hy + 0.06); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ws * 0.08, hy + 0.16); ctx.lineTo(ws * 0.42, hy + 0.18); ctx.stroke();
  }

  // Tiny gold crown coronet between the ears (champion mark).
  ctx.save();
  ctx.translate(0, hy - 0.34);
  ctx.fillStyle = GOLD; ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.018;
  ctx.beginPath();
  ctx.moveTo(-0.13, 0.06); ctx.lineTo(-0.13, -0.02); ctx.lineTo(-0.06, 0.03);
  ctx.lineTo(0, -0.06); ctx.lineTo(0.06, 0.03); ctx.lineTo(0.13, -0.02);
  ctx.lineTo(0.13, 0.06); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = cartSkinShade(paint, 0.0);
  ctx.beginPath(); ctx.arc(0, 0.02, 0.022, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// --- 4. Warlord (achievement) -----------------------------------------------
// A heavy armoured war machine: wide angular chassis, riveted bolt-on plates,
// a toothed ram/spikes on the nose (+X), battle-scar gouges, and twin smoke
// exhaust stacks. Tints to paint with dark gunmetal plating of the same hue.
function drawWarlordSkin(ctx, anim, paint) {
  paint = paint || "#8a3b2b";
  var spike = (0.55);
  var plate = (0.60);
  var rumble = Math.sin(anim * 9) * 0.012;     // engine shudder

  ctx.save();
  ctx.translate(0, rumble);

  // Heavy treads (dark slabs along each side instead of round wheels).
  ctx.fillStyle = "#141414";
  cartRoundRectPath(ctx, -0.7, 0.46, 1.32, 0.3, 0.08); ctx.fill();
  cartRoundRectPath(ctx, -0.7, -0.76, 1.32, 0.3, 0.08); ctx.fill();
  // Tread lugs (scrolling).
  ctx.fillStyle = "#2c2c2c";
  for (var side = -1; side <= 1; side += 2) {
    var ty = side > 0 ? 0.46 : -0.76;
    var off = ((anim * 0.4) % 0.22);
    for (var lx = -0.68 + off; lx < 0.62; lx += 0.22) {
      ctx.fillRect(lx, ty + 0.02, 0.08, 0.26);
    }
  }

  // Nose ram with teeth (spikes), toward +X.
  var sp = 0.18 + 0.4 * spike;
  ctx.fillStyle = cartSkinShade(paint, -0.55);
  ctx.beginPath();
  ctx.moveTo(0.62, -0.46);
  ctx.lineTo(0.62 + sp * 0.4, -0.46);
  for (var tth = -3; tth <= 3; tth++) {
    var ty2 = tth * 0.15;
    ctx.lineTo(0.62 + sp, ty2 - 0.06);
    ctx.lineTo(0.62 + sp * 0.45, ty2);
    ctx.lineTo(0.62 + sp, ty2 + 0.06);
  }
  ctx.lineTo(0.62 + sp * 0.4, 0.46);
  ctx.lineTo(0.62, 0.46);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#0d0d0d"; ctx.lineWidth = 0.03; ctx.stroke();

  // Main hull — wide angular slab.
  ctx.beginPath();
  ctx.moveTo(0.66, -0.4);
  ctx.lineTo(0.74, 0);
  ctx.lineTo(0.66, 0.4);
  ctx.lineTo(-0.66, 0.5);
  ctx.lineTo(-0.78, 0.2);
  ctx.lineTo(-0.78, -0.2);
  ctx.lineTo(-0.66, -0.5);
  ctx.closePath();
  var hull = ctx.createLinearGradient(0, -0.5, 0, 0.5);
  hull.addColorStop(0, cartSkinShade(paint, 0.18));
  hull.addColorStop(0.5, cartSkinShade(paint, -0.08));
  hull.addColorStop(1, cartSkinShade(paint, -0.4));
  ctx.fillStyle = hull; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.6); ctx.lineWidth = 0.06; ctx.stroke();

  // Bolt-on armour plates (darker gunmetal of the same hue), with rivets.
  var plateCol = cartSkinShade(paint, -0.3 - 0.25 * plate);
  var rivet = cartSkinShade(paint, 0.25);
  function platePanel(x, y, w, h) {
    ctx.fillStyle = plateCol;
    cartRoundRectPath(ctx, x, y, w, h, 0.04); ctx.fill();
    ctx.strokeStyle = "#0e0e0e"; ctx.lineWidth = 0.022; ctx.stroke();
    ctx.fillStyle = rivet;
    var rs = 0.022;
    ctx.beginPath(); ctx.arc(x + 0.05, y + 0.05, rs, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 0.05, y + 0.05, rs, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 0.05, y + h - 0.05, rs, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 0.05, y + h - 0.05, rs, 0, Math.PI*2); ctx.fill();
  }
  platePanel(-0.6, -0.42, 0.46, 0.34);
  platePanel(-0.6, 0.08, 0.46, 0.34);
  platePanel(-0.05, -0.4, 0.5, 0.3);
  platePanel(-0.05, 0.1, 0.5, 0.3);

  // Central armoured cockpit hatch (angular, slit window).
  ctx.fillStyle = cartSkinShade(paint, -0.15);
  ctx.beginPath();
  ctx.moveTo(0.34, -0.2); ctx.lineTo(0.16, -0.26); ctx.lineTo(-0.02, -0.2);
  ctx.lineTo(-0.02, 0.2); ctx.lineTo(0.16, 0.26); ctx.lineTo(0.34, 0.2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#0e0e0e"; ctx.lineWidth = 0.03; ctx.stroke();
  ctx.fillStyle = "rgba(120,160,190,0.5)";
  cartRoundRectPath(ctx, 0.04, -0.07, 0.24, 0.14, 0.03); ctx.fill();

  // Battle-scar gouges (light scratches across the plating).
  ctx.strokeStyle = cartSkinShadeA(paint, 0.5, 0.5); ctx.lineWidth = 0.018;
  ctx.beginPath(); ctx.moveTo(-0.4, -0.3); ctx.lineTo(-0.18, -0.12); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-0.5, 0.22); ctx.lineTo(-0.28, 0.3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0.1, -0.32); ctx.lineTo(0.26, -0.2); ctx.stroke();

  // Twin exhaust stacks at the rear with smoke puffs.
  for (var ex = -1; ex <= 1; ex += 2) {
    ctx.fillStyle = "#101010";
    ctx.beginPath(); ctx.arc(-0.74, ex * 0.28, 0.07, 0, Math.PI * 2); ctx.fill();
    var puff = 0.5 + 0.5 * Math.sin(anim * 6 + ex);
    ctx.fillStyle = "rgba(60,60,60," + (0.3 + 0.25 * puff) + ")";
    ctx.beginPath(); ctx.arc(-0.86 - 0.06 * puff, ex * 0.28, 0.05 + 0.03 * puff, 0, Math.PI * 2); ctx.fill();
  }

  ctx.restore();
}

// ============================================================================
// FUN / NOVELTY carts (operator request). Like the lucky cat, each keeps its
// iconic colours and uses the player colour as an accent so owners are still
// tellable apart. Smiley / Earth / 8-Ball are STATUES (drawn upright so the
// face/number stays readable); Pizza is a normal rolling cart.
// ============================================================================

// Pizza pie — a rolling pizza with a missing slice, pepperoni, melty cheese.
// The plate/pan underneath is the player-colour accent.
function drawPizzaSkin(ctx, anim, paint) {
  paint = paint || "#e07b39";
  // Player-colour pan/plate under the pie.
  ctx.beginPath(); ctx.arc(0, 0, 0.98, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.1); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.05; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.15); ctx.fill();
  // Crust ring.
  ctx.beginPath(); ctx.arc(0, 0, 0.84, 0, Math.PI * 2);
  var crust = ctx.createRadialGradient(0, 0, 0.45, 0, 0, 0.84);
  crust.addColorStop(0, "#f0c074"); crust.addColorStop(0.8, "#d99a3c"); crust.addColorStop(1, "#b3741f");
  ctx.fillStyle = crust; ctx.fill();
  // Cheese.
  ctx.beginPath(); ctx.arc(0, 0, 0.68, 0, Math.PI * 2);
  var cheese = ctx.createRadialGradient(-0.15, -0.15, 0.1, 0, 0, 0.7);
  cheese.addColorStop(0, "#ffd967"); cheese.addColorStop(1, "#eab843");
  ctx.fillStyle = cheese; ctx.fill();
  // Missing slice — wedge cut showing the plate underneath.
  var cutA = 0.55, cutW = 0.62;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 0.86, cutA, cutA + cutW); ctx.closePath();
  ctx.fillStyle = cartSkinShade(paint, 0.15); ctx.fill();
  ctx.strokeStyle = "#c8862f"; ctx.lineWidth = 0.03; ctx.stroke();
  // Pepperoni — all sit on the cheese (radius <= 0.55) and clear of the cut wedge.
  ctx.fillStyle = "#b0322a";
  var pepR = 0.1;
  var peps = [[0.3, 0.1], [-0.24, 0.28], [-0.34, -0.2], [0.16, -0.32], [-0.02, -0.02], [0.34, -0.2], [-0.46, 0.04]];
  for (var i = 0; i < peps.length; i++) {
    var pxr = peps[i][0], pyr = peps[i][1];
    // skip anything that would fall inside the missing-slice wedge
    var pang = Math.atan2(pyr, pxr); if (pang < 0) pang += Math.PI * 2;
    if (pang >= cutA && pang <= cutA + cutW) continue;
    if (pxr * pxr + pyr * pyr > 0.55 * 0.55) continue;   // keep on the cheese
    ctx.fillStyle = "#b0322a";
    ctx.beginPath(); ctx.arc(pxr, pyr, pepR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#92271f";
    ctx.beginPath(); ctx.arc(pxr + 0.02, pyr + 0.02, 0.05, 0, Math.PI * 2); ctx.fill();
  }
  // A couple of basil leaves + cheese-bubble highlights for life.
  ctx.fillStyle = "#3f8f3a";
  ctx.beginPath(); ctx.ellipse(-0.42, -0.4, 0.06, 0.035, -0.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0.42, 0.18, 0.06, 0.035, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath(); ctx.arc(0.05, -0.18, 0.05, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(-0.18, 0.12, 0.04, 0, Math.PI * 2); ctx.fill();
}

// Planet Earth — ocean globe with drifting continents + clouds, a tinted
// atmosphere halo, and a little player-colour satellite in orbit (the accent).
function drawEarthSkin(ctx, anim, paint, heading) {
  paint = paint || "#4a78e0";
  // Atmosphere halo, tinted to the player colour.
  var halo = ctx.createRadialGradient(0, 0, 0.78, 0, 0, 1.0);
  halo.addColorStop(0, cartSkinShadeA(paint, 0.4, 0));
  halo.addColorStop(0.82, cartSkinShadeA(paint, 0.5, 0.45));
  halo.addColorStop(1, cartSkinShadeA(paint, 0.5, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, 0, 1.0, 0, Math.PI * 2); ctx.fill();

  // Orbiting satellite. The orbit is tilted; on the far half (top) it passes
  // BEHIND the globe, so we draw it before the globe there and after on the near half.
  var oa = anim * 1.4;
  var sxo = Math.cos(oa) * 0.98, syo = Math.sin(oa) * 0.34;
  var behind = Math.sin(oa) < 0;       // top half of the orbit = behind the planet
  function drawMoon() {
    ctx.fillStyle = cartSkinShade(paint, 0.1);
    ctx.beginPath(); ctx.arc(sxo, syo, 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.02; ctx.stroke();
  }
  if (behind) drawMoon();

  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.82, 0, Math.PI * 2); ctx.clip();
  // Ocean.
  var ocean = ctx.createRadialGradient(-0.28, -0.28, 0.1, 0, 0, 1.0);
  ocean.addColorStop(0, "#41a6e6"); ocean.addColorStop(1, "#0b3a78");
  ctx.fillStyle = ocean; ctx.fillRect(-1, -1, 2, 2);
  // Continents (a blob group scrolled horizontally for a rolling-globe feel).
  var scroll = ((anim * 0.18) % 1.64) - 0.82;
  function land(ox) {
    ctx.save(); ctx.translate(ox, 0);
    ctx.fillStyle = "#3f9b46";
    var blobs = [[-0.2, -0.3, 0.26, 0.18], [0.05, -0.1, 0.2, 0.26], [-0.35, 0.25, 0.22, 0.16],
                 [0.3, 0.3, 0.18, 0.22], [0.45, -0.35, 0.14, 0.12]];
    for (var b = 0; b < blobs.length; b++) {
      ctx.beginPath(); ctx.ellipse(blobs[b][0], blobs[b][1], blobs[b][2], blobs[b][3], 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#327d3a";
    ctx.beginPath(); ctx.ellipse(0.0, -0.12, 0.1, 0.13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  land(scroll); land(scroll + 1.64); land(scroll - 1.64);
  // Drifting clouds.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  var cl = ((anim * 0.26) % 1.8) - 0.9;
  for (var c = 0; c < 3; c++) {
    var cx2 = ((cl + c * 0.7 + 0.9) % 1.8) - 0.9;
    var cy2 = -0.35 + c * 0.32;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, 0.22, 0.08, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2 + 0.14, cy2 + 0.03, 0.12, 0.06, 0, 0, Math.PI * 2); ctx.fill();
  }
  // Sphere shading (terminator) for 3D.
  var term = ctx.createRadialGradient(-0.3, -0.3, 0.2, 0, 0, 1.05);
  term.addColorStop(0, "rgba(255,255,255,0.18)");
  term.addColorStop(0.6, "rgba(0,0,0,0)");
  term.addColorStop(1, "rgba(0,0,20,0.5)");
  ctx.fillStyle = term; ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();

  if (!behind) drawMoon();   // near half of the orbit: in front of the planet
}

// Smiley emoji — a classic grin that FULLY tints to the player colour, with a
// blink and a slight squash bounce.
function drawSmileySkin(ctx, anim, paint, heading) {
  paint = paint || "#f5d142";
  var bounce = 1 + Math.sin(anim * 4) * 0.03;
  ctx.save(); ctx.scale(1 / bounce, bounce);
  // Face.
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var f = ctx.createRadialGradient(-0.3, -0.3, 0.1, 0, 0, 1.0);
  f.addColorStop(0, cartSkinShade(paint, 0.4));
  f.addColorStop(1, paint);
  ctx.fillStyle = f; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.05; ctx.stroke();
  // Eyes (blink every few seconds).
  var phase = anim % 3.2;
  var blink = (phase > 3.0) ? 0.12 : 1;
  ctx.fillStyle = "#2a1c08";
  for (var e = -1; e <= 1; e += 2) {
    ctx.beginPath(); ctx.ellipse(e * 0.32, -0.2, 0.12, 0.17 * blink, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (blink === 1) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (var e2 = -1; e2 <= 1; e2 += 2) {
      ctx.beginPath(); ctx.arc(e2 * 0.32 + 0.04, -0.26, 0.035, 0, Math.PI * 2); ctx.fill();
    }
  }
  // Grin (just the line — no tongue/lips).
  ctx.strokeStyle = "#2a1c08"; ctx.lineWidth = 0.11; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(0, 0.05, 0.5, 0.18 * Math.PI, 0.82 * Math.PI); ctx.stroke();
  // Rosy cheeks.
  ctx.fillStyle = cartSkinShadeA(paint, -0.25, 0.4);
  ctx.beginPath(); ctx.arc(-0.5, 0.12, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.5, 0.12, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Magic 8-Ball — glossy black sphere. It randomly SHAKES (jitters) and then a
// classic answer surfaces in a blue triangle window before settling back to the
// "8". Player colour rings the answer window (the accent).
var EIGHTBALL_ANSWERS = ["YES", "NO", "MAYBE", "ASK\nAGAIN", "FOR\nSURE", "NOPE",
  "IT IS\nCERTAIN", "DON'T\nCOUNT\nON IT", "MOST\nLIKELY", "OUTLOOK\nGOOD",
  "VERY\nDOUBTFUL", "TRY\nLATER"];
var eightBall = { init: false, phase: "rest", until: 0, answer: "YES" };
function eightBallTick(anim) {
  if (!eightBall.init) {
    eightBall.init = true; eightBall.until = anim + 1.5 + Math.random() * 2;
    eightBall.answer = EIGHTBALL_ANSWERS[(Math.random() * EIGHTBALL_ANSWERS.length) | 0];
  }
  if (anim >= eightBall.until) {
    if (eightBall.phase === "rest") { eightBall.phase = "shake"; eightBall.until = anim + 0.75; }
    else if (eightBall.phase === "shake") {
      eightBall.phase = "reveal"; eightBall.until = anim + 2.8;
      eightBall.answer = EIGHTBALL_ANSWERS[(Math.random() * EIGHTBALL_ANSWERS.length) | 0];
    } else { eightBall.phase = "rest"; eightBall.until = anim + 2 + Math.random() * 3; }
  }
}
function drawEightBallSkin(ctx, anim, paint, heading) {
  paint = paint || "#3f6fe0";
  eightBallTick(anim);
  ctx.save();
  if (eightBall.phase === "shake") {                 // physical jitter while shaking
    ctx.translate((Math.random() - 0.5) * 0.09, (Math.random() - 0.5) * 0.09);
    ctx.rotate((Math.random() - 0.5) * 0.07);
  }
  // Black sphere.
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var ball = ctx.createRadialGradient(-0.3, -0.32, 0.1, 0, 0, 1.05);
  ball.addColorStop(0, "#3a3a3a"); ball.addColorStop(0.5, "#161616"); ball.addColorStop(1, "#000");
  ctx.fillStyle = ball; ctx.fill();

  if (eightBall.phase === "reveal") {
    // Blue answer window (triangle die seen through the glass), player-colour rim.
    ctx.beginPath(); ctx.arc(0, 0.04, 0.46, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShade(paint, -0.05); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0.04, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10,20,60,0.85)"; ctx.fill();
    // upward triangle
    ctx.beginPath(); ctx.moveTo(0, -0.32); ctx.lineTo(0.34, 0.26); ctx.lineTo(-0.34, 0.26); ctx.closePath();
    var tri = ctx.createLinearGradient(0, -0.32, 0, 0.26);
    tri.addColorStop(0, "#23409a"); tri.addColorStop(1, "#0e1f5c");
    ctx.fillStyle = tri; ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, 0.2); ctx.lineWidth = 0.02; ctx.stroke();
    // answer text (supports up to 3 short lines)
    var lines = eightBall.answer.split("\n");
    var fs = lines.length >= 3 ? 0.1 : (lines.length === 2 ? 0.12 : 0.16);
    ctx.fillStyle = "#eaf0ff";
    ctx.font = "bold " + fs + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    var lh = fs * 1.15, y0 = 0.06 - (lines.length - 1) * lh / 2;
    for (var li = 0; li < lines.length; li++) ctx.fillText(lines[li], 0, y0 + li * lh);
  } else if (eightBall.phase === "shake") {
    // murky swirl while the answer is still settling.
    ctx.beginPath(); ctx.arc(0, 0.04, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(12,24,66,0.9)"; ctx.fill();
    ctx.fillStyle = "rgba(120,150,220,0.5)";
    for (var b = 0; b < 4; b++) {
      var ba = anim * 6 + b * 1.7;
      ctx.beginPath(); ctx.arc(Math.cos(ba) * 0.18, 0.04 + Math.sin(ba) * 0.16, 0.05, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    // Resting: the classic white "8" disc.
    ctx.beginPath(); ctx.arc(0.04, 0.06, 0.42, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShade(paint, -0.05); ctx.fill();
    ctx.beginPath(); ctx.arc(0.04, 0.06, 0.36, 0, Math.PI * 2);
    ctx.fillStyle = "#f4f4f4"; ctx.fill();
    ctx.fillStyle = "#111";
    ctx.save(); ctx.translate(0.04, 0.06);
    ctx.font = "bold 0.5px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("8", 0, 0.02);
    ctx.restore();
  }

  // Travelling specular highlight (glossy).
  var ga = anim * 0.6;
  var gx = -0.34 + Math.sin(ga) * 0.06, gy = -0.36 + Math.cos(ga) * 0.05;
  var glint = ctx.createRadialGradient(gx, gy, 0.01, gx, gy, 0.32);
  glint.addColorStop(0, "rgba(255,255,255,0.7)");
  glint.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glint;
  ctx.beginPath(); ctx.ellipse(gx, gy, 0.3, 0.18, -0.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Saw Blade — a menacing steel circular-saw disc that spins fast; the centre hub
// is the player-colour accent. (Other circular ideas live below it.)
function drawSawBladeSkin(ctx, anim, paint) {
  paint = paint || "#9aa3ad";
  ctx.save();
  ctx.rotate(anim * 6);   // fast, threatening spin (on top of any heading rotation)
  var steel = ctx.createRadialGradient(-0.25, -0.25, 0.1, 0, 0, 1.0);
  steel.addColorStop(0, "#eef2f6"); steel.addColorStop(0.55, "#aeb6c0"); steel.addColorStop(1, "#79828c");
  // Toothed rim.
  var teeth = 14, rOut = 0.98, rIn = 0.8, step = (Math.PI * 2) / teeth;
  ctx.beginPath();
  for (var t = 0; t < teeth; t++) {
    var a0 = t * step, aTip = a0 + step * 0.32, a1 = a0 + step * 0.5;
    if (t === 0) ctx.moveTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn);
    else ctx.lineTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn);
    ctx.lineTo(Math.cos(aTip) * rOut, Math.sin(aTip) * rOut);
    ctx.lineTo(Math.cos(a1) * rIn, Math.sin(a1) * rIn);
  }
  ctx.closePath();
  ctx.fillStyle = steel; ctx.fill();
  ctx.strokeStyle = "#5b636d"; ctx.lineWidth = 0.03; ctx.stroke();
  // Body plate.
  ctx.beginPath(); ctx.arc(0, 0, 0.74, 0, Math.PI * 2); ctx.fillStyle = steel; ctx.fill();
  ctx.strokeStyle = "#69727c"; ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.arc(0, 0, 0.62, 0, Math.PI * 2); ctx.stroke();
  // Slots (relief cuts) for that real-saw look.
  ctx.strokeStyle = "rgba(40,46,54,0.7)"; ctx.lineWidth = 0.05;
  for (var s = 0; s < 5; s++) {
    var sa = s * (Math.PI * 2) / 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(sa) * 0.5, Math.sin(sa) * 0.5);
    ctx.lineTo(Math.cos(sa + 0.12) * 0.66, Math.sin(sa + 0.12) * 0.66);
    ctx.stroke();
  }
  // Bolt holes.
  ctx.fillStyle = "#3c434c";
  for (var h = 0; h < 4; h++) {
    var ha = h * Math.PI / 2 + 0.4;
    ctx.beginPath(); ctx.arc(Math.cos(ha) * 0.46, Math.sin(ha) * 0.46, 0.05, 0, Math.PI * 2); ctx.fill();
  }
  // Player-colour hub.
  ctx.beginPath(); ctx.arc(0, 0, 0.28, 0, Math.PI * 2);
  var hub = ctx.createRadialGradient(-0.06, -0.06, 0.02, 0, 0, 0.28);
  hub.addColorStop(0, cartSkinShade(paint, 0.3)); hub.addColorStop(1, cartSkinShade(paint, -0.2));
  ctx.fillStyle = hub; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.025; ctx.stroke();
  ctx.fillStyle = "#2b3038"; ctx.beginPath(); ctx.arc(0, 0, 0.07, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Donut — frosting tints to the player colour, with sprinkles, dough, and a hole.
function drawDonutSkin(ctx, anim, paint) {
  paint = paint || "#f06ea9";
  // Dough ring.
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  var dough = ctx.createRadialGradient(0, 0, 0.4, 0, 0, 0.92);
  dough.addColorStop(0, "#d39a5c"); dough.addColorStop(1, "#a96a2e");
  ctx.fillStyle = dough; ctx.fill();
  // Frosting (player colour) with a wavy drip edge.
  ctx.beginPath();
  for (var a = 0; a <= Math.PI * 2 + 0.01; a += 0.2) {
    var rr = 0.78 + Math.sin(a * 7) * 0.04;
    var x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  var fr = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 0.82);
  fr.addColorStop(0, cartSkinShade(paint, 0.3)); fr.addColorStop(1, paint);
  ctx.fillStyle = fr; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.35); ctx.lineWidth = 0.02; ctx.stroke();
  // Sprinkles (deterministic positions on the frosting band).
  var SPRINK = ["#ffffff", "#ffd84d", "#5ec85e", "#4a78e0", "#ef6fb0", "#ff7043"];
  for (var i = 0; i < 14; i++) {
    var sa = i * 2.39963, sr = 0.45 + (i % 3) * 0.1;   // golden-angle scatter
    ctx.save();
    ctx.translate(Math.cos(sa) * sr, Math.sin(sa) * sr);
    ctx.rotate(sa * 1.7);
    ctx.fillStyle = SPRINK[i % SPRINK.length];
    ctx.fillRect(-0.045, -0.014, 0.09, 0.028);
    ctx.restore();
  }
  // Hole.
  ctx.beginPath(); ctx.arc(0, 0, 0.34, 0, Math.PI * 2);
  ctx.fillStyle = "#b07a3e"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.27, 0, Math.PI * 2);
  ctx.fillStyle = "#3a2a1c"; ctx.fill();
}

// Vinyl Record — a spinning black record with grooves and a player-colour label.
function drawVinylSkin(ctx, anim, paint, heading) {
  paint = paint || "#d23b6a";
  ctx.save();
  ctx.rotate(anim * 3);
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  var disc = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 1.0);
  disc.addColorStop(0, "#2a2a2e"); disc.addColorStop(1, "#0a0a0c");
  ctx.fillStyle = disc; ctx.fill();
  // Grooves.
  ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 0.012;
  for (var r = 0.42; r < 0.92; r += 0.06) {
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  }
  // Label (player colour).
  ctx.beginPath(); ctx.arc(0, 0, 0.36, 0, Math.PI * 2);
  var lab = ctx.createRadialGradient(-0.08, -0.08, 0.04, 0, 0, 0.36);
  lab.addColorStop(0, cartSkinShade(paint, 0.3)); lab.addColorStop(1, paint);
  ctx.fillStyle = lab; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.02; ctx.stroke();
  ctx.strokeStyle = cartSkinShade(paint, -0.2); ctx.lineWidth = 0.012;
  ctx.beginPath(); ctx.arc(0, 0, 0.24, 0, Math.PI * 2); ctx.stroke();
  // Spindle hole.
  ctx.fillStyle = "#0a0a0c"; ctx.beginPath(); ctx.arc(0, 0, 0.045, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Static sheen streak (light reflecting off the vinyl — stays put while it spins).
  var sheen = ctx.createLinearGradient(-0.7, -0.7, 0.2, 0.2);
  sheen.addColorStop(0, "rgba(255,255,255,0)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.12)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = sheen; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
}

// --- Compass — brass case, dial, and a needle that POINTS toward travel. The
// pointing half of the needle is the player colour. (statue + heading) ---------
function drawCompassSkin(ctx, anim, paint, heading) {
  if (typeof heading !== "number") heading = 0;
  paint = paint || "#c0392b";
  // Brass case.
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  var brass = ctx.createRadialGradient(-0.3, -0.3, 0.1, 0, 0, 1.0);
  brass.addColorStop(0, "#eccf78"); brass.addColorStop(1, "#9c7414");
  ctx.fillStyle = brass; ctx.fill();
  ctx.strokeStyle = "#6e500d"; ctx.lineWidth = 0.05; ctx.stroke();
  // Dial face.
  ctx.beginPath(); ctx.arc(0, 0, 0.78, 0, Math.PI * 2);
  ctx.fillStyle = "#f3ead2"; ctx.fill();
  // Tick marks + cardinal letters.
  ctx.fillStyle = "#3a2f1c";
  for (var t = 0; t < 16; t++) {
    var a = t * Math.PI / 8, big = (t % 4 === 0);
    ctx.save(); ctx.rotate(a);
    ctx.fillRect(0.6, -0.02, big ? 0.14 : 0.07, big ? 0.05 : 0.03);
    ctx.restore();
  }
  ctx.font = "0.18px bold sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("N", 0, -0.62); ctx.fillText("S", 0, 0.62);
  ctx.fillText("E", 0.62, 0); ctx.fillText("W", -0.62, 0);
  // Needle — points toward heading; pointing half is the player colour.
  ctx.save(); ctx.rotate(heading);
  ctx.fillStyle = cartSkinShade(paint, 0.05); ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.015;
  ctx.beginPath(); ctx.moveTo(0.66, 0); ctx.lineTo(0, -0.1); ctx.lineTo(0, 0.1); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#e9e9e9";
  ctx.beginPath(); ctx.moveTo(-0.66, 0); ctx.lineTo(0, -0.1); ctx.lineTo(0, 0.1); ctx.closePath(); ctx.fill();
  ctx.restore();
  // Center pin + glass glare.
  ctx.fillStyle = "#6e500d"; ctx.beginPath(); ctx.arc(0, 0, 0.06, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath(); ctx.ellipse(-0.28, -0.3, 0.34, 0.2, -0.6, 0, Math.PI * 2); ctx.fill();
}

// --- Wheel of Fortune — spins fast then slows and clicks to rest on a slot, then
// kicks off again. Wedges are player-colour shades. (statue + internal state) ---
var wheel = { init: false, angle: 0, vel: 0, last: 0, restUntil: 0 };
function wheelTick(anim) {
  if (!wheel.init) { wheel.init = true; wheel.last = anim; wheel.vel = 9; }
  var dt = Math.min(0.05, Math.max(0, anim - wheel.last)); wheel.last = anim;
  wheel.angle += wheel.vel * dt;
  wheel.vel *= Math.pow(0.45, dt);
  if (wheel.vel < 0.25) {
    if (wheel.restUntil === 0) wheel.restUntil = anim + 1.4;
    else if (anim > wheel.restUntil) { wheel.vel = 7 + Math.random() * 7; wheel.restUntil = 0; }
  }
}
function drawWheelSkin(ctx, anim, paint) {
  paint = paint || "#c0392b";
  wheelTick(anim);
  var segs = 10, step = (Math.PI * 2) / segs;
  ctx.save(); ctx.rotate(wheel.angle);
  for (var i = 0; i < segs; i++) {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.92, i * step, (i + 1) * step); ctx.closePath();
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.28) : cartSkinShade(paint, -0.22);
    if (i % 5 === 0) ctx.fillStyle = "#f5d142";   // a couple of "jackpot" gold slots
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 0.015; ctx.stroke();
  }
  // Rim + studs.
  ctx.strokeStyle = "#e7c24a"; ctx.lineWidth = 0.06;
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#fff4c0";
  for (var s = 0; s < segs; s++) {
    ctx.beginPath(); ctx.arc(Math.cos(s * step) * 0.92, Math.sin(s * step) * 0.92, 0.03, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // Fixed pointer at top, dipping into the wheel.
  ctx.fillStyle = "#d33"; ctx.strokeStyle = "#7a1c1c"; ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.moveTo(0, -0.78); ctx.lineTo(-0.1, -1.02); ctx.lineTo(0.1, -1.02); ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Gold hub.
  ctx.beginPath(); ctx.arc(0, 0, 0.16, 0, Math.PI * 2);
  ctx.fillStyle = "#f5d142"; ctx.fill(); ctx.strokeStyle = "#9c7414"; ctx.lineWidth = 0.02; ctx.stroke();
}

// --- Clock — player-colour case, white face, sweeping hands. (statue) ---------
function drawClockSkin(ctx, anim, paint) {
  paint = paint || "#3f6fe0";
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  var rim = ctx.createRadialGradient(-0.2, -0.2, 0.3, 0, 0, 1.0);
  rim.addColorStop(0, cartSkinShade(paint, 0.2)); rim.addColorStop(1, cartSkinShade(paint, -0.3));
  ctx.fillStyle = rim; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.8, 0, Math.PI * 2);
  ctx.fillStyle = "#f8f6ee"; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.02; ctx.stroke();
  // Hour ticks.
  ctx.fillStyle = "#2a2a2a";
  for (var h = 0; h < 12; h++) {
    ctx.save(); ctx.rotate(h * Math.PI / 6);
    ctx.fillRect(0.64, -0.025, h % 3 === 0 ? 0.13 : 0.07, 0.05);
    ctx.restore();
  }
  // Hands (sped up for the demo).
  var sec = anim * (Math.PI * 2 / 8);
  var min = anim * (Math.PI * 2 / 48);
  var hr = anim * (Math.PI * 2 / 576);
  ctx.strokeStyle = "#1c1c1c"; ctx.lineCap = "round";
  ctx.lineWidth = 0.07; ctx.save(); ctx.rotate(hr); ctx.beginPath(); ctx.moveTo(0, 0.08); ctx.lineTo(0, -0.36); ctx.stroke(); ctx.restore();
  ctx.lineWidth = 0.05; ctx.save(); ctx.rotate(min); ctx.beginPath(); ctx.moveTo(0, 0.1); ctx.lineTo(0, -0.58); ctx.stroke(); ctx.restore();
  ctx.strokeStyle = "#d33"; ctx.lineWidth = 0.025;
  ctx.save(); ctx.rotate(sec); ctx.beginPath(); ctx.moveTo(0, 0.16); ctx.lineTo(0, -0.66); ctx.stroke(); ctx.restore();
  ctx.fillStyle = "#d33"; ctx.beginPath(); ctx.arc(0, 0, 0.05, 0, Math.PI * 2); ctx.fill();
}

// (Cartoon Bomb removed per operator — too easily confused with the in-game
//  explosive ability/hazard.)

// --- Googly Eyeball — sclera + veins, iris (player colour) and pupil that TRACK
// the travel direction. (statue + heading) ------------------------------------
function drawEyeballSkin(ctx, anim, paint, heading) {
  if (typeof heading !== "number") heading = 0;
  paint = paint || "#4a78e0";
  var lookX = Math.cos(heading), lookY = Math.sin(heading);
  // Sclera.
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  var s = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 1.0);
  s.addColorStop(0, "#ffffff"); s.addColorStop(1, "#d9def0");
  ctx.fillStyle = s; ctx.fill();
  ctx.strokeStyle = "rgba(120,130,150,0.4)"; ctx.lineWidth = 0.02; ctx.stroke();
  // Red veins.
  ctx.strokeStyle = "rgba(210,70,60,0.5)"; ctx.lineWidth = 0.018;
  for (var v = 0; v < 5; v++) {
    var va = v * 1.4;
    ctx.beginPath(); ctx.moveTo(Math.cos(va) * 0.88, Math.sin(va) * 0.88);
    ctx.quadraticCurveTo(Math.cos(va) * 0.4, Math.sin(va) * 0.4, Math.cos(va + 0.3) * 0.55, Math.sin(va + 0.3) * 0.55);
    ctx.stroke();
  }
  // Iris (player colour) tracks heading.
  var ix = lookX * 0.34, iy = lookY * 0.34;
  ctx.beginPath(); ctx.arc(ix, iy, 0.4, 0, Math.PI * 2);
  var ir = ctx.createRadialGradient(ix, iy, 0.05, ix, iy, 0.4);
  ir.addColorStop(0, cartSkinShade(paint, 0.35)); ir.addColorStop(0.7, paint); ir.addColorStop(1, cartSkinShade(paint, -0.4));
  ctx.fillStyle = ir; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.02; ctx.stroke();
  // Pupil + glint.
  ctx.fillStyle = "#101014"; ctx.beginPath(); ctx.arc(ix, iy, 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath(); ctx.arc(ix - 0.07, iy - 0.08, 0.06, 0, Math.PI * 2); ctx.fill();
}

// --- Disco Ball — a true mirror-ball: facets laid out in latitude bands (so it
// reads as a sphere, not a flat grid), each glinting on its own; some tinted to
// the player colour. Faint light beams sweep off it and a few facets twinkle
// bright white. (statue + internal spin) --------------------------------------
function drawDiscoSkin(ctx, anim, paint) {
  paint = paint || "#b06ff0";
  var R = 0.88;
  // Faint rotating light beams behind the ball (disco lights).
  ctx.save();
  ctx.rotate(anim * 0.35);
  for (var bm = 0; bm < 8; bm++) {
    var ba = bm * Math.PI / 4;
    var bf = 0.3 + 0.35 * Math.sin(anim * 2.2 + bm * 1.3);
    var beam = ctx.createLinearGradient(0, 0, Math.cos(ba) * 1.5, Math.sin(ba) * 1.5);
    beam.addColorStop(0, cartSkinShadeA(paint, 0.5, 0.0));
    beam.addColorStop(0.35, cartSkinShadeA(paint, 0.55, 0.05 + 0.06 * bf));
    beam.addColorStop(1, cartSkinShadeA(paint, 0.55, 0));
    ctx.fillStyle = beam;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(ba - 0.09) * 1.5, Math.sin(ba - 0.09) * 1.5);
    ctx.lineTo(Math.cos(ba + 0.09) * 1.5, Math.sin(ba + 0.09) * 1.5);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // Dark base sphere.
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
  var base = ctx.createRadialGradient(-0.28, -0.3, 0.1, 0, 0, R);
  base.addColorStop(0, "#aab3c0"); base.addColorStop(1, "#3b424d");
  ctx.fillStyle = base; ctx.fill();

  // Mirror facets in latitude bands.
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
  ctx.rotate(anim * 0.5);
  var rows = 9, bandH = (2 * R) / rows;
  for (var r = 0; r < rows; r++) {
    var fy = -R + (r + 0.5) * bandH;
    var lat = fy / R;                              // -1..1
    var halfW = Math.sqrt(Math.max(0, 1 - lat * lat)) * R;
    if (halfW < 0.05) continue;
    var cols = Math.max(1, Math.round((halfW * 2) / bandH));
    var tw = (halfW * 2) / cols;
    for (var c = 0; c < cols; c++) {
      var fx = -halfW + (c + 0.5) * tw;
      // Per-facet glint: light from upper-left + time flicker.
      var lightDot = (-fx * 0.55 - fy * 0.55) / R;
      var fl = 0.5 + 0.32 * lightDot + 0.28 * Math.sin(anim * 2.4 + r * 1.1 + c * 0.8);
      fl = fl < 0 ? 0 : (fl > 1 ? 1 : fl);
      var tint = ((r * 3 + c) % 5 === 0);
      if (tint) {
        ctx.fillStyle = cartSkinShadeA(paint, 0.05 + 0.45 * fl, 0.95);
      } else {
        var lv = (140 + 110 * fl) | 0;
        ctx.fillStyle = "rgba(" + lv + "," + ((lv + 8) | 0) + "," + ((lv + 20) | 0) + ",0.96)";
      }
      ctx.fillRect(fx - tw * 0.42, fy - bandH * 0.42, tw * 0.84, bandH * 0.84);
    }
  }
  ctx.restore();

  // Spherical shading overlay (depth) + rim.
  var sh = ctx.createRadialGradient(-0.3, -0.32, 0.2, 0, 0, R * 1.05);
  sh.addColorStop(0, "rgba(255,255,255,0.22)");
  sh.addColorStop(0.55, "rgba(0,0,0,0)");
  sh.addColorStop(1, "rgba(5,8,25,0.55)");
  ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();

  // A few facets twinkle bright white (star glints), clipped to the ball.
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
  for (var sp = 0; sp < 4; sp++) {
    var pa = anim * 1.1 + sp * 1.9;
    var px = Math.cos(pa) * 0.55, py = Math.sin(pa * 0.7 + sp) * 0.5;
    var twk = Math.max(0, Math.sin(anim * 5 + sp * 2));
    if (twk < 0.2) continue;
    ctx.fillStyle = "rgba(255,255,255," + twk + ")";
    ctx.save(); ctx.translate(px, py);
    var r1 = 0.05 + 0.07 * twk;
    ctx.beginPath();
    for (var q = 0; q < 8; q++) {
      var rr = (q % 2 ? 0.018 : r1), aa = q * Math.PI / 4;
      var X = Math.cos(aa) * rr, Y = Math.sin(aa) * rr;
      if (q === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  ctx.restore();
}

// --- Hypno-Spiral — a dizzying two-tone swirl that always spins. (statue + spin) -
function drawHypnoSkin(ctx, anim, paint) {
  paint = paint || "#d0342c";
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = cartSkinShade(paint, -0.35); ctx.fillRect(-1, -1, 2, 2);
  ctx.rotate(anim * 1.1);
  function arm(phase, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 0.16; ctx.lineCap = "round";
    ctx.beginPath();
    for (var th = 0; th < Math.PI * 6; th += 0.18) {
      var r = 0.03 + (th / (Math.PI * 6)) * 0.95;
      var x = Math.cos(th + phase) * r, y = Math.sin(th + phase) * r;
      if (th === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  arm(0, cartSkinShade(paint, 0.45));
  arm(Math.PI, cartSkinShade(paint, 0.05));
  ctx.restore();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.04;
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.stroke();
}

// --- Cookie — golden choc-chip cookie with a bite taken out; the plate behind it
// is the player-colour accent. (rolls like a normal cart) ----------------------
function drawCookieSkin(ctx, anim, paint) {
  paint = paint || "#e8a13c";
  // Player-colour plate.
  ctx.beginPath(); ctx.arc(0, 0, 0.98, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.05); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.03; ctx.stroke();
  // Cookie dough with a bite (a circular notch cut on the +X edge).
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.82, 0, Math.PI * 2);
  ctx.arc(0.86, 0, 0.34, 0, Math.PI * 2, true);     // subtract a bite
  ctx.clip();
  var dough = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 0.9);
  dough.addColorStop(0, "#e3ad5e"); dough.addColorStop(1, "#bd7f37");
  ctx.fillStyle = dough; ctx.fillRect(-1, -1, 2, 2);
  // Chocolate chips.
  ctx.fillStyle = "#46271a";
  var chips = [[-0.3, -0.2], [0.1, 0.28], [-0.1, -0.4], [0.32, -0.1], [-0.42, 0.22], [0.08, -0.08], [-0.05, 0.5], [0.4, 0.34]];
  for (var c = 0; c < chips.length; c++) {
    ctx.beginPath(); ctx.arc(chips[c][0], chips[c][1], 0.085, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.fillStyle = "#2c1810";
    ctx.beginPath(); ctx.arc(chips[c][0] + 0.02, chips[c][1] + 0.02, 0.04, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  // Bite-edge crumbs.
  ctx.fillStyle = "#cf9445";
  for (var b = 0; b < 5; b++) {
    var ba = -0.6 + b * 0.3;
    ctx.beginPath(); ctx.arc(0.56 + Math.cos(ba) * 0.06, Math.sin(ba) * 0.34, 0.03, 0, Math.PI * 2); ctx.fill();
  }
}

// --- Beach Ball — glossy ball with alternating player-colour and white panels.
// (rolls like a normal cart) ---------------------------------------------------
function drawBeachballSkin(ctx, anim, paint) {
  paint = paint || "#e8453c";
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  ctx.fillStyle = "#fafafa"; ctx.fill();
  var panels = 6, step = (Math.PI * 2) / panels;
  for (var i = 0; i < panels; i += 2) {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.92, i * step, (i + 1) * step); ctx.closePath();
    ctx.fillStyle = (i % 4 === 0) ? paint : cartSkinShade(paint, 0.35);
    ctx.fill();
  }
  // White cap hub.
  ctx.beginPath(); ctx.arc(0, 0, 0.18, 0, Math.PI * 2); ctx.fillStyle = "#fafafa"; ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.15)"; ctx.lineWidth = 0.015; ctx.stroke();
  // Outline + gloss.
  ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath(); ctx.ellipse(-0.32, -0.34, 0.22, 0.12, -0.6, 0, Math.PI * 2); ctx.fill();
}

// --- Sun — player-colour body with rotating rays and a cheery face. (statue) ---
function drawSunSkin(ctx, anim, paint) {
  paint = paint || "#f5b50a";
  ctx.save();
  ctx.rotate(anim * 0.5);
  ctx.fillStyle = cartSkinShade(paint, 0.05);
  for (var r = 0; r < 12; r++) {
    ctx.save(); ctx.rotate(r * Math.PI / 6);
    var wob = 0.05 * Math.sin(anim * 3 + r);
    ctx.beginPath();
    ctx.moveTo(0.66, -0.1); ctx.lineTo(1.0 + wob, 0); ctx.lineTo(0.66, 0.1); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  // Core.
  ctx.beginPath(); ctx.arc(0, 0, 0.7, 0, Math.PI * 2);
  var core = ctx.createRadialGradient(-0.2, -0.2, 0.1, 0, 0, 0.7);
  core.addColorStop(0, cartSkinShade(paint, 0.4)); core.addColorStop(1, paint);
  ctx.fillStyle = core; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.35); ctx.lineWidth = 0.03; ctx.stroke();
  // Face (upright).
  ctx.fillStyle = cartSkinShade(paint, -0.6);
  ctx.beginPath(); ctx.arc(-0.24, -0.12, 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.24, -0.12, 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.6); ctx.lineWidth = 0.06; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(0, 0.04, 0.32, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.fillStyle = cartSkinShadeA(paint, -0.2, 0.4);
  ctx.beginPath(); ctx.arc(-0.4, 0.12, 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.4, 0.12, 0.08, 0, Math.PI * 2); ctx.fill();
}

// --- Shuriken — steel ninja star that spins fast; player-colour centre hub.
// (spins like a normal cart, plus its own fast spin) ---------------------------
function drawShurikenSkin(ctx, anim, paint) {
  paint = paint || "#9aa3ad";
  ctx.save();
  ctx.rotate(anim * 5);
  var steel = ctx.createRadialGradient(-0.2, -0.2, 0.1, 0, 0, 1.0);
  steel.addColorStop(0, "#eef2f6"); steel.addColorStop(1, "#8b939d");
  ctx.fillStyle = steel; ctx.strokeStyle = "#5b636d"; ctx.lineWidth = 0.025;
  for (var p = 0; p < 4; p++) {
    ctx.save(); ctx.rotate(p * Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -0.18);
    ctx.quadraticCurveTo(0.5, -0.28, 0.98, 0);
    ctx.quadraticCurveTo(0.5, 0.28, 0, 0.18);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // Center hub (player colour) + hole.
  ctx.beginPath(); ctx.arc(0, 0, 0.26, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.1); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.025; ctx.stroke();
  ctx.fillStyle = "#2b3038"; ctx.beginPath(); ctx.arc(0, 0, 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// --- Dartboard — alternating wedges with player-colour scoring rings + bullseye,
// and a dart stuck near the centre. (statue) -----------------------------------
function drawDartboardSkin(ctx, anim, paint) {
  paint = paint || "#3fb6c8";
  var segs = 20, step = (Math.PI * 2) / segs;
  for (var i = 0; i < segs; i++) {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.92, i * step, (i + 1) * step); ctx.closePath();
    ctx.fillStyle = (i % 2) ? "#f2e6c8" : "#1c1c1c"; ctx.fill();
  }
  // Scoring rings (player colour) — double ring + triple ring.
  function ring(rOuter, rInner, col) {
    ctx.beginPath(); ctx.arc(0, 0, rOuter, 0, Math.PI * 2); ctx.arc(0, 0, rInner, 0, Math.PI * 2, true);
    ctx.fillStyle = col; ctx.fill("evenodd");
  }
  ring(0.92, 0.82, cartSkinShade(paint, -0.1));
  ring(0.6, 0.5, cartSkinShade(paint, 0.1));
  // Spokes.
  ctx.strokeStyle = "rgba(120,120,120,0.5)"; ctx.lineWidth = 0.012;
  for (var w = 0; w < segs; w++) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(w * step) * 0.92, Math.sin(w * step) * 0.92); ctx.stroke();
  }
  // Bullseye.
  ctx.beginPath(); ctx.arc(0, 0, 0.18, 0, Math.PI * 2); ctx.fillStyle = cartSkinShade(paint, -0.15); ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.08, 0, Math.PI * 2); ctx.fillStyle = "#d33"; ctx.fill();
  // A dart stuck just off-centre.
  var dx = 0.16, dy = -0.12;
  ctx.strokeStyle = "#c9ced4"; ctx.lineWidth = 0.04; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx + 0.34, dy - 0.26); ctx.stroke();
  ctx.fillStyle = "#d33";
  ctx.beginPath(); ctx.moveTo(dx + 0.3, dy - 0.18); ctx.lineTo(dx + 0.46, dy - 0.34); ctx.lineTo(dx + 0.38, dy - 0.14); ctx.closePath(); ctx.fill();
}

// ============================================================================
// BATCH 2 of fun carts (20 more). Shared polygon helper:
// ============================================================================
function cartPolyPath(ctx, cx, cy, r, sides, rot) {
  ctx.beginPath();
  for (var k = 0; k < sides; k++) {
    var a = rot + k * Math.PI * 2 / sides;
    var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// 1. Soccer Ball — white ball with player-colour panels. (rolls)
function drawSoccerSkin(ctx, anim, paint) {
  paint = paint || "#222";
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var w = ctx.createRadialGradient(-0.25, -0.25, 0.1, 0, 0, 0.95);
  w.addColorStop(0, "#ffffff"); w.addColorStop(1, "#d7dce4"); ctx.fillStyle = w; ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 0.03; ctx.stroke();
  var pan = cartSkinShade(paint, -0.12);
  ctx.fillStyle = pan;
  cartPolyPath(ctx, 0, 0, 0.3, 5, -Math.PI / 2); ctx.fill();          // centre pentagon
  for (var i = 0; i < 5; i++) {                                       // outer pentagons
    var a = -Math.PI / 2 + i * Math.PI * 2 / 5;
    cartPolyPath(ctx, Math.cos(a) * 0.66, Math.sin(a) * 0.66, 0.2, 5, a + Math.PI / 5);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 0.025;
  for (var s = 0; s < 5; s++) {
    var aa = -Math.PI / 2 + s * Math.PI * 2 / 5;
    ctx.beginPath(); ctx.moveTo(Math.cos(aa) * 0.3, Math.sin(aa) * 0.3);
    ctx.lineTo(Math.cos(aa) * 0.66, Math.sin(aa) * 0.66); ctx.stroke();
  }
}

// 2. Basketball — the ball tints to the player colour; black seams. (rolls)
function drawBasketballSkin(ctx, anim, paint) {
  paint = paint || "#e2802b";
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var g = ctx.createRadialGradient(-0.25, -0.25, 0.1, 0, 0, 0.95);
  g.addColorStop(0, cartSkinShade(paint, 0.28)); g.addColorStop(1, cartSkinShade(paint, -0.22));
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = "#15100a"; ctx.lineWidth = 0.04; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(0, -0.9); ctx.lineTo(0, 0.9); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-0.9, 0); ctx.lineTo(0.9, 0); ctx.stroke();
  ctx.beginPath(); ctx.arc(-1.25, 0, 0.95, -0.7, 0.7); ctx.stroke();
  ctx.beginPath(); ctx.arc(1.25, 0, 0.95, Math.PI - 0.7, Math.PI + 0.7); ctx.stroke();
}

// 3. Yin-Yang — player colour vs. its light tint, slowly turning. (statue+spin)
function drawYinYangSkin(ctx, anim, paint) {
  paint = paint || "#222";
  var dark = cartSkinShade(paint, -0.15), light = cartSkinShade(paint, 0.6);
  ctx.save(); ctx.rotate(anim * 0.8);
  var R = 0.9;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fillStyle = dark; ctx.fill();
  ctx.fillStyle = light;
  ctx.beginPath(); ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2); ctx.fill();      // right half light
  ctx.beginPath(); ctx.arc(0, -R / 2, R / 2, 0, Math.PI * 2); ctx.fill();        // top lobe light
  ctx.fillStyle = dark;
  ctx.beginPath(); ctx.arc(0, R / 2, R / 2, 0, Math.PI * 2); ctx.fill();         // bottom lobe dark
  ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, -R / 2, 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = light; ctx.beginPath(); ctx.arc(0, R / 2, 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
}

// 4. Ferris Wheel — turning wheel with player-colour gondolas. (statue+spin)
function drawFerrisSkin(ctx, anim, paint) {
  paint = paint || "#d33";
  ctx.save(); ctx.rotate(anim * 0.5);
  var spokes = 8, R = 0.86;
  ctx.strokeStyle = "#dfe5ee"; ctx.lineWidth = 0.045;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, R - 0.08, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 0.022; ctx.strokeStyle = "#b9c2cf";
  for (var i = 0; i < spokes; i++) {
    var a = i * Math.PI * 2 / spokes;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx.stroke();
  }
  for (var c = 0; c < spokes; c++) {
    var ca = c * Math.PI * 2 / spokes;
    var gx = Math.cos(ca) * R, gy = Math.sin(ca) * R;
    ctx.fillStyle = (c % 2) ? paint : cartSkinShade(paint, 0.35);
    cartRoundRectPath(ctx, gx - 0.1, gy - 0.05, 0.2, 0.16, 0.04); ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.015; ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = "#9aa3ad"; ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#5b636d"; ctx.beginPath(); ctx.arc(0, 0, 0.05, 0, Math.PI * 2); ctx.fill();
}

// 5. Pinwheel — player-colour curved blades spinning. (rolls + fast spin)
function drawPinwheelSkin(ctx, anim, paint) {
  paint = paint || "#3fb6c8";
  ctx.save(); ctx.rotate(anim * 2.2);
  var blades = 6;
  for (var i = 0; i < blades; i++) {
    ctx.save(); ctx.rotate(i * Math.PI * 2 / blades);
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.3) : cartSkinShade(paint, -0.05);
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(0.5, -0.18, 0.95, 0.04);
    ctx.lineTo(0.18, 0.12); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.012; ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = "#fff4c0"; ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#9c7414"; ctx.lineWidth = 0.02; ctx.stroke();
}

// 6. Watermelon — green rind, player-colour flesh, seeds. (rolls)
function drawWatermelonSkin(ctx, anim, paint) {
  paint = paint || "#e8453c";
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.fillStyle = "#2f7d32"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.86, 0, Math.PI * 2); ctx.fillStyle = "#54a957"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.8, 0, Math.PI * 2); ctx.fillStyle = "#eaf7e0"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.72, 0, Math.PI * 2);
  var f = ctx.createRadialGradient(-0.15, -0.15, 0.1, 0, 0, 0.72);
  f.addColorStop(0, cartSkinShade(paint, 0.2)); f.addColorStop(1, paint);
  ctx.fillStyle = f; ctx.fill();
  ctx.fillStyle = "#241a12";
  for (var i = 0; i < 10; i++) {
    var a = i * 2.39963, r = 0.28 + (i % 3) * 0.16;
    ctx.save(); ctx.translate(Math.cos(a) * r, Math.sin(a) * r); ctx.rotate(a);
    ctx.beginPath(); ctx.ellipse(0, 0, 0.04, 0.025, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}

// (Capsule Ball removed per operator — too close to the trademarked Poké Ball.)

// 8. Tire — rubber tire with a player-colour hubcap. (rolls + spin)
function drawTireSkin(ctx, anim, paint) {
  paint = paint || "#c0392b";
  ctx.save(); ctx.rotate(anim * 3);
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.fillStyle = "#1a1a1a"; ctx.fill();
  ctx.fillStyle = "#2c2c2c";
  for (var t = 0; t < 18; t++) {
    var a = t * Math.PI * 2 / 18;
    ctx.save(); ctx.rotate(a); ctx.fillRect(0.78, -0.05, 0.16, 0.1); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(0, 0, 0.66, 0, Math.PI * 2); ctx.fillStyle = "#242424"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.48, 0, Math.PI * 2);
  var hub = ctx.createRadialGradient(-0.1, -0.1, 0.05, 0, 0, 0.48);
  hub.addColorStop(0, cartSkinShade(paint, 0.35)); hub.addColorStop(1, cartSkinShade(paint, -0.2));
  ctx.fillStyle = hub; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.02; ctx.stroke();
  ctx.fillStyle = "#3a3a3a";
  for (var l = 0; l < 5; l++) {
    var la = l * Math.PI * 2 / 5 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(Math.cos(la) * 0.28, Math.sin(la) * 0.28, 0.05, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = cartSkinShade(paint, 0.1); ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 9. Gear — a player-colour cog with trapezoid teeth. (rolls + spin)
function drawGearSkin(ctx, anim, paint) {
  paint = paint || "#9aa3ad";
  ctx.save(); ctx.rotate(anim * 1.4);
  var teeth = 10, rO = 0.96, rI = 0.78, step = Math.PI * 2 / teeth;
  ctx.beginPath();
  for (var t = 0; t < teeth; t++) {
    var a = t * step;
    ctx.lineTo(Math.cos(a) * rI, Math.sin(a) * rI);
    ctx.lineTo(Math.cos(a + step * 0.16) * rO, Math.sin(a + step * 0.16) * rO);
    ctx.lineTo(Math.cos(a + step * 0.34) * rO, Math.sin(a + step * 0.34) * rO);
    ctx.lineTo(Math.cos(a + step * 0.5) * rI, Math.sin(a + step * 0.5) * rI);
  }
  ctx.closePath();
  var g = ctx.createRadialGradient(-0.2, -0.2, 0.1, 0, 0, 1.0);
  g.addColorStop(0, cartSkinShade(paint, 0.3)); g.addColorStop(1, cartSkinShade(paint, -0.25));
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.025; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 0.5, 0, Math.PI * 2); ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.03; ctx.stroke();
  ctx.fillStyle = "#2b3038"; ctx.beginPath(); ctx.arc(0, 0, 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = cartSkinShade(paint, -0.1); ctx.beginPath(); ctx.arc(0, 0, 0.14, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ============================================================================
// COSMETIC RENDER CACHES (perf) — see docs/spikes/skin-render-perf.md
// ----------------------------------------------------------------------------
// Several equipped cosmetics re-ran expensive procedural drawing (hundreds of
// per-frame gradients, repeated trig, many small paths) EVERY frame, scaling
// linearly with how many karts wear them. The fix mirrors getPlayerSprite's
// offscreen-canvas caching: render the STATIC layer of a skin once per
// (id, colour) and blit it, leaving only the genuinely-animated bits to draw
// live on top.
//
// getCachedSkinLayer(key, build): renders build(c2d) once into a fixed-size
// offscreen canvas whose context is set up in the SAME normalized [-1,1] space
// the painters use. Callers blit it with `ctx.drawImage(cv, -1, -1, 2, 2)` into
// the already-translated+scaled kart ctx, so heading rotation, the punch-pop
// scale, and any per-frame rotation/sheen still compose on top for free. The
// cache key is (id|colour) only — never the live transform — so punch/zoom/DPR
// never thrash it. 256px comfortably exceeds a kart's on-screen device size at
// any zoom/DPR, so the blit only ever downscales (stays crisp).
var SKIN_LAYER_CACHE_PX = 256;
var _skinLayerCache = {};
function getCachedSkinLayer(key, build) {
  var cv = _skinLayerCache[key];
  if (cv != null) return cv;
  var px = SKIN_LAYER_CACHE_PX;
  cv = document.createElement("canvas");
  cv.width = px; cv.height = px;
  var c = cv.getContext("2d");
  c.translate(px / 2, px / 2);
  c.scale(px / 2, px / 2);          // normalized [-1,1] fills the canvas
  build(c);
  _skinLayerCache[key] = cv;
  return cv;
}

// getCachedGlyphSprite(key, span, build): like the above but for a SMALL repeated
// glyph (e.g. a polka dot) drawn once in a normalized [-span,span] box and blitted
// many times per frame. `cv._span` records the box so callers can size the blit.
var _glyphSpriteCache = {};
function getCachedGlyphSprite(key, span, build) {
  var cv = _glyphSpriteCache[key];
  if (cv != null) return cv;
  var px = 64;
  cv = document.createElement("canvas");
  cv.width = px; cv.height = px;
  var c = cv.getContext("2d");
  c.translate(px / 2, px / 2);
  c.scale(px / (2 * span), px / (2 * span));   // normalized [-span,span] fills the canvas
  build(c);
  cv._span = span;
  _glyphSpriteCache[key] = cv;
  return cv;
}

// 10. Spiral Galaxy — glowing arms in the player-colour hue, slowly rotating. (statue+spin)
function drawGalaxySkin(ctx, anim, paint) {
  paint = paint || "#7a4fff";
  // The space-disc and core are radially symmetric and the spiral arms only ROTATE,
  // so the whole galaxy is a static sprite that we rotate-blit — instead of stamping
  // ~100 arm dots + 3 radial gradients every frame. (Rotating the symmetric disc/core
  // with the blit is visually identical.)
  var cv = getCachedSkinLayer("galaxy|" + paint, function (c) {
    c.beginPath(); c.arc(0, 0, 0.95, 0, Math.PI * 2);
    var space = c.createRadialGradient(0, 0, 0.1, 0, 0, 0.95);
    space.addColorStop(0, cartSkinShade(paint, -0.55)); space.addColorStop(1, "#06060f");
    c.fillStyle = space; c.fill();
    c.save();
    c.beginPath(); c.arc(0, 0, 0.93, 0, Math.PI * 2); c.clip();
    for (var arm = 0; arm < 2; arm++) {
      for (var s = 0; s < 26; s++) {
        var th = s * 0.34 + arm * Math.PI;
        var r = 0.08 + s * 0.034;
        var x = Math.cos(th) * r, y = Math.sin(th) * r;
        var br = 1 - r;
        c.fillStyle = cartSkinShadeA(paint, 0.2 + 0.4 * br, 0.85);
        c.beginPath(); c.arc(x, y, 0.09 * br + 0.02, 0, Math.PI * 2); c.fill();
        c.fillStyle = "rgba(255,255,255," + (0.5 * br) + ")";
        c.beginPath(); c.arc(x, y, 0.03 * br + 0.008, 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();
    var core = c.createRadialGradient(0, 0, 0.02, 0, 0, 0.28);
    core.addColorStop(0, "#fffaf0"); core.addColorStop(0.5, cartSkinShade(paint, 0.4)); core.addColorStop(1, cartSkinShadeA(paint, 0.2, 0));
    c.fillStyle = core; c.beginPath(); c.arc(0, 0, 0.28, 0, Math.PI * 2); c.fill();
  });
  ctx.save();
  ctx.rotate(anim * 0.45);
  ctx.drawImage(cv, -1, -1, 2, 2);
  ctx.restore();
}

// 11. Snowflake — an icy player-colour crystal, slowly turning. (statue+spin)
function drawSnowflakeSkin(ctx, anim, paint) {
  paint = paint || "#5ad0ff";
  var ice = cartSkinShade(paint, 0.45), ice2 = cartSkinShade(paint, 0.1);
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.fillStyle = cartSkinShadeA(paint, -0.3, 0.25); ctx.fill();
  ctx.save(); ctx.rotate(anim * 0.3);
  ctx.strokeStyle = ice; ctx.lineWidth = 0.07; ctx.lineCap = "round";
  for (var i = 0; i < 6; i++) {
    ctx.save(); ctx.rotate(i * Math.PI / 3);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -0.88); ctx.stroke();
    for (var b = 1; b <= 2; b++) {
      var by = -0.3 - b * 0.24;
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(0.18, by - 0.18); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(-0.18, by - 0.18); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.fillStyle = ice2; cartPolyPath(ctx, 0, 0, 0.14, 6, 0); ctx.fill();
  ctx.restore();
}

// 12. Flower — player-colour petals around a golden centre, gently breathing. (statue)
function drawFlowerSkin(ctx, anim, paint) {
  paint = paint || "#ef6fb0";
  var breathe = 1 + Math.sin(anim * 1.6) * 0.04;
  var petals = 8;
  ctx.save(); ctx.scale(breathe, breathe);
  for (var i = 0; i < petals; i++) {
    ctx.save(); ctx.rotate(i * Math.PI * 2 / petals);
    var pg = ctx.createLinearGradient(0, -0.3, 0, -0.92);
    pg.addColorStop(0, cartSkinShade(paint, 0.35)); pg.addColorStop(1, paint);
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.ellipse(0, -0.6, 0.2, 0.34, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.3); ctx.lineWidth = 0.012; ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  var c = ctx.createRadialGradient(-0.06, -0.06, 0.03, 0, 0, 0.32);
  c.addColorStop(0, "#ffe27a"); c.addColorStop(1, "#e0a21a");
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#b9831a";
  for (var d = 0; d < 12; d++) {
    var a = d * 2.39963, r = (d % 3) * 0.07;
    ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 0.03, 0, Math.PI * 2); ctx.fill();
  }
}

// 13. Gold Coin — a steady minted coin: reeded edge, star emblem, player-colour
// gem, and a slow sheen sweep. (statue, no flip)
function drawCoinSkin(ctx, anim, paint) {
  paint = paint || "#3fb6c8";
  // Reeded (ridged) edge.
  ctx.fillStyle = "#b3860f";
  for (var e = 0; e < 48; e++) {
    var ea = e * Math.PI * 2 / 48;
    ctx.save(); ctx.rotate(ea); ctx.fillRect(0.82, -0.035, 0.1, 0.07); ctx.restore();
  }
  // Coin face.
  ctx.beginPath(); ctx.arc(0, 0, 0.86, 0, Math.PI * 2);
  var g = ctx.createRadialGradient(-0.25, -0.25, 0.1, 0, 0, 0.92);
  g.addColorStop(0, "#fff3b0"); g.addColorStop(0.7, "#ffd84d"); g.addColorStop(1, "#c4960f");
  ctx.fillStyle = g; ctx.fill();
  // Inner rim ring.
  ctx.strokeStyle = "#9c7414"; ctx.lineWidth = 0.05;
  ctx.beginPath(); ctx.arc(0, 0, 0.74, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#fff3b0"; ctx.lineWidth = 0.015;
  ctx.beginPath(); ctx.arc(0, 0, 0.7, 0, Math.PI * 2); ctx.stroke();
  // Star emblem with a player-colour gem.
  ctx.fillStyle = "#caa11a";
  ctx.beginPath();
  for (var p = 0; p < 10; p++) {
    var rr = (p % 2 ? 0.22 : 0.5), aa = -Math.PI / 2 + p * Math.PI / 5;
    var X = Math.cos(aa) * rr, Y = Math.sin(aa) * rr;
    if (p === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#9c7414"; ctx.lineWidth = 0.015; ctx.stroke();
  var gem = ctx.createRadialGradient(-0.04, -0.04, 0.02, 0, 0, 0.18);
  gem.addColorStop(0, cartSkinShade(paint, 0.4)); gem.addColorStop(1, cartSkinShade(paint, -0.15));
  ctx.fillStyle = gem; ctx.beginPath(); ctx.arc(0, 0, 0.17, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.beginPath(); ctx.arc(-0.05, -0.06, 0.04, 0, Math.PI * 2); ctx.fill();
  // Slow sheen sweep across the face.
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.86, 0, Math.PI * 2); ctx.clip();
  var sx = ((anim * 0.4) % 2.4) - 1.2;
  var sg = ctx.createLinearGradient(sx - 0.3, -0.6, sx + 0.3, 0.6);
  sg.addColorStop(0, "rgba(255,255,255,0)");
  sg.addColorStop(0.5, "rgba(255,255,255,0.3)");
  sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg; ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

// (Radar removed per operator.)

// 15. Ship's Helm — wooden wheel with handles + player-colour hub. (rolls + spin)
function drawHelmSkin(ctx, anim, paint) {
  paint = paint || "#caa11a";
  ctx.save(); ctx.rotate(anim * 0.9);
  var spokes = 6;
  // Handles (knobs) beyond the rim.
  ctx.fillStyle = "#7a4a1e"; ctx.strokeStyle = "#4e2f12"; ctx.lineWidth = 0.02;
  for (var i = 0; i < spokes; i++) {
    var a = i * Math.PI * 2 / spokes;
    ctx.save(); ctx.rotate(a);
    cartRoundRectPath(ctx, 0.86, -0.05, 0.12, 0.1, 0.03); ctx.fill();
    ctx.beginPath(); ctx.arc(0.98, 0, 0.06, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // Wood ring.
  ctx.strokeStyle = "#8a5a26"; ctx.lineWidth = 0.16;
  ctx.beginPath(); ctx.arc(0, 0, 0.74, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#6b421b"; ctx.lineWidth = 0.04;
  ctx.beginPath(); ctx.arc(0, 0, 0.74, 0, Math.PI * 2); ctx.stroke();
  // Spokes.
  ctx.strokeStyle = "#8a5a26"; ctx.lineWidth = 0.07;
  for (var s = 0; s < spokes; s++) {
    var sa = s * Math.PI * 2 / spokes;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(sa) * 0.82, Math.sin(sa) * 0.82); ctx.stroke();
  }
  ctx.restore();
  // Hub (player colour).
  ctx.beginPath(); ctx.arc(0, 0, 0.22, 0, Math.PI * 2);
  var hub = ctx.createRadialGradient(-0.06, -0.06, 0.02, 0, 0, 0.22);
  hub.addColorStop(0, cartSkinShade(paint, 0.3)); hub.addColorStop(1, cartSkinShade(paint, -0.2));
  ctx.fillStyle = hub; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.02; ctx.stroke();
}

// 16. Camera Aperture — player-colour iris blades opening + closing. (statue)
function drawApertureSkin(ctx, anim, paint) {
  paint = paint || "#3f6fe0";
  var open = 0.26 + 0.22 * (0.5 + 0.5 * Math.sin(anim * 1.4));
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.45); ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.86, 0, Math.PI * 2); ctx.fillStyle = "#0a0a0c"; ctx.fill();
  var blades = 7;
  for (var i = 0; i < blades; i++) {
    var a = i * Math.PI * 2 / blades;
    var a2 = (i + 1) * Math.PI * 2 / blades;
    var ix = Math.cos(a) * open, iy = Math.sin(a) * open;
    var i2x = Math.cos(a2) * open, i2y = Math.sin(a2) * open;
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    ctx.lineTo(Math.cos(a) * 0.86, Math.sin(a) * 0.86);
    ctx.lineTo(Math.cos(a2) * 0.86, Math.sin(a2) * 0.86);
    ctx.lineTo(i2x, i2y);
    ctx.closePath();
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.1) : cartSkinShade(paint, -0.12);
    ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.012; ctx.stroke();
  }
  // Lens glint in the hole.
  ctx.fillStyle = "rgba(140,180,255,0.25)";
  ctx.beginPath(); ctx.arc(0, 0, open * 0.9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.beginPath(); ctx.arc(-open * 0.3, -open * 0.3, open * 0.25, 0, Math.PI * 2); ctx.fill();
}

// 17. Cheese Wheel — holey cheese with a player-colour wax rind + cut wedge. (rolls)
function drawCheeseSkin(ctx, anim, paint) {
  paint = paint || "#e8a13c";
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.1); ctx.fill();      // wax rind (player colour)
  ctx.beginPath(); ctx.arc(0, 0, 0.84, 0, Math.PI * 2);
  var ch = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 0.9);
  ch.addColorStop(0, "#ffe08a"); ch.addColorStop(1, "#f0c14e");
  ctx.fillStyle = ch; ctx.fill();
  // Cut wedge.
  var cutA = 0.5, cutW = 0.6;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 0.86, cutA, cutA + cutW); ctx.closePath();
  ctx.fillStyle = cartSkinShade(paint, 0.1); ctx.fill();
  ctx.strokeStyle = "#d9a93c"; ctx.lineWidth = 0.02; ctx.stroke();
  // Holes.
  ctx.fillStyle = "#e0a838";
  var holes = [[0.2, -0.1], [-0.3, 0.2], [-0.1, -0.4], [0.35, 0.28], [-0.42, -0.18], [0.05, 0.15]];
  for (var i = 0; i < holes.length; i++) {
    var hx = holes[i][0], hy = holes[i][1];
    var ha = Math.atan2(hy, hx); if (ha < 0) ha += Math.PI * 2;
    if (ha >= cutA && ha <= cutA + cutW) continue;
    ctx.beginPath(); ctx.arc(hx, hy, 0.07 + (i % 3) * 0.02, 0, Math.PI * 2); ctx.fill();
  }
}

// 18. Citrus Slice — player-colour rind/flesh with segments + seeds. (rolls)
function drawCitrusSkin(ctx, anim, paint) {
  paint = paint || "#f2a72e";
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.15); ctx.fill();      // rind
  ctx.beginPath(); ctx.arc(0, 0, 0.84, 0, Math.PI * 2); ctx.fillStyle = "#fff6e6"; ctx.fill();   // pith
  ctx.beginPath(); ctx.arc(0, 0, 0.8, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.42); ctx.fill();       // flesh
  // Segments.
  var segs = 10;
  ctx.strokeStyle = "#fff6e6"; ctx.lineWidth = 0.04;
  ctx.fillStyle = cartSkinShade(paint, 0.55);
  for (var i = 0; i < segs; i++) {
    var a0 = i * Math.PI * 2 / segs + 0.04, a1 = (i + 1) * Math.PI * 2 / segs - 0.04;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.78, a0, a1); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = "#fff6e6"; ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, Math.PI * 2); ctx.fill();
  // A couple of seeds.
  ctx.fillStyle = "#e8d6a0";
  ctx.beginPath(); ctx.ellipse(0.3, 0.1, 0.04, 0.06, 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-0.2, -0.3, 0.04, 0.06, -0.4, 0, Math.PI * 2); ctx.fill();
}

// 19. Turtle Shell — player-colour domed shell with scute pattern. (rolls)
function drawTurtleSkin(ctx, anim, paint) {
  paint = paint || "#3f8f3a";
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.3); ctx.fill();       // dark rim
  ctx.beginPath(); ctx.arc(0, 0, 0.82, 0, Math.PI * 2);
  var sh = ctx.createRadialGradient(-0.2, -0.2, 0.1, 0, 0, 0.9);
  sh.addColorStop(0, cartSkinShade(paint, 0.3)); sh.addColorStop(1, cartSkinShade(paint, -0.1));
  ctx.fillStyle = sh; ctx.fill();
  // Central scute + ring of scutes.
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.03; ctx.fillStyle = cartSkinShade(paint, 0.12);
  cartPolyPath(ctx, 0, 0, 0.28, 6, Math.PI / 6); ctx.fill(); ctx.stroke();
  for (var i = 0; i < 6; i++) {
    var a = i * Math.PI / 3;
    ctx.save(); ctx.translate(Math.cos(a) * 0.52, Math.sin(a) * 0.52); ctx.rotate(a);
    cartPolyPath(ctx, 0, 0, 0.2, 5, a); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // Rim segments.
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.02;
  for (var s = 0; s < 12; s++) {
    var sa = s * Math.PI / 6;
    ctx.beginPath(); ctx.moveTo(Math.cos(sa) * 0.72, Math.sin(sa) * 0.72);
    ctx.lineTo(Math.cos(sa) * 0.92, Math.sin(sa) * 0.92); ctx.stroke();
  }
}

// 20. Jack-o'-Lantern — a ridged player-colour pumpkin (built from overlapping
// lobes) with a candle-lit carved face that flickers. (statue)
function drawPumpkinSkin(ctx, anim, paint) {
  paint = paint || "#e8731c";
  var flick = 0.72 + 0.28 * (0.55 * Math.sin(anim * 9) + 0.45 * Math.sin(anim * 3.3 + 1));
  flick = flick < 0.45 ? 0.45 : (flick > 1 ? 1 : flick);
  var seam = cartSkinShade(paint, -0.4);

  // Stem (behind body, peeking over the top).
  ctx.fillStyle = "#5d7d34"; ctx.strokeStyle = "#3c5520"; ctx.lineWidth = 0.02;
  ctx.beginPath();
  ctx.moveTo(-0.08, -0.74); ctx.lineTo(-0.05, -1.0);
  ctx.quadraticCurveTo(0.12, -1.04, 0.14, -0.92);
  ctx.lineTo(0.08, -0.72); ctx.closePath(); ctx.fill(); ctx.stroke();

  // Ridged body: overlapping vertical lobes, drawn outermost-first so the
  // centre lobe sits in front (the lobe edges read as pumpkin ribs).
  var lobes = [
    { x: -0.66, rx: 0.3 }, { x: 0.66, rx: 0.3 },
    { x: -0.37, rx: 0.43 }, { x: 0.37, rx: 0.43 },
    { x: 0, rx: 0.52 }
  ];
  for (var i = 0; i < lobes.length; i++) {
    var L = lobes[i];
    ctx.beginPath(); ctx.ellipse(L.x, 0.06, L.rx, 0.82, 0, 0, Math.PI * 2);
    var pg = ctx.createRadialGradient(L.x - 0.06, -0.15, 0.05, L.x, 0.06, L.rx + 0.5);
    pg.addColorStop(0, cartSkinShade(paint, 0.32));
    pg.addColorStop(0.7, paint);
    pg.addColorStop(1, cartSkinShade(paint, -0.28));
    ctx.fillStyle = pg; ctx.fill();
    ctx.strokeStyle = seam; ctx.lineWidth = 0.02; ctx.stroke();
  }

  // Candle glow behind the face.
  var glow = ctx.createRadialGradient(0, 0.12, 0.05, 0, 0.12, 0.6);
  glow.addColorStop(0, "rgba(255,200,90," + (0.5 * flick) + ")");
  glow.addColorStop(1, "rgba(255,160,40,0)");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0.12, 0.6, 0, Math.PI * 2); ctx.fill();

  // Carved, lit features.
  var lit = "rgba(255," + (170 + 60 * flick | 0) + "," + (40 + 30 * flick | 0) + "," + flick + ")";
  ctx.fillStyle = lit; ctx.strokeStyle = "#5a2a08"; ctx.lineWidth = 0.018; ctx.lineJoin = "round";
  // Angled triangle eyes.
  ctx.beginPath(); ctx.moveTo(-0.44, -0.2); ctx.lineTo(-0.14, -0.08); ctx.lineTo(-0.16, 0.06); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0.44, -0.2); ctx.lineTo(0.14, -0.08); ctx.lineTo(0.16, 0.06); ctx.closePath(); ctx.fill(); ctx.stroke();
  // Triangle nose.
  ctx.beginPath(); ctx.moveTo(0, 0.02); ctx.lineTo(0.11, 0.2); ctx.lineTo(-0.11, 0.2); ctx.closePath(); ctx.fill(); ctx.stroke();
  // Toothy grin (zig-zag band with two square teeth).
  ctx.beginPath();
  ctx.moveTo(-0.5, 0.32);
  ctx.lineTo(-0.34, 0.36); ctx.lineTo(-0.28, 0.5); ctx.lineTo(-0.12, 0.4);
  ctx.lineTo(0.12, 0.4); ctx.lineTo(0.28, 0.5); ctx.lineTo(0.34, 0.36); ctx.lineTo(0.5, 0.32);
  ctx.lineTo(0.4, 0.56); ctx.lineTo(0.16, 0.62);
  ctx.lineTo(0.1, 0.5); ctx.lineTo(-0.1, 0.5);
  ctx.lineTo(-0.16, 0.62); ctx.lineTo(-0.4, 0.56);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

// ============================================================================
// BATCH 3 (operator request): Moon, OK-hand emoji, generic Mouse.
// ============================================================================

// Moon — a pale tinted moon with craters, a phase shadow, soft glow and a
// sleepy "man in the moon" face. (statue)
function drawMoonSkin(ctx, anim, paint) {
  paint = paint || "#cfd2dc";
  var pulse = 0.6 + 0.4 * Math.sin(anim * 1.4);
  // Soft glow.
  var halo = ctx.createRadialGradient(0, 0, 0.72, 0, 0, 1.06);
  halo.addColorStop(0, cartSkinShadeA(paint, 0.6, 0));
  halo.addColorStop(0.82, cartSkinShadeA(paint, 0.65, 0.28 * pulse));
  halo.addColorStop(1, cartSkinShadeA(paint, 0.65, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, 0, 1.06, 0, Math.PI * 2); ctx.fill();
  // Moon disc.
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var g = ctx.createRadialGradient(-0.25, -0.28, 0.1, 0, 0, 1.0);
  g.addColorStop(0, cartSkinShade(paint, 0.55)); g.addColorStop(1, cartSkinShade(paint, 0.05));
  ctx.fillStyle = g; ctx.fill();
  // Craters.
  var craters = [[0.34, -0.32, 0.13], [0.42, 0.28, 0.1], [-0.46, 0.22, 0.12], [0.18, 0.46, 0.08], [0.5, -0.02, 0.07]];
  for (var i = 0; i < craters.length; i++) {
    ctx.fillStyle = cartSkinShadeA(paint, -0.2, 0.45);
    ctx.beginPath(); ctx.arc(craters[i][0], craters[i][1], craters[i][2], 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cartSkinShadeA(paint, 0.5, 0.4); ctx.lineWidth = 0.015;
    ctx.beginPath(); ctx.arc(craters[i][0], craters[i][1], craters[i][2], -2.3, 0.6); ctx.stroke();
  }
  // Phase shadow (right side).
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "rgba(10,14,34,0.34)";
  ctx.beginPath(); ctx.arc(0.62, 0, 0.92, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Sleepy face on the lit (left) side.
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.04; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(-0.36, -0.04, 0.1, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.arc(-0.04, -0.1, 0.1, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.fillStyle = cartSkinShadeA(paint, -0.25, 0.5);
  ctx.beginPath(); ctx.arc(-0.42, 0.16, 0.06, 0, Math.PI * 2); ctx.fill();   // cheek
  ctx.beginPath(); ctx.arc(0.0, 0.12, 0.05, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(-0.2, 0.28, 0.11, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();  // smile
}

// OK-hand emoji (👌) — the actual system emoji glyph, enlarged to fill the cart.
// NOTE: a colour emoji renders in its own palette and does NOT tint to the player
// colour. (statue)
function drawOkSkin(ctx, anim, paint) {
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "1.85px sans-serif";   // ~fills the unit circle
  ctx.fillText("👌", 0, 0.06);
  ctx.restore();
}

// Mouse — TOP-DOWN (like the Dino): head toward +X, long curly tail toward -X,
// round ears, little feet. A generic mouse (NOT Mickey); tints to player colour.
function drawMouseSkin(ctx, anim, paint) {
  paint = paint || "#9aa3ad";
  var dk = cartSkinShade(paint, -0.45);
  var legSwing = Math.sin(anim * 4) * 0.16;
  var tailWag = Math.sin(anim * 2.2) * 0.16;

  // Long thin curly tail (-X).
  ctx.strokeStyle = cartSkinShade(paint, 0.15); ctx.lineWidth = 0.055; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-0.55, 0.02);
  ctx.quadraticCurveTo(-0.92, 0.12 + tailWag, -0.98, -0.2 + tailWag);
  ctx.quadraticCurveTo(-1.0, -0.42 + tailWag, -0.82, -0.46 + tailWag);
  ctx.stroke();

  // Feet (under body), with a little shuffle.
  ctx.fillStyle = cartSkinShade(paint, -0.3);
  var feet = [[0.18, 0.46, legSwing], [-0.28, 0.5, -legSwing], [0.18, -0.46, -legSwing], [-0.28, -0.5, legSwing]];
  for (var i = 0; i < feet.length; i++) {
    ctx.beginPath(); ctx.ellipse(feet[i][0] + feet[i][2], feet[i][1], 0.12, 0.08, 0, 0, Math.PI * 2); ctx.fill();
  }

  // Body.
  ctx.beginPath(); ctx.ellipse(-0.08, 0, 0.55, 0.4, 0, 0, Math.PI * 2);
  var bg = ctx.createRadialGradient(-0.2, -0.15, 0.1, -0.08, 0, 0.7);
  bg.addColorStop(0, cartSkinShade(paint, 0.28)); bg.addColorStop(1, paint);
  ctx.fillStyle = bg; ctx.fill();
  ctx.strokeStyle = dk; ctx.lineWidth = 0.035; ctx.stroke();

  // Ears — two rounded circles atop the head, lighter inner.
  for (var s = -1; s <= 1; s += 2) {
    ctx.beginPath(); ctx.arc(0.46, s * 0.34, 0.22, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShade(paint, 0.05); ctx.fill();
    ctx.strokeStyle = dk; ctx.lineWidth = 0.025; ctx.stroke();
    ctx.beginPath(); ctx.arc(0.5, s * 0.34, 0.12, 0, Math.PI * 2);
    ctx.fillStyle = "#e7a6b8"; ctx.fill();
  }

  // Head (teardrop toward +X with a snout).
  ctx.beginPath(); ctx.ellipse(0.6, 0, 0.34, 0.3, 0, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.12); ctx.fill();
  ctx.strokeStyle = dk; ctx.lineWidth = 0.03; ctx.stroke();
  // Snout tip + pink nose.
  ctx.fillStyle = cartSkinShade(paint, 0.2);
  ctx.beginPath(); ctx.moveTo(0.86, -0.12); ctx.quadraticCurveTo(1.02, 0, 0.86, 0.12); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#e26d8a";
  ctx.beginPath(); ctx.arc(0.96, 0, 0.06, 0, Math.PI * 2); ctx.fill();

  // Eyes (small, top-down).
  ctx.fillStyle = "#1c1208";
  ctx.beginPath(); ctx.arc(0.66, -0.13, 0.06, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.66, 0.13, 0.06, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath(); ctx.arc(0.68, -0.15, 0.02, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.68, 0.11, 0.02, 0, Math.PI * 2); ctx.fill();

  // Whiskers from the snout.
  ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 0.014;
  for (var w = -1; w <= 1; w += 2) {
    ctx.beginPath(); ctx.moveTo(0.86, w * 0.06); ctx.lineTo(1.12, w * 0.02); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0.86, w * 0.08); ctx.lineTo(1.1, w * 0.16); ctx.stroke();
  }
}

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
    explosionIcon, moonIcon, scissorsIcon, starIcon, randomTileIcon,
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
    gameContext.shadowBlur = glowBlur(12 + 12 * pulse);
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
        // id keys the per-player smoothed look-ahead state; vx/vy feed it.
        pts.push({ id: living[i].id, x: living[i].x, y: living[i].y, vx: living[i].velX || 0, vy: living[i].velY || 0 });
    }
    if (pts.length === 0 && myPlayer && myPlayer.alive) {
        pts.push({ id: myPlayer.id, x: myPlayer.x, y: myPlayer.y, vx: myPlayer.velX || 0, vy: myPlayer.velY || 0 });
    }
    return pts;
}

// The fully-focused view: the DESIRED (unclamped) centre + zoom that frames every
// live local player (local co-op widens the zoom as players spread, tightens as
// they cluster). Each player contributes a max-zoom half-box, shifted ahead along
// their velocity (look-ahead) so the tight cruise zoom keeps forward visibility.
// Near the nearest goal the zoom cap ramps up (finish-line punch-in) while the
// goal itself stays framed — the close-up only lands once everyone framed has
// converged on it. Centre is kept separate from the zoom so a transition can
// ramp only the zoom (players can't slide out of frame).
// gatedNow is computed ONCE in computeWorldViewTarget and threaded through so the
// gated behaviors here (goal framing suppressed, look-ahead zeroed) can never
// drift out of sync with the gated handling in updateWorldCamera.
function computeFocusedView(dt, gatedNow) {
    var wholeMap = { cx: LOGICAL_WIDTH / 2, cy: LOGICAL_HEIGHT / 2, scale: 1 };
    var pts = focusWorldPoints();
    if (pts.length === 0) {
        // Nobody local alive to follow -> whole map (watch the action). Drop the
        // smoothed look-ahead so it can't carry stale lead into the next round.
        worldLeadSmooth = {};
        return wholeMap;
    }
    // Nearest goal (to any framed player) first: its distance drives the dynamic
    // zoom cap below, so it must be known before the framing boxes are sized.
    var goals = worldGoalPoints();
    var ng = null, nd = Infinity;
    for (var g = 0; g < goals.length; g++) {
        for (var p = 0; p < pts.length; p++) {
            var dx = goals[g].x - pts[p].x, dy = goals[g].y - pts[p].y;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < nd) { nd = d; ng = goals[g]; }
        }
    }
    // Goal-framing weight: blends the goal into the framing box continuously —
    // 1 within ENGAGE, fading to 0 by RELEASE. Continuity matters because the
    // gate-countdown ramp follows the target directly (a=1): a binary engage
    // latch made the target scale STEP the instant the goal popped in/out of
    // the box, which read as a sudden zoom jerk in the gated view.
    // Suppressed entirely while GATED: the intro arc's opening close-up (and its
    // snap) consume this view directly, and on the many maps whose spawn gate
    // sits within RELEASE of a goal the blend would offset/widen what is meant
    // to be a tight shot of YOUR kart. The goal blends back in smoothly once
    // racing starts (the racing path's exponential smoothing absorbs it).
    var w = 0;
    if (ng && !gatedNow) {
        w = smoothstep(1 - (nd - WORLD_ZOOM_ENGAGE) / (WORLD_ZOOM_RELEASE - WORLD_ZOOM_ENGAGE));
    }
    // Finish-line punch-in: raise the zoom cap from WORLD_ZOOM_MAX toward
    // (MAX + BOOST) as the group closes from ENGAGE down to GOAL_FULL.
    // Smoothstepped (and 0 at/beyond ENGAGE, so it's continuous with w), and
    // the goal + every player stay inside the framing box below, so the fit
    // only reaches the boosted cap once everyone has actually converged on the
    // goal — the last stretch reads as a lunge. Suppressed while gated for the
    // same reason as the blend above (also keeps the gated ease-in's peak rate
    // comfortably under WORLD_ZOOM_GATE_RATE — boosted targets never reach it).
    var effMax = WORLD_ZOOM_MAX;
    if (ng && !gatedNow) {
        effMax += WORLD_ZOOM_GOAL_BOOST * smoothstep((WORLD_ZOOM_ENGAGE - nd) / (WORLD_ZOOM_ENGAGE - WORLD_ZOOM_GOAL_FULL));
    }
    var halfX = LOGICAL_WIDTH / (2 * effMax);
    var halfY = LOGICAL_HEIGHT / (2 * effMax);
    // Velocity look-ahead: each player's half-box is centred ahead of them along
    // a SMOOTHED lead vector (its own exponential lag, per player), so steering
    // wiggle, punches and bounces swing the lead gently instead of snapping the
    // camera. While GATED the lead state is hard-zeroed (not just decayed):
    // the intro snaps the camera to this frame's target on gated entry, so a
    // stale lobby lead would anchor the spawn close-up off-centre on the
    // lobby -> first-race path. Players just rev in the pen anyway, and the
    // lead still builds naturally from zero off the line.
    var la = 1 - Math.exp(-(dt || 16) / WORLD_ZOOM_LEAD_TAU);
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
        var tx = 0, ty = 0;
        var spd = Math.sqrt(pts[i].vx * pts[i].vx + pts[i].vy * pts[i].vy);
        if (!gatedNow && spd > 1) {
            // Lead scales with speed up to full cruise (LEAD_REF), and is also
            // capped at LEAD_BOX_FRAC of the (zoom-dependent) half-box so the
            // goal punch-in's tighter box can't shove a fast kart to the screen
            // edge — at least (1 - LEAD_BOX_FRAC) of the half-box always stays
            // behind them.
            var lead = Math.min(WORLD_ZOOM_LEAD_MAX, halfY * WORLD_ZOOM_LEAD_BOX_FRAC) * clamp01(spd / WORLD_ZOOM_LEAD_REF);
            tx = pts[i].vx / spd * lead;
            ty = pts[i].vy / spd * lead;
        }
        var sm = worldLeadSmooth[pts[i].id];
        if (!sm) { sm = worldLeadSmooth[pts[i].id] = { x: 0, y: 0 }; }
        if (gatedNow) {
            sm.x = 0; sm.y = 0;
        } else {
            sm.x += (tx - sm.x) * la;
            sm.y += (ty - sm.y) * la;
        }
        // Clamp the led point to the world so ramming a wall can't inflate the box.
        var lx = Math.max(world.x, Math.min(world.x + world.width, pts[i].x + sm.x));
        var ly = Math.max(world.y, Math.min(world.y + world.height, pts[i].y + sm.y));
        minX = Math.min(minX, lx - halfX);
        maxX = Math.max(maxX, lx + halfX);
        minY = Math.min(minY, ly - halfY);
        maxY = Math.max(maxY, ly + halfY);
    }
    if (w > 0) {
        // Stretch each box edge toward the goal pad by the blend weight — at
        // w=1 the goal is fully framed (same as the old hard include), and the
        // approach/retreat over the ENGAGE..RELEASE band is perfectly smooth.
        minX -= Math.max(0, minX - (ng.x - WORLD_ZOOM_PAD)) * w;
        maxX += Math.max(0, (ng.x + WORLD_ZOOM_PAD) - maxX) * w;
        minY -= Math.max(0, minY - (ng.y - WORLD_ZOOM_PAD)) * w;
        maxY += Math.max(0, (ng.y + WORLD_ZOOM_PAD) - maxY) * w;
    }
    var boxW = Math.max(1, maxX - minX), boxH = Math.max(1, maxY - minY);
    var scale = Math.min(LOGICAL_WIDTH / boxW, LOGICAL_HEIGHT / boxH);
    scale = Math.max(1, Math.min(effMax, scale)); // never zoom out past the whole map
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
        worldLeadSmooth = {};
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
        worldLeadSmooth = {};
        return wholeMap;
    }
    // Advance the gate-intro clock ONLY while in the gated countdown, and zero it
    // on every other frame. The lobby/racing/collapsing follow-camera also counts
    // as "focused", so a single shared clock would keep ticking the whole time you
    // sit in the lobby — and the first race goes straight lobby -> gated with no
    // overview to reset it, saturating the ramp below so the camera opens already
    // fully zoomed instead of easing in from the whole-map overview. Zeroing it
    // whenever we're not gated makes the intro play on EVERY entry into the gate
    // (first race out of the lobby, and later rounds out of overview alike).
    // Frame-dt (already clamped) not wall-clock, so a backgrounded tab pauses it.
    var gatedNow = (currentState === config.stateMap.gated);
    if (gatedNow) {
        worldViewFocusedElapsed += (dt || 16);
    } else {
        worldViewFocusedElapsed = 0;
    }
    var focusedView = computeFocusedView(dt, gatedNow);

    // During the gate countdown, run a slow, eased camera arc timed to the
    // countdown — anchored on YOUR SPAWN, not the map centre: open tight on the
    // kart (admire the skin / find yourself), pan OUT from the spawn to reveal
    // the whole arena (take in the layout + goal), then ease back into the
    // focused zoom, landing exactly as the gate opens. e is the "how focused"
    // weight (1 = tight, 0 = whole map); the centre stays anchored on the
    // player (clamped to the world) throughout — at scale 1 the clamp shows the
    // whole map, and it homes back in on the player as it re-zooms, so the
    // player can never slide out of frame mid-transition. (The very first gated
    // frame snaps the camera to this close-up in updateWorldCamera — the world
    // isn't visible during the overview scoreboard, so the cut is invisible.)
    if (gatedNow) {
        // The cinematic only runs when the camera actually witnessed the gate
        // ENTRY (worldGatedIntroActive, managed in updateWorldCamera). If the
        // dynamic camera was toggled on mid-countdown there is no hidden frame
        // to cut on — replaying the arc would hard-CUT to the close-up with the
        // world fully visible — so just frame the karts like racing and let the
        // exponential smoothing glide there.
        if (!worldGatedIntroActive) {
            return clampViewToWorld(focusedView.cx, focusedView.cy, focusedView.scale);
        }
        var rest = ((config.gatedWaitTime || 9) * 1000) - WORLD_ZOOM_HOLD_MS;
        var tt = worldViewFocusedElapsed - WORLD_ZOOM_HOLD_MS;
        var e = 1; // hold phase (and degenerate configs): stay tight on the spawn
        if (rest > 0 && tt > 0) {
            var outMs = rest * WORLD_ZOOM_GATE_OUT_FRAC;
            var inMs = rest * WORLD_ZOOM_GATE_IN_FRAC;
            if (tt < outMs) {
                e = 1 - smoothstep(tt / outMs);           // pan out from the spawn
            } else if (tt >= rest - inMs) {
                e = smoothstep((tt - (rest - inMs)) / inMs); // ease back in
            } else {
                e = 0;                                    // whole-map beat
            }
        }
        var scale = 1 + (focusedView.scale - 1) * e;
        return clampViewToWorld(focusedView.cx, focusedView.cy, scale);
    }
    // Back the camera off while aiming/throwing an aimed ability (bomb/ice) so
    // it's easier to aim and follow the shot; the smoothing eases it out and back.
    var racingScale = focusedView.scale;
    if (localAimedAbilityActive()) {
        racingScale = Math.max(1, racingScale * AIM_ZOOM_OUT_FACTOR);
    }
    // Star Power FOV: while a local star is live, curve the view wider with a
    // slow breathing wobble; the exponential smoothing below (WORLD_ZOOM_TAU)
    // turns both the onset and the release into a gentle glide.
    if (localStarPowerUntil() > 0) {
        racingScale = Math.max(1, racingScale * (STAR_ZOOM_OUT_FACTOR + 0.03 * Math.sin(Date.now() / 480)));
    }
    return clampViewToWorld(focusedView.cx, focusedView.cy, racingScale);
}

function updateWorldCamera(dt) {
    // Clamp the frame delta so a long stall / tab-refocus catch-up frame can't
    // snap the camera (drives both the gate ramp and the exponential smoothing).
    var cdt = Math.min(dt || 16, 100);
    // --- gate-intro lifecycle (BEFORE the target is computed, so the arc-vs-
    // plain-focus choice inside computeWorldViewTarget sees fresh flags). The
    // STATE transition is tracked independently of the camera toggle: the intro
    // (snap cut + a=1 arc) only arms when the camera was already on at the
    // moment the gated state began — that's the frame hidden behind the
    // overview scoreboard / lobby->arena map swap, the only frame where a hard
    // cut is invisible. Toggling the camera off mid-countdown disarms it for
    // the rest of that countdown, so re-enabling can never re-fire the cut
    // with the world on screen (it glides via the smoothing instead).
    var stateGated = (typeof config !== "undefined" && config && currentState === config.stateMap.gated);
    var freshGate = stateGated && !worldViewGatedPrev;
    worldViewGatedPrev = stateGated;
    if (freshGate) {
        worldGatedIntroActive = cameraZoomEnabled;
    } else if (!stateGated || !cameraZoomEnabled) {
        worldGatedIntroActive = false;
    }
    var followArc = (cameraZoomEnabled && stateGated && worldGatedIntroActive);
    var target = computeWorldViewTarget(cdt);
    if (worldView == null) {
        // The init IS the snap if we're born into gated (target is already the
        // arc's opening close-up).
        worldView = { cx: target.cx, cy: target.cy, scale: target.scale };
        return;
    }
    if (freshGate && followArc) {
        // First gated frame: CUT straight to the spawn close-up the arc opens
        // on. Invisible — the world isn't drawn during the overview scoreboard,
        // and the first race swaps the whole map (lobby -> arena) on this frame
        // anyway. Without the snap the camera would visibly glide in from
        // wherever the previous state left it before the pan-out could begin.
        worldView.cx = target.cx; worldView.cy = target.cy; worldView.scale = target.scale;
    }
    // While the intro arc runs, the target is a precise, eased time-ramp — follow
    // it directly (a=1) so it finishes exactly as the gate opens. Everywhere else
    // (racing, lobby, and a mid-countdown camera re-enable) smooth exponentially.
    var a = followArc ? 1 : (1 - Math.exp(-cdt / WORLD_ZOOM_TAU));
    worldView.cx += (target.cx - worldView.cx) * a;
    worldView.cy += (target.cy - worldView.cy) * a;
    if (followArc) {
        // Direct follow, but rate-limited: the ramp itself moves the scale far
        // slower than this cap, so the cap is invisible in the normal arc — it
        // only bites when the FOCUSED target moves abruptly mid-countdown (a
        // death changing the framed group), turning what would be a visible
        // zoom jerk into a quick glide.
        var ds = target.scale - worldView.scale;
        var maxStep = WORLD_ZOOM_GATE_RATE * cdt / 1000;
        worldView.scale += Math.max(-maxStep, Math.min(maxStep, ds));
    } else {
        worldView.scale += (target.scale - worldView.scale) * a;
    }
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
// --- gameOver medals card ------------------------------------------------
// Persistent reveal clock for the end-of-game medals card. The startGameover
// handler bumps `medalRevealNonce` each match; drawGameOverScreen restarts its
// staggered entrance whenever the nonce it last drew differs (so even a repeat
// winner replays the animation). drawGameOverScreen runs every tick, hence the
// latch rather than a per-frame reset.
var medalRevealNonce = 0;
var medalRevealFor = null;
var medalRevealElapsed = 0;
// One-line, player-facing blurb shown under each medal name on the gameOver card.
// Keyed by the achievement key the server sends (see server/achievements.js); the
// meanings mirror how the stats are earned in server/{game,entities/player}.js.
var MEDAL_DESC = {
    mostKills: "Most eliminations",
    savior: "Toppled a frontrunner",
    survivalist: "Reached the most goals",
    brutalist: "Most goals in brutal rounds",
    mostMurdered: "Everyone's favourite target",
    resourceful: "Used the most abilities",
    bully: "Threw the most punches",
    doubleKill: "Two kills in a flash",
    tripleKill: "Three kills in a flash",
    megaKill: "A relentless killing spree",
    zombieSlayer: "Most kills as a zombie",
    heavyHitter: "Most charged-up punches",
    pinball: "Bounced off the most bumpers",
    iceSkater: "Slid the furthest on ice"
};
// Per-medal glyph stamped into the gold disc, so each award reads at a glance.
// Mirrors the icons on the Learn/Codex medals page (client/scripts/learn.js).
var MEDAL_ICON = {
    mostKills: "🔪",
    savior: "🛡️",
    survivalist: "🏁",
    brutalist: "🔥",
    mostMurdered: "🎯",
    resourceful: "🧰",
    bully: "👊",
    doubleKill: "💥",
    tripleKill: "💥",
    megaKill: "💥",
    zombieSlayer: "🧟",
    heavyHitter: "🥊",
    pinball: "🔵",
    iceSkater: "⛸️"
};

// Rounded-rect path builder (caller fills/strokes it).
function gameOverRoundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// A small gold medal disc with a ribbon + embossed star, used as the marker
// on the medals card. cx/cy is the disc centre; r its radius.
function drawMedalDisc(ctx, cx, cy, r, icon) {
    ctx.save();
    // Ribbon tails tucked behind the disc.
    ctx.fillStyle = "#c8423a";
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.55, cy - r * 0.2);
    ctx.lineTo(cx - r * 0.15, cy + r * 1.5);
    ctx.lineTo(cx + r * 0.15, cy + r * 0.9);
    ctx.lineTo(cx - r * 0.05, cy + r * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#e0584f";
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.55, cy - r * 0.2);
    ctx.lineTo(cx + r * 0.15, cy + r * 1.5);
    ctx.lineTo(cx - r * 0.15, cy + r * 0.9);
    ctx.lineTo(cx + r * 0.05, cy + r * 0.2);
    ctx.closePath();
    ctx.fill();
    // Disc: warm gold radial.
    var grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.2, cx, cy, r);
    grad.addColorStop(0, "#fff2b0");
    grad.addColorStop(0.5, "#f6c64b");
    grad.addColorStop(1, "#b9831f");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.strokeStyle = "rgba(120,80,10,0.85)";
    ctx.stroke();
    // Center mark: the medal's own emoji glyph when given, else an embossed star.
    if (icon) {
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = (r * 1.4) + "px serif";
        ctx.fillText(icon, cx, cy + r * 0.08);
        ctx.restore();
    } else {
        ctx.fillStyle = "rgba(140,92,10,0.9)";
        ctx.beginPath();
        for (var s = 0; s < 5; s++) {
            var ang = -Math.PI / 2 + s * (2 * Math.PI / 5);
            var ax = cx + Math.cos(ang) * r * 0.5;
            var ay = cy + Math.sin(ang) * r * 0.5;
            if (s === 0) { ctx.moveTo(ax, ay); } else { ctx.lineTo(ax, ay); }
            var ang2 = ang + Math.PI / 5;
            ctx.lineTo(cx + Math.cos(ang2) * r * 0.22, cy + Math.sin(ang2) * r * 0.22);
        }
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
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
        // Collect only the medals actually earned this match so the card can be
        // sized + vertically centred around real content (skip empty medals).
        var earnedMedals = [];
        for (var medal in achievements) {
            var a = achievements[medal];
            if (a.ids && a.ids.length > 0) {
                earnedMedals.push({ title: a.title, ids: a.ids, desc: MEDAL_DESC[medal] || "", icon: MEDAL_ICON[medal] || "" });
            }
        }

        if (earnedMedals.length > 0) {
            // Reveal clock: reset when a new match's winner is shown so the
            // staggered entrance replays each game. `medalRevealNonce` is bumped by
            // the startGameover handler so a repeat winner (same playerWon) still
            // restarts the animation. dt is MILLISECONDS (Date.now() delta) — the
            // thresholds below are in seconds, so convert here.
            if (medalRevealFor !== medalRevealNonce) {
                medalRevealFor = medalRevealNonce;
                medalRevealElapsed = 0;
            }
            medalRevealElapsed += (dt || 0) / 1000;

            // Card geometry, anchored to the right edge so it never overlaps the
            // recap montage (which owns the left/centre of the screen).
            var rowH = 58;
            var headH = 58;
            var padX = 24;
            var padTop = 20;
            var padBot = 22;
            var cardW = 430;
            var cardH = padTop + headH + earnedMedals.length * rowH + padBot;
            var cardX = LOGICAL_WIDTH - cardW - 40;
            // Scale-to-fit: a full house of medals can be taller than the screen, so
            // shrink the whole card uniformly to fit within top/bottom margins. The
            // scale pivots on the card's right edge + vertical centre below, so it
            // stays right-anchored and centred while it shrinks.
            var topMargin = 24;
            var availH = LOGICAL_HEIGHT - topMargin * 2;
            var cardScale = (cardH > availH) ? (availH / cardH) : 1;
            // Centre on-screen; when not scaling keep the old min-top-margin clamp.
            var cardY = (LOGICAL_HEIGHT - cardH) / 2;
            if (cardScale === 1) { cardY = Math.max(topMargin, cardY); }

            // Card entrance: quick fade + rise.
            var cardT = Math.min(1, medalRevealElapsed / 0.28);
            var cardEase = 1 - Math.pow(1 - cardT, 3);

            gameContext.save();
            gameContext.textBaseline = "alphabetic";
            gameContext.globalAlpha = cardEase;
            gameContext.translate(0, (1 - cardEase) * 16);
            // Apply the fit scale around the card's right edge + vertical centre.
            if (cardScale !== 1) {
                var pivotX = cardX + cardW;
                var pivotY = LOGICAL_HEIGHT / 2;
                gameContext.translate(pivotX, pivotY);
                gameContext.scale(cardScale, cardScale);
                gameContext.translate(-pivotX, -pivotY);
            }

            // Panel: dark translucent so the fixed light text stays readable on
            // any winner colour, with a soft drop shadow.
            gameContext.save();
            gameContext.shadowColor = "rgba(0,0,0,0.45)";
            gameContext.shadowBlur = 24;
            gameContext.shadowOffsetY = 8;
            gameOverRoundRect(gameContext, cardX, cardY, cardW, cardH, 18);
            gameContext.fillStyle = "rgba(18,20,28,0.86)";
            gameContext.fill();
            gameContext.restore();

            // Gold border.
            gameOverRoundRect(gameContext, cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1, 18);
            gameContext.lineWidth = 1.5;
            gameContext.strokeStyle = "rgba(246,198,75,0.55)";
            gameContext.stroke();

            // Header: trophy disc + "MEDALS" + subtitle, divider beneath.
            var headBaseY = cardY + padTop;
            drawMedalDisc(gameContext, cardX + padX + 15, headBaseY + 16, 15, "🏆");
            gameContext.textAlign = "left";
            gameContext.fillStyle = "#f6c64b";
            gameContext.font = "bold 26px Arial";
            gameContext.fillText("MEDALS", cardX + padX + 42, headBaseY + 22);
            gameContext.fillStyle = "rgba(220,226,236,0.6)";
            gameContext.font = "13px Arial";
            gameContext.fillText("Match awards", cardX + padX + 42, headBaseY + 40);
            gameContext.beginPath();
            gameContext.moveTo(cardX + padX, cardY + padTop + headH - 8);
            gameContext.lineTo(cardX + cardW - padX, cardY + padTop + headH - 8);
            gameContext.lineWidth = 1;
            gameContext.strokeStyle = "rgba(255,255,255,0.12)";
            gameContext.stroke();

            // Medal rows: each fades + slides in, staggered after the card.
            var rowTop = cardY + padTop + headH;
            for (var m = 0; m < earnedMedals.length; m++) {
                var rowT = Math.min(1, Math.max(0, (medalRevealElapsed - 0.18 - m * 0.09) / 0.34));
                var rowEase = 1 - Math.pow(1 - rowT, 3);
                if (rowEase <= 0) { continue; }

                var rowCy = rowTop + m * rowH + rowH / 2;

                gameContext.save();
                gameContext.globalAlpha = cardEase * rowEase;
                gameContext.translate((1 - rowEase) * 22, 0);

                // Medal marker with the award's own icon.
                drawMedalDisc(gameContext, cardX + padX + 14, rowCy - 2, 13, earnedMedals[m].icon);

                // Title + one-line description. With a description, the two lines
                // straddle the row centre; without one, the title sits centred.
                var textX = cardX + padX + 38;
                gameContext.textAlign = "left";
                if (earnedMedals[m].desc) {
                    gameContext.fillStyle = "#eef2f8";
                    gameContext.font = "bold 19px Arial";
                    gameContext.fillText(earnedMedals[m].title, textX, rowCy - 3);
                    gameContext.fillStyle = "rgba(220,226,236,0.6)";
                    gameContext.font = "12px Arial";
                    gameContext.fillText(earnedMedals[m].desc, textX, rowCy + 15);
                } else {
                    gameContext.fillStyle = "#eef2f8";
                    gameContext.font = "bold 19px Arial";
                    gameContext.fillText(earnedMedals[m].title, textX, rowCy + 5);
                }

                // Winner chips, right-aligned. Cap the visible chips and show a
                // "+N" overflow tag so a popular medal can't run off the card.
                var ids = earnedMedals[m].ids;
                var chipR = 11;
                var chipGap = 28;
                var maxChips = 4;
                var shown = Math.min(ids.length, maxChips);
                var chipRight = cardX + cardW - padX - chipR;
                for (var c = 0; c < shown; c++) {
                    var chipX = chipRight - (shown - 1 - c) * chipGap;
                    var cp = playerList[ids[c]];
                    gameContext.beginPath();
                    gameContext.arc(chipX, rowCy, chipR, 0, 2 * Math.PI);
                    gameContext.fillStyle = (cp != null) ? cp.color : "#7a7a7a";
                    gameContext.fill();
                    gameContext.lineWidth = 2;
                    gameContext.strokeStyle = "rgba(255,255,255,0.85)";
                    gameContext.stroke();
                }
                if (ids.length > maxChips) {
                    var firstChipX = chipRight - (shown - 1) * chipGap;
                    gameContext.textAlign = "right";
                    gameContext.fillStyle = "rgba(220,226,236,0.75)";
                    gameContext.font = "bold 13px Arial";
                    gameContext.fillText("+" + (ids.length - maxChips), firstChipX - chipR - 8, rowCy + 5);
                }

                gameContext.restore();
            }

            gameContext.restore();
        }
    }

    // Recap montage overlay. Guarded so a replay-render error can never break
    // the (load-bearing) gameOver screen — worst case the medals show alone.
    try {
        recapDraw(dt || 0);
    } catch (e) {
        debugLog("recap draw error", e);
    }

    // "Rate this map" star widget, pinned bottom-centre. Guarded for the same
    // reason as the recap — it must never take down the game-over screen.
    // (The rewarded "2× XP" offer is intentionally NOT here — it would compete with the
    // recap/stats for the player's attention. It's a prompt at the gameOver -> lobby edge
    // instead; see the startLobby handler in client.js.)
    try {
        drawMapRating();
    } catch (e) {
        debugLog("rating draw error", e);
    }

}

// A 5-star "rate this map" strip pinned bottom-centre. Shown on the per-round
// overview (rate the map you just played) and the match-over screen. Records per-star
// hit rects into ratingStarHits (logical coords) for input.js to test. Click/tap a
// star to vote (one vote per map; re-voting overwrites). No-op render when the server
// didn't tell us which map to rate.
function drawMapRating(cxOverride, bottomY, fixedW) {
    if (typeof ratingMapId === "undefined" || ratingMapId == null) {
        ratingStarHits = [];
        return;
    }
    // Centre/bottom by default (game-over); callers can override both (the overview
    // pins it to a full-width bottom strip via fixedW).
    var cx = (typeof cxOverride === "number") ? cxOverride : LOGICAL_WIDTH / 2;
    var n = 5, starSize = 36, gap = 8;
    var rowW = n * starSize + (n - 1) * gap;
    // Name the map explicitly so it's clear you're rating the map you JUST PLAYED,
    // not the next-map preview shown right below on the overview.
    var rated = (myMapRating > 0);
    var mapLabel = ratingMapName ? ("“" + ratingMapName + "”") : "the map you just played";
    var label = rated
        ? ("Thanks! You rated " + mapLabel + " " + myMapRating + "/5")
        : (ratingMapName ? ("Rate the map you just played: " + mapLabel) : "Rate the map you just played");

    gameContext.save();
    gameContext.font = "bold 15px sans-serif";
    gameContext.textAlign = "center";
    var tw = gameContext.measureText(label).width;
    // fixedW (overview strip) gives an explicit wide panel; otherwise size to content.
    var panelW = (typeof fixedW === "number") ? fixedW : Math.max(tw + 44, rowW + 44);
    var panelH = 78;
    var px = cx - panelW / 2;
    var py = (typeof bottomY === "number") ? (bottomY - panelH) : (LOGICAL_HEIGHT - panelH - 16);

    // panel chrome — drawn for the game-over screen (no fixedW), but the overview
    // strip (fixedW set) stays borderless so it breathes with the rest of the page.
    var chrome = (typeof fixedW !== "number");
    if (chrome) {
        gameContext.globalAlpha = 0.88;
        gameContext.fillStyle = "rgba(18,20,26,0.9)";
        drawRoundRectPath(px, py, panelW, panelH, 12);
        gameContext.fill();
        gameContext.globalAlpha = 1;
        gameContext.lineWidth = 2;
        gameContext.strokeStyle = "#FFCB30";
        gameContext.stroke();
    }

    // label
    gameContext.fillStyle = "#fff";
    gameContext.textBaseline = "middle";
    gameContext.fillText(label, cx, py + 20);

    // stars row
    ratingStarHits = [];
    var startX = cx - rowW / 2;
    var starY = py + 50;
    // Controller mode: highlight the pad-selected star (◄ ► to move, Ⓐ to confirm) while
    // it hasn't been voted yet. Touch/mouse users tap directly and see no cursor.
    var padActive = (typeof activeInputMethod !== "undefined" && activeInputMethod === "pad");
    var showCursor = padActive && myMapRating === 0 && ratingPadCursor >= 1 && ratingPadCursor <= 5;
    for (var i = 0; i < n; i++) {
        var sx = startX + i * (starSize + gap);
        var filled = (i < myMapRating);
        gameContext.textBaseline = "middle";
        gameContext.textAlign = "center";
        gameContext.font = (starSize - 4) + "px sans-serif";
        gameContext.fillStyle = filled ? "#FFCB30" : "rgba(255,255,255,0.4)";
        gameContext.fillText(filled ? "★" : "☆", sx + starSize / 2, starY);
        if (showCursor && (i + 1) === ratingPadCursor) {
            gameContext.strokeStyle = "#FFCB30";
            gameContext.lineWidth = 2;
            gameContext.strokeRect(sx - 2, starY - starSize / 2 - 2, starSize + 4, starSize + 4);
        }
        ratingStarHits.push({ x: sx, y: starY - starSize / 2, w: starSize, h: starSize, stars: i + 1 });
    }
    gameContext.restore();
}

// Local rounded-rect path helper (draw.js has no shared one in this scope).
function drawRoundRectPath(x, y, w, h, r) {
    gameContext.beginPath();
    gameContext.moveTo(x + r, y);
    gameContext.arcTo(x + w, y, x + w, y + h, r);
    gameContext.arcTo(x + w, y + h, x, y + h, r);
    gameContext.arcTo(x, y + h, x, y, r);
    gameContext.arcTo(x, y, x + w, y, r);
    gameContext.closePath();
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
    // Log it for the end-of-game recap so the punch's shockwave replays in clips
    // (the recap can't re-run live closures — it redraws from this effect record).
    if (typeof recapMarkEffect === "function") {
        recapMarkEffect("punch", px, py, { radius: baseRadius, color: color });
    }
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
    if (typeof recapMarkEffect === "function") {
        recapMarkEffect("clash", x, y, {});
    }
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
    if (typeof recapMarkEffect === "function") {
        recapMarkEffect("hit", x, y, { color: color });
    }
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
            ctx.shadowBlur = glowBlur(12 * (1 - t));
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

    if (hasAnyKey(aimerList)) {
        for (var id in aimerList) {
            drawAimer(aimerList[id]);
        }
    }

    // A Star Power holder is immune to the blindfold: on a couch co-op screen the
    // overlay is shared, so any living local starred kart lifts it for the screen
    // (mirrors the server-side bot exemption in aiController.isBlinded).
    if (blindfold.color != null && localStarPowerInfo() == null) {
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

// Truncate text with an ellipsis so it fits maxW in the CURRENT gameContext
// font (binary search on the cut point). Guards the measureText-sized HUD
// panels (map announcement/plaque, lobby banners) against user-authored
// strings — a long map name must shrink the text, never the layout.
function hudEllipsize(text, maxW) {
    text = "" + text;
    if (gameContext.measureText(text).width <= maxW) { return text; }
    var lo = 0, hi = text.length;
    while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (gameContext.measureText(text.slice(0, mid) + "…").width <= maxW) { lo = mid; } else { hi = mid - 1; }
    }
    return text.slice(0, lo) + "…";
}

// ---- Round-start map announcement -------------------------------------------
// A prominent lower-third title card ("Map Name" / "by author") at the start of
// every round, so the map credit is actually seen (the corner plaque stays as a
// subtle persistent reference). Spatially clear of the centre-screen brutal
// round card, AND when a brutal round is announcing, the map card additionally
// waits until the brutal card's hold ends (~2.6s) so the two reveals sequence
// instead of competing for attention.
var mapAnnounceKey = null;
var mapAnnounceStart = null;
function drawMapAnnouncement() {
    if (currentMap == null) { return; }
    var inRace = currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing;
    if (!inRace) {
        mapAnnounceKey = null; // re-arm for the next round
        return;
    }
    var key = round + ":" + currentMap.name;
    if (key !== mapAnnounceKey) {
        mapAnnounceKey = key;
        mapAnnounceStart = Date.now() + (brutalRound ? 2600 : 0);
    }
    var e = Date.now() - mapAnnounceStart;
    var inMs = 320, holdMs = 2400, outMs = 700;
    if (e < 0 || e > inMs + holdMs + outMs) { return; }
    var alpha, rise;
    if (e < inMs) {
        var p = e / inMs;
        alpha = clamp01(p);
        rise = (1 - easeOutBack(p)) * 26; // slide up into place with overshoot
    } else if (e < inMs + holdMs) {
        alpha = 1;
        rise = 0;
    } else {
        var fp = (e - inMs - holdMs) / outMs;
        alpha = clamp01(1 - fp);
        rise = -10 * fp; // gentle drift up as it fades
    }
    var nameFont = "bold 34px sans-serif";
    var creditFont = "16px sans-serif";
    var maxTextW = LOGICAL_WIDTH * 0.66; // cap so user-authored names can't push the card off-screen
    gameContext.save();
    gameContext.font = nameFont;
    var name = hudEllipsize(currentMap.name, maxTextW);
    var nw = gameContext.measureText(name).width;
    gameContext.font = creditFont;
    var credit = hudEllipsize("by " + currentMap.author, maxTextW);
    var cw = gameContext.measureText(credit).width;
    var w = Math.max(nw, cw) + 64;
    var h = 78;
    var cx = LOGICAL_WIDTH / 2;
    var top = LOGICAL_HEIGHT * 0.74 + rise;
    drawHudPanel(cx - w / 2, top, w, h, { alpha: 0.88 * alpha, borderAlpha: alpha });
    var ink = themeColor('ink', 'black');
    gameContext.globalAlpha = alpha;
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    gameContext.fillStyle = ink;
    gameContext.font = nameFont;
    gameContext.fillText(name, cx, top + 38);
    gameContext.globalAlpha = 0.7 * alpha;
    gameContext.font = creditFont;
    gameContext.fillText(credit, cx, top + 62);
    gameContext.restore();
}

// Bottom-left map credit: the map's name (bold) over a dimmed "by <author>"
// line. Frameless (operator preference — no corner box): the ink/ink-outline
// stroke treatment keeps it readable over busy terrain, matching the top
// session readout. Fades with the rest of the persistent chrome once racing.
function drawMapTitle() {
    if (currentMap == null) {
        return;
    }
    var nameFont = "bold 15px sans-serif";
    var creditFont = "11px sans-serif";
    var maxTextW = 300; // corner credit stays in the corner, whatever the map is called
    var ink = themeColor('ink', 'black');
    var outline = themeColor('inkOutline', 'white');
    var fade = hudChromeAlpha();
    gameContext.save();
    gameContext.font = nameFont;
    var name = hudEllipsize(currentMap.name, maxTextW);
    gameContext.font = creditFont;
    var credit = hudEllipsize("by " + currentMap.author, maxTextW);
    var x = 12;
    gameContext.textAlign = "left";
    gameContext.textBaseline = "alphabetic";
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = outline;
    gameContext.fillStyle = ink;
    gameContext.font = nameFont;
    gameContext.globalAlpha = fade;
    gameContext.strokeText(name, x, LOGICAL_HEIGHT - 27);
    gameContext.fillText(name, x, LOGICAL_HEIGHT - 27);
    gameContext.globalAlpha = 0.7 * fade;
    gameContext.font = creditFont;
    gameContext.strokeText(credit, x, LOGICAL_HEIGHT - 12);
    gameContext.fillText(credit, x, LOGICAL_HEIGHT - 12);
    gameContext.restore();
}

// Accumulated time (seconds) driving cart-skin animation (fire-truck wheel spin,
// dino leg cycle). Advanced once per frame in drawPlayers, NOT per player.
var cartSkinAnimTime = 0;
// Set of player ids currently targeted by some aimer (telegraph). Rebuilt once
// per frame in drawPlayers so drawPlayer can do an O(1) lookup instead of an
// O(aimers) for-in + targetList.indexOf per kart per frame.
// Cheap "is this object/map non-empty?" test — stops at the first key instead of
// allocating a throwaway array like Object.keys(o).length does each frame.
function hasAnyKey(o) {
    if (o == null) { return false; }
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { return true; } }
    return false;
}
// perfGlow-gated shadowBlur amount: n when glow is on (or perf.js is absent, which
// means run at full detail), 0 when the low tier sheds glow. Single-sources the
// gate that was otherwise copy-pasted at every per-frame shadowBlur site.
function glowBlur(n) {
    return (typeof perfGlow !== "function" || perfGlow()) ? n : 0;
}
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
    // Reuse gameboard's single Voronoi nearest-site scan rather than a second copy.
    var cell = (typeof nearestCell === "function") ? nearestCell(player.x, player.y) : null;
    var nearestId = (cell != null) ? cell.id : -1;
    player._nearCellId = nearestId;
    player._nearCellX = player.x;
    player._nearCellY = player.y;
    player._nearCellAt = now;
    return nearestId;
}
// Map of player id -> the frame generation in which it was last seen targeted.
// A player is "targeted this frame" iff its stamp === the current generation, so
// the set is reused across frames (a bumped counter invalidates last frame's
// entries) instead of allocating a fresh object every frame.
var targetedPlayerIds = {};
var _targetGen = 0;
function rebuildTargetedPlayerIds() {
    _targetGen++;
    for (var aid in aimerList) {
        var a = aimerList[aid];
        var tl = a != null ? a.targetList : null;
        if (tl == null) { continue; }
        for (var ti = 0; ti < tl.length; ti++) {
            targetedPlayerIds[tl[ti]] = _targetGen;
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
    // Star Power aura sits behind the kart body like the burn flame, so the
    // skin/colour stays readable on top of the rainbow glow.
    drawStarPowerFx(player);
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

    var playerStrokeColor = (targetedPlayerIds[player.id] === _targetGen) ? "red" : "black";
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
    var hasCartSkin = cartSkinPainter(player.cart) != null;
    // try/finally so a thrown drawImage (e.g. an undecoded sprite -> InvalidStateError)
    // can't skip the restore() and leak the dimmed/flash alpha onto the rest of the frame.
    try {
        // Border FIRST — it rings the kart from BEHIND, so the cart body / sprite always sits
        // on top (only the rim beyond the body shows). Independent 4th slot (player.border),
        // renders over ANY cart.
        var borderSkin = (typeof getSkin === "function" && player.border) ? getSkin(player.border) : null;
        if (borderSkin && borderSkin.slot === 'border') {
            var borderPainter = (typeof getSkinPainter === "function") ? getSkinPainter(player.border) : null;
            if (borderPainter != null) {
                drawBorderOverlay(player, player.x + camera.getCameraX(), player.y + camera.getCameraY(), player.radius, borderPainter);
            }
        }
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
            // Pattern overlay on the plain sphere cart (patterns are scoped to the sphere).
            // Independent 2nd slot (player.pattern); guard on its registry slot so a stale
            // border id parked here never renders as a pattern.
            var slot2skin = (typeof getSkin === "function" && player.pattern) ? getSkin(player.pattern) : null;
            if (slot2skin && slot2skin.slot === 'pattern') {
                var patPainter = (typeof getSkinPainter === "function" && player.pattern) ? getSkinPainter(player.pattern) : null;
                if (patPainter != null) {
                    drawPatternOverlay(player, player.x + camera.getCameraX(), player.y + camera.getCameraY(), player.radius, patPainter);
                }
            }
        }
        // Cosmetic cart skin (procedural overlay). Uses the SAME screen anchor as the
        // sprite blit (player.x/y + camera offset), so the camera offset is applied once.
        var bodyPainter = cartSkinPainter(player.cart);
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
// The LOCAL living player with the latest-expiring live Star Power (couch co-op
// can have several) — drives the local-only trip overlay, the FOV curve, and
// the blindfold exemption. Null when no local star is live.
function localStarPowerInfo() {
    var best = null;
    var now = Date.now();
    var locals = livingLocalPlayers();
    for (var i = 0; i < locals.length; i++) {
        var u = locals[i].starPowerUntil;
        if (u != null && u > now && (best == null || u > best.until)) {
            best = { until: u, player: locals[i] };
        }
    }
    return best;
}
function localStarPowerUntil() {
    var info = localStarPowerInfo();
    return info ? info.until : 0;
}

// Star Power: rainbow glow + cycling ring + orbiting stars around an invulnerable
// kart, blinking out Mario-style over the last 1.5s. Drawn behind the kart body
// (called just before the kart paint, like the burn flame) so the skin stays
// readable on top. Per-frame gradient is fine here: the effect is rare and
// lives ~5s on at most a couple of karts at once.
function drawStarPowerFx(player) {
    var until = player.starPowerUntil;
    if (until == null) {
        return;
    }
    var now = Date.now();
    var left = until - now;
    if (left <= 0) {
        return;
    }
    // Expiry warning: blink the whole aura as the star wears off.
    if (left < 1500 && Math.floor(now / 130) % 2 === 0) {
        return;
    }
    var hue = (now * 0.35) % 360;
    var r = player.radius;
    var pulse = 1 + 0.08 * Math.sin(now / 90);
    var auraR = r * 2.3 * pulse;
    gameContext.save();
    gameContext.translate(player.x, player.y);
    // Soft rainbow aura.
    var grad = gameContext.createRadialGradient(0, 0, r * 0.4, 0, 0, auraR);
    grad.addColorStop(0, "hsla(" + hue.toFixed(0) + ",100%,70%,0.55)");
    grad.addColorStop(0.7, "hsla(" + ((hue + 60) % 360).toFixed(0) + ",100%,60%,0.25)");
    grad.addColorStop(1, "hsla(" + ((hue + 120) % 360).toFixed(0) + ",100%,55%,0)");
    gameContext.fillStyle = grad;
    gameContext.beginPath();
    gameContext.arc(0, 0, auraR, 0, 2 * Math.PI);
    gameContext.fill();
    // Bright colour-cycling ring hugging the kart.
    gameContext.globalAlpha = 0.85;
    gameContext.strokeStyle = "hsl(" + hue.toFixed(0) + ",100%,60%)";
    gameContext.lineWidth = 2.5;
    gameContext.beginPath();
    gameContext.arc(0, 0, r + 4, 0, 2 * Math.PI);
    gameContext.stroke();
    // Three orbiting stars, hue-staggered a third of the wheel apart.
    for (var i = 0; i < 3; i++) {
        var ang = now / 280 + i * (2 * Math.PI / 3);
        var ox = Math.cos(ang) * (r + 10);
        var oy = Math.sin(ang) * (r + 10);
        gameContext.save();
        gameContext.translate(ox, oy);
        gameContext.rotate(ang);
        gameContext.globalAlpha = 0.95;
        gameContext.fillStyle = "hsl(" + (((hue + i * 120) % 360)).toFixed(0) + ",100%,70%)";
        if (typeof tfxStarPath === "function") {
            tfxStarPath(gameContext, 4.5);
        } else {
            gameContext.beginPath();
            gameContext.arc(0, 0, 3, 0, 2 * Math.PI);
        }
        gameContext.fill();
        gameContext.restore();
    }
    gameContext.restore();
}

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
    gameContext.shadowBlur = glowBlur(12);
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
// Reused scratch for drawTrail's per-segment bucket indices (see usage below) so
// the trail draw doesn't allocate a fresh array per kart per frame.
var _trailSegBucketScratch = [];
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
    // Star Power overrides everything (the equipped cosmetic AND the near-victory
    // dash) for its few seconds: a rainbow star trail marks the invulnerable kart.
    var starActive = player.starPowerUntil != null && now < player.starPowerUntil;
    if (starActive && typeof drawStarPowerTrail === "function") {
        tfxBaseAlpha = baseAlpha;
        drawStarPowerTrail(gameContext, verts, player.color, now, fadeMs, cartSkinAnimTime * 1000);
        tfxBaseAlpha = 1;
        gameContext.restore();
        return;
    }
    // Cosmetic trail effect: a rich per-effect renderer (trailEffects.js) draws the WHOLE
    // trail in the player's colour and we return. Near-victory dashing keeps priority for
    // legibility. anim is ms; tfxBaseAlpha carries the non-local dimming.
    var trailEffect = (typeof getTrailEffect === "function" && player.trailFx) ? getTrailEffect(player.trailFx) : null;
    var fx = (!dashed && trailEffect && typeof TRAIL_FX !== "undefined") ? TRAIL_FX[trailEffect] : null;
    if (fx) {
        tfxBaseAlpha = baseAlpha;
        fx(gameContext, verts, player.color, now, fadeMs, cartSkinAnimTime * 1000);
        tfxBaseAlpha = 1;
        gameContext.restore();
        return;
    }
    // Trail always uses the player's own colour, even with a cart skin equipped — the
    // colour is the player's identity, so a blue dino trails blue (not skin-themed).
    gameContext.strokeStyle = player.color;
    var trailBlur = glowBlur(3);
    if (trailBlur) {
        gameContext.shadowBlur = trailBlur;
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
    // verts[i] is in this bucket). >= TRAIL_DRAW_BUCKETS marks "expired". Reuse a
    // module-scope scratch array so this isn't a per-kart per-frame allocation;
    // only indices [0, verts.length) are written and read each call.
    var segBucket = _trailSegBucketScratch;
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
            gameContext.shadowBlur = glowBlur(8);
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
    if (mapCanvas == null) {
        renderMapToCache();
        mapDirty = false;
        lastMapBakeAt = Date.now();
    } else if (mapDirty) {
        var nowBake = Date.now();
        if (nowBake - lastMapBakeAt >= MAP_BAKE_MIN_MS) {
            renderMapToCache();
            mapDirty = false;
            lastMapBakeAt = nowBake;
        }
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
    if (hasAnyKey(hazardList)) {
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
    gameContext.shadowBlur = glowBlur(13);
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
    if (!hasAnyKey(set)) {
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
// The vignette gradient depends only on the world rect, so build it once and
// reuse it every frame (createRadialGradient + addColorStop per frame is pure
// waste when the world hasn't changed).
var _vignetteGrad = null, _vgX = NaN, _vgY = NaN, _vgW = NaN, _vgH = NaN;
function drawArenaVignette() {
    if (world == null) {
        return;
    }
    if (_vignetteGrad == null || world.x !== _vgX || world.y !== _vgY ||
        world.width !== _vgW || world.height !== _vgH) {
        var cx = world.x + world.width / 2;
        var cy = world.y + world.height / 2;
        var inner = Math.min(world.width, world.height) * 0.45;
        var outer = Math.sqrt(world.width * world.width + world.height * world.height) / 2;
        _vignetteGrad = gameContext.createRadialGradient(cx, cy, inner, cx, cy, outer);
        _vignetteGrad.addColorStop(0, "rgba(0, 0, 0, 0)");
        _vignetteGrad.addColorStop(1, "rgba(8, 6, 14, 0.26)");
        _vgX = world.x; _vgY = world.y; _vgW = world.width; _vgH = world.height;
    }
    gameContext.save();
    gameContext.fillStyle = _vignetteGrad;
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
    drawMaintenanceBanner();
    drawVirtualButtons();
    drawTouchControls();
    drawTitle();
    drawMapAnnouncement();
}

// Deploy heads-up banner (top-center, every state — drawHUD runs in both the
// main loop and the overview pass). A 'restart' shows a live countdown to the
// server-sent deadline ("back in a moment" — client.js auto-reloads after the
// drop); a 'drain' shows a static "new races paused" notice until the restart
// that always follows it takes over. Self-expires past expiresAt so a
// canceled deploy clears the banner without a server round-trip.
function drawMaintenanceBanner() {
    if (serverMaintenance == null) { return; }
    var now = Date.now();
    if (serverMaintenance.expiresAt != null && now > serverMaintenance.expiresAt) {
        serverMaintenance = null;
        return;
    }
    var line1, line2;
    if (serverMaintenance.reason === "restart") {
        var secsLeft = Math.max(0, Math.ceil((serverMaintenance.deadline - now) / 1000));
        line1 = secsLeft > 0 ? ("Server restarting in " + secsLeft + "s") : "Server restarting…";
        line2 = "Game update — you'll be back in the action in a moment";
    } else {
        line1 = "Server update coming up";
        line2 = "New races are paused — a quick restart follows shortly";
    }
    var cx = LOGICAL_WIDTH / 2;
    var by = 66; // headline baseline — panel sits below the session info bar
    // Urgency pulse on the headline once a restart countdown is live, same
    // accelerating-sine trick as the gate line.
    var alpha = 1;
    if (serverMaintenance.reason === "restart") {
        alpha = 0.75 + 0.25 * Math.sin(now / 180);
    }
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    // Dark alert panel behind both lines so the warning reads over any terrain
    // (and over the HUD chrome) without per-glyph stroking.
    gameContext.font = "bold 20px Arial";
    var mw1 = gameContext.measureText(line1).width;
    gameContext.font = "14px Arial";
    var mw2 = gameContext.measureText(line2).width;
    var mW = Math.max(mw1, mw2) + 36;
    drawHudPanel(cx - mW / 2, by - 22, mW, 50, {
        fill: "rgba(12, 14, 18, 0.78)", alpha: 1,
        border: "rgba(255, 179, 71, 0.65)", borderWidth: 1.5
    });
    gameContext.font = "bold 20px Arial";
    gameContext.globalAlpha = alpha;
    gameContext.fillStyle = "#ffb347";
    gameContext.fillText(line1, cx, by);
    gameContext.globalAlpha = 1;
    gameContext.font = "14px Arial";
    gameContext.fillStyle = "white";
    gameContext.fillText(line2, cx, by + 19);
    gameContext.restore();
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
        // Rounded tile, matching the shared HUD-panel chrome (light bg kept so
        // the dark icon silhouettes stay readable in both themes).
        gameContext.fillStyle = "rgba(255,255,255,0.88)";
        roundRectPath(gameContext, bx, topY, bw, bh, 6);
        gameContext.fill();
        gameContext.strokeStyle = "rgba(0,0,0,0.45)";
        gameContext.lineWidth = 1.5;
        gameContext.stroke();
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

// Record floats during the overview pass. The world-space anchor doesn't apply
// (camera detached, players unrendered), so the float drops onto the player's
// standings row instead. Last-finisher records that arrive AFTER startOverview
// still surface here. Shares computeStandingsRowGeom so the rows line up exactly
// with drawStandingsPanel regardless of player count / column split.
function drawRecordFloatsOverview(page) {
    drainRecordFloats();
    if (recordFloats.length === 0) { return; }
    if (playerList == null || page == null) { return; }
    var g = page.geom || computeStandingsRowGeom(page); // reuse the frame's shared geometry
    if (g.count === 0) { return; }
    // playerId -> row index, matching the standings iteration order.
    var rowIdx = {};
    for (var i = 0; i < g.count; i++) { rowIdx[g.ids[i]] = i; }

    var now = Date.now();
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    for (var k = 0; k < recordFloats.length; k++) {
        var f = recordFloats[k];
        if (!(f.playerId in rowIdx)) { continue; }
        var b = g.box(rowIdx[f.playerId]);
        var env = recordFloatEnvelope(now, f.startedAt);
        // Centre over the row's track, lifted above the row.
        var x = b.x + b.w * 0.55;
        var y = b.y - 4 - env.rise;
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
    gameContext.font = "bold 28px Arial";
    var label = formatRaceTime(elapsed);
    // Fixed dark pill (not the theme surface) so the white/gold/red time keeps
    // contrast in BOTH themes and over any terrain.
    var tw = gameContext.measureText(label).width;
    drawHudPanel(LOGICAL_WIDTH - 20 - tw - 12, 10, tw + 24, 38, {
        fill: "rgba(12, 14, 18, 0.62)", alpha: 1,
        border: "rgba(255, 255, 255, 0.25)", borderWidth: 1.5
    });
    gameContext.fillStyle = color;
    gameContext.textAlign = "right";
    gameContext.textBaseline = "alphabetic";
    gameContext.fillText(label, LOGICAL_WIDTH - 20, 40);
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
    var y = 66; // below the session info bar (which spans y 8..38)
    var boxX = cx - w / 2;

    gameContext.fillStyle = "rgba(0, 0, 0, 0.55)";
    roundRectPath(gameContext, boxX, y - 19, w, 28, 9); // in the play bundle (audience.js)
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

// ---- Shared HUD chrome -----------------------------------------------------
// One rounded-panel language for every persistent HUD element (session info
// bar, map plaque, waiting banner), borrowed from the lobby-hub banners
// (lobbyHub.js drawLobbyBanner): theme surface fill, 2px ink border, 9px
// corners. Keeps the in-race HUD reading as the same family as the lobby UI.
function drawHudPanel(x, y, w, h, opts) {
    opts = opts || {};
    gameContext.save();
    if (opts.glow) { gameContext.shadowColor = opts.glow; gameContext.shadowBlur = 14; }
    gameContext.globalAlpha = (opts.alpha != null) ? opts.alpha : 0.88;
    gameContext.fillStyle = opts.fill || themeColor('surface', '#101216');
    roundRectPath(gameContext, x, y, w, h, (opts.radius != null) ? opts.radius : 9); // audience.js helper
    gameContext.fill();
    gameContext.shadowBlur = 0;
    gameContext.globalAlpha = (opts.borderAlpha != null) ? opts.borderAlpha : 1;
    gameContext.lineWidth = (opts.borderWidth != null) ? opts.borderWidth : 2;
    gameContext.strokeStyle = opts.border || themeColor('ink', 'black');
    gameContext.stroke();
    gameContext.restore();
}

// Persistent-chrome fade: the round panel and the map plaque render at full
// strength through the gate countdown, then ease down to a translucent
// watermark shortly after the race starts so they stop competing with the
// action. Re-arms every round (raceStartedAt is re-stamped on each startRace).
var HUD_FADE_DELAY_MS = 800;   // grace period after the gate drops
var HUD_FADE_MS = 900;         // fade duration
var HUD_FADED_ALPHA = 0.4;     // resting opacity while racing
function hudChromeAlpha() {
    if (raceStartedAt == null) { return 1; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) { return 1; }
    var e = Date.now() - raceStartedAt - HUD_FADE_DELAY_MS;
    if (e <= 0) { return 1; }
    return 1 - clamp01(e / HUD_FADE_MS) * (1 - HUD_FADED_ALPHA);
}

// Top-centre session readout: GAME <id> · PLAYERS <n> · ROUND <r>. Frameless
// by design (operator preference — no panel box up here): small-caps dimmed
// labels + bold values in the theme ink/ink-outline text treatment so the row
// reads over any terrain, with small dot separators. GAME + PLAYERS always
// show (friends read the room id off the host's screen); ROUND joins once a
// race exists. The whole row fades to a watermark while racing (hudChromeAlpha).
function drawGameInfo() {
    var segs = [
        { label: "GAME", value: (gameID != null && gameID !== "") ? ("" + gameID) : "—" },
        { label: "PLAYERS", value: "" + totalPlayers }
    ];
    var inRace = currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing;
    if (inRace && round > 0) {
        segs.push({ label: "ROUND", value: "" + round });
    }

    var labelFont = "bold 10px sans-serif";
    var valueFont = "bold 15px sans-serif";
    var labelGap = 5, sepGap = 11;
    var ink = themeColor('ink', 'black');
    var outline = themeColor('inkOutline', 'white');
    var fade = hudChromeAlpha();

    gameContext.save();
    var total = 0;
    for (var i = 0; i < segs.length; i++) {
        gameContext.font = labelFont;
        segs[i].lw = gameContext.measureText(segs[i].label).width;
        gameContext.font = valueFont;
        segs[i].vw = gameContext.measureText(segs[i].value).width;
        segs[i].w = segs[i].lw + labelGap + segs[i].vw;
        total += segs[i].w;
    }
    var w = total + (segs.length - 1) * sepGap * 2;
    var cx = (LOGICAL_WIDTH - w) / 2;
    var cy = 21;

    gameContext.textBaseline = "middle";
    gameContext.textAlign = "left";
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = outline;
    for (var k = 0; k < segs.length; k++) {
        if (k > 0) {
            // Small dot separator between segments.
            cx += sepGap;
            gameContext.globalAlpha = 0.45 * fade;
            gameContext.fillStyle = ink;
            gameContext.beginPath();
            gameContext.arc(cx, cy, 1.8, 0, Math.PI * 2);
            gameContext.fill();
            cx += sepGap;
        }
        gameContext.fillStyle = ink;
        gameContext.globalAlpha = 0.62 * fade;
        gameContext.font = labelFont;
        gameContext.strokeText(segs[k].label, cx, cy);
        gameContext.fillText(segs[k].label, cx, cy);
        gameContext.globalAlpha = fade;
        gameContext.font = valueFont;
        gameContext.strokeText(segs[k].value, cx + segs[k].lw + labelGap, cy);
        gameContext.fillText(segs[k].value, cx + segs[k].lw + labelGap, cy);
        cx += segs[k].w;
    }
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
        // Properly-centred pill in the shared HUD chrome, with a slow animated
        // ellipsis so the screen reads "alive" while waiting. The panel is sized
        // for the full three dots so it never resizes as they cycle.
        var wMsg = "Waiting for more players";
        var dots = new Array((Math.floor(Date.now() / 450) % 3) + 2).join(".");
        var wFont = "bold 20px sans-serif";
        var wPadX = 24, wH = 44;
        gameContext.save();
        gameContext.font = wFont;
        var wTextW = gameContext.measureText(wMsg + "...").width;
        var wW = wTextW + wPadX * 2;
        var wX = (LOGICAL_WIDTH - wW) / 2;
        var wY = LOGICAL_HEIGHT / 2 - 60;
        drawHudPanel(wX, wY, wW, wH, null);
        gameContext.fillStyle = themeColor('ink', 'black');
        gameContext.textAlign = "left";
        gameContext.textBaseline = "middle";
        gameContext.fillText(wMsg + dots, wX + wPadX, wY + wH / 2 + 1);
        gameContext.restore();
    }
}

// ============================================================================
// OVERVIEW PAGE LAYOUT (between-rounds standings screen)
// ----------------------------------------------------------------------------
// A structured, panelled page rather than elements floating on black:
//   • Standings hero panel  — left ~62%, the racing tracks (karts ride the line)
//   • Right rail            — Next-map preview (top) + Times-to-beat (bottom)
//   • Rating strip          — full-width bottom panel
//   • GameID strip + WR toast at the top
// House style: borderless sections — content breathes on black under a small gold
// label; gold accent (OV.gold) for headings/highlights. headerH reserves the label band.
// ============================================================================
var OV = {
    gold: "#FFCB30",
    margin: 30,
    gap: 16,
    railW: 440,
    ratingH: 84,
    headerH: 34
};

// A section heading: a small gold label at the top-left of its region. No box, border,
// fill, or header band — structure comes from layout position + the label alone. Callers
// own their region rect; this only needs the label's anchor. headerH reserves the band.
function ovLabel(x, y, title) {
    if (!title) { return; }
    gameContext.save();
    gameContext.fillStyle = OV.gold;
    gameContext.font = "bold 13px Arial";
    gameContext.textAlign = "left";
    gameContext.textBaseline = "middle";
    gameContext.fillText(title.toUpperCase(), x + 6, y + OV.headerH / 2 + 1);
    gameContext.restore();
}

// Compute the page regions once per frame. Everything keys off these rects so the
// panels never overlap and the standings know exactly how much room they own.
function computeOverviewPage() {
    var wrActive = overviewWorldRecordActive();
    var topY = wrActive ? 108 : 52;       // drop below the WR toast while it shows
    var m = OV.margin, gap = OV.gap;
    var contentBottom = (LOGICAL_HEIGHT - 50) - OV.ratingH - gap; // clear controls + rating
    var railW = OV.railW;
    var leftW = LOGICAL_WIDTH - 2 * m - railW - gap;
    return {
        topY: topY, gap: gap, margin: m,
        standings: { x: m, y: topY, w: leftW, h: contentBottom - topY },
        railX: m + leftW + gap, railW: railW,
        contentBottom: contentBottom,
        rating: { x: m, y: contentBottom + gap, w: LOGICAL_WIDTH - 2 * m, h: OV.ratingH }
    };
}

// True while the "New world record" toast is on screen, so the standings band can
// drop below it. Mirrors drawWorldRecordBanner's own start/duration guard.
function overviewWorldRecordActive() {
    if (typeof worldRecordBanner === "undefined" || worldRecordBanner == null) { return false; }
    if (typeof worldRecordBanner.startedAt !== "number") { return false; }
    return (Date.now() - worldRecordBanner.startedAt) < WORLD_RECORD_BANNER_DURATION_MS;
}

function drawOverviewBoard() {
    drawBlackBackground();
    var page = computeOverviewPage();
    // Compute the per-frame geometry ONCE and hang it on `page` so every consumer
    // reuses it instead of recomputing (the standings sort + the rail split both used
    // to run twice per frame). All overview renderers read page.geom / page.rail.
    page.geom = computeStandingsRowGeom(page);
    page.rail = overviewRailRects(page);
    drawStandingsPanel(page);
    drawNextMap(page);
    drawMapLeaderboardCard(page);
    // Late-arriving PB floats — the last finisher's playerPbResult lands AFTER
    // startOverview because the server's per-finish upsert + rank lookup are async.
    // The world-space drawRecordFloats in the race pass never sees them; this
    // overview-context render catches them anchored to standings rows.
    drawRecordFloatsOverview(page);
    drawHUD(); // GameID strip + WR toast (race-only widgets early-return on overview)
    // Full-width "Rate this map" strip along the bottom. Guarded so a render error
    // can't break the overview.
    try {
        drawOverviewRating(page);
    } catch (e) {
        debugLog("rating draw error", e);
    }
}

// Bottom rating strip — spans the page width above the controls legend.
function drawOverviewRating(page) {
    if (typeof ratingMapId === "undefined" || ratingMapId == null) {
        ratingStarHits = [];
        return;
    }
    drawMapRating(LOGICAL_WIDTH / 2, page.rating.y + page.rating.h, page.rating.w);
}

// Trim `text` with a trailing "…" until it fits maxW under the CURRENT gameContext font.
// Shared by the overview name columns (standings + times-to-beat) so the ellipsis-fit
// loop lives in one place. Returns the original string when it already fits.
function fitWithEllipsis(text, maxW) {
    if (text == null) { return ""; }
    if (gameContext.measureText(text).width <= maxW) { return text; }
    var t = text;
    while (t.length > 1 && gameContext.measureText(t + "…").width > maxW) { t = t.slice(0, -1); }
    return t + "…";
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

// Vertical split of the right rail into the Next-map panel (top) and the
// Times-to-beat panel (bottom). Shared so both draw consistently and the rating
// avoidance / record floats can reason about the rail.
function overviewRailRects(page) {
    var x = page.railX, w = page.railW, top = page.standings.y;
    // Preview tile aspect ~0.56; panel = header + tile + title/author block.
    var tileW = w - 32;
    var tileH = Math.round(tileW * 0.56);
    var previewH = OV.headerH + 12 + tileH + 58;
    var timesY = top + previewH + page.gap;
    return {
        preview: { x: x, y: top, w: w, h: previewH, tileW: tileW, tileH: tileH },
        times: { x: x, y: timesY, w: w, h: page.contentBottom - timesY }
    };
}

function drawNextMap(page) {
    if (page == null) { return; }
    var rail = page.rail || overviewRailRects(page);
    var r = rail.preview;
    ovLabel(r.x, r.y, "Next Map");
    if (nextMapPreview == null) {
        gameContext.save();
        gameContext.fillStyle = "rgba(255,255,255,0.5)";
        gameContext.font = "italic 16px Arial"; gameContext.textAlign = "left"; gameContext.textBaseline = "middle";
        gameContext.fillText("Picking the next map…", r.x + 16, r.y + r.h / 2);
        gameContext.restore();
        return;
    }
    var thX = r.x + 6, thY = r.y + OV.headerH + 10;
    gameContext.save();
    // big preview tile — the thumbnail is the visual; rounded-clipped, no frame.
    if (nextMapThumbnail != null) {
        try {
            gameContext.save();
            drawRoundRectPath(thX, thY, r.tileW, r.tileH, 10);
            gameContext.clip();
            gameContext.drawImage(nextMapThumbnail, thX, thY, r.tileW, r.tileH);
            gameContext.restore();
        } catch (e) { /* thumbnail not ready — faint placeholder below */ }
    } else {
        // No image yet: a faint rounded placeholder so the space reads as the preview.
        gameContext.fillStyle = "rgba(255,255,255,0.05)";
        drawRoundRectPath(thX, thY, r.tileW, r.tileH, 10);
        gameContext.fill();
    }
    // title + author below the tile
    gameContext.fillStyle = "#fff"; gameContext.font = "bold 22px Arial";
    gameContext.textAlign = "left"; gameContext.textBaseline = "alphabetic";
    gameContext.fillText(nextMapPreview.name || "—", thX, thY + r.tileH + 28);
    if (nextMapPreview.author) {
        gameContext.fillStyle = "rgba(255,255,255,0.6)"; gameContext.font = "14px Arial";
        gameContext.fillText("by " + nextMapPreview.author, thX, thY + r.tileH + 48);
    }
    gameContext.restore();
}

// "Times to beat for <next map>" — right-rail panel below the next-map preview.
// Global top-10 PB times for the upcoming map; top-3 gold. "New map!" placeholder
// when empty. Row pitch shrinks to fit the panel height.
function drawMapLeaderboardCard(page) {
    if (page == null || mapLeaderboardData == null) { return; }
    var rail = page.rail || overviewRailRects(page);
    var r = rail.times;
    ovLabel(r.x, r.y, "Times to Beat");
    var allRows = mapLeaderboardData.rows || [];
    var bodyTop = r.y + OV.headerH + 10;

    gameContext.save();
    gameContext.textBaseline = "alphabetic";
    if (allRows.length === 0) {
        gameContext.font = "italic 15px Arial";
        gameContext.fillStyle = "#9b5";
        gameContext.textAlign = "left";
        gameContext.fillText("New map — be the first!", r.x + 6, bodyTop + 22);
        gameContext.restore();
        return;
    }

    // Fit rows at a legible pitch. Rather than crushing all 10 into a too-short panel
    // (which floored the font ABOVE the row pitch, so lines overlapped), cap the count to
    // what fits at a readable MIN_ROW_H and note the truncation. avail can never go
    // negative here because overviewRailRects keeps times.h >= 0 on the fixed canvas.
    var avail = Math.max(0, (r.y + r.h - 12) - bodyTop);
    var MIN_ROW_H = 18;
    var maxRows = Math.max(1, Math.floor(avail / MIN_ROW_H));
    var truncated = allRows.length > maxRows;
    var rows = truncated ? allRows.slice(0, maxRows - 1) : allRows; // leave a line for "+N more"
    var shown = rows.length + (truncated ? 1 : 0);
    var rowH = Math.min(26, avail / shown);
    var rowFontPx = Math.max(11, Math.min(15, Math.round(rowH - 9)));
    var rankColX = r.x + 6, nameColX = r.x + 40, timeColX = r.x + r.w - 4;
    var maxNameW = (timeColX - nameColX) - 70;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var ty = bodyTop + i * rowH + rowH * 0.72;
        var isYou = (row.playerId === myID);
        gameContext.font = "bold " + rowFontPx + "px Arial";
        gameContext.textAlign = "left";
        gameContext.fillStyle = (i < 3) ? OV.gold : "rgba(255,255,255,0.5)";
        gameContext.fillText("#" + row.rank, rankColX, ty);
        var label = (row.displayName || "Anon") + (isYou ? " (YOU)" : "");
        gameContext.fillStyle = "#fff";
        gameContext.font = (isYou ? "bold " : "") + rowFontPx + "px Arial";
        gameContext.fillText(fitWithEllipsis(label, maxNameW), nameColX, ty);
        gameContext.textAlign = "right";
        gameContext.fillText(formatRaceTime(row.bestMs), timeColX, ty);
    }
    // "+N more" footer when the panel couldn't show the whole top-10.
    if (truncated) {
        var moreTy = bodyTop + rows.length * rowH + rowH * 0.72;
        gameContext.font = "italic " + rowFontPx + "px Arial";
        gameContext.fillStyle = "rgba(255,255,255,0.4)";
        gameContext.textAlign = "left";
        gameContext.fillText("+" + (allRows.length - rows.length) + " more", rankColX, moreTy);
    }
    gameContext.restore();
}
function drawBlackBackground() {
    gameContext.save();
    gameContext.beginPath();
    gameContext.fillStyle = "black";
    gameContext.rect(world.x, world.y, world.width, world.height);
    gameContext.fill();
    gameContext.restore();
}
// ---- STANDINGS HERO PANEL --------------------------------------------------
// The racing tracks, now inside a panel. Each row: rank badge · kart-on-line
// track (kart rides at its score position, full cosmetics + tail) · score.
// Auto 1/2 columns; rows GROW to fill the panel at low player counts.
// Shared standings geometry: ordered player ids + a per-index row box {x,y,w,h}.
// Both the panel renderer and the record-float overlay key off this so a float
// always lands on its player's row at any column/scale.
function computeStandingsRowGeom(page) {
    var r = page.standings;
    // Order by standing (notches desc) so the numeric rank badges and row order match
    // the actual leaderboard, not playerList insertion (join) order. Decorate-sort with
    // the original index as a stable tiebreak so equal-score rows keep a deterministic,
    // flicker-free order frame to frame.
    var deco = [];
    var k = 0;
    for (var pid in playerList) {
        var pl = playerList[pid];
        deco.push({ id: pid, notches: (pl && typeof pl.notches === "number") ? pl.notches : 0, ord: k++ });
    }
    deco.sort(function (a, b) { return (b.notches - a.notches) || (a.ord - b.ord); });
    var ids = deco.map(function (d) { return d.id; });
    var count = ids.length;
    var inX = r.x + 12, inY = r.y + OV.headerH + 6;
    var inW = r.w - 24, inH = r.h - OV.headerH - 14;
    var cols = count <= 11 ? 1 : 2;
    var perCol = Math.max(1, Math.ceil(count / cols));
    var colW = inW / cols;
    var rowH = Math.min(64, inH / perCol);
    var usedH = perCol * rowH;
    var padTop = Math.max(0, (inH - usedH) / 2);
    return {
        ids: ids, count: count, cols: cols, perCol: perCol, colW: colW, rowH: rowH,
        inX: inX, inY: inY, padTop: padTop,
        box: function (i) {
            var col = Math.floor(i / perCol), row = i % perCol;
            return {
                x: inX + col * colW,
                y: inY + padTop + row * rowH,
                w: colW - (cols > 1 ? 12 : 0),
                h: rowH
            };
        }
    };
}

function drawStandingsPanel(page) {
    var r = page.standings;
    ovLabel(r.x, r.y, "Round Standings");
    var g = page.geom || computeStandingsRowGeom(page);
    if (g.count === 0) { return; }

    for (var i = 0; i < g.count; i++) {
        var id = g.ids[i];
        // Preserve the sequential notch-slide cascade: the first not-yet-animated
        // player becomes the animator; it hands off when its slide completes.
        if (playerAnimating == null) { playerAnimating = id; }
        var b = g.box(i);
        drawStandingsRow(playerList[id], i, b.x, b.y, b.w, b.h);
    }
}

// Step a player's notch-slide animation one frame and return the current animated
// progress as a 0..1 fraction of the full track. Same stepping + hand-off logic as
// the legacy drawPlayerIcon, just decoupled from a fixed pixel pitch so the kart can
// ride a track of any width at a constant on-screen size.
function overviewAnimStep(player) {
    var unit = notchDistanceApart || 75;
    var gl = gameLength || (config && config.baseNotchesToWin) || 5;
    var notchX, moveAmt = 0;
    if (player.distanceToMove > 0) {
        moveAmt = 2; notchX = player.distanceTraveled + (oldNotches[player.id] * unit);
    } else if (player.distanceToMove < 0) {
        moveAmt = -2; notchX = player.distanceTraveled + (oldNotches[player.id] * unit);
    } else {
        notchX = player.notches * unit; playerAnimating = null;
    }
    if (playerAnimating === player.id) {
        if (player.distanceToMove - moveAmt < 0 && player.distanceToMove + moveAmt > 0) {
            player.distanceToMove = 0;
        } else {
            player.distanceToMove -= moveAmt;
            player.distanceTraveled += moveAmt;
        }
    }
    player.x = notchX; player.y = 0;
    // Track spans gl+1 segments, NOT gl: reaching gameLength notches is "near victory",
    // not a win — the match only ends when a player wins ANOTHER round while already at the
    // cap. So a kart at gameLength sits one segment SHORT of the goal flag (the decisive
    // final step), matching the legacy goal post reserved at (gameLength+1)*distanceApart.
    return Math.max(0, Math.min(1, notchX / ((gl + 1) * unit)));
}

// nearVictory transitions + their sounds, preserved from the legacy drawGoalPost.
function overviewVictoryState(player) {
    var gl = gameLength || (config && config.baseNotchesToWin) || 5;
    if (player.distanceToMove == 0 && playerAnimating !== player.id) {
        if (player.notches == gl && player.nearVictory == false) {
            player.nearVictory = true;
            playSound(nearVictorySound);
        }
    }
    if (player.distanceToMove != 0 && playerAnimating === player.id) {
        if (oldNotches[player.id] == gl && player.notches != gl && player.nearVictory == true) {
            player.nearVictory = false;
            playSound(fallFromVictorySound);
        }
    }
}

// Row label + "is this one of MY karts" for the standings. In single-player the local
// kart reads "You"; in couch co-op there are up to four local seats sharing the screen,
// so each gets its seat identity — the primary stays "You" and the others read "P2".."P4"
// (slot+1, matching the gamepad HUD), so every player can find their own row. A bot /
// avatar-skin name is used when present; everyone else is nameless (kart colour = id).
function overviewSeatLabel(player) {
    // Ownership ("is this one of MY karts") delegates to the canonical isLocalId so the
    // standings agree with every other render path (kart dimming, halos) — including its
    // loose == handling of a number-vs-string id across the socket boundary.
    var local = (typeof isLocalId === "function") ? isLocalId(player.id) : (player.id === myID);
    if (!local) {
        return { label: (player.name != null ? player.name : ""), local: false };
    }
    // Local: derive the seat tag. Single joined seat → "You"; couch co-op → primary stays
    // "You", the others read "P2".."P4" (slot+1, matching the gamepad HUD).
    if (typeof localPlayers !== "undefined" && localPlayers) {
        var slot = -1, joinedCount = 0;
        for (var s = 0; s < localPlayers.length; s++) {
            var lp = localPlayers[s];
            if (!lp) { continue; }
            if (lp.joined) { joinedCount++; }
            if (lp.myID == player.id) { slot = s; } // == to match isLocalId's loose compare
        }
        var isPrimary = (typeof primarySlot === "number") ? (slot === primarySlot) : (slot === 0);
        if (slot >= 0 && joinedCount > 1 && !isPrimary) {
            return { label: "P" + (slot + 1), local: true };
        }
    }
    return { label: "You", local: true };
}

// One standings row. px,py = row top-left; pw,rh = row box.
function drawStandingsRow(player, idx, px, py, pw, rh) {
    var cy = py + rh / 2;
    var gl = gameLength || (config && config.baseNotchesToWin) || 5;
    var seat = overviewSeatLabel(player);
    var isYou = seat.local;

    // Step the slide FIRST, then run the victory-state check — overviewAnimStep clears
    // playerAnimating to null on the frame a slide settles, which is exactly what
    // overviewVictoryState's `playerAnimating !== player.id` guard needs to fire the
    // near-victory / fall sounds. Running the check first (as before) left the guard
    // permanently false for a leader that the panel had just assigned as the animator,
    // so the audio cues never played. Matches the legacy step-then-goalpost order.
    var frac = overviewAnimStep(player);
    overviewVictoryState(player);

    // NEAR-VICTORY WARNING — a player one round from winning is the threat everyone
    // should gang up on, so their whole row lights up gold and pulses. Derive the VISUAL
    // straight from the score, NOT the stateful player.nearVictory flag (which drives the
    // sound cue and only flips under specific animation timing). Two cases, mirroring the
    // legacy goal-post: (a) settled AT the win line, and (b) the legacy "pending" case — a
    // player who was at the win line last round (oldNotches==gl) whose down-slide hasn't
    // animated yet (distanceToMove!=0), so the gold holds through the wait instead of
    // vanishing instantly at overview entry.
    var atLine = (player.notches >= gl) && player.distanceToMove == 0;
    var pendingFromLine = (oldNotches[player.id] === gl) && player.distanceToMove != 0;
    var nearWin = atLine || pendingFromLine;
    if (nearWin) {
        var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 260);
        gameContext.save();
        gameContext.globalAlpha = 0.12 + 0.10 * pulse;
        gameContext.fillStyle = OV.gold;
        drawRoundRectPath(px + 2, py + 2, pw - 4, rh - 4, 8);
        gameContext.fill();
        gameContext.globalAlpha = 0.55 + 0.35 * pulse;
        gameContext.lineWidth = 1.5;
        gameContext.strokeStyle = OV.gold;
        gameContext.stroke();
        gameContext.restore();
    }

    // rank badge / medal at the front
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    if (player.firstPlace) { gameContext.font = "22px Arial"; gameContext.fillText("🥇", px + 22, cy); }
    else if (player.secondPlace) { gameContext.font = "22px Arial"; gameContext.fillText("🥈", px + 22, cy); }
    else if (player.downRank) { gameContext.font = "20px Arial"; gameContext.fillText("💀", px + 22, cy); }
    else { gameContext.font = "bold 15px Arial"; gameContext.fillStyle = "rgba(255,255,255,0.5)"; gameContext.fillText(idx + 1, px + 22, cy); }
    gameContext.restore();

    // name — humans are nameless on the board (server only sets player.name for bots /
    // avatar-skin players), so identity is carried by the kart colour/skin. Local seats
    // get "You"/"P2".."P4" (overviewSeatLabel) so couch co-op players each find their row;
    // others show a bot/avatar name when present, else blank — the kart speaks for itself.
    var nm = seat.label;
    if (nm) {
        gameContext.save();
        gameContext.textAlign = "left";
        gameContext.textBaseline = "middle";
        gameContext.fillStyle = isYou ? OV.gold : "#fff";
        gameContext.font = (isYou ? "bold " : "") + "15px Arial";
        gameContext.fillText(fitWithEllipsis(nm, 110), px + 46, cy);
        gameContext.restore();
    }

    // ---- track: kart rides the line ----
    var trackX0 = px + 184, trackX1 = px + pw - 52, trackW = trackX1 - trackX0;
    if (trackW < 40) { trackW = 40; trackX1 = trackX0 + trackW; }
    var fillX = trackX0 + frac * trackW;

    // base rail + notch pips. The track spans gl+1 segments (see overviewAnimStep): a pip
    // for each score 0..gl, so pip `gl` is one step short of the goal flag (trackX1) — the
    // kart parks there at near-victory and the flag marks the decisive final win.
    gameContext.save();
    gameContext.strokeStyle = "rgba(255,255,255,0.10)";
    gameContext.lineWidth = 3;
    gameContext.beginPath(); gameContext.moveTo(trackX0, cy); gameContext.lineTo(trackX1, cy); gameContext.stroke();
    for (var n = 0; n <= gl; n++) {
        var nx = trackX0 + (n / (gl + 1)) * trackW;
        gameContext.beginPath(); gameContext.arc(nx, cy, 2.5, 0, 2 * Math.PI);
        gameContext.fillStyle = "rgba(255,255,255,0.22)"; gameContext.fill();
    }
    gameContext.restore();

    // Will an equipped tail cosmetic draw over this segment? If so, the solid progress
    // line recedes to a faint thin guide so the COSMETIC trail is the main visual; with no
    // tail equipped the solid line is the whole show and stays bold.
    var hasTailFx = !nearWin && player.trailFx && typeof getTrailEffect === "function" &&
        typeof TRAIL_FX !== "undefined" && getTrailEffect(player.trailFx) &&
        TRAIL_FX[getTrailEffect(player.trailFx)] != null;

    // filled progress line (the player-colour "trail"). Near-victory players glow GOLD
    // and dash — the warning trumps their own colour so the threat reads instantly.
    gameContext.save();
    if (nearWin) {
        gameContext.shadowColor = OV.gold; gameContext.shadowBlur = 12;
        gameContext.strokeStyle = OV.gold; gameContext.lineWidth = 6; gameContext.lineCap = "round";
        gameContext.setLineDash([18, 6]);
    } else if (hasTailFx) {
        // Faint thin guide under the cosmetic trail — keeps the line readable as "progress"
        // without competing with the equipped effect.
        gameContext.globalAlpha = 0.22;
        gameContext.strokeStyle = player.color; gameContext.lineWidth = 2; gameContext.lineCap = "round";
    } else {
        gameContext.shadowColor = player.color; gameContext.shadowBlur = 6;
        gameContext.strokeStyle = player.color; gameContext.lineWidth = 5; gameContext.lineCap = "round";
    }
    gameContext.beginPath(); gameContext.moveTo(trackX0, cy); gameContext.lineTo(fillX, cy); gameContext.stroke();
    gameContext.restore();

    // equipped tail cosmetic overlaid along the filled segment (skipped for near-victory,
    // where the gold warning trail takes over the whole length).
    if (hasTailFx) { drawOverviewTailFx(trackX0, fillX, cy, player); }

    // goal flag at the finish — solid pulsing gold once a player reaches the win line.
    gameContext.save();
    gameContext.font = (nearWin ? "bold 16px" : "14px") + " Arial";
    gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
    if (nearWin) {
        gameContext.shadowColor = OV.gold; gameContext.shadowBlur = 8;
        gameContext.fillStyle = OV.gold;
    } else {
        gameContext.fillStyle = (frac >= 0.999) ? OV.gold : "rgba(255,255,255,0.3)";
    }
    gameContext.fillText("⚑", trackX1 + 10, cy);
    gameContext.restore();

    // kart rides at the progress head, full cosmetics + fire
    drawFireOverview(fillX, cy, player);
    drawOverviewKart(player, fillX, cy, 12);

    // between-round emote — the server still broadcasts chat reactions during overview
    // and the input UI still sends them, so render them on the row above the kart.
    // drawEmoji anchors at player.x/player.y; overviewAnimStep left those in track-local
    // space, so point them at the kart's actual screen position for this draw.
    if (player.chatMessage != null) {
        var sx = player.x, sy = player.y;
        player.x = fillX; player.y = cy - 6;
        drawEmoji(player);
        player.x = sx; player.y = sy;
    }

    // delta float above the kart (this round's score change)
    drawOverviewDelta(player, fillX, cy - 18);

    // just-played PB tag — signed-in racers' global rank + time on the map they just
    // finished (sourced from mapLeaderboardJustPlayed). Lets the last finisher, who gets
    // almost no overview time, still see how they landed. Drawn in its OWN lane below the
    // track, ending left of the goal flag (trackX1) so it never crowds the flag/score
    // column at the row's right edge.
    drawStandingsPbTag(player, trackX1 - 6, cy, isYou);

    // score
    gameContext.save();
    gameContext.textAlign = "right"; gameContext.textBaseline = "middle";
    gameContext.fillStyle = "#fff"; gameContext.font = "bold 16px Arial";
    gameContext.fillText(player.notches, px + pw - 18, cy);
    gameContext.restore();
}

// Just-played global rank + PB time tag for a row, drawn right-aligned ending at xRight.
// No-op without a mapLeaderboardJustPlayed entry for this player (guests/bots, or a
// signed-in player with no PB). Mirrors the legacy inline-leaderboard data source.
function drawStandingsPbTag(player, xRight, cy, isYou) {
    if (mapLeaderboardJustPlayed == null || !mapLeaderboardJustPlayed.rows) { return; }
    if (player == null || !player.id) { return; }
    var rows = mapLeaderboardJustPlayed.rows, row = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].playerId === player.id) { row = rows[i]; break; }
    }
    if (row == null) { return; }
    gameContext.save();
    gameContext.textBaseline = "middle";
    gameContext.textAlign = "right";
    gameContext.font = (isYou ? "bold " : "") + "12px Arial";
    gameContext.fillStyle = "rgba(255,255,255,0.55)";
    gameContext.fillText("#" + row.rank + "  " + formatRaceTime(row.bestMs), xRight, cy + 13);
    gameContext.restore();
}

// Kart with full cosmetics at an explicit centre/radius (decoupled from the old
// transform-scaled icon). Border behind, then cart skin OR plain disc + pattern —
// same cosmetic dispatch as the legacy drawPlayerIcon.
function drawOverviewKart(player, cx, cy, radius) {
    // Paint the cosmetic stack UNSHADOWED into a small scratch canvas, then blit it
    // ONCE with the colored glow. Keeping shadowBlur=10 live across a procedural
    // skin's dozens of path/gradient ops rendered an intermediate blurred surface
    // per op — with a full board of skinned karts the overview paid that every frame.
    var ext = radius * 2.2; // covers border rim (~1.4r) with glow headroom
    var sx = (typeof canvasScaleX !== "undefined" && canvasScaleX) ? canvasScaleX : 1;
    var sy = (typeof canvasScaleY !== "undefined" && canvasScaleY) ? canvasScaleY : 1;
    var w = Math.ceil(ext * 2 * sx), h = Math.ceil(ext * 2 * sy);
    if (_overviewKartScratch == null) { _overviewKartScratch = document.createElement("canvas"); }
    var s = _overviewKartScratch;
    if (s.width < w) { s.width = w; }
    if (s.height < h) { s.height = h; }
    var sctx = s.getContext("2d");
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, w, h);
    sctx.setTransform(sx, 0, 0, sy, 0, 0);
    // The skin painters draw through the gameContext global, so point it at the
    // scratch for the repaint and ALWAYS restore (try/finally) so a throwing
    // painter can't hijack the rest of the frame.
    var prevCtx = gameContext;
    gameContext = sctx;
    try { drawOverviewKartBody(player, ext, ext, radius); } finally { gameContext = prevCtx; }
    gameContext.save();
    gameContext.shadowColor = player.color;
    gameContext.shadowBlur = 10;
    gameContext.drawImage(s, 0, 0, w, h, cx - ext, cy - ext, ext * 2, ext * 2);
    gameContext.restore();
}
var _overviewKartScratch = null;
// The actual cosmetic stack (border behind, then cart skin OR plain disc + pattern),
// shadow-free — drawOverviewKart composites it with the glow in one blit.
function drawOverviewKartBody(player, cx, cy, radius) {
    gameContext.save();
    // border FIRST (behind the body)
    var bid = player.border;
    var bskin = (typeof getSkin === "function" && bid) ? getSkin(bid) : null;
    if (bskin && bskin.slot === 'border') {
        var bpaint = (typeof getSkinPainter === "function") ? getSkinPainter(bid) : null;
        if (bpaint != null) { drawBorderOverlay(player, cx, cy, radius, bpaint); }
    }
    var painter = cartSkinPainter(player.cart);
    if (painter != null) {
        drawCartSkin(player, cx, cy, radius, painter, 0); // face right (toward finish)
    } else {
        gameContext.beginPath();
        gameContext.arc(cx, cy, radius, 0, 2 * Math.PI);
        gameContext.fillStyle = player.color;
        gameContext.fill();
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = Math.max(2, radius * 0.33);
        gameContext.strokeStyle = "black";
        gameContext.arc(cx, cy, radius, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.restore();
        // pattern overlays the plain sphere only
        var pid = player.pattern;
        var pskin = (typeof getSkin === "function" && pid) ? getSkin(pid) : null;
        if (pskin && pskin.slot === 'pattern') {
            var ppaint = (typeof getSkinPainter === "function") ? getSkinPainter(pid) : null;
            if (ppaint != null) { drawPatternOverlay(player, cx, cy, radius, ppaint); }
        }
    }
    gameContext.restore();
}

// Equipped tail cosmetic (player.trailFx) painted along the filled progress segment,
// using the same TRAIL_FX renderer as live racing / the recap. Synthesised verts march
// x0→x1 so the effect runs the length of the trail. No-op without an effect.
function drawOverviewTailFx(x0, x1, cy, player) {
    if (x1 - x0 <= 8 || !player.trailFx) { return; }
    if (typeof paintTrailFx !== "function") { return; }
    var fadeMs = (typeof TRAIL_FADE_MS !== "undefined") ? TRAIL_FADE_MS : 1700;
    var now = Date.now();
    var n = 14, verts = [];
    for (var i = 0; i < n; i++) {
        var f = i / (n - 1);
        verts.push({ x: x0 + (x1 - x0) * f, y: cy, t: now - fadeMs * 0.92 * (1 - f) });
    }
    gameContext.save();
    // The TRAIL_FX renderers are built for free 2D kart motion, so they add perpendicular
    // sway/drift/waves around the path. On the overview the trail must hug the FIXED notch
    // line, so clip the effect to a thin band centred on cy — each trail keeps its colour,
    // particles, and along-line motion, but its vertical scatter is trimmed to the line.
    var bandH = 12;
    gameContext.beginPath();
    gameContext.rect(x0 - 4, cy - bandH / 2, (x1 - x0) + 8, bandH);
    gameContext.clip();
    paintTrailFx(gameContext, player.trailFx, verts, player.color, { fadeMs: fadeMs });
    gameContext.restore();
}

// Rising/fading "+2"/"+1"/"−1" above the kart, showing this round's score change.
function drawOverviewDelta(player, cx, cy) {
    var delta = player.deltaNotches;
    if (!delta || notchFloatStart == null) { return; }
    var elapsed = Date.now() - notchFloatStart;
    if (elapsed < 0 || elapsed > NOTCH_FLOAT_DURATION) { return; }
    var t = elapsed / NOTCH_FLOAT_DURATION;
    var alpha = (t < 0.15) ? (t / 0.15) : (t > 0.6 ? Math.max(0, (1 - t) / 0.4) : 1);
    var rise = 14 * (1 - Math.pow(1 - t, 2));
    var label = (delta > 0 ? "+" : "−") + Math.abs(delta);
    var fill = delta < 0 ? "#ff5a5a" : (delta >= 2 ? "#ffd54a" : "#5be36a");
    gameContext.save();
    gameContext.globalAlpha = alpha;
    gameContext.font = "bold 15px Arial";
    gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
    gameContext.lineWidth = 3; gameContext.strokeStyle = "rgba(0,0,0,0.85)";
    gameContext.shadowColor = fill; gameContext.shadowBlur = 6;
    gameContext.strokeText(label, cx, cy - rise);
    gameContext.fillStyle = fill;
    gameContext.fillText(label, cx, cy - rise);
    gameContext.restore();
}

function drawFireOverview(x, y, player) {
    if (player.onFire > 0) {
        gameContext.save();
        gameContext.shadowColor = "rgba(0, 0, 0, 0)";
        gameContext.translate(x - 5, y);
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



