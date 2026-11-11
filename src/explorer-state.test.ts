import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLookupTracker,
  lookupUrl,
  readLookupParams,
} from "../explorer/lookup-state.js";

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

test("cancel without a lookup is harmless", () => {
  const tracker = createLookupTracker();
  tracker.cancel();

  const { seq, signal } = tracker.begin();
  assert.equal(tracker.isCurrent(seq), true);
  assert.equal(signal.aborted, false);
});
