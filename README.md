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
docs/                  the dashboard (GitHub Pages source)
supabase/migrations/   schema, views, RLS, scheduling
supabase/functions/oda one Edge Function, routed by path
```

## Local development

```bash
python3 -m http.server 8082 --directory docs
```
