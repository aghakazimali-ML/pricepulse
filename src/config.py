"""Central configuration, loaded from environment variables and an optional .env file."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str = f"sqlite:///{(PROJECT_ROOT / 'data' / 'pricepulse.db').as_posix()}"

    # Polite scraping
    user_agent: str = (
        "PricePulseBot/1.0 (+https://github.com/aghakazimali-ML/pricepulse; portfolio project)"
    )
    min_delay_seconds: float = Field(0.5, ge=0)
    max_delay_seconds: float = Field(1.5, ge=0)
    max_concurrency: int = Field(5, ge=1, le=50)
    request_timeout_seconds: float = Field(20.0, gt=0)
    max_retries: int = Field(4, ge=1)
    respect_robots_txt: bool = True

    # Sources
    books_base_url: str = "https://books.toscrape.com/"
    quotes_js_url: str = "https://quotes.toscrape.com/js/"
    playwright_chromium_executable: str | None = None

    # Loading
    snapshot_mode: Literal["changes", "always"] = "changes"

    # Data quality thresholds
    min_book_rows: int = 20
    min_quote_rows: int = 5
    min_price: float = 0.5
    max_price: float = 1000.0
    row_count_change_warn_pct: float = 20.0

    # Paths
    data_dir: Path = PROJECT_ROOT / "data"
    log_dir: Path = PROJECT_ROOT / "logs"
    log_level: str = "INFO"

    @model_validator(mode="after")
    def _check_delays(self) -> "Settings":
        if self.max_delay_seconds < self.min_delay_seconds:
            raise ValueError("MAX_DELAY_SECONDS must be >= MIN_DELAY_SECONDS")
        if not self.playwright_chromium_executable:
            self.playwright_chromium_executable = None
        # Relative SQLite paths are resolved against the project root so the CLI,
        # scheduler and dashboard all point at the same file wherever they're run from.
        prefix = "sqlite:///"
        if self.database_url.startswith(prefix):
            path = self.database_url[len(prefix):]
            if path and path != ":memory:" and not Path(path).is_absolute():
                self.database_url = prefix + (PROJECT_ROOT / path).as_posix()
        return self

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def rejected_dir(self) -> Path:
        return self.data_dir / "rejected"


@lru_cache
def get_settings() -> Settings:
    return Settings()
