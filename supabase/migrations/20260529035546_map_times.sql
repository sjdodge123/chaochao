-- Per-user, per-map personal-best race times for the global map leaderboard.
-- Written by the game server (via the service-role key) when a signed-in player
-- crosses the goal in a normal or brutal round and the new time beats their
-- existing PB for that map_id. Bots and anonymous players are NEVER written.
--
-- Schema decisions:
--   * Primary key (user_id, map_id) — one row per user per map = their PB.
--   * best_ms is an int (milliseconds). Bounded < 24h to reject obvious garbage.
--   * display_name is denormalized for cheap rendering; refreshed on each PB
--     upsert. The user_id is the canonical identity; the name is just a label.
--   * Index (map_id, best_ms) supports the global rank query (window rank() by
--     best_ms) used to show a player's rank on each map.

create table if not exists public.map_times (
    user_id      uuid        not null references auth.users(id) on delete cascade,
    map_id       text        not null,
    best_ms      integer     not null check (best_ms > 0 and best_ms < 86400000),
    display_name text,
    updated_at   timestamptz not null default now(),
    primary key (user_id, map_id)
);

create index if not exists map_times_map_best_idx on public.map_times (map_id, best_ms);

alter table public.map_times enable row level security;

-- Reads are public so the overview-screen leaderboard works for guests too.
drop policy if exists "map_times_select_all" on public.map_times;
create policy "map_times_select_all" on public.map_times
    for select using (true);

-- No client write path is allowed — ALL writes go through the game server's
-- service-role key (which bypasses RLS). An owner-write policy would let any
-- authenticated browser PostgREST in with the anon key and spoof their own PB
-- to an impossible value, breaking the global leaderboard.
-- Old releases of this migration created a `map_times_write_own` "for all"
-- owner policy; drop it explicitly so re-running this file cleans up after
-- itself.
drop policy if exists "map_times_write_own" on public.map_times;

-- Belt-and-suspenders: revoke direct table write permissions from the public
-- API roles. RLS already denies in the absence of a policy, but a future
-- accidental policy can't enable writes if the underlying grant is gone.
revoke insert, update, delete on public.map_times from anon, authenticated;
