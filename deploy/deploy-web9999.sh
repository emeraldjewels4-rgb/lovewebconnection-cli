#!/usr/bin/env bash
# Deploys the web9999 page to a Linux host in one command: build the bundle, copy it and the two
# installers over, then run them - the same contract as deploy-web9999.ps1 on the Windows side.
#
#   ./deploy-web9999.sh --upstream https://fiatgod.x10.mx --dry-run   # what it would change
#   ./deploy-web9999.sh --upstream https://fiatgod.x10.mx             # loopback bind (adopted)
#   ./deploy-web9999.sh --upstream https://fiatgod.x10.mx --bind 0.0.0.0 --allow-rebind
#
# --upstream is required for a real run: without it the page ships with /api/* answering 404 on the
# host, so the run is refused before anything is built or uploaded. --dry-run is the exception - it
# builds the bundle, prints the exact commands, and marks the rails as not proxied.
#
# --bind left out means "whatever the site already is": the driver reads the listen line from the
# remote server block and asks the installer for that, so a routine deploy is not an exposure change.
# A change needs --allow-rebind, because the installer refuses to move a site between loopback and
# public on its own.
#
# The login account must be able to write /etc/nginx and reload nginx - both installers check that
# themselves and refuse with exit 2 if they cannot, which this driver reports as a failed step.
#
# Exit codes: 0 done, 1 the through-proxy check did not answer JSON, 2 refused (nothing built).
set -uo pipefail

UPSTREAM=""
BIND=""
WEB_PORT=8782
SITE_NAME=web9999
ROOT=""
HOST=""
USER_NAME=""
SSH_PORT=22
KEY_FILE=""
BUNDLE=""
ALLOW_REBIND=0
DRYRUN=0
SELFTEST=0

say() { printf '%s\n' "$*"; }
refuse() { printf '  REFUSED: %s\n' "$*" >&2; exit 2; }

