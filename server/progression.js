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
    applyWinStreak: applyWinStreak,
    mergeMedalCounts: mergeMedalCounts,
    defaultProgression: defaultProgression,
    buildToastEvents: buildToastEvents
};
