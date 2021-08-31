var angleFromPlayer = 0;
var menuOpen = false;

var gamePadA = null;

var isTouchScreen = false,
    joystickMovement = null,
    joystickCamera = null,
    jotstickFadeDuration = 5000,
    joysticksFaded = true,
    joystickLastTouch = Date.now();

function initEventHandlers(){
    window.addEventListener("mousemove", calcMousePos, false);
    window.addEventListener("mousedown", handleClick, false);
    window.addEventListener("mouseup", handleUnClick, false);
    window.addEventListener("keydown", keyDown, false);
    window.addEventListener("keyup", keyUp, false);


    window.addEventListener('touchstart',onTouchStart, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchmove',onTouchMove, { passive: false });

    window.addEventListener('contextmenu', function(ev) {
        ev.preventDefault();
        return false;
    }, false);

    //gamePadA = {enabled:true,x:gameCanvas.width-250,y:gameCanvas.height-250,radius:50};
    //joystickCamera = new Joystick(gameCanvas.width-250,gameCanvas.height-250);
    isTouchScreen = isTouchDevice();
    if(isTouchScreen){
        goFullScreen();
    }
}

function calcMousePos(evt){
    evt.preventDefault();
    var rect = gameCanvas.getBoundingClientRect();
    if(myPlayer != null){
        mouseX = (((evt.pageX - rect.left)/newWidth)*gameCanvas.width);
        mouseY = (((evt.pageY - rect.top )/newHeight)*gameCanvas.height);
        server.emit('mousemove',{x:mouseX,y:mouseY});
        setMousePos(mouseX,mouseY);
    }
}

function setMousePos(x,y){
	mousex = x;
	mousey = y;
    if(playerList[myID] != null){
        angleFromPlayer = Math.abs((180/Math.PI)*Math.atan2(mousey-playerList[myID].y,mousex-playerList[myID].x) - 90);
    }
    if(menuOpen == false){
        moveEmojiMenu(x,y); 
    }
}

function handleClick(event){
    switch(event.which){
        case 1:{
            if(menuOpen == false){
                attack = true;
                server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
            }
            break;
        }
        case 3:{
            if(menuOpen){
                closeEmojiWindow();
            } else{
                openEmojiWindow();
            }
            
            break;
        }
    }
    event.preventDefault();
}
function handleUnClick(event){
    switch(event.which){
        case 1:{
            attack = false;
            server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
            break;
        }
        case 3:{
            break;
        }
    }
}
function keyDown(evt){
    switch(evt.keyCode) {
        case 65: {turnLeft = true; break;} //Left key
        case 37: {turnLeft = true; break;} //Left key
        case 87: {moveForward = true; break;} //Up key
        case 38: {moveForward = true; break;} //Up key
        case 68: {turnRight = true; break;}//Right key
        case 39: {turnRight = true; break;}//Right key
        case 83: {moveBackward = true; break;} //Down key
        case 40: {moveBackward = true; break;} //Down key
        case 32: {attack = true; break;} // Spacebar
    }
    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
}
function keyUp(evt){
    switch(evt.keyCode) {
        case 65: {turnLeft = false; break;} //Left key
        case 37: {turnLeft = false; break;} //Left key
        case 87: {moveForward = false; break;} //Up key
        case 38: {moveForward = false; break;} //Up key
        case 68: {turnRight = false; break;}//Right key
        case 39: {turnRight = false; break;}//Right key
        case 83: {moveBackward = false; break;} //Down key
        case 40: {moveBackward = false; break;} //Down key
        case 32: {attack = false; break;} // Spacebar
    }
    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
}


var attackTouchIdx = null;

function onTouchStart(evt){
    joysticksFaded = false;
    joystickLastTouch = Date.now();
    evt.preventDefault();
    var rect = gameCanvas.getBoundingClientRect();
    var touch = evt.changedTouches[0];
    var touchX = (((touch.pageX - rect.left)/newWidth)*gameCanvas.width);
    var touchY = (((touch.pageY - rect.top )/newHeight)*gameCanvas.height);
    
    if(touchX <= gameCanvas.width/2){
        joystickMovement = new Joystick(touchX,touchY);
        if(joystickMovement.touchIdx == null){
            joystickMovement.touchIdx = touch.identifier;
            joystickMovement.onDown(touchX,touchY);
        }
    }
    
    if(touchX >= gameCanvas.width/2) {
        attack = true;
        attackTouchIdx = touch.identifier;
        server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
        /*
        if(joystickCamera.touchIdx == null){
            joystickCamera.touchIdx = touch.identifier;
            joystickCamera.onDown(touchX,touchY);
            server.emit('mousemove',{x:touchX,y:touchY});
        }
        */
    }
}
function onTouchEnd(evt){
    var touchList = evt.changedTouches;
    for(var i=0;i<touchList.length;i++){
        if(touchList[i].identifier == joystickMovement.touchIdx){
            joystickMovement.touchIdx = null;
            cancelMovement();
            joystickMovement.onUp();
            return;
        }

        if(touchList[i].identifier == attackTouchIdx){
            attack = false;
            attackTouchIdx = null;
            server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
        }

        /*
        if(touchList[i].identifier == joystickCamera.touchIdx){
            joystickCamera.touchIdx = null;
            joystickCamera.onUp();
            return;
        }
        */
    }
}
function onTouchMove(evt){
    joystickLastTouch = Date.now();
    joysticksFaded = false;
    evt.preventDefault();
    var touchList = evt.changedTouches;
    var rect = gameCanvas.getBoundingClientRect();
    var touch, touchX,touchY;    
    for(var i=0;i<touchList.length;i++){
        /*
        if(touchList[i].identifier  == joystickCamera.touchIdx){
            touch = touchList[i];
            touchX = (((touch.pageX - rect.left)/newWidth)*gameCanvas.width);
            touchY = (((touch.pageY - rect.top )/newHeight)*gameCanvas.height);
            joystickCamera.onMove(touchX,touchY);

            if(joystickCamera.checkForAttack()){
                //fireGun(joystickCamera.stickX + myShip.x - camera.xOffset,joystickCamera.stickY+ myShip.y - camera.yOffset);
            }
            server.emit('touchaim',{
                x1:joystickCamera.baseX,
                y1:joystickCamera.baseY,
                x2:joystickCamera.stickX,
                y2:joystickCamera.stickY
            });
        }
        */
        if(touchList[i].identifier  == joystickMovement.touchIdx){
            touch = touchList[i];
            touchX = (((touch.pageX - rect.left)/newWidth)*gameCanvas.width);
            touchY = (((touch.pageY - rect.top )/newHeight)*gameCanvas.height);
            joystickMovement.onMove(touchX,touchY);
            touchMovement();
        }
    }
}

const isTouchDevice = () => {
    return window.matchMedia("(pointer: coarse)").matches
}

function touchMovement(){
    moveForward = joystickMovement.up();
    moveBackward = joystickMovement.down();
    turnRight = joystickMovement.right();
    turnLeft = joystickMovement.left();
    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward});
}

function cancelMovement(evt){
    turnLeft = false;
    turnRight = false;
    moveForward = false;
    moveBackward = false;
    attack = false;
    server.emit('movement',{turnLeft:false,moveForward:false,turnRight:false,moveBackward:false,attack:false});
}

function openEmojiWindow(){
    if(menuOpen == false){
        emojiMenu.style.transform="scale(2)";
        menuOpen = true;
    }
    
}
function closeEmojiWindow(source) {
    if(menuOpen){
        emojiMenu.style.transform="scale(0)"; 
        menuOpen = false;
    }
    if(source == "cancel"){
        return;
    }
    var emoji = String(source).trim();
    sendEmoji(emoji);
}

function moveEmojiMenu(x,y){
    emojiMenu.style.left = x + "px";
    emojiMenu.style.top = y + "px";
}