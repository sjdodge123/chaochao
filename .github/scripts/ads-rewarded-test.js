'use strict';

// Headless rewarded-video ("Watch to 2× match XP") test. Two parts:
//
//   PART A — client ad layer (client/scripts/ads.js) in a fake-window sandbox:
//     - isRewardedAvailable() is false for provider 'none' and before the SDK is ready,
//       true once a real network's SDK reports ready ("not-available" coverage).
//     - showRewarded() grants onReward ONLY on a confirmed full watch (an ad started AND
//       completed); a no-fill (complete with no start) is a skip, not a reward; an SDK
//       throw / request timeout is an error. The right GA events fire (type:'rewarded').
//
//   PART B — server claim path (the REAL engine + messenger.claimXpMultiplier handler),
//     mirroring progression-test.js's "boot the real modules" approach:
//     - The per-user match-XP stash recomputed at startGameover EQUALS the engine's own
//       award (the duplicated breakdown in messenger can't silently drift).
//     - A signed-in claim credits exactly the bonus (2× total = +1× original) via
//       auth.addProgression and acks with xpBonus.
//     - Single-claim, wrong-matchId, expired-TTL, and anonymous claims are all rejected.
//
// No network, no browser, no Supabase writes (the local default).

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const repoRoot = path.join(__dirname, '..', '..');

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('  ok: ' + msg); }
    else { failures++; console.log('::error::FAIL: ' + msg); }
}

// ---------------------------------------------------------------------------
// PART A — ads.js in a sandbox
// ---------------------------------------------------------------------------

// Load client/scripts/ads.js into a fresh fake-window context. Returns handles to drive it:
// the public window.ads, the recorded GA events, a way to fire provider SDK events, and a
// fireTimers() that runs pending setTimeout callbacks (so the hard timeout is deterministic).
function loadAds(adsConfig) {
    const tracked = [];
    const timers = [];
    let timerSeq = 1;
    const lsStore = {};
    const fakeWin = {
        __ADS__: adsConfig,
        localStorage: {
            getItem: function (k) { return (k in lsStore) ? lsStore[k] : null; },
            setItem: function (k, v) { lsStore[k] = String(v); }
        },
        trackEvent: function (name, params) { tracked.push({ name: name, params: params || {} }); },
        // no isEmbedded -> treated as not embedded
        sdk: null
    };
    const createdScripts = [];
    const byId = {};   // appended elements indexed by id, so getElementById (the idempotency guard) works
    function register(el) { if (el && el.id) { byId[el.id] = el; } }
    const fakeDoc = {
        createElement: function () { const el = { setAttribute: function () {}, src: '', async: false, id: '', onload: null, onerror: null, style: {} }; createdScripts.push(el); return el; },
        getElementById: function (id) { return byId[id] || null; },
        head: { appendChild: function (el) { register(el); } },
        documentElement: { appendChild: function (el) { register(el); } },
        body: null
    };
    let clock = 1000;
    const ctx = {
        window: fakeWin,
        document: fakeDoc,
        console: console,
        encodeURIComponent: encodeURIComponent,
        setTimeout: function (fn, ms) { const id = timerSeq++; timers.push({ id: id, fn: fn }); return id; },
        clearTimeout: function (id) { for (let i = 0; i < timers.length; i++) { if (timers[i].id === id) { timers.splice(i, 1); break; } } },
        Date: { now: function () { return clock; } }
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(repoRoot, 'client', 'scripts', 'ads.js'), 'utf8'), ctx);
    return {
        ads: fakeWin.ads,
        win: fakeWin,
        tracked: tracked,
        // GameMonetize routes everything through window.SDK_OPTIONS.onEvent.
        fireSdk: function (name) { fakeWin.SDK_OPTIONS.onEvent({ name: name }); },
        // AdinPlay marks the SDK ready via the injected script's onload — fire it.
        fireScriptLoads: function () { createdScripts.forEach(function (s) { if (typeof s.onload === "function") { s.onload(); } }); },
        fireTimers: function () { const due = timers.splice(0, timers.length); due.forEach(function (t) { t.fn(); }); },
        setNow: function (v) { clock = v; },
        hasEvent: function (name, type) { return tracked.some(function (e) { return e.name === name && (!type || e.params.type === type); }); },
        // Lazy-load introspection: how many <script id="..."> with a given id have been injected.
        scriptCount: function (id) { return createdScripts.filter(function (s) { return s.id === id; }).length; },
        // The most-recently-created element with a given id (to assert its type/src).
        getScript: function (id) { for (let i = createdScripts.length - 1; i >= 0; i--) { if (createdScripts[i].id === id) { return createdScripts[i]; } } return null; },
        // True if an event with the given name + a matching params field was tracked.
        hasEventWith: function (name, key, val) { return tracked.some(function (e) { return e.name === name && e.params[key] === val; }); },
        // Read the frequency-cap localStorage directly (to assert cadence isn't burned).
        ls: function (k) { return (k in lsStore) ? lsStore[k] : null; }
    };
}

function testAdsNoneProvider() {
    console.log('ads.js — provider "none":');
    const h = loadAds({ provider: 'none' });
    check(h.ads.isRewardedAvailable() === false, 'isRewardedAvailable() is false for provider none (button never renders)');
    let rewarded = false, skipped = false, errored = false;
    h.ads.showRewarded({ placement: 'xp_2x', onReward: function () { rewarded = true; }, onSkip: function () { skipped = true; }, onError: function () { errored = true; } });
    check(skipped && !rewarded && !errored, 'showRewarded() fails open as a SKIP (no reward, no error) when no network is wired');
    check(!h.hasEvent('ad_shown'), 'no ad_shown emitted for provider none');
}

