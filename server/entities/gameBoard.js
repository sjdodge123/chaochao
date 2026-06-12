'use strict';
// GameBoard — per-room map/tile/ability/projectile board state and the bulk of
// per-tick board logic. Extracted from game.js (which keeps Room + Game). No
// back-reference to Room/Game; constructed by Room as `new GameBoard(...)`.
var utils = require('../utils.js');
var c = utils.loadConfig();
var messenger = require('../messenger.js');
var _engine = require('../engine.js');
var compressor = require('../compressor.js');
var debug = require('../debug.js');
var cellGraph = require('../cellGraph.js');
var aiController = require('../aiController.js');
var { Gate } = require('./shapes.js');
var { LobbyStartButton, LobbyStation } = require('./player.js');
var { ExplosionAimer, SwapAimer } = require('./aimers.js');
var { HazardRail, Bumper } = require('./hazards.js');
var { CloudProj, SnowFlakeProj, BombProj, Puck } = require('./projectiles.js');
var { Blindfold, Swap, IceCannon, Bomb, SpeedBuff, SpeedDebuff, TileSwap, Cut, StarPower, BombTrigger, OrbitalBeam } = require('./abilities.js');

// Depth (px) of a starting gate measured inward from its world edge. Matches the
// editor's gate strip width so the previewed gate lines up with the server's.
var GATE_DEPTH = 75;

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
		// Active Orbital Beam telegraphs (owner -> locked strike line), so the AI can
		// steer out of the marked danger band during the fuse. Cleared on round reset
		// (clean()) and when each beam fires (fireOrbitalBeam).
		this.pendingBeams = {};
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
		// One gate per start edge: single-edge maps have one, opposite-edge combos
		// (left+right / top+bottom) have two. Built in setupMap from the map's
		// startEdges. The `startingGate` getter below returns gate 0 so older
		// single-gate readers keep working.
		this.startingGates = [];
		var allMaps = utils.loadMaps();
		// lobbyOnly maps (e.g. the lobby tutorial islands) are kept out of the race
		// rotation; the lobby loads its map from lobbyMaps separately.
		this.maps = allMaps.filter(function (m) { return !m.lobbyOnly; });
		this.lobbyMaps = allMaps.filter(function (m) { return m.lobbyOnly; });
		this.mapsPlayed = [];
		// Active playlist for this room's rotation. Players set it at the lobby
		// hub board (last-writer-wins, room-wide); the rotation only draws from
		// maps whose meta.playlists includes it. Defaults to the auto-balanced
		// "featured" pool. A too-thin playlist transparently falls back to the
		// full pool (see getEligibleMapIndices) so rotation can never starve.
		this.playlistId = (c.defaultPlaylist || "featured");
		// Room-wide game mode (lobby hub mode station, last-writer-wins). Like the
		// playlist it persists across rounds AND game-overs for the life of the room;
		// it only changes from the lobby (see messenger setLobbyGameMode). The mode's
		// flags (teams/brutal) are read from c.gameModes via gameModeDef().
		this.gameModeId = (c.defaultGameMode || "standard_ffa");
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
		// Preview-only: pin the HUMAN players' start gate to this edge ("left"/
		// "right"/"top"/"bottom") so the author can test a chosen side of a
		// multi-gate map. null = normal balanced placement. Bots are never pinned,
		// so the opposite gate still fields a grid to race against.
		this.previewStartEdge = null;

		this.allAbilityIDs = this.indexAbilities();
		this.collapseLoc = {};
		this.collapseLine = this.world.height;
		this.visionBlockedUntil = 0;
		this.blackoutActive = false;
		// Bunker state — initialized here (not just in clean()) because lobby-tutorial
		// abilities (bomb/iceCannon/lava/tileSwap) can run before the first race, and
		// their island-protection guards index bunkerSafeIds; an undefined would throw.
		this.goalBuried = false;
		this.bunkerRingActive = false;
		this.bunkerLoc = null;
		this.bunkerArenaRadius = 0;
		this.bunkerSafeIds = {};
		this.bunkerLidIds = [];
		this.bunkerStartTime = null;
		// Heatwave state — the scorched-tile set is shared BY REFERENCE with every
		// player (handleMapCellHit reads it for the Firewalker medal), so the second
		// wave can extend the same object in place. Initialized here as well as in
		// clean() so pre-first-race code can never index an undefined.
		this.heatwaveScorchedIds = null;
		this.pendingHeatwaveWave = null;
		this.soloMode = false;
		this.soloCollapseSpeed = c.lastPlayerCollapseSpeed;
		this.soloStartDistance = this.world.height + 400;
		this.firstPlaceSig = null;
		// Room-wide throttle (ms timestamp) so the crowd's near-burn gasp fires
		// at most once per audienceNearBurnCooldown, no matter how many racers
		// are skating the lava edge at once.
		this.nextNearBurnTime = 0;
	}
	// Back-compat alias: most of the codebase only ever needs "the gate", which is
	// gate 0. Opposite-edge maps add a second gate read through startingGates[].
	get startingGate() {
		return this.startingGates.length > 0 ? this.startingGates[0] : null;
	}
	update(currentState, playerAliveCount, sleepingPlayerCount, dt) {
		this.alivePlayerCount = playerAliveCount;
		this.sleepingPlayerCount = sleepingPlayerCount;
		// Drive the AI racers' steering before the engine integrates movement, so
		// bots set the same targetDir/braking/angle inputs a human's socket would.
		aiController.update(this, currentState, dt);
		this.engine.update(dt);
		this.collapseMap(currentState);
		this.bunkerRingTick(currentState);
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
		// Resolve mutual counter-punches BEFORE knockback lands: if two players are
		// punching each other while facing each other, neither hit connects (the punches
		// are flagged clashed so handlePunchHit skips them) and each is flung back by
		// their own momentum below. Race-only: the clash reflect is a combat mechanic, and
		// letting it fling players around during pre-race gate jostling (or the lobby
		// tutorial) just knocks them into the start-line lava.
		if (currentState == this.stateMap.racing || currentState == this.stateMap.collapsing) {
			this.resolvePunchClashes();
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
	// Counter/parry: two players punching each other while facing each other clash.
	// Punches live ~100ms in punchList, so two thrown within that window coexist here.
	// A clash denies both hits (clashed flag, read by handlePunchHit) and flings each
	// owner back proportional to THEIR OWN momentum — so charging in heavy and getting
	// countered backfires hardest on the aggressor. clashResolved guards against
	// re-firing the same clash on later ticks while the punches linger.
	resolvePunchClashes() {
		var cfg = c.punchClash;
		var ids = Object.keys(this.punchList);
		for (var i = 0; i < ids.length; i++) {
			var pa = this.punchList[ids[i]];
			if (!this.clashEligible(pa)) { continue; }
			var ownerA = this.playerList[pa.ownerId];
			if (ownerA == null || !ownerA.alive || ownerA.isInvuln()) { continue; }
			for (var j = i + 1; j < ids.length; j++) {
				var pb = this.punchList[ids[j]];
				if (!this.clashEligible(pb)) { continue; }
				var ownerB = this.playerList[pb.ownerId];
				if (ownerB == null || !ownerB.alive || ownerB.isInvuln()) { continue; }
				// Teammates' simultaneous punches don't clash: each punch passes through
				// and then no-ops on the teammate (handlePunchHit's friendly-fire gate),
				// so two teammates swinging side by side at a rival aren't flung apart.
				// Zombie bites already never clash (clashEligible excludes ownerInfected).
				if (pa.ownerTeamId != null && pa.ownerTeamId === pb.ownerTeamId) { continue; }
				if (!this.isPunchClash(ownerA, pa, ownerB, pb, cfg)) { continue; }
				var bonusA = pa.getBonus(), bonusB = pb.getBonus();
				if (Math.abs(bonusA - bonusB) <= cfg.tieMargin) {
					// Standoff: forces are close, so neither lands — both are consumed and
					// flung back by their OWN momentum, hardest on whoever charged heaviest.
					pa.clashed = true; pb.clashed = true;
					pa.clashResolved = true; pb.clashResolved = true;
					_engine.reflectPunch(ownerA, ownerB.x, ownerB.y, cfg.reflectKick * bonusA);
					_engine.reflectPunch(ownerB, ownerA.x, ownerA.y, cfg.reflectKick * bonusB);
					messenger.messageRoomBySig(this.roomSig, "punchClash", {
						x: (ownerA.x + ownerB.x) / 2,
						y: (ownerA.y + ownerB.y) / 2
					});
				} else if (bonusA > bonusB) {
					// A wins: the weaker punch is cancelled+consumed; A's punch is left live
					// (and NOT marked resolved) so it still lands AND can still be contested
					// by a third player's counter in a multi-punch scrum.
					pb.clashed = true; pb.clashResolved = true;
				} else {
					pa.clashed = true; pa.clashResolved = true;
				}
				break; // ownerA's punch is spent on this contest
			}
		}
	}
	// Only real, still-pending player punches can clash. Excludes: empty slots,
	// bumper/hazard punches (mapOwned), already-resolved clashes, punches that already
	// landed a normal hit (so only same-tick simultaneous punches clash, never a punch
	// retroactively after it connected), and zombie bites (ownerInfected) — a clash
	// must never deny an infection.
	clashEligible(p) {
		return p != null && !p.mapOwned && !p.clashResolved && !p.landed
			&& !p.ownerInfected;
	}
	// A clash needs the owners close (range) AND each facing roughly toward the other
	// (facingDot). Uses each punch's stored facing angle (the puncher's heading at the
	// moment of swing) — the punch lands radially, but two players have to be charging
	// into each other to clash.
	isPunchClash(ownerA, pa, ownerB, pb, cfg) {
		var dx = ownerB.x - ownerA.x;
		var dy = ownerB.y - ownerA.y;
		var dist = utils.getMag(dx, dy);
		if (dist > cfg.range) { return false; }
		// Exactly overlapping (e.g. a swap teleport onto another kart): no meaningful
		// facing, so don't force a clash — let the punches resolve normally.
		if (dist == 0) { return false; }
		var ux = dx / dist, uy = dy / dist;
		var ra = pa.angle * Math.PI / 180;
		if (Math.cos(ra) * ux + Math.sin(ra) * uy < cfg.facingDot) { return false; }
		var rb = pb.angle * Math.PI / 180;
		if (Math.cos(rb) * (-ux) + Math.sin(rb) * (-uy) < cfg.facingDot) { return false; }
		return true;
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
				_engine.bounceOffEmptyCells(this.playerList[player], this.currentMap);
				_engine.bounceOffStoneEdges(this.playerList[player], this.currentMap);
				_engine.bounceZombieOffWater(this.playerList[player], this.currentMap);
			}
			// The spawn pad is a safe zone (force-shield against bomb/ice/cut knockback).
			// It used to inherit that from the transparent "background" sanctuary tile,
			// but the pad is now solid ground, so checkCollideCells just cleared
			// onSanctuary based on the grass/dirt underfoot. Re-assert it for any player
			// standing within the pad radius so freshly-spawned / mid-join players can't
			// be flung off the pad (into a hole or lava) before they get moving.
			this.reassertSpawnPadSanctuary(this.playerList[player]);
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
			// Clamp each player to THEIR gate (opposite-edge maps hold two groups).
			var gate = this.startingGates[this.playerList[player].gateIndex] || this.startingGates[0];
			if (gate != null) {
				_engine.preventEscape(this.playerList[player], gate);
			}
			objectArray.push(this.playerList[player]);
		}
		for (var punchId in this.punchList) {
			objectArray.push(this.punchList[punchId]);
		}
	}
	collectRaceCollisionObjects(currentState, objectArray) {
		// During collapse every gate becomes a lava wall players are crushed into.
		if (currentState == this.stateMap.collapsing) {
			for (var g = 0; g < this.startingGates.length; g++) {
				objectArray.push(this.startingGates[g]);
			}
		}
		for (var player in this.playerList) {
			if (!this.playerList[player].alive) {
				continue;
			}
			_engine.preventEscape(this.playerList[player], this.world);
			_engine.checkCollideCells(this.playerList[player], this.currentMap);
			_engine.bounceOffEmptyCells(this.playerList[player], this.currentMap);
			_engine.bounceOffStoneEdges(this.playerList[player], this.currentMap);
			_engine.bounceZombieOffWater(this.playerList[player], this.currentMap);
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
			// Defensive: if the owning player has left the room mid-round, the ability
			// is orphaned. Room.leave clears it via removeOwnedEntities, but never let
			// the owner-derefs below (e.g. the SwapAimer construction) read a missing
			// player — drop the orphan and move on.
			if (this.playerList[this.abilityList[id].ownerId] == null) {
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
				this.pendingAbilityTimers.push(setTimeout(this.removeSpeedBuff, c.tileMap.abilities.speedBuff.duration, { id: this.abilityList[id].ownerId, playerList: this.playerList, buffedIds: this.applySpeedBuff(this.abilityList[id].ownerId) }));
			}
			if (this.abilityList[id].applyDebuff) {
				this.abilityList[id].applyDebuff = false;
				this.pendingAbilityTimers.push(setTimeout(this.removeSpeedDebuff, c.tileMap.abilities.speedDebuff.duration, { id: this.abilityList[id].ownerId, playerList: this.playerList, deltaList: this.applySpeedDebuff(this.abilityList[id].ownerId) }));
			}
			if (this.abilityList[id].tileSwap) {
				this.abilityList[id].tileSwap = false;
				this.startTileSwap();
			}
			if (this.abilityList[id].fireBeam) {
				this.abilityList[id].fireBeam = false;
				this.startOrbitalBeam(this.abilityList[id].ownerId);
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
			if (this.abilityList[id].applyStar) {
				this.abilityList[id].applyStar = false;
				// Timestamp-based effect: every damage/knockback/effect gate checks
				// hasStarPower() against this, so there's no removal timer to track.
				var starOwner = this.playerList[this.abilityList[id].ownerId];
				if (starOwner != null) {
					starOwner.starPowerUntil = Date.now() + c.tileMap.abilities.starPower.duration;
				}
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
			player.update(currentState, dt);
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
			// The Bunker island is ice; a tileSwap would otherwise flip it to fast,
			// corrupting the safe core (and its look under the silo door). Leave it be.
			if (this.bunkerSafeIds[cells[i].site.voronoiId]) { continue; }
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
	// Orbital Beam: LOCK the origin + 8-way direction at cast (it's "from orbit" — a
	// fixed line, not the holder's live aim), broadcast the cast so clients telegraph
	// the strike line for the fuse, then schedule the actual strike. Tracked in
	// pendingAbilityTimers like every other ability timer so a round/match teardown
	// cancels a pending beam instead of striking a stale room.
	startOrbitalBeam(owner) {
		var player = this.playerList[owner];
		if (player == null || this.currentMap == null || this.currentMap.cells == null) {
			return;
		}
		var ob = c.tileMap.abilities.orbitalBeam;
		// Same 8-way snap the bomb/ice cannon use; fall back to the raw angle if the
		// holder's facing isn't a clean 45 (clampPlayerAngle returns undefined then).
		var angle = this.clampPlayerAngle(player.angle);
		if (angle == null) {
			angle = player.angle;
		}
		var packet = {
			context: this,
			map: this.currentMap,
			owner: owner,
			x: player.x,
			y: player.y,
			angle: angle,
			length: ob.beamLength,
			width: ob.beamWidth
		};
		// Record the locked strike line so the AI can steer out of the band during the
		// fuse (consumed in aiController via ctx.telegraphs). Keyed by owner so a re-cast
		// replaces it; fireOrbitalBeam / clean() clear it.
		var rad = angle * (Math.PI / 180);
		this.pendingBeams[owner] = {
			ownerId: owner,
			x: player.x,
			y: player.y,
			dirX: Math.cos(rad),
			dirY: Math.sin(rad),
			length: ob.beamLength,
			halfWidth: ob.beamWidth / 2,
			fireAt: Date.now() + ob.fuse
		};
		messenger.messageRoomBySig(this.roomSig, "orbitalBeamCast", {
			owner: owner,
			x: player.x,
			y: player.y,
			angle: angle,
			length: ob.beamLength,
			width: ob.beamWidth,
			duration: ob.fuse
		});
		this.pendingAbilityTimers.push(setTimeout(this.fireOrbitalBeam, ob.fuse, packet));
	}
	fireOrbitalBeam(packet) {
		var gameBoard = packet.context;
		// Telegraph is resolving — drop it whether or not the strike actually lands.
		delete gameBoard.pendingBeams[packet.owner];
		// Bail if the round/map changed while the fuse burned (currentMap is a fresh
		// object each round, so a reference check catches it) — same guard as performTileSwap.
		if (gameBoard.currentMap !== packet.map || gameBoard.currentMap == null) {
			return;
		}
		var rad = packet.angle * (Math.PI / 180);
		var dirX = Math.cos(rad), dirY = Math.sin(rad);
		// Perpendicular axis for the half-width test (the beam is a rectangle: 0..length
		// along the direction, +/- width/2 across it).
		var perpX = -dirY, perpY = dirX;
		var ox = packet.x, oy = packet.y, length = packet.length, halfW = packet.width / 2;
		var iceId = c.tileMap.ice.id, waterId = c.tileMap.water.id;
		var sandId = c.tileMap.slow.id, lavaId = c.tileMap.lava.id;
		var cells = gameBoard.currentMap.cells;
		var tileDelta = {};
		var changed = false;
		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];
			// Only ice and sand are transmutable by the beam; skip everything else early.
			var newId = null;
			if (cell.id == iceId) { newId = waterId; }
			else if (cell.id == sandId) { newId = lavaId; }
			else { continue; }
			var vx = cell.site.x - ox, vy = cell.site.y - oy;
			var along = vx * dirX + vy * dirY;
			if (along < 0 || along > length) { continue; }
			var across = vx * perpX + vy * perpY;
			if (across < -halfW || across > halfW) { continue; }
			cell.id = newId;
			gameBoard.tileChanges[cell.site.voronoiId] = newId; // late-joiner snapshot
			tileDelta[cell.site.voronoiId] = newId;
			changed = true;
		}
		if (changed) {
			messenger.messageRoomBySig(gameBoard.roomSig, "tileChanges", JSON.stringify(tileDelta));
			// The beam can place water immediately beside lava (or vice-versa); the
			// compute-once stone-edge cache won't grow those seams on its own, so rebuild
			// it from the now-live ids. The client recomputes its seams from live cell ids
			// each frame (drawStoneBorders), so no extra client lockstep is needed.
			_engine.rebuildStoneEdges(gameBoard.currentMap);
			gameBoard.lobbyMapDirty = true;
			gameBoard.lobbyLastActivity = Date.now();
		}
		// Burn every kart standing in the line like lava (applyLavaBurn honors invuln /
		// Star Power / zombie immunity and routes a fire shield through the burn timer).
		// The caster is NOT exempt — linger in your own beam and it burns you too; a
		// self-burn is uncredited (attacker null), like driving yourself into lava.
		for (var id in gameBoard.playerList) {
			var p = gameBoard.playerList[id];
			if (p == null || p.alive == false) { continue; }
			var px = p.x - ox, py = p.y - oy;
			var pAlong = px * dirX + py * dirY;
			var pad = p.radius != null ? p.radius : 0;
			if (pAlong < -pad || pAlong > length + pad) { continue; }
			var pAcross = px * perpX + py * perpY;
			if (pAcross < -(halfW + pad) || pAcross > (halfW + pad)) { continue; }
			p.applyLavaBurn(id === packet.owner ? null : packet.owner);
		}
		messenger.messageRoomBySig(gameBoard.roomSig, "orbitalBeamFired", {
			owner: packet.owner,
			x: ox,
			y: oy,
			angle: packet.angle,
			length: length,
			width: packet.width
		});
	}
	cutPlayers(owner) {
		for (var id in this.playerList) {
			if (id == owner) {
				continue;
			}
			// Same force-shield as applyExplosionForce: don't cut-fling a protected
			// (invuln / spawn-pad) player — or a Star Power holder. No-op outside the lobby.
			if (this.playerList[id].isProtected() || this.playerList[id].hasStarPower()) {
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
			randomPlayer.awake == false ||
			randomPlayer.hasStarPower()) {
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
		var bomb = new BombProj(player.x, player.y, 10, "black", owner, this.roomSig, this.launchAngle(player));
		this.projectileList[owner] = bomb;
		messenger.messageRoomBySig(this.roomSig, "spawnBomb", owner);
	}
	spawnSnowFlake(owner) {
		var player = this.playerList[owner];
		player.addSpeed(100);
		var snowFlake = new SnowFlakeProj(player.x, player.y, c.tileMap.abilities.iceCannon.snowFlakeRadius, "black", owner, this.roomSig, this.launchAngle(player));
		this.projectileList[owner] = snowFlake;
		messenger.messageRoomBySig(this.roomSig, "spawnSnowFlake", owner);
	}
	// The angle a player's projectile launches at: the 8-way snap when their facing
	// is a clean 45, else their RAW facing — the same fallback startOrbitalBeam uses.
	// clampPlayerAngle returns undefined for unaligned angles (mouse-aim players send
	// free angles via mousemove), and an undefined launch angle NaNs the projectile's
	// velocity AND position; since the CellIndex spatial grid landed, a NaN position
	// makes checkCollideCells dereference an undefined bucket and CRASHES the room
	// tick. The fallback keeps clean-angle shots identical and makes free-angle shots
	// fly where the player is actually facing.
	launchAngle(player) {
		var angle = this.clampPlayerAngle(player.angle);
		return (angle == null) ? player.angle : angle;
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
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.lava.id || cells[i].id == c.tileMap.background.id || cells[i].id == c.tileMap.empty.id || cells[i].id == c.tileMap.water.id) {
				continue;
			}
			// The Bunker island is the protected safe core — no ability may alter it.
			if (this.bunkerSafeIds[cells[i].site.voronoiId]) { continue; }
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
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.background.id || cells[i].id == c.tileMap.empty.id) {
				continue;
			}
			if (this.bunkerSafeIds[cells[i].site.voronoiId]) { continue; } // protect the Bunker island
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
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.background.id || cells[i].id == c.tileMap.empty.id) {
				continue;
			}
			if (this.bunkerSafeIds[cells[i].site.voronoiId]) { continue; } // never lava the Bunker island
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
			// Star Power shrugs off explosion knockback in any state.
			if (player.isProtected() || player.hasStarPower()) {
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
		// Track exactly who got the drag break so removeSpeedBuff unwinds only
		// them — a player skipped here (Star Power) or who joined mid-buff must
		// not have drag ADDED on expiry that was never removed.
		var buffedIds = [];
		for (var id in this.playerList) {
			if (!this.playerList[id].alive || this.playerList[id].isZombie) {
				continue;
			}
			// Star Power: immune to rival speed effects (their own use still applies).
			if (id != owner && this.playerList[id].hasStarPower()) {
				continue;
			}
			if (id == owner) {
				this.playerList[id].addSpeed(100);
			}
			this.playerList[id].decreaseDragMultiplier(c.tileMap.abilities.speedBuff.value)
			buffedIds.push(id);
		}
		return buffedIds;
	}
	removeSpeedBuff(packet) {
		for (var i = 0; i < packet.buffedIds.length; i++) {
			var id = packet.buffedIds[i];
			if (packet.playerList[id] == null) {
				continue;
			}
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
			// Star Power: debuffs bounce off (and the deltaList skip means no
			// phantom restore when the debuff expires).
			if (this.playerList[id].hasStarPower()) {
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
			// Sync the room-wide playlist to everyone when the lobby (re)loads, so a
			// late joiner / fresh lobby shows the current pick (default 'featured').
			messenger.messageRoomBySig(this.roomSig, "lobbyPlaylistChanged", { id: this.playlistId });
			// Same for the room's game mode (mode persists across game-overs).
			messenger.messageRoomBySig(this.roomSig, "lobbyGameModeChanged", { id: this.gameModeId });
		// Deliver the lobby bumpers so the client creates them (gameUpdates only moves
		// hazards the client already knows about; creation is via this applyHazards path,
		// the same payload shape the newMap event uses for races).
		messenger.messageRoomBySig(this.roomSig, "applyHazards", compressor.newHazards(this.hazardList));
	}
	// Instantiate the walk-up hub stations for this lobby. Positions come from an
	// optional map-JSON `stations` array (authored on verified-clear ground, like
	// `spawnPad` — see _LobbyTutorial.json); if the map omits it we fall back to code
	// defaults that flank the central start button on the center row, so the lobby
	// always has reachable stations even on a plain field.
	buildLobbyStations() {
		this.lobbyStations = [];
		var R = 60; // station radius (a little smaller than the 75px start button)
		var defaults = [
			{ id: "skin", kind: "skin", cx: this.world.width * 0.33, cy: this.world.height * 0.5, color: "#4aa3ff" },
			{ id: "ai", kind: "ai", cx: this.world.width * 0.67, cy: this.world.height * 0.5, color: "#3ad17a" },
			// The playlist board sits above the central start button so three stations
			// don't crowd the center row (fallback layout only; the real lobby authors
			// station positions in _LobbyTutorial.json).
			{ id: "playlist", kind: "playlist", cx: this.world.width * 0.5, cy: this.world.height * 0.28, color: "#FFCB30" }
		];
		var authored = (this.currentMap != null && Array.isArray(this.currentMap.stations))
			? this.currentMap.stations
			: null;
		var src = authored || defaults;
		for (var i = 0; i < src.length; i++) {
			var s = src[i];
			this.lobbyStations.push(new LobbyStation(s.cx, s.cy, s.r || R, s.id, s.kind, s.color || "#888"));
		}
		// Reset every player's proximity latch whenever stations are (re)built, so a
		// stale nearStation from a previous lobby can't diff into a spurious exit. This
		// runs on each Game.startLobby (players are on the spawn pad, away from any
		// zone); the periodic lobby-map idle-reset (restoreLobbyMap) only restores
		// tiles and does NOT rebuild stations, so it never disturbs an open panel.
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
	// Keep the spawn pad a safe zone regardless of the tile under it: a player whose
	// center is within the pad radius is force-shielded (isProtected) against bomb/ice/
	// cut knockback. Called each lobby tick after checkCollideCells (which sets
	// onSanctuary from the tile) so the pad stays safe now that it's solid ground.
	reassertSpawnPadSanctuary(player) {
		if (this.currentMap == null || this.currentMap.spawnPad == null) {
			return;
		}
		var sp = this.currentMap.spawnPad;
		var dx = player.x - sp.cx, dy = player.y - sp.cy;
		if (dx * dx + dy * dy <= sp.r * sp.r) {
			player.onSanctuary = true;
		}
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
		// Snapshot the pre-teleport position so the client knows WHERE the player
		// died/scored in world coords (the teleport below overwrites player.x/y,
		// and the next gameUpdates packet — which would otherwise be the source —
		// carries the post-teleport spawn-pad coords).
		var preX = player.x;
		var preY = player.y;
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
		messenger.messageRoomBySig(this.roomSig, "lobbyRespawn", {
			id: player.id,
			death: (type == "death"),
			invulnMs: c.lobbyRespawnInvulnMs,
			x: preX,
			y: preY
		});
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
		this.startingGates = this.buildStartingGates(this.resolveStartEdges());
		this.gatePlayers();
	}
	// The edges players start from for the current map. Legacy maps (and anything
	// malformed) default to a single left gate, so behaviour is unchanged for
	// every committed map that predates this field.
	resolveStartEdges() {
		var OPPOSITE = { left: "right", right: "left", top: "bottom", bottom: "top" };
		var se = (this.currentMap != null) ? this.currentMap.startEdges : null;
		if (!Array.isArray(se) || se.length === 0) {
			return ["left"];
		}
		var edges = [];
		for (var i = 0; i < se.length && edges.length < 2; i++) {
			if (OPPOSITE[se[i]] && edges.indexOf(se[i]) === -1) {
				edges.push(se[i]);
			}
		}
		// Only opposite pairs (left+right / top+bottom) are valid two-gate combos.
		// validateMap enforces this at submit, but library maps load without
		// re-validation, so drop a second ADJACENT edge here too — a hand-edited
		// map can't spawn two adjacent gates (an untested layout).
		if (edges.length === 2 && OPPOSITE[edges[0]] !== edges[1]) {
			edges = [edges[0]];
		}
		return edges.length > 0 ? edges : ["left"];
	}
	// One Gate per start edge. The gate hugs its edge with a fixed depth (GATE_DEPTH)
	// and spans the full width/height of the opposite axis. Gate stores true
	// dimensions, so these rects are correct on any edge.
	buildStartingGates(startEdges) {
		var W = this.world.width, H = this.world.height, D = GATE_DEPTH;
		var rects = {
			left: [0, 0, D, H],
			right: [W - D, 0, D, H],
			top: [0, 0, W, D],
			bottom: [0, H - D, W, D]
		};
		var gates = [];
		for (var i = 0; i < startEdges.length; i++) {
			var r = rects[startEdges[i]];
			if (r == null) { continue; }
			var gate = new Gate(r[0], r[1], r[2], r[3]);
			gate.edge = startEdges[i];
			gates.push(gate);
		}
		if (gates.length === 0) {
			var fallback = new Gate(0, 0, D, H);
			fallback.edge = "left";
			gates.push(fallback);
		}
		return gates;
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
			if (cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.lava.id || cells[i].id == c.tileMap.empty.id) {
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
	// Group the map's goal cells into spatially-distinct clusters (a map can have
	// more than one goal zone). Two goal cells join the same cluster when within
	// bunker.clusterGap of each other (flood fill). Returns an array of clusters,
	// each an array of cell references.
	getGoalClusters() {
		var cells = this.currentMap.cells;
		var goals = [];
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.goal.id) { goals.push(cells[i]); }
		}
		if (goals.length === 0) { return []; }
		var gap = c.brutalRounds.bunker.clusterGap;
		var gap2 = gap * gap;
		var clusters = [];
		var assigned = new Array(goals.length);
		for (var a = 0; a < goals.length; a++) {
			if (assigned[a]) { continue; }
			var stack = [a];
			assigned[a] = true;
			var members = [];
			while (stack.length > 0) {
				var idx = stack.pop();
				members.push(goals[idx]);
				for (var b = 0; b < goals.length; b++) {
					if (assigned[b]) { continue; }
					var dx = goals[idx].site.x - goals[b].site.x;
					var dy = goals[idx].site.y - goals[b].site.y;
					if (dx * dx + dy * dy <= gap2) { assigned[b] = true; stack.push(b); }
				}
			}
			clusters.push(members);
		}
		return clusters;
	}
	// Bunker (battle-royale) round setup, run once at map setup (before racing).
	// Randomly picks ONE goal cluster as the buried "bunker"; converts that cluster
	// (plus a small padding disc) to ice and remembers it as the silo lid; every
	// OTHER goal cluster loses its win-immunity by becoming normal floor (so the
	// closing ring can swallow it and only one safe island exists). The goal stays
	// underground (no goal tile = unclaimable) until emergeBunker() restores it once
	// a single survivor remains.
	applyBrutalBunkerRound() {
		var clusters = this.getGoalClusters();
		if (clusters.length === 0) {
			// No goal on this map (shouldn't happen for committed maps) -> nothing to
			// bury; leave the round as a plain race so it can't softlock.
			return;
		}
		var chosen = clusters[utils.getRandomInt(0, clusters.length - 1)];
		var chosenSet = {};
		var cx = 0, cy = 0;
		for (var i = 0; i < chosen.length; i++) {
			chosenSet[chosen[i].site.voronoiId] = true;
			cx += chosen[i].site.x;
			cy += chosen[i].site.y;
		}
		cx /= chosen.length;
		cy /= chosen.length;
		var clusterRadius = 0;
		for (var i = 0; i < chosen.length; i++) {
			var d = utils.getMag(cx - chosen[i].site.x, cy - chosen[i].site.y);
			if (d > clusterRadius) { clusterRadius = d; }
		}
		this.bunkerLoc = { x: cx, y: cy };
		// Ring floor = just the chosen cluster's own extent: the safe island is the
		// goal tile(s) themselves, nothing more — the lava closes right up to the
		// goal's edge (no padded disc spilling onto neighbouring tiles).
		this.bunkerArenaRadius = clusterRadius;
		this.goalBuried = true;
		this.bunkerSafeIds = {};
		this.bunkerLidIds = [];

		var cells = this.currentMap.cells;
		var tileDelta = {};
		var maxDist = 0;
		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];
			var inChosen = chosenSet[cell.site.voronoiId] === true;
			var dx = cx - cell.site.x, dy = cy - cell.site.y;
			var dist = Math.sqrt(dx * dx + dy * dy);
			if (dist > maxDist) { maxDist = dist; }
			if (inChosen) {
				// The bunker island: exactly the chosen goal cluster's cells, turned to
				// ice and remembered as the silo lid to restore on emerge.
				cell.id = c.tileMap.ice.id;
				this.tileChanges[cell.site.voronoiId] = cell.id;
				tileDelta[cell.site.voronoiId] = cell.id;
				this.bunkerSafeIds[cell.site.voronoiId] = true;
				this.bunkerLidIds.push(cell.site.voronoiId);
			} else if (cell.id == c.tileMap.goal.id) {
				// Any OTHER goal cluster: sacrifice it to normal floor so it has no
				// win-immunity and isn't claimable while the goal is buried.
				cell.id = c.tileMap.normal.id;
				this.tileChanges[cell.site.voronoiId] = cell.id;
				tileDelta[cell.site.voronoiId] = cell.id;
			}
		}

		// Ring starts fully open (line beyond the farthest cell) and closes inward
		// toward the bunker each racing tick. collapseLoc/collapseLine are reused so
		// the AI's existing ring awareness gets the bunker for free.
		this.collapseLoc = { x: cx, y: cy };
		this.collapseLine = maxDist + 50;
		this.bunkerRingActive = true;
		this.bunkerStartTime = null;

		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(tileDelta));
		messenger.messageRoomBySig(this.roomSig, "bunkerStart", { x: cx, y: cy, radius: this.bunkerArenaRadius, lid: this.bunkerLidIds });
	}
	// Advances the closing ring during a Bunker round's racing phase: lava encroaches
	// from the perimeter inward toward the bunker, never consuming the safe ice island.
	// The shrinking arena forces survivors together and into combat/lava until one
	// remains. No-op outside a racing Bunker round.
	bunkerRingTick(currentState) {
		if (!this.bunkerRingActive || currentState != c.stateMap.racing) { return; }
		if (this.bunkerStartTime == null) { this.bunkerStartTime = Date.now(); }
		if (this.collapseLine > this.bunkerArenaRadius) {
			this.collapseLine -= c.brutalRounds.bunker.ringSpeed;
			if (this.collapseLine < this.bunkerArenaRadius) { this.collapseLine = this.bunkerArenaRadius; }
		}
		var collapsedCells = [];
		var cells = this.currentMap.cells;
		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];
			if (this.bunkerSafeIds[cell.site.voronoiId]) { continue; }
			if (cell.id == c.tileMap.lava.id || cell.id == c.tileMap.empty.id || cell.id == c.tileMap.background.id) { continue; }
			var distance = utils.getMag(this.collapseLoc.x - cell.site.x, this.collapseLoc.y - cell.site.y);
			if (this.collapseLine < distance) {
				cell.id = c.tileMap.lava.id;
				this.tileChanges[cell.site.voronoiId] = cell.id;
				collapsedCells.push(cell.site.voronoiId);
			}
		}
		if (collapsedCells.length > 0) {
			messenger.messageRoomBySig(this.roomSig, 'collapsedCells', collapsedCells);
		}
	}
	// Raise the buried goal once a single survivor remains: revert the silo-lid cells
	// back to goal tiles (so the survivor can claim the win) and tell clients to play
	// the quick emerge animation. Idempotent.
	emergeBunker() {
		if (!this.goalBuried) { return; }
		this.goalBuried = false;
		this.bunkerRingActive = false;
		var tileDelta = {};
		var cells = this.currentMap.cells;
		var lidSet = {};
		for (var i = 0; i < this.bunkerLidIds.length; i++) { lidSet[this.bunkerLidIds[i]] = true; }
		for (var i = 0; i < cells.length; i++) {
			if (lidSet[cells[i].site.voronoiId]) {
				cells[i].id = c.tileMap.goal.id;
				this.tileChanges[cells[i].site.voronoiId] = cells[i].id;
				tileDelta[cells[i].site.voronoiId] = cells[i].id;
			}
		}
		messenger.messageRoomBySig(this.roomSig, "tileChanges", JSON.stringify(tileDelta));
		messenger.messageRoomBySig(this.roomSig, "bunkerEmerge", { x: this.bunkerLoc.x, y: this.bunkerLoc.y, lid: this.bunkerLidIds });
	}
	// --- Heatwave (brutal id 1013) ---
	// Tile-name decoder for everything below: config `slow` renders as SAND,
	// `normal` renders as DIRT, `fast` renders as GRASS (see draw.js patterns).
	// Sand/ice are the "dramatic" conversions (lava/water) the mode is built on.
	countHeatwaveConvertibles() {
		var cells = (this.currentMap != null) ? this.currentMap.cells : null;
		if (cells == null) { return 0; }
		var n = 0;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id == c.tileMap.slow.id || cells[i].id == c.tileMap.ice.id) { n++; }
		}
		return n;
	}
	// True when every start edge can still walk to a goal on the LIVE cell ids.
	// Heatwave's only blocking conversion is sand->lava, so this is the guard that
	// keeps "there is always a walkable path to the goal" true.
	heatwavePathOk() {
		var edges = this.resolveStartEdges();
		for (var e = 0; e < edges.length; e++) {
			if (!cellGraph.reachableFromEdge(this.currentMap, edges[e])) { return false; }
		}
		return true;
	}
	// Heatwave's bonus ability pads lean toward counterplay: half of them carry the
	// Ice Cannon (the heat scatters its own extinguisher), the rest roll normally.
	spawnHeatwaveAbility() {
		if (c.forceAbilitySpawn != null) { return c.forceAbilitySpawn; }
		var iceCannon = c.tileMap.abilities.iceCannon;
		if (iceCannon != null && iceCannon.spawnable && utils.getRandomInt(1, 100) <= 50) {
			return iceCannon.id;
		}
		return this.spawnNewAbility();
	}
	// Pick this wave's conversions WITHOUT permanently touching the map: candidates
	// are applied only to validate the path guarantee, then reverted. Returns
	// { newIds: {vid: newTileId}, fromIds: {vid: oldTileId}, count } or null.
	// `pcts` is either the top-level heatwave config (round start) or its
	// secondWave block — both carry the four *Pct knobs.
	selectHeatwaveChanges(pcts) {
		var hw = c.brutalRounds.heatwave;
		var cells = (this.currentMap != null) ? this.currentMap.cells : null;
		if (cells == null) { return null; }
		var sandId = c.tileMap.slow.id, lavaId = c.tileMap.lava.id;
		var iceId = c.tileMap.ice.id, waterId = c.tileMap.water.id;
		var grassId = c.tileMap.fast.id, dirtId = c.tileMap.normal.id;
		// Gate strips never receive lava: gate spawn points don't avoid hazards, so a
		// converted tile under a spawn would burn someone at GO.
		var margin = GATE_DEPTH + (hw.gateMargin || 0);
		var edges = this.resolveStartEdges();
		var W = this.world.width, H = this.world.height;
		var nearGate = function (site) {
			for (var e = 0; e < edges.length; e++) {
				if (edges[e] === "left" && site.x < margin) { return true; }
				if (edges[e] === "right" && site.x > W - margin) { return true; }
				if (edges[e] === "top" && site.y < margin) { return true; }
				if (edges[e] === "bottom" && site.y > H - margin) { return true; }
			}
			return false;
		};
		var sand = [], ice = [], grass = [], dirt = [];
		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];
			if (cell.id == sandId) { if (!nearGate(cell.site)) { sand.push(cell); } }
			else if (cell.id == iceId) { ice.push(cell); }
			else if (cell.id == grassId) { grass.push(cell); }
			else if (cell.id == dirtId) { dirt.push(cell); }
		}
		var pctCount = function (bucket, pct) {
			return Math.round(bucket.length * (pct || 0) / 100);
		};
		var newIds = {}, fromIds = {}, count = 0;
		var take = function (bucket, n, makeId) {
			bucket = utils.shuffleArray(bucket);
			for (var k = 0; k < n && k < bucket.length; k++) {
				var vid = bucket[k].site.voronoiId;
				newIds[vid] = (typeof makeId === "function") ? makeId() : makeId;
				fromIds[vid] = bucket[k].id;
				count++;
			}
		};
		var self = this;
		take(ice, pctCount(ice, pcts.iceToWaterPct), waterId);
		take(grass, pctCount(grass, pcts.grassToDirtPct), dirtId);
		take(dirt, pctCount(dirt, pcts.dirtToAbilityPct), function () { return self.spawnHeatwaveAbility(); });
		// Sand->lava is the only conversion that can wall off the goal, so it gets
		// the retry loop: re-roll the picks, halving the count for the back half of
		// the attempts, and drop the lava conversions entirely if nothing validates.
		var lavaFull = pctCount(sand, pcts.sandToLavaPct);
		var applySel = function () {
			for (var v in newIds) {
				for (var ci = 0; ci < cells.length; ci++) {
					if (cells[ci].site.voronoiId == v) { cells[ci].id = newIds[v]; break; }
				}
			}
		};
		var revertSel = function () {
			for (var v in fromIds) {
				for (var ci = 0; ci < cells.length; ci++) {
					if (cells[ci].site.voronoiId == v) { cells[ci].id = fromIds[v]; break; }
				}
			}
		};
		if (lavaFull > 0) {
			var retries = hw.maxPathRetries || 8;
			for (var attempt = 0; attempt < retries; attempt++) {
				var lavaN = (attempt < retries / 2) ? lavaFull : Math.max(1, Math.floor(lavaFull / 2));
				var lavaPicks = utils.shuffleArray(sand).slice(0, lavaN);
				for (var lp = 0; lp < lavaPicks.length; lp++) {
					var lvid = lavaPicks[lp].site.voronoiId;
					newIds[lvid] = lavaId;
					fromIds[lvid] = sandId;
				}
				applySel();
				var ok = this.heatwavePathOk();
				revertSel();
				if (ok) { count += lavaPicks.length; break; }
				for (var rp = 0; rp < lavaPicks.length; rp++) {
					var rvid = lavaPicks[rp].site.voronoiId;
					delete newIds[rvid];
					delete fromIds[rvid];
				}
			}
		}
		if (count === 0) { return null; }
		// The non-lava conversions can't block, but validate the whole selection
		// once so the guarantee holds even if a future conversion type changes that.
		applySel();
		var finalOk = this.heatwavePathOk();
		revertSel();
		if (!finalOk) { return null; }
		return { newIds: newIds, fromIds: fromIds, count: count };
	}
	// Commit a selection to the live map: flip the cells, fold the delta into the
	// late-joiner snapshot, grow the shared scorched set, and rebuild stone seams
	// when new water appeared. Returns the {vid: newTileId} delta.
	commitHeatwaveChanges(sel) {
		var cells = this.currentMap.cells;
		var waterMade = false;
		var applied = {};
		for (var i = 0; i < cells.length; i++) {
			var vid = cells[i].site.voronoiId;
			var newId = sel.newIds[vid];
			if (newId == null) { continue; }
			cells[i].id = newId;
			this.tileChanges[vid] = newId;
			applied[vid] = newId;
			if (newId == c.tileMap.water.id) { waterMade = true; }
		}
		if (this.heatwaveScorchedIds == null) { this.heatwaveScorchedIds = {}; }
		for (var v in applied) { this.heatwaveScorchedIds[v] = true; }
		// Share by reference with everyone already seated; gatePlayer covers anyone
		// gated after this point. The second wave extends this same object, so the
		// players' references stay live.
		for (var pid in this.playerList) {
			if (this.playerList[pid] != null) {
				this.playerList[pid].heatwaveScorchedIds = this.heatwaveScorchedIds;
			}
		}
		if (waterMade) {
			// New water can now sit beside lava; grow the stone seams from the live
			// ids (same rule as the Orbital Beam).
			_engine.rebuildStoneEdges(this.currentMap);
		}
		return applied;
	}
	// Round-start application. Runs inside loadNextMap so the delta ships in the
	// newMap payload (clients animate the reveal during the gated zoom-out; the
	// server map is authoritative immediately — everyone is held at the gate).
	applyBrutalHeatwaveRound() {
		if (!this.checkForActiveBrutal(c.brutalRounds.heatwave.id)) { return null; }
		var sel = this.selectHeatwaveChanges(c.brutalRounds.heatwave);
		if (sel == null) { return null; }
		var applied = this.commitHeatwaveChanges(sel);
		return { changes: applied };
	}
	// --- Heatwave second wave (mid-race) ---
	// Scheduled from startRace (volcano pattern: unbound via setTimeout, everything
	// through packet.context). Selection happens at WARN time so the telegraph
	// matches exactly what flips; the flip drops any tile something else changed
	// during the warn window (collapse, tileSwap, ice cannon, ability pickup).
	warnOfHeatwaveWave(packet) {
		var game = packet.context;
		var gb = game.gameBoard;
		if (gb.currentMap !== packet.map || gb.currentMap == null) { return; }
		if (game.currentState != c.stateMap.racing) { return; }
		var sw = c.brutalRounds.heatwave.secondWave;
		var sel = gb.selectHeatwaveChanges(sw);
		if (sel == null || sel.count === 0) { return; }
		gb.pendingHeatwaveWave = sel;
		messenger.messageRoomBySig(gb.roomSig, "heatwavePending", JSON.stringify({ ids: sel.newIds, duration: sw.warnMs }));
		setTimeout(gb.fireHeatwaveWave, sw.warnMs, packet);
	}
	fireHeatwaveWave(packet) {
		var game = packet.context;
		var gb = game.gameBoard;
		var sel = gb.pendingHeatwaveWave;
		gb.pendingHeatwaveWave = null;
		if (sel == null || gb.currentMap !== packet.map || gb.currentMap == null) { return; }
		if (game.currentState != c.stateMap.racing && game.currentState != c.stateMap.collapsing) { return; }
		var cells = gb.currentMap.cells;
		// Drop picks whose ground changed since the warn — flipping those would
		// stomp a collapse/swap/cannon result the players already saw.
		var fresh = { newIds: {}, fromIds: {}, count: 0 };
		for (var i = 0; i < cells.length; i++) {
			var vid = cells[i].site.voronoiId;
			if (sel.newIds[vid] != null && cells[i].id == sel.fromIds[vid]) {
				fresh.newIds[vid] = sel.newIds[vid];
				fresh.fromIds[vid] = sel.fromIds[vid];
				fresh.count++;
			}
		}
		if (fresh.count === 0) { return; }
		var applied = gb.commitHeatwaveChanges(fresh);
		// Re-check the path guarantee on the live map (the warn-time validation can
		// be stale if something added lava since): if blocked, melt this wave's lava
		// back to sand — water/dirt/ability conversions can't block, so they stay.
		if (!gb.heatwavePathOk()) {
			var lavaId = c.tileMap.lava.id, sandId = c.tileMap.slow.id;
			for (var ci = 0; ci < cells.length; ci++) {
				var cvid = cells[ci].site.voronoiId;
				if (applied[cvid] == lavaId) {
					cells[ci].id = sandId;
					gb.tileChanges[cvid] = sandId;
					delete applied[cvid];
					delete gb.heatwaveScorchedIds[cvid];
				}
			}
			if (Object.keys(applied).length === 0) { return; }
		}
		messenger.messageRoomBySig(gb.roomSig, "tileChanges", JSON.stringify(applied));
		messenger.messageRoomBySig(gb.roomSig, "heatwaveWaveFired", JSON.stringify({ ids: Object.keys(applied) }));
		// Fold the wave into the stored newMap payload so a late joiner's scorch
		// list (read from payload.heatwave) covers both waves.
		if (gb.newMapPayload != null) {
			if (gb.newMapPayload.heatwave == null) { gb.newMapPayload.heatwave = { changes: {} }; }
			for (var av in applied) { gb.newMapPayload.heatwave.changes[av] = applied[av]; }
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
		// Balanced alternating split: with two gates (opposite-edge maps), even
		// spawn-order players go to gate 0 and odd to gate 1, so neither edge is
		// stacked. Single-gate maps put everyone at gate 0.
		var i = 0;
		var gateCount = this.startingGates.length || 1;
		for (var playerID in this.playerList) {
			this.gatePlayer(this.playerList[playerID], i % gateCount);
			i++;
		}
	}
	// Pick the gate currently holding the fewest players, so mid-sequence joins
	// (the AI grid fill happens AFTER gatePlayers, and late human joins arrive via
	// determineGameState) keep opposite-edge maps balanced. `exclude` skips the
	// player being placed so it doesn't count its own stale default gate.
	leastPopulatedGateIndex(exclude) {
		var counts = [];
		for (var i = 0; i < this.startingGates.length; i++) { counts.push(0); }
		for (var pid in this.playerList) {
			if (this.playerList[pid] === exclude) { continue; }
			var gi = this.playerList[pid].gateIndex || 0;
			if (gi >= 0 && gi < counts.length) { counts[gi]++; }
		}
		var best = 0;
		for (var k = 1; k < counts.length; k++) { if (counts[k] < counts[best]) { best = k; } }
		return best;
	}
	gatePlayer(player, gateIndex) {
		// Firewalker per-round state: share the heatwave scorched-tile set by
		// reference (null outside heatwave rounds) and re-arm the clean-run latch.
		// gatePlayer runs for every racer each round — setup, AI grid fill, and
		// late joins alike — so this is the one reset point that covers them all.
		player.heatwaveScorchedIds = this.heatwaveScorchedIds;
		player.touchedScorchedTile = false;
		player.firewalkerJudged = false;
		// Editor preview with a pinned start gate: humans always spawn at the chosen
		// edge (every round, and on couch co-op joins), overriding the round-robin /
		// least-populated placement. Bots keep normal placement so both sides race.
		if (this.isPreview && this.previewStartEdge != null && player != null && !player.isAI) {
			for (var pg = 0; pg < this.startingGates.length; pg++) {
				if (this.startingGates[pg].edge === this.previewStartEdge) { gateIndex = pg; break; }
			}
		}
		if (gateIndex == null) { gateIndex = this.leastPopulatedGateIndex(player); }
		if (gateIndex < 0 || gateIndex >= this.startingGates.length) { gateIndex = 0; }
		player.gateIndex = gateIndex;
		var gate = this.startingGates[gateIndex];
		if (gate == null) { return; } // no gate built yet (shouldn't happen post-setupMap)
		var loc = gate.findFreeLoc(player);
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
	// Drop every entity owned by a player who is leaving the room, so the per-tick
	// update loops and the compressor stop touching ghosts whose owner is no longer
	// in playerList (an owner-deref like the SwapAimer construction in checkAbilities
	// would otherwise read `undefined`). aimerList / abilityList / tempSpectatorList
	// are keyed by owner id; projectileList is mixed-keyed (bombs/snowflakes by owner
	// id, but brutal-round clouds by hash and the hockey puck by roomSig), so
	// projectiles are matched on ownerId rather than key — which leaves the
	// clouds/puck (owned by a hash/roomSig, never a client id) correctly untouched.
	//
	// Clients build their own projectileList/aimerList from spawn events and only
	// prune them on terminateProj/terminateAimer (gameUpdates never removes missing
	// entries), so emit the matching terminate BEFORE the server-side delete or the
	// ghost stays rendered until the next reset. Both lists are keyed client-side by
	// ownerId, which for a player-owned entity equals the leaving id. (The player's
	// ability indicator hangs off playerList[id].ability and is already cleared by
	// the playerLeft handler.)
	removeOwnedEntities(clientID) {
		var aimer = this.aimerList[clientID];
		if (aimer != null) {
			// SwapAimer arms a setInterval (this.index); clear it so the orphaned
			// aimer doesn't keep a live closure (and itself) alive after we drop it.
			if (aimer.index != null) {
				clearInterval(aimer.index);
			}
			messenger.messageRoomBySig(this.roomSig, "terminateAimer", clientID);
			delete this.aimerList[clientID];
		}
		delete this.abilityList[clientID];
		delete this.tempSpectatorList[clientID];
		for (var projID in this.projectileList) {
			if (this.projectileList[projID].ownerId == clientID) {
				messenger.messageRoomBySig(this.roomSig, "terminateProj", projID);
				delete this.projectileList[projID];
			}
		}
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
		// The round reset turns every temp spectator into an active racer, so the
		// cohort is spent — drop the references. Otherwise a late joiner who left
		// before the reset would linger here for the room's lifetime and get
		// re-touched (a stale-object write) every round.
		this.tempSpectatorList = {};
	}
	clean() {
		this.lobbyStartButton = null;
		this.collapseLoc = {};
		this.collapseLine = this.world.height + 400;
		this.soloMode = false;
		this.soloCollapseSpeed = c.lastPlayerCollapseSpeed;
		this.soloStartDistance = this.world.height + 400;
		this.tileChanges = {};
		this.pendingBeams = {}; // drop any telegraph whose strike timer this reset cancels
		this.pendingAbilityTimers = []; // bound growth; lobby ones are canceled in clearLobbyAbilities
		// AI vision-fairness state, reset each round.
		this.visionBlockedUntil = 0;
		this.blackoutActive = false;
		// Bunker (battle-royale) brutal state, reset each round.
		this.goalBuried = false;
		this.bunkerRingActive = false;
		this.bunkerLoc = null;
		this.bunkerArenaRadius = 0;
		this.bunkerSafeIds = {};
		this.bunkerLidIds = [];
		this.bunkerStartTime = null;
		// Heatwave brutal state, reset each round.
		this.heatwaveScorchedIds = null;
		this.pendingHeatwaveWave = null;
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
		// Wildcard playlist (e.g. "Default"): roll each round so the FREQUENCY of
		// featured vs community maps is ~ (1 - wildcardChance) : wildcardChance,
		// not just their order — the per-tier no-repeat cycles run independently
		// (see pickNoRepeatFrom), so a 20% community chance stays ~20% no matter
		// how many community maps exist.
		var def = this.activePlaylistDef();
		var wc = (def && typeof def.wildcardChance === "number") ? def.wildcardChance : 0;
		if (wc > 0) {
			var pool = this.getEligibleMapIndices();
			var feat = [], comm = [];
			for (var wi = 0; wi < pool.length; wi++) {
				var wmeta = this.maps[pool[wi]].meta;
				if (wmeta && wmeta.tier === "featured") { feat.push(pool[wi]); } else { comm.push(pool[wi]); }
			}
			var tierPool;
			if (feat.length && comm.length) {
				tierPool = (Math.random() < wc) ? comm : feat;
			} else {
				tierPool = feat.length ? feat : comm;
			}
			var wid = this.pickNoRepeatFrom(tierPool);
			this.nextMap = JSON.parse(JSON.stringify(this.maps[wid]));
			return this.nextMap.id;
		}
		// Draw only from the active playlist's eligible maps, keeping the
		// no-repeat-until-exhausted behaviour but scoped to that pool. Reset the
		// played set once every eligible map has been seen.
		var eligible = this.getEligibleMapIndices();
		var lastId = this.mapsPlayed.length ? this.mapsPlayed[this.mapsPlayed.length - 1] : null;
		var unplayed = [];
		for (var ei = 0; ei < eligible.length; ei++) {
			if (this.mapsPlayed.indexOf(this.maps[eligible[ei]].id) === -1) {
				unplayed.push(eligible[ei]);
			}
		}
		if (unplayed.length === 0) {
			// Pool exhausted — start a fresh cycle, but keep the just-played map out of
			// the first pick so the wrap never produces a back-to-back repeat (unless the
			// pool is a single map, where a repeat is unavoidable).
			this.mapsPlayed = [];
			unplayed = [];
			for (var fi = 0; fi < eligible.length; fi++) {
				if (this.maps[eligible[fi]].id !== lastId) { unplayed.push(eligible[fi]); }
			}
			if (unplayed.length === 0) { unplayed = eligible; }
		}
		var nextMapId = this.pickByDifficultyWeight(unplayed);
		this.nextMap = JSON.parse(JSON.stringify(this.maps[nextMapId]));
		return this.nextMap.id;
	}

	// Match phase for the difficulty ramp. "late" the moment ANY player sits at
	// match point (the same player.nearVictory flag the brutal-round boost in
	// checkForBrutalRound reads — teams mode mirrors it onto every member, so a
	// team at match point also reads late). "early" while the UPCOMING round
	// number is within difficultyRamp.earlyRounds (this.round is the count of
	// rounds already loaded — loadNextMap increments after the draw). Otherwise
	// "mid", which is also the answer whenever the ramp is disabled.
	difficultyPhase() {
		var ramp = c.difficultyRamp;
		if (ramp == null || ramp.enabled === false) { return "mid"; }
		for (var id in this.playerList) {
			if (this.playerList[id] != null && this.playerList[id].nearVictory === true) { return "late"; }
		}
		var earlyRounds = (typeof ramp.earlyRounds === "number") ? ramp.earlyRounds : 2;
		if (this.round < earlyRounds) { return "early"; }
		return "mid";
	}

	// Weighted draw over `unplayed` map indices, biasing by each map's
	// meta.difficulty tier per the current phase's difficultyRamp.weights row.
	// A bias, not a bucket: a map missing meta/difficulty (or a tier missing
	// from the weights row) reads weight 1, and an all-zero pool — e.g. a
	// brutal-only playlist in the early phase, or a single brutal map — falls
	// back to a uniform draw so the pick can never come up empty. No-repeat
	// cycling is untouched: callers compute `unplayed` exactly as before and
	// this only replaces the final uniform pick.
	pickByDifficultyWeight(unplayed) {
		// Drawn lazily so the fallback only consumes RNG state when actually taken
		// (keeps seeded harnesses byte-identical to a plain uniform draw when the
		// ramp is off).
		var uniform = function () { return unplayed[utils.getRandomInt(0, unplayed.length - 1)]; };
		var ramp = c.difficultyRamp;
		if (ramp == null || ramp.enabled === false || ramp.weights == null) { return uniform(); }
		var row = ramp.weights[this.difficultyPhase()];
		if (row == null) { return uniform(); }
		var weights = [];
		var total = 0;
		for (var i = 0; i < unplayed.length; i++) {
			var meta = this.maps[unplayed[i]].meta;
			var tier = meta && meta.difficulty;
			var w = (tier != null && typeof row[tier] === "number" && row[tier] >= 0) ? row[tier] : 1;
			weights.push(w);
			total += w;
		}
		if (total <= 0) { return uniform(); }
		var roll = Math.random() * total;
		for (var j = 0; j < unplayed.length; j++) {
			roll -= weights[j];
			if (roll < 0) { return unplayed[j]; }
		}
		return unplayed[unplayed.length - 1];
	}

	// Indices into this.maps eligible for the room's current playlist. A map is
	// eligible if its classifier meta lists the playlist id. "all" (or an
	// unset/unknown playlist) means the whole pool. A playlist resolving to
	// fewer than 2 maps — too thin for no-repeat rotation, or maps missing meta
	// — falls back to the full pool so the rotation never deadlocks or starves.
	getEligibleMapIndices() {
		var all = [];
		for (var i = 0; i < this.maps.length; i++) { all.push(i); }
		var pid = this.playlistId;
		if (!pid || pid === "all") { return all; }
		var elig = [];
		for (var j = 0; j < this.maps.length; j++) {
			var meta = this.maps[j].meta;
			if (meta && Array.isArray(meta.playlists) && meta.playlists.indexOf(pid) !== -1) {
				elig.push(j);
			}
		}
		return (elig.length < 2) ? all : elig;
	}

	// The config def for the room's active playlist (null if unknown).
	activePlaylistDef() {
		var defs = c.playlists || [];
		for (var i = 0; i < defs.length; i++) {
			if (defs[i] && defs[i].id === this.playlistId) { return defs[i]; }
		}
		return null;
	}

	// Pick a map index from `pool` honouring no-repeat-until-exhausted, scoped to
	// that pool. Used by the wildcard draw so each tier (featured / community)
	// cycles independently: when this pool is exhausted we forget only ITS plays
	// from mapsPlayed, leaving the other tier's progress intact, and keep the
	// just-played map out of the wrap so there's no back-to-back repeat.
	pickNoRepeatFrom(pool) {
		var lastId = this.mapsPlayed.length ? this.mapsPlayed[this.mapsPlayed.length - 1] : null;
		var unplayed = [];
		for (var i = 0; i < pool.length; i++) {
			if (this.mapsPlayed.indexOf(this.maps[pool[i]].id) === -1) { unplayed.push(pool[i]); }
		}
		if (unplayed.length === 0) {
			var poolIds = {};
			for (var p = 0; p < pool.length; p++) { poolIds[this.maps[pool[p]].id] = true; }
			this.mapsPlayed = this.mapsPlayed.filter(function (id) { return !poolIds[id]; });
			for (var f = 0; f < pool.length; f++) {
				if (this.maps[pool[f]].id !== lastId) { unplayed.push(pool[f]); }
			}
			if (unplayed.length === 0) { unplayed = pool.slice(); }
		}
		return this.pickByDifficultyWeight(unplayed);
	}

	// Set the room's active playlist (from the lobby hub board). Validates the id
	// against the configured playlists, resets the played set so the new playlist
	// starts fresh, and reports whether it actually changed. Last-writer-wins.
	setPlaylist(playlistId) {
		var defs = c.playlists || [];
		var known = defs.some(function (p) { return p && p.id === playlistId; });
		if (!known || playlistId === this.playlistId) { return false; }
		this.playlistId = playlistId;
		this.mapsPlayed = [];
		return true;
	}

	// The active mode's config entry (from c.gameModes), or null if the id is
	// somehow unknown — callers treat null as Standard FFA (no flags).
	gameModeDef() {
		var defs = c.gameModes || [];
		for (var i = 0; i < defs.length; i++) {
			if (defs[i] && defs[i].id === this.gameModeId) { return defs[i]; }
		}
		return null;
	}
	// True when the room's mode guarantees a brutal round every round (brutal_ffa /
	// brutal_teams). Only the GUARANTEE comes from the mode — the type pick and the
	// additional-brutal stacking rolls in checkForBrutalRound stay exactly as in
	// standard play.
	isBrutalMode() {
		var def = this.gameModeDef();
		return def != null && def.brutal === true;
	}
	// True when the room's mode plays in teams (standard_teams / brutal_teams):
	// Crimson vs Jade, shared POINTS score (personal notches still run as in FFA),
	// teammate punches are no-ops.
	isTeamsMode() {
		var def = this.gameModeDef();
		return def != null && def.teams === true;
	}
	// Set the room's game mode (from the lobby hub mode station). Validates the id
	// against the ACTIVE configured modes and reports whether it actually changed.
	// Last-writer-wins, like setPlaylist.
	setGameMode(modeId) {
		var defs = c.gameModes || [];
		var known = defs.some(function (m) { return m && m.id === modeId && m.active === true; });
		if (!known || modeId === this.gameModeId) { return false; }
		this.gameModeId = modeId;
		return true;
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
		var abilityGen = this.generateAbilities();
		// Heatwave mutates cells AFTER random tiles resolve (so a random-rolled sand/
		// ice tile is eligible) and after ability generation (its dirt->ability tiles
		// are a bonus on top, never subject to the chanceToSpawnAbility roll). Riding
		// in the newMap payload means joiners always get the scorch list with the map.
		var heatwaveGen = this.applyBrutalHeatwaveRound();
		this.newMapPayload = { id: this.currentMap.id, abilities: abilityGen, round: this.round, randomTiles: randomGen, brutalRoundConfig: this.brutalConfig, hazards: compressor.newHazards(this.hazardList), heatwave: heatwaveGen, currentState: currentState };
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
				case c.brutalRounds.bunker.id: {
					this.applyBrutalBunkerRound();
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
			// Test override (config.forceAbilitySpawn / FORCE_ABILITY_SPAWN env, prod-disabled):
			// the brutal Ability round also hands everyone the forced ability when set.
			var abilityID = (c.forceAbilitySpawn != null)
				? c.forceAbilitySpawn
				: abilitiesToGet[utils.getRandomInt(0, abilitiesToGet.length - 1)];
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
				case c.tileMap.abilities.starPower.id: {
					player.ability = new StarPower(player.id, this.roomSig);
					player.acquiredAbility = { mapID: null };
					break;
				}
				case c.tileMap.abilities.orbitalBeam.id: {
					player.ability = new OrbitalBeam(player.id, this.roomSig);
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
	checkForBrutalRound() {
		var brutalRoundConfig = { brutal: false, brutalTypes: [] };
		this.brutalRound = false;
		if (debug.forceBlackout) {
			this.brutalRound = true;
			return { brutal: true, brutalTypes: [c.brutalRounds.blackout.id] };
		}
		// CI perf harness only: pin the exact brutal set so the base and PR halves
		// of the render-perf gate measure an IDENTICAL scene (otherwise the unseeded
		// shuffle below hands each half a different brutal combo with different FX
		// cost, which the gate misreads as a regression). `brutalTypesForce` only
		// exists when injected via the CHAO_PERF_OVERRIDE seam — never in prod, and
		// not present in config.json — so normal play is unaffected.
		if (Array.isArray(c.brutalTypesForce) && c.brutalTypesForce.length > 0) {
			this.brutalRound = true;
			return { brutal: true, brutalTypes: c.brutalTypesForce.slice() };
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
		//No brutal round. A brutal MODE (brutal_ffa / brutal_teams) guarantees the
		//floor — every round is brutal — but changes nothing past this gate: the
		//type pick, the additional-brutal stacking rolls, and bunker exclusivity
		//all run exactly as in a standard game.
		if (brutalChance > this.chanceOfBrutalRound && !this.isBrutalMode()) {
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

		// Heatwave needs raw material to scorch: on maps with too little sand/ice
		// (the dramatic lava/water conversions) the round would land as a dud, so
		// pull it from this round's pool instead of letting the shuffle pick it.
		var hw = c.brutalRounds.heatwave;
		if (hw != null && activeBrutalTypes.indexOf(hw.id) != -1 &&
			this.countHeatwaveConvertibles() < hw.minConvertibleTiles) {
			activeBrutalTypes.splice(activeBrutalTypes.indexOf(hw.id), 1);
		}

		if (activeBrutalTypes.length == 0) {
			//console.log("Brutal round was engaged, however no brutal types are active in the config file");
			this.brutalRound = false;
			brutalRoundConfig = { brutal: false, brutalTypes: [] };
			return brutalRoundConfig;
		}
		activeBrutalTypes = utils.shuffleArray(activeBrutalTypes);
		brutalRoundConfig.brutalTypes.push(activeBrutalTypes[0]);
		// Bunker (battle royale) reshapes the whole arena with its own closing ring
		// and buried goal — it must never combine with another collapse/hazard mode,
		// so when it's the primary pick it runs solo.
		if (activeBrutalTypes[0] == c.brutalRounds.bunker.id) {
			return brutalRoundConfig;
		}
		if (activeBrutalTypes.length == 1) {
			return brutalRoundConfig;
		}
		activeBrutalTypes.splice(0, 1);
		for (var i = 0; i < activeBrutalTypes.length; i++) {

			if (brutalRoundConfig.brutalTypes.length == c.maxTotalBrutals) {
				return brutalRoundConfig;
			}
			// Bunker only ever runs as a solo primary, never bolted onto another mode.
			if (activeBrutalTypes[i] == c.brutalRounds.bunker.id) { continue; }
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
		// Test override (config.forceAbilitySpawn / FORCE_ABILITY_SPAWN env, prod-disabled):
		// every ability pad yields this id so a new ability can be playtested on demand.
		if (c.forceAbilitySpawn != null) {
			return c.forceAbilitySpawn;
		}
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

module.exports = { GameBoard };
