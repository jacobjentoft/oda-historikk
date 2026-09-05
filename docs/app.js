import { indexLine, divergingBars, columns, hbars, nok, pct, hideTip } from "./charts.js";

const SB  = "https://ezjevbjejokpomwyrysp.supabase.co";
// Publishable key. Not a secret -- RLS is what protects the data, and an
// unlisted user sees zero rows even when signed in.
const KEY = "sb_publishable_LG5w-ftcR7uPUEA-S_SLkA_F-oTJfp4";

let token = null;
const $ = (id) => document.getElementById(id);

async function signIn() {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!password) { $("gateErr").textContent = "Skriv inn passordet."; return; }

  $("btnSignin").disabled = true;
  $("gateErr").textContent = "";
  try {
    const res = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || res.status);
    token = data.access_token;
    $("gate").hidden = true;
    $("app").hidden = false;
    await load();
  } catch (e) {
    $("gateErr").textContent = "Innlogging feilet: " + e.message;
  } finally {
    $("btnSignin").disabled = false;
  }
}

const headers = () => ({ apikey: KEY, Authorization: `Bearer ${token}` });

async function rest(path) {
  const res = await fetch(`${SB}/rest/v1/${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
async function rpc(fn) {
  const res = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { ...headers(), "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status}`);
  return res.json();
}

/** Build a table-view twin for a chart. Values are never tooltip-only. */
function table(host, rows, cols) {
  const t = document.createElement("table");
  const thead = t.createTHead().insertRow();
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c.h;
    if (c.n) th.className = "n";
    thead.appendChild(th);
  }
  const tb = t.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    for (const c of cols) {
      const td = tr.insertCell();
      td.textContent = c.v(r);
      if (c.n) td.className = "n";
    }
  }
  host.replaceChildren(t);
}

