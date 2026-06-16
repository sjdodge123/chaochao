'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();
var { Rect, Circle } = require('./shapes.js');
var { Punch } = require('./punch.js');
// cellGraph is already loaded (utils requires it above); reuse its warpTransitMs as the
// SINGLE source of the distance->transit formula so the AI cost, the par estimate, and the
// runtime transit can never drift apart.
var cellGraph = require('../cellGraph.js');

// --- shared rotated-rect + segment geometry -----------------------------------
// One home for the math the rotated-rect hazards (bumper wall, laser gate, crusher)
// would otherwise each re-implement.
// Corners of a thin rect ANCHORED at (x,y), extending `width` along `angle` with
// `height` thickness (the bumper-wall / laser-gate shape). The base Rect treats
// width/height as far-corner coords, which only works for an axis-aligned,
// origin-anchored rect — hence the override.
function anchoredRectVertices(x, y, width, height, angle) {
	var rad = (angle || 0) * (Math.PI / 180);
	var dx = Math.cos(rad), dy = Math.sin(rad);
	var nx = -dy * (height / 2), ny = dx * (height / 2);
	var bx = x + dx * width, by = y + dy * width;
	return [
		{ x: x + nx, y: y + ny },
		{ x: bx + nx, y: by + ny },
		{ x: bx - nx, y: by - ny },
		{ x: x - nx, y: y - ny }
	];
}
// AABB covering EVERY vertex (base Rect.getExtents skips the last one — a length-1
// loop — which drops a corner from the quadtree box for a rotated rect).
function aabbFromVertices(vertices) {
	var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (var i = 0; i < vertices.length; i++) {
		var v = vertices[i];
		if (v.x < minX) { minX = v.x; }
		if (v.x > maxX) { maxX = v.x; }
		if (v.y < minY) { minY = v.y; }
		if (v.y > maxY) { maxY = v.y; }
	}
	return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
}
// Nearest point on segment (ax,ay)->(bx,by) to (px,py).
function closestPointOnSegment(px, py, ax, ay, bx, by) {
	var abx = bx - ax, aby = by - ay;
	var len2 = abx * abx + aby * aby;
	if (len2 < 1e-6) { return { x: ax, y: ay }; }
	var t = ((px - ax) * abx + (py - ay) * aby) / len2;
	if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
	return { x: ax + abx * t, y: ay + aby * t };
}