function testAdsGameMonetizeRewarded() {
    console.log('ads.js — GameMonetize rewarded flow:');
    const h = loadAds({ provider: 'gamemonetize', publisherId: 'test-game-id' });
    check(h.ads.isRewardedAvailable() === false, 'not available before SDK_READY');
    h.fireSdk('SDK_READY');
    check(h.ads.isRewardedAvailable() === true, 'available after SDK_READY');
    h.win.sdk = { showBanner: function () {} }; // SDK object the adapter calls

    // Confirmed full watch: PAUSE (impression) then START (done) -> reward granted.
    let rewarded = false, skipped = false, errored = false;
    h.ads.showRewarded({ placement: 'xp_2x', onReward: function () { rewarded = true; }, onSkip: function () { skipped = true; }, onError: function () { errored = true; } });
    h.fireSdk('SDK_GAME_PAUSE');
    h.fireSdk('SDK_GAME_START');
    check(rewarded && !skipped && !errored, 'PAUSE->START grants onReward exactly once');
    check(h.hasEvent('ad_shown', 'rewarded'), 'ad_shown {type:rewarded} fired on impression');
    check(h.hasEvent('ad_complete', 'rewarded'), 'ad_complete {type:rewarded} fired on completion');

    // No-fill: START with NO preceding PAUSE -> NOT watched -> skip, never reward.
    const h2 = loadAds({ provider: 'gamemonetize', publisherId: 'test-game-id' });
    h2.fireSdk('SDK_READY');
    h2.win.sdk = { showBanner: function () {} };
    let r2 = false, s2 = false;
    h2.ads.showRewarded({ placement: 'xp_2x', onReward: function () { r2 = true; }, onSkip: function () { s2 = true; } });
    h2.fireSdk('SDK_GAME_START'); // no PAUSE first
    check(!r2 && s2, 'no-fill (START without PAUSE) is a SKIP, never a reward');
    check(!h2.hasEvent('ad_complete'), 'no ad_complete on a no-fill');
    check(h2.hasEvent('ad_skipped', 'rewarded'), 'ad_skipped {type:rewarded} fired on no-fill');

    // SDK throw -> error, no reward.
    const h3 = loadAds({ provider: 'gamemonetize', publisherId: 'test-game-id' });
    h3.fireSdk('SDK_READY');
    h3.win.sdk = { showBanner: function () { throw new Error('boom'); } };
    let r3 = false, e3 = false;
    h3.ads.showRewarded({ placement: 'xp_2x', onReward: function () { r3 = true; }, onError: function () { e3 = true; } });
    check(!r3 && e3, 'an SDK throw is an ERROR, never a reward');
    check(h3.hasEvent('ad_error', 'rewarded'), 'ad_error {type:rewarded} fired on SDK throw');

    // Request timeout (no ad ever starts) -> error via the hard timeout.
    const h4 = loadAds({ provider: 'gamemonetize', publisherId: 'test-game-id' });
    h4.fireSdk('SDK_READY');
    h4.win.sdk = { showBanner: function () {} }; // never fires PAUSE/START
    let r4 = false, e4 = false;
    h4.ads.showRewarded({ placement: 'xp_2x', onReward: function () { r4 = true; }, onError: function () { e4 = true; } });
    h4.fireTimers(); // fire the 8s watchdog
    check(!r4 && e4, 'no ad starting before the timeout is an ERROR');
    check(h4.tracked.some(function (ev) { return ev.name === 'ad_error' && ev.params.reason === 'timeout'; }), 'ad_error reason=timeout on request timeout');
    // A SLOW provider that starts an ad AFTER the timeout must not sneak through: the timeout
    // tore down the provider request (cleared the pending PAUSE/START), so a late PAUSE/START
    // grants no reward and fires no late ad_shown.
    var shownBefore = h4.tracked.filter(function (ev) { return ev.name === 'ad_shown'; }).length;
    h4.fireSdk('SDK_GAME_PAUSE');
    h4.fireSdk('SDK_GAME_START');
    check(!r4, 'a late ad after timeout grants NO reward (provider request was torn down)');
    check(h4.tracked.filter(function (ev) { return ev.name === 'ad_shown'; }).length === shownBefore, 'a late ad after timeout fires no ad_shown');
}

function testAdsAdinPlayEarlyCloseIsSkip() {
    console.log('ads.js — AdinPlay rewarded: an early close (AIP_REMOVE before COMPLETE) is a SKIP:');
    // Mock the AdinPlay SDK: a cmd.player queue that runs callbacks immediately, and an aipPlayer
    // constructor that captures the AIP_* config so we can drive the ad lifecycle by hand.
    function setup() {
        const h = loadAds({ provider: 'adinplay', publisherId: 'pub' });
        let cfg = null;
        h.win.aiptag = { cmd: { player: { push: function (fn) { fn(); } } } };
        h.win.aipPlayer = function (c) { cfg = c; this.startPreRoll = function () {}; this.destroy = function () {}; };
        h.fireScriptLoads();        // AdinPlay sets sdkReady on the script onload
        return { h: h, cfg: function () { return cfg; } };
    }

    // Early close: AIP_START (impression) then AIP_REMOVE WITHOUT AIP_COMPLETE -> skip, no reward.
    var a = setup();
    check(a.h.ads.isRewardedAvailable() === true, 'rewarded available once the AdinPlay script loads');
    var rewardedEarly = false, skippedEarly = false;
    a.h.ads.showRewarded({ placement: 'xp_2x', onReward: function () { rewardedEarly = true; }, onSkip: function () { skippedEarly = true; } });
    a.cfg().AIP_START();
    a.cfg().AIP_REMOVE();   // closed before completing
    check(!rewardedEarly && skippedEarly, 'AIP_REMOVE before AIP_COMPLETE grants NO reward (it is a skip)');
    check(a.h.tracked.some(function (e) { return e.name === 'ad_skipped' && e.params.type === 'rewarded'; }), 'ad_skipped emitted on the early close');

    // Full watch: AIP_START then AIP_COMPLETE -> reward. (A trailing AIP_REMOVE after complete is a no-op.)
    var b = setup();
    var rewardedFull = false;
    b.h.ads.showRewarded({ placement: 'xp_2x', onReward: function () { rewardedFull = true; }, onSkip: function () {} });
    b.cfg().AIP_START();
    b.cfg().AIP_COMPLETE();
    b.cfg().AIP_REMOVE();   // close after a real completion — must not double-fire
    check(rewardedFull, 'AIP_COMPLETE grants the reward (full watch)');
    check(b.h.tracked.filter(function (e) { return e.name === 'ad_complete' && e.params.type === 'rewarded'; }).length === 1, 'exactly one ad_complete — the post-complete AIP_REMOVE is a no-op');
}

