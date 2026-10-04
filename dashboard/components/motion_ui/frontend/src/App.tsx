import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AreaTrend, BarCompare, ChartCard, DonutBreakdown, KpiCard, type Series } from "@/components/ui/revenue-charts-kpi";
import { cn } from "@/lib/utils";
import { Streamlit } from "./streamlit.js";

/* Value formats are passed from Python by name, since functions can't cross the iframe. */
const FORMATS: Record<string, (v: number) => string> = {
  int: (v) => Math.round(v).toLocaleString("en-GB"),
  gbp: (v) => `£${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  gbp0: (v) => `£${Math.round(v).toLocaleString("en-GB")}`,
  pct: (v) => `${v.toFixed(1)}%`,
  sec: (v) => `${v.toFixed(1)}s`,
};
const fmt = (name?: string) => FORMATS[name ?? "int"] ?? FORMATS.int;
const xFormats: Record<string, (v: string) => string> = {
  date: (v) => new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
  run: (v) => `#${v}`,
};

/* Subtle entrance only: a short fade with a 4px rise. */
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

/* ---------------------------------------------------------------- views -- */

interface HeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  status?: { ok: boolean; label: string };
  meta?: string[];
}

function Header({ eyebrow, title, description, status, meta = [] }: HeaderProps) {
  return (
    <Reveal>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div className="grid gap-1.5">
          {eyebrow && <p className="text-[12px] font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</p>}
          <h1 className="m-0 text-[26px] leading-tight font-semibold tracking-[-0.025em]">{title}</h1>
          {description && <p className="m-0 max-w-[640px] text-[13.5px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        <div className="grid justify-items-end gap-1.5 text-[12px] text-muted-foreground">
          {status && (
            <span className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 ring-1 ring-border">
              <span className={cn("size-1.5 rounded-full", status.ok ? "bg-emerald-400" : "bg-red-400")} />
              <span className="text-foreground">{status.label}</span>
            </span>
          )}
          {meta.map((m) => (
            <span key={m} className="tabular-nums">{m}</span>
          ))}
        </div>
      </header>
    </Reveal>
  );
}

interface KpiInput {
  label: string;
  value: number | string;
  format?: string;
  delta?: number;
  good?: "up" | "down";
  period?: string;
  trend?: number[];
}

function Kpis({ cards = [] }: { cards: KpiInput[] }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(180px, 1fr))` }}>
      {cards.map((c, i) => (
        <Reveal key={c.label} delay={i * 0.04} className="h-full">
          <KpiCard
            className="h-full content-start"
            label={c.label}
            value={typeof c.value === "number" ? fmt(c.format)(c.value) : c.value}
            delta={c.delta ?? undefined}
            good={c.good}
            period={c.period}
            trend={c.trend}
          />
        </Reveal>
      ))}
    </div>
  );
}

interface ChartProps {
  title: string;
  subtitle?: string;
  data: Record<string, unknown>[];
  xKey: string;
  series: Series[];
  format?: string;
  xFormat?: string;
  height?: number;
  description: string;
  stacked?: boolean;
  layout?: "horizontal" | "vertical";
}

function Area(p: ChartProps) {
  return (
    <Reveal>
      <ChartCard title={p.title} subtitle={p.subtitle}>
        <AreaTrend data={p.data} xKey={p.xKey} series={p.series} format={fmt(p.format)} xFormat={p.xFormat ? xFormats[p.xFormat] : undefined}
          height={p.height} description={p.description} stacked={p.stacked} />
      </ChartCard>
    </Reveal>
  );
}

function Bars(p: ChartProps) {
  return (
    <Reveal>
      <ChartCard title={p.title} subtitle={p.subtitle}>
        <BarCompare data={p.data} xKey={p.xKey} series={p.series} format={fmt(p.format)} xFormat={p.xFormat ? xFormats[p.xFormat] : undefined}
          height={p.height} description={p.description} stacked={p.stacked} layout={p.layout} />
      </ChartCard>
    </Reveal>
  );
}

function Donut(p: { title: string; subtitle?: string; data: { label: string; value: number }[]; format?: string; centerLabel?: string; description: string }) {
  return (
    <Reveal>
      <ChartCard title={p.title} subtitle={p.subtitle}>
        <DonutBreakdown data={p.data} format={fmt(p.format)} centerLabel={p.centerLabel} description={p.description} />
      </ChartCard>
    </Reveal>
  );
}

interface Run { id: number; status: string; source: string; simulated: boolean; label: string }

function Runs({ runs = [], title = "Recent runs" }: { runs: Run[]; title?: string }) {
  const [active, setActive] = useState<Run | null>(null);
  const shown = active ?? runs[runs.length - 1];
  return (
    <Reveal>
      <ChartCard title={title} subtitle="Each square is one run. Hover for details, click to inspect.">
        <div className="flex flex-wrap gap-1.5">
          {runs.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-label={`Run ${r.id}: ${r.status}`}
              onMouseEnter={() => setActive(r)}
              onFocus={() => setActive(r)}
              onClick={() => Streamlit.setComponentValue(r.id)}
              className={cn(
                "size-4 cursor-pointer rounded-[4px] border-0 p-0 outline-none transition-transform hover:scale-125 focus-visible:ring-2 focus-visible:ring-ring",
                r.simulated ? "bg-transparent ring-1 ring-[var(--chart-2)] ring-inset"
                  : r.status === "success" ? "bg-[var(--chart-4)]"
                  : r.status === "failed" ? "bg-red-400" : "bg-[var(--chart-3)]",
              )}
            />
          ))}
        </div>
        {shown && (
          <p className="m-0 text-[12.5px] text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">Run #{shown.id}</span> · {shown.source} ·{" "}
            <span className={shown.status === "failed" ? "text-red-400" : "text-foreground"}>{shown.status}</span>
            {shown.simulated ? " · simulated" : ""} · {shown.label}
          </p>
        )}
      </ChartCard>
    </Reveal>
  );
}

/* ------------------------------------------------------------------ app -- */

const VIEWS: Record<string, (props: any) => ReactNode> = { header: Header, kpis: Kpis, area: Area, bar: Bars, donut: Donut, runs: Runs };

export default function App() {
  const [args, setArgs] = useState<{ kind: string; props: Record<string, unknown> } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = Streamlit.onRender(setArgs);
    Streamlit.ready();
    return off;
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => Streamlit.setFrameHeight(el.scrollHeight + 2));
    observer.observe(el);
    return () => observer.disconnect();
  }, [args]);

  if (!args) return null;
  const View = VIEWS[args.kind];
  return <div ref={rootRef} className="p-px">{View ? <View {...args.props} /> : null}</div>;
}
