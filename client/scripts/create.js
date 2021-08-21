var server,
    createCanvas,
    voronoi = new Voronoi(),
    vMap,
    mousex = 0,
    mousey = 0,
    lastCell,
    brushID,
    brushColor = "black",
    currentCell = null,
    newWidth = 0,
    newHeight = 0,
    world = {x:0,y:0,width:1366,height:768},
    gate = {x:0,y:0,width:75,height:world.height},
    map = {x:75,y:0,width:world.width,height:world.height},
    createContext;

var tileTypes = {
    "slow":{
        "id": 0,
        "color": "black"
    },
    "normal":{
        "id": 1,
        "color": "#F0F0F0"
    },
    "fast":{
        "id": 2,
        "color": "#90ee90"
    },
    "lava":{
        "id": 3,
        "color": "#cf1020"
    },
    "ice":{
        "id": 4,
        "color": "#A5F2F3"
    },
    "ability":{
        "id": 5,
        "color": "#696969"
    },
    "goal":{
        "id": 6,
        "color": "#FFD700"
    }
}

var then = Date.now(),
    dt;

window.onload = function() {
    //server = clientConnect();
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
    currentCell = cellIdFromPoint(mousex,mousey);
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
    //drawMap();
    renderCells();
    drawPointerCircle();
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
        createContext.fillStyle = "RED";
        createContext.fill();
        createContext.restore();
    }
}
function clientConnect(){
    var server = io();
    return server;
}

function handleClick(event){
    switch(event.which){
        case 1:{
            var newId = locateId(brushColor);
            var cells = vMap.cells;
            for(var i=0;i<cells.length;i++){
                if(currentCell == cells[i].site.voronoiId){
                    cells[i].id = newId;
                }
            }
        }
    }
}
function handleUnClick(event){
    switch(event.which){
        case 1:{
            break;
        }
    }
}

function setMousePos(x,y){
	mousex = x;
	mousey = y;
}


function generateVMap(){
    resize();
    var localMap = null;
    var siteNum = 250;
    var sites = [];
    var margin = 0.07;
    var localbbox = {xl:map.x,xr:map.width,yt:map.y,yb:map.height};

    var xmargin = map.width*margin,
			ymargin = map.height*margin,
			xo = xmargin,
			dx = map.width-xmargin*2,
			yo = ymargin,
			dy = map.height-ymargin*2;

    for(var i=0;i<siteNum;i++){
        sites.push({x:Math.round((xo+Math.random()*dx)*10)/10,y:Math.round((yo+Math.random()*dy)*10)/10});
    }
    localMap = voronoi.compute(sites,localbbox);
    var cells = localMap.cells;
        iCells = cells.length;
    while(iCells--){
        cells[iCells].id = 1;
    }
    return localMap;
}

function cellUnderMouse(evt) {
    var x = 0,
        y = 0;
    var rect = createCanvas.getBoundingClientRect();
    x = (((evt.pageX - rect.left)/newWidth)*createCanvas.width);
    y = (((evt.pageY - rect.top )/newHeight)*createCanvas.height);
    setMousePos(x,y);
}

function cellIdFromPoint(xmouse, ymouse) {
    var cells = vMap.cells;
    var iCell = cells.length;
    while(iCell--){
        var cell = cells[iCell];
        if(pointIntersection(xmouse,ymouse,cell) > 0){
            return cells[iCell].site.voronoiId;
        }
    }
}
function renderCells(){
    var cells = vMap.cells,
        iCell = cells.length,
        cell;

    while (iCell--) {
        renderCell(cells[iCell]);
    }
}

function renderCell (cell) {
    if (!cell) {return;}
    // edges
    createContext.beginPath();
    var halfedges = cell.halfedges;
    var nHalfedges = halfedges.length;
    if(nHalfedges == 0){
        return;
    }
    var v = getStartpoint(halfedges[0]);
    createContext.moveTo(v.x,v.y);
    for (var iHalfedge=0; iHalfedge<nHalfedges; iHalfedge++) {
        v = getEndpoint(halfedges[iHalfedge]);
        createContext.lineTo(v.x,v.y);
    }
    var color = locateColor(cell.id);
    
    if(cell.site.voronoiId == currentCell){
        createContext.fillStyle = brushColor;
    } else{
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
function getStartpoint(halfedge){
    if(compareSite(halfedge.edge.lSite,halfedge.site)){
        return halfedge.edge.va;
    }
    return halfedge.edge.vb;
}
function getEndpoint(halfedge){
    if(compareSite(halfedge.edge.lSite,halfedge.site)){
        return halfedge.edge.vb;
    }
    return halfedge.edge.va;
}
function compareSite(siteA,siteB){
    if(siteA.voronoiId != siteB.voronoiId){
        return false;
    }
    if(siteA.x != siteB.x){
        return false;
    }
    if(siteA.y != siteB.y){
        return false;
    }
    return true;
}
function exportToJSON(){
    var author = $("#author").val();
    if(author == ""){
        author = "anonymous";
    }
    var name = $("#name").val();
    if(name == ""){
        name="unknown";
    }
    vMap.id = makeid(32);
    vMap.author = author;
    vMap.name = name;
    var jsonData = JSON.stringify(vMap);
    navigator.clipboard.writeText(jsonData).then(function() {
        alert("Copied to Clipboard!");
    }, function(err) {
        console.log(err);
        alert("Export failed");
    });
}

function makeid(length) {
    var result           = '';
    var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for ( var i = 0; i < length; i++ ) {
      result += characters.charAt(Math.floor(Math.random() * 
 charactersLength));
   }
   return result;
}

function locateColor(id){
    for(var type in tileTypes){
        if(id == tileTypes[type].id){
            return tileTypes[type].color;
        }
    }
}
function locateId(color){
    for(var type in tileTypes){
        if(color == tileTypes[type].color){
            return tileTypes[type].id;
        }
    }
}

function drawPointerCircle(){
    createContext.beginPath();
    createContext.arc(mousex, mousey, 5, 0, 2 * Math.PI);
    createContext.fillStyle = brushColor;
    createContext.strokeStyle = "black";
    createContext.fill();
    createContext.stroke();
}

function pointIntersection(x,y,cell){
    {
        var halfedges = cell.halfedges,
            iHalfedge = halfedges.length,
            halfedge,
            p0, p1, r;
        while (iHalfedge--) {
            halfedge = halfedges[iHalfedge];
            p0 = getStartpoint(halfedge);
            p1 = getEndpoint(halfedge);
            r = (y-p0.y)*(p1.x-p0.x)-(x-p0.x)*(p1.y-p0.y);
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
function getBbox(cell){
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
        if (vx < xmin) {xmin = vx;}
        if (vy < ymin) {ymin = vy;}
        if (vx > xmax) {xmax = vx;}
        if (vy > ymax) {ymax = vy;}
        // we dont need to take into account end point,
        // since each end point matches a start point
        }
    return {
        x: xmin,
        y: ymin,
        width: xmax-xmin,
        height: ymax-ymin
    };
}