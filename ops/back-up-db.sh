#!/bin/sh
#
# Nightly MySQL dump of every database on this account: dump, verify, prune.
#
# Deliberately small. An earlier version carried its own credential helper, a signal-trapped temp
# config, per-file checksums, a monthly tier and a --restore-check mode, and none of it had ever run
# on the host it was written for. Every branch that has never executed is a branch that can be wrong
# the first time, so this keeps the four things that matter and drops the rest:
#
#   - `--single-transaction`, so the dump is consistent without locking the tables the site reads;
#   - dump to a file, then gzip it, rather than piping into gzip. A failing mysqldump then leaves no
#     .gz at all, which is easier to be sure about than a pipeline whose exit status is being read;
#   - `gzip -t` on the result, because a truncated dump looks exactly like a good one;
#   - prune in the same run, because a backup that fills the quota stops being a backup.
#
# Credentials come from ~/.my.cnf (mode 600) — one file the operator writes once, which is also what
# lets this stay a three-line loop. Nothing here prints, copies or logs the password.
#
# Install: ops/README.md. Cron: 17 3 * * * /bin/sh /home/<account>/bin/back-up-db.sh
#
set -eu

CNF="$HOME/.my.cnf"
KEEP_DAYS=14
DIR="$HOME/backups/mysql/$(date +%F)"

[ -f "$CNF" ] || { echo "no $CNF (see ops/README.md)" >&2; exit 1; }
mkdir -p "$DIR"

failures=0
for db in fiatgodx_fiatlord fiatgodx_lovewebconnection fiatgodx_scan \
          fiatgodx_toolkit fiatgodx_web9999 fiatgodx_zipchain; do
    out="$DIR/$db-$(date +%F).sql"

    # A database that is not there is skipped, not failed: fiatgodx_scan was dropped once and
    # recreated later, and that must not read as five broken backups.
    if ! mysqldump --defaults-extra-file="$CNF" --single-transaction --quick \
            --routines --triggers --databases "$db" >"$out" 2>>"$HOME/backups/error.log"; then
        echo "$(date -u +%FT%TZ) FAILED $db (mysqldump)" >&2
        rm -f "$out"
        failures=$((failures + 1))
        continue
    fi

    if ! gzip -9 "$out" || ! gzip -t "$out.gz"; then
        echo "$(date -u +%FT%TZ) FAILED $db (gzip)" >&2
        rm -f "$out" "$out.gz"
        failures=$((failures + 1))
        continue
    fi

    echo "$(date -u +%FT%TZ) ok $db $(du -h "$out.gz" | cut -f1)"
done

find "$HOME/backups/mysql" -name '*.sql.gz' -mtime "+$KEEP_DAYS" -delete

[ "$failures" -eq 0 ] || { echo "$failures database(s) failed" >&2; exit 1; }
