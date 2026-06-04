# Cosmetics analytics

Two data sources track cosmetic adoption + popularity.

## 1. GA event: `cosmetics_equipped` (popularity + combos)

Fires **once per match** for the local player at the first `round_start` (cosmetics are
fixed for a match). One event carries all four slots so GA can chart both per-slot
popularity and popular *combinations*.

| Param | Value |
|-------|-------|
| `cart` | equipped cart id, or `none` (plain sphere) |
| `pattern` | equipped pattern id, or `none` |
| `trail` | equipped trail id, or `none` (basic) |
| `border` | equipped border id, or `none` |

Implementation: `client/scripts/client.js` — flag `cosmeticsTrackedThisMatch` (reset in
`startLobby`, fired in the `round_start` handler).

### GA4 registration (apply after rebasing onto main)

`analytics/ga-config.json` lives on `main` (PR #238) — not on this branch yet. After the
rebase, add these so the params show up as queryable custom dimensions and the event is a
key event. Mirror the existing entries' shape; then the `ga-config` CI workflow applies them.

- **Custom dimensions** (event-scoped): `cart`, `pattern`, `trail`, `border`
  (parameterName = the param above, scope = EVENT).
- **Key event**: `cosmetics_equipped` (optional — lets GA surface it as a conversion).

Reporting: in a GA4 Exploration, dimension = `cart` (etc.) → metric = Event count for
per-slot popularity; combine `cart` + `pattern` + `trail` + `border` as rows for combos.
Full per-combo breakdowns are also available in the BigQuery export regardless of dimension
registration (params are always exported).

## 2. Supabase: `progression.unlock_dates` (adoption timing)

jsonb map `{ cosmetic_id: ISO8601 }` — when each cosmetic was **first** unlocked for a
player (level + achievement skins). Written by `auth.addProgression` on the match-end write,
behind `ALLOW_SUPABASE_WRITES`; existing keys are never overwritten. Migration:
`supabase/migrations/20260530123000_progression_unlock_dates.sql` (applied to dev; prod via
the `db-migrate` CI workflow on ship).

Example queries:

```sql
-- Every unlock with its date, one row per (user, cosmetic)
select user_id, key as cosmetic_id, value::timestamptz as unlocked_at
from public.progression, jsonb_each_text(unlock_dates);

-- How many players have unlocked each cosmetic, earliest unlock
select key as cosmetic_id, count(*) as players, min(value::timestamptz) as first_unlock
from public.progression, jsonb_each_text(unlock_dates)
group by key order by players desc;
```

Note: `unlock_dates` records *unlocking*; `cosmetics_equipped` (GA) records *choosing to
race with* — together they show the funnel from unlock → actual use.

## 3. Progression pacing (curve-retune monitoring)

The capped-hook XP curve (`min(1000, 50+22n)`) was tuned assuming ~5-minute matches;
real matches run 10–25 min, so wall-clock pacing ships ~3× slower than the design
target (operator decision 2026-06-04: ship as-is, retune with data after ~1 week).
These events exist to make that retune a measurement, not a guess.

### Events (fired at `progressionToasts` arrival in client.js — signed-in humans only,
### drained-once durable queue so they can't double-fire)

| Event | Params | Fires |
|-------|--------|-------|
| `xp_earned` | `xp` (metric), `level` (metric) | once per match per signed-in player; also for the rewarded 2× bonus |
| `level_up` | `level` (metric) | each level gained (GA4 recommended games event) |
| `cosmetic_unlocked` | `cosmetic_id`, `cosmetic_slot`, `unlock_kind` (skin = level ladder / achievement / seasonal) | each newly earned cosmetic — **key event** |

### The three retune questions → where to look

1. **"How much XP does a real match pay?"** — `xp_earned`: `averageXp` (auto-derived
   from the `xp` custom metric). If the average sits near ~100, the curve's
   matches-per-level table holds; if real play (long matches, win rates) pushes it
   higher, pacing is faster than feared. Data API: dimension `date`, metric
   `averageXp` + `eventCount` on `eventName = xp_earned`.
2. **"Where does the player base sit on the ladder after a week?"** — `level_up`
   with the `level` metric: a histogram of `level` (dimension: `customEvent:level`
   isn't needed — bucket the metric in an Exploration) shows how deep players get.
   Healthy: a steady spread into the teens after week one; a wall at L4–6 means the
   early curve is still too steep for real session lengths.
3. **"How long between unlocks?"** (the actual hook) — two sources:
   - GA approximation: `cosmetic_unlocked` count per active user per week
     (Exploration: user-scoped segment, weekly cohort). Falling toward ≤1/week for
     mid-level players = the cap era is too slow.
   - **Precise source: Supabase `progression.unlock_dates`** (`{cosmetic_id: ISO
     timestamp}` per row). Median gap between consecutive unlocks per player:
     sort each row's values, diff adjacent timestamps, take the median by the
     player's level band. This is the number the retune decision should use.

### Decision levers (pre-agreed, demotion-safe — level is derived from xp on read)

- Median unlock gap (mid-level band) > ~3 play sessions → **(a)** add per-round-raced
  XP (~+12/round) so long matches pay like long matches — preferred; or **(b)**
  cheapen the curve to `min(400, 20+9n)`.
- Both levers only ever make the curve cheaper, so no player can lose a level.

### Sampling caveat (read before trusting the numbers)

Pacing events fire on lobby arrival; for a player who quits at the results screen they
fire on the **next session's** first lobby (durable `pending_toasts` queue) — delayed,
not lost. The one cohort the GA data structurally excludes is **players who never
return at all** — i.e. exactly the players the hook failed for. Survivorship-check any
retune read against Supabase (`progression.xp` totals / `unlock_dates`) before
concluding pacing is healthy.

### Dashboard

GA4 has no dashboards-as-code; the standing setup is one saved Exploration per
question above (build once in GA4 UI → Explorations, names: "XP per match",
"Level distribution", "Unlock cadence"). For on-demand checks the same three
queries run through the Analytics Data API (the agent can run them via the
google-analytics MCP `run_report`).
