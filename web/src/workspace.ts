/* Live data sources: every scrape becomes a run, and a source's runs become the same
   Data shape the warehouse export uses, so every page works on scraped data too.
   Sources are kept in this browser (localStorage). */
import type { Category, Change, Data, Product, Run } from "./types";

export type Cell = string | number | boolean | null;
export interface ScrapeDataset { name: string; description: string; columns: string[]; rows: Record<string, Cell>[] }
export interface ScrapeResult {
  url: string; finalUrl: string; status: number; contentType: string; kind: "html" | "json"; bytes: number; pages: number; ms: number;
  robots: string; meta: Record<string, string | number>; datasets: ScrapeDataset[];
}

export interface Item {
  key: string; title: string; category: string; price: number | null; in_stock: boolean | null;
  stock_qty: number | null; rating: number | null; url: string; extra: Record<string, Cell>;
}
export interface Snapshot {
  at: string; ms: number; ok: boolean; error?: string; pages: number; bytes: number; status: number;
  dataset: string; columns: string[]; items: Item[]; rejected: { key: string; reason: string }[];
}
export interface LiveSource {
  id: string; url: string; label: string; mode: string; selector: string; pages: number;
  currency: string; snapshots: Snapshot[];
}

const KEY = "pricepulse.sources.v1";
const MAX_SNAPSHOTS = 8;
const MAX_SOURCES = 10;

export function loadSources(): LiveSource[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
}

export function saveSources(sources: LiveSource[]) {
  let list = sources.slice(0, MAX_SOURCES).map((s) => ({ ...s, snapshots: s.snapshots.slice(-MAX_SNAPSHOTS) }));
  for (let i = 0; i < 6; i++) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return; } catch {
      // Over quota: drop the oldest snapshots first, then the oldest sources.
      list = list.some((s) => s.snapshots.length > 1)
        ? list.map((s) => ({ ...s, snapshots: s.snapshots.slice(-Math.max(1, Math.floor(s.snapshots.length / 2))) }))
        : list.slice(0, Math.max(1, list.length - 1));
    }
  }
}

