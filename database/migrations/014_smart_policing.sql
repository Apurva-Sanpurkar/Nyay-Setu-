-- ===========================================================================
-- NyaySetu :: 014_smart_policing.sql
-- Run after 013_upload_staging.sql.
--
-- Two police modules that work across stations rather than inside one case:
--
--   Vehicle Trace   vehicle_reports, vehicle_events, vehicle_matches
--                   Lost, stolen, found and abandoned vehicles, matched by
--                   registration number and characteristics, with alerts to the
--                   station that holds the original complaint.
--
--   Third Eye       ti_persons, ti_case_links, ti_leads, ti_events
--                   Suspect / accused / convicted person records, their case
--                   history across stations, and investigative leads that a
--                   person must confirm or reject. Nothing here identifies
--                   anyone on its own.
--
--   Shared          secure_media    encrypted photographs and sketches
--                   station_alerts  inter-station notifications
--
-- Photographs are AES-256-GCM encrypted by the API before they are stored
-- (same scheme as evidence). Only digests are anchored on chain; no name,
-- registration number or location ever goes on the ledger.
--
-- Every table: RLS on (default-deny), reads for police and the registry,
-- writes only through the API, audit trigger attached. Idempotent.
-- ===========================================================================

-- ------------------------------------------------------------- shared: media

