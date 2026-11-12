<?php
declare(strict_types=1);

/**
 * Shared plumbing for the coin tables behind `/api/web9999/coins`.
 *
 * Three jobs, kept here so the endpoint and the importer cannot disagree about
 * any of them:
 *
 *   - find a MySQL connection. The account's explorer credentials already exist
 *     in `scan/config.php`, one level above this directory's parent, and the
 *     cPanel user owns every database it created — so the same user and password
 *     reach `fiatgodx_web9999` by swapping only the database name. Nothing here
 *     echoes a password or a DSN: this file is served from the web root, and a
 *     DSN can carry one.
 *   - know which chains Blockchair publishes. A slug is not guessable from a
 *     symbol (`bitcoin-cash` is not `bch`), so the list is written out.
 *   - apply the schema and write a reading. The DDL is here as well as in
 *     `db/web9999-coins.sql` so the importer can create its own tables on a fresh
 *     database; both copies are `IF NOT EXISTS` and identical in shape.
 */

/** The database these tables live in. One of the account's existing five. */
const WEB9999_COIN_DB = 'fiatgodx_web9999';

/** Blockchair's stats route. `%s` is the chain slug. */
const WEB9999_BLOCKCHAIR = 'https://api.blockchair.com/%s/stats';

/** Upstream timeout, in seconds: the free plan is not fast and not slow. */
const WEB9999_FETCH_TIMEOUT = 12;

/**
 * Chains Blockchair no longer publishes, with the CoinGecko id for each.
 *
 * `bitcoin-sv` is not `bitcoin-cash`: the market id carries the distinction.
 *
 * @var array<string, string>
 */
const WEB9999_MARKET_IDS = [
    'bitcoin-sv' => 'bitcoin-cash-sv',
    'tezos' => 'tezos',
    'tron' => 'tron',
    'eos' => 'eos',
];

/**
 * The chains this page keeps, by Blockchair slug.
 *
 * Deliberately a fixed list rather than "everything Blockchair has": each entry
 * costs one metered call per refresh, and a chain added upstream should be a
 * decision here, not a surprise in a cron job's request count.
 *
 * @return array<string, array{0: string, 1: string}>
 */
function web9999_chains(): array
{
    return [
        'bitcoin' => ['Bitcoin', 'BTC'],
        'ethereum' => ['Ethereum', 'ETH'],
        'bitcoin-cash' => ['Bitcoin Cash', 'BCH'],
        'bitcoin-sv' => ['Bitcoin SV', 'BSV'],
        'litecoin' => ['Litecoin', 'LTC'],
        'dogecoin' => ['Dogecoin', 'DOGE'],
        'dash' => ['Dash', 'DASH'],
        'monero' => ['Monero', 'XMR'],
        'zcash' => ['Zcash', 'ZEC'],
        'ecash' => ['eCash', 'XEC'],
        'groestlcoin' => ['Groestlcoin', 'GRS'],
        'ripple' => ['XRP', 'XRP'],
        'stellar' => ['Stellar', 'XLM'],
        'cardano' => ['Cardano', 'ADA'],
        'tezos' => ['Tezos', 'XTZ'],
        'tron' => ['TRON', 'TRX'],
        'eos' => ['EOS', 'EOS'],
    ];
}

/**
 * The two tables, exactly as `db/web9999-coins.sql` declares them.
 *
 * @return list<string>
 */
function web9999_schema(): array
{
    return [
        'CREATE TABLE IF NOT EXISTS web9999_coins ('
        . ' chain VARCHAR(32) NOT NULL,'
        . ' name VARCHAR(64) NOT NULL,'
        . ' symbol VARCHAR(16) NOT NULL,'
        . ' created_at BIGINT UNSIGNED NOT NULL,'
        . ' PRIMARY KEY (chain),'
        . ' UNIQUE KEY symbol_idx (symbol)'
        . ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci',
        'CREATE TABLE IF NOT EXISTS web9999_coin_readings ('
        . ' chain VARCHAR(32) NOT NULL,'
        . ' read_at BIGINT UNSIGNED NOT NULL,'
        . ' price_usd DECIMAL(24,8) DEFAULT NULL,'
        . ' market_cap_usd DECIMAL(30,8) DEFAULT NULL,'
        . ' blocks BIGINT UNSIGNED DEFAULT NULL,'
        . ' transactions BIGINT UNSIGNED DEFAULT NULL,'
        . ' mempool BIGINT UNSIGNED DEFAULT NULL,'
        . ' difficulty DECIMAL(30,8) DEFAULT NULL,'
        . ' hashrate DECIMAL(30,8) DEFAULT NULL,'
        . ' error VARCHAR(255) DEFAULT NULL,'
        . ' PRIMARY KEY (chain),'
        . ' CONSTRAINT web9999_coin_readings_chain'
        . '   FOREIGN KEY (chain) REFERENCES web9999_coins (chain) ON DELETE CASCADE'
        . ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci',
    ];
}

