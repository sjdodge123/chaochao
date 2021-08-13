var mousex,
	mousey,
	gameState,
	lobbyStartButton,
	gate,
	world,
	mapID,
	currentMap,
	playerList,
	clientList;

resetGameboard();

function resetGameboard(){
	playerList = {};
	clientList = {};
}


function connectSpawnPlayers(packet){
	if(packet == null){
		return;
	}
	packet = JSON.parse(packet);
	for(var i=0;i<packet.length;i++){
		var player = packet[i];
		if(playerList[player[0]] == null){
			 createPlayer(player);
		}
	}

}

function createPlayer(dataArray,isAI){
	var index = dataArray[0];
	playerList[index] = {};
	playerList[index].radius = config.playerBaseRadius;
	playerList[index].id = dataArray[0];
	var shipX, shipY, shipColor;
	shipX = dataArray[1];
	shipY = dataArray[2];
	shipColor = dataArray[3];

	playerList[index].x = shipX;
	playerList[index].y = shipY;
	playerList[index].color = shipColor;
    /*
	playerList[index].weapon = {}
	playerList[index].weapon.angle = dataArray[4];
	playerList[index].weapon.name = dataArray[5];
	if(isAI){
		playerList[index].AIName = dataArray[8]
	}
	playerList[index].trail = new Trail({x:shipX, y:shipY}, 10, 20, shipColor, 0.25, 'circle');
    */
}

function updatePlayerList(packet){
	if(packet == null){
		return;
	}
	packet = JSON.parse(packet);
	for(var i=0;i<packet.length;i++){
		var player = packet[i];
		if(playerList[player[0]] != null){
			playerList[player[0]].id = player[0];
			playerList[player[0]].x = player[1];
			playerList[player[0]].y = player[2];
			//playerList[player[0]].weapon.angle = player[3];
			playerList[player[0]].velX = player[4];
			playerList[player[0]].velY = player[5];
		}
	}
}


function worldResize(payload){
	payload = JSON.parse(payload);
	world = {};
	world.x = payload[0];
	world.y = payload[1];
	world.width = payload[2];
	world.height = payload[3];
}
function appendNewPlayer(packet){
	if(packet == null){
		return;
	}
	packet = JSON.parse(packet);
	var player = packet;
	if(playerList[player[0]] == null){
		createPlayer(player);
	}
}

function checkGameState(payload){
	if(payload == null){
		return;
	}
	payload = JSON.parse(payload);
	gameState = payload[0];
	if(gameState == config.stateMap.waiting){
		lobbyStartButton = null;
	}
	if(gameState == config.stateMap.lobby){
		lobbyStartButton = {};
		lobbyStartButton.x = payload[1];
		lobbyStartButton.y = payload[2];
		lobbyStartButton.radius = payload[3];
		lobbyStartButton.color = payload[4];
	}
	if(gameState == config.stateMap.gated){
		lobbyStartButton = null;
		gate = {};
		gate.x = payload[1];
		gate.y = payload[2];
		gate.width = payload[3];
		gate.height = payload[4];
	}
}

function loadNewMap(id){
	for(var i=0;i<maps.length;i++){
		if(id == maps[i].id){
			currentMap = maps[i];
			console.log(currentMap);
		}
	}
}

function spawnLobbyStartButton(payload){
	if(payload == null){
		return;
	}
	payload = JSON.parse(payload);
	lobbyStartButton = {};
	lobbyStartButton.x = payload[0];
	lobbyStartButton.y = payload[1];
	lobbyStartButton.radius = payload[2];
	lobbyStartButton.color = payload[3];
}
