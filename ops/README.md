# ops — the code that runs on the host, not in the package

This directory holds operator scripts that belong to the hosting account rather than to the `lwc`
command: they run from cron, never ship in the npm package, and are the only things here that touch
production data. They live in version control for the same reason `docs/scan/` does — a file that
exists only on a shared host is a file nobody can diff, review or rebuild from.

## back-up-db.sh

Nightly `mysqldump` of every database on the account, written to
`/home/<account>/backups/mysql/<YYYY-MM-DD>/<db>-<date>.sql.gz`, with a `sha256` beside each file.

```sh
bin/back-up-db.sh              dump, verify, prune
bin/back-up-db.sh --verify     re-check today's .gz files only
bin/back-up-db.sh --restore-check FILE.sql.gz [--keep]
                               load one dump into $RESTORE_DB and compare it with live
```

It records a few decisions worth keeping:

- **`set -o pipefail` around `mysqldump | gzip`.** A dump that dies mid-stream must fail the run, not
  leave a truncated file that looks like a back-up.
- **`gzip -t` plus a `sha256` for every file**, inline, so integrity checking is not a second job
  somebody has to remember to write.
- **Pruning in the same run.** 14 daily directories plus 6 monthly copies; a back-up that fills the
  quota stops being a back-up.
- **The database list is checked, not assumed.** A database that does not exist is skipped with a log
  line instead of failing the other five — `fiatgodx_scan` was dropped once and recreated later, which
  is exactly the case that would otherwise read as "all back-ups broken".
- **The dumps are outside `public_html`.** A `.sql.gz` under the web root is customer data with a URL.

## db-credentials.php

Prints a `[client]` block for `mysqldump` from the scan app's own `config.php`, which
`back-up-db.sh` redirects into a `600` file and deletes on exit. One copy of the password exists on the
account, in the file the site already uses; it is never an argument, never in `ps`, and never in the
back-up log. Nothing in this directory contains a credential, and nothing should start to.

## Installing on the host

```sh
# from a checkout
sftp <account>@<host> <<'EOF'
-mkdir bin
put ops/back-up-db.sh      bin/back-up-db.sh
put ops/db-credentials.php bin/db-credentials.php
EOF
```

Then cPanel → **Cron Jobs**, once per day at 03:17:

```cron
17 3 * * * /bin/bash /home/<account>/bin/back-up-db.sh >> /home/<account>/backups/mysql/backup.log 2>&1
```

The log line carries a UTC timestamp; cPanel cron fires in server time.

## Rehearsing a restore

A back-up nobody has restored is a hope. Create a scratch database once in cPanel (**MySQL Databases**),
grant the configured user **ALL PRIVILEGES** on it, and run:

```sh
RESTORE_DB=<account>_restore_test /bin/bash /home/<account>/bin/back-up-db.sh \
  --restore-check /home/<account>/backups/mysql/<date>/<account>_scan-<date>.sql.gz
```

It imports the dump, compares the table list exactly against the live database, prints approximate row
totals for both, and drops the restored tables unless `--keep` is given. `TABLE_ROWS` is an estimate for
InnoDB, so the totals catch an import that stopped early rather than proving every row.

## Not covered

The scripts read `/home/<account>/` paths and a `fiatgodx_*` database list; both are near the top of
`back-up-db.sh` and are the two lines to change on another account. If `mysqldump` is not in
`/usr/local/bin`, `/usr/local/mysql/bin`, `/usr/bin` or `/bin`, the run stops with a `FATAL:` line
naming the PATH it searched instead of writing an empty file.
