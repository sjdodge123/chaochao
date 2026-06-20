-- Discord Activity in-frame auth bridge (Phase 4). Two SECURITY DEFINER helpers the
-- server (service-role key) calls when an Activity player is validated via Discord:
--
--   find_user_by_discord_id(snowflake) -> the auth.users id that ALREADY owns this
--     Discord identity, or null. This is what makes an existing web "Continue with
--     Discord" account carry its cosmetics/progression into the Activity: we match
--     the validated snowflake against auth.identities (where GoTrue records the
--     provider id for a native Discord OAuth login) and ALSO against the discord_id
--     we stamp into auth.users.raw_user_meta_data for Activity-created users (so a
--     failed identity link still resolves on the next launch).
--
--   link_discord_identity(user_id, snowflake, identity_data) -> best-effort: attach a
--     provider='discord' row to an Activity-created user so a LATER web Discord login
--     adopts the SAME account (two-way unification). Idempotent (ON CONFLICT DO
--     NOTHING); a failure here never blocks auth — the user still plays, just isn't
--     pre-linked for the reverse direction.
--
-- Both are EXECUTE-granted to service_role only (the server's key); revoked from
-- anon/authenticated/public so a browser can never call them. `search_path = ''`
-- forces schema-qualified names (avoids the mutable-search-path advisor + injection).
--
-- NOTE: applied to the DEV project for local testing; PROD applies via the DB-migration
-- CI pipeline (never via MCP) — see the db-migration-ci-pipeline memory. Verify the
-- auth.identities column shape on the target before relying on the write-side link.

create or replace function public.find_user_by_discord_id(p_discord_id text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  -- DETERMINISTIC preference: a real GoTrue identity row wins over the metadata
  -- fallback. (A bare UNION ALL + LIMIT 1 has no defined order, so if a stale/orphaned
  -- identity and a metadata-stamped user ever pointed at DIFFERENT users, which one
  -- resolved would be non-deterministic across calls.) The identity table is the
  -- source of truth GoTrue itself uses for native Discord OAuth; the metadata stamp is
  -- only our own re-findability fallback for an Activity-created user whose identity
  -- link didn't land.
  select coalesce(
    (select user_id
       from auth.identities
      where provider = 'discord'
        and (identity_data->>'sub' = p_discord_id
             or identity_data->>'provider_id' = p_discord_id
             or provider_id = p_discord_id)
      limit 1),
    (select id
       from auth.users
      where raw_user_meta_data->>'discord_id' = p_discord_id
      limit 1)
  )
$$;

create or replace function public.link_discord_identity(
  p_user_id uuid,
  p_discord_id text,
  p_identity_data jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into auth.identities (provider, provider_id, user_id, identity_data,
                               last_sign_in_at, created_at, updated_at)
  values ('discord', p_discord_id, p_user_id, coalesce(p_identity_data, '{}'::jsonb),
          now(), now(), now())
  on conflict do nothing;
end;
$$;

revoke all on function public.find_user_by_discord_id(text) from public, anon, authenticated;
grant execute on function public.find_user_by_discord_id(text) to service_role;

revoke all on function public.link_discord_identity(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.link_discord_identity(uuid, text, jsonb) to service_role;
