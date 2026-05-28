
var mousex,
	mousey,
	lobbyStartButton,
	gate,
	gates = [],
	world,
	mapID,
	gameID,
	currentMap,
	punchList,
	aimerList,
	hazardList,
	infection = false,
	projectileList,
	playerList,
	blindfold,
	achievements = null,
	blackout = false,
	timerList = [],
	playersNearVictory = [],
	pingCircles = [],
	collapseShockwaves = [],
	effectsList = [],
	shakeTrauma = 0,
	pendingSwapCells = null,
	blackoutStart = null,
	brutalRound = false,
	brutalRoundConfig = null,
	clientList;

// DEBUG: force my player's trail to render in near-victory (dashed) style. Set to false for real play.
var DEBUG_FORCE_NEAR_VICTORY = false;
// DEBUG: force my player to be on fire for testing flame animation. Set to false for real play.
var DEBUG_FORCE_FIRE = false;

resetGameboard();

function resetGameboard() {
	playerList = {};
	clientList = {};
	punchList = {};
	blindfold = {};
	currentMap = {};
	aimerList = {};
	hazardList = {};
	round = 0;
	brutalRound = false;
	brutalRoundConfig = null;
	projectileList = {};
	gameID = null;
	effectsList = [];
	shakeTrauma = 0;
	shakeSustainUntil = 0;
	shakeSustainFloor = 0;
	pendingSwapCells = null;
	if (typeof discardTrenchDecal === "function") { discardTrenchDecal(); }
}

function resetRound() {
	blackout = false;
	blackoutStart = null;
	infection = false;
	// Transient visuals shouldn't bleed into the next round.
	effectsList = [];
	shakeTrauma = 0;
	shakeSustainUntil = 0;
	shakeSustainFloor = 0;
	pendingSwapCells = null;
	blindfold = {};
	// The sand trench is a per-round ground decal; wipe it so the next round starts
	// on clean sand (the trench "lasts the duration of the race", not beyond it).
	if (typeof discardTrenchDecal === "function") { discardTrenchDecal(); }
	// Buff auras, movement-particle cooldowns and the last-velocity sample all
	// live on the persistent playerList objects, so they have to be cleared by
	// hand or they bleed into the next round (stale wind streaks, a phantom skid
	// burst on the first frame, etc.).
	for (var pid in playerList) {
		var rp = playerList[pid];
		rp.speedBuffUntil = null;
		rp.speedDebuffUntil = null;
		rp.prevVelX = null;
		rp.prevVelY = null;
		rp.dustCD = 0;
		rp.skidCD = 0;
		rp.emberCD = 0;
		// Map-leaderboard transient state: clear per-round so last round's
		// goal-cross doesn't latch the HUD timer on the new race's first tick.
		rp.reachedGoal = false;
		rp.finishMs = null;
		rp.trenchX = null;
		rp.trenchY = null;
	}
	for (var aimerID in this.aimerList) {
		delete this.aimerList[aimerID];
	}
}

function updateGameboard(dt) {
	if (currentState == config.stateMap.racing || currentState == config.stateMap.overview || currentState == config.stateMap.collapsing) {
		updateTrails();
	}
	updatePingCircles(dt);
	updateCollapseShockwaves(dt);
	updateEffects(dt);
	updateShake(dt);
	// Tile-based movement particles also run in the lobby — players drive around
	// on a real terrain map there, so the dust/grass/sand/ice flecks give the same
	// movement feedback as a race (was previously gated to racing/collapsing only).
	if (currentState == config.stateMap.racing || currentState == config.stateMap.collapsing ||
		currentState == config.stateMap.lobby) {
		updateMovementParticles(dt);
	}
	checkTimers(dt);
}

function updatePingCircles(dt) {
	if (pingCircles.length == 0) return;
	// The goal ping is a gated-phase telegraph. drawPingCircles renders during
	// racing/collapsing too, but pings were only advanced/cleared while gated — so
	// any still alive when the race started froze on screen. Clear them on leaving
	// the gate so they don't linger into the race.
	if (currentState != config.stateMap.gated) { pingCircles.length = 0; return; }
	var wrapped = false;
	for (var i = pingCircles.length - 1; i >= 0; i--) {
		var ping = pingCircles[i];
		if (ping.pass >= 2) {
			pingCircles.splice(i, 1);
			continue;
		}
		ping.radius += 200 * dt / 1000;
		if (ping.radius > 500) {
			ping.radius = 0;
			ping.pass++;
			wrapped = true;
		}
	}
	if (wrapped) {
		playSound(countDownA);
	}
}
// Telegraph for an incoming collapse: a shockwave ring centered on the goal the
// collapse converges on, starting at the outer front (where the lava appears
// first) and contracting inward toward the goal, matching how the lava sweeps.
// Used by the solo collapse and the volcano brutal round (both route through
// the server startCollapse).
function spawnCollapseShockwave(x, y) {
	collapseShockwaves.push({ x: x, y: y, radius: 0, maxRadius: 650, pass: 0 });
	if (typeof recapMarkEffect === "function") {
		recapMarkEffect("shockwave", x, y, {});
	}
}
function updateCollapseShockwaves(dt) {
	if (collapseShockwaves.length == 0) { return; }
	if (currentState != config.stateMap.collapsing) { collapseShockwaves.length = 0; return; }
	for (var i = collapseShockwaves.length - 1; i >= 0; i--) {
		var s = collapseShockwaves[i];
		if (s.pass >= 3) { collapseShockwaves.splice(i, 1); continue; }
		s.radius += 600 * dt / 1000;
		if (s.radius >= s.maxRadius) { s.radius = 0; s.pass++; }
	}
}
function resetTrails() {
	for (var id in playerList) {
		var player = playerList[id];
		player.trail.reset(player);
	}
}

// Trail vertices are sampled at ~30Hz regardless of render rate. Motion smoothing
// (smoothEntities) now nudges x/y every frame, so without this gate the trail
// would record at 60fps — doubling the stroke/memory work on desktop and halving
// the kept-tail duration of the direct-trail cap on Low. 30Hz matches the server
// tick (the cadence the trail recorded at before smoothing existed).
var TRAIL_SAMPLE_MS = 33;
var lastTrailSampleAt = 0;
function updateTrails() {
	var now = Date.now();
	if (now - lastTrailSampleAt < TRAIL_SAMPLE_MS) {
		return;
	}
	lastTrailSampleAt = now;
	for (var id in playerList) {
		var player = playerList[id];
		if (player.alive == false || player.infected == true) {
			continue;
		}
		player.trail.update({ x: player.x, y: player.y }, player);
	}
}

function checkTimers(dt) {
	for (var i = 0; i < timerList.length; i++) {
		var timer = timerList[i];
		if (timer.elasped == true) {
			continue;
		}
		timer.timeLeft -= dt;
		if (timer.timeLeft <= 0) {
			timer.elasped = true;
			timer.callback(timer.params);
		}
	}
}

function addTimer(callback, timeout, params) {
	var timer = {};
	timer.callback = callback;
	timer.elasped = false;
	timer.timeLeft = timeout;
	timer.params = params;
	return timerList.push(timer);
}


function connectSpawnPlayers(packet) {
	if (packet == null) {
		return;
	}
	packet = JSON.parse(packet);
	for (var i = 0; i < packet.length; i++) {
		var player = packet[i];
		if (playerList[player[0]] == null) {
			createPlayer(player);
		}
	}

}

