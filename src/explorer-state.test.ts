import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROBE_CACHE_KEY,
  PROBE_CACHE_MS,
  createLookupTracker,
  lookupUrl,
  readLookupParams,
  readProbeCache,
  writeProbeCache,
} from "../explorer/lookup-state.js";
import type { ProbeResults } from "../explorer/lookup-state.js";

/** Stands in for localStorage: the helpers only ever call these two methods. */
function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    entries,
  };
}

const PROBES: ProbeResults = {
  ethereum: { ok: true, block: 19_000_001n, ms: 120, via: "primary" },
  base: { ok: false, error: "timeout" },
};

const CHAINS = ["ethereum", "base"];

test("reads chain, type and query from a lookup URL", () => {
  assert.deepEqual(
    readLookupParams("?chain=base&type=token&q=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    { chain: "base", type: "token", query: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  );
});

test("accepts the legacy query parameter when q is absent", () => {
  assert.equal(readLookupParams("?chain=ethereum&query=19000000").query, "19000000");
});

test("an empty q falls back to query", () => {
  assert.equal(readLookupParams("?q=&query=19000000").query, "19000000");
});

test("missing parameters are null", () => {
  assert.deepEqual(readLookupParams(""), { chain: null, type: null, query: null });
});

test("builds a lookup URL and keeps the origin, path and hash", () => {
  const url = new URL(
    lookupUrl("https://fiatgod.x10.mx/explorer/?chain=ethereum#result", "base", "block", "19000000"),
  );
  assert.equal(url.origin, "https://fiatgod.x10.mx");
  assert.equal(url.pathname, "/explorer/");
  assert.equal(url.hash, "#result");
  assert.equal(url.searchParams.get("chain"), "base");
  assert.equal(url.searchParams.get("type"), "block");
  assert.equal(url.searchParams.get("q"), "19000000");
});

test("replaces an existing lookup instead of appending", () => {
  const url = lookupUrl(
    "https://example.test/explorer/?chain=ethereum&type=token&q=1",
    "base",
    "address",
    "0xabc",
  );
  assert.equal(url, "https://example.test/explorer/?chain=base&type=address&q=0xabc");
});

test("keeps unrelated query parameters and encodes the query", () => {
  const url = new URL(lookupUrl("https://example.test/explorer/?ref=link", "base", "block", "19 000"));
  assert.equal(url.searchParams.get("ref"), "link");
  assert.equal(url.searchParams.get("q"), "19 000");
  assert.equal(url.searchParams.get("chain"), "base");
});

test("begin returns increasing sequence numbers and a live signal", () => {
  const tracker = createLookupTracker();
  const first = tracker.begin();
  const second = tracker.begin();

  assert.equal(first.seq + 1, second.seq);
  assert.equal(tracker.isCurrent(second.seq), true);
  assert.equal(tracker.isCurrent(first.seq), false);
  assert.equal(second.signal.aborted, false);
});

test("begin aborts the lookup it replaces", () => {
  const tracker = createLookupTracker();
  const first = tracker.begin();
  assert.equal(first.signal.aborted, false);

  const second = tracker.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
});

test("cancel aborts the newest lookup and invalidates it", () => {
  const tracker = createLookupTracker();
  const { seq, signal } = tracker.begin();

  tracker.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(tracker.isCurrent(seq), false);
});

test("a lookup started after cancel is current", () => {
  const tracker = createLookupTracker();
  const stale = tracker.begin();
  tracker.cancel();

  const fresh = tracker.begin();
  assert.equal(tracker.isCurrent(fresh.seq), true);
  assert.equal(tracker.isCurrent(stale.seq), false);
  assert.equal(fresh.signal.aborted, false);
});

test("a probe cache round-trips, including a failed probe and the block number", () => {
  const storage = memoryStorage();
  writeProbeCache(storage, PROBES, 1_000);

  const cached = readProbeCache(storage, CHAINS, 1_000 + 30_000);
  assert.ok(cached);
  assert.equal(cached.savedAt, 1_000, "the probe's own time comes back with it");
  assert.equal(cached.results.ethereum?.ok, true);
  assert.equal(cached.results.ethereum?.block, 19_000_001n);
  assert.equal(cached.results.ethereum?.ms, 120);
  assert.equal(cached.results.ethereum?.via, "primary");
  assert.deepEqual(cached.results.base, { ok: false, error: "timeout" });
});

test("the stored form is JSON, with the block number as a decimal string", () => {
  const storage = memoryStorage();
  writeProbeCache(storage, PROBES, 1_000);

  const raw = JSON.parse(storage.getItem(PROBE_CACHE_KEY) as string);
  assert.equal(raw.savedAt, 1_000);
  assert.equal(raw.probes.ethereum.block, "19000001");
  assert.equal(raw.probes.base.ok, false);
});

test("a cache older than the window is ignored, and one inside it is not", () => {
  const storage = memoryStorage();
  writeProbeCache(storage, PROBES, 1_000);

  assert.ok(readProbeCache(storage, CHAINS, 1_000 + PROBE_CACHE_MS - 1));
  assert.equal(readProbeCache(storage, CHAINS, 1_000 + PROBE_CACHE_MS), null);
  assert.equal(readProbeCache(storage, CHAINS, 1_000 + 5 * 60_000), null);
});

test("a clock that ran backwards still counts as inside the window", () => {
  const storage = memoryStorage();
  writeProbeCache(storage, PROBES, 60_000);

  assert.ok(readProbeCache(storage, CHAINS, 50_000));
});

test("a cache missing one of the presets is not used", () => {
  const storage = memoryStorage();
  writeProbeCache(storage, PROBES, 1_000);

  assert.equal(readProbeCache(storage, [...CHAINS, "polygon"], 2_000), null);
});

test("absent, corrupt or unusable storage is a miss rather than a throw", () => {
  assert.equal(readProbeCache(null, CHAINS, 1_000), null);

  const corrupt = memoryStorage();
  corrupt.setItem(PROBE_CACHE_KEY, "{not json");
  assert.equal(readProbeCache(corrupt, CHAINS, 1_000), null);

  const wholeTable = memoryStorage();
  wholeTable.setItem(PROBE_CACHE_KEY, JSON.stringify({ savedAt: 1_000, probes: {} }));
  assert.equal(readProbeCache(wholeTable, CHAINS, 1_000), null);

  const refusing = {
    getItem: () => {
      throw new Error("storage is disabled");
    },
    setItem: () => {
      throw new Error("storage is disabled");
    },
  };
  assert.doesNotThrow(() => writeProbeCache(refusing, PROBES, 1_000));
  assert.equal(readProbeCache(refusing, CHAINS, 1_000), null);
});

test("a malformed block number leaves the cache unusable instead of throwing", () => {
  const storage = memoryStorage();
  storage.setItem(
    PROBE_CACHE_KEY,
    JSON.stringify({ savedAt: 1_000, probes: { ethereum: { ok: true, block: "large", ms: 1, via: "primary" }, base: { ok: false } } }),
  );

  assert.equal(readProbeCache(storage, CHAINS, 1_000), null);
});

test("cancel without a lookup is harmless", () => {
  const tracker = createLookupTracker();
  tracker.cancel();

  const { seq, signal } = tracker.begin();
  assert.equal(tracker.isCurrent(seq), true);
  assert.equal(signal.aborted, false);
});
