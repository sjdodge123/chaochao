-- Per-user lifetime progression: XP/level, unlocked + selected skin, lifetime medal
-- counts, win count, and the devices the account has signed in from.
--
-- *** This file mirrors the PROD table exactly. *** prod.progression was created by hand
-- (never version-controlled); on 2026-05-29 it was read back via the read-only prod MCP
-- and this migration was reconciled to match it column-for-column, including the RLS
-- policy and grant posture. Verified identical against prod and applied to the dev project
-- (ukfecygtfghiybasqgtl).
--
-- Writers (via the service-role key, which bypasses RLS — see server/auth.js):
--   * ensureProgressionRow() on sign-in — upserts the row, dedup-appends deviceId.
--   * addProgression() at match end — bumps xp/level/wins, merges medal_counts, appends
--     newly-earned achievement skins to unlocked_skins.
-- Reads: the server reads via the service-role key and relays over the socket. Authenticated
-- clients may ALSO read their own row directly (the "read own progression" policy below).
--
-- NOTE — two columns prod carries that the current progression-system server code does not
-- yet read or write: `selected_skin` (cosmetic: the skin the player has equipped) and
-- `created_at`. They are included here for exact prod parity; wire the code to them if/when
-- the selected-skin feature lands.
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

-- Prod's ONLY policy: an authenticated user may read their own row. There is deliberately
-- no INSERT/UPDATE/DELETE policy — that absence (not a grant revoke) is what blocks client
-- writes. Server writes go through the service-role key, which bypasses RLS.
drop policy if exists "read own progression" on public.progression;
create policy "read own progression" on public.progression
    for select using (auth.uid() = user_id);

-- Belt-and-suspenders (mirrors map_times in 0001): revoke the default anon/authenticated
-- write grants so client writes can't happen even if a permissive write policy is ever added
-- by accident. All real writes go through the service-role key, which bypasses RLS and keeps
-- its own grants. NOTE: prod's hand-created table originally left these grants intact (writes
-- blocked only by the absence of a write policy); this revoke hardens prod to match — run the
-- same statement on prod.
revoke insert, update, delete on public.progression from anon, authenticated;
