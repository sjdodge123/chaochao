# Lobby Tutorial — Analysis (WIP)

**Status:** Work in progress. This is a design/feasibility analysis, not an implementation.
We are still refining it; no production code has been changed.

## Goal

Build a "tutorial" experience directly into the game lobby with **no on-screen prompts or
text**. Instead, place a small set of curated map terrain elements in the lobby that players
can walk into and interact with, so they learn — purely by doing — the controls, the
objective, and the dangers (lava) before a real game ever starts.

## Decisions locked so far

1. **Option B — visual death + instant respawn.** Lava in the lobby should *look and feel*
   dangerous: the player gets the death feedback (sound/visual) and is immediately respawned.
   It must not be the weaker "physics only" version (too subtle) nor the full hazard sandbox
   (too much, griefing risk).
2. **Safe respawn.** Respawn must never place a player on lava. Use a **fixed safe spawn zone
   with jitter** (not raw random placement). This also governs the initial lobby spawn.
3. **Yellow goal tile.** Include a goal/finish tile (already gold/yellow in the engine) so
   players learn the victory condition by touching it — with win feedback + respawn, but
   without actually concluding/winning anything.
4. **No scoring in the lobby.** Neither touching lava nor touching the goal may change a
   player's score (notches). See "Scoring safety" below — this is the subtle part.
5. **Abilities fully active (curated subset).** Players can pick up *and fire* abilities in
   the lobby. **`swap` is dropped** (it teleports players around, disruptive while they're
   learning to move) and **`blindfold` is dropped** (darkens the screen, confusing without
   context). **`bomb` and `tileSwap` are intentionally kept** — they teach the ability
   controls (aim/fire), and their map mutation is accepted in exchange for the reset cadence
   (decision 8).
6. **All lobby SFX dampened uniformly.** Every lobby sound effect — abilities *and* the reused
   death/win cues — plays at a single reduced lobby volume so the whole lobby reads as
   practice, not a live round.
7. **Reuse in-game death/win feedback.** Lobby death and goal-win use the same explosion /
   finish-celebration cues as a real round (zero new assets, players learn the real cues),
   played at the dampened lobby volume from decision 6.
8. **Layered map-reset cadence.** Because `bomb`/`tileSwap` rewrite cells, the curated layout
   is restored via: (a) game start, (b) lobby (re)start, (c) lobby empties, and (d) an
   **idle-gated safety reset**: if the map differs from pristine *and* there's been no
   ability/projectile activity for **15s**, restore it. (Checked on a short tick; the 15s idle
   gate means active players are never interrupted, but a mutated-then-abandoned lobby
   self-heals 15s after the last ability use.)
9. **Respawn invulnerability: 2–3s, with a visual indicator.** After a lobby death or goal
   touch the player respawns invulnerable for ~2–3s, shown by **flashing the player or fading
   them in/out** so the state is legible. During invuln the player can't re-trigger
   lava/goal/ability damage.
10. **Safe-spawn zone is a protected sanctuary.** The spawn area is *totally* protected: its
    cells cannot be mutated by `bomb`/`tileSwap`/ice-cannon, projectiles/abilities/hazards
    have no effect inside it, and players standing in it take no collision damage. It is
    guaranteed-safe ground for both initial spawn and respawn, always.

---

## How the engine works (grounding facts)

### Maps are Voronoi-cell fields, not tile grids
Each map is a JSON file in `client/maps/*.json` with `cells` / `edges` / `vertices` geometry.
Every cell carries an `id` that is its **terrain type**. The catalog is in
`server/config.json` → `tileMap`:

| id | type | role |
|----|------|------|
| 0 | slow | sand — high drag, sticky |
| 1 | normal | dirt — baseline |
| 2 | fast | grass — low drag, faster |
| 3 | **lava** | hazard — instant death (unless on-fire/zombie) |
| 4 | ice | extremely low friction, slides |
| 5 | ability | spawner placeholder (resolved at load) |
| 6 | **goal** | finish tile — gold/yellow, triggers win |
| 8 | random | randomizer placeholder (resolved at load) |
| 100–108 | abilities | blindfold, swap, bomb, speed buff/debuff, tile swap, ice cannon, cut |
| 900/901 | bumper / movingBumper | hazard objects (separate `hazards` array) |

Physics is **server-authoritative** (`server/engine.js`). Both server and client load the
entire `client/maps/` directory at startup; a map is referenced by `id` and resolved locally.

### The lobby today is intentionally empty
- `GameBoard.startLobby()` (`server/game.js:1040`) spawns a single red `LobbyStartButton`
  circle at world-center and broadcasts only the button.
- `currentMap` is `{}`, so the client's `drawMap()` draws nothing.
- Players already move freely, collide with each other, and can punch in the lobby
  (`checkCollisions` lobby branch, `server/game.js:616-628`).
- The lobby world resizes to `worldWidth` × `worldHeight` (1366 × 768).

