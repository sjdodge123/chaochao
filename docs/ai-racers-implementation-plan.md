# Implementation Plan: Fair Single-Player Lava + AI Racers with Personalities

Status: **Design complete, not yet built.** This plan covers two linked problems with the single-player experience and the AI system that fixes the second.

## Problems

1. **The lava is not tuned per map, so solo rounds are often unwinnable.** There is no general fixed lava timer. In a solo game there is exactly one player, so `alivePlayerCount == 1` is true from the start and every round falls into the **last-player-standing** branch (`server/game.js:363-376`): 15 s after the start, the collapse begins from a *randomly chosen* goal tile (`gameBoard.findRandomGoalTile()`) and advances radially at a fixed `lastPlayerCollapseSpeed: 0.75` units/tick, blind to map size or where the player spawned. The 15 s start, the random center, and the map-blind speed have nothing to do with the distance the player must travel, so beating the map is effectively luck.

2. **There are no AI players to race against.** Every player today is tied to a Socket.IO connection; nothing creates a non-socket player.

## Core architecture decisions

### Bots are headless server-side players
A bot is a `Player` object in `room.playerList` with **no socket**. It does not round-trip through Socket.IO. An `aiController.update(dt)` runs each tick (before `engine.updatePlayers`) and writes the exact `Player` fields the socket handlers would have written:

| Field | Consumed by | Purpose |
|---|---|---|
| `targetDirX`, `targetDirY`, `braking` | `server/engine.js:65` (existing `isAI` branch) | steering |
| `angle` (degrees) | `cutPlayer`, `spawnBomb`, `spawnSnowFlake` | aiming directional abilities |
| `attack` | `checkAttack` (`server/game.js:2044`) | fires held ability, else punches |

The engine **already has** the `isAI` movement branch — it reads `targetDirX * .8`, `targetDirY * .8`, `braking`. Nothing currently sets those. The bot's "hands" exist; we are building the "brain."

### Both fixes share one foundation: a traversability graph
Maps are player-made Voronoi diagrams, but **adjacency is already in the map JSON**. Each cell carries `site{x,y,voronoiId}`, a tile `id`, and `halfedges[]` whose `edge.lSite`/`edge.rSite` give the neighbor on each side. No recomputation and no voronoi library at runtime — neighbors are extracted directly. Tile `id` gives passability (lava = blocked/deadly, goal = win, all else traversable). From this we build a cell adjacency graph once at map load and run A* / reachability over it. This single graph powers:
- **Lava fairness** — optimal spawn→goal distance → a "par time" → a tuned collapse.
- **Map validation** — is any goal reachable from spawn? (also useful for the Preview/Playtest editor feature).
- **Bot navigation** — A* to the nearest reachable goal.

### Difficulty model (locked)
**Within-race rubber-banding only.** No persistence. The difficulty signal is the player's live progress-to-goal versus the bot field, reset each race.

### Grid size (locked)
Fill to a **random total in the 6–10 range**: `target = randomInt(6, 10)`, then spawn `target - humanCount` bots (local-multiplayer humans count against the total).

### Personalities (locked)
**Fixed cast, exact every time** — each character is a static profile in `config.json`, used verbatim with no per-race jitter. Per-race variety comes from (a) the random subset of the cast that spawns and (b) the within-race rubber-band. Deterministic personalities + a seed give reproducible races for tuning/debugging. **Full identity + emotes** — names, titles, and reactive taunts triggered by server-detected events.

---

## The four behavior pillars

### Pillar 1 — Racing brain
Per bot, per tick:
1. A* over the cell graph to the nearest reachable goal; edge cost weighted by tile type (slow/ice expensive, fast cheap), lava blocked.
2. Steer `targetDirX/Y` toward the next waypoint, set `braking` into turns (lookahead smoothing to avoid wiggle — the fiddly part).
3. Re-path on the `collapsedCells` event (mark newly-lava cells blocked) and avoid the advancing collapse.

### Pillar 2 — Nuanced ability use
The bot holds at most one ability (`player.ability`). An **ability policy** scores the held ability against current state `(rank, distance-to-goal, collapse state, rival positions, path geometry)` and returns *fire?* + *angle*, gated by a difficulty-scaled threshold. Per-ability heuristics (mechanics confirmed in code):

