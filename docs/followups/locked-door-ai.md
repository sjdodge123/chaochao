# Follow-up: teach bots to fetch keys + open locked doors

The locked-door + key feature shipped **without AI awareness** (it was scoped out deliberately). Bots currently path straight to the goal via the cell graph and ignore keys/doors entirely. On a locked-door map a bot-heavy room can stall: if a door walls off the only route to the goal and no human grabs the matching key, the bots will mill at the barrier until the round times out. This follow-up adds that awareness.

## What already exists (the contract you build on)

- **Map data**: `currentMap.doors: [{x,y}]` and `currentMap.keys: [{x,y}]` (authored, 1:1).
- **Runtime state** on `gameBoard` (built in `gameBoard.initLockedDoors`, `server/entities/gameBoard.js`):
  - `gameBoard.lockedDoors: [{ index, x, y, shape, voronoiId, originalId, unlocked }]`
  - `gameBoard.lockedKeys: [{ index, doorIndex, shape, x, y, carriedBy, used, consumed }]`
  - `gameBoard.hasLockedDoors` (bool)
  - door **home cells carry `c.tileMap.door.id`** until unlocked (then flip to `originalId`). The engine treats that id as a no-go wall (`engine.bounceOffLockedDoors`).
- **Per-tick resolution**: `Room.checkLockedDoors()` (`server/game.js`) handles pickup (proximity `c.lockedDoor.pickupRadius`), carry (key rides `player.heldKey`), drop on death/infection/finish, lava-consume, and unlock (carrier within `c.lockedDoor.unlockRadius` of the matching door). A carrier is marked by `player.heldKey = { keyIndex, doorIndex, shape }`.
- A key whose cell becomes lava during collapse is **consumed** (gone). There is **no failsafe auto-open** — the door only opens via its key.

## The AI work

In `server/aiController.js` (+ `server/cellGraph.js` as needed):

1. **Target a key when doors block the goal.** When `gameBoard.hasLockedDoors` and the bot's cell-graph path to the goal is blocked by a locked door cell (door id is a wall in the graph), retarget the bot to the **nearest loose, un-consumed key whose `doorIndex` matches a door on the blocking route** (or just the nearest loose key for v1). Walk onto it to pick it up — the existing `checkLockedDoors` proximity grants it; the bot just needs to *drive there*.
2. **Carry it to the matching door.** Once `bot.heldKey != null`, path to `gameBoard.lockedDoors[heldKey.doorIndex]` and drive within `unlockRadius`. The unlock then fires server-side and the door cell becomes passable, so the bot's normal goal pathing resumes.
3. **Re-path on unlock / drop.** When a door opens (cell flips to `originalId`) or the bot loses its key (death/infection), recompute. The cell graph must see the door cell as **walkable once unlocked** and **wall while locked** — confirm `cellGraph` reads live `cell.id` (it already blocks on lava/empty; add `door.id` to the blocked set).
4. **Don't fight over one key.** Light coordination so all bots don't beeline the same key (e.g. only the nearest N bots pursue; others hold or pursue a second pair). Keep it cheap.

Treat keys as **attractors** and locked doors as **walls** in the steering/penalty layer (mirror how boons are attractors and hazards are repellers — see the boon AI notes).

## How to validate (REQUIRED — A/B the harness)

Any `aiController`/`cellGraph` steering or pathing change must be A/B-checked through the fitness harness — see the headless-test-harness memory and `[[ai-bumper-crossing-feature]]` for precedent.

- **`.github/scripts/ai-fitness.js`** — run it `REPO_ROOT=<checkout> node .github/scripts/ai-fitness.js` against **two checkouts** (baseline `main` vs your branch) and compare multi-seed `finishers / frozen / medianDeathX / avgMaxX`. Control maps: crossroads / FastandSlow / IcyLake. **Add a door-map control case**: a small map with one door gating the goal + its key off to the side — assert bots actually finish it (baseline finishers ≈ 0, your branch > 0).
- **`.github/scripts/locked-door-test.js`** — the feature's engine test (pickup→carry→unlock, drop-on-death, lava-consume, goal-decoupling). Keep it green; extend it with a bot-driven scenario if useful.
- **`.github/scripts/smoke-test.js`** — must stay green (it ticks every committed map; none have doors yet, so this only guards regressions).

Watch for the known traps: `generateHash` needs **numeric** seeds; the cell graph must re-read live `cell.id` (a door that opened mid-round must become walkable); and don't introduce a stuck-probe beeline treadmill on the slow approach to a key (see the bumper-crossing `STUCK_SPEED_MAX` lesson).

## Status: LANDED

Implemented in `server/aiController.js` (objective layer: `computeDoorObjective` + the
per-tick coordination/lookup build in `update`) and `server/cellGraph.js` (the
`options.passableDoors` flag used to detect which doors block the goal). A walled bot
fetches the nearest matching loose key, carries it to the door (driving within
`unlockRadius` to fire the server-side unlock), then resumes goal pathing; light
coordination (`KEY_PURSUERS`) keeps the pack from dogpiling one key, and non-pursuers
stage at the door. Validated by the bot-driven scenario F in
`.github/scripts/locked-door-test.js` (baseline-impossible invariant + bots actually
finish) and an A/B of `ai-fitness.js` on the control maps (byte-identical — the change
is gated behind `gameBoard.hasLockedDoors`, so non-door maps are untouched).

Locked-door maps are now safe for bot-heavy rooms. There is still intentionally no
failsafe timer — the door only opens via its key.
