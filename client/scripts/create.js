var server,
    maps = [],
    editorMapMeta = {},      // map id -> classifier summary (tier/trait/score/playlists)
    editorPlaylists = [],    // [{id,name,desc,count}] for the filter chips
    createCanvas,
    gameRunning = false,
    voronoi = new Voronoi(),
    vMap,
    brushing = false,
    drawBrushAimer = true,
    drawObject = null,
    selectedObject = null,
    mapReady = false,
    mousex = 0,
    mousey = 0,
    lastCell,
    brushID,
    config,
    brushColor = "black",
    patterns = {},
    currentCell = null,
    previewPending = false,
    newWidth = 0,
    newHeight = 0,
    world = { x: 0, y: 0, width: 1366, height: 768 },
    startEdges = ["left"],
    gates = [],
    map = { x: 75, y: 0, width: world.width, height: world.height },
    canvasWindow = document.getElementById("canvasWindow"),
    createContext;

// Unified tool model. Every input method (mouse, touch, keyboard, gamepad) sets
// `activeTool` through setTool(); the legacy render flags (drawBrushAimer/
// drawObject/brushID/brushColor) are *derived* from it so the existing draw + paint
// paths are unchanged. kind: 'select' | 'eraser' | 'tile' | 'hazard'.
var activeTool = { kind: "select" };
// Right-button erase-to-default stroke, kept distinct from a left-button paint.
var erasing = false;
// On-canvas hazard rotate handle: while dragging it the selected hazard's angle
// tracks the cursor; rotateStartAngle keeps the pre-drag value to record one undo
// command on release. touchActive guards the window-level touch move/end handlers.
var rotatingHandle = false;
var rotateStartAngle = 0;
var touchActive = false;
var touchId = null; // identifier of the finger currently driving a touch stroke
// Accumulates the cell changes of the in-progress paint/erase stroke so the whole
// stroke collapses to one undo step (beginStroke/recordCellChange/commitStroke).
var strokeChanges = null;
// Graded terrain textures (keyed by tile type), cached at loadPatterns() so the
// tile palette swatches can show the real painted texture, not a flat colour.
var gradedTex = {};
// True once the user has made an undoable edit (or a reshape) since the current
// map was loaded/created/restored. Used to warn before loading a *different* map
// (which would discard the in-progress work). Reset by load/rebuild.
var mapModified = false;

// True between clicking "Test Fairness" and the mapScore reply — routes that
// reply to the overlay + a score toast instead of the submit flow.
var fairnessCheckPending = false;
// Most recent non-error mapScore reply ({ payload, at, sig }). `sig` is the
// serialized map the verdict was computed for, so an Upload only reuses it when
// the map hasn't changed — never a stale verdict for different geometry. Lets an
// Upload inside the server's per-socket throttle window reuse the verdict the
// author is already looking at instead of racing a doomed second request.
var lastMapScoreVerdict = null;
// Serialized map of the in-flight scoreMap request (so its reply can be matched
// back to the geometry it scored) and the emit timestamp (so the submit flow can
// stay clear of the server's 2s per-socket throttle).
var pendingScoreSig = null;
var lastScoreEmitAt = 0;

// Preview start-gate pick: "auto" (balanced placement, the old behaviour) or an
// edge name from the map's startEdges. On multi-gate maps the author chooses
// which gate THEY spawn at in preview; bots still fill both sides. Persisted
// like the AI toggle; the button only shows when the map has 2 gates.
var previewStartEdge = "auto";

// Balance-check overlay: set from the mapScore reply when the verdict is "won't
// make Featured" so the author can SEE the problem (per-start-edge routes with
// par times, goal centroid, and a legend explaining each deduction) instead of
// guessing from the score line alone. Stays up while they fix the map; cleared
// by clearBalanceOverlay() on re-check/submit/load/rebuild/reshape/Escape.
var balanceOverlay = null;

// Coarse uniform-grid spatial index over the Voronoi cells, keyed by each cell's
// site x/y, so cellIdFromPoint() tests only the cells in the nearby bucket(s)
// instead of all ~250 cells on every mousemove. Rebuilt lazily (and invalidated
// via invalidateCellIndex() wherever vMap/cells are reassigned). The exact
// point-in-polygon test (pointIntersection) stays the final arbiter, so results
// are identical to a full scan.
var cellIndex = null;

var scale = 0.035;
// Gate strip depth (px), matching server/game.js GATE_DEPTH so the previewed gate
// lines up with where the server actually holds players.
var GATE_DEPTH = 75;

// Tile textures. Attach load + error BEFORE setting src so cached images
// still fire and a missing/broken asset can't hang the gate forever.
// Pass explicit width/height: PNGs are OK from intrinsic size, but the
// SVG icons (question-solid, bomb) have only viewBox — Firefox returns
// width=0 for those without an attribute, which makes makePattern()
// render a 3px transparent canvas for the random/ability tiles.
// loadPatterns() is gated on all images being ready AND the config
// socket message arriving — see tryStart().
var imagesPending = 0,
    imagesLoaded = 0;
function loadTileImage(src, width, height, scale) {
    var img = new Image(width, height);
    if (scale != null) img.scale = scale;
    imagesPending++;
    img.addEventListener('load', onTileImageSettled, { once: true });
    img.addEventListener('error', onTileImageSettled, { once: true });
    img.src = src;
    return img;
}
function onTileImageSettled() {
    imagesLoaded++;
    tryStart();
}
var lava = loadTileImage("../assets/img/lava.png", 256, 256);
var grass = loadTileImage("../assets/img/grass.png", 256, 256, 0.5);
var dirt = loadTileImage("../assets/img/dirt.png", 256, 256, 0.25);
var ice = loadTileImage("../assets/img/ice.png", 256, 256, 0.75);
var sand = loadTileImage("../assets/img/sand.png", 256, 256, 0.25);
var random = loadTileImage("../assets/img/question-solid.svg", 576, 512);
var bombIcon = loadTileImage("../assets/img/bomb.svg", 576, 512);

// Redraw gate. Set dirty=true from anything that mutates rendered state
// (mouse moved, click, paint, hazard added/removed/rotated, resize, rebuild);
// the animloop skips drawEditor when not dirty so an idle editor doesn't
// re-render 250 voronoi cells at 60fps.
var dirty = true;

var then = Date.now(),
    dt;

window.onload = function () {
    server = clientConnect();
    server.emit("getMaps");
    server.emit("getConfig");
    setupPage();

    // Returning from a play-test? Rehydrate the in-progress map and drop the
    // creator straight back into the editor, mirroring the "load a saved map"
    // path. removeItem so a later manual reload doesn't re-restore. mapReady is
    // forced true so animloop's first-frame rebuild() can't wipe the restored
    // map (the wipe only matters before the editor is first shown).
    var saved = sessionStorage.getItem('previewMap');
    var restored = null;
    if (saved != null) {
        sessionStorage.removeItem('previewMap');
        try {
            restored = JSON.parse(saved);
        } catch (e) {
            restored = null;
        }
    }
    if (restored != null) {
        vMap = restored;
        invalidateCellIndex();
        syncStartEdgesFromMap();
        $('#author').val(vMap.author);
        $('#name').val(vMap.name);
        mapReady = true;
        mapModified = true; // returning from preview = unsaved work to protect
        showEditor();
    } else {
        rebuild();
        showLoadWindow();
    }
}

// Visibility is toggled by class (not jQuery show/hide) so the load grid keeps its
// CSS `display:grid` and the editor keeps its `display:grid` instead of jQuery
// forcing them back to `block`.
function showLoadWindow() {
    document.getElementById('loadWindow').classList.remove('editor-hidden');
    document.getElementById('createWindow').classList.add('editor-hidden');
    document.body.classList.remove('editor-open');
    updateContinueTile();
    // (Re)generate load-list thumbnails now that the window is open — by here
    // config + textured patterns are loaded, so any card whose thumbnail was
    // rendered blank/flat earlier (map fetched before config/patterns) upgrades
    // to the textured version. renderMapThumbnail caches, so this is cheap.
    for (var i = 0; i < maps.length; i++) {
        var m = maps[i];
        if (m == null || m.id == null) { continue; }
        var btn = document.getElementById(m.id);
        var img = btn ? btn.querySelector('img') : null;
        if (img == null) { continue; }
        var url = renderMapThumbnail(m);
        if (url) { img.src = url; }
    }
}

function showEditor() {
    document.getElementById('loadWindow').classList.add('editor-hidden');
    document.getElementById('createWindow').classList.remove('editor-hidden');
    document.body.classList.add('editor-open');
    closeDetailsPanel();
    var rail = document.getElementById('toolRail');
    if (rail != null) rail.scrollTop = 0;
    resize();
    addListeners();
}

// The pinned map-list tile doubles as "your work in progress" once a map has any
// author work, so label it accordingly (non-destructive: clicking it re-enters the
// in-memory map; only the wipe button clears it).
function updateContinueTile() {
    var desc = document.querySelector('#createNew .desc');
    if (desc == null) { return; }
    desc.textContent = mapHasContent() ? "Continue editing" : "Create a new map";
}

function openDetailsPanel() { var p = document.getElementById("detailsPanel"); if (p) { p.classList.add("open"); } }
function closeDetailsPanel() { var p = document.getElementById("detailsPanel"); if (p) { p.classList.remove("open"); } }
function toggleDetailsPanel() { var p = document.getElementById("detailsPanel"); if (p) { p.classList.toggle("open"); } }

// Load a saved map into the editor (replacing the in-memory map). Starts a fresh
// undo history and clears the modified flag — the caller confirms first if there
// were unsaved edits to discard.
function loadMapById(id) {
    for (var j = 0; j < maps.length; j++) {
        if (maps[j].id == id) {
            vMap = JSON.parse(JSON.stringify(maps[j]));
            invalidateCellIndex();
            syncStartEdgesFromMap();
            $('#author').val(vMap.author);
            $('#name').val(vMap.name);
            setSelectedObject(null);
            clearHistory();
            clearBalanceOverlay(); // the verdict belonged to the previous map
            mapModified = false;
            showEditor();
            return;
        }
    }
}

function clientConnect() {
    var server = io();

    server.on("config", function (c) {
        config = c;
        buildHazardById();
        buildHazardButtons();
        tryStart();
    });

    server.on('githubFailure', function (error) {
        console.log(error);
        // The server sends a player-friendly reason: an actionable message
        // ("Add a goal tile…", "Map name can't contain…") or a sanitized generic
        // for unexpected errors — the raw exception is logged server-side, not
        // sent here. Show it as-is (self-contained + red styling reads as a
        // failure); fall back to a generic if the server sent nothing usable.
        var reason = (typeof error === "string" && error.trim() !== "") ? error.trim()
            : "Couldn't upload your map. Please try again.";
        showSubmitStatus(reason, "red", "white", 9000);
    });
    server.on('githubSuccess', function (url) {
        console.log(url);
        showSubmitStatus("Uploaded! Thanks 🎉", "green", "white");
        trackEvent('map_submitted');
    });

    server.on('previewRoomCreated', function (payload) {
        // sessionStorage.previewMap was stashed before emitting; navigate the
        // same tab into the play page, which injects that map and starts a
        // solo session. preview=1 flags the play page to reroute back here.
        window.location = 'play.html?gameid=' + payload.gameID + '&preview=1';
    });
    server.on('previewRejected', function (payload) {
        previewPending = false;
        $("#previewButton").prop("disabled", false);
        showPreviewError(payload && payload.reason ? payload.reason : "Map could not be previewed.");
    });

    // Classifier meta + playlist summary for the browser (arrives before maplisting,
    // see messenger getMaps). Drives the per-card quality badge and the filter chips.
    server.on("editorMapMeta", function (payload) {
        if (payload != null) {
            editorMapMeta = payload.meta || {};
            editorPlaylists = payload.playlists || [];
        }
        if (typeof installPlaylistChips === "function") {
            installPlaylistChips(editorPlaylists);
        }
    });

    // Reply to a balance check. Two callers share the scoreMap round-trip:
    //  - the on-demand "Test Fairness" button (fairnessCheckPending): draw the
    //    overlay + a score toast, no submit flow involved;
    //  - the pre-submit check (submitPending, see submitToGithub): a featured-tier
    //    (or errored) score submits straight through; a lower score shows a
    //    NON-BLOCKING "submit anyway?" nudge listing the main deductions.
    server.on("mapScore", function (payload) {
        // Correlate the reply to the map it scored: the request stamped its
        // serialized map into pendingScoreSig. If the author edited the map after
        // the request went out, this reply is STALE for the current geometry —
        // ignore it (Codex review P2: a stale reply must not draw the wrong routes
        // or feed a submit decision for a different map). A fresh check for the
        // current map is always already scheduled/in-flight when that happens.
        var replySig = pendingScoreSig;
        pendingScoreSig = null; // request consumed
        var curSig = (vMap != null) ? JSON.stringify(vMap) : null;
        var stale = (replySig != null && replySig !== curSig);
        // Remember the latest real verdict, keyed to the map it scored, so an
        // Upload inside the server's 2s throttle window reuses it ONLY when the
        // geometry is unchanged.
        if (payload != null && !payload.error && !stale) {
            lastMapScoreVerdict = { payload: payload, at: Date.now(), sig: replySig };
        }
        if (fairnessCheckPending) {
            fairnessCheckPending = false;
            if (stale) { return; } // map changed mid-check; ignore (no overlay for old geometry)
            if (payload == null || payload.error) {
                // Invalid map (e.g. no goal yet) or the per-socket throttle.
                showSubmitStatus("Couldn't check balance — add a goal, or try again in a moment", "#8a6d00", "white", 6000);
                return;
            }
            applyBalanceOverlay(payload);
            if (payload.tier === "featured") {
                showSubmitStatus("★ " + payload.balanceScore + "/100 — would make Featured!", "green", "white", 6000);
            } else {
                showSubmitStatus(payload.balanceScore + "/100 — see the overlay for fixes (" + balanceHideHint("hides it") + ")", "#8a6d00", "white", 6000);
            }
            return;
        }
        if (!submitPending) { return; }
        // Stale reply during a submit: the abandoned check for the old map must not
        // drive this submit. Drop submitPending and let the user re-Upload (the
        // map they're looking at is different from the one this reply scored).
        if (stale) {
            submitPending = false;
            showSubmitStatus("Map changed — press Upload again to publish", "#8a6d00", "white", 6000);
            return;
        }
        handleSubmitVerdict(payload);
    });

    server.on("maplisting", function (mapnames) {
        if (maps.length > 0) {
            return;
        }
        for (var i = 0; i < mapnames.length; i++) {
            $.getJSON("../maps/" + mapnames[i], function (data) {
                // Maps ship in compact sites-only form; rebuild full geometry so the
                // editor can render/edit them, and generate the load-list thumbnail on
                // demand (no thumbnail is stored or shipped anymore).
                var loaded = reconstructSitesOnlyMap(data);
                maps.push(loaded);
                // Fully escape name/author before interpolating into innerHTML (both
                // the data-search attribute and the visible caption) — quotes alone
                // left & and < to corrupt the markup.
                var nm = escapeHtml(loaded.name), au = escapeHtml(loaded.author);
                var meta = editorMapMeta[loaded.id] || null;
                var plAttr = (meta && meta.playlists) ? meta.playlists.join(" ") : "";
                $("#loadWindow").append('<div class="map-image" data-search="' + nm + ' ' + au + '" data-playlists="' + plAttr + '"><button id="' + loaded.id + '" data-gp-nav><img src="' + renderMapThumbnail(loaded) + '">' + mapBadgeHtml(meta) + '<div class="desc">' + nm + ' | ' + au + '</div></button></div>');
                $("#" + loaded.id).on("click", function () {
                    var id = this.id;
                    // Loading a different map replaces the in-memory map, so warn first
                    // if there are unsaved edits (controller-friendly modal).
                    if (mapModified) {
                        openWipeConfirm("Loading this map will discard the edits you haven't saved. Continue?",
                            function () { loadMapById(id); }, "Discard & load");
                    } else {
                        loadMapById(id);
                    }
                })
                // Cards arrive via parallel AJAX; if a filter chip / search is already
                // active, re-apply it so this late-arriving card respects it instead of
                // showing unconditionally.
                if (typeof applyMapSearch === "function") { applyMapSearch(); }
            });
        }
    });
    return server;
}

