'use strict';

// Headless progression test. Boots the REAL server modules (no network/browser,
// same approach as smoke-test.js), drives a match to gameOver, and asserts the
// server-computed XP breakdown / level-up / achievement-unlock that ships in the
// startGameover packet — with Supabase writes DISABLED (the local default), so it
// also proves nothing is persisted off the gameplay path.
//
// What it covers (the pure, deterministic part of the progression system):
//   - XP breakdown: participation + per-notch + win/runner-up bonuses.
//   - Level curve + level-up detection from the in-memory progression cache.
//   - Lifetime medal counters crossing an achievement-skin threshold.
//   - The progression.js pure helpers (level curve, unlock thresholds).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const hostess = require(path.join(repoRoot, 'server', 'hostess.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const progression = require(path.join(repoRoot, 'server', 'progression.js'));
const auth = require(path.join(repoRoot, 'server', 'auth.js'));
const c = utils.loadConfig();

let failures = 0;
function check(cond, msg) {
    if (cond) {
        console.log('  ok: ' + msg);
    } else {
        failures++;
        console.log('::error::FAIL: ' + msg);
    }
}

// Recording io: messenger.messageRoomBySig -> io.to(sig).emit(header, payload).
const events = [];
const recordingIo = {
    to() { return { emit(header, payload) { events.push({ header: header, payload: payload }); } }; },
    sockets: { emit() { } }
};
messenger.build(recordingIo);

function lastEvent(header) {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].header === header) { return events[i].payload; }
    }
    return null;
}

// --- Unit: pure progression helpers -----------------------------------------
function testPureHelpers() {
    console.log('Pure helpers:');
    check(progression.levelForXp(0) === 1, 'levelForXp(0) === 1');
    check(progression.levelForXp(progression.cumulativeXpForLevel(2)) === 2, 'reaching L2 floor === level 2');
    check(progression.levelForXp(progression.cumulativeXpForLevel(5)) === 5, 'reaching L5 floor === level 5');
    check(progression.levelForXp(progression.cumulativeXpForLevel(5) - 1) === 4, 'one XP short of L5 === level 4');
    const lp = progression.levelProgress(progression.cumulativeXpForLevel(3) + 10);
    check(lp.level === 3 && lp.xpThisLevel === 10, 'levelProgress reports xpThisLevel within the level');
    check(progression.achievementsUnlocked({ mostKills: 30 }, 0).indexOf('executioner') !== -1, 'mostKills>=30 unlocks executioner');
    check(progression.achievementsUnlocked({ mostKills: 29 }, 0).indexOf('executioner') === -1, 'mostKills<30 does NOT unlock executioner');
    check(progression.achievementsUnlocked({}, 100).indexOf('golden_champion') !== -1, 'wins>=100 unlocks golden_champion');
    // New self-counter medals are now PRODUCED in gameplay (Codex P2: previously unlockable
    // by no path). Spot-check a few + the winStreak max-logic helper.
    check(progression.achievementsUnlocked({ gamesPlayed: 10 }, 0).indexOf('turtle') !== -1, 'gamesPlayed>=10 unlocks turtle');
    check(progression.achievementsUnlocked({ iceSkater: 20 }, 0).indexOf('ripple') !== -1, 'iceSkater>=20 unlocks ripple');
    // The 4 v0.26.0 competitive medals (zombieSlayer/heavyHitter/pinball/iceSkater) gate our
    // cosmetics directly via medal_counts (no dup counter). Spot-check the re-points.
    check(progression.achievementsUnlocked({ zombieSlayer: 15 }, 0).indexOf('bolt') !== -1, 'zombieSlayer>=15 unlocks bolt');
    check(progression.achievementsUnlocked({ heavyHitter: 20 }, 0).indexOf('gear') !== -1, 'heavyHitter>=20 unlocks gear');
    check(progression.achievementsUnlocked({ pinball: 25 }, 0).indexOf('border_spikes') !== -1, 'pinball>=25 unlocks border_spikes');
    check(progression.achievementsUnlocked({ mapsSubmitted: 1 }, 0).indexOf('carbon') !== -1, 'mapsSubmitted>=1 unlocks carbon');
    var streakMc = {};
    progression.applyWinStreak(streakMc, true); progression.applyWinStreak(streakMc, true); progression.applyWinStreak(streakMc, true);
    check(streakMc.winStreak === 3, 'applyWinStreak: 3 wins -> winStreak 3');
    progression.applyWinStreak(streakMc, false);
    check(streakMc._streak === 0 && streakMc.winStreak === 3, 'applyWinStreak: loss resets current, keeps best');
    check(progression.achievementsUnlocked({ winStreak: 3 }, 0).indexOf('comet') !== -1, 'winStreak>=3 unlocks comet');
    const merged = progression.mergeMedalCounts({ savior: 2 }, { savior: 1, mostKills: 3 });
    check(merged.savior === 3 && merged.mostKills === 3, 'mergeMedalCounts adds deltas');
}

