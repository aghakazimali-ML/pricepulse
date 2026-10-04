/* Live scraper behind /api/scrape: fetches a public web page or JSON API and turns it into tables.

   Safety: http(s) only, public hosts only (every DNS answer and every redirect hop is checked),
   a 10 s timeout, a 3 MB body cap, robots.txt honoured for HTML pages, and a per-instance rate limit. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parse, type HTMLElement } from "node-html-parser";

export type Cell = string | number | boolean | null;
export interface Dataset { name: string; description: string; columns: string[]; rows: Record<string, Cell>[] }
export interface ScrapeResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  kind: "html" | "json";
  bytes: number;
  pages: number;
  ms: number;
  robots: "allowed" | "disallowed" | "not found" | "skipped";
  meta: Record<string, string | number>;
  datasets: Dataset[];
}
export interface ScrapeOptions { mode?: "auto" | "html" | "json"; selector?: string; pages?: number; allowPrivate?: boolean }

export class ScrapeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const UA = "PricePulseBot/1.0 (+https://github.com/aghakazimali-ML/pricepulse)";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_ROWS = 500;
const PRICE = /(?:[£$€¥₹]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|PKR|INR|€))/;

/* ------------------------------------------------------------- network -- */

function privateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

async function assertPublic(url: URL, allowPrivate: boolean) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ScrapeError("Only http and https URLs are supported.");
  if (url.username || url.password) throw new ScrapeError("URLs with credentials are not allowed.");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new ScrapeError("Private addresses are not allowed.");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new ScrapeError(`Could not resolve ${host}.`); });
  if (addrs.some((a) => privateIp(a.address))) throw new ScrapeError("Private addresses are not allowed.");
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); throw new ScrapeError("The response is larger than 3 MB.", 413); }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder("utf-8").decode(buf);
}

async function get(url: URL, allowPrivate: boolean, accept: string): Promise<{ res: Response; url: URL }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(current, allowPrivate);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": UA, accept, "accept-language": "en" },
    }).catch((e: Error) => { throw new ScrapeError(e.name === "TimeoutError" ? "The site took longer than 10 seconds to respond." : `Could not reach the site (${e.message}).`, 502); });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current); continue; }
    return { res, url: current };
  }
  throw new ScrapeError("Too many redirects.", 502);
}

async function robotsAllows(url: URL, allowPrivate: boolean): Promise<ScrapeResult["robots"]> {
  try {
    const { res } = await get(new URL("/robots.txt", url), allowPrivate, "text/plain");
    if (!res.ok) return "not found";
    const txt = (await readCapped(res)).split(/\r?\n/);
    let applies = false;
    const rules: { allow: boolean; path: string }[] = [];
    for (const raw of txt) {
      const line = raw.replace(/#.*/, "").trim();
      const [k, ...rest] = line.split(":");
      const v = rest.join(":").trim();
      if (/^user-agent$/i.test(k)) applies = v === "*" || /pricepulse/i.test(v);
      else if (applies && /^(dis)?allow$/i.test(k) && v) rules.push({ allow: /^allow$/i.test(k), path: v });
    }
    const path = url.pathname + url.search;
    const match = rules.filter((r) => path.startsWith(r.path.replace(/\*.*$/, ""))).sort((a, b) => b.path.length - a.path.length)[0];
    return match && !match.allow ? "disallowed" : "allowed";
  } catch {
    return "not found";
  }
}

/* ---------------------------------------------------------------- json -- */

function flatten(obj: unknown, prefix = "", out: Record<string, Cell> = {}, depth = 0): Record<string, Cell> {
  if (obj === null || typeof obj !== "object") { out[prefix || "value"] = obj as Cell; return out; }
  if (Array.isArray(obj)) {
    out[prefix || "value"] = obj.every((v) => v === null || typeof v !== "object") ? obj.join(", ") : `[${obj.length} items]`;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < 2) flatten(v, key, out, depth + 1);
    else if (Array.isArray(v) || (v !== null && typeof v === "object")) flatten(v, key, out, 3);
    else out[key] = v as Cell;
  }
  return out;
}

