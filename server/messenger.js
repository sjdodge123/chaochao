var utils = require('./utils.js');
var hostess = require('./hostess.js');
var c = utils.loadConfig();
var compressor = require('./compressor.js');
var mailBoxList = {},
	roomMailList = {},
	io;

exports.build = function (mainIO) {
	io = mainIO;
}
exports.addMailBox = function (id, client) {
	mailBoxList[id] = client;
	checkForMail(mailBoxList[id]);
}
exports.removeMailBox = function (id) {
	delete mailBoxList[id];
}
exports.addRoomToMailBox = function (id, roomSig) {
	roomMailList[id] = roomSig;
}
exports.removeRoomMailBox = function (id) {
	delete roomMailList[id];
}
exports.getClient = function (id) {
	return mailBoxList[id];
}
exports.messageRoomBySig = function (sig, header, payload) {
	messageRoomBySig(sig, header, payload);
}
exports.messageClientBySig = function (sig, header, payload) {
	messageClientBySig(sig, header, payload);
}
exports.getTotalPlayers = function () {
	var count = 0;
	for (var box in mailBoxList) {
		count++;
	}
	return count;
}

function checkForMail(client) {
	client.emit("welcome", client.id);
	client.emit("contentDelivery", JSON.stringify({ count: utils.getContentCount(), mapnames: utils.getMapListings(), soundnames: utils.getSoundListings(), imagenames: utils.getImageListings() }));

	client.on("getMaps", function () {
		client.emit("maplisting", utils.getMapListings());
	});

	client.on("getRooms", function () {
		client.emit("roomListing", JSON.stringify(hostess.getRooms()));
	});

	client.on("getConfig", function () {
		client.emit("config", c);
	});

	client.on('submitNewMap', function (package) {
		var vMap = JSON.parse(package);
		if (vMap.thumbnail == null ||
			vMap.id == null ||
			vMap.author == null ||
			vMap.name == null) {
			return;
		}

		(async (id) => {
			var returnToClient = await utils.submitPullRequest(vMap);
			if (returnToClient.status == false) {
				client.emit("githubFailure", returnToClient.message);
				return;
			}
			client.emit("githubSuccess", returnToClient.message);
		})(client.id)

	});

	client.on('enterGame', function (id) {

		var roomSig = '';
		if (id == -1) {
			roomSig = hostess.findARoom(client.id);
		} else {
			roomSig = id;
		}
		var room = hostess.joinARoom(roomSig, client.id);
		if (room == false) {
			client.emit("roomNotFound");
			return;
		}
		//client.emit("maplisting", utils.getMapListings());

		//Add this player to the list of current clients in the room
		room.clientList[client.id] = client.id;

		//Spawn a player for the new player
		room.playerList[client.id] = room.world.createNewPlayer(client.id);
		room.game.determineGameState(room.playerList[client.id]);

		//Send the current gamestate to the new player
		var worldData = compressor.worldResize(room.world);
		var playerData = compressor.playerSpawns(room.playerList);
		var gameData = compressor.gameState(room.game);

		var gameState = {
			clientList: room.clientList,
			playerList: playerData,
			game: gameData,
			round: room.game.gameBoard.round,
			config: c,
			myID: client.id,
			gameID: roomSig,
			world: worldData
		};
		client.emit("gameState", gameState);
		//Update all existing players with the new player's info
		var appendPlayerData = compressor.appendPlayer(room.playerList[client.id]);
		var appendPlayerList = {
			id: client.id,
			player: appendPlayerData
		};
		room.game.checkSendGameStateUpdates(client);
		client.broadcast.to(String(roomSig)).emit("playerJoin", appendPlayerList);
	});

	client.on('playerLeaveRoom', function () {
		hostess.kickFromRoom(client.id);
	});

	client.on('drip', function () {
		client.emit('drop');
	});
	client.on('sendEmoji', function (emoji) {
		if (c.emojis.indexOf(emoji) == -1) {
			return;
		}
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		var player = room.playerList[client.id];
		if (player.chatCoolDownTimer != null) {
			return;
		}
		player.chatCoolDownTimer = Date.now();
		messageRoomBySig(room.sig, "broadCastEmoji", { emoji: emoji, ownerId: client.id });
	});

	client.on('movement', function (packet) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined) {
			return;
		}
		var player = room.playerList[client.id];
		if (player != null) {
			player.wakeUp();
			if (player.enabled) {
				player.moveForward = packet.moveForward;
				player.moveBackward = packet.moveBackward;
				player.turnLeft = packet.turnLeft;
				player.turnRight = packet.turnRight;
				player.attack = packet.attack;
			}
		}
	});

	client.on('mousemove', function (angle) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined) {
			return;
		}
		var player = room.playerList[client.id];
		if (player != null && player != undefined) {
			if (player.enabled) {
				player.angle = angle;
			}
		}
	});


}
function messageRoomBySig(sig, header, payload) {
	io.to(String(sig)).emit(header, payload);
}
function messageClientBySig(sig, header, payload) {
	mailBoxList[sig].emit(header, payload);
}