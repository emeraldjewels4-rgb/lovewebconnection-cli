import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import { EXPLORER_FILES } from "../deploy/explorer-files.mjs";

// The uploader pastes --host into an ftp:// URL, so a character that the URL reads as user info, a
// port, a query, a fragment or an escape would move the upload somewhere else while the dry run
// still passed. The refusals and the empty-stdin path are the two ways it says "nothing was
// uploaded", and both are checked here without a socket: the one host that gets past the arguments
// points at 127.0.0.1 on a closed port, so a regression cannot leave the machine either.
const SCRIPT = join(import.meta.dirname, "..", "deploy", "explorer-ftp-upload.mjs");

function run(args, stdin = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    // The dry run never reads its stdin, so a closed pipe is expected rather than an error.
    child.stdin.on("error", () => {});
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

for (const [host, stray] of [
  ["a@b", "@"],
  ["b:2121", ":"],
  ["b?x", "?"],
  ["b#x", "#"],
  ["b%41", "%"],
]) {
  test(`--host refuses '${host}' and names ${stray}`, async () => {
    const result = await run(["--host", host, "--user", "account", "--dry-run"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--host must be a bare hostname/);
    assert.ok(result.stderr.includes(`(remove: ${stray})`), result.stderr);
    assert.match(result.stderr, /use --port for the port/);
    assert.equal(result.stdout, "");
  });
}

test("--host refuses a trailing hyphen without inventing a character to remove", async () => {
  const result = await run(["--host", "bad-", "--user", "account", "--dry-run"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--host must be a bare hostname/);
  assert.doesNotMatch(result.stderr, /remove:/);
});

test("stdin that ends before a line is refused, not counted as an upload", async () => {
  const result = await run(["--host", "127.0.0.1", "--port", "1", "--user", "account"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no password on stdin \(it ended before a line\); nothing was uploaded/);
  assert.doesNotMatch(result.stdout, /uploading to/);
});

test("a bare hostname still reaches the plan", async () => {
  const result = await run(["--host", "ftp.example.com", "--user", "account", "--dry-run"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`would upload ${EXPLORER_FILES.length} files`));
  assert.match(result.stdout, /dry run: arguments and local files check out/);
});
