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
// Ice drift: peak level of a single drifter's synthesized skid loop (before the
// master toggle + lobby dampen fold in). Kept low — it's a continuous bed under
// the action, and a pack can have several going at once.
var DRIFT_BASE_VOL = 0.16;
// Flame-extinguished steam quench: peak level of the synthesized one-shot hiss (before
// the master toggle + lobby dampen fold in). A brief cue, so it can sit a touch above
// the continuous drift bed.
var EXTINGUISH_VOL = 0.35;
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

// Returns a promise that resolves once the sound is decoded (or gave up) so a
// throttled loader can chain on it. Never rejects.
function loadSound(s) {
    if (s.buffer || s.loading) { return Promise.resolve(); }
    var ctx = getCtx();
    if (!ctx) { return Promise.resolve(); }
    s.loading = true;
    return fetch(s.src)
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return ctx.decodeAudioData(buf); })
        .then(function (decoded) {
            s.buffer = decoded;
            s.loading = false;
            drainPending();
        })
        .catch(function () { s.loading = false; });
}

// Load the rest of the library AFTER the essentials, a few at a time. Fetching
// all ~65 clips at once (tens of MB) on page load would saturate a thin mobile
// link and starve the map/image loads that actually gate entering the lobby —
// the bug far/slow players hit. Throttling keeps the bulk audio out of the way;
// anything played before its turn still decodes on-demand via startSound().
var bgPreloadStarted = false;
function preloadAllSounds() {
    if (bgPreloadStarted || !getCtx()) { return; }
    bgPreloadStarted = true;
    var queue = allSounds.filter(function (s) { return !s.buffer && !s.loading; });
    var CONCURRENCY = 3;
    function pump() {
        if (!queue.length) { return; }
        loadSound(queue.shift()).then(pump);
    }
    for (var i = 0; i < CONCURRENCY; i++) { pump(); }
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
    // Mark as deliberately stopped (so its onended won't report a natural track-end)
    // and clear the descriptor's live-voice pointer NOW, rather than waiting for the
    // async onended — otherwise guards that read sound.voice see a stale "still
    // playing" during the fade and can refuse to restart the same track.
    voice.stopped = true;
    if (voice.sound.voice === voice) { voice.sound.voice = null; }
    if (!ctx) {
        activeVoices.delete(voice);
        try { voice.source.stop(); } catch (e) {}
        voice.sound.playing = Math.max(0, voice.sound.playing - 1);
        return;
    }
    // The voice deliberately STAYS in activeVoices until its source actually ends
    // (onended cleans up): long crossfade tails (~20s) must remain reachable by
    // stopAllSounds/stopSound — re-fading an already-fading voice just re-ramps it
    // shorter, and re-calling source.stop() with an earlier time is allowed.
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
// The voice still draining from the last crossfade (the ~20s tail). Tracked so a
// quick return to that same track cuts the tail fast instead of doubling over it.
var fadingBackgroundVoice = null;
var backgroundBuildTimer = null;
// Set by client.js once the socket exists; lets the server drive the next track
// when one finishes so background music stays continuous and in sync.
var musicTrackEndedHandler = null;

// --- Sound descriptors (replaces the old `new Audio(...)` globals) ----------
var playerJoinSound = makeSound("./assets/sounds/pleasing-bell.mp3");
// Progression-celebration cues (celebrations.js): XP bar tick-up, level-up chime, and the
// cosmetic-unlock crowd cheer. Distinct descriptors (not the in-game SFX) so their volume
// can skip the lobby dampen — celebrations only ever play in the lobby.
var celebrationXpTick = makeSound("./assets/sounds/collectitem.mp3");
var celebrationLevelUp = makeSound("./assets/sounds/pleasing-bell.mp3", { duck: true });
var celebrationCheer = makeSound("./assets/sounds/crowd-cheer-big.mp3", { duck: true });
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
// Star Power theme (original synthesized cue, see assets/sounds/CREDITS.md).
// The ?v= query busts the 30-day /assets/** browser cache (index.js) — this
// file was re-rendered in place during development, which asset caching
// assumes never happens. Bump it if the render ever changes again.
// The theme fires room-wide for EVERY star use and bots use the ability too;
// the client restarts it on each activation (stopSound + play in client.js)
// so the newest star always owns the theme. maxVoices 2 — NOT a stack
// allowance: the old copy keeps its voice slot during stopSound's 0.25s
// fade-out, so the restart needs one slot of crossfade headroom.
var starPowerSound = makeSound("./assets/sounds/starPower.mp3?v=3", { maxVoices: 2 });
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
// Bunker (battle royale): the goal erupting back up through the silo door for the
// lone survivor — collapse stops, door opens. A distinct rising cue (own instance
// so its level is tuned independently of the near-victory sting).
var bunkerEmergeSound = makeSound("./assets/sounds/rise.mp3?v=bunker", { duck: true, maxVoices: 1 });

// Announcer — routed through the voice bus and flagged to duck the music under them.
var firstBlood = makeSound("./assets/sounds/firstBlood.mp3", { bus: "voice", duck: true });
var doubleKill = makeSound("./assets/sounds/doubleKill.mp3", { bus: "voice", duck: true });
var tripleKill = makeSound("./assets/sounds/tripleKill.mp3", { bus: "voice", duck: true });
var megaKill = makeSound("./assets/sounds/megaKill.mp3", { bus: "voice", duck: true });
var killingSpree = makeSound("./assets/sounds/killingSpree.mp3", { bus: "voice", duck: true });
var rampage = makeSound("./assets/sounds/rampage.mp3", { bus: "voice", duck: true });
var godLike = makeSound("./assets/sounds/godlike.mp3", { bus: "voice", duck: true });

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
var eightBitAction1 = makeSound("./assets/sounds/8bit-action-1.mp3", { bus: "music" });

var therush = makeSound("./assets/sounds/the-rush.mp3", { bus: "music" });
var beastv2 = makeSound("./assets/sounds/beastv2.mp3", { bus: "music" });
var mindInMotion = makeSound("./assets/sounds/mind_in_motion.mp3", { bus: "music" });
var bumpinbits1 = makeSound("./assets/sounds/bumpinbits1.mp3", { bus: "music" });
var bumpinbits2 = makeSound("./assets/sounds/bumpinbits2.mp3", { bus: "music" });
var bumpinbits3 = makeSound("./assets/sounds/bumpinbits3.mp3", { bus: "music" });
var bumpinbits4 = makeSound("./assets/sounds/bumpinbits4.mp3", { bus: "music" });
var bumpinbits5 = makeSound("./assets/sounds/bumpinbits5.mp3", { bus: "music" });
var eightBitAction3 = makeSound("./assets/sounds/8bit-action-3.mp3", { bus: "music" });
var eightBitAction6 = makeSound("./assets/sounds/8bit-action-6.mp3", { bus: "music" });

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
registerBackgroundTrack(calmBackgroundMusicList, "calm", "8bit-action-1", eightBitAction1);

registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "mind_in_motion", mindInMotion);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "the-rush", therush);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "beastv2", beastv2);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits1", bumpinbits1);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits2", bumpinbits2);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits3", bumpinbits3);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits4", bumpinbits4);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "bumpinbits5", bumpinbits5);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "8bit-action-3", eightBitAction3);
registerBackgroundTrack(excitingBackgroundMusicList, "exciting", "8bit-action-6", eightBitAction6);

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
    // Celebration cues fold in the master toggle but NOT the lobby dampen scalar —
    // they only fire in the lobby, where sfxVolumeScalar is 0.1 and would gut them.
    celebrationXpTick.volume = .5 * masterVolume;
    celebrationLevelUp.volume = .55 * masterVolume;
    celebrationCheer.volume = .22 * masterVolume;  // crowd-cheer-big is mastered hot (in-game sits at .125)
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
    // TUNING NOTE: judge this in a RACE, not the lobby — lobby SFX are damped
    // to 10% (sfxVolumeScalar), which silently skewed an earlier tuning pass.
    starPowerSound.volume = 0.05 * sfx;
    speedDebuff.volume = 0.05 * sfx;
    volcanoErupt.volume = 0.05 * sfx;
    brutalRoundSound.volume = 0.35 * sfx;
    bombBounce.volume = 0.22 * sfx;    // a ricochet must sit under the bomb's own shot/explosion (.2)
    abilityFizzle.volume = .15 * sfx;  // a whiffed-ability "nope" — keep it well below the action
    teleportWarnSound.volume = .025 * sfx;
    countDownA.volume = .05 * sfx;
    countDownB.volume = .05 * sfx;
    lavaCollapse.volume = .1 * sfx;
    meleeSound.volume = .03 * sfx; // punch wind-up/swing snap — reduced 40% (.05->.03)
    meleeHitSound.volume = .016 * sfx;
    chargedHitSound.volume = .5 * sfx;
    gameOverSound.volume = .5 * sfx;
    nearVictorySound.volume = .3 * sfx;
    fallFromVictorySound.volume = .15 * sfx;
    bunkerEmergeSound.volume = .45 * sfx;
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
    eightBitAction1.volume = .075 * music;  // operator-tuned by ear mid-race (.015 -> .025 -> .075); the calm slot wants real presence
    slowstride.volume = .05 * music;
    therush.volume = .025 * music;
    beastv2.volume = .035 * music;
    mindInMotion.volume = .035 * music;
    eightBitAction3.volume = .035 * music;  // mastered as hot as mind_in_motion (mean ~-13 dB) — match its coeff
    eightBitAction6.volume = .035 * music;
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
        if (!v.sustained || !v.gain) { return; }
        if (v.stopped) {
            // A draining crossfade tail — never ramp it back up to the sound's
            // level. If music just got muted, cut the tail short; otherwise let
            // it finish its scheduled fade.
            if (v.sound.volume === 0) { fadeOutVoice(v, 0.2); }
            return;
        }
        try {
            var t = ctx.currentTime;
            // Glide to the new level from wherever the gain actually is right now,
            // so a volume toggle landing mid-crossfade doesn't click or jump the
            // music straight to full.
            holdParamNow(v.gain.gain, t);
            v.gain.gain.setTargetAtTime(v.sound.volume, t, 0.05);
        } catch (e) {}
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
    fadingBackgroundVoice = null;
    stopAllDriftSounds();
    stopFireWalkSound();
    stopHeatwaveDrone();
}

