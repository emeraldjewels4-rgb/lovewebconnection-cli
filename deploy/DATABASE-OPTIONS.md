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
- The page calls `/api/web9999/coins`, `/api/markets`, `/api/monero/stats.php` and `/web9999/networks.json` **same-origin and absolute**, which is why the rails must run wherever the page is served.

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

## Option B — point the VPS at x10hosting's MySQL

x10hosting's panel is **DirectAdmin**, not cPanel, so cPanel instructions do not apply verbatim. Remote access is per database user: *Account Manager → MySQL Management → the database → Access Hosts*, where you add the connecting server's IP (or `%`). The client connects to **the hostname you use for the panel, minus `:2222`**, on **port 3306**. See [DirectAdmin's MariaDB/MySQL docs](https://docs.directadmin.dev/other-hosting-services/mariadb-mysql) and [this walk-through](https://namecrane.com/docs/directadmin/databases/remote-mysql).

**What it takes.** On x10: confirm remote access is permitted on your plan at all, add the **VPS's egress IP** as an access host, and confirm 3306 is reachable from outside — many shared hosts block inbound 3306 by default and must open it per account ([example](https://www.hostgator.com/help/article/how-to-connect-to-the-mysql-database-remotely)). From the VPS, prove it before touching code: `Test-NetConnection -ComputerName <x10 host> -Port 3306`.

**Export / import.** None — this is B's one real advantage. The data stays where it is; the app just reaches across. Nothing to dump, nothing to restore, no cutover window, existing rows keep their timestamps.

**Credentials.** Same three settings, pointed outward: `db.host` = x10 server hostname, `db.port` = 3306, plus the x10 database user and password — which now live on the VPS and are sent on every connection. The VPS needs outbound 3306 (usually allowed) and the x10 side needs the VPS's IP allow-listed; a changing IP means editing access hosts.

**DNS.** The VPS must resolve x10's database hostname. If you want to own that name (a CNAME you control, so a hosting migration doesn't break the config), you need a zone you control — x10's free DNS is usually not that, so in practice you are pinned to their hostname.

**Plan limits that become the site's limits.** x10 Basic is 2 MySQL databases and 500 MB of space. A suspended, expired or over-quota free account takes the data away from a site that is otherwise running fine on the VPS — and the failure looks like "the site is broken", not "the database host is gone".

## Why remote MySQL over plaintext is the weak option

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

## Not done, and what to confirm first

Nothing was installed, dumped, imported or reconfigured; no account, firewall or DNS was touched.

To choose between them, three facts are needed that only the x10 account can answer:

- Does the plan allow remote database access at all, and is inbound 3306 open for it?
- What is the database server's hostname, and does it ever change?
- Does the plan include SSH, for a tunnel instead of plaintext 3306?