| Ability (id) | Mechanic | Bot heuristic |
|---|---|---|
| **bomb** (102) | projectile (speed 11000, life 3 s, blast 100) → slow tiles + knockback; grants `bombTrigger` (103) after 200 ms | aim at a rival cluster / chokepoint ahead; hold, then detonate via trigger when a rival is in blast. *Two-step timing.* |
| **swap** (101) | aimer grows 15→300 over 3 s, swaps pos/vel/physics with a random nearby player | fire only when **behind**, near a leader; never when leading (random target risk) |
| **speedBuff** (104) | self ×1.5, 3 s | spend on a low-curvature straight or to beat a closing collapse |
| **speedDebuff** (105) | all rivals slowed, 4 s | when leading, to extend the gap, or near finish |
| **cut** (108) | shoves all other players perpendicular to facing (5 px) | when rivals cluster near; angle to shove them toward lava/edge |
| **iceCannon** (107) | projectile → ice tiles + self +100 speed, life 1 s | ice a rival's path ahead, or self-boost on a straight |
| **tileSwap** (106) | swaps all fast↔ice map-wide | fire only if net route-cost delta improves bot ETA vs field |
| **blindfold** (100) | vision effect (target TBD — see open items) | irrelevant to bot navigation; offensive vs humans only |

Trigger path: set `angle` (degrees) for directional abilities, then `attack = true`. `checkAttack` (`game.js:2044`) fires `ability.use()` which sets a flag; `checkAbilities` (`game.js:791-835`) executes it next tick.

### Pillar 3 — Brutal-mode handling
A **strategy layer** keyed on the active brutal mode sits above the base racer. Most modes are parameter nudges; two flip the objective:

| Mode (id) | Effect | Bot adaptation |
|---|---|---|
| **ability** (1000) | everyone spawns armed | raise threat awareness; use own ability per policy |
| **cloudy** (1002) | 10 clouds, **cosmetic vision-only (confirmed)** | ignore for pathing; apply vision self-handicap when a cloud overlaps the bot (see fairness guard) |
| **lightning** (1006) | +800 speed all, hazards ×3 | more lookahead + earlier braking (physics envelope changed); treat bumpers as faster |
| **volcano** (1007) | collapse starts early at a goal, speed 1 | collapse-avoidance brain with earlier trigger; flee eruption origin |
| **infection** (1008) | first to goal becomes a zombie, **can't win**, slowed, can't grab abilities; punches spread it | **objective flip:** deliberately do *not* finish first — hang back until someone else is infected. If infected → chase-and-punch humans to spread it |
| **hockey** (1009) | puck at center; punch toward goal; 800-force knockback | **objective flip:** target the puck, set angle/attack to punch it toward a goal; dodge puck |
| **explosive** (1010) | reaching goal spawns a growing 100px explosion | finish, but avoid lingering near a finishing rival |
| **blackout** (1011) | client vision message | ignore for pathing; vision self-handicap (fairness guard) |

### Pillar 4 — Difficulty, rubber-banding & personalities
**Skill knobs** (per bot, 0–1 each): reaction delay, steering noise, speed cap (fraction of `playerMaxSpeed 350`), path optimality, ability competence (threshold + targeting accuracy + timing).

**Composition:** `final behavior = personality biases × difficulty scaling`. Personality sets *style* (constant); rubber-band moves *competence* (live).

**Within-race rubber-band:** scale each bot's effective cap/competence by the player's progress-to-goal delta — player far behind → bots ease off; player leading → bots push. Per-race randomization + occasional "off moments" keep outcomes non-deterministic so a player win feels earned.

**Vision-fairness guard:** because the bot reads game state rather than the rendered screen, it is naturally immune to blindfold/blackout/cloud. When "blinded" (under a cloud, or hit by blindfold/blackout), the bot self-imposes degraded steering + reaction lag for the duration, so vision effects bite the AI as they bite a human.

**Personality trait axes** (bias weights over things the brain already computes): aggression, risk tolerance, ability tempo (hoarder vs trigger-happy), target focus (ignore combat / target leader / fixate on the human), tilt (rage-comeback / fold / unbothered), brutal-mode flavor.

**Starter cast** (static profiles in `config.json`):

