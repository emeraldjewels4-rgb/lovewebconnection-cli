import { getAddress, isAddress, type Address } from "viem";

import { formatCacheAge, shortAddress } from "./balances.ts";
import type { ChainConfig } from "./chain.ts";
import { MetadataCache, type ListedTokenMetadata } from "./metadata-cache.ts";

export class CacheArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheArgError";
  }
}

export interface CacheArgs {
  /** Token addresses whose metadata entries should be removed. */
  clear: Address[];
}

export interface CacheEntryReport {
  address: Address;
  symbol: string;
  decimals: number;
  /** Epoch milliseconds when the entry was verified; null for legacy entries. */
  cachedAt: number | null;
  /** Age in milliseconds; null when the entry has no timestamp. */
  ageMs: number | null;
}

export interface CacheReport {
  chainId: number;
  chainName: string;
  path: string;
  entries: CacheEntryReport[];
  removed: CacheEntryReport[];
  warnings: string[];
}

function addClearAddress(clear: Address[], raw: string): void {
  for (const part of raw.split(",")) {
    const candidate = part.trim();
    if (candidate.length === 0) continue;
    if (!isAddress(candidate)) {
      throw new CacheArgError(`"${candidate}" is not a valid token address.`);
    }
    const address = getAddress(candidate);
    if (!clear.includes(address)) clear.push(address);
  }
}

/** `--clear` takes one or more token addresses, repeated or comma-separated. */
export function parseCacheArgs(argv: string[]): CacheArgs {
  const clear: Address[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--clear") {
      const value = argv[index + 1];
      if (!value) throw new CacheArgError("--clear requires a token address.");
      addClearAddress(clear, value);
      index += 1;
    } else if (arg.startsWith("--clear=")) {
      const value = arg.slice("--clear=".length);
      if (!value) throw new CacheArgError("--clear requires a token address.");
      addClearAddress(clear, value);
    } else if (arg.startsWith("-")) {
      // --json, --cache-file, and other global flags are handled by the CLI.
      continue;
    } else {
      throw new CacheArgError(
        `unexpected argument "${arg}"; the cache command takes no positional arguments.`,
      );
    }
  }

  return { clear };
}

function entryReport(entry: ListedTokenMetadata, now: number): CacheEntryReport {
  return {
    address: entry.address,
    symbol: entry.symbol,
    decimals: entry.decimals,
    cachedAt: entry.cachedAt,
    ageMs: entry.cachedAt === null ? null : Math.max(0, now - entry.cachedAt),
  };
}

/**
 * List the current chain's cached metadata and remove the requested entries.
 * Removal is in-memory; the caller saves the cache so a failed write never
 * hides the report.
 */
export function inspectMetadataCache(
  cache: MetadataCache,
  config: ChainConfig,
  path: string,
  args: CacheArgs,
  now = Date.now(),
): CacheReport {
  const warnings: string[] = [];
  const removed: CacheEntryReport[] = [];
  const before = new Map(cache.list().map((entry) => [entry.address.toLowerCase(), entry]));

  for (const address of args.clear) {
    const entry = before.get(address.toLowerCase());
    if (!entry || !cache.invalidate(address)) {
      warnings.push(`token ${shortAddress(address)} is not in the ${config.name} metadata cache.`);
      continue;
    }
    removed.push(entryReport(entry, now));
  }

  return {
    chainId: config.chainId,
    chainName: config.name,
    path,
    entries: cache.list().map((entry) => entryReport(entry, now)),
    removed,
    warnings,
  };
}

export function formatMetadataCache(report: CacheReport): string {
  const lines = [
    "lwc — cache",
    "",
    `  ${"file".padEnd(14)}${report.path}`,
    `  ${"chain".padEnd(14)}${report.chainName} (${report.chainId})`,
    `  ${"entries".padEnd(14)}${report.entries.length}`,
  ];

  if (report.removed.length > 0) {
    lines.push(`  ${"removed".padEnd(14)}${report.removed.length}`);
    for (const entry of report.removed) {
      lines.push(`    ${shortAddress(entry.address)}  ${entry.symbol} (${entry.decimals} decimals)`);
    }
  }

  if (report.entries.length === 0) {
    lines.push("", "  no cached token metadata for this chain");
  } else {
    lines.push("");
    for (const entry of report.entries) {
      const age = entry.ageMs === null ? "age unknown" : `cached ${formatCacheAge(entry.ageMs)}`;
      lines.push(
        `  ${"token".padEnd(14)}${shortAddress(entry.address)}  ${entry.symbol} (${entry.decimals} decimals)  ${age}`,
      );
    }
  }

  return lines.join("\n");
}

export function toCacheJson(report: CacheReport): Record<string, unknown> {
  const entryJson = (entry: CacheEntryReport): Record<string, unknown> => ({
    address: entry.address,
    symbol: entry.symbol,
    decimals: entry.decimals,
    cachedAt: entry.cachedAt,
    ageMs: entry.ageMs,
  });

  return {
    ok: true,
    chain: { id: report.chainId, name: report.chainName },
    cacheFile: report.path,
    entries: report.entries.map(entryJson),
    removed: report.removed.map(entryJson),
    warnings: report.warnings,
  };
}
