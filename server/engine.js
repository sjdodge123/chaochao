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
				var movingOutward = (hazard.angle == hazard.rail.angle);
				// Reverse at the far end only while heading outward, and at the
				// near end only while heading back. Guarding both ends keeps a
				// single overshoot (e.g. from a long tick) from flipping the
				// angle every frame and trapping the bumper jittering in place.
				if (movingOutward && currentDist > hazard.rail.lengthSq) {
					hazard.angle -= 180;
				} else if (!movingOutward && currentDist < hazard.lengthSq) {
					hazard.angle += 180;
				}

				newVelX = Math.cos((hazard.angle) * (Math.PI / 180)) * hazard.speed * this.dt;
				newVelY = Math.sin((hazard.angle) * (Math.PI / 180)) * hazard.speed * this.dt;
			}
			hazard.velX = newVelX;
			hazard.velY = newVelY;
			hazard.newX += hazard.velX * this.dt;
			hazard.newY += hazard.velY * this.dt;
			// Keep the bumper on its rail: if a long tick overshot the far end,
			// snap it back onto the segment instead of letting it drift away.
			if (hazard.rail != null) {
				var overshootSq = utils.getMagSq(hazard.rail.x, hazard.rail.y, hazard.newX, hazard.newY);
				if (overshootSq > hazard.rail.lengthSq) {
					var scale = Math.sqrt(hazard.rail.lengthSq / overshootSq);
					hazard.newX = hazard.rail.x + (hazard.newX - hazard.rail.x) * scale;
					hazard.newY = hazard.rail.y + (hazard.newY - hazard.rail.y) * scale;
					// Clamping pins the bumper exactly AT the far end, where the top-of-loop
					// reversal (currentDist > lengthSq, strict) can never fire again — so it
					// would re-clamp to the same spot every tick and freeze there. Turn it
					// around now if it was heading outward, so it heads back next tick.
					if (hazard.angle == hazard.rail.angle) {
						hazard.angle -= 180;
					}
				}
			}
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
			velCont.velContX = (forceConstant / (distance * distance)) * (object.x - x) / distance;
			velCont.velContY = (forceConstant / (distance * distance)) * (object.y - y) / distance;
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
	velCont.velContX = (forceConstant / (distance * distance)) * xDist / distance;
	velCont.velContY = (forceConstant / (distance * distance)) * yDist / distance;
	return velCont;
}

// Axis-aligned bounding box of a Voronoi cell from its halfedge vertices.
// `bounded` is false if any endpoint is missing/non-finite (an open or clipped
// cell): such a cell's bbox can't be trusted, so the index registers it in every
// bucket rather than risk a missed collision.
function cellExtents(cell) {
	var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	var bounded = true;
	var hes = cell.halfedges;
	for (var i = 0; i < hes.length; i++) {
		var edge = hes[i].edge;
		var pts = [edge.va, edge.vb];
		for (var p = 0; p < 2; p++) {
			var v = pts[p];
			if (v == null || !isFinite(v.x) || !isFinite(v.y)) {
				bounded = false;
				continue;
			}
			if (v.x < minX) minX = v.x;
			if (v.x > maxX) maxX = v.x;
			if (v.y < minY) minY = v.y;
			if (v.y > maxY) maxY = v.y;
		}
	}
	if (!isFinite(minX)) {
		bounded = false; // no usable vertices at all
	}
	return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, bounded: bounded };
}

