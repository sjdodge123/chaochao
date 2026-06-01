var config,
	timeSinceLastCom = 0,
	ping = 0,
	promises = [],
	pingTimeout = null,
	lastTime = null,
	totalPlayers = 0,
	serverTimeoutWait = 5,
	previewReturnScheduled = false,
	recentPunchTimes = [],
	nextFightReactionTime = 0,
	playerWon = null;

// Set true when a match-over (startGameover) fires; consumed by the next startLobby
// to gate the between-matches interstitial. An explicit flag is required because the
// server emits startWaiting (currentState -> waiting) BETWEEN startGameover and the
// next startLobby, so inferring "came from gameOver" from currentState is unreliable.
var adPendingMatchEnd = false;

// Map-rating widget state (shown on the per-round overview + the match-over screen;
// see drawMapRating / handleMapRatingTap). ratingMapId/Name: which map the stars
// rate; myMapRating: stars this player picked (0 = none yet); ratingStarHits:
// per-star screen rects for hit-testing.
var ratingMapId = null,
	ratingMapName = null,
	myMapRating = 0,
	ratingStarHits = [],
	ratingPadCursor = 0;   // gamepad-highlighted star (1..5; 0 = uninitialised)

// Rewarded "2× match XP" results-screen button state. currentMatchId: the server-stamped
// id of the just-finished match (echoed back in claimXpMultiplier). rewardedClaimState:
// 'idle' (button shown) | 'watching' (ad up — button hidden) | 'claimed' (done, button gone).
// rewardButtonHit: the canvas hit-rect drawn by draw.js for input.js to test; rewardPadFocused:
// the gamepad has the button highlighted (lets Ⓐ trigger it on the results screen).
var currentMatchId = null,
	rewardedClaimState = "idle",
	rewardButtonHit = null,
	rewardPadFocused = false;

// True when the "📺 Watch ad to 2× your XP" button should render on the results screen:
// signed-in (anonymous players have no server XP to multiply — hidden OUTRIGHT, never shown-
// then-failed), a rewarded ad is loaded, we know which match to claim, and it isn't already
// being watched / claimed.
function rewardButtonAvailable() {
	if (typeof config === "undefined" || config == null || currentState !== config.stateMap.gameOver) { return false; }
	if (!currentMatchId || rewardedClaimState !== "idle") { return false; }
	// DEV-ONLY — STRIP BEFORE PR: the localhost ?testrewarded=1 override also shows the
	// button for guests (so it's testable without local Supabase auth); the reward is then
	// simulated client-side in triggerRewardButton (no server credit — guests have no XP).
	var devR = (window.ads && typeof window.ads._devRewarded === "function" && window.ads._devRewarded());
	if (!devR && !(window.chaochaoAuth && typeof window.chaochaoAuth.isSignedIn === "function" && window.chaochaoAuth.isSignedIn())) { return false; }
	if (!(window.ads && typeof window.ads.isRewardedAvailable === "function" && window.ads.isRewardedAvailable())) { return false; }
	return true;
}

// Start the rewarded flow (click / tap / gamepad Ⓐ). Shows the ad; on a CONFIRMED full watch
// the server is asked to credit the doubled XP; on skip/error the button returns for a retry.
function triggerRewardButton() {
	if (!rewardButtonAvailable()) { return; }
	var matchId = currentMatchId;
	rewardedClaimState = "watching"; // hide the button while the ad is up
	window.ads.showRewarded({
		placement: "xp_2x",
		onReward: function () {
			// Ad watched in full — ask the server to credit the bonus. The server validates
			// matchId + TTL + single-claim and replies with `xpBonus` (multiplier is server-fixed;
			// we send it only as a courtesy — the server ignores the client value).
			rewardedClaimState = "claimed";
			// DEV-ONLY — STRIP BEFORE PR: under the localhost override a GUEST has no server
			// progression to credit, so the server would reject the claim. Fake the ack locally
			// so the toast/flow is visible. Signed-in players always take the real server path.
			var signedIn = (window.chaochaoAuth && typeof window.chaochaoAuth.isSignedIn === "function" && window.chaochaoAuth.isSignedIn());
			var devR = (window.ads && typeof window.ads._devRewarded === "function" && window.ads._devRewarded());
			if (devR && !signedIn) {
				if (typeof enqueueProgressionToasts === "function") { enqueueProgressionToasts([{ type: "xp_bonus", amount: 0 }]); }
				if (typeof trackEvent === "function") { trackEvent('reward_claimed', { bonus: 'xp_2x', match_id: matchId || '' }); }
				return;
			}
			if (typeof server !== "undefined" && server) {
				server.emit("claimXpMultiplier", { matchId: matchId, multiplier: 2 });
			}
		},
		onSkip: function () {
			// No-fill / closed before completing — leave the button up for a retry, no toast.
			if (rewardedClaimState === "watching") { rewardedClaimState = "idle"; }
		},
		onError: function () {
			// SDK error / timeout — retry allowed + a soft toast.
			if (rewardedClaimState === "watching") { rewardedClaimState = "idle"; }
			if (typeof enqueueProgressionToasts === "function") {
				enqueueProgressionToasts([{ type: "xp_bonus_error" }]);
			}
		}
	});
}

// Hit-test a pointer (logical coords) against the results-screen reward button. On a hit,
// kicks off the rewarded flow. Returns true if the tap was consumed. Mirrors handleMapRatingTap.
function handleRewardButtonTap(lx, ly) {
	if (!rewardButtonAvailable() || !rewardButtonHit) { return false; }
	var h = rewardButtonHit;
	if (lx >= h.x && lx <= h.x + h.w && ly >= h.y && ly <= h.y + h.h) {
		triggerRewardButton();
		return true;
	}
	return false;
}

// The room's active playlist id for analytics, so rounds/matches can be segmented
// by playlist (defaults to the configured default until a lobbyPlaylistChanged
// arrives). Lets us tell whether wins/plays/skew concentrate in a given playlist.
function currentPlaylistIdForMetrics() {
	if (typeof lobbyPlaylist !== "undefined" && lobbyPlaylist) { return lobbyPlaylist; }
	return (typeof config !== "undefined" && config && config.defaultPlaylist) ? config.defaultPlaylist : "featured";
}

// Hit-test a pointer (logical coords) against the map-rating star widget. On a hit,
// optimistically fills the stars and emits the vote (server confirms via mapRated).
// Returns true if the tap was consumed by the widget. Shown on the per-round overview
// (rate the map you just played) and the match-over screen.
function handleMapRatingTap(lx, ly) {
	if (typeof config === "undefined" || config == null ||
		(currentState !== config.stateMap.overview && currentState !== config.stateMap.gameOver)) {
		return false;
	}
	if (!ratingMapId || !Array.isArray(ratingStarHits)) {
		return false;
	}
	for (var i = 0; i < ratingStarHits.length; i++) {
		var h = ratingStarHits[i];
		if (lx >= h.x && lx <= h.x + h.w && ly >= h.y && ly <= h.y + h.h) {
			myMapRating = h.stars; // optimistic; mapRated reflects the server ack
			if (typeof server !== "undefined" && server) {
				server.emit("rateMap", { stars: h.stars });
			}
			return true;
		}
	}
	return false;
}

// Socket.IO auth-callback form: invoked right before each (re)connection
// handshake, so the Supabase access token is read at connection time (after
// auth.js's getSession() microtask has settled) rather than at io() call time.
// Returns { token, deviceId }; token is null for guests, which the server
// allows. Falls back to {} if auth.js isn't present on the page.
function handshakeAuth(cb) {
	if (window.chaochaoAuth && typeof window.chaochaoAuth.getHandshake === "function") {
		cb(window.chaochaoAuth.getHandshake());
	} else {
		cb({});
	}
}

// Connect over WebSocket first and only fall back to HTTP long-polling if it
// fails (tryAllTransports). The default order is polling-then-upgrade, which on
// a high-latency link wastes several round trips on the long-poll handshake
// before upgrading — and prod logs showed far clients getting stuck on polling,
// the slowest transport. Skipping straight to WebSocket cuts connect latency and
// keeps the realtime gameUpdates path off long-polling; polling stays as a
// fallback for networks that block WebSockets.
var SOCKET_TRANSPORT_OPTS = { transports: ["websocket", "polling"], tryAllTransports: true };

