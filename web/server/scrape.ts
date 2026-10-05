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
export interface ScrapeOptions { mode?: "auto" | "html" | "json"; selector?: string; pages?: number; allowPrivate?: boolean; recipe?: Recipe }

/* A user-built extraction plan, like a Web Scraper sitemap: an item selector, named fields,
   an optional next-page selector, and optionally a link to open for each item's detail page. */
export interface FieldSpec { name: string; selector: string; type: "text" | "number" | "link" | "image" | "attr" | "html"; attr?: string; multiple?: boolean }
export interface Recipe { item?: string; fields: FieldSpec[]; next?: string; follow?: { field: string; fields: FieldSpec[]; limit?: number } }
const FIELD_TYPES = ["text", "number", "link", "image", "attr", "html"];

export function parseRecipe(raw: unknown): Recipe | undefined {
  if (raw == null || raw === "") return undefined;
  let r: any;
  try { r = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new ScrapeError("The field recipe is not valid JSON."); }
  const cleanFields = (fs: unknown): FieldSpec[] => (Array.isArray(fs) ? fs : []).slice(0, 30).map((f: any) => ({
    name: String(f?.name ?? "").trim().slice(0, 60),
    selector: String(f?.selector ?? "").trim().slice(0, 300),
    type: FIELD_TYPES.includes(f?.type) ? f.type : "text",
    attr: f?.attr ? String(f.attr).trim().slice(0, 60) : undefined,
    multiple: Boolean(f?.multiple),
  })).filter((f) => f.name);
  const recipe: Recipe = { item: r?.item ? String(r.item).trim().slice(0, 300) : undefined, fields: cleanFields(r?.fields), next: r?.next ? String(r.next).trim().slice(0, 300) : undefined };
  if (r?.follow?.field) recipe.follow = { field: String(r.follow.field), fields: cleanFields(r.follow.fields), limit: Math.min(25, Math.max(1, Number(r.follow.limit) || 10)) };
  if (!recipe.fields.length) throw new ScrapeError("Add at least one field with a name to the recipe.");
  return recipe;
}

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

const robotsCache = new Map<string, { at: number; txt: string[] | null }>();
async function robotsAllows(url: URL, allowPrivate: boolean): Promise<ScrapeResult["robots"]> {
  try {
    let cached = robotsCache.get(url.origin);
    if (!cached || Date.now() - cached.at > 600_000) {
      const { res } = await get(new URL("/robots.txt", url), allowPrivate, "text/plain");
      cached = { at: Date.now(), txt: res.ok ? (await readCapped(res)).split(/\r?\n/) : null };
      if (robotsCache.size > 500) robotsCache.clear();
      robotsCache.set(url.origin, cached);
    }
    if (!cached.txt) return "not found";
    const txt = cached.txt;
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
  const leaf = el.querySelectorAll("span, p, div, small, strong, em, td").filter((c) => c.childNodes.every((n) => n.nodeType === 3)).map(text).sort((a, b) => b.length - a.length)[0];
  const linkText = text(link);
  const title = titled?.getAttribute("title") || text(heading) || img?.getAttribute("alt") || (linkText.length > 12 ? linkText : "") || leaf || linkText || text(el).slice(0, 120);
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
  const time = el.querySelector("time");
  if (time) row.date = time.getAttribute("datetime") || text(time);
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

/* Repeated items without prices: articles, job posts, listings, search results.
   Siblings that share a tag and class, each holding a link plus a heading, image, paragraph or date. */
function repeatedItems(root: HTMLElement, base: URL): Record<string, Cell>[] {
  const groups = new Map<string, HTMLElement[]>();
  for (const el of root.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "HTML", "BODY", "HEAD", "NAV", "HEADER", "FOOTER"].includes(el.tagName)) continue;
    const sig = signature(el);
    if (sig.endsWith(".") && !["LI", "ARTICLE", "TR", "SECTION"].includes(el.tagName)) continue;
    if (el.closest("nav, header, footer")) continue;
    const t = text(el);
    if (t.length < 20 || t.length > 3000) continue;
    if (!el.querySelector("a[href]")) continue;
    if (!el.querySelector("h1, h2, h3, h4, h5, h6, img, p, time") && el.querySelectorAll("[class]").length < 3) continue;
    const parent = el.parentNode as HTMLElement | null;
    const key = `${parent ? signature(parent) : ""}>${sig}`;
    groups.set(key, [...(groups.get(key) ?? []), el]);
  }
  const avgLen = (g: HTMLElement[]) => g.reduce((n, el) => n + Math.min(400, text(el).length), 0) / g.length;
  const best = [...groups.values()].filter((g) => g.length >= 3).sort((a, b) => b.length - a.length || avgLen(b) - avgLen(a))[0];
  return best ? best.map((el) => ({ ...fields(el, base), ...classFields(el) })) : [];
}