// Small quality badge overlaid on a map card: tier + dominant trait + balance score.
// Empty string when the map has no classifier meta (e.g. an unclassifiable map).
function mapBadgeHtml(meta) {
    if (!meta) { return ""; }
    var cls = (meta.tier === "featured") ? "mb-featured" : "mb-community";
    var star = (meta.tier === "featured") ? "★ " : "";
    var trait = meta.dominantTrait ? (meta.dominantTrait.charAt(0).toUpperCase() + meta.dominantTrait.slice(1)) : "";
    var label = star + (trait ? trait + " · " : "") + meta.balanceScore;
    var html = '<div class="map-badge ' + cls + '" title="Balance score ' + meta.balanceScore + '/100">' + label + "</div>";
    // Player rating aggregate (Bayesian avg + vote count), shown once there are votes.
    if (meta.rating && meta.rating.count > 0) {
        var avg = (typeof meta.rating.bayesian === "number") ? meta.rating.bayesian.toFixed(1) : meta.rating.avg;
        html += '<div class="map-badge mb-rating" title="' + meta.rating.count + ' player rating' +
            (meta.rating.count === 1 ? '' : 's') + '">★ ' + avg + '</div>';
    }
    return html;
}

function tryStart() {
    if (!config) return;
    if (imagesLoaded < imagesPending) return;
    if (gameRunning) return;
    loadPatterns();
    gameRunning = true;
    init();
}

function loadPatterns() {

    //Tiles — grade the terrain textures through the shared palette (utils.js)
    // so the editing surface matches the in-game look. Cache the graded canvases
    // in gradedTex so the palette swatches can show the real texture too.
    gradedTex.lava = gradeTexture(lava, "lava");
    gradedTex.ice = gradeTexture(ice, "ice");
    gradedTex.grass = gradeTexture(grass, "grass");
    gradedTex.dirt = gradeTexture(dirt, "dirt");
    gradedTex.sand = gradeTexture(sand, "sand");
    patterns[config.tileMap.lava.id] = makeSeamlessPattern(gradedTex.lava);
    patterns[config.tileMap.ice.id] = makeSeamlessPattern(gradedTex.ice);
    patterns[config.tileMap.fast.id] = makeSeamlessPattern(gradedTex.grass);
    patterns[config.tileMap.normal.id] = makeSeamlessPattern(gradedTex.dirt);
    patterns[config.tileMap.slow.id] = makeSeamlessPattern(gradedTex.sand);
    // Water has no PNG source; build the same procedural texture the in-game client
    // uses (buildWaterTexture) so the editor surface + swatch match the live look.
    if (config.tileMap.water != null) {
        gradedTex.water = buildWaterTexture();
        patterns[config.tileMap.water.id] = makeSeamlessPattern(gradedTex.water);
    }
    patterns[config.tileMap.random.id] = makePattern(random, config.tileMap.random.color);
    patterns[config.tileMap.ability.id] = makePattern(bombIcon, makeSeamlessPattern(gradedTex.dirt));

    brushColor = patterns[config.tileMap.normal.id];
}
// The source canvas is referenced by the returned CanvasPattern (it must be, to
// repeat-tile) but isn't captured in any other closure, and patterns are built
// once in loadPatterns() and never rebuilt — so there's nothing to free here.
function makePattern(image, color) {
    const canvasPadding = 3;
    const canvasPattern = document.createElement("canvas");
    const ctxPattern = canvasPattern.getContext("2d");

    var iconWidth = image.width * scale;
    var iconHeight = image.height * scale;
    canvasPattern.width = iconWidth + canvasPadding;
    canvasPattern.height = iconHeight + canvasPadding;
    ctxPattern.beginPath();
    ctxPattern.fillStyle = color;
    ctxPattern.rect(0, 0, canvasPattern.width, canvasPattern.height);
    ctxPattern.fill();

    ctxPattern.drawImage(image, canvasPadding / 2, canvasPadding / 2, iconWidth, iconHeight);
    return createContext.createPattern(canvasPattern, 'repeat');
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
    return createContext.createPattern(canvasPattern, 'repeat');
}
// Procedural deep-water texture (no PNG asset) — mirrors draw.js buildWaterTexture so
// the editor and the live game render water identically: a blue gradient with a few
// lighter caustic ripple bands (full-period sines so it tiles seamlessly).
function buildWaterTexture() {
    // High-res tile + small `scale` so waves read small and crisp (see draw.js for the
    // full rationale — kept identical so the editor matches the live game).
    var size = 512;
    var cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    var x = cv.getContext("2d");
    var base = (config.tileMap.water && config.tileMap.water.color) ? config.tileMap.water.color : "#2f6fb0";
    var g = x.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, base);
    g.addColorStop(1, "#23578f");
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
    var BANDS = 14, PERIODS = 6, AMP = 3.5;
    x.strokeStyle = "rgba(160,205,240,0.13)";
    x.lineWidth = 2;
    x.lineCap = "round";
    for (var b = 0; b < BANDS; b++) {
        var yBase = (b + 0.5) * size / BANDS;
        x.beginPath();
        for (var px = 0; px <= size; px += 4) {
            var yy = yBase + Math.sin((px / size) * Math.PI * 2 * PERIODS) * AMP;
            if (px === 0) { x.moveTo(px, yy); } else { x.lineTo(px, yy); }
        }
        x.stroke();
    }
    cv.scale = 0.5;
    return cv;
}

// --- textured palette swatches ------------------------------------------------
// Render each tile/hazard button to show what it actually paints (the graded
// terrain texture, or the hazard's in-game look) rather than a flat colour —
// mirroring the lobby skin picker. The button's title carries the name (hover).
function buildSwatchDataURL(opts) {
    var size = 96;
    var c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    var ctx = c.getContext("2d");
    if (opts.texture) {
        ctx.drawImage(opts.texture, 0, 0, size, size);
    } else if (opts.color) {
        ctx.fillStyle = opts.color;
        ctx.fillRect(0, 0, size, size);
    }
    if (opts.icon) {
        var iw = opts.icon.width || 1, ih = opts.icon.height || 1;
        var s = (size * 0.62) / Math.max(iw, ih);
        var w = iw * s, h = ih * s;
        ctx.drawImage(opts.icon, (size - w) / 2, (size - h) / 2, w, h);
    }
    return c.toDataURL();
}
// A hazard swatch draws the in-game look (orange disc + red attack ring; railed
// kinds add their black rail) over a dirt ground — like a bumper sitting on
// terrain — so it contrasts in both themes and reads as "what you'll place".
function buildHazardSwatchDataURL(kind) {
    var size = 96;
    var c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    var ctx = c.getContext("2d");
    if (gradedTex.dirt) {
        ctx.drawImage(gradedTex.dirt, 0, 0, size, size);
    } else {
        ctx.fillStyle = "#7a5b3a";
        ctx.fillRect(0, 0, size, size);
    }
    var cx = size / 2, cy = size / 2;
    if (kind.swatchPaint) {
        kind.swatchPaint(ctx, size);
        return c.toDataURL();
    }
    if (kind.railed) {
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(16, cy);
        ctx.lineTo(size - 16, cy);
        ctx.stroke();
    }
    var hzCfg = objCfgByKey(kind.key);
    ctx.strokeStyle = "red";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = hzCfg.color || "orange";
    ctx.beginPath();
    ctx.arc(cx, cy, 19, 0, 2 * Math.PI);
    ctx.fill();
    return c.toDataURL();
}
function applyTileSwatches() {
    if (config == null) { return; }
    var tiles = [
        ["slowTileButton", { texture: gradedTex.sand }],
        ["normalTileButton", { texture: gradedTex.dirt }],
        ["fastTileButton", { texture: gradedTex.grass }],
        ["lavaTileButton", { texture: gradedTex.lava }],
        ["iceTileButton", { texture: gradedTex.ice }],
        ["waterTileButton", { texture: gradedTex.water }],
        ["abilityTileButton", { texture: gradedTex.dirt, icon: bombIcon }],
        ["randomTileButton", { color: config.tileMap.random.color, icon: random }],
        ["goalTileButton", { color: config.tileMap.goal.color }]
    ];
    for (var i = 0; i < tiles.length; i++) {
        var el = document.getElementById(tiles[i][0]);
        if (el == null) { continue; }
        el.classList.add("swatch");
        el.style.backgroundImage = "url(" + buildSwatchDataURL(tiles[i][1]) + ")";
    }
    for (var h = 0; h < EDITOR_HAZARD_KINDS.length; h++) {
        var kind = EDITOR_HAZARD_KINDS[h];
        var hb = document.getElementById(kind.key + "Button");
        if (hb == null || objCfgByKey(kind.key) == null) { continue; }
        hb.classList.add("swatch");
        hb.style.backgroundImage = "url(" + buildHazardSwatchDataURL(kind) + ")";
    }
}


function setupPage() {
    $("#createNew").on("click", function () {
        resetStatuses();
        showEditor();
    });
    $("#rebuildButton").on("click", function () {
        if (mapHasContent()) {
            openWipeConfirm("Are you sure you want to delete this map?", rebuild);
        } else {
            rebuild();
        }
        return false;
    });
    $("#wipeConfirmYes").on("click", function () {
        var action = wipeConfirmAction;
        closeWipeConfirm();
        if (typeof action === "function") { action(); }
        return false;
    });
    $("#wipeConfirmCancel").on("click", function () {
        closeWipeConfirm();
        return false;
    });
    // Escape cancels (keyboard parity with the native confirm it replaced); with
    // no modal up it dismisses the balance overlay instead.
    $(document).on("keydown", function (e) {
        if (e.key === "Escape" || e.keyCode === 27) {
            if ($("#wipeConfirmModal").is(":visible")) { closeWipeConfirm(); }
            else { clearBalanceOverlay(); }
        }
    });

    $("#deleteSelectedButton").on("click", function () {
        editorDeleteSelected();
        return false;
    });
    $("#rotateButton").on("click", function () {
        editorRotateSelected(15);
        return false;
    });
    $("#rotateLeftButton").on("click", function () {
        editorRotateSelected(-15);
        return false;
    });
    $("#undoButton").on("click", function () { editorUndo(); return false; });
    $("#redoButton").on("click", function () { editorRedo(); return false; });

    $("#selectToolButton").on("click", function () { editorSelectTool("select"); return false; });
    $("#eraserToolButton").on("click", function () { editorSelectTool("eraser"); return false; });

    $("#detailsToggle").on("click", function () { toggleDetailsPanel(); return false; });
    // Clear status toasts + field-required highlights as soon as the user edits any
    // detail, so stale "Failed"/"required" feedback never lingers (backlog UX item).
    $("#author, #name, #email").on("input", function () {
        clearFieldErrors();
        resetStatuses();
    });

    $("#slowTileButton").on("click", function () { editorSelectTile("slow"); return false; });
    $("#normalTileButton").on("click", function () { editorSelectTile("normal"); return false; });
    $("#fastTileButton").on("click", function () { editorSelectTile("fast"); return false; });
    $("#lavaTileButton").on("click", function () { editorSelectTile("lava"); return false; });
    $("#iceTileButton").on("click", function () { editorSelectTile("ice"); return false; });
    $("#waterTileButton").on("click", function () { editorSelectTile("water"); return false; });
    $("#abilityTileButton").on("click", function () { editorSelectTile("ability"); return false; });
    $("#randomTileButton").on("click", function () { editorSelectTile("random"); return false; });
    $("#goalTileButton").on("click", function () { editorSelectTile("goal"); return false; });
    $("#emptyTileButton").on("click", function () { editorSelectTile("empty"); return false; });
    $(".startEdgeButton").on("click", function () {
        var edges = ($(this).attr("data-edges") || "left").split("+");
        setStartEdges(edges);
        return false;
    });
    // Hazard buttons are generated (buildHazardButtons) and bind their own clicks.
    $("#fairnessButton").on("click", function () {
        runFairnessCheck();
        return false;
    });
    $("#previewButton").on("click", function () {
        previewMap();
        return false;
    });
    // "AI racers" is a full-width toggle button (not a DOM checkbox) so it's a
    // big touch target and the editor gamepad nav can flip it via A -> click.
    // Restore the saved choice (default off), then toggle + persist on click.
    var savedAI = false;
    try { savedAI = localStorage.getItem("previewEnableAI") === "true"; } catch (e) { }
    setPreviewAI(savedAI);
    // Preview start-gate picker: cycles Auto -> each current start edge. Only
    // rendered on multi-gate maps (see updatePreviewGateButton).
    try { previewStartEdge = localStorage.getItem("previewStartEdge") || "auto"; } catch (e) { }
    $("#previewGateButton").on("click", function () {
        var opts = ["auto"].concat(startEdges);
        var idx = opts.indexOf(previewStartEdge);
        setPreviewGate(opts[(idx + 1) % opts.length]);
        return false;
    });
    $("#enableAIButton").on("click", function () {
        setPreviewAI($(this).attr("aria-pressed") !== "true");
        return false;
    });
    $("#exportButton").on("click", function () {
        exportToJSON();
        return false;
    });
    $("#submitButton").on("click", function () {
        submitToGithub();
        return false;
    });

    $("#loadButton").on("click", function () {
        setSelectedObject(null);
        $("#createNewImage").attr("src", createCanvas.toDataURL("image/jpeg", 0.1));
        resetStatuses();
        closeDetailsPanel();
        showLoadWindow();
        removeListeners();
        return false;
    });
    window.addEventListener('contextmenu', suppressContextMenu, false);
    window.addEventListener('resize', resize, false);
    window.requestAnimFrame = (function () {
        return window.requestAnimationFrame ||
            window.webkitRequestAnimationFrame ||
            window.mozRequestAnimationFrame ||
            function (callback) {
                window.setTimeout(callback, 1000 / 30);
            };
    })();

    createCanvas = document.getElementById('createCanvas');
    createContext = createCanvas.getContext('2d');
}