function createPlayer(dataArray) {
	var index = dataArray[0];
	playerList[index] = {};
	playerList[index].radius = config.playerBaseRadius;
	playerList[index].id = dataArray[0];
	playerList[index].x = dataArray[1];
	playerList[index].y = dataArray[2];
	playerList[index].tx = dataArray[1];   // seed render-smoothing target (see smoothEntities)
	playerList[index].ty = dataArray[2];
	playerList[index].color = dataArray[3];
	playerList[index].alive = dataArray[4];
	playerList[index].notches = dataArray[5];
	playerList[index].nearVictory = dataArray[6];
	playerList[index].chatMessage = null;
	playerList[index].awake = dataArray[7];
	playerList[index].onFire = dataArray[8];
	playerList[index].ability = null;
	playerList[index].angle = dataArray[9];
	playerList[index].name = dataArray[10] || null;   // AI racer identity (humans: null)
	playerList[index].title = dataArray[11] || null;
	playerList[index].avatarUrl = dataArray[12] || null;   // opt-in avatar skin (else null = colour skin)
	playerList[index].deathMessage = null;
	playerList[index].trail = new Trail({ x: dataArray[1], y: dataArray[2] });
	playerList[index].fizzle = function () {
		if (aimerList[index] != null && aimerList[index].startSwapCountDown) {
			aimerList[index].startSwapCountDown = false;
			playSound(abilityFizzle);
		}
	};
}

// --- Client-side motion smoothing -------------------------------------------
// The server ticks positions at 30Hz (serverTickSpeed 33.33ms); without this,
// entities snap to those 30Hz positions and visibly STEP at 60fps render (the
// "bumper jumping frames", and choppy motion overall — most obvious on a crisp/
// high-refresh display). Each frame we ease the RENDER position (x/y) toward the
// latest server target (tx/ty): the local kart eases fast (snappy controls),
// remote karts and hazards ease slower (smooth). A jump larger than
// SMOOTH_SNAP_DIST (respawn, swap-teleport, inactive park at -100,-100) snaps
// instantly instead of sliding across the map. Easing (not velocity
// extrapolation) is deliberate: the sim is server-authoritative and
// collision-heavy, so extrapolating would overshoot into walls/bumpers and
// rubber-band. Always on — a universal smoothness win, independent of the perf
// profile. A kart travels <=~27px per 30Hz tick (playerMaxSpeed), so 120px
// cleanly separates real motion from a teleport.
var SMOOTH_TAU_LOCAL = 22;    // ms — local kart catches up in ~2-3 frames
var SMOOTH_TAU_REMOTE = 60;   // ms — remote karts / hazards glide over ~5 frames
var SMOOTH_SNAP_DIST = 120;   // px — beyond this is a teleport, not motion → snap
function smoothPos(o, tau, dt) {
	if (o == null || o.tx == null) {
		return;
	}
	if (o.x == null || o.y == null) {   // first sight: snap onto the target
		o.x = o.tx; o.y = o.ty;
		return;
	}
	var dx = o.tx - o.x, dy = o.ty - o.y;
	if (dx * dx + dy * dy > SMOOTH_SNAP_DIST * SMOOTH_SNAP_DIST) {
		o.x = o.tx; o.y = o.ty;          // teleport/respawn/park → snap, don't slide
		return;
	}
	var a = 1 - Math.exp(-dt / tau);     // dt>>tau (tab refocus) → a→1 → full snap, no overshoot
	o.x += dx * a;
	o.y += dy * a;
}
// Ease every moving entity toward its latest server target. Called once per
// render frame, BEFORE drawing (and before the camera reads the local kart).
function smoothEntities(dt) {
	if (!(dt > 0)) {
		return;
	}
	var id;
	for (id in playerList) {
		var p = playerList[id];
		if (p == null) {
			continue;
		}
		smoothPos(p, isLocalId(id) ? SMOOTH_TAU_LOCAL : SMOOTH_TAU_REMOTE, dt);
	}
	if (typeof hazardList !== "undefined" && hazardList) {
		for (id in hazardList) {
			smoothPos(hazardList[id], SMOOTH_TAU_REMOTE, dt);
		}
	}
}

function updatePlayerList(packet) {
	if (packet == null) {
		return;
	}
	for (var i = 0; i < packet.length; i++) {
		var player = packet[i];
		if (playerList[player[0]] != null) {
			playerList[player[0]].id = player[0];
			// Server position is the SMOOTHING TARGET (tx/ty); smoothEntities eases
			// the render position (x/y) toward it each frame so 30Hz ticks don't
			// render as visible stepping. (See smoothEntities.)
			playerList[player[0]].tx = player[1];
			playerList[player[0]].ty = player[2];
			playerList[player[0]].velX = player[3];
			playerList[player[0]].velY = player[4];
			playerList[player[0]].angle = player[5];
			playerList[player[0]].stamina = player[6];
			playerList[player[0]].charge = (player[7] != null) ? player[7] / 100 : 0;
			playerList[player[0]].overcharge = (player[8] != null) ? player[8] / 100 : 0;
			// Mirror the server's exhaustion hysteresis off the authoritative stamina
			// value (the server's staminaExhausted flag isn't sent): once stamina drops
			// below the punch cost you're "tired" and can't punch until it climbs back to
			// exhaustRecover. Drives the charge glow so it never says "ready" while the
			// server is still refusing the punch.
			if (config.punchStamina != null && player[6] != null) {
				if (player[6] < config.punchStamina.punchCost) {
					playerList[player[0]]._tired = true;
				} else if (player[6] >= config.punchStamina.exhaustRecover) {
					playerList[player[0]]._tired = false;
				}
			}
		}
	}
}
function updateProjecileList(packet) {
	if (packet == null) {
		return;
	}
	for (var i = 0; i < packet.length; i++) {
		var proj = packet[i];
		if (projectileList[proj[0]] != null) {
			projectileList[proj[0]].ownerId = proj[0];
			projectileList[proj[0]].type = proj[1];
			projectileList[proj[0]].x = proj[2];
			projectileList[proj[0]].y = proj[3];
		}
	}
}

function updateAimerList(packet) {
	if (packet == null) {
		return;
	}
	for (var i = 0; i < packet.length; i++) {
		var aimer = packet[i];
		if (aimerList[aimer[0]] != null) {
			aimerList[aimer[0]].ownerId = aimer[0];
			aimerList[aimer[0]].targetList = aimer[1];
			aimerList[aimer[0]].radius = aimer[2];
			aimerList[aimer[0]].x = aimer[3];
			aimerList[aimer[0]].y = aimer[4];
		}
	}
}

function updateHazardList(packet) {
	if (packet == null) {
		return;
	}
	for (var i = 0; i < packet.length; i++) {
		var hazard = packet[i];
		if (hazardList[hazard[0]] != null) {
			// Smoothing target (eased toward in smoothEntities) — stops moving
			// bumpers from stepping at the 30Hz tick rate.
			hazardList[hazard[0]].tx = hazard[1];
			hazardList[hazard[0]].ty = hazard[2];
		}
	}
}


function updatePlayerNotches(packet) {
	if (packet == null) {
		return;
	}
	packet = JSON.parse(packet);
	for (var i = 0; i < packet.length; i++) {
		var player = packet[i];
		if (playerList[player[0]] != null) {
			oldNotches[player[0]] = playerList[player[0]].notches;
			playerList[player[0]].notches = player[1];
		}
	}

}
function worldResize(payload) {
	payload = JSON.parse(payload);
	world = {};
	world.x = payload[0];
	world.y = payload[1];
	world.width = payload[2];
	world.height = payload[3];
}
function appendNewPlayer(packet) {
	if (packet == null) {
		return;
	}
	packet = JSON.parse(packet);
	var player = packet;
	if (playerList[player[0]] == null) {
		createPlayer(player);
	}
}

function checkGameState(payload) {
	if (payload == null) {
		return;
	}
	payload = JSON.parse(payload);
	currentState = payload[0];
	if (currentState == config.stateMap.waiting) {
		lobbyStartButton = null;
	}
	if (currentState == config.stateMap.lobby) {
		if (lobbyStartButton == null) {
			lobbyStartButton = {};
			lobbyStartButton.x = payload[1];
			lobbyStartButton.y = payload[2];
			lobbyStartButton.radius = payload[3];
			lobbyStartButton.color = payload[4];
			lobbyStartButton.angle = 0;
			lobbyStartButton.maxVelocity = 60;
			lobbyStartButton.velocity = 0;
			lobbyStartButton.startSpin = false;
		}
	}
	if (currentState == config.stateMap.gated || currentState == config.stateMap.racing || currentState == config.stateMap.collapsing) {
		lobbyStartButton = null;
		// payload[1] is an array of gates [x, y, width, height, edge] (one for a
		// single-edge map, two for an opposite-edge combo) — mirrors
		// compressor.gameState. `gate` keeps pointing at gate 0 for any reader that
		// still wants "the gate".
		gates = [];
		var gateData = payload[1] || [];
		for (var gi = 0; gi < gateData.length; gi++) {
			var gd = gateData[gi];
			gates.push({ x: gd[0], y: gd[1], width: gd[2], height: gd[3], edge: gd[4] });
		}
		gate = gates.length > 0 ? gates[0] : null;
	}
	// Force-close any lobby hub panel + drop the zones once we leave the lobby
	// (startGated etc.), so a panel open at match start can't survive into the race.
	if (currentState != config.stateMap.lobby && typeof lobbyHubReset === "function" &&
		typeof lobbyStations !== "undefined" && lobbyStations.length > 0) {
		lobbyHubReset();
	}

}

