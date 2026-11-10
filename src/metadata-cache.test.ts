import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_CACHE_PATH,
  MetadataCache,
  parseCacheAge,
  resolveCachePath,
} from "./metadata-cache.ts";

const USDT = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";
const WOKB = "0xe538905cf8410324e03A5A23C1c177a474D59b2b";
const DEAD = "0x000000000000000000000000000000000000dEaD";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lwc-cache-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("round-trips metadata through the cache file", () => {
  withTempDir((dir) => {
    const path = join(dir, "nested", "tokens.json");
    const cache = new MetadataCache({ chainId: 196, path });

    assert.equal(cache.get(USDT), null, "a missing cache is not an error");
    cache.set(USDT.toLowerCase(), { symbol: " USDT ", decimals: 6 });
    assert.equal(cache.save(), null);
    assert.ok(existsSync(path));

    const reloaded = new MetadataCache({ chainId: 196, path });
    assert.deepEqual(reloaded.get(USDT.toLowerCase()), { symbol: "USDT", decimals: 6 });
    assert.equal(reloaded.get(WOKB), null);
  });
});

test("records when an entry was cached and reports its age", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    const cache = new MetadataCache({ chainId: 196, path, now: () => 1_000 });

    cache.set(USDT, { symbol: "USDT", decimals: 6 });
    assert.equal(cache.ageMs(USDT, 1_250), 250);
    assert.equal(cache.ageMs(USDT, 900), 0, "a future timestamp clamps to zero");
    assert.equal(cache.save(), null);

    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      chains: Record<string, Record<string, { cachedAt: number }>>;
    };
    assert.equal(parsed.version, 2);
    assert.equal(parsed.chains["196"]?.[USDT.toLowerCase()]?.cachedAt, 1_000);

    const reloaded = new MetadataCache({ chainId: 196, path });
    assert.equal(reloaded.ageMs(USDT, 1_250), 250, "age survives a reload");
  });
});

test("legacy entries have no age until refreshed", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        chains: { "196": { [USDT]: { symbol: "USDT", decimals: 6 } } },
      }),
    );

    const cache = new MetadataCache({ chainId: 196, path, now: () => 2_000 });
    assert.deepEqual(cache.get(USDT), { symbol: "USDT", decimals: 6 });
    assert.equal(cache.ageMs(USDT), null, "a version-1 entry has no timestamp");

    assert.equal(cache.invalidate(USDT), true);
    assert.equal(cache.get(USDT), null);
    assert.equal(cache.invalidate(USDT), false, "invalidating a missing entry is a no-op");

    cache.set(USDT, { symbol: "USDT", decimals: 6 });
    assert.equal(cache.ageMs(USDT, 2_500), 500);
  });
});

test("keeps chains separate in one file", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");

    const mainnet = new MetadataCache({ chainId: 196, path });
    mainnet.set(USDT, { symbol: "USDT", decimals: 6 });
    assert.equal(mainnet.save(), null);

    const otherChain = new MetadataCache({ chainId: 1, path });
    assert.equal(otherChain.get(USDT), null, "an entry for another chain is invisible");
    otherChain.set(WOKB, { symbol: "WOKB", decimals: 18 });
    assert.equal(otherChain.save(), null);

    assert.deepEqual(new MetadataCache({ chainId: 196, path }).get(USDT), {
      symbol: "USDT",
      decimals: 6,
    });
    assert.deepEqual(new MetadataCache({ chainId: 1, path }).get(WOKB), {
      symbol: "WOKB",
      decimals: 18,
    });
    assert.equal(new MetadataCache({ chainId: 1, path }).get(USDT), null);
  });
});

