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

// A sentry-turret shot (the Sentry Turret hazard's projectile). It rides the same
// projList wire the abilities use, but with its OWN type ("turretShot") so the client
// gives it a unique look (a glowing red energy bolt, draw.js) and its own fire/impact
// SFX — not the iceCannon's snowflake sprite + sounds. It resolves as a recoverable
// SHOVE, NOT a terrain freeze: an auto-firing turret reusing the iceCannon's freeze
// (which ices every cell the shot crosses each tick + a 100px burst) would runaway-ice
// the whole arena, so the shot mutates no terrain and only knocks karts off course via
// gameBoard.shoveShot -> applyExplosionForce. Its distinct type also means
// engine/gameBoard's snowFlake-only cell-collision is skipped for it (it flies THROUGH
// terrain — wanted). It detonates on the first live racer it touches (a tracked shot
// connecting) OR on its fuse (the max-range failsafe), whichever comes first. The owner
// is the turret hazard's mapID, so there's no player to recoil or credit.
class TurretShot extends Projectile {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig, angle);
		this.speed = c.hazards.sentryTurret.shotSpeed;
		this.type = "turretShot";   // unique client drawer (draw.js) + fire/impact SFX
		this.shove = false;         // gameBoard.updateProjectiles picks this up -> knockback
		// Fuse (the max-range failsafe). Date.now-based like SnowFlakeProj so the
		// headless clock (which mocks Date.now) ages it deterministically per tick.
		this.fuse = c.hazards.sentryTurret.shotLifetime;
		this.fuseTimer = null;
	}
	update() {
		this.checkFuse();
		super.update();
	}
	checkFuse() {
		if (this.fuseTimer != null) {
			if (Date.now() - this.fuseTimer < this.fuse * 1000) {
				return;
			}
			this.detonate();
			return;
		}
		this.fuseTimer = Date.now();
	}
	detonate() {
		this.shove = true;
		this.alive = false;
	}
	// Detonate on the first live racer OR antlion it touches. Pass through terrain (no
	// icing) and ignore protected/star karts — a brush past one of those shouldn't waste
	// the shot mid-flight (the knockback already shrugs them off downstream). Antlions
	// (the chasing brutal-round hazard) are valid targets: the burst knocks them back
	// via their impulse channel (gameBoard.shoveAntlions).
	handleHit(object) {
		if (object.isAntlion && object.alive !== false) {
			this.detonate();
			return;
		}
		if (!object.isPlayer || object.alive === false) {
			return;
		}
		if (object.isProtected() || object.hasStarPower()) {
			return;
		}
		this.detonate();
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

module.exports = { Projectile, CloudProj, SnowFlakeProj, BombProj, TurretShot, Puck };
