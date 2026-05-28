-- Atomic personal-best upsert. Replaces the read-then-write pattern in
-- leaderboard.js, which had a TOCTOU race: two concurrent finishes by the
-- same (user_id, map_id) — same account on two tabs, two devices, two rooms —
-- could both read the old best_ms, both decide they improved it, and the
-- slower writer's upsert could overwrite the faster one as "best."
--
-- Postgres's INSERT ... ON CONFLICT DO UPDATE WHERE makes the new-row-wins
-- check happen inside the same statement as the write, so a concurrent slower
-- finish whose write commits last sees the conflicting row's already-improved
-- best_ms and the WHERE clause prevents the regression.
--
-- Returns { wrote, previous_best_ms, current_best_ms } so the server can fire
-- the playerPbResult banner / float only on real PB improvements. wrote=false
-- means either the new time was slower OR a concurrent writer beat us to the
-- improvement; either way the client shouldn't show a "new record" telegraph.

create or replace function public.upsert_map_time_if_better(
    p_user_id uuid,
    p_map_id text,
    p_best_ms integer,
    p_display_name text
) returns table (
    wrote boolean,
    previous_best_ms integer,
    current_best_ms integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_old integer;
    v_new integer;
begin
    -- Snapshot the previous best within the same transaction as the write,
    -- so the returned previous_best_ms is consistent with the write decision
    -- (no stale read from before a competing writer landed).
    select best_ms into v_old from public.map_times
        where user_id = p_user_id and map_id = p_map_id;

    insert into public.map_times (user_id, map_id, best_ms, display_name, updated_at)
    values (p_user_id, p_map_id, p_best_ms, p_display_name, now())
    on conflict (user_id, map_id) do update
        set best_ms = excluded.best_ms,
            display_name = excluded.display_name,
            updated_at = excluded.updated_at
        where map_times.best_ms > excluded.best_ms
    returning best_ms into v_new;

    if v_new is null then
        -- ON CONFLICT WHERE was false: the existing row was already at-or-better
        -- than the proposed time, so no row changed. Report the unchanged best.
        return query select false, v_old, v_old;
    end if;

    -- Either inserted (v_old IS NULL) or updated (v_new < v_old).
    return query select true, v_old, v_new;
end;
$$;

-- Lock down the RPC: only the server's service-role key may invoke it. Without
-- this, an authenticated client with the anon key could call rpc(...) directly
-- and write its own row, bypassing the RLS write-policy removal in 0001.
revoke execute on function public.upsert_map_time_if_better(uuid, text, integer, text) from public;
revoke execute on function public.upsert_map_time_if_better(uuid, text, integer, text) from anon, authenticated;
grant execute on function public.upsert_map_time_if_better(uuid, text, integer, text) to service_role;
