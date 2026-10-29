-- Re-define the daily sync without a hard-coded project URL (see 0013).
--
-- The URL now comes from a Vault secret named 'project_url', so this file
-- works unchanged on any project. Create it once per project:
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--
-- Missing is a warning, not an error: the job is only looked up at run time,
-- and a fresh local stack (CI) has no project URL to give it.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    raise warning 'vault secret project_url is missing; oda-daily-sync will fail until it exists';
  end if;
end;
$$;

-- cron.schedule with an existing job name replaces that job.
select cron.schedule(
  'oda-daily-sync',
  '17 4 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
             where name = 'project_url') || '/functions/v1/oda/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-key',   (select decrypted_secret from vault.decrypted_secrets
                        where name = 'oda_sync_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);
