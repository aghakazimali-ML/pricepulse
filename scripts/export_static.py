"""Export the warehouse to web/public/data.json for the static (Vercel) dashboard.

Usage: python scripts/export_static.py [--db sqlite:///data/demo.db] [--out web/public/data.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def default_url() -> str:
    from src.config import get_settings

    url = get_settings().database_url
    db = ROOT / "data" / "pricepulse.db"
    if url.startswith("sqlite") and not db.exists():
        url = f"sqlite:///{ROOT / 'data' / 'demo.db'}"
    return url


def q(engine, sql: str) -> pd.DataFrame:
    with engine.connect() as conn:
        return pd.read_sql(text(sql), conn)


def iso(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, format="mixed").dt.strftime("%Y-%m-%dT%H:%M:%S")


def records(df: pd.DataFrame) -> list[dict]:
    return json.loads(df.to_json(orient="records", double_precision=4))


def price_index(engine) -> pd.DataFrame:
    snaps = q(engine, "SELECT product_id, captured_at, price, in_stock FROM fact_price_snapshot")
    snaps["captured_at"] = pd.to_datetime(snaps["captured_at"], format="mixed").dt.floor("min")
    snaps["in_stock"] = snaps["in_stock"].astype(int)
    price = snaps.pivot_table(index="captured_at", columns="product_id", values="price", aggfunc="last").ffill()
    stock = snaps.pivot_table(index="captured_at", columns="product_id", values="in_stock", aggfunc="last").ffill()
    return pd.DataFrame({
        "t": price.index.strftime("%Y-%m-%dT%H:%M:%S"),
        "avg_price": price.mean(axis=1).round(2).values,
        "pct_in_stock": (stock.mean(axis=1) * 100).round(1).values,
        "products": price.notna().sum(axis=1).values,
    })


def build(engine) -> dict:
    latest = q(engine, "SELECT product_id, title, category, price, in_stock, stock_qty, rating, url FROM v_latest_prices")
    latest["in_stock"] = latest["in_stock"].astype(bool)

    changes = q(engine, """SELECT product_id, title, category, old_price, new_price, pct_change, changed_at, is_simulated
                           FROM v_price_changes ORDER BY changed_at DESC""")
    changes["changed_at"] = iso(changes["changed_at"])
    changes["is_simulated"] = changes["is_simulated"].astype(bool)

    moved = changes["product_id"].unique().tolist()
    history = pd.DataFrame(columns=["product_id", "t", "price"])
    if moved:
        ids = ",".join(str(int(i)) for i in moved)
        history = q(engine, f"SELECT product_id, captured_at AS t, price FROM fact_price_snapshot "
                            f"WHERE product_id IN ({ids}) ORDER BY captured_at")
        history["t"] = iso(history["t"])

    runs = q(engine, "SELECT run_id, source, started_at, finished_at, status, rows_extracted, rows_loaded, "
                     "rows_rejected, is_simulated, error_message FROM pipeline_runs ORDER BY run_id")
    start = pd.to_datetime(runs["started_at"], format="mixed")
    end = pd.to_datetime(runs["finished_at"], format="mixed")
    runs["duration_s"] = (end - start).dt.total_seconds().round(1)
    runs["started_at"] = start.dt.strftime("%Y-%m-%dT%H:%M:%S")
    runs["finished_at"] = end.dt.strftime("%Y-%m-%dT%H:%M:%S")
    runs["is_simulated"] = runs["is_simulated"].astype(bool)

    quality = q(engine, """
        SELECT q.run_id, r.source, q.check_name, q.status, q.severity, q.details FROM quality_results q
        JOIN pipeline_runs r ON r.run_id = q.run_id
        WHERE q.run_id IN (SELECT MAX(q2.run_id) FROM quality_results q2
                           JOIN pipeline_runs r2 ON r2.run_id = q2.run_id GROUP BY r2.source)
        ORDER BY q.run_id DESC, q.result_id""")
    rejected = q(engine, "SELECT run_id, source, record_key, reason FROM rejected_rows ORDER BY rejected_id DESC LIMIT 50")
    quotes = q(engine, "SELECT text, author, tags FROM quotes ORDER BY quote_id LIMIT 12")

    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "products": records(latest),
        "categories": records(q(engine, "SELECT * FROM v_category_summary ORDER BY products DESC")),
        "price_index": records(price_index(engine)),
        "changes": records(changes),
        "history": records(history),
        "runs": records(runs),
        "quality": records(quality),
        "rejected": records(rejected),
        "quotes": {"count": int(q(engine, "SELECT COUNT(*) AS n FROM quotes")["n"].iloc[0]), "sample": records(quotes)},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    ap.add_argument("--out", default=str(ROOT / "web" / "public" / "data.json"))
    args = ap.parse_args()
    data = build(create_engine(args.db or default_url()))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB): {len(data['products'])} products, "
          f"{len(data['changes'])} changes, {len(data['runs'])} runs")


if __name__ == "__main__":
    main()
