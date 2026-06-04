# Follow-up prompt: per-graphics-profile render-perf sweep

> Operator: inject this as a fresh prompt once the cosmetic-perf verification round
> (PR #259 follow-up) is merged/PR'd. It reuses the live-measurement methodology
> documented in memory `live-render-perf-harness.md`.

---

Run a per-graphics-profile render-performance sweep of the chaochao client,
using the live in-page harness methodology from memory `live-render-perf-harness.md`
(read it first — it has the full architecture and the sample-poisoning pitfalls).

## Goal

Quantify client FPS for EACH perf profile — `high`, `balanced`, `low`, and `auto`
(report what auto resolves to at common window sizes: <900px wide → balanced gotcha) —
under identical, worst-realistic load, and confirm each profile's visual contract
(High = full glow/ambient FX; Balanced = reduced; Low = direct paints, no glow,
no audience, flat terrain ambient).

## Setup

- Fresh worktree off origin/main (or the cosmetic-perf verify branch if not yet merged).
- `UNLOCK_ALL_COSMETICS=true PORT=<free> node index.js` + the world.js dev
  bot-cosmetics patch (in the old cosmetic-perf-collapse worktree, uncommitted —
  `git -C <old-worktree> diff -- server/entities/world.js | git apply`). NEVER commit it.
- Chrome MCP tab, VISIBLE, window ≥1280 wide. Do not touch other sessions' dev servers.

## Matrix (per profile × scenario, ~2s gated samples, alive==9, ice map, state recorded)

Scenarios, all 9 karts dressed identically via the client-side override:
1. `__none__` baseline (no cosmetics)
2. Worst-cart combo: cart `warlord` + pattern `nebula` + border `border_runes` + trail `comet`
3. Heavy trails: all 9 wearing `comet` (then `aurora`, `founders_flare`)
4. Random-mix (dev-patch cosmetics as-served)

For each profile: pin via `setPerfPref('<tier>'); applyPerfProfile()`, gate every
sample on `perfProfileLabel()` matching the pinned tier, and interleave `__none__`
controls (environmental dips: brutal rounds — blackout/cloudy — drag the baseline;
judge RELATIVE to the nearest control; requeue suspect clusters for a clean round).

## Visual contract checks (screenshot each profile)

- High: trail glow present, ice reflections present, audience present.
- Balanced: reduced FX per PERF_PROFILES knobs (read perf.js for the expected set).
- Low: trails render via the DIRECT no-glow path (still visible, no shadowBlur),
  no ice reflections, no audience, terrain ambient flat. None of these should
  silently disappear entirely (e.g. a trail id that draws NOTHING on Low is a bug).
- Auto: confirm the resolved tier at 1440px and at <900px window widths.

## Run discipline (operator working agreement)

- **Hard time cap: 3 hours wall-clock** for the whole run. When the cap nears,
  stop all monitors/waits, finalize with collected data, report coverage
  honestly (measured vs skipped).
- **Operator messages preempt monitoring**: answer immediately, pause watch
  loops while a question is pending, stop entirely if asked.

## Deliverable

Per-profile × per-scenario FPS table + visual contract screenshots + any fixes
(committed on the worktree branch; never push/PR without operator go-ahead),
smoke+build green, dev server hosted with localhost AND LAN-IP URLs printed,
memory updated (`live-render-perf-harness.md` + a new finding memory if anything
actionable surfaces).
