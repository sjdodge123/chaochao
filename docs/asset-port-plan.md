# Asset-port plan — trails + patterns + borders (2026-05-30)

Three approved asset sessions to wire into the game. Carts are already ported. This plan
covers wiring all three; **unlock/ladder slotting is deferred** — new items register as
`pool` (hidden, not equippable) until the operator slots them, with a dev toggle to reveal
them for playtest. Source-of-truth files in `docs/asset-prototypes/`.

## Key cross-cutting decisions
- **Borders slot model:** 4th independent slot (cart/pattern/trail/**border**) — RECOMMENDED
  — vs. replacing the pattern slot. Operator just approved BOTH 17 patterns (scoped to the
  sphere cart) and 18 borders, so keeping both = 4th slot. (Pending operator sign-off.)
- **ID collision:** border ids `flames`/`scales`/`electric` duplicate pattern ids. Registry
  is a flat id→entry map → border ids get a `border_` prefix (stored/serialized id; display
  name unchanged). Painter fn names (drawXxxBorder vs drawXxxPattern) already differ.
- **Unlock strategy:** register all new trails/patterns/borders (+ the 39 pool carts) as
  `unlock.kind:'pool'` (hidden from lobby, server-rejected). Add a dev reveal (`?unlockall=1`
  or localStorage) so the operator can equip + playtest everything before committing the
  ladder. Real Lv/achievement slotting is a later operator pass.

## Phase T — Trails (independent; no slot decision needed)
1. Copy `trail-effects.js` → `client/scripts/trailEffects.js`.
2. Add to `build.js` play bundle list + a `<script>` in play.html BUILD block, BEFORE draw.js.
3. `drawTrail` (draw.js): add `TRAIL_FX` dispatch map; when `!dashed && trailEffect`, set
   `tfxBaseAlpha` for non-local dimming, call `TRAIL_FX[fx](gameContext, verts, color, now,
   fadeMs, cartSkinAnimTime*1000)`, then `restore()`+`return`. Keep near-victory dashing.
   Delete the obsolete lightweight per-effect stroke tweaks I added earlier.
4. Registry: add 10 new trail ids (ribbon, bolt→"Lightning", hearts, smoke, confetti,
   snow→"Crystals", tracks→"Tire Tracks", notes→"Music Notes", neon→"Neon Wall", ripple→
   "Ripples"), client + server, as `pool`.
5. CHANGELOG `## Unreleased` bullet (draw.js = game-mechanic file).

## Phase P — Patterns (independent)
1. draw.js: replace the 7 placeholder `drawXxxPattern` stubs with approved versions; add 10
   new painters (carbon, camo, hazard, circuit, scales, electric, tiger, waves, honeycomb,
   splatter) + helpers (srnd, flameTongue, nebStars+_nebStars cache, sparkle, bonePath,
   tigerStripe, hexPath). `cartSkinShadeA` already present.
2. Per-pattern opacity: add an `opacity` field to pattern registry entries (from
   `PATTERN_DEFS`: 0.6 opaque set, 1 see-through + badges); `drawPatternOverlay` sets
   `ctx.globalAlpha` from it before invoking the painter. Painters unchanged.
3. Registry: 7 existing entries already point at the painter names (just upgraded). Add the
   10 new patterns (client+server) as `pool`, each with its `opacity`.
4. Inline each `P("key", default)` shim to its literal default when porting.
5. CHANGELOG bullet.

## Phase B — Borders (after slot-model sign-off; 4th-slot path below)
1. Schema: new timestamp migration `<ts>_cosmetics_border.sql` adding `selected_border` text
   col; apply to dev via MCP; hand operator the prod one-liner + the `migration repair` version
   (per docs/db-migrations.md). 
2. Player state + network: `player.border` (server) + decode; compressor `packet[16]`
   (cart/pattern already ride packets [13]/[14]/trail-fx[15], so border is static-per-player
   on the same path) + client gameboard decoder in lockstep.
3. Server: `COSMETIC_SLOT_FIELD.border='border'`, `auth.saveCosmetic` col map, restore-on-load,
   `setCosmetic` slot allow-list, server skinRegistry border entries.
4. Client registry: `border` slot, 18 entries (ids `border_*` to dodge the collision), painter
   refs; `getSkinsForSlot('border')`.
5. draw.js: port 18 `drawXxxBorder` painters; add `drawBorderOverlay(player,cx,cy,r,painter)`
   (same transform as drawCartSkin but NO interior clip — borders draw r≈1.0–1.4); call it
   AFTER cart+pattern in every kart path (live drawPlayer, overview drawPlayerIcon, recap
   recapDrawCar; lava-burn rides live). Bake tuned param defaults as constants.
6. Lobby: 5th group "Borders" in lobbyHub (COSMETIC_GROUPS + COSMETIC_SLOT_DEFAULT_NAME +
   COSMETIC_SLOT_FIELD + COSMETIC_GROUP_LABEL + localStorage re-equip). Pad-navigable.
7. CHANGELOG bullet.

## Verification (each phase)
`npm run build` + `node .github/scripts/smoke-test.js` + `progression-test.js` green; host a
dev server on a fresh free port (print localhost + LAN IP) for in-browser playtest. No
commit/push/PR without operator go-ahead; rebase onto origin/main before any PR.

## Sequencing
T and P are independent of the borders decision and can land first. B waits on the slot-model
sign-off (it's the only one touching schema/compressor/lobby-structure).