function loadNewMap(id) {
	currentMap = {};
	pingCircles = [];
	invalidateMapCache();
	for (var i = 0; i < maps.length; i++) {
		if (id == maps[i].id) {
			currentMap = JSON.parse(JSON.stringify(maps[i]));
			break;
		}
	}
	if (currentMap.cells == null) {
		// id wasn't in maps[] (e.g. an unsynced preview map); bail rather than
		// dereferencing undefined cells below.
		return;
	}
	if (currentState == config.stateMap.gated) {
		var goalFound = false;
		for (var j = 0; j < currentMap.cells.length; j++) {
			if (currentMap.cells[j].id == config.tileMap.goal.id) {
				goalFound = true;
				pingCircles.push({ x: currentMap.cells[j].site.x, y: currentMap.cells[j].site.y, radius: 0, pass: 0 });
			}
		}
		if (goalFound) {
			playSound(countDownA);
		}
	}
}
function loadMapPreview(id) {
	for (var i = 0; i < maps.length; i++) {
		if (id == maps[i].id) {
			nextMapPreview = JSON.parse(JSON.stringify(maps[i]));
			break;
		}
	}
	// Maps no longer ship a thumbnail; render one on demand from the (already
	// reconstructed) geometry into an offscreen canvas, which drawImage accepts
	// just like an Image.
	nextMapThumbnail = (nextMapPreview != null) ? buildMapThumbnailCanvas(nextMapPreview) : null;
}
// Textured render of a map for the next-map preview window, using the SAME tile
// patterns the live map renders with (renderMapToCache) so the preview matches
// the in-game look. Falls back to the tile's flat config colour for any id without
// a pattern. Rendered at world resolution; drawImage downscales it to the preview
// box. Patterns are loaded long before any next-map preview appears mid-game.
function thumbnailTileFill(id) {
	// Prefer the textured pattern; fall back to the shared locateColor (draw.js)
	// which already handles ability ids (>99) and the null case.
	if (typeof patterns !== 'undefined' && patterns[id] != null) { return patterns[id]; }
	return locateColor(id) || '#888';
}
function buildMapThumbnailCanvas(map) {
	var cv = document.createElement('canvas');
	if (map == null || !Array.isArray(map.cells)) { return cv; }
	cv.width = world.width;
	cv.height = world.height;
	var ctx = cv.getContext('2d');
	ctx.fillStyle = thumbnailTileFill(config.tileMap.normal.id);
	ctx.fillRect(0, 0, cv.width, cv.height);
	for (var i = 0; i < map.cells.length; i++) {
		var cell = map.cells[i];
		var hes = cell.halfedges;
		if (!hes || hes.length === 0) { continue; }
		ctx.beginPath();
		var v = getStartpoint(hes[0]);
		ctx.moveTo(v.x, v.y);
		for (var h = 0; h < hes.length; h++) { v = getEndpoint(hes[h]); ctx.lineTo(v.x, v.y); }
		ctx.closePath();
		ctx.fillStyle = thumbnailTileFill(cell.id);
		ctx.fill();
	}
	// Hazards: matches drawBumper/drawMovingBumper in draw.js (orange disc +
	// red attack ring; moving bumper also draws its rail). The thumbnail can't
	// know the moving bumper's current position along the rail, so it draws
	// the bumper at the rail anchor — where every round starts it anyway.
	if (Array.isArray(map.hazards)) {
		var bumperColor = config.hazards.bumper.color;
		var bumperRingColor = "#E5392B";
		var attackR = config.hazards.bumper.attackRadius;
		var bodyR = config.hazards.bumper.radius;
		var mbWidth = config.hazards.movingBumper.width;
		var mbHeight = config.hazards.movingBumper.height;
		for (var hi = 0; hi < map.hazards.length; hi++) {
			var hz = map.hazards[hi];
			if (hz == null) { continue; }
			if (hz.id === config.hazards.movingBumper.id) {
				ctx.save();
				ctx.translate(hz.x, hz.y);
				ctx.rotate((hz.angle || 0) * Math.PI / 180);
				ctx.fillStyle = "black";
				ctx.fillRect(0, -mbHeight / 2, mbWidth, mbHeight);
				ctx.restore();
			}
			ctx.beginPath();
			ctx.arc(hz.x, hz.y, attackR, 0, 2 * Math.PI);
			ctx.strokeStyle = bumperRingColor;
			ctx.lineWidth = 3;
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(hz.x, hz.y, bodyR, 0, 2 * Math.PI);
			ctx.fillStyle = bumperColor;
			ctx.fill();
		}
	}
	return cv;
}
function applyAbilites(abilities) {
	if (abilities.length == 0) {
		return;
	}
	for (var i = 0; i < currentMap.cells.length; i++) {
		if (currentMap.cells[i].id == config.tileMap.ability.id) {
			currentMap.cells[i].id = abilities[currentMap.cells[i].site.voronoiId];
		}
	}
	invalidateMapCache();
}
function applyRandomTiles(randomTiles) {
	if (randomTiles.length == 0) {
		return;
	}
	for (var i = 0; i < currentMap.cells.length; i++) {
		if (currentMap.cells[i].id == config.tileMap.random.id) {
			currentMap.cells[i].id = randomTiles[currentMap.cells[i].site.voronoiId];
		}
	}
	invalidateMapCache();
}
function applyHazards(payload) {
	if (payload == null) {
		return;
	}
	payload = JSON.parse(payload);
	for (var i = 0; i < payload.length; i++) {
		var hazard = payload[i];
		if (hazardList[hazard[0]] != null) {
			continue;
		}
		hazardList[hazard[0]] = {};
		hazardList[hazard[0]].ownerId = hazard[0];
		hazardList[hazard[0]].id = hazard[1];
		hazardList[hazard[0]].x = hazard[2];
		hazardList[hazard[0]].y = hazard[3];
		hazardList[hazard[0]].tx = hazard[2];   // seed render-smoothing target (see smoothEntities)
		hazardList[hazard[0]].ty = hazard[3];
		hazardList[hazard[0]].angle = hazard[4];

		hazardList[hazard[0]].railX = hazardList[hazard[0]].x;
		hazardList[hazard[0]].railY = hazardList[hazard[0]].y;

	}
}
function clearInfection() {
	for (var id in playerList) {
		if (playerList[id].infected) {
			playerList[id].infected = false;
		}
	}
}

function applyBrutalMap(brconfig) {
	// Always recompute `infection` from this round's config: the early-return
	// branch used to leave it untouched, so a non-brutal round after an
	// infection round inherited the poison-lava texture (loadPatterns()
	// reads this flag) and the visuals never cleared.
	infection = brconfig.brutal != false &&
		brconfig.brutalTypes.indexOf(config.brutalRounds.infection.id) != -1;
	if (brconfig.brutal == false) {
		brutalRound = false;
		brutalRoundConfig = null;
		return;
	}
	brutalRound = true;
	brutalRoundConfig = brconfig;
	playSound(brutalRoundSound);
}