// ----------------------------------------------------------------------------
// Ice drift skid — synthesized, NOT a clip. A drift is a sustained per-player
// state, so rather than a one-shot each drifter gets its own looping voice:
// a shared white-noise buffer through a bandpass filter (the spray "hiss") into
// a gain we ride with the drift's intensity. It's pure Web Audio (no MP3 asset)
// because a continuous, intensity-modulated skid is exactly what filtered noise
// does well. Routed through the sfxBus, so the master toggle + lobby dampen
// already apply; we fold those coefficients into the live gain ourselves since
// these voices live outside the descriptor/volumeChange path.
var driftNoiseBuffer = null;
var driftVoices = {};   // player id -> { source, filter, gain }

function getDriftNoiseBuffer(ctx) {
    if (driftNoiseBuffer) { return driftNoiseBuffer; }
    var len = Math.floor(ctx.sampleRate * 2);   // 2s of noise, looped seamlessly
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) { data[i] = Math.random() * 2 - 1; }
    driftNoiseBuffer = buf;
    return buf;
}

// Bunker silo door sealing — a one-shot pneumatic "pshhh" (Star-Trek-door hiss),
// synthesized from the shared noise buffer through a bandpass that sweeps down as
// it vents, with a sharp attack and a quick decay. Pure Web Audio (no asset), like
// the drift skid; routed through sfxBus so the master toggle/lobby dampen apply.
function playBunkerDoorHiss() {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    var now = ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = getDriftNoiseBuffer(ctx);
    src.loop = true;
    var filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.Q.value = 1.1;
    filt.frequency.setValueAtTime(5200, now);                       // bright burst...
    filt.frequency.exponentialRampToValueAtTime(800, now + 0.42);   // ...venting down
    var g = ctx.createGain();
    var peak = Math.max(0.0002, 0.16 * masterVolume * sfxVolumeScalar);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.025);         // sharp "pss" onset
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);        // vent out
    src.connect(filt); filt.connect(g); g.connect(sfxBus);
    try { src.start(now); src.stop(now + 0.5); } catch (e) { try { src.disconnect(); } catch (e2) {} }
}

