'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();
var messenger = require('../messenger.js');
var compressor = require('../compressor.js');
var { Rect } = require('./shapes.js');
var { Player } = require('./player.js');
var skinRegistry = require('../skinRegistry.js');

class World extends Rect {
	constructor(x, y, width, height, engine, playerList, hazardList, roomSig) {
		super(x, y, width, height, 0, "white");
		this.engine = engine;
		this.playerList = playerList;
		this.hazardList = hazardList;
		this.roomSig = roomSig;
		this.center = { x: width / 2, y: height / 2 };
	}
	update(dt) {

	}
	createNewPlayer(id) {
		var color = this.getUniqueColorR();
		var player = new Player(0, 0, 90, color, id, this.roomSig);
		return player;
	}
	// A headless AI racer: a Player with no socket, flagged isAI, given an
	// identity (name/title/personality) from the config cast. Reuses the same
	// unique-color picker so bots are visually distinct from the human and each
	// other. The bot brain (aiController) drives it via targetDirX/Y/braking.
	createNewBot(id, identity) {
		var color = this.getUniqueColorR();
		var bot = new Player(0, 0, 90, color, id, this.roomSig);
		bot.isAI = true;
		bot.name = identity.name;
		bot.title = identity.title;
		bot.personality = identity.id;
		// Full personality profile (trait weights) for the AI brain; the
		// suffix-numbered duplicates share their base personality's traits.
		bot.profile = identity;
		if (c.randomBotCosmetics) {
			this.dressBotRandomly(bot);
		}
		return bot;
	}
	// Dev/testing seam (RANDOM_BOT_COSMETICS, see utils.js): dress a bot in random
	// cosmetics so a local playtest shows the full skin spread without 9 signed-in
	// humans. Slots and their Player fields come straight from the registry
	// (SLOTS / SLOT_FIELD), so a newly-added slot is dressed automatically: cart +
	// trail always land (every bot reads as "skinned"), other slots roll their
	// listed chance (unlisted ones default to a coin flip). Cosmetic ids ride the
	// normal spawn packet (compressor slots 13-16), so the client needs nothing.
	dressBotRandomly(bot) {
		var chance = { cart: 1, trail: 1, pattern: 0.7, border: 0.5 };
		for (var i = 0; i < skinRegistry.SLOTS.length; i++) {
			var slot = skinRegistry.SLOTS[i];
			var field = skinRegistry.SLOT_FIELD[slot];
			var odds = (chance[slot] != null) ? chance[slot] : 0.5;
			if (field == null || Math.random() >= odds) {
				continue;
			}
			var ids = [];
			for (var k = 0; k < skinRegistry.SKINS.length; k++) {
				if (skinRegistry.SKINS[k].slot === slot) {
					ids.push(skinRegistry.SKINS[k].id);
				}
			}
			if (ids.length > 0) {
				bot[field] = utils.pick(ids);
			}
		}
	}
	spawnPlayerRandomLoc(player) {
		var loc = this.findFreeLoc(player);
		player.initialLoc = loc;
		player.x = loc.x;
		player.y = loc.y;
	}
	setSpawnLocation(player) {
		player.initialLoc = this.findFreeLoc(player);
	}
	getUniqueColorR() {
		var usedColors = {};
		for (var player in this.playerList) {
			usedColors[this.playerList[player].color] = true;
		}
		return utils.getUniqueColor(usedColors);
	}
	resize() {
		this.width = c.worldWidth;
		this.height = c.worldHeight;
		this.baseBoundRadius = this.width;
		this.center = { x: this.width / 2, y: this.height / 2 };
		this.engine.setWorldBounds(this.width, this.height);
		var data = compressor.worldResize(this);
		messenger.messageRoomBySig(this.roomSig, 'worldResize', data);
	}
}

module.exports = { World };
