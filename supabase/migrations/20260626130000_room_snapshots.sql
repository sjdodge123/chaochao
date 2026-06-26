-- Seamless-reconnect (Phase 2): cross-process room roster + standings snapshot.
--
-- Written at SIGTERM by the dying dyno (server/roomSnapshot.js -> makeSupabaseStore),
-- read on boot by the new dyno to restore rooms + re-seat returning players. Rows are
-- short-lived (TTL ~2 min, carried in payload.expiresAt): the app purges the rows it
-- consumes on boot, and expires_at lets a periodic sweep drop any abandoned ones. The
-- server uses the service-role key (bypasses RLS); RLS is enabled with NO policies so
-- anon/auth clients can never read the roster (names/cosmetics are mildly sensitive).
create table if not exists public.room_snapshots (
    sig integer primary key,
    payload jsonb not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index if not exists room_snapshots_expires_at_idx
    on public.room_snapshots (expires_at);

alter table public.room_snapshots enable row level security;
-- No policies: only the service-role key (the game server) can read/write.
