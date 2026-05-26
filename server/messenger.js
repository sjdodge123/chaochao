var utils = require('./utils.js');
var hostess = require('./hostess.js');
var c = utils.loadConfig();
// Skin station: expose the curated named-color palette to the client (via the
// config payload that already ships to every client) so the skin picker's swatches
// and its "is this color taken?" preview match the server's validation set.
c.colorPalette = utils.getColorPalette();
var compressor = require('./compressor.js');
var debug = require('./debug.js');
var mailBoxList = {},
	identityList = {},
	roomMailList = {},
	io;

exports.build = function (mainIO) {
	io = mainIO;
}
// `identity` is { userId, deviceId } resolved by the io.use() auth middleware
// (both null for guests). We keep it in a parallel map so the socket-id mailbox
// keeps storing the raw socket — existing consumers (getClient, game.js) are
// unchanged — while later account-aware code can resolve client id → user id.
exports.addMailBox = function (id, client, identity) {
	mailBoxList[id] = client;
	identityList[id] = identity || { userId: null, deviceId: null };
	checkForMail(mailBoxList[id]);
}
exports.removeMailBox = function (id) {
	delete mailBoxList[id];
	delete identityList[id];
}
// Resolve a connected client id to its account identity ({ userId, deviceId }).
// userId is null for guests. Returns null if the client isn't connected.
exports.getIdentity = function (id) {
	return identityList[id] || null;
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

// Avatar-skin URLs must be https images on a known provider CDN (Discord/Google).
// A signed-in player picks their avatar client-side, but the server can't trust the
// supplied URL — without a host allowlist, a player could broadcast an arbitrary
// host that every peer's browser then fetches (tracking-pixel / IP-leak vector).
function isAllowedAvatarUrl(url) {
	if (typeof url !== "string" || url.length > 512) {
		return false;
	}
	var parsed;
	try {
		parsed = new URL(url);
	} catch (e) {
		return false;
	}
	if (parsed.protocol !== "https:") {
		return false;
	}
	var host = parsed.hostname.toLowerCase();
	return host === "cdn.discordapp.com" ||
		host === "media.discordapp.net" ||
		// Google avatars live on lh3/lh4/lh5/... .googleusercontent.com. Match that
		// specific pattern rather than any *.googleusercontent.com subdomain (some of
		// which can host user-controllable content).
		/^lh[0-9]+\.googleusercontent\.com$/.test(host);
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
		// Bots yield to the joining human so humans + bots can never exceed the room
		// cap (no-op in normal flow — there are no bots while a room is joinable).
		room.game.trimBotsToCapacity();

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
			music: room.game.currentMusic,
			// Mid-join rehydration (§9.2): a player who joins mid-lobby gets the
			// walk-up stations here too (startLobby's lobbyStations event already
			// fired before they were in the room). Null outside the lobby.
			lobbyStations: (room.game.currentState == c.stateMap.lobby)
				? compressor.sendLobbyStations(room.game.gameBoard.lobbyStations)
				: null,
			// Live AI override so a late joiner's AI panel reflects the room setting.
			lobbyAI: room.game.botOverride
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

	// SPIKE (lobby skin station): set this player's color from the curated palette.
	// Lobby-only (a skin change mid-race would be confusing); validated against the
	// palette and rejected if another player already holds the color (uniqueness is
	// what keeps karts distinguishable). Broadcast on its own event because color is
	// NOT part of the per-tick gameUpdates (it only ships in the spawn packet).
	client.on('setSkin', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		var player = room.playerList[client.id];
		if (player == null) {
			return;
		}
		var color = payload && payload.color;
		if (utils.getColorPalette().indexOf(color) === -1) {
			return; // off-palette request
		}
		for (var pid in room.playerList) {
			if (pid !== client.id && room.playerList[pid] != null && room.playerList[pid].color === color) {
				client.emit("skinRejected", { color: color, reason: "taken" });
				return;
			}
		}
		player.color = color;
		// Picking a colour skin clears any equipped avatar skin (and its name); the
		// client drops the avatar when it sees playerSkinChanged.
		player.avatarUrl = null;
		player.name = null;
		messageRoomBySig(room.sig, "playerSkinChanged", { id: client.id, color: color });
	});

	// Opt-in avatar skin: a SIGNED-IN player equips their Discord/Google picture
	// (+ display name) as their kart skin, shown to everyone. Gated on client.userId
	// (resolved by the io.use auth middleware) so a guest can't spoof a name/avatar.
	client.on('setAvatarSkin', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		if (client.userId == null) {
			return; // only signed-in players may use the avatar skin
		}
		var player = room.playerList[client.id];
		if (player == null) {
			return;
		}
		var url = (payload && typeof payload.url === "string") ? payload.url : null;
		var name = (payload && typeof payload.name === "string") ? payload.name : null;
		if (!isAllowedAvatarUrl(url)) {
			return; // must be an https image on a known provider CDN (Discord/Google)
		}
		if (name != null) {
			// Strip control + bidi/zero-width/format chars (canvas name-spoofing), then
			// cap length by CODE POINT so we never split a surrogate pair (emoji names).
			name = name.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "").trim();
			name = Array.from(name).slice(0, 24).join("");
		}
		player.avatarUrl = url;
		player.name = (name && name.length) ? name : null;
		console.log('[skin] avatar skin equipped: socket', client.id, 'user', client.userId, 'name', player.name);
		messageRoomBySig(room.sig, "playerAvatarChanged", { id: client.id, avatarUrl: player.avatarUrl, name: player.name });
	});

	// Lobby AI station: set the room-wide bot override. { auto:true } => clear the
	// override back to Auto (fill toward autoTarget); enabled:false => no bots next
	// race; enabled:true + count => exactly `count` bots. Lobby-only; last-writer-
	// wins; broadcast so every open AI panel + the join page reflect the live setting.
	// Takes effect at the next startGated (fillGridWithBots reads game.botOverride).
	client.on('setLobbyAI', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		// Auto: drop the override so the grid auto-fills toward autoTarget again.
		if (payload && payload.auto) {
			room.game.botOverride = null;
			messageRoomBySig(room.sig, "lobbyAIChanged", { auto: true });
			return;
		}
		var enabled = !!(payload && payload.enabled);
		var count = (payload && typeof payload.count === "number") ? Math.floor(payload.count) : 0;
		var max = (c.aiRacers && c.aiRacers.maxGrid) ? c.aiRacers.maxGrid : 10;
		if (count < 0) { count = 0; }
		if (count > max) { count = max; }
		room.game.botOverride = { enabled: enabled, count: count };
		messageRoomBySig(room.sig, "lobbyAIChanged", { enabled: enabled, count: count });
	});


}
function messageRoomBySig(sig, header, payload) {
	io.to(String(sig)).emit(header, payload);
}
function messageClientBySig(sig, header, payload) {
	mailBoxList[sig].emit(header, payload);
}