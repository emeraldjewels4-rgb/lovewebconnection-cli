import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadTokenList } from "./balances.ts";
import {
  TokenFileArgError,
  buildTokenListJson,
  parseTokenFileArgs,
  saveTokenList,
} from "./tokenfile.ts";

const USDT = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";
const WOKB = "0xe538905cf8410324e03A5A23C1c177a474D59b2b";

function expectArgError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof TokenFileArgError && pattern.test(error.message),
  );
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lwc-tokenfile-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("collects positional and flagged addresses, checksummed and deduped", () => {
  const args = parseTokenFileArgs([
    USDT.toLowerCase(),
    "--token",
    WOKB,
    "--tokens",
    USDT,
    "--out",
    "./tokens.json",
  ]);

  assert.deepEqual(args.addresses, [USDT, WOKB], "order preserved, duplicate collapsed");
  assert.equal(args.outPath, "./tokens.json");
  assert.equal(args.force, false);
});

test("accepts --out=, --token=, --tokens=, and - for stdout", () => {
  const args = parseTokenFileArgs([
    `--tokens=${USDT},${WOKB}`,
    "--out=-",
    "--force",
    "--json",
  ]);

  assert.deepEqual(args.addresses, [USDT, WOKB]);
  assert.equal(args.outPath, "-");
  assert.equal(args.force, true, "--force is honoured and --json ignored");
  assert.equal(args.maxSubCalls, null, "verification uses its default batching");
});

test("parses --max-subcalls for the verification reads", () => {
  assert.equal(
    parseTokenFileArgs([USDT, "--out", "-", "--max-subcalls", "40"]).maxSubCalls,
    40,
  );
  assert.equal(parseTokenFileArgs([USDT, "--out", "-", "--max-subcalls=7"]).maxSubCalls, 7);
  expectArgError(
    () => parseTokenFileArgs([USDT, "--out", "-", "--max-subcalls", "0"]),
    /between 1 and 1000/,
  );
  expectArgError(
    () => parseTokenFileArgs([USDT, "--out", "-", "--max-subcalls", "1001"]),
    /between 1 and 1000/,
  );
  expectArgError(
    () => parseTokenFileArgs([USDT, "--out", "-", "--max-subcalls", "nope"]),
    /whole number/,
  );
  expectArgError(
    () => parseTokenFileArgs([USDT, "--out", "-", "--max-subcalls"]),
    /requires a value/,
  );
});

test("rejects a missing output path or address, and a malformed address", () => {
  expectArgError(() => parseTokenFileArgs([USDT]), /--out <path> is required/);
  expectArgError(() => parseTokenFileArgs(["--out", "./t.json"]), /at least one token address/);
  expectArgError(() => parseTokenFileArgs([USDT, "--out"]), /--out requires a path/);
  expectArgError(() => parseTokenFileArgs(["0xnot-an-address", "--out", "./t.json"]), /not a valid token address/);
  expectArgError(() => parseTokenFileArgs([USDT, "--token", "--out"]), /--token requires an address/);
  expectArgError(
    () => parseTokenFileArgs([`${USDT}=${"x".repeat(65)}`, "--out", "-"]),
    /label longer than 64 characters/,
  );
});

test("keeps inline labels in the written file", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    const args = parseTokenFileArgs([`${USDT}=Tether USD`, WOKB, "--out", path]);

    assert.deepEqual(args.entries, [
      { address: USDT, label: "Tether USD" },
      { address: WOKB, label: null },
    ]);
    assert.deepEqual(args.warnings, []);

    saveTokenList(path, args.entries);
    assert.deepEqual(loadTokenList(path), [
      { address: USDT, label: "Tether USD" },
      { address: WOKB, label: null },
    ]);
    assert.deepEqual(
      JSON.parse(readFileSync(path, "utf8")),
      [{ address: USDT, label: "Tether USD" }, WOKB],
      "unlabeled entries stay plain strings",
    );
  });
});

