var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');
var game = require('./game.js');

var roomList = {},
	maxPlayersInRoom = c.maxPlayersInRoom;


exports.getRooms = function () {
	var rooms = {};
	if (getRoomCount() == 0) {
		return rooms;
	}
	for (var sig in roomList) {
		var room = roomList[sig];
		// Preview rooms are private capacity-1 play-tests; never list them.
		if (room.isPreview) {
			continue;
		}
		// A full room, or one whose match has started (locked), can't be joined
		// — but it should still appear so the join page can show it greyed out
		// ("In progress") instead of having it silently vanish. Flag joinability
		// explicitly (mirrors findARoom's matchmaking test).
		var joinable = room.hasSpace() && !room.isLocked();
		rooms[sig] = {
			state: room.game.currentState,
			round: room.game.gameBoard.round,
			currentMap: room.game.gameBoard.currentMap.name,
			gameID: Number(sig),
			players: room.game.playerCount,
			playerColors: room.game.getPlayerColors(),
			joinable: joinable,
			locked: room.isLocked(),
		}
	}
	return rooms;
}
exports.findARoom = function (clientID) {
	if (getRoomCount() == 0) {
		var sig = generateNewRoom();
		console.log("No rooms exist; Starting a new room:" + sig);
		return sig;
	}
	for (var sig2 in roomList) {
		if (roomList[sig2].hasSpace() && !roomList[sig2].isLocked()) {
			return sig2;
		}
	}
	return generateNewRoom();
}
exports.kickFromRoom = function (clientID) {
	var room = searchForRoom(clientID);
	if (room != undefined) {
		room.leave(clientID);
		if (room.clientCount == 0) {
			console.log("Deleting room");
			delete roomList[room.sig];
		}
	}
}
exports.joinARoom = function (sig, clientID) {
	var room = roomList[sig];
	if (room == null) {
		return false;
	}
	// A preview room is a private capacity-1 play-test; never let a second
	// client (e.g. a guessed ?gameid= link) in once the creator has joined.
	if (room.isPreview && !room.hasSpace()) {
		return false;
	}
	// getRooms now advertises full and locked (mid-match) rooms so the join page
	// can show them greyed out — but the disabled UI button is not the enforcement.
	// Reject a hand-typed/shared ?gameid= (or "Join by ID") into a full or started
	// room so it can't overflow capacity or drop a player into a live race. Mirrors
	// findARoom's matchmaking test; preview rooms are handled above.
	if (!room.isPreview && (!room.hasSpace() || room.isLocked())) {
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
// Create an isolated, single-player room running an unsaved (injected) map for
// the editor's play-test. Capacity 1 + isPreview + locked keep matchmaking from
// ever placing a stranger here (findARoom skips isLocked; getRooms skips
// isPreview; once the creator joins hasSpace() is false anyway). The map is
// injected onto this room's gameBoard only — never the shared map library.
exports.createPreviewRoom = function (previewMap) {
	var sig = generateRoomSig();
	var room = game.getRoom(sig, 1);
	room.isPreview = true;
	room.game.locked = true;
	room.game.gameBoard.isPreview = true;
	room.game.gameBoard.previewMap = previewMap;
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
