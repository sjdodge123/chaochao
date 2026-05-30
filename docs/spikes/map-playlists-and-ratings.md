# Spike: Map Playlists + Star Ratings

**Status:** IMPLEMENTED on branch `worktree-map-playlists-spike` (Phases 0–4), not pushed.
**Author:** design pass (Claude) with operator decisions, 2026-05-30.

## Implementation summary (commits on worktree-map-playlists-spike)

- **Phase 0** `9f028f4` — `server/mapClassifier.js` (geometry meta + balanceScore + tier),
  `config.json` balance thresholds + `playlists[]`, wired into `utils.loadMaps`;
  `.github/scripts/classifier-test.js`. Result: 43/51 Featured at threshold 90.
- **Phase 1** `4fcd330` — playlist-aware rotation in `gameBoard` (`playlistId`,
  `getEligibleMapIndices`, `setPlaylist`, fallback to full pool); fixed a latent
  wrap-boundary repeat; `playlist-selection-test.js`.
- **Phase 2** `e6852a1` — lobby playlist hub board (`playlist` station, `lobbyHub.js`
  panel + status banner, `setLobbyPlaylist`/`lobbyPlaylistChanged`, summary in
  contentDelivery, station authored in `_lobbyTutorial.json` at a verified-walkable spot).
- **Phase 3** `6ccbd3d` — editor filter chips + per-card badges (`editorMapMeta`),
  read-only `scoreMap` → soft submit warning (submit/PR path untouched).
- **Phase 4** `4885b34` — star ratings: `supabase/migrations/..._map_ratings.sql`,
  `server/ratings.js` (weighted Bayesian), `rateMap` handler (gated, dedup, anti-bot),
  boot+interval refresh, Crowd Favorites, game-over star widget; `ratings-test.js`.

**Remaining operator/follow-up work:** apply the Supabase migration via the CI migration
pipeline (not MCP); set `ALLOW_SUPABASE_WRITES=true` on Heroku to enable rating writes;
playtest the lobby hub board (confirm the playlist station's authored position on clear
ground) and the game-over star widget; add gamepad nav for the star widget; then rebase +
PR with operator go-ahead.

## Problem

Anyone can submit maps via the in-browser editor; most are not balanced for a good
experience. Today every non-lobby map sits in one flat pool and is picked by blind
random rotation (`gameBoard.getRandomMapR()`), with no notion of map *character* or
*quality*, and no way for players to influence what they play. We want maps
auto-grouped into selectable playlists (chosen at a lobby hub, filterable in the
editor) plus a player star-rating signal for "best maps."

## Core reframe: three orthogonal signals

| Signal | Question | Source | Used for |
|---|---|---|---|
| **Character** | What *kind* of map? (ice / pinball / lava / sprint / pure) | Geometry, computed at boot | Discovery, variety, themed playlists |
| **Balance** | Is it *fair and playable*? | Geometry, computed at boot | Quality gate → "Featured" tier; soft submit warning |
| **Rating** | Is it *fun*? | Player stars (human taste) | "Crowd Favorites" playlist |

A map gets **one balance tier**, **multiple character tags**, and **one aggregate
rating**. Playlists are named filters over these. Balance (fair) and Rating (fun) stay
**separate** — a geometrically-fair map players dislike, and a chaotic map players love,
are both meaningful and shouldn't be collapsed prematurely.

## Operator decisions (locked)

- **Lobby UI = hub board**, not a single walk-up station. A dedicated board in the lobby
  showing each playlist with a preview thumbnail + live map count.
- **Playlist selection = last-writer-wins, room-wide** (mirrors the existing AI-bot dial:
  any player can set it, broadcast to all, persists across rounds). No voting.
- **Soft balance warning at submit** = yes. Non-blocking nudge when a submitted map scores
  below the Featured threshold, explaining why (e.g. heavy lava, single chokepoint).
