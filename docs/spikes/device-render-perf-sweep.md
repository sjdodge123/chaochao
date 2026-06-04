# On-device render-performance sweep (real iPad / Android hardware)

**Status:** COMPLETE — iPad run 66/66 and Android-phone run 66/66, both 0 skips.
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

## Device results — iPad (iPadOS 26.5, Chrome/WebKit, 8 cores, dpr 2, 1180×688)

Display cap (rAF ceiling): **60 fps** (cap_probe). Healthy = 60; flag <45.
Auto tier resolved: **balanced** (matches `namedDeviceTier`). 66/66 scenarios, 0 skips,
gl ratio 1.0 throughout (no duplicate render chain on the device).

### Balanced — the tier iPads actually ship with (Auto): ALL CLEAR

All 8 hot-spot carts, all 7 hot-spot trails (comet, founders_flare, bolt, aurora,
neon, ripple, guardian), nebula, border_runes, the worst-combo
(warlord+nebula+border_runes+comet), random_mix, and all 18 random unknowns +
2 random combos read **60 fps at the display cap, worst frame 17-22ms** (17ms =
no dropped frames at 60Hz). Three soft rows, all explained by ambient hitches —
an interleaved `__none__` baseline itself read 56 fps / 86ms worst, so these are
round-transition/GC/texture hitches, not cosmetics:

| Scenario (balanced) | FPS | Worst ms | Verdict |
| --- | --- | --- | --- |
| border:border_runes | 54.9 | 130 | ambient hitch (same border reads 60/17 on High; combo carrying it reads 59/21) |
| rnd|cart:eight_ball | 58.2 | 77 | ambient hitch (baseline #8 hitched 86ms with cosmetics OFF) |
| __none__#8 (baseline) | 56.0 | 86 | the ambient hitch itself |

### Low: ALL CLEAR — every subset row at 60 fps / 17ms worst.

### High (manual override only on an iPad): heavy trails degrade

| Scenario (high) | FPS | Worst ms |
| --- | --- | --- |
| __none__ baseline | 60 | 17 |
| cart:pizza / cart:golden_champion | 60 | 17 |
| pattern:nebula / border:border_runes | 60 | 17 |
| **trailFx:comet** | **37.9** | 30 |
| **trailFx:founders_flare** | **24.4** | 44 |
| **trailFx:aurora** | **37.4** | **96** |
| **combo:worst** (carries comet) | **42.1** | 26 |

Reproducible and baseline-anchored (60-fps baseline in the same round). The delta
vs Balanced is the High knob set: full particle volume (particleCount 1.0 vs 0.6),
no effect cap (100000 vs 280), shorter spawn cooldowns — per-particle glow blits at
full volume overwhelm the mobile GPU. **Not a ship blocker**: Auto never puts a
tablet on High; a player must force it manually. Verdict: the PR #259 fixes hold on
real mobile hardware at every tier the device can Auto-resolve to.

### Run notes

- The NoSleep-style muted looping video does NOT prevent screen sleep on
  iPadOS 26 (Chrome or Safari — both WebKit). The device slept mid-run; gates
  caught it, rows resumed cleanly after wake. **Operator must set
  Settings → Display & Brightness → Auto-Lock → Never for the run.** The video
  + visibility gates remain useful (re-arm on tap, poisoned-window requeue).
- Mid-run resume worked in production conditions: 16 banked rows survived the
  sleep, the remaining 50 completed after wake with no duplicates or skips.

## Device results — Android phone (Android 10+, Chrome 148 Mobile, 8 cores, dpr 2.625, 412×915)

Display cap: **60 fps** (probe 58.8). Auto tier resolved: **low** (as `namedDeviceTier`
predicts for Android phones). 66/66 scenarios, 0 skips, gl 1.0 throughout. Early-run
page reloads (Android pull-to-refresh) were absorbed by localStorage resume — 4 hellos,
zero lost rows. Android Chrome's keep-awake video DID hold the screen (no sleep, unlike
iPadOS).

### Low — the tier phones actually ship with (Auto): ALL CLEAR

All hot spots, worst-combo, random_mix, and random unknowns ≥54 fps, almost all at the
60 cap with 17ms worsts. The two sub-58 rows carry ambient-hitch signatures (a
`__none__` baseline itself read 55.8 with a 233ms one-off spike during the early reload
churn; wheel_of_fortune 54.3/100ms in the same stretch).

### Balanced — what ANDROID TABLETS Auto-resolve to: two glow-heavy trails collapse

| Scenario (balanced) | FPS | Worst ms |
| --- | --- | --- |
| __none__ baseline / carts / border_runes | 60.1 | 17 |
| pattern:nebula | 57.7 | 33 |
| trailFx:comet | 60.1 | 17 |
| **trailFx:founders_flare** | **26.6** | 50 |
| **trailFx:aurora** | **27.2** | 50 |
| combo:worst | 45.5 | 33 |

Baseline-anchored (60.1 same phase). Balanced keeps `glow: true` at 0.6× particle
volume — founders_flare/aurora's glow passes still overwhelm a phone-class GPU. This is
the strongest finding of the device round: **an Android tablet (Auto→balanced) with
multiple founders_flare/aurora wearers could see ~27 fps.** Mitigation context: 9
same-trail wearers is the synthetic stress case; typical rooms have 1-2.

### High (manual override only): combo collapse, trails individually OK

Unlike the iPad (individual trails 24-42 on High), this phone runs each heavy trail at
57-60 on High but **combo:worst collapses to 22.8 fps** — cumulative 4-layer cost, not
any single effect. One more suggestive row: golden_champion 38.1 on the heaviest-ice
round (89 sites) while a Low-tier row in the SAME round read 60.1 — plausibly the
statue-skin × ice-reflection repaint interaction at High's full budget; single reading,
not chased.

## Cross-device picture

- **Every tier Auto can actually pick is clean**: iPad→Balanced ✔, Android
  phone→Low ✔ (and iPad Balanced runs even the heavy trails at cap — tablet iPad GPU
  ≫ phone GPU at the same tier).
- The trail-glow budget is the consistent offender once you step one tier above a
  device's Auto resolution: founders_flare + aurora are the worst, comet next.
- Worst-frame stutter (>50ms) only ever accompanied the low-FPS rows or one-off
  ambient hitches — no silent texture-upload stutter at healthy FPS readings.

## Follow-up prompt (operator-injectable)

> Glow-heavy trails (founders_flare, aurora — comet next) overwhelm mobile GPUs one
> tier above the device's Auto resolution. Measured at 9 same-trail wearers:
> Android phone on Balanced 26.6/27.2 fps (Balanced is what ANDROID TABLETS
> Auto-resolve to — the real exposure); iPad on High 24-42 fps; phone on High
> combo 22.8 fps. Every Auto-picked tier is clean on both devices. Recommended
> shape of a fix: gate the trail glow pass (`perfGlow()`-style) or scale the trail
> particle budget by device class (touch → Low's trail knobs) even when the
> player pins a higher tier — or demote just founders_flare/aurora's glow on
> touch devices. Verify on-device with
> `PERF_HARNESS=1 UNLOCK_ALL_COSMETICS=true PORT=<free> node index.js` +
> `http://<LAN-IP>:<port>/play.html?perfharness=1` — the phase-2 tier subsets
> cover exactly these ids; compare against the committed tables in this doc.

## Raw data

Full JSONL row sets archived in the session job dir during the run
(`desktop-sweep.jsonl`, `ipad-sweep.jsonl`); regenerate any time by re-running the
harness — rows stream to `perf-harness-report.jsonl`.

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

