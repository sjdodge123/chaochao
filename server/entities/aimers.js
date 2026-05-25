'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();
var messenger = require('../messenger.js');
var { Circle } = require('./shapes.js');

class ExplosionAimer extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color);
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.isExplosionAimer = true;
		this.alive = true;
		this.targetListAry = [];

		this.explode = false;
		this.explodeWaitTime = c.explosionWarnTime;
		this.explodeTimer = null;
		this.explodeTimeLeft = this.explodeWaitTime;
	}
	update() {
		if (!this.alive) {
			return;
		}
		if (this.radius < c.explosionRadius) {
			this.grow();
		}
		this.checkExplodeTimer();

	}
	grow() {
		this.radius += 2;
	}
	checkExplodeTimer() {
		if (this.explodeTimer != null) {
			this.explodeTimeLeft = ((this.explodeWaitTime * 1000 - (Date.now() - this.explodeTimer)) / (1000)).toFixed(1);
			if (this.explodeTimeLeft > 0) {
				return;
			}
			this.explodeTimer = null;
			this.explode = true;
			messenger.messageRoomBySig(this.roomSig, "terminateAimer", this.ownerId);
			return;
		}
		this.explodeTimer = Date.now();
	}
	killSelf() {
		this.alive = false;
	}
	handleHit() {

	}
}

class SwapAimer extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color);
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.isSwapAimer = true;
		this.alive = true;
		this.targetList = {};
		this.targetListAry = [];
		var index = setInterval(function (aimer) {
			aimer.targetList = {};
			aimer.targetListAry = [];
		}, 300, this);
		this.index = index;
	}
	update(owner) {
		if (owner.alive == false || owner.isZombie) {
			this.alive = false;
			messenger.messageRoomBySig(this.roomSig, "terminateAimer", this.ownerId);
			return;
		}
		if (this.radius < c.tileMap.abilities.swap.endSize) {
			this.grow();
		}
		this.move(owner);
	}
	grow() {
		this.radius += 2;
	}
	move(owner) {
		this.x = owner.x;
		this.y = owner.y;
	}
	handleHit(object) {
		if (object.isPlayer && object.id != this.ownerId && object.isZombie == false && this.alive) {
			if (this.targetList[object.id] == null) {
				this.targetList[object.id] = object;
				this.targetListAry.push(object.id);
			}
			return;
		}
	}
}

module.exports = { ExplosionAimer, SwapAimer };
