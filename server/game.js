'use strict';
var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');
var hostess = require('./hostess.js');
var _engine = require('./engine.js');
var compressor = require('./compressor.js');

exports.getRoom = function (sig, size) {
	return new Room(sig, size);
}

class Room {
	constructor(sig, size) {
		this.sig = sig;
		this.size = size;
		this.clientList = {};
		this.playerList = {};
		this.aimerList = {};
		this.projectileList = {};
		this.hazardList = {};
		this.clientCount = 0;
		this.alive = true;
		this.engine = _engine.getEngine(this.playerList, this.projectileList, this.hazardList);
		this.world = new World(0, 0, c.worldWidth, c.worldHeight, this.engine, this.playerList, this.hazardList, this.sig);
		this.game = new Game(this.clientList, this.playerList, this.projectileList, this.aimerList, this.hazardList, this.world, this.engine, this.sig);
	}
	join(clientID) {
		var client = messenger.getClient(clientID);
		messenger.addRoomToMailBox(clientID, this.sig);
		client.join(String(this.sig));
		this.clientCount++;
	}
	leave(clientID) {
		messenger.messageRoomBySig(this.sig, 'playerLeft', clientID);
		messenger.removeRoomMailBox(clientID);
		var client = messenger.getClient(clientID);
		client.leave(String(this.sig));
		delete this.clientList[clientID];
		delete this.playerList[clientID];
		this.clientCount--;
	}
	update(dt) {
		this.checkAFK();
		this.game.update(dt);
		this.sendUpdates();
	}
	sendUpdates() {
		var playerData = compressor.sendPlayerUpdates(this.playerList);
		var projData = compressor.sendProjUpdates(this.projectileList);
		var aimerData = compressor.sendAimerUpdates(this.aimerList);
		var gameStateData = compressor.gameState(this.game);
		messenger.messageRoomBySig(this.sig, "gameUpdates", {
			playerList: playerData,
			projList: projData,
			aimerList: aimerData,
			state: gameStateData,
			totalPlayers: this.game.playerCount
		});
	}
	checkRoom(clientID) {
		for (var id in this.clientList) {
			if (id == clientID) {
				return true;
			}
		}
		return false;
	}
	checkAFK() {
		for (var id in this.playerList) {
			if (this.playerList[id].kick) {
				messenger.messageClientBySig(id, "serverKick", null);
				hostess.kickFromRoom(id);
			}
		}
	}
	hasSpace() {
		if (this.clientCount < this.size) {
			return true;
		}
		return false;
	}
	isLocked() {
		return this.game.locked;
	}
}

class Game {
	constructor(clientList, playerList, projectileList, aimerList, hazardList, world, engine, roomSig) {
		this.clientList = clientList;
		this.playerList = playerList;
		this.projectileList = projectileList;
		this.aimerList = aimerList;
		this.hazardList = hazardList;
		this.roomSig = roomSig;
		this.world = world;
		this.engine = engine;
		this.gameEnded = false;
		this.locked = false;

		//Game stats
		this.playerCount = 0;
		this.alivePlayerCount = 0;
		this.sleepingPlayerCount = 0;
		this.lobbyButtonPressedCount = 0;
		this.collapseInitated = false;
		this.notchesToWin = c.baseNotchesToWin;
		this.firstPlaceSig = null;
		this.secondPlaceSig = null;

		//Timers
		this.lobbyWaitTime = c.lobbyWaitTime;
		this.lobbyTimer = null;
		this.lobbyTimeLeft = this.lobbyWaitTime;

		this.gatedWaitTime = c.gatedWaitTime;
		this.gatedTimer = null;
		this.gatedTimeLeft = this.gatedWaitTime;

		this.newRaceWaitTime = c.newRaceWaitTime;
		this.newRaceTimer = null;
		this.newRaceTimeLeft = this.newRaceWaitTime;

		this.gameOverWaitTime = c.gameOverTime;
		this.gameOverTimer = null;
		this.gameOverTimeLeft = this.gameOverWaitTime;

		//State mgmt
		this.stateMap = c.stateMap;
		this.currentState = this.stateMap.waiting;
		this.gameBoard = new GameBoard(world, playerList, projectileList, aimerList, hazardList, engine, roomSig);
	}

	update(dt) {
		this.getPlayerCount();
		//In Waiting State
		if (this.currentState == this.stateMap.waiting) {
			this.checkLobbyStart();
		}
		//In Lobby State
		if (this.currentState == this.stateMap.lobby) {
			this.checkGatedStart();
		}
		//In Gated State
		if (this.currentState == this.stateMap.gated) {
			this.checkRacingStart();
		}
		//In Racing State or Collapse State
		if (this.currentState == this.stateMap.racing || this.currentState == this.stateMap.collapsing) {
			this.checkForWinners();
		}
		//In Overview State
		if (this.currentState == this.stateMap.overview) {
			this.checkNewRaceTimer();
		}

		//In Gameover state
		if (this.currentState == this.stateMap.gameOver) {
			this.checkGameOverTimer();
		}
		this.gameBoard.update(this.currentState, this.alivePlayerCount, this.sleepingPlayerCount, dt);
		this.world.update(dt);
	}
	getState() {
		return this.currentState;
	}
	getPlayerColors() {
		var colors = [];
		for (var id in this.playerList) {
			var player = this.playerList[id];
			colors.push(player.color);
		}
		return colors;
	}
	determineGameState(newPlayer) {
		if (this.currentState == c.stateMap.waiting || this.currentState == c.stateMap.lobby || this.currentState == c.stateMap.gameOver) {
			this.world.spawnPlayerRandomLoc(newPlayer);
			return;
		}
		if (this.currentState == c.stateMap.gated) {
			this.gameBoard.gatePlayer(newPlayer);
		}
		if (this.currentState == c.stateMap.racing || this.currentState == c.stateMap.collapsing) {
			this.gameBoard.setTempSpectator(newPlayer);
		}
		this.world.setSpawnLocation(newPlayer);
	}
	checkSendGameStateUpdates(client) {
		if (this.currentState == c.stateMap.waiting || this.currentState == c.stateMap.lobby || this.currentState == c.stateMap.gameOver) {
			return;
		}
		//Send map configuration - Change current state so that its accurate
		this.gameBoard.newMapPayload.currentState = this.currentState;
		client.emit("newMap", this.gameBoard.newMapPayload);
		//Send map tile changes
		client.emit("tileChanges", JSON.stringify(this.gameBoard.gatherTileChanges()));
		//Send current abilities
		client.emit("allAbilityHoldings", JSON.stringify(this.gameBoard.gatherAbilities()));
	}
	checkLobbyStart() {
		if (this.playerCount >= c.minPlayersToStart) {
			this.startLobby();
		}
	}
	checkGatedStart() {
		//Reset back to waiting if someone leaves
		if (this.playerCount < c.minPlayersToStart) {
			this.startWaiting();
		}
		//If majority of players stand on the gamestart button start the timer
		var percentPlayers = (this.lobbyButtonPressedCount / this.playerCount) * 100;
		if (percentPlayers > 50) {
			this.startLobbyTimer();
			return;
		}
		this.resetLobbyTimer();
	}
	checkRacingStart() {
		if (this.gatedTimer != null) {
			this.gatedTimeLeft = ((this.gatedWaitTime * 1000 - (Date.now() - this.gatedTimer)) / (1000)).toFixed(1);
			if (this.gatedTimeLeft > 0) {
				return;
			}
			this.resetGatedTimer();
			this.startRace();
			return;
		}
		this.gatedTimer = Date.now();
	}
	checkNewRaceTimer() {
		if (this.newRaceTimer != null) {
			this.newRaceTimeLeft = ((this.newRaceWaitTime * 1000 - (Date.now() - this.newRaceTimer)) / (1000)).toFixed(1);
			if (this.newRaceTimeLeft > 0) {
				return;
			}
			this.newRaceTimer = null;
			this.startGated();
			return;
		}
		this.newRaceTimer = Date.now();
	}
	checkGameOverTimer() {
		if (this.gameOverTimer != null) {
			this.gameOverTimeLeft = ((this.gameOverWaitTime * 1000 - (Date.now() - this.gameOverTimer)) / (1000)).toFixed(1);
			if (this.gameOverTimeLeft > 0) {
				return;
			}
			this.gameOverTimer = null;
			this.resetGame();
			this.startWaiting();
			return;
		}
		this.gameOverTimer = Date.now();
	}
	startLobbyTimer() {
		if (this.lobbyTimer != null) {
			this.lobbyTimeLeft = ((this.lobbyWaitTime * 1000 - (Date.now() - this.lobbyTimer)) / (1000)).toFixed(1);
			if (this.lobbyTimeLeft > 0) {
				return;
			}
			this.checkForDynamicGameLength();
			this.resetLobbyTimer();
			this.startGated();
			return;
		}
		this.lobbyTimer = Date.now();
		messenger.messageRoomBySig(this.roomSig, "startLobbyTimer");
	}
	checkForWinners() {
		var playersConcluded = 0;

		for (var player in this.playerList) {
			if (!this.playerList[player].alive && !this.playerList[player].reachedGoal) {
				playersConcluded++;

				if (this.playerList[player].murderedBy != null) {
					var killer = this.playerList[this.playerList[player].murderedBy];
					if (killer != null) {
						this.playerList[player].murderedBy = null;
						killer.addKill(this.playerList[player]);
						this.gameBoard.checkForFirstBlood();
					}
				}

				if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.infection.id)) {
					this.playerList[player].infect();
				}
				if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.explosive.id)) {
					if (this.playerList[player].exploded == false) {
						this.gameBoard.createExplosionAimer({ x: this.playerList[player].x, y: this.playerList[player].y }, 1, this.playerList[player].id);
						this.playerList[player].exploded = true;
					}
				}
				continue;
			}
			if (this.playerList[player].isSpectator) {
				playersConcluded++
				continue;
			}
			if (this.playerList[player].awake == false) {
				playersConcluded++
				continue;
			}
			if (this.playerList[player].isZombie) {
				playersConcluded++;
				continue;
			}
			if (this.playerList[player].reachedGoal == true) {
				playersConcluded++;
				if (this.firstPlaceSig == null) {
					if (this.playerList[player].notches == this.notchesToWin) {
						//Game over player wins
						this.gameOver(player);
						return;
					}
					this.firstPlaceSig = player;
					this.playerList[player].addNotch(this.notchesToWin);
					this.playerList[player].addNotch(this.notchesToWin);
					this.gameBoard.firstPlaceSig = player;
					this.startCollapse(this.playerList[player].x, this.playerList[player].y);
					messenger.messageRoomBySig(this.roomSig, "firstPlaceWinner", player);
					continue;
				}
				if (this.secondPlaceSig == null && player != this.firstPlaceSig) {
					this.secondPlaceSig = player;
					messenger.messageRoomBySig(this.roomSig, "secondPlaceWinner", player);
					this.playerList[player].addNotch(this.notchesToWin);
					continue;
				}
			}
		}
		this.alivePlayerCount = this.playerCount - playersConcluded;

		if (playersConcluded == this.playerCount) {
			this.gameBoard.killAFKPlayers();
			this.startOverview();
		}

		//Start slow collapse if last player alive
		if (this.alivePlayerCount == 1) {
			if (this.currentState != c.stateMap.collapsing && !this.collapseInitated) {
				this.collapseInitated = true;
				setTimeout(function (context) {
					if (context.currentState == c.stateMap.racing || context.currentState == c.stateMap.collapsing) {
						var goal = context.gameBoard.findRandomGoalTile();
						context.startCollapse(goal.x, goal.y);
					}
				}, 5000, this);
			}
		}
	}
	startWaiting() {
		messenger.messageRoomBySig(this.roomSig, "startWaiting", null);
		this.currentState = this.stateMap.waiting;
	}
	startLobby() {
		console.log("Start Lobby")
		this.currentState = this.stateMap.lobby;
		this.world.resize();
		this.gameBoard.startLobby();
	}
	startGated() {
		console.log("Start Gated");
		this.locked = true;
		this.resetForRace();
		this.currentState = this.stateMap.gated;
		this.gameBoard.setupMap(this.currentState);
		messenger.messageRoomBySig(this.roomSig, "startGated", null);
	}
	startRace() {
		console.log("Start Race");
		this.currentState = this.stateMap.racing;

		var lightningRound = this.gameBoard.checkForActiveBrutal(c.brutalRounds.lightning.id);

		if (!lightningRound) {
			for (var id in this.playerList) {
				this.playerList[id].setSpeedBonus(0);
			}
		}
		if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.volcano.id)) {
			var eruptionDelay = utils.getRandomInt(8, 15);
			if (lightningRound) {
				eruptionDelay = utils.getRandomInt(1, 4);
			}
			setTimeout(this.gameBoard.warnOfPendingVolcano, (eruptionDelay - 2) * 1000, { context: this });
			setTimeout(this.gameBoard.applyBrutalVolcanoRound, eruptionDelay * 1000, { context: this });
		}

		if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.hockey.id)) {
			var puckSpawnDelay = utils.getRandomInt(3, 5);
			if (lightningRound) {
				puckSpawnDelay = utils.getRandomInt(1, 3);
			}
			setTimeout(this.gameBoard.applyBrutalHockeyRound, puckSpawnDelay * 1000, { context: this });
		}


		messenger.messageRoomBySig(this.roomSig, "startRace", null);
	}

	startOverview() {
		console.log("Start Overview");
		this.currentState = this.stateMap.overview;
		var nextMapID = this.gameBoard.determineNextMap();
		this.collapseInitated = false;
		messenger.messageRoomBySig(this.roomSig, 'startOverview', { notchUpdates: compressor.sendNotchUpdates(this.playerList), nextMapID: nextMapID });
	}
	startCollapse(xloc, yloc) {
		console.log("Start Collapse");
		this.currentState = this.stateMap.collapsing;
		this.gameBoard.startCollapse({ x: xloc, y: yloc });
		messenger.messageRoomBySig(this.roomSig, "startCollapse", null);
	}
	resetLobbyTimer() {
		this.lobbyTimer = null;
		messenger.messageRoomBySig(this.roomSig, "resetLobbyTimer");
	}
	resetGatedTimer() {
		this.gatedTimer = null;
	}
	resetForRace() {
		this.firstPlaceSig = null;
		this.secondPlaceSig = null;
		this.gameBoard.firstPlaceSig = null;
	}
	resetGame() {
		this.locked = false;
		this.collapseInitated = false;
		this.notchesToWin = c.baseNotchesToWin;
		this.gameBoard.resetGame(this.currentState);
		messenger.messageRoomBySig(this.roomSig, "resetGame", null);
	}
	getPlayerCount() {
		var playerCount = 0;
		var sleepingPlayerCount = 0;
		var lobbyButtonPressedCount = 0;
		for (var playerID in this.playerList) {
			if (this.playerList[playerID].hittingLobbyButton) {
				this.playerList[playerID].hittingLobbyButton = false;
				lobbyButtonPressedCount++;
			}
			if (!this.playerList[playerID].awake) {
				sleepingPlayerCount++;
			}
			playerCount++;
		}
		this.lobbyButtonPressedCount = lobbyButtonPressedCount;
		this.playerCount = playerCount;
		this.sleepingPlayerCount = sleepingPlayerCount;
		return playerCount;
	}
	checkForDynamicGameLength() {
		//For every dynamicGameLengthModifier players the number of notches to win decreases by 1
		var dynamicGameLengthModifier = 6;

		if (this.playerCount < dynamicGameLengthModifier) {
			return;
		}
		var notchesToRemove = Math.ceil(this.playerCount / dynamicGameLengthModifier);
		var minimumNotches = c.minimumNotchesToWin;
		if (this.notchesToWin - notchesToRemove <= minimumNotches) {
			this.notchesToWin = minimumNotches;
		} else {
			this.notchesToWin = this.notchesToWin - notchesToRemove;
		}
		messenger.messageRoomBySig(this.roomSig, 'gameLength', this.notchesToWin);
	}
	gameOver(player) {
		console.log("Game Over");
		this.currentState = this.stateMap.gameOver;
		messenger.messageRoomBySig(this.roomSig, 'startGameover', { winner: player, achievements: this.gatherAchievements() });
	}
	gatherAchievements() {
		return null;
		var achievements = {
			mostKills: { id: null, value: 0, title: "Most kills" },
			mostMurdered: { id: null, value: 0, title: "Most murdered" },
			mostBrutals: { id: null, value: 0, title: "Most brutal victories" },
			bully: { id: null, value: 0, title: "Most aggresive" },
			gameSaves: { id: null, value: 0, title: "Saved the game" },
		};
		for (var id in this.playerList) {
			var player = this.playerList[id];
			if (player.totalKills > achievements.mostKills.value) {
				achievements.mostKills.id = id;
				achievements.mostKills.value = player.totalKills;
			}
			if (player.savier > achievements.gameSaves.value) {
				achievements.gameSaves.id = id;
				achievements.gameSaves.value = player.savier;
			}
		}
		return achievements;
	}
}