function addListeners() {
    window.addEventListener("mousemove", cellUnderMouse, false);
    window.addEventListener("mousedown", handleClick, false);
    window.addEventListener("mouseup", handleUnClick, false);
    // Touch drives the same paint/place/select paths as the mouse. touchstart binds
    // to the canvas (so taps on the tool docks don't paint); move/end bind to the
    // window so a drag that strays off the canvas still tracks (touch capture).
    if (createCanvas != null) {
        createCanvas.addEventListener("touchstart", handleTouchStart, { passive: false });
    }
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: false });
    window.addEventListener("touchcancel", handleTouchEnd, { passive: false });
}

function removeListeners() {
    window.removeEventListener("mousemove", cellUnderMouse, false);
    window.removeEventListener("mousedown", handleClick, false);
    window.removeEventListener("mouseup", handleUnClick, false);
    if (createCanvas != null) {
        createCanvas.removeEventListener("touchstart", handleTouchStart);
    }
    window.removeEventListener("touchmove", handleTouchMove);
    window.removeEventListener("touchend", handleTouchEnd);
    window.removeEventListener("touchcancel", handleTouchEnd);
}

function suppressContextMenu(ev) {
    ev.preventDefault();
    return false;
}

function setSelectedObject(obj) {
    selectedObject = obj;
    var none = (obj == null);
    var ids = ["deleteSelectedButton", "rotateButton", "rotateLeftButton"];
    for (var i = 0; i < ids.length; i++) {
        var btn = document.getElementById(ids[i]);
        if (btn != null) { btn.disabled = none; }
    }
    dirty = true;
}

// True if the map has any author work worth confirming before a wipe/reshape:
// a non-default tile painted, or a hazard placed.
function mapHasContent() {
    if (vMap == null || !Array.isArray(vMap.cells)) { return false; }
    if (vMap.hazards && vMap.hazards.length > 0) { return true; }
    if (config == null) { return false; } // can't compare tile ids until config arrives
    for (var i = 0; i < vMap.cells.length; i++) {
        if (vMap.cells[i].id != config.tileMap.normal.id) { return true; }
    }
    return false;
}

// Controller-friendly replacement for the old native confirm(): show an in-editor
// modal (navigable by the editor gamepad — see editorGamepad.js, which traps focus
// to the modal's buttons while it's open) and run onConfirm if the user accepts.
var wipeConfirmAction = null;
// True while the confirm modal is up. Canvas input (paint/erase/place) must be
// inert behind it: the mouse/touch handlers are window-level, so a click on the
// modal's buttons would otherwise bubble through and paint the map underneath.
function wipeConfirmOpen() {
    var m = document.getElementById("wipeConfirmModal");
    return m != null && !m.classList.contains("hidden");
}
function openWipeConfirm(message, onConfirm, confirmLabel) {
    // Re-entrancy guard: if a confirm is already pending, don't clobber its action.
    if (!$("#wipeConfirmModal").hasClass("hidden")) { return; }
    // A modal can open mid-stroke (the mapScore reply is async) — close out the
    // stroke now so the animloop doesn't keep painting under the dialog.
    if (brushing) { brushing = false; commitStroke(); }
    if (erasing) { erasing = false; commitStroke(); }
    wipeConfirmAction = onConfirm || null;
    var msg = document.getElementById("wipeConfirmMessage");
    if (msg != null) { msg.textContent = message || "Are you sure?"; }
    var yes = document.getElementById("wipeConfirmYes");
    if (yes != null) { yes.textContent = confirmLabel || "Delete"; }
    // Shares the leave-game modal's .confirm-modal styling: toggle .hidden.
    $("#wipeConfirmModal").removeClass("hidden");
}
function closeWipeConfirm() {
    wipeConfirmAction = null;
    $("#wipeConfirmModal").addClass("hidden");
}

function validateEmail(mail) {
    // Non-backtracking pattern (no nested quantifiers on overlapping char
    // classes) — the older /\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+/ was a
    // classic ReDoS shape. Mirror this exact regex server-side (server/utils.js
    // submitPullRequest); changing one without the other desyncs the trust
    // boundaries.
    if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(mail)) {
        return (true)
    }
    return (false)
}

function rebuild() {
    resetStatuses();
    clearFieldErrors();
    clearBalanceOverlay();
    setSelectedObject(null);
    vMap = generateVMap();
    invalidateCellIndex();
    clearHistory(); // a fresh map starts with an empty undo history
    mapModified = false;
    $('#author').val("");
    $('#name').val("");
    $("#createNewImage").attr("src", createCanvas.toDataURL("image/jpeg", 0.1));
    updateContinueTile();
    resize();
}

function init() {
    initEditorGamepad();
    installEditorShortcuts();
    installMapSearch();
    applyTileSwatches();
    recomputeStartLayout();
    updateStartEdgeButtons();
    setTool({ kind: "select" }); // sensible default; pick a tile/hazard to start painting
    updateUndoRedoButtons();
    animloop();
}

function animloop() {
    if (!gameRunning) return;
    pollEditorGamepad();
    var now = Date.now();
    dt = now - then;
    if (mapReady == false) {
        mapReady = true;
        rebuild();
    }
    if (rotatingHandle && selectedObject != null) {
        // Dragging the on-canvas rotate knob: angle tracks the cursor.
        selectedObject.angle = Math.atan2(mousey - selectedObject.y, mousex - selectedObject.x) * (180 / Math.PI);
        updateSelectedObject();
        dirty = true;
    }
    if (drawBrushAimer || erasing) {
        var prev = currentCell;
        currentCell = cellIdFromPoint(mousex, mousey);
        if (prev !== currentCell) dirty = true;
    }
    if (brushing) {
        if (paintTile()) dirty = true;
    }
    if (erasing) {
        if (paintTile(config.tileMap.normal.id)) dirty = true;
    }
    if (dirty) {
        drawEditor(dt);
        dirty = false;
    }
    then = now;
    requestAnimFrame(animloop);
}

function resize() {
    if (createCanvas == null) return;
    var rect = canvasWindow.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    var optimalRatio = Math.min(rect.width / createCanvas.width, rect.height / createCanvas.height);
    newWidth = createCanvas.width * optimalRatio;
    newHeight = createCanvas.height * optimalRatio;
    createCanvas.style.width = newWidth + "px";
    createCanvas.style.height = newHeight + "px";
    dirty = true;
}

function drawEditor(dt) {
    drawBackground(dt);
    drawWorld(dt);
    drawGate();
    renderCells();
    renderHazards();
    drawSelectedObject();
    drawBalanceOverlay();
    drawPointerCircle();
    if (drawObject != null) {
        drawMyObject(mousex, mousey, drawObject);
    }
}
function drawBackground() {
    createContext.clearRect(0, 0, createCanvas.width, createCanvas.height);
}
function drawWorld() {
    if (world != null) {
        createContext.save();
        createContext.beginPath();
        createContext.lineWidth = 3;
        createContext.strokeStyle = "grey";
        createContext.rect(world.x, world.y, world.width, world.height);
        createContext.stroke();
        createContext.restore();
    }
}
// Rebuild the drawn gate(s) and the cell-generation region from the chosen start
// edges. Mirrors server/game.js buildStartingGates so the previewed/submitted gate
// matches where the server holds players. Cells are kept off the gate strip(s) so
// spawns don't land under a gate.
function recomputeStartLayout() {
    var W = world.width, H = world.height, D = GATE_DEPTH;
    var rects = {
        left: { x: 0, y: 0, width: D, height: H },
        right: { x: W - D, y: 0, width: D, height: H },
        top: { x: 0, y: 0, width: W, height: D },
        bottom: { x: 0, y: H - D, width: W, height: D }
    };
    gates = [];
    for (var i = 0; i < startEdges.length; i++) {
        var r = rects[startEdges[i]];
        if (r != null) {
            gates.push({ x: r.x, y: r.y, width: r.width, height: r.height, edge: startEdges[i] });
        }
    }
    // Cell region as a far-corner box {x, y, width(=xr), height(=yb)}: reserve a
    // strip on each selected edge.
    var xl = 0, yt = 0, xr = W, yb = H;
    for (var j = 0; j < startEdges.length; j++) {
        if (startEdges[j] === "left") { xl = Math.max(xl, D); }
        else if (startEdges[j] === "right") { xr = Math.min(xr, W - D); }
        else if (startEdges[j] === "top") { yt = Math.max(yt, D); }
        else if (startEdges[j] === "bottom") { yb = Math.min(yb, H - D); }
    }
    map = { x: xl, y: yt, width: xr, height: yb };
}

// Apply a new start-edge selection from the picker. Changing the start edge
// reshapes the arena — the playable surface shrinks away from the gate strip(s) —
// so the cells are regenerated to fit the new region. That clears painted tiles
// and hazards, so confirm first (via the controller-friendly modal) when the map
// already has author work. No-op when the selection is unchanged.
function setStartEdges(edges) {
    if (sameEdgeSet(edges, startEdges)) { return; }
    if (mapReady && mapHasContent()) {
        openWipeConfirm("Changing the start edge reshapes the map and clears your tiles. Continue?", function () {
            applyStartEdges(edges);
        }, "Reshape");
        return;
    }
    applyStartEdges(edges);
}
function applyStartEdges(edges) {
    startEdges = edges.slice();
    clearBalanceOverlay(); // routes were computed against the old gate layout
    recomputeStartLayout();
    // Regenerate the playable cells in the new (gate-reserving) region so the
    // surface reshapes instead of overlapping the relocated gate.
    if (mapReady && vMap != null) {
        setSelectedObject(null);
        vMap = generateVMap();
        invalidateCellIndex();
        clearHistory(); // the reshape replaced every cell — old undo steps are stale
        // The reshaped surface is blank again (no painted tiles/hazards), so there's
        // nothing unsaved to warn about — matches a fresh map. Painting after this
        // re-sets mapModified via pushCommand.
        mapModified = false;
    }
    if (vMap != null) { vMap.startEdges = startEdges.slice(); }
    updateStartEdgeButtons();
    dirty = true;
}
function sameEdgeSet(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { return false; }
    return a.slice().sort().join("+") === b.slice().sort().join("+");
}

// Sync the picker to whatever start edges the loaded/restored map declares
// (legacy maps without the field default to a single left gate).
function syncStartEdgesFromMap() {
    var se = (vMap != null && Array.isArray(vMap.startEdges) && vMap.startEdges.length > 0) ? vMap.startEdges : ["left"];
    startEdges = se.slice();
    recomputeStartLayout();
    if (vMap != null) { vMap.startEdges = startEdges.slice(); }
    updateStartEdgeButtons();
}

// Highlight the active picker button. Matches on the sorted edge set, so button
// order (e.g. "top+bottom") doesn't have to match the stored order.
function updateStartEdgeButtons() {
    var activeKey = startEdges.slice().sort().join("+");
    $(".startEdgeButton").each(function () {
        var edges = ($(this).attr("data-edges") || "").split("+").sort().join("+");
        // Use the shared .tool-active ring (same as tiles/hazards/tools) instead of a
        // separate inline-blue outline, so the editor has one selection visual.
        $(this).toggleClass("tool-active", edges === activeKey);
    });
    // The preview gate picker tracks the same edge set (every caller of this fn
    // is a start-edge change: init, reshape, map load/restore).
    updatePreviewGateButton();
}

function drawGate() {
    if (gates == null || gates.length === 0) {
        return;
    }
    createContext.save();
    createContext.lineWidth = 5;
    createContext.fillStyle = "grey";
    for (var i = 0; i < gates.length; i++) {
        var g = gates[i];
        createContext.beginPath();
        createContext.rect(g.x, g.y, g.width, g.height);
        createContext.fill();
    }
    createContext.restore();
}
function drawMap() {
    if (map != null) {
        createContext.save();
        createContext.beginPath();
        createContext.lineWidth = 5;
        createContext.rect(map.x, map.y, map.width, map.height);
        createContext.fillStyle = "RED";
        createContext.fill();
        createContext.restore();
    }
}
// --- balance-check overlay ------------------------------------------------------
// Visualizes the mapScore verdict on the map itself: the median race route from
// each start edge (green = fastest side, red = slowest — the fairness deduction is
// exactly that gap), the goal centroid vs the centre line between opposite start
// edges (the goal deduction), and a legend translating every deduction into a fix.
function clearBalanceOverlay() {
    if (balanceOverlay == null) { return; }
    balanceOverlay = null;
    dirty = true;
}

// The control that dismisses the balance overlay, named for whatever the player is
// holding: the face button (B / ○) when a controller is connected — editorGamepad
// maps that to clearBalanceOverlay, keyboard parity with Esc — otherwise "Esc". The
// verb is provided by the caller ("hides this" / "hides them") so each instruction
// reads naturally.
function balanceHideHint(verb) {
    if (typeof egConnected !== "undefined" && egConnected && typeof egGlyphB === "function") {
        return egGlyphB() + " " + verb;
    }
    return "Esc " + verb;
}

// Stash a mapScore payload's overlay geometry for drawEditor. Shared by the
// pre-submit nudge and the on-demand "Test Fairness" button.
function applyBalanceOverlay(payload) {
    if (payload == null || payload.debug == null) { return; }
    balanceOverlay = {
        debug: payload.debug,
        score: payload.balanceScore,
        featuredScore: payload.featuredScore,
        deductions: Array.isArray(payload.deductions) ? payload.deductions : [],
        hardFail: Array.isArray(payload.hardFail) ? payload.hardFail : [],
        par: payload.parTime,
        idealLow: payload.idealParLow,
        idealHigh: payload.idealParHigh
    };
    dirty = true;
}

// On-demand balance check ("Test Fairness" button): same scoreMap round-trip the
// submit flow uses, but the reply only draws the overlay + a score toast. Works
// on unnamed WIP maps (no author/name/email required — nothing is published).
function runFairnessCheck() {
    if (config == null || vMap == null || server == null) { return; }
    if (submitPending || wipeConfirmOpen()) { return; } // don't race the submit flow
    clearBalanceOverlay();
    showSubmitStatus("Checking balance..", "#ADD8E6", "black", 8000);
    fairnessCheckPending = true;
    emitScoreMap(JSON.stringify(vMap));
}

// Single point that fires a scoreMap request: records the exact serialized map
// (so the reply can be matched back to the geometry it scored) and the emit time
// (so the submit flow can dodge the server's 2s per-socket throttle).
function emitScoreMap(sig) {
    pendingScoreSig = sig;
    lastScoreEmitAt = Date.now();
    server.emit('scoreMap', sig);
}

