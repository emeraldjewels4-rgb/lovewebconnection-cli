#!/usr/bin/env bash
# Makes the web9999 site on this host answer /api/* by proxying to the existing x10 deployment
# over HTTPS, so the page and its rails are served from one origin without moving anything.
#
# WHY THIS EXISTS
#
# The page calls its rails same-origin and absolutely (/api/web9999/coins, /api/markets,
# /api/monero/stats.php). On a static host those paths 404, because there is no PHP and the
# database is still on x10. Proxy the prefix instead of moving the database: the rails keep running
# where they already work, the browser sees one origin, and no database credential leaves x10.
#
# This is the nginx counterpart of proxy-web9999.ps1, with the same flags, the same dry-run block,
# the same per-path forwarding list, the same REFUSED lines and the same exit codes. The rule lives
# in /etc/nginx/snippets/, included from the site block, so a reinstall of the site does not drop it
# while a --remove takes it away deliberately.
#
#   ./proxy-web9999.sh --upstream https://fiatgod.x10.mx
#   ./proxy-web9999.sh --upstream https://fiatgod.x10.mx --dry-run
#   ./proxy-web9999.sh --remove
#   ./proxy-web9999.sh --selftest
#
# Exit codes: 0 done, 1 the selftest failed OR the through-proxy check failed after the rule was
# installed, 2 refused because a prerequisite is missing or the upstream does not answer (nothing
# was changed).
set -uo pipefail

UPSTREAM=""
SITE_NAME=web9999
WEB_PORT=8782
RULE_NAME=web9999-api-proxy
REMOVE=0
DRYRUN=0
SELFTEST=0
CONF_DIR=/etc/nginx/conf.d
SNIPPET_DIR=/etc/nginx/snippets
CONF=""
SNIPPET=""

# stderr, not stdout: a validator runs inside $(...) and its message must survive the capture.
refuse() { printf '  REFUSED: %s\n' "$*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
usage: proxy-web9999.sh [options]

  --upstream https://host[/path]   the x10 origin the rails are proxied to (required)
  --site-name NAME                 server block to attach to (default web9999)
  --web-port N                     the port that block listens on (default 8782)
  --rule-name NAME                 snippet name (default web9999-api-proxy)
  --remove                         remove the rule and leave /api/* unproxied
  --dry-run                        print the plan, change nothing
  --selftest                       prove the validators and the plan on this host, touch nothing
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --upstream) UPSTREAM=${2:-}; shift 2 ;;
    --site-name) SITE_NAME=${2:-}; shift 2 ;;
    --web-port) WEB_PORT=${2:-}; shift 2 ;;
    --rule-name) RULE_NAME=${2:-}; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    --dry-run) DRYRUN=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) refuse "unknown option '$1'; run --help" ;;
  esac
done

CONF="$CONF_DIR/$SITE_NAME.conf"
SNIPPET="$SNIPPET_DIR/$RULE_NAME.conf"
SNIPPET_IN_SITE="include $SNIPPET;"

# Scheme, host and an optional subdirectory - no query, no fragment. The path is kept in front of
# /api/, so an upstream mounted under one serves the same rails through the same rule.
proxy_origin() {
  local text=$1
  [ -n "$text" ] || refuse 'no upstream given: pass --upstream https://<your x10 host>'
  case $text in
    ''|*[[:space:]]*) refuse "upstream '$text' is not a URL" ;;
    https://*) ;;
    *) refuse "upstream must be https://, got '$text' - plain http would put the API data on the wire in the clear" ;;
  esac
  case $text in
    *\?*) refuse "upstream must not carry a query string or fragment, got '$text'" ;;
    *\#*) refuse "upstream must not carry a query string or fragment, got '$text'" ;;
  esac
  local rest=${text#https://}
  local authority=${rest%%/*}
  local path=""
  [ "$rest" = "$authority" ] || path="/${rest#*/}"
  [ -n "$authority" ] || refuse "upstream '$text' is not a URL"
  case $authority in
    *[[:space:]]*|*@*) refuse "upstream '$text' is not a URL" ;;
  esac
  # Checked on the text: a "/app/../etc" would otherwise resolve to /etc before any check saw it.
  if printf '%s' "$path" | grep -Eq '/(\.|%2e){1,2}(/|$)'; then
    refuse "upstream must not carry . or .. segments, got '$text'"
  fi
  path=${path%/}
  if [ -n "$path" ] && ! printf '%s' "$path" | grep -Eq '^(/[A-Za-z0-9._~-]+)+$'; then
    refuse "upstream path must be plain segments (letters, digits, . _ ~ -), got '$text'"
  fi
  printf '%s://%s%s\n' 'https' "$authority" "$path"
}

