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
	// humans. Cart + trail always land (every bot reads as "skinned"); pattern and
	// border roll independently so the mix varies. Cosmetic ids ride the normal
	// spawn packet (compressor slots 13-16), so the client needs nothing special.
	dressBotRandomly(bot) {
		var bySlot = { cart: [], pattern: [], trail: [], border: [] };
		for (var i = 0; i < skinRegistry.SKINS.length; i++) {
			var s = skinRegistry.SKINS[i];
			if (bySlot[s.slot]) {
				bySlot[s.slot].push(s.id);
			}
		}
		var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
		bot.cart = pick(bySlot.cart);
		bot.trailFx = pick(bySlot.trail);
		if (Math.random() < 0.7) {
			bot.pattern = pick(bySlot.pattern);
		}
		if (Math.random() < 0.5) {
			bot.border = pick(bySlot.border);
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
