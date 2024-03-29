"use strict";
var utils = require('./utils.js');
var c = utils.loadConfig();
var forceConstant = c.forceConstant;

exports.getEngine = function (playerList, projectileList, hazardList) {
	return new Engine(playerList, projectileList, hazardList);
}
exports.checkDistance = function (obj1, obj2) {
	return checkDistance(obj1, obj2);
}
exports.preventEscape = function (obj, bound) {
	preventEscape(obj, bound);
}
exports.bounceOffBoundry = function (obj, bound) {
	bounceOffBoundry(obj, bound);
}
exports.checkCollideCells = function (player, map) {
	checkCollideCells(player, map);
}
exports.punchPlayer = function (player, punch) {
	punchPlayer(player, punch);
}
exports.puckPlayer = function (puck, player) {
	puckPlayer(puck, player);
}
exports.punchPuck = function (puck, punch) {
	punchPuck(puck, punch);
}
exports.cutPlayer = function (player, cuttingPlayer, angle) {
	cutPlayer(player, cuttingPlayer, angle);
}
exports.checkFlipAroundWorld = function (proj, world) {
	checkFlipAroundWorld(proj, world);
}
exports.explosion = function (player, location, distance) {
	explosion(player, location, distance);
}

class Engine {
	constructor(playerList, projectileList, hazardList) {
		this.playerList = playerList;
		this.projectileList = projectileList;
		this.hazardList = hazardList;
		this.dt = 0;
		this.quadTree = null;
		this.worldWidth = 0;
		this.worldHeight = 0;
	}
	update(dt) {
		this.dt = dt;
		this.updateHazards();
		this.updateProjectiles();
		this.updatePlayers();
	}
	updatePlayers() {
		for (var playerSig in this.playerList) {
			var player = this.playerList[playerSig];
			if (player.alive == false) {
				continue;
			}
			var dirX = 0;
			var dirY = 0;
			var braking = false;
			if (player.isAI) {
				dirX = player.targetDirX * .8;
				dirY = player.targetDirY * .8;
				braking = player.braking;
			}
			else {
				if (player.moveForward && player.moveBackward == false && player.turnLeft == false && player.turnRight == false) {
					dirY = -1;
					dirX = 0;
				}
				else if (player.moveForward == false && player.moveBackward && player.turnLeft == false && player.turnRight == false) {
					dirY = 1;
					dirX = 0;
				}
				else if (player.moveForward == false && player.moveBackward == false && player.turnLeft && player.turnRight == false) {
					dirY = 0;
					dirX = -1;
				}
				else if (player.moveForward == false && player.moveBackward == false && player.turnLeft == false && player.turnRight) {
					dirY = 0;
					dirX = 1;
				}
				else if (player.moveForward && player.moveBackward == false && player.turnLeft && player.turnRight == false) {
					dirY = -Math.sqrt(2) / 2;
					dirX = -Math.sqrt(2) / 2;
				}
				else if (player.moveForward && player.moveBackward == false && player.turnLeft == false && player.turnRight) {
					dirY = -Math.sqrt(2) / 2;
					dirX = Math.sqrt(2) / 2;
				}
				else if (player.moveForward == false && player.moveBackward && player.turnLeft && player.turnRight == false) {
					dirY = Math.sqrt(2) / 2;
					dirX = -Math.sqrt(2) / 2;
				}
				else if (player.moveForward == false && player.moveBackward && player.turnLeft == false && player.turnRight) {
					dirY = Math.sqrt(2) / 2;
					dirX = Math.sqrt(2) / 2;
				}
				else {
					braking = true;
				}
			}
			var punchingSlowDown = 1;
			if (player.attack && player.ability == null) {
				punchingSlowDown = c.playerPunchSlowAmt;
			}

			var newVelX, newVelY, newVel, newDirX, newDirY;
			newVelX = punchingSlowDown * player.velX + (player.acel + player.getSpeedBonus()) * dirX * this.dt;
			newVelY = punchingSlowDown * player.velY + (player.acel + player.getSpeedBonus()) * dirY * this.dt;

			if (braking) {
				newVelX -= player.brakeCoeff * player.velX;
				newVelY -= player.brakeCoeff * player.velY;
			}
			else {
				newVelX -= player.dragCoeff * player.getDragBonus() * player.velX;
				newVelY -= player.dragCoeff * player.getDragBonus() * player.velY;
			}

			newVel = utils.getMag(newVelX, newVelY);

			newDirX = newVelX / newVel;
			newDirY = newVelY / newVel;
			if (newVel > player.maxVelocity) {
				player.velX = player.maxVelocity * newDirX;
				player.velY = player.maxVelocity * newDirY;
			}
			else {
				player.velX = newVelX;
				player.velY = newVelY;
			}
			player.newX += player.velX * this.dt;
			player.newY += player.velY * this.dt;
		}
	}
	updateProjectiles() {
		for (var id in this.projectileList) {
			var proj = this.projectileList[id];
			var newVelX = 0;
			var newVelY = 0;
			newVelX = Math.cos((proj.angle) * (Math.PI / 180)) * proj.speed * this.dt;
			newVelY = Math.sin((proj.angle) * (Math.PI / 180)) * proj.speed * this.dt;

			newVelX -= 0.25 * proj.velX;
			newVelY -= 0.25 * proj.velY;

			proj.velX = newVelX;
			proj.velY = newVelY;
			proj.newX += proj.velX * this.dt;
			proj.newY += proj.velY * this.dt;
		}
	}
	updateHazards() {
		for (var id in this.hazardList) {
			var hazard = this.hazardList[id];
			if (!hazard.moveable) {
				continue;
			}
			var newVelX = 0;
			var newVelY = 0;
			if (hazard.rail != null) {
				var currentDist = utils.getMagSq(hazard.rail.x, hazard.rail.y, hazard.x, hazard.y);
				if (currentDist > hazard.rail.lengthSq) {
					hazard.angle -= 180;
				}
				if (hazard.angle != hazard.rail.angle && currentDist < hazard.lengthSq) {
					hazard.angle += 180;
				}

				newVelX = Math.cos((hazard.angle) * (Math.PI / 180)) * hazard.speed * this.dt;
				newVelY = Math.sin((hazard.angle) * (Math.PI / 180)) * hazard.speed * this.dt;
			}
			hazard.velX = newVelX;
			hazard.velY = newVelY;
			hazard.newX += hazard.velX * this.dt;
			hazard.newY += hazard.velY * this.dt;
		}
	}

