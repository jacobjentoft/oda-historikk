-- Let normalize_raw_orders() work on a subset of orders.
--
-- Until now every sync re-derived every order: all lines deleted and
-- re-inserted, every product re-aggregated. The sync now passes the order
-- numbers it actually fetched; NULL (the default) still means "everything",
-- so a manual full rebuild is just `select public.normalize_raw_orders();`.

drop function if exists public.normalize_raw_orders();

create or replace function public.normalize_raw_orders(p_order_numbers text[] default null)
returns void
language plpgsql
set search_path = ''
as $fn$
declare
  v_orders   text[];
  v_products int[];
begin
  select coalesce(array_agg(r.order_number), '{}') into v_orders
  from public.raw_orders r
  where p_order_numbers is null or r.order_number = any (p_order_numbers);

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
  where r.order_number = any (v_orders)
  on conflict (order_number) do update set
    delivery_date   = excluded.delivery_date,
    slot_display    = excluded.slot_display,
    slot_weekday    = excluded.slot_weekday,
    slot_start_hour = excluded.slot_start_hour,
    currency        = excluded.currency,
    gross_amount    = excluded.gross_amount,
    ingested_at     = now();

  -- Product ids on these orders before the rewrite, so a product dropped from
  -- an order still has its counts recomputed below.
  select coalesce(array_agg(distinct l.product_id), '{}') into v_products
  from public.order_lines l
  where l.order_number = any (v_orders);

  delete from public.order_lines
  where order_number = any (v_orders);

  insert into public.order_lines (order_number, line_no, product_id, product_name,
                                  unit_price, quantity, line_total)
  select
    r.order_number,
    i.ord::int,
    (i.item->>'id')::int,
    i.item->>'n',
    (i.item->>'p')::numeric,
    (i.item->>'q')::numeric,
    (i.item->>'t')::numeric
  from public.raw_orders r,
       lateral jsonb_array_elements(r.payload->'products')
         with ordinality as i(item, ord)
  where r.order_number = any (v_orders);

  -- ...plus the product ids on them now.
  select coalesce(array_agg(distinct x), '{}') into v_products
  from unnest(v_products || array(
         select l.product_id from public.order_lines l
         where l.order_number = any (v_orders))) as x;

  update public.orders o
  set line_total = s.total
  from (select order_number, sum(line_total) as total
        from public.order_lines
        where order_number = any (v_orders)
        group by order_number) s
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
  where l.product_id = any (v_products)
  group by l.product_id
  on conflict (product_id) do update set
    latest_name = excluded.latest_name,
    first_seen  = excluded.first_seen,
    last_seen   = excluded.last_seen,
    order_count = excluded.order_count;
end;
$fn$;

revoke execute on function public.normalize_raw_orders(text[]) from public, anon, authenticated;
grant  execute on function public.normalize_raw_orders(text[]) to service_role;
