-- 0001 up — daily temperature rollup per device, as a continuous aggregate.
--
-- Prerequisites, deliberately not created here because they are shared objects:
--   * the timescaledb extension
--       CREATE EXTENSION IF NOT EXISTS timescaledb;
--   * `conditions` as a hypertable on its `time` column
--       SELECT create_hypertable('conditions', 'time');
--
-- Safe to re-run: the view and the policy both use IF NOT EXISTS. The aggregate
-- columns are named explicitly because PostgreSQL would otherwise call them
-- avg/max/min, which collide as soon as a second average is added.

CREATE MATERIALIZED VIEW IF NOT EXISTS conditions_summary_daily
WITH (timescaledb.continuous) AS
SELECT
  device,
  time_bucket(INTERVAL '1 day', time) AS bucket,
  AVG(temperature) AS avg_temperature,
  MAX(temperature) AS max_temperature,
  MIN(temperature) AS min_temperature
FROM conditions
GROUP BY device, bucket;

-- Serve the current, not-yet-materialized day from the raw rows. TimescaleDB
-- 2.13+ defaults to materialized_only = true, so this is what turns it on.
ALTER MATERIALIZED VIEW conditions_summary_daily
  SET (timescaledb.materialized_only = false);

-- Recompute the last month hourly, stopping one day short of now so the tail
-- stays open for late-arriving rows (and is read live by real-time queries).
SELECT add_continuous_aggregate_policy('conditions_summary_daily',
  start_offset      => INTERVAL '1 month',
  end_offset        => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);
