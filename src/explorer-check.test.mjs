import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// deploy/explorer-check.mjs only sends GETs, so its six checks can be run against a loopback server:
// no host, no network egress, nothing written. The page is served with CRLF on purpose, because a
// file manager upload can store it that way and the check is meant to ignore that difference.
const SCRIPT = join(import.meta.dirname, "..", "deploy", "explorer-check.mjs");
const PAGE = await readFile(join(import.meta.dirname, "..", "explorer", "index.html"), "utf8");
const CRLF_PAGE = PAGE.replace(/\n/g, "\r\n");
const DASHBOARD = "<!doctype html><title>dashboard</title>";

/** The healthy host: the page, its script, the dashboard, and a 404 for anything else. */
function healthyHost() {
  return {
    "/": { body: DASHBOARD },
    "/explorer/": { body: CRLF_PAGE },
    "/explorer/app.js": {
      body: "export {};\n",
      headers: { "content-type": "text/javascript", "cache-control": "no-cache, must-revalidate" },
    },
  };
}

async function serve(table) {
  const server = createServer((request, response) => {
    const route = table[request.url ?? ""];
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

test("a host serving the checkout's page passes all six checks, CRLF and all", async () => {
  const result = await check(healthyHost());

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^ {2}ok {3}/gm)?.length, 6, result.stdout);
  assert.match(result.stdout, /6 checks passed/);
  assert.doesNotMatch(result.stdout, /FAIL/);
});

test("the directory still landing on the site root's index fails, naming both checks", async () => {
  const result = await check({ ...healthyHost(), "/explorer/": { body: DASHBOARD } });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL \/explorer\/ is explorer\/index\.html/);
  assert.match(result.stdout, /FAIL the page loads app\.js\?v=/);
  assert.match(result.stderr, /2 of 6 checks failed/);
});

test("an app.js cached for a year fails the revalidation check", async () => {
  const result = await check({
    ...healthyHost(),
    "/explorer/app.js": { body: "export {};\n", headers: { "content-type": "text/javascript" } },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL app\.js is revalidated/);
  assert.match(result.stdout, /cache-control: \(none\)/);
  assert.match(result.stderr, /1 of 6 checks failed/);
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
