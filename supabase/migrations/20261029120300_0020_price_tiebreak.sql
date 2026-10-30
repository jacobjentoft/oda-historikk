-- Make first/last prices deterministic.
--
-- Weight-priced goods can appear twice in one delivery at different prices
-- (two packs of pork tenderloin: 67.72 and 83.11 on 2026-08-05). Ordering by
-- delivery_date alone left the tie to physical row order, so the "last price"
-- shown could change after a re-normalise with no change in the data.

-- First and last price are the AVERAGE paid on the first and last delivery
-- date -- the same averaging v_inflation_index already does per month.
create or replace view v_price_movement
with (security_invoker = on) as
with daily as (
  select l.product_id, o.delivery_date, round(avg(l.unit_price), 2) as price
  from order_lines l
  join orders o using (order_number)
  where l.quantity > 0 and l.unit_price > 0
  group by l.product_id, o.delivery_date
),
obs as (
  select
    b.product_id,
    b.latest_name,
    b.buys,
    b.weight_spend,
    (array_agg(d.price order by d.delivery_date asc ))[1] as first_price,
    (array_agg(d.price order by d.delivery_date desc))[1] as last_price,
    min(d.delivery_date) as first_seen,
    max(d.delivery_date) as last_seen
  from v_inflation_basket b
  join daily d using (product_id)
  group by b.product_id, b.latest_name, b.buys, b.weight_spend
)
select
  product_id, latest_name, buys, weight_spend,
  first_price, last_price, first_seen, last_seen,
  round(100.0 * (last_price - first_price) / first_price, 1) as pct_change
from obs;

-- Same columns as 0007; only the window gains a tie-break, so first_price
-- and prev_price no longer depend on row order within a delivery.
create or replace view v_price_history
with (security_invoker = on) as
select
  l.product_id,
  p.latest_name,
  o.delivery_date,
  o.order_number,
  l.unit_price,
  first_value(l.unit_price) over w                       as first_price,
  lag(l.unit_price)         over w                       as prev_price,
  round(l.unit_price - lag(l.unit_price) over w, 2)      as change_vs_prev,
  round(100.0 * (l.unit_price - first_value(l.unit_price) over w)
        / first_value(l.unit_price) over w, 1)           as pct_vs_first
from order_lines l
join orders   o using (order_number)
join products p using (product_id)
where l.quantity > 0 and l.unit_price > 0
window w as (partition by l.product_id
             order by o.delivery_date, l.order_number, l.line_no);
