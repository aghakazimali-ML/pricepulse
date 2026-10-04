-- PricePulse warehouse schema (star-like). Portable across SQLite and PostgreSQL.
-- `__PK__` is replaced at runtime by the dialect's auto-increment primary key
-- (SQLite: INTEGER PRIMARY KEY AUTOINCREMENT, Postgres: BIGSERIAL PRIMARY KEY).
-- Every statement is idempotent, so init-db can be run any number of times.
-- All timestamps are stored in UTC.

CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id          __PK__,
    source          VARCHAR(50)  NOT NULL,
    started_at      TIMESTAMP    NOT NULL,
    finished_at     TIMESTAMP,
    status          VARCHAR(20)  NOT NULL DEFAULT 'running',  -- running | success | failed
    rows_extracted  INTEGER      NOT NULL DEFAULT 0,
    rows_loaded     INTEGER      NOT NULL DEFAULT 0,
    rows_rejected   INTEGER      NOT NULL DEFAULT 0,
    is_simulated    BOOLEAN      NOT NULL DEFAULT FALSE,      -- demo runs from simulate-price-changes
    stats_json      TEXT,                                      -- pages fetched, retries, failures, duration
    error_message   TEXT
);

CREATE TABLE IF NOT EXISTS dim_category (
    category_id     __PK__,
    name            VARCHAR(120) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS dim_product (
    product_id      __PK__,
    upc             VARCHAR(64)  NOT NULL UNIQUE,
    title           VARCHAR(500) NOT NULL,
    category_id     INTEGER      NOT NULL REFERENCES dim_category (category_id),
    url             TEXT         NOT NULL,
    image_url       TEXT,
    description     TEXT,
    first_seen      TIMESTAMP    NOT NULL,
    last_seen       TIMESTAMP    NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_price_snapshot (
    snapshot_id     __PK__,
    product_id      INTEGER       NOT NULL REFERENCES dim_product (product_id),
    run_id          INTEGER       NOT NULL REFERENCES pipeline_runs (run_id),
    price           NUMERIC(10,2) NOT NULL,
    currency        VARCHAR(3)    NOT NULL DEFAULT 'GBP',
    in_stock        BOOLEAN       NOT NULL,
    stock_qty       INTEGER       NOT NULL,
    rating          INTEGER       NOT NULL,
    captured_at     TIMESTAMP     NOT NULL,
    UNIQUE (product_id, run_id)
);

CREATE TABLE IF NOT EXISTS quality_results (
    result_id       __PK__,
    run_id          INTEGER      NOT NULL REFERENCES pipeline_runs (run_id),
    check_name      VARCHAR(100) NOT NULL,
    status          VARCHAR(10)  NOT NULL,   -- pass | warn | fail
    severity        VARCHAR(10)  NOT NULL,   -- critical | soft
    details         TEXT,
    UNIQUE (run_id, check_name)
);

CREATE TABLE IF NOT EXISTS rejected_rows (
    rejected_id     __PK__,
    run_id          INTEGER      NOT NULL REFERENCES pipeline_runs (run_id),
    source          VARCHAR(50)  NOT NULL,
    record_key      TEXT,
    reason          TEXT         NOT NULL,
    payload         TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
    quote_id        __PK__,
    quote_hash      VARCHAR(32)  NOT NULL UNIQUE,
    text            TEXT         NOT NULL,
    author          VARCHAR(200) NOT NULL,
    tags            TEXT,
    page_url        TEXT,
    first_seen      TIMESTAMP    NOT NULL,
    last_seen       TIMESTAMP    NOT NULL,
    last_run_id     INTEGER      REFERENCES pipeline_runs (run_id)
);

CREATE INDEX IF NOT EXISTS ix_snapshot_product_time ON fact_price_snapshot (product_id, captured_at);
CREATE INDEX IF NOT EXISTS ix_snapshot_run ON fact_price_snapshot (run_id);
CREATE INDEX IF NOT EXISTS ix_product_category ON dim_product (category_id);
CREATE INDEX IF NOT EXISTS ix_runs_source_started ON pipeline_runs (source, started_at);