function spawnLobbyStartButton(payload) {
	if (payload == null) {
		return;
	}
	payload = JSON.parse(payload);
	lobbyStartButton = {};
	lobbyStartButton.x = payload[0];
	lobbyStartButton.y = payload[1];
	lobbyStartButton.radius = payload[2];
	lobbyStartButton.color = payload[3];
	lobbyStartButton.angle = 0;
	lobbyStartButton.velocity = 0;
	lobbyStartButton.maxVelocity = 60;
	lobbyStartButton.startSpin = false;
}
// Load the curated tutorial-islands map for the lobby (packet[4] = map id). The
// map is already in maps[] (delivered to every client at startup); we just render
// it like a race map so players can walk the islands. null id = plain lobby.
function loadLobbyMap(payload) {
	if (payload == null) {
		return;
	}
	var data = JSON.parse(payload);
	var mapID = data[4];
	if (mapID == null) {
		currentMap = {};
		invalidateMapCache();
		return;
	}
	loadNewMap(mapID);
	loadPatterns();
	invalidateMapCache();
}
function spawnPunch(payload) {
	if (payload == null) {
		return;
	}
	payload = JSON.parse(payload);
	var punch = {};
	punch.ownerId = payload[0];
	punch.x = payload[1];
	punch.y = payload[2];
	punch.color = payload[3];
	punch.radius = payload[4];
	punch.type = payload[5];
	punch.bonus = (payload[6] != null) ? payload[6] : 1;
	punchList[punch.ownerId] = punch;
	return punch;
}
function spawnClouds(packet) {
	var parsed = JSON.parse(packet);
	for (var i = 0; i < parsed.length; i++) {
		var cloud = parsed[i];
		var newCloudID = cloud[0];
		projectileList[newCloudID] = {};
		projectileList[newCloudID].ownerId = cloud[0];
		projectileList[newCloudID].x = cloud[1];
		projectileList[newCloudID].y = cloud[2];
		projectileList[newCloudID].type = "cloud";
		projectileList[newCloudID].rotation = getRandomInt(1, 360);
	}
}
function spawnBomb(owner) {
	var bomb = {};
	bomb.ownerId = owner;
	bomb.x = playerList[owner].x;
	bomb.y = playerList[owner].y;
	bomb.radius = 10;
	bomb.rotation = 0;
	bomb.color = "black";
	projectileList[owner] = bomb;
}
function spawnPuck(owner) {
	var puck = {};
	puck.ownerId = owner;
	puck.x = -100;
	puck.y = -100;
	puck.radius = config.brutalRounds.hockey.puckRadius;
	puck.rotation = 0;
	puck.color = "black";
	projectileList[owner] = puck;
}
function spawnSnowFlake(owner) {
	var snowFlake = {};
	snowFlake.ownerId = owner;
	snowFlake.x = playerList[owner].x;
	snowFlake.y = playerList[owner].y;
	snowFlake.radius = config.tileMap.abilities.iceCannon.snowFlakeRadius;
	snowFlake.rotation = 15;
	snowFlake.color = "black";
	projectileList[owner] = snowFlake;
}
function spawnSwapAimer(owner) {
	var aimer = {};
	aimer.ownerId = owner;
	aimer.x = playerList[owner].x;
	aimer.y = playerList[owner].y;
	aimer.targetList = '';
	aimer.radius = config.tileMap.abilities.swap.startSize;
	aimer.color = "red";
	aimer.hide = false;
	aimerList[owner] = aimer;
	return aimer;
}
function spawnExplosionAimer(owner) {
	var aimer = {};
	aimer.ownerId = owner;
	aimer.x = playerList[owner].x;
	aimer.y = playerList[owner].y;
	aimer.targetList = '';
	aimer.radius = config.explosionRadius;
	aimer.color = "red";
	aimer.hide = false;
	aimerList[owner] = aimer;
	return aimer;
}

function terminatePunch(id) {
	if (punchList[id] != null) {
		delete punchList[id];
	}
}
function terminateProj(id) {
	if (projectileList[id] != null) {
		delete projectileList[id];
	}
}
function terminateAimer(id) {
	if (aimerList[id] != null) {
		delete aimerList[id];
	}
}
function resetHazardList() {
	hazardList = {};
}

function resetPlayers() {
	for (var id in playerList) {
		var player = playerList[id];
		player.alive = true;
		player.deathMessage = null;
		player.deathX = null;
		player.deathY = null;
		player.deathAt = null;
		player.trail = new Trail({ x: player.x, y: player.y });
	}
}
function resetProjectiles() {
	for (var id in projectileList) {
		delete projectileList[id];
	}
	projectileList = {};
}

function fullReset() {
	gameLength = config.baseNotchesToWin;
	playerWon = null;
	achievements = null;
	decodedColorName = '';
	oldNotches = {};
	aimerList = {};
	timerList = [];
	playersNearVictory = [];
	round = 0;
	nextMapPreview = null;
	nextMapThumbnail = null;
	brutalRound = false;
	blackout = false;
	infection = false;
	brutalRoundConfig = null;
	resetProjectiles();
	resetHazardList();
	for (var id in playerList) {
		var player = playerList[id];
		player.alive = true;
		player.nearVictory = false;
		player.ability = null;
		player.deathMessage = null;
		player.deathX = null;
		player.deathY = null;
		player.deathAt = null;
		player.infected = false;
		player.onFire = 0;
		player.trail = new Trail({ x: player.x, y: player.y });
		player.notches = 0;
		oldNotches[id] = player.notches;
	}

}

function collapseCells(cells) {
	for (var i = 0; i < currentMap.cells.length; i++) {
		var cell = currentMap.cells[i];
		for (var j = 0; j < cells.length; j++) {
			if (cells[j] == cell.site.voronoiId) {
				cell.id = config.tileMap.lava.id;
				cell.color = config.tileMap.lava.color;
			}
		}
	}
	invalidateMapCache();
}
function explodedCells(cells) {
	for (var i = 0; i < currentMap.cells.length; i++) {
		var cell = currentMap.cells[i];
		for (var j = 0; j < cells.length; j++) {
			if (cells[j] == cell.site.voronoiId) {
				cell.id = config.tileMap.slow.id;
				cell.color = config.tileMap.slow.color;
			}
		}
	}
	invalidateMapCache();
}

// Average site position of a set of voronoi ids — used to place a blast effect
// at the centre of the cells a bomb just flattened.
function cellsCentroid(voronoiIds) {
	if (currentMap == null || currentMap.cells == null || voronoiIds == null) {
		return null;
	}
	var sumX = 0, sumY = 0, count = 0;
	for (var i = 0; i < currentMap.cells.length; i++) {
		var cell = currentMap.cells[i];
		for (var j = 0; j < voronoiIds.length; j++) {
			if (voronoiIds[j] == cell.site.voronoiId) {
				sumX += cell.site.x;
				sumY += cell.site.y;
				count++;
				break;
			}
		}
	}
	if (count === 0) {
		return null;
	}
	return { x: sumX / count, y: sumY / count, count: count };
}

function playerPickedUpAbility(payload) {
	playerList[payload.owner].ability = payload.ability;
	if (payload.voronoiId == null) {
		return;
	}
	for (var i = 0; i < currentMap.cells.length; i++) {
		var cell = currentMap.cells[i];
		if (cell.site.voronoiId == payload.voronoiId) {
			cell.id = config.tileMap.normal.id;
			invalidateMapCache();
			return;
		}
	}
}

function changeTilesBulk(tileChanges) {
	for (var prop in tileChanges) {
		for (var i = 0; i < currentMap.cells.length; i++) {
			var cell = currentMap.cells[i];
			if (cell.site.voronoiId == prop) {
				cell.id = tileChanges[prop];
				break;
			}

		}
		// A telegraphed tile that just changed — by ANY cause (the swap itself, a
		// bomb, the collapse) — no longer needs pulsing. We stop telegraphing it
		// here but do NOT play the swap sound from this path: an unrelated change
		// flipping the last pending tile must not trigger the swap audio early.
		// The sound is driven by the dedicated "tileSwapPerformed" event.
		if (pendingSwapCells != null && pendingSwapCells.set[prop] != null) {
			delete pendingSwapCells.set[prop];
		}
	}
	if (pendingSwapCells != null && Object.keys(pendingSwapCells.set).length === 0) {
		pendingSwapCells = null;
	}
	invalidateMapCache();
}

