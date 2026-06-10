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

module.exports = { HazardRail, Hazard, Bumper };
