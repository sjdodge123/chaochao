var gameMuted = false;
var playingSounds = [];
var masterVolume = 1,
    effectsVolume = 1,
    musicVolume = 1;

var calmBackgroundMusicList = [];
var excitingBackgroundMusicList = [];
var brutalBackgroundMusicList = [];
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
var bombBounce = new Audio("./assets/sounds/bomb-bounce.mp3");
var blindSound = new Audio("./assets/sounds/blind.mp3");
var abilityFizzle = new Audio("./assets/sounds/fizzle.mp3");
var teleportSound = new Audio("./assets/sounds/teleport.mp3");
var teleportWarnSound = new Audio("./assets/sounds/teleport_warn.mp3");
var brutalRoundSound = new Audio("./assets/sounds/brutalround.mp3");
var volcanoErupt = new Audio("./assets/sounds/volcano-erupt.mp3");
var speedBuff = new Audio("./assets/sounds/speedBuff.mp3");
var speedDebuff = new Audio("./assets/sounds/speed_downgrade.mp3");
var tileSwap = new Audio("./assets/sounds/tileswap.mp3");
var iceCannon = new Audio("./assets/sounds/iceCannon.mp3");
var iceExplosion = new Audio("./assets/sounds/iceExplosion.mp3");
var lavaExplosion = new Audio("./assets/sounds/lavaExplosion.mp3");
var cutSound = new Audio("./assets/sounds/thwack.mp3");

var newZombie = new Audio("./assets/sounds/newzombie.mp3");
var zombieHit = new Audio("./assets/sounds/zombiehit.mp3");
var zombieSwing = new Audio("./assets/sounds/zombieswing.mp3");

var nearVictorySound = new Audio("./assets/sounds/rise.mp3");
var fallFromVictorySound = new Audio("./assets/sounds/reverserise.mp3");


//Anouncer
var firstBlood = new Audio("./assets/sounds/firstBlood.mp3");
var doubleKill = new Audio("./assets/sounds/doubleKill.mp3");
var tripleKill = new Audio("./assets/sounds/tripleKill.mp3");
var megaKill = new Audio("./assets/sounds/megaKill.mp3");
var killingSpree = new Audio("./assets/sounds/killingSpree.mp3");
var rampage = new Audio("./assets/sounds/rampage.mp3");
var godLike = new Audio("./assets/sounds/godLike.mp3");

var lobbyMusic = new Audio("./assets/sounds/lobbymusic.mp3");
var gameStart = new Audio("./assets/sounds/gamestart.mp3");

var slowstride = new Audio("./assets/sounds/slowstride.mp3");
var slowpipes = new Audio("./assets/sounds/slow-pipes.mp3");

calmBackgroundMusicList.push(slowstride);
calmBackgroundMusicList.push(slowpipes);

var therush = new Audio("./assets/sounds/the-rush.mp3");
var beastv2 = new Audio("./assets/sounds/beastv2.mp3");
var mindInMotion = new Audio("./assets/sounds/mind_in_motion.mp3");
var bumpinbits1 = new Audio("./assets/sounds/bumpinbits1.mp3");
var bumpinbits2 = new Audio("./assets/sounds/bumpinbits2.mp3");
var bumpinbits3 = new Audio("./assets/sounds/bumpinbits3.mp3");
var bumpinbits4 = new Audio("./assets/sounds/bumpinbits4.mp3");
var bumpinbits5 = new Audio("./assets/sounds/bumpinbits5.mp3");

excitingBackgroundMusicList.push(mindInMotion);
excitingBackgroundMusicList.push(therush);
excitingBackgroundMusicList.push(beastv2);
excitingBackgroundMusicList.push(bumpinbits1);
excitingBackgroundMusicList.push(bumpinbits2);
excitingBackgroundMusicList.push(bumpinbits3);
excitingBackgroundMusicList.push(bumpinbits4);
excitingBackgroundMusicList.push(bumpinbits5);

var heavyfabric = new Audio("./assets/sounds/heavyfabric.mp3");
var desperationSetsIn = new Audio("./assets/sounds/DesperationSetsIn.mp3");
var horrorLoop = new Audio("./assets/sounds/HorrorLoop.mp3");

brutalBackgroundMusicList.push(horrorLoop);
brutalBackgroundMusicList.push(desperationSetsIn);
brutalBackgroundMusicList.push(heavyfabric);


