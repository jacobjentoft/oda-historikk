// Single edge function fronting Oda, routed by path.
//
//   GET  /oda/status         authenticated  -> connection state
//   GET  /oda/auth/start     authenticated  -> authorize_url (registers once)
//   GET  /oda/auth/callback  public          -> protected by `state`
//   POST /oda/mcp/call       authenticated  -> allowlisted read tools only
//   POST /oda/sync           authenticated or scheduled -> order sweep
//                            (incremental; body {"full": true} for all pages)
//
// verify_jwt = false because Oda redirects a bare browser to the callback.
// Every other route authenticates explicitly in code.

import {
  ODA_AUTHORIZE, ODA_SCOPE, ODA_TOKEN, REDIRECT_URI,
  audit, cors, db, html, json, pkceChallenge, randomToken, registerClient,
  requireDashboardUser, rpc, secretGet, secretSet,
} from "./shared.ts";
import { Mcp } from "./mcp.ts";
import { compact, pageIsSettled, timingSafeEqual } from "./lib.ts";

// ---------------------------------------------------------------------------
// Tool policy. Deny by default: anything not named here is refused.
// ---------------------------------------------------------------------------
const READ_TOOLS = new Set([
  "product_search", "get_category", "get_brand", "similar_and_related_products",
  "get_orders", "get_order", "order_tracking",
  "get_delivery_addresses", "get_delivery_slots",
  "recipe_search", "get_liked_recipes", "get_purchased_recipes",
  "get_product_lists", "get_product_list", "get_dinner_lists",
  "likely_to_buy", "unique_for_you", "get_cart",
]);

// Named only so the refusal can say *why*. Blocking does not depend on this
// list -- an unknown tool is refused too.
const WRITE_TOOLS = new Set([
  "manipulate_cart", "clear_cart", "select_delivery_slot",
  "create_product_list", "manipulate_product_list", "delete_product_list",
  "feedback",
]);

// ---------------------------------------------------------------------------

async function authStart(req: Request): Promise<Response> {
  await requireDashboardUser(req);

  const existing = await db("oda_credentials?id=eq.1&select=client_id");
  let clientId: string | undefined = existing?.[0]?.client_id ?? undefined;
  let registered = false;

  if (!clientId) {
    clientId = await registerClient();
    registered = true;
    await db("oda_credentials?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: 1, client_id: clientId, scope: ODA_SCOPE }),
    });
  }

  const verifier  = randomToken();
  const challenge = await pkceChallenge(verifier);
  const state     = randomToken(24);

  await db("oda_auth_states", {
    method: "POST",
    body: JSON.stringify({ state, code_verifier: verifier }),
  });

  const url = new URL(ODA_AUTHORIZE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId!);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", ODA_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return json({ authorize_url: url.toString(), client_id: clientId, newly_registered: registered });
}

async function authCallback(url: URL): Promise<Response> {
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err   = url.searchParams.get("error");

  if (err)             return html("Not connected", `Oda returned: ${err}`, 400);
  if (!code || !state) return html("Not connected", "Missing code or state.", 400);

  // Claim the state in one statement. A separate read-then-mark would let two
  // concurrent callbacks both see it unconsumed; a filtered PATCH can match
  // only once, so exactly one of them gets the verifier back.
  const now  = new Date().toISOString();
  const rows = await db(
    `oda_auth_states?state=eq.${encodeURIComponent(state)}` +
    `&consumed_at=is.null&expires_at=gt.${now}&select=code_verifier`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ consumed_at: now }),
    },
  );
  if (!rows?.length) return html("Not connected", "That link is expired or already used.", 400);

  const cred     = await db("oda_credentials?id=eq.1&select=client_id");
  const clientId = cred?.[0]?.client_id;
  if (!clientId) return html("Not connected", "No client registered.", 400);

  const tok = await fetch(ODA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code,
      redirect_uri: REDIRECT_URI, client_id: clientId,
      code_verifier: rows[0].code_verifier,
    }),
  });
  if (!tok.ok) return html("Not connected", `Token exchange failed: ${tok.status}`, 400);

  const t = await tok.json();
  await secretSet("oda_access_token", t.access_token);
  if (t.refresh_token) await secretSet("oda_refresh_token", t.refresh_token);

  await db("oda_credentials?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id: 1, client_id: clientId, scope: t.scope ?? ODA_SCOPE,
      token_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
      connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }),
  });

  return html("Connected to Oda", "You can close this tab and return to the dashboard.");
}

async function status(req: Request): Promise<Response> {
  await requireDashboardUser(req);
  const rows = await db(
    "oda_credentials?id=eq.1&select=client_id,scope,connected_at,token_expires_at",
  );
  const c = rows?.[0];
  return json({
    connected: Boolean(c?.connected_at),
    client_registered: Boolean(c?.client_id),
    connected_at: c?.connected_at ?? null,
    token_expires_at: c?.token_expires_at ?? null,
    read_tools: [...READ_TOOLS].sort(),
    write_tools_blocked: [...WRITE_TOOLS].sort(),
    redirect_uri: REDIRECT_URI,
  });
}

