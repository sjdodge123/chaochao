# On-device render-performance sweep (real iPad / Android hardware)

**Status:** in progress — harness built + desktop-validated; awaiting on-device run.
**Date:** 2026-06-04
**Branch:** `worktree-perf-device-sweep`

Port of the desktop live render-perf harness (see `docs/spikes/cosmetic-perf-verification.md`
for the desktop round this follows up) to a self-installing, on-device variant: the page
itself runs the sampler/driver/reporting autonomously so a real tablet/phone can be swept
by just opening a URL.

## How to run

```bash
npm install
PERF_HARNESS=1 UNLOCK_ALL_COSMETICS=true PORT=<free> node index.js
# (optional, dev-only, never commit: the world.js bot-cosmetics patch so the
#  random_mix scenario dresses bots in random cosmetics)
```

Then open `http://<LAN-IP>:<port>/play.html?perfharness=1` on the device, tap once
(arms the keep-awake video), and keep the page foregrounded. Rows stream to
`perf-harness-report.jsonl` (override path with `PERF_HARNESS_LOG`).

Activation requires BOTH the `?perfharness=1` URL param AND `config.perfHarness === true`
(only set when the server booted with `PERF_HARNESS=1`), so the committed plumbing is
inert in prod.

## Scenario matrix

1. `cap_probe` — display-cap calibration (visible-only gate, runs in lobby).
2. Optimal (Auto-resolved) tier: `__none__` baselines + the desktop-round hot spots
   (carts pizza, golden_champion, wheel_of_fortune, firetruck, compass, coin, dartboard,
   clock; trails comet, founders_flare, bolt, aurora, neon, ripple, guardian;
   border_runes; nebula) + worst-combo (warlord+nebula+border_runes+comet) + random_mix.
3. Pinned non-optimal tiers (high/balanced/low): baseline + confirmation subset + combo.
4. Random unknowns (seeded, 4 per slot + 2 combos) on the optimal tier.

All race-gated samples require: tab visible, state ∈ {gated, racing, collapsing} and
unchanged across the window, 9 karts alive, ice on the map (`setLobbyPlaylist 'ice'`
pins the Slip & Slide playlist), pinned tier label in effect; failures auto-requeue
(max 8 attempts). Each row records mean FPS **and worst single-frame ms** (stutter
hides in averages — GPU texture re-upload lesson).

## Device results

_(pending on-device run)_

| Tier | Scenario | FPS | Worst ms | Notes |
| ---- | -------- | --- | -------- | ----- |

## Desktop validation (sanity check of the harness itself)

_(filled in below during the build session)_

## Follow-ups

_(pending)_