function clientConnect() {
	// The primary connection (slot 0): the keyboard/mouse player and the sole
	// owner of rendering, audio, UI and one-shot/timer handlers. The globals
	// `server`/`myID`/`myPlayer` alias this slot (see game.js localPlayers).
	// This slot carries the signed-in account's token (if any).
	var sock = io({ auth: handshakeAuth, transports: SOCKET_TRANSPORT_OPTS.transports, tryAllTransports: SOCKET_TRANSPORT_OPTS.tryAllTransports });
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

	registerConnectionHandlers(server);
	registerScoreHandlers(server);
	registerStateHandlers(server);
	registerCombatHandlers(server);
	registerAbilityHandlers(server);
	registerEffectHandlers(server);
	registerLobbyHubHandlers(server);
}
// Lobby hub stations. `lobbyStations`/`lobbyAIChanged` are ROOM broadcasts handled
// only on the primary (every socket gets them; rendering/state lives on the
// primary). `stationEnter`/`stationExit` are per-PLAYER edges delivered to each
// player's OWN socket, so the primary's handler drives the primary slot and the
// secondary handler (registerSecondaryHandlers) drives each pad slot.
function registerLobbyHubHandlers(server) {
	server.on("lobbyStations", function (payload) {
		if (typeof applyLobbyStations === "function") {
			applyLobbyStations(payload);
		}
	});
	server.on("lobbyAIChanged", function (payload) {
		// Always apply — this is how every client (and our own slots) stay in sync with
		// the room-wide setting. Rapid local stepping is de-raced by debouncing the
		// EMIT (lobbyHub.adjustAILevel), not by suppressing this broadcast, so another
		// player's change is never dropped. { auto:true } => Auto (null).
		lobbyAISetting = (payload != null && payload.auto) ? null : payload;
	});
	server.on("playlistInfo", function (payload) {
		// Server pushed a refreshed playlist summary (counts / newly-visible
		// playlists after a ratings refresh) — update the lobby board's source list.
		if (typeof lobbyPlaylistInfo !== "undefined" && Array.isArray(payload)) {
			lobbyPlaylistInfo = payload;
		}
	});
	server.on("lobbyPlaylistChanged", function (payload) {
		// Room-wide playlist selection. Always apply so every client (and our own
		// slots) stay in sync; the EMIT is debounced (lobbyHub.adjustPlaylist), not
		// this broadcast.
		if (payload != null && typeof payload.id === "string") {
			lobbyPlaylist = payload.id;
		}
	});
	server.on("stationEnter", function (payload) {
		if (payload != null && typeof setSlotNearStation === "function") {
			setSlotNearStation(primarySlot, payload.id);
		}
	});
	server.on("stationExit", function (payload) {
		if (typeof clearSlotNearStation === "function") {
			clearSlotNearStation(primarySlot, payload != null ? payload.id : null);
		}
	});
	// A player changed skin (room broadcast — color isn't in the per-tick updates).
	// Keep the authoritative server colour in _serverColor so the colour-blind remap
	// (syncColorblind) stays correct; apply it to the live colour only when assist is
	// off (when on, the kart keeps its CVD-distinct colour, which is the point).
	server.on("playerSkinChanged", function (payload) {
		if (payload == null) {
			return;
		}
		var p = playerList[payload.id];
		if (p == null) {
			return;
		}
		p._serverColor = payload.color;
		if (typeof colorblindEnabled === "undefined" || !colorblindEnabled) {
			p.color = payload.color;
		}
		// A colour skin replaces any avatar skin (the server cleared it too).
		p.avatarUrl = null;
		p.name = null;
	});
	// A player equipped the opt-in avatar skin: show their picture on the kart
	// (drawn shrunk inside a border) and their name below it, for everyone.
	server.on("playerAvatarChanged", function (payload) {
		if (payload == null) {
			return;
		}
		var p = playerList[payload.id];
		if (p == null) {
			return;
		}
		p.avatarUrl = payload.avatarUrl || null;
		p.name = payload.name || null;
		if (p.avatarUrl && typeof preloadAvatarImage === "function") {
			preloadAvatarImage(p.avatarUrl);
		}
	});
	// A player equipped/cleared one of the three cosmetic slots (room broadcast — like
	// color, the slots aren't in the per-tick updates, only the spawn packet). Each slot
	// is independent of the others (and of color/avatar), so we set only the named slot:
	// cart -> p.cart, pattern -> p.pattern, trail -> p.trailFx.
	server.on("playerCosmeticChanged", function (payload) {
		if (payload == null) {
			return;
		}
		var p = playerList[payload.id];
		if (p == null) {
			return;
		}
		var field = COSMETIC_SLOT_FIELD[payload.slot];
		if (field) {
			p[field] = payload.value || null;
		}
	});
	// The primary's skin request was rejected (color taken). Flash the picker.
	server.on("skinRejected", function (payload) {
		if (typeof flagSkinRejected === "function") {
			flagSkinRejected(primarySlot, payload != null ? payload.color : null);
		}
	});
	// A cosmetic equip was rejected (locked / not unlocked / wrong slot). Show the
	// requirement on the relevant lobby group.
	server.on("cosmeticRejected", function (payload) {
		if (typeof flagCosmeticRejected === "function") {
			flagCosmeticRejected(primarySlot, payload);
		}
	});
}
// Local signed-in player's progression (server-authoritative, pushed via
// progressionUpdate on join + after each match). null = guest / not yet loaded.
// Drives the lobby Lv/XP badge + the skin-unlock UI; never trusted for equips.
var myProgression = null;

// --- Progression celebration toasts (shown on lobby arrival) -----------------
// A sequenced queue: one toast at a time, auto-advancing, so a match that earned
// XP + a level-up + a couple of skins reads as a short reward sequence rather than
// a wall. Reuses the cc-toast styling family (css/styles.css). DOM-based so it
// layers over the canvas without touching the render loop.
var progressionToastQueue = [];
var progressionToastShowing = false;
var PROGRESSION_TOAST_MS = 5000; // applies to ALL progression toasts (xp / level-up / skin unlock / seasonal)

function progressionToastText(ev) {
	if (!ev || !ev.type) { return null; }
	if (ev.type === "xp") {
		return ev.amount > 0 ? ("+" + ev.amount + " XP") : null;
	}
	// Rewarded-video "2× match XP" claim feedback (results screen). The bonus is the EXTRA
	// XP credited on top of what the match earned (2× total = +1× of the original).
	if (ev.type === "xp_bonus") {
		return ev.amount > 0 ? ("⭐ +" + ev.amount + " bonus XP — match XP doubled!") : "⭐ Match XP doubled!";
	}
	if (ev.type === "xp_bonus_error") {
		return "Ad didn't finish — tap to try again for 2× XP.";
	}
	if (ev.type === "level") {
		return "⬆️ Level up!  Lv " + ev.level;
	}
	var nm = (typeof skinDisplayName === "function") ? skinDisplayName(ev.id) : ev.id;
	// Name the cosmetic by its slot so the toast reads "New cart/pattern/trail unlocked".
	var slot = (typeof getSkinSlot === "function") ? getSkinSlot(ev.id) : null;
	var slotWord = slot === "cart" ? "cart" : slot === "pattern" ? "pattern" : slot === "trail" ? "trail" : "cosmetic";
	if (ev.type === "seasonal") {
		// A limited-time seasonal claim — a one-time, never-again cosmetic. The season's
		// player-facing name comes from the registry entry's unlock.label (data-driven, so a
		// future season needs no edit here); falls back to "Limited" if absent.
		var sk = (typeof getSkin === "function") ? getSkin(ev.id) : null;
		var label = (sk && sk.unlock && sk.unlock.label) ? sk.unlock.label : "Limited";
		return "🌟 " + label + " " + slotWord + " claimed: " + nm;
	}
	if (ev.type === "skin") {
		return "🎨 New " + slotWord + " unlocked: " + nm;
	}
	if (ev.type === "achievement") {
		return "🏆 Achievement " + slotWord + ": " + nm;
	}
	return null;
}
function enqueueProgressionToasts(events) {
	for (var i = 0; i < events.length; i++) {
		var txt = progressionToastText(events[i]);
		if (txt) { progressionToastQueue.push(txt); }
	}
	if (!progressionToastShowing) { showNextProgressionToast(); }
}
function showNextProgressionToast() {
	if (progressionToastQueue.length === 0) { progressionToastShowing = false; return; }
	if (!document.body) { progressionToastShowing = false; return; }
	progressionToastShowing = true;
	var txt = progressionToastQueue.shift();
	var el = document.createElement("div");
	el.className = "cc-toast cc-progression-toast";
	el.setAttribute("role", "status");
	el.innerHTML = '<span class="cc-toast-msg"></span>';
	el.querySelector(".cc-toast-msg").textContent = txt; // textContent: never inject
	document.body.appendChild(el);
	// next frame -> add .visible so the CSS transition runs
	requestAnimationFrame(function () { el.classList.add("visible"); });
	setTimeout(function () {
		el.classList.remove("visible");
		setTimeout(function () {
			if (el.parentNode) { el.parentNode.removeChild(el); }
			showNextProgressionToast();
		}, 400); // matches the cc-toast fade-out transition
	}, PROGRESSION_TOAST_MS);
}
// Drop any queued/visible progression toasts. Called when the lobby ends (startGated) so a long
// reward sequence (now ~5s each) can never keep popping over live gameplay — same rationale as
// dismissing the between-matches ad at the gate. Pending fade timeouts no-op on the removed nodes.
function clearProgressionToasts() {
	progressionToastQueue.length = 0;
	progressionToastShowing = false;
	if (typeof document !== "undefined" && document.querySelectorAll) {
		var open = document.querySelectorAll(".cc-progression-toast");
		for (var i = 0; i < open.length; i++) {
			if (open[i].parentNode) { open[i].parentNode.removeChild(open[i]); }
		}
	}
}