function volumeChange() {
    cutSound.volume = .15 * masterVolume;
    godLike.volume = .1 * masterVolume;
    rampage.volume = .1 * masterVolume;
    killingSpree.volume = .1 * masterVolume;
    megaKill.volume = .1 * masterVolume;
    tripleKill.volume = .1 * masterVolume;
    doubleKill.volume = .1 * masterVolume;
    firstBlood.volume = .1 * masterVolume;
    lavaExplosion.volume = .75 * masterVolume;
    iceExplosion.volume = .25 * masterVolume;
    iceCannon.volume = .25 * masterVolume;
    tileSwap.volume = .5 * masterVolume;
    speedBuff.volume = 0.25 * masterVolume;
    speedDebuff.volume = 0.05 * masterVolume;
    volcanoErupt.volume = 0.05 * masterVolume;
    brutalRoundSound.volume = 0.35 * masterVolume;
    bombBounce.volume = 0.75 * masterVolume;
    abilityFizzle.volume = .65 * masterVolume;
    teleportWarnSound.volume = .025 * masterVolume;
    countDownA.volume = .05 * masterVolume;
    countDownB.volume = .05 * masterVolume;
    lavaCollapse.volume = .1 * masterVolume;
    meleeSound.volume = .05 * masterVolume;
    meleeHitSound.volume = .016 * masterVolume;
    gameOverSound.volume = .5 * masterVolume;
    nearVictorySound.volume = .3 * masterVolume;
    fallFromVictorySound.volume = .15 * masterVolume;
    collectItem.volume = .4 * masterVolume;
    bombShot.volume = .2 * masterVolume;
    bombExplosion.volume = .2 * masterVolume;
    playerFinished.volume = .3 * masterVolume;
    blindSound.volume = .4 * masterVolume;
    teleportSound.volume = .05 * masterVolume;
    newZombie.volume = .65 * masterVolume;
    zombieHit.volume = .25 * masterVolume;
    zombieSwing.volume = .35 * masterVolume;

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

    mindInMotion.volume = .035 * masterVolume * musicVolume
    mindInMotion.targetVolume = mindInMotion.volume;

    desperationSetsIn.volume = .015 * masterVolume * musicVolume
    desperationSetsIn.targetVolume = desperationSetsIn.volume;

    horrorLoop.volume = .015 * masterVolume * musicVolume
    horrorLoop.targetVolume = horrorLoop.volume;

    bumpinbits1.volume = .05 * masterVolume * musicVolume
    bumpinbits1.targetVolume = bumpinbits1.volume;

    bumpinbits2.volume = .05 * masterVolume * musicVolume
    bumpinbits2.targetVolume = bumpinbits2.volume;

    bumpinbits3.volume = .05 * masterVolume * musicVolume
    bumpinbits3.targetVolume = bumpinbits3.volume;

    bumpinbits4.volume = .05 * masterVolume * musicVolume
    bumpinbits4.targetVolume = bumpinbits4.volume;

    bumpinbits5.volume = .05 * masterVolume * musicVolume
    bumpinbits5.targetVolume = bumpinbits5.volume;
}


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
        if (brutalRound == false) {
            changeBackgroundMusic(calmBackgroundMusicList);
        } else {
            changeBackgroundMusic(brutalBackgroundMusicList);
        }
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
    if (musicList === brutalBackgroundMusicList && isBrutalPlaylist(currentBackgroundMusic)) {
        return;
    }
    if (musicList === calmBackgroundMusicList && isCalmingPlaylist(currentBackgroundMusic)) {
        return;
    }
    if (musicList === excitingBackgroundMusicList && isExcitingPlaylist(currentBackgroundMusic)) {
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

function isExcitingPlaylist(sound) {
    for (var i = 0; i < excitingBackgroundMusicList.length; i++) {
        if (sound === excitingBackgroundMusicList[i]) {
            return true;
        }
    }
    return false;
}

function isBrutalPlaylist(sound) {
    for (var i = 0; i < brutalBackgroundMusicList.length; i++) {
        if (sound === brutalBackgroundMusicList[i]) {
            return true;
        }
    }
    return false;
}

function isCalmingPlaylist(sound) {
    for (var i = 0; i < calmBackgroundMusicList.length; i++) {
        if (sound === calmBackgroundMusicList[i]) {
            return true;
        }
    }
    return false;
}