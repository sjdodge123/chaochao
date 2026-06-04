'use strict';

// Pure progression math + unlock rules. No Supabase, no sockets — just the level
// curve and achievement-skin thresholds, so they're trivially testable and shared
// by both auth.js (persistence) and game.js (the at-gameOver compute that fills
// the startGameover packet). Kept server-authoritative: the client only ever
// renders values the server computed.

// Rewarded-video "Watch to 2× match XP" multiplier. Lives HERE (not config.json) so
// tuning it stays off the gameplay-mechanic CHANGELOG path. The server credits a BONUS
// of originalXpDelta * (XP_MULTIPLIER_REWARDED - 1) on a confirmed ad watch — i.e. a 2×
// multiplier tops up the match XP by another 1× of what the match originally earned.
var XP_MULTIPLIER_REWARDED = 2;

// The extra XP granted for watching the rewarded ad: the match's original earned XP times
// (multiplier - 1). At 2× that's exactly the original delta again (total = 2× original).
// Pure + server-authoritative (multiplier never comes from the client) so the claim handler
// and the headless test compute the bonus the same way.
function rewardedBonusXp(originalXpDelta) {
    var base = (typeof originalXpDelta === 'number' && originalXpDelta > 0) ? originalXpDelta : 0;
    return base * (XP_MULTIPLIER_REWARDED - 1);
}

// XP needed to advance FROM level n-1 TO level n. Linear with a hard ceiling
// ("capped hook", operator-approved 2026-06-04): 50 + 22n, capped at 1000/level
// (the cap kicks in at Lv44). With ~100 XP/match (winners ~195) that paces the
// every-2-levels cosmetic ladder at ~2-3 matches per unlock early, growing to a
// permanent ceiling of ~20 matches — the next skin always feels reachable.
// L100 ≈ 80k XP ≈ ~800 matches lifetime.
//   xpRequiredForLevel(2) = 95, (10) = 270, (44+) = 1000.
// MIGRATION SAFETY: this is strictly cheaper than the old 50·n^1.6 curve at every
// level, so levelForXp(existing xp) can only go UP — no player ever demotes.
function xpRequiredForLevel(n) {
    if (n <= 1) { return 0; }
    return Math.min(1000, Math.round((50 + 22 * n) / 5) * 5);
}

// Precomputed cumulative floors make cumulativeXpForLevel/levelForXp O(1). This is a
// hardening requirement, not just speed: past the cap every level costs a flat 1000,
// so a naive walk is ~xp/1000 iterations — a corrupt/oversized xp row (nothing bounds
// the column) would stall the single-threaded event loop for seconds (measured 2.4s at
// xp=1e12). CURVE_CAP_LEVEL = first level whose cost hits the cap; CURVE_CUM[l] = the
// cumulative floor of level l up to there; beyond it the floor is closed-form.
var CURVE_CAP = 1000;
var CURVE_CAP_LEVEL = (function () {
    var n = 2;
    while (xpRequiredForLevel(n) < CURVE_CAP) { n++; }
    return n;
})();
var CURVE_CUM = (function () {
    var cum = [0, 0]; // levels 0 and 1 have a 0 floor
    for (var n = 2; n <= CURVE_CAP_LEVEL; n++) { cum[n] = cum[n - 1] + xpRequiredForLevel(n); }
    return cum;
})();

// Total cumulative XP required to BE level `level` (i.e. the floor of that level).
function cumulativeXpForLevel(level) {
    if (level <= 1) { return 0; }
    if (level <= CURVE_CAP_LEVEL) { return CURVE_CUM[level]; }
    return CURVE_CUM[CURVE_CAP_LEVEL] + (level - CURVE_CAP_LEVEL) * CURVE_CAP;
}

// Highest level whose cumulative floor a given total XP has reached. Clamped at a
// far-beyond-the-ladder ceiling so a corrupt/absurd xp row renders a bounded badge
// ("Lv 9999") instead of a ten-digit one — the skin ladder tops out at 100, so no
// legitimate value gets near the clamp.
var LEVEL_HARD_CAP = 9999;
function levelForXp(totalXp) {
    var xp = totalXp || 0;
    var capFloor = CURVE_CUM[CURVE_CAP_LEVEL];
    if (xp >= capFloor) {
        return Math.min(LEVEL_HARD_CAP, CURVE_CAP_LEVEL + Math.floor((xp - capFloor) / CURVE_CAP));
    }
    var lvl = 1;
    while (lvl + 1 <= CURVE_CAP_LEVEL && CURVE_CUM[lvl + 1] <= xp) {
        lvl++;
    }
    return lvl;
}

