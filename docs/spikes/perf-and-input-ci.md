# Spike: device-perf + input-compliance CI (P1b de-risk)

**Date:** 2026-05-26 · **Branch:** `worktree-spike-perf-ci`

## Question being de-risked

Can a GitHub-CI-friendly headless browser reach a **sustained, representative
racing state** in the real client and let us **sample per-frame cost** — the one
risky assumption behind the client-side FPS-proxy job (P1b)? The operator asked
the spike to measure the **worst case**: 25 karts, a stacked brutal round, with
abilities/particles active.

## Method (throwaway probe: `spike-perf-probe.js`)

1. **Boot the real server** as a child process on an ephemeral port. Config
   temporarily patched (and restored on exit) to force worst-case load:
   `aiRacers.minGrid=maxGrid=25`, `chanceOfBrutalRound=100`,
   `chanceForAdditionalBrutal=100`, `maxTotalBrutals=4`.
2. **Reach racing with zero manual input** via the editor **preview** path:
   open `create.html`, emit `createPreviewRoom({map, enableAI:true})` over the
   socket, get the `gameID`, then load `play.html?gameid=<id>&preview=1`.
   Preview rooms skip the lobby start-button rally (`checkGatedStart` →
   `isPreview` → straight to `startGated` → `fillGridWithBots`), so they go
   gated → racing on their own. **This is the key unlock** — a normal matchmade
   room sits in `lobby` forever headless, because lobby→gated needs >50% of
   players standing on the lobby start button and idle bots/clients never do.
3. **Sample per-frame work**: an `addInitScript` wraps `requestAnimationFrame`
   and records the synchronous duration of every frame callback (`animloop` =
   update + `draw.js`). Read back, compute p50/p95/p99.
4. **Throttle**: re-run under CDP `Emulation.setCPUThrottlingRate {rate:4}`.
5. Viewport iPad-ish: 1194×834, DPR 2, `hasTouch`, iPad UA.

## Results (12s samples, 25 karts, brutal = explosive+ability+blackout+volcano)

| Run | p50 | p95 | p99 | max | frames | implied FPS @p95 | JS heap |
|---|---|---|---|---|---|---|---|
| Baseline (no throttle) | 140.7 ms | 145.5 ms | 154.4 ms | 154.4 ms | 76 | 6.9 | 202 MB |
| 4× CPU throttle | 581.0 ms | 614.1 ms | 614.1 ms | 614.1 ms | 19 | 1.6 | 202 MB |

- Reached racing headless with **25 karts**, **zero manual input**. ✅
- Per-frame work is **measurable and very stable** (p50→p99 spread only ~10%). ✅
- CPU throttle scales the metric **4.22× for 4× throttle** — near-linear, which
  confirms the measurement is genuine CPU-bound work (not a constant-overhead
  artifact). ✅

## Verdict: **VIABLE** — proceed, with the framing below

The approach works and the signal is reproducible and stable. **But the absolute
numbers must be read correctly:**

### Critical nuance — absolute ms ≠ iPad performance
The baseline ~140 ms/frame is **dominated by headless software canvas
rasterization**. CI runners (and headless Chromium generally) have no GPU, so
2D-canvas drawing is CPU-rasterized — far slower in absolute terms than a real
iPad, whose canvas compositing is GPU-accelerated. DPR 2 makes it worse (the
backing store is ~2388×1668 ≈ 4 MP, trivial for a GPU, expensive in software).

**Implication:** this is a **relative regression gate**, not an absolute-FPS
predictor. A PR that adds JS/draw work shows up as higher ms in the same
environment; the number does **not** tell you the iPad frame rate. To map to
real mobile, do a **one-time calibration** on a real iPad via Safari Web
Inspector → Timelines and anchor a budget — re-calibrate occasionally.

### Implementation refinements (feed into P1b build)
1. **Separate scripting from painting.** Under heavy software raster, a pure
   JS-logic regression (e.g. +2 ms in `update`) can hide under ~130 ms of
   raster. Capture a **CDP trace** and bucket time by category
   (Scripting vs Rendering/Painting) instead of gating on total frame time, so
   JS regressions stay visible regardless of raster cost. Consider DPR 1 for the
   gate to reduce raster dominance.
2. **Gate on the right metric.** Recommend gating on **scripting ms/frame**
   (stable, device-meaningful-ish, regression-sensitive) and tracking total
   frame ms + heap as reported-only context.
3. **Load knobs via a test-only path, not config edits.** The probe patched
   `config.json`; the real CI scenario should force the 25-kart + brutal load
   through a dedicated test hook / query param so it's deterministic and doesn't
   touch shipped config.
4. **Reporting:** emit a `$GITHUB_STEP_SUMMARY` markdown table (p50/p95/p99
   scripting+frame ms, heap, kart count), a sticky PR comment with delta vs
   base, and upload the CDP trace as an artifact for deep dives.
5. Minor: 2 benign `ERR_CONNECTION_REFUSED` console errors (the gtag/analytics
   script offline in CI) — filter from the error gate.

## Reusable techniques discovered
- **Preview-room = deterministic headless route to racing** (no lobby rally,
  no manual input, AI auto-fill via `enableAI`). Reuse for any browser-driven
  gameplay test.
- `window.currentState` / `window.config.stateMap` / `window.playerList` /
  `window.gameRunning` are live globals usable as probe signals.
- rAF-wrapping frame-work sampler + CDP CPU throttle is a clean, dependency-light
  (Playwright-only) measurement primitive.

## Follow-up prompt for implementation session

> Implement the client perf-regression CI job (P1b) on chaochao, building on the
> `worktree-spike-perf-ci` spike (`docs/spikes/perf-and-input-ci.md`). Use the
> proven preview-room route to drive a headless Playwright Chromium into a
> 25-kart forced-brutal race. Instead of gating on total frame time, capture a
> CDP performance trace and gate on **scripting ms/frame** (regression-sensitive
> under software raster), reporting total-frame-ms + JS heap as context. Force
> the load via a test-only hook (not by editing `config.json`). Output a
> `$GITHUB_STEP_SUMMARY` table + sticky PR delta-vs-base comment + uploaded trace
> artifact. Start the job **non-blocking**. Honor the dependency-light CI ethos:
> Playwright is the only new devDep; isolate it so the existing zero-dep jobs are
> unaffected. Pair with the zero-dep server tick-budget check (P1a).
