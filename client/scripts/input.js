var menuOpen = false;

var gamePadA = null;
var movingByMouse = false;
var isTouchScreen = false,
    virtualButtonList = null,
    joystickMovement = null,
    joystickCamera = null,
    exitButton = null,
    chatButton = null,
    attackButton = null;

function initEventHandlers() {
    window.addEventListener("mousemove", calcMousePos, false);
    window.addEventListener("mousedown", handleClick, false);
    window.addEventListener("mouseup", handleUnClick, false);
    window.addEventListener("keydown", keyDown, false);
    window.addEventListener("keyup", keyUp, false);
    window.addEventListener("dblclick", handleDblClick, false);


    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });

    window.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        return false;
    }, false);
    isTouchScreen = isTouchDevice();
    // Experiment: dynamic camera defaults ON for every input method (still
    // toggleable via the navbar camera button). It auto-falls back to the
    // whole-map view when >1 local player is sharing the screen (see
    // computeWorldViewTarget) so local multiplayer isn't cropped.
    cameraZoomEnabled = true;
    if (typeof updateCameraToggleUI === "function") {
        updateCameraToggleUI();
    }
    if (isTouchScreen) {
        setupVirtualbuttons();
        // Don't auto-request fullscreen on load: browsers require a user
        // gesture (so the first call typically fails anyway), and on iOS Safari
        // the Fullscreen API isn't available on non-<video> elements at all.
        // Fullscreen is triggered only by an explicit tap on the on-canvas
        // button (onTouchStart -> goFullScreen), and that button is hidden where
        // fullscreen is unsupported.
    }

}

function calcMousePos(evt) {
    // Only suppress the default (text selection / drag) when the pointer is over
    // the game canvas, so selecting text elsewhere on the page isn't broken by
    // the global mousemove listener (item 8).
    var t = evt.target;
    if (t === gameCanvas || t === overlayCanvas ||
        (typeof gameWindow !== "undefined" && gameWindow && gameWindow.contains && gameWindow.contains(t))) {
        evt.preventDefault();
    }
    if (myPlayer != null) {
        var rect = gameCanvas.getBoundingClientRect();
        // screen -> logical (the un-zoomed 1366x768 canvas space)
        var lx = ((evt.pageX - rect.left) / newWidth) * LOGICAL_WIDTH;
        var ly = ((evt.pageY - rect.top) / newHeight) * LOGICAL_HEIGHT;
        // logical -> world: invert the dynamic-camera transform so aiming points
        // at the world spot under the cursor even while zoomed. No-op (identity)
        // when the camera isn't zoomed (worldView centre = LOGICAL/2, scale 1).
        var wx = lx, wy = ly;
        if (typeof worldView !== "undefined" && worldView && worldView.scale) {
            wx = (lx - LOGICAL_WIDTH / 2) / worldView.scale + worldView.cx;
            wy = (ly - LOGICAL_HEIGHT / 2) / worldView.scale + worldView.cy;
        }
        setMousePos(wx, wy);
    }
}

function setMousePos(x, y) {
    mousex = x;
    mousey = y;
    determineMovement();
    /*
    if (playerList[myID] != null) {
        playerList[myID].angle = angle(playerList[myID].x, playerList[myID].y, x, y);
        server.emit('mousemove', playerList[myID].angle);
    }
    */
}

