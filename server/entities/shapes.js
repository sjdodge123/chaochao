'use strict';
var utils = require('../utils.js');
var c = utils.loadConfig();

class Shape {
	constructor(x, y, color) {
		this.x = x;
		this.y = y;
		this.newX = this.x;
		this.newY = this.y;
		this.velX = 0;
		this.velY = 0;
		this.color = color;
	}
	inBounds(shape) {
		if (shape.radius) {
			return this.testCircle(shape);
		}
		if (shape.width) {
			return this.testRect(shape);
		}
		return false;
	}
}

class Rect extends Shape {
	constructor(x, y, width, height, angle, color) {
		super(x, y, color);
		this.width = width;
		this.height = height;
		this.angle = angle;
		this.vertices = this.getVertices();
	}
	getVertices() {
		var vertices = [];
		var a = { x: this.x, y: this.y },
			b = { x: this.width, y: this.y },
			c = { x: this.width, y: this.height },
			d = { x: this.x, y: this.height };

		vertices.push(a, b, c, d);
		return vertices;
	}
	pointInRect(objX, objY) {
		var a = this.areaTriangle(this.vertices[0].x, this.vertices[0].y, this.vertices[1].x, this.vertices[1].y, this.vertices[2].x, this.vertices[2].y) +
			this.areaTriangle(this.vertices[0].x, this.vertices[0].y, this.vertices[3].x, this.vertices[3].y, this.vertices[2].x, this.vertices[2].y);
		var a1 = this.areaTriangle(objX, objY, this.vertices[0].x, this.vertices[0].y, this.vertices[1].x, this.vertices[1].y);
		var a2 = this.areaTriangle(objX, objY, this.vertices[1].x, this.vertices[1].y, this.vertices[2].x, this.vertices[2].y);
		var a3 = this.areaTriangle(objX, objY, this.vertices[2].x, this.vertices[2].y, this.vertices[3].x, this.vertices[3].y);
		var a4 = this.areaTriangle(objX, objY, this.vertices[0].x, this.vertices[0].y, this.vertices[3].x, this.vertices[3].y);
		return (a == a1 + a2 + a3 + a4);
	}

	areaTriangle(x1, y1, x2, y2, x3, y3) {
		return Math.abs((x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2.0);
	}

	getExtents() {
		var minX = this.vertices[0].x,
			maxX = minX,
			minY = this.vertices[0].y,
			maxY = minY;
		for (var i = 0; i < this.vertices.length - 1; i++) {
			var vert = this.vertices[i];
			minX = (vert.x < minX) ? vert.x : minX;
			maxX = (vert.x > maxX) ? vert.x : maxX;
			minY = (vert.y < minY) ? vert.y : minY;
			maxY = (vert.y > maxY) ? vert.y : maxY;
		}
		return { minX, maxX, minY, maxY };
	}
	testRect(rect) {
		for (var i = 0; i < this.vertices.length; i++) {
			if (rect.pointInRect(this.vertices[i].x, this.vertices[i].y)) {
				return true;
			}
		}
		for (var i = 0; i < rect.vertices.length; i++) {
			if (this.pointInRect(rect.vertices[i].x, rect.vertices[i].y)) {
				return true;
			}
		}
		return false;
	}
	testCircle(circle) {
		return circle.testRect(this);
	}
	getRandomLoc() {
		return { x: Math.floor(Math.random() * (this.width - this.x)) + this.x, y: Math.floor(Math.random() * (this.height - this.y)) + this.y };
	}
	findFreeLoc(obj) {
		var loc = this.getSafeLoc(obj.width || obj.radius);
		return loc;
	}
	getSafeLoc(size) {
		var objW = size + 5 + c.playerBaseRadius * 2;
		var objH = size + 5 + c.playerBaseRadius * 2;
		return { x: Math.floor(Math.random() * (this.width - 2 * objW - this.x)) + this.x + objW, y: Math.floor(Math.random() * (this.height - 2 * objH - this.y)) + this.y + objH, width: objW };
	}
}

// A Gate is the start-pen players are held in before the race. Unlike the base
// Rect (whose width/height double as the far-corner coordinates and so only
// line up with true dimensions when x=y=0), a Gate can sit on ANY edge of the
// world (left/right/top/bottom), so it stores width/height as TRUE dimensions
// and overrides the two Rect methods that assumed far-corner coords. With this,
// preventEscape (bound.x + bound.width), the gate-line render (gate.x+width),
// and getSafeLoc all compute the correct edges for a non-origin gate.
class Gate extends Rect {
	constructor(x, y, width, height) {
		super(x, y, width, height, 0, "grey");
		this.isGate = true;
		// Which world edge this gate hugs ("left"/"right"/"top"/"bottom"); set by
		// the GameBoard when it builds the gate from the map's startEdges. Used by
		// the client to draw the release line on the gate's inner edge.
		this.edge = null;
	}
	getVertices() {
		var x2 = this.x + this.width,
			y2 = this.y + this.height;
		return [
			{ x: this.x, y: this.y },
			{ x: x2, y: this.y },
			{ x: x2, y: y2 },
			{ x: this.x, y: y2 }
		];
	}
	getSafeLoc(size) {
		var objW = size + 5 + c.playerBaseRadius * 2;
		var objH = size + 5 + c.playerBaseRadius * 2;
		return {
			x: Math.floor(Math.random() * (this.width - 2 * objW)) + this.x + objW,
			y: Math.floor(Math.random() * (this.height - 2 * objH)) + this.y + objH,
			width: objW
		};
	}
	// True-dimension counterpart to Rect.getRandomLoc (which treats width/height as
	// far-corner coords); kept consistent with the overrides above so a non-origin
	// gate doesn't hand back coordinates outside itself.
	getRandomLoc() {
		return {
			x: Math.floor(Math.random() * this.width) + this.x,
			y: Math.floor(Math.random() * this.height) + this.y
		};
	}
	handleHit() {

	}
}


class Circle extends Shape {
	constructor(x, y, radius, color) {
		super(x, y, color);
		this.radius = radius;
	}
	getExtents() {
		return { minX: this.x - this.radius, maxX: this.x + this.radius, minY: this.y - this.radius, maxY: this.y + this.radius };
	}

