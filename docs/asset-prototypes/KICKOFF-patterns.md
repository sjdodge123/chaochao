# Asset-design session: PATTERNS (tint to player color)

Paste this into a fresh Claude Code session. ISOLATED art session — build a standalone
prototype, iterate, do NOT wire into the game. The main session ports approved painters.

---

You're running an isolated asset-design session for the chaochao cosmetics rework. Work
on the `worktree-progression-system` branch
(`/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/progression-system`).
Read `docs/cosmetics-ladder.md` for the locked design. Do NOT touch the game registries
or draw.js — your only output is a prototype + approved painter functions.

**Key rule:** in the new model, a PATTERN is a texture overlay drawn ON the cart body,
and **every pattern MUST tint to the player's color** (`paint`). NO fixed color schemes.
The chosen color is the base; the pattern is the texture/accent in that hue family.
(Today's `drawSunsetSkin`/`drawBubblegumSkin`/`drawCheckeredSkin` in draw.js ignore
`paint` — that's exactly what we're fixing.)

**Goal:** design 7 pattern painters, all tinting to `paint`:

1. `stripes` — **Racing Stripes** (Lv2, common): player color base + one or two darker
   offset racing stripes (use `cartSkinShade(paint,-0.4)`).
2. `polka` — **Polka** (Lv8, uncommon): player color base + white/light dots (rework of
   Bubblegum — base must be the player color, not fixed pink).
3. `checkered` — **Checkered** (Lv14, rare): player color + black race squares.
4. `flames` — **Flames** (Lv20, epic): gradient/hue-ramp within the player's hue
   (rework of Sunset — ramp light→dark of `paint`, not fixed orange→magenta).
5. `nebula` — **Nebula** (Lv26, epic, cosmic): starfield/nebula cloud tinted to the
   player hue, with sparkle stars. NEW.
6. `executioner` — **Executioner** (achievement, pattern): skull/bone motif tinted to
   color, menacing.
7. `punching_bag` — **Punching Bag** (achievement, pattern): target/bruise motif tinted
   to color, comedic.

**Painter contract:**

```js
function drawStripesPattern(ctx, anim, paint) { /* fills the body texture */ }
```

- The pattern fills the cart body's normalized interior — approximately the rect
  `[-0.85..0.85] x [-0.6..0.6]` (radius==1 space). The integrator clips it to the
  equipped cart's silhouette, so just paint the full rect; don't draw wheels/windshield.
- `paint` = player CSS color (always present in the prototype). `anim` = rolling time
  for any subtle motion (twinkle, drift).
- For the prototype, render each pattern clipped over a generic rounded-body shape so it
  reads like it's on a kart. Copy a minimal `cartRoundRectPath` + body-clip from draw.js.

**Prototype:** `docs/asset-prototypes/patterns.html`, self-contained:

- `<canvas>` showing all 7 patterns side-by-side on sample bodies, animated.
- Color swatches that re-tint EVERY pattern live — the whole point is confirming each
  honors `paint`. Cycle through the full player palette.
- Sliders for relevant params (stripe width, dot spacing, star density, flame ramp).

Iterate until approved, then leave the approved `drawXxxPattern(ctx, anim, paint)`
functions for the main session to port. Don't edit game registries yourself.