// True only when the emoji wheel is open AND owned by the primary (mouse) player.
// The mouse must keep working when ANOTHER local player has the wheel open.
function primaryOwnsWheel() {
    return (typeof menuOpen !== "undefined" && menuOpen) &&
        (typeof emojiOwnerSlot === "undefined" || emojiOwnerSlot === primarySlot);
}
function handleClick(event) {
    switch (event.which) {
        case 1: {
            // Suppress attack only while the PRIMARY's own wheel is up — a pad
            // player's wheel must not freeze the mouse player's attack.
            if (!primaryOwnsWheel()) {
                // NOTE: a single click is NOT treated as "kb/m is P1" — it's too
                // ambiguous (could be clicking to start/focus). Only actually
                // moving the player via keyboard or mouse-move claims P1 (so a
                // controller-only player keeps P1). See keyDown / handleDblClick.
                attack = true;
                server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
            }
            break;
        }
        case 3: {
            if (typeof menuOpen !== "undefined" && menuOpen) {
                // Only close the wheel if it's the primary's own — don't hijack a
                // pad player's open wheel.
                if (primaryOwnsWheel()) {
                    closeEmojiWindow();
                }
            } else {
                // Open at the cursor (client coords); moveEmojiMenu clamps it.
                openEmojiWindow(event.clientX, event.clientY);
            }

            break;
        }
    }
    event.preventDefault();
}
function handleUnClick(event) {
    switch (event.which) {
        case 1: {
            if (!primaryOwnsWheel()) {
                attack = false;
                server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
            }
            break;
        }
        case 3: {
            break;
        }
    }
}
function handleDblClick(event) {
    claimPrimaryForKbm(); // mouse-move play claims P1 -> controllers are P2+
    if (movingByMouse) {
        cancelMovement(event);
    }
    movingByMouse = !movingByMouse;
}
// Map a key event to a movement action using the modern KeyboardEvent.code
// (layout-independent), falling back to the deprecated keyCode for older
// browsers. Returns "turnLeft" | "moveForward" | "turnRight" | "moveBackward" |
// "attack" | null.
function movementActionFor(evt) {
    switch (evt.code) {
        case "KeyA": case "ArrowLeft": return "turnLeft";
        case "KeyW": case "ArrowUp": return "moveForward";
        case "KeyD": case "ArrowRight": return "turnRight";
        case "KeyS": case "ArrowDown": return "moveBackward";
        case "Space": return "attack";
    }
    switch (evt.keyCode) {
        case 65: case 37: return "turnLeft";
        case 87: case 38: return "moveForward";
        case 68: case 39: return "turnRight";
        case 83: case 40: return "moveBackward";
        case 32: return "attack";
    }
    return null;
}
function keyDown(evt) {
    // While the leave-game confirmation is up, don't let movement keys drive the
    // player (gamepad.js owns that modal; openLeaveModal already stopped motion).
    if (typeof leaveModalIsOpen === "function" && leaveModalIsOpen()) {
        return;
    }
    if (movingByMouse) {
        movingByMouse = false;
    }
    var action = movementActionFor(evt);
    switch (action) {
        case "turnLeft": { turnLeft = true; break; }
        case "moveForward": { moveForward = true; break; }
        case "turnRight": { turnRight = true; break; }
        case "moveBackward": { moveBackward = true; break; }
        case "attack": { attack = true; break; }
    }
    // The keyboard is being used to play -> it owns the primary slot (P1), so
    // controllers hot-join as P2+. (When this stays null, the first pad takes P1.)
    if (action) {
        claimPrimaryForKbm();
    }
    if (playerList[myID] != null) {
        calcAngleFromKeys(playerList[myID]);
        server.emit('mousemove', playerList[myID].angle);
    }
    server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
}
function keyUp(evt) {
    if (movingByMouse) {
        movingByMouse = false;
    }

    switch (movementActionFor(evt)) {
        case "turnLeft": { turnLeft = false; break; }
        case "moveForward": { moveForward = false; break; }
        case "turnRight": { turnRight = false; break; }
        case "moveBackward": { moveBackward = false; break; }
        case "attack": { attack = false; break; }
    }
    if (playerList[myID] != null) {
        calcAngleFromKeys(playerList[myID]);
        server.emit('mousemove', playerList[myID].angle);
    }
    server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
}

