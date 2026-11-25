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

3. Do the first run described in the next section. Nothing after it matters until that run is clean and
one of its dumps has been imported.

## The first run, on this account

The backup is not trusted because a log line said `ok`; it is trusted once one of its files has been
imported and compared. Do the whole of this once, before adding the cron entry.

**1. Run it by hand.** cPanel → **Terminal**:

```sh
sh /home/fiatgodx/bin/back-up-db.sh
```

It ends silently on success (the per-database lines go to stdout, failures to stderr). If it prints
`no /home/fiatgodx/.my.cnf`, step 1 of the install did not happen and nothing else will work.

**2. Look at what it produced.**

```sh
ls -l /home/fiatgodx/backups/mysql/$(date +%F)/
tail -20 /home/fiatgodx/backups/mysql/backup.log 2>/dev/null
cat /home/fiatgodx/backups/error.log 2>/dev/null
```

A healthy directory is one `.sql.gz` per database that exists, dated today:

```
fiatgodx_fiatlord-2026-11-25.sql.gz
fiatgodx_lovewebconnection-2026-11-25.sql.gz
fiatgodx_toolkit-2026-11-25.sql.gz
fiatgodx_web9999-2026-11-25.sql.gz
fiatgodx_zipchain-2026-11-25.sql.gz
```

Five files, not six: `fiatgodx_scan` is still dropped. It appears here on its own once the database is
recreated in cPanel — no change to the script. Sizes in the megabytes are normal; a 0-byte file or a
missing database that you know exists is the failure to chase. `error.log` should be empty or absent.

**3. Restore one dump into a scratch database.** This is the step that proves the backup.

1. Download one `.sql.gz` (File Manager → select → *Download*), then `gunzip` it locally. phpMyAdmin
   may accept the `.gz` directly, but gunzipping first removes one variable.
2. cPanel → **MySQL Databases** → create a database, e.g. `fiatgodx_restore_test`, and add the same
   user with **ALL PRIVILEGES**.
3. cPanel → **phpMyAdmin** → click `fiatgodx_restore_test` in the left sidebar → **Import** tab →
   *Choose File* → the `.sql` → **Go**. The dump contains no `CREATE DATABASE` or `USE`, so it lands in
   whichever database you selected — which is why the dump is written without `--databases`.
4. Compare it with the live database in the **SQL** tab:

```sql
SHOW TABLES;
SELECT COUNT(*) FROM blocks;
SELECT COUNT(*) FROM transfers;
SELECT last_block FROM progress WHERE id = 1;
```

   Run the same four against the live database and expect the same table list and the same counts, or
   close counts if the crawler has ingested since the dump.
5. Drop the scratch database in cPanel → MySQL Databases. Leaving it risks a later import into the
   wrong place.

If step 3 or 4 fails, fix the backup before adding the cron entry — on the day the live database is
missing is the wrong time to discover the dumps are empty.

## Cron

cPanel → **Cron Jobs**, once per day at 03:17 (server time):

```cron
17 3 * * * /bin/sh /home/<account>/bin/back-up-db.sh >> /home/<account>/backups/mysql/backup.log 2>&1
```

## Retention

14 days. Every run deletes `*.sql.gz` older than that, and a failed database is reported on stderr and
exits non-zero, so a silent failure shows up as a cron email or a missing file. Raise `KEEP_DAYS` at the
top of the script if the quota allows; there is no monthly tier on purpose.

## Then, once a quarter

Repeat step 3 of the first run — import one dump into a scratch database and compare it — on a fresh
backup rather than the first one. It is the same five steps, and it is the only thing that turns an
accumulating set of files into a backup that has been shown to restore. Do it before a hosting plan
change, a migration or an upgrade, not only on the calendar.

## Not covered

The path and the `fiatgodx_*` database list are literal; both are at the top of the script and are the
two lines to change on another account. The dumps live outside `public_html` because a `.sql.gz` under
the web root is customer data with a URL, and they are on the same disk as the databases they copy — a
monthly copy taken off the account is worth more than a deeper retention on the account.