// XP progress within the current level + how much the next level costs — handed to
// the client so it can draw the "to next level" bar without re-deriving the curve.
function levelProgress(totalXp) {
    var xp = totalXp || 0;
    var level = levelForXp(xp);
    var floor = cumulativeXpForLevel(level);
    return {
        level: level,
        xpThisLevel: xp - floor,
        xpForNextLevel: xpRequiredForLevel(level + 1)
    };
}

// Achievement-gated cosmetics: lifetime medal/win thresholds, each assigned to a cosmetic
// slot ('cart' | 'pattern' | 'trail') so it equips alongside the level cosmetics. The
// medals a player banks count toward them lifetime. `stat` keys match the medal names from
// gatherAchievements() (game.js / achievements.js), except `wins` which is its own
// progression column. Thresholds are scaled per-achievement (rare=50, mid=75, common=100)
// — see docs/cosmetics-ladder.md. Slots mirror server/skinRegistry.js.
var ACHIEVEMENT_UNLOCKS = [
    { id: 'galaxy', name: "Galaxy", slot: 'cart', stat: 'wins', threshold: 25 },
    { id: 'border_laurel', name: "Laurel", slot: 'border', stat: 'wins', threshold: 50 },
    { id: 'golden_champion', name: "Golden Champion", slot: 'cart', stat: 'wins', threshold: 100 },
    { id: 'border_crown', name: "Crown", slot: 'border', stat: 'wins', threshold: 200 },
    { id: 'warlord', name: "Warlord", slot: 'cart', stat: 'brutalist', threshold: 25 },
    { id: 'border_runes', name: "Runes", slot: 'border', stat: 'brutalist', threshold: 60 },
    { id: 'border_plasma', name: "Plasma", slot: 'border', stat: 'brutalist', threshold: 120 },
    { id: 'executioner', name: "Executioner", slot: 'pattern', stat: 'mostKills', threshold: 30 },
    { id: 'electric', name: "Electric", slot: 'pattern', stat: 'mostKills', threshold: 75 },
    { id: 'aperture', name: "Aperture", slot: 'cart', stat: 'mostKills', threshold: 150 },
    { id: 'survivor', name: "Survivor", slot: 'trail', stat: 'survivalist', threshold: 25 },
    { id: 'hoverbike', name: "Hoverbike", slot: 'cart', stat: 'survivalist', threshold: 60 },
    { id: 'aurora', name: "Aurora", slot: 'trail', stat: 'survivalist', threshold: 120 },
    { id: 'comet', name: "Comet", slot: 'trail', stat: 'winStreak', threshold: 3 },
    { id: 'border_electric', name: "Electric Rim", slot: 'border', stat: 'winStreak', threshold: 5 },
    { id: 'starfighter', name: "Starfighter", slot: 'cart', stat: 'winStreak', threshold: 8 },
    { id: 'ribbon', name: "Ribbon", slot: 'trail', stat: 'savior', threshold: 15 },
    { id: 'guardian', name: "Guardian", slot: 'trail', stat: 'savior', threshold: 50 },
    { id: 'flames', name: "Flames", slot: 'pattern', stat: 'savior', threshold: 100 },
    { id: 'punching_bag', name: "Punching Bag", slot: 'pattern', stat: 'mostMurdered', threshold: 30 },
    { id: 'bubbles', name: "Bubbles", slot: 'trail', stat: 'mostMurdered', threshold: 75 },
    { id: 'nebula', name: "Nebula", slot: 'pattern', stat: 'mostMurdered', threshold: 150 },
    { id: 'bolt', name: "Bolt", slot: 'trail', stat: 'zombieSlayer', threshold: 15 },
    { id: 'neon', name: "Neon", slot: 'trail', stat: 'zombieSlayer', threshold: 50 },
    { id: 'yin_yang', name: "Yin-Yang", slot: 'cart', stat: 'abilitiesUsed', threshold: 50 },
    { id: 'hypno', name: "Hypno", slot: 'cart', stat: 'abilitiesUsed', threshold: 200 },
    { id: 'border_orbit', name: "Orbit", slot: 'border', stat: 'abilitiesUsed', threshold: 500 },
    { id: 'ferris_wheel', name: "Ferris Wheel", slot: 'cart', stat: 'goalsReached', threshold: 25 },
    { id: 'wheel_of_fortune', name: "Wheel of Fortune", slot: 'cart', stat: 'goalsReached', threshold: 75 },
    { id: 'disco_ball', name: "Disco Ball", slot: 'cart', stat: 'goalsReached', threshold: 200 },
    { id: 'turtle', name: "Turtle", slot: 'cart', stat: 'gamesPlayed', threshold: 10 },
    { id: 'pumpkin', name: "Pumpkin", slot: 'cart', stat: 'gamesPlayed', threshold: 50 },
    { id: 'saw_blade', name: "Saw Blade", slot: 'cart', stat: 'gamesPlayed', threshold: 150 },
    { id: 'border_gear', name: "Gear Rim", slot: 'border', stat: 'gamesPlayed', threshold: 400 },
    { id: 'gear', name: "Gear", slot: 'cart', stat: 'heavyHitter', threshold: 20 },
    { id: 'dino', name: "Dino", slot: 'cart', stat: 'heavyHitter', threshold: 60 },
    { id: 'tiger', name: "Tiger", slot: 'pattern', stat: 'cosmeticGames', threshold: 10 },
    { id: 'pinwheel', name: "Pinwheel", slot: 'cart', stat: 'cosmeticGames', threshold: 50 },
    { id: 'border_spikes', name: "Spikes", slot: 'border', stat: 'pinball', threshold: 25 },
    { id: 'border_sawblade', name: "Sawblade Rim", slot: 'border', stat: 'pinball', threshold: 80 },
    { id: 'ripple', name: "Ripple", slot: 'trail', stat: 'iceSkater', threshold: 20 },
    { id: 'border_glow', name: "Glow", slot: 'border', stat: 'iceSkater', threshold: 60 },
    { id: 'helm', name: "Helm", slot: 'cart', stat: 'recapAppearances', threshold: 10 },
    { id: 'border_flames', name: "Flame Rim", slot: 'border', stat: 'recapAppearances', threshold: 40 },
    { id: 'circuit', name: "Circuit", slot: 'pattern', stat: 'joinInProgress', threshold: 15 },
    { id: 'carbon', name: "Carbon Fiber", slot: 'pattern', stat: 'mapsSubmitted', threshold: 1 },
    { id: 'checkered', name: "Checkered", slot: 'pattern', stat: 'mapsSubmitted', threshold: 5 },
];

