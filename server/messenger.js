var utils = require('./utils.js');
var hostess = require('./hostess.js');
var c = utils.loadConfig();
var compressor = require('./compressor.js');
var debug = require('./debug.js');
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
		// getMaps is the editor's listing request; hide lobbyOnly maps from it.
		client.emit("maplisting", utils.getEditorMapListings());
	});

	client.on("getRooms", function () {
		client.emit("roomListing", JSON.stringify(hostess.getRooms()));
	});

	client.on("getConfig", function () {
		client.emit("config", c);
	});

	client.on('submitNewMap', function (package) {
		var vMap;
		try {
			vMap = JSON.parse(package);
		} catch (e) {
			client.emit("githubFailure", "Could not read map data.");
			return;
		}
		if (vMap == null ||
			vMap.thumbnail == null ||
			vMap.id == null ||
			vMap.author == null ||
			vMap.name == null) {
			client.emit("githubFailure", "Map is missing required info (name, author, thumbnail).");
			return;
		}
		// Structural validation at the trust boundary — the same check the
		// preview path runs — so a crafted, non-map payload can never reach the
		// GitHub API (and the server's credentials) with the submitter's data.
		var validation = utils.validateMap(vMap, c);
		if (!validation.valid) {
			client.emit("githubFailure", validation.reason);
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

	client.on('createPreviewRoom', function (package) {
		var parsed;
		try {
			parsed = JSON.parse(package);
		} catch (e) {
			client.emit("previewRejected", { reason: "Could not read map data." });
			return;
		}
		// Accept either a { map, enableAI } wrapper (current editor) or a raw map
		// object (legacy payload). Detect the wrapper structurally — a non-array
		// object that owns map/enableAI — rather than `parsed.map != null`, which
		// misfires on arrays (Array.prototype.map is truthy) and odd payloads.
		// AI defaults off, so a preview is bot-free unless explicitly opted in.
		var isWrapper = parsed != null && typeof parsed === "object" && !Array.isArray(parsed) &&
			(Object.prototype.hasOwnProperty.call(parsed, "map") || Object.prototype.hasOwnProperty.call(parsed, "enableAI"));
		var previewMap = isWrapper ? parsed.map : parsed;
		var enableAI = isWrapper && parsed.enableAI === true;
		var result = utils.validateMap(previewMap, c);
		if (!result.valid) {
			client.emit("previewRejected", { reason: result.reason });
			return;
		}
		var sig = hostess.createPreviewRoom(previewMap, enableAI);
		client.emit("previewRoomCreated", { gameID: sig });
	});

	client.on('enterGame', function (id) {
		debug.log("enterGame: client=", client.id, " requestedId=", id);
		var roomSig = '';
		if (id == -1) {
			roomSig = hostess.findARoom(client.id);
		} else {
			roomSig = id;
		}
		var room = hostess.joinARoom(roomSig, client.id);
		if (room == false) {
			debug.log("enterGame: joinARoom FAILED for client=", client.id, " roomSig=", roomSig);
			client.emit("roomNotFound");
			return;
		}
		debug.log("enterGame: client=", client.id, " joined room=", roomSig, " state=", room.game.currentState, " playerCount=", room.game.playerCount);
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
			world: worldData,
			music: room.game.currentMusic
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

	client.on('musicTrackEnded', function (trackName) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined) {
			return;
		}
		room.game.rotateMusicTrack(trackName);
	});

	client.on('drip', function () {
		client.emit('drop');
	});
	client.on('sendEmoji', function (emoji) {
		if (c.emojis.indexOf(emoji) == -1) {
			return;
		}
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined) {
			return;
		}
		var player = room.playerList[client.id];
		if (player == null) {
			return;
		}
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