-- A single cheap call for dashboard headline numbers.
-- SECURITY INVOKER on purpose: RLS applies, so a caller who is not on the
-- allowlist gets zeros rather than the real figures.

create or replace function public.oda_stats()
returns json
language sql
stable
security invoker
set search_path = ''
as $$
  select json_build_object(
    'orders',      (select count(*) from public.orders),
    'lines',       (select count(*) from public.order_lines),
    'products',    (select count(*) from public.products),
    'first_order', (select min(delivery_date) from public.orders),
    'last_order',  (select max(delivery_date) from public.orders),
    'total_spend', (select round(sum(gross_amount)) from public.orders)
  );
$$;

grant execute on function public.oda_stats() to authenticated, service_role;
