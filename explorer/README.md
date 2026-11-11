# lwc explorer

A static, read-only explorer for the six chains built into
`lovewebconnection`: live preset health on the primary and fallback endpoints,
plus block, address and transaction lookups.

Nothing here holds a key, signs, or sends a transaction. `rpc.php` accepts only
a fixed list of `eth_*`/`net_version` read methods and forwards them to the
endpoints in `presets.json`, primary first, then fallback.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page shell. |
| `style.css` | Styles, matching the dark web9999 dashboard. |
| `app.js` | Probes the presets, renders the table, runs lookups. |
| `presets.json` | Generated from `CHAIN_PRESETS`; do not edit by hand. |
| `rpc.php` | Same-origin read-only JSON-RPC proxy with failover. |
| `.htaccess` | No directory listing, basic security headers. |

## Regenerate the preset list

```sh
npm run explorer:data
```

Rerun this after changing `CHAIN_PRESETS` in `src/chain.ts`. The page and
`rpc.php` both read `presets.json`, so they cannot disagree.

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
3. Upload `index.html`, `style.css`, `app.js`, `presets.json`, `rpc.php` and
   `.htaccess` (turn on **Settings → Show Hidden Files** so `.htaccess` is
   visible).
4. Open `https://<your-domain>/explorer/`.

If the page says `presets.json` cannot be loaded, confirm it was uploaded as
`application/json` and not HTML. If `rpc.php` downloads instead of running,
select **PHP 8.x** for the account and make sure the `php` handler is enabled
for `.php`.

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
