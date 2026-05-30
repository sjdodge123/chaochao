# Asset-design session: CART shapes

Paste this into a fresh Claude Code session to design the new cart bodies. This is an
ISOLATED art session — build a standalone prototype, iterate on the look, do NOT wire
anything into the game. The main cosmetics session ports approved painters afterward.

---

You're running an isolated asset-design session for the chaochao cosmetics rework. Work
on the `worktree-progression-system` branch
(`/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/progression-system`).
Read `docs/cosmetics-ladder.md` for the locked design. Do NOT touch the game registries
or draw.js — your only output is a prototype + approved painter functions.

**Goal:** design 4 new procedural cart-body painters:

1. `hoverbike` — **Hoverbike** (Lv24, epic, cosmic): sleek single-rider hover-bike
   silhouette, low and elongated, subtle thruster glow. Cosmic/sci-fi vibe.
2. `starfighter` — **Starfighter** (Lv30, legendary, cosmic capstone): swept-wing space
   fighter, the flashiest body in the set, engine glow/animated.
3. `golden_champion` — **Golden Champion** (achievement, cart): gilded/prestige body —
   ornate, premium gold accents. (Tints to player color but reads as "champion".)
4. `warlord` — **Warlord** (achievement, cart): armored / battle-scarred heavy body,
   plating, aggressive.

**Painter contract** (match the real ones in `client/scripts/draw.js`, lines ~481–684):

```js
function drawHoverbikeSkin(ctx, anim, paint) { /* ... */ }
```

- Normalized space: `radius == 1`, the kart is drawn in a unit circle. Forward = **+X**
  (head points toward positive X). The integrator does translate/rotate/scale.
- `anim` is a rolling animation time (wheels spin, thrusters pulse). `paint` is the
  player's CSS color string — the body MUST tint to `paint`. Use the existing helper
  `cartSkinShade(paint, amount)` (negative = darker outline) for hue-consistent shading.
- Study `drawTruckSkin`/`drawDinoSkin`/`drawFiretruckSkin` for style + the
  `cartRoundRectPath`, `drawSkinCar`, `cartFillBody` helpers. Copy minimal versions of
  the helpers into the prototype so it runs standalone.

**Prototype:** create `docs/asset-prototypes/carts.html` — a single self-contained file:

- A `<canvas>` rendering ALL 4 new carts side-by-side (plus the 3 existing ones for
  style reference), each in its own cell, large, animated (requestAnimationFrame driving
  `anim`), rotating slowly so the operator sees them from a moving angle.
- A row of color swatches (the game's player palette is fine, plus a custom picker) that
  re-tints every cart live, to confirm they read across colors.
- A few sliders for per-cart params worth tuning (e.g. body length, glow intensity).
- No build step, no game imports — pure inline `<script>`.

Iterate with the operator IN the prototype until they approve each cart. Then leave the
approved `drawXxxSkin(ctx, anim, paint)` functions in the HTML (and/or a
`docs/asset-prototypes/carts.painters.js`) for the main session to port into
`draw.js` + `skinRegistry.js`. Don't edit the game registries yourself.
