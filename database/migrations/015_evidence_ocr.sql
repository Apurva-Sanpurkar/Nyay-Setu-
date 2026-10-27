-- ===========================================================================
-- NyaySetu :: 015_evidence_ocr.sql
-- Run after 014_smart_policing.sql.
--
-- Text read from a photographed or scanned evidence item (a seizure memo, an
-- FIR copy, a receipt, an exhibit label) by ai-service/src/ocr.py.
--
-- A reading is derived evidence, so each row carries the proof the service
-- produced: the digest of the bytes read (always the registered file digest —
-- the API refuses anything else), the digest of the prepared image, the
-- pipeline and engine versions, the digest of the text, and resultDigest over
-- all of it. The API recomputes resultDigest before storing it and anchors it
-- on chain, so the text cannot later be edited without the record ceasing to
-- match the ledger. The same file read through the same pipeline reproduces
-- the same digest, which is why a reading is unique per (item, digest).
--
-- RLS on (default-deny); reads follow the item's case; writes only through the
-- API; audit trigger attached. Idempotent.
-- ===========================================================================

create table if not exists public.evidence_ocr (
  id                  uuid primary key default gen_random_uuid(),
  evidence_id         uuid not null references public.evidence_items (id) on delete cascade,
  case_id             uuid not null references public.cases (id) on delete cascade,
  mode                text not null default 'document' check (mode in ('document', 'plate')),
  lang                text not null default 'eng' check (lang ~ '^[a-z_]{3,10}(\+[a-z_]{3,10}){0,4}$'),
  input_sha256        public.hash32 not null,
  preprocessed_sha256 public.hash32 not null,
  text_sha256         public.hash32 not null,
  result_digest       public.hash32 not null,
  extracted_text      text not null default '',
  confidence_pct      integer not null check (confidence_pct between 0 and 100),
  variant             text not null,
  psm                 integer not null check (psm between 0 and 13),
  engine              jsonb not null,
  pipeline            jsonb not null,
  proof               jsonb not null,
  improvement         jsonb,
  duration_ms         integer check (duration_ms is null or duration_ms >= 0),
  anchor_id           uuid references public.anchors (id) on delete set null,
  created_by          uuid references public.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint evidence_ocr_unique_reading unique (evidence_id, result_digest)
);

create index if not exists evidence_ocr_evidence_idx on public.evidence_ocr (evidence_id, created_at desc);

comment on table public.evidence_ocr is
  'OCR readings of evidence items with their proof; result_digest is anchored on chain (015).';

do $$
begin
  alter table public.evidence_ocr enable row level security;
  revoke insert, update, delete on public.evidence_ocr from anon, authenticated;

  drop trigger if exists audit_changes on public.evidence_ocr;
  create trigger audit_changes after insert or update or delete on public.evidence_ocr
    for each row execute function app.audit_trigger();

  -- Whoever may read the case may read what was read from its evidence.
  drop policy if exists evidence_ocr_case_read on public.evidence_ocr;
  create policy evidence_ocr_case_read on public.evidence_ocr for select to authenticated
    using (app.has_role(array['court_admin']) or app.is_assigned(case_id));
end $$;

do $$ begin raise notice 'Migration 015 complete: evidence OCR.'; end $$;