/**
 * The explorer's credentials, with this module's database name swapped in.
 *
 * @return array{dsn: string, user: string, password: string}|array{}
 */
function web9999_connection_details(): array
{
    $path = getenv('WEB9999_DB_CONFIG');
    if (!is_string($path) || trim($path) === '') {
        // public_html/api/web9999/lib -> public_html -> account directory.
        $path = dirname(__DIR__, 3) . '/scan/config.php';
    }

    if (is_file($path)) {
        $config = require $path;
        $db = is_array($config) && is_array($config['db'] ?? null) ? $config['db'] : [];
        if ($db !== []) {
            return [
                'dsn' => sprintf(
                    'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                    (string) ($db['host'] ?? 'localhost'),
                    (string) ($db['port'] ?? '3306'),
                    WEB9999_COIN_DB,
                ),
                'user' => (string) ($db['user'] ?? ''),
                'password' => (string) ($db['password'] ?? ''),
            ];
        }
    }

    // A host without the explorer's config can still point this module at a
    // database explicitly. Same variable names cPanel would ask for.
    $dsn = getenv('WEB9999_DB_DSN');
    $user = getenv('WEB9999_DB_USER');
    $password = getenv('WEB9999_DB_PASSWORD');
    if (is_string($dsn) && $dsn !== '' && is_string($user) && $user !== '') {
        return ['dsn' => $dsn, 'user' => $user, 'password' => is_string($password) ? $password : ''];
    }

    return [];
}

/**
 * Connect, or say why not. One shape in both branches.
 *
 * @return array{0: ?PDO, 1: ?string, 2: ?string}
 */
