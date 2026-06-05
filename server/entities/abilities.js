'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();
var messenger = require('../messenger.js');

class Ability {
	constructor(owner, roomSig) {
		this.id = null;
		this.roomSig = roomSig;
		this.ownerId = owner;
		this.alive = true;
	}
	update() {

	}
	use() {
		console.log("unimplemented");
	}
}
class Blindfold extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.id = c.tileMap.abilities.blindfold.id;
		this.blind = false;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		// Flag the room-wide blind so checkAbilities can record it for the AI
		// vision-fairness self-handicap (bots read state, not pixels).
		this.blind = true;
		messenger.messageRoomBySig(this.roomSig, "blindfoldUsed", this.ownerId);
	}
}
class Swap extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.swap = false;
		this.id = c.tileMap.abilities.swap.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.swap = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "swapUsed", this.ownerId);
	}
}
class IceCannon extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.spawnSnowFlake = false;
		this.id = c.tileMap.abilities.iceCannon.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.spawnSnowFlake = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "iceCannon", this.ownerId);
	}
}

class Bomb extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.spawnBomb = false;
		this.id = c.tileMap.abilities.bomb.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.spawnBomb = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "bombUsed", this.ownerId);
	}
}
class SpeedBuff extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.applyBuff = false;
		this.id = c.tileMap.abilities.speedBuff.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.applyBuff = true;
		messenger.messageRoomBySig(this.roomSig, "speedBuff", this.ownerId);
	}
}

class SpeedDebuff extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.applyDebuff = false;
		this.id = c.tileMap.abilities.speedDebuff.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.applyDebuff = true;
		messenger.messageRoomBySig(this.roomSig, "speedDebuff", this.ownerId);
	}
}
class TileSwap extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.tileSwap = false;
		this.id = c.tileMap.abilities.tileSwap.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.tileSwap = true;
		messenger.messageRoomBySig(this.roomSig, "tileSwap", this.ownerId);
	}
}

class Cut extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.applyCut = false;
		this.id = c.tileMap.abilities.cut.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.applyCut = true;
		messenger.messageRoomBySig(this.roomSig, "cutUsed", this.ownerId);
	}
}


class StarPower extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.applyStar = false;
		this.id = c.tileMap.abilities.starPower.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.alive = false;
		this.applyStar = true;
		messenger.messageRoomBySig(this.roomSig, "starPower", this.ownerId);
	}
}

class BombTrigger extends Ability {
	constructor(owner, roomSig) {
		super(owner, roomSig);
		this.explodeBomb = false;
		this.id = c.tileMap.abilities.bombTrigger.id;
	}
	use() {
		if (this.alive == false) {
			return;
		}
		this.explodeBomb = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig, "bombTriggered", this.ownerId);
	}
}

module.exports = { Ability, Blindfold, Swap, IceCannon, Bomb, SpeedBuff, SpeedDebuff, TileSwap, Cut, StarPower, BombTrigger };
