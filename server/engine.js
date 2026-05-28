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
exports.bounceOffEmptyCells = function (player, map) {
	bounceOffEmptyCells(player, map);
}
exports.punchPlayer = function (player, punch) {
	punchPlayer(player, punch);
}
exports.reflectPunch = function (player, fromX, fromY, kick) {
	reflectPunch(player, fromX, fromY, kick);
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
			// Depleted stamina = a little sluggish: cut drive (and thus top speed) while
			// exhausted, until the bar recharges. This is the punch's commitment cost now
			// — holding to charge doesn't brake you (so you keep the momentum that powers
			// the hit), but emptying your bar on a big charge leaves you slow afterward.
			var driveMult = 1;
			if (player.staminaExhausted && c.punchStamina != null) {
				driveMult = c.punchStamina.exhaustedMoveFactor;
			}

			var newVelX, newVelY, newVel, newDirX, newDirY;
			newVelX = player.velX + (player.acel + player.getSpeedBonus()) * driveMult * dirX * this.dt;
			newVelY = player.velY + (player.acel + player.getSpeedBonus()) * driveMult * dirY * this.dt;

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
			if (hazard.rail == null) {
				hazard.velX = 0;
				hazard.velY = 0;
				continue;
			}
			// Confine the bumper to its rail PARAMETRICALLY: track how far along the
			// rail it sits (t in [0, length]) and step that single scalar, instead of
			// free 2-D integration with an after-the-fact clamp. The old approach only
			// clamped the FAR end radially, so a long tick — a lag spike, or the
			// server's sleep/wake re-arm, where dt can be seconds and the step grows as
			// speed·dt² — overshot the UN-clamped near end, mirrored across the origin,
			// and the far clamp then pinned it at -length where the reversal could never
			// fire again, freezing it off-rail. Clamping the scalar t to the segment
			// makes leaving the rail impossible for ANY dt. Reflect at both ends with
			// exact angle values (rail.angle / rail.angle-180) so a non-axis rail angle
			// can't drift out of the strict-equality direction check (prior freeze bug).
			var rad = hazard.rail.angle * (Math.PI / 180);
			var dirX = Math.cos(rad);
			var dirY = Math.sin(rad);
			var len = hazard.rail.width; // rail length (rail.lengthSq = width²)
			// Where the bumper is along the rail right now (project onto the axis).
			var t = (hazard.x - hazard.rail.x) * dirX + (hazard.y - hazard.rail.y) * dirY;
			var outward = (hazard.angle == hazard.rail.angle);
			// Same step magnitude as before (speed·dt², the prior double-dt integration).
			t += (outward ? 1 : -1) * hazard.speed * this.dt * this.dt;
			if (t >= len) {
				t = len;
				hazard.angle = hazard.rail.angle - 180;
			} else if (t <= 0) {
				t = 0;
				hazard.angle = hazard.rail.angle;
			}
			// Snap exactly onto the rail line — also sheds any perpendicular drift.
			hazard.newX = hazard.rail.x + dirX * t;
			hazard.newY = hazard.rail.y + dirY * t;
			hazard.velX = hazard.newX - hazard.x;
			hazard.velY = hazard.newY - hazard.y;
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
// Clash recoil: a flat velocity kick of magnitude `kick` directed from (fromX,fromY)
// toward the player (i.e. away from the rival they clashed with). Distance-independent
// — unlike punchPlayer's inverse-square falloff — so the backfire is predictable and
// scales only with the puncher's own momentum (caller passes reflectKick * bonus).
function reflectPunch(player, fromX, fromY, kick) {
	var dx = player.x - fromX;
	var dy = player.y - fromY;
	var d = utils.getMag(dx, dy);
	if (d == 0) {
		dx = utils.getRandomInt(-4, 4);
		dy = utils.getRandomInt(-4, 4);
		d = utils.getMag(dx, dy) || 1;
	}
	player.velX += (dx / d) * kick;
	player.velY += (dy / d) * kick;
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
	var xDist = object.x - x;
	var yDist = object.y - y;
	// Essentially overlapping (a radial punch on a stacked kart from a swap, an
	// explosion centered on a player, a cut on an overlapping victim). Pick a
	// random unit direction and floor distance at 1 — the old -4..4 integer
	// fallback was used as a MAGNITUDE rather than a direction, so distance=1
	// and xDist=4 produced velCont = forceConstant * 4, injecting ~20k velocity
	// from a single tap and launching the victim off-map.
	if (distance < 1) {
		var ang = Math.random() * Math.PI * 2;
		xDist = Math.cos(ang);
		yDist = Math.sin(ang);
		distance = 1;
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
function ensureCellIndex(map) {
	if (map._cellIndex == null) {
		Object.defineProperty(map, '_cellIndex', {
			value: new CellIndex(map.cells),
			enumerable: false,
			writable: true,
			configurable: true
		});
	}
	return map._cellIndex;
}
// Whether the map has ANY empty (hole) cells. Empty cells are authored in the map
// JSON and never created or destroyed at runtime (explosions/collapse skip them and
// nothing converts a tile *to* empty), so this is fixed for the map's life — cache it
// once so the per-tick bounce check on the common case (maps with no holes) is a single
// boolean test instead of a spatial-index lookup per player per tick.
function mapHasEmptyCells(map) {
	if (map._hasEmptyCells === undefined) {
		var has = false, cells = map.cells, eid = c.tileMap.empty.id;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id === eid) { has = true; break; }
		}
		Object.defineProperty(map, '_hasEmptyCells', { value: has, enumerable: false, writable: true, configurable: true });
	}
	return map._hasEmptyCells;
}
// The empty cell containing (x,y), or null. Empty cells are non-walkable holes
// that show the skybox/water below; locating one means that point is over a hole.
function emptyCellAt(x, y, map) {
	var candidates = ensureCellIndex(map).candidates(x, y);
	for (var i = 0; i < candidates.length; i++) {
		var cell = candidates[i];
		if (cell.id === c.tileMap.empty.id && pointIntersection(x, y, cell) > 0) {
			return cell;
		}
	}
	return null;
}
// Nearest non-empty (solid) cell to a point — the ground to steer a stranded player
// back toward. O(cells), but only runs when a player is actually inside a hole, which
// the rim bounce below normally prevents.
function nearestSolidCell(x, y, map) {
	var cells = map.cells, eid = c.tileMap.empty.id, best = Infinity, bestCell = null;
	for (var i = 0; i < cells.length; i++) {
		if (cells[i].id === eid) {
			continue;
		}
		var s = cells[i].site, dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
		if (d < best) { best = d; bestCell = cells[i]; }
	}
	return bestCell;
}
// Keep players out of empty holes the way the world edge stops them. Two cases:
//   1. On solid ground, projected move would enter a hole -> stop at the rim and
//      bounce back (reverse + damp), matching preventEscape's player-edge feel.
//   2. Already inside a hole (a hard punch/knockback flung the center past the rim,
//      or a spawn landed there) -> DON'T just reverse velocity; that oscillates and
//      bleeds energy, leaving the player stranded in the void. Redirect this tick's
//      step straight at the nearest solid ground and point their velocity that way,
//      so they consistently climb back out.
var EMPTY_BOUNCE_DAMP = 0.25;
function bounceOffEmptyCells(player, map) {
	if (!mapHasEmptyCells(map)) {
		return; // no holes on this map — skip the per-tick lookup entirely
	}
	if (emptyCellAt(player.x, player.y, map) != null) {
		// Case 2: stranded inside a hole — eject toward solid ground.
		var solid = nearestSolidCell(player.x, player.y, map);
		if (solid != null) {
			var ex = solid.site.x - player.x, ey = solid.site.y - player.y;
			var em = Math.sqrt(ex * ex + ey * ey);
			if (em > 1e-6) {
				var ux = ex / em, uy = ey / em;
				// Redirect this tick's already-integrated displacement toward solid
				// (same length, new heading) instead of letting it carry deeper. Cap
				// the step at the distance to the target so a big knockback step can't
				// overshoot the solid cell into a hole on its far side and zig-zag.
				var sx = player.newX - player.x, sy = player.newY - player.y;
				var step = Math.min(Math.sqrt(sx * sx + sy * sy), em);
				player.newX = player.x + ux * step;
				player.newY = player.y + uy * step;
				player.velX = ux * player.maxVelocity;
				player.velY = uy * player.maxVelocity;
			}
		}
		player.bounced = true;
		return;
	}
	if (emptyCellAt(player.newX, player.newY, map) == null) {
		return; // on solid ground and the projected move stays on solid ground
	}
	// Case 1: outside -> inside. Stop at the rim and bounce back.
	player.newX = player.x;
	player.newY = player.y;
	player.velX = -player.velX * EMPTY_BOUNCE_DAMP;
	player.velY = -player.velY * EMPTY_BOUNCE_DAMP;
	player.bounced = true;
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