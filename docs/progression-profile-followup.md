# Follow-up: Player profile (level + achievements + skins)

**Status:** spec only — not built. Follow-up to the progression-system PR (XP/levels/
achievement counters/skin unlocks are in; this surfaces them in a dedicated view).

## Why
Today a signed-in player only glimpses progression at two moments: the lobby skin
station (Lv + XP bar) and the game-over XP card. There's no place to see your
**lifetime** picture — current level, total XP, medal counts, which achievement
skins you've earned vs. how close you are. That's the natural "home" for a returning
player and the hook the retention thesis wants.

## Scope (proposed)
A **Profile panel** showing, for the signed-in user:
- Level + XP bar to next level (reuse the server `progressionUpdate` payload:
  `{ xp, level, unlocked_skins, medal_counts, wins, xpThisLevel, xpForNextLevel }`).
- Lifetime stats: total wins, and each medal counter from `medal_counts`
  (`mostKills`, `savior`, `survivalist`, `brutalist`, `mostMurdered`, …).
- Achievement-skin tracker: for each entry in `progression.js ACHIEVEMENT_UNLOCKS`,
  show progress `X / threshold` and a ✓ when earned (e.g. "Executioner — 7 / 10 kills").
- Skin collection grid: every registry skin, locked/unlocked with its requirement
  (the lobby already has `cartSkinUnlock()` + thumbnail rendering to reuse).

## Where it could live
- **Lobby hub:** a new walk-up "Profile" station next to Skins/AI (mirrors the
  existing station pattern in `lobbyHub.js`), OR
- **A persistent HUD button** (gamepad-reachable via `data-gp-nav`) opening an overlay.
- Decide whether it's canvas-drawn (like the skin station) or a DOM overlay.

## Server work
- The data is already computed/persisted. Likely no new write paths. May want a
  read endpoint or to extend the initial `progressionUpdate` with the full
  `medal_counts` (already included) — confirm the achievement-progress numbers are
  all derivable client-side from the existing payload (they are).

## Out of scope
- Public/other-player profiles, leaderboards of level, cosmetic showcases.

---

### Operator-injectable follow-up prompt

> Implement the player Profile view per `docs/progression-profile-followup.md` on a
> new worktree. Surface the signed-in user's level + XP bar, lifetime medal counts
> and wins, achievement-skin progress (X / threshold from `server/progression.js`
> ACHIEVEMENT_UNLOCKS), and a full skin collection grid (locked/unlocked, reusing
> `cartSkinUnlock()` + the lobby thumbnail painters). Decide lobby-station vs HUD-
> overlay placement; tag any new controls with `data-gp-nav`. All data comes from
> the existing `progressionUpdate` payload — no new Supabase writes. Add a headless
> assertion that the payload carries everything the view needs. Don't push/PR
> without asking.
