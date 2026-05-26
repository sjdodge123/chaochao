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
        drawLobbyFloor();
        drawMap();
        drawLobbyArrows();
        drawLobbyStartButton();
        if (typeof drawLobbyStationZones === "function") {
            drawLobbyStationZones();
        }
    }
    if (currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing) {
        drawGate();
        drawMap();
        drawArenaVignette();
        drawPendingSwap();
        drawPingCircles();
        drawCollapseShockwaves();
    }
    if (currentState == config.stateMap.gated) {
        drawGateLine();
    }
    drawPlayers(dt);
    drawProjectiles(dt);
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
    gameContext.shadowBlur = 12 + 12 * pulse;
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
        // Nobody local alive to follow -> whole map (watch the action).
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
    if (ng && nd <= WORLD_ZOOM_ENGAGE) {
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
        return wholeMap;
    }
    // Focus once the round is live (gate countdown + race);
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

function drawBackground() {
    gameContext.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    overlayContext.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
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

    gameContext.save();
    gameContext.fillStyle = "black";
    gameContext.font = '48px serif';
    var winString = decodedColorName + " won the game.";
    // When a recap montage is showing, lift the header so the header + clip
    // block is vertically centred (recap.js owns the shared layout). No recap
    // (or recap.js absent) -> the usual vertical-centre baseline.
    var goHeaderY = (typeof recapHeaderBaseline === "function") ? recapHeaderBaseline() : (LOGICAL_HEIGHT + 48) / 2;
    gameContext.fillText(winString, LOGICAL_WIDTH / 2 - 400, goHeaderY);
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
// ~100ms). The original three-part look — a quick impact pop, an expanding
// shockwave ring, and a directional sweep — but scaled down so nothing exceeds
// ~1.8x the real punch radius (the first cut sprawled to ~3x). The pop + ring
// are radial and always shown; the sweep is added only for directional punches
// (radial punches — hockey, survivors swatting zombies, bumpers — skip it).
function spawnPunchEffect(punch) {
    if (punch == null) {
        return;
    }
    var owner = playerList[punch.ownerId];
    var infected = owner != null && owner.infected === true;
    var baseRadius = infected ? config.brutalRounds.infection.punchRadius : punch.radius;
    var color = infected ? "#7CFC00" : punch.color;
    // Derive the swing direction from where the server actually placed the
    // punch hitbox (offset punchReach in front of the player at throw time),
    // not the owner's live angle — a player who keeps turning would otherwise
    // make the sweep point away from where the hit really landed.
    var angleDeg = null;
    if (punch.directional && owner != null) {
        var ddx = punch.x - owner.x;
        var ddy = punch.y - owner.y;
        angleDeg = (ddx * ddx + ddy * ddy > 0.0001) ? Math.atan2(ddy, ddx) * 180 / Math.PI : owner.angle;
    }
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
            // Expanding shockwave ring (tops ~1.6x — was 2.5x).
            ctx.globalAlpha = (1 - t);
            ctx.lineWidth = 2 * (1 - t) + 1;
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.arc(px, py, baseRadius * (0.8 + 0.8 * grow), 0, 2 * Math.PI);
            ctx.stroke();
            // Directional sweep — a crescent that thrusts out in the facing
            // direction and narrows as it fades (tops ~1.8x — was 3.1x; thinner).
            if (angleDeg != null && t < 0.6) {
                var st = clamp01(t / 0.6);
                var center = angleDeg * Math.PI / 180;
                var half = 0.95 * (1 - st * 0.4);
                var reach = baseRadius * (1.1 + 0.7 * st);
                ctx.globalAlpha = (1 - st) * 0.85;
                ctx.lineWidth = baseRadius * 0.45 * (1 - st) + 1.5;
                ctx.beginPath();
                ctx.arc(px, py, reach, center - half, center + half);
                ctx.stroke();
            }
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
            ctx.shadowBlur = 12 * (1 - t);
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
            // Debris sparks.
            ctx.fillStyle = color;
            for (var i = 0; i < 10; i++) {
                var a = (i / 10) * Math.PI * 2 + 0.2;
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

function drawPlayers(dt) {
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
    if (player.onFire > 0) {
        drawFire(player);
    }
    drawSpeedFx(player);
    // Draw a halo behind your own kart(s) — the primary plus every couch co-op
    // slot — so you can always find yourself in a crowded pack.
    if (isLocalId(player.id)) {
        drawLocalPlayerHighlight(player);
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
    // Fade other players' kart bodies during the race so yours pops. Never dims
    // a flashing (immune) kart — that flash carries its own alpha — and never
    // your own. Threat FX drawn elsewhere (fire/ability rings) stay full.
    var dimKart = !isLocalId(player.id) && !immune &&
        (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing);
    if (dimKart) {
        gameContext.save();
        gameContext.globalAlpha = NONLOCAL_KART_ALPHA;
    }
    // try/finally so a thrown drawImage (e.g. an undecoded sprite -> InvalidStateError)
    // can't skip the restore() and leak the dimmed/flash alpha onto the rest of the frame.
    try {
        gameContext.drawImage(
            sprite,
            player.x + camera.getCameraX() - sprite.halfSize,
            player.y + camera.getCameraY() - sprite.halfSize
        );
    } finally {
        if (dimKart) {
            gameContext.restore();
        }
        if (immune) {
            gameContext.restore();
        }
    }

    // Opt-in avatar skin: the player's picture, shrunk inside a distinct border,
    // overlaid on the kart so it reads as an external (not earned) skin.
    drawAvatarSkin(player, sprite);

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
        var rp = (now / 700) % 1;
        gameContext.save();
        gameContext.globalAlpha = (1 - rp) * 0.4;
        gameContext.strokeStyle = "rgba(80,80,160,1)";
        gameContext.lineWidth = 2;
        gameContext.beginPath();
        gameContext.arc(player.x, player.y, player.radius + 2 + rp * 12, 0, 2 * Math.PI);
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
// Discord/Google picture on their kart for everyone. It's drawn SHRUNK inside a
// distinct gold border so it's visually obvious the skin is external — not an
// earned/purchased in-game skin (prevents using an avatar to fake a real skin).
// Images load async and are cached per URL; until one is ready (or if it fails
// CORS/404) the kart just shows its base colour.
var AVATAR_BORDER_COLOR = "#f4c542";
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
    var cx = player.x + camera.getCameraX();
    var cy = player.y + camera.getCameraY();
    // Shrink the picture well within the kart so the border frame stays visible.
    var r = (sprite && sprite.halfSize ? sprite.halfSize : 20) * 0.62;
    gameContext.save();
    gameContext.beginPath();                       // border frame (the "not earned" marker)
    gameContext.arc(cx, cy, r + 2.5, 0, 2 * Math.PI);
    gameContext.fillStyle = AVATAR_BORDER_COLOR;
    gameContext.fill();
    gameContext.beginPath();                       // clip to a circle and draw the avatar inside
    gameContext.arc(cx, cy, r, 0, 2 * Math.PI);
    gameContext.closePath();
    gameContext.clip();
    gameContext.drawImage(entry.img, cx - r, cy - r, r * 2, r * 2);
    gameContext.restore();
    gameContext.save();                            // thin inner outline for definition
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
    // Use the same raw-coord convention as the emote/chat bubble (drawEmoji) so the
    // name and the bubble stay attached to each other. camera.getCameraX/Y is 0 in
    // the default desktop view, so this also aligns with the kart there.
    var x = player.x;
    var y = player.y + player.radius + 12;
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
    gameContext.shadowBlur = 12;
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

function drawTrail(player) {
    if (player.trail.canvas != null) {
        // Fade other players' trails so your own line stays legible in the pack.
        var dim = !isLocalId(player.id);
        if (dim) {
            gameContext.save();
            gameContext.globalAlpha = NONLOCAL_TRAIL_ALPHA;
        }
        gameContext.drawImage(player.trail.canvas, player.trail.canvasOriginX, player.trail.canvasOriginY);
        if (dim) {
            gameContext.restore();
        }
    }
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
    if (gates == null || gates.length == 0) {
        return;
    }
    gameContext.save();
    gameContext.lineWidth = 5;
    if (brutalRound == false) {
        gameContext.fillStyle = "grey";
    } else {
        gameContext.fillStyle = brutalPatterns[brutalRoundConfig.brutalTypes.toString()];
    }
    if (currentState == config.stateMap.collapsing) {
        gameContext.fillStyle = patterns[config.tileMap.lava.id];
    }
    for (var i = 0; i < gates.length; i++) {
        var g = gates[i];
        gameContext.beginPath();
        gameContext.rect(g.x, g.y, g.width, g.height);
        gameContext.fill();
    }
    gameContext.restore();
}

function drawGateLine() {
    if (gates == null || gates.length == 0) {
        return;
    }
    gameContext.save();
    gameContext.lineWidth = 5;
    gameContext.strokeStyle = "red";
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
        gameContext.drawImage(mapCanvas, world.x - mapCanvasPad, world.y - mapCanvasPad);
    }
    if (Object.keys(hazardList).length > 0) {
        for (var id in hazardList) {
            drawHazard(hazardList[id]);
        }
    }
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

// Tile-swap telegraph flicker tuning. The per-frame chance of a gentle dim
// ramps from BASE to BASE+RAMP as the swap nears, and a dim frame multiplies
// brightness by DIM (closer to 1.0 = calmer). Kept deliberately low so the
// warn-up reads as a calm electric glow rather than a harsh strobe.
var SWAP_FLICKER_BASE = 0.01;   // base per-frame dim chance (was 0.03)
var SWAP_FLICKER_RAMP = 0.03;   // extra chance at full progress (was 0.07)
var SWAP_FLICKER_DIM = 0.8;     // brightness on a dim frame (was 0.6)

// Overlay drawn on top of the cached map: the tiles a tileSwap is about to flip
// pulse (a global sine that speeds up as the swap nears) with a brief random
// flicker per cell, plus a brightening yellow edge. Cleared as tiles flip (see
// changeTilesBulk) and self-expires if the swap never lands.
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
        var pulse = 0.5 + 0.5 * Math.sin((now / 1000) * (2 + 3 * prog) * Math.PI * 2);
        // Occasional, gentle dim frames (rarer and shallower than a hard strobe)
        // so the warn-up reads as a calm electric glow, not an intense flicker.
        var flicker = Math.random() < (SWAP_FLICKER_BASE + SWAP_FLICKER_RAMP * prog) ? SWAP_FLICKER_DIM : 1.0;
        var alpha = (0.15 + 0.32 * pulse) * flicker;
        if (!traceCellPath(gameContext, cell)) {
            continue;
        }
        gameContext.globalAlpha = alpha;
        gameContext.fillStyle = "#ffffff";
        gameContext.fill();
        gameContext.lineWidth = 2 + 3 * prog;
        gameContext.strokeStyle = "#ffff66";
        gameContext.stroke();
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
    drawTileBorders(mapCtx);
    drawLavaBorders(mapCtx);
    mapCtx.restore();
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
    var idByVoronoi = {};
    for (var i = 0; i < cells.length; i++) {
        idByVoronoi[cells[i].site.voronoiId] = cells[i].id;
    }
    ctx.save();
    ctx.beginPath();
    for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        if (cell.id == bgId || cell.id == lavaId) {
            continue; // background draws nothing; lava has its own rim
        }
        var halfedges = cell.halfedges;
        for (var h = 0; h < halfedges.length; h++) {
            var he = halfedges[h];
            var neighbor = compareSite(he.edge.lSite, he.site) ? he.edge.rSite : he.edge.lSite;
            var nid = neighbor != null ? idByVoronoi[neighbor.voronoiId] : null;
            if (nid === cell.id || nid === lavaId) {
                continue; // same-type internal seam, or lava's edge — skip
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
    // Theme-aware halo so the pink label reads on the dark board too.
    gameContext.strokeStyle = themeColor('inkOutline', 'white');
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
    // Theme-aware so the captions read correctly on the dark board too (matches
    // the rest of the renderer + the adjacent touch-control rings).
    gameContext.strokeStyle = themeColor('inkOutline', 'white');
    gameContext.fillStyle = themeColor('ink', 'black');
    gameContext.strokeText(text, x, y);
    gameContext.fillText(text, x, y);
    gameContext.restore();
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
                gameContext.strokeText(titles[j], 0, 40 + (35 * j));
                gameContext.fillText(titles[j], 0, 40 + (35 * j));
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
        drawNotchDeltaFloat(playerList[player]);
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

// Small rising/fading "+2"/"+1"/"−1" above a player's notch icon on the standings
// board, showing how their score changed this round. Drawn in the same translated
// row space as drawPlayerIcon (so player.x is the icon's current track position),
// after the icon/emoji so it sits on top. Driven off notchFloatStart, set on
// overview entry; once the window elapses nothing draws, so a resize/redraw of the
// board won't replay it and it resets cleanly each round.
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



