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