class HazardRail extends Rect {
	constructor(x, y, width, height, angle, color, ownerId, roomSig) {
		super(x, y, width, height, angle, color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.lengthSq = this.width * this.width;
	}
	update() {
		if (this.alive == false) {
			return;
		}
	}
	handleHit(object) {
		console.log("hazard rail hit");
	}
}

class Hazard extends Circle {
	constructor(x, y, radius, color, ownerId, roomSig, rail) {
		super(x, y, radius, color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.moveable = false;
		this.id = -1;
		this.speed = 0;
		this.angle = 0;
		this.lengthSq = this.radius * radius;
		if (rail != null) {
			this.moveable = true;
			this.rail = rail;
		}
	}
	update() {
		if (this.alive == false) {
			return;
		}
		this.move();
	}
	move() {
		this.x = this.newX;
		this.y = this.newY;
	}
	handleHit(object) {

	}
}
class Bumper extends Hazard {
	constructor(x, y, radius, color, ownerId, roomSig, rail) {
		super(x, y, radius, color, ownerId, roomSig, rail);
		this.id = c.hazards.bumper.id;
		if (this.rail != null) {
			this.speed = c.hazards.movingBumper.speed;
			this.id = c.hazards.movingBumper.id;
			this.angle = this.rail.angle;
		}
		this.punch = null;
	}
	// Lightning brutal round speeds moving hazards up; for a (railed) bumper that
	// means scaling its along-rail speed. Static bumpers have speed 0, so this is a
	// harmless no-op for them. See gameBoard.generateHazards.
	scaleSpeed(mod) {
		this.speed *= mod;
	}
	handleHit(object) {
		if (!object.isPlayer && !object.isPuck) {
			return;
		}
		if (this.punch == null) {
			this.punch = new Punch(this.x, this.y, c.hazards.bumper.attackRadius, c.hazards.bumper.color, this.ownerId, this.roomSig, c.hazards.bumper.punchBonus, false, null);
			this.punch.mapOwned = true;
			this.punch.type = "bumper";
		}
	}
}

// A pinball slingshot wall: a static, rotated line segment that flings players
// (and pucks) away on contact via the same map-owned punch machinery the round
// bumpers use. The punch spawns at the nearest point on the wall's centerline to
// the victim, so the shove reads as a perpendicular kick off the face (and a
// radial one off the end caps). No `radius` property on purpose — Shape.inBounds
// dispatches on it, and a radius here would make players collide with the wall
// as a circle instead of the rotated rect.
class BumperWall extends Rect {
	constructor(x, y, width, height, angle, color, ownerId, roomSig) {
		super(x, y, width, height, angle, color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.moveable = false;
		this.isWall = true;
		this.id = c.hazards.bumperWall.id;
		this.speed = 0;
		this.punch = null;
		// Centerline endpoints (anchor -> anchor + width along angle), consumed by
		// handleHit and the AI's repulsion field / path penalties.
		var rad = (this.angle || 0) * (Math.PI / 180);
		this.ax = this.x;
		this.ay = this.y;
		this.bx = this.x + Math.cos(rad) * this.width;
		this.by = this.y + Math.sin(rad) * this.width;
	}
	// Anchored rotated rect (called by the Rect constructor, so it reads only
	// x/y/width/height/angle). getExtents covers all 4 corners (base Rect drops one).
	getVertices() {
		return anchoredRectVertices(this.x, this.y, this.width, this.height, this.angle);
	}
	getExtents() {
		return aabbFromVertices(this.vertices);
	}
	closestOnLine(px, py) {
		return closestPointOnSegment(px, py, this.ax, this.ay, this.bx, this.by);
	}
	update() {
		if (this.alive == false) {
			return;
		}
	}
	handleHit(object) {
		if (!object.isPlayer && !object.isPuck) {
			return;
		}
		if (this.punch == null) {
			var hit = this.closestOnLine(object.newX || object.x, object.newY || object.y);
			this.punch = new Punch(hit.x, hit.y, c.hazards.bumperWall.attackRadius, c.hazards.bumperWall.color, this.ownerId, this.roomSig, c.hazards.bumperWall.punchBonus, false, null);
			this.punch.mapOwned = true;
			this.punch.type = "bumper";
		}
	}
}

// A rotor: a bumper head that orbits a fixed pivot at a constant angular speed,
// sweeping a circle like a clock hand. Flings karts/pucks off the head via the
// same map-owned punch the round bumpers use. The map entry's (x,y) is the
// PIVOT and `angle` is the starting sweep angle; the head rides `orbitRadius`
// out along the current angle. Motion lives in advance(dt) (the engine's
// per-tick hook — it has dt; the hazard's own update()/move() just commits the
// computed newX/newY). streamAngle ships the live sweep angle each tick so the
// client can draw the arm + head and smooth the rotation. First consumer of the
// framework's streamAngle wire slot.
class Rotor extends Hazard {
	constructor(x, y, radius, color, ownerId, roomSig, angle) {
		super(x, y, radius, color, ownerId, roomSig);
		this.id = c.hazards.rotor.id;
		this.moveable = true;       // engine.updateHazards drives advance(dt)
		this.streamAngle = true;    // ship .angle per tick (compressor.sendHazardUpdates)
		this.isRotor = true;        // AI classifies the swept ring (aiController)
		this.px = x;                // pivot (the map anchor) — fixed for the round
		this.py = y;
		this.orbitRadius = c.hazards.rotor.orbitRadius;
		this.angularSpeed = c.hazards.rotor.angularSpeed; // degrees/second
		// Sanitize the optional start angle: the kind is non-directional so
		// validateMap doesn't enforce a finite angle, and `angle || 0` would let a
		// crafted Infinity through (truthy) into Math.cos/sin -> NaN coordinates.
		this.angle = Number.isFinite(angle) ? angle : 0; // current sweep angle (degrees)
		this.punch = null;
		// Seed the head onto the orbit so creation (newHazards) and the first tick
		// agree — no one-frame jump from pivot to head.
		var rad = this.angle * (Math.PI / 180);
		this.x = this.newX = this.px + Math.cos(rad) * this.orbitRadius;
		this.y = this.newY = this.py + Math.sin(rad) * this.orbitRadius;
	}
	// Per-tick motion hook (engine.updateHazards). Advance the sweep angle and
	// place the head on the orbit; move() (called later in gameBoard.updateHazards)
	// commits newX/newY, mirroring how rail bumpers separate compute from commit.
	// Lightning brutal round speeds moving hazards up; a rotor moves via its sweep
	// rate, so scale that (it has no along-rail speed). See generateHazards.
	scaleSpeed(mod) {
		this.angularSpeed *= mod;
	}
	advance(dt) {
		this.angle += this.angularSpeed * dt;
		if (this.angle >= 360) { this.angle -= 360; } else if (this.angle < 0) { this.angle += 360; }
		var rad = this.angle * (Math.PI / 180);
		this.newX = this.px + Math.cos(rad) * this.orbitRadius;
		this.newY = this.py + Math.sin(rad) * this.orbitRadius;
		this.velX = this.newX - this.x;
		this.velY = this.newY - this.y;
	}
	handleHit(object) {
		if (!object.isPlayer && !object.isPuck) {
			return;
		}
		if (this.punch == null) {
			this.punch = new Punch(this.x, this.y, c.hazards.rotor.attackRadius, c.hazards.rotor.color, this.ownerId, this.roomSig, c.hazards.rotor.punchBonus, false, null);
			this.punch.mapOwned = true;
			this.punch.type = "bumper";
		}
	}
}

// A geyser: a stationary vent that cycles dormant -> charging (a telegraph) ->
// erupt, launching anyone on or near it with a strong radial punch, then back to
// dormant. Harmless to touch between eruptions — the only damage is the timed
// burst, so the telegraph is your cue to clear off. The cycle runs on a phase
// timer in update(dt) (stationary, so it has no motion hook); the phase is shipped
// to the client via the framework's netState wire slot so it can draw the calm /
// bubbling / erupting states. First consumer of netState.
//
// Phases (also the netState values): 0 dormant, 1 charging, 2 erupting.
var GEYSER_DORMANT = 0, GEYSER_CHARGING = 1, GEYSER_ERUPTING = 2;
class Geyser extends Hazard {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color, ownerId, roomSig);
		this.id = c.hazards.geyser.id;
		this.moveable = false;      // stationary — no engine motion hook
		this.punch = null;
		this.phase = GEYSER_DORMANT;
		this.netState = GEYSER_DORMANT; // shipped each tick (compressor.sendHazardUpdates)
		this.timer = 0;             // seconds elapsed in the current phase
	}
	// Phase timer (called per tick from gameBoard.updateHazards with dt). On the
	// charging->erupting edge it spawns one strong map-owned punch at the vent;
	// gameBoard.updateHazards picks it up, so anyone within attackRadius is flung.
	update(dt) {
		if (this.alive === false) {
			return;
		}
		this.timer += (dt || 0);
		if (this.phase === GEYSER_DORMANT) {
			if (this.timer >= c.hazards.geyser.dormantMs / 1000) {
				this.phase = GEYSER_CHARGING;
				this.timer = 0;
			}
		} else if (this.phase === GEYSER_CHARGING) {
			if (this.timer >= c.hazards.geyser.chargeMs / 1000) {
				this.phase = GEYSER_ERUPTING;
				this.timer = 0;
				if (this.punch == null) {
					this.punch = new Punch(this.x, this.y, c.hazards.geyser.attackRadius, c.hazards.geyser.color, this.ownerId, this.roomSig, c.hazards.geyser.punchBonus, false, null);
					this.punch.mapOwned = true;
					this.punch.type = "bumper";
				}
			}
		} else { // GEYSER_ERUPTING
			if (this.timer >= c.hazards.geyser.eruptMs / 1000) {
				this.phase = GEYSER_DORMANT;
				this.timer = 0;
			}
		}
		this.netState = this.phase;
	}
	// Touch is harmless — the eruption is the timed punch, not contact.
	handleHit(object) { }
}

// A proximity mine: armed and quiet until a kart strays within its trigger radius
// (the collision radius), then it lights a short fuse and detonates with a strong
// radial map-owned punch that flings the whole nearby pack — the leader trips it,
// the chasers eat it. One-shot: spent after it blows (the first anti-draft trap).
// The phase rides the netState wire (armed -> fuse -> spent) so the client can
// draw the idle light, the blinking countdown, and the spent crater.
//
// Phases (also the netState values): 0 armed, 1 fuse, 2 spent.
var MINE_ARMED = 0, MINE_FUSE = 1, MINE_SPENT = 2;
class Mine extends Hazard {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color, ownerId, roomSig);
		this.id = c.hazards.mine.id;
		this.moveable = false;
		this.punch = null;
		this.phase = MINE_ARMED;
		this.netState = MINE_ARMED;
		this.timer = 0;
	}
	// Proximity trip: a kart entering the trigger radius (this hazard's collision
	// circle) lights the fuse. Only the first trip matters — fuse/spent ignore it.
	handleHit(object) {
		if (this.phase !== MINE_ARMED || !object.isPlayer) {
			return;
		}
		this.phase = MINE_FUSE;
		this.netState = MINE_FUSE;
		this.timer = 0;
	}
	// Fuse timer (per tick from gameBoard.updateHazards). When it burns down the
	// mine spawns one strong map-owned punch at its center and goes spent (alive
	// false) — gameBoard.updateHazards still emits the punch that same tick.
	update(dt) {
		if (this.phase !== MINE_FUSE) {
			return;
		}
		this.timer += (dt || 0);
		if (this.timer >= c.hazards.mine.fuseMs / 1000) {
			if (this.punch == null) {
				this.punch = new Punch(this.x, this.y, c.hazards.mine.attackRadius, c.hazards.mine.color, this.ownerId, this.roomSig, c.hazards.mine.punchBonus, false, null);
				this.punch.mapOwned = true;
				this.punch.type = "bumper";
			}
			this.phase = MINE_SPENT;
			this.netState = MINE_SPENT;
			this.alive = false; // one-shot — inert crater for the rest of the round
		}
	}
}