usage() {
  cat <<'EOF'
usage: deploy-web9999.sh [options]

  --upstream URL            the x10 origin /api/* is proxied to (required unless --dry-run)
  --bind 127.0.0.1|0.0.0.0  how the site is reachable (default: whatever it already is)
  --allow-rebind            permit a run that changes the site's exposure
  --web-port N              port to listen on (default 8782)
  --site-name NAME          nginx server block name (default web9999)
  --root PATH               site directory on the host (default: the installer's /srv/web9999)
  --host HOST               the Linux host (required)
  --user NAME               login account (default: $USER)
  --ssh-port N              SSH port (default 22)
  --key-file PATH           identity file; default keys are used otherwise
  --bundle PATH             use this zip instead of building one
  --dry-run                 build, print the commands, upload nothing
  --selftest                prove the planner on this machine, touch nothing
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --upstream) UPSTREAM=${2:-}; shift 2 ;;
    --bind) BIND=${2:-}; shift 2 ;;
    --allow-rebind) ALLOW_REBIND=1; shift ;;
    --web-port) WEB_PORT=${2:-}; shift 2 ;;
    --site-name) SITE_NAME=${2:-}; shift 2 ;;
    --root) ROOT=${2:-}; shift 2 ;;
    --host) HOST=${2:-}; shift 2 ;;
    --user) USER_NAME=${2:-}; shift 2 ;;
    --ssh-port) SSH_PORT=${2:-}; shift 2 ;;
    --key-file) KEY_FILE=${2:-}; shift 2 ;;
    --bundle) BUNDLE=${2:-}; shift 2 ;;
    --dry-run) DRYRUN=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) refuse "unknown option '$1'; run --help" ;;
  esac
done

[ -z "$USER_NAME" ] && USER_NAME=${USER:-$(id -un)}
case "$SSH_PORT" in ''|*[!0-9]*) refuse "--ssh-port '$SSH_PORT' is not a port; use 1-65535" ;; esac
[ "$SSH_PORT" -ge 1 ] && [ "$SSH_PORT" -le 65535 ] || refuse "--ssh-port '$SSH_PORT' is not a port; use 1-65535"
case "$WEB_PORT" in ''|*[!0-9]*) refuse "--web-port '$WEB_PORT' is not a port; use 1-65535" ;; esac
[ "$WEB_PORT" -ge 1 ] && [ "$WEB_PORT" -le 65535 ] || refuse "--web-port '$WEB_PORT' is not a port; use 1-65535"
case "$BIND" in
  ''|127.0.0.1|0.0.0.0) ;;
  *) refuse "--bind '$BIND' is not an address; use 127.0.0.1 or 0.0.0.0, or leave it out to adopt the site's" ;;
esac

# Scheme, host, optional subdirectory - no query, no fragment, no traversal. The path is kept in front
# of /api/{R:1}, so an origin mounted under one serves the same rails through the same rule.
valid_upstream() {
  local text=$1 path
  [ -n "$text" ] || { printf 'no upstream given: pass --upstream https://<your x10 host>'; return 1; }
  case "$text" in https://*) ;; *) printf "upstream must be https://, got '%s' - plain http would put the API password in the clear" "$text"; return 1 ;; esac
  case "$text" in *\?*) printf "upstream must not carry a query string, got '%s'" "$text"; return 1 ;; esac
  case "$text" in *'#'*) printf "upstream must not carry a fragment, got '%s'" "$text"; return 1 ;; esac
  case "$text" in */./*|*/../*|*/.|*/..) printf "upstream must not carry . or .. segments, got '%s'" "$text"; return 1 ;; esac
  case "$text" in https://*/|https://*//*|https://) ;; esac
  local authority=${text#https://}
  authority=${authority%%/*}
  [ -n "$authority" ] || { printf "upstream '%s' has no host" "$text"; return 1; }
  path=${text#https://$authority}
  path=${path%/}
  case "$path" in
    '') ;;
    /*) case "${path#/}" in *[!A-Za-z0-9._/~-]*) printf "upstream path must be plain segments, got '%s'" "$text"; return 1 ;; esac ;;
    *) printf "upstream '%s' is not a URL" "$text"; return 1 ;;
  esac
  printf '%s://%s%s' https "$authority" "$path"
}

# The address an nginx listen line names, or nothing when there is no block yet. "listen 8782;" (no
# address) means every interface in nginx; the installers never write that form.
bind_of_listen() {
  local line=$1 addr
  [ -n "$line" ] || return 1
  addr=${line#*listen}
  addr=${addr%%;*}
  addr=$(printf '%s' "$addr" | tr -d '[:space:]')
  case "$addr" in
    *:* ) printf '%s' "${addr%:*}" ;;
    * ) printf '0.0.0.0' ;;
  esac
}

if [ "$SELFTEST" = 1 ]; then
  checks=0; failures=0
  chk() {
    checks=$((checks + 1))
    [ "$2" = "$3" ] || { failures=$((failures + 1)); printf '  FAIL %s (got %s, expected %s)\n' "$1" "$2" "$3"; }
  }
  chk 'a bare https origin is accepted' "$(valid_upstream https://account.x10.mx)" 'https://account.x10.mx'
  chk 'a trailing slash is dropped' "$(valid_upstream https://account.x10.mx/)" 'https://account.x10.mx'
  chk 'a subdirectory is kept' "$(valid_upstream https://fiatgod.x10.mx/web9999-interface)" 'https://fiatgod.x10.mx/web9999-interface'
  chk 'plain http is refused' "$(valid_upstream http://account.x10.mx >/dev/null 2>&1; echo $?)" '1'
  chk 'a query string is refused' "$(valid_upstream 'https://a.x10.mx/x?y=1' >/dev/null 2>&1; echo $?)" '1'
  chk 'a traversal segment is refused' "$(valid_upstream https://a.x10.mx/../etc >/dev/null 2>&1; echo $?)" '1'
  chk 'nothing is refused' "$(valid_upstream '' >/dev/null 2>&1; echo $?)" '1'
  # The adoption rule is what keeps a routine deploy from being an exposure change.
  chk 'a loopback listen is read back' "$(bind_of_listen '    listen 127.0.0.1:8782;')" '127.0.0.1'
  chk 'a public listen is read back' "$(bind_of_listen '    listen 0.0.0.0:8782;')" '0.0.0.0'
  chk 'no block means no address' "$(bind_of_listen '' >/dev/null 2>&1; echo $?)" '1'
  say "  deploy selftest PASSED ($checks checks)"
  [ "$failures" -eq 0 ] || { say "  deploy selftest FAILED ($failures)"; exit 1; }
  exit 0
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -p "$SSH_PORT")
SCP_OPTS=(-o StrictHostKeyChecking=accept-new -P "$SSH_PORT")
if [ -n "$KEY_FILE" ]; then SSH_OPTS+=(-i "$KEY_FILE"); SCP_OPTS+=(-i "$KEY_FILE"); fi
REMOTE="$USER_NAME@$HOST"
REMOTE_CONF="/etc/nginx/conf.d/$SITE_NAME.conf"

# The installer's own flags, in the order its usage lists them. --allow-rebind is passed through only
# when the operator asked for it, so the driver can never make an exposure change by itself.
install_args() {
  local bind=$1 out
  out="--bind $bind --web-port $WEB_PORT --site-name $SITE_NAME"
  [ -n "$ROOT" ] && out="$out --root $ROOT"
  [ "$ALLOW_REBIND" = 1 ] && out="$out --allow-rebind"
  printf '%s' "$out"
}

# What the host's server block says today, or nothing. Read over ssh rather than guessed, because the
# whole point of adopting is that this machine does not know the answer.
remote_listen() {
  ssh "${SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" \
    "grep -m1 -E '^[[:space:]]*listen[[:space:]]' $REMOTE_CONF 2>/dev/null" 2>/dev/null
}

# One round trip before anything expensive: a refused login that surfaces only at scp time wastes a
# bundle build and reports the wrong thing.
login_preflight() {
  local out code said
  out=$(ssh "${SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" 'echo preflight-ok' 2>&1); code=$?
  [ "$code" -eq 0 ] && return 0
  said=$(printf '%s' "$out" | head -2 | tr '\n' ' ')
  case "$said" in
    *"Permission denied"*)
      refuse "$REMOTE on port $SSH_PORT refused the credential - the key or the account, not the network. ssh said: $said" ;;
    *"Could not resolve"*|*"Name or service not known"*)
      refuse "cannot resolve $HOST; check --host. ssh said: $said" ;;
    *"Connection refused"*)
      refuse "nothing is listening on $HOST port $SSH_PORT; check --ssh-port" ;;
    *"timed out"*|*"No route to host"*|*"Connection closed"*)
      refuse "$REMOTE did not answer within 10s - the host or the port is filtered. ssh said: $said" ;;
    *)
      refuse "the login preflight failed (ssh exit $code). ssh said: $said" ;;
  esac
}

[ -n "$HOST" ] || refuse "--host is required: the Linux box to deploy to (a hostname or IP)"
if [ -n "$UPSTREAM" ]; then
  origin=$(valid_upstream "$UPSTREAM") || refuse "$origin"
elif [ "$DRYRUN" = 1 ]; then
  origin=""
else
  refuse "--upstream is required - without it the page ships with /api/* answering 404 on the server, so nothing was built."
fi

# The bundle is the expensive part - a staging copy and a zip - so a real run proves the credential and
# reads the current binding first, and only then builds. That is the same order as the Windows driver:
# a dead port costs one ssh and ten seconds, not a build.
build_bundle() {
  if [ -n "$BUNDLE" ]; then
    [ -f "$BUNDLE" ] || refuse "bundle not found: $BUNDLE"
    return 0
  fi
  command -v zip >/dev/null 2>&1 || refuse "zip is not installed on this machine, so the bundle cannot be built; install zip, or pass --bundle with an existing web9999-site.zip"
  local stage
  stage=$(mktemp -d) || refuse "cannot create a temporary directory"
  [ -f web9999/index.html ] || { rm -rf "$stage"; refuse "web9999/index.html is missing from this checkout"; }
  [ -f web9999/networks.json ] || { rm -rf "$stage"; refuse "web9999/networks.json is missing; run node deploy/networks.mjs"; }
  cp web9999/index.html "$stage/" || { rm -rf "$stage"; refuse "cannot stage index.html"; }
  cp web9999/networks.json "$stage/" || { rm -rf "$stage"; refuse "cannot stage networks.json"; }
  # api/ sits at the project root, not under web9999/ - and it is not optional: without it the page
  # ships with every /api/* read finding nothing, which looks like a broken database, not a bad bundle.
  [ -d api ] || { rm -rf "$stage"; refuse "api/ is missing from this checkout; the bundle would ship a page whose /api/* reads find nothing"; }
  cp -r api "$stage/api" || { rm -rf "$stage"; refuse "cannot stage api/"; }
  [ -f deploy/serve.mjs ] && cp deploy/serve.mjs "$stage/"
  BUNDLE="$PWD/deploy/web9999-site.zip"
  rm -f "$BUNDLE"
  # -X drops the extra fields that make two builds of the same tree differ byte for byte.
  ( cd "$stage" && zip -q -r -X "$BUNDLE" . ) || { rm -rf "$stage"; refuse "zip failed on the staged bundle"; }
  rm -rf "$stage"
  unzip -l "$BUNDLE" 2>/dev/null | grep -q 'networks.json' || refuse "the bundle has no networks.json beside index.html; the page's chain table would read as missing"
  # Checked on the archive, not the stage: this is the check that would have caught the driver staging
  # nothing from a path that does not exist, which produced a bundle that installed cleanly and served
  # a page whose every read 404s.
  unzip -l "$BUNDLE" 2>/dev/null | grep -q 'api/web9999/' || refuse "the bundle has no api/ tree; the page's rails would answer 404 behind the proxy"
}

if [ "$DRYRUN" = 0 ]; then login_preflight; fi

if [ -n "$BIND" ]; then
  bind=$BIND; bind_note="as asked"
else
  listen=$(remote_listen); rl=$?
  if bind=$(bind_of_listen "$listen"); then
    bind_note="adopted from $REMOTE_CONF"
  else
    bind=127.0.0.1
    # Two different nothings: no block on the host (first install) and no answer from the host (the
    # probe itself failed). Saying "first install" for a dead ssh would be a lie the dry run can check.
    if [ "$rl" -ne 0 ]; then
      bind_note="could not ask the host (ssh failed) - a real run adopts it there; loopback is the default here"
    else
      bind_note="first install (no server block on the host); loopback unless --bind says otherwise"
    fi
  fi
fi

build_bundle

say '  DRY RUN - nothing uploaded. What this run would do:' 2>/dev/null || true
if [ "$DRYRUN" = 1 ]; then
  say "    host       $REMOTE on port $SSH_PORT"
  say "    bundle     $BUNDLE ($(wc -c < "$BUNDLE" | tr -d ' ') bytes)"
  say "    bind       $bind - $bind_note"
  if [ -n "$origin" ]; then
    say "    upstream   $origin (rails proxied, /api/* forwarded here)"
  else
    say '    upstream   none given - rails: NOT proxied, and a real run without one is refused'
  fi
  say '    steps      1 install-web9999.sh   2 proxy-web9999.sh   3 read /api/web9999/coins back'
  say '    These are the exact commands:'
  say "      scp ${SCP_OPTS[*]} $BUNDLE $REMOTE:~/web9999-site.zip"
  say "      scp ${SCP_OPTS[*]} deploy/install-web9999.sh $REMOTE:~/install-web9999.sh"
  say "      scp ${SCP_OPTS[*]} deploy/proxy-web9999.sh $REMOTE:~/proxy-web9999.sh"
  say "      ssh ${SSH_OPTS[*]} $REMOTE 'bash ~/install-web9999.sh $(install_args "$bind")'"
  if [ -n "$origin" ]; then
    say "      ssh ${SSH_OPTS[*]} $REMOTE 'bash ~/proxy-web9999.sh --upstream $origin --web-port $WEB_PORT --site-name $SITE_NAME'"
  else
    say "      ssh ${SSH_OPTS[*]} $REMOTE 'bash ~/proxy-web9999.sh --upstream https://<x10 host> --web-port $WEB_PORT'"
    say '    (no proxy run printed as final: --upstream was not given, and a real deploy without it is refused)'
  fi
  say "      ssh ${SSH_OPTS[*]} $REMOTE 'curl -sS -o /dev/null -w \"%{http_code} %{content_type}\" http://127.0.0.1:$WEB_PORT/api/web9999/coins'"
  say "    then       GET http://127.0.0.1:$WEB_PORT/api/web9999/coins on the host and report what came back"
  exit 0
fi

say "  uploading to $REMOTE on port $SSH_PORT"
scp "${SCP_OPTS[@]}" "$BUNDLE" "$REMOTE:~/web9999-site.zip" || refuse "scp of the bundle failed"
scp "${SCP_OPTS[@]}" deploy/install-web9999.sh "$REMOTE:~/install-web9999.sh" || refuse "scp of the installer failed"
scp "${SCP_OPTS[@]}" deploy/proxy-web9999.sh "$REMOTE:~/proxy-web9999.sh" || refuse "scp of the proxy script failed"

args=$(install_args "$bind")
say "  installing: install-web9999.sh $args"
ssh "${SSH_OPTS[@]}" "$REMOTE" "bash ~/install-web9999.sh $args"
inst=$?
if [ "$inst" -ne 0 ]; then
  say ''
  say "  FAILED: install-web9999.sh exited $inst on the host - read its REFUSED line above."
  say "  nothing was proxied; re-run once that is addressed."
  exit 2
fi

say "  proxying: proxy-web9999.sh --upstream $origin"
ssh "${SSH_OPTS[@]}" "$REMOTE" "bash ~/proxy-web9999.sh --upstream $origin --web-port $WEB_PORT --site-name $SITE_NAME"
prox=$?
if [ "$prox" -ne 0 ]; then
  say ''
  say "  FAILED: proxy-web9999.sh exited $prox - the site is installed but /api/* is not forwarded."
  say "  the rule and its checks are described in the script's output above."
  exit 1
fi

say '  checking through the proxy'
answer=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "curl -sS -m 20 -o /dev/null -w '%{http_code} %{content_type}' http://127.0.0.1:$WEB_PORT/api/web9999/coins 2>/dev/null || echo '000 none'" 2>/dev/null)
say "    $answer"
case "$answer" in
  *application/json*)
    say "  done: /api/web9999/coins answers JSON through the proxy on $HOST:$WEB_PORT" ;;
  *)
    say ''
    say "  NOT CONFIGURED: the proxied request did not get JSON back ($answer)."
    say '  the site and the rule are in place, so compare the two ends:'
    say "    ssh ${SSH_OPTS[*]} $REMOTE 'curl -sS $origin/api/web9999/coins'   # the origin itself"
    say "    ssh ${SSH_OPTS[*]} $REMOTE 'tail -20 /var/log/nginx/error.log'"
    exit 1 ;;
esac
