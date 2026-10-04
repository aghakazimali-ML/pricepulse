"""Engine creation, idempotent schema init and pipeline run tracking."""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import (
    Boolean, Column, DateTime, Integer, MetaData, Numeric, String, Table, Text,
    create_engine, event, func, insert, select, text, update,
)
from sqlalchemy.engine import Engine

from src.config import PROJECT_ROOT, get_settings

log = logging.getLogger(__name__)
SQL_DIR = PROJECT_ROOT / "sql"

# Core table definitions mirroring sql/schema.sql (the DDL there is the source of truth;
# these give SQLAlchemy the column types for dialect-aware inserts/upserts).
metadata = MetaData()

pipeline_runs = Table(
    "pipeline_runs", metadata,
    Column("run_id", Integer, primary_key=True, autoincrement=True),
    Column("source", String(50)), Column("started_at", DateTime), Column("finished_at", DateTime),
    Column("status", String(20)), Column("rows_extracted", Integer), Column("rows_loaded", Integer),
    Column("rows_rejected", Integer), Column("is_simulated", Boolean(create_constraint=False)),
    Column("stats_json", Text), Column("error_message", Text),
)
dim_category = Table(
    "dim_category", metadata,
    Column("category_id", Integer, primary_key=True, autoincrement=True), Column("name", String(120)),
)
dim_product = Table(
    "dim_product", metadata,
    Column("product_id", Integer, primary_key=True, autoincrement=True), Column("upc", String(64)),
    Column("title", String(500)), Column("category_id", Integer), Column("url", Text),
    Column("image_url", Text), Column("description", Text),
    Column("first_seen", DateTime), Column("last_seen", DateTime),
)
fact_price_snapshot = Table(
    "fact_price_snapshot", metadata,
    Column("snapshot_id", Integer, primary_key=True, autoincrement=True), Column("product_id", Integer),
    Column("run_id", Integer), Column("price", Numeric(10, 2, asdecimal=False)), Column("currency", String(3)),
    Column("in_stock", Boolean(create_constraint=False)), Column("stock_qty", Integer),
    Column("rating", Integer), Column("captured_at", DateTime),
)
quality_results = Table(
    "quality_results", metadata,
    Column("result_id", Integer, primary_key=True, autoincrement=True), Column("run_id", Integer),
    Column("check_name", String(100)), Column("status", String(10)), Column("severity", String(10)),
    Column("details", Text),
)
rejected_rows = Table(
    "rejected_rows", metadata,
    Column("rejected_id", Integer, primary_key=True, autoincrement=True), Column("run_id", Integer),
    Column("source", String(50)), Column("record_key", Text), Column("reason", Text), Column("payload", Text),
)
quotes = Table(
    "quotes", metadata,
    Column("quote_id", Integer, primary_key=True, autoincrement=True), Column("quote_hash", String(32)),
    Column("text", Text), Column("author", String(200)), Column("tags", Text), Column("page_url", Text),
    Column("first_seen", DateTime), Column("last_seen", DateTime), Column("last_run_id", Integer),
)

PK_BY_DIALECT = {
    "sqlite": "INTEGER PRIMARY KEY AUTOINCREMENT",
    "postgresql": "BIGSERIAL PRIMARY KEY",
}


def utcnow() -> datetime:
    """Naive UTC timestamp (portable across SQLite and Postgres TIMESTAMP columns)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def get_engine(url: str | None = None) -> Engine:
    url = url or get_settings().database_url
    if url.startswith("sqlite:///"):
        db_path = url.removeprefix("sqlite:///")
        if db_path and db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, future=True, pool_pre_ping=True)
    if engine.dialect.name == "sqlite":
        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()
    return engine


def _statements(sql: str) -> list[str]:
    """Split a SQL file into statements (our DDL has no semicolons inside literals)."""
    lines = [line for line in sql.splitlines() if not line.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


def init_db(engine: Engine) -> None:
    """Create tables, indexes and views. Safe to run repeatedly."""
    pk = PK_BY_DIALECT.get(engine.dialect.name)
    if pk is None:
        raise RuntimeError(f"Unsupported database dialect: {engine.dialect.name}")
    schema = (SQL_DIR / "schema.sql").read_text(encoding="utf-8").replace("__PK__", pk)
    views = (SQL_DIR / "views.sql").read_text(encoding="utf-8")
    with engine.begin() as conn:
        for stmt in _statements(schema) + _statements(views):
            conn.execute(text(stmt))
    log.info("database initialised", extra={"dialect": engine.dialect.name})


# ---------------------------------------------------------------- run tracking

def start_run(engine: Engine, source: str, *, is_simulated: bool = False,
              started_at: datetime | None = None) -> int:
    """Insert a 'running' row in its own transaction so it survives a failed load."""
    with engine.begin() as conn:
        result = conn.execute(insert(pipeline_runs).values(
            source=source, started_at=started_at or utcnow(), status="running",
            rows_extracted=0, rows_loaded=0, rows_rejected=0, is_simulated=is_simulated,
        ))
        return int(result.inserted_primary_key[0])


def finish_run(engine: Engine, run_id: int, *, status: str, rows_extracted: int = 0, rows_loaded: int = 0,
               rows_rejected: int = 0, stats: dict[str, Any] | None = None, error_message: str | None = None,
               finished_at: datetime | None = None) -> None:
    with engine.begin() as conn:
        conn.execute(update(pipeline_runs).where(pipeline_runs.c.run_id == run_id).values(
            status=status, finished_at=finished_at or utcnow(), rows_extracted=rows_extracted,
            rows_loaded=rows_loaded, rows_rejected=rows_rejected,
            stats_json=json.dumps(stats, default=str) if stats is not None else None,
            error_message=(error_message or "")[:4000] or None,
        ))


def previous_clean_count(engine: Engine, source: str, before_run_id: int) -> int | None:
    """Clean-row count of the most recent successful, non-simulated run of a source."""
    with engine.connect() as conn:
        row = conn.execute(
            select(pipeline_runs.c.rows_extracted - pipeline_runs.c.rows_rejected)
            .where(pipeline_runs.c.source == source, pipeline_runs.c.status == "success",
                   pipeline_runs.c.is_simulated.is_(False), pipeline_runs.c.run_id < before_run_id)
            .order_by(pipeline_runs.c.run_id.desc()).limit(1)
        ).first()
    return int(row[0]) if row else None


def latest_run_id(engine: Engine) -> int | None:
    with engine.connect() as conn:
        return conn.execute(select(func.max(pipeline_runs.c.run_id))).scalar()
