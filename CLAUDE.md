# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies (uses `package-lock.json`).
- `npm start` — run the Node server in dev mode on port 3000 (serves the unminified per-file `<script>` tags directly from `client/scripts/*.js`).
- `npm run build` — run `build.js` to produce minified bundles in `client/scripts/dist/` (`play.bundle.min.js`, `create.bundle.min.js`, `join.bundle.min.js`) via esbuild's `transform`.
- `npm run start:prod` — start with `NODE_ENV=production`, which makes `index.js` rewrite the `<!-- BUILD: bundle-start -->…<!-- BUILD: bundle-end -->` block in each served HTML page to point at the corresponding bundle in `client/scripts/dist/`. The bundles must already exist; run `npm run build` first.
- `npm run heroku-postbuild` — invoked automatically by Heroku to build bundles during deploy.

There is no unit-test framework, linter, or formatter configured. `client/scripts/dist/` is ignored by `.gitignore` (the `dist` rule), so bundles are produced at deploy time, not committed.

### Testing gameplay (headless)

CI (`.github/workflows/pr-validation.yml`) runs `.github/scripts/smoke-test.js` — it boots the **real** server modules with no network/browser, drives the live tick loop (`hostess.updateRooms(dt)` / `room.update(dt)`), and ticks every committed map through waiting→racing→collapsing, failing on any throw or malformed compressor payload. There is no separate physics simulator: to test game logic you run the actual engine headlessly the same way.

`smoke-test.js` is the canonical template. The reusable techniques for richer assertions: a fake `socket.io` `io` (`messenger.build`) whose `emit` *records* events so you can assert on them (`bombTriggered`, `botEmote`, `playerInfected`, …); pinning a map via the editor preview path (`gameBoard.isPreview` + `previewMap`); forcing states (`startGated`/`startRace`/`applyBrutalAbilityRound`) to skip timers; and — **important** — mocking `Date.now` + `setTimeout` into a clock you advance per tick, because a tight synchronous tick loop freezes wall-clock and otherwise no cooldown, projectile fuse, or `setTimeout` callback ever fires.

## Release notes for game mechanic changes

