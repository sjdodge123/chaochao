# GA4 config-as-code (repo → prod via GitHub)

Google Analytics **configuration** (custom dimensions, custom metrics, key events) for
the prod property is applied **only** by CI, only from `analytics/ga-config.json`. The GA
property is edited nowhere by hand for these definitions — the single thing with write
access to GA config is the GitHub Actions runner in `.github/workflows/ga-config.yml`, and
it acts only on config that landed on `main`. This is the GA analogue of the Supabase
schema pipeline in [`db-migrations.md`](db-migrations.md).

```
agent / laptop ──(GA MCP, read-only)──► prod property        inspect only, never writes config
you ──► edit analytics/ga-config.json ──► PR ──► merge to main
                                                      │
                                       GitHub Actions (holds the GA service-account key)
                                                      │
                                  node analytics/reconcile-ga.js ──► PROD property
```

This governs GA *config*, not the gameplay events themselves. The `gtag('event', …)` calls
that fire the events live in the client code (`client/scripts/*`). A custom dimension/metric
here only tells GA to **retain and expose** a parameter that those events already send.

## What's managed (and what isn't)

| GA config | Managed here |
|---|---|
| Custom dimensions | ✅ create / patch / archive |
| Custom metrics | ✅ create / patch / archive |
| Key events (conversions) | ✅ create / delete |
| `gtag` event firing | ❌ — client code, already in the repo |
| Saved Comparisons, Explorations, reports | ❌ — not Admin-API-manageable, stay manual |
| Internal-traffic / data filters | ❌ here — partial Admin-API support; left manual for now |

The `count*` / `average*` metric variants you see in the GA reporting API are **auto-derived
by GA** from each base custom metric — do not list them in the config.

## One-time operator setup

1. **Create a GCP service account** (any GCP project) and download its **JSON key**.
   - Enable the **Google Analytics Admin API** on that GCP project.
2. **Grant it access to the GA4 property:** GA Admin → Property Access Management → add the
   service account's email with the **Editor** role (Editor is required to write config;
   Viewer/Analyst cannot). Property: `chaochaogame` (`454757771`).
3. **Add one repo secret** (Settings → Secrets and variables → Actions → New secret):
   - `GA_SERVICE_ACCOUNT_KEY` — paste the entire JSON key file as the value.

Least privilege: scope the key to Editor on this one property only, mirroring the
read-only-prod posture used for Supabase.

## Day-to-day flow

1. Edit `analytics/ga-config.json` (add a dimension/metric, mark a key event, fix a label).
2. Open a PR. The **dry-run** job posts the exact plan (CREATE / PATCH / ARCHIVE / DELETE)
   to the Actions log without touching GA. Fork PRs are skipped (no secret access).
3. Merge to `main`. The **apply** job reconciles the prod property.

The reconcile is idempotent — re-running with no config change is a no-op.

## Safety: pruning is manual-only

CI **never** passes `--prune`, so an apply can only CREATE or PATCH; it will **never**
archive a dimension/metric or delete a key event, even if you remove it from the config
(it logs `keeping un-managed …` instead). Destructive cleanup is a deliberate local action:

```bash
# Editor-grade key, locally:
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/ga-key.json
node analytics/reconcile-ga.js --dry-run --prune   # review what would be removed
node analytics/reconcile-ga.js --prune             # actually archive/delete
```

Note GA caps standard properties at **50 custom dimensions / 50 custom metrics**, and
**archiving a definition does not always free its slot immediately** — prune with care.

## Local dry-run (optional)

You don't need CI to preview. With an Editor key on the property:

```bash
npm install --no-save @google-analytics/admin@^9.1.0
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/ga-key.json
node analytics/reconcile-ga.js --dry-run
```

## Event catalog (what the client fires)

Quick index of every `trackEvent()` call and where it lives. Params marked † are
registered custom dimensions/metrics in `ga-config.json`.

| Event | Fired when | Params | Where |
|---|---|---|---|
| `cta_click` | Landing CTA clicked | `target`† | index.html |
| `tip_click` | Landing tip carousel clicked | `idx` | index.html |
| `bot_trap` | Invisible honeypot decoy clicked | `trap_source`† | index/play.html |
| `verified_human` | Server confirmed real kart input (once/session) | — | client.js |
| `lobby_entered` | Player reaches a lobby | — | client.js |
| `first_match` | Player's first-ever race (lifetime, localStorage) | `time_to_first_match`† | metrics.js → client.js |
| `round_start` | Each round's gate release | `players`† `bots`† `map`† `playlist`† | client.js |
| `round_complete` | Round's overview screen | `map`† `playlist`† `round_number`† `duration_seconds`† | client.js |
| `match_end` | Match over (key event) | `won`† `map`† `playlist`† `players`† `bots`† `duration_seconds`† | client.js |
| `match_abandon` | Page closed mid-match (pagehide) | `state`† `round_number`† `map`† `playlist`† | metrics.js |
| `cosmetics_equipped` | Once per match, local player's loadout | `cart` `pattern` `trail` `border` | client.js |
| `level_up` | Progression level reached | `level`† | client.js |
| `cosmetic_unlocked` | Cosmetic earned (key event) | `cosmetic_id`† `cosmetic_slot`† `unlock_kind`† | client.js |
| `xp_earned` | Per-match XP credited (incl. 2× bonus) | `xp`† `level`† | client.js — see docs/cosmetics-analytics.md |
| `login` | Fresh OAuth sign-in completed (key event) | `method`† | auth.js |
| `login_nudge_shown` / `login_nudge_clicked` | Post-match sign-in nudge funnel | — | auth.js |
| `reward_offered` | 2× XP toast became visible (funnel denominator) | `bonus`† | client.js |
| `reward_claimed` | Server credited the 2× XP bonus | `bonus`† `match_id` | client.js |
| `ad_shown` / `ad_complete` / `ad_skipped` / `ad_error` / `ad_blocked` | Ad lifecycle | `type`† `placement`† | ads.js |
| `disconnect` | Socket dropped (once/session) | `reason`† | client.js |
| `connect_error` | Could not reach the server (once/session) | `reason`† | client.js |
| `server_kick` | Kicked by the server (AFK etc.) | — | client.js |
| `map_submitted` | Editor map submitted as a PR | — | create.js |

User-scoped properties (set via `gtag('set','user_properties',…)` in
`client/scripts/metrics.js`, refreshed on auth change / progression update /
gamepad connect): `auth_state`, `player_level`, `input_method`, `perf_profile`,
`embed_host`.

## Operator checklist — console-only settings (NOT manageable by this pipeline)

These two are one-time clicks in the GA web console; neither is retroactive, so the
clock on their data starts only when they're enabled:

1. **Event data retention → 14 months.** GA4's default is **2 months**, after which
   event-level data ages out of Explorations. Admin → Data settings → Data retention →
   Event data retention: `14 months` (also toggle "Reset user data on new activity" on).
2. **BigQuery export (free tier).** Admin → Product links → BigQuery links → Link.
   Daily export is free and is the only way to keep raw events past GA4's 14-month cap
   (cohort/LTV analysis across launches, e.g. comparing portal launch cohorts). Pick the
   same region as the GCP project hosting the service account; daily export only (streaming
   costs money and isn't needed).