function web9999_connect(): array
{
    $details = web9999_connection_details();
    if ($details === []) {
        return [null, 'no database credentials: neither scan/config.php nor WEB9999_DB_DSN is present', null];
    }
    if (!str_starts_with($details['dsn'], 'mysql:')) {
        return [null, 'the configured DSN is not MySQL', null];
    }
    try {
        $pdo = new PDO($details['dsn'], $details['user'], $details['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $version = $pdo->query('SELECT VERSION()')->fetchColumn();
        return [$pdo, null, is_string($version) ? $version : null];
    } catch (Throwable $error) {
        // The driver's message names host and user, never the password.
        return [null, 'cannot connect: ' . substr($error->getMessage(), 0, 160), null];
    }
}

/** Create the tables if they are not there. Idempotent, by design. */
function web9999_ensure_schema(PDO $pdo): void
{
    foreach (web9999_schema() as $statement) {
        $pdo->exec($statement);
    }
}

/** True when both tables exist, without creating them. */
function web9999_has_schema(PDO $pdo): bool
{
    try {
        $count = (int) $pdo->query(
            "SELECT COUNT(*) FROM information_schema.tables"
            . " WHERE table_schema = DATABASE()"
            . " AND table_name IN ('web9999_coins', 'web9999_coin_readings')",
        )->fetchColumn();
        return $count === 2;
    } catch (Throwable) {
        return false;
    }
}

/** Register the chains this module knows, leaving readings alone. */
function web9999_seed(PDO $pdo): void
{
    $statement = $pdo->prepare(
        'INSERT INTO web9999_coins (chain, name, symbol, created_at) VALUES (:chain, :name, :symbol, :created_at)'
        . ' ON DUPLICATE KEY UPDATE name = VALUES(name), symbol = VALUES(symbol)',
    );
    $now = time();
    foreach (web9999_chains() as $chain => [$name, $symbol]) {
        $statement->execute([':chain' => $chain, ':name' => $name, ':symbol' => $symbol, ':created_at' => $now]);
    }
}

/**
 * One chain's stats from Blockchair, reduced to the fields this page promises.
 *
 * `ok` is false with a reason rather than an exception: a refresh loops over
 * seventeen chains, and one upstream refusal must not abandon the other sixteen.
 *
 * @return array{ok: bool, reading: array<string, float|int|null>, error: ?string, api_version: ?string}
 */
function web9999_blockchair(string $chain): array
{
    $url = sprintf(WEB9999_BLOCKCHAIR, rawurlencode($chain));
    $key = getenv('BLOCKCHAIR_KEY');
    if (is_string($key) && $key !== '') {
        $url .= '?key=' . rawurlencode($key);
    }

    $raw = null;
    if (function_exists('curl_init')) {
        $handle = curl_init($url);
        if ($handle !== false) {
            curl_setopt_array($handle, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_CONNECTTIMEOUT => WEB9999_FETCH_TIMEOUT,
                CURLOPT_TIMEOUT => WEB9999_FETCH_TIMEOUT,
                CURLOPT_USERAGENT => 'lovewebconnection/1.0 (+php web9999 coins)',
                CURLOPT_HTTPHEADER => ['Accept: application/json'],
            ]);
            $body = curl_exec($handle);
            if (is_string($body) && $body !== '') {
                $raw = $body;
            }
            curl_close($handle);
        }
    }
    if ($raw === null) {
        $context = stream_context_create([
            'http' => [
                'timeout' => WEB9999_FETCH_TIMEOUT,
                'header' => "Accept: application/json\r\nUser-Agent: lovewebconnection/1.0\r\n",
            ],
        ]);
        $body = @file_get_contents($url, false, $context);
        if (is_string($body) && $body !== '') {
            $raw = $body;
        }
    }

    if ($raw === null) {
        return ['ok' => false, 'reading' => [], 'error' => 'Blockchair did not answer', 'api_version' => null];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'reading' => [], 'error' => 'Blockchair sent something that is not JSON', 'api_version' => null];
    }

    $data = $decoded['data'] ?? null;
    if (!is_array($data)) {
        $detail = $decoded['context']['error'] ?? null;
        $reason = is_string($detail) && $detail !== '' ? $detail : 'no data in the response';
        return ['ok' => false, 'reading' => [], 'error' => substr($reason, 0, 200), 'api_version' => null];
    }

    $decimal = static function (mixed $value): ?float {
        return is_numeric($value) ? (float) $value : null;
    };
    $integer = static function (mixed $value): ?int {
        return is_numeric($value) ? (int) $value : null;
    };

    return [
        'ok' => true,
        'reading' => [
            'price_usd' => $decimal($data['market_price_usd'] ?? null),
            'market_cap_usd' => $decimal($data['market_cap_usd'] ?? null),
            'blocks' => $integer($data['blocks'] ?? null),
            'transactions' => $integer($data['transactions'] ?? null),
            'mempool' => $integer($data['mempool_transactions'] ?? null),
            'difficulty' => $decimal($data['difficulty'] ?? null),
            'hashrate' => $decimal($data['hashrate_24h'] ?? null),
        ],
        'error' => null,
        'api_version' => is_string($decoded['context']['api_version'] ?? null)
            ? (string) $decoded['context']['api_version']
            : null,
    ];
}

/**
 * Write one reading, replacing whatever was there.
 *
 * A refusal is stored as a row with `error` set and no numbers, so the next page
 * load shows "refused at 12:04" instead of an empty cell that looks like zero.
 *
 * @param array<string, float|int|null> $reading
 */
function web9999_save(PDO $pdo, string $chain, array $reading, ?string $error): void
{
    $statement = $pdo->prepare(
        'INSERT INTO web9999_coin_readings'
        . ' (chain, read_at, price_usd, market_cap_usd, blocks, transactions, mempool, difficulty, hashrate, error)'
        . ' VALUES (:chain, :read_at, :price_usd, :market_cap_usd, :blocks, :transactions, :mempool, :difficulty, :hashrate, :error)'
        . ' ON DUPLICATE KEY UPDATE'
        . ' read_at = VALUES(read_at), price_usd = VALUES(price_usd), market_cap_usd = VALUES(market_cap_usd),'
        . ' blocks = VALUES(blocks), transactions = VALUES(transactions), mempool = VALUES(mempool),'
        . ' difficulty = VALUES(difficulty), hashrate = VALUES(hashrate), error = VALUES(error)',
    );
    $statement->execute([
        ':chain' => $chain,
        ':read_at' => time(),
        ':price_usd' => $reading['price_usd'] ?? null,
        ':market_cap_usd' => $reading['market_cap_usd'] ?? null,
        ':blocks' => $reading['blocks'] ?? null,
        ':transactions' => $reading['transactions'] ?? null,
        ':mempool' => $reading['mempool'] ?? null,
        ':difficulty' => $reading['difficulty'] ?? null,
        ':hashrate' => $reading['hashrate'] ?? null,
        ':error' => $error === null ? null : substr($error, 0, 255),
    ]);
}

