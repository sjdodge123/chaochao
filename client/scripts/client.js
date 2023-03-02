var config,
	timeSinceLastCom = 0,
	ping = 0,
	promises = [],
	pingTimeout = null,
	lastTime = null,
	totalPlayers = 0,
	serverTimeoutWait = 5,
	playerWon = null;

function clientConnect() {
	var server = io();

	server.on('welcome', function (id) {
		myID = id;
	});

	server.on("drop", function () {
		calcPing();
	});
	server.on("roomNotFound", function () {
		alert("Game ID not found");
	})

	server.on("serverKick", function () {
		server.disconnect();
		window.parent.location.href = "./index.html";
	});


	server.on("gameState", function (gameState) {
		config = gameState.config;
		round = gameState.round;
		gameLength = config.baseNotchesToWin;
		clientList = gameState.clientList;
		gameID = gameState.gameID;
		checkGameState(gameState.game);
		connectSpawnPlayers(gameState.playerList);
		worldResize(gameState.world);
		interval = config.serverTickSpeed;
		gameRunning = true;
		playSoundAfterFinish(lobbyMusic);
		init();
		loadPatterns();
		if (gameState.myID != null) {
			myID = gameState.myID;
		}
		if (playerList[myID] != null) {
			myPlayer = playerList[myID];
		}
		setupEmojiWheel();
	});

	server.on("playerJoin", function (appendPlayerList) {
		clientList[appendPlayerList.id] = appendPlayerList.id;
		appendNewPlayer(appendPlayerList.player);
		playSound(playerJoinSound);
	});
	server.on("playerLeft", function (id) {
		var name = clientList[id];
		if (name != null) {
			delete clientList[id];
			delete playerList[id];
			return;
		}
	});

	server.on("gameUpdates", function (updatePacket) {
		updatePlayerList(updatePacket.playerList);
		updateProjecileList(updatePacket.projList);
		updateAimerList(updatePacket.aimerList);
		checkGameState(updatePacket.state);
		totalPlayers = updatePacket.totalPlayers;
		timeSinceLastCom = 0;
	});

	server.on("newMap", function (payload) {
		$.when.apply($, promises).then(function () {
			currentState = payload.currentState;
			loadNewMap(payload.id);
			round = payload.round;
			applyRandomTiles(payload.randomTiles);
			applyAbilites(payload.abilities);
			applyBrutalMap(payload.brutalRoundConfig);
			loadPatterns();
			clearInfection();
			stopSound(lobbyMusic);
		});

	});

	server.on("maplisting", function (mapnames) {
		for (var i = 0; i < mapnames.length; i++) {
			promises.push($.getJSON("../maps/" + mapnames[i], function (data) {
				maps.push(data);
			}));
		}
	});
	server.on("contentDelivery", function (payload) {
		var payload = JSON.parse(payload);
		var mapnames = payload.mapnames;
		var soundnames = payload.soundnames;
		var imagenames = payload.imagenames;
		for (var i = 0; i < imagenames.length; i++) {
			promises.push($.get("../assets/img/" + imagenames[i]));
		}
		for (var i = 0; i < mapnames.length; i++) {
			promises.push($.getJSON("../maps/" + mapnames[i], function (data) {
				maps.push(data);
			}));
		}
		for (var i = 0; i < soundnames.length; i++) {
			promises.push($.get("../assets/sounds/" + soundnames[i]));
		}
		setupPage();
	});

	server.on("firstPlaceWinner", function (id) {
		createFirstRankSymbol(id);
	});
	server.on("secondPlaceWinner", function (id) {
		createSecondRankSymbol(id);
	});
	server.on("playerConcluded", function (id) {
		playerList[id].alive = false;
		playSound(playerFinished);
	});
	server.on("playerDied", function (id) {
		playSound(playerDiedSound);
		playerAbilityUsed(id);
		playerList[id].alive = false;
		playerList[id].onFire = 0;
		playerList[id].deathMessage = '💀';
		createDownRankSymbol(id);
	});
	server.on("playerInfected", function (id) {
		playerList[id].alive = true;
		playerList[id].deathMessage = null;
		playerList[id].infected = true;
		playSound(newZombie);
	});
	server.on("broadCastEmoji", function (payload) {
		playerList[payload.ownerId].chatMessage = payload.emoji;
		setTimeout(function (owner) {
			playerList[owner].chatMessage = null;
		}, 4000, payload.ownerId);
	});
	server.on('playerSleeping', function (id) {
		playerList[id].awake = false;
	});
	server.on('playerAwake', function (id) {
		playerList[id].awake = true;
	});

	//Game State Map changes
	server.on("startWaiting", function (packet) {
		currentState = config.stateMap.waiting;
		playSoundAfterFinish(lobbyMusic);
	});
	server.on("startLobby", function (packet) {
		spawnLobbyStartButton(packet);
		playSoundAfterFinish(lobbyMusic);
		currentState = config.stateMap.lobby;
	});
	server.on("startGated", function (packet) {
		stopSound(lobbyMusic);
		playSound(gameStart);
		currentState = config.stateMap.gated;
	});
	server.on("startRace", function (packet) {
		playSound(countDownB);
		playBackgroundSound();
		oldNotches = {};
		resetTrails();
		resetPlayerRanks();
		currentState = config.stateMap.racing;
		for (var i = 0; i < pingIntervals.length; i++) {
			clearInterval(pingIntervals[i]);
		}

	});
	server.on("startOverview", function (packet) {
		resetRound();
		stopSound(lavaCollapse);
		resetTrails();
		updatePlayerNotches(packet.notchUpdates);
		calculateNotchMoveAmt();
		loadMapPreview(packet.nextMapID);
		currentState = config.stateMap.overview;
	});
	server.on("startGameover", function (player) {
		playerWon = player;
		stopAllSounds();
		playSound(gameOverSound);
		decodedColorName = Colors.decode(playerList[player].color);
		currentState = config.stateMap.gameOver;
	});
	server.on("startCollapse", function () {
		currentState = config.stateMap.collapsing;
		playSound(lavaCollapse);
	});

	server.on("resetPlayers", function () {
		resetPlayers();
	});
	server.on("resetProjectiles", function () {
		resetProjectiles();
	});
	server.on("resetGame", function () {
		fullReset();
	});
	server.on("gameLength", function (length) {
		gameLength = length;
	});

	server.on("punch", function (packet) {
		var punch = spawnPunch(packet);
		if (playerList[punch.ownerId].infected) {
			playSound(zombieSwing);
		}
		else {
			playSound(meleeSound);
		}

	});
	server.on("spawnBomb", function (owner) {
		spawnBomb(owner);
		playSound(bombShot);
	});
	server.on("spawnPuck", function (owner) {
		spawnPuck(owner);
		playSound(bombShot);
	});
	server.on("spawnSnowFlake", function (owner) {
		spawnSnowFlake(owner);
		playSound(bombShot);
	});
	server.on("spawnClouds", function (packet) {
		spawnClouds(packet);
	});
	server.on("playerPunched", function (owner) {
		if (playerList[owner] == null) {
			playSound(meleeHitSound);
			return;
		}
		if (playerList[owner].infected) {
			playSound(zombieHit);
		}
	});
	server.on("terminatePunch", function (id) {
		terminatePunch(id);
	});
	server.on("terminateProj", function (id) {
		terminateProj(id);
	});
	server.on("terminateAimer", function (id) {
		terminateAimer(id);
	});
	server.on('collapsedCells', function (cells) {
		$.when.apply($, promises).then(function () {
			collapseCells(cells);
		});
	});
	server.on('explodedCells', function (cells) {
		explodedCells(cells);
		playSound(bombExplosion);
	});
	server.on("snowFlakeExploded", function (owner) {
		playSound(iceExplosion);
	});
	server.on("firstBlood", function () {
		playSound(firstBlood);
	});
	server.on("onFire", function (packet) {
		var owner = packet.owner;
		var value = packet.value;
		if (playerList[owner] != null) {
			playerList[owner].onFire = value;
		}
	});
	server.on("multiKill", function (count) {
		console.log("multiKill: " + count);
		if (count == 2) {
			playSound(doubleKill);
		}
		if (count == 3) {
			playSound(tripleKill);
		}
		if (count > 3) {
			playSound(megaKill);
		}
	});
	server.on("killingSpree", function (player) {
		playSound(killingSpree);
	});
	server.on("rampage", function (player) {
		playSound(rampage);
	});
	server.on("godLike", function (player) {
		playSound(godLike);
	});
	server.on("fizzle", function (owner) {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
			if (playerList[owner] != null) {
				playerList[owner].fizzle();
			}
		}
	});
	server.on("abilityAcquired", function (payload) {
		playerPickedUpAbility(payload);
		playSound(collectItem);
	});
	server.on("allAbilityHoldings", function (payload) {
		$.when.apply($, promises).then(function () {
			var abilities = JSON.parse(payload);
			for (var id in abilities) {
				playerPickedUpAbility(abilities[id]);
			}
		});
	});
	server.on("tileChanges", function (payload) {
		$.when.apply($, promises).then(function () {
			var tileChanges = JSON.parse(payload);
			changeTilesBulk(tileChanges);
		});
	});

	server.on("projBounced", function () {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
			playSound(bombBounce);
		}
	});
	server.on("blindfoldUsed", function (owner) {
		createBlindFold(owner);
		playerAbilityUsed(owner);
		playSound(blindSound);
	});
	server.on("tileSwap", function (owner) {
		playerAbilityUsed(owner);
		playSound(tileSwap);
	});
	server.on("iceCannon", function (owner) {
		playerAbilityUsed(owner);
		playSound(iceCannon);
	});
	server.on("lavaExplosion", function () {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
			playSound(lavaExplosion);
		}
	});
	server.on("swapUsed", function (owner) {
		playerAbilityUsed(owner);
		spawnAimer(owner);
		aimerList[owner].startSwapCountDown = true;
		var count = 0;
		var int = setInterval(function () {
			if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
				if (aimerList[owner] != undefined) {
					playSound(teleportWarnSound);
					aimerList[owner].swapCountDownPulse = true;
				}
			}
			count++;
			if (count == (config.tileMap.abilities.swap.warnTime / 1000)) {
				if (aimerList[owner] != undefined) {
					aimerList[owner].hide = true;
				}
				clearInterval(int);
			}
		}, 1000);
	});
	server.on("playerSwapped", function (owner) {
		if (aimerList[owner].startSwapCountDown) {
			aimerList[owner].startSwapCountDown = false;
		}
		playSound(teleportSound);
	});
	server.on("bombUsed", function (owner) {
		playerAbilityUsed(owner);
	});
	server.on("volcanoEruption", function () {
		playSound(volcanoErupt);
		screenShake = true;
		setTimeout(function () {
			screenShake = false;
		}, 2500);
	});

	server.on("speedBuff", function (owner) {
		playSound(speedBuff);
		playerAbilityUsed(owner);
	});

	server.on("speedDebuff", function (owner) {
		playSound(speedDebuff);
		playerAbilityUsed(owner);
	});
	server.on("triggerUsed", function (owner) {
		playerAbilityUsed(owner);
	});
	server.on("startLobbyTimer", function () {
		if (lobbyStartButton != null) {
			lobbyStartButton.startSpin = true;
		}
	});
	server.on("resetLobbyTimer", function () {
		if (lobbyStartButton != null) {
			lobbyStartButton.startSpin = false;
		}
	});

	return server;
}

function clientSendStart(id) {
	if (id != null) {
		server.emit('enterGame', id);
	}
}

function pingServer() {
	clearTimeout(pingTimeout);
	lastTime = new Date();
	server.emit('drip');
}
function sendEmoji(emoji) {
	server.emit('sendEmoji', emoji);
}

function calcPing() {
	ping = new Date() - lastTime;
	pingTimeout = setTimeout(pingServer, 1000);
	timeSinceLastCom = 0;
}

function checkForTimeout() {
	timeSinceLastCom++;
	if (timeSinceLastCom > serverTimeoutWait) {
		server.disconnect();
		window.parent.location.reload();
	}
}

