var menuOpen = false;

var gamePadA = null;
var movingByMouse = false;
// Opt-in touch diagnostics. Enable with ?debugtouch=1 in the URL: the client then
// streams a touch-lifecycle snapshot (which control claimed each touch, every
// control's live touchIdx, fullscreen state, touchcancel events) to the server,
// for diagnosing touch problems on devices that can't be remotely inspected
// (e.g. iOS Chrome/Safari). Off by default and zero-cost when off; the server
// only logs these when started with TOUCH_DEBUG=1 (see messenger.js).
var touchDebug = false;
function tdLog(ev, extra) {
    if (!touchDebug || typeof server === "undefined" || !server) {
        return;
    }
    var p = {
        ev: ev,
        fs: !!(document.fullscreenElement || document.webkitFullscreenElement),
        idx: {
            move: joystickMovement ? joystickMovement.touchIdx : "n/a",
            attack: attackButton ? attackButton.touchIdx : "n/a",
            exit: exitButton ? exitButton.touchIdx : "n/a",
            chat: chatButton ? chatButton.touchIdx : "n/a"
        }
    };
    if (extra) { for (var k in extra) { p[k] = extra[k]; } }
    server.emit("touchDebugReport", p);
}
var isTouchScreen = false,
    virtualButtonList = null,
    joystickMovement = null,
    joystickCamera = null,
    exitButton = null,
    chatButton = null,
    attackButton = null;

// initEventHandlers() can run more than once per session (init() is called at
// page load AND from the gameState handler, which re-fires on reconnect/re-join),
// so the window/document listeners are bound exactly once behind this flag to
// avoid stacking duplicate handlers.
var eventListenersBound = false;
var wasFullscreen = false;
function onFullscreenChange() {
    var nowFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    tdLog("fschange");
    // Release any still-held touch control when LEAVING fullscreen — that exit is
    // the transition that orphaned the joystick (a stuck touchIdx bricked it).
    // We skip ENTER so a player holding the stick while tapping fullscreen isn't
    // dropped; touchcancel handles genuinely-cancelled touches in either direction.
    if (wasFullscreen && !nowFs) {
        releaseHeldTouchControls();
    }
    wasFullscreen = nowFs;
}

function initEventHandlers() {
    if (!eventListenersBound) {
        eventListenersBound = true;
        window.addEventListener("mousemove", calcMousePos, false);
        window.addEventListener("mousedown", handleClick, false);
        window.addEventListener("mouseup", handleUnClick, false);
        window.addEventListener("keydown", keyDown, false);
        window.addEventListener("keyup", keyUp, false);
        window.addEventListener("dblclick", handleDblClick, false);

        window.addEventListener('touchstart', onTouchStart, { passive: false });
        window.addEventListener('touchend', onTouchEnd, { passive: false });
        window.addEventListener('touchmove', onTouchMove, { passive: false });
        // The OS can CANCEL in-flight touches (touchcancel) rather than end them —
        // notably iOS does this for touches held across a fullscreen enter/exit.
        // Without a handler the touched control's touchIdx stays set forever and it
        // goes dead (the movement stick bricked after toggling fullscreen).
        window.addEventListener('touchcancel', onTouchCancel, { passive: false });
        // Backstop: leaving fullscreen can orphan a touch without firing
        // touchend/cancel; onFullscreenChange releases any still-held control then.
        document.addEventListener('fullscreenchange', onFullscreenChange, false);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange, false);

        window.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            return false;
        }, false);
    }
    isTouchScreen = isTouchDevice();
    try { touchDebug = /[?&]debugtouch/.test(window.location.search); } catch (e) { touchDebug = false; }
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

// Map a viewport client X/Y to the canvas' logical 1366x768 space using the
// canvas' ACTUAL rendered size (rect.width/height) — which is what the drawing
// transform scales into — so touch/mouse hit-tests line up with where controls
// are actually drawn. Dividing by the computed newWidth/newHeight instead skews
// the mapping whenever the rendered size differs from it (iOS visual-viewport
// scaling, sub-pixel rounding, a resize that ran against a stale viewport): the
// skew is ~0 at the left/top edge and grows toward the right/bottom, so a
// top-right control can miss while a top-left one is dead-on.
function canvasClientToLogicalX(clientX, rect) {
    var w = (rect && rect.width) || newWidth || LOGICAL_WIDTH;
    return ((clientX - rect.left) / w) * LOGICAL_WIDTH;
}
function canvasClientToLogicalY(clientY, rect) {
    var h = (rect && rect.height) || newHeight || LOGICAL_HEIGHT;
    return ((clientY - rect.top) / h) * LOGICAL_HEIGHT;
}

