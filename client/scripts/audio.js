// ============================================================================
// Web Audio engine
// ----------------------------------------------------------------------------
// All game audio runs through a single AudioContext. Each "sound" is a small
// descriptor (NOT an HTMLAudioElement) that lazily decodes its file into an
// AudioBuffer once; every play spawns a fresh AudioBufferSourceNode, so:
//   * overlap is free — a flurry of punches LAYERS instead of cutting itself off
//     (the old single-shared-<audio> model restarted the clip on every trigger);
//   * pitch jitter is exact (source.playbackRate shifts pitch with no time-stretch);
//   * gain ramps give click-free fades, true music crossfades, and ducking.
//
// The public API (playSound / playSoundVaried / playSoundAfterFinish / stopSound /
// stopAllSounds / volumeChange / setBackgroundMusic / setLobbySfxDampen /
// playAudience / updateAudienceIntensity / pickCrowd*) is unchanged, and the sound
// globals (meleeSound, lobbyMusic, …) are still passed around as opaque tokens, so
// no call site in client.js / draw.js / gameboard.js / game.js had to change.
// ============================================================================

var gameMuted = false;
var masterVolume = 1,        // master on/off toggle (navbar gamepad icon): 0 or 1
    musicVolume = 1;         // music on/off toggle: 0 or 1
// Lobby tutorial: all SFX play at this fraction of normal while in the lobby (1 = no
// change). Toggled by setLobbySfxDampen() on lobby enter/exit; applied in volumeChange.
var sfxVolumeScalar = 1;
var LOBBY_SFX_SCALAR = 0.1;
function setLobbySfxDampen(on) {
    sfxVolumeScalar = on ? LOBBY_SFX_SCALAR : 1;
    volumeChange();
}

// --- Engine state -----------------------------------------------------------
var audioCtx = null;
var sfxBus = null, musicBus = null, crowdBus = null, voiceBus = null;
var activeVoices = new Set();   // every live voice: { sound, source, gain, sustained }
var pendingSounds = new Set();  // sounds asked to play before the ctx was ready/unlocked
var allSounds = [];             // every descriptor, for preload + live volume updates

function getCtx() {
    if (audioCtx == null) {
        var AC = (typeof window !== "undefined") && (window.AudioContext || window.webkitAudioContext);
        if (!AC) { return null; }
        audioCtx = new AC();
        sfxBus = audioCtx.createGain();
        musicBus = audioCtx.createGain();
        crowdBus = audioCtx.createGain();
        voiceBus = audioCtx.createGain();
        [sfxBus, musicBus, crowdBus, voiceBus].forEach(function (b) {
            b.gain.value = 1;
            b.connect(audioCtx.destination);
        });
    }
    return audioCtx;
}

function busFor(s) {
    switch (s.bus) {
        case "music": return musicBus;
        case "crowd": return crowdBus;
        case "voice": return voiceBus;
        default: return sfxBus;
    }
}

// A sound is a plain descriptor. `.volume` is the absolute 0..1 level set by
// volumeChange(); the engine reads it when spawning each voice.
function makeSound(src, opts) {
    opts = opts || {};
    var s = {
        src: src,
        bus: opts.bus || "sfx",
        loop: !!opts.loop,
        duck: !!opts.duck,          // when played, briefly dips the music bus
        volume: 1,
        targetVolume: 1,
        audienceBaseVolume: null,   // crowd clips: pre-intensity base level
        trackName: null,            // background tracks: name the server addresses
        buffer: null,
        loading: false,
        voice: null,                // sustained voice handle (music / looping lobby)
        pendingPlay: false,
        pendingOpt: null,
        pendingAt: 0,               // wall-clock time a one-shot was deferred (staleness)
        maxVoices: opts.maxVoices || 6,
        playing: 0                  // live voice count (caps runaway stacking)
    };
    allSounds.push(s);
    return s;
}

