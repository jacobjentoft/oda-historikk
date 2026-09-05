-- Phase 4b: storage for the Oda OAuth client and its tokens.
--
-- Secrets (client_secret if ever issued, access + refresh tokens) live in Vault.
-- Non-secret state lives here. Both are service-role only: RLS on, no policies.

-- Single-row table. The check constraint makes "there is only one connection"
-- a database rule rather than a convention.
create table if not exists oda_credentials (
  id               smallint primary key default 1 check (id = 1),
  client_id        text,
  scope            text,
  token_expires_at timestamptz,
  connected_at     timestamptz,
  updated_at       timestamptz not null default now()
);

alter table oda_credentials enable row level security;

-- Short-lived PKCE handshakes. A row is created by oda-auth-start (which
-- requires an authenticated dashboard user) and consumed once by the callback.
create table if not exists oda_auth_states (
  state         text primary key,
  code_verifier text        not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '10 minutes',
  consumed_at   timestamptz
);

alter table oda_auth_states enable row level security;

-- Vault wrappers. The vault schema is not reachable through PostgREST, so the
-- Edge Function needs these. They are SECURITY DEFINER and therefore dangerous
-- if exposed -- EXECUTE is granted to service_role ONLY, never to a browser role.
create or replace function public.oda_secret_set(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name, 'Oda OAuth');
  else
    perform vault.update_secret(v_id, p_value, p_name, 'Oda OAuth');
  end if;
end;
$$;

create or replace function public.oda_secret_get(p_name text)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name;
$$;

revoke execute on function public.oda_secret_set(text, text) from public, anon, authenticated;
revoke execute on function public.oda_secret_get(text)       from public, anon, authenticated;
grant  execute on function public.oda_secret_set(text, text) to service_role;
grant  execute on function public.oda_secret_get(text)       to service_role;