// Record which tiles a tileSwap is about to flip, so drawPendingSwap can
// pulse/flicker them during the warn-up. Each tile carries its OWN start/end
// timeline, so when two tileSwaps overlap the second one doesn't restart the
// pulse on the first's already-warming tiles. If a tile is telegraphed by both,
// keep whichever flip is imminent (the earliest end) so its pulse keeps
// intensifying toward the real flip.
function markPendingSwap(ids, duration) {
	if (ids == null || ids.length === 0) {
		return;
	}
	var now = Date.now();
	var end = now + duration;
	var set = (pendingSwapCells != null) ? pendingSwapCells.set : {};
	for (var i = 0; i < ids.length; i++) {
		var existing = set[ids[i]];
		if (existing == null || end < existing.end) {
			set[ids[i]] = { start: now, end: end };
		}
	}
	pendingSwapCells = { set: set };
}

// The swap actually landed. Driven by a dedicated server event (not inferred
// from the tile-change batch), so it fires exactly once when the flip happens
// — never early because some other tile change emptied the pending set, and
// never dropped because a telegraphed tile got converted before the swap. Plays
// the delayed swap sound and stops telegraphing the tiles this swap flipped.
function tileSwapLanded(ids) {
	playSound(tileSwap);
	if (pendingSwapCells == null) {
		return;
	}
	if (ids != null) {
		for (var i = 0; i < ids.length; i++) {
			delete pendingSwapCells.set[ids[i]];
		}
	}
	if (Object.keys(pendingSwapCells.set).length === 0) {
		pendingSwapCells = null;
	}
}


function playerAbilityUsed(owner) {
	playerList[owner].ability = null;
}

function createBlindFold(owner) {
	blindfold.color = makePattern(blindfoldLargeIcon, this.playerList[owner].color);
	// Timestamps let drawAbilties() ease the overlay in and out (see blindfoldAlpha).
	blindfold.start = Date.now();
	blindfold.duration = config.tileMap.abilities.blindfold.duration * 1000;
	var int = setInterval(function () {
		clearInterval(int);
		blindfold.color = null;
	}, config.tileMap.abilities.blindfold.duration * 1000);
}

// --- Screen shake (trauma model) ---
// Callers add "trauma" (0..1); the rendered offset is maxShakeOffset * trauma^2
// so a big hit reads much harder than a small one, and the shake tapers off
// smoothly as trauma decays instead of snapping off after a fixed timer.
var maxShakeOffset = 16;        // px at full trauma
var shakeDecayPerSec = 1.6;     // trauma units bled off per second
var shakeSustainUntil = 0;      // for events that should rumble for a while
var shakeSustainFloor = 0;

function addTrauma(amount) {
	shakeTrauma = Math.min(1, shakeTrauma + amount);
}
// A sustained low rumble while a punch is charging (held one frame at a time): set a
// trauma FLOOR rather than accumulating, so it holds steady instead of ramping to max.
// Respects a stronger existing sustain (e.g. a volcano) so charging can't quiet it.
function chargeRumble(intensity) {
	if (Date.now() < shakeSustainUntil) {
		shakeSustainFloor = Math.max(shakeSustainFloor, intensity);
	} else {
		shakeSustainFloor = intensity;
	}
	shakeSustainUntil = Date.now() + 90;
}
// Hold a minimum trauma floor for a duration (e.g. a long volcano eruption),
// then let it decay normally.
function rumbleSustained(durationMs, intensity) {
	shakeSustainUntil = Date.now() + durationMs;
	shakeSustainFloor = intensity;
	addTrauma(intensity);
}
function updateShake(dt) {
	if (Date.now() < shakeSustainUntil && shakeTrauma < shakeSustainFloor) {
		shakeTrauma = shakeSustainFloor;
	}
	if (shakeTrauma > 0) {
		shakeTrauma = Math.max(0, shakeTrauma - shakeDecayPerSec * (dt / 1000));
	}
}
// Back-compat shim: a couple of call sites still pass a duration in ms. Map it
// to a one-shot trauma jolt (longer => slightly stronger).
function rumbleScreen(time) {
	addTrauma(time >= 500 ? 0.6 : 0.45);
}

// --- Transient render effects (shockwaves, sparks, slashes, puffs) ---
// Each effect carries its own clock so its visual lifetime is independent of
// any server object (the punch object, for instance, only lives ~100ms). An
// effect is { age, maxAge, draw(ctx, t, effect), update?(dt), screen? }; t is
// the normalized 0..1 progress passed to draw. screen:true skips the camera
// translate (for screen-space flashes); world-space is the default.
function addEffect(effect) {
	if (effect == null) {
		return null;
	}
	effect.age = 0;
	if (effect.maxAge == null) {
		effect.maxAge = 300;
	}
	// Bound the live effect list per the performance profile. At the cap, an
	// ordinary cosmetic effect is simply DROPPED (O(1), no array churn / GC) —
	// the cheap path, since this runs hardest on the low-end device the cap is
	// for. A gameplay telegraph (tagged `keep` — death ping, brutal-round flash)
	// is always admitted, making room by evicting the oldest non-keep effect, so
	// a flood of cosmetic FX can never crowd out something the player must see.
	// The safe default is evictable: a new cosmetic spawner needs no flag.
	// HIGH's cap is effectively unbounded, so this never trims on desktop.
	if (typeof perfMaxEffects === "function" && effectsList.length >= perfMaxEffects()) {
		if (!effect.keep) {
			return null;
		}
		var ei = 0;
		while (ei < effectsList.length && effectsList[ei].keep) {
			ei++;
		}
		// Evict the oldest non-keep effect. If EVERY live effect is a telegraph,
		// let the list exceed the cap rather than dropping one — telegraphs are
		// few and short-lived, so "keep" truly means never evicted.
		if (ei < effectsList.length) {
			effectsList.splice(ei, 1);
		}
	}
	effectsList.push(effect);
	return effect;
}
function updateEffects(dt) {
	for (var i = effectsList.length - 1; i >= 0; i--) {
		var e = effectsList[i];
		e.age += dt;
		if (e.update != null) {
			e.update(dt);
		}
		if (e.age >= e.maxAge) {
			effectsList.splice(i, 1);
		}
	}
}
// True if id belongs to a player controlled on this screen (covers couch
// multiplayer where several local slots share one client).
function isLocalId(id) {
	if (id == null) {
		return false;
	}
	if (id == myID) {
		return true;
	}
	if (typeof localPlayers !== "undefined" && localPlayers) {
		for (var s = 0; s < localPlayers.length; s++) {
			if (localPlayers[s] && localPlayers[s].myID == id) {
				return true;
			}
		}
	}
	return false;
}

// --- Movement & burn particles ---
// Driven per-frame from player velocity (decoded from gameUpdates), throttled
// by per-player cooldowns so a fast lap doesn't flood the effects list.

// A single drifting, fading puff. vx/vy are in px per ms. A faint dark outline
// keeps it readable even when its colour is close to the terrain underneath.
function spawnDustParticle(x, y, vx, vy, size, color) {
	addEffect({
		x: x,
		y: y,
		maxAge: 430,
		draw: function (ctx, t, e) {
			var a = 1 - t;
			var r = size * (1 - 0.35 * t);
			ctx.save();
			ctx.beginPath();
			ctx.arc(x + vx * e.age, y + vy * e.age, r, 0, 2 * Math.PI);
			ctx.globalAlpha = a * 0.85;
			ctx.fillStyle = color;
			ctx.fill();
			ctx.globalAlpha = a * 0.4;
			ctx.lineWidth = 1;
			ctx.strokeStyle = "rgba(0, 0, 0, 1)";
			ctx.stroke();
			ctx.restore();
		}
	});
}

