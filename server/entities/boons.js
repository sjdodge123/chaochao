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
	}
	update() { }
	handleHit(object) { }
}

// Dash Arrows — a directional speed pad (the chevron strip). While a player or
// puck overlaps it, it adds a velocity impulse along the pad's facing each contact
// tick; the engine's maxVelocity clamp (engine.js) turns a couple of contact ticks
// into a snap to top speed in the arrow's direction. Self-limiting: the pad is
// small, so a boosted player is flung clear within a few ticks. Unlike the
// omnidirectional `fast` tile, the boost is purely along the author-set angle, so
// hitting it backwards fights it — placement and rotation are the authoring lever.
class DashArrows extends Boon {
	constructor(x, y, angle, ownerId, roomSig) {
		super(x, y, c.boons.dashArrows.radius, c.boons.dashArrows.color, ownerId, roomSig);
		this.id = c.boons.dashArrows.id;
		this.angle = angle;
		this.boost = c.boons.dashArrows.boost;
		this.boostCap = c.boons.dashArrows.boostCap;
	}
	handleHit(object) {
		if (!object.isPlayer && !object.isPuck) {
			return;
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

module.exports = { Boon, DashArrows };
