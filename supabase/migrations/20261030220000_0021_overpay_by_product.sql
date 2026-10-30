-- v_overpay summed per product, for the dashboard.
--
-- v_overpay has one row per order line (684 today) and grows with every
-- order; PostgREST returns at most 1000 rows, so the browser cannot be left
-- to aggregate it. One row per product stays far below that.

create or replace view v_overpay_by_product
with (security_invoker = on) as
select
  o.product_id,
  p.latest_name,
  count(*)                 as lines_over,  -- lines paid above the best price
  round(sum(o.overpaid), 2) as overpaid,
  min(o.best_price)        as best_price,
  max(o.unit_price)        as worst_price
from v_overpay o
join products p using (product_id)
group by o.product_id, p.latest_name;