# The plan as data: one row per forwarded prefix, each with the absolute target it lands on.
forward_plan() {
  local origin=$1
  printf '%-8s -> %s\n' '/api/' "$origin/api/"
}

# The concrete requests those prefixes carry: the dry run's paper trail, so a prefix is never
# advertised as forwarded without the paths the page actually asks for.
forwarded_paths() {
  local origin=$1 p
  for p in /api/web9999/coins /api/markets /api/monero/stats.php; do
    printf '%-26s -> %s\n' "$p" "$origin$p"
  done
}

# What an answer to /api/web9999/coins actually is. A misrouted base path comes back as 200 with
# HTML, and a status-only test calls that "configured" while every browser gets the wrong page.
classify_answer() {
  local status=$1 ctype=$2 body=$3
  local type=${ctype%%;*}
  type=$(printf '%s' "$type" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  local first
  first=$(printf '%s' "$body" | tr -d '[:space:]' | cut -c1)
  if [ "$status" != "200" ]; then
    printf 'it answered HTTP %s\n' "$status"
    return 1
  fi
  if [ "$type" != "application/json" ]; then
    if [ -z "$type" ]; then printf 'it answered with no content type, not application/json\n';
    else printf 'it answered as %s, not application/json\n' "$type"; fi
    return 1
  fi
  case $first in
    '{'|'[') ;;
    '<') printf 'it answered with HTML, not application/json\n'; return 1 ;;
    '') printf 'the content type says JSON but the body is empty\n'; return 1 ;;
    *) printf 'the content type says JSON but the body does not start like JSON\n'; return 1 ;;
  esac
  return 0
}

probe_upstream() {
  local origin=$1 hdr body status ctype why
  hdr=$(mktemp); body=$(mktemp)
  say "  checking the upstream: $origin/api/web9999/coins"
  status=$(curl -sS --max-time 20 -D "$hdr" -o "$body" -w '%{http_code}' "$origin/api/web9999/coins" 2>/dev/null || echo 000)
  ctype=$(grep -i '^content-type:' "$hdr" | head -1 | cut -d: -f2- | tr -d '\r' || true)
  if ! why=$(classify_answer "$status" "$ctype" "$(cat "$body" 2>/dev/null)"); then
    rm -f "$hdr" "$body"
    refuse "the upstream does not answer JSON at $origin/api/web9999/coins - $why"
  fi
  say "  upstream   $status $(printf '%s' "$ctype" | tr -d '\r'), $(wc -c < "$body" | tr -d ' ') bytes"
  rm -f "$hdr" "$body"
}

