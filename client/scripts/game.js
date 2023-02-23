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
    loading = true,
    gameRunning = null;


var musicControl = $('#musicControl');
var masterControl = $('#masterControl');
var progressContainer = $('#progressContainer');
var progressBar = document.getElementById("progressBar");
var emojiMenu = document.getElementById("emojiMenu");
var canvasWindow = document.getElementById("mapContainer");
var exitIconID = document.getElementById("exitIcon");

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

    musicControl.on("click", function (e) {
        if (musicVolume > 0) {
            musicVolume = 0;
            volumeChange();
            $("#musicControl").html('<i class="music-btn fas fa-music"></i>  [<i class="music-btn fa fa-ban" aria-hidden="true"></i>]');
        } else {
            musicVolume = 1;
            volumeChange();
            $("#musicControl").html('<i class="music-btn fas fa-music"></i>  [<i class="music-btn fa fa-volume-up" aria-hidden="true"></i>]');
        }
    });
    masterControl.on("click", function (e) {
        if (masterVolume > 0) {
            masterVolume = 0;
            volumeChange();
            $("#masterControl").html('<i class="music-btn fa fa-gamepad" aria-hidden="true"></i>  [<i class="music-btn fa fa-ban" aria-hidden="true"></i>]');
        } else {
            masterVolume = 1;
            volumeChange();
            $("#masterControl").html('<i class="music-btn fa fa-gamepad" aria-hidden="true"></i>  [<i class="music-btn fa fa-volume-up" aria-hidden="true"></i>]');
        }
    });
    volumeChange();
    gameCanvas = document.getElementById('gameCanvas');
    gameContext = gameCanvas.getContext('2d');
    init();
    $.when.apply($, promises).then(function () {
        enterLobby();
    });

}

function enterLobby() {
    loading = false;
    progressContainer.hide();
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
    if (loading == false) {
        timeOutChecker = setInterval(checkForTimeout, 1000);
    }
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
    if (loading == true) {
        var contentLoaded = true;
        var loadedCount = 0;
        var totalToLoad = promises.length;
        for (var i = 0; i < promises.length; i++) {
            if (promises[i].status != 200) {
                contentLoaded = false;
                continue;
            }
            if (promises[i].status == 200) {
                loadedCount++;
            }
        }
        progressBar.style.width = ((loadedCount / totalToLoad) * 100 + "%");
        //console.log("Loaded (" + loadedCount + " / " + totalToLoad + ")");
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

    if (window.document.fullscreenElement) {
        newWidth = viewport.width;
        newHeight = viewport.height;
    } else {
        newWidth = gameCanvas.width * optimalRatio / 1.1;
        newHeight = gameCanvas.height * optimalRatio / 1.1;
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


