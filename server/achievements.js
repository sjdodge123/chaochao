'use strict';

// Medal display names live in progression.js (MEDAL_TITLES) so the end-of-match medal
// cards here and the achievement requirement lines ("Earn the <medal> medal N times")
// can never drift apart.
var MEDAL_TITLES = require('./progression.js').MEDAL_TITLES;

// End-of-match medal tallying. Mixed into Game.prototype, so methods use `this`.
module.exports = {
	gatherAchievements() {
		var achievements = {};
		for (var stat in MEDAL_TITLES) {
			achievements[stat] = { ids: [], value: 0, title: MEDAL_TITLES[stat] };
		}
		// Competitive medals need a real opponent — 2+ humans present (guests count; bots don't).
		var humanCount = 0;
		for (var hid in this.playerList) { if (this.playerList[hid] && !this.playerList[hid].isAI) { humanCount++; } }
		var enoughHumans = (humanCount >= 2);
		for (var id in this.playerList) {
			var player = this.playerList[id];

			// Medals are HUMAN-only: a bot holding a self-medal would deny every human credit
			// for it that match (the progression award loop skips bots) and the card is a human
			// achievement — so bots never contend for the self-medals below.
			if (!player.isAI && enoughHumans) {
				//Best Murderer
				this.checkForNewMedalHolder(achievements.mostKills, id, player.totalKills);
				//Savior
				if (player.savior > 0) { achievements.savior.ids.push(id); }
				//Survivalist
				this.checkForNewMedalHolder(achievements.survivalist, id, player.survivalist);
				//Brutalist
				this.checkForNewMedalHolder(achievements.brutalist, id, player.brutalist);
				//Bully
				this.checkForNewMedalHolder(achievements.bully, id, player.bully);
				//Resourceful
				this.checkForNewMedalHolder(achievements.resourceful, id, player.resourceful);
				//Zombie Slayer — most kills landed while infected (zombie bites)
				this.checkForNewMedalHolder(achievements.zombieSlayer, id, player.zombieKillCount);
				//Heavy Hitter — most fully-charged wind-up punches thrown
				this.checkForNewMedalHolder(achievements.heavyHitter, id, player.heavyHitCount);
				//Pinball — most bumper bonks taken
				this.checkForNewMedalHolder(achievements.pinball, id, player.bumperHitCount);
				//Ice Skater — most distance slid across ice (rounded so a hair's difference
				//doesn't split the medal; integer keeps the tie logic clean)
				this.checkForNewMedalHolder(achievements.iceSkater, id, Math.round(player.iceDistanceTravelled));
				//Smooth Operator — most distance drifted on ice (holding a punch charge for
				//grip) WITHOUT the charge landing on anyone or burning up in lava. Uses
				//driftCreditTotal() so a kart still mid-drift at the match-ending tick gets
				//its final, not-yet-banked drift counted (reset() folds it in only afterward).
				this.checkForNewMedalHolder(achievements.smoothOperator, id, Math.round(player.driftCreditTotal()));
			}

			//Picked on — count kills by ANYONE (bots included), but only a HUMAN victim
			//can hold the medal.
			var mostKilled = null;
			for (var i = 0; i < player.killedPlayerList.length; i++) {
				var murderedID = player.killedPlayerList[i];
				if (mostKilled == null) {
					mostKilled = {};
					mostKilled[murderedID] = 1;
				} else {
					mostKilled[murderedID] += 1;
				}
			}
			if (mostKilled != null && enoughHumans) {
				for (var murderID in mostKilled) {
					var victim = this.playerList[murderID];
					if (victim && victim.isAI) { continue; }
					this.checkForNewMedalHolder(achievements.mostMurdered, murderID, mostKilled[murderID]);
				}
			}
		}
		return achievements;
	},
	checkForNewMedalHolder(medal, id, value) {
		if (value == 0) {
			return;
		}
		if (value >= medal.value) {
			if (value > medal.value) {
				medal.ids = [id];
			} else {
				medal.ids.push(id);
			}
			medal.value = value;
		}
	},
};
