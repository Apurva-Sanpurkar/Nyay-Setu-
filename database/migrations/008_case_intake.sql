-- ===========================================================================
-- NyaySetu :: 008_case_intake.sql            (2.0 · F1 case intake)
-- Run after 007_account_removal.sql.
--
-- WHAT CHANGES
--   1. Every case gets a case_reference of its own (NS/<STATION>/<YEAR>/<SERIAL>).
--      It is what a case is called everywhere: screens, documents, the public
--      verification page. The FIR is no longer the case's identity.
--   2. The FIR moves into fir_records, one optional row per case, unique per
--      (police station, year, FIR number) — which is how FIRs are actually numbered.
--      fir_records is readable only by police, prosecutor, judge and court admin.
--   3. New cases are keyed on chain by a salted hash (case_key_scheme = salted_v2),
--      so neither the FIR nor the case reference can be recovered from the chain.
--      Cases created before 2.0 keep keccak256(FIR): their anchors are already on
--      chain and cannot be re-keyed. See docs/DECISIONS.md D-02.
--   4. The light theme becomes the default (D-11).
--
-- WHAT DOES NOT CHANGE
--   cases.fir_number stays, with its data and its unique constraint. It is made
--   nullable so a 2.0 case need not have one, and it is left untouched for every
--   existing row. The API stops returning it to roles that may not see FIRs.
--
-- Idempotent: safe to run twice.
-- ===========================================================================

-- ------------------------------------------------------------------ theme

alter table public.users alter column theme set default 'light';
-- One-time reset: the old default was 'dark' and a stored 'dark' cannot be told
-- apart from a deliberate choice. Guarded so a re-run does not undo later choices.
do $$
begin
  if not exists (select 1 from pg_class where relname = 'cases_case_reference_key') then
    update public.users set theme = 'light' where theme = 'dark';
  end if;
end $$;

-- ------------------------------------------------------------------ cases

