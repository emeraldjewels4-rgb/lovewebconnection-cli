# ops — what runs on the host

`back-up-db.sh` is the only thing here: a nightly `mysqldump` of every database on the account, written
to `/home/<account>/backups/mysql/<YYYY-MM-DD>/<db>-<date>.sql.gz`. It is in the repository because a
file that exists only on a shared host is one nobody can review or rebuild — not because it belongs to
the `lwc` package, which it does not.

## Install, once

1. Create `~/.my.cnf` with the database user and password, mode `600`:

```ini
[client]
user=account_scan
password=…
```

Use File Manager → *New File* → `.my.cnf`, then *Change Permissions* to `0600`. It must not be readable
by anyone else, and it must not live in `public_html`.

2. Upload the script:

```sh
sftp <account>@<host> <<'EOF'
-mkdir bin
put ops/back-up-db.sh bin/back-up-db.sh
EOF
```

3. Run it once by hand — cPanel → **Terminal**, `sh /home/<account>/bin/back-up-db.sh` — and look at
`backups/mysql/<date>/` and `backups/error.log`. Nothing below matters until that first run is clean.

## Cron

cPanel → **Cron Jobs**, once per day at 03:17 (server time):

```cron
17 3 * * * /bin/sh /home/<account>/bin/back-up-db.sh >> /home/<account>/backups/mysql/backup.log 2>&1
```

## Retention

14 days. Every run deletes `*.sql.gz` older than that, and a failed database is reported on stderr and
exits non-zero, so a silent failure shows up as a cron email or a missing file. Raise `KEEP_DAYS` at the
top of the script if the quota allows; there is no monthly tier on purpose.

## The quarterly restore test

A backup nobody has restored is a hypothesis. Once a quarter:

1. Download one `.sql.gz` and `gunzip` it locally.
2. cPanel → **MySQL Databases** → create a scratch database, e.g. `<account>_restore_test`.
3. phpMyAdmin → select it → **Import** → the `.sql` file.
4. Compare `SHOW TABLES` and a couple of `SELECT COUNT(*)`s against the live database.
5. Drop the scratch database.

If a step fails, fix it then — not on the day the live database is gone.

## Not covered

The path and the `fiatgodx_*` database list are literal; both are at the top of the script and are the
two lines to change on another account. The dumps live outside `public_html` because a `.sql.gz` under
the web root is customer data with a URL, and they are on the same disk as the databases they copy — a
monthly copy taken off the account is worth more than a deeper retention on the account.
