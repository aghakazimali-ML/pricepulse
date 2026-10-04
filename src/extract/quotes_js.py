"""Playwright scraper for https://quotes.toscrape.com/js/ (content is rendered by JavaScript)."""

import logging
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

from selectolax.lexbor import LexborHTMLParser as HTMLParser

from src.config import get_settings
from src.extract.base import ExtractResult, ExtractStats, Source
from src.models import RawQuote

log = logging.getLogger(__name__)


def parse_quotes(html: str, page_url: str, scraped_at: datetime | None = None) -> tuple[list[RawQuote], str | None]:
    """Parse the *rendered* DOM of a quotes page into raw quotes and the next-page URL."""
    tree = HTMLParser(html)
    now = scraped_at or datetime.now(timezone.utc)
    quotes = []
    for node in tree.css("div.quote"):
        text = node.css_first("span.text")
        author = node.css_first("small.author")
        quotes.append(
            RawQuote(
                text=text.text(strip=True) if text else None,
                author=author.text(strip=True) if author else None,
                tags=[t.text(strip=True) for t in node.css("div.tags a.tag")],
                page_url=page_url,
                scraped_at=now,
            )
        )
    next_link = tree.css_first("ul.pager li.next a")
    next_url = urljoin(page_url, next_link.attributes["href"]) if next_link else None
    return quotes, next_url


class QuotesJsSource(Source):
    name = "quotes_js"
    kind = "quotes"

    async def fetch(self) -> ExtractResult:
        # Imported lazily so the rest of the pipeline works without Playwright installed.
        from playwright.async_api import async_playwright

        from src.extract.http_client import PoliteClient

        settings = get_settings()
        stats = ExtractStats()
        started = time.perf_counter()
        records: list[RawQuote] = []
        page_url: str | None = settings.quotes_js_url
        pages = 0

        # Reuse the HTTP client purely for the robots.txt check and polite delays.
        async with PoliteClient(settings, stats) as robots, async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=True, executable_path=settings.playwright_chromium_executable
            )
            context = await browser.new_context(user_agent=settings.user_agent)
            page = await context.new_page()
            try:
                while page_url and (self.limit_pages is None or pages < self.limit_pages):
                    if not await robots.allowed(page_url):
                        stats.robots_blocked += 1
                        log.warning("robots.txt disallows page", extra={"url": page_url})
                        break
                    await robots._polite_pause()
                    try:
                        await page.goto(page_url, wait_until="domcontentloaded",
                                        timeout=settings.request_timeout_seconds * 1000)
                        # The quotes only exist after the page's script runs.
                        await page.wait_for_selector("div.quote", timeout=settings.request_timeout_seconds * 1000)
                    except Exception as exc:
                        stats.failures += 1
                        stats.failed_urls.append(page_url)
                        log.error("JS page failed", extra={"url": page_url, "error": str(exc)})
                        break
                    stats.pages_fetched += 1
                    page_quotes, page_url = parse_quotes(await page.content(), page.url)
                    records.extend(page_quotes)
                    pages += 1
            finally:
                await browser.close()

        stats.duration_seconds = round(time.perf_counter() - started, 2)
        return ExtractResult(records=records, stats=stats)
