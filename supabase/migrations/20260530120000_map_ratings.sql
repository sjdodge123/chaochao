-- Player star ratings for maps (1-5), powering the "Crowd Favorites" playlist
-- and the per-map rating shown in the editor. Written by the game server (via the
-- service-role key) when a player rates the map they just finished on the
-- game-over screen. Bots never write (they aren't sockets); humans — signed-in or
-- guest — may each cast one vote per map.
--
-- Schema decisions:
--   * voter_id is TEXT, namespaced so authed and guest voters can't collide:
--       'u:<auth.users uuid>'  for signed-in players (weighted higher at read time)
--       'd:<client deviceId>'  for guests (the stable localStorage id)
--     We deliberately do NOT FK to auth.users — guests have no row there, and the
--     prefix keeps the two identity spaces disjoint in one table.
--   * Primary key (map_id, voter_id) makes a re-vote an UPSERT (one effective vote
--     per voter per map; changing your mind overwrites, never double-counts).
--   * is_authed is denormalized from the prefix so the read-time summary can weight
--     signed-in votes without parsing voter_id.
--   * stars is bounded 1..5; anything else is rejected by the server before write,
--     and by the CHECK here as belt-and-suspenders.

create table if not exists public.map_ratings (
    map_id     text        not null,
    voter_id   text        not null,
    stars      smallint    not null check (stars between 1 and 5),
    is_authed  boolean     not null default false,
    updated_at timestamptz not null default now(),
    primary key (map_id, voter_id)
);

create index if not exists map_ratings_map_idx on public.map_ratings (map_id);

alter table public.map_ratings enable row level security;

-- Reads are public so guests see the same aggregate scores. Writes go ONLY through
-- the server's service-role key (which bypasses RLS); no client write policy exists,
-- and we revoke the underlying grants so a future accidental policy can't open a
-- browser-spoofable write path (mirrors map_times).
drop policy if exists "map_ratings_select_all" on public.map_ratings;
create policy "map_ratings_select_all" on public.map_ratings
    for select using (true);

revoke insert, update, delete on public.map_ratings from anon, authenticated;

-- Read-time aggregate per map, split by voter class so the server can apply the
-- authed-vote weight (configurable) and a Bayesian prior in JS without a schema
-- change. One row per map that has at least one rating.
drop view if exists public.map_rating_summary;
create view public.map_rating_summary as
select
    map_id,
    count(*) filter (where not is_authed)                  as guest_votes,
    coalesce(sum(stars) filter (where not is_authed), 0)   as guest_sum,
    count(*) filter (where is_authed)                      as authed_votes,
    coalesce(sum(stars) filter (where is_authed), 0)       as authed_sum
from public.map_ratings
group by map_id;
