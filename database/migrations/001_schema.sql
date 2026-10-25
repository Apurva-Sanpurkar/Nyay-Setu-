-- ===========================================================================
-- NyaySetu :: 001_schema.sql
-- Tables, enums and indexes. Run first, then 002_rls.sql, then 003_audit.sql.
--
-- Run in the Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f database/migrations/001_schema.sql
--
-- Design rule enforced throughout: nothing in here duplicates what the chain
-- already proves. Hashes and chain ids are stored so rows can be joined to
-- on-chain records, never as the source of truth for integrity.
-- ===========================================================================

create schema if not exists app;         -- helper functions used by RLS policies
create schema if not exists restricted;  -- personally identifying data, separately gated

comment on schema app is 'NyaySetu internal helper functions for row level security.';
comment on schema restricted is 'PII tables. Readable only by the subject and court_admin.';

-- ---------------------------------------------------------------- enum types

do $$ begin
  create type public.user_role as enum (
    'police', 'forensic_lab', 'prosecutor', 'judge', 'defence_lawyer', 'accused', 'court_admin'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.case_status as enum (
    'registered', 'under_investigation', 'charge_sheeted', 'trial', 'disposed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.custody_stage as enum ('SCENE', 'FORENSIC_LAB', 'PROSECUTOR', 'COURT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.evidence_kind as enum ('photo', 'video', 'document', 'audio', 'physical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.summons_status as enum ('PENDING', 'DELIVERED', 'FAILED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.violation_kind as enum (
    'GEO_FENCE_BREACH', 'MISSED_CHECK_IN', 'NO_CONTACT_BREACH', 'OTHER'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.risk_band as enum ('LOW', 'MEDIUM', 'HIGH');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.chain_tx_status as enum ('pending', 'confirmed', 'failed');
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------- shared constraints

-- A 0x-prefixed 32 byte digest. Used for every SHA-256 and keccak256 column so
-- a malformed hash can never reach the chain layer.
create domain public.hash32 as text
  check (value ~ '^0x[0-9a-f]{64}$');

create domain public.eth_address as text
  check (value ~ '^0x[0-9a-fA-F]{40}$');

create domain public.tx_hash as text
  check (value ~ '^0x[0-9a-fA-F]{64}$');

-- ------------------------------------------------------------- reference data

create table if not exists public.roles (
  role        public.user_role primary key,
  label       text not null,
  description text not null,
  portal_path text not null
);

comment on table public.roles is 'Reference data. Read-only for every signed-in user.';

-- --------------------------------------------------------------------- users

create table if not exists public.users (
  id                    uuid primary key default gen_random_uuid(),
  -- Set when the deployment also uses Supabase Auth; the API session layer
  -- works without it.
  auth_user_id          uuid,
  email                 text not null,
  password_hash         text not null,
  full_name             text not null,
  role                  public.user_role not null,
  designation           text,
  station_or_court      text,
  wallet_address        public.eth_address,
  theme                 text not null default 'dark' check (theme in ('dark', 'light')),
  is_active             boolean not null default true,
  failed_login_attempts integer not null default 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists users_email_key on public.users (lower(email));
create index if not exists users_role_idx on public.users (role) where is_active;

comment on column public.users.password_hash is 'bcrypt. Never leaves the backend.';
comment on column public.users.wallet_address is 'Optional own wallet. Most users are relayed by the keeper.';

-- PII lives in its own schema so access can be reasoned about in one place.
create table if not exists restricted.user_pii (
  user_id           uuid primary key references public.users (id) on delete cascade,
  -- Salted SHA-256 of the Aadhaar number. The number itself is never stored,
  -- never logged and never sent on-chain. This token is what the contracts see.
  aadhaar_token     public.hash32 not null,
  aadhaar_last4     text check (aadhaar_last4 ~ '^[0-9]{4}$'),
  phone_encrypted   text,
  address_encrypted text,
  date_of_birth     date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists user_pii_aadhaar_token_key
  on restricted.user_pii (aadhaar_token);

comment on table restricted.user_pii is
  'Aadhaar tokens and encrypted contact details. aadhaar_token is a salted hash, never the number.';

-- ------------------------------------------------------- sessions and OTP

create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  -- SHA-256 of the opaque cookie value. Stealing the database does not
  -- hand over live sessions.
  token_hash   public.hash32 not null unique,
  csrf_token   text not null,
  user_agent   text,
  ip_address   inet,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

create index if not exists sessions_user_idx on public.sessions (user_id) where revoked_at is null;
create index if not exists sessions_expiry_idx on public.sessions (expires_at);

create table if not exists public.otp_challenges (
  id            uuid primary key default gen_random_uuid(),
  purpose       text not null check (purpose in ('login', 'summons_ack', 'bail_checkin')),
  aadhaar_token public.hash32 not null,
  reference_id  text,
  otp_hash      public.hash32 not null,
  attempts      integer not null default 0,
  max_attempts  integer not null default 3,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists otp_lookup_idx
  on public.otp_challenges (aadhaar_token, purpose, expires_at desc)
  where consumed_at is null;

comment on table public.otp_challenges is
  'Service-only. Stores the OTP digest, never the OTP. RLS denies all client access.';

-- --------------------------------------------------------------------- cases

create table if not exists public.cases (
  id             uuid primary key default gen_random_uuid(),
  fir_number     text not null unique,
  -- keccak256(fir_number). This is the bytes32 caseId every contract uses.
  case_id_hash   public.hash32 not null unique,
  title          text not null,
  offence_type   text not null,
  sections       text[] not null default '{}',
  police_station text not null,
  court_name     text,
  status         public.case_status not null default 'registered',
  summary        text,
  registered_by  uuid references public.users (id),
  registered_at  timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists cases_status_idx on public.cases (status);
create index if not exists cases_station_idx on public.cases (police_station);

create table if not exists public.case_assignments (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references public.cases (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  access      text not null default 'read' check (access in ('read', 'write')),
  assigned_by uuid references public.users (id),
  created_at  timestamptz not null default now(),
  unique (case_id, user_id)
);

create index if not exists case_assignments_user_idx on public.case_assignments (user_id);

comment on table public.case_assignments is
  'The single source of truth for "who may see this case". Every RLS policy routes through it.';

-- ------------------------------------------------------------------ evidence

create table if not exists public.evidence_items (
  id                     uuid primary key default gen_random_uuid(),
  case_id                uuid not null references public.cases (id) on delete cascade,
  -- Null until the registration transaction confirms.
  chain_evidence_id      bigint unique,
  file_hash              public.hash32 not null,
  file_name              text not null,
  mime_type              text,
  size_bytes             bigint check (size_bytes >= 0),
  kind                   public.evidence_kind not null,
  ipfs_cid               text,
  encryption_iv          text,
  encryption_tag         text,
  encryption_key_id      text,
  gps_lat                numeric(9, 6) check (gps_lat between -90 and 90),
  gps_lng                numeric(9, 6) check (gps_lng between -180 and 180),
  collected_at           timestamptz not null,
  device_reported_mtime  timestamptz,
  current_stage          public.custody_stage not null default 'SCENE',
  officer_id             uuid references public.users (id),
  officer_aadhaar_token  public.hash32 not null,
  anomaly_score          numeric(6, 5) check (anomaly_score between 0 and 1),
  anomaly_flagged        boolean not null default false,
  anomaly_reasons        text[] not null default '{}',
  anomaly_flag_hash      public.hash32,
  forensic_report_hash   public.hash32,
  mismatch_count         integer not null default 0,
  notes                  text,
  registration_tx_hash   public.tx_hash,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists evidence_case_idx on public.evidence_items (case_id);
create index if not exists evidence_hash_idx on public.evidence_items (file_hash);
create index if not exists evidence_stage_idx on public.evidence_items (current_stage);
create index if not exists evidence_flagged_idx on public.evidence_items (anomaly_flagged) where anomaly_flagged;

comment on column public.evidence_items.ipfs_cid is
  'CID of the AES-256-GCM ciphertext. The plaintext never reaches IPFS.';

create table if not exists public.custody_events (
  id             uuid primary key default gen_random_uuid(),
  evidence_id    uuid not null references public.evidence_items (id) on delete cascade,
  from_stage     public.custody_stage,
  to_stage       public.custody_stage not null,
  confirmed_hash public.hash32 not null,
  actor_id       uuid references public.users (id),
  actor_role     public.user_role,
  occurred_at    timestamptz not null,
  tx_hash        public.tx_hash,
  block_number   bigint,
  created_at     timestamptz not null default now()
);

create index if not exists custody_evidence_idx on public.custody_events (evidence_id, occurred_at);

create table if not exists public.integrity_checks (
  id             uuid primary key default gen_random_uuid(),
  evidence_id    uuid not null references public.evidence_items (id) on delete cascade,
  submitted_hash public.hash32 not null,
  expected_hash  public.hash32 not null,
  matched        boolean not null,
  checked_by     uuid references public.users (id),
  checked_by_role public.user_role,
  context        text,
  tx_hash        public.tx_hash,
  created_at     timestamptz not null default now()
);

create index if not exists integrity_evidence_idx on public.integrity_checks (evidence_id, created_at desc);
create index if not exists integrity_failed_idx on public.integrity_checks (matched) where not matched;

comment on table public.integrity_checks is
  'Every verification attempt, pass or fail. A rejected tamper attempt is evidence in itself.';

create table if not exists public.forensic_reports (
  id          uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.evidence_items (id) on delete cascade,
  case_id     uuid not null references public.cases (id) on delete cascade,
  lab_id      uuid references public.users (id),
  report_hash public.hash32 not null,
  conclusion  text not null,
  detail      text,
  ipfs_cid    text,
  tx_hash     public.tx_hash,
  created_at  timestamptz not null default now()
);

create index if not exists forensic_case_idx on public.forensic_reports (case_id);

-- ------------------------------------------------------------------- summons

create table if not exists public.summons (
  id                      uuid primary key default gen_random_uuid(),
  case_id                 uuid not null references public.cases (id) on delete cascade,
  chain_summons_id        bigint unique,
  recipient_user_id       uuid references public.users (id),
  recipient_name          text not null,
  recipient_aadhaar_token public.hash32 not null,
  document_hash           public.hash32 not null,
  document_ipfs_cid       text,
  document_body           text,
  hearing_at              timestamptz,
  issued_by               uuid references public.users (id),
  issued_at               timestamptz not null default now(),
  expiry_at               timestamptz not null,
  status                  public.summons_status not null default 'PENDING',
  delivered_at            timestamptz,
  delivery_lat            numeric(9, 6) check (delivery_lat between -90 and 90),
  delivery_lng            numeric(9, 6) check (delivery_lng between -180 and 180),
  device_fingerprint      text,
  non_delivery_alerted_at timestamptz,
  issue_tx_hash           public.tx_hash,
  ack_tx_hash             public.tx_hash,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint summons_expiry_after_issue check (expiry_at > issued_at)
);

create index if not exists summons_case_idx on public.summons (case_id);
create index if not exists summons_recipient_idx on public.summons (recipient_user_id);
create index if not exists summons_pending_idx on public.summons (expiry_at) where status = 'PENDING';

comment on column public.summons.document_body is
  'Off-chain summons text. Only its hash is anchored.';

-- ---------------------------------------------------------------------- bail

create table if not exists public.bail_conditions (
  id                       uuid primary key default gen_random_uuid(),
  case_id                  uuid not null unique references public.cases (id) on delete cascade,
  accused_user_id          uuid references public.users (id),
  accused_name             text not null,
  accused_aadhaar_token    public.hash32 not null,
  -- Human labels shown in the UI, and the keccak tags in the same order as the
  -- on-chain conditions array, so violation flags line up by index.
  conditions               text[] not null,
  condition_tags           public.hash32[] not null,
  order_text               text,
  centre_lat               numeric(9, 6) check (centre_lat between -90 and 90),
  centre_lng               numeric(9, 6) check (centre_lng between -180 and 180),
  radius_metres            integer not null default 0 check (radius_metres >= 0),
  checkin_interval_seconds integer not null default 604800 check (checkin_interval_seconds > 0),
  expiry_at                timestamptz not null,
  granted_by               uuid references public.users (id),
  surety_name              text,
  surety_user_id           uuid references public.users (id),
  risk_band                public.risk_band,
  risk_score               numeric(6, 5) check (risk_score between 0 and 1),
  compliance_score         integer check (compliance_score between 0 and 100),
  active                   boolean not null default true,
  grant_tx_hash            public.tx_hash,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint bail_conditions_tags_aligned
    check (array_length(conditions, 1) = array_length(condition_tags, 1))
);

create index if not exists bail_accused_idx on public.bail_conditions (accused_user_id);
create index if not exists bail_active_idx on public.bail_conditions (active) where active;

create table if not exists public.checkins (
  id                    uuid primary key default gen_random_uuid(),
  case_id               uuid not null references public.cases (id) on delete cascade,
  bail_id               uuid not null references public.bail_conditions (id) on delete cascade,
  accused_aadhaar_token public.hash32 not null,
  gps_lat               numeric(9, 6) not null check (gps_lat between -90 and 90),
  gps_lng               numeric(9, 6) not null check (gps_lng between -180 and 180),
  distance_metres       integer check (distance_metres >= 0),
  within_fence          boolean not null,
  occurred_at           timestamptz not null,
  device_fingerprint    text,
  tx_hash               public.tx_hash,
  block_number          bigint,
  created_at            timestamptz not null default now()
);

create index if not exists checkins_bail_idx on public.checkins (bail_id, occurred_at desc);

create table if not exists public.violations (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null references public.cases (id) on delete cascade,
  bail_id          uuid references public.bail_conditions (id) on delete cascade,
  kind             public.violation_kind not null,
  reason           text not null,
  detected_at      timestamptz not null,
  acknowledged_by  uuid references public.users (id),
  acknowledged_at  timestamptz,
  tx_hash          public.tx_hash,
  block_number     bigint,
  created_at       timestamptz not null default now()
);

create index if not exists violations_case_idx on public.violations (case_id, detected_at desc);
create index if not exists violations_open_idx on public.violations (detected_at desc)
  where acknowledged_at is null;

-- ------------------------------------------------------------ AI predictions

create table if not exists public.ai_flags (
  id           uuid primary key default gen_random_uuid(),
  model        text not null check (model in ('evidence_anomaly', 'bail_risk', 'case_delay')),
  model_version text,
  subject_type text not null,
  subject_id   text not null,
  case_id      uuid references public.cases (id) on delete cascade,
  input        jsonb not null,
  output       jsonb not null,
  -- SHA-256 over the canonical JSON of {model, input, output}. For the evidence
  -- anomaly model this is the digest anchored by anchorAnomalyFlag().
  payload_hash public.hash32 not null,
  anchored_tx_hash public.tx_hash,
  created_at   timestamptz not null default now()
);

create index if not exists ai_flags_subject_idx on public.ai_flags (model, subject_type, subject_id);
create index if not exists ai_flags_case_idx on public.ai_flags (case_id);

-- ----------------------------------------------------- chain bookkeeping

create table if not exists public.chain_tx (
  id           uuid primary key default gen_random_uuid(),
  tx_hash      public.tx_hash not null unique,
  contract     text not null,
  method       text not null,
  status       public.chain_tx_status not null default 'pending',
  block_number bigint,
  gas_used     numeric,
  error        text,
  submitted_by uuid references public.users (id),
  payload      jsonb,
  created_at   timestamptz not null default now(),
  confirmed_at timestamptz
);

create index if not exists chain_tx_status_idx on public.chain_tx (status, created_at desc);

create table if not exists public.chain_events (
  id           bigserial primary key,
  contract     text not null,
  event_name   text not null,
  block_number bigint not null,
  tx_hash      public.tx_hash not null,
  log_index    integer not null,
  args         jsonb not null,
  created_at   timestamptz not null default now(),
  unique (tx_hash, log_index)
);

create index if not exists chain_events_lookup_idx
  on public.chain_events (contract, event_name, block_number desc);

create table if not exists public.indexer_state (
  contract   text primary key,
  last_block bigint not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.chain_events is
  'Materialised contract events. The chain remains authoritative; this is a read cache.';

-- ----------------------------------------------------------------- audit log

create table if not exists public.audit_log (
  id              bigserial primary key,
  table_name      text not null,
  operation       text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  row_pk          text,
  actor_id        uuid,
  actor_role      text,
  old_data        jsonb,
  new_data        jsonb,
  changed_columns text[],
  occurred_at     timestamptz not null default now()
);

create index if not exists audit_table_idx on public.audit_log (table_name, occurred_at desc);
create index if not exists audit_actor_idx on public.audit_log (actor_id, occurred_at desc);

-- ------------------------------------------------- updated_at housekeeping

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
  targets text[] := array[
    'public.users', 'restricted.user_pii', 'public.cases', 'public.evidence_items',
    'public.summons', 'public.bail_conditions'
  ];
begin
  foreach t in array targets loop
    execute format('drop trigger if exists touch_updated_at on %s', t);
    execute format(
      'create trigger touch_updated_at before update on %s
         for each row execute function app.touch_updated_at()', t
    );
  end loop;
end $$;

-- ------------------------------------------------------------ safe directory

-- Column level access, done the portable way. The view runs with the owner's
-- rights (security_invoker = false), so it exposes exactly these columns of
-- public.users to every signed-in user and nothing else. Salaries, password
-- hashes and lockout state stay behind the table's own RLS.
drop view if exists public.user_directory;
create view public.user_directory
  with (security_invoker = false) as
  select id, full_name, role, designation, station_or_court, is_active
  from public.users
  where is_active;

comment on view public.user_directory is
  'Non-sensitive columns of public.users. The mechanism for column level access control.';

-- ------------------------------------------------------------- API action log

-- The trigger in 003 records what changed at row level. This records what was
-- intended at API level: "judge Mehta issued summons 14 for case CC/2026/0093".
-- Both matter. A row diff cannot tell you a tamper attempt was refused, because
-- a refused write leaves no row behind.
create table if not exists public.action_log (
  id          bigserial primary key,
  actor_id    uuid references public.users (id) on delete set null,
  actor_role  public.user_role,
  action      text not null,
  subject     text,
  case_id     uuid references public.cases (id) on delete set null,
  outcome     text not null default 'ok' check (outcome in ('ok', 'refused', 'failed')),
  detail      jsonb,
  ip_address  inet,
  user_agent  text,
  occurred_at timestamptz not null default now()
);

create index if not exists action_log_actor_idx on public.action_log (actor_id, occurred_at desc);
create index if not exists action_log_case_idx on public.action_log (case_id, occurred_at desc);
create index if not exists action_log_action_idx on public.action_log (action, occurred_at desc);
