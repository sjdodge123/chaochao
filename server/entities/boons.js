'use strict';
// Boons — the helpful counterpart to hazards (server/entities/hazards.js). A boon
// is a map-authorable placeable that AIDS the player. Boons deliberately reuse the
// hazard framework end to end: they register into the shared kind registry (so
// gameBoard.generateHazards builds them, utils.validateMap validates them, and the
// editor/wire/drawer treat them uniformly), and they live in the same runtime
// hazardList. The ONLY thing that distinguishes a boon is `helpful: true`, which
// gates the three spots where hazard behavior would otherwise apply: the lightning
// brutal-round speed-up, the AI's repulsion + cell-penalty (bots must not dodge a
// boost), and the map classifier's difficulty count (a boon is not difficulty).
//
// Adding a boon = a config.boons entry + one registerBoonKind call here (with a
// `build`), a drawer in client/scripts/draw.js (buildHazardDrawers), and an editor
// entry in client/scripts/create.js (EDITOR_HAZARD_KINDS, group:"boon"). See the
// add-a-kind checklist in ARCHITECTURE.md.
var utils = require('../utils.js');
var c = utils.loadConfig();
var { Hazard, HazardRail, WarpPad, registerBoonKind } = require('./hazards.js');

// Base class for boons. Extends the circular Hazard so a boon rides the existing
// engine tick, quadtree collision, compressor wire, and client drawer dispatch
// with no new plumbing. Subclasses override handleHit to do the helpful thing;
// static boons need no per-tick update (the override guards against Hazard.move()
// touching undefined newX/newY). A boon that animates a phase opts into the wire's
// streamAngle/netState slots (compressor.sendHazardUpdates) and overrides update().
class Boon extends Hazard {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color, ownerId, roomSig, null);
		this.helpful = true;
		this.moveable = false;
		// Engine double-dispatch bookkeeping (see claimTickContact).
		this._contactTick = -1;
		this._contactIds = null;
	}
	update() { }
	handleHit(object) { }
	// Who a boon acts on: a live RACER, never a zombie. Boons are racer aids, so they
	// deliberately skip the infection side — a boon must not speed a zombie's chase,
	// reset its bite cooldown, or let it drain a shared Recharge Spring away from the
	// survivors. Every other colliding entity (pucks, projectiles, antlions and other
	// hazards, aimers, punches, gates) is not isPlayer, so this also excludes them all.
	isEligiblePlayer(object) {
		return object != null && object.isPlayer === true && object.isZombie !== true;
	}
	// Engine.broadBase resolves a colliding pair from BOTH object orderings
	// (obj1.handleHit(obj2); obj2.handleHit(obj1)) and walks every object as obj1,
	// so a boon's handleHit runs TWICE for one overlap in a single tick. A boon that
	// applies a velocity impulse per call would therefore impart ~2x its configured
	// push. claimTickContact returns true only the FIRST time it sees a given object
	// in a tick — keyed on Date.now(), which is constant across one synchronous
	// collision pass — so the caller applies its effect exactly once per tick. (The
	// Recharge Spring doesn't need this: its global cooldown already no-ops the second
	// call.) Returns false for the duplicate call.
	claimTickContact(object) {
		var now = Date.now();
		if (this._contactTick !== now) {
			this._contactTick = now;
			this._contactIds = {};
		}
		var key = object.id != null ? object.id : (object.ownerId != null ? object.ownerId : "anon");
		if (this._contactIds[key]) {
			return false;
		}
		this._contactIds[key] = true;
		return true;
	}
}

