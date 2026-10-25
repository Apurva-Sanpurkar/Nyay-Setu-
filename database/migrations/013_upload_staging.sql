-- ===========================================================================
-- NyaySetu :: 013_upload_staging.sql            (2.0 · hosting on Vercel)
-- Run after 012_workflows.sql.
--
-- A private Supabase Storage bucket for the pieces of a resumable upload while
-- the recording is incomplete. On serverless hosting, consecutive requests can
-- reach different instances, so pieces cannot wait on local disk.
--
-- Every piece is already AES-256-GCM encrypted by the API before it is stored.
-- The bucket is private and has no policies: only the API's service role,
-- which bypasses storage RLS, can read or write it.
--
-- Idempotent. Does nothing on a database without Supabase's storage schema
-- (for example the PGlite instance used by `npm run db:validate`).
-- ===========================================================================

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage')
     and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('upload-staging', 'upload-staging', false, 16777216)
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
    raise notice 'Migration 013 complete: private upload-staging bucket ready.';
  else
    raise notice 'Migration 013 skipped: no Supabase storage schema in this database.';
  end if;
end
$$;