// The interstitial and rewarded paths share GameMonetize's single showBanner()/PAUSE/START
// slot. dismissInterstitial() runs at race start; it must tear down an in-flight INTERSTITIAL
// but must NOT drop an in-flight REWARDED ad the player opted into (that would clear its
// completion and silently deny the credit).
function testDismissDoesNotKillRewarded() {
    console.log('ads.js — dismissInterstitial() leaves an in-flight rewarded ad alone, but tears down an interstitial:');

    // Rewarded in flight + race starts (dismissInterstitial) -> reward STILL granted on completion.
    var h = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h.fireSdk('SDK_READY');
    h.win.sdk = { showBanner: function () {} };
    var rewarded = false;
    h.ads.showRewarded({ placement: 'xp_2x', onReward: function () { rewarded = true; }, onSkip: function () {} });
    h.fireSdk('SDK_GAME_PAUSE');     // rewarded ad actually started (adInFlight = 'rewarded')
    h.ads.dismissInterstitial();      // next race starting — must be a no-op for a rewarded ad
    h.fireSdk('SDK_GAME_START');     // ad finishes
    check(rewarded, 'rewarded ad survives a race-start dismiss and still grants the reward');

    // Interstitial in flight + race starts -> torn down (onClose fires).
    var h2 = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h2.fireSdk('SDK_READY');
    h2.win.sdk = { showBanner: function () {} };
    h2.setNow(1000000);               // clear the 90s cooldown (last_ts = 0)
    h2.ads.onMatchEnded();            // seed the cadence so canShowInterstitial() is true
    var closed = false;
    h2.ads.showInterstitial({ placement: 'between_matches', onClose: function () { closed = true; } });
    h2.fireSdk('SDK_GAME_PAUSE');     // interstitial started (adInFlight = 'interstitial')
    h2.ads.dismissInterstitial();     // race starting — tears it down
    check(closed, 'an in-flight interstitial IS torn down at race start (onClose fires)');
}

