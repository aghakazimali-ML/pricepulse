"""Extract layer: HTML parsing and the polite HTTP client (all network calls mocked with respx)."""

import asyncio

import httpx
import pytest
import respx

from src.extract.base import ExtractStats
from src.extract.books import BooksSource, parse_catalogue, parse_product
from src.extract.http_client import PoliteClient, RobotsDisallowedError
from src.extract.quotes_js import parse_quotes

BASE = "https://books.toscrape.com/"
PAGE1 = BASE + "catalogue/page-1.html"


def test_parse_catalogue_returns_absolute_product_urls_and_next_page(catalogue_html):
    urls, next_url = parse_catalogue(catalogue_html, PAGE1)
    assert urls == [
        BASE + "catalogue/a-light-in-the-attic_1000/index.html",
        BASE + "catalogue/tipping-the-velvet_999/index.html",
        BASE + "catalogue/soumission_998/index.html",
    ]
    assert next_url == BASE + "catalogue/page-2.html"


def test_parse_catalogue_last_page_has_no_next(catalogue_html):
    html = catalogue_html.replace('<li class="next"><a href="page-2.html">next</a></li>', "")
    _, next_url = parse_catalogue(html, PAGE1)
    assert next_url is None


def test_parse_product_extracts_all_fields(product_html):
    url = BASE + "catalogue/a-light-in-the-attic_1000/index.html"
    book = parse_product(product_html, url)
    assert book.title == "A Light in the Attic"
    assert book.category == "Poetry"
    assert book.price == "£51.77"
    assert book.availability == "In stock (22 available)"
    assert book.rating == "Three"
    assert book.upc == "a897fe39b1053632"
    assert book.description.startswith("It's hard to imagine a world without A Light in the Attic")
    assert book.product_url == url
    assert book.image_url == BASE + "media/cache/fe/72/fe72f0532301ec28892ae79a629a293c.jpg"
    assert book.scraped_at is not None


def test_parse_quotes_from_rendered_dom(quotes_html):
    url = "https://quotes.toscrape.com/js/"
    quotes, next_url = parse_quotes(quotes_html, url)
    assert len(quotes) == 2
    assert quotes[0].author == "Albert Einstein"
    assert quotes[0].tags == ["change", "deep-thoughts", "thinking", "world"]
    assert quotes[1].text.startswith("“It is our choices")
    assert next_url == "https://quotes.toscrape.com/js/page/2/"


@respx.mock
def test_client_retries_on_503_then_succeeds(offline_settings):
    respx.get(BASE + "robots.txt").mock(return_value=httpx.Response(404))
    route = respx.get(PAGE1).mock(side_effect=[httpx.Response(503), httpx.Response(200, text="<html>ok</html>")])
    stats = ExtractStats()

    async def go():
        async with PoliteClient(offline_settings, stats) as client:
            return await client.get_text(PAGE1)

    assert asyncio.run(go()) == "<html>ok</html>"
    assert route.call_count == 2
    assert stats.retries == 1
    assert stats.pages_fetched == 1


@respx.mock
def test_client_gives_up_after_max_retries(offline_settings):
    respx.get(BASE + "robots.txt").mock(return_value=httpx.Response(404))
    route = respx.get(PAGE1).mock(return_value=httpx.Response(500))
    stats = ExtractStats()

    async def go():
        async with PoliteClient(offline_settings, stats) as client:
            await client.get_text(PAGE1)

    with pytest.raises(Exception, match="HTTP 500"):
        asyncio.run(go())
    assert route.call_count == offline_settings.max_retries


@respx.mock
def test_client_respects_robots_txt(offline_settings):
    respx.get(BASE + "robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *\nDisallow: /catalogue/"))
    page = respx.get(PAGE1).mock(return_value=httpx.Response(200, text="nope"))
    stats = ExtractStats()

    async def go():
        async with PoliteClient(offline_settings, stats) as client:
            await client.get_text(PAGE1)

    with pytest.raises(RobotsDisallowedError):
        asyncio.run(go())
    assert not page.called
    assert stats.robots_blocked == 1


@respx.mock
def test_books_source_crawls_catalogue_and_products(catalogue_html, product_html):
    respx.get(BASE + "robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *\nDisallow:"))
    respx.get(PAGE1).mock(return_value=httpx.Response(200, text=catalogue_html))
    respx.get(url__regex=r".*/catalogue/[a-z-]+_\d+/index\.html").mock(
        return_value=httpx.Response(200, text=product_html))

    result = asyncio.run(BooksSource(limit_pages=1).fetch())

    assert len(result.records) == 3
    assert result.stats.pages_fetched == 4  # 1 catalogue page + 3 product pages
    assert result.stats.failures == 0
    assert {r.upc for r in result.records} == {"a897fe39b1053632"}


@respx.mock
def test_books_source_records_failed_product_pages(catalogue_html, product_html):
    respx.get(BASE + "robots.txt").mock(return_value=httpx.Response(404))
    respx.get(PAGE1).mock(return_value=httpx.Response(200, text=catalogue_html))
    respx.get(url__regex=r".*/soumission_998/index\.html").mock(return_value=httpx.Response(404))
    respx.get(url__regex=r".*/catalogue/[a-z-]+_\d+/index\.html").mock(
        return_value=httpx.Response(200, text=product_html))

    result = asyncio.run(BooksSource(limit_pages=1).fetch())

    assert len(result.records) == 2
    assert result.stats.failures == 1
    assert result.stats.failed_urls == [BASE + "catalogue/soumission_998/index.html"]
