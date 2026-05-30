var utils = require('./utils.js');
var hostess = require('./hostess.js');
var c = utils.loadConfig();
// Skin station: expose the curated named-color palette to the client (via the
// config payload that already ships to every client) so the skin picker's swatches
// and its "is this color taken?" preview match the server's validation set.
c.colorPalette = utils.getColorPalette();
var compressor = require('./compressor.js');
var debug = require('./debug.js');
var mapFormat = require('./mapFormat.js');
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
	client.emit("contentDelivery", JSON.stringify({ count: utils.getContentCount(), mapnames: utils.getMapListings(), soundnames: utils.getSoundListings(), imagenames: utils.getImageListings(), playlists: utils.getPlaylistSummary() }));

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

	// Opt-in touch diagnostics: a client running with ?debugtouch=1 streams touch
	// lifecycle snapshots here. We only log them when the server is started with
	// TOUCH_DEBUG=1, so in production this is a no-op and can't be log-spammed.
	client.on("touchDebugReport", function (data) {
		if (process.env.TOUCH_DEBUG !== "1") {
			return;
		}
		try { console.log("[touchDebug] " + JSON.stringify(data)); }
		catch (e) { console.log("[touchDebug] (unserializable)"); }
	});

	// Diagnostic only: a client running with ?diag=1 streams render-perf samples
	// (frame times, phase split, device class, game-state counts) so a stutter on
	// a real device can be diagnosed from server logs. Untrusted input from any
	// client, so it's hardened against abuse: reject anything but a small string,
	// rate-limit per client, and log one truncated line. Never parse a large
	// payload (avoids a main-thread JSON.parse DoS) and never act on it.
	var lastPerfDiagAt = 0;
	client.on("clientPerfDiag", function (payload) {
		try {
			if (typeof payload !== "string" || payload.length > 4000) {
				return;   // the legit client sends a small JSON string; ignore anything else
			}
			var now = Date.now();
			if (now - lastPerfDiagAt < 500) {
				return;   // rate-limit: the real client emits every ~1.5-3s
			}
			lastPerfDiagAt = now;
			var d = JSON.parse(payload);
			if (d == null || typeof d !== "object") {
				return;
			}
			console.log("[perf-diag] " + client.id + " " + payload);
		} catch (e) { /* ignore malformed diag payloads */ }
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
			vMap.id == null ||
			vMap.author == null ||
			vMap.name == null) {
			client.emit("githubFailure", "Map is missing required info (name, author).");
			return;
		}
		// Rebuild full geometry if the client sent the compact sites-only form, so
		// validateMap (and submitPullRequest's reduction) see a full map either way.
		try {
			vMap = mapFormat.hydrate(vMap);
		} catch (e) {
			client.emit("githubFailure", "Map geometry could not be reconstructed.");
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
		})(client.id).catch(function (e) {
			// Backstop: submitPullRequest resolves with {status,message} on its own
			// errors, but never let an unexpected throw become an unhandled
			// rejection that leaves the editor stuck on "Submitting..". Log the
			// real error; send the player the same friendly generic.
			console.log(e);
			client.emit("githubFailure", "Couldn't upload your map right now. Please try again in a moment.");
		})

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
		// Maps are sites-only now; rebuild full geometry at this trust boundary so a
		// client may submit either form (the editor sends full geometry, but a raw
		// committed map is sites-only). validateMap + the engine need cells.
		try {
			previewMap = mapFormat.hydrate(previewMap);
		} catch (e) {
			client.emit("previewRejected", { reason: "Map geometry could not be reconstructed." });
			return;
		}
		var result = utils.validateMap(previewMap, c);
		if (!result.valid) {
			client.emit("previewRejected", { reason: result.reason });
			return;
		}
		var sig = hostess.createPreviewRoom(previewMap, enableAI);
		client.emit("previewRoomCreated", { gameID: sig });
	});

	client.on('enterGame', function (id, coop) {
		debug.log("enterGame: client=", client.id, " requestedId=", id, " coop=", coop);
		var roomSig = '';
		if (id == -1) {
			roomSig = hostess.findARoom(client.id);
		} else {
			roomSig = id;
		}
		// Any deliberate join (join page, "Join by ID", shared id, or a local co-op
		// seat) may now land in an already-started (locked) room, spawning as a
		// spectator who races from the next round (determineGameState's racing
		// branch). joinARoom enforces capacity; matchmaking (id == -1) still avoids
		// locked rooms in findARoom. The legacy `coop` event arg is no longer needed
		// server-side but clients may still send it — accepted and ignored.
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
		// Stamp the verified Supabase user id so the map-time leaderboard knows
		// whose finish to record (null for guests). Bots never get a user id —
		// world.createNewBot sets isAI but leaves verifiedUserId undefined.
		room.playerList[client.id].verifiedUserId = client.userId || null;
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
				// Latch the press edge so a sub-tick tap (press+release between two server
				// ticks) still throws — punches now fire on release, so checkAttack would
				// otherwise see only the trailing attack=false and drop the punch.
				if (packet.attack && !player.attack) { player.attackQueued = true; }
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

	// Cosmetic cart skin (procedural overlay). Independent of color/avatar: equipping
	// one does NOT clear them. Available to everyone (no ownership gating yet).
	// Validated against an allowlist; "" / null clears back to the plain colored cart.
	client.on('setCartSkin', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		var player = room.playerList[client.id];
		if (player == null) {
			return;
		}
		var cartSkin = payload && payload.cartSkin;
		var allowed = ["firetruck", "dino"];
		if (cartSkin === "" || cartSkin == null) {
			cartSkin = null;
		} else if (allowed.indexOf(cartSkin) === -1) {
			return; // unknown skin id
		}
		player.cartSkin = cartSkin;
		messageRoomBySig(room.sig, "playerCartSkinChanged", { id: client.id, cartSkin: player.cartSkin });
	});

	// Lobby AI station: set the room-wide bot override. { auto:true } => clear the
	// override back to Auto (triangular-tier fill); enabled:false => no bots next
	// race; enabled:true + count => exactly `count` bots. Lobby-only; last-writer-
	// wins; broadcast so every open AI panel + the join page reflect the live setting.
	// Takes effect at the next startGated (fillGridWithBots reads game.botOverride).
	client.on('setLobbyAI', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		// Auto: drop the override so the grid auto-fills with the triangular-tier scale.
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

	// Room-wide playlist pick from the lobby hub board. Last-writer-wins: validate
	// against the configured playlists (setPlaylist does this), and only echo the
	// change to the room when it actually changed.
	client.on('setLobbyPlaylist', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		var id = payload && payload.id;
		if (typeof id !== "string") {
			return;
		}
		if (room.game.gameBoard.setPlaylist(id)) {
			messageRoomBySig(room.sig, "lobbyPlaylistChanged", { id: id });
		}
	});


}
function messageRoomBySig(sig, header, payload) {
	io.to(String(sig)).emit(header, payload);
}
function messageClientBySig(sig, header, payload) {
	mailBoxList[sig].emit(header, payload);
}