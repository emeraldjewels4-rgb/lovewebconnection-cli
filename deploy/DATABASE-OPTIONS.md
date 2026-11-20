# The database behind web9999

Written from the code that exists, not from a generic template. Nothing has been started.

## What the application actually needs

`api/web9999/lib/coins.php` is the whole database layer. It matters here because it fixes the requirements both options have to satisfy:

- **Two tables**, created by the app itself with `CREATE TABLE IF NOT EXISTS`:

| Table | Key | Columns |
|---|---|---|
| `web9999_coins` | `PRIMARY KEY (chain)` | chain, name, symbol, created_at |
| `web9999_coin_readings` | `PRIMARY KEY (chain)`, FK → coins | chain, read_at, price_usd, market_cap_usd, blocks, transactions, mempool, difficulty, hashrate, error |

- **Both tables hold one row per chain**, not a time series: `web9999_coin_readings` is keyed on `chain`, so each read overwrites the previous one. With ~20 chains the entire database is a **few kilobytes**. This is a snapshot cache, not history — it changes the weight of everything below.
- **The catalogue is seeded from code, but only on the write path.** `web9999_seed()` is called from the POST/shell branch alone, immediately after `web9999_ensure_schema()`; GET never creates tables or inserts rows. An empty database therefore answers a read with `needs_schema: true`, `count: 0`, an empty `coins` list and a hint — not a populated catalogue. It refills on the first refresh (POST with `WEB9999_REFRESH_TOKEN`, or the CLI importer), which costs ~17 metered Blockchair calls with a 2-second pause between them and needs either the token configured or shell access. Starting clean is cheap, but it is not free.
- **Credentials are resolved in one place**, in this order:
  1. `WEB9999_DB_CONFIG` → path to a config file containing `db.host`, `db.port`, `db.user`, `db.password` (default: `scan/config.php` beside the account directory);
  2. otherwise `WEB9999_DB_DSN`, `WEB9999_DB_USER`, `WEB9999_DB_PASSWORD`.
- **The DSN is `mysql:host=…;port=…;dbname=…;charset=utf8mb4`** with no TLS parameters, and **each PHP request opens its own connection** (plain PDO constructor, no persistent handle, no pool).
- The page calls `/api/web9999/coins`, `/api/markets`, `/api/monero/stats.php` and `networks.json` **same-origin** (fetched relative to the page, so it follows the page wherever it is mounted), which is why the rails must run wherever the page is served.
- `networks.json` is **static and ships in the deploy bundle** beside `index.html` (generated from `CHAIN_PRESETS` by `deploy/networks.mjs`), and the page fetches it relatively, so it resolves whether the site is served at the domain root or under a subdirectory; IIS serves it and the proxy rule never sees it — a rule for it would fetch a file x10 does not have.

## What the cPanel account actually has

An inspection of the cPanel account behind `fiatgod.x10.mx` found three things that decide the options below. They are stated here, before either option, rather than discovered halfway through one.

- **Six databases**, all on the same server: `fiatgodx_fiatlord`, `fiatgodx_lovewebconnection`, `fiatgodx_scan`, `fiatgodx_toolkit`, `fiatgodx_web9999` (the one this page reads) and `fiatgodx_zipchain`. Those six names are read back from the host itself rather than inferred from the naming pattern: `GET /api/web9999/` on 2026-11-20 returned exactly these six, all reachable, all on MariaDB `11.4.13-MariaDB-cll-lve`, holding between 4 and 11 tables each. **The user, and the size of each in bytes, are not recorded in this document.** Take them from *cPanel → MySQL Databases* when they matter — they decide whether a dump and restore takes minutes or an afternoon — and do not infer them from the naming pattern.
- **Remote access is not granted - but the port is not closed.** The **Remote MySQL** module is not installed on this account, so there is no screen on which to add an allowed host, and therefore no host that can be allow-listed: the databases answer from localhost and a connection from anywhere else has no grant to succeed with.

  Measured from outside, however, `fiatgod.x10.mx:3306` **accepts a TCP connection** and returns a MariaDB `11.4.13-MariaDB-cll-lve` greeting. So the restriction is at the grant level, not the network level, and the listening port is exposed to the internet. No credential was tried and nothing was changed; this is a statement about exposure, and it cuts both ways - it is also why a VPS *could* reach that port, which is the case the "weak option" section below argues against.
- **The rails answer at `/api` on the domain root.** `https://fiatgod.x10.mx/api/web9999/coins` returns JSON today. That is the same prefix the page requests same-origin, which is why a `/api/*` proxy needs no change to the application, and why the page's absolute paths are not a problem to be solved.

## Option A — MySQL on the VPS, next to the app