alter table public.cases
  add column if not exists case_reference text,
  add column if not exists case_key_scheme text not null default 'fir_v1',
  add column if not exists case_salt text,
  add column if not exists origin text not null default 'fir';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cases_case_key_scheme_check') then
    alter table public.cases add constraint cases_case_key_scheme_check
      check (case_key_scheme in ('fir_v1', 'salted_v2'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cases_origin_check') then
    alter table public.cases add constraint cases_origin_check
      check (origin in ('fir', 'complaint', 'court', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cases_case_salt_check') then
    alter table public.cases add constraint cases_case_salt_check
      check (case_salt is null or case_salt ~ '^[0-9a-f]{64}$');
  end if;
  -- A salted key without its salt could never be re-derived, and a 1.0 key with
  -- one would be a lie about how it was made.
  if not exists (select 1 from pg_constraint where conname = 'cases_salt_matches_scheme') then
    alter table public.cases add constraint cases_salt_matches_scheme
      check ((case_key_scheme = 'salted_v2') = (case_salt is not null));
  end if;
end $$;

-- A 2.0 case may have no FIR at all (a complaint under inquiry, a court matter).
alter table public.cases alter column fir_number drop not null;

-- Back-fill a reference for every case that predates this migration. The FIR
-- number was unique, so the reference is too.
update public.cases
   set case_reference = 'NS/FIR/' || left(upper(regexp_replace(fir_number, '[^A-Za-z0-9/_-]+', '-', 'g')), 80)
 where case_reference is null and fir_number is not null;

update public.cases
   set case_reference = 'NS/CASE/' || upper(substr(replace(id::text, '-', ''), 1, 12))
 where case_reference is null;

alter table public.cases alter column case_reference set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cases_case_reference_key') then
    alter table public.cases add constraint cases_case_reference_key unique (case_reference);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cases_case_reference_format') then
    alter table public.cases add constraint cases_case_reference_format
      check (case_reference ~ '^NS/[A-Z0-9/_-]{3,90}$');
  end if;
end $$;

comment on column public.cases.case_reference is
  'The case''s own identity. Shown everywhere a case is named; never derived from the FIR for 2.0 cases.';
comment on column public.cases.case_salt is
  '32 random bytes (hex). case_id_hash = keccak256("nyaysetu:case:v2:" || case_reference || ":" || case_salt) for salted_v2.';
comment on column public.cases.fir_number is
  '1.0 only. Kept for the cases that were keyed by it. 2.0 cases leave it null and use fir_records.';

-- Serial numbers per station and year, handed out atomically.
create table if not exists public.case_reference_counters (
  station_code text not null,
  year         integer not null check (year between 1950 and 2200),
  last_serial  integer not null default 0 check (last_serial >= 0),
  updated_at   timestamptz not null default now(),
  primary key (station_code, year)
);
comment on table public.case_reference_counters is '2.0: serial counters for case references. Service-only.';

create or replace function public.next_case_reference(p_station_code text, p_year integer)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_serial integer;
  v_code   text := upper(regexp_replace(coalesce(p_station_code, ''), '[^A-Za-z0-9]+', '-', 'g'));
begin
  v_code := trim(both '-' from v_code);
  if v_code = '' then
    raise exception 'A station or court code is required to number a case.';
  end if;
  v_code := left(v_code, 40);

  insert into public.case_reference_counters as c (station_code, year, last_serial)
  values (v_code, p_year, 1)
  on conflict (station_code, year)
  do update set last_serial = c.last_serial + 1, updated_at = now()
  returning last_serial into v_serial;

  return 'NS/' || v_code || '/' || p_year::text || '/' || lpad(v_serial::text, 6, '0');
end;
$$;

revoke all on function public.next_case_reference(text, integer) from public, anon, authenticated;
grant execute on function public.next_case_reference(text, integer) to service_role;

-- ------------------------------------------------------------- FIR records

create table if not exists public.fir_records (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid not null unique references public.cases (id) on delete restrict,
  fir_number          text not null check (char_length(fir_number) between 1 and 40),
  fir_number_norm     text not null,
  fir_year            integer not null check (fir_year between 1950 and 2200),
  fir_date            date,
  police_station      text not null check (char_length(police_station) between 2 and 160),
  police_station_norm text not null,
  district            text,
  -- True for rows copied from cases.fir_number by this migration, whose year was
  -- inferred from the registration date rather than entered.
  backfilled          boolean not null default false,
  recorded_by         uuid references public.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint fir_records_date_matches_year
    check (fir_date is null or extract(year from fir_date)::integer = fir_year)
);

create unique index if not exists fir_records_station_year_number_key
  on public.fir_records (police_station_norm, fir_year, fir_number_norm);

comment on table public.fir_records is
  '2.0: the FIR linked to a case, if any. Never on chain; readable by police, prosecutor, judge and court admin only.';

insert into public.fir_records (
  case_id, fir_number, fir_number_norm, fir_year, police_station, police_station_norm, backfilled, recorded_by
)
select c.id,
       c.fir_number,
       upper(regexp_replace(c.fir_number, '\s+', '', 'g')),
       extract(year from c.registered_at)::integer,
       c.police_station,
       lower(regexp_replace(c.police_station, '[^A-Za-z0-9]+', '-', 'g')),
       true,
       c.registered_by
  from public.cases c
 where c.fir_number is not null
   and not exists (select 1 from public.fir_records f where f.case_id = c.id)
on conflict do nothing;

-- ---------------------------------------------------------------- security

alter table public.case_reference_counters enable row level security;
alter table public.fir_records enable row level security;

revoke all on public.case_reference_counters from anon, authenticated;

drop policy if exists fir_records_read on public.fir_records;
create policy fir_records_read on public.fir_records
  for select to authenticated
  using (
    app.has_role(array['court_admin'])
    or (app.has_role(array['police', 'prosecutor', 'judge']) and app.is_assigned(case_id))
  );

drop policy if exists fir_records_write on public.fir_records;
create policy fir_records_write on public.fir_records
  for all to authenticated
  using (app.has_role(array['court_admin']) or (app.has_role(array['police']) and app.can_write_case(case_id)))
  with check (app.has_role(array['court_admin']) or (app.has_role(array['police']) and app.can_write_case(case_id)));

-- --------------------------------------------------------------- triggers

drop trigger if exists touch_updated_at on public.fir_records;
create trigger touch_updated_at before update on public.fir_records
  for each row execute function app.touch_updated_at();

drop trigger if exists audit_changes on public.fir_records;
create trigger audit_changes after insert or update or delete on public.fir_records
  for each row execute function app.audit_trigger();

drop trigger if exists audit_changes on public.case_reference_counters;
create trigger audit_changes after insert or update or delete on public.case_reference_counters
  for each row execute function app.audit_trigger();

comment on table public.case_reference_counters is '2.0: serial counters for case references. Service-only.';

create index if not exists cases_reference_idx on public.cases (case_reference);
create index if not exists action_log_case_time_idx on public.action_log (case_id, occurred_at);

do $$ begin raise notice 'Migration 008 complete: case references, FIR records, light theme default.'; end $$;
