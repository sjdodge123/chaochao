var utils = require('./utils.js');
var hostess = require('./hostess.js');
var botGuard = require('./botGuard.js');
var c = utils.loadConfig();
// Skin station: expose the curated named-color palette to the client (via the
// config payload that already ships to every client) so the skin picker's swatches
// and its "is this color taken?" preview match the server's validation set.
c.colorPalette = utils.getColorPalette();
// Achievement-cosmetic definitions (id/name/slot/stat/threshold + player-facing "how to
// earn it" text), shipped in the same config payload — the unlock celebrations and the
// profile panel render from this, so the ladder lives only in server/progression.js.
c.achievementDefs = require('./progression.js').clientAchievementDefs();
var compressor = require('./compressor.js');
var debug = require('./debug.js');
var mapFormat = require('./mapFormat.js');
var mapClassifier = require('./mapClassifier.js');
var ratings = require('./ratings.js');
var auth = require('./auth.js');
var progression = require('./progression.js');
var skinRegistry = require('./skinRegistry.js');
// Maps a cosmetic slot to the Player field that holds its equipped id (single-
// sourced from the server skin registry — see SLOT_FIELD there for the field
// naming rationale). Also the allow-list of valid slot names for setCosmetic.
// `border` is its OWN 4th slot (player.border / selected_border) — a pattern and a border can
// be equipped at once. Mirrors the client COSMETIC_SLOT_FIELD (skinRegistry.js).
var COSMETIC_SLOT_FIELD = skinRegistry.SLOT_FIELD;
var mailBoxList = {},
	identityList = {},
	roomMailList = {},
	io;

// ---- Rewarded "2× match XP" claim state ------------------------------------------------
// The rewarded-video reward (docs/ads-monetization-plan.md) tops up a signed-in player's
// match XP when they watch an ad on the results screen. To validate a claim WITHOUT a DB
// read per attempt — and without touching game.js — we stash each match's per-user earned
// XP the instant `startGameover` is emitted (at that point the playerList still holds this
// match's notches; resetForRace hasn't run). The stash lives on the Room object, is
// overwritten every match, and a matchId + TTL + single-claim flag guard against replay.
// A claim is only valid within this window of gameOver. The offer is a lobby-edge toast (a few
// seconds after gameOver) with a deliberate watch step. The CLIENT stops OFFERING well before
// this (REWARD_OFFER_WINDOW_MS in client.js) so an ad is never started without enough headroom
// to finish + claim inside this window; this server cap is the backstop + anti-replay bound.
var REWARD_CLAIM_TTL_MS = 180 * 1000;
var rewardedMatchSeq = 0;              // monotonic — makes each matchId unique per process

// Recompute one signed-in human's match XP the SAME way game.js awardProgression does
// (participation + per-notch + win + runner-up bonuses, all from config). Kept in lockstep
// with that breakdown; the headless ads test asserts this equals the engine's own award so
// the duplication can't silently drift.
function matchXpForPlayer(p, isWinner, isRunnerUp) {
	var total = c.xpParticipate;
	total += c.xpPerNotch * (p.notches || 0);
	if (isWinner) { total += c.xpWinBonus; }
	if (isRunnerUp) { total += c.xpRunnerUpBonus; }
	return total;
}

// Stash this match's per-user earned XP for later rewarded-bonus claims. Called from
// messageRoomBySig (the single startGameover emit path) so no game.js edit is needed. The
// matchId is NOT broadcast — it's delivered targeted, only to players the server actually
// credited (see emitRewardedEligibility), so a spectator who never raced is never offered an ad
// the server would then reject. Returns the payload unchanged.
function stampRewardedMatch(sig, payload) {
	var room = hostess.getRoomBySig(sig);
	if (!room || !room.game || !room.game.playerList || !payload) {
		return payload;
	}
	var pl = room.game.playerList;
	var winnerId = (payload.winner != null) ? String(payload.winner) : null;
	// Runner-up = highest-notch non-winner (mirrors awardProgression; first/secondPlaceSig are
	// null on the match-ending tick, so derive from the durable notch score instead).
	var runnerUpId = null, bestNotches = -1;
	for (var rid in pl) {
		if (rid === winnerId || pl[rid] == null) { continue; }
		var rn = pl[rid].notches || 0;
		if (rn > bestNotches) { bestNotches = rn; runnerUpId = rid; }
	}
	var matchId = 'm' + (++rewardedMatchSeq) + '-' + Date.now();
	var claims = {};
	for (var id in pl) {
		var p = pl[id];
		// Only signed-in humans who actually raced earn XP -> only they can claim a multiplier.
		if (p == null || p.isAI || !p.verifiedUserId || !p.racedCurrentMap) { continue; }
		var xpDelta = matchXpForPlayer(p, id === winnerId, id === runnerUpId);
		if (xpDelta > 0) {
			claims[p.verifiedUserId] = { xpDelta: xpDelta, claimed: false };
		}
	}
	// Keep per-match claim records keyed by matchId (not just the latest match): a rewarded ad
	// is allowed to finish during the NEXT race, and a long ad / suspended tab can complete after
	// that next match has ended — the still-in-TTL prior claim must remain claimable. Prune
	// records past the TTL on each stamp so the map can't grow. room.rewardedMatch points at the
	// latest record for convenience; the claim handler looks up by the claimed matchId.
	var now = Date.now();
	if (!room.rewardedMatches) { room.rewardedMatches = {}; }
	for (var oldId in room.rewardedMatches) {
		if (now - room.rewardedMatches[oldId].gameOverTs > REWARD_CLAIM_TTL_MS) { delete room.rewardedMatches[oldId]; }
	}
	var record = { matchId: matchId, gameOverTs: now, claims: claims };
	room.rewardedMatches[matchId] = record;
	room.rewardedMatch = record;   // latest (same object reference as the map entry)
	return payload;
}

