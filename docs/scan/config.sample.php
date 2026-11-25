<?php
declare(strict_types=1);

/**
 * Copy this file to `config.php` (same directory) on the host and fill it in.
 *
 * `config.php` is deliberately not in the repository and not in the deploy
 * package: it holds a database password, and a package that carried one would put
 * it in every upload. The explorer page works without it — it reads the chain
 * live — and gains address history only once this exists and a cron job runs the
 * ingest route.
 *
 * The database comes from cPanel → MySQL Databases. On this host it is only
 * reachable from the host itself, which is where this file runs.
 *
 * The cron job (cPanel → Cron Jobs, every five minutes) is:
 *
 *   /usr/local/bin/php /home/…/scan/api.php ingest
 *
 * and if the PHP binary is somewhere else, `which php` in a cPanel terminal says
 * where. The HTTP form works too — `api/ingest?key=…` — for a service that would
 * rather call a URL than start a process.
 */
return [
    'db' => [
        // cPanel puts the account name in front of both, e.g. fiatgodx_lwc.
        'host' => 'localhost',
        'port' => 3306,
        'name' => 'account_scan',
        'user' => 'account_scan',
        'password' => '',
    ],
    'rpc' => 'https://polygon-bor-rpc.publicnode.com',
    // The key the HTTP ingest route requires. `php api.php ingest` does not need
    // it: a process started by cron is already the operator.
    'cron_key' => 'change-me-to-something-long',
    // Blocks per run and the wall-clock budget for one run, in seconds. Cron on
    // shared hosting is not a queue: a run that overruns its interval stacks up
    // behind itself, so this stops well short of five minutes.
    //
    // These were 5 and 20 while `store_block` fetched a receipt per transaction
    // (~51 calls a block). It now reads the block's receipts in one call, so the
    // same twenty seconds covers tens of blocks and 5 became the reason the index
    // fell thousands of blocks behind. `tuning.php`, shipped beside this file,
    // holds the current floors (1000 / 120) and `api.php` takes the larger of the
    // two — raise these above that if this host can afford more.
    'batch' => 1000,
    'seconds' => 120,
];