// One-line, on-canvas explanation per deduction label ("fairness -10" -> "fairness").
function balanceHint(label) {
    var ov = balanceOverlay || {};
    switch (label) {
        case "fairness": return "every start point should finish within ~0.2s — slowest line red, fastest green";
        case "length": {
            var band = (ov.idealLow != null ? ov.idealLow : 18) + "–" + (ov.idealHigh != null ? ov.idealHigh : 40) + "s";
            if (ov.par != null && ov.idealLow != null && ov.par < ov.idealLow) {
                return "par " + ov.par + "s is short of the ideal " + band + " — lengthen the route";
            }
            return "par " + (ov.par != null ? ov.par + "s" : "time") + " is past the ideal " + band + " — shorten the route";
        }
        case "goal": return "goal is off-centre — move it toward the dashed centre line";
        case "hazard": return "lava/bumper coverage is off (too heavy, or a token sliver)";
        case "ice": return "too much of the floor is ice";
        case "tiny": return "very few cells — the board is too small";
        case "bland": return "too plain — add fast/ice/ability tiles or hazards";
    }
    return "";
}

// Small dark chip with colored text, clamped inside the world bounds.
function overlayChip(x, y, text, color) {
    var ctx = createContext;
    ctx.font = "bold 15px Arial";
    var w = ctx.measureText(text).width + 12, h = 22;
    if (x + w > world.width - 4) { x = world.width - 4 - w; }
    if (x < 4) { x = 4; }
    if (y + h > world.height - 4) { y = world.height - 4 - h; }
    if (y < 4) { y = 4; }
    ctx.fillStyle = "rgba(20, 20, 28, 0.85)";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillText(text, x + 6, y + 16);
}