class GameBoard {
	constructor(world, playerList, projectileList, aimerList, hazardList, engine, roomSig) {
		this.world = world;
		this.playerList = playerList;
		this.projectileList = projectileList;
		this.hazardList = hazardList;
		this.abilityList = {};
		this.tempSpectatorList = {};
		this.tileChanges = {};
		this.punchList = {};
		this.aimerList = aimerList;
		this.engine = engine;
		this.roomSig = roomSig;
		this.stateMap = c.stateMap;
		this.newMapPayload = null;

		this.chanceToSpawnAbility = c.chanceToSpawnAbility;
		this.chanceOfBrutalRound = c.chanceOfBrutalRound;
		this.chanceForAdditionalBrutal = c.chanceForAdditionalBrutal;
		this.round = 0;
		this.firstBlood = false;
		this.brutalRound = false;
		this.brutalConfig = null;

		this.lobbyStartButton;
		this.alivePlayerCount = 0;
		this.sleepingPlayerCount = 0;
		this.startingGate = null;
		this.maps = utils.loadMaps();
		this.mapsPlayed = [];
		this.currentMap = {};
		this.nextMap = {};

		this.allAbilityIDs = this.indexAbilities();
		this.collapseLoc = {};
		this.collapseLine = this.world.height;
		this.firstPlaceSig = null;
	}
	update(currentState, playerAliveCount, sleepingPlayerCount, dt) {
		this.alivePlayerCount = playerAliveCount;
		this.sleepingPlayerCount = sleepingPlayerCount;
		this.engine.update(dt);
		this.collapseMap(currentState);
		this.checkCollisions(currentState);
		this.updatePlayers(currentState, dt);
		this.updateProjectiles(currentState);
		this.checkAbilities(currentState);
		this.updateAimers(currentState);
		this.updateHazards(currentState);
	}
	checkCollisions(currentState) {
		var objectArray = [];
		if (currentState == this.stateMap.waiting) {
			for (var player in this.playerList) {
				_engine.preventEscape(this.playerList[player], this.world);
			}
			return;
		}
		if (currentState == this.stateMap.lobby) {
			for (var player in this.playerList) {
				if (!this.playerList[player].alive) {
					continue;
				}
				_engine.preventEscape(this.playerList[player], this.world);
				objectArray.push(this.playerList[player]);
			}
			for (var punchId in this.punchList) {
				objectArray.push(this.punchList[punchId]);
			}
			objectArray.push(this.lobbyStartButton);
		}
		if (currentState == this.stateMap.gated) {
			for (var player in this.playerList) {
				if (!this.playerList[player].alive) {
					continue;
				}
				_engine.preventEscape(this.playerList[player], this.world);
				_engine.preventEscape(this.playerList[player], this.startingGate);
				objectArray.push(this.playerList[player]);
			}
			for (var punchId in this.punchList) {
				objectArray.push(this.punchList[punchId]);
			}
		}
		if (currentState == this.stateMap.racing || currentState == this.stateMap.collapsing) {
			for (var player in this.playerList) {
				if (!this.playerList[player].alive) {
					continue;
				}
				if (currentState == this.stateMap.collapsing) {
					objectArray.push(this.startingGate);
				}
				_engine.preventEscape(this.playerList[player], this.world);
				_engine.checkCollideCells(this.playerList[player], this.currentMap);
				objectArray.push(this.playerList[player]);
			}
			for (var projID in this.projectileList) {
				if (this.projectileList[projID].type == "cloud") {
					_engine.checkFlipAroundWorld(this.projectileList[projID], this.world);
					continue;
				}
				_engine.bounceOffBoundry(this.projectileList[projID], this.world);
				if (this.projectileList[projID].type == "snowFlake") {
					_engine.checkCollideCells(this.projectileList[projID], this.currentMap);
				}
				objectArray.push(this.projectileList[projID]);
			}
			for (var punchId in this.punchList) {
				objectArray.push(this.punchList[punchId]);
			}
			for (var aimerId in this.aimerList) {
				objectArray.push(this.aimerList[aimerId]);
			}
			for (var hazardId in this.hazardList) {
				objectArray.push(this.hazardList[hazardId]);
			}
		}

		this.engine.broadBase(objectArray);
	}
	checkAbilities(currentState) {
		for (var id in this.abilityList) {
			if (this.abilityList[id].swap) {
				this.abilityList[id].swap = false;
				var aimer = new SwapAimer(this.playerList[this.abilityList[id].ownerId].x, this.playerList[this.abilityList[id].ownerId].y, c.tileMap.abilities.swap.startSize, "red", this.abilityList[id].ownerId, this.roomSig);
				this.aimerList[this.abilityList[id].ownerId] = aimer;
				var packet = { owner: this.abilityList[id].ownerId, aimer: aimer, context: this };
				setTimeout(this.swapOwnerWithRandomPlayer, c.tileMap.abilities.swap.warnTime + utils.getRandomInt(1000, 4000), packet);
			}
			if (this.abilityList[id].spawnBomb) {
				this.abilityList[id].spawnBomb = false;
				this.spawnBomb(this.abilityList[id].ownerId);
				setTimeout(this.acquireBombTrigger, 200, { id: this.abilityList[id].ownerId, abilityList: this.abilityList, playerList: this.playerList, roomSig: this.roomSig });
			}
			if (this.abilityList[id].spawnSnowFlake) {
				this.abilityList[id].spawnSnowFlake = false;
				this.spawnSnowFlake(this.abilityList[id].ownerId);
			}
			if (this.abilityList[id].explodeBomb) {
				this.abilityList[id].explodeBomb = false;
				this.projectileList[this.abilityList[id].ownerId].explodeBomb();
			}
			if (this.abilityList[id].applyBuff) {
				this.abilityList[id].applyBuff = false;
				setTimeout(this.removeSpeedBuff, c.tileMap.abilities.speedBuff.duration, { id: this.abilityList[id].ownerId, playerList: this.playerList, delta: this.applySpeedBuff(this.abilityList[id].ownerId) });
			}
			if (this.abilityList[id].applyDebuff) {
				this.abilityList[id].applyDebuff = false;
				setTimeout(this.removeSpeedDebuff, c.tileMap.abilities.speedDebuff.duration, { id: this.abilityList[id].ownerId, playerList: this.playerList, deltaList: this.applySpeedDebuff(this.abilityList[id].ownerId) });
			}
			if (this.abilityList[id].tileSwap) {
				this.abilityList[id].tileSwap = false;
				this.swapTiles();
			}
			if (this.abilityList[id].applyCut) {
				this.abilityList[id].applyCut = false;
				this.cutPlayers(id);
			}
			if (this.abilityList[id].alive == false) {
				if (this.playerList[this.abilityList[id].ownerId] != undefined) {
					this.playerList[this.abilityList[id].ownerId].ability = null;
				}
				delete this.abilityList[id];
			}
		}
	}
	updatePlayers(currentState, dt) {
		for (var playerID in this.playerList) {
			var player = this.playerList[playerID];
			if (player.acquiredAbility != null) {
				this.abilityList[playerID] = player.ability;
				if (player.acquiredAbility.mapID != null) {
					this.changeTile(player.acquiredAbility.mapID, c.tileMap.normal.id);
				}
				player.acquiredAbility = null;
			}
			player.update(currentState, dt);
			if (player.punch != null) {
				this.punchList[player.id] = player.punch;
				setTimeout(this.terminatePunch, 100, { id: player.id, punchList: this.punchList, roomSig: this.roomSig });
				player.punch = null;
			}
		}
	}
	updateProjectiles(currentState) {
		for (var id in this.projectileList) {

			if (this.projectileList[id].explode == true) {
				this.explodeBomb(id);
			}
			if (this.projectileList[id].explodeIce == true) {
				this.explodeIce(id);
			}
			if (this.projectileList[id].tileChanges != null && Object.keys(this.projectileList[id].tileChanges).length > 0) {
				for (var vid in this.projectileList[id].tileChanges) {
					this.changeTile(vid, this.projectileList[id].tileChanges[vid]);
					delete this.projectileList[id].tileChanges[vid];
				}
				messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(this.gatherTileChanges()));
			}

			if (this.projectileList[id].alive == false) {
				messenger.messageRoomBySig(this.roomSig, "terminateProj", id);
				delete this.projectileList[id];
				continue;
			}
			this.projectileList[id].update();
		}

	}
	updateAimers(currentState) {
		for (var id in this.aimerList) {
			if (this.playerList[id] != null) {
				if (this.aimerList[id].alive) {
					this.aimerList[id].update(this.playerList[id]);
					if (this.aimerList[id].isExplosionAimer && this.aimerList[id].explode) {
						this.explodeLava({ x: this.aimerList[id].x, y: this.aimerList[id].y }, this.aimerList[id].radius);
						this.aimerList[id].killSelf();
					}
				}

			}

		}
	}
	updateHazards(currentState) {
		for (var id in this.hazardList) {
			var hazard = this.hazardList[id];
			hazard.update();
			if (hazard.punch != null && this.punchList[hazard.ownerId] == null) {
				this.punchList[hazard.ownerId] = hazard.punch;
				messenger.messageRoomBySig(this.roomSig, "punch", compressor.sendPunch(hazard.punch));
				setTimeout(this.terminatePunch, 100, { id: hazard.ownerId, punchList: this.punchList, roomSig: this.roomSig });
				hazard.punch = null;
			}
		}
	}

	gatherAbilities() {
		var abilities = {};
		for (var id in this.playerList) {
			var player = this.playerList[id];
			if (player.ability == null) {
				continue;
			}
			abilities[player.id] = { owner: player.id, ability: player.ability.id, voronoiId: null };
		}
		return abilities;
	}
	gatherTileChanges() {
		return this.tileChanges;
	}

	swapTiles() {
		//Find all fast tiles, find all ice tiles, swap them
		var cells = this.currentMap.cells;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.fast.id) {
				cells[i].id = c.tileMap.ice.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				continue;
			}
			if (cells[i].id == c.tileMap.ice.id) {
				cells[i].id = c.tileMap.fast.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				continue;
			}
		}
		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(this.gatherTileChanges()));
	}
	cutPlayers(owner) {
		for (var id in this.playerList) {
			if (id == owner) {
				continue;
			}
			_engine.cutPlayer(this.playerList[id], this.playerList[owner], this.playerList[owner].angle);
			this.playerList[id].setPunchedBy(owner);
		}
	}

	terminatePunch(packet) {
		messenger.messageRoomBySig(packet.roomSig, "terminatePunch", packet.id);
		delete packet.punchList[packet.id];

	}
	acquireBombTrigger(packet) {
		var player = packet.playerList[packet.id];
		player.ability = new BombTrigger(packet.id, packet.id.roomSig);
		packet.abilityList[player.id] = player.ability;
		messenger.messageRoomBySig(packet.roomSig, "abilityAcquired", { owner: player.id, ability: c.tileMap.abilities.bombTrigger.id, voronoiId: null });
	}

	swapOwnerWithRandomPlayer(packet) {
		var gameBoard = packet.context;
		var aimer = packet.aimer;
		aimer.alive = false;
		//Remove aimer
		delete gameBoard.aimerList[aimer.id];

		var randomPlayer = utils.getRandomProperty(aimer.targetList);
		var count = 0;
		if (randomPlayer == undefined) {
			messenger.messageRoomBySig(gameBoard.roomSig, "fizzle", packet.owner);
			return;
		}
		while (randomPlayer.id == packet.owner ||
			randomPlayer.alive == false ||
			randomPlayer.awake == false) {
			if (count > 100 || Object.keys(gameBoard.playerList).length == 1 || gameBoard.alivePlayerCount == 1 || gameBoard.alivePlayerCount - gameBoard.sleepingPlayerCount == 1 || gameBoard.playerList[packet.owner] == undefined) {
				messenger.messageRoomBySig(gameBoard.roomSig, "fizzle", packet.owner);
				return;
			}
			randomPlayer = utils.getRandomProperty(aimer.targetList);
			count++;
		}
		var ownerPlayer = gameBoard.playerList[packet.owner];
		if (ownerPlayer == undefined) {
			messenger.messageRoomBySig(gameBoard.roomSig, "fizzle", packet.owner);
			return;
		}
		var tempVars = { x: randomPlayer.x, y: randomPlayer.y, newX: randomPlayer.newX, newY: randomPlayer.newY, velX: randomPlayer.velX, velY: randomPlayer.velY, dragCoeff: randomPlayer.dragCoeff, brakeCoeff: randomPlayer.brakeCoeff, acel: randomPlayer.acel };
		for (var prop in tempVars) {
			randomPlayer[prop] = ownerPlayer[prop];
			ownerPlayer[prop] = tempVars[prop];
		}
		messenger.messageRoomBySig(gameBoard.roomSig, "playerSwapped", packet.owner);
	}
	spawnBomb(owner) {
		var player = this.playerList[owner];
		var bomb = new BombProj(player.x, player.y, 10, "black", owner, this.roomSig, this.clampPlayerAngle(player.angle));
		this.projectileList[owner] = bomb;
		messenger.messageRoomBySig(this.roomSig, "spawnBomb", owner);
	}
	spawnSnowFlake(owner) {
		var player = this.playerList[owner];
		player.addSpeed(100);
		var snowFlake = new SnowFlakeProj(player.x, player.y, c.tileMap.abilities.iceCannon.snowFlakeRadius, "black", owner, this.roomSig, this.clampPlayerAngle(player.angle));
		this.projectileList[owner] = snowFlake;
		messenger.messageRoomBySig(this.roomSig, "spawnSnowFlake", owner);
	}
	clampPlayerAngle(angle) {
		if (angle % 90 == 0) {
			return angle;
		}
		if ((angle + 45) % 90 == 0) {
			return angle;
		}
	}
	explodeBomb(owner) {
		var explodedCells = [];
		var explodeLoc = { x: this.projectileList[owner].x, y: this.projectileList[owner].y };
		var cells = this.currentMap.cells;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.lava.id) {
				continue;
			}
			var distance = utils.getMag(explodeLoc.x - cells[i].site.x, explodeLoc.y - cells[i].site.y);
			if (c.tileMap.abilities.bomb.explosionRadius > distance) {
				cells[i].id = c.tileMap.slow.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				explodedCells.push(cells[i].site.voronoiId);
			}
		}
		this.applyExplosionForce(explodeLoc, owner);
		if (this.abilityList[owner] != null) {
			this.abilityList[owner].alive = false;
		}
		messenger.messageRoomBySig(this.roomSig, 'triggerUsed', owner);
		messenger.messageRoomBySig(this.roomSig, 'explodedCells', explodedCells);
	}
	explodeIce(owner) {
		if (this.playerList[owner] != null && this.playerList[owner].alive == true && !this.playerList[owner].isZombie) {
			this.playerList[owner].removeSpeed(100);
		}
		var explodeLoc = { x: this.projectileList[owner].x, y: this.projectileList[owner].y };
		var cells = this.currentMap.cells;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id) {
				continue;
			}
			var distance = utils.getMag(explodeLoc.x - cells[i].site.x, explodeLoc.y - cells[i].site.y);
			if (c.tileMap.abilities.iceCannon.explosionRadius > distance) {
				cells[i].id = c.tileMap.ice.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
			}
		}
		this.applyExplosionForce(explodeLoc, owner);
		messenger.messageRoomBySig(this.roomSig, 'snowFlakeExploded', owner);
		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(this.gatherTileChanges()));
	}
	explodeLava(explodeLoc, radius) {
		var cells = this.currentMap.cells;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id) {
				continue;
			}
			var distance = utils.getMag(explodeLoc.x - cells[i].site.x, explodeLoc.y - cells[i].site.y);
			if (radius > distance) {
				cells[i].id = c.tileMap.lava.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
			}
		}
		this.applyExplosionForce(explodeLoc, null);
		messenger.messageRoomBySig(this.roomSig, 'lavaExplosion');
		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(this.gatherTileChanges()));
	}
	applyExplosionForce(loc, owner) {
		for (var id in this.playerList) {
			var player = this.playerList[id];
			var distance = utils.getMag(loc.x - player.x, loc.y - player.y);
			if (c.tileMap.abilities.bomb.explosionRadius > distance) {
				if (this.playerList[owner] != null) {
					player.setPunchedBy(owner);
				}
				_engine.explosion(player, loc, distance);
			}
		}
	}
	createExplosionAimer(loc, radius, owner) {
		var aimer = new ExplosionAimer(loc.x, loc.y, radius, "red", owner, this.roomSig);
		this.aimerList[owner] = aimer;
		messenger.messageRoomBySig(this.roomSig, "spawnExplosionAimer", owner);
	}
	applySpeedBuff(owner) {
		for (var id in this.playerList) {
			if (!this.playerList[id].alive || this.playerList[id].isZombie) {
				continue;
			}
			if (id == owner) {
				this.playerList[id].addSpeed(100);
			}
			this.playerList[id].decreaseDragMultiplier(c.tileMap.abilities.speedBuff.value)
		}
	}
	removeSpeedBuff(packet) {
		for (var id in packet.playerList) {
			if (id == packet.id) {
				packet.playerList[id].removeSpeed(100);
			}
			packet.playerList[id].increaseDragMultiplier(c.tileMap.abilities.speedBuff.value);
		}
	}
	applySpeedDebuff(owner) {
		var deltaList = {};
		for (var id in this.playerList) {
			if (id == owner) {
				continue;
			}
			if (!this.playerList[id].alive || this.playerList[id].isZombie) {
				continue;
			}

			//TODO remove this debuff it adds 2 speed player must get the update still
			deltaList[id] = this.playerList[id].removeSpeed(c.tileMap.abilities.speedDebuff.value);
			this.playerList[id].increaseDragMultiplier(c.tileMap.abilities.speedDebuff.value);
		}
		return deltaList;
	}
	removeSpeedDebuff(packet) {
		for (var id in packet.deltaList) {
			if (packet.playerList[id] != null) {
				//TODO remove this debuff it adds 2 speed player must get the update still
				packet.playerList[id].addSpeed(packet.deltaList[id]);
				packet.playerList[id].decreaseDragMultiplier(c.tileMap.abilities.speedDebuff.value);
			}
		}
	}
	checkForFirstBlood() {
		if (this.firstBlood == true) {
			return;
		}
		this.firstBlood = true;
		//Apply bonus fire for player who got first blood
		for (var id in this.playerList) {
			if (this.playerList[id].totalKills > 0) {
				this.playerList[id].addFire(c.playerFirstBloodFireBonus);
				break;
			}
		}
		messenger.messageRoomBySig(this.roomSig, "firstBlood");
	}

	startLobby() {
		this.lobbyStartButton = new LobbyStartButton(this.world.center.x, this.world.center.y, 0, "red");
		messenger.messageRoomBySig(this.roomSig, "startLobby", compressor.sendLobbyStart(this.lobbyStartButton));
	}
	setupMap(currentState) {
		this.clean();
		this.resetPlayers(currentState);
		this.loadNextMap(currentState);
		this.checkApplyBrutalConfig();
		this.startingGate = new Gate(0, 0, 75, this.world.height);
		this.gatePlayers();
	}
	startCollapse(loc) {
		this.collapseLoc = loc;
	}
	collapseMap(currentState) {
		if (currentState != c.stateMap.collapsing) {
			return;
		}
		//Calcuate collapse speed - Default collapse speed
		var collapseSpeed = c.worldCollapseSpeed;

		//Game isnt concluded
		if (this.firstPlaceSig == null) {

			collapseSpeed = c.lastPlayerCollapseSpeed;

			//Brutal round is active
			if (this.checkForActiveBrutal(c.brutalRounds.volcano.id)) {
				if (this.checkForActiveBrutal(c.brutalRounds.lightning.id)) {
					collapseSpeed = c.brutalRounds.lightning.volcanoCollapseSpeed;
				} else {
					collapseSpeed = c.brutalRounds.volcano.collapseSpeed;
				}
			}
		}

		this.collapseLine -= collapseSpeed;

		var collapsedCells = [];
		var cells = this.currentMap.cells;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.lava.id) {
				continue;
			}
			var distance = utils.getMag(this.collapseLoc.x - cells[i].site.x, this.collapseLoc.y - cells[i].site.y);
			if (this.collapseLine < distance) {
				cells[i].id = c.tileMap.lava.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				collapsedCells.push(cells[i].site.voronoiId);
			}
		}
		messenger.messageRoomBySig(this.roomSig, 'collapsedCells', collapsedCells);
	}
	findRandomGoalTile() {
		var goalTiles = [];
		var cells = this.currentMap.cells;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id) {
				goalTiles.push({ x: cells[i].site.x, y: cells[i].site.y });
			}
		}
		return goalTiles[utils.getRandomInt(0, goalTiles.length - 1)];
	}
	changeTile(voronoiId, newId) {
		for (var i = 0; i < this.currentMap.cells.length; i++) {
			if (this.currentMap.cells[i].site.voronoiId == voronoiId) {
				this.tileChanges[voronoiId] = newId;
				this.currentMap.cells[i].id = newId;
				return;
			}
		}
	}
	//Occurs at gameover
	resetGame(currentState) {
		this.mapsPlayed = [];
		this.chanceToSpawnAbility = c.chanceToSpawnAbility;
		this.chanceOfBrutalRound = c.chanceOfBrutalRound;
		this.chanceForAdditionalBrutal = c.chanceForAdditionalBrutal;
		this.brutalRound = false;
		this.brutalConfig = null;
		this.tileChanges = {};
		this.round = 0;
		this.firstBlood = false;
		this.currentMap = {};
		this.nextMap = {};
		this.resetPlayers(currentState);
	}
	gatePlayers() {
		for (var playerID in this.playerList) {
			this.gatePlayer(this.playerList[playerID]);
		}
	}
	gatePlayer(player) {
		var loc = this.startingGate.findFreeLoc(player);
		player.x = loc.x;
		player.y = loc.y;
		if (!this.checkForActiveBrutal(c.brutalRounds.lightning.id)) {
			player.setSpeedBonus(500);
		}
	}
	killAFKPlayers() {
		for (var id in this.playerList) {
			if (this.playerList[id].awake == false) {
				this.playerList[id].killSelf();
			}
		}
	}
	setTempSpectator(player) {
		player.isSpectator = true;
		player.alive = false;
		player.x = -100;
		player.y = -100;
		this.tempSpectatorList[player.id] = player;
	}
	resetProjectiles() {
		messenger.messageRoomBySig(this.roomSig, "resetProjectiles", null);
		for (var id in this.projectileList) {
			delete this.projectileList[id];
		}
	}
	resetHazards() {
		messenger.messageRoomBySig(this.roomSig, "resetHazards", null);
		for (var id in this.hazardList) {
			delete this.hazardList[id];
		}
	}
	resetPlayers(currentState) {
		messenger.messageRoomBySig(this.roomSig, "resetPlayers", null);
		for (var playerID in this.playerList) {
			var player = this.playerList[playerID];
			player.reset(currentState);
		}
		for (var aimerID in this.aimerList) {
			delete this.aimerList[aimerID];
		}
		for (var specID in this.tempSpectatorList) {
			this.tempSpectatorList[specID].isSpectator = false;
		}
	}
	clean() {
		this.lobbyStartButton = null;
		this.collapseLoc = {};
		this.collapseLine = this.world.height + 400;
		this.tileChanges = {};
		this.resetProjectiles();
		this.resetHazards();
	}
	checkForActiveBrutal(id) {
		if (this.brutalRound == true && this.brutalConfig.brutalTypes.indexOf(id) != -1) {
			return true;
		}
		return false;
	}
	determineNextMap() {
		if (c.TESTSingleMap) {
			this.nextMap = JSON.parse(JSON.stringify(this.maps[0]));
			return this.nextMap.id;
		}
		if (this.maps.length == this.mapsPlayed.length) {
			this.mapsPlayed = [];
		}
		var nextMapId = this.getRandomMapR();
		this.nextMap = JSON.parse(JSON.stringify(this.maps[nextMapId]));
		return this.nextMap.id;
	}

	loadNextMap(currentState) {
		if (Object.keys(this.nextMap) == 0) {
			this.determineNextMap();
		}
		this.currentMap = this.nextMap;
		this.round++;
		this.checkForDynamicDifficultyIncrease();
		this.generateHazards();
		this.mapsPlayed.push(this.currentMap.id);
		console.log("Round: " + this.round);
		this.brutalConfig = this.checkForBrutalRound();
		var randomGen = this.generateRandomTiles();
		this.newMapPayload = { id: this.currentMap.id, abilities: this.generateAbilities(), round: this.round, randomTiles: randomGen, brutalRoundConfig: this.brutalConfig, currentState: currentState };
		messenger.messageRoomBySig(this.roomSig, "newMap", this.newMapPayload);
	}
	checkApplyBrutalConfig() {
		if (this.brutalRound == false || this.brutalConfig == null) {
			return;
		}
		for (var i = 0; i < this.brutalConfig.brutalTypes.length; i++) {
			switch (this.brutalConfig.brutalTypes[i]) {
				case c.brutalRounds.ability.id: {
					this.applyBrutalAbilityRound();
					break;
				}
				case c.brutalRounds.lightning.id: {
					this.applyBrutalLightningRound();
					break;
				}
				case c.brutalRounds.cloudy.id: {
					this.applyBrutalCloudyRound();
					break;
				}
			}
		}

	}
	applyBrutalAbilityRound() {
		//Count number of aquireable abilities
		var abilitiesToGet = [];
		for (var prop in c.tileMap.abilities) {
			if (c.tileMap.abilities[prop].spawnable == true) {
				abilitiesToGet.push(c.tileMap.abilities[prop].id);
			}
		}
		//Every player gets an ability on round start
		for (var playerID in this.playerList) {
			var player = this.playerList[playerID];
			if (player.ability != null) {
				continue;
			}
			var abilityID = abilitiesToGet[utils.getRandomInt(0, abilitiesToGet.length - 1)];
			switch (abilityID) {
				case c.tileMap.abilities.blindfold.id: {
					player.ability = new Blindfold(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				case c.tileMap.abilities.bomb.id: {
					player.ability = new Bomb(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				case c.tileMap.abilities.swap.id: {
					player.ability = new Swap(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				case c.tileMap.abilities.speedBuff.id: {
					player.ability = new SpeedBuff(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				case c.tileMap.abilities.speedDebuff.id: {
					player.ability = new SpeedDebuff(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				case c.tileMap.abilities.tileSwap.id: {
					player.ability = new TileSwap(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				case c.tileMap.abilities.iceCannon.id: {
					player.ability = new IceCannon(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				case c.tileMap.abilities.cut.id: {
					player.ability = new Cut(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				default: {
					console.log("applyBrutalAbilityRound() in game.js chose abilityID:" + abilityID + " which is not implemented as an option. Please update this function");
					player.ability = new Bomb(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
			}
			messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: player.id, ability: abilityID, voronoiId: null });
		}
	}
	applyBrutalLightningRound() {
		//Give every player a speed bonus
		for (var id in this.playerList) {
			var player = this.playerList[id];
			player.setSpeedBonus(800);
		}
	}
	applyBrutalVolcanoRound(packet) {
		var context = packet.context;
		if (context.currentState == c.stateMap.racing || context.currentState == c.stateMap.collapsing) {
			//Find gold tile location to collapse on
			var loc = context.gameBoard.findRandomGoalTile();
			context.startCollapse(loc.x, loc.y);
		}

	}
	warnOfPendingVolcano(packet) {
		var context = packet.context;
		if (context.currentState == c.stateMap.racing || context.currentState == c.stateMap.collapsing) {
			messenger.messageRoomBySig(context.roomSig, 'volcanoEruption');
		}
	}
	applyBrutalCloudyRound() {
		var density = c.brutalRounds.cloudy.density;
		var angle = utils.getRandomInt(0, 359);
		var clouds = {};
		var padding = c.brutalRounds.cloudy.size + 50;
		while (density != 0) {
			var hash = utils.generateHash(this.roomSig, density);
			var loc = { x: utils.getRandomInt(-padding, this.world.width + padding), y: utils.getRandomInt(-padding, this.world.height + padding) };
			var cloud = new CloudProj(loc.x, loc.y, c.brutalRounds.cloudy.size, "white", hash, this.roomSig, angle);
			this.projectileList[hash] = cloud;
			clouds[hash] = cloud;
			density--;
		}
		messenger.messageRoomBySig(this.roomSig, "spawnClouds", compressor.sendClouds(clouds));
	}
	applyBrutalHockeyRound(packet) {
		var context = packet.context;
		var loc = { x: context.world.width / 2, y: context.world.height / 2 };
		var puck = new Puck(loc.x, loc.y, c.brutalRounds.hockey.puckRadius, "black", context.roomSig, context.roomSig, utils.getRandomInt(1, 360));
		context.projectileList[context.roomSig] = puck;
		messenger.messageRoomBySig(context.roomSig, "spawnPuck", context.roomSig);
	}

	checkForDynamicDifficultyIncrease() {
		const playerCountMod = c.chanceToSpawnAbilityPlayerCountMod;
		if (this.round == 1) {
			return;
		}
		if (this.alivePlayerCount + this.sleepingPlayerCount % playerCountMod == 0) {
			var inceasePerPlayer = 1;
			this.increaseChanceOfAbilities(inceasePerPlayer * playerCountMod);
		}
		if (this.round % 5 == 0) {
			this.increaseChanceOfAbilities(0);
			this.increaseChanceOfBrutalRound();
			this.increaseChanceOfAdditionalBrutal();
		}
	}
	increaseChanceOfAbilities(bonus) {
		if (bonus == null || bonus == undefined) {
			console.log("increaseChanceOfAbilities in GameBoard called without a valid bonus value");
			bonus = 0;
		}
		const increment = c.chanceToSpawnAbilityIncrement + bonus;
		if (this.chanceToSpawnAbility + increment >= 100) {
			return;
		}
		this.chanceToSpawnAbility = this.chanceToSpawnAbility + increment;
	}
	increaseChanceOfBrutalRound() {
		const increment = c.chanceOfBrutalRoundIncrement;
		if (this.chanceOfBrutalRound + increment >= 90) {
			return;
		}
		this.chanceOfBrutalRound = this.chanceOfBrutalRound + increment;
	}
	increaseChanceOfAdditionalBrutal() {
		const increment = 2;
		if (this.chanceForAdditionalBrutal + increment >= 50) {
			return;
		}
		this.chanceForAdditionalBrutal = this.chanceForAdditionalBrutal + increment;
	}
	getRandomMapR() {
		var randomIndex = utils.getRandomInt(0, this.maps.length - 1);
		var nextMap = this.maps[randomIndex];
		for (var i = 0; i < this.mapsPlayed.length; i++) {
			if (nextMap.id == this.mapsPlayed[i]) {
				return this.getRandomMapR();
			}
		}
		return randomIndex;
	}
	checkForBrutalRound() {
		var brutalRoundConfig = { brutal: false, brutalTypes: [] };
		this.brutalRound = false;
		var brutalChance = utils.getRandomInt(1, 100);

		//console.log("Initial roll: " + brutalChance);
		//Check for temp boost
		for (var id in this.playerList) {
			if (this.playerList[id].nearVictory == true) {
				if (brutalChance - c.nearVictoryBrutalRoundBoost >= 0) {
					//console.log("Roll mod: " + brutalChance + " -(" + c.nearVictoryBrutalRoundBoost + ")");
					brutalChance -= c.nearVictoryBrutalRoundBoost;
				}

				break;
			}
		}
		//console.log("Current roll: " + brutalChance);
		//console.log("Chance for brutal round: " + this.chanceOfBrutalRound);
		//No brutal round
		if (brutalChance > this.chanceOfBrutalRound) {
			return brutalRoundConfig;
		}


		this.brutalRound = true;
		brutalRoundConfig.brutal = true;
		//Find only active brutal types
		var activeBrutalTypes = [];

		for (var prop in c.brutalRounds) {
			if (c.brutalRounds[prop].active == true) {
				activeBrutalTypes.push(c.brutalRounds[prop].id);
			}
		}

		if (activeBrutalTypes.length == 0) {
			//console.log("Brutal round was engaged, however no brutal types are active in the config file");
			this.brutalRound = false;
			brutalRoundConfig = { brutal: false, brutalTypes: [] };
			return brutalRoundConfig;
		}
		activeBrutalTypes = utils.shuffleArray(activeBrutalTypes);
		brutalRoundConfig.brutalTypes.push(activeBrutalTypes[0]);
		if (activeBrutalTypes.length == 1) {
			return brutalRoundConfig;
		}
		activeBrutalTypes.splice(0, 1);
		for (var i = 0; i < activeBrutalTypes.length; i++) {

			if (brutalRoundConfig.brutalTypes.length == c.maxTotalBrutals) {
				return brutalRoundConfig;
			}
			//Roll for next Brutal
			var nextBrutalChance = utils.getRandomInt(1, 100);
			//console.log("Roll for additional brutal: " + nextBrutalChance);
			//console.log("Chance for " + this.chanceForAdditionalBrutal);
			if (nextBrutalChance > this.chanceForAdditionalBrutal) {
				return brutalRoundConfig;
			}
			brutalRoundConfig.brutalTypes.push(activeBrutalTypes[i]);
		}
		return brutalRoundConfig;
	}
	generateHazards() {
		if (this.currentMap.hazards == null) {
			return;
		}
		for (var i = 0; i < this.currentMap.hazards.length; i++) {
			if (this.currentMap.hazards[i].id == c.hazards.bumper.id) {
				var mapID = utils.generateHash(this.roomSig, String(this.currentMap.hazards[i].x + this.currentMap.hazards[i].y));
				var hazard = new Bumper(this.currentMap.hazards[i].x, this.currentMap.hazards[i].y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, this.roomSig);
				this.hazardList[mapID] = hazard;
			}
		}
	}
	generateAbilities() {
		var abilityTilesAvaliable = [];
		var indexMap = {};

		//Gather Map tiles to spawn
		for (var i = 0; i < this.currentMap.cells.length; i++) {
			if (this.currentMap.cells[i].id == c.tileMap.ability.id) {
				abilityTilesAvaliable.push(i);
			}
		}
		if (abilityTilesAvaliable.length == 0) {
			return indexMap;
		}
		var tilesRemaining = [];
		//Fill in normal tiles if chance to spawn is too low
		for (var p = 0; p < abilityTilesAvaliable.length; p++) {
			var spawnChance = utils.getRandomInt(1, 100);
			if (spawnChance >= this.chanceToSpawnAbility) {
				indexMap[this.currentMap.cells[abilityTilesAvaliable[p]].site.voronoiId] = c.tileMap.normal.id;
				this.currentMap.cells[abilityTilesAvaliable[p]].id = c.tileMap.normal.id;
				continue;
			}
			tilesRemaining.push(abilityTilesAvaliable[p]);
		}
		//Fill in remaining tiles with abilities
		for (var j = 0; j < tilesRemaining.length; j++) {
			var ability = this.spawnNewAbility();
			indexMap[this.currentMap.cells[tilesRemaining[j]].site.voronoiId] = ability;
			this.currentMap.cells[tilesRemaining[j]].id = ability;
		}
		return indexMap;
	}
	generateRandomTiles() {
		var randomTilesAvaliable = [];
		var indexMap = {};
		//Gather Map tiles to spawn
		for (var i = 0; i < this.currentMap.cells.length; i++) {
			if (this.currentMap.cells[i].id == c.tileMap.random.id) {
				randomTilesAvaliable.push(i);
			}
		}
		if (randomTilesAvaliable.length == 0) {
			return indexMap;
		}

		//Count all types that can be randomed
		var possibleTiles = [];
		for (var prop in c.tileMap) {
			if (c.tileMap[prop].canBeRandomed == false) {
				continue;
			}
			possibleTiles.push(c.tileMap[prop].id);
		}

		//Fill in tiles with random types
		for (var j = 0; j < randomTilesAvaliable.length; j++) {
			var tileID = possibleTiles[utils.getRandomInt(0, possibleTiles.length - 1)];
			indexMap[this.currentMap.cells[randomTilesAvaliable[j]].site.voronoiId] = tileID;
			this.currentMap.cells[randomTilesAvaliable[j]].id = tileID;
		}
		return indexMap;
	}
	spawnNewAbility() {
		return this.allAbilityIDs[utils.getRandomInt(0, this.allAbilityIDs.length - 1)];
	}
	indexAbilities() {
		var abilities = [];
		for (var ability in c.tileMap.abilities) {
			if (c.tileMap.abilities[ability].spawnable) {
				abilities.push(c.tileMap.abilities[ability].id);
			}
		}
		return abilities;
	}
}

class Shape {
	constructor(x, y, color) {
		this.x = x;
		this.y = y;
		this.color = color;
	}
	inBounds(shape) {
		if (shape.radius) {
			return this.testCircle(shape);
		}
		if (shape.width) {
			return this.testRect(shape);
		}
		return false;
	}
}

class Rect extends Shape {
	constructor(x, y, width, height, angle, color) {
		super(x, y, color);
		this.width = width;
		this.height = height;
		this.angle = angle;
		this.vertices = this.getVertices();
	}
	getVertices() {
		var vertices = [];
		var a = { x: this.x, y: this.y },
			b = { x: this.width, y: this.y },
			c = { x: this.width, y: this.height },
			d = { x: this.x, y: this.height };

		vertices.push(a, b, c, d);
		return vertices;
	}
	pointInRect(objX, objY) {
		var a = this.areaTriangle(this.vertices[0].x, this.vertices[0].y, this.vertices[1].x, this.vertices[1].y, this.vertices[2].x, this.vertices[2].y) +
			this.areaTriangle(this.vertices[0].x, this.vertices[0].y, this.vertices[3].x, this.vertices[3].y, this.vertices[2].x, this.vertices[2].y);
		var a1 = this.areaTriangle(objX, objY, this.vertices[0].x, this.vertices[0].y, this.vertices[1].x, this.vertices[1].y);
		var a2 = this.areaTriangle(objX, objY, this.vertices[1].x, this.vertices[1].y, this.vertices[2].x, this.vertices[2].y);
		var a3 = this.areaTriangle(objX, objY, this.vertices[2].x, this.vertices[2].y, this.vertices[3].x, this.vertices[3].y);
		var a4 = this.areaTriangle(objX, objY, this.vertices[0].x, this.vertices[0].y, this.vertices[3].x, this.vertices[3].y);
		return (a == a1 + a2 + a3 + a4);
	}

	areaTriangle(x1, y1, x2, y2, x3, y3) {
		return Math.abs((x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2.0);
	}

	getExtents() {
		var minX = this.vertices[0].x,
			maxX = minX,
			minY = this.vertices[0].y,
			maxY = minY;
		for (var i = 0; i < this.vertices.length - 1; i++) {
			var vert = this.vertices[i];
			minX = (vert.x < minX) ? vert.x : minX;
			maxX = (vert.x > maxX) ? vert.x : maxX;
			minY = (vert.y < minY) ? vert.y : minY;
			maxY = (vert.y > maxY) ? vert.y : maxY;
		}
		return { minX, maxX, minY, maxY };
	}
	testRect(rect) {
		for (var i = 0; i < this.vertices.length; i++) {
			if (rect.pointInRect(this.vertices[i].x, this.vertices[i].y)) {
				return true;
			}
		}
		for (var i = 0; i < rect.vertices.length; i++) {
			if (this.pointInRect(rect.vertices[i].x, rect.vertices[i].y)) {
				return true;
			}
		}
		return false;
	}
	testCircle(circle) {
		return circle.testRect(this);
	}
	getRandomLoc() {
		return { x: Math.floor(Math.random() * (this.width - this.x)) + this.x, y: Math.floor(Math.random() * (this.height - this.y)) + this.y };
	}
	findFreeLoc(obj) {
		var loc = this.getSafeLoc(obj.width || obj.radius);
		return loc;
	}
	getSafeLoc(size) {
		var objW = size + 5 + c.playerBaseRadius * 2;
		var objH = size + 5 + c.playerBaseRadius * 2;
		return { x: Math.floor(Math.random() * (this.width - 2 * objW - this.x)) + this.x + objW, y: Math.floor(Math.random() * (this.height - 2 * objH - this.y)) + this.y + objH, width: objW };
	}
}

class Gate extends Rect {
	constructor(x, y, width, height) {
		super(x, y, width, height, 0, "grey");
		this.isGate = true;
	}
	handleHit() {

	}
}

class World extends Rect {
	constructor(x, y, width, height, engine, playerList, hazardList, roomSig) {
		super(x, y, width, height, 0, "white");
		this.engine = engine;
		this.playerList = playerList;
		this.hazardList = hazardList;
		this.roomSig = roomSig;
		this.center = { x: width / 2, y: height / 2 };
	}
	update(dt) {

	}
	createNewPlayer(id) {
		var color = this.getUniqueColorR();
		var player = new Player(0, 0, 90, color, id, this.roomSig);
		return player;
	}
	spawnPlayerRandomLoc(player) {
		var loc = this.findFreeLoc(player);
		player.initialLoc = loc;
		player.x = loc.x;
		player.y = loc.y;
	}
	setSpawnLocation(player) {
		player.initialLoc = this.findFreeLoc(player);
	}
	getUniqueColorR() {
		var color = utils.getColor();
		for (var player in this.playerList) {
			if (this.playerList[player].color == color) {
				return this.getUniqueColorR();
			}
		}
		return color;
	}
	resize() {
		this.width = c.worldWidth;
		this.height = c.worldHeight;
		this.baseBoundRadius = this.width;
		this.center = { x: this.width / 2, y: this.height / 2 };
		this.engine.setWorldBounds(this.width, this.height);
		var data = compressor.worldResize(this);
		messenger.messageRoomBySig(this.roomSig, 'worldResize', data);
	}
}

class Circle extends Shape {
	constructor(x, y, radius, color) {
		super(x, y, color);
		this.radius = radius;
	}
	getExtents() {
		return { minX: this.x - this.radius, maxX: this.x + this.radius, minY: this.y - this.radius, maxY: this.y + this.radius };
	}

	testCircle(circle) {
		var objX1, objY1, objX2, objY2, distance;
		objX1 = this.newX || this.x;
		objY1 = this.newY || this.y;
		objX2 = circle.newX || circle.x;
		objY2 = circle.newY || circle.y;
		distance = utils.getMag(objX2 - objX1, objY2 - objY1);
		distance -= this.radius;
		distance -= circle.radius;
		if (distance <= 0) {
			return true;
		}
		return false;
	}

	testRect(rect) {
		if (this.lineIntersectCircle({ x: rect.x, y: rect.y }, { x: rect.newX, y: rect.newY })) {
			return true;
		}
		if (rect.pointInRect(this.x, this.y)) {
			return true;
		}

		if (this.lineIntersectCircle(rect.vertices[0], rect.vertices[1]) ||
			this.lineIntersectCircle(rect.vertices[1], rect.vertices[2]) ||
			this.lineIntersectCircle(rect.vertices[2], rect.vertices[3]) ||
			this.lineIntersectCircle(rect.vertices[3], rect.vertices[0])) {
			return true;
		}

		for (var i = 0; i < rect.vertices.length; i++) {
			var distsq = utils.getMagSq(this.x, this.y, rect.vertices[i].x, rect.vertices[i].y);
			if (distsq < Math.pow(this.radius, 2)) {
				return true;
			}
		}
		return false;
	}
	lineIntersectCircle(a, b) {
		var ap, ab, dirAB, magAB, projMag, perp, perpMag;
		ap = { x: this.x - a.x, y: this.y - a.y };
		ab = { x: b.x - a.x, y: b.y - a.y };
		magAB = Math.sqrt(utils.dotProduct(ab, ab));
		dirAB = { x: ab.x / magAB, y: ab.y / magAB };

		projMag = utils.dotProduct(ap, dirAB);

		perp = { x: ap.x - projMag * dirAB.x, y: ap.y - projMag * dirAB.y };
		perpMag = Math.sqrt(utils.dotProduct(perp, perp));
		if ((0 < perpMag) && (perpMag < this.radius) && (0 < projMag) && (projMag < magAB)) {
			return true;
		}
		return false;
	}


	getRandomCircleLoc(minR, maxR) {
		var r = Math.floor(Math.random() * (maxR - minR));
		var angle = Math.floor(Math.random() * (Math.PI * 2 - 0));
		return { x: r * Math.cos(angle) + this.x, y: r * Math.sin(angle) + this.y };
	}
}

class LobbyStartButton extends Circle {
	constructor(x, y, angle, color) {
		super(x, y, 75, color);
		this.isLobbyStart = true;
	}
	handleHit(object) {

	}
}

class Player extends Circle {
	constructor(x, y, angle, color, id, roomSig) {
		super(x, y, c.playerBaseRadius, color);
		this.isPlayer = true;
		this.enabled = true;
		this.alive = true;
		this.color = color;
		this.id = id;
		this.roomSig = roomSig;
		this.currentState = null;
		this.initialLoc = { x: 0, y: 0 };

		//Sleep Variables
		this.awake = true;
		this.kick = false;
		this.sleepWaitTime = c.playerStartSleepTime;
		this.sleepTimer = null;
		this.sleepTimeLeft = this.sleepWaitTime;

		this.kickWaitTime = c.playerAFKKickTime;
		this.kickTimer = null;
		this.kickTimeLeft = this.kickWaitTime;

		this.chatCoolDownWaitTime = 10;
		this.chatCoolDownTimer = null;
		this.chatCoolDownTimeLeft = this.chatCoolDownWaitTime;

		//Game Variables
		this.hittingLobbyButton = false;
		this.reachedGoal = false;
		this.timeReached = null;
		this.notches = 0;
		this.nearVictory = false;
		this.fellFromVictory = false;
		this.infected = false;
		this.isZombie = false;
		this.exploded = false;

		//Movement
		this.moveForward = false;
		this.moveBackward = false;
		this.turnLeft = false;
		this.turnRight = false;
		this.attack = false;
		this.angle = 0;


		//Attack
		this.acquiredAbility = null;
		this.ability = null;
		this.punch = null;
		this.punchedBy = null;
		this.murderedBy = null;
		this.totalKills = 0;
		this.roundKills = 0;
		this.multiKillCount = 0;
		this.openMultiKillWindow = false;
		this.killedPlayerList = [];


		this.punchWaitTime = c.playerPunchCooldown;
		this.punchedTimer = null;
		this.punchTimeLeft = this.punchWaitTime;

		//On Fire
		this.onFire = 0;
		this.fireTimer = null;
		this.fireTimeLeft = 0;

		//Achievements
		this.savier = 0;

		//Engine Variables
		this.newX = this.x;
		this.newY = this.y;
		this.velX = 0;
		this.velY = 0;
		this.dragMultiplier = 1;
		this.dragCoeff = c.playerDragCoeff;
		this.brakeCoeff = c.playerBrakeCoeff;
		this.maxVelocity = c.playerMaxSpeed;
		this.acel = c.playerBaseAcel;

		this.currentSpeedBonus = 0;
	}
	update(currentState, dt) {
		this.currentState = currentState;
		this.checkForSleep(currentState);
		if (this.alive == false) {
			return;
		}
		this.dt = dt;
		this.move();
		this.checkAttack(currentState);
		this.checkChatCoolDownTimer();
		this.checkFireTimer();
	}
	move() {
		this.x = this.newX;
		this.y = this.newY;
	}
	checkAttack(currentState) {
		if (this.attack) {
			if ((currentState == c.stateMap.racing || currentState == c.stateMap.collapsing) && this.ability != null) {
				this.punchedTimer = Date.now();
				this.ability.use();
				return;
			}
			if (this.checkPunchCoolDown()) {
				return;
			}
			this.punchedTimer = Date.now();
			var punchRadius = c.punchRadius;
			if (this.isZombie == true) {
				punchRadius = c.brutalRounds.infection.punchRadius;
			}
			this.punch = new Punch(this.x, this.y, punchRadius, this.color, this.id, this.roomSig, 1, this.isZombie);
			messenger.messageRoomBySig(this.roomSig, "punch", compressor.sendPunch(this.punch));
			this.attack = false;
		}
	}
	checkPunchCoolDown() {
		if (this.punchedTimer != null) {
			this.punchTimeLeft = (this.punchWaitTime - (Date.now() - this.punchedTimer));
			if (this.punchTimeLeft > 0) {
				return true;
			}
			return false;
		}
	}
	checkChatCoolDownTimer() {
		if (this.chatCoolDownTimer != null) {
			this.chatCoolDownTimeLeft = ((this.chatCoolDownWaitTime * 1000 - (Date.now() - this.chatCoolDownTimer)) / (1000)).toFixed(1);
			if (this.chatCoolDownTimeLeft > 0) {
				return;
			}
			this.chatCoolDownTimer = null;
		}
	}
	checkFireTimer() {
		if (this.fireTimer != null) {
			this.fireTimeLeft = ((this.onFire - (Date.now() - this.fireTimer)) / (1000)).toFixed(1);
			messenger.messageRoomBySig(this.roomSig, "onFire", { owner: this.id, value: this.fireTimeLeft * 1000 });
			if (this.fireTimeLeft > 0) {
				return;
			}
			this.onFire = 0;
			this.fireTimer = null;
			messenger.messageRoomBySig(this.roomSig, "onFire", { owner: this.id, value: 0 });
		}
	}
	setPunchedBy(owner) {
		this.punchedBy = owner;
		setTimeout(function (myself) {
			if (myself.alive) {
				myself.punchedBy = null;
			}
		}, c.playerKillWindow, this);
	}
	addKill(player) {
		if (this.alive == false || this.isZombie == true) {
			return;
		}
		this.killedPlayerList.push(player.id);
		clearTimeout(multiKillIndex);
		this.roundKills += 1;
		this.totalKills += 1;
		this.addFire(c.playerKillFireBonus);
		if (player.fellFromVictory) {
			this.savier += 1;
			this.addFire(c.playerKilledNearVictoryBonus);
		}
		if (this.openMultiKillWindow == true) {
			if (this.multiKillCount == 0) {
				this.multiKillCount = 2;
			} else {
				this.multiKillCount++;
			}
			this.addFire(c.playerMultiKillFireBonus);
			messenger.messageRoomBySig(this.roomSig, "multiKill", this.multiKillCount);
		}
		if (this.totalKills == 5) {
			messenger.messageRoomBySig(this.roomSig, "killingSpree", this.id);
		}
		if (this.totalKills == 10) {
			messenger.messageRoomBySig(this.roomSig, "rampage", this.id);
		}
		if (this.totalKills == 15) {
			messenger.messageRoomBySig(this.roomSig, "godLike", this.id);
		}
		var multiKillIndex = setTimeout(function (myself) {
			myself.openMultiKillWindow = false;
			myself.multiKillCount = 0;
		}, c.playerMultiKillWindow, this)
		this.openMultiKillWindow = true;
	}
	addFire(value) {
		if (this.isZombie) {
			return;
		}
		this.onFire += value;
		messenger.messageRoomBySig(this.roomSig, "onFire", { owner: this.id, value: this.onFire });
	}
	addSpeed(newValue) {
		//New speed cant go above max speed
		var delta = 0;
		if (newValue + this.currentSpeedBonus > c.playerMaxSpeedBonus) {
			delta = c.playerMaxSpeedBonus - this.currentSpeedBonus;
			this.currentSpeedBonus = c.playerMaxSpeedBonus;
			return delta;
		}
		delta = newValue;
		this.currentSpeedBonus += newValue;
		return delta;
	}
	removeSpeed(newValue) {
		//Subtract from Speedbonus cant go below 0
		var delta = 0;
		if (this.currentSpeedBonus - newValue < 0) {
			delta = this.currentSpeedBonus;
			this.currentSpeedBonus = 0;
			return delta;
		}
		this.currentSpeedBonus -= newValue;
		return newValue;
	}
	setSpeedBonus(newValue) {
		if (newValue > c.playerMaxSpeedBonus) {
			return;
		}
		this.currentSpeedBonus = newValue;
	}
	getSpeedBonus() {
		return this.currentSpeedBonus;
	}
	increaseDragMultiplier(newValue) {
		this.dragMultiplier *= newValue;
	}
	decreaseDragMultiplier(newValue) {
		this.dragMultiplier = this.dragMultiplier / newValue;
	}
	getDragBonus() {
		return this.dragMultiplier;
	}
	wakeUp() {
		this.sleepTimer = null;
		this.kickTimer = null;
		if (this.awake == false) {
			this.awake = true;
			messenger.messageRoomBySig(this.roomSig, "playerAwake", this.id);
		}
	}
	checkForSleep(currentState) {
		if (this.sleepTimer != null) {
			this.sleepTimeLeft = ((this.sleepWaitTime * 1000 - (Date.now() - this.sleepTimer)) / (1000)).toFixed(1);
			if (this.sleepTimeLeft > 0) {
				return;
			}
			this.checkAFK(currentState);
			return;
		}
		this.sleepTimer = Date.now();
	}
	checkAFK(currentState) {
		if (this.awake == true) {
			if (currentState == c.stateMap.waiting || currentState == c.stateMap.lobby) {
				this.kick = true;
				return;
			}
			this.awake = false;
			messenger.messageRoomBySig(this.roomSig, "playerSleeping", this.id);
		}
		if (this.kickTimer != null) {
			this.kickTimeLeft = ((this.kickWaitTime * 1000 - (Date.now() - this.kickTimer)) / (1000)).toFixed(1);
			if (this.kickTimeLeft > 0) {
				return;
			}
			this.kick = true;
			return;
		}
		this.kickTimer = Date.now();

	}
	resurrect(packet) {
		if (packet.currentState != c.stateMap.racing &&
			packet.currentState != c.stateMap.collapsing) {
			return;
		}
		packet.isZombie = true;
		packet.enabled = true;
		packet.alive = true;
		messenger.messageRoomBySig(packet.roomSig, "playerInfected", packet.id);
	}
	infect() {
		if (this.infected == true) {
			return;
		}
		this.infected = true;
		var infectTimer = 0;
		if (this.alive == true) {
			infectTimer = utils.getRandomInt(1000, 4000);
			setTimeout(this.killPlayer, infectTimer, this);
		}
		setTimeout(this.resurrect, infectTimer + 1500, this);
	}
	applyInfectedMods(object) {
		this.acel = object.acel * c.brutalRounds.infection.acelModifer;
		this.dragCoeff = object.dragCoeff * c.brutalRounds.infection.dragModifer;
		this.brakeCoeff = object.brakeCoeff * c.brutalRounds.infection.brakeModifer;
	}
	handleHit(object) {
		if (object.isLobbyStart) {
			this.hittingLobbyButton = true;
			return;
		}
		if (object.isPunch && object.ownerId != this.id) {
			if (object.ownerInfected) {
				this.infect();
			}
			this.setPunchedBy(object.ownerId);
			_engine.punchPlayer(this, object);
			messenger.messageRoomBySig(this.roomSig, "playerPunched", object.ownerId);
			return;
		}
		if (object.isPuck) {
			_engine.puckPlayer(object, this);
			messenger.messageRoomBySig(this.roomSig, "playerPunched", object.ownerId);
			return;
		}
		if (object.isGate) {
			this.killSelf();
			return;
		}
		if (object.isMapCell) {
			if (object.id == c.tileMap.normal.id) {
				if (this.isZombie == true) {
					this.applyInfectedMods(object);
					return;
				}
				this.acel = object.acel;
				this.brakeCoeff = object.brakeCoeff;
				this.dragCoeff = object.dragCoeff;
				return;
			}
			if (object.id == c.tileMap.slow.id) {
				if (this.isZombie == true) {
					this.applyInfectedMods(object);
					return;
				}
				this.acel = object.acel;
				this.dragCoeff = object.dragCoeff;
				this.brakeCoeff = object.brakeCoeff;
				return;
			}
			if (object.id == c.tileMap.fast.id) {
				if (this.isZombie == true) {
					this.applyInfectedMods(object);
					return;
				}
				this.acel = object.acel;
				this.dragCoeff = object.dragCoeff;
				this.brakeCoeff = object.brakeCoeff;
				return;
			}
			if (object.id == c.tileMap.lava.id) {
				if (this.isZombie == true) {
					this.acel = object.acel;
					this.dragCoeff = object.dragCoeff;
					this.brakeCoeff = object.brakeCoeff;
					return;
				}
				if (this.onFire > 0) {
					if (this.fireTimer == null) {
						this.fireTimer = Date.now();
					}
					this.checkFireTimer();
					return;
				}
				this.killSelf();
				return;
			}
			if (object.id == c.tileMap.ice.id) {
				this.acel = object.acel;
				this.brakeCoeff = object.brakeCoeff;
				this.dragCoeff = object.dragCoeff;
				return;
			}
			if (object.id == c.tileMap.goal.id) {
				if (this.isZombie == true) {
					this.acel = object.acel;
					this.brakeCoeff = object.brakeCoeff;
					this.dragCoeff = object.dragCoeff;
					return;
				}
				this.alive = false;
				this.reachedGoal = true;
				this.timeReached = Date.now();
				messenger.messageRoomBySig(this.roomSig, "playerConcluded", this.id);
				return;
			}
			if (object.id == c.tileMap.abilities.blindfold.id) {
				if (this.ability != null || this.isZombie) {
					return;
				}
				this.ability = new Blindfold(this.id, this.roomSig);
				this.acquiredAbility = { mapID: object.voronoiId };
				messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
				return;
			}
			if (object.id == c.tileMap.abilities.swap.id) {
				if (this.ability != null || this.isZombie) {
					return;
				}
				this.ability = new Swap(this.id, this.roomSig);
				this.acquiredAbility = { mapID: object.voronoiId };
				messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
				return;
			}
			if (object.id == c.tileMap.abilities.bomb.id) {
				if (this.ability != null || this.isZombie) {
					return;
				}
				this.ability = new Bomb(this.id, this.roomSig);
				this.acquiredAbility = { mapID: object.voronoiId };
				messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
				return;
			}
			if (object.id == c.tileMap.abilities.speedBuff.id) {
				if (this.ability != null || this.isZombie) {
					return;
				}
				this.ability = new SpeedBuff(this.id, this.roomSig);
				this.acquiredAbility = { mapID: object.voronoiId };
				messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
				return;
			}
			if (object.id == c.tileMap.abilities.speedDebuff.id) {
				if (this.ability != null || this.isZombie) {
					return;
				}
				this.ability = new SpeedDebuff(this.id, this.roomSig);
				this.acquiredAbility = { mapID: object.voronoiId };
				messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
				return;
			}
			if (object.id == c.tileMap.abilities.tileSwap.id) {
				if (this.ability != null || this.isZombie) {
					return;
				}
				this.ability = new TileSwap(this.id, this.roomSig);
				this.acquiredAbility = { mapID: object.voronoiId };
				messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
				return;
			}
			if (object.id == c.tileMap.abilities.iceCannon.id) {
				if (this.ability != null || this.isZombie) {
					return;
				}
				this.ability = new IceCannon(this.id, this.roomSig);
				this.acquiredAbility = { mapID: object.voronoiId };
				messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
				return;
			}
			if (object.id == c.tileMap.abilities.cut.id) {
				if (this.ability != null || this.isZombie) {
					return;
				}
				this.ability = new Cut(this.id, this.roomSig);
				this.acquiredAbility = { mapID: object.voronoiId };
				messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
				return;
			}

		}
	}
	addNotch(notchesToWin) {
		if (this.notches + 1 >= notchesToWin) {
			this.notches = notchesToWin;
			this.nearVictory = true;
			return;
		}
		this.notches += 1;
	}
	removeNotch() {
		if (this.notches > 0) {
			if (this.nearVictory == true) {
				this.fellFromVictory = true;
			}
			this.nearVictory = false;
			this.notches -= 1;
		}
	}
	killPlayer(packet) {
		if (packet.currentState != c.stateMap.racing &&
			packet.currentState != c.stateMap.collapsing) {
			return;
		}
		if (packet.alive == false) {
			return;
		}
		if (packet.punchedBy != null) {
			packet.murderedBy = packet.punchedBy;
		}
		packet.removeNotch();
		packet.enabled = false;
		packet.alive = false;
		packet.ability = null;
		packet.newX = packet.x;
		packet.newY = packet.y;
		packet.velX = 0;
		packet.velY = 0;
		packet.onFire = 0;
		packet.moveForward = false;
		packet.moveBackward = false;
		packet.turnLeft = false;
		packet.turnRight = false;
		packet.attack = false;
		messenger.messageRoomBySig(packet.roomSig, "playerDied", packet.id);
	}
	killSelf() {
		this.killPlayer(this);
	}
	reset(currentState) {
		this.alive = true;
		this.enabled = true;
		this.infected = false;
		this.isZombie = false;
		this.exploded = false;
		this.x = this.initialLoc.x;
		this.y = this.initialLoc.y;
		this.newX = this.x;
		this.newY = this.y;
		this.velX = 0;
		this.velY = 0;
		this.dragMultiplier = 1;
		this.dragCoeff = c.playerDragCoeff;
		this.brakeCoeff = c.playerBrakeCoeff;
		this.maxVelocity = c.playerMaxSpeed;
		this.acel = c.playerBaseAcel;
		this.currentSpeedBonus = 0;
		this.moveForward = false;
		this.moveBackward = false;
		this.turnLeft = false;
		this.turnRight = false;
		this.attack = false;
		this.reachedGoal = false;
		this.timeReached = null;
		this.punch = null;
		this.punchedBy = null;
		this.murderedBy = null;
		this.roundKills = 0;
		this.fellFromVictory = false;
		this.openMultiKillWindow = false;
		this.multiKillCount = 0;
		this.acquiredAbility = null;
		this.angle = 315;
		if (currentState == c.stateMap.gameOver) {
			this.ability = null;
			this.notches = 0;
			this.totalKills = 0;
			this.onFire = 0;
			this.savier = 0;
			this.killedPlayerList = [];
		}
	}
}

class ExplosionAimer extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color);
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.isExplosionAimer = true;
		this.alive = true;
		this.targetListAry = [];

		this.explode = false;
		this.explodeWaitTime = c.explosionWarnTime;
		this.explodeTimer = null;
		this.explodeTimeLeft = this.explodeWaitTime;
	}
	update() {
		if (!this.alive) {
			return;
		}
		if (this.radius < c.explosionRadius) {
			this.grow();
		}
		this.checkExplodeTimer();

	}
	grow() {
		this.radius += 2;
	}
	checkExplodeTimer() {
		if (this.explodeTimer != null) {
			this.explodeTimeLeft = ((this.explodeWaitTime * 1000 - (Date.now() - this.explodeTimer)) / (1000)).toFixed(1);
			if (this.explodeTimeLeft > 0) {
				return;
			}
			this.explodeTimer = null;
			this.explode = true;
			messenger.messageRoomBySig(this.roomSig, "terminateAimer", this.ownerId);
			return;
		}
		this.explodeTimer = Date.now();
	}
	killSelf() {
		this.alive = false;
	}
	handleHit() {

	}
}

class SwapAimer extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color);
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.isSwapAimer = true;
		this.alive = true;
		this.targetList = {};
		this.targetListAry = [];
		var index = setInterval(function (aimer) {
			aimer.targetList = {};
			aimer.targetListAry = [];
		}, 300, this);
		this.index = index;
	}
	update(owner) {
		if (owner.alive == false || owner.isZombie) {
			this.alive = false;
			messenger.messageRoomBySig(this.roomSig, "terminateAimer", this.ownerId);
			return;
		}
		if (this.radius < c.tileMap.abilities.swap.endSize) {
			this.grow();
		}
		this.move(owner);
	}
	grow() {
		this.radius += 2;
	}
	move(owner) {
		this.x = owner.x;
		this.y = owner.y;
	}
	handleHit(object) {
		if (object.isPlayer && object.id != this.ownerId && object.isZombie == false && this.alive) {
			if (this.targetList[object.id] == null) {
				this.targetList[object.id] = object;
				this.targetListAry.push(object.id);
			}
			return;
		}
	}
}

class Punch extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig, punchBonus, infected) {
		super(x, y, radius, color);
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.isPunch = true;
		this.ownerInfected = infected;
		this.punchBonus = punchBonus;
	}
	handleHit(object) {

	}
	getBonus() {
		return this.punchBonus;
	}
}

class Hazard extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color);
		this.alive = true;
	}
	update() {
		if (this.alive == false) {
			return;
		}
	}
	handleHit(object) {

	}
}
class Bumper extends Hazard {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color, ownerId, roomSig);
		this.punch = null;
	}
	handleHit(object) {
		if (!object.isPlayer && !object.isPuck) {
			return;
		}
		if (this.punch == null) {
			this.punch = new Punch(this.x, this.y, c.hazards.bumper.attackRadius, c.hazards.bumper.color, this.ownerId, this.roomSig, c.hazards.bumper.punchBonus, false);
		}
	}
}

class Projectile extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color);
		this.alive = true;
		this.bounced = false;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.angle = angle;
		this.speed = 0;
		this.velX = 0;
		this.velY = 0;
		this.newX = this.x;
		this.newY = this.y;
		this.type = "";
	}
	update() {
		if (!this.alive) {
			return;
		}
		this.checkForBounce();
		this.move();
	}
	move() {
		this.x = this.newX;
		this.y = this.newY;
	}
	checkForBounce() {
		if (this.bounced) {
			this.bounced = false;
			messenger.messageRoomBySig(this.roomSig, "projBounced");
		}
	}
	handleHit(object) {

	}
}
class CloudProj extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.speed = c.brutalRounds.cloudy.speed;
		this.type = "cloud";
	}
	update() {
		if (!this.alive) {
			return;
		}
		this.move();
	}
}
class SnowFlakeProj extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.explosionRadius = c.tileMap.abilities.iceCannon.explosionRadius;
		this.speed = c.tileMap.abilities.iceCannon.speed;
		this.explodeIce = false;
		this.type = "snowFlake";
		this.tileChanges = {};

		this.explodeWaitTime = c.tileMap.abilities.iceCannon.lifetime;
		this.explodeTimer = null;
		this.explodeTimeLeft = this.explodeWaitTime;
	}
	update() {
		this.checkExplodeTimer();
		super.update();
	}
	checkExplodeTimer() {
		if (this.explodeTimer != null) {
			this.explodeTimeLeft = ((this.explodeWaitTime * 1000 - (Date.now() - this.explodeTimer)) / (1000)).toFixed(1);
			if (this.explodeTimeLeft > 0) {
				return;
			}
			this.explodeFlake();
			return;
		}
		this.explodeTimer = Date.now();
	}
	explodeFlake() {
		this.explodeIce = true;
		this.alive = false;
	}
	handleHit(object) {
		if (object.isMapCell) {
			if (object.id != c.tileMap.lava.id && object.id != c.tileMap.goal.id && object.id != c.tileMap.slow.id) {
				this.tileChanges[object.voronoiId] = c.tileMap.ice.id;
			}
		}
	}
}
class BombProj extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.explosionRadius = c.tileMap.abilities.bomb.explosionRadius;
		this.speed = c.tileMap.abilities.bomb.speed;
		this.explode = false;
		this.type = "bomb";

		this.explodeWaitTime = c.tileMap.abilities.bomb.lifetime;
		this.explodeTimer = null;
		this.explodeTimeLeft = this.explodeWaitTime;
	}
	update() {
		this.checkExplodeTimer();
		super.update();
	}
	checkExplodeTimer() {
		if (this.explodeTimer != null) {
			this.explodeTimeLeft = ((this.explodeWaitTime * 1000 - (Date.now() - this.explodeTimer)) / (1000)).toFixed(1);
			if (this.explodeTimeLeft > 0) {
				return;
			}
			this.explodeBomb();
			return;
		}
		this.explodeTimer = Date.now();
	}
	explodeBomb() {
		this.explode = true;
		this.alive = false;
	}
}