function loadSound(s) {
    if (s.buffer || s.loading) { return; }
    var ctx = getCtx();
    if (!ctx) { return; }
    s.loading = true;
    fetch(s.src)
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return ctx.decodeAudioData(buf); })
        .then(function (decoded) {
            s.buffer = decoded;
            s.loading = false;
            drainPending();
        })
        .catch(function () { s.loading = false; });
}

// Kick off decoding for every sound up front so the first punch/explosion isn't
// silent while its buffer decodes. decodeAudioData works on a suspended context.
function preloadAllSounds() {
    if (!getCtx()) { return; }
    for (var i = 0; i < allSounds.length; i++) { loadSound(allSounds[i]); }
}

// Core playback: spawn one voice. Returns the voice handle (or undefined if it
// couldn't start yet — deferred until decode/unlock, for sustained sounds).
function startSound(s, opt) {
    opt = opt || {};
    var ctx = getCtx();
    if (!ctx || gameMuted) { return; }

    var sustained = s.loop || !!opt.sustained;

    // Fully muted: a one-shot is a true no-op — don't allocate a voice or burn a slot
    // of the cap. Sustained sounds (music, lobby loop) still start, silently, so
    // unmuting can ramp them up live via applyLiveVolumes().
    if (!sustained && masterVolume === 0) { return; }

    // Not ready yet (still decoding, or autoplay-blocked). Sustained sounds (music,
    // lobby loop) are remembered and started by drainPending() once ready. A one-shot
    // is deferred ONLY when the context is already running (i.e. just mid-decode), and
    // drainPending drops it if its buffer takes too long (a late cue is worse than a
    // missed one); a one-shot fired while still suspended (pre-gesture) is dropped now.
    if (!s.buffer || ctx.state === "suspended") {
        loadSound(s);
        if (sustained) {
            s.pendingPlay = true;
            s.pendingOpt = opt;
            pendingSounds.add(s);
        } else if (ctx.state === "running" && !s.buffer) {
            s.pendingPlay = true;
            s.pendingOpt = opt;
            s.pendingAt = Date.now();
            pendingSounds.add(s);
        }
        return;
    }

    // Don't stack a sustained sound on itself (e.g. re-entering the lobby while its
    // music already loops).
    if (sustained && s.voice && !opt.restart) { return; }
    // Cap simultaneous one-shots so a mass lava collapse doesn't sum into a wall of
    // clipping (and to bound CPU); drop the newest over the cap.
    if (!sustained && s.playing >= s.maxVoices) { return; }

    var source = ctx.createBufferSource();
    source.buffer = s.buffer;
    source.loop = s.loop;
    if (opt.rate) { source.playbackRate.value = opt.rate; }

    var g = ctx.createGain();
    var vol = (opt.volume != null) ? opt.volume : s.volume;
    // Loops/music get a short fade-in by default so they wash in rather than snap.
    var fadeIn = (opt.fadeIn != null) ? opt.fadeIn : (s.loop ? 0.4 : 0);
    var now = ctx.currentTime;
    if (fadeIn > 0) {
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(Math.max(0.0001, vol), now + fadeIn);
    } else {
        g.gain.value = vol;
    }

    source.connect(g);
    g.connect(busFor(s));

    var voice = { sound: s, source: source, gain: g, sustained: sustained, stopped: false };
    activeVoices.add(voice);
    s.playing++;
    source.onended = function () {
        activeVoices.delete(voice);
        s.playing = Math.max(0, s.playing - 1);
        if (s.voice === voice) { s.voice = null; }
        // Only a NATURAL end notifies the server "track finished" (so it queues the
        // next track). A deliberate stop (crossfade / stopSound / stopAllSounds) sets
        // voice.stopped and must NOT — otherwise stopping music spuriously tells the
        // server to start a new track.
        if (!voice.stopped && opt.onended) { opt.onended(); }
    };

    try {
        source.start();
    } catch (e) {
        // start() can throw (e.g. InvalidStateError if the context state churned).
        // onended won't fire for a node that never started, so undo the bookkeeping
        // here — otherwise s.playing leaks and the sound wedges at its voice cap (goes
        // permanently silent) after maxVoices such failures.
        activeVoices.delete(voice);
        s.playing = Math.max(0, s.playing - 1);
        try { source.disconnect(); } catch (e2) {}
        return;
    }
    if (sustained) { s.voice = voice; }
    if (s.duck) { duckMusic(); }
    return voice;
}

