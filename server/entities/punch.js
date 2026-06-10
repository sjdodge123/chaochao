'use strict';
var { Circle } = require('./shapes.js');

class Punch extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig, punchBonus, infected, ownerTeamId) {
		super(x, y, radius, color);
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.isPunch = true;
		this.ownerInfected = infected;
		// Team friendly-fire gate (Player.handlePunchHit) + the teammate-clash skip
		// read this. A constructor param (not a post-construction stamp) so a future
		// punch site can't silently ship with friendly fire enabled by forgetting
		// the stamp; null (no team) deliberately fails open to FFA rules.
		this.ownerTeamId = (ownerTeamId != null) ? ownerTeamId : null;
		this.punchBonus = punchBonus;
		this.type = "player";
		this.mapOwned = false;
		// Clash bookkeeping (set by GameBoard.resolvePunchClashes / Player.handlePunchHit):
		// landed = already connected; clashed = nullified by a clash; clashResolved =
		// already processed by the clash pass. Initialised so reads never hit undefined.
		this.landed = false;
		this.clashed = false;
		this.clashResolved = false;
	}
	handleHit(object) {

	}
	getBonus() {
		return this.punchBonus;
	}
}

module.exports = { Punch };
