'use strict';
var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');

// Music-mood/track selection. Mixed into Game.prototype, so methods use `this`.
module.exports = {
	//The mood the room should be hearing right now: exciting overrides everything
	//when anyone is one notch from winning, otherwise brutal rounds get brutal music.
	computeMusicMood() {
		for (var id in this.playerList) {
			if (this.playerList[id].nearVictory == true) {
				return "exciting";
			}
		}
		if (this.gameBoard.brutalRound == true) {
			return "brutal";
		}
		return "calm";
	},
	//Pick a track name for a mood from the shared config manifest, avoiding an
	//immediate repeat of avoidTrack when the playlist has alternatives.
	pickMusicTrack(mood, avoidTrack) {
		var playlist = c.music[mood];
		if (playlist == null || playlist.length == 0) {
			return null;
		}
		if (playlist.length == 1) {
			return playlist[0];
		}
		var track = playlist[utils.getRandomInt(0, playlist.length - 1)];
		var attempts = 0;
		while (track == avoidTrack && attempts < 5) {
			track = playlist[utils.getRandomInt(0, playlist.length - 1)];
			attempts++;
		}
		return track;
	},
	//Set the room's music and remember when, so the fallback timer can recover
	//if no client ever reports the track ending. Also remember the pick per mood:
	//a mood that flips away and back shouldn't land on the track that just played
	//(client-side it may still be draining from the crossfade and would double up).
	setRoomMusic(mood, track) {
		this.currentMusic = { mood: mood, track: track };
		this.musicChangedAt = Date.now();
		if (this.lastTrackByMood == null) { this.lastTrackByMood = {}; }
		this.lastTrackByMood[mood] = track;
	},
	//Called at startOverview (round settled): if the room's mood changed (someone
	//hit/left near-victory), pick a track for the new mood and tell every client
	//to switch. Deliberately NOT called mid-race — an instant mood flip the moment
	//the win condition changes hands felt jarring (see game.js update loop).
	updateMusicMood() {
		if (this.currentMusic == null) {
			return;
		}
		var desiredMood = this.computeMusicMood();
		if (desiredMood == this.currentMusic.mood) {
			return;
		}
		this.setRoomMusic(desiredMood, this.pickMusicTrack(desiredMood, (this.lastTrackByMood || {})[desiredMood]));
		messenger.messageRoomBySig(this.roomSig, "musicMood", this.currentMusic);
	},
	//A client reported its background track finished. Background tracks don't loop,
	//so pick the next one for the current mood and broadcast it, keeping music
	//continuous and in sync. Stale reports for an already-rotated track are ignored.
	rotateMusicTrack(endedTrack) {
		if (this.currentMusic == null || this.currentMusic.track != endedTrack) {
			return;
		}
		var mood = this.currentMusic.mood;
		this.setRoomMusic(mood, this.pickMusicTrack(mood, endedTrack));
		messenger.messageRoomBySig(this.roomSig, "musicMood", this.currentMusic);
	},
	//Safety net: clients normally drive rotation by reporting "ended" (precise,
	//per-track). But if every client is muted/backgrounded/autoplay-blocked, that
	//report never comes. If the current track has been playing past the fallback
	//window (set above the longest track so it never cuts normal playback), advance
	//it anyway so the room never gets stuck in silence.
	checkMusicFallback() {
		if (this.currentMusic == null || this.musicChangedAt == null) {
			return;
		}
		if (Date.now() - this.musicChangedAt < c.musicFallbackSeconds * 1000) {
			return;
		}
		var mood = this.currentMusic.mood;
		this.setRoomMusic(mood, this.pickMusicTrack(mood, this.currentMusic.track));
		messenger.messageRoomBySig(this.roomSig, "musicMood", this.currentMusic);
	},
};
