"""Abstract source interface and the raw (bronze) storage layer."""

import json
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, ClassVar

from pydantic import BaseModel


@dataclass
class ExtractStats:
    pages_fetched: int = 0
    failures: int = 0
    retries: int = 0
    robots_blocked: int = 0
    duration_seconds: float = 0.0
    failed_urls: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["failed_urls"] = data["failed_urls"][:20]  # keep run metadata small
        return data


@dataclass
class ExtractResult:
    records: list[BaseModel]
    stats: ExtractStats


class Source(ABC):
    """A website we can scrape.

    Subclasses set `name` (used on the CLI and in the DB) and `kind` (which transform /
    loader handles the records) and implement `fetch`.
    """

    name: ClassVar[str]
    kind: ClassVar[str]

    def __init__(self, limit_pages: int | None = None) -> None:
        self.limit_pages = limit_pages

    @abstractmethod
    async def fetch(self) -> ExtractResult:
        """Scrape the site and return raw records plus crawl statistics."""


def save_raw(records: list[BaseModel], source: str, run_date: date, raw_dir: Path) -> Path:
    """Append raw records to data/raw/{source}/{run_date}.jsonl (kept for reprocessing)."""
    out_dir = raw_dir / source
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{run_date.isoformat()}.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record.model_dump(mode="json"), ensure_ascii=False) + "\n")
    return path
