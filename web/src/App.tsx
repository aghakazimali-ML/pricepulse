import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Activity, BarChart3, History, LayoutGrid, Package, Search } from "lucide-react";
import { AreaTrend, BarCompare, ChartCard, DonutBreakdown, KpiCard, type Series } from "@/components/ui/revenue-charts-kpi";
import { cn } from "@/lib/utils";
import type { Data, Product, Run } from "./types";

const REPO = "https://github.com/aghakazimali-ML/pricepulse";

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/* ------------------------------------------------------------ formats -- */

const int = (v: number) => Math.round(v).toLocaleString("en-GB");
const gbp = (v: number) => `£${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const gbp0 = (v: number) => `£${Math.round(v).toLocaleString("en-GB")}`;
const pct = (v: number) => `${v.toFixed(1)}%`;
const sec = (v: number) => `${v.toFixed(0)}s`;
const day = (v: string) => new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const stamp = (v: string) =>
  new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const delta = (xs: number[]) => (xs.length > 1 && xs[xs.length - 2] ? xs[xs.length - 1] / xs[xs.length - 2] - 1 : undefined);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

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
        <div className="grid gap-1.5">
          <p className="m-0 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</p>
          <h1 className="m-0 text-[26px] leading-tight font-semibold tracking-[-0.025em]">{title}</h1>
          <p className="m-0 max-w-[640px] text-[13.5px] leading-relaxed text-muted-foreground">{description}</p>
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

interface KpiInput { label: string; value: string; delta?: number; good?: "up" | "down"; period?: string; trend?: number[] }

function Kpis({ cards }: { cards: KpiInput[] }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
      {cards.map((c, i) => (
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

const inputCls = "h-9 rounded-[10px] bg-card px-3 text-[13px] text-foreground ring-1 ring-border outline-none focus:ring-ring";

/* --------------------------------------------------------------- pages -- */

function Home({ d }: { d: Data }) {
  const idx = d.price_index;
  const real = d.runs.filter((r) => !r.is_simulated);
  const last = real[real.length - 1];
  const ratings = [5, 4, 3, 2, 1].map((n, i) => ({
    label: `${n} star${n > 1 ? "s" : ""}`,
    value: d.products.filter((p) => p.rating === n).length,
    slot: (i + 1) as 1,
  }));
  return (
    <>
      <Header
        eyebrow="Overview"
        title="Catalogue price tracking"
        description="Daily scrape of books.toscrape.com, validated and stored as price history in a SQL star schema."
        aside={
          <>
            <StatusPill ok={last?.status === "success"} label={last?.status === "success" ? "Pipeline healthy" : "Last run failed"} />
            {last && <span className="tabular-nums">Last successful run {stamp(last.finished_at)}</span>}
            <span>{real.length} runs recorded</span>
          </>
        }
      />
      <Kpis
        cards={[
          { label: "Products tracked", value: int(d.products.length), trend: idx.map((r) => r.products), delta: delta(idx.map((r) => r.products)), period: "vs last capture" },
          { label: "Categories", value: int(d.categories.length) },
          { label: "Average price", value: gbp(mean(d.products.map((p) => p.price))), trend: idx.map((r) => r.avg_price), delta: delta(idx.map((r) => r.avg_price)), good: "down", period: "vs last capture" },
          { label: "In stock", value: pct(idx.at(-1)?.pct_in_stock ?? 0), trend: idx.map((r) => r.pct_in_stock), delta: delta(idx.map((r) => r.pct_in_stock)), period: "vs last capture" },
          { label: "Price changes", value: int(d.changes.length) },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card title="Average catalogue price" subtitle="Last known price of every product, at each capture">
          <AreaTrend data={idx} xKey="t" series={[{ key: "avg_price", label: "Average price" }]} format={gbp} xFormat={day} description="Average catalogue price over time" height={240} />
        </Card>
        <Card title="Rating mix" subtitle="Products by star rating">
          <DonutBreakdown data={ratings} format={int} centerLabel="Products" description="Products by star rating" />
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Largest categories" subtitle="Top 15 by product count">
          <BarCompare data={d.categories.slice(0, 15)} xKey="category" series={[{ key: "products", label: "Products" }]} layout="vertical" height={380} description="Top 15 categories by product count" />
        </Card>
        <Card title="Category summary" subtitle="Latest prices, all categories">
          <div className="max-h-[380px] overflow-y-auto">
            <Table
              rows={d.categories}
              columns={[
                { key: "category", label: "Category" },
                { key: "products", label: "Products", align: "right" },
                { key: "avg_price", label: "Avg price", align: "right", render: (r) => gbp(r.avg_price) },
                { key: "avg_rating", label: "Rating", align: "right", render: (r) => r.avg_rating.toFixed(1) },
                { key: "pct_in_stock", label: "In stock", align: "right", render: (r) => pct(r.pct_in_stock) },
              ]}
            />
          </div>
        </Card>
      </div>
    </>
  );
}

const PAGE = 25;
type SortKey = "title" | "price" | "rating" | "stock_qty";

function Products({ d }: { d: Data }) {
  const [term, setTerm] = useState("");
  const [cat, setCat] = useState("All");
  const [sort, setSort] = useState<SortKey>("price");
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(0);
  const cats = useMemo(() => ["All", ...d.categories.map((c) => c.category).sort()], [d]);
  const rows = useMemo(() => {
    const t = term.trim().toLowerCase();
    const out = d.products.filter((p) => (cat === "All" || p.category === cat) && (!t || p.title.toLowerCase().includes(t)));
    out.sort((a, b) => {
      const x = a[sort] ?? 0, y = b[sort] ?? 0;
      const c = typeof x === "string" ? x.localeCompare(String(y)) : Number(x) - Number(y);
      return desc ? -c : c;
    });
    return out;
  }, [d, term, cat, sort, desc]);
  useEffect(() => setPage(0), [term, cat, sort, desc]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const inStock = rows.filter((p) => p.in_stock).length;
  return (
    <>
      <Header eyebrow="Products" title="Latest catalogue" description="The most recent captured state of every product. Search, filter by category and sort." />
      <Kpis
        cards={[
          { label: "Matching products", value: int(rows.length) },
          { label: "Average price", value: gbp(mean(rows.map((p) => p.price))) },
          { label: "In stock", value: rows.length ? pct((inStock / rows.length) * 100) : "–" },
          { label: "Average rating", value: rows.length ? mean(rows.map((p) => p.rating)).toFixed(2) : "–" },
        ]}
      />
      <Card
        title="Products"
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
              <select className={inputCls} value={cat} onChange={(e) => setCat(e.target.value)}>
                {cats.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label>
              <span className="sr-only">Sort by</span>
              <select className={inputCls} value={`${sort}:${desc ? "d" : "a"}`} onChange={(e) => { const [k, o] = e.target.value.split(":"); setSort(k as SortKey); setDesc(o === "d"); }}>
                <option value="price:d">Price, high to low</option>
                <option value="price:a">Price, low to high</option>
                <option value="rating:d">Rating, best first</option>
                <option value="stock_qty:d">Stock, most first</option>
                <option value="title:a">Title, A to Z</option>
              </select>
            </label>
          </div>
        }
      >
        <Table<Product>
          rows={shown}
          empty="No products match."
          columns={[
            { key: "title", label: "Title", render: (p) => <a href={p.url} target="_blank" rel="noreferrer" className="text-foreground no-underline hover:underline">{p.title}</a> },
            { key: "category", label: "Category", render: (p) => <span className="text-muted-foreground">{p.category}</span> },
            { key: "price", label: "Price", align: "right", render: (p) => gbp(p.price) },
            { key: "rating", label: "Rating", align: "right", render: (p) => `${p.rating} / 5` },
            { key: "stock_qty", label: "Stock", align: "right", render: (p) => (p.in_stock ? int(p.stock_qty ?? 0) : <span className="text-red-400">Out</span>) },
          ]}
        />
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <span className="tabular-nums">Page {page + 1} of {pages}</span>
          <div className="flex gap-2">
            {[["Previous", -1], ["Next", 1]].map(([label, step]) => (
              <button
                key={label}
                type="button"
                disabled={page + Number(step) < 0 || page + Number(step) >= pages}
                onClick={() => setPage(page + Number(step))}
                className="h-8 cursor-pointer rounded-[8px] bg-card px-3 text-[12px] text-foreground ring-1 ring-border disabled:cursor-default disabled:opacity-40"
              >
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
  const titles = useMemo(() => new Map(d.products.map((p) => [p.product_id, p.title])), [d]);
  const [picked, setPicked] = useState<number[]>(() => movers.slice(0, 4));
  const options = movers.filter((id) => !picked.includes(id));

  const chart = useMemo(() => {
    const times = [...new Set(d.history.map((h) => h.t.slice(0, 16)))].sort();
    const last = new Map<number, number>();
    const byTime = new Map<string, Map<number, number>>();
    d.history.forEach((h) => {
      if (!picked.includes(h.product_id)) return;
      const k = h.t.slice(0, 16);
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
  return (
    <>
      <Header
        eyebrow="Price history"
        title="Price movements"
        description="Every change in price, with old and new values. Simulated runs are marked."
        aside={<span className="tabular-nums">{int(d.changes.length)} changes recorded</span>}
      />
      <Kpis
        cards={[
          { label: "Price drops", value: int(drops.length) },
          { label: "Price increases", value: int(ups.length) },
          { label: "Average drop", value: pct(mean(drops.map((c) => c.pct_change))) },
          { label: "Average increase", value: pct(mean(ups.map((c) => c.pct_change))) },
          { label: "Simulated", value: int(d.changes.filter((c) => c.is_simulated).length) },
        ]}
      />
      <Card title="Price over time" subtitle="Pick up to 5 products. The biggest movers are selected by default.">
        <div className="flex flex-wrap items-center gap-2">
          {picked.map((id) => (
            <button key={id} type="button" onClick={() => setPicked(picked.filter((x) => x !== id))}
              className="inline-flex max-w-[260px] cursor-pointer items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12px] text-foreground ring-1 ring-border">
              <span className="truncate">{titles.get(id)}</span>
              <span aria-hidden className="text-muted-foreground">×</span>
              <span className="sr-only">Remove</span>
            </button>
          ))}
          {picked.length < 5 && (
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
          <AreaTrend data={chart} xKey="t" series={series} format={gbp0} xFormat={day} height={280} description="Price over time for the selected products" />
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
              { key: "old_price", label: "Old", align: "right", render: (c) => gbp(c.old_price) },
              { key: "new_price", label: "New", align: "right", render: (c) => gbp(c.new_price) },
              { key: "pct_change", label: "Change", align: "right", render: (c) => <span className={c.pct_change < 0 ? "text-emerald-400" : "text-red-400"}>{c.pct_change > 0 ? "+" : ""}{c.pct_change.toFixed(1)}%</span> },
              { key: "changed_at", label: "When", align: "right", render: (c) => <span className="text-muted-foreground">{day(c.changed_at)}{c.is_simulated ? " · sim" : ""}</span> },
            ]}
          />
        </div>
      </Card>
    </>
  );
}

function Insights({ d }: { d: Data }) {
  const [n, setN] = useState(12);
  const top = d.categories.slice(0, n);
  const byRating = [1, 2, 3, 4, 5].map((r) => {
    const ps = d.products.filter((p) => p.rating === r);
    return { rating: `${r} star${r > 1 ? "s" : ""}`, avg: Number(mean(ps.map((p) => p.price)).toFixed(2)), count: ps.length };
  });
  const bands = [[0, 20], [20, 30], [30, 40], [40, 50], [50, 61]].map(([lo, hi]) => ({
    band: hi > 60 ? `£${lo}+` : `£${lo}–${hi}`,
    products: d.products.filter((p) => p.price >= lo && p.price < hi).length,
  }));
  const stock = top.map((c) => ({ category: c.category, in: Math.round((c.products * c.pct_in_stock) / 100), out: c.products - Math.round((c.products * c.pct_in_stock) / 100) }));
  return (
    <>
      <Header eyebrow="Insights" title="What the catalogue looks like" description="Price spread by category, how price relates to rating, and where the stock is." />
      <Card
        title="Price range by category"
        subtitle="Cheapest, average and most expensive title in each category"
        actions={
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            Categories
            <input type="range" min={5} max={Math.min(25, d.categories.length)} value={n} onChange={(e) => setN(Number(e.target.value))} className="w-28 accent-[var(--foreground)]" />
            <span className="w-5 tabular-nums text-foreground">{n}</span>
          </label>
        }
      >
        <BarCompare
          data={top}
          xKey="category"
          series={[{ key: "min_price", label: "Lowest", slot: 3 }, { key: "avg_price", label: "Average", slot: 2 }, { key: "max_price", label: "Highest", slot: 1 }]}
          format={gbp0}
          height={300}
          description="Lowest, average and highest price per category"
        />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rating vs price" subtitle="Average price at each star rating">
          <BarCompare data={byRating} xKey="rating" series={[{ key: "avg", label: "Average price" }]} format={gbp0} height={240} description="Average price by star rating" />
        </Card>
        <Card title="Price bands" subtitle="How many titles sit in each price range">
          <BarCompare data={bands} xKey="band" series={[{ key: "products", label: "Products" }]} height={240} description="Products per price band" />
        </Card>
      </div>
      <Card title="Stock levels" subtitle="Products in and out of stock, by category">
        <BarCompare data={stock} xKey="category" series={[{ key: "in", label: "In stock", slot: 1 }, { key: "out", label: "Out of stock", slot: 3 }]} stacked height={260} description="In and out of stock products by category" />
      </Card>
    </>
  );
}

function Health({ d }: { d: Data }) {
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
        description="Every run is tracked with row counts, timings, quality checks and rejected records."
        aside={<StatusPill ok={lastOk} label={lastOk ? "Last run succeeded" : "Last run failed"} />}
      />
      <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
        <input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} className="accent-[var(--foreground)]" />
        Include simulated runs
      </label>
      <Kpis
        cards={[
          { label: "Runs", value: int(runs.length) },
          { label: "Success rate", value: runs.length ? pct((ok / runs.length) * 100) : "–" },
          { label: "Average duration", value: sec(mean(real.map((r) => r.duration_s))), trend: real.map((r) => r.duration_s), slot: 2 },
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
          </p>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rows per run" subtitle="Loaded and rejected">
          <BarCompare data={rows} xKey="run" series={[{ key: "loaded", label: "Loaded", slot: 1 }, { key: "rejected", label: "Rejected", slot: 3 }]} stacked height={240} description="Rows loaded and rejected per run" />
        </Card>
        <Card title="Run duration" subtitle="Real runs only, all sources">
          <BarCompare data={real.map((r) => ({ run: `#${r.run_id} ${r.source}`, s: r.duration_s }))} xKey="run" series={[{ key: "s", label: "Seconds", slot: 2 }]} format={sec} height={240} description="Duration of each real run" />
        </Card>
      </div>
      <Card title="Data quality checks" subtitle="Latest run of each source">
        <Table
          rows={d.quality}
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
            { key: "record_key", label: "Record" },
            { key: "reason", label: "Reason" },
          ]}
        />
      </Card>
    </>
  );
}

