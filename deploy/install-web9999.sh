#!/usr/bin/env bash
# Installs the web9999 page on this host as an nginx server block on a port, bound either to
# loopback (for SSH tunnelling) or to every interface (public).
#
#   --bind 127.0.0.1    default. The site answers on the host's own loopback only; reach it with
#                       ssh -N -L 8782:127.0.0.1:8782 user@server and browse http://127.0.0.1:8782/
#   --bind 0.0.0.0      every interface, with the firewall opened: http://server:8782/
#
# This is the nginx counterpart of install-web9999.ps1 and keeps its contract: the same flags, the
# same dry-run block, the same exposure gate, and one REFUSED line with exit 2 when a run would
# change how the site is reachable without --allow-rebind.
#
#   ./install-web9999.sh --dry-run
#   ./install-web9999.sh --bind 0.0.0.0
#   ./install-web9999.sh --bind 0.0.0.0 --allow-rebind
#   ./install-web9999.sh --no-clobber
#   ./install-web9999.sh --selftest
#
# Exit codes: 0 done, 1 the selftest failed, 2 refused (nothing was changed: no files, no server
# block, no firewall rule).
#
# Unlike the IIS installer this does not need a runtime: nginx serves the page from disk. It writes
# one server block, /etc/nginx/conf.d/<site>.conf, and reloads nginx only after `nginx -t` passes.
set -uo pipefail

BIND=127.0.0.1
WEB_PORT=8782
ROOT=/srv/web9999
SITE_NAME=web9999
NOCLOBBER=0
ALLOW_REBIND=0
DRYRUN=0
SELFTEST=0
PRINTCONF=0
CONF_DIR=/etc/nginx/conf.d
ZIP=""
PROG=$(basename "$0")

# stderr, not stdout: the gate runs inside $(...) in some callers, and a message captured into a
# variable is a message the operator never sees.
refuse() { printf '  REFUSED: %s\n' "$*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
usage: install-web9999.sh [options]

  --bind 127.0.0.1|0.0.0.0   how the site is reachable (default 127.0.0.1)
  --web-port N               port to listen on (default 8782)
  --root PATH                site directory (default /srv/web9999)
  --zip PATH                 bundle to install (default ~/web9999-site.zip)
  --site-name NAME           server block file name (default web9999)
  --no-clobber               keep server files newer than the bundle, delete nothing
  --allow-rebind             permit a run that changes the site's exposure
  --dry-run                  print what would change, change nothing
  --selftest                 prove the planner and the gate on this host, touch nothing
    --print-conf               print the server block it would write to stdout, then exit
                               (no root, no writes) - check it with nginx -t
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bind) BIND=${2:-}; shift 2 ;;
    --web-port) WEB_PORT=${2:-}; shift 2 ;;
    --root) ROOT=${2:-}; shift 2 ;;
    --zip) ZIP=${2:-}; shift 2 ;;
    --site-name) SITE_NAME=${2:-}; shift 2 ;;
    --no-clobber) NOCLOBBER=1; shift ;;
    --allow-rebind) ALLOW_REBIND=1; shift ;;
    --dry-run) DRYRUN=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
      --print-conf) PRINTCONF=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) refuse "unknown option '$1'; run --help" ;;
  esac
done

[ -z "$ZIP" ] && ZIP="$HOME/web9999-site.zip"
CONF="$CONF_DIR/$SITE_NAME.conf"

case "$BIND" in
  127.0.0.1) nginx_listen="127.0.0.1:$WEB_PORT" ;;
  0.0.0.0)   nginx_listen="0.0.0.0:$WEB_PORT" ;;
  *) refuse "--bind '$BIND' is not an address; use 127.0.0.1 or 0.0.0.0, or leave it out to adopt the site's" ;;
esac
[ "$WEB_PORT" -ge 1 ] 2>/dev/null && [ "$WEB_PORT" -le 65535 ] || refuse "--web-port '$WEB_PORT' is not a port; use 1-65535"

is_public() { [ "$BIND" = "0.0.0.0" ]; }

