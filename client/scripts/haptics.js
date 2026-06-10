// --- Controller rumble (Gamepad haptics) ---
// Drives dual-rumble force feedback on connected controllers. Two layers feed a
// single per-pad magnitude each frame (only one effect can play per actuator, so
// everything is mixed down before a single playEffect call):
//
//   1. Ambient: a per-pad mirror of the screen-shake "trauma" model (see
//      gameboard.js). It does NOT read the global shakeTrauma scalar — that's tied
//      to the shared camera and would buzz every local pad for one player's hit in
//      couch co-op. Instead each shake call site also feeds haptic trauma, routed
//      to the right place: local-specific shakes (punch hits, charge-hold, muzzle
//      recoil) via traumaForId/chargeTraumaForId, and global world events (volcano,
//      collapse, explosions) via traumaAll/sustainTraumaAll. See that section below.
//   2. Discrete pulses: one-shot envelopes for events that DON'T shake the screen
//      but should buzz a specific local player's pad (death, finish, infection,
//      water splash/swim/steam) or all local pads (race GO).
//
// Toggle: navbar #hapticsControl, persisted as localStorage "hapticsPref". Default
// ON. Honoured by the single update entry point so the toggle gates both layers.
//
// Support: dual-rumble via gamepad.vibrationActuator.playEffect is Chrome/Edge
// (the desktop controller audience). Safari/Firefox lack it; every call is
// feature-checked and silently no-ops there.

var hapticsEnabled = true;

// Per-pad-index transient pulse envelope: { strong, weak, start, dur } where the
// magnitude decays linearly to zero over `dur` ms from `start`. Keyed by the same
// pad index navigator.getGamepads() uses, matching localPlayers[].padIndex.
var hapticPulses = {};

// Throttle re-issuing playEffect: each effect is requested with a duration that
// outlives several frames, so we only need to refresh it periodically (or when the
// magnitude changes meaningfully) rather than every single frame. Keyed by pad index.
var hapticLastIssue = {};        // pad index -> { strong, weak, at }
var HAPTIC_EFFECT_MS = 120;      // duration handed to each playEffect call
var HAPTIC_REISSUE_MS = 60;      // refresh cadence while a magnitude holds steady
var HAPTIC_MIN = 0.02;           // below this, treat as silent (and let the effect lapse)

function loadHapticsPref() {
    try {
        var v = localStorage.getItem("hapticsPref");
        hapticsEnabled = (v == null) ? true : (v === "on");
    } catch (e) {
        hapticsEnabled = true;
    }
}

function setHapticsEnabled(on) {
    hapticsEnabled = !!on;
    try { localStorage.setItem("hapticsPref", hapticsEnabled ? "on" : "off"); } catch (e) {}
    if (!hapticsEnabled) {
        stopAllHaptics();
    }
}

// Map a 0..1 trauma value to a (strong, weak) magnitude pair. Trauma's rendered
// offset uses trauma^2 so big hits read much harder than small ones; mirror that
// curve so a light jostle is a faint bump and a volcano is a heavy rumble. The
// heavy low-frequency motor (strongMagnitude) carries the body; the high-frequency
// motor (weakMagnitude) rides along at ~60% for texture.
function traumaToMagnitude(trauma) {
    if (trauma <= 0) { return null; }
    var strong = Math.min(1, trauma * trauma * 1.4);
    return { strong: strong, weak: strong * 0.6 };
}

// --- Per-pad ambient trauma (haptic-only mirror of the screen-shake model) ---
// The screen-shake `shakeTrauma` is a single GLOBAL scalar tied to the shared
// camera, so reading it directly would buzz every local pad for one player's hit
// (wrong in couch co-op). Instead, haptics keeps its OWN trauma per pad index:
// local-specific shakes (punch hits, charge, muzzle recoil) route to the
// originating player's pad via traumaForId/chargeTraumaForId, while genuinely
// global world events (collapse, volcano, explosions) fan out to every local pad
// via traumaAll/sustainTraumaAll. Each call site keeps driving the visual
// shakeTrauma too; these run alongside it, they don't replace it.
var hapticTrauma = {};         // padIndex -> trauma 0..1
var hapticSustainUntil = {};   // padIndex -> ms (floor active until)
var hapticSustainFloor = {};   // padIndex -> 0..1
var HAPTIC_TRAUMA_DECAY = 1.6; // units/sec — matches gameboard.js shakeDecayPerSec

