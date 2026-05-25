'use strict';

// End-of-match medal tallying. Mixed into Game.prototype, so methods use `this`.
module.exports = {
	gatherAchievements() {
		var achievements = {
			mostKills: { ids: [], value: 0, title: "Serial killer" },
			savior: { ids: [], value: 0, title: "Savior" },
			survivalist: { ids: [], value: 0, title: "Survivalist" },
			brutalist: { ids: [], value: 0, title: "Brutalist" },
			mostMurdered: { ids: [], value: 0, title: "Picked on" },
			resourceful: { ids: [], value: 0, title: "Resouceful" },
			bully: { ids: [], value: 0, title: "Bully" },
			doubleKill: { ids: [], value: 0, title: "Double Kill" },
			tripleKill: { ids: [], value: 0, title: "Triple Kill" },
			megaKill: { ids: [], value: 0, title: "Mega Kill" },
		};
		for (var id in this.playerList) {
			var player = this.playerList[id];

			//Best Murderer
			this.checkForNewMedalHolder(achievements.mostKills, id, player.totalKills);

			//Savior
			if (player.savior > 0) {
				achievements.savior.ids.push(id);
			}

			//Survivalist
			this.checkForNewMedalHolder(achievements.survivalist, id, player.survivalist);

			//Brutalist
			this.checkForNewMedalHolder(achievements.brutalist, id, player.brutalist);

			//Bully
			this.checkForNewMedalHolder(achievements.bully, id, player.bully);

			//Resourceful
			this.checkForNewMedalHolder(achievements.resourceful, id, player.resourceful);

			//Picked on
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
			if (mostKilled != null) {
				for (var murderID in mostKilled) {
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
