// Cosmetics registry — the client's single source of truth for the three composable
// cosmetic slots. id, display name, rarity, slot, unlock rule, and either a procedural
// painter (cart/pattern slots) or a trail-effect id (trail slot). Painters are the
// drawXxx functions in draw.js; they're function declarations (hoisted across the
// concatenated bundle, and draw.js is bundled BEFORE this file), so referencing them in
// this array literal is safe.
//
// THREE independent slots, all composable + all compatible with the player's color:
//   'cart'    — body SHAPE; painter tints the silhouette to the player's color.
//   'pattern' — texture OVERLAY painted on the body; painter tints to the player's color.
//   'trail'   — motion-trail EFFECT; rendered in the player's color (no painter — draw.js
//               drawTrail switches on the effect id). What varies is shape/effect, never color.
//
// Unlock rules MUST stay in lockstep with server/skinRegistry.js (same ids, same slots,
// same unlocks). The server is authoritative; this registry drives rendering + the lobby
// lock UI only. Ladder + thresholds: docs/cosmetics-ladder.md. ids are stable storage keys.
var SKINS = [
    // --- Carts (body shape; painter tints to player color) ---
    { id: 'firetruck', name: 'Drone', slot: 'cart', rarity: 'uncommon', unlock: { kind: 'level', level: 12 }, painter: drawFiretruckSkin },
    { id: 'dino', name: 'Dino', slot: 'cart', rarity: 'rare', unlock: { kind: 'level', level: 18 }, painter: drawDinoSkin },
    { id: 'hoverbike', name: 'Hoverbike', slot: 'cart', rarity: 'epic', unlock: { kind: 'level', level: 24 }, painter: drawHoverbikeSkin },
    { id: 'starfighter', name: 'Starfighter', slot: 'cart', rarity: 'legendary', unlock: { kind: 'level', level: 30 }, painter: drawStarfighterSkin },
    { id: 'golden_champion', name: 'Golden Champion', slot: 'cart', rarity: 'legendary', unlock: { kind: 'achievement' }, painter: drawGoldenChampionSkin, statue: true, tracksHeading: true },
    { id: 'warlord', name: 'Warlord', slot: 'cart', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawWarlordSkin },
    // --- Cart POOL: approved novelty bodies from the carts asset-design session (painters
    // ported + statue/heading/stateful flags carried). kind:'open' = unlock-all-for-testing
    // (shown + equippable now); the operator re-gates these to real Lv/achievement homes
    // before ship. statue/tracksHeading/stateful flags drive drawCartSkin. ---
    { id: 'pizza', name: 'Pizza Pie', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawPizzaSkin },
    { id: 'earth', name: 'Planet Earth', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawEarthSkin, statue: true },
    { id: 'smiley', name: 'Smiley', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawSmileySkin, statue: true },
    { id: 'eight_ball', name: 'Magic 8-Ball', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawEightBallSkin, statue: true, stateful: true },
    { id: 'saw_blade', name: 'Saw Blade', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawSawBladeSkin },
    { id: 'donut', name: 'Donut', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawDonutSkin },
    { id: 'vinyl', name: 'Vinyl Record', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawVinylSkin, statue: true },
    { id: 'compass', name: 'Compass', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawCompassSkin, statue: true, tracksHeading: true },
    { id: 'wheel_of_fortune', name: 'Wheel of Fortune', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawWheelSkin, statue: true, stateful: true },
    { id: 'clock', name: 'Clock', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawClockSkin, statue: true },
    { id: 'eyeball', name: 'Googly Eyeball', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawEyeballSkin, statue: true, tracksHeading: true },
    { id: 'disco_ball', name: 'Disco Ball', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawDiscoSkin, statue: true },
    { id: 'hypno', name: 'Hypno-Spiral', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawHypnoSkin, statue: true },
    { id: 'cookie', name: 'Cookie', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawCookieSkin },
    { id: 'beach_ball', name: 'Beach Ball', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawBeachballSkin },
    { id: 'sun', name: 'Sun', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawSunSkin, statue: true },
    { id: 'shuriken', name: 'Shuriken', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawShurikenSkin },
    { id: 'dartboard', name: 'Dartboard', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawDartboardSkin, statue: true },
    { id: 'soccer_ball', name: 'Soccer Ball', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawSoccerSkin },
    { id: 'basketball', name: 'Basketball', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawBasketballSkin },
    { id: 'yin_yang', name: 'Yin-Yang', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawYinYangSkin, statue: true },
    { id: 'ferris_wheel', name: 'Ferris Wheel', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawFerrisSkin, statue: true },
    { id: 'pinwheel', name: 'Pinwheel', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawPinwheelSkin },
    { id: 'watermelon', name: 'Watermelon', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawWatermelonSkin },
    { id: 'tire', name: 'Tire', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawTireSkin },
    { id: 'gear', name: 'Gear', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawGearSkin },
    { id: 'galaxy', name: 'Spiral Galaxy', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawGalaxySkin, statue: true },
    { id: 'snowflake', name: 'Snowflake', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawSnowflakeSkin, statue: true },
    { id: 'flower', name: 'Flower', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawFlowerSkin, statue: true },
    { id: 'coin', name: 'Gold Coin', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawCoinSkin, statue: true },
    { id: 'helm', name: 'Ship\'s Helm', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawHelmSkin },
    { id: 'aperture', name: 'Camera Aperture', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawApertureSkin, statue: true },
    { id: 'cheese', name: 'Cheese Wheel', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawCheeseSkin },
    { id: 'citrus', name: 'Citrus Slice', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawCitrusSkin },
    { id: 'turtle', name: 'Turtle Shell', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawTurtleSkin },
    { id: 'pumpkin', name: 'Jack-o\'-Lantern', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawPumpkinSkin, statue: true },
    { id: 'moon', name: 'Moon', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawMoonSkin, statue: true },
    { id: 'ok_hand', name: 'OK Hand', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawOkSkin, statue: true },
    { id: 'mouse', name: 'Mouse', slot: 'cart', rarity: 'common', unlock: { kind: 'open' }, painter: drawMouseSkin },
    // --- Patterns (texture overlay; painter tints to player color) ---
    { id: 'stripes', name: 'Racing Stripes', slot: 'pattern', rarity: 'common', unlock: { kind: 'level', level: 2 }, painter: drawStripesPattern },
    { id: 'polka', name: 'Polka', slot: 'pattern', rarity: 'uncommon', unlock: { kind: 'level', level: 8 }, painter: drawPolkaPattern },
    { id: 'checkered', name: 'Checkered', slot: 'pattern', rarity: 'rare', unlock: { kind: 'level', level: 14 }, painter: drawCheckeredPattern },
    { id: 'flames', name: 'Flames', slot: 'pattern', rarity: 'epic', unlock: { kind: 'level', level: 20 }, painter: drawFlamesPattern },
    { id: 'nebula', name: 'Nebula', slot: 'pattern', rarity: 'epic', unlock: { kind: 'level', level: 26 }, painter: drawNebulaPattern },
    { id: 'executioner', name: 'Executioner', slot: 'pattern', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawExecutionerPattern },
    { id: 'punching_bag', name: 'Punching Bag', slot: 'pattern', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawPunchingBagPattern },
    // --- Trails (motion-trail effect; rendered in player color via drawTrail switch) ---
    { id: 'dashes', name: 'Dashes', slot: 'trail', rarity: 'common', unlock: { kind: 'level', level: 4 }, effect: 'dashes' },
    { id: 'sparkle', name: 'Sparkle', slot: 'trail', rarity: 'uncommon', unlock: { kind: 'level', level: 10 }, effect: 'sparkle' },
    { id: 'comet', name: 'Comet', slot: 'trail', rarity: 'rare', unlock: { kind: 'level', level: 16 }, effect: 'comet' },
    { id: 'bubbles', name: 'Bubbles', slot: 'trail', rarity: 'epic', unlock: { kind: 'level', level: 22 }, effect: 'bubbles' },
    { id: 'aurora', name: 'Aurora', slot: 'trail', rarity: 'legendary', unlock: { kind: 'level', level: 28 }, effect: 'aurora' },
    { id: 'guardian', name: 'Guardian', slot: 'trail', rarity: 'epic', unlock: { kind: 'achievement' }, effect: 'guardian' },
    { id: 'survivor', name: 'Survivor', slot: 'trail', rarity: 'rare', unlock: { kind: 'achievement' }, effect: 'survivor' },
    // --- New trails (asset session 2026-05-30); 'open' = unlock-all-for-testing ---
    { id: 'ribbon', name: 'Ribbon', slot: 'trail', rarity: 'epic', unlock: { kind: 'open' }, effect: 'ribbon' },
    { id: 'bolt', name: 'Lightning', slot: 'trail', rarity: 'epic', unlock: { kind: 'open' }, effect: 'bolt' },
    { id: 'hearts', name: 'Hearts', slot: 'trail', rarity: 'uncommon', unlock: { kind: 'open' }, effect: 'hearts' },
    { id: 'smoke', name: 'Smoke', slot: 'trail', rarity: 'common', unlock: { kind: 'open' }, effect: 'smoke' },
    { id: 'confetti', name: 'Confetti', slot: 'trail', rarity: 'rare', unlock: { kind: 'open' }, effect: 'confetti' },
    { id: 'snow', name: 'Crystals', slot: 'trail', rarity: 'rare', unlock: { kind: 'open' }, effect: 'snow' },
    { id: 'tracks', name: 'Tire Tracks', slot: 'trail', rarity: 'common', unlock: { kind: 'open' }, effect: 'tracks' },
    { id: 'notes', name: 'Music Notes', slot: 'trail', rarity: 'uncommon', unlock: { kind: 'open' }, effect: 'notes' },
    { id: 'neon', name: 'Neon Wall', slot: 'trail', rarity: 'epic', unlock: { kind: 'open' }, effect: 'neon' },
    { id: 'ripple', name: 'Ripples', slot: 'trail', rarity: 'rare', unlock: { kind: 'open' }, effect: 'ripple' },
    // --- New trails (asset session 2026-05-30); 'open' = unlock-all-for-testing ---
    { id: 'ribbon', name: 'Ribbon', slot: 'trail', rarity: 'epic', unlock: { kind: 'open' }, effect: 'ribbon' },
    { id: 'bolt', name: 'Lightning', slot: 'trail', rarity: 'epic', unlock: { kind: 'open' }, effect: 'bolt' },
    { id: 'hearts', name: 'Hearts', slot: 'trail', rarity: 'uncommon', unlock: { kind: 'open' }, effect: 'hearts' },
    { id: 'smoke', name: 'Smoke', slot: 'trail', rarity: 'common', unlock: { kind: 'open' }, effect: 'smoke' },
    { id: 'confetti', name: 'Confetti', slot: 'trail', rarity: 'rare', unlock: { kind: 'open' }, effect: 'confetti' },
    { id: 'snow', name: 'Crystals', slot: 'trail', rarity: 'rare', unlock: { kind: 'open' }, effect: 'snow' },
    { id: 'tracks', name: 'Tire Tracks', slot: 'trail', rarity: 'common', unlock: { kind: 'open' }, effect: 'tracks' },
    { id: 'notes', name: 'Music Notes', slot: 'trail', rarity: 'uncommon', unlock: { kind: 'open' }, effect: 'notes' },
    { id: 'neon', name: 'Neon Wall', slot: 'trail', rarity: 'epic', unlock: { kind: 'open' }, effect: 'neon' },
    { id: 'ripple', name: 'Ripples', slot: 'trail', rarity: 'rare', unlock: { kind: 'open' }, effect: 'ripple' }
];

