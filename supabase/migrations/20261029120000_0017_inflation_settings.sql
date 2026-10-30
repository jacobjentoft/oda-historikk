-- Move the inflation basket's rules out of the view definition.
--
-- 0007 hard-coded "first seen by 2025-12-31, bought at least 3 times". The
-- basket is fixed on purpose (a Laspeyres-style index needs a stable basket),
-- but re-basing it should be an UPDATE, not a migration that redefines a view.

create table if not exists inflation_settings (
  id            smallint primary key default 1 check (id = 1),
  basket_cutoff date     not null,  -- products first bought after this are excluded
  min_buys      int      not null check (min_buys >= 1),
  updated_at    timestamptz not null default now()
);

insert into inflation_settings (id, basket_cutoff, min_buys)
values (1, date '2025-12-31', 3)
on conflict (id) do nothing;

alter table inflation_settings enable row level security;

create policy inflation_settings_read on inflation_settings
  for select to authenticated
  using ((select private.is_dashboard_user()));

create policy inflation_settings_update on inflation_settings
  for update to authenticated
  using ((select private.is_dashboard_user()))
  with check ((select private.is_dashboard_user()));

-- Same columns as before, so dependent views (v_inflation_index,
-- v_price_movement) need no change. security_invoker is restated because
-- CREATE OR REPLACE does not touch reloptions it isn't given.
create or replace view v_inflation_basket
with (security_invoker = on) as
select
  l.product_id,
  p.latest_name,
  count(distinct l.order_number) as buys,
  min(o.delivery_date)           as first_seen,
  sum(l.line_total)              as weight_spend
from order_lines l
join orders   o using (order_number)
join products p using (product_id)
where l.quantity > 0 and l.unit_price > 0
group by l.product_id, p.latest_name
having count(distinct l.order_number) >= (select min_buys      from public.inflation_settings)
   and min(o.delivery_date)           <= (select basket_cutoff from public.inflation_settings);
