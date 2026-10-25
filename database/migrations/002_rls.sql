-- ===========================================================================
-- NyaySetu :: 002_rls.sql
-- Row Level Security. Default-deny on every table, then explicit policies.
--
-- HOW IDENTITY REACHES POSTGRES
--   Two channels, checked in order:
--     1. request.jwt.claims  -- a Supabase JWT carrying nyay_user_id / nyay_role.
--                               Used when a client talks to PostgREST directly.
--     2. app.actor_id / app.actor_role  -- session GUCs the API sets per
--                               transaction. Used on the pooled service
--                               connection so audit rows still name a human.
--
-- WHY RLS IS STILL WORTH IT WHEN THE API USES THE SERVICE KEY
--   Supabase's service_role has BYPASSRLS, so these policies do not constrain
--   the API. That is intentional: authorisation for API traffic is enforced by
--   the RBAC middleware, which can return useful 403s and write audit rows.
--   RLS is the second wall. It is what stands between an attacker holding a
--   leaked anon key, or a future direct-from-browser query, or a Realtime
--   subscription, and the contents of these tables. A table with RLS off has
--   no second wall at all, which is why every single one has it on.
-- ===========================================================================

-- --------------------------------------------------------- helper functions

create or replace function app.jwt_claims()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      app.jwt_claims() ->> 'nyay_user_id',
      nullif(current_setting('app.actor_id', true), '')
    ),
    ''
  )::uuid;
$$;

create or replace function app.current_role_name()
returns text
language sql
stable
as $$
  select coalesce(
    app.jwt_claims() ->> 'nyay_role',
    nullif(current_setting('app.actor_role', true), '')
  );
$$;

create or replace function app.has_role(wanted text[])
returns boolean
language sql
stable
as $$
  select app.current_role_name() = any(wanted);
$$;

