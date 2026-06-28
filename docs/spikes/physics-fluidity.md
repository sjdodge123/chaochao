# Spike: Fluid kart physics (toggle-gated sample)

**Branch:** `spike/physics-fluidity`
**Commit:** `aadc547` — `feat(physics): toggle-gated fluid kart feel (eased steering + momentum carry + soft coast)`
**Worktree:** `/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity`
**Status:** Built + verified locally. **Not pushed, no PR** (per the operator-permission rule). This is a feel sample for an A/B, not a ship-ready PR.

> **Revision 2026-06-28 (live demo feedback).** Two real bugs surfaced by driving the demo, both fixed:
> 1. **Steering reversal / input-lag bug.** The drive-heading ease was a *linear lerp of two unit vectors + renormalize*, which is degenerate near a reversal: pressing the opposite direction collapsed the heading back toward the *original* way and snapped it to full length there (kart ignored the input), and wide turns wasted motion shrinking magnitude instead of rotating (laggy feel). **Fix:** ease the heading **angle** (shortest-arc rotation) instead of the vector — uniform, predictable turn rate, clean 180° reversals, always unit-length. `turnTau` also lowered `0.12 → 0.08` for snappier response.
> 2. **Ice release-brake bug.** The soft-coast used a *flat* `releaseBrakeCoeff` (0.08) on release regardless of surface, which is ~800× grippier than ice's own `brakeCoeff` (0.0001) — so letting go on ice scrubbed speed instead of sliding. **Fix:** cap the eased brake at the tile's own brake — `min(player.brakeCoeff, releaseBrakeCoeff)` — so ice stays slippery (0.0001) while normal ground keeps the soft 0.08 coast.
>
> **Revision 2026-06-28 (post code-review).** A workflow code-review surfaced two stale-state correctness bugs in the eased heading, both fixed, plus a refactor:
> 1. **Stale heading across the start gun.** `startRace` zeroed `momentum`/`lastMoveDir` but not `driveHeadingX/Y`, so a player who juked on the start line could carve out of the gate sideways. **Fix:** `startRace` now also zeros `driveHeadingX/Y` (+ `wasBraking`) so the near-stop snap guard launches them straight.
> 2. **Stale heading after a mid-coast knockback.** The heading is frozen while coasting (intended, to continue the arc), but a bumper/punch that rotated your velocity mid-coast left re-press thrusting along the *old* heading. **Fix:** a new `player.wasBraking` flag re-seeds the heading from actual velocity on the coast→move transition (a no-op for a pure coast, a correction after a knock).
> 4. **Soft hard-turn penalty (addresses review #3).** The classic model dumps your momentum to the floor on a hard turn/reverse; the fluid model originally removed that entirely for humans (a leaderboard-consistency risk, since bots still paid it). Re-added as a *graduated* cost: `turnPenaltyDot`/`turnPenaltyTime` bleed momentum in proportion to how sharply the input diverges from the current heading, over the turn rather than in one tick — a smooth carve is free, a hard reverse scrubs ~15% speed (vs the classic ~30% instant). Tunable; `turnPenaltyTime: 0` restores the no-penalty feel.
>
> 3. **Refactor:** the inline fluid block was extracted to `Engine.applyFluidSteering()` (was bloating `updatePlayers`); the angle ease now rotates the heading vector directly (1 `atan2` + `cos`/`sin` instead of 2 `atan2` + `cos`/`sin`, no manual ±π wrap), and the dead per-tick input re-normalize + `lastMoveDir` writes on the fluid path were removed. Behavior-preserving; verified by a 10-assertion harness driving the real method (reversal, snap, coast re-seed, unit-length, no-NaN) + smoke + AI-fitness 32/36 (unchanged).

> TL;DR for a fresh agent: a new `config.physicsFluid` block makes **human** karts steer like they carve an arc, carry speed through turns, and coast to a smooth stop. It is **default ON** in this branch. Flip `physicsFluid.enabled` to `false` in `server/config.json` to get the classic snap-and-stop model back, restart the server, and feel the difference side by side. Bots are never touched.

---

## 1. What feels different + the design decisions + WHY

### The problem this samples a fix for
Today's kart movement is **rigid**: there are only 8 fixed drive headings (the keyboard/joystick 8-way), so a turn instantly *flicks* the drive force from one compass point to the next; the momentum ramp gets **dumped to zero** on any hard turn or stop; and releasing the keys **stomps** a hard brake (`brakeCoeff = 0.235` per tick). Net feel: on/off, twitchy, "stuck to a grid."

### The three highest-impact changes (sourced from the rigidity reports)

All three are **human-players-only**. Bots stay on the exact classic snap model, mirroring the existing `momentumRamp` bot-exemption precedent — so **AI pathing/fitness is provably untouched** (bots never enter the new code branch). All three preserve cruise/terminal speed, the per-tile grip table, brutal-round speed mods, the hard max-speed clamp, and collision.

1. **Eased steering** (the #1 cited cause of rigidity). Each kart now carries a `driveHeadingX/Y` — the direction the drive force is *actually* applied along. Each tick its **angle** exponentially eases toward the held 8-way input's angle along the **shortest arc** over `turnTau` (time constant, seconds); the heading stays unit-length by construction (`cos`/`sin` of the eased angle). Turns **carve an arc** instead of flicking between the 8 headings. *(Originally a vector lerp + renormalize — replaced because that was degenerate on a ~180° reversal; see the Revision note above.)* **Crispness guard:** from a near-stop (`speed < momentumRamp.resetSpeedMin`, i.e. < 15 px/s) the heading **snaps** straight to intent — the ease only engages once you're moving, so launches off the line stay sharp.

2. **Momentum carried through direction changes.** Instead of dumping the momentum ramp to zero on a hard turn or stop, it **bleeds down gradually** over `momentumDecayTime` seconds when coasting, and keeps building while you hold input regardless of turn angle. The eased heading is what makes the turn feel smooth; the preserved ramp is what keeps you from re-winding speed from scratch after every corner.

3. **Softer coast on release.** Releasing all keys brakes on `min(tile.brakeCoeff, releaseBrakeCoeff)` — the eased `releaseBrakeCoeff` (`0.08`, a gentle glide) on normal ground (vs the classic `brakeCoeff` `0.235`, a stomp), but **capped at the tile's own brake so a slippery surface stays slippery** (ice's `0.0001` is preserved, not overridden). Measured on normal ground: **82 → 6.8 px/s over 1 s** of coasting vs the classic model's near-instant stop (~0.05 px/s). You glide to rest instead of nailing the brakes; on ice you keep sliding. *(The `min()` cap was added after the demo — a flat 0.08 was ~800× grippier than ice and killed the slide; see the Revision note above.)*

**Why a toggle rather than a hard swap:** this is a feel experiment. The classic code path is kept 100% intact behind `else`/`else if` branches, so an A/B is a one-boolean flip + restart, and reverting the whole sample is deleting one config key.

---

## 2. The exact toggle (config key, default, A/B)

**File:** `server/config.json` → top-level `physicsFluid` block (around line 836):

```json
"physicsFluid": {
    "_doc": "... (long inline explanation of the model) ...",
    "enabled": true,
    "turnTau": 0.08,
    "momentumDecayTime": 0.6,
    "releaseBrakeCoeff": 0.08
}
```

- **`enabled`** — `true` (default in this branch) = new fluid feel; `false` = classic snap-and-stop model. **If the whole `physicsFluid` key is absent or `null`, it also falls back to classic** (`fluid != null && fluid.enabled` guard).
- **`turnTau`** (`0.08`) — exponential time-constant of the drive-heading **angle** ease, in seconds. **Smaller = snappier turns**, larger = floatier. *(Was `0.12`; lowered after the demo for responsiveness.)*
- **`momentumDecayTime`** (`0.6`) — seconds to bleed the momentum ramp to zero while coasting.
- **`releaseBrakeCoeff`** (`0.08`) — per-tick velocity bleed while coasting with no input, **capped per-tile at `min(tile.brakeCoeff, releaseBrakeCoeff)`** so slippery tiles aren't made grippier. Larger = stops sooner; the classic normal-ground value is `0.235`.
- **`turnPenaltyDot`** (`0.4`) — soft hard-turn speed cost: input pointing more than this (cos, `0.4 ≈ 66°`) away from the current heading starts bleeding momentum. Matches the classic `momentumRamp.resetDot`.
- **`turnPenaltyTime`** (`0.1`) — seconds to fully drain momentum at a dead reversal; **smaller = harsher**. Unlike the classic instant dump-to-floor, this bleeds gradually over the turn (a 180° flick costs ~0.5 momentum → ~15% slower, rebuilding over `rampTime`). Set to `0`/`null` to disable.

**A/B procedure:** edit `enabled`, **restart the dev server** (config is read at boot and re-delivered to clients), drive, compare. There is no live hot-reload.

---

## 3. Every file:line changed (commit `aadc547`)

| File | Lines | What |
|---|---|---|
| `server/config.json` | ~836–842 | New `physicsFluid` block (`_doc`, `enabled:true`, `turnTau:0.08`, `momentumDecayTime:0.6`, `releaseBrakeCoeff:0.08`). |
| `server/engine.js` | 246–253 | New comment + `var fluid = c.physicsFluid;` + `var useFluid = (fluid != null && fluid.enabled && !player.isAI);` |
| `server/engine.js` | 255–256 | `var thrustX = dirX; var thrustY = dirY;` — the direction drive force is applied along this tick (eased in fluid mode, raw otherwise). |
| `server/engine.js` | call ~257–266; method ~333–393 | `if (useFluid)` now just calls `this.applyFluidSteering(player, dirX, dirY, braking, fluid, ramp)` and reads `player.driveHeadingX/Y` as thrust while moving. The method (sibling of `updatePlayers`): coast = gradual `momentum` decay over `momentumDecayTime` + set `wasBraking`; moving = coast→move velocity re-seed (if `wasBraking`), then snap-on-near-stop (`headMag < 1e-4 || fspeed < snapSpeed`) or rotate the heading vector toward input by the shortest arc (`dot`/`cross` → `atan2`, `blend = 1 - exp(-dt/turnTau)`, rotate by `blend*theta`), then build momentum over `ramp.rampTime`. The classic momentum block is `else if (ramp != null && !player.isAI)`. |
| `server/game.js` | startRace (~1385) | Zeros `driveHeadingX/Y` + `wasBraking` at the gun alongside `momentum`/`lastMoveDir` so a stale heading can't leak across the start. |
| `server/entities/player.js` | ~361–365 | New `this.wasBraking = false` field (coast→move re-seed flag). |
| `server/engine.js` | 325 | `momentumFactor` now enabled under fluid too: `((ramp != null \|\| useFluid) && !player.isAI) ? player.getMomentumFactor() : 1`. |
| `server/engine.js` | 328–329 | Velocity integration now uses `thrustX/thrustY` instead of raw `dirX/dirY`. |
| `server/engine.js` | ~338–349 | Brake uses `var brakeC = useFluid ? Math.min(player.brakeCoeff, fluid.releaseBrakeCoeff) : player.brakeCoeff;` then bleeds `velX/velY` by `brakeC` — the `min()` keeps slippery tiles (ice `0.0001`) from being made grippier by the flat ease. |
| `server/entities/player.js` | 354–360 | New fields `this.driveHeadingX = 0; this.driveHeadingY = 0;` (eased drive heading; `0,0` = not yet moving → snaps to intent on first committed tick). |
| `CHANGELOG.md` | 19 | Player-facing bullet under `## Unreleased` → Gameplay & Balance. |
| `client/scripts/learn.js` | 70–72 | Refreshed the "Building Speed" Codex card `detail` prose to describe the fluid feel. |

(Line numbers are post-commit on this branch; re-grep `useFluid` / `driveHeadingX` / `physicsFluid` if the file has moved since.)

---

## 4. HOW TO DEMO (step by step, zero guesswork)

### 4a. Launch the dev server (cwd-independent, fresh free port)

Run from **anywhere** — `index.js` is referenced by absolute path so cwd doesn't matter. Port `3611` was free at write time; if it's taken, pick `3612`/`3613`/`3614`.

```bash
PORT=3611 node /Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity/index.js
```

This serves the **unminified** per-file scripts (dev mode) — no build step needed. Watch for the boot log; the server prints its listen port. It auto-sleeps when no clients are connected and wakes on first connect — that's expected.

**Open these (print BOTH for the operator — they test on a real iPad/phone too):**
- Local: **http://localhost:3611/play.html**
- LAN: **http://192.168.0.62:3611/play.html**

(LAN IP `192.168.0.62` was this machine's `en0` at write time; re-derive with `ipconfig getifaddr en0` if it changed. The port = `process.env.PORT` you passed, i.e. `3611`.)

### 4b. Feel the difference (fluid is ON by default in this branch)

1. Load `play.html`, enter the game. You'll spawn into the **lobby** — a free-roam map with no collapse pressure, ideal for feeling movement.
2. Drive around with **WASD / arrow keys** (or a gamepad / touch joystick). Things to feel with fluid **ON**:
   - **Carving:** hold forward, then swing to a diagonal — the kart **rotates into** the new heading and traces an arc instead of instantly re-pointing.
   - **Momentum through turns:** weave left/right at speed — you **keep your pace** instead of bogging down on each direction change.
   - **Soft coast:** get up to speed, then **release all keys** — you **glide** to a stop over ~a second instead of stopping almost dead.
   - **Crisp launch:** from a dead stop, tap a direction — it should still **leave the line sharply** (the near-stop snap guard), not feel mushy.

### 4c. A/B against the classic model

1. Stop the server (Ctrl-C).
2. Edit `/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity/server/config.json` → set `physicsFluid.enabled` to `false`.
3. Relaunch the same command (`PORT=3611 node …/index.js`), reload `play.html`.
4. Drive the same lobby. Now you should feel the **classic** behavior: headings flick between 8 compass points, speed dumps on hard turns, and releasing keys stops you almost immediately.
5. Flip back to `true`, restart, and the fluid feel returns. That side-by-side is the demo.

**What to look for / success criteria:** fluid mode should feel *smoother and less twitchy* without feeling *floaty or laggy*; top speed and surface grip should be visibly identical (ice still slips, sand still drags); launches off a stop should stay crisp. If turns feel too floaty, lower `turnTau` (e.g. `0.08`); if coast feels too long, raise `releaseBrakeCoeff` (e.g. `0.12`).

---

## 5. Verification results (already run on this branch)

- `node --check server/engine.js server/entities/player.js client/scripts/learn.js` + `JSON.parse(config.json)` — **all OK**.
- `node .github/scripts/smoke-test.js` — **PASS** (engine ticked 53 committed maps through waiting→racing→collapsing, no throw, no malformed compressor payload).
- `REPO_ROOT=. node .github/scripts/ai-fitness.js Crossroads 6` — **finishers = 32/36, frozen = 0** (bots still finish; expected, since bots never enter the fluid branch).
- `node .github/scripts/codex-coverage.js` — **PASS** (Codex card prose refreshed, no drift gate failure).
- Headless math harness of the human fluid path — cruise terminal unchanged (~83 px/s), a hard turn carves the heading gradually while **preserving speed**, coast glides (82 → 6.8 px/s over 1 s), no NaN.

To re-run quickly from the worktree root:
```bash
node /Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity/.github/scripts/smoke-test.js
REPO_ROOT=/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity \
  node /Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity/.github/scripts/ai-fitness.js Crossroads 6
```

---

## 6. Risks + open questions

- **Client prediction / smoothing:** movement is server-authoritative; the client only renders interpolated state. The eased heading lives entirely server-side, so there's no client decoder change — but verify the existing interpolation doesn't *fight* the new curve at higher latency (looked fine locally on LAN; untested over WAN).
- **PvP fairness / abilities:** punch, swap, ice-cannon, bumpers etc. apply impulses directly to `velX/velY`; the gentler `releaseBrakeCoeff` means karts **retain knock impulses longer** while coasting. Feels fine in lobby but not stress-tested in a full brutal round — worth a combat-heavy playtest.
- **Tuning is eyeballed:** `turnTau:0.12`, `momentumDecayTime:0.6`, `releaseBrakeCoeff:0.08` are first-pass values from feel + the math harness, not a tuned sweep. They're the obvious knobs to dial in a playtest.
- **Touch/joystick feel:** verified the model is input-source-agnostic (it eases whatever 8-way `dirX/dirY` arrives), but the *carve* feel on a touch joystick vs keyboard hasn't been A/B'd on a real device.
- **Codex/Learn scope:** the "Building Speed" card now describes the fluid feel as if shipped. If this sample is reverted, that prose must revert too (it's gated on the same toggle in spirit but the card text is unconditional).
- **No client-side visual of the heading:** the kart sprite still faces its velocity/aim; the eased *drive* heading is invisible except through how the kart moves. Probably fine, but a subtle "lean" could sell the carve harder if pursued.

---

## 7. Operator-injectable prompt — "Show me the new physics demo"

> **Show me the new physics demo.**
>
> Launch the fluid-physics sample so I can feel it. From the worktree `/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity` (branch `spike/physics-fluidity`, commit `aadc547`), start the dev server cwd-independently on a fresh free port:
>
> ```
> PORT=3611 node /Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity/index.js
> ```
>
> (If 3611 is taken, pick 3612–3614.) Print BOTH the localhost and LAN URLs to `play.html` (LAN IP via `ipconfig getifaddr en0`; port = the PORT you used). Don't kill any server I already have running — start a fresh instance.
>
> The fluid feel is **default ON** (`server/config.json` → `physicsFluid.enabled: true`). Tell me exactly how to feel the difference: drive the lobby with WASD, then for the A/B set `physicsFluid.enabled: false`, restart the server, reload, and drive again — fluid = carving turns + speed carried through turns + soft coast to a stop; classic = snappy 8-way flicks + hard brake. Read the spike at `/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/physics-fluidity/docs/spikes/physics-fluidity.md` for the full background, the exact knobs (`turnTau`, `momentumDecayTime`, `releaseBrakeCoeff`), and what to look for. Don't push or open a PR.

---

*Spike authored 2026-06-27. Nothing pushed; no PR opened.*
