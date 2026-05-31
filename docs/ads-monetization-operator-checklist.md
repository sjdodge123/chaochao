# Ads Monetization — Operator Checklist & Implementation Status

Companion to `docs/ads-monetization-plan.md`. Records what shipped in this chunk
and what only the operator can do.

## What shipped (interstitial half)

- `client/scripts/ads.js` — network-agnostic ad layer. Interstitial at the
  `gameOver` -> `lobby` edge (between matches, AFTER the results/medals screen — it
  does NOT cover the recap), frequency-capped (every 2 finished matches AND ≤ once /
  90 s, both tunable at the top of `ads.js`). Fail-open: 8 s hard timeout, every
  callback fires, gameplay is never blocked. Embedded mode (`isEmbedded()`) and
  `provider:'none'` both no-op cleanly.
- Server-side config injection: `index.js` `adsConfigTag()` writes
  `window.__ADS__ = { provider, publisherId }` into `play.html` via the
  `<!-- ADS_CONFIG -->` placeholder, from the `ADS_PROVIDER` / `ADS_PUBLISHER_ID`
  env vars. No env vars → `provider:'none'` (no-op).
- `ads.js` registered in `build.js` (play bundle) and the `play.html` BUILD block.
- Interstitial hook in `client.js`'s `startLobby` handler, gated on having just
  come from `gameOver` (`cameFromGameOver`) — i.e. only between matches, after the
  results screen, never over it.
- GA events from `ads.js`: `ad_shown`, `ad_complete`, `ad_error` (with
  `reason: sdk|timeout|error`). (`ad_skipped` / `reward_claimed` belong to the
  rewarded half — see below.)
- CHANGELOG `## Unreleased` transparency bullet (occasional short ad between
  matches).

## DEFERRED: rewarded-video "Watch to 2× XP" half

**Why:** it has a HARD dependency on the cosmetics progression engine
(`server/progression.js` + `auth.addProgression`) being in `main`. As of this
chunk that engine is NOT in `main` (it lives on `worktree-progression-system`).
Per the plan's own fallback (plan §"Dependency"), only the interstitial half is
built. The rewarded API surface exists in `ads.js` but is stubbed
(`isRewardedAvailable()` returns `false`, `showRewarded()` fails open) and NO
"Watch to 2× XP" button is rendered, NO `claimXpMultiplier` server handler is
added, and NO 2× XP CHANGELOG bullet is written.

**To finish the rewarded half once progression lands in main:**
1. Rebase this branch onto `origin/main`; confirm `server/progression.js` exports
   `addProgression` (gated on `auth.writesEnabled`) with the expected signature.
2. Implement `showRewarded()` / `isRewardedAvailable()` against the chosen
   network's rewarded API in `ads.js`.
3. Render the "📺 Watch ad to 2× your XP this match" button in
   `drawGameOverScreen` (`client/scripts/draw.js`) — signed-in players only
   (`window.chaochaoAuth.isSignedIn()`), only when `ads.isRewardedAvailable()`.
4. Add the `claimXpMultiplier` handler in `server/messenger.js` (signed-in only,
   match-id + TTL + single-claim guards, server-fixed multiplier, persistence via
   `auth.addProgression` behind `writesEnabled`); put
   `XP_MULTIPLIER_REWARDED = 2` in `server/progression.js`.
5. Add `ad_skipped` + `reward_claimed` GA events and the `## Unreleased` 2× XP
   CHANGELOG bullet from the plan.

## Chosen network: GameMonetize (decided 2026-05-30)

Operator picked GameMonetize over AdinPlay (laxer onboarding at ~1.1k views/mo).
The `ads.js` GameMonetize adapter is now FULLY WIRED against their official SDK
(`window.SDK_OPTIONS = { gameId, onEvent }` → loader injects
`https://api.gamemonetize.com/sdk.js` → events `SDK_READY` / `SDK_GAME_PAUSE`
(mute) / `SDK_GAME_START` (ad done) → `sdk.showBanner()`). `SDK_GAME_START` is the
completion signal (fires even on no-fill); the 8 s timeout + exactly-once settle
still own fail-open. AdinPlay adapter remains in the file as an alternative.

**Game ID (game hash):** `elvluveq681cl5oop2bd54ls7oza2mxo` → goes in `ADS_PUBLISHER_ID`.

### GameMonetize submission copy (for the dashboard form)

Keep this truthful to what's live; if the distribution chunk's OG/SEO copy drifts,
match that tone.

- **Title:** Chao Chao
- **Category:** Racing (alt: Action / Multiplayer / .io)
- **Tags:** multiplayer, racing, arena, io, party, survival, browser
- **Orientation:** Landscape
- **Resolution:** 1366 × 768 (16:9)
- **Controls:** Keyboard, mouse, touch, and gamepad
- **Plays in browser:** Yes (HTML5, no download)

