"""Data-quality checks pass and fail on crafted DataFrames."""

import pandas as pd

from src.quality import (
    QualityGateError, check_duplicates, check_not_null, check_row_count, check_row_count_change,
    check_value_range, critical_failures, run_book_checks,
)
from tests.conftest import make_books_df


def test_row_count():
    assert check_row_count(make_books_df(5), 5).status == "pass"
    assert check_row_count(make_books_df(4), 5).status == "fail"


def test_not_null():
    df = make_books_df(3)
    assert check_not_null(df, ["upc", "title", "price"]).status == "pass"
    df.loc[1, "price"] = None
    result = check_not_null(df, ["upc", "title", "price"])
    assert result.status == "fail" and "price" in result.details


def test_not_null_missing_column_fails():
    assert check_not_null(pd.DataFrame({"upc": ["a"]}), ["upc", "title"]).status == "fail"


def test_price_range():
    df = make_books_df(3, price=10)
    assert check_value_range(df, "price", 0.5, 1000).status == "pass"
    df.loc[0, "price"] = 5000
    assert check_value_range(df, "price", 0.5, 1000).status == "fail"


def test_rating_range():
    df = make_books_df(3)
    assert check_value_range(df, "rating", 1, 5).status == "pass"
    df.loc[2, "rating"] = 6
    assert check_value_range(df, "rating", 1, 5).status == "fail"


def test_duplicates():
    df = make_books_df(3)
    assert check_duplicates(df, "upc").status == "pass"
    df.loc[2, "upc"] = df.loc[0, "upc"]
    result = check_duplicates(df, "upc")
    assert result.status == "fail" and "33.33%" in result.details


def test_row_count_change_is_soft():
    assert check_row_count_change(100, None, 20).status == "pass"
    assert check_row_count_change(110, 100, 20).status == "pass"
    result = check_row_count_change(70, 100, 20)
    assert result.status == "warn" and result.severity == "soft"


def test_run_book_checks_only_critical_failures_block():
    df = make_books_df(10)
    results = run_book_checks(df, min_rows=5, min_price=0.5, max_price=1000, previous_count=1000, warn_pct=20)
    assert {r.check_name: r.status for r in results}["row_count_change"] == "warn"
    assert critical_failures(results) == []

    df.loc[0, "rating"] = 0
    failures = critical_failures(run_book_checks(df, min_rows=5, min_price=0.5, max_price=1000,
                                                 previous_count=None, warn_pct=20))
    assert [f.check_name for f in failures] == ["rating_range"]
    assert "rating_range" in str(QualityGateError(failures))
