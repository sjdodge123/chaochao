// Device / screen-size performance profiles.
//
// Small phones and weak GPUs can't afford the same FX budget as a desktop, so a
// "profile" is a small bag of rendering-detail knobs (particle counts, effect
// caps, glow passes, trail length, the device-pixel-ratio cap, the audience
// crowd) that the render loop reads each frame. Three named quality tiers, plus
// an AUTO mode that picks one from screen size + known devices + hardware hints.
//
// The HIGH tier is tuned to be a byte-for-byte no-op versus the pre-profile
// renderer, so desktop players (the bulk of the audience) see no change; only
// small/low-end screens shed detail. The chosen tier is persisted in
// localStorage and exposed both as a navbar control (#performanceControl) and a
// row in the in-game controller Settings panel.
//
// `PERF` is the live resolved knob bag, read by draw.js / gameboard.js /
// game.js (resize) / audience.js via the small perf*() accessors below. It's
// initialised eagerly to HIGH so those reads are always valid even before the
// first detection pass runs.

// Named quality tiers. Anything not listed here falls back to HIGH.
var PERF_PROFILES = {
    // Roomy desktop / laptop: everything on. Values mirror the old hard-coded
    // renderer exactly, so selecting HIGH is indistinguishable from no profile.
    high: {
        particleCount: 1.0,      // multiplier on per-spawn particle counts
        cooldownMul: 1.0,        // multiplier on particle spawn cooldowns (>1 = rarer)
        maxEffects: 100000,      // cap on simultaneous transient effects (huge => unbounded)
        glow: true,              // per-frame shadowBlur glow passes (goal arrow, ability beam, trail, cut)
        embers: true,            // rising embers off burning karts
        explosionSparks: 10,     // debris sparks per explosion
        audience: true,          // letterbox crowd
        trailDirect: false,      // false = full per-kart offscreen trail canvas; true = stroke a capped tail straight to the main canvas (avoids re-uploading a world-sized texture/kart/frame on weak GPUs)
        mapScale: 1,             // resolution of the cached map texture (1 = full); <1 shrinks it so each re-upload on a tile change moves fewer bytes (the GPU-paint stutter on weak GPUs)
        dprCap: 2                // device-pixel-ratio ceiling for the backing store
    },
    // Tablets / small desktop windows: trim particle volume, keep the glow and
    // crowd (they read well on a mid device).
    balanced: {
        particleCount: 0.6,
        cooldownMul: 1.4,
        maxEffects: 280,
        glow: true,
        embers: true,
        explosionSparks: 7,
        audience: true,
        trailDirect: false,
        mapScale: 1,
        dprCap: 2
    },
    // Phones / low-end: shed the fill-rate-heavy work — glow passes, the crowd,
    // embers — cap effects hard, and drop the DPR a notch so the backing store
    // isn't over-rendered on dense panels.
    low: {
        particleCount: 0.4,
        cooldownMul: 2.2,
        maxEffects: 120,
        glow: false,
        embers: false,
        explosionSparks: 4,
        audience: false,
        trailDirect: true,
        mapScale: 0.6,
        dprCap: 1.5
    }
};

// Max trail vertices kept/stroked per kart in direct mode (~last few seconds of
// tail). Bounds both memory and the per-frame re-stroke, and — unlike the old
// offscreen canvas — never triggers a full-world texture upload or an unbounded
// _redrawAll, so it kills both the GPU-paint and the main-thread trail spikes.
var PERF_TRAIL_DIRECT_MAX = 240;

var PERF_STORAGE_KEY = "perfPref";
var PERF_ORDER = ["auto", "high", "balanced", "low"];
var PERF_LABEL = { auto: "Auto", high: "High", balanced: "Balanced", low: "Low" };

// In-memory preference ("auto" | "high" | "balanced" | "low"), seeded lazily
// from storage. Held separately from PERF so AUTO can re-resolve each load (and
// on resize/orientation change) while a pinned tier stays put.
var perfPref = null;
// The resolved tier name currently in effect ("high" | "balanced" | "low").
var perfTier = "high";
// The live knob bag the renderer reads. Eagerly valid (see file header).
var PERF = clonePerfProfile(PERF_PROFILES.high);

function clonePerfProfile(p) {
    var out = {};
    for (var k in p) {
        if (Object.prototype.hasOwnProperty.call(p, k)) {
            out[k] = p[k];
        }
    }
    return out;
}

