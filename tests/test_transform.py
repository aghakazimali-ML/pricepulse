"""Transform layer: parsing helpers, validation, rejection and de-duplication."""

from datetime import datetime, timezone
from decimal import Decimal

import pandas as pd
import pytest

from src.models import RawBook, RawQuote
from src.transform.books import (
    normalize_category, parse_availability, parse_price, parse_rating, transform_books, write_rejected,
)
from src.transform.quotes import transform_quotes

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def raw_book(**overrides) -> RawBook:
    data = dict(title="  A Light in the Attic ", category="poetry", price="£51.77",
                availability="In stock (22 available)", rating="Three", upc="a897fe39b1053632",
                description="Desc", product_url="https://books.toscrape.com/catalogue/a_1/index.html",
                image_url="https://books.toscrape.com/media/x.jpg", scraped_at=NOW)
    data.update(overrides)
    return RawBook(**data)


@pytest.mark.parametrize("text, expected", [
    ("£51.77", (Decimal("51.77"), "GBP")),
    ("Â£13.99", (Decimal("13.99"), "GBP")),   # mojibake from a mis-decoded page
    ("$1,299.5", (Decimal("1299.50"), "USD")),
    ("free", (None, None)),
    ("", (None, None)),
    (None, (None, None)),
])
def test_parse_price(text, expected):
    assert parse_price(text) == expected


@pytest.mark.parametrize("text, expected", [
    ("Three", 3), ("one", 1), ("Five", 5), ("4", 4), ("Zero", None), (None, None),
])
def test_parse_rating(text, expected):
    assert parse_rating(text) == expected


@pytest.mark.parametrize("text, expected", [
    ("In stock (22 available)", (True, 22)),
    ("  In stock (1 available)\n", (True, 1)),
    ("In stock", (True, 0)),
    ("Out of stock", (False, 0)),
    ("", (None, None)),
    ("Pre-order", (None, None)),
])
def test_parse_availability(text, expected):
    assert parse_availability(text) == expected


def test_normalize_category_title_cases():
    assert normalize_category("  historical   fiction ") == "Historical Fiction"


def test_transform_books_produces_typed_clean_rows():
    result = transform_books([raw_book()])
    assert result.rejected.empty
    row = result.clean.iloc[0]
    assert row["title"] == "A Light in the Attic"
    assert row["category"] == "Poetry"
    assert row["price"] == pytest.approx(51.77)
    assert row["currency"] == "GBP"
    assert bool(row["in_stock"]) is True
    assert row["stock_qty"] == 22
    assert row["rating"] == 3


def test_invalid_rows_are_rejected_with_reason():
    result = transform_books([
        raw_book(),
        raw_book(upc="bad-price", price="N/A"),
        raw_book(upc="bad-rating", rating="Eleven"),
        raw_book(upc=None),
    ])
    assert len(result.clean) == 1
    assert len(result.rejected) == 3
    reasons = dict(zip(result.rejected["record_key"], result.rejected["reason"]))
    assert "price" in reasons["bad-price"]
    assert "rating" in reasons["bad-rating"]
    assert any("upc" in r for r in reasons.values())


def test_out_of_stock_row_is_valid():
    result = transform_books([raw_book(availability="Out of stock")])
    assert result.rejected.empty
    assert bool(result.clean.iloc[0]["in_stock"]) is False
    assert result.clean.iloc[0]["stock_qty"] == 0


def test_duplicates_by_upc_are_removed_keeping_latest():
    later = datetime(2026, 1, 2, tzinfo=timezone.utc)
    result = transform_books([raw_book(price="£10.00"), raw_book(price="£12.00", scraped_at=later)])
    assert len(result.clean) == 1
    assert result.duplicates_dropped == 1
    assert result.clean.iloc[0]["price"] == pytest.approx(12.0)


def test_write_rejected_appends_csv(tmp_path):
    result = transform_books([raw_book(upc="x", price="N/A")])
    run_date = datetime(2026, 1, 1).date()
    path = write_rejected(result.rejected, "books", run_date, tmp_path)
    write_rejected(result.rejected, "books", run_date, tmp_path)
    df = pd.read_csv(path)
    assert path.name == "2026-01-01.csv"
    assert list(df.columns) == ["source", "record_key", "reason", "payload"]
    assert len(df) == 2


def test_transform_quotes_strips_curly_quotes_and_dedupes():
    raw = RawQuote(text="“Hello world.”", author=" Jane Austen ", tags=["Life", "life", "love"],
                   page_url="https://quotes.toscrape.com/js/", scraped_at=NOW)
    result = transform_quotes([raw, raw, RawQuote(text=None, author="X", page_url="https://q.com/", scraped_at=NOW)])
    assert len(result.clean) == 1
    assert result.duplicates_dropped == 1
    assert len(result.rejected) == 1
    row = result.clean.iloc[0]
    assert row["text"] == "Hello world."
    assert row["author"] == "Jane Austen"
    assert row["tags"] == "life,love"
