-- Phase 3: price history, overpay, and the personal inflation index.
--
-- Zero-price lines (free recycling bags, product 8211) and credit lines
-- (negative quantity) are excluded everywhere here: neither is a price
-- observation, and a zero base price would divide by zero.

-- Every price ever paid, per product, with movement since the first purchase.
create or replace view v_price_history as
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
window w as (partition by l.product_id order by o.delivery_date);

-- What each line cost above the cheapest price you have ever paid for it.
-- Not a claim you could have had that price on the day -- it is your own
-- historical best, which is the only benchmark this data supports.
create or replace view v_overpay as
with best as (
  select product_id, min(unit_price) as best_price
  from order_lines
  where quantity > 0 and unit_price > 0
  group by product_id
)
select
  o.delivery_date,
  l.order_number,
  l.product_id,
  l.product_name,
  l.unit_price,
  b.best_price,
  l.quantity,
  round((l.unit_price - b.best_price) * l.quantity, 2) as overpaid
from order_lines l
join orders o using (order_number)
join best   b using (product_id)
where l.quantity > 0
  and l.unit_price > b.best_price;

-- The fixed basket: >=3 separate purchases, first seen in 2025.
create or replace view v_inflation_basket as
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
having count(distinct l.order_number) >= 3
   and min(o.delivery_date) <= date '2025-12-31';

-- Monthly index. 100 = each product's first observed price.
-- price_locf carries the last known price forward across months with no
-- purchase; a product contributes nothing before its first observation, so
-- products_priced shows how much of the basket is actually being measured.
create or replace view v_inflation_index as
with months as (
  select generate_series(
           date_trunc('month', (select min(delivery_date) from orders)),
           date_trunc('month', (select max(delivery_date) from orders)),
           interval '1 month')::date as month
),
obs as (
  select l.product_id,
         date_trunc('month', o.delivery_date)::date as month,
         avg(l.unit_price)                          as price
  from order_lines l
  join orders o using (order_number)
  where l.quantity > 0 and l.unit_price > 0
  group by l.product_id, date_trunc('month', o.delivery_date)
),
grid as (
  select
    b.product_id,
    b.weight_spend,
    m.month,
    (select ob.price from obs ob
      where ob.product_id = b.product_id and ob.month <= m.month
      order by ob.month desc limit 1)               as price_locf,
    (select ob.price from obs ob
      where ob.product_id = b.product_id
      order by ob.month asc  limit 1)               as base_price
  from v_inflation_basket b
  cross join months m
)
select
  month,
  count(*) filter (where price_locf is not null)    as products_priced,
  round(100.0 * sum(weight_spend * price_locf / base_price)
          filter (where price_locf is not null)
        / nullif(sum(weight_spend) filter (where price_locf is not null), 0)
        , 1)                                        as index_value
from grid
group by month;