function determineMovement() {
    if (playerList[myID] != null) {
        var curAngle = angle(playerList[myID].x, playerList[myID].y, mousex, mousey);
        var rightCone = (curAngle >= 330 || curAngle <= 30);
        var rfwdCone = (curAngle >= 300 && curAngle <= 330);
        var forwardCone = (curAngle >= 240 && curAngle <= 300);
        var lfwdCone = (curAngle >= 210 && curAngle <= 240);
        var leftCone = (curAngle >= 150 && curAngle <= 210);
        var lbwdCone = (curAngle >= 120 && curAngle <= 150);
        var backwardCone = (curAngle >= 60 && curAngle <= 120);
        var rbwdCone = (curAngle >= 30 && curAngle <= 60);

        calcAngleFromKeys(playerList[myID]);
        server.emit('mousemove', playerList[myID].angle);
        if (movingByMouse) {
            moveForward = false;
            moveBackward = false;
            turnRight = false;
            turnLeft = false;
            if (rfwdCone) {
                moveForward = true;
                turnRight = true;
            }
            if (rbwdCone) {
                moveBackward = true;
                turnRight = true;
            }
            if (lfwdCone) {
                moveForward = true;
                turnLeft = true;
            }
            if (lbwdCone) {
                moveBackward = true;
                turnLeft = true;
            }
            if (rightCone) {
                turnRight = true;
            }
            if (forwardCone) {
                moveForward = true;
            }
            if (leftCone) {
                turnLeft = true;
            }
            if (backwardCone) {
                moveBackward = true;
            }
            server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
        }
    }
}

function setupVirtualbuttons() {
    // The world (server dims) must be known before we size the tap regions.
    // It normally is by the time this runs (gameState -> worldResize -> init),
    // but guard so an early/ordering call can't throw on world.width (matches
    // layoutTouchControls' guard).
    if (typeof world === "undefined" || world == null) {
        return;
    }
    // Movement (left quarter) and attack (right quarter) tap regions. These are
    // proportional to the world so they always cover their half of the screen;
    // the control sizes within them are physical (see layoutTouchControls).
    var leftRect = new VirtualButton(0, 85, world.width / 4, world.height, false);
    var rightRect = new VirtualButton(0 + world.width - (world.width / 4), 50, world.width / 4, world.height, false);
    // Top-corner icon hit zones — sized & positioned in layoutTouchControls()
    // (>=44px square, below the top safe strip). Placeholders until then.
    var upperLeftRect = new VirtualButton(0, 0, 1, 1, false);
    var upperRightRect = new VirtualButton(0, 0, 1, 1, false);

    virtualButtonList = [];
    joystickMovement = new Joystick(0, 0, false, false);
    attackButton = new Button(0, 0, 0, 0, 0, true, false);
    // radius is set in layoutTouchControls (single source of truth); no dead 12.5.
    exitButton = new Button(0, 0, 0, 0, 0, false);
    chatButton = new Button(0, 0, 0, 0, 0, false);

    virtualButtonList.push({ button: joystickMovement, bound: leftRect });
    virtualButtonList.push({ button: attackButton, bound: rightRect });
    virtualButtonList.push({ button: exitButton, bound: upperRightRect });
    virtualButtonList.push({ button: chatButton, bound: upperLeftRect });

    layoutTouchControls();
}

// Convert a physical (CSS-px) size into the canvas' logical 1366x768 space so
// touch controls keep a constant physical size regardless of how the canvas is
// fitted to the screen (5.2). fitRatio = CSS px per logical unit.
function cssToLogical(px) {
    return px / (fitRatio || 1);
}