// Dash Arrows — a directional speed pad (the chevron strip). While a racer overlaps
// it, it adds a velocity impulse along the pad's facing each contact tick; the engine's
// maxVelocity clamp (engine.js) turns a couple of contact ticks into a snap to top
// speed in the arrow's direction. Self-limiting: the pad is small, so a boosted racer
// is flung clear within a few ticks. Unlike the omnidirectional `fast` tile, the boost
// is purely along the author-set angle, so hitting it backwards fights it — placement
// and rotation are the authoring lever. (Racers only — see Boon.isEligiblePlayer.)
class DashArrows extends Boon {
	constructor(x, y, angle, ownerId, roomSig) {
		super(x, y, c.boons.dashArrows.radius, c.boons.dashArrows.color, ownerId, roomSig);
		this.id = c.boons.dashArrows.id;
		this.angle = angle;
		this.boost = c.boons.dashArrows.boost;
		this.boostCap = c.boons.dashArrows.boostCap;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object)) {
			return;
		}
		if (!this.claimTickContact(object)) {
			return; // engine double-dispatch: only boost once per overlap tick
		}
		var rad = (this.angle || 0) * (Math.PI / 180);
		var dirX = Math.cos(rad), dirY = Math.sin(rad);
		// The pad accelerates the player toward boostCap ALONG its arrow and no
		// further — capped below the engine's maxVelocity so a boost reads as a
		// brisk shove, not a slam to top speed. handleHit fires every overlap tick,
		// so add only up to the remaining gap: never overshoot the cap (which would
		// let a kart tunnel a thin wall in one tick) and never brake a player who's
		// already moving faster than the pad. (maxVelocity honors a speed buff.)
		var cap = Math.min(this.boostCap, object.maxVelocity || c.playerMaxSpeed);
		var along = object.velX * dirX + object.velY * dirY;
		if (along >= cap) {
			return;
		}
		var add = Math.min(this.boost, cap - along);
		object.velX += dirX * add;
		object.velY += dirY * add;
	}
}

registerBoonKind("dashArrows", {
	railed: false,
	directional: true,
	build: function (entry, mapID, roomSig) {
		return new DashArrows(entry.x, entry.y, entry.angle, mapID, roomSig);
	}
});

// Recharge Spring — a drive-over pit stop (the green spring pad). Touching it makes a
// player instantly battle-ready: it tops the punch-stamina bar back to full, drops the
// exhausted/overcharge latch, and resets the punch cooldown (the reset itself lives on
// Player.rechargeFromSpring). The spring is a SHARED, GLOBAL resource: it has one charge
// that the first racer to reach a ready spring consumes, after which the spring visibly
// drains and refills over cooldownMs before it can recharge anyone again. That refill
// progress rides the wire's netState slot (0 = just drained .. 100 = ready) so the
// client can draw the drained -> fill-ring -> ready-pulse telegraph. Non-directional.
// A boon with a single GLOBAL shared charge that re-arms over cooldownMs and telegraphs
// the refill on the wire's netState slot (0 = just spent .. 100 = ready). Subclasses
// (Recharge Spring, Guard Halo) call isReady() to gate, then spend() once the charge is
// actually consumed; update() drives the drained -> fill-ring -> ready-pulse animation.
class CooldownBoon extends Boon {
	constructor(x, y, radius, color, ownerId, roomSig, cooldownMs) {
		super(x, y, radius, color, ownerId, roomSig);
		this.cooldownMs = cooldownMs;
		this.rechargeReadyAt = 0;   // Date.now() the charge is ready again (<= now == ready)
		this.netState = 100;        // wire slot: refill percent, 100 = ready (drawn telegraph)
	}
	isReady() {
		return Date.now() >= this.rechargeReadyAt;
	}
	spend() {
		this.rechargeReadyAt = Date.now() + this.cooldownMs;
		this.netState = 0;
	}
	// Per tick (gameBoard.updateHazards): refresh the refill percent the client draws.
	update() {
		var now = Date.now();
		if (now >= this.rechargeReadyAt) {
			this.netState = 100;
			return;
		}
		var remaining = this.rechargeReadyAt - now;
		this.netState = Math.max(0, Math.min(99, Math.round((1 - remaining / this.cooldownMs) * 100)));
	}
}

class RechargeSpring extends CooldownBoon {
	constructor(x, y, ownerId, roomSig) {
		super(x, y, c.boons.rechargeSpring.radius, c.boons.rechargeSpring.color, ownerId, roomSig, c.boons.rechargeSpring.cooldownMs);
		this.id = c.boons.rechargeSpring.id;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object) || typeof object.rechargeFromSpring !== "function") {
			return;
		}
		if (!this.isReady()) {
			return; // still refilling — no charge to give
		}
		// Only spend the charge if the racer actually needed it (rechargeFromSpring
		// returns false for an already-topped-up kart), so a full racer doesn't drain
		// a ready spring for nothing.
		if (object.rechargeFromSpring()) {
			this.spend();
		}
	}
}

registerBoonKind("rechargeSpring", {
	railed: false,
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new RechargeSpring(entry.x, entry.y, mapID, roomSig);
	}
});

