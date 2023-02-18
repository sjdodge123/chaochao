var server = null,
    interval = null,
    gameLength = null,
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
    nextMapPreview = null,
    nextMapThumbnail = null,
    round = 0,
    timeOutChecker = null,
    currentState = null,
    gameRunning = null;

var emojiMenu = document.getElementById("emojiMenu");
var canvasWindow = document.getElementById("mapContainer");
var exitIcon = document.getElementById("exitIcon");

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

$(function () {
    server = clientConnect();
    setupPage();
})

function setupPage() {
    window.addEventListener('blur', cancelMovement);
    window.addEventListener('resize', resize, false);
    window.requestAnimFrame = (function () {
        return window.requestAnimationFrame ||
            window.webkitRequestAnimationFrame ||
            window.mozRequestAnimationFrame ||
            function (callback) {
                window.setTimeout(callback, 1000 / 30);
            };
    })();

    gameCanvas = document.getElementById('gameCanvas');
    gameContext = gameCanvas.getContext('2d');
    enterLobby();

}

function enterLobby() {
    $('#main').hide();
    $('#gameWindow').show();
    resize();
    var playParams = new URLSearchParams(window.location.search);
    if (playParams.has("gameid")) {
        var paramGameID = playParams.get("gameid");
        clientSendStart(paramGameID);
    } else {
        clientSendStart(-1);
    }

}
function init() {
    timeOutChecker = setInterval(checkForTimeout, 1000);
    animloop();
    initEventHandlers();
}
function animloop() {
    if (gameRunning) {
        var now = Date.now();
        dt = now - then;
        gameLoop(dt);
        then = now;
        requestAnimFrame(animloop);
    }
}
function gameLoop(dt) {
    drawObjects(dt);
    updateGameboard(dt);
}


function resize() {
    var gameWindowRect = canvasWindow.getBoundingClientRect();
    var viewport = { width: gameWindowRect.width, height: gameWindowRect.height };
    var scaleToFitX = viewport.width / gameCanvas.width;
    var scaleToFitY = viewport.height / gameCanvas.height;
    var currentScreenRatio = viewport.width / viewport.height;
    var optimalRatio = Math.min(scaleToFitX, scaleToFitY);

    if (currentScreenRatio >= 1.77 && currentScreenRatio <= 1.79) {
        newWidth = viewport.width;
        newHeight = viewport.height;
    } else {
        newWidth = gameCanvas.width * optimalRatio;
        newHeight = gameCanvas.height * optimalRatio;
    }
    gameCanvas.style.width = newWidth + "px";
    gameCanvas.style.height = newHeight + "px";
}

function goFullScreen() {
    if (window.document.fullscreenElement) {
        window.document.exitFullscreen().then(function () {
            resize();
        });
    } else {
        gameWindow.requestFullscreen().then(function () {
            resize();
        }).catch(function (e) {
            console.log(e);
        });
    }

}