// Tell ONLY the players the server actually credited that a rewarded 2× claim is available for
// this match (server-authoritative eligibility — racedCurrentMap + earned XP). Sent AFTER the
// broadcast startGameover (which the client uses to reset its rewarded state), so the targeted
// `rewardedEligible` lands last and isn't clobbered by that reset. Ineligible players (spectators,
// guests, bots) get nothing and so are never offered an ad the claim handler would reject.
function emitRewardedEligibility(sig) {
	var room = hostess.getRoomBySig(sig);
	if (!room || !room.rewardedMatch || !room.game || !room.game.playerList) { return; }
	var rm = room.rewardedMatch;
	var pl = room.game.playerList;
	// Send the REMAINING claim lifetime as a DURATION (not a server timestamp): the client adds
	// it to its OWN Date.now() to get a deadline, so the whole comparison stays on one clock and
	// a client/server clock skew can neither hide a valid offer nor launch an expired one.
	var ttlMs = REWARD_CLAIM_TTL_MS - (Date.now() - rm.gameOverTs);
	if (ttlMs < 0) { ttlMs = 0; }
	for (var id in pl) {
		var p = pl[id];
		if (p == null || !p.verifiedUserId || !rm.claims[p.verifiedUserId]) { continue; }
		var sock = mailBoxList[id];
		if (sock) { sock.emit('rewardedEligible', { matchId: rm.matchId, ttlMs: ttlMs }); }
	}
}

// Persist one cosmetic-slot equip for a signed-in player (best-effort, behind the
// global writes gate inside auth.saveCosmetic). Guests / writes-off are a no-op.
function persistCosmetic(userId, slot, id) {
	if (!userId) {
		return;
	}
	auth.saveCosmetic(userId, slot, id).catch(function (e) {
		console.log('[cosmetic] persist failed:', e && e.message);
	});
}

// Unlock kinds whose ownership is recorded PERMANENTLY in progression.unlocked_skins once
// earned: achievement medals and seasonal claims (and any future grant-based kind — gift/paid/
// event cosmetics). Both gate the same way: equippable iff the id is in unlocked_skins. Keeping
// this in one predicate (consulted by cosmeticUnlocked + the setCosmetic handler) means a new
// such kind only has to be added here, not in two switch arms that could drift apart.
function unlockIsOwnedKind(kind) {
	return kind === 'achievement' || kind === 'seasonal';
}

// Returns true if a player with the given progression row qualifies to equip `id`
// (exists, belongs to `slot`, and the level/achievement unlock is met). Shared by the
// restore path; the live setCosmetic handler inlines the same checks (it also emits
// per-reason rejections, which restore doesn't need).
function cosmeticUnlocked(prog, slot, id) {
	var skin = skinRegistry.getSkin(id);
	if (!skin || skin.slot !== slot) {
		return false;
	}
	if (skin.unlock.kind === 'open') {
		return true; // unlock-all-for-testing: always equippable (re-gate before ship)
	}
	if (skin.unlock.kind === 'level') {
		return (prog ? (prog.level || 1) : 1) >= skin.unlock.level;
	}
	if (unlockIsOwnedKind(skin.unlock.kind)) {
		var unlocked = (prog && Array.isArray(prog.unlocked_skins)) ? prog.unlocked_skins : [];
		return unlocked.indexOf(id) !== -1;
	}
	return false;
}