// Slipstream — a wind-current corridor (the streamline patch). While a racer overlaps
// it, a gentle constant push along the author-set axis carries them up to currentSpeed
// — a steady current, deliberately well below the engine max and below Dash Arrows'
// launch cap, so it reads as a tailwind, not a slam. Same anti-overshoot rule as Dash
// Arrows: add only the remaining gap to the cap each contact tick (never overshoot —
// which could tunnel a thin wall in one tick — and never brake a racer already moving
// faster ALONG the axis). Because the push is purely axial, a kart shoved or driven
// BACKWARDS through it has a negative `along`, so the full push fights that backward
// motion and carries it forward again. The footprint is large; chain a few to build a
// long tunnel. (Racers only — see Boon.isEligiblePlayer; pucks use projectile physics
// that wouldn't carry a raw velocity impulse, so they're deliberately excluded.)
class Slipstream extends Boon {
	constructor(x, y, angle, ownerId, roomSig) {
		super(x, y, c.boons.slipstream.radius, c.boons.slipstream.color, ownerId, roomSig);
		this.id = c.boons.slipstream.id;
		this.angle = angle;
		this.push = c.boons.slipstream.push;
		this.currentSpeed = c.boons.slipstream.currentSpeed;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object)) {
			return;
		}
		if (!this.claimTickContact(object)) {
			return; // engine double-dispatch: only push once per overlap tick
		}
		var rad = (this.angle || 0) * (Math.PI / 180);
		var dirX = Math.cos(rad), dirY = Math.sin(rad);
		var cap = Math.min(this.currentSpeed, object.maxVelocity || c.playerMaxSpeed);
		var along = object.velX * dirX + object.velY * dirY;
		if (along >= cap) {
			return;
		}
		var add = Math.min(this.push, cap - along);
		object.velX += dirX * add;
		object.velY += dirY * add;
	}
}

registerBoonKind("slipstream", {
	railed: false,
	directional: true,
	build: function (entry, mapID, roomSig) {
		return new Slipstream(entry.x, entry.y, entry.angle, mapID, roomSig);
	}
});

// Guard Halo — a floating ring (the gold halo) you drive over to pick up a ONE-HIT
// SHIELD. The shield is per-player state (Player.guardShield): it absorbs the next
// incoming hit from ANY source — punch, bumper, bumper-wall, rotor, bomb, ice shot,
// cut, puck — and pops, applying no knockback, no attribution, and (for a zombie
// punch) no infection for that one hit. The absorb itself lives where each hit is
// already gated for Star Power (Player.handlePunchHit/handlePuckHit + GameBoard's
// cutPlayers/applyExplosionForce), via Player.tryConsumeGuardShield(); the halo's
// only job is to GRANT the shield. Like the Recharge Spring it's a global shared
// charge: the first unshielded racer to reach a ready halo claims it, after which the
// halo drains and re-arms over cooldownMs, telegraphing the refill on the netState
// wire slot (0 = just claimed .. 100 = ready). A racer who already holds a shield
// never wastes a ready halo. Non-directional. (Racers only — see isEligiblePlayer.)
class GuardHalo extends CooldownBoon {
	constructor(x, y, ownerId, roomSig) {
		super(x, y, c.boons.guardHalo.radius, c.boons.guardHalo.color, ownerId, roomSig, c.boons.guardHalo.cooldownMs);
		this.id = c.boons.guardHalo.id;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object) || typeof object.grantGuardShield !== "function") {
			return;
		}
		if (!this.isReady()) {
			return; // still re-arming — no shield to give
		}
		// Only spend the charge if the racer actually took the shield (grantGuardShield
		// returns false for a racer who already holds one), so a shielded racer doesn't
		// drain a ready halo for nothing.
		if (object.grantGuardShield()) {
			this.spend();
		}
	}
}

registerBoonKind("guardHalo", {
	railed: false,
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new GuardHalo(entry.x, entry.y, mapID, roomSig);
	}
});