create table if not exists public.secure_media (
  id               uuid primary key default gen_random_uuid(),
  module           text not null check (module in ('vehicle_trace', 'third_eye')),
  subject_id       uuid not null,
  kind             text not null check (kind in ('vehicle_photo', 'plate_photo', 'suspect_photo', 'sketch', 'cctv_still', 'other')),
  cid              text not null,
  iv               text not null,
  tag              text not null,
  key_id           text not null,
  sha256           public.hash32 not null,
  mime_type        text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes            integer not null check (bytes > 0),
  -- 64-bit difference hash of the image, computed on the officer's device. Finds
  -- the same picture uploaded twice; it is not facial recognition.
  perceptual_hash  text check (perceptual_hash is null or perceptual_hash ~ '^[0-9a-f]{16}$'),
  source_note      text,
  uploaded_by      uuid references public.users (id) on delete set null,
  uploaded_station text,
  uploaded_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
comment on table public.secure_media is
  '2.0: encrypted photographs and sketches for Vehicle Trace and Third Eye. Append-only chain of custody.';
create index if not exists secure_media_subject_idx on public.secure_media (module, subject_id, uploaded_at);

drop trigger if exists append_only on public.secure_media;
create trigger append_only before update or delete on public.secure_media
  for each row execute function app.refuse_mutation();

-- ------------------------------------------------------------- shared: alerts

create table if not exists public.station_alerts (
  id              uuid primary key default gen_random_uuid(),
  -- Normalised station name (lower case, single spaces): who should act.
  target_station  text not null,
  kind            text not null check (kind in ('vehicle_match', 'vehicle_recovered', 'third_eye_link')),
  subject_type    text not null check (subject_type in ('vehicle_match', 'vehicle_report', 'ti_lead')),
  subject_id      uuid not null,
  title           text not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'unread' check (status in ('unread', 'read', 'actioned')),
  dedupe_key      text not null unique,
  read_by         uuid references public.users (id) on delete set null,
  read_at         timestamptz,
  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.station_alerts is '2.0: alerts from one police station to another (vehicle matches, case links).';
create index if not exists station_alerts_target_idx on public.station_alerts (target_station, status, created_at desc);

-- ------------------------------------------------------------- Vehicle Trace

create table if not exists public.vehicle_reports (
  id                  uuid primary key default gen_random_uuid(),
  report_type         text not null check (report_type in ('missing', 'stolen', 'found', 'abandoned', 'suspicious')),
  -- Upper case, letters and digits only ("MH12AB1234"). Null when unreadable.
  registration_norm   text check (registration_norm is null or registration_norm ~ '^[A-Z0-9]{4,12}$'),
  registration_raw    text,
  registration_source text not null default 'manual' check (registration_source in ('manual', 'anpr', 'anpr_corrected', 'none')),
  vehicle_type        text not null check (vehicle_type in ('two_wheeler', 'three_wheeler', 'car', 'suv', 'truck', 'bus', 'tractor', 'bicycle', 'other')),
  make                text,
  model               text,
  colour              text,
  chassis_last5       text check (chassis_last5 is null or chassis_last5 ~ '^[A-Z0-9]{3,6}$'),
  condition_notes     text,
  -- Missing / stolen: the complaint. Found / abandoned: where it was seen.
  complaint_ref       text,
  case_id             uuid references public.cases (id) on delete set null,
  incident_at         timestamptz,
  latitude            double precision check (latitude is null or latitude between -90 and 90),
  longitude           double precision check (longitude is null or longitude between -180 and 180),
  location_accuracy_m double precision,
  location_source     text not null default 'none' check (location_source in ('gps', 'manual', 'none')),
  location_text       text,
  station             text not null,
  station_norm        text not null,
  -- Owner contact for missing / stolen vehicles, encrypted (encryptField).
  owner_contact_enc   text,
  status              text not null check (status in (
                        'MISSING_REPORTED', 'VEHICLE_FOUND', 'POTENTIAL_MATCH', 'VERIFICATION_PENDING',
                        'MATCH_VERIFIED', 'RECOVERY_IN_PROGRESS', 'OWNER_VERIFICATION_PENDING',
                        'VEHICLE_RETURNED', 'CASE_CLOSED')),
  record_digest       public.hash32 not null,
  reported_by         uuid references public.users (id) on delete set null,
  reported_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint vehicle_location_pair check ((latitude is null) = (longitude is null))
);
comment on table public.vehicle_reports is '2.0: Vehicle Trace reports (missing, stolen, found, abandoned, suspicious).';
create index if not exists vehicle_reports_reg_idx on public.vehicle_reports (registration_norm) where registration_norm is not null;
create index if not exists vehicle_reports_station_idx on public.vehicle_reports (station_norm, status, reported_at desc);
create index if not exists vehicle_reports_type_idx on public.vehicle_reports (report_type, status);

create table if not exists public.vehicle_events (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null references public.vehicle_reports (id) on delete restrict,
  kind          text not null check (kind in ('reported', 'observation', 'status', 'match', 'media')),
  from_status   text,
  to_status     text,
  note          text,
  actor_id      uuid references public.users (id) on delete set null,
  actor_station text,
  occurred_at   timestamptz not null default now(),
  -- Hash chain: each event's digest covers the previous one.
  event_digest  public.hash32 not null,
  previous_digest public.hash32,
  anchored      boolean not null default false,
  created_at    timestamptz not null default now()
);
comment on table public.vehicle_events is '2.0: the timeline of a vehicle report. Append-only and hash-chained.';
create index if not exists vehicle_events_report_idx on public.vehicle_events (report_id, occurred_at);

drop trigger if exists append_only on public.vehicle_events;
create trigger append_only before update or delete on public.vehicle_events
  for each row execute function app.refuse_mutation();

create table if not exists public.vehicle_matches (
  id                 uuid primary key default gen_random_uuid(),
  missing_report_id  uuid not null references public.vehicle_reports (id) on delete restrict,
  found_report_id    uuid not null references public.vehicle_reports (id) on delete restrict,
  match_type         text not null check (match_type in ('exact_registration', 'partial_registration', 'characteristics')),
  score              numeric(4, 3) not null check (score between 0 and 1),
  reasons            jsonb not null default '[]'::jsonb,
  status             text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  decided_by         uuid references public.users (id) on delete set null,
  decided_at         timestamptz,
  decision_note      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (missing_report_id, found_report_id),
  constraint vehicle_match_distinct check (missing_report_id <> found_report_id),
  constraint vehicle_match_decided_has_reason check (status = 'pending' or (decision_note is not null and char_length(decision_note) >= 10))
);
comment on table public.vehicle_matches is '2.0: possible matches between a missing and a found vehicle. Verified by an officer, never automatically.';
create index if not exists vehicle_matches_status_idx on public.vehicle_matches (status, created_at desc);

-- ------------------------------------------------------------- Third Eye

create table if not exists public.ti_persons (
  id                    uuid primary key default gen_random_uuid(),
  full_name             text not null,
  name_norm             text not null,
  aliases               text[] not null default '{}',
  gender                text check (gender is null or gender in ('male', 'female', 'transgender', 'unknown')),
  date_of_birth         date,
  age_estimate          integer check (age_estimate is null or age_estimate between 5 and 120),
  height_cm             integer check (height_cm is null or height_cm between 50 and 250),
  build                 text,
  complexion            text,
  identifying_marks     text,
  physical_description  text,
  -- The person's standing in law, which the UI never lets blur:
  -- a suspect is not accused, an accused is not convicted.
  classification        text not null check (classification in ('person_of_interest', 'suspect', 'accused', 'convicted')),
  home_station          text not null,
  record_status         text not null default 'active' check (record_status in ('active', 'archived')),
  record_digest         public.hash32 not null,
  created_by            uuid references public.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.ti_persons is '2.0: Third Eye person records. Investigative information, not a finding of guilt.';
create index if not exists ti_persons_name_idx on public.ti_persons (name_norm);

create table if not exists public.ti_case_links (
  id                     uuid primary key default gen_random_uuid(),
  person_id              uuid not null references public.ti_persons (id) on delete restrict,
  fir_number             text not null,
  case_id                uuid references public.cases (id) on delete set null,
  police_station         text not null,
  station_norm           text not null,
  offence                text not null,
  offence_category       text not null check (offence_category in (
                           'theft', 'robbery', 'burglary', 'chain_snatching', 'vehicle_theft', 'cheating_fraud',
                           'cyber_crime', 'assault', 'murder', 'kidnapping', 'sexual_offence', 'narcotics', 'other')),
  modus_operandi         text,
  crime_date             date,
  crime_location         text,
  involvement            text not null check (involvement in ('suspect', 'accused', 'convicted', 'acquitted', 'discharged')),
  investigation_status   text not null check (investigation_status in (
                           'under_investigation', 'chargesheeted', 'on_trial', 'convicted', 'acquitted', 'closed')),
  arrest_status          text check (arrest_status is null or arrest_status in ('not_arrested', 'arrested', 'on_bail', 'absconding', 'in_custody')),
  court_status           text,
  investigating_officer  text,
  record_digest          public.hash32 not null,
  created_by             uuid references public.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
comment on table public.ti_case_links is '2.0: the case history of a Third Eye person, one row per FIR, across stations.';
create index if not exists ti_case_links_person_idx on public.ti_case_links (person_id, crime_date desc);
create index if not exists ti_case_links_fir_idx on public.ti_case_links (fir_number);

create table if not exists public.ti_leads (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('possible_duplicate', 'image_similarity', 'related_cases')),
  subject_a      uuid not null,
  subject_b      uuid not null,
  subject_type   text not null check (subject_type in ('person', 'case_link')),
  score          numeric(4, 3) not null check (score between 0 and 1),
  reasons        jsonb not null default '[]'::jsonb,
  status         text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  raised_by      uuid references public.users (id) on delete set null,
  reviewed_by    uuid references public.users (id) on delete set null,
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (kind, subject_a, subject_b),
  constraint ti_lead_distinct check (subject_a <> subject_b),
  constraint ti_lead_reviewed_has_reason check (status = 'pending' or (review_note is not null and char_length(review_note) >= 15))
);
comment on table public.ti_leads is
  '2.0: Third Eye investigative leads. A lead is a reason to look, never an identification; a person confirms or rejects it.';
create index if not exists ti_leads_status_idx on public.ti_leads (status, created_at desc);

create table if not exists public.ti_events (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references public.ti_persons (id) on delete restrict,
  kind            text not null check (kind in ('created', 'updated', 'case_linked', 'media_added', 'lead_reviewed', 'viewed')),
  detail          jsonb not null default '{}'::jsonb,
  actor_id        uuid references public.users (id) on delete set null,
  actor_station   text,
  occurred_at     timestamptz not null default now(),
  event_digest    public.hash32 not null,
  previous_digest public.hash32,
  created_at      timestamptz not null default now()
);
comment on table public.ti_events is '2.0: every change to a Third Eye record, hash-chained. Append-only.';
create index if not exists ti_events_person_idx on public.ti_events (person_id, occurred_at);

drop trigger if exists append_only on public.ti_events;
create trigger append_only before update or delete on public.ti_events
  for each row execute function app.refuse_mutation();

-- ------------------------------------------------------------- RLS, audit, timestamps

do $$
declare
  t text;
  all_tables text[] := array[
    'secure_media', 'station_alerts', 'vehicle_reports', 'vehicle_events', 'vehicle_matches',
    'ti_persons', 'ti_case_links', 'ti_leads', 'ti_events'];
  touched text[] := array['station_alerts', 'vehicle_reports', 'vehicle_matches', 'ti_persons', 'ti_case_links', 'ti_leads'];
begin
  foreach t in array all_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('drop trigger if exists audit_changes on public.%I', t);
    execute format('create trigger audit_changes after insert or update or delete on public.%I
                    for each row execute function app.audit_trigger()', t);
    -- Police across stations, and the registry for oversight. The API applies
    -- the finer rules (purpose of search, review, station of the alert).
    execute format('drop policy if exists %I on public.%I', t || '_police_read', t);
    execute format('create policy %I on public.%I for select to authenticated
                    using (app.has_role(array[''police'', ''court_admin'']))', t || '_police_read', t);
  end loop;

  foreach t in array touched loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;

do $$ begin raise notice 'Migration 014 complete: Vehicle Trace and Third Eye.'; end $$;
