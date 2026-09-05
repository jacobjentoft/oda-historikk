-- Daily automatic sync at 04:17 UTC (early morning in Norway).
--
-- The job reads the shared secret straight out of Vault, so the key exists
-- only inside the database -- never in a config file, a repo, or a transcript.
-- Runs as the scheduling role (postgres), which is why it can read the vault.

select cron.schedule(
  'oda-daily-sync',
  '17 4 * * *',
  $job$
  select net.http_post(
    url := 'https://ezjevbjejokpomwyrysp.supabase.co/functions/v1/oda/sync',
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