function readStoredPerfPref() {
    try {
        var p = localStorage.getItem(PERF_STORAGE_KEY);
        return (p === "high" || p === "balanced" || p === "low" || p === "auto") ? p : "auto";
    } catch (e) {
        return "auto";
    }
}

function getPerfPref() {
    if (perfPref === null) {
        perfPref = readStoredPerfPref();
    }
    return perfPref;
}

function setPerfPref(pref) {
    perfPref = pref;
    try { localStorage.setItem(PERF_STORAGE_KEY, pref); } catch (e) { /* storage disabled */ }
}

// Named profiles tuned for specific target devices. A UA match here wins over
// the generic screen/hardware heuristic below, so a known phone always lands on
// LOW even on a high-DPR panel that might otherwise read as "big".
function namedDeviceTier(ua) {
    if (/iPhone|iPod/i.test(ua)) { return "low"; }        // iPhones: shed FX
    if (/iPad/i.test(ua)) { return "balanced"; }           // iPads: mid detail
    if (/Android/i.test(ua)) {
        return /Mobile/i.test(ua) ? "low" : "balanced";    // android phone vs tablet
    }
    // Note: iPadOS 13+ Safari reports a desktop "Macintosh" UA with no iPad
    // token, so it falls through here — but it's a coarse-pointer device, so the
    // touch branch in detectPerfTier still lands it on BALANCED (same as above).
    return null;
}

// Resolve AUTO to a concrete tier from the device & viewport. Conservative:
// when signals conflict it steps down a notch rather than risking a stutter.
function detectPerfTier() {
    var w = window.innerWidth || (screen && screen.width) || 1366;
    var h = window.innerHeight || (screen && screen.height) || 768;
    var minDim = Math.min(w, h);
    var touch = (typeof isTouchScreen !== "undefined" && isTouchScreen === true);
    var cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0;
    var mem = (typeof navigator !== "undefined" && navigator.deviceMemory) || 0; // GB, Chromium-only
    var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";

    var named = namedDeviceTier(ua);
    if (named) { return named; }

    // Coarse-pointer (touch) screens: bucket by physical size. LOW is reserved
    // for phone-sized touch screens — a mouse/desktop never auto-drops to LOW,
    // so the desktop audience keeps the full show (CHANGELOG promise).
    if (touch) {
        return (minDim <= 480) ? "low" : "balanced"; // phone vs tablet/large-touch
    }

    // Desktop / laptop. Only genuinely weak machines (a couple of cores, or
    // ~2GB RAM) or cramped windows step down to BALANCED; 4-core/8GB and up,
    // at a normal window size, stay HIGH.
    if ((cores && cores <= 2) || (mem && mem <= 2)) { return "balanced"; }
    if (w < 900 || h < 560) { return "balanced"; }

    return "high";
}

// Recompute the active tier from the preference and copy its knobs into PERF.
// Re-applies the DPR cap (via resize) and refreshes any visible UI.
function applyPerfProfile() {
    var pref = getPerfPref();
    var prevDprCap = (PERF && PERF.dprCap != null) ? PERF.dprCap : null;
    perfTier = (pref === "auto") ? detectPerfTier() : pref;
    if (!PERF_PROFILES[perfTier]) {
        perfTier = "high";
    }
    PERF = clonePerfProfile(PERF_PROFILES[perfTier]);
    // The particle/glow/effect knobs are read live each frame, so they take
    // effect on the next frame with no extra work. Only the DPR cap feeds the
    // backing-store size (set in resize), so re-fit ONLY when it actually
    // changes — toggling e.g. High<->Balanced (same cap) shouldn't reallocate
    // the canvas or reset the camera.
    if (PERF.dprCap !== prevDprCap && typeof resize === "function") {
        try { resize(); } catch (e) { /* canvas not ready yet */ }
    }
    // The map cache resolution (mapScale) is baked into the cached canvas, so a
    // tier change must discard it (not just mark it dirty) to re-bake at the new
    // resolution rather than re-rendering into the old-sized canvas.
    if (typeof discardMapCache === "function") {
        discardMapCache();
    }
    updatePerformanceToggleUI();
    if (typeof renderSettingsRows === "function") {
        try { renderSettingsRows(); } catch (e) { /* settings panel not open */ }
    }
}

// Cycle auto -> high -> balanced -> low -> auto (navbar click / settings row).
function cyclePerfProfile() {
    var next = PERF_ORDER[(PERF_ORDER.indexOf(getPerfPref()) + 1) % PERF_ORDER.length];
    setPerfPref(next);
    applyPerfProfile();
}