function arrays(node: unknown, path: string, found: { path: string; items: unknown[] }[], depth = 0) {
  if (depth > 5 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    if (node.length && node.some((v) => v && typeof v === "object" && !Array.isArray(v))) found.push({ path: path || "root", items: node });
    node.slice(0, 3).forEach((v, i) => arrays(v, `${path}[${i}]`, found, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(node)) arrays(v, path ? `${path}.${k}` : k, found, depth + 1);
}

function toDataset(name: string, description: string, rows: Record<string, Cell>[]): Dataset {
  const columns: string[] = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!columns.includes(k)) columns.push(k); }));
  return { name, description, columns: columns.slice(0, 40), rows: rows.slice(0, MAX_ROWS) };
}

export function extractJson(data: unknown): Dataset[] {
  const found: { path: string; items: unknown[] }[] = [];
  arrays(data, "", found);
  found.sort((a, b) => b.items.length - a.items.length);
  const sets = found.slice(0, 3).map((f) =>
    toDataset(f.path, `${f.items.length} records at ${f.path}`, f.items.filter((v) => v && typeof v === "object").map((v) => flatten(v))));
  if (!sets.length) sets.push(toDataset("response", "The response as a single record", [flatten(data)]));
  return sets;
}

/* ---------------------------------------------------------------- html -- */

const text = (el: HTMLElement | null | undefined) => (el?.text ?? "").replace(/\s+/g, " ").trim();
const abs = (href: string | undefined, base: URL) => { try { return href ? new URL(href, base).toString() : ""; } catch { return ""; } };
const num = (s: string) => { const m = s.replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
const RATING_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

function signature(el: HTMLElement) {
  return `${el.tagName}.${(el.getAttribute("class") ?? "").trim().split(/\s+/).filter((c) => !/\d/.test(c)).sort().join(".")}`;
}

function fields(el: HTMLElement, base: URL): Record<string, Cell> {
  const link = el.querySelector("a[href]");
  const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
  const img = el.querySelector("img");
  const titled = el.querySelector("[title]");
  const title = titled?.getAttribute("title") || text(heading) || img?.getAttribute("alt") || text(link) || text(el).slice(0, 120);
  const full = (el.structuredText ?? el.text).replace(/\s+/g, " ");
  const priceMatch = full.match(PRICE);
  const ratingEl = el.querySelector("[class*=star], [class*=rating]");
  const ratingWord = (ratingEl?.getAttribute("class") ?? "").toLowerCase().split(/\s+/).find((c) => c in RATING_WORDS);
  const ratingText = ratingEl ? (ratingEl.getAttribute("aria-label") || ratingEl.getAttribute("title") || text(ratingEl)) : "";
  const row: Record<string, Cell> = { title };
  if (priceMatch) { row.price_text = priceMatch[0]; row.price = num(priceMatch[0]); }
  if (ratingWord) row.rating = RATING_WORDS[ratingWord];
  else if (ratingText && num(ratingText) !== null) row.rating = num(ratingText);
  const stock = full.match(/(out of stock|sold out|unavailable|in stock|available)/i);
  if (stock) row.availability = stock[0];
  if (link) row.link = abs(link.getAttribute("href"), base);
  if (img) row.image = abs(img.getAttribute("src") || img.getAttribute("data-src"), base);
  return row;
}

/* For a user selector: the text of each classed leaf element inside the item, keyed by its class. */
function classFields(el: HTMLElement): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const child of el.querySelectorAll("[class]")) {
    const key = (child.getAttribute("class") ?? "").trim().split(/\s+/)[0];
    const value = text(child);
    if (!key || !value || value.length > 300 || child.querySelectorAll("[class]").length > 3) continue;
    out[key] = key in out ? `${out[key]}, ${value}` : value;
    if (Object.keys(out).length >= 12) break;
  }
  return out;
}

/* Repeated elements that each carry a price (product cards). */
function priceCards(root: HTMLElement, base: URL): Record<string, Cell>[] {
  const groups = new Map<string, HTMLElement[]>();
  for (const el of root.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "HTML", "BODY", "HEAD"].includes(el.tagName)) continue;
    const own = el.childNodes.filter((n) => n.nodeType === 3).map((n) => n.rawText).join(" ");
    if (!PRICE.test(own)) continue;
    // Climb to the nearest ancestor that also holds a link or an image: the card.
    let card: HTMLElement | null = el;
    for (let i = 0; i < 6 && card && !(card.querySelector("a[href]") && (card.querySelector("img") || card.querySelector("h1,h2,h3,h4,h5,h6"))); i++) card = card.parentNode as HTMLElement | null;
    if (!card || card.tagName === "BODY" || card.tagName === "HTML") continue;
    const key = signature(card);
    const list = groups.get(key) ?? [];
    if (!list.includes(card)) list.push(card);
    groups.set(key, list);
  }
  const best = [...groups.values()].filter((g) => g.length >= 3).sort((a, b) => b.length - a.length)[0];
  return best ? best.map((el) => fields(el, base)) : [];
}