export const sourceId = (url: string, selector: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/$/, "")}${u.search}${selector ? `#${selector}` : ""}`;
  } catch { return url; }
};

export function labelFor(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/(index\.html?)?$/, "");
    return `${u.host.replace(/^www\./, "")}${path.length > 1 ? path : ""}`;
  } catch { return url; }
}

/* ------------------------------------------------------------ normalise -- */

const pick = (row: Record<string, Cell>, keys: string[]) => {
  for (const k of keys) {
    const hit = Object.keys(row).find((c) => c.toLowerCase() === k);
    if (hit && row[hit] !== null && row[hit] !== "") return row[hit];
  }
  return null;
};
const toNum = (v: Cell): number | null => {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/* The dataset that best represents the page's records. */
export function primaryDataset(r: ScrapeResult): ScrapeDataset | undefined {
  const order = (d: ScrapeDataset) =>
    d.name.startsWith("selector") ? 0 : d.name === "products" ? 1 : d.name === "structured data" ? 2 : r.kind === "json" ? 3 : d.name.startsWith("table") ? 4 : d.name === "links" ? 9 : 5;
  return [...r.datasets].filter((d) => d.rows.length).sort((a, b) => order(a) - order(b))[0];
}

export function currencyOf(ds: ScrapeDataset): string {
  for (const r of ds.rows.slice(0, 20)) {
    const cur = pick(r, ["currency", "pricecurrency"]);
    if (typeof cur === "string") return ({ GBP: "£", USD: "$", EUR: "€", INR: "₹", JPY: "¥" } as Record<string, string>)[cur.toUpperCase()] ?? `${cur} `;
    const txt = pick(r, ["price_text"]);
    const sym = typeof txt === "string" ? txt.match(/[£$€¥₹]/) : null;
    if (sym) return sym[0];
  }
  return "";
}

export function normalise(ds: ScrapeDataset): { items: Item[]; rejected: Snapshot["rejected"] } {
  const priceCol = ds.columns.find((c) => /(^|\.)price$/i.test(c)) ?? ds.columns.find((c) => /price|amount|cost/i.test(c) && !/text|discount/i.test(c));
  const firstText = ds.columns.find((c) => ds.rows.some((r) => typeof r[c] === "string" && !/^https?:/.test(String(r[c]))));
  const items: Item[] = [];
  const rejected: Snapshot["rejected"] = [];
  const seen = new Set<string>();
  ds.rows.forEach((row, i) => {
    const title = String(pick(row, ["title", "name", "headline", "product", "label", "text"]) ?? (firstText ? row[firstText] ?? "" : "")).trim();
    const url = String(pick(row, ["link", "url", "href", "product_url", "permalink"]) ?? "");
    const key = url || title || `row ${i + 1}`;
    if (!title) { rejected.push({ key, reason: "title: missing" }); return; }
    const price = priceCol ? toNum(row[priceCol]) : null;
    if (priceCol && (price === null || price < 0)) { rejected.push({ key, reason: "price: missing or unparseable" }); return; }
    if (seen.has(key)) { rejected.push({ key, reason: "duplicate record" }); return; }
    seen.add(key);
    const availability = pick(row, ["availability", "availabilitystatus", "stock_status", "status"]);
    const stock = toNum(pick(row, ["stock", "stock_qty", "quantity", "inventory"]));
    const in_stock = typeof availability === "string"
      ? !/out of stock|sold out|unavailable|outofstock/i.test(availability) && /in stock|available|instock|low stock/i.test(availability) ? true : /out|sold|unavailable/i.test(availability) ? false : null
      : stock !== null ? stock > 0 : null;
    const ratingRaw = toNum(pick(row, ["rating", "stars", "score", "ratingvalue"]));
    const category = pick(row, ["category", "categories", "brand", "brand.name", "type", "genre", "author", "company.name", "tag", "tags"]);
    const extra: Record<string, Cell> = {};
    ds.columns.slice(0, 14).forEach((c) => { const v = row[c]; extra[c] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v ?? null; });
    items.push({
      key, title: title.slice(0, 240), url,
      category: category === null ? "Uncategorised" : String(category).split(",")[0].trim() || "Uncategorised",
      price, in_stock, stock_qty: stock, rating: ratingRaw !== null && ratingRaw >= 0 && ratingRaw <= 10 ? ratingRaw : null, extra,
    });
  });
  return { items, rejected };
}

export function snapshotFrom(r: ScrapeResult): Snapshot {
  const ds = primaryDataset(r);
  const { items, rejected } = ds ? normalise(ds) : { items: [], rejected: [] };
  return {
    at: new Date().toISOString(), ms: r.ms, ok: items.length > 0, error: items.length ? undefined : "No records found on this page",
    pages: r.pages ?? 1, bytes: r.bytes, status: r.status, dataset: ds?.name ?? "none", columns: ds?.columns ?? [], items, rejected,
  };
}

export function failedSnapshot(error: string): Snapshot {
  return { at: new Date().toISOString(), ms: 0, ok: false, error, pages: 0, bytes: 0, status: 0, dataset: "none", columns: [], items: [], rejected: [] };
}

/* ------------------------------------------------------------ build Data -- */

const round = (v: number, d = 2) => Number(v.toFixed(d));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function buildData(src: LiveSource): Data {
  const ok = src.snapshots.filter((s) => s.ok);
  const latest = ok[ok.length - 1];
  const ids = new Map<string, number>();
  const idOf = (k: string) => { if (!ids.has(k)) ids.set(k, ids.size + 1); return ids.get(k)!; };
  ok.forEach((s) => s.items.forEach((it) => idOf(it.key)));

  const products: Product[] = (latest?.items ?? []).map((it) => ({
    product_id: idOf(it.key), title: it.title, category: it.category, price: it.price, in_stock: it.in_stock,
    stock_qty: it.stock_qty, rating: it.rating, url: it.url, extra: it.extra,
  }));

  const groups = new Map<string, Product[]>();
  products.forEach((p) => groups.set(p.category, [...(groups.get(p.category) ?? []), p]));
  const categories: Category[] = [...groups.entries()].map(([category, ps]) => {
    const prices = ps.map((p) => p.price).filter((v): v is number => v !== null);
    const ratings = ps.map((p) => p.rating).filter((v): v is number => v !== null);
    const known = ps.filter((p) => p.in_stock !== null);
    return {
      category, products: ps.length,
      avg_price: round(avg(prices)), min_price: prices.length ? Math.min(...prices) : 0, max_price: prices.length ? Math.max(...prices) : 0,
      avg_rating: round(avg(ratings)), pct_in_stock: known.length ? round((known.filter((p) => p.in_stock).length / known.length) * 100, 1) : 0,
      total_stock: ps.reduce((n, p) => n + (p.stock_qty ?? 0), 0),
    };
  }).sort((a, b) => b.products - a.products);

  const price_index = ok.map((s) => {
    const prices = s.items.map((i) => i.price).filter((v): v is number => v !== null);
    const known = s.items.filter((i) => i.in_stock !== null);
    return { t: s.at, avg_price: round(avg(prices)), pct_in_stock: known.length ? round((known.filter((i) => i.in_stock).length / known.length) * 100, 1) : 0, products: s.items.length };
  });

  const changes: Change[] = [];
  const history: Data["history"] = [];
  for (let i = 1; i < ok.length; i++) {
    const prev = new Map(ok[i - 1].items.map((it) => [it.key, it.price]));
    for (const it of ok[i].items) {
      const old = prev.get(it.key);
      if (old != null && it.price != null && old !== it.price) {
        changes.push({ product_id: idOf(it.key), title: it.title, category: it.category, old_price: old, new_price: it.price,
          pct_change: round(((it.price - old) / old) * 100), changed_at: ok[i].at, is_simulated: false });
      }
    }
  }
  const moved = new Set(changes.map((c) => c.product_id));
  ok.forEach((s) => s.items.forEach((it) => { if (it.price !== null && moved.has(idOf(it.key))) history.push({ product_id: idOf(it.key), t: s.at, price: it.price }); }));
  changes.reverse();

  const runs: Run[] = src.snapshots.map((s, i) => ({
    run_id: i + 1, source: src.label, started_at: s.at, finished_at: new Date(new Date(s.at).getTime() + s.ms).toISOString(),
    status: s.ok ? "success" : "failed", rows_extracted: s.items.length + s.rejected.length, rows_loaded: s.items.length,
    rows_rejected: s.rejected.length, is_simulated: false, error_message: s.error ?? null, duration_s: round(s.ms / 1000, 2),
  }));

  return {
    generated_at: latest?.at ?? new Date().toISOString(),
    source: { id: src.id, label: src.label, url: src.url, live: true, currency: src.currency, columns: latest?.columns ?? [] },
    products, categories, price_index, changes, history, runs,
    quality: latest ? qualityChecks(src, latest, ok[ok.length - 2]) : [],
    rejected: (latest?.rejected ?? []).slice(0, 50).map((r) => ({ run_id: src.snapshots.indexOf(latest!) + 1, source: src.label, record_key: r.key, reason: r.reason })),
    quotes: { count: 0, sample: [] },
  };
}

function qualityChecks(src: LiveSource, s: Snapshot, prev?: Snapshot): Data["quality"] {
  const run_id = src.snapshots.indexOf(s) + 1;
  const row = (check_name: string, status: "pass" | "warn" | "fail", severity: string, details: string) => ({ run_id, source: src.label, check_name, status, severity, details });
  const total = s.items.length + s.rejected.length;
  const prices = s.items.map((i) => i.price).filter((v): v is number => v !== null);
  const ratings = s.items.map((i) => i.rating).filter((v): v is number => v !== null);
  const missingTitle = s.rejected.filter((r) => r.reason.startsWith("title")).length;
  const badPrice = s.rejected.filter((r) => r.reason.startsWith("price")).length;
  const dupes = s.rejected.filter((r) => r.reason.startsWith("duplicate")).length;
  const out = [
    row("row_count_min", s.items.length >= 1 ? "pass" : "fail", "critical", `${s.items.length} valid rows (minimum 1)`),
    row("not_null_title", missingTitle ? "warn" : "pass", "critical", missingTitle ? `${missingTitle} rows without a title` : "every row has a title"),
    row("duplicate_records", dupes ? "warn" : "pass", "critical", `duplicate rate ${total ? ((dupes / total) * 100).toFixed(2) : "0.00"}% (${dupes} rows)`),
  ];
  if (prices.length || badPrice) {
    const outOfRange = prices.filter((p) => p <= 0 || p > 100_000).length;
    out.push(row("price_parse", badPrice / Math.max(1, total) > 0.05 ? "fail" : badPrice ? "warn" : "pass", "critical", `${badPrice} unparseable prices of ${total}`));
    out.push(row("price_range", outOfRange ? "warn" : "pass", "critical", `${outOfRange} value(s) outside (0, 100000]; observed min=${Math.min(...prices)}, max=${Math.max(...prices)}`));
  }
  if (ratings.length) out.push(row("rating_range", "pass", "soft", `${ratings.length} ratings; observed min=${Math.min(...ratings)}, max=${Math.max(...ratings)}`));
  if (prev) {
    const change = prev.items.length ? (s.items.length - prev.items.length) / prev.items.length : 0;
    out.push(row("row_count_change", Math.abs(change) > 0.5 ? "warn" : "pass", "soft", `${(change * 100).toFixed(1)}% vs previous run (${prev.items.length} rows)`));
  } else {
    out.push(row("row_count_change", "pass", "soft", "no previous successful run to compare"));
  }
  return out;
}
