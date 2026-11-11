<?php
/**
 * Read-only JSON-RPC proxy for the lwc explorer.
 *
 * Public RPC endpoints do not all send CORS headers, so the browser cannot call
 * them directly. This forwards one request at a time to the chain's primary
 * endpoint, then its fallback, and says which one answered. Only read methods
 * are accepted: nothing here can sign or send a transaction.
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

function fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32600, 'message' => $message]]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'use POST');
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
