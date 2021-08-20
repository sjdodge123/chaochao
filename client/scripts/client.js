var config,
	playerWon = null;

function clientConnect() {
	var server = io();

    server.on('welcome', function(id){
		myID = id;
	});

	server.on("gameState", function(gameState){
		config = gameState.config;
		clientList = gameState.clientList;
		checkGameState(gameState.game);
		connectSpawnPlayers(gameState.playerList);
		worldResize(gameState.world);
		interval = config.serverTickSpeed;
		gameRunning = true;
		init();
		//Testing overview state
		/*
		currentState = config.stateMap.overview;
		
		for(var i=0;i<10;i++){
			playerList[i] = {};
			playerList[i].id = i;
			playerList[i].color = getColor();
		}
		for(var player in playerList){
			oldNotches[player] = getRandomInt(0,config.playerNotchesToWin-1);
			playerList[player].notches = oldNotches[player] + getRandomInt(-1,2);
		}
		calculateNotchMoveAmt();
		*/
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
			delete clientList[id];
			delete playerList[id];
			return;
		}
	});

	server.on("gameUpdates",function(updatePacket){
		updatePlayerList(updatePacket.playerList);
		checkGameState(updatePacket.state);
		totalPlayers = updatePacket.totalPlayers;
		timeSinceLastCom = 0;

		/*
		if(myShip != null && myShip.weapon != null){
			currentWeaponCooldown = myShip.weapon.cooldown*1000;
		}
		*/
	});
	
	server.on("newMap",function(newMapID){
		loadNewMap(newMapID);
	});
	server.on("firstPlaceWinner",function(id){
		//createFirstRankSymbol();
		playerList[id].alive = false;
	});
	server.on("secondPlaceWinner",function(id){
		//createSecondRankSymbol();
		playerList[id].alive = false;
	});
	server.on("playerDied",function(id){
		//playLavaNoise();
		playerList[id].alive = false;
	});

	//Game State Map changes
	server.on("startWaiting",function(packet){
		currentState = config.stateMap.waiting;
	});
	server.on("startLobby",function(packet){
		spawnLobbyStartButton(packet);
		currentState = config.stateMap.lobby;
	});
	server.on("startGated",function(packet){
		currentState = config.stateMap.gated;
	});
	server.on("startRace",function(packet){
		oldNotches = {};
		resetTrails();
		currentState = config.stateMap.racing;
	});
	server.on("startOverview",function(packet){
		updatePlayerNotches(packet);
		calculateNotchMoveAmt();
		currentState = config.stateMap.overview;
	});
	server.on("startGameover",function(player){
		playerWon = player;
		decodedColorName = Colors.decode(playerList[player].color);
		currentState = config.stateMap.gameOver;
	});

	server.on("resetPlayers",function(){
		resetPlayers();
	});
	server.on("resetGame",function(){
		fullReset();
	});
	server.on("punch",function(packet){
		spawnPunch(packet);
	});
	server.on("terminatePunch",function(id){
		terminatePunch(id);
	});


    return server;
}

function clientSendStart(){
	server.emit('enterGame');
}

