-- Account-backed "mobile touch walkthrough seen" latch.
--
-- The first-run mobile touch walkthrough (client/scripts/hudOverlay.js) is gated by a
-- localStorage flag ("touchWalkthroughSeen"). localStorage is per-device and, inside the
-- Discord Activity, the iframe's storage is partitioned/ephemeral — so a signed-in player
-- on a new device (or every Activity launch) would re-see the walkthrough. This column
-- persists the "seen" state on the account so it follows the player cross-device and
-- survives the Activity. Guests keep using localStorage only.
--
-- Monotonic latch: only ever set true (server: saveTouchWalkthroughSeen). Same shape/grants
-- as the other progression columns — no new RLS needed (the existing row-owner policies
-- already cover every column of public.progression; writes go through the service-role key).

alter table public.progression
    add column if not exists touch_walkthrough_seen boolean not null default false;
