import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getAddress, isAddress, type Address } from "viem";

/** The immutable parts of an ERC-20's identity, read once and reused. */
export interface TokenMetadata {
  symbol: string;
  decimals: number;
}

/** Cached metadata plus when it was last verified; null for legacy entries. */
export interface CachedTokenMetadata extends TokenMetadata {
  cachedAt: number | null;
}

/** A cached entry paired with its checksummed token address. */
export interface ListedTokenMetadata extends CachedTokenMetadata {
  address: Address;
}

export interface MetadataCacheOptions {
  /** Only entries for this chain are returned. */
  chainId: number;
  /** File to load from and save to; ignored when `persist` is false. */
  path?: string;
  /** False keeps everything in memory and never touches the disk. */
  persist?: boolean;
  /** Clock used for entry timestamps; injectable for tests. */
  now?: () => number;
}

export const DEFAULT_CACHE_PATH = ".lwc-cache/token-metadata.json";

interface CacheFile {
  version: 2;
  chains: Record<string, Record<string, CachedTokenMetadata>>;
}

export type CacheAgeParse =
  | { ok: true; ms: number }
  | { ok: false; message: string };

/**
 * Parse cache-age flags (`--max-cache-age`, `--stale-after`): a positive whole
 * number with a unit, for example `30m`, `12h`, `7d`, or `2w`. A bare number is
 * rejected so seconds and milliseconds are never guessed.
 */
export function parseCacheAge(raw: string, flag = "--max-cache-age"): CacheAgeParse {
  const match = /^(\d+)([smhdw])$/.exec(raw.trim());
  if (!match) {
    return {
      ok: false,
      message: `${flag} must look like 30m, 12h, 7d, or 2w, got "${raw}".`,
    };
  }
  const value = Number(match[1]);
  const unit = match[2];
  const factor =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "d"
            ? 86_400_000
            : 604_800_000;
  const ms = value * factor;
  if (ms <= 0 || !Number.isSafeInteger(ms)) {
    return { ok: false, message: `${flag} must be a positive duration, got "${raw}".` };
  }
  return { ok: true, ms };
}

/** Flag value wins, then LWC_CACHE_FILE, then the project-local default. */
export function resolveCachePath(
  flagPath: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = flagPath ?? env.LWC_CACHE_FILE;
  return value && value.trim().length > 0 ? value : DEFAULT_CACHE_PATH;
}

function usableEntry(value: unknown): CachedTokenMetadata | null {
  const entry = value as { symbol?: unknown; decimals?: unknown; cachedAt?: unknown } | null;
  const symbol = typeof entry?.symbol === "string" ? entry.symbol.trim() : "";
  const decimals = entry?.decimals;
  if (!symbol || typeof decimals !== "number") return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const cachedAt =
    typeof entry?.cachedAt === "number" && Number.isFinite(entry.cachedAt) && entry.cachedAt >= 0
      ? entry.cachedAt
      : null;
  return { symbol, decimals, cachedAt };
}

/**
 * `decimals` and `symbol` are cached per chain and reused across runs and across
 * owners within a scan. Entries record when they were last verified so a stale
 * symbol can be spotted and refreshed. Only clean metadata is stored: a token
 * whose symbol or decimals did not decode is left out, so a malformed contract
 * is re-examined rather than remembered as broken.
 */
export class MetadataCache {
  private readonly chainId: number;
  private readonly path: string;
  private readonly persist: boolean;
  private readonly now: () => number;
  private readonly entries = new Map<string, Map<string, CachedTokenMetadata>>();
  private dirty = false;

  constructor(options: MetadataCacheOptions) {
    this.chainId = options.chainId;
    this.path = options.path ?? DEFAULT_CACHE_PATH;
    this.persist = options.persist ?? true;
    this.now = options.now ?? (() => Date.now());
    if (this.persist) this.load();
  }

  get(token: string): TokenMetadata | null {
    const entry = this.entries.get(String(this.chainId))?.get(token.toLowerCase());
    return entry ? { symbol: entry.symbol, decimals: entry.decimals } : null;
  }

  /** Every entry for this cache's chain, oldest first (undated entries first). */
  list(): ListedTokenMetadata[] {
    const scoped = this.entries.get(String(this.chainId));
    if (!scoped) return [];
    return [...scoped.entries()]
      .map(([address, entry]) => ({ address: getAddress(address), ...entry }))
      .sort(
        (a, b) =>
          (a.cachedAt ?? 0) - (b.cachedAt ?? 0) || a.address.localeCompare(b.address),
      );
  }

  /** How old this entry is in milliseconds; null when it has no timestamp. */
  ageMs(token: string, now = Date.now()): number | null {
    const entry = this.entries.get(String(this.chainId))?.get(token.toLowerCase());
    if (!entry || entry.cachedAt === null) return null;
    return Math.max(0, now - entry.cachedAt);
  }

  set(token: string, metadata: TokenMetadata): void {
    const usable = usableEntry({ ...metadata, cachedAt: this.now() });
    if (!usable || !isAddress(token)) return;

    const chain = String(this.chainId);
    let scoped = this.entries.get(chain);
    if (!scoped) {
      scoped = new Map<string, CachedTokenMetadata>();
      this.entries.set(chain, scoped);
    }

    const key = token.toLowerCase();
    const existing = scoped.get(key);
    if (existing && existing.symbol === usable.symbol && existing.decimals === usable.decimals) {
      return;
    }
    scoped.set(key, usable);
    this.dirty = true;
  }

  /**
   * Drop every entry older than `maxAgeMs`, plus undated entries whose age
   * cannot be checked. Returns how many entries were removed.
   */
  invalidateStale(maxAgeMs: number, now = Date.now()): number {
    const scoped = this.entries.get(String(this.chainId));
    if (!scoped) return 0;

    let removed = 0;
    for (const [address, entry] of scoped) {
      if (entry.cachedAt === null || now - entry.cachedAt > maxAgeMs) {
        scoped.delete(address);
        removed += 1;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** Drop an entry so the next read re-fetches it; true when one was removed. */
  invalidate(token: string): boolean {
    const scoped = this.entries.get(String(this.chainId));
    if (!scoped?.delete(token.toLowerCase())) return false;
    this.dirty = true;
    return true;
  }

  /** Persist changes; returns a warning message instead of throwing on failure. */
  save(): string | null {
    if (!this.persist || !this.dirty) return null;

    try {
      const chains: CacheFile["chains"] = {};
      for (const [chain, scoped] of this.entries) {
        const record: Record<string, CachedTokenMetadata> = {};
        for (const [address, metadata] of scoped) record[address] = metadata;
        chains[chain] = record;
      }
      const payload: CacheFile = { version: 2, chains };

      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(temporary, this.path);
      this.dirty = false;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return; // No cache yet is the normal first-run case.
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // A damaged cache is worth ignoring, never worth failing a read.
    }

    const chains = (parsed as { chains?: unknown } | null)?.chains;
    if (!chains || typeof chains !== "object") return;

    for (const [chain, record] of Object.entries(chains as Record<string, unknown>)) {
      if (!/^\d+$/.test(chain) || !record || typeof record !== "object") continue;
      const scoped = new Map<string, CachedTokenMetadata>();
      for (const [address, value] of Object.entries(record as Record<string, unknown>)) {
        if (!isAddress(address)) continue;
        const metadata = usableEntry(value);
        if (metadata) scoped.set(address.toLowerCase(), metadata);
      }
      if (scoped.size > 0) this.entries.set(chain, scoped);
    }
  }
}
