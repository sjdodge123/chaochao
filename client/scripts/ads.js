// ads.js — network-agnostic ad layer for ChaoChao.
//
// SCOPE: interstitials at the gameOver state transition (frequency-capped) AND the
// rewarded-video "Watch to 2× match XP" reward on the results screen. The rewarded
// reward is credited server-side (server/messenger.js claimXpMultiplier +
// auth.addProgression, gated on writesEnabled); the client onReward below is only the
// signal — see docs/ads-monetization-plan.md, "Rewarded video".
//
// GameMonetize note: their HTML5 SDK exposes only showBanner() + the
// SDK_GAME_PAUSE/START events — NO dedicated rewarded unit, no reward-granted event,
// and no server-to-server completion postback. So a rewarded ad reuses showBanner() and
// a CONFIRMED full play (PAUSE -> START) is treated as the reward signal; the server's
// single-claim + TTL + fixed-multiplier guards are the anti-abuse. A true rewarded unit /
// S2S postback is a documented follow-up if the network later supports it.
//
// DESIGN CONTRACT
//   - Network-agnostic. Only this file knows which ad network is wired. The rest
//     of the client calls ads.* and never touches an SDK. Swapping AdinPlay for
//     GameMonetize later is a one-file change (the inside of initProvider()).
//   - provider 'none' (the local-dev / no-creds default) makes every call a
//     graceful no-op: callbacks fire immediately so gameplay NEVER blocks.
//   - Fail-open everywhere. Every ad request has a hard timeout; on SDK absence,
//     throw, or network error the close/skip/error callback still fires and the
//     game proceeds exactly as it does today.
//   - Embedded mode (portal iframes): no direct-network ads. The portal SDK
//     serves them; double-stacking would be wrong. We no-op cleanly here; the
//     real portal-SDK-backed implementation lands with the distribution chunk.
//   - Frequency cap lives HERE (localStorage + constants below), NOT in
//     server/config.json — keeps this chunk off the gameplay-mechanic CHANGELOG
//     path.
//
// CONFIG comes from window.__ADS__ (injected into play.html server-side from the
// ADS_PROVIDER / ADS_PUBLISHER_ID env vars). Absent/none => no-op.
//
// This file shares globals with the rest of the play bundle (not a module
// bundler — see CLAUDE.md). It exposes window.ads.
(function () {
    "use strict";

    // ---- Tunable constants (this is the ONLY place to tune ad frequency) ------
    // Interstitial cadence: show at most once per N finished matches AND never
    // more often than every COOLDOWN_MS. Both gates must pass.
    var MATCHES_PER_INTERSTITIAL = 2;   // every 2nd finished match is eligible
    var INTERSTITIAL_COOLDOWN_MS = 90 * 1000; // ...and not more than once / 90s
    var AD_TIMEOUT_MS = 8 * 1000;       // hard timeout on any ad request

    // localStorage keys (frequency-cap state survives reloads within a device).
    var LS_LAST_TS = "ads_last_interstitial_ts";
    var LS_MATCH_COUNT = "ads_match_count_since_interstitial";

    // ---- Internal state -------------------------------------------------------
    var provider = "none";   // 'adinplay' | 'gamemonetize' | 'none'
    var publisherId = null;
    var sdkReady = false;    // network SDK loaded + ready to serve
    var initialized = false;
    // The settle() of the currently in-flight interstitial, or null. Lets
    // dismissInterstitial() tear down an ad that's still up when the next race
    // starts, so an interstitial can never sit over live gameplay.
    var activeSettle = null;
    // Which kind of ad is currently in flight: "interstitial" | "rewarded" | null.
    // The interstitial and rewarded paths SHARE the provider plumbing (GameMonetize's
    // single showBanner()/PAUSE/START slots; AdinPlay's single adplayer). They never run
    // at the same time (mutually exclusive at the gameOver->lobby edge), but
    // dismissInterstitial() runs at race start and must NOT tear down an in-flight REWARDED
    // ad the player opted into — that would drop its completion and silently deny the credit.
    // So dismiss only acts when an interstitial is in flight; a rewarded ad is left to finish.
    var adInFlight = null;

    // ---- Small safe helpers ---------------------------------------------------
    function lsGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function lsSet(key, val) {
        try { window.localStorage.setItem(key, String(val)); } catch (e) { /* private mode */ }
    }
    function nowMs() { return Date.now(); }

    // GA passthrough — trackEvent() is defined inline in play.html and no-ops if
    // gtag is blocked, so this can never throw.
    function track(name, params) {
        try {
            if (typeof window.trackEvent === "function") { window.trackEvent(name, params || {}); }
        } catch (e) { /* analytics must never break gameplay */ }
    }

    function embedded() {
        // isEmbedded() ships in embed.js (loaded before the bundle). Treat its
        // absence as "not embedded" so a load-order hiccup can't suppress ads.
        try { return typeof window.isEmbedded === "function" && window.isEmbedded(); }
        catch (e) { return false; }
    }

    // Single source of truth for "should this user see ads at all?". v1 returns
    // true for everyone; when the remove-ads subscription chunk lands it flips
    // off here for subscribers (one place to change).
    function shouldShow() {
        if (provider === "none") { return false; }
        if (embedded()) { return false; }   // portal SDK owns ads when embedded
        return true;
    }

    // Lazy-load kick. The network SDK is NOT injected at page init (some loaders, e.g.
    // GameMonetize, auto-show a preroll the moment they initialize — that splashed an ad on
    // the first lobby, before the player had played). Instead each adapter exposes an optional
    // ensureLoaded() that injects its <script> once, and we call this from the demand paths
    // (canShowInterstitial / isRewardedAvailable / the show* entry points). Those are only
    // reached AFTER a match ends, so the SDK is pulled in lazily — never on the first lobby.
    // Idempotent + fail-open: a missing ensureLoaded or a load failure just keeps us a no-op.
    function ensureSdkLoaded() {
        if (!shouldShow()) { return; }   // provider 'none' / embedded -> never load a network
        // Never KICK a load during a live round: an SDK that autostarts a preroll on init could
        // then splash it over gameplay. Loads are kicked from gameOver/lobby edges (preloadSdk /
        // the availability gates), so this is belt-and-suspenders against a stray gameplay call.
        if (inActiveGameplay()) { return; }
        try {
            if (adapter && typeof adapter.ensureLoaded === "function") { adapter.ensureLoaded(); }
        } catch (e) { /* fail-open: load failure just leaves the SDK absent (no-op) */ }
    }

    // Hard guard: an ad must NEVER cover live gameplay. Returns true when the client is in an
    // active-gameplay state (gated / racing / collapsing) — the waiting / lobby / overview /
    // gameOver edges are the only valid ad surfaces. Reads the shared `currentState` /
    // `config.stateMap` globals from the play bundle. If they're absent (load-order, or this
    // file on a non-play page) we return false so a missing global can't suppress a legitimate
    // ad — the cadence/availability gates upstream already constrain WHEN we get here.
    function inActiveGameplay() {
        try {
            var cs = window.currentState;
            var sm = window.config && window.config.stateMap;
            if (typeof cs !== "number" || !sm) { return false; }
            return cs === sm.gated || cs === sm.racing || cs === sm.collapsing;
        } catch (e) { return false; }
    }

    // ---- Frequency cap --------------------------------------------------------
    // Called once per FINISHED match (from the gameOver hook), regardless of
    // whether an ad ends up showing — it advances the per-match counter.
    // The counter SEEDS to (MATCHES_PER_INTERSTITIAL - 1) on a player's very first
    // finished match so that first match is already eligible — interstitials then
    // fire on matches 1, 3, 5, … (show, skip one, show), the every-2-match cadence.
    function onMatchEnded() {
        var raw = lsGet(LS_MATCH_COUNT);
        var count;
        if (raw === null) {
            count = MATCHES_PER_INTERSTITIAL - 1; // first ever match -> eligible now
        } else {
            count = parseInt(raw, 10);
            if (isNaN(count)) { count = 0; }
        }
        lsSet(LS_MATCH_COUNT, count + 1);
    }

    function canShowInterstitial() {
        if (!shouldShow()) { return false; }
        // First demand for an ad after a match end — kick the lazy SDK load (no-op once
        // loaded). The first request races the SDK becoming ready, so this returns false
        // now (treated as no-fill, gameplay proceeds) and the SDK is ready for next time.
        ensureSdkLoaded();
        if (!sdkReady) { return false; } // nothing loaded => nothing to show
        var count = parseInt(lsGet(LS_MATCH_COUNT) || "0", 10);
        if (isNaN(count)) { count = 0; }
        if (count < MATCHES_PER_INTERSTITIAL) { return false; }
        var last = parseInt(lsGet(LS_LAST_TS) || "0", 10);
        if (isNaN(last)) { last = 0; }
        if (nowMs() - last < INTERSTITIAL_COOLDOWN_MS) { return false; }
        return true;
    }

    // Reset the cadence counters after an interstitial fires.
    function markInterstitialShown() {
        lsSet(LS_LAST_TS, nowMs());
        lsSet(LS_MATCH_COUNT, 0);
    }

    // ---- Provider adapters ----------------------------------------------------
    // Each adapter implements showInterstitial(onStart, onComplete, onError):
    //   onStart()    — MUST be called the moment a real ad actually begins playing
    //                  (an impression). This — not the attempt — is what commits the
    //                  frequency cap and emits ad_shown. If the network has no fill,
    //                  onStart must NOT fire, so an empty request never burns the cap
    //                  or distorts the GA funnel.
    //   onComplete() — the ad finished or was closed. (If it arrives without onStart
    //                  having fired, the public layer treats it as a no-fill: no
    //                  impression, cadence left untouched.)
    //   onError()    — the SDK threw / was unusable.
    // The adapter does NOT own the timeout or the exactly-once guarantee — that
    // single settle authority lives in the public showInterstitial() below. The
    // rewarded path is intentionally NOT implemented for any provider yet (deferred
    // half — needs the progression engine in main).
    var adapter = null;

    // AdinPlay (recommended default). Their SDK exposes a global `aiptag` queue
    // and an `aipPlayer` constructor loaded from a CDN tag. We inject that tag
    // dynamically so it only loads when a real provider is configured (play.html
    // carries no ad SDK by default — saves bytes for visitors who never play).
    function initAdinPlay() {
        // NOTE: the exact aiptag boilerplate / zone ids come from the operator's
        // AdinPlay dashboard. This wires the documented integration shape; until
        // a publisher account + zone exist the script 404s and sdkReady stays
        // false, so canShowInterstitial() returns false and everything no-ops.
        window.aiptag = window.aiptag || { cmd: [] };
        window.aiptag.cmd = window.aiptag.cmd || [];
        window.aiptag.cmd.player = window.aiptag.cmd.player || [];

        var s = document.createElement("script");
        // Publisher-scoped CDN tag. The operator's real tag URL is set via the
        // dashboard; publisherId selects their account.
        s.src = "//api.adinplay.com/libs/aiptag/pageads/" +
            encodeURIComponent(publisherId || "") + "/aiptag.js";
        s.async = true;
        s.onload = function () { sdkReady = true; };
        s.onerror = function () { sdkReady = false; }; // fail-open: stays no-op
        (document.head || document.documentElement).appendChild(s);

        // AdinPlay is NOT the chosen network (GameMonetize is) so this path is wired-but-untested.
        // INTERSTITIAL: a close (AIP_REMOVE) and a full play (AIP_COMPLETE) both just mean "the
        // ad is done" — either resolves it. REWARDED is stricter: the reward must be granted ONLY
        // on a full watch (AIP_COMPLETE); an early close (AIP_REMOVE before COMPLETE) is a SKIP,
        // not a reward — otherwise dismissing a preroll would pay out 2× XP. AIP_START is the
        // impression signal for both (no-fill never fires it).
        function aipShowInterstitial(onStart, onComplete, onError) {
            try {
                window.aiptag.cmd.player.push(function () {
                    try {
                        window.aiptag.adplayer = new window.aipPlayer({
                            AD_WIDTH: 960,
                            AD_HEIGHT: 540,
                            AD_DISPLAY: "fullscreen",
                            LOADING_TEXT: "Advertisement",
                            AIP_START: function () { onStart(); },
                            AIP_COMPLETE: function () { onComplete(); },
                            AIP_REMOVE: function () { onComplete(); } // close == done for an interstitial
                        });
                        window.aiptag.adplayer.startPreRoll();
                    } catch (e) { onError(); }
                });
            } catch (e) { onError(); }
        }
        function aipShowRewarded(onStart, onComplete, onError, onSkip) {
            try {
                window.aiptag.cmd.player.push(function () {
                    try {
                        var completed = false;
                        window.aiptag.adplayer = new window.aipPlayer({
                            AD_WIDTH: 960,
                            AD_HEIGHT: 540,
                            AD_DISPLAY: "fullscreen",
                            LOADING_TEXT: "Advertisement",
                            AIP_START: function () { onStart(); },
                            AIP_COMPLETE: function () { completed = true; onComplete(); }, // full watch -> reward
                            AIP_REMOVE: function () {
                                // Close: only a no-op AFTER a real completion. A close BEFORE complete
                                // is an early dismiss -> SKIP (no reward), never onComplete.
                                if (completed) { return; }
                                if (typeof onSkip === "function") { onSkip(); } else { onError(); }
                            }
                        });
                        window.aiptag.adplayer.startPreRoll();
                    } catch (e) { onError(); }
                });
            } catch (e) { onError(); }
        }
        adapter = {
            showInterstitial: aipShowInterstitial,
            showRewarded: aipShowRewarded,
            // Best-effort teardown if we must reclaim the screen for the next race.
            dismiss: function () {
                try {
                    if (window.aiptag && window.aiptag.adplayer &&
                        typeof window.aiptag.adplayer.destroy === "function") {
                        window.aiptag.adplayer.destroy();
                    }
                } catch (e) { /* best-effort */ }
            }
        };
    }

    // GameMonetize — the recommended default for a low-traffic site (laxer
    // onboarding than AdinPlay). Its SDK differs structurally from AdinPlay: it's
    // a SINGLETON loaded once with a global window.SDK_OPTIONS.onEvent handler,
    // not a per-call constructor. The integration shape (verbatim from their SDK
    // README):
    //   window.SDK_OPTIONS = { gameId, onEvent: fn };  // set BEFORE the loader
    //   loader injects https://api.gamemonetize.com/sdk.js (id gamemonetize-sdk)
    //   onEvent(a) fires a.name: SDK_READY | SDK_ERROR | SDK_GAME_PAUSE | SDK_GAME_START
    //   show an ad: window.sdk.showBanner();
    //   the sequence per showBanner() is SDK_GAME_PAUSE -> (ad) -> SDK_GAME_START.
    //   SDK_GAME_PAUSE fires ONLY when an ad is actually about to play, so it's our
    //   real START/impression signal. SDK_GAME_START fires when the ad finishes AND
    //   also when there's NO FILL (no ad shown), so it's the completion signal but
    //   NOT proof an ad ran — a START with no preceding PAUSE is a no-fill. SDK_ERROR
    //   => SDK never became ready (stays no-op).
    // Because onEvent is a singleton, we route PAUSE -> pending start and START ->
    // pending complete; the public showInterstitial() owns the 8s timeout and the
    // exactly-once settle, so a missing/duplicate event can't wedge us.
    var gmPendingStart = null;    // fires on SDK_GAME_PAUSE (real impression)
    var gmPendingComplete = null; // fires on SDK_GAME_START (ad done / no-fill)
    function initGameMonetize() {
        sdkReady = false;
        // One-shot guard: set whenever we deliberately TEAR DOWN a request we initiated (a
        // rewarded/interstitial timeout or a race-start dismiss). After a teardown the provider
        // can still fire a late SDK_GAME_PAUSE for that abandoned request; without this we'd
        // misread that stray PAUSE as a fresh unsolicited autostart and adopt it (double
        // impression). The flag makes the very next stray PAUSE be ignored once — a genuine
        // init-autostart (no preceding teardown) is still adopted. See the PAUSE handler.
        var gmSuppressUnsolicited = false;
        // LAZY LOAD (acquisition-UX fix): we set up SDK_OPTIONS here but DELIBERATELY do
        // NOT inject https://api.gamemonetize.com/sdk.js yet. Their loader can auto-show a
        // preroll the instant it initializes, so pulling it in at page load splashed an ad
        // on the very FIRST lobby — before the player had played a single match. The loader
        // is now injected on demand by gmEnsureLoaded() (wired to adapter.ensureLoaded and
        // kicked from the show / availability paths), and the first such demand can only
        // happen AFTER a match ends. See ensureSdkLoaded() below.
        window.SDK_OPTIONS = {
            gameId: publisherId || "",
            onEvent: function (a) {
                var name = a && a.name;
                if (name === "SDK_READY") {
                    sdkReady = true;
                } else if (name === "SDK_ERROR") {
                    sdkReady = false; // fail-open: stays a no-op
                } else if (name === "SDK_GAME_PAUSE") {
                    // A real ad is about to play on top of the results screen — mute
                    // so no audio bleeds under it (their TOS forbids it). stopAllSounds()
                    // already ran in the gameOver handler; guard in case it didn't.
                    try { if (typeof window.stopAllSounds === "function") { window.stopAllSounds(); } } catch (e) {}
                    // This is the impression signal — commit the cap / emit ad_shown.
                    var sb = gmPendingStart;
                    gmPendingStart = null;
                    if (typeof sb === "function") {
                        sb();   // our solicited ad's impression
                    } else if (gmSuppressUnsolicited) {
                        // A request we initiated was just torn down (timeout / dismiss); this
                        // stray PAUSE belongs to it, not a fresh autostart. Ignore it once.
                        gmSuppressUnsolicited = false;
                    } else if (adInFlight === null) {
                        // UNSOLICITED preroll: GameMonetize's SDK can autostart an ad on init,
                        // OUTSIDE our showBanner() flow. It never passed through showInterstitial(),
                        // so without this it's invisible — no impression telemetry, and the
                        // startGated/startRace dismiss safety net (which keys off adInFlight) can't
                        // reclaim the screen if the ad lingers into the next race. Adopt it as an
                        // in-flight interstitial (sets adInFlight + activeSettle) and bridge its
                        // completion (the next SDK_GAME_START) to the adopted settle so it resolves
                        // cleanly. The dismiss is still best-effort (GM exposes no hard close — see
                        // adapter.dismiss), but now the autostart is tracked, muted, and torn down
                        // at the gate exactly like a solicited interstitial.
                        var adoptedSettle = trackProviderInterstitial();
                        // SDK_GAME_START for this autostart resolves it as a real completion
                        // (records ad_complete); dismissInterstitial settles it "cancelled".
                        gmPendingComplete = function () { adoptedSettle("complete"); };
                    }
                } else if (name === "SDK_GAME_START") {
                    // Ad finished (or no fill) — resolve the in-flight interstitial.
                    var cb = gmPendingComplete;
                    gmPendingStart = null; // a START without a prior PAUSE = no-fill
                    gmPendingComplete = null;
                    if (typeof cb === "function") { cb(); }
                }
            }
        };
        // VERIFICATION DETECTABILITY (P2): GameMonetize's activation check visits play.html
        // WITHOUT completing a match and expects to find the SDK integrated. Pure lazy-loading
        // would make us invisible to that scan. So at init we add an INERT, detectable marker:
        // a <script type="text/plain"> carrying the canonical sdk.js URL. A text/plain script is
        // NOT fetched and NOT executed by the browser, so it CANNOT autostart a preroll (the very
        // thing we're suppressing), yet it leaves a DOM/source-detectable reference to the SDK
        // (script[src*="gamemonetize"] + window.SDK_OPTIONS, both present pre-match). The
        // EXECUTABLE loader is still injected lazily by gmEnsureLoaded() under a DIFFERENT id,
        // only after a match. NOTE: if GM's verifier instead requires the SDK to have actually
        // executed (window.sdk live), that can't be satisfied without re-introducing the preroll
        // — the operator must then either verify once with autostart on, or (preferred) ask GM to
        // disable dashboard autostart so the real SDK can load eagerly with no preroll. Network
        // specifics stay in this file (ads.js).
        try {
            if (!document.getElementById("gamemonetize-sdk-marker")) {
                var marker = document.createElement("script");
                marker.id = "gamemonetize-sdk-marker";
                marker.type = "text/plain";   // inert: never fetched, never executed -> no autostart
                marker.setAttribute("data-gamemonetize-sdk", "1");
                marker.src = "https://api.gamemonetize.com/sdk.js";
                (document.head || document.documentElement).appendChild(marker);
            }
        } catch (e) { /* the marker is best-effort; never block init */ }

        // Lazy loader: inject the GameMonetize loader exactly as their README specifies, but
        // ONLY when first asked (ensureSdkLoaded -> adapter.ensureLoaded). Idempotent by id —
        // the gamemonetize-sdk guard means the <script> is appended at most once no matter how
        // many demands arrive. Fail-open: a 404/blocked load just leaves sdkReady false (no-op).
        function gmEnsureLoaded() {
            try {
                if (document.getElementById("gamemonetize-sdk")) { return; }
                var s = document.createElement("script");
                s.id = "gamemonetize-sdk";
                s.src = "https://api.gamemonetize.com/sdk.js";
                s.onerror = function () { sdkReady = false; }; // 404/blocked -> no-op
                (document.head || document.documentElement).appendChild(s);
            } catch (e) { sdkReady = false; }
        }

        // One ad-show routine for BOTH interstitial and rewarded. GameMonetize's HTML5 SDK
        // exposes only showBanner() and the SDK_GAME_PAUSE/START events — there is NO dedicated
        // rewarded unit, no "reward granted" event, and no server-to-server completion postback
        // (verified against their SDK source). So a rewarded ad is the same showBanner() video;
        // the public layer treats a CONFIRMED full play (PAUSE -> START) as the reward signal
        // and a START with no prior PAUSE as a no-fill (skip). Interstitial and rewarded never
        // overlap in time (lobby gate vs results screen), so sharing the pending slots is safe.
        function gmShowAd(onStart, onComplete, onError) {
            try {
                // Stash the start/complete cbs for the next PAUSE/START. If a previous ad is
                // somehow still pending, clear its slots first (don't replay its start — that
                // would double-count an impression; the public timeout already settled it).
                gmPendingStart = null;
                if (typeof gmPendingComplete === "function") {
                    var stale = gmPendingComplete; gmPendingComplete = null; stale();
                }
                gmPendingStart = onStart;
                gmPendingComplete = onComplete;
                if (window.sdk && typeof window.sdk.showBanner === "function") {
                    window.sdk.showBanner();
                } else {
                    // SDK object missing despite sdkReady — treat as error.
                    gmPendingStart = null;
                    gmPendingComplete = null;
                    onError();
                }
            } catch (e) {
                gmPendingStart = null;
                gmPendingComplete = null;
                onError();
            }
        }
        adapter = {
            showInterstitial: gmShowAd,
            showRewarded: gmShowAd,
            ensureLoaded: gmEnsureLoaded,   // lazy-injects sdk.js on first real ad demand
            // Best-effort teardown for race-start cancellation. NOTE: the GameMonetize
            // preroll SDK exposes no documented programmatic close, so we can only
            // drop our pending callbacks here — visually dismissing an already-playing
            // GM ad is a known limitation (the overlay closes on its own normal
            // lifecycle). Clearing the slots still prevents a late SDK_GAME_START from
            // re-resolving a cancelled request.
            dismiss: function () {
                gmPendingStart = null;
                gmPendingComplete = null;
                // The provider may emit a late PAUSE for this torn-down request — suppress
                // adopting that stray event as a fresh unsolicited autostart (one-shot).
                gmSuppressUnsolicited = true;
            }
        };
    }

    function initProvider() {
        if (provider === "adinplay") { initAdinPlay(); }
        else if (provider === "gamemonetize") { initGameMonetize(); }
        else {
            // 'none' — pure no-op adapter; completes immediately with NO start (no
            // impression). (In practice unreachable via showInterstitial(), which
            // early-returns when canShowInterstitial() is false for provider 'none'.)
            sdkReady = false;
            adapter = {
                showInterstitial: function (onStart, onComplete) { onComplete(); },
                // Unreachable in practice (isRewardedAvailable() is false for provider 'none',
                // so showRewarded() short-circuits to onSkip before reaching the adapter).
                showRewarded: function (onStart, onComplete) { onComplete(); }
            };
        }
    }

    // ---- Public API -----------------------------------------------------------
    function init(opts) {
        if (initialized) { return; }
        initialized = true;
        opts = opts || {};
        provider = (opts.provider || "none").toLowerCase();
        publisherId = opts.publisherId || null;

        // Embedded => the portal SDK serves ads; never load a direct network.
        if (embedded()) { provider = "none"; }

        initProvider();

        if (provider !== "none") {
            console.log("[ads] provider=" + provider + " (publisher set: " +
                (!!publisherId) + ")");
        }
    }

    // Interstitial: runs ON TOP OF the results screen. onClose ALWAYS fires
    // (success, fail, or timeout). Callers must NOT gate any game-flow transition
    // on this — it's purely cosmetic-over-the-top.
    function showInterstitial(args) {
        args = args || {};
        var placement = args.placement || "gameover";
        var onClose = (typeof args.onClose === "function") ? args.onClose : function () {};
        // Belt-and-suspenders: an ad must never cover live gameplay. The normal trigger is the
        // gameOver->lobby edge, but refuse outright if somehow called while a round is live
        // (gated/racing/collapsing). Fail-open: just fire onClose so nothing is gated on it.
        if (inActiveGameplay()) {
            try { console.warn("[ads] refused interstitial during active gameplay"); } catch (e) {}
            track("ad_blocked", { type: "interstitial", reason: "active_gameplay" });
            onClose();
            return;
        }
        if (!canShowInterstitial()) { onClose(); return; }

        // Impression/cadence are committed ONLY when the ad actually starts (onStart),
        // NOT on the attempt. So a no-fill or a failed request never burns the 90s
        // cooldown / match counter, and never emits ad_shown — keeping the GA funnel
        // honest and not suppressing the next genuine opportunity. `started` gates
        // ad_complete/ad_error too: a settle without a start is a silent no-fill.
        var started = false;
        function onStart() {
            if (started) { return; }
            started = true;
            // The watchdog guards the REQUEST (waiting for an ad to begin), not
            // playback. Once an ad is actually on screen we must NOT time it out —
            // a real interstitial can run well past AD_TIMEOUT_MS, and firing the
            // timeout here would settle the request, log a bogus ad_error, suppress
            // the genuine completion event, and call onClose while the ad is still
            // visible. Clear it; from here we wait for the provider's complete/close.
            clearTimeout(timer);
            markInterstitialShown();
            track("ad_shown", { type: "interstitial", placement: placement });
        }

        // Single settle authority: fires exactly once. The hard timeout is the
        // fail-open guarantee — if no ad ever STARTS, gameplay proceeds. (It's
        // cleared in onStart once playback begins — see above.)
        var settled = false;
        var timer = setTimeout(function () { settle("timeout"); }, AD_TIMEOUT_MS);
        function settle(status) {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            activeSettle = null;
            adInFlight = null;
            if (status === "complete") {
                // Completion is only an impression if the ad actually started.
                // A "complete" with no start is a NO-FILL (GameMonetize signals it
                // as SDK_GAME_START without a prior PAUSE): emit nothing and leave
                // the cadence untouched so the next match can try again.
                if (started) {
                    track("ad_complete", { type: "interstitial", placement: placement });
                }
            } else if (status === "cancelled") {
                // Deliberate teardown (the next race is starting — see
                // dismissInterstitial): NOT a failure and NOT a completion, so emit
                // no telemetry. The impression (ad_shown) already counted if it had
                // started; we just close out so gameplay isn't covered.
            } else {
                // "error" (SDK threw) or "timeout" (no ad started in time). Always
                // useful failure telemetry, and never an impression, so it can't
                // inflate the ad_shown -> ad_complete funnel. A pre-start error does
                // NOT burn the cadence (markInterstitialShown only runs in onStart).
                track("ad_error", { type: "interstitial", placement: placement, reason: status });
            }
            try { onClose(); } catch (e) { /* gameplay must proceed */ }
        }
        // Expose this in-flight settle so dismissInterstitial() can tear it down if
        // the next race starts before the ad closes on its own.
        activeSettle = settle;
        adInFlight = "interstitial";

        try {
            adapter.showInterstitial(
                onStart,
                function () { settle("complete"); },
                function () { settle("error"); }
            );
        } catch (e) {
            settle("error");
        }
    }

    // Tear down any in-flight INTERSTITIAL so it can't sit over live gameplay. Called when
    // the next race is about to start (startGated / startRace). Asks the provider to drop the
    // ad (best-effort — see each adapter's dismiss note), then settles the in-flight request as
    // "cancelled" (no telemetry, fires onClose). No-op when nothing is showing.
    //
    // IMPORTANT: this must NOT touch an in-flight REWARDED ad. The two share the provider's
    // single ad slot, but the rewarded one was opted into for a reward — dropping it at race
    // start would clear its completion callback and silently deny the credit (and strand the
    // client awaiting an ack). So we only tear down when an interstitial is what's in flight;
    // a rewarded ad is left to finish on its own and pay out, even if the race has begun.
    function dismissInterstitial() {
        if (adInFlight !== "interstitial") { return; }
        try {
            if (adapter && typeof adapter.dismiss === "function") { adapter.dismiss(); }
        } catch (e) { /* best-effort */ }
        if (typeof activeSettle === "function") { activeSettle("cancelled"); }
    }

    // Adopt a PROVIDER-INITIATED ad (one the network's SDK started on its own — e.g. a
    // GameMonetize preroll fired on init, outside our showBanner() flow) into the same
    // interstitial bookkeeping a solicited ad uses, so it's never invisible: registers
    // adInFlight = "interstitial" + an activeSettle, so dismissInterstitial() reclaims the slot
    // at race start (best-effort — the provider may expose no hard close), and emits the
    // impression. If the autostart somehow began over a live round it's flagged (ad_blocked),
    // never silent. Returns the one-shot settle the adapter bridges to the provider's completion
    // event (SDK_GAME_START) so the adopted ad resolves and clears adInFlight cleanly. No-op-safe
    // to call again: a second adoption while one is in flight is prevented by the caller's
    // adInFlight === null guard.
    function trackProviderInterstitial() {
        var settled = false;
        // status: "complete" (provider's SDK_GAME_START) or "cancelled" (dismissInterstitial at
        // the gate). Mirrors showInterstitial's settle so the funnel stays symmetric: an adopted
        // preroll that finishes records ad_complete; a deliberate teardown records nothing.
        function settle(status) {
            if (settled) { return; }
            settled = true;
            if (activeSettle === settle) { activeSettle = null; }
            if (adInFlight === "interstitial") { adInFlight = null; }
            if (status === "complete") {
                track("ad_complete", { type: "interstitial", placement: "provider_auto" });
            }
        }
        activeSettle = settle;     // dismissInterstitial() calls activeSettle("cancelled") -> settle("cancelled")
        adInFlight = "interstitial";
        track("ad_shown", { type: "interstitial", placement: "provider_auto" });
        // An autostarted preroll IS a real impression, so it must burn the frequency cap exactly
        // like a solicited interstitial — otherwise the seeded cadence stays eligible and the
        // very next match could request another ad, breaking the 2-match / 90s cap.
        markInterstitialShown();
        if (inActiveGameplay()) {
            // The autostart raced into a live round. We can't force-close the provider's overlay
            // (no API — same limitation as a solicited ad), but flag it so it's never silent;
            // dismissInterstitial() at the next gate will still attempt the best-effort teardown.
            track("ad_blocked", { type: "interstitial", reason: "provider_auto_in_gameplay" });
        }
        return settle;
    }

    // ---- Rewarded video — "Watch to 2× match XP" ------------------------------
    // True once a real network's SDK is ready (and we're allowed to show ads at all:
    // not embedded, provider != 'none'). The UI gates the results-screen reward button
    // on this — so locally / when embedded / when no network is wired, the button never
    // renders and gameplay is untouched. GameMonetize has no separate "rewarded loaded"
    // signal, so readiness == SDK ready.
    function isRewardedAvailable() {
        if (!shouldShow()) { return false; }  // provider 'none' or embedded -> not available
        // Kick the lazy SDK load (no-op once loaded). This is reached at the gameOver->lobby
        // edge when deciding whether to offer the 2× prompt — i.e. only AFTER a match — so the
        // SDK never loads on the first lobby. First call returns false (not yet ready); the
        // offer simply isn't made that match and the SDK is ready for the next one.
        ensureSdkLoaded();
        return !!sdkReady;
    }

    // Show a rewarded ad. onReward fires ONLY on a confirmed full watch (an ad actually
    // started AND completed); onSkip on a no-fill or a close-before-complete; onError on
    // an SDK throw or the request timing out before any ad starts. Single settle authority
    // + hard timeout + exactly-once, mirroring showInterstitial's discipline — the reward is
    // never credited on a mere attempt or a no-fill, so the GA funnel and the XP grant stay
    // honest. Fail-open: if no real ad path exists, we skip (no reward, no error noise).
    function showRewarded(args) {
        args = args || {};
        var placement = args.placement || "xp_2x";
        var onReward = (typeof args.onReward === "function") ? args.onReward : function () {};
        var onSkip = (typeof args.onSkip === "function") ? args.onSkip : function () {};
        var onError = (typeof args.onError === "function") ? args.onError : function () {};

        // Belt-and-suspenders: never play a rewarded ad over live gameplay. The offer toast is a
        // lobby surface, but refuse outright if somehow triggered mid-round (gated/racing/
        // collapsing) and fail open as a SKIP so the player can retry from the lobby.
        if (inActiveGameplay()) {
            try { console.warn("[ads] refused rewarded ad during active gameplay"); } catch (e) {}
            track("ad_blocked", { type: "rewarded", reason: "active_gameplay" });
            onSkip();
            return;
        }

        // No real, ready network (local 'none' / embedded / SDK not loaded) — fail open as a
        // skip so the caller leaves the button up for a retry and never credits a reward.
        if (!isRewardedAvailable() || !adapter || typeof adapter.showRewarded !== "function") {
            onSkip();
            return;
        }

        var started = false;
        function onStart() {
            if (started) { return; }
            started = true;
            // The watchdog guards the REQUEST (waiting for an ad to begin), not playback —
            // a rewarded video runs well past AD_TIMEOUT_MS. Clear it now that an ad is on
            // screen; from here we wait for the provider's complete/error.
            clearTimeout(timer);
            track("ad_shown", { type: "rewarded", placement: placement });
        }

        var settled = false;
        var timer = setTimeout(function () { settle("timeout"); }, AD_TIMEOUT_MS);
        function settle(status) {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            adInFlight = null;
            if (status === "timeout") {
                // The request is still pending in the provider (no ad started in time). Tear it
                // down so a slow ad can't appear AFTER we've given up — otherwise it would cover
                // the screen, fire a late ad_shown, and complete with no credit (this settle is
                // already closed). dismiss() clears GameMonetize's pending PAUSE/START callbacks
                // and destroys AdinPlay's player. No interstitial can be in flight here.
                try { if (adapter && typeof adapter.dismiss === "function") { adapter.dismiss(); } } catch (e) {}
            }
            if (status === "complete") {
                if (started) {
                    // Confirmed full watch -> grant the reward.
                    track("ad_complete", { type: "rewarded", placement: placement });
                    try { onReward(); } catch (e) { /* caller must not break the screen */ }
                } else {
                    // "complete" with no start = no-fill (GameMonetize signals it as
                    // SDK_GAME_START without a prior PAUSE). Not watched -> no reward, just skip.
                    track("ad_skipped", { type: "rewarded", placement: placement });
                    try { onSkip(); } catch (e) {}
                }
            } else if (status === "skipped") {
                track("ad_skipped", { type: "rewarded", placement: placement });
                try { onSkip(); } catch (e) {}
            } else {
                // "error" (SDK threw) or "timeout" (no ad started in time): no reward.
                track("ad_error", { type: "rewarded", placement: placement, reason: status });
                try { onError(); } catch (e) {}
            }
        }

        adInFlight = "rewarded";   // so dismissInterstitial() leaves this opted-in ad alone
        try {
            adapter.showRewarded(
                onStart,
                function () { settle("complete"); },
                function () { settle("error"); },
                // Adapter-signalled SKIP (e.g. AdinPlay AIP_REMOVE before AIP_COMPLETE = early
                // close): NOT a reward. GameMonetize has no early-close event, so its adapter
                // ignores this 4th arg (a no-fill is detected in settle() as complete-without-start).
                function () { settle("skipped"); }
            );
        } catch (e) {
            settle("error");
        }
    }

    // Start loading the network SDK as EARLY as possible in the post-match break (called from
    // the gameOver/results edge), so a GameMonetize-style loader that autostarts a preroll on
    // init does so over the results screen — a valid ad surface — with the whole lobby countdown
    // of lead time before the next race, instead of racing into gated/racing. Idempotent + a
    // no-op while in active gameplay / for provider 'none' / embedded; never blocks anything.
    function preloadSdk() {
        try { ensureSdkLoaded(); } catch (e) { /* fail-open */ }
    }

    window.ads = {
        init: init,
        onMatchEnded: onMatchEnded,
        preloadSdk: preloadSdk,
        canShowInterstitial: canShowInterstitial,
        showInterstitial: showInterstitial,
        dismissInterstitial: dismissInterstitial,
        shouldShow: shouldShow,
        isRewardedAvailable: isRewardedAvailable,
        showRewarded: showRewarded,
        // Exposed for headless tests / debugging.
        _config: function () { return { provider: provider, sdkReady: sdkReady, adInFlight: adInFlight }; }
    };

    // Auto-init from server-injected config. window.__ADS__ is set by the
    // ADS_CONFIG injection in play.html; absent => defaults to provider 'none'.
    init(window.__ADS__ || { provider: "none" });
})();
