"""Shared fixtures: offline settings, a temporary SQLite warehouse and HTML fixtures."""

from datetime import datetime
from pathlib import Path

import pandas as pd
import pytest

from src.config import get_settings

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def offline_settings(tmp_path, monkeypatch):
    """Point every test at temp dirs, a temp DB and zero politeness delays."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("BOOKS_BASE_URL", "https://books.toscrape.com/")
    monkeypatch.setenv("MIN_DELAY_SECONDS", "0")
    monkeypatch.setenv("MAX_DELAY_SECONDS", "0")
    monkeypatch.setenv("MAX_RETRIES", "3")
    monkeypatch.setenv("MIN_BOOK_ROWS", "1")
    monkeypatch.setenv("SNAPSHOT_MODE", "changes")
    get_settings.cache_clear()
    yield get_settings()
    get_settings.cache_clear()


@pytest.fixture
def engine(offline_settings):
    from src.load.db import get_engine, init_db

    eng = get_engine(offline_settings.database_url)
    init_db(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def catalogue_html() -> str:
    return (FIXTURES / "catalogue_page.html").read_text(encoding="utf-8")


@pytest.fixture
def product_html() -> str:
    return (FIXTURES / "product_page.html").read_text(encoding="utf-8")


@pytest.fixture
def quotes_html() -> str:
    return (FIXTURES / "quotes_js_rendered.html").read_text(encoding="utf-8")


def make_books_df(n: int = 3, price: float = 10.0, **overrides) -> pd.DataFrame:
    """A clean books DataFrame shaped like transform_books() output."""
    rows = []
    for i in range(n):
        row = {
            "upc": f"upc{i:04d}", "title": f"Book {i}", "category": "Poetry" if i % 2 else "Travel",
            "price": price + i, "currency": "GBP", "in_stock": True, "stock_qty": 5, "rating": 3,
            "description": "desc", "url": f"https://books.toscrape.com/catalogue/book-{i}/index.html",
            "image_url": None, "scraped_at": datetime(2026, 1, 1),
        }
        row.update(overrides)
        rows.append(row)
    return pd.DataFrame(rows)
