#!/bin/bash
#
# Nightly MySQL back-ups for this cPanel account.
#
# A script rather than one long cron line, because the dump has to survive a failure
# half-way through (a gzip that truncates a dump is worse than no dump, since it looks
# like one), the credential file must never appear in `ps` or in a log, and pruning
# belongs to the same run so a full disk is not what finally stops the back-ups.
#
#   bin/back-up-db.sh              dump every database, verify each gzip, prune
#   bin/back-up-db.sh --verify     re-check today's .gz files only
#   bin/back-up-db.sh --restore-check FILE.sql.gz [--keep]
#                                  load one dump into $RESTORE_DB and compare it with
#                                  the live database it came from
#
# Credentials come from the scan app's own config.php through bin/db-credentials.php,
# written to a 600 file for the run: the password is never an argument and never
# reaches this log. That same user already holds privileges on every database below,
# because its connection lists all of them in SHOW DATABASES.
#
# The dumps live outside public_html on purpose: a .sql.gz under the web root is a
# copy of customer data with a URL.
#
set -euo pipefail
umask 077

ROOT="/home/fiatgodx"
BACKUPS="$ROOT/backups/mysql"
KEEP_DAYS=14
KEEP_MONTHS=6

DATABASES=(
  fiatgodx_fiatlord
  fiatgodx_lovewebconnection
  fiatgodx_scan
  fiatgodx_toolkit
  fiatgodx_web9999
  fiatgodx_zipchain
)

PATH="/usr/local/bin:/usr/local/mysql/bin:/usr/bin:/bin"
export PATH

mysqldump_bin="$(command -v mysqldump || true)"
mysql_bin="$(command -v mysql || true)"
gzip_bin="$(command -v gzip || true)"
php_bin="$(command -v php || true)"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FATAL: $*"; exit 1; }

[ -n "$mysqldump_bin" ] || die "mysqldump not found in PATH ($PATH)"
[ -n "$mysql_bin" ] || die "mysql not found in PATH ($PATH)"
[ -n "$gzip_bin" ] || die "gzip not found in PATH"

mkdir -p "$BACKUPS"

# ---------------------------------------------------------------- credentials
CNF="$BACKUPS/.mysql.$$.cnf"
cleanup() { rm -f "$CNF"; }
trap cleanup EXIT INT TERM HUP

if [ -n "$php_bin" ] && [ -f "$ROOT/bin/db-credentials.php" ]; then
  "$php_bin" "$ROOT/bin/db-credentials.php" > "$CNF" || die "db-credentials.php failed"
elif [ -f "$ROOT/.my.cnf" ]; then
  cp "$ROOT/.my.cnf" "$CNF"
else
  die "no credentials: no bin/db-credentials.php and no ~/.my.cnf"
fi
chmod 600 "$CNF"
[ -s "$CNF" ] || die "credentials file is empty"

sql() { "$mysql_bin" --defaults-extra-file="$CNF" -N -B -e "$1"; }

