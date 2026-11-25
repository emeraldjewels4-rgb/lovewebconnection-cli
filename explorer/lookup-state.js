/**
 * Pure helpers for the explorer's URL state and lookup lifecycle.
 * Kept free of DOM access so node:test can exercise them directly.
 */

/**
 * How long a probe of every preset is reused, in milliseconds, and the key it is
 * kept under. The window is the proxy's own minute: the twelve calls a cold table
 * costs are paid once a minute rather than once a load, and a reload or a second
 * tab inside it asks the proxy for nothing.
 */
export const PROBE_CACHE_MS = 60_000;
export const PROBE_CACHE_KEY = "lwc-explorer-probes";

/** A stored value as JSON, or null when storage is absent, empty or unreadable. */
function storedJson(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return typeof raw === "string" && raw !== "" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * The probe results for every named chain and when they were taken, or null when
 * the cache cannot answer for all of them.
 *
 * A probe answer holds a bigint block number, which JSON cannot carry, so the
 * stored form keeps it as a decimal string. One chain missing makes the whole
 * cache unusable: a table with a row left empty, after paying nothing, is worse
 * than probing again.
 */
export function readProbeCache(storage, chains, now, ttlMs = PROBE_CACHE_MS) {
  const stored = storedJson(storage, PROBE_CACHE_KEY);
  if (!stored || typeof stored.savedAt !== "number" || !stored.probes || typeof stored.probes !== "object") {
    return null;
  }
  // Negative for a clock that ran backwards, which is still inside the window.
  if (now - stored.savedAt >= ttlMs) return null;

  const results = {};
  for (const name of chains) {
    const entry = stored.probes[name];
    if (!entry || typeof entry.ok !== "boolean") return null;
    if (entry.ok) {
      if (typeof entry.block !== "string" || !/^\d+$/.test(entry.block) || typeof entry.ms !== "number") {
        return null;
      }
      results[name] = {
        ok: true,
        block: BigInt(entry.block),
        ms: entry.ms,
        via: entry.via === "fallback" ? "fallback" : "primary",
      };
    } else {
      results[name] = { ok: false, error: typeof entry.error === "string" ? entry.error : "probe failed" };
    }
  }
  return { savedAt: stored.savedAt, results };
}

/** Store the whole table's probe results, a failed probe included, for the window. */
export function writeProbeCache(storage, results, now) {
  const probes = {};
  for (const [name, result] of Object.entries(results)) {
    probes[name] = result && result.ok
      ? { ok: true, block: String(result.block), ms: result.ms, via: result.via }
      : { ok: false, error: String(result?.error ?? "probe failed") };
  }
  try {
    storage?.setItem(PROBE_CACHE_KEY, JSON.stringify({ savedAt: now, probes }));
  } catch {
    // A privacy mode that refuses storage still shows this load's results.
  }
}

/** The chain, type and query a page URL asks for, with the legacy `query` alias. */
export function readLookupParams(search) {
  const params = new URLSearchParams(search);
  return {
    chain: params.get("chain"),
    type: params.get("type"),
    query: params.get("q") || params.get("query"),
  };
}

/** The page URL for a lookup, with any previous lookup parameters replaced. */
export function lookupUrl(href, chain, kind, query) {
  const url = new URL(href);
  url.searchParams.set("chain", chain);
  url.searchParams.set("type", kind);
  url.searchParams.set("q", query);
  return url.toString();
}

/**
 * Tracks the newest lookup. begin() aborts the lookup it replaces, cancel()
 * aborts the current one, and isCurrent() tells a late response to stand down.
 */
export function createLookupTracker() {
  let seq = 0;
  let controller = null;
  return {
    begin() {
      if (controller) controller.abort();
      controller = new AbortController();
      seq += 1;
      return { seq, signal: controller.signal };
    },
    cancel() {
      seq += 1;
      if (controller) controller.abort();
      controller = null;
    },
    isCurrent(candidate) {
      return candidate === seq;
    },
  };
}