// ----------------------------------------------------------------------------
// Heatwave (brutal round) — three synthesized cues from the shared noise buffer
// + oscillators (no assets), all through sfxBus so the master toggle and lobby
// dampen apply. Volumes are set for MID-RACE listening (never judge in the
// lobby; it damps all SFX to 10%).
//   playHeatwaveSizzle  — one-shot reveal wash: a bright searing band sweeping
//                         down into a low rumble while the tiles burn over.
//   start/stopHeatwaveDrone — looping ambient heat shimmer for the round; lives
//                         OUTSIDE activeVoices (drift-skid pattern), so generic
//                         stops can't reach it — it must be stopped explicitly
//                         (stopAllSounds does, plus the round-end handlers).
//   playHeatwaveWarning — second-wave alarm: two quick rising chirps.
var HEATWAVE_DRONE_VOL = 0.03;
// The beating low sines are the dominant (and most fatiguing) part of the drone;
// they get their own attenuation below so the throb sits well under the music
// while the airy noise shimmer carries the "heat" read. (Playtest: the bass
// pulse was too loud at full osc level.)
var HEATWAVE_DRONE_BASS = 0.45;
var heatwaveDroneVoice = null;

function playHeatwaveSizzle() {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    var now = ctx.currentTime;
    var dur = 2.2;
    var src = ctx.createBufferSource();
    src.buffer = getDriftNoiseBuffer(ctx);
    src.loop = true;
    var filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.Q.value = 0.7;
    filt.frequency.setValueAtTime(6000, now);                       // searing hiss...
    filt.frequency.exponentialRampToValueAtTime(420, now + dur);    // ...settling to a rumble
    var g = ctx.createGain();
    var peak = Math.max(0.0002, 0.14 * masterVolume * sfxVolumeScalar);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.35);
    g.gain.setValueAtTime(peak, now + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt); filt.connect(g); g.connect(sfxBus);
    try { src.start(now); src.stop(now + dur + 0.05); } catch (e) { try { src.disconnect(); } catch (e2) {} }
}

