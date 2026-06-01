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
    const fakeDoc = {
        createElement: function () { return { setAttribute: function () {}, src: '', async: false, id: '', onload: null, onerror: null, style: {} }; },
        getElementById: function () { return null; },
        head: { appendChild: function () {} },
        documentElement: { appendChild: function () {} },
        body: null
    };
    const ctx = {
        window: fakeWin,
        document: fakeDoc,
        console: console,
        encodeURIComponent: encodeURIComponent,
        setTimeout: function (fn, ms) { const id = timerSeq++; timers.push({ id: id, fn: fn }); return id; },
        clearTimeout: function (id) { for (let i = 0; i < timers.length; i++) { if (timers[i].id === id) { timers.splice(i, 1); break; } } },
        Date: { now: function () { return 1000; } }
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(repoRoot, 'client', 'scripts', 'ads.js'), 'utf8'), ctx);
    return {
        ads: fakeWin.ads,
        win: fakeWin,
        tracked: tracked,
        // GameMonetize routes everything through window.SDK_OPTIONS.onEvent.
        fireSdk: function (name) { fakeWin.SDK_OPTIONS.onEvent({ name: name }); },
        fireTimers: function () { const due = timers.splice(0, timers.length); due.forEach(function (t) { t.fn(); }); },
        hasEvent: function (name, type) { return tracked.some(function (e) { return e.name === name && (!type || e.params.type === type); }); }
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
function setupMatch(prefix) {
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
    p2.isAI = false; p2.verifiedUserId = s2.userId; p2.notches = 2; p2.racedCurrentMap = true;
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
    check(packet && packet.payload.matchId === rm.matchId, 'the startGameover packet carries the same matchId (echoed to the client)');
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
        check(calls[0].opts.suppressToasts === true, 'suppressToasts set (client shows its own xpBonus toast, no duplicate lobby toast)');
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
        m.room.rewardedMatch.gameOverTs = Date.now() - (1000 * 1000); // way past the 90s TTL
        m.s1.fire('claimXpMultiplier', { matchId: matchId, multiplier: 2 });
        await Promise.resolve(); await Promise.resolve();
        check(calls.length === 0, 'a claim past the TTL is rejected');
    });
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
    // Part B
    testMultiplierConstant();
    await testStashMatchesEngineAward();
    await testCreditAndSingleClaim();
    await testRejections();

    if (failures > 0) {
        console.log('\nRewarded-ads test FAILED with ' + failures + ' error(s).');
        process.exit(1);
    }
    console.log('\nRewarded-ads test passed.');
    process.exit(0);
})();