function drawBalanceOverlay() {
    if (balanceOverlay == null || balanceOverlay.debug == null) { return; }
    var ctx = createContext;
    var dbg = balanceOverlay.debug;
    var edges = Array.isArray(dbg.edges) ? dbg.edges : [];
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Each gate fans out several routes (one per sampled start point). Colour and
    // label EVERY route by its own time so the slow ones are obvious: the globally
    // slowest line is red, the fastest green, the rest amber — and each line carries
    // its time at its start point. The min/max are the spawn-spread the fairness
    // deduction grades.
    var gmin = null, gmax = null;
    for (var i = 0; i < edges.length; i++) {
        var rs = Array.isArray(edges[i].routes) ? edges[i].routes : [];
        for (var j = 0; j < rs.length; j++) {
            if (typeof rs[j].par !== "number") { continue; }
            if (gmin == null || rs[j].par < gmin) { gmin = rs[j].par; }
            if (gmax == null || rs[j].par > gmax) { gmax = rs[j].par; }
        }
    }
    var sharedExtreme = (gmin === gmax); // single route, or all equal
    function routeColor(par) {
        if (!sharedExtreme && par === gmax) { return "#ff5252"; } // slowest = red
        if (!sharedExtreme && par === gmin) { return "#27c46c"; } // fastest = green
        return "#ffb02e";                                          // mid = amber
    }
    for (var e = 0; e < edges.length; e++) {
        var entry = edges[e];
        var routes = Array.isArray(entry.routes) ? entry.routes : [];
        if (routes.length === 0) {
            // No drivable route from this gate — flag it at the gate itself.
            for (var g = 0; g < gates.length; g++) {
                if (gates[g].edge === entry.edge) {
                    overlayChip(gates[g].x + gates[g].width / 2 - 60, gates[g].y + gates[g].height / 2 - 11,
                        "no route from " + entry.edge + " start", "#ff8080");
                }
            }
            continue;
        }
        // Draw slowest routes LAST so the red line sits on top where lines overlap.
        var order = routes.map(function (rt, idx) { return idx; })
            .sort(function (a, b) { return (routes[a].par || 0) - (routes[b].par || 0); });
        for (var oi = 0; oi < order.length; oi++) {
            var rt = routes[order[oi]];
            var rpts = rt.points;
            if (!Array.isArray(rpts) || rpts.length < 2) { continue; }
            var color = routeColor(rt.par);
            // White casing under the colored line so the route reads on any terrain.
            for (var pass = 0; pass < 2; pass++) {
                ctx.beginPath();
                ctx.moveTo(rpts[0].x, rpts[0].y);
                for (var p = 1; p < rpts.length; p++) { ctx.lineTo(rpts[p].x, rpts[p].y); }
                ctx.strokeStyle = (pass === 0) ? "rgba(255,255,255,0.75)" : color;
                ctx.lineWidth = (pass === 0) ? 7 : 3;
                ctx.globalAlpha = (pass === 0) ? 0.8 : 1;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            // Start dot + its own time label at each gate spawn point.
            ctx.beginPath();
            ctx.arc(rpts[0].x, rpts[0].y, 5, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            var labelY = (entry.edge === "bottom") ? rpts[0].y - 4 : rpts[0].y + 4;
            overlayChip(rpts[0].x + 8, labelY, rt.par + "s", color);
        }
    }
    // Shared goal marker (end of every route).
    for (var ge = 0; ge < edges.length; ge++) {
        var grs = edges[ge].routes;
        if (Array.isArray(grs) && grs.length && grs[0].points.length) {
            var lastPt = grs[0].points[grs[0].points.length - 1];
            ctx.beginPath();
            ctx.arc(lastPt.x, lastPt.y, 5, 0, 2 * Math.PI);
            ctx.fillStyle = "white";
            ctx.fill();
            break;
        }
    }

    // Goal centroid vs the centre line between opposite start gates.
    if (dbg.goal != null) {
        var offCentre = false;
        for (var d = 0; d < balanceOverlay.deductions.length; d++) {
            if (balanceOverlay.deductions[d].indexOf("goal") === 0) { offCentre = true; }
        }
        if (offCentre && edges.length > 1) {
            ctx.setLineDash([10, 8]);
            ctx.strokeStyle = "rgba(255, 213, 74, 0.9)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            if (dbg.goal.vertical) {
                ctx.moveTo(0, world.height / 2);
                ctx.lineTo(world.width, world.height / 2);
            } else {
                ctx.moveTo(world.width / 2, 0);
                ctx.lineTo(world.width / 2, world.height);
            }
            ctx.stroke();
            // Arrow from the goal toward where it should sit.
            var tx = dbg.goal.vertical ? dbg.goal.x : world.width / 2;
            var ty = dbg.goal.vertical ? world.height / 2 : dbg.goal.y;
            ctx.beginPath();
            ctx.moveTo(dbg.goal.x, dbg.goal.y);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.setLineDash([]);
            overlayChip(dbg.goal.x + 14, dbg.goal.y + 14, "goal is off-centre", "#ffd54a");
        }
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(dbg.goal.x, dbg.goal.y, 11, 0, 2 * Math.PI);
        ctx.strokeStyle = "rgba(255, 213, 74, 0.95)";
        ctx.lineWidth = 3;
        ctx.stroke();
    }

    // Legend: the verdict plus a plain-English fix per deduction / hard fail.
    var lines = [["Balance " + balanceOverlay.score + "/100 — Featured needs " +
        (balanceOverlay.featuredScore != null ? balanceOverlay.featuredScore : 85) + "+  (" + balanceHideHint("hides this") + ")", "white"]];
    for (var hf = 0; hf < balanceOverlay.hardFail.length; hf++) {
        lines.push(["✖ " + balanceOverlay.hardFail[hf], "#ff8080"]);
    }
    for (var dd = 0; dd < balanceOverlay.deductions.length; dd++) {
        var ded = balanceOverlay.deductions[dd];
        var hint = balanceHint(ded.split(" ")[0]);
        lines.push(["– " + ded + (hint ? ": " + hint : ""), "#ffd54a"]);
    }
    if (balanceOverlay.hardFail.length === 0 && balanceOverlay.deductions.length === 0) {
        lines.push(["No deductions — nice and fair!", "#7ee08a"]);
    }
    lines.push(["Routes are estimated racing lines — abilities & skilled play aren't modeled", "#9fd3ff"]);
    ctx.font = "bold 15px Arial";
    var maxW = 0;
    for (var lw = 0; lw < lines.length; lw++) {
        var tw = ctx.measureText(lines[lw][0]).width;
        if (tw > maxW) { maxW = tw; }
    }
    var lx = map.x + 12, ly = map.y + 12, lh = 21;
    ctx.fillStyle = "rgba(20, 20, 28, 0.82)";
    ctx.fillRect(lx, ly, maxW + 20, lines.length * lh + 14);
    for (var ll = 0; ll < lines.length; ll++) {
        ctx.fillStyle = lines[ll][1];
        ctx.fillText(lines[ll][0], lx + 10, ly + 22 + ll * lh);
    }
    ctx.restore();
}

function drawMyObject(x, y, myObject, angle) {
    if (angle == null) {
        angle = 0;
    }
    var kind = editorHazardKindById(myObject);
    if (kind != null) {
        (kind.paint || paintHazardShape)(createContext, kind, x, y, angle, "red");
    }
}
// A placed object's config lives in config.hazards OR config.boons — boons reuse
// the hazard editor pipeline (same placement/select/rotate/undo path) but tune
// from their own namespace. Resolve from whichever defines the key.
function objCfgByKey(key) {
    if (config == null) { return null; }
    if (config.hazards != null && config.hazards[key] != null) { return config.hazards[key]; }
    if (config.boons != null && config.boons[key] != null) { return config.boons[key]; }
    return null;
}
// Dash Arrows painter (the dashArrows `paint` hook) — mirrors the in-game look
// (draw.js drawDashArrows): a translucent teal pad with two chevrons pointing
// along `angle`, the boost direction.
function paintDashArrowsShape(ctx, kind, x, y, angle, ringColor) {
    var cfg = objCfgByKey(kind.key);
    if (cfg == null) { return; }
    var rad = (angle || 0) * (Math.PI / 180);
    var w = cfg.width, hgt = cfg.height;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rad);
    // Faint footprint that blends into the terrain (matches draw.js drawDashArrows).
    ctx.beginPath();
    ctx.rect(-w / 2, -hgt / 2, w, hgt);
    ctx.fillStyle = "rgba(63,193,201,0.06)";
    ctx.fill();
    ctx.strokeStyle = "rgba(63,193,201,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    var ch = hgt * 0.32;
    for (var i = 0; i < 2; i++) {
        var bx = -w * 0.16 + i * (w * 0.30);
        ctx.beginPath();
        ctx.moveTo(bx - 8, -ch);
        ctx.lineTo(bx + 8, 0);
        ctx.lineTo(bx - 8, ch);
        ctx.stroke();
    }
    ctx.restore();
}
// True when a boon placed at (x,y) sits on a water cell in the map being edited, so
// the painter can preview the foam "water variant" exactly as it renders in-game.
// renderCells() (which rebuilds tileIdByVid) runs before renderHazards() each frame.
function editorBoonOnWater(x, y) {
    if (config == null || config.tileMap == null || config.tileMap.water == null) { return false; }
    if (typeof cellIdFromPoint !== "function" || tileIdByVid == null) { return false; }
    var vid = cellIdFromPoint(x, y);
    return vid != null && tileIdByVid[vid] === config.tileMap.water.id;
}
// Recharge Spring painter (the rechargeSpring `paint` hook) — mirrors the in-game
// look (draw.js drawRechargeSpring). On land: faint green footprint + ring + green
// restore cross. On water: the bubbling-spring variant (white footprint, foam ripple
// rings, static bubbles) + the cross. Static in the editor (no animation).
function paintRechargeSpringShape(ctx, kind, x, y, angle, ringColor) {
    var cfg = objCfgByKey(kind.key);
    if (cfg == null) { return; }
    var r = cfg.radius;
    var onWater = editorBoonOnWater(x, y);
    ctx.save();
    ctx.translate(x, y);
    if (onWater) {
        var foam = cfg.colorWater;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(234,251,255,0.12)";
        ctx.fill();
        ctx.strokeStyle = foam;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.5, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.85, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillStyle = foam;
        for (var bi = 0; bi < 3; bi++) {
            ctx.beginPath();
            ctx.arc((bi - 1) * r * 0.28, -r * 0.2 - bi * 3, 2.4, 0, 2 * Math.PI);
            ctx.fill();
        }
    } else {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(91,227,160,0.08)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.78, 0, 2 * Math.PI);
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 3;
        ctx.stroke();
    }
    var arm = r * 0.42;
    ctx.strokeStyle = cfg.color;
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-arm, 0);
    ctx.lineTo(arm, 0);
    ctx.moveTo(0, -arm);
    ctx.lineTo(0, arm);
    ctx.stroke();
    ctx.restore();
}
// Slipstream painter (the slipstream `paint` hook) — mirrors the in-game look
// (draw.js drawSlipstream). On land: straight light-blue streamlines + leading
// arrowheads along `angle`. On water: foam-white wavy streamlines (a river current).
// Static (no flow animation).
function paintSlipstreamShape(ctx, kind, x, y, angle, ringColor) {
    var cfg = objCfgByKey(kind.key);
    if (cfg == null) { return; }
    var rad = (angle || 0) * (Math.PI / 180);
    var w = cfg.width, hgt = cfg.height;
    var onWater = editorBoonOnWater(x, y);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rad);
    ctx.beginPath();
    ctx.rect(-w / 2, -hgt / 2, w, hgt);
    ctx.fillStyle = onWater ? "rgba(234,248,255,0.08)" : "rgba(127,216,255,0.06)";
    ctx.fill();
    ctx.strokeStyle = onWater ? "rgba(234,248,255,0.14)" : "rgba(127,216,255,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = onWater ? cfg.colorWater : cfg.color;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    var rows = [-hgt * 0.28, 0, hgt * 0.28];
    var x0 = -w / 2 + 8, x1 = w / 2 - 16;
    for (var i = 0; i < rows.length; i++) {
        var ly = rows[i];
        if (onWater) {
            ctx.beginPath();
            for (var sx = x0; sx <= x1; sx += 8) {
                var wy = ly + Math.sin(sx / 18 + i) * 4;
                if (sx === x0) { ctx.moveTo(sx, wy); } else { ctx.lineTo(sx, wy); }
            }
            ctx.stroke();
        } else {
            ctx.setLineDash([18, 10]);
            ctx.beginPath();
            ctx.moveTo(x0, ly);
            ctx.lineTo(x1, ly);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.beginPath();
        ctx.moveTo(w / 2 - 22, ly - 7);
        ctx.lineTo(w / 2 - 10, ly);
        ctx.lineTo(w / 2 - 22, ly + 7);
        ctx.stroke();
    }
    ctx.restore();
}
// Wall-band painter (bumperWall's `paint` hook). Mirrors the in-game look
// (draw.js drawBumperWall): rim band over the bumper-orange core, anchored at
// (x,y) and extending `width` along `angle`.
function paintBumperWallShape(ctx, kind, x, y, angle, ringColor) {
    var cfg = objCfgByKey(kind.key);
    if (cfg == null) { return; }
    var rad = (angle || 0) * (Math.PI / 180);
    var bx = x + Math.cos(rad) * cfg.width;
    var by = y + Math.sin(rad) * cfg.width;
    ctx.save();
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = "#E5392B";
    ctx.lineWidth = cfg.height + 6;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = cfg.height;
    ctx.stroke();
    ctx.restore();
}
// Rotor painter (rotor's `paint` hook). In the editor (x,y) is the PIVOT and
// `angle` the starting sweep; the head sits orbitRadius out along it. Mirrors
// the in-game look (draw.js drawRotor): dark hub + arm to a bumper-orange head
// with the red attack ring. (In-game the server tracks the head as the hazard
// position; here the static map entry stores the pivot.)
function paintRotorShape(ctx, kind, x, y, angle, ringColor) {
    var cfg = config.hazards[kind.key];
    if (cfg == null) { return; }
    var rad = (angle || 0) * (Math.PI / 180);
    var hx = x + Math.cos(rad) * cfg.orbitRadius;
    var hy = y + Math.sin(rad) * cfg.orbitRadius;
    ctx.save();
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(hx, hy);
    ctx.strokeStyle = "#222";
    ctx.lineWidth = cfg.armWidth;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, cfg.armWidth, 0, 2 * Math.PI);
    ctx.fillStyle = "#222";
    ctx.fill();
    // Head.
    ctx.beginPath();
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 3;
    ctx.arc(hx, hy, cfg.attackRadius, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, hy, cfg.radius, 0, 2 * Math.PI);
    ctx.fillStyle = cfg.color;
    ctx.fill();
    ctx.restore();
}
// Geyser painter (geyser's `paint` hook). The editor shows the dormant vent —
// stone rim + dark throat + a faint reach ring so authors see the eruption area.
function paintGeyserShape(ctx, kind, x, y, angle, ringColor) {
    var cfg = config.hazards[kind.key];
    if (cfg == null) { return; }
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, cfg.attackRadius, 0, 2 * Math.PI);
    ctx.strokeStyle = ringColor;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, cfg.radius, 0, 2 * Math.PI);
    ctx.fillStyle = "#3a2f2a";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#6b5546";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, cfg.radius * 0.6, 0, 2 * Math.PI);
    ctx.fillStyle = "#241c18";
    ctx.fill();
    ctx.restore();
}
// Mine painter (mine's `paint` hook). Shows the spiked body + a dashed trigger
// ring (the proximity radius) so authors can see how close is too close.
function paintMineShape(ctx, kind, x, y, angle, ringColor) {
    var cfg = config.hazards[kind.key];
    if (cfg == null) { return; }
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, cfg.radius, 0, 2 * Math.PI);
    ctx.strokeStyle = ringColor;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    var r = cfg.bodyRadius;
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 3;
    for (var s = 0; s < 8; s++) {
        var a = (s / 8) * 2 * Math.PI;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        ctx.lineTo(x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5));
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = "#2b2b2b";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.4, 0, 2 * Math.PI);
    ctx.fillStyle = "#ffc24b";
    ctx.fill();
    ctx.restore();
}
// Shared per-kind hazard painter for the editor canvas (placement preview +
// placed hazards) and the load-list thumbnails — the default `paint` hook.
// Railed kinds draw their rail bar from (x,y) along `angle`; every kind draws
// the attack ring + disc from its config entry. Kinds with a different look
// (e.g. the bumper wall's band) set their own `paint` on EDITOR_HAZARD_KINDS.
function paintHazardShape(ctx, kind, x, y, angle, ringColor) {
    var cfg = objCfgByKey(kind.key);
    if (cfg == null) { return; }
    if (kind.railed) {
        ctx.save();
        ctx.beginPath();
        ctx.translate(x, y);
        ctx.rotate((angle || 0) * (Math.PI / 180));
        ctx.rect(0, -cfg.height / 2, cfg.width, cfg.height);
        ctx.fillStyle = "black";
        ctx.fill();
        ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 3;
    ctx.arc(x, y, cfg.attackRadius, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, cfg.radius, 0, 2 * Math.PI);
    ctx.fillStyle = cfg.color;
    ctx.fill();
    ctx.restore();
}
function handleClick(event) {
    // Canvas input is inert while the confirm modal is up — these are window-level
    // listeners, so a click on the modal's buttons reaches here too and would
    // paint/erase/place straight through the dialog.
    if (wipeConfirmOpen()) { return; }
    switch (event.which) {
        case 1: {
            if (erasing) { break; } // don't start a paint while a right-erase is in progress
            // On-canvas hazard handles take priority over painting/selecting.
            if (selectedObject != null) {
                if (overDeleteHandle(mousex, mousey)) { removeSelectedObject(); break; }
                if (overRotateHandle(mousex, mousey)) {
                    rotatingHandle = true;
                    rotateStartAngle = selectedObject.angle || 0;
                    break;
                }
            }
            if (drawBrushAimer) { brushing = true; beginStroke(); break; }
            if (drawObject != null) { addObjectToMap(mousex, mousey, drawObject); break; }
            locateObject(mousex, mousey);
            break;
        }
        case 3: {
            if (brushing || rotatingHandle) { break; } // don't erase while painting/rotating
            // Right button: delete a hazard under the cursor, else erase to dirt
            // (right-drag keeps erasing). Backlog UX item.
            if (hazardUnderPoint(mousex, mousey)) {
                removeHazardUnderPoint(mousex, mousey);
                break;
            }
            erasing = true;
            beginStroke();
            break;
        }
    }
}
function handleUnClick(event) {
    switch (event.which) {
        case 1: {
            if (rotatingHandle) {
                rotatingHandle = false;
                if (selectedObject != null) {
                    pushRotateCommand(selectedHazardIndex(), rotateStartAngle, selectedObject.angle || 0);
                }
                break;
            }
            if (brushing) { brushing = false; commitStroke(); break; }
            break;
        }
        case 3: {
            if (erasing) { erasing = false; commitStroke(); break; }
            break;
        }
    }
}

// --- touch input --------------------------------------------------------------
// Single-touch only: track the first finger's identifier and ignore extra fingers,
// so a stray second touch can't snap the cursor or restart/commit the stroke.
function canvasPointFromTouch(touch) {
    var rect = createCanvas.getBoundingClientRect();
    // Map through the *live* displayed size, not the cached newWidth/newHeight which
    // are 0 until a successful resize() — a tap during the first/reflow layout would
    // otherwise divide by 0 and map to Infinity.
    if (rect.width === 0 || rect.height === 0) { return { x: mousex, y: mousey }; }
    return {
        x: ((touch.clientX - rect.left) / rect.width) * createCanvas.width,
        y: ((touch.clientY - rect.top) / rect.height) * createCanvas.height
    };
}
function findTrackedTouch(list) {
    for (var i = 0; i < list.length; i++) {
        if (list[i].identifier === touchId) { return list[i]; }
    }
    return null;
}
function handleTouchStart(event) {
    if (wipeConfirmOpen()) { return; } // modal up: don't capture or paint (see handleClick)
    if (touchActive || event.changedTouches.length === 0) { return; } // ignore extra fingers
    event.preventDefault();
    touchActive = true;
    var t = event.changedTouches[0];
    touchId = t.identifier;
    var p = canvasPointFromTouch(t);
    setMousePos(p.x, p.y);
    // Resolve the touched cell up front so the first paint lands immediately
    // (the animloop's per-frame recompute hasn't run yet for this point).
    if (drawBrushAimer) { currentCell = cellIdFromPoint(p.x, p.y); }
    handleClick({ which: 1 });
}
function handleTouchMove(event) {
    if (!touchActive) { return; }
    var t = findTrackedTouch(event.touches);
    if (t == null) { return; }
    event.preventDefault();
    var p = canvasPointFromTouch(t);
    setMousePos(p.x, p.y);
    dirty = true;
}
function handleTouchEnd(event) {
    if (!touchActive) { return; }
    // End only when OUR finger lifts; touchcancel always ends the stroke.
    if (event.type !== "touchcancel" && findTrackedTouch(event.changedTouches) == null) { return; }
    if (event.cancelable) { event.preventDefault(); }
    touchActive = false;
    touchId = null;
    handleUnClick({ which: 1 });
}

// --- unified tool model -------------------------------------------------------
// Every input path routes through setTool(); the legacy render flags are derived
// here so draw/paint code is untouched.
function setTool(tool) {
    activeTool = tool;
    drawBrushAimer = (tool.kind === "tile" || tool.kind === "eraser");
    drawObject = (tool.kind === "hazard") ? tool.id : null;
    if (tool.kind === "tile") {
        brushID = tool.id;
        brushColor = tool.color;
    } else if (tool.kind === "eraser") {
        brushID = config.tileMap.normal.id;
        brushColor = patterns[config.tileMap.normal.id];
    }
    // A paint/place tool can't also keep a hazard selected (no handles to show).
    if (tool.kind !== "select") {
        setSelectedObject(null);
    }
    updateToolButtons();
    dirty = true;
}
function editorSelectTool(kind) {
    // The eraser needs config (it paints the default tile id); guard like the
    // tile/hazard selectors do. Select needs no config.
    if (kind === "eraser") {
        if (config == null) { return; }
        setTool({ kind: "eraser" });
        return;
    }
    setTool({ kind: "select" });
}
function editorSelectTile(typeName) {
    if (config == null) { return; }
    var t = config.tileMap[typeName];
    if (t == null) { return; }
    var color = (patterns[t.id] != null) ? patterns[t.id] : t.color;
    setTool({ kind: "tile", id: t.id, color: color, name: typeName });
}
function editorSelectHazard(typeName) {
    if (config == null) { return; }
    var h = objCfgByKey(typeName); // hazard OR boon — both use the "hazard" tool path
    if (h == null) { return; }
    setTool({ kind: "hazard", id: h.id, name: typeName });
}
function editorDeselect() {
    if (selectedObject != null) { setSelectedObject(null); }
}
function editorRotateSelected(deg) {
    if (selectedObject == null) { return; }
    var from = selectedObject.angle || 0;
    selectedObject.angle = from + deg;
    updateSelectedObject();
    pushRotateCommand(selectedHazardIndex(), from, selectedObject.angle);
    dirty = true;
}
function editorDeleteSelected() {
    if (selectedObject != null) { removeSelectedObject(); }
}

// Highlight the active tool/tile/hazard button.
var TOOL_BUTTON_IDS = ["selectToolButton", "eraserToolButton", "slowTileButton",
    "normalTileButton", "fastTileButton", "lavaTileButton", "iceTileButton",
    "waterTileButton", "abilityTileButton", "randomTileButton", "goalTileButton",
    "emptyTileButton"];
function allToolButtonIds() {
    var ids = TOOL_BUTTON_IDS.slice();
    for (var i = 0; i < EDITOR_HAZARD_KINDS.length; i++) {
        ids.push(EDITOR_HAZARD_KINDS[i].key + "Button");
    }
    return ids;
}
function updateToolButtons() {
    var buttonIds = allToolButtonIds();
    for (var i = 0; i < buttonIds.length; i++) {
        var el = document.getElementById(buttonIds[i]);
        if (el != null) { el.classList.remove("tool-active"); }
    }
    var activeId = activeToolButtonId();
    if (activeId != null) {
        var a = document.getElementById(activeId);
        if (a != null) { a.classList.add("tool-active"); }
    }
}
function activeToolButtonId() {
    if (activeTool.kind === "select") { return "selectToolButton"; }
    if (activeTool.kind === "eraser") { return "eraserToolButton"; }
    if (activeTool.kind === "tile") {
        var tileMap = {
            slow: "slowTileButton", normal: "normalTileButton", fast: "fastTileButton",
            lava: "lavaTileButton", ice: "iceTileButton", water: "waterTileButton",
            ability: "abilityTileButton",
            random: "randomTileButton", goal: "goalTileButton", empty: "emptyTileButton"
        };
        return tileMap[activeTool.name] || null;
    }
    if (activeTool.kind === "hazard") {
        return activeTool.name + "Button";
    }
    return null;
}

// --- paint-stroke undo grouping ----------------------------------------------
// Idempotent: a second begin (e.g. button chording) must not clobber the
// in-progress stroke's accumulated diff.
function beginStroke() { if (strokeChanges == null) { strokeChanges = {}; } }
function recordCellChange(idx, from, to) {
    if (strokeChanges == null) { return; }
    if (!Object.prototype.hasOwnProperty.call(strokeChanges, idx)) {
        strokeChanges[idx] = { from: from };
    }
    strokeChanges[idx].to = to;
}
function commitStroke() {
    if (strokeChanges == null) { return; }
    var changes = [];
    for (var k in strokeChanges) {
        if (!Object.prototype.hasOwnProperty.call(strokeChanges, k)) { continue; }
        var c = strokeChanges[k];
        if (c.from !== c.to) { changes.push({ idx: +k, from: c.from, to: c.to }); }
    }
    strokeChanges = null;
    if (changes.length === 0) { return; }
    pushCommand({
        undo: function () { for (var i = 0; i < changes.length; i++) { var cell = vMap.cells[changes[i].idx]; if (cell) { cell.id = changes[i].from; } } },
        redo: function () { for (var i = 0; i < changes.length; i++) { var cell = vMap.cells[changes[i].idx]; if (cell) { cell.id = changes[i].to; } } }
    });
}

// --- hazard kinds (editor side) ------------------------------------------------
// The editor's view of the map-authorable hazard kinds (server counterpart:
// the registry in server/entities/hazards.js — keep the key sets in sync).
// Adding a hazard kind in the editor = one entry here. Each entry drives the
// palette button (label/title/shortcut), the swatch, the canvas painter, the
// hit-test, and the angle requirement in the mirrored validateMap below.
// key indexes config.hazards. Optional hooks (defaults cover disc-style kinds):
//   paint(ctx, kind, x, y, angle, ringColor) — custom canvas/thumbnail painter
//   swatchPaint(ctx, size) — custom palette-swatch overlay
//   segmentSelect — hit-test against the centerline segment, not the anchor disc
//   directional — map entry needs a finite angle (railed kinds are directional)
//   group — "boon" routes the palette button to the Boons section (helpful kinds,
//           config.boons); absent/"hazard" routes to the Hazards section.
var EDITOR_HAZARD_KINDS = [
    { key: "bumper", label: "Bumper", shortcut: "b", railed: false, directional: false },
    { key: "movingBumper", label: "Moving Bumper", shortcut: "m", railed: true, directional: true },
    {
        key: "bumperWall", label: "Bumper Wall", shortcut: "w", railed: false, directional: true,
        segmentSelect: true, paint: paintBumperWallShape,
        swatchPaint: function (ctx, size) {
            // The in-game look at swatch scale: red rim band over the orange core.
            var cy = size / 2;
            ctx.lineCap = "round";
            ctx.strokeStyle = "#E5392B";
            ctx.lineWidth = 22;
            ctx.beginPath();
            ctx.moveTo(16, cy);
            ctx.lineTo(size - 16, cy);
            ctx.stroke();
            ctx.strokeStyle = "orange";
            ctx.lineWidth = 13;
            ctx.beginPath();
            ctx.moveTo(16, cy);
            ctx.lineTo(size - 16, cy);
            ctx.stroke();
        }
    },
    {
        key: "rotor", label: "Rotor", shortcut: "o", railed: false, directional: false,
        paint: paintRotorShape,
        swatchPaint: function (ctx, size) {
            // Hub + arm to an orange head with red ring — the rotor at swatch scale.
            var cx = size / 2, cy = size / 2;
            var hx = size - 22, hy = size - 22;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(cx - 14, cy - 14);
            ctx.lineTo(hx, hy);
            ctx.strokeStyle = "#222";
            ctx.lineWidth = 9;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx - 14, cy - 14, 9, 0, 2 * Math.PI);
            ctx.fillStyle = "#222";
            ctx.fill();
            ctx.beginPath();
            ctx.strokeStyle = "#E5392B";
            ctx.lineWidth = 5;
            ctx.arc(hx, hy, 17, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(hx, hy, 12, 0, 2 * Math.PI);
            ctx.fillStyle = "orange";
            ctx.fill();
        }
    },
    {
        key: "geyser", label: "Geyser", shortcut: "g", railed: false, directional: false,
        paint: paintGeyserShape,
        swatchPaint: function (ctx, size) {
            // Stone vent + dark throat + dashed eruption-reach ring.
            var cx = size / 2, cy = size / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, size * 0.42, 0, 2 * Math.PI);
            ctx.strokeStyle = "#E5392B";
            ctx.setLineDash([5, 5]);
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(cx, cy, size * 0.26, 0, 2 * Math.PI);
            ctx.fillStyle = "#3a2f2a";
            ctx.fill();
            ctx.lineWidth = 4;
            ctx.strokeStyle = "#6b5546";
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, size * 0.16, 0, 2 * Math.PI);
            ctx.fillStyle = "#241c18";
            ctx.fill();
        }
    },
    {
        key: "mine", label: "Mine", shortcut: "i", railed: false, directional: false,
        paint: paintMineShape,
        swatchPaint: function (ctx, size) {
            // Spiked body + amber light + dashed trigger ring.
            var cx = size / 2, cy = size / 2, r = size * 0.22;
            ctx.beginPath();
            ctx.arc(cx, cy, size * 0.42, 0, 2 * Math.PI);
            ctx.strokeStyle = "#E5392B";
            ctx.setLineDash([5, 5]);
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.strokeStyle = "#222";
            ctx.lineWidth = 4;
            for (var s = 0; s < 8; s++) {
                var a = (s / 8) * 2 * Math.PI;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
                ctx.lineTo(cx + Math.cos(a) * (r + 8), cy + Math.sin(a) * (r + 8));
                ctx.stroke();
            }
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, 2 * Math.PI);
            ctx.fillStyle = "#2b2b2b";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.4, 0, 2 * Math.PI);
            ctx.fillStyle = "#ffc24b";
            ctx.fill();
        }
    },
    {
        key: "dashArrows", label: "Dash Arrows", shortcut: "d", railed: false, directional: true,
        group: "boon", paint: paintDashArrowsShape,
        swatchPaint: function (ctx, size) {
            // Two teal chevrons pointing right — "this flings you THIS way".
            var cy = size / 2;
            ctx.strokeStyle = "#3FC1C9";
            ctx.lineWidth = 9;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            for (var i = 0; i < 2; i++) {
                var bx = 30 + i * 26;
                ctx.beginPath();
                ctx.moveTo(bx - 12, cy - 18);
                ctx.lineTo(bx + 12, cy);
                ctx.lineTo(bx - 12, cy + 18);
                ctx.stroke();
            }
        }
    },
    {
        key: "rechargeSpring", label: "Recharge Spring", shortcut: "c", railed: false, directional: false,
        group: "boon", paint: paintRechargeSpringShape,
        swatchPaint: function (ctx, size) {
            // Green ring + restore cross — "this tops you back up".
            var cx = size / 2, cy = size / 2;
            ctx.strokeStyle = "#5BE3A0";
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.arc(cx, cy, size * 0.32, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.lineWidth = 8;
            ctx.lineCap = "round";
            var arm = size * 0.18;
            ctx.beginPath();
            ctx.moveTo(cx - arm, cy);
            ctx.lineTo(cx + arm, cy);
            ctx.moveTo(cx, cy - arm);
            ctx.lineTo(cx, cy + arm);
            ctx.stroke();
        }
    },
    {
        key: "slipstream", label: "Slipstream", shortcut: "t", railed: false, directional: true,
        group: "boon", paint: paintSlipstreamShape,
        swatchPaint: function (ctx, size) {
            // Three blue streamlines pointing right — "a current carries you THIS way".
            ctx.strokeStyle = "#7FD8FF";
            ctx.lineWidth = 6;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            var rows = [size * 0.30, size * 0.5, size * 0.70];
            for (var i = 0; i < rows.length; i++) {
                var ly = rows[i];
                ctx.beginPath();
                ctx.moveTo(12, ly);
                ctx.lineTo(size - 22, ly);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(size - 28, ly - 8);
                ctx.lineTo(size - 14, ly);
                ctx.lineTo(size - 28, ly + 8);
                ctx.stroke();
            }
        }
    }
];
function editorHazardKindById(id) {
    for (var i = 0; i < EDITOR_HAZARD_KINDS.length; i++) {
        var cfg = objCfgByKey(EDITOR_HAZARD_KINDS[i].key);
        if (cfg != null && cfg.id === id) { return EDITOR_HAZARD_KINDS[i]; }
    }
    return null;
}
// Generate one palette button per kind into the Hazards (#hazardButtonGrid) or
// Boons (#boonButtonGrid) section by kind.group (the HTML ships both empty —
// buttons can't be static because labels/shortcuts live here). Runs on the config
// socket message; idempotent for reconnects.
function buildHazardButtons() {
    var hazardGrid = document.getElementById("hazardButtonGrid");
    var boonGrid = document.getElementById("boonButtonGrid");
    if (hazardGrid == null || config == null) { return; }
    if (hazardGrid.childElementCount > 0 || (boonGrid != null && boonGrid.childElementCount > 0)) { return; }
    for (var i = 0; i < EDITOR_HAZARD_KINDS.length; i++) {
        (function (kind) {
            if (objCfgByKey(kind.key) == null) { return; }
            var grid = (kind.group === "boon" && boonGrid != null) ? boonGrid : hazardGrid;
            var btn = document.createElement("button");
            btn.id = kind.key + "Button";
            btn.className = "mapEditorTile";
            btn.title = kind.label + (kind.shortcut ? " (" + kind.shortcut.toUpperCase() + ")" : "");
            btn.setAttribute("data-gp-nav", "");
            var span = document.createElement("span");
            span.textContent = kind.label;
            btn.appendChild(span);
            btn.addEventListener("click", function (e) {
                e.preventDefault();
                editorSelectHazard(kind.key);
            });
            grid.appendChild(btn);
        })(EDITOR_HAZARD_KINDS[i]);
    }
}