// (Re)size & position the on-canvas touch controls from the current fit ratio.
// Called after setup and on every resize, so a thumb-sized joystick/buttons
// stay thumb-sized on any screen width or orientation (5.2), and the top-corner
// icons keep a >=44px tap zone that matches the drawn icon (2.2).
function layoutTouchControls() {
    if (!virtualButtonList || !joystickMovement || typeof world === "undefined" || world == null) {
        return;
    }
    // Joystick: thumb-sized base ring + stick, preserving the original ratios.
    joystickMovement.baseRadius = cssToLogical(90);
    joystickMovement.width = joystickMovement.baseRadius;
    joystickMovement.height = joystickMovement.baseRadius;
    joystickMovement.stickRadius = cssToLogical(54);
    joystickMovement.maxPullRadius = cssToLogical(45);
    joystickMovement.deadzone = cssToLogical(5);

    // Attack: keep a large right-side tap circle, sized in physical units.
    if (attackButton) {
        attackButton.radius = cssToLogical(150);
    }

    // Top-corner icon buttons: >=44px square tap zones matching the drawn icon,
    // inset from the edges and dropped below the top strip (URL bar / notch).
    var hit = Math.max(cssToLogical(52), 44);   // tap zone side (logical)
    var icon = cssToLogical(34);                // drawn icon size (logical)
    var margin = cssToLogical(12);
    var topInset = cssToLogical(14);
    // chat (emoji) -> top-left; exit (fullscreen) -> top-right.
    sizeCornerButton(chatButton, margin + hit / 2, topInset + hit / 2, hit, icon);
    sizeCornerButton(exitButton, world.width - margin - hit / 2, topInset + hit / 2, hit, icon);

    // Centre each button in its bound rect (the joystick base is overridden on
    // touch-down; this fixes the static buttons' positions).
    for (var i = 0; i < virtualButtonList.length; i++) {
        var b = virtualButtonList[i].button;
        var bound = virtualButtonList[i].bound;
        b.baseX = bound.x + bound.width / 2 - b.width / 2;
        b.stickX = b.baseX;
        b.baseY = bound.y + bound.height / 2 - b.height / 2;
        b.stickY = b.baseY;
    }
}

// Centre a corner icon button's tap zone (its bound rect) on (cx,cy) and set the
// drawn icon size + a real radius — so the bound rect, the radius and the icon
// are one source of truth for the target size (replaces the dead 12.5 radius).
function sizeCornerButton(button, cx, cy, hit, icon) {
    if (!button) {
        return;
    }
    button.iconSize = icon;
    button.radius = hit / 2;
    for (var i = 0; i < virtualButtonList.length; i++) {
        if (virtualButtonList[i].button === button) {
            var r = virtualButtonList[i].bound;
            r.x = cx - hit / 2;
            r.y = cy - hit / 2;
            r.width = hit;
            r.height = hit;
            r.left = r.x;
            r.top = r.y;
            r.right = r.x + r.width;
            r.bottom = r.y + r.height;
            break;
        }
    }
}