test("ignores a corrupt file and unusable entries", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    writeFileSync(path, "{not json");

    const cache = new MetadataCache({ chainId: 196, path });
    assert.equal(cache.get(USDT), null);
    cache.set(USDT, { symbol: "USDT", decimals: 6 });
    assert.equal(cache.save(), null, "a damaged cache is replaced, not fatal");

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        chains: {
          "196": {
            [USDT]: { symbol: "USDT", decimals: 6 },
            [WOKB]: { symbol: "WOKB", decimals: "eighteen" },
            [DEAD]: { symbol: "   ", decimals: 18 },
            "0xnot-an-address": { symbol: "BAD", decimals: 18 },
            "0x0000000000000000000000000000000000000001": { symbol: "BAD", decimals: 99 },
          },
        },
      }),
    );

    const reloaded = new MetadataCache({ chainId: 196, path });
    assert.deepEqual(reloaded.get(USDT), { symbol: "USDT", decimals: 6 });
    assert.equal(reloaded.get(WOKB), null, "a non-numeric decimals is dropped");
    assert.equal(reloaded.get(DEAD), null, "a blank symbol is dropped");
    assert.equal(reloaded.get("0x0000000000000000000000000000000000000001"), null);
  });
});

test("persist: false stays in memory and writes nothing", () => {
  withTempDir((dir) => {
    const path = join(dir, "never", "tokens.json");
    const cache = new MetadataCache({ chainId: 196, path, persist: false });

    cache.set(USDT, { symbol: "USDT", decimals: 6 });

    assert.deepEqual(cache.get(USDT), { symbol: "USDT", decimals: 6 });
    assert.equal(cache.save(), null);
    assert.equal(existsSync(path), false);
  });
});

test("save writes only when something changed", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    const cache = new MetadataCache({ chainId: 196, path });

    assert.equal(cache.save(), null, "nothing to write yet");
    assert.equal(existsSync(path), false);

    cache.set(USDT, { symbol: "USDT", decimals: 6 });
    assert.equal(cache.save(), null);
    const first = readFileSync(path, "utf8");

    cache.set(USDT, { symbol: "USDT", decimals: 6 });
    assert.equal(cache.save(), null, "an identical entry is not a change");
    assert.equal(readFileSync(path, "utf8"), first);
  });
});

test("parses cache ages only with an explicit unit", () => {
  assert.deepEqual(parseCacheAge("30s"), { ok: true, ms: 30_000 });
  assert.deepEqual(parseCacheAge("15m"), { ok: true, ms: 900_000 });
  assert.deepEqual(parseCacheAge("12h"), { ok: true, ms: 43_200_000 });
  assert.deepEqual(parseCacheAge("7d"), { ok: true, ms: 604_800_000 });
  assert.deepEqual(parseCacheAge("2w"), { ok: true, ms: 1_209_600_000 });
  assert.equal(parseCacheAge("30").ok, false, "a bare number is ambiguous");
  assert.equal(parseCacheAge("0d").ok, false);
  assert.equal(parseCacheAge("soon").ok, false);
  assert.equal(parseCacheAge("-1d").ok, false);
});

test("invalidateStale drops old and undated entries", () => {
  withTempDir((dir) => {
    const path = join(dir, "tokens.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        chains: {
          "196": {
            [USDT]: { symbol: "USDT", decimals: 6, cachedAt: 9_000 },
            [WOKB]: { symbol: "WOKB", decimals: 18, cachedAt: 100 },
            [DEAD]: { symbol: "DEAD", decimals: 18 },
          },
        },
      }),
    );

    const cache = new MetadataCache({ chainId: 196, path });
    assert.equal(cache.invalidateStale(5_000, 10_000), 2, "old and undated entries are dropped");
    assert.deepEqual(cache.get(USDT), { symbol: "USDT", decimals: 6 });
    assert.equal(cache.get(WOKB), null);
    assert.equal(cache.get(DEAD), null);
    assert.equal(cache.invalidateStale(5_000, 10_000), 0, "a second pass finds nothing stale");

    assert.equal(cache.save(), null);
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      chains: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(saved.chains["196"] ?? {}), [USDT.toLowerCase()]);
  });
});

test("resolveCachePath prefers the flag, then the environment, then the default", () => {
  assert.equal(resolveCachePath(null, {}), DEFAULT_CACHE_PATH);
  assert.equal(resolveCachePath("  ", {}), DEFAULT_CACHE_PATH);
  assert.equal(resolveCachePath(null, { LWC_CACHE_FILE: "/tmp/lwc.json" }), "/tmp/lwc.json");
  assert.equal(resolveCachePath("flag.json", { LWC_CACHE_FILE: "/tmp/lwc.json" }), "flag.json");
});