/**
 * Every registered chain with its latest reading, highest price first.
 *
 * Nulls stay null: PDO hands DECIMAL and BIGINT back as strings, and casting a
 * null to (float) would turn "not reported by this chain" into 0.0 — which on a
 * page that prints prices reads as a coin worth nothing.
 *
 * @return list<array<string, mixed>>
 */
function web9999_rows(PDO $pdo): array
{
    $rows = $pdo->query(
        'SELECT c.chain, c.name, c.symbol,'
        . ' r.read_at, r.price_usd, r.market_cap_usd, r.blocks, r.transactions, r.mempool,'
        . ' r.difficulty, r.hashrate, r.error'
        . ' FROM web9999_coins c'
        . ' LEFT JOIN web9999_coin_readings r ON r.chain = c.chain'
        . ' ORDER BY (r.price_usd IS NULL), r.price_usd DESC, c.chain',
    )->fetchAll();

    $number = static function (mixed $value): ?float {
        return is_numeric($value) ? (float) $value : null;
    };
    $count = static function (mixed $value): ?int {
        return is_numeric($value) ? (int) $value : null;
    };

    $clean = [];
    foreach ($rows as $row) {
        $readAt = $count($row['read_at'] ?? null);
        $clean[] = [
            'chain' => (string) $row['chain'],
            'name' => (string) $row['name'],
            'symbol' => (string) $row['symbol'],
            'read_at' => $readAt,
            'age_seconds' => $readAt === null ? null : max(0, time() - $readAt),
            'price_usd' => $number($row['price_usd'] ?? null),
            'market_cap_usd' => $number($row['market_cap_usd'] ?? null),
            'blocks' => $count($row['blocks'] ?? null),
            'transactions' => $count($row['transactions'] ?? null),
            'mempool' => $count($row['mempool'] ?? null),
            'difficulty' => $number($row['difficulty'] ?? null),
            'hashrate' => $number($row['hashrate'] ?? null),
            'error' => is_string($row['error'] ?? null) && $row['error'] !== '' ? (string) $row['error'] : null,
        ];
    }
    return $clean;
}

/**
 * Fetch a URL as text, trying cURL before PHP's stream wrapper.
 *
 * Null means "no body", not an exception: one provider refusing must not stop
 * the refresh of the other sixteen chains.
 */
function web9999_http(string $url): ?string
{
    if (function_exists('curl_init')) {
        $handle = curl_init($url);
        if ($handle !== false) {
            curl_setopt_array($handle, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_CONNECTTIMEOUT => WEB9999_FETCH_TIMEOUT,
                CURLOPT_TIMEOUT => WEB9999_FETCH_TIMEOUT,
                CURLOPT_USERAGENT => 'lovewebconnection/1.0 (+php web9999 coins)',
                CURLOPT_HTTPHEADER => ['Accept: application/json'],
                CURLOPT_ENCODING => '',
            ]);
            $body = curl_exec($handle);
            curl_close($handle);
            if (is_string($body) && $body !== '') {
                return $body;
            }
        }
    }

    $context = stream_context_create([
        'http' => [
            'timeout' => WEB9999_FETCH_TIMEOUT,
            'header' => "Accept: application/json\r\nUser-Agent: lovewebconnection/1.0\r\n",
        ],
    ]);
    $body = @file_get_contents($url, false, $context);
    return is_string($body) && $body !== '' ? $body : null;
}

