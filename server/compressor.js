'use strict';
var utils = require('./utils.js');
var c = utils.loadConfig();

var listItem = null;
var player = null;
var proj = null;
var aimer = null;
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
			player.angle
		];
		packet.push(listItem);
	}
	packet = JSON.stringify(packet);
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
	packet = JSON.stringify(packet);
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
	packet = JSON.stringify(packet);
	aimer = null;
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
exports.sendLobbyStart = function (lobbyStartButton) {
	var packet = [];
	packet[0] = lobbyStartButton.x;
	packet[1] = lobbyStartButton.y;
	packet[2] = lobbyStartButton.radius;
	packet[3] = lobbyStartButton.color;

	packet = JSON.stringify(packet);
	return packet;
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
		packet[1] = game.gameBoard.startingGate.x;
		packet[2] = game.gameBoard.startingGate.y;
		packet[3] = game.gameBoard.startingGate.width;
		packet[4] = game.gameBoard.startingGate.height;
	}
	packet = JSON.stringify(packet);
	return packet;
}

exports.playerSpawns = function (playerList) {
	var packet = [];
	for (prop in playerList) {
		player = playerList[prop];
		listItem = [
			player.id,
			player.x,
			player.y,
			player.color
			//player.weapon.angle,
			//player.weapon.name,
		];
		packet.push(listItem);
	}
	packet = JSON.stringify(packet);
	player = null;
	listItem = null;
	prop = null;
	return packet;
}
exports.appendPlayer = function (player) {
	var packet = [];
	packet[0] = player.id;
	packet[1] = player.x;
	packet[2] = player.y;
	packet[3] = player.color;
	//packet[4] = player.weapon.angle;
	//packet[5] = player.weapon.name;
	//packet[6] = player.weapon.level;
	//packet[7] = player.weapon.powerCost;
	packet = JSON.stringify(packet);
	player = null;
	listItem = null;
	prop = null;
	return packet;
}

exports.sendPunch = function (punch) {
	var packet = [];
	packet[0] = punch.ownerId;
	packet[1] = punch.x;
	packet[2] = punch.y;
	packet[3] = punch.color;
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