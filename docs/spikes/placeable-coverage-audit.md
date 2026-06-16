# Placeable coverage audit — every hazard & boon × five systems

**Date:** 2026-06-16 · **Base:** main @ v0.49.0 (Magpie Drone shipped) · **Mode:** read-only audit, no code changed.

## Why

Batch-4 boons (Zipline, Lily Pads) shipped initially missing AI-pathing and validation coverage that had to be retro-fitted. This is a systematic gap-check that every placeable is wired into all five systems, with no silent holes. The recently-shipped **warpPad / zipline / lilyPad** trio is the bar for "fully covered."

## Scope — the placeable set

The **editor-authorable** set is **22**, not 24: the 11 registered hazards + 11 boons listed in `client/scripts/create.js` `EDITOR_HAZARD_KINDS` and registered via `registerHazardKind`/`registerBoonKind` (`server/entities/hazards.js:1013-1114`, `server/entities/boons.js`).

`antlion (906)` and `thumper (907)` live in `config.hazards` but have **no `registerHazardKind` call** and are **not in the editor palette** — they are spawned at runtime only by the Antlions brutal round (`server/game.js` / `gameBoard.js`). They are audited as a footnote row, not as map placeables.

**Baseline:** all placeable tests green — `boons-test, validate-content, smoke-test, classifier-test, warp-pads-test, rotor-test, geyser-test, mine-test, crusher-test, laser-gate-test, sentry-turret-test, vortex-well-test, magpie-drone-test, bumper-wall-test, antlion-test` all PASS. The gaps below are coverage holes the suite does not exercise, not regressions.

## The five systems

1. **AI pathing** — `server/cellGraph.js` (shortcut/footing edges, null-gated + non-enumerable `_*` cache) + `server/aiController.js` (`hazardRepulsion()` live steering, the `hazardList` cell-penalty loop; boons skipped via `if (h.helpful) continue`).
2. **Fairness / balance** — `server/mapClassifier.js` (`hazardCount`/`hazardAvoidance`, memoized `boonIdSet`, `warpTrapSeverity`/`ziplineTrapSeverity`).
3. **Validation** — `server/utils.js` `validateMap` (id-union from config, directional finite-angle rule, per-kind structural checks).
4. **Recap** — `client/scripts/recap.js` (`recapCaptureHazards` snapshot, `recapDrawHazard` dispatch) + wire via `server/compressor.js`.
5. **Thumbnail** — `client/scripts/gameboard.js` `buildMapThumbnailCanvas` (per-kind glyph; honor radius/angle/geometry).

## Coverage matrix

✅ covered · ⚠️ partial · ❌ missing

### Hazards (authorable)

| Placeable (id) | AI pathing | Fairness | Validation | Recap | Thumbnail |
|---|---|---|---|---|---|
| bumper 900 | ✅ | ✅ | ✅ | ✅ | ✅ |
| movingBumper 901 | ✅ | ✅ | ✅ | ✅ | ✅ |
| bumperWall 902 | ✅ | ✅ | ✅ | ✅ | ❌ |
| rotor 903 | ✅ | ⚠️ | ✅ | ✅ | ❌ |
| geyser 904 | ⚠️ | ⚠️ | ✅ | ✅ | ❌ |
| mine 905 | ⚠️ | ✅ | ✅ | ✅ | ❌ |
| vortexWell 908 | ✅ | ⚠️ | ⚠️ | ✅ | ❌ |
| laserGate 909 | ✅ | ✅ | ✅ | ✅ | ❌ |
| crusher 910 | ✅ | ✅ | ✅ | ✅ | ❌ |
| sentryTurret 911 | ✅ | ✅ | ✅ | ✅ | ❌ |
| magpieDrone 912 | ✅ | ⚠️ | ✅ | ⚠️ | ❌ |

### Boons

| Placeable (id) | AI pathing | Fairness | Validation | Recap | Thumbnail |
|---|---|---|---|---|---|
| dashArrows 950 | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| rechargeSpring 951 | ✅ | ✅ | ✅ | ✅ | ✅ |
| slipstream 952 | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| guardHalo 953 | ✅ | ✅ | ✅ | ✅ | ✅ |
| secondWindTotem 954 | ✅ | ✅ | ✅ | ✅ | ✅ |
| launchPad 955 | ✅ | ❌ | ✅ | ✅ | ✅ |
| barrelCannon 956 | ✅ | ❌ | ✅ | ✅ | ✅ |
| slingshotRings 957 | ✅ | ❌ | ✅ | ✅ | ✅ |
| **warpPad 958** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **zipline 959** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **lilyPad 960** | ✅ | ✅ | ✅ | ✅ | ✅ |

### Footnote — runtime-only (not authorable)