/** Decode a JSON object, or return null when the provider did not answer with one. */
function web9999_json(string $url): ?array
{
    $raw = web9999_http($url);
    if ($raw === null) {
        return null;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

/** A number from a provider field, without turning a missing value into zero. */
function web9999_decimal(mixed $value): ?float
{
    return is_numeric($value) ? (float) $value : null;
}

/** An integer from a provider field, without turning a missing value into zero. */
function web9999_integer(mixed $value): ?int
{
    return is_numeric($value) ? (int) $value : null;
}

/**
 * One CoinGecko call for every fallback chain, reused across the refresh loop.
 *
 * The free endpoint is rate-limited; four separate calls per refresh would spend
 * that budget for no extra data. A failed call returns no quotes and leaves the
 * chain's provider reading intact.
 *
 * @return array<string, array{price_usd: ?float, market_cap_usd: ?float}>
 */
function web9999_market_quotes(): array
{
    static $quotes = null;
    if (is_array($quotes)) {
        return $quotes;
    }

    $ids = array_values(array_unique(array_values(WEB9999_MARKET_IDS)));
    $url = 'https://api.coingecko.com/api/v3/simple/price?ids='
        . rawurlencode(implode(',', $ids))
        . '&vs_currencies=usd&include_market_cap=true';
    $data = web9999_json($url);
    $quotes = [];
    if ($data === null) {
        return $quotes;
    }

    foreach (WEB9999_MARKET_IDS as $chain => $id) {
        $row = $data[$id] ?? null;
        if (!is_array($row)) {
            continue;
        }
        $quotes[$chain] = [
            'price_usd' => web9999_decimal($row['usd'] ?? null),
            'market_cap_usd' => web9999_decimal($row['usd_market_cap'] ?? null),
        ];
    }
    return $quotes;
}

/**
 * The four chains Blockchair dropped, read from their own public providers.
 *
 * Price and market cap come from CoinGecko; height, mempool, and transaction
 * count come from the chain's provider where it publishes them. A provider that
 * refuses leaves its fields null, and the row is still saved if anything else
 * answered, so the page shows a real partial reading instead of "refused".
 *
 * @return array{ok: bool, reading: array<string, float|int|null>, error: ?string, api_version: ?string}
 */
function web9999_fallback(string $chain): array
{
    $reading = [
        'price_usd' => null,
        'market_cap_usd' => null,
        'blocks' => null,
        'transactions' => null,
        'mempool' => null,
        'difficulty' => null,
        'hashrate' => null,
    ];

    $quote = web9999_market_quotes()[$chain] ?? [];
    $reading['price_usd'] = $quote['price_usd'] ?? null;
    $reading['market_cap_usd'] = $quote['market_cap_usd'] ?? null;

    if ($chain === 'bitcoin-sv') {
        $info = web9999_json('https://api.whatsonchain.com/v1/bsv/main/chain/info');
        if ($info !== null) {
            $reading['blocks'] = web9999_integer($info['blocks'] ?? null);
        }
        $mempool = web9999_json('https://api.whatsonchain.com/v1/bsv/main/mempool/info');
        if ($mempool !== null) {
            $reading['mempool'] = web9999_integer($mempool['size'] ?? null);
        }
    } elseif ($chain === 'tezos') {
        $head = web9999_json('https://api.tzkt.io/v1/head');
        if ($head !== null) {
            $reading['blocks'] = web9999_integer($head['level'] ?? null);
        }
        $raw = web9999_http('https://api.tzkt.io/v1/operations/transactions/count');
        if ($raw !== null) {
            $count = trim($raw);
            if (is_numeric($count)) {
                $reading['transactions'] = (int) $count;
            }
        }
    } elseif ($chain === 'tron') {
        $info = web9999_json('https://api.trongrid.io/wallet/getnodeinfo');
        $block = is_array($info) ? ($info['block'] ?? null) : null;
        if (is_string($block) && preg_match('/\bNum:(\d+)/', $block, $match) === 1) {
            $reading['blocks'] = (int) $match[1];
        }
    } elseif ($chain === 'eos') {
        $info = web9999_json('https://eos.greymass.com/v1/chain/get_info');
        if ($info !== null) {
            $reading['blocks'] = web9999_integer($info['head_block_num'] ?? null);
        }
    }

    foreach (['price_usd', 'market_cap_usd', 'blocks', 'transactions', 'mempool'] as $field) {
        if ($reading[$field] !== null) {
            return [
                'ok' => true,
                'reading' => $reading,
                'error' => null,
                'api_version' => 'fallback',
            ];
        }
    }

    return [
        'ok' => false,
        'reading' => [],
        'error' => 'fallback providers did not answer',
        'api_version' => 'fallback',
    ];
}

/** Route the four dropped chains to their fallback readers, everything else to Blockchair. */
function web9999_coin(string $chain): array
{
    return isset(WEB9999_MARKET_IDS[$chain])
        ? web9999_fallback($chain)
        : web9999_blockchair($chain);
}
