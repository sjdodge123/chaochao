var mousex,
	mousey,
	lobbyStartButton,
	gate,
	world,
	mapID,
	currentMap,
	punchList,
	playerList,
	blindfold,
	clientList;

resetGameboard();

function resetGameboard(){
	playerList = {};
	clientList = {};
	punchList = {};
	blindfold = {};
	currentMap = {};
}
function updateGameboard(dt){
	if(currentState == config.stateMap.racing || currentState == config.stateMap.collapsing){
		updateTrails();
	}
}
function resetTrails(){
	for(var id in playerList){
		var player = playerList[id];
		player.trail.reset(player);
	}
}

function updateTrails(){
	for(var id in playerList){
		var player = playerList[id];
		player.trail.update({x:player.x, y:player.y});
	}
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
	playerList[index].x = dataArray[1];
	playerList[index].y = dataArray[2];
	playerList[index].color = dataArray[3];
	playerList[index].alive = true;
	playerList[index].notches = 0;
	playerList[index].awake = true;
	playerList[index].ability = null;
	playerList[index].trail = new Trail({x:dataArray[1],y:dataArray[2]});
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
			playerList[player[0]].velX = player[3];
			playerList[player[0]].velY = player[4];
		}
	}
}
function updatePlayerNotches(packet){
	if(packet == null){
		return;
	}
	packet = JSON.parse(packet);
	for(var i=0;i<packet.length;i++){
		var player = packet[i];
		if(playerList[player[0]] != null){
			oldNotches[player[0]] = playerList[player[0]].notches;
			playerList[player[0]].notches = player[1];
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
	currentState = payload[0];
	if(currentState == config.stateMap.waiting){
		lobbyStartButton = null;
	}
	if(currentState == config.stateMap.lobby){
		lobbyStartButton = {};
		lobbyStartButton.x = payload[1];
		lobbyStartButton.y = payload[2];
		lobbyStartButton.radius = payload[3];
		lobbyStartButton.color = payload[4];
	}
	if(currentState == config.stateMap.gated){
		lobbyStartButton = null;
		gate = {};
		gate.x = payload[1];
		gate.y = payload[2];
		gate.width = payload[3];
		gate.height = payload[4];
	}
}

function loadNewMap(id){
	currentMap = {};
	for(var i=0;i<maps.length;i++){
		if(id == maps[i].id){
			currentMap = JSON.parse(JSON.stringify(maps[i]));
		}
	}
}
function applyAbilites(abilities){
	if(abilities.length == 0){
		return;
	}
	for(var i=0;i<currentMap.cells.length;i++){
		if(currentMap.cells[i].id == config.tileMap.ability.id){
			currentMap.cells[i].id = abilities[currentMap.cells[i].site.voronoiId];
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
function spawnPunch(payload){
	if(payload == null){
		return;
	}
	payload = JSON.parse(payload);
	var punch = {};
	punch.ownerId = payload[0];
	punch.x = payload[1];
	punch.y = payload[2];
	punch.color = payload[3];
	punchList[punch.ownerId] = punch;
}
function terminatePunch(id){
	if(punchList[id] != null){
		delete punchList[id];
	}
}

function resetPlayers(){
	for(var id in playerList){
		var player = playerList[id];
		player.alive = true;
		player.trail = new Trail({x:player.x,y:player.y});
	}
}

function fullReset(){
	playerWon = null;
	decodedColorName = '';
	oldNotches = {};
	for(var id in playerList){
		var player = playerList[id];
		player.alive = true;
		player.ability = null;
		player.trail = new Trail({x:player.x,y:player.y});
		player.notches = 0;
		oldNotches[id] = player.notches;
	}
	
}

function collapseCells(cells){
	for(var i=0;i<currentMap.cells.length;i++){
		var cell = currentMap.cells[i];
		for(var j=0;j<cells.length;j++){
			if(cells[j] == cell.site.voronoiId){
				cell.id = config.tileMap.lava.id;
				cell.color = config.tileMap.lava.color;
			}
		}
	}
	
}

function playerPickedUpAbility(payload){
	playerList[payload.owner].ability = payload.ability;
	for(var i=0;i<currentMap.cells.length;i++){
		var cell = currentMap.cells[i];
		if(cell.site.voronoiId == payload.voronoiId){
			cell.id = config.tileMap.normal.id;
			return;
		}
	}
}
function createBlindFold(owner){
	blindfold.color = this.playerList[owner].color;
	var int = setInterval(function(){
		clearInterval(int);
		blindfold.color = null;
	},config.tileMap.abilities.blindfold.duration*1000);
}

class Trail {
	constructor(initialPosition){
		this.vertices = [];
		this.maxLength = 3000;
		for (var i = 0; i < this.maxLength; i++){
			this.vertices.push(initialPosition);
		}
	}
	update(currentPosition){
		for (var i = this.maxLength - 1; i > 0; i--){
			this.vertices[i] = this.vertices[i-1];
		}
		this.vertices[0] = currentPosition;
	}
	reset(player){
		this.vertices = [];
		for (var i = 0; i < this.maxLength; i++){
			this.vertices.push({x:player.x,y:player.y});
		}
	}
}