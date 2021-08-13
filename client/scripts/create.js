var server,
    createCanvas,
    voronoi = new Voronoi(),
    vMap,
    treemap = null,
    lastCell,
    brushID,
    brushColor,
    newWidth = 0,
    newHeight = 0,
    world = {x:0,y:0,width:1366,height:768},
    gate = {x:0,y:0,width:75,height:world.height},
    map = {x:0+gate.width,y:0,width:world.width,height:world.height},
    bbox = {xl:map.x,xr:map.width,yt:map.y,yb:map.height},
    createContext;

var tileTypes = {
    "slow":{
        "id": 0,
        "color": "black",
        "value": .2
    },
    "normal":{
        "id": 1,
        "color": "#F0F0F0",
        "value": 1
    },
    "fast":{
        "id": 2,
        "color": "#90ee90",
        "value": 2
    },
    "lava":{
        "id": 3,
        "color": "#90ee90",
        "value": 0
    },
    "ice":{
        "id": 4,
        "color": "#A5F2F3",
        "value": 0
    },
    "ability":{
        "id": 5,
        "color": "#696969",
        "value": 0
    },
    "goal":{
        "id": 6,
        "color": "#FFD700",
        "value": 0
    }
}

var then = Date.now(),
    dt;

window.onload = function() {
    server = clientConnect();
    setupPage();
    enter();
}


function setupPage(){
    $("#rebuildButton").on("click", function () {
        vMap = generateVMap();
        return false;
    });
    $("#slowTileButton").on("click", function () {
        brushID = tileTypes.slow.id;
        brushColor = tileTypes.slow.color;
        return false;
    });
    $("#normalTileButton").on("click", function () {
        brushID = tileTypes.normal.id;
        brushColor = tileTypes.normal.color;
        return false;
    });
    $("#fastTileButton").on("click", function () {
        brushID = tileTypes.fast.id;
        brushColor = tileTypes.fast.color;
        return false;
    });
    $("#lavaTileButton").on("click", function () {
        brushID = tileTypes.lava.id;
        brushColor = tileTypes.lava.color;
        return false;
    });
    $("#iceTileButton").on("click", function () {
        brushID = tileTypes.ice.id;
        brushColor = tileTypes.ice.color;
        return false;
    });
    $("#abilityTileButton").on("click", function () {
        brushID = tileTypes.ability.id;
        brushColor = tileTypes.ability.color;
        return false;
    });
    $("#goalTileButton").on("click", function () {
        brushID = tileTypes.goal.id;
        brushColor = tileTypes.goal.color;
        return false;
    });
    $("#exportButton").on("click", function () {
        exportToJSON();
        return false;
    });

    window.addEventListener('resize', resize, false);
    window.requestAnimFrame = (function(){
        return  window.requestAnimationFrame       ||
                window.webkitRequestAnimationFrame ||
                window.mozRequestAnimationFrame    ||
                function( callback ){
                    window.setTimeout(callback, 1000 / 30);
                };
        })();

    createCanvas = document.getElementById('createCanvas');
    createContext = createCanvas.getContext('2d');
}

function enter(){
    vMap = generateVMap();
    $('#createWindow').show();
    gameRunning = true;
    init();
}
function init(){
    animloop();
    window.addEventListener("mousemove", cellUnderMouse, false);
    window.addEventListener("mousedown", handleClick, false);
    window.addEventListener("mouseup", handleUnClick, false);
    //window.addEventListener("keydown", keyDown, false);
    //window.addEventListener("keyup", keyUp, false);
    window.addEventListener('contextmenu', function(ev) {
        ev.preventDefault();
        return false;
    }, false);
}

function animloop(){
    if(gameRunning){
        var now = Date.now();
    	dt = now - then;
        gameLoop(dt);
    	then = now;
    	requestAnimFrame(animloop);
    }
}
function gameLoop(dt){
    drawEditor(dt);
}

function resize(){
    var viewport = {width:window.innerWidth,height:window.innerHeight};
    var scaleToFitX = viewport.width / createCanvas.width;
    var scaleToFitY = viewport.height / createCanvas.height;
    var currentScreenRatio = viewport.width/viewport.height;
    var optimalRatio = Math.min(scaleToFitX,scaleToFitY);

    if(currentScreenRatio >= 1.77 && currentScreenRatio <= 1.79){
        newWidth = viewport.width;
        newHeight = viewport.height;
    } else{
        newWidth = createCanvas.width * optimalRatio;
        newHeight = createCanvas.height * optimalRatio;
    }

    createCanvas.style.width = newWidth + "px";
    createCanvas.style.height = newHeight + "px";
}