// A vortex well: a circular PULL ZONE that drags karts toward the core — the
// anti-bumper. The framework's first "force field" hazard: a continuous inward
// pull applied ONCE PER TICK by gameBoard.updateHazards (a dedicated force-zone
// pass over the player list), NOT via handleHit — the collision system calls
// handleHit up to twice per overlapping pair, which would double (and
// non-deterministically vary) the force. The pull
// profile is a CALM EYE: zero at the dead centre, rising to a peak in a mid-ring,
// falling back to zero at the rim (a parabola, peak `force` at half-radius). That
// shape is what makes the well escapable instead of a roach motel — you build speed
// in the quiet centre and punch out through the ring — while still drawing a
// crawling kart inward and bending a fast kart's line (carry speed to slingshot
// past). `force` is tuned below the kart's own thrust so driving always wins; the
// danger is the well dragging you toward lava / off the racing line, not trapping
// you. Often parked over lava or off-line. The map entry's (x,y) is the core;
// `radius` the pull reach — authored PER INSTANCE in the editor (drag-to-resize),
// clamped server-side to [minRadius, radius] from config so a crafted map can't
// ship a giant well. coreRadius (the calm-eye / drawn centre) scales with the
// instance radius so a small well still reads right. See vortexWellRadius().
class VortexWell extends Hazard {
	constructor(x, y, radius, color, ownerId, roomSig) {
		super(x, y, radius, color, ownerId, roomSig);
		this.id = c.hazards.vortexWell.id;
		this.moveable = false;      // stationary — no engine motion hook
		this.forceZone = true;      // gameBoard.updateHazards applies applyForce once/tick
		this.isVortex = true;       // AI routes around the core (aiController classifier)
		this.sizable = true;        // ship per-instance radius on the wire (compressor.newHazards [8])
		this.coreRadius = c.hazards.vortexWell.coreRadius * (radius / c.hazards.vortexWell.radius);
		this.force = c.hazards.vortexWell.force;
	}
	update() {
		if (this.alive == false) { return; }
	}
	// Force zone (called once per tick from gameBoard.updateHazards for EVERY player;
	// self-filters by distance). Pull the victim toward the core with the calm-eye
	// parabola: strength = force·4·r·(1−r) where r = dist/radius (0 at centre & rim,
	// peak `force` at r=0.5). Fixed per-tick increment (not dt-scaled), drag-bounded,
	// maxVelocity-capped. Skips protected/star-power/finished/dead karts. Returns
	// true if the pull was applied (for tests).
	applyForce(object) {
		if (!object.isPlayer || object.alive === false || object.reachedGoal) { return false; }
		if ((object.isProtected && object.isProtected()) || (object.hasStarPower && object.hasStarPower())) { return false; }
		var ox = object.newX != null ? object.newX : object.x;
		var oy = object.newY != null ? object.newY : object.y;
		var dx = this.x - ox, dy = this.y - oy;
		var dist = Math.sqrt(dx * dx + dy * dy);
		if (dist > this.radius || dist < 0.0001) { return false; } // past the rim / dead centre: no pull
		var r = dist / this.radius;
		var pull = this.force * 4 * r * (1 - r);  // calm eye: 0 at centre & rim, peak at r=0.5
		object.velX += (dx / dist) * pull;
		object.velY += (dy / dist) * pull;
		return true;
	}
	handleHit(object) { } // force is applied in gameBoard.updateHazards, not on contact
}
// Resolve a vortex well's per-instance radius from its map entry: clamp the
// authored value to [minRadius, radius] (config = the editor's drag bounds) so a
// crafted/legacy map can't ship an over-sized well; a missing/non-finite value
// (legacy entries, tests) falls back to the DEFAULT — the midpoint of the range,
// matching the size the editor places a fresh well at.
function vortexWellRadius(entry) {
	var cfg = c.hazards.vortexWell;
	var min = cfg.minRadius, max = cfg.radius;
	var r = (entry != null && Number.isFinite(entry.radius)) ? entry.radius : (min + max) / 2;
	if (r < min) { r = min; } else if (r > max) { r = max; }
	return r;
}

