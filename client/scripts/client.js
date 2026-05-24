var config,
	timeSinceLastCom = 0,
	ping = 0,
	promises = [],
	pingTimeout = null,
	lastTime = null,
	totalPlayers = 0,
	serverTimeoutWait = 5,
	previewReturnScheduled = false,
	playerWon = null;

function clientConnect() {
	// The primary connection (slot 0): the keyboard/mouse player and the sole
	// owner of rendering, audio, UI and one-shot/timer handlers. The globals
	// `server`/`myID`/`myPlayer` alias this slot (see game.js localPlayers).
	var sock = io();
	server = sock;
	localPlayers[primarySlot] = makeLocalPlayer(primarySlot, sock, true);
	registerPrimaryHandlers(sock);
	return sock;
}

// Registers the FULL handler set on the primary connection. The bodies use the
// `server`/`myID`/`playerList`/`myPlayer` globals, which alias the primary slot.
function registerPrimaryHandlers(server) {

	//Let audio.js report a finished background track so the server picks the next one.
	musicTrackEndedHandler = function (trackName) {
		server.emit("musicTrackEnded", trackName);
	};

	server.on('welcome', function (id) {
		debugLog("welcome, myID=", id);
		myID = id;
		if (localPlayers[primarySlot]) {
			localPlayers[primarySlot].myID = id;
		}
	});

	server.on("drop", function () {
		calcPing();
	});
	server.on("roomNotFound", function () {
		// Don't use alert() — it blocks the page and the user has no recovery
		// path once dismissed. Disconnect and bounce them back to the join
		// page so they can pick a real room (or start a new one).
		debugLog("roomNotFound -- redirecting to join page");
		server.disconnect();
		window.location.href = "./join.html?notfound=1";
	});

	server.on("serverKick", function () {
		debugLog("serverKick received -- being booted");
		// Per-slot teardown (§6.17): drop the primary slot. With no other local
		// players this disconnects and navigates exactly as before (N=1); with pad
		// players still in the game it fails over to one of them instead of ending
		// everyone's session.
		dropLocalPlayer(primarySlot);
	});


	server.on("gameState", function (gameState) {
		debugLog("gameState received, gameID=", gameState.gameID, "myID=", gameState.myID, "players=", Object.keys(gameState.clientList || {}).length);
		config = gameState.config;
		round = gameState.round;
		gameLength = config.baseNotchesToWin;
		clientList = gameState.clientList;
		gameID = gameState.gameID;
		checkGameState(gameState.game);
		connectSpawnPlayers(gameState.playerList);
		worldResize(gameState.world);
		interval = config.serverTickSpeed;
		gameRunning = true;
		playSoundAfterFinish(lobbyMusic);
		loadPatterns();
		loadSpriteSheets();
		init();
		if (gameState.myID != null) {
			myID = gameState.myID;
		}
		if (localPlayers[primarySlot]) {
			localPlayers[primarySlot].myID = myID;
			localPlayers[primarySlot].joined = true;
		}
		if (playerList[myID] != null) {
			myPlayer = playerList[myID];
		}
		//Late joiners: pick up the race already in progress on the right track/mood.
		if (gameState.music != null) {
			setBackgroundMusic(gameState.music.mood, gameState.music.track);
		}
		setupEmojiWheel();
		// Refresh the hint UI now the primary has joined (solo bottom bar by
		// default; switches to per-player blocks once a 2nd local player joins).
		if (typeof onLocalPlayersChanged === "function") {
			onLocalPlayersChanged();
		}
	});

	server.on("playerJoin", function (appendPlayerList) {
		clientList[appendPlayerList.id] = appendPlayerList.id;
		appendNewPlayer(appendPlayerList.player);
		playSound(playerJoinSound);
	});
	server.on("playerLeft", function (id) {
		var name = clientList[id];
		if (name != null) {
			delete clientList[id];
			delete playerList[id];
			return;
		}
	});

	server.on("gameUpdates", function (updatePacket) {
		updatePlayerList(updatePacket.playerList);
		updateProjecileList(updatePacket.projList);
		updateAimerList(updatePacket.aimerList);
		updateHazardList(updatePacket.hazardList);
		checkGameState(updatePacket.state);
		totalPlayers = updatePacket.totalPlayers;
		timeSinceLastCom = 0;
	});

	server.on("newMap", function (payload) {
		$.when.apply($, promises).then(function () {
			currentState = payload.currentState;
			loadNewMap(payload.id);
			round = payload.round;
			applyRandomTiles(payload.randomTiles);
			applyHazards(payload.hazards);
			applyAbilites(payload.abilities);
			applyBrutalMap(payload.brutalRoundConfig);
			loadPatterns();
			clearInfection();
			stopSound(lobbyMusic);
		});

	});

	server.on("maplisting", function (mapnames) {
		for (var i = 0; i < mapnames.length; i++) {
			promises.push($.getJSON("../maps/" + mapnames[i], function (data) {
				maps.push(data);
			}));
		}
	});
	server.on("contentDelivery", function (payload) {
		var payload = JSON.parse(payload);
		var mapnames = payload.mapnames;
		var soundnames = payload.soundnames;
		var imagenames = payload.imagenames;
		for (var i = 0; i < imagenames.length; i++) {
			promises.push($.get("../assets/img/" + imagenames[i]));
		}
		for (var i = 0; i < mapnames.length; i++) {
			promises.push($.getJSON("../maps/" + mapnames[i], function (data) {
				maps.push(data);
			}));
		}
		for (var i = 0; i < soundnames.length; i++) {
			promises.push($.get("../assets/sounds/" + soundnames[i]));
		}
		setupPage();
	});

	server.on("firstPlaceWinner", function (id) {
		createFirstRankSymbol(id);
	});
	server.on("secondPlaceWinner", function (id) {
		createSecondRankSymbol(id);
	});
	server.on("playerConcluded", function (id) {
		playerList[id].alive = false;
		playSound(playerFinished);
	});
	server.on("playerDied", function (id) {
		playSound(playerDiedSound);
		playerAbilityUsed(id);
		playerList[id].alive = false;
		playerList[id].onFire = 0;
		playerList[id].deathMessage = '💀';
		createDownRankSymbol(id);
		if (id == myID) {
			previewReturnToEditor();
		}
	});
	server.on("playerInfected", function (id) {
		playerList[id].alive = true;
		playerList[id].deathMessage = null;
		playerList[id].infected = true;
		playSound(newZombie);
	});
	server.on("broadCastEmoji", function (payload) {
		playerList[payload.ownerId].chatMessage = payload.emoji;
		setTimeout(function (owner) {
			playerList[owner].chatMessage = null;
		}, 4000, payload.ownerId);
	});
	server.on('playerSleeping', function (id) {
		playerList[id].awake = false;
	});
	server.on('playerAwake', function (id) {
		playerList[id].awake = true;
	});

	//Game State Map changes
	server.on("startWaiting", function (packet) {
		debugLog("startWaiting");
		setLobbySfxDampen(false); // lobby emptied back to waiting — restore full SFX
		currentState = config.stateMap.waiting;
		playSoundAfterFinish(lobbyMusic);
	});
	server.on("startLobby", function (packet) {
		debugLog("startLobby, packet=", packet);
		// Set state first so loadNewMap doesn't run its gated-only goal-ping branch.
		currentState = config.stateMap.lobby;
		spawnLobbyStartButton(packet);
		setLobbySfxDampen(true);
		playSoundAfterFinish(lobbyMusic);
		// Wait for the async map/asset loads to finish before loading the lobby map —
		// otherwise on a fresh page load maps[] may not yet contain the tutorial map and
		// it silently fails to render (the islands "disappear"). Mirrors the newMap path.
		$.when.apply($, promises).then(function () {
			loadLobbyMap(packet);
		});
	});
	// Lobby bumpers (the race path creates hazards inside the newMap handler; the lobby
	// has no newMap, so it sends them separately).
	server.on("applyHazards", function (payload) {
		applyHazards(payload);
	});
	server.on("startGated", function (packet) {
		debugLog("startGated");
		setLobbySfxDampen(false); // restore full SFX before the game-start cue
		stopSound(lobbyMusic);
		playSound(gameStart);
		currentState = config.stateMap.gated;
	});
	server.on("startRace", function (packet) {
		playSound(countDownB);
		if (packet != null && packet.music != null) {
			setBackgroundMusic(packet.music.mood, packet.music.track);
		}
		oldNotches = {};
		resetTrails();
		resetPlayerRanks();
		currentState = config.stateMap.racing;
	});
	//Server-driven mood change (near-victory) or next track (previous one ended).
	server.on("musicMood", function (packet) {
		if (packet != null) {
			setBackgroundMusic(packet.mood, packet.track);
		}
	});
	server.on("startOverview", function (packet) {
		// Round ended (solo death or goal reached) — schedule the editor return
		// first, so a throw in the rendering calls below can't strand the creator.
		previewReturnToEditor();
		resetRound();
		stopSound(lavaCollapse);
		resetTrails();
		updatePlayerNotches(packet.notchUpdates);
		calculateNotchMoveAmt();
		loadMapPreview(packet.nextMapID);
		currentState = config.stateMap.overview;
	});
	server.on("startGameover", function (packet) {
		// Match over (solo creator hit the winning notch) — schedule the editor
		// return first so the calls below can't strand the creator if they throw.
		previewReturnToEditor();
		playerWon = packet.winner;
		achievements = packet.achievements;
		stopAllSounds();
		playSound(gameOverSound);
		decodedColorName = Colors.decode(playerList[packet.winner].color);
		currentState = config.stateMap.gameOver;
	});
	server.on("startCollapse", function () {
		currentState = config.stateMap.collapsing;
		playSound(lavaCollapse);
	});

	server.on("resetPlayers", function () {
		resetPlayers();
	});
	server.on("resetProjectiles", function () {
		resetProjectiles();
	});
	server.on("resetHazards", function () {
		resetHazardList();
	});
	server.on("resetGame", function () {
		fullReset();
	});
	server.on("gameLength", function (length) {
		gameLength = length;
	});

	server.on("punch", function (packet) {
		var punch = spawnPunch(packet);
		var owner = playerList[punch.ownerId];
		if (owner != null && owner.infected) {
			playSound(zombieSwing);
			return;
		}
		if (punch.type == "player") {
			playSound(meleeSound);
		}
		if (punch.type == "bumper") {
			playSound(bumperSound);
		}

	});
	server.on("spawnBomb", function (owner) {
		spawnBomb(owner);
		playSound(bombShot);
	});
	server.on("spawnPuck", function (owner) {
		spawnPuck(owner);
		playSound(bombShot);
	});
	server.on("applyBlackout", function (owner) {
		blackout = true;
		playSound(blackoutSound);
	});

	server.on("spawnSnowFlake", function (owner) {
		spawnSnowFlake(owner);
		playSound(bombShot);
	});
	server.on("spawnClouds", function (packet) {
		spawnClouds(packet);
	});
	server.on("playerPunched", function (owner) {
		if (playerList[owner] == null) {
			playSound(meleeHitSound);
			return;
		}
		if (playerList[owner].infected) {
			playSound(zombieHit);
		}
	});
	server.on("terminatePunch", function (id) {
		terminatePunch(id);
	});
	server.on("terminateProj", function (id) {
		terminateProj(id);
	});
	server.on("terminateAimer", function (id) {
		terminateAimer(id);
	});
	server.on('collapsedCells', function (cells) {
		$.when.apply($, promises).then(function () {
			collapseCells(cells);
		});
	});
	server.on('explodedCells', function (cells) {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing || currentState == config.stateMap.lobby) {
			explodedCells(cells);
			playSound(bombExplosion);
			rumbleScreen(100);
		}
	});
	server.on("snowFlakeExploded", function (owner) {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing || currentState == config.stateMap.lobby) {
			playSound(iceExplosion);
			rumbleScreen(100);
		}
	});
	server.on("firstBlood", function () {
		playSound(firstBlood);
	});
	server.on("onFire", function (packet) {
		var owner = packet.owner;
		var value = packet.value;
		if (playerList[owner] != null) {
			playerList[owner].onFire = value;
		}
	});
	// Lobby tutorial: a player touched lava (death) or the goal (win) and was safely
	// respawned. Reuse the real death/win cues (dampened to lobby volume) and set the
	// post-respawn invuln window so drawPlayer can flash the sprite. No scoring here.
	server.on("lobbyRespawn", function (packet) {
		if (packet == null) {
			return;
		}
		var p = playerList[packet.id];
		if (p != null) {
			p.invulnUntil = Date.now() + packet.invulnMs;
			if (packet.death) {
				p.deathMessage = '💀';
				setTimeout(function (id) {
					if (playerList[id] != null) {
						playerList[id].deathMessage = null;
					}
				}, 800, packet.id);
			}
		}
		playSound(packet.death ? playerDiedSound : playerFinished);
	});
	server.on("multiKill", function (count) {
		if (count == 2) {
			playSound(doubleKill);
		}
		if (count == 3) {
			playSound(tripleKill);
		}
		if (count > 3) {
			playSound(megaKill);
		}
	});
	server.on("killingSpree", function (player) {
		playSound(killingSpree);
	});
	server.on("rampage", function (player) {
		playSound(rampage);
	});
	server.on("godLike", function (player) {
		playSound(godLike);
	});
	server.on("fizzle", function (owner) {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
			if (playerList[owner] != null) {
				playerList[owner].fizzle();
			}
		}
	});
	server.on("abilityAcquired", function (payload) {
		playerPickedUpAbility(payload);
		playSound(collectItem);
	});
	// Late-join seed of invuln state so already-protected players flash on this client.
	server.on("lobbyInvulnStates", function (states) {
		if (states == null) {
			return;
		}
		for (var i = 0; i < states.length; i++) {
			var s = states[i];
			if (playerList[s.id] != null) {
				if (s.remainingMs > 0) {
					playerList[s.id].invulnUntil = Date.now() + s.remainingMs;
				}
				playerList[s.id].invulnHeldInCircle = s.held;
			}
		}
	});
	server.on("allAbilityHoldings", function (payload) {
		$.when.apply($, promises).then(function () {
			var abilities = JSON.parse(payload);
			for (var id in abilities) {
				playerPickedUpAbility(abilities[id]);
			}
		});
	});
	server.on("tileChanges", function (payload) {
		$.when.apply($, promises).then(function () {
			var tileChanges = JSON.parse(payload);
			changeTilesBulk(tileChanges);
		});
	});

	server.on("projBounced", function () {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing || currentState == config.stateMap.lobby) {
			playSound(bombBounce);
		}
	});
	server.on("blindfoldUsed", function (owner) {
		createBlindFold(owner);
		playerAbilityUsed(owner);
		playSound(blindSound);
	});
	server.on("cutUsed", function (owner) {
		playSound(cutSound);
		playerAbilityUsed(owner);
		rumbleScreen(100);
	});
	server.on("tileSwap", function (owner) {
		playerAbilityUsed(owner);
		playSound(tileSwap);
	});
	server.on("iceCannon", function (owner) {
		playerAbilityUsed(owner);
		playSound(iceCannon);
	});
	server.on("lavaExplosion", function () {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
			playSound(lavaExplosion);
			rumbleScreen(100);
		}
	});
	server.on("spawnExplosionAimer", function (owner) {
		spawnExplosionAimer(owner);
		aimerList[owner].startExplosionCountDown = true;

		for (var i = 1; i < config.explosionWarnTime + 1; i++) {
			addTimer(function (params) {
				if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
					playSound(teleportWarnSound);
					params.explosionPulse = true;
				}
			}, i * 1000, aimerList[owner]);
			if (i == config.explosionWarnTime) {
				addTimer(function (params) {
					if (params != undefined) {
						params.hide = true;
					}
				}, config.explosionWarnTime * 1000, aimerList[owner]);
			}
		}
	});
	server.on("swapUsed", function (owner) {
		playerAbilityUsed(owner);
		spawnSwapAimer(owner);
		aimerList[owner].startSwapCountDown = true;

		for (var i = 1; i < (config.tileMap.abilities.swap.warnTime / 1000) + 1; i++) {
			addTimer(function (params) {
				if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
					playSound(teleportWarnSound);
					params.swapCountDownPulse = true;
				}
			}, i * 1000, aimerList[owner]);
			if (i == (config.tileMap.abilities.swap.warnTime / 1000)) {
				addTimer(function (params) {
					if (params != undefined) {
						params.hide = true;
					}
				}, config.tileMap.abilities.swap.warnTime, aimerList[owner]);
			}
		}
	});
	server.on("playerSwapped", function (owner) {
		if (aimerList[owner].startSwapCountDown) {
			aimerList[owner].startSwapCountDown = false;
		}
		playSound(teleportSound);
	});
	server.on("bombUsed", function (owner) {
		playerAbilityUsed(owner);
	});
	server.on("volcanoEruption", function () {
		playSound(volcanoErupt);
		rumbleScreen(2500);
	});

	server.on("speedBuff", function (owner) {
		playSound(speedBuff);
		playerAbilityUsed(owner);
	});

	server.on("speedDebuff", function (owner) {
		playSound(speedDebuff);
		playerAbilityUsed(owner);
	});
	server.on("triggerUsed", function (owner) {
		playerAbilityUsed(owner);
	});
	server.on("startLobbyTimer", function () {
		if (lobbyStartButton != null) {
			lobbyStartButton.startSpin = true;
		}
	});
	server.on("resetLobbyTimer", function () {
		if (lobbyStartButton != null) {
			lobbyStartButton.startSpin = false;
		}
	});
}