| Name | Style |
|---|---|
| The Ghost | pure racer, optimal lines, ignores combat, hoards speed buffs — pace-setter |
| Bulldozer | max aggression (punch/cut/bomb), poor racing lines |
| The Gambler | high risk — corner-cuts by lava, impulsive abilities; big wins and big deaths |
| Nemesis | fixates on the human — swap/cut/debuff aimed at you, rubber-bands hardest to stay near you |
| Trickster | ability-chaos (tileSwap/blindfold/iceCannon), modest raw speed |
| Tortoise | cautious, safe lines, rarely dies, conservative in collapse |
| Hothead | calm when leading, reckless when behind (plays into the rubber-band) |

Grid draws a varied subset (distinct names/colors, no dupes), weighted so a race usually includes a pace-setter (Ghost) and a rival (Nemesis).

**Identity + emotes:** names/colors render for free (bots are `Player` objects the client already draws). Emotes need a new one-shot message `botEmote {id, emote}` + client render of a speech bubble and a title under the name. Triggered server-side off events already detected — `playerConcluded` (win/finish), `playerPunched` (knockout), near-collapse escapes, overtakes, swap/infection — filtered through each personality's taunt set, throttled to avoid spam. Converges with the **audience-sounds** backlog (crowd reacts to the same events) and the **skins** in the monetization plan (each personality = a recognizable skin).

---

## Phased build

Each phase from Phase 2 on touches `server/config.json` / `server/game.js` / `server/engine.js`, so each **requires a player-facing `## Unreleased` bullet in `CHANGELOG.md` in the same commit** (CLAUDE.md release-notes rule; enforced by `.github/workflows/release-notes-check.yml`).

### Phase 0 — Cell adjacency graph (shared foundation)
- **New:** a graph builder run at map load that, for each cell, derives neighbors from `halfedges[].edge.lSite`/`rSite` (the neighbor is whichever site's `voronoiId` ≠ the cell's own), and an A* / reachability query over it with tile-weighted edge costs and lava as blocked.
- **Where:** server-side map load (`server/utils.js` map loading ~`:393-401`; graph attached to the map object used as `currentMap` in `server/game.js`).
- **Acceptance:** given a map + a point, return shortest traversable path (cell sequence) to the nearest reachable goal, or `null` if none reachable.
- Pure addition; no CHANGELOG entry required (not yet a player-facing mechanic change).

### Phase 1 — Lava fairness + a real solo mode
- Detect single-player and route it to a dedicated solo collapse instead of the last-player branch.
- Compute par time from the Phase 0 spawn→nearest-goal distance + known physics (`playerMaxSpeed 350`, `playerBaseAcel 375`); derive collapse **start delay and/or speed** as `par_time × margin` (≈1.5–2×, tunable).
- Choose the collapse center as the **goal nearest the player's path** (not random), so the destination stays safe longest.
- Reject/flag maps with no goal reachable from spawn (reuse for editor Preview/Playtest validation).
- **Where:** `server/game.js` collapse trigger (`:363-376`), `startCollapse`, `collapseMap` (`:1168-1206`); new tuning keys in `server/config.json`.
- **Acceptance:** a competent line beats a representative sample of player maps; unbeatable maps are flagged. **CHANGELOG bullet required.**

### Phase 2 — Headless bot plumbing
- Spawn socketless `Player` objects; fill grid to `randomInt(6,10) - humanCount`.
- Guard the two socket-coupled spots: `messageClientBySig` (used by the AFK kick, `game.js:76`) — skip for bots; and `clientList`/`mailBoxList` registration in `messenger.js` (`:114-117`) — bots go in `playerList` only. (`messageRoomBySig` via `io.to().emit` and `compressor.js` are already socket-agnostic — bots render for free.)
- Add the `isAI` flag + bot identity fields (name, color, personality id) to the `Player` constructor (`game.js:1938-2027`) and `world.createNewPlayer`.
- **Acceptance:** bots appear in a solo room, render on the client, do not crash AFK/kick paths, sit still (no brain yet). **CHANGELOG bullet required.**

### Phase 3 — Base racing brain
- `aiController.update(dt)` per bot: A* → waypoint → `targetDirX/Y` + `braking`, with lookahead smoothing; collapse avoidance; re-path on `collapsedCells`.
- **Acceptance:** bots complete a representative sample of maps without getting stuck or driving into lava. **CHANGELOG bullet required.**