function startHeatwaveDrone() {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    if (heatwaveDroneVoice != null) { return; }
    var now = ctx.currentTime;
    // Two slightly detuned low sines beating (~3.5Hz shimmer) under a narrow
    // noise band — distant heat-haze that sits beneath the music.
    var oscA = ctx.createOscillator();
    oscA.type = "sine"; oscA.frequency.value = 68;
    var oscB = ctx.createOscillator();
    oscB.type = "sine"; oscB.frequency.value = 71.5;
    var noise = ctx.createBufferSource();
    noise.buffer = getDriftNoiseBuffer(ctx);
    noise.loop = true;
    var nFilt = ctx.createBiquadFilter();
    nFilt.type = "bandpass"; nFilt.Q.value = 2.2; nFilt.frequency.value = 2600;
    var nGain = ctx.createGain(); nGain.gain.value = 0.18;
    var bassGain = ctx.createGain(); bassGain.gain.value = HEATWAVE_DRONE_BASS;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, HEATWAVE_DRONE_VOL * masterVolume * sfxVolumeScalar), now + 1.6);
    oscA.connect(bassGain); oscB.connect(bassGain); bassGain.connect(g);
    noise.connect(nFilt); nFilt.connect(nGain); nGain.connect(g);
    g.connect(sfxBus);
    try { oscA.start(now); oscB.start(now); noise.start(now); }
    catch (e) { try { g.disconnect(); } catch (e2) {} return; }
    heatwaveDroneVoice = { oscA: oscA, oscB: oscB, noise: noise, gain: g };
}

function stopHeatwaveDrone() {
    var v = heatwaveDroneVoice;
    if (v == null) { return; }
    heatwaveDroneVoice = null;
    var ctx = getCtx();
    if (!ctx) { try { v.oscA.stop(); v.oscB.stop(); v.noise.stop(); } catch (e) {} return; }
    var now = ctx.currentTime;
    try {
        v.gain.gain.setTargetAtTime(0.0001, now, 0.3);
        v.oscA.stop(now + 1.2); v.oscB.stop(now + 1.2); v.noise.stop(now + 1.2);
    } catch (e) {}
}

function playHeatwaveWarning() {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    var now = ctx.currentTime;
    var peak = Math.max(0.0002, 0.12 * masterVolume * sfxVolumeScalar);
    for (var i = 0; i < 2; i++) {
        var t0 = now + i * 0.28;
        var osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(540, t0);
        osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.16);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        osc.connect(g); g.connect(sfxBus);
        try { osc.start(t0); osc.stop(t0 + 0.25); } catch (e) {}
    }
}

// ----------------------------------------------------------------------------
// Antlions (brutal round) — three synthesized one-shots from the shared noise
// buffer + oscillators (no assets), through sfxBus so the master toggle and
// lobby dampen apply. Volumes set for MID-RACE listening (the lobby damps all
// SFX to 10% and will mislead any tuning done there). Each takes `level` 0..1,
// the caller's distance falloff to the event.
//   playThumperSlam     — the Nova Prospekt pound: a deep pitch-dropping sine
//                         body under a short lowpassed noise thud.
//   playAntlionEruption — sand burst: a bandpassed noise whoosh sweeping up
//                         then settling, with a quick chitter chirp on top.
//   playAntlionBite     — mandible snap on a landed shove: a tight noise tick
//                         plus a low knock.
function playThumperSlam(level) {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    var lvl = (level == null) ? 1 : Math.max(0, Math.min(1, level));
    if (lvl <= 0.02) { return; }
    var now = ctx.currentTime;
    // deep body: sine dropping 88 -> 36 Hz over ~0.32s
    var osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(88, now);
    osc.frequency.exponentialRampToValueAtTime(36, now + 0.32);
    var og = ctx.createGain();
    var oPeak = Math.max(0.0002, 0.34 * lvl * masterVolume * sfxVolumeScalar);
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(oPeak, now + 0.012);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
    osc.connect(og); og.connect(sfxBus);
    // dirt thud: a short burst of lowpassed noise
    var src = ctx.createBufferSource();
    src.buffer = getDriftNoiseBuffer(ctx);
    src.loop = true;
    var filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = 0.8;
    filt.frequency.setValueAtTime(900, now);
    filt.frequency.exponentialRampToValueAtTime(140, now + 0.22);
    var ng = ctx.createGain();
    var nPeak = Math.max(0.0002, 0.16 * lvl * masterVolume * sfxVolumeScalar);
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.exponentialRampToValueAtTime(nPeak, now + 0.01);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
    src.connect(filt); filt.connect(ng); ng.connect(sfxBus);
    try { osc.start(now); osc.stop(now + 0.42); src.start(now); src.stop(now + 0.3); }
    catch (e) { try { osc.disconnect(); src.disconnect(); } catch (e2) {} }
}

