# PricePulse: demo script & Upwork write-up

## 5-step demo script (for a 30–45 s GIF)

1. **Terminal, fresh DB.** Run `python cli.py init-db && python cli.py run --source books --limit-pages 3`. Show the structured logs scrolling and the coloured run summary table (60 extracted, 60 loaded, 0 rejected).
2. **Idempotency.** Run the same command again. The table shows **0 new snapshots**, then `python cli.py runs` lists both runs. Mention that re-running never duplicates data.
3. **Simulate history.** Run `python cli.py simulate-price-changes --runs 3`, then `python cli.py quality-report --last` to show the green pass/warn checks.
4. **Dashboard, Home → Price History.** Run `streamlit run dashboard/Home.py`. Show the status chip and the KPI cards with their sparklines, then hover the average-price trend. Open **Price History** and pick a few products to show the step chart with the simulated points marked.
5. **Pipeline Health.** Hover the run strip tiles, scroll to the colour-coded run history, the data-quality table and the rejected-rows sample. End on the GitHub Actions run page showing the daily cron.

Tip: record at 1280×800 with a dark terminal theme so it matches the dashboard.

---

## Upwork portfolio write-up

**Title (≤70 chars):**
> Web Scraping ETL Pipeline: Python, Playwright, SQL & Streamlit Dashboard

**Description (~150 words):**

> **Problem:** Businesses that track competitor prices often rely on brittle one-off scripts. Those scripts break silently, duplicate data and keep no history.
>
> **Solution:** I built PricePulse, a production-style pipeline that scrapes a 1,000-product catalogue every day, including JavaScript-rendered pages. It cleans and validates every record and stores full price history in a SQL star schema. Async crawling uses retries, robots.txt compliance and rate limiting. Invalid rows are quarantined with a reason, and data-quality gates stop bad loads. Every run is tracked with row counts and errors. Loads are idempotent, so re-runs never duplicate data.
>
> **Tech:** Python, httpx, Playwright, Pydantic, pandas, SQLAlchemy (SQLite/PostgreSQL), GitHub Actions, Docker, Streamlit, Plotly, and a React and Tailwind chart kit from 21st.dev.
>
> **Result:** A hands-off daily pipeline and an interactive dashboard of prices, stock, ratings, price changes and pipeline health. It is deployable in minutes and backed by 52 automated tests.

**Skill tags:**
`Web Scraping` · `ETL Pipeline` · `Python` · `Data Engineering` · `SQL`
