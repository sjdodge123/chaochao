'use strict';

// Server-side mirror of the cosmetic unlock rules. NO painter functions — the server
// only validates equips (setCosmetic) against a player's level / unlocked_skins. Keep
// the id + slot + unlock triples in lockstep with the painter-bearing client registry at
// client/scripts/skinRegistry.js.
//
// THREE independent slots — 'cart' (body shape), 'pattern' (texture painted on the body,
// tinted to player colour), 'trail' (motion-trail effect, rendered in player colour). A
// player equips one id per slot simultaneously; equipping in one slot never clears another.
//
// Level cosmetics are gated purely by progression.level (not stored per-user). Achievement
// cosmetics are stored in progression.unlocked_skins once their lifetime threshold is
// crossed (see server/progression.js ACHIEVEMENT_UNLOCKS) and assigned to a slot here.
// ids are stable storage keys — never renamed when display names change (display names +
// painters live on the client). The every-2-levels ladder (pattern@2, trail@4, cart@6, …)
// is documented in docs/cosmetics-ladder.md.
// 'border' SHARES the 2nd slot with 'pattern' (both map to the pattern field / selected_pattern
// column via COSMETIC_SLOT_FIELD / COSMETIC_SLOT_COLUMN) but is its own slot for setCosmetic
// validation (a border id has slot:'border').
var SLOTS = ['cart', 'pattern', 'trail', 'border'];
// Live Player-object field per slot ('trail' stores the EFFECT id in `trailFx`
// so it never collides with the client's `player.trail` motion object). Single
// source for everything that writes cosmetics onto a player server-side — the
// setCosmetic equip path (messenger.js) and the RANDOM_BOT_COSMETICS dev seam
// (entities/world.js) both consume this; add new slots HERE alongside SLOTS.
var SLOT_FIELD = { cart: 'cart', pattern: 'pattern', trail: 'trailFx', border: 'border' };