/* ----------------------------------------------------------------- app -- */

const PAGES = [
  { id: "home", label: "Home", icon: LayoutGrid, view: Home },
  { id: "products", label: "Products", icon: Package, view: Products },
  { id: "history", label: "Price History", icon: History, view: PriceHistory },
  { id: "insights", label: "Insights", icon: BarChart3, view: Insights },
  { id: "health", label: "Pipeline Health", icon: Activity, view: Health },
] as const;

const route = () => {
  const id = window.location.hash.replace("#/", "").replace("#", "");
  return PAGES.some((p) => p.id === id) ? id : "home";
};

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(route);

  useEffect(() => {
    fetch("/data.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
    const onHash = () => { setPage(route()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const current = PAGES.find((p) => p.id === page)!;
  const View = current.view;
  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <aside className="border-b border-border bg-[oklch(0.17_0_0)] md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
        <div className="flex h-full flex-col gap-6 p-4 md:p-5">
          <a href="#/home" className="flex items-center gap-2.5 text-foreground no-underline">
            <span className="grid size-8 place-content-center rounded-[9px] bg-card ring-1 ring-border">
              <svg viewBox="0 0 32 32" className="size-5" aria-hidden><path d="M6 20l6-6 5 4 9-9" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <span className="grid leading-tight">
              <span className="text-[14px] font-semibold">PricePulse</span>
              <span className="text-[11.5px] text-muted-foreground">Price tracking pipeline</span>
            </span>
          </a>
          <nav aria-label="Pages" className="-mx-1 flex gap-1 overflow-x-auto md:mx-0 md:grid md:overflow-visible">
            {PAGES.map((p) => (
              <a
                key={p.id}
                href={`#/${p.id}`}
                aria-current={p.id === page ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13px] whitespace-nowrap no-underline transition-colors",
                  p.id === page ? "bg-card text-foreground ring-1 ring-border" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                <p.icon className="size-4" aria-hidden />
                {p.label}
              </a>
            ))}
          </nav>
          <div className="mt-auto hidden gap-3 text-[11.5px] leading-relaxed text-muted-foreground md:grid">
            {data && <p className="m-0">Snapshot exported {stamp(data.generated_at)}. Hollow squares and “sim” mark demo price moves; the source site never changes its prices.</p>}
            <a href={REPO} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-foreground no-underline hover:underline">
              <GithubMark className="size-4" /> Source on GitHub
            </a>
          </div>
        </div>
      </aside>
      <main className="mx-auto grid w-full max-w-[1240px] content-start gap-5 px-4 py-6 md:px-8 md:py-8">
        {error && <p className="text-[13px] text-red-400">Could not load data.json ({error}).</p>}
        {!data && !error && (
          <div className="grid gap-4" aria-busy>
            {[64, 96, 280].map((h) => <div key={h} className="animate-pulse rounded-[14px] bg-card" style={{ height: h }} />)}
          </div>
        )}
        {data && <View key={page} d={data} />}
        <footer className="mt-4 border-t border-border pt-4 text-[12px] text-muted-foreground md:hidden">
          <a href={REPO} className="text-foreground">Source on GitHub</a>
        </footer>
      </main>
    </div>
  );
}
