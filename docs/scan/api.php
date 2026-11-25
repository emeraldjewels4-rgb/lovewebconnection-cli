<?php
declare(strict_types=1);

/**
 * The index behind the explorer at `/scan/`, served at `/scan/api/…`.
 *
 * It indexes Polygon, chain 137 — the chain the page beside it reads, and the one
 * ZipChain, wZPC and the exchange live on. `chainId` in `status` is a claim about
 * what the rows contain, so it is a constant here rather than a guess from the RPC.
 *
 * The page beside it reads the chain live and needs nothing from this file. This
 * file exists for the one thing a live reader cannot do: history. An address page
 * can ask the RPC for a balance, a nonce and whether it is a contract, but not for
 * "what has this address done" — that needs someone to have written the blocks
 * down, because `eth_getLogs` is token-gated on this endpoint.
 *
 *   GET /scan/api/status                      what the index has, if anything
 *   GET /scan/api/address?address=0x…&limit=25 one address's indexed history
 *   GET /scan/api/ingest?key=…                one cron-sized bite of new blocks
 *   php api.php ingest                        the same, from a cron job
 *
 * The credentials come from `config.php` beside this file, which is not in the
 * repository and not in the deploy package: it is written once on the host from
 * `config.sample.php`. Without it every route answers `configured:false` and the
 * page falls back to reading the chain live, exactly as it did before the index
 * existed — a missing database must not turn into an error page.
 *
 * What the index can and cannot be: this chain is at block ~97 million. A cron
 * job cannot walk that from genesis, so the first run starts at the current head
 * and the index is complete only from there forward. Every surface that shows
 * indexed data says which block it starts at, because a history silently missing
 * its first 97 million blocks is worse than no history.
 */

/** `Transfer(address,address,uint256)` — the only log shape read here. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * `TokenCreated(address,address,string,string,uint8,uint256)` — the registry event
 * of TokenFactory at 0x7885A9A6fB23B3B8802A3420cF6C97Fb51720BA8.
 *
 * Only the two indexed addresses are read from it. The name, symbol, decimals and
 * supply stay on the new contract, where a wallet reads them; copying them here
 * would create a second place for a currency's identity to disagree with itself.
 */
const TOKEN_CREATED_TOPIC = '0x6aba688e0d9fb13e49808a9f69e09384142cd46853e4ecfcf79aa7e4d63c1832';

/* --------------------------------------------------------------- bootstrap */

function scan_config(): array
{
    $path = __DIR__ . '/config.php';
    if (!is_file($path)) {
        return [];
    }
    $config = require $path;

    return is_array($config) ? $config : [];
}

function answer(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    // History and counts change with every cron run; a cached copy would be a
    // page quietly insisting it is up to date.
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function route(): string
{
    if (PHP_SAPI === 'cli') {
        // `$_SERVER['argv']`, not `$argv`: the latter is not in scope inside a
        // function, and a cron run that reads an undefined variable silently
        // answers the index route instead of ingesting anything.
        return isset($_SERVER['argv'][1]) ? (string) $_SERVER['argv'][1] : '';
    }

    return isset($_GET['r']) ? (string) $_GET['r'] : '';
}

/**
 * One JSON-RPC call. The result is returned as it arrived: `eth_blockNumber`
 * answers a hex string and the block methods answer objects, and a return type of
 * `?array` here would have turned every height into `null`.
 */
function rpc_call(string $url, string $method, array $params, int $timeout = 20)
{
    $payload = json_encode([
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => $method,
        'params' => $params,
    ]);
    if ($payload === false) {
        return null;
    }

    $handle = curl_init($url);
    if ($handle === false) {
        return null;
    }
    curl_setopt_array($handle, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $timeout,
    ]);
    $raw = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);

    if (!is_string($raw) || $status !== 200) {
        return null;
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return null;
    }
    if (isset($decoded['error'])) {
        return null;
    }

    return $decoded['result'] ?? null;
}

function head_number(string $url): int
{
    $result = rpc_call($url, 'eth_blockNumber', [], 10);
    if (!is_string($result) || strpos($result, '0x') !== 0) {
        return 0;
    }

    return (int) hexdec(substr($result, 2));
}

/* ------------------------------------------------------------------ schema */

/**
 * Created on first use rather than by a migration step nobody remembers to run.
 * Every statement is `IF NOT EXISTS`, so running it on each ingest costs one round
 * trip and can never destroy a table.
 */
