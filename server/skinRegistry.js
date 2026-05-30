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
var SLOTS = ['cart', 'pattern', 'trail'];

var SKINS = [
    // --- Carts (body shape; tints to player colour) ---
    { id: 'firetruck', slot: 'cart', unlock: { kind: 'level', level: 12 } },   // "Drone"
    { id: 'dino', slot: 'cart', unlock: { kind: 'level', level: 18 } },
    { id: 'hoverbike', slot: 'cart', unlock: { kind: 'level', level: 24 } },
    { id: 'starfighter', slot: 'cart', unlock: { kind: 'level', level: 30 } },
    { id: 'golden_champion', slot: 'cart', unlock: { kind: 'achievement' } },
    { id: 'warlord', slot: 'cart', unlock: { kind: 'achievement' } },
    // --- Cart POOL: approved-but-not-yet-slotted novelty bodies. kind:'pool' is NOT an
    // equippable unlock kind (setCosmetic rejects it) — ids live here so validation knows
    // them + so the operator can promote one to a level/achievement unlock in one place. ---
    { id: 'pizza', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'earth', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'smiley', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'eight_ball', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'saw_blade', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'donut', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'vinyl', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'compass', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'wheel_of_fortune', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'clock', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'eyeball', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'disco_ball', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'hypno', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'cookie', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'beach_ball', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'sun', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'shuriken', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'dartboard', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'soccer_ball', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'basketball', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'yin_yang', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'ferris_wheel', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'pinwheel', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'watermelon', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'tire', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'gear', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'galaxy', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'snowflake', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'flower', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'coin', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'helm', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'aperture', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'cheese', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'citrus', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'turtle', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'pumpkin', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'moon', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'ok_hand', slot: 'cart', unlock: { kind: 'open' } },
    { id: 'mouse', slot: 'cart', unlock: { kind: 'open' } },
    // --- Patterns (texture overlay; tints to player colour) ---
    { id: 'stripes', slot: 'pattern', unlock: { kind: 'level', level: 2 } },
    { id: 'polka', slot: 'pattern', unlock: { kind: 'level', level: 8 } },
    { id: 'checkered', slot: 'pattern', unlock: { kind: 'level', level: 14 } },
    { id: 'flames', slot: 'pattern', unlock: { kind: 'level', level: 20 } },
    { id: 'nebula', slot: 'pattern', unlock: { kind: 'level', level: 26 } },
    { id: 'executioner', slot: 'pattern', unlock: { kind: 'achievement' } },
    { id: 'punching_bag', slot: 'pattern', unlock: { kind: 'achievement' } },
    // --- Trails (motion-trail effect; ALWAYS rendered in player colour) ---
    { id: 'dashes', slot: 'trail', unlock: { kind: 'level', level: 4 } },
    { id: 'sparkle', slot: 'trail', unlock: { kind: 'level', level: 10 } },
    { id: 'comet', slot: 'trail', unlock: { kind: 'level', level: 16 } },
    { id: 'bubbles', slot: 'trail', unlock: { kind: 'level', level: 22 } },
    { id: 'aurora', slot: 'trail', unlock: { kind: 'level', level: 28 } },
    { id: 'guardian', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'survivor', slot: 'trail', unlock: { kind: 'achievement' } },
    { id: 'ribbon', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'bolt', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'hearts', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'smoke', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'confetti', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'snow', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'tracks', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'notes', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'neon', slot: 'trail', unlock: { kind: 'open' } },
    { id: 'ripple', slot: 'trail', unlock: { kind: 'open' } }
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

module.exports = {
    SLOTS: SLOTS,
    SKINS: SKINS,
    getSkin: getSkin,
    getSkinSlot: getSkinSlot,
    levelSkinsUnlockedBetween: levelSkinsUnlockedBetween
};
