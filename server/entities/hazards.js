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

// A pinball slingshot wall: a static, rotated line segment that flings players
// (and pucks) away on contact via the same map-owned punch machinery the round
// bumpers use. The punch spawns at the nearest point on the wall's centerline to
// the victim, so the shove reads as a perpendicular kick off the face (and a
// radial one off the end caps). No `radius` property on purpose — Shape.inBounds
// dispatches on it, and a radius here would make players collide with the wall
// as a circle instead of the rotated rect.
class BumperWall extends Rect {
	constructor(x, y, width, height, angle, color, ownerId, roomSig) {
		super(x, y, width, height, angle, color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.moveable = false;
		this.isWall = true;
		this.id = c.hazards.bumperWall.id;
		this.speed = 0;
		this.punch = null;
		// Centerline endpoints (anchor -> anchor + width along angle), consumed by
		// handleHit and the AI's repulsion field / path penalties.
		var rad = (this.angle || 0) * (Math.PI / 180);
		this.ax = this.x;
		this.ay = this.y;
		this.bx = this.x + Math.cos(rad) * this.width;
		this.by = this.y + Math.sin(rad) * this.width;
	}
	// True rotated corners (base Rect treats width/height as far-corner coords,
	// which only works for axis-aligned, origin-anchored rects). Called by the
	// Rect constructor, so it must only read x/y/width/height/angle.
	getVertices() {
		var rad = (this.angle || 0) * (Math.PI / 180);
		var dx = Math.cos(rad), dy = Math.sin(rad);
		var nx = -dy * (this.height / 2), ny = dx * (this.height / 2);
		var bx = this.x + dx * this.width, by = this.y + dy * this.width;
		return [
			{ x: this.x + nx, y: this.y + ny },
			{ x: bx + nx, y: by + ny },
			{ x: bx - nx, y: by - ny },
			{ x: this.x - nx, y: this.y - ny }
		];
	}
	// Base Rect.getExtents skips the last vertex (length - 1 loop); for a rotated
	// wall that drops a whole corner from the quadtree AABB, so cover all four.
	getExtents() {
		var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (var i = 0; i < this.vertices.length; i++) {
			var v = this.vertices[i];
			if (v.x < minX) { minX = v.x; }
			if (v.x > maxX) { maxX = v.x; }
			if (v.y < minY) { minY = v.y; }
			if (v.y > maxY) { maxY = v.y; }
		}
		return { minX, maxX, minY, maxY };
	}
	closestOnLine(px, py) {
		var abx = this.bx - this.ax, aby = this.by - this.ay;
		var len2 = abx * abx + aby * aby;
		if (len2 < 1e-6) { return { x: this.ax, y: this.ay }; }
		var t = ((px - this.ax) * abx + (py - this.ay) * aby) / len2;
		if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
		return { x: this.ax + abx * t, y: this.ay + aby * t };
	}
	update() {
		if (this.alive == false) {
			return;
		}
	}
	handleHit(object) {
		if (!object.isPlayer && !object.isPuck) {
			return;
		}
		if (this.punch == null) {
			var hit = this.closestOnLine(object.newX || object.x, object.newY || object.y);
			this.punch = new Punch(hit.x, hit.y, c.hazards.bumperWall.attackRadius, c.hazards.bumperWall.color, this.ownerId, this.roomSig, c.hazards.bumperWall.punchBonus, false, null);
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
//   railed — rides a HazardRail; compressor.newHazards ships the rail
//            origin/angle so clients draw the rail from its true origin (not
//            wherever the hazard happens to be when a spectator joins
//            mid-round). Implies directional.
//   directional — the map entry must carry a finite .angle (validateMap
//            rejects it otherwise; a non-finite angle NaNs the rail/segment
//            math). True for railed kinds and for static rotated kinds like
//            the bumper wall.
//   build(entry, mapID, roomSig) — construct the live hazard from its map JSON
//            entry ({id, x, y, [angle]}). Must return a Hazard/Rect subclass.
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
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new Bumper(entry.x, entry.y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, roomSig);
	}
});
registerHazardKind("movingBumper", {
	railed: true,
	directional: true,
	build: function (entry, mapID, roomSig) {
		var rail = new HazardRail(entry.x, entry.y, c.hazards.movingBumper.width, c.hazards.movingBumper.height, entry.angle, c.hazards.bumper.color, mapID, roomSig);
		return new Bumper(entry.x, entry.y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, roomSig, rail);
	}
});
registerHazardKind("bumperWall", {
	railed: false,
	directional: true,
	build: function (entry, mapID, roomSig) {
		return new BumperWall(entry.x, entry.y, c.hazards.bumperWall.width, c.hazards.bumperWall.height, entry.angle, c.hazards.bumperWall.color, mapID, roomSig);
	}
});

module.exports = { HazardRail, Hazard, Bumper, BumperWall, HAZARD_KINDS, hazardKindById, registerHazardKind };
