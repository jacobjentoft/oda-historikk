# Oda Historikk

A personal analytics dashboard over my own Oda grocery orders, whose centrepiece
is a **personal inflation index** — a fixed-basket price index of the goods this
household actually buys.

## What it does

Roughly 15 months of order history is synced nightly into Postgres and turned
into views: spend over time, order cadence, staples, per-product price history,
an overpay tracker, and the index itself.

The interesting result so far: the index is **flat (+0.7 %)** while individual
products moved between **−36 % and +37 %**. Prices swung hard and cancelled out.

## Architecture

```
Browser (static HTML, Supabase Auth)
  ├─ reads v_* views straight from Postgres, gated by RLS
  └─ calls an Edge Function for anything touching Oda
                   │
        Edge Function (Deno)  — Oda OAuth tokens in supabase_vault
                   │
             https://oda.com/mcp
```

`oda.com` sends no CORS headers, so a browser can never call it directly — the
Edge Function is required, not a convenience. It authenticates to Oda as its own
OAuth client (PKCE, dynamic registration), independent of any local tooling.

## Security notes

- The publishable Supabase key is in `docs/` and is **not a secret**. Access is
  an allowlist: `dashboard_users` + `private.is_dashboard_user()`. Someone who
  signs up to the project sees zero rows.
- All views are `security_invoker = on`. Without it a view runs as its owner and
  silently bypasses every RLS policy.
- Oda access and refresh tokens live in Vault and never reach the browser.
- The MCP proxy is deny-by-default: read tools only. Cart and delivery-slot
  tools return 403. Ordering is not enabled.

## Layout

```
docs/                     the dashboard (GitHub Pages source)
supabase/migrations/      schema, views, RLS, scheduling -- named <live version>_<name>.sql
supabase/notes/           SQL considered and deliberately not applied
supabase/functions/oda    one Edge Function, routed by path
supabase/functions/tests  Deno unit tests for the function's pure helpers
scripts/deploy.sh         lint, test, push migrations, deploy the function
```

## Setting up a new project

1. Create a Supabase project and point `SB` / `KEY` in `docs/app.js` and
   `docs/connect.html` at it (URL + publishable key).
2. Store the project URL in Vault, which the daily sync job reads:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
   ```
3. Deploy: `SUPABASE_PROJECT_REF=<ref> scripts/deploy.sh`
4. Create your user in Supabase Auth, then put it on the allowlist:
   ```sql
   insert into dashboard_users (user_id, email)
   select id, email from auth.users where email = '<you>';
   ```
5. Open `connect.html`, sign in, and connect Oda. Then run a first sync
   (`POST /functions/v1/oda/sync` with your bearer token).

## Sync

The nightly job is incremental: Oda lists orders newest first, and the sweep
stops at the first page whose orders are all stored already and delivered more
than 14 days ago. Only fetched orders are re-normalised. Send `{"full": true}`
to walk every page. A sweep that hits the 50-page cap stores what it saw and is
logged in `oda_audit_log` as not ok.

## Inflation basket

The basket is fixed on purpose, so the index compares like with like. Its rules
live in `inflation_settings` (first-purchase cutoff, minimum number of buys).
Moving the cutoff re-bases the whole index; it is an `UPDATE`, not a migration.

## Development

```bash
python3 -m http.server 8082 --directory docs   # dashboard
deno task lint && deno task check && deno task test
```

CI runs the same Deno tasks and applies every migration to a throwaway local
Supabase stack.