	broadBase(objectArray) {
		this.quadTree.clear();
		var collidingBeams = [];
		var beamList = [];
		for (var i = 0; i < objectArray.length; i++) {
			this.quadTree.insert(objectArray[i]);
		}
		for (var j = 0; j < objectArray.length; j++) {
			var obj1 = objectArray[j];
			var collisionList = [];
			collisionList = this.quadTree.retrieve(collisionList, obj1);
			this.narrowBase(obj1, collisionList);
		}
	}
	narrowBase(obj1, collisionList) {
		for (var i = 0; i < collisionList.length; i++) {
			var obj2 = collisionList[i];
			if (obj1 == obj2) {
				continue;
			}
			if (obj1.inBounds(obj2)) {
				obj1.handleHit(obj2);
				obj2.handleHit(obj1);
			}
		}
	}
	checkCollideAll(loc) {
		var result = false;
		var testLoc = { x: loc.x, y: loc.y, radius: loc.width };
		var objectArray = [];
		for (var playerSig in this.playerList) {
			objectArray.push(this.playerList[playerSig]);
		}
		for (var i = 0; i < objectArray.length; i++) {
			result = checkDistance(testLoc, objectArray[i]);
			if (result) {
				return true;
			}
		}
		return result;
	}
	_calcVelCont(distance, object, x, y, implode) {
		var velCont = { velContX: 0, velContY: 0 };
		if (implode == true) {
			velCont.velContX = -c.pulseForceMultiplier * forceConstant * (object.x - x);///distance;
			velCont.velContY = -c.pulseForceMultiplier * forceConstant * (object.y - y);///distance;
		} else {
			velCont.velContX = (forceConstant / Math.pow(distance, 2)) * (object.x - x) / distance;
			velCont.velContY = (forceConstant / Math.pow(distance, 2)) * (object.y - y) / distance;
		}
		return velCont;
	}
	setWorldBounds(width, height) {
		this.worldWidth = width;
		this.worldHeight = height;
		this.quadTree = new QuadTree(0, this.worldWidth, 0, this.worldHeight, c.quadTreeMaxDepth, c.quadTreeMaxCount, -1);
	}
}

