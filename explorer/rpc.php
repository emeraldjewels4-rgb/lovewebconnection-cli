<?php
/**
 * Read-only JSON-RPC proxy for the lwc explorer.
 *
 * Public RPC endpoints do not all send CORS headers, so the browser cannot call
 * them directly. This forwards one request at a time to the chain's primary
 * endpoint, then its fallback, and says which one answered.
 *
 * It is unauthenticated: anyone who finds the path can spend this account's RPC
 * quota, so what it accepts is deliberately narrow.
 *
 *  - POST only, and `content-type: application/json` only. A plain HTML form
 *    cannot send that type without a preflight, so a stranger's page cannot make
 *    visitors' browsers post through here.
 *  - An Origin header, when one is present, must be this site's own, so a page on
 *    another origin is refused rather than served. This is a speed bump, not
 *    authentication: a script can set any Origin it likes.
 *  - The body is capped at 8 KiB, checked against the declared length before the
 *    body is read, so a large post cannot be buffered.
 *  - Only the ten read methods app.js calls. Nothing here can sign or send a
 *    transaction, and the range-hungry calls the page never makes are absent.
 *  - Block lookups must ask for transaction hashes: the full-transaction shape is
 *    ~20 times the size and the page never requests it.
 *  - The upstream answer is capped at 1 MiB and the transfer is aborted past
 *    that, so one request cannot drag an arbitrarily large answer through shared
 *    hosting. The cap has to clear a block: app.js asks eth_getBlockByNumber for
 *    the hash list, not full transactions, and a hash-list block measured at
 *    about 80 bytes per transaction, so an ordinary block is tens of kilobytes
 *    and a busy L2 block with thousands of hashes is a few hundred.
 *
 * There is no per-IP throttle: a request counter needs shared state that this
 * file does not have, and the edge is the right place for it. explorer/README.md
 * records that as the next step if the quota is ever abused.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const READ_METHODS = [
    'eth_chainId',
    'eth_blockNumber',
    'eth_getBalance',
    'eth_getTransactionCount',
    'eth_getCode',
    'eth_getStorageAt',
    'eth_getBlockByNumber',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
    'eth_call',
];

/** The largest request body accepted, in bytes. */
const MAX_REQUEST_BYTES = 8192;

/** The largest upstream answer relayed, in bytes; the transfer is cut past this. */
const MAX_RESPONSE_BYTES = 1048576;

function fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32600, 'message' => $message]]);
    exit;
}

/** True when the Origin header names this same scheme, host and port. */
function same_origin(string $origin): bool
{
    $scheme = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    return $host !== '' && strcasecmp(rtrim($origin, '/'), $scheme . '://' . $host) === 0;
}

/** The host of an endpoint URL, for messages that should not print the whole URL. */
function endpoint_host(string $url): string
{
    $host = parse_url($url, PHP_URL_HOST);
    return is_string($host) && $host !== '' ? $host : 'endpoint';
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'use POST');
}

$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
if ($origin !== '' && !same_origin($origin)) {
    fail(403, 'this proxy only answers its own page');
}

$contentType = strtolower(trim(explode(';', (string) ($_SERVER['CONTENT_TYPE'] ?? ''), 2)[0]));
if ($contentType !== 'application/json') {
    fail(415, 'content-type must be application/json');
}

// Declared first, so an oversized body is refused before it is read into memory.
$declared = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($declared > MAX_REQUEST_BYTES) {
    fail(413, 'the request body is over ' . MAX_REQUEST_BYTES . ' bytes');
}
$raw = (string) file_get_contents('php://input');
if (strlen($raw) > MAX_REQUEST_BYTES) {
    fail(413, 'the request body is over ' . MAX_REQUEST_BYTES . ' bytes');
}

$request = json_decode($raw, true);
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

// The page reads a block for its header and its transaction count, and asks for the
// hashes. A full-transaction block measured at 541 KB against 28 KB for the hash
// list on the same block, so refusing that shape keeps the largest answer this proxy
// can be made to fetch at a block's hash list instead of near the cap.
if ($request['method'] === 'eth_getBlockByNumber' && ($params[1] ?? false) !== false) {
    fail(400, 'blocks are read with their transactions as hashes, so the second param must be false');
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
    $tooLarge = false;

    if (function_exists('curl_init')) {
        $buffer = '';
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
            // Collects the answer here rather than in curl's own buffer, so a body
            // past the cap is cut off during the transfer instead of after it.
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$buffer, &$tooLarge): int {
                if (strlen($buffer) + strlen($chunk) > MAX_RESPONSE_BYTES) {
                    $tooLarge = true;
                    return 0; // aborts the transfer
                }
                $buffer .= $chunk;
                return strlen($chunk);
            },
        ]);
        $ok = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        // No curl_close(): it has had no effect since PHP 8.0 and 8.5 reports it
        // as deprecated, which prints before the headers and breaks the response.
        if ($tooLarge) {
            $problems[] = endpoint_host($url) . ': answer over ' . MAX_RESPONSE_BYTES . ' bytes';
            continue;
        }
        if ($ok === false) {
            $problems[] = endpoint_host($url) . ': ' . $error;
            continue;
        }
        $body = $buffer;
    } else {
        // No curl extension: the stream wrapper still lets the body be read in chunks,
        // so an answer past the cap is cut off instead of being buffered whole. The
        // status comes from the stream's own metadata rather than the deprecated
        // $http_response_header, which PHP 8.5 reports while compiling the file.
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "content-type: application/json\r\naccept: application/json\r\n",
                'content' => $payload,
                'timeout' => 9,
                'ignore_errors' => true,
            ],
        ]);
        $stream = @fopen($url, 'rb', false, $context);
        if ($stream === false) {
            $problems[] = endpoint_host($url) . ': unreachable';
            continue;
        }
        $buffer = '';
        while (!feof($stream) && strlen($buffer) <= MAX_RESPONSE_BYTES) {
            $buffer .= (string) fread($stream, 8192);
        }
        $meta = stream_get_meta_data($stream);
        fclose($stream);
        foreach ((array) ($meta['wrapper_data'] ?? []) as $line) {
            if (is_string($line) && preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $match)) {
                $status = (int) $match[1];
            }
        }
        if (strlen($buffer) > MAX_RESPONSE_BYTES) {
            $problems[] = endpoint_host($url) . ': answer over ' . MAX_RESPONSE_BYTES . ' bytes';
            continue;
        }
        $body = $buffer;
    }

    $decoded = json_decode((string) $body, true);
    if ($status !== 200 || !is_array($decoded) || (!array_key_exists('result', $decoded) && !isset($decoded['error']))) {
        $problems[] = endpoint_host($url) . ': HTTP ' . $status;
        continue;
    }

    // An RPC-level error is the endpoint's answer, not a reason to try another
    // operator: the backup would return the same error for the same request.
    header('X-Lwc-Via: ' . ($index === 0 ? 'primary' : 'fallback'));
    echo json_encode($decoded, JSON_UNESCAPED_SLASHES);
    exit;
}

fail(502, 'every endpoint for ' . $chain . ' failed' . ($problems ? ' (' . implode('; ', $problems) . ')' : ''));