// Start anything that was requested before the engine was ready. Safe to call
// repeatedly (on each buffer decode and on unlock).
function drainPending() {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    var nowMs = Date.now();
    pendingSounds.forEach(function (s) {
        if (!s.buffer) { return; }
        pendingSounds.delete(s);
        s.pendingPlay = false;
        var opt = s.pendingOpt || {};
        s.pendingOpt = null;
        var sus = s.loop || !!opt.sustained;
        // Drop a one-shot whose buffer took too long to decode — firing a stale cue
        // late is worse than skipping it. Sustained sounds always start once ready.
        if (!sus && s.pendingAt && (nowMs - s.pendingAt) > 1500) { return; }
        startSound(s, opt);
    });
}

// Pin an AudioParam to its CURRENT rendered value before re-automating it. Plain
// `.value` returns the last *set* value, not the live ramped one, so re-ramping
// mid-fade would snap/pump. cancelAndHoldAtTime captures the live value where
// supported; otherwise fall back to a best-effort hold.
function holdParamNow(param, now) {
    if (param.cancelAndHoldAtTime) {
        param.cancelAndHoldAtTime(now);
    } else {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
    }
}

function fadeOutVoice(voice, dur) {
    if (!voice) { return; }
    var ctx = getCtx();
    activeVoices.delete(voice);
    // Mark as deliberately stopped (so its onended won't report a natural track-end)
    // and clear the descriptor's live-voice pointer NOW, rather than waiting for the
    // async onended — otherwise guards that read sound.voice see a stale "still
    // playing" during the fade and can refuse to restart the same track.
    voice.stopped = true;
    if (voice.sound.voice === voice) { voice.sound.voice = null; }
    if (!ctx) {
        try { voice.source.stop(); } catch (e) {}
        voice.sound.playing = Math.max(0, voice.sound.playing - 1);
        return;
    }
    var now = ctx.currentTime;
    try {
        holdParamNow(voice.gain.gain, now);
        voice.gain.gain.linearRampToValueAtTime(0.0001, now + dur);
        voice.source.stop(now + dur + 0.03);
    } catch (e) {
        try { voice.source.stop(); } catch (e2) {}
    }
}

// --- Ducking ----------------------------------------------------------------
// When an announcer line (or the brutal-round stinger) plays, dip the music bus a
// few dB and ramp it back, so the call-out sits clearly over the track. Crowd and
// other SFX are left alone (a kill cue and its crowd cheer should land together).
function duckMusic() {
    var ctx = getCtx();
    if (!ctx) { return; }
    var now = ctx.currentTime;
    try {
        // Hold the live level first so back-to-back ducks (a multi-kill announcer
        // chain) re-dip smoothly from the current value instead of snapping/pumping.
        holdParamNow(musicBus.gain, now);
        musicBus.gain.linearRampToValueAtTime(0.4, now + 0.08);  // dip fast
        musicBus.gain.linearRampToValueAtTime(1.0, now + 0.7);   // recover gently
    } catch (e) {}
}

// ----------------------------------------------------------------------------
// Background music registry. Playlists are name-keyed (trackName -> Sound) so a
// server-sent {mood, track} resolves to the exact descriptor the engine plays.
// ----------------------------------------------------------------------------
var calmBackgroundMusicList = {};
var excitingBackgroundMusicList = {};
var brutalBackgroundMusicList = {};
var backgroundMusicLists = {};
var currentBackgroundMusic = null;
var backgroundBuildTimer = null;
// Set by client.js once the socket exists; lets the server drive the next track
// when one finishes so background music stays continuous and in sync.
var musicTrackEndedHandler = null;