**Short description (tagline):**
> Free multiplayer arena racing — survive brutal rounds and race to the goal.

**Game description (main body):**
> Chao Chao is a fast, chaotic multiplayer arena racer you can jump into instantly
> in your browser — no signup required. Race across tile-based maps to reach the
> goal first, but every round throws something new at you: lava floors, ice slides,
> bumpers, and "brutal rounds" like infection, lightning storms, blackouts, and
> volcanoes. Grab power-ups — punches, bombs, ice cannons, blindfolds, and
> tile-swaps — to knock rivals off course while the arena collapses around you.
> Last one standing (or first to the goal) wins. Play with friends, climb the
> medals, and build your kart with unlockable skins. Pure party-game chaos in
> quick, replayable matches.

**Instructions / How to play:**
> Use WASD/arrows or the on-screen joystick to move. Reach the goal tile to win the
> round. Pick up abilities and use them to knock opponents into hazards. Avoid lava
> and the collapsing arena. First to the target score wins the match.

## Operator prerequisites (only you can do these)

GameMonetize requires the game to be **uploaded + verified + activated on their
side against a real domain** before ads serve — there is no localhost path. Steps:

1. **In the GameMonetize dashboard** (per their SDK README STEP 3–5): add the game
   pointing at `https://www.chaochaogame.com/play.html` (or upload a ZIP), then
   click **Verify Game** (confirms the SDK snippet is detected on the live page —
   so it must be DEPLOYED first, see below), then **Request Activation**.
   - Verify will only pass once the prod site is serving the SDK, i.e. after the
     PR is merged + deployed with `ADS_PROVIDER=gamemonetize` set.
2. **Set Heroku config vars:**
   - `ADS_PROVIDER=gamemonetize`
   - `ADS_PUBLISHER_ID=elvluveq681cl5oop2bd54ls7oza2mxo`
   Leave unset locally → ads no-op (verified).
3. **Accept GameMonetize's TOS / data terms** in the dashboard (their network
   handles consent; we build no custom CMP).
4. To persist rewarded bonus XP later: `ALLOW_SUPABASE_WRITES=true` on Heroku
   (local default OFF — see the Supabase writes-gate rule).
5. Register the new GA event params (`type`, `placement`, later `bonus`) as
   custom event-scoped dimensions, or add them to `analytics/ga-config.json` for
   the GA-config-as-code workflow.

### Deploy → verify order (important)
GameMonetize's "Verify Game" inspects the LIVE page, so the order is:
1. Merge this PR + deploy to Heroku with the two config vars set.
2. Load `https://www.chaochaogame.com/play.html`, view source → confirm
   `window.__ADS__ = {"provider":"gamemonetize","publisherId":"elvluveq...mxo"}`
   and that `https://api.gamemonetize.com/sdk.js` loads (Network tab).
3. Back in the GameMonetize dashboard → **Verify Game** → **Request Activation**.
4. Once activated, play 3 matches → an interstitial should appear at gameOver on
   matches 1 and 3 (the every-2 cadence; first match pre-seeded eligible) and the
   next match must start normally whether or not an ad showed.

## Verification run (this chunk, no live network needed)

- `ADS_PROVIDER` unset → `window.__ADS__={"provider":"none","publisherId":null}`,
  all ad calls no-op, `canShowInterstitial()` false. ✅
- `ADS_PROVIDER=gamemonetize ADS_PUBLISHER_ID=…` → `window.__ADS__` injected,
  `ads.js` tag present, `<!-- ADS_CONFIG -->` placeholder consumed, loads after
  `auth.js`. ✅
- Freq cap: fires on matches 1, 3 & 5 of 5 (first match pre-seeded eligible); 90 s
  cooldown blocks; counter resets. ✅
- GameMonetize adapter (headless, 23/23): `SDK_READY`→ready, `SDK_GAME_PAUSE`→
  impression (commits cadence + `ad_shown`), `SDK_GAME_START`→complete,
  `SDK_ERROR`/loader-404→no-op, 8 s timeout→`ad_error` reason=timeout, missing
  `window.sdk`→`ad_error` reason=error. ✅
- **No-fill honesty (Codex fix):** a `SDK_GAME_START` with no preceding
  `SDK_GAME_PAUSE` (no ad served), and any pre-start error, emit NO `ad_shown` /
  `ad_complete` and do NOT burn the frequency cap — so empty requests can't inflate
  the GA funnel or suppress the next genuine ad opportunity. Impression bookkeeping
  fires only on a real start. ✅
- Fail-open: SDK timeout (8 s) / throw / 404 all fire `onClose`; gameplay proceeds.
  Genuine errors still log `ad_error` (failure telemetry, never an impression). ✅
- `npm run build`, `npm run test:smoke`, `test:unit`, `test:lint-buttons`,
  `test:button-gate` all pass. ✅