**What it takes.** Install MySQL Community Server or MariaDB for Windows on the VPS (it is Windows Server 2022 with IIS 10, no MySQL today). Create one database and one user scoped to `127.0.0.1`, bind the server to loopback only (`bind-address=127.0.0.1`), and leave port 3306 closed in Windows Firewall. Install PHP with `pdo_mysql` and wire the `/api/*` path in IIS.

**Export / import.** This is the only option that *needs* a migration, because the data moves:

```bash
# on the host that holds the current database
mysqldump --single-transaction --no-tablespaces --default-character-set=utf8mb4 \
  --skip-triggers --skip-routines db_name web9999_coins web9999_coin_readings > web9999.sql

mysql -u root -p db_name < web9999.sql
```

`web9999_coins` must import before `web9999_coin_readings` (foreign key). `--single-transaction` keeps it consistent without locking. Total size is a few KB — seconds either way. Verify with `SELECT COUNT(*)` on both tables before and after.

**Credentials.** Three values on the VPS, nothing shared outward:

| Where | Key | Value |
|---|---|---|
| config file | `db.host` / `db.port` | `127.0.0.1` / `3306` |
| config file | `db.user` / `db.password` | a dedicated user, generated password |
| or env | `WEB9999_DB_DSN` / `_USER` / `_PASSWORD` | same, DSN form |

Put the config file **outside the website root** and point `WEB9999_DB_CONFIG` at it, so a PHP misconfiguration cannot serve it. Only the app's own host can reach the database at all — the password never crosses a network.

**DNS.** None. The database has no name to resolve, and the site's own address does not change.

**Ongoing cost.** You now own backups (a scheduled `mysqldump`), upgrades and disk. In exchange: no shared host in the data path, and the app↔database conversation never leaves the machine.

## Option C — keep the rails on x10, move only the database

`web9999_connection_details()` builds `mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4` and substitutes host and port **verbatim**, with no validation, from `scan/config.php` (or `WEB9999_DB_CONFIG`) — falling back to `WEB9999_DB_DSN` / `WEB9999_DB_USER` / `WEB9999_DB_PASSWORD`, where the DSN must start with `mysql:`. So the PHP that serves the rails can be pointed at a database on another machine without a code change:

```php
// scan/config.php, on the x10 account
return ["db" => ["host" => "108.181.154.182", "port" => "3306", "user" => "...", "password" => "..."]];
```

**One constraint the same function imposes:** the database name is not part of that config. It is `const WEB9999_COIN_DB = "fiatgodx_web9999"` in `coins.php`, so a database on the VPS must be created with **exactly that name**, or the constant has to change with the code.

**What it costs.** Nothing to dump and restore on the x10 side until the cutover, but everything Option B is criticised for below applies unchanged and in the same direction — the DSN carries no TLS parameters, so the database password and every result cross the public internet in the clear; the VPS must bind 3306 publicly, grant a user matching the account's egress IP, and firewall it to that IP alone. It also leaves the site split across two providers, so an x10 outage still takes the rails down.

**What gates it.** Two unknowns, both measurable rather than arguable: something must listen on the VPS 3306 (nothing does today), and this account must be able to reach it at all. `deploy/probe-vps-3306.php` answers the second, from the host that would make the connection. Until both are true, this is a config example, not an option.

## Option B — point the VPS at x10hosting's MySQL

x10hosting's panel here is **cPanel**, and cPanel's remote access lives entirely in the *Remote MySQL* module: you add a connecting host's IP (or `%`) there and nothing else opens 3306. That module is **not installed on this account** (see above), so the step this option depends on has nowhere to happen. Option B is therefore not merely the weaker choice on this account — as described, it is unavailable. What survives of it is the tunnel shape at the end of this section, which needs SSH on the shared account as well.

**What it takes.** More than this account can give. With Remote MySQL absent there is no allow-list to add the VPS's egress IP to, so the VPS cannot reach 3306 whatever it opens outbound, and no amount of work on the Windows side changes that. The only version of B that could still work is the tunnel in the last paragraph of this section, and it is blocked on the same missing module plus SSH access.

**Export / import.** None — this is B's one real advantage. The data stays where it is; the app just reaches across. Nothing to dump, nothing to restore, no cutover window, existing rows keep their timestamps.

**Credentials.** Same three settings, pointed outward: `db.host` = the x10 server hostname, `db.port` = 3306, plus the x10 database user and password - which would then live on the VPS and travel on every connection. The x10 side would have to allow-list the VPS egress IP, and this account cannot: there is no Remote MySQL module to hold that list, and a changing IP would mean editing it repeatedly if there were.

**DNS.** The VPS must resolve x10's database hostname. If you want to own that name (a CNAME you control, so a hosting migration doesn't break the config), you need a zone you control — x10's free DNS is usually not that, so in practice you are pinned to their hostname.

