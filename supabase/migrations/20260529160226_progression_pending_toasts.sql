-- Durable queue of unshown progression celebration toasts (XP gained, level-ups,
-- newly-unlocked skins, achievement unlocks). Earned at match end but SHOWN when the
-- player next arrives in a lobby (this session, after X-ing out of game-over, or on a
-- later boot) — so the busy game-over screen stays uncluttered. Persisted (not just
-- in-memory) so the toasts survive a server restart/redeploy between earning and showing.
--
-- Shape: a JSON array of small event objects, e.g.
--   [{"type":"xp","amount":125},{"type":"level","level":2},{"type":"skin","id":"crimson"}]
-- The server appends at match end (addProgression path) and clears the array when it
-- drains them to the client on lobby join. Written ONLY via the service-role key, same
-- as every other progression column.
alter table public.progression
    add column if not exists pending_toasts jsonb not null default '[]'::jsonb;
