# Lobby Tutorial — Analysis

**Status:** ✅ Implemented. This document was the design/feasibility analysis; the feature is now
built on branch `worktree-lobby-tutorial-analysis` (see "Implementation status" near the end for
the per-change breakdown). Original analysis prose is preserved below for context.

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
5. **Abilities active (curated subset).** Players can pick up *and fire* abilities in the
   lobby. **Dropped: `swap`** (teleports players, disruptive while learning to move),
   **`blindfold`** (darkens screen, confusing without context), and **`tileSwap`** (GLOBAL —
   one fire swaps every fast↔ice cell on the whole map, wrecking the curated layout; bomb
   teaches aim/fire with far less collateral). **Kept: `bomb`** (the primary teaching
   ability) plus `iceCannon`, `speedBuff`, `speedDebuff`, `cut`. With tileSwap gone, the only
   remaining map-mutators are **bomb and ice cannon, both *local*** — so layout churn is minor
   and the reset cadence is lighter-duty.
   - **Authoring note (deep scan):** the ability pool (`allAbilityIDs`) is built once in the
     constructor and shared by *all* states, so you can't drop abilities via a config
     `spawnable` flag without removing them from real races. Instead **hard-code the curated
     ability tile ids directly in the lobby map JSON** (e.g. `102` bomb) rather than the
     `id:5` placeholder — bypasses the random pool, gives deterministic tutorial placement.
   - **Replenishment (decision: fast lobby-only respawn).** Picking up an ability tile
     rewrites it to `normal` (`changeTile` on pickup), so each tile is one-shot. Add a
     **lobby-only timer that restores a consumed ability tile** after a short delay so every
     player — not just the first per cycle — can learn each ability. (See change #18.)
6. **All lobby SFX dampened uniformly.** Every lobby sound effect — abilities *and* the reused
   death/win cues — plays at a single reduced lobby volume so the whole lobby reads as
   practice, not a live round.
7. **Reuse in-game death/win feedback.** Lobby death and goal-win use the same explosion /
   finish-celebration cues as a real round (zero new assets, players learn the real cues),
   played at the dampened lobby volume from decision 6.
8. **Layered map-reset cadence.** Because `bomb`/`ice cannon` locally rewrite cells, the
   curated layout is restored via: (a) game start, (b) lobby (re)start, (c) lobby empties, and
   (d) an **idle-gated safety reset**: if the map differs from pristine *and* there's been no
   ability/projectile activity for **15s**, restore it. (Checked on a short tick; the 15s idle
   gate means active players are never interrupted, but a mutated-then-abandoned lobby
   self-heals 15s after the last ability use.) With tileSwap dropped (decision 5) the
   mutations are now *local* only, so this is lighter-duty than originally scoped.
9. **Respawn invulnerability: 2–3s, with a visual indicator.** After a lobby death or goal
   touch the player respawns invulnerable for ~2–3s, shown by **flashing the player or fading
   them in/out** so the state is legible. During invuln the player can't re-trigger
   lava/goal/ability damage.
   - **Impl (deep scan):** no invuln/grace concept exists today — add a timestamped
     `invulnUntil` flag on `Player`, set it in `respawnInLobby`, and check it in the lobby
     lava/goal branches. The flag must be **synced to the client** (no packet carries it) —
     follow the existing `onFire` event pattern. The player is drawn as a **cached sprite with
     no alpha**, so flash/fade is a small but real render change (wrap the blit in
     `save()/globalAlpha/restore()` for fade, or time-toggle the blit for flash) — not a
     one-liner.
10. **Safe-spawn zone is a protected sanctuary.** The spawn area is protected: its cells
    cannot be mutated, abilities/projectiles/force have no effect inside it, and players in it
    take no lava/goal damage. Guaranteed-safe ground for both initial spawn and respawn.
    - **Impl (updated for Option 2 islands):** the sanctuary **is the `background` terrain
      type** — no separate `sanctuary:true` flag. Any cell whose `id` is `background` is
      neutral + immutable. Add early-`continue`/return guards keyed on "is `background`?" at
      the mutation sites — `explodeBomb`, `explodeIce`, `explodeLava`, and `changeTile`
      (tileSwap dropped) — **reusing the existing goal/lava `continue` idiom** already in
      those functions. Good news: this pattern already exists in the codebase.
    - **⚠ Force functions bypass damage guards:** `cutPlayer` (`engine.js`) and
      `applyExplosionForce` mutate position/velocity directly without checking
      `alive`/invuln/sanctuary, so another player's cut/bomb could physically fling an
      invuln/sanctuary player out into lava. The sanctuary/invuln guard must cover the
      *force-application* path, not just collision damage.
    - The sanctuary "no-damage" check and the decision-9 invuln check are the **same guard at
      different scope** — unify into one `isProtected(player, cell)` helper.
    - **Scope note:** "hazards have no effect" is broader than v1 delivers — bumpers are
      deferred for v1, so that clause only fully applies once a bumper position-guard is added.

---

## Lobby shape: ISLANDS, not a full-coverage map

**Intended design:** the lobby stays the existing plain background, with a few small *islands*
of tiles placed on it (lava pool, ice patch, grass, goal, ability tile, spawn pad). The whole
lobby is NOT a map — only parts of it are.

**Confirmed possible by code inspection:**
- **Collision tolerates sparse cells.** `checkCollideCells` (`engine.js:504-516`) just iterates
  whatever cells exist and runs point-in-polygon (`pointIntersection`, `engine.js:518-539`). A
  player standing on no cell simply gets **no `handleHit`** — no crash, no full-coverage
  assumption.
- **Rendering tolerates sparse cells.** `renderMapToCache` (`draw.js:1030`) paints each cell
  polygon onto a **transparent** cached canvas (`clearRect` + per-cell fill) and `drawImage`s
  it over the world — **no backing fill**. Gaps show the existing lobby background. Islands
  render exactly as islands.

**The one wrinkle this introduces — off-island physics:** player `acel`/`dragCoeff`/`brakeCoeff`
are *only ever set by `handleHit`* (`game.js:2168-2220`) and are **never reset on walk-off**
(on a full map you're always on a cell, so it never mattered). With islands, a player who
crosses an ice patch and steps back onto plain background would **keep the ice grip forever**.
The two representations below handle this differently.

### Two ways to represent islands

**Option 1 — true sparse cells.** `currentMap.cells` holds *only* the island cells; gaps are
genuine empty background.
- Pros: matches the mental model literally; minimal map data.
- Cons: (a) **must add an off-island physics reset** — each frame, if the player hit no cell,
  restore `c.playerDragCoeff`/`playerBrakeCoeff`/`playerBaseAcel`; (b) **authoring is awkward**
  — the editor generates full Voronoi diagrams, so a sparse cell array means hand-editing JSON
  or extending the editor to export a subset (the halfedge/va/vb geometry is fiddly to author
  by hand).

**Option 2 — full map with a transparent "background" terrain type (✅ CHOSEN).** Author a
normal full map in the editor, but paint everything except the islands as a new
*background/transparent* type that renders nothing and applies normal physics.
- Pros: **authorable in the existing editor** (add a transparent/erase brush); the off-island
  physics wrinkle **disappears for free** (background cells set normal physics every frame);
  the entire background area naturally *becomes* the decision-10 sanctuary (neutral,
  immutable), with islands as the only interactive zones.
- Cons: under the hood the world is still a full Voronoi map (just mostly invisible) — a
  representational, not behavioral, difference. Visually/behaviorally identical to Option 1.

**Recommendation: Option 2** — less work, uses existing authoring tools, dissolves the physics
wrinkle, and unifies "background = sanctuary." The rest of the analysis (option-B respawn,
lava death, goal, abilities, reset cadence) is unaffected — it all keys off the *island* cells
either way.

**✅ DECISION: Option 2.** Implications now baked into the plan below:
- A **new `background` terrain type** (config `tileMap`): transparent (renderer skips its
  fill), normal physics, no death/goal/ability effect. Its `handleHit` is a no-op that just
  sets default grip — which is what makes background cells reset physics for free.
- **`background` = the sanctuary** (decision 10). No separate `sanctuary:true` flag needed:
  the background type itself marks immutable/neutral ground. Mutation guards key off "is this
  cell `background`?" (or its id), reusing the existing goal/lava `continue` idiom.
- **Spawn pad** = a chosen background region away from the islands; any background ground is
  inherently safe, so spawn/respawn just needs coordinates within it (+ jitter).
- **Editor** needs a transparent/"erase" brush to paint the background type. Authoring is
  otherwise unchanged (full Voronoi map as today).

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

**Map-mutation consequence:** bomb (`changeTile` → slow), tileSwap (fast↔ice, *global*), and
ice cannon (freeze → ice) permanently rewrite `currentMap` cells. We **exclude tileSwap** from
the lobby (decision 5) precisely because it's global; the kept mutators (bomb, ice cannon) are
*local*, so a *persistent, shared* lobby erodes only slowly — handled by the reset strategy
(see Risks / decision 8).

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
| `addNotch()` (goal score up) | `game.js:325-335` inside `checkForWinners()` | `reachedGoal == true` | `checkForWinners` only runs in racing/collapsing (`game.js:151-153`) |
| `survivalist` / `brutalist` ++ | `game.js:314/316` | `reachedGoal == true` | same |
| `addKill()` / streaks / first blood | `game.js:284` inside `checkForWinners()` | `murderedBy` set by a kill | same |
| `removeNotch()` (death score down) | `game.js:2332` inside `killPlayer()` | any death | `killPlayer` early-returns outside racing/collapsing (`game.js:2322-2324`) |
| **`resourceful++` (achievement stat)** | `game.js:1923` inside `checkAttack()` | **every ability fire** | the `ability.use()` state gate we plan to REMOVE for lobby |
| **`bully++` (achievement stat)** | `game.js:1941` inside `checkAttack()` | **every punch** | punches already process in the lobby, so this may already increment today — verify and guard |

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

> **⚠ Deep-scan corrections to this section:**
> 1. **Achievement stats are a fifth/sixth touchpoint the notches framing missed.**
>    `resourceful++` (`game.js:1923`, every ability fire) and `bully++` (`game.js:1941`, every
>    punch) live in `checkAttack` and are gathered into end-game achievements
>    (`gatherAchievements`). They are NOT gated by `checkForWinners`. Un-gating `ability.use()`
>    for the lobby (change #10) WILL pollute these. Mitigation: either guard the increments
>    when in lobby state, or snapshot/reset `resourceful`/`bully`/`savior`/`totalKills` at race
>    start. **"No scoring in lobby" must explicitly cover achievement stats, not just notches.**
> 2. **`onFire` leaks.** A normal race-start `reset()` only zeroes `onFire` in the `gameOver`
>    branch, so a lobby fire-pickup could bleed into the first real round. `respawnInLobby`
>    must clear `onFire` explicitly.
> 3. **Other transient flags are safe:** `reachedGoal`, `timeReached`, `alive`, `enabled`,
>    `murderedBy`, `ability`, `isZombie`, `infected` are all cleared by the `reset()` that runs
>    via `startGated → setupMap → resetPlayers` before every race — so they won't leak even if
>    `respawnInLobby` forgets them. `onFire` is the lone exception.

---

## Curated lobby layout (proposed)

Authored as **ISLANDS** in the existing map editor (`client/scripts/create.js` +
`create.html`), saved as a normal map JSON sized 1366 × 768, with **everything outside the
islands painted `background`** (transparent → shows the existing lobby) and the center kept
clear for the start button. The islands:

- A small **lava pool** island — the danger.
- An **ice** patch and a **sand (slow)** patch — controls/feel contrast.
- A **grass (fast)** patch — speed contrast.
- A **yellow goal** island — the objective.
- One or more **`bomb` ability tiles** (fast-respawning) — teach ability aim/fire.
- A **spawn pad** — just a `background` region (inherently safe) for initial spawn + respawn.
- Bumpers left out for v1.

---

## Draft artifacts (on this branch)

Concrete drafts produced so far (validated: config parses, map is well-formed, `game.js`/
`draw.js` pass `node --check`, `loadMaps()` excludes the tutorial from the race pool):

- **`background` terrain type** — `server/config.json` `tileMap.background` (id 9, normal
  physics, editor color `#2b2b2b`). Renderer skips it (`draw.js` `renderMapToCache`); `handleHit`
  treats it as normal ground (`game.js`), which also resets off-island physics. Race rotation
  filters out `lobbyOnly` maps (`game.js` ctor → `this.maps` / `this.lobbyMaps`).
- **Island map** — `tools/genLobbyTutorialMap.js` (deterministic, seeded) generates
  `client/maps/_lobbyTutorial.json`: a full 320-cell Voronoi field, 269 transparent
  `background` cells + islands. Layout (1366×768, center kept clear for the start button):

  | Island | Type (id) | Center | r | Cells |
  |---|---|---|---|---|
  | lava pool (danger) | lava (3) | (380, 200) | 95 | 11 |
  | ice patch | ice (4) | (986, 200) | 95 | 11 |
  | sand patch | slow (0) | (380, 568) | 95 | 9 |
  | grass patch | fast (2) | (986, 568) | 95 | 9 |
  | goal (yellow) | goal (6) | (1210, 384) | 80 | 8 |
  | bomb tiles ×2 | bomb (102) | (683,130)/(683,638) | 46 | 3 |
  | spawn pad | background | (175, 384) | 70 | (bg) |

  Re-run with `node tools/genLobbyTutorialMap.js` after tweaking layout. The map carries
  `lobbyOnly:true` and `spawnPad` (for change #7's spawn/respawn).

**✅ IMPLEMENTED** (the implementation phase is complete — see the per-change status in the
table below). `startLobby` loads `lobbyMaps[0]` + broadcasts it; the map renders and cell
collision is enabled in the lobby; the Option-B respawn/invuln/scoring guards, the curated
abilities (bomb) + ability-tile respawn, the SFX dampening, the layered reset cadence, and the
force-fn guards are all live and verified in the running game (lobby renders the islands, player
spawns on the pad, bumpers spawn + render, SFX dampened, no console errors, scoring untouched —
audited at the code level). The only item NOT built is the optional editor "erase"/transparent
brush (change #0) — the map is authored via the deterministic generator instead.

## Change list

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 0 | **New `background` terrain type** (transparent render, normal physics, no-op `handleHit`, = sanctuary). ✅ **DRAFTED** (config + game.js handleHit + draw.js skip + rotation filter). Editor "erase" brush still TODO. | `config.json`, `draw.js`, `create.js`, `game.js` | ~0.5 day |
| 1 | Author tutorial lobby map as **ISLANDS**. ✅ **DRAFTED** via `tools/genLobbyTutorialMap.js` → `client/maps/_lobbyTutorial.json` (lava/ice/slow/fast/goal/bomb islands on a background field). | generator → map JSON | 0.5–1 day |
| 2 | Load tutorial map + button in `startLobby`; **exclude from race rotation** | `game.js`, `utils.js` | ~2 hrs |
| 3 | Enable `checkCollideCells` for lobby state | `game.js:616-628` | ~30 min |
| 4 | Render map client-side during lobby | `client.js:162`, `draw.js:275` | ~1 hr |
| 5 | Lobby-aware **lava**: death cosmetics + respawn, **no `killPlayer`/`removeNotch`** | `game.js` (lava `handleHit`) | ~0.5 day |
| 6 | Lobby-aware **goal**: win cosmetics + respawn, **no `reachedGoal`/`playerConcluded`/`addNotch`** | `game.js:2202-2213` | ~2 hrs |
| 7 | Spawn/respawn on a **`background` (sanctuary) region** w/ jitter (initial + respawn); mutation/force guards key off the `background` type | `game.js` (spawn path, mutation/force guards) | ~0.5 day |
| 8 | Shared `respawnInLobby(player)` helper used by 5 & 6 | `game.js` | (folded into 5/6) |
| 9 | **2–3s respawn invulnerability** + **flash/fade visual** (client) after lobby death or goal touch | `game.js` (`respawnInLobby`), `draw.js` (flash/fade) | ~0.5 day |
| 10 | **Un-gate `ability.use()` for lobby** in `checkAttack` (lobby ability set: bomb, iceCannon, speedBuff, speedDebuff, cut — `swap`/`blindfold`/`tileSwap` excluded via curated map tiles) | `game.js:1921`, lobby map JSON | ~2 hrs |
| 11 | **Lobby projectile→terrain collision** (ice cannon / bomb reshape) | `game.js:661` | ~2 hrs |
| 12 | **Dampen ALL lobby SFX uniformly** (single lobby volume scalar) | `client/scripts/audio.js` | ~2 hrs |
| 13 | **Layered map-reset cadence** — game-start / lobby-(re)start / lobby-empty / **15s idle-gated** safety reset; reset = reapply pristine cell ids + broadcast `tileChanges` | `game.js` (`startLobby`, reset helper, timer) | ~0.5 day |
| 14 | Multiplayer testing (concurrent deaths, spawn stacking, griefing tolerance, no score drift, map-mutation recovery) | — | ~0.5–1 day |
| 15 | **Guard achievement stats in lobby** — don't increment `resourceful`/`bully` (and verify `savior`/`totalKills`) on lobby ability-fire/punch; clear `onFire` in `respawnInLobby` | `game.js` (`checkAttack`, `respawnInLobby`) | ~2 hrs |
| 16 | **Sanctuary/invuln guards on force functions** — `cutPlayer` (`engine.js`), `applyExplosionForce`; unify with `isProtected()` helper | `game.js`, `engine.js` | ~2 hrs |
| 17 | **Hard-code curated ability ids in lobby map JSON** (skip random pool) instead of config `spawnable` edits; `tileSwap` excluded | lobby map JSON, `game.js` load | ~1 hr |
| 18 | **Fast lobby-only ability-tile respawn** — timer restores a consumed ability tile so every player can learn (broadcast via `tileChanges`) | `game.js` (lobby tick / reset helper) | ~2 hrs |

**Total: ~4.5–5.5 days** — the islands model adds the `background` terrain type + editor brush
(change #0, ~0.5 day) but simplifies the sanctuary (it *is* the background type) and dissolves
the off-island physics wrinkle, so net add is modest.

### ✅ Implementation status (built on `worktree-lobby-tutorial-analysis`)

All gameplay changes are implemented and committed. Status per change:

- **#0 background type / rotation filter** — ✅ DONE (config + `handleHit` + `draw.js` skip + `this.maps`/`this.lobbyMaps`). Editor "erase" brush: **not built** (optional; map is generator-authored).
- **#1 islands map** — ✅ DONE (`tools/genLobbyTutorialMap.js` → `_lobbyTutorial.json`, 470 cells, lava/ice/slow/fast/goal/bomb islands + 2 bumpers + spawn pad).
- **#2 load + broadcast lobby map** — ✅ DONE (`GameBoard.startLobby`/`loadLobbyMap`, `sendLobbyStart` packet[4]).
- **#3 enable `checkCollideCells` in lobby** — ✅ DONE (`checkCollisions` lobby branch).
- **#4 render map client-side in lobby** — ✅ DONE (client `loadLobbyMap`, `drawMap()` in the lobby draw branch).
- **#5/#6/#8 lobby-aware lava/goal + shared `respawnInLobby`** — ✅ DONE (deferred `lobbyRespawnPending` flag → `respawnInLobby`; no `killPlayer`/`reachedGoal`/`playerConcluded`).
- **#7 spawn/respawn on sanctuary + jitter** — ✅ DONE (`placePlayerOnSpawnPad`, `getLobbySpawnLoc`; mutation/force guards key off the `background` type).
- **#9 2–3s invuln + flash/fade** — ✅ DONE (`invulnUntil`, synced via `lobbyRespawn` event; `drawPlayer` pulses sprite alpha).
- **#10 un-gate `ability.use()` (bomb)** — ✅ DONE (`checkAttack`; curated set enforced by map tiles).
- **#11 lobby projectile→terrain** — ✅ DONE (snowFlake `checkCollideCells` in the lobby branch).
- **#12 dampen all lobby SFX** — ✅ DONE (single `sfxVolumeScalar` in `audio.js`, toggled on lobby enter/exit).
- **#13 layered map-reset cadence** — ✅ DONE (game-start / lobby-(re)start / lobby-empty re-clone + 15s idle-gated `checkLobbyMapReset`/`restoreLobbyMap`).
- **#14 multiplayer testing** — partial: solo runtime verification done (render, spawn, bumpers, SFX, no-score audit); concurrent-player stress not exercised.
- **#15 guard achievement stats** — ✅ DONE (`bully`/`resourceful` skip lobby; `onFire` cleared in `respawnInLobby`).
- **#16 sanctuary/invuln force guards** — ✅ DONE (`isProtected()`; `applyExplosionForce`/`cutPlayers` skip protected; `explodeBomb`/`explodeIce`/`explodeLava` skip background).
- **#17 hard-coded curated ability ids in map** — ✅ DONE (map places only bomb tiles, id 102).
- **#18 fast ability-tile respawn** — ✅ DONE (`respawnLobbyAbilityTile`, lobbyAbilityTileRespawnMs).

A late runtime-found fix: lobby bumpers needed an explicit `applyHazards` broadcast (gameUpdates
only moves known hazards; creation is via the newMap/`applyHazards` path the lobby lacked).

### Map-rotation leakage gotcha
`loadMaps()` (`server/utils.js:308`) ingests *everything* in `client/maps/`, so a tutorial map
placed there would leak into the random race rotation. Exclude it by name/flag in
`determineNextMap()` (`game.js:1197`), or store it outside that folder and `require` it
explicitly.

---

## Deep-scan validation (post-rebase, 4 agents)

Validated all decisions against the current code after rebasing onto 3 upstream commits.
**Verdict: the decisions are sound and implementable.** Corrections folded in above; summary:

- **Upstream rebase is safe.** The 3 new commits (gamepad, menu/lobby/editor controller nav +
  on-screen keyboard, release) touch **zero server files**. Every server mechanism the plan
  depends on is intact. Gamepad/touch input flows through the same `moveForward`/`attack`/aim
  channels, so lobby terrain interaction and ability-fire are **input-device-agnostic** — no
  extra work for controllers.
- **Line refs drifted +3 to +14 lines** but no logic moved or changed. Key current values:
  `startLobby` **1043-1046**; lobby `checkCollisions` branch **619-631**; `checkCollideCells`
  **654** (player) / **663-664** (snowFlake); lava `handleHit` **2193-2208** (`killSelf` 2207);
  goal `handleHit` **2216-2227**; `killPlayer` **2321** (gate 2322-2324, `removeNotch` 2332);
  `checkAttack` use-gate **1921**; spawn `getSafeLoc` **1668-1671** / `spawnPlayerRandomLoc`
  **1702**; `determineNextMap` **1197**; `sendLobbyStart` in **server/compressor.js:115**.
- **New gaps the scan caught** (now reflected in decisions/changes): achievement-stat leak
  (`resourceful`/`bully`, change #15), `onFire` not cleared by race-start reset, ability pool
  is global so curate via map JSON not config (#17), tileSwap is global (decision 5 ⚠),
  ability tiles are one-shot per reset cycle, sanctuary needs voronoiId-set guards reusing the
  existing goal/lava `continue` idiom (#16), force functions bypass invuln/sanctuary (#16),
  invuln flag needs client sync + player sprite has no alpha (decision 9 impl note).
- **Good-news reuse:** the "protect certain cells from mutation" pattern already exists
  (`explodeBomb`/`explodeIce`/`explodeLava` already `continue` past goal/lava), and the
  `tileChanges` broadcast + `this.maps` pristine templates give a ready restore path for the
  reset cadence.

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
- **Map mutation in a persistent shared lobby** — bomb/ice-cannon locally rewrite cells (tileSwap
  dropped), so the curated layout degrades slowly over a long-lived lobby. Reset strategy
  (change #13): reload the pristine lobby map on a cadence, on lobby (re)entry, or when empty.
- **Griefing tolerance** — the curated active abilities in a shared lobby are accepted by
  design (speedDebuff affects everyone; cut can knock players around). Watch that it stays
  fun, not disruptive.

---

## Open questions (to refine)

- Exact safe-spawn zone coordinates depend on the final authored layout.
- Flash vs. fade for the invuln indicator (change #9) — pick during implementation/eyeballing.
- Ability-tile respawn delay (change #18) — pick a short value during implementation.

### Resolved
- ~~Map-reset cadence~~ → layered: game-start / lobby-(re)start / lobby-empty / **15s**
  idle-gated safety reset (decision 8).
- ~~SFX dampening scope~~ → all lobby SFX dampened uniformly (decision 6).
- ~~Abilities present-but-inert vs active~~ → active curated subset; `swap`, `blindfold`,
  `tileSwap` dropped; `bomb` (+ iceCannon/speedBuff/speedDebuff/cut) kept (decision 5).
- ~~tileSwap keep/drop~~ → dropped (it's global, wrecks layout); `bomb` teaches aim/fire.
- ~~Ability replenishment~~ → fast lobby-only ability-tile respawn (change #18).
- ~~Feedback reuse~~ → reuse in-game death/win cues at lobby volume (decision 7).
- ~~Respawn cooldown length~~ → 2–3s invuln with flash/fade indicator (decision 9).
- ~~Safe-spawn protection level~~ → fully protected sanctuary (decision 10).
- ~~Whole-map vs partial lobby~~ → ISLANDS via full map + transparent `background` type
  (Option 2); background = sanctuary; needs a `background` terrain type + editor brush.
