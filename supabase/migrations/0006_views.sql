-- Phase 2: core analytical views.
-- These are the stable vocabulary the dashboard reads from. Adding a new
-- question should mean a new SELECT here, never a change to ingest.

-- Spend per month, with a running total.
-- sum(sum(x)) over (...) is not a typo: the inner sum aggregates each month,
-- the outer one is a window function running across those monthly rows.
-- Window functions are evaluated after GROUP BY.
create or replace view v_spend_over_time as
select
  date_trunc('month', delivery_date)::date          as month,
  count(*)                                          as orders,
  round(sum(gross_amount), 2)                       as spend,
  round(avg(gross_amount), 2)                       as avg_order,
  round(sum(sum(gross_amount))
        over (order by date_trunc('month', delivery_date)), 2) as cumulative_spend
from orders
-- must repeat the expression rather than "group by 1": Postgres matches the
-- window's ORDER BY against the GROUP BY expression, not against its ordinal.
group by date_trunc('month', delivery_date);

-- One row per order: size, value, and days since the previous delivery.
-- Credit lines (negative quantity) are excluded from line_count so a refund
-- doesn't read as an extra item, but they stay in units and in the totals.
create or replace view v_basket_stats as
select
  o.order_number,
  o.delivery_date,
  o.slot_weekday,
  o.slot_start_hour,
  o.gross_amount,
  o.line_total,
  o.net_discount,
  count(l.*) filter (where l.quantity > 0)          as line_count,
  sum(l.quantity)                                   as units,
  o.delivery_date
    - lag(o.delivery_date) over (order by o.delivery_date) as days_since_prev
from orders o
left join order_lines l using (order_number)
group by o.order_number, o.delivery_date, o.slot_weekday, o.slot_start_hour,
         o.gross_amount, o.line_total, o.net_discount;

-- Every product, how often it appears, and what it has cost in total.
create or replace view v_product_frequency as
select
  p.product_id,
  p.latest_name,
  count(distinct l.order_number)                    as orders_with,
  round(100.0 * count(distinct l.order_number)
        / (select count(*) from orders), 1)         as pct_of_orders,
  sum(l.quantity)                                   as total_units,
  round(sum(l.line_total), 2)                       as total_spend,
  round(avg(l.unit_price), 2)                       as avg_price,
  min(o.delivery_date)                              as first_bought,
  max(o.delivery_date)                              as last_bought
from order_lines l
join orders   o using (order_number)
join products p using (product_id)
group by p.product_id, p.latest_name;

-- The core basket: anything in more than 40% of orders.
create or replace view v_staples as
select * from v_product_frequency
where pct_of_orders > 40;

-- How similar is each basket to the one before it?
-- Jaccard = shared products / total distinct products across the two orders.
-- 100% would mean an identical shopping list; 0% no overlap at all.
create or replace view v_basket_similarity as
with baskets as (
  select o.order_number, o.delivery_date,
         array_agg(distinct l.product_id) as pids
  from orders o
  join order_lines l using (order_number)
  where l.quantity > 0
  group by o.order_number, o.delivery_date
),
seq as (
  select *,
         lag(pids)         over (order by delivery_date) as prev_pids,
         lag(order_number) over (order by delivery_date) as prev_order
  from baskets
)
select
  order_number,
  delivery_date,
  prev_order,
  cardinality(pids) as items,
  cardinality(array(select unnest(pids) intersect select unnest(prev_pids)))
    as shared,
  round(100.0
        * cardinality(array(select unnest(pids) intersect select unnest(prev_pids)))
        / cardinality(array(select unnest(pids) union     select unnest(prev_pids)))
        , 1) as jaccard_pct
from seq
where prev_pids is not null;
