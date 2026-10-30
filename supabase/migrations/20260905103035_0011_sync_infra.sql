-- Phase 4c: scheduling infrastructure and the sync shared secret.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 0008 revoked EXECUTE from PUBLIC, which also removed service_role's implicit
-- grant. The sync job runs as service_role and must be able to call this.
grant execute on function public.normalize_raw_orders() to service_role;

-- A dedicated secret for the scheduled caller, so the service-role key never
-- has to be embedded in a cron job definition or handled outside Supabase.
-- Generated in-database: the value is never printed or transported.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'oda_sync_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'oda_sync_key',
      'Shared secret for the scheduled Oda sync'
    );
  end if;
end;
$$;
