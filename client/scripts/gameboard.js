
var mousex,
	mousey,
	lobbyStartButton,
	gate,
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
	screenShake = false,
	blackout = false,
	timerList = [],
	playersNearVictory = [],
	pingCircles = [],
	pingIntervals = [],
	brutalRound = false,
	brutalRoundConfig = null,
	clientList;

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
}

function resetRound() {
	blackout = false;
	infection = false;
	for (var aimerID in this.aimerList) {
		delete this.aimerList[aimerID];
	}
}

function updateGameboard(dt) {
	if (currentState == config.stateMap.racing || currentState == config.stateMap.overview || currentState == config.stateMap.collapsing) {
		updateTrails();
	}
	checkTimers(dt);
}
function resetTrails() {
	for (var id in playerList) {
		var player = playerList[id];
		player.trail.reset(player);
	}
}

function updateTrails() {
	for (var id in playerList) {
		var player = playerList[id];
		if (player.alive == false || player.infected == true) {
			continue;
		}
		player.trail.update({ x: player.x, y: player.y });
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
	playerList[index].color = dataArray[3];
	playerList[index].alive = dataArray[4];
	playerList[index].notches = dataArray[5];
	playerList[index].nearVictory = dataArray[6];
	playerList[index].chatMessage = null;
	playerList[index].awake = dataArray[7];
	playerList[index].onFire = dataArray[8];
	playerList[index].ability = null;
	playerList[index].angle = dataArray[9];
	playerList[index].deathMessage = null;
	playerList[index].trail = new Trail({ x: dataArray[1], y: dataArray[2] });
	playerList[index].fizzle = function () {
		if (aimerList[index] != null && aimerList[index].startSwapCountDown) {
			aimerList[index].startSwapCountDown = false;
			playSound(abilityFizzle);
		}
	};
}

function updatePlayerList(packet) {
	if (packet == null) {
		return;
	}
	packet = JSON.parse(packet);
	for (var i = 0; i < packet.length; i++) {
		var player = packet[i];
		if (playerList[player[0]] != null) {
			playerList[player[0]].id = player[0];
			playerList[player[0]].x = player[1];
			playerList[player[0]].y = player[2];
			playerList[player[0]].velX = player[3];
			playerList[player[0]].velY = player[4];
			playerList[player[0]].angle = player[5];
		}
	}
}
function updateProjecileList(packet) {
	if (packet == null) {
		return;
	}
	packet = JSON.parse(packet);
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
	packet = JSON.parse(packet);
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
	packet = JSON.parse(packet);
	for (var i = 0; i < packet.length; i++) {
		var hazard = packet[i];
		if (hazardList[hazard[0]] != null) {
			hazardList[hazard[0]].x = hazard[1];
			hazardList[hazard[0]].y = hazard[2];
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
		gate = {};
		gate.x = payload[1];
		gate.y = payload[2];
		gate.width = payload[3];
		gate.height = payload[4];
	}

}

function loadNewMap(id) {
	currentMap = {};
	pingCircles = [];
	for (var i = 0; i < maps.length; i++) {
		if (id == maps[i].id) {
			currentMap = JSON.parse(JSON.stringify(maps[i]));
			break;
		}
	}
	if (currentState == config.stateMap.gated) {
		for (var j = 0; j < currentMap.cells.length; j++) {
			if (currentMap.cells[j].id == config.tileMap.goal.id) {
				playSound(countDownA);
				var pingCircle = { x: currentMap.cells[j].site.x, y: currentMap.cells[j].site.y, radius: 0, pass: 0 };
				pingCircles.push(pingCircle);
				pingIntervals.push(setInterval(function (ping) {
					if (ping.pass == 2) {
						var index = pingCircles.indexOf(ping);
						pingCircles.splice(index, 1);
					}
					if (ping.radius > 500) {
						ping.radius = 0;
						playSound(countDownA);
						ping.pass++;
					} else {
						ping.radius += 10;
					}

				}, 50, pingCircle));
			}
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
	nextMapThumbnail = new Image();
	nextMapThumbnail.src = nextMapPreview.thumbnail;
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
	if (brconfig.brutal == false) {
		brutalRound = false;
		brutalRoundConfig = null;
		return;
	}
	brutalRound = true;
	brutalRoundConfig = brconfig;
	playSound(brutalRoundSound);
	if (brutalRoundConfig.brutalTypes.indexOf(config.brutalRounds.infection.id) != -1) {
		infection = true;
	} else {
		infection = false;
	}
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
	}
}


function playerAbilityUsed(owner) {
	playerList[owner].ability = null;
}

function createBlindFold(owner) {
	blindfold.color = makePattern(blindfoldLargeIcon, this.playerList[owner].color);
	var int = setInterval(function () {
		clearInterval(int);
		blindfold.color = null;
	}, config.tileMap.abilities.blindfold.duration * 1000);
}

function rumbleScreen(time) {
	screenShake = true;
	setTimeout(function () {
		screenShake = false;
	}, time);
}

function setupEmojiWheel() {
	var menu = $("#emojiMenu");
	for (var i = 0; i < config.emojis.length; i++) {
		menu.append('<a onclick="closeEmojiWindow(this.innerHTML)" href="#">' + config.emojis[i] + '</a>');
	}
	emojiMenu.style.borderColor = playerList[myID].color;
}


class Trail {
	constructor(initialPosition) {
		this.vertices = [];
		this.maxLength = 10000;
	}
	update(currentPosition) {
		if (this.vertices.length > 0 &&
			currentPosition.x == this.vertices[this.vertices.length - 1].x &&
			currentPosition.y == this.vertices[this.vertices.length - 1].y) {
			return;
		}
		if (this.vertices.length > this.maxLength) {
			this.vertices.shift();
		}
		this.vertices.push(currentPosition);
	}
	reset(player) {
		this.vertices = [];
	}
}