// Minimal handler set for a NON-primary connection (a pad player). It is an
// input/identity channel only: it captures its own server id and handles its own
// teardown, but does NOT run rendering/audio/UI/timer handlers (the primary owns
// those — running them per socket would fire every room broadcast N times,
// §6.8a). Teardown is per-slot: a kick/notfound on this slot drops only this
// slot and never navigates the tab (§6.17).
function registerSecondaryHandlers(sock, slot) {
	sock.on('welcome', function (id) {
		debugLog("[localmp] slot", slot, "welcome, myID=", id);
		if (localPlayers[slot]) {
			localPlayers[slot].myID = id;
		}
	});
	sock.on('gameState', function (gs) {
		var lp = localPlayers[slot];
		if (lp) {
			lp.myID = gs.myID;
			lp.joined = true;
			lp.everJoined = true;
			if (lp.reconnectTimer) {
				clearTimeout(lp.reconnectTimer);
				lp.reconnectTimer = null;
			}
		}
		if (typeof onLocalPlayerReconnecting === "function") {
			onLocalPlayerReconnecting(slot, false); // recovered — un-grey its block
		}
		debugLog("[localmp] slot", slot, "joined room", gs.gameID, "as", gs.myID);
	});
	sock.on('connect', function () {
		var lp = localPlayers[slot];
		// socket.io fires 'connect' on the initial connect AND on each reconnect.
		// The initial join is already buffered by addLocalPlayer; on a RECONNECT
		// (everJoined) re-join the same room so the pad player pops back in
		// without having to press to rejoin. The reconnect gets a fresh server id
		// (no server-side session recovery here), so this spawns a new player and
		// the gameState handler updates the slot's myID.
		if (lp && lp.everJoined && gameID != null) {
			debugLog("[localmp] slot", slot, "reconnected — re-joining room", gameID);
			sock.emit('enterGame', gameID);
		}
	});
	sock.on('roomNotFound', function () {
		debugLog("[localmp] slot", slot, "roomNotFound — dropping slot, tab kept alive");
		dropLocalPlayer(slot);
	});
	sock.on('serverKick', function () {
		debugLog("[localmp] slot", slot, "serverKick — dropping slot, tab kept alive");
		dropLocalPlayer(slot);
	});
	sock.on('disconnect', function (reason) {
		// We tore it down on purpose (kick / leave / unplug call sock.disconnect()).
		if (reason === 'io client disconnect') {
			return;
		}
		var lp = localPlayers[slot];
		if (!lp || lp.socket !== sock) {
			return;
		}
		// Transient blip: keep the slot, grey its block, and let socket.io
		// auto-reconnect (the 'connect' handler re-joins). Drop only if it can't
		// recover within the grace window (§6.10).
		debugLog("[localmp] slot", slot, "disconnected (", reason, ") — awaiting reconnect");
		if (typeof onLocalPlayerReconnecting === "function") {
			onLocalPlayerReconnecting(slot, true);
		}
		if (lp.reconnectTimer) {
			clearTimeout(lp.reconnectTimer);
		}
		lp.reconnectTimer = setTimeout(function () {
			debugLog("[localmp] slot", slot, "reconnect grace expired — dropping");
			dropLocalPlayer(slot);
		}, RECONNECT_GRACE_MS);
	});
}

