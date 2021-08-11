var config;

function clientConnect() {
	var server = io();

    server.on('welcome', function(id){
		myID = id;
	});

	server.on("gameState", function(gameState){
		config = gameState.config;
		clientList = gameState.clientList;
		connectSpawnPlayers(gameState.playerList);
		worldResize(gameState.world);
		interval = config.serverTickSpeed;
		/*
		for(var id in clientList){
			eventLog.addEvent(clientList[id] + " has joined the battle");
		}
		*/
		if(gameState.myID != null){
			myID = gameState.myID;
		}
		if(playerList[myID] != null){
			myPlayer = playerList[myID];
		}
		/*
		if(config){
			applyConfigs();
		}
		*/
	});

	server.on("playerJoin", function(appendPlayerList){
		clientList[appendPlayerList.id] = appendPlayerList.id;
		appendNewPlayer(appendPlayerList.player);
	});
	server.on("playerLeft", function(id){
		var name = clientList[id];
		if(name != null){
			console.log(playerList);
			console.log(name + " disconnected");
			delete clientList[id];
			delete playerList[id];
			console.log(playerList);
			return;
		}
		console.log("I disconnected");
	});

    return server;
}

function clientSendStart(){
	server.emit('enterGame');
}