function jsonLd(root: HTMLElement): Record<string, Cell>[] {
  const out: Record<string, Cell>[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    const type = [].concat(n["@type"] ?? []).join(",");
    if (/Product|Offer|Book|Event|JobPosting|Recipe|Article|LocalBusiness/i.test(type)) {
      const offer = Array.isArray(n.offers) ? n.offers[0] : n.offers;
      out.push({
        type, name: n.name ?? n.headline ?? null,
        price: offer?.price != null ? Number(offer.price) : null, currency: offer?.priceCurrency ?? null,
        availability: typeof offer?.availability === "string" ? offer.availability.split("/").pop() : null,
        rating: n.aggregateRating?.ratingValue != null ? Number(n.aggregateRating.ratingValue) : null,
        url: n.url ?? null,
      });
    }
    Object.values(n).forEach(visit);
  };
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(s.text)); } catch { /* ignore malformed blocks */ }
  }
  return out;
}

function tables(root: HTMLElement): Dataset[] {
  return root.querySelectorAll("table").map((t, i) => {
    const trs = t.querySelectorAll("tr");
    const head = trs[0]?.querySelectorAll("th").length ? trs[0].querySelectorAll("th").map(text) : null;
    const body = (head ? trs.slice(1) : trs).map((tr) => tr.querySelectorAll("td, th").map(text)).filter((r) => r.length);
    const width = Math.max(0, ...body.map((r) => r.length));
    const cols = (head ?? Array.from({ length: width }, (_, j) => `column_${j + 1}`)).map((c, j) => c || `column_${j + 1}`);
    const rows = body.map((r) => Object.fromEntries(cols.map((c, j) => [c, r[j] ?? null])));
    return toDataset(`table ${i + 1}`, `HTML table with ${rows.length} rows`, rows);
  }).filter((d) => d.rows.length >= 2).slice(0, 3);
}

export function extractHtml(html: string, base: URL, selector?: string): { meta: Record<string, string | number>; datasets: Dataset[] } {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true } });
  const metaTag = (n: string) => root.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.getAttribute("content") ?? "";
  const links = root.querySelectorAll("a[href]");
  const meta: Record<string, string | number> = {
    title: text(root.querySelector("title")),
    description: metaTag("description") || metaTag("og:description"),
    h1: text(root.querySelector("h1")),
    links: links.length,
    images: root.querySelectorAll("img").length,
  };
  const datasets: Dataset[] = [];
  if (selector) {
    let items: HTMLElement[];
    try { items = root.querySelectorAll(selector); } catch { throw new ScrapeError("That CSS selector is not valid."); }
    datasets.push(toDataset(`selector ${selector}`, `${items.length} elements matching ${selector}`, items.map((el) => ({ ...classFields(el), ...fields(el, base) }))));
  }
  const cards = priceCards(root, base);
  if (cards.length) datasets.push(toDataset("products", `${cards.length} repeated items with prices`, cards));
  const ld = jsonLd(root);
  if (ld.length) datasets.push(toDataset("structured data", `${ld.length} schema.org records (JSON-LD)`, ld));
  datasets.push(...tables(root));
  if (!datasets.some((d) => d.rows.length)) {
    const headings = root.querySelectorAll("h1, h2, h3").map((h) => ({ level: h.tagName.toLowerCase(), text: text(h) })).filter((h) => h.text);
    if (headings.length) datasets.push(toDataset("headings", "Page headings", headings));
  }
  const seen = new Set<string>();
  const linkRows = links.map((a) => ({ text: text(a) || a.getAttribute("title") || "", url: abs(a.getAttribute("href"), base) }))
    .filter((l) => l.url.startsWith("http") && !seen.has(l.url) && seen.add(l.url));
  datasets.push(toDataset("links", `${linkRows.length} unique links`, linkRows));
  return { meta, datasets };
}

