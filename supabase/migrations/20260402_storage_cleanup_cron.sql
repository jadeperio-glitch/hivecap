-- ─────────────────────────────────────────────────────────────────────────────
-- FIX 5: Scheduled cleanup of expired brain-ingestion storage files.
--
-- Runs every hour via pg_cron. Deletes storage objects under
-- brain-ingestion/{user_id}/{pdf_hash}.txt for any pending_documents row
-- where expires_at < now() (the row has already expired).
--
-- pg_cron must be enabled in Supabase Dashboard → Database → Extensions.
-- storage.objects path column uses the format: "{bucket}/{user_id}/{pdf_hash}.txt"
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable pg_cron extension (idempotent)
create extension if not exists pg_cron;

-- Schedule hourly cleanup job
select cron.schedule(
  'brain-ingestion-storage-cleanup',   -- job name (unique)
  '0 * * * *',                          -- every hour at :00
  $$
    delete from storage.objects
    where bucket_id = 'brain-ingestion'
      and name in (
        select storage_ref
        from public.pending_documents
        where expires_at < now()
      );

    delete from public.pending_documents
    where expires_at < now();
  $$
);