// A laser gate: a laser barrier strung between two pylons that cycles on a
// published rhythm — OPEN (passable) -> WARN (a shimmer telegraph, still passable)
// -> SOLID (a wall you can't cross) -> back to OPEN. The framework's first TIMED
// PASSABILITY GATE: collision turns on and off, so a kart only physically interacts
// with it while it's solid. SOLID = a non-lethal BOUNCE (engine.bounceOffSegment, the
// rotated-segment cousin of bounceOffBoundry) rather than a lava-style burn: the
// stated primitive is a passability gate, a bounce is recoverable, and a hidden-timing
// DEATH from being shoved into a lit beam reads unfair — so the gate blocks, it
// doesn't kill (place it over/near lava if you want the danger). Directional (the
// barrier runs along the pylon axis). A thin rotated Rect like the bumper wall (so the
// kart collides with the BEAM, not a disc); the phase runs on a timer in update(dt)
// and ships on the framework's netState wire slot (like the geyser). `blocking`
// (warn|solid) is the AI's cue to hold off crossing; only SOLID actually collides.
//
// Phases (also the netState values): 0 open, 1 warn, 2 solid.
var GATE_OPEN = 0, GATE_WARN = 1, GATE_SOLID = 2;
class LaserGate extends Rect {
	constructor(x, y, angle, ownerId, roomSig) {
		super(x, y, c.hazards.laserGate.width, c.hazards.laserGate.height, angle, c.hazards.laserGate.color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.moveable = false;      // stationary — no engine motion hook
		this.isLaserGate = true;        // AI classifies the beam line (aiController)
		this.id = c.hazards.laserGate.id;
		this.speed = 0;
		this.phase = GATE_OPEN;
		this.netState = GATE_OPEN; // shipped each tick (compressor.sendHazardUpdates)
		this.blocking = false;      // warn|solid — AI steers clear (set in update)
		this.timer = 0;             // seconds elapsed in the current phase
		// Beam endpoints (anchor -> anchor + width along angle), consumed by handleHit
		// (the bounce line) and the AI's repulsion field / path penalties — the same
		// centerline contract the bumper wall exposes.
		var rad = (this.angle || 0) * (Math.PI / 180);
		this.ax = this.x;
		this.ay = this.y;
		this.bx = this.x + Math.cos(rad) * this.width;
		this.by = this.y + Math.sin(rad) * this.width;
	}
	// Anchored rotated rect — same shape as the bumper wall (shared helpers).
	getVertices() {
		return anchoredRectVertices(this.x, this.y, this.width, this.height, this.angle);
	}
	getExtents() {
		return aabbFromVertices(this.vertices);
	}
	// Phase timer (per tick from gameBoard.updateHazards with dt). Walks the cycle and
	// publishes the phase as netState; `blocking` flags warn+solid for the AI.
	update(dt) {
		if (this.alive === false) { return; }
		this.timer += (dt || 0);
		if (this.phase === GATE_OPEN) {
			if (this.timer >= c.hazards.laserGate.openMs / 1000) { this.phase = GATE_WARN; this.timer = 0; }
		} else if (this.phase === GATE_WARN) {
			if (this.timer >= c.hazards.laserGate.warnMs / 1000) { this.phase = GATE_SOLID; this.timer = 0; }
		} else { // GATE_SOLID
			if (this.timer >= c.hazards.laserGate.solidMs / 1000) { this.phase = GATE_OPEN; this.timer = 0; }
		}
		this.netState = this.phase;
		this.blocking = (this.phase !== GATE_OPEN);
	}
	// Solid beam = a bounce; open/warn are passable (no-op). Racers only (pucks,
	// antlions and other hazards pass through). The bounce reverts the crossing and
	// reflects the kart off the beam line (engine.bounceOffSegment).
	handleHit(object) {
		if (this.phase !== GATE_SOLID || !object.isPlayer || object.alive === false) { return; }
		require('../engine.js').bounceOffSegment(object, this, c.hazards.laserGate.restitution);
	}
}

// A crusher: a heavy slab that slides back and forth across a corridor on a rail —
// a Thwomp. It rides the SAME parametric rail the moving bumper does, but owns its
// motion via advance(dt) (so the slab keeps its fixed broadside orientation instead
// of the rail code flipping `angle` to track direction). The slab is a rotated rect
// CENTERED on the rail position, broadside to the rail (its flat face plows along the
// slide axis) — collided against with the bumper wall's rotated-rect machinery.
// Contact mid-rail is a hard directional SHOVE (a map-owned punch, like the bumper
// wall); but the slab slamming home in the outer pinch zone — caught between the
// crusher face and the boundary the author parks the far rail end against — is a
// lethal PINCH. The map entry's (x,y) is the rail anchor (the slab's retracted rest)
// and `angle` the slide direction. Static slab orientation, so it streams only its
// rail position (3-field rows) — no streamAngle; the client derives the broadside
// from the rail angle in the creation row. AI times the gap for free: it's railed
// (h.moveable && h.rail), so aiController's moving-bumper rail-crossing logic and the
// railCells (mild/timeable) path penalty already apply.
class Crusher extends Rect {
	constructor(x, y, rail, ownerId, roomSig) {
		// Slab broadside to the rail: its long axis (width) is perpendicular to the
		// slide. Base Rect builds vertices from x/y/width/height/angle, but we override
		// getVertices to center the slab on (x,y) — so seed x/y as the rail anchor.
		super(x, y, c.hazards.crusher.width, c.hazards.crusher.height, (rail.angle + 90), c.hazards.crusher.color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.moveable = true;       // advance(dt) drives it (engine.updateHazards)
		this.isCrusher = true;
		this.id = c.hazards.crusher.id;
		this.rail = rail;           // slide path (railed kind: ships rail origin/angle)
		this.railLength = rail.width;
		this.speed = c.hazards.crusher.speed;
		this.dir = 1;               // +1 toward the far (boundary) end, -1 retracting
		this.t = 0;                 // distance along the rail (0 = anchor/rest)
		this.punch = null;
		// Whether the slam end is a LETHAL pinch. Default false (shove-only): only a far
		// rail end that actually abuts a wall (world edge / empty-hole cell) or lava
		// crushes — so a kill always reads as "pinned against something", never an
		// invisible insta-kill in open ground. Set by resolveMapContext at map load.
		this.lethalEnd = false;
		// Slab orientation (perpendicular to the rail) is fixed for the round; cache the
		// unit vectors and seed the centerline at the rest position.
		var rad = this.angle * (Math.PI / 180);
		this.slabDirX = Math.cos(rad); this.slabDirY = Math.sin(rad); // along the slab length
		this.railDirX = Math.cos(rail.angle * (Math.PI / 180));
		this.railDirY = Math.sin(rail.angle * (Math.PI / 180));
		this.x = this.newX = rail.x; this.y = this.newY = rail.y;
		this.refreshGeometry();
	}
	// Centered rotated-rect corners (the slab straddles its center; the base Rect /
	// bumper wall anchor at one END). Built from newX/newY — the position the slab is
	// MOVING TO this tick — so the collision pass (engine.broadBase runs after
	// advance() but before move() commits x/y) tests the slab where it will be, exactly
	// like players (Circle.testRect reads newX/newY). At construction newX==x.
	getVertices() {
		var hw = this.width / 2, hh = this.height / 2;
		var dx = this.slabDirX, dy = this.slabDirY;   // along length
		var nx = -dy, ny = dx;                          // across thickness
		var cx = (this.newX != null) ? this.newX : this.x, cy = (this.newY != null) ? this.newY : this.y;
		return [
			{ x: cx - dx * hw - nx * hh, y: cy - dy * hw - ny * hh },
			{ x: cx + dx * hw - nx * hh, y: cy + dy * hw - ny * hh },
			{ x: cx + dx * hw + nx * hh, y: cy + dy * hw + ny * hh },
			{ x: cx - dx * hw + nx * hh, y: cy - dy * hw + ny * hh }
		];
	}
	getExtents() {
		return aabbFromVertices(this.vertices);
	}
	// Slab centerline (the long axis through the center) — the shove pushes a kart
	// perpendicular off the nearest point on it, i.e. along the slide axis. Built from
	// newX/newY to match getVertices (the slab's about-to-commit position).
	refreshGeometry() {
		var hw = this.width / 2;
		var cx = (this.newX != null) ? this.newX : this.x, cy = (this.newY != null) ? this.newY : this.y;
		this.ax = cx - this.slabDirX * hw; this.ay = cy - this.slabDirY * hw;
		this.bx = cx + this.slabDirX * hw; this.by = cy + this.slabDirY * hw;
		this.vertices = this.getVertices();
	}
	closestOnLine(px, py) {
		return closestPointOnSegment(px, py, this.ax, this.ay, this.bx, this.by);
	}
	// Lightning speeds moving hazards up — scale the along-rail speed (like the rail
	// bumper). See gameBoard.generateHazards.
	scaleSpeed(mod) { this.speed *= mod; }
	// Decide whether the slam end is a LETHAL pinch (called once at map load from
	// gameBoard.generateHazards, which has the live map + world). The end crushes ONLY
	// when something solid backs it: the world boundary, an empty/hole "wall" cell, or
	// lava — probed just past the slab's leading face at the full-extension end, across
	// the slab width. Otherwise the crusher only shoves (no arbitrary open-ground kill).
	resolveMapContext(map, world) {
		this.lethalEnd = false;
		if (map == null) { return; }
		var lavaId = c.tileMap.lava.id;
		var emptyId = (c.tileMap.empty != null) ? c.tileMap.empty.id : -99999;
		var wx = (world && world.x != null) ? world.x : 0;
		var wy = (world && world.y != null) ? world.y : 0;
		var ww = (world && world.width != null) ? world.width : c.worldWidth;
		var wh = (world && world.height != null) ? world.height : c.worldHeight;
		var endX = this.rail.x + this.railDirX * this.railLength;
		var endY = this.rail.y + this.railDirY * this.railLength;
		var perpX = -this.railDirY, perpY = this.railDirX;     // across the slab face
		var ahead = this.height / 2 + 20;                       // just past the leading face
		var halfW = this.width / 2;
		var engine = require('../engine.js');
		for (var s = -1; s <= 1; s++) {
			var ox = endX + perpX * (s * halfW * 0.7);
			var oy = endY + perpY * (s * halfW * 0.7);
			var ax = ox + this.railDirX * ahead;
			var ay = oy + this.railDirY * ahead;
			if (ax < wx || ax > wx + ww || ay < wy || ay > wy + wh) { this.lethalEnd = true; return; }
			if (engine.isOnCellOfType(ax, ay, map, lavaId) || engine.isOnCellOfType(ax, ay, map, emptyId)) { this.lethalEnd = true; return; }
		}
	}
	// Per-tick motion (engine.updateHazards). Step the rail param parametrically and
	// reflect at the ends — the same overshoot-proof scheme the rail bumper uses
	// (clamp the scalar t, not a 2-D position), so a long tick can't fling the slab
	// off its rail. move() (gameBoard.updateHazards) commits newX/newY afterward.
	advance(dt) {
		this.t += this.dir * this.speed * dt * dt;
		if (this.t >= this.railLength) { this.t = this.railLength; this.dir = -1; }
		else if (this.t <= 0) { this.t = 0; this.dir = 1; }
		this.newX = this.rail.x + this.railDirX * this.t;
		this.newY = this.rail.y + this.railDirY * this.t;
		this.velX = this.newX - this.x;
		this.velY = this.newY - this.y;
		// Refresh the collider to the new position NOW — engine.broadBase (checkCollisions)
		// runs after this and before move() commits x/y, so the slab must already present
		// its swept position or it would collide one tick behind.
		this.refreshGeometry();
	}
	// Commit the rail step. advance() already refreshed the collider to newX/newY
	// (which now equal x/y), so no second refreshGeometry is needed here.
	move() {
		this.x = this.newX; this.y = this.newY;
	}
	update() {
		if (this.alive === false) { return; }
		this.move();
	}
	// Contact. Star-power / freshly-spawned-invuln karts are untouchable (the universal
	// applyExplosionForce policy the vortex follows). Slamming home in the outer pinch
	// zone (moving outward) CRUSHES — but only when the end is wall/lava-backed
	// (lethalEnd, set at map load); otherwise, and anywhere else along the rail, it's a
	// hard shove that flings the kart along the slide axis (escapable). Idempotent under
	// the engine's up-to-twice handleHit-per-pair: killSelf no-ops once dead, the punch
	// is guarded by punch==null.
	handleHit(object) {
		if (!object.isPlayer || object.alive === false) { return; }
		if (object.isProtected && object.isProtected()) { return; }
		if (object.hasStarPower && object.hasStarPower()) { return; }
		if (this.lethalEnd && this.dir > 0 && this.t >= this.railLength * c.hazards.crusher.pinchFraction) {
			object.killSelf("crush");
			return;
		}
		if (this.punch == null) {
			var hit = this.closestOnLine(object.newX != null ? object.newX : object.x, object.newY != null ? object.newY : object.y);
			this.punch = new Punch(hit.x, hit.y, c.hazards.crusher.attackRadius, c.hazards.crusher.color, this.ownerId, this.roomSig, c.hazards.crusher.punchBonus, false, null);
			this.punch.mapOwned = true;
			this.punch.type = "bumper";
		}
	}
}

// A sentry turret: a stationary emplacement that tracks the nearest racer inside its
// firing arc and lobs an aimed shot every cooldown. The FIRST projectile-emitting map
// element — every prior hazard hit via the Punch/force machinery on contact; this one
// fires a real projectile (a TurretShot) that rides the iceCannon ability's
// projectile wire (see entities/projectiles.js + gameBoard.fireTurret). The shot
// SHOVES (knockback), it does NOT freeze terrain like an iceCannon — an auto-firing
// turret reusing the freeze would runaway-ice the arena (rationale on TurretShot).
//
// Two state layers ride the framework wires: the live barrel facing on `streamAngle`
// (like the rotor) and the phase on `netState` (like the geyser). Directional — the
// authored `angle` is the turret's MOUNT facing, the centre of its firing arc.
//
// Per-tick logic needs the room's player list (to acquire a target), which the
// stationary update(dt) hook doesn't get — so it lives in serve(playerList, dt, live),
// called from gameBoard.updateHazards (the geyser's punch + the vortex's force run
// there too). serve sets `fireRequest` on the firing edge; gameBoard spawns the shot
// (mirroring the abilityList spawnSnowFlake flag -> gameBoard.spawnSnowFlake pattern).
//
// Unlike every prior hazard, the turret can be DESTROYED: a solid player punch
// smashes it offline for the rest of the round. The charge telegraph is the
// opening — rush the emplacement during its cooldown/lock-on and break it before
// it fires (or pick it off from outside its arc, where it can't shoot back).
//
// Phases (also the netState values): 0 idle/scanning, 1 charging (the lock-on
// telegraph — a dodge window, like the geyser charge / laser-gate warn), 2 firing,
// 3 destroyed (an inert wreck — serve()/AI/firing all skip it).
var TURRET_IDLE = 0, TURRET_CHARGING = 1, TURRET_FIRING = 2, TURRET_DESTROYED = 3;
class Turret extends Hazard {
	constructor(x, y, angle, ownerId, roomSig) {
		super(x, y, c.hazards.sentryTurret.radius, c.hazards.sentryTurret.color, ownerId, roomSig);
		this.id = c.hazards.sentryTurret.id;
		this.moveable = false;      // stationary — no engine motion hook
		this.streamAngle = true;    // ship the live barrel facing per tick (rotor pattern)
		this.isTurret = true;       // AI penalizes the cone of fire (aiController)
		// Mount facing = the centre of the firing arc. Directional, so validateMap
		// enforces a finite angle; guard anyway (a non-finite angle NaNs the aim math).
		// NORMALIZE to [0,360): the arc-membership tests (here + AI) use a single-mod
		// shortest-delta that assumes the reference angle is in range — a crafted/hand-
		// edited map shipping e.g. 720 or -400 would otherwise corrupt the wedge.
		this.mountAngle = Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : 0;
		this.angle = this.mountAngle;   // current barrel facing (streamed; eases to/from mount)
		this.range = c.hazards.sentryTurret.range;
		this.arc = c.hazards.sentryTurret.arc;
		this.turnSpeed = c.hazards.sentryTurret.turnSpeed; // barrel tracking, degrees/sec
		this.phase = TURRET_IDLE;
		this.netState = TURRET_IDLE; // shipped each tick (compressor.sendHazardUpdates)
		this.timer = 0;             // seconds elapsed in charging/firing
		// Start "loaded" so a turret guarding the start line threatens promptly.
		this.cooldownTimer = c.hazards.sentryTurret.cooldownMs / 1000;
		this.fireRequest = false;   // gameBoard.fireTurret consumes this on the firing edge
		this.destroyedRequest = false; // gameBoard.updateHazards consumes this to ship the wreck FX
		this.breakable = false;     // only punch-breakable while racing/collapsing (set in serve)
		this.x = this.newX = x;     // stationary; seed newX/newY so a stray move() is a no-op
		this.y = this.newY = y;
	}
	// Stationary: no motion + no timer that runs without the player list. All per-tick
	// work is in serve() (needs playerList), called from gameBoard.updateHazards.
	update() { }
	// Shortest-arc step of `cur` toward `target` by at most `maxStep` (all degrees).
	stepAngleToward(cur, target, maxStep) {
		var diff = ((target - cur + 540) % 360) - 180;
		if (Math.abs(diff) <= maxStep) { return ((target % 360) + 360) % 360; }
		return ((cur + (diff < 0 ? -1 : 1) * maxStep) % 360 + 360) % 360;
	}
	// Whether a candidate at (tx,ty) is a valid target: inside range, inside the mount
	// arc, and (if `map` has barriers) not shielded behind a wall/fence. Returns the
	// angle to it (for aiming) or null. Shared by the racer + antlion passes so both use
	// the identical arc/range/line-of-sight test.
	targetAngleIfVisible(tx, ty, halfArc, eng, map) {
		var dx = tx - this.x, dy = ty - this.y;
		var d2 = dx * dx + dy * dy;
		if (d2 < 1) { return null; }
		var ang = Math.atan2(dy, dx) * 180 / Math.PI;
		if (Math.abs(((ang - this.mountAngle + 540) % 360) - 180) > halfArc) { return null; }
		if (eng != null && eng.barrierCrossing(this.x, this.y, tx, ty, map) != null) { return null; }
		return { angle: ang, d2: d2 };
	}
	// Nearest valid target inside range AND inside the mount arc, as { angle }, or null.
	// Considers racers (skipping protected/star — knockback shrugs them off — and
	// finished karts) AND antlions (the chasing brutal-round hazard, passed in by
	// gameBoard during the antlion round). Zombies are alive racers, so the turret
	// tracks them like anyone else. A barrier between the turret and a candidate shields
	// it (line of sight). Picks whichever target — racer or antlion — is closest.
	acquireTarget(playerList, map, antlions) {
		var best = null, bestD2 = this.range * this.range, halfArc = this.arc / 2;
		var eng = (map != null) ? require('../engine.js') : null;
		for (var id in playerList) {
			var p = playerList[id];
			if (p == null || p.alive === false || p.reachedGoal) { continue; }
			if (typeof p.isProtected === "function" && p.isProtected()) { continue; }
			if (typeof p.hasStarPower === "function" && p.hasStarPower()) { continue; }
			var hit = this.targetAngleIfVisible(p.x, p.y, halfArc, eng, map);
			if (hit != null && hit.d2 < bestD2) { bestD2 = hit.d2; best = { angle: hit.angle }; }
		}
		if (antlions != null) {
			for (var ai = 0; ai < antlions.length; ai++) {
				var an = antlions[ai];
				if (an == null || an.alive === false) { continue; }
				var ahit = this.targetAngleIfVisible(an.x, an.y, halfArc, eng, map);
				if (ahit != null && ahit.d2 < bestD2) { bestD2 = ahit.d2; best = { angle: ahit.angle }; }
			}
		}
		return best;
	}
	// Per-tick: aim + run the cooldown->charge->fire state machine. `live` is false
	// outside racing/collapsing (karts are penned) — the turret idles and the barrel
	// eases back to its mount facing. `map` (optional) lets it skip targets shielded by
	// a barrier; `antlions` (optional) are extra targets during the antlion round. Sets
	// fireRequest on the firing edge.
	serve(playerList, dt, live, map, antlions) {
		dt = dt || 0;
		if (this.alive === false) { return; }
		// Only smashable while it's an actual threat (racing/collapsing). Off the race
		// — e.g. the decorative turret on the lobby tutorial map, where it never fires —
		// a stray punch shouldn't leave a permanent wreck. serve() runs every tick (after
		// checkCollisions), so handleHit reads last tick's liveness — stable across a state.
		this.breakable = !!live;
		var target = live ? this.acquireTarget(playerList, map, antlions) : null;
		var wantAngle = (target != null) ? target.angle : this.mountAngle;
		this.angle = this.stepAngleToward(this.angle, wantAngle, this.turnSpeed * dt);
		this.cooldownTimer += dt; // always recovering, so it's loaded when a target appears
		var cfg = c.hazards.sentryTurret;
		if (this.phase === TURRET_IDLE) {
			if (target != null && this.cooldownTimer >= cfg.cooldownMs / 1000) {
				this.phase = TURRET_CHARGING; this.timer = 0;
			}
		} else if (this.phase === TURRET_CHARGING) {
			this.timer += dt;
			// Juke out of the arc during the lock-on and the shot is aborted — the
			// telegraph is a real dodge window (bait the turret, then break the line).
			if (target == null) {
				this.phase = TURRET_IDLE; this.timer = 0;
			} else if (this.timer >= cfg.chargeMs / 1000) {
				this.fireRequest = true;    // fire along the current barrel angle
				this.cooldownTimer = 0;
				this.phase = TURRET_FIRING; this.timer = 0;
			}
		} else { // TURRET_FIRING
			this.timer += dt;
			if (this.timer >= cfg.fireMs / 1000) { this.phase = TURRET_IDLE; this.timer = 0; }
		}
		this.netState = this.phase;
	}
	// The muzzle world position (where the shot spawns + where the client draws the
	// barrel tip), barrelLength out along the current barrel facing.
	muzzle() {
		var rad = this.angle * (Math.PI / 180);
		return {
			x: this.x + Math.cos(rad) * c.hazards.sentryTurret.barrelLength,
			y: this.y + Math.sin(rad) * c.hazards.sentryTurret.barrelLength
		};
	}
	// Touch is harmless — the turret's only damage is its shot. But a SOLID PLAYER
	// PUNCH smashes it: one good hit takes it offline for the rest of the round. Only
	// real player swings count — map-owned shoves (other hazards' knockback punches)
	// and the hockey puck can't, and an already-wrecked turret ignores everything.
	// A CLASHED punch (countered by resolvePunchClashes — two players parrying each
	// other) lands on nothing, so it can't break the turret either (mirrors the same
	// guard in Player.handlePunchHit). alive=false drops it from serve()/firing and
	// the AI cone-avoidance (both guard alive===false); the wreck stays in hazardList
	// so the netState wire keeps drawing it. destroyedRequest is the firing-edge flag
	// gameBoard turns into the break FX.
	handleHit(object) {
		if (this.alive === false || !this.breakable) { return; }
		if (object == null || !object.isPunch || object.mapOwned || object.clashed) { return; }
		this.phase = TURRET_DESTROYED;
		this.netState = TURRET_DESTROYED;
		this.alive = false;       // inert wreck for the rest of the round
		this.destroyedRequest = true;
		object.landed = true;     // the punch connected — keep it out of the clash pass
	}
}

// A magpie drone: a thieving drone that patrols a rail (railed like the moving bumper) and
// STEALS a racer's HELD ABILITY on contact, then carries it off — the FIRST hazard to reach
// into the ability ECONOMY (every prior kind only shoved/teleported/blocked, never touched a
// player's inventory). PUNCH it (a real player swing) and it DROPS the loot onto the nearest
// drivable cell as a re-grabbable ability PAD — reusing the normal ability-tile pickup path,
// not a parallel pickup system. A racer holding NO ability instead gets a STAMINA chunk
// drained (immediate; nothing to carry). A drone is "FULL" while carrying — a full drone is
// harmless and won't steal again until it drops or is punched — so the steal/punch/regrab
// loop reads cleanly.
//
// Railed, so motion + AI are FREE: the engine steps it along its HazardRail (like the moving
// bumper) and aiController's moving-bumper rail-crossing logic times its gap. It carries no
// CONTACT FORCE — the "damage" is the theft, resolved NOT in handleHit (the collision system
// fires handleHit up to 2x per pair) but in a once-per-tick gameBoard.serveMagpieDrone pass:
// handleHit only RECORDS the contact/punch as a request, and the pass does the inventory
// mutation (it owns abilityList + the broadcasts + the racing/collapsing gate). The carried
// ability TILE id rides the netState wire (0 = empty) so the client can draw the loot — note
// ability.id IS the ability TILE id (100-110), so it round-trips straight back to a Ctor.
class MagpieDrone extends Hazard {
	constructor(x, y, rail, ownerId, roomSig) {
		super(x, y, c.hazards.magpieDrone.radius, c.hazards.magpieDrone.color, ownerId, roomSig, rail);
		this.id = c.hazards.magpieDrone.id;
		this.isMagpie = true;       // AI: a bot CARRYING an ability gives it a wide berth (aiController)
		// Author-sized rail: ship rail.width on wire slot [9] — the SAME slot the Zipline uses
		// (railLengthAuthored), so the client decodes it into .railLength for the rail track.
		this.railLengthAuthored = true;
		// Patrol at a CONSTANT LINEAR speed (patrolSpeed px/s) regardless of rail length, so the
		// bird sweeps the WHOLE rail at a steady pace whether the author drew a short hover or a
		// map-wide patrol. We deliberately ride the engine's SHARED rail step (linear px/s =
		// speed*dt) rather than a custom advance(): aiController.railCrossingOpen predicts a
		// railed hazard's motion from `h.speed` on that exact model, so staying on it keeps the
		// bot gap-timing correct (a bespoke advance would read undefined h.speed and mis-time).
		// Back `speed` out of the desired px/s and the tick dt so both the motion AND the AI
		// prediction land on patrolSpeed.
		this.speed = c.hazards.magpieDrone.patrolSpeed / (c.serverTickSpeed / 1000);
		this.angle = rail.angle;    // the engine rail step overloads .angle to track direction
		this.loot = 0;              // carried ability TILE id (100-110); 0 = empty-handed
		this.netState = 0;          // ship loot on the wire (client draws the carried-ability icon)
		this.stealVictimId = null;  // set by handleHit on body contact; resolved in serveMagpieDrone
		this.dropRequest = false;   // set by handleHit on a real player punch while carrying
		this.nextStealTime = 0;     // per-drone cooldown (Date.now ms) after a steal / stamina zap
	}
	// Lightning speeds moving hazards up — scale the along-rail patrol speed (the rail
	// bumper pattern). See gameBoard.generateHazards.
	scaleSpeed(mod) { this.speed *= mod; }
	// Contact does NOT punch/shove — it RECORDS a request the gameBoard pass resolves (which
	// owns abilityList + the racing gate). A real player PUNCH while carrying loot requests a
	// DROP (map-owned shoves / clashed punches don't count — the turret-break guard). Body
	// contact with an eligible racer requests a STEAL, but only when the drone is EMPTY and
	// off cooldown (a full drone is harmless). Idempotent under the up-to-2x handleHit (guarded
	// by loot / an already-queued request).
	handleHit(object) {
		if (this.alive === false || object == null) { return; }
		if (object.isPunch) {
			if (this.loot && !object.mapOwned && !object.clashed) {
				this.dropRequest = true;
				object.landed = true; // the punch connected — keep it out of the clash pass
			}
			return;
		}
		if (this.loot || this.stealVictimId != null) { return; } // full, or a steal is already queued this tick
		if (!object.isPlayer || object.alive === false || object.reachedGoal) { return; }
		if (object.isProtected && object.isProtected()) { return; }
		if (object.hasStarPower && object.hasStarPower()) { return; }
		if (Date.now() < this.nextStealTime) { return; }
		this.stealVictimId = object.id;
	}
}

// A warp pad: one half of a PAIRED TELEPORTER. Registered as a BOON (config.boons.warpPad,
// id 958 — see boons.js) though the class lives here with its cross-cutting machinery. A
// racer driving onto this pad is whisked to its partner pad, KEEPING its velocity — so the
// exit heading is whatever you arrived with, and an author can aim a partner's exit at lava.
// Pads are authored as a pair: each map entry carries a `pair` integer and the two entries
// sharing a value link to each other (gameBoard.linkWarpPads resolves `partner` after
// generateHazards builds them all). STATIC — the pair id rides the netState wire so the
// client can colour-match the two halves.
//
// The warp is NOT instant and NOT done in handleHit (the collision system fires handleHit up
// to twice per overlapping pair). Instead gameBoard.updateWarpPads runs ONE pass per tick as
// a 2-stage TRANSIT: on contact the racer COMMITS (frozen in place + invulnerable for
// transitMs, skipped by the engine/collision/AI), then EMERGES at the partner with velocity
// restored — `warpTo` does the relocate at emerge time. The client pans its camera to the
// exit during the transit. Ping-pong is prevented by a per-PLAYER "armed" latch
// (player.warpArmed): a racer is disarmed the moment it warps and only RE-ARMS once it has
// left every pad's trigger radius — so it can never warp again while still sitting on the pad
// (covers both an immediate bounce-back AND a kart parked dead-still on a pad).
//
// The genuinely hard part is the AI, which lives elsewhere: cellGraph.getWarpLinks adds a
// graph edge between the two linked cells WEIGHTED by the transit cost (≈cruise·transitMs px)
// so bots route THROUGH a pad pair only when it shortens the trip by more than the freeze,
// and `helpful` (it's a boon) makes aiController/mapClassifier skip the pad entirely (it is
// NOT an obstacle to route around).
class WarpPad extends Hazard {
	constructor(x, y, ownerId, roomSig, pair) {
		super(x, y, c.boons.warpPad.radius, c.boons.warpPad.color, ownerId, roomSig);
		this.id = c.boons.warpPad.id;
		this.helpful = true;        // it's a BOON — AI/classifier treat it as helpful (no dodge)
		this.moveable = false;      // stationary — no engine motion hook
		this.isWarpPad = true;      // the cellGraph shortcut keys off this (not a hazard to route around)
		// Pairing id from the map entry; two pads sharing it are linked. Keep it only if
		// it's a valid integer (validateMap enforces exactly-two-per-pair of integer ids
		// at the submit boundary; a crafted/hand-edited map with a missing or fractional
		// pair leaves this null → the pad never links → inert, never a half-formed link).
		this.pair = Number.isInteger(pair) ? pair : null;
		this.partner = null;        // the linked WarpPad (set by gameBoard via linkWarpPads)
		// Ship the pair id on the netState wire slot (static — never changes) so the
		// client can colour-match the two halves of a pair. Reuses an already-pinned
		// slot; no new wire field. A malformed (null) pair ships 0 — it won't link anyway.
		this.netState = (this.pair != null) ? this.pair : 0;
	}
	update() {
		if (this.alive === false) { return; }
	}
	// Is `object` a racer standing on this (linked) pad right now? The membership test
	// gameBoard.updateWarpPads uses to decide on-pad vs off-pad. Players only — pucks,
	// antlions and other hazards pass through; dead/finished racers are ignored.
	contains(object) {
		if (this.partner == null || this.alive === false) { return false; }
		if (!object.isPlayer || object.alive === false || object.reachedGoal) { return false; }
		var ox = object.newX != null ? object.newX : object.x;
		var oy = object.newY != null ? object.newY : object.y;
		var dx = ox - this.x, dy = oy - this.y;
		return dx * dx + dy * dy <= this.radius * this.radius;
	}
	// Relocate `object` onto the partner pad, KEEPING velocity (a discontinuous jump —
	// the client's smoothEntities snaps it because it exceeds SMOOTH_SNAP_DIST, like the
	// swap ability's teleport). Sets BOTH x and newX/newY: the warp pass runs after the
	// engine committed this tick's position, so next tick integrates from the exit.
	warpTo(object) {
		if (this.partner == null) { return false; }
		object.x = object.newX = this.partner.x;
		object.y = object.newY = this.partner.y;
		return true;
	}
	handleHit(object) { } // teleport runs in gameBoard.updateWarpPads, not on contact
}
// Link freshly-built warp pads into pairs: every pad's `partner` is set to the OTHER
// pad sharing its `pair` id, and its `transitMs` is computed from the pair's separation.
// Called once at map load from gameBoard.generateHazards (after the whole hazardList is
// built — a pad's partner may be constructed later in the build loop, so linking can't
// happen in build()). Only integer pair ids group (a malformed pad with a null pair is left
// unlinked → inert), and a pair without exactly two members (a map that slipped past
// validateMap) stays unlinked, never throwing.
function linkWarpPads(hazardList) {
	var byPair = {};
	for (var id in hazardList) {
		var hz = hazardList[id];
		if (hz == null || !hz.isWarpPad || !Number.isInteger(hz.pair)) { continue; }
		(byPair[hz.pair] || (byPair[hz.pair] = [])).push(hz);
	}
	for (var p in byPair) {
		var pads = byPair[p];
		if (pads.length === 2) {
			pads[0].partner = pads[1];
			pads[1].partner = pads[0];
			var dx = pads[0].x - pads[1].x, dy = pads[0].y - pads[1].y;
			var tms = cellGraph.warpTransitMs(Math.sqrt(dx * dx + dy * dy));
			pads[0].transitMs = tms;
			pads[1].transitMs = tms;
		}
	}
}

// --- hazard-kind registry ------------------------------------------------------
// Single source of truth for the map-authorable hazard kinds. Everything with
// per-kind behavior keys off this: gameBoard.generateHazards builds via
// kind.build, utils.validateMap enforces kind.railed => finite angle, and the
// lightning brutal round speeds up every railed kind. Adding a new hazard kind
// server-side = a config.hazards entry + one registerHazardKind call here (the
// client needs a matching drawer in draw.js and an editor entry in create.js).
//
// Kind contract:
//   railed — rides a HazardRail; compressor.newHazards ships the rail
//            origin/angle so clients draw the rail from its true origin (not
//            wherever the hazard happens to be when a spectator joins
//            mid-round). Implies directional.
//   directional — the map entry must carry a finite .angle (validateMap
//            rejects it otherwise; a non-finite angle NaNs the rail/segment
//            math). True for railed kinds and for static rotated kinds like
//            the bumper wall.
//   build(entry, mapID, roomSig) — construct the live hazard from its map JSON
//            entry ({id, x, y, [angle]}). Must return a Hazard/Rect subclass.
//
// Per-tick motion: a moveable hazard either rides a `rail` (engine.updateHazards
// steps it along the rail) or defines `advance(dt)` (engine.updateHazards calls
// it with the tick dt so the kind owns its own motion — e.g. the rotor's orbit).
// Static kinds set moveable=false and are skipped.
var HAZARD_KINDS = {};
var BOON_KINDS = {};
var _kindById = {};
function registerHazardKind(key, def) {
	def.key = key;
	def.id = c.hazards[key].id;
	def.helpful = false;
	HAZARD_KINDS[key] = def;
	_kindById[def.id] = def;
}
// Boons (server/entities/boons.js) are the helpful counterpart to hazards. They
// register into the SAME id-resolver (_kindById) so generateHazards, validateMap,
// the wire, and the client drawer treat them uniformly — the only difference is
// def.helpful, which gates the lightning speed-up, the AI's repulsion/cell-penalty
// (bots must not dodge a boost), and the map classifier's difficulty count. Their
// by-key map is kept separate (BOON_KINDS) so hazard-only iteration stays clean.
// id comes from config.boons (ids 950+), not config.hazards.
function registerBoonKind(key, def) {
	def.key = key;
	def.id = c.boons[key].id;
	def.helpful = true;
	BOON_KINDS[key] = def;
	_kindById[def.id] = def;
}
function hazardKindById(id) {
	return Object.prototype.hasOwnProperty.call(_kindById, id) ? _kindById[id] : null;
}

registerHazardKind("bumper", {
	railed: false,
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new Bumper(entry.x, entry.y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, roomSig);
	}
});
registerHazardKind("movingBumper", {
	railed: true,
	directional: true,
	build: function (entry, mapID, roomSig) {
		var rail = new HazardRail(entry.x, entry.y, c.hazards.movingBumper.width, c.hazards.movingBumper.height, entry.angle, c.hazards.bumper.color, mapID, roomSig);
		return new Bumper(entry.x, entry.y, c.hazards.bumper.radius, c.hazards.bumper.color, mapID, roomSig, rail);
	}
});
registerHazardKind("bumperWall", {
	railed: false,
	directional: true,
	build: function (entry, mapID, roomSig) {
		return new BumperWall(entry.x, entry.y, c.hazards.bumperWall.width, c.hazards.bumperWall.height, entry.angle, c.hazards.bumperWall.color, mapID, roomSig);
	}
});
registerHazardKind("rotor", {
	railed: false,
	directional: false, // `angle` is the OPTIONAL starting sweep angle (defaults to 0)
	build: function (entry, mapID, roomSig) {
		// Pass the raw angle — the Rotor constructor sanitizes a missing/non-finite
		// value to 0 (the kind is non-directional, so validateMap doesn't gate it).
		return new Rotor(entry.x, entry.y, c.hazards.rotor.radius, c.hazards.rotor.color, mapID, roomSig, entry.angle);
	}
});
registerHazardKind("geyser", {
	railed: false,
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new Geyser(entry.x, entry.y, c.hazards.geyser.radius, c.hazards.geyser.color, mapID, roomSig);
	}
});
registerHazardKind("mine", {
	railed: false,
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new Mine(entry.x, entry.y, c.hazards.mine.radius, c.hazards.mine.color, mapID, roomSig);
	}
});
registerHazardKind("vortexWell", {
	railed: false,
	directional: false,
	build: function (entry, mapID, roomSig) {
		return new VortexWell(entry.x, entry.y, vortexWellRadius(entry), c.hazards.vortexWell.color, mapID, roomSig);
	}
});
registerHazardKind("laserGate", {
	railed: false,
	directional: true, // the barrier runs along the pylon axis — needs a finite angle
	build: function (entry, mapID, roomSig) {
		return new LaserGate(entry.x, entry.y, entry.angle, mapID, roomSig);
	}
});
registerHazardKind("crusher", {
	railed: true, // rides a HazardRail; ships the rail origin/angle on the wire
	directional: true,
	build: function (entry, mapID, roomSig) {
		var rail = new HazardRail(entry.x, entry.y, c.hazards.crusher.railLength, c.hazards.crusher.height, entry.angle, c.hazards.crusher.color, mapID, roomSig);
		return new Crusher(entry.x, entry.y, rail, mapID, roomSig);
	}
});
registerHazardKind("sentryTurret", {
	railed: false,
	directional: true, // the authored angle is the mount facing (centre of the firing arc)
	build: function (entry, mapID, roomSig) {
		return new Turret(entry.x, entry.y, entry.angle, mapID, roomSig);
	}
});
registerHazardKind("magpieDrone", {
	railed: true, // rides a HazardRail like the moving bumper; ships the rail origin/angle on the wire
	directional: true,
	build: function (entry, mapID, roomSig) {
		// The rail LENGTH is author-sized per instance (drag the rail-end handle in the
		// editor), clamped server-side to [minRailLength, maxRailLength] so a crafted map
		// can't ship a rail spanning the world. Falls back to the config default.
		var rail = new HazardRail(entry.x, entry.y, magpieRailLength(entry), c.hazards.magpieDrone.height, entry.angle, c.hazards.magpieDrone.color, mapID, roomSig);
		return new MagpieDrone(entry.x, entry.y, rail, mapID, roomSig);
	}
});
// Resolve a magpie drone's per-instance rail length from its map entry: clamp the authored
// value to [minRailLength, max], where the max is MAP-WIDE — the world diagonal, so a rail can
// span the whole map in any direction (config `maxRailLength` overrides it if ever set). A
// missing/non-finite value (legacy entries, tests) falls back to the config default railLength.
function magpieRailLength(entry) {
	var cfg = c.hazards.magpieDrone;
	var min = cfg.minRailLength != null ? cfg.minRailLength : 80;
	var max = cfg.maxRailLength != null ? cfg.maxRailLength : Math.hypot(c.worldWidth, c.worldHeight);
	var v = (entry != null && Number.isFinite(entry.railLength)) ? entry.railLength : cfg.railLength;
	if (v < min) { v = min; } else if (v > max) { v = max; }
	return v;
}

