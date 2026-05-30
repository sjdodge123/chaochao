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