# What the server block says today: "<address> <port>", or nothing when there is no block yet.
# Read from the file rather than from a running nginx, so this works for a stopped or absent nginx
# and for --dry-run on a laptop.
current_listen() {
  [ -f "$CONF" ] || return 1
  local line
  line=$(grep -E '^[[:space:]]*listen[[:space:]]' "$CONF" | head -1 || true)
  [ -n "$line" ] || return 1
  line=${line#*listen}
  line=${line%%;*}
  line=$(printf '%s' "$line" | tr -d '[:space:]')
  printf '%s\n' "$line"
}

# The effects a change of exposure has, one line each, in the same words the PowerShell installer
# uses: what would close, what would open, and which firewall rule carries it.
exposure_effects() {
  local current=$1 wanted=$2 cur_addr cur_port
  cur_addr=${current%%:*}
  cur_port=${current##*:}
  if [ "$cur_port" != "$WEB_PORT" ]; then
    printf 'close   http://%s:%s/  (removes listen %s)\n' "$cur_addr" "$cur_port" "$current"
    printf 'open    http://%s:%s/  (adds listen %s)\n' "${wanted%%:*}" "$WEB_PORT" "$wanted"
    return
  fi
  if [ "$cur_addr" != "${wanted%%:*}" ]; then
    printf 'close   http://%s:%s/  (removes listen %s)\n' "$cur_addr" "$cur_port" "$current"
    printf 'open    http://%s:%s/  (adds listen %s)\n' "${wanted%%:*}" "$WEB_PORT" "$wanted"
  fi
  if is_public && [ "$cur_addr" = "127.0.0.1" ]; then
    printf "open    inbound TCP %s  (adds firewall rule 'web9999 %s')\n" "$WEB_PORT" "$WEB_PORT"
  fi
  if ! is_public && [ "$cur_addr" = "0.0.0.0" ]; then
    printf "close   inbound TCP %s  (removes firewall rule 'web9999 %s')\n" "$WEB_PORT" "$WEB_PORT"
  fi
}

# Would this run change how the site is reachable? Only an existing block on this port can be a
# change: a first install has nothing to adopt, so it may bind either way without --allow-rebind.
exposure_differs() {
  local current=$1 wanted=$2
  [ -n "$current" ] || return 1
  [ "$current" != "$wanted" ]
}

# Firewall, only where ufw is the thing managing it. A host without ufw keeps whatever rules it
# has - this script does not invent a firewall.
firewall_public_apply() {
  if ! is_public; then
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "^${WEB_PORT}"; then
      ufw --force delete allow "$WEB_PORT"/tcp >/dev/null 2>&1 || true
      say "    firewall   closed inbound TCP $WEB_PORT"
    fi
    return
  fi
  if command -v ufw >/dev/null 2>&1; then
    ufw allow "$WEB_PORT"/tcp >/dev/null 2>&1 || refuse "ufw refused to open inbound TCP $WEB_PORT"
    say "    firewall   opened inbound TCP $WEB_PORT"
  else
    say "    firewall   left alone (no ufw on this host; open $WEB_PORT yourself if it is firewalled)"
  fi
}

render_conf() {
  # The block as it would be written, on stdout. --print-conf prints this and write_conf redirects it
  # at the file, so there is one description of the block and nothing to drift.
  local proxy_include="# proxy: absent"
  [ -f "/etc/nginx/snippets/web9999-api-proxy.conf" ] && proxy_include="include /etc/nginx/snippets/web9999-api-proxy.conf;"
  echo "# managed by deploy/install-web9999.sh - edits are overwritten on the next install"
  echo "server {"
  echo "    listen $nginx_listen;"
  echo "    server_name _;"
  echo "    root $ROOT;"
  echo "    index index.html;"
  echo "    server_tokens off;"
  echo ""
  echo "    location / { try_files \$uri \$uri/ =404; }"
  echo ""
  echo "    # generated, and fetched relatively by the page: a cached copy is a stale chain table"
  echo "    location = /networks.json         { add_header Cache-Control \"no-cache\"; }"
  echo ""
  echo "    # /api/* is forwarded by proxy-web9999.sh; this line is its only attachment point"
  echo "    $proxy_include"
  echo "}"
}

write_conf() {
  mkdir -p "$CONF_DIR" || refuse "cannot create $CONF_DIR"
  render_conf > "$CONF.tmp" || refuse "cannot write $CONF"
  mv "$CONF.tmp" "$CONF" || refuse "cannot replace $CONF"
}

# Replace: empty the directory, then expand, so a file dropped from the bundle disappears.
# --no-clobber: unpacks beside the old files and keeps any the bundle is not newer than.
install_bundle() {
  command -v unzip >/dev/null 2>&1 || refuse "unzip is not installed on this host; the bundle cannot be expanded"
  mkdir -p "$ROOT" || refuse "cannot create $ROOT"
  if [ "$NOCLOBBER" = 1 ]; then
    local report wrote
    report=$(unzip -n "$ZIP" -d "$ROOT" 2>&1) || refuse "unzip failed on $ZIP"
    wrote=$(printf '%s\n' "$report" | grep -c 'extracting' || true)
    say "    files      kept every file newer than the bundle, deleted nothing; wrote $wrote"
  else
    find "$ROOT" -mindepth 1 -delete 2>/dev/null || refuse "cannot empty $ROOT"
    unzip -q -o "$ZIP" -d "$ROOT" || refuse "unzip failed on $ZIP"
    say "    files      replaced everything under $ROOT"
  fi
}

# ---------------------------------------------------------------- selftest

selftest() {
  local failures=0 total=0
  check() {
    total=$((total + 1))
    if [ "$2" = "$3" ]; then return 0; fi
    failures=$((failures + 1))
    printf '  FAIL %s (got %s, expected %s)\n' "$1" "$2" "$3"
  }
  check 'loopback and public differ' "$(exposure_differs '127.0.0.1:8782' '0.0.0.0:8782' && echo differs)" 'differs'
  check 'the same listen is not a change' "$(exposure_differs '127.0.0.1:8782' '127.0.0.1:8782' && echo differs || echo same)" 'same'
  check 'first install is not a change' "$(exposure_differs '' '127.0.0.1:8782' && echo differs || echo same)" 'same'
  # loopback -> public is three effects, the same list the PowerShell installer prints: close the
  # loopback bind, open the public one, open the firewall that makes it reachable at all.
  check 'loopback to public is close, open bind, open firewall' \
    "$(BIND=0.0.0.0; WEB_PORT=8782; exposure_effects '127.0.0.1:8782' '0.0.0.0:8782' | wc -l | tr -d ' ')" '3'
  check 'and it names the firewall rule' \
    "$(BIND=0.0.0.0; WEB_PORT=8782; exposure_effects '127.0.0.1:8782' '0.0.0.0:8782' | grep -c "adds firewall rule")" '1'
  check 'loopback effect closes a public port' \
    "$(BIND=127.0.0.1; WEB_PORT=8782; exposure_effects '0.0.0.0:8782' '127.0.0.1:8782' | grep -c '^close   inbound')" '1'
  local tmp
  tmp=$(mktemp -d)
  printf 'server {\n    listen 127.0.0.1:8782;\n}\n' > "$tmp/$SITE_NAME.conf"
  CONF_DIR=$tmp
  check 'current listen is read from the block' "$(CONF_DIR=$tmp CONF="$tmp/$SITE_NAME.conf" current_listen)" '127.0.0.1:8782'
  rm -rf "$tmp"

    # The rendered block is what lands on the host, so it is asserted here as text: the listen line
    # the flags asked for, and the one file that must never be cached.
    check 'the rendered block listens where the flags asked' "$(nginx_listen=0.0.0.0:8782 ROOT=/srv/web9999 render_conf | grep -c '^    listen 0.0.0.0:8782;')" '1'
    check 'and serves networks.json with no-cache' "$(nginx_listen=127.0.0.1:8782 ROOT=/srv/web9999 render_conf | grep -c 'location = /networks.json.*no-cache')" '1'
    check 'and keeps exactly one /api/ attachment point' "$(nginx_listen=127.0.0.1:8782 ROOT=/srv/web9999 render_conf | grep -c 'proxy: absent')" '1'
  if [ "$failures" -eq 0 ]; then
    say "  install selftest PASSED ($total checks)"
    exit 0
  fi
  say "  install selftest FAILED ($failures)"
  exit 1
}

if [ "$SELFTEST" = 1 ]; then selftest; fi
case "$ROOT" in
  ''|/|/etc|/usr|/var|/home) refuse "--root '$ROOT' is not a site directory; point it at a directory the bundle may own" ;;
esac
# Rendering is not installing: print the block and leave, before the root check, before the bundle,
# and before anything is written - this is what makes the file checkable with nginx -t off the host.
if [ "$PRINTCONF" = 1 ]; then render_conf; exit 0; fi
if [ "$DRYRUN" = 0 ] && [ "$(id -u)" -ne 0 ]; then refuse "this must run as root to write $CONF_DIR and touch the firewall"; fi
if [ "$DRYRUN" = 0 ] && ! command -v nginx >/dev/null 2>&1; then refuse "nginx is not installed on this host; install it, or run --dry-run to see the plan"; fi
[ -f "$ZIP" ] || refuse "bundle not found: $ZIP"

current=$(current_listen || true)
changed=0; exposure_differs "$current" "$nginx_listen" && changed=1
effects=""
if [ "$changed" = 1 ]; then effects=$(exposure_effects "$current" "$nginx_listen"); fi

if [ "$DRYRUN" = 1 ]; then
  say '  DRY RUN - nothing written. What this run would do on this host:'
  say "    root       $ROOT"
  say "    bundle     $ZIP ($(wc -c < "$ZIP" | tr -d ' ') bytes)"
  if [ -z "$current" ]; then bind_note='first install'; elif [ "$changed" = 1 ]; then bind_note='change of exposure'; else bind_note='as now'; fi
  say "    bind       $BIND:$WEB_PORT ($bind_note)"
  say "    nginx      $CONF, listen $nginx_listen, server_name _, try_files \$uri \$uri/ =404"
  if is_public; then say "    firewall   open inbound TCP $WEB_PORT"; else say "    firewall   untouched (loopback only)"; fi
  if [ "$NOCLOBBER" = 1 ]; then say '    files      keep any file newer than the bundle, delete nothing'; else say "    files      replace everything under $ROOT"; fi
  say "    local      http://127.0.0.1:$WEB_PORT/ (checked on the host either way)"
  if is_public; then say "    public     http://<this-host>:$WEB_PORT/"; else say "    public     none; browse through a tunnel: ssh -N -L $WEB_PORT:127.0.0.1:$WEB_PORT <user>@<server>"; fi
  if [ -z "$current" ]; then
    say '    current    nothing on this port yet'
    say '    exposure   unchanged (first install)'
  else
    say "    current    listen $current"
    if [ "$changed" = 0 ]; then
      say '    exposure   unchanged'
    elif [ "$ALLOW_REBIND" = 1 ]; then
      say '    exposure   changes, allowed by --allow-rebind:'
      printf '%s\n' "$effects" | sed 's/^/                 /'
    else
      say '    exposure   would change, and the real run would REFUSE without --allow-rebind:'
      printf '%s\n' "$effects" | sed 's/^/                 /'
    fi
  fi
  exit 0
fi

# The gate runs before a single file is written: a deploy that forgot --bind leaves the site exactly
# as it was and lists what it would have closed.
if [ "$changed" = 1 ] && [ "$ALLOW_REBIND" = 0 ]; then
  if is_public; then wanted_label='every interface (public)'; else wanted_label='127.0.0.1 (loopback only)'; fi
  say '  REFUSED: this run would change how the site is exposed, and --allow-rebind was not passed.'
  say "    wanted     $wanted_label on port $WEB_PORT"
  say '    this run would:'
  printf '%s\n' "$effects" | sed 's/^/      /'
  say '  nothing was changed: no files written, no server block or firewall rule touched.'
  say "  to switch it on purpose: --bind $BIND --allow-rebind"
  say '  to leave it alone: nothing; it was not touched.'
  exit 2
fi
if [ "$changed" = 1 ]; then
  say '  exposure is changing, as --allow-rebind allows:'
  printf '%s\n' "$effects" | sed 's/^/    /'
fi

say "  installing the bundle into $ROOT"
install_bundle
say "  writing $CONF"
write_conf
firewall_public_apply

nginx -t 2>/tmp/nginx-test.$$ || { cat /tmp/nginx-test.$$; rm -f /tmp/nginx-test.$$; refuse "nginx rejected the new configuration; $CONF was written but nginx was NOT reloaded"; }
rm -f /tmp/nginx-test.$$
if ! systemctl reload nginx 2>/dev/null; then
  reload_err=$(nginx -s reload 2>&1) || refuse "nginx reload failed: $reload_err"
fi
say '  nginx reloaded'

code=$(curl -sS -m 20 -o /tmp/w9.$$ -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/networks.json" 2>/dev/null || echo 000)
size=$(wc -c < /tmp/w9.$$ 2>/dev/null | tr -d ' ' || echo 0)
if [ "$code" = "200" ]; then
  say "  checked    http://127.0.0.1:$WEB_PORT/networks.json answered 200 ($size bytes)"
else
  say "  checked    http://127.0.0.1:$WEB_PORT/networks.json answered $code - the block is installed; check nginx -t and the port"
fi
rm -f /tmp/w9.$$
if [ -f /etc/nginx/snippets/web9999-api-proxy.conf ]; then
  say "  rails      /api/* is proxied (snippets/web9999-api-proxy.conf is included)"
else
  say '  rails      /api/* is NOT proxied: run proxy-web9999.sh --upstream https://<x10 host>'
fi
say '  If it does not answer, read the server log:'
say '    tail -20 /var/log/nginx/error.log'
say '    ss -lntp | grep '"$WEB_PORT"
