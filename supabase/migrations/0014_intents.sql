-- Phase 4d: the schema ordering will need. Created now so that enabling
-- ordering later is additive rather than a redesign.

create type order_intent_status as enum (
  'draft', 'submitted', 'claimed', 'executed', 'failed', 'cancelled'
);

-- A proposed order. Composed by a human, executed by the server.
create table if not exists order_intents (
  id             uuid primary key default gen_random_uuid(),
  created_by     uuid not null references auth.users(id) on delete cascade,
  status         order_intent_status not null default 'draft',

  items          jsonb not null default '[]'::jsonb,  -- [{product_id, quantity, note}]
  delivery_slot  jsonb,
  note           text,

  created_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  claimed_at     timestamptz,
  completed_at   timestamptz,

  oda_order_number text,
  error            text,
  updated_at       timestamptz not null default now()
);

create index if not exists order_intents_status_idx on order_intents (status, created_at desc);

-- Every call that leaves this system for Oda. Insert-only from the server;
-- readable by the dashboard so the history is visible, never editable.
create table if not exists oda_audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,                 -- auth user, null when scheduled
  caller      text not null,        -- 'user' | 'scheduled'
  tool        text not null,
  arguments   jsonb,
  ok          boolean not null,
  status_code int,
  error       text,
  duration_ms int,
  intent_id   uuid references order_intents(id) on delete set null
);

create index if not exists oda_audit_log_at_idx   on oda_audit_log (at desc);
create index if not exists oda_audit_log_tool_idx on oda_audit_log (tool, at desc);

-- The lifecycle is enforced here, not in application code. An illegal move
-- raises rather than quietly writing a state nothing else expects.
create or replace function private.enforce_intent_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'order intents must start as draft, got %', new.status;
    end if;
    return new;
  end if;

  if old.status = new.status then
    new.updated_at := now();
    return new;
  end if;

  allowed := case old.status
    when 'draft'     then new.status in ('submitted', 'cancelled')
    when 'submitted' then new.status in ('claimed', 'cancelled')
    when 'claimed'   then new.status in ('executed', 'failed')
    when 'failed'    then new.status in ('draft', 'cancelled')
    else false                       -- executed and cancelled are terminal
  end;

  if not allowed then
    raise exception 'illegal order intent transition: % -> %', old.status, new.status;
  end if;

  -- Stamp the moment each state was entered, so the trail is not guesswork.
  if new.status = 'submitted' then new.submitted_at := now(); end if;
  if new.status = 'claimed'   then new.claimed_at   := now(); end if;
  if new.status in ('executed', 'failed', 'cancelled')
    then new.completed_at := now(); end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists order_intents_transition on order_intents;
create trigger order_intents_transition
  before insert or update on order_intents
  for each row execute function private.enforce_intent_transition();

alter table order_intents enable row level security;
alter table oda_audit_log enable row level security;

-- A human may compose, submit and cancel. Nothing further.
create policy intents_read on order_intents
  for select to authenticated
  using ((select private.is_dashboard_user()));

create policy intents_insert on order_intents
  for insert to authenticated
  with check ((select private.is_dashboard_user())
              and created_by = (select auth.uid())
              and status = 'draft');

create policy intents_update on order_intents
  for update to authenticated
  using ((select private.is_dashboard_user()) and status in ('draft', 'failed'))
  with check ((select private.is_dashboard_user())
              and status in ('draft', 'submitted', 'cancelled'));

-- claimed / executed / failed are reachable only by the service role, which
-- bypasses RLS. The browser cannot fabricate a completed order.

create policy audit_read on oda_audit_log
  for select to authenticated
  using ((select private.is_dashboard_user()));
-- No insert policy: only the service role writes here.
