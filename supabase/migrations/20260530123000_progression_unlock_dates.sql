-- Cosmetic unlock timestamps for adoption analytics.
--
-- jsonb map { cosmetic_id: ISO8601 } recording when each cosmetic was FIRST unlocked for a
-- player (level + achievement skins alike). Lets us chart adoption curves ("when did people
-- start unlocking X") without a separate table. Written by auth.addProgression on the
-- match-end write (behind ALLOW_SUPABASE_WRITES); existing keys are never overwritten.
--
-- Example: every unlock with its date ->
--   select user_id, key as cosmetic_id, value as unlocked_at
--   from public.progression, jsonb_each_text(unlock_dates);

alter table public.progression
    add column if not exists unlock_dates jsonb not null default '{}'::jsonb;
