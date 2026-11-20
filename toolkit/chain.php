<?php
/**
 * chain.php — the small feed web9999.js reads.
 *
 * It holds no copy of the chain id, the chain name or the database name. It asks
 * the site's own JSON API for them, so this file cannot drift out of step with
 * index.php the way a constant would: if the API is reconfigured for another
 * chain or another database, this feed follows it without an edit here.
 *
 * Two parts of the schema are reported as unknown, on purpose:
 *
 *   gas_price_gwei   measured by one batched POST to the node the API itself
 *                    reads (eth_blockNumber + eth_gasPrice in one round trip).
 *                    null when the node does not answer: an unanswered method is
 *                    not the same measurement as a zero price.
 *   gateway, domains nothing on this host records which hostnames answer or how
 *                    many bindings are on. A number here would be invented.
 *
 * chain.php?format=json is the shape web9999.js expects; the query string is
 * accepted for symmetry with the page and ignored.
 *
 * Deploy at public_html/toolkit/chain.php.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

/** The site's own API. Env override exists so this file can be exercised locally. */
const API_BASE = 'https://fiatgod.x10.mx/api/web9999';
const TIMEOUT = 3;

/** The node the API itself reads, so gas is quoted for the same chain as the block. */
const RPC_URL = 'https://polygon-bor-rpc.publicnode.com';

/**
 * The feed is public, and every call it serves becomes a call to this host's own
 * API and to the RPC node behind it. So it is also where a stranger can spend
 * this account's CPU and the node's rate limit. Two cheap guards, the same pair
 * explorer/rpc.php uses, neither of which changes what the page receives:
 *
 * - only the page may call it: the browser's same-origin signal must be present
 *   and must name this host. A script pointed at this URL gets 403; forging the
 *   header is possible, which is what the second guard is for;
 * - a fixed window per address, counted in one small file so no database is
 *   involved. Thirty calls a minute is far above one page load, which asks once.
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
 * An Origin naming this host is the whole test wherever a browser sends one; a
 * same-origin GET usually carries none, so Sec-Fetch-Site is accepted as an equal
 * because it says `same-origin` outright. There is deliberately no Referer
 * fallback: it is the weakest of the three, and a client sending neither header is
 * not a page at all - it is the relay traffic this guard turns away.
 */
function from_page(): bool
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
 * failure must not become the page's outage.
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

/** Refuse, in the same shape a caller can still parse as JSON. */
function deny(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['state' => 'denied', 'error' => $message], JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * One GET, parsed, or null on anything that is not a 200 carrying JSON.
 *
 * The timeout is not decoration: on a host whose PHP pool has a single worker, a
 * request from a worker back to the same host can wait for a free worker that
 * cannot exist while this one is held. Without a bound that wait is the page.
 */
function fetch_json(string $url): ?array
{
    if (!function_exists('curl_init')) {
        return null;
    }
    $handle = curl_init($url);
    if ($handle === false) {
        return null;
    }
    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => TIMEOUT,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($handle);
    $status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);

    if ($body === false || $status !== 200) {
        return null;
    }
    $data = json_decode($body, true);

    return is_array($data) ? $data : null;
}

/**
 * eth_blockNumber and eth_gasPrice, in one request.
 *
 * One POST rather than two: the round trip is the whole cost of this step, so a
 * second POST would roughly double what gas adds to a page load. The answers are
 * matched by JSON-RPC id, because a batch is not guaranteed to come back in the
 * order it was sent.
 *
 * @return array{0: ?int, 1: ?int} block height and gas price in wei; either is
 *                                 null when that method did not answer.
 */