// Second Wind Totem — drive over to ATTUNE (the totem becomes your respawn anchor).
// The first death that round respawns you AT the totem instead of ending your run;
// single-use per player per round. The revive itself lives on the death path
// (Player.killPlayer reads Player.secondWind, repositions, and returns before marking
// you dead) — the totem's only job is to attune a racer (Player.attuneSecondWind),
// handing it a reference to this totem so the death path can read the live `safe`
// flag. That flag is recomputed each tick by GameBoard.updateHazards (the totem opts
// in via tracksTileSafety): once the collapse turns the totem's tile to lava, `safe`
// goes false and the revive is skipped (lava would just re-kill the respawned racer).
// The totem has no cooldown — it's a fixed anchor any number of racers can attune to.
// Non-directional. (Racers only — see isEligiblePlayer; a zombie can't attune.)
class SecondWindTotem extends Boon {
	constructor(x, y, ownerId, roomSig) {
		super(x, y, c.boons.secondWindTotem.radius, c.boons.secondWindTotem.color, ownerId, roomSig);
		this.id = c.boons.secondWindTotem.id;
		this.respawnInvulnMs = c.boons.secondWindTotem.respawnInvulnMs;
		this.tracksTileSafety = true; // updateHazards keeps `safe` fresh for the revive guard
		this.safe = true;             // false once the collapse turns this tile to lava
		// Wire slot: 100 = flag standing (revives), 0 = consumed by lava (dead). Mirrors
		// `safe`; the client hides the flag once it reads consumed. (updateHazards sets it.)
		this.netState = 100;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object) || typeof object.attuneSecondWind !== "function") {
			return;
		}
		object.attuneSecondWind(this);
	}
}

registerBoonKind("secondWindTotem", {
	railed: false,
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new SecondWindTotem(entry.x, entry.y, mapID, roomSig);
	}
});

// Launch Pad — drive over to be FLUNG on a committed airborne arc along the pad's
// facing. The pad's only job is to start the shared "airborne" player state
// (Player.launchAirborne): while aloft the racer ignores every ground tile (lava
// included), hazard, and punch — they're untouchable in the air (the isAloft guards in
// Player.update/handleHit/killPlayer) — then they land where the arc ends and normal
// tile resolution resumes (land in lava and you die — author placement is the risk).
// No mid-flight steering. Directional (author-rotated). (Racers only — see
// isEligiblePlayer. launchAirborne itself guards re-entry, so the engine double-dispatch
// and an already-aloft kart are both no-ops.)
class LaunchPad extends Boon {
	constructor(x, y, angle, ownerId, roomSig) {
		super(x, y, c.boons.launchPad.radius, c.boons.launchPad.color, ownerId, roomSig);
		this.id = c.boons.launchPad.id;
		this.angle = angle;
		this.distance = c.boons.launchPad.distance;
		this.durationMs = c.boons.launchPad.durationMs;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object) || typeof object.launchAirborne !== "function") {
			return;
		}
		object.launchAirborne(this.angle, this.distance, this.durationMs, "pad");
	}
}

registerBoonKind("launchPad", {
	railed: false,
	directional: true,
	build: function (entry, mapID, roomSig) {
		return new LaunchPad(entry.x, entry.y, entry.angle, mapID, roomSig);
	}
});

// Barrel Cannon — drive in to be LOADED (DK-barrel style): the racer is captured at the
// barrel mouth and the barrel AUTO-SPINS; you press punch to TIME the shot (or the fuse
// fires you when it runs out), launching on a committed airborne arc along whatever
// direction the barrel currently points — a longer flight than the Launch Pad.
// Reuses the same shared airborne state (Player.loadIntoBarrel holds them, then
// launchAirborne flies them) — same lava/tile immunity aloft, same land-where-you-land
// resolution. Directional (author-rotated). (Racers only — see isEligiblePlayer;
// loadIntoBarrel guards re-entry so the double-dispatch / already-loaded calls no-op.)
class BarrelCannon extends Boon {
	constructor(x, y, angle, ownerId, roomSig) {
		super(x, y, c.boons.barrelCannon.radius, c.boons.barrelCannon.color, ownerId, roomSig);
		this.id = c.boons.barrelCannon.id;
		this.angle = angle;
		this.authorAngle = angle;
		// The barrel ITSELF rotates to show the aim: while a racer is loaded, tickBarrel
		// drives this.angle to the auto-spin aim; opting into the streamAngle wire slot
		// (compressor.sendHazardUpdates) ships it each tick so the client barrel spins
		// (eased like the rotor) instead of drawing a separate aim arrow.
		this.streamAngle = true;
		this.idleSpeed = c.boons.barrelCannon.idleSpeed;
		this.autoFireMs = c.boons.barrelCannon.autoFireMs;
		this.minAimMs = c.boons.barrelCannon.minAimMs;
		this.sweepSpeed = c.boons.barrelCannon.sweepSpeed;
		this.flightDistance = c.boons.barrelCannon.flightDistance;
		this.flightDurationMs = c.boons.barrelCannon.flightDurationMs;
		// While a racer is loaded, their tickBarrel drives this.angle (the fast aim spin)
		// and refreshes occupiedUntil; otherwise update() idle-spins the empty barrel slowly.
		// A timestamp (not a flag) so a vanished occupant can't strand it "occupied".
		this.occupiedUntil = 0;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object) || typeof object.loadIntoBarrel !== "function") {
			return;
		}
		object.loadIntoBarrel(this);
	}
	// Idle spin: an empty barrel turns slowly on its own (streamAngle ships it). While a
	// racer is loaded (occupiedUntil in the future) their tickBarrel owns the angle instead.
	update(dt) {
		if (Date.now() < this.occupiedUntil) {
			return;
		}
		this.angle = (this.angle + this.idleSpeed * (dt || 0)) % 360;
	}
}

