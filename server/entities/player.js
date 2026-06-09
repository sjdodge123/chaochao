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
var { Blindfold, Swap, Bomb, SpeedBuff, SpeedDebuff, TileSwap, IceCannon, Cut, StarPower, OrbitalBeam } = require('./abilities.js');

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
ABILITY_TILE_CTORS[c.tileMap.abilities.starPower.id] = StarPower;
ABILITY_TILE_CTORS[c.tileMap.abilities.orbitalBeam.id] = OrbitalBeam;

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
		// Which starting gate this player is held in / launches from. Maps with
		// opposite-edge starts (e.g. left+right) split players across two gates;
		// single-edge maps keep everyone at gate 0.
		this.gateIndex = 0;
		this.reachedGoal = false;
		this.timeReached = null;
		this.eliminatedAt = null;
		// True once this player has been gated into a race (startRace); gates the
		// game-over map rating so only actual participants can vote.
		this.racedCurrentMap = false;
		// Set when the map-time leaderboard has already saved this finish (either
		// via publishMapLeaderboard at round-end or via the disconnect-flush in
		// Room.leave). Prevents a double upsert when both paths fire for the same
		// finish, and prevents a stale finish from re-uploading on re-spawn.
		this.pbWritten = false;
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
		// Latched press edge: a punch now fires on RELEASE, so a tap faster than a server
		// tick (keydown+keyup both arriving between ticks) would leave attack=false at
		// checkAttack and be lost. The movement handler sets this on a false->true edge so
		// checkAttack can still throw the tap. Cleared once consumed.
		this.attackQueued = false;
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
		// Punch stamina: punching drains it, it regenerates over time, and below the
		// cost you can't punch. staminaExhausted latches when a punch empties you, and
		// only clears once you've regenerated back up to exhaustRecover — that
		// hysteresis is what makes "getting tired" then "recovered" a distinct beat.
		this.stamina = c.punchStamina.max;
		this.staminaExhausted = false;
		// Hold-to-charge punch state. charging spans press->release; chargeFrac (0..1)
		// drives both the thrown punch's power and the telegraph fist art on the client.
		this.charging = false;
		this.chargeStartedAt = 0;
		this.chargeStaminaAtStart = 0;
		this.chargeFrac = 0;
		// Overcharge: holding way too long fills a dark-red danger meter (overcharge
		// 0..1) and, if you don't release in time, locks you in the exhausted move
		// penalty until exhaustLockUntil (regen is paused, so staminaExhausted stays set).
		this.overcharge = 0;
		this.exhaustLockUntil = 0;

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
		// Current footing is ice (stamped every tick alongside onSanctuary): gates the
		// drift-traction blend and the keepMomentumOnRelease playtest toggle.
		this.onIce = false;
		// Current footing is water (stamped every tick like onIce): gates the swim
		// impulse in throwChargedPunch and the fire-extinguish in handleMapCellHit.
		this.onWater = false;
		// "Dripping wet" exit slow: when a player leaves water this is set to
		// now + water.dripMs; while active, handleMapCellHit scales their drive by
		// water.dripMoveFactor so they trudge for a beat after climbing out.
		this.dripUntil = 0;

		//Star Power: timestamp until which the player is invulnerable to rival
		//abilities and punches (set by GameBoard.checkAbilities on use).
		this.starPowerUntil = 0;

		//Achievements
		this.savior = 0;
		this.totalKills = 0;
		this.brutalist = 0;
		this.survivalist = 0;
		this.resourceful = 0;
		this.bully = 0;
		// Per-match medal counters (reset at gameOver, see reset()). Named distinctly
		// from the progression branch's lifetime medal_counts keys so the two never
		// collide: these are per-match tallies that feed gatherAchievements().
		this.zombieKillCount = 0;       // kills landed while infected -> Zombie Slayer
		this.heavyHitCount = 0;         // fully-charged punches thrown -> Heavy Hitter
		this.bumperHitCount = 0;        // bumper bonks taken -> Pinball
		this.iceDistanceTravelled = 0;  // distance slid on ice tiles -> Ice Skater
		// Smooth Operator drift bookkeeping. driftDistanceTravelled is the per-match
		// BANKED drift total (distance covered while holding a punch charge on ice).
		// pendingDriftDistance accrues live during the charge and only banks once the
		// charge resolves "clean": a charge dropped without a throw banks in
		// cancelCharge; a THROWN charge moves the credit into escrow on the punch
		// (driftPunchRef/driftPunchPending) until the ~100ms punch linger settles —
		// a hit or clash voids it, a whiff banks it (checkDriftEscrow). Burning up
		// in lava voids both (handleMapCellHit's lava branch).
		this.driftDistanceTravelled = 0;
		this.pendingDriftDistance = 0;
		this.driftPunchRef = null;
		this.driftPunchPending = 0;
		this.driftPunchAt = 0;
		// Per-match counter for the abilitiesUsed cosmetic medal. The zombie/heavy-hit/bumper/
		// ice medals are main's gatherAchievements medals (zombieSlayer/heavyHitter/pinball/
		// iceSkater), which the award path already folds into medal_counts — no dup needed.
		this.abilitiesUsedMatch = 0;
		this.goalsReachedMatch = 0; // goals crossed this match (across all rounds)
		this.recapWorthy = false;   // had a recap-worthy "moment" this match (drives recapAppearances)

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
		// Opt-in avatar skin: a signed-in player who equips it in the lobby hub gets
		// their Discord/Google picture (and `name`) shown on their kart for everyone.
		// null = default colour skin, nameless. Set/cleared via messenger setAvatarSkin/setSkin.
		this.avatarUrl = null;
		// Three independent cosmetic slots (null = the slot's default: plain cart /
		// no pattern / basic trail). Equipped via messenger setCosmetic, validated
		// server-side, sent in the spawn packet. `trailFx` is the trail-EFFECT id —
		// named to avoid colliding with the client's `player.trail` motion object.
		this.cart = null;
		this.pattern = null;
		this.trailFx = null;
		this.border = null;     // 4th cosmetic slot: rim border (independent of pattern)
		this.profile = null;
		this.emoteReadyAt = 0;
		//Steering outputs the engine's isAI branch reads each tick.
		this.targetDirX = 0;
		this.targetDirY = 0;
		this.braking = false;
		//Scratch space for the bot brain (aiController) — path cache, timers, etc.
		this.ai = null;
	}
	update(currentState, dt) {
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
		this.checkDriftEscrow();
		this.checkAttack(currentState);
		this.checkChatCoolDownTimer();
		this.checkFireTimer();
		this.regenStamina(dt);
		this.updateOverchargeMeter();
	}
	move() {
		this.x = this.newX;
		this.y = this.newY;
	}
	// Punch input is hold-to-charge: a press starts a charge that drains stamina and
	// grows over time, and the punch is thrown on RELEASE with force = momentum x
	// charge. A quick tap (press then release) is a normal light punch; holding dumps
	// more of the stamina bar into a harder hit. Abilities are unchanged — they fire
	// instantly on press, not on a charge.
	checkAttack(currentState) {
		var playState = (currentState == c.stateMap.racing || currentState == c.stateMap.collapsing
			|| currentState == c.stateMap.lobby || currentState == c.stateMap.gated);
		// Holding attack while carrying an ability fires it instantly (no charge).
		if (this.attack && this.ability != null
			&& (currentState == c.stateMap.racing || currentState == c.stateMap.collapsing || currentState == c.stateMap.lobby)) {
			this.cancelCharge();
			this.punchedTimer = Date.now();
			// No scoring in the lobby (the resourceful stat isn't gated by checkForWinners).
			if (currentState != c.stateMap.lobby) {
				this.resourceful += 1;
				this.abilitiesUsedMatch += 1;
			}
			this.ability.use();
			this.attack = false;
			return;
		}
		// Punching only matters in active play (racing/collapsing/gated/lobby tutorial).
		// Outside that, swallow the input and drop any in-progress charge.
		if ((this.attack || this.attackQueued) && !playState) {
			this.attack = false;
			this.attackQueued = false;
			this.cancelCharge();
			return;
		}
		// Zombies bite instantly and for FREE — infection is a relentless chase, not a
		// stamina-managed duel — so they skip the charge/stamina flow entirely (still
		// cooldown-gated). (A zombie can't hold-charge a bite.)
		if (this.isZombie) {
			if ((this.attack || this.attackQueued) && !this.checkPunchCoolDown()) {
				this.cancelCharge();
				this.throwBite(currentState);
			} else if (!this.attack) {
				this.cancelCharge();
			}
			this.attackQueued = false;
			return;
		}
		if (this.attack) {
			// Button held -> build (or continue) a charge. The punch fires on release.
			if (!this.charging) {
				if (this.checkPunchCoolDown()) { return; } // still recovering from the last punch
				if (!this.canSpendStamina()) { this.attack = false; this.attackQueued = false; return; } // too tired
				this.startCharge();
			}
			this.updateCharge();
			this.attackQueued = false;
			return;
		}
		// Button up -> release a held charge as a punch.
		if (this.charging) {
			if (playState) {
				this.throwChargedPunch(currentState);
			} else {
				this.cancelCharge();
			}
			this.attackQueued = false;
			return;
		}
		// Sub-tick tap rescue: a press+release that both landed between ticks never set
		// charging, so throw it as a tap here rather than dropping it.
		if (this.attackQueued && !this.checkPunchCoolDown() && this.canSpendStamina()) {
			this.startCharge();
			this.updateCharge();        // ~0 charge -> a tap
			this.throwChargedPunch(currentState);
		}
		this.attackQueued = false;
	}
	// An instant, stamina-free zombie bite (used in infection rounds). Mirrors a tap punch
	// but with the infection bite radius + infected flag, no charge/stamina.
	throwBite(currentState) {
		this.punchedTimer = Date.now();
		this.punch = new Punch(this.x, this.y, c.brutalRounds.infection.punchRadius, this.color, this.id, this.roomSig, 1, true);
		this.punch.angle = this.angle;
		this.punch.ox = this.x;
		this.punch.oy = this.y;
		if (currentState != c.stateMap.lobby) { this.bully += 1; }
		messenger.messageRoomBySig(this.roomSig, "punch", compressor.sendPunch(this.punch));
		this.attack = false;
	}
	startCharge() {
		this.charging = true;
		this.chargeStartedAt = Date.now();
		this.chargeStaminaAtStart = this.stamina;
		this.chargeFrac = 0;
	}
	// Stamina a charge of `frac` (0..1) costs: a tap (0) costs punchCost; a full charge
	// (1) costs fullChargeCost. Charge IS the fuel.
	chargeCost(frac) {
		var s = c.punchStamina;
		return s.punchCost + (s.fullChargeCost - s.punchCost) * frac;
	}
	// Grow the charge over time toward full, capped by the stamina we can afford, and
	// drain the meter as we hold so it visibly empties.
	updateCharge() {
		var s = c.punchStamina;
		var held = Date.now() - this.chargeStartedAt;
		// Overcharge: hold way too long and the charge is wasted — you're locked in the
		// exhausted move penalty (the dark-red meter filled). Anti-camping pressure.
		var ch = c.punchCharge;
		if (held >= ch.overchargeAfterMs + ch.overchargeFillMs) {
			this.triggerOverchargeLock();
			return;
		}
		var frac = Math.min(1, held / ch.maxChargeMs);
		var span = s.fullChargeCost - s.punchCost;
		var affordable = span > 0 ? Math.min(1, Math.max(0, (this.chargeStaminaAtStart - s.punchCost) / span)) : 0;
		if (frac > affordable) { frac = affordable; }
		this.chargeFrac = frac;
		this.stamina = Math.max(0, this.chargeStaminaAtStart - this.chargeCost(frac));
	}
	// Held past the danger window: drop the charge (no punch), empty the bar, and lock
	// the exhausted move penalty for exhaustLockMs (regen is paused so it stays latched).
	triggerOverchargeLock() {
		this.cancelCharge();
		this.stamina = 0;
		this.staminaExhausted = true;
		this.exhaustLockUntil = Date.now() + c.punchCharge.exhaustLockMs;
		this.attack = false;
	}
	// Client-facing dark-red danger meter (0..1): fills while overcharging, then drains
	// across the lock as the penalty counts down; 0 otherwise.
	updateOverchargeMeter() {
		var now = Date.now();
		var ch = c.punchCharge;
		if (now < this.exhaustLockUntil) {
			this.overcharge = (this.exhaustLockUntil - now) / ch.exhaustLockMs;
		} else if (this.charging) {
			var held = now - this.chargeStartedAt;
			this.overcharge = held >= ch.overchargeAfterMs
				? Math.min(1, (held - ch.overchargeAfterMs) / ch.overchargeFillMs)
				: 0;
		} else {
			this.overcharge = 0;
		}
	}
	cancelCharge() {
		// A charge that ends here without throwing a punch can't have hit anyone — bank
		// any drift distance it accrued on ice. throwChargedPunch moves the pending
		// credit into punch escrow BEFORE calling this (so a thrown charge banks nothing
		// here), and a lava death zeroes the pending BEFORE killPlayer's cancelCharge
		// reaches us — so every path lands on the right side of the "clean drift" rule.
		if (this.pendingDriftDistance > 0) {
			this.driftDistanceTravelled += this.pendingDriftDistance;
			this.pendingDriftDistance = 0;
		}
		this.charging = false;
		this.chargeFrac = 0;
	}
	// Drift distance that counts toward the Smooth Operator medal: the banked total
	// PLUS any still-clean in-progress drift — a live charge's pending accrual and a
	// thrown charge whose punch hasn't connected. gatherAchievements reads this at
	// gameOver, where the final round's pending/escrow hasn't been folded in by
	// reset() yet; mirrors reset()'s clean-drift banking (a landed/clashed punch's
	// escrow never counts). Non-mutating, so reading it can't double-count.
	driftCreditTotal() {
		var total = this.driftDistanceTravelled + (this.pendingDriftDistance || 0);
		if (this.driftPunchRef != null && !this.driftPunchRef.landed && !this.driftPunchRef.clashed) {
			total += this.driftPunchPending;
		}
		return total;
	}
	// Judge a thrown drift-charge once its punch has settled (landed/clashed are
	// stamped within the ~100ms punch linger; resolveMs comfortably outlasts it,
	// and the 200ms punch cooldown means the next charge can't start before this
	// resolves): a clean whiff banks the escrowed drift distance; connecting with
	// anyone — a hit OR a clash — voids it.
	checkDriftEscrow() {
		if (this.driftPunchRef == null) { return; }
		if (Date.now() - this.driftPunchAt < c.iceDrift.resolveMs) { return; }
		if (!this.driftPunchRef.landed && !this.driftPunchRef.clashed) {
			this.driftDistanceTravelled += this.driftPunchPending;
		}
		this.driftPunchRef = null;
		this.driftPunchPending = 0;
	}
	// The held 8-way MOVEMENT direction (from the move booleans — the same mapping
	// the engine uses to drive), normalized, or null if nothing (or an opposed pair)
	// is held. The swim stroke propels you along the direction you're HOLDING, not
	// where you're aiming (this.angle), per the water design.
	getMoveDir() {
		var dx = 0, dy = 0;
		if (this.moveForward && !this.moveBackward) { dy -= 1; }
		else if (this.moveBackward && !this.moveForward) { dy += 1; }
		if (this.turnLeft && !this.turnRight) { dx -= 1; }
		else if (this.turnRight && !this.turnLeft) { dx += 1; }
		if (dx === 0 && dy === 0) { return null; }
		var m = Math.sqrt(dx * dx + dy * dy);
		return { x: dx / m, y: dy / m };
	}
	throwChargedPunch(currentState) {
		var frac = this.chargeFrac;
		// Stamina was already drained while charging; latch exhaustion off what's left.
		if (this.stamina < c.punchStamina.punchCost) {
			this.stamina = Math.max(0, this.stamina);
			this.staminaExhausted = true;
		}
		this.punchedTimer = Date.now();
		var punchRadius = c.punchRadius;
		if (this.isZombie == true) {
			punchRadius = c.brutalRounds.infection.punchRadius;
		}
		// Force = raw momentum x charge multiplier, so a fast, fully charged commit hits
		// hardest. Stash facing + owner position for the clash pass.
		var chargeMult = 1 + (c.punchCharge.maxChargeMult - 1) * frac;
		var bonus = this.calcPunchBonus() * chargeMult;
		this.punch = new Punch(this.x, this.y, punchRadius, this.color, this.id, this.roomSig, bonus, this.isZombie);
		this.punch.angle = this.angle;
		this.punch.ox = this.x;
		this.punch.oy = this.y;
		this.punch.chargeFrac = frac; // so a fully-charged hit can play its own SFX
		// Drift escrow: distance drifted during THIS charge rides on the thrown punch
		// until the linger settles — a hit/clash voids it, a clean whiff banks it
		// (checkDriftEscrow). Moved out of pending here so cancelCharge below banks nothing.
		if (this.pendingDriftDistance > 0) {
			this.driftPunchRef = this.punch;
			this.driftPunchPending = this.pendingDriftDistance;
			this.driftPunchAt = Date.now();
			this.pendingDriftDistance = 0;
		}
		// Throwing a punch costs momentum: brake your velocity so even a tap isn't free
		// — you lurch as you swing and have to rebuild speed. (The hit's force already
		// captured your pre-brake speed via calcPunchBonus above.) On ICE the brake is
		// eased by releaseBrakeEase (the full stop felt too harsh coming out of a
		// drift), and the keepMomentumOnRelease playtest toggle skips it entirely.
		if (this.onWater) {
			// Swimming: a punch on water PROPELS you in your held movement direction
			// rather than braking. A bigger charge gives a slightly longer stroke
			// (swimChargeBonus). The high water drag (config) bleeds the burst off so
			// each stroke is a lunge-and-glide; the engine's maxVelocity caps the peak.
			var w = c.tileMap.water;
			var dir = this.getMoveDir();
			// Bots have no move keys (getMoveDir reads them), so getMoveDir is always
			// null for them — they steer via targetDirX/Y (the engine's isAI drive axis).
			// Fall back to that steer vector so a bot's stroke propels it along the very
			// direction it's already trying to swim (the path carrot). Guarded by isAI so
			// a human's swim stays byte-for-byte unchanged (no keys held -> no stroke).
			if (dir == null && this.isAI) {
				var tdm = Math.sqrt(this.targetDirX * this.targetDirX + this.targetDirY * this.targetDirY);
				if (tdm > 0.0001) { dir = { x: this.targetDirX / tdm, y: this.targetDirY / tdm }; }
			}
			if (dir != null && w != null) {
				var impulse = w.swimImpulse * (1 + (w.swimChargeBonus || 0) * frac);
				this.velX += dir.x * impulse;
				this.velY += dir.y * impulse;
			}
		}
		else if (!(c.iceDrift.keepMomentumOnRelease && this.onIce)) {
			var releaseBrake = this.onIce
				? Math.min(1, c.punchThrowBrake * (c.iceDrift.releaseBrakeEase || 1))
				: c.punchThrowBrake;
			this.velX *= releaseBrake;
			this.velY *= releaseBrake;
		}
		// No scoring in the lobby (the bully stat isn't gated by checkForWinners).
		if (currentState != c.stateMap.lobby) {
			this.bully += 1;
			// Heavy Hitter: a committed, fully-charged swing (same threshold the client
			// uses for the charged-hit SFX). Counted on throw, like bully — a zombie's
			// free bite never charges, so it's naturally excluded.
			if (frac >= c.punchCharge.chargedHitFrac) {
				this.heavyHitCount += 1;
			}
		}
		messenger.messageRoomBySig(this.roomSig, "punch", compressor.sendPunch(this.punch));
		this.cancelCharge();
		this.attack = false;
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
	// Knockback multiplier from momentum: raw speed magnitude (punches are radial, so
	// any motion contributes — no aim to project onto). Maps 0..refFrac*maxVelocity
	// to floor..ceil.
	calcPunchBonus() {
		var m = c.punchMomentum;
		var speed = utils.getMag(this.velX, this.velY);
		var ref = this.maxVelocity * m.refFrac;
		var frac = ref > 0 ? Math.min(1, speed / ref) : 0;
		return m.floor + (m.ceil - m.floor) * frac;
	}
	// True if there's enough stamina to throw a punch. Once exhausted, stays false
	// until regenStamina lifts the latch (hysteresis), even if cost is momentarily met.
	canSpendStamina() {
		if (this.staminaExhausted) { return false; }
		return this.stamina >= c.punchStamina.punchCost;
	}
	regenStamina(dt) {
		// Don't regenerate mid-charge — holding the button is actively spending the bar
		// (updateCharge drains it), so regen here would fight that and inflate the meter.
		if (this.charging) { return; }
		// During an overcharge lock the penalty is forced: pause regen so staminaExhausted
		// stays latched (and the move penalty holds) for the whole lock window.
		if (Date.now() < this.exhaustLockUntil) { return; }
		var s = c.punchStamina;
		if (this.stamina < s.max) {
			this.stamina = Math.min(s.max, this.stamina + s.regenPerSec * dt);
		}
		if (this.staminaExhausted && this.stamina >= s.exhaustRecover) {
			this.staminaExhausted = false;
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
	// Star Power (any state, not lobby-only): immune to punches/pucks, explosion
	// and cut knockback, swaps, rival speed buffs/debuffs — and lava (crossed
	// like terrain, see handleMapCellHit). The starred player can still punch
	// others.
	hasStarPower() {
		return this.starPowerUntil != 0 && Date.now() < this.starPowerUntil;
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
		// A multi-kill or a kill streak is a recap highlight.
		if (this.multiKillCount >= 2 || this.totalKills >= 5) { this.recapWorthy = true; }
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
	// Burn this player exactly as stepping into lava does, without synthesizing a map
	// cell hit (that would clobber the onIce/onWater/onSanctuary footing stamps in
	// handleMapCellHit). Used by Orbital Beam to "burn like lava" along its struck line.
	// Honors the same immunities lava does — invuln (incl. lobby grace), Star Power,
	// and zombies — and routes a killstreak fire shield through the same burn timer, so
	// a shielded kart survives the line just like it survives lava. attackerId credits
	// the caster (mirrors cutPlayers); pass null for an unattributed burn.
	applyLavaBurn(attackerId) {
		if (this.alive == false) {
			return;
		}
		if (this.currentState == c.stateMap.lobby) {
			// Lobby lava is a teaching prop: cosmetic death + safe respawn, never the
			// real kill path. Invuln/Star Power holders are immune (matches the lava branch).
			if (this.isInvuln() || this.hasStarPower()) {
				return;
			}
			this.lobbyRespawnPending = "death";
			return;
		}
		if (this.hasStarPower() || this.isZombie == true || this.isInvuln()) {
			return;
		}
		if (attackerId != null) {
			this.setPunchedBy(attackerId);
		}
		if (this.onFire > 0) {
			// Killstreak fire shield: ride the burn timer down instead of an instant kill,
			// exactly like lava does while onFire > 0.
			if (this.fireTimer == null) {
				this.fireTimer = Date.now();
			}
			if (this.punchedBy != null) {
				this.burnedBy = this.punchedBy;
			}
			this.checkFireTimer();
			return;
		}
		if (this.punchedBy == null && this.burnedBy != null) {
			this.punchedBy = this.burnedBy;
		}
		// Burning up voids pending drift credit before killSelf banks it (see lava branch).
		this.pendingDriftDistance = 0;
		this.driftPunchRef = null;
		this.driftPunchPending = 0;
		this.killSelf("lava");
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
		// NOTE: merely standing in a hub station zone is NOT activity — proximity alone must
		// still idle out normally. ACTIVELY using a station panel (open / navigate / tab /
		// page / confirm / close, on key, touch, or pad) is what keeps a player awake: the
		// client fires a `lobbyActivity` ping on each such interaction (see messenger.js),
		// which calls wakeUp(). Shop browsing emits no movement packets, so without that ping
		// it would read as AFK — but parking a kart on the pad and walking away should not.
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
		// Off every cell = not on ice either (mirrors the per-tick onIce stamp).
		this.onIce = false;
		// Off every cell = not on water either; leaving water this way still triggers
		// the dripping-wet slow (mirrors handleMapCellHit's leave transition).
		if (this.onWater) {
			this.dripUntil = Date.now() + c.tileMap.water.dripMs;
		}
		this.onWater = false;
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
		// A clashed punch was countered (resolvePunchClashes already flung both owners
		// back); it lands on no one, so swallow the hit here.
		if (object.clashed) {
			return;
		}
		// Invulnerable lobby players (freshly respawned, or held safe in the start
		// circle) can't be punched — so a griefer can't shove them into lava or out
		// of the safe circle. Normal players still bump freely. No-op outside lobby.
		if (this.isInvuln()) {
			return;
		}
		// Star Power deflects every incoming punch — players, bumpers, zombies
		// (no infection) — while the starred player keeps punching others.
		if (this.hasStarPower()) {
			return;
		}
		if (object.ownerInfected) {
			this.infect();
		}
		if (!object.mapOwned) {
			this.setPunchedBy(object.ownerId);
		}
		// Mark the punch as having connected. A punch that already landed a normal hit
		// must not later be pulled into a clash (resolvePunchClashes skips landed
		// punches) — otherwise a punch thrown a tick earlier could both hit a victim AND
		// reflect, so only truly simultaneous (same-tick) mutual punches clash.
		object.landed = true;
		// Pinball: a bumper bonk. The bumper's punch lingers ~100ms (re-overlapping the
		// same victim across ticks), so dedupe per victim on the punch object — one
		// bonk = one tally. Real play only (lobby bumpers are a teaching prop).
		if (object.type === "bumper"
			&& (this.currentState == c.stateMap.racing || this.currentState == c.stateMap.collapsing)) {
			if (object.pinballCountedFor == null) { object.pinballCountedFor = {}; }
			if (!object.pinballCountedFor[this.id]) {
				object.pinballCountedFor[this.id] = true;
				this.bumperHitCount += 1;
			}
		}
		_engine.punchPlayer(this, object);
		var charged = object.chargeFrac != null && object.chargeFrac >= c.punchCharge.chargedHitFrac;
		messenger.messageRoomBySig(this.roomSig, "playerPunched", { owner: object.ownerId, victim: this.id, x: this.x, y: this.y, charged: charged });
		emitBotEmote(this, "hurt"); // an AI racer reacts to getting knocked
		return;
	}
	handlePuckHit(object) {
		if (this.isInvuln() || this.hasStarPower()) {
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
		// Same per-tick footing stamp for ice: gates the drift-traction blend below and
		// the keepMomentumOnRelease toggle in throwChargedPunch.
		this.onIce = (object.id == c.tileMap.ice.id);
		// Water footing (gates the swim stroke in throwChargedPunch). Climbing OUT of
		// water — was on water last tick, isn't now — starts the "dripping wet" slow
		// (engine.updatePlayers reads dripUntil). The same transition is mirrored in
		// handleNoCellHit for a player who leaves water by going off every cell.
		var nowOnWater = (c.tileMap.water != null && object.id == c.tileMap.water.id);
		if (this.onWater && !nowOnWater) {
			this.dripUntil = Date.now() + c.tileMap.water.dripMs;
		}
		this.onWater = nowOnWater;
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
		if (object.id == c.tileMap.empty.id) {
			// Empty cells are non-walkable holes; the engine bounces players off the
			// rim before their center ever commits inside one (bounceOffEmptyCells).
			// This branch is a defensive fallback (e.g. a hard punch flinging a kart
			// clean past the rim in a single tick): keep normal grip so the previous
			// tile's physics — notably ice — doesn't persist while they're pushed out.
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
		if (c.tileMap.water != null && object.id == c.tileMap.water.id) {
			// Deep water. Low acel + high drag (config) make passive drive almost nil —
			// you barely move unless you PUNCH to swim (throwChargedPunch reads onWater,
			// set above). Zombies get their infection-modded grip like any other tile.
			if (this.isZombie == true) {
				this.applyInfectedMods(object);
			} else {
				this.acel = object.acel;
				this.dragCoeff = object.dragCoeff;
				this.brakeCoeff = object.brakeCoeff;
			}
			// Water douses a killstreak fire shield: drop onFire and tell the room so the
			// client can stop the flame and play the hiss/steam cue. Does NOT touch the
			// burn attributor (burnedBy was already cleared above for any non-lava cell).
			if (this.onFire > 0) {
				this.onFire = 0;
				this.fireTimer = null;
				messenger.messageRoomBySig(this.roomSig, "onFire", { owner: this.id, value: 0 });
				messenger.messageRoomBySig(this.roomSig, "flameExtinguished", { owner: this.id, x: this.x, y: this.y });
			}
			return;
		}
		if (object.id == c.tileMap.lava.id) {
			if (this.currentState == c.stateMap.lobby) {
				// Lobby lava is a teaching prop: cosmetic death + safe respawn, never
				// the real kill path (no killPlayer/removeNotch). Invuln players in
				// their post-respawn grace window are immune, as is a Star Power holder.
				if (this.isInvuln() || this.hasStarPower()) {
					return;
				}
				this.lobbyRespawnPending = "death";
				return;
			}
			// Star Power: lava can't kill — cross it (collapse ground included) like a
			// zombie does, taking the cell's physics but never the burn/death path. If
			// the star runs out mid-crossing, the next tick's lava hit kills as normal.
			if (this.hasStarPower()) {
				this.acel = object.acel;
				this.dragCoeff = object.dragCoeff;
				this.brakeCoeff = object.brakeCoeff;
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
			// Burning up in the lava voids ALL pending drift credit — the live charge's
			// accrual and anything still in punch escrow. Must happen BEFORE killSelf:
			// the killPlayer path calls cancelCharge(), which would otherwise bank it.
			this.pendingDriftDistance = 0;
			this.driftPunchRef = null;
			this.driftPunchPending = 0;
			this.killSelf("lava");
			return;
		}
		if (object.id == c.tileMap.ice.id) {
			this.acel = object.acel;
			this.brakeCoeff = object.brakeCoeff;
			this.dragCoeff = object.dragCoeff;
			// Drifting: holding a punch charge digs the kart in for grip — blend the ice
			// physics toward normal terrain by iceDrift.grip. The extra drag bleeds a
			// little top speed (the deliberate "slow down slightly" trade) while the
			// restored brake/acel give steering control back. Zombies never charge, so
			// their infection-modded grip is untouched by construction.
			if (this.charging) {
				var grip = c.iceDrift.grip;
				var solid = c.tileMap.normal;
				this.acel += (solid.acel - object.acel) * grip;
				this.brakeCoeff += (solid.brakeCoeff - object.brakeCoeff) * grip;
				this.dragCoeff += (solid.dragCoeff - object.dragCoeff) * grip;
				// Smooth Operator: drift distance accrues only in real play (like the Ice
				// Skater clock below) and only PENDING — it banks when the charge resolves
				// without hitting anyone (cancelCharge / checkDriftEscrow).
				if ((this.currentState == c.stateMap.racing || this.currentState == c.stateMap.collapsing) && this.dt) {
					this.pendingDriftDistance += utils.getMag(this.velX, this.velY) * this.dt;
				}
			}
			// Ice Skater: clock the distance slid while on ice (speed x dt this tick).
			// Only in real play — lobby ice is a teaching prop, not scored.
			if ((this.currentState == c.stateMap.racing || this.currentState == c.stateMap.collapsing) && this.dt) {
				this.iceDistanceTravelled += utils.getMag(this.velX, this.velY) * this.dt;
			}
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
			this.goalsReachedMatch += 1; // count EVERY round's goal (reset clears reachedGoal per round)
			this.timeReached = Date.now();
			// "clutch" = beat the lava to the goal: only when the lava front was
			// genuinely close (collapseMargin stamped each collapsing tick), so an
			// uncontested slow-collapse stroll-in doesn't trigger the big eruption.
			var clutch = this.collapseMargin != null && this.collapseMargin < c.audienceClutchMargin;
			// A clutch finish (just beat the collapse) or crossing the line while still on fire
			// is a recap moment — credit the recapAppearances medal for who actually had one.
			if (clutch || this.onFire > 0) { this.recapWorthy = true; }
			// Server-authoritative elapsed time at finish — sent down so the
			// client can freeze the HUD timer at this exact value (avoiding
			// any clock-skew drift between server Date.now() and the browser's
			// Date.now() that the client would otherwise have to subtract).
			// Null when raceStartedAt isn't stamped (preview / non-racing path).
			var finishMs = (this.raceStartedAt != null)
				? Math.max(0, this.timeReached - this.raceStartedAt)
				: null;
			messenger.messageRoomBySig(this.roomSig, "playerConcluded", { id: this.id, clutch: clutch, finishMs: finishMs });
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
		// Test override (config.forceAbilitySpawn / FORCE_ABILITY_SPAWN env, prod-disabled):
		// force any ability tile to grant the configured ability instead. Generic ability
		// pads already resolve to it at map generation (spawnNewAbility); this also covers
		// ability tiles painted with a fixed id directly on a map.
		if (c.forceAbilitySpawn != null && ABILITY_TILE_CTORS[c.forceAbilitySpawn] != null) {
			Ctor = ABILITY_TILE_CTORS[c.forceAbilitySpawn];
		}
		this.ability = new Ctor(this.id, this.roomSig);
		this.acquiredAbility = { mapID: object.voronoiId };
		// Broadcast the GRANTED ability's id (not the tile id) so the client-side
		// holding state matches what use() will actually fire.
		messenger.messageRoomBySig(this.roomSig, "abilityAcquired", { owner: this.id, ability: this.ability.id, voronoiId: object.voronoiId });
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
	killPlayer(packet, cause) {
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
		// Bounced off a lot of bumpers and then died — a funny recap moment.
		if ((packet.bumperHitCount || 0) >= 6) { packet.recapWorthy = true; }
		// Clear any in-progress charge/exhaustion so a death mid-charge doesn't leak a
		// frozen charge-fist on the corpse or, via the infection resurrect, revive a
		// zombie with a stale charge (phantom punch / instant overcharge-lock).
		packet.cancelCharge();
		packet.overcharge = 0;
		packet.exhaustLockUntil = 0;
		packet.staminaExhausted = false;
		packet.stamina = c.punchStamina.max;
		packet.attack = false;
		packet.attackQueued = false;
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
		// `cause` + `x`/`y` are AUTHORITATIVE: the client needs them to decide
		// whether to spawn the sinking-corpse FX without racing the next
		// gameUpdates packet (which is what carries the late tx/ty for a kart
		// that crossed onto lava between server ticks). `cause` is null for
		// non-lava deaths (gate-wall, infection-timer, AFK, bomb) so the client
		// can also distinguish without inspecting the tile.
		messenger.messageRoomBySig(packet.roomSig, "playerDied", {
			id: packet.id,
			killed: packet.murderedBy != null,
			cause: cause || null,
			x: packet.x,
			y: packet.y
		});
	}
	killSelf(cause) {
		this.killPlayer(this, cause);
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
		if (this.ai != null) {
			this.ai.waypoints = null; this.ai.repathTimer = 0; this.ai.punchHoldUntil = null; this.ai.punchAngle = 0;
			// Clear the anti-stuck/escape state too. It persists on bot.ai across rounds, and
			// the headwayAt "continuous-stuck" clock is stale from the previous round — if the
			// bot's new-round spawn happens to fall within STUCK_RADIUS of its old anchor (the
			// corner-stuck bots end near the gate and respawn there), a stale headwayAt would
			// trip the avoidance-off beeline on the very first racing tick and fling it off the
			// line. Reset so the first tick re-anchors fresh.
			this.ai.progressAnchor = null; this.ai.progressAt = 0; this.ai.headwayAt = null;
			this.ai.escapeUntil = 0; this.ai.escapeStage = 0; this.ai.lastEscapeAt = 0;
		}
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
		this.eliminatedAt = null;
		this.pbWritten = false;
		this.collapseMargin = null;
		this.stamina = c.punchStamina.max;
		this.staminaExhausted = false;
		this.charging = false;
		this.chargeFrac = 0;
		this.chargeStartedAt = 0;
		this.chargeStaminaAtStart = 0;
		this.overcharge = 0;
		this.exhaustLockUntil = 0;
		this.attackQueued = false;
		// A drift still live when the round ends (e.g. carried a charge across the goal
		// line, or a punch still in its linger) never hit anyone — bank it before
		// clearing the transient state, then judge any unresolved escrow optimistically.
		if (this.pendingDriftDistance > 0) {
			this.driftDistanceTravelled += this.pendingDriftDistance;
		}
		if (this.driftPunchRef != null && !this.driftPunchRef.landed && !this.driftPunchRef.clashed) {
			this.driftDistanceTravelled += this.driftPunchPending;
		}
		this.pendingDriftDistance = 0;
		this.driftPunchRef = null;
		this.driftPunchPending = 0;
		this.onIce = false;
		this.onWater = false;
		this.dripUntil = 0;
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
		this.starPowerUntil = 0;
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
			this.zombieKillCount = 0;
			this.heavyHitCount = 0;
			this.bumperHitCount = 0;
			this.iceDistanceTravelled = 0;
			this.driftDistanceTravelled = 0;
			this.abilitiesUsedMatch = 0; // per-match counter for the abilitiesUsed cosmetic medal
			this.goalsReachedMatch = 0;
			this.recapWorthy = false;
		}
	}
}

module.exports = { Player, LobbyStartButton, LobbyStation };
