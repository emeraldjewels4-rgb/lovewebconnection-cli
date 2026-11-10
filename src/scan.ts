import { getAddress, isAddress, type Address, type PublicClient } from "viem";

import type { ChainConfig } from "./chain.ts";
import { parseCacheAge } from "./metadata-cache.ts";
import {
  countCacheStats,
  formatTokenAmount,
  loadAddressList,
  loadTokenList,
  MAX_SUB_CALLS,
  formatCacheAge,
  mergeTokenLabels,
  parseTokenSpec,
  prefetchMetadata,
  readBalances,
  rememberTokenLabel,
  shortAddress,
  TOKENS_PER_BATCH,
  type BalancesOptions,
  type CacheStats,
  type ChunkStatus,
  type RecoverySummary,
  type TokenBalance,
} from "./balances.ts";

export class ScanArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanArgError";
  }
}

export interface ScanArgs {
  owners: Address[];
  tokens: Address[];
  /** Lowercased token address → label from the token list file. */
  labels: Map<string, string>;
  /** `null` prints the table; "-" prints CSV; anything else is a file path. */
  csvPath: string | null;
  /** Tokens per Multicall3 request. */
  batchSize: number;
  /** Fixed sub-call cap per Multicall3 request, independent of cache state. */
  maxSubCalls: number | null;
  /** Exit non-zero when any chunk needed a retry or individual fallback. */
  failOnRetry: boolean;
  /** Suppress per-chunk progress on stderr; reports and JSON are unchanged. */
  quiet: boolean;
  /** Refresh cached metadata older than this many milliseconds. */
  maxCacheAgeMs: number | null;
  /** Warn when cached metadata is older than this many milliseconds; never refreshes. */
  staleAfterMs: number | null;
  /** Non-fatal label conflicts found while merging token sources. */
  warnings: string[];
}

export interface ScanRow {
  owner: Address;
  native: bigint;
  balances: (bigint | null)[];
}

export interface ScanChunkReport {
  owner: Address;
  index: number;
  total: number;
  tokens: number;
  status: ChunkStatus;
  error: string | null;
  /** Tokens from this chunk read individually. */
  individual: Address[];
}

export interface ScanFallback {
  owner: Address;
  token: Address;
  symbol: string;
  label: string | null;
  /** 1-based chunk position. */
  chunk: number;
  chunks: number;
  error: string | null;
}

export interface ScanReport {
  chainId: number;
  chainName: string;
  blockNumber: bigint;
  nativeSymbol: string;
  nativeDecimals: number;
  owners: Address[];
  tokens: TokenBalance[];
  /** Tokens per Multicall3 request selected for the owner reads. */
  batchSize: number;
  /** Total Multicall3 chunks attempted across owners. */
  chunkCount: number;
  rows: ScanRow[];
  warnings: string[];
  chunks: ScanChunkReport[];
  /** Every token that had to be read individually, with its owner and chunk. */
  fallbacks: ScanFallback[];
  /** First-attempt failures and retry outcomes across owners. */
  recovery: RecoverySummary;
  /** Metadata cache hits and misses for this scan. */
  cache: CacheStats;
}

/** How many owners are queried at once. */
const SCAN_CONCURRENCY = 4;
const MAX_BATCH_SIZE = 100;

function parseBatchSize(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ScanArgError(`--batch-size must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_BATCH_SIZE) {
    throw new ScanArgError(`--batch-size must be between 1 and ${MAX_BATCH_SIZE}.`);
  }
  return value;
}

function parseMaxCacheAge(raw: string): number {
  const parsed = parseCacheAge(raw);
  if (!parsed.ok) throw new ScanArgError(parsed.message);
  return parsed.ms;
}

function parseStaleAfter(raw: string): number {
  const parsed = parseCacheAge(raw, "--stale-after");
  if (!parsed.ok) throw new ScanArgError(parsed.message);
  return parsed.ms;
}

function parseMaxSubCalls(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ScanArgError(`--max-subcalls must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_SUB_CALLS) {
    throw new ScanArgError(`--max-subcalls must be between 1 and ${MAX_SUB_CALLS}.`);
  }
  return value;
}