// THE single source of medal display names: achievements.js builds its end-of-match
// medal cards from this map, and describeAchievement phrases requirement lines from it
// ("Earn the <medal> medal N times") — so the game-over banner, the profile tab, and
// the unlock celebration can never disagree on what a medal is called.
var MEDAL_TITLES = {
    mostKills: 'Serial killer', savior: 'Savior', survivalist: 'Survivalist',
    brutalist: 'Brutalist', mostMurdered: 'Picked on', resourceful: 'Resouceful',
    bully: 'Bully', doubleKill: 'Double Kill', tripleKill: 'Triple Kill',
    megaKill: 'Mega Kill', zombieSlayer: 'Zombie Slayer', heavyHitter: 'Heavy Hitter',
    pinball: 'Pinball', iceSkater: 'Ice Skater'
};
function describeAchievement(u) {
    var n = u.threshold;
    switch (u.stat) {
        case 'wins': return 'Win ' + n + ' matches';
        case 'winStreak': return 'Win ' + n + ' matches in a row';
        case 'gamesPlayed': return 'Play ' + n + ' matches';
        case 'goalsReached': return 'Reach the goal ' + n + ' times';
        case 'abilitiesUsed': return 'Use ' + n + ' abilities';
        case 'cosmeticGames': return 'Play ' + n + ' matches with a cosmetic equipped';
        case 'recapAppearances': return 'Star in ' + n + ' match recaps';
        case 'joinInProgress': return 'Join ' + n + ' matches already in progress';
        case 'mapsSubmitted': return n === 1 ? 'Publish a map from the editor' : ('Publish ' + n + ' maps from the editor');
        default: {
            var title = MEDAL_TITLES[u.stat] || u.stat;
            return 'Earn the ' + title + ' medal ' + n + (n === 1 ? ' time' : ' times');
        }
    }
}

// The achievement ladder shaped for the client (config payload): everything the UI
// needs to render locked silhouettes, requirement text and progress bars — no
// client-side mirror of ACHIEVEMENT_UNLOCKS to keep in lockstep.
function clientAchievementDefs() {
    return ACHIEVEMENT_UNLOCKS.map(function (u) {
        return { id: u.id, name: u.name, slot: u.slot, stat: u.stat, threshold: u.threshold, desc: describeAchievement(u) };
    });
}