registerBoonKind("barrelCannon", {
	railed: false,
	directional: true,
	build: function (entry, mapID, roomSig) {
		return new BarrelCannon(entry.x, entry.y, entry.angle, mapID, roomSig);
	}
});

// Slingshot Rings — drive THROUGH a ring for a speed pulse along the ring's axis, scaled
// by how CENTERED the pass was (dead-centre = full pulse, clipping the rim = barely any).
// Reuses the Dash Arrows capped-add (add only the remaining gap to the cap, so it never
// overshoots — which could tunnel a thin wall in one tick — and never brakes a kart
// already faster along the axis), but the per-tick add is scaled by centeredness and the
// cap is raised when consecutive rings are hit inside chainWindowMs (chainBonus per link,
// up to chainMax) — so a line of rings stacks into a bigger launch than any one ring.
// Purely axial, so a backward pass fights it. (Racers only — see isEligiblePlayer; pucks
// use projectile physics that wouldn't carry a raw velocity impulse, so they're excluded.)
class SlingshotRings extends Boon {
	constructor(x, y, angle, ownerId, roomSig) {
		super(x, y, c.boons.slingshotRings.radius, c.boons.slingshotRings.color, ownerId, roomSig);
		this.id = c.boons.slingshotRings.id;
		this.angle = angle;
		this.pulse = c.boons.slingshotRings.pulse;
		this.pulseCap = c.boons.slingshotRings.pulseCap;
		this.chainWindowMs = c.boons.slingshotRings.chainWindowMs;
		this.chainMinGapMs = c.boons.slingshotRings.chainMinGapMs;
		this.chainBonus = c.boons.slingshotRings.chainBonus;
		this.chainMax = c.boons.slingshotRings.chainMax;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object)) {
			return;
		}
		if (!this.claimTickContact(object)) {
			return; // engine double-dispatch: only pulse once per overlap tick
		}
		var rad = (this.angle || 0) * (Math.PI / 180);
		var dirX = Math.cos(rad), dirY = Math.sin(rad);
		// Centeredness: perpendicular distance of the kart from the ring centre (its
		// component along the axis-normal). 1 dead-centre, 0 at the rim. A glancing pass
		// barely boosts; a centred pass gets the full pulse.
		var ox = (object.x || 0) - this.x, oy = (object.y || 0) - this.y;
		var perp = Math.abs(ox * -dirY + oy * dirX);
		var reach = this.radius + (c.playerBaseRadius || 7.5);
		var centered = 1 - Math.min(1, perp / reach);
		if (centered <= 0) {
			return;
		}
		// Chain: consecutive rings within chainWindowMs stack a cap bonus (up to chainMax),
		// so a row of rings launches harder than one. The window re-arms on every ring. A
		// link only counts if at least chainMinGapMs has passed since the last one, so a
		// kart overlapping two tightly-packed rings in a single tick (or a dense cluster)
		// can't multi-increment the chain — it has to be SEPARATE passes through a line.
		var now = Date.now();
		var withinWindow = object.slingChainUntil != null && object.slingChainUntil > 0 && now <= object.slingChainUntil;
		var gapOk = object.slingChainAt == null || (now - object.slingChainAt) >= this.chainMinGapMs;
		if (withinWindow) {
			if (gapOk) {
				object.slingChainCount = Math.min(this.chainMax, (object.slingChainCount || 0) + 1);
				object.slingChainAt = now;
			}
			// within the window but too soon (same tick / cluster) → keep the current count
		} else {
			object.slingChainCount = 0;
			object.slingChainAt = now;
		}
		object.slingChainUntil = now + this.chainWindowMs;
		// Capped-add toward the (chain-raised) cap, scaled by how centred the pass is.
		var cap = Math.min(this.pulseCap + this.chainBonus * object.slingChainCount,
			object.maxVelocity || c.playerMaxSpeed);
		var along = object.velX * dirX + object.velY * dirY;
		if (along >= cap) {
			return;
		}
		var add = Math.min(this.pulse, cap - along) * centered;
		object.velX += dirX * add;
		object.velY += dirY * add;
	}
}