function padIndexForId(id) {
    if (id == null || typeof localPlayers === "undefined" || !localPlayers) { return null; }
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (lp && lp.myID == id && lp.padIndex != null) { return lp.padIndex; }
    }
    return null;
}
function addPadTrauma(padIndex, amount) {
    // Discard events fired while rumble is off — otherwise trauma accumulates with
    // the mixer paused and replays the moment the toggle comes back on.
    if (!hapticsEnabled || padIndex == null) { return; }
    hapticTrauma[padIndex] = Math.min(1, (hapticTrauma[padIndex] || 0) + amount);
}
// One-shot ambient jolt routed to the local pad that earned it (no-op if not local).
function traumaForId(id, amount) { addPadTrauma(padIndexForId(id), amount); }
// Fan an ambient jolt out to every local pad (genuinely global world events).
function traumaAll(amount) {
    if (typeof localPlayers === "undefined" || !localPlayers) { return; }
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (lp && lp.padIndex != null) { addPadTrauma(lp.padIndex, amount); }
    }
}
// A sustained floor on every local pad for durationMs (e.g. a volcano eruption).
function sustainTraumaAll(durationMs, intensity) {
    if (!hapticsEnabled || typeof localPlayers === "undefined" || !localPlayers) { return; }
    var until = Date.now() + durationMs;
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (lp && lp.padIndex != null) {
            hapticSustainUntil[lp.padIndex] = until;
            hapticSustainFloor[lp.padIndex] = intensity;
            addPadTrauma(lp.padIndex, intensity);
        }
    }
}
// A held charge floor on one local player's pad (refreshed each frame while
// charging, like gameboard.js chargeRumble): holds steady instead of ramping.
function chargeTraumaForId(id, intensity) {
    if (!hapticsEnabled) { return; }
    var idx = padIndexForId(id);
    if (idx == null) { return; }
    if (Date.now() < hapticSustainUntil[idx]) {
        hapticSustainFloor[idx] = Math.max(hapticSustainFloor[idx] || 0, intensity);
    } else {
        hapticSustainFloor[idx] = intensity;
    }
    // Keep the LATER deadline: a longer world-event sustain already running (e.g. a
    // volcano's 2.5s) must not be truncated to this 90ms charge window when the
    // player releases charge before the event ends.
    hapticSustainUntil[idx] = Math.max(hapticSustainUntil[idx] || 0, Date.now() + 90);
}
// Advance one pad's ambient trauma: apply any active sustain floor, then decay.
function tickPadTrauma(padIndex, dt) {
    if (Date.now() < hapticSustainUntil[padIndex] &&
        (hapticTrauma[padIndex] || 0) < hapticSustainFloor[padIndex]) {
        hapticTrauma[padIndex] = hapticSustainFloor[padIndex];
    }
    var tr = hapticTrauma[padIndex] || 0;
    if (tr > 0) {
        hapticTrauma[padIndex] = Math.max(0, tr - HAPTIC_TRAUMA_DECAY * (dt / 1000));
    }
    return hapticTrauma[padIndex] || 0;
}

// Queue a discrete pulse on a specific pad index. strong/weak are 0..1 peak
// magnitudes; the envelope decays to zero over durMs. A new pulse replaces any
// running one on that pad (the mixer takes the max against ambient each frame).
function padPulseIndex(padIndex, strong, weak, durMs) {
    if (!hapticsEnabled || padIndex == null) { return; }
    hapticPulses[padIndex] = {
        strong: Math.min(1, strong),
        weak: Math.min(1, weak == null ? strong : weak),
        start: Date.now(),
        dur: durMs || 200
    };
}

// Pulse the pad bound to a given local player id (couch co-op: only that player's
// controller buzzes). No-op if the id isn't a local slot or has no pad.
function padPulseForId(id, strong, weak, durMs) {
    if (id == null || typeof localPlayers === "undefined" || !localPlayers) { return; }
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (lp && lp.myID == id && lp.padIndex != null) {
            padPulseIndex(lp.padIndex, strong, weak, durMs);
            return;
        }
    }
}

// Pulse every locally-bound pad (environmental / shared-moment events like race GO).
function padPulseAll(strong, weak, durMs) {
    if (typeof localPlayers === "undefined" || !localPlayers) { return; }
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (lp && lp.padIndex != null) {
            padPulseIndex(lp.padIndex, strong, weak, durMs);
        }
    }
}