// Build a room with two signed-in human players, force places, run gameOver.
function runMatch(setup) {
    events.length = 0;
    const sig = setup.sig;
    const room = game.getRoom(sig, 4);
    const p1 = room.world.createNewPlayer(setup.p1.id);
    const p2 = room.world.createNewPlayer(setup.p2.id);
    room.playerList[setup.p1.id] = p1;
    room.playerList[setup.p2.id] = p2;
    // Mark as signed-in humans (gameOver awards only these). Use the player id AS the
    // userId so the in-memory toast queue is drainable per-test by that same id.
    p1.isAI = false; p1.verifiedUserId = setup.p1.id;
    if (setup.p2.isAI) { p2.isAI = true; p2.verifiedUserId = null; }
    else { p2.isAI = false; p2.verifiedUserId = setup.p2.id; }
    p1.notches = setup.p1.notches;
    p2.notches = setup.p2.notches;
    // Medal inputs (gatherAchievements reads these).
    p1.totalKills = setup.p1.totalKills || 0;
    p2.totalKills = setup.p2.totalKills || 0;
    p1.goalsReachedMatch = setup.p1.goalsReachedMatch || 0;
    p2.goalsReachedMatch = setup.p2.goalsReachedMatch || 0;
    p1.recapWorthy = !!setup.p1.recapWorthy;
    p2.recapWorthy = !!setup.p2.recapWorthy;
    p1.racedCurrentMap = setup.p1.racedCurrentMap !== false;
    p2.racedCurrentMap = setup.p2.racedCurrentMap !== false;
    if (setup.p1.progression) { p1.progression = setup.p1.progression; p1.progressionLoaded = true; }
    if (setup.p2.progression) { p2.progression = setup.p2.progression; p2.progressionLoaded = true; }
    room.game.firstPlaceSig = setup.p1.id;
    room.game.secondPlaceSig = setup.p2.id;
    // Call awardProgression directly to capture its return (xpEarned telemetry +
    // cache mutation), then gameOver for the packet/state. gameOver also calls
    // awardProgression, so to avoid double-applying we snapshot via a single path:
    const awards = room.game.awardProgression(room.game.gatherAchievements(), setup.p1.id);
    return { room: room, awards: awards, p1: p1, p2: p2 };
}

// Toasts are queued in-memory when writes are off (the test default). Drain a
// user's queued toast events via the messenger's exported in-memory drain so we can
// assert on what a match produced. (Mirrors the lobby-arrival delivery path.)
function drainMem(userId) {
    // messenger exposes enqueue; drain is internal, so pull via a fresh enterGame is
    // heavy. Instead read the module's queue through enqueue's side: re-enqueue empty
    // then use the test-only accessor if present, else fall back to deliver path.
    return messenger._drainToastsInMemoryForTest
        ? messenger._drainToastsInMemoryForTest(userId)
        : [];
}