// Label for the navbar/settings UI. AUTO shows the tier it resolved to, e.g.
// "Auto (Low)", so players can see what the detector picked.
function perfProfileLabel() {
    var pref = getPerfPref();
    if (pref === "auto") {
        return "Auto (" + (PERF_LABEL[perfTier] || "High") + ")";
    }
    return PERF_LABEL[pref] || "High";
}

function updatePerformanceToggleUI() {
    var el = (typeof document !== "undefined") ? document.getElementById("performanceControl") : null;
    if (!el) {
        return;
    }
    el.innerHTML = '<i class="music-btn fas fa-bolt" aria-hidden="true"></i> [' + perfProfileLabel() + ']';
    el.setAttribute("title", "Graphics detail: " + perfProfileLabel() + " (click to change)");
    el.setAttribute("aria-label", "Graphics detail: " + perfProfileLabel() + ". Click to change.");
}

// --- Renderer-facing accessors, read every frame. PERF is eagerly initialised
// above and never cleared, so these read it directly; renderer call sites guard
// `typeof perfX === "function"` to cover perf.js being absent entirely (in which
// case these functions don't exist either). Keep them cheap. ---
// Scale a requested particle burst. A burst that was going to spawn (n >= 1)
// always keeps at least one fleck — profiles thin particles, they don't make
// terrain feedback vanish entirely (full removal is an explicit knob, e.g.
// perfEmbers). n == 0 stays 0.
function perfCount(n) {
    return Math.max(n >= 1 ? 1 : 0, Math.round(n * PERF.particleCount));
}
function perfCooldown(ms) {
    return ms * PERF.cooldownMul;
}
// Gates the per-frame shadowBlur glow passes in the racing hot path (the
// off-screen goal arrow, the ability/aim beam, the kart trail, the cut slash).
// One-shot, cached (halo/sprite), lobby and HUD glows are intentionally left
// alone — they're not in the per-frame racing budget the LOW tier targets.
function perfGlow() { return !!PERF.glow; }
function perfEmbers() { return !!PERF.embers; }
function perfTrailDirect() { return !!PERF.trailDirect; }
function perfTrailDirectMax() { return PERF_TRAIL_DIRECT_MAX; }
function perfMapScale() { return PERF.mapScale || 1; }
function perfExplosionSparks() { return PERF.explosionSparks; }
function perfMaxEffects() { return PERF.maxEffects; }
function perfDprCap() { return PERF.dprCap; }
function perfAudienceAllowed() { return PERF.audience !== false; }

// --- Optional on-screen frame-time HUD (diagnostic) ---
// Enabled with ?fps=1 in the URL (or localStorage perfHud=1). Shows smoothed FPS
// plus the WORST frame in each ~0.5s window — the worst-frame number is the
// stutter signal: if FPS reads ~50 but worst spikes to 80ms+, that's hitching,
// not a low average. Off by default; pure overlay, never touches gameplay.
var perfHudOn = null, perfHudEl = null, perfHudAccum = 0, perfHudFrames = 0, perfHudWorst = 0;
function perfHudEnabled() {
    if (perfHudOn === null) {
        perfHudOn = false;
        try {
            perfHudOn = /[?&]fps=1\b/.test(window.location.search || "") ||
                (localStorage.getItem("perfHud") === "1");
        } catch (e) { /* no location/storage */ }
    }
    return perfHudOn;
}
function perfHudTick(dt) {
    if (!perfHudEnabled() || !(dt > 0)) {
        return;
    }
    if (dt > perfHudWorst) { perfHudWorst = dt; }
    perfHudFrames++;
    perfHudAccum += dt;
    if (perfHudAccum < 500) {
        return;
    }
    var fps = Math.round(1000 * perfHudFrames / perfHudAccum);
    var worst = Math.round(perfHudWorst);
    if (!perfHudEl && typeof document !== "undefined" && document.body) {
        perfHudEl = document.createElement("div");
        perfHudEl.id = "perfHud";
        perfHudEl.style.cssText = "position:fixed;top:4px;left:4px;z-index:99999;" +
            "font:bold 12px monospace;background:rgba(0,0,0,.6);color:#0f0;" +
            "padding:3px 6px;border-radius:4px;pointer-events:none;white-space:pre;";
        document.body.appendChild(perfHudEl);
    }
    if (perfHudEl) {
        perfHudEl.textContent = fps + " fps   worst " + worst + "ms   [" + perfProfileLabel() + "]";
        // Red = a real stutter spike this window; amber = low average; green = smooth.
        perfHudEl.style.color = worst > 40 ? "#ff5555" : (fps < 45 ? "#ffdd00" : "#00ff66");
    }
    perfHudAccum = 0; perfHudFrames = 0; perfHudWorst = 0;
}