### Terrain collision is OFF in the lobby
`checkCollisions()` only calls `_engine.checkCollideCells()` in the `racing` / `collapsing`
branches (`server/game.js:651`). The `lobby` branch only does `preventEscape` + player/punch/
button collisions. **Loaded cells would be inert until this is changed** — this is the single
most important enabling change.

### What lava does today
`Player.handleHit()` for lava (`server/game.js` ~2179-2195): non-zombie, not-on-fire players
call `killSelf()` → `killPlayer()`.

### What the goal does today
`Player.handleHit()` for goal (`server/game.js:2202-2213`): sets `alive=false`,
`reachedGoal=true`, `timeReached`, and broadcasts `playerConcluded`. **Not state-gated** — it
would "conclude" a lobby player if collision were on.

### Abilities — what is and isn't gated
The ability *processing* loops (`checkAbilities`, `updateProjectiles`, `updateAimers`,
`game.js:678/742/768`) run **every tick regardless of state**; their lists are simply empty in
the lobby today. The actual gates are:

1. **Acquisition** — picking up an ability tile happens through cell collision in
   `handleHit` (ids 100–108). This only runs where `checkCollideCells` runs (`game.js:651`),
   so enabling lobby cell collision (change #3) makes ability pickup work in the lobby *for
   free*.
2. **Use / fire** — `checkAttack` only calls `ability.use()` in racing/collapsing
   (`game.js:1912-1918`). **Must be un-gated for the lobby** to fire abilities.
3. **Projectile → terrain** — snowflake/bomb cell collision is in the racing/collapsing
   branch (`game.js:661`). Needs lobby handling if ice cannon / bomb should reshape lobby
   terrain.

**Map-mutation consequence:** bomb (`changeTile` → slow), tileSwap (fast↔ice), and ice cannon
(freeze → ice) permanently rewrite `currentMap` cells. In a *persistent, shared* lobby this
slowly erodes the curated layout, so we need a reset strategy (see Risks).

### Spawn placement is terrain-blind
`spawnPlayerRandomLoc` → `findFreeLoc` → `getSafeLoc` (`server/game.js:1657-1665`) only keeps
the spawn inside world bounds, away from edges. It has **no awareness of terrain**, so it can
drop a player straight onto lava. This is why a fixed safe zone is required.

---

## Scoring safety (the subtle part)

Score is tracked as **notches** (`player.notches`, win at `notchesToWin`). There are several
score touchpoints, and the lobby plan must avoid all of them:

| Touchpoint | Where | Triggered by | Today's gate |
|---|---|---|---|
| `addNotch()` (goal score up) | `game.js:323-333` inside `checkForWinners()` | `reachedGoal == true` | `checkForWinners` only runs in racing/collapsing (`game.js:151-152`) |
| `survivalist` / `brutalist` ++ | `game.js:312-314` | `reachedGoal == true` | same |
| `addKill()` / streaks / first blood | `game.js:282-283` | `murderedBy` set by a kill | same |
| `removeNotch()` (death score down) | `game.js:2318` inside `killPlayer()` | any death | `killPlayer` early-returns outside racing/collapsing (`game.js:2308-2311`) |

**Key insight:** scoring is safe *today* only because the entire death/win machinery is
state-gated to racing/collapsing. **Option B deliberately punches a hole in that gate** to get
cosmetic death + respawn in the lobby. Therefore the new lobby code path must *explicitly*
avoid every touchpoint above rather than relying on the gate we are bypassing:

- Lobby lava death must **not** call `killPlayer()`/`removeNotch()`.
- Lobby goal touch must **not** set `reachedGoal`/`timeReached`, must **not** broadcast
  `playerConcluded`, and must **not** reach `addNotch()`.
- Punches already work in the lobby, but `checkForWinners` (which would convert a kill into a
  score) does not run there — leave that as-is, just don't enable it for the lobby.

**Design principle:** build one dedicated `respawnInLobby(player)` helper that resets
position / velocity / `alive` and clears transient flags, but never touches `notches`,
`reachedGoal`, `survivalist`, `brutalist`, or sends `playerConcluded` / `playerDied`-for-score.
Intercept lava and goal hits *in lobby state* before they reach any scoring-bearing code, then
route both through this helper after playing the appropriate (death vs. win) feedback.

---

## Curated lobby layout (proposed)

Authored in the existing map editor (`client/scripts/create.js` + `create.html`), saved as a
normal map JSON, sized to 1366 × 768, center kept clear for the start button:

- A small **lava pool** — the danger.
- An **ice** strip and a **sand (slow)** strip — controls/feel contrast.
- A **grass (fast)** lane — speed contrast.
- One **yellow goal** cell — the objective.
- A **safe grass spawn zone** (known coordinates) for initial spawn + respawn.
- (Optional, deferred) one ability tile; bumpers left out for v1.

---

## Change list

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 1 | Author tutorial lobby map (lava, ice/sand/grass, yellow goal, safe spawn zone, clear center) | editor → new map JSON | 0.5–1 day |
| 2 | Load tutorial map + button in `startLobby`; **exclude from race rotation** | `game.js`, `utils.js` | ~2 hrs |
| 3 | Enable `checkCollideCells` for lobby state | `game.js:616-628` | ~30 min |
| 4 | Render map client-side during lobby | `client.js:162`, `draw.js:275` | ~1 hr |
| 5 | Lobby-aware **lava**: death cosmetics + respawn, **no `killPlayer`/`removeNotch`** | `game.js` (lava `handleHit`) | ~0.5 day |
| 6 | Lobby-aware **goal**: win cosmetics + respawn, **no `reachedGoal`/`playerConcluded`/`addNotch`** | `game.js:2202-2213` | ~2 hrs |
| 7 | Fixed safe-spawn zone w/ jitter (initial + respawn) — **protected sanctuary: no cell mutation, no projectile/ability/hazard effect, no collision damage inside it** | `game.js` (spawn path, collision/mutation guards) | ~0.5 day |
| 8 | Shared `respawnInLobby(player)` helper used by 5 & 6 | `game.js` | (folded into 5/6) |
| 9 | **2–3s respawn invulnerability** + **flash/fade visual** (client) after lobby death or goal touch | `game.js` (`respawnInLobby`), `draw.js` (flash/fade) | ~0.5 day |
| 10 | **Un-gate `ability.use()` for lobby** in `checkAttack`; **exclude `swap` and `blindfold`** from lobby ability pool | `game.js:1912-1918`, ability spawn | ~2 hrs |
| 11 | **Lobby projectile→terrain collision** (ice cannon / bomb reshape) | `game.js:661` | ~2 hrs |
| 12 | **Dampen ALL lobby SFX uniformly** (single lobby volume scalar) | `client/scripts/audio.js` | ~2 hrs |
| 13 | **Layered map-reset cadence** — game-start / lobby-(re)start / lobby-empty / **15s idle-gated** safety reset; reset = reapply pristine cell ids + broadcast `tileChanges` | `game.js` (`startLobby`, reset helper, timer) | ~0.5 day |
| 14 | Multiplayer testing (concurrent deaths, spawn stacking, griefing tolerance, no score drift, map-mutation recovery) | — | ~0.5–1 day |

**Total: ~3.5–4.5 days** — fully-active abilities + map-reset + SFX work added ~1–1.5 days on
top of the movement/lava/goal core.

### Map-rotation leakage gotcha
`loadMaps()` (`server/utils.js:303`) ingests *everything* in `client/maps/`, so a tutorial map
placed there would leak into the random race rotation. Exclude it by name/flag in
`determineNextMap()` (`game.js:1195`), or store it outside that folder and `require` it
explicitly.

---

## Risks / things to test hard

- **Shared lobby, not per-player.** The tutorial is a communal sandbox; rules out per-player
  scripted sequences. Several players can hit lava/goal in the same tick and all respawn at
  once — the safe zone needs jitter so they don't stack.
- **Spawn safety** must cover both initial spawn and respawn.
- **Stale flags** — make sure no lobby interaction leaves `reachedGoal` / `alive=false`
  lingering when the real game starts.
- **Score drift** — verify notches are byte-for-byte unchanged after a lobby session full of
  lava deaths, goal touches, and ability use (incl. punch/cut knocking players into lava).
- **Map mutation in a persistent shared lobby** — bomb/tileSwap/ice-cannon rewrite cells, so
  the curated layout degrades over a long-lived lobby. Need a reset strategy (change #13):
  reload the pristine lobby map on a cadence, or on lobby (re)entry, or when it empties.
- **Griefing tolerance** — fully-active abilities in a shared lobby are accepted by design
  (swap teleports, speed debuff affects everyone). Watch that it stays fun, not disruptive.

---

## Open questions (to refine)

- Exact safe-spawn zone coordinates depend on the final authored layout.
- Flash vs. fade for the invuln indicator (change #9) — pick during implementation/eyeballing.

### Resolved
- ~~Map-reset cadence~~ → layered: game-start / lobby-(re)start / lobby-empty / **15s**
  idle-gated safety reset (decision 8).
- ~~SFX dampening scope~~ → all lobby SFX dampened uniformly (decision 6).
- ~~Abilities present-but-inert vs active~~ → fully active, curated subset; `swap` and
  `blindfold` dropped; `bomb`/`tileSwap` kept to teach controls (decision 5).
- ~~Feedback reuse~~ → reuse in-game death/win cues at lobby volume (decision 7).
- ~~Respawn cooldown length~~ → 2–3s invuln with flash/fade indicator (decision 9).
- ~~Safe-spawn protection level~~ → fully protected sanctuary (decision 10).