class Puck extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.type = "puck";
		this.isPuck = true;
		this.speed = c.brutalRounds.hockey.baseSpeed;
	}
	handleHit(object) {
		if (object.isPunch && object.ownerId != this.ownerId) {
			_engine.punchPuck(this, object);
			messenger.messageRoomBySig(this.roomSig, "playerPunched", object.ownerId);
			return;
		}
	}
}

class Ability {
	constructor(owner, roomSig) {
		this.id = null;
		this.roomSig = roomSig;
		this.ownerId = owner;
		this.alive = true;
	}
	update() {

	}
	use() {
		console.log("unimplemented");
	}
}
class Blindfold extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.id = c.tileMap.abilities.blindfold.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "blindfoldUsed", this.ownerId);
	}
}
class Swap extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.swap = false;
		this.id = c.tileMap.abilities.swap.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.swap = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "swapUsed", this.ownerId);
	}
}
class IceCannon extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.spawnSnowFlake = false;
		this.id = c.tileMap.abilities.iceCannon.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.spawnSnowFlake = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "iceCannon", this.ownerId);
	}
}

class Bomb extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.spawnBomb = false;
		this.id = c.tileMap.abilities.bomb.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.spawnBomb = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "bombUsed", this.ownerId);
	}
}
class SpeedBuff extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.applyBuff = false;
		this.id = c.tileMap.abilities.speedBuff.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.applyBuff = true;
		messenger.messageRoomBySig(this.roomSig, "speedBuff", this.ownerId);
	}
}

class SpeedDebuff extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.applyDebuff = false;
		this.id = c.tileMap.abilities.speedDebuff.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.applyDebuff = true;
		messenger.messageRoomBySig(this.roomSig, "speedDebuff", this.ownerId);
	}
}
class TileSwap extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.tileSwap = false;
		this.id = c.tileMap.abilities.tileSwap.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.tileSwap = true;
		messenger.messageRoomBySig(this.roomSig, "tileSwap", this.ownerId);
	}
}

class Cut extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.applyCut = false;
		this.id = c.tileMap.abilities.cut.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.applyCut = true;
		messenger.messageRoomBySig(this.roomSig, "cutUsed", this.ownerId);
	}
}


class BombTrigger extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.explodeBomb = false;
		this.id = c.tileMap.abilities.bombTrigger.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.explodeBomb = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "bombTriggered", this.ownerId);
	}
}



