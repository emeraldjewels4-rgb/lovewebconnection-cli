/**
 * Pure helpers for the explorer's URL state and lookup lifecycle.
 * Kept free of DOM access so node:test can exercise them directly.
 */

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
