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
// Ability icons used by the combat log (the others above double as its icons too).
var cutIcon = new Image(576, 512);
cutIcon.src = "../assets/img/scissors-solid.svg";
var starIcon = new Image(576, 512);
starIcon.src = "../assets/img/star-solid.svg";
var orbitalBeamIcon = new Image(576, 512);
orbitalBeamIcon.src = "../assets/img/orbital-beam-solid.svg";

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
var heatwaveIcon = new Image(576, 512);
heatwaveIcon.src = "../assets/img/heatwave-solid.svg";
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
var bunkerIcon = new Image(512, 512);
bunkerIcon.src = "../assets/img/bunker-door.svg";
var orbitalBeamIcon = new Image(576, 512);
orbitalBeamIcon.src = "../assets/img/orbital-beam-solid.svg";
var antlionIcon = new Image(576, 512);
antlionIcon.src = "../assets/img/bug-solid.svg";

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
        // Heatwave: wall-clock reveal fallback (camera intro inactive) + the
        // per-tile burn-in flashes for freshly converted tiles (both waves).
        if (typeof updateHeatwaveReveal === "function") {
            updateHeatwaveReveal();
            drawHeatwaveFlashes();
        }
        drawPingCircles();
        drawCollapseShockwaves();
        // Slow-boil water: tiered simmer->boil->rolling warning over cells the collapse
        // front has reached but that haven't flipped to lava yet.
        if (typeof drawBoilingWater === "function") { drawBoilingWater(); }
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
    drawOrbitalBeamTelegraph();
    // Locked-door barriers (under everything) + loose keys on the ground (under karts).
    if (typeof drawLockedDoors === "function") { drawLockedDoors(); }
    if (typeof drawLooseKeys === "function") { drawLooseKeys(); }
    // Bonus orbs sit on the ground under the karts (so a kart visibly rolls over one).
    if (typeof drawBonusOrbs === "function") { drawBonusOrbs(); }
    drawPlayers(dt);
    drawProjectiles(dt);
    drawRecordFloats();
    drawTeamPointFloats();
    drawEffects();
    drawAbilties();
    drawOverlay();
    postShake();

    // ---- HUD PASS: screen space, never zoomed (score, map title, touch
    // controls, mode indicators, game-over). ----
    applyCanvasTransform();
    // Heatwave warm grade: a subtle screen-space heat tint over the rendered
    // world (drawn before the HUD text so readouts stay crisp).
    if (typeof drawHeatwaveGrade === "function") {
        drawHeatwaveGrade();
    }
    if (currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing) {
        drawMapTitle();
    }
    drawSpectatorBanner();
    hudProbeReset();
    drawHUD();
    drawMouseDriveIndicator();
    drawOffscreenGoalIndicator();
    if (typeof drawLobbyHubHud === "function") {
        drawLobbyHubHud();
    }
    // Brutal-mode match intro: a round-1, gated-state-only banner (guards inside).
    if (typeof drawGameModeIntro === "function") {
        drawGameModeIntro();
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
    // Bunker round: the goal is buried (no goal tiles), but players still need to
    // know where it is — point the arrow at the bunker. Scoped to the arrow so the
    // camera's finish-line punch-in doesn't fire on the buried goal.
    if (goals.length === 0 && typeof bunkerFX !== "undefined" && bunkerFX != null &&
        bunkerFX.phase === "buried" && bunkerFX.x != null) {
        goals = [{ x: bunkerFX.x, y: bunkerFX.y }];
    }
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
        // Bunker silo door: hold open while the camera pans out to reveal the buried
        // goal, seal shut during the whole-map beat (e≈0) so the player watches it
        // close on the full map, then stay shut as the camera zooms back in to race.
        if (typeof bunkerFX !== "undefined" && bunkerFX != null && bunkerFX.phase === "buried") {
            var cover;
            if (!(rest > 0)) {
                cover = 1;
            } else if (tt <= 0) {
                cover = 0; // still holding tight on the spawn — door open
            } else {
                var beatStart = rest * WORLD_ZOOM_GATE_OUT_FRAC;
                var beatEnd = rest - rest * WORLD_ZOOM_GATE_IN_FRAC;
                if (tt < beatStart) { cover = 0; }
                else if (beatEnd > beatStart && tt < beatEnd) { cover = smoothstep((tt - beatStart) / (beatEnd - beatStart)); }
                else { cover = 1; }
            }
            bunkerFX.camCover = cover;
        }
        // Heatwave reveal: tiles burn over during the whole-map beat — exactly the
        // bunker-door window — so every player watches the arena transform at full
        // zoom-out, then races the changed map. camReveal being non-null tells the
        // wall-clock fallback (updateHeatwaveReveal) the camera intro owns the clock.
        if (typeof heatwaveFX !== "undefined" && heatwaveFX != null && !heatwaveFX.done) {
            var reveal = 0;
            if (!(rest > 0)) {
                reveal = 1;
            } else if (tt > 0) {
                var hwStart = rest * WORLD_ZOOM_GATE_OUT_FRAC;
                var hwEnd = rest - rest * WORLD_ZOOM_GATE_IN_FRAC;
                if (tt >= hwEnd) { reveal = 1; }
                else if (tt > hwStart && hwEnd > hwStart) { reveal = (tt - hwStart) / (hwEnd - hwStart); }
            }
            heatwaveFX.camReveal = reveal;
            heatwaveRevealAdvance(reveal);
        }
        var scale = 1 + (focusedView.scale - 1) * e;
        return clampViewToWorld(focusedView.cx, focusedView.cy, scale);
    }
    var racingScale = focusedView.scale;
    // Second Wind death-beat: when the LOCAL player has gone down on an attuned flag,
    // slow-pan from the death spot to the flag over the respawn delay, then release back
    // to the normal follow (the kart reappears at the flag as the pan lands). Takes
    // priority over the other racing camera tweaks. Solo-local only (set in the handler)
    // so it never yanks a shared co-op camera off a still-racing partner.
    if (secondWindCam != null) {
        var swElapsed = Date.now() - secondWindCam.startedAt;
        // Safety release: the revive event normally clears this; if it's lost, don't
        // strand the camera. Hold a beat past the pan so it doesn't snap before respawn.
        if (swElapsed > secondWindCam.ms + 2500) {
            secondWindCam = null;
        } else {
            // Ease to the flag over the delay, then HOLD there (clamped) until the
            // revive event releases — so the camera is already on the flag as you pop in.
            var swE = smoothstep(Math.max(0, Math.min(1, swElapsed / Math.max(1, secondWindCam.ms))));
            var swcx = secondWindCam.fromX + (secondWindCam.toX - secondWindCam.fromX) * swE;
            var swcy = secondWindCam.fromY + (secondWindCam.toY - secondWindCam.fromY) * swE;
            return clampViewToWorld(swcx, swcy, racingScale);
        }
    }
    // Warp pad transit: when the LOCAL player drives onto a warp pad it commits and goes
    // invisible (frozen in transit server-side); slow-pan from the entrance pad to the exit
    // over the transit, then HOLD on the exit until the emerge event (warpEnd) releases the
    // camera back to the follow — so the kart pops in right where the camera already is.
    // (Set by the warpStart handler; only for a local warp.) Same priority/shape as the
    // Second Wind beat.
    if (warpCam != null) {
        if (Date.now() > warpCam.endAt) {
            warpCam = null; // failsafe: the warpEnd event was lost — don't strand the camera
        } else {
            var wRaw = Math.max(0, Math.min(1, (Date.now() - warpCam.startedAt) / Math.max(1, warpCam.ms)));
            var wE = smoothstep(wRaw);
            var wcx = warpCam.fromX + (warpCam.toX - warpCam.fromX) * wE;
            var wcy = warpCam.fromY + (warpCam.toY - warpCam.fromY) * wE;
            // Pull the camera OUT mid-journey (a sine bump: normal at the ends, widest at the
            // midpoint) so you see the ground you're crossing, then ease back in to arrive
            // tight on the exit. updateWorldCamera follows the warp target DIRECTLY (a=1), so
            // this pan+zoom isn't damped by the usual exponential filter — it reads crisply.
            var warpScale = Math.max(1, racingScale * (1 - WARP_ZOOM_OUT * Math.sin(wRaw * Math.PI)));
            return clampViewToWorld(wcx, wcy, warpScale);
        }
    }
    // Back the camera off while aiming/throwing an aimed ability (bomb/ice) so
    // it's easier to aim and follow the shot; the smoothing eases it out and back.
    if (localAimedAbilityActive()) {
        racingScale = Math.max(1, racingScale * AIM_ZOOM_OUT_FACTOR);
    }
    // Star Power FOV: while a local star is live, curve the view wider with a
    // slow breathing wobble; the exponential smoothing below (WORLD_ZOOM_TAU)
    // turns both the onset and the release into a gentle glide.
    if (localStarPowerUntil() > 0) {
        racingScale = Math.max(1, racingScale * (STAR_ZOOM_OUT_FACTOR + 0.03 * Math.sin(Date.now() / 480)));
    }
    // Bunker emerge cinematic: when the goal erupts for the lone survivor, pull the
    // camera back to frame the bunker — peaking as the door bursts open and the SFX
    // fires (BUNKER_EMERGE timeline) — hold, then ease back to following the survivor.
    if (typeof bunkerFX !== "undefined" && bunkerFX != null && bunkerFX.phase === "emerging" &&
        typeof BUNKER_EMERGE !== "undefined" && bunkerFX.x != null) {
        var ems = Date.now() - bunkerFX.animStart;
        var peakEnd = BUNKER_EMERGE.panOut + BUNKER_EMERGE.hold;
        var emTotal = peakEnd + BUNKER_EMERGE.panIn;
        var w; // 0 = follow survivor, 1 = pulled back on the bunker
        if (ems < BUNKER_EMERGE.panOut) { w = smoothstep(ems / BUNKER_EMERGE.panOut); }
        else if (ems < peakEnd) { w = 1; }
        else if (ems < emTotal) { w = 1 - smoothstep((ems - peakEnd) / BUNKER_EMERGE.panIn); }
        else { w = 0; }
        if (w > 0) {
            var pbScale = 1 + (focusedView.scale - 1) * 0.15; // pull most of the way to whole-map
            var pcx = focusedView.cx + (bunkerFX.x - focusedView.cx) * w;
            var pcy = focusedView.cy + (bunkerFX.y - focusedView.cy) * w;
            racingScale = racingScale + (pbScale - racingScale) * w;
            return clampViewToWorld(pcx, pcy, racingScale);
        }
    }
    // Locked-door cinematic: on a key PICKUP (ping) or door UNLOCK, pull the camera back
    // toward the door so every player notices it — peaking mid-animation (the unlock burst
    // is timed to this peak), then easing back to the normal follow. Unlock pulls harder.
    if (typeof doorFX !== "undefined" && doorFX != null && doorFX.x != null) {
        var dcfg = (typeof config !== "undefined" && config && config.lockedDoor) ? config.lockedDoor : {};
        var dtotal = doorFX.kind === "unlock" ? (dcfg.zoomOutMs || 1700) : (dcfg.pingMs || 1300);
        var dms2 = Date.now() - doorFX.animStart;
        if (dms2 >= dtotal) {
            doorFX = null;
        } else {
            var dPanOut = dtotal * 0.32, dHold = dtotal * 0.30, dPanIn = dtotal - dPanOut - dHold;
            var dw;
            if (dms2 < dPanOut) { dw = smoothstep(dms2 / dPanOut); }
            else if (dms2 < dPanOut + dHold) { dw = 1; }
            else { dw = 1 - smoothstep((dms2 - dPanOut - dHold) / dPanIn); }
            if (dw > 0) {
                var pullFrac = doorFX.kind === "unlock" ? 0.30 : 0.55; // smaller = more zoom-out
                var dScale = 1 + (focusedView.scale - 1) * pullFrac;
                var dcx2 = focusedView.cx + (doorFX.x - focusedView.cx) * dw;
                var dcy2 = focusedView.cy + (doorFX.y - focusedView.cy) * dw;
                racingScale = racingScale + (dScale - racingScale) * dw;
                return clampViewToWorld(dcx2, dcy2, racingScale);
            }
        }
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
    // While the intro arc runs — OR a local warp-pad pan is active — the target is already a
    // precise, eased time-ramp (the gate arc / the warpCam smoothstep), so follow it DIRECTLY
    // (a=1): the usual exponential filter would lag the pan ~WORLD_ZOOM_TAU behind, making the
    // sweep feel sluggish. Everywhere else (racing, lobby, mid-countdown re-enable) smooth
    // exponentially.
    var warpFollow = (typeof warpCam !== "undefined" && warpCam != null);
    var a = (followArc || warpFollow) ? 1 : (1 - Math.exp(-cdt / WORLD_ZOOM_TAU));
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
    iceSkater: "Slid the furthest on ice",
    smoothOperator: "Drifted the furthest on ice",
    firewalker: "Finished a Heatwave round untouched by scorched ground"
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
    iceSkater: "⛸️",
    smoothOperator: "🏂",
    firewalker: "👣"
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
    // Teams: the TEAM is the winner — Crimson/Jade backdrop + headline, with the
    // clincher's recap below as usual. The team payload survives removeBots(), so
    // a bot clinching for its team can't blank the screen.
    var teamWin = (typeof gameOverTeam !== "undefined") ? gameOverTeam : null;
    // playerList[playerWon] can be gone if the winner was an AI racer that
    // removeBots() cleared at the gameOver->waiting transition — guard the deref.
    if (playerWon == null || (teamWin == null && playerList[playerWon] == null)) {
        return;
    }
    var backdrop = teamWin ? teamWin.color : playerList[playerWon].color;
    gameContext.save();
    gameContext.fillStyle = backdrop;
    gameContext.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    gameContext.fill();
    gameContext.restore();

    // Readable ink for everything drawn over the winner-coloured backdrop.
    var ink = gameOverInk(backdrop);

    gameContext.save();
    gameContext.fillStyle = ink.fill;
    gameContext.strokeStyle = ink.stroke;
    gameContext.lineWidth = 4;
    gameContext.lineJoin = "round";
    gameContext.font = '48px serif';
    var winString = teamWin ? ("Team " + teamWin.name + " won the game!") : (decodedColorName + " won the game.");
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

// Land-lunge dash streak: a few tapered speed lines trailing BEHIND the kart along
// its burst direction, fading fast. Seeded by the server "landLunge" event; the
// lunge's own punch already pops a shockwave, so this only adds the "whoosh" sense
// of motion. Direction comes from the kart's velocity (the impulse just snapped it
// to top speed in the held direction); falls back to facing if barely moving.
function spawnLungeEffect(owner, dirX, dirY) {
    if (owner == null) { return; }
    var dx, dy;
    var dm = (dirX != null && dirY != null) ? Math.sqrt(dirX * dirX + dirY * dirY) : 0;
    if (dm > 0.001) {
        dx = dirX / dm; dy = dirY / dm; // server-sent lunge direction (most accurate)
    } else {
        var vx = owner.velX || 0, vy = owner.velY || 0;
        var m = Math.sqrt(vx * vx + vy * vy);
        if (m > 1) { dx = vx / m; dy = vy / m; }
        else { var a = (owner.angle || 0) * Math.PI / 180; dx = Math.cos(a); dy = Math.sin(a); }
    }
    var ox = owner.x, oy = owner.y;
    var color = owner.color || "white";
    var len = 46;
    addEffect({
        x: ox,
        y: oy,
        maxAge: 240,
        draw: function (ctx, t) {
            var fade = 1 - t;
            ctx.save();
            ctx.lineCap = "round";
            // three offset streak lines fanned slightly across the dash axis
            var perpX = -dy, perpY = dx;
            for (var i = -1; i <= 1; i++) {
                var sx = ox + perpX * i * 7;
                var sy = oy + perpY * i * 7;
                var headX = sx + dx * len * (0.25 + 0.75 * t);   // lines streak outward as they fade
                var headY = sy + dy * len * (0.25 + 0.75 * t);
                var tailX = headX - dx * len * 0.7;
                var tailY = headY - dy * len * 0.7;
                ctx.globalAlpha = fade * (i === 0 ? 0.7 : 0.4);
                ctx.strokeStyle = color;
                ctx.lineWidth = (i === 0 ? 5 : 3) * fade + 1;
                ctx.shadowColor = color;
                ctx.shadowBlur = glowBlur(10 * fade);
                ctx.beginPath();
                ctx.moveTo(tailX, tailY);
                ctx.lineTo(headX, headY);
                ctx.stroke();
            }
            ctx.restore();
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
// Drifting (client-side read): winding up a punch while standing on ice. Derived
// locally — chargeFrac is already synced per tick and the footing comes from the
// same cached nearest-cell scan the on-fire-on-lava flash uses — so the cue needs
// no new network field and mirrors the server's charging-on-ice traction gate.
function isDriftingClient(player) {
    if (player == null || !(player.charge > 0.001)) { return false; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing
        && currentState != config.stateMap.gated && currentState != config.stateMap.lobby) { return false; }
    if (currentMap == null || currentMap.cells == null) { return false; }
    return nearestCellIdCached(player) == config.tileMap.ice.id;
}
// ---- Ice drift cues --------------------------------------------------------
// Shared pool of short-lived ice-spray specks kicked up by drifting karts.
// Stored in WORLD coords; the camera offset is applied at draw time (per the
// camera convention — never bake the offset into stored positions). A hard cap
// keeps a whole pack drifting at once cheap; specks are plain alpha'd arc fills
// (no per-frame shadowBlur in this hot path).
var _driftSpray = [];
var DRIFT_SPRAY_MAX = 240;
// Per-frame drift state for one kart: eases the counter-steer lean (so a tap
// punch never pops the squash), tracks the travel heading the lean tilts
// against, and feeds the spray pool while actually drifting.
function updateDriftCue(player, dt) {
    var drifting = isDriftingClient(player);
    var step = (dt || 16.7);
    var prev = player._driftLean || 0;
    var target = drifting ? 1 : 0;
    var lean = prev + (target - prev) * Math.min(1, step / 140); // ~140ms ease
    player._driftLean = lean < 0.005 ? 0 : lean;
    var speed = Math.sqrt((player.velX || 0) * (player.velX || 0) + (player.velY || 0) * (player.velY || 0));
    if (speed > 1) {
        player._driftHeading = Math.atan2(player.velY, player.velX);
    }
    if (!drifting || speed < 8 || _driftSpray.length >= DRIFT_SPRAY_MAX) { return; }
    // Frost chips fan out behind the kart toward both flanks, faster when you're
    // carrying more speed into the slide.
    var h = player._driftHeading || 0;
    var count = 1 + (speed > 60 ? 1 : 0);
    for (var i = 0; i < count; i++) {
        var side = (Math.random() < 0.5 ? -1 : 1);
        var a = h + Math.PI + side * (0.35 + Math.random() * 0.5);
        var sp = 14 + Math.random() * 30 + speed * 0.12;
        _driftSpray.push({
            x: player.x - Math.cos(h) * player.radius * 0.8 + (Math.random() - 0.5) * 4,
            y: player.y - Math.sin(h) * player.radius * 0.8 + (Math.random() - 0.5) * 4,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            born: Date.now(),
            life: 320 + Math.random() * 220,
            size: 0.9 + Math.random() * 1.5
        });
    }
}
// Advance + draw every live spray speck, compacting expired ones in place.
// Called once per frame from drawPlayers BEFORE the karts so spray sits under them.
function drawDriftSpray(dt) {
    if (_driftSpray.length === 0) { return; }
    var now = Date.now();
    var step = (dt || 16.7) / 1000;
    var ox = camera.getCameraX(), oy = camera.getCameraY();
    gameContext.save();
    var w = 0;
    for (var i = 0; i < _driftSpray.length; i++) {
        var p = _driftSpray[i];
        var age = now - p.born;
        if (age >= p.life) { continue; }
        _driftSpray[w++] = p;
        p.x += p.vx * step;
        p.y += p.vy * step;
        p.vx *= 0.92; p.vy *= 0.92; // chips bleed speed fast, like spray settling
        var lifeFrac = age / p.life;
        gameContext.globalAlpha = 0.75 * (1 - lifeFrac);
        gameContext.fillStyle = lifeFrac < 0.4 ? "#eafaff" : "#bfeaf7";
        gameContext.beginPath();
        gameContext.arc(p.x + ox, p.y + oy, p.size * (1 - lifeFrac * 0.5), 0, 2 * Math.PI);
        gameContext.fill();
    }
    _driftSpray.length = w;
    gameContext.restore();
}
// World distance past which another kart's drift skid is inaudible (local kart is
// always full volume). Linear falloff to silence keeps a far-off bot's hiss from
// muddying the mix while a nearby carve still reads.
var DRIFT_AUDIBLE_RANGE = 950;
// Ids whose drift loop we started last frame, so we can stop the ones that ended
// (a kart that released, left the ice, died, or left the room) — the audio sweep
// owns start/stop edges centrally rather than per drawPlayer (which skips dead /
// off-camera karts and would otherwise leak a hanging voice).
var _driftAudioOn = {};
function updateDriftAudio() {
    if (typeof setDriftSound !== "function") { return; }
    var playState = (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing
        || currentState == config.stateMap.gated || currentState == config.stateMap.lobby);
    var nowOn = {};
    if (playState) {
        var anchor = playerList[myID]; // local primary kart, for distance falloff
        for (var id in playerList) {
            var p = playerList[id];
            if (p == null || p.alive === false || !isDriftingClient(p)) { continue; }
            var speed = Math.sqrt((p.velX || 0) * (p.velX || 0) + (p.velY || 0) * (p.velY || 0));
            if (speed < 8) { continue; } // a parked charge on ice slides nowhere -> no skid
            var level = 1;
            if (!isLocalId(id) && anchor != null) {
                var dx = p.x - anchor.x, dy = p.y - anchor.y;
                level = clamp01(1 - Math.sqrt(dx * dx + dy * dy) / DRIFT_AUDIBLE_RANGE);
            }
            if (level <= 0.02) { continue; }
            var intensity = clamp01(speed / (config.playerMaxSpeed * 0.5));
            setDriftSound(id, intensity, level);
            nowOn[id] = true;
        }
    }
    for (var oid in _driftAudioOn) {
        if (!nowOn[oid]) { stopDriftSound(oid); }
    }
    _driftAudioOn = nowOn;
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
    // Ice-drift spray sits UNDER every kart so the chips read as kicked-up ground frost.
    drawDriftSpray(dt);
    // Per-frame drift skid audio (synthesized loop per drifting kart, distance-faded).
    updateDriftAudio();
    // Per-frame fire-walk sizzle (local kart striding over lava/water on the shield).
    updateFireWalkAudio();
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
    // A racer mid warp-pad transit is invisible — it's been whisked into the portal and
    // emerges at the exit on warpEnd. Skip drawing its kart (+ trail/FX). The failsafe
    // clears a stuck flag if the warpEnd event was ever lost, so a kart can't vanish forever.
    if (player.warping === true) {
        if (player.warpHideUntil != null && Date.now() >= player.warpHideUntil) {
            player.warping = false;
        } else {
            return;
        }
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
    // Track the water->land exit every frame in EVERY state (lobby pool included) so the
    // drip can fire wherever a kart can swim — not just mid-race.
    updateWaterDrip(player);
    if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
        drawTrail(player);
        // Swim ripples ride ON TOP of the normal trail while the kart is in water — but
        // a fire-walker strides across (no swimming), so its shield steams instead.
        if (!(player.onFire > 0)) {
            drawSwimRipple(player);
        }
    }
    // Dead — or in the Second Wind death-beat (frozen, playing the standard death
    // animation before the respawn): don't draw the live kart, just the death skull.
    if (player.alive == false || player.secondWindDown) {
        drawDeathMessage(player);
        return;
    }
    // Airborne (Launch Pad / Barrel Cannon flight): the kart hops up along a parabola with
    // a shrinking ground shadow so it reads as flying OVER the terrain (the server already
    // lerps its ground position along the arc; this is the purely-cosmetic vertical lift).
    // Client-only state set by the airbornePending/airborneLand handlers.
    // Self-clearing backstop (independent of camera bounds) so a dropped airborneLand never
    // strands the kart in the airborne branch (suppressing its FX, or — for barrelLoaded —
    // keeping it hidden) after the flight should have ended.
    if (player.airborne != null && Date.now() > player.airborne.startAt + player.airborne.ms + 600) {
        player.airborne = null;
    }
    if (player.airborne != null) {
        if (camera.inBounds(player)) { drawAirborneKart(player, dt); }
        return; // aloft: hopped when in view, otherwise skip the normal ground draw
    }
    // Loaded in a Barrel Cannon: the racer is INSIDE the barrel (hidden), which spins on
    // its own to show the aim (the barrel hazard streams its angle — see boons.js). We only
    // draw the burning fuse counting down to launch; the kart is hidden until it fires.
    if (player.barrelLoaded != null && Date.now() > player.barrelLoaded.startAt + player.barrelLoaded.ms + 600) {
        player.barrelLoaded = null;
    }
    if (player.barrelLoaded != null) {
        if (camera.inBounds(player)) { drawBarrelLoadedFx(player); }
        return;
    }
    // Riding a Zipline: the kart is clipped onto the cable. Lift it off the ground with a
    // shadow + draw a trolley clamped on the rope over it + a strap, so it reads as hanging
    // from the line rather than driving beside it. Client-only state (ziplineBoard/End).
    // Self-clearing backstop (like the airborne branch): if a ziplineEnd is ever missed, drop
    // the rig once the max ride time lapses so the kart can't hang under a phantom trolley forever.
    if (player.ziplining != null && player.ziplining.until != null && Date.now() > player.ziplining.until) {
        player.ziplining = null;
    }
    if (player.ziplining != null) {
        if (camera.inBounds(player)) { drawZiplineKart(player, dt); }
        return;
    }
    if (camera.inBounds(player)) {
        drawPlayer(player, dt);
        // Wet sheen + droplets on top of the kart while it dries off after swimming.
        drawWaterDrip(player);
        // Flame-walking FX: steam off the shield on water, embers on lava (unified).
        drawFireWalkFX(player);
    }
}
// Airborne hop: parabolic vertical lift + a shrinking ground shadow. drawPlayer reads
// player.x/y (+camera) everywhere, so we lift the kart by temporarily raising player.y for
// the one draw call and restore it immediately. Skips drip/fire FX (irrelevant aloft).
function drawAirborneKart(player, dt) {
    var a = player.airborne;
    var t = Math.max(0, Math.min(1, (Date.now() - a.startAt) / Math.max(1, a.ms)));
    var hop = 4 * t * (1 - t); // 0 -> 1 -> 0 over the flight
    var maxHop = 28;
    var hopPx = maxHop * hop;
    var br = (config.playerBaseRadius || 7.5);
    var gx = player.x + camera.getCameraX();
    var gy = player.y + camera.getCameraY();
    // Ground shadow under the arc — shrinks + fades as the kart rises.
    gameContext.save();
    gameContext.globalAlpha = 0.30 * (1 - 0.6 * hop);
    gameContext.fillStyle = "#000";
    gameContext.beginPath();
    gameContext.ellipse(gx, gy, br * (1.15 - 0.45 * hop), br * (0.6 - 0.25 * hop), 0, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.restore();
    var savedY = player.y;
    player.y = savedY - hopPx; // up is -y
    // try/finally so a throw inside the hot drawPlayer path can't leave player.y lifted
    // (which would feed interpolation + render the kart at the wrong height all round).
    try {
        drawPlayer(player, dt);
    } finally {
        player.y = savedY;
    }
}
// Zipline ride: the kart is clipped onto the cable and HANGS UNDER it. The cable line stays
// at the streamed position (gx,gy, where the static rope is drawn); the trolley clamps there
// and the kart dangles straight down from it on a strap. drawPlayer reads player.x/y
// (+camera) everywhere, so we drop the kart by temporarily lowering player.y for the one draw
// call and restore it in a finally (a throw can't strand the kart displaced).
function drawZiplineKart(player, dt) {
    var br = (config.playerBaseRadius || 7.5);
    var gx = player.x + camera.getCameraX();
    var gy = player.y + camera.getCameraY();           // the CABLE point (trolley clamps here)
    var bob = Math.sin(Date.now() / 220) * 1.2;
    var hang = br + 8 + bob;                            // how far below the cable the kart dangles
    var rad = (player.ziplining.angle || 0) * (Math.PI / 180);
    var dirX = Math.cos(rad), dirY = Math.sin(rad);
    var ky = gy + hang;                                 // hanging kart centre (straight DOWN)
    // Faint contact shadow under the hanging kart.
    gameContext.save();
    gameContext.globalAlpha = 0.22;
    gameContext.fillStyle = "#000";
    gameContext.beginPath();
    gameContext.ellipse(gx, ky + br * 0.7, br * 0.95, br * 0.45, 0, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.restore();
    // Strap from the cable down to the kart (drawn UNDER the kart so it tucks into the roof).
    gameContext.save();
    gameContext.lineCap = "round";
    gameContext.strokeStyle = ZIP_STRAP; gameContext.lineWidth = 3;
    gameContext.beginPath(); gameContext.moveTo(gx, gy); gameContext.lineTo(gx, ky - br * 0.5); gameContext.stroke();
    gameContext.restore();
    // The kart, dropped to the hanging position.
    var savedY = player.y;
    player.y = savedY + hang;
    try {
        drawPlayer(player, dt);
    } finally {
        player.y = savedY;
    }
    // Trolley + cable bit OVER everything, clamped on the cable line above the kart.
    var seg = 16;
    gameContext.save();
    gameContext.lineCap = "round";
    // rope segment (twin gold strands over a dark halo) — the bit of cable the trolley grips
    gameContext.beginPath();
    gameContext.moveTo(gx - dirX * seg, gy - dirY * seg);
    gameContext.lineTo(gx + dirX * seg, gy + dirY * seg);
    gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 6; gameContext.stroke();
    gameContext.strokeStyle = "#F2C14E"; gameContext.lineWidth = 2.5; gameContext.stroke();
    // trolley pulley clamped on the rope
    gameContext.beginPath(); gameContext.arc(gx, gy, 5, 0, 2 * Math.PI);
    gameContext.fillStyle = ZIP_STEEL; gameContext.fill();
    gameContext.strokeStyle = "#e9eef2"; gameContext.lineWidth = 2; gameContext.stroke();
    gameContext.beginPath(); gameContext.arc(gx, gy, 1.8, 0, 2 * Math.PI);
    gameContext.fillStyle = "#F2C14E"; gameContext.fill();
    // a couple of faint speed streaks trailing back along the cable (at the kart's level)
    gameContext.strokeStyle = "rgba(255,255,255,0.35)"; gameContext.lineWidth = 1.5;
    for (var i = 0; i < 2; i++) {
        var so = (i - 0.5) * 5;
        var bxs = gx - dirX * (10 + ((Date.now() / 90 + i * 13) % 10)) + (-dirY) * so;
        var bys = ky - dirY * (10 + ((Date.now() / 90 + i * 13) % 10)) + (dirX) * so;
        gameContext.globalAlpha = 0.5;
        gameContext.beginPath();
        gameContext.moveTo(bxs, bys);
        gameContext.lineTo(bxs - dirX * 7, bys - dirY * 7);
        gameContext.stroke();
    }
    gameContext.globalAlpha = 1;
    gameContext.restore();
}
// Barrel-loaded telegraph: just a burning fuse counting down to the auto-launch (the barrel
// itself spins to show the aim — see boons.js streamAngle; the racer is hidden inside it).
// Press punch to fire now, or the fuse fires you when it burns out.
function drawBarrelLoadedFx(player) {
    var bl = player.barrelLoaded;
    var now = Date.now();
    if (now > bl.startAt + bl.ms + 300) { player.barrelLoaded = null; return; }
    var t = Math.max(0, Math.min(1, (now - bl.startAt) / Math.max(1, bl.ms))); // fuse burn 0..1
    var cx = player.x + camera.getCameraX();
    var cy = player.y + camera.getCameraY();
    var pulse = 0.5 + 0.5 * Math.sin(now / 150);
    gameContext.save();
    gameContext.lineCap = "round";
    gameContext.lineJoin = "round";
    // Burning fuse: a wick curling up from the barrel that shortens as it burns, with a
    // bright spark at the burning tip. Flickers red + faster near the end (imminent launch).
    var imminent = t > 0.72;
    var br = (config.playerBaseRadius || 7.5);
    var wickBaseX = cx, wickBaseY = cy - br * 1.4;       // top of the barrel
    var wickLen = 16 * (1 - t);                           // burns down toward the barrel
    var curl = 6;
    var tipX = wickBaseX + curl, tipY = wickBaseY - wickLen;
    gameContext.globalAlpha = 1;
    gameContext.beginPath();
    gameContext.moveTo(wickBaseX, wickBaseY);
    gameContext.quadraticCurveTo(wickBaseX + curl, wickBaseY - wickLen * 0.5, tipX, tipY);
    gameContext.strokeStyle = "rgba(40,28,18,0.9)"; gameContext.lineWidth = 3; gameContext.stroke();
    // Spark at the burning tip.
    var sparkFlick = imminent ? (0.5 + 0.5 * Math.sin(now / 50)) : pulse;
    var sparkR = 3 + 2.2 * sparkFlick;
    gameContext.fillStyle = imminent ? "#ff5a2e" : "#ffd23f";
    gameContext.globalAlpha = 0.85 + 0.15 * sparkFlick;
    gameContext.beginPath();
    gameContext.arc(tipX, tipY, sparkR, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.fillStyle = "#fff6c8";
    gameContext.globalAlpha = 0.9;
    gameContext.beginPath();
    gameContext.arc(tipX, tipY, sparkR * 0.45, 0, 2 * Math.PI);
    gameContext.fill();
    // A couple of stray sparks flying off near the end.
    if (imminent) {
        for (var i = 0; i < 3; i++) {
            var sa = (now / 60 + i * 2.1);
            var sd = 4 + (i + 1) * 2.5 * sparkFlick;
            gameContext.globalAlpha = 0.5 * (1 - sparkFlick * 0.4);
            gameContext.beginPath();
            gameContext.arc(tipX + Math.cos(sa) * sd, tipY + Math.sin(sa) * sd, 1.4, 0, 2 * Math.PI);
            gameContext.fillStyle = "#ffb04a";
            gameContext.fill();
        }
    }
    gameContext.globalAlpha = 1;
    gameContext.restore();
}
// =========================== Infection zombie body ===========================
// Ported from docs/spikes/zombie-prototype.html — the "Infected sprinter" variant
// (PALETTES.infected + {bulk:0.95, pace:1.6, glowEyes:1}). While player.infected,
// the kart body is REPLACED by this top-down zombie; the biohazard tag-radius ring
// and the #7CFC00 punch ring are unchanged. The flag clears on round reset
// (gameboard.js), so the kart reverts automatically.
//
// Perf: the prototype's drawZombie builds gradients every call and uses shadowBlur
// for the eye glow — both banned in the frame path (docs/spikes/skin-render-perf.md).
// The whole lurch cycle is baked ONCE into an offscreen sprite sheet: ZOMBIE_FRAMES
// frames over one arm-swing period, with every sine rate snapped to an integer
// multiple of the arm rate so the baked loop closes seamlessly (the prototype's
// free-running sines never exactly repeat). Live cost per zombie = one ellipse fill
// (ground shadow) + one rotated drawImage; the drunken stagger, lurch bob, and punch
// lunge ride on cheap canvas transforms.
var ZOMBIE_FRAMES = 16;
var ZOMBIE_FRAME_PX = 128;          // baked at ~2.5x the on-screen size, so it stays crisp
var ZOMBIE_SPAN = 122;              // design units per frame (~118-unit box + margin)
var ZOMBIE_BODY_SCALE = 5.6;        // frame box spans radius*5.6 world units — arms clear the
                                    // r=15 tag ring (kart radius is 7.5, so span = 42)
var ZOMBIE_PACE = 1.6;              // sprinter preset: everything lurches faster
var ZOMBIE_BULK = 0.95;
var ZOMBIE_ARM_RATE = 2.2 * ZOMBIE_PACE; // rad/s; one baked cycle = 2PI/this seconds
var ZOMBIE_PAL = {
    skin: '#7ed957', skinHi: '#9cf07a', skinDark: '#48a23c',
    shirt: '#2e6b3a', shirtDark: '#1d472a', pants: '#3f5a3a',
    hair: '#1f3a22', wound: '#a33b3b', bone: '#e8e0cc',
    eyeW: '#ffe0e0', pupil: '#3a0d0d', glow: '#ff4040'
};
var zombieSheet = null; // lazy-baked on the first infected render

function zombieArmPose(s, ph) {
    var ext = Math.sin(ph + (s > 0 ? 0 : 2.8));
    return {
        elbow: [s * 16 + s * ext * 0.5, -16 + ext * 1.5],
        hand: [s * 9.5 - s * ext * 1.2, -26 - ext * 3.5]
    };
}

function zombieFleshStroke(ctx, pts, w) {
    var P = ZOMBIE_PAL;
    var i;
    ctx.strokeStyle = P.skinDark; ctx.lineWidth = w + 2.2;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (i = 1; i < pts.length; i++) { ctx.lineTo(pts[i][0], pts[i][1]); }
    ctx.stroke();
    ctx.strokeStyle = P.skin; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (i = 1; i < pts.length; i++) { ctx.lineTo(pts[i][0], pts[i][1]); }
    ctx.stroke();
}

// One pose of the lurch cycle in design space (origin = kart centre, facing -y).
// ph runs 0..2PI over the arm-swing period. Gradients/shadowBlur are fine HERE
// because this only runs at bake time, never per frame.
function bakeZombieFrame(ctx, ph) {
    var S = Math.sin, C = Math.cos, PI = Math.PI;
    var P = ZOMBIE_PAL;
    var s, i, pose;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // (the prototype's stagger rotation + lurch bob are applied LIVE at blit time)
    // shuffling feet — the trailing foot drags, toes out (orig 5*pace ~= 2x arm rate)
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        var stride = s > 0 ? S(2 * ph) * 4 : S(2 * ph + PI) * 2;
        ctx.fillStyle = P.pants; ctx.strokeStyle = P.shirtDark; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(s * (6 + (s < 0 ? 1.5 : 0)), 14 - stride, 3.2, 5.2, s * (s < 0 ? 0.5 : 0.12), 0, PI * 2);
        ctx.fill(); ctx.stroke();
    }
    // hips
    ctx.fillStyle = P.pants; ctx.strokeStyle = P.shirtDark; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 12, 9, 5, 0, 0, PI * 2); ctx.fill(); ctx.stroke();

    // upper body scales by bulk around the shoulder line
    ctx.save();
    ctx.translate(0, -4); ctx.scale(ZOMBIE_BULK, ZOMBIE_BULK); ctx.translate(0, 4);

    // belly
    var bg = ctx.createLinearGradient(0, -2, 0, 14);
    bg.addColorStop(0, P.shirt); bg.addColorStop(1, P.shirtDark);
    ctx.fillStyle = bg; ctx.strokeStyle = P.shirtDark; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 5, 11, 8, 0, 0, PI * 2); ctx.fill(); ctx.stroke();

    // arms reach forward (roots tucked under the shoulders) + torn sleeve stubs
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        pose = zombieArmPose(s, ph);
        zombieFleshStroke(ctx, [[s * 13, -6], pose.elbow, pose.hand], 4);
        ctx.strokeStyle = P.shirt; ctx.lineWidth = 5.4;
        ctx.beginPath(); ctx.moveTo(s * 13, -6);
        ctx.lineTo(s * 13 + (pose.elbow[0] - s * 13) * 0.45, -6 + (pose.elbow[1] + 6) * 0.45);
        ctx.stroke();
    }

    // hunched shoulders (shirt)
    var sg = ctx.createLinearGradient(0, -12, 0, 2);
    sg.addColorStop(0, P.shirt); sg.addColorStop(1, P.shirtDark);
    ctx.fillStyle = sg; ctx.strokeStyle = P.shirtDark; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, -4, 15, 8, 0, 0, PI * 2); ctx.fill(); ctx.stroke();
    // torn shoulder — skin showing through
    ctx.fillStyle = P.skin; ctx.strokeStyle = P.skinDark; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.ellipse(9.5, -6, 3.2, 2.4, 0.5, 0, PI * 2); ctx.fill(); ctx.stroke();
    // gore splotches
    ctx.globalAlpha = 0.8; ctx.fillStyle = P.wound;
    ctx.beginPath(); ctx.ellipse(-6, -2, 2.6, 1.8, -0.4, 0, PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(3, 1.5, 1.4, 0, PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    // hands with grasping finger nubs (orig 6*pace ~= 3x arm rate)
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        pose = zombieArmPose(s, ph);
        var grasp = S(3 * ph + s) * 0.6;
        ctx.fillStyle = P.skin; ctx.strokeStyle = P.skinDark; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.arc(pose.hand[0], pose.hand[1], 3, 0, PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = P.skinHi;
        for (var f = -1; f <= 1; f++) {
            var fa = -PI / 2 + f * (0.55 + grasp * 0.18) + s * 0.12;
            ctx.beginPath();
            ctx.arc(pose.hand[0] + C(fa) * 3.4, pose.hand[1] + S(fa) * 3.4, 1.15, 0, PI * 2);
            ctx.fill();
        }
    }

    // head — hunched forward, wobbling (orig 2.1/1.3*pace snapped to 1x arm rate,
    // phase-shifted so the wobble doesn't run in lockstep with the arms)
    ctx.save();
    ctx.translate(0, -13 + S(ph + 1.3) * 0.6);
    ctx.rotate(S(ph + 2.1) * 0.12);
    var hg = ctx.createRadialGradient(-3, -3.5, 2, 0, 0, 9.5);
    hg.addColorStop(0, P.skinHi); hg.addColorStop(1, P.skinDark);
    ctx.fillStyle = hg; ctx.strokeStyle = P.skinDark; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, PI * 2); ctx.fill(); ctx.stroke();
    // matted hair patch over the back of the crown
    ctx.fillStyle = P.hair;
    ctx.beginPath();
    ctx.moveTo(-7.8, -1);
    ctx.quadraticCurveTo(-8.5, 6, -3.5, 8.2);
    ctx.quadraticCurveTo(0, 9.3, 3.5, 8.2);
    ctx.quadraticCurveTo(8.5, 6, 7.8, -1);
    ctx.quadraticCurveTo(4, 2.5, 0, 1.8);
    ctx.quadraticCurveTo(-4, 2.5, -7.8, -1);
    ctx.closePath(); ctx.fill();
    // stray strands
    ctx.strokeStyle = P.hair; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-6.5, 0.5); ctx.lineTo(-9.4, -2.2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(6.8, 1); ctx.lineTo(9.6, -0.8); ctx.stroke();
    // exposed skull wound
    ctx.fillStyle = P.bone; ctx.strokeStyle = P.wound; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(4.3, -1.4, 2.5, 1.9, 0.5, 0, PI * 2); ctx.fill(); ctx.stroke();
    // milky eyes near the front edge
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        ctx.fillStyle = P.eyeW; ctx.strokeStyle = P.skinDark; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.arc(s * 3.4, -5.6, 1.6, 0, PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = P.pupil;
        ctx.beginPath();
        ctx.arc(s * 3.4 + S(ph + s) * 0.6, -5.9, 0.55, 0, PI * 2);
        ctx.fill();
    }
    // glowing eyes (sprinter preset) — shadowBlur is OK at bake time only
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.55 + 0.3 * S(2 * ph));
    ctx.fillStyle = P.glow; ctx.shadowColor = P.glow; ctx.shadowBlur = 5;
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        ctx.beginPath(); ctx.arc(s * 3.4, -5.7, 1.1, 0, PI * 2); ctx.fill();
    }
    ctx.restore();
    // groaning mouth at the front rim
    ctx.fillStyle = P.pupil;
    ctx.beginPath();
    ctx.ellipse(0, -8.2, 1.6, 0.9 + Math.max(0, S(ph)) * 0.7, 0, 0, PI * 2);
    ctx.fill();
    ctx.restore(); // head

    ctx.restore(); // bulk group
    ctx.restore(); // root
}

function buildZombieSheet() {
    zombieSheet = document.createElement('canvas');
    zombieSheet.width = ZOMBIE_FRAMES * ZOMBIE_FRAME_PX;
    zombieSheet.height = ZOMBIE_FRAME_PX;
    var ctx = zombieSheet.getContext('2d');
    for (var i = 0; i < ZOMBIE_FRAMES; i++) {
        ctx.save();
        ctx.translate(i * ZOMBIE_FRAME_PX + ZOMBIE_FRAME_PX / 2, ZOMBIE_FRAME_PX / 2);
        ctx.scale(ZOMBIE_FRAME_PX / ZOMBIE_SPAN, ZOMBIE_FRAME_PX / ZOMBIE_SPAN);
        bakeZombieFrame(ctx, (i / ZOMBIE_FRAMES) * Math.PI * 2);
        ctx.restore();
    }
}

// Blit the zombie body at screen (sx,sy), rotated to the kart heading. Called from
// the same body-draw scopes as the sprite/skin (drawPlayer + drawKartAppearance),
// so camera offset, dim/immune alpha, and drift-lean transforms are all inherited.
// headingOverride pins a static pose (mirrors drawCartSkin's pinned contract).
function drawZombieBody(player, sx, sy, headingOverride) {
    if (zombieSheet == null) { buildZombieSheet(); }
    var ctx = gameContext;
    var pinned = (typeof headingOverride === "number");
    var heading = pinned ? headingOverride : getCartHeading(player);
    var t = pinned ? 0 : cartSkinAnimTime;
    // Radius fallback: a partially-initialised player record (just-joined, mid-reset)
    // would otherwise feed NaN through every sizing expression below and silently
    // corrupt the canvas state for the rest of the frame.
    var span = (player.radius || 7.5) * ZOMBIE_BODY_SCALE;
    var frame = Math.floor((t * ZOMBIE_ARM_RATE / (2 * Math.PI)) * ZOMBIE_FRAMES) % ZOMBIE_FRAMES;
    if (frame < 0) { frame += ZOMBIE_FRAMES; }
    ctx.save();
    // try/finally so nothing between save and restore can leak the translated/
    // rotated transform onto the rest of the frame (same convention as the kart
    // body draws in drawPlayer).
    try {
        // soft ground shadow — unrotated ambient blob, like the prototype's
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.beginPath();
        ctx.ellipse(sx, sy + span * 0.02, span * 0.17, span * 0.085, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.translate(sx, sy);
        ctx.rotate(heading + Math.PI / 2); // sheet faces -y; heading 0 = due east
        if (!pinned) {
            ctx.rotate(Math.sin(t * 2.5 * ZOMBIE_PACE) * 0.05); // drunken stagger
            ctx.translate(0, Math.sin(t * 10 * ZOMBIE_PACE) * 0.5 * (span / ZOMBIE_SPAN)); // lurch bob
        }
        // punch lunge — same impact cue as drawCartSkin; forward is local -y here
        if (player.punchAnimAt != null) {
            var pe = (Date.now() - player.punchAnimAt) / 220;
            if (pe >= 0 && pe < 1) {
                var pk = (pe < 0.3) ? (pe / 0.3) : (1 - (pe - 0.3) / 0.7);
                ctx.translate(0, -pk * span * 0.12);
                ctx.scale(1 + pk * 0.14, 1 + pk * 0.14);
            }
        }
        ctx.drawImage(zombieSheet, frame * ZOMBIE_FRAME_PX, 0, ZOMBIE_FRAME_PX, ZOMBIE_FRAME_PX,
            -span / 2, -span / 2, span, span);
    } finally {
        ctx.restore();
    }
}

function drawPlayer(player, dt) {

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
    // Guard Halo shield: a protective ring around the kart while a one-hit shield is
    // held (set by the guardShield/guardShieldPopped events). Behind the body too.
    drawGuardShieldFx(player);
    drawSpeedFx(player);
    // Ice drift cue state: eases the counter-steer lean applied to the kart body
    // below and feeds the shared ice-spray pool (drawn under all karts in drawPlayers).
    updateDriftCue(player, dt);
    // Draw a halo behind your own kart(s) — the primary plus every couch co-op
    // slot — so you can always find yourself in a crowded pack.
    if (isLocalId(player.id)) {
        drawLocalPlayerHighlight(player);
        drawStaminaMeter(player);
    }
    // Team underglow under the LIVE kart body (the live path inlines its own body
    // draw below and never goes through drawKartAppearance). Before the punch-charge
    // telegraph and OUTSIDE the dim/immune alpha scopes, so team identity stays
    // readable even on dimmed rival karts. Camera offset applied per convention.
    drawTeamUnderglow(player, player.x + camera.getCameraX(), player.y + camera.getCameraY());
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
    // Drift lean: squash the kart slightly about its own centre — narrower along the
    // travel axis, wider across it — like an edge digging in on a counter-steer. The
    // transform composes with the absolute screen coords every body draw below uses
    // (border/sprite/avatar/pattern/skin all squash together). The Powder trail
    // (the Smooth Operator unlock) makes the lean noticeably more dramatic.
    var driftLean = player._driftLean || 0;
    var leaning = driftLean > 0.02;
    if (leaning) {
        var leanK = driftLean * (player.trailFx === 'powder' ? 0.16 : 0.09);
        var lcx = player.x + camera.getCameraX();
        var lcy = player.y + camera.getCameraY();
        var lh = player._driftHeading || 0;
        gameContext.save();
        gameContext.translate(lcx, lcy);
        gameContext.rotate(lh);
        gameContext.scale(1 - leanK, 1 + leanK);
        gameContext.rotate(-lh);
        gameContext.translate(-lcx, -lcy);
    }
    // try/finally so a thrown drawImage (e.g. an undecoded sprite -> InvalidStateError)
    // can't skip the restore() and leak the dimmed/flash alpha onto the rest of the frame.
    try {
        // Infected racers shamble as the zombie INSTEAD of their kart body: skip every
        // body cosmetic (border/sprite/avatar/pattern/skin) so the silhouette reads as
        // pure horde. Same screen anchor + alpha/lean scopes as the body draws below.
        if (player.infected == true) {
            drawZombieBody(player, player.x + camera.getCameraX(), player.y + camera.getCameraY());
        } else {
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
        } // end non-infected body draws
        // The base sprite (skipped for skinned karts) is where the "you're being
        // targeted" red rim lives, so re-draw that tell around the skin (or the zombie,
        // which also skips the sprite) when this kart is in an aimer's target list
        // (swap/explosive).
        if ((hasCartSkin || player.infected == true) && playerStrokeColor === "red") {
            gameContext.save();
            gameContext.beginPath();
            gameContext.lineWidth = 3;
            gameContext.strokeStyle = "red";
            gameContext.arc(player.x + camera.getCameraX(), player.y + camera.getCameraY(), player.radius + 1, 0, 2 * Math.PI);
            gameContext.stroke();
            gameContext.restore();
        }
    } finally {
        // Restores in reverse order of the saves above: lean -> dim -> immune.
        if (leaning) {
            gameContext.restore();
        }
        if (dimKart) {
            gameContext.restore();
        }
        if (immune) {
            gameContext.restore();
        }
    }

    if (player.infected == true) {
        // Tag-radius telegraph. Used to be a filled biohazard disc, but that disc
        // (r=15 world units) completely swallowed the zombie body that replaces the
        // kart above — so it's a thin toxic-green ring instead: the reach cue
        // survives, the zombie reads. Drawn AFTER the body so the ring always sits
        // on top of the sprite, and anchored to the same camera-offset coords as
        // the body so the two can never drift apart on offset-camera devices.
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = 2;
        gameContext.arc(player.x + camera.getCameraX(), player.y + camera.getCameraY(),
            config.brutalRounds.infection.radius, 0, 2 * Math.PI);
        gameContext.strokeStyle = "rgba(124,252,0,0.55)";
        gameContext.stroke();
        gameContext.restore();
    }

    if (player.ability != null) {
        drawAbilityIndicator(player.x, player.y, player);
    }
    if (player.heldKey != null && typeof drawHeldKey === "function") {
        drawHeldKey(player);
    }
    drawEmoji(player);
    drawBotName(player);
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

// Frost white -> cyan -> deep ice blue while DRIFT-charging on ice, so a drift
// wind-up reads at a glance as "carving for grip", not the warm white->orange->red
// of an attacking haymaker. Same 11-bucket string cache as punchChargeColor.
var _driftChargeColorCache = [];
function driftChargeColor(frac) {
    var key = frac < 0 ? 0 : (frac > 1 ? 10 : Math.round(frac * 10));
    var cached = _driftChargeColorCache[key];
    if (cached) { return cached; }
    var f = key / 10, out;
    if (f < 0.5) {
        var t = f / 0.5;               // frost white -> cyan
        out = "rgb(" + Math.round(235 - 95 * t) + "," + Math.round(250 - 30 * t) + ",255)";
    } else {
        var t2 = (f - 0.5) / 0.5;      // cyan -> deep ice blue
        out = "rgb(" + Math.round(140 - 80 * t2) + "," + Math.round(220 - 60 * t2) + ",255)";
    }
    _driftChargeColorCache[key] = out;
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
        if (ocBuilding) { chargeRumble(0.18 + 0.3 * ocLevel); if (typeof chargeTraumaForId === "function") { chargeTraumaForId(player.id, 0.18 + 0.3 * ocLevel); } }
        else if (isCharging) { chargeRumble(0.1 + 0.14 * chargeLevel); if (typeof chargeTraumaForId === "function") { chargeTraumaForId(player.id, 0.1 + 0.14 * chargeLevel); } }
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
    // A charge held ON ICE is a drift: frost the ring so it never reads as a haymaker.
    var drifting = isCharging && isDriftingClient(player);
    var color = exhausted ? "rgb(150,150,150)" : (drifting ? driftChargeColor(level) : punchChargeColor(level));
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

// Guard Halo shield: a gold hexagonal ring orbiting a kart that holds a one-hit
// shield (player.guardShield, toggled by the guardShield/guardShieldPopped events).
// Cheap stroked hexagon with a slow spin + gentle pulse; no gradient/shadowBlur.
function drawGuardShieldFx(player) {
    if (!player.guardShield) {
        return;
    }
    var now = Date.now();
    var r = player.radius;
    var pulse = 1 + 0.06 * Math.sin(now / 160);
    var ringR = (r + 6) * pulse;
    var spin = now / 900;
    var cfg = (config.boons != null && config.boons.guardHalo != null) ? config.boons.guardHalo : null;
    var col = cfg != null ? cfg.color : "#FFD166";
    gameContext.save();
    gameContext.translate(player.x, player.y);
    gameContext.rotate(spin);
    gameContext.globalAlpha = 0.85;
    gameContext.strokeStyle = col;
    gameContext.lineWidth = 2.5;
    gameContext.lineJoin = "round";
    gameContext.beginPath();
    for (var i = 0; i < 6; i++) {
        var a = i * (Math.PI / 3);
        var px = Math.cos(a) * ringR;
        var py = Math.sin(a) * ringR;
        if (i === 0) { gameContext.moveTo(px, py); } else { gameContext.lineTo(px, py); }
    }
    gameContext.closePath();
    gameContext.stroke();
    gameContext.globalAlpha = 1;
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

// Every racer carries a visible name below the kart, Discord-style. AI racers
// show their personality name; human players (name === null) are labelled by the
// colour they're playing, via Colors.nameFor. Aligned with the sprite's camera
// convention (camera offset is 0 in the default desktop view).
function drawBotName(player) {
    var label = (typeof Colors !== "undefined") ? Colors.nameFor(player) : player.name;
    if (label == null) { return; }
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
    gameContext.strokeText(label, x, y);
    gameContext.fillText(label, x, y);
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
// The shield doesn't snap off — it fades over its final FLAME_FADE_MS as onFire (the
// live remaining ms) runs down, so a flame burning out on lava OR boiling away on water
// dies away gracefully instead of vanishing in one frame.
var FLAME_FADE_MS = 600;
function drawFire(player) {
    gameContext.save();
    if (player.onFire < FLAME_FADE_MS) {
        gameContext.globalAlpha = Math.max(0, player.onFire / FLAME_FADE_MS);
    }
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
// Flame-walking FX: while a kart carries the killstreak shield over lava OR water it
// kicks up a unified plume — pale steam off boiling water, hot embers off lava — that
// loft and fade as it moves. Purely cosmetic and procedural (seeded by id+time, no
// stored particle state), drawn in the camera-translated gameplay pass (raw world
// coords, like drawWaterDrip). The looping sizzle SFX is driven separately, local-only,
// by updateFireWalkAudio so remote karts don't each spin up a voice.
function drawFireWalkFX(player) {
    if (!(player.onFire > 0)) { return; }
    if (config == null || config.tileMap == null) { return; }
    var cid = nearestCellIdCached(player);
    var waterTile = config.tileMap.water;
    var onWater = (waterTile != null && cid === waterTile.id);
    var onLava = (cid === config.tileMap.lava.id);
    if (!onWater && !onLava) { return; }
    var now = Date.now();
    var ctx = gameContext;
    var sx = player.x, sy = player.y, r = player.radius || 7.5;
    var dim = isLocalId(player.id) ? 1 : NONLOCAL_TRAIL_ALPHA;
    var idSeed = (player.id && player.id.charCodeAt) ? (player.id.charCodeAt(0) || 0) + (player.id.charCodeAt(1) || 0) : 0;
    ctx.save();
    if (onWater) {
        // Steam plumes lofting straight up as the shield boils the water beneath.
        var puffs = 6;
        for (var i = 0; i < puffs; i++) {
            var seed = i * 53 + idSeed;
            var ph = ((now * 0.0011) + (i / puffs)) % 1;          // 0 just off the kart -> 1 dissipated
            var px = sx + Math.sin(seed + now * 0.002) * (r * 0.9);
            var py = sy - ph * (r * 3.2);
            ctx.globalAlpha = 0.22 * (1 - ph) * dim;
            ctx.fillStyle = "rgba(232,240,248,1)";
            ctx.beginPath();
            ctx.arc(px, py, 2.5 + ph * 5.5, 0, Math.PI * 2);
            ctx.fill();
        }
    } else {
        // Lava embers: hot sparks flung up that cool from gold to ember as they rise.
        var sparks = 5;
        for (var j = 0; j < sparks; j++) {
            var s2 = j * 37 + idSeed;
            var ph2 = ((now * 0.0016) + (j / sparks)) % 1;
            var ang = s2 * 1.3 + now * 0.003;
            var ex = sx + Math.cos(ang) * (r * 0.8);
            var ey = sy - ph2 * (r * 2.6);
            ctx.globalAlpha = 0.5 * (1 - ph2) * dim;
            ctx.fillStyle = ph2 < 0.5 ? "rgba(255,210,120,1)" : "rgba(255,120,40,1)";
            ctx.beginPath();
            ctx.arc(ex, ey, 1.6 * (1 - ph2) + 0.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();
}
// Once-per-frame, local-kart-only: keep the looping fire-walk sizzle in sync with the
// local player's footing. A single voice (like the drift skid) that washes in while the
// shield rides over lava/water and fades out the moment it isn't — unified across both.
function updateFireWalkAudio() {
    if (typeof setFireWalkSound !== "function") { return; }
    var me = (typeof myPlayer !== "undefined") ? myPlayer : null;
    var active = false;
    if (me != null && me.alive && me.onFire > 0 && config != null && config.tileMap != null &&
        (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing)) {
        var cid = nearestCellIdCached(me);
        var waterTile = config.tileMap.water;
        if ((waterTile != null && cid === waterTile.id) || cid === config.tileMap.lava.id) {
            active = true;
            var sp = Math.sqrt((me.velX || 0) * (me.velX || 0) + (me.velY || 0) * (me.velY || 0));
            var inten = Math.max(0.2, Math.min(1, sp / 90));
            setFireWalkSound(me.id, inten, 1);
        }
    }
    if (!active && typeof stopFireWalkSound === "function") {
        stopFireWalkSound((me != null) ? me.id : null);
    }
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
        if (projectileList[proj].type == 'turretShot') {
            // A glowing red energy bolt oriented along its flight (angle shipped on
            // spawn): a trailing streak + layered ellipses (outer glow -> hot body ->
            // white-hot core). All flat fills — no per-frame filter/shadow (mobile GPU).
            var tp = projectileList[proj];
            var tr = tp.radius || 14;
            gameContext.save();
            gameContext.translate(tp.x, tp.y);
            gameContext.rotate((tp.angle || 0) * (Math.PI / 180));
            var streak = gameContext.createLinearGradient(-tr * 2.6, 0, 0, 0);
            streak.addColorStop(0, "rgba(255,90,55,0)");
            streak.addColorStop(1, "rgba(255,120,70,0.55)");
            gameContext.fillStyle = streak;
            gameContext.beginPath();
            gameContext.moveTo(-tr * 2.6, 0);
            gameContext.lineTo(0, -tr * 0.5);
            gameContext.lineTo(0, tr * 0.5);
            gameContext.closePath();
            gameContext.fill();
            gameContext.globalAlpha = 0.4;
            gameContext.fillStyle = "#ff5436";
            gameContext.beginPath();
            gameContext.ellipse(0, 0, tr * 1.3, tr * 0.72, 0, 0, 2 * Math.PI);
            gameContext.fill();
            gameContext.globalAlpha = 1;
            gameContext.fillStyle = "#ff8a3c";
            gameContext.beginPath();
            gameContext.ellipse(0, 0, tr * 0.85, tr * 0.46, 0, 0, 2 * Math.PI);
            gameContext.fill();
            gameContext.fillStyle = "#fff3d0";
            gameContext.beginPath();
            gameContext.ellipse(tr * 0.12, 0, tr * 0.42, tr * 0.24, 0, 0, 2 * Math.PI);
            gameContext.fill();
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
        case config.tileMap.abilities.orbitalBeam.id:
            drawProjectileAimer(x, y, player.angle, "#b388ff", config.tileMap.abilities.orbitalBeam.aimerLength);
            break;
        case config.tileMap.abilities.swap.id:
        case config.tileMap.abilities.bombTrigger.id:
        default:
            // Size the armed ring off the SAME skin-scaled radius the team underglow
            // uses (drawTeamUnderglow: radius * CART_SKIN_VISUAL_SCALE + 5), not the
            // raw radius — otherwise on skinned/large karts the solid team-colour ring
            // grows but the dashed ability ring doesn't, the two concentric rings cross,
            // and "this kart holds an ability" becomes unreadable against the team ring.
            // When the player is on a team, push the ring out enough to leave a clear
            // annular gap OUTSIDE the team underglow so the two never read as one band.
            var skinScale = (cartSkinPainter(player.cart) != null) ? CART_SKIN_VISUAL_SCALE : 1;
            var onTeam = (player.teamId != null && typeof teamInfo !== "undefined" && teamInfo != null && !player.infected);
            var armedRadius = player.radius * skinScale + (onTeam ? 4 : 0);
            drawArmedRing(x, y, player.color, armedRadius);
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
// slowly rotating dashed ring that pulses, in the player's colour. The caller
// passes an already skin-scaled (and, in team modes, outward-nudged) radius; the
// internal +9 keeps it orbiting OUTSIDE the local-player halo (which sits at
// radius+5 and glows past it) and outside the team underglow — otherwise the
// rings merged into one smear when you held an ability. A thin dark backing keeps
// the dashes legible where they cross the halo's glow.
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
// Cached Path2D covering every water cell (world coords), used to CLIP the swim ripple
// so its expanding rings are cut off at the shoreline instead of spilling onto land.
// Rebuilt only when the terrain cache changes (mapCacheRev — water turns to lava on
// collapse); the rev-first guard caches the "no water" (null) result too.
var _waterClipPath = null, _waterClipRev = -1;
function ensureWaterClipPath() {
    if (_waterClipRev === mapCacheRev) { return _waterClipPath; }
    _waterClipRev = mapCacheRev;
    _waterClipPath = null;
    if (currentMap == null || currentMap.cells == null || config.tileMap.water == null ||
        typeof Path2D === "undefined") {
        return null;
    }
    var wId = config.tileMap.water.id, cells = currentMap.cells, p = new Path2D(), any = false;
    for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        if (cell.id !== wId) { continue; }
        var hes = cell.halfedges;
        if (!hes.length) { continue; }
        var v = getStartpoint(hes[0]);
        p.moveTo(v.x, v.y);
        for (var h = 0; h < hes.length; h++) { v = getEndpoint(hes[h]); p.lineTo(v.x, v.y); }
        p.closePath();
        any = true;
    }
    _waterClipPath = any ? p : null;
    return _waterClipPath;
}
// Swim ripples: an ADDITIVE overlay on top of the kart's normal trail while it sits in
// water — reuses the Ripples cosmetic renderer (drawRippleTrail) so a swimmer leaves
// expanding rings WITHOUT replacing their equipped trail (which still draws beneath, via
// drawTrail just before this). Footing is read client-side from the cached nearest-cell
// scan — the same source the drift cue uses — so no new network field is needed. Clipped
// to the water cells so the rings can't expand past the shoreline onto land.
function drawSwimRipple(player) {
    var waterTile = (typeof config !== "undefined" && config.tileMap) ? config.tileMap.water : null;
    var rippleFx = (typeof TRAIL_FX !== "undefined") ? TRAIL_FX["ripple"] : null;
    if (waterTile == null || rippleFx == null) { return; }
    // NOTE: intentionally NOT gated on currently-being-on-water. The per-vertex water
    // filter below scopes the rings to the swum stretch, and letting it run after the
    // kart climbs out means the rings on those (now aging) water vertices keep fading
    // naturally instead of snapping off the instant it touches land.
    var trail = player.trail;
    if (trail == null || trail.vertices == null || trail.vertices.length < 2) { return; }
    // Keep only the vertices that sit OVER water, so the rings hug the swum stretch and
    // don't trail back onto the land the kart came from. Membership is cached per vertex
    // (verts never move) so this costs ~nothing after a vertex is first seen.
    var src = trail.vertices; // already age-trimmed by drawTrail, which ran first
    var verts = [];
    for (var vi = 0; vi < src.length; vi++) {
        var sv = src[vi];
        if (sv._overWater === undefined) {
            var scell = (typeof nearestCell === "function") ? nearestCell(sv.x, sv.y) : null;
            sv._overWater = (scell != null && scell.id === waterTile.id);
        }
        if (sv._overWater) { verts.push(sv); }
    }
    if (verts.length < 2) { return; }
    var fadeMs = (typeof TRAIL_FADE_MS !== "undefined") ? TRAIL_FADE_MS : 5000;
    // Toned-down: the swim ripple is an ambient water disturbance layered over the kart's
    // real trail, so keep it subtle (well under the full-strength Ripples cosmetic) and in
    // a neutral pale-water tint — NOT the player colour, so it reads as disturbed water and
    // doesn't compete with / look like the kart's own trail.
    var SWIM_RIPPLE_ALPHA = 0.4;
    var SWIM_RIPPLE_COLOR = "#cfeaff";
    var baseAlpha = (isLocalId(player.id) ? 1 : NONLOCAL_TRAIL_ALPHA) * SWIM_RIPPLE_ALPHA;
    gameContext.save();
    // Clip to the water surface so expanding rings are cut at the shoreline (not spilled
    // onto land). Drawn in the same camera-translated world space as the verts.
    var clip = ensureWaterClipPath();
    if (clip != null) { gameContext.clip(clip); }
    gameContext.lineWidth = 3;
    gameContext.lineCap = "round";
    gameContext.lineJoin = "round";
    tfxBaseAlpha = baseAlpha;
    rippleFx(gameContext, verts, SWIM_RIPPLE_COLOR, Date.now(), fadeMs, cartSkinAnimTime * 1000);
    tfxBaseAlpha = 1;
    gameContext.restore();
}
// "Dripping wet": derive the drip state client-side (no network field) by watching for a
// water -> land footing transition, mirroring the server's water.dripMs window. Stamped
// every frame so drawWaterDrip can fade a wet sheen + falling droplets as the kart dries.
// Visual drip window — a touch longer than the server's physics slow (water.dripMs ~800)
// so the "shaking off water" beat is clearly visible as the kart dries.
var WATER_DRIP_VISUAL_MS = 1200;
function updateWaterDrip(player) {
    var waterTile = (typeof config !== "undefined" && config.tileMap) ? config.tileMap.water : null;
    if (waterTile == null) { return; }
    var onWater = nearestCellIdCached(player) === waterTile.id;
    if (player._wasOnWater && !onWater) {
        player._dripUntil = Date.now() + WATER_DRIP_VISUAL_MS;
    } else if (!player._wasOnWater && onWater &&
        typeof padPulseForId === "function" && isLocalId(player.id)) {
        // Splash in: a soft watery plomp on the diving local player's own pad.
        padPulseForId(player.id, 0.4, 0.45, 200);
    }
    player._wasOnWater = onWater;
}
function drawWaterDrip(player) {
    if (!player._dripUntil) { return; }
    var frac = (player._dripUntil - Date.now()) / WATER_DRIP_VISUAL_MS; // 1 just out -> 0 dry
    if (frac <= 0) { return; }
    // Same context as drawPlayer (camera-translated gameplay pass) -> raw world coords.
    var sx = player.x, sy = player.y, r = player.radius || 7.5;
    var dim = isLocalId(player.id) ? 1 : NONLOCAL_TRAIL_ALPHA;
    var ctx = gameContext;
    ctx.save();
    // Exit splash: a quick ring sheeting off the kart in the first ~third of the drip.
    var splash = (frac > 0.66) ? (frac - 0.66) / 0.34 : 0; // 1 at exit -> 0 a third in
    if (splash > 0) {
        ctx.globalAlpha = 0.55 * splash * dim;
        ctx.strokeStyle = "rgba(195,232,255,1)";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r + (1 - splash) * 11, 0, Math.PI * 2);
        ctx.stroke();
    }
    // Wet sheen: a bright cool rim all the way around the kart, fading as it dries.
    ctx.globalAlpha = 0.6 * frac * dim;
    ctx.strokeStyle = "rgba(205,238,255,1)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 1.5, 0, Math.PI * 2);
    ctx.stroke();
    // Droplets sliding off and falling, staggered so they don't drip in lockstep.
    var drops = 5;
    for (var i = 0; i < drops; i++) {
        var phase = (frac * 1.4 + i / drops) % 1;          // each drop on its own fall cycle
        var fall = (1 - phase) * (r * 3.0);
        var dx = sx + ((i / (drops - 1)) - 0.5) * r * 1.6;
        var dy = sy + r * 0.4 + fall;
        ctx.globalAlpha = 0.7 * phase * frac * dim;
        ctx.fillStyle = "rgba(150,210,250,1)";
        ctx.beginPath();
        ctx.arc(dx, dy, 2.4, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}
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
// Slow-boil warning overlay: water cells the collapse front has reached but that are
// still aging toward lava (server gameBoard.advanceBoilingWater, mirrored client-side in
// boilingCells). Three tiers escalate the warning — stage 0 simmer (faint bubbles),
// stage 1 boil (bubbles + steam wisps + warm tint), stage 2 rolling (violent churn +
// strong steam + orange glow pulse, "this is about to be lava"). Procedural + seeded by
// vid so the churn is stable per cell. Drawn in the camera-translated pass (raw world
// coords); centered at each cell site (no polygon clip needed — reads clearly as the
// tile heating up). Self-clears if we somehow draw outside a collapse.
function drawBoilingWater() {
    if (currentState != config.stateMap.collapsing) { clearBoilingWater(); return; }
    if (currentMap == null || currentMap.cells == null) { return; }
    var now = Date.now();
    var t = now * 0.001;
    var ctx = gameContext;
    for (var i = 0; i < currentMap.cells.length; i++) {
        var cell = currentMap.cells[i];
        var b = boilingCells[cell.site.voronoiId];
        if (b == null) { continue; }
        var stage = b.stage | 0;                  // 0..2
        var cx = cell.site.x, cy = cell.site.y;
        var intensity = (stage + 1) / 3;          // 0.33, 0.66, 1.0
        var pulse = 0.5 + 0.5 * Math.sin(t * (4 + stage * 3));
        ctx.save();
        // Warm radial glow — pale at a simmer, angry orange at a rolling boil.
        var R = 22 + stage * 4;
        var warm = stage >= 2 ? "255,90,30" : (stage >= 1 ? "255,150,60" : "255,205,130");
        var glowA = 0.08 + 0.13 * stage + 0.05 * pulse;
        var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        grad.addColorStop(0, "rgba(" + warm + "," + glowA.toFixed(3) + ")");
        grad.addColorStop(1, "rgba(" + warm + ",0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fill();
        // Bubbles: rising dots that pop at the surface, more + faster with each tier.
        var bubbles = 3 + stage * 3;
        for (var k = 0; k < bubbles; k++) {
            var seed = (cell.site.voronoiId * 13 + k * 7);
            var phase = ((t * (0.6 + 0.5 * stage)) + (seed % 100) / 100) % 1;
            var bx = cx + Math.sin(seed * 1.7 + k) * (R * 0.5);
            var by = cy + (R * 0.45) - phase * (R * 0.9);     // rise upward, pop near the top
            var br = (1.0 + stage * 0.7) * (0.4 + 0.6 * (1 - phase));
            ctx.globalAlpha = 0.5 * (1 - phase) * (0.6 + 0.4 * intensity);
            ctx.fillStyle = stage >= 2 ? "rgba(255,215,175,1)" : "rgba(222,240,255,1)";
            ctx.beginPath();
            ctx.arc(bx, by, Math.max(0.5, br), 0, Math.PI * 2);
            ctx.fill();
        }
        // Steam wisps from a boil on up — pale plumes lofting off the surface.
        if (stage >= 1) {
            var wisps = stage * 2;
            for (var w = 0; w < wisps; w++) {
                var seed2 = cell.site.voronoiId * 5 + w * 31;
                var ph = ((t * 0.4) + (seed2 % 100) / 100) % 1;
                var wx = cx + Math.sin(seed2 + t * 0.6) * (R * 0.4);
                var wy = cy - ph * (R * 1.3);
                ctx.globalAlpha = 0.22 * (1 - ph) * intensity;
                ctx.fillStyle = "rgba(230,238,245,1)";
                ctx.beginPath();
                ctx.arc(wx, wy, 3 + ph * 5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }
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
    // Author-placed barriers (fence/wall) sit on the terrain, under hazards/karts.
    drawBarriers();
    if (hasAnyKey(hazardList)) {
        for (var id in hazardList) {
            drawHazard(hazardList[id]);
        }
    }
    // Antlion dig-down fades play where a despawned antlion just was — it's no
    // longer in hazardList, so this is its own short-lived pass.
    drawAntlionBurrows();
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

function drawSwapTelegraphTile(cell, prog, now, explicitDestId) {
    var ctx = gameContext;
    var fastId = config.tileMap.fast.id, iceId = config.tileMap.ice.id;
    // The tileSwap telegraph infers its destination (fast<->ice); a heatwave
    // second-wave entry pins it explicitly (lava/water/dirt/ability ghosts).
    var destId = (explicitDestId != null) ? explicitDestId
        : (cell.id === fastId) ? iceId : (cell.id === iceId ? fastId : null);
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
        drawSwapTelegraphTile(cell, prog, now, tile.destId);
    }
    gameContext.restore();
    // Once every tile has flipped/cleared/expired, drop the telegraph.
    if (!hasAnyKey(set)) {
        pendingSwapCells = null;
    }
}

// --- Heatwave reveal + scorch visuals ---
// The round-start reveal is normally clocked by the gated camera arc (see the
// heatwave block in computeWorldViewTarget — same whole-map beat as the bunker
// door). This fallback drives it on the same beat fractions from wall-clock when
// that arc isn't running (world camera off, intro disarmed mid-countdown);
// camReveal being non-null means the camera owns the clock this round. startRace
// force-completes whatever is left either way.
function updateHeatwaveReveal() {
    if (typeof heatwaveFX === "undefined" || heatwaveFX == null || heatwaveFX.done) {
        return;
    }
    if (currentState !== config.stateMap.gated || heatwaveFX.camReveal != null) {
        return;
    }
    var rest = ((config.gatedWaitTime || 9) * 1000) - WORLD_ZOOM_HOLD_MS;
    var tt = (Date.now() - heatwaveFX.gatedAt) - WORLD_ZOOM_HOLD_MS;
    var reveal = 0;
    if (!(rest > 0)) {
        reveal = 1;
    } else if (tt > 0) {
        var hwStart = rest * WORLD_ZOOM_GATE_OUT_FRAC;
        var hwEnd = rest - rest * WORLD_ZOOM_GATE_IN_FRAC;
        if (tt >= hwEnd) { reveal = 1; }
        else if (tt > hwStart && hwEnd > hwStart) { reveal = (tt - hwStart) / (hwEnd - hwStart); }
    }
    heatwaveRevealAdvance(reveal);
}

// vid -> cell index for the per-frame heatwave paths. Rebuilt lazily when the
// map OBJECT changes (each round loads a fresh map; within a round cells mutate
// ids in place but never re-key), so the per-frame flash fills below are O(1)
// lookups instead of full-cell scans.
var _hwCellIndex = { map: null, byVid: null };
function heatwaveCellByVid(vid) {
    if (currentMap == null || currentMap.cells == null) { return null; }
    if (_hwCellIndex.map !== currentMap) {
        var byVid = {};
        for (var i = 0; i < currentMap.cells.length; i++) {
            byVid[currentMap.cells[i].site.voronoiId] = currentMap.cells[i];
        }
        _hwCellIndex = { map: currentMap, byVid: byVid };
    }
    var cell = _hwCellIndex.byVid[vid];
    return (cell != null) ? cell : null;
}

// Short burn-in flash on each freshly converted tile: an additive hot fill that
// pops and fades over ~450ms, leaving the baked scorch rim behind. Serves both
// the round-start reveal and the mid-race second wave. World coords (same pass
// as the swap telegraph).
var HEATWAVE_FLASH_MS = 450;
function drawHeatwaveFlashes() {
    if (typeof heatwaveFlashes === "undefined" || heatwaveFlashes.length === 0 ||
        currentMap == null || currentMap.cells == null) {
        return;
    }
    var now = Date.now();
    var ctx = gameContext;
    var kept = [];
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < heatwaveFlashes.length; i++) {
        var f = heatwaveFlashes[i];
        var age = now - f.at;
        if (age > HEATWAVE_FLASH_MS) { continue; }
        kept.push(f);
        var cell = heatwaveCellByVid(f.vid);
        if (cell == null || !traceCellPath(ctx, cell)) { continue; }
        var a = 1 - age / HEATWAVE_FLASH_MS;
        ctx.globalAlpha = 0.55 * a;
        ctx.fillStyle = "#ffb24a";
        ctx.fill();
    }
    ctx.restore();
    heatwaveFlashes = kept;
}

// Subtle screen-space warm tint while a Heatwave round is live, so the mode is
// felt mid-race and not just at the reveal. One translucent fill — cheap on
// every profile. Ramps in with the reveal so the heat "arrives" with the burn.
function drawHeatwaveGrade() {
    if (typeof brutalRoundConfig === "undefined" || brutalRoundConfig == null ||
        brutalRoundConfig.brutalTypes.indexOf(config.brutalRounds.heatwave.id) === -1) {
        return;
    }
    if (currentState != config.stateMap.gated &&
        currentState != config.stateMap.racing &&
        currentState != config.stateMap.collapsing) {
        return;
    }
    var strength = 1;
    if (typeof heatwaveFX !== "undefined" && heatwaveFX != null && !heatwaveFX.done) {
        strength = (heatwaveFX.camReveal != null) ? heatwaveFX.camReveal : (heatwaveFX.started ? 1 : 0);
    }
    if (strength <= 0) {
        return;
    }
    gameContext.save();
    gameContext.globalAlpha = 0.06 * strength;
    gameContext.fillStyle = "#ff7a26";
    gameContext.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    gameContext.restore();
}

// Permanent heatwave scorch, baked into the map cache (sand-trench pattern: zero
// per-frame cost, replayed on every cache rebuild while the world->cache
// transform is active). Each converted tile gets a charred rim traced along its
// border plus soot speckles; melted-ice water gets a dark wet-stone shoreline
// instead. Seeded by voronoiId so every re-bake lays identical marks.
function paintScorchMarks(ctx) {
    if (typeof heatwaveScorch === "undefined" || heatwaveScorch.length === 0 ||
        currentMap == null || currentMap.cells == null) {
        return;
    }
    var byVid = {};
    for (var i = 0; i < currentMap.cells.length; i++) {
        byVid[currentMap.cells[i].site.voronoiId] = currentMap.cells[i];
    }
    // Prune marks whose ground moved on (the trench-pruning rule): a mark only
    // lives while its tile still holds the id the heatwave gave it — so the
    // round-end collapse (or a bomb/swap/cannon) flooding a scorched tile takes
    // the char outline with it. Two refinements:
    //   - a sand->lava rim ALSO drops once every neighbour is lava (the collapse
    //     reached it — a char outline floating mid-lava-sea reads as a glitch);
    //   - a picked-up heatwave ability pad (ability id -> dirt) KEEPS its rim,
    //     because the ground still counts as scorched for the Firewalker medal.
    var lavaId = config.tileMap.lava.id, dirtId = config.tileMap.normal.id;
    var keptMarks = [];
    for (var pm = 0; pm < heatwaveScorch.length; pm++) {
        var m = heatwaveScorch[pm];
        var mcell = byVid[m.vid];
        if (mcell == null) { continue; }
        var keep;
        if (m.newId == null || mcell.id === m.newId) {
            keep = true;
            if (mcell.id === lavaId) {
                var hasNonLavaNeighbor = false;
                var mhes = mcell.halfedges;
                for (var mh = 0; mh < mhes.length; mh++) {
                    var nb = compareSite(mhes[mh].edge.lSite, mhes[mh].site) ? mhes[mh].edge.rSite : mhes[mh].edge.lSite;
                    var nbCell = (nb != null) ? byVid[nb.voronoiId] : null;
                    if (nbCell == null || nbCell.id !== lavaId) { hasNonLavaNeighbor = true; break; }
                }
                keep = hasNonLavaNeighbor;
            }
        } else {
            keep = (m.newId > 99 && mcell.id === dirtId);
        }
        if (keep) { keptMarks.push(m); }
    }
    heatwaveScorch = keptMarks;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var s = 0; s < heatwaveScorch.length; s++) {
        var mark = heatwaveScorch[s];
        var cell = byVid[mark.vid];
        if (cell == null || !traceCellPath(ctx, cell)) { continue; }
        // Wide soft band, then a tighter dark lip on the same path.
        ctx.globalAlpha = mark.water ? 0.30 : 0.34;
        ctx.strokeStyle = mark.water ? "#2e3d46" : "#1d130b";
        ctx.lineWidth = 9;
        ctx.stroke();
        ctx.globalAlpha = mark.water ? 0.45 : 0.55;
        ctx.lineWidth = 3.5;
        ctx.stroke();
        if (!mark.water) {
            var seed = 0;
            var vidStr = String(mark.vid);
            for (var ch = 0; ch < vidStr.length; ch++) { seed = (seed * 31 + vidStr.charCodeAt(ch)) >>> 0; }
            ctx.fillStyle = "#16100a";
            ctx.globalAlpha = 0.28;
            for (var p = 0; p < 5; p++) {
                seed = (seed * 1103515245 + 12345) >>> 0;
                var ang = (seed % 360) * Math.PI / 180;
                seed = (seed * 1103515245 + 12345) >>> 0;
                var dist = 4 + (seed % 18);
                seed = (seed * 1103515245 + 12345) >>> 0;
                var r = 1 + (seed % 100) / 50;
                ctx.beginPath();
                ctx.arc(cell.site.x + Math.cos(ang) * dist, cell.site.y + Math.sin(ang) * dist, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
    ctx.restore();
}

// --- Orbital Beam telegraph + strike ---
// Self-timed overlay (like drawPendingSwap): the server's "orbitalBeamCast" message
// seeds a locked beam line, this ramps a warning band along it for the fuse, then
// "orbitalBeamFired" flips it to a brief bright strike flash before it self-expires.
// Drawn in the world pass (raw world coords, no camera offset — same space as the
// karts and the swap telegraph).
var orbitalBeams = {}; // owner -> { x, y, angle, length, width, start, end, fired, firedAt }
var ORBITAL_STRIKE_MS = 380; // hot strike-flash duration after the beam fires

function markOrbitalBeam(data) {
    if (data == null) { return; }
    var now = Date.now();
    orbitalBeams[data.owner] = {
        x: data.x, y: data.y, angle: data.angle,
        length: data.length, width: data.width,
        start: now, end: now + data.duration,
        fired: false, firedAt: 0
    };
}

function orbitalBeamFiredFX(data) {
    if (data == null) { return; }
    var now = Date.now();
    var b = orbitalBeams[data.owner];
    if (b == null) {
        // Joined mid-fuse (no telegraph tracked): synthesize one straight into the strike.
        b = orbitalBeams[data.owner] = { start: now - 1, end: now };
    }
    // Trust the fire payload's authoritative geometry for the strike.
    b.x = data.x; b.y = data.y; b.angle = data.angle;
    b.length = data.length; b.width = data.width;
    b.fired = true;
    b.firedAt = now;
}

function fillBeamRect(ctx, ax, ay, px, py, halfW, dx, dy, length) {
    var bx = ax + dx * length, by = ay + dy * length;
    ctx.beginPath();
    ctx.moveTo(ax + px * halfW, ay + py * halfW);
    ctx.lineTo(bx + px * halfW, by + py * halfW);
    ctx.lineTo(bx - px * halfW, by - py * halfW);
    ctx.lineTo(ax - px * halfW, ay - py * halfW);
    ctx.closePath();
    ctx.fill();
}

function drawOrbitalBeamTelegraph() {
    if (!hasAnyKey(orbitalBeams)) { return; }
    var now = Date.now();
    var ctx = gameContext;
    for (var owner in orbitalBeams) {
        var b = orbitalBeams[owner];
        if (b.fired) {
            if (now - b.firedAt > ORBITAL_STRIKE_MS) { delete orbitalBeams[owner]; continue; }
        } else if (now > b.end + 250) {
            // Fuse elapsed but no fire arrived (left/teardown) — drop the stale telegraph.
            delete orbitalBeams[owner];
            continue;
        }
        var rad = b.angle * Math.PI / 180;
        var dx = Math.cos(rad), dy = Math.sin(rad);
        var px = -dy, py = dx;            // perpendicular (band half-width axis)
        var halfW = b.width / 2;
        var ax = b.x, ay = b.y;
        var ex = b.x + dx * b.length, ey = b.y + dy * b.length;
        ctx.save();
        if (b.fired) {
            // Strike: a hot core that fades fast, with an outward-widening scorch halo.
            var t = clamp01((now - b.firedAt) / ORBITAL_STRIKE_MS);
            var fade = 1 - t;
            ctx.globalAlpha = 0.5 * fade;
            ctx.fillStyle = "#ff6a1a";
            fillBeamRect(ctx, ax, ay, px, py, halfW * (1 + t * 1.6), dx, dy, b.length);
            ctx.globalAlpha = 0.9 * fade;
            ctx.fillStyle = "#fff3c0";
            fillBeamRect(ctx, ax, ay, px, py, halfW * (1 - 0.5 * t), dx, dy, b.length);
        } else {
            var prog = clamp01((now - b.start) / (b.end - b.start));
            // Pulse accelerates + the band reddens as the strike nears (swap-aimer feel).
            var phase = (now / 1000) * (1.5 + 6 * prog) * Math.PI * 2;
            var pulse = 0.5 + 0.5 * Math.sin(phase);
            var hot = prog > 0.66;
            // Warning band fill.
            ctx.globalAlpha = (0.06 + 0.22 * prog) * (0.6 + 0.4 * pulse);
            ctx.fillStyle = hot ? "#ff5a2a" : "#b388ff";
            fillBeamRect(ctx, ax, ay, px, py, halfW, dx, dy, b.length);
            // Bright marching center line, thickening toward the strike.
            ctx.globalAlpha = 0.4 + 0.55 * pulse * (0.4 + 0.6 * prog);
            ctx.strokeStyle = hot ? "#ffd24a" : "#e0c8ff";
            ctx.lineWidth = lerp(2, 7, prog);
            ctx.lineCap = "round";
            ctx.setLineDash([14, 10]);
            ctx.lineDashOffset = -(now / 18) % 24;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            // Edge rails so the impact WIDTH reads clearly.
            ctx.setLineDash([]);
            ctx.globalAlpha = (0.3 + 0.4 * prog) * (0.5 + 0.5 * pulse);
            ctx.lineWidth = 2;
            ctx.strokeStyle = hot ? "#ffb060" : "#cdb0ff";
            ctx.beginPath();
            ctx.moveTo(ax + px * halfW, ay + py * halfW);
            ctx.lineTo(ex + px * halfW, ey + py * halfW);
            ctx.moveTo(ax - px * halfW, ay - py * halfW);
            ctx.lineTo(ex - px * halfW, ey - py * halfW);
            ctx.stroke();
        }
        ctx.restore();
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
    // Heatwave scorch rims bake here too (same zero-per-frame trick); before the
    // stone seams so a wet shoreline never paints over a water/lava ledge.
    paintScorchMarks(mapCtx);
    drawEmptyBorders(mapCtx);
    drawStoneBorders(mapCtx);
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
// Stone seam where water meets lava: that boundary is a SOLID wall (engine
// bounceOffStoneEdges blocks crossing it), so it must read distinctly — not like an
// open water/lava border. Stroke each water-cell edge whose neighbour is lava as a
// chunky stone ledge (dark lip + light highlight, like drawEmptyBorders' rim). Mirrors
// the server's ensureStoneEdges adjacency test (lSite/rSite -> neighbour tile id).
var stoneBorderOuter = "#2c2c33";
var stoneBorderInner = "#9a9aa4";
function drawStoneBorders(ctx) {
    if (currentMap == null || currentMap.cells == null || config.tileMap.water == null) {
        return;
    }
    var waterId = config.tileMap.water.id, lavaId = config.tileMap.lava.id;
    var cells = currentMap.cells;
    // Most maps have no water — bail before the neighbour-index build + per-edge work.
    var anyWater = false;
    for (var w = 0; w < cells.length; w++) {
        if (cells[w].id === waterId) { anyWater = true; break; }
    }
    if (!anyWater) {
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
        if (cell.id != waterId) {
            continue;
        }
        var halfedges = cell.halfedges;
        for (var h = 0; h < halfedges.length; h++) {
            var he = halfedges[h];
            var neighbor = compareSite(he.edge.lSite, he.site) ? he.edge.rSite : he.edge.lSite;
            if (neighbor == null || idByVoronoi[neighbor.voronoiId] != lavaId) {
                continue; // only the water/lava seam is a wall
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
    // Chunky dark lip then a thinner light highlight — a raised stone ledge look that
    // reads as impassable, distinct from the open lava border.
    ctx.lineWidth = 7;
    ctx.strokeStyle = stoneBorderOuter;
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = stoneBorderInner;
    ctx.stroke();
    ctx.restore();
}