// winStreak is a MAX/streak, not a count: maintained explicitly after the additive medal
// merge. `_streak` (underscore = internal, not a cosmetic stat) is the current run; `winStreak`
// is the best-ever, which the achievement ladder gates on. Call once per match after merging.
function applyWinStreak(medalCounts, win) {
    if (!medalCounts) { return medalCounts; }
    var cur = win ? (medalCounts._streak || 0) + 1 : 0;
    medalCounts._streak = cur;
    medalCounts.winStreak = Math.max(medalCounts.winStreak || 0, cur);
    return medalCounts;
}

// Set of achievement-skin ids whose threshold the given lifetime totals satisfy.
function achievementsUnlocked(medalCounts, wins) {
    var mc = medalCounts || {};
    var out = [];
    for (var i = 0; i < ACHIEVEMENT_UNLOCKS.length; i++) {
        var u = ACHIEVEMENT_UNLOCKS[i];
        var val = (u.stat === 'wins') ? (wins || 0) : (mc[u.stat] || 0);
        if (val >= u.threshold) { out.push(u.id); }
    }
    return out;
}

// Additively merge per-match medal deltas into a lifetime medal-counts object,
// returning a new object (never mutates the input).
function mergeMedalCounts(existing, deltas) {
    var out = {};
    var k;
    if (existing) { for (k in existing) { out[k] = existing[k]; } }
    if (deltas) { for (k in deltas) { out[k] = (out[k] || 0) + deltas[k]; } }
    return out;
}

// A blank progression row (used before the real row loads, and for guests' compute).
function defaultProgression() {
    return { xp: 0, level: 1, unlocked_skins: [], medal_counts: {}, wins: 0 };
}

// Build the ordered celebration-toast events for one match, shown on the player's
// next lobby arrival (NOT on the game-over screen). Order = XP → level-up → newly
// unlocked LEVEL skins → newly unlocked ACHIEVEMENT skins. Level-skin unlocks are
// derived here from the level crossing so the "new skin available" toast fires even
// though level skins aren't stored in unlocked_skins. Pure; takes the registry's
// level→skin map via `levelSkinsUnlockedBetween` injected by the caller to avoid a
// server/skinRegistry require cycle.
function buildToastEvents(opts) {
    opts = opts || {};
    var events = [];
    if (opts.xpDelta > 0) {
        var xpEv = { type: 'xp', amount: opts.xpDelta };
        // When the caller knows the player's pre-match XP total, attach before/after
        // level-bar snapshots so the client can ANIMATE the bar filling (and rolling
        // over on level-up) instead of just printing "+N XP". Optional: events without
        // them (old queued toasts, not-yet-loaded rows) fall back to plain text.
        if (typeof opts.oldXp === 'number') {
            xpEv.from = levelProgress(opts.oldXp);
            xpEv.to = levelProgress(opts.oldXp + opts.xpDelta);
        }
        events.push(xpEv);
    }
    var oldLevel = opts.oldLevel || 1;
    var newLevel = opts.newLevel || oldLevel;
    if (newLevel > oldLevel) {
        events.push({ type: 'level', level: newLevel });
        var levelSkins = (typeof opts.levelSkinsUnlocked === 'function')
            ? opts.levelSkinsUnlocked(oldLevel, newLevel)
            : (opts.levelSkinsUnlocked || []);
        for (var i = 0; i < levelSkins.length; i++) {
            events.push({ type: 'skin', id: levelSkins[i] });
        }
    }
    var ach = opts.freshAchievementSkins || [];
    for (var a = 0; a < ach.length; a++) {
        events.push({ type: 'achievement', id: ach[a] });
    }
    return events;
}

module.exports = {
    XP_MULTIPLIER_REWARDED: XP_MULTIPLIER_REWARDED,
    rewardedBonusXp: rewardedBonusXp,
    xpRequiredForLevel: xpRequiredForLevel,
    cumulativeXpForLevel: cumulativeXpForLevel,
    levelForXp: levelForXp,
    levelProgress: levelProgress,
    ACHIEVEMENT_UNLOCKS: ACHIEVEMENT_UNLOCKS,
    MEDAL_TITLES: MEDAL_TITLES,
    describeAchievement: describeAchievement,
    clientAchievementDefs: clientAchievementDefs,
    achievementsUnlocked: achievementsUnlocked,
    applyWinStreak: applyWinStreak,
    mergeMedalCounts: mergeMedalCounts,
    defaultProgression: defaultProgression,
    buildToastEvents: buildToastEvents
};
