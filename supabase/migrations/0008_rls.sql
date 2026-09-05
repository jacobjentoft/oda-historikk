-- Phase 4a: the authentication boundary.
--
-- The dashboard ships its publishable key in a public GitHub Pages document.
-- That key is not a secret and is not meant to be. Everything below is what
-- actually protects the data.

create schema if not exists private;

-- Allowlist of who may read this dashboard. One row in practice.
-- RLS is enabled with NO policies, so no browser role can read it or add
-- themselves to it -- only the service role can, and that never reaches a client.
create table if not exists dashboard_users (
  user_id  uuid primary key,
  email    text not null,
  added_at timestamptz not null default now()
);

alter table dashboard_users enable row level security;

-- SECURITY DEFINER so it can read dashboard_users despite that table's RLS.
-- It takes no arguments and only ever checks the CALLER's own uid, so granting
-- it to authenticated leaks nothing -- unlike a definer function that accepts
-- an id, which could be probed for other people's access.
-- search_path = '' forces every reference to be schema-qualified, so the
-- function cannot be hijacked by a shadowing object in someone else's path.
create or replace function private.is_dashboard_user()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.dashboard_users
    where user_id = (select auth.uid())
  );
$$;

revoke execute on function private.is_dashboard_user() from public, anon;
grant  execute on function private.is_dashboard_user() to authenticated;

-- Postgres views run with the VIEW OWNER's privileges unless told otherwise.
-- Without this, every policy below would be bypassed by reading the view
-- instead of the table -- same rows, no check.
alter view v_spend_over_time   set (security_invoker = on);
alter view v_basket_stats      set (security_invoker = on);
alter view v_product_frequency set (security_invoker = on);
alter view v_staples           set (security_invoker = on);
alter view v_basket_similarity set (security_invoker = on);
alter view v_price_history     set (security_invoker = on);
alter view v_overpay           set (security_invoker = on);
alter view v_inflation_basket  set (security_invoker = on);
alter view v_inflation_index   set (security_invoker = on);

-- Base-table read policies. (select fn()) rather than fn() so Postgres
-- evaluates it once per query instead of once per row.
create policy orders_read on orders
  for select to authenticated
  using ((select private.is_dashboard_user()));

create policy order_lines_read on order_lines
  for select to authenticated
  using ((select private.is_dashboard_user()));

create policy products_read on products
  for select to authenticated
  using ((select private.is_dashboard_user()));

-- raw_orders deliberately gets NO policy: it is ingest staging, service-role
-- only, and nothing in the browser has any reason to read it.

-- Ingest machinery is not for clients to invoke.
revoke execute on function public.normalize_raw_orders() from public, anon, authenticated;