function playAntlionEruption(level) {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    var lvl = (level == null) ? 1 : Math.max(0, Math.min(1, level));
    if (lvl <= 0.02) { return; }
    var now = ctx.currentTime;
    // sandy whoosh
    var src = ctx.createBufferSource();
    src.buffer = getDriftNoiseBuffer(ctx);
    src.loop = true;
    var filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.Q.value = 0.9;
    filt.frequency.setValueAtTime(420, now);
    filt.frequency.exponentialRampToValueAtTime(2400, now + 0.16); // burst up...
    filt.frequency.exponentialRampToValueAtTime(600, now + 0.45);  // ...grains settling
    var g = ctx.createGain();
    var peak = Math.max(0.0002, 0.15 * lvl * masterVolume * sfxVolumeScalar);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    src.connect(filt); filt.connect(g); g.connect(sfxBus);
    // chitter: two quick descending triangle chirps
    var cPeak = Math.max(0.0002, 0.07 * lvl * masterVolume * sfxVolumeScalar);
    for (var i = 0; i < 2; i++) {
        var t0 = now + 0.12 + i * 0.09;
        var osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(1900 - i * 350, t0);
        osc.frequency.exponentialRampToValueAtTime(900 - i * 200, t0 + 0.07);
        var cg = ctx.createGain();
        cg.gain.setValueAtTime(0.0001, t0);
        cg.gain.exponentialRampToValueAtTime(cPeak, t0 + 0.012);
        cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
        osc.connect(cg); cg.connect(sfxBus);
        try { osc.start(t0); osc.stop(t0 + 0.11); } catch (e) {}
    }
    try { src.start(now); src.stop(now + 0.55); }
    catch (e) { try { src.disconnect(); } catch (e2) {} }
}

