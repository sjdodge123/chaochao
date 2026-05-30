-- Harden public.progression to match the agreed hardened prod posture: revoke the default
-- anon/authenticated write grants so writes can only happen via the service-role key.
-- Belt-and-suspenders on top of the (already write-policy-free) RLS. Mirrors map_times (0001).
revoke insert, update, delete on public.progression from anon, authenticated;