// --- Sound descriptors (replaces the old `new Audio(...)` globals) ----------
var playerJoinSound = makeSound("./assets/sounds/pleasing-bell.mp3");
var playerDiedSound = makeSound("./assets/sounds/TailWhip.mp3");
var countDownA = makeSound("./assets/sounds/countdown-a.mp3");
var countDownB = makeSound("./assets/sounds/countdown-b.mp3");
var lavaCollapse = makeSound("./assets/sounds/doomed.mp3");
var meleeSound = makeSound("./assets/sounds/melee-sound.mp3");
var meleeHitSound = makeSound("./assets/sounds/bing.mp3");
var chargedHitSound = makeSound("./assets/sounds/thwack.mp3");
var gameOverSound = makeSound("./assets/sounds/gameover.mp3");
var collectItem = makeSound("./assets/sounds/collectitem.mp3");
var playerFinished = makeSound("./assets/sounds/playerfinished.mp3");
var bombShot = makeSound("./assets/sounds/bomb-shot.mp3");
var bombExplosion = makeSound("./assets/sounds/bomb-explosion.mp3");
var bombBounce = makeSound("./assets/sounds/bomb-bounce.mp3");
var blindSound = makeSound("./assets/sounds/blind.mp3");
var abilityFizzle = makeSound("./assets/sounds/fizzle.mp3");
var teleportSound = makeSound("./assets/sounds/teleport.mp3");
var teleportWarnSound = makeSound("./assets/sounds/teleport_warn.mp3");
var brutalRoundSound = makeSound("./assets/sounds/brutalround.mp3", { duck: true });
var volcanoErupt = makeSound("./assets/sounds/volcano-erupt.mp3");
var speedBuff = makeSound("./assets/sounds/speedBuff.mp3");
var speedDebuff = makeSound("./assets/sounds/speed_downgrade.mp3");
var tileSwap = makeSound("./assets/sounds/tileswap.mp3");
var iceCannon = makeSound("./assets/sounds/iceCannon.mp3");
var iceExplosion = makeSound("./assets/sounds/iceExplosion.mp3");
var lavaExplosion = makeSound("./assets/sounds/lavaExplosion.mp3");
var cutSound = makeSound("./assets/sounds/thwack.mp3");
var bumperSound = makeSound("./assets/sounds/bumper.mp3");
var blackoutSound = makeSound("./assets/sounds/blackout.mp3");

var newZombie = makeSound("./assets/sounds/newzombie.mp3");
var zombieHit = makeSound("./assets/sounds/zombiehit.mp3");
var zombieSwing = makeSound("./assets/sounds/zombieswing.mp3");

var nearVictorySound = makeSound("./assets/sounds/rise.mp3");
var fallFromVictorySound = makeSound("./assets/sounds/reverserise.mp3");

// Announcer — routed through the voice bus and flagged to duck the music under them.
var firstBlood = makeSound("./assets/sounds/firstBlood.mp3", { bus: "voice", duck: true });
var doubleKill = makeSound("./assets/sounds/doubleKill.mp3", { bus: "voice", duck: true });
var tripleKill = makeSound("./assets/sounds/tripleKill.mp3", { bus: "voice", duck: true });
var megaKill = makeSound("./assets/sounds/megaKill.mp3", { bus: "voice", duck: true });
var killingSpree = makeSound("./assets/sounds/killingSpree.mp3", { bus: "voice", duck: true });
var rampage = makeSound("./assets/sounds/rampage.mp3", { bus: "voice", duck: true });
var godLike = makeSound("./assets/sounds/godLike.mp3", { bus: "voice", duck: true });

