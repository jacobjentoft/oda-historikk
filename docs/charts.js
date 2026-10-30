// SVG chart builders. No library: every mark is written here, so the specs from
// the dataviz skill (thin marks, hairline grid, 2px gaps, selective labels,
// hover on every plot) are visible in the code rather than buried in config.

const NS = "http://www.w3.org/2000/svg";
const el = (n, attrs = {}, text) => {
  const e = document.createElementNS(NS, n);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
};

/** Labels come from Oda's product names; tooltips are HTML, so escape them. */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const nok = (n) =>
  new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(n);
export const pct = (n) =>
  (n > 0 ? "+" : "") + n.toFixed(1).replace(".", ",") + " %";

/** Shared tooltip. One element, moved around -- not one per mark. */
let tip;
function showTip(host, html, ev) {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    document.body.appendChild(tip);
  }
  tip.innerHTML = html;
  tip.style.display = "block";
  const pad = 12;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY - r.height - pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y < 8) y = ev.clientY + pad;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
export function hideTip() { if (tip) tip.style.display = "none"; }

/** Hover + keyboard focus show the same thing -- tooltips enhance, never gate. */
function hoverable(node, host, html) {
  node.setAttribute("tabindex", "0");
  node.addEventListener("pointerenter", (e) => showTip(host, html, e));
  node.addEventListener("pointermove",  (e) => showTip(host, html, e));
  node.addEventListener("pointerleave", hideTip);
  node.addEventListener("focus", (e) => {
    const r = node.getBoundingClientRect();
    showTip(host, html, { clientX: r.left + r.width / 2, clientY: r.top });
  });
  node.addEventListener("blur", hideTip);
}

function frame(w, h) {
  const svg = el("svg", {
    viewBox: `0 0 ${w} ${h}`, width: "100%", height: h,
    role: "img", preserveAspectRatio: "xMidYMid meet",
  });
  return svg;
}

/* ------------------------------------------------------------------ *
 * Index line. The y-domain is deliberately wider than the data:
 * 99.7-101.1 auto-scaled would turn a 1 % band into apparent drama.
 * ------------------------------------------------------------------ */