// --- Optional perf telemetry to the server (diagnostic) ---
// Enabled with ?diag=1 (or localStorage perfDiag=1). Streams compact render-perf
// samples over the existing socket so a stutter on a real device can be read from
// the SERVER log ([perf-diag] lines): rolling frame-time stats, a coarse phase
// split (input / render / rest), device class + current game-state counts, and —
// on Chromium — Long Animation Frame attribution (script vs render blocking),
// which is the clearest signal for whether spikes are JS/GC or rendering. Off by
// default; sends only technical data (no PII beyond the UA string), and a spike
// frame triggers an immediate (throttled) report so the stutter is captured.
var perfDiagOn = null, perfDiagInited = false;
var pdFrames = 0, pdSum = 0, pdWorst = 0, pdDrop = 0, pdSpike = 0;
var pdInSum = 0, pdInWorst = 0, pdRnSum = 0, pdRnWorst = 0, pdRsSum = 0, pdRsWorst = 0;
var pdWinStart = 0, pdLastSpikeEmit = 0, pdLoaf = [];
var PD_WINDOW_MS = 3000, PD_SPIKE_MS = 60, PD_SPIKE_EMIT_GAP = 1500;
// Bump this whenever the perf code changes meaningfully, so a device reporting an
// old value tells us it loaded a stale (cached) bundle rather than the new fix.
var PERF_DIAG_VERSION = "td2";

function perfDiagEnabled() {
    if (perfDiagOn === null) {
        perfDiagOn = false;
        try {
            perfDiagOn = /[?&]diag=1\b/.test(window.location.search || "") ||
                (localStorage.getItem("perfDiag") === "1");
        } catch (e) { /* no location/storage */ }
    }
    return perfDiagOn;
}

function perfDiagInit() {
    if (perfDiagInited || !perfDiagEnabled()) {
        return;
    }
    perfDiagInited = true;
    pdWinStart = Date.now();
    // Chromium: attribute long frames (script/style/layout/paint blocking). Tells
    // us whether a spike was JS execution (incl. GC) or rendering. No-op elsewhere.
    try {
        if (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes &&
            PerformanceObserver.supportedEntryTypes.indexOf("long-animation-frame") !== -1) {
            var po = new PerformanceObserver(function (list) {
                var es = list.getEntries();
                for (var i = 0; i < es.length; i++) {
                    pdLoaf.push({ d: Math.round(es[i].duration), b: Math.round(es[i].blockingDuration || 0) });
                    if (pdLoaf.length > 8) { pdLoaf.shift(); }
                }
            });
            po.observe({ type: "long-animation-frame", buffered: true });
        }
    } catch (e) { /* observer unsupported */ }
}

function perfDiagCount(obj) {
    if (obj == null) { return 0; }
    if (typeof obj.length === "number") { return obj.length; }
    var n = 0; for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { n++; } }
    return n;
}

function perfDiagEmit(reason) {
    var sock = (typeof server !== "undefined") ? server : null;
    if (!sock || typeof sock.emit !== "function") {
        return;
    }
    var frames = pdFrames || 1;
    var nav = (typeof navigator !== "undefined") ? navigator : {};
    var payload = {
        r: reason,
        ua: (nav.userAgent || "").slice(0, 180),
        dpr: window.devicePixelRatio || 1,
        iw: window.innerWidth, ih: window.innerHeight,
        cores: nav.hardwareConcurrency || 0, mem: nav.deviceMemory || 0,
        tier: perfTier, pref: getPerfPref(),
        v: PERF_DIAG_VERSION,                                   // build marker: confirms the device ran THIS code (not a cached old bundle)
        td: (typeof perfTrailDirect === "function") ? perfTrailDirect() : null, // is the direct-trail fix active this frame?
        ms: (typeof perfMapScale === "function") ? perfMapScale() : null,       // map-cache resolution scale (1 = full, <1 = reduced)
        st: (typeof currentState !== "undefined") ? currentState : null,
        karts: (typeof playerList !== "undefined") ? perfDiagCount(playerList) : 0,
        fx: (typeof effectsList !== "undefined") ? perfDiagCount(effectsList) : 0,
        proj: (typeof projectileList !== "undefined") ? perfDiagCount(projectileList) : 0,
        fps: Math.round(1000 * pdFrames / Math.max(1, pdSum)),
        avg: +(pdSum / frames).toFixed(1), worst: Math.round(pdWorst),
        drop33: pdDrop, spike60: pdSpike,
        ph: {
            in: { a: +(pdInSum / frames).toFixed(1), w: +pdInWorst.toFixed(1) },
            rn: { a: +(pdRnSum / frames).toFixed(1), w: +pdRnWorst.toFixed(1) },
            rs: { a: +(pdRsSum / frames).toFixed(1), w: +pdRsWorst.toFixed(1) }
        },
        loaf: pdLoaf.slice(-5)
    };
    try { sock.emit("clientPerfDiag", JSON.stringify(payload)); } catch (e) { /* socket not ready */ }
}