// Acquisition-UX fix: the GameMonetize loader must NOT be injected at page init (its SDK can
// auto-show a preroll the instant it initializes — that splashed an ad on the very first lobby,
// before the player had played). It's lazy-loaded on the first real ad demand instead, the first
// such demand fails open, and an active-gameplay guard refuses to cover a live round.
function testLazyLoadAndGameplayGuard() {
    console.log('ads.js — GameMonetize loader is lazy-loaded (no ad on first lobby) + active-gameplay guard:');

    // (a) On init, the loader <script id="gamemonetize-sdk"> is NOT injected.
    const h = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    check(h.scriptCount('gamemonetize-sdk') === 0, '(a) on init the gamemonetize-sdk script is NOT injected (lazy — no first-lobby preroll possible)');
    check(h.ads._config().sdkReady === false, '(a) sdkReady is false on init (SDK not loaded yet)');

    // (b) The loader IS injected on the first real ad demand (a match-end interstitial check).
    const firstCheck = h.ads.canShowInterstitial();
    check(firstCheck === false, '(b) first canShowInterstitial() is false (SDK not ready yet) — fails open, no ad');
    check(h.scriptCount('gamemonetize-sdk') === 1, '(b) the gamemonetize-sdk script IS injected on the first ad demand');
    // Idempotent: repeated demands never inject a second copy.
    h.ads.canShowInterstitial();
    h.ads.isRewardedAvailable();
    check(h.scriptCount('gamemonetize-sdk') === 1, '(b) repeated demands never inject a second loader (idempotent by id)');

    // (c) An ad requested before the SDK is ready fails open (onClose), and the frequency cadence
    //     is NOT burned — the next match can still try once the SDK has loaded.
    const h2 = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h2.setNow(1000000);          // clear the 90s cooldown
    h2.ads.onMatchEnded();       // a match ended -> cadence is now eligible
    const countBefore = h2.ls('ads_match_count_since_interstitial');
    let closed = false;
    h2.ads.showInterstitial({ placement: 'between_matches', onClose: function () { closed = true; } });
    check(closed, '(c) an interstitial requested before SDK-ready fails open (onClose fires, gameplay never blocks)');
    check(!h2.hasEvent('ad_shown'), '(c) no ad_shown for a pre-ready request (no impression)');
    check(h2.ls('ads_match_count_since_interstitial') === countBefore, '(c) the match-cadence counter is NOT burned by a pre-ready no-fill');
    // Rewarded mirrors this: not available before ready -> a clean skip.
    let rSkipped = false, rRewarded = false;
    h2.ads.showRewarded({ placement: 'xp_2x', onReward: function () { rRewarded = true; }, onSkip: function () { rSkipped = true; } });
    check(rSkipped && !rRewarded, '(c) a rewarded ad requested before SDK-ready is a clean SKIP (no reward, no crash)');

    // (d) The active-gameplay guard blocks a show during gated/racing/collapsing even when the
    //     SDK is ready and the cadence is eligible — an ad can NEVER cover a live round.
    const stateMap = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'config.json'), 'utf8')).stateMap;
    [['gated', stateMap.gated], ['racing', stateMap.racing], ['collapsing', stateMap.collapsing]].forEach(function (pair) {
        const h3 = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
        h3.fireSdk('SDK_READY');
        let bannerCalls = 0;
        h3.win.sdk = { showBanner: function () { bannerCalls++; } };
        h3.win.config = { stateMap: stateMap };
        h3.win.currentState = pair[1];        // the client is mid-round
        h3.setNow(1000000);
        h3.ads.onMatchEnded();                 // cadence eligible
        check(h3.ads.canShowInterstitial() === true, '(d/' + pair[0] + ') sanity: cadence + SDK would otherwise allow an interstitial');
        let iClosed = false;
        h3.ads.showInterstitial({ placement: 'between_matches', onClose: function () { iClosed = true; } });
        check(iClosed && bannerCalls === 0, '(d/' + pair[0] + ') interstitial is REFUSED during ' + pair[0] + ' (no showBanner), onClose still fires');
        check(h3.hasEvent('ad_blocked', 'interstitial'), '(d/' + pair[0] + ') ad_blocked {type:interstitial} logged for the gameplay-state refusal');
        // Rewarded is refused too -> a clean skip, no banner.
        let rSkip = false;
        h3.ads.showRewarded({ placement: 'xp_2x', onReward: function () {}, onSkip: function () { rSkip = true; } });
        check(rSkip && bannerCalls === 0, '(d/' + pair[0] + ') rewarded ad is REFUSED during ' + pair[0] + ' (skip, no showBanner)');
    });

    // And the valid surfaces (lobby / gameOver) are NOT blocked by the guard.
    const h4 = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h4.fireSdk('SDK_READY');
    let banner4 = 0;
    h4.win.sdk = { showBanner: function () { banner4++; } };
    h4.win.config = { stateMap: stateMap };
    h4.win.currentState = stateMap.lobby;     // the normal interstitial surface
    h4.setNow(1000000);
    h4.ads.onMatchEnded();
    h4.ads.showInterstitial({ placement: 'between_matches', onClose: function () {} });
    check(banner4 === 1, '(d) an interstitial at the lobby edge is NOT blocked (showBanner called)');

    // (e) preloadSdk() loads the SDK EARLY (gameOver/results edge) to widen the lead time before
    //     the race, but is a no-op during active gameplay so a slow autostart can't be kicked
    //     into a live round (Codex P1: delayed init covering gameplay).
    const hp = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    hp.win.config = { stateMap: stateMap };
    check(hp.scriptCount('gamemonetize-sdk') === 0, '(e) no executable loader before preloadSdk()');
    hp.win.currentState = stateMap.racing;
    hp.ads.preloadSdk();                       // mid-round -> refused
    check(hp.scriptCount('gamemonetize-sdk') === 0, '(e) preloadSdk() is a no-op during active gameplay (no load kicked into a live round)');
    hp.win.currentState = stateMap.gameOver;   // results screen -> valid surface
    hp.ads.preloadSdk();
    check(hp.scriptCount('gamemonetize-sdk') === 1, '(e) preloadSdk() at the gameOver edge injects the executable loader early (more lead time before the race)');
}

