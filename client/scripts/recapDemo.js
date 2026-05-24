// recapDemo.js — __dev PLAYTEST-ONLY recap harness. DO NOT SHIP TO PROD.
//
// Iterating on the end-game recap montage normally means playing a whole match
// to reach the gameOver screen. This harness skips that: it fabricates ~14s of
// synthetic "footage" (player motion + scripted highlights) at cranked time —
// generating the whole buffer instantly instead of one frame per server tick —
// then forces the client straight into the gameOver state so the recap renders.
//
// It reuses the LIVE lobby world + cached mapCanvas, so clips draw against the
// real map. It is inert unless explicitly triggered, and is intentionally NOT
// listed in build.js, so it is excluded from the production bundle (in prod the
// <script> tags inside the BUILD block are replaced by the single bundle tag).
//
// Trigger:  load play.html?recapDemo   (auto-runs once the lobby is ready)
//           or call recapDemo() from the devtools console.
//
// PRE-PR: delete this file + its <script> tag in play.html before any prod PR.

var recapDemoActive = false; // while true, ignore that the server has no game

function recapDemo() {
	if (typeof config === "undefined" || config == null || config.stateMap == null) {
		console.warn("[recapDemo] config not loaded yet — try again from the lobby");
		return;
	}
	if (typeof world === "undefined" || world == null || world.width == null) {
		console.warn("[recapDemo] no world yet — enter the lobby first, then run recapDemo()");
		return;
	}

	// Stop the authoritative server from overwriting our forced gameOver state.
	// The render loop (gameRunning) is independent of the socket, so detaching
	// listeners freezes the client on whatever state we set here.
	if (typeof server !== "undefined" && server && server.removeAllListeners) {
		server.removeAllListeners();
	}
	// Detaching listeners also drops the ping ('drip') response handler, so the
	// no-server-comm watchdog (checkForTimeout) would reload the page every
	// ~serverTimeoutWait seconds. Defang it so the forced gameOver stays put.
	if (typeof serverTimeoutWait !== "undefined") {
		serverTimeoutWait = Number.MAX_SAFE_INTEGER;
	}
	if (typeof timeSinceLastCom !== "undefined") {
		timeSinceLastCom = 0;
	}
	recapDemoActive = true;

	// --- synthetic players (live in playerList so colours/radius resolve) -----
	var palette = ["#e6194b", "#4363d8", "#3cb44b", "#f58231", "#911eb4"];
	var ids = [];
	playerList = {};
	for (var i = 0; i < palette.length; i++) {
		var id = "demo" + i;
		ids.push(id);
		// alive:false (and no deathMessage) so the live world-pass drawPlayers
		// no-ops for them — the recap clip uses its own per-frame alive flags.
		// recap/medals only read .color + .radius from here.
		playerList[id] = { id: id, color: palette[i], radius: 14, alive: false, x: 0, y: 0 };
	}

	// --- simulate motion at cranked time: build the whole buffer in one go -----
	recapReset();
	var now = Date.now();
	var step = 33; // ~one server tick
	var nFrames = Math.floor(RECAP_BUFFER_MS / step);
	var goal = { x: world.x + world.width * 0.82, y: world.y + world.height * 0.5 };
	var st = [];
	for (var p = 0; p < ids.length; p++) {
		st.push({
			x: world.x + world.width * (0.10 + 0.04 * p),
			y: world.y + world.height * (0.20 + 0.14 * p),
			alive: true
		});
	}
	for (var f = 0; f < nFrames; f++) {
		var t = now - RECAP_BUFFER_MS + f * step;
		var players = [];
		for (var q = 0; q < ids.length; q++) {
			var s = st[q];
			if (s.alive) {
				// ease toward the goal + a little per-player wander
				s.x += (goal.x - s.x) * 0.012 + Math.sin(f * 0.10 + q) * 5;
				s.y += (goal.y - s.y) * 0.012 + Math.cos(f * 0.13 + q * 1.7) * 5;
			}
			players.push([ids[q], s.x, s.y, s.alive]);
		}
		recapFrames.push({ t: t, players: players });

		// scripted highlight moments spread across the round
		if (f === Math.floor(nFrames * 0.30)) {
			st[4].alive = false;
			recapMarkHighlightAt(t, "death", [ids[4]]);
		}
		if (f === Math.floor(nFrames * 0.55)) {
			st[3].alive = false;
			recapMarkHighlightAt(t, "death", [ids[3]]);
			recapMarkHighlightAt(t, "double", []);
		}
		if (f === Math.floor(nFrames * 0.80)) {
			st[2].alive = false;
			recapMarkHighlightAt(t, "death", [ids[2]]);
		}
	}

	// --- achievements (mirror the server's startGameover packet shape) --------
	achievements = {
		mostKills: { ids: [ids[0]], title: "Most Kills", value: 3 },
		doubleKill: { ids: [ids[0]], title: "Double Kill", value: 1 },
		savior: { ids: [ids[1]], title: "Savior", value: 1 },
		survivalist: { ids: [ids[0]], title: "Survivalist", value: 1 }
	};

	playerWon = ids[0];
	decodedColorName = "Demo Champ";
	recapBuild(achievements);
	currentState = config.stateMap.gameOver;
	console.log("[recapDemo] forced gameOver with " + recapFrames.length +
		" synthetic frames; recap clips: " + (recapSequence ? recapSequence.length : 0));
}

// Push a marker at a specific timestamp (recapMarkHighlight stamps Date.now()).
function recapMarkHighlightAt(t, type, ids) {
	recapMarkers.push({ t: t, type: type, ids: ids || [] });
}

// Auto-run when ?recapDemo is in the URL, once the lobby world is ready.
(function () {
	try {
		if (typeof location === "undefined" || location.search.indexOf("recapDemo") < 0) {
			return;
		}
		var tries = 0;
		var iv = setInterval(function () {
			tries++;
			var ready = (typeof world !== "undefined" && world != null && world.width != null) &&
				(typeof config !== "undefined" && config != null && config.stateMap != null);
			if (ready) {
				clearInterval(iv);
				recapDemo();
			} else if (tries > 300) { // ~30s safety cap
				clearInterval(iv);
				console.warn("[recapDemo] gave up waiting for the lobby to load");
			}
		}, 100);
	} catch (e) { /* dev-only; never break the page */ }
})();
