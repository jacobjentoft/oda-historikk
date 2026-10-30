// Pure helpers: no env, no network, no database. Kept apart from shared.ts so
// they can be unit-tested without a Supabase project.

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const randomToken = (bytes = 48): string =>
  b64url(crypto.getRandomValues(new Uint8Array(bytes)).buffer);

/** PKCE S256: send the hash now, prove possession of the original later. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(verifier),
  );
  return b64url(digest);
}

/**
 * Compare two secrets in time independent of where they differ.
 * Both sides are hashed first, so the loop always runs over 32 bytes and
 * the comparison leaks neither the position of a mismatch nor the length.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export const escapeHtml = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** Compact an Oda order into the staging shape normalize_raw_orders() expects. */
export function compact(o: any) {
  return {
    orderNumber: o.orderNumber,
    deliveryDate: o.deliveryDate,
    deliverySlotDisplay: o.deliverySlotDisplay,
    currency: o.currency ?? "NOK",
    grossAmount: o.grossAmount,
    products: (o.products ?? []).map((li: any) => ({
      id: li.product?.id,
      n:  li.product?.name,
      p:  Number(li.product?.price),
      q:  Number(li.quantity),
      t:  Number(li.totalGrossAmount),
    })),
  };
}

/**
 * An order whose delivery is this many days behind us is treated as final:
 * Oda will not change it again, so an incremental sync may stop at it.
 */
export const SETTLED_AFTER_DAYS = 14;

/** True when every order on the page is already stored and settled. */
export function pageIsSettled(
  orders: Array<{ orderNumber: string; deliveryDate?: string }>,
  known: Set<string>,
  now = Date.now(),
): boolean {
  if (!orders.length) return false;
  const cutoff = now - SETTLED_AFTER_DAYS * 86_400_000;
  return orders.every((o) =>
    known.has(o.orderNumber) &&
    o.deliveryDate != null && Date.parse(o.deliveryDate) < cutoff
  );
}