// Codex P1: a GameMonetize preroll the SDK autostarts on init bypasses our showBanner() flow,
// so it must still be ADOPTED into the interstitial bookkeeping — tracked, telemetered, and
// torn down by the startGated/startRace dismiss safety net — instead of being invisible. And a
// request we deliberately tore down must NOT have its late stray PAUSE misread as a fresh
// autostart (one-shot suppression).
function testProviderAutostartAdoption() {
    console.log('ads.js — an SDK-autostarted (unsolicited) preroll is adopted + dismissable:');

    // Unsolicited PAUSE with no prior showInterstitial() -> adopted as an in-flight interstitial.
    const h = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h.fireSdk('SDK_READY');
    h.win.sdk = { showBanner: function () {} };
    check(h.ads._config().adInFlight == null, 'no ad in flight before the autostart');
    h.setNow(50000);               // a real clock so markInterstitialShown stamps a cooldown ts
    h.fireSdk('SDK_GAME_PAUSE');   // the SDK started a preroll we never requested
    check(h.ads._config().adInFlight === 'interstitial', 'an unsolicited autostart is adopted as an in-flight interstitial (so the dismiss net covers it)');
    check(h.hasEventWith('ad_shown', 'placement', 'provider_auto'), 'ad_shown {placement:provider_auto} emitted for the autostart (not invisible)');
    // P1b: an adopted preroll IS an impression, so it burns the frequency cap like a solicited one.
    check(h.ls('ads_last_interstitial_ts') === '50000', 'adopted autostart stamps the cooldown ts (frequency cap applied)');
    check(h.ls('ads_match_count_since_interstitial') === '0', 'adopted autostart resets the match cadence counter (no back-to-back ad next match)');
    // The race-start dismiss safety net can now reclaim it.
    h.ads.dismissInterstitial();
    check(h.ads._config().adInFlight == null, 'dismissInterstitial() tears down the adopted autostart at the gate');
    // P2: a deliberate teardown (cancelled) records NO completion.
    check(!h.hasEventWith('ad_complete', 'placement', 'provider_auto'), 'a dismissed autostart records no ad_complete (cancelled, not completed)');
    // A trailing SDK_GAME_START for the dismissed ad is a harmless no-op (already settled).
    h.fireSdk('SDK_GAME_START');
    check(h.ads._config().adInFlight == null, 'a late SDK_GAME_START after dismiss is a no-op');

    // An autostart that completes on its own (PAUSE -> START, never dismissed) resolves cleanly.
    const h2 = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h2.fireSdk('SDK_READY');
    h2.win.sdk = { showBanner: function () {} };
    h2.fireSdk('SDK_GAME_PAUSE');
    check(h2.ads._config().adInFlight === 'interstitial', 'autostart adopted');
    h2.fireSdk('SDK_GAME_START');
    check(h2.ads._config().adInFlight == null, 'the adopted autostart resolves on its own SDK_GAME_START');
    // P2: a normally-completed autostart records ad_complete (symmetric funnel, not "abandoned").
    check(h2.hasEventWith('ad_complete', 'placement', 'provider_auto'), 'a completed autostart records ad_complete {placement:provider_auto}');

    // Autostart that races into a LIVE round is flagged (ad_blocked) but still tracked so the
    // gate dismiss can attempt teardown — never silent.
    const h3 = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h3.fireSdk('SDK_READY');
    h3.win.sdk = { showBanner: function () {} };
    const stateMap = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'config.json'), 'utf8')).stateMap;
    h3.win.config = { stateMap: stateMap };
    h3.win.currentState = stateMap.racing;
    h3.fireSdk('SDK_GAME_PAUSE');
    check(h3.hasEventWith('ad_blocked', 'reason', 'provider_auto_in_gameplay'), 'an autostart over a live round is flagged ad_blocked {reason:provider_auto_in_gameplay}');
    check(h3.ads._config().adInFlight === 'interstitial', 'still tracked (so the gate dismiss can attempt teardown)');

    // Regression: a SOLICITED interstitial PAUSE is NOT re-adopted as provider_auto.
    const h4 = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h4.fireSdk('SDK_READY');
    h4.win.sdk = { showBanner: function () {} };
    h4.setNow(1000000);
    h4.ads.onMatchEnded();
    h4.ads.showInterstitial({ placement: 'between_matches', onClose: function () {} });
    h4.fireSdk('SDK_GAME_PAUSE');   // solicited -> fires our onStart, not the adopt path
    check(!h4.hasEventWith('ad_shown', 'placement', 'provider_auto'), 'a solicited interstitial PAUSE is NOT mislabeled provider_auto');
    check(h4.hasEventWith('ad_shown', 'placement', 'between_matches'), 'the solicited interstitial impression is recorded normally');

    // One-shot suppression: after a torn-down request, a late stray PAUSE is NOT adopted (no
    // duplicate impression). Mirrors the rewarded-timeout teardown.
    const h5 = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h5.fireSdk('SDK_READY');
    h5.win.sdk = { showBanner: function () {} };
    h5.ads.showRewarded({ placement: 'xp_2x', onReward: function () {}, onSkip: function () {} });
    h5.fireTimers();                 // request times out -> dismiss() sets the suppress flag
    const shownBefore = h5.tracked.filter(function (e) { return e.name === 'ad_shown'; }).length;
    h5.fireSdk('SDK_GAME_PAUSE');    // late stray PAUSE for the torn-down request
    check(h5.ads._config().adInFlight == null, 'a stray PAUSE after a teardown is NOT adopted (one-shot suppression)');
    check(h5.tracked.filter(function (e) { return e.name === 'ad_shown'; }).length === shownBefore, 'no duplicate ad_shown for the abandoned request');
}

// Review finding: a SOLICITED interstitial whose request times out must be TORN DOWN (mirroring
// the rewarded path), so a slow fill that arrives after the 8s watchdog can't re-fire a phantom
// impression / burn the cap after onClose already ran, nor cover the next round untracked.
function testInterstitialTimeoutTeardown() {
    console.log('ads.js — a timed-out solicited interstitial is torn down (no phantom late impression):');
    const h = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    h.fireSdk('SDK_READY');
    h.win.sdk = { showBanner: function () {} };   // never fires PAUSE/START -> the request times out
    h.setNow(1000000);                             // clear the 90s cooldown
    h.ads.onMatchEnded();                          // cadence eligible
    let closed = false;
    h.ads.showInterstitial({ placement: 'between_matches', onClose: function () { closed = true; } });
    h.fireTimers();                                // 8s watchdog -> settle('timeout') -> adapter.dismiss()
    check(closed, 'onClose fires on the interstitial timeout (fail-open, gameplay proceeds)');
    check(h.ads._config().adInFlight == null, 'nothing in flight after the timeout');
    check(h.ls('ads_last_interstitial_ts') == null, 'a timed-out request does NOT burn the cooldown (no impression occurred)');
    const shownBefore = h.tracked.filter(function (e) { return e.name === 'ad_shown'; }).length;
    // A slow provider that serves the ad AFTER the timeout must not sneak through.
    h.fireSdk('SDK_GAME_PAUSE');
    h.fireSdk('SDK_GAME_START');
    check(h.tracked.filter(function (e) { return e.name === 'ad_shown'; }).length === shownBefore, 'a late fill after the interstitial timeout fires NO ad_shown (no phantom impression after onClose)');
    check(!h.hasEventWith('ad_shown', 'placement', 'provider_auto'), 'the late PAUSE is NOT mis-adopted as a provider_auto autostart (one-shot suppression)');
    check(h.ads._config().adInFlight == null, 'the late PAUSE leaves nothing in flight (cannot cover the next round)');
}