var SKINS = [
    // --- Carts (body shape; tints to player colour) ---
    { id: 'firetruck', slot: 'cart', unlock: { kind: 'level', level: 58 } },   // "Drone"
    { id: 'dino', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'hoverbike', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'starfighter', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'golden_champion', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'warlord', slot: 'cart', unlock: { kind: 'achievement' } },
    // --- Cart POOL: approved-but-not-yet-slotted novelty bodies. kind:'pool' is NOT an
    // equippable unlock kind (setCosmetic rejects it) — ids live here so validation knows
    // them + so the operator can promote one to a level/achievement unlock in one place. ---
    { id: 'pizza', slot: 'cart', unlock: { kind: 'level', level: 4 } },
    { id: 'earth', slot: 'cart', unlock: { kind: 'level', level: 62 } },
    { id: 'smiley', slot: 'cart', unlock: { kind: 'level', level: 36 } },
    { id: 'eight_ball', slot: 'cart', unlock: { kind: 'level', level: 40 } },
    { id: 'saw_blade', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'donut', slot: 'cart', unlock: { kind: 'level', level: 8 } },
    { id: 'vinyl', slot: 'cart', unlock: { kind: 'level', level: 66 } },
    { id: 'compass', slot: 'cart', unlock: { kind: 'level', level: 70 } },
    { id: 'wheel_of_fortune', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'clock', slot: 'cart', unlock: { kind: 'level', level: 74 } },
    { id: 'eyeball', slot: 'cart', unlock: { kind: 'level', level: 78 } },
    { id: 'disco_ball', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'hypno', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'cookie', slot: 'cart', unlock: { kind: 'level', level: 12 } },
    { id: 'beach_ball', slot: 'cart', unlock: { kind: 'level', level: 16 } },
    { id: 'sun', slot: 'cart', unlock: { kind: 'level', level: 90 } },
    { id: 'shuriken', slot: 'cart', unlock: { kind: 'level', level: 82 } },
    { id: 'dartboard', slot: 'cart', unlock: { kind: 'level', level: 86 } },
    { id: 'soccer_ball', slot: 'cart', unlock: { kind: 'level', level: 20 } },
    { id: 'basketball', slot: 'cart', unlock: { kind: 'level', level: 24 } },
    { id: 'yin_yang', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'ferris_wheel', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'pinwheel', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'watermelon', slot: 'cart', unlock: { kind: 'level', level: 28 } },
    { id: 'tire', slot: 'cart', unlock: { kind: 'level', level: 32 } },
    { id: 'gear', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'galaxy', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'snowflake', slot: 'cart', unlock: { kind: 'level', level: 96 } },
    { id: 'flower', slot: 'cart', unlock: { kind: 'level', level: 98 } },
    { id: 'coin', slot: 'cart', unlock: { kind: 'level', level: 50 } },
    { id: 'helm', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'aperture', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'cheese', slot: 'cart', unlock: { kind: 'level', level: 48 } },
    { id: 'citrus', slot: 'cart', unlock: { kind: 'level', level: 44 } },
    { id: 'turtle', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'pumpkin', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'moon', slot: 'cart', unlock: { kind: 'level', level: 94 } },
    { id: 'ok_hand', slot: 'cart', unlock: { kind: 'level', level: 100 } },
    { id: 'mouse', slot: 'cart', unlock: { kind: 'level', level: 54 } },
    // --- Patterns (texture overlay; tints to player colour) ---
    { id: 'stripes', slot: 'pattern', unlock: { kind: 'level', level: 2 } },
    { id: 'polka', slot: 'pattern', unlock: { kind: 'level', level: 56 } },
    { id: 'checkered', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'flames', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'nebula', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'executioner', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'punching_bag', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'carbon', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'camo', slot: 'pattern', unlock: { kind: 'level', level: 68 } },
    { id: 'hazard', slot: 'pattern', unlock: { kind: 'level', level: 14 } },
    { id: 'circuit', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'scales', slot: 'pattern', unlock: { kind: 'level', level: 80 } },
    { id: 'electric', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'tiger', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'waves', slot: 'pattern', unlock: { kind: 'level', level: 26 } },
    { id: 'honeycomb', slot: 'pattern', unlock: { kind: 'level', level: 88 } },
    { id: 'splatter', slot: 'pattern', unlock: { kind: 'level', level: 38 } },
    // --- Trails (motion-trail effect; ALWAYS rendered in player colour) ---
    { id: 'dashes', slot: 'trail', unlock: { kind: 'level', level: 6 } },
    { id: 'sparkle', slot: 'trail', unlock: { kind: 'level', level: 60 } },
    { id: 'comet', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'bubbles', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'aurora', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'guardian', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'survivor', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'ribbon', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'bolt', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'hearts', slot: 'trail', unlock: { kind: 'level', level: 72 } },
    { id: 'smoke', slot: 'trail', unlock: { kind: 'level', level: 18 } },
    { id: 'confetti', slot: 'trail', unlock: { kind: 'level', level: 84 } },
    { id: 'snow', slot: 'trail', unlock: { kind: 'level', level: 42 } },
    { id: 'tracks', slot: 'trail', unlock: { kind: 'level', level: 30 } },
    { id: 'notes', slot: 'trail', unlock: { kind: 'level', level: 92 } },
    { id: 'neon', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'ripple', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'powder', slot: 'trail', unlock: { kind: 'achievement' } },
    // --- Seasonal claims (kind:'seasonal') — granted ONCE on sign-in while the claim window
    // is open; OWNERSHIP IS PERMANENT (the id lands in unlocked_skins, exactly like an
    // achievement skin, so it stays equippable forever, even after the window closes). After
    // claimEnd the grant path simply stops firing, so the cosmetic can never be obtained
    // again — a true "founder" badge. To add a FUTURE season: append another entry with its
    // own id + window (no schema/migration change needed). Times are ISO-8601 UTC; keep these
    // IN LOCKSTEP with client/scripts/skinRegistry.js. ---
    { id: 'founders_flare', slot: 'trail', unlock: { kind: 'seasonal', season: 'early_adopter_2026', label: 'Early Adopter', claimStart: '2026-06-01T00:00:00Z', claimEnd: '2026-08-01T00:00:00Z' } },
    // --- Borders (rim cosmetic; SHARE the 2nd slot with patterns). border_-prefixed ids
    // (flames/scales/electric collide with pattern ids). All kind:'open' for testing. ---
    { id: 'border_ring', slot: 'border', unlock: { kind: 'level', level: 10 } },
    { id: 'border_double', slot: 'border', unlock: { kind: 'level', level: 22 } },
    { id: 'border_studs', slot: 'border', unlock: { kind: 'level', level: 64 } },
    { id: 'border_chevrons', slot: 'border', unlock: { kind: 'level', level: 52 } },
    { id: 'border_dashed', slot: 'border', unlock: { kind: 'level', level: 46 } },
    { id: 'border_ticks', slot: 'border', unlock: { kind: 'level', level: 34 } },
    { id: 'border_scales', slot: 'border', unlock: { kind: 'level', level: 76 } },
    { id: 'border_glow', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_spikes', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_gear', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_sawblade', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_runes', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_flames', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_electric', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_orbit', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_laurel', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_crown', slot: 'border', unlock: { kind: 'achievement' } },
    { id: 'border_plasma', slot: 'border', unlock: { kind: 'achievement' } }
];

var byId = {};
for (var i = 0; i < SKINS.length; i++) {
    byId[SKINS[i].id] = SKINS[i];
}

function getSkin(id) {
    return byId[id] || null;
}

// The slot an id belongs to ('cart' | 'pattern' | 'trail'), or null for unknown ids.
function getSkinSlot(id) {
    var s = byId[id];
    return s ? s.slot : null;
}

// Level-gated cosmetic ids (any slot) that become equippable when a player crosses from
// oldLevel to newLevel (oldLevel < unlock.level <= newLevel). Drives the "new X unlocked"
// lobby toast. Achievement cosmetics unlock by medal threshold, handled separately.
function levelSkinsUnlockedBetween(oldLevel, newLevel) {
    var out = [];
    for (var i = 0; i < SKINS.length; i++) {
        var s = SKINS[i];
        if (s.unlock.kind === 'level' && s.unlock.level > oldLevel && s.unlock.level <= newLevel) {
            out.push(s.id);
        }
    }
    return out;
}

// The NEXT level-gated cosmetic above `level` (lowest unlock.level > level), or null at
// the top of the ladder. Drives the "next unlock" teaser in the progression payload —
// the single biggest "one more match" pull, so the client always knows what's coming.
function nextLevelSkin(level) {
    var best = null;
    for (var i = 0; i < SKINS.length; i++) {
        var s = SKINS[i];
        if (s.unlock.kind !== 'level' || s.unlock.level <= level) { continue; }
        if (!best || s.unlock.level < best.unlock.level) { best = s; }
    }
    return best ? { id: best.id, level: best.unlock.level } : null;
}

// True if `unlock` is a seasonal-claim rule whose window is currently open (claimStart <=
// now < claimEnd). Missing/invalid bounds read as closed so a malformed entry can't grant
// forever. `now` is epoch ms (pass Date.now()); injected so callers/tests stay deterministic.
function isClaimWindowOpen(unlock, now) {
    if (!unlock || unlock.kind !== 'seasonal') { return false; }
    var start = Date.parse(unlock.claimStart);
    var end = Date.parse(unlock.claimEnd);
    if (isNaN(start) || isNaN(end)) { return false; }
    return now >= start && now < end;
}

// Every seasonal cosmetic id whose claim window is open right now — the set a signing-in
// player should be granted (the grant path then skips any already owned). Empty outside any
// window. Drives auth.grantSeasonalClaims; future seasons are picked up automatically.
function currentSeasonalClaims(now) {
    var out = [];
    for (var i = 0; i < SKINS.length; i++) {
        if (isClaimWindowOpen(SKINS[i].unlock, now)) { out.push(SKINS[i].id); }
    }
    return out;
}

module.exports = {
    SLOTS: SLOTS,
    SLOT_FIELD: SLOT_FIELD,
    SKINS: SKINS,
    getSkin: getSkin,
    getSkinSlot: getSkinSlot,
    levelSkinsUnlockedBetween: levelSkinsUnlockedBetween,
    nextLevelSkin: nextLevelSkin,
    isClaimWindowOpen: isClaimWindowOpen,
    currentSeasonalClaims: currentSeasonalClaims
};
