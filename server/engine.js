"use strict";
var utils = require('./utils.js');
var geometry = require('./geometry.js');
var c = utils.loadConfig();
var forceConstant = c.forceConstant;
// Shared segment geometry (also used by cellGraph for bot pathing).
var segmentsCross = geometry.segmentsCross;
// Tile ids the stone-seam wall depends on (constant) — hoisted so the seam-active
// test is a stable function, not a per-call closure.
var STONE_WATER_ID = (c.tileMap.water != null) ? c.tileMap.water.id : -999;
var STONE_LAVA_ID = c.tileMap.lava.id;
function stoneEdgeActive(e) {
	// The seam is only a wall while it's still water beside lava; a terrain change
	// (collapse, ice-cannon freeze, lava explosion) drops it.
	return e.waterCell.id === STONE_WATER_ID && e.lavaCell.id === STONE_LAVA_ID;
}
// Slide a player along the first segment in `edges` their step this tick crosses:
// keep only the component ALONG the segment (drop the perpendicular), the same
// deflection the hole-rim slide gives. A corner guard refuses to commit a slid
// position that would cross another (still-active) segment, holding at the pre-step
// position so a corner can't tunnel through. `isActive` (optional) filters edges
// that are currently walls (stone seams re-validate live cell ids; barriers are
// always active). Shared by bounceOffStoneEdges + bounceOffBarriers.
function slideAlongSegmentWalls(player, edges, isActive) {
	for (var i = 0; i < edges.length; i++) {
		var e = edges[i];
		if (isActive && !isActive(e)) { continue; }
		if (!segmentsCross(player.x, player.y, player.newX, player.newY, e.ax, e.ay, e.bx, e.by)) { continue; }
		var sx = player.newX - player.x, sy = player.newY - player.y;
		var sProj = sx * e.tanX + sy * e.tanY;
		var vProj = player.velX * e.tanX + player.velY * e.tanY;
		var slidX = player.x + sProj * e.tanX;
		var slidY = player.y + sProj * e.tanY;
		player.velX = vProj * e.tanX;
		player.velY = vProj * e.tanY;
		var crossesAgain = false;
		for (var j = 0; j < edges.length; j++) {
			var f = edges[j];
			if (isActive && !isActive(f)) { continue; }
			if (segmentsCross(player.x, player.y, slidX, slidY, f.ax, f.ay, f.bx, f.by)) { crossesAgain = true; break; }
		}
		if (!crossesAgain) {
			player.newX = slidX;
			player.newY = slidY;
		} else {
			player.newX = player.x;
			player.newY = player.y;
		}
		player.bounced = true;
		return;
	}
}

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
exports.bounceOffSegment = function (obj, seg, restitution) {
	bounceOffSegment(obj, seg, restitution);
}
exports.checkCollideCells = function (player, map) {
	checkCollideCells(player, map);
}
exports.bounceOffStoneEdges = function (player, map) {
	bounceOffStoneEdges(player, map);
}
exports.bounceOffBarriers = function (player, map) {
	bounceOffBarriers(player, map);
}
exports.barrierCrossing = function (x1, y1, x2, y2, map) {
	return barrierCrossing(x1, y1, x2, y2, map);
}
exports.rebuildStoneEdges = function (map) {
	rebuildStoneEdges(map);
}
exports.bounceZombieOffWater = function (player, map) {
	bounceZombieOffWater(player, map);
}
// Block ANY entity (not just zombies) from entering water — used by the antlion
// round so the creatures can't walk over water (a moat/island is a hard barrier,
// the same way water is a no-go for zombies). Reuses the shared rim-slide so the
// entity glides along the shore instead of dead-stopping. No-op on maps without
// water. The entity needs x/y, newX/newY, velX/velY and maxVelocity (the stranded-
// inside eject reads it).
exports.bounceEntityOffWater = function (entity, map) {
	if (c.tileMap.water == null) { return; }
	bounceOffNoGoCells(entity, map, c.tileMap.water.id);
}
exports.bounceOffEmptyCells = function (player, map) {
	bounceOffEmptyCells(player, map);
}
// Locked-door barrier: a door's home cell carries tileMap.door.id until its key
// unlocks it, and behaves as a no-go wall for ALL players (same rim slide/bounce as
// an empty hole). Once unlocked the cell flips to normal and this no longer matches.
exports.bounceOffLockedDoors = function (player, map) {
	bounceOffNoGoCells(player, map, c.tileMap.door.id);
}
// The live cell whose polygon contains (x,y), regardless of tile id (shared spatial
// index). Used at map-init to find a door/key entity's home cell, and per-tick to
// decide whether a loose key is sitting on lava. Null if the point is off the map.
exports.cellAtPoint = function (x, y, map) {
	var candidates = ensureCellIndex(map).candidates(x, y);
	for (var i = 0; i < candidates.length; i++) {
		if (pointIntersection(x, y, candidates[i]) > 0) {
			return candidates[i];
		}
	}
	return null;
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
// Whether (x,y) sits on a cell of tile id `id` (live cell ids, shared spatial
// index). Used by the antlion round for the creatures' own sand-leash check —
// antlions are hazards, not players, so they never get a handleMapCellHit stamp.
exports.isOnCellOfType = function (x, y, map, id) {
	return cellOfTypeAt(x, y, map, id) != null;
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
			// "Dripping wet": for a beat after climbing out of water, drive is cut so the
			// kart trudges before regaining traction (dripUntil stamped on the player when
			// it leaves water). Stacks multiplicatively with the exhausted penalty.
			if (player.dripUntil && Date.now() < player.dripUntil && c.tileMap.water != null) {
				driveMult *= c.tileMap.water.dripMoveFactor;
			}

			// Momentum ramp (human players only): hold a steady heading and your drive
			// force climbs from `floor` to full over rampTime seconds; cut hard the other
			// way (or stop) and it dumps back to the floor. Makes starts and hard turns a
			// touch slower and rewards committing to a line — at full ramp it's a no-op,
			// so the old top speed stays the cap.
			//
			// Bots are exempt: they steer with a continuously-jittering pathfinding
			// heading and were tuned around full thrust, so the floor traps them on slow
			// terrain and the hard-turn reset pins them at the floor — they freeze against
			// walls instead of powering out (measured via ai-fitness). A bot keeps the old
			// physics (momentum stays 1 → factor 1).
			var ramp = c.momentumRamp;
			if (ramp != null && !player.isAI) {
				if (braking) {
					player.momentum = 0;
					player.lastMoveDirX = 0;
					player.lastMoveDirY = 0;
				}
				else {
					var moveMag = utils.getMag(dirX, dirY);
					var ndx = moveMag > 0 ? dirX / moveMag : 0;
					var ndy = moveMag > 0 ? dirY / moveMag : 0;
					var hadHeading = player.lastMoveDirX !== 0 || player.lastMoveDirY !== 0;
					var dot = ndx * player.lastMoveDirX + ndy * player.lastMoveDirY;
					// Only dump momentum on a hard turn if you're actually carrying speed —
					// a near-stationary kart (starting up, or pinned/wiggling against a wall)
					// keeps building so it can power out instead of stalling at the floor.
					var carryingSpeed = utils.getMag(player.velX, player.velY) > ramp.resetSpeedMin;
					if (hadHeading && dot < ramp.resetDot && carryingSpeed) {
						// turned hard enough at speed to break momentum
						player.momentum = 0;
					}
					else {
						player.momentum = Math.min(1, player.momentum + this.dt / ramp.rampTime);
					}
					player.lastMoveDirX = ndx;
					player.lastMoveDirY = ndy;
				}
			}
			var momentumFactor = (ramp != null && !player.isAI) ? player.getMomentumFactor() : 1;

			var newVelX, newVelY, newVel, newDirX, newDirY;
			newVelX = player.velX + (player.acel + player.getSpeedBonus()) * driveMult * momentumFactor * dirX * this.dt;
			newVelY = player.velY + (player.acel + player.getSpeedBonus()) * driveMult * momentumFactor * dirY * this.dt;

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
			// Self-propelled kinds own their motion (e.g. the rotor's orbit). They
			// get the tick dt here — the hazard's own update()/move() (called later
			// in gameBoard.updateHazards) commits the newX/newY they set.
			if (typeof hazard.advance === "function") {
				hazard.advance(this.dt);
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

// Bounce a player off a solid Laser Gate — the rotated-segment counterpart to
// bounceOffBoundry (which only reflects off the AXIS-ALIGNED world box). The seg
// is a thin barrier on the segment (seg.ax,seg.ay)->(seg.bx,seg.by); when
// it's solid a kart can't cross it. Like bounceOffBoundry we (1) cancel this tick's
// move so the kart never tunnels through, (2) reflect the velocity component normal
// to the seg (with restitution; tangential slip is kept so a kart slides ALONG the
// barrier instead of sticking), and (3) eject the kart just clear of the beam so it
// never rests inside a barrier that solidified on top of it. Non-lethal by design —
// a timed passability gate, not a kill zone (see hazards.js LaserGate).
function bounceOffSegment(obj, seg, restitution) {
	var ex = seg.bx - seg.ax, ey = seg.by - seg.ay;
	var len = Math.sqrt(ex * ex + ey * ey);
	if (len < 1e-6) { return; }
	var nx = -ey / len, ny = ex / len; // unit normal to the seg line
	// Which side of the line the kart sits on BEFORE this tick's move (pre-integration
	// x/y) — the safe side to send it back to.
	var side = (obj.x - seg.ax) * nx + (obj.y - seg.ay) * ny;
	var sgn = side >= 0 ? 1 : -1;
	// Cancel the crossing move (mirrors bounceOffBoundry's newX = x), then reflect the
	// inward normal velocity so the kart rebounds; keep the tangential part (slide).
	obj.newX = obj.x;
	obj.newY = obj.y;
	var vn = obj.velX * nx + obj.velY * ny;
	var e = (restitution != null) ? restitution : 1;
	if (vn * sgn < 0) { // moving INTO the barrier
		obj.velX -= (1 + e) * vn * nx;
		obj.velY -= (1 + e) * vn * ny;
	}
	// Eject to the safe side if the kart's body still overlaps the solid beam (it
	// solidified while the kart straddled the line) so it can't sit pinned inside.
	var clear = (seg.height || 0) / 2 + (obj.radius || 0) + 1;
	var need = clear - Math.abs(side);
	if (need > 0) {
		obj.newX = obj.x + sgn * nx * need;
		obj.newY = obj.y + sgn * ny * need;
	}
	obj.bounced = true;
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
// Whether the map has ANY cell of tile id `id`. Used by the no-go-cell bounces (empty
// holes; water, which is a hole to zombies). The answer is effectively fixed for the
// map's life — empty cells are never created/destroyed, and water only ever turns TO
// lava during a collapse (never the reverse) — so cache it per id so the common
// "map has none" case is a single boolean test instead of a spatial-index lookup per
// player per tick.
function mapHasCellOfType(map, id) {
	if (map._hasCellOfType === undefined) {
		Object.defineProperty(map, '_hasCellOfType', { value: {}, enumerable: false, writable: true, configurable: true });
	}
	if (map._hasCellOfType[id] === undefined) {
		var has = false, cells = map.cells;
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].id === id) { has = true; break; }
		}
		map._hasCellOfType[id] = has;
	}
	return map._hasCellOfType[id];
}
// The cell of tile id `id` containing (x,y), or null.
function cellOfTypeAt(x, y, map, id) {
	var candidates = ensureCellIndex(map).candidates(x, y);
	for (var i = 0; i < candidates.length; i++) {
		var cell = candidates[i];
		if (cell.id === id && pointIntersection(x, y, cell) > 0) {
			return cell;
		}
	}
	return null;
}
// Nearest cell whose id ISN'T `id` — the ground to steer a stranded player back toward.
// O(cells), but only runs when a player is actually inside a no-go cell, which the rim
// bounce below normally prevents.
function nearestCellNotOfType(x, y, map, id) {
	var cells = map.cells, best = Infinity, bestCell = null;
	for (var i = 0; i < cells.length; i++) {
		if (cells[i].id === id) {
			continue;
		}
		var s = cells[i].site, dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
		if (d < best) { best = d; bestCell = cells[i]; }
	}
	return bestCell;
}
// Keep players out of "no-go" cells of tile id `noGoId` the way the world edge stops
// them. Two cases:
//   1. On safe ground, projected move would enter a no-go cell -> slide along its border
//      edge: project the move/velocity onto the nearest edge's tangent, so the kart
//      deflects AROUND the cell (even pushing straight in) instead of dead-stopping.
//   2. Already inside one (a hard punch/knockback flung the center past the rim, or a
//      spawn landed there, or — for zombie/water — a survivor swimming there just got
//      infected) -> DON'T just reverse velocity; that oscillates and bleeds energy,
//      leaving them stranded. Redirect this tick's step straight at the nearest safe
//      cell and point their velocity that way, so they consistently climb back out.
function bounceOffNoGoCells(player, map, noGoId) {
	if (!mapHasCellOfType(map, noGoId)) {
		return; // no such cells on this map — skip the per-tick lookup entirely
	}
	if (cellOfTypeAt(player.x, player.y, map, noGoId) != null) {
		// Case 2: stranded inside — eject toward safe ground.
		var solid = nearestCellNotOfType(player.x, player.y, map, noGoId);
		if (solid != null) {
			var ex = solid.site.x - player.x, ey = solid.site.y - player.y;
			var em = Math.sqrt(ex * ex + ey * ey);
			if (em > 1e-6) {
				var ux = ex / em, uy = ey / em;
				// Redirect this tick's already-integrated displacement toward safe
				// (same length, new heading) instead of letting it carry deeper. Cap
				// the step at the distance to the target so a big knockback step can't
				// overshoot the safe cell into a no-go cell on its far side and zig-zag.
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
	if (cellOfTypeAt(player.newX, player.newY, map, noGoId) == null) {
		return; // on safe ground and the projected move stays on safe ground
	}
	// Case 1: outside -> inside. Slide ALONG the no-go cell's actual border edge so the
	// kart deflects around it even when pushing straight in (not a dead-stop). Find the
	// polygon edge nearest the kart, then project both the intended step and the velocity
	// onto that edge's tangent — the parallel component survives, the into-rim one drops.
	var hole = cellOfTypeAt(player.newX, player.newY, map, noGoId);
	var hes = hole.halfedges;
	var bestD2 = Infinity, tanX = 0, tanY = 0, foundEdge = false;
	for (var hi = 0; hi < hes.length; hi++) {
		var a = getStartpoint(hes[hi]);
		var b = getEndpoint(hes[hi]);
		var ex = b.x - a.x, ey = b.y - a.y;
		var elen2 = ex * ex + ey * ey;
		if (elen2 < 1e-9) { continue; }
		// Closest point on segment a-b to the kart, then its distance.
		var tt = ((player.x - a.x) * ex + (player.y - a.y) * ey) / elen2;
		if (tt < 0) { tt = 0; } else if (tt > 1) { tt = 1; }
		var ddx = player.x - (a.x + tt * ex), ddy = player.y - (a.y + tt * ey);
		var d2 = ddx * ddx + ddy * ddy;
		if (d2 < bestD2) {
			bestD2 = d2;
			var el = Math.sqrt(elen2);
			tanX = ex / el; tanY = ey / el;
			foundEdge = true;
		}
	}
	if (foundEdge) {
		var sx = player.newX - player.x, sy = player.newY - player.y;
		var sProj = sx * tanX + sy * tanY;            // intended motion along the rim
		var vProj = player.velX * tanX + player.velY * tanY;
		var slidX = player.x + sProj * tanX;
		var slidY = player.y + sProj * tanY;
		// Keep the tangential velocity either way so the glide carries into the next tick;
		// only commit the slid position if it stays out of the no-go cell (corner guard).
		player.velX = vProj * tanX;
		player.velY = vProj * tanY;
		if (cellOfTypeAt(slidX, slidY, map, noGoId) == null) {
			player.newX = slidX;
			player.newY = slidY;
		} else {
			player.newX = player.x;
			player.newY = player.y;
		}
	} else {
		// Degenerate cell with no usable edge — just hold position.
		player.newX = player.x;
		player.newY = player.y;
		player.velX = 0;
		player.velY = 0;
	}
	player.bounced = true;
}
// Empty holes block ALL players.
function bounceOffEmptyCells(player, map) {
	bounceOffNoGoCells(player, map, c.tileMap.empty.id);
}
// Water is a hole to ZOMBIES specifically: they can't punch-to-swim (their bite is a
// separate, swim-less path), so rather than let them wade in uselessly, water behaves
// for them exactly like an empty cell — they bounce off its rim and can't enter at all.
// Survivors swim freely; this is a per-tick zombie-only no-go bounce. No-op off
// infection rounds (nothing is a zombie) and on maps with no water.
function bounceZombieOffWater(player, map) {
	if (!player.isZombie || c.tileMap.water == null) { return; }
	bounceOffNoGoCells(player, map, c.tileMap.water.id);
}
// Precompute the map's "stone edges": the Voronoi boundary segments where a water
// cell touches a lava cell. Authored lava only (computed once, cached) — at runtime
// the collapse turns the whole map to lava AND converts the water cell itself, so a
// later lava change never needs a fresh stone edge. Each entry caches the segment
// endpoints plus its unit tangent for the slide projection. Mirrors the _cellIndex /
// _hasEmptyCells caching pattern (non-enumerable, computed lazily, fixed for the map).
function ensureStoneEdges(map) {
	if (map._stoneEdges === undefined) {
		var edges = [];
		var cells = map.cells, waterId = c.tileMap.water != null ? c.tileMap.water.id : -999, lavaId = c.tileMap.lava.id;
		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];
			if (cell.id !== waterId) { continue; }
			var hes = cell.halfedges;
			for (var h = 0; h < hes.length; h++) {
				var edge = hes[h].edge;
				// The neighbour site across this halfedge is whichever of lSite/rSite
				// isn't this cell's own site. A null neighbour = diagram boundary (no
				// cell beyond), never lava.
				var neighbour = compareSite(edge.lSite, hes[h].site) ? edge.rSite : edge.lSite;
				if (neighbour == null) { continue; }
				// Find the neighbour cell so we can both check its (authored) tile id now
				// and KEEP the reference — cell.id mutates in place when terrain changes
				// (collapse, ice cannon, lava explosions), so holding both cells lets the
				// per-tick test re-validate the seam against their LIVE ids instead of
				// trusting the build-time snapshot (which would leave stale invisible walls
				// where the water has since become ice/lava). See the guard in
				// bounceOffStoneEdges.
				var nCell = null;
				for (var k = 0; k < cells.length; k++) {
					if (cells[k].site.voronoiId === neighbour.voronoiId) { nCell = cells[k]; break; }
				}
				if (nCell == null || nCell.id !== lavaId) { continue; }
				var a = getStartpoint(hes[h]), b = getEndpoint(hes[h]);
				var ex = b.x - a.x, ey = b.y - a.y, el = Math.sqrt(ex * ex + ey * ey);
				if (el < 1e-9) { continue; }
				edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, tanX: ex / el, tanY: ey / el, waterCell: cell, lavaCell: nCell });
			}
		}
		Object.defineProperty(map, '_stoneEdges', { value: edges, enumerable: false, writable: true, configurable: true });
	}
	return map._stoneEdges;
}
function mapHasStoneEdges(map) {
	return ensureStoneEdges(map).length > 0;
}
// Drop the compute-once stone-edge cache so the next ensureStoneEdges rebuilds it from
// the cells' LIVE ids. ensureStoneEdges only walls water/lava seams that existed when
// the map was first scanned; an ability that MANUFACTURES new water/lava adjacencies at
// runtime (Orbital Beam: ice->water crossing sand->lava) must call this so the fresh
// seams get walled. Cheap and rare (an occasional ability fire, never per tick). The
// _stoneEdges property was defined writable, so reassigning undefined re-arms the lazy build.
function rebuildStoneEdges(map) {
	if (map == null) { return; }
	map._stoneEdges = undefined;
	// Terrain types just changed (water/lava created — Orbital Beam, Heatwave). The
	// per-id "does this map have any cell of type X" cache (mapHasCellOfType) is
	// otherwise never invalidated, so a no-go barrier that early-outs on "no water
	// here" (the zombie/antlion water block) would stay disabled after water is made
	// mid-round. Reset it so the next query rebuilds from the live cell ids.
	map._hasCellOfType = undefined;
	ensureStoneEdges(map);
}
// Solid stone wall on the water/lava boundary: a player whose move this tick would
// cross a stone edge is slid along it (the perpendicular component is dropped), the
// same deflection bounceOffEmptyCells gives a hole rim — so water is fully walkable
// EXCEPT you can't step from it into the bordering lava. Only the water/lava seam is
// walled; lava bordering plain terrain still kills as usual (this tests the actual
// step segment crossing the seam, not mere proximity to lava).
function bounceOffStoneEdges(player, map) {
	if (!mapHasStoneEdges(map)) {
		return; // no water/lava seams on this map — skip the per-tick test entirely
	}
	// Only the still-live water|lava seams are walls (stoneEdgeActive re-validates
	// against current cell ids each tick).
	slideAlongSegmentWalls(player, map._stoneEdges, stoneEdgeActive);
}
// Author-placed solid barriers (the editor's fence/wall 2-point tool): each map
// barrier is a {x1,y1,x2,y2} line segment a player can't pass through but slides
// along, EXACTLY like the water/lava stone seam above. Unlike stone edges these
// are static geometry (no live cell re-validation needed) and block crossing from
// EITHER side. Precomputed once per map into a non-enumerable cache so the
// per-tick test is a handful of segment crossings.
function ensureBarrierEdges(map) {
	if (map._barrierEdges === undefined) {
		var edges = [];
		var list = map.barriers;
		if (Array.isArray(list)) {
			for (var i = 0; i < list.length; i++) {
				var b = list[i];
				if (b == null) { continue; }
				var ax = b.x1, ay = b.y1, bx = b.x2, by = b.y2;
				if (!isFinite(ax) || !isFinite(ay) || !isFinite(bx) || !isFinite(by)) { continue; }
				var ex = bx - ax, ey = by - ay;
				var el = Math.sqrt(ex * ex + ey * ey);
				if (el < 1e-9) { continue; } // zero-length segment can't wall anything
				edges.push({ ax: ax, ay: ay, bx: bx, by: by, tanX: ex / el, tanY: ey / el });
			}
		}
		Object.defineProperty(map, '_barrierEdges', { value: edges, enumerable: false, writable: true, configurable: true });
	}
	return map._barrierEdges;
}
function mapHasBarriers(map) {
	return ensureBarrierEdges(map).length > 0;
}
// The first point where the segment (x1,y1)->(x2,y2) crosses a map barrier (a
// wall/fence), or null if it crosses none. Players slide along barriers
// (bounceOffBarriers); this is the straight-line test used to BLOCK the sentry
// turret's line-of-sight + its shot on a barrier (a wall shields whoever's behind it).
function barrierCrossing(x1, y1, x2, y2, map) {
	if (map == null) { return null; }
	var edges = ensureBarrierEdges(map);
	if (edges.length === 0) { return null; }
	var best = null, bestT = Infinity;
	for (var i = 0; i < edges.length; i++) {
		var e = edges[i];
		var hit = geometry.segmentIntersectionPoint(x1, y1, x2, y2, e.ax, e.ay, e.bx, e.by);
		if (hit != null && hit.t < bestT) { bestT = hit.t; best = { x: hit.x, y: hit.y }; }
	}
	return best;
}
function bounceOffBarriers(player, map) {
	if (!mapHasBarriers(map)) {
		return; // no barriers on this map — skip the per-tick test entirely
	}
	// Barriers are static, always-active walls (no live re-validation) — slide the
	// same way the water/lava seam does, blocking crossing from either side.
	slideAlongSegmentWalls(player, map._barrierEdges, null);
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