function rpc(): array
{
    if (!function_exists('curl_init')) {
        return [null, null];
    }
    $handle = curl_init(RPC_URL);
    if ($handle === false) {
        return [null, null];
    }
    curl_setopt_array($handle, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            ['jsonrpc' => '2.0', 'id' => 'block', 'method' => 'eth_blockNumber', 'params' => []],
            ['jsonrpc' => '2.0', 'id' => 'gas', 'method' => 'eth_gasPrice', 'params' => []],
        ]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => TIMEOUT,
    ]);
    $body = curl_exec($handle);
    $ok = curl_getinfo($handle, CURLINFO_RESPONSE_CODE) === 200;
    curl_close($handle);

    $answers = [];
    $batch = $ok && is_string($body) ? json_decode($body, true) : null;
    foreach (is_array($batch) ? $batch : [] as $entry) {
        if (is_array($entry) && is_string($entry['id'] ?? null)) {
            $answers[$entry['id']] = from_hex($entry['result'] ?? null);
        }
    }

    return [$answers['block'] ?? null, $answers['gas'] ?? null];
}

/** A 0x quantity as an int, or null when it is not one. */
function from_hex($value): ?int
{
    return is_string($value) && preg_match('/^0x[0-9a-fA-F]+$/', $value)
        ? (int) hexdec(substr($value, 2))
        : null;
}

/** An int, or null — a JSON number decoded as float is still a number. */
function as_int($value): ?int
{
    return is_int($value) ? $value : (is_float($value) && floor($value) === $value ? (int) $value : null);
}

$base = getenv('WEB9999_API_BASE') ?: API_BASE;

// Both guards run before the API call: a refused request costs this host nothing
// and never reaches the API or the node behind it.
if (!from_page()) {
    deny(403, 'this feed answers the page it is served with, not other callers');
}

[$limited, $retryAfter] = rate_limited(client_ip());
if ($limited) {
    header('Retry-After: ' . (string) $retryAfter);
    deny(429, 'too many calls from this address; try again in ' . $retryAfter . ' seconds');
}

// The API answers at the directory: /api/web9999/, not /api/web9999/index.php,
// which its router reports as "unknown route".
$index = fetch_json(rtrim($base, '/') . '/');

$chain = is_array($index['chain'] ?? null) ? $index['chain'] : [];
$chainId = as_int($chain['id'] ?? null);
$chainName = is_string($chain['name'] ?? null) && $chain['name'] !== '' ? $chain['name'] : null;
$block = as_int($chain['head'] ?? null);

// Gas is measured, not inferred. One batched POST answers both questions; when
// the node does not answer the block still stands on the API's own head, and gas
// stays null rather than becoming a number nothing measured.
[$rpcBlock, $gasWei] = rpc();
$block = $block ?? $rpcBlock;

// The API lists every database it probes. storage.database means the one the
// page is describing, which it labels "Explorer index"; fall back to the first
// entry only because that is the same row, and only when the label is missing.
$database = null;
$databases = is_array($index['databases'] ?? null) ? $index['databases'] : [];
$named = [];
foreach ($databases as $entry) {
    if (is_array($entry) && is_string($entry['name'] ?? null) && $entry['name'] !== '') {
        $named[] = $entry;
    }
}
foreach ($named as $entry) {
    if (($entry['label'] ?? null) === 'Explorer index') {
        $database = $entry['name'];
        break;
    }
}
if ($database === null && $named !== []) {
    $database = $named[0]['name'];
}

// ts is when the API measured, which is the honest timestamp for these values.
// gmdate is used rather than date so the page sees UTC whatever the host's zone.
$checkedAt = as_int($index['ts'] ?? null);
$checkedAt = $checkedAt === null ? gmdate('c') : gmdate('c', $checkedAt);

echo json_encode([
    'state' => $block === null ? 'unknown' : 'live',
    'network' => $chainName,
    'live' => [
        'chain_id' => $chainId,
        'block' => $block,
        // The node quotes wei; the page shows gwei. null stays null.
        'gas_price_gwei' => $gasWei === null ? null : round($gasWei / 1e9, 3),
        'checked_at' => $checkedAt,
    ],
    // domains is null, not []: the page reads an array as a measurement, so []
    // would make every badge read "not listed" - a claim that these hostnames
    // were checked and are absent. null makes them read "unknown", which is true.
    'gateway' => ['on' => null, 'matches' => 0, 'domains' => null],
    'domains' => ['on' => null, 'total' => 0],
    'storage' => ['database' => $database],
], JSON_UNESCAPED_SLASHES);
