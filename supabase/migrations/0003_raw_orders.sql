-- Raw landing table for Oda's get_orders payloads.
--
-- Orders arrive as JSON from an MCP tool that only exists inside a Claude
-- session. Landing the payload verbatim means the normalisation below can be
-- re-run and corrected without re-fetching anything from Oda.

create table if not exists raw_orders (
  order_number text primary key,
  payload      jsonb not null,
  fetched_at   timestamptz not null default now()
);

alter table raw_orders enable row level security;
