import {
  indexLine, divergingBars, columns, hbars, priceSteps, nok, pct, hideTip,
} from "./charts.js";

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
    rest("v_price_movement?select=product_id,latest_name,buys,first_price,last_price,pct_change&order=pct_change.desc"),
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

  // The sections below load independently: one failing view empties its own
  // card instead of taking the whole dashboard down with it.
  await Promise.all([
    section("c-hist", () => priceHistory(move)),
    section("c-overpay", async () => overpaid(await rest(
      "v_overpay_by_product?select=product_id,latest_name,lines_over,overpaid,best_price,worst_price&order=overpaid.desc"))),
    section("c-cadence", async () => cadenceChart(await rest(
      "v_cadence?select=days,orders&order=days.asc"))),
    section("c-sim", async () => similarity(await rest(
      "v_basket_similarity?select=order_number,delivery_date,items,shared,jaccard_pct&order=delivery_date.asc"))),
  ]);
}

async function section(chartId, render) {
  try {
    await render();
  } catch (e) {
    console.error(chartId, e);
    $(chartId).textContent = "Kunne ikke laste denne delen.";
  }
}

/* Price history: one product at a time. v_price_history has a row per order
   line -- more than PostgREST's 1000-row page -- so it is fetched per product. */
function priceHistory(move) {
  const pick = $("pick");
  const byName = [...move].sort((a, b) => a.latest_name.localeCompare(b.latest_name, "nb"));
  pick.replaceChildren(...byName.map((m) => {
    const o = document.createElement("option");
    o.value = m.product_id;
    o.textContent = `${m.latest_name} (${pct(Number(m.pct_change))})`;
    return o;
  }));
  // Open on the biggest mover: the most interesting history to show first.
  const top = [...move].sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change))[0];
  if (!top) return;
  pick.value = top.product_id;

  const show = async () => {
    const id = Number(pick.value);   // option values come from our own data
    const rows = await rest(
      `v_price_history?product_id=eq.${id}` +
      "&select=delivery_date,unit_price,first_price,pct_vs_first" +
      "&order=delivery_date.asc,order_number.asc",
    );
    if (!rows.length) return;
    priceSteps($("c-hist"), rows);
    table($("t-hist"), rows, [
      { h: "Dato", v: (r) => r.delivery_date },
      { h: "Pris", n: 1, v: (r) => r.unit_price },
      { h: "Mot første", n: 1, v: (r) => pct(Number(r.pct_vs_first)) },
    ]);
  };
  pick.onchange = () => show().catch((e) => console.error(e));
  return show();
}

function overpaid(rows) {
  const total = rows.reduce((a, r) => a + Number(r.overpaid), 0);
  const top = rows.slice(0, 10);
  $("overpayNote").prepend(
    `${nok(total)} kr totalt, fordelt på ${rows.length} varer. De ti største vises. `);
  hbars($("c-overpay"), top, {
    value: (r) => Number(r.overpaid),
    label: (r) => r.latest_name,
    fmt:   (r) => `${nok(r.overpaid)} kr · ${r.lines_over} kjøp`,
  });
  table($("t-overpay"), rows, [
    { h: "Vare", v: (r) => r.latest_name },
    { h: "Kjøp over beste", n: 1, v: (r) => r.lines_over },
    { h: "Beste pris", n: 1, v: (r) => r.best_price },
    { h: "Høyeste", n: 1, v: (r) => r.worst_price },
    { h: "Betalt over", n: 1, v: (r) => nok(r.overpaid) },
  ]);
}

function cadenceChart(rows) {
  if (!rows.length) return;
  // Fill the empty days so the x-axis is a true day scale, not just the
  // gaps that happened to occur.
  const counts = new Map(rows.map((r) => [r.days, Number(r.orders)]));
  const lo = rows[0].days, hi = rows.at(-1).days;
  const bins = [];
  for (let d = lo; d <= hi; d++) bins.push({ days: d, orders: counts.get(d) ?? 0 });

  const gaps = rows.flatMap((r) => Array(Number(r.orders)).fill(r.days));
  const median = gaps[Math.floor((gaps.length - 1) / 2)];
  $("cadenceNote").append(` Median ${median} dager.`);

  columns($("c-cadence"), bins, {
    value: (r) => r.orders,
    label: (r) => String(r.days),
    fmt:   (r) => `${r.orders} ${r.orders === 1 ? "gang" : "ganger"}`,
    showLabel: (r) => r.days % 7 === 0,
    tickFmt: String,
  });
  table($("t-cadence"), rows, [
    { h: "Dager mellom", n: 1, v: (r) => r.days },
    { h: "Antall", n: 1, v: (r) => r.orders },
  ]);
}

function similarity(rows) {
  if (!rows.length) return;
  const avg = rows.reduce((a, r) => a + Number(r.jaccard_pct), 0) / rows.length;
  $("simNote").append(` Snitt ${avg.toFixed(1).replace(".", ",")} %.`);
  columns($("c-sim"), rows, {
    value: (r) => Number(r.jaccard_pct),
    label: (r) => r.delivery_date.slice(2, 7),
    fmt:   (r) => `${r.delivery_date} · ${r.shared} av ${r.items} varer felles (${r.jaccard_pct} %)`,
    everyNth: 8,
    tickFmt: (v) => `${v} %`,
  });
  table($("t-sim"), rows, [
    { h: "Dato", v: (r) => r.delivery_date },
    { h: "Varer", n: 1, v: (r) => r.items },
    { h: "Felles", n: 1, v: (r) => r.shared },
    { h: "Likhet", n: 1, v: (r) => r.jaccard_pct + " %" },
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