function schema(PDO $db): void
{
    $db->exec(
        'CREATE TABLE IF NOT EXISTS blocks (
            number BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            hash CHAR(66) NOT NULL,
            parent CHAR(66) NOT NULL,
            time BIGINT UNSIGNED NOT NULL,
            gas_used BIGINT UNSIGNED NOT NULL,
            gas_limit BIGINT UNSIGNED NOT NULL,
            base_fee VARCHAR(32) NULL,
            miner CHAR(42) NOT NULL,
            tx_count INT UNSIGNED NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    $db->exec(
        'CREATE TABLE IF NOT EXISTS txs (
            hash CHAR(66) NOT NULL PRIMARY KEY,
            block_number BIGINT UNSIGNED NOT NULL,
            tx_index INT UNSIGNED NOT NULL,
            from_addr CHAR(42) NOT NULL,
            to_addr CHAR(42) NULL,
            value VARCHAR(80) NOT NULL,
            status TINYINT NULL,
            gas_used BIGINT UNSIGNED NULL,
            KEY block_number (block_number),
            KEY from_addr (from_addr),
            KEY to_addr (to_addr)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    $db->exec(
        'CREATE TABLE IF NOT EXISTS transfers (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            tx_hash CHAR(66) NOT NULL,
            block_number BIGINT UNSIGNED NOT NULL,
            log_index INT UNSIGNED NOT NULL,
            token CHAR(42) NOT NULL,
            from_addr CHAR(42) NOT NULL,
            to_addr CHAR(42) NOT NULL,
            amount VARCHAR(80) NOT NULL,
            UNIQUE KEY once (tx_hash, log_index),
            KEY from_addr (from_addr),
            KEY to_addr (to_addr),
            KEY block_number (block_number)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    $db->exec(
        'CREATE TABLE IF NOT EXISTS progress (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            last_block BIGINT UNSIGNED NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    // The row counts every reader used to recompute. `transfers` is tens of
    // millions of rows and COUNT(*) over it is a full index scan — fourteen
    // seconds, which is why the status page could not answer before a publish
    // check timed out on it. One row, written once per ingest run.
    $db->exec(
        'CREATE TABLE IF NOT EXISTS counts (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            blocks BIGINT UNSIGNED NOT NULL,
            txs BIGINT UNSIGNED NOT NULL,
            transfers BIGINT UNSIGNED NOT NULL,
            tokens BIGINT UNSIGNED NOT NULL,
            counted_at BIGINT UNSIGNED NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    // Every currency created through the factory, learned from the chain rather
    // than from a form: anyone can deploy a token without telling this host, and
    // the registry still finds it because the event is in the receipt.
    $db->exec(
        'CREATE TABLE IF NOT EXISTS tokens (
            token CHAR(42) NOT NULL PRIMARY KEY,
            creator CHAR(42) NOT NULL,
            tx_hash CHAR(66) NOT NULL,
            block_number BIGINT UNSIGNED NOT NULL,
            KEY creator (creator),
            KEY block_number (block_number)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    // A copy of what someone else verified. This index does not compile anything:
    // Sourcify does that, and the copy is kept so a contract page still answers when
    // Sourcify is slow or down. fetched_at is printed beside the source, because a
    // cached copy can outlive the code it describes.
    $db->exec(
        'CREATE TABLE IF NOT EXISTS contracts (
            address CHAR(42) NOT NULL PRIMARY KEY,
            chain_id INT UNSIGNED NOT NULL,
            name VARCHAR(190) NULL,
            compiler VARCHAR(120) NULL,
            language VARCHAR(40) NULL,
            verified_at VARCHAR(40) NULL,
            match_type VARCHAR(40) NULL,
            source_count INT UNSIGNED NOT NULL,
            sources LONGTEXT NULL,
            abi LONGTEXT NULL,
            runtime_bytecode LONGTEXT NULL,
            fetched_at BIGINT UNSIGNED NOT NULL,
            origin VARCHAR(40) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
}

/**
 * A JSON GET with no key and no credentials, because the one file whose compromise
 * would matter is config.php and it must not have to hold an explorer key.
 */
function http_json(string $url, int $timeout = 20): ?array
{
    $context = stream_context_create([
        'http' => [
            'method' => 'GET',
            'timeout' => $timeout,
            'header' => ['accept: application/json', 'user-agent: fiatgodx-scan/1'],
        ],
    ]);
    $raw = @file_get_contents($url, false, $context);
    if ($raw === false) {
        return null;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

/**
 * What Sourcify knows about one address on this chain. Null means "asked and could
 * not find out" - which is different from "verified nothing", and the route says so.
 */
function contract_fetch(string $address): ?array
{
    $url = 'https://sourcify.dev/server/v2/contract/137/' . $address
        . '?fields=sources,abi,runtimeBytecode,compilation';
    $body = http_json($url, 25);
    if ($body === null || !isset($body['match'])) {
        return null;
    }
    $compilation = isset($body['compilation']) && is_array($body['compilation']) ? $body['compilation'] : [];
    $sources = [];
    $rawSources = isset($body['sources']) && is_array($body['sources']) ? $body['sources'] : [];
    foreach ($rawSources as $path => $entry) {
        $content = is_array($entry) && isset($entry['content']) ? (string) $entry['content'] : '';
        $sources[(string) $path] = $content;
    }
    $bytecode = $body['runtimeBytecode'] ?? null;
    if (is_array($bytecode)) {
        $bytecode = $bytecode['onchainBytecode'] ?? ($bytecode['runtimeBytecode'] ?? null);
    }
    return [
        'address' => $address,
        'chain_id' => 137,
        'name' => (string) ($compilation['name'] ?? ''),
        'compiler' => (string) ($compilation['compilerVersion'] ?? ''),
        'language' => (string) ($compilation['language'] ?? ''),
        'verified_at' => (string) ($body['verifiedAt'] ?? ''),
        'match_type' => (string) ($body['match'] ?? ''),
        'sources' => $sources,
        'abi' => isset($body['abi']) ? json_encode($body['abi'], JSON_UNESCAPED_SLASHES) : null,
        'runtime_bytecode' => is_string($bytecode) ? $bytecode : null,
        'fetched_at' => time(),
        'origin' => 'sourcify',
    ];
}

function contract_store(PDO $db, array $contract): void
{
    $db->prepare(
        'INSERT INTO contracts (address, chain_id, name, compiler, language, verified_at, match_type,'
        . ' source_count, sources, abi, runtime_bytecode, fetched_at, origin)'
        . ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        . ' ON DUPLICATE KEY UPDATE name = VALUES(name), compiler = VALUES(compiler),'
        . ' language = VALUES(language), verified_at = VALUES(verified_at), match_type = VALUES(match_type),'
        . ' source_count = VALUES(source_count), sources = VALUES(sources), abi = VALUES(abi),'
        . ' runtime_bytecode = VALUES(runtime_bytecode), fetched_at = VALUES(fetched_at), origin = VALUES(origin)'
    )->execute([
        $contract['address'],
        $contract['chain_id'],
        $contract['name'] !== '' ? $contract['name'] : null,
        $contract['compiler'] !== '' ? $contract['compiler'] : null,
        $contract['language'] !== '' ? $contract['language'] : null,
        $contract['verified_at'] !== '' ? $contract['verified_at'] : null,
        $contract['match_type'] !== '' ? $contract['match_type'] : null,
        count($contract['sources']),
        json_encode($contract['sources'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        $contract['abi'],
        $contract['runtime_bytecode'],
        $contract['fetched_at'],
        $contract['origin'],
    ]);
}

function contract_read(PDO $db, string $address): ?array
{
    $statement = $db->prepare('SELECT * FROM contracts WHERE address = ?');
    $statement->execute([$address]);
    $row = $statement->fetch();
    if (!$row) {
        return null;
    }
    $sources = json_decode((string) $row['sources'], true);
    return [
        'address' => (string) $row['address'],
        'name' => (string) ($row['name'] ?? ''),
        'compiler' => (string) ($row['compiler'] ?? ''),
        'language' => (string) ($row['language'] ?? ''),
        'verified_at' => (string) ($row['verified_at'] ?? ''),
        'match_type' => (string) ($row['match_type'] ?? ''),
        'sources' => is_array($sources) ? $sources : [],
        'abi' => $row['abi'] === null ? null : (string) $row['abi'],
        'runtime_bytecode' => $row['runtime_bytecode'] === null ? null : (string) $row['runtime_bytecode'],
        'fetched_at' => (int) $row['fetched_at'],
        'origin' => (string) $row['origin'],
    ];
}

function database(array $config): PDO
{
    $db = isset($config['db']) && is_array($config['db']) ? $config['db'] : [];
    $name = isset($db['name']) ? (string) $db['name'] : '';
    $user = isset($db['user']) ? (string) $db['user'] : '';
    $password = isset($db['password']) ? (string) $db['password'] : '';
    if ($name === '' || $user === '') {
        throw new RuntimeException('config.php has no db.name / db.user');
    }
    $host = isset($db['host']) && (string) $db['host'] !== '' ? (string) $db['host'] : 'localhost';
    $port = isset($db['port']) ? (int) $db['port'] : 3306;
    $dsn = 'mysql:host=' . $host . ';port=' . $port . ';dbname=' . $name . ';charset=utf8mb4';

    $pdo = new PDO($dsn, $user, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    schema($pdo);

    return $pdo;
}

/* ------------------------------------------------------------------ ingest */

/** A 32-byte topic whose last 20 bytes are an address. */
function topic_address(string $topic): string
{
    $bare = strtolower(substr($topic, 2));

    return '0x' . substr($bare, 24);
}

function store_block(PDO $db, array $block, string $rpc): void
{
    $number = (int) hexdec((string) $block['number']);
    $transactions = isset($block['transactions']) && is_array($block['transactions']) ? $block['transactions'] : [];

    // Receipts are read before the transaction opens: holding one open across a
    // hundred network calls is how a shared host ends up with a locked table.
    //
    // One call for the whole block where the node supports `eth_getBlockReceipts`,
    // and that is the difference between keeping up and not. A Polygon block
    // carries ~50 transactions, so the per-transaction path cost 51 round trips per
    // block: the batch had to be 5, and 5 blocks every five minutes against the ~150
    // the chain produces is a gap that can only widen. Batched, the same block is
    // two calls, and the run is limited by the clock instead of by arithmetic.
    $receipts = [];
    $batched = rpc_call($rpc, 'eth_getBlockReceipts', ['0x' . dechex($number)], 25);
    if (is_array($batched)) {
        foreach ($batched as $receipt) {
            if (is_array($receipt) && isset($receipt['transactionHash'])) {
                $receipts[strtolower((string) $receipt['transactionHash'])] = $receipt;
            }
        }
    }
    if ($receipts === []) {
        foreach ($transactions as $tx) {
            if (!is_array($tx) || !isset($tx['hash'])) {
                continue;
            }
            $receipt = rpc_call($rpc, 'eth_getTransactionReceipt', [(string) $tx['hash']]);
            if ($receipt !== null) {
                $receipts[strtolower((string) $tx['hash'])] = $receipt;
            }
        }
    }

    $db->beginTransaction();
    try {
        $db->prepare(
            'INSERT INTO blocks (number, hash, parent, time, gas_used, gas_limit, base_fee, miner, tx_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE hash = VALUES(hash), parent = VALUES(parent), time = VALUES(time),
                 gas_used = VALUES(gas_used), gas_limit = VALUES(gas_limit), base_fee = VALUES(base_fee),
                 miner = VALUES(miner), tx_count = VALUES(tx_count)'
        )->execute([
            $number,
            (string) ($block['hash'] ?? ''),
            (string) ($block['parentHash'] ?? ''),
            (int) hexdec((string) ($block['timestamp'] ?? '0x0')),
            (int) hexdec((string) ($block['gasUsed'] ?? '0x0')),
            (int) hexdec((string) ($block['gasLimit'] ?? '0x0')),
            isset($block['baseFeePerGas']) ? (string) $block['baseFeePerGas'] : null,
            (string) ($block['miner'] ?? ''),
            count($transactions),
        ]);

        $insertTx = $db->prepare(
            'INSERT INTO txs (hash, block_number, tx_index, from_addr, to_addr, value, status, gas_used)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), gas_used = VALUES(gas_used)'
        );
        $insertTransfer = $db->prepare(
            'INSERT IGNORE INTO transfers (tx_hash, block_number, log_index, token, from_addr, to_addr, amount)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $insertToken = $db->prepare(
            'INSERT IGNORE INTO tokens (token, creator, tx_hash, block_number) VALUES (?, ?, ?, ?)'
        );

        foreach ($transactions as $index => $tx) {
            if (!is_array($tx) || !isset($tx['hash'])) {
                continue;
            }
            $hash = (string) $tx['hash'];
            // Keyed lower-case above, because a node may return the hash in either
            // case and a receipt that is present but unfound would store every
            // transaction with a null status.
            $receipt = $receipts[strtolower($hash)] ?? null;
            $status = null;
            if ($receipt !== null && isset($receipt['status'])) {
                $status = (int) hexdec((string) $receipt['status']) === 1 ? 1 : 0;
            }
            $insertTx->execute([
                $hash,
                $number,
                (int) $index,
                strtolower((string) ($tx['from'] ?? '')),
                isset($tx['to']) ? strtolower((string) $tx['to']) : null,
                (string) ($tx['value'] ?? '0x0'),
                $status,
                $receipt !== null && isset($receipt['gasUsed']) ? (int) hexdec((string) $receipt['gasUsed']) : null,
            ]);

            if ($receipt === null || !isset($receipt['logs']) || !is_array($receipt['logs'])) {
                continue;
            }
            foreach ($receipt['logs'] as $logIndex => $log) {
                if (!is_array($log) || !isset($log['topics']) || !is_array($log['topics'])) {
                    continue;
                }
                $topics = $log['topics'];
                // A currency minted through TokenFactory announces itself with two
                // indexed addresses and leaves the identity on the new contract.
                if (count($topics) === 3 && strcasecmp((string) $topics[0], TOKEN_CREATED_TOPIC) === 0) {
                    $insertToken->execute([
                        topic_address((string) $topics[1]),
                        topic_address((string) $topics[2]),
                        $hash,
                        $number,
                    ]);
                    continue;
                }
                // Three topics and a 32-byte payload is the ERC-20 shape. A fourth
                // topic would be an ERC-721 id, whose "amount" is a token id, not a
                // quantity — recording it as an amount would be a wrong number.
                if (count($topics) !== 3 || strcasecmp((string) $topics[0], TRANSFER_TOPIC) !== 0) {
                    continue;
                }
                // The payload is kept as hex. `hexdec` returns a float above PHP's
                // integer range, and a uint256 is always above it, so converting here
                // would store "1.0E+25" as an amount. The page formats it with BigInt.
                $amount = isset($log['data']) ? (string) $log['data'] : '0x0';
                if ($amount === '' || $amount === '0x') {
                    $amount = '0x0';
                }
                $insertTransfer->execute([
                    $hash,
                    $number,
                    (int) $logIndex,
                    strtolower((string) ($log['address'] ?? '')),
                    topic_address((string) $topics[1]),
                    topic_address((string) $topics[2]),
                    $amount,
                ]);
            }
        }

        $db->prepare('UPDATE progress SET last_block = ? WHERE id = 1')->execute([$number]);
        $db->commit();
    } catch (Throwable $error) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $error;
    }
}

/**
 * One cron-sized bite: at most `$batch` blocks, and at most `$seconds` spent.
 *
 * Both limits matter on shared hosting. A cron job that runs longer than its
 * interval piles up behind itself, and one that dies mid-block leaves the
 * progress row behind the data — which is why the block, its transactions, its
 * transfers and the progress update land in one transaction.
 */
function ingest(PDO $db, string $rpc, int $batch, int $seconds): array
{
    $started = time();
    $head = head_number($rpc);
    if ($head <= 0) {
        return ['ok' => false, 'error' => 'the RPC did not report a block height'];
    }

    $row = $db->query('SELECT last_block FROM progress WHERE id = 1')->fetch();
    if ($row === false || !isset($row['last_block'])) {
        // First run starts at the head. This chain is ~97 million blocks old and a
        // shared host is not going to walk it; claiming otherwise would be a lie
        // repeated on every address page.
        $last = max(0, $head - 1);
        $db->prepare('INSERT INTO progress (id, last_block) VALUES (1, ?)')->execute([$last]);
    } else {
        $last = (int) $row['last_block'];
    }

    // A reorg rewrites the newest blocks. Serving a block the chain no longer has
    // is worse than a gap, so the last few are dropped when the hash disagrees.
    if ($last > 0) {
        $stored = $db->prepare('SELECT hash FROM blocks WHERE number = ?');
        $stored->execute([$last]);
        $hash = $stored->fetchColumn();
        if (is_string($hash) && $hash !== '') {
            $chain = rpc_call($rpc, 'eth_getBlockByNumber', ['0x' . dechex($last), false]);
            if (is_array($chain) && isset($chain['hash']) && strcasecmp((string) $chain['hash'], $hash) !== 0) {
                $rewind = max(0, $last - 5);
                $db->prepare('DELETE FROM transfers WHERE block_number > ?')->execute([$rewind]);
                $db->prepare('DELETE FROM tokens WHERE block_number > ?')->execute([$rewind]);
                $db->prepare('DELETE FROM txs WHERE block_number > ?')->execute([$rewind]);
                $db->prepare('DELETE FROM blocks WHERE number > ?')->execute([$rewind]);
                $db->prepare('UPDATE progress SET last_block = ? WHERE id = 1')->execute([$rewind]);
                $last = $rewind;
            }
        }
    }

    $target = min($head, $last + max(1, $batch));
    $done = 0;
    for ($number = $last + 1; $number <= $target; $number += 1) {
        if (time() - $started >= $seconds) {
            break;
        }
        $block = rpc_call($rpc, 'eth_getBlockByNumber', ['0x' . dechex($number), true], 25);
        if ($block === null || !isset($block['hash'])) {
            break;
        }
        store_block($db, $block, $rpc);
        $last = $number;
        $done += 1;
    }

    return ['ok' => true, 'ingested' => $done, 'lastBlock' => $last, 'head' => $head, 'seconds' => time() - $started];
}

/**
 * Count the index once per ingest run and keep the numbers.
 *
 * This is the query set that made `/api/web9999/status` take fourteen seconds:
 * `transfers` holds tens of millions of rows and COUNT(*) over it is a full index
 * scan. Once every five minutes is affordable; once per request is not.
 *
 * @return array{blocks: int, txs: int, transfers: int, tokens: int, counted_at: int}
 */
function store_counts(PDO $db): array
{
    $counts = [
        'blocks' => (int) $db->query('SELECT COUNT(*) FROM blocks')->fetchColumn(),
        'txs' => (int) $db->query('SELECT COUNT(*) FROM txs')->fetchColumn(),
        'transfers' => (int) $db->query('SELECT COUNT(*) FROM transfers')->fetchColumn(),
        'tokens' => (int) $db->query('SELECT COUNT(*) FROM tokens')->fetchColumn(),
        'counted_at' => time(),
    ];
    $db->prepare(
        'INSERT INTO counts (id, blocks, txs, transfers, tokens, counted_at) VALUES (1, ?, ?, ?, ?, ?)'
        . ' ON DUPLICATE KEY UPDATE blocks = VALUES(blocks), txs = VALUES(txs),'
        . ' transfers = VALUES(transfers), tokens = VALUES(tokens), counted_at = VALUES(counted_at)',
    )->execute([$counts['blocks'], $counts['txs'], $counts['transfers'], $counts['tokens'], $counts['counted_at']]);
    return $counts;
}

/**
 * The counts the last ingest run stored, or null when none has run yet.
 *
 * @return array{blocks: int, txs: int, transfers: int, tokens: int, counted_at: int}|null
 */
function stored_counts(PDO $db): ?array
{
    try {
        $row = $db->query('SELECT blocks, txs, transfers, tokens, counted_at FROM counts WHERE id = 1')->fetch();
    } catch (Throwable) {
        return null;
    }
    if (!is_array($row)) {
        return null;
    }
    return [
        'blocks' => (int) $row['blocks'],
        'txs' => (int) $row['txs'],
        'transfers' => (int) $row['transfers'],
        'tokens' => (int) $row['tokens'],
        'counted_at' => (int) $row['counted_at'],
    ];
}

/* ------------------------------------------------------------------ routes */

$config = scan_config();

// Run limits that ship with the package, as floors rather than overrides: the
// larger of this file and the host's config wins, so a value written by hand
// years ago cannot throttle the crawler and an operator can still raise it.
// Shipping the numbers beats editing the host's config.php, which holds the
// database password and should not have to be opened to change a batch size.
$tuningPath = __DIR__ . '/tuning.php';
if (is_file($tuningPath)) {
    $tuning = require $tuningPath;
    if (is_array($tuning)) {
        foreach (['batch', 'seconds'] as $limit) {
            if (isset($tuning[$limit])) {
                $config[$limit] = max((int) ($config[$limit] ?? 0), (int) $tuning[$limit]);
            }
        }
    }
}

$configured = isset($config['db']) && is_array($config['db']);
$rpc = isset($config['rpc']) && (string) $config['rpc'] !== ''
    ? (string) $config['rpc']
    : 'https://polygon-bor-rpc.publicnode.com';
$which = route();

if ($which === '') {
    answer(200, [
        'ok' => true,
        'configured' => $configured,
        'routes' => ['status', 'stream', 'address?address=0x…&limit=25', 'tokens?creator=0x…&limit=25', 'ingest?key=…'],
    ]);
}

if (!$configured) {
    // Not an error: the page is designed to run without an index.
    answer(200, [
        'ok' => true,
        'configured' => false,
        'reason' => 'no config.php beside api.php — copy config.sample.php and fill in the database',
    ]);
}

try {
    $db = database($config);
} catch (Throwable $error) {
    answer(503, ['ok' => false, 'configured' => true, 'error' => $error->getMessage()]);
}

if ($which === 'status') {
    $last = (int) $db->query('SELECT last_block FROM progress WHERE id = 1')->fetchColumn();
    $first = (int) $db->query('SELECT MIN(number) FROM blocks')->fetchColumn();
    $head = head_number($rpc);
    // The stored numbers when an ingest run has written them; a live count only
    // until then, so a fresh install answers with real figures rather than null.
    $counts = stored_counts($db);
    if ($counts === null) {
        $counts = [
            'blocks' => (int) $db->query('SELECT COUNT(*) FROM blocks')->fetchColumn(),
            'txs' => (int) $db->query('SELECT COUNT(*) FROM txs')->fetchColumn(),
            'transfers' => (int) $db->query('SELECT COUNT(*) FROM transfers')->fetchColumn(),
            'tokens' => (int) $db->query('SELECT COUNT(*) FROM tokens')->fetchColumn(),
            'counted_at' => time(),
        ];
    }
    answer(200, [
        'ok' => true,
        'configured' => true,
        'chainId' => 137,
        'rpc' => $rpc,
        'head' => $head,
        'lastBlock' => $last,
        // How far behind the head the index is. One number, because "is this index
        // current?" is one question, and it used to be answerable only by
        // subtracting two other fields.
        'lag' => $head > 0 ? max(0, $head - $last) : null,
        'firstBlock' => $first,
        'blocks' => $counts['blocks'],
        'txs' => $counts['txs'],
        'transfers' => $counts['transfers'],
        'tokens' => $counts['tokens'],
        'countedAt' => $counts['counted_at'],
    ]);
}

if ($which === 'address') {
    $address = isset($_GET['address']) ? strtolower(trim((string) $_GET['address'])) : '';
    if (preg_match('/^0x[0-9a-f]{40}$/', $address) !== 1) {
        answer(400, ['ok' => false, 'error' => 'address must be 0x followed by 40 hex characters']);
    }
    $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 25;
    $limit = max(1, min(200, $limit));

    $sent = $db->prepare(
        'SELECT block_number, hash, value, to_addr FROM txs WHERE from_addr = ? ORDER BY block_number DESC LIMIT ' . $limit
    );
    $sent->execute([$address]);
    $received = $db->prepare(
        'SELECT block_number, hash, value, from_addr FROM txs WHERE to_addr = ? ORDER BY block_number DESC LIMIT ' . $limit
    );
    $received->execute([$address]);
    $transfers = $db->prepare(
        'SELECT block_number, tx_hash, token, from_addr, to_addr, amount FROM transfers
         WHERE from_addr = ? OR to_addr = ? ORDER BY block_number DESC LIMIT ' . $limit
    );
    $transfers->execute([$address, $address]);

    $shape = static function (array $row, bool $outgoing): array {
        return [
            'block' => (int) $row['block_number'],
            'hash' => (string) $row['hash'],
            'value' => (string) $row['value'],
            'direction' => $outgoing ? 'out' : 'in',
            'counterparty' => (string) ($outgoing ? $row['to_addr'] : $row['from_addr']),
        ];
    };

    answer(200, [
        'ok' => true,
        'address' => $address,
        'firstBlock' => (int) $db->query('SELECT MIN(number) FROM blocks')->fetchColumn(),
        'sent' => array_map(static fn (array $row): array => $shape($row, true), $sent->fetchAll()),
        'received' => array_map(static fn (array $row): array => $shape($row, false), $received->fetchAll()),
        'transfers' => array_map(static function (array $row) use ($address): array {
            return [
                'block' => (int) $row['block_number'],
                'hash' => (string) $row['tx_hash'],
                'token' => (string) $row['token'],
                'direction' => strcasecmp((string) $row['from_addr'], $address) === 0 ? 'out' : 'in',
                'counterpart' => strcasecmp((string) $row['from_addr'], $address) === 0
                    ? (string) $row['to_addr']
                    : (string) $row['from_addr'],
                'amount' => (string) $row['amount'],
            ];
        }, $transfers->fetchAll()),
    ]);
}

if ($which === 'contract') {
    // Source for one contract, copied from Sourcify and cached here. Cached, because a
    // contract page should not wait on a third party every time it is opened; fetched
    // again after a week, or on ?refresh=1, because a cached copy can go stale.
    $address = isset($_GET['address']) ? strtolower(trim((string) $_GET['address'])) : '';
    if (preg_match('/^0x[0-9a-f]{40}$/', $address) !== 1) {
        answer(400, ['ok' => false, 'error' => 'address must be 0x followed by 40 hex characters']);
    }
    $refresh = isset($_GET['refresh']) && (string) $_GET['refresh'] === '1';
    $contract = contract_read($db, $address);
    $stale = $contract === null || time() - (int) $contract['fetched_at'] > 604800;
    if ($refresh || $stale) {
        $fresh = contract_fetch($address);
        if ($fresh !== null) {
            contract_store($db, $fresh);
            $contract = contract_read($db, $address);
        }
    }
    if ($contract === null) {
        answer(200, [
            'ok' => true,
            'address' => $address,
            'verified' => false,
            'reason' => 'no verified source for this address on Sourcify, and none cached here',
        ]);
    }
    $sources = [];
    foreach ($contract['sources'] as $path => $content) {
        $sources[] = ['path' => (string) $path, 'content' => (string) $content];
    }
    answer(200, [
        'ok' => true,
        'address' => $address,
        'verified' => true,
        'name' => $contract['name'],
        'compiler' => $contract['compiler'],
        'language' => $contract['language'],
        'match' => $contract['match_type'],
        'verifiedAt' => $contract['verified_at'],
        'fetchedAt' => $contract['fetched_at'],
        'origin' => $contract['origin'],
        'sources' => $sources,
        'abi' => $contract['abi'] === null ? null : json_decode($contract['abi'], true),
        'bytecode' => $contract['runtime_bytecode'],
    ]);
}

if ($which === 'tokens') {
    // The currencies the factory has made, newest first. The identity is not
    // copied here on purpose: `name()` and `symbol()` are one RPC call away and
    // cannot go stale, while a copied string is a second truth.
    $creator = isset($_GET['creator']) ? strtolower(trim((string) $_GET['creator'])) : '';
    if ($creator !== '' && preg_match('/^0x[0-9a-f]{40}$/', $creator) !== 1) {
        answer(400, ['ok' => false, 'error' => 'creator must be 0x followed by 40 hex characters']);
    }
    $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
    $limit = max(1, min(200, $limit));

    $statement = $db->prepare(
        'SELECT token, creator, tx_hash, block_number FROM tokens'
        . ($creator !== '' ? ' WHERE creator = ?' : '')
        . ' ORDER BY block_number DESC, token DESC LIMIT ' . $limit
    );
    $statement->execute($creator !== '' ? [$creator] : []);

    answer(200, [
        'ok' => true,
        'factory' => '0x7885A9A6fB23B3B8802A3420cF6C97Fb51720BA8',
        'count' => (int) $db->query('SELECT COUNT(*) FROM tokens')->fetchColumn(),
        'tokens' => array_map(static fn (array $row): array => [
            'token' => (string) $row['token'],
            'creator' => (string) $row['creator'],
            'tx' => (string) $row['tx_hash'],
            'block' => (int) $row['block_number'],
        ], $statement->fetchAll()),
    ]);
}

if ($which === 'stream') {
    // A continuous link from an open page to this database, so a cron run shows up
    // in the browser instead of waiting for a reload. Server-sent events, because
    // the direction is one way and a WebSocket would need a second port.
    //
    // It closes itself after ~25s on purpose: this host counts a PHP process that
    // runs for minutes against its entry-process limit, and a page can open a new
    // stream when this one ends. The page also only holds one while it is visible.
    $window = isset($config['stream_seconds']) ? (int) $config['stream_seconds'] : 25;
    $window = max(5, min(50, $window));

    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-store');
    // Apache buffers a response until it is large enough to be worth sending,
    // which would turn a live stream into one delivery at the end.
    header('X-Accel-Buffering: no');
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', '1');
    }
    @ini_set('zlib.output_compression', '0');
    @set_time_limit($window + 10);

    $state = static function (PDO $db): array {
        // The stored counts, not a recount. This closure runs every two seconds for
        // as long as a page is open, and COUNT(*) over transfers — 83 million rows
        // at the time of writing — is a full index scan; four of them per tick is
        // the single most expensive thing this host was asked to do. A host with no
        // ingest run since the table existed reports nulls here rather than stalling
        // the stream for fourteen seconds, and the page already ignores a tick whose
        // counts are not numbers.
        $counts = stored_counts($db);
        return [
            'chainId' => 137,
            'lastBlock' => (int) $db->query('SELECT last_block FROM progress WHERE id = 1')->fetchColumn(),
            'firstBlock' => (int) $db->query('SELECT MIN(number) FROM blocks')->fetchColumn(),
            'blocks' => $counts['blocks'] ?? null,
            'txs' => $counts['txs'] ?? null,
            'transfers' => $counts['transfers'] ?? null,
            'tokens' => $counts['tokens'] ?? null,
            'countedAt' => $counts['counted_at'] ?? null,
            'newestToken' => (string) $db->query('SELECT token FROM tokens ORDER BY block_number DESC, token DESC LIMIT 1')->fetchColumn(),
        ];
    };

    $started = time();
    $previous = null;
    $ticks = 0;
    while (time() - $started < $window) {
        // A closed tab must not keep a process alive for the rest of the window.
        if (connection_aborted()) {
            break;
        }
        try {
            $now = $state($db);
        } catch (Throwable $error) {
            echo 'event: trouble\ndata: ' . json_encode(['error' => $error->getMessage()], JSON_UNESCAPED_SLASHES) . "\n\n";
            @ob_flush();
            @flush();
            break;
        }
        if ($now !== $previous) {
            // Only send when something actually moved: a stream that repeats the
            // same row every two seconds is a busy loop with a pretty coat on.
            // The timestamp is added on the way out and deliberately left out of
            // the comparison, because "the clock ticked" is not a change.
            $payload = $now;
            $payload['at'] = time();
            echo 'data: ' . json_encode($payload, JSON_UNESCAPED_SLASHES) . "\n\n";
            $previous = $now;
            $ticks = 0;
        } else {
            $ticks += 1;
            if ($ticks % 5 === 0) {
                echo ": still here\n\n";
            }
        }
        @ob_flush();
        @flush();
        sleep(2);
    }

    echo "event: end\ndata: {}\n\n";
    @ob_flush();
    @flush();
    exit;
}

if ($which === 'ingest') {
    $secret = isset($config['cron_key']) ? (string) $config['cron_key'] : '';
    if (PHP_SAPI !== 'cli') {
        $given = isset($_GET['key']) ? (string) $_GET['key'] : '';
        // A write route reachable by anyone is a way to make the host burn its RPC
        // quota on demand. Refused, rather than run slowly.
        if ($secret === '' || !hash_equals($secret, $given)) {
            answer(403, ['ok' => false, 'error' => 'ingest needs the cron key']);
        }
    }
    $batch = isset($config['batch']) ? (int) $config['batch'] : 5;
    $seconds = isset($config['seconds']) ? (int) $config['seconds'] : 20;
    $result = ingest($db, $rpc, $batch, $seconds);
    // After the run, not during it: a failed ingest must not move the numbers
    // readers see, and the counts describe the data the run just committed.
    if (($result['ok'] ?? false) === true) {
        try {
            $result['counts'] = store_counts($db);
        } catch (Throwable $error) {
            $result['counts_error'] = $error->getMessage();
        }
    }
    answer($result['ok'] ? 200 : 503, $result);
}

answer(404, ['ok' => false, 'error' => 'no such route: ' . $which]);
