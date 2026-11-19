<?php
/**
 * Read-only JSON-RPC proxy for the lwc explorer.
 *
 * Public RPC endpoints do not all send CORS headers, so the browser cannot call
 * them directly. This forwards one request at a time to the chain's primary
 * endpoint, then its fallback, and says which one answered. Only read methods
 * are accepted: nothing here can sign or send a transaction. Because the URL is
 * public, it also answers only the page it is served with, and only so many times
 * per minute per address: a free public relay is not what this is for.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const READ_METHODS = [
    'eth_chainId',
    'eth_blockNumber',
    'eth_gasPrice',
    'eth_getBalance',
    'eth_getTransactionCount',
    'eth_getCode',
    'eth_getStorageAt',
    'eth_getBlockByNumber',
    'eth_getBlockByHash',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
    'eth_call',
    'eth_estimateGas',
    'eth_feeHistory',
    'eth_maxPriorityFeePerGas',
    'net_version',
];

/**
 * The proxy is public, so it is also the one place a stranger can spend this
 * account's CPU and the endpoints' own rate limits. Two cheap guards, neither of
 * which changes what may be called:
 *
 * - only the explorer may call it: the browser's same-origin signal must be
 *   present and must name this host. A script pointed at this URL with curl gets
 *   403; forging the header is possible, which is what the second guard is for;
 * - a fixed window per address, counted in one small file so no database is
 *   involved. Thirty calls a minute is well above the page's six probes plus a
 *   lookup, and well below what a relay needs to be useful.
 */
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 60;

/** The address the request came from. No forwarding header is trusted here. */
function client_ip(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return is_string($ip) ? $ip : '';
}

/**
 * Whether the request carries the browser's sign that it came from this site.
 *
 * An Origin naming this host is the whole test: every browser that can load the
 * explorer sends Origin on the POST this proxy requires, a long time before
 * Safari 16.4 added the second signal. Sec-Fetch-Site is accepted as an equal
 * because it says same-origin outright and costs nothing to read (Chromium 76+,
 * Firefox 90+, Safari 16.4+). There is deliberately no Referer fallback: it was
 * the weakest match of the three, it covered only clients that send neither
 * header, and such a client is not a page at all - it is the relay traffic this
 * guard turns away. An Origin that names another site is still refused even if
 * Sec-Fetch-Site agrees: the point is that the explorer is the caller.
 */
function from_explorer(): bool
{
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    if ($host === '') {
        return false;
    }
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin !== '') {
        $originHost = parse_url($origin, PHP_URL_HOST);
        return is_string($originHost) && strcasecmp($originHost, $host) === 0;
    }
    return ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'same-origin';
}

/**
 * Count one call for this address and say whether it is over the window's limit.
 *
 * One file per address under the system temp directory, locked while it is read
 * and written, so two simultaneous requests cannot both believe they are first. A
 * directory that cannot be created or opened returns "not limited": a counter's
 * failure must not become the site's outage.
 *
 * @return array{0: bool, 1: int} whether it is limited, and the seconds to wait
 */
function rate_limited(string $ip): array
{
    if ($ip === '') {
        return [false, 0];
    }
    $dir = sys_get_temp_dir() . '/lwc-explorer-rl';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        return [false, 0];
    }
    $handle = @fopen($dir . '/' . hash('sha256', $ip) . '.json', 'c+');
    if ($handle === false) {
        return [false, 0];
    }

    $limited = false;
    $retryAfter = 0;
    if (flock($handle, LOCK_EX)) {
        $raw = stream_get_contents($handle);
        $state = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
        $now = time();
        $start = is_array($state) && is_int($state['start'] ?? null) ? $state['start'] : $now;
        $count = is_array($state) && is_int($state['count'] ?? null) ? $state['count'] : 0;

        if ($now - $start >= RATE_WINDOW_SECONDS) {
            $start = $now;
            $count = 0;
        }
        if ($count >= RATE_LIMIT) {
            $limited = true;
            $retryAfter = max(1, $start + RATE_WINDOW_SECONDS - $now);
        } else {
            rewind($handle);
            ftruncate($handle, 0);
            fwrite($handle, json_encode(['start' => $start, 'count' => $count + 1]));
            fflush($handle);
        }
        flock($handle, LOCK_UN);
    }
    fclose($handle);

    return [$limited, $retryAfter];
}

function fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32600, 'message' => $message]]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'use POST');
}

if (!from_explorer()) {
    fail(403, 'this proxy answers the explorer page it is served with, not other callers');
}

[$limited, $retryAfter] = rate_limited(client_ip());
if ($limited) {
    header('Retry-After: ' . (string) $retryAfter);
    fail(429, 'too many calls from this address; try again in ' . $retryAfter . ' seconds');
}

$request = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($request) || ($request['jsonrpc'] ?? '') !== '2.0' || !is_string($request['method'] ?? null)) {
    fail(400, 'the body must be a JSON-RPC 2.0 request');
}
if (!in_array($request['method'], READ_METHODS, true)) {
    fail(400, 'that method is not part of the explorer\'s read-only set');
}
$params = $request['params'] ?? [];
if (!is_array($params) || count($params) > 4) {
    fail(400, 'params must be an array of at most four values');
}

$chain = (string) ($_GET['chain'] ?? '');
$presetsPath = __DIR__ . '/presets.json';
$presets = is_readable($presetsPath) ? json_decode((string) file_get_contents($presetsPath), true) : null;
if (!is_array($presets) || !is_array($presets['chains'] ?? null)) {
    fail(500, 'presets.json is missing or unreadable');
}

$preset = null;
foreach ($presets['chains'] as $row) {
    if (is_array($row) && ($row['name'] ?? null) === $chain) {
        $preset = $row;
        break;
    }
}
if ($preset === null) {
    fail(400, 'unknown chain');
}

$payload = json_encode([
    'jsonrpc' => '2.0',
    'id' => $request['id'] ?? 1,
    'method' => $request['method'],
    'params' => $params,
], JSON_UNESCAPED_SLASHES);

$endpoints = is_array($preset['endpoints'] ?? null) ? $preset['endpoints'] : [];
$problems = [];

foreach (array_values($endpoints) as $index => $url) {
    if (!is_string($url) || !preg_match('#^https://#', $url)) {
        continue;
    }

    $body = false;
    $status = 0;

    if (function_exists('curl_init')) {
        $handle = curl_init($url);
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => ['content-type: application/json', 'accept: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 9,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_USERAGENT => 'lwc-explorer/1.0 (+read-only)',
        ]);
        $body = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        curl_close($handle);
        if ($body === false) {
            $problems[] = parse_url($url, PHP_URL_HOST) . ': ' . $error;
            continue;
        }
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "content-type: application/json\r\naccept: application/json\r\n",
                'content' => $payload,
                'timeout' => 9,
                'ignore_errors' => true,
            ],
        ]);
        $body = @file_get_contents($url, false, $context);
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $match)) {
            $status = (int) $match[1];
        }
        if ($body === false) {
            $problems[] = parse_url($url, PHP_URL_HOST) . ': unreachable';
            continue;
        }
    }

    $decoded = json_decode((string) $body, true);
    if ($status !== 200 || !is_array($decoded) || (!array_key_exists('result', $decoded) && !isset($decoded['error']))) {
        $problems[] = parse_url($url, PHP_URL_HOST) . ': HTTP ' . $status;
        continue;
    }

    // An RPC-level error is the endpoint's answer, not a reason to try another
    // operator: the backup would return the same error for the same request.
    header('X-Lwc-Via: ' . ($index === 0 ? 'primary' : 'fallback'));
    echo json_encode($decoded, JSON_UNESCAPED_SLASHES);
    exit;
}

fail(502, 'every endpoint for ' . $chain . ' failed' . ($problems ? ' (' . implode('; ', $problems) . ')' : ''));
