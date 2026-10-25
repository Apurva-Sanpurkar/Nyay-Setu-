-- ===========================================================================
-- NyaySetu :: 009_verification_state.sql     (2.0 · F2 verification state)
-- Run after 008_case_intake.sql.
--
-- Every chain write that concerns evidence becomes an ANCHOR: a row that says
-- what was meant to be written (contract, method, the digest, the event that
-- should come back) and how far it has got.
--
--   LOCAL_ONLY → SUBMITTED → CONFIRMED
--   plus INTEGRITY_MISMATCH, SYNC_ERROR, REVIEW_REQUIRED
--
-- These are APPLICATION states, not contract states. The contract knows nothing
-- about them. CONFIRMED means: the receipt succeeded, the expected event was
-- decoded from it with the expected digest and case, and enough blocks sit on
-- top. The transition table lives in exactly one place,
-- backend/src/services/verification/stateMachine.ts, and every transition is
-- appended to anchor_state_events, which cannot be edited.
--
-- Idempotent.
-- ===========================================================================

do $$ begin
  create type public.verification_state as enum (
    'LOCAL_ONLY', 'SUBMITTED', 'CONFIRMED', 'INTEGRITY_MISMATCH', 'SYNC_ERROR', 'REVIEW_REQUIRED'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.anchors (
  id                     uuid primary key default gen_random_uuid(),
  purpose                text not null check (purpose in (
                           'evidence_registration', 'custody_transfer', 'integrity_check',
                           'forensic_report', 'anomaly_flag', 'document')),
  contract               text not null check (contract in ('EvidenceChain', 'SummonsChain', 'BailChain')),
  method                 text not null,
  -- The arguments as sent, JSON with bigints as decimal strings, so a retry
  -- sends exactly what the first attempt would have.
  args                   jsonb not null default '[]'::jsonb,
  case_id                uuid references public.cases (id) on delete restrict,
  subject_type           text not null,
  subject_id             text not null,
  parent_anchor_id       uuid references public.anchors (id) on delete restrict,
  -- One event name, or alternatives separated by "|" (an integrity check emits
  -- either IntegrityVerified or IntegrityMismatch, and both are a successful record).
  expected_event         text not null,
  expected_digest        public.hash32 not null,
  -- Which event argument carries the digest ("fileHash", "checkHash|submittedHash").
  digest_arg             text not null default 'fileHash',
  -- Other event arguments that must match, e.g. {"caseId": "0x…"} or {"evidenceId": "12"}.
  expected_args          jsonb not null default '{}'::jsonb,
  -- The id the contract assigned (evidenceId), once decoded from the event.
  chain_record_id        bigint,
  state                  public.verification_state not null default 'LOCAL_ONLY',
  tx_hash                public.tx_hash,
  block_number           bigint,
  block_hash             text check (block_hash is null or block_hash ~ '^0x[0-9a-f]{64}$'),
  confirmations          integer not null default 0 check (confirmations >= 0),
  required_confirmations integer not null default 1 check (required_confirmations >= 1),
  attempts               integer not null default 0 check (attempts >= 0),
  submitted_at           timestamptz,
  confirmed_at           timestamptz,
  last_checked_at        timestamptz,
  failure_code           text,
  failure_reason         text,
  idempotency_key        text unique check (idempotency_key is null or char_length(idempotency_key) between 8 and 200),
  created_by             uuid references public.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint anchors_confirmed_has_proof
    check (state <> 'CONFIRMED' or (tx_hash is not null and block_number is not null and block_hash is not null))
);

comment on table public.anchors is
  '2.0: every evidence-related chain write and how far it has got. Application state, not contract state.';

create index if not exists anchors_state_idx on public.anchors (state, updated_at);
create index if not exists anchors_case_idx on public.anchors (case_id, created_at);
create index if not exists anchors_subject_idx on public.anchors (subject_type, subject_id);
create index if not exists anchors_tx_idx on public.anchors (tx_hash);

create table if not exists public.anchor_state_events (
  id          bigserial primary key,
  anchor_id   uuid not null references public.anchors (id) on delete restrict,
  from_state  public.verification_state,
  to_state    public.verification_state not null,
  reason_code text not null,
  reason      text,
  actor_id    uuid references public.users (id) on delete set null,
  actor_role  text,
  occurred_at timestamptz not null default now()
);

comment on table public.anchor_state_events is
  '2.0: append-only history of every verification state transition.';

create index if not exists anchor_state_events_anchor_idx on public.anchor_state_events (anchor_id, occurred_at);

-- Append-only, enforced in the database: history that can be edited is not history.
create or replace function app.refuse_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: % refused', tg_table_name, tg_op;
end;
$$;

drop trigger if exists append_only on public.anchor_state_events;
create trigger append_only before update or delete on public.anchor_state_events
  for each row execute function app.refuse_mutation();

-- ------------------------------------------------------- evidence linkage

alter table public.evidence_items
  add column if not exists anchor_id uuid references public.anchors (id) on delete restrict,
  add column if not exists idempotency_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_idempotency_key_key') then
    alter table public.evidence_items add constraint evidence_items_idempotency_key_key unique (idempotency_key);
  end if;
end $$;

create index if not exists evidence_anchor_idx on public.evidence_items (anchor_id);

-- Back-fill an anchor for every item registered before 2.0. One with a
-- registration transaction starts as SUBMITTED, and the tracker confirms it
-- the normal way — by fetching the receipt and decoding the event — rather than
-- this migration declaring it confirmed. One with no transaction is a SYNC_ERROR:
-- its registration never reached the chain.
do $$
declare
  e record;
  v_anchor uuid;
begin
  for e in
    select ei.id, ei.case_id, ei.file_hash, ei.registration_tx_hash, ei.chain_evidence_id, ei.officer_id, ei.created_at
      from public.evidence_items ei
     where ei.anchor_id is null
  loop
    insert into public.anchors (
      purpose, contract, method, case_id, subject_type, subject_id, expected_event, expected_digest,
      chain_record_id, state, tx_hash, submitted_at, failure_code, failure_reason,
      idempotency_key, created_by, created_at
    ) values (
      'evidence_registration', 'EvidenceChain', 'registerEvidence', e.case_id, 'evidence_item', e.id::text,
      'EvidenceRegistered', e.file_hash, e.chain_evidence_id,
      case when e.registration_tx_hash is not null then 'SUBMITTED' else 'SYNC_ERROR' end::public.verification_state,
      e.registration_tx_hash,
      case when e.registration_tx_hash is not null then e.created_at end,
      case when e.registration_tx_hash is null then 'NEVER_ANCHORED' end,
      case when e.registration_tx_hash is null then 'Registered before 2.0 without a registration transaction.' end,
      'evidence:' || e.id::text || ':registration', e.officer_id, e.created_at
    )
    returning id into v_anchor;

    insert into public.anchor_state_events (anchor_id, from_state, to_state, reason_code, reason)
    values (
      v_anchor, null,
      case when e.registration_tx_hash is not null then 'SUBMITTED' else 'SYNC_ERROR' end::public.verification_state,
      'BACKFILL_2_0', 'State assigned when 2.0 was installed; confirmation is re-derived from the chain.'
    );

    update public.evidence_items set anchor_id = v_anchor where id = e.id;
  end loop;
end $$;

-- ---------------------------------------------------------------- security

alter table public.anchors enable row level security;
alter table public.anchor_state_events enable row level security;

drop policy if exists anchors_read on public.anchors;
create policy anchors_read on public.anchors
  for select to authenticated
  using (app.has_role(array['court_admin']) or (case_id is not null and app.is_assigned(case_id)));

drop policy if exists anchor_state_events_read on public.anchor_state_events;
create policy anchor_state_events_read on public.anchor_state_events
  for select to authenticated
  using (
    exists (
      select 1 from public.anchors a
       where a.id = anchor_state_events.anchor_id
         and (app.has_role(array['court_admin']) or (a.case_id is not null and app.is_assigned(a.case_id)))
    )
  );

-- Written only by the API.
revoke insert, update, delete on public.anchors from anon, authenticated;
revoke insert, update, delete on public.anchor_state_events from anon, authenticated;

drop trigger if exists touch_updated_at on public.anchors;
create trigger touch_updated_at before update on public.anchors
  for each row execute function app.touch_updated_at();

drop trigger if exists audit_changes on public.anchors;
create trigger audit_changes after insert or update or delete on public.anchors
  for each row execute function app.audit_trigger();

drop trigger if exists audit_changes on public.anchor_state_events;
create trigger audit_changes after insert on public.anchor_state_events
  for each row execute function app.audit_trigger();

do $$ begin raise notice 'Migration 009 complete: verification state machine.'; end $$;
