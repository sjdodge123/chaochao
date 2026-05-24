var gameMuted = false;
var playingSounds = new Set();
var fadeTimers = new Map();
var masterVolume = 1,
    effectsVolume = 1,
    musicVolume = 1;
// Lobby tutorial: all SFX play at this fraction of normal while in the lobby (1 = no
// change). Toggled by setLobbySfxDampen() on lobby enter/exit; applied in volumeChange.
var sfxVolumeScalar = 1;
var LOBBY_SFX_SCALAR = 0.2;
function setLobbySfxDampen(on) {
    sfxVolumeScalar = on ? LOBBY_SFX_SCALAR : 1;
    volumeChange();
}

function clearFade(sound) {
    var timer = fadeTimers.get(sound);
    if (timer != null) {
        clearInterval(timer);
        fadeTimers.delete(sound);
    }
}

// Playlists are name-keyed maps (trackName -> Audio) so a server-sent track name
// resolves to the exact same Audio instance that volumeChange() tunes.
var calmBackgroundMusicList = {};
var excitingBackgroundMusicList = {};
var brutalBackgroundMusicList = {};
var backgroundMusicLists = {};
var currentBackgroundMusic = null;
var backgroundBuildTimer = null;
// Set by client.js once the socket exists; lets the server drive the next track
// when one finishes so background music stays continuous and in sync.
var musicTrackEndedHandler = null;

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
var bumperSound = new Audio("./assets/sounds/bumper.mp3");
var blackoutSound = new Audio("./assets/sounds/blackout.mp3");

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

var therush = new Audio("./assets/sounds/the-rush.mp3");
var beastv2 = new Audio("./assets/sounds/beastv2.mp3");
var mindInMotion = new Audio("./assets/sounds/mind_in_motion.mp3");
var bumpinbits1 = new Audio("./assets/sounds/bumpinbits1.mp3");
var bumpinbits2 = new Audio("./assets/sounds/bumpinbits2.mp3");
var bumpinbits3 = new Audio("./assets/sounds/bumpinbits3.mp3");
var bumpinbits4 = new Audio("./assets/sounds/bumpinbits4.mp3");
var bumpinbits5 = new Audio("./assets/sounds/bumpinbits5.mp3");

var heavyfabric = new Audio("./assets/sounds/heavyfabric.mp3");
var desperationSetsIn = new Audio("./assets/sounds/DesperationSetsIn.mp3");
var horrorLoop = new Audio("./assets/sounds/HorrorLoop.mp3");
var depthOfDespair = new Audio("./assets/sounds/depthOfDespair.mp3");

// Register a track under a mood. Keys MUST match the names in config.json "music"
// so a server-sent {mood, track} resolves here. trackName is stamped on the Audio
// so the "ended" listener can report which track finished back to the server.
function registerBackgroundTrack(playlist, mood, name, sound) {
	sound.trackName = name;
	playlist[name] = sound;
	sound.addEventListener("ended", handleBackgroundTrackEnded);
	backgroundMusicLists[mood] = playlist;
}

registerBackgroundTrack(calmBackgroundMusicList, "calm", "slowstride", slowstride);
registerBackgroundTrack(calmBackgroundMusicList, "calm", "slow-pipes", slowpipes);

registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "mind_in_motion", mindInMotion);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "the-rush", therush);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "beastv2", beastv2);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits1", bumpinbits1);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits2", bumpinbits2);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits3", bumpinbits3);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits4", bumpinbits4);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits5", bumpinbits5);

registerBackgroundTrack(brutalBackgroundMusicList, "brutal", "depthOfDespair", depthOfDespair);
registerBackgroundTrack(brutalBackgroundMusicList, "brutal", "HorrorLoop", horrorLoop);
registerBackgroundTrack(brutalBackgroundMusicList, "brutal", "DesperationSetsIn", desperationSetsIn);
registerBackgroundTrack(brutalBackgroundMusicList, "brutal", "heavyfabric", heavyfabric);