# ------------------------------------------------------------------- --verify
if [ "${1:-}" = "--verify" ]; then
  day_dir="$BACKUPS/$(date +%Y-%m-%d)"
  [ -d "$day_dir" ] || die "no dumps for $(date +%Y-%m-%d) in $day_dir"
  status=0
  seen=0
  for file in "$day_dir"/*.sql.gz; do
    [ -e "$file" ] || continue
    seen=1
    if "$gzip_bin" -t "$file" 2>/dev/null; then
      log "ok    $(basename "$file") ($(du -h "$file" | cut -f1))"
    else
      log "BAD   $(basename "$file") fails gzip -t"
      status=1
    fi
  done
  [ "$seen" -eq 1 ] || die "no .sql.gz files in $day_dir"
  exit "$status"
fi

# ------------------------------------------------------------ --restore-check
if [ "${1:-}" = "--restore-check" ]; then
  file="${2:-}"
  [ -f "$file" ] || die "usage: $0 --restore-check <dump.sql.gz> [--keep]"
  [ -n "${RESTORE_DB:-}" ] || die "set RESTORE_DB to a database you created in cPanel for this test"

  base="$(basename "$file")"
  source="${base%-20*.sql.gz}"
  [ -n "$source" ] && [ "$source" != "$base" ] || die "cannot tell the source database from $base"

  live_tables="$(sql "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${source}' ORDER BY TABLE_NAME")"
  [ -n "$live_tables" ] || die "no tables in live database ${source}; is the name in the dump correct?"

  log "restoring $base into $RESTORE_DB (source ${source})"
  "$gzip_bin" -dc "$file" | "$mysql_bin" --defaults-extra-file="$CNF" --database="$RESTORE_DB" \
    || die "import failed"

  status=0
  test_tables="$(sql "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${RESTORE_DB}' ORDER BY TABLE_NAME")"
  if [ "$live_tables" != "$test_tables" ]; then
    log "MISMATCH: table lists differ"
    diff <(printf '%s\n' "$live_tables") <(printf '%s\n' "$test_tables") | head -20 || true
    status=1
  else
    log "ok    the restored database has the same $(printf '%s\n' "$live_tables" | wc -l) tables"
  fi

  # TABLE_ROWS is approximate for InnoDB; it is here to catch an import that
  # stopped early, which is the failure worth catching, not to be exact.
  live_rows="$(sql "SELECT IFNULL(SUM(TABLE_ROWS),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${source}'")"
  test_rows="$(sql "SELECT IFNULL(SUM(TABLE_ROWS),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${RESTORE_DB}'")"
  log "rows: live~${live_rows} restored~${test_rows}"
  [ "$live_rows" = "$test_rows" ] || log "note: totals differ - approximate for InnoDB, or live data moved since the dump"

  if [ "${3:-}" != "--keep" ]; then
    while read -r table; do
      [ -n "$table" ] || continue
      printf 'DROP TABLE IF EXISTS `%s`;\n' "$table"
    done <<< "$test_tables" | "$mysql_bin" --defaults-extra-file="$CNF" --database="$RESTORE_DB" || status=1
    log "dropped the restored tables from $RESTORE_DB (pass --keep to inspect them)"
  fi
  exit "$status"
fi

[ "$#" -eq 0 ] || die "unknown argument: $1"

# ------------------------------------------------------------------- dumps
day="$(date +%Y-%m-%d)"
day_dir="$BACKUPS/$day"
mkdir -p "$day_dir"

log "back-up starting: $day"
failures=0

for db in "${DATABASES[@]}"; do
  if [ -z "$(sql "SHOW DATABASES LIKE '${db}'")" ]; then
    log "skip  $db (not present on the server)"
    continue
  fi

  out="$day_dir/$db-$day.sql.gz"

  # pipefail is set: a failing mysqldump inside the pipe fails the whole command,
  # so a half-written dump cannot be mistaken for a complete one.
  if "$mysqldump_bin" --defaults-extra-file="$CNF" \
       --single-transaction --quick --routines --triggers --events --hex-blob \
       --default-character-set=utf8mb4 --databases "$db" \
       | "$gzip_bin" -9 > "$out"; then
    :
  else
    log "FAIL  $db: mysqldump or gzip returned non-zero"
    rm -f "$out"
    failures=$((failures + 1))
    continue
  fi

  if ! "$gzip_bin" -t "$out" 2>/dev/null; then
    log "FAIL  $db: gzip -t rejects the file"
    rm -f "$out"
    failures=$((failures + 1))
    continue
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$out" | cut -d' ' -f1 > "$out.sha256"
  else
    shasum -a 256 "$out" | cut -d' ' -f1 > "$out.sha256"
  fi
  log "ok    $db -> $(basename "$out") ($(du -h "$out" | cut -f1))"
done

# -------------------------------------------------------------- monthly copies
if [ "$(date +%d)" = "01" ]; then
  mkdir -p "$BACKUPS/monthly"
  for file in "$day_dir"/*.sql.gz; do
    [ -e "$file" ] || continue
    cp "$file" "$BACKUPS/monthly/$(basename "$file")"
  done
  log "monthly copies written for $(date +%Y-%m)"
fi

# ------------------------------------------------------------------ pruning
removed=0
while read -r dir; do
  [ -n "$dir" ] || continue
  rm -rf "$dir"
  removed=$((removed + 1))
done < <(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -name '20*-*-*' -mtime "+$KEEP_DAYS" 2>/dev/null)
[ "$removed" -gt 0 ] && log "pruned $removed day director(ies) older than $KEEP_DAYS days"

# Monthly files go by name, not mtime: a copy keeps the mtime of what it copied.
if [ -d "$BACKUPS/monthly" ]; then
  keep=0
  while read -r file; do
    [ -n "$file" ] || continue
    keep=$((keep + 1))
    [ "$keep" -le "$KEEP_MONTHS" ] && continue
    rm -f "$BACKUPS/monthly/$file" "$BACKUPS/monthly/$file.sha256"
    log "pruned monthly $file"
  done < <(ls -1 "$BACKUPS/monthly" 2>/dev/null | grep -E '\.sql\.gz$' | sort -r)
fi

# -------------------------------------------------------------------- done
if [ "$failures" -gt 0 ]; then
  log "back-up finished with $failures failure(s)"
  exit 1
fi
log "back-up finished cleanly"
