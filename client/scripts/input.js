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
    if (isTouchScreen) {
        setupVirtualbuttons();
        goFullScreen();
    }

}

function calcMousePos(evt) {
    evt.preventDefault();
    if (myPlayer != null) {
        var rect = gameCanvas.getBoundingClientRect();
        setMousePos((((evt.pageX - rect.left) / newWidth) * gameCanvas.width), (((evt.pageY - rect.top) / newHeight) * gameCanvas.height));
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

function handleClick(event) {
    switch (event.which) {
        case 1: {
            if (menuOpen == false) {
                attack = true;
                server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
            }
            break;
        }
        case 3: {
            if (menuOpen) {
                closeEmojiWindow();
            } else {
                openEmojiWindow(mousex, mousey);
            }

            break;
        }
    }
    event.preventDefault();
}
function handleUnClick(event) {
    switch (event.which) {
        case 1: {
            if (menuOpen == false) {
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
    if (movingByMouse) {
        cancelMovement(event);
    }
    movingByMouse = !movingByMouse;
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
    var gameKey = true;
    switch (evt.keyCode) {
        case 65: { turnLeft = true; break; } //Left key
        case 37: { turnLeft = true; break; } //Left key
        case 87: { moveForward = true; break; } //Up key
        case 38: { moveForward = true; break; } //Up key
        case 68: { turnRight = true; break; }//Right key
        case 39: { turnRight = true; break; }//Right key
        case 83: { moveBackward = true; break; } //Down key
        case 40: { moveBackward = true; break; } //Down key
        case 32: { attack = true; break; } // Spacebar
        default: { gameKey = false; }
    }
    // The keyboard is being used to play -> it owns the primary slot (P1), so
    // controllers hot-join as P2+. (When this stays false, the first pad takes P1.)
    if (gameKey) {
        keyboardClaimedPrimary = true;
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

    switch (evt.keyCode) {
        case 65: { turnLeft = false; break; } //Left key
        case 37: { turnLeft = false; break; } //Left key
        case 87: { moveForward = false; break; } //Up key
        case 38: { moveForward = false; break; } //Up key
        case 68: { turnRight = false; break; }//Right key
        case 39: { turnRight = false; break; }//Right key
        case 83: { moveBackward = false; break; } //Down key
        case 40: { moveBackward = false; break; } //Down key
        case 32: { attack = false; break; } // Spacebar
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


    //var rect = gameCanvas.getBoundingClientRect();
    var leftRect = new VirtualButton(0, 85, world.width / 4, world.height, false);
    var rightRect = new VirtualButton(0 + world.width - (world.width / 4), 50, world.width / 4, world.height, false);
    var upperLeftRect = new VirtualButton(0, 10, world.width / 16, 50, false);
    var upperRightRect = new VirtualButton(0 + world.width - (world.width / 16), 10, world.width / 16, 50, false);
    var topRightRect = new VirtualButton(0 + world.width - (world.width / 4), 85, world.width / 4, world.height / 2, false);
    var bottomRightRect = new VirtualButton(0 + world.width - (world.width / 4), topRightRect.bottom, world.width / 4, world.height / 2, false);
    //var bottomCenterRect = new VirtualButton(leftRect.right,world.height - (world.height/4)-100,rightRect.left-leftRect.right,200,false);

    virtualButtonList = [];
    joystickMovement = new Joystick(0, 0, false, false);
    //joystickCamera = new Joystick(0, 0, false);
    attackButton = new Button(0, 0, 0, 0, rightRect.width * 1.5, true, false);
    exitButton = new Button(world.width - 50, 0, 0, 0, 12.5, false);
    chatButton = new Button(50, 0, 0, 0, 12.5, false);

    virtualButtonList.push({ button: joystickMovement, bound: leftRect });
    //virtualButtonList.push({ button: joystickCamera, bound: topRightRect });
    virtualButtonList.push({ button: attackButton, bound: rightRect });
    virtualButtonList.push({ button: exitButton, bound: upperRightRect });
    virtualButtonList.push({ button: chatButton, bound: upperLeftRect });


    for (var i = 0; i < virtualButtonList.length; i++) {
        virtualButtonList[i].button.baseX = virtualButtonList[i].bound.x + virtualButtonList[i].bound.width / 2 - virtualButtonList[i].button.width / 2;
        virtualButtonList[i].button.stickX = virtualButtonList[i].bound.x + virtualButtonList[i].bound.width / 2 - virtualButtonList[i].button.width / 2;
        virtualButtonList[i].button.baseY = virtualButtonList[i].bound.y + virtualButtonList[i].bound.height / 2 - virtualButtonList[i].button.height / 2;
        virtualButtonList[i].button.stickY = virtualButtonList[i].bound.y + virtualButtonList[i].bound.height / 2 - virtualButtonList[i].button.height / 2;
    }
}


function onTouchStart(evt) {
    var rect = gameCanvas.getBoundingClientRect();
    var touch = evt.changedTouches[0];
    var touchX = (((touch.pageX - rect.left) / newWidth) * gameCanvas.width);
    var touchY = (((touch.pageY - rect.top) / newHeight) * gameCanvas.height);
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
                        openEmojiWindow(rect.width / 2 - 50, rect.height / 2 - 50);
                    }
                }
            }
        }

    }
}
function onTouchEnd(evt) {
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
    var rect = gameCanvas.getBoundingClientRect();
    var touchList = evt.changedTouches;
    var touch, touchX, touchY;
    for (var i = 0; i < touchList.length; i++) {
        touch = touchList[i];
        var touchX = (((touch.pageX - rect.left) / newWidth) * gameCanvas.width);
        var touchY = (((touch.pageY - rect.top) / newHeight) * gameCanvas.height);
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
    return window.matchMedia('(hover: none)').matches
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
        emojiMenu.style.transform = "scale(2)";
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

function moveEmojiMenu(x, y) {
    emojiMenu.style.left = x + "px";
    emojiMenu.style.top = y + "px";
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