function testXpBreakdown() {
    console.log('XP breakdown + win/runner-up (via awardProgression return + cache):');
    const r = runMatch({
        sig: 'prog-xp',
        p1: { id: 'prog-xp-1', notches: 5, totalKills: 0, progression: progression.defaultProgression() },
        p2: { id: 'prog-xp-2', notches: 2, totalKills: 0, progression: progression.defaultProgression() }
    });
    // awardProgression still returns xpEarned (telemetry), even though the packet no
    // longer carries it. runMatch captures it via r.awards.
    const x1 = r.awards.xpEarned['prog-xp-1'];
    const x2 = r.awards.xpEarned['prog-xp-2'];
    check(!!x1 && !!x2, 'both signed-in players have an xp breakdown');
    const expected1 = c.xpParticipate + c.xpPerNotch * 5 + c.xpWinBonus;
    const expected2 = c.xpParticipate + c.xpPerNotch * 2 + c.xpRunnerUpBonus;
    check(x1.total === expected1, 'winner total = participation + 5 notches + win bonus (' + x1.total + ' === ' + expected1 + ')');
    check(x1.winBonus === c.xpWinBonus && x1.runnerUp === 0, 'winner gets win bonus, no runner-up');
    check(x2.total === expected2, 'runner-up total = participation + 2 notches + runner-up bonus (' + x2.total + ' === ' + expected2 + ')');
    check(x2.winBonus === 0 && x2.runnerUp === c.xpRunnerUpBonus, 'runner-up gets runner-up bonus, no win bonus');
    // Winner's in-memory cache advanced by the earned total.
    check(r.p1.progression.xp === expected1, 'winner cache xp = earned total (' + r.p1.progression.xp + ')');
}

// Regression for the P1 bug: on the real match-ending tick, gameOver(winner) is
// called BEFORE firstPlaceSig/secondPlaceSig are set for the final race, so they're
// null. The win bonus + wins increment must come from gameOver's winner ARGUMENT,
// not those round-placement fields. (The earlier tests pre-set the fields, which
// masked this.)
function testWinnerFromGameOverArg() {
    console.log('Win bonus from gameOver arg (P1 regression):');
    const room = game.getRoom('prog-p1', 4);
    const w = room.world.createNewPlayer('prog-p1-win');
    const l = room.world.createNewPlayer('prog-p1-lose');
    room.playerList['prog-p1-win'] = w;
    room.playerList['prog-p1-lose'] = l;
    w.isAI = false; w.verifiedUserId = 'u-win'; w.notches = 5; w.racedCurrentMap = true;
    w.progression = progression.defaultProgression(); w.progressionLoaded = true;
    l.isAI = false; l.verifiedUserId = 'u-lose'; l.notches = 2; l.racedCurrentMap = true;
    l.progression = progression.defaultProgression(); l.progressionLoaded = true;
    // Reproduce the real match-end state: placement fields NULL at gameOver time.
    room.game.firstPlaceSig = null;
    room.game.secondPlaceSig = null;
    const awards = room.game.awardProgression(room.game.gatherAchievements(), 'prog-p1-win');
    const xw = awards.xpEarned['prog-p1-win'];
    check(xw.winBonus === c.xpWinBonus, 'winner gets win bonus even with firstPlaceSig null (' + xw.winBonus + ')');
    check(w.progression.wins === 1, 'winner wins incremented to 1 (was 0)');
    check(awards.xpEarned['prog-p1-lose'].winBonus === 0, 'loser gets no win bonus');
    // Runner-up reachability (Codex #1): secondPlaceSig is null at match end, so the
    // runner-up bonus must come from notches (highest non-winner). The loser has the
    // most notches among non-winners here, so they must get it.
    check(awards.xpEarned['prog-p1-lose'].runnerUp === c.xpRunnerUpBonus,
        'runner-up bonus reachable via notches when secondPlaceSig is null (' + awards.xpEarned['prog-p1-lose'].runnerUp + ')');
}

