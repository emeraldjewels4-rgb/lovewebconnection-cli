# The scan index: what it holds, what it can rebuild, what it cannot

`/scan/api.php` is the history index behind the page deployed beside it (`public_html/scan/index.html`,
"Polygon Scan — chain 137"). The page reads the chain live and needs nothing from the database; the
index exists for the one thing a live reader cannot answer — "what has this address done" — because
`eth_getLogs` is token-gated on the public endpoint. It indexes chain 137 only, and `chainId` in `status`
is a constant there rather than a guess from the RPC.

## The code this describes

`docs/scan/` holds the deployed files, taken from the host byte for byte on 2026-11-25:
`api.php` (`sha256 414f5fcb299e7633d976b7a6baa7c19a15a224be00a288e60538e8f23efa5e2b`),
`config.sample.php` and `tuning.php`. They are here so the table list and the `ingest()` quote below
have something in the repository to disagree with: if `api.php` changes on the host and this copy is
not refreshed, the digest stops matching and this document is describing code that is not running.

`config.php` is deliberately absent. It is the one file that holds the database password, it exists
only on the host, and it is written by hand from `config.sample.php` — a copy here would be a
credential in version control, which is the shape of mistake this directory exists to avoid.

It runs from `public_html/scan/`, with credentials in `public_html/scan/config.php` (written once by
hand from `config.sample.php`, never in a package) and a cron job every five minutes:

```sh
/usr/local/bin/php /home/<account>/public_html/scan/api.php ingest
```

The HTTP form works too — `/scan/api.php?r=ingest&key=<cron_key>` — for anything that would rather call
a URL than start a process.

## The seven tables

`schema()` is called from `database()` on **every** connection, and every statement is
`CREATE TABLE IF NOT EXISTS`. The structure therefore rebuilds itself as soon as anything connects;
what a lost database cannot give back is the rows.

| Table | What it holds | Where it comes from | After a loss |
| --- | --- | --- | --- |
| `blocks` | number, hash, parent, time, gas used/limit, base fee, miner, tx count | `eth_getBlockByNumber` | refills forward only |
| `txs` | hash, block, index, from/to, value, status, gas used | block body + receipts | refills forward only |
| `transfers` | ERC-20 `Transfer` logs: token, from, to, amount (hex), unique on `(tx_hash, log_index)` | receipts | refills forward only |
| `tokens` | currencies minted through TokenFactory, from `TokenCreated` events | receipts | refills forward only |
| `progress` | one row (`id = 1`), `last_block` — how far the crawler got | written by `store_block` | recreated at head |
| `counts` | one row, cached `COUNT(*)` of the four tables | `store_counts` after each run | recomputed each run |
| `contracts` | cached verified source from Sourcify: abi, sources, bytecode, `fetched_at`, `origin` | fetched on demand | repopulates per address |

Two of those need a word more.

`counts` exists because `COUNT(*)` over a `transfers` table of tens of millions of rows is a full index
scan — fourteen seconds — which is why the status route once timed out. It is a cache, written once per
ingest run, and it costs nothing to lose.

`contracts` is the only table that is not chain-derived at all. It is a copy of what Sourcify verified,
kept so a contract page answers when Sourcify is slow. The route reads the row, and if it is missing or
older than seven days it re-fetches and stores it again, so each contract page heals itself on first
visit. What cannot be recovered is the *list* of which addresses had been cached, because nothing
enumerated them.

## The limit: ingest is forward-only

This is the part worth knowing before a database is lost, because it decides what a rebuild can and
cannot do. From `ingest()`:

```php
$row = $db->query('SELECT last_block FROM progress WHERE id = 1')->fetch();
if ($row === false || !isset($row['last_block'])) {
    // First run starts at the head. This chain is ~97 million blocks old and a
    // shared host is not going to walk it; claiming otherwise would be a lie
    // repeated on every address page.
    $last = max(0, $head - 1);
```

With no `progress` row the crawler starts at the **current head** and moves forward. There is no
backfill flag, no start-block parameter, and nothing that replays history — deliberately, because
walking 97 million blocks from a shared host is not a thing that finishes. The consequences:

- An empty database becomes a correct, current index from the moment the first run completes — and it
  holds **none** of the history that was in it before.
- `status.firstBlock` is how the index says so: it is `MIN(blocks.number)`, so after a rebuild it names
  the first block of the new run, not the chain's first. Every surface that shows indexed data carries
  that number, because a history silently missing its beginning is worse than no history.
- Address pages will show nothing for activity before that block. That is the honest state, not a bug.

## Restoring (preferred)

1. cPanel → **JETBACKUP** → Restore, and pick a backup taken before the loss.
2. Restrict it to **Databases → the scan database only**. Restoring files or other databases would roll
   back things that are currently fine.
3. Check `/scan/api.php?r=status`: `ok` should be `true`, `firstBlock` should be far below `lastBlock`,
   and `transfers` should be in the millions rather than zero.

A restore is the only path that brings the history back. Everything below rebuilds the machinery.

## Rebuilding from nothing

1. cPanel → **MySQL Databases** → create database `scan`, which cPanel names `<account>_scan`. The name
   is not a preference: `config.php` hardcodes it as `dbname`, and a different name is simply not found.
2. On the same page, **Add User To Database** → the user named in `config.php` → **ALL PRIVILEGES**.
   Adding an existing user does not change its password, and the password does not need to be known to
   do this.
3. **Write no SQL.** Do not create the tables by hand. `database()` runs `schema()` on the first
   connection, so the seven tables appear on their own; hand-made tables would become a second
   definition that drifts from `api.php`.
4. Trigger one run, either by waiting for the five-minute cron or by calling
   `/scan/api.php?r=ingest&key=<cron_key>` once, taking `cron_key` from `config.php` in File Manager.
5. Confirm with `/scan/api.php?r=status`: `chainId 137`, `lastBlock` at or near the Polygon head,
   `firstBlock` equal to the block of that first run, `counts.countedAt` recent.

Until the database exists, every database-backed route answers `503` with
`Unknown database '<account>_scan'`; the page itself keeps working, because it reads the chain live.

## Backups

`bin/back-up-db.sh` on the account dumps every database nightly with `mysqldump --single-transaction`,
checks each file with `gzip -t` and a `sha256`, keeps 14 days plus 6 monthly copies, and prunes inside
the same run. `bin/` is only where it is installed: the script and its credential helper are tracked in
`ops/`, next to this document's repository, so the back-up can be rebuilt from a checkout — see
`ops/README.md`. A rehearsal against a throwaway database is:

```sh
RESTORE_DB=<account>_restore_test /bin/bash /home/<account>/bin/back-up-db.sh \
  --restore-check /home/<account>/backups/mysql/<date>/<account>_scan-<date>.sql.gz
```

It imports the dump, compares the table list with the live database exactly, prints approximate row
totals for both, and drops the restored tables unless `--keep` is given. `TABLE_ROWS` is approximate for
InnoDB, so the totals catch an import that stopped early rather than proving every row.
