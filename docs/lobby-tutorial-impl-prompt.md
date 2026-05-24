# Lobby Tutorial — Implementation Prompt

> This file lives at `docs/lobby-tutorial-impl-prompt.md` on branch
> `worktree-lobby-tutorial-analysis`. Hand its contents to a fresh agent to start the
> implementation. It assumes no prior conversation context and points at the committed analysis
> doc as the source of truth.

---

Implement the in-lobby tutorial for the chaochao game (Node server in `server/`, browser client
in `client/scripts/`, Voronoi-cell maps in `client/maps/`).

**This prompt file:** `docs/lobby-tutorial-impl-prompt.md` (you're reading it). The authoritative
design lives in `docs/lobby-tutorial-analysis.md` — read that first.

## START HERE — read these first, in order
1. `docs/lobby-tutorial-analysis.md` — the full design + feasibility analysis. This is the
   source of truth for WHAT to build and WHY. Read it completely before writing code.
2. The already-drafted artifacts on this branch (`worktree-lobby-tutorial-analysis`):
   - `client/maps/_lobbyTutorial.json` — the tutorial map (generated, committed)
   - `tools/genLobbyTutorialMap.js` — deterministic generator for that map (re-run to tweak layout)
   - `tools/previewLobbyMap.js` — renders a map JSON to a standalone HTML for visual review
   - `docs/lobby-tutorial-preview.png` — what the map looks like

## GOAL
A no-text tutorial built into the game lobby. Instead of prompts/wording, the lobby contains
curated terrain "islands" (lava, ice, sand, grass biomes, two goal tiles, two bomb ability
tiles, two bumper hazards) sitting on the plain lobby background. Players walk around before the
game starts and learn movement, terrain feel, the win condition (goal), and the danger (lava) by
interacting — with no real-game consequences.

## ALREADY DONE (verify, don't redo)
- New `background` terrain type (`server/config.json` tileMap, id 9): transparent render
  (`draw.js` `renderMapToCache` skips it), normal physics + off-island grip reset
  (`Player.handleHit` branch in `server/game.js`). This is the lobby field + the decision-10
  "sanctuary".
- `lobbyOnly` maps are filtered out of race rotation (`GameBoard` ctor: `this.maps` vs
  `this.lobbyMaps`).
- The tutorial map exists with `lobbyOnly:true` and a `spawnPad` field.

## REMAINING WORK (the "Still TODO" list in the doc — implement these)
1. **startLobby**: load `this.lobbyMaps[0]` into `currentMap` and broadcast it to clients (mirror
   the existing `newMap` plumbing); render the map + enable cell collision during the lobby
   state (`checkCollisions` lobby branch must call `_engine.checkCollideCells`; client must
   `drawMap` in lobby + load the map on the `startLobby` event).
2. **Option-B respawn**: build ONE `respawnInLobby(player)` helper. In lobby state, lava and goal
   hits must play the existing death/win feedback then respawn the player at the `spawnPad` (with
   jitter) — NOT run the real death/win path.
3. **Respawn invulnerability**: 2–3s after respawn, with a flash/fade indicator (player sprite
   has no alpha today — must add; sync an invuln flag to the client following the `onFire` event
   pattern). During invuln, lava/goal hits are ignored.
4. **Curated abilities**: un-gate `ability.use()` for the lobby state in `checkAttack`. Lobby
   ability set is bomb (+ iceCannon/speedBuff/speedDebuff/cut); swap/blindfold/tileSwap are
   excluded — do this via the hard-coded ability tile ids in the map (bomb=102), NOT a config
   `spawnable` flag (the pool is global/shared). Enable lobby projectile→terrain collision for
   ice cannon.
5. **Fast lobby-only ability-tile respawn**: a short timer restores a consumed ability tile
   (pickup rewrites it to normal) so every player can learn, not just the first.
6. **Map-reset cadence**: restore the pristine layout on game-start / lobby-(re)start /
   lobby-empty, plus a 15s idle-gated safety reset (reset only if the map differs from pristine
   AND no ability/projectile activity for 15s). Restore = reapply pristine cell ids + broadcast
   `tileChanges`; `this.maps`/templates hold untouched copies.
7. **Dampen ALL lobby SFX uniformly** (single lobby volume scalar in `client/scripts/audio.js`).
8. *(Optional)* editor "erase"/transparent brush in `create.js` to paint the background type.

## CRITICAL CORRECTNESS LANDMINES
(From a 4-agent deep scan — see the doc's "Scoring safety" and "Deep-scan validation" sections.)
- **NO SCORING IN LOBBY, and this means MORE than notches.** Un-gating `ability.use()`/punch will
  increment the achievement stats `resourceful` (every ability fire) and `bully` (every punch)
  in `checkAttack` — these are persistent and pollute end-game achievements. Guard them in lobby
  state. Also do NOT route lobby lava/goal through `killPlayer`/`removeNotch` or
  `reachedGoal`/`playerConcluded`/`addNotch`.
- **`respawnInLobby` MUST clear `onFire` explicitly** — the normal race-start `reset()` only
  clears it in the `gameOver` branch, so a lobby fire-pickup would leak into the first real round.
- **Force functions bypass the invuln/sanctuary guards**: `cutPlayer` (`engine.js`) and
  `applyExplosionForce` mutate position/velocity directly. They must also respect
  sanctuary/invuln, or another player's cut/bomb can fling an invuln player into lava.
- **Sanctuary = the `background` terrain type.** Guard mutation sites
  (`explodeBomb`/`explodeIce`/`explodeLava`/`changeTile`) against background cells, reusing the
  existing goal/lava `continue` idiom already in those functions.
- **Projectiles/abilities/timeouts are state-blind** and can outlive the lobby→gated transition —
  test that case.

## PROCESS
- This is in a git worktree (cwd under `.claude/worktrees/`). Work here; commit incrementally.
- File:line references in the doc may have drifted — locate code by SYMBOL NAME (function names
  like `startLobby`, `checkCollisions`, `checkAttack`, `handleHit`, `killPlayer`,
  `generateHazards`) and re-verify before editing.
- Keep the generator deterministic; if you adjust the map, edit `tools/genLobbyTutorialMap.js`
  and re-run it rather than hand-editing the JSON.
- **DESIGN CONSTRAINT:** absolutely no on-screen text or prompts in the lobby — teaching is purely
  through interaction.

## VERIFY as you go
- `node --check` on every edited `.js`; confirm `config.json` + the map JSON still parse.
- Run the server (`npm start`) and confirm: the lobby shows the islands; you can walk around;
  lava kills-with-feedback then respawns you at the spawn pad with an invuln flash; touching a
  goal plays the win feedback then respawns you; a bomb ability picks up and fires; bumpers knock
  you; and after a lobby session full of deaths/goals/abilities, a player's notches AND
  achievement stats are unchanged when a real game starts. (`tools/previewLobbyMap.js` is for
  static map review only — verify real behavior in the running game.)

When done, update `docs/lobby-tutorial-analysis.md` to mark the implemented items.
