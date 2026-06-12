'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();
var { Rect, Circle } = require('./shapes.js');
var { Punch } = require('./punch.js');

class HazardRail extends Rect {
	constructor(x, y, width, height, angle, color, ownerId, roomSig) {
		super(x, y, width, height, angle, color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.lengthSq = this.width * this.width;
	}
	update() {
		if (this.alive == false) {
			return;
		}
	}
	handleHit(object) {
		console.log("hazard rail hit");
	}
}

class Hazard extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig, rail) {
		super(x, y, radius, color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.moveable = false;
		this.id = -1;
		this.speed = 0;
		this.angle = 0;
		this.lengthSq = this.radius * radius;
		if (rail != null) {
			this.moveable = true;
			this.rail = rail;
		}
	}
	update() {
		if (this.alive == false) {
			return;
		}
		this.move();
	}
	move() {
		this.x = this.newX;
		this.y = this.newY;
	}
	handleHit(object) {

	}
}
class Bumper extends Hazard {
	constructor(x, y, radius, color, ownerId, roomSig, rail) {
		super(x, y, radius, color, ownerId, roomSig, rail);
		this.id = c.hazards.bumper.id;
		if (this.rail != null) {
			this.speed = c.hazards.movingBumper.speed;
			this.id = c.hazards.movingBumper.id;
			this.angle = this.rail.angle;
		}
		this.punch = null;
	}
	handleHit(object) {
		if (!object.isPlayer && !object.isPuck) {
			return;
		}
		if (this.punch == null) {
			this.punch = new Punch(this.x, this.y, c.hazards.bumper.attackRadius, c.hazards.bumper.color, this.ownerId, this.roomSig, c.hazards.bumper.punchBonus, false, null);
			this.punch.mapOwned = true;
			this.punch.type = "bumper";
		}
	}
}

// --- hazard-kind registry ------------------------------------------------------
// Single source of truth for the map-authorable hazard kinds. Everything with
// per-kind behavior keys off this: gameBoard.generateHazards builds via
// kind.build, utils.validateMap enforces kind.railed => finite angle, and the
// lightning brutal round speeds up every railed kind. Adding a new hazard kind
// server-side = a config.hazards entry + one registerHazardKind call here (the
// client needs a matching drawer in draw.js and an editor entry in create.js).
//
// Kind contract:
//   railed — rides a HazardRail; map entries must carry a finite .angle, and
//            compressor.newHazards ships the rail origin/angle so clients draw
//            the rail from its true origin (not wherever the hazard happens to
//            be when a spectator joins mid-round).
//   build(entry, mapID, roomSig) — construct the live hazard from its map JSON
//            entry ({id, x, y, [angle]}). Must return a Hazard subclass.
var HAZARD_KINDS = {};
var _kindById = {};
function registerHazardKind(key, def) {
	def.key = key;
	def.id = c.hazards[key].id;
	HAZARD_KINDS[key] = def;
	_kindById[def.id] = def;
}
function hazardKindById(id) {
	return Object.prototype.hasOwnProperty.call(_kindById, id) ? _kindById[id] : null;
}

registerHazardKind("bumper", {
	railed: false,
	build: function (entry, mapID, roomSig) {
		return new Bumper(entry.x, entry.y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, roomSig);
	}
});
registerHazardKind("movingBumper", {
	railed: true,
	build: function (entry, mapID, roomSig) {
		var rail = new HazardRail(entry.x, entry.y, c.hazards.movingBumper.width, c.hazards.movingBumper.height, entry.angle, c.hazards.bumper.color, mapID, roomSig);
		return new Bumper(entry.x, entry.y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, roomSig, rail);
	}
});

module.exports = { HazardRail, Hazard, Bumper, HAZARD_KINDS, hazardKindById, registerHazardKind };
