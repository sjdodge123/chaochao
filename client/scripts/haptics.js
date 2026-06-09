// --- Controller rumble (Gamepad haptics) ---
// Drives dual-rumble force feedback on connected controllers. Two layers feed a
// single per-pad magnitude each frame (only one effect can play per actuator, so
// everything is mixed down before a single playEffect call):
//
//   1. Ambient: mirrors the screen-shake "trauma" model (see gameboard.js). Every
//      event that shakes the camera — punch hits on/by a local player, charged
//      thwacks, charge-hold buzz, volcano eruptions, lava collapse — already adds
//      trauma, gated to the local player where appropriate, so reading shakeTrauma
//      gives correctly-targeted rumble for free and stays in sync with shake tuning.
//   2. Discrete pulses: one-shot envelopes for events that DON'T shake the screen
//      but should buzz a specific local player's pad (death, finish, infection) or
//      all local pads (race GO).
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

// Queue a discrete pulse on a specific pad index. strong/weak are 0..1 peak
// magnitudes; the envelope decays to zero over durMs. A new pulse replaces any
// running one on that pad (the mixer takes the max against ambient each frame).
function padPulseIndex(padIndex, strong, weak, durMs) {
    if (padIndex == null) { return; }
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
}

// Per-frame mixer: for each locally-bound pad, take the max of the ambient trauma
// magnitude and any active discrete pulse, then issue (or lapse) the effect. Called
// from the game loop after pollGamepad. Cheap: a handful of pads, mostly silent.
function updateHaptics() {
    if (!hapticsEnabled || typeof localPlayers === "undefined" || !localPlayers) { return; }
    var pads = (typeof navigator !== "undefined" && navigator.getGamepads) ? navigator.getGamepads() : [];
    if (!pads) { return; }
    var ambient = (typeof shakeTrauma !== "undefined") ? traumaToMagnitude(shakeTrauma) : null;
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (!lp || lp.padIndex == null) { continue; }
        var idx = lp.padIndex;
        var act = padActuator(pads[idx]);
        if (!act) { continue; }
        var strong = 0, weak = 0;
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