// Antlion (brutal round 1014): a sand-dwelling chaser. It is NOT moveable in the
// engine's sense — engine.updateHazards is rail-only and zeroes velocity for
// rail-less moveables — so GameBoard.updateAntlionRound steers it directly each
// tick (writes newX/newY; the base Hazard.update() commits them). Contact shoves
// the kart via the same mapOwned-Punch machinery as Bumper, gated by a per-antlion
// hit cooldown so it shoves rather than vibrates.
class Antlion extends Hazard {
	constructor(x, y, ownerId, roomSig) {
		super(x, y, c.hazards.antlion.radius, c.hazards.antlion.color, ownerId, roomSig, null);
		this.id = c.hazards.antlion.id;
		this.isAntlion = true;
		this.punch = null;
		this.nextHitTime = 0;
		// Read by engine.bounceEntityOffWater's stranded-inside eject. The antlion's
		// velX/velY are vestigial (steering recomputes newX/newY from the seek each
		// tick), but the water-bounce needs a finite maxVelocity for the eject math.
		this.maxVelocity = c.brutalRounds.antlion.chaseSpeed;
		// Slam knockback from a thumper: an impulse velocity that decays each tick,
		// layered on top of the steady chase steering.
		this.impVX = 0;
		this.impVY = 0;
		// Continuous time spent off sand (ms). At offSandDespawnSeconds it burrows
		// away (GameBoard despawns it with a removeHazards broadcast).
		this.offSandMs = 0;
	}
	handleHit(object) {
		if (!object.isPlayer || object.alive === false) {
			return;
		}
		if (Date.now() < this.nextHitTime) {
			return;
		}
		if (this.punch == null) {
			this.nextHitTime = Date.now() + c.brutalRounds.antlion.hitCooldown * 1000;
			this.punch = new Punch(this.x, this.y, c.hazards.antlion.attackRadius, c.hazards.antlion.color, this.ownerId, this.roomSig, c.brutalRounds.antlion.punchBonus, false, null);
			this.punch.mapOwned = true;
			this.punch.type = "antlion";
		}
	}
}

