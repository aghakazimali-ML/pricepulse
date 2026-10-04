"""Database access for the dashboard (SQLAlchemy + Streamlit caching)."""

import os
import sys
from pathlib import Path

import pandas as pd
import streamlit as st
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:  # allow `from src...` / `from dashboard...` imports
    sys.path.insert(0, str(PROJECT_ROOT))

LOCAL_DB = PROJECT_ROOT / "data" / "pricepulse.db"
DEMO_DB = PROJECT_ROOT / "data" / "demo.db"


def _secret_url() -> str | None:
    try:
        return st.secrets.get("DATABASE_URL")  # Streamlit Cloud secrets
    except Exception:
        return None


def resolve_database_url() -> tuple[str, str]:
    """Return (url, label). Priority: DATABASE_URL env/.env -> secrets -> local DB -> bundled demo DB."""
    try:
        from dotenv import dotenv_values

        env_file = dotenv_values(PROJECT_ROOT / ".env")
    except ImportError:
        env_file = {}
    url = os.getenv("DATABASE_URL") or _secret_url() or env_file.get("DATABASE_URL")
    if url:
        if url.startswith("sqlite:///") and not Path(url.removeprefix("sqlite:///")).is_absolute():
            url = "sqlite:///" + (PROJECT_ROOT / url.removeprefix("sqlite:///")).as_posix()
        if not url.startswith("sqlite:///") or Path(url.removeprefix("sqlite:///")).exists():
            return url, "configured database"
    if LOCAL_DB.exists():
        return f"sqlite:///{LOCAL_DB.as_posix()}", "local SQLite (data/pricepulse.db)"
    return f"sqlite:///{DEMO_DB.as_posix()}", "bundled demo data (data/demo.db)"


@st.cache_resource
def get_engine() -> Engine:
    url, _ = resolve_database_url()
    return create_engine(url, pool_pre_ping=True)


@st.cache_data(ttl=600, show_spinner=False)
def query(sql: str, params: dict | None = None) -> pd.DataFrame:
    with get_engine().connect() as conn:
        return pd.read_sql(text(sql), conn, params=params or {})


def has_data() -> bool:
    try:
        return int(query("SELECT COUNT(*) AS n FROM fact_price_snapshot")["n"].iloc[0]) > 0
    except Exception:
        return False


def _bools(df: pd.DataFrame, *cols: str) -> pd.DataFrame:
    for col in cols:
        if col in df:
            df[col] = df[col].astype(bool)
    return df


def _times(df: pd.DataFrame, *cols: str) -> pd.DataFrame:
    for col in cols:
        if col in df:
            df[col] = pd.to_datetime(df[col], format="mixed")
    return df


def latest_prices() -> pd.DataFrame:
    df = query("SELECT * FROM v_latest_prices")
    return _times(_bools(df, "in_stock"), "captured_at", "first_seen", "last_seen")


def category_summary() -> pd.DataFrame:
    return query("SELECT * FROM v_category_summary ORDER BY products DESC")


def price_changes() -> pd.DataFrame:
    df = query("SELECT * FROM v_price_changes ORDER BY changed_at DESC")
    return _times(_bools(df, "is_simulated"), "changed_at", "old_captured_at")


def price_history(product_ids: list[int]) -> pd.DataFrame:
    if not product_ids:
        return pd.DataFrame()
    ids = ",".join(str(int(i)) for i in product_ids)  # ints only -> safe to inline
    df = query(f"""
        SELECT s.product_id, p.title, s.price, s.in_stock, s.stock_qty, s.captured_at, s.run_id, r.is_simulated
        FROM fact_price_snapshot s
        JOIN dim_product p ON p.product_id = s.product_id
        JOIN pipeline_runs r ON r.run_id = s.run_id
        WHERE s.product_id IN ({ids})
        ORDER BY s.captured_at
    """)
    return _times(_bools(df, "in_stock", "is_simulated"), "captured_at")


def runs() -> pd.DataFrame:
    df = query("SELECT * FROM pipeline_runs ORDER BY run_id")
    df = _times(_bools(df, "is_simulated"), "started_at", "finished_at")
    df["duration_s"] = (df["finished_at"] - df["started_at"]).dt.total_seconds()
    return df


def quality_results(run_id: int | None = None) -> pd.DataFrame:
    if run_id is None:
        return query("""
            SELECT q.*, r.source, r.started_at FROM quality_results q
            JOIN pipeline_runs r ON r.run_id = q.run_id
            WHERE q.run_id IN (SELECT MAX(q2.run_id) FROM quality_results q2
                               JOIN pipeline_runs r2 ON r2.run_id = q2.run_id GROUP BY r2.source)
            ORDER BY q.run_id DESC, q.result_id
        """)
    return query("SELECT * FROM quality_results WHERE run_id = :r ORDER BY result_id", {"r": run_id})


def rejected_sample(limit: int = 50) -> pd.DataFrame:
    return query("SELECT run_id, source, record_key, reason, payload FROM rejected_rows "
                 "ORDER BY rejected_id DESC LIMIT :n", {"n": limit})


def price_index() -> pd.DataFrame:
    """Catalogue state at every capture time: average price, % in stock and products tracked.

    Snapshots are change-only, so each product's last known price is carried forward.
    """
    snaps = query("SELECT product_id, captured_at, price, in_stock FROM fact_price_snapshot")
    if snaps.empty:
        return pd.DataFrame(columns=["captured_at", "avg_price", "pct_in_stock", "products"])
    snaps = _times(_bools(snaps, "in_stock"), "captured_at")
    snaps["in_stock"] = snaps["in_stock"].astype(int)
    snaps["captured_at"] = snaps["captured_at"].dt.floor("min")
    price = snaps.pivot_table(index="captured_at", columns="product_id", values="price", aggfunc="last").ffill()
    stock = snaps.pivot_table(index="captured_at", columns="product_id", values="in_stock", aggfunc="last").ffill()
    return pd.DataFrame({
        "captured_at": price.index,
        "avg_price": price.mean(axis=1).round(2).values,
        "pct_in_stock": (stock.mean(axis=1) * 100).round(1).values,
        "products": price.notna().sum(axis=1).values,
    }).reset_index(drop=True)
