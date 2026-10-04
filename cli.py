"""PricePulse command-line interface.

    python cli.py init-db
    python cli.py run --source books --limit-pages 5
    python cli.py run --all
    python cli.py quality-report --last
    python cli.py simulate-price-changes --runs 3
    python cli.py runs
    python cli.py schedule
"""

import pandas as pd
import typer
from rich.console import Console
from rich.table import Table
from sqlalchemy import text

from src.config import get_settings
from src.extract import SOURCES
from src.load.db import get_engine, init_db
from src.logging_setup import setup_logging
from src.pipeline import run_pipeline, simulate_price_changes

app = typer.Typer(help="PricePulse: scrape -> clean -> validate -> warehouse -> dashboard.",
                  no_args_is_help=True, add_completion=False)
console = Console()

STATUS_STYLE = {"success": "green", "pass": "green", "warn": "yellow", "failed": "red", "fail": "red",
                "running": "cyan"}


@app.callback()
def _setup() -> None:
    settings = get_settings()
    setup_logging(settings.log_dir, settings.log_level)


@app.command("init-db")
def init_db_cmd() -> None:
    """Create tables, indexes and views (idempotent)."""
    engine = get_engine()
    init_db(engine)
    console.print(f"[green]✓[/] Database ready: [bold]{engine.url.render_as_string(hide_password=True)}[/]")


@app.command()
def run(
    source: list[str] = typer.Option(None, "--source", "-s", help=f"Source(s) to run: {', '.join(SOURCES)}"),
    all_sources: bool = typer.Option(False, "--all", help="Run every registered source."),
    limit_pages: int = typer.Option(None, "--limit-pages", min=1, help="Crawl at most N listing pages (quick tests)."),
) -> None:
    """Run the ETL pipeline for one or more sources."""
    names = list(SOURCES) if all_sources else (source or [])
    if not names:
        raise typer.BadParameter("Pass --source NAME or --all")
    engine = get_engine()
    init_db(engine)  # cheap and idempotent: makes `run` work on a fresh database
    summaries = run_pipeline(names, limit_pages, engine)

    table = Table(title="Pipeline runs", header_style="bold")
    for col in ("run", "source", "status", "extracted", "loaded", "rejected", "new snapshots", "secs"):
        table.add_column(col)
    for s in summaries:
        table.add_row(str(s.run_id), s.source, f"[{STATUS_STYLE.get(s.status, '')}]{s.status}[/]",
                      str(s.rows_extracted), str(s.rows_loaded), str(s.rows_rejected),
                      str(s.snapshots_inserted), f"{s.duration_seconds:.1f}")
    console.print(table)
    for s in summaries:
        if s.error:
            console.print(f"[red]✗ {s.source}:[/] {s.error}")
    if any(s.status != "success" for s in summaries):
        raise typer.Exit(code=1)


@app.command("quality-report")
def quality_report(
    last: bool = typer.Option(True, "--last/--no-last", help="Show the most recent run (default)."),
    run_id: int = typer.Option(None, "--run-id", help="Show a specific run instead."),
) -> None:
    """Print data-quality check results for a run."""
    engine = get_engine()
    target = run_id
    if target is None and last:
        # Simulated runs have no quality checks, so "last" means the last real run.
        with engine.connect() as conn:
            target = conn.execute(text("SELECT MAX(run_id) FROM pipeline_runs WHERE NOT is_simulated")).scalar()
    if target is None:
        console.print("[yellow]No runs recorded yet.[/]")
        raise typer.Exit()
    run_df = pd.read_sql(text("SELECT * FROM pipeline_runs WHERE run_id = :r"), engine, params={"r": target})
    if run_df.empty:
        console.print(f"[red]Run {target} not found.[/]")
        raise typer.Exit(code=1)
    r = run_df.iloc[0]
    console.print(f"Run [bold]{target}[/] · {r.source} · [{STATUS_STYLE.get(r.status, '')}]{r.status}[/] · "
                  f"extracted {r.rows_extracted}, loaded {r.rows_loaded}, rejected {r.rows_rejected}")
    if r.error_message:
        console.print(f"[red]{r.error_message}[/]")
    checks = pd.read_sql(text("SELECT check_name, status, severity, details FROM quality_results "
                              "WHERE run_id = :r ORDER BY result_id"), engine, params={"r": target})
    if checks.empty:
        console.print("[yellow]No quality checks recorded for this run (simulated runs skip them).[/]")
        return
    table = Table(header_style="bold")
    for col in ("check", "status", "severity", "details"):
        table.add_column(col)
    for c in checks.itertuples(index=False):
        table.add_row(c.check_name, f"[{STATUS_STYLE.get(c.status, '')}]{c.status}[/]", c.severity, c.details)
    console.print(table)


@app.command("simulate-price-changes")
def simulate(
    fraction: float = typer.Option(0.10, min=0.01, max=1.0, help="Share of products whose price moves."),
    runs: int = typer.Option(1, min=1, max=30, help="How many simulated daily runs to create."),
    seed: int = typer.Option(None, help="Random seed for reproducible demos."),
) -> None:
    """DEMO: fabricate price moves in new runs flagged is_simulated (the practice site never changes)."""
    engine = get_engine()
    for i in range(runs):
        s = simulate_price_changes(engine, fraction=fraction, seed=None if seed is None else seed + i)
        console.print(f"[magenta]◆ simulated run {s.run_id}[/]: {s.snapshots_inserted} price/stock changes")


@app.command()
def runs(limit: int = typer.Option(10, min=1)) -> None:
    """List recent pipeline runs."""
    df = pd.read_sql(text("SELECT run_id, source, status, is_simulated, started_at, rows_extracted, rows_loaded, "
                          "rows_rejected FROM pipeline_runs ORDER BY run_id DESC LIMIT :n"),
                     get_engine(), params={"n": limit})
    table = Table(header_style="bold")
    for col in df.columns:
        table.add_column(col)
    for row in df.itertuples(index=False):
        values = [str(v) for v in row]
        values[2] = f"[{STATUS_STYLE.get(row.status, '')}]{row.status}[/]"
        table.add_row(*values)
    console.print(table)


@app.command()
def schedule(
    hour: int = typer.Option(6, min=0, max=23), minute: int = typer.Option(0, min=0, max=59),
    run_now: bool = typer.Option(False, "--run-now", help="Also run once immediately."),
) -> None:
    """Run the full pipeline daily on this machine (APScheduler, blocking)."""
    from src.scheduler import start_scheduler

    start_scheduler(hour=hour, minute=minute, run_now=run_now)


if __name__ == "__main__":
    app()