// Uniform spatial grid over the map's cells. A cell is bucketed into every grid
// square its bounding box overlaps, so the square containing any query point is
// guaranteed to contain that point's cell. Geometry is static for a round (only
// cell.id mutates on tile changes), so the index is built once per map.
//
// Degenerate cells (an edge endpoint missing/non-finite, i.e. an open/unclipped
// cell) are excluded entirely: their bbox is untrustworthy AND pointIntersection
// would dereference the null vertex and throw. Excluding them yields "no tile in
// that region" rather than crashing the server tick — strictly safer than the
// original full scan, which fed every cell to pointIntersection. Real maps are
// fully clipped/closed, so no cell is ever excluded in practice.
class CellIndex {
	constructor(cells) {
		this.cells = cells;
		var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		var bounded = []; // {cell, ext} for usable cells only
		for (var i = 0; i < cells.length; i++) {
			var ext = cellExtents(cells[i]);
			if (!ext.bounded) {
				continue;
			}
			bounded.push({ cell: cells[i], ext: ext });
			if (ext.minX < minX) minX = ext.minX;
			if (ext.minY < minY) minY = ext.minY;
			if (ext.maxX > maxX) maxX = ext.maxX;
			if (ext.maxY > maxY) maxY = ext.maxY;
		}
		var w = maxX - minX;
		var h = maxY - minY;
		// No usable cells (empty or all-degenerate): one empty bucket, so queries
		// return nothing without crashing.
		if (bounded.length === 0 || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
			this.cols = 1;
			this.rows = 1;
			this.minX = 0;
			this.minY = 0;
			this.invW = 0;
			this.invH = 0;
			this.buckets = [[]];
			return;
		}
		// Aim for roughly one cell per bucket, preserving the map's aspect ratio.
		this.cols = Math.max(1, Math.round(Math.sqrt(bounded.length * (w / h))));
		this.rows = Math.max(1, Math.round(Math.sqrt(bounded.length * (h / w))));
		this.minX = minX;
		this.minY = minY;
		this.invW = this.cols / w;
		this.invH = this.rows / h;
		this.buckets = new Array(this.cols * this.rows);
		for (var b = 0; b < this.buckets.length; b++) {
			this.buckets[b] = [];
		}
		for (var j = 0; j < bounded.length; j++) {
			var e = bounded[j].ext;
			var c0 = this._col(e.minX), c1 = this._col(e.maxX);
			var r0 = this._row(e.minY), r1 = this._row(e.maxY);
			for (var r = r0; r <= r1; r++) {
				for (var col = c0; col <= c1; col++) {
					this.buckets[r * this.cols + col].push(bounded[j].cell);
				}
			}
		}
	}
	_col(x) {
		var c = Math.floor((x - this.minX) * this.invW);
		return c < 0 ? 0 : (c >= this.cols ? this.cols - 1 : c);
	}
	_row(y) {
		var r = Math.floor((y - this.minY) * this.invH);
		return r < 0 ? 0 : (r >= this.rows ? this.rows - 1 : r);
	}
	candidates(x, y) {
		return this.buckets[this._row(y) * this.cols + this._col(x)];
	}
}

function checkCollideCells(player, map) {
	if (map._cellIndex == null) {
		Object.defineProperty(map, '_cellIndex', {
			value: new CellIndex(map.cells),
			enumerable: false,
			writable: true,
			configurable: true
		});
	}
	var candidates = map._cellIndex.candidates(player.x, player.y);
	for (var i = 0; i < candidates.length; i++) {
		var cell = candidates[i];
		if (pointIntersection(player.x, player.y, cell) > 0) {
			var mapCell = locateCell(cell.id);
			mapCell.voronoiId = cell.site.voronoiId;
			mapCell.isMapCell = true;
			player.handleHit(mapCell);
			// Ability pickup is a check-then-act split across two tick phases: the
			// ability is acquired here (checkCollisions), but the tile isn't rewritten
			// to normal ground until updatePlayers' changeTile runs later this tick.
			// Two karts knocked onto the same ability tile in one tick would each
			// acquire from it before it's consumed — a duplication. Consume it the
			// instant it's claimed so any other player resolving this same cell this
			// tick sees plain ground. The deferred changeTile still runs (now a no-op
			// re-set) to broadcast the tile change and schedule the lobby respawn.
			if (player.acquiredAbility != null && player.acquiredAbility.mapID === cell.site.voronoiId) {
				cell.id = c.tileMap.normal.id;
			}
			return; // a point lies in exactly one Voronoi cell
		}
	}
	// No cell contains this point — it's outside the playable terrain (e.g. punched
	// back behind the starting gate). Reset grip to normal ground so the last tile's
	// physics (notably ice) doesn't persist there. Only players carry grip; snowFlake
	// projectiles also reach this path and have no resetGrip, so guard the call.
	if (typeof player.resetGrip === "function") {
		player.resetGrip();
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
// Precomputed id -> tile lookup, built once from the static config. Stores the
// same shared config object references locateCell used to return (so the
// caller's voronoiId/isMapCell mutation behaves exactly as before). Abilities
// are inserted last so they win on any id collision, matching the original
// "abilities checked first" precedence for ids > 99.
var tileIdMap = (function () {
	var map = {};
	for (var type in c.tileMap) {
		var tile = c.tileMap[type];
		if (tile != null && tile.id != null) {
			map[tile.id] = tile;
		}
	}
	for (var ability in c.tileMap.abilities) {
		var a = c.tileMap.abilities[ability];
		if (a != null && a.id != null) {
			map[a.id] = a;
		}
	}
	return map;
})();
function locateCell(id) {
	return tileIdMap[id];
}