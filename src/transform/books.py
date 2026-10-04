"""Clean, type, validate and de-duplicate raw book records."""

import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pandas as pd
from pydantic import ValidationError

from src.models import BookRecord, RawBook

CURRENCY_SYMBOLS = {"£": "GBP", "$": "USD", "€": "EUR"}
RATING_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
REJECTED_COLUMNS = ["record_key", "reason", "payload"]


@dataclass
class TransformResult:
    clean: pd.DataFrame
    rejected: pd.DataFrame
    duplicates_dropped: int = 0


def normalize_text(value: str | None) -> str | None:
    """Strip, repair common mojibake, NFKC-normalise and collapse whitespace."""
    if value is None:
        return None
    text = value.replace("Â£", "£").replace("â€™", "’").replace("â€œ", "“").replace("â€\x9d", "”")
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def parse_price(value: str | None) -> tuple[Decimal | None, str | None]:
    """'£51.77' -> (Decimal('51.77'), 'GBP'). Returns (None, None) if unparseable."""
    text = normalize_text(value)
    if not text:
        return None, None
    currency = next((code for sym, code in CURRENCY_SYMBOLS.items() if sym in text), None)
    match = re.search(r"\d[\d,]*(?:\.\d+)?", text)
    if not match:
        return None, currency
    try:
        return Decimal(match.group().replace(",", "")).quantize(Decimal("0.01")), currency
    except InvalidOperation:
        return None, currency


def parse_rating(value: str | None) -> int | None:
    """'Three' -> 3; also accepts '3'. Returns None if unknown."""
    text = (normalize_text(value) or "").lower()
    if text.isdigit():
        return int(text)
    return RATING_WORDS.get(text)


def parse_availability(value: str | None) -> tuple[bool | None, int | None]:
    """'In stock (22 available)' -> (True, 22); 'Out of stock' -> (False, 0); 'In stock' -> (True, 0)."""
    text = (normalize_text(value) or "").lower()
    if not text:
        return None, None
    if "out of stock" in text or "unavailable" in text:
        return False, 0
    if "in stock" in text:
        match = re.search(r"(\d+)\s+available", text)
        return True, int(match.group(1)) if match else 0
    return None, None


def normalize_category(value: str | None) -> str | None:
    text = normalize_text(value)
    return text.title() if text else None


def _clean_row(raw: RawBook) -> dict[str, Any]:
    price, currency = parse_price(raw.price)
    in_stock, stock_qty = parse_availability(raw.availability)
    return {
        "upc": normalize_text(raw.upc),
        "title": normalize_text(raw.title),
        "category": normalize_category(raw.category),
        "price": price,
        "currency": currency,
        "in_stock": in_stock,
        "stock_qty": stock_qty,
        "rating": parse_rating(raw.rating),
        "description": normalize_text(raw.description),
        "url": raw.product_url,
        "image_url": raw.image_url,
        "scraped_at": raw.scraped_at,
    }


def _reason(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        field = ".".join(map(str, err["loc"]))
        parts.append(f"{field}: missing or unparseable" if err.get("input") is None else f"{field}: {err['msg']}")
    return "; ".join(parts)


def transform_books(raw_records: list[RawBook]) -> TransformResult:
    """Return clean rows (validated by BookRecord, deduped by UPC) and rejected rows with reasons."""
    clean_rows: list[dict[str, Any]] = []
    rejected_rows: list[dict[str, Any]] = []

    for raw in raw_records:
        row = _clean_row(raw)
        try:
            record = BookRecord.model_validate(row)
        except ValidationError as exc:
            rejected_rows.append({
                "record_key": row.get("upc") or raw.product_url,
                "reason": _reason(exc),
                "payload": raw.model_dump_json(),
            })
            continue
        clean = record.model_dump()
        clean["url"] = str(record.url)
        clean["image_url"] = str(record.image_url) if record.image_url else None
        clean_rows.append(clean)

    clean_df = pd.DataFrame(clean_rows, columns=list(BookRecord.model_fields))
    before = len(clean_df)
    # Keep the most recently scraped version of each UPC.
    clean_df = (
        clean_df.sort_values("scraped_at").drop_duplicates(subset="upc", keep="last").reset_index(drop=True)
    )
    if not clean_df.empty:
        clean_df["price"] = clean_df["price"].astype(float)
        clean_df["stock_qty"] = clean_df["stock_qty"].astype(int)
        clean_df["rating"] = clean_df["rating"].astype(int)
        clean_df["in_stock"] = clean_df["in_stock"].astype(bool)

    return TransformResult(
        clean=clean_df,
        rejected=pd.DataFrame(rejected_rows, columns=REJECTED_COLUMNS),
        duplicates_dropped=before - len(clean_df),
    )


def write_rejected(rejected: pd.DataFrame, source: str, run_date: date, rejected_dir: Path) -> Path | None:
    """Append rejected rows to data/rejected/{run_date}.csv (source column added)."""
    if rejected.empty:
        return None
    rejected_dir.mkdir(parents=True, exist_ok=True)
    path = rejected_dir / f"{run_date.isoformat()}.csv"
    out = rejected.assign(source=source)[["source", *REJECTED_COLUMNS]]
    out.to_csv(path, mode="a", header=not path.exists(), index=False)
    return path