/* The "next page" link of a paginated listing, if there is one. */
export function nextLink(html: string, base: URL): URL | null {
  const root = parse(html, { comment: false });
  const rel = root.querySelector('link[rel="next"]') ?? root.querySelector('a[rel="next"]');
  const candidates = rel ? [rel] : root.querySelectorAll("a[href]").filter((a) => {
    const cls = `${a.getAttribute("class") ?? ""} ${(a.parentNode as HTMLElement | null)?.getAttribute?.("class") ?? ""}`;
    const label = `${text(a)} ${a.getAttribute("aria-label") ?? ""} ${a.getAttribute("title") ?? ""}`.trim();
    return /(^|\s)next(\s|$)/i.test(cls) || /^(next|next page|older|more)\b|^[›»→]$/i.test(label) || /\bnext\b/i.test(a.getAttribute("rel") ?? "");
  });
  for (const el of candidates) {
    const href = el.getAttribute("href");
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.host === base.host && u.toString() !== base.toString()) return u;
    } catch { /* skip bad hrefs */ }
  }
  return null;
}

/* Concatenate same-named datasets from several pages (links are de-duplicated). */
function merge(all: Dataset[][]): Dataset[] {
  const out: Dataset[] = [];
  for (const sets of all) for (const d of sets) {
    const prev = out.find((o) => o.name === d.name);
    if (!prev) { out.push({ ...d, rows: [...d.rows] }); continue; }
    d.columns.forEach((c) => { if (!prev.columns.includes(c)) prev.columns.push(c); });
    const seen = new Set(prev.rows.map((r) => JSON.stringify(r)));
    for (const r of d.rows) if (prev.rows.length < MAX_ROWS * 2 && !seen.has(JSON.stringify(r))) prev.rows.push(r);
  }
  for (const d of out) {
    const n = d.rows.length;
    d.description = d.description.replace(/^\d+/, String(n));
  }
  return out;
}

/* ----------------------------------------------------------------- api -- */

export async function scrape(raw: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  let url: URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) && !/^https?:\/\//i.test(raw.trim())) throw new ScrapeError("Only http and https URLs are supported.");
  try { url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); } catch { throw new ScrapeError("That doesn't look like a valid URL."); }
  const started = Date.now();
  const mode = opts.mode ?? "auto";
  const allowPrivate = Boolean(opts.allowPrivate);
  const robots = mode === "json" ? "skipped" : await robotsAllows(url, allowPrivate);
  if (robots === "disallowed") throw new ScrapeError("This site's robots.txt asks bots not to scrape this page, so PricePulse skips it.", 403);
  const { res, url: finalUrl } = await get(url, allowPrivate, mode === "json" ? "application/json" : "text/html,application/json;q=0.9,*/*;q=0.8");
  const body = await readCapped(res);
  if (!res.ok) throw new ScrapeError(`The site answered with HTTP ${res.status}.`, 502);
  const contentType = res.headers.get("content-type") ?? "";
  const looksJson = mode === "json" || /json/i.test(contentType) || (mode === "auto" && /^\s*[[{]/.test(body));
  const base = { url: url.toString(), finalUrl: finalUrl.toString(), status: res.status, contentType, bytes: body.length, robots };
  if (looksJson) {
    let data: unknown;
    try { data = JSON.parse(body); } catch { throw new ScrapeError("The response is not valid JSON."); }
    const datasets = extractJson(data);
    return { ...base, pages: 1, kind: "json", ms: Date.now() - started, meta: { records: datasets[0]?.rows.length ?? 0 }, datasets };
  }
  const selector = opts.selector?.trim() || undefined;
  const first = extractHtml(body, finalUrl, selector);
  const pages = [first.datasets];
  const maxPages = Math.min(10, Math.max(1, Math.floor(opts.pages ?? 1)));
  let bytes = body.length;
  let next = maxPages > 1 ? nextLink(body, finalUrl) : null;
  const visited = new Set([finalUrl.toString()]);
  while (next && pages.length < maxPages && Date.now() - started < 20_000 && !visited.has(next.toString())) {
    visited.add(next.toString());
    try {
      const page = await get(next, allowPrivate, "text/html");
      const html = await readCapped(page.res);
      if (!page.res.ok) break;
      bytes += html.length;
      pages.push(extractHtml(html, page.url, selector).datasets);
      next = nextLink(html, page.url);
    } catch { break; }
  }
  return { ...base, bytes, pages: pages.length, kind: "html", ms: Date.now() - started, meta: first.meta, datasets: pages.length > 1 ? merge(pages) : first.datasets };
}

/* Per-instance rate limit: 20 requests a minute per client IP. */
const hits = new Map<string, number[]>();
export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 20;
}
