# Progression System Plan — XP, Levels, Achievements, Skin Set

**Branch:** `worktree-progression-system`
**Status:** plan only — implement this.
**Why now:** The auth foundation (PR #175) and cart-skin plumbing (firetruck + dino) are
in. The retention engine is half-built — there's a UI to *pick* the 2 cart skins, but
**no reason to keep playing to earn more.** Adding XP, levels, achievement counters,
level-gated unlocks, and a batch of new skin renderers is what turns one-time visitors
into returning grinders — the retention thesis that the GA data justifies.

**Scope of THIS task:**
1. **XP + leveling** — server-authoritative XP earned at `Game.gameOver`, persisted to
   the Supabase `progression` table, level curve, client display.
2. **Lifetime achievement counters** — increment per-match medal counts (already emitted
   by `gatherAchievements()` in `server/game.js`) into the `medal_counts` jsonb column.
3. **Skin unlock gating** — a skin registry with `unlock: { kind: 'level' | 'achievement' }`,
   server-side validation in `setCartSkin`, lobby UI showing locks + requirements.
4. **First batch of new skin renderers** (8 procedural skins) bringing total from 2 → 10.
   Batches 2 and 3 (rare/epic/legendary + 6 achievement-gated SVGs) are explicit follow-up
   PRs — DO NOT cram all 18 into one PR.

**Out of scope:** ads (separate chunk), paid skins / Stripe (separate chunk), remove-ads
subscription (separate chunk), rewarded "watch to 2× XP" video (lands with ads).

⚠️ **This task DOES touch `server/game.js` and `server/config.json`.** Per CLAUDE.md /
the release-notes-check workflow, **a `## Unreleased` CHANGELOG entry IS REQUIRED** in
the same commit, describing what players notice ("Earn XP every match. Level up to unlock
new skins. Win to earn bonus XP…").

---

## Architecture decisions (decided — do not re-litigate)

- **Server is authoritative** for XP, level, and achievement counts. Computed inside
  `Game.gameOver(player)` at `server/game.js:578`. The client only **reads** progression.
- **All progression writes go through the global Supabase writes gate:** `auth.writesEnabled`
  / the `ALLOW_SUPABASE_WRITES` env var (see `server/auth.js`). **Local dev defaults to OFF**
  (reads work, writes no-op); Heroku/prod must set `true`. **Every new writer added in
  this task MUST gate at the call site.** When testing writes locally, flip ON, exercise,
  **clean up the test rows**, flip back OFF.
- **Schema is already in place.** The `progression` table has `xp int`, `level int`,
  `unlocked_skins text[]`, `medal_counts jsonb`, `wins int`. No migration needed.
- **Skin renderer architecture stays as-is:** procedural canvas painters in
  `client/scripts/draw.js`, one `drawXxxSkin(ctx, anim, paint)` per skin, dispatched
  through `drawCartSkin` (`draw.js:451`) with the existing per-skin lookup at
  `draw.js:2352` (in-game render) and `draw.js:3056` (lobby preview).
- **Server validates skin equip** against the user's `unlocked_skins[]`. The existing
  `setCartSkin` handler at `server/messenger.js:432` adds a level/achievement gate; on
  fail it emits the existing `skinRejected` event the client already handles
  (`client.js:143`, `client.js:1194`).
- **Anonymous (not signed-in) players** see no progression UI and cannot earn XP or
  unlock skins. The existing auth toast already nudges sign-in ("Sign in to save your
  progress and earn skins") — leave it.

---

## Part A — XP & leveling

### A1. Earning XP (server-side)

In `Game.gameOver(player)` at `server/game.js:578`, after the existing
`messenger.messageRoomBySig` emit but before the gameOverTimer starts, compute per-player
XP and persist:

```js
for (const id in this.playerList) {
  const p = this.playerList[id];
  const breakdown = {
    participation: c.xpParticipate,          // e.g. 50
    notches:       c.xpPerNotch * p.notches, // e.g. 15 each
    winBonus:      (id === this.firstPlaceSig)  ? c.xpWinBonus      : 0,  // e.g. 100
    runnerUp:      (id === this.secondPlaceSig) ? c.xpRunnerUpBonus : 0,  // e.g. 40
  };
  breakdown.total = breakdown.participation + breakdown.notches +
                    breakdown.winBonus + breakdown.runnerUp;
  perPlayerXp[id] = breakdown;
}
```

Tune the constants in `server/config.json` (which is why that file is touched — and why
this task needs a CHANGELOG entry):
```
"xpParticipate": 50,
"xpPerNotch": 15,
"xpWinBonus": 100,
"xpRunnerUpBonus": 40
```

### A2. Persistence

Add a new function in `server/auth.js` (which already owns Supabase writes):

```js
async function addProgression(userId, { xpDelta, medalDeltas, win, newlyUnlocked }) {
  if (!writesEnabled || !userId || !supabase) return null;
  // Use a single UPDATE … RETURNING * with jsonb_set + array_cat to avoid races.
  // Return the new row so caller can compute newLevel / newlyUnlockedSkins.
}
```

Gate the call in `game.js` behind `auth.writesEnabled` — if writes are disabled the XP
is still computed and emitted to the client (so the gameOver UI works in dev), but
nothing is persisted.

### A3. Level curve

Pure function (place in `server/auth.js` or a new `server/progression.js`):

```js
// Fast-early, slow-late. xpForLevel(2) ≈ 150; xpForLevel(50) ≈ 25,000.
function xpRequiredForLevel(n) { return Math.round(50 * Math.pow(n, 1.6)); }
function levelForXp(totalXp) {
  let lvl = 1, cumulative = 0;
  while (cumulative + xpRequiredForLevel(lvl + 1) <= totalXp) {
    cumulative += xpRequiredForLevel(++lvl);
  }
  return lvl;
}
```

These constants are hand-tuned for "4-5 unlocks in the first session" — assume ~150-250
XP per match (participation 50 + a few notches + occasional win bonus) and validate by
running through the unlock ladder.

### A4. Emit the breakdown

Extend the existing `startGameover` packet (currently
`{ winner, achievements }` at `server/game.js:581`) with:
```
{ winner, achievements, xpEarned: { <playerId>: breakdown }, levelUps: { <playerId>: newLevel } }
```

Server-emitted, client-rendered. Keep params minimal — no XP fields that could be
spoofed.

### A5. Client display

- **Lobby skin station** (`client/scripts/lobbyHub.js`): show `Lv N` badge + an XP bar to
  the next level for signed-in players.
- **gameOver results** (`drawGameOverScreen` at `client/scripts/draw.js:403`): show
  `+XX XP earned` with the breakdown lines (Participation / Notches / Win bonus); on
  level-up, a `LEVEL UP! → Lv N` burst with the new level number.
- Read progression on connect via the existing `welcome`/`gameState` flow — extend the
  server's initial payload with the player's `{xp, level, unlocked_skins, medal_counts}`
  for signed-in users.

---

## Part B — Achievement counters

### B1. Increment in `gameOver`

The existing `gatherAchievements()` at `server/game.js:583` already computes per-match
medals (`mostKills`, `savior`, `survivalist`, `brutalist`, `bully`, `resourceful`,
`mostMurdered`). For each medal, identify the holder(s) and pass medal deltas into
`addProgression()`:

```js
const medalDeltas = {};
for (const medalName in achievements) {
  for (const id of achievements[medalName].ids || []) {
    medalDeltas[id] ||= {};
    medalDeltas[id][medalName] = (medalDeltas[id][medalName] || 0) + 1;
  }
}
// Pass medalDeltas[id] alongside xpDelta into addProgression for each player.
```

Server stores via `jsonb_set` or computes the new jsonb client-side and writes the whole
column — pick whichever races more cleanly.

### B2. Achievement-skin unlock

A pure function `achievementsUnlocked(medal_counts, wins)` returning the set of
achievement-skin IDs whose threshold the user has crossed:

| Skin id | Threshold |
|---|---|
| `executioner` | `medal_counts.mostKills` ≥ 10 |
| `guardian` | `medal_counts.savior` ≥ 10 |
| `survivor` | `medal_counts.survivalist` ≥ 15 |
| `warlord` | `medal_counts.brutalist` ≥ 10 |
| `golden_champion` | `wins` ≥ 25 |
| `punching_bag` | `medal_counts.mostMurdered` ≥ 10 |

After each progression update, diff against `progression.unlocked_skins` and append the
newly-unlocked IDs. Return them in `addProgression()`'s response so the server can emit a
toast.

### B3. Toast on unlock

In the `startGameover` packet, include `newlyUnlockedSkins: { <playerId>: [<skinId>] }`.
Client (`client.js` `startGameover` handler at line 245) shows
`🏆 Achievement unlocked: <name>!` on the results screen for the local player.

---

## Part C — Skin set (registry + level/achievement gating + new renderers)

### C1. Skin registry

Add `client/scripts/skinRegistry.js` (single source of truth, **registered in `build.js`
AND the play-page `<!-- BUILD -->` block** per CLAUDE.md):

```js
const SKINS = [
  { id: 'firetruck', name: 'Five-Alarm', rarity: 'common',
    unlock: { kind: 'level', level: 1 }, painter: drawFiretruckSkin },
  { id: 'dino', name: 'Dino', rarity: 'common',
    unlock: { kind: 'level', level: 1 }, painter: drawDinoSkin },
  // … Batch 1 additions below
];
```

Mirror the unlock-only data on the server (`server/skinRegistry.js`, or a constant inside
`server/utils.js`) — no painter functions; just `{ id, unlock }` for validation.

`drawCartSkin` (`draw.js:451`) and the in-game / lobby render branches at `draw.js:2352`
and `draw.js:3056` switch from the current `if/else if` chains to a single registry
lookup.

### C2. Server-side unlock validation

In `server/messenger.js setCartSkin` (`messenger.js:432`), before equipping:
- If `skinId` doesn't exist in the registry → `client.emit('skinRejected', { reason: 'unknown' })`.
- If `unlock.kind === 'level'` and the user's `progression.level < unlock.level` →
  `skinRejected` with `{ reason: 'level', required: unlock.level }`.
- If `unlock.kind === 'achievement'` and `progression.unlocked_skins` doesn't contain the
  skin id → `skinRejected` with `{ reason: 'achievement' }`.
- Otherwise → equip and broadcast `playerCartSkinChanged` as today.

Anonymous players: `setCartSkin` accepts only `firetruck`, `dino`, or `null` (the always-
unlocked common set). All other skins reject for guests.

### C3. Lobby skin station UI

In `client/scripts/lobbyHub.js`, the skin shop:
- Iterates the registry, rendering each skin as a thumbnail (use a preview canvas with the
  painter).
- Locked skins render grayscale + a small badge: `🔒 Lv N` (level) or `🔒 X / Y` (achievement
  progress, e.g. `🔒 4 / 10 kills`).
- Clicking a locked skin shows the requirement as a tooltip/inline message — do not allow
  equip.
- Selected skin persists in `localStorage` for instant equip on rejoin; the server still
  validates on equip.

### C4. Batch 1 new renderers (this PR)

**Land 8 new skin painters in this PR. Don't go further.** All procedural canvas painters
matching the existing `drawXxxSkin(ctx, anim, paint)` signature — zero new image assets.
Add each to the registry with the listed `unlock`:

| id | name | unlock | technique (canvas) |
|---|---|---|---|
| `crimson` | Crimson | Lv 2 | flat fill, hand-picked shade |
| `ocean` | Ocean | Lv 3 | vertical linear gradient (deep → light blue) |
| `sunset` | Sunset | Lv 4 | 2-tone diagonal gradient (orange → magenta) |
| `mint` | Mint | Lv 5 | radial gradient (center pale → edge teal) |
| `bumblebee` | Bumblebee | Lv 7 | diagonal stripe pattern (yellow/black) |
| `bubblegum` | Bubblegum | Lv 9 | polka-dot pattern over pink |
| `checkered` | Checkered | Lv 11 | 2-colour checker |
| `grass` | Grass | Lv 13 | tiled texture from `client/assets/img/grass.png` |

Batches 2 (rare/epic procedural + SVG glow effects: `sandstorm`, `glacier`, `magma`,
`neon_pulse`, `prism`) and 3 (6 achievement-gated SVGs: `executioner`, `guardian`,
`survivor`, `warlord`, `golden_champion`, `punching_bag`) are explicit **follow-up PRs**.
DO NOT cram them all into this PR — keep it reviewable.

---

## Constraints

- **`server/game.js` + `server/config.json` are touched → `## Unreleased` CHANGELOG entry
  is REQUIRED in the same commit.** Sample player-facing entry (refine per the existing
  changelog voice):
  > ### General
  > - Every match now earns you XP. Win to bag a fat bonus. Level up to unlock new cart
  >   skins — and earn special skins by stacking up specific medals (Most Kills, Savior,
  >   Survivalist, Brutalist, Most Murdered) or winning enough matches.
- **`ALLOW_SUPABASE_WRITES` gate on every progression write.** Local default OFF. When
  testing writes locally: flip ON, run matches, verify rows in Supabase, **delete the
  test rows**, flip back OFF.
- **No client-side trust** for unlock status. The server checks against
  `progression.unlocked_skins` and `progression.level` before letting `setCartSkin`
  succeed. Don't add ownership claims to the client payload that the server then trusts.
- **Skin renderer additions** in this batch are procedural only — no new image assets.
- **Test headlessly** using the smoke-test pattern in `.github/scripts/smoke-test.js`: run
  a match through `gameOver`, mock the Supabase client (or check XP packet emission with
  writes disabled), assert XP / medal increments / unlocks land as expected. Mock
  `Date.now` + `setTimeout` per the CLAUDE.md testing note.

---

## Verification

1. **Without `ALLOW_SUPABASE_WRITES`:** run a headless match through `gameOver`. Server
   computes XP and emits the breakdown in `startGameover`; no writes happen; gameplay
   is unaffected.
2. **With writes enabled against a dev Supabase project:** run a few simulated matches;
   confirm `progression.xp` / `level` / `wins` / `medal_counts` / `unlocked_skins`
   increment correctly. **Delete the test rows afterwards.** Flip the env back OFF.
3. **In the lobby:** anonymous player sees "Sign in to earn skins" on locked skins; a
   freshly-signed-in player at Lv 1 sees firetruck/dino unlocked + crimson at Lv 2;
   attempting to equip a locked skin via the network triggers `skinRejected` and the
   client UI shows the reason.
4. **On gameOver:** results card shows `+XX XP earned` with breakdown; on level-up,
   `LEVEL UP! → Lv N`; on achievement-skin unlock, `🏆 Achievement unlocked: …`.
5. **Next lobby visit:** the new level + any newly-unlocked skins are reflected (proves
   persistence + reload).

## Done criteria

- [ ] XP constants added to `server/config.json`.
- [ ] XP computed in `Game.gameOver` (`server/game.js`); `startGameover` packet extended.
- [ ] `addProgression()` in `server/auth.js` gated on `writesEnabled`; writes increment
      `xp`/`wins` and merge `medal_counts`.
- [ ] `levelForXp()` / `xpRequiredForLevel()` implemented; level recomputed on every
      delta.
- [ ] Lifetime medal counters increment from `gatherAchievements()` output.
- [ ] `achievementsUnlocked()` thresholds applied; new unlocks appended to
      `progression.unlocked_skins`.
- [ ] `client/scripts/skinRegistry.js` added + registered in `build.js` + the play-page
      BUILD block.
- [ ] `drawCartSkin` dispatches via the registry; both render branches
      (`draw.js:2352`, `draw.js:3056`) updated.
- [ ] Server `setCartSkin` validates against unlock criteria; rejects via `skinRejected`
      with a `reason`.
- [ ] Lobby skin station renders all skins with locks + requirements.
- [ ] **Batch 1 (8 new skins) painters added.** Batches 2-3 explicitly noted as
      follow-ups in the PR description.
- [ ] CHANGELOG `## Unreleased` entry describing the player-facing change.
- [ ] Headless smoke-test for XP/medals/unlocks; manual verification with
      `ALLOW_SUPABASE_WRITES=true` against a dev Supabase, then **test rows cleaned up.**

---

## Follow-on PRs (out of scope here, but spec)

- **Batch 2 (skins 11-15):** sandstorm, glacier (reuse `ice.png`), magma (reuse
  `lava.png`), neon_pulse (SVG glow ring), prism (SVG animated rainbow).
- **Batch 3 (skins 16-20, achievement-gated SVG):** executioner, guardian, survivor,
  warlord, golden_champion, punching_bag.
- **Rewarded 2× XP** (lands with the ads chunk).
- **Paid skins / Stripe** (separate monetization chunk).
