# Water tile

A new terrain type: **water**. You barely drift in deep water on your own — to move you
**punch to swim** (each stroke shoves you in the held direction). Water is a risk/reward
shortcut, extinguishes your killstreak flame, leaves you "dripping wet" on exit, and where
it meets lava the edge is an impassable **stone wall**. Shipped as a single feature
(branch `worktree-feat-water-tile`).

## Design decisions (operator calls)

- **Swim stroke hits + costs stamina.** Swimming reuses the punch (`throwChargedPunch`), so
  a stroke still knocks rivals back and spends stamina; water's high drag dampens both ends
  (no special-case code).
- **Direction = held movement dir**, not aim (`getMoveDir()` from the move booleans).
- **Stone edge is edge-only**, not whole-cell: only the water↔lava shared Voronoi edges are
  walled (reusing the empty-cell rim slide), with a distinct stone-ledge render. Water is
  otherwise fully walkable.
- **Dripping:** 0.6× drive for 800 ms after leaving water (`water.dripMoveFactor` /
  `water.dripMs`). Visual lingers ~1.2 s (sheen + splash + droplets).
- **Zombies cannot enter water** — it's an empty-tile/hole to them (they can't swim; their
  bite is a separate, swim-less path). They bounce off the rim.
- **AI avoids water** by routing weight (`cellGraph.tileWeight` water ≈ 13× grass) — it
  can't swim yet, so it takes dry detours; water is never *blocked* (maps stay reachable).
- **Ability interactions:** Bomb does NOT sand-over water (skipped). Ice Cannon **freezes**
  water→ice (kept; thematic + counterplay). Volcano/explosive lava **overruns** water
  (kept). Tile Swap never touches water. Collapse turns water→lava (end-game).
- **Orbital Beam ability (ice→water) deferred** — see follow-up below.

## Config knobs (`server/config.json` → `tileMap.water`, id 11)

`acel` 55, `dragCoeff` 0.32 (near-zero passive drift) · `swimImpulse` 205 (per-stroke
velocity, capped by `playerMaxSpeed`) · `swimChargeBonus` 0.5 · `dripMs` 800 ·
`dripMoveFactor` 0.6 · `canBeRandomed` false (the `random` tile never rolls water in v1).

## Where it lives

- **Server physics:** `player.js` `handleMapCellHit` water branch (footing stamp, fire
  extinguish, drip-on-leave) + `getMoveDir`/`throwChargedPunch` swim impulse;
  `engine.js` `updatePlayers` drip drive-cut.
- **Stone edge:** `engine.js` `ensureStoneEdges` (compute-once cache) + `bounceOffStoneEdges`,
  wired in `gameBoard.js` lobby + racing collision passes.
- **Zombie no-go:** `engine.js` generalized `bounceOffNoGoCells` (empty holes + zombie
  water) + `bounceZombieOffWater`.
- **AI:** `cellGraph.js` `tileWeight`.
- **Client:** `draw.js` procedural water texture, swim ripples (`drawSwimRipple`, water-clip
  + per-vertex filter), stone-seam ledge (`drawStoneBorders`), dripping-wet
  (`updateWaterDrip`/`drawWaterDrip`); `audio.js` synthesized `playFlameExtinguish`;
  `client.js` `flameExtinguished` handler; `create.js`/`create.html` editor Water tile.

## Non-obvious gotchas (read before touching)

- **Stone seams are compute-once cached but VALIDATED LIVE.** `_stoneEdges` is built once
  (cheap, no per-collapse recompute), but each seam stores its water + lava cell refs and
  `bounceOffStoneEdges` re-checks their live `id` before walling. This is what stops a
  terrain mutation (ice cannon freezing water→ice, collapse, lava explosion) from leaving a
  **stale invisible wall** where the water no longer exists. New water/lava adjacencies
  formed at runtime get NO new seam — accepted (those only happen mid-collapse/volcano,
  i.e. kill phases). (Caught by Codex review.)
- **Swim ripple coordinate space:** drawn in the camera-translated gameplay pass → raw world
  coords (like `drawPlayer`), NOT `+camera.getCameraX()`. The water clip Path2D is in the
  same world space.
- **Swim ripple is water-CLIPPED, not just vertex-filtered.** The per-vertex filter stops
  rings being *seeded* on land; the Path2D clip stops the *expanding* rings spilling past
  the shoreline. Both are needed. Ripple is a fixed pale-water color (not player color) and
  NOT gated on currently-being-on-water, so it fades out as over-water verts age instead of
  snapping off at the shoreline.
- **Trails only sample in racing/overview/collapsing**, so swim ripples don't show in the
  lobby (no trail data). The drip does NOT need a trail and runs in every state.
- **Swimming ≠ a separate action.** It's the punch. Zombies bite via `throwBite` (no swim
  impulse) — that's *why* they can't swim, and why water-as-hole is the chosen behavior.
- **Lobby map** (`_lobbyTutorial.json`) has a 5-cell water pool against the lava (teaching
  corner). Don't tighten cell-id validation past `typeof number` (station sentinels 102–108).

## Deferred follow-ups (operator-injectable prompts)

### 1. Teach AI to punch-swim

> In the chaochao water-tile feature, bots currently AVOID water (`cellGraph.tileWeight`
> weights it ~13× grass) because they can't swim — their navigation sets `targetDirX/Y`, not
> the move booleans `getMoveDir()` reads, and their bite (`throwBite`) has no swim impulse.
> Teach the AI to swim: when a bot is on water (`onWater`), have it punch/stroke toward its
> path carrot (set the move booleans or give `throwBite`/a bot-swim path the same
> `swimImpulse` in the held/target direction), and lower water's `tileWeight` so bots will
> route through water shortcuts when genuinely faster. Verify headlessly that a bot completes
> a water-only crossing (the `SwimTest`-style map with the dry detour removed) so a pinned
> water playlist can't stall a round. Keep humans' feel unchanged.

### 2. Orbital Beam ability (ice → water)

> Add an "Orbital Beam" ability to chaochao (next free id after `starPower` 109, so 110) that
> converts ICE tiles to WATER in an area — modeled on `iceCannon`/`tileSwap` (aimed strike or
> AoE at the holder; pick one and note it). It should only convert ice (`tileMap.ice.id` →
> `tileMap.water.id`), broadcast the tile change in lockstep (server `tileChanges` +
> client `gameboard.js` handler), and the new water must immediately get correct stone seams
> vs adjacent lava — note that `_stoneEdges` is compute-once + live-validated, so newly
> created water won't auto-grow a seam; decide whether Orbital Beam needs to invalidate/extend
> `_stoneEdges` for the affected cells. Add the icon, a synthesized SFX, a CHANGELOG bullet,
> and a headless test. This was scoped out of water-tile v1.
