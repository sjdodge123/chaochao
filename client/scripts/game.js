// DEBUG: set to true to log network events and state changes. Defaults to false.
var DEBUG_NETWORK = false;
function debugLog() {
    if (!DEBUG_NETWORK) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[debug]");
    console.log.apply(console, args);
}

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
// Read available space from #gameWindow (the section-filling flex
// container); #mapContainer is sized inside it to match the canvas.
var canvasWindow = document.getElementById("gameWindow");
var mapContainer = document.getElementById("mapContainer");
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

// --- PHASE 1 SPIKE: local two-player proof (gated behind ?spike2p=1) ---
// Opens a SECOND, independent Socket.IO connection from this one tab and joins
// it into the same room as the primary player, to prove Approach A end-to-end:
// two forceNew sockets => two distinct server players in one room, with a
// gamepad routed to player #2. Throwaway scaffolding; Phase 2 generalises it
// into a per-slot localPlayers[0..N-1] table. When the flag is absent, none of
// this runs and behaviour is identical to today (N=1).
function spikeTwoPlayers() {
    return new URLSearchParams(window.location.search).has('spike2p');
}
var spikePlayer2 = { socket: null, myID: null, joined: false };

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
    // Use .always() (not .then()) so a single 404 / CORS error in the
    // preload list doesn't leave the lobby never being entered. Once
    // every XHR has settled (success or failure), wait on the image
    // decodes too — otherwise loadPatterns() in the gameState handler
    // builds empty CanvasPatterns and the board renders transparent for
    // mid-game joiners. animloop also surfaces a "still loading?" prompt
    // after LOADING_TIMEOUT_MS as a last-resort recovery path.
    $.when.apply($, promises).always(function () {
        tileImagesReady.then(enterLobby);
    });
}

var loadingStartedAt = Date.now();
var LOADING_TIMEOUT_MS = 20000;
var loadingTimeoutShown = false;

function enterLobby() {
    if (inLobby == true) {
        return;
    }
    inLobby = true;
    loading = false;
    progressContainer.hide();
    $('#main').hide();
    $('#gameWindow').css('display', 'flex');
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
    initGamepad();
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
        for (var i = 0; i < promises.length; i++) {
            // readyState 4 = DONE for any settled XHR (200, 304, 404, etc).
            // Counting only status==200 would stall the bar on 304s and
            // mask CDN cache hits as "still loading".
            if (promises[i].readyState === 4) loadedCount++;
        }
        // Roll the tile/ability Image() decodes into the loading bar so
        // it reflects what we actually wait on before entering the game.
        loadedCount += requiredImagesLoaded;
        var totalToLoad = promises.length + requiredImages.length;
        progressBar.style.width = ((loadedCount / totalToLoad) * 100 + "%");
        if (loadedCount == totalToLoad) {
            enterLobby();
        } else if (!loadingTimeoutShown && Date.now() - loadingStartedAt > LOADING_TIMEOUT_MS) {
            loadingTimeoutShown = true;
            progressContainer.html('Loading is taking longer than usual. <a href="#" onclick="location.reload();return false;">Refresh the page</a> to retry.');
        }
        requestAnimFrame(animloop);
    }
}
function gameLoop(dt) {
    pollGamepad(dt);
    drawObjects(dt);
    updateGameboard(dt);
}


function resize() {
    var gameWindowRect = canvasWindow.getBoundingClientRect();
    if (gameWindowRect.width === 0 || gameWindowRect.height === 0) return;
    var viewport = { width: gameWindowRect.width, height: gameWindowRect.height };
    var optimalRatio = Math.min(viewport.width / gameCanvas.width, viewport.height / gameCanvas.height);

    if (window.document.fullscreenElement) {
        newWidth = viewport.width;
        newHeight = viewport.height;
    } else {
        // Fit the canvas to the available space at its native 16:9
        // aspect ratio (no padding shrink — the gameWindow flex
        // container provides any breathing room).
        newWidth = gameCanvas.width * optimalRatio;
        newHeight = gameCanvas.height * optimalRatio;
    }

    if (mapContainer != null) {
        mapContainer.style.width = newWidth + "px";
        mapContainer.style.height = newHeight + "px";
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