- **Star ratings:** anonymous voting allowed; **authenticated votes weighted higher**.
- **Default playlist = Featured** (assumption — replaces today's blind rotation with the
  auto-balanced pool; flag if you'd rather keep "Everything" as default).

## Grouping dimensions (all computed at boot, deterministic, no telemetry)

Computed the same way `parTime` already is in `utils.loadMaps()` (`server/utils.js:705`,
`server/cellGraph.js:424`). Attach a `map.meta` object.

**Character tags:**
- **Length** from `parTime`: sprint / standard / marathon.
- **Tile composition ratios** (each tile id ÷ walkable cells) → `dominantTrait`:
  ice → "Slip & Slide", lava → "Hardcore", bumper/hazard-dense → "Pinball",
  ability-tile-heavy → "Powerup Mayhem", mostly normal/fast → "Pure Racing".
- **Hazard density** (bumpers ÷ area) → chaos level.
- **Start-edge count** (1 vs 2 opposite edges) → "Head-to-head / convergence".
- **Route count / openness** (from cellGraph BFS) → "Technical/linear" vs "Open/multi-route".

**Balance score (0–100):**
- Passes `validateMap` hard checks already present (`server/utils.js:553`): goal reachable
  from every start edge.
- **parTime in a sane band** (not trivial, not a slog).
- **Fairness** — cellGraph computes parTime *per start edge*; for 2-edge maps,
  `min/max` of those = spawn symmetry. Lopsided → penalty.
- **Walkable fraction** — mostly-lava or mostly-empty → penalty.
- **Hazard sanity** — bumper density within a playable range.
- **(1.5) Chokepoint severity** — narrowest walkable band between start and goal from the
  BFS; a single 1-cell funnel for a crowd → penalty.

`tier = "featured"` above threshold, else `"community"`.

## Playlists (data-defined in `config.json`, delivered via the existing `config` event)

Each playlist = a simple predicate over `map.meta`. Membership is **precomputed per map at
boot** (`map.meta.playlists = ['featured','sprint','ice']`) so selection + editor filtering
are array checks. A map can sit in several.

| Playlist | Filter |
|---|---|
| **Featured** (default) | `tier=featured` |
| **Everything** | none (today's behavior) |
| **Quick Sprints** | `length=sprint` |
| **Marathon** | `length=marathon` |
| **Slip & Slide** | `trait=ice` |
| **Pinball** | `trait=bumper` |
| **Hardcore** | `trait=lava` |
| **Pure Racing** | `trait=pure` |
| **Crowd Favorites** | `rating.bayesian >= threshold` (cold-start → falls back to Featured) |
| **Wild / Unsorted** | `tier=community` |

## Star ratings

**Where:** primary = game-over recap (just played it) — a 5-star strip, `data-gp-nav` for
pad/touch, one tap submits, tap again to change. Secondary = editor map browser cards.

**Anti-abuse:**
- One effective vote per voter per map, stored as an **upsert** (change overwrites).
- **Voter id:** stable `localStorage` UUID for anon; Supabase user id when signed in (JWT
  already on socket handshake from the auth foundation). Authed votes **weighted higher**
  and countable separately as "verified."
- **Must have participated** in that map this session to rate it.
- **Bayesian average** (IMDB-style): `weighted = (v/(v+m))·R + (m/(v+m))·C` so low-sample
  maps don't dominate the "best" list.
- **Server rate-limit** per socket.
- Whole write path **behind `auth.writesEnabled` / `ALLOW_SUPABASE_WRITES`** (master
  kill-switch). Reads work with writes off; locally writes no-op (empty/sample data).
- In-game AI are server-spawned, not sockets — they can't emit `rateMap`, so automated
  bots aren't a ballot-stuffing vector; the guards above target human sybil/refresh stuffing.

**Supabase (schema via CI migration pipeline `<timestamp>_name.sql`, NOT MCP):**
- `map_ratings(map_id, voter_id, stars 1–5, is_authed, created_at, updated_at)`,
  unique `(map_id, voter_id)`.
- `map_rating_summary(map_id, vote_count, avg, bayesian)` — refreshed periodically + at boot.

## Implementation phases

**Phase 0 — Classifier (server, no UI).** New `server/mapClassifier.js`: map+config → `meta`
(ratios, length, trait, fairness, balanceScore, tier, tags). Call inside `utils.loadMaps()`
where `parTime` is computed; attach `map.meta`. Add `playlists[]` defs to `config.json`,
resolve each map's membership. Headless smoke-test: every committed map classifies without
throwing; Featured non-empty. *Gives the balance signal before any UI.*

**Phase 1 — Playlist-aware selection.** Room gains `this.playlistId` (default `featured`);
`getRandomMapR()` (`gameBoard.js:1698`) filters `maps[]` by membership before picking, with
fallback to `all` if a playlist has <2 maps (rotation never starves).

**Phase 2 — Lobby hub board.** Dedicated lobby hub showing playlists with preview thumbnails
+ live counts; selecting one sets `room.playlistId`, broadcasts `lobbyPlaylistChanged`
room-wide (mirror `lobbyAIChanged`), persists across rounds. Deliver playlist defs+counts in
`config`/`contentDelivery`. Reuse `lobbyHub.js` nav/input infra; pad/touch/keyboard.

**Phase 3 — Editor filter + soft balance warning.** Extend `maplisting` payload with each
map's `meta`. Filter chips above the existing card grid (`create.html:704`, client-side by
`data-playlists`); quality badge + trait tags on each card. At submit, if score <
Featured threshold, show a **non-blocking** warning explaining the main deductions
("heavy lava, single chokepoint — submit anyway?").

**Phase 4 — Star ratings.** Supabase tables (via CI migrations); `messenger.js` `rateMap`
handler (validate stars 1–5, participation, upsert behind `auth.writesEnabled`, rate-limit);
load `map_rating_summary` at boot + interval into `map.meta.rating`; resolve Crowd Favorites
membership. Recap 5-star UI (`data-gp-nav`); editor star badge + "Top Rated" chip/sort.
Headless smoke-test the `rateMap` path with the fake-`io` recorder (dedup/upsert; empty
summary tolerated).

**Phase 5 (later) — Telemetry blend.** Use existing `round_complete`/`match_end` analytics +
ratings to add a correction term to balance / a "Recommended" blend.

## Key file references

| Concern | File | Lines |
|---|---|---|
| Map load + parTime hook | `server/utils.js` | 705–741 |
| parTime / per-edge / reachability | `server/cellGraph.js` | 416–446 |
| validateMap (hard gate) | `server/utils.js` | 553–667 |
| Map selection (random rotation) | `server/entities/gameBoard.js` | 1481–1507, 1698 |
| Lobby stations (server) | `server/entities/gameBoard.js` | 883–946 |
| Lobby hub (client) | `client/scripts/lobbyHub.js` | 245–730 |
| AI dial broadcast (pattern to mirror) | `server/game.js` / `client/scripts/client.js` | 499–507 / 65–70 |
| Editor map browser + search | `client/create.html` / `client/scripts/create.js` | 704–717 / 249–278 |
| Map submission | `client/scripts/create.js` | 1666–1692 |
| Config (tiles, playlists) | `server/config.json` | 62–200 |

## Conventions to honor

- Game-mechanic changes (config/game/engine) need a `CHANGELOG.md` `## Unreleased` bullet.
- New pad-reachable controls get `data-gp-nav`.
- Supabase writes behind `ALLOW_SUPABASE_WRITES`; schema only via CI migration pipeline.
- Strip any localhost-only dev controls before PR; rebase onto `origin/main` first; PR only
  with operator go-ahead.

---

## Operator-injectable follow-up prompt

> Implement Phase 0 of the map-playlists spike (`docs/spikes/map-playlists-and-ratings.md`):
> a boot-time map classifier. Create `server/mapClassifier.js` exporting a function that
> takes a reconstructed map + config and returns a `meta` object with: tile-composition
> ratios, `length` (sprint/standard/marathon from parTime), `dominantTrait`
> (ice/lava/bumper/ability/pure), hazard density, start-edge count, per-edge fairness
> (min/max of cellGraph per-edge parTimes), a 0–100 `balanceScore`, and `tier`
> (featured/community). Call it inside `utils.loadMaps()` right where parTime is computed and
> attach `map.meta`. Add a `playlists[]` array to `config.json` (Featured, Everything,
> Quick Sprints, Marathon, Slip & Slide, Pinball, Hardcore, Pure Racing, Wild) and resolve
> each map's `meta.playlists` membership at boot. Add a headless assertion (smoke-test style)
> that every committed map classifies without throwing and that the Featured pool is
> non-empty. No UI and no selection changes yet — print a table of every committed map's
> trait/length/balanceScore/tier so we can eyeball how today's maps score. Don't push.