function playAntlionBite(level) {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    var lvl = (level == null) ? 1 : Math.max(0, Math.min(1, level));
    if (lvl <= 0.02) { return; }
    var now = ctx.currentTime;
    // snap: a very short bright noise tick
    var src = ctx.createBufferSource();
    src.buffer = getDriftNoiseBuffer(ctx);
    src.loop = true;
    var filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.Q.value = 2.4;
    filt.frequency.setValueAtTime(3200, now);
    filt.frequency.exponentialRampToValueAtTime(1400, now + 0.05);
    var g = ctx.createGain();
    var peak = Math.max(0.0002, 0.12 * lvl * masterVolume * sfxVolumeScalar);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    src.connect(filt); filt.connect(g); g.connect(sfxBus);
    // knock under it
    var osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(190, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.08);
    var og = ctx.createGain();
    var oPeak = Math.max(0.0002, 0.1 * lvl * masterVolume * sfxVolumeScalar);
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(oPeak, now + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    osc.connect(og); og.connect(sfxBus);
    try { src.start(now); src.stop(now + 0.09); osc.start(now); osc.stop(now + 0.12); }
    catch (e) { try { src.disconnect(); osc.disconnect(); } catch (e2) {} }
}

// Start (first call) or update (later calls) the drift loop for a player.
//   intensity 0..1 — how hard they're carving; rides gain + filter brightness so
//                    a faster slide hisses higher.
//   level     0..1 — spatial gain (the caller's distance falloff; 1 = local kart).
// Idempotent per id: the first call spins a voice up from silence, later calls
// just glide the params, so it can be driven straight from the per-frame loop.
function setDriftSound(id, intensity, level) {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    var v = driftVoices[id];
    // Muted (hard mute or master toggle off): don't spin up a NEW voice, but DO let
    // an already-running one ride its gain down to silence here — drift voices live
    // outside activeVoices, so volumeChange()/applyLiveVolumes() can't mute them, and
    // an early return would leave the skid hissing until the drift happened to end.
    var muted = gameMuted || masterVolume === 0;
    if (!v && muted) { return; }
    var vol = muted ? 0 : DRIFT_BASE_VOL * intensity * level * masterVolume * sfxVolumeScalar;
    var now = ctx.currentTime;
    if (!v) {
        var src = ctx.createBufferSource();
        src.buffer = getDriftNoiseBuffer(ctx);
        src.loop = true;
        var filt = ctx.createBiquadFilter();
        filt.type = "bandpass";
        filt.Q.value = 0.6;                     // wide band -> airy spray, not a tone
        var g = ctx.createGain();
        g.gain.value = 0.0001;                  // wash in from silence
        src.connect(filt); filt.connect(g); g.connect(sfxBus);
        try { src.start(); } catch (e) { try { src.disconnect(); } catch (e2) {} return; }
        v = driftVoices[id] = { source: src, filter: filt, gain: g };
    }
    var freq = 850 + 1900 * intensity;          // brighter as the carve intensifies
    try {
        v.filter.frequency.setTargetAtTime(freq, now, 0.05);
        v.gain.gain.setTargetAtTime(Math.max(0.0001, vol), now, 0.06);
    } catch (e) {}
}

// Fade a player's drift voice out and tear it down (drift ended / kart died / left).
function stopDriftSound(id) {
    var v = driftVoices[id];
    if (!v) { return; }
    delete driftVoices[id];
    var ctx = getCtx();
    if (!ctx) { try { v.source.stop(); } catch (e) {} return; }
    var now = ctx.currentTime;
    try {
        holdParamNow(v.gain.gain, now);
        v.gain.gain.linearRampToValueAtTime(0.0001, now + 0.18);
        v.source.stop(now + 0.22);
    } catch (e) { try { v.source.stop(); } catch (e2) {} }
}

function stopAllDriftSounds() {
    for (var id in driftVoices) { stopDriftSound(id); }
}

// --- Fire-walk sizzle (synthesized, no MP3) ---
// One looping voice for the LOCAL kart while its killstreak shield strides over lava or
// water (unified): white noise through a bandpass that brightens as you move faster, so
// the shield "sizzles/hisses" against the ground. Modeled on the drift skid — same
// out-of-activeVoices lifecycle, so it's driven straight from the per-frame loop
// (updateFireWalkAudio) and rides its gain down to silence on mute rather than cutting.
var FIREWALK_BASE_VOL = 0.13;
var fireWalkVoice = null;       // single voice (local kart only) | null
function setFireWalkSound(id, intensity, level) {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    var muted = gameMuted || masterVolume === 0;
    if (!fireWalkVoice && muted) { return; }
    var lvl = (level == null) ? 1 : level;
    var inten = (intensity == null) ? 0.4 : Math.max(0, Math.min(1, intensity));
    var vol = muted ? 0 : FIREWALK_BASE_VOL * inten * lvl * masterVolume * sfxVolumeScalar;
    var now = ctx.currentTime;
    if (!fireWalkVoice) {
        var src = ctx.createBufferSource();
        src.buffer = getDriftNoiseBuffer(ctx);   // reuse the shared white-noise bed
        src.loop = true;
        var filt = ctx.createBiquadFilter();
        filt.type = "bandpass";
        filt.Q.value = 0.8;                       // airy hiss, not a tone
        var g = ctx.createGain();
        g.gain.value = 0.0001;                    // wash in from silence
        src.connect(filt); filt.connect(g); g.connect(sfxBus);
        try { src.start(); } catch (e) { try { src.disconnect(); } catch (e2) {} return; }
        fireWalkVoice = { source: src, filter: filt, gain: g };
    }
    var freq = 1800 + 2400 * inten;               // brighter sizzle the faster you stride
    try {
        fireWalkVoice.filter.frequency.setTargetAtTime(freq, now, 0.06);
        fireWalkVoice.gain.gain.setTargetAtTime(Math.max(0.0001, vol), now, 0.07);
    } catch (e) {}
}
function stopFireWalkSound(id) {
    var v = fireWalkVoice;
    if (!v) { return; }
    fireWalkVoice = null;
    var ctx = getCtx();
    if (!ctx) { try { v.source.stop(); } catch (e) {} return; }
    var now = ctx.currentTime;
    try {
        holdParamNow(v.gain.gain, now);
        v.gain.gain.linearRampToValueAtTime(0.0001, now + 0.16);
        v.source.stop(now + 0.2);
    } catch (e) { try { v.source.stop(); } catch (e2) {} }
}

// Flame extinguished by water — synthesized one-shot "steam quench" (no MP3 asset),
// fired when a kart carrying a killstreak fire shield steps into water. A short burst of
// the shared white-noise buffer through a lowpass that sweeps DOWN (the hiss dying out)
// with a fast attack and a ~0.5s steam decay. Routed through sfxBus so the master toggle
// + lobby dampen already apply; we fold those coefficients in like the drift voices do.
function playFlameExtinguish(level) {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    var lvl = (level == null) ? 1 : level;
    var vol = EXTINGUISH_VOL * lvl * masterVolume * sfxVolumeScalar;
    if (vol <= 0.0001) { return; }
    var now = ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = getDriftNoiseBuffer(ctx); // reuse the shared 2s white-noise bed
    src.loop = true;
    var filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = 0.7;
    try {
        filt.frequency.setValueAtTime(6500, now);
        filt.frequency.exponentialRampToValueAtTime(450, now + 0.45); // hiss settles as steam
    } catch (e) {}
    var g = ctx.createGain();
    try {
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), now + 0.02); // fast attack
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);                  // steam decay
    } catch (e) {}
    src.connect(filt); filt.connect(g); g.connect(sfxBus);
    try { src.start(now); src.stop(now + 0.56); } catch (e) { try { src.disconnect(); } catch (e2) {} }
}

