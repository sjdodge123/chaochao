'use strict';
var utils = require('./utils.js');
var c = utils.loadConfig();

var listItem = null;
var player = null;
var proj = null;
var aimer = null;
var hazard = null;
var prop = null;

exports.sendPlayerUpdates = function (playerList) {
	var packet = [];
	for (prop in playerList) {
		player = playerList[prop];
		listItem = [
			player.id,
			player.x,
			player.y,
			player.velX,
			player.velY,
			player.angle,
			Math.round(player.stamina),
			Math.round((player.chargeFrac || 0) * 100),
			Math.round((player.overcharge || 0) * 100)
		];
		packet.push(listItem);
	}
	player = null;
	listItem = null;
	prop = null;
	return packet;
}
exports.sendProjUpdates = function (projectileList) {
	var packet = [];
	for (prop in projectileList) {
		proj = projectileList[prop];
		listItem = [
			proj.ownerId,
			proj.type,
			proj.x,
			proj.y
		];
		packet.push(listItem);
	}
	proj = null;
	listItem = null;
	prop = null;
	return packet;
}

exports.sendAimerUpdates = function (aimerList) {
	var packet = [];
	for (prop in aimerList) {
		aimer = aimerList[prop];
		listItem = [
			aimer.ownerId,
			aimer.targetListAry.join(','),
			aimer.radius,
			aimer.x,
			aimer.y
		];
		packet.push(listItem);
	}
	aimer = null;
	listItem = null;
	prop = null;
	return packet;
}

exports.sendHazardUpdates = function (hazardList) {
	var packet = [];
	for (prop in hazardList) {
		hazard = hazardList[prop];
		listItem = [
			hazard.ownerId,
			hazard.x,
			hazard.y
		];
		packet.push(listItem);
	}
	hazard = null;
	listItem = null;
	prop = null;
	return packet;
}

exports.sendNotchUpdates = function (playerList) {
	var packet = [];
	for (prop in playerList) {
		player = playerList[prop];
		listItem = [
			player.id,
			player.notches
		];
		packet.push(listItem);
	}
	packet = JSON.stringify(packet);
	player = null;
	listItem = null;
	prop = null;
	return packet;
}
exports.worldResize = function (world) {
	var packet = [];
	packet[0] = world.x;
	packet[1] = world.y;
	packet[2] = world.width;
	packet[3] = world.height;

	packet = JSON.stringify(packet);
	return packet;
}
exports.sendLobbyStart = function (lobbyStartButton, lobbyMapID) {
	var packet = [];
	packet[0] = lobbyStartButton.x;
	packet[1] = lobbyStartButton.y;
	packet[2] = lobbyStartButton.radius;
	packet[3] = lobbyStartButton.color;
	// [4] = id of the curated tutorial map to render in the lobby (null = plain lobby).
	packet[4] = (lobbyMapID != null) ? lobbyMapID : null;

	packet = JSON.stringify(packet);
	return packet;
}
// SPIKE (lobby hub): serialize the walk-up stations for client rendering. Static
// for the lobby's lifetime, so sent once on startLobby (not per tick). Each entry:
// [id, kind, x, y, radius, color].
exports.sendLobbyStations = function (stations) {
	var packet = [];
	if (stations != null) {
		for (var i = 0; i < stations.length; i++) {
			var s = stations[i];
			packet.push([s.stationId, s.stationKind, s.x, s.y, s.radius, s.color]);
		}
	}
	return JSON.stringify(packet);
}
exports.gameState = function (game) {
	var packet = [];
	packet[0] = game.currentState;
	if (game.currentState == game.stateMap.lobby) {
		packet[1] = game.gameBoard.lobbyStartButton.x;
		packet[2] = game.gameBoard.lobbyStartButton.y;
		packet[3] = game.gameBoard.lobbyStartButton.radius;
		packet[4] = game.gameBoard.lobbyStartButton.color;
	}
	if (game.currentState == game.stateMap.gated || game.currentState == game.stateMap.racing || game.currentState == game.stateMap.collapsing) {
		// One or two starting gates (opposite-edge maps have two). Each gate is
		// [x, y, width, height, edge]; width/height are true dimensions. The client
		// decoder in gameboard.js#checkGameState mirrors this shape (lockstep rule).
		var gates = game.gameBoard.startingGates || [];
		var gatePackets = [];
		for (var gi = 0; gi < gates.length; gi++) {
			var g = gates[gi];
			gatePackets.push([g.x, g.y, g.width, g.height, g.edge || "left"]);
		}
		packet[1] = gatePackets;
	}
	packet = JSON.stringify(packet);
	return packet;
}

exports.playerSpawns = function (playerList) {
	var packet = [];
	for (prop in playerList) {
		packet.push(newPlayerPacket(playerList[prop]));
	}
	packet = JSON.stringify(packet);
	player = null;
	listItem = null;
	prop = null;
	return packet;
}
exports.appendPlayer = function (player) {
	var packet = newPlayerPacket(player);
	packet = JSON.stringify(packet);
	player = null;
	listItem = null;
	prop = null;
	return packet;
}

function newPlayerPacket(player) {
	var packet = [];
	packet[0] = player.id;
	packet[1] = player.x;
	packet[2] = player.y;
	packet[3] = player.color;
	packet[4] = player.alive;
	packet[5] = player.notches;
	packet[6] = player.nearVictory;
	packet[7] = player.awake;
	packet[8] = player.onFire;
	packet[9] = player.angle;
	// Bot identity (null for human players, who stay nameless). Sent only in the
	// spawn/append packets, not every tick — name/title are static.
	packet[10] = player.name || null;
	packet[11] = player.title || null;
	// Avatar-skin URL (null unless the player opted into the avatar skin). Static
	// like name/title — spawn/append only, not per tick.
	packet[12] = player.avatarUrl || null;
	packet[13] = player.cartSkin || null;
	return packet;
}

exports.sendPunch = function (punch) {
	var packet = [];
	packet[0] = punch.ownerId;
	packet[1] = punch.x;
	packet[2] = punch.y;
	packet[3] = punch.color;
	packet[4] = punch.radius;
	packet[5] = punch.type;
	packet[6] = punch.getBonus();
	packet = JSON.stringify(packet);
	player = null;
	listItem = null;
	prop = null;
	return packet;
}
exports.sendClouds = function (clouds) {
	var packet = [];
	for (prop in clouds) {
		proj = clouds[prop];
		listItem = [
			proj.ownerId,
			proj.x,
			proj.y
		];
		packet.push(listItem);
	}
	packet = JSON.stringify(packet);
	proj = null;
	listItem = null;
	prop = null;
	return packet;
}
exports.newHazards = function (hazardList) {
	var packet = [];
	for (prop in hazardList) {
		hazard = hazardList[prop];
		listItem = [
			hazard.ownerId,
			hazard.id,
			hazard.x,
			hazard.y,
			hazard.angle
		];
		packet.push(listItem);
	}
	packet = JSON.stringify(packet);
	hazard = null;
	listItem = null;
	prop = null;
	return packet;
}