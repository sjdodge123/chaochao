
var scale = 0.05;
var patterns = {};
var blindfoldIcon = new Image(576,512);
blindfoldIcon.src = "../assets/img/low-vision.svg";
var transferIcon = new Image(576,512);
transferIcon.src = "../assets/img/random.svg";

function loadPatterns(){
    patterns[config.tileMap.abilities.blindfold.id] = makePattern(blindfoldIcon);
    patterns[config.tileMap.abilities.swap.id] = makePattern(transferIcon);
}
function makePattern(image){
    var canvasPadding = 1;
    const canvasPattern = document.createElement("canvas");
    const ctxPattern = canvasPattern.getContext("2d");
    var iconWidth = image.width*scale;
    var iconHeight = image.height*scale;
    canvasPattern.width = iconWidth + canvasPadding;
    canvasPattern.height = iconHeight + canvasPadding;
    ctxPattern.drawImage(image,canvasPadding/2,canvasPadding/2,iconWidth,iconHeight);
    //document.body.appendChild(canvasPattern);
    return gameContext.createPattern(canvasPattern, 'repeat');
}

var notchDistanceApart = 0,
    decodedColorName = '';

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
       currentState == config.stateMap.racing ||
       currentState == config.stateMap.collapsing){
        drawGate();
        drawMap();
        drawPingCircles();
        drawMapTitle();
    }
    drawPlayers(dt);
    drawPunches();
    drawAbilties();
    if(currentState == config.stateMap.gameOver){
        drawGameOverScreen();
    }
}

function drawBackground() {
    gameContext.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
}
function drawGameOverScreen(){
    if(playerWon == null){
        return;
    }
    gameContext.save();
    gameContext.fillStyle = playerList[playerWon].color;
    gameContext.rect(0,0,gameCanvas.width, gameCanvas.height);
    gameContext.fill();
    gameContext.restore();
    
    gameContext.save();
    gameContext.fillStyle = "black";
    gameContext.font = '48px serif';
    var winString = decodedColorName + " won the game.";
    gameContext.fillText(winString, gameCanvas.width/2 - 400, (gameCanvas.height+48)/2);
    gameContext.restore();
}

function drawPunches(){
    for(var id in punchList){
        drawPunch(punchList[id]);
    }
}