// --- hazard helpers (index/reference based — also fixes the stacked-duplicate
//     selection bug, since selection now tracks the array index, not x/y) -------
// Resolve a hazard config by its id. Built once when the config socket message
// arrives (buildHazardById) so the per-call for-in over config.hazards — hit on
// every hover/place/select — collapses to a single map lookup. Falls back to the
// linear scan if a lookup somehow happens before the map is built.
var hazardById = null;
function buildHazardById() {
    hazardById = {};
    if (config == null) { return; }
    // Index BOTH hazards and boons by id — they share the editor's placed-object
    // list (vMap.hazards), so hit-testing/painting must resolve either.
    if (config.hazards != null) {
        for (var type in config.hazards) {
            hazardById[config.hazards[type].id] = config.hazards[type];
        }
    }
    if (config.boons != null) {
        for (var btype in config.boons) {
            if (config.boons[btype] && typeof config.boons[btype].id === "number") {
                hazardById[config.boons[btype].id] = config.boons[btype];
            }
        }
    }
}
function hazardConfigById(id) {
    if (hazardById != null) {
        return Object.prototype.hasOwnProperty.call(hazardById, id) ? hazardById[id] : null;
    }
    for (var type in config.hazards) {
        if (config.hazards[type].id == id) { return config.hazards[type]; }
    }
    for (var btype in (config.boons || {})) {
        if (config.boons[btype] && config.boons[btype].id == id) { return config.boons[btype]; }
    }
    return null;
}
function selectedHazardIndex() {
    return (selectedObject != null && selectedObject.index != null) ? selectedObject.index : -1;
}
function hazardIndexUnderPoint(x, y) {
    if (outsideMapBounds(x, y, 0)) { return -1; }
    var hazards = vMap.hazards || [];
    for (var i = hazards.length - 1; i >= 0; i--) { // topmost (last drawn) first
        var cfg = hazardConfigById(hazards[i].id);
        if (cfg == null) { continue; }
        // Segment-style kinds (the bumper wall) are selectable anywhere along
        // their band, not just at the anchor: hit-test distance to the
        // centerline segment instead.
        var hitKind = editorHazardKindById(hazards[i].id);
        if (hitKind != null && hitKind.segmentSelect) {
            var rad = (hazards[i].angle || 0) * Math.PI / 180;
            var p = closestOnSegmentEditor(x, y, hazards[i].x, hazards[i].y,
                hazards[i].x + Math.cos(rad) * cfg.width, hazards[i].y + Math.sin(rad) * cfg.width);
            if (getMagSq(x, y, p.x, p.y) < Math.pow(cfg.radius, 2)) { return i; }
            continue;
        }
        if (getMagSq(x, y, hazards[i].x, hazards[i].y) < Math.pow(cfg.radius, 2)) { return i; }
    }
    return -1;
}
// Nearest point on segment AB to P (editor-local copy of the server helper).
function closestOnSegmentEditor(px, py, ax, ay, bx, by) {
    var abx = bx - ax, aby = by - ay;
    var len2 = abx * abx + aby * aby;
    if (len2 < 1e-6) { return { x: ax, y: ay }; }
    var t = ((px - ax) * abx + (py - ay) * aby) / len2;
    if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
    return { x: ax + abx * t, y: ay + aby * t };
}
function hazardUnderPoint(x, y) { return hazardIndexUnderPoint(x, y) >= 0; }
function removeHazardUnderPoint(x, y) {
    var i = hazardIndexUnderPoint(x, y);
    if (i < 0) { return; }
    var removed = vMap.hazards[i];
    vMap.hazards.splice(i, 1);
    pushHazardRemoveCommand(removed, i);
    setSelectedObject(null); // a splice shifts indices — drop any stale selection
    dirty = true;
}
function pushHazardAddCommand(hazard) {
    pushCommand({
        undo: function () { var i = vMap.hazards.indexOf(hazard); if (i >= 0) { vMap.hazards.splice(i, 1); } },
        redo: function () { if (vMap.hazards.indexOf(hazard) < 0) { vMap.hazards.push(hazard); } }
    });
}
function pushHazardRemoveCommand(hazard, index) {
    pushCommand({
        undo: function () { vMap.hazards.splice(Math.min(index, vMap.hazards.length), 0, hazard); },
        redo: function () { var i = vMap.hazards.indexOf(hazard); if (i >= 0) { vMap.hazards.splice(i, 1); } }
    });
}
function pushRotateCommand(index, from, to) {
    if (from === to) { return; }
    var hz = (index >= 0 && vMap.hazards[index]) ? vMap.hazards[index] : null;
    if (hz == null) { return; }
    pushCommand({
        undo: function () { hz.angle = from; },
        redo: function () { hz.angle = to; }
    });
}

// --- on-canvas hazard handles -------------------------------------------------
function rotateHandlePos() {
    var r = selectedObject.radius + 50;
    return pos({ x: selectedObject.x, y: selectedObject.y }, r, selectedObject.angle || 0);
}
function deleteHandlePos() {
    var d = selectedObject.radius + 28;
    // Clamp inside the canvas so a hazard near the top-right edge still shows a
    // clickable ✕ (the draw + hit-test both call this, so they stay in sync).
    var m = 16;
    var x = Math.max(m, Math.min(createCanvas.width - m, selectedObject.x + d));
    var y = Math.max(m, Math.min(createCanvas.height - m, selectedObject.y - d));
    return { x: x, y: y };
}
function overRotateHandle(x, y) {
    if (selectedObject == null) { return false; }
    var p = rotateHandlePos();
    return getMagSq(x, y, p.x, p.y) < 18 * 18;
}
function overDeleteHandle(x, y) {
    if (selectedObject == null) { return false; }
    var p = deleteHandlePos();
    return getMagSq(x, y, p.x, p.y) < 18 * 18;
}
function drawHazardHandles() {
    var rp = rotateHandlePos();
    createContext.save();
    createContext.beginPath();
    createContext.arc(rp.x, rp.y, 12, 0, 2 * Math.PI);
    createContext.fillStyle = "#1e90ff";
    createContext.strokeStyle = "white";
    createContext.lineWidth = 3;
    createContext.fill();
    createContext.stroke();
    createContext.restore();

    var dp = deleteHandlePos();
    createContext.save();
    createContext.beginPath();
    createContext.arc(dp.x, dp.y, 13, 0, 2 * Math.PI);
    createContext.fillStyle = "#cf1020";
    createContext.strokeStyle = "white";
    createContext.lineWidth = 3;
    createContext.fill();
    createContext.stroke();
    createContext.beginPath();
    createContext.moveTo(dp.x - 5, dp.y - 5); createContext.lineTo(dp.x + 5, dp.y + 5);
    createContext.moveTo(dp.x + 5, dp.y - 5); createContext.lineTo(dp.x - 5, dp.y + 5);
    createContext.lineWidth = 2.5;
    createContext.strokeStyle = "white";
    createContext.stroke();
    createContext.restore();
}

// --- required-field validation + status reset --------------------------------
function setFieldError(inputId, msgId, message) {
    var input = document.getElementById(inputId);
    var msg = document.getElementById(msgId);
    if (input != null) { input.classList.add("field-required"); }
    if (msg != null) { msg.textContent = message || ""; }
}
function clearFieldErrors() {
    var fields = [["author", "authorMsg"], ["name", "nameMsg"], ["email", "emailMsg"]];
    for (var i = 0; i < fields.length; i++) {
        var input = document.getElementById(fields[i][0]);
        var msg = document.getElementById(fields[i][1]);
        if (input != null) { input.classList.remove("field-required"); }
        if (msg != null) { msg.textContent = ""; }
    }
}
// Author + name are required before export/upload (previously substituted with
// "anonymous"/"unknown" silently). Flags the empty fields and opens the Details
// panel so the feedback is visible. Returns true when both are present.
function requireDetails() {
    clearFieldErrors();
    var ok = true;
    if (($("#author").val() || "").trim() === "") { setFieldError("author", "authorMsg", "Author is required"); ok = false; }
    if (($("#name").val() || "").trim() === "") { setFieldError("name", "nameMsg", "Map name is required"); ok = false; }
    if (!ok) { openDetailsPanel(); }
    return ok;
}
var submitStatusTimer = null;
// True between clicking Upload and the server's success/failure reply — so an
// input-change reset doesn't wipe the in-flight "Submitting.." indicator.
var submitPending = false;
function showSubmitStatus(message, bg, color, holdMs) {
    submitPending = false; // a terminal status (success/failure/validation) clears pending
    var el = $("#submitStatus");
    el.text(message);
    el.css({ "color": color || "white", "background-color": bg });
    el.show();
    if (submitStatusTimer) { clearTimeout(submitStatusTimer); }
    // `holdMs != null` (not `|| 4000`) so a caller passing 0 = "hide now" isn't
    // silently bumped to the default.
    submitStatusTimer = setTimeout(function () { el.hide(); }, holdMs != null ? holdMs : 4000);
}
function resetStatuses() {
    $("#exportStatus, #previewStatus").hide();
    if (!submitPending) { // don't hide an in-flight upload
        $("#submitStatus").hide();
        if (submitStatusTimer) { clearTimeout(submitStatusTimer); submitStatusTimer = null; }
    }
    if (exportStatusTimer) { clearTimeout(exportStatusTimer); exportStatusTimer = null; }
}