// Fire the `cosmetics_equipped` GA event once per MATCH (cosmetics are fixed for a match),
// not once per round. Reset when a new match's lobby forms (startLobby).
var cosmeticsTrackedThisMatch = false;
function registerConnectionHandlers(server) {
	server.on('welcome', function (id) {
		debugLog("welcome, myID=", id);
		myID = id;
		if (localPlayers[primarySlot]) {
			localPlayers[primarySlot].myID = id;
			// Re-apply the locally-saved cosmetic slots so the player's picks persist
			// across reloads/rejoins without reopening the picker (server re-validates).
			if (typeof reEquipSavedCosmetics === "function") {
				reEquipSavedCosmetics(localPlayers[primarySlot]);
			}
		}
	});
	// Authoritative progression for the signed-in player (XP/level/unlocked skins).
	server.on('progressionUpdate', function (prog) {
		myProgression = prog || null;
		debugLog("progressionUpdate level=", prog && prog.level, "xp=", prog && prog.xp);
	});
	// Celebration toasts earned in a prior match, delivered on lobby arrival (NOT on
	// the game-over screen). Server sends an ordered batch; we sequence them as
	// individual toasts. Each event: {type:'xp',amount} | {type:'level',level} |
	// {type:'skin',id} | {type:'achievement',id}.
	server.on('progressionToasts', function (payload) {
		var events = (payload && Array.isArray(payload.events)) ? payload.events : [];
		if (events.length) { enqueueProgressionToasts(events); }
	});
	// Rewarded "2× match XP" claim acked by the server (after it validated + credited the
	// bonus). Announce it immediately on the results screen and fire the reward_claimed GA
	// event. The server already pushed a fresh progressionUpdate for the lobby badge (writes-on);
	// we only handle the celebration + analytics here so the funnel match_end -> ad_shown ->
	// ad_complete -> reward_claimed closes.
	server.on('xpBonus', function (payload) {
		var bonus = (payload && typeof payload.bonus === "number") ? payload.bonus : 0;
		rewardedClaimState = "claimed";
		if (typeof enqueueProgressionToasts === "function") {
			enqueueProgressionToasts([{ type: "xp_bonus", amount: bonus }]);
		}
		trackEvent('reward_claimed', {
			bonus: 'xp_2x',
			match_id: (payload && payload.matchId) || currentMatchId || ''
		});
	});

	// botGuard: the server confirmed this client actually drove a kart (not a pageview-only
	// bot). Fire the trustworthy human KPI exactly once per page session. trackEvent is the
	// shared gtag helper defined in the page head; it no-ops if gtag is blocked.
	server.on("verifiedHuman", function () {
		if (window.__verifiedHumanSent) { return; }
		window.__verifiedHumanSent = true;
		trackEvent('verified_human');
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
			// Re-equip saved cosmetics NOW that we're actually in the room. The `welcome`
			// re-equip fires before enterGame (roomMailList unset server-side), so those
			// setCosmetic emits are dropped; this is the effective restore, esp. for guests
			// and the writes-off path (no server-side restorePersistedCosmetics). setCosmetic
			// is lobby-only, so guard on the lobby state.
			if (currentState === config.stateMap.lobby && typeof reEquipSavedCosmetics === "function") {
				reEquipSavedCosmetics(localPlayers[primarySlot]);
			}
		}
		if (playerList[myID] != null) {
			myPlayer = playerList[myID];
		}
		// Joined a match already racing/collapsing? The server spawned this player as
		// a temp spectator (parked off-arena, not alive) who races from the next
		// round — flag the slot so drawSpectatorBanner explains the wait. The server
		// spectator-izes exactly the racing/collapsing states, so the state alone is
		// the signal; the banner's own !alive check gates the display. Cleared for
		// every slot at the next startGated.
		if (localPlayers[primarySlot]) {
			localPlayers[primarySlot].lateJoinSpectating =
				(currentState == config.stateMap.racing || currentState == config.stateMap.collapsing);
		}
		//Late joiners: pick up the race already in progress on the right track/mood.
		if (gameState.music != null) {
			setBackgroundMusic(gameState.music.mood, gameState.music.track);
		}
		setupEmojiWheel();
		// Mid-join rehydration of the lobby hub: a player who joins mid-lobby missed
		// the startLobby `lobbyStations` broadcast, so the snapshot carries them (plus
		// the live room AI setting) here. Null/absent outside the lobby.
		if (typeof applyLobbyStations === "function") {
			applyLobbyStations(gameState.lobbyStations);
		}
		lobbyAISetting = (gameState.lobbyAI != null) ? gameState.lobbyAI : null;
		// Sync the room-wide playlist on mid-join so a late joiner shows the real
		// selection (not the default) and doesn't clobber it when stepping the board.
		if (gameState.lobbyPlaylist != null) {
			lobbyPlaylist = gameState.lobbyPlaylist;
		}
		// Refresh the hint UI now the primary has joined (solo bottom bar by
		// default; switches to per-player blocks once a 2nd local player joins).
		if (typeof onLocalPlayersChanged === "function") {
			onLocalPlayersChanged();
		}
		// Mid-match joiners: seed crowd intensity from the current standings so it
		// isn't stuck tame if someone is already closing in on the win.
		updateAudienceIntensity();
	});

	server.on("playerJoin", function (appendPlayerList) {
		clientList[appendPlayerList.id] = appendPlayerList.id;
		appendNewPlayer(appendPlayerList.player);
		// Pre-late-join this only fired pre-race (lobby/waiting). With public
		// late-join enabled, the same broadcast now reaches racers mid-round for a
		// spectator who isn't even on the track — don't ring the chime over an
		// active race. Lobby/waiting/gameOver keep the welcome cue.
		if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) {
			playSound(playerJoinSound);
		}
	});
	server.on("playerLeft", function (id) {
		// Always drop the rendered player. AI racers live in playerList but may be
		// absent from a mid-game joiner's clientList (the server room's clientList
		// excludes bots), so gating the delete on clientList left them as frozen
		// ghost karts when removeBots() fired. Delete from both unconditionally.
		delete clientList[id];
		delete playerList[id];
	});

	server.on("gameUpdates", function (updatePacket) {
		updatePlayerList(updatePacket.playerList);
		updateProjecileList(updatePacket.projList);
		updateAimerList(updatePacket.aimerList);
		updateHazardList(updatePacket.hazardList);
		checkGameState(updatePacket.state);
		totalPlayers = updatePacket.totalPlayers;
		timeSinceLastCom = 0;
		// Buffer this tick's positions for the end-of-game recap montage.
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
			recapCaptureFrame();
		}
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
				maps.push(reconstructSitesOnlyMap(data));
			}));
		}
	});
	server.on("contentDelivery", function (payload) {
		var payload = JSON.parse(payload);
		var mapnames = payload.mapnames;
		var imagenames = payload.imagenames;
		// Boot-time playlist summary ([{id,name,desc,count}]) for the lobby hub board.
		if (typeof lobbyPlaylistInfo !== "undefined" && Array.isArray(payload.playlists)) {
			lobbyPlaylistInfo = payload.playlists;
		}
		for (var i = 0; i < imagenames.length; i++) {
			promises.push($.get("../assets/img/" + imagenames[i]));
		}
		for (var i = 0; i < mapnames.length; i++) {
			promises.push($.getJSON("../maps/" + mapnames[i], function (data) {
				maps.push(reconstructSitesOnlyMap(data));
			}));
		}
		// Sounds are deliberately NOT preloaded into `promises` (the loading-screen
		// gate): the audio engine in audio.js loads them itself — lobby music up
		// front, the rest (tens of MB of gameplay music/SFX) throttled in the
		// background — and plays anything not-yet-decoded on-demand. Blocking lobby
		// entry on the full audio download was the #1 cause of mobile load timeouts
		// on far/slow links (a phone in Vietnam never cleared the loading bar).
		setupPage();
	});

}
function registerScoreHandlers(server) {
	server.on("firstPlaceWinner", function (id) {
		createFirstRankSymbol(id);
	});
	server.on("secondPlaceWinner", function (id) {
		createSecondRankSymbol(id);
	});
	server.on("playerConcluded", function (packet) {
		var id = (packet != null && packet.id != null) ? packet.id : packet;
		if (playerList[id] != null) {
			playerList[id].alive = false;
			// Stamp goal-cross + server-authoritative finish elapsed (ms) so the
			// HUD timer can freeze on the exact server value rather than the
			// receive-time approximation, and so drawRaceTimer's "did the local
			// player finish?" check has a real signal to read.
			playerList[id].reachedGoal = true;
			if (packet != null && typeof packet.finishMs === 'number') {
				playerList[id].finishMs = packet.finishMs;
			}
			playerList[id].recapState = RECAP_SCORED; // recap: vanish with a goal poof, not hover the goal
		}
		recapMarkHighlight('goal', [id]); // flag a scoring moment for the recap
		playSound(playerFinished);
		// Lava was chasing when they crossed the line — the crowd erupts.
		if (packet != null && packet.clutch) {
			playAudience(pickCrowdBig(), 2);
		}
	});
	server.on("playerDied", function (packet) {
		var id = (packet != null && packet.id != null) ? packet.id : packet;
		playSound(playerDiedSound);
		playerAbilityUsed(id);
		if (playerList[id] != null) {
			playerList[id].alive = false;
			playerList[id].recapState = RECAP_DIED; // recap: vanish with a death poof, not hover the lava
			playerList[id].onFire = 0;
			playerList[id].deathMessage = '💀';
			// Remember where/when they fell: a dead local player can press attack
			// to ping every dead player's spot, and the floating skull fades from
			// deathAt — see updateDeathPings()/drawDeathMessage() in draw.js.
			// Use the authoritative server position (tx/ty), not the eased render
			// position (x/y), so the death skull/ping lands where the kart actually
			// died (x/y lags by ~tau, noticeable for a fast death into lava).
			// Prefer the authoritative position from the server (packet.x/y); fall
			// back to the eased/server-tx position only if the server didn't send
			// it (a kart that crossed onto lava between server ticks has its post-
			// lava tx/ty sent in the NEXT gameUpdates, after this event).
			var srvX = (packet != null && packet.x != null) ? packet.x : null;
			var srvY = (packet != null && packet.y != null) ? packet.y : null;
			playerList[id].deathX = (srvX != null) ? srvX :
				((playerList[id].tx != null) ? playerList[id].tx : playerList[id].x);
			playerList[id].deathY = (srvY != null) ? srvY :
				((playerList[id].ty != null) ? playerList[id].ty : playerList[id].y);
			playerList[id].deathAt = Date.now();
			// Lava deaths get the sinking corpse. The server now tags the cause
			// directly (packet.cause === "lava"); we still keep a tile-lookup
			// fallback for the edge case where the server doesn't send a cause
			// (legacy/test paths) but the authoritative position lands on lava.
			var byLava = (packet != null && packet.cause === "lava");
			if (!byLava && typeof tileIdAt === "function" && config != null &&
				config.tileMap != null && config.tileMap.lava != null) {
				byLava = (tileIdAt(playerList[id].deathX, playerList[id].deathY) == config.tileMap.lava.id);
			}
			if (byLava && typeof spawnSinkingCorpse === "function") {
				spawnSinkingCorpse(playerList[id]);
			}
		}
		recapMarkHighlight('death', [id]); // flag an elimination moment for the recap
		createDownRankSymbol(id);
		// Solo preview pops back to the editor the instant the creator dies. In a co-op
		// preview (2+ local players) one death shouldn't yank everyone out — let the round
		// play on; the round-end handler (startOverview) returns to the editor instead.
		if (id == myID && (typeof liveLocalPlayerCount !== "function" || liveLocalPlayerCount() <= 1)) {
			previewReturnToEditor();
		}
		// A player-caused kill (not someone driving into the lava) gets a cheer.
		if (packet != null && packet.killed) {
			playAudience(pickCrowdCheer(), 1);
		}
	});
	server.on("playerInfected", function (id) {
		playerList[id].alive = true;
		playerList[id].recapState = RECAP_ALIVE; // revived as a zombie — back in play for the recap
		playerList[id].deathMessage = null;
		// Revived as a zombie — clear the death spot so no stale skull/ping data
		// lingers on a now-alive player (keeps the death-state guards consistent
		// across every revive/reset path).
		playerList[id].deathX = null;
		playerList[id].deathY = null;
		playerList[id].deathAt = null;
		playerList[id].infected = true;
		playSound(newZombie);
	});
	server.on("broadCastEmoji", function (payload) {
		playerList[payload.ownerId].chatMessage = payload.emoji;
		// Stamp when/how long so drawEmoji can fade other players' bubbles out.
		var emoteStamp = Date.now();
		playerList[payload.ownerId].chatMessageAt = emoteStamp;
		playerList[payload.ownerId].chatMessageDuration = 4000;
		setTimeout(function (owner) {
			// Only clear if still the same emote — a newer one re-stamps
			// chatMessageAt, so this older timeout must not cut it short.
			if (playerList[owner] != null && playerList[owner].chatMessageAt === emoteStamp) {
				playerList[owner].chatMessage = null;
			}
		}, 4000, payload.ownerId);
	});
	server.on('playerSleeping', function (id) {
		playerList[id].awake = false;
	});
	server.on('playerAwake', function (id) {
		playerList[id].awake = true;
	});

	//Game State Map changes
}
// Bot count for analytics — playerList[id].name is the spawn-packet bot marker
// (compressor.js sets player.name only on bot append; humans stay null).
function countBotsInPlayerList() {
	if (playerList == null) { return 0; }
	var n = 0;
	for (var id in playerList) {
		if (playerList[id] != null && playerList[id].name != null) { n++; }
	}
	return n;
}
function registerStateHandlers(server) {
	server.on("startWaiting", function (packet) {
		debugLog("startWaiting");
		recapNewMatch(); // a fresh match is forming — drop last game's recap clips
		setLobbySfxDampen(false); // lobby emptied back to waiting — restore full SFX
		if (typeof lobbyHubReset === "function") {
			lobbyHubReset();
		}
		currentState = config.stateMap.waiting;
		playSoundAfterFinish(lobbyMusic);
	});
	server.on("startLobby", function (packet) {
		debugLog("startLobby, packet=", packet);
		// Was the player just on the match-over results screen? If so this startLobby
		// is the BETWEEN-MATCHES transition — the natural ad break. We read an explicit
		// flag set in startGameover (NOT currentState): the server emits startWaiting
		// between gameOver and this startLobby, so currentState is already `waiting`
		// here and a state-compare would never be true for the normal match loop.
		// (First lobby of a session is reached without a prior gameOver, so the flag
		// is false and no ad fires there.)
		var cameFromGameOver = adPendingMatchEnd;
		adPendingMatchEnd = false;
		recapNewMatch(); // a fresh match is forming — drop last game's recap clips
		// Set state first so loadNewMap doesn't run its gated-only goal-ping branch.
		currentState = config.stateMap.lobby;
		trackEvent('lobby_entered');
		cosmeticsTrackedThisMatch = false; // new match forming — re-arm the cosmetics event
		spawnLobbyStartButton(packet);
		setLobbySfxDampen(true);
		playSoundAfterFinish(lobbyMusic);
		// Monetization: a frequency-capped interstitial may run HERE, at the
		// gameOver -> lobby edge — AFTER the player has had the full game-over window
		// to see their results/medals/recap, and as the next match's lobby comes up.
		// Strictly fail-open and cosmetic: onClose is a no-op, the lobby is already
		// live underneath, and the SDK missing/throwing/timing out all proceed
		// unchanged. onMatchEnded advances the per-match cadence counter regardless of
		// whether an ad actually shows.
		if (cameFromGameOver && window.ads && typeof window.ads.onMatchEnded === "function") {
			try {
				window.ads.onMatchEnded();
				if (window.ads.canShowInterstitial()) {
					window.ads.showInterstitial({ placement: "between_matches", onClose: function () {} });
				}
			} catch (e) { /* ads must never break the lobby transition */ }
		}
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
		// The next round is starting — tear down any between-matches interstitial that
		// is still up so an ad can never sit over live gameplay (other racers may have
		// rallied the lobby while this client was watching). No-op if nothing's showing.
		if (window.ads && typeof window.ads.dismissInterstitial === "function") {
			try { window.ads.dismissInterstitial(); } catch (e) { /* never block the gate */ }
		}
		// Same idea for celebration toasts: clear the queue so a long reward sequence doesn't
		// keep popping over the race that's starting (toasts belong to the lobby).
		if (typeof clearProgressionToasts === "function") { clearProgressionToasts(); }
		setLobbySfxDampen(false); // restore full SFX before the game-start cue
		stopSound(lobbyMusic);
		playSound(gameStart);
		// Match starting — force-close any open hub panel + drop the zones/prompts.
		if (typeof lobbyHubReset === "function") {
			lobbyHubReset();
		}
		// The next round gates everyone in, including any late-join spectators from
		// the previous round — they're racing now, so drop the banner for every slot.
		for (var ljs = 0; ljs < localPlayers.length; ljs++) {
			if (localPlayers[ljs]) { localPlayers[ljs].lateJoinSpectating = false; }
		}
		// Wipe the sand trench so a round always starts on clean sand. Fires every
		// round's gate phase — covers lobby -> round 1 (lobby trench accrued while
		// idling) and between rounds — and runs before the gate/countdown renders.
		if (typeof discardTrenchDecal === "function") { discardTrenchDecal(); }
		// Stamp the countdown start so the start-line glow can ramp toward release.
		gatedStartTime = Date.now();
		raceStartTime = null;
		currentState = config.stateMap.gated;
	});
	server.on("startRace", function (packet) {
		// Belt-and-suspenders: also tear down any lingering interstitial here, in case
		// a client reaches racing without passing through gated (e.g. the preview
		// play-test path skips the gate). No-op if nothing's showing or already torn down.
		if (window.ads && typeof window.ads.dismissInterstitial === "function") {
			try { window.ads.dismissInterstitial(); } catch (e) { /* never block the race */ }
		}
		playSound(countDownB);
		if (packet != null && packet.music != null) {
			setBackgroundMusic(packet.music.mood, packet.music.track);
		}
		oldNotches = {};
		resetTrails();
		resetPlayerRanks();
		recapReset(); // start a fresh recap buffer for this round's map
		// Anchor the HUD timer to the CLIENT's Date.now() at receipt — mixing
		// server's Date.now() with the browser's local Date.now() would drift
		// arbitrarily if the player's system clock disagrees with the server's.
		// Server's raceStartedAt (in packet.raceStartedAt) is intentionally
		// ignored here; the server-authoritative finishMs delta arrives later
		// in playerConcluded for goal-cross freeze.
		raceStartedAt = Date.now();
		// Clear last round's spectator board + any lingering record floats so
		// they don't bleed into the new race before the server's mapLeaderboardCurrent
		// arrives.
		mapLeaderboardCurrent = null;
		recordFloats.length = 0;
		// Reset the per-race local-player timer freeze (re-stamped on death or
		// goal-cross by drawRaceTimer's transition detector).
		localTimerStopAt = null;
		localTimerStopByDeath = false;
		// Clear any lingering WR banner from the prior round.
		worldRecordBanner = null;
		// Stamp the gate-release moment so the start line can flash green as it fades.
		raceStartTime = Date.now();
		currentState = config.stateMap.racing;
		// Fires once per round (racing state is re-entered each round), so this is a
		// round-start signal. `players` counts humans only (clientList = room's
		// client roster, excludes bots); `bots` counts AI fill via the spawn-packet
		// `name` marker (server compressor sets player.name only on bot append; humans
		// stay null — see compressor.js gameState).
		trackEvent('round_start', {
			players: clientList ? Object.keys(clientList).length : 0,
			bots: countBotsInPlayerList(),
			map: (currentMap && currentMap.name) || 'unknown',
			playlist: currentPlaylistIdForMetrics()
		});
		// Once per match: which cosmetics the LOCAL player chose to race with. One event with
		// all four slots so GA can chart per-slot popularity AND popular combinations.
		// 'none' = the slot's default (no cart shape / pattern / trail / border).
		if (!cosmeticsTrackedThisMatch) {
			cosmeticsTrackedThisMatch = true;
			var mp = (typeof myID !== "undefined" && typeof playerList !== "undefined" && playerList) ? playerList[myID] : null;
			if (mp) {
				trackEvent('cosmetics_equipped', {
					cart: mp.cart || 'none',
					pattern: mp.pattern || 'none',
					trail: mp.trailFx || 'none',
					border: mp.border || 'none'
				});
			}
		}
	});
	//Server-driven mood change (near-victory) or next track (previous one ended).
	server.on("musicMood", function (packet) {
		if (packet != null) {
			setBackgroundMusic(packet.mood, packet.track);
		}
	});
	server.on("startOverview", function (packet) {
		// Round ended (solo death or goal reached) — harvest this round's best clips
		// into the cross-round recap archive (uses the buffer + map snapshot captured
		// during the round, so it's safe to run before resetRound clears live state).
		recapHarvestRound();
		// Schedule the editor return first, so a throw in the rendering calls below
		// can't strand the creator.
		previewReturnToEditor();
		resetRound();
		stopSound(lavaCollapse);
		resetTrails();
		updatePlayerNotches(packet.notchUpdates);
		// Notches just changed — escalate the crowd toward "edge of their seats"
		// as the leader closes in on the win.
		updateAudienceIntensity();
		calculateNotchMoveAmt();
		// resetRound() above cleared the `infection` flag, but the baked lava pattern is
		// still the poison-green texture from the just-ended infection round (loadPatterns
		// only re-bakes it on a map load, which hasn't happened yet). Rebuild patterns now
		// so the next-map preview thumbnail — which reads patterns[lava] — doesn't inherit
		// the zombie lava colour.
		loadPatterns();
		loadMapPreview(packet.nextMapID);
		// Clear last round's leaderboards so stale rows don't flash on the new
		// overview before the server's async queries return.
		mapLeaderboardData = null;
		mapLeaderboardJustPlayed = null;
		currentState = config.stateMap.overview;
		// Set up the "rate this map" widget for the map JUST played (currentMap is
		// still the played map here — the next map only loads at the next gate). Reset
		// the picked stars so each round's overview rates its own map.
		ratingMapId = (packet.mapId != null) ? packet.mapId : ((currentMap && currentMap.id) || null);
		ratingMapName = (packet.mapName != null) ? packet.mapName : ((currentMap && currentMap.name) || null);
		myMapRating = 0;
		ratingStarHits = [];
		ratingPadCursor = 0;
		trackEvent('round_complete', {
			map: (currentMap && currentMap.name) || 'unknown',
			playlist: currentPlaylistIdForMetrics()
		});
	});
	// Map leaderboard for the JUST-PLAYED map (rank/time per logged-in racer in
	// this room). Drives the inline rank/time shown alongside each notch row on
	// the overview, so even the last finisher catches their result.
	server.on("mapLeaderboardJustPlayed", function (packet) {
		if (packet == null || !packet.rows) { return; }
		mapLeaderboardJustPlayed = packet;
	});
	// Map leaderboard for the UPCOMING map (global top 10). Drives the "Times
	// to beat for <map>" card under the next-map preview on the overview.
	server.on("mapLeaderboardNextMap", function (packet) {
		if (packet == null) { return; }
		mapLeaderboardData = packet;
	});
	// Map leaderboard for the CURRENT (racing) map. Drives the spectator
	// mini-leaderboard widget in the HUD corner. Fired once at race start.
	server.on("mapLeaderboardCurrent", function (packet) {
		if (packet == null) { return; }
		mapLeaderboardCurrent = packet;
	});
	// A logged-in racer just set a personal (and possibly world) record on the
	// current map. Spawn a floating "NEW PERSONAL/WORLD RECORD!! <time>" above
	// their kart, and — for world records (rank<=10 globally) — also raise a
	// screen-space banner so it's visible regardless of camera position.
	server.on("playerPbResult", function (packet) {
		if (packet == null || !packet.playerId || !packet.isNewRecord) { return; }
		recordFloats.push({
			playerId: packet.playerId,
			isWorldRecord: !!packet.isWorldRecord,
			finishMs: packet.finishMs,
			startedAt: Date.now()
		});
		if (packet.isWorldRecord) {
			worldRecordBanner = {
				// Same "Anon" placeholder used on the overview/spectator
				// leaderboards when a signed-in racer has no name metadata.
				displayName: packet.displayName || 'Anon',
				mapName: packet.mapName || 'this map',
				finishMs: packet.finishMs,
				rank: packet.rank || null,
				startedAt: Date.now()
			};
		}
	});
	server.on("mapRated", function (payload) {
		// Server confirmation of our star vote — reflect the acknowledged value, but
		// only if it's for the map currently being rated. Ratings now happen every
		// overview, so a slow ack from a previous round could otherwise resolve after
		// ratingMapId moved on and overwrite the new map's selection with a stale one.
		if (payload != null && typeof payload.stars === "number" && payload.mapId === ratingMapId) {
			myMapRating = payload.stars;
		}
	});
	server.on("startGameover", function (packet) {
		// Match over (solo creator hit the winning notch) — schedule the editor
		// return first so the calls below can't strand the creator if they throw.
		previewReturnToEditor();
		// Match over — clear the final round's sand trench so it doesn't linger into
		// the game-over screen or the return to the lobby.
		if (typeof discardTrenchDecal === "function") { discardTrenchDecal(); }
		// Clear any full-screen brutal overlay still up when the match ended — the
		// blackout darkness or a blindfold tint — so it can't sit on top of (and hide)
		// the game-over screen. These are set by their own events, never re-set per
		// tick, so clearing them here holds for the whole game-over screen.
		blackout = false;
		blackoutStart = null;
		blindfold = {};
		playerWon = packet.winner;
		achievements = packet.achievements;
		// Set up the "rate this map" widget for the game-over screen.
		ratingMapId = (packet.mapId != null) ? packet.mapId : ((currentMap && currentMap.id) || null);
		ratingMapName = (packet.mapName != null) ? packet.mapName : ((currentMap && currentMap.name) || null);
		myMapRating = 0;
		ratingStarHits = [];
		ratingPadCursor = 0;
		// Rewarded "2× match XP" button: bind it to THIS match and reset its claim state so
		// it can be earned once. matchId is server-stamped (absent from an older server -> the
		// button simply never offers, since rewardButtonAvailable() requires it).
		currentMatchId = (packet && packet.matchId != null) ? packet.matchId : null;
		rewardedClaimState = "idle";
		rewardButtonHit = null;
		rewardPadFocused = false;
		// Bump the medals-card reveal nonce so its entrance animation replays for
		// this match — even when the same player wins back-to-back (playerWon
		// unchanged). drawGameOverScreen watches this (see draw.js).
		if (typeof medalRevealNonce === "number") { medalRevealNonce++; }
		// Progression XP/level/skin celebration is NOT shown here — it's delivered as
		// toasts when the player next arrives in the lobby (progressionToasts handler).
		recapHarvestRound();      // fold the final round's clips into the archive first
		recapBuild(achievements); // then assemble the montage from the whole-match archive
		stopAllSounds();
		playSound(gameOverSound);
		// Decode the SERVER colour (not the live .color, which colour-blind assist
		// may have remapped to an off-palette CVD hex that Colors.decode can't name).
		var winner = playerList[packet.winner];
		decodedColorName = (winner != null)
			? Colors.decode((winner._serverColor != null) ? winner._serverColor : winner.color)
			: "";
		currentState = config.stateMap.gameOver;
		trackEvent('match_end', {
			won: (packet.winner === myID),
			map: (currentMap && currentMap.name) || 'unknown',
			playlist: currentPlaylistIdForMetrics(),
			players: clientList ? Object.keys(clientList).length : 0,
			bots: countBotsInPlayerList()
		});
		// Nudge signed-out players to log in (save progress / earn skins). No-op
		// when auth is off or already signed in. Primary screen only.
		if (window.chaochaoAuth && typeof window.chaochaoAuth.showLoginNudge === "function") {
			window.chaochaoAuth.showLoginNudge();
		}
		// Monetization: arm the between-matches interstitial. The ad is intentionally
		// NOT shown here — it runs at the gameOver -> lobby edge (see the startLobby
		// handler) so the player gets the full game-over window to see their
		// results/medals/recap uninterrupted. We only RECORD that a match just ended;
		// startLobby consumes this flag. An explicit flag (not a currentState check) is
		// required because the server emits startWaiting (currentState -> waiting)
		// between this and the next startLobby, so a state-compare there is always false.
		adPendingMatchEnd = true;
	});
	server.on("startCollapse", function (info) {
		currentState = config.stateMap.collapsing;
		playSound(lavaCollapse);
		// Telegraph: erupt a shockwave from where the lava first appears and
		// spreads, plus the volcano cue. info may be null from an older server.
		if (info && typeof info.originX === "number") {
			spawnCollapseShockwave(info.originX, info.originY);
			playSound(volcanoErupt);
			rumbleScreen(1500);
		}
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
		// New match — the crowd starts tame again, and brawl tracking is cleared so
		// a fight lockout from the last match can't suppress the first new scrum.
		setAudienceIntensity(0);
		recentPunchTimes.length = 0;
		nextFightReactionTime = 0;
	});
	server.on("gameLength", function (length) {
		gameLength = length;
	});

}
function registerCombatHandlers(server) {
	server.on("punch", function (packet) {
		var punch = spawnPunch(packet);
		spawnPunchEffect(punch);
		var owner = playerList[punch.ownerId];
		// Seed the cart-skin punch animation (forward lunge + impact pop) on a kart's
		// own melee swing — not on bumper hits, which aren't a kart throwing a punch.
		if (owner != null && punch.type == "player") {
			owner.punchAnimAt = Date.now();
		}
		if (owner != null && owner.infected) {
			playSoundVaried(zombieSwing, 0.1);
			return;
		}
		if (punch.type == "player") {
			playSoundVaried(meleeSound, 0.1);
		}
		if (punch.type == "bumper") {
			playSoundVaried(bumperSound, 0.08);
		}

	});
	server.on("punchClash", function (payload) {
		// Two players countered each other — both got flung back, neither landed the
		// hit. A bright parry flash at the midpoint sells the "clang". The two swing
		// "punch" events already played the melee sound, so don't stack a third here;
		// the gold star is the distinct visual cue for the clash.
		if (payload != null && payload.x != null && payload.y != null) {
			spawnClashEffect(payload.x, payload.y);
		}
	});
	server.on("spawnBomb", function (owner) {
		spawnBomb(owner);
		fireMuzzleFlash(owner, "#ffcf8f");
		playSound(bombShot);
	});
	server.on("spawnPuck", function (owner) {
		spawnPuck(owner);
		playSound(bombShot);
	});
	server.on("applyBlackout", function (owner) {
		blackout = true;
		blackoutStart = Date.now();
		playSound(blackoutSound);
	});

	server.on("spawnSnowFlake", function (owner) {
		spawnSnowFlake(owner);
		fireMuzzleFlash(owner, "#bfefff");
		playSound(bombShot);
	});
	server.on("spawnClouds", function (packet) {
		spawnClouds(packet);
	});
	server.on("playerPunched", function (payload) {
		// payload: { owner: attacker id, victim: id of whoever got hit, x, y: the
		// victim's position }. victim may be a non-player target (e.g. the hockey
		// puck), so use the payload position rather than a playerList lookup for
		// the spark — that way bashing the puck still gets a hit effect.
		var owner = payload != null ? payload.owner : null;
		var victim = payload != null ? payload.victim : null;
		var victimPlayer = playerList[victim];
		var hitX = victimPlayer != null ? victimPlayer.x : (payload != null ? payload.x : null);
		var hitY = victimPlayer != null ? victimPlayer.y : (payload != null ? payload.y : null);
		if (hitX != null && hitY != null) {
			var sparkColor = playerList[owner] != null ? playerList[owner].color : "white";
			spawnHitEffect(hitX, hitY, sparkColor);
			// Watch a real player victim for a long knockback slide (e.g. flung across
			// the ice) — the recap turns a big launch into its own highlight clip.
			if (victimPlayer != null && typeof recapNotePunchLaunch === "function") {
				recapNotePunchLaunch(victim, hitX, hitY);
			}
			// A fully-charged punch landing gets a meaty "thwack" (Smash-style charged
			// bat) and an extra kick, on top of the normal swing/hit feedback.
			if (payload != null && payload.charged) {
				playSound(chargedHitSound);
				if ((isLocalId(victim) || isLocalId(owner)) && currentState != config.stateMap.gated) {
					addTrauma(0.4);
				}
			}
			// Feel a connecting hit when a local player is on either end of it —
			// but not during the gated countdown (jostling at the start line
			// shouldn't rattle the camera while everyone's waiting to race).
			else if ((isLocalId(victim) || isLocalId(owner)) && currentState != config.stateMap.gated) {
				addTrauma(0.28);
			}
		}
		// Only a real scrum — several hits landing in quick succession — reads as
		// "a fight broke out." A single punch (or one multi-hit swing) shouldn't
		// trigger it, and once it fires the crowd stays quiet for a while so it
		// punctuates the brawl instead of reacting to every blow.
		var now = Date.now();
		recentPunchTimes.push(now);
		while (recentPunchTimes.length > 0 && now - recentPunchTimes[0] > 2000) {
			recentPunchTimes.shift();
		}
		if (recentPunchTimes.length >= 5 && now > nextFightReactionTime) {
			recentPunchTimes.length = 0;
			nextFightReactionTime = now + 6000;
			playAudience(pickCrowdOoh(), 1);
		}
		if (playerList[owner] == null) {
			playSoundVaried(meleeHitSound, 0.1);
			return;
		}
		if (playerList[owner].infected) {
			playSoundVaried(zombieHit, 0.1);
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
		if (typeof recapMarkMapDirty === "function") { recapMarkMapDirty(); } // map changed -> recap re-snapshots
	});
	server.on('explodedCells', function (cells) {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing || currentState == config.stateMap.lobby) {
			var center = cellsCentroid(cells);
			explodedCells(cells);
			if (center != null) {
				spawnExplosion(center.x, center.y, config.tileMap.abilities.bomb.explosionRadius);
				recapMarkEffect("explosion", center.x, center.y, { radius: config.tileMap.abilities.bomb.explosionRadius, color: "#ff7a18" });
			}
			if (typeof recapMarkMapDirty === "function") { recapMarkMapDirty(); } // exploded tiles -> recap re-snapshots
			playSoundVaried(bombExplosion, 0.05);
			addTrauma(0.5);
		}
	});
	server.on("snowFlakeExploded", function (payload) {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing || currentState == config.stateMap.lobby) {
			// payload carries the true detonation point { owner, x, y }; fall back
			// to the projectile's last position (older shape) if needed. Using the
			// sent point means the blast renders even if the flake was already
			// removed by a terminateProj/gameUpdates arriving first.
			var ex = (payload != null && payload.x != null) ? payload.x : null;
			var ey = (payload != null && payload.y != null) ? payload.y : null;
			if (ex == null) {
				var owner = (payload != null && payload.owner != null) ? payload.owner : payload;
				var flake = projectileList[owner];
				if (flake != null) { ex = flake.x; ey = flake.y; }
			}
			if (ex != null && ey != null) {
				spawnExplosion(ex, ey, config.tileMap.abilities.iceCannon.explosionRadius, "#9fe8ff");
				recapMarkEffect("explosion", ex, ey, { radius: config.tileMap.abilities.iceCannon.explosionRadius, color: "#9fe8ff" });
			}
			playSoundVaried(iceExplosion, 0.05);
			addTrauma(0.45);
		}
	});
	server.on("firstBlood", function () {
		playSound(firstBlood);
		playAudience(pickCrowdCheer(), 1);
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
				// Sink the kart into the lobby lava too. The server snapshots the
				// PRE-teleport position into packet.x/y, which is the authoritative
				// lava-cell position (the gameUpdates packet carrying the spawn
				// pad coords lands AFTER this event). Fall back to tx/ty only if
				// the server didn't send it. The synthetic player-like object keeps
				// the live playerList entry unmutated.
				if (typeof spawnSinkingCorpse === "function") {
					var dx = (packet.x != null) ? packet.x : ((p.tx != null) ? p.tx : p.x);
					var dy = (packet.y != null) ? packet.y : ((p.ty != null) ? p.ty : p.y);
					spawnSinkingCorpse({
						deathX: dx,
						deathY: dy,
						color: p.color,
						angle: p.angle,
						radius: p.radius
					});
				}
			}
		}
		playSound(packet.death ? playerDiedSound : playerFinished);
	});
}
function registerAbilityHandlers(server) {
	server.on("multiKill", function (count) {
		if (count == 2) {
			playSound(doubleKill);
			playAudience(pickCrowdCheer(), 1);
			recapMarkHighlight('double', []);
		}
		if (count == 3) {
			playSound(tripleKill);
			playAudience(pickCrowdBig(), 2);
			recapMarkHighlight('triple', []);
		}
		if (count > 3) {
			playSound(megaKill);
			playAudience(pickCrowdBig(), 2);
			recapMarkHighlight('mega', []);
		}
	});
	server.on("killingSpree", function (player) {
		playSound(killingSpree);
		playAudience(pickCrowdBig(), 2);
		recapMarkHighlight('spree', [player]);
	});
	server.on("rampage", function (player) {
		playSound(rampage);
		playAudience(pickCrowdBig(), 2);
		recapMarkHighlight('rampage', [player]);
	});
	server.on("godLike", function (player) {
		playSound(godLike);
		playAudience(pickCrowdBig(), 2);
		recapMarkHighlight('godlike', [player]);
	});
	// The crowd gasps when a racer skates the edge of the advancing lava and lives.
	server.on("audienceNearBurn", function () {
		playAudience(pickCrowdOoh(), 1);
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
		playSoundVaried(collectItem, 0.06);
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
		if (typeof recapMarkMapDirty === "function") { recapMarkMapDirty(); } // tile-swap -> recap re-snapshots
	});
	// The tiles a tileSwap is about to flip — clients pulse/flicker them for the
	// (random 3-6s) warn-up before the swap actually lands.
	server.on("tileSwapPending", function (payload) {
		$.when.apply($, promises).then(function () {
			var data = JSON.parse(payload);
			markPendingSwap(data.ids, data.duration);
		});
	});
	// Fires the instant the swap actually flips the tiles — drives the delayed
	// swap sound and clears the telegraph for exactly the tiles that flipped.
	server.on("tileSwapPerformed", function (payload) {
		$.when.apply($, promises).then(function () {
			var ids = JSON.parse(payload);
			tileSwapLanded(ids);
		});
	});

	server.on("projBounced", function () {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing || currentState == config.stateMap.lobby) {
			playSoundVaried(bombBounce, 0.1);
		}
	});
	server.on("blindfoldUsed", function (owner) {
		createBlindFold(owner);
		playerAbilityUsed(owner);
		playSound(blindSound);
	});
	server.on("botEmote", function (payload) {
		if (payload == null || playerList[payload.id] == null) {
			return;
		}
		// Reuse the chat-bubble render path (drawEmoji) for the bot's taunt.
		playerList[payload.id].chatMessage = payload.emote;
		playerList[payload.id].chatMessageAt = Date.now();
		playerList[payload.id].chatMessageDuration = 2500;
		setTimeout(function () {
			if (playerList[payload.id] != null && playerList[payload.id].chatMessage === payload.emote) {
				playerList[payload.id].chatMessage = null;
			}
		}, 2500);
	});
	server.on("cutUsed", function (owner) {
		playSoundVaried(cutSound, 0.08);
		var cutter = playerList[owner];
		if (cutter != null) {
			spawnSlashEffect(cutter.x, cutter.y, cutter.angle, cutter.color);
			// The cut shoves every other player (server game.cutPlayers pushes all
			// non-owner players perpendicular to the line), so stamp each victim with
			// the same hit-lines a punch leaves — coloured by the cutter, like
			// playerPunched — so the impact reads on the players who got flung too.
			var sparkColor = cutter.color || "white";
			for (var id in playerList) {
				var victim = playerList[id];
				if (id == owner || victim == null || victim.alive == false) {
					continue;
				}
				spawnHitEffect(victim.x, victim.y, sparkColor);
			}
		}
		playerAbilityUsed(owner);
		addTrauma(0.4);
	});
	server.on("tileSwap", function (owner) {
		// The swap is telegraphed then delayed (see tileSwapPending); the sound
		// now plays when the tiles actually flip (see tileSwapPerformed), not here.
		playerAbilityUsed(owner);
	});
	server.on("iceCannon", function (owner) {
		playerAbilityUsed(owner);
		playSound(iceCannon);
	});
}
function registerEffectHandlers(server) {
	server.on("lavaExplosion", function () {
		if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
			playSoundVaried(lavaExplosion, 0.05);
			spawnScreenFlash("#ff5a1a", 0.3, 300);
			addTrauma(0.5);
		}
	});
	server.on("spawnExplosionAimer", function (owner) {
		spawnExplosionAimer(owner);
		aimerList[owner].startExplosionCountDown = true;
		aimerList[owner].countdownStart = Date.now();
		aimerList[owner].countdownDuration = config.explosionWarnTime * 1000;

		for (var i = 1; i < config.explosionWarnTime + 1; i++) {
			addTimer(function (params) {
				if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
					playSound(teleportWarnSound);
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
		aimerList[owner].countdownStart = Date.now();
		aimerList[owner].countdownDuration = config.tileMap.abilities.swap.warnTime;

		for (var i = 1; i < (config.tileMap.abilities.swap.warnTime / 1000) + 1; i++) {
			addTimer(function (params) {
				if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
					playSound(teleportWarnSound);
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
	server.on("playerSwapped", function (payload) {
		// payload: { owner, points: [end A, end B] } — the two world positions the
		// swapped players occupy just after exchanging. Puffing at both ends puts
		// the effect where players actually appear/vanish; reading the owner's
		// live position instead would land on the pre-swap spot, since the new
		// coordinates only arrive in a later gameUpdates.
		var data = (typeof payload === "string") ? JSON.parse(payload) : payload;
		var owner = data != null ? data.owner : null;
		var swapColor = playerList[owner] != null ? playerList[owner].color : "white";
		var aimer = aimerList[owner];
		if (aimer != null && aimer.startSwapCountDown) {
			aimer.startSwapCountDown = false;
		}
		if (data != null && data.points != null) {
			for (var pi = 0; pi < data.points.length; pi++) {
				spawnTeleportPuff(data.points[pi].x, data.points[pi].y, swapColor);
			}
		} else if (playerList[owner] != null) {
			spawnTeleportPuff(playerList[owner].x, playerList[owner].y, swapColor);
		}
		playSound(teleportSound);
	});
	server.on("bombUsed", function (owner) {
		playerAbilityUsed(owner);
	});
	server.on("volcanoEruption", function () {
		playSound(volcanoErupt);
		spawnScreenFlash("#ff7a18", 0.28, 400);
		rumbleSustained(2500, 0.7);
	});

	server.on("speedBuff", function (owner) {
		playSound(speedBuff);
		if (playerList[owner] != null) {
			playerList[owner].speedBuffUntil = Date.now() + config.tileMap.abilities.speedBuff.duration;
		}
		playerAbilityUsed(owner);
	});

	server.on("speedDebuff", function (owner) {
		playSound(speedDebuff);
		// speedDebuff slows everyone EXCEPT the owner (see gameBoard.applySpeedDebuff),
		// so the "slowed" aura belongs on the other karts — not on the caster. Mirror the
		// server's target set (skip the owner, the dead, and zombies).
		var until = Date.now() + config.tileMap.abilities.speedDebuff.duration;
		for (var id in playerList) {
			if (id == owner) { continue; }
			if (playerList[id].alive === false || playerList[id].infected) { continue; }
			playerList[id].speedDebuffUntil = until;
		}
		playerAbilityUsed(owner);
	});
	server.on("triggerUsed", function (owner) {
		var p = playerList[owner];
		if (p != null) {
			spawnTriggerPulse(p.x, p.y, p.color);
		}
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
			if (typeof reEquipSavedCosmetics === "function") {
				reEquipSavedCosmetics(localPlayers[slot]);
			}
		}
	});
	sock.on('gameState', function (gs) {
		var lp = localPlayers[slot];
		if (lp) {
			lp.myID = gs.myID;
			lp.joined = true;
			lp.everJoined = true;
			// A pad seat that joins (or reconnects) mid-race lands as a temp spectator
			// who races from the next round — flag the slot so it gets the spectating
			// banner too (the primary keeps racing). Read the state from THIS gs
			// payload (compressor.gameState JSON-stringifies an array with state at
			// [0]) rather than the global currentState the primary maintains on its
			// own socket — separate sockets can deliver events in different orders,
			// so the global may have already advanced past the snapshot's state.
			var gsRoomState = null;
			if (config != null && gs != null && gs.game != null) {
				try { gsRoomState = JSON.parse(gs.game)[0]; } catch (e) { gsRoomState = null; }
			}
			lp.lateJoinSpectating = config != null && gsRoomState != null &&
				(gsRoomState == config.stateMap.racing || gsRoomState == config.stateMap.collapsing);
			// Re-equip this pad seat's saved cosmetics now it's actually in the room (the
			// `welcome` re-equip fired pre-enterGame and was dropped). setCosmetic is
			// lobby-only, so guard on this snapshot's room state.
			if (config != null && gsRoomState === config.stateMap.lobby && typeof reEquipSavedCosmetics === "function") {
				reEquipSavedCosmetics(lp);
			}
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
			// Co-op flag so a mid-game reconnect into a now-locked room is accepted
			// (spectator until the next round) rather than dropped.
			sock.emit('enterGame', gameID, true);
		}
	});
	// Lobby hub enter/exit edges arrive on THIS pad player's own socket, so they
	// route to this slot — that is what makes a panel per-slot in local co-op.
	sock.on('stationEnter', function (payload) {
		if (payload != null && typeof setSlotNearStation === "function") {
			setSlotNearStation(slot, payload.id);
		}
	});
	sock.on('stationExit', function (payload) {
		if (typeof clearSlotNearStation === "function") {
			clearSlotNearStation(slot, payload != null ? payload.id : null);
		}
	});
	// This pad player's skin request was rejected — flash its own picker.
	sock.on('skinRejected', function (payload) {
		if (typeof flagSkinRejected === "function") {
			flagSkinRejected(slot, payload != null ? payload.color : null);
		}
	});
	sock.on('cosmeticRejected', function (payload) {
		if (typeof flagCosmeticRejected === "function") {
			flagCosmeticRejected(slot, payload);
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
	// Local co-op IS supported in the editor's Preview/Playtest. The preview room is
	// created with co-op capacity (server hostess.createPreviewRoom → PREVIEW_COOP_CAP),
	// so a second+ local player joins by the same preview gameID exactly like a normal
	// couch player — the creator (P1) designs the map and friends press to join during
	// gated. The only preview-specific wrinkle is the exit: handlePrimaryLost and the
	// round-end handlers send the session back to the editor (create.html), not the menu.
	if (gameID == null) {
		return null; // primary hasn't confirmed a room yet
	}
	debugLog("[localmp] opening slot", slot, "pad", padIndex, "-> gameID", gameID);
	// Auth foundation: local players 2-4 connect as guests (no token). The browser
	// session has at most one signed-in account and it rides the primary socket.
	// TODO: per-seat sign-in is technically feasible (each socket could carry its
	// own token) — revisit if local-multiplayer accounts are wanted later.
	var sock = io({ forceNew: true, transports: SOCKET_TRANSPORT_OPTS.transports, tryAllTransports: SOCKET_TRANSPORT_OPTS.tryAllTransports });
	var lp = makeLocalPlayer(slot, sock, false);
	lp.padIndex = padIndex;
	localPlayers[slot] = lp;
	registerSecondaryHandlers(sock, slot);
	// `true` = local co-op join: allowed to land in an already-started (locked)
	// room mid-game as a spectator who races from the next round, instead of being
	// rejected (which booted couch players who pressed to join after the gate).
	sock.emit('enterGame', gameID, true);
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
	// Close this slot's hub panel + clear its proximity latch so a leaving player
	// can't strand an open panel / stale prompt for the slot.
	if (lp.stationPanel && typeof closeStationPanel === "function") {
		closeStationPanel(lp);
	}
	lp.nearStation = null;
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
		// No real player left. In a preview, return to the editor (immediately — this
		// is a deliberate leave); otherwise tear the tab down and go back to the menu.
		if (previewMode) {
			previewReturnToEditor(true);
			return;
		}
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
	// A preview play-test lives entirely in the creator's editor tab. If the designer
	// (P1) leaves or their socket drops, end the preview and go back to the editor
	// rather than promoting a friend to primary or bailing to the menu. Immediate:
	// this is a deliberate leave, so don't sit on a blank screen for the result beat.
	if (previewMode) {
		previewReturnToEditor(true);
		return;
	}
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
		// Drop the secondary lobby-hub listeners too, else registerPrimaryHandlers
		// (-> registerLobbyHubHandlers) double-binds them on the promoted socket.
		lp.socket.off('stationEnter');
		lp.socket.off('stationExit');
		lp.socket.off('skinRejected');
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

// In a preview session, the round ends when a player dies or reaches the goal
// (both surface as startOverview, plus startGameover on a win); after a short beat
// to see the result we navigate back to the editor with the map intact. An explicit
// LEAVE (`immediate`) skips that beat — the leave modal is already gone, so any delay
// just reads as "it didn't work" and invites a second button press that lands on the
// editor. The flag makes whichever trigger fires first win and dedupes the rest.
function previewReturnToEditor(immediate) {
	if (!previewMode || previewReturnScheduled) {
		return;
	}
	previewReturnScheduled = true;
	setTimeout(function () {
		window.location = './create.html';
	}, immediate ? 0 : 1500);
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

