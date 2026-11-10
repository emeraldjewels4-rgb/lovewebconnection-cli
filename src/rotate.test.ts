import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RotatingLog } from "./rotate.ts";
import { WatchArgError, parseLogSize, parseWatchArgs } from "./watch.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lwc-rotate-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rotates to .1 once the next line would pass the limit", () => {
  withTempDir((dir) => {
    const path = join(dir, "watch.ndjson");
    // Each "1234567890\n" line is 11 bytes: 10 digits plus the newline.
    const log = new RotatingLog({ path, maxBytes: 22 });

    log.append("1234567890\n");
    log.append("1234567890\n");
    assert.equal(existsSync(`${path}.1`), false, "filling to exactly the limit does not rotate");

    log.append("x\n");

    assert.equal(readFileSync(`${path}.1`, "utf8"), "1234567890\n1234567890\n");
    assert.equal(readFileSync(path, "utf8"), "x\n");
    assert.equal(statSync(path).size, 2);
  });
});

test("keeps a single backup across repeated rotations", () => {
  withTempDir((dir) => {
    const path = join(dir, "watch.ndjson");
    const log = new RotatingLog({ path, maxBytes: 12 });

    log.append("first\n");
    log.append("second\n"); // would make 12 exactly? first(6)+second(7)=13 → rotates
    log.append("third\n");
    log.append("fourth\n");

    assert.equal(readFileSync(`${path}.1`, "utf8"), "third\n");
    assert.equal(existsSync(`${path}.2`), false, "older generations are discarded");
    assert.equal(readFileSync(path, "utf8"), "fourth\n");
  });
});

test("counts an existing file when the writer starts", () => {
  withTempDir((dir) => {
    const path = join(dir, "watch.ndjson");
    writeFileSync(path, "0123456789012345678901234567890"); // 31 bytes

    const log = new RotatingLog({ path, maxBytes: 30 });
    log.append("a");

    assert.equal(readFileSync(`${path}.1`, "utf8").length, 31);
    assert.equal(readFileSync(path, "utf8"), "a\n", "a missing newline is added");
  });
});

test("appends without rotating when disabled or when one line is oversized", () => {
  withTempDir((dir) => {
    const path = join(dir, "watch.ndjson");
    const disabled = new RotatingLog({ path, maxBytes: 0 });
    disabled.append("x".repeat(1000));
    assert.equal(existsSync(`${path}.1`), false);
    assert.equal(statSync(path).size, 1001);

    const small = new RotatingLog({ path: join(dir, "small.ndjson"), maxBytes: 5 });
    small.append("0123456789\n");
    assert.equal(
      readFileSync(join(dir, "small.ndjson"), "utf8"),
      "0123456789\n",
      "an oversized line is written rather than looped on",
    );
  });
});

test("parseLogSize understands suffixes and defaults bare numbers to megabytes", () => {
  assert.equal(parseLogSize("1024b"), 1024);
  assert.equal(parseLogSize("512kb"), 512 * 1024);
  assert.equal(parseLogSize("2mb"), 2 * 1024 ** 2);
  assert.equal(parseLogSize("1gb"), 1024 ** 3);
  assert.equal(parseLogSize("5"), 5 * 1024 ** 2);
  assert.equal(parseLogSize("1.5mb"), Math.round(1.5 * 1024 ** 2));

  for (const bad of ["", "abc", "1tb", "0", "-1mb", "1.2.3mb"]) {
    assert.throws(
      () => parseLogSize(bad),
      (error: unknown) => error instanceof WatchArgError,
      `"${bad}" should be rejected`,
    );
  }
});

test("parseWatchArgs takes a rotation limit and requires --log", () => {
  assert.equal(parseWatchArgs(["--log", "w.ndjson"]).logMaxBytes, 0, "off by default");
  assert.equal(parseWatchArgs(["--log", "w.ndjson", "--log-max-size", "2kb"]).logMaxBytes, 2048);
  assert.equal(parseWatchArgs(["--log=w.ndjson", "--log-max-size=3mb"]).logMaxBytes, 3 * 1024 ** 2);

  assert.throws(
    () => parseWatchArgs(["--log-max-size", "2kb"]),
    (error: unknown) => error instanceof WatchArgError && /needs --log/.test(error.message),
  );
  assert.throws(
    () => parseWatchArgs(["--log", "w.ndjson", "--log-max-size", "0"]),
    (error: unknown) => error instanceof WatchArgError && /at least/.test(error.message),
  );
});
