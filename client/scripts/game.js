var server = null,
    interval = null,
    clientList = null,
    playerList = null,
    myPlayer = null,
    myID = null,
    gameContext = null,
    gameCanvas = null,
    newWidth = 0,
    newHeight = 0,
    gameRunning = null;

    //Input Vars
    var iAmFiring = false,
    moveForward = false,
    moveBackward = false,
    turnLeft = false,
    turnRight = false,
    mousex = null,
	mousey = null;

var then = Date.now(),
    dt;

window.onload = function() {
    server = clientConnect();
    setupPage();
}

function setupPage(){

    $("#guestPlay").on("submit", function () {
        enterLobby();
        return false;
    });

    window.addEventListener('resize', resize, false);
    window.requestAnimFrame = (function(){
        return  window.requestAnimationFrame       ||
                window.webkitRequestAnimationFrame ||
                window.mozRequestAnimationFrame    ||
                function( callback ){
                  window.setTimeout(callback, 1000 / 30);
                };
      })();

    gameCanvas = document.getElementById('gameCanvas');
    gameContext = gameCanvas.getContext('2d');
}

function enterLobby(){
    $('#main').hide();
    $('#gameWindow').show();
    clientSendStart();
    gameRunning = true;
    init();
}
function init(){
    animloop();
    window.addEventListener("mousemove", calcMousePos, false);
    window.addEventListener("mousedown", handleClick, false);
    window.addEventListener("mouseup", handleUnClick, false);
    window.addEventListener("keydown", keyDown, false);
    window.addEventListener("keyup", keyUp, false);
    window.addEventListener('contextmenu', function(ev) {
        ev.preventDefault();
        return false;
    }, false);
}
function animloop(){
    if(gameRunning){
        var now = Date.now();
    	dt = now - then;
        gameLoop(dt);
    	then = now;
    	requestAnimFrame(animloop);
    }
}
function gameLoop(dt){
    drawObjects(dt);
    //updateGameboard();
    //drawBackground();
    //drawHUD();
}

function drawObjects(dt){
    drawPlayers(dt);
}

function drawPlayers(dt){
    for(var id in playerList){
       var player = playerList[id];
       if(player == null){
           continue;
       }
       drawPlayer(player);
    }
}
function drawPlayer(player){
    gameContext.beginPath();
    gameContext.arc(player.x, player.y, player.radius, 0, 2 * Math.PI);
    gameContext.fillStyle = player.color;
    gameContext.fill();
    gameContext.lineWidth = 1.5;
    gameContext.strokeStyle = "black";
    gameContext.stroke();
}

function resize(){
    var viewport = {width:window.innerWidth,height:window.innerHeight};
    var scaleToFitX = viewport.width / gameCanvas.width;
    var scaleToFitY = viewport.height / gameCanvas.height;
    var currentScreenRatio = viewport.width/viewport.height;
    var optimalRatio = Math.min(scaleToFitX,scaleToFitY);

    if(currentScreenRatio >= 1.77 && currentScreenRatio <= 1.79){
        newWidth = viewport.width;
        newHeight = viewport.height;
    } else{
        newWidth = gameCanvas.width * optimalRatio;
        newHeight = gameCanvas.height * optimalRatio;
    }

    gameCanvas.style.width = newWidth + "px";
    gameCanvas.style.height = newHeight + "px";
    //backgroundImage.style.width = newWidth + "px";
    //backgroundImage.style.height = newHeight + "px";
    //hud.style.width = newWidth + "px";
    //hud.style.height = newHeight + "px";
}

function calcMousePos(evt){
    evt.preventDefault();
    var rect = gameCanvas.getBoundingClientRect();
    if(myPlayer != null){
        mouseX = (((evt.pageX - rect.left)/newWidth)*gameCanvas.width)+ myPlayer.x;
        mouseY = (((evt.pageY - rect.top )/newHeight)*gameCanvas.height) + myPlayer.y;
        server.emit('mousemove',{x:mouseX,y:mouseY});
        setMousePos(mouseX,mouseY);
    }
}

function setMousePos(x,y){
	mousex = x;
	mousey = y;
}

function handleClick(event){
    switch(event.which){
        case 1:{
            iAmFiring = true;
            break;
        }
    }
    event.preventDefault();
}
function handleUnClick(event){
    switch(event.which){
        case 1:{
            iAmFiring = false;
            server.emit("stopFire");
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
    }
    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward});
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
    }
    server.emit('movement',{turnLeft:turnLeft,moveForward:moveForward,turnRight:turnRight,moveBackward:moveBackward});
}




