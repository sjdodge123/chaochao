# Borders — APPROVED handoff (for the main session to port)

Operator approved **all 18** border variants on 2026-05-30. This file is the
contract for porting them into the game. The asset session does **not** touch
`draw.js` or the registries — that's this handoff's job, in the main session.

## What's approved & where it lives

- **Painters (source of truth):** `docs/asset-prototypes/borders.painters.js` —
  18 `drawXxxBorder(ctx, anim, paint)` functions, port-ready and perf-audited
  (see "Perf" below). The same functions are inlined in `borders.html` (the
  standalone visual prototype); the `.js` file is the one to port from.
- **Prototype:** `docs/asset-prototypes/borders.html` — live color swatches,
  per-border param sliders, dual backdrops (plain sphere + detailed truck), a
  draw-loop CPU meter and a Stress ×N slider.

## Painter contract (identical to cart/pattern painters)

```js
function drawRingBorder(ctx, anim, paint) { /* ... */ }
```
- Normalized space: `radius == 1` == kart rim, forward = `+X`. The integrator
  does translate/rotate/scale (same as `drawCartSkin` in `draw.js`).
- Draw **around/outside** the rim (`~1.0` … `~1.4`). **Never** fill the interior
  (`r < ~0.9`) — that's the cart skin's space; keeping it clear is the point, so
  a border composes over ANY cart (incl. the plain colored sphere) without
  hiding its detail.
- `paint` = the player's CSS color string; the border MUST tint to it. Use
  `cartSkinShade(paint, amt)` (already in `draw.js`) for in-hue accents.
- `anim` = rolling animation time (spins dashes/gear/saw/orbit, pulses
  glow/runes, crackles electric, flickers flames).

## The 18 borders (id → display → suggested rarity)

| # | id | Display | Suggested rarity | Animated |
|---|------|---------|------------------|----------|
| 1 | `ring` | Ring | common | — |
| 2 | `double` | Double | common | — |
| 3 | `studs` | Studs | common | — |
| 4 | `chevrons` | Chevrons | common | drift |
| 5 | `dashed` | Dashed | uncommon | spin |
| 6 | `ticks` | Ticks | uncommon | — |
| 7 | `scales` | Scales | uncommon | — |
| 8 | `glow` | Glow | uncommon | pulse |
| 9 | `spikes` | Spikes | rare | — |
| 10 | `gear` | Gear | rare | spin |
| 11 | `sawblade` | Sawblade | rare | spin (fast) |
| 12 | `runes` | Runes | epic | pulse |
| 13 | `flames` | Flames | epic | flicker |
| 14 | `electric` | Electric | epic | crackle |
| 15 | `orbit` | Orbit | epic | orbit |
| 16 | `laurel` | Laurel | legendary | — |
| 17 | `crown` | Crown | legendary | — |
| 18 | `plasma` | Plasma | legendary | wave |

Rarities above are a **recommendation** for whoever slots them onto a level/
achievement ladder — not locked. The painters themselves carry no rarity.

## Tunable params

Each border reads a few values from a `P` object in the prototype
(`ringThickness`, `studCount`, `dashCount`, `glowRadius`, `spikeLen`,
`spikeCount`, `gearTeeth`, `spinSpeed`). For the game port, bake the
operator-tuned defaults as constants in the painter (the prototype defaults are
already sensible) unless a border is meant to be user-tunable.

## Integration decisions left to the main session

1. **Slot model.** `docs/cosmetics-ladder.md` defines cart/pattern/trail slots.
   Borders are a NEW cosmetic kind. Decide: a 4th independent equip slot, or
   replace the pattern slot (the original border rationale was that full-body
   patterns muddy the shaped carts, whereas a rim border reads cleanly over any
   cart). This is a design/registry call — not part of the approved art.
2. **Ladder placement.** If borders join the every-2-levels cadence, pick which
   subset maps to Lv2–30 and which are achievement rewards. All 18 are approved
   and available to draw from.
3. **Registry + network.** Add a `border` field wherever `cart`/`pattern` are
   selected/serialized (lobby pick UI, player state, compressor lockstep if it
   travels per-tick — likely it's static per-player like cart/pattern, so it
   rides the same join/profile path, not `gameUpdates`). Render by calling the
   border painter right AFTER the cart/pattern painters in the same normalized
   `drawCartSkin` transform.
4. **Render coverage.** Per the skin-render-coverage checklist, make sure the
   border draws in every kart path: live racing, overview scoreboard,
   lava-death/burn, and the game-over recap.

## Perf (already audited — see `bench-borders.js` methodology)

- **Zero** per-element gradient allocations across all 18 (the mobile-GC risk).
  Only `glow` and `plasma` allocate one whole-kart aura gradient per call.
- Same-style elements share one path + one fill/stroke; no per-element
  save/restore; invariant shade strings hoisted.
- Node-measured: a full 18-distinct-border screen ≈ **13 µs** of painter JS per
  frame; worst single painter (`plasma`) ≈ 3.7 µs/call; 16 karts on the priciest
  border ≈ 0.06 ms/frame. Negligible vs a 16.7 ms budget.
- If `plasma` ever needs trimming, drop its `steps` from 56 → ~40.

## Status

- Art: **approved (all 18)**. Painters: **port-ready**.
- NOT yet done (main session): registry/slot wiring, ladder placement, render-
  path coverage, lobby pick UI, CHANGELOG entry on ship.
- Not committed/pushed (operator gate).