function setMousePos(x, y) {
    mousex = x;
    mousey = y;
}

function paintTile(targetId) {
    if (currentCell == null) return false;
    var cell = vMap.cells[currentCell];
    if (cell == null) return false;
    var newId = (targetId != null) ? targetId : locateId(brushColor);
    if (cell.id === newId) return false;
    recordCellChange(currentCell, cell.id, newId);
    cell.id = newId;
    return true;
}

function addObjectToMap(x, y, obj) {
    var cfg = hazardConfigById(obj);
    var radius = (cfg != null) ? cfg.attackRadius : 0;
    if (outsideMapBounds(x, y, radius)) {
        return;
    }
    if (vMap.hazards == undefined) {
        vMap.hazards = [];
    }
    var hazard = { id: obj, x: x, y: y, angle: 0 };
    vMap.hazards.push(hazard);
    pushHazardAddCommand(hazard);
    dirty = true;
}

function locateObject(x, y) {
    var i = hazardIndexUnderPoint(x, y);
    if (i < 0) {
        setSelectedObject(null);
        return;
    }
    var hz = vMap.hazards[i];
    var cfg = hazardConfigById(hz.id);
    setSelectedObject({ index: i, id: hz.id, x: hz.x, y: hz.y, angle: hz.angle, radius: cfg.radius });
}

// Write the selection's live angle back to its hazard (selection tracks the array
// index, so stacked duplicates at the same x/y are no longer ambiguous).
function updateSelectedObject() {
    var i = selectedHazardIndex();
    if (i < 0 || vMap.hazards[i] == null) { return; }
    vMap.hazards[i].angle = selectedObject.angle;
}

function removeSelectedObject() {
    var i = selectedHazardIndex();
    if (i < 0 || vMap.hazards[i] == null) { return; }
    var removed = vMap.hazards[i];
    vMap.hazards.splice(i, 1);
    pushHazardRemoveCommand(removed, i);
    setSelectedObject(null);
}


function generateVMap() {
    resize();
    var localMap = null;
    var siteNum = 250;
    var sites = [];
    var margin = 0.07;
    var localbbox = { xl: map.x, xr: map.width, yt: map.y, yb: map.height };

    // Span of the cell region (map.width/height are far-corner coords), so sites
    // honor the reserved gate strip(s) on whichever edge(s) were chosen.
    var spanX = map.width - map.x,
        spanY = map.height - map.y;
    var xmargin = spanX * margin,
        ymargin = spanY * margin,
        xo = map.x + xmargin,
        dx = spanX - xmargin * 2,
        yo = map.y + ymargin,
        dy = spanY - ymargin * 2;

    for (var i = 0; i < siteNum; i++) {
        sites.push({ x: Math.round((xo + Math.random() * dx) * 10) / 10, y: Math.round((yo + Math.random() * dy) * 10) / 10 });
    }
    localMap = voronoi.compute(sites, localbbox);
    var cells = localMap.cells;
    var iCells = cells.length;
    while (iCells--) {
        cells[iCells].id = 1;
    }
    localMap.hazards = [];
    localMap.startEdges = startEdges.slice();
    return localMap;
}

function cellUnderMouse(evt) {
    var x = 0,
        y = 0;
    var rect = createCanvas.getBoundingClientRect();
    x = (((evt.pageX - rect.left) / newWidth) * createCanvas.width);
    y = (((evt.pageY - rect.top) / newHeight) * createCanvas.height);
    setMousePos(x, y);
    dirty = true;
}

// Drop the cached spatial index. Call this anywhere vMap / vMap.cells is
// (re)assigned (new map loaded, reshape, wipe, preview restore) so the next
// query rebuilds from the current geometry instead of pointing at stale cells.
function invalidateCellIndex() {
    cellIndex = null;
}

// (Re)build the uniform-grid index from the current cells. Buckets are ~one to a
// few sites each over the world bounds. Each cell's site is bucketed by its x/y.
function buildCellIndex() {
    cellIndex = null;
    if (vMap == null || !Array.isArray(vMap.cells) || vMap.cells.length === 0) { return; }
    var cells = vMap.cells;
    var minX = world.x, minY = world.y;
    // ~96px buckets give roughly 1-2 sites per bucket for the ~250-site maps,
    // keeping the per-query search to a handful of cells.
    var bucketSize = 96;
    var cols = Math.max(1, Math.ceil(world.width / bucketSize));
    var rows = Math.max(1, Math.ceil(world.height / bucketSize));
    var buckets = new Array(cols * rows);
    for (var i = 0; i < cells.length; i++) {
        var site = cells[i].site;
        if (site == null) { continue; }
        var cx = Math.floor((site.x - minX) / bucketSize);
        var cy = Math.floor((site.y - minY) / bucketSize);
        if (cx < 0) { cx = 0; } else if (cx >= cols) { cx = cols - 1; }
        if (cy < 0) { cy = 0; } else if (cy >= rows) { cy = rows - 1; }
        var b = cy * cols + cx;
        if (buckets[b] == null) { buckets[b] = []; }
        buckets[b].push(cells[i]);
    }
    cellIndex = { bucketSize: bucketSize, cols: cols, rows: rows, minX: minX, minY: minY, buckets: buckets };
}

// Test every cell whose site falls in a bucket at Chebyshev distance `ring` from
// (qx,qy) — the ring's perimeter only, since inner rings were already tested.
// Returns the voronoiId of the first cell whose exact polygon contains (x,y), or
// undefined if none on this ring do.
function testCellRing(idx, qx, qy, ring, x, y) {
    var cols = idx.cols, rows = idx.rows, buckets = idx.buckets;
    var y0 = qy - ring, y1 = qy + ring, x0 = qx - ring, x1 = qx + ring;
    for (var gy = y0; gy <= y1; gy++) {
        if (gy < 0 || gy >= rows) { continue; }
        var onYEdge = (gy === y0 || gy === y1);
        for (var gx = x0; gx <= x1; gx++) {
            if (gx < 0 || gx >= cols) { continue; }
            if (!onYEdge && gx !== x0 && gx !== x1) { continue; } // perimeter only
            var bucket = buckets[gy * cols + gx];
            if (bucket == null) { continue; }
            for (var i = 0; i < bucket.length; i++) {
                if (pointIntersection(x, y, bucket[i]) > 0) {
                    return bucket[i].site.voronoiId;
                }
            }
        }
    }
    return undefined;
}

function cellIdFromPoint(xmouse, ymouse) {
    if (vMap == null || !Array.isArray(vMap.cells)) { return; }
    if (cellIndex == null) { buildCellIndex(); }
    if (cellIndex == null) { return; }
    var idx = cellIndex;
    var qx = Math.floor((xmouse - idx.minX) / idx.bucketSize);
    var qy = Math.floor((ymouse - idx.minY) / idx.bucketSize);
    if (qx < 0) { qx = 0; } else if (qx >= idx.cols) { qx = idx.cols - 1; }
    if (qy < 0) { qy = 0; } else if (qy >= idx.rows) { qy = idx.rows - 1; }
    // Search the query bucket, then expand the ring outward. The owning cell's
    // site is almost always in the nearest bucket(s); expanding until a polygon
    // hit (or all buckets are covered) keeps the result identical to a full scan,
    // including boundary/outside points that match no cell (returns undefined).
    var maxRing = Math.max(idx.cols, idx.rows);
    for (var ring = 0; ring <= maxRing; ring++) {
        var hit = testCellRing(idx, qx, qy, ring, xmouse, ymouse);
        if (hit !== undefined) { return hit; }
    }
}
var tileIdByVid = null; // voronoiId -> tile id, for boundary-AO neighbour typing
function renderCells() {
    var cells = vMap.cells,
        iCell = cells.length,
        cell;

    tileIdByVid = buildIdByVoronoi(cells);
    while (iCell--) {
        renderCell(cells[iCell]);
    }
}
function renderHazards() {
    if (vMap.hazards == undefined) {
        return;
    }
    var hazards = vMap.hazards;
    for (var i = 0; i < hazards.length; i++) {
        var hazard = hazards[i];
        drawMyObject(hazard.x, hazard.y, hazard.id, hazard.angle);
    }
}

