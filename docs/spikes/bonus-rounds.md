# Spike: Bonus Rounds (Mario Party–style mini-games between races)

**Date:** 2026-06-11
**Question:** Can we insert competitive mini-game "bonus rounds" between races — XP-only rewards,
no carry-in abilities or flame, rotating roster of dozens of games — without conflicting with
existing gameplay?

**Verdict: Feasible and a good architectural fit. No fundamental conflicts.** The state machine
has a clean seam between races, the brutal-rounds system is a ready-made template for a rotating
per-round variant registry, and the XP pipeline absorbs bonus awards with zero new persistence
surface. There are ~6 real conflicts to design around (listed below); all are tractable. The
single biggest recurring cost for "dozens of games" is **bot participation** — every mini-game
needs an AI behavior or bots stand around looking broken.

---

## 1. Where bonus rounds slot in

The round loop is `racing → collapsing → startOverview() → checkNewRaceTimer() (overview timer)
→ startGated() → startRace()` (`server/game.js:218-229`, `1282`, `593-612`, `1110`, `1160`).

**Insertion point:** a new `bonusRound` state entered from `checkNewRaceTimer()` instead of
`startGated()` when the cadence rolls a mini-game, exiting back into `startGated()` when the
mini-game ends. This means:

- The score overview still plays after every race (players see notch updates as usual).
- The next race's map was already chosen and announced in `startOverview()`
  (`determineNextMap`, `game.js:1283`) — the bonus round doesn't disturb map rotation because
  `loadNextMap` only advances `currentMap` later, at the gate.
- `startGated()` is the single choke point every race start flows through (maintenance drain,
  bot fill, team broadcast — `game.js:1110-1158`). Entering it *after* the mini-game keeps all
  those invariants intact untouched.

`stateMap` is config-delivered to the client (`server/config.json:439`), so adding
`"bonusRound": 7` automatically reaches both sides; the client needs a matching state branch
(see §5).

## 2. The brutal-rounds system is the template for the rotating roster

Brutal rounds already are "a registry of variant rounds, one picked per round, config-gated":

- Registry: `c.brutalRounds` — `{ ability: {id:1000, active:true, title:'Ability'}, cloudy:
  {...}, ... }` with inactive entries parked (`gravity`, `bomb`, `fiesta` have `active:false`).
- Per-mode dispatch is by numeric id checks (`checkForActiveBrutal(c.brutalRounds.X.id)`) at
  race start and in the tick (`game.js:1184-1224`, `696-740`, `815-840`).
- CI: `mode-smoke-test` auto-discovers active modes and ticks each end-to-end headlessly.

A `c.bonusRounds` block with the same shape (`{ suddenDeath: {id:2000, active:true,
title:'Sudden Death', xpWin:75, ...} }`) plus a `BonusGame` controller per mode gives the
rotation system. Selection = weighted random excluding the last N played (room remembers
recent ids, same spirit as map rotation). Cadence = config knob, e.g. `bonusRoundEvery: 2`
races, or "after every brutal round" as a breather.

**Recommendation:** unlike brutal's inline-in-game.js dispatch, give each mini-game its own
controller object with a tiny interface (`setup(room)`, `update(dt)`, `isOver()`,
`results()`, `cleanup()`), registered in a map keyed by id. With dozens planned, inline
switch dispatch in `game.js` will not scale (file-size conventions in ARCHITECTURE.md), and a
`server/bonusGames/` directory keeps each game ~50–150 LOC and independently testable.

## 3. The conflicts (and the design-around for each)

### 3.1 Abilities persist between rounds **on purpose** — stash, don't clear
`startGated()` comment (`game.js:1122-1126`): *"reset() only clears ability at gameOver, so
abilities legitimately persist between rounds."* Players bank an ability and carry it across
races; that's a real mechanic. "No carry-in abilities" therefore must **stash
`player.ability` on bonus-round entry and restore it on exit** — clearing it would silently
nerf the banked-ability mechanic every time a bonus round fires. Same in reverse: anything
granted inside a mini-game (a punch-fest game might hand out bombs) must be dropped on exit.

