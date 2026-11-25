<?php
declare(strict_types=1);

/**
 * Print a [client] block for mysqldump, from the config the site already reads.
 *
 * Run by bin/back-up-db.sh, which redirects this into a 600 file and deletes it when
 * the run ends. Keeping the credentials here rather than in ~/.my.cnf means there is
 * one copy on the account instead of two that can drift, and printing them on stdout
 * rather than taking them as arguments keeps them out of `ps` and out of the log.
 *
 * Set SCAN_CONFIG to point somewhere else; the cPanel path is the fallback.
 */

$path = getenv('SCAN_CONFIG');
if (!is_string($path) || $path === '') {
    $path = '/home/fiatgodx/public_html/scan/config.php';
}

if (!is_file($path)) {
    fwrite(STDERR, "no config at {$path}\n");
    exit(1);
}

$config = require $path;
$db = is_array($config) && is_array($config['db'] ?? null) ? $config['db'] : [];

foreach (['user', 'password'] as $key) {
    if (!isset($db[$key]) || (string) $db[$key] === '') {
        fwrite(STDERR, "config.php has no db.{$key}\n");
        exit(1);
    }
}

// Quoted, because a password may contain a space, a quote or a '#' that the option
// file would otherwise read as a comment.
$quote = static function (string $value): string {
    return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $value) . '"';
};

printf("[client]\n");
printf("user=%s\n", $quote((string) $db['user']));
printf("password=%s\n", $quote((string) $db['password']));
printf("host=%s\n", $quote((string) ($db['host'] ?? 'localhost')));
printf("port=%d\n", (int) ($db['port'] ?? 3306));
