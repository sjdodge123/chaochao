# Spike: client refactor for Claude token efficiency

**Date:** 2026-06-17
**Goal (operator):** *both* — (a) reduce tokens loaded per typical gameplay/visual edit, and (b) cap worst-case single-file size so no one file can blow the context window.
**Decision so far:** write this cut-plan doc first; no code changes yet.

---

## TL;DR

`draw.js` is the entire problem. **14,439 lines / 652 KB (~190k tokens), 424 functions, touched in 97 of the last 200 commits.** It is both the largest *and* the most-edited client file by a wide margin — every visual/gameplay PR drags it into context. Everything else is a rounding error.

The fix is a pure **file split along existing function-cluster boundaries**, exploiting the fact that the client is bundled by **plain concatenation of global-scoped files** (`build.js`), not a module bundler. Splitting `draw.js` into N files concatenated *in the same order* produces a functionally identical bundle — so the refactor is mechanically near-zero-risk and behaviour-preserving.

Target end state: no client file > ~2,500 lines; a typical "tweak a skin" / "add a hazard" / "fix the HUD" edit loads a ~2k-line focused file instead of the full 14.4k-line monster.

---

## Why draw.js (the cost model)

Token cost of a file to Claude ≈ **size × how often it's pulled into context**. Change-frequency is the multiplier that matters.

| File | Lines | KB | commits / last 200 | size × freq |
|---|---:|---:|---:|---:|
| **draw.js** | **14,439** | **652** | **97** | **dominant** |
| client.js | 2,948 | 136 | 60 | medium |
| create.js | 5,559 | 244 | 49 | low* |
| learn.js | 592 | 60 | 39 | low |
| audio.js | 1,703 | 84 | 37 | low |
| gameboard.js | 2,592 | 100 | 25 | low |
| lobbyHub.js | 2,795 | 136 | 23 | low |

\* create.js is large but isolated to the `create` bundle (map editor) — it rarely co-occurs with gameplay work, so its effective token cost during gameplay edits is ~0.

draw.js is ~3× the next file and the single most-edited file. Cutting it is the only change with material ROI.

## Why the risk is low

`build.js` concatenates global-scoped files in a fixed order into `play.bundle.min.js`. The files already share globals (no modules, no imports). Therefore:

- Splitting `[draw.js]` into `[draw_a.js][draw_b.js][draw_c.js]` and listing them **in the same order** in the bundle yields a functionally identical concatenation.
- Function declarations are hoisted **within their own file**; all cross-function calls happen at **runtime** (inside `draw*()` calls fired from the render loop), not at eval time.
- Eval-time (load-time) statements are the only order hazard. Audit result: draw.js has **192 top-level `var`/`const`** (mostly icon/`Image()` globals in lines 1–250 and scattered state vars) and exactly **one** top-level *call* statement: `tileImagesReady.then(...)` at line 3598. That one stays with its loader cluster. The globals are **written at load, read at runtime**, so as long as concat order is preserved, nothing reads an undefined global at eval time.

**Invariant for every cut:** preserve the relative order of code as it appears in draw.js today. Never reorder functions across the cut. Keep each extracted file in the bundle list in the same relative slot draw.js occupies (positions adjacent to each other, in original order).

---

## The cut plan

draw.js divides into contiguous, named subsystem zones (line numbers from current `main` @ commit 05b5efe — re-derive before cutting; they drift). Proposed files, in **bundle order**:

| New file | draw.js line range | Approx lines | Contents | Edit frequency |
|---|---|---:|---|---|
| `draw_core.js` *(keep as draw.js)* | 1–398, + camera/world/background/gameover, + player hot path, + projectiles/trail | ~varies | Icon/`Image()` globals, colorblind+theme helpers, map-cache state, camera/transform, background/starfield, gameover screen, FX-effect drivers `drawObjects`/`drawEffects`/`drawWorld`/`drawHUD` orchestration, **player render hot path** (`drawPlayers`/`drawPlayer`/zombie/punch-charge/stamina/star-power), projectiles, trail, death pings | high (hot path) |
| `draw_skins.js` | **399–2837** | **~2,440** | `cartSkinRGB`/`cartSkinShade`/cart helpers + all **47 `drawXxxSkin`** painters + `eightBallTick`/`wheelTick` + `drawCartSkin`/overlay helpers | **high** — every new skin |
| `draw_patterns.js` | **2838–3830** | **~990** | Pattern painters (`drawStripesPattern`…`drawSplatterPattern`), `getPlayerSprite`, `loadPatterns`/`loadSpriteSheets`/`buildWaterTexture`/`makePattern*` loaders (incl. the lone eval-time `tileImagesReady.then` @3598) | medium |
| `draw_hazards.js` | **9599–12007** | **~2,410** | `buildHazardDrawers` + every hazard & boon drawer (bumper/rotor/geyser/mine/vortex/warp/laser/crusher/sentry/antlion/thumper + boons dash-arrows/recharge/slipstream/launch-pad/barrel/slingshot/zipline/lily/guard-halo/second-wind), locked-door/key glyphs, bonus orbs | **high** — every new hazard/boon |
| `draw_hud.js` | **12008–end (14439)** | **~2,430** | HUD, combat log, world-record/spectator banners, race timer, overview boards + standings + overview kart render, record floats, touch controls, title screen | high |

