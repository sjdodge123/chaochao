var gameMuted = false;
var playingSounds = [];
var masterVolume = 1,
    effectsVolume = 1,
    musicVolume = 1;

var calmBackgroundMusicList = [];
var excitingBackgroundMusicList = [];
var currentBackgroundMusic = null;
var backgroundBuildTimer = null;

var playerJoinSound = new Audio("./assets/sounds/pleasing-bell.mp3");
var playerDiedSound = new Audio("./assets/sounds/TailWhip.mp3");
var countDownA = new Audio("./assets/sounds/countdown-a.mp3");
var countDownB = new Audio("./assets/sounds/countdown-b.mp3");
var lavaCollapse = new Audio("./assets/sounds/doomed.mp3");
var meleeSound = new Audio("./assets/sounds/melee-sound.mp3");
var meleeHitSound = new Audio("./assets/sounds/bing.mp3");
var gameOverSound = new Audio("./assets/sounds/gameover.mp3");
var collectItem = new Audio("./assets/sounds/collectitem.mp3");
var playerFinished = new Audio("./assets/sounds/playerfinished.mp3");
var bombShot = new Audio("./assets/sounds/bomb-shot.mp3");
var bombExplosion = new Audio("./assets/sounds/bomb-explosion.mp3");
var blindSound = new Audio("./assets/sounds/blind.mp3");
var abilityFizzle = new Audio("./assets/sounds/fizzle.mp3");
var teleportSound = new Audio("./assets/sounds/teleport.mp3");
var teleportWarnSound = new Audio("./assets/sounds/teleport_warn.mp3");


var nearVictorySound = new Audio("./assets/sounds/rise.mp3");
var fallFromVictorySound = new Audio("./assets/sounds/reverserise.mp3");


var lobbyMusic = new Audio("./assets/sounds/lobbymusic.mp3");
var gameStart = new Audio("./assets/sounds/gamestart.mp3");

var slowstride = new Audio("./assets/sounds/slowstride.mp3");
var slowpipes = new Audio("./assets/sounds/slow-pipes.mp3");
var heavyfabric = new Audio("./assets/sounds/heavyfabric.mp3");
calmBackgroundMusicList.push(slowstride);
calmBackgroundMusicList.push(slowpipes);


var therush = new Audio("./assets/sounds/the-rush.mp3");
var beastv2 = new Audio("./assets/sounds/beastv2.mp3");
excitingBackgroundMusicList.push(therush);
excitingBackgroundMusicList.push(beastv2);
excitingBackgroundMusicList.push(heavyfabric);

abilityFizzle.volume = .85 * masterVolume;
teleportWarnSound.volume = .025 * masterVolume;
countDownA.volume = .05 * masterVolume;
countDownB.volume = .05 * masterVolume;
lavaCollapse.volume = .1 * masterVolume;
meleeSound.volume = .05 * masterVolume;
meleeHitSound.volume = .025 * masterVolume;
gameOverSound.volume = .5 * masterVolume;
nearVictorySound.volume = .3 * masterVolume;
fallFromVictorySound.volume = .15 * masterVolume;
collectItem.volume = .4 * masterVolume;
bombShot.volume = .2 * masterVolume;
bombExplosion.volume = .2 * masterVolume;
playerFinished.volume = .3 * masterVolume;
blindSound.volume = .4 * masterVolume;
teleportSound.volume = .05 * masterVolume;

lobbyMusic.volume = .05 * masterVolume * musicVolume;
lobbyMusic.loop = true;
gameStart.volume = .2 * masterVolume;

heavyfabric.volume = .030 * masterVolume * musicVolume;
heavyfabric.targetVolume = heavyfabric.volume;

slowpipes.volume = .015 * masterVolume * musicVolume;
slowpipes.targetVolume = slowpipes.volume;

slowstride.volume = .05 * masterVolume * musicVolume;
slowstride.targetVolume = slowstride.volume;

therush.volume = .025 * masterVolume * musicVolume;
therush.targetVolume = therush.volume;

beastv2.volume = .035 * masterVolume * musicVolume;
beastv2.targetVolume = beastv2.volume;

function playSound(sound) {
    playingSounds.push(sound);
    if (!gameMuted) {
        if (sound.currentTime > 0) {
            sound.currentTime = 0;
        }
        sound.play();
    }
}

function stopSound(sound) {
    var index = playingSounds.indexOf(sound);
    if (index != -1) {
        playingSounds.splice(index, 1);
    }
    if (!gameMuted) {
        sound.pause();
        if (sound.currentTime > 0) {
            sound.currentTime = 0;
        }
    }
}

function stopAllSounds() {
    for (var i = 0; i < playingSounds.length; i++) {
        playingSounds[i].pause();
    }
}

function playBackgroundSound() {
    //Count all players near victory
    for (var id in playerList) {
        if (playerList[id].nearVictory == true) {
            playersNearVictory.push(id);
        } else {
            playersNearVictory.splice(playersNearVictory.indexOf(id), 1);
        }
    }
    //Not a match point, change to calming music
    if (playersNearVictory.length < 1) {
        changeBackgroundMusic(calmBackgroundMusicList);
        return;
    }
    //If match point, change to exciting music
    if (playersNearVictory.length > 0) {
        changeBackgroundMusic(excitingBackgroundMusicList);
        return;
    }
}

function playSoundAfterFinish(sound) {
    playingSounds.push(sound);
    if (!gameMuted) {
        if (sound.currentTime > 0 && !sound.ended) {
            return;
        } else {
            sound.currentTime = 0;
        }
        sound.play();
    }
}

function changeBackgroundMusic(musicList) {
    //No existing background sounds, set musiclist provided
    if (currentBackgroundMusic == null || currentBackgroundMusic.ended) {
        currentBackgroundMusic = musicList[getRandomInt(0, musicList.length - 1)];
        fadeSoundIn(currentBackgroundMusic);
        playSound(currentBackgroundMusic);
        return;
    }
    //Existing background music playing from provided musiclist, continue
    if (musicList === calmBackgroundMusicList && isCalmingPlaylist(currentBackgroundMusic)) {
        return;
    }

    if (musicList === excitingBackgroundMusicList && !isCalmingPlaylist(currentBackgroundMusic)) {
        return;
    }
    //Existing background music does not match playlist, fade out and change playlist
    fadeSoundOut(currentBackgroundMusic);
    currentBackgroundMusic = musicList[getRandomInt(0, musicList.length - 1)];
    fadeSoundIn(currentBackgroundMusic);
    playSound(currentBackgroundMusic);
}

function fadeSoundIn(sound) {
    sound.volume = .001 * masterVolume;
    var backgroundBuildTimer = setInterval(function () {
        if (sound.volume < sound.targetVolume) {
            sound.volume = sound.volume * 1.2 * masterVolume * musicVolume;
        } else {
            sound.volume = sound.targetVolume;
            clearInterval(backgroundBuildTimer);
        }
    }, 500);
}

function fadeSoundOut(sound) {
    if (sound != null) {
        var backGroundFadeTimer = setInterval(function () {
            if (sound.volume > 0.0025) {
                sound.volume *= .95;
            } else {
                stopSound(sound);
                clearInterval(backGroundFadeTimer);
            }
        }, 500);
    }
}

function lookupCurrentBackgroundSound() {

}

function isCalmingPlaylist(sound) {
    for (var i = 0; i < calmBackgroundMusicList.length; i++) {
        if (sound === calmBackgroundMusicList[i]) {
            return true;
        }
    }
    return false;
}