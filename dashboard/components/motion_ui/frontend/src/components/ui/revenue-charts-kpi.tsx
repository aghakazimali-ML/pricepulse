"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis, type TooltipProps } from "recharts";

/* Layro System · ChartCard (21st.dev: @uvain/revenue-charts-kpi). Composed from the Layro UI source into one file.
   Themed with shadcn/ui tokens; follows your globals.css in light and dark.
   PricePulse changes: Sparkline and KpiCard accept a `slot`; BarCompare accepts `layout="vertical"`. */

/* ------------------------------------------------------------ tokens -- */

const SQUIRCLE = "[corner-shape:squircle]";

/* ==========================================================================
   Charts

   Recharts underneath; the Layro rules on top, which are the rules that make
   a chart readable rather than decorative:

     · colour follows the series, in a fixed order (--chart-1 … --chart-5),
       never its rank — filtering a series out never repaints the others
     · one y-axis, always; two measures of different scale are two charts
     · thin marks: 2px lines, bars no wider than 24px with a 4px rounded end,
       area fills as a 10% wash, hairline solid gridlines
     · text never wears the series colour — values and labels stay in the
       text tokens, and a swatch beside them carries the identity
     · two or more series get a legend; every chart carries a tooltip and a
       visually hidden data table, so nothing depends on colour or hover

   Pieces:  ChartCard · AreaTrend · BarCompare · DonutBreakdown · Sparkline · KpiCard
   ========================================================================== */

export interface Series {
  /** Key in each data row. */
  key: string;
  label: string;
  /** Slot 1–5. Defaults to the series' position — keep it stable across filters. */
  slot?: 1 | 2 | 3 | 4 | 5;
}

const color = (s: Series, i: number) => `var(--chart-${s.slot ?? (i % 5) + 1})`;
const AXIS = { fill: "var(--muted-foreground)", fontSize: 11 };
const defaultFormat = (v: number) => v.toLocaleString();

/* ---------------------------------------------------------------- card -- */

export interface ChartCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right side of the header: a range select, a menu. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function ChartCard({ title, subtitle, actions, className, children, ...rest }: ChartCardProps) {
  return (
    <figure className={cn("m-0 grid gap-4 rounded-[18px] bg-card p-5 text-card-foreground ring-1 ring-border", SQUIRCLE, className)} {...rest}>
      <figcaption className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">{title}</span>
          {subtitle && <span className="text-[12px] text-muted-foreground">{subtitle}</span>}
        </div>
        {actions}
      </figcaption>
      {children}
    </figure>
  );
}

