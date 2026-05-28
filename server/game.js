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
var { GameBoard } = require('./entities/gameBoard.js');
var auth = require('./auth.js');
var leaderboard = require('./leaderboard.js');

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
		// Flush an unsaved personal-best BEFORE removing the player — a logged-in
		// racer who crossed the goal and then disconnected before the round-end
		// publish would otherwise lose their time entirely (their player object
		// vanishes from playerList here, so the next checkForWinners snapshot
		// never sees them).
		this.game.flushPendingFinishForPlayer(this.playerList[clientID]);
		messenger.messageRoomBySig(this.sig, 'playerLeft', clientID);
		messenger.removeRoomMailBox(clientID);
		var client = messenger.getClient(clientID);
		client.leave(String(this.sig));
		delete this.clientList[clientID];
		delete this.playerList[clientID];
		// Remove anything this player owned (aimer/ability/projectile/temp-spectator
		// entry) so the per-tick loops and compressor don't keep iterating and
		// emitting orphans whose ownerId now points at a player that's gone.
		this.game.gameBoard.removeOwnedEntities(clientID);
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
		// Set when the gate opens (startRace) so the round-end leaderboard hook can
		// compute each finisher's elapsed time as Player.timeReached - raceStartedAt.
		// Reset on each new race; null between rounds.
		this.raceStartedAt = null;
		// In-flight per-finish PB upsert promises. publishMapLeaderboard awaits
		// these before issuing the just-played rank query so a still-pending
		// upsert (especially the last finisher's, which awaits getDisplayName
		// first) can't be missed from the overview rows.
		this.pendingPbWrites = [];
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
		// Late-join spectator: send the LIVE hazard list (the puck, mid-round volcano
		// debris, lightning hazards, etc.). newMap only carries the map's round-start
		// hazards, and updateHazardList on the client only updates EXISTING entries
		// — without this, a mid-race joiner is blind to anything spawned after
		// the round began. Mirrors the lobby branch above.
		client.emit("applyHazards", compressor.newHazards(this.gameBoard.hazardList));
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
			// A temp spectator (late joiner waiting for the next round) is alive=false
			// but isn't IN this round — they must not be infected, exploded, or
			// credited as a kill, all of which the !alive branch below would do. They
			// just count as already-concluded so the round can end normally.
			if (this.playerList[player].isSpectator) {
				playersConcluded++;
				continue;
			}
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
				// Per-finish PB upsert (idempotent via the pbWritten flag, so
				// firing every tick while reachedGoal stays true is harmless).
				this.recordPlayerFinish(this.playerList[player]);
				this.playerList[player].survivalist += 1;
				if (this.gameBoard.brutalRound) {
					this.playerList[player].brutalist += 1;
				}
				if (this.firstPlaceSig == null) {
					if (this.playerList[player].notches == this.notchesToWin) {
						//Game over player wins
						// Sweep up any OTHER racers who reached the goal on this
						// same tick — gameOver's early-return below skips the rest
						// of the iteration, and publishMapLeaderboard then clears
						// raceStartedAt. Without this sweep, simultaneous finishers
						// after the winner in playerList iteration order would never
						// get recordPlayerFinish called and their PBs would be lost.
						this.recordAllPendingFinishes();
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
			// Auto (no override): pick a target TOTAL once at match start using a
			// triangular-tier scale (humans -> small bot fill; full lobby -> fills
			// the room). Held across rounds within a match so a mid-match human
			// join can't despawn a bot — desiredBots only ever tops up below.
			if (this.botTarget == null) {
				var capLeft = (c.maxPlayersInRoom || 25) - humanCount;
				if (capLeft < 0) { capLeft = 0; }
				this.botTarget = humanCount + utils.autoBotsForHumans(humanCount, capLeft);
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
	// Bots yield to humans: keep humans + bots within the room cap by despawning
	// surplus bots. fillGridWithBots clamps bots at spawn, and the match lock blocks
	// mid-race human joins today — but the cap must not depend on that timing (the
	// determineGameState `racing` branch shows mid-race joins are a contemplated path).
	// Called whenever a human joins; a no-op in normal flow (no bots while joinable),
	// and a human is never refused a slot a bot is holding.
	trimBotsToCapacity() {
		// Late-join changed who calls this: a public join can now land in a locked
		// room mid-race, and despawning a bot then would blink a kart out of the
		// active race for every viewer. fillGridWithBots already promises bots are
		// "held across rounds within a match" — keep the same promise on the join
		// side. Cap may transiently exceed by a few seats inside one match; the
		// next match's resetGame -> removeBots re-rolls the grid cleanly.
		if (this.locked) {
			return;
		}
		var cap = c.maxPlayersInRoom || 25;
		var humanCount = 0, botIds = [];
		for (var id in this.playerList) {
			if (this.playerList[id].isAI) { botIds.push(id); } else { humanCount++; }
		}
		var allowedBots = cap - humanCount;
		if (allowedBots < 0) { allowedBots = 0; }
		for (var i = allowedBots; i < botIds.length; i++) {
			messenger.messageRoomBySig(this.roomSig, "playerLeft", botIds[i]);
			delete this.playerList[botIds[i]];
		}
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
		this.raceStartedAt = Date.now();
		// Stamp the per-race start on every player so handleMapCellHit can
		// compute the finishMs delta locally without reaching back through
		// hostess->room->game (avoids a circular require from entities/).
		for (var rid in this.playerList) {
			if (this.playerList[rid] != null) {
				this.playerList[rid].raceStartedAt = this.raceStartedAt;
			}
		}

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

		messenger.messageRoomBySig(this.roomSig, "startRace", { music: this.currentMusic, raceStartedAt: this.raceStartedAt });
		this.publishCurrentMapLeaderboard();
	}

	// Async-fetch the current map's global top 10 and emit it to the room so
	// the client can render the spectator mini-leaderboard during the race
	// (and any racer who looks at the corner widget sees what they're chasing).
	// Fire-and-forget; skipped for preview rooms and rooms without a map.
	//
	// Staleness guard: a slow Supabase response can return after the room has
	// already advanced to a different map / state. Re-check the room is still
	// on the same map before emitting, so the spectator widget never gets the
	// previous race's leaderboard injected into the new race.
	publishCurrentMapLeaderboard() {
		if (this.gameBoard.isPreview) { return; }
		var currentMap = this.gameBoard.currentMap;
		if (currentMap == null || !currentMap.id) { return; }
		var mapId = currentMap.id;
		var mapName = currentMap.name || null;
		var roomSig = this.roomSig;
		var self = this;
		(async function () {
			var topRows = await leaderboard.getTopForMap(mapId, 10);
			if (!self.isStillOnMap(mapId)) { return; }
			messenger.messageRoomBySig(roomSig, 'mapLeaderboardCurrent', {
				mapId: mapId,
				mapName: mapName,
				rows: topRows
			});
		})().catch(function (e) {
			console.log('[leaderboard] current-map publish error:', e.message);
		});
	}

	// True if the room's currently-loaded map still matches the given mapId.
	// Used to gate every async leaderboard emit against the case where the
	// Supabase round-trip finished after the room advanced — without this,
	// a slow response would broadcast a previous-map payload into a new race
	// or a previous-round PB float into an unrelated overview.
	isStillOnMap(mapId) {
		var cm = this.gameBoard.currentMap;
		return cm != null && cm.id === mapId;
	}

	startOverview() {
		console.log("Start Overview");
		this.currentState = this.stateMap.overview;
		var nextMapID = this.gameBoard.determineNextMap();
		this.collapseInitated = false;
		messenger.messageRoomBySig(this.roomSig, 'startOverview', { notchUpdates: compressor.sendNotchUpdates(this.playerList), nextMapID: nextMapID });
		this.publishMapLeaderboard();
	}

	// Per-finish PB upsert. Called every tick from checkForWinners on any player
	// flagged reachedGoal — the pbWritten flag (set synchronously before any
	// await) makes it idempotent so each finish writes exactly once even though
	// the call site fires repeatedly. Runs the upsert + rank lookup + emits
	// `playerPbResult` so the client can show a NEW PERSONAL / WORLD RECORD
	// float over the kart that just finished. No-op for guests, bots, preview
	// rooms, races that never started, and already-written finishes.
	//
	// Also called from Room.leave for disconnect-during-race so a player who
	// finished and immediately quit still gets their PB saved.
	recordPlayerFinish(p) {
		if (p == null || p.isAI || !p.verifiedUserId) { return; }
		if (!p.reachedGoal || !p.timeReached || p.pbWritten) { return; }
		if (this.gameBoard.isPreview) { return; }
		if (this.raceStartedAt == null) { return; }
		var currentMap = this.gameBoard.currentMap;
		if (currentMap == null || !currentMap.id) { return; }
		var elapsed = p.timeReached - this.raceStartedAt;
		if (!(elapsed > 0 && elapsed < 86400000)) { return; }
		// Synchronous latch: subsequent ticks (or a disconnect-flush racing the
		// in-flight upsert) see pbWritten=true and bail.
		p.pbWritten = true;
		var userId = p.verifiedUserId;
		var playerId = p.id;
		var mapId = currentMap.id;
		var mapName = currentMap.name || null;
		var roomSig = this.roomSig;
		var self = this;
		// Track the promise so publishMapLeaderboard can wait for in-flight PB
		// writes to settle before issuing the round-end rank query — otherwise
		// the very last finisher's PB read can run before their own upsert
		// commits, omitting them from the overview rows.
		var p_promise = (async function () {
			try {
				var name = await auth.getDisplayName(userId);
				var upsert = await leaderboard.upsertBestTime(userId, mapId, elapsed, name);
				// Only telegraph PB-improving finishes; a slower finish never floats.
				if (!upsert.isNewRecord) { return; }
				// Staleness guard: if the room has moved on to a different map
				// before this async chain returns, the PB write is still valid
				// but the float/banner would fire on the WRONG race. Skip emit.
				if (!self.isStillOnMap(mapId)) { return; }
				// World-record check: rank <= 10 globally on this map after the upsert.
				var ranked = await leaderboard.getLeaderboardForPlayers(mapId, [userId]);
				if (!self.isStillOnMap(mapId)) { return; } // re-check after second await
				var myRank = (ranked[0] && ranked[0].rank) || null;
				messenger.messageRoomBySig(roomSig, 'playerPbResult', {
					playerId: playerId,
					isNewRecord: true,
					isWorldRecord: myRank != null && myRank <= 10,
					finishMs: Math.round(elapsed),
					rank: myRank,
					// Display name + map name carried in the payload so the world-
					// record screen-space banner doesn't have to round-trip through
					// playerList lookups (the kart that finished can leave the
					// scoreboard column before the banner finishes animating).
					displayName: name,
					mapName: mapName
				});
			} catch (e) {
				console.log('[leaderboard] recordPlayerFinish failed:', e.message);
			}
		})();
		this.pendingPbWrites.push(p_promise);
		// Self-prune on settle so the array doesn't grow unbounded across
		// many rounds. Using finally so both success and failure clean up.
		p_promise.finally(function () {
			var i = self.pendingPbWrites.indexOf(p_promise);
			if (i !== -1) { self.pendingPbWrites.splice(i, 1); }
		});
	}

	// Disconnect-during-race hook — same idempotent upsert path. Kept as a
	// separate name so the call site in Room.leave reads as intent.
	flushPendingFinishForPlayer(p) {
		this.recordPlayerFinish(p);
	}

	// Sweep every reached-goal player and call recordPlayerFinish on any whose
	// PB hasn't been written yet. Called just before gameOver() so the early
	// return on a match-ending finish doesn't skip simultaneous finishers
	// later in the playerList iteration order. The pbWritten flag makes this
	// idempotent — players the loop already visited this tick are no-ops.
	recordAllPendingFinishes() {
		for (var pid in this.playerList) {
			var p = this.playerList[pid];
			if (p != null && p.reachedGoal && !p.pbWritten) {
				this.recordPlayerFinish(p);
			}
		}
	}

	// Round-end leaderboard publish. PB upserts are NOT done here — they happen
	// per-finish in recordPlayerFinish. This is just two read queries + emits:
	//   * mapLeaderboardJustPlayed — one row per logged-in racer in this room
	//     with a PB on the just-played map. Drives the inline rank/time shown
	//     beside each notch row so the last finisher still glimpses their time.
	//   * mapLeaderboardNextMap — global top 10 for the upcoming map, plus the
	//     map's display name. Drives the "Times to beat for <name>" card under
	//     the next-map preview. Empty rows -> client renders "New map!".
	// Skipped for preview rooms, races that never started, and gameOver paths
	// where there's no follow-on round (next-map fetch would be wasted).
	publishMapLeaderboard() {
		if (this.gameBoard.isPreview) { return; }
		if (this.raceStartedAt == null) { return; }
		var justPlayedMap = this.gameBoard.currentMap;
		if (justPlayedMap == null || !justPlayedMap.id) { return; }
		// Reset so a follow-on overview (e.g. AFK timer) can't double-publish.
		this.raceStartedAt = null;

		var justPlayedId = justPlayedMap.id;
		var nextMap = this.gameBoard.nextMap;
		var nextMapId = (nextMap && nextMap.id) ? nextMap.id : null;
		var nextMapName = (nextMap && nextMap.name) ? nextMap.name : null;

		// Logged-in racers currently in the room — used for the inline notch-row
		// data on the just-played map. Bots and guests are filtered out.
		var loggedInIds = [];
		var userIdToPlayerId = {};
		for (var pid in this.playerList) {
			var p = this.playerList[pid];
			if (p == null || p.isAI || !p.verifiedUserId) { continue; }
			loggedInIds.push(p.verifiedUserId);
			userIdToPlayerId[p.verifiedUserId] = pid;
		}

		var roomSig = this.roomSig;
		var self = this;
		// Snapshot the in-flight PB write promises and clear the live array so
		// any writes that begin AFTER this snapshot (e.g. a stragglet flush)
		// don't leak into the next round's await.
		var inflightPbWrites = this.pendingPbWrites.slice();
		this.pendingPbWrites = [];
		(async function () {
			// Wait for every per-finish upsert kicked off this round to settle
			// before we read ranks. allSettled so one Supabase failure can't
			// stall the whole publish.
			if (inflightPbWrites.length > 0) {
				await Promise.allSettled(inflightPbWrites);
			}
			// Just-played: rows for logged-in racers in this room that have a PB
			// on the just-played map (the per-finish upserts ran already).
			if (loggedInIds.length > 0) {
				var ranked = await leaderboard.getLeaderboardForPlayers(justPlayedId, loggedInIds);
				// Staleness guard: if the next race has already loaded a different
				// map, this overview leaderboard would land on a screen where the
				// just-played map is no longer "just played." Skip the emit; the
				// PBs themselves were already saved per-finish.
				if (self.isStillOnMap(justPlayedId)) {
					var justRows = ranked.map(function (r) {
						return {
							userId: r.userId,
							playerId: userIdToPlayerId[r.userId] || null,
							displayName: r.displayName,
							bestMs: r.bestMs,
							rank: r.rank
						};
					});
					justRows.sort(function (a, b) { return a.rank - b.rank; });
					messenger.messageRoomBySig(roomSig, 'mapLeaderboardJustPlayed', {
						mapId: justPlayedId,
						rows: justRows
					});
				}
			}
			// Next map: global top 10 + name. Tag rows that belong to a current
			// racer with their socket id so the client can highlight them.
			if (nextMapId) {
				var topRows = await leaderboard.getTopForMap(nextMapId, 10);
				// Same staleness guard: skip if the room has moved past this
				// overview onto a different map. The next-map card the client
				// would otherwise render would be against the wrong context.
				if (self.isStillOnMap(justPlayedId)) {
					var rows = topRows.map(function (r) {
						return {
							userId: r.userId,
							playerId: userIdToPlayerId[r.userId] || null,
							displayName: r.displayName,
							bestMs: r.bestMs,
							rank: r.rank
						};
					});
					messenger.messageRoomBySig(roomSig, 'mapLeaderboardNextMap', {
						mapId: nextMapId,
						mapName: nextMapName,
						rows: rows
					});
				}
			}
		})().catch(function (e) {
			console.log('[leaderboard] publish error:', e.message);
		});
	}
	startCollapse(xloc, yloc) {
		console.log("Start Collapse");
		this.currentState = this.stateMap.collapsing;
		// A hockey puck is frictionless and never expires on its own, so once the
		// round is decided it would keep ricocheting around the arena — and each
		// wall bounce fires the bounce SFX — all the way through the collapse.
		// Retire it the instant the round ends so it can't spam its sound.
		for (var pid in this.gameBoard.projectileList) {
			if (this.gameBoard.projectileList[pid].isPuck) {
				delete this.gameBoard.projectileList[pid];
				messenger.messageRoomBySig(this.roomSig, "terminateProj", pid);
			}
		}
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
		// The match-ending finish skips startOverview, but the player still
		// crossed a goal — record their PB so a record-setting run on the final
		// round isn't lost. The emitted mapLeaderboard message arrives during
		// gameOver state where the card doesn't render; the PB is what matters
		// here, and the next round's overview will reflect it.
		this.publishMapLeaderboard();
	}
}
Object.assign(Game.prototype, require('./music.js'), require('./achievements.js'));