// Audience — a stadium crowd layered under the action that reacts to tense and
// amazing plays (big kills, fight flurries, narrow lava escapes, clutch goals).
// Source: "Free Crowd Cheering Sounds" by Gregor Quendel (OpenGameArt, CC-BY 4.0),
// trimmed into short cues. See client/assets/sounds/CREDITS.md for attribution.
// Each reaction rotates through interchangeable clips (and gets a small random
// pitch shift per play, see playAudience) so repeats never sound identical.
var crowdCheerBigVariants = [                            // amazing plays / clutch finishes
    makeSound("./assets/sounds/crowd-cheer-big.mp3", { bus: "crowd" }),
    makeSound("./assets/sounds/crowd-cheer-big-2.mp3", { bus: "crowd" }),
    makeSound("./assets/sounds/crowd-cheer-big-3.mp3", { bus: "crowd" })
];
var crowdCheerVariants = [                               // a single kill
    makeSound("./assets/sounds/crowd-cheer.mp3", { bus: "crowd" }),
    makeSound("./assets/sounds/crowd-cheer-2.mp3", { bus: "crowd" }),
    makeSound("./assets/sounds/crowd-cheer-3.mp3", { bus: "crowd" })
];
var crowdOohVariants = [                                 // tension: fight flurries / near-burn escapes
    makeSound("./assets/sounds/crowd-ooh.mp3", { bus: "crowd" }),
    makeSound("./assets/sounds/crowd-ooh-2.mp3", { bus: "crowd" }),
    makeSound("./assets/sounds/crowd-ooh-3.mp3", { bus: "crowd" })
];

var lobbyMusic = makeSound("./assets/sounds/lobbymusic.mp3", { bus: "music", loop: true });
var gameStart = makeSound("./assets/sounds/gamestart.mp3");

var slowstride = makeSound("./assets/sounds/slowstride.mp3", { bus: "music" });
var slowpipes = makeSound("./assets/sounds/slow-pipes.mp3", { bus: "music" });

var therush = makeSound("./assets/sounds/the-rush.mp3", { bus: "music" });
var beastv2 = makeSound("./assets/sounds/beastv2.mp3", { bus: "music" });
var mindInMotion = makeSound("./assets/sounds/mind_in_motion.mp3", { bus: "music" });
var bumpinbits1 = makeSound("./assets/sounds/bumpinbits1.mp3", { bus: "music" });
var bumpinbits2 = makeSound("./assets/sounds/bumpinbits2.mp3", { bus: "music" });
var bumpinbits3 = makeSound("./assets/sounds/bumpinbits3.mp3", { bus: "music" });
var bumpinbits4 = makeSound("./assets/sounds/bumpinbits4.mp3", { bus: "music" });
var bumpinbits5 = makeSound("./assets/sounds/bumpinbits5.mp3", { bus: "music" });

var heavyfabric = makeSound("./assets/sounds/heavyfabric.mp3", { bus: "music" });
var desperationSetsIn = makeSound("./assets/sounds/DesperationSetsIn.mp3", { bus: "music" });
var horrorLoop = makeSound("./assets/sounds/HorrorLoop.mp3", { bus: "music" });
var depthOfDespair = makeSound("./assets/sounds/depthOfDespair.mp3", { bus: "music" });

