-- ===========================================================================
-- NyaySetu :: 012_workflows.sql
-- Run after 011_chunked_uploads.sql.
--
-- The role workflows of 2.0, in one migration because they reference each
-- other (a disposal needs an approval; a lab re-check raises an alert):
--
--   F11  document_templates, certificates            Section 63 certificate
--   F13  seizures, seizure_items, malkhana_movements Police workflow
--   F14  lab_intakes, working_copies, report versions Forensic laboratory
--   F16  access_requests, objections                  Defence
--   F17  court_events, summons_service_attempts       Court
--   F18  checkin_explanations, notification_outbox    Accused / witness
--   F19  approval_requests, legal_holds, disposal_records  Governance
--   F4   discrepancy_alerts, alert_comments           Audit trail and alerts
--   F5   ai_reviews                                   Human review of AI output
--
-- Every table: RLS on (default-deny), reads limited to the case's assigned roles
-- or the registry, writes only through the API, audit trigger attached.
-- Idempotent.
-- ===========================================================================

-- ------------------------------------------------------------- F11 templates

create table if not exists public.document_templates (
  id            uuid primary key default gen_random_uuid(),
  template_key  text not null unique check (template_key ~ '^[a-z0-9_]{3,60}$'),
  title         text not null,
  -- Ordered sections: [{heading, body}]. Bodies may contain {placeholders}.
  sections      jsonb not null,
  footer        text not null,
  version       integer not null default 1 check (version >= 1),
  updated_by    uuid references public.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.document_templates is
  '2.0: editable document templates (Section 63 certificate, seizure memo, custody form). Templates, not legal advice.';

create table if not exists public.certificates (
  id                uuid primary key default gen_random_uuid(),
  evidence_id       uuid not null references public.evidence_items (id) on delete restrict,
  case_id           uuid not null references public.cases (id) on delete restrict,
  template_key      text not null,
  template_version  integer not null,
  pdf_sha256        public.hash32 not null,
  anchored_digest   public.hash32 not null,
  fields            jsonb not null,
  generated_by      uuid references public.users (id) on delete set null,
  generated_role    text,
  generated_at      timestamptz not null default now()
);
comment on table public.certificates is '2.0: every Section 63 certificate rendering, by digest.';
create index if not exists certificates_evidence_idx on public.certificates (evidence_id, generated_at desc);

-- ------------------------------------------------------------- F13 police

create table if not exists public.seizures (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null references public.cases (id) on delete restrict,
  memo_number      text not null,
  memo_digest      public.hash32,
  seized_at        timestamptz not null,
  -- Off chain, role-gated: where and from whom.
  place            text not null,
  seized_from      text,
  witnesses        jsonb not null default '[]'::jsonb,
  notes            text,
  created_by       uuid references public.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (case_id, memo_number)
);
comment on table public.seizures is '2.0: a seizure memo grouping related items (phone, SIM, memory card).';

create table if not exists public.seizure_items (
  id           uuid primary key default gen_random_uuid(),
  seizure_id   uuid not null references public.seizures (id) on delete cascade,
  evidence_id  uuid not null unique references public.evidence_items (id) on delete restrict,
  item_label   text not null,
  description  text,
  item_index   integer not null check (item_index >= 1),
  created_at   timestamptz not null default now(),
  unique (seizure_id, item_index)
);
comment on table public.seizure_items is '2.0: each item of a seizure, with its own evidence record and digest.';

create table if not exists public.malkhana_movements (
  id            uuid primary key default gen_random_uuid(),
  evidence_id   uuid not null references public.evidence_items (id) on delete restrict,
  case_id       uuid not null references public.cases (id) on delete restrict,
  movement      text not null check (movement in ('IN', 'OUT', 'RETURN', 'TRANSFER')),
  location      text not null,
  shelf         text,
  reason        text not null,
  counterparty  text,
  performed_by  uuid references public.users (id) on delete set null,
  occurred_at   timestamptz not null default now(),
  -- The movement's canonical digest, anchored like a custody transfer (D-06).
  movement_digest public.hash32 not null,
  anchor_id     uuid references public.anchors (id) on delete set null,
  created_at    timestamptz not null default now()
);
comment on table public.malkhana_movements is '2.0: the malkhana (property room) register. Append-only.';
create index if not exists malkhana_evidence_idx on public.malkhana_movements (evidence_id, occurred_at);

drop trigger if exists append_only on public.malkhana_movements;
create trigger append_only before update or delete on public.malkhana_movements
  for each row execute function app.refuse_mutation();

-- ------------------------------------------------------------- F14 laboratory

create table if not exists public.lab_intakes (
  id                     uuid primary key default gen_random_uuid(),
  evidence_id            uuid not null references public.evidence_items (id) on delete restrict,
  case_id                uuid not null references public.cases (id) on delete restrict,
  seal_intact            boolean not null,
  seal_notes             text,
  packaging_evidence_ids uuid[] not null default '{}',
  received_by            uuid references public.users (id) on delete set null,
  received_at            timestamptz not null default now(),
  condition_notes        text,
  recheck_digest         public.hash32,
  recheck_matched        boolean,
  recheck_anchor_id      uuid references public.anchors (id) on delete set null,
  status                 text not null default 'received' check (status in ('received', 'in_analysis', 'reported', 'returned')),
  status_changed_at      timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
comment on table public.lab_intakes is '2.0: laboratory intake checklist and the hash re-check on arrival.';
create index if not exists lab_intakes_case_idx on public.lab_intakes (case_id, received_at);

create table if not exists public.working_copies (
  id                    uuid primary key default gen_random_uuid(),
  original_evidence_id  uuid not null references public.evidence_items (id) on delete restrict,
  case_id               uuid not null references public.cases (id) on delete restrict,
  copy_sha256           public.hash32 not null,
  tool                  text not null,
  tool_version          text not null,
  method                text not null,
  notes                 text,
  operator_id           uuid references public.users (id) on delete set null,
  anchor_id             uuid references public.anchors (id) on delete set null,
  created_at            timestamptz not null default now()
);
comment on table public.working_copies is '2.0: forensic working copies, each linked to its original with how it was derived.';

alter table public.forensic_reports
  add column if not exists version integer not null default 1,
  add column if not exists supersedes_id uuid references public.forensic_reports (id) on delete restrict,
  add column if not exists analyst_name text,
  add column if not exists tool text,
  add column if not exists method text,
  add column if not exists anchor_id uuid references public.anchors (id) on delete set null;

-- A report is immutable once written; a correction is a new linked version.
drop trigger if exists append_only on public.forensic_reports;
create trigger append_only before update or delete on public.forensic_reports
  for each row execute function app.refuse_mutation();

-- ------------------------------------------------------------- F16 defence

create table if not exists public.access_requests (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null references public.cases (id) on delete cascade,
  requester_id     uuid not null references public.users (id) on delete cascade,
  reason           text not null,
  status           text not null default 'pending' check (status in ('pending', 'granted', 'refused', 'withdrawn')),
  decided_by       uuid references public.users (id) on delete set null,
  decision_reason  text,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.access_requests is '2.0: defence requests for access to a case, decided by the court. All logged.';
create index if not exists access_requests_case_idx on public.access_requests (case_id, created_at desc);

create table if not exists public.objections (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references public.cases (id) on delete cascade,
  evidence_id   uuid references public.evidence_items (id) on delete set null,
  filed_by      uuid not null references public.users (id) on delete cascade,
  grounds       text not null,
  status        text not null default 'open' check (status in ('open', 'upheld', 'dismissed', 'withdrawn')),
  ruling        text,
  ruled_by      uuid references public.users (id) on delete set null,
  ruled_at      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.objections is '2.0: objections to evidence, filed by defence, ruled on by the court.';

-- ------------------------------------------------------------- F17 court

create table if not exists public.court_events (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references public.cases (id) on delete cascade,
  kind          text not null check (kind in ('hearing', 'order', 'adjournment', 'direction', 'judgment')),
  title         text not null,
  body          text,
  scheduled_for timestamptz,
  linked_type   text check (linked_type in ('evidence', 'summons', 'bail', 'objection', 'access_request')),
  linked_id     uuid,
  document_sha256 public.hash32,
  created_by    uuid references public.users (id) on delete set null,
  created_at    timestamptz not null default now()
);
comment on table public.court_events is '2.0: hearings, orders and directions, linked to the events they concern. Role-gated.';
create index if not exists court_events_case_idx on public.court_events (case_id, coalesce(scheduled_for, created_at));

create table if not exists public.summons_service_attempts (
  id            uuid primary key default gen_random_uuid(),
  summons_id    uuid not null references public.summons (id) on delete cascade,
  attempted_at  timestamptz not null default now(),
  method        text not null check (method in ('in_person', 'registered_post', 'email', 'sms', 'affixture', 'electronic')),
  outcome       text not null check (outcome in ('served', 'refused', 'not_found', 'address_wrong', 'deferred')),
  notes         text,
  recorded_by   uuid references public.users (id) on delete set null,
  created_at    timestamptz not null default now()
);
comment on table public.summons_service_attempts is '2.0: every attempt to serve a summons.';

alter table public.checkins add column if not exists accuracy_metres numeric(10, 2);
alter table public.violations
  add column if not exists severity text check (severity in ('minor', 'moderate', 'serious', 'critical')),
  add column if not exists court_finding text check (court_finding in ('no_violation', 'gps_drift', 'technical', 'violation', 'absconding'));

-- ------------------------------------------------------------- F18 accused

create table if not exists public.checkin_explanations (
  id             uuid primary key default gen_random_uuid(),
  bail_id        uuid not null references public.bail_conditions (id) on delete cascade,
  case_id        uuid not null references public.cases (id) on delete cascade,
  violation_id   uuid references public.violations (id) on delete set null,
  reason         text not null check (char_length(reason) between 5 and 2000),
  category       text not null check (category in ('medical', 'network', 'device', 'travel_permitted', 'other')),
  submitted_by   uuid not null references public.users (id) on delete cascade,
  submitted_at   timestamptz not null default now()
);
comment on table public.checkin_explanations is
  '2.0: the accused''s reason for a missed check-in, shown to the court beside it. Not a violation by itself.';

create table if not exists public.notification_outbox (
  id                 uuid primary key default gen_random_uuid(),
  recipient_user_id  uuid references public.users (id) on delete cascade,
  channel            text not null check (channel in ('email', 'sms', 'sandbox')),
  template           text not null,
  payload            jsonb not null default '{}'::jsonb,
  dedupe_key         text not null unique,
  status             text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  provider           text,
  error              text,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz
);
comment on table public.notification_outbox is '2.0: reminders for summons and check-ins. Sandbox by default.';

-- ------------------------------------------------------------- F19 governance

create table if not exists public.approval_requests (
  id               uuid primary key default gen_random_uuid(),
  action           text not null check (action in ('case_close', 'evidence_destroy', 'custody_after_mismatch', 'legal_hold_release')),
  subject_type     text not null check (subject_type in ('case', 'evidence')),
  subject_id       uuid not null,
  case_id          uuid not null references public.cases (id) on delete restrict,
  requested_by     uuid not null references public.users (id) on delete restrict,
  requested_role   text not null,
  reason           text not null check (char_length(reason) >= 10),
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'executed', 'cancelled')),
  approver_id      uuid references public.users (id) on delete restrict,
  approver_role    text,
  approver_reason  text,
  decided_at       timestamptz,
  executed_at      timestamptz,
  idempotency_key  text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Two people, enforced where it cannot be forgotten.
  constraint approval_two_people check (approver_id is null or approver_id <> requested_by)
);
comment on table public.approval_requests is '2.0: two-person approval for critical actions. Requester and approver must differ.';
create index if not exists approvals_pending_idx on public.approval_requests (status, created_at) where status = 'pending';

create table if not exists public.legal_holds (
  id              uuid primary key default gen_random_uuid(),
  subject_type    text not null check (subject_type in ('case', 'evidence')),
  subject_id      uuid not null,
  case_id         uuid not null references public.cases (id) on delete restrict,
  reason          text not null,
  placed_by       uuid references public.users (id) on delete set null,
  placed_at       timestamptz not null default now(),
  released_by     uuid references public.users (id) on delete set null,
  release_reason  text,
  released_at     timestamptz,
  approval_id     uuid references public.approval_requests (id) on delete restrict
);
comment on table public.legal_holds is '2.0: a hold blocks disposal, deletion and destruction until released with a reason.';
create index if not exists legal_holds_active_idx on public.legal_holds (subject_type, subject_id) where released_at is null;

create table if not exists public.disposal_records (
  id            uuid primary key default gen_random_uuid(),
  evidence_id   uuid not null unique references public.evidence_items (id) on delete restrict,
  case_id       uuid not null references public.cases (id) on delete restrict,
  method        text not null check (method in ('returned_to_owner', 'destroyed', 'auctioned', 'transferred', 'retained_by_court')),
  performed_at  timestamptz not null default now(),
  witnesses     jsonb not null default '[]'::jsonb,
  notes         text,
  approval_id   uuid not null references public.approval_requests (id) on delete restrict,
  recorded_by   uuid references public.users (id) on delete set null,
  created_at    timestamptz not null default now()
);
comment on table public.disposal_records is '2.0: disposal at the end of a case. Requires an executed two-person approval.';

alter table public.evidence_items add column if not exists disposed_at timestamptz;

-- ------------------------------------------------------------- F4 alerts

create table if not exists public.discrepancy_alerts (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references public.cases (id) on delete cascade,
  evidence_id     uuid references public.evidence_items (id) on delete cascade,
  kind            text not null check (kind in (
                    'MISSING_CONFIRMATION', 'DELAYED_TX', 'HASH_MISMATCH', 'INDEXER_LAG', 'SYNC_FAILED',
                    'SEAL_BROKEN', 'CUSTODY_GAP', 'RECORD_CHAIN_DISAGREE', 'SIGNATURE_INVALID', 'CLOCK_SKEW')),
  severity        text not null check (severity in ('info', 'warning', 'serious')),
  explanation     text not null,
  dedupe_key      text not null unique,
  status          text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  detected_at     timestamptz not null default now(),
  acknowledged_by uuid references public.users (id) on delete set null,
  acknowledged_at timestamptz,
  resolved_by     uuid references public.users (id) on delete set null,
  resolved_at     timestamptz,
  resolution      text,
  constraint resolution_has_reason check (status <> 'resolved' or (resolution is not null and char_length(resolution) >= 10))
);
comment on table public.discrepancy_alerts is '2.0: things that could not be verified. Alerts never penalise anyone automatically.';
create index if not exists alerts_open_idx on public.discrepancy_alerts (case_id, status, detected_at desc);

create table if not exists public.alert_comments (
  id          uuid primary key default gen_random_uuid(),
  alert_id    uuid not null references public.discrepancy_alerts (id) on delete cascade,
  author_id   uuid references public.users (id) on delete set null,
  author_role text,
  body        text not null check (char_length(body) between 1 and 4000),
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------- F5 AI review

create table if not exists public.ai_reviews (
  id          uuid primary key default gen_random_uuid(),
  ai_flag_id  uuid not null references public.ai_flags (id) on delete cascade,
  case_id     uuid references public.cases (id) on delete cascade,
  reviewer_id uuid references public.users (id) on delete set null,
  reviewer_role text,
  decision    text not null check (decision in ('agree', 'contest', 'dismiss')),
  reason      text not null check (char_length(reason) >= 10),
  created_at  timestamptz not null default now()
);
comment on table public.ai_reviews is '2.0: a person''s recorded view of an AI output. AI never changes case status.';

-- ------------------------------------------------------------- comments for the validator

comment on table public.certificates is '2.0: every Section 63 certificate rendering, by digest.';
comment on table public.alert_comments is '2.0: discussion on a discrepancy alert.';

-- ------------------------------------------------------------- RLS, audit, timestamps

do $$
declare
  t text;
  case_tables text[] := array[
    'certificates', 'seizures', 'malkhana_movements', 'lab_intakes', 'working_copies', 'access_requests',
    'objections', 'court_events', 'checkin_explanations', 'approval_requests', 'legal_holds',
    'disposal_records', 'discrepancy_alerts', 'ai_reviews'];
  all_tables text[] := case_tables || array[
    'document_templates', 'seizure_items', 'summons_service_attempts', 'notification_outbox', 'alert_comments'];
begin
  foreach t in array all_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('drop trigger if exists audit_changes on public.%I', t);
    execute format('create trigger audit_changes after insert or update or delete on public.%I
                    for each row execute function app.audit_trigger()', t);
  end loop;

  -- Readable by roles assigned to the case, and by the registry.
  foreach t in array case_tables loop
    execute format('drop policy if exists %I on public.%I', t || '_case_read', t);
    execute format('create policy %I on public.%I for select to authenticated
                    using (app.has_role(array[''court_admin'']) or app.is_assigned(case_id))', t || '_case_read', t);
  end loop;
end $$;

-- Court events and objections are not for the accused's eyes through the API
-- path that bypasses the service; the API enforces the finer rules.

drop policy if exists document_templates_read on public.document_templates;
create policy document_templates_read on public.document_templates for select to authenticated using (true);

drop policy if exists seizure_items_read on public.seizure_items;
create policy seizure_items_read on public.seizure_items for select to authenticated
  using (exists (select 1 from public.seizures s where s.id = seizure_items.seizure_id
                 and (app.has_role(array['court_admin']) or app.is_assigned(s.case_id))));

drop policy if exists summons_attempts_read on public.summons_service_attempts;
create policy summons_attempts_read on public.summons_service_attempts for select to authenticated
  using (exists (select 1 from public.summons s where s.id = summons_service_attempts.summons_id
                 and (app.has_role(array['court_admin']) or app.is_assigned(s.case_id))));

drop policy if exists notification_outbox_own on public.notification_outbox;
create policy notification_outbox_own on public.notification_outbox for select to authenticated
  using (recipient_user_id = app.current_user_id() or app.has_role(array['court_admin']));

drop policy if exists alert_comments_read on public.alert_comments;
create policy alert_comments_read on public.alert_comments for select to authenticated
  using (exists (select 1 from public.discrepancy_alerts a where a.id = alert_comments.alert_id
                 and (app.has_role(array['court_admin']) or (a.case_id is not null and app.is_assigned(a.case_id)))));

do $$
declare t text;
begin
  foreach t in array array['document_templates', 'seizures', 'lab_intakes', 'access_requests', 'objections', 'approval_requests'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------------------------- seed templates

insert into public.document_templates (template_key, title, sections, footer)
values (
  'section63_certificate',
  'Certificate under Section 63(4)(c) of the Bharatiya Sakshya Adhiniyam, 2023',
  jsonb_build_array(
    jsonb_build_object('heading', 'Part A — to be filled by the party',
      'body', 'I, {custodian_name}, {custodian_designation}, state that the electronic record described below was produced by the computer or device identified here, which was regularly used to create, store or process information for the purposes of the activities regularly carried on over that period by the person having lawful control over its use.'),
    jsonb_build_object('heading', 'Device or source',
      'body', '{device_description}'),
    jsonb_build_object('heading', 'How the record was produced',
      'body', '{production_method}'),
    jsonb_build_object('heading', 'Hash value',
      'body', 'Algorithm: SHA-256. Hash of the record: {file_sha256}. Value anchored on the public ledger: {anchored_digest} (reference {public_ref}, transaction {tx_hash}).'),
    jsonb_build_object('heading', 'Time of capture or registration',
      'body', 'Captured or collected: {captured_at}. Registered: {registered_at}.'),
    jsonb_build_object('heading', 'Custody',
      'body', 'Current custodian: {custodian_role}. Chain of custody events recorded: {custody_count}.'),
    jsonb_build_object('heading', 'Part B — to be filled by the expert',
      'body', 'I, ____________________ (name), ____________________ (designation), have examined the electronic record identified above. The hash value computed by me is ____________________ using ____________________ (algorithm), which matches / does not match the value stated in Part A.')
  ),
  'TEMPLATE — verify against the current Schedule of the Bharatiya Sakshya Adhiniyam, 2023 with a legal practitioner before use. Generated by NyaySetu; not legal advice.'
)
on conflict (template_key) do nothing;

do $$ begin raise notice 'Migration 012 complete: role workflows, governance, alerts and templates.'; end $$;
