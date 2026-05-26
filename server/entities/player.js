'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();
var messenger = require('../messenger.js');
var compressor = require('../compressor.js');
var debug = require('../debug.js');
var _engine = require('../engine.js');
var { emitBotEmote } = require('../botEmotes.js');
var { Circle } = require('./shapes.js');
var { Punch } = require('./punch.js');
var { Blindfold, Swap, Bomb, SpeedBuff, SpeedDebuff, TileSwap, IceCannon, Cut } = require('./abilities.js');

// Ability pickup tiles -> their ability class, so handleHit can acquire any of
// them through one path (tryAcquireAbility) instead of eight identical branches.
var ABILITY_TILE_CTORS = {};
ABILITY_TILE_CTORS[c.tileMap.abilities.blindfold.id] = Blindfold;
ABILITY_TILE_CTORS[c.tileMap.abilities.swap.id] = Swap;
ABILITY_TILE_CTORS[c.tileMap.abilities.bomb.id] = Bomb;
ABILITY_TILE_CTORS[c.tileMap.abilities.speedBuff.id] = SpeedBuff;
ABILITY_TILE_CTORS[c.tileMap.abilities.speedDebuff.id] = SpeedDebuff;
ABILITY_TILE_CTORS[c.tileMap.abilities.tileSwap.id] = TileSwap;
ABILITY_TILE_CTORS[c.tileMap.abilities.iceCannon.id] = IceCannon;
ABILITY_TILE_CTORS[c.tileMap.abilities.cut.id] = Cut;

class LobbyStartButton extends Circle {
	constructor(x, y, angle, color) {
		super(x, y, 75, color);
		this.isLobbyStart = true;
	}
	handleHit(object) {

	}
}