# The snippet itself. Referer is not decoration: measured against the live API, it answers
# "this API answers the pages it is served with" (403) to a caller whose referer names another
# host, so the header is set to the origin the rails believe they are serving.
write_snippet() {
  local origin=$1 authority=${1#https://}
  authority=${authority%%/*}
  mkdir -p "$SNIPPET_DIR" || refuse "cannot create $SNIPPET_DIR"
  {
    echo "# managed by deploy/proxy-web9999.sh - edits are overwritten on the next run"
    echo "location /api/ {"
    echo "    proxy_pass $origin;"
    echo "    proxy_ssl_server_name on;"
    echo "    proxy_set_header Host $authority;"
    echo "    proxy_set_header Referer $origin/"
    echo "    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
    echo "    proxy_set_header X-Forwarded-Proto \$scheme;"
    echo "    proxy_http_version 1.1;"
    echo "    proxy_read_timeout 30s;"
    echo "}"
  } > "$SNIPPET.tmp" || refuse "cannot write $SNIPPET"
  mv "$SNIPPET.tmp" "$SNIPPET" || refuse "cannot replace $SNIPPET"
}

# Attach or detach the include line in the site block, in place, leaving every other line alone.
set_include() {
  local want=$1 tmp
  [ -f "$CONF" ] || refuse "no nginx server block at $CONF; install the site first (install-web9999.sh)"
  tmp=$(mktemp)
  if [ "$want" = "add" ]; then
    if grep -Fq "$SNIPPET_IN_SITE" "$CONF"; then rm -f "$tmp"; return 0; fi
    awk -v line="    $SNIPPET_IN_SITE" '
      { a[NR] = $0 }
      END {
        last = 0
        for (i = NR; i >= 1; i--) if (a[i] ~ /^[[:space:]]*}/) { last = i; break }
        for (i = 1; i <= NR; i++) { if (i == last) print line; print a[i] }
        if (last == 0) print line
      }' "$CONF" > "$tmp"
  else
    sed "s|^[[:space:]]*include[[:space:]]*$SNIPPET;.*$|    # proxy: absent|" "$CONF" > "$tmp"
  fi
  cp "$CONF" "$CONF.bak" || refuse "cannot back up $CONF"
  mv "$tmp" "$CONF" || refuse "cannot rewrite $CONF"
}

apply_and_reload() {
  local err
  if ! nginx -t 2>/tmp/nginx-t.$$; then
    err=$(cat /tmp/nginx-t.$$); rm -f /tmp/nginx-t.$$
    [ -f "$CONF.bak" ] && mv "$CONF.bak" "$CONF"
    refuse "nginx rejected the configuration; $CONF was restored from $CONF.bak ($(printf '%s' "$err" | grep -m1 -E 'emerg|error' || echo 'see nginx -t'))"
  fi
  rm -f /tmp/nginx-t.$$
  systemctl reload nginx 2>/dev/null || { err=$(nginx -s reload 2>&1) || refuse "nginx reload failed: $err"; }
}

# ---------------------------------------------------------------- selftest

selftest() {
  local failures=0 total=0 got
  check() {
    total=$((total + 1))
    [ "$2" = "$3" ] && return 0
    failures=$((failures + 1))
    printf '  FAIL %s (got %s, expected %s)\n' "$1" "$2" "$3"
  }
  throws() {
    total=$((total + 1))
    if ( "$@" ) >/dev/null 2>&1; then
      failures=$((failures + 1))
      printf '  FAIL expected a refusal, got an answer\n'
    fi
  }
  got=$(proxy_origin 'https://fiatgod.x10.mx')            ; check 'a bare https origin is accepted' "$got" 'https://fiatgod.x10.mx'
  got=$(proxy_origin 'https://fiatgod.x10.mx/')           ; check 'a trailing slash is dropped' "$got" 'https://fiatgod.x10.mx'
  got=$(proxy_origin 'https://fiatgod.x10.mx:8443')       ; check 'a port is kept' "$got" 'https://fiatgod.x10.mx:8443'
  got=$(proxy_origin 'https://fiatgod.x10.mx/web9999-interface') ; check 'a subdirectory is kept' "$got" 'https://fiatgod.x10.mx/web9999-interface'
  got=$(proxy_origin 'https://fiatgod.x10.mx/web9999-interface/') ; check 'a trailing slash after a subdirectory is dropped' "$got" 'https://fiatgod.x10.mx/web9999-interface'
  for bad in 'http://fiatgod.x10.mx' 'fiatgod.x10.mx' 'https://fiatgod.x10.mx/app?x=1' 'https://fiatgod.x10.mx/app#top' 'https://fiatgod.x10.mx/app/../etc' 'https://fiatgod.x10.mx/app x' ''; do
    throws proxy_origin "$bad"
  done

  check 'the plan forwards one prefix' "$(forward_plan https://fiatgod.x10.mx | wc -l | tr -d ' ')" '1'
  check 'the plan names the api target' "$(forward_plan https://fiatgod.x10.mx)" "$(printf '%-8s -> %s' '/api/' 'https://fiatgod.x10.mx/api/')"
  check 'three paths are advertised' "$(forwarded_paths https://fiatgod.x10.mx | wc -l | tr -d ' ')" '3'
  check 'every path lands under the origin' "$(forwarded_paths https://fiatgod.x10.mx | grep -c '^/api/[^ ]* *-> https://fiatgod.x10.mx/api/')" '3'

  classify_answer 200 'application/json; charset=utf-8' '{"ok":true}' >/dev/null 2>&1
  check 'json on 200 is accepted' "$?" '0'
  classify_answer 200 'text/html' '<!doctype html><p>404' >/dev/null 2>&1
  check 'html on 200 is refused' "$?" '1'
  classify_answer 200 'application/json' '' >/dev/null 2>&1
  check 'empty json body is refused' "$?" '1'
  classify_answer 403 'application/json' '{"ok":false}' >/dev/null 2>&1
  check 'a non-200 is refused' "$?" '1'
  classify_answer 200 '' '{"ok":true}' >/dev/null 2>&1
  check 'json without a content type is refused' "$?" '1'

  if [ "$failures" -eq 0 ]; then
    say "  proxy selftest PASSED ($total checks)"
    exit 0
  fi
  say "  proxy selftest FAILED ($failures)"
  exit 1
}

# Order matters and follows proxy-web9999.ps1: the selftest first, then the origin is validated,
# then -DryRun answers without touching the host, and only then are the host prerequisites checked.
# A bad origin therefore gets its own sentence, not "must be root".
if [ "$SELFTEST" = 1 ]; then selftest; fi

if [ "$REMOVE" = 1 ]; then
  [ "$(id -u)" -eq 0 ] || refuse "this must run as root to remove $SNIPPET and reload nginx"
  if [ ! -f "$SNIPPET" ]; then
    say "  no rule named $RULE_NAME on this host: nothing to remove."
    exit 0
  fi
  command -v nginx >/dev/null 2>&1 || refuse "nginx is not installed on this host; there is nothing to reload"
  rm -f "$SNIPPET"
  set_include remove
  apply_and_reload
  say "  removed $SNIPPET and its include: /api/* is no longer proxied."
  say '  the site block and the static files are untouched.'
  exit 0
fi

# The validator prints its own REFUSED line and exits 2, but it runs in a command substitution, so
# that exit ends the subshell only. Without this the script would carry on with an empty origin and
# report some later, wrong refusal.
origin=$(proxy_origin "$UPSTREAM") || exit 2


if [ "$DRYRUN" = 1 ]; then
  say '  DRY RUN - nothing configured. What this run would do on this host:'
  say "    site       $SITE_NAME (http://127.0.0.1:$WEB_PORT/)"
  say "    upstream   $origin"
  say '    proxy      a location /api/ block with proxy_pass to that origin, SNI on'
  say '               so the certificate matches the host, not an IP'
  say "    rule       $SNIPPET, included from $CONF (survives install-web9999.sh replacing files)"
  say '    match      location /api/  (path preserved, /api/... forwarded unchanged)'
  say "    action     proxy_pass $origin  (query string kept)"
  say '    headers    Host and Referer set to the origin: measured, the live API answers 403'
  say '               to a caller whose referer names another host'
  say '    plan       every prefix this rule forwards, and where each one goes:'
  forward_plan "$origin" | sed 's/^/      /'
  say '    paths      the requests the page makes through that prefix:'
  forwarded_paths "$origin" | sed 's/^/      /'
  say '    static     not forwarded - served from the bundle, never from this rule:'
  printf '      %-26s -> %s\n' '/' 'index.html'
  printf '      %-26s -> %s\n' '/networks.json' 'networks.json'
  printf '      %-26s -> %s\n' '/web9999/networks.json' 'the same file, for a page that asks for the absolute path'
  say '    checks     nginx present, the site block exists, the upstream answers JSON (before any change)'
  say "    then       GET http://127.0.0.1:$WEB_PORT/api/web9999/coins and report what came back"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || refuse "this must run as root to write $SNIPPET_DIR and reload nginx"
command -v nginx >/dev/null 2>&1 || refuse 'nginx is not installed on this host; the rule cannot be added.'
[ -f "$CONF" ] || refuse "no nginx server block at $CONF; install the site first (install-web9999.sh)"
probe_upstream "$origin"

say "  writing $SNIPPET"
write_snippet "$origin"
set_include add
apply_and_reload
say '  nginx reloaded with the rule in place'

hdr=$(mktemp); body=$(mktemp)
say "  checking through the proxy: http://127.0.0.1:$WEB_PORT/api/web9999/coins"
status=$(curl -sS --max-time 25 -D "$hdr" -o "$body" -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/web9999/coins" 2>/dev/null || echo 000)
ctype=$(grep -i '^content-type:' "$hdr" | head -1 | cut -d: -f2- | tr -d '\r' || true)
if why=$(classify_answer "$status" "$ctype" "$(cat "$body" 2>/dev/null)"); then
  say "  proxying   /api/* answers $status $(printf '%s' "$ctype" | tr -d '\r'), $(wc -c < "$body" | tr -d ' ') bytes"
else
  say "  the rule IS installed and /api/ is proxied to $origin, but the through-proxy check failed: $why"
  say '  the site, the upstream, its certificate, or the DNS on this host is what to check - not the rule.'
  rm -f "$hdr" "$body"
  exit 1
fi
rm -f "$hdr" "$body"
say '  If the page still shows nothing, check the browser console for the request it made.'
