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
    maps = [],
    oldNotches = {},
    timeOutChecker = null;
    currentState = null;
    gameRunning = null;

    //Input Vars
    var attack = false,
    moveForward = false,
    moveBackward = false,
    turnLeft = false,
    turnRight = false,
    mousex = null,
	mousey = null;

var then = Date.now(),
    dt;

$(function(){
    server = clientConnect();
    setupPage();
});

function setupPage(){
    
    $("#guestPlay").on("submit", function () {
        enterLobby();
        return false;
    });

    $("#createButton").on("click", function () {
        window.location = '/create.html';
        return false;
    });
    window.addEventListener('blur', haltInput);
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
    resize();
}

function enterLobby(){
    $('#main').hide();
    $('#gameWindow').show();
    clientSendStart();
}
function init(){
    timeOutChecker = setInterval(checkForTimeout,1000);
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
    updateGameboard(dt);
    //drawBackground();
    //drawHUD();
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


