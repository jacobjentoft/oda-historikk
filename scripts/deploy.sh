#!/usr/bin/env bash
# Deploy migrations and the edge function to a Supabase project.
#
#   SUPABASE_PROJECT_REF=<ref> scripts/deploy.sh
#
# Needs the Supabase CLI, logged in (`supabase login`). The dashboard itself is
# static and deploys by pushing docs/ to GitHub Pages.
set -euo pipefail

ref="${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"
cd "$(dirname "$0")/.."

deno task lint
deno task check
deno task test

supabase link --project-ref "$ref"
supabase db push

supabase functions deploy oda --project-ref "$ref"   # verify_jwt = false comes from config.toml
