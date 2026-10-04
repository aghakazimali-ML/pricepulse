import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Activity, BarChart3, Database, Download, Globe, History, LayoutGrid, Loader2, Package, Play, Radar, RefreshCw, Search, Trash2 } from "lucide-react";
import { AreaTrend, BarCompare, ChartCard, DonutBreakdown, KpiCard, type Series } from "@/components/ui/revenue-charts-kpi";
import { cn } from "@/lib/utils";
import type { Data, Product, Run } from "./types";
import {
  buildData, currencyOf, failedSnapshot, labelFor, loadSources, primaryDataset, saveSources, snapshotFrom, sourceId,
  type Cell, type LiveSource, type ScrapeResult,
} from "./workspace";

const REPO = "https://github.com/aghakazimali-ML/pricepulse";
const DEMO = "demo";

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/* ------------------------------------------------------------ formats -- */

// Currency of the active source; set by App before each render (chart tooltips read it later too).
let CUR = "£";
const int = (v: number) => Math.round(v).toLocaleString("en-GB");
const money = (v: number) => `${CUR}${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (v: number) => `${CUR}${Math.round(v).toLocaleString("en-GB")}`;
const pct = (v: number) => `${v.toFixed(1)}%`;
const secs = (v: number) => (v < 10 ? `${v.toFixed(1)}s` : `${v.toFixed(0)}s`);
const day = (v: string) => new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const clock = (v: string) => new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const stamp = (v: string) =>
  new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const delta = (xs: number[]) => (xs.length > 1 && xs[xs.length - 2] ? xs[xs.length - 1] / xs[xs.length - 2] - 1 : undefined);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const nums = <T,>(xs: T[], f: (x: T) => number | null | undefined) => xs.map(f).filter((v): v is number => typeof v === "number" && isFinite(v));

/* Time axis: dates for a daily warehouse, clock times for live scrapes taken minutes apart. */
const timeFmt = (d: Data) => (d.source.live ? clock : day);

/* ------------------------------------------------------------ context -- */

interface Workspace {
  sources: LiveSource[];
  active: string;
  setActive: (id: string) => void;
  scrape: (req: { url: string; mode: string; selector: string; pages: number }) => Promise<{ result?: ScrapeResult; error?: string; source?: LiveSource }>;
  remove: (id: string) => void;
}
const Ctx = createContext<Workspace>(null!);
const useWorkspace = () => useContext(Ctx);

/* --------------------------------------------------------- primitives -- */

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: [0.25, 0.1, 0.25, 1] }}
    >
      {children}
    </motion.div>
  );
}

function Header({ eyebrow, title, description, aside }: { eyebrow: string; title: string; description: string; aside?: ReactNode }) {
  return (
    <Reveal>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div className="grid min-w-0 gap-1.5">
          <p className="m-0 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</p>
          <h1 className="m-0 text-[26px] leading-tight font-semibold tracking-[-0.025em] break-words">{title}</h1>
          <p className="m-0 max-w-[680px] text-[13.5px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {aside && <div className="grid justify-items-start gap-1.5 text-[12px] text-muted-foreground sm:justify-items-end">{aside}</div>}
      </header>
    </Reveal>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 ring-1 ring-border">
      <span className={cn("size-1.5 rounded-full", ok ? "bg-emerald-400" : "bg-red-400")} />
      <span className="text-foreground">{label}</span>
    </span>
  );
}

interface KpiInput { label: string; value: string; delta?: number; good?: "up" | "down"; period?: string; trend?: number[]; slot?: 1 | 2 | 3 | 4 | 5 }

function Kpis({ cards }: { cards: (KpiInput | false | null | undefined)[] }) {
  const shown = cards.filter(Boolean) as KpiInput[];
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
      {shown.map((c, i) => (
        <Reveal key={c.label} delay={i * 0.04} className="h-full">
          <KpiCard className="h-full content-start" {...c} />
        </Reveal>
      ))}
    </div>
  );
}

function Card({ title, subtitle, actions, children, delay = 0.05 }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode; delay?: number }) {
  return (
    <Reveal delay={delay} className="min-w-0">
      <ChartCard title={title} subtitle={subtitle} actions={actions} className="min-w-0">
        {children}
      </ChartCard>
    </Reveal>
  );
}

function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-3 py-2">
      <p className="m-0 max-w-[560px] text-[13px] leading-relaxed text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}

interface Column<T> { key: string; label: string; render?: (row: T) => ReactNode; align?: "right" }

function Table<T extends Record<string, any>>({ rows, columns, empty = "Nothing to show." }: { rows: T[]; columns: Column<T>[]; empty?: string }) {
  if (!rows.length) return <p className="m-0 text-[13px] text-muted-foreground">{empty}</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cn("border-b border-border px-1 py-2 font-medium whitespace-nowrap text-muted-foreground", c.align === "right" ? "text-right" : "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-accent/40">
              {columns.map((c) => (
                <td key={c.key} className={cn("border-b border-border/60 px-1 py-2 tabular-nums", c.align === "right" && "text-right")}>
                  {c.render ? c.render(r) : String(r[c.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellView({ v }: { v: Cell | undefined }) {
  if (v === null || v === undefined || v === "") return <span className="text-muted-foreground">–</span>;
  if (typeof v === "string" && /^https?:\/\//.test(v)) {
    return <a href={v} target="_blank" rel="noreferrer" className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">{v.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}</a>;
  }
  const s = String(v);
  return <span title={s.length > 90 ? s : undefined}>{s.length > 90 ? `${s.slice(0, 90)}…` : s}</span>;
}

const inputCls = "h-9 rounded-[10px] bg-card px-3 text-[13px] text-foreground ring-1 ring-border outline-none focus:ring-ring";
const btnCls = "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] border-0 bg-muted px-3 text-[12px] text-foreground ring-1 ring-border hover:bg-accent disabled:cursor-wait disabled:opacity-60";

/* Re-scrape the active live source: adds a run, and price changes appear when prices move. */
function ScrapeAgain({ d, label = "Scrape again" }: { d: Data; label?: string }) {
  const ws = useWorkspace();
  const [busy, setBusy] = useState(false);
  const src = ws.sources.find((s) => s.id === d.source.id);
  if (!src) return null;
  return (
    <button type="button" className={btnCls} disabled={busy} onClick={async () => { setBusy(true); await ws.scrape(src); setBusy(false); }}>
      <RefreshCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden /> {busy ? "Scraping…" : label}
    </button>
  );
}

function priceBands(xs: number[], n = 6) {
  if (xs.length < 2) return [];
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const step = (hi - lo) / n || 1;
  const f = (v: number) => (hi - lo < 12 ? v.toFixed(1) : String(Math.round(v)));
  const bands = Array.from({ length: n }, (_, i) => ({ band: `${CUR}${f(lo + i * step)}–${f(lo + (i + 1) * step)}`, items: 0 }));
  xs.forEach((x) => { bands[Math.min(n - 1, Math.floor((x - lo) / step))].items += 1; });
  return bands;
}

/* --------------------------------------------------------------- pages -- */

function Home({ d }: { d: Data }) {
  const idx = d.price_index;
  const live = d.source.live;
  const real = d.runs.filter((r) => !r.is_simulated);
  const last = real[real.length - 1];
  const lastOk = [...real].reverse().find((r) => r.status === "success");
  const prices = nums(d.products, (p) => p.price);
  const ratings = nums(d.products, (p) => p.rating);
  const stockKnown = d.products.filter((p) => p.in_stock !== null);
  const ratingMix = [5, 4, 3, 2, 1].map((n, i) => ({ label: `${n} star${n > 1 ? "s" : ""}`, value: d.products.filter((p) => p.rating !== null && Math.round(p.rating) === n).length, slot: (i + 1) as 1 }));
  const catMix = d.categories.slice(0, 5).map((c, i) => ({ label: c.category, value: c.products, slot: (i + 1) as 1 }));
  const others = d.products.length - catMix.reduce((n, c) => n + c.value, 0);
  if (others > 0) catMix.push({ label: "Other", value: others, slot: 5 as 1 });
  return (
    <>
      <Header
        eyebrow={live ? "Live source" : "Overview"}
        title={live ? d.source.label : "Catalogue price tracking"}
        description={live
          ? `Scraped from ${d.source.url}. Every page of this dashboard now shows this source. Scrape again to add runs and build price history.`
          : "Daily scrape of books.toscrape.com, validated and stored as price history in a SQL star schema."}
        aside={
          <>
            <StatusPill ok={last?.status === "success"} label={last?.status === "success" ? "Pipeline healthy" : "Last run failed"} />
            {lastOk && <span className="tabular-nums">Last successful run {stamp(lastOk.finished_at)}</span>}
            <span>{real.length} run{real.length === 1 ? "" : "s"} recorded</span>
          </>
        }
      />
      <Kpis
        cards={[
          { label: live ? "Records tracked" : "Products tracked", value: int(d.products.length), trend: idx.map((r) => r.products), delta: delta(idx.map((r) => r.products)), period: idx.length > 1 ? "vs last run" : undefined },
          { label: "Categories", value: int(d.categories.length) },
          prices.length > 0 && { label: "Average price", value: money(mean(prices)), trend: idx.map((r) => r.avg_price), delta: delta(idx.map((r) => r.avg_price)), good: "down", period: idx.length > 1 ? "vs last run" : undefined },
          stockKnown.length > 0 && { label: "In stock", value: pct(idx.at(-1)?.pct_in_stock ?? 0), trend: idx.map((r) => r.pct_in_stock), delta: delta(idx.map((r) => r.pct_in_stock)), period: idx.length > 1 ? "vs last run" : undefined },
          { label: "Price changes", value: int(d.changes.length) },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        {prices.length > 0 && idx.length > 1 ? (
          <Card title="Average price" subtitle="Average price of every record, at each run">
            <AreaTrend data={idx} xKey="t" series={[{ key: "avg_price", label: "Average price" }]} format={money} xFormat={timeFmt(d)} description="Average price over time" height={240} />
          </Card>
        ) : prices.length > 1 ? (
          <Card title="Price distribution" subtitle={`${prices.length} prices in the latest run`}>
            <BarCompare data={priceBands(prices)} xKey="band" series={[{ key: "items", label: "Records" }]} height={240} description="How many records fall in each price range" />
          </Card>
        ) : (
          <Card title="Latest records" subtitle={`First ${Math.min(8, d.products.length)} of ${int(d.products.length)}`}>
            <Table
              rows={d.products.slice(0, 8)}
              columns={[
                { key: "title", label: "Title", render: (p) => <CellView v={p.title} /> },
                { key: "category", label: "Category", render: (p) => <span className="text-muted-foreground">{p.category}</span> },
              ]}
            />
          </Card>
        )}
        {ratings.length > 0 ? (
          <Card title="Rating mix" subtitle="Records by star rating">
            <DonutBreakdown data={ratingMix} format={int} centerLabel="Rated" description="Records by star rating" />
          </Card>
        ) : (
          <Card title="Category mix" subtitle="Share of records by category">
            <DonutBreakdown data={catMix} format={int} centerLabel="Records" description="Records by category" />
          </Card>
        )}
      </div>
      {d.categories.length > 1 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Largest categories" subtitle="Top 15 by record count">
            <BarCompare data={d.categories.slice(0, 15)} xKey="category" series={[{ key: "products", label: "Records" }]} layout="vertical" height={Math.max(160, Math.min(15, d.categories.length) * 25)} description="Top 15 categories by record count" />
          </Card>
          <Card title="Category summary" subtitle="Latest run, all categories">
            <div className="max-h-[380px] overflow-y-auto">
              <Table
                rows={d.categories}
                columns={[
                  { key: "category", label: "Category" },
                  { key: "products", label: "Records", align: "right" },
                  ...(prices.length ? [{ key: "avg_price", label: "Avg price", align: "right" as const, render: (r: any) => money(r.avg_price) }] : []),
                  ...(ratings.length ? [{ key: "avg_rating", label: "Rating", align: "right" as const, render: (r: any) => r.avg_rating.toFixed(1) }] : []),
                  ...(stockKnown.length ? [{ key: "pct_in_stock", label: "In stock", align: "right" as const, render: (r: any) => pct(r.pct_in_stock) }] : []),
                ]}
              />
            </div>
          </Card>
        </div>
      ) : prices.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Most expensive" subtitle="Top 12 records by price">
            <BarCompare data={[...d.products].filter((p) => p.price !== null).sort((a, b) => b.price! - a.price!).slice(0, 12).map((p) => ({ title: p.title.length > 28 ? `${p.title.slice(0, 28)}…` : p.title, price: p.price }))}
              xKey="title" series={[{ key: "price", label: "Price" }]} format={money0} layout="vertical" height={320} description="Most expensive records" />
          </Card>
          <Card title="Cheapest" subtitle="Lowest-priced records in the latest run">
            <Table
              rows={[...d.products].filter((p) => p.price !== null).sort((a, b) => a.price! - b.price!).slice(0, 8)}
              columns={[
                { key: "title", label: "Title" },
                { key: "price", label: "Price", align: "right", render: (p) => money(p.price!) },
                ...(ratings.length ? [{ key: "rating", label: "Rating", align: "right" as const, render: (p: Product) => (p.rating ?? "–") }] : []),
              ]}
            />
          </Card>
        </div>
      ) : null}
    </>
  );
}

const PAGE = 25;
type SortKey = "title" | "price" | "rating" | "stock_qty";

function Products({ d }: { d: Data }) {
  const [term, setTerm] = useState("");
  const [cat, setCat] = useState("All");
  const hasPrice = d.products.some((p) => p.price !== null);
  const hasRating = d.products.some((p) => p.rating !== null);
  const hasStock = d.products.some((p) => p.in_stock !== null);
  const [sort, setSort] = useState<SortKey>(hasPrice ? "price" : "title");
  const [desc, setDesc] = useState(hasPrice);
  const [page, setPage] = useState(0);
  const cats = useMemo(() => ["All", ...d.categories.map((c) => c.category).sort()], [d]);
  const rows = useMemo(() => {
    const t = term.trim().toLowerCase();
    const out = d.products.filter((p) => (cat === "All" || p.category === cat) && (!t || p.title.toLowerCase().includes(t)));
    out.sort((a, b) => {
      const x = a[sort] ?? (typeof a[sort] === "string" ? "" : -Infinity), y = b[sort] ?? (typeof b[sort] === "string" ? "" : -Infinity);
      const c = typeof x === "string" ? x.localeCompare(String(y)) : Number(x) - Number(y);
      return desc ? -c : c;
    });
    return out;
  }, [d, term, cat, sort, desc]);
  useEffect(() => setPage(0), [term, cat, sort, desc]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const known = rows.filter((p) => p.in_stock !== null);
  const ratingVals = nums(rows, (p) => p.rating);
  // Live API sources without prices: show their own fields instead.
  const extraCols = d.source.live ? d.source.columns.filter((c) => !/^(title|name|link|url|image|price|price_text|rating|availability|category)$/i.test(c)).slice(0, hasPrice ? 2 : 5) : [];
  return (
    <>
      <Header eyebrow="Products" title={d.source.live ? "Latest scraped records" : "Latest catalogue"} description={`The most recent captured state of every record from ${d.source.label}. Search, filter by category and sort.`} />
      <Kpis
        cards={[
          { label: "Matching records", value: int(rows.length) },
          hasPrice && { label: "Average price", value: money(mean(nums(rows, (p) => p.price))) },
          hasStock && { label: "In stock", value: known.length ? pct((known.filter((p) => p.in_stock).length / known.length) * 100) : "–" },
          hasRating && { label: "Average rating", value: ratingVals.length ? mean(ratingVals).toFixed(2) : "–" },
          !hasPrice && { label: "Categories", value: int(new Set(rows.map((p) => p.category)).size) },
        ]}
      />
      <Card
        title="Records"
        subtitle={`${int(rows.length)} results`}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <label className="relative">
              <span className="sr-only">Search titles</span>
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input className={cn(inputCls, "w-48 pl-8")} placeholder="Search titles" value={term} onChange={(e) => setTerm(e.target.value)} />
            </label>
            <label>
              <span className="sr-only">Category</span>
              <select className={cn(inputCls, "max-w-[200px]")} value={cat} onChange={(e) => setCat(e.target.value)}>
                {cats.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label>
              <span className="sr-only">Sort by</span>
              <select className={inputCls} value={`${sort}:${desc ? "d" : "a"}`} onChange={(e) => { const [k, o] = e.target.value.split(":"); setSort(k as SortKey); setDesc(o === "d"); }}>
                {hasPrice && <option value="price:d">Price, high to low</option>}
                {hasPrice && <option value="price:a">Price, low to high</option>}
                {hasRating && <option value="rating:d">Rating, best first</option>}
                {hasStock && <option value="stock_qty:d">Stock, most first</option>}
                <option value="title:a">Title, A to Z</option>
              </select>
            </label>
          </div>
        }
      >
        <Table<Product>
          rows={shown}
          empty="No records match."
          columns={[
            { key: "title", label: "Title", render: (p) => (p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="text-foreground no-underline hover:underline">{p.title}</a> : p.title) },
            { key: "category", label: "Category", render: (p) => <span className="text-muted-foreground">{p.category}</span> },
            ...(hasPrice ? [{ key: "price", label: "Price", align: "right" as const, render: (p: Product) => (p.price === null ? "–" : money(p.price)) }] : []),
            ...(hasRating ? [{ key: "rating", label: "Rating", align: "right" as const, render: (p: Product) => (p.rating === null ? "–" : `${p.rating} / ${p.rating > 5 ? 10 : 5}`) }] : []),
            ...(hasStock ? [{ key: "stock_qty", label: "Stock", align: "right" as const, render: (p: Product) => (p.in_stock === false ? <span className="text-red-400">Out</span> : p.stock_qty !== null ? int(p.stock_qty) : "In stock") }] : []),
            ...extraCols.map((c) => ({ key: `x:${c}`, label: c, render: (p: Product) => <CellView v={p.extra?.[c]} /> })),
          ]}
        />
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <span className="tabular-nums">Page {page + 1} of {pages}</span>
          <div className="flex gap-2">
            {([["Previous", -1], ["Next", 1]] as const).map(([label, step]) => (
              <button key={label} type="button" disabled={page + step < 0 || page + step >= pages} onClick={() => setPage(page + step)}
                className="h-8 cursor-pointer rounded-[8px] bg-card px-3 text-[12px] text-foreground ring-1 ring-border disabled:cursor-default disabled:opacity-40">
                {label}
              </button>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}

function PriceHistory({ d }: { d: Data }) {
  const movers = useMemo(() => {
    const total = new Map<number, number>();
    d.changes.forEach((c) => total.set(c.product_id, (total.get(c.product_id) ?? 0) + Math.abs(c.pct_change)));
    return [...total.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [d]);
  const titles = useMemo(() => {
    const m = new Map(d.products.map((p) => [p.product_id, p.title]));
    d.changes.forEach((c) => { if (!m.has(c.product_id)) m.set(c.product_id, c.title); });
    return m;
  }, [d]);
  const [picked, setPicked] = useState<number[]>(() => movers.slice(0, 4));
  const options = movers.filter((id) => !picked.includes(id));
  const chart = useMemo(() => {
    const times = [...new Set(d.history.map((h) => h.t.slice(0, 19)))].sort();
    const last = new Map<number, number>();
    const byTime = new Map<string, Map<number, number>>();
    d.history.forEach((h) => {
      if (!picked.includes(h.product_id)) return;
      const k = h.t.slice(0, 19);
      if (!byTime.has(k)) byTime.set(k, new Map());
      byTime.get(k)!.set(h.product_id, h.price);
    });
    return times.map((t) => {
      byTime.get(t)?.forEach((v, id) => last.set(id, v));
      const row: Record<string, unknown> = { t };
      picked.forEach((id) => { if (last.has(id)) row[`p${id}`] = last.get(id); });
      return row;
    });
  }, [d, picked]);
  const series: Series[] = picked.map((id, i) => ({ key: `p${id}`, label: titles.get(id) ?? `#${id}`, slot: ((i % 5) + 1) as 1 }));
  const drops = d.changes.filter((c) => c.pct_change < 0);
  const ups = d.changes.filter((c) => c.pct_change > 0);
  const okRuns = d.price_index.length;
  const hasPrice = d.products.some((p) => p.price !== null);
  return (
    <>
      <Header
        eyebrow="Price history"
        title="Price movements"
        description={`Every change in price between runs of ${d.source.label}, with old and new values.${d.source.live ? "" : " Simulated runs are marked."}`}
        aside={<span className="tabular-nums">{int(d.changes.length)} changes recorded across {okRuns} run{okRuns === 1 ? "" : "s"}</span>}
      />
      <Kpis
        cards={[
          { label: "Price drops", value: int(drops.length) },
          { label: "Price increases", value: int(ups.length) },
          { label: "Average drop", value: drops.length ? pct(mean(drops.map((c) => c.pct_change))) : "–" },
          { label: "Average increase", value: ups.length ? pct(mean(ups.map((c) => c.pct_change))) : "–" },
          !d.source.live && { label: "Simulated", value: int(d.changes.filter((c) => c.is_simulated).length) },
        ]}
      />
      {!hasPrice ? (
        <Card title="No prices in this source"><Empty>This source has no price field, so there is no price history to track. Scrape a product listing or a products API to use this page.</Empty></Card>
      ) : !d.changes.length ? (
        <>
          {okRuns > 1 && (
            <Card title="Average price" subtitle="Average price at each run">
              <AreaTrend data={d.price_index} xKey="t" series={[{ key: "avg_price", label: "Average price" }]} format={money} xFormat={timeFmt(d)} description="Average price per run" height={220} />
            </Card>
          )}
          <Card title="No price changes yet">
            <Empty action={d.source.live ? <ScrapeAgain d={d} label="Scrape again now" /> : undefined}>
              {okRuns < 2
                ? "Price history needs at least two runs of the same source. Each time you scrape it again, PricePulse compares every record's price with the previous run and logs the changes here."
                : `All ${int(d.products.length)} prices were the same in every run so far. Changes appear here as soon as a price moves.`}
            </Empty>
          </Card>
        </>
      ) : (
        <>
          <Card title="Price over time" subtitle="Pick up to 5 products. The biggest movers are selected by default.">
            <div className="flex flex-wrap items-center gap-2">
              {picked.map((id) => (
                <button key={id} type="button" onClick={() => setPicked(picked.filter((x) => x !== id))}
                  className="inline-flex max-w-[260px] cursor-pointer items-center gap-1.5 rounded-full border-0 bg-muted px-2.5 py-1 text-[12px] text-foreground ring-1 ring-border">
                  <span className="truncate">{titles.get(id)}</span>
                  <span aria-hidden className="text-muted-foreground">×</span>
                  <span className="sr-only">Remove</span>
                </button>
              ))}
              {picked.length < 5 && options.length > 0 && (
                <label>
                  <span className="sr-only">Add a product</span>
                  <select className={cn(inputCls, "h-8 max-w-[260px]")} value="" onChange={(e) => e.target.value && setPicked([...picked, Number(e.target.value)])}>
                    <option value="">Add a product…</option>
                    {options.map((id) => <option key={id} value={id}>{titles.get(id)}</option>)}
                  </select>
                </label>
              )}
            </div>
            {picked.length ? (
              <AreaTrend data={chart} xKey="t" series={series} format={money0} xFormat={timeFmt(d)} height={280} description="Price over time for the selected products" />
            ) : (
              <p className="m-0 text-[13px] text-muted-foreground">Pick a product to see its history.</p>
            )}
          </Card>
          <Card title="Recent changes" subtitle="Newest first">
            <div className="max-h-[440px] overflow-y-auto">
              <Table
                rows={d.changes.slice(0, 100)}
                columns={[
                  { key: "title", label: "Product" },
                  { key: "category", label: "Category", render: (c) => <span className="text-muted-foreground">{c.category}</span> },
                  { key: "old_price", label: "Old", align: "right", render: (c) => money(c.old_price) },
                  { key: "new_price", label: "New", align: "right", render: (c) => money(c.new_price) },
                  { key: "pct_change", label: "Change", align: "right", render: (c) => <span className={c.pct_change < 0 ? "text-emerald-400" : "text-red-400"}>{c.pct_change > 0 ? "+" : ""}{c.pct_change.toFixed(1)}%</span> },
                  { key: "changed_at", label: "When", align: "right", render: (c) => <span className="text-muted-foreground">{timeFmt(d)(c.changed_at)}{c.is_simulated ? " · sim" : ""}</span> },
                ]}
              />
            </div>
          </Card>
        </>
      )}
    </>
  );
}

