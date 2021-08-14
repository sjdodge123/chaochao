function drawObjects(dt){
    drawBackground(dt);
    drawWorld(dt);
    drawLobbyStartButton();
    drawGate();
    drawMap();
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
       drawPlayer(player);
    }
}
function drawPlayer(player){
    gameContext.save();
    gameContext.beginPath();
    gameContext.arc(player.x, player.y, player.radius, 0, 2 * Math.PI);
    gameContext.fillStyle = player.color;
    gameContext.fill();
    
    gameContext.strokeStyle = "black";
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
            gameContext.lineWidth = 2;
            gameContext.fillStyle = locateColor(cell.id);
            gameContext.strokeStyle = 'black';
            gameContext.fill();
            gameContext.stroke();
        }
    }
}

function locateColor(id){
    if(id == null){
        return "white";
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