// Register a track under a mood. Keys MUST match the names in config.json "music"
// so a server-sent {mood, track} resolves here. trackName is stamped on the sound
// so the engine can report which track finished back to the server.
function registerBackgroundTrack(playlist, mood, name, sound) {
    sound.trackName = name;
    playlist[name] = sound;
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
    // `.volume` is the absolute level the engine applies per voice. SFX fold in the
    // master toggle + the lobby dampen scalar (1 except in the lobby tutorial, so it
    // reads as practice). Music folds in the master + music toggles. These coefficients
    // are NOT perceived loudness — the source files are mastered at very different
    // levels — they were tuned against a per-file loudness measurement.
    var sfx = masterVolume * sfxVolumeScalar;
    playerJoinSound.volume = .6 * sfx;   // join chime — must scale with the slider (historically it didn't)
    blackoutSound.volume = .35 * sfx;
    bumperSound.volume = .25 * sfx;
    cutSound.volume = .15 * sfx;
    godLike.volume = .1 * sfx;
    rampage.volume = .1 * sfx;
    setVariantVolume(crowdCheerBigVariants, .125 * sfx);
    setVariantVolume(crowdCheerVariants, .14 * sfx);
    setVariantVolume(crowdOohVariants, .16 * sfx);
    killingSpree.volume = .1 * sfx;
    megaKill.volume = .1 * sfx;
    tripleKill.volume = .1 * sfx;
    doubleKill.volume = .1 * sfx;
    firstBlood.volume = .1 * sfx;
    lavaExplosion.volume = .75 * sfx;
    iceExplosion.volume = .25 * sfx;
    iceCannon.volume = .25 * sfx;
    tileSwap.volume = .32 * sfx;       // file has the hottest transient peak in the game (~-6 dBFS); tame the spike
    speedBuff.volume = 0.25 * sfx;
    speedDebuff.volume = 0.05 * sfx;
    volcanoErupt.volume = 0.05 * sfx;
    brutalRoundSound.volume = 0.35 * sfx;
    bombBounce.volume = 0.22 * sfx;    // a ricochet must sit under the bomb's own shot/explosion (.2)
    abilityFizzle.volume = .15 * sfx;  // a whiffed-ability "nope" — keep it well below the action
    teleportWarnSound.volume = .025 * sfx;
    countDownA.volume = .05 * sfx;
    countDownB.volume = .05 * sfx;
    lavaCollapse.volume = .1 * sfx;
    meleeSound.volume = .05 * sfx;
    meleeHitSound.volume = .016 * sfx;
    chargedHitSound.volume = .5 * sfx;
    gameOverSound.volume = .5 * sfx;
    nearVictorySound.volume = .3 * sfx;
    fallFromVictorySound.volume = .15 * sfx;
    collectItem.volume = .75 * sfx;    // pickup source is very quiet; was buried near the noise floor
    bombShot.volume = .2 * sfx;
    bombExplosion.volume = .2 * sfx;
    playerFinished.volume = .3 * sfx;
    playerDiedSound.volume = .3 * sfx;
    blindSound.volume = .4 * sfx;
    teleportSound.volume = .05 * sfx;
    newZombie.volume = .65 * sfx;
    zombieHit.volume = .25 * sfx;
    zombieSwing.volume = .35 * sfx;
    gameStart.volume = .2 * sfx;

    var music = masterVolume * musicVolume;
    lobbyMusic.volume = .05 * music;
    heavyfabric.volume = .030 * music;
    slowpipes.volume = .015 * music;
    slowstride.volume = .05 * music;
    therush.volume = .025 * music;
    beastv2.volume = .035 * music;
    mindInMotion.volume = .035 * music;
    desperationSetsIn.volume = .015 * music;
    horrorLoop.volume = .015 * music;
    bumpinbits1.volume = .05 * music;
    bumpinbits2.volume = .05 * music;
    bumpinbits3.volume = .05 * music;
    bumpinbits4.volume = .05 * music;
    bumpinbits5.volume = .05 * music;
    depthOfDespair.volume = .20 * music;

    applyLiveVolumes();
}

// Push the freshly-computed levels onto anything currently sustained (music, the
// looping lobby track) so muting/unmuting takes effect immediately mid-playback.
function applyLiveVolumes() {
    var ctx = getCtx();
    if (!ctx) { return; }
    activeVoices.forEach(function (v) {
        if (v.sustained && v.gain) {
            try {
                var t = ctx.currentTime;
                // Glide to the new level from wherever the gain actually is right now,
                // so a volume toggle landing mid-crossfade doesn't click or jump the
                // music straight to full.
                holdParamNow(v.gain.gain, t);
                v.gain.gain.setTargetAtTime(v.sound.volume, t, 0.05);
            } catch (e) {}
        }
    });
}


// ----------------------------------------------------------------------------
// Public play helpers (API preserved from the old HTMLAudio implementation).
// ----------------------------------------------------------------------------
function playSound(sound) {
    startSound(sound, {});
}

