-- ===========================================================================
-- NyaySetu :: 006_invitations.sql
-- Accounts are created by a court administrator and invited by email.
--
-- Run after 005_pii_access.sql.
--
-- WHY
--   There is no self-registration and no demo cast. A court is a closed
--   institution: somebody with authority decides who is a judge. So the only
--   way an account comes into existence is a court administrator creating it,
--   and the only way its holder learns their password is an email nobody else
--   can read.
--
--   That leaves one problem. A password sent by email is a password sitting in
--   an inbox forever, readable by anyone who later gains access to that
--   mailbox. So an invited password is single-use: it gets the holder through
--   one sign-in, and the system refuses to go further until they replace it.
-- ===========================================================================

alter table public.users
  -- Set when an account is created by an administrator, cleared the moment the
  -- holder chooses their own password.
  add column if not exists must_change_password boolean not null default false,
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by uuid references public.users (id) on delete set null,
  -- Distinguishes "never signed in" from "signed in long ago", which is what a
  -- court administrator needs to know before chasing somebody.
  add column if not exists first_login_at timestamptz;

comment on column public.users.must_change_password is
  'True while the account still holds the temporary password from its invitation. Blocks every route except changing it.';
comment on column public.users.invited_at is
  'When the invitation email was last sent.';

create index if not exists users_pending_invite_idx
  on public.users (invited_at desc)
  where must_change_password;

-- ------------------------------------------------- bootstrap protection

/**
 * Refuses to leave the system with no administrator.
 *
 * Deactivating or deleting the last court_admin would lock everybody out
 * permanently, with no route back in short of editing the database by hand.
 * The API checks this too, but the API is not the only thing that can write
 * here, and a constraint that lives in the database cannot be forgotten.
 */
create or replace function app.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  remaining integer;
begin
  -- Only interesting when an admin is being removed or stood down.
  if tg_op = 'DELETE' then
    if old.role <> 'court_admin' then return old; end if;
  else
    if old.role <> 'court_admin' then return new; end if;
    if new.role = 'court_admin' and new.is_active then return new; end if;
  end if;

  select count(*) into remaining
  from public.users u
  where u.role = 'court_admin'
    and u.is_active
    and u.id <> old.id;

  if remaining = 0 then
    -- P0001 (the plpgsql default) rather than check_violation, because the API
    -- passes a P0001 message straight through to the client: this sentence is
    -- written to be read by whoever just tried it.
    raise exception
      'Refusing to remove the last active court administrator. Create another one first.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_last_admin on public.users;
create trigger guard_last_admin
  before update or delete on public.users
  for each row execute function app.guard_last_admin();

comment on function app.guard_last_admin() is
  'Stops the last active court_admin being deactivated, demoted or deleted.';

do $$
begin
  raise notice 'Migration 006 complete. Accounts are now invite-only.';
end $$;