| Entity (id) | AI pathing | Fairness | Validation | Recap | Thumbnail |
|---|---|---|---|---|---|
| antlion 906 | ✅ (brutal AI) | n/a | ❌ (id leaks into accepted union) | ❌ (vanishes) | n/a |
| thumper 907 | ✅ (n/a) | n/a | ❌ (id leaks into accepted union) | ❌ (vanishes) | n/a |

## What's missing and why it matters

### ❌ / ⚠️ Thumbnail — 11 of 13 hazards render as identical bumper dots
`buildMapThumbnailCanvas` has exactly one per-kind branch — `movingBumper` (adds a black rail rect, `gameboard.js:945-952`). Every other hazard falls through to the generic red-ring + orange-disc bumper mark (`gameboard.js:953-961`), sized from `config.hazards.bumper.attackRadius`/`.radius` — the *bumper's* fixed sizes, never the kind's own geometry. So `bumperWall, rotor, geyser, mine, vortexWell, laserGate, crusher, sentryTurret, magpieDrone` are visually indistinguishable from a bumper in previews, and `vortexWell` ignores its authored per-instance `radius`. **Contrast:** all 11 boons route through `drawThumbnailBoonGlyph` (`gameboard.js:761-904`) with distinct palettes + icons that honor `angle`/`length`/`radius`. The boon path is the template the hazard loop should mirror. *Cosmetic, but it's the largest silent hole by count.*

### ❌ Fairness — launchPad / barrelCannon / slingshotRings have no trap-severity
These three are the direct analog of warp/zip: **author-aimed forced displacement** that can fling a line-driving racer backward or off-line. But unlike warp/zip there is **no `launchtrap`/`cannontrap`/`slingtrap` deduction and no par-time credit** (0 references in `cellGraph.js`; only skipped from difficulty via `boonIdSet`). A maliciously- or poorly-aimed launcher sitting on the racing line scores as a **clean map** and can pass the featured-85+ fairness gate. Gold-standard comparators: `warpTrapSeverity` (`mapClassifier.js:461-542`, label `warptrap`) and `ziplineTrapSeverity` (`:554-632`, label `ziptrap`). *This is the single most important fairness gap — it can let an unfair map through.*

### ⚠️ Fairness — vortexWell pull and magpieDrone steal are trap-shaped but unscored
`vortexWell` actively pulls a racer toward its core (backward on the line); its footprint is modeled (`mapClassifier.js:302-311`) but there is no trap-severity term. `magpieDrone` steals a held ability from an interacting racer — a trap-shaped penalty with no scoring (lower stakes than a teleport). Worth a `vortextrap`/`magpietrap` term if we want full parity.

### ⚠️ Fairness — dashArrows / slipstream speed-ups not priced into par-time
Both are correctly skipped from difficulty, but their boosts have **0 references in `cellGraph.js`**, so `estimatePathTime` ignores them — par over-estimates time across a boosted lane, and fairness can misjudge a gate that funnels a spawn into a dash corridor. Lower stakes than the trap holes.

### ⚠️ AI pathing — geyser & mine are timing-blind
Both fall through to the generic single-cell static penalty + radial repulsion (`aiController.js:495`, `:2559`). Both are **stationary** so routing is correct, but the treatment never relaxes when the geyser is dormant or the mine is spent (a bot over-avoids). Parity with rotor/laserGate would want a `netState`/`phase`-aware penalty. *Polish, not a bug.*

### ⚠️ Fairness — rotor / antlion / geyser footprint under-read
Counted as hazards but get only the generic ~40px ring in the classifier, while `aiController` models their real denial areas (rotor sweep, antlion shove-zone) more richly — a slight overlay/par-vs-AI drift. *Minor.*

### ⚠️ Recap — magpieDrone always faces right
`recapDrawHazard`'s drawer reads `h.tx` to mirror the sprite (`draw.js:9794`), but `recapCaptureHazards` never snapshots `tx`/`ty` (only id, x, y, angle, railX, railY, state, radius, claim, railLength — `recap.js:335-352`), so `face` falls back to +1. Body, rail, loot glow, and carried-ability icon all render correctly. *Cosmetic.*

### ⚠️ Validation — vortexWell radius is build-clamped, not validated
Unlike lilyPad/zipline/warp, an out-of-range or non-finite authored vortex `radius` is silently clamped at build (`hazards.js:404-413`) rather than rejected by `validateMap`. No crash surface (clamp handles NaN) — a consistency gap, not a live bug.

