'use strict';

// Pure progression math + unlock rules. No Supabase, no sockets — just the level
// curve and achievement-skin thresholds, so they're trivially testable and shared
// by both auth.js (persistence) and game.js (the at-gameOver compute that fills
// the startGameover packet). Kept server-authoritative: the client only ever
// renders values the server computed.

// XP needed to advance FROM level n-1 TO level n. Fast-early, slow-late:
//   xpRequiredForLevel(2) ≈ 152, (5) ≈ 657, (13) ≈ 3084.
// Tuned (with the config XP awards, ~150-250 XP/match) for ~4-5 unlocks in a
// player's first session.
function xpRequiredForLevel(n) {
    if (n <= 1) { return 0; }
    return Math.round(50 * Math.pow(n, 1.6));
}

// Total cumulative XP required to BE level `level` (i.e. the floor of that level).
function cumulativeXpForLevel(level) {
    var total = 0;
    for (var n = 2; n <= level; n++) {
        total += xpRequiredForLevel(n);
    }
    return total;
}

// Highest level whose cumulative floor a given total XP has reached.
function levelForXp(totalXp) {
    var xp = totalXp || 0;
    var lvl = 1;
    var cumulative = 0;
    while (cumulative + xpRequiredForLevel(lvl + 1) <= xp) {
        cumulative += xpRequiredForLevel(lvl + 1);
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
    { id: 'golden_champion', name: 'Golden Champion', slot: 'cart', stat: 'wins', threshold: 50 },
    { id: 'warlord', name: 'Warlord', slot: 'cart', stat: 'brutalist', threshold: 75 },
    { id: 'executioner', name: 'Executioner', slot: 'pattern', stat: 'mostKills', threshold: 75 },
    { id: 'punching_bag', name: 'Punching Bag', slot: 'pattern', stat: 'mostMurdered', threshold: 100 },
    { id: 'guardian', name: 'Guardian', slot: 'trail', stat: 'savior', threshold: 100 },
    { id: 'survivor', name: 'Survivor', slot: 'trail', stat: 'survivalist', threshold: 100 }
];

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
        events.push({ type: 'xp', amount: opts.xpDelta });
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
    xpRequiredForLevel: xpRequiredForLevel,
    cumulativeXpForLevel: cumulativeXpForLevel,
    levelForXp: levelForXp,
    levelProgress: levelProgress,
    ACHIEVEMENT_UNLOCKS: ACHIEVEMENT_UNLOCKS,
    achievementsUnlocked: achievementsUnlocked,
    mergeMedalCounts: mergeMedalCounts,
    defaultProgression: defaultProgression,
    buildToastEvents: buildToastEvents
};
