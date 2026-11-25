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
is refused. There is no per-IP limit in the PHP: shared hosting has no counter
to keep, so the cap on how fast a stranger can spend the quota belongs at the
edge — see [Rate-limit the proxy at the edge](#rate-limit-the-proxy-at-the-edge).

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page shell. |
| `style.css` | Styles, matching the dark web9999 dashboard. |
| `app.js` | Probes the presets, renders the table, runs lookups (tokens read `name`, `symbol`, `decimals` and `totalSupply`; contracts read code and the EIP-1967 slots). |
| `presets.json` | Generated from `CHAIN_PRESETS`; do not edit by hand. |
| `rpc.php` | Same-origin read-only JSON-RPC proxy with failover. |
| `.htaccess` | No directory listing, the folder's own directory index, basic security headers. |

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
previous one so only the newest stays in flight. The URL and lookup-lifecycle
helpers live in `lookup-state.js`, imported by `app.js` with a `?v=` query;
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

Step 4 depends on `.htaccess` pinning `DirectoryIndex index.html`. The site root
answers a directory request with its own dashboard (`/assets/` behaves the same
way), and a folder inherits that until it declares an index of its own, which is
why `/explorer/` used to serve the dashboard while `/explorer/index.html`
served the explorer. If the folder URL still shows the dashboard after an
upload, the `.htaccess` did not take effect: look for a 500 at that URL (the
host rejects `DirectoryIndex` in `.htaccess` when `AllowOverride` leaves out
`Indexes`) and re-upload the file with **Show Hidden Files** on. When
`.htaccess` is the only file that changed, uploading it alone is enough.

`deploy/explorer-ftp-upload.mjs` can push the same seven files with curl when a
host has an FTPS login and a shell. It is optional: the file manager steps above
are the documented route, and the script's own `--help` says so. It requires
explicit FTPS (`--ssl-reqd`, with no opt-out), so a server that cannot do TLS is
refused instead of accepting the password in the clear.

`index.html` loads `app.js?v=7`. The parent site marks `.js` files immutable for
a year, so bump that number whenever `app.js` changes; otherwise a browser that
loaded the old script keeps running it.

If the page says `presets.json` cannot be loaded, confirm it was uploaded as
`application/json` and not HTML. If `rpc.php` downloads instead of running,
select **PHP 8.x** for the account and make sure the `php` handler is enabled
for `.php`.

## Rate-limit the proxy at the edge

`rpc.php` has no per-IP counter and no place to keep one on shared hosting, so
the limit goes in front of the host. On Cloudflare that is one rule, applied
before PHP runs: a blocked request costs no PHP time and no RPC quota.

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

Why 60: a page load probes all six chains twice, chain id and block number, so
12 requests, and a lookup costs one to four more. That leaves a reader four page
loads a minute while capping an abuser at roughly 60 MiB a minute at the 1 MiB
answer cap. The count is per IP, so an office behind one address shares it.

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
