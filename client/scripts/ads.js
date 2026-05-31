// ads.js — network-agnostic ad layer for ChaoChao (interstitial half).
//
// SCOPE (this chunk): interstitials at the gameOver state transition,
// frequency-capped. The rewarded-video "Watch to 2× XP" half is DEFERRED until
// the cosmetics progression engine (server/progression.js + auth.addProgression)
// lands in main — see docs/ads-monetization-plan.md, "Dependency". The rewarded
// API surface below is present but stubbed (isRewardedAvailable() === false,
// showRewarded() fails open) so the forward-compatible interface exists without
// any progression dependency. Do NOT render the rewarded button until the
// server-side claim handler ships.
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
    // Each adapter implements showInterstitial(onComplete, onError): it calls
    // onComplete() on a genuine full/closed ad and onError() on an SDK throw. The
    // adapter does NOT own the timeout or the exactly-once guarantee — that single
    // settle authority lives in the public showInterstitial() below. The rewarded
    // path is intentionally NOT implemented for any provider yet (deferred half —
    // needs the progression engine in main).
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

        adapter = {
            showInterstitial: function (onComplete, onError) {
                try {
                    window.aiptag.cmd.player.push(function () {
                        try {
                            window.aiptag.adplayer = new window.aipPlayer({
                                AD_WIDTH: 960,
                                AD_HEIGHT: 540,
                                AD_DISPLAY: "fullscreen",
                                LOADING_TEXT: "Advertisement",
                                AIP_COMPLETE: function () { onComplete(); },
                                AIP_REMOVE: function () { onComplete(); }
                            });
                            window.aiptag.adplayer.startPreRoll();
                        } catch (e) { onError(); }
                    });
                } catch (e) { onError(); }
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
    //   the sequence per showBanner() is SDK_GAME_PAUSE -> (ad) -> SDK_GAME_START;
    //   SDK_GAME_START fires even when there's no fill, so it's our "ad done/closed"
    //   completion signal. SDK_ERROR => SDK never became ready (stays no-op).
    // Because onEvent is a singleton, we route SDK_GAME_START to a single pending
    // completion callback; the public showInterstitial() still owns the 8s timeout
    // and the exactly-once settle, so a missing/duplicate event can't wedge us.
    var gmPendingComplete = null; // set while an interstitial is in flight
    function initGameMonetize() {
        sdkReady = false;
        window.SDK_OPTIONS = {
            gameId: publisherId || "",
            onEvent: function (a) {
                var name = a && a.name;
                if (name === "SDK_READY") {
                    sdkReady = true;
                } else if (name === "SDK_ERROR") {
                    sdkReady = false; // fail-open: stays a no-op
                } else if (name === "SDK_GAME_PAUSE") {
                    // Ad starting on top of the results screen — mute so no audio
                    // bleeds under the ad (their TOS forbids it). stopAllSounds()
                    // already ran in the gameOver handler; guard in case it didn't.
                    try { if (typeof window.stopAllSounds === "function") { window.stopAllSounds(); } } catch (e) {}
                } else if (name === "SDK_GAME_START") {
                    // Ad finished (or no fill) — resolve the in-flight interstitial.
                    var cb = gmPendingComplete;
                    gmPendingComplete = null;
                    if (typeof cb === "function") { cb(); }
                }
            }
        };
        // Inject the loader exactly as their README specifies (idempotent by id).
        try {
            if (!document.getElementById("gamemonetize-sdk")) {
                var s = document.createElement("script");
                s.id = "gamemonetize-sdk";
                s.src = "https://api.gamemonetize.com/sdk.js";
                s.onerror = function () { sdkReady = false; }; // 404/blocked -> no-op
                (document.head || document.documentElement).appendChild(s);
            }
        } catch (e) { sdkReady = false; }

        adapter = {
            showInterstitial: function (onComplete, onError) {
                try {
                    // Stash the completion cb for the next SDK_GAME_START. If a
                    // previous one is somehow still pending, fire it now so we never
                    // strand a callback (the public timeout would have settled the
                    // game side already; this just clears our slot).
                    if (typeof gmPendingComplete === "function") {
                        var stale = gmPendingComplete; gmPendingComplete = null; stale();
                    }
                    gmPendingComplete = onComplete;
                    if (window.sdk && typeof window.sdk.showBanner === "function") {
                        window.sdk.showBanner();
                    } else {
                        // SDK object missing despite sdkReady — treat as error.
                        gmPendingComplete = null;
                        onError();
                    }
                } catch (e) {
                    gmPendingComplete = null;
                    onError();
                }
            }
        };
    }

    function initProvider() {
        if (provider === "adinplay") { initAdinPlay(); }
        else if (provider === "gamemonetize") { initGameMonetize(); }
        else {
            // 'none' — pure no-op adapter; callback fires immediately. (In practice
            // unreachable via showInterstitial(), which early-returns when
            // canShowInterstitial() is false for provider 'none'.)
            sdkReady = false;
            adapter = { showInterstitial: function (onComplete) { onComplete(); } };
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
        if (!canShowInterstitial()) { onClose(); return; }
        markInterstitialShown();
        track("ad_shown", { type: "interstitial", placement: placement });

        // Single settle authority: fires exactly once. The hard timeout is the
        // fail-open guarantee — if the SDK never calls back, gameplay proceeds.
        var settled = false;
        var timer = setTimeout(function () { settle("timeout"); }, AD_TIMEOUT_MS);
        function settle(status) {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            if (status === "complete") {
                track("ad_complete", { type: "interstitial", placement: placement });
            } else {
                // "error" (SDK threw) or "timeout" (SDK never returned).
                track("ad_error", { type: "interstitial", placement: placement, reason: status });
            }
            try { onClose(); } catch (e) { /* gameplay must proceed */ }
        }

        try {
            adapter.showInterstitial(
                function () { settle("complete"); },
                function () { settle("error"); }
            );
        } catch (e) {
            settle("error");
        }
    }

    // ---- Rewarded (DEFERRED — stubbed until progression engine lands) ----------
    // The forward-compatible surface exists so callers can be written against the
    // final API, but it reports unavailable and fails open. Do NOT render the
    // "Watch to 2× XP" button: it requires server/progression.js +
    // auth.addProgression + the claimXpMultiplier handler, which are not in main.
    function isRewardedAvailable() { return false; }
    function showRewarded(args) {
        args = args || {};
        // No reward path wired yet — treat as a skip so any caller fails open.
        if (typeof args.onSkip === "function") { args.onSkip(); }
    }

    window.ads = {
        init: init,
        onMatchEnded: onMatchEnded,
        canShowInterstitial: canShowInterstitial,
        showInterstitial: showInterstitial,
        shouldShow: shouldShow,
        isRewardedAvailable: isRewardedAvailable,
        showRewarded: showRewarded,
        // Exposed for headless tests / debugging.
        _config: function () { return { provider: provider, sdkReady: sdkReady }; }
    };

    // Auto-init from server-injected config. window.__ADS__ is set by the
    // ADS_CONFIG injection in play.html; absent => defaults to provider 'none'.
    init(window.__ADS__ || { provider: "none" });
})();