function Insights({ d }: { d: Data }) {
  const [n, setN] = useState(12);
  const prices = nums(d.products, (p) => p.price);
  const hasRating = d.products.some((p) => p.rating !== null);
  const hasStock = d.products.some((p) => p.in_stock !== null);
  const maxN = Math.max(1, Math.min(25, d.categories.length));
  const top = d.categories.slice(0, Math.min(n, maxN));
  const ratingLevels = [...new Set(nums(d.products, (p) => (p.rating === null ? null : Math.round(p.rating))))].sort((a, b) => a - b);
  const byRating = ratingLevels.map((r) => {
    const ps = d.products.filter((p) => p.rating !== null && Math.round(p.rating) === r);
    return { rating: `${r} star${r === 1 ? "" : "s"}`, avg: Number(mean(nums(ps, (p) => p.price)).toFixed(2)), count: ps.length };
  });
  const stock = top.map((c) => {
    const ps = d.products.filter((p) => p.category === c.category && p.in_stock !== null);
    const inn = ps.filter((p) => p.in_stock).length;
    return { category: c.category, in: inn, out: ps.length - inn };
  });
  return (
    <>
      <Header eyebrow="Insights" title={`What ${d.source.live ? "this source" : "the catalogue"} looks like`} description={`Price spread by category, how price relates to rating, and where the stock is, for ${d.source.label}.`} />
      {!prices.length ? (
        <Card title="No prices in this source">
          <Empty>Price insights need a price field. Here is how the records split by category instead.</Empty>
          <BarCompare data={d.categories.slice(0, 15)} xKey="category" series={[{ key: "products", label: "Records" }]} layout="vertical" height={Math.max(160, Math.min(15, d.categories.length) * 25)} description="Records per category" />
        </Card>
      ) : (
        <>
          <Card
            title="Price range by category"
            subtitle="Cheapest, average and most expensive record in each category"
            actions={maxN > 5 ? (
              <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                Categories
                <input type="range" min={Math.min(5, maxN)} max={maxN} value={Math.min(n, maxN)} onChange={(e) => setN(Number(e.target.value))} className="w-28 accent-[var(--foreground)]" />
                <span className="w-5 tabular-nums text-foreground">{Math.min(n, maxN)}</span>
              </label>
            ) : undefined}
          >
            <BarCompare
              data={top}
              xKey="category"
              series={[{ key: "min_price", label: "Lowest", slot: 3 }, { key: "avg_price", label: "Average", slot: 2 }, { key: "max_price", label: "Highest", slot: 1 }]}
              format={money0}
              height={300}
              description="Lowest, average and highest price per category"
            />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            {hasRating && byRating.length > 0 && (
              <Card title="Rating vs price" subtitle="Average price at each star rating">
                <BarCompare data={byRating} xKey="rating" series={[{ key: "avg", label: "Average price" }]} format={money0} height={240} description="Average price by star rating" />
              </Card>
            )}
            <Card title="Price bands" subtitle="How many records sit in each price range">
              <BarCompare data={priceBands(prices, 5)} xKey="band" series={[{ key: "items", label: "Records" }]} height={240} description="Records per price band" />
            </Card>
          </div>
          {hasStock && (
            <Card title="Stock levels" subtitle="Records in and out of stock, by category">
              <BarCompare data={stock} xKey="category" series={[{ key: "in", label: "In stock", slot: 1 }, { key: "out", label: "Out of stock", slot: 3 }]} stacked height={260} description="In and out of stock records by category" />
            </Card>
          )}
        </>
      )}
    </>
  );
}

