# Ads & Rewarded Video Plan

**Branch:** `worktree-ads-monetization`
**Status:** plan only — implement this.
**Why this is next:** The retention engine (XP, levels, achievement counters, 97-item
cosmetic ladder) is being landed in the cosmetics PRs split off from `backup-cosmetics-wip`.
That work gives players a *reason* to replay; this chunk **converts those replays into
revenue.** Two things ship in this task:

1. **Interstitial ads** at the natural `gameOver` state transition (frequency-capped so
   it isn't every match).
2. **Rewarded video — "Watch to 2× match XP"** — an opt-in button on the gameOver results
   screen that grants a server-validated XP multiplier on completion. This *directly couples
   ads to the progression players want* (the Agar.io pattern, but pointed at *our* loop).

Banners are deliberately **out of scope** — the game uses fullscreen canvas, banner ads
clash with the play surface. Banners on the landing page only would earn rounding errors.

**Out of scope (future chunks):** remove-ads premium subscription, paid skins / Stripe,
portal-SDK ad integration (CrazyGames/Poki — bundled with the distribution chunk).

⚠️ **Honest reality check up front:** at the ~17 DAU baseline the GA audit established,
ads earn pennies today. **This chunk builds the rails so that when distribution lands
real audience, the revenue is already wired up.** Don't expect meaningful revenue until
the distribution playbook ships.

---

## Dependency: cosmetics progression must be in `main` first

The rewarded-video reward (2× match XP) **requires the server-side XP/progression engine
in main** (`server/progression.js` + `auth.addProgression`, currently on
`backup-cosmetics-wip`). The implementing agent should:

- Rebase this branch onto `origin/main` immediately before starting and confirm
  `server/progression.js` and `auth.addProgression` exist with the expected signatures.
- If not yet merged, build only the **interstitial** half (which has no progression
  dependency) and defer the rewarded-video half until the progression engine lands.

---

## Architecture decisions

### Client-side ad module (`client/scripts/ads.js`)

A new file (register in `build.js` AND `client/play.html`'s `<!-- BUILD -->` block per
CLAUDE.md), exposing a small, network-agnostic API:

```js
// All calls are fire-and-forget for the game loop; the callback fires later.
ads.init({ provider, publisherId });   // provider: 'adinplay' | 'gamemonetize' | 'none'
ads.showInterstitial({ placement, onClose });   // onClose ALWAYS fires (even on fail)
ads.showRewarded({ placement, onReward, onSkip, onError });
ads.canShowInterstitial();   // false if frequency cap hit, embedded mode, sub active, etc.
ads.isRewardedAvailable();   // true once an ad has loaded
```

Implementation requirements:
- **Network is pluggable.** Default to a single recommended SDK so the agent has a
  concrete integration path; isolate everything network-specific behind the API above
  so swapping later is a one-file change.
- **No-op gracefully** when `provider === 'none'` (e.g. local dev with no creds) — the
  callbacks fire immediately with `onClose()` / `onSkip()` so gameplay never blocks.
- **Hard timeout** every ad request (e.g. 8 s); on timeout call `onClose`/`onError` and
  proceed.
- **Frequency cap** in `localStorage` — track `last_interstitial_ts` and
  `match_count_since_interstitial`. Default rule: interstitial every 2 finished matches
  AND not more than once per 90 s. Tune the constants in `ads.js`, NOT in
  `server/config.json` (keep this chunk out of the gameplay-mechanic CHANGELOG path).
- **Disabled-for-user hook** — `ads.shouldShow()` consults a single source of truth that
  later flips off when the remove-ads subscription chunk lands. For v1: returns true for
  everyone.

### Recommended network: AdinPlay (with a noted alternative)

After surveying the .io-game ad-network landscape, the default integration should be
**AdinPlay**:
- Genuinely .io-focused (their pitch is exactly this category).
- Onboards small games more readily than AdSense/Poki/CrazyGames-as-network.
- Supports both display interstitials and rewarded video.
- Their SDK loads from a CDN tag and exposes a global; the integration boilerplate is
  small enough to fit in `ads.js`.

**Alternative if AdinPlay rejects at current traffic:** **GameMonetize**. Similar profile,
slightly lower fill but laxer onboarding. The plan's *interface* is identical — only
the inside of `ads.init` changes.

**Honest caveat:** some networks will refuse a site at ~17 DAU. The plan must still ship
working code in that case — that's what `provider: 'none'` is for. The CTA button can
still render; it just no-ops gracefully until a real network is wired.

### Interstitial placement

Hook into the existing `startGameover` socket event handler at `client/scripts/client.js:245`
(where `playerWon` is set and `currentState = config.stateMap.gameOver`):

1. When gameOver fires, after the existing UI updates, call `ads.canShowInterstitial()`.
2. If yes, increment the match counter, set `last_interstitial_ts`, and call
   `ads.showInterstitial({ placement: 'gameover', onClose })` where `onClose` is the
   no-op that lets the existing gameOverTimer countdown proceed visually.
3. **DO NOT block the `gameOver` → `lobby` server transition.** The ad runs *on top of*
   the results screen; when it closes (or fails or times out), gameplay continues
   exactly as it does today.

Important: **fail-open.** If the ad SDK isn't loaded, throws, or returns a network error,
the game flow proceeds unchanged. Gameplay is never gated on an ad.

### Rewarded video — the 2× match XP reward

#### UX
On the gameOver results screen (`drawGameOverScreen` in `client/scripts/draw.js:403`),
for **signed-in players only** (anonymous players have no server-side XP to multiply):
- Show a button: **"📺 Watch ad to 2× your XP this match"**.
- Only render if `ads.isRewardedAvailable()` (an ad has preloaded) AND the player hasn't
  already claimed this match's bonus (server flag).
- On click: call `ads.showRewarded({ placement: 'xp_2x', onReward, onSkip, onError })`.
- `onReward`: emit a `claimXpMultiplier` socket event with `{ matchId, multiplier: 2 }`.
- `onSkip` / `onError`: button stays available for a retry; show a soft toast on error.

#### Server (depends on cosmetics progression engine being in main)

New handler in `server/messenger.js` (next to the other progression events):
```js
client.on('claimXpMultiplier', async function (payload) {
    // 1. Require signed-in (client.userId present).
    // 2. Validate payload.matchId matches the player's most-recently-completed match.
    // 3. Validate the claim hasn't already been used (per-player single-claim flag).
    // 4. Validate within a TTL (e.g. 90 s since gameOver — server stamps gameOver time).
    // 5. Multiplier is fixed (server constant), not from client.
    // 6. Compute bonus = original xpDelta * (multiplier - 1), so a 2× total = +xpDelta extra.
    // 7. Call auth.addProgression({ userId, xpDelta: bonus, ... }) — gated on writesEnabled.
    // 8. Emit 'xpBonus' back to that client with the new totals so the lobby toast
    //    enqueues like a normal progression toast.
});
```

**Per-match state for validation** lives on the `Game`/`Room` object — when `gameOver`
emits, stash `{ playerId → { matchId, xpDelta, gameOverTs, claimed: false } }` for the
duration of the gameOver window. After the lobby state resets, drop it. This avoids a
DB read on every claim attempt.

**Anti-abuse, in order of strength:**
- The basic guards above (single-claim, TTL, server-computed bonus) stop trivial replay.
- If AdinPlay (or whichever network) supports **server-to-server postback** for rewarded
  completion, wire it. The client `onReward` becomes a *signal*; the server only credits
  XP once the postback confirms. This is the gold standard — implement if the chosen
  network supports it within reasonable effort, otherwise punt to a follow-up.

**Multiplier constant** lives in `server/progression.js` (NOT `server/config.json`) to
avoid forcing a CHANGELOG entry for a tunable. `const XP_MULTIPLIER_REWARDED = 2;`.

#### CHANGELOG

The 2× XP feature is player-facing → **add a `## Unreleased` bullet** describing what
players see:
> - Watch a short ad on the results screen to **double the XP you earned that match** —
>   handy when you're close to a level-up. Signed-in players only.

The interstitial alone, no CHANGELOG bullet needed (it's a monetization-surface change,
not a game mechanic — but consider noting it for transparency: *"Free play now shows
the occasional short ad between matches."*).

---

## GA instrumentation

Extend the existing instrumentation (`docs/analytics-instrumentation-plan.md` shipped
via PR #171) with ad events. Add to the same `trackEvent()` wrapper:

| Event | Params | Where |
|---|---|---|
| `ad_shown` | `{ type: 'interstitial' \| 'rewarded', placement }` | `ads.js` on SDK callback |
| `ad_complete` | `{ type, placement }` | on full-watch callback |
| `ad_skipped` | `{ type, placement }` | on skip / close-without-complete |
| `ad_error` | `{ type, placement, reason }` | on SDK error / timeout |
| `reward_claimed` | `{ bonus: 'xp_2x', match_id }` | client emits AFTER server `xpBonus` ack |

After landing, register the new event params (`type`, `placement`, `bonus`) as **custom
event-scoped dimensions** in GA4 (Admin → Custom definitions, per the analytics plan).
If `analytics/ga-config.json` is in main (PR #238 per memory), add entries there so the
GA-config-as-code workflow registers them automatically.

**Funnel to watch in GA Explorations:**
`match_end → ad_shown → ad_complete → reward_claimed` — tells you how many gameOver
opportunities convert to actual ad impressions and onward to reward claims. That's the
revenue-leverage curve.

---

## Embedded mode (portal iframes)

When ChaoChao is embedded in CrazyGames/Poki later (per the distribution playbook), the
portal SDK serves the ads — **double-stacking would be wrong.** Use the `isEmbedded()`
helper (planned in `worktree-distribution-playbook`) to:
- Skip direct-network ads entirely when `isEmbedded()` is true.
- Defer to a portal-SDK-backed implementation of the same `ads.js` API (built when that
  chunk lands; for now, just no-op).

For v1, document the contract in `ads.js` ("when embedded: defer to portal SDK") and
no-op cleanly so gameplay isn't affected if `isEmbedded()` is true.

---

## Consent / GDPR

EU traffic requires a Consent Management Platform (CMP) when ads track users. AdinPlay
bundles its own CMP; load it alongside the SDK and let it handle the banner. **Do not
build a custom CMP** — they're a legal compliance product, not a UI exercise.

For the operator: when registering with the network, accept their CMP terms and any
data-processing agreements. The agent can't do this step.

---

## Constraints

- **Does NOT touch `server/game.js`, `server/engine.js`, or `server/config.json`.**
  All ad-frequency tuning lives in `client/scripts/ads.js` (constants); the XP
  multiplier lives in `server/progression.js`; the server claim handler lives in
  `server/messenger.js`. **However, the 2× XP feature is player-facing → a `## Unreleased`
  CHANGELOG entry is REQUIRED** (the rule fires on visible mechanic changes, not just
  file paths — and this materially changes how XP is earned).
- **`auth.writesEnabled` / `ALLOW_SUPABASE_WRITES`** gates the bonus-XP persistence in
  `auth.addProgression()`. Local default OFF; flip ON in Heroku.
- **Anonymous players** see interstitials but **not** the rewarded button (no progression
  to multiply). Don't hide-then-fail; hide outright when `client.userId == null`.
- **Fail-open everywhere.** Every ad call has a timeout; every callback fires; gameplay
  is never blocked on a network or SDK.
- **No ad SDK on `index.html`/`join.html`/`create.html`.** Only `play.html` needs it.
  Saves bytes for visitors who never start a match.
- **New client script (`ads.js`) → register in `build.js` AND the play-page `<!-- BUILD -->`
  block** per CLAUDE.md.
- Embedded-mode handling: stub for v1, real integration with the distribution chunk.

---

## Operator prerequisites (only the user can do)

1. **Sign up with AdinPlay** at https://www.adinplay.com — request a publisher account.
   Provide site URL (the Heroku domain), describe the game, accept TOS.
2. **Accept the CMP terms** on their dashboard.
3. **Provide the publisher / site ID** via Heroku config var (e.g. `ADS_PUBLISHER_ID`,
   `ADS_PROVIDER=adinplay`). Local dev leaves them unset → `ads.js` no-ops cleanly.
4. **If AdinPlay rejects** at current traffic, repeat with **GameMonetize**
   (https://gamemonetize.com) — same workflow, the agent's code stays unchanged because
   `ads.js` swaps providers via a config string.

⚠️ Realistic outcome: networks may decline a ~17 DAU site. That's OK — the code ships
with `ADS_PROVIDER=none` (no-op), the buttons and hooks all work, and when a network
accepts (post-distribution), you flip the env var and ads light up. This makes the
chunk **traffic-independent to build** but **traffic-dependent to monetize**.

---

## Verification

1. **`ADS_PROVIDER=none` (default local dev):** game runs normally, no ads, no
   rewarded button. Console clean.
2. **`ADS_PROVIDER=adinplay`, valid creds, signed-in player:** finish a match → an
   interstitial appears at gameOver every ~2 matches (cap working). Rewarded button
   appears on results screen, clicking it shows an ad, on completion server credits
   double the original match XP (verified in Supabase: `xp` row jumped by `2×xpDelta`).
3. **Anonymous player, ads provider configured:** sees interstitials, no rewarded
   button.
4. **Ad SDK fails / times out:** gameplay proceeds normally, no UI lock, GA logs
   `ad_error`.
5. **Frequency cap:** finish 5 matches in a row → confirm interstitials fire on roughly
   matches 1, 3, 5 (every-2-match rule).
6. **Anti-abuse:** in dev, try sending `claimXpMultiplier` twice for the same match →
   server rejects the second.
7. **Headless smoke** continues to pass (no gameplay-engine changes).

## Done criteria

- [ ] `client/scripts/ads.js` with the documented network-agnostic API; registered in
      `build.js` + `play.html` BUILD block.
- [ ] Interstitial fires at `gameOver` with frequency cap; fail-open on errors / timeouts.
- [ ] "Watch to 2× XP" button on the gameOver results screen for signed-in players,
      only when a rewarded ad is available.
- [ ] Server `claimXpMultiplier` handler in `server/messenger.js`: signed-in only,
      match-id + TTL validation, single-claim guard, persistence via `auth.addProgression`
      behind `writesEnabled`.
- [ ] GA events fire: `ad_shown`, `ad_complete`, `ad_skipped`, `ad_error`,
      `reward_claimed`. Custom dimensions registered (or added to `analytics/ga-config.json`).
- [ ] `## Unreleased` CHANGELOG bullet describes the 2× XP feature.
- [ ] Embedded-mode (`isEmbedded()`) → no-op gracefully (stub; full handling lands with
      distribution chunk).
- [ ] Tested all five verification scenarios.
- [ ] Operator checklist (sign-up + env-var setup) committed in the PR description.

---

## What this chunk does NOT do (intentionally)

- **Remove-ads subscription.** That's its own chunk — needs Stripe + customer portal +
  the disabled-for-user hook is already stubbed into `ads.shouldShow()`.
- **Paid skins.** Separate Stripe chunk.
- **Portal SDK ad integration.** Bundles with the distribution chunk; this just
  no-ops when embedded.
- **Banner ads.** Deliberately skipped — fullscreen canvas conflicts with banner
  placement, and banner CPMs on a small site are negligible.
- **Other rewarded bonuses.** v1 only ships the 2× XP reward. Future rewarded options
  (extra ability tries, double medal credit, etc.) can plug into the same
  `claimXpMultiplier`-style pattern.

The interface and server contract are deliberately general enough that adding more
rewarded options later is mostly content, not architecture.
