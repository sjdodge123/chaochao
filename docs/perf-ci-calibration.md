# Perf & input-compliance CI — what it measures and how to tune it

This repo gates PRs on four checks beyond the smoke test. Two are zero-dependency;
two use Playwright. Here's what each reports, why, and how to calibrate it.

## The jobs

| Job | Blocking? | Deps | What it catches |
|---|---|---|---|
| `perf-tick-budget` | yes | none | A server-side regression that makes one room unable to tick within the 30 Hz interval under a full 25-kart brutal load. |
| `button-lint` | yes | none | A newly added button/link missing an accessible name, a known styling class, or (on menu pages) gamepad-reachability. |
| `button-gate` | yes | Playwright + axe | The same, on the **live DOM** (incl. JS-injected controls): axe control rules, ≥44px touch targets, gamepad-reachability against each page's real nav selector. |
| `client-perf` | **no** (advisory) | Playwright | A render/JS regression: scripting ms/frame growing >15% vs `main` under the 25-kart brutal scenario. |

Run any of them locally:

```
npm run test:perf-tick      # server tick budget
npm run test:lint-buttons   # static button lint
npm run test:button-gate    # runtime button gate (needs: npx playwright install chromium)
npm run test:perf-client    # one client-perf measurement (prints scripting ms/frame)
```

## Why `client-perf` is a *relative* gate, not an iPad FPS test

CI runners have no GPU, so the 2D canvas is **software-rasterized**. In that mode
the raster cost is charged to main-thread scripting, so the headline number —
**scripting ms/frame** — is far higher in absolute terms than on a real device
(the spike measured ~140 ms/frame headless for 25 karts; a real iPad with
GPU-accelerated canvas is a small fraction of that). The absolute value is
therefore **environment-dependent and not an iPad frame time**.

What *is* meaningful is the **delta vs `main`** measured in the same environment:
if a PR pushes scripting ms/frame up, it made the per-frame render/JS work
heavier, and that will hurt real devices too. So the gate compares PR vs the
`main` baseline (stored by `perf-baseline.yml`) and flags a >15% regression. It
is non-blocking to start, so you can watch the real run-to-run CI variance before
deciding to enforce it (tune `PERF_REGRESS_PCT` in `pr-validation.yml`).

## Calibrating to real iPad performance (one-time, ~20 min)

To put an *absolute* mobile number next to the regression signal:

1. Serve the current build and open it on a real iPad in Safari.
2. On a Mac, **Safari → Develop → [your iPad] → [the tab] → Timelines**, record
   while a full race plays out.
3. Read the real **frames-per-second** and **JS/Layout/Paint** timeline for the
   same 25-kart-ish moment. That is your ground-truth iPad frame time for this
   build.
4. Note the ratio between that and the CI scripting ms/frame for the same commit.
   You now have an anchor: "CI scripting X ms/frame ≈ iPad Y fps for this build."
5. Re-anchor occasionally (new device, big rendering change). The regression gate
   keeps working between calibrations; calibration only refreshes the absolute
   mapping.

If you want true cross-device numbers per PR rather than a proxy, wire a device
farm (BrowserStack / Sauce / AWS Device Farm) as a separate **scheduled** job —
it needs a paid account + a secret, so it doesn't belong in the per-PR path.

## Tuning the thresholds

- **`PERF_REGRESS_PCT`** (`client-perf`, default 15) — max allowed scripting
  ms/frame regression vs `main`. Lower once you've seen CI variance settle.
- **`PERF_TICK_BUDGET_MS`** (`perf-tick-budget`, default = one 30 Hz tick,
  33.33 ms) — the server per-room ceiling. There is large headroom today
  (~0.5 ms p95), so this mainly guards against catastrophic regressions.
- **`button-gate` touch target** — `TARGET_PX` (44, project standard) with a hard
  `FLOOR_PX` (24, WCAG 2.5.8 AA). New controls must hit 44px.

## Known pre-existing debt the gates allowlist (consider fixing)

- **`#themeToggle`** (JS-injected navbar button): renders at **34×34** (under the
  44px standard) and is **not gamepad-reachable on the menu pages** (`index`/
  `join`) — it has class `theme-toggle`, which `menuGamepad`'s
  `NAV_SELECTOR` doesn't match. It *is* reachable in-game via the Settings panel.
  Allowlisted in `button-gate.js`; bumping it to 44px and/or giving it `btn`
  would let it pass unaided.
- **`#createNew`** (editor "Create a new map" tile): no styling class (styled by
  id). Allowlisted in `lint-button-input.js`.
