# Handoff: Supabase dev project + prod schema mirror

**For the next agent session.** Context: setting up a dev Supabase that mirrors prod's
schema, so progression work can be tested with writes ON without touching prod.

## Why this is a handoff (not done in one session)
The session that did the setup was a **background job** — MCP tools bind at job/session
start, so a server added mid-job never loads there. The Supabase MCP is now connected at
**user scope**, so **any FRESH session/job started from this machine will have the
`mcp__supabase__*` tools**. Just start fresh and verify (below).

## Current state (done)
- Supabase MCP server `supabase` is at **USER scope** (`~/.claude.json`), `✓ Connected`
  + authenticated, pointing at the **DEV** project `ukfecygtfghiybasqgtl` with **full
  (write) access** (no `read_only`). This is intentional: dev is throwaway and we need
  DDL/write for the mirror.
- **No `.mcp.json` in either repo root** (worktree or main) — removed so nothing rides
  into the progression PR. No `enabledMcpjsonServers` approval needed at user scope.
- **Decision (operator):** standing config is **dev-only, full access**; **NEVER** wire a
  standing prod connection. If prod must be read, add a temporary `read_only=true`,
  project-scoped prod entry ad-hoc and remove it after.
- Prod writes are OFF: `.env` (worktree root, points at PROD) does NOT set
  `ALLOW_SUPABASE_WRITES`, and the writes-enabled servers (:3271/:3281) were stopped.
  Operator was given flush SQL to clear prod test rows (`delete from public.progression`;
  scoped delete for `map_times` test PBs only — `map_times` is a RELEASED table, do NOT
  truncate it).

## First step in the fresh session — verify tools
```
ToolSearch "+supabase"   → should list mcp__supabase__* (list_tables, execute_sql,
                            apply_migration, list_migrations, …)
mcp__supabase__list_tables({ project_id: "ukfecygtfghiybasqgtl", schemas: ["public"] })
```
If those return, you're good. If not, confirm `claude mcp list` shows `supabase ✓ Connected`.

## Remaining work: mirror prod → dev

### 1. Get prod's authoritative schema (operator is dumping it)
Operator chose to **dump prod themselves** (so no agent touches prod):
`supabase db dump --schema public -f prod_schema.sql`. Reconcile the migrations below
against that dump before applying.

### 2. The repo migration gap
`supabase/migrations/` has `0001_map_times.sql` + `0002_upsert_map_time_if_better.sql`
but **NO migration for the `progression` table** — it was created by hand in prod ("schema
already in place" per the plan). Mirroring it properly means **authoring
`0003_progression.sql`** so progression is finally in version control and dev/prod parity
is reproducible. A code-derived DRAFT is below — reconcile against the prod dump for exact
types/defaults/RLS before trusting it.

### 3. Apply to dev + verify
- Apply `0001`, `0002`, `0003` to the DEV project (via `mcp__supabase__apply_migration`
  or `supabase db push`).
- Verify dev's `public` schema matches the prod dump (tables, columns, types, defaults,
  RLS policies, the `upsert_map_time_if_better` RPC + its grants).
- Do NOT copy DATA — schema only. Real rows are user PII.

## Columns the server code touches (source of truth for the draft)
From `server/auth.js` + `server/leaderboard.js`:
- `progression`: `user_id` (uuid, PK, → auth.users), `device_ids` (text[]), `xp` (int),
  `level` (int), `unlocked_skins` (text[]), `medal_counts` (jsonb), `wins` (int),
  `updated_at` (timestamptz). Writes via service-role upsert `onConflict: 'user_id'`.
- `map_times`: already in `0001` (do not recreate).

## DRAFT 0003_progression.sql (reconcile against prod dump!)
NOTE: defaults/constraints are best-guess from code usage. The prod dump is authoritative —
fix types/defaults/RLS to match it exactly before committing.

```sql
-- Per-user lifetime progression: XP/level, unlocked achievement skins, lifetime medal
-- counts, win count, and the devices the account has signed in from. Written ONLY by the
-- game server via the service-role key (ensureProgressionRow on sign-in; addProgression at
-- match end). Bots + guests are never written. Mirrors the map_times lockdown style (0001):
-- public reads, no client write path, write grants revoked from anon/authenticated.
create table if not exists public.progression (
    user_id        uuid        not null references auth.users(id) on delete cascade,
    xp             integer     not null default 0,
    level          integer     not null default 1,
    unlocked_skins text[]      not null default '{}',
    medal_counts   jsonb       not null default '{}'::jsonb,
    wins           integer     not null default 0,
    device_ids     text[]      not null default '{}',
    updated_at     timestamptz not null default now(),
    primary key (user_id)
);

alter table public.progression enable row level security;

-- Reads public so the client can show a player's level/unlocks. (Confirm against prod —
-- if prod restricts reads to owner, match that instead.)
drop policy if exists "progression_select_all" on public.progression;
create policy "progression_select_all" on public.progression
    for select using (true);

-- No client write path — all writes go through the service-role key (bypasses RLS).
revoke insert, update, delete on public.progression from anon, authenticated;
```

## Guardrails (operator's standing rules)
- **Never write to prod.** Dev only. Prod is dump-only / never a standing MCP connection.
- **Schema, not data.** Don't copy user rows (PII).
- **Writes gate:** any local server test that writes uses `ALLOW_SUPABASE_WRITES=true`
  INLINE at launch (never in `.env`); stop that instance + delete test rows when done.
- The progression feature PR must NOT contain any `.mcp.json` or Supabase credential.
```