function testLevelUp() {
    console.log('Level-up detection + lobby toast (in-memory queue):');
    // Start 12 XP below the L2 floor so a single match (>=152 XP for a 5-notch win)
    // crosses it. The Racing Stripes pattern (id 'stripes') unlocks at Lv2, so crossing
    // into Lv2 should also queue a "skin" toast.
    const startXp = progression.cumulativeXpForLevel(2) - 12;
    // The runner-up sits JUST past the L2 floor: under the capped-hook curve (50+22n,
    // tuned so a fresh player levels off their very first decent match) a 0-XP start
    // would cross L2 too — park them where one runner-up match can't reach L3.
    const r = runMatch({
        sig: 'prog-lvl',
        p1: { id: 'prog-lvl-1', notches: 5, totalKills: 0, progression: { xp: startXp, level: 1, unlocked_skins: [], medal_counts: {}, wins: 0 } },
        p2: { id: 'prog-lvl-2', notches: 1, totalKills: 0, progression: { xp: progression.cumulativeXpForLevel(2), level: 2, unlocked_skins: [], medal_counts: {}, wins: 0 } }
    });
    check(r.p1.progression.level >= 2, 'winner cache level advanced past 1 (-> ' + r.p1.progression.level + ')');
    check(r.p2.progression.level === 2, 'low-XP runner-up stayed level 2');
    const t1 = drainMem('prog-lvl-1');
    check(t1.some(e => e.type === 'level' && e.level >= 2), 'winner queued a level-up toast');
    check(t1.some(e => e.type === 'skin' && e.id === 'stripes'), 'winner queued a Racing Stripes (stripes, Lv2) new-cosmetic toast');
    check(t1.some(e => e.type === 'xp'), 'winner queued an xp toast');
    const t2 = drainMem('prog-lvl-2');
    check(!t2.some(e => e.type === 'level'), 'runner-up queued no level-up toast');
}

function testAchievementUnlock() {
    console.log('Achievement-skin unlock + toast:');
    // p1 holds Most Kills this match (totalKills highest) and already has 29 lifetime
    // -> crossing the threshold (30) unlocks "executioner".
    const r = runMatch({
        sig: 'prog-ach',
        p1: { id: 'prog-ach-1', notches: 3, totalKills: 5, progression: { xp: 0, level: 1, unlocked_skins: [], medal_counts: { mostKills: 29 }, wins: 0 } },
        p2: { id: 'prog-ach-2', notches: 1, totalKills: 0, progression: progression.defaultProgression() }
    });
    check(r.p1.progression.unlocked_skins.indexOf('executioner') !== -1, 'in-memory cache records the executioner unlock');
    const t1 = drainMem('prog-ach-1');
    check(t1.some(e => e.type === 'achievement' && e.id === 'executioner'), 'winner queued an executioner achievement toast');
}

// Codex #2: players who STAY in the room get their toasts on the lobby return
// (Game.startLobby -> messenger.deliverRoomToasts), not only on a re-join. async +
// awaits a microtask because the emit happens inside auth.drainPendingToasts's
// resolved promise (production doesn't care about that microtask; the test must).
async function testSameRoomToastDelivery() {
    console.log('Same-room lobby-return toast delivery (Codex #2):');
    // A recording socket registered in the mailbox so deliverRoomToasts can emit to it.
    const sock = makeRecordingSocket('prog-room-1');
    sock.userId = 'u-room-1';
    messenger.addMailBox(sock.id, sock, { userId: 'u-room-1', deviceId: null });
    // Queue toasts for this user as a finished match would (writes-off in-memory path).
    messenger.enqueueToastsInMemory('u-room-1', [{ type: 'xp', amount: 200 }, { type: 'level', level: 3 }]);
    // Simulate the match->lobby transition for a room containing this still-present player.
    const playerList = { 'prog-room-1': { isAI: false, verifiedUserId: 'u-room-1' } };
    messenger.deliverRoomToasts(playerList);
    await Promise.resolve(); await Promise.resolve(); // let the drain promise's .then run
    const emit = sock.lastEmit('progressionToasts');
    check(!!emit && Array.isArray(emit.events), 'staying player received a progressionToasts batch on lobby return');
    check(emit && emit.events.some(e => e.type === 'level' && e.level === 3), 'batch carries the queued level toast');
    // Drained: a second delivery sends nothing (toasts show once).
    sock.emits.length = 0;
    messenger.deliverRoomToasts(playerList);
    await Promise.resolve(); await Promise.resolve();
    check(!sock.lastEmit('progressionToasts'), 'toasts cleared after first delivery (not re-sent)');
    messenger.removeMailBox(sock.id);
}

function testNoWritesByDefault() {
    console.log('Writes:');
    // With no Supabase env configured (the test's environment), there's no DB to write to,
    // so writes are off and progression stays in-memory. (The full env matrix for the write
    // decision — gate removed, prod tripwire, Heroku/override — lives in unit-tests.js.)
    check(auth.writesEnabled === false, 'no DB configured -> auth.writesEnabled === false (no persistence)');
}