/* ------------------------------------------------------------ helpers -- */

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-hidden>
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="h-2 w-2 rounded-[3px]" style={{ background: color(s, i) }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
  format,
  labelFormat,
}: TooltipProps<number, string> & { series: Series[]; format: (v: number) => string; labelFormat?: (l: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[140px] rounded-[10px] bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-lg ring-1 ring-border">
      {label !== undefined && <p className="mb-1.5 font-medium">{labelFormat ? labelFormat(String(label)) : label}</p>}
      <ul className="grid gap-1">
        {payload.map((p) => {
          const i = series.findIndex((s) => s.key === p.dataKey);
          const s = series[i] ?? { key: String(p.dataKey), label: String(p.name) };
          return (
            <li key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2 w-2 rounded-[3px]" style={{ background: color(s, Math.max(i, 0)) }} />
                {s.label}
              </span>
              <span className="font-medium tabular-nums">{format(Number(p.value))}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DataTableFallback<T extends Record<string, unknown>>({
  caption,
  data,
  xKey,
  series,
  format,
}: {
  caption: string;
  data: T[];
  xKey: string;
  series: Series[];
  format: (v: number) => string;
}) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{xKey}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              <th scope="row">{String(row[xKey])}</th>
              {series.map((s) => (
                <td key={s.key}>{format(Number(row[s.key]))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface CartesianProps<T> {
  data: T[];
  xKey: keyof T & string;
  series: Series[];
  /** Value formatter for the axis, tooltip and table. */
  format?: (v: number) => string;
  /** Label formatter for the x-axis and tooltip. */
  xFormat?: (v: string) => string;
  height?: number;
  /** Accessible summary, read before the data table. */
  description: string;
  className?: string;
}

/* ---------------------------------------------------------- area trend -- */

export function AreaTrend<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  format = defaultFormat,
  xFormat,
  height = 220,
  description,
  stacked = false,
  className,
}: CartesianProps<T> & { stacked?: boolean }) {
  const id = React.useId().replace(/:/g, "");
  return (
    <div className={cn("grid gap-3", className)}>
      <Legend series={series} />
      <div role="img" aria-label={description} style={{ height }}>
        <div aria-hidden className="h-full w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color(s, i)} stopOpacity={0.14} />
                    <stop offset="100%" stopColor={color(s, i)} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={AXIS} tickMargin={8} tickFormatter={xFormat} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} tick={AXIS} tickFormatter={format} width={48} domain={["auto", "auto"]} />
              <RTooltip
                cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
                content={<ChartTooltip series={series} format={format} labelFormat={xFormat} />}
              />
              {series.map((s, i) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stackId={stacked ? "a" : undefined}
                  stroke={color(s, i)}
                  strokeWidth={2}
                  fill={`url(#${id}-${s.key})`}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: color(s, i) }}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <DataTableFallback caption={description} data={data} xKey={xKey} series={series} format={format} />
    </div>
  );
}

/* --------------------------------------------------------- bar compare -- */

export function BarCompare<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  format = defaultFormat,
  xFormat,
  height = 220,
  description,
  stacked = false,
  layout = "horizontal",
  className,
}: CartesianProps<T> & { stacked?: boolean; layout?: "horizontal" | "vertical" }) {
  const vertical = layout === "vertical";
  return (
    <div className={cn("grid gap-3", className)}>
      <Legend series={series} />
      <div role="img" aria-label={description} style={{ height }}>
        <div aria-hidden className="h-full w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout={vertical ? "vertical" : "horizontal"} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
              <CartesianGrid vertical={vertical} horizontal={!vertical} stroke="var(--border)" />
              {vertical ? (
                <>
                  <XAxis type="number" tickLine={false} axisLine={false} tick={AXIS} tickFormatter={format} />
                  <YAxis type="category" dataKey={xKey} tickLine={false} axisLine={false} tick={AXIS} width={128} interval={0} />
                </>
              ) : (
                <>
                  <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={AXIS} tickMargin={8} tickFormatter={xFormat} />
                  <YAxis tickLine={false} axisLine={false} tick={AXIS} tickFormatter={format} width={48} />
                </>
              )}
              <RTooltip cursor={{ fill: "var(--accent)", opacity: 0.6 }} content={<ChartTooltip series={series} format={format} labelFormat={xFormat} />} />
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId={stacked ? "a" : undefined}
                  fill={color(s, i)}
                  maxBarSize={vertical ? 14 : 24}
                  radius={stacked && i < series.length - 1 ? 0 : vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                  stroke={stacked ? "var(--card)" : undefined}
                  strokeWidth={stacked ? 2 : 0}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <DataTableFallback caption={description} data={data} xKey={xKey} series={series} format={format} />
    </div>
  );
}

/* ------------------------------------------------------ donut breakdown -- */

export interface DonutSlice {
  label: string;
  value: number;
  slot?: 1 | 2 | 3 | 4 | 5;
}

export function DonutBreakdown({
  data,
  format = defaultFormat,
  centerLabel = "Total",
  description,
  size = 176,
  className,
}: {
  data: DonutSlice[];
  format?: (v: number) => string;
  centerLabel?: string;
  description: string;
  size?: number;
  className?: string;
}) {
  const total = data.reduce((n, d) => n + d.value, 0);
  const series: Series[] = data.map((d, i) => ({ key: d.label, label: d.label, slot: d.slot ?? (((i % 5) + 1) as 1) }));
  return (
    <div className={cn("flex flex-wrap items-center gap-6", className)}>
      <div role="img" aria-label={description} className="relative shrink-0" style={{ width: size, height: size }}>
        <div aria-hidden className="h-full w-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius="68%"
                outerRadius="100%"
                stroke="var(--card)"
                strokeWidth={2}
                startAngle={90}
                endAngle={-270}
                rootTabIndex={-1}
                isAnimationActive={false}
              >
                {data.map((d, i) => (
                  <Cell key={d.label} fill={color(series[i], i)} />
                ))}
              </Pie>
              <RTooltip content={<ChartTooltip series={[]} format={format} />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
          <span className="text-[11px] text-muted-foreground">{centerLabel}</span>
          <span className="text-[17px] font-semibold tabular-nums">{format(total)}</span>
        </div>
      </div>
      <ul className="grid max-w-[340px] min-w-[180px] flex-1 gap-2">
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center justify-between gap-4 text-[12.5px]">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color(series[i], i) }} />
              {d.label}
            </span>
            <span className="tabular-nums">
              <span className="font-medium">{format(d.value)}</span>
              <span className="ml-2 text-muted-foreground">{total ? Math.round((d.value / total) * 100) : 0}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------- sparkline and KPI -- */

export function Sparkline({
  data,
  slot = 1,
  height = 36,
  className,
}: {
  data: number[];
  slot?: 1 | 2 | 3 | 4 | 5;
  height?: number;
  className?: string;
}) {
  const rows = data.map((v, i) => ({ i, v }));
  return (
    <div aria-hidden className={className} style={{ height }}>
      <div aria-hidden className="h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Line type="monotone" dataKey="v" stroke={`var(--chart-${slot})`} strokeWidth={2} dot={false} isAnimationActive={false} strokeLinecap="round" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export interface KpiCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  /** Change vs the previous period, as a fraction: 0.124 = +12.4%. */
  delta?: number;
  /** Whether up is good (revenue) or bad (churn). Default "up". */
  good?: "up" | "down";
  /** What the delta compares against: "vs last month". */
  period?: string;
  trend?: number[];
  slot?: 1 | 2 | 3 | 4 | 5;
}

export function KpiCard({ label, value, delta, good = "up", period, trend, slot = 1, className, ...rest }: KpiCardProps) {
  const up = (delta ?? 0) >= 0;
  const positive = delta === undefined ? null : (up && good === "up") || (!up && good === "down");
  return (
    <div className={cn("grid gap-2 rounded-[14px] bg-card p-4 text-card-foreground ring-1 ring-border", SQUIRCLE, className)} {...rest}>
      <p className="text-[12px] font-medium text-muted-foreground">{label}</p>
      <div className="flex items-end justify-between gap-3">
        <p className="text-[24px] leading-none font-semibold tracking-[-0.02em] tabular-nums">{value}</p>
        {trend && trend.length > 1 && <Sparkline data={trend} className="w-20" slot={slot} height={28} />}
      </div>
      {delta !== undefined && (
        <p className="flex items-center gap-1 text-[12px]">
          <span className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", positive ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
            {up ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
            <span className="sr-only">{up ? "Up" : "Down"} </span>
            {Math.abs(delta * 100).toFixed(1)}%
          </span>
          {period && <span className="text-muted-foreground">{period}</span>}
        </p>
      )}
    </div>
  );
}

export { ChartCard as Component };