// Open a new local player on `slot`, driven by gamepad `padIndex`, and join it
// into the SAME room as the primary (`gameID`). `forceNew` is load-bearing
// (§6.7): without it io() reuses the cached Manager and the new "player" would
// share the primary's socket id.
function addLocalPlayer(slot, padIndex) {
	if (localPlayers[slot]) {
		return localPlayers[slot];
	}
	if (gameID == null) {
		return null; // primary hasn't confirmed a room yet
	}
	debugLog("[localmp] opening slot", slot, "pad", padIndex, "-> gameID", gameID);
	var sock = io({ forceNew: true });
	var lp = makeLocalPlayer(slot, sock, false);
	lp.padIndex = padIndex;
	localPlayers[slot] = lp;
	registerSecondaryHandlers(sock, slot);
	sock.emit('enterGame', gameID);
	if (typeof onLocalPlayersChanged === "function") {
		onLocalPlayersChanged(); // switch to per-player blocks if now >= 2 players
	}
	return lp;
}

// Drop one local player. Non-primary: close its socket and free its slot, leaving
// everyone else running. Primary: if other locals remain, fail over to one of
// them rather than tearing down the whole tab (§6.17 — only navigate when the
// LAST local player is gone).
function dropLocalPlayer(slot) {
	var lp = localPlayers[slot];
	if (!lp) {
		return;
	}
	if (lp.reconnectTimer) {
		clearTimeout(lp.reconnectTimer);
		lp.reconnectTimer = null;
	}
	if (lp.leaveConfirmTimer) {
		clearTimeout(lp.leaveConfirmTimer);
		lp.leaveConfirmTimer = null;
	}
	// If this player had the shared emoji wheel open, close it — otherwise it
	// soft-locks open (no surviving player owns it, so none can dismiss it).
	if (typeof emojiOwnerSlot !== "undefined" && emojiOwnerSlot === slot &&
		typeof closeEmojiWindow === "function") {
		closeEmojiWindow("cancel");
	}
	// The controller that drove this player must release its buttons before it can
	// (re)join, so the press that confirmed leaving doesn't instantly re-join them.
	if (lp.padIndex != null && typeof markPadNeedsRelease === "function") {
		markPadNeedsRelease(lp.padIndex);
	}
	if (lp.isPrimary) {
		handlePrimaryLost();
		return;
	}
	try { lp.socket.disconnect(); } catch (e) { /* already gone */ }
	localPlayers[slot] = null;
	// A controller player who just left was effectively the only player if all that
	// remains is the primary slot with no one actually driving it — no pad bound and
	// the keyboard/mouse was never used to play (a phantom P1 that only exists to
	// hold the tab). In that case fall through to the same teardown the primary leave
	// uses, so leaving returns to the menu instead of stranding the tab on a player
	// nobody is controlling. A real keyboard/mouse player (kbmClaimedPrimary) or
	// another controller still in the game keeps the session alive.
	if (onlyPhantomPrimaryRemains()) {
		// No real player left — tear the tab down and go back to the menu, same as
		// the last-player-leaving path in handlePrimaryLost().
		try { server.disconnect(); } catch (e) { /* ignore */ }
		window.location.href = "./index.html";
		return;
	}
	if (typeof onLocalPlayersChanged === "function") {
		onLocalPlayersChanged(); // restore the bottom bar if back to 1 player
	}
}

