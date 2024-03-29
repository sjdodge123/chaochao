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
    newWidth = 0,
    newHeight = 0,
    world = { x: 0, y: 0, width: 1366, height: 768 },
    gate = { x: 0, y: 0, width: 75, height: world.height },
    map = { x: 75, y: 0, width: world.width, height: world.height },
    canvasWindow = document.getElementById("canvasWindow"),
    createContext;

var scale = 0.035;
//TileTextures
var lava = new Image(256, 256);
lava.src = "../assets/img/lava.png";
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
var random = new Image(576, 512);
random.src = "../assets/img/question-solid.svg";
var bombIcon = new Image(576, 512);
bombIcon.src = "../assets/img/bomb.svg";

var then = Date.now(),
    dt;

window.onload = function () {
    server = clientConnect();
    server.emit("getMaps");
    server.emit("getConfig");
    setupPage();
    rebuild();
    $('#loadWindow').show();
    $('#createWindow').hide();
}

function clientConnect() {
    var server = io();

    server.on("config", function (c) {
        config = c;
        gameRunning = true;
        loadPatterns();
        init();
    });

    server.on('githubFailure', function (error) {
        var submitStatus = $("#submitStatus");
        submitStatus.css("color", "white");
        submitStatus.css("background-color", "red");
        console.log(error);
        submitStatus.text("Failed");
    });
    server.on('githubSuccess', function (url) {
        console.log(url);
        var submitStatus = $("#submitStatus");
        submitStatus.css("color", "white");
        submitStatus.css("background-color", "green");
        submitStatus.text("Sucesss");
    });

    server.on("maplisting", function (mapnames) {
        if (maps.length > 0) {
            return;
        }
        for (var i = 0; i < mapnames.length; i++) {
            $.getJSON("../maps/" + mapnames[i], function (data) {
                maps.push(data);
                $("#loadWindow").append('<div class="map-image"><button id="' + data.id + '"><img src="' + data.thumbnail + '"><div class="desc">' + data.name + ' | ' + data.author + '</div></button></div>');
                $("#" + data.id).on("click", function () {
                    for (var j = 0; j < maps.length; j++) {
                        if (maps[j].id == this.id) {
                            vMap = JSON.parse(JSON.stringify(maps[j]));
                            $('#author').val(vMap.author);
                            $('#name').val(vMap.name);
                            $('#loadWindow').hide();
                            $('#createWindow').show();
                            resize();
                            addListeners();
                            return;
                        }
                    }
                })
            });
        }
    });
    return server;
}

