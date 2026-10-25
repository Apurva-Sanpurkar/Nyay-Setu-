-- ===========================================================================
-- NyaySetu :: 003_audit.sql
-- Trigger-based audit trail on every sensitive table.
--
-- The API also writes its own audit rows for intent ("judge X issued summons
-- Y"). This trigger is the layer below that: it fires whatever the caller
-- intended, including on a direct psql session or a Supabase dashboard edit,
-- so "the row changed but nothing was logged" cannot happen.
-- ===========================================================================

create or replace function app.audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_pk      text;
  v_changed text[];
  -- Columns whose values must never land in the audit trail. Hashes of secrets
  -- are still secrets: an offline attack on a bcrypt digest is cheaper than on
  -- nothing at all.
  v_secrets text[] := array['password_hash', 'otp_hash', 'token_hash', 'csrf_token'];
  v_key     text;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_pk  := v_old ->> 'id';
  elsif tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_pk  := v_new ->> 'id';
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_pk  := v_new ->> 'id';

    select array_agg(e.key order by e.key)
      into v_changed
      from jsonb_each(v_new) e
     where v_new -> e.key is distinct from v_old -> e.key;

    -- A no-op UPDATE is noise, not history.
    if v_changed is null then
      return new;
    end if;
  end if;

  foreach v_key in array v_secrets loop
    if v_old is not null and v_old ? v_key then
      v_old := jsonb_set(v_old, array[v_key], '"[redacted]"'::jsonb);
    end if;
    if v_new is not null and v_new ? v_key then
      v_new := jsonb_set(v_new, array[v_key], '"[redacted]"'::jsonb);
    end if;
  end loop;

  insert into public.audit_log (
    table_name, operation, row_pk, actor_id, actor_role, old_data, new_data, changed_columns
  )
  values (
    tg_table_schema || '.' || tg_table_name,
    tg_op,
    v_pk,
    app.current_user_id(),
    coalesce(app.current_role_name(), 'service'),
    v_old,
    v_new,
    v_changed
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function app.audit_trigger() is
  'Row level audit capture. SECURITY DEFINER because public.audit_log denies direct writes.';

-- ------------------------------------------------- attach to sensitive tables

do $$
declare
  t text;
  targets text[] := array[
    'public.users',
    'restricted.user_pii',
    'public.cases',
    'public.case_assignments',
    'public.evidence_items',
    'public.custody_events',
    'public.integrity_checks',
    'public.forensic_reports',
    'public.summons',
    'public.bail_conditions',
    'public.checkins',
    'public.violations',
    'public.ai_flags'
  ];
begin
  foreach t in array targets loop
    execute format('drop trigger if exists audit_changes on %s', t);
    execute format(
      'create trigger audit_changes
         after insert or update or delete on %s
         for each row execute function app.audit_trigger()', t
    );
  end loop;

  raise notice 'Audit triggers attached to % tables.', array_length(targets, 1);
end $$;

-- --------------------------------------------- retention helper (call monthly)

create or replace function app.prune_expired()
returns table (deleted_sessions bigint, deleted_otps bigint)
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  s bigint;
  o bigint;
begin
  delete from public.sessions
   where expires_at < now() - interval '7 days'
      or (revoked_at is not null and revoked_at < now() - interval '7 days');
  get diagnostics s = row_count;

  delete from public.otp_challenges
   where expires_at < now() - interval '1 day';
  get diagnostics o = row_count;

  return query select s, o;
end;
$$;

comment on function app.prune_expired() is
  'Deletes stale sessions and spent OTP challenges. Safe to run from a cron job.';

revoke all on function app.prune_expired() from public, anon, authenticated;