### Phase 4 — Ability policy
- Per-ability scoring + directional aiming; bomb throw-then-detonate timing via `bombTrigger`.
- **Acceptance:** bots pick up and use abilities in sensible situations (measured: ability not wasted into walls/empty space; bomb detonates near rivals). **CHANGELOG bullet required.**

### Phase 5 — Brutal strategy layer
- Param nudges (lightning/volcano/cloudy) + objective swaps (infection delay-or-hunt, hockey puck-push); vision-fairness self-handicap.
- **Acceptance:** bots don't suicide-finish in infection, do push the puck in hockey, and survive lightning/volcano. **CHANGELOG bullet required.**

### Phase 6 — Difficulty, rubber-band & personality profiles
- Skill knobs; live progress-based scaling; per-race randomization; personality bias bundles in `config.json` read by all upstream pillars.
- **Acceptance:** across many solo races the player wins a healthy-but-not-guaranteed share; distinct personalities are recognizable by behavior. **CHANGELOG bullet required.**

### Phase 7 — Identity + emotes (client)
- `botEmote {id, emote}` one-shot message; client renders speech bubble + title; server triggers off existing events filtered by personality, throttled.
- **Client changes:** new handler in `client/scripts/client.js`, render in `client/scripts/draw.js`; add any new script to the `play` bundle list in `build.js` **and** the `<!-- BUILD: bundle-start -->` block in `play.html`.
- **Acceptance:** characters taunt/emote on the right moments without spam. (UI/CSS-only parts are CHANGELOG-exempt; any mechanic-coupled bits carry a bullet.)

---

## Networking / client touch-points
- Bots serialize through `compressor.js` from `playerList` with no changes (socket-agnostic). Per-tick `gameUpdates` reach clients via `messageRoomBySig` → `io.to(room).emit`.
- New server→client message: `botEmote` (Phase 7). Update the matching handler in `client/scripts/client.js`.
- Personality profiles ride the existing `config` socket event (they live in `config.json`), so name/color/title are available client-side automatically.

## Open verification items (confirm in code before the relevant phase)
1. **blindfold target** — the search read it as self-blinding, which is suspicious; confirm whether it blinds the user or everyone else (affects Pillar 2 + the vision-fairness guard). *Phase 4/5.*
2. ~~clouds collidable vs cosmetic~~ — **resolved: cosmetic vision-only.** Bot ignores them for pathing; vision self-handicap applies.

## Risks / caveats
- **Par-time is an estimate** (graph distance ignores acceleration and turning) — lean on a generous margin and playtest-tune (Phase 1).
- **Steering a momentum car along a cell-center polyline** needs lookahead smoothing or bots visibly wiggle (Phase 3) — standard but not free.
- **Voronoi adjacency** assumes a shared edge means a passable boundary; passability is really "tile is not lava," and the world boundary (`bounceOffBoundry`) is the only wall, so the graph stays simple.
- **Performance:** A* runs per bot; cache paths and re-path on a throttle / on `collapsedCells` rather than every tick.

## Source references (as of this writing — verify before editing)
- State map: `server/config.json:255-262`. Collapse triggers: `server/game.js:343`, `:363-376`; `collapseMap` `:1168-1206`; `collapseLine` init `:1304`.
- Speeds: `worldCollapseSpeed 6`, `lastPlayerCollapseSpeed 0.75`, volcano `collapseSpeed 1` (`config.json`).
- Goal detection: `server/game.js:2341-2352`; `server/engine.js:504-539`.
- Player object: `server/game.js:1938-2027`. `isAI` movement branch: `server/engine.js:56-139` (esp. `:65`).
- Input handlers: `server/messenger.js:175-191` (movement), `:193-204` (mousemove/angle); join/add player `:114-117`.
- Socket coupling: `messageClientBySig` `server/messenger.js:212`, AFK kick `server/game.js:76`.
- Abilities: `config.json:99-152`; acquire/trigger `server/game.js:2354-2424`, `checkAttack :2044-2070`, `checkAbilities :791-835`; cut `server/engine.js:462-484`.
- Brutal rounds: `config.json:155-231`; implementations across `server/game.js` (`applyBrutal*`, `checkForActiveBrutal`).
