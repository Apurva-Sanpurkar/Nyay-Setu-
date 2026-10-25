-- ===========================================================================
-- NyaySetu :: 004_otp_channels.sql
-- Generalises the OTP challenge table beyond Aadhaar, so email-based login
-- verification can share one lifecycle with Aadhaar-based citizen actions.
--
-- Run after 003_audit.sql. Safe on a fresh database and on one that already
-- has 001-003 applied: every step is guarded.
--
-- WHY THIS CHANGE
--   The table was built around a single channel, and its key column was called
--   aadhaar_token. Login verification sends a code to a registered email
--   address instead, and the subject of that challenge is a user, not an
--   Aadhaar holder. Reusing a column named aadhaar_token to hold a hash of a
--   user id would be a lie in the schema, so the column is renamed to what it
--   actually is: the token identifying whoever the challenge is about.
-- ===========================================================================

-- ------------------------------------------- rename the key column, once

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'otp_challenges'
      and column_name = 'aadhaar_token'
  ) then
    alter table public.otp_challenges rename column aadhaar_token to subject_token;
    raise notice 'otp_challenges.aadhaar_token renamed to subject_token';
  end if;
end $$;

-- ------------------------------------------------------- new columns

alter table public.otp_challenges
  add column if not exists channel text not null default 'aadhaar',
  -- What the UI shows the user: "code sent to a•••••a@gmail.com". Masked here
  -- rather than in the application so it cannot accidentally be logged in full.
  add column if not exists masked_destination text,
  -- Which user this challenge authenticates, for the login channel. Null for
  -- citizen actions, where the subject token is the binding instead.
  add column if not exists user_id uuid references public.users (id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'otp_challenges_channel_check'
  ) then
    alter table public.otp_challenges
      add constraint otp_challenges_channel_check
      check (channel in ('aadhaar', 'email', 'sms'));
  end if;
end $$;

-- The purpose vocabulary gains login_mfa, which is the second factor after a
-- correct password rather than a standalone sign-in method.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'otp_challenges_purpose_check'
  ) then
    alter table public.otp_challenges drop constraint otp_challenges_purpose_check;
  end if;

  alter table public.otp_challenges
    add constraint otp_challenges_purpose_check
    check (purpose in ('login', 'login_mfa', 'summons_ack', 'bail_checkin'));
end $$;

-- ------------------------------------------------------------ indexes

drop index if exists public.otp_lookup_idx;

create index if not exists otp_subject_idx
  on public.otp_challenges (subject_token, purpose, expires_at desc)
  where consumed_at is null;

create index if not exists otp_user_idx
  on public.otp_challenges (user_id, purpose, expires_at desc)
  where consumed_at is null;

comment on table public.otp_challenges is
  'Service-only. Stores the OTP digest, never the OTP, and a masked destination, never the address in full. RLS denies all client access.';
comment on column public.otp_challenges.subject_token is
  'Whoever the challenge is about: a salted Aadhaar token for citizen actions, or an HMAC of the user id for login.';

-- ----------------------------------------------- users: email verification

-- An emailed OTP only proves control of the address, so record when that was
-- last demonstrated. A court admin creating an account has not proved it.
alter table public.users
  add column if not exists email_verified_at timestamptz,
  -- Per-user opt out, for an account that authenticates some other way.
  add column if not exists mfa_email_enabled boolean not null default true;

comment on column public.users.email_verified_at is
  'Last time an emailed OTP to this address was successfully verified.';

-- ---------------------------------------------------- delivery attempt log

-- Outbound email is a dependency that fails in ways worth seeing: a wrong app
-- password, a rate limit, a bounced address. Without a record, "I never got the
-- code" is unanswerable, which is the same class of problem this whole project
-- exists to solve.
create table if not exists public.email_log (
  id           bigserial primary key,
  user_id      uuid references public.users (id) on delete set null,
  purpose      text not null,
  -- Masked. The full address is in public.users and nowhere else.
  masked_to    text not null,
  subject      text not null,
  status       text not null check (status in ('sent', 'failed', 'skipped')),
  provider_id  text,
  error        text,
  occurred_at  timestamptz not null default now()
);

create index if not exists email_log_user_idx on public.email_log (user_id, occurred_at desc);
create index if not exists email_log_failed_idx on public.email_log (occurred_at desc)
  where status = 'failed';

comment on table public.email_log is
  'Outbound email attempts. Addresses are masked; bodies and OTP codes are never stored.';

-- --------------------------------------------------------------- security

alter table public.email_log enable row level security;

drop policy if exists email_log_admin_read on public.email_log;
create policy email_log_admin_read on public.email_log
  for select to authenticated
  using (app.has_role(array['court_admin']));

drop policy if exists email_log_self_read on public.email_log;
create policy email_log_self_read on public.email_log
  for select to authenticated
  using (user_id = app.current_user_id());

-- Written only by the API.
revoke insert, update, delete on public.email_log from anon, authenticated;
revoke all on public.email_log from anon;

-- otp_challenges keeps its deliberate zero-policy, default-deny posture.
revoke all on public.otp_challenges from anon, authenticated;

-- ------------------------------------------------- audit the new columns

-- users already carries the audit trigger, so email_verified_at and
-- mfa_email_enabled changes are captured with no further work.

do $$
begin
  raise notice 'Migration 004 complete: OTP challenges now support email and SMS channels.';
end $$;
