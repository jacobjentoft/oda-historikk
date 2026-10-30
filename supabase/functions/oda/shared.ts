// Shared helpers for the Oda edge function.
// No third-party imports: this code handles OAuth tokens, so the dependency
// surface is kept at zero deliberately.

import { escapeHtml } from "./lib.ts";
export { pkceChallenge, randomToken } from "./lib.ts";

export const SB_URL = Deno.env.get("SUPABASE_URL")!;
export const SRK    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const ODA_AUTHORIZE = "https://oda.com/o/authorize/";
export const ODA_TOKEN     = "https://oda.com/o/token/";
export const ODA_REGISTER  = "https://oda.com/o/register/";
export const ODA_MCP       = "https://oda.com/mcp";
export const ODA_SCOPE     = "mcp";

export const REDIRECT_URI = `${SB_URL}/functions/v1/oda/auth/callback`;

const adminHeaders = {
  apikey: SRK,
  Authorization: `Bearer ${SRK}`,
  "Content-Type": "application/json",
};

/** PostgREST as the service role (bypasses RLS). */
export async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...adminHeaders, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`db ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Call a SECURITY DEFINER vault wrapper. Only service_role may execute these. */
export async function rpc(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const secretSet = (name: string, value: string) =>
  rpc("oda_secret_set", { p_name: name, p_value: value });

export const secretGet = (name: string): Promise<string | null> =>
  rpc("oda_secret_get", { p_name: name });

/**
 * Two separate checks: the JWT proves who the caller is, dashboard_users
 * decides whether that identity is permitted. Throws a Response on failure.
 */
export async function requireDashboardUser(req: Request): Promise<string> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw json({ error: "missing bearer token" }, 401);

  const who = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SRK, Authorization: auth },
  });
  if (!who.ok) throw json({ error: "invalid token" }, 401);

  const user = await who.json();
  const rows = await db(`dashboard_users?user_id=eq.${user.id}&select=user_id`);
  if (!rows?.length) throw json({ error: "not on the dashboard allowlist" }, 403);
  return user.id as string;
}

/** Register this function as an OAuth client on the Oda account. Runs once. */
export async function registerClient(): Promise<string> {
  const res = await fetch(ODA_REGISTER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Oda Historikk Dashboard",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client; PKCE is the proof
      scope: ODA_SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
  const reg = await res.json();
  if (reg.client_secret) await secretSet("oda_client_secret", reg.client_secret);
  return reg.client_id as string;
}

/**
 * Record a call that left this system for Oda.
 *
 * Failures are swallowed: a broken audit write must not break a read.
 * NOTE: when ordering is enabled this must become blocking for write tools --
 * a cart mutation that cannot be recorded should not be attempted.
 */
export async function audit(entry: {
  actor?: string | null;
  caller: string;
  tool: string;
  arguments?: unknown;
  ok: boolean;
  status_code?: number;
  error?: string | null;
  duration_ms?: number;
}): Promise<void> {
  try {
    await db("oda_audit_log", { method: "POST", body: JSON.stringify(entry) });
  } catch (e) {
    console.error("audit write failed", e);
  }
}

// Browsers block cross-origin calls unless the server opts in. Auth here is a
// bearer token, never a cookie, so a wildcard origin grants nothing on its own.
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

/** A tiny page for the OAuth callback. Both arguments are escaped: the body
 *  can carry text from Oda's redirect, which anyone can craft. */
export const html = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font:16px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`,
    { status, headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } },
  );
