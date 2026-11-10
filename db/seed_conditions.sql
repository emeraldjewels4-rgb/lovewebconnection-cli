-- Sample data for `conditions`, and an end-to-end check of the daily aggregate.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/setup_conditions.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seed_conditions.sql
--
-- Three devices x two days x four readings = 24 rows at fixed timestamps, so
-- every expectation below is exact rather than "roughly this". Re-running the
-- file replaces those same rows instead of duplicating them.
--
-- The rows are deliberately in the past, outside the refresh policy's window
-- (last month), so the explicit refresh below is what materializes them — which
-- is the point: it proves the aggregate can be backfilled, not just that
-- real-time queries paper over missing data.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('conditions') IS NULL THEN
    RAISE EXCEPTION 'table conditions is missing; run db/setup_conditions.sql first';
  END IF;
  IF to_regclass('conditions_summary_daily') IS NULL THEN
    RAISE EXCEPTION 'conditions_summary_daily is missing; run db/setup_conditions.sql first';
  END IF;
END $$;

-- Only the seeded devices and window, so real data is never touched.
DELETE FROM conditions
WHERE device IN ('sensor-a', 'sensor-b', 'sensor-c')
  AND time >= TIMESTAMPTZ '2026-01-01 00:00:00+00'
  AND time <  TIMESTAMPTZ '2026-01-03 00:00:00+00';

-- temperature = base + day * day_add + reading * step
--   sensor-a: 10,12,14,16 then 20,22,24,26   (averages 13 and 23)
--   sensor-b:  0, 5,10,15 then  8,13,18,23   (averages 7.5 and 15.5)
--   sensor-c: 100,100.5,101,101.5 then 102,102.5,103,103.5  (100.75 and 102.75)
INSERT INTO conditions (time, device, temperature)
SELECT
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
    + make_interval(days => day)
    + make_interval(hours => reading * 6),
  device,
  base + day * day_add + reading * step
FROM (VALUES
  ('sensor-a', 10::double precision, 10::double precision, 2::double precision),
  ('sensor-b',  0::double precision,  8::double precision, 5::double precision),
  ('sensor-c', 100::double precision, 2::double precision, 0.5::double precision)
) AS seeds(device, base, day_add, step)
CROSS JOIN generate_series(0, 1) AS day
CROSS JOIN generate_series(0, 3) AS reading;

-- Materialize the seeded window. Bucket-aligned bounds, end exclusive.
CALL refresh_continuous_aggregate(
  'conditions_summary_daily',
  TIMESTAMPTZ '2025-12-31 00:00:00+00',
  TIMESTAMPTZ '2026-01-04 00:00:00+00');

-- Fail loudly if the aggregate disagrees with the data above.
DO $$
DECLARE
  buckets integer;
  average double precision;
  lowest  double precision;
  highest double precision;
BEGIN
  SELECT count(*) INTO buckets
  FROM conditions_summary_daily
  WHERE bucket >= TIMESTAMPTZ '2026-01-01 00:00:00+00'
    AND bucket <  TIMESTAMPTZ '2026-01-03 00:00:00+00';
  IF buckets <> 6 THEN
    RAISE EXCEPTION 'expected 6 device-day buckets, found %', buckets;
  END IF;

  SELECT avg_temperature, min_temperature, max_temperature
  INTO average, lowest, highest
  FROM conditions_summary_daily
  WHERE device = 'sensor-a'
    AND bucket = TIMESTAMPTZ '2026-01-02 00:00:00+00';

  IF average IS NULL OR abs(average - 23) > 1e-9
     OR lowest <> 20 OR highest <> 26 THEN
    RAISE EXCEPTION 'sensor-a 2026-01-02 is avg %, min %, max %; expected 23, 20, 26',
      average, lowest, highest;
  END IF;

  SELECT avg_temperature INTO average
  FROM conditions_summary_daily
  WHERE device = 'sensor-c'
    AND bucket = TIMESTAMPTZ '2026-01-01 00:00:00+00';

  IF average IS NULL OR abs(average - 100.75) > 1e-9 THEN
    RAISE EXCEPTION 'sensor-c 2026-01-01 average is %, expected 100.75', average;
  END IF;

  RAISE NOTICE 'seed verified: 6 buckets, sensor-a avg 23 / min 20 / max 26, sensor-c avg 100.75';
END $$;

-- What the aggregate now holds for the seeded window.
SELECT
  device,
  bucket,
  round(avg_temperature::numeric, 2) AS avg,
  min_temperature AS min,
  max_temperature AS max
FROM conditions_summary_daily
WHERE bucket >= TIMESTAMPTZ '2026-01-01 00:00:00+00'
  AND bucket <  TIMESTAMPTZ '2026-01-03 00:00:00+00'
ORDER BY device, bucket;
