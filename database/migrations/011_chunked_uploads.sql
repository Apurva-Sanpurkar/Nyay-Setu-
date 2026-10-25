-- ===========================================================================
-- NyaySetu :: 011_chunked_uploads.sql    (2.0 · F12 search and seizure video)
-- Run after 010_passport_capture.sql.
--
-- A search can run for most of an hour, and a recording of it is hundreds of
-- megabytes sent from a phone on a field connection. Sent as one request, a
-- dropped connection at 90% loses everything. So a recording is sent in pieces:
-- each piece is checked against its own SHA-256 when it arrives, stored
-- encrypted, and the upload can resume from the first missing piece. Only when
-- every piece is present is the whole recording reassembled, its full SHA-256
-- recomputed, and the item registered.
--
-- Witness names for a search-and-seizure recording live in
-- evidence_items.witnesses: off chain, never on the public page, never returned
-- to the accused.
--
-- Idempotent.
-- ===========================================================================

create table if not exists public.upload_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  case_id         uuid not null references public.cases (id) on delete cascade,
  file_name       text not null check (char_length(file_name) between 1 and 255),
  mime_type       text not null,
  total_bytes     bigint not null check (total_bytes > 0),
  chunk_size      integer not null check (chunk_size between 262144 and 16777216),
  total_chunks    integer not null check (total_chunks > 0),
  -- The whole recording's SHA-256 as the device computed it. Checked again at
  -- assembly against what actually arrived.
  declared_sha256 public.hash32 not null,
  -- Indexes received so far, and each piece's digest, so a re-sent piece with the
  -- same bytes is accepted and one with different bytes is refused.
  received        integer[] not null default '{}',
  chunk_digests   jsonb not null default '{}'::jsonb,
  status          text not null default 'open' check (status in ('open', 'consumed', 'expired', 'refused')),
  evidence_id     uuid references public.evidence_items (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '48 hours')
);

comment on table public.upload_sessions is
  '2.0: resumable uploads of long recordings. Pieces are stored encrypted until assembled.';

create index if not exists upload_sessions_user_idx on public.upload_sessions (user_id, created_at desc);
create index if not exists upload_sessions_open_idx on public.upload_sessions (expires_at) where status = 'open';

alter table public.evidence_items
  add column if not exists witnesses jsonb,
  add column if not exists search_checklist jsonb;

comment on column public.evidence_items.witnesses is
  'Search and seizure: witnesses present, as [{name, description}]. Off chain; never public; never to the accused.';

alter table public.upload_sessions enable row level security;

drop policy if exists upload_sessions_own on public.upload_sessions;
create policy upload_sessions_own on public.upload_sessions
  for select to authenticated
  using (user_id = app.current_user_id() or app.has_role(array['court_admin']));

revoke insert, update, delete on public.upload_sessions from anon, authenticated;

drop trigger if exists touch_updated_at on public.upload_sessions;
create trigger touch_updated_at before update on public.upload_sessions
  for each row execute function app.touch_updated_at();

drop trigger if exists audit_changes on public.upload_sessions;
create trigger audit_changes after insert or update or delete on public.upload_sessions
  for each row execute function app.audit_trigger();

do $$ begin raise notice 'Migration 011 complete: resumable uploads for long recordings.'; end $$;
