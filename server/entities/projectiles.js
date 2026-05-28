'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();
var messenger = require('../messenger.js');
var _engine = require('../engine.js');
var { Circle } = require('./shapes.js');

class Projectile extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color);
		this.alive = true;
		this.bounced = false;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.angle = angle;
		this.speed = 0;
		this.velX = 0;
		this.velY = 0;
		this.newX = this.x;
		this.newY = this.y;
		this.type = "";
	}
	update() {
		if (!this.alive) {
			return;
		}
		this.checkForBounce();
		this.move();
	}
	move() {
		this.x = this.newX;
		this.y = this.newY;
	}
	checkForBounce() {
		if (this.bounced) {
			this.bounced = false;
			messenger.messageRoomBySig(this.roomSig, "projBounced");
		}
	}
	handleHit(object) {

	}
}
class CloudProj extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.speed = c.brutalRounds.cloudy.speed;
		this.type = "cloud";
	}
	update() {
		if (!this.alive) {
			return;
		}
		this.move();
	}
}
class SnowFlakeProj extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.explosionRadius = c.tileMap.abilities.iceCannon.explosionRadius;
		this.speed = c.tileMap.abilities.iceCannon.speed;
		this.explodeIce = false;
		this.type = "snowFlake";
		this.tileChanges = {};

		this.explodeWaitTime = c.tileMap.abilities.iceCannon.lifetime;
		this.explodeTimer = null;
		this.explodeTimeLeft = this.explodeWaitTime;
	}
	update() {
		this.checkExplodeTimer();
		super.update();
	}
	checkExplodeTimer() {
		if (this.explodeTimer != null) {
			this.explodeTimeLeft = ((this.explodeWaitTime * 1000 - (Date.now() - this.explodeTimer)) / (1000)).toFixed(1);
			if (this.explodeTimeLeft > 0) {
				return;
			}
			this.explodeFlake();
			return;
		}
		this.explodeTimer = Date.now();
	}
	explodeFlake() {
		this.explodeIce = true;
		this.alive = false;
	}
	handleHit(object) {
		if (object.isMapCell) {
			// Empty holes are non-walkable; freezing one to ice would let players fill /
			// bridge a hole just by gliding a snowflake over it, defeating its no-walk
			// semantics. Skip it like lava/goal (explodeIce already skips it too).
			if (object.id != c.tileMap.lava.id && object.id != c.tileMap.goal.id && object.id != c.tileMap.slow.id && object.id != c.tileMap.empty.id) {
				this.tileChanges[object.voronoiId] = c.tileMap.ice.id;
			}
		}
	}
}
class BombProj extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.explosionRadius = c.tileMap.abilities.bomb.explosionRadius;
		this.speed = c.tileMap.abilities.bomb.speed;
		this.explode = false;
		this.type = "bomb";

		this.explodeWaitTime = c.tileMap.abilities.bomb.lifetime;
		this.explodeTimer = null;
		this.explodeTimeLeft = this.explodeWaitTime;
	}
	update() {
		this.checkExplodeTimer();
		super.update();
	}
	checkExplodeTimer() {
		if (this.explodeTimer != null) {
			this.explodeTimeLeft = ((this.explodeWaitTime * 1000 - (Date.now() - this.explodeTimer)) / (1000)).toFixed(1);
			if (this.explodeTimeLeft > 0) {
				return;
			}
			this.explodeBomb();
			return;
		}
		this.explodeTimer = Date.now();
	}
	explodeBomb() {
		this.explode = true;
		this.alive = false;
	}
}

class Puck extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.type = "puck";
		this.isPuck = true;
		this.speed = c.brutalRounds.hockey.baseSpeed;
	}
	handleHit(object) {
		if (object.isPunch && object.ownerId != this.ownerId) {
			_engine.punchPuck(this, object);
			messenger.messageRoomBySig(this.roomSig, "playerPunched", { owner: object.ownerId, victim: this.id, x: this.x, y: this.y });
			return;
		}
	}
}

module.exports = { Projectile, CloudProj, SnowFlakeProj, BombProj, Puck };