function onTouchStart(evt) {
    // Guard against touch events on devices the touch UI wasn't built for
    // (hybrids where touch fires but isTouchScreen was false) so we never
    // dereference a null virtualButtonList.
    if (!virtualButtonList) {
        return;
    }
    var rect = gameCanvas.getBoundingClientRect();
    var touch = evt.changedTouches[0];
    var touchX = (((touch.pageX - rect.left) / newWidth) * LOGICAL_WIDTH);
    var touchY = (((touch.pageY - rect.top) / newHeight) * LOGICAL_HEIGHT);
    for (var i = 0; i < virtualButtonList.length; i++) {
        if (virtualButtonList[i].bound.pointInRect(touchX, touchY)) {
            var button = virtualButtonList[i].button;
            if (button.touchIdx == null) {
                button.touchIdx = touch.identifier;
                button.onDown(touchX, touchY);

                if (button == attackButton) {
                    if (button.pressed) {
                        attack = true;
                        server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
                    }
                }
                if (button == exitButton) {
                    goFullScreen();
                }
                if (button == chatButton) {
                    if (menuOpen) {
                        closeEmojiWindow();
                    } else {
                        // Touch: open centred on the viewport.
                        openEmojiWindow(window.innerWidth / 2, window.innerHeight / 2);
                    }
                }
            }
        }

    }
}
function onTouchEnd(evt) {
    if (!virtualButtonList) {
        return;
    }
    var touchList = evt.changedTouches;
    for (var i = 0; i < touchList.length; i++) {
        for (var j = 0; j < virtualButtonList.length; j++) {
            var button = virtualButtonList[j].button;
            if (touchList[i].identifier == button.touchIdx) {
                if (button == joystickMovement) {
                    cancelMovement();
                }
                if (button == attackButton) {
                    attack = false;
                    server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
                }
                button.touchIdx = null;
                button.onUp();
            }
        }
    }
}
function onTouchMove(evt) {
    if (!virtualButtonList) {
        return;
    }
    // The listener is registered passive:false precisely so we can stop the
    // page scrolling / rubber-banding / pinch-zooming under a joystick drag (6.2).
    evt.preventDefault();
    var rect = gameCanvas.getBoundingClientRect();
    var touchList = evt.changedTouches;
    var touch, touchX, touchY;
    for (var i = 0; i < touchList.length; i++) {
        touch = touchList[i];
        var touchX = (((touch.pageX - rect.left) / newWidth) * LOGICAL_WIDTH);
        var touchY = (((touch.pageY - rect.top) / newHeight) * LOGICAL_HEIGHT);
        for (var j = 0; j < virtualButtonList.length; j++) {
            var button = virtualButtonList[j].button;
            if (touch.identifier == button.touchIdx) {
                button.onMove(touchX, touchY);
                if (button == joystickCamera) {
                    if (playerList[myID] != null) {
                        playerList[myID].angle = angle(joystickCamera.baseX, joystickCamera.baseY, joystickCamera.stickX, joystickCamera.stickY);
                        server.emit('mousemove', playerList[myID].angle);
                    }
                    continue;
                }
                if (button == joystickMovement) {
                    touchMovement();
                    continue;
                }
            }
        }

    }
}

