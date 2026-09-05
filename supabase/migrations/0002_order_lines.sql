-- Oda Historikk — order line items
-- One row per line on an order.

create table if not exists order_lines (
  -- Cascade: deleting an order should take its lines with it, so a re-ingest
  -- can wipe an order and rebuild it without leaving orphaned rows behind.
  order_number  text not null references orders(order_number) on delete cascade,

  -- Position within the order. This exists so the same product can appear
  -- twice on one order: order 2ns7xr holds product 59489 at both 67.72 and
  -- 83.11, because pork tenderloin is priced by actual weight.
  line_no       int  not null,

  product_id    int  not null,
  product_name  text not null,          -- the name as sold that day
  unit_price    numeric(10,2) not null,
  quantity      numeric(10,3) not null,
  line_total    numeric(10,2) not null,

  -- (order_number, product_id) would reject the weight-priced duplicate above.
  primary key (order_number, line_no)
);

-- Price history and product frequency both scan by product, so this one
-- index is worth having up front.
create index if not exists order_lines_product_id_idx on order_lines (product_id);

alter table order_lines enable row level security;
