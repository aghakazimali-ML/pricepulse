"""Clean and validate quotes scraped from the JavaScript-rendered site."""

import hashlib
from typing import Any

import pandas as pd
from pydantic import ValidationError

from src.models import QuoteRecord, RawQuote
from src.transform.books import REJECTED_COLUMNS, TransformResult, _reason, normalize_text


def quote_hash(text: str, author: str) -> str:
    """Stable natural key for a quote (used for idempotent upserts)."""
    return hashlib.sha256(f"{text}|{author}".lower().encode("utf-8")).hexdigest()[:32]


def transform_quotes(raw_records: list[RawQuote]) -> TransformResult:
    clean_rows: list[dict[str, Any]] = []
    rejected_rows: list[dict[str, Any]] = []

    for raw in raw_records:
        # Strip the decorative curly quotes the site wraps every quote in.
        text = (normalize_text(raw.text) or "").strip("“”\"")
        row = {
            "text": text,
            "author": normalize_text(raw.author),
            "tags": sorted({t.lower() for t in (normalize_text(x) for x in raw.tags) if t}),
            "page_url": raw.page_url,
            "scraped_at": raw.scraped_at,
        }
        try:
            record = QuoteRecord.model_validate(row)
        except ValidationError as exc:
            rejected_rows.append({"record_key": raw.page_url, "reason": _reason(exc), "payload": raw.model_dump_json()})
            continue
        clean_rows.append({
            "quote_hash": quote_hash(record.text, record.author),
            "text": record.text,
            "author": record.author,
            "tags": ",".join(record.tags),
            "page_url": str(record.page_url),
            "scraped_at": record.scraped_at,
        })

    clean_df = pd.DataFrame(clean_rows, columns=["quote_hash", "text", "author", "tags", "page_url", "scraped_at"])
    before = len(clean_df)
    clean_df = clean_df.drop_duplicates(subset="quote_hash", keep="last").reset_index(drop=True)
    return TransformResult(
        clean=clean_df,
        rejected=pd.DataFrame(rejected_rows, columns=REJECTED_COLUMNS),
        duplicates_dropped=before - len(clean_df),
    )
