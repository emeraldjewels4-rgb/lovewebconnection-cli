import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// A fake curl first on PATH records its arguments and exits 0, so the upload's argv can be read
// without a socket: the property that matters is that every transfer asks for explicit TLS, which is
// what keeps the password off a plaintext connection. It needs a POSIX shell, so Windows skips it.
test(
  "every transfer requires TLS, so the password cannot go out in the clear",
  { skip: process.platform === "win32" ? "needs a POSIX shell to stand in for curl" : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "lwc-curl-"));
    const argvLog = join(dir, "argv.log");
    try {
      await writeFile(join(dir, "curl"), `#!/bin/sh\necho "$@" >> "${argvLog}"\ncat > /dev/null\n`, {
        mode: 0o755,
      });

      const result = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [SCRIPT, "--host", "127.0.0.1", "--port", "1", "--user", "account"],
          {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
        child.stdin.end("password\n");
      });

      assert.equal(result.status, 0, result.stderr);
      const transfers = (await readFile(argvLog, "utf8")).trim().split("\n");
      assert.equal(transfers.length, EXPLORER_FILES.length);
      for (const transfer of transfers) assert.ok(transfer.includes("--ssl-reqd"), transfer);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
