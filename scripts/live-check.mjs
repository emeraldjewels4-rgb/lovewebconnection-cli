#!/usr/bin/env node
/**
 * Read-only live check for the tracked web9999 page and API.
 *
 *   npm run live-check
 *   npm run live-check -- --json
 *   npm run live-check -- --require-api-source
 *
 * The page is fetched over HTTPS and its exact bytes are compared with
 * web9999/index.html. The API is checked through its public read-only routes:
 * `/api/web9999/` must answer `ok:true` for web9999, and
 * `/api/web9999/coins` must match the database and chain list in the tracked
 * `api/web9999/lib/coins.php`.
 *
 * When CPANEL_USER and CPANEL_PASS (or CPANEL_TOKEN) are configured in
 * `.env.cpanel`, the tracked API source files are also read with cPanel's
 * read-only Fileman get_file_content call and compared by SHA-256. Without
 * those credentials the source comparison is reported as skipped; the public
 * page and API checks still run.
 *
 * A mismatch or health failure is reported, written to the report file, and
 * optionally POSTed to LWC_LIVE_ALERT_WEBHOOK. Nothing is uploaded, renamed,
 * restored, or deployed. Exit status is 0 when every configured check passes,
 * 1 when the live page/API is unhealthy or differs, and 2 for a usage error.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { postWebhook } from "../src/webhook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PAGE = "web9999/index.html";
const DEFAULT_PAGE_URL = "https://fiatgod.x10.mx/web9999/";
const DEFAULT_API_URL = "https://fiatgod.x10.mx/api/web9999";
const DEFAULT_API_FILES = ["coins.php", "lib/coins.php"];
const DEFAULT_REPORT = ".lwc-cache/live-check.json";
const DEFAULT_TIMEOUT_MS = 20_000;
const REQUIRED_COIN_FIELDS = ["chain", "name", "symbol", "read_at"];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function short(value) {
  return typeof value === "string" && value.length > 12 ? value.slice(0, 12) : value;
}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readEnvFile(path) {
  const file = resolve(ROOT, path);
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

// .env.cpanel is intentionally separate from .env. The process environment
// still wins, so a scheduled runner can supply the same values without a file.
const fileEnv = {
  ...readEnvFile(".env"),
  ...readEnvFile(".env.cpanel"),
};

function envValue(name, fallback = null) {
  const value = process.env[name] ?? fileEnv[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function apiUrl(value) {
  return value.replace(/\/+$/, "");
}

async function fetchBytes(url, headers = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "follow",
    headers,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

async function getJson(url) {
  const response = await fetchBytes(url, { accept: "application/json" });
  let body;
  try {
    body = JSON.parse(response.bytes.toString("utf8"));
  } catch {
    throw new Error(`HTTP ${response.status}: response was not JSON`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { status: response.status, body };
}

function readTrackedApi(source) {
  const database = /const\s+WEB9999_COIN_DB\s*=\s*'([^']+)'/.exec(source)?.[1] ?? null;
  const block = /function\s+web9999_chains\s*\(\)\s*:\s*array\s*\{[\s\S]*?return\s*\[([\s\S]*?)\]\s*;/.exec(
    source,
  )?.[1];
  const chains = block ? [...block.matchAll(/'([^']+)'\s*=>/g)].map((match) => match[1]) : [];
  if (!database || chains.length === 0) {
    throw new Error("cannot read WEB9999_COIN_DB / web9999_chains() from api/web9999/lib/coins.php");
  }
  return { database, chains };
}

async function checkPage(pagePath, pageUrl) {
  const result = {
    path: pagePath,
    url: pageUrl,
    ok: false,
    localSha256: null,
    liveSha256: null,
    localBytes: 0,
    liveBytes: 0,
    status: null,
    contentType: null,
    error: null,
  };
  try {
    const tracked = await readFile(resolve(ROOT, pagePath));
    result.localBytes = tracked.length;
    result.localSha256 = hash(tracked);
    const live = await fetchBytes(pageUrl, { accept: "text/html" });
    result.status = live.status;
    result.contentType = live.contentType;
    result.liveBytes = live.bytes.length;
    result.liveSha256 = hash(live.bytes);
    if (live.status !== 200) result.error = `HTTP ${live.status}`;
    else if (!(live.contentType ?? "").toLowerCase().includes("text/html")) {
      result.error = `unexpected content-type ${live.contentType ?? "(none)"}`;
    } else if (result.liveSha256 !== result.localSha256) {
      result.error = `live hash ${short(result.liveSha256)} != tracked ${short(result.localSha256)}`;
    }
    result.ok = result.error === null;
  } catch (error) {
    result.error = describe(error);
  }
  return result;
}

async function checkApi(base, tracked) {
  const result = {
    url: base,
    ok: false,
    status: null,
    coins: null,
    contractSha256: null,
    errors: [],
    warnings: [],
  };
  try {
    const status = await getJson(`${base}/`);
    result.status = {
      http: status.status,
      ok: status.body?.ok === true,
      name: status.body?.name ?? null,
    };
    if (status.body?.ok !== true) result.errors.push("status: ok is not true");
    if (status.body?.name !== "web9999") result.errors.push(`status: name is ${status.body?.name ?? "(missing)"}, not web9999`);

    const coins = await getJson(`${base}/coins`);
    const body = coins.body ?? {};
    const list = Array.isArray(body.coins) ? body.coins : null;
    result.coins = {
      http: coins.status,
      ok: body.ok === true,
      database: body.database ?? null,
      needsSchema: body.needs_schema ?? null,
      count: body.count ?? null,
      stale: body.stale ?? null,
      chainCount: list?.length ?? null,
    };

    if (body.ok !== true) result.errors.push("coins: ok is not true");
    if (body.database !== tracked.database) {
      result.errors.push(`coins: database ${body.database ?? "(missing)"} != tracked ${tracked.database}`);
    }
    if (body.needs_schema !== false) result.errors.push("coins: needs_schema is not false");
    if (list === null) {
      result.errors.push("coins: response has no coins array");
    } else {
      if (body.count !== list.length) {
        result.errors.push(`coins: count ${body.count} != array length ${list.length}`);
      }
      const liveChains = list.map((coin) => coin?.chain).filter((chain) => typeof chain === "string");
      const missing = tracked.chains.filter((chain) => !liveChains.includes(chain));
      const extra = liveChains.filter((chain) => !tracked.chains.includes(chain));
      if (missing.length) result.errors.push(`coins: missing tracked chain(s): ${missing.join(", ")}`);
      if (extra.length) result.errors.push(`coins: unexpected chain(s): ${extra.join(", ")}`);
      const malformed = list
        .map((coin, index) => ({ coin, index }))
        .filter(({ coin }) => REQUIRED_COIN_FIELDS.some((field) => coin?.[field] === undefined));
      if (malformed.length) {
        result.errors.push(`coins: row(s) ${malformed.map(({ index }) => index).join(", ")} lack required fields`);
      }
      if (body.stale === true) result.warnings.push("coins: stale is true (API reachable, but its data is old)");
    }

    result.contractSha256 = hash(
      Buffer.from(
        JSON.stringify({
          database: tracked.database,
          chains: [...tracked.chains].sort(),
          statusKeys: Object.keys(status.body ?? {}).sort(),
          coinsKeys: Object.keys(body).sort(),
          coinKeys: [
            ...new Set((list ?? []).flatMap((coin) => (coin && typeof coin === "object" ? Object.keys(coin) : []))),
          ].sort(),
        }),
      ),
    );
  } catch (error) {
    result.errors.push(describe(error));
  }
  result.ok = result.errors.length === 0;
  return result;
}

function cpanelConfig() {
  const host = envValue("CPANEL_HOST");
  const user = envValue("CPANEL_USER");
  const password = envValue("CPANEL_PASS");
  const token = envValue("CPANEL_TOKEN");
  if (!host || !user || (!password && !token)) {
    return {
      ready: false,
      reason:
        "CPANEL_USER and CPANEL_PASS or CPANEL_TOKEN are not configured in .env.cpanel",
    };
  }
  let base;
  try {
    let raw = host;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    const parsed = new URL(raw);
    if (!parsed.port) parsed.port = "2083";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    base = parsed.origin;
  } catch (error) {
    return { ready: false, reason: `CPANEL_HOST is not a URL (${describe(error)})` };
  }
  return {
    ready: true,
    base,
    auth: token
      ? `cpanel ${user}:${token}`
      : `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
    dir: (envValue("CPANEL_API_DIR", "public_html/api/web9999") ?? "public_html/api/web9999")
      .replace(/^\/+|\/+$/g, ""),
  };
}

async function cpanelRead(config, relative) {
  const remote = posix.join(config.dir, relative);
  const directory = posix.dirname(remote);
  const file = posix.basename(remote);
  const url = new URL("/execute/Fileman/get_file_content", config.base);
  const form = new URLSearchParams({ dir: directory, file });
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      accept: "application/json",
      authorization: config.auth,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`cPanel Fileman returned HTTP ${response.status} without JSON`);
  }
  if (payload?.status !== 1) {
    const errors = Array.isArray(payload?.errors) ? payload.errors.join("; ") : `HTTP ${response.status}`;
    throw new Error(`cPanel Fileman: ${errors}`);
  }
  const content = typeof payload.data === "string" ? payload.data : payload.data?.content;
  if (typeof content !== "string") throw new Error(`cPanel Fileman returned no content for ${relative}`);
  return content;
}

async function checkApiSource(files, required, disabled) {
  const result = {
    status: "skipped",
    ok: null,
    reason: null,
    files: [],
  };
  for (const relative of files) {
    const entry = { path: `api/web9999/${relative}`, localSha256: null, liveSha256: null, ok: null, error: null };
    try {
      entry.localSha256 = hash(await readFile(resolve(ROOT, entry.path)));
    } catch (error) {
      entry.error = `tracked file unreadable: ${describe(error)}`;
    }
    result.files.push(entry);
  }

  if (disabled) {
    result.reason = "disabled with --no-api-source";
    if (required) result.ok = false;
    return result;
  }

  const config = cpanelConfig();
  if (!config.ready) {
    result.reason = config.reason;
    if (required) result.ok = false;
    return result;
  }

  result.status = "checked";
  result.ok = true;
  for (const entry of result.files) {
    if (entry.error !== null) {
      result.ok = false;
      continue;
    }
    const relative = entry.path.slice("api/web9999/".length);
    try {
      entry.liveSha256 = hash(Buffer.from(await cpanelRead(config, relative), "utf8"));
      entry.ok = entry.liveSha256 === entry.localSha256;
      if (!entry.ok) {
        result.ok = false;
        entry.error = `live hash ${short(entry.liveSha256)} != tracked ${short(entry.localSha256)}`;
      }
    } catch (error) {
      result.ok = false;
      entry.error = describe(error);
    }
  }
  return result;
}

async function deliverAlert(webhook, authHeader, payload) {
  if (!webhook) return { sent: false, reason: "no LWC_LIVE_ALERT_WEBHOOK configured" };
  const result = await postWebhook(webhook, payload, { authHeader });
  return { sent: result.ok, reason: result.message };
}

function printReport(report, reportPath) {
  const page = report.page;
  const api = report.api;
  const source = api.source;
  console.log(`web9999 live check  ${report.checkedAt}`);
  console.log(
    `  page    ${page.ok ? "ok  " : "FAULT"} ${page.status ?? "-"} ` +
      `${short(page.liveSha256) ?? "-"} ${page.liveBytes} bytes` +
      (page.localSha256 !== page.liveSha256 ? ` (tracked ${short(page.localSha256)})` : ""),
  );
  console.log(
    `  api     ${api.ok ? "ok  " : "FAULT"} ` +
      `${api.coins?.chainCount ?? "-"}/${report.expected.chains.length} chains, ` +
      `${api.coins?.database ?? "-"}, needs_schema=${api.coins?.needsSchema ?? "-"}`,
  );
  console.log(
    `  source  ${source.status === "checked" ? (source.ok ? "ok  " : "FAULT") : "skip "} ` +
      `${source.status}${source.reason ? ` — ${source.reason}` : ""}`,
  );
  for (const warning of [...api.warnings, ...report.warnings]) console.log(`  warning ${warning}`);
  for (const failure of report.failures) console.log(`  FAILED  ${failure}`);
  console.log(`  report  ${reportPath}`);
  if (report.alert) {
    console.log(`  alert   ${report.alert.sent ? "sent" : "not sent"}${report.alert.reason ? ` — ${report.alert.reason}` : ""}`);
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      strict: true,
      options: {
        page: { type: "string" },
        "page-url": { type: "string" },
        "api-url": { type: "string" },
        "api-file": { type: "string", multiple: true },
        "alert-webhook": { type: "string" },
        "alert-auth": { type: "string" },
        "no-alert": { type: "boolean" },
        "no-api-source": { type: "boolean" },
        "require-api-source": { type: "boolean" },
        report: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    console.error(`usage error: ${describe(error)}`);
    return 2;
  }

  if (values.help) {
    console.log(
      "usage: node scripts/live-check.mjs [--json] [--page <path>] [--page-url <url>]\n" +
        "       [--api-url <url>] [--api-file <relative>] [--alert-webhook <url>]\n" +
        "       [--alert-auth <header>] [--no-alert] [--no-api-source]\n" +
        "       [--require-api-source] [--report <path>]",
    );
    return 0;
  }

  const pagePath = values.page ?? DEFAULT_PAGE;
  const pageUrl = values["page-url"] ?? envValue("LWC_LIVE_PAGE_URL", DEFAULT_PAGE_URL);
  const base = apiUrl(values["api-url"] ?? envValue("LWC_LIVE_API_URL", DEFAULT_API_URL));
  const files = values["api-file"] ?? DEFAULT_API_FILES;
  const webhook =
    values["alert-webhook"] ?? envValue("LWC_LIVE_ALERT_WEBHOOK") ?? envValue("LWC_ALERT_WEBHOOK");
  const authHeader = values["alert-auth"] ?? envValue("LWC_WEBHOOK_AUTH");
  const reportPath = values.report ?? DEFAULT_REPORT;

  if (!httpUrl(pageUrl)) {
    console.error("usage error: --page-url / LWC_LIVE_PAGE_URL must be an http(s) URL");
    return 2;
  }
  if (!httpUrl(base)) {
    console.error("usage error: --api-url / LWC_LIVE_API_URL must be an http(s) URL");
    return 2;
  }
  if (webhook !== null && !httpUrl(webhook)) {
    console.error("usage error: --alert-webhook / LWC_LIVE_ALERT_WEBHOOK must be an http(s) URL");
    return 2;
  }
  if (authHeader !== null && /[\r\n]/.test(authHeader)) {
    console.error("usage error: --alert-auth / LWC_WEBHOOK_AUTH must be a single line");
    return 2;
  }
  if (values["no-api-source"] && values["require-api-source"]) {
    console.error("usage error: --no-api-source and --require-api-source cannot be combined");
    return 2;
  }

  let tracked;
  try {
    tracked = readTrackedApi(await readFile(resolve(ROOT, "api/web9999/lib/coins.php"), "utf8"));
  } catch (error) {
    console.error(`config error: ${describe(error)}`);
    return 2;
  }

  const page = await checkPage(pagePath, pageUrl);
  const api = await checkApi(base, tracked);
  const source = await checkApiSource(
    files,
    values["require-api-source"] === true,
    values["no-api-source"] === true,
  );
  const failures = [];
  const warnings = [];
  if (!page.ok) failures.push(`page: ${page.error ?? "live page differs from tracked file"}`);
  failures.push(...api.errors.map((error) => `api: ${error}`));
  warnings.push(...api.warnings);
  if (source.status === "skipped") {
    if (values["no-api-source"] !== true) {
      warnings.push(`api source: ${source.reason}; set .env.cpanel to compare exact API source hashes`);
    }
    if (values["require-api-source"] === true) failures.push(`api source: ${source.reason}`);
  } else if (!source.ok) {
    for (const file of source.files) {
      if (file.error) failures.push(`api source ${file.path}: ${file.error}`);
      else if (file.ok === false) failures.push(`api source ${file.path}: live source differs from tracked`);
    }
  }

  const checkedAt = new Date().toISOString();
  const report = {
    checkedAt,
    page,
    api: { ...api, source },
    expected: tracked,
    failures,
    warnings,
    healthy: failures.length === 0,
    alert: null,
  };
  if (!report.healthy && !values["no-alert"]) {
    report.alert = await deliverAlert(webhook, authHeader, {
      event: "web9999-live-drift",
      checkedAt,
      page: {
        url: page.url,
        ok: page.ok,
        localSha256: page.localSha256,
        liveSha256: page.liveSha256,
      },
      api: {
        url: base,
        ok: api.ok,
        database: api.coins?.database ?? null,
        chains: api.coins?.chainCount ?? null,
        contractSha256: api.contractSha256,
        sourceStatus: source.status,
        sourceOk: source.ok,
      },
      failures,
    });
  }

  await mkdir(dirname(resolve(ROOT, reportPath)), { recursive: true });
  await writeFile(resolve(ROOT, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report, reportPath);

  if (!report.healthy) {
    if (!webhook || values["no-alert"]) {
      console.error("live check failed; no webhook alert was sent");
    }
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`live check failed to run: ${describe(error)}`);
    process.exitCode = 2;
  });
