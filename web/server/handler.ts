import type { IncomingMessage, ServerResponse } from "node:http";
import { rateLimited, scrape, ScrapeError, type ScrapeOptions } from "./scrape";

/* Node handler for /api/scrape?url=...&mode=auto|html|json&selector=... (Vercel function and Vite dev server). */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return send(405, { error: "Use GET." });
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const url = params.get("url");
  if (!url) return send(400, { error: "Add a url parameter." });
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return send(429, { error: "Too many requests. Try again in a minute." });
  const mode = (["auto", "html", "json"].includes(params.get("mode") ?? "") ? params.get("mode") : "auto") as ScrapeOptions["mode"];
  try {
    send(200, await scrape(url, { mode, selector: params.get("selector") ?? undefined, pages: Number(params.get("pages") ?? 1) || 1, allowPrivate: process.env.SCRAPE_ALLOW_PRIVATE === "1" }));
  } catch (e) {
    const err = e instanceof ScrapeError ? e : new ScrapeError("Something went wrong while scraping.", 500);
    if (!(e instanceof ScrapeError)) console.error(e);
    send(err.status, { error: err.message });
  }
}