// Bots and guests (no verifiedUserId) earn no progression at gameOver.
function testGuestsAndBotsEarnNothing() {
    console.log('Guests + bots earn no XP:');
    events.length = 0;
    const room = game.getRoom('prog-guest', 4);
    const human = room.world.createNewPlayer('prog-guest-human');
    const guest = room.world.createNewPlayer('prog-guest-guest');
    const bot = room.world.createNewPlayer('prog-guest-bot');
    room.playerList['prog-guest-human'] = human;
    room.playerList['prog-guest-guest'] = guest;
    room.playerList['prog-guest-bot'] = bot;
    human.isAI = false; human.verifiedUserId = 'user-h'; human.notches = 5; human.racedCurrentMap = true;
    human.progression = progression.defaultProgression(); human.progressionLoaded = true;
    guest.isAI = false; guest.verifiedUserId = null; guest.notches = 3;
    bot.isAI = true; bot.verifiedUserId = null; bot.notches = 4;
    room.game.firstPlaceSig = 'prog-guest-human';
    room.game.secondPlaceSig = 'prog-guest-guest';
    const awards = room.game.awardProgression(room.game.gatherAchievements(), 'prog-guest-human');
    check(!!awards.xpEarned['prog-guest-human'], 'signed-in human earns XP');
    check(!awards.xpEarned['prog-guest-guest'], 'guest (no verifiedUserId) earns nothing');
    check(!awards.xpEarned['prog-guest-bot'], 'bot (isAI) earns nothing');
    // And the game-over packet itself no longer carries progression fields.
    events.length = 0;
    room.game.gameOver('prog-guest-human');
    const packet = lastEvent('startGameover');
    check(packet && packet.xpEarned === undefined && packet.levelUps === undefined,
        'startGameover packet no longer carries xp/level/unlock fields');
}

// A socket.io stand-in that RECORDS outbound emits so we can assert on the
// cosmeticRejected / playerCosmeticChanged the real setCosmetic handler emits.
function makeRecordingSocket(id) {
    const handlers = {};
    const emits = [];
    return {
        id: id, userId: null, handlers: handlers, emits: emits,
        on(e, fn) { handlers[e] = fn; },
        emit(h, p) { emits.push({ header: h, payload: p }); },
        join() { }, leave() { },
        broadcast: { to() { return { emit() { } }; } },
        fire(e, p) { if (handlers[e]) handlers[e](p); },
        lastEmit(h) { for (let i = emits.length - 1; i >= 0; i--) { if (emits[i].header === h) return emits[i].payload; } return null; }
    };
}

