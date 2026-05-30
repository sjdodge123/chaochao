-- Mirror dev.progression to PROD's shape (read via supabase-prod, 2026-05-29).
-- Prod's hand-created table has: selected_skin + created_at columns, column order with
-- wins before medal_counts, an owner-read RLS policy, and DEFAULT anon/authenticated grants
-- left intact (writes gated only by the absence of a write policy).
--
-- FORWARD-ONLY: this migration must never drop data. It creates the table only if absent and
-- (re)asserts the read policy idempotently. Where the table already exists (prod, and dev
-- after first apply), later migrations add any missing columns via `alter ... add column if
-- not exists`, so the schema converges without a destructive drop+recreate.

create table if not exists public.progression (
    user_id        uuid        not null,
    xp             integer     not null default 0,
    level          integer     not null default 1,
    unlocked_skins text[]      not null default '{}'::text[],
    selected_skin  text,
    wins           integer     not null default 0,
    medal_counts   jsonb       not null default '{}'::jsonb,
    device_ids     text[]      not null default '{}'::text[],
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    constraint progression_pkey primary key (user_id),
    constraint progression_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade
);

alter table public.progression enable row level security;

-- Prod's only policy: authenticated users may read their own row. No write policy exists,
-- which is what blocks anon/authenticated writes despite the default write grants. Drop+create
-- so re-applying is idempotent without erroring on an already-present policy.
drop policy if exists "read own progression" on public.progression;
create policy "read own progression" on public.progression
    for select using (auth.uid() = user_id);
