# Asset-design session: BORDERS (rim cosmetic — an alternative to patterns)

EXPLORATORY. We're testing a pivot: a full-body PATTERN competes with the cart skin's own
detail and muddies the shaped karts (Dino/Truck/Drone). A BORDER rings the kart instead of
covering it, so it reads cleanly over ANY cart skin AND the plain sphere. This session
prototypes border looks so the operator can judge before we wire it into the game.

Paste into a fresh Claude Code session. ISOLATED art session — build a standalone
prototype, iterate, do NOT wire into the game or touch the registries.

---

You're running an isolated asset-design session for the chaochao cosmetics rework. Work on
the `worktree-progression-system` branch
(`/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/progression-system`). Read
`docs/cosmetics-ladder.md` for the locked design context. Do NOT touch draw.js or the
registries — your only output is a prototype + approved painter functions.

**The idea:** a BORDER is a decorative cosmetic drawn AROUND the kart's rim (a ring / frame
/ halo / studs / spikes / etc.), NOT over the body — so it never hides the cart skin's
detail. It TINTS to the player's color (the chosen color is the base hue). It composes on
top of whatever cart is equipped, including the plain colored sphere.

**Goal:** design ~8 border variants spanning common → legendary feel, so we can map the best
5 onto the Lv2–30 ladder afterward. Suggested set (refine freely):
1. `ring` — clean solid outline ring (common).
2. `studs` — evenly spaced rivets/bolts around the rim.
3. `dashed` — rotating dashed segments (anim spins them).
4. `glow` — soft pulsing aura/halo just outside the kart.
5. `spikes` — triangular spikes radiating outward.
6. `gear` — mechanical cog-tooth rim that rotates with anim.
7. `electric` — crackling arc segments jumping around the edge.
8. `laurel` — prestige wreath/leaves hugging the lower arc (legendary feel).

**Painter contract** (matches the cart painters in `client/scripts/draw.js` ~line 451):
```js
function drawRingBorder(ctx, anim, paint) { /* ... */ }
```
- Normalized space: `radius == 1`, the kart fills the unit circle; forward = **+X**. The
  integrator does translate/rotate/scale. Draw the border AROUND the rim — at radius ≈ 1.0
  and OUTSIDE it (you may draw out to ~1.4 for spikes/glow/halo). **Do NOT fill the interior
  (radius < ~0.9)** — that's the cart skin's space; keeping it clear is the whole point.
- `paint` = the player's CSS color string — the border MUST tint to it. Use the helper
  `cartSkinShade(paint, amount)` (positive lightens, negative darkens) for in-hue accents.
- `anim` = rolling animation time (spin the dashes/gear, pulse the glow, crackle the arcs).

**Prototype:** create `docs/asset-prototypes/borders.html`, self-contained:
- A `<canvas>` rendering all ~8 borders, each drawn AROUND a sample kart. Show each border
  over MULTIPLE backdrops in its cell or a toggle — at minimum: (a) the plain colored sphere
  and (b) a detailed shaped kart (copy a minimal `drawTruckSkin`/disc from draw.js) — so the
  operator can confirm the border doesn't cover the skin's detail. Animate via
  requestAnimationFrame, rotate the kart slowly.
- A row of color swatches (+ custom picker) that re-tints every border AND the sample karts
  live, to confirm borders read across colors and against a colored body.
- Sliders for per-border params (ring thickness, stud count, glow radius, spike length, spin
  speed).
- No build step, no game imports — pure inline `<script>`.

Iterate with the operator until the look is approved. Then leave the approved
`drawXxxBorder(ctx, anim, paint)` functions in the HTML (and/or
`docs/asset-prototypes/borders.painters.js`) for the main session to port. The main session
will decide slot integration (borders may replace the pattern slot, or become a 4th slot).
Don't edit game registries, and don't commit or push.
