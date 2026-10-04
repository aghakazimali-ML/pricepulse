"""Load layer + orchestration: idempotency, change-only snapshots and failure tracking."""

from datetime import datetime

from sqlalchemy import text

from src.extract.base import ExtractResult, ExtractStats, Source
from src.load import loaders
from src.load.db import start_run
from src.models import RawBook
from src.pipeline import run_source, simulate_price_changes
from tests.conftest import make_books_df


def counts(engine) -> dict[str, int]:
    with engine.connect() as conn:
        return {t: conn.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar()
                for t in ("dim_category", "dim_product", "fact_price_snapshot")}


def load(engine, df, when=datetime(2026, 1, 1)):
    run_id = start_run(engine, "books")
    with engine.begin() as conn:
        return loaders.load_books(conn, df, run_id, when)


def test_init_db_is_idempotent(engine):
    from src.load.db import init_db

    init_db(engine)
    init_db(engine)
    with engine.connect() as conn:
        views = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'view'"))}
    assert {"v_latest_prices", "v_price_changes", "v_category_summary"} <= views


def test_loading_same_data_twice_does_not_duplicate(engine):
    df = make_books_df(5)
    first = load(engine, df)
    after_first = counts(engine)
    second = load(engine, df, when=datetime(2026, 1, 2))

    assert after_first == {"dim_category": 2, "dim_product": 5, "fact_price_snapshot": 5}
    assert counts(engine) == after_first
    assert first["snapshots_inserted"] == 5
    assert second["snapshots_inserted"] == 0


def test_changed_price_creates_exactly_one_new_snapshot(engine):
    df = make_books_df(5)
    load(engine, df)
    df.loc[2, "price"] = 99.99
    result = load(engine, df, when=datetime(2026, 1, 2))

    assert result["snapshots_inserted"] == 1
    assert counts(engine)["fact_price_snapshot"] == 6
    with engine.connect() as conn:
        change = conn.execute(text("SELECT upc, old_price, new_price FROM v_price_changes")).one()
    assert change.upc == "upc0002"
    assert float(change.old_price) == 12.0 and float(change.new_price) == 99.99


def test_stock_change_also_creates_snapshot(engine):
    df = make_books_df(2)
    load(engine, df)
    df.loc[0, "stock_qty"] = 1
    assert load(engine, df, when=datetime(2026, 1, 2))["snapshots_inserted"] == 1


def test_always_mode_snapshots_every_product(engine):
    df = make_books_df(3)
    load(engine, df)
    run_id = start_run(engine, "books")
    with engine.begin() as conn:
        result = loaders.load_books(conn, df, run_id, datetime(2026, 1, 2), mode="always")
    assert result["snapshots_inserted"] == 3


def test_product_attributes_and_last_seen_are_updated(engine):
    df = make_books_df(1)
    load(engine, df)
    df.loc[0, "title"] = "Renamed"
    load(engine, df, when=datetime(2026, 2, 1))
    with engine.connect() as conn:
        row = conn.execute(text("SELECT title, first_seen, last_seen FROM dim_product")).one()
    assert row.title == "Renamed"
    assert str(row.first_seen).startswith("2026-01-01")
    assert str(row.last_seen).startswith("2026-02-01")


# ------------------------------------------------------------ orchestration

class FakeBooks(Source):
    name = "books"
    kind = "books"

    def __init__(self, records=None, error: Exception | None = None):
        super().__init__(limit_pages=None)
        self.records, self.error = records or [], error

    async def fetch(self) -> ExtractResult:
        if self.error:
            raise self.error
        return ExtractResult(self.records, ExtractStats(pages_fetched=len(self.records)))


def raw(upc: str, price: str = "£10.00") -> RawBook:
    return RawBook(title=f"Book {upc}", category="travel", price=price, availability="In stock (3 available)",
                   rating="Four", upc=upc, product_url=f"https://books.toscrape.com/catalogue/{upc}/index.html",
                   scraped_at=datetime(2026, 1, 1))


def run_rows(engine):
    with engine.connect() as conn:
        return conn.execute(text("SELECT * FROM pipeline_runs ORDER BY run_id")).mappings().all()


def test_pipeline_run_twice_is_idempotent_and_tracked(engine):
    records = [raw("a"), raw("b"), raw("c", price="broken")]
    first = run_source(FakeBooks(records), engine)
    second = run_source(FakeBooks(records), engine)

    assert first.status == second.status == "success"
    assert (first.rows_extracted, first.rows_loaded, first.rows_rejected) == (3, 2, 1)
    assert counts(engine)["dim_product"] == 2
    assert counts(engine)["fact_price_snapshot"] == 2
    runs = run_rows(engine)
    assert [r["status"] for r in runs] == ["success", "success"]
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM rejected_rows")).scalar() == 2
        assert conn.execute(text("SELECT COUNT(*) FROM quality_results WHERE run_id = :r"),
                            {"r": first.run_id}).scalar() == 6


def test_failed_extract_is_recorded_as_failed(engine):
    summary = run_source(FakeBooks(error=RuntimeError("site is down")), engine)

    assert summary.status == "failed"
    run = run_rows(engine)[0]
    assert run["status"] == "failed"
    assert "site is down" in run["error_message"]
    assert run["finished_at"] is not None
    assert counts(engine)["dim_product"] == 0


def test_quality_gate_failure_fails_run_but_keeps_results(engine, monkeypatch):
    monkeypatch.setenv("MIN_BOOK_ROWS", "10")
    from src.config import get_settings

    get_settings.cache_clear()
    summary = run_source(FakeBooks([raw("a")]), engine, get_settings())

    assert summary.status == "failed"
    assert "row_count_min" in summary.error
    assert counts(engine)["dim_product"] == 0  # nothing loaded
    with engine.connect() as conn:
        status = conn.execute(text("SELECT status FROM quality_results WHERE check_name = 'row_count_min'")).scalar()
    assert status == "fail"


def test_simulated_run_is_flagged_and_creates_changes(engine):
    run_source(FakeBooks([raw(str(i)) for i in range(20)]), engine)
    summary = simulate_price_changes(engine, fraction=0.1, seed=1)

    assert summary.snapshots_inserted == 2
    with engine.connect() as conn:
        assert conn.execute(text("SELECT is_simulated FROM pipeline_runs WHERE run_id = :r"),
                            {"r": summary.run_id}).scalar() in (1, True)
        changes = conn.execute(text("SELECT COUNT(*) FROM v_price_changes WHERE is_simulated")).scalar()
    assert changes == 2
