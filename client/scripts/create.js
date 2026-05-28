var server,
    maps = [],
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
            syncStartEdgesFromMap();
            $('#author').val(vMap.author);
            $('#name').val(vMap.name);
            setSelectedObject(null);
            clearHistory();
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
                $("#loadWindow").append('<div class="map-image" data-search="' + nm + ' ' + au + '"><button id="' + loaded.id + '" data-gp-nav><img src="' + renderMapThumbnail(loaded) + '"><div class="desc">' + nm + ' | ' + au + '</div></button></div>');
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
            });
        }
    });
    return server;
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
    patterns[config.tileMap.random.id] = makePattern(random, config.tileMap.random.color);
    patterns[config.tileMap.ability.id] = makePattern(bombIcon, makeSeamlessPattern(gradedTex.dirt));

    brushColor = patterns[config.tileMap.normal.id];
}
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
// A hazard swatch draws the in-game look (orange disc + red attack ring; the
// moving bumper adds its black rail) over a dirt ground — like a bumper sitting on
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
    if (kind === "movingBumper") {
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(16, cy);
        ctx.lineTo(size - 16, cy);
        ctx.stroke();
    }
    ctx.strokeStyle = "red";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = "orange";
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
    var hazards = [["bumperButton", "bumper"], ["movingBumperButton", "movingBumper"]];
    for (var h = 0; h < hazards.length; h++) {
        var hb = document.getElementById(hazards[h][0]);
        if (hb == null) { continue; }
        hb.classList.add("swatch");
        hb.style.backgroundImage = "url(" + buildHazardSwatchDataURL(hazards[h][1]) + ")";
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
    // Escape cancels (keyboard parity with the native confirm it replaced).
    $(document).on("keydown", function (e) {
        if ((e.key === "Escape" || e.keyCode === 27) && $("#wipeConfirmModal").is(":visible")) {
            closeWipeConfirm();
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
    $("#abilityTileButton").on("click", function () { editorSelectTile("ability"); return false; });
    $("#randomTileButton").on("click", function () { editorSelectTile("random"); return false; });
    $("#goalTileButton").on("click", function () { editorSelectTile("goal"); return false; });
    $("#emptyTileButton").on("click", function () { editorSelectTile("empty"); return false; });
    $(".startEdgeButton").on("click", function () {
        var edges = ($(this).attr("data-edges") || "left").split("+");
        setStartEdges(edges);
        return false;
    });
    $("#bumperButton").on("click", function () { editorSelectHazard("bumper"); return false; });
    $("#movingBumperButton").on("click", function () { editorSelectHazard("movingBumper"); return false; });
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
function openWipeConfirm(message, onConfirm, confirmLabel) {
    // Re-entrancy guard: if a confirm is already pending, don't clobber its action.
    if (!$("#wipeConfirmModal").hasClass("hidden")) { return; }
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
    setSelectedObject(null);
    vMap = generateVMap();
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
    recomputeStartLayout();
    // Regenerate the playable cells in the new (gate-reserving) region so the
    // surface reshapes instead of overlapping the relocated gate.
    if (mapReady && vMap != null) {
        setSelectedObject(null);
        vMap = generateVMap();
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
function drawMyObject(x, y, myObject, angle) {
    if (angle == null) {
        angle = 0;
    }
    if (myObject == config.hazards.bumper.id) {
        drawBumper(x, y);
        return;
    }
    if (myObject == config.hazards.movingBumper.id) {
        drawMovingBumper(x, y, angle);
        return;
    }
}
function drawBumper(x, y) {
    createContext.save();
    createContext.beginPath();
    createContext.strokeStyle = "red";
    createContext.lineWidth = 3;
    createContext.arc(x, y, config.hazards.bumper.attackRadius, 0, 2 * Math.PI);
    createContext.stroke();
    createContext.beginPath();
    createContext.arc(x, y, config.hazards.bumper.radius, 0, 2 * Math.PI);
    createContext.fillStyle = config.hazards.bumper.color;
    createContext.fill();
    createContext.restore();
}
function drawMovingBumper(x, y, angle) {
    createContext.save();
    createContext.beginPath();
    createContext.translate(x, y);
    createContext.rotate(angle * (Math.PI / 180));
    createContext.rect(0, -config.hazards.movingBumper.height / 2, config.hazards.movingBumper.width, config.hazards.movingBumper.height);
    createContext.fillStyle = "black";
    createContext.fill();
    createContext.restore();

    createContext.save();
    createContext.beginPath();
    createContext.strokeStyle = "red";
    createContext.lineWidth = 3;
    createContext.arc(x, y, config.hazards.movingBumper.attackRadius, 0, 2 * Math.PI);
    createContext.stroke();
    createContext.beginPath();
    createContext.arc(x, y, config.hazards.movingBumper.radius, 0, 2 * Math.PI);
    createContext.fillStyle = config.hazards.movingBumper.color;
    createContext.fill();

    createContext.restore();
}
function handleClick(event) {
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
    var h = config.hazards[typeName];
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
    "abilityTileButton", "randomTileButton", "goalTileButton", "emptyTileButton",
    "bumperButton", "movingBumperButton"];
function updateToolButtons() {
    for (var i = 0; i < TOOL_BUTTON_IDS.length; i++) {
        var el = document.getElementById(TOOL_BUTTON_IDS[i]);
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
            lava: "lavaTileButton", ice: "iceTileButton", ability: "abilityTileButton",
            random: "randomTileButton", goal: "goalTileButton", empty: "emptyTileButton"
        };
        return tileMap[activeTool.name] || null;
    }
    if (activeTool.kind === "hazard") {
        return activeTool.name === "movingBumper" ? "movingBumperButton" : "bumperButton";
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

// --- hazard helpers (index/reference based — also fixes the stacked-duplicate
//     selection bug, since selection now tracks the array index, not x/y) -------
function hazardConfigById(id) {
    for (var type in config.hazards) {
        if (config.hazards[type].id == id) { return config.hazards[type]; }
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
        if (getMagSq(x, y, hazards[i].x, hazards[i].y) < Math.pow(cfg.radius, 2)) { return i; }
    }
    return -1;
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

function cellIdFromPoint(xmouse, ymouse) {
    var cells = vMap.cells;
    var iCell = cells.length;
    while (iCell--) {
        var cell = cells[iCell];
        if (pointIntersection(xmouse, ymouse, cell) > 0) {
            return cells[iCell].site.voronoiId;
        }
    }
}
function renderCells() {
    var cells = vMap.cells,
        iCell = cells.length,
        cell;

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
    }
    // Hazards (same look as the editor canvas: orange disc + red attack ring,
    // plus a black rail bar for moving bumpers). Without this, the load-list
    // thumbnails dropped every bumper a map authored.
    if (Array.isArray(map.hazards)) {
        for (var hi = 0; hi < map.hazards.length; hi++) {
            var hz = map.hazards[hi];
            if (hz == null) { continue; }
            if (hz.id === config.hazards.movingBumper.id) {
                ctx.save();
                ctx.translate(hz.x, hz.y);
                ctx.rotate((hz.angle || 0) * Math.PI / 180);
                ctx.fillStyle = "black";
                ctx.fillRect(0, -config.hazards.movingBumper.height / 2,
                    config.hazards.movingBumper.width, config.hazards.movingBumper.height);
                ctx.restore();
            }
            ctx.beginPath();
            ctx.arc(hz.x, hz.y, config.hazards.bumper.attackRadius, 0, 2 * Math.PI);
            ctx.strokeStyle = "#E5392B";
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(hz.x, hz.y, config.hazards.bumper.radius, 0, 2 * Math.PI);
            ctx.fillStyle = config.hazards.bumper.color;
            ctx.fill();
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
    // Pending state stays put until githubSuccess/githubFailure replaces it (those
    // use the auto-resetting showSubmitStatus); don't auto-hide the "Submitting.."
    var submitStatus = $("#submitStatus");
    if (submitStatusTimer) { clearTimeout(submitStatusTimer); submitStatusTimer = null; }
    submitStatus.show();
    submitStatus.css("color", "black");
    submitStatus.css("background-color", "#ADD8E6");
    submitStatus.text("Submitting..");
    submitPending = true; // protect this indicator from input-change resets until the reply
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
            // A moving bumper rides a rail at a given angle; without a numeric
            // angle the engine's rail math goes NaN.
            if (hazard.id === config.hazards.movingBumper.id &&
                typeof hazard.angle !== "number") {
                return { valid: false, reason: "Map has a moving bumper with no direction." };
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
    server.emit('createPreviewRoom', JSON.stringify({ map: vMap, enableAI: enableAI }));
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