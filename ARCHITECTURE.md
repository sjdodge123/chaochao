# ARCHITECTURE

Reference map of the codebase for fast onboarding (human or agent). For commands,
the release-notes rule, and a prose architecture summary, see `CLAUDE.md`; this
file is the per-file index and the cross-cutting contracts.

`chaochao` is a multiplayer top-down racing/arena game. A single Node process
hosts both the static client and the Socket.IO server. **Gameplay is fully
authoritative on the server**; the client only renders state and forwards input.

---

## Repository layout

```
index.js              Express + Socket.IO boot, prod bundle rewriter, sleep/wake tick loop
build.js              esbuild bundler (CLIENT scripts only) -> client/scripts/dist/*.min.js
server/               authoritative game server (Node + Socket.IO)
  entities/           game-object classes split out of game.js (geometry, players, abilities…)
client/               static client (3 HTML entry pages + their scripts)
  scripts/            per-file client scripts (served raw in dev, bundled in prod)
  maps/*.json         canonical maps, loaded at server boot
  assets/{img,sounds} streamed to clients via manifests built in utils.js
.github/workflows/    pr-validation, release-notes-check, map-submission (+ -cleanup), release
.github/scripts/      smoke-test.js + validate-content.js (CI gates), map-submission
                      review (validate-submitted-map.js + lib/render-map.js +
                      build-review-comment.js), release tooling
```

---

## Server (`server/`)

The server is plain CommonJS (`require`/`module.exports`), no transpile step.
Boot order: `index.js` → `utils.loadConfig()` → `hostess` creates `Room`s on
demand → each `Room` owns a `Game` + `GameBoard` + `World` + `Engine`.

| File | Lines | Purpose / contents |
|---|---|---|
| `game.js` | ~2.3k | Core orchestrators only: **`Room`** (per-room registry of player/projectile/aimer/hazard lists), **`Game`** (the state machine over `c.stateMap`: waiting→lobby→overview→gated→racing→collapsing→gameOver; round/brutal/scoring rules; bot fill), **`GameBoard`** (per-tick collision/ability/map driving, brutal-round config, map lifecycle). Music & achievement methods are mixed into `Game.prototype` from `music.js`/`achievements.js`. Exports only `getRoom(sig,size)`. |
| `engine.js` | ~730 | Physics & collision. Per-tick updates hazards/projectiles/players; `QuadTree` broadphase against active map tiles. Helpers used from game.js/entities: `preventEscape`, `checkCollideCells`, `punchPlayer`, `puckPlayer`, `explosion`, `bounceOffBoundry`, … |
| `utils.js` | ~500 | Central config loader (`loadConfig()` returns cached `config.json`, `PORT` override), `dt` clock, math/RNG helpers; scans `client/{maps,assets}` at boot to build the `contentDelivery` manifests; `loadMaps()` reconstructs sites-only maps to full geometry (`mapFormat`); `submitPullRequest()` (octokit) reduces an editor-submitted map to sites-only and opens a GitHub PR; shared `validateMap()`. |
| `messenger.js` | ~210 | Socket.IO wrapper. Owns mailbox (client id→socket) and room-mailbox (id→room sig). `checkForMail()` registers every per-client handler (`enterGame`, `joinARoom`, `submitNewMap`, input events). The single place socket events are wired. |
| `hostess.js` | ~140 | Room registry. Creates `Room`s on demand, matchmakes clients into rooms with space, drives `room.update(dt)` each tick, deletes empty rooms. |
| `compressor.js` | ~230 | Serializes per-tick state into compact positional arrays (e.g. `[id,x,y,velX,velY,angle]`) before `gameUpdates`. **Edit client decoders in `client/scripts/client.js` in lockstep with any layout change.** |
| `aiController.js` | ~1.1k | AI racer brain: A\*-over-cells + feeler steering (`steerBot`), ability/punch policy, brutal-mode fairness, personalities + rubber-banding. Drives bot `Player`s via `targetDirX/Y/braking`. |
| `cellGraph.js` | ~410 | Cell adjacency graph + pathfinding over a map's Voronoi cells (`findPathToNearestGoal`, …). Used by `aiController`. |
| `mapFormat.js` | ~110 | Compact **sites-only** map format ↔ full Voronoi geometry. `toSitesOnly()` reduces a full map to `{bbox, sites:[{x,y,id}], hazards, …}`; `reconstruct()`/`hydrate()` recompute the diagram (via `rhill-voronoi-core.js`, now required server-side) deterministically so cells/adjacency/par-time/geometry match what the editor produced. Used by `loadMaps()` and the submit boundary. |
| `music.js` | ~85 | **Mixin** of music-mood/track-selection methods (`computeMusicMood`, `pickMusicTrack`, `rotateMusicTrack`, …). `Object.assign`ed onto `Game.prototype`; methods use `this`. |
| `achievements.js` | ~75 | **Mixin** of end-of-match medal tallying (`gatherAchievements`, `checkForNewMedalHolder`). `Object.assign`ed onto `Game.prototype`. |
| `botEmotes.js` | ~40 | Neutral helper (`emitBotEmote`, `botsCheerFor`) so `game.js` and `entities/player.js` can broadcast bot chat-wheel emotes without a require cycle. |
| `debug.js` | ~12 | Opt-in network logger gated by a flag at the top. |
| `config.json` | ~305 | **Single source of truth for tuning** (world size, tick rate, tile types, abilities, brutal-round modes, hazards, state map, timers, per-player constants). Delivered verbatim to the client via the `config` event, so changes affect both sides. |

