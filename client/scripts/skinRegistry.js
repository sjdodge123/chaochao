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
    { id: 'firetruck', name: 'Drone', slot: 'cart', rarity: 'uncommon', unlock: { kind: 'level', level: 58 }, painter: drawFiretruckSkin },
    { id: 'dino', name: 'Dino', slot: 'cart', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawDinoSkin },
    { id: 'hoverbike', name: 'Hoverbike', slot: 'cart', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawHoverbikeSkin },
    { id: 'starfighter', name: 'Starfighter', slot: 'cart', rarity: 'legendary', unlock: { kind: 'achievement' }, painter: drawStarfighterSkin },
    { id: 'golden_champion', name: 'Golden Champion', slot: 'cart', rarity: 'legendary', unlock: { kind: 'achievement' }, painter: drawGoldenChampionSkin, statue: true, tracksHeading: true },
    { id: 'warlord', name: 'Warlord', slot: 'cart', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawWarlordSkin },
    // --- Cart POOL: approved novelty bodies from the carts asset-design session (painters
    // ported + statue/heading/stateful flags carried). kind:'open' = unlock-all-for-testing
    // (shown + equippable now); the operator re-gates these to real Lv/achievement homes
    // before ship. statue/tracksHeading/stateful flags drive drawCartSkin. ---
    { id: 'pizza', name: 'Pizza Pie', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 4 }, painter: drawPizzaSkin },
    { id: 'earth', name: 'Planet Earth', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 62 }, painter: drawEarthSkin, statue: true },
    { id: 'smiley', name: 'Smiley', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 36 }, painter: drawSmileySkin, statue: true },
    { id: 'eight_ball', name: 'Magic 8-Ball', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 40 }, painter: drawEightBallSkin, statue: true, stateful: true },
    { id: 'saw_blade', name: 'Saw Blade', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawSawBladeSkin },
    { id: 'donut', name: 'Donut', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 8 }, painter: drawDonutSkin },
    { id: 'vinyl', name: 'Vinyl Record', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 66 }, painter: drawVinylSkin, statue: true },
    { id: 'compass', name: 'Compass', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 70 }, painter: drawCompassSkin, statue: true, tracksHeading: true },
    { id: 'wheel_of_fortune', name: 'Wheel of Fortune', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawWheelSkin, statue: true, stateful: true },
    { id: 'clock', name: 'Clock', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 74 }, painter: drawClockSkin, statue: true },
    { id: 'eyeball', name: 'Googly Eyeball', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 78 }, painter: drawEyeballSkin, statue: true, tracksHeading: true },
    { id: 'disco_ball', name: 'Disco Ball', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawDiscoSkin, statue: true },
    { id: 'hypno', name: 'Hypno-Spiral', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawHypnoSkin, statue: true },
    { id: 'cookie', name: 'Cookie', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 12 }, painter: drawCookieSkin },
    { id: 'beach_ball', name: 'Beach Ball', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 16 }, painter: drawBeachballSkin },
    { id: 'sun', name: 'Sun', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 90 }, painter: drawSunSkin, statue: true },
    { id: 'shuriken', name: 'Shuriken', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 82 }, painter: drawShurikenSkin },
    { id: 'dartboard', name: 'Dartboard', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 86 }, painter: drawDartboardSkin, statue: true },
    { id: 'soccer_ball', name: 'Soccer Ball', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 20 }, painter: drawSoccerSkin },
    { id: 'basketball', name: 'Basketball', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 24 }, painter: drawBasketballSkin },
    { id: 'yin_yang', name: 'Yin-Yang', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawYinYangSkin, statue: true },
    { id: 'ferris_wheel', name: 'Ferris Wheel', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawFerrisSkin, statue: true },
    { id: 'pinwheel', name: 'Pinwheel', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawPinwheelSkin },
    { id: 'watermelon', name: 'Watermelon', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 28 }, painter: drawWatermelonSkin },
    { id: 'tire', name: 'Tire', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 32 }, painter: drawTireSkin },
    { id: 'gear', name: 'Gear', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawGearSkin },
    { id: 'galaxy', name: 'Spiral Galaxy', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawGalaxySkin, statue: true },
    { id: 'snowflake', name: 'Snowflake', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 96 }, painter: drawSnowflakeSkin, statue: true },
    { id: 'flower', name: 'Flower', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 98 }, painter: drawFlowerSkin, statue: true },
    { id: 'coin', name: 'Gold Coin', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 50 }, painter: drawCoinSkin, statue: true },
    { id: 'helm', name: 'Ship\'s Helm', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawHelmSkin },
    { id: 'aperture', name: 'Camera Aperture', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawApertureSkin, statue: true },
    { id: 'cheese', name: 'Cheese Wheel', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 48 }, painter: drawCheeseSkin },
    { id: 'citrus', name: 'Citrus Slice', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 44 }, painter: drawCitrusSkin },
    { id: 'turtle', name: 'Turtle Shell', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawTurtleSkin },
    { id: 'pumpkin', name: 'Jack-o\'-Lantern', slot: 'cart', rarity: 'common', unlock: { kind: 'achievement' }, painter: drawPumpkinSkin, statue: true },
    { id: 'moon', name: 'Moon', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 94 }, painter: drawMoonSkin, statue: true },
    { id: 'ok_hand', name: 'OK Hand', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 100 }, painter: drawOkSkin, statue: true },
    { id: 'mouse', name: 'Mouse', slot: 'cart', rarity: 'common', unlock: { kind: 'level', level: 54 }, painter: drawMouseSkin },
    // --- Patterns (texture overlay; painter tints to player color) ---
    { id: 'stripes', name: 'Racing Stripes', slot: 'pattern', rarity: 'common', unlock: { kind: 'level', level: 2 }, painter: drawStripesPattern, opacity: 1 },
    { id: 'polka', name: 'Polka', slot: 'pattern', rarity: 'uncommon', unlock: { kind: 'level', level: 56 }, painter: drawPolkaPattern, opacity: 1 },
    { id: 'checkered', name: 'Checkered', slot: 'pattern', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawCheckeredPattern, opacity: 1 },
    { id: 'flames', name: 'Flames', slot: 'pattern', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawFlamesPattern, opacity: 0.6 },
    { id: 'nebula', name: 'Nebula', slot: 'pattern', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawNebulaPattern, opacity: 0.6 },
    { id: 'executioner', name: 'Executioner', slot: 'pattern', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawExecutionerPattern, opacity: 1 },
    { id: 'punching_bag', name: 'Punching Bag', slot: 'pattern', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawPunchingBagPattern, opacity: 1 },
    // --- New patterns (asset session 2026-05-30); 'open' = unlock-all-for-testing. opacity
    // 0.6 = full-repaint (body shows through) per PATTERN_DEFS. ---
    { id: 'carbon', name: 'Carbon Fiber', slot: 'pattern', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawCarbonPattern, opacity: 0.6 },
    { id: 'camo', name: 'Camo', slot: 'pattern', rarity: 'common', unlock: { kind: 'level', level: 68 }, painter: drawCamoPattern, opacity: 0.6 },
    { id: 'hazard', name: 'Hazard', slot: 'pattern', rarity: 'common', unlock: { kind: 'level', level: 14 }, painter: drawHazardPattern, opacity: 0.6 },
    { id: 'circuit', name: 'Circuit', slot: 'pattern', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawCircuitPattern, opacity: 0.6 },
    { id: 'scales', name: 'Scales', slot: 'pattern', rarity: 'rare', unlock: { kind: 'level', level: 80 }, painter: drawScalesPattern, opacity: 0.6 },
    { id: 'electric', name: 'Electric', slot: 'pattern', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawElectricPattern, opacity: 0.6 },
    { id: 'tiger', name: 'Tiger', slot: 'pattern', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawTigerPattern, opacity: 0.6 },
    { id: 'waves', name: 'Waves', slot: 'pattern', rarity: 'common', unlock: { kind: 'level', level: 26 }, painter: drawWavesPattern, opacity: 0.6 },
    { id: 'honeycomb', name: 'Honeycomb', slot: 'pattern', rarity: 'uncommon', unlock: { kind: 'level', level: 88 }, painter: drawHoneycombPattern, opacity: 0.6 },
    { id: 'splatter', name: 'Splatter', slot: 'pattern', rarity: 'uncommon', unlock: { kind: 'level', level: 38 }, painter: drawSplatterPattern, opacity: 1 },
    // --- Trails (motion-trail effect; rendered in player color via drawTrail switch) ---
    { id: 'dashes', name: 'Dashes', slot: 'trail', rarity: 'common', unlock: { kind: 'level', level: 6 }, effect: 'dashes' },
    { id: 'sparkle', name: 'Sparkle', slot: 'trail', rarity: 'uncommon', unlock: { kind: 'level', level: 60 }, effect: 'sparkle' },
    { id: 'comet', name: 'Comet', slot: 'trail', rarity: 'rare', unlock: { kind: 'achievement' }, effect: 'comet' },
    { id: 'bubbles', name: 'Bubbles', slot: 'trail', rarity: 'epic', unlock: { kind: 'achievement' }, effect: 'bubbles' },
    { id: 'aurora', name: 'Aurora', slot: 'trail', rarity: 'legendary', unlock: { kind: 'achievement' }, effect: 'aurora' },
    { id: 'guardian', name: 'Guardian', slot: 'trail', rarity: 'epic', unlock: { kind: 'achievement' }, effect: 'guardian' },
    { id: 'survivor', name: 'Survivor', slot: 'trail', rarity: 'rare', unlock: { kind: 'achievement' }, effect: 'survivor' },
    // --- New trails (asset session 2026-05-30); 'open' = unlock-all-for-testing ---
    { id: 'ribbon', name: 'Ribbon', slot: 'trail', rarity: 'epic', unlock: { kind: 'achievement' }, effect: 'ribbon' },
    { id: 'bolt', name: 'Lightning', slot: 'trail', rarity: 'epic', unlock: { kind: 'achievement' }, effect: 'bolt' },
    { id: 'hearts', name: 'Hearts', slot: 'trail', rarity: 'uncommon', unlock: { kind: 'level', level: 72 }, effect: 'hearts' },
    { id: 'smoke', name: 'Smoke', slot: 'trail', rarity: 'common', unlock: { kind: 'level', level: 18 }, effect: 'smoke' },
    { id: 'confetti', name: 'Confetti', slot: 'trail', rarity: 'rare', unlock: { kind: 'level', level: 84 }, effect: 'confetti' },
    { id: 'snow', name: 'Crystals', slot: 'trail', rarity: 'rare', unlock: { kind: 'level', level: 42 }, effect: 'snow' },
    { id: 'tracks', name: 'Tire Tracks', slot: 'trail', rarity: 'common', unlock: { kind: 'level', level: 30 }, effect: 'tracks' },
    { id: 'notes', name: 'Music Notes', slot: 'trail', rarity: 'uncommon', unlock: { kind: 'level', level: 92 }, effect: 'notes' },
    { id: 'neon', name: 'Neon Wall', slot: 'trail', rarity: 'epic', unlock: { kind: 'achievement' }, effect: 'neon' },
    { id: 'ripple', name: 'Ripples', slot: 'trail', rarity: 'rare', unlock: { kind: 'achievement' }, effect: 'ripple' },
    // --- Seasonal claims (kind:'seasonal') — claimed once on sign-in during the window, then
    // owned forever (in unlocked_skins, like an achievement skin). rarity:'seasonal' draws a
    // distinct gold cell frame in the locker. `unlock.label` is the season's player-facing name,
    // read by the lobby banner + claim toast (so a future season needs NO code edit — just a new
    // entry). The 'founder gold' palette lives in the painter (drawFoundersFlareTrail,
    // trailEffects.js). Keep IN LOCKSTEP with server/skinRegistry.js. ---
    { id: 'founders_flare', name: 'Solar Flare', slot: 'trail', rarity: 'seasonal', unlock: { kind: 'seasonal', season: 'early_adopter_2026', label: 'Early Adopter', claimStart: '2026-06-01T00:00:00Z', claimEnd: '2026-08-01T00:00:00Z' }, effect: 'foundersFlare' },
    // --- Borders (rim cosmetic; painter tints to player color, drawn AROUND the rim). SHARE the
    // 2nd cosmetic slot with patterns (player.pattern field / selected_pattern column) — distinguished
    // by slot:'border'. ids are border_-prefixed because flames/scales/electric collide with pattern
    // ids. All kind:'open' for testing; operator slots them onto the ladder later. (Phase B; ported
    // from docs/asset-prototypes/borders.painters.js, approved 2026-05-30.) ---
    { id: 'border_ring', name: 'Ring', slot: 'border', rarity: 'common', unlock: { kind: 'level', level: 10 }, painter: drawRingBorder },
    { id: 'border_double', name: 'Double', slot: 'border', rarity: 'common', unlock: { kind: 'level', level: 22 }, painter: drawDoubleBorder },
    { id: 'border_studs', name: 'Studs', slot: 'border', rarity: 'common', unlock: { kind: 'level', level: 64 }, painter: drawStudsBorder },
    { id: 'border_chevrons', name: 'Chevrons', slot: 'border', rarity: 'common', unlock: { kind: 'level', level: 52 }, painter: drawChevronsBorder },
    { id: 'border_dashed', name: 'Dashed', slot: 'border', rarity: 'uncommon', unlock: { kind: 'level', level: 46 }, painter: drawDashedBorder },
    { id: 'border_ticks', name: 'Ticks', slot: 'border', rarity: 'uncommon', unlock: { kind: 'level', level: 34 }, painter: drawTicksBorder },
    { id: 'border_scales', name: 'Scales', slot: 'border', rarity: 'uncommon', unlock: { kind: 'level', level: 76 }, painter: drawScalesBorder },
    { id: 'border_glow', name: 'Glow', slot: 'border', rarity: 'uncommon', unlock: { kind: 'achievement' }, painter: drawGlowBorder },
    { id: 'border_spikes', name: 'Spikes', slot: 'border', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawSpikesBorder },
    { id: 'border_gear', name: 'Gear', slot: 'border', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawGearBorder },
    { id: 'border_sawblade', name: 'Sawblade', slot: 'border', rarity: 'rare', unlock: { kind: 'achievement' }, painter: drawSawbladeBorder },
    { id: 'border_runes', name: 'Runes', slot: 'border', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawRunesBorder },
    { id: 'border_flames', name: 'Flames', slot: 'border', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawFlamesBorder },
    { id: 'border_electric', name: 'Electric', slot: 'border', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawElectricBorder },
    { id: 'border_orbit', name: 'Orbit', slot: 'border', rarity: 'epic', unlock: { kind: 'achievement' }, painter: drawOrbitBorder },
    { id: 'border_laurel', name: 'Laurel', slot: 'border', rarity: 'legendary', unlock: { kind: 'achievement' }, painter: drawLaurelBorder },
    { id: 'border_crown', name: 'Crown', slot: 'border', rarity: 'legendary', unlock: { kind: 'achievement' }, painter: drawCrownBorder },
    { id: 'border_plasma', name: 'Plasma', slot: 'border', rarity: 'legendary', unlock: { kind: 'achievement' }, painter: drawPlasmaBorder }
];

