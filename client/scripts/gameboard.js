var mousex,
	mousey,
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
