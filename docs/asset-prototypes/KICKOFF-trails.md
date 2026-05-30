# Asset-design session: TRAILS (effect/shape varies, always player color)

Paste this into a fresh Claude Code session. ISOLATED art session — build a standalone
prototype, iterate, do NOT wire into the game. The main session ports approved effects.

---

You're running an isolated asset-design session for the chaochao cosmetics rework. Work
on the `worktree-progression-system` branch
(`/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/progression-system`).
Read `docs/cosmetics-ladder.md` for the locked design. Do NOT touch draw.js or the
registries — your only output is a prototype + approved effect functions.

**Key rule:** a TRAIL is ALWAYS rendered in the player's color (`player.color`). What
varies between unlockable trails is the **effect/shape** — never the color. (Today the
trail color is overridden per-skin via `getSkinTrailColor`; that override is being
removed. Build effects that take a `color` and render in it.)

**Goal:** design 7 trail effects (all rendered in `color`):

1. `dashes` — **Dashes** (Lv4, common): broken dash segments along the path.
2. `sparkle` — **Sparkle** (Lv10, uncommon): scattered twinkling particles trailing off.
3. `comet` — **Comet** (Lv16, rare): a wide glowing tapered streak (head bright → tail thin).
4. `bubbles` — **Bubbles** (Lv22, epic): rising bubble particles that drift off the path.
5. `aurora` — **Aurora** (Lv28, legendary): flowing ribbon glow, soft waving band.
6. `guardian` — **Guardian** (achievement, trail): protective halo/shield glow following the kart.
7. `survivor` — **Survivor** (achievement, trail): ember/phoenix-persistence — glowing
   embers that linger and fade.

Plus show the **Basic** default (solid fading stroke) for reference — that's the current
`drawTrail` behavior in `client/scripts/draw.js` (~line 3127); read it to match the
fade-bucket / alpha conventions.

**Effect contract** (the integrator will call your effect per-frame with the trail
vertex history + color; design to that shape):

```js
// verts: [{x,y,t}], newest last. color: player CSS color. now: ms. fadeMs: lifetime.
function drawSparkleTrail(ctx, verts, color, now, fadeMs, anim) { /* ... */ }
```

- The real trail is a list of timestamped vertices that fade over ~5s (`TRAIL_FADE_MS`).
  Older vertices are more transparent. Your effect renders along that polyline in `color`.
- For particle effects (sparkle/bubbles/embers), derive deterministic per-vertex jitter
  from the vertex index/time (NO Math.random per-frame — must be stable frame-to-frame).

**Prototype:** `docs/asset-prototypes/trails.html`, self-contained:

- `<canvas>` with several karts auto-driving looping/curving paths, each leaving a
  different trail effect, animated in real time, so the operator sees them in MOTION.
- Color swatches re-coloring every trail live (full player palette) to confirm they all
  read in the player color.
- Sliders for per-effect params (dash length, particle density, comet width, glow blur).
- Simulate the vertex-fade buffer (push the kart position each frame with a timestamp,
  expire past fadeMs) so effects behave like the real `drawTrail`.

Iterate until approved, then leave the approved effect functions for the main session to
port into the trail-effect switch in draw.js. Don't edit game registries yourself.
