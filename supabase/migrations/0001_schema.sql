-- Oda Historikk — core schema
-- Tier 1 scope: everything derivable from get_orders alone.

-- One row per delivered order.
create table if not exists orders (
  order_number    text primary key,
  delivery_date   date not null,
  slot_display    text,                        -- raw, e.g. "Tir 1. sep 16:00 - 21:00"
  slot_weekday    text,                        -- parsed in ingest
  slot_start_hour int check (slot_start_hour between 0 and 23),
  currency        text not null default 'NOK',

  -- gross_amount is Oda's order total and includes fees/pant.
  -- line_total is the sum of order_lines, maintained by ingest: a generated
  -- column cannot reach across rows into another table.
  gross_amount    numeric(10,2) not null,
  line_total      numeric(10,2),

  -- Generated: one definition of "fees", enforced by the database.
  fees_delta      numeric(10,2) generated always as (gross_amount - line_total) stored,

  ingested_at     timestamptz not null default now()
);

create index if not exists orders_delivery_date_idx on orders (delivery_date);

-- Derived from order history, never fetched from Oda.
-- product_id is the only stable key; names drift ("8 pc." vs "8 stk").
create table if not exists products (
  product_id   integer primary key,
  latest_name  text not null,
  first_seen   date,
  last_seen    date,
  order_count  integer not null default 0
);

-- RLS on, deliberately with NO permissive policy yet: deny by default.
-- The frontend's publishable key is not a secret, so the policy is the lock.
-- How reads are granted (Supabase Auth login vs. a read-only anon policy)
-- is a Phase 4 decision -- see the note in the plan.
alter table orders   enable row level security;
alter table products enable row level security;