	testCircle(circle) {
		var objX1, objY1, objX2, objY2, distance;
		objX1 = this.newX || this.x;
		objY1 = this.newY || this.y;
		objX2 = circle.newX || circle.x;
		objY2 = circle.newY || circle.y;
		distance = utils.getMag(objX2 - objX1, objY2 - objY1);
		distance -= this.radius;
		distance -= circle.radius;
		if (distance <= 0) {
			return true;
		}
		return false;
	}

	testRect(rect) {
		if (this.lineIntersectCircle({ x: rect.x, y: rect.y }, { x: rect.newX, y: rect.newY })) {
			return true;
		}
		if (rect.pointInRect(this.x, this.y)) {
			return true;
		}

		if (this.lineIntersectCircle(rect.vertices[0], rect.vertices[1]) ||
			this.lineIntersectCircle(rect.vertices[1], rect.vertices[2]) ||
			this.lineIntersectCircle(rect.vertices[2], rect.vertices[3]) ||
			this.lineIntersectCircle(rect.vertices[3], rect.vertices[0])) {
			return true;
		}

		for (var i = 0; i < rect.vertices.length; i++) {
			var distsq = utils.getMagSq(this.x, this.y, rect.vertices[i].x, rect.vertices[i].y);
			if (distsq < Math.pow(this.radius, 2)) {
				return true;
			}
		}
		return false;
	}
	lineIntersectCircle(a, b) {
		var ap, ab, dirAB, magAB, projMag, perp, perpMag;
		ap = { x: this.x - a.x, y: this.y - a.y };
		ab = { x: b.x - a.x, y: b.y - a.y };
		magAB = Math.sqrt(utils.dotProduct(ab, ab));
		dirAB = { x: ab.x / magAB, y: ab.y / magAB };

		projMag = utils.dotProduct(ap, dirAB);

		perp = { x: ap.x - projMag * dirAB.x, y: ap.y - projMag * dirAB.y };
		perpMag = Math.sqrt(utils.dotProduct(perp, perp));
		if ((0 < perpMag) && (perpMag < this.radius) && (0 < projMag) && (projMag < magAB)) {
			return true;
		}
		return false;
	}


	getRandomCircleLoc(minR, maxR) {
		var r = Math.floor(Math.random() * (maxR - minR));
		var angle = Math.floor(Math.random() * (Math.PI * 2 - 0));
		return { x: r * Math.cos(angle) + this.x, y: r * Math.sin(angle) + this.y };
	}
}

module.exports = { Shape, Rect, Circle, Gate };
