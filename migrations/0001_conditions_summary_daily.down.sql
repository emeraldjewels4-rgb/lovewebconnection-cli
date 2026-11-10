-- 0001 down — remove the daily rollup and everything that only exists for it.
--
-- Dropping a continuous aggregate also removes the refresh policy created by
-- add_continuous_aggregate_policy, so there is no separate policy to drop.
-- Confirm nothing is left behind with:
--
--   SELECT job_id, application_name FROM timescaledb_information.jobs
--   WHERE hypertable_name = 'conditions_summary_daily';
--
-- The timescaledb extension and the `conditions` hypertable are shared with
-- other objects and are intentionally left alone; dropping them here would make
-- this migration destructive far beyond its own scope.

DROP MATERIALIZED VIEW IF EXISTS conditions_summary_daily;