function perfDiagReset() {
    pdFrames = 0; pdSum = 0; pdWorst = 0; pdDrop = 0; pdSpike = 0;
    pdInSum = 0; pdInWorst = 0; pdRnSum = 0; pdRnWorst = 0; pdRsSum = 0; pdRsWorst = 0;
    pdWinStart = Date.now();
}

// Per-frame sample. inputMs/renderMs/restMs are the gameLoop phase splits.
function perfDiagTick(dt, inputMs, renderMs, restMs) {
    if (!perfDiagEnabled() || !(dt > 0)) {
        return;
    }
    // Ignore non-render stalls: a backgrounded/locked tab or an asset-load gap
    // produces multi-second "frames" that aren't rendering and would swamp the
    // stats (the 5–6s "frames" seen in early captures). Real render spikes are
    // well under this.
    if (dt > 2000 || (typeof document !== "undefined" && document.hidden)) {
        return;
    }
    if (!perfDiagInited) { perfDiagInit(); }
    pdFrames++; pdSum += dt;
    if (dt > pdWorst) { pdWorst = dt; }
    if (dt > 33) { pdDrop++; }            // missed 30fps
    if (dt > PD_SPIKE_MS) { pdSpike++; }  // a stutter spike
    pdInSum += inputMs; if (inputMs > pdInWorst) { pdInWorst = inputMs; }
    pdRnSum += renderMs; if (renderMs > pdRnWorst) { pdRnWorst = renderMs; }
    pdRsSum += restMs; if (restMs > pdRsWorst) { pdRsWorst = restMs; }

    var now = Date.now();
    // Capture a single bad spike promptly (throttled) so we see what coincided.
    if (dt > PD_SPIKE_MS && now - pdLastSpikeEmit > PD_SPIKE_EMIT_GAP) {
        pdLastSpikeEmit = now;
        perfDiagEmit("spike");
    }
    if (now - pdWinStart >= PD_WINDOW_MS) {
        perfDiagEmit("interval");
        perfDiagReset();
    }
}

// Wire the navbar control and run the first detection pass once the DOM is up.
// Re-resolve AUTO on viewport changes (rotate / resize) so going landscape on a
// tablet, say, can step the tier up or down.
function initPerf() {
    var el = (typeof document !== "undefined") ? document.getElementById("performanceControl") : null;
    if (el && !el._perfWired) {
        el._perfWired = true;
        el.addEventListener("click", cyclePerfProfile);
        el.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " " || e.keyCode === 13 || e.keyCode === 32) {
                e.preventDefault();
                e.stopPropagation();
                cyclePerfProfile();
            }
        });
    }
    if (typeof window !== "undefined" && !window._perfResizeWired) {
        window._perfResizeWired = true;
        // Re-resolve AUTO on viewport changes (rotate / resize), but DEBOUNCED:
        // mobile browsers fire 'resize' rapidly as the address bar shows/hides on
        // scroll, and re-applying (a possible canvas re-fit) on each would stutter.
        // Collapse a burst into one settled check, and only re-apply on a genuine
        // tier change (applyPerfProfile itself re-fits only if the DPR cap moved).
        var resizeTimer = null;
        window.addEventListener("resize", function () {
            if (getPerfPref() !== "auto") {
                return;
            }
            if (resizeTimer) {
                clearTimeout(resizeTimer);
            }
            resizeTimer = setTimeout(function () {
                resizeTimer = null;
                if (getPerfPref() === "auto" && detectPerfTier() !== perfTier) {
                    applyPerfProfile();
                }
            }, 300);
        });
    }
    perfDiagInit();
    applyPerfProfile();
}

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initPerf);
    } else {
        initPerf();
    }
}