`draw_core.js` (whatever remains) lands at ~6,200 lines — still the biggest, but it's the live render hot path that genuinely co-changes. A **phase 2** could further split it into `draw_world.js` (camera/background/map-render/terrain-borders/heatwave/orbital, lines ~3831–4894 + 8217–9598) and a leaner `draw_players.js` (5729–8216), bringing every file under ~2,500.

### Bundle wiring (per file extracted)

For each new `draw_*.js`:
1. `build.js` → add to the `play.bundle.min.js` array, **immediately before/after `draw.js`** preserving original code order (skins/patterns before core if core references them only at runtime — order among them is safe either way since cross-calls are runtime; the safe default is to list them in the same top-to-bottom order they were carved from draw.js).
2. `play.html` → add a `<script src="scripts/draw_*.js">` tag **inside** the `<!-- BUILD: bundle-start --> … <!-- BUILD: bundle-end -->` block, in the same order. Dev mode serves raw tags; prod rewrites the block to the single bundle.

### Verification per cut (cheap, deterministic)

1. `npm run build` — must succeed (esbuild transform per file).
2. `node .github/scripts/smoke-test.js` — boots real server, ticks every map waiting→racing→collapsing. (Note: smoke-test exercises server engine, not client render — it catches bundle/load breakage indirectly via the build step, not draw regressions.)
3. **In-browser render check** (the real gate): `npm start`, open `play.html`, confirm karts/skins/hazards/HUD render. Diff the *minified bundle* before/after the cut — for a pure reorder-preserving split it should be functionally identical (whitespace/file-boundary aside).
4. Watch the advisory `client-perf` CI gate but don't chase it (known noisy; see `client-perf-gate-noisy` memory).

### Sequencing (lowest-risk first)

1. **`draw_skins.js`** — biggest single win, cleanest boundary (399–2837 is one dense contiguous block of pure painters). Proves the pattern.
2. **`draw_patterns.js`** — adjacent, small, contains the only eval-time statement (good test of the order invariant).
3. **`draw_hazards.js`** — high-frequency subsystem, clean trailing-of-middle block.
4. **`draw_hud.js`** — trailing block to EOF, easiest mechanical cut.
5. *(phase 2, optional)* split the `draw_core.js` remainder into `draw_world.js` + `draw_players.js`.

Each step is its own PR (small, reviewable, independently verifiable). Do **not** combine — the value is in keeping each diff a trivially-auditable "move these lines to a new file + 2 wiring lines."

---

## Secondary targets (do only after draw.js, lower ROI)

- **client.js (2,948 / touched 60×):** split the compressor decoders (`update*List`) from the socket event handlers. **Caveat:** decoders are lockstep-coupled to `server/compressor.js` (per CLAUDE.md networking contract) — splitting the *file* is fine, but keep the decoder cluster together and obvious. Medium value.
- **lobbyHub.js / gameboard.js:** cohesive, moderate size, moderate frequency — leave unless they grow.
- **create.js (5,559):** large but bundle-isolated to the editor; near-zero gameplay-edit token cost. Skip.

## Non-goals / explicit cautions

- **No logic changes, no reordering, no renaming** during the split — pure file carving only. Any behaviour change makes the diff un-auditable and forfeits the "byte-identical bundle" safety property.
- Don't touch the landing headline / `[headline]` markers (unrelated; see `landing-headline-no-touch`).
- This is a refactor → **exempt from the CHANGELOG/Codex gates** (no `config.json`/`game.js`/`engine.js` change). Confirm CI's release-notes + codex-coverage gates stay green (they should, since no registry entry changes).

---

## Operator-injectable follow-up prompt

> Execute phase 1 of the client refactor in `docs/spikes/client-refactor.md`: extract `draw_skins.js` from `client/scripts/draw.js`. Carve out the cart-skin subsystem (the `cartSkin*`/cart-helper block through all 47 `drawXxxSkin` painters — currently ~lines 399–2837, re-derive exact bounds from current `main`) into `client/scripts/draw_skins.js`, preserving exact code order. Wire it into `build.js`'s `play.bundle.min.js` list immediately before `draw.js`, and add the matching `<script>` tag inside the BUILD block of `play.html`. Do NOT reorder/rename/modify any function. Verify: `npm run build`, `node .github/scripts/smoke-test.js`, and an in-browser render check that skins still draw; diff the minified bundle to confirm a functionally-identical concatenation. Work in a worktree, commit, but do NOT push or open a PR without my go-ahead.
