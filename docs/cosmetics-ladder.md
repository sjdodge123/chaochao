# Cosmetics ladder — LOCKED design (Lv1–30 starting range)

Approved by operator 2026-05-29. This is the source of truth the system + asset
sessions build against. The every-2-levels cycle is **pattern → trail → cart**.
Lv30 is the *starting* depth, NOT the final cap — the cadence continues past it in
a later batch, so leave the registries open-ended.

Three independent equip slots: **cart** (shape, tints to player color), **pattern**
(texture, tints to player color), **trail** (effect/shape, ALWAYS rendered in player
color). All three composable + all compatible with the per-match color pick.

## Level ladder (Lv2–30 = 15 unlocks, 5 per slot)

| Lv | Slot | Item id | Display | Rarity | Art status |
|----|------|---------|---------|--------|-----------|
| 1 | — | (defaults) | Plain cart / No pattern / Basic trail | — | exists |
| 2 | pattern | `stripes` | Racing Stripes | common | rework painter → tint to color |
| 4 | trail | `dashes` | Dashes | common | new effect |
| 6 | cart | `crimson` | Truck | common | exists (tints) |
| 8 | pattern | `polka` | Polka | uncommon | rework (was Bubblegum) → tint |
| 10 | trail | `sparkle` | Sparkle | uncommon | new effect |
| 12 | cart | `firetruck` | Drone | uncommon | exists (tints) |
| 14 | pattern | `checkered` | Checkered | rare | rework → tint (color + black squares) |
| 16 | trail | `comet` | Comet | rare | new effect |
| 18 | cart | `dino` | Dino | rare | exists (tints) |
| 20 | pattern | `flames` | Flames | epic | rework (was Sunset) → hue ramp in color |
| 22 | trail | `bubbles` | Bubbles | epic | new effect |
| 24 | cart | `hoverbike` | Hoverbike | epic | **NEW shape** (cosmic) |
| 26 | pattern | `nebula` | Nebula | epic | **NEW** (cosmic starfield, tinted) |
| 28 | trail | `aurora` | Aurora | legendary | new effect (ribbon glow) |
| 30 | cart | `starfighter` | Starfighter | legendary | **NEW shape** (cosmic) |

## Achievement items (assigned to slots, 2 per slot)

Thresholds raised + scaled per-achievement (rare = 50, mid = 75, common = 100).

| Item id | Display | Slot | Stat | Threshold (was) |
|---------|---------|------|------|-----------------|
| `golden_champion` | Golden Champion | cart | wins | **50** (25) |
| `warlord` | Warlord | cart | brutalist | **75** (10) |
| `executioner` | Executioner | pattern | mostKills | **75** (10) |
| `punching_bag` | Punching Bag | pattern | mostMurdered | **100** (10) |
| `guardian` | Guardian | trail | savior | **100** (10) |
| `survivor` | Survivor | trail | survivalist | **100** (15) |

Achievement art themes: Golden Champion = gilded/prestige body; Warlord =
armored/battle-scarred body; Executioner = skull/bone motif (tinted); Punching Bag =
target/bruise motif (tinted); Guardian = protective halo glow trail; Survivor =
ember/phoenix-persistence trail.

## Resulting per-slot rosters (default + level + achievement)

- **Carts** (8): Plain · Truck(6) · Drone(12) · Dino(18) · Hoverbike(24) ·
  Starfighter(30) · Golden Champion(ach) · Warlord(ach).
  New painters needed: Hoverbike, Starfighter, Golden Champion, Warlord. (Truck/
  Drone/Dino already exist + tint.)
- **Patterns** (8): None · Stripes(2) · Polka(8) · Checkered(14) · Flames(20) ·
  Nebula(26) · Executioner(ach) · Punching Bag(ach). ALL must tint to player color.
  Stripes/Polka/Checkered/Flames are reworks of today's Sunset/Bubblegum/Checkered
  painters (which currently ignore `paint`); Nebula/Executioner/Punching Bag are new.
- **Trails** (8): Basic · Dashes(4) · Sparkle(10) · Comet(16) · Bubbles(22) ·
  Aurora(28) · Guardian(ach) · Survivor(ach). ALL render in `player.color`; only the
  effect/shape varies. All 7 non-default effects are new.

## Painter contract (what asset sessions produce)

- Cart + pattern painters: `drawXxxSkin(ctx, anim, paint)` where `paint` = the
  player's CSS color string. Cart painters draw the body silhouette tinted to paint;
  pattern painters draw a texture overlay in the paint hue family (NO fixed schemes).
- Trail effects render in `player.color`; the registry entry selects the effect, not
  a color. (Replaces today's per-skin `getSkinTrailColor` override.)

Asset sessions iterate each batch in a standalone `docs/asset-prototypes/<batch>.html`
(canvas, animated, live color + param controls), then the approved painters get ported
into `client/scripts/skinRegistry.js` / `draw.js` and the trail-effect switch.
