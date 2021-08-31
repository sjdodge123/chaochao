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
    timeOutChecker = null,
    currentState = null,
    gameRunning = null;

    var emojiMenu = document.getElementById("emojiMenu");
    var gameWindow = document.getElementById("gameWindow");

    //Input Vars
    var attack = false,
    moveForward = false,
    moveBackward = false,
    turnLeft = false,
    turnRight = false,
    drawChatWheel = false,
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
    window.addEventListener('blur', cancelMovement);
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
    resize();
    clientSendStart();
}
function init(){
    timeOutChecker = setInterval(checkForTimeout,1000);
    animloop();
    initEventHandlers();
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
}


function resize(){
    var gameWindowRect = gameWindow.getBoundingClientRect();
    var viewport = {width:gameWindowRect.width,height:gameWindowRect.height};
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
    /*
    var canvasRect = gameCanvas.getBoundingClientRect();
    var emojiMenuRect = emojiMenu.getBoundingClientRect();
    emojiMenu.style.left = canvasRect.x + newWidth/2 +"px";
    emojiMenu.style.top = canvasRect.y + newHeight - 175 +"px";
    */
}

function goFullScreen(){
    if (gameCanvas.fullscreenElement) {
        gameCanvas.exitFullscreen();
      } else {
        gameCanvas.requestFullscreen();
      }
      /*
    if(gameCanvas.requestFullScreen)
        gameCanvas.requestFullScreen();
    else if(gameCanvas.webkitRequestFullScreen)
        gameCanvas.webkitRequestFullScreen();
    else if(gameCanvas.mozRequestFullScreen)
        gameCanvas.mozRequestFullScreen();
    */
}


