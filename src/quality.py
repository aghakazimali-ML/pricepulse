"""Lightweight data-quality checks (no Great Expectations dependency).

Each check returns a CheckResult. Critical checks that fail abort the run before anything
is loaded; soft checks only warn. All results are stored in `quality_results`.
"""

from dataclasses import dataclass
from typing import Literal

import pandas as pd

Status = Literal["pass", "warn", "fail"]
Severity = Literal["critical", "soft"]


@dataclass(frozen=True)
class CheckResult:
    check_name: str
    status: Status
    severity: Severity
    details: str


class QualityGateError(Exception):
    """Raised when at least one critical check fails."""

    def __init__(self, failures: list[CheckResult]) -> None:
        super().__init__("Critical data-quality checks failed: " + "; ".join(
            f"{f.check_name} ({f.details})" for f in failures
        ))
        self.failures = failures


def _result(name: str, ok: bool, severity: Severity, details: str) -> CheckResult:
    status: Status = "pass" if ok else ("fail" if severity == "critical" else "warn")
    return CheckResult(name, status, severity, details)


def check_row_count(df: pd.DataFrame, min_rows: int) -> CheckResult:
    return _result("row_count_min", len(df) >= min_rows, "critical", f"{len(df)} rows (minimum {min_rows})")


def check_not_null(df: pd.DataFrame, columns: list[str]) -> CheckResult:
    missing = {c: int(df[c].isna().sum()) for c in columns if c in df}
    absent = [c for c in columns if c not in df]
    nulls = {c: n for c, n in missing.items() if n}
    ok = not nulls and not absent
    details = "no nulls in " + ", ".join(columns) if ok else f"nulls={nulls} missing_columns={absent}"
    return _result("not_null_" + "_".join(columns), ok, "critical", details)


def check_value_range(df: pd.DataFrame, column: str, low: float, high: float,
                      severity: Severity = "critical") -> CheckResult:
    if df.empty:
        return _result(f"{column}_range", True, severity, "no rows to check")
    values = pd.to_numeric(df[column], errors="coerce")
    bad = int(((values < low) | (values > high) | values.isna()).sum())
    return _result(
        f"{column}_range", bad == 0, severity,
        f"{bad} value(s) outside [{low}, {high}]; observed min={values.min()}, max={values.max()}",
    )


def check_duplicates(df: pd.DataFrame, key: str) -> CheckResult:
    dupes = int(df[key].duplicated().sum()) if key in df else 0
    rate = dupes / len(df) if len(df) else 0.0
    return _result(f"duplicate_{key}", dupes == 0, "critical", f"duplicate rate {rate:.2%} ({dupes} rows)")


def check_row_count_change(current: int, previous: int | None, warn_pct: float) -> CheckResult:
    if not previous:
        return _result("row_count_change", True, "soft", "no previous successful run to compare")
    change = (current - previous) / previous * 100
    return _result(
        "row_count_change", abs(change) <= warn_pct, "soft",
        f"{change:+.1f}% vs previous run ({previous} -> {current}); threshold ±{warn_pct:g}%",
    )


def run_book_checks(df: pd.DataFrame, *, min_rows: int, min_price: float, max_price: float,
                    previous_count: int | None, warn_pct: float) -> list[CheckResult]:
    return [
        check_row_count(df, min_rows),
        check_not_null(df, ["upc", "title", "price"]),
        check_value_range(df, "price", min_price, max_price),
        check_value_range(df, "rating", 1, 5),
        check_duplicates(df, "upc"),
        check_row_count_change(len(df), previous_count, warn_pct),
    ]


def run_quote_checks(df: pd.DataFrame, *, min_rows: int, previous_count: int | None,
                     warn_pct: float) -> list[CheckResult]:
    return [
        check_row_count(df, min_rows),
        check_not_null(df, ["text", "author"]),
        check_duplicates(df, "quote_hash"),
        check_row_count_change(len(df), previous_count, warn_pct),
    ]


def critical_failures(results: list[CheckResult]) -> list[CheckResult]:
    return [r for r in results if r.status == "fail"]
