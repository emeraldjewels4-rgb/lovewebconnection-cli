import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CacheArgError,
  formatMetadataCache,
  inspectMetadataCache,
  parseCacheArgs,
  toCacheJson,
} from "./cache.ts";
import type { ChainConfig } from "./chain.ts";
import { MetadataCache } from "./metadata-cache.ts";

const USDT = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";
const WOKB = "0xe538905cf8410324e03A5A23C1c177a474D59b2b";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const MISSING = "0x0000000000000000000000000000000000000001";

const config: ChainConfig = {
  chainId: 196,
  name: "xlayer",
  rpcUrl: "https://xlayer.drpc.org",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  authHeader: null,
  preset: "xlayer",
  timeoutMs: 15_000,
};

function withCache(
  entries: Record<string, { symbol: string; decimals: number; cachedAt?: number }>,
  fn: (cache: MetadataCache, path: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "lwc-cache-command-"));
  try {
    const path = join(dir, "tokens.json");
    writeFileSync(path, JSON.stringify({ version: 2, chains: { "196": entries } }));
    fn(new MetadataCache({ chainId: 196, path }), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parses repeated and comma-separated --clear addresses", () => {
  assert.deepEqual(parseCacheArgs([]), { clear: [] });
  assert.deepEqual(
    parseCacheArgs([
      "--clear",
      USDT,
      "--clear",
      `${WOKB},${USDT.toLowerCase()}`,
      "--json",
    ]).clear,
    [USDT, WOKB],
  );
  assert.deepEqual(parseCacheArgs([`--clear=${WOKB}`]).clear, [WOKB]);

  assert.throws(() => parseCacheArgs(["--clear"]), CacheArgError);
  assert.throws(() => parseCacheArgs(["--clear", "nope"]), CacheArgError);
  assert.throws(() => parseCacheArgs([USDT]), /no positional arguments/);
});

test("lists cached ages oldest first and clears selected entries", () => {
  withCache(
    {
      [USDT.toLowerCase()]: { symbol: "USDT", decimals: 6, cachedAt: 7_000 },
      [WOKB.toLowerCase()]: { symbol: "WOKB", decimals: 18, cachedAt: 9_000 },
      [DEAD.toLowerCase()]: { symbol: "DEAD", decimals: 18 },
    },
    (cache, path) => {
      const report = inspectMetadataCache(
        cache,
        config,
        path,
        { clear: [WOKB, MISSING] },
        10_000,
      );

      assert.deepEqual(
        report.entries.map((entry) => entry.symbol),
        ["DEAD", "USDT"],
        "undated entries sort first, then oldest",
      );
      assert.deepEqual(
        report.removed.map((entry) => entry.address),
        [WOKB],
      );
      assert.equal(report.removed[0]?.ageMs, 1_000);
      assert.equal(report.warnings.length, 1, "an uncached address is a warning");
      assert.match(report.warnings[0] ?? "", /0x0000…0001 is not in the xlayer/);

      const text = formatMetadataCache(report);
      assert.match(text, /entries\s+2/);
      assert.match(text, /removed\s+1/);
      assert.match(text, /DEAD \(18 decimals\)\s+age unknown/);
      assert.match(text, /USDT \(6 decimals\)\s+cached 3s/);

      const json = toCacheJson(report) as {
        entries: Array<{ symbol: string; ageMs: number | null }>;
        removed: Array<{ symbol: string }>;
        warnings: string[];
      };
      assert.deepEqual(
        json.entries.map((entry) => [entry.symbol, entry.ageMs]),
        [
          ["DEAD", null],
          ["USDT", 3_000],
        ],
      );
      assert.deepEqual(
        json.removed.map((entry) => entry.symbol),
        ["WOKB"],
      );
      assert.equal(json.warnings.length, 1);

      assert.equal(cache.save(), null);
      const reloaded = new MetadataCache({ chainId: 196, path });
      assert.equal(reloaded.get(WOKB), null, "the cleared entry is persisted");
      assert.deepEqual(reloaded.get(USDT), { symbol: "USDT", decimals: 6 });
    },
  );
});

test("formats an empty cache without a token table", () => {
  const report = inspectMetadataCache(
    new MetadataCache({ chainId: 196, persist: false }),
    config,
    "empty.json",
    { clear: [] },
  );

  assert.equal(report.entries.length, 0);
  assert.match(formatMetadataCache(report), /entries\s+0/);
  assert.match(formatMetadataCache(report), /no cached token metadata for this chain/);
  assert.deepEqual(
    (toCacheJson(report) as { entries: unknown[] }).entries,
    [],
  );
});
