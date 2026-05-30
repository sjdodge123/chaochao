# Database migrations (dev → prod via GitHub)

Schema changes to the production Supabase project are applied **only** by CI, only
from migrations committed under `supabase/migrations/`. Production stays read-only
from every interactive surface — the MCP servers, your laptop, and any agent. The
single thing on earth with DDL/write access to prod is the GitHub Actions runner in
`.github/workflows/db-migrate.yml`, and it acts only on a commit that landed on `main`.

```
agent / laptop ──(MCP, read-only)──► dev + prod        inspect only, never writes schema
you ──► write SQL in supabase/migrations/NNNN_name.sql ──► PR ──► merge to main
                                                                      │
                                                       GitHub Actions (holds prod DB creds)
                                                                      │
                                                              supabase db push ──► PROD
```

This is separate from the `ALLOW_SUPABASE_WRITES` kill-switch, which governs *application
data* writes from the game server. This pipeline governs *schema* migrations. Both keep
the LLM/agent out of the prod-write business.

## One-time operator setup

1. **Create an access token** at https://supabase.com/dashboard/account/tokens
2. **Get the prod DB password** (Project Settings → Database → reset/copy if unknown).
3. **Add three repo secrets** (Settings → Secrets and variables → Actions → New secret):
   - `SUPABASE_ACCESS_TOKEN` — the token from step 1
   - `SUPABASE_DB_PASSWORD` — the prod DB password from step 2
   - `PROD_PROJECT_REF` — `spkwpkpiuzshrfwplzyg`

## One-time history reconciliation (important)

The existing migrations (`0001_map_times`, `0002_upsert_map_time_if_better`) were applied
to dev and prod **via the MCP `apply_migration` tool**, not via the CLI. The CLI tracks
applied migrations in the remote `supabase_migrations.schema_migrations` table by *version*
(the leading number before the first `_`). Before the first CI `db push`, local and remote
history must agree, or `db push` will try to re-apply already-applied SQL.

Run this locally once (CLI: `brew install supabase/tap/supabase` or `npx supabase`):

```bash
export SUPABASE_ACCESS_TOKEN=...        # your token
supabase link --project-ref spkwpkpiuzshrfwplzyg
supabase migration list --linked        # compare Local vs Remote columns
```

- If `0001`/`0002` show as applied on **Remote** but missing **Local** linkage, mark them
  applied so the CLI won't re-run them:
  ```bash
  supabase migration repair --status applied 0001 0002
  ```
- If a migration shows Local-only (not yet on prod), a `supabase db push --dry-run` will
  show the SQL; running `db push` applies it.

Repeat the same `migration list` check against **dev** (`ukfecygtfghiybasqgtl`) so dev and
prod histories stay aligned. Once reconciled, CI handles everything going forward.

## Day-to-day: adding a migration

1. Write the change in dev first (MCP/dashboard) to prototype, then capture it as a file:
   ```bash
   supabase migration new descriptive_name     # creates supabase/migrations/NNNN_descriptive_name.sql
   ```
   (Or hand-author the file. Keep the sequential `NNNN_` prefix consistent with existing files.)
2. Make migrations **idempotent / forward-only** (`create ... if not exists`, `alter table ... add column if not exists`). There is no automatic down-migration; roll back by committing a new corrective migration.
3. Open a PR. The `dry-run` job posts the exact SQL that will hit prod and the local-vs-remote
   diff — review it.
4. Merge to `main`. The `migrate` job applies only the not-yet-applied versions to prod.

## Notes

- Fork PRs do **not** get secrets, so the `dry-run` job is skipped for them (guarded in the
  workflow). Map-submission PRs touch `client/maps/`, not `supabase/migrations/`, so they
  never trigger this workflow.
- The `concurrency` group serializes runs so two migrations never race the same DB.
- To also auto-migrate dev on every push, add a second `migrate`-style job pointed at the dev
  project ref + a `DEV_DB_PASSWORD` secret. Left out by default to keep dev a free-form
  prototyping target.
