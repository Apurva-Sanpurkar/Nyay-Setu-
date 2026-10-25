-- ===========================================================================
-- NyaySetu :: 010_passport_capture.sql   (2.0 · F3 passport, F10/F12 capture)
-- Run after 009_verification_state.sql.
--
-- F3  Every item gets an unguessable public reference for its Integrity
--     Passport: a page anyone can open, which shows only the reference, the
--     anchored digest, the transaction, block time, verification state and the
--     custody event types with role labels. Nothing personal.
--
-- F10 Live capture. For a capture, the value anchored on chain is the SHA-256 of
--     a canonical manifest that contains the file's digest, the GPS fix, the
--     device time and the device (docs/DECISIONS.md D-04). anchored_digest is
--     whatever went on chain; file_hash stays the file's own digest.
--
--     The manifest holds raw coordinates, so it is readable only by roles
--     assigned to the case, and never appears on the public page, which says only
--     "location committed in anchor".
--
-- Idempotent.
-- ===========================================================================

alter table public.evidence_items
  add column if not exists public_ref text,
  add column if not exists source text not null default 'upload',
  add column if not exists anchor_mode text not null default 'file',
  add column if not exists anchored_digest public.hash32,
  add column if not exists capture_purpose text not null default 'general',
  add column if not exists capture_manifest jsonb,
  add column if not exists manifest_hash public.hash32,
  add column if not exists manifest_signature jsonb,
  add column if not exists signature_status text not null default 'none',
  add column if not exists gps_status text,
  add column if not exists gps_accuracy_m numeric(10, 2) check (gps_accuracy_m is null or gps_accuracy_m >= 0),
  add column if not exists gps_mocked boolean,
  add column if not exists device_id text,
  add column if not exists app_version text,
  add column if not exists device_time timestamptz,
  add column if not exists server_received_at timestamptz,
  add column if not exists clock_skew_seconds integer,
  add column if not exists clock_skew_flagged boolean not null default false,
  add column if not exists duration_ms integer check (duration_ms is null or duration_ms >= 0);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_source_check') then
    alter table public.evidence_items add constraint evidence_items_source_check
      check (source in ('upload', 'capture'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_anchor_mode_check') then
    alter table public.evidence_items add constraint evidence_items_anchor_mode_check
      check (anchor_mode in ('file', 'manifest'));
  end if;
  -- A manifest-anchored item must carry the manifest and its digest, or it could
  -- never be verified.
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_manifest_complete') then
    alter table public.evidence_items add constraint evidence_items_manifest_complete
      check (anchor_mode <> 'manifest' or (capture_manifest is not null and manifest_hash is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_capture_purpose_check') then
    alter table public.evidence_items add constraint evidence_items_capture_purpose_check
      check (capture_purpose in ('general', 'search_seizure', 'lab_intake'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_signature_status_check') then
    alter table public.evidence_items add constraint evidence_items_signature_status_check
      check (signature_status in ('none', 'valid', 'invalid', 'unknown_key'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_gps_status_check') then
    alter table public.evidence_items add constraint evidence_items_gps_status_check
      check (gps_status is null or gps_status in ('OK', 'LOW_ACCURACY', 'NO_GPS'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_public_ref_format') then
    alter table public.evidence_items add constraint evidence_items_public_ref_format
      check (public_ref is null or public_ref ~ '^NSE-[0-9A-Z]{26,32}$');
  end if;
end $$;

-- References for items that predate 2.0: 122 random bits from a v4 UUID.
update public.evidence_items
   set public_ref = 'NSE-' || upper(replace(gen_random_uuid()::text, '-', ''))
 where public_ref is null;

update public.evidence_items set anchored_digest = file_hash where anchored_digest is null;

alter table public.evidence_items alter column public_ref set not null;
alter table public.evidence_items alter column anchored_digest set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evidence_items_public_ref_key') then
    alter table public.evidence_items add constraint evidence_items_public_ref_key unique (public_ref);
  end if;
end $$;

comment on column public.evidence_items.public_ref is
  'Unguessable reference for the public Integrity Passport. Reveals nothing about the case.';
comment on column public.evidence_items.anchored_digest is
  'The digest written on chain: the file''s SHA-256 for uploads, the manifest''s SHA-256 for live captures.';
comment on column public.evidence_items.capture_manifest is
  'Canonical capture manifest (contains raw coordinates). Assigned case roles only; never public.';

-- --------------------------------------------------------- device keys

-- A device that signs its capture manifests registers its key here once. The
-- web app holds a non-extractable ECDSA P-256 key and registers the public half;
-- the phone holds an HMAC secret in its secure store and registers it, encrypted
-- at rest with the evidence key. A valid signature shows a manifest came from a
-- registered install of the app; it is not hardware attestation.
create table if not exists public.device_keys (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  key_id           text not null unique check (key_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  algorithm        text not null check (algorithm in ('ECDSA-P256-SHA256', 'HMAC-SHA256')),
  public_jwk       jsonb,
  secret_encrypted text,
  platform         text not null check (platform in ('web', 'android', 'ios')),
  label            text,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  constraint device_keys_material check (
    (algorithm = 'ECDSA-P256-SHA256' and public_jwk is not null and secret_encrypted is null)
    or (algorithm = 'HMAC-SHA256' and secret_encrypted is not null and public_jwk is null)
  )
);

comment on table public.device_keys is
  '2.0: capture-manifest signing keys, one per app install. Public keys and encrypted HMAC secrets only.';

create index if not exists device_keys_user_idx on public.device_keys (user_id) where revoked_at is null;

alter table public.device_keys enable row level security;

drop policy if exists device_keys_self_read on public.device_keys;
create policy device_keys_self_read on public.device_keys
  for select to authenticated
  using (user_id = app.current_user_id() or app.has_role(array['court_admin']));

revoke insert, update, delete on public.device_keys from anon, authenticated;

drop trigger if exists audit_changes on public.device_keys;
create trigger audit_changes after insert or update or delete on public.device_keys
  for each row execute function app.audit_trigger();

do $$ begin raise notice 'Migration 010 complete: integrity passport and capture manifests.'; end $$;