### 3.2 Flame / kill attribution leaks into match medals — snapshot & gate
`burnedBy` persists past punch expiry for lava-kill credit (`server/entities/player.js:753,
1149-1165`) and `onFire` is only cleared in specific paths (`gameBoard.js:1328` notes the
race-start reset only clears it in the gameOver path). Additionally, **per-match medal
counters run match-long** (`player.js:209`; tallied best-in-match by
`achievements.js:gatherAchievements`). A combat mini-game would inflate `mostKills`,
`heavyHitter`, `mostMurdered`, punch counters, etc., and skew who wins the match medals.

Design-around: on bonus-round entry, snapshot the per-match stat fields that mini-game combat
can touch; on exit, restore them (or better: gate the increment sites on
`currentState != bonusRound` — fewer fields to enumerate as new medals are added, but more
touch points). Either way this is the fiddliest part of "preserve existing game state" and
deserves a headless test asserting *stat invariance across a bonus round*.

### 3.3 Round-pacing counters must not tick
Brutal chance increments per round (`chanceOfBrutalRoundIncrement: 25`,
`nearVictoryBrutalRoundBoost`, `maxTotalBrutals: 3` — `config.json`), and dynamic game length
(`checkForDynamicGameLength`) calibrates match pacing. Bonus rounds must be invisible to all
of these — they are not rounds. Since the insertion point is *before* `startGated()`, nothing
in the race-start path runs during a mini-game, so this mostly falls out free; just don't
route bonus-round entry through `startGated()`/`startRace()`.

### 3.4 Notches vs XP — already separable
Notch scoring happens in `checkForWinners` during racing/collapsing; the bonus state never
runs it, so mini-games award no notches by construction. XP: accumulate
`player.bonusXpEarned` during mini-games and fold it into `awardProgression()`
(`game.js:1639-1714`) at match end with its own toast line (`buildToastEvents`,
`progression.js:236-267`, already supports typed events — add `{type:'xp_bonus_round'}`).
This reuses the signed-in gate, CAS persistence, and pending-toast delivery untouched. New
config keys: `xpBonusWin`, `xpBonusParticipate` (pattern of `config.json:425-428`).
Optional later: a `bonusRoundWins` medal + cosmetic unlock — the 5-step recipe is mechanical
(`progression.js:100-162`, `achievements.js:25-56`).
**Caveat:** XP lands at match end, not at the mini-game podium. Players who quit mid-match
lose accrued bonus XP (consistent with today's race XP, which also settles at gameOver — fine,
but say so in the Codex). The mini-game podium screen should show "+75 XP (paid at match end)"
style messaging or just the toast at gameOver.

### 3.5 Bots — the real per-game cost
Rooms are bot-filled (`fillGridWithBots`, `game.js:1140`); bots earn no XP (filtered at
`game.js:1641`), which is fine — but they **must visibly play** each mini-game or the room
looks broken. `aiController` only knows race-to-goal steering plus combat primitives. The
practical rule: **design mini-games whose objective maps onto existing AI primitives** —
"reach/hold a target tile" (goal-seek), "punch the player with the crown" (existing chase +
punch), "dodge the telegraphed strike" (lava-avoid steering), "last one on the shrinking
platform" (bunker-style ring already has AI handling). Each game's controller exposes a
per-tick AI hint (target point + aggression flag) the aiController consumes generically —
one AI hook, not one AI rewrite per game. Games that need wits/memory (quiz, Simon-says)
should be parked until later; bots can't fake those convincingly.

### 3.6 Late join, AFK, teams, exclusivity
- **Late join:** gated late-joins exist today; during `bonusRound` the simplest correct rule
  is spectate-until-next-gate (the bunker EXCLUSIVE pattern shows how a mode suppresses
  normal flows).
- **AFK/sleep:** sleeping-player handling and the 0-client server sleep loop key off states —
  the new state must be included wherever racing/collapsing are treated as "active play".
- **Teams (Crimson-vs-Jade):** v1 should run mini-games FFA regardless of mode (individual
  XP), with team-scored mini-games as a future variant; `teamUpdate` broadcasts stay
  untouched since no notches move.

## 4. Arenas

