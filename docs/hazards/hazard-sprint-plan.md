# Map Hazards — Sprint Plan & Design Doc

Living source of truth for the multi-batch effort to add new **map-authorable hazards** to Chao Chao. Each batch is one PR. Agents pick up the next batch by reading this doc + the handover prompt. **Update the Status Log + check off boxes in the same PR that ships a batch.**

> Sibling reference: the per-file architecture index is `ARCHITECTURE.md` (see the `hazards.js` row for the add-a-kind checklist). Player-facing behavior lives in the Codex (`client/scripts/learn.js`). Tuning lives in `server/config.json`.

---

## 1. Goal

Grow the roster of map-placeable hazards on top of the **hazard-kind registry** that shipped in v0.35.1. Hazards are placed in the in-browser map editor and stored in map JSON as `{ id, x, y, [angle] }`. The registry makes each new kind a localized addition — no edits to the generic spawn/wire/validate paths.

## 2. The framework — how to add a hazard kind

Single source of truth: `server/entities/hazards.js` (`HAZARD_KINDS` / `registerHazardKind` / `hazardKindById`). Adding a kind touches exactly these spots:

1. **`server/config.json` → `hazards.<key>`** — id + tuning. **Next free id: 909** (900–905 = bumper/movingBumper/bumperWall/rotor/geyser/mine; **906 antlion, 907 thumper are taken** by the antlion brutal mode, not registry kinds; **908 vortexWell** = Batch 2's force zone — the Gust Fan was scrapped before shipping, see §5).
2. **`server/entities/hazards.js`** — a `Hazard`/`Rect` subclass + one `registerHazardKind(key, { railed, directional, build })` call.
3. **`client/scripts/draw.js`** — a drawer in `buildHazardDrawers` (id → fn).
4. **`client/scripts/create.js`** — an entry in `EDITOR_HAZARD_KINDS` (palette button, swatch, paint, shortcut). Optional hooks: `paint` / `swatchPaint` / `segmentSelect`.
5. **`.github/scripts/<kind>-test.js`** — a real-engine headless test, wired into `.github/workflows/pr-validation.yml`.
6. **Docs:** `CHANGELOG.md` (`## Unreleased`, player-voice bullet — CI-enforced for config/game/engine changes), `client/scripts/learn.js` Codex card/mention, `ARCHITECTURE.md` hazards row, and check a box here.

Everything else is registry-driven and needs **no** change: `gameBoard.generateHazards`, `utils.validateMap` (`directional` ⇒ finite angle), the Lightning speedup, the editor palette/thumbnail/keyboard plumbing, and the wire payloads.

### Registry contract
- `railed` — rides a `HazardRail` (implies directional). `directional` — map entry needs a finite `angle` (validateMap rejects otherwise; non-finite ⇒ NaN math). `build(entry, mapID, roomSig)` — construct from the JSON entry.
- **Per-tick motion:** moveable kinds either ride a `rail` *or* define `advance(dt)` (called by `engine.updateHazards`, which has the tick dt). Static kinds set `moveable=false`.
- **Per-tick state:** stationary stateful kinds run a phase timer in `update(dt)` (`gameBoard.updateHazards` passes dt) and ship a `netState` int.
- **Lightning:** moving kinds implement `scaleSpeed(mod)` (rail → speed, rotor → angularSpeed); timed/static kinds omit it.

### Wire slots (already built, in `compressor.js` + `client/scripts/gameboard.js`)
- Per-tick row `[ownerId, x, y]` + optional `[3] angle` (only if `hazard.streamAngle`) + optional `[4] netState`. Bumpers stay 3 fields.
- Creation row (`newHazards`) `[ownerId, id, x, y, angle, railX, railY, netState, radius]`; railed kinds ship the **rail's** origin/angle. Slot `[8] radius` is **opt-in** (like `streamAngle`/`netState`): a kind sets `sizable=true` to ship its per-instance authored radius (the vortex well); it's `null` for every other kind.
- Client smooths position (`tx/ty`) and streamed angle (`ta`, via `smoothAngle`, shortest-arc).

### Damage patterns available (reuse, don't reinvent)
- **Map-owned Punch** (radial knockback): set `this.punch = new Punch(x,y,radius,color,ownerId,roomSig,bonus,false,null)`; mark `mapOwned=true`, `type="bumper"` (keeps the pinball-medal tally + team-gate exemption). `gameBoard.updateHazards` emits it; it collides with players for ~100ms. Used by bumper, wall, rotor, geyser, mine.
- **Explosion force** (`gameBoard.applyExplosionForce`) — coupled to projectileList; prefer the Punch path for hazards.
- **Proximity trigger** — give the hazard a collision `radius`; `handleHit(player)` fires when a kart overlaps (used by the mine).

### AI awareness (`server/aiController.js`)
Two layers: (a) `hazardRepulsion` (per-tick steering away from live hazard positions — generic radial field handles most circle hazards) and (b) the path-cost classification loop (~line 1920) sorting hazard cells into `staticHazardCells` (harsh) vs `railCells` (mild/timeable). Add a branch there only if the default point-nearest-cell classification is wrong for the kind's shape (rotor uses `isRotor` → swept-ring cells as railCells; wall uses `isWall` → segment cells as static).

### Testing pattern
Copy an existing `<kind>-test.js` (rotor/geyser/mine are the cleanest templates). Boot the real server headlessly, mock `Date.now`+`setTimeout` into a per-tick clock, seed `Math.random` (mulberry32). Cover: (A) pure geometry/state machine, (B) the wire-payload shape, (C) a live `room.update(dt)` loop proving the actual gameplay outcome (bonk/launch/boom). Wire into `pr-validation.yml`.

## 3. Conventions (operator working agreements)

- **Worktree per batch:** `git worktree add -b worktree-hazard-batchN .claude/worktrees/hazard-batchN origin/main`. Never work on shared main.
- **PR gate:** commits + worktree + dev server are free, but **NEVER push/open/update a PR without explicit operator go-ahead each time.**
- **Rebase before PR:** fetch + rebase onto `origin/main` (it moves fast), re-verify build + full battery.
- **Babysit after open:** poll CI to completion; check bot inline comments (`gh api repos/sjdodge123/chaochao/pulls/<n>/comments` + `/reviews` — `gh pr view --json comments` misses inline), failed jobs, issues; fix/re-run/report.
- **Known CI noise:** `client-perf` is advisory (not a blocker). `start-edges-test` (in the smoke-test job) is a `Date.now` flake — "only N/6 bots found a non-lava lane" = re-run, not a regression.
- **Codex review** each batch (`/codex:review`) before PR; fix findings with regression coverage.
- **Dev server:** host on a fresh free port; print `localhost:<port>` + `<LAN-IP>:<port>` for on-device playtest.
- **Codex scenes (deferred debt):** the batch-1 hazards reused the bumpers Codex card text rather than bespoke animated `learnScenes.js` scenes. A polish follow-up could add real scenes (CI only gates that `anim` refs resolve).

## 4. Roadmap & status

Effort ascends; cheap+reused first, AI/economy-heavy last.

- [x] **Batch 0 — Framework + Bumper Wall** (id 902) — PR #300 → v0.35.1.
- [x] **Batch 1 — Rotor (903), Geyser (904), Proximity Mine (905)** — PR #303 → v0.35.4. Proved the `streamAngle` (rotor) and `netState` (geyser/mine) wire slots, the `advance(dt)` motion hook, and the `dt`→`update(dt)` stationary-timer path.
- [x] **Batch 2 — Vortex Well (908)** — the constant-force-field hazard. Proved the **force-zone primitive**: a continuous per-tick force applied ONCE per tick in `gameBoard.updateHazards` (`forceZone` flag + `applyForce`), NOT in `handleHit` (the collision system fires handleHit up to 2× per pair → doubled/non-deterministic force). No engine/compressor change, no new wire slot (static; `newHazards` carries it). Circular Hazard (`isVortex`, AI routes around the core), **calm-eye** pull profile so the centre is escapable. Test: `.github/scripts/vortex-well-test.js`. **The Gust Fan was cut** (operator: too similar to a boon they're building) — see §5.
- [ ] **Batch 3 — Blink Fence + Crusher** ← NEXT.
- [ ] **Batch 4 — Sentry Turret.**
- [ ] **Batch 5 — Warp Pads.**
- [ ] **Batch 6 — Magpie Drone.**

## 5. Per-batch design specs

### Batch 2 — Vortex Well  ✅ SHIPPED (the new primitive: a force ZONE, not a punch)
> **Scope change:** this batch was originally Gust Fan **+** Vortex Well. The **Gust Fan was cut** during playtest — the operator is building a boon too similar to it (a directional wind/speed effect). It was fully built then removed cleanly (config/registry/draw/editor/AI/classifier/test); id 908 was reassigned to the Vortex Well. If a wind hazard is ever wanted, the rotated-Rect `forceZone` pattern is in git history on this branch (commits before the cut).

The genuinely new bit vs batch 1: apply a constant per-tick force to players **inside a region** rather than via the Punch system. **How it landed (and a correction):** the first cut reused the Dash Arrows trick — apply the force in `handleHit` (which `engine.narrowBase` calls when a kart overlaps). That was WRONG for an *uncapped* force: narrowBase calls `handleHit` up to **twice** per overlapping pair (once with each object as the outer loop var), and whether both fire depends on quadtree node placement — so the force was ~2× and non-deterministic. The fix is the dedicated path the spec originally suggested: a `forceZone: true` flag + an `applyForce(player)` method, called **once per hazard per tick** over the player list in `gameBoard.updateHazards` (handleHit is a no-op for these). No engine/compressor change; static, so the per-tick wire row stays 3 fields and `newHazards` carries it. The force is a fixed per-tick increment (not dt-scaled), tuned **below the kart's own thrust** so driving always wins; drag bounds it; `maxVelocity` caps it; protected/star-power/finished karts are skipped (`applyExplosionForce` policy); applied only while racing/collapsing.
- **Vortex Well** (id 908, `directional: false`) — a circular **Hazard** (`isVortex`); `applyForce` pulls toward the core with a **calm-eye** profile: `pull = force·4·r·(1−r)` where `r = dist/radius` — **zero at the dead centre and the rim, peak (`force` = 7) in the mid-ring**. This is the load-bearing design choice: the original "peak at centre" linear ramp was a **roach motel** (the strongest pull pointed exactly opposite your only escape, so a stopped kart could never drive out — verified by sim, and caught by the operator in playtest: *"how do you get out of the middle?"*). The calm eye lets you build speed in the quiet centre and punch out through the ring; `force` 7 sits below thrust (~12.5/tick) so driving out always works (worst case ~3.8s flooring straight out from a dead stop). Carry speed → slingshot past; crawl → drawn toward the eye. AI: the generic radial `hazardRepulsion` (h.radius) keeps bots off it; the classifier penalizes the inner-`0.6·radius` core cells (STATIC) so A* routes around the centre.
- **Blur effect:** the interior renders as a hazy violet swirl (`draw.js drawVortexWell`). The blur is baked ONCE into an offscreen sprite via `ctx.filter = "blur()"` (the `getBlackoutHoleSprite` pattern) and rotate-blitted each frame (scaled to the instance radius) — a per-frame canvas filter is a mobile GPU killer (see the cosmetic-perf-collapse history), so the filter never runs in the live loop. It's a stylized haze, NOT a true frosted-glass blur of the terrain/karts behind it (that would need a per-frame framebuffer capture+blur — deferred as too costly).
- **Per-instance size (drag-to-resize):** the well's `radius` is authored PER INSTANCE — config `radius` (150) is the MAX, `minRadius` (70) the floor, and a fresh placement defaults to the **midpoint** (110). The editor exposes a **resize handle** (the `resizable` kind flag) in place of the rotate knob (the well is radially symmetric — spinning it did nothing): drag it to size the pull radius, clamped to `[minRadius, radius]`. The size rides the map entry (`{id,x,y,radius}`), is **clamped server-side** in `vortexWellRadius()` (a crafted map can't ship a giant well), and ships to clients in the **opt-in `newHazards` slot `[8]`** (gated by the kind's `sizable` flag; per-tick rows stay 3 fields — size is static). `coreRadius` (the drawn centre + the calm eye) scales with the instance radius. The strong-pull core fraction (`coreFraction` 0.6) lives in config, shared by `aiController` and `mapClassifier` so the bot routing and the fairness/par estimate never drift. AI (`hazardRepulsion` h.radius, classifier `radius·0.6`) already reads the live per-instance radius.
- Tests (`.github/scripts/vortex-well-test.js`, wired into `pr-validation.yml`): [A] inward pull + calm-eye-peaks-in-the-ring + peak≤force + rim-cutoff + protected/star/finished + handleHit-noop, [B] static 3-field wire + `newHazards`, [C] live loop — **exactly one pull/tick (not doubled)**, parked kart drawn toward the core, and the **escape regression: a kart flooring out from the dead centre drives clear of the well**.
- **Deferred polish:** custom in-game SFX (none — silent like batch-1 hazards); the editor selects/rotates via the default disc handle; the well is still pushed into the collision quadtree (handleHit no-op) — harmless but slightly wasteful; a true framebuffer blur of content behind the well (vs the stylized haze).

### Batch 3 — Blink Fence + Crusher
- **Blink Fence** — a laser barrier between two pylons on a published cycle (solid Ns / open Ns, shimmer warning). Solid = wall bounce (reuse `bounceOffBoundry`) or lava-style burn variant. Uses `netState` (open/closed) like a traffic light. Directional (pylon axis).
- **Crusher** — a wall segment sliding across a corridor on a rail (Thwomp). Reuse rail movement + the `BumperWall` rotated-rect collision; lethal pinch between crusher and boundary. AI: time the gap like a moving bumper.

### Batch 4 — Sentry Turret (id TBD)
First projectile-emitting map element. Stationary; tracks nearest kart in an arc; fires an ice-cannon shot every cooldown. Reuse the aimer + iceCannon projectile systems. Uses `streamAngle` (barrel facing) + `netState` (cooldown/firing). AI: route around the firing arc / bait shots.

### Batch 5 — Warp Pads
Paired teleporters preserving velocity, per-player cooldown. Teleport is trivial; the cost is teaching the AI `cellGraph` the pads are linked (so bots don't ping-pong) — budget AI work. Signature play: punch a rival into a portal whose exit faces lava.

### Batch 6 — Magpie Drone
A drone patrolling a rail that **steals** the held ability (or a stamina chunk) on contact and visibly carries the loot; punch it to make it drop the pickup. First hazard touching the ability economy. Reuse rail movement + the ability pickup/drop flow.

## 6. The chaining workflow

Each batch is handed off with a prompt that points the next agent here. Sequence per batch: read this doc → create the worktree → build the batch (framework recipe in §2) → full battery + `/codex:review` → fix findings → host a dev server for playtest → **get go-ahead** → rebase → PR → babysit. Then update §4/§5 + the Status Log in this doc and write the next handover prompt.

## 7. Status log
- 2026-06-13 — Batch 0 (framework + Bumper Wall) shipped v0.35.1; Batch 1 (Rotor/Geyser/Mine) shipped v0.35.4. Doc created. Next: Batch 2 (Gust Fan + Vortex Well), ids 908/909.
- 2026-06-13 — Batch 2 BUILT on worktree-hazard-batch2. Originally Gust Fan + Vortex Well; `/codex:review` (high) → 4 fixes. Then playtest feedback drove two changes: (1) the **vortex was a roach motel** — moved force from `handleHit` (fired ~2×/tick) to a once-per-tick `forceZone`/`applyForce` pass in `gameBoard.updateHazards`, and reshaped the pull to a **calm eye** (`force·4r(1−r)`, force 7) so the centre is escapable (~3.8s worst case, sim-verified + regression test); (2) the operator **cut the Gust Fan** (too close to a boon they're building) — removed cleanly, id 908 reassigned to the well; and (3) added a **baked-sprite blur** to the well interior (bake-time `ctx.filter`, rotate-blit per frame — no per-frame filter). Test renamed `vortex-well-test.js`. Full battery + build green; dev server re-hosted for playtest. **Not yet pushed / no PR** (awaiting operator go-ahead). Next: Batch 3 (Blink Fence + Crusher).

## 8. Batch 3 handover prompt

> Paste this to the next agent to start Batch 3.

```
Continue the Chao Chao map-hazards initiative. Read docs/hazards/hazard-sprint-plan.md first — it's the living design doc (framework recipe §2, conventions §3, roadmap §4, per-batch specs §5, chaining workflow §6, status log §7).

Do Batch 3: Blink Fence + Crusher — the two state-machine / sliding-wall hazards (§5, §4 next-free-id is 910). New bits vs prior batches:
- Blink Fence: a laser barrier between two pylons on a published solid/open cycle (shimmer warning). Reuses the netState wire slot (open/closed phase, like the geyser) and a phase timer in update(dt). Directional (pylon axis). Solid = bounce (reuse engine.bounceOffBoundry) or a lava-style burn variant — pick one and note why. The new primitive is a TIMED PASSABILITY GATE (collision that turns on/off), so the kart must physically interact only while solid.
- Crusher: a wall segment sliding across a corridor on a rail (Thwomp). Reuse rail movement (the movingBumper advance/rail path) + the BumperWall rotated-rect collision; lethal pinch between the crusher face and the boundary. Streams angle if it rotates; otherwise just rail position. AI: time the gap like a moving bumper (the rail-crossing logic already exists in aiController.hazardRepulsion).

Create the worktree off origin/main: git worktree add -b worktree-hazard-batch3 .claude/worktrees/hazard-batch3 origin/main. Follow the add-a-kind recipe (§2): config + registry + draw + editor + headless test wired into pr-validation.yml, plus CHANGELOG/Codex(learn.js)/ARCHITECTURE. Then run the full headless battery (smoke, classifier, validate-content, mode-smoke, the AI tests since you'll touch aiController, plus your new test) + /codex:review (high), fix findings with regression coverage, and host a dev server (localhost + LAN IP) for playtest.

Honor the gates: NO push/PR without explicit operator go-ahead each time. Rebase onto origin/main and re-verify before any PR; babysit CI after opening (inline bot comments via gh api repos/sjdodge123/chaochao/pulls/<n>/comments + /reviews; start-edges-test/client-perf are known noise). Update §4/§5 + the Status Log (§7) in the design doc in the same PR, and write the Batch 4 (Sentry Turret) handover prompt at the end.

Reference Batch 2 (force zones) as the closest precedent for the registry/editor/AI/test wiring; reference movingBumper (rail) + bumperWall (rotated-rect collision) for the Crusher, and the geyser (netState phase timer) for the Blink Fence.
```
