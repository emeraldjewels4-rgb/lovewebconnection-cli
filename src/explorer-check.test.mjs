import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// deploy/explorer-check.mjs sends only GETs apart from one same-origin POST to rpc.php, so its eleven
// checks can be run against a loopback server: no host, no network egress, nothing written. The page
// and its four assets are served exactly as the checkout holds them, because an upload that stored
// CRLF or dropped the final newline is a different file and has to fail.
const SCRIPT = join(import.meta.dirname, "..", "deploy", "explorer-check.mjs");
const SOURCE = join(import.meta.dirname, "..", "explorer");
const PAGE = await readFile(join(SOURCE, "index.html"), "utf8");
const APP = await readFile(join(SOURCE, "app.js"), "utf8");
const STATE = await readFile(join(SOURCE, "lookup-state.js"), "utf8");
const STYLE = await readFile(join(SOURCE, "style.css"), "utf8");
const PRESETS = await readFile(join(SOURCE, "presets.json"), "utf8");
const README = await readFile(join(SOURCE, "README.md"), "utf8");
// What a file manager upload can leave behind: the same text re-encoded, or minus
// its final newline. Both are differences the check has to report, not skip.
const CRLF_PAGE = PAGE.replace(/\n/g, "\r\n");
const DASHBOARD = "<!doctype html><title>dashboard</title>";

