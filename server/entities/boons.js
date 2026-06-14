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
var { Hazard, registerBoonKind } = require('./hazards.js');

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
class RechargeSpring extends Boon {
	constructor(x, y, ownerId, roomSig) {
		super(x, y, c.boons.rechargeSpring.radius, c.boons.rechargeSpring.color, ownerId, roomSig);
		this.id = c.boons.rechargeSpring.id;
		this.cooldownMs = c.boons.rechargeSpring.cooldownMs;
		this.rechargeReadyAt = 0;   // Date.now() the spring is ready again (<= now == ready)
		this.netState = 100;        // wire slot: refill percent, 100 = ready (drawn telegraph)
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
	handleHit(object) {
		if (!this.isEligiblePlayer(object) || typeof object.rechargeFromSpring !== "function") {
			return;
		}
		if (Date.now() < this.rechargeReadyAt) {
			return; // still refilling — no charge to give
		}
		// Only spend the charge if the racer actually needed it (rechargeFromSpring
		// returns false for an already-topped-up kart), so a full racer doesn't drain
		// a ready spring for nothing.
		if (object.rechargeFromSpring()) {
			this.rechargeReadyAt = Date.now() + this.cooldownMs;
			this.netState = 0;
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

module.exports = { Boon, DashArrows, RechargeSpring, Slipstream };
