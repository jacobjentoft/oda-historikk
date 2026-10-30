-- Silence the function_search_path_mutable advisory on normalize_raw_orders.
--
-- With search_path = '' every object must be schema-qualified, so the function
-- cannot be redirected to a shadowing table planted in someone else's path.
-- Body is otherwise unchanged from 0004.

create or replace function public.normalize_raw_orders() returns void
language plpgsql
set search_path = ''
as $fn$
begin
  insert into public.orders (order_number, delivery_date, slot_display,
                             slot_weekday, slot_start_hour, currency, gross_amount)
  select
    r.order_number,
    (r.payload->>'deliveryDate')::date,
    r.payload->>'deliverySlotDisplay',
    split_part(r.payload->>'deliverySlotDisplay', ' ', 1),
    (substring(r.payload->>'deliverySlotDisplay' from '(\d{1,2}):\d{2}'))::int,
    coalesce(r.payload->>'currency', 'NOK'),
    (r.payload->>'grossAmount')::numeric
  from public.raw_orders r
  on conflict (order_number) do update set
    delivery_date   = excluded.delivery_date,
    slot_display    = excluded.slot_display,
    slot_weekday    = excluded.slot_weekday,
    slot_start_hour = excluded.slot_start_hour,
    currency        = excluded.currency,
    gross_amount    = excluded.gross_amount,
    ingested_at     = now();

  delete from public.order_lines
  where order_number in (select order_number from public.raw_orders);

  insert into public.order_lines (order_number, line_no, product_id, product_name,
                                  unit_price, quantity, line_total)
  select
    r.order_number,
    t.ord::int,
    (t.item->>'id')::int,
    t.item->>'n',
    (t.item->>'p')::numeric,
    (t.item->>'q')::numeric,
    (t.item->>'t')::numeric
  from public.raw_orders r,
       lateral jsonb_array_elements(r.payload->'products')
         with ordinality as t(item, ord);

  update public.orders o
  set line_total = s.total
  from (select order_number, sum(line_total) as total
        from public.order_lines group by order_number) s
  where s.order_number = o.order_number;

  insert into public.products (product_id, latest_name, first_seen, last_seen, order_count)
  select
    l.product_id,
    (array_agg(l.product_name order by o.delivery_date desc))[1],
    min(o.delivery_date),
    max(o.delivery_date),
    count(distinct l.order_number)
  from public.order_lines l
  join public.orders o using (order_number)
  group by l.product_id
  on conflict (product_id) do update set
    latest_name = excluded.latest_name,
    first_seen  = excluded.first_seen,
    last_seen   = excluded.last_seen,
    order_count = excluded.order_count;
end;
$fn$;

revoke execute on function public.normalize_raw_orders() from public, anon, authenticated;