class QuadTree {
	constructor(minX, maxX, minY, maxY, maxDepth, maxChildren, level) {
		this.maxDepth = maxDepth;
		this.maxChildren = maxChildren;
		this.minX = minX;
		this.maxX = maxX;
		this.minY = minY;
		this.maxY = maxY;
		this.width = maxX - minX;
		this.height = maxY - minY;
		this.level = level;
		this.nodes = [];
		this.objects = [];
	}
	clear() {
		this.objects = [];
		this.nodes = [];
	}
	splitNode() {
		var subWidth = Math.floor((this.width) / 2);
		var subHeight = Math.floor((this.height) / 2);

		this.nodes.push(new QuadTree(this.minX, this.minX + subWidth, this.minY, this.minY + subHeight, this.maxDepth, this.maxChildren, this.level + 1));
		this.nodes.push(new QuadTree(this.minX + subWidth, this.maxX, this.minY, this.minY + subHeight, this.maxDepth, this.maxChildren, this.level + 1));
		this.nodes.push(new QuadTree(this.minX, this.minX + subWidth, this.minY + subHeight, this.maxY, this.maxDepth, this.maxChildren, this.level + 1));
		this.nodes.push(new QuadTree(this.minX + subWidth, this.maxX, this.minY + subHeight, this.maxY, this.maxDepth, this.maxChildren, this.level + 1));
	}
	getIndex(obj) {
		var index = -1;
		var horizontalMidpoint = this.minX + this.width / 2;
		var verticalMidpoint = this.minY + this.height / 2;

		var extents = obj.getExtents();

		if (extents.minX > this.minX && extents.maxX < horizontalMidpoint) {
			var leftQuadrant = true;
		}
		if (extents.maxX < this.maxX && extents.minX > horizontalMidpoint) {
			var rightQuadrant = true;
		}

		if (extents.minY > this.minY && extents.maxY < verticalMidpoint) {
			if (leftQuadrant) {
				index = 0;
			}
			else if (rightQuadrant) {
				index = 1;
			}
		}
		else if (extents.maxY < this.maxY && extents.minY > verticalMidpoint) {
			if (leftQuadrant) {
				index = 2;
			}
			else if (rightQuadrant) {
				index = 3;
			}
		}
		return index;
	}

	insert(obj) {
		if (this.nodes[0] != null) {
			var index = this.getIndex(obj);
			if (index != -1) {
				this.nodes[index].insert(obj);

				return;
			}
		}
		this.objects.push(obj);

		if (this.objects.length > this.maxChildren && this.level < this.maxDepth) {
			if (this.nodes[0] == null) {
				this.splitNode();
			}

			var i = 0;
			while (i < this.objects.length) {
				var index = this.getIndex(this.objects[i]);
				if (index != -1) {
					this.nodes[index].insert(this.objects[i]);
					this.objects.splice(i, 1);
				}
				else {
					i++;
				}
			}
		}
	}
	retrieve(returnObjects, obj) {
		var index = this.getIndex(obj);
		if (index != -1 && this.nodes[0] != null) {
			this.nodes[index].retrieve(returnObjects, obj);
		}
		returnObjects.push.apply(returnObjects, this.objects);
		return returnObjects;
	}
}

