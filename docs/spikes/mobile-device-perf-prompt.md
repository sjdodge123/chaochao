# Follow-up prompt: on-device (iPad / Android) render-perf sweep

> Operator: inject this as a fresh prompt. Feasibility was verified 2026-06-04:
> the live harness (memory `live-render-perf-harness.md`) is pure page JS and
> ports to mobile by self-installing via a URL flag instead of browser-automation
> injection. No adb / Web Inspector / cables needed — the device just opens a URL.

---

Build and run an on-device render-performance sweep of the chaochao client for
real iPad/Android hardware, porting the live harness methodology from memory
`live-render-perf-harness.md` (read it first — sampler design, gating rules,
sample-poisoning pitfalls all carry over).

## Architecture (verified feasible — follow existing repo precedents)

1. **Self-installing harness**: add a dev-only client script (or block) gated by
   `?perfharness=1` in the URL — same opt-in pattern as `?debugtouch=1`
   (client/scripts/input.js:85) and `?fps=1` (perf.js:258). When present, the
   page installs the rAF sampler + cosmetic override + driver (drive to
   lobbyStartButton, jiggle/goal-seek during rounds, wander-escape when wedged
   >1.2s — water pockets WILL wedge a naive straight-line driver) and runs the
   queue autonomously. Also gate on a server env var (e.g. PERF_HARNESS=1
   delivered via the config payload) so this can never activate in prod.
2. **Result reporting**: the page POSTs each completed sample (and a final
   summary) to a dev-only `POST /__perf/report` endpoint — mirror the existing
   `app.post('/feedback', express.json(...))` in index.js:293, gated behind the
   same env var, writing JSONL to a file the agent tails. (Alternative: a
   dev-gated socket message mirroring the TOUCH_DEBUG server-log pattern.)
3. **Agent loop**: agent starts `PERF_HARNESS=1 UNLOCK_ALL_COSMETICS=true
   PORT=<free> node index.js` (+ the world.js bot-cosmetics dev patch from the
   old cosmetic-perf-collapse worktree — never commit it), prints
   `http://<LAN-IP>:<port>/play.html?perfharness=1`, asks the operator to open
   it on the device, then tails the report file and narrates progress. The
   operator's only job: open the URL and keep the screen awake/foregrounded.

## Mobile-specific methodology (differences from the desktop round)

- **Auto tier**: `namedDeviceTier` maps iPad→balanced, Android-phone→low,
  Android-tablet→balanced. Record what Auto resolves to on the device, then run
  the sweep per pinned tier (high/balanced/low) via `setPerfPref`. Gate every
  sample on `perfProfileLabel()` as before.
- **Display cap**: most tablets/phones are 60Hz — healthy baseline ≈60, not 120.
  Some iPads are 120Hz ProMotion; calibrate with `__none__` baselines first and
  report the cap. Flag <45 (≈ the 90-of-120 line scaled), investigate <30.
- **Foreground/awake**: backgrounding or screen-sleep freezes rAF + socket
  heartbeats (this killed two desktop sessions — on mobile it's harsher).
  KEEP-AWAKE IS THE HARNESS'S JOB, not the operator's: the Screen Wake Lock API
  is NOT available over plain http:// LAN (secure-context only), so use the
  NoSleep.js technique — a tiny muted inline looping <video> element started on
  the first touch (gesture-gated; works on iOS Safari + Android Chrome over
  http). Ask the operator to disable auto-lock only as a belt-and-braces
  fallback. Still detect visibility loss / rAF stalls in the harness and
  auto-requeue poisoned samples as before.
- **Scenario matrix — validate the KNOWN hot spots on the device's OPTIMAL
  (Auto-resolved) tier first**, then pinned tiers, then random unknowns:
  1. `__none__` baseline (calibrates the device's display cap + headroom).
  2. The identified hot spots from the desktop rounds — the ids that were
     pre-fix collapse drivers or shadow/filter-heavy: carts pizza,
     golden_champion, wheel_of_fortune, firetruck, compass, coin, dartboard,
     clock; trails comet, founders_flare, bolt, aurora, neon, ripple, guardian;
     border_runes; pattern nebula; plus the worst-combo
     (warlord+nebula+border_runes+comet) and the ice-reflection stressor
     (any cart, ice-heavy map — the scratch+blit path PR #259 added).
     These all passed at desktop-High; the point is confirming the fix holds
     on mobile GPUs at the tier Auto actually picks for the device.
  3. Random unknowns: 3-5 random same-id picks per slot (seeded from the
     full registry, ids not in the hot-spot list) + the random-mix dev-patch
     dressing — catches anything device-specific the desktop round couldn't.
  All on an ice map, 9 karts via `setLobbyAI {enabled:true, count:8}`,
  interleaved `__none__` controls as always.
- **Watch for**: GPU texture re-upload stutter that dt-FPS misses (memory
  `device-perf-profiles-feature`) — also report worst-frame ms (max rAF delta
  per window), not just the mean, since stutter hides in averages.

## Run discipline (operator working agreement)

- **Hard time cap: 3 hours wall-clock** for the whole run (setup + sweep +
  fixes). Track start time; when the cap nears, stop all monitors/waits,
  finalize with whatever data is collected, and report coverage honestly
  (measured vs skipped) rather than running on.
- **Operator messages preempt monitoring**: answer immediately and pause any
  watch loops while a question is pending; resume only after replying (and
  stop entirely if asked). Never let a babysitting loop delay a status answer.

## Deliverable

Per-tier × per-scenario FPS (+ worst-frame ms) table from the real device,
device model + resolved Auto tier noted; any fixes committed on a worktree
branch (never push/PR without operator go-ahead; strip dev patches);
smoke+build green; memory updated (`live-render-perf-harness.md` gains the
on-device variant; new finding memory if anything actionable). The
`?perfharness=1` + `/__perf/report` plumbing may be committed if cleanly
env-gated — call it out in the PR description either way.