// SPIKE: a walk-up lobby "hub" zone. Like LobbyStartButton it is a server-placed
// Circle that joins the lobby collision set, but instead of a momentary "on it"
// flag it feeds per-player ENTER/EXIT detection (see GameBoard.updateStationProximity).
// `kind` selects the station's behaviour ("skin" = per-player, "ai" = room-wide).
class LobbyStation extends Circle {
	constructor(x, y, radius, id, kind, color) {
		super(x, y, radius, color);
		this.isStation = true;
		this.stationId = id;
		this.stationKind = kind;
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
		// SPIKE (lobby hub): touchingStation is set every tick a station is overlapped
		// (reset after the proximity diff); nearStation latches the station the player
		// is currently INSIDE, so enter/exit edges can be derived. See game.js.
		this.touchingStation = null;
		this.nearStation = null;
		this.reachedGoal = false;
		this.timeReached = null;
		this.collapseMargin = null; // distance to the lava front while collapsing (for clutch-goal cheer)
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
		// Persistent attributor for a *delayed* burn-on-lava death. punchedBy expires
		// after c.playerKillWindow, but a killstreak fire shield can keep a victim
		// burning on lava well past that window before they actually die — so we latch
		// the attacker who shoved a still-attributed victim into the doom here, and at the
		// actual lava burn-out death fold it back into punchedBy (handleMapCellHit). It is
		// consumed ONLY by that lava death; cleared the moment the victim escapes — onto
		// terrain (handleMapCellHit) or off every cell (resetGrip) — and on any death, so
		// no later/unrelated death is ever credited to the old attacker.
		this.burnedBy = null;

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

		//Lobby tutorial (no scoring). invulnUntil: timestamp grace window after a
		//lobby respawn; onSanctuary: standing on a transparent "background" cell
		//(neutral/immutable ground); lobbyRespawnPending: 'death' | 'goal' flagged by
		//handleHit and consumed by GameBoard.updatePlayers (deferred like ability picks).
		this.invulnUntil = 0;
		this.invulnHeldInCircle = false;
		this.onSanctuary = false;
		this.lobbyRespawnPending = null;

		//Achievements
		this.savior = 0;
		this.totalKills = 0;
		this.brutalist = 0;
		this.survivalist = 0;
		this.resourceful = 0;
		this.bully = 0;

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

		//AI (set on bot players by world.createNewBot; humans leave these untouched)
		this.isAI = false;
		this.name = null;
		this.title = null;
		this.personality = null;
		this.profile = null;
		this.emoteReadyAt = 0;
		//Steering outputs the engine's isAI branch reads each tick.
		this.targetDirX = 0;
		this.targetDirY = 0;
		this.braking = false;
		//Scratch space for the bot brain (aiController) — path cache, timers, etc.
		this.ai = null;
	}
	update(currentState, dt, punchDirectional) {
		this.currentState = currentState;
		// Bots have no socket and never AFK — the sleep/kick path ends in
		// messageClientBySig (Room.checkAFK), which would throw on a socketless
		// bot. Skip it entirely; bots stay awake for their whole life.
		if (!this.isAI) {
			this.checkForSleep(currentState);
		}
		if (this.alive == false) {
			return;
		}
		this.dt = dt;
		this.move();
		this.checkAttack(currentState, punchDirectional);
		this.checkChatCoolDownTimer();
		this.checkFireTimer();
	}
	move() {
		this.x = this.newX;
		this.y = this.newY;
	}
	checkAttack(currentState, punchDirectional) {
		if (this.attack) {
			if ((currentState == c.stateMap.racing || currentState == c.stateMap.collapsing || currentState == c.stateMap.lobby) && this.ability != null) {
				this.punchedTimer = Date.now();
				// No scoring in the lobby: firing an ability there must not tick the
				// resourceful achievement stat (it isn't gated by checkForWinners). The
				// curated lobby ability set is enforced by the map's tiles (bomb only),
				// not here — swap/blindfold/tileSwap simply aren't placed to pick up.
				if (currentState != c.stateMap.lobby) {
					this.resourceful += 1;
				}
				this.ability.use();
				// Clear the attack input so using an ability doesn't bleed into the
				// next tick. Otherwise, once checkAbilities() nulls out the consumed
				// ability, the still-true attack flag would trigger the punch
				// slow-down in the engine (and throw a stray punch), stopping movement.
				this.attack = false;
				return;
			}
			// Punching is only meaningful during active play: the race itself
			// (racing/collapsing), the pre-race gate where players jostle at the start
			// (gated), and the lobby tutorial. In the non-play screens — the overview
			// "next map" screen, waiting, and gameOver — swallow the input so no punch
			// (and no punch sound, which the client only plays on the server's "punch"
			// event) is thrown.
			if (currentState != c.stateMap.racing && currentState != c.stateMap.collapsing && currentState != c.stateMap.lobby && currentState != c.stateMap.gated) {
				this.attack = false;
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
			// Directional punch: place the hitbox in front of the player along its
			// facing angle so you have to aim, and the radial knockback shoves the
			// target forward. The decision (per round/mode) is resolved in
			// GameBoard.updatePlayers and passed in. (Bumper/hazard punches are
			// created elsewhere and stay centered/radial.)
			var directional = punchDirectional === undefined ? c.directionalPunch : punchDirectional;
			var punchX = this.x;
			var punchY = this.y;
			if (directional) {
				var aim = utils.pos({ x: this.x, y: this.y }, c.punchReach, this.angle);
				punchX = aim.x;
				punchY = aim.y;
			}
			this.punch = new Punch(punchX, punchY, punchRadius, this.color, this.id, this.roomSig, 1, this.isZombie);
			this.punch.directional = directional;
			// No scoring in the lobby: punches still land (knockback feel) but must not
			// tick the bully achievement stat, which isn't gated by checkForWinners.
			if (currentState != c.stateMap.lobby) {
				this.bully += 1;
			}
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
	// Lobby-only protection.
	// isTimedInvuln(): inside the timed post-respawn grace window.
	// isInvuln(): timed grace OR "held" — parked in the start circle keeps it alive
	//   (set by GameBoard.updateLobbyInvulnHold) so a griefed player can die, walk to
	//   the center, and stand there safely until the game starts. During invuln,
	//   lava/goal do nothing and knockback (cut/explosion/punch/bumper) is ignored.
	// isProtected(): invuln OR standing on sanctuary (background) ground.
	isTimedInvuln() {
		return this.invulnUntil != 0 && Date.now() < this.invulnUntil;
	}
	isInvuln() {
		return this.isTimedInvuln() || this.invulnHeldInCircle;
	}
	isProtected() {
		return this.isInvuln() || this.onSanctuary;
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
		emitBotEmote(this, "kill");
		this.addFire(c.playerKillFireBonus);
		if (player.fellFromVictory) {
			this.savior += 1;
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
				debug.log("checkAFK: kicking player id=", this.id, " from state=", currentState, " (awake AFK)");
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
			debug.log("checkAFK: kicking player id=", this.id, " from state=", currentState, " (kickTimer expired)");
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
	// Restore normal ground grip (accel/drag/brake). Called when a player is off every
	// map cell — e.g. shoved back behind the starting gate, a region with no terrain
	// tile to stamp physics. Without this, the last tile they touched (ice in particular)
	// keeps them sliding there until they step back onto real terrain. Zombies keep their
	// infection handicap, measured against normal ground.
	resetGrip() {
		// Being off every map cell is also an escape from a burn-on-lava doom (e.g.
		// shoved off the terrain edge / behind the gate while burning). This is the
		// one escape path that bypasses handleMapCellHit, so clear the persistent burn
		// attributor here too, mirroring the non-lava-cell clear in handleMapCellHit.
		this.burnedBy = null;
		if (this.isZombie == true) {
			this.acel = c.playerBaseAcel * c.brutalRounds.infection.acelModifer;
			this.dragCoeff = c.playerDragCoeff * c.brutalRounds.infection.dragModifer;
			this.brakeCoeff = c.playerBrakeCoeff * c.brutalRounds.infection.brakeModifer;
			return;
		}
		this.acel = c.playerBaseAcel;
		this.dragCoeff = c.playerDragCoeff;
		this.brakeCoeff = c.playerBrakeCoeff;
	}
	handleHit(object) {
		if (object.isLobbyStart) {
			this.hittingLobbyButton = true;
			return;
		}
		if (object.isStation) {
			// Record overlap this tick; the enter/exit edge is derived once per tick in
			// GameBoard.updateStationProximity. First-overlap wins (don't overwrite) so a
			// player straddling two authored, overlapping zones latches one stably
			// instead of flickering between whichever the QuadTree visited last.
			if (this.touchingStation == null) {
				this.touchingStation = object.stationId;
			}
			return;
		}
		if (object.isPunch && object.ownerId != this.id) {
			this.handlePunchHit(object);
			return;
		}
		if (object.isPuck) {
			this.handlePuckHit(object);
			return;
		}
		if (object.isGate) {
			this.killSelf();
			return;
		}
		if (object.isMapCell) {
			this.handleMapCellHit(object);
		}
	}
	handlePunchHit(object) {
		// Invulnerable lobby players (freshly respawned, or held safe in the start
		// circle) can't be punched — so a griefer can't shove them into lava or out
		// of the safe circle. Normal players still bump freely. No-op outside lobby.
		if (this.isInvuln()) {
			return;
		}
		if (object.ownerInfected) {
			this.infect();
		}
		if (!object.mapOwned) {
			this.setPunchedBy(object.ownerId);
		}
		_engine.punchPlayer(this, object);
		messenger.messageRoomBySig(this.roomSig, "playerPunched", { owner: object.ownerId, victim: this.id, x: this.x, y: this.y });
		emitBotEmote(this, "hurt"); // an AI racer reacts to getting knocked
		return;
	}
	handlePuckHit(object) {
		if (this.isInvuln()) {
			return;
		}
		_engine.puckPlayer(object, this);
		messenger.messageRoomBySig(this.roomSig, "playerPunched", { owner: object.ownerId, victim: this.id, x: this.x, y: this.y });
		return;
	}
	// Apply the terrain/lava/goal effect of the cell the player is on; if it wasn't
	// a terrain tile, fall through to ability-tile pickup.
	handleMapCellHit(object) {
		// Track sanctuary ground (the transparent background type) for the
		// force-shield in isProtected(). A player only "is on" the one cell this
		// hit reports, so this reflects their current footing every tick.
		this.onSanctuary = (object.id == c.tileMap.background.id);
		// Standing on any non-lava cell means we've escaped a burn-on-lava doom: drop
		// the persistent burn attributor so a later, unrelated lava death isn't credited
		// to whoever last shoved us. A burning death is itself a lava hit (id == lava),
		// so the attributor survives right up to the killSelf below.
		if (object.id != c.tileMap.lava.id) {
			this.burnedBy = null;
		}
		if (object.id == c.tileMap.background.id) {
			// Transparent lobby "background" / sanctuary ground: behaves as normal
			// terrain. Applying normal grip here is what resets a player's physics
			// when they step off an island onto background.
			if (this.isZombie == true) {
				this.applyInfectedMods(object);
				return;
			}
			this.acel = object.acel;
			this.brakeCoeff = object.brakeCoeff;
			this.dragCoeff = object.dragCoeff;
			return;
		}
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
			if (this.currentState == c.stateMap.lobby) {
				// Lobby lava is a teaching prop: cosmetic death + safe respawn, never
				// the real kill path (no killPlayer/removeNotch). Invuln players in
				// their post-respawn grace window are immune.
				if (this.isInvuln()) {
					return;
				}
				this.lobbyRespawnPending = "death";
				return;
			}
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
				// Latch the attacker who shoved us in while we're still attributed, so the
				// credit survives even if the burn outlasts playerKillWindow. Refreshed
				// each burning tick while punchedBy is live; once it expires, burnedBy keeps
				// the last attacker. A self-inflicted burn (no attacker) leaves it null, so
				// driving yourself into lava while on fire stays uncredited.
				if (this.punchedBy != null) {
					this.burnedBy = this.punchedBy;
				}
				this.checkFireTimer();
				return;
			}
			// onFire == 0 here: this *is* the lava death (a fresh instant lava death, or
			// the killstreak burn finally running out). If the kill window expired while
			// we burned, hand the latched attributor back to the normal punchedBy ->
			// murderedBy path. Doing it here, gated on an actual lava death, means only a
			// burn-out death consumes burnedBy — gate / infection-timer / AFK / bomb
			// deaths can never inherit a stale burn attributor.
			if (this.punchedBy == null && this.burnedBy != null) {
				this.punchedBy = this.burnedBy;
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
			if (this.currentState == c.stateMap.lobby) {
				// Lobby goal teaches the win condition: play the win cue + respawn,
				// but never conclude/score (no reachedGoal/timeReached/playerConcluded/
				// addNotch). Invuln players in their grace window are ignored.
				if (this.isInvuln()) {
					return;
				}
				this.lobbyRespawnPending = "goal";
				return;
			}
			if (this.isZombie == true) {
				this.acel = object.acel;
				this.brakeCoeff = object.brakeCoeff;
				this.dragCoeff = object.dragCoeff;
				return;
			}
			this.alive = false;
			this.reachedGoal = true;
			this.timeReached = Date.now();
			// "clutch" = beat the lava to the goal: only when the lava front was
			// genuinely close (collapseMargin stamped each collapsing tick), so an
			// uncontested slow-collapse stroll-in doesn't trigger the big eruption.
			var clutch = this.collapseMargin != null && this.collapseMargin < c.audienceClutchMargin;
			messenger.messageRoomBySig(this.roomSig, "playerConcluded", { id: this.id, clutch: clutch });
			return;
		}
		this.tryAcquireAbility(object);
	}
	// Pick up an ability tile. Returns true if `object` was an ability tile (so the
	// caller stops here), whether or not it was actually acquired — already holding
	// an ability, or being a zombie, blocks the pickup but still counts as handled.
	tryAcquireAbility(object) {
		var Ctor = ABILITY_TILE_CTORS[object.id];
		if (Ctor == null) {
			return false;
		}
		if (this.ability != null || this.isZombie) {
			return true;
		}
		this.ability = new Ctor(this.id, this.roomSig);
		this.acquiredAbility = { mapID: object.voronoiId };
		messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: object.id, voronoiId: object.voronoiId });
		return true;
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
		// Drop any latched burn attributor on every death. A genuine burn-out death
		// already folded it into punchedBy above (see handleMapCellHit's lava branch);
		// any other death (gate / infection / AFK / bomb) must NOT inherit it.
		packet.burnedBy = null;
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
		// "killed" marks a player-caused death (punched/cut/blown into oblivion or
		// the lava) versus an environmental/self death, so the crowd only cheers
		// kills — not someone driving themselves into the lava.
		messenger.messageRoomBySig(packet.roomSig, "playerDied", { id: packet.id, killed: packet.murderedBy != null });
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
		// Drop any stale AI path from the previous round so the bot re-paths fresh
		// on the new map instead of steering toward old-map coordinates. Identity,
		// personality knobs and the emote cooldown live on the Player/profile and
		// are intentionally preserved.
		if (this.ai != null) { this.ai.waypoints = null; this.ai.repathTimer = 0; }
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
		this.collapseMargin = null;
		this.punch = null;
		this.punchedBy = null;
		this.murderedBy = null;
		this.burnedBy = null;
		this.roundKills = 0;
		this.fellFromVictory = false;
		this.openMultiKillWindow = false;
		this.multiKillCount = 0;
		this.acquiredAbility = null;
		this.angle = 315;
		// Clear lobby-only state on every race (re)start so a lobby respawn's invuln
		// grace / sanctuary flag / pending-respawn can never bleed into a real round.
		this.invulnUntil = 0;
		this.invulnHeldInCircle = false;
		this.onSanctuary = false;
		this.lobbyRespawnPending = null;
		if (currentState == c.stateMap.gameOver) {
			this.survivalist = 0;
			this.brutalist = 0;
			this.resourceful = 0;
			this.bully = 0;
			this.ability = null;
			this.notches = 0;
			this.totalKills = 0;
			this.onFire = 0;
			this.savior = 0;
			this.killedPlayerList = [];
		}
	}
}

module.exports = { Player, LobbyStartButton, LobbyStation };