// Apply a signed-in player's persisted cosmetic slots (from their progression row) to the
// live Player, skipping any the player no longer qualifies for, and broadcast each so the
// room reflects the restored look. Called once the row loads.
function restorePersistedCosmetics(client, player, prog) {
	var room = hostess.getRoomBySig(roomMailList[client.id]);
	var slots = skinRegistry.SLOTS;
	for (var i = 0; i < slots.length; i++) {
		var slot = slots[i];
		var id = prog ? prog['selected_' + slot] : null;
		if (!id) {
			continue;
		}
		// Validate the persisted id by ITS OWN registry slot. Each slot now has its own column
		// (selected_cart/pattern/trail/border), so the nominal slot already matches; the
		// getSkinSlot() guard stays as defence against a stale id parked in the wrong column.
		var realSlot = skinRegistry.getSkinSlot(id);
		if (!realSlot || COSMETIC_SLOT_FIELD[realSlot] == null || !cosmeticUnlocked(prog, realSlot, id)) {
			continue;
		}
		player[COSMETIC_SLOT_FIELD[realSlot]] = id;
		if (room) {
			messageRoomBySig(room.sig, "playerCosmeticChanged", { id: client.id, slot: realSlot, value: id });
		}
	}
}

exports.build = function (mainIO) {
	io = mainIO;
}
// Broadcast an event to every connected socket (not room-scoped). Used for global
// state refreshes like the recomputed playlist summary.
exports.broadcastAll = function (header, payload) {
	if (io) { io.emit(header, payload); }
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
	// Rewarded-XP: stash this match's per-user earned XP as the results screen goes up, so a
	// later claimXpMultiplier can be validated without a DB read and without any game.js edit
	// (this is the single startGameover emit path). Then tell ONLY the credited players they're
	// eligible — AFTER the broadcast, so the client's startGameover reset can't clobber it.
	if (header === 'startGameover') {
		payload = stampRewardedMatch(sig, payload);
		messageRoomBySig(sig, header, payload);
		emitRewardedEligibility(sig);
		return;
	}
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
// Push a player's authoritative progression row to just that client (after a DB
// write or initial load). No-op if the client has since disconnected. Drives the
// lobby Lv/XP badge + skin-unlock UI; the server stays authoritative.
exports.sendProgressionToClient = function (sig, row) {
	var client = mailBoxList[sig];
	if (!client) {
		return;
	}
	var payload = buildProgressionPayload(row);
	if (payload) {
		client.emit('progressionUpdate', payload);
	}
}

// In-memory pending celebration toasts for the LOCAL-DEV (writes-off) path only,
// keyed by userId. With writes ON the durable queue lives in the DB's pending_toasts
// column (auth.addProgression / drainPendingToasts); this fallback just keeps the
// toast UI testable locally. Lost on server restart — fine for dev.
var pendingToastsMem = {};
exports.enqueueToastsInMemory = function (userId, events) {
	if (!userId || !events || !events.length) {
		return;
	}
	if (!pendingToastsMem[userId]) { pendingToastsMem[userId] = []; }
	pendingToastsMem[userId] = pendingToastsMem[userId].concat(events);
}
function drainToastsInMemory(userId) {
	var t = (userId && pendingToastsMem[userId]) ? pendingToastsMem[userId] : [];
	if (userId) { delete pendingToastsMem[userId]; }
	return t;
}
// Test-only: lets the headless progression test read what a match queued (the live
// drain happens inside loadPlayerProgression on lobby join, which the test doesn't
// drive). Not used by production code.
exports._drainToastsInMemoryForTest = drainToastsInMemory;

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
		// Send the classifier meta + playlist summary FIRST so the client has them
		// when it renders the map cards (socket preserves emit order).
		client.emit("editorMapMeta", { meta: utils.getEditorMapMeta(), playlists: utils.getPlaylistSummary() });
		client.emit("maplisting", utils.getEditorMapListings());
	});

	// Read-only: classify an in-editor map and return its balance so the editor can
	// show a soft "this looks unbalanced" nudge before submit. Does NOT touch the
	// submit/PR path; purely informational.
	//
	// Trust boundary: this is an unauthenticated socket and classification (plus
	// the overlay's balanceDebug) runs synchronous pathfinding on the shared event
	// loop, so cap + validate BEFORE any classifier work — the same hydrate +
	// validateMap pipeline submit/preview use (cell cap, finite coords, 1-2
	// opposite startEdges) — and throttle per socket. Every rejection replies
	// { error: true }, which the editor treats as "check unavailable, submit
	// normally", so the real submit path still surfaces the actual reason.
	var lastScoreMapAt = 0;
	client.on("scoreMap", function (package) {
		var now = Date.now();
		if (now - lastScoreMapAt < 2000) {
			client.emit("mapScore", { error: true });
			return;
		}
		lastScoreMapAt = now;
		// A real full-geometry editor map is ~600KB; 4MB is generous headroom that
		// still bounds JSON.parse work on garbage.
		if (typeof package !== "string" || package.length > 4 * 1024 * 1024) {
			client.emit("mapScore", { error: true });
			return;
		}
		try {
			var map = JSON.parse(package);
			map = mapFormat.hydrate(map); // enforces MAX_MAP_CELLS/bbox on sites-only payloads
			if (!utils.validateMap(map, c).valid) {
				client.emit("mapScore", { error: true });
				return;
			}
			var meta = mapClassifier.classify(map, c);
			var reply = {
				balanceScore: meta.balanceScore,
				tier: meta.tier,
				featuredScore: (c.balance && c.balance.featuredScore) || 85,
				deductions: meta.deductions,
				hardFail: meta.hardFail
			};
			// Attach the overlay geometry (per-edge median routes + goal centroid)
			// plus the numbers the editor's legend cites, so the author can see
			// WHERE the deductions come from. Featured maps carry it too — the
			// editor's on-demand "Test Fairness" check draws the routes either way.
			reply.debug = mapClassifier.balanceDebug(map, c);
			reply.parTime = Math.round(meta.parTime * 10) / 10;
			reply.idealParLow = (c.balance && c.balance.idealParLow != null) ? c.balance.idealParLow : 18;
			reply.idealParHigh = (c.balance && c.balance.idealParHigh != null) ? c.balance.idealParHigh : 40;
			client.emit("mapScore", reply);
		} catch (e) {
			client.emit("mapScore", { error: true });
		}
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
			// Credit the mapsSubmitted medal (writes-gated; atomic via addProgression's CAS).
			if (client.userId) {
				auth.addProgression(client.userId, { medalDeltas: { mapsSubmitted: 1 } })
					.then(function (row) { if (row) { exports.sendProgressionToClient(client.id, row); } })
					.catch(function (e) { console.log('[progression] mapsSubmitted bump failed:', e && e.message); });
			}
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
		// Optional pinned start gate for the author (editor "Start:" picker). Trust
		// boundary: only the four edge names pass; anything else means "auto".
		var startEdge = (isWrapper && ["left", "right", "top", "bottom"].indexOf(parsed.startEdge) !== -1)
			? parsed.startEdge : null;
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
		var sig = hostess.createPreviewRoom(previewMap, enableAI, startEdge);
		client.emit("previewRoomCreated", { gameID: sig });
	});

	client.on('enterGame', function (id, coop) {
		debug.log("enterGame: client=", client.id, " requestedId=", id, " coop=", coop);
		var roomSig = '';
		// botGuard: divert a flagged client (datacenter connection in tarpit mode, or one
		// that tripped the invisible honeypot) into the dead tarpit room — checked BEFORE
		// matchmaking so findARoom() never spins up and then abandons an empty real room on a
		// bot's behalf. This overrides matchmaking AND a direct ?gameid= join, so a flagged
		// bot can't pick its own way into a live room.
		if (botGuard.shouldTarpit(client.id)) {
			roomSig = hostess.getTarpitRoom();
		} else if (id == -1) {
			roomSig = hostess.findARoom(client.id);
		} else if (id == -2) {
			// "Start a new game" (play.html?new=1): always a fresh room, never
			// matchmade into an existing one.
			roomSig = hostess.startNewRoom();
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
		// Joined a match already underway? Flag it for the joinInProgress medal (consumed +
		// cleared at the next gameOver). racing/collapsing == a live match.
		if (room.game.currentState === c.stateMap.racing || room.game.currentState === c.stateMap.collapsing) {
			room.playerList[client.id].joinedInProgress = true;
		}
		// Stamp the verified Supabase user id so the map-time leaderboard knows
		// whose finish to record (null for guests). Bots never get a user id —
		// world.createNewBot sets isAI but leaves verifiedUserId undefined.
		room.playerList[client.id].verifiedUserId = client.userId || null;
		// Stable guest identity (localStorage deviceId from the handshake) so an
		// anonymous player still gets one effective map-rating vote (see rateMap).
		room.playerList[client.id].deviceId = client.deviceId || null;
		// Load this signed-in player's progression (XP/level/unlocked skins) for
		// skin-unlock gating + the lobby Lv/XP badge. Defaults immediately so gating
		// has something to check, then pushes the real row via progressionUpdate when
		// it loads. Guests get no progression. Reads work even with writes gated off.
		loadPlayerProgression(client, room.playerList[client.id]);
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
			lobbyAI: room.game.botOverride,
			// Room-wide playlist so a late joiner sees the real selection (not the
			// default Featured) and can't overwrite it by stepping the board.
			lobbyPlaylist: room.game.gameBoard.playlistId,
			// Room-wide game mode so a late joiner (any state) knows what kind of
			// game this room is playing.
			lobbyGameMode: room.game.gameBoard.gameModeId
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

	// The invisible honeypot decoy was tripped (a human never sees or clicks it). Flag the
	// client so its NEXT matchmake (enterGame) is diverted into the tarpit. We don't yank an
	// already-in-game socket mid-session — decoy trips happen at page load, well before
	// enterGame — which keeps this off the hot path and avoids a risky live room migration.
	client.on('honeypotTriggered', function () {
		botGuard.flag(client.id, 'honeypot');
		console.log('[botGuard] honeypot tripped by', client.id);
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
			// botGuard human-verify: once this client's kart has actually travelled far
			// enough under its own server-simulated input, emit a one-shot signal so the
			// client fires the verified_human GA event. A pageview-only bot that never opens
			// a socket (or sits frozen in the tarpit, which is never ticked) never moves and
			// so never verifies — making verified_human a trustworthy human KPI.
			if (botGuard.noteMovement(client.id, player)) {
				client.emit('verifiedHuman');
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

	// Equip one of the three independent cosmetic slots (cart / pattern / trail). Each
	// slot is set independently — equipping one NEVER clears another, and it's all
	// independent of color/avatar. Server-authoritative unlock gating: an id must exist
	// in the registry AND belong to the requested slot, and the player must meet its
	// level (level cosmetics) or own it (achievement cosmetics, tracked in
	// progression.unlocked_skins). Guests have no progression -> level 1, no achievement
	// unlocks. "" / null clears the slot back to its default. Persisted per-slot for
	// signed-in players (behind the writes gate). Rejections emit cosmeticRejected.
	client.on('setCosmetic', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		var player = room.playerList[client.id];
		if (player == null) {
			return;
		}
		player.wakeUp(); // picking a cosmetic is activity — don't AFK a browsing player
		var slot = payload && payload.slot;
		if (COSMETIC_SLOT_FIELD[slot] == null) {
			client.emit("cosmeticRejected", { slot: slot, reason: "slot" });
			return;
		}
		var field = COSMETIC_SLOT_FIELD[slot];
		var id = payload && payload.id;
		if (id === "" || id == null) {
			player[field] = null;
			persistCosmetic(client.userId, slot, null);
			messageRoomBySig(room.sig, "playerCosmeticChanged", { id: client.id, slot: slot, value: null });
			return;
		}
		var skin = skinRegistry.getSkin(id);
		if (!skin || skin.slot !== slot) {
			client.emit("cosmeticRejected", { slot: slot, id: id, reason: "unknown" });
			return;
		}
		var prog = player.progression || null;
		if (c.unlockAllCosmetics) {
			// Dev/testing seam (UNLOCK_ALL_COSMETICS): any registry id is equippable.
		} else if (skin.unlock.kind === "level") {
			var level = prog ? (prog.level || 1) : 1;
			if (level < skin.unlock.level) {
				client.emit("cosmeticRejected", { slot: slot, id: id, reason: "level", required: skin.unlock.level });
				return;
			}
		} else if (unlockIsOwnedKind(skin.unlock.kind)) {
			// Seasonal claims live in unlocked_skins once granted (auth.grantSeasonalClaims),
			// so ownership is permanent — equippable even after the claim window closes. A player
			// who never claimed during the window simply never has the id and is rejected here.
			// reason carries the kind ('achievement' | 'seasonal') so the client can word the lock.
			var unlocked = (prog && Array.isArray(prog.unlocked_skins)) ? prog.unlocked_skins : [];
			if (unlocked.indexOf(id) === -1) {
				client.emit("cosmeticRejected", { slot: slot, id: id, reason: skin.unlock.kind });
				return;
			}
		} else if (skin.unlock.kind === "open") {
			// unlock-all-for-testing: always equippable (operator re-gates before ship).
		} else {
			// Any other unlock kind (e.g. 'pool') is never equippable until promoted.
			client.emit("cosmeticRejected", { slot: slot, id: id, reason: "locked" });
			return;
		}
		player[field] = id;
		persistCosmetic(client.userId, slot, id);
		messageRoomBySig(room.sig, "playerCosmeticChanged", { id: client.id, slot: slot, value: id });
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

	// Room-wide game mode pick from the lobby hub mode station. Lobby-only (the
	// mode is locked once the gate goes up so a mid-game switch can't half-apply);
	// last-writer-wins; validated against the ACTIVE c.gameModes entries
	// (setGameMode does this) and only echoed when it actually changed.
	client.on('setLobbyGameMode', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		var id = payload && payload.id;
		if (typeof id !== "string") {
			return;
		}
		if (room.game.gameBoard.setGameMode(id)) {
			messageRoomBySig(room.sig, "lobbyGameModeChanged", { id: id });
		}
	});

	// Lobby hub keepalive: the client fires this on any active station-panel interaction
	// (open / navigate / tab / page / confirm / close — keyboard, touch, or pad). That is
	// the "pressing keys" signal that defers the lobby AFK kick, since browsing the menus
	// sends no movement packets. Proximity alone does NOT wake the player (see
	// Player.checkForSleep): a kart parked in a station zone without touching the panel
	// still idles out normally.
	client.on('lobbyActivity', function () {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined || room.game.currentState != c.stateMap.lobby) {
			return;
		}
		var player = room.playerList[client.id];
		if (player != null) {
			player.wakeUp();
		}
	});

	// Rewarded video: a signed-in player watched a "2× match XP" ad on the results screen.
	// Validate + credit a one-time bonus = original match XP * (multiplier-1), all computed
	// server-side (the multiplier is a server constant, NEVER trusted from the client). The
	// client onReward is only a signal — these guards (signed-in + matchId + TTL + single-claim)
	// are the anti-abuse. GameMonetize's HTML5 SDK exposes no rewarded-completion S2S postback,
	// so the gold-standard server postback is a documented follow-up (ads-monetization-plan.md).
	client.on('claimXpMultiplier', function (payload) {
		// 1. Signed-in only — guests have no progression to multiply. Silently ignore.
		if (!client.userId) { return; }
		var matchId = payload && payload.matchId;
		if (!matchId) { return; }
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (!room || !room.rewardedMatches) { return; }
		// 2. Look the claim up by its OWN matchId (records are kept per-match, not just the
		//    latest), so a rewarded ad that finished after the next match started can still pay.
		var rm = room.rewardedMatches[matchId];
		if (!rm) { return; }
		// 3. Within the TTL since gameOver (server-stamped).
		if (Date.now() - rm.gameOverTs > REWARD_CLAIM_TTL_MS) { return; }
		var entry = rm.claims[client.userId];
		if (!entry) { return; }          // earned no XP this match (didn't race / wasn't signed in then)
		// 4. Single-claim guard. Set BEFORE the async persist so a rapid double-emit can't double-credit.
		if (entry.claimed) { return; }
		entry.claimed = true;
		// 5/6. Bonus computed server-side from the stashed delta + the fixed multiplier.
		var bonus = progression.rewardedBonusXp(entry.xpDelta);
		if (bonus <= 0) { entry.claimed = false; return; }
		// 7. Persist (writes-gated inside addProgression). suppressXpToast: the client shows its
		//    own xpBonus toast, so drop the duplicate lobby "+N XP" (but keep any level-up/skin).
		auth.addProgression(client.userId, { xpDelta: bonus, suppressXpToast: true })
			.then(function (row) {
				var live = mailBoxList[client.id];
				if (row) {
					// SUCCESS. Refresh the SERVER-side cached progression too (not just the
					// browser) so a bonus that crosses a level threshold immediately gates
					// setCosmetic equips for the newly-unlocked level skins — otherwise the
					// server would keep rejecting them until the player rejoined.
					var liveRoom = hostess.getRoomBySig(roomMailList[client.id]);
					var rp = liveRoom && liveRoom.playerList ? liveRoom.playerList[client.id] : null;
					if (rp) {
						rp.progression = {
							xp: row.xp, level: row.level,
							unlocked_skins: row.unlocked_skins || [],
							medal_counts: row.medal_counts || {},
							wins: row.wins || 0
						};
						rp.progressionLoaded = true;
					}
					if (live) {
						var pp = buildProgressionPayload(row);
						if (pp) { live.emit('progressionUpdate', pp); }
						// 8. Ack so the client toasts the bonus + fires reward_claimed.
						live.emit('xpBonus', { matchId: matchId, bonus: bonus, multiplier: progression.XP_MULTIPLIER_REWARDED, xp: row.xp, level: row.level });
					}
				} else if (!auth.writesEnabled) {
					// Writes DELIBERATELY off (local dev / no Supabase): the bonus was computed but
					// not persisted. Ack anyway so the UX stays testable; xp/level are unknown.
					if (live) {
						live.emit('xpBonus', { matchId: matchId, bonus: bonus, multiplier: progression.XP_MULTIPLIER_REWARDED, xp: null, level: null });
					}
				} else {
					// Writes ENABLED but the persist FAILED (CAS exhausted / DB error -> null row).
					// Do NOT ack as success — that would consume a watched ad with no credit. Reset
					// the single-claim flag so the player can retry; the client's ack-timeout re-offers.
					entry.claimed = false;
					console.log('[rewarded] claim persist returned null with writes enabled — retry allowed');
				}
			})
			.catch(function (e) {
				// Persist threw — let the player retry (they watched the ad in good faith).
				entry.claimed = false;
				console.log('[rewarded] claim persist failed:', e && e.message);
			});
	});

	// Star-rate the map you just played. Allowed on the per-round OVERVIEW (rate it
	// while fresh) and the match-over screen. Server-authoritative: the rated map is
	// the room's current map (still the just-played map in both states — the next map
	// only loads at the gate), not a client-supplied id. One vote per voter per map
	// (UPSERT); bots and identity-less sockets can't vote; a short per-socket cooldown
	// stops spam. recordRating no-ops when no Supabase DB is configured.
	client.on('rateMap', function (payload) {
		var room = hostess.getRoomBySig(roomMailList[client.id]);
		if (room == undefined ||
			(room.game.currentState != c.stateMap.overview && room.game.currentState != c.stateMap.gameOver)) {
			return;
		}
		var board = room.game.gameBoard;
		if (board == null || board.currentMap == null || board.currentMap.id == null) {
			return;
		}
		// Never record ratings from an editor preview room: its map id is a throwaway
		// preview-* (or a committed id played on injected geometry), so a vote there
		// would poison the real aggregate. Mirrors the leaderboard's isPreview skip.
		if (board.isPreview) {
			return;
		}
		var stars = (payload && typeof payload.stars === "number") ? Math.floor(payload.stars) : 0;
		if (!ratings.validStars(stars)) {
			return;
		}
		var player = room.playerList[client.id];
		var voter = ratings.deriveVoter(player);
		if (voter == null) {
			return; // bot or identity-less socket — may not vote
		}
		// Must have actually raced the map being rated. racedCurrentMap is stamped at
		// startRace for everyone in the gate and is never set for a late-join spectator
		// (who joins after startRace during racing/collapsing, or during game-over), so
		// a drive-by joiner can't rate a map it never played.
		if (!player.racedCurrentMap) {
			return;
		}
		// Per-socket cooldown: at most one rate write per ~800ms (the upsert dedups
		// re-votes anyway; this just blunts a spam loop).
		var now = Date.now();
		if (player._lastRateAt && (now - player._lastRateAt) < 800) {
			return;
		}
		player._lastRateAt = now;
		var mapId = board.currentMap.id;
		ratings.recordRating(mapId, voter, stars, c).then(function (res) {
			client.emit("mapRated", { mapId: mapId, stars: stars, ok: !!(res && res.wrote) });
		});
	});


}
// Shape a stored/normalized progression row into the client payload: raw totals
// plus the precomputed level-bar values (so the client never re-derives the XP
// curve — the server stays the single source of truth).
function buildProgressionPayload(row) {
	if (!row) {
		return null;
	}
	var prog = progression.levelProgress(row.xp || 0);
	// The next level-ladder cosmetic this player is working toward, with the exact XP
	// gap — drives the client's "next unlock: X, ~N matches away" teaser. null when the
	// ladder is exhausted (Lv100).
	var next = skinRegistry.nextLevelSkin(prog.level);
	var nextUnlock = null;
	if (next) {
		nextUnlock = {
			id: next.id,
			level: next.level,
			xpToGo: Math.max(0, progression.cumulativeXpForLevel(next.level) - (row.xp || 0))
		};
	}
	return {
		xp: row.xp || 0,
		// ALWAYS the level derived from xp (levelProgress above) — never row.level. The
		// stored column is a write-time cache that goes stale across curve retunes, and
		// a `row.level ||` fallback here would silently re-introduce the badge-vs-bar
		// payload inconsistency normalizeProgression exists to prevent.
		level: prog.level,
		unlocked_skins: row.unlocked_skins || [],
		medal_counts: row.medal_counts || {},
		wins: row.wins || 0,
		xpThisLevel: prog.xpThisLevel,
		xpForNextLevel: prog.xpForNextLevel,
		nextUnlock: nextUnlock
	};
}
// Attach a signed-in player's progression to the player object (for server-side
// equip gating) and emit it to the client (for the lobby UI). Guests are skipped.
function loadPlayerProgression(client, player) {
	if (!client.userId) {
		return;
	}
	player.progression = progression.defaultProgression();
	player.progressionLoaded = false;
	// Grant any OPEN seasonal claim (Early Adopter etc.) BEFORE the read, so the row we load
	// already reflects the new unlock and the queued claim toast is in pending_toasts for the
	// drain at the end of the chain. No-op for guests / writes-off / outside any window; never
	// blocks the load (a grant failure still falls through to getProgression).
	Promise.resolve(auth.grantSeasonalClaims(client.userId)).catch(function () { return null; }).then(function () {
		return auth.getProgression(client.userId);
	}).then(function (row) {
		var prog = row || progression.defaultProgression();
		player.progression = prog;
		player.progressionLoaded = true;
		// Restore each persisted cosmetic slot the player still qualifies for. The
		// client also re-equips from localStorage (instant, idempotent); this is the
		// cross-device source of truth. Broadcast so the room sees the spawn-time look.
		restorePersistedCosmetics(client, player, prog);
		if (mailBoxList[client.id]) {
			var payload = buildProgressionPayload(prog);
			if (payload) {
				mailBoxList[client.id].emit('progressionUpdate', payload);
			}
		}
	}).catch(function (e) {
		// Leave the default row in place; mark loaded so gameOver doesn't keep
		// treating it as still-loading.
		player.progressionLoaded = true;
		console.log('[progression] load failed:', e && e.message);
	}).then(function () {
		// Drain + deliver pending celebration toasts — chained AFTER the grant resolves so a
		// just-granted seasonal claim toast is already in pending_toasts (a synchronous drain
		// here would race the grant's write and miss it). Only when actually arriving in the
		// lobby: joining a racing/collapsing room mid-match must not overlay rewards during play;
		// the next startLobby's deliverRoomToasts delivers them at the right moment.
		var toastRoom = hostess.getRoomBySig(roomMailList[client.id]);
		if (toastRoom && toastRoom.game && toastRoom.game.currentState === c.stateMap.lobby) {
			deliverPendingToasts(client);
		}
	});
}
// Collect a signed-in client's pending toasts (durable DB queue + dev in-memory
// queue) and emit them as one ordered `progressionToasts` batch. The client
// sequences them. Cleared as they're read so they show once.
function deliverPendingToasts(client) {
	if (client && client.userId) {
		deliverToastsTo(client.userId, client.id);
	}
}
// In-flight DB-drain guard, keyed by userId. A joining player and the very next
// waiting->lobby transition can both call deliverToastsTo for the same user; since the
// DB drain is a non-atomic read-then-clear, two concurrent drains could read the same
// queue and emit the rewards twice. The first drain holds the lock; a concurrent second
// caller skips the DB drain (delivering only its sync in-memory toasts, which are already
// cleared on first read so they can't duplicate either).
var toastDrainInFlight = {};
// Core drain+emit, keyed by (userId, clientId) so it serves both the enterGame path
// (a re-joining socket) and the same-room lobby-return path (existing sockets that
// never re-enter). Drains the DB queue (writes-on) + the in-memory queue (dev).
// Resolve a user's CURRENTLY-connected socket id — the clientId captured when a drain began
// can go stale across a disconnect/reconnect. null if the user has no live socket.
function liveClientIdForUser(userId) {
	for (var cid in identityList) {
		if (identityList[cid] && identityList[cid].userId === userId && mailBoxList[cid]) {
			return cid;
		}
	}
	return null;
}
function deliverToastsTo(userId, clientId) {
	if (!userId) {
		return;
	}
	var memToasts = drainToastsInMemory(userId);
	if (toastDrainInFlight[userId]) {
		// A DB drain is already running for this user — don't read the queue again.
		if (memToasts.length) {
			var t0 = mailBoxList[clientId] ? clientId : liveClientIdForUser(userId);
			if (t0 && mailBoxList[t0]) { mailBoxList[t0].emit('progressionToasts', { events: memToasts }); }
			else { exports.enqueueToastsInMemory(userId, memToasts); } // no live socket -> keep for next join
		}
		return;
	}
	toastDrainInFlight[userId] = true;
	auth.drainPendingToasts(userId).then(function (dbToasts) {
		delete toastDrainInFlight[userId];
		var all = (dbToasts || []).concat(memToasts);
		if (!all.length) { return; }
		var target = mailBoxList[clientId] ? clientId : liveClientIdForUser(userId);
		if (target && mailBoxList[target]) {
			mailBoxList[target].emit('progressionToasts', { events: all });
		} else {
			// Socket vanished between the drain's read and here — re-queue so the rewards aren't
			// lost; they deliver on the user's next join. Split back to their original queues
			// (mem -> memory, DB -> durable re-append) so nothing duplicates.
			exports.enqueueToastsInMemory(userId, memToasts);
			auth.requeuePendingToasts(userId, dbToasts || []);
		}
	}).catch(function (e) {
		delete toastDrainInFlight[userId];
		// DB drain failed (queue NOT cleared) — deliver in-memory ones, or keep them for next join.
		if (memToasts.length) {
			var t2 = mailBoxList[clientId] ? clientId : liveClientIdForUser(userId);
			if (t2 && mailBoxList[t2]) { mailBoxList[t2].emit('progressionToasts', { events: memToasts }); }
			else { exports.enqueueToastsInMemory(userId, memToasts); }
		}
		console.log('[progression] toast drain failed:', e && e.message);
	});
}
// Deliver pending celebration toasts to every signed-in player in a room. Called on
// the match->lobby transition (Game.startLobby) so players who STAY in the same room
// — and thus never re-enter via enterGame — still get their lobby-arrival toasts.
// playerList is keyed by client id (== sig); verifiedUserId is the Supabase user id.
exports.deliverRoomToasts = function (playerList) {
	if (!playerList) {
		return;
	}
	for (var id in playerList) {
		var p = playerList[id];
		if (p && !p.isAI && p.verifiedUserId && mailBoxList[id]) {
			deliverToastsTo(p.verifiedUserId, id);
		}
	}
}
function messageRoomBySig(sig, header, payload) {
	io.to(String(sig)).emit(header, payload);
}
function messageClientBySig(sig, header, payload) {
	mailBoxList[sig].emit(header, payload);
}