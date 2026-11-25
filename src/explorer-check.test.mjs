import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// deploy/explorer-check.mjs sends only GETs apart from one same-origin POST to rpc.php, so its nine
// checks can be run against a loopback server: no host, no network egress, nothing written. The page
// and its scripts are served with CRLF on purpose, because a file manager upload can store them that
// way and the check is meant to ignore that difference.
const SCRIPT = join(import.meta.dirname, "..", "deploy", "explorer-check.mjs");
const SOURCE = join(import.meta.dirname, "..", "explorer");
const PAGE = await readFile(join(SOURCE, "index.html"), "utf8");
const CRLF_PAGE = PAGE.replace(/\n/g, "\r\n");
const CRLF_APP = (await readFile(join(SOURCE, "app.js"), "utf8")).replace(/\n/g, "\r\n");
const CRLF_STATE = (await readFile(join(SOURCE, "lookup-state.js"), "utf8")).replace(/\n/g, "\r\n");
const DASHBOARD = "<!doctype html><title>dashboard</title>";

/** The healthy host: the page, its script, the dashboard, and a 404 for anything else. */
function healthyHost() {
  return {
    "/": { body: DASHBOARD },
    "/explorer/": { body: CRLF_PAGE },
    "/explorer/app.js": {
      body: CRLF_APP,
      headers: { "content-type": "text/javascript", "cache-control": "no-cache, must-revalidate" },
    },
    "/explorer/lookup-state.js": {
      body: CRLF_STATE,
      headers: { "content-type": "text/javascript", "cache-control": "no-cache, must-revalidate" },
    },
    // The page's own call: a same-origin POST with a JSON body. This one answers
    // only when all three hold, which is what the proxy check is meant to prove.
    "/explorer/rpc.php": (request) => {
      const answered = request.method === "POST"
        && request.headers.origin === `http://${request.headers.host}`
        && (request.headers["content-type"] ?? "") === "application/json";
      return {
        status: answered ? 200 : 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          answered
            ? { jsonrpc: "2.0", id: 1, result: "0x1" }
            : { jsonrpc: "2.0", id: null, error: { code: -32600, message: "not the page's own call" } },
        ),
      };
    },
  };
}

async function serve(table) {
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    // The proxy URL carries ?chain=..., so a route may be named by its path alone.
    const entry = table[url] ?? table[url.split("?")[0]];
    const route = typeof entry === "function" ? entry(request) : entry;
    response.writeHead(route?.status ?? (route ? 200 : 404), route?.headers ?? { "content-type": "text/html" });
    response.end(route?.body ?? "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runCheck(base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--base", base], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function check(table) {
  const host = await serve(table);
  try {
    return await runCheck(host.base);
  } finally {
    await host.close();
  }
}

test("a host serving the checkout's page passes all nine checks, CRLF and all", async () => {
  const result = await check(healthyHost());

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^ {2}ok {3}/gm)?.length, 9, result.stdout);
  assert.match(result.stdout, /9 checks passed/);
  assert.doesNotMatch(result.stdout, /FAIL/);
});

test("the directory still landing on the site root's index fails, naming both checks", async () => {
  const result = await check({ ...healthyHost(), "/explorer/": { body: DASHBOARD } });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL \/explorer\/ is explorer\/index\.html/);
  assert.match(result.stdout, /FAIL the page loads app\.js\?v=/);
  assert.match(result.stderr, /2 of 9 checks failed/);
});

test("an app.js cached for a year fails the revalidation check", async () => {
  const result = await check({
    ...healthyHost(),
    "/explorer/app.js": { body: CRLF_APP, headers: { "content-type": "text/javascript" } },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL app\.js is revalidated/);
  assert.match(result.stdout, /cache-control: \(none\)/);
  assert.match(result.stderr, /1 of 9 checks failed/);
});

test("scripts left behind by an earlier upload fail by name, page or not", async () => {
  // The page is the checkout's own and names the checkout's version, so before
  // these checks a host serving old scripts passed; only the lookups broke.
  const result = await check({
    ...healthyHost(),
    "/explorer/app.js": {
      body: "// the build an earlier upload left\n",
      headers: { "content-type": "text/javascript", "cache-control": "no-cache, must-revalidate" },
    },
    "/explorer/lookup-state.js": {
      body: "// the helpers an earlier upload left\n",
      headers: { "content-type": "text/javascript", "cache-control": "no-cache, must-revalidate" },
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL \/explorer\/app\.js is explorer\/app\.js/);
  assert.match(result.stdout, /FAIL \/explorer\/lookup-state\.js is explorer\/lookup-state\.js/);
  assert.doesNotMatch(result.stdout, /FAIL the page loads/);
  assert.match(result.stderr, /2 of 9 checks failed/);
});

test("a proxy that refuses the page's own origin fails the proxy check", async () => {
  // What the merged guard returns to a caller that is not the page, and what a
  // deploy that broke rpc.php would look like: every other check still passes,
  // the page silently falls back to the public endpoints, and this one fails.
  const result = await check({
    ...healthyHost(),
    "/explorer/rpc.php": {
      status: 403,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "this proxy answers the explorer page it is served with, not other callers" },
      }),
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL \/explorer\/rpc\.php answers eth_chainId/);
  assert.match(result.stdout, /HTTP 403, .*answers the explorer page/);
  assert.match(result.stderr, /1 of 9 checks failed/);
});

test("a base that is not an http URL is a usage error, not a failed check", async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--base", "not-a-url"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--base is not a URL/);
  assert.equal(result.stdout, "");
});
