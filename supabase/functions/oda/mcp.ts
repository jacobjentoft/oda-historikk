// Minimal MCP (Streamable HTTP) client, plus Oda token lifecycle.
//
// Two things this has to cope with that a plain REST client would not:
//   1. MCP is a session protocol -- initialize, then an initialized
//      notification, then tool calls, all carrying an Mcp-Session-Id.
//   2. Responses come back as JSON *or* as an SSE stream, server's choice.

import {
  ODA_MCP, ODA_TOKEN, db, secretGet, secretSet,
} from "./shared.ts";

/** Exchange the refresh token for a fresh access token and persist both. */
export async function refreshAccessToken(): Promise<string> {
  const refresh = await secretGet("oda_refresh_token");
  if (!refresh) throw new Error("no refresh token stored -- reconnect Oda");

  const cred = await db("oda_credentials?id=eq.1&select=client_id");
  const clientId = cred?.[0]?.client_id;
  if (!clientId) throw new Error("no client registered");

  const res = await fetch(ODA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    }),
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${await res.text()}`);

  const t = await res.json();
  await secretSet("oda_access_token", t.access_token);
  // Oda rotates the refresh token on use; storing the new one is mandatory.
  if (t.refresh_token) await secretSet("oda_refresh_token", t.refresh_token);

  await db("oda_credentials?id=eq.1", {
    method: "PATCH",
    body: JSON.stringify({
      token_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  return t.access_token as string;
}

/** Current access token, refreshed if it expires within a minute. */
export async function getAccessToken(force = false): Promise<string> {
  if (!force) {
    const cred = await db("oda_credentials?id=eq.1&select=token_expires_at");
    const exp = cred?.[0]?.token_expires_at ? Date.parse(cred[0].token_expires_at) : 0;
    if (exp - Date.now() > 60_000) {
      const tok = await secretGet("oda_access_token");
      if (tok) return tok;
    }
  }
  return await refreshAccessToken();
}

/** An MCP response is either JSON or SSE; normalise both to an object. */
async function parseMcp(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (!body) return null;
  if (ct.includes("text/event-stream")) {
    const data = body.split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    if (!data.length) throw new Error("empty SSE response");
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(body);
}

export class Mcp {
  private sessionId?: string;
  private nextId = 1;
  private constructor(private token: string) {}

  /** Open a session. One handshake, then many tool calls. */
  static async open(): Promise<Mcp> {
    const m = new Mcp(await getAccessToken());
    await m.handshake();
    return m;
  }

  private headers(): HeadersInit {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  private async post(payload: unknown): Promise<Response> {
    let res = await fetch(ODA_MCP, {
      method: "POST", headers: this.headers(), body: JSON.stringify(payload),
    });
    // One retry on 401: the stored token may have been revoked early.
    if (res.status === 401) {
      this.token = await getAccessToken(true);
      res = await fetch(ODA_MCP, {
        method: "POST", headers: this.headers(), body: JSON.stringify(payload),
      });
    }
    return res;
  }

  private async handshake(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0", id: this.nextId++, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oda-historikk", version: "1.0" },
      },
    });
    if (!res.ok) throw new Error(`initialize: ${res.status} ${await res.text()}`);

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    await parseMcp(res); // drain

    // Notifications carry no id and expect no result.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const res = await this.post({
      jsonrpc: "2.0", id: this.nextId++, method: "tools/call",
      params: { name, arguments: args },
    });
    if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);

    const msg = await parseMcp(res);
    if (msg?.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);

    const result = msg?.result;
    if (result?.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);

    // Prefer structured output; otherwise the text block is usually JSON.
    if (result?.structuredContent) return result.structuredContent;
    const text = result?.content?.find((c: any) => c.type === "text")?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text); } catch { return text; }
    }
    return result;
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(ODA_MCP, { method: "DELETE", headers: this.headers() });
    } catch { /* closing is best-effort */ }
  }
}