function drawEditor(dt){
    drawBackground(dt);
    drawWorld(dt);
    drawGate();
    drawMap();
    drawVMap();
    //drawPlayers(dt);
}
function drawBackground() {
	createContext.clearRect(0, 0, createCanvas.width, createCanvas.height);
}
function drawWorld(){
	if(world != null){
		createContext.save();
		createContext.beginPath();
        createContext.lineWidth = 3;
        createContext.strokeStyle = "grey";
        createContext.rect(world.x,world.y,world.width,world.height);
        createContext.stroke();
        createContext.restore();
	}
}
function drawGate(){
    if(gate != null){
        createContext.save();
		createContext.beginPath();
        createContext.lineWidth = 5;
        createContext.rect(gate.x,gate.y,gate.width,gate.height);
        createContext.fillStyle = "grey";
        createContext.fill();
        createContext.restore();
    }
}
function drawMap(){
    if(map != null){
        createContext.save();
		createContext.beginPath();
        createContext.lineWidth = 5;
        createContext.rect(map.x,map.y,map.width,map.height);
        createContext.fillStyle = "#F0F0F0";
        createContext.fill();
        createContext.restore();
    }
}

function drawVMap(){
    if(vMap != null){
        createContext.beginPath();
        createContext.strokeStyle = '#000';
        var edges = vMap.edges,
			iEdge = edges.length,
			edge, v;
        while (iEdge--) {
            edge = edges[iEdge];
            v = edge.va;
            createContext.moveTo(v.x,v.y);
            v = edge.vb;
            createContext.lineTo(v.x,v.y);
        }
        createContext.stroke();
    }   
}


function clientConnect(){
    var server = io();
    return server;
}

function calcMousePos(evt){
    evt.preventDefault();
    var rect = createCanvas.getBoundingClientRect();
    mouseX = (((evt.pageX - rect.left)/newWidth)*createCanvas.width);
    mouseY = (((evt.pageY - rect.top )/newHeight)*createCanvas.height);
    server.emit('mousemove',{x:mouseX,y:mouseY});
    setMousePos(mouseX,mouseY);
}

function handleClick(event){
    switch(event.which){
        case 1:{
            //iAmFiring = true;
            break;
        }
    }
    event.preventDefault();
}
function handleUnClick(event){
    switch(event.which){
        case 1:{
            //iAmFiring = false;
            //server.emit("stopFire");
            break;
        }
    }
}

function setMousePos(x,y){
	mousex = x;
	mousey = y;
}


function generateVMap(){
    var vMap;
    var siteNum = 250;
    var sites = [];
    var margin = 0.015;
    bbox = {xl:map.x,xr:map.width,yt:map.y,yb:map.height};

    var xmargin = map.width*margin,
			ymargin = map.height*margin,
			xo = xmargin,
			dx = map.width-xmargin*2,
			yo = ymargin,
			dy = map.height-ymargin*2;

    for(var i=0;i<siteNum;i++){
        sites.push({x:Math.round((xo+Math.random()*dx)*10)/10,y:Math.round((yo+Math.random()*dy)*10)/10});
    }
    vMap = voronoi.compute(sites,bbox);
    return vMap;
}

function cellUnderMouse(evt) {
    var x = 0,
        y = 0;
    var rect = createCanvas.getBoundingClientRect();
    x = (((evt.pageX - rect.left)/newWidth)*createCanvas.width);
    y = (((evt.pageY - rect.top )/newHeight)*createCanvas.height);
    cellid = cellIdFromPoint(x,y);
    if (lastCell !== cellid) {
        if (lastCell !== undefined) {
            renderCell(lastCell, 'red', 'black');
        }
        if (cellid !== undefined) {
            renderCell(cellid, 'red', 'black');
        }
        lastCell = cellid;
        }
}

function cellIdFromPoint(x, y) {
    // We build the treemap on-demand
    if (treemap === null) {
        treemap = buildTreemap();
    }
    // Get the Voronoi cells from the tree map given x,y
    var items = treemap.retrieve({x:x,y:y}),
        iItem = items.length,
        cells = vMap.cells,
        cell, cellid;
    while (iItem--) {
        cellid = items[iItem].cellid;
        cell = cells[cellid];
        if (cell.pointIntersection(x,y) > 0) {
            return cellid;
            }
        }
    return undefined;
}
function buildTreemap(){
    var treemap = new QuadTree({
        x: bbox.xl,
        y: bbox.yt,
        width: bbox.xr-bbox.xl,
        height: bbox.yb-bbox.yt
        });
    var cells = vMap.cells,
        iCell = cells.length;
    while (iCell--) {
        bbox = cells[iCell].getBbox();
        bbox.cellid = iCell;
        treemap.insert(bbox);
        }
    return treemap;
}

function renderCell (id, fillStyle, strokeStyle) {
    if (id === undefined) {return;}
    var cell = vMap.cells[id];
    if (!cell) {return;}
    console.log(id);
    // edges
    createContext.beginPath();
    var halfedges = cell.halfedges,
        nHalfedges = halfedges.length,
        v = halfedges[0].getStartpoint();
    createContext.moveTo(v.x,v.y);
    for (var iHalfedge=0; iHalfedge<nHalfedges; iHalfedge++) {
        v = halfedges[iHalfedge].getEndpoint();
        createContext.lineTo(v.x,v.y);
        }
    createContext.fillStyle = fillStyle;
    createContext.strokeStyle = strokeStyle;
    createContext.fill();
    createContext.stroke();
}
function exportToJSON(){
    var jsonData = JSON.stringify(vMap);
    navigator.clipboard.writeText(jsonData).then(function() {
        alert("Copied to Clipboard!");
    }, function(err) {
        console.log(err);
        alert("Export failed");
    });
}