"""Orchestration: extract -> raw layer -> transform -> quality gate -> load, with run tracking."""

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

import pandas as pd
from sqlalchemy import text
from sqlalchemy.engine import Engine

from src.config import Settings, get_settings
from src.extract import SOURCES, Source, save_raw
from src.load import loaders
from src.load.db import finish_run, get_engine, previous_clean_count, start_run, utcnow
from src.quality import QualityGateError, critical_failures, run_book_checks, run_quote_checks
from src.transform import transform_books, transform_quotes
from src.transform.books import write_rejected

log = logging.getLogger(__name__)


@dataclass
class RunSummary:
    run_id: int
    source: str
    status: str
    rows_extracted: int = 0
    rows_loaded: int = 0
    rows_rejected: int = 0
    snapshots_inserted: int = 0
    duration_seconds: float = 0.0
    error: str | None = None
    quality: list[dict[str, str]] = field(default_factory=list)


def build_source(name: str, limit_pages: int | None = None) -> Source:
    try:
        return SOURCES[name](limit_pages=limit_pages)
    except KeyError:
        raise ValueError(f"Unknown source '{name}'. Available: {', '.join(SOURCES)}") from None


def run_source(source: Source, engine: Engine | None = None, settings: Settings | None = None) -> RunSummary:
    """Run the full pipeline for one source. Never raises: failures are recorded on the run row."""
    settings = settings or get_settings()
    engine = engine or get_engine(settings.database_url)
    started = time.perf_counter()
    run_id = start_run(engine, source.name)
    summary = RunSummary(run_id=run_id, source=source.name, status="running")
    stats: dict[str, Any] = {"limit_pages": source.limit_pages}
    ctx = {"run_id": run_id, "source": source.name}
    log.info("run started", extra=ctx)

    try:
        # ---- Extract
        result = asyncio.run(source.fetch())
        stats.update(result.stats.as_dict())
        summary.rows_extracted = len(result.records)
        run_date = utcnow().date()
        raw_path = save_raw(result.records, source.name, run_date, settings.raw_dir)
        stats["raw_path"] = str(raw_path)
        log.info("extracted", extra={**ctx, "rows": summary.rows_extracted, **result.stats.as_dict()})

        # ---- Transform + validate
        transformed = (transform_books if source.kind == "books" else transform_quotes)(result.records)
        clean, rejected = transformed.clean, transformed.rejected
        summary.rows_rejected = len(rejected)
        stats["duplicates_dropped"] = transformed.duplicates_dropped
        rejected_path = write_rejected(rejected, source.name, run_date, settings.rejected_dir)
        if rejected_path:
            stats["rejected_path"] = str(rejected_path)

        # ---- Data quality
        previous = previous_clean_count(engine, source.name, run_id)
        if source.kind == "books":
            checks = run_book_checks(clean, min_rows=settings.min_book_rows, min_price=settings.min_price,
                                     max_price=settings.max_price, previous_count=previous,
                                     warn_pct=settings.row_count_change_warn_pct)
        else:
            checks = run_quote_checks(clean, min_rows=settings.min_quote_rows, previous_count=previous,
                                      warn_pct=settings.row_count_change_warn_pct)
        summary.quality = [{"check": c.check_name, "status": c.status, "details": c.details} for c in checks]
        # Quality results and rejects are persisted even if the gate below fails the run.
        with engine.begin() as conn:
            loaders.save_quality_results(conn, run_id, checks)
            loaders.save_rejected(conn, run_id, source.name, rejected)
        for check in checks:
            if check.status != "pass":
                log.warning("quality check not passing", extra={**ctx, "check": check.check_name,
                                                                "status": check.status, "details": check.details})
        if failures := critical_failures(checks):
            raise QualityGateError(failures)

        # ---- Load (single transaction)
        captured_at = utcnow()
        with engine.begin() as conn:
            if source.kind == "books":
                counts = loaders.load_books(conn, clean, run_id, captured_at, settings.snapshot_mode)
                summary.snapshots_inserted = counts["snapshots_inserted"]
            else:
                counts = loaders.load_quotes(conn, clean, run_id, captured_at)
        stats.update(counts)
        summary.rows_loaded = len(clean)
        summary.status = "success"
    except Exception as exc:
        summary.status = "failed"
        summary.error = f"{type(exc).__name__}: {exc}"
        log.exception("run failed", extra=ctx)

    summary.duration_seconds = round(time.perf_counter() - started, 2)
    stats["total_duration_seconds"] = summary.duration_seconds
    finish_run(engine, run_id, status=summary.status, rows_extracted=summary.rows_extracted,
               rows_loaded=summary.rows_loaded, rows_rejected=summary.rows_rejected,
               stats=stats, error_message=summary.error)
    log.info("run finished", extra={**ctx, "status": summary.status, "rows_loaded": summary.rows_loaded,
                                    "duration_seconds": summary.duration_seconds})
    return summary


def run_pipeline(source_names: list[str], limit_pages: int | None = None,
                 engine: Engine | None = None) -> list[RunSummary]:
    engine = engine or get_engine()
    return [run_source(build_source(name, limit_pages), engine) for name in source_names]


def simulate_price_changes(engine: Engine, fraction: float = 0.10, seed: int | None = None,
                           step_days: float = 1.0) -> RunSummary:
    """DEMO HELPER: create a simulated run that moves ~`fraction` of latest prices.

    books.toscrape.com prices never change, so this fabricates a believable next-day run
    (captured `step_days` after the newest snapshot) to give the history charts something
    to show. The run is flagged `is_simulated = TRUE` and the dashboard labels it.
    """
    rng = random.Random(seed)
    latest = pd.read_sql(text("SELECT * FROM v_latest_prices"), engine)
    if latest.empty:
        raise RuntimeError("No data to simulate from. Run `python cli.py run --source books` first.")

    captured_at = pd.to_datetime(latest["captured_at"]).max().to_pydatetime() + timedelta(days=step_days)
    run_id = start_run(engine, "books", is_simulated=True, started_at=captured_at)
    sample = latest.sample(n=max(1, round(len(latest) * fraction)), random_state=rng.randint(0, 2**31 - 1))

    rows = []
    for r in sample.itertuples(index=False):
        factor = rng.choice([rng.uniform(0.70, 0.95), rng.uniform(1.05, 1.25)])  # drop or rise, never flat
        in_stock = bool(r.in_stock) if rng.random() > 0.1 else not bool(r.in_stock)
        stock_qty = 0 if not in_stock else max(1, int(r.stock_qty) + rng.randint(-3, 3))
        rows.append({"product_id": int(r.product_id), "price": round(float(r.price) * factor, 2),
                     "currency": r.currency, "in_stock": in_stock, "stock_qty": stock_qty, "rating": int(r.rating)})

    with engine.begin() as conn:
        inserted = loaders.insert_snapshots(conn, rows, run_id, captured_at, mode="always")
    finish_run(engine, run_id, status="success", rows_extracted=len(rows), rows_loaded=inserted,
               stats={"simulated": True, "fraction": fraction, "seed": seed}, finished_at=captured_at)
    log.info("simulated price changes", extra={"run_id": run_id, "changed": inserted})
    return RunSummary(run_id=run_id, source="books (simulated)", status="success",
                      rows_extracted=len(rows), rows_loaded=inserted, snapshots_inserted=inserted)
