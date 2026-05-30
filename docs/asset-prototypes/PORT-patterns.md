# Pattern painters — APPROVED, ready to port (handoff to main session)

**Status:** Operator-approved 2026-05-30. The asset session is done; the main
session ports these into the game. Do NOT re-derive — the painters are locked.

## What's approved

17 pattern painters, all tinting to the player color (`paint`), in
[`patterns.approved.js`](patterns.approved.js) (self-contained, syntax-checked).
Interactive reference: [`patterns.html`](patterns.html) — live palette, per-pattern
sliders, an opacity slider, and a "body shape" dropdown that composites each
pattern over real carts (Basketball / Earth / 8-Ball).

- **Existing 7** (replace today's stubs in `draw.js`, same names/ids):
  `stripes`, `polka`, `checkered`, `flames`, `nebula`, `executioner`, `punching_bag`.
- **New 10**: `carbon`, `camo`, `hazard`, `circuit`, `scales`, `electric`, `tiger`,
  `waves`, `honeycomb`, `splatter`.

## Operator scope decisions

- Patterns are intended for the **default sphere cart**, not the shaped skins —
  so the shaped-skin coverage concerns from the prototype don't need solving.
- **Main session decides** how the 10 new patterns are surfaced (unlock now / level
  cadence past Lv30 / hold). Not specified by the operator.

## Port checklist (main session)

1. **`draw.js`** — replace the 7 placeholder `drawXxxPattern` stubs with the
   approved versions; add the 10 new painters and their helpers (`srnd`,
   `flameTongue`, `nebStars` + `_nebStars` cache, `sparkle`, `bonePath`,
   `tigerStripe`, `hexPath`). Add `cartSkinShadeA` (rgba twin of `cartSkinShade`)
   if it isn't already present — definition is in `patterns.approved.js`.
2. **Opacity** — the full-repaint ("opaque") patterns are meant to render at
   reduced alpha so the cart shows through. Per-pattern opacity is in
   `PATTERN_DEFS` at the bottom of `patterns.approved.js` (0.6 for the opaque set,
   1 for see-through patterns + achievement badges). Apply it by setting
   `ctx.globalAlpha` in `drawPatternOverlay` from a per-pattern `opacity` field —
   the painters themselves stay unchanged.
3. **`skinRegistry.js`** — the 7 existing entries already point at the painter
   names (no change needed beyond the painters being upgraded). Add registry
   entries for the 10 new patterns per the operator's chosen availability, and add
   an `opacity` field so `drawPatternOverlay` can read it.
4. The `P("key", default)` calls in the approved file are a slider shim that
   returns the approved default — inline each to its literal when porting.

## Injectable prompt for the main session

> Port the approved chaochao pattern painters into the game. They're locked in
> `docs/asset-prototypes/patterns.approved.js` (17 painters, all tint to `paint`)
> with full instructions in `docs/asset-prototypes/PORT-patterns.md`. Replace the
> 7 placeholder `drawXxxPattern` stubs in `client/scripts/draw.js` with the
> approved versions, add the 10 new painters + their helpers (and `cartSkinShadeA`
> if missing), wire per-pattern overlay opacity into `drawPatternOverlay` from a
> registry `opacity` field (values in `PATTERN_DEFS`), and register the 10 new
> patterns in `client/scripts/skinRegistry.js` — you decide their unlock gating
> (operator left it open; patterns are used on the default sphere cart). Then
> verify with the headless smoke test and a quick in-browser check, and add a
> CHANGELOG `## Unreleased` bullet if a game-mechanic file changed.
