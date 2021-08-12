function drawObjects(dt){
    drawBackground(dt);
    drawWorld(dt);
    drawLobbyStartButton();
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