function Health({ d }: { d: Data }) {
  const anySim = d.runs.some((r) => r.is_simulated);
  const [sim, setSim] = useState(false);
  const runs = d.runs.filter((r) => sim || !r.is_simulated);
  const [active, setActive] = useState<Run | null>(null);
  const shown = active ?? runs[runs.length - 1];
  const ok = runs.filter((r) => r.status === "success").length;
  const real = runs.filter((r) => !r.is_simulated);
  const rows = runs.map((r) => ({ run: `#${r.run_id}`, loaded: r.rows_loaded, rejected: r.rows_rejected }));
  const lastOk = d.runs.filter((r) => !r.is_simulated).at(-1)?.status === "success";
  return (
    <>
      <Header
        eyebrow="Pipeline health"
        title="Runs and data quality"
        description={`Every run of ${d.source.label} is tracked with row counts, timings, quality checks and rejected records.`}
        aside={<StatusPill ok={lastOk} label={lastOk ? "Last run succeeded" : "Last run failed"} />}
      />
      {anySim && (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
          <input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} className="accent-[var(--foreground)]" />
          Include simulated runs
        </label>
      )}
      <Kpis
        cards={[
          { label: "Runs", value: int(runs.length) },
          { label: "Success rate", value: runs.length ? pct((ok / runs.length) * 100) : "–" },
          { label: "Average duration", value: secs(mean(real.map((r) => r.duration_s))), trend: real.map((r) => r.duration_s), slot: 2 },
          { label: "Rows rejected", value: int(runs.reduce((n, r) => n + r.rows_rejected, 0)) },
        ]}
      />
      <Card title="Recent runs" subtitle="Each square is one run. Hover or tap for details.">
        <div className="flex flex-wrap gap-1.5">
          {runs.map((r) => (
            <button
              key={r.run_id}
              type="button"
              aria-label={`Run ${r.run_id}: ${r.status}`}
              onMouseEnter={() => setActive(r)}
              onFocus={() => setActive(r)}
              onClick={() => setActive(r)}
              className={cn(
                "size-4 cursor-pointer rounded-[4px] border-0 p-0 outline-none transition-transform hover:scale-125 focus-visible:ring-2 focus-visible:ring-ring",
                r.is_simulated ? "bg-transparent ring-1 ring-[var(--chart-2)] ring-inset" : r.status === "success" ? "bg-[var(--chart-4)]" : r.status === "failed" ? "bg-red-400" : "bg-[var(--chart-3)]",
              )}
            />
          ))}
        </div>
        {shown && (
          <p className="m-0 text-[12.5px] text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">Run #{shown.run_id}</span> · {shown.source} ·{" "}
            <span className={shown.status === "failed" ? "text-red-400" : "text-foreground"}>{shown.status}</span>
            {shown.is_simulated ? " · simulated" : ""} · {stamp(shown.started_at)} · {int(shown.rows_loaded)} loaded
            {shown.error_message ? ` · ${shown.error_message}` : ""}
          </p>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rows per run" subtitle="Loaded and rejected">
          <BarCompare data={rows} xKey="run" series={[{ key: "loaded", label: "Loaded", slot: 1 }, { key: "rejected", label: "Rejected", slot: 3 }]} stacked height={240} description="Rows loaded and rejected per run" />
        </Card>
        <Card title="Run duration" subtitle="Real runs only">
          <BarCompare data={real.map((r) => ({ run: d.source.live ? `#${r.run_id}` : `#${r.run_id} ${r.source}`, s: r.duration_s }))} xKey="run" series={[{ key: "s", label: "Seconds", slot: 2 }]} format={secs} height={240} description="Duration of each real run" />
        </Card>
      </div>
      <Card title="Data quality checks" subtitle={d.source.live ? "Latest run" : "Latest run of each source"}>
        <Table
          rows={d.quality}
          empty="No successful run yet."
          columns={[
            { key: "source", label: "Source", render: (q) => <span className="text-muted-foreground">{q.source}</span> },
            { key: "check_name", label: "Check" },
            { key: "severity", label: "Severity", render: (q) => <span className="text-muted-foreground">{q.severity}</span> },
            { key: "status", label: "Result", render: (q) => <span className={q.status === "pass" ? "text-emerald-400" : q.status === "warn" ? "text-amber-300" : "text-red-400"}>{q.status}</span> },
            { key: "details", label: "Details", render: (q) => <span className="text-muted-foreground">{q.details}</span> },
          ]}
        />
      </Card>
      <Card title="Rejected rows" subtitle="Records that failed validation, with the reason">
        <Table rows={d.rejected} empty="No rows were rejected. Every scraped record passed validation."
          columns={[
            { key: "run_id", label: "Run", render: (r) => `#${r.run_id}` },
            { key: "source", label: "Source" },
            { key: "record_key", label: "Record", render: (r) => <CellView v={r.record_key} /> },
            { key: "reason", label: "Reason" },
          ]}
        />
      </Card>
    </>
  );
}

/* -------------------------------------------------------------- scrape -- */

const PRESETS = [
  { label: "Books to Scrape (5 pages)", url: "https://books.toscrape.com/", mode: "auto", selector: "", pages: 5 },
  { label: "Quotes (CSS selector)", url: "https://quotes.toscrape.com/", mode: "html", selector: ".quote", pages: 3 },
  { label: "JSON API: products", url: "https://dummyjson.com/products?limit=100", mode: "json", selector: "", pages: 1 },
  { label: "JSON API: users", url: "https://jsonplaceholder.typicode.com/users", mode: "json", selector: "", pages: 1 },
];

const csvCell = (v: Cell | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function download(name: string, body: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Scrape(_: { d?: Data | null }) {
  const ws = useWorkspace();
  const [url, setUrl] = useState("https://books.toscrape.com/");
  const [mode, setMode] = useState("auto");
  const [selector, setSelector] = useState("");
  const [pages, setPages] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScrapeResult | null>(null);
  const [saved, setSaved] = useState<LiveSource | null>(null);
  const [tab, setTab] = useState(0);

  async function run(req = { url, mode, selector, pages }) {
    if (!req.url.trim()) return;
    setBusy(true); setError(null);
    const out = await ws.scrape(req);
    setBusy(false);
    if (out.error) { setError(out.error); setResult(null); setSaved(null); return; }
    setResult(out.result!); setSaved(out.source ?? null);
    const primary = primaryDataset(out.result!);
    setTab(Math.max(0, out.result!.datasets.findIndex((x) => x === primary)));
  }

  const ds = result?.datasets[tab];
  const total = result?.datasets.filter((x) => x.name !== "links").reduce((n, x) => n + x.rows.length, 0) ?? 0;
  const slug = result ? new URL(result.finalUrl).hostname.replace(/^www\./, "") : "scrape";
  const loaded = saved?.snapshots.at(-1);

  return (
    <>
      <Header
        eyebrow="Live scraper"
        title="Scrape a website or API"
        description="Paste a public web page or JSON API URL. PricePulse fetches it on the server, checks robots.txt, follows next-page links, cleans and validates the records, and switches the whole dashboard to that data."
      />
      <Reveal delay={0.04}>
        <form onSubmit={(e) => { e.preventDefault(); run(); }} className="grid gap-3 rounded-[18px] bg-card p-5 ring-1 ring-border [corner-shape:squircle]">
          <div className="flex flex-wrap gap-2">
            <label className="relative min-w-[240px] flex-1">
              <span className="sr-only">URL to scrape</span>
              <Globe className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input className={cn(inputCls, "h-11 w-full pl-9 text-[14px]")} type="text" inputMode="url"
                placeholder="https://example.com/products or https://api.example.com/items" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label>
              <span className="sr-only">Source type</span>
              <select className={cn(inputCls, "h-11")} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="auto">Auto detect</option>
                <option value="html">Website (HTML)</option>
                <option value="json">API (JSON)</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Pages to follow</span>
              <select className={cn(inputCls, "h-11")} value={pages} onChange={(e) => setPages(Number(e.target.value))}>
                {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 1 ? "1 page" : `Up to ${n} pages`}</option>)}
              </select>
            </label>
            <button type="submit" disabled={busy}
              className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-[10px] border-0 bg-foreground px-5 text-[14px] font-medium text-[oklch(0.145_0_0)] disabled:cursor-wait disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
              {busy ? "Scraping…" : "Scrape"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[220px] flex-1 sm:max-w-[340px]">
              <span className="sr-only">Optional CSS selector for items</span>
              <input className={cn(inputCls, "w-full font-mono text-[12.5px]")} placeholder="Optional CSS selector, e.g. .product-card" value={selector} onChange={(e) => setSelector(e.target.value)} />
            </label>
            <span className="text-[12px] text-muted-foreground">Try:</span>
            {PRESETS.map((p) => (
              <button key={p.label} type="button" disabled={busy}
                onClick={() => { setUrl(p.url); setMode(p.mode); setSelector(p.selector); setPages(p.pages); run(p); }}
                className="cursor-pointer rounded-full border-0 bg-muted px-2.5 py-1 text-[12px] text-foreground ring-1 ring-border hover:bg-accent disabled:cursor-wait">
                {p.label}
              </button>
            ))}
          </div>
        </form>
      </Reveal>

      {error && (
        <Reveal><p role="alert" className="m-0 rounded-[12px] bg-red-500/10 px-4 py-3 text-[13px] text-red-300 ring-1 ring-red-500/30">{error}</p></Reveal>
      )}

      {busy && (
        <div className="grid gap-3" aria-busy>
          {[64, 96, 320].map((h) => <div key={h} className="animate-pulse rounded-[14px] bg-card" style={{ height: h }} />)}
        </div>
      )}

      {!busy && result && saved && loaded && (
        <Reveal>
          <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-[14px] px-4 py-3 ring-1", loaded.ok ? "bg-emerald-500/10 ring-emerald-500/30" : "bg-amber-500/10 ring-amber-500/30")}>
            <p className="m-0 text-[13px] text-foreground">
              {loaded.ok
                ? <>Loaded <b>{int(loaded.items.length)}</b> clean records from <b>{saved.label}</b>{loaded.pages > 1 ? ` across ${loaded.pages} pages` : ""}{loaded.rejected.length ? `, ${loaded.rejected.length} rejected` : ""}. The whole dashboard now shows this source.</>
                : result.meta?.needs_js
                  ? <>The site answered, but it builds its content with JavaScript in the browser, so the HTML PricePulse receives has no records. The dashboard is unchanged. Try the site's own JSON API instead (in Chrome: Inspect, Network, Fetch/XHR, then copy a JSON URL and paste it here).</>
                  : <>The site answered, but PricePulse couldn't spot a list of repeated items, tables or records on it, so the dashboard is unchanged. Tell it which element is one item: right-click an item, choose Inspect, copy its class (for example <code>.product-card</code>) into the CSS selector box and scrape again.</>}
            </p>
            {loaded.ok && (
              <div className="flex flex-wrap gap-2">
                {[["home", "Overview"], ["products", "Products"], ["insights", "Insights"], ["health", "Pipeline health"]].map(([id, label]) => (
                  <a key={id} href={`#/${id}`} className={cn(btnCls, "no-underline")}>{label}</a>
                ))}
              </div>
            )}
          </div>
        </Reveal>
      )}

      {!busy && result && ds && (
        <>
          <Kpis
            key={result.finalUrl + result.ms}
            cards={[
              { label: "HTTP status", value: String(result.status), period: result.kind === "json" ? "JSON API" : `HTML, ${result.pages} page${result.pages === 1 ? "" : "s"}` },
              { label: "Records found", value: int(total), period: `${result.datasets.length} datasets` },
              { label: "Fetch and parse", value: `${(result.ms / 1000).toFixed(2)}s`, period: `${(result.bytes / 1024).toFixed(0)} KB` },
              { label: "robots.txt", value: result.robots === "allowed" ? "Allowed" : result.robots === "skipped" ? "Skipped" : "None found", period: result.robots === "skipped" ? "APIs are not checked" : "checked before fetching" },
            ]}
          />
          <Card
            title="Raw scraped data"
            subtitle={`${ds.description} · showing ${Math.min(ds.rows.length, 100)} of ${ds.rows.length}`}
            actions={
              <div className="flex gap-2">
                <button type="button" className={btnCls} onClick={() => download(`${slug}-${ds.name.replace(/\W+/g, "-")}.csv`, [ds.columns.join(","), ...ds.rows.map((r) => ds.columns.map((c) => csvCell(r[c])).join(","))].join("\n"), "text/csv")}>
                  <Download className="size-3.5" aria-hidden /> CSV
                </button>
                <button type="button" className={btnCls} onClick={() => download(`${slug}-${ds.name.replace(/\W+/g, "-")}.json`, JSON.stringify(ds.rows, null, 2), "application/json")}>
                  <Download className="size-3.5" aria-hidden /> JSON
                </button>
              </div>
            }
          >
            <div role="tablist" aria-label="Datasets" className="flex flex-wrap gap-1.5">
              {result.datasets.map((x, i) => (
                <button key={x.name + i} role="tab" type="button" aria-selected={i === tab} onClick={() => setTab(i)}
                  className={cn("cursor-pointer rounded-[8px] border-0 px-2.5 py-1 text-[12px] ring-1 ring-border", i === tab ? "bg-foreground text-[oklch(0.145_0_0)]" : "bg-transparent text-muted-foreground hover:text-foreground")}>
                  {x.name} <span className="tabular-nums opacity-70">{x.rows.length}</span>
                </button>
              ))}
            </div>
            <div className="max-h-[560px] overflow-auto">
              <Table rows={ds.rows.slice(0, 100)} empty="This dataset is empty."
                columns={ds.columns.map((c) => ({ key: c, label: c, render: (r: Record<string, Cell>) => <CellView v={r[c]} /> }))} />
            </div>
          </Card>
        </>
      )}

      <Sources />

      {!result && !busy && !error && (
        <Reveal delay={0.08}>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Websites", "Finds repeated product cards (title, price, rating, stock, link, image), schema.org data and HTML tables, and follows next-page links."],
              ["JSON APIs", "Finds the biggest list of records in the response and flattens nested fields into columns."],
              ["Runs like the pipeline", "Each scrape is validated, quality-checked and logged as a run. Scrape the same source again to build price history."],
            ].map(([t, x]) => (
              <div key={t} className="grid gap-1 rounded-[14px] bg-card p-4 ring-1 ring-border">
                <p className="m-0 text-[13px] font-medium">{t}</p>
                <p className="m-0 text-[12.5px] leading-relaxed text-muted-foreground">{x}</p>
              </div>
            ))}
          </div>
        </Reveal>
      )}
    </>
  );
}

function Sources() {
  const ws = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  if (!ws.sources.length) return null;
  return (
    <Card title="Your sources" subtitle="Saved in this browser. Pick one to show it across the dashboard, or scrape it again to add a run.">
      <Table
        rows={ws.sources}
        columns={[
          { key: "label", label: "Source", render: (s) => <span className={cn(s.id === ws.active && "font-medium")}>{s.label}{s.id === ws.active ? " · showing" : ""}</span> },
          { key: "runs", label: "Runs", align: "right", render: (s) => s.snapshots.length },
          { key: "records", label: "Records", align: "right", render: (s) => int([...s.snapshots].reverse().find((x) => x.ok)?.items.length ?? 0) },
          { key: "last", label: "Last run", align: "right", render: (s) => <span className="text-muted-foreground">{s.snapshots.length ? clock(s.snapshots.at(-1)!.at) : "–"}</span> },
          {
            key: "actions", label: "", align: "right", render: (s) => (
              <span className="inline-flex gap-1.5">
                {s.id !== ws.active && <button type="button" className={btnCls} onClick={() => { ws.setActive(s.id); location.hash = "#/home"; }}>Show</button>}
                <button type="button" className={btnCls} disabled={busy === s.id} onClick={async () => { setBusy(s.id); await ws.scrape(s); setBusy(null); }}>
                  <RefreshCw className={cn("size-3.5", busy === s.id && "animate-spin")} aria-hidden /> Run
                </button>
                <button type="button" aria-label={`Remove ${s.label}`} className={btnCls} onClick={() => ws.remove(s.id)}><Trash2 className="size-3.5" aria-hidden /></button>
              </span>
            ),
          },
        ]}
      />
    </Card>
  );
}

/* ----------------------------------------------------------------- app -- */

const PAGES = [
  { id: "home", label: "Home", icon: LayoutGrid, view: Home },
  { id: "scrape", label: "Scrape a site", icon: Radar, view: Scrape },
  { id: "products", label: "Products", icon: Package, view: Products },
  { id: "history", label: "Price History", icon: History, view: PriceHistory },
  { id: "insights", label: "Insights", icon: BarChart3, view: Insights },
  { id: "health", label: "Pipeline Health", icon: Activity, view: Health },
] as const;

const route = () => {
  const id = window.location.hash.replace("#/", "").replace("#", "");
  return PAGES.some((p) => p.id === id) ? id : "home";
};

const ACTIVE_KEY = "pricepulse.active.v1";
const readActive = () => { try { return localStorage.getItem(ACTIVE_KEY) ?? DEMO; } catch { return DEMO; } };

export default function App() {
  const [demo, setDemo] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(route);
  const [sources, setSources] = useState<LiveSource[]>(loadSources);
  const [active, setActiveState] = useState<string>(() => {
    const id = readActive();
    return id === DEMO || loadSources().some((s) => s.id === id) ? id : DEMO;
  });

  useEffect(() => {
    fetch("/data.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((raw) => setDemo({ ...raw, source: { id: DEMO, label: "books.toscrape.com", url: "https://books.toscrape.com/", live: false, currency: "£", columns: [] } }))
      .catch((e) => setError(String(e)));
    const onHash = () => { setPage(route()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setActive = useCallback((id: string) => {
    setActiveState(id);
    try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* private mode */ }
  }, []);

  const commit = useCallback((next: LiveSource[]) => { setSources(next); saveSources(next); }, []);

  const scrape = useCallback<Workspace["scrape"]>(async (req) => {
    const qs = new URLSearchParams({ url: req.url.trim(), mode: req.mode, pages: String(req.pages || 1) });
    if (req.selector?.trim()) qs.set("selector", req.selector.trim());
    let result: ScrapeResult | undefined;
    let error: string | undefined;
    try {
      const res = await fetch(`/api/scrape?${qs}`);
      const body = await res.json().catch(() => ({ error: `The scraper answered with HTTP ${res.status}.` }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      result = body;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const key = result ? result.finalUrl : req.url.trim();
    const id = sourceId(/^https?:\/\//i.test(key) ? key : `https://${key}`, req.selector?.trim() ?? "");
    const current = loadSources();
    const existing = current.find((s) => s.id === id);
    if (!result && !existing) return { error };
    const snap = result ? snapshotFrom(result) : failedSnapshot(error!);
    const primary = result ? primaryDataset(result) : undefined;
    const src: LiveSource = existing
      ? { ...existing, currency: existing.currency || (primary ? currencyOf(primary) : ""), snapshots: [...existing.snapshots, snap] }
      : { id, url: result!.finalUrl, label: labelFor(result!.finalUrl) + (req.selector?.trim() ? ` (${req.selector.trim()})` : ""), mode: req.mode, selector: req.selector?.trim() ?? "", pages: req.pages || 1, currency: primary ? currencyOf(primary) : "", snapshots: [snap] };
    commit([src, ...current.filter((s) => s.id !== id)]);
    if (snap.ok) setActive(id);
    return { result, error, source: src };
  }, [commit, setActive]);

  const remove = useCallback((id: string) => {
    commit(loadSources().filter((s) => s.id !== id));
    if (active === id) setActive(DEMO);
  }, [active, commit, setActive]);

  const liveSource = sources.find((s) => s.id === active);
  const data = useMemo<Data | null>(() => (liveSource ? buildData(liveSource) : demo), [liveSource, demo]);
  CUR = data?.source.currency ?? "£";

  const current = PAGES.find((p) => p.id === page)!;
  const View = current.view;
  const ws: Workspace = { sources, active, setActive, scrape, remove };

  return (
    <Ctx.Provider value={ws}>
      <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
        <aside className="border-b border-border bg-[oklch(0.17_0_0)] md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
          <div className="flex h-full flex-col gap-5 p-4 md:p-5">
            <a href="#/home" className="flex items-center gap-2.5 text-foreground no-underline">
              <span className="grid size-8 place-content-center rounded-[9px] bg-card ring-1 ring-border">
                <svg viewBox="0 0 32 32" className="size-5" aria-hidden><path d="M6 20l6-6 5 4 9-9" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
              <span className="grid leading-tight">
                <span className="text-[14px] font-semibold">PricePulse</span>
                <span className="text-[11.5px] text-muted-foreground">Price tracking pipeline</span>
              </span>
            </a>
            <label className="grid gap-1.5">
              <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><Database className="size-3.5" aria-hidden /> Data source</span>
              <select className={cn(inputCls, "w-full")} value={active} onChange={(e) => setActive(e.target.value)}>
                <option value={DEMO}>Demo warehouse (books.toscrape.com)</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <nav aria-label="Pages" className="-mx-1 flex gap-1 overflow-x-auto md:mx-0 md:grid md:overflow-visible">
              {PAGES.map((p) => (
                <a key={p.id} href={`#/${p.id}`} aria-current={p.id === page ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13px] whitespace-nowrap no-underline transition-colors",
                    p.id === page ? "bg-card text-foreground ring-1 ring-border" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                  )}>
                  <p.icon className="size-4" aria-hidden />
                  {p.label}
                </a>
              ))}
            </nav>
            <div className="mt-auto hidden gap-3 text-[11.5px] leading-relaxed text-muted-foreground md:grid">
              {data && (data.source.live
                ? <p className="m-0">Live source, last scraped {stamp(data.generated_at)}. Scraped sources are saved in this browser.</p>
                : <p className="m-0">Demo warehouse exported {stamp(data.generated_at)}. Hollow squares and “sim” mark simulated price moves.</p>)}
              <a href={REPO} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-foreground no-underline hover:underline">
                <GithubMark className="size-4" /> Source on GitHub
              </a>
            </div>
          </div>
        </aside>
        <main className="mx-auto grid w-full max-w-[1240px] content-start gap-5 px-4 py-6 md:px-8 md:py-8">
          {data && page !== "scrape" && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] px-3.5 py-2.5 text-[12.5px] ring-1 ring-border">
              <span className="text-muted-foreground">
                {data.source.live
                  ? <>Showing live data from <span className="text-foreground">{data.source.label}</span> · {int(data.products.length)} records · {data.runs.length} run{data.runs.length === 1 ? "" : "s"}</>
                  : <>Showing the demo warehouse. <a href="#/scrape" className="text-foreground underline underline-offset-2">Scrape a site</a> to see your own data here.</>}
              </span>
              {data.source.live && (
                <span className="flex gap-2">
                  <ScrapeAgain d={data} />
                  <button type="button" className={btnCls} onClick={() => setActive(DEMO)}>Back to demo</button>
                </span>
              )}
            </div>
          )}
          {error && !liveSource && <p className="text-[13px] text-red-400">Could not load data.json ({error}).</p>}
          {!data && !error && page !== "scrape" && (
            <div className="grid gap-4" aria-busy>
              {[64, 96, 280].map((h) => <div key={h} className="animate-pulse rounded-[14px] bg-card" style={{ height: h }} />)}
            </div>
          )}
          {(data || page === "scrape") && <View key={page === "scrape" ? page : `${page}:${active}:${data?.runs.length ?? 0}`} d={data!} />}
          <footer className="mt-4 border-t border-border pt-4 text-[12px] text-muted-foreground md:hidden">
            <a href={REPO} className="text-foreground">Source on GitHub</a>
          </footer>
        </main>
      </div>
    </Ctx.Provider>
  );
}
