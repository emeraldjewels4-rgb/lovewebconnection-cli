export interface LookupParams {
  chain: string | null;
  type: string | null;
  query: string | null;
}

export interface LookupStart {
  seq: number;
  signal: AbortSignal;
}

export interface LookupTracker {
  begin(): LookupStart;
  cancel(): void;
  isCurrent(candidate: number): boolean;
}

/** The two methods the probe cache needs from localStorage. */
export interface ProbeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One preset's probe: a block number and latency, or the reason it failed. */
export interface ProbeResult {
  ok: boolean;
  block?: bigint;
  ms?: number;
  via?: "primary" | "fallback";
  error?: string;
}

export type ProbeResults = Record<string, ProbeResult>;

export interface ProbeCache {
  savedAt: number;
  results: ProbeResults;
}

export const PROBE_CACHE_MS: number;
export const PROBE_CACHE_KEY: string;

export function readProbeCache(
  storage: ProbeStorage | null,
  chains: string[],
  now: number,
  ttlMs?: number,
): ProbeCache | null;
export function writeProbeCache(
  storage: ProbeStorage | null,
  results: ProbeResults,
  now: number,
): void;

export function readLookupParams(search: string): LookupParams;
export function lookupUrl(href: string, chain: string, kind: string, query: string): string;
export function createLookupTracker(): LookupTracker;