/** The healthy host: the page, its script, the dashboard, and a 404 for anything else. */
function healthyHost() {
  return {
    "/": { body: DASHBOARD },
    "/explorer/": { body: PAGE },
    "/explorer/app.js": {
      body: APP,
      headers: { "content-type": "text/javascript", "cache-control": "no-cache, must-revalidate" },
    },
    "/explorer/lookup-state.js": {
      body: STATE,
      headers: { "content-type": "text/javascript", "cache-control": "no-cache, must-revalidate" },
    },
    "/explorer/style.css": {
      body: STYLE,
      headers: { "content-type": "text/css", "cache-control": "no-cache, must-revalidate" },
    },
    "/explorer/presets.json": {
      body: PRESETS,
      headers: { "content-type": "application/json", "cache-control": "no-cache, must-revalidate" },
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

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runCheck(base) {
  return runScript(["--base", base]);
}

async function check(table) {
  const host = await serve(table);
  try {
    return await runCheck(host.base);
  } finally {
    await host.close();
  }
}

/** CHECK_COUNT and the files the script compares, read out of its own source. */
async function checkFacts() {
  const source = await readFile(SCRIPT, "utf8");
  const count = Number(/const CHECK_COUNT = (\d+);/.exec(source)?.[1]);
  assert.ok(Number.isInteger(count) && count > 0, "CHECK_COUNT is declared in the script");
  const compared = [...source.matchAll(/join\(SOURCE_DIR, "([^"]+)"\)/g)].map(([, name]) => name);
  assert.ok(compared.length > 0, "the script reads its files through SOURCE_DIR");
  return { count, compared };
}

/**
 * A numbered list written by hand has to agree with the script it describes: the
 * numbers run 1 to CHECK_COUNT, and the files it names are exactly the ones the
 * script compares, so a check inserted without renumbering, an entry dropped, or
 * a file listed that nothing compares fails here rather than in a deploy.
 */
function assertListMatchesChecks(entries, compared, count, where) {
  assert.deepEqual(
    entries.map((entry) => entry.number),
    Array.from({ length: count }, (_, index) => index + 1),
    `${where} runs 1 to CHECK_COUNT with no gaps or repeats`,
  );

  const named = entries.flatMap((entry) => entry.text.match(/[\w-]+\.(?:html|js|css|json)\b/g) ?? []);
  for (const name of named) {
    assert.ok(compared.includes(name), `${where} names ${name}, which the script compares`);
  }
  for (const name of compared) {
    assert.ok(named.includes(name), `${name} is compared, so ${where} names it`);
  }
}

test("a host serving the checkout's files passes all eleven checks", async () => {
  const result = await check(healthyHost());

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^ {2}ok {3}/gm)?.length, 11, result.stdout);
  assert.match(result.stdout, /11 checks passed/);
  assert.doesNotMatch(result.stdout, /FAIL/);
});

test("a host that stored CRLF fails, and the detail names the line endings", async () => {
  // The failure the check used to wave through: the text is the checkout's, so
  // every size matches, and only the bytes a browser parses are different.
  const result = await check({ ...healthyHost(), "/explorer/": { body: CRLF_PAGE } });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL \/explorer\/ is explorer\/index\.html/);
  assert.match(result.stdout, /B served, 3362 B in the checkout; line endings are CRLF, the checkout's are LF/);
  assert.match(result.stderr, /1 of 11 checks failed/);
});

test("an upload that dropped the final newline fails, and the detail names it", async () => {
  const result = await check({
    ...healthyHost(),
    "/explorer/lookup-state.js": {
      body: STATE.replace(/\n$/, ""),
      headers: { "content-type": "text/javascript", "cache-control": "no-cache, must-revalidate" },
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL \/explorer\/lookup-state\.js is explorer\/lookup-state\.js/);
  assert.match(result.stdout, /4091 B served, 4092 B in the checkout/);
  assert.match(result.stdout, /the served copy has no final newline/);
  assert.match(result.stderr, /1 of 11 checks failed/);
});

test("the directory still landing on the site root's index fails, naming both checks", async () => {
  const result = await check({ ...healthyHost(), "/explorer/": { body: DASHBOARD } });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL \/explorer\/ is explorer\/index\.html/);
  assert.match(result.stdout, /FAIL the page loads app\.js\?v=/);
  assert.match(result.stderr, /2 of 11 checks failed/);
});

test("an app.js cached for a year fails the revalidation check", async () => {
  const result = await check({
    ...healthyHost(),
    "/explorer/app.js": { body: APP, headers: { "content-type": "text/javascript" } },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL app\.js is revalidated/);
  assert.match(result.stdout, /cache-control: \(none\)/);
  assert.match(result.stderr, /1 of 11 checks failed/);
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
  assert.match(result.stderr, /2 of 11 checks failed/);
});

test("a stale stylesheet or preset list fails by name too", async () => {
  // Neither file is versioned by a query the page names, so before these checks
  // a host could restyle the explorer or drop a chain and still pass.
  const result = await check({
    ...healthyHost(),
    "/explorer/style.css": {
      body: "/* the stylesheet an earlier upload left */\n",
      headers: { "content-type": "text/css", "cache-control": "no-cache, must-revalidate" },
    },
    "/explorer/presets.json": {
      body: JSON.stringify({ chains: [{ name: "ethereum", id: 1 }] }),
      headers: { "content-type": "application/json", "cache-control": "no-cache, must-revalidate" },
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL \/explorer\/style\.css is explorer\/style\.css/);
  assert.match(result.stdout, /FAIL \/explorer\/presets\.json is explorer\/presets\.json/);
  assert.doesNotMatch(result.stdout, /FAIL the page loads/);
  assert.match(result.stderr, /2 of 11 checks failed/);
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
  assert.match(result.stderr, /1 of 11 checks failed/);
});

test("the usage list numbers every check once and names only compared files", async () => {
  // The help list is written by hand beside the checks it describes, so a check
  // inserted without renumbering, or one dropped from the list, would otherwise
  // drift silently.
  const { count, compared } = await checkFacts();

  const result = await runScript(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  // Only the numbered entries start a check's line; a wrapped entry continues on
  // an indented line of its own, so those are not counted twice. The numbers are
  // padded to the same column, so a one-digit entry has two spaces after it and a
  // two-digit one a single space.
  const entries = [...result.stdout.matchAll(/^ {2}(\d+) +(.+)$/gm)].map(([, number, text]) => ({
    number: Number(number),
    text,
  }));

  assertListMatchesChecks(entries, compared, count, "the usage list");
});

test("the README's check list matches the script too", async () => {
  // The README numbers the checks by hand as well, and nothing else ties that
  // list to the code. It lives under step 5 and ends at the next section, so the
  // numbered cPanel and SSH steps elsewhere in the file are not read as checks.
  const { count, compared } = await checkFacts();

  const start = README.indexOf("**5. Check what the host now serves.**");
  assert.notEqual(start, -1, "the README has a step 5 for the check");
  const end = README.indexOf("\n### ", start);
  const section = README.slice(start, end === -1 ? undefined : end);
  const entries = [...section.matchAll(/^(\d+)\. (.+)$/gm)].map(([, number, text]) => ({
    number: Number(number),
    text,
  }));

  assertListMatchesChecks(entries, compared, count, "the README's check list");
});

test("every check count the README spells out is CHECK_COUNT", async () => {
  // Beyond the list, the README quotes the total in prose - how many pass, how
  // many fail, and how many make up the gate - so adding a check to the script
  // would leave those sentences quoting an old number. Every count is collected,
  // in digits or in words, and compared.
  const { count } = await checkFacts();
  const words = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  const digits = [
    ...[...README.matchAll(/(\d+) checks? (?:passed|failed)/g)].map(([text, n]) => ({ text, value: Number(n) })),
    ...[...README.matchAll(/(\d+) of (\d+) checks/g)].flatMap(([text, ...ns]) =>
      ns.map((n) => ({ text, value: Number(n) })),
    ),
  ];
  const spelled = [...README.matchAll(/\b([a-z]+) checks\b/gi)]
    .filter(([, word]) => word.toLowerCase() in words)
    .map(([text, word]) => ({ text, value: words[word.toLowerCase()] }));

  // If either form of count stopped being found, the test would quietly stop
  // covering it, so both are required to appear at least once.
  assert.ok(digits.length >= 2, `the README states a count in digits (${digits.length} found)`);
  assert.ok(spelled.length >= 1, `the README states a count in words (${spelled.length} found)`);
  for (const { text, value } of [...digits, ...spelled]) {
    assert.equal(value, count, `"${text}" says ${value}, the script runs ${count}`);
  }
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
