import {
  assert, assertEquals, assertFalse, assertMatch, assertNotEquals,
} from "@std/assert";
import {
  compact, escapeHtml, pageIsSettled, pkceChallenge, randomToken,
  SETTLED_AFTER_DAYS, timingSafeEqual,
} from "../oda/lib.ts";

Deno.test("pkceChallenge matches the RFC 7636 appendix B vector", async () => {
  assertEquals(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

Deno.test("randomToken is url-safe and unique", () => {
  const a = randomToken(), b = randomToken();
  assertMatch(a, /^[A-Za-z0-9_-]+$/);
  assertEquals(a.length, 64); // 48 bytes -> 64 base64 chars, no padding
  assertNotEquals(a, b);
});

Deno.test("timingSafeEqual", async () => {
  assert(await timingSafeEqual("abc123", "abc123"));
  assertFalse(await timingSafeEqual("abc123", "abc124"));
  assertFalse(await timingSafeEqual("abc123", "abc1234"));
  assertFalse(await timingSafeEqual("", "x"));
});

Deno.test("escapeHtml neutralises markup", () => {
  assertEquals(
    escapeHtml(`<img src=x onerror="alert('1')">&`),
    "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;",
  );
  assertEquals(escapeHtml("Melk, 1 l"), "Melk, 1 l");
});

Deno.test("compact keeps the fields normalize_raw_orders reads", () => {
  const out = compact({
    orderNumber: "123", deliveryDate: "2026-01-02",
    deliverySlotDisplay: "Fre 2. jan 16:00 - 21:00", grossAmount: "512.30",
    products: [{
      product: { id: 42, name: "Melk", price: "21.90" },
      quantity: "2", totalGrossAmount: "43.80",
    }],
  });
  assertEquals(out.currency, "NOK");
  assertEquals(out.products, [{ id: 42, n: "Melk", p: 21.9, q: 2, t: 43.8 }]);
});

Deno.test("pageIsSettled", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const old = "2026-09-01";
  const recent = new Date(now - (SETTLED_AFTER_DAYS - 1) * 86_400_000)
    .toISOString().slice(0, 10);
  const known = new Set(["a", "b", "c"]);

  assert(pageIsSettled([{ orderNumber: "a", deliveryDate: old },
                        { orderNumber: "b", deliveryDate: old }], known, now));
  // An unseen order means there may be more new ones further down.
  assertFalse(pageIsSettled([{ orderNumber: "a", deliveryDate: old },
                             { orderNumber: "z", deliveryDate: old }], known, now));
  // A recent order may still change, so keep going.
  assertFalse(pageIsSettled([{ orderNumber: "c", deliveryDate: recent }], known, now));
  assertFalse(pageIsSettled([], known, now));
});