// Drive the REAL messenger setCosmetic handler through every gate branch + the
// three-independent-slot guarantees.
function testSetCosmeticGating() {
    console.log('setCosmetic gating (real messenger handler):');
    const s = makeRecordingSocket('prog-skin-sock');
    messenger.addMailBox(s.id, s, { userId: null, deviceId: null }); // registers handlers
    s.fire('enterGame', -1); // real join + matchmake + spawn

    let room = null, player = null;
    for (const sig of Object.keys(hostess.getRooms())) {
        const rm = hostess.getRoomBySig(sig);
        if (rm && rm.playerList[s.id]) { room = rm; player = rm.playerList[s.id]; break; }
    }
    if (!room || !player) { check(false, 'joined a room via enterGame'); return; }
    room.game.currentState = c.stateMap.lobby; // setCosmetic requires the lobby state

    // setCosmetic emits the SUCCESS broadcast via messageRoomBySig (the recording
    // `io` -> events), but REJECTIONS via client.emit (the socket -> s.emits). Read
    // each from its real sink. Clear both before every equip. changedTo reads the
    // last broadcast FOR THAT SLOT so we can prove per-slot independence.
    const equip = function (slot, id) { s.emits.length = 0; events.length = 0; s.fire('setCosmetic', { slot: slot, id: id }); };
    const changedTo = function (slot) {
        for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].header === 'playerCosmeticChanged' && events[i].payload.slot === slot) { return events[i].payload.value; }
        }
        return '__none__';
    };
    const rejection = function () { return s.lastEmit('cosmeticRejected'); };

    // Guest (no progression) — treated as level 1. Every level cosmetic rejects.
    player.progression = null;
    equip('pattern', 'stripes'); { const r = rejection(); check(!!r && r.reason === 'level' && r.required === 2 && changedTo('pattern') === '__none__', 'guest rejected from Stripes (pattern Lv 2)'); }
    equip('cart', 'firetruck'); { const r = rejection(); check(!!r && r.reason === 'level' && r.required === 58 && changedTo('cart') === '__none__', 'guest rejected from Drone (cart Lv 58)'); }
    equip('bogusSlot', 'stripes'); { const r = rejection(); check(!!r && r.reason === 'slot', 'unknown slot rejected'); }
    equip('pattern', 'bogus-id'); { const r = rejection(); check(!!r && r.reason === 'unknown', 'unknown id rejected'); }
    equip('pattern', 'firetruck'); { const r = rejection(); check(!!r && r.reason === 'unknown', 'wrong-slot id rejected (cart id in pattern slot)'); }
    equip('cart', 'eight_ball'); { const r = rejection(); check(!!r && r.reason === 'level' && r.required === 40, 'guest rejected from a level-gated cart (eight_ball Lv 40)'); }

    // Signed-in level 1: still nothing free; empty id clears a slot.
    player.progression = { xp: 0, level: 1, unlocked_skins: [], medal_counts: {}, wins: 0 };
    equip('pattern', 'stripes'); { const r = rejection(); check(!!r && r.reason === 'level', 'level-1 player rejected from Stripes'); }
    equip('pattern', ''); check(changedTo('pattern') === null, 'empty id clears the pattern slot back to default');

    // Level 10 — Stripes (pattern Lv2) + Dashes (trail Lv6) + Pizza (cart Lv4) unlock;
    // Cookie (cart Lv12) + Hazard (pattern Lv14) rejected.
    player.progression = { xp: 99999, level: 10, unlocked_skins: [], medal_counts: {}, wins: 0 };
    equip('pattern', 'stripes'); check(changedTo('pattern') === 'stripes', 'level-10 player equips Stripes (pattern Lv 2)');
    equip('trail', 'dashes'); check(changedTo('trail') === 'dashes', 'level-10 player equips Dashes (trail Lv 6)');
    equip('cart', 'pizza'); check(changedTo('cart') === 'pizza', 'level-10 player equips Pizza (cart Lv 4)');
    equip('cart', 'cookie'); { const r = rejection(); check(!!r && r.reason === 'level' && r.required === 12, 'level-10 player rejected from Cookie (cart Lv 12)'); }
    equip('pattern', 'hazard'); { const r = rejection(); check(!!r && r.reason === 'level' && r.required === 14, 'level-10 player rejected from Hazard (pattern Lv 14)'); }

    // INDEPENDENCE: pattern + trail set above must BOTH still be equipped — equipping
    // one slot never clears another. (player fields: pattern, trailFx.)
    check(player.pattern === 'stripes' && player.trailFx === 'dashes', 'equipping the trail slot did not clear the pattern slot (independent slots)');

    // BORDER is an independent 4th slot (player.border): equipping it must NOT clear the
    // pattern — the two coexist (border rings the rim, pattern textures the body).
    equip('border', 'border_ring');
    check(player.border === 'border_ring' && player.pattern === 'stripes', 'equipping a border kept the pattern (border + pattern coexist, 4 independent slots)');

    // Level 12 — Cookie (cart Lv12) ok; Hazard (pattern Lv14) rejected.
    player.progression = { xp: 99999, level: 12, unlocked_skins: [], medal_counts: {}, wins: 0 };
    equip('cart', 'cookie'); check(changedTo('cart') === 'cookie', 'level-12 player equips Cookie (cart Lv 12)');
    equip('pattern', 'hazard'); { const r = rejection(); check(!!r && r.reason === 'level' && r.required === 14, 'level-12 player rejected from Hazard (pattern Lv 14)'); }

    // Achievement cosmetic — gated on unlocked_skins, not level, and slot-checked.
    player.progression = { xp: 99999, level: 30, unlocked_skins: [], medal_counts: {}, wins: 0 };
    equip('cart', 'golden_champion'); { const r = rejection(); check(!!r && r.reason === 'achievement', 'achievement cart rejected when not unlocked (even at Lv 30)'); }
    equip('pattern', 'golden_champion'); { const r = rejection(); check(!!r && r.reason === 'unknown', 'achievement cart rejected in the wrong slot'); }
    player.progression.unlocked_skins = ['golden_champion'];
    equip('cart', 'golden_champion'); check(changedTo('cart') === 'golden_champion', 'achievement cart equips once unlocked');

    hostess.kickFromRoom(s.id);
    messenger.removeMailBox(s.id);
}

