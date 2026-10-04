# 📈 PricePulse

**Automated price-tracking pipeline: scrape → clean → validate → warehouse → dashboard.**

PricePulse crawls an e-commerce catalogue every day, validates every record, stores price history in a SQL star schema with run tracking and data-quality results, and serves it in an animated Streamlit dashboard.

![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-Chromium-2EAD33?logo=playwright&logoColor=white)
![SQLAlchemy](https://img.shields.io/badge/SQLAlchemy-2.x-D71F00?logo=sqlalchemy&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Streamlit](https://img.shields.io/badge/Streamlit-dashboard-FF4B4B?logo=streamlit&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-daily_cron-2088FF?logo=githubactions&logoColor=white)
[![tests](https://github.com/aghakazimali-ML/pricepulse/actions/workflows/tests.yml/badge.svg)](https://github.com/aghakazimali-ML/pricepulse/actions/workflows/tests.yml)

**🔗 Live demo:** [pricepulse-ml.vercel.app](https://pricepulse-ml.vercel.app) (static snapshot of the warehouse; the full Streamlit app runs locally or on Streamlit Cloud)

| Home | Price history | Pipeline health |
|---|---|---|
| ![Home](docs/screenshots/home.png) | ![Price history](docs/screenshots/price_history.png) | ![Pipeline health](docs/screenshots/pipeline_health.png) |

![Dashboard tour](docs/screenshots/demo.gif)

---

## Architecture

```mermaid
flowchart LR
    GHA["⏰ GitHub Actions<br/>daily cron"] -.triggers.-> EX

    subgraph Sources
        B["books.toscrape.com<br/>(httpx async)"]
        Q["quotes.toscrape.com/js<br/>(Playwright)"]
    end

    B --> EX["Extract<br/>robots.txt · rate limit · retries"]
    Q --> EX
    EX --> RAW[("Raw layer<br/>data/raw/{source}/{date}.jsonl")]
    RAW --> TR["Transform + Validate<br/>pandas · Pydantic v2"]
    TR --> REJ[("Rejected rows<br/>data/rejected/{date}.csv")]
    TR --> DQ{"Quality checks<br/>critical / soft"}
    DQ -- critical fail --> FAIL["Run marked failed"]
    DQ -- pass --> LD["Load<br/>idempotent upserts, 1 transaction"]
    LD --> DB[("SQL star schema<br/>SQLite / PostgreSQL")]
    DB --> V["Views<br/>v_latest_prices · v_price_changes · v_category_summary"]
    V --> DASH["📊 Streamlit + Plotly<br/>21st.dev React chart kit"]
```

## Data model

```mermaid
erDiagram
    dim_category ||--o{ dim_product : contains
    dim_product ||--o{ fact_price_snapshot : "priced in"
    pipeline_runs ||--o{ fact_price_snapshot : captures
    pipeline_runs ||--o{ quality_results : checks
    pipeline_runs ||--o{ rejected_rows : rejects
    pipeline_runs ||--o{ quotes : "last seen in"

    dim_category {
        int category_id PK
        varchar name UK
    }
    dim_product {
        int product_id PK
        varchar upc UK
        varchar title
        int category_id FK
        text url
        text image_url
        text description
        timestamp first_seen
        timestamp last_seen
    }
    fact_price_snapshot {
        int snapshot_id PK
        int product_id FK
        int run_id FK
        numeric price
        varchar currency
        boolean in_stock
        int stock_qty
        int rating
        timestamp captured_at
    }
    pipeline_runs {
        int run_id PK
        varchar source
        timestamp started_at
        timestamp finished_at
        varchar status
        int rows_extracted
        int rows_loaded
        int rows_rejected
        boolean is_simulated
        text stats_json
        text error_message
    }
    quality_results {
        int result_id PK
        int run_id FK
        varchar check_name
        varchar status
        varchar severity
        text details
    }
    rejected_rows {
        int rejected_id PK
        int run_id FK
        varchar source
        text record_key
        text reason
        text payload
    }
    quotes {
        int quote_id PK
        varchar quote_hash UK
        text text
        varchar author
        text tags
        timestamp first_seen
        timestamp last_seen
        int last_run_id FK
    }
```

## Data-engineering practices

| Practice | Where |
|---|---|
| **Idempotent loads**: `INSERT … ON CONFLICT` via SQLAlchemy's SQLite/Postgres dialect inserts; re-running a day never duplicates rows | `src/load/loaders.py` |
| **History tracking**: a new `fact_price_snapshot` row only when price or stock changes, or on first sighting (`SNAPSHOT_MODE=changes`). Set it to `always` for one row per product per run | `insert_snapshots()` |
| **Retries with backoff**: tenacity, exponential backoff and jitter on timeouts, transport errors, 429 and 5xx | `src/extract/http_client.py` |
| **Polite scraping**: robots.txt check, descriptive User-Agent, random 0.5–1.5 s delay, concurrency cap | `PoliteClient` |
| **Raw layer**: every scrape is kept as JSONL so it can be reprocessed without re-crawling | `data/raw/` |
| **Validation**: Pydantic v2 models; invalid rows go to `data/rejected/*.csv` and to the `rejected_rows` table with a reason | `src/models.py`, `src/transform/` |
| **Data-quality gate**: row count, nulls, price range, rating 1–5, duplicate rate, and row-count drift vs the previous run. Critical failures stop the load; soft ones warn | `src/quality.py` |
| **Run tracking**: every run is recorded with status, row counts, crawl stats and errors. A failed run is marked `failed` with its error message | `pipeline_runs` |
| **Transactions**: the whole load runs in one transaction; run status is written separately so a failure is still recorded | `src/pipeline.py` |
| **Structured logs**: JSON lines in `logs/pricepulse.log` plus readable console output | `src/logging_setup.py` |
| **Pluggable sources**: add a site by writing one class | `src/extract/base.py` |

---

## Quick start (SQLite)

Requires Python 3.11+.

**macOS / Linux**
```bash
git clone https://github.com/aghakazimali-ML/pricepulse.git && cd pricepulse
make setup                       # venv + requirements + Playwright Chromium + .env
source .venv/bin/activate
python cli.py init-db
python cli.py run --source books --limit-pages 3   # ~60 books, under a minute
python cli.py run --all                            # all 1,000 books + JS quotes
python cli.py simulate-price-changes --runs 3      # demo price history
streamlit run dashboard/Home.py                    # http://localhost:8501
```

**Windows (PowerShell, no make needed)**
```powershell
git clone https://github.com/aghakazimali-ML/pricepulse.git; cd pricepulse
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m playwright install chromium
Copy-Item .env.example .env
python cli.py init-db
python cli.py run --source books --limit-pages 3
python cli.py run --all
python cli.py simulate-price-changes --runs 3
streamlit run dashboard/Home.py
```
If you have `make` on Windows (Git Bash, WSL or `choco install make`), the Makefile targets work too.

Run `pytest` to run the offline test suite.

## PostgreSQL via Docker Compose

```bash
docker compose up --build
```
This starts **Postgres 17**, a one-shot **pipeline** container (init-db, scrape all sources, 3 simulated days, quality report) and the **dashboard** at http://localhost:8501.

To run the pipeline against your own Postgres, set `DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/db` in `.env`. The same SQL and upsert code runs on both databases.

## CLI reference

| Command | What it does |
|---|---|
| `python cli.py init-db` | Create tables, indexes and views (idempotent) |
| `python cli.py run --source books --limit-pages 5` | Run one source; `--limit-pages` crawls only N listing pages |
| `python cli.py run --source books --source quotes_js` | Run several sources |
| `python cli.py run --all` | Run every registered source; exits 1 if any run fails |
| `python cli.py quality-report --last` | Quality checks of the latest real run (`--run-id N` for a specific run) |
| `python cli.py simulate-price-changes [--runs 3] [--fraction 0.1] [--seed 42]` | **Demo helper.** Moves ~10% of prices in a new run flagged `is_simulated`, dated one day after the newest snapshot |
| `python cli.py runs [--limit 10]` | List recent runs |
| `python cli.py schedule [--hour 6] [--run-now]` | Local daily scheduler (APScheduler) |

All settings (delays, concurrency, thresholds, snapshot mode, URLs) live in `.env`. See `.env.example`.

> **Why simulate?** books.toscrape.com is a static sandbox, so its prices never change. `simulate-price-changes` creates believable moves so the history charts have something to show. Simulated runs are flagged in the DB (`pipeline_runs.is_simulated`), excluded from quality and drift comparisons, and marked **SIM** in the dashboard.

## Dashboard

| Page | Contents |
|---|---|
| **Home** | Header with pipeline status. KPI cards with sparklines and change vs last capture (products, categories, avg price, % in stock, price changes). Average-price trend, rating mix donut, largest categories, category summary |
| **Products** | Filters (category, price, rating, stock, title search), table with cover images and links, CSV download |
| **Price History** | Drop and increase KPIs, average-price trend, multi-product price-over-time step chart (simulated points marked), biggest drops and increases, distribution of moves |
| **Insights** | Price spread by category, rating vs price, stock-level bands, units in stock by category, top-rated cheapest books |
| **Pipeline Health** | Run KPIs, run strip, rows per run, durations, run history, latest quality checks, crawl stats, rejected-row sample |

**UI kit.** KPI cards, sparklines, area, bar and donut charts, page headers and the run strip come from `dashboard/components/motion_ui`. It's a Streamlit custom component built on the 21st.dev **[Charts & KPI Cards](https://21st.dev/@uvain/components/revenue-charts-kpi)** kit (Layro System, by @uvain), using React, Tailwind, Recharts and shadcn tokens, with subtle [Motion](https://motion.dev) entrances. The style uses neutral surfaces, hairline borders and a monochrome chart scale. Colour is kept for meaning: green for good or a price drop, red for bad or a price rise. Plotly charts and tables use the same palette and card surface (`dashboard/ui.py`). The production bundle (`frontend/dist`) is committed, so Streamlit Cloud needs no Node build. If the bundle is missing, the pages fall back to native Streamlit widgets. To change it:

```bash
cd dashboard/components/motion_ui/frontend
npm install && npm run build                       # rebuild dist/
# or live-reload: npm run dev, then
MOTION_UI_DEV_URL=http://localhost:5173 streamlit run dashboard/Home.py
```

The dashboard reads `DATABASE_URL` (env, `.env` or Streamlit secrets). Without it, it uses `data/pricepulse.db`, falling back to `data/demo.db`. Queries are cached with `@st.cache_data(ttl=600)`.

### Deploy to Streamlit Community Cloud
1. `data/demo.db` (full live scrape + 5 simulated days) is built by **`.github/workflows/demo-db.yml`**. It runs on the first push and commits the file. Re-run it from the Actions tab to refresh the data, or build it locally with `make demo-db`.
2. Push to GitHub.
3. On share.streamlit.io choose the repo, main file `dashboard/Home.py`, Python 3.11.
4. Optional: add a `DATABASE_URL` secret pointing at a hosted Postgres to show live data instead.

### Deploy the static dashboard to Vercel
`web/` is a static React build of the same five pages (21st.dev kit, Recharts, Motion) that reads `web/public/data.json`.
1. `python scripts/export_static.py` writes `data.json` from the database (`demo-db.yml` does this automatically).
2. `cd web && npm ci && npm run dev` to preview, `npm run build` for `web/dist`.
3. On Vercel, import the repo with **Root Directory `web`**; `web/vercel.json` sets the Vite build. Every push to `main` then redeploys.

## Scheduling with GitHub Actions

- **`.github/workflows/tests.yml`** runs `pytest` (offline) and a schema smoke test on every push and PR.
- **`.github/workflows/pipeline.yml`** runs daily at 06:00 UTC, or manually from the Actions tab with an optional page limit:
  1. restores yesterday's `pricepulse.db` from the `data` branch, so history accumulates,
  2. runs `init-db` and `run --all`, then prints the quality report,
  3. **Option A:** uploads the DB, logs and rejected rows as a run **artifact** (30-day retention),
  4. **Option B:** force-pushes the DB to an orphan **`data` branch**. That branch holds only the latest DB, which keeps the main history clean.

Use A if you only want downloadable snapshots, or B (the default) if you want persistent history and a stable URL for the latest DB. To use Postgres instead, add a `DATABASE_URL` repository secret, expose it as `env` in the workflow, and remove the restore and commit steps.

For a machine you control, `python cli.py schedule --run-now` (or `python -m src.scheduler`) runs everything daily with APScheduler.

## Adding a new source

1. **Create the extractor** in `src/extract/my_shop.py`:

```python
from datetime import datetime, timezone

from selectolax.lexbor import LexborHTMLParser

from src.config import get_settings
from src.extract.base import ExtractResult, ExtractStats, Source
from src.extract.http_client import PoliteClient
from src.models import RawBook


class MyShopSource(Source):
    name = "my_shop"   # used on the CLI and stored on pipeline_runs.source
    kind = "books"     # reuse the books transform + loader (same raw fields)

    async def fetch(self) -> ExtractResult:
        settings, stats = get_settings(), ExtractStats()
        records = []
        async with PoliteClient(settings, stats) as client:   # robots.txt, delays, retries for free
            html = await client.get_text("https://example.com/products?page=1")
            for card in LexborHTMLParser(html).css("div.product"):
                records.append(RawBook(
                    title=card.css_first("h2").text(strip=True),
                    category=card.attributes.get("data-category"),
                    price=card.css_first(".price").text(strip=True),
                    availability=card.css_first(".stock").text(strip=True),
                    rating=card.attributes.get("data-rating"),
                    upc=card.attributes.get("data-sku"),
                    product_url=card.css_first("a").attributes["href"],
                    scraped_at=datetime.now(timezone.utc),
                ))
        return ExtractResult(records=records, stats=stats)
```

2. **Register it** in `src/extract/__init__.py`: `SOURCES[MyShopSource.name] = MyShopSource`.
3. **Add a fixture and test**: save one page to `tests/fixtures/` and assert the parsed fields in `tests/test_extract.py` with `respx`.
4. **Run it**: `python cli.py run --source my_shop --limit-pages 1`.

If the new site has a different shape (for example reviews instead of products), add a Raw/clean model in `src/models.py`, a transform in `src/transform/`, a table in `sql/schema.sql` and a loader function, then route its `kind` in `src/pipeline.py`.

## Ethics

Only scrape sites you are allowed to. This project targets **books.toscrape.com** and **quotes.toscrape.com**, which are sandboxes built for scraping practice. For any other site, read its Terms of Service, respect `robots.txt` (enforced by default with `RESPECT_ROBOTS_TXT=true`), identify your bot with an honest User-Agent, keep request rates low, and don't collect personal data.

## Tests

```bash
pytest              # 52 tests, fully offline (respx mocks httpx, HTML fixtures in tests/fixtures)
```

| Area | Checks |
|---|---|
| Extract | Catalogue and product fixtures parse into the right fields; a mocked 503 is retried then succeeds; retries give up after `MAX_RETRIES`; robots.txt blocks; failed product pages are counted |
| Transform | Price, rating and stock parsing, including "Out of stock", mojibake `Â£` and missing values; invalid rows rejected with a reason; UPC de-duplication; rejected CSV |
| Quality | Each check passes and fails on crafted DataFrames; only critical failures block |
| Load | Same load twice gives the same row counts; a changed price creates exactly one new snapshot; a failed extract is recorded as `failed`; a quality-gate failure loads nothing but keeps its results; simulated runs are flagged |

## Limitations & next steps

- The practice site's prices are static, so real history needs a live catalogue. The simulation is clearly labelled.
- SQLite on a branch is fine at this scale. A team setup would use managed Postgres, BigQuery or Snowflake.
- **Next:** dbt models and tests on top of the raw and staging layers, orchestration with Airflow, Prefect or Dagster, Slack or email alerts on failed runs and big price drops, incremental crawling with sitemaps or ETags, proxy rotation for harder targets, and a FastAPI layer for price alerts.

## Author

**Agha Kazim Ali — Python Data Analyst & AI Developer**

[Upwork](https://www.upwork.com/freelancers/your-profile) · [LinkedIn](https://www.linkedin.com/in/your-profile) · [GitHub](https://github.com/aghakazimali-ML)

Licensed under the [MIT License](LICENSE).