### `server/entities/` (game-object classes, extracted from `game.js`)

All extend the geometry primitives and are required back into `game.js`. Dependency
direction is strictly downward (no cycles): `game.js` → entities → `shapes.js`.

| File | Lines | Classes / contents |
|---|---|---|
| `shapes.js` | ~185 | Geometry primitives: `Shape` → `Rect`, `Circle`, `Gate`. Collision math (`testRect`/`testCircle`/`getExtents`). Everything else extends these. |
| `world.js` | ~70 | `World` (extends `Rect`): bounds + player creation/spawn (`createNewPlayer`). |
| `player.js` | ~740 | `Player` (extends `Circle`) and `LobbyStartButton`. The big behavioral class: movement, punch/puck, fire, sleep/AFK, infection, `handleHit` (type dispatcher → `handlePunchHit`/`handlePuckHit`/`handleMapCellHit`), ability pickup via the `ABILITY_TILE_CTORS` table + `tryAcquireAbility`, scoring/notches, kill/reset. |
| `abilities.js` | ~165 | `Ability` base + `Blindfold`, `Swap`, `IceCannon`, `Bomb`, `SpeedBuff`, `SpeedDebuff`, `TileSwap`, `Cut`, `BombTrigger`. |
| `projectiles.js` | ~145 | `Projectile` (extends `Circle`) + `CloudProj`, `SnowFlakeProj`, `BombProj`, `Puck`. |
| `hazards.js` | ~80 | `HazardRail`, `Hazard`, `Bumper`. |
| `aimers.js` | ~100 | `ExplosionAimer`, `SwapAimer` (telegraph circles). |
| `punch.js` | ~25 | `Punch` (extends `Circle`) — the melee hitbox; created by `Player` and `Bumper`. |

---

## Client (`client/`)

No module system — `build.js` **concatenates** the listed files in order; they
share globals (NOT a module bundler). Three HTML entry pages, each with its own
bundle list in `build.js` and a `<!-- BUILD: bundle-start -->…<!-- BUILD: bundle-end -->`
block. Dev (`npm start`) serves the raw `<script>` tags; prod swaps in the bundle.

**`play.html` → `play.bundle.min.js`** (the in-game client):

| File | Lines | Purpose / contents |
|---|---|---|
| `game.js` | ~580 | Globals/bootstrap, canvas setup, `resize()`, page setup, main loop wiring. |
| `client.js` | ~1.1k | Socket.IO event handlers. `registerPrimaryHandlers` is a dispatcher over themed sub-registrars (`registerConnection/Score/State/Combat/Ability/EffectHandlers`); `registerSecondaryHandlers` for extra local players. **Holds the decoders that mirror `server/compressor.js`.** |
| `draw.js` | ~3.1k | Canvas rendering — the largest hot path. Camera, players, projectiles, HUD, touch controls, lobby/goal/map-cache drawing, effects/particles. |
| `gameboard.js` | ~1.3k | Client-side map/tile state mirror. |
| `audio.js` | ~480 | Music + SFX + audience crowd reactions; reports finished tracks back to the server. |
| `input.js` | ~650 | Keyboard/mouse/touch → input events; movement intent. |
| `joystick.js` | ~245 | On-screen joystick for touch. |
| `gamepad.js` | ~1.5k | In-game controller support (per local-player polling, aim/attack, hot-join). |
| `recap.js` | ~440 | End-game highlight montage (buffered per-tick positions, zoom+follow replay). |
| `QuadTree.js` | ~420 | Client spatial structure (rendering/picking). |
| `utils.js` | ~100 | Client math/format helpers. |

**`create.html` → `create.bundle.min.js`** (in-browser map editor):

| File | Lines | Purpose / contents |
|---|---|---|
| `create.js` | ~1.1k | Assembles a map from Voronoi cells, validates, POSTs via `submitNewMap` (server reduces to sites-only → GitHub PR in `utils.submitPullRequest`). Reconstructs sites-only maps on load (`reconstructSitesOnlyMap`) and renders load-list thumbnails on demand (`renderMapThumbnail`). |
| `rhill-voronoi-core.js` | ~1.7k | **Third-party** Voronoi cell generation (leave as-is). Now in the **play** bundle too (client reconstructs sites-only maps); a browser-safe `module.exports` shim lets `server/mapFormat.js` require it. |
| `editorGamepad.js` | ~460 | Controller support specific to the editor page (owns the pad; does not load `menuGamepad.js`). |

**`join.html` → `join.bundle.min.js`**: `join.js` (~150) — standalone room-join page.