function checkDistance(obj1, obj2) {
	var objX1 = obj1.newX || obj1.x;
	var objY1 = obj1.newY || obj1.y;
	var objX2 = obj2.newX || obj2.x;
	var objY2 = obj2.newY || obj2.y;
	var distance = utils.getMag(objX2 - objX1, objY2 - objY1);
	distance -= obj1.radius || obj1.height / 2;
	distance -= obj2.radius || obj2.height / 2;
	if (distance <= 0) {
		return true;
	}
	return false;
}

function preventMovement(obj, wall, dt) {
	var bx = wall.x - obj.x;
	var by = wall.y - obj.y;
	var bMag = utils.getMag(bx, by);
	var bxDir = bx / bMag;
	var byDir = by / bMag;
	var dot = bxDir * obj.velX + byDir * obj.velY;
	var ax = dot * bxDir;
	var ay = dot * byDir;
	obj.velX -= ax;
	obj.velY -= ay;
	obj.newX = obj.x + obj.velX * dt;
	obj.newY = obj.y + obj.velY * dt;
}

function slowDown(obj, dt, amt) {
	obj.velX = obj.velX * (1 - amt);
	obj.velY = obj.velY * (1 - amt);
	obj.newX = obj.x + obj.velX * dt;
	obj.newY = obj.y + obj.velY * dt;
}


function preventEscape(obj, bound) {
	if (obj.newX - obj.radius < bound.x) {
		obj.newX = obj.x;
		obj.velX = -obj.velX * 0.25;
	}
	if (obj.newX + obj.radius > bound.x + bound.width) {
		obj.newX = obj.x;
		obj.velX = -obj.velX * 0.25;
	}
	if (obj.newY - obj.radius < bound.y) {
		obj.newY = obj.y;
		obj.velY = -obj.velY * 0.25;
	}
	if (obj.newY + obj.radius > bound.y + bound.height) {
		obj.newY = obj.y;
		obj.velY = -obj.velY * 0.25;
	}
}
function bounceOffBoundry(obj, bound) {
	if (obj.newX - obj.radius < bound.x) {
		obj.newX = obj.x;
		obj.angle = 180 - obj.angle;
		obj.velX *= -3;
		obj.bounced = true;
	}
	if (obj.newX + obj.radius > bound.x + bound.width) {
		obj.newX = obj.x;
		obj.angle = 180 - obj.angle;
		obj.velX *= -3;
		obj.bounced = true;
	}
	if (obj.newY - obj.radius < bound.y) {
		obj.newY = obj.y;
		obj.angle *= -1;
		obj.velY *= -3;
		obj.bounced = true;
	}
	if (obj.newY + obj.radius > bound.y + bound.height) {
		obj.newY = obj.y;
		obj.angle *= -1;
		obj.velY *= -3;
		obj.bounced = true;
	}
}

function punchPlayer(player, punch) {
	var distance = utils.getMag(punch.x - player.x, punch.y - player.y);
	var velCont = _calcVelCont(distance, player, punch.x, punch.y);
	player.velX += velCont.velContX * punch.getBonus();
	player.velY += velCont.velContY * punch.getBonus();
}
function punchPuck(puck, punch) {
	var angle = utils.angle(punch.x, punch.y, puck.x, puck.y);
	puck.angle = angle;
	puck.speed *= c.brutalRounds.hockey.spikeSpeed;
}
function puckPlayer(puck, player) {
	var distance = utils.getMag(puck.x - player.x, puck.y - player.y);
	var velCont = _calcVelCont(distance, player, puck.x, puck.y);
	player.velX += velCont.velContX * c.brutalRounds.hockey.puckHitStrength;
	player.velY += velCont.velContY * c.brutalRounds.hockey.puckHitStrength;
}
function explosion(player, loc, dist) {
	var velCont = _calcVelCont(dist, player, loc.x, loc.y);
	player.velX += velCont.velContX * c.explosionStrength;
	player.velY += velCont.velContY * c.explosionStrength;
}

