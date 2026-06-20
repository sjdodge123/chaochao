var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');
var game = require('./game.js');
var botGuard = require('./botGuard.js');

var roomList = {},
	maxPlayersInRoom = c.maxPlayersInRoom;

// Discord Activity instance -> room routing (Phase 5). Every player who launches the
// Activity in the same Discord voice channel shares one `instanceId`; we key a room to
// it so they all land in the SAME match. A different voice channel / instance gets a
// different room. This map is the instanceId -> room sig index; entries are cleared
// when the backing room is deleted (last client left), so a fresh launch into a
// recycled instance id spins up a clean room. Discord-keyed rooms are tagged
// `room.discordInstanceId` and are kept PRIVATE — never advertised on the join page
// (getRooms) nor matchmade into by web players (findARoom) — which also keeps voice
// groups isolated, so identity stays within the group (no cross-server mixing to
// anonymize). Untrusted: instanceId is just a grouping key, never a trust boundary.
var instanceRoomMap = {};


exports.getRooms = function () {
	var rooms = {};
	if (getRoomCount() == 0) {
		return rooms;
	}
	for (var sig in roomList) {
		var room = roomList[sig];
		// Preview rooms are private local-co-op play-tests; never list them.
		if (room.isPreview) {
			continue;
		}
		// Tarpit is a dead room for flagged bots — never advertise it on the join page.
		if (room.isTarpit) {
			continue;
		}
		// Discord Activity rooms are private to one voice-channel instance — never
		// list them on the public join page (a web player must never see/join one).
		if (room.discordInstanceId) {
			continue;
		}
		// Late-join: a started (locked) match is now joinable as long as it has
		// space — the joiner spectates the current round and races from the next
		// (determineGameState's racing branch). Only a FULL room is unjoinable, and
		// it's still listed (greyed "Full") rather than silently vanishing. `locked`
		// is sent alongside so the join page can label an in-progress room as such.
		var joinable = room.hasSpace();
		// AI hub: surface the room's bots so the join page shows them. aiCount is the
		// LIVE bot count (non-zero during a race). aiPlanned is how many bots will
		// actually spawn NEXT race for the current human count — computed for every
		// mode (explicit count, Off, or Auto's triangular-tier fill), clamped to room
		// capacity — and aiAuto flags the Auto mode so the page can label it.
		var humans = 0, aiCount = 0;
		for (var pid in room.playerList) {
			if (room.playerList[pid] == null) { continue; }
			if (room.playerList[pid].isAI) { aiCount++; } else { humans++; }
		}
		var capLeft = (c.maxPlayersInRoom || 25) - humans;
		if (capLeft < 0) { capLeft = 0; }
		var aiAuto = (room.game.botOverride == null);
		var aiPlanned;
		if (aiAuto) {
			aiPlanned = utils.autoBotsForHumans(humans, capLeft);
		} else {
			aiPlanned = room.game.botOverride.enabled ? room.game.botOverride.count : 0;
			if (aiPlanned > capLeft) { aiPlanned = capLeft; }
		}
		rooms[sig] = {
			state: room.game.currentState,
			// Room game mode, so the join page can label every card with what kind
			// of game it is (Standard FFA / Brutal FFA / teams) before joining.
			mode: room.game.gameBoard.gameModeId,
			round: room.game.gameBoard.round,
			currentMap: room.game.gameBoard.currentMap.name,
			gameID: Number(sig),
			players: room.game.playerCount,
			playerColors: room.game.getPlayerColors(),
			joinable: joinable,
			locked: room.isLocked(),
			aiCount: aiCount,
			aiPlanned: aiPlanned,
			aiAuto: aiAuto,
		}
	}
	return rooms;
}
// Rooms currently mid-race (gate raised through collapse). The deploy
// workflow polls this via /ops/status after a drain to wait for in-flight
// races to finish before pushing a new build. Preview play-tests and tarpit
// rooms never hold up a deploy.
exports.countActiveRaces = function () {
	var count = 0;
	for (var sig in roomList) {
		var room = roomList[sig];
		if (room.isPreview || room.isTarpit) { continue; }
		var state = room.game.currentState;
		if (state == c.stateMap.gated || state == c.stateMap.racing || state == c.stateMap.collapsing) {
			count++;
		}
	}
	return count;
}
exports.findARoom = function (clientID) {
	if (getRoomCount() == 0) {
		var sig = generateNewRoom();
		console.log("No rooms exist; Starting a new room:" + sig);
		return sig;
	}
	for (var sig2 in roomList) {
		// Never matchmake a stranger into a preview play-test room. Preview rooms now
		// hold several local-co-op players (capacity > 1), and they get unlocked at
		// game-over (resetGame), so the old "locked + capacity 1" implicit guard no
		// longer keeps them private — exclude them explicitly here.
		if (roomList[sig2].hasSpace() && !roomList[sig2].isLocked() && !roomList[sig2].isPreview && !roomList[sig2].isTarpit && !roomList[sig2].discordInstanceId) {
			return sig2;
		}
	}
	return generateNewRoom();
}
// Discord Activity routing (Phase 5): find (or create) the room for a Discord
// `instanceId` so everyone who launched the Activity in the same voice channel shares
// one match. Unlike findARoom this DOES return a started/locked room (the joiner lands
// as a late-join spectator and races from the next round — same voice group, so we
// want them together even mid-match), as long as it still has space. The room is
// tagged so getRooms/findARoom keep it private to the instance. If the mapped room is
// full, we spin up a fresh room and re-point the instance at it (a voice channel that
// outgrows one room's capacity overflows into a second — rare; room cap is 25).
exports.findOrCreateRoomForInstance = function (instanceId) {
	var sig = instanceRoomMap[instanceId];
	var room = (sig != null) ? roomList[sig] : null;
	if (room != null && room.hasSpace()) {
		return sig;
	}
	if (room != null && !room.hasSpace()) {
		console.log("Discord instance " + instanceId + " room " + sig + " full; spilling into a new room.");
	}
	var newSig = generateNewRoom();
	roomList[newSig].discordInstanceId = instanceId;
	instanceRoomMap[instanceId] = newSig;
	console.log("Discord instance " + instanceId + " -> room " + newSig);
	return newSig;
}
// Explicit "Start a new game": always spin up a fresh room, never matchmake into an
// existing one (that's findARoom's job). Used by enterGame's id == -2 sentinel.
exports.startNewRoom = function () {
	var sig = generateNewRoom();
	console.log("Starting a fresh room on request:" + sig);
	return sig;
}
exports.kickFromRoom = function (clientID) {
	var room = searchForRoom(clientID);
	if (room != undefined) {
		room.leave(clientID);
		if (room.clientCount == 0) {
			console.log("Deleting room");
			forgetInstanceRoom(room);
			delete roomList[room.sig];
		}
	}
}
// Drop the instanceId -> sig index entry when a Discord-keyed room is torn down, so a
// later launch into a recycled instance id starts a clean room (and the map can't grow
// unboundedly). No-op for non-Discord rooms.
function forgetInstanceRoom(room) {
	if (room && room.discordInstanceId && instanceRoomMap[room.discordInstanceId] === room.sig) {
		delete instanceRoomMap[room.discordInstanceId];
	}
}
exports.joinARoom = function (sig, clientID) {
	var room = roomList[sig];
	if (room == null) {
		return false;
	}
	// Only a botGuard-flagged client may enter the tarpit. A normal player following a
	// shared/guessed ?gameid= link that happens to hit the tarpit's ordinary room id is
	// rejected here (-> roomNotFound) rather than being stranded in a room that never ticks.
	if (room.isTarpit && !botGuard.shouldTarpit(clientID)) {
		return false;
	}
	// A preview room is a private local-co-op play-test (capacity PREVIEW_COOP_CAP):
	// the creator's extra local players join here by its exact sig. Only reject once
	// it's full. It's never advertised (getRooms skips isPreview) nor matchmade into
	// (findARoom skips isPreview), so the only outside vector is a correctly-guessed
	// sig during the short preview window — acceptable for a play-test tool.
	if (room.isPreview && !room.hasSpace()) {
		return false;
	}
	// Late-join: a started (locked) match can now be joined as long as it has
	// space. The joiner lands as a temp spectator (determineGameState's racing /
	// collapsing branch) and races from the next round. Matchmaking (id == -1)
	// never resolves to a locked room — findARoom filters them — so a locked room
	// only reaches here via a deliberate join (the join page, "Join by ID", a
	// shared ?gameid= link, or a local co-op seat), which is exactly the intent.
	// Capacity is still enforced for everyone; preview-full is handled above.
	if (!room.isPreview && !room.hasSpace()) {
		return false;
	}
	room.join(clientID);
	return room;
}
exports.updateRooms = function (dt) {
	for (var sig in roomList) {
		var room = roomList[sig];
		if (room == null) {
			delete roomList[sig];
			continue;
		}
		// The tarpit is intentionally NEVER ticked: a flagged bot diverted here gets a
		// valid waiting-room gameState and then sits forever — no state transitions, no
		// gameUpdates, no AI fill, no real match. This is the whole tarpit mechanism and
		// it keeps game.js untouched.
		if (room.isTarpit) {
			continue;
		}
		room.update(dt);
		/*
		if(!room.game.gameEnded){
			room.update(dt);
		} else if(room.alive){
			room.alive = false;
			messenger.messageRoomBySig(room.sig,"gameOver",room.game.winner);
			reclaimRoom(room.sig); //setTimeout(reclaimRoom,roomKickTimeout*1000,room.sig);
		}
		*/
	}
}
exports.getRoomBySig = function (sig) {
	return roomList[sig];
}
// Lazily create (and re-create if reclaimed) the singleton tarpit room — a high-capacity
// room that findARoom never matchmakes into, getRooms never lists, and updateRooms never
// ticks. messenger.enterGame diverts botGuard-flagged clients here so they sit in a dead
// waiting room instead of polluting real matches. Returns its sig.
var tarpitSig = null;
exports.getTarpitRoom = function () {
	if (tarpitSig != null && roomList[tarpitSig] != null) {
		return tarpitSig;
	}
	var sig = generateRoomSig();
	var room = game.getRoom(sig, 500);
	room.isTarpit = true;
	roomList[sig] = room;
	tarpitSig = sig;
	console.log("Created tarpit room: " + sig);
	return sig;
}
// Local co-op cap for a preview play-test, mirroring the client's LOCAL_PLAYER_CAP
// (client/scripts/game.js). Keep the two in lockstep if either changes.
var PREVIEW_COOP_CAP = 4;
// Create an isolated room running an unsaved (injected) map for the editor's
// play-test. The creator (P1) designs the map, launches the preview, and up to
// PREVIEW_COOP_CAP local players can press to join during gated — a local couch
// play-test of the unsaved map. isPreview keeps it private: getRooms never lists
// it and findARoom never matchmakes into it, so no stranger is placed here even
// though capacity is now > 1. The map is injected onto this room's gameBoard only
// — never the shared map library. enableAI defaults off, so the play-test runs
// bot-free unless the editor opted in. startEdge (optional) pins which gate the
// AUTHOR spawns at on multi-gate maps, so each side is testable on demand instead
// of whichever the round-robin hands out.
exports.createPreviewRoom = function (previewMap, enableAI, startEdge) {
	var sig = generateRoomSig();
	var room = game.getRoom(sig, PREVIEW_COOP_CAP);
	room.isPreview = true;
	room.game.locked = true;
	room.game.gameBoard.isPreview = true;
	room.game.gameBoard.previewMap = previewMap;
	// Default off: a preview is a solo, bot-free run unless the editor opted in.
	room.game.gameBoard.previewAI = enableAI === true;
	room.game.gameBoard.previewStartEdge = (typeof startEdge === "string") ? startEdge : null;
	if (enableAI === true) {
		// A play-test wants a real grid to race against, but the auto fill scales
		// off humans (1 human -> 1 bot). Force a fixed-size field via the same
		// override the lobby AI hub uses; fillGridWithBots clamps it to capacity.
		room.game.botOverride = { enabled: true, count: (c.aiRacers && c.aiRacers.previewBotCount) || 6 };
	}
	roomList[sig] = room;
	// Safety net: if the creator's play page never connects (abandoned launch),
	// reclaim the empty room so it can't linger. A joined room is left alone.
	setTimeout(function () {
		var orphan = roomList[sig];
		if (orphan != null && orphan.clientCount == 0) {
			console.log("Reclaiming unjoined preview room: " + sig);
			delete roomList[sig];
		}
	}, 60000);
	return sig;
}

function getRoomCount() {
	var count = 0;
	for (var sig in roomList) {
		count++;
	}
	return count;
}
function searchForRoom(id) {
	var room;
	for (var sig in roomList) {
		if (roomList[sig].checkRoom(id)) {
			room = roomList[sig];
		}
	}
	return room;
}

function generateRoomSig() {
	var sig = utils.getRandomInt(0, 999);
	if (roomList[sig] == null || roomList[sig] == undefined) {
		return sig;
	}
	return generateRoomSig();
}

function generateNewRoom() {
	var sig = generateRoomSig();
	roomList[sig] = game.getRoom(sig, maxPlayersInRoom);
	return sig;
}