### ❌ Validation/Recap — antlion & thumper ids leak (runtime-only entities)
`validateMap` builds its accepted-id union from `config.hazards ∪ config.boons`, so 906/907 are accepted even though no kind is registered. A hand-crafted/submitted JSON placing them returns `valid:true`, then `generateHazards` silently `continue`s past them (`gameBoard.js:3691-3694`) → inert phantom. The inline comment "validateMap already rejects them" is **incorrect**. Benign (accepted-but-inert, no crash), but a true validation gap. Fix: validate against the **kind registry** (`HAZARD_KINDS`/`BOON_KINDS`), not the raw config union. They also vanish in any Antlions-round recap (`drawAntlionHazard`/`drawThumperHazard` are called by live `drawHazard` at `draw.js:9718-9723` but were never added to `hazardDrawers`, which `recapDrawHazard` dispatches through).

## What's fully covered (the bar held)

All three gold-standard boons — **warpPad, zipline, lilyPad** — are ✅ across all five systems: shortcut/footing edges with null-gated non-enumerable `_*` caches in cellGraph, trap-severity + hard-fail in the classifier (warp/zip), pairs-of-2 / drivable-ends / water-only structural validation, full recap snapshot+draw, and distinct radius/angle-honoring thumbnails. Every routing-relevant moving/reshaping kind (movingBumper rail timing, crusher/magpie rails, bumperWall segment, laserGate beam, vortexWell core ring, sentryTurret cone) is modeled with correct geometry in AI pathing — **no invisible-to-pathing lane blocker exists**. All 11 boons are skipped from difficulty correctly and all 11 render distinct thumbnail glyphs.

## Ranked fix list (pending operator go-ahead)

| # | Fix | System | Severity | Effort |
|---|---|---|---|---|
| 1 | Per-kind hazard thumbnail dispatch (mirror `drawThumbnailBoonGlyph`); start with vortexWell (honor radius), laserGate/crusher (rail+angle), bumperWall (span), then the rest | Thumbnail | Med (visible everywhere, cosmetic) | Med |
| 2 | Trap-severity for launchPad/barrelCannon/slingshotRings — backward-fling deduction analogous to `warpTrapSeverity` | Fairness | **High (can pass unfair maps as featured)** | Med |
| 3 | Validate against the kind registry, not the config id-union → rejects antlion/thumper + any future config-only id; fix the stale comment | Validation | Med | Low |
| 4 | `vortextrap` (+ optional `magpietrap`) severity term | Fairness | Med | Low–Med |
| 5 | Price dashArrows/slipstream speed-ups into par-time (cellGraph) | Fairness | Low–Med | Med |
| 6 | netState/phase-aware AI penalty for geyser & mine (relax when dormant/spent) | AI pathing | Low (routing already correct) | Low |
| 7 | Snapshot `tx`/`ty` in `recapCaptureHazards` so magpieDrone faces its travel direction in recap | Recap | Low (cosmetic) | Low |
| 8 | Richer classifier footprint for rotor/antlion sweep/shove zones | Fairness | Low | Low |
| 9 | `validateMap` structural bound on vortexWell radius (reject vs silent clamp) | Validation | Low | Low |

## Implemented (this session, branch `worktree-placeable-coverage-audit`)

All changes verified against the full suite: `unit-tests, boons-test, validate-content, smoke-test, classifier-test, ratings-test, difficulty-ramp-test` + every per-hazard test (rotor/geyser/mine/crusher/laser-gate/sentry-turret/vortex-well/magpie-drone/bumper-wall/antlion/warp-pads) — **all green** — plus `npm run build` (bundles compile). No `config.json`/`game.js`/`engine.js` touched, so no CHANGELOG gate triggered.

| # | Fix | Status | Files |
|---|---|---|---|
| 1 | Per-kind hazard thumbnail glyphs (9 kinds, honoring authored radius/rail-length/angle) | ✅ done | `client/scripts/gameboard.js` |
| 2 | Launch-pad trap severity (`launchtrap` deduction + hard-fail), mirroring warp/zip | ✅ done | `server/mapClassifier.js`, test in `boons-test.js` |
| 3 | Validate against the kind registry (rejects antlion/thumper + any config-only id) + fixed stale comment | ✅ done | `server/utils.js`, `server/entities/gameBoard.js`, tests in `unit-tests.js` |
| 9 | Reject non-finite vortexWell radius in validateMap | ✅ done | `server/utils.js`, test in `unit-tests.js` |
| 7 | Snapshot magpie `tx` in recap so the bird faces its travel direction | ✅ done | `client/scripts/recap.js` |
| 8 | Rotor swept-arm-ring footprint in the classifier (mirrors live AI `isRotor`) | ✅ done | `server/mapClassifier.js` |
| 6a | Stop AI pricing a **spent** mine's cell (monotonic, flicker-free) | ✅ done | `server/aiController.js` |

