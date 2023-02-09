var server,
    maps = [],
    createCanvas,
    gameRunning = false,
    voronoi = new Voronoi(),
    vMap,
    brushing = false,
    mapReady = false,
    mousex = 0,
    mousey = 0,
    lastCell,
    brushID,
    config,
    brushColor = "black",
    currentCell = null,
    newWidth = 0,
    newHeight = 0,
    world = { x: 0, y: 0, width: 1366, height: 768 },
    gate = { x: 0, y: 0, width: 75, height: world.height },
    map = { x: 75, y: 0, width: world.width, height: world.height },
    canvasWindow = document.getElementById("canvasWindow"),
    createContext;

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
        init();
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


function setupPage() {
    $("#createNew").on("click", function () {
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
    $("#slowTileButton").on("click", function () {
        brushID = config.tileMap.slow.id;
        brushColor = config.tileMap.slow.color;
        return false;
    });
    $("#normalTileButton").on("click", function () {
        brushID = config.tileMap.normal.id;
        brushColor = config.tileMap.normal.color;
        return false;
    });
    $("#fastTileButton").on("click", function () {
        brushID = config.tileMap.fast.id;
        brushColor = config.tileMap.fast.color;
        return false;
    });
    $("#lavaTileButton").on("click", function () {
        brushID = config.tileMap.lava.id;
        brushColor = config.tileMap.lava.color;
        return false;
    });
    $("#iceTileButton").on("click", function () {
        brushID = config.tileMap.ice.id;
        brushColor = config.tileMap.ice.color;
        return false;
    });
    $("#abilityTileButton").on("click", function () {
        brushID = config.tileMap.ability.id;
        brushColor = config.tileMap.ability.color;
        return false;
    });
    $("#randomTileButton").on("click", function () {
        brushID = config.tileMap.random.id;
        brushColor = config.tileMap.random.color;
        return false;
    });
    $("#goalTileButton").on("click", function () {
        brushID = config.tileMap.goal.id;
        brushColor = config.tileMap.goal.color;
        return false;
    });
    $("#bumperTileButton").on("click", function () {
        brushID = config.tileMap.bumper.id;
        brushColor = config.tileMap.bumper.color;
        return false;
    });
    $("#exportButton").on("click", function () {
        exportToJSON();
        return false;
    });
    $("#submitButton").on("click", function () {
        submitViaEmail();
        return false;
    });
    /*
    $("#submitToGame").on("click", function () {
        submitToGithub();
        return false;
    });
    */
    $("#loadButton").on("click", function () {
        $("#createNewImage").attr("src", createCanvas.toDataURL("image/jpeg", 0.1));
        $('#createWindow').hide();
        $('#loadWindow').show();

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

function validateWithUser() {
    var cells = vMap.cells;
    for (var i = 0; i < cells.length; i++) {
        if (cells[i].id != config.tileMap.normal.id) {
            return confirm("Are you sure you want to delete this map?");
        }
    }
    return true;
}

function rebuild() {
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
    currentCell = cellIdFromPoint(mousex, mousey);
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

    if (currentScreenRatio >= 1.77 && currentScreenRatio <= 1.79) {
        newWidth = viewport.width;
        newHeight = viewport.height;
    } else {
        newWidth = createCanvas.width * optimalRatio;
        newHeight = createCanvas.height * optimalRatio;
    }
    var controlPanel = document.getElementById("controlPanel");
    controlPanel.style.width = newWidth + "px";
    createCanvas.style.width = newWidth + "px";
    createCanvas.style.height = newHeight + "px";
}

function drawEditor(dt) {
    drawBackground(dt);
    drawWorld(dt);
    drawGate();
    //drawMap();
    renderCells();
    drawPointerCircle();
    //drawPlayers(dt);
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
function handleClick(event) {
    switch (event.which) {
        case 1: {
            brushing = true;
        }
    }
}
function handleUnClick(event) {
    switch (event.which) {
        case 1: {
            brushing = false;
            break;
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

    if (cell.site.voronoiId == currentCell) {
        createContext.fillStyle = brushColor;
    } else {
        createContext.fillStyle = color;
    }

    createContext.strokeStyle = '#adadad';
    createContext.fill();
    createContext.stroke();

    /*
    v = cell.site;
    createContext.fillStyle = '#44f';
    createContext.beginPath();
    createContext.rect(v.x-2/3,v.y-2/3,2,2);
    createContext.fill();
    */
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
    basicSanitize();
    $.ajax
        ({
            data: JSON.stringify(vMap),
            contentType: 'application/json',
            type: "POST",

            url: 'https://staticman-chaochao.herokuapp.com/v2/entry/sjdodge123/chaochao/master/maps',

            //json object to sent to the authentication url

            success: function () {
                alert("Thanks!");
            }
        });
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
        if (color == config.tileMap[type].color) {
            return config.tileMap[type].id;
        }
    }
}

function drawPointerCircle() {
    createContext.beginPath();
    createContext.arc(mousex, mousey, 5, 0, 2 * Math.PI);
    createContext.fillStyle = brushColor;
    createContext.strokeStyle = "black";
    createContext.fill();
    createContext.stroke();
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