// Render a map to an offscreen canvas and return a JPEG data URL, for the
// load-list previews. Thumbnails are no longer stored/shipped with maps, so the
// editor regenerates them on demand from the (reconstructed) geometry. Uses the
// SAME textured tile patterns the editor canvas does (renderCell) so previews
// match the in-game look instead of the flat config colours. Rendered at world
// resolution (the load-list <img> is CSS-downscaled), cached in-session by map id
// — but only once patterns are loaded, so an early call before loadPatterns()
// falls back to flat colours without caching and re-renders textured next time.
var thumbnailCache = {};
function renderMapThumbnail(map) {
    // config arrives async (socket event) and the map-list getJSON callbacks can
    // resolve first; bail until it's here (showLoadWindow re-renders thumbnails
    // once it's loaded) rather than dereferencing config.tileMap and throwing.
    if (map == null || !Array.isArray(map.cells) || config == null) { return ""; }
    if (map.id != null && thumbnailCache[map.id] != null) { return thumbnailCache[map.id]; }
    var patternsReady = patterns[config.tileMap.normal.id] != null;
    var tileFill = function (id) {
        return (patterns[id] != null) ? patterns[id] : (locateColor(id) || '#888');
    };
    var cv = document.createElement('canvas');
    cv.width = world.width;
    cv.height = world.height;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = tileFill(config.tileMap.normal.id);
    ctx.fillRect(0, 0, cv.width, cv.height);
    var thumbIds = buildIdByVoronoi(map.cells);
    for (var i = 0; i < map.cells.length; i++) {
        var cell = map.cells[i];
        var hes = cell.halfedges;
        if (!hes || hes.length === 0) { continue; }
        ctx.beginPath();
        var v = getStartpoint(hes[0]);
        ctx.moveTo(v.x, v.y);
        for (var h = 0; h < hes.length; h++) { v = getEndpoint(hes[h]); ctx.lineTo(v.x, v.y); }
        ctx.closePath();
        ctx.fillStyle = tileFill(cell.id);
        ctx.fill();
        paintCellEdgeAO(ctx, cell, thumbIds);
    }
    // Hazards (same look as the editor canvas, via the shared per-kind painter).
    // Without this, the load-list thumbnails dropped every hazard a map authored.
    if (Array.isArray(map.hazards)) {
        for (var hi = 0; hi < map.hazards.length; hi++) {
            var hz = map.hazards[hi];
            if (hz == null) { continue; }
            var hzKind = editorHazardKindById(hz.id);
            if (hzKind == null) { continue; }
            (hzKind.paint || paintHazardShape)(ctx, hzKind, hz.x, hz.y, hz.angle || 0, "#E5392B");
        }
    }
    var url = cv.toDataURL("image/jpeg", 0.7);
    if (map.id != null && patternsReady) { thumbnailCache[map.id] = url; }
    return url;
}
function renderCell(cell) {
    if (!cell) { return; }
    // edges
    createContext.beginPath();
    var halfedges = cell.halfedges;
    var nHalfedges = halfedges.length;
    if (nHalfedges == 0) {
        return;
    }
    var v = getStartpoint(halfedges[0]);
    createContext.moveTo(v.x, v.y);
    for (var iHalfedge = 0; iHalfedge < nHalfedges; iHalfedge++) {
        v = getEndpoint(halfedges[iHalfedge]);
        createContext.lineTo(v.x, v.y);
    }
    var color = locateColor(cell.id);
    if (patterns[cell.id] != null) {
        color = patterns[cell.id];
    }


    if (cell.site.voronoiId == currentCell) {
        createContext.fillStyle = brushColor;
    } else {
        createContext.fillStyle = color;
    }

    createContext.strokeStyle = '#adadad';
    createContext.fill();
    createContext.stroke();
    // Match the in-game board's depth: shadow only at terrain transitions.
    if (tileIdByVid) { paintCellEdgeAO(createContext, cell, tileIdByVid); }
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
// Transient feedback for the Export button. A native alert() steals focus and a
// gamepad can't dismiss it, so write to the inline #exportStatus readout instead
// (mirrors the #submitStatus pattern) and auto-hide after a moment.
var exportStatusTimer = null;
function showExportStatus(message, bg) {
    var el = $("#exportStatus");
    el.text(message); // same write pattern as #submitStatus (the span is just a placeholder)
    el.css({ "color": "white", "background-color": bg });
    el.show();
    if (exportStatusTimer) {
        clearTimeout(exportStatusTimer);
    }
    exportStatusTimer = setTimeout(function () { el.hide(); }, 2500);
}
function exportToJSON() {
    if (!requireDetails()) {
        showExportStatus("Add an author and map name first", "red");
        return;
    }
    basicSanitize();
    navigator.clipboard.writeText(JSON.stringify(vMap)).then(function () {
        showExportStatus("Copied to clipboard!", "green");
    }, function (err) {
        console.log(err);
        showExportStatus("Copy failed — try again", "red");
    });
}

function submitViaEmail() {
    basicSanitize();
    var mailLink = "mailto:" + config.submitViaMail + "?subject=New map submission - " + vMap.name + " : " + vMap.author + "&body=" + JSON.stringify(vMap);
    window.open(mailLink, '_blank');
}

function submitToGithub() {
    // Re-entry guard: a check or publish is already mid-flight (incl. the
    // throttle-deferred fresh check below) — a second click must not stack a
    // second request or double-submit.
    if (submitPending) { return false; }
    if (!requireDetails()) {
        showSubmitStatus("Add an author and map name first", "red", "white");
        return false;
    }
    var email = $("#email").val();
    if (!validateEmail(email)) {
        // Inline feedback instead of a focus-stealing alert() the gamepad can't close.
        setFieldError("email", "emailMsg", "Enter a valid email");
        openDetailsPanel();
        showSubmitStatus("Enter a valid email to submit", "red", "white");
        $("#email").focus();
        return false;
    }
    basicSanitize();
    vMap.email = email;
    // Pre-submit balance check: ask the server to classify the map (read-only) so we
    // can show a soft "looks unbalanced" nudge before publishing. The actual submit
    // happens in performSubmit(), called from the mapScore reply (or its fallback).
    // Set the indicator directly (not showSubmitStatus, which clears submitPending and
    // auto-hides) so the pending guard survives until the reply.
    var submitStatus = $("#submitStatus");
    if (submitStatusTimer) { clearTimeout(submitStatusTimer); submitStatusTimer = null; }
    submitStatus.show();
    submitStatus.css("color", "black");
    submitStatus.css("background-color", "#ADD8E6");
    submitStatus.text("Checking balance..");
    submitPending = true; // protect the indicator from input-change resets until the reply
    var sig = JSON.stringify(vMap);
    // A Fairness check for THIS exact map is in flight: re-route its reply to the
    // submit flow rather than firing a second (throttled) request. If the map
    // changed since that check, its reply is stale — fall through to a fresh one.
    if (fairnessCheckPending && pendingScoreSig === sig) {
        fairnessCheckPending = false;
        return false;
    }
    // A fresh verdict for THIS exact map is already in hand (e.g. the Fairness
    // reply the author is looking at): decide from it directly. The sig guard is
    // what stops a since-edited map from reusing the previous map's verdict.
    if (lastMapScoreVerdict != null && lastMapScoreVerdict.sig === sig &&
        Date.now() - lastMapScoreVerdict.at < 2500) {
        handleSubmitVerdict(lastMapScoreVerdict.payload);
        return false;
    }
    // Otherwise run a fresh, map-matched check. Abandon any stale in-flight
    // Fairness reply (different map), and stay clear of the server's 2s throttle:
    // if we emitted a scoreMap < ~2s ago, delay until the window clears so the
    // reply is a real verdict rather than a throttle error that would auto-submit
    // past the nudge (Codex review P2).
    fairnessCheckPending = false;
    clearBalanceOverlay(); // a fresh check replaces any stale overlay
    // Server throttle is 2s from its last ACCEPTED request; lastScoreEmitAt is the
    // client emit (≈ receive time minus network latency), so wait a touch past 2s
    // to clear it even on a slow link.
    var wait = 2300 - (Date.now() - lastScoreEmitAt);
    if (wait > 0) {
        // Re-serialize at fire time: if the author edited during the wait, score the
        // map they actually have now (so the reply correlates and never hangs).
        setTimeout(function () { if (submitPending) { emitScoreMap(JSON.stringify(vMap)); } }, wait);
    } else {
        emitScoreMap(sig);
    }
    return false;
}

// Act on a balance verdict for the submit flow: featured (or unavailable) maps
// publish straight through; anything else draws the overlay and asks "Submit
// anyway?". Called from the mapScore reply and from submitToGithub's
// reuse-a-fresh-verdict path.
function handleSubmitVerdict(payload) {
    if (payload == null || payload.error || payload.tier === "featured") {
        performSubmit();
        return;
    }
    var reasons = [];
    if (Array.isArray(payload.hardFail) && payload.hardFail.length) { reasons = payload.hardFail.slice(); }
    else if (Array.isArray(payload.deductions)) { reasons = payload.deductions.slice(); }
    var why = reasons.length ? (" — " + reasons.slice(0, 3).join(", ")) : "";
    // Stash the overlay geometry (per-edge routes + goal) so drawEditor can
    // SHOW the problem on the map itself; it persists after Cancel so the
    // author can paint fixes against it.
    applyBalanceOverlay(payload);
    var msg = "This map scored " + payload.balanceScore + "/100" + why +
        ", so it won't make the Featured playlist. It'll still be playable in the themed/Wild lists." +
        (payload.debug != null ? " The routes behind this check are now drawn on the map (" + balanceHideHint("hides them") + ")." : "") +
        " Submit anyway?";
    submitPending = false;
    showSubmitStatus("Map looks unbalanced — confirm to submit", "#8a6d00", "white");
    openWipeConfirm(msg, function () { performSubmit(); }, "Submit anyway");
}

// The real publish step — opens the PR via the server's submitNewMap handler.
// Reached only after the balance check (auto for a good map, or on "Submit anyway").
function performSubmit() {
    clearBalanceOverlay(); // they chose to submit anyway — the nudge is moot
    submitPending = true;
    // Pending state stays put until githubSuccess/githubFailure replaces it (those
    // use the auto-resetting showSubmitStatus); don't auto-hide the "Submitting.."
    var submitStatus = $("#submitStatus");
    if (submitStatusTimer) { clearTimeout(submitStatusTimer); submitStatusTimer = null; }
    submitStatus.show();
    submitStatus.css("color", "black");
    submitStatus.css("background-color", "#ADD8E6");
    submitStatus.text("Submitting..");
    server.emit('submitNewMap', JSON.stringify(vMap));
}
// Mirror of server/utils.js validateMap — gives fast inline feedback in the
// editor; the server re-runs it as the trust boundary. Returns { valid, reason }.
function validateMap(map) {
    if (map == null) {
        return { valid: false, reason: "No map data." };
    }
    if (!Array.isArray(map.cells) || map.cells.length === 0) {
        return { valid: false, reason: "Map has no cells." };
    }
    var hasGoal = false;
    for (var i = 0; i < map.cells.length; i++) {
        var cell = map.cells[i];
        if (cell == null || cell.site == null) {
            return { valid: false, reason: "Map has a malformed cell." };
        }
        if (typeof cell.site.x !== "number" || typeof cell.site.y !== "number") {
            return { valid: false, reason: "Map has a cell with an invalid position." };
        }
        if (!Array.isArray(cell.halfedges)) {
            return { valid: false, reason: "Map has a cell with no geometry." };
        }
        if (typeof cell.id !== "number") {
            return { valid: false, reason: "Map has a cell with an invalid tile." };
        }
        if (cell.id === config.tileMap.goal.id) {
            hasGoal = true;
        }
    }
    if (!hasGoal) {
        return { valid: false, reason: "Add a goal tile before previewing." };
    }
    if (map.hazards != null) {
        if (!Array.isArray(map.hazards)) {
            return { valid: false, reason: "Map has malformed hazards." };
        }
        for (var h = 0; h < map.hazards.length; h++) {
            var hazard = map.hazards[h];
            if (hazard == null || hazard.id == null ||
                typeof hazard.x !== "number" || typeof hazard.y !== "number") {
                return { valid: false, reason: "Map has a malformed hazard." };
            }
            // Directional kinds (railed bumpers, bumper walls) extend along an
            // angle; without a numeric angle the rail/segment math goes NaN.
            // (Server mirror: utils.validateMap, driven by the hazard-kind
            // registry.)
            var hzKind = editorHazardKindById(hazard.id);
            if (hzKind != null && hzKind.directional &&
                typeof hazard.angle !== "number") {
                return { valid: false, reason: "Map has a directional hazard with no direction." };
            }
        }
    }
    if (map.startEdges != null) {
        var startEdgeCheck = validateStartEdges(map.startEdges);
        if (!startEdgeCheck.valid) {
            return startEdgeCheck;
        }
    }
    return { valid: true };
}
// Mirror of server/utils.js validateStartEdges — one edge, or an opposite pair.
function validateStartEdges(startEdges) {
    var OPPOSITE = { left: "right", right: "left", top: "bottom", bottom: "top" };
    if (!Array.isArray(startEdges) || startEdges.length < 1 || startEdges.length > 2) {
        return { valid: false, reason: "startEdges must list 1 or 2 edges." };
    }
    for (var i = 0; i < startEdges.length; i++) {
        if (OPPOSITE[startEdges[i]] == null) {
            return { valid: false, reason: "startEdges has an unknown edge." };
        }
    }
    if (startEdges.length === 2) {
        if (startEdges[0] === startEdges[1]) {
            return { valid: false, reason: "startEdges can't repeat the same edge." };
        }
        if (OPPOSITE[startEdges[0]] !== startEdges[1]) {
            return { valid: false, reason: "Two start edges must be opposite (left+right or top+bottom)." };
        }
    }
    return { valid: true };
}

function showPreviewError(message) {
    var status = $("#previewStatus");
    status.css("color", "white");
    status.css("background-color", "red");
    status.find("span").text(message);
    status.show();
}

function previewMap() {
    // Ignore re-clicks while a launch is in flight: basicSanitize() mints a
    // fresh id each call, so a double-click would create two rooms whose map
    // ids no longer match what's stashed/navigated to.
    if (previewPending) {
        return;
    }
    // config arrives async (the editor can be shown before it lands, e.g. on
    // the return-from-preview restore). validateMap needs it.
    if (config == null) {
        showPreviewError("Still loading — try again in a moment.");
        return;
    }
    // basicSanitize() fills id/author/name/thumbnail. Prefix the id so the
    // unsaved map can't collide with a real one in the client's maps[] lookup.
    basicSanitize();
    vMap.id = "preview-" + vMap.id;
    var result = validateMap(vMap);
    if (!result.valid) {
        showPreviewError(result.reason);
        return;
    }
    $("#previewStatus").hide();
    previewPending = true;
    $("#previewButton").prop("disabled", true);
    // Stash for the editor to rehydrate on the round-trip back, and for the
    // play page to inject into its maps[] before enterGame. Same serialized
    // object goes to the server so both sides resolve the same id.
    var json = JSON.stringify(vMap);
    sessionStorage.setItem('previewMap', json);
    // Default off: preview a bot-free solo run unless the editor toggled it on.
    // sessionStorage.previewMap stays the raw map (the play page reads it from
    // there); only the socket payload carries the { map, enableAI } wrapper.
    var enableAI = $("#enableAIButton").attr("aria-pressed") === "true";
    // Pin the author's spawn gate when one is picked (and still valid for the
    // map's current edges); null lets the server place normally.
    var startEdge = (previewStartEdge !== "auto" && startEdges.indexOf(previewStartEdge) !== -1)
        ? previewStartEdge : null;
    server.emit('createPreviewRoom', JSON.stringify({ map: vMap, enableAI: enableAI, startEdge: startEdge }));
}

// Reflect the "AI racers" toggle state onto its button (pressed attr for
// assistive tech + gamepad, .ai-on for the green fill, icon + label) and
// persist it. Driven on load (restore) and on every click.
function setPreviewAI(on) {
    var btn = document.getElementById("enableAIButton");
    if (btn == null) {
        return;
    }
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("ai-on", on);
    var icon = btn.querySelector("i");
    if (icon != null) {
        icon.className = "fa " + (on ? "fa-check-square" : "fa-square-o");
    }
    var label = btn.querySelector("span");
    if (label != null) {
        label.textContent = on ? "AI racers: on" : "AI racers: off";
    }
    try { localStorage.setItem("previewEnableAI", on ? "true" : "false"); } catch (e) { }
}

// Apply + persist the preview start-gate pick, then refresh its button.
function setPreviewGate(value) {
    previewStartEdge = value || "auto";
    try { localStorage.setItem("previewStartEdge", previewStartEdge); } catch (e) { }
    updatePreviewGateButton();
}
// Keep the pick valid for the map's current edges (a stale pick falls back to
// auto) and only show the button when there's actually a choice (2 gates).
function updatePreviewGateButton() {
    var btn = document.getElementById("previewGateButton");
    if (btn == null) { return; }
    if (previewStartEdge !== "auto" && startEdges.indexOf(previewStartEdge) === -1) {
        previewStartEdge = "auto";
        try { localStorage.setItem("previewStartEdge", "auto"); } catch (e) { }
    }
    btn.style.display = (startEdges.length > 1) ? "" : "none";
    var label = btn.querySelector("span");
    if (label != null) {
        label.textContent = "Start: " + (previewStartEdge === "auto" ? "Auto"
            : previewStartEdge.charAt(0).toUpperCase() + previewStartEdge.slice(1));
    }
}

function basicSanitize() {
    var author = $("#author").val();
    if (author == "") {
        author = "anonymous";
    }
    var name = $("#name").val();
    if (name == "") {
        name = "unknown";
    }
    selectedObject = null;
    drawEditor(null);
    // No thumbnail is stored or shipped with maps anymore — the editor's load-list
    // regenerates previews on demand (renderMapThumbnail).
    vMap.id = makeid(32);
    vMap.author = author.substring(0, 15);
    vMap.name = name.substring(0, 15);
}

// Escape HTML-significant chars before interpolating untrusted text (map name /
// author) into innerHTML, for both attribute and element-content contexts.
function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function makeid(length) {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() *
            charactersLength));
    }
    return result;
}

function locateColor(id) {
    for (var type in config.tileMap) {
        if (id == config.tileMap[type].id) {
            return config.tileMap[type].color;
        }
    }
}
function locateId(color) {
    for (var type in config.tileMap) {
        if (color == config.tileMap[type].color || color == patterns[config.tileMap[type].id]) {
            return config.tileMap[type].id;
        }
    }
}

function drawSelectedObject() {
    if (selectedObject != null) {
        if (selectedObject.angle == undefined) {
            selectedObject.angle = 0;
        }

        createContext.save();
        createContext.beginPath();
        createContext.arc(selectedObject.x, selectedObject.y, selectedObject.radius + 10, 0, 2 * Math.PI);
        createContext.lineWidth = 5;
        createContext.setLineDash([5, 10]);
        createContext.strokeStyle = "lime";
        createContext.stroke();
        createContext.restore();

        createContext.save();
        createContext.beginPath();
        createContext.arc(selectedObject.x, selectedObject.y, selectedObject.radius + 15, 0, 2 * Math.PI);
        createContext.lineWidth = 2;
        createContext.setLineDash([5, 10]);
        createContext.strokeStyle = "black";
        createContext.stroke();
        createContext.restore();
        drawRotationRing();
        drawHazardHandles();
    }
}

function drawRotationRing() {
    var loc = pos({ x: selectedObject.x, y: selectedObject.y }, 60, selectedObject.angle);
    createContext.save();
    createContext.beginPath();
    createContext.moveTo(selectedObject.x, selectedObject.y);
    createContext.lineTo(loc.x, loc.y);
    createContext.lineWidth = 3;
    createContext.strokeStyle = "blue";
    createContext.stroke();
    createContext.restore();

    createContext.save();
    createContext.beginPath();
    createContext.arc(selectedObject.x, selectedObject.y, selectedObject.radius + 50, 0, 2 * Math.PI);
    createContext.lineWidth = 5;
    createContext.setLineDash([5, 10]);
    createContext.strokeStyle = "blue";
    createContext.stroke();
    createContext.restore();
}

function drawPointerCircle() {
    if (drawBrushAimer) {
        createContext.save();
        createContext.beginPath();
        createContext.arc(mousex, mousey, 5, 0, 2 * Math.PI);
        createContext.fillStyle = brushColor;
        createContext.strokeStyle = "black";
        createContext.fill();
        createContext.stroke();
        createContext.restore();
    }
}

function outsideMapBounds(x, y, radius) {
    if (x - radius < map.x || x + radius > map.width || y - radius < map.y || y + radius > map.height) {
        return true;
    }
    return false;
}

function pointIntersection(x, y, cell) {
    {
        var halfedges = cell.halfedges,
            iHalfedge = halfedges.length,
            halfedge,
            p0, p1, r;
        while (iHalfedge--) {
            halfedge = halfedges[iHalfedge];
            p0 = getStartpoint(halfedge);
            p1 = getEndpoint(halfedge);
            r = (y - p0.y) * (p1.x - p0.x) - (x - p0.x) * (p1.y - p0.y);
            if (!r) {
                return 0;
            }
            if (r > 0) {
                return -1;
            }
        }
        return 1;
    };
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
        // we dont need to take into account end point,
        // since each end point matches a start point
    }
    return {
        x: xmin,
        y: ymin,
        width: xmax - xmin,
        height: ymax - ymin
    };
}