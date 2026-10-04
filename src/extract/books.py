"""Async crawler for https://books.toscrape.com (1,000 books over 50 catalogue pages)."""

import asyncio
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

import httpx
from selectolax.lexbor import LexborHTMLParser as HTMLParser

from src.config import get_settings
from src.extract.base import ExtractResult, ExtractStats, Source
from src.extract.http_client import PoliteClient
from src.models import RawBook

log = logging.getLogger(__name__)


def _text(node) -> str | None:
    return node.text(strip=True) if node is not None else None


def parse_catalogue(html: str, page_url: str) -> tuple[list[str], str | None]:
    """Return (absolute product URLs, absolute next-page URL or None) for a catalogue page."""
    tree = HTMLParser(html)
    product_urls = []
    for link in tree.css("article.product_pod h3 a"):
        href = link.attributes.get("href")
        if href:
            product_urls.append(urljoin(page_url, href))
    next_link = tree.css_first("ul.pager li.next a")
    next_url = urljoin(page_url, next_link.attributes["href"]) if next_link else None
    return product_urls, next_url


def parse_product(html: str, product_url: str, scraped_at: datetime | None = None) -> RawBook:
    """Extract raw (string) fields from a product detail page."""
    tree = HTMLParser(html)
    main = tree.css_first("div.product_main")

    rating = None
    rating_node = main.css_first("p.star-rating") if main else None
    if rating_node is not None:
        classes = (rating_node.attributes.get("class") or "").split()
        rating = next((c for c in classes if c != "star-rating"), None)

    # Breadcrumb: Home > Books > <Category> > <Title>
    crumbs = tree.css("ul.breadcrumb li a")
    category = _text(crumbs[2]) if len(crumbs) >= 3 else None

    info = {
        _text(row.css_first("th")): _text(row.css_first("td"))
        for row in tree.css("table.table-striped tr")
    }

    # The description is the first <p> sibling after the #product_description header.
    description = None
    header = tree.css_first("#product_description")
    if header is not None:
        node = header.next
        while node is not None and node.tag != "p":
            node = node.next
        description = _text(node)

    image = tree.css_first("#product_gallery img") or tree.css_first("div.item.active img")
    image_url = urljoin(product_url, image.attributes["src"]) if image and image.attributes.get("src") else None

    return RawBook(
        title=_text(main.css_first("h1")) if main else None,
        category=category,
        price=_text(main.css_first("p.price_color")) if main else info.get("Price (incl. tax)"),
        availability=info.get("Availability") or (_text(main.css_first("p.availability")) if main else None),
        rating=rating,
        upc=info.get("UPC"),
        description=description,
        product_url=product_url,
        image_url=image_url,
        scraped_at=scraped_at or datetime.now(timezone.utc),
    )


class BooksSource(Source):
    name = "books"
    kind = "books"

    def __init__(self, limit_pages: int | None = None, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(limit_pages)
        self.settings = get_settings()
        self.transport = transport  # injectable for tests

    async def fetch(self) -> ExtractResult:
        stats = ExtractStats()
        started = time.perf_counter()
        start_url = urljoin(self.settings.books_base_url, "catalogue/page-1.html")

        async with PoliteClient(self.settings, stats, transport=self.transport) as client:
            product_urls = await self._crawl_catalogue(client, start_url, stats)
            log.info("catalogue crawled", extra={"source": self.name, "products": len(product_urls)})

            async def fetch_product(url: str) -> RawBook | None:
                try:
                    return parse_product(await client.get_text(url), url)
                except Exception as exc:  # one bad page must not sink the run
                    stats.failures += 1
                    stats.failed_urls.append(url)
                    log.warning("product page failed", extra={"url": url, "error": str(exc)})
                    return None

            results = await asyncio.gather(*(fetch_product(u) for u in product_urls))

        stats.duration_seconds = round(time.perf_counter() - started, 2)
        records = [r for r in results if r is not None]
        return ExtractResult(records=records, stats=stats)

    async def _crawl_catalogue(self, client: PoliteClient, start_url: str, stats: ExtractStats) -> list[str]:
        urls: list[str] = []
        page_url: str | None = start_url
        pages = 0
        while page_url and (self.limit_pages is None or pages < self.limit_pages):
            try:
                html = await client.get_text(page_url)
            except Exception as exc:
                stats.failures += 1
                stats.failed_urls.append(page_url)
                log.error("catalogue page failed, stopping pagination", extra={"url": page_url, "error": str(exc)})
                break
            page_products, page_url = parse_catalogue(html, page_url)
            urls.extend(page_products)
            pages += 1
        return list(dict.fromkeys(urls))  # de-dupe while keeping order
