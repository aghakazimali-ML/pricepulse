"""Optional local scheduler: runs every source once a day with APScheduler.

GitHub Actions (.github/workflows/pipeline.yml) is the primary scheduler; use this when
you'd rather keep the pipeline on your own machine or a small VM.

    python -m src.scheduler            # daily at 06:00 local time
    python cli.py schedule --hour 2 --run-now
"""

import logging

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from src.config import get_settings
from src.extract import SOURCES
from src.load.db import get_engine, init_db
from src.logging_setup import setup_logging
from src.pipeline import run_pipeline

log = logging.getLogger(__name__)


def daily_job() -> None:
    engine = get_engine()
    init_db(engine)
    summaries = run_pipeline(list(SOURCES), engine=engine)
    log.info("scheduled pipeline finished", extra={"results": {s.source: s.status for s in summaries}})


def start_scheduler(hour: int = 6, minute: int = 0, run_now: bool = False) -> None:
    settings = get_settings()
    setup_logging(settings.log_dir, settings.log_level)
    scheduler = BlockingScheduler()
    scheduler.add_job(daily_job, CronTrigger(hour=hour, minute=minute), id="pricepulse-daily",
                      max_instances=1, coalesce=True, misfire_grace_time=3600)
    if run_now:
        daily_job()
    log.info("scheduler started", extra={"hour": hour, "minute": minute})
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        log.info("scheduler stopped")


if __name__ == "__main__":
    start_scheduler()