function calcMousePos(evt) {
    // Touch devices synthesize mouse events from taps (mousemove/mousedown/
    // click/dblclick), which would drive the DESKTOP mouse controls in parallel
    // with the touch handlers. Ignore them on touch-first devices so a tap can't
    // fire a synthetic mousedown->attack or a double-tap->mouse-drive. See the
    // same guard in handleClick/handleUnClick/handleDblClick.
    if (isTouchScreen) {
        return;
    }
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
        // screen -> logical (the un-zoomed 1366x768 canvas space). Client coords
        // are viewport-relative, matching getBoundingClientRect and handleClick;
        // map against the canvas' actual rendered size (see canvasClientToLogical*).
        var lx = canvasClientToLogicalX(evt.clientX, rect);
        var ly = canvasClientToLogicalY(evt.clientY, rect);
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
    // Synthetic mouse event from a tap on a touch device — the touch handlers
    // already handled it. Without this, every tap fires a mousedown->attack
    // (e.g. tapping the fullscreen button also punched). See calcMousePos.
    if (isTouchScreen) {
        return;
    }
    switch (event.which) {
        case 1: {
            var rect = gameCanvas.getBoundingClientRect();
            var lx = ((event.clientX - rect.left) / newWidth) * LOGICAL_WIDTH;
            var ly = ((event.clientY - rect.top) / newHeight) * LOGICAL_HEIGHT;
            // Game-over screen: a click on the star widget rates the map — consume it.
            if (typeof handleGameOverRatingTap === "function" && handleGameOverRatingTap(lx, ly)) {
                event.preventDefault();
                break;
            }
            // Lobby hub: a left click on the primary's prompt/panel opens it, hits a
            // control, or dismisses it — consume the click before it becomes an attack.
            if (typeof lobbyHubHandlePrimaryPointer === "function") {
                if (lobbyHubHandlePrimaryPointer(lx, ly)) {
                    event.preventDefault();
                    break;
                }
            }
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
    if (isTouchScreen) {
        return; // synthetic mouseup from a tap; touch handlers own input
    }
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
    // A double-TAP on a touch device fires a synthetic dblclick; without this it
    // would toggle the desktop "mouse-drive" mode and send the kart driving on
    // its own (often to its death). Mouse-drive is desktop-only. See calcMousePos.
    if (isTouchScreen) {
        return;
    }
    // A double-click landing on a lobby hub prompt/panel is the player operating
    // the menu (e.g. tapping a stepper or swatch twice), not the "toggle mouse-drive"
    // gesture. The mousedown path already routes these through the hub; the separate
    // dblclick event must ignore them too, or mouse-drive silently flips on mid-menu.
    if (typeof lobbyHubPointHitsActive === "function") {
        var rect = gameCanvas.getBoundingClientRect();
        var lx = ((event.clientX - rect.left) / newWidth) * LOGICAL_WIDTH;
        var ly = ((event.clientY - rect.top) / newHeight) * LOGICAL_HEIGHT;
        if (lobbyHubPointHitsActive(lx, ly)) {
            return;
        }
    }
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
    // While the leave-game confirmation or the settings panel is up, don't let
    // movement keys drive the player (gamepad.js owns those overlays and already
    // stopped motion).
    if (typeof leaveModalIsOpen === "function" && leaveModalIsOpen()) {
        return;
    }
    if (typeof settingsModalIsOpen === "function" && settingsModalIsOpen()) {
        return;
    }
    // Lobby hub: opening/navigating the primary's station panel consumes the key
    // (E/Enter to open, arrows/WASD to step, Esc to close) so it never leaks to
    // movement. preventDefault also signals the separate leave-modal keydown handler
    // (gamepad.js) to skip, so Esc closes the panel without also opening "Leave?".
    if (typeof lobbyHubHandlePrimaryKey === "function" && lobbyHubHandlePrimaryKey(evt)) {
        if (evt.preventDefault) {
            evt.preventDefault();
        }
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
        // Aim from the AUTHORITATIVE server position (the smoothing target), not the
        // eased render position (x/y), which lags by ~tau — otherwise mouse-drive
        // direction is computed from a stale spot and can pick the wrong cone.
        var mp = playerList[myID];
        var ax = (mp.tx != null) ? mp.tx : mp.x;
        var ay = (mp.ty != null) ? mp.ty : mp.y;
        var curAngle = angle(ax, ay, mousex, mousey);
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
    // Attack is now a PERSISTENT, VISIBLE button (autoHide=false, visible=true).
    // It used to be invisible, so on big-screen tablets — where the old centred
    // hit-circle shrank to the screen middle — players had no on-screen target
    // and tapping the natural lower-right thumb spot missed entirely (punch never
    // fired on iPad). The hit target is now the whole right region; see onTouchStart.
    attackButton = new Button(0, 0, 0, 0, 0, false, true);
    // radius is set in layoutTouchControls (single source of truth); no dead 12.5.
    exitButton = new Button(0, 0, 0, 0, 0, false);
    chatButton = new Button(0, 0, 0, 0, 0, false);

    // Hit-test ORDER matters: onTouchStart claims the first control whose bound
    // contains the touch, so the small top-corner icons (emoji/fullscreen) must
    // come BEFORE the large move/attack regions they overlap — otherwise the
    // right-side attack region would swallow taps on the fullscreen icon.
    virtualButtonList.push({ button: chatButton, bound: upperLeftRect });
    virtualButtonList.push({ button: exitButton, bound: upperRightRect });
    virtualButtonList.push({ button: joystickMovement, bound: leftRect });
    virtualButtonList.push({ button: attackButton, bound: rightRect });

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

    // Attack: a thumb-sized button drawn in the LOWER-right corner (where a
    // thumb naturally rests). This circle is only the visible AFFORDANCE — the
    // actual hit target is the whole right tap region (see onTouchStart) — so it
    // no longer matters that a fixed physical radius looks small on a big tablet
    // (that shrinking centre circle is what made punch impossible to land there).
    if (attackButton) {
        attackButton.radius = cssToLogical(78);
    }

    // Top-corner icon buttons: generous tap zones (the fullscreen icon shares the
    // top edge with the right-side attack region, so a small target was easy to
    // miss into a punch — corner buttons are hit-tested first, see onTouchStart,
    // and now get a comfortable thumb-sized zone + a visible button backing).
    var hit = Math.max(cssToLogical(72), 48);   // tap zone side (logical)
    var icon = cssToLogical(38);                // drawn icon size (logical)
    var margin = cssToLogical(16);
    var topInset = cssToLogical(16);
    // chat (emoji) -> top-left; exit (fullscreen) -> top-right.
    sizeCornerButton(chatButton, margin + hit / 2, topInset + hit / 2, hit, icon);
    sizeCornerButton(exitButton, world.width - margin - hit / 2, topInset + hit / 2, hit, icon);

    // Reserve the top strip for the corner icons: drop the TOP of the move/attack
    // regions below the corner buttons (+ a little buffer). Without this the attack
    // region reaches all the way into the top-right corner, so a tap aimed at the
    // fullscreen icon that lands even slightly off it throws a punch instead. Now
    // the strip around the corner icons is a no-punch zone — the icon (or nothing).
    var regionTop = topInset + hit + cssToLogical(10);
    for (var t = 0; t < virtualButtonList.length; t++) {
        var entry = virtualButtonList[t];
        if (entry.button === joystickMovement || entry.button === attackButton) {
            var r = entry.bound;
            var keepBottom = r.y + r.height;
            r.y = regionTop;
            r.top = regionTop;
            r.height = keepBottom - regionTop;
            r.bottom = keepBottom;
        }
    }

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

    // Anchor the visible attack button in the lower-right thumb zone (the centring
    // loop above left it at the region's vertical middle). The bottom margin leaves
    // room for the "Attack" caption so it never clips off the bottom edge.
    if (attackButton) {
        attackButton.baseX = world.width - cssToLogical(28) - attackButton.radius;
        attackButton.baseY = world.height - cssToLogical(48) - attackButton.radius;
        attackButton.stickX = attackButton.baseX;
        attackButton.stickY = attackButton.baseY;
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
    // Map against the canvas' ACTUAL on-screen box (getBoundingClientRect) using
    // viewport-relative client coords. We divide by rect.width/height, NOT the
    // computed newWidth/newHeight: if the canvas ever renders at a size that
    // differs from newWidth (CSS, a stale resize, sub-pixel rounding), dividing
    // by newWidth skews the mapping — and the skew grows toward the right/bottom
    // edge while the left/top stay accurate (which is exactly how a top-right
    // button can miss while a top-left one is fine).
    var touchX = canvasClientToLogicalX(touch.clientX, rect);
    var touchY = canvasClientToLogicalY(touch.clientY, rect);
    // Lobby hub taps win over the movement/attack tap regions so the prompt/panel
    // is usable even where it overlaps a control zone (primary slot only). Pass the
    // SCREEN-logical touch coords directly: the hub HUD is drawn in screen space and
    // its hit rects come from lobbyProjectToScreen() (which already bakes in the
    // dynamic-camera zoom/pan), so no world conversion is needed — and adding one
    // would offset hits once the lobby follow-camera zooms in on touch.
    if (typeof config !== "undefined" && config && currentState === config.stateMap.lobby &&
        typeof lobbyHubHandlePrimaryPointer === "function" && lobbyHubHandlePrimaryPointer(touchX, touchY)) {
        evt.preventDefault();
        return;
    }
    // Game-over screen: a tap on the star widget rates the map.
    if (typeof handleGameOverRatingTap === "function" && handleGameOverRatingTap(touchX, touchY)) {
        evt.preventDefault();
        return;
    }
    var claimedName = "none";   // for touch diagnostics (tdLog below)
    for (var i = 0; i < virtualButtonList.length; i++) {
        if (virtualButtonList[i].bound.pointInRect(touchX, touchY)) {
            var button = virtualButtonList[i].button;
            if (button.touchIdx == null) {
                button.touchIdx = touch.identifier;
                button.onDown(touchX, touchY);
                claimedName = button === joystickMovement ? "MOVE" : button === attackButton ? "ATTACK" :
                    button === exitButton ? "EXIT" : button === chatButton ? "CHAT" : "?";

                if (button == attackButton) {
                    // The ENTIRE right tap region punches (not just the drawn
                    // circle), so a thumb anywhere on the right reliably attacks
                    // on every screen size.
                    button.pressed = true;
                    attack = true;
                    server.emit('movement', { turnLeft: turnLeft, moveForward: moveForward, turnRight: turnRight, moveBackward: moveBackward, attack: attack });
                }
                // NOTE: fullscreen (exitButton) is requested in onTouchEnd, NOT
                // here. requestFullscreen() needs "transient activation", which
                // browsers grant on the gesture-COMPLETING event (touchend), not
                // on touchstart — calling it here rejects with "Cannot request
                // fullscreen without transient activation." The touch is still
                // claimed above (touchIdx + break), so onTouchEnd can act on it.
                if (button == chatButton) {
                    if (menuOpen) {
                        closeEmojiWindow();
                    } else {
                        // Touch: open centred on the viewport.
                        openEmojiWindow(window.innerWidth / 2, window.innerHeight / 2);
                    }
                }
                // One touch claims exactly one control (priority order set in
                // setupVirtualbuttons), so overlapping bounds — e.g. the
                // fullscreen icon sitting inside the right attack region — can't
                // fire two actions from a single tap.
                break;
            }
        }

    }
    tdLog("start", { id: touch.identifier, x: Math.round(touchX), y: Math.round(touchY), claimed: claimedName });
}
function onTouchEnd(evt) {
    if (!virtualButtonList) {
        return;
    }
    var touchList = evt.changedTouches;
    if (touchDebug) {
        var endIds = [];
        for (var e = 0; e < touchList.length; e++) { endIds.push(touchList[e].identifier); }
        tdLog("end", { ids: endIds });
    }
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
                if (button == exitButton) {
                    // Fire fullscreen on finger-UP: touchend carries the transient
                    // activation that requestFullscreen() requires (touchstart does
                    // not). This is what makes the fullscreen button actually work.
                    goFullScreen();
                }
                button.touchIdx = null;
                button.onUp();
            }
        }
    }
}
// touchcancel: the OS interrupted these touches (no touchend will come). Release
// the matched controls exactly like touchend does, but WITHOUT requesting
// fullscreen — a cancelled exit-button touch must not toggle fullscreen.
function onTouchCancel(evt) {
    if (!virtualButtonList) {
        return;
    }
    var touchList = evt.changedTouches;
    if (touchDebug) {
        var cids = [];
        for (var c = 0; c < touchList.length; c++) { cids.push(touchList[c].identifier); }
        tdLog("CANCEL", { ids: cids });
    }
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
// Release any control that still thinks it's being touched. Used as a fullscreen-
// change backstop: a transition can orphan a touch (no touchend/cancel), leaving
// a stuck touchIdx that bricks the control until reload. Clearing it lets the
// next tap re-claim the control cleanly.
function releaseHeldTouchControls() {
    if (!virtualButtonList) {
        return;
    }
    var any = false;
    for (var i = 0; i < virtualButtonList.length; i++) {
        var button = virtualButtonList[i].button;
        if (button.touchIdx != null) {
            button.touchIdx = null;
            if (button.onUp) { button.onUp(); }
            any = true;
        }
    }
    if (any) {
        cancelMovement(); // clears the movement/attack globals and emits a stop
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
        // Map against the canvas' actual rendered size (see onTouchStart / the
        // canvasClientToLogical* helpers) so drags track the finger exactly.
        var touchX = canvasClientToLogicalX(touch.clientX, rect);
        var touchY = canvasClientToLogicalY(touch.clientY, rect);
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