function loadPatterns() {

    //Tiles
    patterns[config.tileMap.lava.id] = makeSeamlessPattern(lava);
    patterns[config.tileMap.ice.id] = makeSeamlessPattern(ice);
    patterns[config.tileMap.fast.id] = makeSeamlessPattern(grass);
    patterns[config.tileMap.normal.id] = makeSeamlessPattern(dirt);
    patterns[config.tileMap.slow.id] = makeSeamlessPattern(sand);
    patterns[config.tileMap.random.id] = makePattern(random, config.tileMap.random.color);
    patterns[config.tileMap.ability.id] = makePattern(bombIcon, makeSeamlessPattern(dirt));

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


function setupPage() {
    $("#createNew").on("click", function () {
        $("#submitStatus").hide();
        $('#loadWindow').hide();
        $('#createWindow').show();
        resize();
        addListeners();
    });
    $("#rebuildButton").on("click", function () {
        if (validateWithUser()) {
            rebuild();
        };
        return false;
    });

    $("#rotateButton").on("click", function () {
        drawObject = null;
        drawBrushAimer = false;
        if (selectedObject != null) {
            selectedObject.angle += 15;
            updateSelectedObject();
        }
        return false;
    });

    $("#mouseButton").on("click", function () {
        drawBrushAimer = false;
        drawObject = null;
        return false;
    });

    $("#slowTileButton").on("click", function () {
        brushID = config.tileMap.slow.id;
        brushColor = patterns[config.tileMap.slow.id];
        drawBrushAimer = true;
        drawObject = null;
        return false;
    });
    $("#normalTileButton").on("click", function () {
        brushID = config.tileMap.normal.id;
        brushColor = patterns[config.tileMap.normal.id];
        drawBrushAimer = true;
        drawObject = null;
        return false;
    });
    $("#fastTileButton").on("click", function () {
        brushID = config.tileMap.fast.id;
        brushColor = patterns[config.tileMap.fast.id];
        drawBrushAimer = true;
        drawObject = null;
        return false;
    });
    $("#lavaTileButton").on("click", function () {
        brushID = config.tileMap.lava.id;
        brushColor = patterns[config.tileMap.lava.id];
        drawBrushAimer = true;
        drawObject = null;
        return false;
    });
    $("#iceTileButton").on("click", function () {
        brushID = config.tileMap.ice.id;
        brushColor = patterns[config.tileMap.ice.id];
        drawBrushAimer = true;
        drawObject = null;
        return false;
    });
    $("#abilityTileButton").on("click", function () {
        brushID = config.tileMap.ability.id;
        brushColor = patterns[config.tileMap.ability.id];
        drawBrushAimer = true;
        drawObject = null;
        return false;
    });
    $("#randomTileButton").on("click", function () {
        brushID = config.tileMap.random.id;
        brushColor = patterns[config.tileMap.random.id];
        drawBrushAimer = true;
        drawObject = null;
        return false;
    });
    $("#goalTileButton").on("click", function () {
        brushID = config.tileMap.goal.id;
        brushColor = config.tileMap.goal.color;
        drawBrushAimer = true;
        drawObject = null;
        return false;
    });
    $("#bumperButton").on("click", function () {
        drawBrushAimer = false;
        drawObject = null;
        drawObject = config.hazards.bumper.id;
        return false;
    });
    $("#movingBumperButton").on("click", function () {
        drawBrushAimer = false;
        drawObject = null;
        drawObject = config.hazards.movingBumper.id;
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
        selectedObject = null;
        $("#createNewImage").attr("src", createCanvas.toDataURL("image/jpeg", 0.1));
        $('#createWindow').hide();
        $('#loadWindow').show();
        $("#submitStatus").hide();

        window.removeEventListener("mousemove", cellUnderMouse, false);
        window.removeEventListener("mousedown", handleClick, false);
        window.removeEventListener("mouseup", handleUnClick, false);
        window.removeEventListener('contextmenu', function (ev) {
            return false;
        }, false);
        return false;
    });
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
    window.addEventListener('contextmenu', function (ev) {
        return false;
    }, false);
}

function validateEmail(mail) {
    if (/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(mail)) {
        return (true)
    }
    return (false)
}

function validateWithUser() {

    if (selectedObject != null) {
        removeSelectedObject();
        return;
    }

    var cells = vMap.cells;
    var prompt = false;
    for (var i = 0; i < cells.length; i++) {
        if (cells[i].id != config.tileMap.normal.id) {
            prompt = true;
            break;
        }
    }
    if (prompt == false && vMap.hazards.length > 0) {
        prompt = true;
    }
    if (prompt) {
        return confirm("Are you sure you want to delete this map?");
    }
    return true;
}

function rebuild() {
    $("#submitStatus").hide();
    vMap = generateVMap();
    $('#author').val("");
    $('#name').val("");
    $("#createNewImage").attr("src", createCanvas.toDataURL("image/jpeg", 0.1));
    resize();
}

function init() {
    animloop();
}

function animloop() {
    if (gameRunning) {
        var now = Date.now();
        dt = now - then;
        gameLoop(dt);
        then = now;
        requestAnimFrame(animloop);
    }
}
function gameLoop(dt) {
    if (drawBrushAimer) {
        currentCell = cellIdFromPoint(mousex, mousey);
    }
    drawEditor(dt);
    if (mapReady == false) {
        mapReady = true;
        rebuild();
    }
    if (brushing) {
        paintTile();
    }
}

function resize() {
    var rect = canvasWindow.getBoundingClientRect();
    var viewport = { width: rect.width, height: rect.height };
    var scaleToFitX = viewport.width / createCanvas.width;
    var scaleToFitY = viewport.height / createCanvas.height;
    var currentScreenRatio = viewport.width / viewport.height;
    var optimalRatio = Math.min(scaleToFitX, scaleToFitY);


    /*
    if (currentScreenRatio >= 1.77 && currentScreenRatio <= 1.79) {
        newWidth = viewport.width ;
        newHeight = viewport.height;
    } else {
        */
    newWidth = createCanvas.width * optimalRatio / 1.2;
    newHeight = createCanvas.height * optimalRatio / 1.2;
    // }
    var controlPanel = document.getElementById("controlPanel");
    controlPanel.style.height = newHeight + "px";
    createCanvas.style.width = newWidth + "px";
    createCanvas.style.height = newHeight + "px";
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
function drawGate() {
    if (gate != null) {
        createContext.save();
        createContext.beginPath();
        createContext.lineWidth = 5;
        createContext.rect(gate.x, gate.y, gate.width, gate.height);
        createContext.fillStyle = "grey";
        createContext.fill();
        createContext.restore();
    }
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
            if (drawBrushAimer) {
                brushing = true;
                break;
            }
            if (drawObject != null) {
                addObjectToMap(mousex, mousey, drawObject);
                break;
            }
            locateObject(mousex, mousey);
        }
    }
}
function handleUnClick(event) {
    switch (event.which) {
        case 1: {
            if (drawBrushAimer) {
                brushing = false;
                break;
            }
        }
    }
}