// Current decayed magnitude of a pad's transient pulse (or null once it expires).
function activePulse(padIndex) {
    var p = hapticPulses[padIndex];
    if (p == null) { return null; }
    var t = (Date.now() - p.start) / p.dur;
    if (t >= 1) {
        delete hapticPulses[padIndex];
        return null;
    }
    var k = 1 - t; // linear decay
    return { strong: p.strong * k, weak: p.weak * k };
}

function padActuator(pad) {
    if (!pad) { return null; }
    if (pad.vibrationActuator && typeof pad.vibrationActuator.playEffect === "function") {
        return pad.vibrationActuator;
    }
    return null;
}

// Send a dual-rumble effect to one pad, throttled so we don't spam playEffect every
// frame: refresh only when the magnitude shifts meaningfully or the cadence elapses.
function issueRumble(padIndex, act, strong, weak) {
    var prev = hapticLastIssue[padIndex];
    var now = Date.now();
    var changed = !prev ||
        Math.abs(prev.strong - strong) > 0.05 ||
        Math.abs(prev.weak - weak) > 0.05 ||
        (now - prev.at) > HAPTIC_REISSUE_MS;
    if (!changed) { return; }
    hapticLastIssue[padIndex] = { strong: strong, weak: weak, at: now };
    try {
        act.playEffect("dual-rumble", {
            startDelay: 0,
            duration: HAPTIC_EFFECT_MS,
            strongMagnitude: strong,
            weakMagnitude: weak
        });
    } catch (e) { /* unsupported effect type / detached pad — ignore */ }
}

function stopPad(padIndex, act) {
    if (hapticLastIssue[padIndex] == null) { return; }
    delete hapticLastIssue[padIndex];
    try {
        if (typeof act.reset === "function") { act.reset(); }
        else { act.playEffect("dual-rumble", { duration: 0, strongMagnitude: 0, weakMagnitude: 0 }); }
    } catch (e) { /* ignore */ }
}

function stopAllHaptics() {
    var pads = (typeof navigator !== "undefined" && navigator.getGamepads) ? navigator.getGamepads() : [];
    for (var i = 0; i < pads.length; i++) {
        var act = padActuator(pads[i]);
        if (act) { stopPad(i, act); }
    }
    hapticPulses = {};
    hapticTrauma = {};
    hapticSustainUntil = {};
    hapticSustainFloor = {};
}

// Per-frame mixer: for each locally-bound pad, take the max of the ambient trauma
// magnitude and any active discrete pulse, then issue (or lapse) the effect. Called
// from the game loop after pollGamepad. Cheap: a handful of pads, mostly silent.
function updateHaptics(dt) {
    if (!hapticsEnabled || typeof localPlayers === "undefined" || !localPlayers) { return; }
    var pads = (typeof navigator !== "undefined" && navigator.getGamepads) ? navigator.getGamepads() : [];
    if (!pads) { return; }
    var step = (typeof dt === "number" && dt > 0) ? dt : 16;
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (!lp || lp.padIndex == null) { continue; }
        var idx = lp.padIndex;
        // Decay this pad's ambient trauma every frame (even with no actuator).
        var trauma = tickPadTrauma(idx, step);
        var act = padActuator(pads[idx]);
        if (!act) { continue; }
        var strong = 0, weak = 0;
        var ambient = traumaToMagnitude(trauma);
        if (ambient) { strong = ambient.strong; weak = ambient.weak; }
        var pulse = activePulse(idx);
        if (pulse) {
            if (pulse.strong > strong) { strong = pulse.strong; }
            if (pulse.weak > weak) { weak = pulse.weak; }
        }
        if (strong < HAPTIC_MIN && weak < HAPTIC_MIN) {
            stopPad(idx, act);
        } else {
            issueRumble(idx, act, strong, weak);
        }
    }
}

// Update the navbar toggle glyph (check vs ban) to match state.
function updateHapticsToggleUI() {
    var el = document.getElementById("hapticsControl");
    if (!el) { return; }
    var status = hapticsEnabled
        ? '[<i class="music-btn fa fa-check" aria-hidden="true"></i>]'
        : '[<i class="music-btn fa fa-ban" aria-hidden="true"></i>]';
    el.innerHTML = '<i class="music-btn fas fa-mobile-alt" aria-hidden="true"></i> ' + status;
}
