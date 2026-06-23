# Follow-up: rebase barrier-map *validation* on a free-space flood-fill oracle

**Status:** deferred follow-up (not urgent — no committed map has barriers today).
**Owner decision (2026-06-20):** ship the current hardened doorway model now; do this swap before/when the first real barrier map is submitted.

## Why

`server/cellGraph.js` does two jobs:

1. **Reachability / validation** — "can a thick kart physically get from a start edge to the goal?" (`utils.validateMap` → `firstUnreachableStartEdge`; the map-submission validator).
2. **Routing** — the racing line: AI waypoints + the fairness overlay (tile-weighted Dijkstra with warp/zip/lily edges, hazard penalties, boon attraction, `goalSet`, `passableDoors`, per-bot noise).

A 5-round adversarial Codex review of the thickness-aware barrier work found **10 issues, all in job #1** — every one a place the Voronoi-**doorway** abstraction failed to match free-space truth:

- single widest crossing per border (missed the gap on the other side of a wall — incl. split goal cells reading reachable);
- doorway rim points clipped past the world boundary read as drivable;
- a sealed split-cell start mapped to the site's region (false reachable);
- door-adjacent doorways dropped from the cached nav graph;
- partial-wall split / crossing-clearance tuning.

All are fixed (commits on `fix-unify-map-validation`), but the pattern is clear: **the doorway model is the wrong abstraction for the reachability VERDICT.** Each fix is a patch on geometry that has more edge cases.

## The durable fix (job #1 only)

A rasterized **free-space flood fill** IS the ground truth and has none of these edge cases:

- Grid the world (STEP ~2–3px). A cell is BLOCKED if its nearest map cell is lava/empty/door, OR it's within `clear`(=BARRIER_HALF_WIDTH 7 + kart radius 7.5 = 14.5) of any barrier capsule centre-line, OR within kart-radius of a lava/empty edge (sample a radius-R disc), OR outside the world.
- 4-connected BFS from each start-edge sample; the goal is reachable iff its free cell is in the same component.
- Reference implementation lived in the verification script used during the fix (the "rigorous oracle" — ~50 lines). Re-derive from this spec.

Make THIS the authority for `validateMap`/submission reachability (gated on `map.barriers`; barrier-free maps keep the existing identity path unchanged). Keep `findPathToNearestGoal`/the doorway graph for the **racing line** — it carries the tile-cost/shortcut/hazard/boon/door machinery a grid can't easily express.

## The one consistency rule to honour

A map the oracle PASSES must be one the doorway router can still navigate, or bots stall on a validated map (the original D-Day failure). In practice the AI's stuck/beeline escape behaviours (`steerBot`) cover the residual gap — the racing line may be imperfect where the doorway graph under-connects, but that's cosmetic, not a correctness/validation bug. Don't gate validation on the doorway router ALSO finding a path (that reintroduces its under-connect false-rejects); the oracle alone is the reachability gate.

## Cost / scope

Bounded, mostly additive: ~the oracle module + wiring into the validation path; cache the grid per map (build is ~30–100ms for a barrier map — fine for CI/submission, not for per-tick, so keep it out of live routing). Only barrier maps are affected.

## Operator-injectable follow-up prompt

> Implement the barrier-map validation oracle described in `docs/spikes/barrier-validation-oracle.md`: add a rasterized free-space flood-fill reachability check (gated on `map.barriers`) and make it the authority for `utils.validateMap`/`firstUnreachableStartEdge` and the map-submission validator, while leaving `findPathToNearestGoal`/the doorway graph as the racing-line source. Keep the 53 barrier-free committed maps byte-identical and ai-fitness control maps unchanged; add a barriers-test case where the doorway model and the oracle would disagree (a wall leaving a sub-kart gap, and a split goal cell) and assert the oracle verdict. Verify against a real submitted barrier map if one exists.