// --- Orbital Beam (synthesized, no MP3) ---
// A rising charge "whine" that spools up across the 5s telegraph, then a downward
// impact blast when the beam strikes. Both route through sfxBus so the master toggle +
// lobby dampen apply (folded in like the drift/extinguish voices).
var ORBITAL_CHARGE_VOL = 0.154; // 0.22 reduced 30%
var ORBITAL_IMPACT_VOL = 0.35;  // 0.5 reduced 30%
var orbitalChargeVoice = null; // { osc, osc2, noise, gain } | null (one whine at a time)

function playOrbitalBeamCharge(durationMs) {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    stopOrbitalBeamCharge(); // newest cast owns the whine
    var dur = (durationMs > 0 ? durationMs : 5000) / 1000;
    var vol = ORBITAL_CHARGE_VOL * masterVolume * sfxVolumeScalar;
    if (vol <= 0.0001) { return; }
    var now = ctx.currentTime;
    var g = ctx.createGain();
    try {
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol * 0.5), now + dur * 0.6); // swell
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), now + dur * 0.98);      // peak at strike
    } catch (e) {}
    g.connect(sfxBus);
    // Rising sawtooth — the core spool-up.
    var osc = ctx.createOscillator();
    osc.type = "sawtooth";
    var osc2 = ctx.createOscillator();
    osc2.type = "triangle";
    var noise = ctx.createBufferSource();
    noise.buffer = getDriftNoiseBuffer(ctx);
    noise.loop = true;
    try {
        osc.frequency.setValueAtTime(120, now);
        osc.frequency.exponentialRampToValueAtTime(1500, now + dur);
        osc2.frequency.setValueAtTime(240, now);
        osc2.frequency.exponentialRampToValueAtTime(3200, now + dur); // shimmer harmonic
    } catch (e) {}
    var oscGain = ctx.createGain(); oscGain.gain.value = 0.5;
    var osc2Gain = ctx.createGain(); osc2Gain.gain.value = 0.22;
    osc.connect(oscGain); oscGain.connect(g);
    osc2.connect(osc2Gain); osc2Gain.connect(g);
    // Airy noise bed through a rising bandpass.
    var nFilt = ctx.createBiquadFilter();
    nFilt.type = "bandpass"; nFilt.Q.value = 0.8;
    try {
        nFilt.frequency.setValueAtTime(400, now);
        nFilt.frequency.exponentialRampToValueAtTime(4000, now + dur);
    } catch (e) {}
    var nGain = ctx.createGain(); nGain.gain.value = 0.4;
    noise.connect(nFilt); nFilt.connect(nGain); nGain.connect(g);
    var stopAt = now + dur + 0.25; // safety stop if the fire event is missed
    try {
        osc.start(now); osc2.start(now); noise.start(now);
        osc.stop(stopAt); osc2.stop(stopAt); noise.stop(stopAt);
    } catch (e) { try { osc.disconnect(); osc2.disconnect(); noise.disconnect(); } catch (e2) {} return; }
    orbitalChargeVoice = { osc: osc, osc2: osc2, noise: noise, gain: g };
}

function stopOrbitalBeamCharge() {
    var v = orbitalChargeVoice;
    if (!v) { return; }
    orbitalChargeVoice = null;
    var ctx = getCtx();
    if (!ctx) { try { v.osc.stop(); v.osc2.stop(); v.noise.stop(); } catch (e) {} return; }
    var now = ctx.currentTime;
    try {
        holdParamNow(v.gain.gain, now);
        v.gain.gain.linearRampToValueAtTime(0.0001, now + 0.08);
        v.osc.stop(now + 0.1); v.osc2.stop(now + 0.1); v.noise.stop(now + 0.12);
    } catch (e) { try { v.osc.stop(); v.osc2.stop(); v.noise.stop(); } catch (e2) {} }
}

