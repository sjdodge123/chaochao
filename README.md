# Chao Chao

A multiplayer, top-down, slow-paced racing/arena game that runs entirely in the browser. Race across procedurally-flavoured Voronoi maps, grab abilities, shove rivals into the lava, and survive "brutal rounds" where the rules turn against you — then watch the chaos play back in an end-of-match highlight reel.

🎮 **Play it now: [www.chaochaogame.com](https://www.chaochaogame.com)**

A single Node process hosts both the static client and the Socket.IO server. **Gameplay is fully authoritative on the server** — the client only renders state and forwards input, so the game can't be cheated from the browser.

---

## Features

- **Real-time multiplayer racing** — matchmade rooms over Socket.IO, with AI racers filling empty seats.
- **Abilities** — pick up tiles to fire off `blindfold`, `swap`, `bomb`, `speedBuff`/`speedDebuff`, `tileSwap`, `iceCannon`, and `cut`.
- **Brutal rounds** — round modifiers like `cloudy`, `lightning`, `volcano`, `infection`, `hockey`, `explosive`, and `blackout` that change how a race plays.
- **Tile-based terrain** — `slow`/`normal`/`fast`/`lava`/`ice`/`ability`/`goal`/`bumper`/`random` tiles, each with distinct physics and visuals.
- **In-browser map editor** — build your own maps from Voronoi cells and submit them; the server opens a GitHub PR automatically.
- **Cross-platform input** — keyboard/mouse, touch with an on-screen joystick, and full game-controller support.
- **End-of-match recap** — a buffered highlight montage that zooms and follows the action.
- **Optional accounts & progression** — Supabase-backed sign-in, XP/levels, and unlockable cart skins (all gated behind env vars; the game runs fully as guest-only with no setup).

---

## Quick start

Requirements: [Node.js](https://nodejs.org/en/download/) (LTS recommended).

```bash
git clone https://github.com/sjdodge123/chaochao.git
cd chaochao
npm install
npm start
```

Then open **http://localhost:3000**.

To play with others on your local network, browse to `http://<your-LAN-IP>:3000` from another device.

> Dev mode (`npm start`) serves the unminified per-file client scripts directly, so there's no build step needed to iterate.

---

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the Node server in dev mode on port 3000 (raw, unbundled client scripts). |
| `npm run build` | Produce minified client bundles in `client/scripts/dist/` via esbuild. |
| `npm run start:prod` | Start with `NODE_ENV=production`; serves the pre-built bundles (run `npm run build` first). |
| `npm run test:smoke` | Boot the real server engine headlessly and tick every map through every game state — the primary regression gate. |
| `npm run test:perf-tick` / `test:perf-client` | Server tick-budget and client render-perf checks. |

Set the port with the `PORT` environment variable (defaults to `3000`).

---

## Project layout

```
index.js              Express + Socket.IO boot, prod bundle rewriter, sleep/wake tick loop
build.js              esbuild bundler (client scripts only) -> client/scripts/dist/*.min.js
server/               authoritative game server (Node + Socket.IO)
  entities/           game-object classes (players, abilities, hazards, projectiles…)
  config.json         single source of truth for all gameplay tuning
client/               static client (3 HTML entry pages + their scripts)
  scripts/            per-file client scripts (served raw in dev, bundled in prod)
  maps/*.json         canonical maps (compact "sites-only" Voronoi format)
  assets/{img,sounds} streamed to clients via auto-built manifests
.github/              CI workflows + headless test/validation scripts
```

The client has three entry pages, each with its own bundle:

- **`play.html`** — the in-game client (rendering, input, audio, recap).
- **`create.html`** — the in-browser map editor.
- **`join.html`** — a standalone room-join page.

For a full per-file index, the networking/config contracts, and the build model, see **[`ARCHITECTURE.md`](ARCHITECTURE.md)**.

---

## How it works

- **Server (`server/`)** — plain CommonJS, no transpile step. `hostess.js` matchmakes clients into `Room`s; each room owns a `Game` (state machine: `waiting → lobby → overview → gated → racing → collapsing → gameOver`), a `GameBoard`, a `World`, and an `Engine` (physics + `QuadTree` collision). `compressor.js` packs per-tick state into compact positional arrays before they're emitted as a single `gameUpdates` message.
- **Client (`client/`)** — not a module bundler; `build.js` concatenates files that share globals. `client.js` decodes the compressed `gameUpdates` (kept in lockstep with `compressor.js`), and `draw.js` renders everything to canvas.
- **Config (`server/config.json`)** — tunes world size, tick rate, tiles, abilities, brutal rounds, hazards, timers, and per-player constants. The same object is shipped to the client via the `config` event, so it's the single source of truth for both sides.

---

## Configuration (optional)

The game boots fine with **no configuration** — auth is simply disabled and everyone plays as a guest. To enable accounts, leaderboards, and progression, copy `.env.example` to `.env` and fill in the Supabase values:

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Browser-safe client config. |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | **Server-only.** Never expose to the client. |
| `ALLOW_SUPABASE_WRITES` | Master kill-switch for all DB write paths. Defaults to `false` so local dev can read prod data without polluting it. |
| `PORT` | Server port (default `3000`). |
| `GITHUB_AUTH` | Token used by the map editor to open map-submission PRs. |

---

## Contributing

See **[`CONTRIBUTING.md`](CONTRIBUTING.md)**. The key rule: any change touching `server/config.json`, `server/game.js`, or `server/engine.js` is a "game mechanic" change and must add a player-facing bullet under `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md) — CI enforces it.

New maps are submitted straight from the in-browser editor (`create.html`), which opens a PR; a CI workflow validates and renders the map and posts a preview comment.

---

## Tech stack

Node.js · Express · Socket.IO · esbuild · Supabase (optional) · vanilla-JS canvas client. Deployed on Heroku.