// The default (always-equipped, slot-empty) option shown first in each lobby group.
// 'border' SHARES the 2nd slot with 'pattern' (same player.pattern field) — it is listed as a
// distinct slot so it gets its own lobby tab + "None" default, but equipping a border overwrites
// any pattern and vice versa.
var COSMETIC_SLOTS = ['cart', 'pattern', 'trail', 'border'];
var COSMETIC_SLOT_DEFAULT_NAME = { cart: 'Plain', pattern: 'None', trail: 'Basic', border: 'None' };
// Maps a cosmetic slot to the player-object field that holds its equipped id. `trail` uses
// `trailFx` (the effect id) so it never collides with `player.trail` (the motion object).
// `border` is its own independent slot/field. Mirrors COSMETIC_SLOT_FIELD on the
// server (messenger.js).
var COSMETIC_SLOT_FIELD = { cart: 'cart', pattern: 'pattern', trail: 'trailFx', border: 'border' };

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
// True if a seasonal-claim window is open at `now` (epoch ms). Mirrors the server's
// isClaimWindowOpen so the lobby lock UI + claim banner read the SAME rule the server
// grants on. Missing/invalid bounds read as closed.
function isClaimWindowOpen(unlock, now) {
    if (!unlock || unlock.kind !== 'seasonal') { return false; }
    var start = Date.parse(unlock.claimStart);
    var end = Date.parse(unlock.claimEnd);
    if (isNaN(start) || isNaN(end)) { return false; }
    return now >= start && now < end;
}
// Every seasonal cosmetic whose claim window is open right now — mirrors the server's
// currentSeasonalClaims (which GRANTS all of them), so the lobby can reason about more than
// one simultaneously-open season instead of seeing only the first.
function currentSeasonalClaims(now) {
    var out = [];
    for (var i = 0; i < SKINS.length; i++) {
        if (isClaimWindowOpen(SKINS[i].unlock, now)) { out.push(SKINS[i]); }
    }
    return out;
}
// The first seasonal cosmetic whose window is open right now (or null) — convenience for the
// common single-season case. The banner uses the plural form so it can skip already-claimed ones.
function currentSeasonalClaim(now) {
    var open = currentSeasonalClaims(now);
    return open.length ? open[0] : null;
}