registerBoonKind("slingshotRings", {
	railed: false,
	directional: true,
	build: function (entry, mapID, roomSig) {
		return new SlingshotRings(entry.x, entry.y, entry.angle, mapID, roomSig);
	}
});

// Zipline — a two-post cable (a RAILED boon). The collidable disc is the START post (the
// rail origin); drive onto it to be CARRIED fast along the cable toward the far post.
// Like the moving bumper it rides a HazardRail and ships the rail's origin/angle on the
// wire — but its LENGTH is author-set (railLengthAuthored ships rail.width too), so a
// longer line carries you further. It is ONE-WAY/directional: rotation + length are the
// authoring lever. The ride itself lives on the shared "aloft" player state
// (Player.boardZipline → tickZipline → finishZipline): untouchable + tile/lava-immune
// while carried (the isAloft guards), holding drains stamina (run dry = auto-drop), punch
// drops off early, and any drop-off keeps the along-rail speed as real velocity. The boon
// is STATIC (the player moves, not the cable), so it never moves and needs no per-tick
// update. (Racers only — see isEligiblePlayer; boardZipline guards re-entry so the engine
// double-dispatch + an already-aloft kart are both no-ops.)
class Zipline extends Boon {
	constructor(x, y, rail, ownerId, roomSig) {
		super(x, y, c.boons.zipline.radius, c.boons.zipline.color, ownerId, roomSig);
		this.id = c.boons.zipline.id;
		// Hold the rail directly (NOT via the Hazard rail param, which would set moveable
		// and try to Hazard.move() undefined newX) so the boon stays static at the origin
		// post while still shipping the rail's geometry on the wire (compressor.newHazards).
		this.rail = rail;
		this.railLengthAuthored = true; // ship rail.width (the author-set span) on wire slot [9]
		this.angle = rail.angle;        // origin-post facing (also drawn by the editor/HUD)
		this.speed = c.boons.zipline.speed;
		this.staminaDrainPerSec = c.boons.zipline.staminaDrainPerSec;
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object) || typeof object.boardZipline !== "function") {
			return;
		}
		object.boardZipline(this.rail, this.speed, this.staminaDrainPerSec);
	}
}

registerBoonKind("zipline", {
	railed: true,
	directional: true,
	build: function (entry, mapID, roomSig) {
		// Author-set span: the rail length comes from the map entry (entry.length), clamped
		// to the config bounds. Falls back to minLength for a legacy/malformed entry.
		var z = c.boons.zipline;
		var len = (typeof entry.length === "number" && isFinite(entry.length)) ? entry.length : z.minLength;
		len = Math.max(z.minLength, Math.min(z.maxLength, len));
		var rail = new HazardRail(entry.x, entry.y, len, z.height, entry.angle, z.color, mapID, roomSig);
		return new Zipline(entry.x, entry.y, rail, mapID, roomSig);
	}
});

