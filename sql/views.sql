-- Analytical views used by the dashboard. DROP + CREATE keeps this idempotent on
-- both SQLite (no CREATE OR REPLACE VIEW) and PostgreSQL (no CREATE VIEW IF NOT EXISTS).

DROP VIEW IF EXISTS v_category_summary;
DROP VIEW IF EXISTS v_price_changes;
DROP VIEW IF EXISTS v_latest_prices;

-- Latest known state of every product.
CREATE VIEW v_latest_prices AS
SELECT
    p.product_id,
    p.upc,
    p.title,
    c.name        AS category,
    s.price,
    s.currency,
    s.in_stock,
    s.stock_qty,
    s.rating,
    s.captured_at,
    s.run_id,
    p.url,
    p.image_url,
    p.first_seen,
    p.last_seen
FROM dim_product p
JOIN dim_category c ON c.category_id = p.category_id
JOIN (
    SELECT fs.*,
           ROW_NUMBER() OVER (PARTITION BY fs.product_id ORDER BY fs.captured_at DESC, fs.snapshot_id DESC) AS rn
    FROM fact_price_snapshot fs
) s ON s.product_id = p.product_id AND s.rn = 1;

-- Every price movement: previous vs new price for consecutive snapshots of a product.
CREATE VIEW v_price_changes AS
SELECT
    x.product_id,
    p.upc,
    p.title,
    c.name                                              AS category,
    x.old_price,
    x.price                                             AS new_price,
    x.price - x.old_price                               AS price_diff,
    ROUND(CAST((x.price - x.old_price) * 100.0 / x.old_price AS NUMERIC), 2) AS pct_change,
    x.old_captured_at,
    x.captured_at                                       AS changed_at,
    x.run_id,
    r.is_simulated
FROM (
    SELECT fs.product_id,
           fs.run_id,
           fs.price,
           fs.captured_at,
           LAG(fs.price)       OVER (PARTITION BY fs.product_id ORDER BY fs.captured_at, fs.snapshot_id) AS old_price,
           LAG(fs.captured_at) OVER (PARTITION BY fs.product_id ORDER BY fs.captured_at, fs.snapshot_id) AS old_captured_at
    FROM fact_price_snapshot fs
) x
JOIN dim_product p     ON p.product_id = x.product_id
JOIN dim_category c    ON c.category_id = p.category_id
JOIN pipeline_runs r   ON r.run_id = x.run_id
WHERE x.old_price IS NOT NULL AND x.price <> x.old_price;

-- Per-category roll-up of the latest prices.
CREATE VIEW v_category_summary AS
SELECT
    category,
    COUNT(*)                                                    AS products,
    ROUND(CAST(AVG(price) AS NUMERIC), 2)                       AS avg_price,
    MIN(price)                                                  AS min_price,
    MAX(price)                                                  AS max_price,
    ROUND(CAST(AVG(rating) AS NUMERIC), 2)                      AS avg_rating,
    ROUND(CAST(AVG(CASE WHEN in_stock THEN 1.0 ELSE 0.0 END) * 100 AS NUMERIC), 1) AS pct_in_stock,
    SUM(stock_qty)                                              AS total_stock
FROM v_latest_prices
GROUP BY category;
