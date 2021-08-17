function drawObjects(dt){
    if(config == null){
        return;
    }
    drawBackground(dt);
    if(currentState == config.stateMap.overview){
        drawOverviewBoard();
        return;
    }
    drawWorld(dt);
    if(currentState == config.stateMap.lobby){
        drawLobbyStartButton();
    }
    if(currentState == config.stateMap.gated ||
       currentState == config.stateMap.racing){
        drawGate();
        drawMap();
    }
    drawPlayers(dt);
}

function drawBackground() {
	gameContext.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
}

function drawPlayers(dt){
    for(var id in playerList){
        var player = playerList[id];
        if(player == null){
            continue;
        }
        if(currentState == config.stateMap.racing){
            drawTrail(player)
        }
        if(player.alive == false){
            continue;
        }
       drawPlayer(player);
    }
}
function drawPlayer(player){
    gameContext.save();
    gameContext.beginPath();
    gameContext.shadowColor = player.color;
    gameContext.shadowBlur = 3;
    gameContext.arc(player.x, player.y, player.radius, 0, 2 * Math.PI);
    gameContext.fillStyle = player.color;
    gameContext.fill();
    
    gameContext.strokeStyle = "black";
    gameContext.stroke();
    gameContext.restore();
    
    
    
}
function drawTrail(player){
    gameContext.save();
    gameContext.beginPath();
    gameContext.moveTo(player.trail.vertices[0].x,player.trail.vertices[0].y);
    for (var i = 0; i < player.trail.vertices.length; i++){
        var point = player.trail.vertices[i];
        gameContext.lineWidth = 3;
        gameContext.strokeStyle = player.color;
        gameContext.lineTo(point.x, point.y);
    }
    gameContext.stroke();
    gameContext.restore();
}

function drawWorld(){
	if(world != null){
		gameContext.save();
		gameContext.beginPath();
        gameContext.lineWidth = 3;
        gameContext.strokeStyle = "grey";
        gameContext.rect(world.x,world.y,world.width,world.height);
        gameContext.stroke();
        gameContext.restore();
	}
}

function drawLobbyStartButton(){
    if(lobbyStartButton != null){
        gameContext.save();
        gameContext.beginPath();
        gameContext.arc(lobbyStartButton.x, lobbyStartButton.y, lobbyStartButton.radius, 0, 2 * Math.PI);
        gameContext.lineWidth = 3;
        gameContext.stroke();

        gameContext.beginPath();
        gameContext.arc(lobbyStartButton.x, lobbyStartButton.y, lobbyStartButton.radius, 0, 2 * Math.PI);
        gameContext.clip();
        for (i=0; i<  360; i++) {
            var angle = 0.1 * i;
            var x = lobbyStartButton.x + (4 + 2 * angle)*Math.cos(angle);
            var y = lobbyStartButton.y + (4 + 2 * angle)*Math.sin(angle);
            gameContext.lineTo(x, y);
          }
        gameContext.lineWidth = 2;
        
        
        gameContext.strokeStyle = lobbyStartButton.color;
        gameContext.stroke();
        gameContext.restore();
    }
}
function drawGate(){
    if(gate != null){
        gameContext.save();
		gameContext.beginPath();
        gameContext.lineWidth = 5;
        gameContext.rect(gate.x,gate.y,gate.width,gate.height);
        gameContext.fillStyle = "grey";
        gameContext.fill();
        gameContext.restore();
    }
}
function drawMap(){
    if(currentMap != null){
        gameContext.save();
        var cells = currentMap.cells,
            iCell = cells.length;

        while(iCell--){
            gameContext.beginPath();
            var cell = cells[iCell];
            var halfedges = cell.halfedges;
            var nHalfedges = halfedges.length;
            if(nHalfedges == 0){
                continue;
            }
            var v = getStartpoint(halfedges[0]);
            gameContext.moveTo(v.x,v.y);
            for(var i=0;i<nHalfedges;i++){
                v = getEndpoint(halfedges[i]);
                gameContext.lineTo(v.x,v.y);
            }
            var color = locateColor(cell.id);
            gameContext.shadowColor = color;
            gameContext.shadowBlur = 3;
            gameContext.lineWidth = 0.5;
            gameContext.fillStyle = color;
            gameContext.strokeStyle = '#adadad';
            gameContext.fill();
            gameContext.stroke();
        }
        gameContext.restore();
    }
}

function locateColor(id){
    if(id == null){
        return "red";
    }
    for(var type in config.tileMap){
        if(id == config.tileMap[type].id){
            return config.tileMap[type].color;
        }
    }
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

function drawOverviewBoard(){
    drawBlackBackground();
    drawOldNotches();
}
function drawBlackBackground(){
    gameContext.save();
    gameContext.beginPath();
    gameContext.fillStyle = "black";
    gameContext.rect(world.x,world.y,world.width,world.height);
    gameContext.fill();
    gameContext.restore();
}
function drawOldNotches(){
    gameContext.save();
    var count = 0;
    for(var player in playerList){
        count++;
    }
    var distanceApart =  7;
    var notchDistanceApart = config.playerNotchesToWin*20;
    var offSetX = gameCanvas.width/2 - config.playerNotchesToWin*notchDistanceApart*.5;
    var offSetY = gameCanvas.height/2 - (count*config.playerBaseRadius*distanceApart*.5);
    gameContext.translate(offSetX,offSetY);
    for(var player in playerList){
        drawNotches(notchDistanceApart);
        drawPlayerIcon(playerList[player],notchDistanceApart);
        drawGoalPost(playerList[player],notchDistanceApart);
        gameContext.translate(0,config.playerBaseRadius*distanceApart);
    }
    gameContext.restore();
}
function drawPlayerIcon(player,notchDistanceApart){
    gameContext.beginPath();
    gameContext.shadowColor = player.color;
    gameContext.shadowBlur = 10;
    gameContext.arc(0 + oldNotches[player.id]*notchDistanceApart, 0, config.playerBaseRadius*2, 0, 2 * Math.PI);
    gameContext.fillStyle = player.color;
    gameContext.fill();
}
function drawNotches(distanceApart){
    gameContext.beginPath();
    for(var i=0;i<config.playerNotchesToWin;i++){
        gameContext.arc(i*distanceApart, 0, 2, 0, 2 * Math.PI);  
    }
    gameContext.fillStyle = "grey";
    gameContext.fill();
}
function drawGoalPost(player,distanceApart){
    gameContext.beginPath();
    gameContext.rect(-15 + config.playerNotchesToWin*distanceApart,-15,30,30);
    
    if(oldNotches[player.id] == config.playerNotchesToWin-1){
        gameContext.shadowColor = "white";
        gameContext.shadowBlur = 10;
        gameContext.fillStyle = "white"
        gameContext.fill();
    }else{
        gameContext.shadowColor = "grey";
        gameContext.strokeStyle = "grey";
        gameContext.stroke();
    }
}