-- SECURITY DEFINER so reading case_assignments here does not re-enter that
-- table's own policies and recurse forever.
create or replace function app.is_assigned(p_case uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select exists (
    select 1
    from public.case_assignments ca
    where ca.case_id = p_case
      and ca.user_id = app.current_user_id()
  );
$$;

create or replace function app.can_write_case(p_case uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select exists (
    select 1
    from public.case_assignments ca
    where ca.case_id = p_case
      and ca.user_id = app.current_user_id()
      and ca.access = 'write'
  );
$$;

-- True when the current user is the accused or the surety on this bail order.
create or replace function app.is_bail_party(p_bail uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select exists (
    select 1
    from public.bail_conditions b
    where b.id = p_bail
      and app.current_user_id() in (b.accused_user_id, b.surety_user_id)
  );
$$;

revoke all on function app.is_assigned(uuid) from public;
revoke all on function app.can_write_case(uuid) from public;
revoke all on function app.is_bail_party(uuid) from public;
grant execute on function app.jwt_claims() to authenticated, anon;
grant execute on function app.current_user_id() to authenticated, anon;
grant execute on function app.current_role_name() to authenticated, anon;
grant execute on function app.has_role(text[]) to authenticated, anon;
grant execute on function app.is_assigned(uuid) to authenticated;
grant execute on function app.can_write_case(uuid) to authenticated;
grant execute on function app.is_bail_party(uuid) to authenticated;

grant usage on schema app to authenticated, anon;
grant usage on schema restricted to authenticated;

-- ------------------------------------------- enable RLS on absolutely everything

do $$
declare
  t record;
begin
  for t in
    select schemaname, tablename
    from pg_tables
    where (schemaname = 'public' and tablename in (
            'roles', 'users', 'sessions', 'otp_challenges', 'cases', 'case_assignments',
            'evidence_items', 'custody_events', 'integrity_checks', 'forensic_reports',
            'summons', 'bail_conditions', 'checkins', 'violations', 'ai_flags',
            'chain_tx', 'chain_events', 'indexer_state', 'audit_log'))
       or (schemaname = 'restricted' and tablename = 'user_pii')
  loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
end $$;

-- Drop any earlier version of each policy so this file is re-runnable.
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname in ('public', 'restricted')
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- =========================================================== reference data

create policy roles_read on public.roles
  for select to authenticated using (true);

-- ================================================================== users

-- Own row, always.
create policy users_self_read on public.users
  for select to authenticated
  using (id = app.current_user_id());

-- Court admin is the registry operator and sees the whole staff list.
create policy users_admin_read on public.users
  for select to authenticated
  using (app.has_role(array['court_admin']));

create policy users_admin_write on public.users
  for all to authenticated
  using (app.has_role(array['court_admin']))
  with check (app.has_role(array['court_admin']));

-- A user may change their own theme and name. The API restricts which columns
-- it actually forwards; this stops anyone editing somebody else's row at all.
create policy users_self_update on public.users
  for update to authenticated
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

-- Everybody else reads colleagues through public.user_directory, which exposes
-- only non-sensitive columns.
grant select on public.user_directory to authenticated;

-- ============================================================ restricted PII

create policy pii_self_read on restricted.user_pii
  for select to authenticated
  using (user_id = app.current_user_id());

create policy pii_admin_read on restricted.user_pii
  for select to authenticated
  using (app.has_role(array['court_admin']));

create policy pii_admin_write on restricted.user_pii
  for all to authenticated
  using (app.has_role(array['court_admin']))
  with check (app.has_role(array['court_admin']));

-- ================================================ sessions and OTP: no policies

-- RLS is enabled and deliberately has zero policies, so default-deny applies to
-- anon and authenticated alike. Only the API's service connection touches these.
revoke all on public.sessions from anon, authenticated;
revoke all on public.otp_challenges from anon, authenticated;

-- ================================================================== cases

create policy cases_assigned_read on public.cases
  for select to authenticated
  using (app.is_assigned(id) or app.has_role(array['court_admin']));

create policy cases_police_insert on public.cases
  for insert to authenticated
  with check (app.has_role(array['police', 'court_admin']));

create policy cases_write_update on public.cases
  for update to authenticated
  using (app.can_write_case(id) or app.has_role(array['court_admin']))
  with check (app.can_write_case(id) or app.has_role(array['court_admin']));

create policy case_assignments_read on public.case_assignments
  for select to authenticated
  using (
    user_id = app.current_user_id()
    or app.has_role(array['court_admin'])
    or (app.has_role(array['judge']) and app.is_assigned(case_id))
  );

create policy case_assignments_manage on public.case_assignments
  for all to authenticated
  using (app.has_role(array['court_admin', 'judge']))
  with check (app.has_role(array['court_admin', 'judge']));

-- ================================================================ evidence

-- Read for every participant assigned to the case. This is how a defence
-- lawyer gets to the chain of custody: assignment, not a special-cased role.
create policy evidence_assigned_read on public.evidence_items
  for select to authenticated
  using (app.is_assigned(case_id) or app.has_role(array['court_admin']));

create policy evidence_police_insert on public.evidence_items
  for insert to authenticated
  with check (app.has_role(array['police']) and app.is_assigned(case_id));

-- Only the roles that actually hold the item may amend its row, and never the
-- defence: read-only on prosecution data is a hard requirement.
create policy evidence_custodian_update on public.evidence_items
  for update to authenticated
  using (
    app.has_role(array['court_admin'])
    or (app.has_role(array['police', 'forensic_lab', 'prosecutor']) and app.can_write_case(case_id))
  )
  with check (
    app.has_role(array['court_admin'])
    or (app.has_role(array['police', 'forensic_lab', 'prosecutor']) and app.can_write_case(case_id))
  );

create policy custody_assigned_read on public.custody_events
  for select to authenticated
  using (
    exists (
      select 1 from public.evidence_items e
      where e.id = custody_events.evidence_id
        and (app.is_assigned(e.case_id) or app.has_role(array['court_admin']))
    )
  );

create policy custody_insert on public.custody_events
  for insert to authenticated
  with check (
    app.has_role(array['police', 'forensic_lab', 'prosecutor', 'judge', 'court_admin'])
    and exists (
      select 1 from public.evidence_items e
      where e.id = custody_events.evidence_id and app.is_assigned(e.case_id)
    )
  );

-- Custody history is append-only. No update or delete policy exists, so those
-- are denied for every client role.

create policy integrity_assigned_read on public.integrity_checks
  for select to authenticated
  using (
    exists (
      select 1 from public.evidence_items e
      where e.id = integrity_checks.evidence_id
        and (app.is_assigned(e.case_id) or app.has_role(array['court_admin']))
    )
  );

-- Defence counsel must be able to record a verification. It is the one write
-- they get, and it touches no prosecution row.
create policy integrity_insert on public.integrity_checks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.evidence_items e
      where e.id = integrity_checks.evidence_id and app.is_assigned(e.case_id)
    )
  );

create policy forensic_assigned_read on public.forensic_reports
  for select to authenticated
  using (app.is_assigned(case_id) or app.has_role(array['court_admin']));

create policy forensic_lab_insert on public.forensic_reports
  for insert to authenticated
  with check (app.has_role(array['forensic_lab']) and app.is_assigned(case_id));

-- ================================================================= summons

create policy summons_read on public.summons
  for select to authenticated
  using (
    app.is_assigned(case_id)
    or recipient_user_id = app.current_user_id()
    or app.has_role(array['court_admin'])
  );

create policy summons_court_insert on public.summons
  for insert to authenticated
  with check (app.has_role(array['judge', 'court_admin']));

create policy summons_court_update on public.summons
  for update to authenticated
  using (app.has_role(array['judge', 'court_admin']))
  with check (app.has_role(array['judge', 'court_admin']));

-- ==================================================================== bail

create policy bail_read on public.bail_conditions
  for select to authenticated
  using (
    app.is_assigned(case_id)
    or app.current_user_id() in (accused_user_id, surety_user_id)
    or app.has_role(array['court_admin'])
  );

create policy bail_judge_insert on public.bail_conditions
  for insert to authenticated
  with check (app.has_role(array['judge']));

create policy bail_judge_update on public.bail_conditions
  for update to authenticated
  using (app.has_role(array['judge', 'court_admin']))
  with check (app.has_role(array['judge', 'court_admin']));

create policy checkins_read on public.checkins
  for select to authenticated
  using (
    app.is_assigned(case_id)
    or app.is_bail_party(bail_id)
    or app.has_role(array['court_admin'])
  );

-- An accused may only file their own check-in.
create policy checkins_accused_insert on public.checkins
  for insert to authenticated
  with check (
    (app.has_role(array['accused']) and app.is_bail_party(bail_id))
    or app.has_role(array['court_admin'])
  );

create policy violations_read on public.violations
  for select to authenticated
  using (
    app.is_assigned(case_id)
    or (bail_id is not null and app.is_bail_party(bail_id))
    or app.has_role(array['court_admin'])
  );

create policy violations_court_insert on public.violations
  for insert to authenticated
  with check (app.has_role(array['judge', 'court_admin']));

create policy violations_court_ack on public.violations
  for update to authenticated
  using (app.has_role(array['judge', 'court_admin']))
  with check (app.has_role(array['judge', 'court_admin']));

-- ============================================================= AI predictions

create policy ai_flags_read on public.ai_flags
  for select to authenticated
  using (
    app.has_role(array['court_admin'])
    or (case_id is not null and app.is_assigned(case_id))
  );

-- Predictions are written only by the API. No insert policy exists on purpose.

-- ====================================================== chain bookkeeping

-- Everything here is already public on Sepolia, so signed-in read is fine.
-- Writes belong to the indexer alone, so no write policy is defined.
create policy chain_tx_read on public.chain_tx
  for select to authenticated using (true);

create policy chain_events_read on public.chain_events
  for select to authenticated using (true);

create policy indexer_state_read on public.indexer_state
  for select to authenticated using (true);

-- ================================================================ audit log

create policy audit_admin_read on public.audit_log
  for select to authenticated
  using (app.has_role(array['court_admin']));

-- Nobody may write the audit log through a policy. The trigger in 003 is
-- SECURITY DEFINER, which is the only path in.
revoke insert, update, delete on public.audit_log from anon, authenticated;
revoke all on public.audit_log from anon;

-- ======================================================== hardening the rest

revoke all on schema app from anon;
revoke all on all functions in schema app from anon;
grant execute on function app.jwt_claims() to anon;

-- Sanity report. Any table printed here would be a bug.
do $$
declare
  leaky text;
begin
  select string_agg(format('%s.%s', schemaname, tablename), ', ')
  into leaky
  from pg_tables
  where schemaname in ('public', 'restricted')
    and not rowsecurity;

  if leaky is not null then
    raise warning 'Tables without RLS: %', leaky;
  else
    raise notice 'RLS verified: every table in public and restricted has row security enabled.';
  end if;
end $$;

-- ============================================================== action log

alter table public.action_log enable row level security;

-- Court admin sees the whole audit feed; everyone else sees only their own trail.
create policy action_log_admin_read on public.action_log
  for select to authenticated
  using (app.has_role(array['court_admin']));

create policy action_log_self_read on public.action_log
  for select to authenticated
  using (actor_id = app.current_user_id());

-- Written only by the API. No insert policy on purpose.
revoke insert, update, delete on public.action_log from anon, authenticated;
revoke all on public.action_log from anon;