**Shared across pages** (in multiple bundle lists): `theme.js` (light/dark/auto
toggle), `controllerHeader.js` (controller-detection header for index/join/create),
`osk.js` (on-screen keyboard wrapping simple-keyboard), `menuGamepad.js` (DOM-menu
controller navigation for landing/join).

---

## Cross-cutting contracts

**Game state machine** (`Game`, driven by `c.stateMap`):
`waiting → lobby → overview → gated → racing → collapsing → gameOver`. `GameBoard`
collision behavior is keyed on the current state (see `checkCollisions` →
`collectLobby/Gated/RaceCollisionObjects`).

**Networking contract:**
- Client → server: input events via `messenger.js` (`checkForMail`).
- Server → client per tick: one `gameUpdates` message with compacted
  player/proj/aimer/hazard arrays + state metadata.
- Server → client one-shot/state-change: `welcome`, `contentDelivery`, `gameState`,
  `playerJoin`, `playerLeft`, `serverKick`, `roomNotFound`, plus map/sound/config fetches.
- **Lockstep rule:** any change to a `gameUpdates` payload shape must update
  `server/compressor.js` and the matching decoders in `client/scripts/client.js`
  **together**.

**Config is the single source of truth:** `server/config.json` tunes both sides;
it's shipped to the client via the `config` event. Don't fork tuning values.

**Map format (sites-only):** `client/maps/*.json` are stored compact —
`{bbox, sites:[{x,y,id}], hazards, startEdges, parTime, name, author, id}`, no
`cells`/`edges`/`thumbnail` (~16 KB vs ~1.3 MB). Full Voronoi geometry is
reconstructed deterministically on load — server in `loadMaps()` via
`server/mapFormat.js`, client in `reconstructSitesOnlyMap()` (`client/scripts/utils.js`,
both bundles include `rhill-voronoi-core.js`). **Lockstep rule:** keep these two
reconstructors in sync. Thumbnails are rendered on demand, not stored. The
full-geometry originals are frozen in `maps-archive/` (outside `client/maps/`, so
`loadMaps` ignores them and nothing ships to the browser). Loaders accept legacy
full-geometry maps unchanged.

**Adding code:**
- *New server module:* just `require`/`module.exports` — the server isn't bundled,
  so no build change. Keep entity classes under `server/entities/`.
- *New client script:* add it to the right bundle list in `build.js` **and** the
  `<!-- BUILD: bundle-start -->…<!-- BUILD: bundle-end -->` block of the relevant
  HTML page (load order matters — these files share globals).
- *New map / asset:* drop the file in `client/maps/` or `client/assets/{img,sounds}/`;
  it appears on the next server restart (manifests rebuilt in `utils.js`).

**Testing / CI** (no unit test suite):
- `node .github/scripts/smoke-test.js` — boots the real server + messenger handlers
  and ticks the engine through every state on all maps. Primary regression gate.
- `node .github/scripts/validate-content.js` — validates `config.json` + every map.
- `.github/workflows/map-submission.yml` — runs only when a PR touches `client/maps/**`
  (the in-browser editor opens these from `mapchange-*` branches). It deep-validates
  the *changed* map(s) via `validate-submitted-map.js` (goal-reachability from the
  default left start — which `utils.validateMap` skips when `startEdges` is unset —
  plus bounds, finiteness, a cell cap, and a real AI playability sim), and posts a
  sticky PR comment with TWO `lib/render-map.js` (zero-dep PNG) images — the
  authoritative map render (eyeball for inappropriate imagery) and a competing-lines
  trail overlay (the AI's own pathing, timed by `estimatePathTime`) — plus an
  automatic preview-integrity PASS/FAIL on the editor's embedded thumbnail. Images
  are pushed to a per-PR branch `map-previews-pr-<N>` (force-pushed, so concurrent
  map PRs never contend) and referenced by raw URL; `map-preview-cleanup.yml` deletes
  that branch when the PR closes. Submission (`mapchange-*`) PRs that touch anything
  outside `client/maps/*.json` are blocked. Pure map PRs skip `pr-validation.yml` and
  `release-notes-check.yml` (via `paths-ignore: client/maps/**`) since this workflow
  already covers the map; mixed code+map PRs still run everything.
- `npm run build` needs `esbuild` (a devDependency installed at deploy via
  `heroku-postbuild`); it is not present in a fresh/dev checkout, which serves raw
  scripts instead. Use `node --check <file>` for local client syntax validation.

**Conventions** (from the file-size refactor):
- Soft target ~300 lines/file and ~60 lines/function; hard cap ~120 lines/function.
  Exempt: third-party (`rhill-voronoi-core.js`), pure data (`config.json`), and
  self-contained data structures (`QuadTree.js`). `game.js`, `draw.js`, etc. remain
  large single-responsibility files by design.
- Any change to `config.json`, `game.js`, or `engine.js` is a "game mechanic" change
  and **must** add a player-facing bullet under `## Unreleased` in `CHANGELOG.md`
  (enforced by `.github/workflows/release-notes-check.yml`). Refactors, UI/CSS,
  build/CI, and map JSON are exempt.
