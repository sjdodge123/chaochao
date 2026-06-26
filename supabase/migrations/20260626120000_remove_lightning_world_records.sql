-- One-off data cleanup: remove world-record times that were set on Lightning
-- brutal rounds before the WR-lightning suppression shipped (server/game.js
-- recordPlayerFinish now passes isWorldRecord:false on Lightning rounds).
--
-- map_times carries no round-type column, so Lightning-set times can't be told
-- apart from normal runs in the schema — these three rows were identified out of
-- band (operator account "roknua") as Lightning-boosted #1s that are far faster
-- than the rest of the field (Thin Black Line 6.67s vs 20.82s, Bumper City 11.61s
-- vs 16.95s, Rush Hour 19.44s vs 25.71s). Deleting each row drops that bogus best
-- so the next-fastest legitimate time becomes the map's record.
--
-- Scoped to (user_id, map_id, best_ms) so it is exact and idempotent: it removes
-- ONLY these specific stale rows and can never clip a different/newer time. Safe to
-- re-run (a no-op once applied).

delete from public.map_times
where user_id = '0c3c272e-a392-4abc-85b2-57d34c98adeb'
  and (map_id, best_ms) in (
    ('sfw0szJi9zjYdrejPiWajueO6B8h5s1X', 6665),   -- Thin Black Line
    ('kU8JKNBbGJdMnga4tY6OFDGjoitslypj', 11610),  -- Bumper City
    ('v3ZVMhDBPb0rEtoC2KJ8eaPVl9jDDife', 19443)   -- Rush Hour
  );
