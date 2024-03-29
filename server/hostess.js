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
		if (roomList[sig].hasSpace()) {
			var room = roomList[sig];
			rooms[sig] = {
				state: room.game.currentState,
				round: room.game.gameBoard.round,
				currentMap: room.game.gameBoard.currentMap.name,
				gameID: Number(sig),
				players: room.game.playerCount,
				playerColors: room.game.getPlayerColors(),
			}
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
	if (roomList[sig] == null) {
		return false;
	}
	roomList[sig].join(clientID);
	return roomList[sig];
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
	sig = generateRoomSig();
}

function generateNewRoom() {
	var sig = generateRoomSig();
	roomList[sig] = game.getRoom(sig, maxPlayersInRoom);
	return sig;
}