// The default (always-equipped, slot-empty) option shown first in each lobby group.
var COSMETIC_SLOTS = ['cart', 'pattern', 'trail'];
var COSMETIC_SLOT_DEFAULT_NAME = { cart: 'Plain', pattern: 'None', trail: 'Basic' };
// Maps a cosmetic slot to the player-object field that holds its equipped id. `trail` uses
// `trailFx` (the effect id) so it never collides with `player.trail` (the motion object).
// Mirrors COSMETIC_SLOT_FIELD on the server (messenger.js).
var COSMETIC_SLOT_FIELD = { cart: 'cart', pattern: 'pattern', trail: 'trailFx' };

var SKINS_BY_ID = {};
for (var _skinIdx = 0; _skinIdx < SKINS.length; _skinIdx++) {
    SKINS_BY_ID[SKINS[_skinIdx].id] = SKINS[_skinIdx];
}

function getSkin(id) {
    return SKINS_BY_ID[id] || null;
}
function getSkinSlot(id) {
    var s = getSkin(id);
    return s ? s.slot : null;
}
// Cart/pattern painter for an id (null for trail ids or unknown ids — trails render via
// the drawTrail effect switch, not a painter).
function getSkinPainter(id) {
    var s = getSkin(id);
    return (s && s.painter) ? s.painter : null;
}
// Trail-effect id for a trail cosmetic (null for non-trail/unknown ids).
function getTrailEffect(id) {
    var s = getSkin(id);
    return (s && s.effect) ? s.effect : null;
}
// Every LADDER unlockable in a slot, ladder order (the lobby prepends the slot default).
// Pool items (unlock.kind === 'pool' — approved-but-not-yet-slotted cart bodies) are hidden
// here so the lobby shows only the laddered cosmetics; they stay resolvable via getSkin.
function getSkinsForSlot(slot) {
    var out = [];
    for (var i = 0; i < SKINS.length; i++) {
        if (SKINS[i].slot === slot && SKINS[i].unlock.kind !== 'pool') { out.push(SKINS[i]); }
    }
    return out;
}
function skinDisplayName(id) {
    var s = getSkin(id);
    return s ? s.name : id;
}
