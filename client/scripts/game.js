var server = null,
    interval = null,
    gameLength = null,
    clientList = null,
    playerList = null,
    myPlayer = null,
    myID = null,
    gameContext = null,
    gameCanvas = null,
    overlayCanvas = null,
    overlayContext = null,
    newWidth = 0,
    newHeight = 0,
    maps = [],
    oldNotches = {},
    camera,
    nextMapPreview = null,
    nextMapThumbnail = null,
    round = 0,
    timeOutChecker = null,
    currentState = null,
    inLobby = false,
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
    overlayCanvas = document.getElementById('overlayCanvas');
    gameContext = gameCanvas.getContext('2d');
    overlayContext = overlayCanvas.getContext('2d');
    init();
    $.when.apply($, promises).then(function () {
        enterLobby();
    });
}

function enterLobby() {
    if (inLobby == true) {
        return;
    }
    inLobby = true;
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
        var loadedCount = 0;
        var totalToLoad = promises.length;
        for (var i = 0; i < promises.length; i++) {
            if (promises[i].status != 200) {
                continue;
            }
            if (promises[i].status == 200) {
                loadedCount++;
            }
        }

        progressBar.style.width = ((loadedCount / totalToLoad) * 100 + "%");
        //console.log("Loaded (" + loadedCount + " / " + totalToLoad + ")");
        if (loadedCount == totalToLoad) {
            enterLobby();
        }
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
    overlayCanvas.style.width = newWidth + "px";
    overlayCanvas.style.height = newHeight + "px";

    camera = {
        active: false,
        x: gameCanvas.width / 2,
        y: gameCanvas.height / 2,
        width: gameCanvas.width,
        height: gameCanvas.height,
        target: null,
        color: 'yellow',
        padding: 150,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        xOffset: gameCanvas.width / 2,
        yOffset: gameCanvas.height / 2,

        centerOnObject: function (object) {
            if (!this.active) {
                return;
            }
            if (object == null) {
                return;
            }
            this.target = object;
        },

        draw: function () {
            if (!this.active) {
                return;
            }
            gameContext.save();
            gameContext.beginPath();
            gameContext.strokeStyle = this.color;
            gameContext.lineWidth = 5;
            gameContext.rect(this.padding, this.padding, this.width - this.padding * 2, this.height - this.padding * 2);
            gameContext.stroke();
            gameContext.restore();
        },

        getCameraX() {
            if (!this.active) {
                return 0;
            }
            if (this.target == null) {
                return this.xOffset;
            }
            return -this.target.x + this.xOffset;
        },
        getCameraY() {
            if (!this.active) {
                return 0;
            }
            if (this.target == null) {
                return this.yOffset;
            }
            return -this.target.y + this.yOffset;
        },

        inBounds: function (object) {
            if (!this.active) {
                return true;
            }
            if (object == null || object == undefined || this.target == null || this.target == undefined) {
                return false;
            }
            if (object.radius != null) {
                var dx = Math.abs(object.x - this.target.x);
                var dy = Math.abs(object.y - this.target.y);

                if (dx > (this.xOffset - this.padding + object.radius)) { return false; }
                if (dy > (this.yOffset - this.padding + object.radius)) { return false; }

                if (dx <= (this.xOffset - this.padding)) {
                    return true;
                }
                if (dy <= (this.yOffset - this.padding)) {
                    return true;
                }

                var cornerDsq = Math.pow(dx - (this.xOffset - this.padding), 2) + Math.pow(dy - (this.yOffset - this.padding), 2);

                return (cornerDsq <= Math.pow(object.radius, 2));
            }
            else {
                var leftBound = object.x + object.width >= this.target.x - this.xOffset + this.padding;
                var rightBound = object.x - object.width <= this.target.x - this.xOffset + this.width - this.padding;
                var topBound = object.y + object.width >= this.target.y - this.yOffset + this.padding;
                var bottomBound = object.y - object.width <= this.target.y - this.yOffset + this.height - this.padding;

                if (leftBound && rightBound && topBound && bottomBound) {
                    return true;
                }
                return false;
            }


        },
    }
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


