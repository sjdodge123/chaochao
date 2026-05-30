-- Re-mirror dev.progression to match PROD exactly (read via supabase-prod, 2026-05-29).
-- Prod's hand-created table has: selected_skin + created_at columns, column order with
-- wins before medal_counts, an owner-read RLS policy, and DEFAULT anon/authenticated grants
-- left intact (writes gated only by the absence of a write policy). dev had 0 rows so a
-- drop+create is safe and gives an exact ordinal match.
drop table if exists public.progression cascade;

create table public.progression (
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
-- which is what blocks anon/authenticated writes despite the default write grants.
create policy "read own progression" on public.progression
    for select using (auth.uid() = user_id);
