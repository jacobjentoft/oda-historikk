-- Normalise raw_orders -> orders + order_lines + products.
-- Idempotent: safe to run after every page of the sweep, and again afterwards.

create or replace function normalize_raw_orders() returns void
language plpgsql as $fn$
begin
  -- Orders: upsert. slot_display "Tir 1. sep 16:00 - 21:00" is parsed here --
  -- the weekday is the first token, the start hour is the first HH:MM in the
  -- string (the "1." can't match, since it isn't followed by a colon).
  insert into orders (order_number, delivery_date, slot_display,
                      slot_weekday, slot_start_hour, currency, gross_amount)
  select
    r.order_number,
    (r.payload->>'deliveryDate')::date,
    r.payload->>'deliverySlotDisplay',
    split_part(r.payload->>'deliverySlotDisplay', ' ', 1),
    (substring(r.payload->>'deliverySlotDisplay' from '(\d{1,2}):\d{2}'))::int,
    coalesce(r.payload->>'currency', 'NOK'),
    (r.payload->>'grossAmount')::numeric
  from raw_orders r
  on conflict (order_number) do update set
    delivery_date   = excluded.delivery_date,
    slot_display    = excluded.slot_display,
    slot_weekday    = excluded.slot_weekday,
    slot_start_hour = excluded.slot_start_hour,
    currency        = excluded.currency,
    gross_amount    = excluded.gross_amount,
    ingested_at     = now();

  -- Lines: delete-then-insert, because the SET of lines can change between
  -- runs and upserting would leave stale rows behind.
  delete from order_lines
  where order_number in (select order_number from raw_orders);

  -- WITH ORDINALITY supplies line_no, which is what lets the same product
  -- appear twice in one order (weight-priced items).
  insert into order_lines (order_number, line_no, product_id, product_name,
                           unit_price, quantity, line_total)
  select
    r.order_number,
    t.ord::int,
    (t.item->>'id')::int,
    t.item->>'n',
    (t.item->>'p')::numeric,
    (t.item->>'q')::numeric,
    (t.item->>'t')::numeric
  from raw_orders r,
       lateral jsonb_array_elements(r.payload->'products')
         with ordinality as t(item, ord);

  -- line_total sums across OTHER rows, so it can't be a generated column.
  -- Once set, fees_delta (gross_amount - line_total) computes itself.
  update orders o
  set line_total = s.total
  from (select order_number, sum(line_total) as total
        from order_lines group by order_number) s
  where s.order_number = o.order_number;

  -- products is a derived dimension: rebuilt from order_lines, never fetched.
  insert into products (product_id, latest_name, first_seen, last_seen, order_count)
  select
    l.product_id,
    (array_agg(l.product_name order by o.delivery_date desc))[1],
    min(o.delivery_date),
    max(o.delivery_date),
    count(distinct l.order_number)
  from order_lines l
  join orders o using (order_number)
  group by l.product_id
  on conflict (product_id) do update set
    latest_name = excluded.latest_name,
    first_seen  = excluded.first_seen,
    last_seen   = excluded.last_seen,
    order_count = excluded.order_count;
end;
$fn$;
