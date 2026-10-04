"""Idempotent loaders: dimension upserts, change-only price snapshots, quality + rejects.

Upserts use the dialect-specific INSERT ... ON CONFLICT so the same code works on SQLite
and PostgreSQL. All functions take an open Connection; the caller owns the transaction.
"""

from datetime import datetime
from typing import Any, Literal

import pandas as pd
from sqlalchemy import Connection, Table, select, text
from sqlalchemy.dialects import postgresql, sqlite

from src.load.db import (
    dim_category, dim_product, fact_price_snapshot, quality_results, quotes, rejected_rows,
)
from src.quality import CheckResult


def _insert(conn: Connection, table: Table):
    """Dialect-aware INSERT that supports .on_conflict_do_update / _do_nothing."""
    dialect = conn.engine.dialect.name
    if dialect == "postgresql":
        return postgresql.insert(table)
    if dialect == "sqlite":
        return sqlite.insert(table)
    raise RuntimeError(f"Unsupported dialect for upserts: {dialect}")


def upsert_categories(conn: Connection, names: list[str]) -> dict[str, int]:
    names = sorted(set(names))
    if names:
        stmt = _insert(conn, dim_category).on_conflict_do_nothing(index_elements=["name"])
        conn.execute(stmt, [{"name": n} for n in names])
    rows = conn.execute(select(dim_category.c.name, dim_category.c.category_id))
    return {name: cid for name, cid in rows}


def upsert_products(conn: Connection, df: pd.DataFrame, category_ids: dict[str, int],
                    seen_at: datetime) -> dict[str, int]:
    """Insert new products, refresh attributes + last_seen of existing ones. Returns upc -> product_id."""
    if not df.empty:
        payload = [
            {
                "upc": r.upc, "title": r.title, "category_id": category_ids[r.category], "url": r.url,
                "image_url": r.image_url, "description": r.description,
                "first_seen": seen_at, "last_seen": seen_at,
            }
            for r in df.itertuples(index=False)
        ]
        stmt = _insert(conn, dim_product)
        stmt = stmt.on_conflict_do_update(
            index_elements=["upc"],
            set_={col: stmt.excluded[col] for col in
                  ("title", "category_id", "url", "image_url", "description", "last_seen")},
        )
        conn.execute(stmt, payload)
    rows = conn.execute(select(dim_product.c.upc, dim_product.c.product_id))
    return {upc: pid for upc, pid in rows}


def latest_snapshots(conn: Connection) -> dict[int, dict[str, Any]]:
    """Most recent snapshot per product, keyed by product_id."""
    rows = conn.execute(text("""
        SELECT product_id, price, in_stock, stock_qty, rating FROM (
            SELECT product_id, price, in_stock, stock_qty, rating,
                   ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY captured_at DESC, snapshot_id DESC) AS rn
            FROM fact_price_snapshot
        ) t WHERE rn = 1
    """)).mappings()
    return {r["product_id"]: dict(r) for r in rows}


def _changed(prev: dict[str, Any] | None, price: float, in_stock: bool, stock_qty: int) -> bool:
    if prev is None:
        return True  # first sighting
    return (
        round(float(prev["price"]), 2) != round(float(price), 2)
        or bool(prev["in_stock"]) != bool(in_stock)
        or int(prev["stock_qty"]) != int(stock_qty)
    )


def insert_snapshots(conn: Connection, rows: list[dict[str, Any]], run_id: int, captured_at: datetime,
                     mode: Literal["changes", "always"] = "changes") -> int:
    """Insert price snapshots. In 'changes' mode only for new products or changed price/stock.

    Each row needs: product_id, price, currency, in_stock, stock_qty, rating.
    Returns the number of snapshots written.
    """
    previous = latest_snapshots(conn) if mode == "changes" else {}
    to_insert = [
        {**{k: r[k] for k in ("product_id", "price", "currency", "in_stock", "stock_qty", "rating")},
         "run_id": run_id, "captured_at": captured_at}
        for r in rows
        if mode == "always" or _changed(previous.get(r["product_id"]), r["price"], r["in_stock"], r["stock_qty"])
    ]
    if to_insert:
        stmt = _insert(conn, fact_price_snapshot).on_conflict_do_nothing(index_elements=["product_id", "run_id"])
        conn.execute(stmt, to_insert)
    return len(to_insert)


def load_books(conn: Connection, df: pd.DataFrame, run_id: int, captured_at: datetime,
               mode: Literal["changes", "always"] = "changes") -> dict[str, int]:
    """Load a clean books DataFrame. Returns counts for run metadata."""
    category_ids = upsert_categories(conn, df["category"].tolist())
    product_ids = upsert_products(conn, df, category_ids, captured_at)
    rows = [
        {"product_id": product_ids[r.upc], "price": float(r.price), "currency": r.currency,
         "in_stock": bool(r.in_stock), "stock_qty": int(r.stock_qty), "rating": int(r.rating)}
        for r in df.itertuples(index=False)
    ]
    snapshots = insert_snapshots(conn, rows, run_id, captured_at, mode)
    return {"products_upserted": len(df), "snapshots_inserted": snapshots, "categories": len(set(df["category"]))}


def load_quotes(conn: Connection, df: pd.DataFrame, run_id: int, seen_at: datetime) -> dict[str, int]:
    if not df.empty:
        payload = [
            {"quote_hash": r.quote_hash, "text": r.text, "author": r.author, "tags": r.tags,
             "page_url": r.page_url, "first_seen": seen_at, "last_seen": seen_at, "last_run_id": run_id}
            for r in df.itertuples(index=False)
        ]
        stmt = _insert(conn, quotes)
        stmt = stmt.on_conflict_do_update(
            index_elements=["quote_hash"],
            set_={c: stmt.excluded[c] for c in ("tags", "page_url", "last_seen", "last_run_id")},
        )
        conn.execute(stmt, payload)
    return {"quotes_upserted": len(df)}


def save_quality_results(conn: Connection, run_id: int, results: list[CheckResult]) -> None:
    if not results:
        return
    stmt = _insert(conn, quality_results)
    stmt = stmt.on_conflict_do_update(
        index_elements=["run_id", "check_name"],
        set_={c: stmt.excluded[c] for c in ("status", "severity", "details")},
    )
    conn.execute(stmt, [
        {"run_id": run_id, "check_name": r.check_name, "status": r.status,
         "severity": r.severity, "details": r.details}
        for r in results
    ])


def save_rejected(conn: Connection, run_id: int, source: str, rejected: pd.DataFrame) -> None:
    if rejected.empty:
        return
    conn.execute(rejected_rows.insert(), [
        {"run_id": run_id, "source": source, "record_key": r.record_key, "reason": r.reason, "payload": r.payload}
        for r in rejected.itertuples(index=False)
    ])