async function load() {
  const [stats, idx, move, spend, staples, baskets] = await Promise.all([
    rpc("oda_stats"),
    rest("v_inflation_index?select=month,index_value,products_priced&order=month.asc"),
    rest("v_price_movement?select=latest_name,buys,first_price,last_price,pct_change&order=pct_change.desc"),
    rest("v_spend_over_time?select=month,orders,spend,avg_order&order=month.asc"),
    rest("v_staples?select=latest_name,orders_with,pct_of_orders,total_spend&order=pct_of_orders.desc"),
    rest("v_basket_stats?select=order_number,delivery_date,gross_amount,net_discount,line_count,days_since_prev&order=delivery_date.asc"),
  ]);

  const last  = idx.at(-1), first = idx[0];
  const drift = last.index_value - first.index_value;
  const up    = move.filter((m) => m.pct_change > 0).length;
  const down  = move.filter((m) => m.pct_change < 0).length;
  const saved = baskets.reduce((a, b) => a + Number(b.net_discount ?? 0), 0);

  $("period").textContent =
    `${stats.orders} bestillinger · ${stats.first_order} til ${stats.last_order}`;

  $("kpis").innerHTML = `
    <div class="kpi hero">
      <div class="k">Personlig prisvekst</div>
      <div class="v" style="color:var(--${drift >= 0 ? "pole-up" : "good"})">${pct(drift)}</div>
      <div class="s">over ${idx.length} måneder</div>
    </div>
    <div class="kpi"><div class="k">Totalt forbruk</div>
      <div class="v">${nok(stats.total_spend)}</div><div class="s">kroner</div></div>
    <div class="kpi"><div class="k">Snitt per bestilling</div>
      <div class="v">${nok(stats.total_spend / stats.orders)}</div><div class="s">kroner</div></div>
    <div class="kpi"><div class="k">Netto rabatt</div>
      <div class="v" style="color:var(--${saved >= 0 ? "good" : "pole-up"})">${nok(saved)}</div>
      <div class="s">kroner, netto mot gebyr</div></div>
    <div class="kpi"><div class="k">Varer i kurven</div>
      <div class="v">${move.length}</div>
      <div class="s">${up} opp · ${down} ned</div></div>`;

  indexLine($("c-index"), idx);
  table($("t-index"), idx, [
    { h: "Måned", v: (r) => r.month.slice(0, 7) },
    { h: "Indeks", n: 1, v: (r) => r.index_value },
    { h: "Varer priset", n: 1, v: (r) => r.products_priced },
  ]);

  divergingBars($("c-move"), move, {
    value: (r) => Number(r.pct_change),
    label: (r) => r.latest_name,
    fmt:   (r) => `${pct(Number(r.pct_change))} (${r.first_price} → ${r.last_price} kr, ${r.buys} kjøp)`,
    short: (r) => `${pct(Number(r.pct_change))} ${r.latest_name.split(",")[0]}`,
    polarity: "up-bad",                    // a price rise is the bad direction
    ends: ["billigere", "dyrere"],
  });
  table($("t-move"), move, [
    { h: "Vare", v: (r) => r.latest_name },
    { h: "Kjøp", n: 1, v: (r) => r.buys },
    { h: "Først", n: 1, v: (r) => r.first_price },
    { h: "Sist", n: 1, v: (r) => r.last_price },
    { h: "Endring", n: 1, v: (r) => pct(Number(r.pct_change)) },
  ]);

  columns($("c-spend"), spend, {
    value: (r) => Number(r.spend),
    label: (r) => r.month.slice(2, 7),
    fmt:   (r) => `${nok(r.spend)} kr · ${r.orders} bestillinger · snitt ${nok(r.avg_order)} kr`,
  });
  table($("t-spend"), spend, [
    { h: "Måned", v: (r) => r.month.slice(0, 7) },
    { h: "Bestillinger", n: 1, v: (r) => r.orders },
    { h: "Forbruk", n: 1, v: (r) => nok(r.spend) },
    { h: "Snitt", n: 1, v: (r) => nok(r.avg_order) },
  ]);

  hbars($("c-staples"), staples, {
    value: (r) => Number(r.pct_of_orders),
    label: (r) => r.latest_name,
    fmt:   (r) => `${r.pct_of_orders} % · ${nok(r.total_spend)} kr`,
  });
  table($("t-staples"), staples, [
    { h: "Vare", v: (r) => r.latest_name },
    { h: "I bestillinger", n: 1, v: (r) => r.orders_with },
    { h: "Andel", n: 1, v: (r) => r.pct_of_orders + " %" },
    { h: "Sum", n: 1, v: (r) => nok(r.total_spend) },
  ]);

  const disc = baskets.filter((b) => b.net_discount != null);
  divergingBars($("c-disc"), disc, {
    value: (r) => Number(r.net_discount),
    label: (r) => r.delivery_date,
    fmt:   (r) => `${nok(r.net_discount)} kr · ordre ${nok(r.gross_amount)} kr`,
    short: (r) => `${nok(r.net_discount)} kr`,
    polarity: "up-good",                   // a saving is the good direction
    ends: ["betalte over", "spart"],
    labelTop: 2, barH: 8, gap: 3,
  });
  table($("t-disc"), disc, [
    { h: "Dato", v: (r) => r.delivery_date },
    { h: "Ordre", n: 1, v: (r) => nok(r.gross_amount) },
    { h: "Netto rabatt", n: 1, v: (r) => nok(r.net_discount) },
    { h: "Varelinjer", n: 1, v: (r) => r.line_count },
  ]);
}

// Table-view toggles.
document.addEventListener("click", (e) => {
  const b = e.target.closest(".toggle");
  if (!b) return;
  const chart = $(b.dataset.for);
  const tbl   = $("t-" + b.dataset.for.slice(2));
  const showTable = !chart.hidden;
  chart.hidden = showTable;
  tbl.hidden   = !showTable;
  b.textContent = showTable ? "Graf" : "Tabell";
  hideTip();
});

$("btnSignin").addEventListener("click", signIn);
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });
