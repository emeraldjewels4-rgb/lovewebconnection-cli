# lwc explorer

A static, read-only explorer for the six chains built into
`lovewebconnection`: live preset health on the primary and fallback endpoints,
plus block, address, transaction, token and contract lookups.

Nothing here holds a key, signs, or sends a transaction. `rpc.php` accepts only
the ten read methods the page itself calls, only as `POST` with
`application/json`, and only from its own origin, then forwards them to the
endpoints in `presets.json`, primary first, then fallback. Bodies are capped at
8 KiB and answers at 1 MiB, which clears a block's hash list (about 80 bytes a
transaction) while still refusing an unbounded answer. Block lookups must ask for
those hashes: a full-transaction block is roughly twenty times the size
(541 KB against 28 KB for the same ethereum block) and the page never asks for
it, so `eth_getBlockByNumber` with anything but `false` as its second parameter
is refused. A per-address counter in the PHP — sixty calls a minute, the edge
rule's own number, one small locked file per address under the temp directory —
is a backstop for a forged `Origin`, not the plan: the cap on how fast a stranger can spend the quota
belongs at the edge — see
[Rate-limit the proxy at the edge](#rate-limit-the-proxy-at-the-edge).

The `/scan/` index deployed beside this explorer on the same host is a separate
app; its tables and restore steps are in [`../docs/scan-index.md`](../docs/scan-index.md).

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page shell. |
| `style.css` | Styles, matching the dark web9999 dashboard. |
| `app.js` | Probes the presets (reusing a probe from the last minute), renders the table, runs lookups (tokens read `name`, `symbol`, `decimals` and `totalSupply`; contracts read code and the EIP-1967 slots). |
| `presets.json` | Generated from `CHAIN_PRESETS`; do not edit by hand. |
| `rpc.php` | Same-origin read-only JSON-RPC proxy with failover. |
| `.htaccess` | No directory listing, the folder's own directory index, basic security headers. |

The document root's `.htaccess` is not in this folder and not in this repo: it
is shared with every other app on the host. The one rule the explorer needs from
it is in [Deploy to x10 / cPanel](#deploy-to-x10--cpanel).

## Regenerate the preset list

```sh
npm run explorer:data
```

Rerun this after changing `CHAIN_PRESETS` in `src/chain.ts`. The page and
`rpc.php` both read `presets.json`, so they cannot disagree.

## Shareable lookups

Every lookup is written into the address bar as `chain`, `type` and `q`, for
example `?chain=ethereum&type=token&q=0xA0b8…eB48`. Opening that URL selects the
chain and mode and runs the lookup on load. Each lookup is a history entry, so
browser back and forward move between them and re-run the one in the URL.
Lookups are sequence-guarded: a slow earlier response is discarded instead of
rendering over a newer one, and starting a lookup aborts the requests of the
previous one so only the newest stays in flight. The URL, lookup-lifecycle and
probe-cache helpers live in `lookup-state.js`, imported by `app.js` with a `?v=` query;
bump that query when the helper file changes. `src/explorer-state.test.ts`
covers both, and `src/explorer-browser.test.ts` drives the real page in a
headless Chrome, Edge or Chromium against a stub `rpc.php` that refuses the same
requests the real proxy refuses; it skips when no browser is installed unless
`CHROME_PATH` names one. `src/explorer-rpc.test.mjs`
checks the proxy's refusals themselves — wrong verb, wrong content type, a
foreign origin, an oversized body, a method outside the set, an oversized
answer — against a real `php -S` with a loopback HTTPS fixture; it skips when no
`php` binary is found unless `LWC_PHP` names one.

## Run locally

```sh
npm run explorer:data
php -S 127.0.0.1:8080 -t explorer
# http://127.0.0.1:8080/
```

PHP 8 with the curl extension is what the proxy expects. Without PHP, the page
falls back to calling the public endpoints directly; a browser will block any
endpoint that sends no CORS header.

## Deploy to x10 / cPanel

1. `npm run explorer:data`
2. In cPanel, open **File Manager**, go to `public_html`, create `explorer/`.
3. Upload `index.html`, `style.css`, `app.js`, `lookup-state.js`, `presets.json`,
   `rpc.php` and `.htaccess` (turn on **Settings → Show Hidden Files** so
   `.htaccess` is visible). `app.js` imports `lookup-state.js`, so leaving it
   out leaves the page dead.
4. Open `https://<your-domain>/explorer/`.

`npm run explorer:zip` builds `explorer-x10-upload.zip` from those seven files
for a drag-and-drop upload: extract it in `public_html/explorer`, with hidden
files shown, then delete the zip. The archive is gitignored, so it is built when
wanted; `npm run explorer:zip:check` fails if an existing copy no longer matches
the folder, and the pre-commit hook runs that check when one is present, because
a stale zip uploads a page the checkout no longer has.

`deploy/explorer-sftp-ship.mjs` is the upload-and-check route when the host has
an SFTP login and a key: it sends `index.html`, `app.js`, `style.css` and
`rpc.php` to `--remote-dir` (default `public_html/explorer`), then runs
`deploy/explorer-check.mjs` against `--base` and fails if any check does. It
does not send `lookup-state.js`, `presets.json` or `.htaccess`; use the zip or
the file manager when one of those changes. `--dry-run` prints the batch and
the check command without connecting.

Step 4 also needs a line in the document root's `.htaccess`. This host answers a
request for an existing directory with its dashboard (`/assets/` behaves the
same way), because `RewriteCond %{REQUEST_FILENAME} -d` followed by
`RewriteRule . /index.html [L]` runs before the folder's own `DirectoryIndex`:
that is why `/explorer/` used to serve the dashboard while
`/explorer/index.html` served the explorer. The explorer therefore gets a rule
of its own beside `^scan/?$` and `^exchange/?$`, ahead of the directory rule:

```apache
RewriteRule ^explorer/?$ explorer/index.html [L]
```

That file is shared with every other app on the document root, so this repo does
not keep a copy of it; the line is added by hand in cPanel → **File Manager**
(**Settings → Show Hidden Files**), and re-applied by hand if someone redeploys
the root file. The folder's own `.htaccess` still pins `DirectoryIndex` as a
fallback for hosts whose root does not rewrite, but on this one the root rule
answers first and the folder file never gets the request.

With the line in place, every check in `npm run explorer:check` passes. Without
it, checks 2 and 3 stay red — check 2 reporting the served page's text against
the checkout's, line endings and final newline included, check 3 because that
page never asks for `app.js?v=8` — while checks 1 and 4-11 pass. That is the
signature of a routing miss, not a failed upload, and
`deploy/explorer-sftp-ship.mjs` reports it that way. If
`/explorer/` is still the dashboard after the line is in, look for a 500 at that
URL (the host rejects `RewriteRule` in `.htaccess` when `AllowOverride` leaves
out `FileInfo`) and re-upload with hidden files shown.

The next section uploads the same seven files over SSH from a shell instead.

`deploy/explorer-ftp-upload.mjs` can push the same seven files with curl when a
host has an FTPS login and a shell. It is optional: the file manager steps above
are the documented route, and the script's own `--help` says so. It requires
explicit FTPS (`--ssl-reqd`, with no opt-out), so a server that cannot do TLS is
refused instead of accepting the password in the clear.

`index.html` loads `app.js?v=8`. The parent site marks `.js` files immutable for
a year, so bump that number whenever `app.js` changes; otherwise a browser that
loaded the old script keeps running it.

If the page says `presets.json` cannot be loaded, confirm it was uploaded as
`application/json` and not HTML. If `rpc.php` downloads instead of running,
select **PHP 8.x** for the account and make sure the `php` handler is enabled
for `.php`.

### Upload over SSH instead

The file manager route needs a browser. This route needs a shell and the
`freebuff-x10` key, uploads the same seven files to the same place, and changes
nothing else on the host — no cPanel setting, no DNS, no PHP version.

| | |
| --- | --- |
| Host | `fiatgod.x10.mx` |
| User | `fiatgod` |
| Port | `22` |
| Key | `freebuff-x10`, private half at `~/.ssh/id_ed25519_x10` |
| Fingerprint | `SHA256:oSJQYKmK2C9XaxXYYzHCLwTIyoJSs2Ej73gLfvQnfiA` |
| Target | `public_html/explorer/` in the account's home directory |

The host offers `publickey,password` on port 22; 21 and 990 are closed, so the
FTPS script above cannot reach it. The private key is never committed and never
pasted anywhere: it stays at `~/.ssh/id_ed25519_x10`, readable only by its owner.

**1. Authorize the key in cPanel.** cPanel → **SSH Access** → **Manage SSH
Keys** → **Import Key**: paste the public half (`~/.ssh/id_ed25519_x10.pub`,
the line starting `ssh-ed25519` and ending `freebuff-x10`) and import it. Then,
still under **Manage SSH Keys**, open the key's **Manage** view and
**Authorize** it. Authorizing is the step that is easy to miss: an imported but
unauthorized key authenticates nothing and the host answers
`Permission denied (publickey)`. This step only registers a public key; it
uploads no file.

**2. Confirm the key on disk is the one above.** A different fingerprint is a
different key: stop and import the public half that belongs to it.

```sh
chmod 600 ~/.ssh/id_ed25519_x10
ssh-keygen -lf ~/.ssh/id_ed25519_x10
# 256 SHA256:oSJQYKmK2C9XaxXYYzHCLwTIyoJSs2Ej73gLfvQnfiA freebuff-x10 (ED25519)
```

**3. Sign in once**, confirming the host key the first time it is offered:

```sh
ssh -i ~/.ssh/id_ed25519_x10 -o IdentitiesOnly=yes -p 22 fiatgod@fiatgod.x10.mx
exit
```

`IdentitiesOnly=yes` keeps the agent's other keys out of the attempt, so the
key named above is the one tried. A `Permission denied (publickey)` here means
step 1 was not finished, not that the upload command is wrong.

**4. Send the seven files.** Run from the repository root, after
`npm run explorer:data` if `CHAIN_PRESETS` changed:

```sh
cd explorer
scp -i ~/.ssh/id_ed25519_x10 -o IdentitiesOnly=yes -P 22 \
  index.html style.css app.js lookup-state.js presets.json rpc.php .htaccess \
  fiatgod@fiatgod.x10.mx:public_html/explorer/
cd ..
```

`.htaccess` is named explicitly because a shell glob such as `explorer/*` skips
it, and without it `/explorer/` answers with the dashboard instead of the page.
Uploading again overwrites the same seven files; there is no partial state to
clean up, and `app.js` and `lookup-state.js` are imported with `?v=` queries, so
a browser holding an older copy fetches the new one.

**5. Check what the host now serves.**

```sh
npm run explorer:check
```

It runs eleven checks, in this order:

1. `/explorer/` answers 200.
2. `/explorer/` is `explorer/index.html` from this checkout, byte for byte.
3. The page loads the same `app.js?v=` version this checkout names.
4. `/explorer/app.js` is revalidated, not cached for a year.
5. `/explorer/app.js` is `explorer/app.js` from this checkout, byte for byte.
6. `/explorer/lookup-state.js` is `explorer/lookup-state.js` from this checkout, byte for byte.
7. `/explorer/style.css` is `explorer/style.css` from this checkout, byte for byte.
8. `/explorer/presets.json` is `explorer/presets.json` from this checkout, byte for byte.
9. `/explorer/nope/` answers 404.
10. `/` still answers with the dashboard.
11. `/explorer/rpc.php` answers `eth_chainId` to this site's own origin.

The check defaults to `https://fiatgod.x10.mx`, so it needs no arguments here;
pass `-- --base https://<other-domain>` for another host. It reads only, plus
the one `eth_chainId` POST the page itself makes. Each check prints an `ok`
line, and the run ends with `11 checks passed` and exit status 0: the upload
landed, `index.html`, `app.js`, `lookup-state.js`, `style.css` and
`presets.json` are byte for byte the files in this checkout, `/explorer/app.js`
is revalidated rather than cached for a year, and the proxy answers this site's
own origin. Byte for byte includes the
line endings and the final newline, because a file manager that stores CRLF or
drops the last newline has uploaded a different file even when the text reads
the same; the detail column names which of those it found. The scripts are
compared rather than only named because the page carries just a version query: a
host can serve the checkout's page beside scripts from an earlier upload and
every other check still passes. A failure prints
`FAIL` against that check and ends with `N of 11 checks failed`, naming them,
with exit status 1; exit status 2 is a usage error. A failure on checks 1, 3 or 4
when the files are demonstrably on disk is usually a stale browser or edge cache
rather than a bad upload; a failure on 2, 5, 6, 7 or 8 means the upload is not
the build in the checkout.

### When only some of the files are behind

A deploy can land part of the batch: the page current and a script not, or the
other way round. The check names what is behind — a failure on 2, 5, 6, 7 or 8
is one of the five files it compares byte for byte, and the detail says how far
off it is. To see the whole batch before touching the host, compare sizes, because a
page can fail at an identical size. Each block sets `BASE` only when it is not
already set, so the commands work unchanged against another origin or a local
copy and any one of them can be run on its own:

```sh
BASE=${BASE:-https://fiatgod.x10.mx}
for f in index.html app.js lookup-state.js style.css presets.json; do
  printf '%-16s host %6s B   local %6s B\n' "$f" \
    "$(curl -s "$BASE/explorer/$f" | wc -c)" "$(wc -c < "explorer/$f")"
done
```

Read the pairs:

| What you see | What it means |
| --- | --- |
| the two sizes differ | the host holds a different revision |
| the sizes match but check 2 fails | same length, different text — the `app.js?v=` query is the usual case |
| a check quotes `line endings are CRLF` | the upload was re-encoded on the way up, a file manager rather than `scp` |
| a check quotes `has no final newline` | the copy is one byte short of the checkout's |

Upload only the files that are behind, in this order — the preset list and the
stylesheet the page uses, then helpers, then the script that imports them, then
the page that names the script's version:

```sh
cd explorer
scp -i ~/.ssh/id_ed25519_x10 -o IdentitiesOnly=yes -P 22 \
  presets.json style.css lookup-state.js app.js index.html \
  fiatgod@fiatgod.x10.mx:public_html/explorer/
cd ..
```

Leave out any of the five that already matched; the order is what matters.
Each file lands on its own, so sending the page last means its `?v=` query never
points at a script that has not arrived yet, and a browser that reloads mid
upload still gets a consistent pair. `scp` copies bytes as they are on disk,
which is what the check requires: no CRLF conversion, and the final newline
kept. A file manager is what re-encodes them.

Then verify, in this order. First the bytes: run the size loop above again, and
after the upload every pair must be two equal numbers, not two similar ones.
Second the line endings, which a size alone can hide — zero CR bytes on every
file means the host kept LF, and the equal sizes are what prove the final
newline survived:

```sh
BASE=${BASE:-https://fiatgod.x10.mx}
for f in index.html app.js lookup-state.js style.css presets.json; do
  printf '%-16s CR bytes on host: %s\n' "$f" \
    "$(curl -s "$BASE/explorer/$f" | tr -cd '\r' | wc -c)"
done
```

Third, the page's version token, which must be the one this checkout names — the
two lines below have to print the same thing:

```sh
BASE=${BASE:-https://fiatgod.x10.mx}
curl -s "$BASE/explorer/" | grep -o 'app\.js?v=[A-Za-z0-9._-]*'
grep -o 'app\.js?v=[A-Za-z0-9._-]*' explorer/index.html
```

Fourth and last, the acceptance gate — the eleven checks, not the five:

```sh
BASE=${BASE:-https://fiatgod.x10.mx}
npm run explorer:check -- --base "$BASE"
```

Exit status 0 and `11 checks passed` means the deploy is done; that run also
re-checks the revalidation header, the 404, the dashboard and the proxy, so a
file outside this batch that broke shows up here. Against a local static copy
two of those are expected to fail — a static server has no dashboard at `/` and
no PHP to answer the proxy — so use the first three steps to check a local copy
and keep the gate for the real host. A remaining failure on 2, 5, 6, 7 or 8
quoting `line endings are CRLF` or `has no final newline` means the bytes were
rewritten on the way up: re-send that file over `scp` after confirming the local
copy is LF (`file explorer/style.css`), rather than editing the host copy.

## Rate-limit the proxy at the edge

`rpc.php` counts sixty calls a minute per address — the edge rule's own number —
but that counter is a backstop: it is per-host state in a temp directory, it
starts empty on a new worker, and it costs PHP time on every request. The limit
itself goes in front of the host. On Cloudflare that is one rule, applied before
PHP runs: a blocked request costs no PHP time and no RPC quota.

1. Cloudflare dashboard → the site's zone → **Security → WAF → Rate limiting
   rules → Create rule**.
2. Name it `explorer rpc`.
3. **When incoming requests match** → *Custom filter expression*:
   `starts_with(http.request.uri.path, "/explorer/rpc.php")`. If the explorer is
   at the root of its own subdomain (Option A below), use
   `http.request.uri.path eq "/rpc.php"` instead.
4. **Rate**: 60 requests per 1 minute, **counting by IP**. Optionally add a
   second rule on the same path for bursts: 20 requests per 10 seconds.
5. **Action**: Block.

Why 60, and what a visitor spends. A page load probes all six presets twice —
chain id and block number, so 12 requests before the reader asks for anything —
and each lookup costs:

| Lookup | Calls |
| --- | --- |
| Block | 1 |
| Address | 3 |
| Transaction | 3 |
| Contract (code plus the three EIP-1967 slots) | 4 |
| Token (code plus name, symbol, decimals, totalSupply) | 5 |

A load plus two lookups is 14 to 22 calls, and the 60 leaves room for about nine
token lookups after a load: a reader works through a few lookups a minute while an
abuser is capped at roughly 60 MiB a minute at the 1 MiB answer cap. At the thirty
this started with, a load plus four token lookups was already refused. Back and
forward re-run a lookup, so it costs the same again.

**The boot probe is reused for a minute.** `app.js` keeps the six probe answers in
`localStorage` under `lwc-explorer-probes`, for the same 60 seconds the proxy
counts, so a reload or a second tab renders the table without twelve more calls; a
cache older than that, or one missing a chain the presets now list, is ignored and
the page probes again. That is what makes a second tab cost a lookup rather than a
lookup plus the table.

Two things move that sum:

- **The count is per public address, so it is shared.** Everyone behind one
  office, campus or carrier-NAT address spends the same 60: two readers loading
  the page behind one address is 24 calls before either asks for a lookup.
- **Behind a proxy the count becomes site-wide.** `rpc.php` reads `REMOTE_ADDR`
  and trusts no forwarding header, which is what stops a forged `Origin` from
  buying a fresh window; with Cloudflare's proxy switched on, that address is
  the edge's, so the 60 is one budget for the whole site rather than per
  visitor and a handful of loads exhaust it. The page answers as plain `Apache`
  today, with no `cf-ray`; if the proxy is turned on, either keep this counter
  as a global backstop and let the WAF rule count the visitor's real address, or
  move the per-visitor count to the edge and leave PHP the Origin gate.

**What a limited visitor sees.** Cloudflare's Block action answers 429 with
Cloudflare's own HTML page, not JSON, so the page treats it the way it treats any
non-JSON answer from `rpc.php`: it stops using the proxy for the rest of that
page load and calls the public endpoints directly. A lookup then either answers
with the status line reading “answered by the endpoint directly”, or fails with
`no endpoint answered`, or names a host and says `Failed to fetch` when the
browser blocks the cross-origin call. A reload after the minute passes goes back
through the proxy. The “rpc.php is not answering” note under the form does not
appear: it is rendered once when the page loads, and by then the limit had not
been hit.

If your plan lets a rate limiting rule return a custom response, set
`application/json` and this body, and the status line prints the message
verbatim instead of falling back:

```json
{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"this proxy is rate limited; try again in a minute"}}
```

**Check the rule after saving.** Send more than 60 requests inside a minute and
watch the tail turn 429; the counter clears within a minute, so a 200 after the
wait means the rule is live and not stuck:

```sh
for i in $(seq 1 70); do
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
    https://<your-domain>/explorer/rpc.php
done | tail -5
```

## Point a domain at it

You need cPanel access for either option; nothing in this folder changes DNS.

**Option A — subdomain, no redirect.** cPanel → **Domains** → *Create A New
Domain* (or *Subdomains*): use `explorer.<your-domain>` and set the document
root to `public_html/explorer`. `https://explorer.<your-domain>/` then serves
the explorer directly.

**Option B — redirect the root.** cPanel → **Domains** → **Redirects**: make
`https://<your-domain>/` redirect to `https://<your-domain>/explorer/`
(301 or 302). The equivalent rule, appended to `public_html/.htaccess`, is:

```apache
RewriteEngine On
RewriteRule ^$ /explorer/ [R=302,L]
```

This replaces the dashboard at `/`; the old page stays reachable at
`/index.html`. Remove the rule to bring the dashboard back.

**Option C — an addon domain.** cPanel → **Domains** → *Create A New Domain*,
and set its document root to `public_html/explorer`. No redirect is needed,
and the existing site at `fiatgod.x10.mx` is untouched.
