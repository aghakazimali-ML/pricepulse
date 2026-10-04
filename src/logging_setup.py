"""Structured (JSON lines) logging to logs/pricepulse.log plus readable console output."""

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

# Attributes every LogRecord has; anything else was passed via `extra=` and is logged as a field.
_STANDARD_ATTRS = set(vars(logging.makeLogRecord({}))) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _STANDARD_ATTRS:
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = f"{datetime.now():%H:%M:%S} {record.levelname:<7} {record.name}: {record.getMessage()}"
        extras = {k: v for k, v in vars(record).items() if k not in _STANDARD_ATTRS}
        if extras:
            base += "  " + " ".join(f"{k}={v}" for k, v in extras.items())
        if record.exc_info:
            base += "\n" + self.formatException(record.exc_info)
        return base


def setup_logging(log_dir: Path, level: str = "INFO") -> None:
    """Configure the root logger once; safe to call repeatedly."""
    root = logging.getLogger()
    if getattr(root, "_pricepulse_configured", False):
        return
    log_dir.mkdir(parents=True, exist_ok=True)
    root.setLevel(level.upper())

    file_handler = logging.FileHandler(log_dir / "pricepulse.log", encoding="utf-8")
    file_handler.setFormatter(JsonFormatter())
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(ConsoleFormatter())
    root.addHandler(file_handler)
    root.addHandler(console)

    # Third-party libraries are chatty at INFO.
    for noisy in ("httpx", "httpcore", "apscheduler"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    root._pricepulse_configured = True  # type: ignore[attr-defined]
