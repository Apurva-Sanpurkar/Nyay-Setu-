-- ===========================================================================
-- NyaySetu :: 005_pii_access.sql
-- Reaches PII through SECURITY DEFINER functions instead of exposing a schema.
--
-- Run after 004_otp_channels.sql.
--
-- WHY THIS EXISTS
--   restricted.user_pii holds Aadhaar tokens and encrypted contact details. For
--   PostgREST to read a schema at all, that schema has to be listed under
--   Settings -> API -> Exposed schemas. That worked, but it had two problems:
--
--     1. It is a manual dashboard step, invisible in the repository, and
--        skipping it produces an error that looks like a code bug.
--     2. Exposing the schema makes EVERY table in it reachable over REST,
--        forever, including ones added later. The surface grows silently.
--
--   These functions invert that. The schema stays unexposed and unreachable,
--   and the only way in is four named operations that do exactly one thing
--   each. Adding a table to `restricted` later grants nobody anything.
--
--   They are SECURITY DEFINER because the caller has no rights on the schema.
--   Each one pins search_path, which is what stops a caller shadowing a table
--   name and having the function operate on theirs instead.
-- ===========================================================================

-- ------------------------------------------------------------ read one

create or replace function public.pii_get(p_user_id uuid)
returns table (
  user_id uuid,
  aadhaar_token public.hash32,
  aadhaar_last4 text,
  phone_encrypted text,
  address_encrypted text,
  date_of_birth date
)
language sql
stable
security definer
set search_path = restricted, public, pg_temp
as $$
  select p.user_id, p.aadhaar_token, p.aadhaar_last4,
         p.phone_encrypted, p.address_encrypted, p.date_of_birth
  from restricted.user_pii p
  where p.user_id = p_user_id;
$$;

comment on function public.pii_get(uuid) is
  'One PII row by user id. Service-only; the restricted schema stays unexposed.';

-- --------------------------------------------- directory of what exists

-- Deliberately returns no token and no encrypted field: the admin list needs to
-- know WHETHER a record exists and show the last four digits, nothing more.
create or replace function public.pii_directory()
returns table (user_id uuid, aadhaar_last4 text)
language sql
stable
security definer
set search_path = restricted, public, pg_temp
as $$
  select p.user_id, p.aadhaar_last4 from restricted.user_pii p;
$$;

comment on function public.pii_directory() is
  'Which users have an Aadhaar record, and the last four digits. Never the token.';

-- ------------------------------------------------- find by token

-- Answers "is this token already registered", for the uniqueness check when an
-- administrator attaches an Aadhaar number to an account.
create or replace function public.pii_owner_of(p_token public.hash32)
returns uuid
language sql
stable
security definer
set search_path = restricted, public, pg_temp
as $$
  select p.user_id from restricted.user_pii p where p.aadhaar_token = p_token limit 1;
$$;

comment on function public.pii_owner_of(public.hash32) is
  'The user holding this Aadhaar token, or null. For the duplicate check.';

-- -------------------------------------------------------- write

create or replace function public.pii_upsert(
  p_user_id uuid,
  p_aadhaar_token public.hash32,
  p_aadhaar_last4 text default null,
  p_phone_encrypted text default null,
  p_address_encrypted text default null,
  p_date_of_birth date default null
)
returns void
language plpgsql
security definer
set search_path = restricted, public, pg_temp
as $$
begin
  -- A foreign key would raise a less helpful error deep inside the insert.
  if not exists (select 1 from public.users u where u.id = p_user_id) then
    raise exception 'No user with id %', p_user_id using errcode = '23503';
  end if;

  insert into restricted.user_pii (
    user_id, aadhaar_token, aadhaar_last4, phone_encrypted, address_encrypted, date_of_birth
  )
  values (
    p_user_id, p_aadhaar_token, p_aadhaar_last4, p_phone_encrypted, p_address_encrypted, p_date_of_birth
  )
  on conflict (user_id) do update set
    aadhaar_token     = excluded.aadhaar_token,
    aadhaar_last4     = excluded.aadhaar_last4,
    -- A null on update means "leave it alone", not "erase it". Re-attaching an
    -- Aadhaar number without re-entering a phone should not wipe the phone.
    phone_encrypted   = coalesce(excluded.phone_encrypted, restricted.user_pii.phone_encrypted),
    address_encrypted = coalesce(excluded.address_encrypted, restricted.user_pii.address_encrypted),
    date_of_birth     = coalesce(excluded.date_of_birth, restricted.user_pii.date_of_birth),
    updated_at        = now();
end;
$$;

comment on function public.pii_upsert is
  'Creates or updates a PII row. Null optional arguments preserve existing values.';

-- --------------------------------------------------------- privileges

-- Nobody but the service role. These functions bypass RLS by design, so the
-- browser-facing roles must never be able to call them: an anon key plus a
-- reachable pii_get would hand over every Aadhaar token in the system.
revoke all on function public.pii_get(uuid) from public, anon, authenticated;
revoke all on function public.pii_directory() from public, anon, authenticated;
revoke all on function public.pii_owner_of(public.hash32) from public, anon, authenticated;
revoke all on function public.pii_upsert(uuid, public.hash32, text, text, text, date)
  from public, anon, authenticated;

grant execute on function public.pii_get(uuid) to service_role;
grant execute on function public.pii_directory() to service_role;
grant execute on function public.pii_owner_of(public.hash32) to service_role;
grant execute on function public.pii_upsert(uuid, public.hash32, text, text, text, date)
  to service_role;

-- The schema itself no longer needs to be reachable at all.
revoke usage on schema restricted from anon, authenticated;

do $$
begin
  raise notice
    'Migration 005 complete. `restricted` no longer needs to be an exposed schema.';
end $$;
