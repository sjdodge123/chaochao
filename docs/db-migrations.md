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
to dev and prod **via the MCP `apply_migration` tool**, not via the CLI. The CLI derives a
migration's *version* from the leading numeric token of its filename and compares it against
the remote `supabase_migrations.schema_migrations` table. Verified state (read via MCP, 2026-05-30):

| | dev (`ukfecygtfghiybasqgtl`) | prod (`spkwpkpiuzshrfwplzyg`) |
|---|---|---|
| `schema_migrations` history | 6 rows, versions `20260529035546`…`20260530003653` (`0001_map_times` … `0006_cosmetics_slots`) | **EMPTY** (`[]`) |
| `map_times` table | present | present |
| `progression` table | present, full schema through `0006` | present, **full schema through `0006`** (incl. `pending_toasts`, `selected_cart/pattern/trail`), 2 real rows |

Two consequences, both requiring action before the first CI run:

1. **Recorded versions are 14-digit timestamps, not `0001`.** The committed files were renamed
   from `0001_*`/`0002_*` to `20260529035546_map_times.sql` /
   `20260529035556_upsert_map_time_if_better.sql` so the CLI-derived version matches what dev
   already recorded. **Keep this `<timestamp>_name.sql` convention for all future files** — a
   plain `0001_` name will never match history and the CLI will treat it as unapplied forever.

2. **Prod already HAS the schema but has ZERO migration history.** If CI ran `db push` against
   prod as-is, the CLI would think nothing is applied and try to re-run *every* migration. Prod
   must instead be **back-filled by marking the existing migrations as applied — never pushed:**

   ```bash
   export SUPABASE_ACCESS_TOKEN=...                 # your token
   supabase link --project-ref spkwpkpiuzshrfwplzyg # PROD
   supabase migration list --linked                 # confirm Remote column is empty
   # Mark the two migrations that live on main as applied WITHOUT running them:
   supabase migration repair --status applied 20260529035546 20260529035556
   ```

   Dev needs **no repair** — its history already matches the renamed files.

   ⚠️ Prod also physically has the effects of `0003`–`0006` (progression/cosmetics), but those
   SQL files are not on `main` yet (they live on the progression feature branch). When that
   branch merges and brings those files in, prod must likewise be `migration repair --status
   applied <their versions>` **before** the merge build runs — do NOT let CI `db push` them, or
   it will re-run progression DDL against a prod that already has it (and has 2 live rows).

## Day-to-day: adding a migration

**Create the file FIRST, then apply it — never the other way around.** The `0001`/`0002`
drift this doc untangles happened because schema was applied to the DB *before* a matching
migration file existed. Do not repeat it. In particular, do **not** prototype via the MCP
`apply_migration` tool and then run `supabase migration new`: MCP records its own timestamp
version on the remote, and `migration new` generates a *different* one — leaving a remote-only
migration plus a local file that looks unapplied. That is exactly the mismatch we just repaired.

1. Generate the file first, so the filename's timestamp IS the version of record:
   ```bash
   supabase migration new descriptive_name     # creates supabase/migrations/<timestamp>_descriptive_name.sql
   ```
   (Or hand-author the file, but it MUST use a 14-digit timestamp prefix — `<YYYYMMDDHHMMSS>_name.sql`
   — matching the existing files and the recorded history. A plain `0001_` name will not match.)
2. Write the SQL into that file. Make it **idempotent / forward-only** (`create ... if not exists`,
   `alter table ... add column if not exists`). There is no automatic down-migration; roll back by
   committing a new corrective migration.
3. Apply it to **dev** with the CLI so dev's history records the *same* version the file carries:
   ```bash
   supabase link --project-ref ukfecygtfghiybasqgtl   # DEV
   supabase db push                                    # applies the new file to dev
   ```
   Iterate here as needed. Reserve the MCP/dashboard SQL editor for throwaway exploration that
   does **not** write migration history — once you settle on a change, it must live in a file.
4. Open a PR. The `dry-run` job prints the SQL of the migration files added in the PR plus the
   local-vs-remote diff — review it.
5. Merge to `main`. The `migrate` job applies only the not-yet-applied versions to prod.

## Notes

- Fork PRs do **not** get secrets, so the `dry-run` job is skipped for them (guarded in the
  workflow). Map-submission PRs touch `client/maps/`, not `supabase/migrations/`, so they
  never trigger this workflow.
- The `concurrency` group serializes runs so two migrations never race the same DB.
- To also auto-migrate dev on every push, add a second `migrate`-style job pointed at the dev
  project ref + a `DEV_DB_PASSWORD` secret. Left out by default to keep dev a free-form
  prototyping target.