Options, cheapest first:
1. **Reuse the just-played map** with the mini-game painting tiles via the existing mutation
   helpers (heatwave/orbital-beam precedent) — zero new map assets, good for combat/survival
   games.
2. **Dedicated mini-arena JSONs** in `client/maps/` with a flag exempting them from rotation
   and from map-fairness CI (the lobby map precedent: it lives outside normal rotation and
   uses sentinel cell ids 102–108 — and note validate-content's `typeof number` looseness is
   load-bearing, don't tighten it). The newMap payload path already handles pushing an
   arbitrary map at a state change (`gameBoard.setupMap`, preview pinning).

Start with (1); add (2) when a game concept demands custom geometry.

## 5. Client work

- New state branch in `client/scripts/client.js` (gameState handling) + `draw.js` HUD: game
  title card, countdown, per-game visuals, podium/results splash. `currentState` already
  rides the existing payloads (`gameBoard.newMapPayload.currentState`, `game.js:502`) —
  compressor lockstep rule applies to anything new in `gameUpdates`.
- Mini-game results can ride a one-shot socket event (`bonusRoundResults`) rather than the
  per-tick payload.
- Icons: follow `brutalRoundImages[id]` pattern (`chaochao-iconography` convention — no emoji).
- Sounds: synth or licensed stingers per game; remember lobby SFX-dampen rule when testing.
- Codex: add a Bonus Rounds entry to the `CODEX` array in `learn.js` (+ scene), per the
  learn-page convention.

## 6. CI / process obligations

- `game.js`/`config.json` changes ⇒ CHANGELOG bullet under `## Unreleased` (release-notes
  check).
- Extend `mode-smoke-test` style coverage: auto-discover active `bonusRounds`, tick each one
  headlessly through enter→play→exit, assert (a) no throw, (b) **stat/ability invariance**
  (§3.1/3.2), (c) round-pacing counters unchanged (§3.3). The headless harness
  (`.github/scripts/smoke-test.js` + mocked `Date.now`/`setTimeout` clock) covers this.
- Map fairness CI: exempt mini-arenas if/when added (§4.2).

## 7. Effort estimate

- **Framework** (new state + cadence + registry + stash/restore + AI hint hook + XP fold-in +
  client state UI + 1 reference mini-game + headless invariance test): a mid-size feature,
  comparable to the mode-hub or bunker efforts.
- **Each additional mini-game** after the framework: roughly one brutal-mode's worth —
  ~50–150 LOC server controller, client visuals, an AI hint mapping, icon + stinger + Codex
  line. That marginal cost is what makes "dozens" realistic, *provided* the AI-hint interface
  is designed in from game one.

## 8. Suggested v1 roster (all bot-compatible)

1. **King of the Hill** — hold the glowing center tile; most hold-time wins (goal-seek AI).
2. **Crown Chase** — punch the crown-holder to steal it; holder at the buzzer wins
   (chase/punch AI, reuses punch + killWindow plumbing minus stat pollution per §3.2).
3. **Floor Is Lava: Encore** — shrinking safe zone, last standing wins (bunker ring +
   collapse machinery, AI already handles it).
4. **Strike Dodge** — telegraphed orbital-beam-style strikes rain down; survive (reuses
   orbital telegraph art + lava-avoid AI).

---

## Follow-up prompt (operator-injectable)

> Build the Bonus Rounds framework from `docs/spikes/bonus-rounds.md`: add a `bonusRound`
> state between overview and gated (entered from `checkNewRaceTimer` on a `bonusRoundEvery`
> cadence, exiting into `startGated`), a `c.bonusRounds` config registry + per-game controller
> interface in `server/bonusGames/`, ability stash/restore + per-match-stat invariance
> (snapshot or state-gated increments), `player.bonusXpEarned` folded into `awardProgression`
> with a new toast type, a generic AI-hint hook in aiController, client state UI (title card,
> countdown, podium) and one reference mini-game: **King of the Hill**. Include a headless
> test asserting no-throw + stat/ability invariance + brutal-chance/round-counter invariance
> across a bonus round, and a CHANGELOG bullet. No notches, FFA even in teams mode, late
> joiners spectate until the next gate.
