-- Price movement per basket product, and order cadence.
--
-- Applied to the live project on 2026-09-05 but missing from the repo until
-- now; the dashboard reads v_price_movement. Both views are created with
-- security_invoker = on from the start so RLS applies (see 0008).

create or replace view v_price_movement
with (security_invoker = on) as
with obs as (
  select
    b.product_id,
    b.latest_name,
    b.buys,
    b.weight_spend,
    (array_agg(l.unit_price order by o.delivery_date asc ))[1] as first_price,
    (array_agg(l.unit_price order by o.delivery_date desc))[1] as last_price,
    min(o.delivery_date) as first_seen,
    max(o.delivery_date) as last_seen
  from v_inflation_basket b
  join order_lines l using (product_id)
  join orders     o using (order_number)
  where l.quantity > 0 and l.unit_price > 0
  group by b.product_id, b.latest_name, b.buys, b.weight_spend
)
select
  product_id, latest_name, buys, weight_spend,
  first_price, last_price, first_seen, last_seen,
  round(100.0 * (last_price - first_price) / first_price, 1) as pct_change
from obs;

create or replace view v_cadence
with (security_invoker = on) as
select days_since_prev as days, count(*) as orders
from v_basket_stats
where days_since_prev is not null
group by days_since_prev;
