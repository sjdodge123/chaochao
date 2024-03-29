"use strict";

class Joystick {
	constructor(x, y, staticBase, autoHide) {
		this.baseX = x;
		this.baseY = y;
		this.stickX = x;
		this.stickY = y;
		this.tempX = x;
		this.tempY = y;
		this.staticBase = staticBase;
		this.baseRadius = 200;
		this.width = this.baseRadius;
		this.height = this.baseRadius;
		this.stickRadius = 120;
		this.maxPullRadius = 100;
		this.dx = 0;
		this.dy = 0;
		this.deadzone = 10;
		this.distanceSquared = 0;
		this.touchIdx = null;
		this.pressed = false;
		this.autoHide = autoHide;

		this.fadeDuration = 10 * 1000;
		this.lastTouch = Date.now();
		this.timeUntilVisible = Date.now();
	}
	isVisible() {
		if (this.autoHide == false) {
			return true;
		}
		this.timeUntilVisible = Date.now() - this.lastTouch;
		if (this.fadeDuration - this.timeUntilVisible <= 0) {
			return false;
		}
		return true;
	}

	touchScreenAvailable() {
		return 'createTouch' in document ? true : false;
	}
	checkForAttack() {
		if (this.distanceSquared > this.fireradius2) {
			return true;
		}
		return false;
	}

	up() {
		if (!this.pressed) {
			return false;
		}
		if (this.dy >= 0) {
			return false;
		}
		if (Math.abs(this.dy) <= this.deadzone) {
			return false;
		}
		if (Math.abs(this.dx) > 2 * Math.abs(this.dy)) {
			return false;
		}
		return true;
	}

	down() {
		if (!this.pressed) {
			return false;
		}
		if (this.dy <= 0) {
			return false;
		}
		if (Math.abs(this.dy) <= this.deadzone) {
			return false;
		}
		if (Math.abs(this.dx) > 2 * Math.abs(this.dy)) {
			return false;
		}
		return true;
	}

	right() {
		if (!this.pressed) {
			return false;
		}
		if (this.dx <= 0) {
			return false;
		}
		if (Math.abs(this.dx) <= this.deadzone) {
			return false;
		}
		if (Math.abs(this.dy) > 2 * Math.abs(this.dx)) {
			return false;
		}
		return true;
	}

	left() {
		if (!this.pressed) {
			return false;
		}
		if (this.dx >= 0) {
			return false;
		}
		if (Math.abs(this.dx) <= this.deadzone) {
			return false;
		}
		if (Math.abs(this.dy) > 2 * Math.abs(this.dx)) {
			return false;
		}
		return true;
	}

	onUp() {
		this.pressed = false;
		if (this.staticBase) {
			this.stickX = this.baseX;
			this.stickY = this.baseY;
		} else {
			this.baseX = this.tempX;
			this.baseY = this.tempY;
			this.stickX = this.tempX;
			this.stickY = this.tempY;
		}
		this.dx = 0;
		this.dy = 0;
	}

	onMove(x, y) {
		if (this.pressed = true) {
			this.lastTouch = Date.now();
			this.calcStick(x, y);
		}
	}
	onDown(x, y) {
		this.pressed = true;
		this.lastTouch = Date.now();
		if (!this.staticBase) {
			this.tempX = x;
			this.tempY = y;
			this.baseX = x;
			this.baseY = y;
		}
		this.calcStick(x, y);
	}
	calcStick(x, y) {
		this.dx = x - this.baseX;
		this.dy = y - this.baseY;
		this.distanceSquared = getMagSquared(this.dx, this.dy);
		if (this.distanceSquared < this.maxPullRadius * this.maxPullRadius) {
			this.stickX = x;
			this.stickY = y;
		} else {
			var mag = Math.sqrt(getMagSq(x, y, this.baseX, this.baseY));
			this.stickX = this.baseX + (this.maxPullRadius / mag) * (x - this.baseX);
			this.stickY = this.baseY + (this.maxPullRadius / mag) * (y - this.baseY);
		}
	}
}

class VirtualButton {
	constructor(x, y, width, height, render) {
		this.x = x;
		this.y = y;
		this.width = width;
		this.height = height;

		this.top = this.y;
		this.left = this.x;
		this.bottom = this.y + this.height;
		this.right = this.x + this.width;
		this.render = render;
	}
	pointInRect(x, y) {
		if (x > this.left && x < this.right && y > this.top && y < this.bottom) {
			return true;
		}
		return false;
	}

}
class Button {
	constructor(x, y, width, height, radius, autoHide, visible) {
		this.baseX = x;
		this.baseY = y;

		this.autoHide = autoHide;

		this.top = this.baseY;
		this.left = this.baseX;
		this.bottom = this.baseY + this.height;
		this.right = this.baseX + this.width;

		this.width = width;
		this.height = height;
		this.radius = radius;
		this.pressed = false;
		this.touchIdx = null;
		this.visible = visible;

		this.fadeDuration = 3 * 1000;
		this.lastTouch = Date.now();
		this.timeUntilVisible = Date.now();
	}
	pointInRect(x, y) {
		if (this.width == 0) {
			return this.pointInCircle(x, y);
		}
		if (x > this.left && x < this.right && y > this.top && y < this.bottom) {
			return true;
		}
		return false;
	}
	pointInCircle(x, y) {
		var dist = getMagSq(this.baseX, this.baseY, x, y);
		return (dist <= this.radius * this.radius);
	}
	isVisible() {
		if (this.visible == false) {
			return false;
		}
		if (!this.autoHide) {
			return true;
		}
		this.timeUntilVisible = Date.now() - this.lastTouch;
		if (this.fadeDuration - this.timeUntilVisible <= 0) {
			return false;
		}
		return true;
	}
	onDown(x, y) {
		this.lastTouch = Date.now();
		if (this.pointInRect(x, y)) {
			this.pressed = true;
		}
	}
	onMove(x, y) {
		if (this.pressed = true) {
			this.lastTouch = Date.now();
		}
	}
	onUp() {
		this.pressed = false;
	}
}