function setMousePos(x, y) {
    mousex = x;
    mousey = y;
}

function paintTile() {
    var newId = locateId(brushColor);
    var cells = vMap.cells;
    for (var i = 0; i < cells.length; i++) {
        if (currentCell == cells[i].site.voronoiId) {
            cells[i].id = newId;
        }
    }
}

function addObjectToMap(x, y, obj) {
    var radius = 0;
    for (var hazard in config.hazards) {
        if (obj == config.hazards[hazard].id) {
            radius = config.hazards[hazard].attackRadius;
        }
    }
    if (outsideMapBounds(x, y, radius)) {
        return;
    }
    if (vMap.hazards == undefined) {
        vMap.hazards = [];
    }
    vMap.hazards.push({ id: drawObject, x: x, y: y, angle: 0 });
}

function locateObject(x, y) {
    if (outsideMapBounds(x, y, 0)) {
        return;
    }
    for (var hazard in vMap.hazards) {
        var hazardObj = null;
        for (var type in config.hazards) {
            if (vMap.hazards[hazard].id == config.hazards[type].id) {
                hazardObj = config.hazards[type];
                break;
            }
        }
        var distance = getMagSq(x, y, vMap.hazards[hazard].x, vMap.hazards[hazard].y);
        if (distance < Math.pow(hazardObj.radius, 2)) {
            selectedObject = { id: vMap.hazards[hazard].id, x: vMap.hazards[hazard].x, y: vMap.hazards[hazard].y, angle: vMap.hazards[hazard].angle, radius: hazardObj.radius };
            return;
        }
    }
    selectedObject = null;
}

function updateSelectedObject() {
    for (var i = 0; i < vMap.hazards.length; i++) {
        if (vMap.hazards[i].id == selectedObject.id) {
            if (vMap.hazards[i].x == selectedObject.x && vMap.hazards[i].y == selectedObject.y) {
                vMap.hazards[i].angle = selectedObject.angle;
                return;
            }
        }
    }
}

function removeSelectedObject() {
    for (var i = 0; i < vMap.hazards.length; i++) {
        if (vMap.hazards[i].id == selectedObject.id) {
            if (vMap.hazards[i].x == selectedObject.x && vMap.hazards[i].y == selectedObject.y) {
                vMap.hazards.splice(i, 1);
                selectedObject = null;
                return;
            }
        }
    }
}


function generateVMap() {
    resize();
    var localMap = null;
    var siteNum = 250;
    var sites = [];
    var margin = 0.07;
    var localbbox = { xl: map.x, xr: map.width, yt: map.y, yb: map.height };

    var xmargin = map.width * margin,
        ymargin = map.height * margin,
        xo = xmargin,
        dx = map.width - xmargin * 2,
        yo = ymargin,
        dy = map.height - ymargin * 2;

    for (var i = 0; i < siteNum; i++) {
        sites.push({ x: Math.round((xo + Math.random() * dx) * 10) / 10, y: Math.round((yo + Math.random() * dy) * 10) / 10 });
    }
    localMap = voronoi.compute(sites, localbbox);
    var cells = localMap.cells;
    iCells = cells.length;
    while (iCells--) {
        cells[iCells].id = 1;
    }
    localMap.hazards = [];
    return localMap;
}

function cellUnderMouse(evt) {
    var x = 0,
        y = 0;
    var rect = createCanvas.getBoundingClientRect();
    x = (((evt.pageX - rect.left) / newWidth) * createCanvas.width);
    y = (((evt.pageY - rect.top) / newHeight) * createCanvas.height);
    setMousePos(x, y);
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
function exportToJSON() {
    basicSanitize();
    navigator.clipboard.writeText(JSON.stringify(vMap)).then(function () {
        alert("Copied to Clipboard!");
    }, function (err) {
        console.log(err);
        alert("Export failed");
    });
}

function submitViaEmail() {
    basicSanitize();
    var mailLink = "mailto:" + config.submitViaMail + "?subject=New map submission - " + vMap.name + " : " + vMap.author + "&body=" + JSON.stringify(vMap);
    window.open(mailLink, '_blank');
}

function submitToGithub() {
    var email = $("#email").val();
    if (!validateEmail(email)) {
        alert("You must enter a valid email address to submit to GitHub");
        return false;
    }
    basicSanitize();
    vMap.email = email;
    var submitStatus = $("#submitStatus");
    submitStatus.show();
    submitStatus.css("color", "black");
    submitStatus.css("background-color", "#ADD8E6");
    submitStatus.text("Submitting..");
    server.emit('submitNewMap', JSON.stringify(vMap));
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
    vMap.thumbnail = createCanvas.toDataURL("image/jpeg", 0.1);
    vMap.id = makeid(32);
    vMap.author = author.substring(0, 15);
    vMap.name = name.substring(0, 15);
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