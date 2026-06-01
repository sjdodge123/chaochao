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

## What shipped (rewarded-video "Watch to 2× XP" half)

The progression engine (`server/progression.js` + `auth.addProgression`, gated on
`auth.writesEnabled`) is now in `main`, so the rewarded half is built:

- `ads.js`: real `showRewarded({ placement, onReward, onSkip, onError })` +
  `isRewardedAvailable()`. Same fail-open discipline as the interstitial half —
  single settle authority, 8 s request timeout, exactly-once. `onReward` fires
  ONLY on a CONFIRMED full watch (an ad actually started AND completed); a no-fill
  or close-before-complete is `onSkip`; an SDK throw / timeout is `onError`. No
  reward is credited on a mere attempt or a no-fill.
  - **GameMonetize reality:** their HTML5 SDK exposes only `showBanner()` and the
    `SDK_GAME_PAUSE`/`SDK_GAME_START` events — there is NO dedicated rewarded unit,
    no "reward granted" event, and **no server-to-server completion postback**
    (verified against their SDK source). So a rewarded ad reuses `showBanner()` and
    a `PAUSE → START` (confirmed play) is the reward signal. The gold-standard S2S
    postback is a documented **follow-up** if GameMonetize later exposes one; until
    then the server's single-claim + TTL + server-fixed multiplier are the
    anti-abuse guardrails.
- Client UI: a canvas "📺 Watch ad to 2× your XP" button on the results screen
  (`drawRewardButton` in `draw.js`), pinned above the rating widget. Rendered ONLY
  for signed-in players (`window.chaochaoAuth.isSignedIn()`), only when
  `ads.isRewardedAvailable()` AND the match's bonus hasn't been claimed. Anonymous
  players never see it (hidden outright). Click/tap hit-tested in `input.js`;
  gamepad-reachable on the results screen (D-pad ▲▼ toggles reward ↔ stars, Ⓐ
  confirms — `pollGameOverPad` in `gamepad.js`). It's a canvas control (no DOM
  element), so it sits outside the DOM button-compliance gates like the rating widget.
- Server: `claimXpMultiplier` handler in `server/messenger.js` — signed-in only,
  validates `matchId` == the room's most-recently-completed match, single-claim
  flag, 90 s TTL (server-stamped `gameOverTs`), bonus computed server-side
  (`originalXpDelta × (multiplier − 1)`, multiplier never from the client),
  persisted via `auth.addProgression({ xpDelta, suppressToasts:true })` behind
  `writesEnabled`, then emits `xpBonus` back. Per-match `{ userId → { xpDelta,
  claimed } }` is stashed on the Room object when `startGameover` is emitted
  (intercepted in `messenger.messageRoomBySig`, so **no `game.js` edit**) — avoids a
  DB read per claim.
- `XP_MULTIPLIER_REWARDED = 2` lives in `server/progression.js` (NOT `config.json`).
- GA events: `ad_shown` / `ad_complete` / `ad_skipped` / `ad_error`
  `{ type:'rewarded', placement:'xp_2x' }` from `ads.js`; `reward_claimed`
  `{ bonus:'xp_2x', match_id }` from the client after the server `xpBonus` ack.
  `type` / `placement` / `bonus` added to `analytics/ga-config.json`.
- CHANGELOG `## Unreleased` 2× XP player-facing bullet.

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
4. The rewarded 2× bonus persists through the **same Supabase writes gate as all
   progression** (`auth.writesEnabled`) — no new env var. With writes off the button +
   ad + claim + `xpBonus` ack/toast all still work; only the DB persist no-ops. Sign-in
   must be working too (anonymous players never see the button — there's no XP to
   multiply).
5. The new GA event params (`type`, `placement`, `bonus`) are already in
   `analytics/ga-config.json`, so the GA-config-as-code workflow registers them as
   custom event-scoped dimensions on deploy — no manual GA Admin step needed.

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
- GameMonetize adapter (headless, 33/33): `SDK_READY`→ready, `SDK_GAME_PAUSE`→
  impression (commits cadence + `ad_shown`), `SDK_GAME_START`→complete,
  `SDK_ERROR`/loader-404→no-op, 8 s request-timeout→`ad_error` reason=timeout,
  missing `window.sdk`→`ad_error` reason=error. ✅
- **No-fill honesty (Codex fix):** a `SDK_GAME_START` with no preceding
  `SDK_GAME_PAUSE` (no ad served), and any pre-start error, emit NO `ad_shown` /
  `ad_complete` and do NOT burn the frequency cap — so empty requests can't inflate
  the GA funnel or suppress the next genuine ad opportunity. Impression bookkeeping
  fires only on a real start. ✅
- **Ad actually fires in the normal loop (Codex P1 fix):** the between-matches
  trigger keys off an explicit `adPendingMatchEnd` flag set in `startGameover`, NOT
  a `currentState` compare — because the server emits `startWaiting` between
  `startGameover` and `startLobby`, a state-compare was always false and no ad ever
  showed. ✅
- **Long ads aren't cut off (Codex P2 fix):** the 8 s watchdog guards only the
  *request* (waiting for an ad to begin); `onStart` clears it, so an interstitial
  longer than 8 s runs to completion with no bogus `ad_error` and no premature
  `onClose`. ✅
- **Ad can't cover the next race (Codex P2 fix):** `startGated` / `startRace` call
  `ads.dismissInterstitial()`, which tears down any in-flight ad (best-effort), then
  settles it as `cancelled` — no `ad_complete`/`ad_error` telemetry, just `onClose`.
  KNOWN LIMITATION: the GameMonetize preroll SDK has no documented programmatic
  close, so a GM ad already on screen is dropped from our side (callbacks cleared)
  but may finish its own visual lifecycle; AdinPlay's `destroy()` is called when
  present. ✅
- Fail-open: request timeout (8 s) / throw / 404 all fire `onClose`; gameplay
  proceeds. Genuine errors still log `ad_error` (failure telemetry, never an
  impression); deliberate dismiss logs nothing. ✅
### Rewarded "2× XP" verification (headless + manual)

- Headless `test:ads` (`.github/scripts/ads-rewarded-test.js`) drives a REAL match
  end-to-end and asserts: (a) the server-recomputed per-user match XP stash equals
  the engine's own award (no drift in the duplicated breakdown); (b) a signed-in
  claim credits exactly `+xpDelta` (2× total) via a fake `addProgression`; (c) a
  second claim for the same match is rejected (single-claim); (d) a wrong/empty
  `matchId` is rejected; (e) an expired claim (>90 s) is rejected; (f) an anonymous
  (no `userId`) claim is rejected. ✅
- Manual signed-in 2× credit (writes enabled, DEV Supabase): sign in, finish a match,
  click "Watch ad to 2× your XP", confirm the `xp` row in Supabase jumped by
  `2× xpDelta` (i.e. `+xpDelta` on top of the match award), then DELETE the test row
  delta. (Persistence rides the existing progression writes gate — `auth.writesEnabled`.)
- Manual anonymous: not signed in → the reward button never renders; a forged
  `claimXpMultiplier` from a guest socket is rejected server-side.
- `npm run build`, `npm run test:smoke`, `test:unit`, `test:ads`,
  `test:lint-buttons`, `test:button-gate` all pass. ✅
