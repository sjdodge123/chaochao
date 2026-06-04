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
unchanged across the window, 9 karts alive, ice on the map (default rotation maps
mostly carry some ice; ice-only playlist deliberately NOT pinned — see lessons),
pinned tier label in effect; failures auto-requeue (max 8 attempts). Each row records mean FPS **and worst single-frame ms** (stutter
hides in averages — GPU texture re-upload lesson).

## Device results

_(pending on-device run)_

| Tier | Scenario | FPS | Worst ms | Notes |
| ---- | -------- | --- | -------- | ----- |

## Desktop validation (sanity check of the harness itself)

Validated end-to-end on desktop Chrome (Mac, 120Hz rAF cap) against the dev server
before the device run:

- Install gate, hello row, 66-scenario queue build, JSONL streaming: ✔
- Driver autonomously reaches the lobby start button, requests 8 bots, race starts,
  bots spawn in random cosmetics (dev world.js patch): ✔
- Race-gated samples complete with correct gates (state 3→3, alive 9, ice>0,
  pinned-tier label, gl ratio 1.0) at the 120fps display cap, worst ~9ms: ✔
- localStorage resume after reload skips completed labels: ✔
- Requeue/wait on gate failure (lobby/overview between rounds): ✔ after a fix —
  see "lessons" below.

Lessons baked back into the harness during validation:

1. **Don't pin the all-ice playlist.** The AI can't finish ice-heavy maps (the
   ice-nav fix lives in unmerged PR #181) and NOTHING else ends a racing round —
   the sweep stalled forever in round 1. The default (featured) rotation carries
   enough ice for the `ice>0` gate, and bots actually finish those maps. A 90s
   round watchdog was also added: the driver goal-seeks with its own kart to force
   the round over if bots wedge anyway.
2. **Pre-window gate failures must WAIT, not burn retry attempts** — sitting out
   the lobby/overview between rounds is normal. Attempts are only consumed by
   windows that started and then got poisoned (state flip / stall / hidden), plus
   a 180s wait budget per visit.
3. Desktop-only trap (irrelevant on-device, fatal in validation): another agent
   session sharing Chrome steals tab focus; a hidden tab freezes rAF and
   eventually trips the AFK kick via intensive timer throttling. Running the
   harness in its own Chrome window (visibility is per-window occlusion, not app
   focus) fixed it.
4. The lobby floor's ice cells make the drive to the start button SLOW
   (`ice.acel` = 15 vs 300) — patience, not a bug; the wedge-escape handles the
   shoreline pockets.

The full 66-scenario desktop run completed (66 samples, 0 skips, ~25 min,
Chrome/Mac M-series, 120Hz cap): clean stretches read 120 fps across hot spots
(pizza/golden_champion/comet/etc.) on High; Balanced ~89-104; Low ~96-104. A
late-run stretch dipped to 49-77 fps — **including the interleaved `__none__`
baselines (52-67)** — i.e. an environmental dip (the harness window was
backgrounded/partially occluded; macOS Chrome throttles occluded windows), not a
cosmetic regression. Judge ids relative to the nearest baseline, exactly as the
desktop methodology prescribes. Per-id desktop verdicts were already settled in
`docs/spikes/cosmetic-perf-verification.md`; this run validates the harness, the
device run is the new data.

## Follow-ups

_(pending)_