function checkFlipAroundWorld(proj, world) {
	if (proj.x - proj.radius > world.width) {
		proj.newX = world.x - proj.radius;
	}
	if (proj.y - proj.radius > world.height) {
		proj.newY = world.y - proj.radius;
	}
	if (proj.x + proj.radius < world.x) {
		proj.newX = world.width + proj.radius;
	}
	if (proj.y + proj.radius < world.y) {
		proj.newY = world.height + proj.radius;
	}
}
function cutPlayer(p2, p1, angle) {
	var cut = {};
	const distance = c.tileMap.abilities.cut.distance;
	const aimVector = { x: Math.cos(angle * (Math.PI / 180)), y: Math.sin(angle * (Math.PI / 180)) };
	const perpVector1 = { x: -aimVector.y, y: aimVector.x };
	const perpVector2 = { x: aimVector.y, y: -aimVector.x };
	const playerDifferenceVector = { x: p2.x - p1.x, y: p2.y - p1.y };
	const dotProduct = utils.dotProduct(playerDifferenceVector, perpVector1);
	if (dotProduct > 0) {
		cut = {
			x: p2.x + (distance * perpVector2.x),
			y: p2.y + (distance * perpVector2.y)
		};
	} else {
		cut = {
			x: p2.x + (distance * perpVector1.x),
			y: p2.y + (distance * perpVector1.y)
		};
	}
	const velCont = _calcVelCont(distance, p2, cut.x, cut.y);
	p2.velX += velCont.velContX;
	p2.velY += velCont.velContY;
}

function _calcVelCont(distance, object, x, y) {
	if (distance == 0) {
		distance = 1;
	}
	var xDist = object.x - x;
	var yDist = object.y - y;
	if (xDist == 0) {
		xDist = utils.getRandomInt(-4, 4);
	}
	if (yDist == 0) {
		yDist = utils.getRandomInt(-4, 4);
	}
	var velCont = { velContX: 0, velContY: 0 };
	velCont.velContX = (forceConstant / Math.pow(distance, 2)) * xDist / distance;
	velCont.velContY = (forceConstant / Math.pow(distance, 2)) * yDist / distance;
	return velCont;
}

function checkCollideCells(player, map) {
	var cells = map.cells,
		iCell = cells.length,
		cell;
	while (iCell--) {
		cell = cells[iCell];
		if (pointIntersection(player.x, player.y, cells[iCell]) > 0) {
			var mapCell = locateCell(cell.id);
			mapCell.voronoiId = cell.site.voronoiId;
			mapCell.isMapCell = true;
			player.handleHit(mapCell);
		}
	}
}
function pointIntersection(x, y, cell) {
	{
		var halfedges = cell.halfedges,
			iHalfedge = halfedges.length,
			halfedge,
			p0, p1, r;
		while (iHalfedge--) {
			halfedge = halfedges[iHalfedge];
			p0 = getStartpoint(halfedge);
			p1 = getEndpoint(halfedge);
			r = (y - p0.y) * (p1.x - p0.x) - (x - p0.x) * (p1.y - p0.y);

			if (!r) {
				return 0;
			}
			if (r > 0) {
				return -1;
			}
		}
		return 1;
	};
}
function getStartpoint(halfedge) {
	if (compareSite(halfedge.edge.lSite, halfedge.site)) {
		return halfedge.edge.va;
	}
	return halfedge.edge.vb;
}
function getEndpoint(halfedge) {
	if (compareSite(halfedge.edge.lSite, halfedge.site)) {
		return halfedge.edge.vb;
	}
	return halfedge.edge.va;
}
function compareSite(siteA, siteB) {
	if (siteA.voronoiId != siteB.voronoiId) {
		return false;
	}
	if (siteA.x != siteB.x) {
		return false;
	}
	if (siteA.y != siteB.y) {
		return false;
	}
	return true;
}
function locateCell(id) {
	if (id > 99) {
		for (var ability in c.tileMap.abilities) {
			if (id == c.tileMap.abilities[ability].id) {
				return c.tileMap.abilities[ability];
			}
		}
	}
	for (var type in c.tileMap) {
		if (id == c.tileMap[type].id) {
			return c.tileMap[type];
		}
	}
}