// Thumper (Antlions round): a static ground-pounder that repels antlions inside
// repelRadius. The server slams on a fixed period (GameBoard.updateAntlionRound
// applies the impulse); the CLIENT animates its own pound cycle anchored by the
// `angle` slot of the applyHazards packet — exposed here as a getter returning
// "ms until the next slam" so any packet build (round load or late joiner) carries
// a fresh anchor. Karts are unaffected: it never spawns a punch.
class Thumper extends Hazard {
	constructor(x, y, ownerId, roomSig) {
		super(x, y, c.hazards.thumper.radius, c.hazards.thumper.color, ownerId, roomSig, null);
		this.id = c.hazards.thumper.id;
		this.isThumper = true;
		this.nextSlamTime = Date.now() + c.brutalRounds.antlion.thumperPeriod * 1000;
		// Replace the base data property with the cycle-anchor getter (compressor
		// newHazards reads hazard.angle).
		Object.defineProperty(this, "angle", {
			get: function () {
				return Math.max(0, Math.round(this.nextSlamTime - Date.now()));
			},
			configurable: true
		});
	}
	handleHit(object) {

	}
}


module.exports = { HazardRail, Hazard, Bumper, BumperWall, Rotor, Geyser, Mine, VortexWell, vortexWellRadius, LaserGate, Crusher, Turret, MagpieDrone, magpieRailLength, WarpPad, linkWarpPads, Antlion, Thumper, HAZARD_KINDS, BOON_KINDS, hazardKindById, registerHazardKind, registerBoonKind };

// Load the boon kinds AFTER module.exports is assigned: boons.js requires this
// module for the Hazard base class + registerBoonKind, so it must see the fully
// built exports. Requiring it here (rather than from gameBoard) guarantees the
// boon kinds are in _kindById for EVERY consumer of hazardKindById — including
// utils.validateMap, which can run in CI contexts that never load gameBoard.
require('./boons.js');
