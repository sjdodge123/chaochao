'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();
var { Rect, Circle } = require('./shapes.js');
var { Punch } = require('./punch.js');

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
	// True rotated corners (base Rect treats width/height as far-corner coords,
	// which only works for axis-aligned, origin-anchored rects). Called by the
	// Rect constructor, so it must only read x/y/width/height/angle.
	getVertices() {
		var rad = (this.angle || 0) * (Math.PI / 180);
		var dx = Math.cos(rad), dy = Math.sin(rad);
		var nx = -dy * (this.height / 2), ny = dx * (this.height / 2);
		var bx = this.x + dx * this.width, by = this.y + dy * this.width;
		return [
			{ x: this.x + nx, y: this.y + ny },
			{ x: bx + nx, y: by + ny },
			{ x: bx - nx, y: by - ny },
			{ x: this.x - nx, y: this.y - ny }
		];
	}
	// Base Rect.getExtents skips the last vertex (length - 1 loop); for a rotated
	// wall that drops a whole corner from the quadtree AABB, so cover all four.
	getExtents() {
		var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (var i = 0; i < this.vertices.length; i++) {
			var v = this.vertices[i];
			if (v.x < minX) { minX = v.x; }
			if (v.x > maxX) { maxX = v.x; }
			if (v.y < minY) { minY = v.y; }
			if (v.y > maxY) { maxY = v.y; }
		}
		return { minX, maxX, minY, maxY };
	}
	closestOnLine(px, py) {
		var abx = this.bx - this.ax, aby = this.by - this.ay;
		var len2 = abx * abx + aby * aby;
		if (len2 < 1e-6) { return { x: this.ax, y: this.ay }; }
		var t = ((px - this.ax) * abx + (py - this.ay) * aby) / len2;
		if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
		return { x: this.ax + abx * t, y: this.ay + aby * t };
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
var _kindById = {};
function registerHazardKind(key, def) {
	def.key = key;
	def.id = c.hazards[key].id;
	HAZARD_KINDS[key] = def;
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


module.exports = { HazardRail, Hazard, Bumper, BumperWall, Rotor, Geyser, Mine, Antlion, Thumper, HAZARD_KINDS, hazardKindById, registerHazardKind };