function playOrbitalBeamImpact() {
    var ctx = getCtx();
    if (!ctx || ctx.state !== "running") { return; }
    if (gameMuted || masterVolume === 0) { return; }
    var vol = ORBITAL_IMPACT_VOL * masterVolume * sfxVolumeScalar;
    if (vol <= 0.0001) { return; }
    var now = ctx.currentTime;
    // Bright noise blast through a downward-sweeping lowpass — the beam slamming down.
    var src = ctx.createBufferSource();
    src.buffer = getDriftNoiseBuffer(ctx);
    src.loop = true;
    var filt = ctx.createBiquadFilter();
    filt.type = "lowpass"; filt.Q.value = 0.8;
    try {
        filt.frequency.setValueAtTime(9000, now);
        filt.frequency.exponentialRampToValueAtTime(300, now + 0.5);
    } catch (e) {}
    var g = ctx.createGain();
    try {
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), now + 0.01); // hard attack
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    } catch (e) {}
    src.connect(filt); filt.connect(g); g.connect(sfxBus);
    // A sub "boom" dropping in pitch underneath the noise.
    var boom = ctx.createOscillator();
    boom.type = "sine";
    try {
        boom.frequency.setValueAtTime(220, now);
        boom.frequency.exponentialRampToValueAtTime(45, now + 0.4);
    } catch (e) {}
    var boomGain = ctx.createGain();
    try {
        boomGain.gain.setValueAtTime(Math.max(0.0001, vol * 0.8), now);
        boomGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    } catch (e) {}
    boom.connect(boomGain); boomGain.connect(sfxBus);
    try {
        src.start(now); src.stop(now + 0.66);
        boom.start(now); boom.stop(now + 0.55);
    } catch (e) { try { src.disconnect(); boom.disconnect(); } catch (e2) {} }
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
// The sounds the lobby / first interaction needs promptly. Everything else is
// loaded by the throttled background pass (preloadAllSounds), so the heavy
// gameplay music can't compete with the map/image loads that gate the lobby.
var essentialSounds = [lobbyMusic, playerJoinSound, gameStart, countDownA, countDownB];

// Start the background load of the remaining clips. Called once the lobby is
// reachable (from enterLobby in game.js), with a timed fallback in case that
// path changes — bgPreloadStarted makes it idempotent either way.
function startBackgroundAudioPreload() {
    preloadAllSounds();
}

if (typeof window !== "undefined") {
    ["mousedown", "pointerdown", "keydown", "touchstart"].forEach(function (evt) {
        window.addEventListener(evt, unlockAudio, { passive: true });
    });
    // Decode just the lobby essentials up front; defer the bulk so it doesn't
    // saturate a slow link before the player reaches the lobby.
    essentialSounds.forEach(loadSound);
    // Fallback: ensure the background pass runs even if enterLobby never calls it.
    window.setTimeout(startBackgroundAudioPreload, 4000);
    window.startBackgroundAudioPreload = startBackgroundAudioPreload;
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
    // Crossfade: fade the old track out while the new one fades in. A mood flip
    // mid-moment (e.g. you die in the lead and the room drops from exciting to
    // calm) should wash over, not slam: the outgoing track drains away over ~20s
    // while the incoming one eases up underneath it over ~8s. Only a cold start
    // (no music playing) gets the quick 1.2s entrance.
    var crossfading = false;
    if (currentBackgroundMusic != null && currentBackgroundMusic !== track) {
        if (currentBackgroundMusic.voice != null) {
            crossfading = true;
            fadingBackgroundVoice = currentBackgroundMusic.voice;
            fadeOutVoice(fadingBackgroundVoice, 20);
        }
        currentBackgroundMusic.voice = null;
        pendingSounds.delete(currentBackgroundMusic);
        currentBackgroundMusic.pendingPlay = false;
    }
    // Coming back to the track that's still draining from the last crossfade —
    // cut its tail fast so the fresh voice doesn't double over it, phase-offset.
    if (fadingBackgroundVoice != null && fadingBackgroundVoice.sound === track) {
        fadeOutVoice(fadingBackgroundVoice, 0.3);
        fadingBackgroundVoice = null;
    }
    currentBackgroundMusic = track;
    startSound(track, {
        sustained: true,
        fadeIn: crossfading ? 8 : 1.2,
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
