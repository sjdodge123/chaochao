'use strict';
var utils = require('./utils.js');
var messenger = require('./messenger.js');

// Reactive bot emotes: pick a chat-wheel emoji from the personality's emote set
// for an event category (win/kill/hurt/cheer/greet) and broadcast a one-shot
// botEmote. Each bot is rate-limited to one emote every 45-90s (randomized per bot
// so they don't all chime at once and the chatter stays sparse). Bots use the full
// emotional range — celebrating, clapping for others, reacting to hits — not just
// taunting. The client renders it as a speech bubble. The cooldown lives on the
// Player and is NOT cleared by reset(), so the cadence holds across rounds.
function emitBotEmote(player, category) {
	if (player == null || !player.isAI || player.profile == null) {
		return;
	}
	var emotes = player.profile.emotes;
	if (emotes == null || emotes[category] == null || emotes[category].length === 0) {
		return;
	}
	var now = Date.now();
	if (player.emoteReadyAt != null && now < player.emoteReadyAt) {
		return;
	}
	player.emoteReadyAt = now + utils.getRandomInt(45000, 90000);
	var opts = emotes[category];
	var emote = opts[Math.floor(Math.random() * opts.length)];
	messenger.messageRoomBySig(player.roomSig, "botEmote", { id: player.id, emote: emote });
}

// When a racer reaches the goal, other AI racers react — a wheel emote, often a
// clap/acknowledgement (cheer), throttled so only a couple pipe up.
function botsCheerFor(playerList, finisherId) {
	for (var id in playerList) {
		var p = playerList[id];
		if (p.isAI && p.alive && id !== finisherId && Math.random() < 0.3) {
			emitBotEmote(p, "cheer");
		}
	}
}

module.exports = { emitBotEmote, botsCheerFor };