function volumeChange() {
    // Single lobby SFX scalar: dampens every sound effect uniformly while in the
    // lobby tutorial (so it reads as practice, not a live round). Music is untouched
    // — only lines that used "* masterVolume;" (SFX) became "* sfx;". sfxVolumeScalar
    // is 1 everywhere except the lobby (see setLobbySfxDampen).
    var sfx = masterVolume * sfxVolumeScalar;
    blackoutSound.volume = .35 * sfx;
    bumperSound.volume = .25 * sfx;
    cutSound.volume = .15 * sfx;
    godLike.volume = .1 * sfx;
    rampage.volume = .1 * sfx;
    killingSpree.volume = .1 * sfx;
    megaKill.volume = .1 * sfx;
    tripleKill.volume = .1 * sfx;
    doubleKill.volume = .1 * sfx;
    firstBlood.volume = .1 * sfx;
    lavaExplosion.volume = .75 * sfx;
    iceExplosion.volume = .25 * sfx;
    iceCannon.volume = .25 * sfx;
    tileSwap.volume = .5 * sfx;
    speedBuff.volume = 0.25 * sfx;
    speedDebuff.volume = 0.05 * sfx;
    volcanoErupt.volume = 0.05 * sfx;
    brutalRoundSound.volume = 0.35 * sfx;
    bombBounce.volume = 0.75 * sfx;
    abilityFizzle.volume = .65 * sfx;
    teleportWarnSound.volume = .025 * sfx;
    countDownA.volume = .05 * sfx;
    countDownB.volume = .05 * sfx;
    lavaCollapse.volume = .1 * sfx;
    meleeSound.volume = .05 * sfx;
    meleeHitSound.volume = .016 * sfx;
    gameOverSound.volume = .5 * sfx;
    nearVictorySound.volume = .3 * sfx;
    fallFromVictorySound.volume = .15 * sfx;
    collectItem.volume = .4 * sfx;
    bombShot.volume = .2 * sfx;
    bombExplosion.volume = .2 * sfx;
    playerFinished.volume = .3 * sfx;
    blindSound.volume = .4 * sfx;
    teleportSound.volume = .05 * sfx;
    newZombie.volume = .65 * sfx;
    zombieHit.volume = .25 * sfx;
    zombieSwing.volume = .35 * sfx;

    lobbyMusic.volume = .05 * masterVolume * musicVolume;
    lobbyMusic.loop = true;
    gameStart.volume = .2 * sfx;

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

    mindInMotion.volume = .035 * masterVolume * musicVolume;
    mindInMotion.targetVolume = mindInMotion.volume;

    desperationSetsIn.volume = .015 * masterVolume * musicVolume;
    desperationSetsIn.targetVolume = desperationSetsIn.volume;

    horrorLoop.volume = .015 * masterVolume * musicVolume;
    horrorLoop.targetVolume = horrorLoop.volume;

    bumpinbits1.volume = .05 * masterVolume * musicVolume;
    bumpinbits1.targetVolume = bumpinbits1.volume;

    bumpinbits2.volume = .05 * masterVolume * musicVolume;
    bumpinbits2.targetVolume = bumpinbits2.volume;

    bumpinbits3.volume = .05 * masterVolume * musicVolume;
    bumpinbits3.targetVolume = bumpinbits3.volume;

    bumpinbits4.volume = .05 * masterVolume * musicVolume;
    bumpinbits4.targetVolume = bumpinbits4.volume;

    bumpinbits5.volume = .05 * masterVolume * musicVolume;
    bumpinbits5.targetVolume = bumpinbits5.volume;

    depthOfDespair.volume = .20 * masterVolume * musicVolume;
    depthOfDespair.targetVolume = depthOfDespair.volume;
}


function playSound(sound) {
    playingSounds.add(sound);
    if (!gameMuted) {
        if (sound.currentTime > 0) {
            sound.currentTime = 0;
        }
        sound.play();
    }
}

function stopSound(sound) {
    playingSounds.delete(sound);
    if (!gameMuted) {
        sound.pause();
        if (sound.currentTime > 0) {
            sound.currentTime = 0;
        }
    }
}

function stopAllSounds() {
    playingSounds.forEach(function (sound) {
        sound.pause();
    });
    playingSounds.clear();
}

function playSoundAfterFinish(sound) {
    playingSounds.add(sound);
    if (!gameMuted) {
        if (sound.currentTime > 0 && !sound.ended) {
            return;
        } else {
            sound.currentTime = 0;
        }
        sound.play();
    }
}

// Server-authoritative: play the exact mood+track the server told us to. The
// server decides what everyone hears; the client only obeys.
function setBackgroundMusic(mood, trackName) {
    if (mood == null || trackName == null) {
        return;
    }
    var playlist = backgroundMusicLists[mood];
    if (playlist == null) {
        console.warn("setBackgroundMusic: unknown mood '" + mood + "' from server — no music change");
        return;
    }
    var track = playlist[trackName];
    if (track == null) {
        console.warn("setBackgroundMusic: track '" + trackName + "' not registered for mood '" + mood + "' (config.json/audio.js mismatch?) — no music change");
        return;
    }
    //Already playing this exact track — leave it (and its fade) alone.
    if (currentBackgroundMusic === track && !track.paused && !track.ended) {
        return;
    }
    //Fade out whatever else is playing before switching.
    if (currentBackgroundMusic != null && currentBackgroundMusic !== track) {
        fadeSoundOut(currentBackgroundMusic);
    }
    currentBackgroundMusic = track;
    fadeSoundIn(track);
    playSound(track);
}

// Background tracks don't loop. When the active one finishes, tell the server so
// it can pick the next track for everyone — keeps music continuous and in sync.
function handleBackgroundTrackEnded(event) {
    var sound = event.target;
    if (sound !== currentBackgroundMusic) {
        return;
    }
    if (musicTrackEndedHandler != null) {
        musicTrackEndedHandler(sound.trackName);
    }
}

function fadeSoundIn(sound) {
    clearFade(sound);
    sound.volume = .001 * masterVolume;
    var timer = setInterval(function () {
        if (sound.volume < sound.targetVolume) {
            sound.volume = sound.volume * 1.2 * masterVolume * musicVolume;
        } else {
            sound.volume = sound.targetVolume;
            clearInterval(timer);
            fadeTimers.delete(sound);
        }
    }, 500);
    fadeTimers.set(sound, timer);
}

function fadeSoundOut(sound) {
    if (sound == null) return;
    clearFade(sound);
    var timer = setInterval(function () {
        if (sound.volume > 0.0025) {
            sound.volume *= .95;
        } else {
            stopSound(sound);
            clearInterval(timer);
            fadeTimers.delete(sound);
        }
    }, 500);
    fadeTimers.set(sound, timer);
}