function testSoloCompetitionGate() {
    console.log('Solo competition gate (wins/medals need 2+ humans):');
    const r = runMatch({
        sig: 'prog-solo',
        p1: { id: 'prog-solo-1', notches: 5, totalKills: 9, progression: { xp: 0, level: 1, unlocked_skins: [], medal_counts: {}, wins: 99 } },
        p2: { id: 'prog-solo-bot', isAI: true, notches: 1, totalKills: 0, progression: progression.defaultProgression() }
    });
    check(r.p1.progression.wins === 99, 'solo win does NOT increment wins (only 1 human in room)');
    check((r.p1.progression.medal_counts.mostKills || 0) === 0, 'solo competitive medal (mostKills) is not awarded');
    check(r.p1.progression.xp > 0, 'solo player still earns participation XP');
}

function testGoalAccountingAndRecap() {
    console.log('goalsReached accumulator + recap top-2 gating:');
    const r = runMatch({
        sig: 'prog-goals',
        p1: { id: 'prog-goals-1', notches: 5, totalKills: 0, goalsReachedMatch: 3, progression: { xp: 0, level: 1, unlocked_skins: [], medal_counts: {}, wins: 0 } },
        p2: { id: 'prog-goals-2', notches: 1, totalKills: 0, recapWorthy: true, progression: progression.defaultProgression() }
    });
    check((r.p1.progression.medal_counts.goalsReached || 0) === 3, 'goalsReached folds the per-match accumulator (3 across rounds), not a single bool');
    check((r.p1.progression.medal_counts.recapAppearances || 0) === 1, 'winner banks a recapAppearance (the recap headline)');
    check((r.p2.progression.medal_counts.recapAppearances || 0) === 1, 'a non-winner with a recap-worthy moment banks a recapAppearance');
}

function testSpectatorEarnsNothing() {
    console.log('Late-join spectator earns no progression:');
    const r = runMatch({
        sig: 'prog-spec',
        p1: { id: 'prog-spec-1', notches: 5, totalKills: 0, progression: { xp: 0, level: 1, unlocked_skins: [], medal_counts: {}, wins: 0 } },
        // a signed-in player who joined mid-race as a spectator: never raced this match
        p2: { id: 'prog-spec-2', notches: 0, totalKills: 0, racedCurrentMap: false, progression: { xp: 0, level: 1, unlocked_skins: [], medal_counts: {}, wins: 0 } }
    });
    check(!r.awards.xpEarned['prog-spec-2'], 'spectator (never raced) gets no XP/progression award');
    check(!!r.awards.xpEarned['prog-spec-1'], 'the actual racer still earns');
    // with only 1 real racer, competitive progression must NOT count (the spectator does not make it 2 humans)
    check((r.p1.progression.wins || 0) === 0, '1 racer + 1 spectator is not "2 humans" — solo win does not count');
}

(async function run() {
    testPureHelpers();
    testXpBreakdown();
    testWinnerFromGameOverArg();
    testLevelUp();
    testAchievementUnlock();
    testGuestsAndBotsEarnNothing();
    testSoloCompetitionGate();
    testGoalAccountingAndRecap();
    testSpectatorEarnsNothing();
    testSetCosmeticGating();
    await testSameRoomToastDelivery();
    testNoWritesByDefault();

    if (failures > 0) {
        console.log('\nProgression test FAILED with ' + failures + ' error(s).');
        process.exit(1);
    }
    console.log('\nProgression test passed.');
    process.exit(0);
})();
