-- Full setup for the `conditions` hypertable and its daily continuous aggregate.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/setup_conditions.sql
--
-- Creates, in order: the extension, the source table and hypertable, the
-- continuous aggregate, real-time aggregation, the refresh policy, and the
-- initial backfill. Every object is created with IF NOT EXISTS, so re-running
-- the file is safe — but step 6 re-materializes the whole aggregate each time,
-- so it is not free. Skip that step on re-runs once history is backfilled.
--
-- This bootstraps a fresh database. For an existing one, use the versioned
-- migrations in migrations/ instead, which assume the table already exists.

\set ON_ERROR_STOP on

-- 1. Extension ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 2. Source table and hypertable --------------------------------------------
-- Adjust the column types to match your ingest: `temperature` is double
-- precision so fractional sensor readings survive the trip.
CREATE TABLE IF NOT EXISTS conditions (
  time        timestamptz      NOT NULL,
  device      text             NOT NULL,
  temperature double precision NOT NULL
);

SELECT create_hypertable('conditions', 'time', if_not_exists => TRUE);

-- The aggregate groups by (device, day); this index keeps each refresh from
-- sorting the whole hypertable.
CREATE INDEX IF NOT EXISTS conditions_device_time_idx
  ON conditions (device, time DESC);

-- 3. Continuous aggregate ----------------------------------------------------
-- Named columns: PostgreSQL would otherwise call these avg/max/min, and a
-- second average would then collide.
CREATE MATERIALIZED VIEW IF NOT EXISTS conditions_summary_daily
WITH (timescaledb.continuous) AS
SELECT
  device,
  time_bucket(INTERVAL '1 day', time) AS bucket,
  AVG(temperature) AS avg_temperature,
  MAX(temperature) AS max_temperature,
  MIN(temperature) AS min_temperature
FROM conditions
GROUP BY device, bucket
WITH NO DATA;

-- 4. Real-time aggregation ---------------------------------------------------
-- TimescaleDB 2.13+ defaults to materialized_only = true; this makes queries
-- read the current, not-yet-materialized day straight from the raw table.
ALTER MATERIALIZED VIEW conditions_summary_daily
  SET (timescaledb.materialized_only = false);

-- 5. Refresh policy ----------------------------------------------------------
-- Recompute the last month hourly, stopping one day short of now so the tail
-- stays open for late-arriving rows.
SELECT add_continuous_aggregate_policy('conditions_summary_daily',
  start_offset      => INTERVAL '1 month',
  end_offset        => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);

-- 6. Backfill ----------------------------------------------------------------
-- The view was created WITH NO DATA, so nothing historical is materialized yet.
-- NULL, NULL means "the entire range"; narrow it to a window on large tables.
CALL refresh_continuous_aggregate('conditions_summary_daily', NULL, NULL);

-- Verify:
--   SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates
--   WHERE view_name = 'conditions_summary_daily';
--   SELECT job_id, schedule_interval, config FROM timescaledb_information.jobs
--   WHERE hypertable_name = 'conditions_summary_daily';
--   SELECT count(*) FROM conditions_summary_daily;