// True when the sole surviving local player is the primary slot and nobody is
// actually driving it: no controller bound and the keyboard/mouse never claimed P1.
function onlyPhantomPrimaryRemains() {
	var remaining = null, count = 0;
	for (var s = 0; s < localPlayers.length; s++) {
		if (localPlayers[s]) {
			count++;
			remaining = localPlayers[s];
		}
	}
	return count === 1 && remaining.isPrimary &&
		remaining.padIndex == null && !kbmClaimedPrimary;
}

// The primary (rendering/audio) connection was lost. If pad players are still in
// the game, promote the lowest surviving slot to primary so the couch session and
// its rendering continue; only when no local players remain do we leave the page.
function handlePrimaryLost() {
	var survivor = null;
	for (var s = 0; s < localPlayers.length; s++) {
		if (localPlayers[s] && !localPlayers[s].isPrimary) {
			survivor = localPlayers[s];
			break;
		}
	}
	if (survivor == null) {
		// Last local player gone — behave as today and leave.
		try { server.disconnect(); } catch (e) { /* ignore */ }
		window.location.href = "./index.html";
		return;
	}
	promoteToPrimary(survivor);
}

// Best-effort failover: re-point the primary aliases at `lp`'s socket and attach
// the full handler set so rendering/audio resume on it. `lp` KEEPS its gamepad
// binding (padIndex) so a promoted controller player keeps controlling the game;
// the keyboard/mouse also drives the primary if used.
function promoteToPrimary(lp) {
	debugLog("[localmp] promoting slot", lp.slot, "to primary");
	var old = localPlayers[primarySlot];
	if (old) {
		localPlayers[primarySlot] = null;
		try { old.socket.disconnect(); } catch (e) { /* ignore */ }
	}
	lp.isPrimary = true;
	primarySlot = lp.slot;
	server = lp.socket;
	myID = lp.myID;
	if (playerList && myID != null && playerList[myID]) {
		myPlayer = playerList[myID];
	}
	// Drop the secondary-only listeners before attaching the full set, so the
	// promoted socket doesn't run both handler sets for the same event.
	try {
		lp.socket.off('welcome');
		lp.socket.off('gameState');
		lp.socket.off('roomNotFound');
		lp.socket.off('serverKick');
		lp.socket.off('disconnect');
		lp.socket.off('connect'); // drop the secondary reconnect-rejoin handler too
	} catch (e) { /* ignore */ }
	registerPrimaryHandlers(lp.socket); // resume render/audio/state handlers
	if (typeof onLocalPlayersChanged === "function") {
		onLocalPlayersChanged(); // reconcile the hint UI for the new player count
	}
}

