'use strict';
var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');
var hostess = require('./hostess.js');
var maintenance = require('./maintenance.js');
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
var progression = require('./progression.js');
var skinRegistry = require('./skinRegistry.js');
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
		// Teams (teams game modes only): the shared POINTS score per team id and the
		// winning team (read by awardProgression/startGameover). Points flow from
		// race placement and combat (see creditTeamPoints / c.teams.points): first/
		// second/other finishes earn, enemy kills earn, ANY member death costs. The
		// match ends mid-round on the CLINCH — a team holding the target whose
		// member takes first place (checkForWinners) — with a round-cap leader
		// backstop (checkTeamPointsWin). null/none in FFA modes.
		this.teamPoints = null;
		this.winningTeamId = null;
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
			this.checkBonusOrbPickups(); // team-modes bonus orbs (credits before the flush)
			this.flushTeamBroadcast(); // coalesced teamUpdate (score changes this tick)
			//Mood changes are deferred to startOverview — flipping the music the
			//instant someone gains/loses near-victory mid-race felt jarring. The
			//fallback still ticks here so a stuck track can't silence the room.
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
	// ---- Teams (teams game modes) ------------------------------------------------
	isTeamsMode() {
		return this.gameBoard.isTeamsMode();
	}
	teamDefs() {
		return (c.teams && Array.isArray(c.teams.defs)) ? c.teams.defs : [{ id: 0, name: "Crimson", color: "#DC143C" }, { id: 1, name: "Jade", color: "#00A86B" }];
	}
	// Team points tuning (c.teams.points) with safe defaults. All knobs in config.
	teamPointsCfg() {
		var p = (c.teams && c.teams.points) ? c.teams.points : {};
		return {
			firstPlace: (typeof p.firstPlace === "number") ? p.firstPlace : 5,
			secondPlace: (typeof p.secondPlace === "number") ? p.secondPlace : 3,
			finish: (typeof p.finish === "number") ? p.finish : 1,
			kill: (typeof p.kill === "number") ? p.kill : 2,
			death: (typeof p.death === "number") ? p.death : -1,
			target: (typeof p.target === "number") ? p.target : 30,
			maxRounds: (typeof p.maxRounds === "number") ? p.maxRounds : 10
		};
	}
	teamMemberCount(teamId) {
		var n = 0;
		for (var id in this.playerList) {
			if (this.playerList[id] != null && this.playerList[id].teamId === teamId) { n++; }
		}
		return n;
	}
	// Assign a team to every UNASSIGNED player: each goes to the currently-smaller
	// team (ties -> Crimson). Called at match start (everyone) and again whenever
	// someone arrives mid-match (late-join humans via determineGameState, topped-up
	// bots via startGated) — assigned players are never moved, so humans keep their
	// team for the whole match and only NEW arrivals rebalance the count.
	ensureTeamAssignments() {
		var defs = this.teamDefs();
		var a = defs[0].id, b = defs[1].id;
		var changed = false;
		for (var id in this.playerList) {
			var p = this.playerList[id];
			if (p == null || p.teamId != null) { continue; }
			p.teamId = (this.teamMemberCount(a) <= this.teamMemberCount(b)) ? a : b;
			changed = true;
		}
		return changed;
	}
	resetTeams() {
		for (var id in this.playerList) {
			if (this.playerList[id] != null) { this.playerList[id].teamId = null; }
		}
		this.teamPoints = null;
		this.winningTeamId = null;
		this._teamsDirty = false;
		for (var rid in this.playerList) {
			if (this.playerList[rid] != null) { this.playerList[rid].teamPointsEarned = 0; }
		}
	}
	// One-shot team sync: assignments + the shared score. Broadcast on every change
	// (assignment or score) and included in the gameState snapshot for late joiners.
	teamSnapshot() {
		// Gate on the pool, not just the mode: a teams room idling in the lobby has
		// no rosters/score yet, and a non-null-but-empty snapshot would latch the
		// client's teams UI on (it keys every team render off teamInfo != null).
		if (!this.isTeamsMode() || this.teamPoints == null) { return null; }
		var assignments = [];
		for (var id in this.playerList) {
			var p = this.playerList[id];
			if (p != null && p.teamId != null) { assignments.push([id, p.teamId]); }
		}
		// `target` doubles as match point: a team AT/OVER it wins on its next
		// first-place finish (the clinch in checkForWinners), and deaths can drop
		// it back under — so the same number drives the victory tails/sting.
		return {
			assignments: assignments,
			score: this.teamPoints,
			target: this.teamPointsCfg().target,
			defs: this.teamDefs()
		};
	}
	broadcastTeams() {
		var snap = this.teamSnapshot();
		if (snap != null) {
			messenger.messageRoomBySig(this.roomSig, "teamUpdate", snap);
		}
	}
	// Teams with at least one player still standing this round. Zombies, spectators
	// and finished players don't keep a team "standing" — this drives the bunker's
	// emerge trigger in team modes (door opens at ONE TEAM remaining, not one player).
	aliveTeamCount() {
		var seen = {};
		var n = 0;
		for (var id in this.playerList) {
			var p = this.playerList[id];
			// !awake matches FFA's accounting: checkForWinners counts asleep players
			// as concluded, so an AFK kart must not keep its team "standing" either.
			if (p == null || p.teamId == null || !p.alive || !p.awake || p.isSpectator || p.isZombie || p.reachedGoal) { continue; }
			if (!seen[p.teamId]) { seen[p.teamId] = true; n++; }
		}
		return n;
	}
	// Credit a finisher's notches to their team's shared pool, mirroring addNotch's
	// clamp-at-target semantics: the pool parks at the target and the NEXT first
	// finish from that team clinches the match (checkForWinners). While a team is
	// parked at the target every member reads nearVictory (brutal-roll boost + the
	// same "gun for the leader" HUD cue as FFA).
	initTeamPool() {
		this.teamPoints = {};
		// Dev/testing seam: TEAM_POINTS_START=<n> seeds every team's score at match
		// start (e.g. 55 vs the 60 target = round 1 opens at match point, lighting
		// the team-wide victory tails and making the first round decisive). Env-
		// gated like PERF_MONITOR / TOUCH_DEBUG — absent in prod, no config surface.
		var seed = parseInt(process.env.TEAM_POINTS_START, 10);
		if (isNaN(seed) || seed < 0) { seed = 0; }
		var defs = this.teamDefs();
		for (var d = 0; d < defs.length; d++) { this.teamPoints[defs[d].id] = seed; }
	}
	// Credit (or charge) team points THROUGH the player who caused it: finishes and
	// enemy kills earn, a member dying costs. The score floors at 0 — a bleeding
	// team can't dig a negative hole — and deliberately does NOT cap at the target:
	// the rule is "hold the target and take first place" (overshoot like 62/60 is
	// real, and deaths still drag it back down). Every change re-derives the team's
	// nearVictory (at/over the target = match point) and broadcasts a per-player
	// delta (teamPointsDelta) for the floating +5/+2/-1; the full teamUpdate
	// snapshot is coalesced per tick (flushTeamBroadcast).
	creditTeamPoints(player, amount, reason) {
		if (!this.isTeamsMode() || player == null || player.teamId == null || amount === 0) { return; }
		if (this.teamPoints == null) { this.initTeamPool(); }
		var team = player.teamId;
		var next = (this.teamPoints[team] || 0) + amount;
		if (next < 0) { next = 0; }
		this.teamPoints[team] = next;
		// ALWAYS re-derive the team's nearVictory from the score it mirrors (cheap:
		// one small loop per credit). Deriving unconditionally — rather than only on
		// a match-point flip — also scrubs the stale personal flag addNotch sets
		// when a player parks at the personal notch cap, which would otherwise
		// wrongly boost brutal rolls and the music mood all match in teams play.
		var matchPoint = next >= this.teamPointsCfg().target;
		for (var id in this.playerList) {
			var p = this.playerList[id];
			if (p != null && p.teamId === team) { p.nearVictory = matchPoint; }
		}
		// Per-player NET contribution this match (placement + kills - deaths):
		// the teams runner-up derivation reads this, since personal notches
		// saturate at the cap over a long teams match.
		player.teamPointsEarned = (player.teamPointsEarned || 0) + amount;
		// `reason` ('first'|'second'|'finish'|'kill'|'death') feeds the client's
		// round ledger — the teams overview itemizes where the round's points came from.
		// The per-event delta goes out immediately (the floating +N/-N popups need the
		// moment), but the full teamUpdate snapshot is COALESCED to one per tick
		// (flushTeamBroadcast) — a collapse killing half the grid in one tick would
		// otherwise rebuild + fan out N snapshots inside the heaviest tick of the round.
		messenger.messageRoomBySig(this.roomSig, "teamPointsDelta", {
			id: player.id, teamId: team, amount: amount, reason: reason || null
		});
		this._teamsDirty = true;
	}
	// One coalesced teamUpdate per tick at most (set by creditTeamPoints; called
	// from update() right after the racing-state checkForWinners pass).
	flushTeamBroadcast() {
		if (this._teamsDirty) {
			this._teamsDirty = false;
			this.broadcastTeams();
		}
	}
	// Team-modes only: each racing tick, the first live racer to drive over an
	// uncollected bonus orb banks +1 for their team. Orbs are static (placed by
	// gameBoard.generateBonusOrbs and shipped in the newMap payload), so this is a
	// cheap O(orbs x players) distance pass — at most 2 orbs against a handful of
	// karts. `collected` latches the orb for the rest of the round (one-time pickup);
	// a `bonusOrbCollected` event drives the client pop/SFX. Zombies, spectators,
	// finishers, and the dead can't collect (no team credit for the infected).
	checkBonusOrbPickups() {
		if (!this.isTeamsMode()) { return; }
		// checkForWinners (called just before this) can flip the room to overview/
		// gameOver on a clinch tick — the racing/collapsing guard at the call site was
		// evaluated BEFORE that flip. Re-check here so a racer already sitting on an orb
		// can't bank a post-match point into the final score/ledger.
		if (this.currentState != this.stateMap.racing && this.currentState != this.stateMap.collapsing) { return; }
		var orbs = this.gameBoard.bonusOrbs;
		if (orbs == null || orbs.length === 0) { return; }
		var cfg = c.bonusOrb;
		var orbRadius = (cfg != null && cfg.radius != null) ? cfg.radius : 22;
		var pts = (cfg != null && cfg.pointsValue != null) ? cfg.pointsValue : 1;
		for (var i = 0; i < orbs.length; i++) {
			var orb = orbs[i];
			if (orb.collected) { continue; }
			for (var id in this.playerList) {
				var p = this.playerList[id];
				// A sleeping/AFK kart is already treated as out of the round by
				// checkForWinners/aliveTeamCount — it must not bank a point by resting on an orb.
				if (p == null || !p.alive || !p.awake || p.isSpectator || p.isZombie || p.reachedGoal || p.teamId == null) {
					continue;
				}
				var dx = p.x - orb.x;
				var dy = p.y - orb.y;
				var reach = orbRadius + (p.radius || 0);
				if (dx * dx + dy * dy <= reach * reach) {
					orb.collected = true;
					this.creditTeamPoints(p, pts, 'bonus_orb');
					messenger.messageRoomBySig(this.roomSig, "bonusOrbCollected", {
						index: i, by: p.id, teamId: p.teamId
					});
					break;
				}
			}
		}
	}
	// Round-cap BACKSTOP only (called when every racer has concluded, before the
	// overview). The real win is the mid-round CLINCH in checkForWinners: a team
	// holding the target whose member takes first place wins on the spot. This
	// backstop just stops an endless match — once maxRounds have been played, the
	// leading team takes it (a dead heat plays on, sudden-death style).
	checkTeamPointsWin() {
		if (!this.isTeamsMode() || this.teamPoints == null) { return false; }
		var pts = this.teamPointsCfg();
		var defs = this.teamDefs();
		var a = defs[0].id, b = defs[1].id;
		var sa = this.teamPoints[a] || 0, sb = this.teamPoints[b] || 0;
		var atRoundCap = (pts.maxRounds > 0 && this.gameBoard.round >= pts.maxRounds);
		if (!atRoundCap) { return false; }
		if (sa === sb) { return false; }
		var winnerTeam = (sa > sb) ? a : b;
		// Stamp the winner BEFORE picking the anchor kart: gameOver prefers this
		// pre-set winningTeamId, so the backstop still crowns the right team even
		// when it has no remaining members (e.g. its only human disconnected).
		this.winningTeamId = winnerTeam;
		// Winner sig anchors the game-over screen/recap: this round's first finisher
		// when they're on the winning team, else any member, else ANY player at all
		// (the TEAM is the winner; the sig is just the recap anchor).
		var sig = null;
		if (this.firstPlaceSig != null && this.playerList[this.firstPlaceSig] != null
			&& this.playerList[this.firstPlaceSig].teamId === winnerTeam) {
			sig = this.firstPlaceSig;
		} else {
			for (var id in this.playerList) {
				if (this.playerList[id] != null && this.playerList[id].teamId === winnerTeam) { sig = id; break; }
			}
		}
		if (sig == null) {
			for (var anyId in this.playerList) {
				if (this.playerList[anyId] != null) { sig = anyId; break; }
			}
		}
		if (sig == null) { return false; } // empty room — nothing to end
		this.recordAllPendingFinishes();
		this.gameOver(sig);
		return true;
	}

	determineGameState(newPlayer) {
		// Teams: a player arriving after the match started (late-join human; bots go
		// through here too when fillGridWithBots tops up) joins the SMALLER team.
		// Lobby/waiting arrivals wait for the match-start assignment in startGated.
		if (this.isTeamsMode() && this.locked && newPlayer.teamId == null) {
			if (this.ensureTeamAssignments()) { this.broadcastTeams(); }
		}
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
		//Send map tile changes. During the GATED phase of a Heatwave round the
		//heatwave delta must NOT ride this snapshot: the joiner just armed the
		//zoom-out reveal from the newMap payload above, and the snapshot would
		//flip those tiles instantly (no reveal, and scorch marks out of sync
		//with the burn-in). The delta reaches them through the reveal instead;
		//once racing/collapsing, armHeatwave applies it immediately on arm, so
		//the full snapshot is correct (and idempotent) there. Filter on a COPY —
		//gatherTileChanges returns the live accumulator.
		var tileSnapshot = this.gameBoard.gatherTileChanges();
		var hwPayload = (this.gameBoard.newMapPayload != null) ? this.gameBoard.newMapPayload.heatwave : null;
		if (this.currentState == c.stateMap.gated && hwPayload != null && hwPayload.changes != null) {
			var filtered = {};
			for (var tv in tileSnapshot) {
				if (hwPayload.changes[tv] == null) { filtered[tv] = tileSnapshot[tv]; }
			}
			tileSnapshot = filtered;
		}
		client.emit("tileChanges", JSON.stringify(tileSnapshot));
		// Bunker round in progress: bunkerStart was a one-shot at setup, so a mid-round
		// joiner/reconnect never set bunkerFX and would miss the silo door + offscreen
		// bunker indicator. Replay it, flagged `sealed` so they see it already shut
		// (no sink animation or close hiss replay).
		if (this.gameBoard.goalBuried && this.gameBoard.bunkerLoc != null) {
			client.emit("bunkerStart", {
				x: this.gameBoard.bunkerLoc.x, y: this.gameBoard.bunkerLoc.y,
				radius: this.gameBoard.bunkerArenaRadius, lid: this.gameBoard.bunkerLidIds, sealed: true
			});
		}
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
		//Checked BEFORE the maintenance drain: previews never hold up a deploy
		//(countActiveRaces skips them), so a drain shouldn't freeze a creator's
		//solo test either.
		if (this.gameBoard.isPreview) {
			this.startGated();
			return;
		}
		//Maintenance drain: a restart is pending, so hold the room in the lobby —
		//no new race may start (one already underway elsewhere is left to finish).
		//Reset the start-button timer so the race doesn't fire the instant the
		//block lifts; players re-rally on the button instead. (startGated() has
		//its own backstop gate; this earlier check just keeps the button timer
		//from spinning pointlessly.)
		if (maintenance.isRaceBlocked()) {
			this.resetLobbyTimer();
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
		//Maintenance drain: the next race of the series doesn't start while a
		//server restart is pending. Null the timer (don't just early-return) so
		//wall-clock elapsed during the block is discarded and the room gets a
		//fresh full countdown when the block lifts — mirrors resetLobbyTimer()
		//in checkGatedStart.
		if (maintenance.isRaceBlocked()) {
			this.newRaceTimer = null;
			return;
		}
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

				// Survival-time stamp (used to rank Bunker non-winners by how long they
				// lasted). Set once, the tick they're first seen concluded.
				if (this.playerList[player].eliminatedAt == null) {
					this.playerList[player].eliminatedAt = Date.now();
					// Teams: ANY member death costs the team points (the once-per-round
					// latch is this eliminatedAt stamp — zombie re-deaths never re-charge).
					this.creditTeamPoints(this.playerList[player], this.teamPointsCfg().death, 'death');
				}

				if (this.playerList[player].murderedBy != null) {
					var killer = this.playerList[this.playerList[player].murderedBy];
					if (killer != null) {
						this.playerList[player].murderedBy = null;
						// Teams: killing a TEAMMATE (only possible via abilities — punches
						// already no-op) earns nothing: no kill stat, no fire/streak, no
						// first blood. The death still happened; only the reward is denied,
						// so a bomb "accident" can't be farmed. Zombies override teams.
						if (killer.teamId != null && killer.teamId === this.playerList[player].teamId
							&& !killer.isZombie && !this.playerList[player].isZombie) {
							// no credit
						} else {
							// Zombie Slayer: addKill() ignores zombie attackers (zombies don't
							// rack up the normal kill stat), so tally infected kills here where
							// both killer and victim are in hand.
							if (killer.isZombie) {
								killer.zombieKillCount += 1;
							}
							killer.addKill(this.playerList[player]);
							this.gameBoard.checkForFirstBlood();
							// Teams: an enemy kill earns the killer's team points — but only a
							// LIVING, non-zombie killer scores, mirroring addKill's own gate, so
							// a trade-kill can't bank team points the kill stat itself denies
							// (zombies play for the horde, not a team).
							if (!killer.isZombie && killer.alive) {
								this.creditTeamPoints(killer, this.teamPointsCfg().kill, 'kill');
							}
						}
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
				// Escaped the horde: a human reaching the goal during an infection round.
				if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.infection.id)) {
					this.playerList[player].recapWorthy = true;
				}
				if (this.gameBoard.brutalRound) {
					this.playerList[player].brutalist += 1;
				}
				// Firewalker: finished a Heatwave round without ever touching a
				// heatwave-converted (scorched) tile. Latched once per round — this
				// block re-runs every conclusion tick (survivalist/brutalist above
				// deliberately accumulate), but a clean finish is a 0/1 event.
				if (!this.playerList[player].firewalkerJudged) {
					this.playerList[player].firewalkerJudged = true;
					if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.heatwave.id) &&
						!this.playerList[player].touchedScorchedTile) {
						this.playerList[player].firewalkerCount += 1;
					}
				}
				if (this.firstPlaceSig == null) {
					// The clinch: FFA — the first finisher already parked at the personal
					// cap wins the match. Teams — a team HOLDING the points target whose
					// member takes first place wins on the spot (the score is checked
					// before this finish's +5, so you must arrive at the line already at
					// the target — and deaths can knock you back under it).
					var clinched = this.isTeamsMode()
						? (this.teamPoints != null && this.playerList[player].teamId != null
							&& (this.teamPoints[this.playerList[player].teamId] || 0) >= this.teamPointsCfg().target)
						: (this.playerList[player].notches == this.notchesToWin);
					if (clinched) {
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
					if (this.isTeamsMode() && !this.playerList[player].teamPointsCredited) {
						this.playerList[player].teamPointsCredited = true;
						this.creditTeamPoints(this.playerList[player], this.teamPointsCfg().firstPlace, 'first');
						// Personal addNotch may have flagged nearVictory at the PERSONAL
						// cap; creditTeamPoints just rewrote the whole team from the
						// points score, which is the only victory signal in teams.
					}
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
					if (this.isTeamsMode() && !this.playerList[player].teamPointsCredited) {
						this.playerList[player].teamPointsCredited = true;
						this.creditTeamPoints(this.playerList[player], this.teamPointsCfg().secondPlace, 'second');
					}
					continue;
				}
				// Teams: every OTHER finisher past the podium still banks the small
				// finish bonus — once (the per-round latch covers the every-tick rescan
				// of players whose reachedGoal stays true).
				if (this.isTeamsMode() && !this.playerList[player].teamPointsCredited) {
					this.playerList[player].teamPointsCredited = true;
					this.creditTeamPoints(this.playerList[player], this.teamPointsCfg().finish, 'finish');
				}
			}
		}
		this.alivePlayerCount = this.playerCount - playersConcluded;

		if (playersConcluded == this.playerCount) {
			this.gameBoard.killAFKPlayers();
			// Teams round-cap backstop ONLY (the real win is the mid-round clinch in
			// the first-place branch above): once maxRounds have been played the
			// leading team takes it, ties play on. Fires INSTEAD of the overview.
			if (this.checkTeamPointsWin()) {
				return;
			}
			this.startOverview();
			return;
		}

		// Bunker (battle royale) safety valve: if survivors stalemate on the ice
		// island past the cap (ring already frozen, goal still buried), void the round
		// — no winner, no notch — so a camped last-man-standing can't hang the room.
		if (this.gameBoard.bunkerRingActive && this.gameBoard.bunkerStartTime != null) {
			if (Date.now() - this.gameBoard.bunkerStartTime > c.brutalRounds.bunker.maxRoundTime * 1000) {
				// Round ends here too, so the teams round-cap backstop must get its
				// look-in — otherwise a bunker void at/after maxRounds plays on.
				if (this.checkTeamPointsWin()) {
					return;
				}
				this.startOverview();
				return;
			}
		}

		//Start slow collapse once the round has a "last stand": the lone survivor in
		// FFA, or — in a teams mode — only ONE TEAM still standing (teammates aren't
		// rivals, so a surviving squad gets the same hurry-up pressure a lone
		// survivor does, in bunker AND normal rounds alike).
		var lastStand = this.isTeamsMode() ? (this.aliveTeamCount() <= 1) : (this.alivePlayerCount == 1);
		if (lastStand) {
			// Battle-royale endgame: the last player/team remains, so raise the buried
			// goal for them to claim — then engage the SAME map-aware par collapse a
			// normal last stand gets, so they can't just run laps to burn everyone's
			// time (grief). The collapse converges on the risen goal; an honest line
			// beats it with margin, a staller gets swallowed (round ends, no winner).
			if (this.gameBoard.checkForActiveBrutal(c.brutalRounds.bunker.id)) {
				if (this.gameBoard.goalBuried && !this.collapseInitated) {
					this.gameBoard.emergeBunker();
					this.collapseInitated = true;
					if (!this.scheduleSoloCollapse()) {
						setTimeout(function (context) {
							if (context.currentState == c.stateMap.racing || context.currentState == c.stateMap.collapsing) {
								var goal = context.gameBoard.findRandomGoalTile();
								if (goal != null) { context.startCollapse(goal.x, goal.y); }
							}
						}, 15000, this);
					}
				}
			} else if (this.currentState != c.stateMap.collapsing && !this.collapseInitated) {
				this.collapseInitated = true;
				// The map-tuned par collapse (a competent line can win) covers a true
				// single-player room AND a last-team-standing in teams mode; the
				// remaining multi-rival FFA case keeps the legacy map-blind
				// 15s/random-goal collapse (also the fallback when no par is known).
				if ((this.playerCount == 1 || this.isTeamsMode()) && this.scheduleSoloCollapse()) {
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
				// Teams + Auto fill: an odd grid leaves one side a kart short every
				// round, so round the auto target up to even (capacity permitting).
				// An explicit lobby override is respected as-is.
				if (this.isTeamsMode() && this.botTarget % 2 === 1 && this.botTarget < (c.maxPlayersInRoom || 25)) {
					this.botTarget += 1;
				}
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
		// New match forming: clear last match's "raced" flags so only players who actually race
		// THIS match earn progression (a late-join spectator is never gated into a race).
		for (var rcid in this.playerList) { if (this.playerList[rcid]) { this.playerList[rcid].racedCurrentMap = false; } }
		// Deliver any celebration toasts earned last match to players who STAYED in the
		// room (they never re-enter via enterGame, so loadPlayerProgression's drain never
		// runs for them). Lobby arrival is the promised moment for these.
		messenger.deliverRoomToasts(this.playerList);
	}
	startGated() {
		//Structural maintenance gate at the single choke point every race start
		//flows through, so a future caller can't bypass the drain. Callers are
		//tick-driven check* functions that re-arm and retry, so a silent no-op
		//just holds the room until the block lifts. Previews are exempt: they
		//never delay a deploy and the restart cuts them regardless.
		if (!this.gameBoard.isPreview && maintenance.isRaceBlocked()) {
			return;
		}
		console.log("Start Gated");
		this.locked = true;
		var matchStarting = (this.currentState == this.stateMap.lobby);
		// Leaving the lobby tutorial (this is the lobby->race transition; later rounds
		// arrive here from overview): drop any ability picked up in the lobby so it
		// can't be carried into the first real round. reset() only clears ability at
		// gameOver, so abilities legitimately persist between rounds — hence the guard.
		if (matchStarting) {
			this.gameBoard.clearLobbyAbilities();
			// Teams: a fresh match rebuilds the rosters from scratch (the mode may
			// have just changed at the hub, and last match's split shouldn't stick).
			// Assignment itself happens below, after the bot grid fills.
			this.resetTeams();
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
		// Teams: with the full grid (humans + bots) known, hand every unassigned
		// player to the smaller team and announce the rosters + pool. Later rounds
		// only ever ADD arrivals (top-up bots above, late-join humans via
		// determineGameState) — assigned players never move.
		if (this.isTeamsMode()) {
			if (matchStarting || this.teamPoints == null) { this.initTeamPool(); }
			this.ensureTeamAssignments();
		}
		// EVERY round start broadcasts the authoritative teams state: the snapshot
		// in team modes, null in FFA. The null is the clients' CLEAR — they latch
		// teamInfo from the last snapshot they saw, so a room that played a teams
		// match and switched modes would otherwise render the whole FFA match
		// through stale team UI (score pill, team overview panels, underglows).
		messenger.messageRoomBySig(this.roomSig, "teamUpdate", this.teamSnapshot());
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
				// Mark everyone in the gate as a racer of this round's map. Late-join
				// spectators join AFTER this loop, so they never get the flag — the
				// rateMap handler uses it to reject ratings from non-participants.
				this.playerList[rid].racedCurrentMap = true;
				// Clear the momentum ramp at the gun: the engine keeps ticking through
				// the gated countdown, so a player holding a direction would otherwise
				// build to full momentum behind the gate and skip the slow start. Reset
				// so everyone launches from the floor and has to wind up on the track.
				this.playerList[rid].momentum = 0;
				this.playerList[rid].lastMoveDirX = 0;
				this.playerList[rid].lastMoveDirY = 0;
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
		// Heatwave second wave: another (smaller) scorch pulse mid-race, paced to
		// the map like the volcano — around half of par, so front-runners are deep
		// in the course when the ground shifts. Warn fires first (tile telegraph);
		// the flip itself is scheduled from the warn handler after selection.
		var hwCfg = c.brutalRounds.heatwave;
		if (this.gameBoard.checkForActiveBrutal(hwCfg.id) && hwCfg.secondWave && hwCfg.secondWave.active) {
			var bestPar = this.gameBoard.currentMap.parTime;
			var waveDelay = (bestPar > 0) ? bestPar * hwCfg.secondWave.parFactor : utils.getRandomInt(hwCfg.secondWave.minDelay, hwCfg.secondWave.maxDelay);
			if (waveDelay < hwCfg.secondWave.minDelay) { waveDelay = hwCfg.secondWave.minDelay; }
			if (waveDelay > hwCfg.secondWave.maxDelay) { waveDelay = hwCfg.secondWave.maxDelay; }
			setTimeout(this.gameBoard.warnOfHeatwaveWave, waveDelay * 1000, { context: this, map: this.gameBoard.currentMap });
		}


		//Keep the current track playing across the load/overview screens — only pick
		//a new one for the first race or when the mood actually changes. The client
		//re-plays the same track as a no-op, so music continues uninterrupted.
		var mood = this.computeMusicMood();
		if (this.currentMusic == null || this.currentMusic.mood != mood) {
			this.setRoomMusic(mood, this.pickMusicTrack(mood, (this.lastTrackByMood || {})[mood]));
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
		// currentMap is still the JUST-PLAYED map here (determineNextMap only stashes
		// nextMap; loadNextMap advances currentMap later at the gate). Pass it so the
		// overview's rating widget rates the map you just played, not the upcoming one.
		var justPlayed = this.gameBoard.currentMap;
		messenger.messageRoomBySig(this.roomSig, 'startOverview', {
			notchUpdates: compressor.sendNotchUpdates(this.playerList),
			nextMapID: nextMapID,
			mapId: (justPlayed != null) ? justPlayed.id : null,
			mapName: (justPlayed != null) ? justPlayed.name : null
		});
		//Round is settled — NOW reconcile the music mood (near-victory gained or
		//lost this round). Doing it here instead of mid-race means the hype track
		//carries the racer over the line and the change washes in on this screen.
		this.updateMusicMood();
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
		// Teams reassign fresh at the next match start (the MODE persists; rosters don't).
		this.resetTeams();
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
	// End-of-match XP / medal / win awards. Server-authoritative: computes a
	// per-player breakdown (only for signed-in humans — bots + guests earn
	// nothing), updates the in-memory progression cache so a same-lobby re-equip is
	// gated on the freshly-earned level/unlocks, fires the (writes-gated) Supabase
	// persist, and returns the breakdowns for the startGameover packet. With writes
	// disabled (local dev) XP is still computed + emitted so the gameOver UI works;
	// nothing is persisted.
	awardProgression(achievements, winnerSig) {
		var xpEarned = {};
		// The match winner is the player passed to gameOver(). The match-ending tick
		// calls gameOver() and returns BEFORE firstPlaceSig/secondPlaceSig are assigned
		// for that final race, so those round-placement fields are null here — relying
		// on them would deny the winner their win bonus and never increment `wins`.
		var winnerId = (winnerSig != null) ? String(winnerSig) : null;
		// Teams: the whole winning team wins — every member gets the win bonus and
		// the win counter, not just the clincher (winningTeamId is stamped by
		// gameOver before this runs).
		var winningTeamId = this.isTeamsMode() ? this.winningTeamId : null;
		// Runner-up = the best non-winner. FFA ranks by notches (the durable match
		// score; secondPlaceSig is null on the match-ending tick). Teams rank the
		// LOSING side by NET team-points contribution (teamPointsEarned) — personal
		// notches saturate at the cap over a long teams match, which would reduce
		// the pick to playerList iteration order. Ties: first found.
		var runnerUpId = null;
		var bestScore = -Infinity;
		for (var rid in this.playerList) {
			if (rid === winnerId) { continue; }
			var rp = this.playerList[rid];
			if (rp == null) { continue; }
			if (winningTeamId != null && rp.teamId === winningTeamId) { continue; }
			var rn = (winningTeamId != null) ? (rp.teamPointsEarned || 0) : (rp.notches || 0);
			if (rn > bestScore) { bestScore = rn; runnerUpId = rid; }
		}

		// Per-player medal deltas: each medal a player holds this match counts +1
		// toward that lifetime medal counter.
		var medalDeltas = {};
		// Only persist medals a cosmetic actually gates on (skip resourceful/bully/double/
		// triple/megaKill etc.) so medal_counts stays a lean ledger of unlock-relevant stats.
		var TRACKED_MEDALS = new Set(progression.ACHIEVEMENT_UNLOCKS.map(function (u) { return u.stat; }));
		for (var medalName in achievements) {
			if (!TRACKED_MEDALS.has(medalName)) { continue; }
			var medalIds = achievements[medalName].ids || [];
			for (var m = 0; m < medalIds.length; m++) {
				var mid = medalIds[m];
				if (!medalDeltas[mid]) { medalDeltas[mid] = {}; }
				medalDeltas[mid][medalName] = (medalDeltas[mid][medalName] || 0) + 1;
			}
		}

		// Competitive progression (wins, winStreak, and the best-in-match medals folded above)
		// needs a real opponent: 2+ HUMANS present at gameOver. Guests count — only bots are
		// excluded. Solo / you-and-bots still earns XP/levels + the participation self-medals.
		var humanCount = 0;
		for (var hid in this.playerList) { if (this.playerList[hid] && !this.playerList[hid].isAI && this.playerList[hid].racedCurrentMap) { humanCount++; } }
		var enoughHumans = (humanCount >= 2);

		for (var id in this.playerList) {
			var p = this.playerList[id];
			if (p == null || p.isAI || !p.verifiedUserId || !p.racedCurrentMap) {
				continue; // bots + guests + late-join spectators (never raced) earn no progression
			}
			var isWinner = (winningTeamId != null) ? (p.teamId === winningTeamId) : (id === winnerId);
			var countsAsWin = isWinner && enoughHumans; // a "win" requires real competition
			var isRunnerUp = (id === runnerUpId);
			var breakdown = {
				participation: c.xpParticipate,
				notches: c.xpPerNotch * (p.notches || 0),
				winBonus: isWinner ? c.xpWinBonus : 0,
				runnerUp: isRunnerUp ? c.xpRunnerUpBonus : 0
			};
			breakdown.total = breakdown.participation + breakdown.notches + breakdown.winBonus + breakdown.runnerUp;
			xpEarned[id] = breakdown;

			var deltas = medalDeltas[id] || {};
			// Self-counter medals (not best-in-match): fold this player's own per-match tallies
			// into their lifetime medal_counts so the new achievement cosmetics are earnable.
			deltas.gamesPlayed = (deltas.gamesPlayed || 0) + 1;
			// recapAppearances = the winner (always the recap headline) OR anyone who had a
			// server-detected highlight this match (clutch/burning finish, multi-kill/streak,
			// pinball death, horde escape) — p.recapWorthy is stamped at those moments.
			if (p.recapWorthy || isWinner) { deltas.recapAppearances = (deltas.recapAppearances || 0) + 1; }
			if (p.goalsReachedMatch) { deltas.goalsReached = (deltas.goalsReached || 0) + p.goalsReachedMatch; }
			if (p.cart || p.pattern || p.trailFx || p.border) { deltas.cosmeticGames = (deltas.cosmeticGames || 0) + 1; }
			if (p.joinedInProgress) { deltas.joinInProgress = (deltas.joinInProgress || 0) + 1; p.joinedInProgress = false; }
			if (p.abilitiesUsedMatch) { deltas.abilitiesUsed = (deltas.abilitiesUsed || 0) + p.abilitiesUsedMatch; }

			// Update the in-memory cache (so a same-lobby re-equip is gated on the
			// freshly-earned level/unlocks) and build this match's celebration toasts.
			// Toasts are SHOWN on the player's next lobby arrival (not the busy game-over
			// screen). With writes ON, addProgression persists xp/level/unlocks AND the
			// toast queue to the DB authoritatively. With writes OFF (local dev), we keep
			// the cache + queue toasts in memory so the UI is still testable.
			var events = [{ type: 'xp', amount: breakdown.total }];
			if (p.progressionLoaded && p.progression) {
				var prog = p.progression;
				var newXp = (prog.xp || 0) + breakdown.total;
				var oldLevel = prog.level || 1;
				var newLevel = progression.levelForXp(newXp);
				var newWins = (prog.wins || 0) + (countsAsWin ? 1 : 0);
				var newMedalCounts = progression.mergeMedalCounts(prog.medal_counts, deltas);
				progression.applyWinStreak(newMedalCounts, countsAsWin);
				var earned = progression.achievementsUnlocked(newMedalCounts, newWins);
				var had = prog.unlocked_skins || [];
				var fresh = [];
				for (var e = 0; e < earned.length; e++) {
					if (had.indexOf(earned[e]) === -1) { fresh.push(earned[e]); }
				}
				events = progression.buildToastEvents({
					xpDelta: breakdown.total,
					oldXp: prog.xp || 0,
					oldLevel: oldLevel,
					newLevel: newLevel,
					levelSkinsUnlocked: skinRegistry.levelSkinsUnlockedBetween,
					freshAchievementSkins: fresh
				});
				p.progression = {
					xp: newXp,
					level: newLevel,
					unlocked_skins: had.concat(fresh),
					medal_counts: newMedalCounts,
					wins: newWins
				};
			}

			if (auth.writesEnabled) {
				// DB path: addProgression recomputes + persists (incl. pending_toasts)
				// authoritatively from the stored row; don't also queue in memory.
				this.persistProgression(p.verifiedUserId, id, breakdown.total, deltas, countsAsWin);
			} else {
				messenger.enqueueToastsInMemory(p.verifiedUserId, events);
			}
		}
		// xpEarned kept for any caller/telemetry; the packet no longer carries it.
		return { xpEarned: xpEarned };
	}
	// Fire-and-forget persist for one player. A method (not an inline closure) so the
	// per-call params are captured correctly across the async boundary — a `var` loop
	// body would leak the last iteration's values into every .then. On success the
	// authoritative row is pushed back to just that client.
	persistProgression(userId, sig, xpDelta, medalDeltas, win) {
		auth.addProgression(userId, { xpDelta: xpDelta, medalDeltas: medalDeltas, win: win })
			.then(function (row) {
				if (row) { messenger.sendProgressionToClient(sig, row); }
			})
			.catch(function (err) { console.log('[progression] persist failed:', err && err.message); });
	}
	gameOver(player) {
		console.log("Game Over");
		this.currentState = this.stateMap.gameOver;
		// Teams: the clincher's whole team wins. Stamped BEFORE awardProgression so
		// the win bonus / win counter reach every member, and carried on the payload
		// so the game-over screen celebrates Crimson/Jade rather than one kart.
		var winningTeam = null;
		if (this.isTeamsMode()) {
			// checkTeamPointsWin pre-stamps winningTeamId (its anchor kart may not be
			// on the winning team when that team emptied out); the clinch path derives
			// it from the clincher.
			if (this.winningTeamId == null && this.playerList[player] != null && this.playerList[player].teamId != null) {
				this.winningTeamId = this.playerList[player].teamId;
			}
		}
		if (this.isTeamsMode() && this.winningTeamId != null) {
			var defs = this.teamDefs();
			var def = null;
			for (var d = 0; d < defs.length; d++) { if (defs[d].id === this.winningTeamId) { def = defs[d]; break; } }
			var members = [];
			for (var mid in this.playerList) {
				if (this.playerList[mid] != null && this.playerList[mid].teamId === this.winningTeamId) { members.push(mid); }
			}
			winningTeam = { id: this.winningTeamId, name: def ? def.name : "Team", color: def ? def.color : "#fff", members: members };
		}
		var achievements = this.gatherAchievements();
		// Award XP/medals/unlocks and queue this match's celebration toasts (shown on next
		// lobby arrival), then carry the just-played map's id/name so the game-over screen
		// can offer a star rating (rateMap uses the room's current map, not this id).
		this.awardProgression(achievements, player);
		var ratedMap = (this.gameBoard && this.gameBoard.currentMap) ? this.gameBoard.currentMap : null;
		messenger.messageRoomBySig(this.roomSig, 'startGameover', {
			winner: player,
			team: winningTeam,
			achievements: achievements,
			mapId: ratedMap ? ratedMap.id : null,
			mapName: ratedMap ? ratedMap.name : null
		});
		// The match-ending finish skips startOverview, but the player still
		// crossed a goal — record their PB so a record-setting run on the final
		// round isn't lost. The emitted mapLeaderboard message arrives during
		// gameOver state where the card doesn't render; the PB is what matters
		// here, and the next round's overview will reflect it.
		this.publishMapLeaderboard();
	}
}
Object.assign(Game.prototype, require('./music.js'), require('./achievements.js'));