test("a repeated address keeps its first position and last label", () => {
  const args = parseTokenFileArgs([
    `${USDT}=First`,
    WOKB,
    `${USDT.toLowerCase()}:Second`,
    "--out",
    "-",
  ]);

  assert.deepEqual(args.addresses, [USDT, WOKB]);
  assert.deepEqual(args.entries, [
    { address: USDT, label: "Second" },
    { address: WOKB, label: null },
  ]);
  assert.equal(args.warnings.length, 1);
  assert.match(args.warnings[0] ?? "", /conflicting labels "First" and "Second"/);

  const same = parseTokenFileArgs([`${USDT}=Same`, `${USDT}=Same`, "--out", "-"]);
  assert.deepEqual(same.warnings, [], "an identical repeated label is not a conflict");
});

test("the written JSON is the format --tokens-file reads", () => {
  const json = buildTokenListJson([USDT, WOKB]);

  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    saveTokenList(path, [USDT, WOKB]);

    assert.deepEqual(loadTokenList(path), [
      { address: USDT, label: null },
      { address: WOKB, label: null },
    ]);
    assert.equal(readFileSync(path, "utf8"), json);
  });
});

test("creates parent directories and refuses to overwrite without --force", () => {
  withTempDir((dir) => {
    const path = join(dir, "nested", "deeper", "tokens.json");

    saveTokenList(path, [USDT]);
    assert.ok(existsSync(path));

    expectArgError(() => saveTokenList(path, [WOKB]), /already exists; pass --force/);
    assert.deepEqual(loadTokenList(path), [{ address: USDT, label: null }], "file untouched");

    saveTokenList(path, [WOKB], { force: true });
    assert.deepEqual(loadTokenList(path), [{ address: WOKB, label: null }]);
    assert.equal(existsSync(`${path}.tmp`), false, "no temporary file left behind");
  });
});

test("--merge appends new addresses and keeps the existing list", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    saveTokenList(path, [{ address: USDT, label: "Tether USD" }]);

    const args = parseTokenFileArgs([
      `${WOKB}=Wrapped OKB`,
      USDT,
      "--out",
      path,
      "--merge",
    ]);

    assert.equal(args.merge, true);
    assert.deepEqual(args.entries, [
      { address: USDT, label: "Tether USD" },
      { address: WOKB, label: "Wrapped OKB" },
    ]);
    assert.deepEqual(args.warnings, [], "an unlabeled repeat is not a conflict");

    saveTokenList(path, args.entries, { force: true });
    assert.deepEqual(loadTokenList(path), args.entries);
  });
});

test("--merge replaces a differing label and creates a missing file", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    saveTokenList(path, [{ address: USDT, label: "First" }]);

    const args = parseTokenFileArgs([`${USDT}=Second`, WOKB, "--out", path, "--merge"]);
    assert.deepEqual(args.entries, [
      { address: USDT, label: "Second" },
      { address: WOKB, label: null },
    ]);
    assert.equal(args.warnings.length, 1);
    assert.match(args.warnings[0] ?? "", /conflicting labels "First" and "Second"/);

    const missing = join(dir, "nested", "new.json");
    const created = parseTokenFileArgs([USDT, "--out", missing, "--merge"]);
    assert.deepEqual(created.entries, [{ address: USDT, label: null }]);
    assert.equal(existsSync(missing), false, "parsing writes nothing");
  });
});

test("--merge rejects stdout and an unreadable existing list", () => {
  expectArgError(
    () => parseTokenFileArgs([USDT, "--out", "-", "--merge"]),
    /--merge needs a file path/,
  );

  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    writeFileSync(path, "{not json");
    expectArgError(
      () => parseTokenFileArgs([USDT, "--out", path, "--merge"]),
      /is not valid JSON/,
    );
  });
});

test("stdout mode returns the list and writes nothing", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    const json = saveTokenList("-", [USDT]);

    assert.equal(json, buildTokenListJson([USDT]));
    assert.equal(existsSync(path), false);
  });
});