// Codex P2: with pure lazy-loading the SDK would be invisible to GameMonetize's activation
// verifier (which visits play.html without playing a match). An INERT, source/DOM-detectable
// marker is injected at init: a <script type="text/plain"> carrying the sdk.js URL — never
// fetched/executed (so no autostart), while the executable loader stays lazy under a different id.
function testVerificationMarker() {
    console.log('ads.js — an inert SDK marker is detectable at init (no preroll), executable loader stays lazy:');
    const h = loadAds({ provider: 'gamemonetize', publisherId: 'g' });
    check(h.scriptCount('gamemonetize-sdk-marker') === 1, 'an inert gamemonetize-sdk-marker is injected at init (detectable for verification)');
    const marker = h.getScript('gamemonetize-sdk-marker');
    check(marker && marker.type === 'text/plain', 'the marker is type="text/plain" — inert: never fetched or executed (no autostart possible)');
    check(marker && marker.src === 'https://api.gamemonetize.com/sdk.js', 'the marker carries the canonical sdk.js URL (source-detectable)');
    check(h.scriptCount('gamemonetize-sdk') === 0, 'the EXECUTABLE loader is still NOT injected at init (stays lazy until a match ends)');
    check(!!h.win.SDK_OPTIONS && h.win.SDK_OPTIONS.gameId === 'g', 'window.SDK_OPTIONS is set at init (gameId present) — detectable by an executing verifier too');
}