// Per-play pitch jitter for frequently-repeated impact SFX (punches, bounces, hits,
// burns) so a flurry doesn't read as the identical click looped. `variance` is the ±
// fraction of normal speed (.1 = ±10%); a smaller value keeps weighty one-shots' body.
function playSoundVaried(sound, variance) {
    var v = (variance == null) ? 0.08 : variance;
    startSound(sound, { rate: 1 + (Math.random() * 2 - 1) * v });
}

// "Play unless already playing" — used for the looping lobby track. With the engine,
// startSound already refuses to stack a sustained sound on itself.
function playSoundAfterFinish(sound) {
    startSound(sound, {});
}

// Stop every live voice of this sound (sustained or one-shot) with a quick fade so
// it doesn't click off. Used for the lobby loop and the collapse rumble.
function stopSound(sound) {
    var toStop = [];
    activeVoices.forEach(function (v) { if (v.sound === sound) { toStop.push(v); } });
    for (var i = 0; i < toStop.length; i++) { fadeOutVoice(toStop[i], 0.25); }
    pendingSounds.delete(sound);
    sound.pendingPlay = false;
    sound.voice = null;
}

function stopAllSounds() {
    var all = [];
    activeVoices.forEach(function (v) { all.push(v); });
    for (var i = 0; i < all.length; i++) { fadeOutVoice(all[i], 0.2); }
    pendingSounds.forEach(function (s) { s.pendingPlay = false; s.pendingOpt = null; });
    pendingSounds.clear();
    // The match's music was just stopped; forget it so the next setBackgroundMusic
    // starts cleanly (and the fading music voice can't report a track-end either).
    currentBackgroundMusic = null;
}

// Browser autoplay policy keeps the AudioContext "suspended" until the user
// interacts with the page, so anything requested on the waiting/lobby screen
// (before any click/keypress) can't be heard. On the first user gesture, resume the
// context and start anything that was deferred (the lobby loop, pending music).
// Fires once, then detaches.
var audioUnlocked = false;
function unlockAudio() {
    if (audioUnlocked) { return; }
    audioUnlocked = true;
    ["mousedown", "pointerdown", "keydown", "touchstart"].forEach(function (evt) {
        window.removeEventListener(evt, unlockAudio);
    });
    var ctx = getCtx();
    if (!ctx) { return; }
    var resume = ctx.resume ? ctx.resume() : null;
    if (resume && resume.then) {
        resume.then(drainPending).catch(function () {});
    } else {
        drainPending();
    }
}
if (typeof window !== "undefined") {
    ["mousedown", "pointerdown", "keydown", "touchstart"].forEach(function (evt) {
        window.addEventListener(evt, unlockAudio, { passive: true });
    });
    // Begin decoding everything immediately so gameplay sounds are ready on first use.
    preloadAllSounds();
}

// ----------------------------------------------------------------------------
// Audience reactions (unchanged behaviour: one shared crowd voice, priority +
// cooldown gating, intensity that escalates over the match, per-play pitch shift).
// ----------------------------------------------------------------------------
var audienceCooldownMs = 1800;
var audienceReactionUntil = 0;
var audienceCurrentSound = null;
var audienceCurrentVoice = null;
var audienceCurrentPriority = 0;
var audienceIntensity = 0;     // 0 (match start) .. 1 (someone one notch from winning)
var audienceVolScale = 0.5;    // volume multiplier derived from intensity
var audienceMinPriority = 2;   // lowest priority allowed to fire now (early: 2 = exceptional only)

function setVariantVolume(list, vol) {
    for (var i = 0; i < list.length; i++) {
        list[i].audienceBaseVolume = vol;
        list[i].volume = vol * audienceVolScale;
    }
}

function setAudienceIntensity(t) {
    audienceIntensity = Math.max(0, Math.min(1, t));
    audienceVolScale = 0.5 + 0.6 * audienceIntensity;       // 0.5 (tame) .. 1.1 (boosted)
    audienceMinPriority = audienceIntensity < 0.34 ? 2 : 1; // minor reactions unlock as the match heats up
}

