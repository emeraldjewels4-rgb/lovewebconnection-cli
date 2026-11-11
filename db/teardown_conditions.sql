-- Teardown for the sample data and the daily aggregate.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/teardown_conditions.sql
--
-- Removes the seeded rows, the continuous aggregate (which takes its refresh
-- policy with it), and the ledger row claiming the migration was applied — so
-- both db/setup_conditions.sql and `npm run migrate -- up` can run again.
--
-- The source table is kept, because it may hold real data. To drop it too and
-- start from nothing:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v drop_table=1 -f db/teardown_conditions.sql
--
-- The timescaledb extension is shared and is never touched here.

\set ON_ERROR_STOP on

-- 1. Seeded rows only: the same devices and window as db/seed_conditions.sql,
--    so a shared database keeps everything that was not seeded.
DO $$
DECLARE
  removed integer;
BEGIN
  IF to_regclass('conditions') IS NULL THEN
    RAISE NOTICE 'conditions is absent; no seeded rows to remove';
  ELSE
    DELETE FROM conditions
    WHERE device IN ('sensor-a', 'sensor-b', 'sensor-c')
      AND time >= TIMESTAMPTZ '2026-01-01 00:00:00+00'
      AND time <  TIMESTAMPTZ '2026-01-03 00:00:00+00';
    GET DIAGNOSTICS removed = ROW_COUNT;
    RAISE NOTICE 'removed % seeded row(s)', removed;
  END IF;
END $$;

-- 2. The aggregate itself. Deliberately no CASCADE: if another continuous
--    aggregate has been built on this one, refusing is better than silently
--    dropping that too.
DROP MATERIALIZED VIEW IF EXISTS conditions_summary_daily;

-- 3. Forget the migration, so `npm run migrate -- up` applies it again rather
--    than deciding there is nothing to do.
DO $$
DECLARE
  forgotten integer;
BEGIN
  IF to_regclass('schema_migrations') IS NULL THEN
    RAISE NOTICE 'schema_migrations is absent; nothing recorded';
  ELSE
    DELETE FROM schema_migrations WHERE name = '0001_conditions_summary_daily';
    GET DIAGNOSTICS forgotten = ROW_COUNT;
    RAISE NOTICE 'forgot % migration ledger row(s)', forgotten;
  END IF;
END $$;

-- 4. Optional: the source table as well.
\if :{?drop_table}
  DROP TABLE IF EXISTS conditions;
\endif

-- 5. What is left behind.
SELECT
  to_regclass('conditions') AS conditions_table,
  to_regclass('conditions_summary_daily') AS daily_aggregate;