Any change that touches `server/config.json`, `server/game.js`, or `server/engine.js` is a "game mechanic" change and MUST add a player-facing bullet under `## Unreleased` in `CHANGELOG.md` in the same commit. The `.github/workflows/release-notes-check.yml` workflow enforces this on PRs and pushes to `main`. Write the entry the way a player would describe what they noticed, not what the code does — see existing GitHub releases (https://github.com/sjdodge123/chaochao/releases) and `CONTRIBUTING.md` for the format. Refactors, perf work, UI/CSS, build/CI changes, and map JSON submissions are exempt.

## Architecture

This is a multiplayer top-down racing/arena game. A single Node process hosts both the static client and the Socket.IO server; gameplay is fully authoritative on the server, and the client only renders state and forwards input.

### Server (Node + Socket.IO, in `server/`)

- `index.js` (repo root) — boots Express, applies `compression()`, installs the prod-only bundle rewriter, serves `client/` statically, and creates the Socket.IO server. It also runs a **sleep/wake loop**: when `clientCount` is 0 the server cancels its `setInterval(update, serverTickSpeed)`; the first new connection re-arms it. All gameplay ticks flow through `hostess.updateRooms(dt)`.
- `utils.js` — central config loader (`config.json`, with `PORT` env override), `dt` clock, math helpers, and at boot scans `client/maps/`, `client/assets/sounds/`, `client/assets/img/` to build the manifests sent to clients via the `contentDelivery` message. Also implements `submitPullRequest()`, which uses `@octokit/core` (auth from `GITHUB_AUTH` env var) to commit a user-submitted map JSON to a new branch and open a PR against `main` — this is how the in-browser map editor publishes new maps.
- `hostess.js` — room registry. Creates `Room` instances on demand, matchmakes clients into rooms with space, and drives `room.update(dt)` for every room each server tick. Rooms are deleted when the last client leaves.
- `messenger.js` — Socket.IO wrapper. Owns the mailbox map (client id → socket) and the room-mailbox map (client id → room sig), and registers per-client event handlers in `checkForMail()` (`enterGame`, `joinARoom`, `submitNewMap`, input events, etc.). This is the single place where socket events are wired.
- `game.js` — defines `Room`, `Game`, and `World`. `Room` owns the per-room `playerList`, `projectileList`, `aimerList`, `hazardList`, an `Engine`, a `World`, and a `Game`. `Game` runs the state machine over `c.stateMap` (`waiting → lobby → overview → gated → racing → collapsing → gameOver`) and contains the rules for rounds, brutal-round selection, scoring/notches, and ability spawning.
- `engine.js` — physics and collision. Per-tick it updates hazards, projectiles, and players; collision uses a `QuadTree` against the active map's tiles. Exposes helpers (`checkDistance`, `punchPlayer`, `puckPlayer`, `explosion`, `cutPlayer`, `bounceOffBoundry`, …) consumed from `game.js`.
- `compressor.js` — serializes per-tick game state into compact positional arrays (e.g. `[id, x, y, velX, velY, angle]`) before they're emitted as `gameUpdates`. Always edit the client-side decoders in `client/scripts/client.js` in lockstep when the array layout changes.
- `config.json` — single source of truth for gameplay tuning: world size, tick rate, tile types (`slow`/`normal`/`fast`/`lava`/`ice`/`ability`/`goal`/`bumper`/`random`), abilities (`blindfold`, `swap`, `bomb`, `speedBuff`, `speedDebuff`, `tileSwap`, `iceCannon`, `cut`), brutal-round modes (`cloudy`, `lightning`, `volcano`, `infection`, `hockey`, `explosive`, `blackout`, …), hazards, state map, timers, and per-player constants. The same object is delivered to the client via the `config` socket event, so changes here affect both sides.
- `debug.js` — opt-in network logger gated by a flag at the top.

### Client (`client/`)

Three entry pages, each backed by its own bundle defined in `build.js`:

- `index.html` — landing page.
- `play.html` → `play.bundle.min.js`: the in-game client. Concatenates `game.js` (globals/bootstrap), `client.js` (Socket.IO event handlers — `welcome`, `gameState`, `gameUpdates`, `playerJoin`/`playerLeft`, etc.), `audio.js`, `input.js`, `draw.js` (canvas rendering — large hot path), `gameboard.js` (client-side map/tile state), `joystick.js`, `utils.js`.
- `create.html` → `create.bundle.min.js`: the in-browser map editor. Uses `rhill-voronoi-core.js` for cell generation and `create.js` to assemble the map JSON, which is POSTed via `submitNewMap` and turned into a GitHub PR by `utils.submitPullRequest`.
- `join.html` → `join.bundle.min.js`: standalone room-join page.

The bundler concatenates the listed files in order (not a module bundler — these files share globals). Adding a new client script means adding it to the appropriate bundle list in `build.js` **and** adding a `<script>` tag inside the `<!-- BUILD: bundle-start --> … <!-- BUILD: bundle-end -->` block of the relevant HTML page. In dev mode the raw tags are served; in prod the block is replaced with a single bundle tag at request time.

`client/maps/*.json` are the canonical map files (loaded at server boot). `client/assets/{img,sounds}/` are streamed to clients via the manifests built by `utils.js`; new files placed in those directories show up automatically on the next server restart.

### Networking contract

- Client → server: input events through `messenger.js` (handlers registered in `checkForMail`).
- Server → client per tick: a single `gameUpdates` message containing compacted `playerList`/`projList`/`aimerList`/`hazardList` arrays plus game-state metadata.
- Server → client one-shot/state-change: `welcome`, `contentDelivery`, `gameState`, `playerJoin`, `playerLeft`, `serverKick`, `roomNotFound`, plus map/sound/config fetches.

When changing the shape of any of these payloads, update `server/compressor.js` and the matching `update*List` functions in `client/scripts/client.js` together.
