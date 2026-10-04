"""Extract layer: pluggable sources that fetch raw records from websites."""

from src.extract.base import ExtractResult, ExtractStats, Source, save_raw
from src.extract.books import BooksSource
from src.extract.quotes_js import QuotesJsSource

# Registry used by the pipeline/CLI. Adding a site = writing one Source class + one entry here.
SOURCES: dict[str, type[Source]] = {
    BooksSource.name: BooksSource,
    QuotesJsSource.name: QuotesJsSource,
}

__all__ = ["SOURCES", "Source", "ExtractResult", "ExtractStats", "save_raw"]