// Lily Pads — drivable stepping-stones over water. While a racer overlaps a NOT-fully-sunk
// pad, its handleHit stamps the racer's onLilyPadUntil for this tick (checkCollisions runs
// before updatePlayers), and Player.handleMapCellHit's water branch reads it to give solid
// footing — you skim across instead of swimming. But the pad SINKS while stood on: netState
// climbs to 100 (fully submerged) over sinkMs, at which point it stops granting footing and
// the racer drops into the punch-swim water below. Step off and it REFLOATS over refloatMs.
// netState (the sink %) rides the wire so the client draws the pad settling. Occupancy is a
// timestamp (occupiedUntil, refreshed each overlap tick with a little grace) so a one-tick
// gap between overlaps doesn't flicker it back to floating. (Racers only — see
// isEligiblePlayer; a zombie can't enter water and never stands on a pad.)
class LilyPad extends Boon {
	constructor(x, y, radius, angle, ownerId, roomSig) {
		super(x, y, radius, c.boons.lilyPad.color, ownerId, roomSig);
		this.id = c.boons.lilyPad.id;
		// Cosmetic per-pad random rotation (baked by the editor) — shipped on the angle wire
		// slot so the in-game leaf rotation + the ~30% lotus-bloom roll (keyed off the angle)
		// MATCH the editor. Without this the wire would ship the Hazard default 0 and every
		// pad would render unrotated + identical in-game.
		this.angle = (typeof angle === "number" && isFinite(angle)) ? angle : 0;
		this.sizable = true;      // ship the per-instance (author-resized) radius on the wire ([8])
		this.sinkMs = c.boons.lilyPad.sinkMs;
		this.refloatMs = c.boons.lilyPad.refloatMs;
		this.netState = 0;        // wire slot: sink %, 0 = floating .. 100 = fully sunk
		this.occupiedUntil = 0;   // refreshed each overlap tick; sink rises while in the future
	}
	handleHit(object) {
		if (!this.isEligiblePlayer(object)) {
			return;
		}
		// A fully-sunk pad gives no footing — the racer is left to the swim below.
		if (this.netState >= 100) {
			return;
		}
		// Solid this tick: handleMapCellHit reads onLilyPadUntil (set with a tick's grace so
		// brief non-overlap between ticks doesn't refloat-flicker). occupiedUntil drives the
		// sink in update() (same grace).
		var now = Date.now();
		object.onLilyPadUntil = now + 60;
		this.occupiedUntil = now + 60;
	}
	// Per tick (gameBoard.updateHazards): climb the sink while occupied, otherwise refloat.
	update(dt) {
		var step = (dt || 0) * 1000;
		if (Date.now() < this.occupiedUntil) {
			this.netState = Math.min(100, this.netState + step / this.sinkMs * 100);
		} else {
			this.netState = Math.max(0, this.netState - step / this.refloatMs * 100);
		}
	}
}

// Resolve a lily pad's per-instance radius from its map entry: clamp the author-resized value
// to [minRadius, radius] (config = the editor's drag bounds) so a crafted/legacy map can't ship
// an over-sized pad; a missing/non-finite value falls back to the DEFAULT — the midpoint of the
// range, matching the size the editor places a fresh pad at. Mirrors vortexWellRadius.
function lilyPadRadius(entry) {
	var cfg = c.boons.lilyPad;
	var min = cfg.minRadius, max = cfg.radius;
	var r = (entry != null && Number.isFinite(entry.radius)) ? entry.radius : (min + max) / 2;
	if (r < min) { r = min; } else if (r > max) { r = max; }
	return r;
}

registerBoonKind("lilyPad", {
	railed: false,
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new LilyPad(entry.x, entry.y, lilyPadRadius(entry), entry.angle, mapID, roomSig);
	}
});

// Warp Pad — a paired teleporter (the WarpPad class lives in hazards.js with the other
// placeable machinery — linkWarpPads, the cellGraph shortcut, gameBoard.updateWarpPads —
// since it predates the boon reclassification and is cross-cutting; here we just register
// it as a BOON, so config.boons.warpPad supplies its id and the editor files it under
// Boons). Authored as a PAIR (two-click); the genuinely hard part is the AI cellGraph
// shortcut, not the teleport. See WarpPad / linkWarpPads in hazards.js.
registerBoonKind("warpPad", {
	railed: false,
	directional: false, // symmetric portal — the exit heading is your preserved velocity, not an angle
	build: function (entry, mapID, roomSig) {
		return new WarpPad(entry.x, entry.y, mapID, roomSig, entry.pair);
	}
});

module.exports = { Boon, DashArrows, RechargeSpring, Slipstream, GuardHalo, SecondWindTotem, LaunchPad, BarrelCannon, SlingshotRings, Zipline, LilyPad };