/* JSON that JavaScript apps ship inside the page (Next.js __NEXT_DATA__, application/json blocks). */
function embeddedJson(root: HTMLElement): Dataset[] {
  const out: Dataset[] = [];
  for (const s of root.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]')) {
    try {
      const sets = extractJson(JSON.parse(s.text)).filter((d) => d.rows.length >= 3);
      out.push(...sets.map((d) => ({ ...d, name: `embedded data ${d.name}`.slice(0, 60), description: `${d.rows.length} records from JSON embedded in the page` })));
    } catch { /* not JSON */ }
  }
  return out.sort((a, b) => b.rows.length - a.rows.length).slice(0, 2);
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

export function extractHtml(html: string, base: URL, selector?: string, recipe?: Recipe): { meta: Record<string, string | number>; datasets: Dataset[] } {
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
  if (recipe) {
    const rows = recipeRows(root, base, recipe.fields, recipe.item);
    datasets.push({ name: "custom fields", description: `${rows.length} items from your field recipe`, columns: recipe.fields.map((f) => f.name), rows });
  }
  if (selector) {
    let items: HTMLElement[];
    try { items = root.querySelectorAll(selector); } catch { throw new ScrapeError("That CSS selector is not valid."); }
    datasets.push(toDataset(`selector ${selector}`, `${items.length} elements matching ${selector}`, items.map((el) => ({ ...classFields(el), ...fields(el, base) }))));
  }
  const cards = priceCards(root, base);
  if (cards.length) datasets.push(toDataset("products", `${cards.length} repeated items with prices`, cards));
  const ld = jsonLd(root);
  if (ld.length) datasets.push(toDataset("structured data", `${ld.length} schema.org records (JSON-LD)`, ld));
  if (!cards.length) {
    const items = repeatedItems(root, base);
    if (items.length) datasets.push(toDataset("items", `${items.length} repeated items`, items));
  }
  datasets.push(...embeddedJson(root));
  datasets.push(...tables(root));
  // Little visible text but plenty of script: the content is rendered by JavaScript in the browser.
  const bodyText = text(root.querySelector("body") ?? root).length;
  if (bodyText < 400 && root.querySelectorAll("script").length >= 1) meta.needs_js = 1;
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

/* --------------------------------------------------------------- recipe -- */

function selectAll(scope: HTMLElement, selector: string): HTMLElement[] {
  if (!selector || selector === "_self") return [scope];
  try { return scope.querySelectorAll(selector); } catch { throw new ScrapeError(`"${selector}" is not a valid CSS selector.`); }
}

function fieldValue(el: HTMLElement, f: FieldSpec, base: URL): Cell {
  switch (f.type) {
    case "link": return abs((el.tagName === "A" ? el : el.querySelector("a[href]") ?? el).getAttribute("href"), base) || null;
    case "image": { const img = el.tagName === "IMG" ? el : el.querySelector("img"); return abs(img?.getAttribute("src") || img?.getAttribute("data-src"), base) || null; }
    case "attr": return el.getAttribute(f.attr || "href") ?? null;
    case "html": return el.innerHTML.trim().slice(0, 5000);
    case "number": return num(text(el));
    default: return text(el);
  }
}

export function recipeRows(root: HTMLElement, base: URL, fields: FieldSpec[], item?: string): Record<string, Cell>[] {
  const items = item ? selectAll(root, item) : [root];
  return items.slice(0, MAX_ROWS).map((el) => {
    const row: Record<string, Cell> = {};
    for (const f of fields) {
      const hits = selectAll(el, f.selector);
      if (f.multiple) {
        const vals = hits.map((h) => fieldValue(h, f, base)).filter((v) => v !== null && v !== "");
        row[f.name] = vals.length ? vals.join("; ") : null;
      } else row[f.name] = hits[0] ? fieldValue(hits[0], f, base) : null;
    }
    return row;
  }).filter((r) => Object.values(r).some((v) => v !== null && v !== ""));
}

/* sitemap.xml: one row per <url> (or child sitemap) with its location and last change. */
function sitemapRows(xml: string): Record<string, Cell>[] | null {
  if (!/<(urlset|sitemapindex)[\s>]/i.test(xml)) return null;
  const root = parse(xml);
  return root.querySelectorAll("url, sitemap").slice(0, MAX_ROWS).map((u) => ({
    url: text(u.querySelector("loc")), lastmod: text(u.querySelector("lastmod")) || null, priority: num(text(u.querySelector("priority"))),
  })).filter((r) => r.url);
}

/* "page-[1-5].html", "?p=[0-100:20]" or "[001-010]" expands to a list of start URLs. */
export function expandRange(raw: string, max = 20): string[] {
  const m = raw.match(/\[(\d+)-(\d+)(?::(\d+))?\]/);
  if (!m) return [raw];
  const [whole, a, b, step] = m;
  const from = Number(a), to = Number(b), by = Math.max(1, Number(step ?? 1));
  if (to < from) throw new ScrapeError("In a URL range like [1-5], the first number must be the smaller one.");
  const pad = a.length > 1 && a.startsWith("0") ? a.length : 0;
  const out: string[] = [];
  for (let n = from; n <= to && out.length < max; n += by) out.push(raw.replace(whole, String(n).padStart(pad, "0")));
  return out;
}

/* The "next page" link of a paginated listing, if there is one. */
export function nextLink(html: string, base: URL, custom?: string): URL | null {
  const root = parse(html, { comment: false });
  const rel = custom ? selectAll(root, custom).map((el) => (el.tagName === "A" ? el : el.querySelector("a[href]") ?? el))[0]
    : root.querySelector('link[rel="next"]') ?? root.querySelector('a[rel="next"]');
  const candidates = rel ? [rel] : custom ? [] : root.querySelectorAll("a[href]").filter((a) => {
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

async function scrapeOne(raw: string, opts: ScrapeOptions, started: number, maxPages: number): Promise<ScrapeResult> {
  let url: URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) && !/^https?:\/\//i.test(raw.trim())) throw new ScrapeError("Only http and https URLs are supported.");
  try { url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); } catch { throw new ScrapeError("That doesn't look like a valid URL."); }
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
  const urls = sitemapRows(body);
  if (urls) return { ...base, pages: 1, kind: "html", ms: Date.now() - started, meta: { records: urls.length }, datasets: [toDataset("sitemap", `${urls.length} URLs from sitemap.xml`, urls)] };
  const selector = opts.selector?.trim() || undefined;
  const recipe = opts.recipe;
  const first = extractHtml(body, finalUrl, selector, recipe);
  const pages = [first.datasets];
  let bytes = body.length;
  let next = maxPages > 1 ? nextLink(body, finalUrl, recipe?.next) : null;
  const visited = new Set([finalUrl.toString()]);
  while (next && pages.length < maxPages && Date.now() - started < 18_000 && !visited.has(next.toString())) {
    visited.add(next.toString());
    try {
      const page = await get(next, allowPrivate, "text/html");
      const html = await readCapped(page.res);
      if (!page.res.ok) break;
      bytes += html.length;
      pages.push(extractHtml(html, page.url, selector, recipe).datasets);
      next = nextLink(html, page.url, recipe?.next);
    } catch { break; }
  }
  return { ...base, bytes, pages: pages.length, kind: "html", ms: Date.now() - started, meta: first.meta, datasets: pages.length > 1 ? merge(pages) : first.datasets };
}

/* Open each item's link and add the detail page's fields to its row (Web Scraper's "link" selector). */
async function followDetails(result: ScrapeResult, recipe: Recipe, allowPrivate: boolean, started: number) {
  const follow = recipe.follow;
  const ds = result.datasets.find((d) => d.name === "custom fields");
  if (!follow || !ds || !follow.fields.length) return;
  const queue = ds.rows.slice(0, follow.limit ?? 10).map((row) => ({ row, href: row[follow.field] }))
    .filter((q): q is { row: Record<string, Cell>; href: string } => typeof q.href === "string" && /^https?:\/\//.test(q.href));
  let opened = 0, failed = 0;
  const worker = async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      if (Date.now() - started > 24_000) { failed++; continue; }
      try {
        const url = new URL(q.href);
        if ((await robotsAllows(url, allowPrivate)) === "disallowed") { failed++; continue; }
        const page = await get(url, allowPrivate, "text/html");
        const html = await readCapped(page.res);
        if (!page.res.ok) { failed++; continue; }
        const detail = recipeRows(parse(html, { comment: false, blockTextElements: { script: true, style: true } }), page.url, follow.fields)[0] ?? {};
        Object.assign(q.row, detail);
        result.bytes += html.length;
        opened++;
      } catch { failed++; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  follow.fields.forEach((f) => { if (!ds.columns.includes(f.name)) ds.columns.push(f.name); });
  result.meta = { ...result.meta, detail_pages: opened, detail_failed: failed };
}

export async function scrape(raw: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  const started = Date.now();
  const starts = expandRange(raw.trim());
  const maxPages = Math.min(10, Math.max(1, Math.floor(opts.pages ?? 1)));
  let result: ScrapeResult;
  if (starts.length === 1) result = await scrapeOne(starts[0], opts, started, maxPages);
  else {
    // A URL range: scrape each start URL once (no next-page following) and stack the results.
    const parts: ScrapeResult[] = [];
    let lastError: unknown;
    for (const u of starts) {
      if (Date.now() - started > 18_000) break;
      try { parts.push(await scrapeOne(u, opts, started, 1)); } catch (e) { lastError = e; }
    }
    if (!parts.length) throw lastError instanceof ScrapeError ? lastError : new ScrapeError("None of the URLs in that range could be scraped.", 502);
    result = { ...parts[0], url: raw.trim(), pages: parts.length, bytes: parts.reduce((n, p) => n + p.bytes, 0), datasets: merge(parts.map((p) => p.datasets)) };
    result.meta = { ...result.meta, range_urls: starts.length };
  }
  if (opts.recipe?.follow) await followDetails(result, opts.recipe, Boolean(opts.allowPrivate), started);
  result.ms = Date.now() - started;
  return result;
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