// ---------------------------------------------------------------------------
// PART B — server claim path (real engine + messenger handler)
// ---------------------------------------------------------------------------
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const hostess = require(path.join(repoRoot, 'server', 'hostess.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const progression = require(path.join(repoRoot, 'server', 'progression.js'));
const auth = require(path.join(repoRoot, 'server', 'auth.js'));
const c = utils.loadConfig();

const ioEvents = [];
messenger.build({ to: function () { return { emit: function (header, payload) { ioEvents.push({ header: header, payload: payload }); } }; }, sockets: { emit: function () {} } });

// Recording socket.io stand-in (mirrors progression-test.js).
function makeRecordingSocket(id) {
    const handlers = {};
    const emits = [];
    return {
        id: id, userId: null, deviceId: null, handlers: handlers, emits: emits,
        on: function (e, fn) { handlers[e] = fn; },
        emit: function (h, p) { emits.push({ header: h, payload: p }); },
        join: function () {}, leave: function () {},
        broadcast: { to: function () { return { emit: function () {} }; } },
        fire: function (e, p) { if (handlers[e]) { handlers[e](p); } },
        lastEmit: function (h) { for (let i = emits.length - 1; i >= 0; i--) { if (emits[i].header === h) { return emits[i].payload; } } return null; }
    };
}

// Stand up a real hostess room with two signed-in humans (via the enterGame matchmaking
// path so the room is hostess-registered and roomMailList is wired), set notches, force
// the winner, and drive gameOver — which fires startGameover and so the rewarded stash.
let matchSeq = 0;
function setupMatch(prefix, opts) {
    opts = opts || {};
    matchSeq++;
    const s1 = makeRecordingSocket(prefix + '-s1');
    const s2 = makeRecordingSocket(prefix + '-s2');
    s1.userId = prefix + '-u1';
    s2.userId = prefix + '-u2';
    messenger.addMailBox(s1.id, s1, { userId: s1.userId, deviceId: null });
    messenger.addMailBox(s2.id, s2, { userId: s2.userId, deviceId: null });
    s1.fire('enterGame', -1);
    s2.fire('enterGame', -1);

    // Both should have matchmade into the same room.
    let room = null;
    for (const sig of Object.keys(hostess.getRooms())) {
        const rm = hostess.getRoomBySig(sig);
        if (rm && rm.playerList[s1.id] && rm.playerList[s2.id]) { room = rm; break; }
    }
    if (!room) { return null; }
    const p1 = room.playerList[s1.id];
    const p2 = room.playerList[s2.id];
    p1.isAI = false; p1.verifiedUserId = s1.userId; p1.notches = 5; p1.racedCurrentMap = true;
    // opts.p2Spectator: p2 is a signed-in late-joiner who never raced this match — server must
    // NOT credit them, so they must NOT be told they're eligible for the rewarded claim.
    p2.isAI = false; p2.verifiedUserId = s2.userId; p2.notches = 2; p2.racedCurrentMap = !opts.p2Spectator;
    p1.progression = progression.defaultProgression(); p1.progressionLoaded = true;
    p2.progression = progression.defaultProgression(); p2.progressionLoaded = true;
    room.game.firstPlaceSig = s1.id;
    room.game.secondPlaceSig = s2.id;
    // Drain any toasts queued by joins so our post-gameOver drain reads only this match.
    messenger._drainToastsInMemoryForTest(s1.userId);
    messenger._drainToastsInMemoryForTest(s2.userId);
    room.game.gameOver(s1.id); // -> awardProgression + startGameover (stamps + stashes)
    return { room: room, s1: s1, s2: s2 };
}

function teardown(m) {
    hostess.kickFromRoom(m.s1.id);
    hostess.kickFromRoom(m.s2.id);
    messenger.removeMailBox(m.s1.id);
    messenger.removeMailBox(m.s2.id);
}

// The xp amount the engine actually awarded a user (from the writes-off in-memory toast queue).
function engineXp(userId) {
    const toasts = messenger._drainToastsInMemoryForTest(userId) || [];
    const xp = toasts.filter(function (e) { return e.type === 'xp'; });
    return xp.length ? xp[0].amount : null;
}

async function testStashMatchesEngineAward() {
    console.log('Server — match-XP stash equals the engine award (no drift):');
    const m = setupMatch('rw-drift');
    if (!m) { check(false, 'two signed-in players matchmade into one room'); return; }
    const rm = m.room.rewardedMatch;
    check(!!rm && !!rm.matchId, 'startGameover stashed a rewardedMatch with a matchId');
    const packet = ioEvents.filter(function (e) { return e.header === 'startGameover'; }).pop();
    check(packet && packet.payload.matchId == null, 'the broadcast startGameover packet does NOT carry matchId (eligibility is targeted, not broadcast)');
    // Eligibility is delivered targeted, only to the credited racers, and carries the REMAINING
    // claim lifetime as a duration (ttlMs) so the client deadline stays on a single clock.
    var elig1 = m.s1.lastEmit('rewardedEligible');
    check(elig1 && elig1.matchId === rm.matchId, 'winner received a targeted rewardedEligible with this matchId');
    check(elig1 && typeof elig1.ttlMs === 'number' && elig1.ttlMs > 0 && elig1.ttlMs <= 180000, 'rewardedEligible carries a remaining-lifetime duration (ttlMs), not a server timestamp');
    check(m.s2.lastEmit('rewardedEligible') && m.s2.lastEmit('rewardedEligible').matchId === rm.matchId, 'runner-up received a targeted rewardedEligible with this matchId');
    // Compare per-user stash to the engine's own awarded XP.
    const eng1 = engineXp(m.s1.userId);
    const eng2 = engineXp(m.s2.userId);
    check(rm.claims[m.s1.userId] && rm.claims[m.s1.userId].xpDelta === eng1, 'winner stash xpDelta == engine award (' + (rm.claims[m.s1.userId] || {}).xpDelta + ' === ' + eng1 + ')');
    check(rm.claims[m.s2.userId] && rm.claims[m.s2.userId].xpDelta === eng2, 'runner-up stash xpDelta == engine award (' + (rm.claims[m.s2.userId] || {}).xpDelta + ' === ' + eng2 + ')');
    // Sanity: matches the documented breakdown for a 5-notch win / 2-notch runner-up.
    check(eng1 === c.xpParticipate + c.xpPerNotch * 5 + c.xpWinBonus, 'winner award = participation + 5 notches + win bonus');
    check(eng2 === c.xpParticipate + c.xpPerNotch * 2 + c.xpRunnerUpBonus, 'runner-up award = participation + 2 notches + runner-up bonus');
    teardown(m);
}

// A rewarded ad can finish during (or after) the NEXT match. The prior match's claim record
// must survive a later match's stamp (kept per-matchId, pruned only past the TTL) so the
// watched ad still pays out.
async function testPriorMatchStillClaimable() {
    console.log('Server — a prior match stays claimable after the next match ends (per-matchId records):');
    const m = setupMatch('rw-prior');
    if (!m) { check(false, 'room set up'); return; }
    const matchA = m.room.rewardedMatch.matchId;
    // Simulate a SECOND match ending in the same room (an ad from match A still in flight).
    m.room.playerList[m.s1.id].notches = 3; m.room.playerList[m.s1.id].racedCurrentMap = true;
    m.room.playerList[m.s2.id].notches = 1; m.room.playerList[m.s2.id].racedCurrentMap = true;
    m.room.game.firstPlaceSig = m.s1.id; m.room.game.secondPlaceSig = m.s2.id;
    m.room.game.gameOver(m.s1.id); // stamps match B; A must remain in the map
    const matchB = m.room.rewardedMatch.matchId;
    check(matchA !== matchB, 'the second match got a distinct matchId');
    check(!!(m.room.rewardedMatches[matchA] && m.room.rewardedMatches[matchB]), 'both the prior (A) and current (B) match records are retained within the TTL');
    await withFakeAddProgression(async function (calls) {
        m.s1.fire('claimXpMultiplier', { matchId: matchA, multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls.length === 1, "the PRIOR match's claim still succeeds after the next match ended");
    });
    teardown(m);
}

// A signed-in late-joiner who never raced (spectator) is excluded server-side (no claims entry)
// and must NOT be told they're eligible — so they're never offered an ad the server would reject.
async function testSpectatorNotOfferedEligibility() {
    console.log('Server — a signed-in spectator (never raced) is NOT sent rewardedEligible:');
    const m = setupMatch('rw-spec', { p2Spectator: true });
    if (!m) { check(false, 'room set up'); return; }
    const rm = m.room.rewardedMatch;
    check(!rm.claims[m.s2.userId], 'spectator has no server claim entry (excluded by racedCurrentMap)');
    check(!!m.s1.lastEmit('rewardedEligible'), 'the racer IS told they are eligible');
    check(!m.s2.lastEmit('rewardedEligible'), 'the spectator is NOT told they are eligible (no wasted-ad offer)');
    // And a forged claim from the spectator is rejected (no entry).
    await withFakeAddProgression(async function (calls) {
        m.s2.fire('claimXpMultiplier', { matchId: rm.matchId, multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls.length === 0, "a spectator's forged claim is rejected (no entry to credit)");
    });
    teardown(m);
}

// Patch auth.addProgression so we can assert the credited bonus without Supabase writes.
function withFakeAddProgression(fn) {
    const orig = auth.addProgression;
    const calls = [];
    auth.addProgression = function (userId, opts) {
        calls.push({ userId: userId, opts: opts });
        // Return a plausible normalized-ish row so buildProgressionPayload + the ack work.
        return Promise.resolve({ xp: 9999, level: 7, unlocked_skins: [], medal_counts: {}, wins: 0 });
    };
    return Promise.resolve(fn(calls)).finally(function () { auth.addProgression = orig; });
}

async function testCreditAndSingleClaim() {
    console.log('Server — signed-in claim credits the bonus, then single-claim blocks a repeat:');
    const m = setupMatch('rw-credit');
    if (!m) { check(false, 'room set up'); return; }
    const matchId = m.room.rewardedMatch.matchId;
    const expectedBonus = m.room.rewardedMatch.claims[m.s1.userId].xpDelta; // 2x -> +1x original
    await withFakeAddProgression(async function (calls) {
        m.s1.fire('claimXpMultiplier', { matchId: matchId, multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls.length === 1, 'addProgression called exactly once');
        check(calls[0] && calls[0].userId === m.s1.userId && calls[0].opts.xpDelta === expectedBonus, 'credited xpDelta == original match XP (2x total): ' + (calls[0] && calls[0].opts.xpDelta) + ' === ' + expectedBonus);
        check(calls[0].opts.suppressXpToast === true, 'suppressXpToast set (client shows its own xpBonus toast; level-up/skin toasts are preserved)');
        check(progression.rewardedBonusXp(expectedBonus * 1) >= 0, 'rewardedBonusXp helper present');
        const ack = m.s1.lastEmit('xpBonus');
        check(!!ack && ack.bonus === expectedBonus && ack.matchId === matchId && ack.multiplier === 2, 'xpBonus ack carries bonus + matchId + server multiplier');

        // Single-claim: a second emit for the same match credits nothing more.
        const before = calls.length;
        m.s1.fire('claimXpMultiplier', { matchId: matchId, multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls.length === before, 'a SECOND claim for the same match is rejected (single-claim guard)');
    });
    teardown(m);
}

async function testRejections() {
    console.log('Server — wrong-match / expired / anonymous claims are rejected:');
    const m = setupMatch('rw-reject');
    if (!m) { check(false, 'room set up'); return; }
    const matchId = m.room.rewardedMatch.matchId;
    await withFakeAddProgression(async function (calls) {
        // Wrong matchId.
        m.s1.fire('claimXpMultiplier', { matchId: 'not-a-real-match', multiplier: 2 });
        // Missing matchId.
        m.s1.fire('claimXpMultiplier', { multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls.length === 0, 'a wrong / missing matchId is rejected');

        // Anonymous (no userId on the socket) — even with the correct matchId.
        const savedUid = m.s1.userId; m.s1.userId = null;
        m.s1.fire('claimXpMultiplier', { matchId: matchId, multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls.length === 0, 'an anonymous (no userId) claim is rejected server-side');
        m.s1.userId = savedUid;

        // Expired TTL.
        m.room.rewardedMatch.gameOverTs = Date.now() - (1000 * 1000); // way past the 180s TTL
        m.s1.fire('claimXpMultiplier', { matchId: matchId, multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls.length === 0, 'a claim past the TTL is rejected');
    });
    teardown(m);
}

// P1-b: with writes ENABLED, a failed persist (addProgression resolves null) must NOT be acked
// as success — no xpBonus, and the single-claim flag is reset so the watched ad can be retried.
async function testWriteFailureNotAcked() {
    console.log('Server — a failed persist (writes on) is not acked, claim resets for retry:');
    const m = setupMatch('rw-fail');
    if (!m) { check(false, 'room set up'); return; }
    const matchId = m.room.rewardedMatch.matchId;
    const origWrites = auth.writesEnabled;
    const origAdd = auth.addProgression;
    let calls = 0;
    auth.writesEnabled = true;                 // pretend prod writes are on
    auth.addProgression = function () { calls++; return Promise.resolve(null); }; // simulate DB failure
    try {
        m.s1.emits.length = 0;
        m.s1.fire('claimXpMultiplier', { matchId: matchId, multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls === 1, 'addProgression was attempted');
        check(!m.s1.lastEmit('xpBonus'), 'NO xpBonus ack emitted on a failed write (ad not falsely credited)');
        check(m.room.rewardedMatch.claims[m.s1.userId].claimed === false, 'single-claim flag reset -> the watched ad can be retried');
    } finally {
        auth.writesEnabled = origWrites;
        auth.addProgression = origAdd;
    }
    teardown(m);
}

function testMultiplierConstant() {
    console.log('Server — multiplier constant + bonus helper live in progression.js:');
    check(progression.XP_MULTIPLIER_REWARDED === 2, 'XP_MULTIPLIER_REWARDED === 2');
    check(progression.rewardedBonusXp(150) === 150, 'rewardedBonusXp(150) === 150 (2x total = +1x original)');
    check(progression.rewardedBonusXp(0) === 0 && progression.rewardedBonusXp(-5) === 0, 'rewardedBonusXp clamps non-positive deltas to 0');
}

(async function run() {
    // Part A
    testAdsNoneProvider();
    testAdsGameMonetizeRewarded();
    testAdsAdinPlayEarlyCloseIsSkip();
    testDismissDoesNotKillRewarded();
    testLazyLoadAndGameplayGuard();
    testProviderAutostartAdoption();
    testInterstitialTimeoutTeardown();
    testVerificationMarker();
    // Part B
    testMultiplierConstant();
    await testStashMatchesEngineAward();
    await testPriorMatchStillClaimable();
    await testSpectatorNotOfferedEligibility();
    await testCreditAndSingleClaim();
    await testRejections();
    await testWriteFailureNotAcked();

    if (failures > 0) {
        console.log('\nRewarded-ads test FAILED with ' + failures + ' error(s).');
        process.exit(1);
    }
    console.log('\nRewarded-ads test passed.');
    process.exit(0);
})();