**Plan limits that become the site's limits.** The account already holds **six** databases (`fiatgodx_*`), so the "2 MySQL databases" figure often quoted for x10 Basic does not describe this account — treat any advertised allowance as unverified and the **disk quota** as the limit that matters, since the sizes above were not measured. A suspended, expired or over-quota account takes the data away from a site that is otherwise running fine on the VPS, and the failure looks like "the site is broken", not "the database host is gone".

## Why remote MySQL over plaintext is the weak option

On this account it is also **impossible** (see the panel section above), so read this list as why it would still be the wrong choice on a host where remote MySQL does exist - and as the case the tunnel variant has to answer for.

1. **Nothing in the path is encrypted.** The DSN has no TLS parameters and PDO's MySQL driver without TLS attributes connects in the clear. Shared MySQL almost never offers a server certificate anyway. Every query, every result, and **the database password itself** cross the open internet readable by anything on the path.
2. **The password is a reusable internet-facing credential.** With the VPS IP allow-listed (or `%`, which people add when their IP is dynamic) and port 3306 opened, the only thing between the internet and the data is that one password, with no rate limiting, no second factor and no way to see who is guessing. Leaking it once on the wire means rotating it everywhere.
3. **Data can be altered in flight**, not just read — a price or a reading can be changed by whoever sits on the path, and the application has no way to tell.
4. **Every page view pays the WAN.** PHP opens a fresh connection per request, so each `/api/web9999/coins` hit costs a DNS lookup, TCP handshake, and MySQL authentication across the internet, then the query round trip. On loopback this is sub-millisecond; across hosting it is tens to hundreds of milliseconds per request, and each extra failure mode (timeout, DNS, reset) turns into a 500 on the page.
5. **Availability and backups move out of your control.** The site's data depends on a free shared host's uptime and quota, while the site itself runs somewhere else that you do control. Two providers, two failure domains, one of which you cannot see into.
6. **It solves a problem that is barely a problem.** The database is a few kilobytes of snapshot rows, and it is repopulated by a single refresh rather than by reads (the seeding sits on the write path). Option A's migration is a `mysqldump` that runs in seconds — B's "no migration needed" is worth very little against the above.

If B is chosen anyway, the only defensible shape is **not** plaintext 3306: an SSH tunnel from the VPS to x10 with the database bound to loopback on the far side, or a VPN between the two, so the DSN points at `127.0.0.1` through the tunnel. That requires SSH access on the x10 account, which free shared plans usually do not include — confirm before relying on it.

## Third path worth knowing before choosing

The page's rails are same-origin (`/api/...`), which is the real constraint. A reverse proxy in IIS that forwards `/api/*` to the **existing** x10 deployment over HTTPS keeps the database where it is, with no remote MySQL at all, no plaintext credentials, and no migration — at the cost of one proxied hop per API call, over an encrypted channel you can lock down with a shared secret. That is closer to "best of both" than either option above, and it is a smaller change than moving a database.

## Recommendation

**Option A** — MySQL on the VPS — with the config file outside the web root and 3306 bound to loopback. The migration is a few kilobytes, the security argument is decisive, and it removes a provider from the site's critical path. If the rails are not ready to run on the VPS yet, the reverse proxy is the better interim step than pointing a Windows web server at a free host's database over the open internet.

**Option B is off the table on this account, not merely discouraged.** Remote MySQL being absent removes the one advantage B was chosen for, so the only surviving form needs an SSH tunnel the same account must also provide. That makes the real choice the one between the remaining two: move a few kilobytes of snapshot data onto the VPS (A), or proxy `/api/*` to the deployment that already works (third path).

**Option C is the cheapest to try and the least defensible to keep.** It is a two-line config change, which is exactly why it will be tempting; but it moves the same plaintext credential onto the public internet that B does, adds a publicly bound 3306 on the VPS, and still depends on x10 for the rails. Try it if the probe says the path works — as a way to measure, not as the resting state.

## Not done, and what to confirm first

Nothing was installed, dumped, imported or reconfigured; no account, firewall or DNS was touched.

The x10 to VPS direction is still unmeasured, and the probe for it is `deploy/probe-vps-3306.php`: it must be dropped on the host by hand (this project has no upload channel to x10), it says nothing useful until something listens on 3306 on the VPS, and it has to be deleted from the host the moment it has answered.

The inspection above settles the remote-access question (no Remote MySQL, no allow-list), so what remains to choose between the options is:

- Does the account include SSH? That is now the only way to reach the database from the VPS, and B's tunnel shape depends on it.
- What is the database server's hostname, and does it ever change?
- Does the plan include SSH, for a tunnel instead of plaintext 3306?
