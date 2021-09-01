var config,
	timeSinceLastCom = 0,
	ping = 0,
	pingTimeout = null,
	lastTime = null,
	serverTimeoutWait = 5,
	playerWon = null;

function clientConnect() {
	var server = io();

    server.on('welcome', function(id){
		myID = id;
	});

	server.on("drop",function(){
		calcPing();
	});

	server.on("serverKick",function(){
		alert("You have been kicked from the game due to inactivity.");
		server.disconnect();
		window.parent.location.reload();
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
		loadPatterns();
		if(gameState.myID != null){
			myID = gameState.myID;
		}
		if(playerList[myID] != null){
			myPlayer = playerList[myID];
		}
		setupEmojiWheel();
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
		updateProjecileList(updatePacket.projList);
		checkGameState(updatePacket.state);
		totalPlayers = updatePacket.totalPlayers;
		timeSinceLastCom = 0;
	});
	
	server.on("newMap",function(payload){
		loadNewMap(payload.id);
		applyAbilites(payload.abilities);
	});

	server.on("maplisting",function(mapnames){
		for(var i=0;i<mapnames.length;i++){
			$.getJSON("../maps/" + mapnames[i],function(data){
				maps.push(data);
			});
		}
	});

	server.on("firstPlaceWinner",function(id){
		//createFirstRankSymbol();
		//playerList[id].alive = false;
	});
	server.on("secondPlaceWinner",function(id){
		//createSecondRankSymbol();
		//playerList[id].alive = false;
	});
	server.on("playerConcluded",function(id){
		playerList[id].alive = false;
	});
	server.on("playerDied",function(id){
		//playLavaNoise();
		playerAbilityUsed(id);
		playerList[id].alive = false;
		playerList[id].deathMessage = '💀';
	});
	server.on("broadCastEmoji",function(payload){
		playerList[payload.ownerId].chatMessage = payload.emoji;
		setTimeout(function(owner){
			playerList[owner].chatMessage = null;
		},4000,payload.ownerId);
	});
	server.on('playerSleeping',function(id){
		playerList[id].awake = false;
	});
	server.on('playerAwake',function(id){
		playerList[id].awake = true;
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
	server.on("startCollapse",function(){
		currentState = config.stateMap.collapsing;
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
	server.on("spawnBomb",function(owner){
		spawnBomb(owner);
	});
	server.on("terminatePunch",function(id){
		terminatePunch(id);
	});
	server.on("terminateBomb",function(id){
		terminateBomb(id);
	});
	server.on('collapsedCells',function(cells){
		collapseCells(cells);
	});
	server.on('explodedCells',function(cells){
		explodedCells(cells);
	});
	server.on("abilityAcquired",function(payload){
		playerPickedUpAbility(payload);
	});
	server.on("blindfoldUsed",function(owner){
		createBlindFold(owner);
		playerAbilityUsed(owner);
	});
	server.on("swapUsed",function(owner){
		playerAbilityUsed(owner);
	});
	server.on("bombUsed",function(owner){
		playerAbilityUsed(owner);
	});

    return server;
}

function clientSendStart(){
	server.emit('enterGame');
}

function pingServer(){
	clearTimeout(pingTimeout);
	lastTime = new Date();
	server.emit('drip');
}
function sendEmoji(emoji){
	server.emit('sendEmoji',emoji);
}

function calcPing(){
	ping = new Date() - lastTime;
	pingTimeout = setTimeout(pingServer,1000);
	timeSinceLastCom = 0;
}

function checkForTimeout(){
	timeSinceLastCom++;
	if(timeSinceLastCom > serverTimeoutWait){
		server.disconnect();
		window.parent.location.reload();
	}
}

