'use strict';
var { Circle } = require('./shapes.js');

class Punch extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig, punchBonus, infected) {
		super(x, y, radius, color);
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.isPunch = true;
		this.ownerInfected = infected;
		this.punchBonus = punchBonus;
		this.type = "player";
		this.mapOwned = false;
	}
	handleHit(object) {

	}
	getBonus() {
		return this.punchBonus;
	}
}

module.exports = { Punch };