function drawPunch(punch){
    gameContext.save();
    gameContext.beginPath();
    gameContext.fillStyle = punch.color;
    gameContext.arc(punch.x, punch.y, config.punchRadius, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.restore();

    gameContext.save();
    gameContext.beginPath();
    gameContext.lineWidth = 1;
    gameContext.strokeStyle = "black";
    gameContext.arc(punch.x, punch.y, config.punchRadius, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.restore();
}

function drawAbilties(){
    if(blindfold.color != null){
        gameContext.save();
		gameContext.beginPath();
        gameContext.fillStyle = blindfold.color;
        gameContext.rect(world.x,world.y,world.width,world.height);
        gameContext.fill();
        gameContext.restore();
    }
}

function drawMapTitle(){
    if(currentMap != null){
        gameContext.save();
        gameContext.fillStyle = "black";
        gameContext.font = '14px serif';
        gameContext.fillText('"'+currentMap.name+'"', 5, gameCanvas.height-25);
        gameContext.fillText('~'+currentMap.author, 5, gameCanvas.height-10);
        gameContext.restore();
    }
}

function drawPlayers(dt){
    for(var id in playerList){
        var player = playerList[id];
        if(id == myID){
            continue;
        }
        checkDrawPlayer(player);
    }
    checkDrawPlayer(playerList[myID]);
}
function checkDrawPlayer(player){
    if(player == null){
        return;
    }
    if(currentState == config.stateMap.racing || currentState == config.stateMap.collapsing){
        drawTrail(player);
    }
    if(player.alive == false){
        return;
    }
    drawPlayer(player);
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

    if(player.awake == false){
        gameContext.save();
        gameContext.fillStyle = "black";
        gameContext.font = '10px serif';
        gameContext.fillText("zzZZ..", player.x+5, player.y-10);
        gameContext.restore();
    }
}
function drawTrail(player){
    gameContext.save();
    gameContext.beginPath();
    gameContext.moveTo(player.trail.vertices[0].x,player.trail.vertices[0].y);
    var len = player.trail.vertices.length;
    for (var i = 0; i < len; i++){
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
        gameContext.fillStyle = "#F0F0F0";
        gameContext.rect(world.x,world.y,world.width,world.height);
        gameContext.fill();
        gameContext.restore();

		gameContext.save();
		gameContext.beginPath();
        gameContext.lineWidth = 4;
        gameContext.strokeStyle = "black";
        gameContext.rect(world.x,world.y,world.width,world.height);
        gameContext.stroke();
        gameContext.restore();   
	}
}

function drawLobbyStartButton(){
    gameContext.save();
    if(lobbyStartButton != null){
        
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
        
    }
    gameContext.restore();
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
function drawPingCircles(){
    if(pingCircles.length == 0){
        return;
    }
    gameContext.save();
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = config.tileMap.goal.color;
    gameContext.shadowBlur = 3;
    gameContext.shadowColor = "black";
    for(var i=0;i<pingCircles.length;i++){
        gameContext.beginPath();
        gameContext.arc(pingCircles[i].x, pingCircles[i].y, pingCircles[i].radius, 0, 2 * Math.PI);
        gameContext.stroke();
    }
    gameContext.restore();
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
            var color = null;
            if(cell.id > 99){
                color = patterns[cell.id];
            } else{
                color = locateColor(cell.id);
            }
           
            gameContext.lineWidth = 0.5;
            gameContext.shadowBlur = null;
            gameContext.shadowColor = null;
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
        return "purple";
    }
    if(id > 99){
        return config.tileMap.ability.color;
    }
    for(var type in config.tileMap){
        if(id == config.tileMap[type].id){
            return config.tileMap[type].color;
        }
    }
    
}
function locateSymbol(id){
    for(var type in config.tileMap.abilities){
        if(id == config.tileMap.abilities[type].id){
            return config.tileMap.abilities[type].symbol;
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
    var moveAmt = 0;
    if(player.distanceToMove > 0){
        moveAmt = 0.5;
        player.distanceToMove -= moveAmt;
        gameContext.arc(oldNotches[player.id]*notchDistanceApart, 0, config.playerBaseRadius*2, 0, 2 * Math.PI);
    } else if(player.distanceToMove < 0){
        moveAmt = -0.5;
        player.distanceToMove -= moveAmt;
        gameContext.arc(oldNotches[player.id]*notchDistanceApart, 0, config.playerBaseRadius*2, 0, 2 * Math.PI);
    } else{
        gameContext.arc(player.notches*notchDistanceApart, 0, config.playerBaseRadius*2, 0, 2 * Math.PI);
    }
    gameContext.fillStyle = player.color;
    gameContext.fill();
    
}

function drawNotches(distanceApart){
    gameContext.beginPath();
    for(var i=0;i<config.playerNotchesToWin+1;i++){
        gameContext.arc(i*distanceApart, 0, 2, 0, 2 * Math.PI);  
    }
    gameContext.fillStyle = "grey";
    gameContext.fill();
}
function drawGoalPost(player,distanceApart){
    gameContext.beginPath();
    gameContext.rect(-15 + (config.playerNotchesToWin+1)*distanceApart,-15,30,30);
    
    //If the animation is complete
    if(player.distanceToMove == 0){
        if(player.notches == config.playerNotchesToWin){
            gameContext.shadowColor = "white";
            gameContext.shadowBlur = 10;
            gameContext.fillStyle = "white"
            gameContext.fill();
        } else{
            gameContext.shadowColor = "grey";
            gameContext.strokeStyle = "grey";
            gameContext.stroke();
        }
        return;
    }
    //Animation hasnt occurred yet
    if(oldNotches[player.id] == config.playerNotchesToWin){
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
function calculateNotchMoveAmt(){
    notchDistanceApart = config.playerNotchesToWin*20;
    for(var id in playerList){
        playerList[id].deltaNotches = playerList[id].notches - oldNotches[id];
        playerList[id].distanceToMove = playerList[id].deltaNotches*notchDistanceApart;
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
        if (vx < xmin) {xmin = vx;}
        if (vy < ymin) {ymin = vy;}
        if (vx > xmax) {xmax = vx;}
        if (vy > ymax) {ymax = vy;}
    }
    return {
        x: xmin,
        y: ymin,
        width: xmax-xmin,
        height: ymax-ymin
    };
};