export function indexLine(host, rows) {
  const w = 720, h = 260, m = { t: 18, r: 18, b: 34, l: 44 };
  const svg = frame(w, h);

  const lo = 95, hi = 105;                       // fixed honest window
  const x = (i) => m.l + (i * (w - m.l - m.r)) / Math.max(1, rows.length - 1);
  const y = (v) => m.t + ((hi - v) * (h - m.t - m.b)) / (hi - lo);

  for (const v of [95, 100, 105]) {
    svg.appendChild(el("line", {
      x1: m.l, x2: w - m.r, y1: y(v), y2: y(v),
      stroke: v === 100 ? "var(--baseline)" : "var(--grid)", "stroke-width": 1,
    }));
    svg.appendChild(el("text", {
      x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "tick",
    }, String(v)));
  }
  // No in-plot annotation at y=100: the data line sits on it, and a label
  // there collides with the marks. The axis tick plus the card note carry it.

  const d = rows.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r.index_value)}`).join(" ");
  svg.appendChild(el("path", {
    d, fill: "none", stroke: "var(--series-1)", "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }));

  rows.forEach((r, i) => {
    const dot = el("circle", {
      cx: x(i), cy: y(r.index_value), r: 3.5,
      fill: "var(--series-1)", stroke: "var(--surface)", "stroke-width": 2,
    });
    hoverable(dot, host,
      `<b>${r.month.slice(0, 7)}</b><br>Indeks ${r.index_value}<br>` +
      `${r.products_priced} varer priset`);
    svg.appendChild(dot);
    if (i === 0 || i === rows.length - 1) {
      svg.appendChild(el("text", {
        x: x(i), y: h - 12, "text-anchor": i ? "end" : "start", class: "tick",
      }, r.month.slice(0, 7)));
    }
  });

  host.replaceChildren(svg);
}

/* ------------------------------------------------------------------ *
 * Diverging bars. Polarity data: two hues that read as opposite,
 * neutral gray at the midpoint, never a hue at zero.
 * ------------------------------------------------------------------ */
const ellipsis = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function divergingBars(host, rows, opts) {
  // `short` is the direct label: terse by design. Detail lives in the tooltip
  // and the table view -- a long string here overflows the gutter and gets
  // clipped, which is worse than no label at all.
  // polarity says which SIDE is the bad one, so the same component can serve
  // "prices went up = bad" and "you saved money = good" without inverting meaning.
  //   up-bad  : positive -> red  (a price rise)
  //   up-good : positive -> blue (a saving)
  // ends[] labels the two directions; omitted, the axis carries no wording.
  const {
    value, label, fmt, short, labelTop = 3, barH = 9, gap = 2,
    polarity = "up-bad", ends = null,
  } = opts;
  // Wide gutters: the extremes are the labelled rows, and they are also the
  // longest bars, so the label needs room exactly where space is tightest.
  const w = 720, m = { t: 10, r: 176, b: 26, l: 176 };
  const h = m.t + m.b + rows.length * (barH + gap);
  const svg = frame(w, h);

  const max = Math.max(...rows.map((r) => Math.abs(value(r)))) || 1;
  // Extremes by VALUE, not by position -- on a date-ordered chart the first
  // and last rows are not the interesting ones.
  const ranked = rows.map((r, i) => [i, value(r)]).sort((a, b) => b[1] - a[1]);
  const labelled = new Set([
    ...ranked.slice(0, labelTop).map(([i]) => i),
    ...ranked.slice(-labelTop).map(([i]) => i),
  ]);
  const mid = m.l + (w - m.l - m.r) / 2;
  const scale = (v) => (v / max) * ((w - m.l - m.r) / 2);

  svg.appendChild(el("line", {
    x1: mid, x2: mid, y1: m.t, y2: h - m.b,
    stroke: "var(--baseline)", "stroke-width": 1,
  }));

  rows.forEach((r, i) => {
    const v = value(r);
    const yy = m.t + i * (barH + gap);
    const len = scale(v);
    const up = v >= 0;
    const bad  = polarity === "up-bad" ? up : !up;
    const bar = el("rect", {
      x: up ? mid : mid + len, y: yy,
      width: Math.max(1, Math.abs(len)), height: barH, rx: 2,
      fill: bad ? "var(--pole-up)" : "var(--pole-down)",
    });
    hoverable(bar, host, `<b>${esc(label(r))}</b><br>${esc(fmt(r))}`);
    svg.appendChild(bar);

    // Direct-label only the extremes; the rest are carried by tooltip + table.
    if (labelled.has(i)) {
      const txt = short ? short(r) : ellipsis(label(r), 18);
      svg.appendChild(el("text", {
        x: up ? mid + len + 7 : mid + len - 7, y: yy + barH - 1,
        "text-anchor": up ? "start" : "end", class: "tick",
      }, ellipsis(txt, 26)));
    }
  });

  if (ends) {
    svg.appendChild(el("text", { x: mid - 6, y: h - 10, "text-anchor": "end",   class: "tick" }, ends[0]));
    svg.appendChild(el("text", { x: mid + 6, y: h - 10, "text-anchor": "start", class: "tick" }, ends[1]));
  }
  host.replaceChildren(svg);
}

/* ------------------------------------------------------------------ *
 * Column chart, single series -> one hue for every bar (never a value
 * ramp on categories: that would double-encode height as colour).
 * ------------------------------------------------------------------ */
export function columns(host, rows, opts) {
  // showLabel picks which bars get an axis label; the default is every Nth.
  // tickFmt formats the y-axis (kroner by default, plain counts or % otherwise).
  const {
    value, label, fmt, everyNth = 2,
    showLabel = (r, i) => i % everyNth === 0, tickFmt = nok,
  } = opts;
  const w = 720, h = 240, m = { t: 16, r: 12, b: 38, l: 52 };
  const svg = frame(w, h);

  const raw = Math.max(...rows.map(value)) || 1;
  const step = Math.pow(10, Math.floor(Math.log10(raw / 4)));
  const nice = [1, 2, 2.5, 5, 10].map((k) => k * step).find((s) => raw / s <= 4) ?? step * 10;
  const max = Math.ceil(raw / nice) * nice;   // round up to a readable tick
  const bw = (w - m.l - m.r) / rows.length;
  const y = (v) => m.t + (1 - v / max) * (h - m.t - m.b);

  for (let v = 0; v <= max + 1e-9; v += nice) {
    svg.appendChild(el("line", {
      x1: m.l, x2: w - m.r, y1: y(v), y2: y(v),
      stroke: v ? "var(--grid)" : "var(--baseline)", "stroke-width": 1,
    }));
    svg.appendChild(el("text", {
      x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "tick",
    }, tickFmt(v)));
  }

  rows.forEach((r, i) => {
    const v = value(r);
    // A zero is drawn as nothing, not a 1px sliver: in a histogram an empty
    // bin must read as empty. The label still marks its place on the axis.
    if (showLabel(r, i)) {
      svg.appendChild(el("text", {
        x: m.l + i * bw + bw / 2, y: h - 14, "text-anchor": "middle", class: "tick",
      }, label(r)));
    }
    if (!v) return;
    const bar = el("rect", {
      x: m.l + i * bw + 1, y: y(v),
      width: Math.max(1, bw - 2), height: Math.max(1, y(0) - y(v)),
      rx: 2, fill: "var(--series-1)",
    });
    hoverable(bar, host, `<b>${esc(label(r))}</b><br>${esc(fmt(r))}`);
    svg.appendChild(bar);
  });

  host.replaceChildren(svg);
}

/** Horizontal bars with a direct label on every row (few enough to fit). */
export function hbars(host, rows, opts) {
  const { value, label, fmt } = opts;
  const w = 720, barH = 26, gap = 8, m = { t: 8, r: 150, b: 8, l: 210 };
  const h = m.t + m.b + rows.length * (barH + gap);
  const svg = frame(w, h);
  const max = Math.max(...rows.map(value)) || 1;

  rows.forEach((r, i) => {
    const yy = m.t + i * (barH + gap);
    const len = (value(r) / max) * (w - m.l - m.r);
    const bar = el("rect", {
      x: m.l, y: yy, width: Math.max(2, len), height: barH, rx: 3,
      fill: "var(--series-1)",
    });
    hoverable(bar, host, `<b>${esc(label(r))}</b><br>${esc(fmt(r))}`);
    svg.appendChild(bar);
    svg.appendChild(el("text", {
      x: m.l - 10, y: yy + barH / 2 + 4, "text-anchor": "end", class: "rowlabel",
    }, label(r).length > 30 ? label(r).slice(0, 29) + "…" : label(r)));
    svg.appendChild(el("text", {
      x: m.l + len + 8, y: yy + barH / 2 + 4, class: "rowvalue",
    }, fmt(r)));
  });

  host.replaceChildren(svg);
}

/* ------------------------------------------------------------------ *
 * Price history for one product, drawn as steps: a price holds until the
 * next purchase, the same carry-forward the index assumes. Dashed line =
 * first price paid. x is real time, so long gaps between buys look long.
 * ------------------------------------------------------------------ */
export function priceSteps(host, rows) {
  const w = 720, h = 240, m = { t: 16, r: 18, b: 34, l: 52 };
  const svg = frame(w, h);

  const t = rows.map((r) => Date.parse(r.delivery_date));
  const p = rows.map((r) => Number(r.unit_price));
  const first = Number(rows[0].first_price);

  const t0 = t[0], t1 = Math.max(t.at(-1), t0 + 86_400_000);
  // Pad the y-range so a flat price is not drawn as a line on the frame edge.
  const lo0 = Math.min(...p, first), hi0 = Math.max(...p, first);
  const pad = Math.max((hi0 - lo0) * 0.15, hi0 * 0.03);
  const raw = (hi0 + pad) - (lo0 - pad);
  const step = [1, 2, 2.5, 5, 10, 20, 25, 50, 100].find((s) => raw / s <= 5) ?? 100;
  const lo = Math.floor((lo0 - pad) / step) * step;
  const hi = Math.ceil((hi0 + pad) / step) * step;

  const x = (v) => m.l + ((v - t0) * (w - m.l - m.r)) / (t1 - t0);
  const y = (v) => m.t + ((hi - v) * (h - m.t - m.b)) / (hi - lo);

  // A 2.5 kr step needs its decimal: nok() would round 22.5 to "23".
  const tick = Number.isInteger(step) ? nok : (v) => v.toFixed(1).replace(".", ",");
  for (let v = lo; v <= hi + 1e-9; v += step) {
    svg.appendChild(el("line", {
      x1: m.l, x2: w - m.r, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1,
    }));
    svg.appendChild(el("text", {
      x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "tick",
    }, tick(v)));
  }

  svg.appendChild(el("line", {
    x1: m.l, x2: w - m.r, y1: y(first), y2: y(first),
    stroke: "var(--baseline)", "stroke-width": 1.5, "stroke-dasharray": "4 4",
  }));

  let d = `M${x(t[0])},${y(p[0])}`;
  for (let i = 1; i < rows.length; i++) d += ` H${x(t[i])} V${y(p[i])}`;
  svg.appendChild(el("path", {
    d, fill: "none", stroke: "var(--series-1)", "stroke-width": 2,
    "stroke-linejoin": "round",
  }));

  rows.forEach((r, i) => {
    const dot = el("circle", {
      cx: x(t[i]), cy: y(p[i]), r: 3.5,
      fill: "var(--series-1)", stroke: "var(--surface)", "stroke-width": 2,
    });
    hoverable(dot, host,
      `<b>${esc(r.delivery_date)}</b><br>${esc(r.unit_price)} kr` +
      ` (${esc(pct(Number(r.pct_vs_first)))} mot første pris)`);
    svg.appendChild(dot);
  });

  for (const [v, anchor] of [[t[0], "start"], [t1, "end"]]) {
    svg.appendChild(el("text", {
      x: x(v), y: h - 12, "text-anchor": anchor, class: "tick",
    }, new Date(v).toISOString().slice(0, 10)));
  }

  host.replaceChildren(svg);
}
