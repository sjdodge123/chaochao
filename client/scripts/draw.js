var scale = 0.035;
var spreadScale = 0.15;
var bombScale = 0.025;
var complexPatternScale = 0.1;

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
function invalidateMapCache() {
    mapDirty = true;
}
function discardMapCache() {
    mapCanvas = null;
    mapCtx = null;
    mapDirty = true;
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
    ctx.shadowColor = color;
    ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
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
    explosionIcon, moonIcon, scissorsIcon,
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


function loadPatterns() {
    //Abilities
    patterns[config.tileMap.abilities.blindfold.id] = makePattern(blindfoldIcon, makeSeamlessPattern(dirt));
    patterns[config.tileMap.abilities.swap.id] = makePattern(transferIcon, makeSeamlessPattern(dirt));
    patterns[config.tileMap.abilities.bomb.id] = makePattern(bombIcon, makeSeamlessPattern(dirt));
    patterns[config.tileMap.abilities.speedBuff.id] = makePattern(windIcon, makeSeamlessPattern(dirt));
    patterns[config.tileMap.abilities.speedDebuff.id] = makePattern(hourglassIcon, makeSeamlessPattern(dirt));
    patterns[config.tileMap.abilities.tileSwap.id] = makePattern(copyIcon, makeSeamlessPattern(dirt));
    patterns[config.tileMap.abilities.iceCannon.id] = makePattern(snowFlakeIcon, makeSeamlessPattern(dirt));
    patterns[config.tileMap.abilities.cut.id] = makePattern(scissorsIcon, makeSeamlessPattern(dirt));
    patterns[config.brutalRounds.infection.id] = makePattern(infectionIcon, "red");

    //Tiles
    if (infection == true) {
        patterns[config.tileMap.lava.id] = makeSeamlessPattern(poison);
    } else {
        patterns[config.tileMap.lava.id] = makeSeamlessPattern(lava);
    }
    patterns[config.tileMap.ice.id] = makeSeamlessPattern(ice);
    patterns[config.tileMap.fast.id] = makeSeamlessPattern(grass);
    patterns[config.tileMap.normal.id] = makeSeamlessPattern(dirt);
    patterns[config.tileMap.slow.id] = makeSeamlessPattern(sand);



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

function drawObjects(dt) {
    if (config == null) {
        return;
    }

    updateWorldCamera(dt);
    applyCanvasTransform();
    drawBackground(dt);
    if (currentState == config.stateMap.overview) {
        screenShake = false;
        drawOverviewBoard();
        return;
    }

    // ---- WORLD PASS: zoomed/panned by the dynamic camera (touch); identity
    // elsewhere. Everything positioned in world coords goes here. ----
    applyWorldTransform();
    preShake();
    drawWorld(dt);
    cameraOnMyPlayer();
    if (currentState == config.stateMap.lobby) {
        drawLobbyFloor();
        drawMap();
        drawLobbyArrows();
        drawLobbyStartButton();
    }
    if (currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing) {
        drawGate();
        drawMap();
        drawPingCircles();
    }
    if (currentState == config.stateMap.gated) {
        drawGateLine();
    }
    drawPlayers(dt);
    drawPunches();
    drawProjectiles();
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
    drawHUD();
    drawMouseDriveIndicator();

    if (currentState == config.stateMap.gameOver) {
        drawGameOverScreen();
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

// The fully-focused view: the DESIRED (unclamped) centre — the player, growing
// toward the nearest goal as it's approached — plus the focused zoom. The centre
// is kept separate from the zoom so a transition can ramp the zoom while always
// anchoring on the player (so the player can never slide out of frame).
function computeFocusedView() {
    var halfX = LOGICAL_WIDTH / (2 * WORLD_ZOOM_MAX);
    var halfY = LOGICAL_HEIGHT / (2 * WORLD_ZOOM_MAX);
    var minX = myPlayer.x - halfX, maxX = myPlayer.x + halfX;
    var minY = myPlayer.y - halfY, maxY = myPlayer.y + halfY;
    // Pull the nearest goal into frame as we get close to it -> the view zooms
    // back out to keep both the player and the goal visible.
    var goals = worldGoalPoints();
    var ng = null, nd = Infinity;
    for (var i = 0; i < goals.length; i++) {
        var dx = goals[i].x - myPlayer.x, dy = goals[i].y - myPlayer.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < nd) { nd = d; ng = goals[i]; }
    }
    if (ng && nd <= WORLD_ZOOM_ENGAGE) {
        minX = Math.min(minX, ng.x - WORLD_ZOOM_PAD);
        maxX = Math.max(maxX, ng.x + WORLD_ZOOM_PAD);
        minY = Math.min(minY, ng.y - WORLD_ZOOM_PAD);
        maxY = Math.max(maxY, ng.y + WORLD_ZOOM_PAD);
    }
    var boxW = Math.max(1, maxX - minX), boxH = Math.max(1, maxY - minY);
    var scale = Math.min(LOGICAL_WIDTH / boxW, LOGICAL_HEIGHT / boxH);
    scale = Math.max(1, Math.min(WORLD_ZOOM_MAX, scale)); // never zoom out past the whole map
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale: scale };
}

function computeWorldViewTarget(dt) {
    // Whole-map (identity) baseline — exactly today's view.
    var wholeMap = { cx: LOGICAL_WIDTH / 2, cy: LOGICAL_HEIGHT / 2, scale: 1 };
    if (!cameraZoomEnabled || myPlayer == null || typeof world === "undefined" || world == null) {
        worldViewFocusedElapsed = 0;
        return wholeMap;
    }
    // Local multiplayer: 2-4 players share one screen, so focusing on the
    // primary would crop the others out — keep the whole map in that case.
    if (typeof liveLocalPlayerCount === "function" && liveLocalPlayerCount() > 1) {
        worldViewFocusedElapsed = 0;
        return wholeMap;
    }
    // Focus on the player only once the round is live (gate countdown + race);
    // lobby / overview / game-over keep the whole map so the goal + player and
    // the arena are all visible at the start.
    var focused = (currentState === config.stateMap.gated ||
        currentState === config.stateMap.racing ||
        currentState === config.stateMap.collapsing);
    if (!focused) {
        worldViewFocusedElapsed = 0;
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
    return clampViewToWorld(focusedView.cx, focusedView.cy, focusedView.scale);
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

function drawBackground() {
    gameContext.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    overlayContext.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
}
function drawGameOverScreen() {
    if (playerWon == null) {
        return;
    }
    gameContext.save();
    gameContext.fillStyle = playerList[playerWon].color;
    gameContext.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    gameContext.fill();
    gameContext.restore();

    gameContext.save();
    gameContext.fillStyle = "black";
    gameContext.font = '48px serif';
    var winString = decodedColorName + " won the game.";
    gameContext.fillText(winString, LOGICAL_WIDTH / 2 - 400, (LOGICAL_HEIGHT + 48) / 2);
    gameContext.restore();

    if (achievements != null) {
        var xOffset = 200;
        var yOffset = -200;
        var startingHeight = (LOGICAL_HEIGHT + 48) / 2;
        gameContext.save();
        gameContext.fillStyle = "black";
        gameContext.font = '28px serif';
        gameContext.fillText("-- Medals -- ", (LOGICAL_WIDTH / 2) + xOffset, startingHeight + yOffset);


        var lineHeight = 40;
        var count = 1;
        for (var medal in achievements) {
            if (achievements[medal].ids.length == 0) {
                continue;
            }
            gameContext.fillStyle = "black";
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

}
function preShake() {
    if (currentState == config.stateMap.gameOver || currentState == config.stateMap.overview) {
        return;
    }
    if (screenShake == true) {
        gameContext.save();
        // This translate runs under the world transform; divide by the camera
        // zoom so the shake is a constant on-screen magnitude at any zoom level.
        var s = (worldView && worldView.scale) ? worldView.scale : 1;
        var dx = Math.random() * 15 / s;
        var dy = Math.random() * 15 / s;
        gameContext.translate(dx, dy);
    }
}
function postShake() {
    if (currentState == config.stateMap.gameOver || currentState == config.stateMap.overview) {
        return;
    }
    if (screenShake == true) {
        gameContext.restore();
    }
}

function drawPunches() {
    for (var id in punchList) {
        drawPunch(punchList[id]);
    }
}

function drawPunch(punch) {
    var punchSize = punch.radius;
    var player = playerList[punch.ownerId];
    if (player != null && player.infected == true) {
        punchSize = config.brutalRounds.infection.punchRadius;
    }
    gameContext.save();
    gameContext.beginPath();
    gameContext.fillStyle = punch.color;
    gameContext.arc(punch.x, punch.y, punchSize, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.restore();

    gameContext.save();
    gameContext.beginPath();
    gameContext.lineWidth = 1;
    gameContext.strokeStyle = "black";
    gameContext.arc(punch.x, punch.y, punchSize, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.restore();
}

function drawAbilties() {

    if (Object.keys(aimerList).length > 0) {
        for (var id in aimerList) {
            drawAimer(aimerList[id]);
        }
    }

    if (blindfold.color != null) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.fillStyle = blindfold.color;
        gameContext.rect(world.x, world.y, world.width, world.height);
        gameContext.fill();
        gameContext.restore();
    }
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
        for (var i = 0; i < living.length; i++) {
            var p = living[i];
            overlayContext.drawImage(sprite, p.x - sprite.width / 2, p.y - sprite.height / 2);
        }
        overlayContext.restore();
    }
}

function drawAimer(aimer) {
    if (aimer.startSwapCountDown && aimer.hide == false) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.arc(aimer.x, aimer.y, aimer.radius, 0, 2 * Math.PI);
        gameContext.setLineDash([15, 3, 3, 3]);
        if (aimer.swapCountDownPulse) {
            aimer.swapCountDownPulse = false;
            gameContext.lineWidth = 10;
            gameContext.strokeStyle = "red";
        } else {
            gameContext.lineWidth = 3;
            gameContext.strokeStyle = "black";
        }
        gameContext.stroke();
        gameContext.restore();
    }
    if (aimer.startExplosionCountDown && aimer.hide == false) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.arc(aimer.x, aimer.y, aimer.radius, 0, 2 * Math.PI);
        if (aimer.explosionPulse) {
            aimer.explosionPulse = false;
            gameContext.fillStyle = aimer.color;
            gameContext.fill();
        } else {
            gameContext.setLineDash([15, 3, 3, 3]);
            gameContext.lineWidth = 3;
            gameContext.strokeStyle = aimer.color;
            gameContext.stroke();
        }
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

function drawPlayers(dt) {
    for (var id in playerList) {
        var player = playerList[id];
        if (id == myID) {
            continue;
        }
        checkDrawPlayer(player, dt);
    }
    checkDrawPlayer(playerList[myID], dt);
}
function checkDrawPlayer(player, dt) {
    if (player == null) {
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
    if (player.onFire > 0) {
        drawFire(player);
    }

    var playerStrokeColor = "black";
    for (var aimerID in aimerList) {
        if (aimerList[aimerID].targetList.indexOf(player.id) != -1) {
            playerStrokeColor = "red"
        }
    }
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
        var nearestId = -1, nd = Infinity;
        for (var ci = 0; ci < currentMap.cells.length; ci++) {
            var cdx = player.x - currentMap.cells[ci].site.x;
            var cdy = player.y - currentMap.cells[ci].site.y;
            var cd = cdx * cdx + cdy * cdy;
            if (cd < nd) { nd = cd; nearestId = currentMap.cells[ci].id; }
        }
        onFireOnLava = (nearestId == config.tileMap.lava.id);
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
    gameContext.drawImage(
        sprite,
        player.x + camera.getCameraX() - sprite.halfSize,
        player.y + camera.getCameraY() - sprite.halfSize
    );
    if (immune) {
        gameContext.restore();
    }

    if (player.ability != null) {
        drawAbilityIndicator(player.x, player.y, player);
    }
    drawEmoji(player);
    if (player.awake == false) {
        gameContext.save();
        gameContext.drawImage(commentIconSolid, player.x, player.y - 40, commentIconSolid.width * 0.07, commentIconSolid.height * 0.07);
        gameContext.font = '20px Times New Roman';
        gameContext.fillText("😴", player.x + 8, player.y - 17);
        gameContext.restore();
    }
}


function drawEmoji(player) {
    if (player.chatMessage != null) {
        gameContext.save();
        gameContext.drawImage(commentIconSolid, player.x, player.y - 40, commentIconSolid.width * 0.07, commentIconSolid.height * 0.07);
        gameContext.font = '20px Times New Roman';
        gameContext.fillStyle = "white";
        gameContext.fillText(player.chatMessage, player.x + 8, player.y - 18);
        gameContext.restore();
    }
}

function drawDeathMessage(player) {
    if (player.deathMessage != null) {
        gameContext.save();
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
    switch (player.angle) {
        case 0: {
            gameContext.translate(player.x - 5, player.y);
            break;
        }
        case 45: {
            gameContext.translate(player.x - 5, player.y - 5);
            break;
        }
        case 90: {
            gameContext.translate(player.x, player.y - 5);
            break;
        }
        case 135: {
            gameContext.translate(player.x + 5, player.y - 5);
            break;
        }
        case 180: {
            gameContext.translate(player.x + 5, player.y);
            break;
        }
        case 225: {
            gameContext.translate(player.x + 5, player.y + 5);
            break;
        }
        case 270: {
            gameContext.translate(player.x, player.y + 5);
            break;
        }
        case 315: {
            gameContext.translate(player.x - 5, player.y + 5);
            break;
        }
    }

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



function drawProjectiles() {
    for (var proj in projectileList) {

        if (projectileList[proj].type == 'bomb') {
            projectileList[proj].rotation += 5;
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
            projectileList[proj].rotation += 5;
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
        case config.tileMap.abilities.bomb.id: {
            if (player.angle % 90 == 0) {
                drawBombAimer(x, y, player.angle);
                break;
            }
            if ((player.angle + 45) % 90 == 0) {
                drawBombAimer(x, y, player.angle);
                break;
            }
        }
        case config.tileMap.abilities.iceCannon.id: {
            if (player.angle % 90 == 0) {
                drawBombAimer(x, y, player.angle);
                break;
            }
            if ((player.angle + 45) % 90 == 0) {
                drawBombAimer(x, y, player.angle);
                break;
            }
        }
        case config.tileMap.abilities.cut.id: {
            if (player.angle % 90 == 0) {
                drawCutAimer(x, y, player.angle, player.color);
                break;
            }
            if ((player.angle + 45) % 90 == 0) {
                drawCutAimer(x, y, player.angle, player.color);
                break;
            }
        }
        case config.tileMap.abilities.swap.id: {
            gameContext.save();
            gameContext.beginPath();
            gameContext.setLineDash([15, 3, 3, 3]);
            gameContext.arc(x, y, 10, 0, 2 * Math.PI);
            gameContext.stroke();
            gameContext.restore();
        }
        case config.tileMap.abilities.bombTrigger.id: {
            gameContext.save();
            gameContext.beginPath();
            gameContext.lineWidth = 2;
            gameContext.setLineDash([7, 2, 2]);
            gameContext.arc(x, y, 10, 0, 2 * Math.PI);
            gameContext.stroke();
            gameContext.restore();
        }
        default: {
            gameContext.save();
            gameContext.beginPath();
            gameContext.setLineDash([2, 2]);
            gameContext.arc(x, y, 10, 0, 2 * Math.PI);
            gameContext.stroke();
            gameContext.restore();
        }
    }
}

function drawBombAimer(x, y, angle) {
    gameContext.save();
    gameContext.beginPath();
    gameContext.setLineDash([5, 5]);
    gameContext.moveTo(x, y);
    var point = pos({ x: x, y: y }, config.tileMap.abilities.bomb.aimerLength, angle);
    gameContext.lineTo(point.x, point.y);
    gameContext.stroke();
    gameContext.restore();
}
function drawCutAimer(x, y, angle, color) {
    gameContext.save();
    gameContext.beginPath();
    gameContext.setLineDash([15, 10, 12, 0, 0, 2]);
    gameContext.shadowColor = color;
    gameContext.shadowBlur = 10;
    gameContext.lineWidth = 1;
    gameContext.strokeStyle = "black";
    gameContext.moveTo(x, y);
    var pointFWD = pos({ x: x, y: y }, config.worldWidth, angle);
    gameContext.lineTo(pointFWD.x, pointFWD.y);

    gameContext.moveTo(x, y);
    var pointBWD = pos({ x: x, y: y }, config.worldWidth, angle - 180);
    gameContext.lineTo(pointBWD.x, pointBWD.y);

    gameContext.stroke();
    gameContext.restore();
}

function drawTrail(player) {
    if (player.trail.canvas != null) {
        gameContext.drawImage(player.trail.canvas, player.trail.canvasOriginX, player.trail.canvasOriginY);
    }
}

function drawWorld() {
    if (world != null) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.fillStyle = themeColor('surface', '#F0F0F0');
        gameContext.rect(world.x + camera.getCameraX(), world.y + camera.getCameraY(), world.width, world.height);
        gameContext.fill();
        gameContext.restore();

        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = 4;
        gameContext.strokeStyle = themeColor('ink', 'black');
        gameContext.rect(world.x + camera.getCameraX(), world.y + camera.getCameraY(), world.width, world.height);
        gameContext.stroke();
        gameContext.restore();
    }
}

function drawLobbyStartButton() {
    if (lobbyStartButton != null && camera.inBounds(lobbyStartButton)) {
        gameContext.save();
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
        gameContext.translate(lobbyStartButton.x + camera.getCameraX(), lobbyStartButton.y + camera.getCameraY());
        gameContext.rotate(lobbyStartButton.angle * (Math.PI / 180));
        gameContext.beginPath();
        gameContext.arc(0, 0, lobbyStartButton.radius, 0, 2 * Math.PI);
        gameContext.lineWidth = 5;
        gameContext.stroke();

        gameContext.beginPath();
        gameContext.arc(0, 0, lobbyStartButton.radius, 0, 2 * Math.PI);
        gameContext.clip();

        gameContext.moveTo(0, 0);
        for (i = 0; i < 360; i++) {
            var angle = 0.1 * i;
            var x = 0 + (4 + 2 * angle) * Math.cos(angle);
            var y = 0 + (4 + 2 * angle) * Math.sin(angle);
            gameContext.lineTo(x, y);
        }
        gameContext.lineWidth = 3;
        gameContext.strokeStyle = lobbyStartButton.color;
        gameContext.stroke();
        gameContext.restore();

    }
}
function drawGate() {
    if (gate != null) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = 5;
        gameContext.rect(gate.x, gate.y, gate.width, gate.height);
        if (brutalRound == false) {
            gameContext.fillStyle = "grey";
        } else {
            gameContext.fillStyle = brutalPatterns[brutalRoundConfig.brutalTypes.toString()];
        }
        if (currentState == config.stateMap.collapsing) {
            gameContext.fillStyle = patterns[config.tileMap.lava.id];
        }
        gameContext.fill();
        gameContext.restore();
    }
}

function drawGateLine() {
    if (gate != null) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.moveTo(gate.x + gate.width, gate.y);
        gameContext.lineTo(gate.x + gate.width, gate.y + gate.height);
        gameContext.lineWidth = 5;
        gameContext.strokeStyle = "red";
        gameContext.stroke();
        gameContext.restore();
    }
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
// Lobby-only "practice room" floor treatment: a faint grid + a dashed inset frame
// over the arena. Races never draw this, so a returning player instantly reads the
// lobby as a distinct practice space (not a glitched race map) — without any text.
// Drawn after drawWorld (the plain fill) and before the islands.
function drawLobbyFloor() {
    if (world == null) {
        return;
    }
    var ox = world.x + camera.getCameraX();
    var oy = world.y + camera.getCameraY();
    // Faint grid, clipped to the arena so it never spills past the border.
    gameContext.save();
    gameContext.beginPath();
    gameContext.rect(ox, oy, world.width, world.height);
    gameContext.clip();
    // Theme-aware faint lines: the theme's foreground "ink" (dark on the light theme,
    // light on dark) at low alpha, so the practice grid reads on both themes.
    gameContext.globalAlpha = 0.07;
    gameContext.strokeStyle = themeColor('ink', 'black');
    gameContext.lineWidth = 1;
    var step = 64;
    gameContext.beginPath();
    for (var gx = step; gx < world.width; gx += step) {
        gameContext.moveTo(ox + gx, oy);
        gameContext.lineTo(ox + gx, oy + world.height);
    }
    for (var gy = step; gy < world.height; gy += step) {
        gameContext.moveTo(ox, oy + gy);
        gameContext.lineTo(ox + world.width, oy + gy);
    }
    gameContext.stroke();
    gameContext.restore();
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
function drawLobbyArrows() {
    if (lobbyStartButton == null || world == null) {
        return;
    }
    var cx = lobbyStartButton.x + camera.getCameraX();
    var cy = lobbyStartButton.y + camera.getCameraY();
    var btnR = lobbyStartButton.radius || 70;
    var count = 4;
    var t = Date.now() / 1000;
    gameContext.save();
    gameContext.globalAlpha = 0.5;                       // translucent: float over the map, don't hide it
    for (var i = 0; i < count; i++) {
        var ang = (i / count) * Math.PI * 2 + Math.PI / 4; // +45deg -> 4 corner (diagonal) positions
        var bob = Math.sin(t * 2.5 - i * 0.9) * 7;      // gentle staggered float toward/away from center
        var ringR = btnR + 50 + bob;                    // arrow tip distance from button center
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
        gameContext.drawImage(mapCanvas, world.x - mapCanvasPad, world.y - mapCanvasPad);
    }
    if (Object.keys(hazardList).length > 0) {
        for (var id in hazardList) {
            drawHazard(hazardList[id]);
        }
    }
}

function renderMapToCache() {
    if (world == null) {
        return;
    }
    if (mapCanvas == null) {
        mapCanvas = document.createElement("canvas");
        mapCanvas.width = world.width + mapCanvasPad * 2;
        mapCanvas.height = world.height + mapCanvasPad * 2;
        mapCtx = mapCanvas.getContext("2d");
    } else {
        mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    }
    mapCtx.save();
    mapCtx.translate(-world.x + mapCanvasPad, -world.y + mapCanvasPad);

    var cells = currentMap.cells;
    var iCell = cells.length;
    while (iCell--) {
        mapCtx.beginPath();
        var cell = cells[iCell];
        // Transparent "background" cells render nothing, so the plain lobby shows
        // through and only the curated islands are visible.
        if (cell.id == config.tileMap.background.id) {
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
            color = patterns[cell.id];
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
    }
    mapCtx.restore();
}
function drawHazard(hazard) {
    if (hazard.id == config.hazards.bumper.id) {
        drawBumper(hazard.x, hazard.y);
    }
    if (hazard.id == config.hazards.movingBumper.id) {
        drawMovingBumper(hazard.x, hazard.y, hazard.railX, hazard.railY, hazard.angle);
    }
}

function drawBumper(x, y) {
    gameContext.save();
    gameContext.beginPath();
    gameContext.strokeStyle = "red";
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
    gameContext.strokeStyle = "red";
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
    drawVirtualButtons();
    drawTouchControls();
    drawTitle();
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

function drawTouchControls() {
    if (isTouchScreen == false) {
        return;
    }

    var exitToUse = exitIcon;
    var fullScreenToUse = fullscreenIcon;
    var chatToUse = commentIconSolid;

    if (currentState == config.stateMap.overview) {
        exitToUse = exitIconWhite;
        fullScreenToUse = fullscreenIconWhite;
        chatToUse = commentIconWhite;
    }


    if (joystickMovement != null && joystickMovement.isVisible()) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = 3;
        gameContext.strokeStyle = themeColor('ink', 'black');
        gameContext.arc(joystickMovement.baseX, joystickMovement.baseY, joystickMovement.baseRadius, 0, Math.PI * 2, false);
        gameContext.stroke();
        gameContext.beginPath();
        gameContext.arc(joystickMovement.baseX, joystickMovement.baseY, joystickMovement.stickRadius, 0, Math.PI * 2, false);
        gameContext.stroke();


        gameContext.beginPath();
        gameContext.arc(joystickMovement.stickX, joystickMovement.stickY, joystickMovement.stickRadius, 0, Math.PI * 2, true);
        gameContext.fillStyle = "rgba(255, 0, 0, 0.2)";
        gameContext.fill();
        gameContext.stroke();
        gameContext.restore();
        drawTouchLabel("Move", joystickMovement.baseX, joystickMovement.baseY + joystickMovement.baseRadius + 20);
    }
    if (joystickCamera != null && joystickCamera.isVisible()) {
        gameContext.save();

        gameContext.beginPath();
        gameContext.lineWidth = 3;
        gameContext.strokeStyle = themeColor('ink', 'black');
        gameContext.arc(joystickCamera.baseX, joystickCamera.baseY, joystickCamera.baseRadius, 0, Math.PI * 2, false);
        gameContext.stroke();
        gameContext.beginPath();
        gameContext.arc(joystickCamera.baseX, joystickCamera.baseY, joystickCamera.stickRadius, 0, Math.PI * 2, false);
        gameContext.stroke();

        gameContext.beginPath();
        gameContext.fillStyle = "rgba(0, 255, 0, 0.2)";
        gameContext.arc(joystickCamera.stickX, joystickCamera.stickY, joystickCamera.stickRadius, 0, Math.PI * 2, true);
        gameContext.fill();
        gameContext.stroke();
        gameContext.restore();
    }
    if (attackButton != null && attackButton.isVisible()) {
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = 1;
        gameContext.strokeStyle = themeColor('ink', 'black');
        gameContext.fillStyle = "rgba(0, 0, 255, 0.2)";

        //gameContext.rect(attackButton.baseX, attackButton.baseY, attackButton.width, attackButton.height);
        gameContext.arc(attackButton.baseX, attackButton.baseY, attackButton.radius, 0, Math.PI * 2, true);
        gameContext.fill();
        gameContext.stroke();
        gameContext.restore();
        drawTouchLabel("Attack", attackButton.baseX, attackButton.baseY + attackButton.radius + 20);
    }
    if (exitButton != null && exitButton.isVisible() && fullscreenSupported()) {
        var exitSize = exitButton.iconSize || 34;
        if (window.document.fullscreenElement) {
            gameContext.save();
            gameContext.drawImage(exitToUse, exitButton.baseX - exitSize / 2, exitButton.baseY - exitSize / 2, exitSize, exitSize);
            gameContext.restore();
        } else {
            gameContext.save();
            gameContext.drawImage(fullScreenToUse, exitButton.baseX - exitSize / 2, exitButton.baseY - exitSize / 2, exitSize, exitSize);
            gameContext.restore();
        }
        drawTouchLabel(window.document.fullscreenElement ? "Exit" : "Fullscreen", exitButton.baseX, exitButton.baseY + exitSize / 2 + 16);
    }
    if (chatButton != null && chatButton.isVisible()) {
        var chatSize = chatButton.iconSize || 34;
        gameContext.save();
        gameContext.drawImage(chatToUse, chatButton.baseX - chatSize / 2, chatButton.baseY - chatSize / 2, chatSize, chatSize);
        gameContext.restore();
        drawTouchLabel("Emoji", chatButton.baseX, chatButton.baseY + chatSize / 2 + 16);
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
    gameContext.strokeStyle = "white";
    gameContext.fillStyle = "#c87f8a";
    var label = "Mouse-drive ON — double-click to toggle";
    gameContext.strokeText(label, LOGICAL_WIDTH / 2, 44);
    gameContext.fillText(label, LOGICAL_WIDTH / 2, 44);
    gameContext.restore();
}

// Small caption under a touch control so mobile players know what it does.
function drawTouchLabel(text, x, y) {
    gameContext.save();
    // The 1366x768 logical space is scaled down a lot on a phone, so a fixed
    // 16px label would render only a few CSS px tall. Size up as the fit ratio
    // shrinks to hold a roughly constant physical size (~15 CSS px), clamped so
    // it never goes below the original 16px or balloons on large displays.
    var fontPx = Math.round(Math.max(16, Math.min(40, 15 / (fitRatio || 1))));
    gameContext.font = "bold " + fontPx + "px Arial";
    gameContext.textAlign = "center";
    gameContext.lineWidth = 4;
    gameContext.strokeStyle = "white";
    gameContext.fillStyle = "black";
    gameContext.strokeText(text, x, y);
    gameContext.fillText(text, x, y);
    gameContext.restore();
}

function drawTitle() {

    if (brutalRound == true) {
        if (brutalRoundConfig.drawTitleAlpha == null) {
            brutalRoundConfig.drawTitleAlpha = 1.0;
        }
        if (brutalRoundConfig.drawTitleAlpha < 0) {
            return;
        }
        gameContext.save();
        gameContext.strokeStyle = "rgba(255, 255, 255, " + brutalRoundConfig.drawTitleAlpha + ")";;
        gameContext.lineWidth = 10;
        gameContext.fillStyle = "rgba(255, 0, 0, " + brutalRoundConfig.drawTitleAlpha + ")";
        gameContext.font = "50px Arial";
        gameContext.strokeText('Brutal Round', (LOGICAL_WIDTH / 2) - 120, (LOGICAL_HEIGHT / 2) - 25);
        gameContext.fillText('Brutal Round', (LOGICAL_WIDTH / 2) - 120, (LOGICAL_HEIGHT / 2) - 25);
        var titles = [];
        for (var i = 0; i < brutalRoundConfig.brutalTypes.length; i++) {
            for (var prop in config.brutalRounds) {
                if (config.brutalRounds[prop].id == brutalRoundConfig.brutalTypes[i]) {
                    titles.push(config.brutalRounds[prop].title);
                }
            }
        }
        gameContext.font = "30px Arial";
        for (var j = 0; j < titles.length; j++) {
            gameContext.strokeText(titles[j], (LOGICAL_WIDTH / 2) - 120, (LOGICAL_HEIGHT / 2) + 15 + (35 * j));
            gameContext.fillText(titles[j], (LOGICAL_WIDTH / 2) - 120, (LOGICAL_HEIGHT / 2) + 15 + (35 * j));
        }
        gameContext.restore();
        brutalRoundConfig.drawTitleAlpha -= .0025;
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
    drawHUD();
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
    gameContext.arc(notchX, 0, config.playerBaseRadius * 2, 0, 2 * Math.PI);

    gameContext.save();
    gameContext.beginPath();
    gameContext.lineWidth = 5;
    gameContext.strokeStyle = "black";
    gameContext.arc(notchX, 0, config.playerBaseRadius * 2, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.restore();

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
    gameContext.fillStyle = player.color;
    gameContext.fill();
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