// A flame sprite on top of a sinking corpse. Mirrors drawFire's translate+rotate,
// but takes explicit (x, y, angle, size) so it can be driven from an effect that
// no longer has a live player entry (the dead kart isn't in playerList anymore).
function drawCorpseFire(x, y, angleDeg, size) {
	if (typeof redFire === "undefined" || redFire == null || redFire.spriteSheet == null) {
		return;
	}
	gameContext.save();
	var ar = angleDeg * (Math.PI / 180);
	gameContext.translate(x - 5 * Math.cos(ar), y - 5 * Math.sin(ar));
	gameContext.rotate((angleDeg - 90) * (Math.PI / 180));
	redFire.spriteSheet.update(dt);
	redFire.spriteSheet.draw(size, size);
	gameContext.restore();
}

// A "crashed and sinking" corpse: when a player dies on lava, leave a shrinking,
// darkening disc bobbing slightly as it sinks, with a flame sprite on top for the
// first ~70% of the dive plus a fading surface ring and a slow drip of embers and
// lava bubble pops. Lives ~2.8s in the effects list, which is cleaned up by the
// usual `updateEffects` path. Entirely cosmetic: doesn't touch playerList or any
// recap/networking state. Skipped on LOW (perfExtraFx) — most of the new visual
// budget for this feature lives here.
function spawnSinkingCorpse(player) {
	if (player == null) {
		return;
	}
	if (typeof perfExtraFx === "function" && !perfExtraFx()) {
		return;
	}
	var cx = (player.deathX != null) ? player.deathX : player.x;
	var cy = (player.deathY != null) ? player.deathY : player.y;
	if (cx == null || cy == null || isNaN(cx) || isNaN(cy)) {
		return;
	}
	var color = player.color || "#cc3333";
	var angle0 = (player.angle != null) ? player.angle : 0;
	var radius0 = (player.radius != null && player.radius > 0) ? player.radius : 11;
	// Longer sink + flame phase reads as a slow burnout, not a flash. The flame
	// stays visible through ~80% of the sink and shrinks gently with the body
	// (not aggressively) so it's still legible when the disc is small.
	var maxAge = 3600;
	var flameCutoff = 0.8;
	// Closure state for the per-frame update (embers + bubble pops on a cadence).
	var lastEmberAt = -1000; // negative so the first ember fires immediately
	var lastBubbleAt = -1000;
	addEffect({
		x: cx,
		y: cy,
		maxAge: maxAge,
		update: function (deltaT) {
			var age = this.age;
			var t = age / maxAge;
			// Embers ride on the same per-tier embers knob that the running flame uses,
			// so a Balanced profile that already dims live-fire embers also dims these.
			if (t < 0.9 && age - lastEmberAt >= 110) {
				lastEmberAt = age;
				if (typeof perfEmbers !== "function" || perfEmbers()) {
					spawnEmber(cx + (Math.random() * 2 - 1) * radius0 * 0.6,
						cy + (Math.random() * 2 - 1) * radius0 * 0.4);
				}
			}
			// Lava bubble pops: orange droplets that rise + fade. perfCount thins them
			// on Balanced (0.6) and would on Low too — but Low never reaches this code.
			if (t < 0.95 && age - lastBubbleAt >= 220) {
				lastBubbleAt = age;
				var n = (typeof perfCount === "function") ? perfCount(2) : 2;
				for (var i = 0; i < n; i++) {
					var ang = Math.random() * Math.PI * 2;
					var r = Math.random() * radius0 * 0.85;
					var bx = cx + Math.cos(ang) * r;
					var by = cy + Math.sin(ang) * r;
					var vx = (Math.random() * 2 - 1) * 0.012;
					var vy = -(0.022 + Math.random() * 0.022);
					var hue = 18 + Math.random() * 22;
					var size = 1.6 + Math.random() * 2.2;
					spawnDustParticle(bx, by, vx, vy, size, "hsl(" + hue + ", 92%, 55%)");
				}
			}
		},
		draw: function (ctx, t) {
			var sink = t;
			var bodyR = radius0 * (1 - 0.85 * sink);
			if (bodyR <= 0.5) {
				return;
			}
			// Surface lava ring: a quick widening ring at the moment of impact,
			// fully gone by ~70% sink.
			if (sink < 0.7) {
				var ringAlpha = 0.85 * (1 - sink / 0.7);
				ctx.save();
				ctx.globalAlpha = ringAlpha;
				ctx.beginPath();
				ctx.arc(cx, cy, radius0 * (1 + 0.45 * sink), 0, 2 * Math.PI);
				ctx.strokeStyle = "rgba(255, 130, 50, 1)";
				ctx.lineWidth = 2.4;
				ctx.stroke();
				ctx.restore();
			}
			// Sinking disc: roll slowly, bob slightly, dim toward black as it goes under.
			var rollDeg = angle0 + 35 * sink;
			var bob = 3 * Math.sin(sink * Math.PI);
			ctx.save();
			ctx.translate(cx, cy + bob);
			ctx.rotate(rollDeg * Math.PI / 180);
			ctx.globalAlpha = clamp01(1 - sink * 0.85);
			ctx.beginPath();
			ctx.arc(0, 0, bodyR, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();
			// Scorch overlay strengthens with the sink so the disc reads "burnt" not
			// just "small" — pure black at low alpha multiplies the tint toward dark.
			ctx.globalAlpha = clamp01(sink * 0.75);
			ctx.beginPath();
			ctx.arc(0, 0, bodyR, 0, 2 * Math.PI);
			ctx.fillStyle = "rgba(20, 10, 4, 1)";
			ctx.fill();
			// Thin outline so the corpse stays legible over the lava texture.
			ctx.globalAlpha = clamp01(1 - sink);
			ctx.lineWidth = 1.4;
			ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
			ctx.stroke();
			ctx.restore();
			// Flame on top through the first ~80% of the sink, shrinking gently so
			// it stays legible while the disc gets small.
			if (sink < flameCutoff) {
				var flameT = sink / flameCutoff;
				var flameAlpha = 1 - flameT;
				var flameSize = 55 * (1 - 0.4 * sink);
				ctx.save();
				ctx.globalAlpha = flameAlpha;
				drawCorpseFire(cx, cy + bob, rollDeg, flameSize);
				ctx.restore();
			}
		}
	});
}

// A rising, cooling ember for a burning player (complements the flame sprite).
function spawnEmber(x, y) {
	var vx = (Math.random() * 2 - 1) * 0.015;
	var vy = -(0.03 + Math.random() * 0.03);
	var hue = 18 + Math.random() * 32;
	var maxAge = 500 + Math.random() * 300;
	addEffect({
		x: x,
		y: y,
		maxAge: maxAge,
		draw: function (ctx, t, e) {
			ctx.save();
			ctx.globalAlpha = (1 - t) * 0.9;
			ctx.fillStyle = "hsl(" + hue + ", 100%, " + (62 - 22 * t) + "%)";
			ctx.beginPath();
			ctx.arc(x + vx * e.age, y + vy * e.age, 2.5 * (1 - t) + 0.5, 0, 2 * Math.PI);
			ctx.fill();
			ctx.restore();
		}
	});
}

// Fire a muzzle flash from a player's front edge in their facing direction, and
// a small recoil kick (screen shake) if a local player fired.
function fireMuzzleFlash(owner, color) {
	var p = playerList[owner];
	if (p == null) {
		return;
	}
	var front = pos({ x: p.x, y: p.y }, p.radius, p.angle);
	spawnMuzzleFlash(front.x, front.y, p.angle, color);
	if (typeof recapMarkEffect === "function") {
		recapMarkEffect("muzzle", front.x, front.y, { angle: p.angle, color: color });
	}
	if (isLocalId(owner)) {
		addTrauma(0.18);
	}
}

// Terrain palette for movement particles. Colours are picked to CONTRAST the
// tile they land on (bright lime over green grass, pale dust over tan sand,
// deep cyan over pale ice) so the flecks read instead of blending in.
function dustColor() { return "rgba(170, 150, 120, 1)"; }   // dirt
function grassColor() { return "rgba(150, 230, 70, 1)"; }    // bright lime
function sandColor() { return "rgba(250, 238, 205, 1)"; }    // pale dust puff
function iceColor() { return "rgba(70, 165, 220, 1)"; }      // deep cyan scrape
function terrainParticleColor(tile) {
	if (config != null) {
		if (tile == config.tileMap.fast.id) { return grassColor(); }
		if (tile == config.tileMap.slow.id) { return sandColor(); }
		if (tile == config.tileMap.ice.id) { return iceColor(); }
	}
	return dustColor();
}

// Which tile id a point sits on. The map is a Voronoi diagram, so the cell a
// point belongs to is simply the one whose site is nearest — cheap and exact,
// and it tracks tile changes (bombs, tileSwap) since cell.id is mutated in place.
function tileIdAt(x, y) {
	if (currentMap == null || currentMap.cells == null) {
		return null;
	}
	var cells = currentMap.cells;
	var bestId = null, bestD = Infinity;
	for (var i = 0; i < cells.length; i++) {
		var s = cells[i].site;
		var dx = s.x - x, dy = s.y - y;
		var d = dx * dx + dy * dy;
		if (d < bestD) { bestD = d; bestId = cells[i].id; }
	}
	return bestId;
}

// `count` flecks kicked up behind a moving player, coloured by the terrain and
// scattered a little so they read as a puff rather than a single dot.
function spawnTerrainParticle(p, color, minSize, count) {
	count = (typeof perfCount === "function") ? perfCount(count || 1) : (count || 1);
	var dir = Math.atan2(p.velY, p.velX);
	for (var i = 0; i < count; i++) {
		var bx = p.x - Math.cos(dir) * p.radius + (Math.random() * 2 - 1) * p.radius * 0.5;
		var by = p.y - Math.sin(dir) * p.radius + (Math.random() * 2 - 1) * p.radius * 0.5;
		var spread = (Math.random() * 2 - 1) * 0.03;
		var vx = -Math.cos(dir) * 0.013 + Math.cos(dir + Math.PI / 2) * spread;
		var vy = -Math.sin(dir) * 0.013 + Math.sin(dir + Math.PI / 2) * spread;
		spawnDustParticle(bx, by, vx, vy, minSize + Math.random() * 2, color);
	}
}

// One lingering skate streak (blade mark) left on ice.
function addIceStreak(bx, by, ex, ey) {
	addEffect({
		x: bx,
		y: by,
		maxAge: 700,
		draw: function (ctx, t) {
			ctx.save();
			ctx.globalAlpha = (1 - t) * 0.6;
			ctx.strokeStyle = iceColor();
			ctx.lineWidth = 3;
			ctx.lineCap = "round";
			ctx.beginPath();
			ctx.moveTo(bx, by);
			ctx.lineTo(ex, ey);
			ctx.stroke();
			ctx.restore();
		}
	});
}
// A pair of skate marks behind a player gliding over ice.
function spawnIceTrail(p) {
	var dir = Math.atan2(p.velY, p.velX);
	var len = p.radius * 1.7;
	var perp = dir + Math.PI / 2;
	var gap = p.radius * 0.5;
	for (var s = -1; s <= 1; s += 2) {
		var bx = p.x + Math.cos(perp) * gap * s;
		var by = p.y + Math.sin(perp) * gap * s;
		addIceStreak(bx, by, bx - Math.cos(dir) * len, by - Math.sin(dir) * len);
	}
}

// Colours for the trench a kart plows through sand: a recessed shadow groove
// (the dug-out floor) flanked by pale berms (sand shoved up to either side).
function sandTrenchColor() { return "rgba(120, 92, 52, 1)"; }   // dark sandy shadow
// One lingering trench segment carved through the dune from (bx,by) to (ex,ey).
// `dir` is the travel angle and `radius` the kart radius — used to splay the
// berms out either side of the groove. Lingers longer than an ice mark because
// scooped sand holds its shape.
function addSandTrench(bx, by, ex, ey, dir, radius) {
	var perp = dir + Math.PI / 2;
	var off = radius * 0.7;
	var ox = Math.cos(perp) * off, oy = Math.sin(perp) * off;
	addEffect({
		x: bx,
		y: by,
		maxAge: 1300,
		draw: function (ctx, t) {
			ctx.save();
			ctx.lineCap = "round";
			// Recessed groove floor: a soft, wide dark band the width of the kart.
			ctx.globalAlpha = (1 - t) * 0.3;
			ctx.strokeStyle = sandTrenchColor();
			ctx.lineWidth = off * 2;
			ctx.beginPath();
			ctx.moveTo(bx, by);
			ctx.lineTo(ex, ey);
			ctx.stroke();
			// Pushed-up berms: thin pale ridges along each lip of the trench.
			ctx.globalAlpha = (1 - t) * 0.5;
			ctx.strokeStyle = sandColor();
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.moveTo(bx + ox, by + oy);
			ctx.lineTo(ex + ox, ey + oy);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(bx - ox, by - oy);
			ctx.lineTo(ex - ox, ey - oy);
			ctx.stroke();
			ctx.restore();
		}
	});
}
// Extend the continuous trench behind a kart trudging through sand. Segments are
// laid by distance travelled (not time) so a slow crawl draws one clean groove
// instead of stacking overlapping bands into a dark blob; a big jump (re-entering
// sand, a teleport) just resets the anchor without drawing a streak across the map.
// The segment is stamped onto a persistent ground decal (drawTrenchDecal) so the
// trench lasts — through a whole race round, and across the lobby until the next
// round wipes it (resetRound clears the decal). LOW never reaches here (the extraFx
// gate at the call site skips the trench on phone-class devices); the addSandTrench
// fading effect is the fallback if the decal ever isn't available.
function spawnSandTrail(p) {
	if (p.trenchX == null) { p.trenchX = p.x; p.trenchY = p.y; return; }
	var dx = p.x - p.trenchX, dy = p.y - p.trenchY;
	var d2 = dx * dx + dy * dy;
	var step = p.radius * 0.5;
	if (d2 < step * step) { return; }
	var maxGap = p.radius * 4;
	if (d2 <= maxGap * maxGap) {
		var dir = Math.atan2(dy, dx);
		var inGame = (currentState == config.stateMap.racing ||
			currentState == config.stateMap.collapsing ||
			currentState == config.stateMap.lobby);
		if (inGame && typeof stampSandTrench === "function") {
			stampSandTrench(p.trenchX, p.trenchY, p.x, p.y, dir, p.radius);
		} else {
			addSandTrench(p.trenchX, p.trenchY, p.x, p.y, dir, p.radius);
		}
	}
	p.trenchX = p.x;
	p.trenchY = p.y;
}

// A skid burst when a player whips around — particles fly off in the old
// direction of travel, coloured by the terrain underfoot.
function spawnSkid(p, color) {
	var dir = Math.atan2(p.prevVelY, p.prevVelX);
	var n = (typeof perfCount === "function") ? perfCount(4) : 4;
	for (var i = 0; i < n; i++) {
		var spread = (Math.random() * 2 - 1) * 0.04;
		var vx = Math.cos(dir) * 0.02 + Math.cos(dir + Math.PI / 2) * spread;
		var vy = Math.sin(dir) * 0.02 + Math.sin(dir + Math.PI / 2) * spread;
		spawnDustParticle(p.x, p.y, vx, vy, 2.5 + Math.random() * 2, color);
	}
}

function updateMovementParticles(dt) {
	if (config == null) {
		return;
	}
	// Spawn-cooldown helper: the performance profile stretches the gaps between
	// particle bursts (>1x => rarer) so a low-end device emits fewer over time.
	var cd = (typeof perfCooldown === "function") ? perfCooldown : function (ms) { return ms; };
	var maxSpeed = config.playerMaxSpeed;
	var fastThresh = maxSpeed * 0.55;
	var walkThresh = maxSpeed * 0.08;
	for (var id in playerList) {
		var p = playerList[id];
		if (p == null || p.alive == false || p.velX == null) {
			continue;
		}
		var speed = Math.sqrt(p.velX * p.velX + p.velY * p.velY);

		if (p.dustCD == null) { p.dustCD = 0; }
		if (p.skidCD == null) { p.skidCD = 0; }
		if (p.emberCD == null) { p.emberCD = 0; }
		p.dustCD -= dt;
		p.skidCD -= dt;
		p.emberCD -= dt;

		// Sharp turn at speed -> skid burst (dot product of old/new velocity).
		if (p.prevVelX != null && p.skidCD <= 0 && speed > fastThresh * 0.5) {
			var prevSpeed = Math.sqrt(p.prevVelX * p.prevVelX + p.prevVelY * p.prevVelY);
			if (prevSpeed > 1) {
				var dot = (p.velX * p.prevVelX + p.velY * p.prevVelY) / (speed * prevSpeed);
				if (dot < 0.6) {
					spawnSkid(p, terrainParticleColor(tileIdAt(p.x, p.y)));
					p.skidCD = cd(140);
				}
			}
		}

		// Moving -> terrain-aware trail. Ice glides leave skate marks; at a walk
		// it sheds a faint shaving fleck. Grass/sand sprinkle at any pace. Bare
		// dirt kicks up a subtle puff at a walk and a stronger one at speed.
		// The walking-speed flecks (ice shavings + dirt puff) are AMBIENT and
		// gated by perfExtraFx() so LOW skips them.
		var extraFx = (typeof perfExtraFx === "function") ? perfExtraFx() : true;
		// Sand (the slow tile) tops out (~21) BELOW walkThresh (40) because it's the
		// draggiest surface, so gating it at walkThresh meant sand flecks only fired
		// during the momentum-carrying crossover ONTO sand and never while you were
		// actually driving on it. Sand gets its own lower gate; every other tile keeps
		// walkThresh so the ambient ice/dirt flecks still stay quiet at idle.
		var sandThresh = maxSpeed * 0.03;
		if (speed > sandThresh && p.dustCD <= 0) {
			var tile = tileIdAt(p.x, p.y);
			// Drop the trench anchor the moment the kart leaves sand, so a trench is
			// only ever stamped along CONTINUOUS sand travel. Otherwise two sand cells
			// separated by a short non-sand gap (< p.radius * 4) would reuse the old
			// anchor and stamp a groove straight across the gap.
			if (tile != config.tileMap.slow.id) {
				p.trenchX = null;
				p.trenchY = null;
			}
			if (tile != config.tileMap.slow.id && speed <= walkThresh) {
				// Non-sand tile below the walk threshold: nothing to shed. Throttle
				// the recheck so we don't run tileIdAt every frame while coasting slow.
				p.dustCD = cd(80);
			} else if (tile == config.tileMap.ice.id) {
				// Same line-mark look at every pace (matches the Codex scene):
				// two cyan blade tracks under the cart, just at a slower cadence
				// when walking so the marks don't run continuously together.
				if (speed > fastThresh) {
					spawnIceTrail(p);
					p.dustCD = cd(40);
				} else {
					if (extraFx) {
						spawnIceTrail(p);
					}
					p.dustCD = cd(120);
				}
			} else if (tile == config.tileMap.fast.id) {
				// Grass dialed back ~20% (smaller flecks) — it read a touch strong.
				spawnTerrainParticle(p, grassColor(), 1.8, 2);
				p.dustCD = cd(speed > fastThresh ? 45 : 70);
			} else if (tile == config.tileMap.slow.id) {
				// Trudging through a dune: a continuous trench carves out behind the
				// kart (skipped on LOW — it's a lingering/decal effect), with just a
				// light puff of displaced sand on top so the trench art stays readable
				// rather than being buried under a cloud of flecks.
				if (extraFx) {
					spawnSandTrail(p);
				}
				spawnTerrainParticle(p, sandColor(), 1.8, 1);
				p.dustCD = cd(speed > fastThresh ? 90 : 130);
			} else if (speed > fastThresh) {
				spawnTerrainParticle(p, dustColor(), 2.5, 2);
				p.dustCD = cd(50);
			} else {
				// Bare dirt at a walk: a single subtle puff at a slower cadence
				// than the fast-speed burst. Skipped on LOW; the throttle still
				// ticks so we don't recheck the tile every frame.
				if (extraFx) {
					spawnTerrainParticle(p, dustColor(), 1.5, 1);
				}
				p.dustCD = cd(extraFx ? 110 : 60);
			}
		}

		// Burning -> rising embers. Shed entirely on low-end profiles (the flame
		// sprite still draws, so a burning kart still reads).
		if (p.onFire > 0 && p.emberCD <= 0 && (typeof perfEmbers !== "function" || perfEmbers())) {
			spawnEmber(p.x + (Math.random() * 2 - 1) * p.radius, p.y + (Math.random() * 2 - 1) * p.radius);
			p.emberCD = cd(70);
		}

		p.prevVelX = p.velX;
		p.prevVelY = p.velY;
	}
}

function setupEmojiWheel() {
	var menu = $("#emojiMenu");
	// Remove any emoji anchors a previous run added (gameState can re-fire on a
	// socket reconnect), keeping the static close button — otherwise the wheel
	// accumulates duplicate emojis and positionEmojiSlots spreads them.
	menu.find("a").filter(function () {
		return (this.getAttribute("onclick") || "").indexOf("cancel") === -1;
	}).remove();
	for (var i = 0; i < config.emojis.length; i++) {
		menu.append('<a onclick="closeEmojiWindow(this.innerHTML)" href="#">' + config.emojis[i] + '</a>');
	}
	emojiMenu.style.borderColor = playerList[myID].color;
	positionEmojiSlots();
}

// Lay the emoji anchors out on a ring with JS-computed positions, expressed in
// percentages so they scale with the viewport-sized wheel and work for any
// emoji count (no hand-authored per-slot CSS). The first <a> is the static
// close button (kept at the centre); the rest are the emojis -- this matches
// emojiItems(), which skips the close button.
function positionEmojiSlots() {
	var items = document.querySelectorAll('#emojiMenu a');
	if (items.length === 0) {
		return;
	}
	items[0].style.left = '50%';
	items[0].style.top = '50%';
	var count = items.length - 1;
	var radiusPct = 38;
	for (var i = 1; i <= count; i++) {
		var ang = (-Math.PI / 2) + (2 * Math.PI * (i - 1) / count);
		items[i].style.left = (50 + radiusPct * Math.cos(ang)) + '%';
		items[i].style.top = (50 + radiusPct * Math.sin(ang)) + '%';
	}
}


// Trail vertices stay visible for TRAIL_FADE_MS milliseconds, then they're
// dropped off the head of the list. drawTrail (draw.js) re-strokes the
// remaining vertices each frame with alpha scaled by age, so older bits of the
// path naturally fade out. At the 30 Hz trail sample cadence this caps each
// kart's vertex buffer at ~150 entries — small enough to re-stroke cheaply on
// the main canvas, so the previous per-kart offscreen-canvas + direct-mode
// split is gone (perfTrailDirect now no-ops; both render paths converge here).
var TRAIL_FADE_MS = 5000;
class Trail {
	constructor(initialPosition) {
		this.vertices = []; // each entry: { x, y, t }
		this.lastColor = null;
		this.wasNearVictory = false;
	}
	update(currentPosition, player) {
		var now = Date.now();
		// Expire vertices off the head before considering new ones, so the
		// buffer stays bounded even when sat at the spawn pad.
		while (this.vertices.length > 0 && now - this.vertices[0].t > TRAIL_FADE_MS) {
			this.vertices.shift();
		}
		var last = this.vertices.length > 0 ? this.vertices[this.vertices.length - 1] : null;
		// Parked? Don't add a duplicate vertex — but keep tracking colour so a
		// mid-round colour-blind toggle propagates to the next live segment.
		if (last != null && currentPosition.x === last.x && currentPosition.y === last.y) {
			if (player != null) {
				this.lastColor = player.color;
			}
			return;
		}
		this.vertices.push({ x: currentPosition.x, y: currentPosition.y, t: now });
		if (player != null) {
			this.lastColor = player.color;
			var isNV = player.notches == gameLength;
			if (DEBUG_FORCE_NEAR_VICTORY && player.id == myID) {
				isNV = true;
			}
			this.wasNearVictory = isNV;
		}
	}
	reset(player) {
		this.vertices = [];
		this.wasNearVictory = false;
		this.lastColor = null;
	}
}