// Recompute intensity from the standings: how close is the leader to the win
// target? Called at each round overview (notches change) and on match reset.
function updateAudienceIntensity() {
    var maxNotches = 0;
    for (var pid in playerList) {
        var n = playerList[pid].notches;
        if (typeof n === "number" && n > maxNotches) {
            maxNotches = n;
        }
    }
    var denom = Math.max(1, gameLength - 1); // intensity reaches 1.0 when someone is one notch from winning
    setAudienceIntensity(maxNotches / denom);
}

// Each audience cue rotates through its clips, never repeating the same one
// twice in a row, so a run of reactions doesn't replay the identical sound.
var crowdLastIndex = { big: -1, cheer: -1, ooh: -1 };
function pickVariant(list, key) {
    var i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === crowdLastIndex[key]) {
        i = (i + 1) % list.length;
    }
    crowdLastIndex[key] = i;
    return list[i];
}
function pickCrowdBig() { return pickVariant(crowdCheerBigVariants, "big"); }
function pickCrowdCheer() { return pickVariant(crowdCheerVariants, "cheer"); }
function pickCrowdOoh() { return pickVariant(crowdOohVariants, "ooh"); }

// Small per-play pitch shift (±audiencePitchVariance) so even the same clip sounds
// slightly different each time.
var audiencePitchVariance = 0.06;
function playAudience(sound, priority) {
    // Early in a match the crowd only stirs for exceptional plays; minor reactions
    // unlock as someone approaches the win (see audienceMinPriority).
    if (priority < audienceMinPriority) {
        return;
    }
    var now = Date.now();
    // Within the cooldown, only a higher-priority reaction may break through.
    if (now < audienceReactionUntil && priority <= audienceCurrentPriority) {
        return;
    }
    // One crowd voice: fade out whatever clip is still playing before the next one
    // starts, so reactions never pile up.
    if (audienceCurrentVoice != null) {
        fadeOutVoice(audienceCurrentVoice, 0.15);
        audienceCurrentVoice = null;
    }
    var rate = 1 + (Math.random() * 2 - 1) * audiencePitchVariance;
    var vol = (sound.audienceBaseVolume != null ? sound.audienceBaseVolume : sound.volume) * audienceVolScale;
    var voice = startSound(sound, { rate: rate, volume: vol });
    // If the clip couldn't actually start (ctx suspended / buffer not yet decoded /
    // muted), don't arm the cooldown — otherwise a reaction nobody heard would gate
    // genuine reactions for the next ~1.8s.
    if (voice == null) { return; }
    audienceCurrentSound = sound;
    audienceCurrentPriority = priority;
    audienceReactionUntil = now + audienceCooldownMs;
    audienceCurrentVoice = voice;
}

// ----------------------------------------------------------------------------
// Background music — server-authoritative. The server tells everyone the exact
// mood+track; the client crossfades to it.
// ----------------------------------------------------------------------------
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
    // Already playing this exact track — leave it (and its fade) alone.
    if (currentBackgroundMusic === track && track.voice != null) {
        return;
    }
    // Crossfade: fade the old track out while the new one fades in.
    if (currentBackgroundMusic != null && currentBackgroundMusic !== track) {
        if (currentBackgroundMusic.voice != null) {
            fadeOutVoice(currentBackgroundMusic.voice, 1.2);
        }
        currentBackgroundMusic.voice = null;
        pendingSounds.delete(currentBackgroundMusic);
        currentBackgroundMusic.pendingPlay = false;
    }
    currentBackgroundMusic = track;
    startSound(track, {
        sustained: true,
        fadeIn: 1.2,
        // Background tracks don't loop; when the active one finishes, tell the server
        // so it can pick the next track for everyone (keeps music continuous + in sync).
        onended: function () {
            if (currentBackgroundMusic === track) {
                track.voice = null;
                if (musicTrackEndedHandler != null) {
                    musicTrackEndedHandler(track.trackName);
                }
            }
        }
    });
}
