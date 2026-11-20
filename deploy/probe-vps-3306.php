<?php
// THROWAWAY PROBE - delete this file from the host as soon as it has answered.
//
// Answers one question and nothing else: can this shared host open a TCP connection to the VPS on
// 3306? That is the x10 -> VPS direction, which no test run from this machine can observe.
//
// Read the result like this:
//   connected + greeting  -> egress allowed, and something on the VPS is listening
//   errno 110 / timed out -> the path is dropped: x10 egress or the VPS firewall
//   errno 111 / refused   -> reachable, but nothing is listening (install MySQL first)
header('Content-Type: text/plain; charset=utf-8');

$host    = '108.181.154.182';
$port    = 3306;
$timeout = 5;

echo "host: " . gethostname() . " (" . ($_SERVER['SERVER_ADDR'] ?? 'unknown address') . ")\n";
echo "target: {$host}:{$port}\n";
echo "php: " . PHP_VERSION . "\n\n";

$start = microtime(true);
$errno = 0;
$errstr = '';
$fp = @fsockopen($host, $port, $errno, $errstr, $timeout);
$ms = (int) round((microtime(true) - $start) * 1000);

if ($fp !== false) {
    stream_set_timeout($fp, $timeout);
    $greeting = (string) fread($fp, 128);
    fclose($fp);
    echo "tcp: connected in {$ms} ms\n";
    echo "greeting: " . preg_replace('/[^\x20-\x7e]/', '.', $greeting) . "\n";
    echo "RESULT: egress to {$host}:{$port} is ALLOWED and something answers there.\n";
} else {
    echo "tcp: failed in {$ms} ms - errno {$errno}: {$errstr}\n";
    if ($errno === 110) {
        echo "RESULT: TIMED OUT - the path is dropped before anything answers.\n";
        echo "        Either this host cannot reach that port, or the VPS firewall drops it.\n";
    } elseif ($errno === 111) {
        echo "RESULT: CONNECTION REFUSED - the VPS answered, but nothing listens on 3306.\n";
        echo "        Egress is fine; install MySQL before reading anything else into this.\n";
    } else {
        echo "RESULT: inconclusive (errno {$errno}).\n";
    }
}

echo "\nDELETE THIS FILE NOW - it must not stay on a public host.\n";