function clientSendStart(id) {
	if (id != null) {
		server.emit('enterGame', id);
	}
}

// In a preview session, the round ends when the solo creator dies or reaches
// the goal (both surface as startOverview, plus startGameover on a win). After
// a short beat to see the result, navigate back to the editor with the map
// intact. The flag makes whichever trigger fires first win and dedupes the rest.
function previewReturnToEditor() {
	if (!previewMode || previewReturnScheduled) {
		return;
	}
	previewReturnScheduled = true;
	setTimeout(function () {
		window.location = './create.html';
	}, 1500);
}

function pingServer() {
	clearTimeout(pingTimeout);
	lastTime = new Date();
	server.emit('drip');
}
function sendEmoji(emoji) {
	server.emit('sendEmoji', emoji);
}

// Emit an emoji on a specific local player's socket so the server attributes it
// (ownerId = emitting socket id) to the player who actually picked it. Falls back
// to the primary socket if the slot is gone.
function sendEmojiForSlot(emoji, slot) {
	var lp = (slot != null && localPlayers[slot]) ? localPlayers[slot] : null;
	var sock = (lp && lp.socket) ? lp.socket : server;
	sock.emit('sendEmoji', emoji);
}

function calcPing() {
	ping = new Date() - lastTime;
	pingTimeout = setTimeout(pingServer, 1000);
	timeSinceLastCom = 0;
}

function checkForTimeout() {
	timeSinceLastCom++;
	if (timeSinceLastCom > serverTimeoutWait) {
		debugLog("client timeout -- no server comm for " + timeSinceLastCom + "s, reloading");
		server.disconnect();
		window.parent.location.reload();
	}
}