export function parseScanArgs(argv: string[]): ScanArgs {
  const owners: Address[] = [];
  const rawTokens: string[] = [];
  const tokenFiles: string[] = [];
  const ownerFiles: string[] = [];
  let csvPath: string | null = null;
  let batchSize = TOKENS_PER_BATCH;
  let maxSubCalls: number | null = null;
  let sawBatchSize = false;
  let failOnRetry = false;
  let quiet = false;
  let maxCacheAgeMs: number | null = null;
  let staleAfterMs: number | null = null;

  const addOwner = (raw: string): void => {
    const candidate = raw.trim();
    if (!candidate) return;
    if (!isAddress(candidate)) {
      throw new ScanArgError(`"${candidate}" is not a valid owner address.`);
    }
    owners.push(getAddress(candidate));
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--owner") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--owner requires an address.");
      addOwner(value);
      index += 1;
    } else if (arg.startsWith("--owner=")) {
      addOwner(arg.slice("--owner=".length));
    } else if (arg === "--owners-file") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--owners-file requires a path.");
      ownerFiles.push(value);
      index += 1;
    } else if (arg.startsWith("--owners-file=")) {
      const value = arg.slice("--owners-file=".length);
      if (!value) throw new ScanArgError("--owners-file requires a path.");
      ownerFiles.push(value);
    } else if (arg === "--token") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--token requires an address.");
      rawTokens.push(value);
      index += 1;
    } else if (arg.startsWith("--token=")) {
      rawTokens.push(arg.slice("--token=".length));
    } else if (arg === "--tokens") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--tokens requires a comma-separated list.");
      rawTokens.push(...value.split(","));
      index += 1;
    } else if (arg.startsWith("--tokens=")) {
      rawTokens.push(...arg.slice("--tokens=".length).split(","));
    } else if (arg === "--tokens-file") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--tokens-file requires a path.");
      tokenFiles.push(value);
      index += 1;
    } else if (arg.startsWith("--tokens-file=")) {
      const value = arg.slice("--tokens-file=".length);
      if (!value) throw new ScanArgError("--tokens-file requires a path.");
      tokenFiles.push(value);
    } else if (arg === "--batch-size") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--batch-size requires a value.");
      batchSize = parseBatchSize(value);
      sawBatchSize = true;
      index += 1;
    } else if (arg.startsWith("--batch-size=")) {
      batchSize = parseBatchSize(arg.slice("--batch-size=".length));
      sawBatchSize = true;
    } else if (arg === "--max-subcalls") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--max-subcalls requires a value.");
      maxSubCalls = parseMaxSubCalls(value);
      index += 1;
    } else if (arg.startsWith("--max-subcalls=")) {
      maxSubCalls = parseMaxSubCalls(arg.slice("--max-subcalls=".length));
    } else if (arg === "--fail-on-retry") {
      failOnRetry = true;
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--max-cache-age") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--max-cache-age requires a duration.");
      maxCacheAgeMs = parseMaxCacheAge(value);
      index += 1;
    } else if (arg.startsWith("--max-cache-age=")) {
      maxCacheAgeMs = parseMaxCacheAge(arg.slice("--max-cache-age=".length));
    } else if (arg === "--stale-after") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--stale-after requires a duration.");
      staleAfterMs = parseStaleAfter(value);
      index += 1;
    } else if (arg.startsWith("--stale-after=")) {
      staleAfterMs = parseStaleAfter(arg.slice("--stale-after=".length));
    } else if (arg === "--csv") {
      const value = argv[index + 1];
      if (!value) throw new ScanArgError("--csv requires a path, or - for stdout.");
      csvPath = value;
      index += 1;
    } else if (arg.startsWith("--csv=")) {
      const value = arg.slice("--csv=".length);
      if (!value) throw new ScanArgError("--csv requires a path, or - for stdout.");
      csvPath = value;
    } else if (arg.startsWith("-")) {
      // Other flags (e.g. --json) are handled by the caller.
      continue;
    } else {
      addOwner(arg);
    }
  }

  const tokens: Address[] = [];
  const warnings: string[] = [];
  const inlineLabels = new Map<string, string>();
  const fileLabels = new Map<string, string>();
  const loadList = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      throw new ScanArgError(error instanceof Error ? error.message : String(error));
    }
  };

  for (const raw of rawTokens) {
    const candidate = raw.trim();
    if (!candidate) continue;
    const entry = loadList(() => parseTokenSpec(candidate));
    tokens.push(entry.address);
    rememberTokenLabel(entry, inlineLabels, warnings);
  }

  for (const file of tokenFiles) {
    for (const entry of loadList(() => loadTokenList(file))) {
      tokens.push(entry.address);
      rememberTokenLabel(entry, fileLabels, warnings);
    }
  }
  const labels = mergeTokenLabels(inlineLabels, fileLabels, warnings);
  for (const file of ownerFiles) {
    owners.push(...loadList(() => loadAddressList(file, "owner list", ["owners", "addresses"])));
  }

  const uniqueOwners = [...new Set(owners)];
  if (uniqueOwners.length === 0) {
    throw new ScanArgError(
      "at least one owner is required: lwc scan 0xaddress… --tokens-file ./tokens.json --csv out.csv",
    );
  }

  if (sawBatchSize && maxSubCalls !== null) {
    throw new ScanArgError("use either --batch-size or --max-subcalls, not both.");
  }

  return {
    owners: uniqueOwners,
    tokens: [...new Set(tokens)],
    labels,
    csvPath,
    batchSize,
    maxSubCalls,
    failOnRetry,
    quiet,
    maxCacheAgeMs,
    staleAfterMs,
    warnings,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Prefer the first owner that resolved a token's metadata for the column header. */
function mergeTokens(perOwner: TokenBalance[][]): TokenBalance[] {
  const first = perOwner[0] ?? [];
  return first.map((token, index) => {
    for (const list of perOwner) {
      const candidate = list[index];
      if (candidate && candidate.decimals !== null) return candidate;
    }
    return token;
  });
}

export async function scanBalances(
  client: PublicClient,
  config: ChainConfig,
  owners: Address[],
  tokens: Address[],
  options: BalancesOptions = {},
): Promise<ScanReport> {
  if (options.cache && options.refreshCache) {
    for (const token of tokens) options.cache.invalidate(token);
  }
  if (options.cache && options.maxCacheAgeMs !== undefined) {
    options.cache.invalidateStale(options.maxCacheAgeMs);
  }
  const cacheStats = countCacheStats(tokens, options.cache);
  if (options.cache) {
    await prefetchMetadata(
      client,
      tokens,
      options.cache,
      options.batchSize,
      options.maxSubCalls,
    );
  }

  // A scan refreshes metadata once above; owners must reuse the fresh entries.
  const ownerOptions = { ...options, refreshCache: false };
  const reports = await mapLimit(owners, SCAN_CONCURRENCY, (owner) =>
    readBalances(client, config, owner, tokens, ownerOptions),
  );

  const warnings = reports
    .filter((report) => report.batchWarning !== null)
    .map((report) => `${shortAddress(report.owner)}: ${report.batchWarning}`);

  const chunks: ScanChunkReport[] = reports.flatMap((report) =>
    report.chunks.map((chunk) => ({
      owner: report.owner,
      index: chunk.index,
      total: chunk.total,
      tokens: chunk.tokens,
      status: chunk.status,
      error: chunk.error,
      individual: chunk.individual,
    })),
  );

  const fallbacks: ScanFallback[] = [];
  for (const report of reports) {
    const tokenByAddress = new Map(
      report.tokens.map((token) => [token.address.toLowerCase(), token] as const),
    );
    for (const chunk of report.chunks) {
      for (const address of chunk.individual) {
        const token = tokenByAddress.get(address.toLowerCase());
        fallbacks.push({
          owner: report.owner,
          token: address,
          symbol: token?.symbol ?? shortAddress(address),
          label: token?.label ?? null,
          chunk: chunk.index,
          chunks: chunk.total,
          error: chunk.error,
        });
      }
    }
  }

  const recovery: RecoverySummary = reports.reduce(
    (sum, report) => ({
      failedChunks: sum.failedChunks + report.recovery.failedChunks,
      retryRequests: sum.retryRequests + report.recovery.retryRequests,
      recoveredChunks: sum.recoveredChunks + report.recovery.recoveredChunks,
    }),
    { failedChunks: 0, retryRequests: 0, recoveredChunks: 0 },
  );

  return {
    chainId: config.chainId,
    chainName: config.name,
    blockNumber: reports[0]?.blockNumber ?? 0n,
    nativeSymbol: config.nativeCurrency.symbol,
    nativeDecimals: config.nativeCurrency.decimals,
    owners,
    tokens: mergeTokens(reports.map((report) => report.tokens)),
    rows: reports.map((report) => ({
      owner: report.owner,
      native: report.native.balance,
      balances: report.tokens.map((token) => token.balance),
    })),
    warnings,
    batchSize: reports[0]?.batchSize ?? options.batchSize ?? TOKENS_PER_BATCH,
    chunkCount: chunks.length,
    chunks,
    fallbacks,
    recovery,
    cache: cacheStats,
  };
}

function columnHeading(token: TokenBalance): string {
  if (token.decimals === null) return shortAddress(token.address);
  return `${token.symbol} (${shortAddress(token.address)})`;
}

function columnLabel(token: TokenBalance): string {
  const tag = token.label ? ` [${token.label}]` : "";
  if (token.decimals === null) return `${shortAddress(token.address)}${tag}`;
  return `${token.symbol}${tag} (${shortAddress(token.address)})`;
}

function labelCell(tokens: TokenBalance[]): string {
  return tokens
    .filter((token) => token.label !== null)
    .map((token) => `${columnHeading(token)}: ${token.label}`)
    .join(" | ");
}

function flagCell(tokens: TokenBalance[]): string {
  return tokens
    .filter((token) => token.issue !== null)
    .map((token) => `${columnLabel(token)}: ${token.issue}`)
    .join(" | ");
}

export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function scanCsv(report: ScanReport): string {
  const header = [
    "owner",
    `native (${report.nativeSymbol})`,
    ...report.tokens.map(columnHeading),
    "labels",
    "flag",
  ];
  const labels = labelCell(report.tokens);
  const flags = flagCell(report.tokens);
  const lines = [header.map(csvCell).join(",")];

  for (const row of report.rows) {
    const cells = [
      row.owner,
      formatTokenAmount(row.native, report.nativeDecimals),
    ];
    report.tokens.forEach((token, index) => {
      const balance = row.balances[index] ?? null;
      cells.push(
        balance === null || token.decimals === null
          ? ""
          : formatTokenAmount(balance, token.decimals),
      );
    });
    cells.push(labels, flags);
    lines.push(cells.map(csvCell).join(","));
  }

  return `${lines.join("\n")}\n`;
}

export function formatScan(report: ScanReport): string {
  const lines = [
    "lwc — scan",
    "",
    `  chain         ${report.chainName} (${report.chainId})`,
    `  block         ${report.blockNumber}`,
    `  owners        ${report.owners.length}`,
    `  tokens        ${report.tokens.length}`,
  ];

  if (report.chunks.length > 0) {
    const count = (status: ChunkStatus): number =>
      report.chunks.filter((chunk) => chunk.status === status).length;
    const recovered = count("recovered");
    const partial = count("partial");
    const failed = count("failed");
    if (recovered + partial + failed > 0) {
      lines.push(
        `  chunks        ${report.chunks.length} (${recovered} recovered, ${partial} partial, ${failed} failed)`,
      );
    }
  }

  if (report.recovery.failedChunks > 0) {
    const failed = report.recovery.failedChunks;
    const retries = report.recovery.retryRequests;
    const recovered = report.recovery.recoveredChunks;
    lines.push(
      `  recovery      ${failed} failed chunk${failed === 1 ? "" : "s"}, ${retries} retry request${retries === 1 ? "" : "s"}, ${recovered} recovered`,
    );
  }

  for (const row of report.rows) {
    lines.push("");
    lines.push(`  owner         ${row.owner}`);
    lines.push(
      `    native      ${formatTokenAmount(row.native, report.nativeDecimals)} ${report.nativeSymbol}`,
    );
    report.tokens.forEach((token, index) => {
      const balance = row.balances[index] ?? null;
      const value =
        balance === null || token.decimals === null
          ? "unreadable"
          : formatTokenAmount(balance, token.decimals);
      const cached =
        token.cacheAgeMs == null ? "" : ` [cached ${formatCacheAge(token.cacheAgeMs)}]`;
      lines.push(`    ${columnLabel(token)}  ${value}${cached}`);
    });
  }

  for (const warning of report.warnings) {
    lines.push("");
    lines.push(`  warning       ${warning}`);
  }

  if (report.fallbacks.length > 0) {
    const count = report.fallbacks.length;
    lines.push("");
    lines.push(`  fallbacks     ${count} token${count === 1 ? "" : "s"} read individually`);
    for (const fallback of report.fallbacks) {
      const tag = fallback.label ? ` [${fallback.label}]` : "";
      lines.push(
        `    ${shortAddress(fallback.owner)}  chunk ${fallback.chunk}/${fallback.chunks}  ${fallback.token} ${fallback.symbol}${tag}`,
      );
    }
  }

  for (const token of report.tokens) {
    if (token.issue) {
      lines.push("");
      lines.push(`  flag          token ${shortAddress(token.address)}: ${token.issue}`);
    }
  }

  return lines.join("\n");
}

export function toScanJson(report: ScanReport): Record<string, unknown> {
  return {
    ok: true,
    chain: { id: report.chainId, name: report.chainName },
    blockNumber: report.blockNumber.toString(),
    batchSize: report.batchSize,
    chunkCount: report.chunkCount,
    cache: { hits: report.cache.hits, misses: report.cache.misses },
    recovery: {
      failedChunks: report.recovery.failedChunks,
      retryRequests: report.recovery.retryRequests,
      recoveredChunks: report.recovery.recoveredChunks,
    },
    native: { symbol: report.nativeSymbol, decimals: report.nativeDecimals },
    owners: report.owners,
    tokens: report.tokens.map((token) => ({
      address: token.address,
      symbol: token.symbol,
      label: token.label,
      decimals: token.decimals,
      issue: token.issue,
      cacheAgeMs: token.cacheAgeMs,
    })),
    rows: report.rows.map((row) => ({
      owner: row.owner,
      native: row.native.toString(),
      balances: row.balances.map((balance) => (balance === null ? null : balance.toString())),
    })),
    warnings: report.warnings,
    chunks: report.chunks.map((chunk) => ({
      owner: chunk.owner,
      chunk: chunk.index,
      total: chunk.total,
      tokens: chunk.tokens,
      status: chunk.status,
      error: chunk.error,
      individual: chunk.individual,
    })),
    fallbacks: report.fallbacks.map((fallback) => ({
      owner: fallback.owner,
      token: fallback.token,
      symbol: fallback.symbol,
      label: fallback.label,
      chunk: fallback.chunk,
      chunks: fallback.chunks,
      error: fallback.error,
    })),
  };
}
