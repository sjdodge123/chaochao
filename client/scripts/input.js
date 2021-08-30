var angleFromPlayer = 0;
var menuOpen = false;

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
function haltInput(evt){
    turnLeft = false;
    moveForward = false;
    turnRight = false;
    moveBackward = false;
    attack = false;
    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward,attack:attack});
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