# PricePulse — common tasks. On Windows without make, see "Windows (no make)" in README.md.

PYTHON ?= python3
VENV   ?= .venv
ifeq ($(OS),Windows_NT)
	BIN := $(VENV)/Scripts
else
	BIN := $(VENV)/bin
endif
PY := $(BIN)/python

.PHONY: help setup init run run-all quick simulate quality dashboard test schedule demo-db docker-up docker-down clean

help:  ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup:  ## Create venv, install dependencies and the Playwright Chromium browser
	$(PYTHON) -m venv $(VENV)
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -r requirements.txt
	$(PY) -m playwright install chromium
	@test -f .env || cp .env.example .env

init:  ## Create tables, indexes and views (idempotent)
	$(PY) cli.py init-db

quick:  ## Fast smoke run: first 3 catalogue pages only
	$(PY) cli.py run --source books --limit-pages 3

run:  ## Scrape all 1,000 books
	$(PY) cli.py run --source books

run-all:  ## Run every source (books + JS quotes)
	$(PY) cli.py run --all

simulate:  ## Demo: create 3 simulated daily runs with price changes
	$(PY) cli.py simulate-price-changes --runs 3

quality:  ## Show the latest data-quality report
	$(PY) cli.py quality-report --last

dashboard:  ## Launch the Streamlit dashboard
	$(BIN)/streamlit run dashboard/Home.py

test:  ## Run the offline test suite
	$(PY) -m pytest

schedule:  ## Run the pipeline daily on this machine (APScheduler)
	$(PY) cli.py schedule --run-now

demo-db:  ## Build data/demo.db (full scrape + 5 simulated days) for Streamlit Cloud
	rm -f data/demo.db
	DATABASE_URL=sqlite:///data/demo.db $(PY) cli.py run --all
	DATABASE_URL=sqlite:///data/demo.db $(PY) cli.py simulate-price-changes --runs 5 --seed 42
	DATABASE_URL=sqlite:///data/demo.db $(PY) -c "import sqlite3; c = sqlite3.connect('data/demo.db'); c.execute('PRAGMA journal_mode=DELETE'); c.execute('VACUUM'); c.close()"

docker-up:  ## Postgres + pipeline + dashboard via Docker Compose
	docker compose up --build

docker-down:  ## Stop the Compose stack (add -v manually to drop the Postgres volume)
	docker compose down

clean:  ## Remove caches, logs and the local SQLite DB (keeps demo.db)
	rm -rf .pytest_cache **/__pycache__ logs/*.log data/pricepulse.db* data/raw/*/ data/rejected/*.csv
