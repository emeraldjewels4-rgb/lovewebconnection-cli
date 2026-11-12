<?php
declare(strict_types=1);

/**
 * `/api/web9999/coins` — the coin table, read from MySQL.
 *
 *   GET  /api/web9999/coins          what the database holds, now
 *   POST /api/web9999/coins          refresh from Blockchair (token required)
 *   php  api/web9999/coins.php       the same refresh, from the shell or cron
 *
 * The page never calls Blockchair. A refresh is metered upstream — the free plan
 * allows roughly thirty calls a minute — so seventeen chains are spent once per
 * refresh by whoever owns the token, and every visitor reads the result from
 * MySQL. That is also why GET does not create tables: a public read should not be
 * able to run DDL. It reports `needs_schema` instead, and the refresh (token or
 * CLI) is the thing that creates them.
 *
 * A failed refresh is stored, not swallowed: the refused chain keeps its row with
 * `error` set and the numbers cleared, so the page shows "refused" beside a real
 * timestamp rather than a blank that reads as zero.
 */

require __DIR__ . '/lib/coins.php';

function answer(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    // Every field here is a measurement; a cached copy would claim to be current.
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$isCli = PHP_SAPI === 'cli';

if ($method === 'POST' || $isCli) {
    $token = getenv('WEB9999_REFRESH_TOKEN');
    if (!$isCli) {
        if (!is_string($token) || strlen($token) < 16) {
            answer(503, [
                'ok' => false,
                'error' => 'refresh is not configured on this host',
                'hint' => 'set WEB9999_REFRESH_TOKEN above the web root, or run the importer from the shell',
            ]);
        }
        $given = (string) ($_SERVER['HTTP_X_WEB9999_TOKEN'] ?? '');
        if (!hash_equals($token, $given)) {
            answer(403, ['ok' => false, 'error' => 'token rejected']);
        }
    }

    [$pdo, $reason, $engine] = web9999_connect();
    if (!$pdo instanceof PDO) {
        answer(503, ['ok' => false, 'error' => (string) $reason]);
    }

    web9999_ensure_schema($pdo);
    web9999_seed($pdo);

    // `?chain=bitcoin` (or `--chain=bitcoin`) refreshes one chain: useful when a
    // single slug is failing, and it keeps a manual re-run inside the rate limit.
    $only = null;
    if ($isCli) {
        foreach (array_slice($_SERVER['argv'] ?? [], 1) as $argument) {
            if (str_starts_with($argument, '--chain=')) {
                $only = substr($argument, strlen('--chain='));
            }
        }
    } elseif (isset($_GET['chain']) && is_string($_GET['chain'])) {
        $only = (string) $_GET['chain'];
    }

    $known = web9999_chains();
    $wanted = $only === null ? array_keys($known) : [$only];
    $results = [];
    $updated = 0;
    $failed = 0;

    foreach ($wanted as $index => $chain) {
        if (!isset($known[$chain])) {
            $results[] = ['chain' => $chain, 'ok' => false, 'error' => 'not a chain this module keeps'];
            $failed += 1;
            continue;
        }
        // Seventeen calls back to back is what the free plan rate-limits; the
        // pause is the difference between a refresh and a ban.
        if ($index > 0) {
            sleep(2);
        }
        $fetched = web9999_coin($chain);
        web9999_save(
            $pdo,
            $chain,
            is_array($fetched['reading']) ? $fetched['reading'] : [],
            $fetched['ok'] ? null : (string) ($fetched['error'] ?? 'refused'),
        );
        $results[] = [
            'chain' => $chain,
            'ok' => (bool) $fetched['ok'],
            'error' => $fetched['ok'] ? null : $fetched['error'],
        ];
        if ($fetched['ok']) {
            $updated += 1;
        } else {
            $failed += 1;
        }
    }

    answer(200, [
        'ok' => $failed === 0,
        'ts' => time(),
        'database' => WEB9999_COIN_DB,
        'engine' => $engine,
        'refreshed' => $updated,
        'refused' => $failed,
        'results' => $results,
        'count' => count(web9999_rows($pdo)),
    ]);
}

if ($method !== 'GET' && $method !== 'HEAD') {
    header('Allow: GET, POST');
    answer(405, ['ok' => false, 'error' => 'only GET and POST are answered here']);
}

[$pdo, $reason, $engine] = web9999_connect();
if (!$pdo instanceof PDO) {
    answer(503, [
        'ok' => false,
        'error' => (string) $reason,
        'database' => WEB9999_COIN_DB,
    ]);
}

if (!web9999_has_schema($pdo)) {
    answer(200, [
        'ok' => true,
        'ts' => time(),
        'database' => WEB9999_COIN_DB,
        'engine' => $engine,
        'needs_schema' => true,
        'count' => 0,
        'coins' => [],
        'hint' => 'run db/web9999-coins.sql in cPanel, or refresh once with the token / from the shell',
    ]);
}

$coins = web9999_rows($pdo);
$ages = array_filter(array_map(static fn (array $row): ?int => $row['age_seconds'], $coins), static fn (?int $v): bool => $v !== null);

answer(200, [
    'ok' => true,
    'ts' => time(),
    'database' => WEB9999_COIN_DB,
    'engine' => $engine,
    'needs_schema' => false,
    'count' => count($coins),
    // Fifteen minutes: one refresh interval plus slack, so a fresh cron run is
    // not called stale and a stopped one is not called current.
    'stale' => $ages !== [] && min($ages) > 900,
    'coins' => $coins,
]);