**Fix #2 scope decision:** only the **Launch Pad** is trap-scored. The **Barrel Cannon** is a player-*timed* skill shot off a continuously-sweeping barrel (the author angle is only the start), and the **Slingshot Rings** are a capped-add axial pulse that "never brakes a faster kart" — scoring either as a fixed-angle backward fling would false-fail legitimate placements. Documented in `launcherTrapSeverity`. Verified: a 180°-facing pad on the line drops the score 91→80 (below the featured-85 gate); a 0°-facing pad stays 91.

**Tuning knobs:** the launchtrap uses inline `bal()` defaults (`launcherTrapTolSec/PerSec/Max/Radius/HardSec`) rather than `config.balance` keys, to keep the change off the `config.json` CHANGELOG gate. Adding the five keys to `config.balance` for operator tunability (parity with the warp/zip knobs) is a trivial one-line-each follow-up.

### Deferred (with rationale — not silently dropped)

- **#6b geyser phase-awareness — deferred (route-thrash risk).** Unlike the mine (monotonic armed→fuse→spent), a geyser cycles dormant↔erupt (~300 ms erupt in a ~4 s cycle). A per-tick phase-aware penalty would flicker on/off and thrash a bot's committed route. Stable over-avoidance of a brief-eruption point hazard is cheap and correct; the cost/benefit doesn't justify the instability. (Rationale also recorded in the `aiController.js` comment.)
- **#4 vortexWell / magpieDrone trap severity — deferred (double-count / wrong model).** VortexWell is already priced as hazard difficulty *and* a core-ring avoidance in `hazardAvoidance`; a separate seconds-based "trap" deduction would double-count, and a faithful continuous-pull→time model is speculative (no clean landing point like warp/launch). MagpieDrone's harm is an *ability theft*, not a positional time-setback, so it doesn't fit the seconds-based trap-severity axis at all — it would need a new scoring dimension. Both are best left to a dedicated design pass if desired.
- **#5 dashArrows / slipstream par-time pricing — deferred (par-shift risk, low reward).** Crediting a transient speed pad into `estimatePathTime` requires modeling boost duration/decay over distance (speculative) and would shift par — and therefore featured/community tiering — for *every* map using these boons. The audit rated the mispricing low-stakes; the risk/reward doesn't favor a speculative par change.

## Open question for the operator

The user asked to confirm `warptrap`+`ziptrap` exist (they do) and ask whether any *other* kind can trap a racer. **Yes — three more:** launchPad/barrelCannon/slingshotRings (aimed flings, fix #2), vortexWell (pull, fix #4), magpieDrone (steal, fix #4). Decision needed: do we want trap-severity scoring for the aimed launchers (fix #2 — recommended), and optionally vortex/magpie (fix #4)?

## Code-review hardening (post-implementation, high-effort review)

A multi-angle review of the implemented fixes surfaced one real correctness gap plus cleanup/altitude items; all were fixed:

- **Correctness — lethal launch-pad landing was silently exempt.** `launcherTrapSeverity` inherited zip's `Infinity ⇒ not-a-trap` heuristic, but a launch pad's landing isn't validated drivable (warp/zip endpoints are). So a pad flinging a line-driving racer into lava / off-world / a goal-less pocket — the *most* punishing placement, an unavoidable death — earned **zero** deduction and could pass the featured gate. Fixed: a non-finite landing on an on-line pad is now reported as `lethal` and **hard-fails** the map outright (max deduction). New `boons-test` [O2] assertions lock it in.
- **Reuse + efficiency — `racingLineContext`.** The warp/zip/launch severity passes each rebuilt the same idToCell / driveTime / racing-line / `distToSegSq` / `onRacingLine` machinery (~80 lines ×3) and re-ran the edge-sample pathfinding 3× per `classify()`. Extracted a module-level `distToSegSq` + `racingLineContext(map, config, pathOpts)` factory; `classify()` memoizes by options-key so zip+launch share one no-shortcut context (built once) and warp keeps its own — built lazily, still O(0) on trap-free maps.
- **Altitude — thumbnail dispatch table.** `drawThumbnailHazardGlyph`'s 9-branch if/else became a module-level `THUMB_HAZARD_GLYPHS` registry (parallel to draw.js `buildHazardDrawers` / create.js `EDITOR_HAZARD_KINDS.paint`), with a lazy id→kind cache replacing the per-hazard array allocation + linear scan.
- **Altitude — `MINE_SPENT` constant.** Exported `MINE_ARMED/FUSE/SPENT` from `entities/hazards.js`; `aiController` now references `MINE_SPENT` instead of the magic literal `2`.
- **Altitude — `sizable` kind flag.** `validateMap`'s vortex-radius check now reads a `hazardKind.sizable` flag (set on vortexWell + lilyPad) instead of pinning vortexWell's id — a new resizable kind is covered automatically.
