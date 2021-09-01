var angleFromPlayer = 0;
var menuOpen = false;

var gamePadA = null;

var isTouchScreen = false,
    virtualButtonList = null,
    joystickMovement = null,
    joystickCamera = null,
    squareButton = null,
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

    isTouchScreen = isTouchDevice();
    if(isTouchScreen){
        setupVirtualbuttons();
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

function setupVirtualbuttons(){
    virtualButtonList = [];
    joystickMovement = new Joystick(0,0,false);
    joystickCamera = new Joystick(0,0,false);
    squareButton = new Button(0,0,100,200,0);

    //var rect = gameCanvas.getBoundingClientRect();
    var leftRect = new VirtualButton(0,50,world.width/4,world.height,false);
    //var rightRect = new VirtualButton(0 + rect.width - (rect.width/4),50,rect.width/4,rect.height,true);
    var topRightRect = new VirtualButton(0 + world.width - (world.width/4),50,world.width/4,world.height/2,false);
    var bottomRightRect = new VirtualButton(0 + world.width - (world.width/4),topRightRect.bottom,world.width/4,world.height/2,false);
    //var bottomCenterRect = new VirtualButton(leftRect.right,rect.height - (rect.height/4),rightRect.left-leftRect.right,200,true);

    virtualButtonList.push({button:joystickMovement,bound:leftRect});
    virtualButtonList.push({button:joystickCamera,bound:bottomRightRect});
    virtualButtonList.push({button:squareButton,bound:topRightRect});


    for(var i=0;i<virtualButtonList.length;i++){
        virtualButtonList[i].button.baseX = virtualButtonList[i].bound.x + virtualButtonList[i].bound.width/2 - virtualButtonList[i].button.width/2;
        virtualButtonList[i].button.stickX = virtualButtonList[i].bound.x + virtualButtonList[i].bound.width/2 - virtualButtonList[i].button.width/2;
        virtualButtonList[i].button.baseY = virtualButtonList[i].bound.y +virtualButtonList[i].bound.height/2 - virtualButtonList[i].button.height/2;
        virtualButtonList[i].button.stickY = virtualButtonList[i].bound.y +virtualButtonList[i].bound.height/2 - virtualButtonList[i].button.height/2;
    }
}


function onTouchStart(evt){
    joysticksFaded = false;
    joystickLastTouch = Date.now();
    var rect = gameCanvas.getBoundingClientRect();
    var touch = evt.changedTouches[0];
    var touchX = (((touch.pageX - rect.left)/newWidth)*gameCanvas.width);
    var touchY = (((touch.pageY - rect.top )/newHeight)*gameCanvas.height);

    for(var i=0;i<virtualButtonList.length;i++){
        if(virtualButtonList[i].bound.pointInRect(touchX,touchY)){
            var button = virtualButtonList[i].button;
            if(button.touchIdx == null){
                button.touchIdx = touch.identifier;
                button.onDown(touchX,touchY);

                if(button == squareButton){
                    attack = true;
                    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
                }
            }
        }

    }
}
function onTouchEnd(evt){
    var touchList = evt.changedTouches;
    for(var i=0;i<touchList.length;i++){
        for(var j=0;j<virtualButtonList.length;j++){
            var button = virtualButtonList[j].button;
            if(touchList[i].identifier == button.touchIdx){
                if(button == joystickMovement){
                    cancelMovement();
                }
                if(button == squareButton){
                    attack = false;
                    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
                }
                button.touchIdx = null;
                button.onUp();
            }
        }
    }
}
function onTouchMove(evt){
    joystickLastTouch = Date.now();
    joysticksFaded = false;
    var touchList = evt.changedTouches;
    var rect = gameCanvas.getBoundingClientRect();
    var touch, touchX,touchY;    
    for(var i=0;i<touchList.length;i++){

        if(touchList[i].identifier  == joystickCamera.touchIdx){
            touch = touchList[i];
            touchX = (((touch.pageX - rect.left)/newWidth)*gameCanvas.width);
            touchY = (((touch.pageY - rect.top )/newHeight)*gameCanvas.height);
            joystickCamera.onMove(touchX,touchY);
            server.emit('mousemove',{x:touchX,y:touchY});
        }
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
    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
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