const isTouchDevice = () => {
    // Broadened from `(hover: none)` alone: treat the device as touch-first when
    // its PRIMARY input is touch-like — a coarse primary pointer or no hover
    // (phones/tablets). Touch-capable laptops keep a fine primary pointer
    // (trackpad/mouse) and are correctly left as keyboard+mouse, so this doesn't
    // over-trigger on hybrids. matchMedia is the source of truth; fall back to
    // touch-hardware probes only where it's unavailable. (Evaluated once at init.)
    var mm = window.matchMedia;
    if (mm) {
        return mm('(pointer: coarse)').matches || mm('(hover: none)').matches;
    }
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

function touchMovement() {
    moveForward = joystickMovement.up();
    moveBackward = joystickMovement.down();
    turnRight = joystickMovement.right();
    turnLeft = joystickMovement.left();
    if (playerList[myID] != null) {
        calcAngleFromKeys(playerList[myID]);
        server.emit('mousemove', playerList[myID].angle);
    }
    server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
}

function cancelMovement(evt) {
    // Cancels the PRIMARY (keyboard/mouse) player's movement via the globals.
    turnLeft = false;
    turnRight = false;
    moveForward = false;
    moveBackward = false;
    attack = false;
    server.emit('movement', { turnLeft: false, moveForward: false, turnRight: false, moveBackward: false, attack: false });
}

// Stop one local player's movement on its own socket. Primary -> the globals;
// pad slot -> its own input struct.
function cancelMovementForSlot(lp) {
    if (!lp) {
        return;
    }
    if (lp.isPrimary) {
        cancelMovement();
        return;
    }
    lp.input.turnLeft = false;
    lp.input.turnRight = false;
    lp.input.moveForward = false;
    lp.input.moveBackward = false;
    lp.input.attack = false;
    if (lp.socket) {
        lp.socket.emit('movement', { turnLeft: false, moveForward: false, turnRight: false, moveBackward: false, attack: false });
    }
}

// On tab blur, stop EVERY local player (not just the primary) so no one drifts
// while the tab is backgrounded, emitting a stop on each player's own socket
// (§6.18).
function cancelAllLocalMovement(evt) {
    if (typeof localPlayers === "undefined" || !localPlayers.length) {
        cancelMovement(evt); // bootstrap / nothing set up yet
        return;
    }
    for (var i = 0; i < localPlayers.length; i++) {
        if (localPlayers[i]) {
            cancelMovementForSlot(localPlayers[i]);
        }
    }
}

// Pure version of calcAngleFromKeys: derive the facing angle from explicit
// movement booleans instead of the keyboard globals, so a pad slot can compute
// its own facing without reading the primary player's input. Returns `fallback`
// (the player's current angle) when no direction is held.
function calcAngleFromInput(mf, mb, tl, tr, fallback) {
    if (tl && mf) { return 225; }
    if (tr && mf) { return 315; }
    if (tr && mb) { return 45; }
    if (tl && mb) { return 135; }
    if (mf) { return 270; }
    if (mb) { return 90; }
    if (tl) { return 180; }
    if (tr) { return 0; }
    return fallback;
}

function calcAngleFromKeys(player) {
    if (turnLeft && moveForward) {
        player.angle = 225;
        return;
    }
    if (turnRight && moveForward) {
        player.angle = 315;
        return;
    }
    if (turnRight && moveBackward) {
        player.angle = 45;
        return;
    }
    if (turnLeft && moveBackward) {
        player.angle = 135;
        return;
    }
    if (moveForward) {
        player.angle = 270;
        return;
    }
    if (moveBackward) {
        player.angle = 90;
        return;
    }
    if (turnLeft) {
        player.angle = 180;
        return;
    }
    if (turnRight) {
        player.angle = 0;
        return;
    }
}

function openEmojiWindow(x, y) {
    if (menuOpen == false) {
        // The wheel's full size comes from CSS (--wheel-size); scale(1) reveals it.
        emojiMenu.style.transform = "scale(1)";
        menuOpen = true;
        // Mouse/touch/keyboard opens belong to the primary; a pad open overrides
        // this in openEmojiFromPad. Tint the wheel border with the opener's color.
        emojiOwnerSlot = primarySlot;
        if (typeof playerList !== "undefined" && playerList && myID != null && playerList[myID]) {
            emojiMenu.style.borderColor = playerList[myID].color;
        }
        moveEmojiMenu(x, y);
    }

}
function closeEmojiWindow(source) {
    var owner = emojiOwnerSlot;
    if (menuOpen) {
        emojiMenu.style.transform = "scale(0)";
        menuOpen = false;
    }
    emojiOwnerSlot = null;
    if (source == "cancel") {
        return;
    }
    var emoji = String(source).trim();
    // Attribute the emoji to the player who opened the wheel (their socket).
    sendEmojiForSlot(emoji, owner);
}

// Centre the wheel on (centerX, centerY) given in viewport/client coords, then
// clamp so the WHOLE wheel stays on-screen even when opened near an edge (3.2).
function moveEmojiMenu(centerX, centerY) {
    var size = emojiMenu.offsetWidth || 200;   // full size (unaffected by scale)
    var half = size / 2;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = Math.max(half, Math.min(vw - half, centerX));
    var cy = Math.max(half, Math.min(vh - half, centerY));
    emojiMenu.style.left = (cx - half) + "px";
    emojiMenu.style.top = (cy - half) + "px";
}

var recursiveOffsetLeftAndTop = function (element) {
    var offsetLeft = 0;
    var offsetTop = 0;
    while (element) {
        offsetLeft += element.offsetLeft;
        offsetTop += element.offsetTop;
        element = element.offsetParent;
    }
    return {
        offsetLeft: offsetLeft,
        offsetTop: offsetTop
    };
};

