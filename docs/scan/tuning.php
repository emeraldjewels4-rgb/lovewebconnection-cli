<?php
declare(strict_types=1);

/**
 * How much one ingest run may do, shipped with the package.
 *
 * These are floors, not overrides: `api.php` takes the larger of this file and
 * the host's `config.php`, so an operator can raise them further and a stale
 * host value cannot quietly throttle the crawler back to what it used to be.
 *
 * `config.php` cannot hold the right numbers on its own, because it was written
 * once by hand before the crawler could afford to be fast. It said 5 blocks and
 * 20 seconds, which is 5 blocks every five minutes against the ~150 Polygon
 * produces — a backlog that can only grow, and did: 6,300 blocks behind and
 * climbing. `store_block` now reads a whole block's receipts in one call instead
 * of one call per transaction (~51 calls per block down to 2), so the same
 * twenty seconds covers tens of blocks and this file is where the rest of the
 * headroom is spent.
 *
 * `seconds` stays well under the five-minute interval. Cron on shared hosting is
 * not a queue: a run that overruns its slot starts again on top of itself, and
 * two crawlers writing `progress` is how a block gets ingested twice or skipped.
 * The process is the cron one, so PHP's 30-second web limit does not apply, but
 * the interval still does.
 */
return [
    /** An upper bound only — the clock is the real limit. */
    'batch' => 1000,
    /** Wall-clock budget for one run, in seconds. */
    'seconds' => 120,
];
