'use strict';
var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');
var hostess = require('./hostess.js');
var _engine = require('./engine.js');
var compressor = require('./compressor.js');
var debug = require('./debug.js');
var cellGraph = require('./cellGraph.js');
var aiController = require('./aiController.js');
var { emitBotEmote, botsCheerFor } = require('./botEmotes.js');
var { Shape, Rect, Circle, Gate } = require('./entities/shapes.js');
var { World } = require('./entities/world.js');
var { Player, LobbyStartButton, LobbyStation } = require('./entities/player.js');
var { ExplosionAimer, SwapAimer } = require('./entities/aimers.js');
var { Punch } = require('./entities/punch.js');
var { HazardRail, Hazard, Bumper } = require('./entities/hazards.js');
var { Projectile, CloudProj, SnowFlakeProj, BombProj, Puck } = require('./entities/projectiles.js');
var { Ability, Blindfold, Swap, IceCannon, Bomb, SpeedBuff, SpeedDebuff, TileSwap, Cut, BombTrigger } = require('./entities/abilities.js');

exports.getRoom = function (sig, size) {
	return new Room(sig, size);
}

// Monotonic id source for headless AI racers. Bot ids are namespaced ("bot-N")
// so they never collide with socket ids (which key human players in playerList).
var botSeq = 0;

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
		this.isPreview = false;
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
		var hazardData = compressor.sendHazardUpdates(this.hazardList);
		var gameStateData = compressor.gameState(this.game);
		messenger.messageRoomBySig(this.sig, "gameUpdates", {
			playerList: playerData,
			projList: projData,
			aimerList: aimerData,
			hazardList: hazardData,
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
			// Bots have no socket/mailbox; messageClientBySig would throw. They
			// also never set kick (Player.update skips checkForSleep for AI), but
			// guard here too so a bot can never reach the socket-only kick path.
			if (this.playerList[id].isAI) {
				continue;
			}
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
		//AI racers: grid size is rolled once per game and held across rounds.
		this.botTarget = null;
		// SPIKE (lobby AI hub): a room-level override set from the lobby AI station.
		// null = legacy behaviour (random botTarget). Otherwise { enabled, count } and
		// fillGridWithBots honours it. Persists across games (a room setting, not per-game).
		this.botOverride = null;

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
		//Server-authoritative background music ({mood, track}); null until a race starts
		this.currentMusic = null;
		//When currentMusic.track was last chosen, for the fallback rotation timer
		this.musicChangedAt = null;
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
			this.updateMusicMood();
			this.checkMusicFallback();
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
		if (this.currentState == c.stateMap.lobby && this.gameBoard.currentMap != null && this.gameBoard.currentMap.spawnPad != null) {
			// Mid-lobby join: drop onto the safe spawn pad, not a random spot (which
			// could be the lava island now that lobby terrain is live).
			this.gameBoard.placePlayerOnSpawnPad(newPlayer);
			return;
		}
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
		if (this.currentState == c.stateMap.lobby) {
			// Late join into a running lobby: the room-wide startLobby broadcast already
			// fired before this client joined, so deliver the curated map + button +
			// bumpers (and any tile mutations) just to them. Without this, every player
			// after the first sees an empty lobby.
			if (this.gameBoard.lobbyStartButton != null) {
				var lobbyMapID = (this.gameBoard.currentMap != null && this.gameBoard.currentMap.cells != null) ? this.gameBoard.currentMap.id : null;
				client.emit("startLobby", compressor.sendLobbyStart(this.gameBoard.lobbyStartButton, lobbyMapID));
				client.emit("applyHazards", compressor.newHazards(this.gameBoard.hazardList));
				client.emit("tileChanges", JSON.stringify(this.gameBoard.gatherTileChanges()));
				// So the late joiner sees ability indicators for players already holding one.
				client.emit("allAbilityHoldings", JSON.stringify(this.gameBoard.gatherAbilities()));
				// So the late joiner sees the invuln flash on players who respawned (or are
				// parked safe in the start circle) before they joined — the per-player
				// lobbyRespawn event was one-shot and they missed it.
				client.emit("lobbyInvulnStates", this.gameBoard.gatherInvulnStates());
			}
			return;
		}
		if (this.currentState == c.stateMap.waiting || this.currentState == c.stateMap.gameOver) {
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
		debug.log("checkLobbyStart: playerCount=", this.playerCount, " min=", c.minPlayersToStart, " state=", this.currentState);
		if (this.playerCount >= c.minPlayersToStart) {
			this.startLobby();
		}
	}
	checkGatedStart() {
		//Reset back to waiting if someone leaves
		if (this.playerCount < c.minPlayersToStart) {
			this.startWaiting();
			this.resetLobbyTimer();
			return;
		}
		//Preview play-test: the solo creator has no one to rally on the lobby
		//start button, so skip the lobby and head straight to the race gate.
		if (this.gameBoard.isPreview) {
			this.startGated();
			return;
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
				this.playerList[player].survivalist += 1;
				if (this.gameBoard.brutalRound) {
					this.playerList[player].brutalist += 1;
				}
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
					emitBotEmote(this.playerList[player], "win");
					botsCheerFor(this.playerList, player); // others clap/react
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
				// A true single-player room (no rivals, no bots) gets a collapse
				// tuned to the map so a competent line can win, instead of the
				// map-blind 15s/random-goal last-player collapse.
				if (this.playerCount == 1 && this.scheduleSoloCollapse()) {
					return;
				}
				setTimeout(function (context) {
					if (context.currentState == c.stateMap.racing || context.currentState == c.stateMap.collapsing) {
						var goal = context.gameBoard.findRandomGoalTile();
						if (goal == null) {
							return;
						}
						context.startCollapse(goal.x, goal.y);
					}
				}, 15000, this);
			}
		}
	}
	// Fill the race grid with headless AI racers. Called at the start of each
	// race (startGated). The grid total is rolled once per game (botTarget) and
	// held across rounds; we only ever top up toward it, never despawn bots when
	// humans join mid-game. A bot-only room is never created (humanCount == 0
	// bails). Bots are spawned exactly like a joining human — added to playerList
	// (not clientList), placed by determineGameState for the current state, and
	// announced with playerJoin so connected clients render them.
	fillGridWithBots() {
		var ai = c.aiRacers;
		if (!ai || !ai.enabled) {
			return;
		}
		var humanCount = 0, botCount = 0;
		for (var pid in this.playerList) {
			if (this.playerList[pid].isAI) { botCount++; } else { humanCount++; }
		}
		if (humanCount === 0) {
			return;
		}
		// SPIKE (lobby AI hub): a lobby-set override wins over the random grid roll.
		// { enabled:false } => no bots at all; { enabled:true, count:N } => exactly N
		// bots regardless of human count. null => legacy random-grid behaviour.
		var desiredBots;
		if (this.botOverride != null) {
			if (!this.botOverride.enabled) {
				return;
			}
			desiredBots = this.botOverride.count;
		} else {
			if (this.botTarget == null) {
				this.botTarget = utils.getRandomInt(ai.minGrid, ai.maxGrid);
			}
			desiredBots = this.botTarget - humanCount;
		}
		if (desiredBots < 0) { desiredBots = 0; }
		// Never let bots overflow the room: humans + bots must fit maxPlayersInRoom.
		// A lobby AI override can ask for more bots than there's room for once the
		// lobby fills up, so clamp it authoritatively here at spawn time.
		var botCapacity = (c.maxPlayersInRoom || 25) - humanCount;
		if (botCapacity < 0) { botCapacity = 0; }
		if (desiredBots > botCapacity) { desiredBots = botCapacity; }
		if (desiredBots <= botCount) {
			return;
		}
		var roster = this.pickBotCast(desiredBots);
		for (var i = botCount; i < desiredBots; i++) {
			var id = "bot-" + (++botSeq);
			var bot = this.world.createNewBot(id, roster[i]);
			this.playerList[id] = bot;
			this.determineGameState(bot);
			messenger.messageRoomBySig(this.roomSig, "playerJoin", {
				id: id,
				player: compressor.appendPlayer(bot)
			});
		}
	}
	// Draw `count` racer identities from the config cast. Distinct personalities
	// while the cast lasts (shuffled), then repeats with a numeric suffix so the
	// grid can exceed the cast size without confusing duplicate names. Biased to
	// open with the pace-setter (Ghost) and the rival (Nemesis) when present.
	pickBotCast(count) {
		var cast = (c.aiRacers && c.aiRacers.cast) ? c.aiRacers.cast.slice() : [];
		if (cast.length === 0) {
			cast = [{ id: "racer", name: "Racer", title: "Racer" }];
		}
		// Fisher-Yates shuffle.
		for (var s = cast.length - 1; s > 0; s--) {
			var j = Math.floor(Math.random() * (s + 1));
			var tmp = cast[s]; cast[s] = cast[j]; cast[j] = tmp;
		}
		// Float Ghost then Nemesis to the front so a typical race has a pace-setter
		// and a rival without forcing them every time the grid is small.
		this.floatToFront(cast, "nemesis");
		this.floatToFront(cast, "ghost");
		var roster = [];
		for (var i = 0; i < count; i++) {
			var base = cast[i % cast.length];
			var rep = Math.floor(i / cast.length);
			if (rep === 0) {
				roster.push(base);
			} else {
				// A repeat shares the base personality's FULL profile (skill, traits,
				// emotes) — only the name is suffixed — so it behaves and emotes like
				// its namesake rather than a generic, silent bot.
				var dup = Object.assign({}, base);
				dup.name = base.name + " " + (rep + 1);
				roster.push(dup);
			}
		}
		return roster;
	}
	floatToFront(cast, id) {
		for (var i = 0; i < cast.length; i++) {
			if (cast[i].id === id) {
				var picked = cast.splice(i, 1)[0];
				cast.unshift(picked);
				return;
			}
		}
	}
	// Drop all AI racers and re-roll the grid size for the next game.
	removeBots() {
		for (var id in this.playerList) {
			if (this.playerList[id].isAI) {
				messenger.messageRoomBySig(this.roomSig, "playerLeft", id);
				delete this.playerList[id];
			}
		}
		this.botTarget = null;
	}
	// Schedule a fair, map-aware collapse for a solo player. Uses the Phase 0
	// cell graph to find the goal nearest the player's current position and the
	// shortest traversable distance to it, derives a "par time" from that
	// distance and the player's realistic speed, then collapses from that goal at a
	// front speed slower than that realistic speed by config.soloCollapse.marginFactor
	// (so an optimal line beats it with margin to spare). Returns true if a solo
	// collapse was scheduled, false to fall back to the legacy last-player path
	// (e.g. no reachable goal from where the player is).
	scheduleSoloCollapse() {
		var player = null;
		for (var id in this.playerList) {
			var p = this.playerList[id];
			if (p.alive && !p.isSpectator && !p.isZombie && p.awake) {
				player = p;
				break;
			}
		}
		if (player == null) {
			return false;
		}
		var map = this.gameBoard.currentMap;
		var route = cellGraph.findPathToNearestGoal(map, { x: player.x, y: player.y });
		if (route == null) {
			// No goal reachable without crossing lava from where the player is.
			// Flag it and let the lenient legacy collapse run so the room never
			// soft-locks on an unbeatable layout.
			console.warn("Solo map has no goal reachable from player position (mapId=" + map.id + "); using fallback collapse.");
			return false;
		}

		var cfg = c.soloCollapse;
		var secondsPerTick = c.serverTickSpeed / 1000;
		// Par = the map's stored canonical par (physics drive gate->nearest goal)
		// plus a buffer for the random gate-spawn y (a solo player can spawn farther
		// from the goal than the canonical line). Live fallback if the map lacks it.
		var parTime = (map.parTime != null && map.parTime > 0) ? map.parTime : cellGraph.estimatePathTime(map, route.path);
		if (parTime <= 0) { parTime = route.distance / 40; }
		parTime += cfg.spawnBufferSeconds;

		// Front starts at the player's path distance from the goal (cap at the
		// world diagonal so a very mazey route doesn't create a long dead lead-in)
		// plus a buffer so the player's current cell isn't lava on the first tick.
		var worldDiagonal = Math.sqrt(this.world.width * this.world.width + this.world.height * this.world.height);
		var startDistance = Math.min(route.distance, worldDiagonal) + cfg.startDistanceBuffer;

		// Front closes the whole start distance in parTime * marginFactor seconds,
		// so it adapts to how slow/twisty the map actually is and a competent line
		// always beats it. (Was a flat speed that outran players on hard maps.)
		var collapseSpeed = (startDistance / (parTime * cfg.marginFactor)) * secondsPerTick;
		if (collapseSpeed < cfg.minCollapseSpeed) {
			collapseSpeed = cfg.minCollapseSpeed;
		}

		var grace = parTime * cfg.graceDelayFactor;
		if (grace < cfg.minGraceSeconds) grace = cfg.minGraceSeconds;
		if (grace > cfg.maxGraceSeconds) grace = cfg.maxGraceSeconds;

		this.gameBoard.soloMode = true;
		this.gameBoard.soloCollapseSpeed = collapseSpeed;
		this.gameBoard.soloStartDistance = startDistance;

		var context = this;
		var goal = route.goal;
		setTimeout(function () {
			if (context.currentState == c.stateMap.racing || context.currentState == c.stateMap.collapsing) {
				context.gameBoard.collapseLine = context.gameBoard.soloStartDistance;
				context.startCollapse(goal.x, goal.y);
			}
		}, grace * 1000);
		return true;
	}
	startWaiting() {
		messenger.messageRoomBySig(this.roomSig, "startWaiting", null);
		this.currentState = this.stateMap.waiting;
	}
	startLobby() {
		console.log("Start Lobby")
		debug.log("startLobby: from state=", this.currentState, " playerCount=", this.playerCount);
		this.currentState = this.stateMap.lobby;
		this.world.resize();
		this.gameBoard.startLobby();
	}
	startGated() {
		console.log("Start Gated");
		this.locked = true;
		// Leaving the lobby tutorial (this is the lobby->race transition; later rounds
		// arrive here from overview): drop any ability picked up in the lobby so it
		// can't be carried into the first real round. reset() only clears ability at
		// gameOver, so abilities legitimately persist between rounds — hence the guard.
		if (this.currentState == this.stateMap.lobby) {
			this.gameBoard.clearLobbyAbilities();
		}
		this.resetForRace();
		this.currentState = this.stateMap.gated;
		this.gameBoard.setupMap(this.currentState);
		// Fill the grid with AI racers after the map (and starting gate) are laid
		// out, so each bot can be placed at the gate via determineGameState.
		// Preview rooms only fill when the editor opted in (previewAI); default
		// off gives the creator a solo, bot-free run of their map. Non-preview
		// rooms are unaffected (isPreview is false -> always fill, as before).
		if (!this.gameBoard.isPreview || this.gameBoard.previewAI) {
			this.fillGridWithBots();
		}
		messenger.messageRoomBySig(this.roomSig, "startGated", null);
	}
	startRace() {
		console.log("Start Race");
		this.currentState = this.stateMap.racing;

		// A few AI racers greet/hype as the gate opens (full emote range, not just taunts).
		for (var gid in this.playerList) {
			if (this.playerList[gid].isAI && Math.random() < 0.3) {
				emitBotEmote(this.playerList[gid], "greet");
			}
		}

		var lightningRound = this.gameBoard.checkForActiveBrutal(c.brutalRounds.lightning.id);

		if (!lightningRound) {
			for (var id in this.playerList) {
				this.playerList[id].setSpeedBonus(0);
			}
		}
		if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.volcano.id)) {
			var eruptionDelay = this.gameBoard.computeVolcanoEruptionDelay();
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
		if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.blackout.id)) {
			var blackoutDelay = utils.getRandomInt(2, 3);
			if (lightningRound) {
				blackoutDelay = utils.getRandomInt(1, 2);
			}
			setTimeout(this.gameBoard.applyBrutalBlackoutRound, blackoutDelay * 1000, { context: this });
		}


		//Keep the current track playing across the load/overview screens — only pick
		//a new one for the first race or when the mood actually changes. The client
		//re-plays the same track as a no-op, so music continues uninterrupted.
		var mood = this.computeMusicMood();
		if (this.currentMusic == null || this.currentMusic.mood != mood) {
			this.setRoomMusic(mood, this.pickMusicTrack(mood, null));
		}

		messenger.messageRoomBySig(this.roomSig, "startRace", { music: this.currentMusic });
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
		// Telegraph: erupt the shockwave from where the lava FIRST appears (the
		// point farthest from the collapse center, which turns to lava first),
		// not from the goal it converges on.
		var origin = this.gameBoard.getCollapseOrigin({ x: xloc, y: yloc });
		messenger.messageRoomBySig(this.roomSig, "startCollapse", { x: xloc, y: yloc, originX: origin.x, originY: origin.y });
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
		this.currentMusic = null;
		this.musicChangedAt = null;
		// A full game is over: drop the AI racers and re-roll the grid for the
		// next game so the cast and field size vary game to game.
		this.removeBots();
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
		//For every dynamicGameLengthModifier players the number of notches to win decreases by 1.
		//Count HUMANS only — AI racers fill the grid but shouldn't shorten the game
		//(otherwise a solo human + bots would collapse to the minimum notches).
		var dynamicGameLengthModifier = 6;

		var humanCount = 0;
		for (var hid in this.playerList) {
			if (!this.playerList[hid].isAI) { humanCount++; }
		}
		if (humanCount < dynamicGameLengthModifier) {
			return;
		}
		var notchesToRemove = Math.ceil(humanCount / dynamicGameLengthModifier);
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
}
Object.assign(Game.prototype, require('./music.js'), require('./achievements.js'));


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
		// Lobby-tutorial idle-reset bookkeeping (set per lobby load in loadLobbyMap).
		this.lobbyMapDirty = false;
		this.lobbyLastActivity = 0;
		// Pending speedBuff/speedDebuff removal timers; tracked so lobby-fired ones can be
		// canceled on game start (otherwise they'd fire mid-race and skew drag/speed).
		this.pendingAbilityTimers = [];
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
		var allMaps = utils.loadMaps();
		// lobbyOnly maps (e.g. the lobby tutorial islands) are kept out of the race
		// rotation; the lobby loads its map from lobbyMaps separately.
		this.maps = allMaps.filter(function (m) { return !m.lobbyOnly; });
		this.lobbyMaps = allMaps.filter(function (m) { return m.lobbyOnly; });
		this.mapsPlayed = [];
		this.currentMap = {};
		this.nextMap = {};
		// Injected-map (preview) mode: when set, every round loads previewMap
		// instead of a random library map. previewMap is a per-instance copy —
		// NEVER push it into the shared this.maps array.
		this.isPreview = false;
		this.previewMap = null;
		// Preview-only: whether the editor asked to fill the grid with AI racers.
		// Default off, so a preview is a solo, bot-free run unless opted in.
		this.previewAI = false;

		this.allAbilityIDs = this.indexAbilities();
		this.collapseLoc = {};
		this.collapseLine = this.world.height;
		this.visionBlockedUntil = 0;
		this.blackoutActive = false;
		this.soloMode = false;
		this.soloCollapseSpeed = c.lastPlayerCollapseSpeed;
		this.soloStartDistance = this.world.height + 400;
		this.firstPlaceSig = null;
		// Room-wide throttle (ms timestamp) so the crowd's near-burn gasp fires
		// at most once per audienceNearBurnCooldown, no matter how many racers
		// are skating the lava edge at once.
		this.nextNearBurnTime = 0;
	}
	update(currentState, playerAliveCount, sleepingPlayerCount, dt) {
		this.alivePlayerCount = playerAliveCount;
		this.sleepingPlayerCount = sleepingPlayerCount;
		// Drive the AI racers' steering before the engine integrates movement, so
		// bots set the same targetDir/braking/angle inputs a human's socket would.
		aiController.update(this, currentState, dt);
		this.engine.update(dt);
		this.collapseMap(currentState);
		this.checkCollisions(currentState);
		this.updatePlayers(currentState, dt);
		this.updateProjectiles(currentState);
		this.checkAbilities(currentState);
		this.updateAimers(currentState);
		this.updateHazards(currentState);
		if (currentState == c.stateMap.lobby) {
			this.checkLobbyMapReset();
			// SPIKE (lobby hub): runs AFTER checkCollisions so touchingStation reflects
			// this tick's overlaps; emits per-player enter/exit edges.
			this.updateStationProximity();
		}
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
			this.collectLobbyCollisionObjects(currentState, objectArray);
		}
		if (currentState == this.stateMap.gated) {
			this.collectGatedCollisionObjects(objectArray);
		}
		if (currentState == this.stateMap.racing || currentState == this.stateMap.collapsing) {
			this.collectRaceCollisionObjects(currentState, objectArray);
		}
		this.engine.broadBase(objectArray);
	}
	// Interactive lobby: curated abilities are live, so projectiles/hazards/aimers
	// and the start button all join the collision set as teaching props.
	collectLobbyCollisionObjects(currentState, objectArray) {
		for (var player in this.playerList) {
			if (!this.playerList[player].alive) {
				continue;
			}
			_engine.preventEscape(this.playerList[player], this.world);
			// Stamp state now (updatePlayers runs after this), so handleHit's lobby
			// branches read the right state on the same tick they collide.
			this.playerList[player].currentState = currentState;
			// Terrain collision is normally racing/collapsing only. Enabling it here
			// is what makes the curated islands interactive (physics, lava/goal
			// teaching props, ability pickups). Guarded so a plain (mapless) lobby
			// still works.
			if (this.currentMap != null && this.currentMap.cells != null) {
				_engine.checkCollideCells(this.playerList[player], this.currentMap);
			}
			objectArray.push(this.playerList[player]);
		}
		// Curated abilities are live in the lobby (bomb + ice cannon), so projectiles
		// must collide with players and ice cannon must be able to freeze terrain —
		// mirror the racing projectile pass. Hazards (the bumpers) and aimers join the
		// collision set so they knock players around as a teaching prop.
		for (var projID in this.projectileList) {
			if (this.projectileList[projID].type == "cloud") {
				_engine.checkFlipAroundWorld(this.projectileList[projID], this.world);
				continue;
			}
			_engine.bounceOffBoundry(this.projectileList[projID], this.world);
			if (this.projectileList[projID].type == "snowFlake" && this.currentMap != null && this.currentMap.cells != null) {
				_engine.checkCollideCells(this.projectileList[projID], this.currentMap);
			}
			objectArray.push(this.projectileList[projID]);
		}
		for (var aimerId in this.aimerList) {
			objectArray.push(this.aimerList[aimerId]);
		}
		for (var hazardId in this.hazardList) {
			objectArray.push(this.hazardList[hazardId]);
		}
		for (var punchId in this.punchList) {
			objectArray.push(this.punchList[punchId]);
		}
		objectArray.push(this.lobbyStartButton);
		// SPIKE (lobby hub): walk-up stations join the collision set so handleHit can
		// stamp per-player overlap; the enter/exit edge is derived in updateStationProximity.
		if (this.lobbyStations != null) {
			for (var sIdx = 0; sIdx < this.lobbyStations.length; sIdx++) {
				objectArray.push(this.lobbyStations[sIdx]);
			}
		}
	}
	collectGatedCollisionObjects(objectArray) {
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
	collectRaceCollisionObjects(currentState, objectArray) {
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
	checkAbilities(currentState) {
		for (var id in this.abilityList) {
			if (this.abilityList[id] == null) {
				delete this.abilityList[id];
				continue;
			}
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
				// Tracked so a lobby bomb fired right before game-start can't grant its
				// detonator (BombTrigger) into the first race (canceled in clearLobbyAbilities).
				this.pendingAbilityTimers.push(setTimeout(this.acquireBombTrigger, 200, { id: this.abilityList[id].ownerId, abilityList: this.abilityList, playerList: this.playerList, roomSig: this.roomSig }));
			}
			if (this.abilityList[id].spawnSnowFlake) {
				this.abilityList[id].spawnSnowFlake = false;
				this.spawnSnowFlake(this.abilityList[id].ownerId);
			}
			if (this.abilityList[id].explodeBomb) {
				this.abilityList[id].explodeBomb = false;
				// The bomb may already be gone (auto-expired after its lifetime, or
				// detonated) by the time the trigger fires — guard the deref so
				// triggering a spent bomb just clears the trigger instead of crashing.
				var bombProj = this.projectileList[this.abilityList[id].ownerId];
				if (bombProj != null) {
					bombProj.explodeBomb();
				}
			}
			if (this.abilityList[id].applyBuff) {
				this.abilityList[id].applyBuff = false;
				this.pendingAbilityTimers.push(setTimeout(this.removeSpeedBuff, c.tileMap.abilities.speedBuff.duration, { id: this.abilityList[id].ownerId, playerList: this.playerList, delta: this.applySpeedBuff(this.abilityList[id].ownerId) }));
			}
			if (this.abilityList[id].applyDebuff) {
				this.abilityList[id].applyDebuff = false;
				this.pendingAbilityTimers.push(setTimeout(this.removeSpeedDebuff, c.tileMap.abilities.speedDebuff.duration, { id: this.abilityList[id].ownerId, playerList: this.playerList, deltaList: this.applySpeedDebuff(this.abilityList[id].ownerId) }));
			}
			if (this.abilityList[id].tileSwap) {
				this.abilityList[id].tileSwap = false;
				this.startTileSwap();
			}
			if (this.abilityList[id].blind) {
				this.abilityList[id].blind = false;
				// Room-wide vision block: bots self-handicap their steering for the
				// duration so a blindfold bites the AI as it bites a human.
				this.visionBlockedUntil = Date.now() + c.tileMap.abilities.blindfold.duration * 1000;
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
		// Punch directionality policy (resolved here, applied in checkAttack):
		//  - Hockey: radial for everyone, so you can smack the puck from any side.
		//  - Infection: zombies must aim their bite (directional), but survivors
		//    swat zombies in any direction (radial).
		//  - Otherwise: per config.directionalPunch.
		var hockeyRound = this.checkForActiveBrutal(c.brutalRounds.hockey.id);
		var infectionRound = this.checkForActiveBrutal(c.brutalRounds.infection.id);
		for (var playerID in this.playerList) {
			var player = this.playerList[playerID];
			// handleHit (during checkCollisions, just above) flags lobby lava/goal hits
			// instead of running the real death/win path; perform the safe respawn here
			// where the spawn pad and playerList are in scope.
			if (player.lobbyRespawnPending != null) {
				this.respawnInLobby(player, player.lobbyRespawnPending);
				player.lobbyRespawnPending = null;
			}
			if (player.acquiredAbility != null) {
				// Never register a null ability — a null entry would crash
				// checkAbilities on the next tick (it reads abilityList[id].flag).
				if (player.ability != null) {
					this.abilityList[playerID] = player.ability;
				}
				if (player.acquiredAbility.mapID != null) {
					var consumedVid = player.acquiredAbility.mapID;
					this.changeTile(consumedVid, c.tileMap.normal.id);
					// Lobby-only: the curated ability tile is one-shot (rewritten to normal
					// on pickup). Restore it to its pristine ability id after a short delay
					// so every player gets to learn it, not just the first per cycle.
					if (currentState == c.stateMap.lobby) {
						var pristineId = this.getPristineCellId(consumedVid);
						if (pristineId != null && pristineId > 99) {
							setTimeout(this.respawnLobbyAbilityTile, c.lobbyAbilityTileRespawnMs, { context: this, voronoiId: consumedVid, id: pristineId, mapId: this.currentMap.id });
						}
					}
				}
				player.acquiredAbility = null;
			}
			var punchDirectional = c.directionalPunch;
			if (hockeyRound) {
				punchDirectional = false;
			} else if (infectionRound && !player.isZombie) {
				punchDirectional = false;
			}
			player.update(currentState, dt, punchDirectional);
			if (currentState == c.stateMap.lobby) {
				this.updateLobbyInvulnHold(player);
			}
			if (player.punch != null) {
				this.punchList[player.id] = player.punch;
				setTimeout(this.terminatePunch, 100, { id: player.id, punchList: this.punchList, roomSig: this.roomSig });
				player.punch = null;
			}
		}
	}
	// The start circle is a safe haven: a player who reaches it while still invulnerable
	// keeps that invulnerability (held) until they leave, so a griefed player can die,
	// walk to the center, and wait out the round start safely. Latch: arriving with timed
	// invuln sets the hold; leaving the circle clears it; the hold persists in between
	// even after the timed grace runs out.
	updateLobbyInvulnHold(player) {
		if (this.lobbyStartButton == null) {
			return;
		}
		var dx = player.x - this.lobbyStartButton.x;
		var dy = player.y - this.lobbyStartButton.y;
		var reach = this.lobbyStartButton.radius + player.radius;
		var inCircle = (dx * dx + dy * dy) <= (reach * reach);
		if (!inCircle) {
			player.invulnHeldInCircle = false;
		} else if (player.isTimedInvuln()) {
			player.invulnHeldInCircle = true;
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
				var tileDelta = {};
				for (var vid in this.projectileList[id].tileChanges) {
					var newTileId = this.projectileList[id].tileChanges[vid];
					this.changeTile(vid, newTileId);
					tileDelta[vid] = newTileId;
					delete this.projectileList[id].tileChanges[vid];
				}
				messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(tileDelta));
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
	// Snapshot of currently-invulnerable players for late joiners (lobby): remaining
	// timed grace (ms) + whether they're held safe in the start circle. The joining
	// client seeds these so the invuln flash shows correctly from the start.
	gatherInvulnStates() {
		var states = [];
		for (var id in this.playerList) {
			var player = this.playerList[id];
			if (player.isInvuln()) {
				states.push({ id: id, remainingMs: Math.max(0, player.invulnUntil - Date.now()), held: player.invulnHeldInCircle === true });
			}
		}
		return states;
	}
	gatherTileChanges() {
		return this.tileChanges;
	}

	// TileSwap now telegraphs before it fires: clients are told which tiles are
	// about to flip (so they can pulse/flicker), and the actual swap is delayed
	// a random 3-6s. swapTiles() below still performs the flip when the timer
	// fires.
	startTileSwap() {
		if (this.currentMap == null || this.currentMap.cells == null) {
			return;
		}
		var cells = this.currentMap.cells;
		var pending = [];
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.fast.id || cells[i].id == c.tileMap.ice.id) {
				pending.push(cells[i].site.voronoiId);
			}
		}
		if (pending.length == 0) {
			return;
		}
		var ts = c.tileMap.abilities.tileSwap;
		var min = ts.minSwapDelay != null ? ts.minSwapDelay : 3000;
		var max = ts.maxSwapDelay != null ? ts.maxSwapDelay : 6000;
		var delay = min + Math.floor(Math.random() * (max - min + 1));
		messenger.messageRoomBySig(this.roomSig, "tileSwapPending", JSON.stringify({ ids: pending, duration: delay }));
		// Track the timer like every other ability timer so it gets cancelled on
		// round/match end — otherwise it can fire against a torn-down room or swap
		// tiles after the round has logically ended.
		this.pendingAbilityTimers.push(setTimeout(this.performTileSwap, delay, { context: this, map: this.currentMap }));
	}
	performTileSwap(packet) {
		var gameBoard = packet.context;
		// Bail if the round/map changed while the timer was pending — currentMap
		// is a fresh object each round, so a reference check catches that.
		if (gameBoard.currentMap !== packet.map) {
			return;
		}
		gameBoard.swapTiles();
	}

	swapTiles() {
		//Find all fast tiles, find all ice tiles, swap them
		var cells = this.currentMap.cells;
		var tileDelta = {};
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.fast.id) {
				cells[i].id = c.tileMap.ice.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				tileDelta[cells[i].site.voronoiId] = cells[i].id;
				continue;
			}
			if (cells[i].id == c.tileMap.ice.id) {
				cells[i].id = c.tileMap.fast.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				tileDelta[cells[i].site.voronoiId] = cells[i].id;
				continue;
			}
		}
		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(tileDelta));
		// Tell clients the swap itself just landed (distinct from any other tile
		// change), carrying the ids it flipped, so the delayed swap sound fires
		// exactly once at the flip and the right tiles stop telegraphing.
		var swappedIds = Object.keys(tileDelta);
		if (swappedIds.length > 0) {
			messenger.messageRoomBySig(this.roomSig, "tileSwapPerformed", JSON.stringify(swappedIds));
		}
	}
	cutPlayers(owner) {
		for (var id in this.playerList) {
			if (id == owner) {
				continue;
			}
			// Same force-shield as applyExplosionForce: don't cut-fling a protected
			// (invuln / spawn-pad) player. No-op outside the lobby.
			if (this.playerList[id].isProtected()) {
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
		// Send both endpoints (the players' positions just after they exchanged)
		// so the client can puff teleport effects where players actually land,
		// not where the owner used to be.
		messenger.messageRoomBySig(gameBoard.roomSig, "playerSwapped", JSON.stringify({
			owner: packet.owner,
			points: [
				{ x: ownerPlayer.x, y: ownerPlayer.y },
				{ x: randomPlayer.x, y: randomPlayer.y }
			]
		}));
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
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.lava.id || cells[i].id == c.tileMap.background.id) {
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
		// Mark the lobby map mutated so the idle-gated reset can later restore it.
		this.lobbyMapDirty = true;
		this.lobbyLastActivity = Date.now();
		messenger.messageRoomBySig(this.roomSig, 'triggerUsed', owner);
		messenger.messageRoomBySig(this.roomSig, 'explodedCells', explodedCells);
	}
	explodeIce(owner) {
		if (this.playerList[owner] != null && this.playerList[owner].alive == true && !this.playerList[owner].isZombie) {
			this.playerList[owner].removeSpeed(100);
		}
		var explodeLoc = { x: this.projectileList[owner].x, y: this.projectileList[owner].y };
		var cells = this.currentMap.cells;
		var tileDelta = {};
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.background.id) {
				continue;
			}
			var distance = utils.getMag(explodeLoc.x - cells[i].site.x, explodeLoc.y - cells[i].site.y);
			if (c.tileMap.abilities.iceCannon.explosionRadius > distance) {
				cells[i].id = c.tileMap.ice.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				tileDelta[cells[i].site.voronoiId] = cells[i].id;
			}
		}
		this.applyExplosionForce(explodeLoc, owner);
		this.lobbyMapDirty = true;
		this.lobbyLastActivity = Date.now();
		messenger.messageRoomBySig(this.roomSig, 'snowFlakeExploded', { owner: owner, x: explodeLoc.x, y: explodeLoc.y });
		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(tileDelta));
	}
	explodeLava(explodeLoc, radius) {
		var cells = this.currentMap.cells;
		var tileDelta = {};
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.background.id) {
				continue;
			}
			var distance = utils.getMag(explodeLoc.x - cells[i].site.x, explodeLoc.y - cells[i].site.y);
			if (radius > distance) {
				cells[i].id = c.tileMap.lava.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				tileDelta[cells[i].site.voronoiId] = cells[i].id;
			}
		}
		this.applyExplosionForce(explodeLoc, null);
		messenger.messageRoomBySig(this.roomSig, 'lavaExplosion');
		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(tileDelta));
	}
	applyExplosionForce(loc, owner) {
		for (var id in this.playerList) {
			var player = this.playerList[id];
			// Force functions bypass the lava/goal damage guards (they mutate velocity
			// directly), so respect protection here too — otherwise a bomb could fling an
			// invuln or spawn-pad player into lava in the lobby. No-op outside the lobby.
			if (player.isProtected()) {
				continue;
			}
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
		this.loadLobbyMap();
		// Gather players onto the safe spawn pad as the tutorial map appears, so nobody
		// is left standing on the lava island when collision switches on. Skipped for a
		// plain (mapless) lobby, where the old free-roam behaviour is kept.
		if (this.currentMap != null && this.currentMap.spawnPad != null) {
			for (var id in this.playerList) {
				this.placePlayerOnSpawnPad(this.playerList[id]);
			}
		}
		this.lobbyStartButton = new LobbyStartButton(this.world.center.x, this.world.center.y, 0, "red");
		this.buildLobbyStations();
		var lobbyMapID = (this.currentMap != null && this.currentMap.cells != null) ? this.currentMap.id : null;
		messenger.messageRoomBySig(this.roomSig, "startLobby", compressor.sendLobbyStart(this.lobbyStartButton, lobbyMapID));
		messenger.messageRoomBySig(this.roomSig, "lobbyStations", compressor.sendLobbyStations(this.lobbyStations));
		// Deliver the lobby bumpers so the client creates them (gameUpdates only moves
		// hazards the client already knows about; creation is via this applyHazards path,
		// the same payload shape the newMap event uses for races).
		messenger.messageRoomBySig(this.roomSig, "applyHazards", compressor.newHazards(this.hazardList));
	}
	// Instantiate the walk-up hub stations for this lobby. Positions come from an
	// optional map-JSON `stations` array (authored on verified-clear ground, like
	// `spawnPad` — see _lobbyTutorial.json); if the map omits it we fall back to code
	// defaults that flank the central start button on the center row, so the lobby
	// always has reachable stations even on a plain field.
	buildLobbyStations() {
		this.lobbyStations = [];
		var R = 60; // station radius (a little smaller than the 75px start button)
		var defaults = [
			{ id: "ai", kind: "ai", cx: this.world.width * 0.33, cy: this.world.height * 0.5, color: "#3ad17a" },
			{ id: "skin", kind: "skin", cx: this.world.width * 0.67, cy: this.world.height * 0.5, color: "#4aa3ff" }
		];
		var authored = (this.currentMap != null && Array.isArray(this.currentMap.stations))
			? this.currentMap.stations
			: null;
		var src = authored || defaults;
		for (var i = 0; i < src.length; i++) {
			var s = src[i];
			this.lobbyStations.push(new LobbyStation(s.cx, s.cy, s.r || R, s.id, s.kind, s.color || "#888"));
		}
		// Risk §9.3: a player standing in a zone when the lobby map idle-resets (this
		// runs again) would otherwise diff against a stale nearStation and emit a
		// spurious exit. Clear proximity latches whenever the stations are rebuilt.
		for (var id in this.playerList) {
			this.playerList[id].nearStation = null;
			this.playerList[id].touchingStation = null;
		}
	}
	// SPIKE (lobby hub): once-per-tick enter/exit edge detection. handleHit stamps
	// `touchingStation` on any player overlapping a station this tick; here we diff it
	// against the latched `nearStation` to emit ENTER (newly inside) and EXIT (no longer
	// inside) to that player's OWN socket — which is what makes the UI per-slot in local
	// co-op (each local player has its own socket). Bots are skipped (no socket, no UI).
	updateStationProximity() {
		for (var id in this.playerList) {
			var p = this.playerList[id];
			if (p.isAI) {
				p.touchingStation = null;
				continue;
			}
			var now = p.touchingStation;   // station id this tick, or null
			var was = p.nearStation;        // station id last tick, or null
			if (now !== was) {
				if (was != null) {
					this.emitStationEdge(id, "stationExit", was);
				}
				if (now != null) {
					this.emitStationEdge(id, "stationEnter", now);
				}
				p.nearStation = now;
			}
			p.touchingStation = null; // consumed; re-stamped next tick by handleHit
		}
	}
	emitStationEdge(playerId, header, stationId) {
		var station = null;
		for (var i = 0; i < this.lobbyStations.length; i++) {
			if (this.lobbyStations[i].stationId === stationId) {
				station = this.lobbyStations[i];
				break;
			}
		}
		if (station == null || messenger.getClient(playerId) == null) {
			return; // station gone, or no live socket for this player
		}
		messenger.messageClientBySig(playerId, header, { id: stationId, kind: station.stationKind });
	}
	// Place a player on the background spawn pad (used for the lobby start and for
	// players who join mid-lobby). onSanctuary keeps them force-shielded on the pad.
	placePlayerOnSpawnPad(player) {
		var loc = this.getLobbySpawnLoc();
		player.x = loc.x;
		player.y = loc.y;
		player.newX = loc.x;
		player.newY = loc.y;
		player.velX = 0;
		player.velY = 0;
		player.initialLoc = { x: loc.x, y: loc.y };
		player.onSanctuary = true;
		player.onFire = 0;
		player.fireTimer = null;
	}
	// Load the curated tutorial-islands map into the lobby. lobbyMaps[0] stays the
	// pristine template (we clone from it), so the reset cadence can restore the
	// layout after bomb/ice-cannon mutate cells. No-op (empty map) if no lobby map
	// is authored, so the lobby simply falls back to the plain field + button.
	loadLobbyMap() {
		this.tileChanges = {};
		// Fresh pristine layout, so the idle-reset bookkeeping starts clean.
		this.lobbyMapDirty = false;
		this.lobbyLastActivity = Date.now();
		if (this.lobbyMaps == null || this.lobbyMaps.length == 0) {
			this.currentMap = {};
			this.resetHazards();
			return;
		}
		this.currentMap = JSON.parse(JSON.stringify(this.lobbyMaps[0]));
		// Spawn the map's bumpers (a knock-you-around teaching prop). generateHazards
		// reads currentMap.hazards and is the same path races use; the per-tick
		// gameUpdates carries them to the client.
		this.generateHazards();
	}
	// Drop every ability acquired during the lobby tutorial. Called on the lobby->race
	// transition only (see Game.startGated). Projectiles/hazards/aimers are cleared
	// separately by setupMap -> clean()/resetPlayers().
	clearLobbyAbilities() {
		this.abilityList = {};
		for (var id in this.playerList) {
			// Drop both the held ability and any just-grabbed-but-unprocessed pickup, so
			// nothing collected in the lobby carries into the first real round.
			this.playerList[id].ability = null;
			this.playerList[id].acquiredAbility = null;
		}
		// Cancel pending lobby-fired ability timers (speed-buff/debuff removal and the
		// bomb-trigger grant) so none fire mid-race: speed timers would skew drag/speed
		// after reset() normalizes it, and the bomb-trigger timer would hand a player a
		// detonator in the first round. (reset() clears already-applied effects; this
		// stops the late ones.)
		for (var i = 0; i < this.pendingAbilityTimers.length; i++) {
			clearTimeout(this.pendingAbilityTimers[i]);
		}
		this.pendingAbilityTimers = [];
	}
	// Original id of a cell in the pristine lobby template (lobbyMaps[0]), used to
	// restore a consumed ability tile and to detect mutated cells for the idle reset.
	getPristineCellId(voronoiId) {
		if (this.lobbyMaps == null || this.lobbyMaps.length == 0) {
			return null;
		}
		var cells = this.lobbyMaps[0].cells;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].site.voronoiId == voronoiId) {
				return cells[i].id;
			}
		}
		return null;
	}
	// Fast lobby-only ability-tile respawn (scheduled on pickup). Restores the tile to
	// its ability id and broadcasts the change. Bails if the lobby map was swapped out
	// (e.g. a race started) so a stale timeout can't rewrite a race map.
	respawnLobbyAbilityTile(packet) {
		var self = packet.context;
		if (self.currentMap == null || self.currentMap.cells == null || self.currentMap.id != packet.mapId) {
			return;
		}
		self.changeTile(packet.voronoiId, packet.id);
		messenger.messageRoomBySig(self.roomSig, "tileChanges", JSON.stringify(self.gatherTileChanges()));
	}
	// Idle-gated safety reset (analysis decision 8): if bomb/ice-cannon have mutated the
	// lobby and there's been no ability/projectile activity for lobbyIdleResetMs, restore
	// the pristine layout. The idle gate means active players are never interrupted, but a
	// mutated-then-abandoned lobby self-heals. Runs only in the lobby tick.
	checkLobbyMapReset() {
		if (!this.lobbyMapDirty) {
			return;
		}
		if (Object.keys(this.projectileList).length > 0) {
			this.lobbyLastActivity = Date.now();
			return;
		}
		if (Date.now() - this.lobbyLastActivity < c.lobbyIdleResetMs) {
			return;
		}
		this.restoreLobbyMap();
	}
	// Reapply pristine cell ids from the lobby template and broadcast the diff. currentMap
	// is a deep clone of lobbyMaps[0], so cell indexes line up one-to-one.
	restoreLobbyMap() {
		if (this.currentMap == null || this.currentMap.cells == null || this.lobbyMaps == null || this.lobbyMaps.length == 0) {
			this.lobbyMapDirty = false;
			return;
		}
		var pristine = this.lobbyMaps[0].cells;
		for (var i = 0; i < this.currentMap.cells.length; i++) {
			var cell = this.currentMap.cells[i];
			if (i < pristine.length && cell.id != pristine[i].id) {
				cell.id = pristine[i].id;
				this.tileChanges[cell.site.voronoiId] = cell.id;
			}
		}
		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(this.gatherTileChanges()));
		this.lobbyMapDirty = false;
	}
	// The single safe-respawn helper for the lobby tutorial. Deliberately touches ONLY
	// cosmetic/positional state: it never calls killPlayer/removeNotch/addNotch, never
	// sets reachedGoal, and never sends playerConcluded — so a lobby full of lava deaths
	// and goal touches leaves notches and achievement stats byte-for-byte unchanged.
	// type is "death" or "goal" purely to pick which feedback cue the client plays.
	respawnInLobby(player, type) {
		var loc = this.getLobbySpawnLoc();
		player.x = loc.x;
		player.y = loc.y;
		player.newX = loc.x;
		player.newY = loc.y;
		player.velX = 0;
		player.velY = 0;
		player.currentSpeedBonus = 0;
		// CRITICAL: clear onFire. The race-start reset() only clears it in the gameOver
		// branch, so a lobby fire state would otherwise bleed into the first real round.
		player.onFire = 0;
		player.fireTimer = null;
		// Reset grip so dying on ice doesn't leave the player sliding at the pad.
		player.acel = c.playerBaseAcel;
		player.dragCoeff = c.playerDragCoeff;
		player.brakeCoeff = c.playerBrakeCoeff;
		player.invulnUntil = Date.now() + c.lobbyRespawnInvulnMs;
		player.invulnHeldInCircle = false; // re-latches once they reach the start circle
		player.onSanctuary = true; // landed on the background spawn pad
		messenger.messageRoomBySig(this.roomSig, "lobbyRespawn", { id: player.id, death: (type == "death"), invulnMs: c.lobbyRespawnInvulnMs });
	}
	// A jittered point inside the spawn pad (a background region, inherently safe).
	// Jitter keeps several simultaneous respawns from stacking on one spot.
	getLobbySpawnLoc() {
		var pad = (this.currentMap != null) ? this.currentMap.spawnPad : null;
		if (pad == null) {
			return { x: this.world.center.x, y: this.world.center.y };
		}
		var maxR = Math.max(0, pad.r - c.playerBaseRadius);
		var ang = Math.random() * Math.PI * 2;
		var dist = Math.random() * maxR;
		return { x: pad.cx + Math.cos(ang) * dist, y: pad.cy + Math.sin(ang) * dist };
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
	// Where the lava first appears for a collapse centered at loc: the cell
	// farthest from loc (the collapse turns the farthest cells to lava first,
	// then closes inward toward loc). Used to telegraph the eruption origin.
	getCollapseOrigin(loc) {
		var cells = this.currentMap.cells;
		var best = loc, bestD = -1;
		if (cells != null) {
			for (var i = 0; i < cells.length; i++) {
				if (cells[i].id == c.tileMap.goal.id) { continue; }
				var d = utils.getMag(loc.x - cells[i].site.x, loc.y - cells[i].site.y);
				if (d > bestD) { bestD = d; best = { x: cells[i].site.x, y: cells[i].site.y }; }
			}
		}
		return best;
	}
	// Seconds for a competent line to reach the nearest goal from the start gate
	// (graph par-time at the realistic player speed) so a volcano round erupts
	// "around par" -- scaled to the map, not a flat random delay. Samples a few
	// points down the gate and uses the shortest reachable line; falls back to a
	// random 8-15s if no goal is reachable.
	computeVolcanoEruptionDelay() {
		var vcfg = c.brutalRounds.volcano;
		// Use the map's stored canonical par (computed at submission/boot); only
		// compute live if this map somehow lacks it.
		var bestPar = this.currentMap.parTime;
		if (bestPar == null || bestPar <= 0) {
			bestPar = cellGraph.computeMapParTime(this.currentMap);
		}
		if (!(bestPar > 0)) {
			return utils.getRandomInt(8, 15);
		}
		var delay = bestPar * vcfg.parFactor + vcfg.eruptionParBonus;
		if (delay < vcfg.minEruptionDelay) { delay = vcfg.minEruptionDelay; }
		if (delay > vcfg.maxEruptionDelay) { delay = vcfg.maxEruptionDelay; }
		return delay;
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

			//Solo player: map-aware collapse speed tuned to spawn->goal distance
			if (this.soloMode) {
				collapseSpeed = this.soloCollapseSpeed;
			}

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

		// Audience near-burn gasp: the crowd reacts when an alive racer is right
		// at the edge of the advancing lava (a small positive margin) but hasn't
		// been swallowed yet — the "you barely made it" moment. Throttled per room.
		// Stamp each live racer's distance to the advancing lava front. Used for
		// the clutch-goal cheer (did they beat the lava to the goal?) and the
		// near-burn gasp (skating the edge); the gasp is throttled per room.
		var now = Date.now();
		var nearBurnReady = now > this.nextNearBurnTime;
		for (var pid in this.playerList) {
			var racer = this.playerList[pid];
			if (!racer.alive || racer.isZombie || racer.reachedGoal) {
				continue;
			}
			var racerDist = utils.getMag(this.collapseLoc.x - racer.x, this.collapseLoc.y - racer.y);
			var margin = this.collapseLine - racerDist;
			racer.collapseMargin = margin;
			if (nearBurnReady && margin > 0 && margin < c.audienceNearBurnMargin) {
				messenger.messageRoomBySig(this.roomSig, "audienceNearBurn");
				this.nextNearBurnTime = now + c.audienceNearBurnCooldown;
				nearBurnReady = false;
			}
		}

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
		var cells = this.currentMap.cells;
		if (cells == null) {
			return null;
		}
		var goalTiles = [];
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id) {
				goalTiles.push({ x: cells[i].site.x, y: cells[i].site.y });
			}
		}
		// No goal tile (or a torn-down room): return null so callers skip the
		// collapse instead of dereferencing undefined and crashing the engine.
		if (goalTiles.length === 0) {
			return null;
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
		// Sync the engine's integration position too. The engine advances newX/newY
		// and then move() copies them back to x/y, so a player whose newX/newY were
		// never set (a freshly spawned bot still at the constructor's 0,0) would snap
		// to that stale point on the first tick instead of staying at the gate.
		player.newX = loc.x;
		player.newY = loc.y;
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
		this.soloMode = false;
		this.soloCollapseSpeed = c.lastPlayerCollapseSpeed;
		this.soloStartDistance = this.world.height + 400;
		this.tileChanges = {};
		this.pendingAbilityTimers = []; // bound growth; lobby ones are canceled in clearLobbyAbilities
		// AI vision-fairness state, reset each round.
		this.visionBlockedUntil = 0;
		this.blackoutActive = false;
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
		if (this.isPreview && this.previewMap != null) {
			// Re-select the injected preview map every round (incl. round 2 via
			// startOverview), never the random library — mirrors TESTSingleMap.
			this.nextMap = JSON.parse(JSON.stringify(this.previewMap));
			return this.nextMap.id;
		}
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
		this.mapsPlayed.push(this.currentMap.id);
		console.log("Round: " + this.round);
		this.brutalConfig = this.checkForBrutalRound();
		var randomGen = this.generateRandomTiles();
		this.generateHazards();
		this.newMapPayload = { id: this.currentMap.id, abilities: this.generateAbilities(), round: this.round, randomTiles: randomGen, brutalRoundConfig: this.brutalConfig, hazards: compressor.newHazards(this.hazardList), currentState: currentState };
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
			if (loc == null) {
				return;
			}
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
	applyBrutalBlackoutRound(packet) {
		var context = packet.context;
		// Blackout lasts the rest of the round; bots self-handicap their steering
		// for fairness (a human can only see a small circle around themselves).
		context.gameBoard.blackoutActive = true;
		messenger.messageRoomBySig(context.roomSig, "applyBlackout", context.roomSig);
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
		if (debug.forceBlackout) {
			this.brutalRound = true;
			return { brutal: true, brutalTypes: [c.brutalRounds.blackout.id] };
		}
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
		this.resetHazards();
		if (this.currentMap.hazards == null) {
			return;
		}
		for (var i = 0; i < this.currentMap.hazards.length; i++) {
			if (this.currentMap.hazards[i].id == c.hazards.bumper.id) {
				var mapID = utils.generateHash(this.roomSig, String(this.currentMap.hazards[i].x + this.currentMap.hazards[i].y));
				var hazard = new Bumper(this.currentMap.hazards[i].x, this.currentMap.hazards[i].y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, this.roomSig);
				this.hazardList[mapID] = hazard;
			}
			if (this.currentMap.hazards[i].id == c.hazards.movingBumper.id) {
				var mapID = utils.generateHash(this.roomSig, String(this.currentMap.hazards[i].x + this.currentMap.hazards[i].y));
				var rail = new HazardRail(this.currentMap.hazards[i].x, this.currentMap.hazards[i].y, c.hazards.movingBumper.width, c.hazards.movingBumper.height, this.currentMap.hazards[i].angle, c.hazards.bumper.color, mapID, this.roomSig);
				var bumper = new Bumper(this.currentMap.hazards[i].x, this.currentMap.hazards[i].y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, this.roomSig, rail);
				if (this.checkForActiveBrutal(c.brutalRounds.lightning.id)) {
					bumper.speed *= c.brutalRounds.lightning.movingHazardSpeedMod;
				}
				this.hazardList[mapID] = bumper;
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