/** Proxy a single MCP tool call. Read tools only. */
async function mcpCall(req: Request): Promise<Response> {
  const actor = await requireDashboardUser(req);
  const started = Date.now();

  const body = await req.json().catch(() => ({}));
  const tool = String(body?.tool ?? "");
  const args = (body?.arguments ?? {}) as Record<string, unknown>;

  if (!tool) return json({ error: "missing 'tool'" }, 400);

  // Refusals are audited too -- an attempted write is exactly what you want
  // a record of, whether or not it succeeded.
  if (!READ_TOOLS.has(tool)) {
    const reason = WRITE_TOOLS.has(tool)
      ? "this tool writes to the Oda account; ordering is not enabled yet"
      : "unknown tool; the proxy allows read tools only";
    await audit({ actor, caller: "user", tool, arguments: args, ok: false,
                  status_code: 403, error: reason,
                  duration_ms: Date.now() - started });
    return json({ error: "tool not permitted", tool, reason }, 403);
  }

  const mcp = await Mcp.open();
  try {
    const result = await mcp.callTool(tool, args);
    await audit({ actor, caller: "user", tool, arguments: args, ok: true,
                  status_code: 200, duration_ms: Date.now() - started });
    return json({ tool, result });
  } catch (e) {
    await audit({ actor, caller: "user", tool, arguments: args, ok: false,
                  status_code: 502, error: String(e),
                  duration_ms: Date.now() - started });
    throw e;
  } finally {
    await mcp.close();
  }
}

/** Either a signed-in dashboard user, or the scheduled caller holding the sync key. */
async function requireSyncCaller(req: Request): Promise<string> {
  const provided = req.headers.get("x-sync-key");
  if (provided) {
    const expected = await secretGet("oda_sync_key");
    if (expected && await timingSafeEqual(provided, expected)) return "scheduled";
    throw json({ error: "bad sync key" }, 401);
  }
  return await requireDashboardUser(req);
}

const PAGE_SIZE = 20;
const MAX_PAGES = 50;

/**
 * Order sweep. Idempotent: upsert by order_number, then re-normalise only the
 * orders fetched. Oda lists newest first, so an incremental run stops at the
 * first page made up entirely of orders already stored and long delivered.
 */
async function sync(req: Request): Promise<Response> {
  const caller = await requireSyncCaller(req);
  const started = Date.now();

  const body = await req.json().catch(() => ({}));
  const full = body?.full === true;

  const known = new Set<string>(
    full ? [] : (await db("raw_orders?select=order_number"))
      .map((r: { order_number: string }) => r.order_number),
  );

  const mcp = await Mcp.open();
  try {
    const rows: Array<{ order_number: string; payload: unknown; fetched_at: string }> = [];
    const now = new Date().toISOString();
    let pages = 0;
    let truncated = false;

    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) { truncated = true; break; }
      const r = await mcp.callTool("get_orders", { page, size: PAGE_SIZE });
      const orders = r?.orders ?? [];
      pages = page;
      for (const o of orders) {
        rows.push({ order_number: o.orderNumber, payload: compact(o), fetched_at: now });
      }
      if (!r?.hasMore || orders.length === 0) break;
      if (!full && pageIsSettled(orders, known)) break;
    }

    if (rows.length) {
      await db("raw_orders?on_conflict=order_number", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(rows),
      });
      await rpc("normalize_raw_orders", {
        p_order_numbers: rows.map((r) => r.order_number),
      });
    }

    const stats = await rpc("oda_stats", {});
    await audit({
      caller, tool: "get_orders(sweep)",
      arguments: { full, pages, size: PAGE_SIZE },
      // A sweep that hit the page cap still stored what it saw, but older
      // orders were skipped -- record that rather than report a clean run.
      ok: !truncated, status_code: 200,
      error: truncated ? `stopped at ${MAX_PAGES} pages; older orders not fetched` : null,
      duration_ms: Date.now() - started,
    });
    return json({
      ok: true, caller, full, pages, truncated, orders_seen: rows.length,
      ms: Date.now() - started, stats,
    });
  } catch (e) {
    await audit({
      caller, tool: "get_orders(sweep)", ok: false, status_code: 502,
      error: String(e), duration_ms: Date.now() - started,
    });
    throw e;
  } finally {
    await mcp.close();
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url  = new URL(req.url);
    const path = url.pathname.replace(/^\/oda/, "").replace(/\/+$/, "") || "/";

    switch (path) {
      case "/auth/start":    return await authStart(req);
      case "/auth/callback": return await authCallback(url);
      case "/status":        return await status(req);
      case "/mcp/call":      return await mcpCall(req);
      case "/sync":          return await sync(req);
      default:               return json({ error: "not found", path }, 404);
    }
  } catch (e) {
    if (e instanceof Response) return e;
    return json({ error: String(e) }, 500);
  }
});
