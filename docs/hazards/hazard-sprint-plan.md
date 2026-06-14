# Map Hazards — Sprint Plan & Design Doc

Living source of truth for the multi-batch effort to add new **map-authorable hazards** to Chao Chao. Each batch is one PR. Agents pick up the next batch by reading this doc + the handover prompt. **Update the Status Log + check off boxes in the same PR that ships a batch.**

> Sibling reference: the per-file architecture index is `ARCHITECTURE.md` (see the `hazards.js` row for the add-a-kind checklist). Player-facing behavior lives in the Codex (`client/scripts/learn.js`). Tuning lives in `server/config.json`.

---

## 1. Goal

Grow the roster of map-placeable hazards on top of the **hazard-kind registry** that shipped in v0.35.1. Hazards are placed in the in-browser map editor and stored in map JSON as `{ id, x, y, [angle] }`. The registry makes each new kind a localized addition — no edits to the generic spawn/wire/validate paths.

## 2. The framework — how to add a hazard kind

Single source of truth: `server/entities/hazards.js` (`HAZARD_KINDS` / `registerHazardKind` / `hazardKindById`). Adding a kind touches exactly these spots:

1. **`server/config.json` → `hazards.<key>`** — id + tuning. **Next free id: 910** (900–905 = bumper/movingBumper/bumperWall/rotor/geyser/mine; **906 antlion, 907 thumper are taken** by the antlion brutal mode, not registry kinds; **908 gustFan, 909 vortexWell** = Batch 2 force zones).
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
- Creation row (`newHazards`) `[ownerId, id, x, y, angle, railX, railY, netState]`; railed kinds ship the **rail's** origin/angle.
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
- [x] **Batch 2 — Gust Fan (908), Vortex Well (909)** — the two constant-force-field hazards. Proved the **force-zone primitive**: a continuous per-tick force applied in `handleHit` (the collision system's every-overlap-tick contact, reusing the Dash Arrows boon's trick) instead of a one-shot Punch — no engine/compressor change, no new wire slot (both static; gust ships its wind angle via the existing `newHazards` angle slot). Gust = rotated Rect (`isGust`, AI counter-steers the wind); Vortex = circular Hazard (`isVortex`, AI routes around the core). Test: `.github/scripts/force-zones-test.js`.
- [ ] **Batch 3 — Blink Fence + Crusher** ← NEXT.
- [ ] **Batch 4 — Sentry Turret.**
- [ ] **Batch 5 — Warp Pads.**
- [ ] **Batch 6 — Magpie Drone.**

## 5. Per-batch design specs

### Batch 2 — Gust Fan + Vortex Well  ✅ SHIPPED (the new primitive: a force ZONE, not a punch)
The genuinely new bit vs batch 1: apply a constant per-tick force to players **inside a region** rather than via the Punch system. **How it landed (and a correction):** the first cut reused the Dash Arrows trick — apply the force in `handleHit` (which `engine.narrowBase` calls when a kart overlaps). That was WRONG for an *uncapped* force: narrowBase calls `handleHit` up to **twice** per overlapping pair (once with each object as the outer loop var), and whether both fire depends on quadtree node placement — so the force was ~2× and non-deterministic. The fix is the dedicated path the spec originally suggested: a `forceZone: true` flag + an `applyForce(player)` method, called **once per hazard per tick** over the player list in `gameBoard.updateHazards` (handleHit is a no-op for these). No engine/compressor change; both static, per-tick wire row stays 3 fields, gust's wind angle rides the existing `newHazards` angle slot. The force is a fixed per-tick increment (not dt-scaled), tuned **below the kart's own thrust** so driving always wins; drag bounds it; `maxVelocity` caps it; protected/star-power/finished karts are skipped (`applyExplosionForce` policy); applied only while racing/collapsing.
- **Gust Fan** (id 908, `directional: true`) — a centre-anchored rotated **Rect** wind zone (`isGust`); `applyForce` adds `force` (12) along the unit wind vector (`windX/windY` from `angle`) while the kart is inside the rect. `width` along the wind, `height` across. Crosswind/tailwind/headwind authoring; composes with ice (lower drag ⇒ bigger drift; ~80 u/s crosswind on grass). AI (`hazardRepulsion`): inside the rotated-rect, bias the heading against the wind (`GUST_COUNTER_STRENGTH`); classifier skips it (traversable — drive through, don't route around).
- **Vortex Well** (id 909, `directional: false`) — a circular **Hazard** (`isVortex`); `applyForce` pulls toward the core with a **calm-eye** profile: `pull = force·4·r·(1−r)` where `r = dist/radius` — **zero at the dead centre and the rim, peak (`force` = 7) in the mid-ring**. This is the load-bearing design choice: the original "peak at centre" linear ramp was a **roach motel** (the strongest pull pointed exactly opposite your only escape, so a stopped kart could never drive out — verified by sim). The calm eye lets you build speed in the quiet centre and punch out through the ring; `force` 7 sits below thrust (~12.5/tick) so driving out always works (worst case ~3.8s flooring straight out from a dead stop). Carry speed → slingshot past; crawl → drawn toward the eye. AI: the generic radial `hazardRepulsion` (h.radius) keeps bots off it; the classifier penalizes the inner-`0.6·radius` core cells (STATIC) so A* routes around the centre.
- Tests (`.github/scripts/force-zones-test.js`, wired into `pr-validation.yml`): [A] gust push/accumulate/containment/protected/finished + NaN-angle vertices + handleHit-noop, [B] vortex inward + calm-eye-peaks-in-the-ring + rim-cutoff/protected + handleHit-noop, [C] static 3-field wire + gust angle in `newHazards`, [D] live loop — parked kart drifts downwind, **exactly one push/tick (not doubled)**, parked kart drawn toward the core, and the **escape regression: a kart flooring out from the dead centre drives clear of the well**.
- **Deferred polish:** custom in-game SFX (none — silent like batch-1 hazards); the editor selects/rotates both via the default disc handle (gust uses `config.radius` 80, not its true rect footprint) — fine for v1; force zones are still pushed into the collision quadtree (handleHit no-op) — harmless but slightly wasteful.

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
- 2026-06-13 — Batch 2 (Gust Fan 908 + Vortex Well 909) BUILT on worktree-hazard-batch2: config + registry + drawers + editor (palette `f`/`v` + paint/swatch) + AI (`isGust` counter-steer, `isVortex` core route-around) + headless test (`force-zones-test.js`, wired into CI) + CHANGELOG/Codex/ARCHITECTURE. Key finding: the "force-zone application path" already exists — `engine.narrowBase` fires `handleHit` every overlap tick, so a force zone is just a velocity-nudging `handleHit` (Dash Arrows pattern); **zero engine/compressor change**. `/codex:review` (high) run → 4 findings fixed with regression coverage (NaN-angle vertices, vortex core plateau, classifier↔AI consistency, editor placement pad). Full battery + build green; dev server hosted for playtest. **Not yet pushed / no PR** (awaiting operator go-ahead). Next: Batch 3 (Blink Fence + Crusher).

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
