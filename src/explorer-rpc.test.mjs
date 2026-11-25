import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// explorer/rpc.php is unauthenticated, so its refusals are the only thing between a
// stranger and this account's RPC quota. They are checked here against a real PHP
// server: the guards run before any upstream call, and a small local HTTPS fixture
// covers the two paths that do reach one (a normal answer and an oversized answer).
// Nothing here leaves loopback. PHP is not part of the toolchain, so the file skips
// itself when no interpreter is found; LWC_PHP points at one elsewhere.
const PHP = process.env.LWC_PHP ?? "php";
const REPO = join(import.meta.dirname, "..");
const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 1048576;

function have(binary, args) {
  try {
    return spawnSync(binary, args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** A port nothing is listening on, for the PHP server and the HTTPS fixture. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no answer from ${url}`);
}

// Both tools are needed: php runs rpc.php, openssl makes the fixture certificate that
// the success and cap cases need, because the proxy only talks to https endpoints.
const skip = !have(PHP, ["-v"])
  ? "php is not installed; set LWC_PHP to a php binary"
  : !have("openssl", ["version"])
    ? "openssl is not installed, so the fixture certificate cannot be made"
    : false;
let work;
let php;
let upstream;
let proxy;

before(async () => {
  if (skip) return;
  work = await mkdtemp(join(tmpdir(), "lwc-rpc-"));
  const cert = join(work, "cert.pem");
  const key = join(work, "key.pem");
  const made = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdio: "ignore" },
  );
  if (made.status !== 0) {
    throw new Error("openssl is present but could not make the fixture certificate");
  }

  // The fixture answers every method with a small result, except eth_getCode, which
  // answers past the proxy's cap so the abort path can be exercised, and
  // eth_getBlockByNumber, which answers the hash-list shape app.js asks for at the
  // size of a busy L2 block: thousands of hashes, well past the old 256 KiB cap and
  // comfortably inside the current one.
  upstream = createHttpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        let method = "";
        try {
          method = JSON.parse(raw).method ?? "";
        } catch {
          // a body this fixture cannot read is answered as if it were small
        }
        const hashes = Array.from({ length: 5000 }, (_, index) =>
          `0x${index.toString(16).padStart(64, "0")}`,
        );
        const body = method === "eth_getCode"
          ? { jsonrpc: "2.0", id: 1, result: `0x${"ab".repeat(700 * 1024)}` }
          : method === "eth_getBlockByNumber"
            ? { jsonrpc: "2.0", id: 1, result: { number: "0x1", transactions: hashes } }
            : { jsonrpc: "2.0", id: 1, result: "0x1" };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
    },
  );
  const upstreamPort = await freePort();
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));

  // A copy of the folder with one chain pointing at the fixture: rpc.php reads
  // presets.json from its own directory, and only https endpoints are accepted.
  const docroot = join(work, "public");
  await cp(join(REPO, "explorer"), docroot, { recursive: true });
  await writeFile(
    join(docroot, "presets.json"),
    JSON.stringify({ chains: [{ name: "test", endpoints: [`https://127.0.0.1:${upstreamPort}`] }] }),
  );

  const phpPort = await freePort();
  php = spawn(PHP, ["-S", `127.0.0.1:${phpPort}`, "-t", docroot], {
    // Trusts the fixture certificate only, for this child process: the proxy's own
    // certificate verification is untouched.
    env: { ...process.env, SSL_CERT_FILE: cert },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proxy = `http://127.0.0.1:${phpPort}/rpc.php?chain=test`;
  await waitFor(proxy);
});

after(async () => {
  php?.kill();
  await new Promise((resolve) => (upstream ? upstream.close(resolve) : resolve()));
  if (work) await rm(work, { recursive: true, force: true });
});

function post(body, options = {}) {
  return fetch(proxy, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const call = (method, params = [], extra = {}) => ({ jsonrpc: "2.0", id: 1, method, params, ...extra });

test("a GET is refused with 405", { skip }, async () => {
  const response = await fetch(proxy);
  assert.equal(response.status, 405);
  assert.match(await response.text(), /use POST/);
});

test("a form-encodable content type is refused with 415", { skip }, async () => {
  const response = await post(JSON.stringify(call("eth_chainId")), {
    headers: { "content-type": "text/plain" },
  });

  assert.equal(response.status, 415);
  const body = await response.json();
  assert.equal(body.error.message, "content-type must be application/json");
});

test("another origin is refused with 403", { skip }, async () => {
  const response = await post(call("eth_chainId"), { headers: { origin: "https://evil.example" } });

  assert.equal(response.status, 403);
  assert.match(await response.text(), /only answers its own page/);
});

test("a body past the request cap is refused with 413 before it is read", { skip }, async () => {
  const padding = "a".repeat(MAX_REQUEST_BYTES);
  const response = await post(call("eth_chainId", [padding]));

  assert.equal(response.status, 413);
  assert.match(await response.text(), new RegExp(`over ${MAX_REQUEST_BYTES} bytes`));
});

test("a method outside the narrowed set is refused with 400", { skip }, async () => {
  for (const method of ["eth_feeHistory", "eth_estimateGas", "eth_getLogs", "eth_sendRawTransaction"]) {
    const response = await post(call(method));

    assert.equal(response.status, 400, method);
    assert.match(await response.text(), /read-only set/, method);
  }
});

test("an allowed method gets past the gates to the chain lookup", { skip }, async () => {
  // No upstream call: the chain is unknown, which is only reached if the origin,
  // content-type, size and method gates all let the request through.
  const response = await fetch(proxy.replace("chain=test", "chain=nope"), {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${new URL(proxy).port}` },
    body: JSON.stringify(call("eth_chainId")),
  });

  assert.equal(response.status, 400);
  assert.match(await response.text(), /unknown chain/);
});

test("a same-origin request is answered by the primary endpoint", { skip }, async () => {
  const response = await post(call("eth_chainId"), {
    headers: { origin: `http://127.0.0.1:${new URL(proxy).port}` },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lwc-via"), "primary");
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: "0x1" });
});

test("a block whose hash list is past the old cap still relays whole", { skip }, async () => {
  // 5,000 hashes is roughly 350 KB: bigger than the 256 KiB cap this started with,
  // which would have broken the block view on a busy chain, and smaller than a
  // real eth_getBlockByNumber [number, false] answer for thousands of transactions.
  const response = await post(call("eth_getBlockByNumber", ["latest", false]));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.result.transactions.length, 5000);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 262144, "the fixture must exceed the old cap");
});

test("an answer past the response cap is refused instead of relayed", { skip }, async () => {
  const response = await post(call("eth_getCode", ["0x0000000000000000000000000000000000000001", "latest"]));

  assert.equal(response.status, 502);
  assert.match(await response.text(), new RegExp(`answer over ${MAX_RESPONSE_BYTES} bytes`));
});
