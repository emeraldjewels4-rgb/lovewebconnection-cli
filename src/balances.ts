import { readFileSync } from "node:fs";

import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import type { ChainConfig } from "./chain.ts";
import { MULTICALL3_ADDRESS, multicall3BatchAbi, readTyped } from "./contract.ts";
import { parseCacheAge, type MetadataCache, type TokenMetadata } from "./metadata-cache.ts";

export interface TokenBalance {
  address: Address;
  symbol: string;
  /** Optional name from the token list or an inline `--token` label. */
  label: string | null;
  /** Null when the contract did not return a usable decimals value. */
  decimals: number | null;
  /** Null when balanceOf could not be read (not an ERC-20, or the call reverted). */
  balance: bigint | null;
  /** Age of the reused metadata entry; null when read fresh or unrecorded. */
  cacheAgeMs: number | null;
  /**
   * Why this address does not look like a usable ERC-20, when it does not.
   * Null for a token whose metadata all decoded cleanly.
   */
  issue: string | null;
}

export type ChunkStatus = "batched" | "recovered" | "partial" | "failed";

export interface RecoverySummary {
  /** Original chunks whose first aggregate3 request failed. */
  failedChunks: number;
  /** Retry requests sent for those chunks, two per multi-token chunk. */
  retryRequests: number;
  /** Chunks whose retries recovered every token. */
  recoveredChunks: number;
}

export interface ChunkReport {
  /** 1-based position among this owner's chunks. */
  index: number;
  total: number;
  /** Tokens assigned to this chunk. */
  tokens: number;
  status: ChunkStatus;
  /** Why the first batch attempt failed; null when it succeeded. */
  error: string | null;
  /** Tokens from this chunk that were re-read individually. */
  individual: Address[];
}

export interface ChunkProgress extends ChunkReport {
  owner: Address;
}

export interface CacheStats {
  /** Unique tokens whose metadata was served from the cache. */
  hits: number;
  /** Unique tokens whose metadata had to be read. */
  misses: number;
}

export interface BalancesReport {
  owner: Address;
  chainId: number;
  chainName: string;
  native: { symbol: string; decimals: number; balance: bigint };
  tokens: TokenBalance[];
  blockNumber: bigint;
  /** Why the Multicall3 batch could not be used, if it could not. */
  batchWarning: string | null;
  /** Tokens per Multicall3 request selected for this read. */
  batchSize: number;
  /** Number of Multicall3 chunks attempted. */
  chunkCount: number;
  /** Per-chunk outcomes, including retries and individual fallbacks. */
  chunks: ChunkReport[];
  /** First-attempt failures and their retry outcome. */
  recovery: RecoverySummary;
  /** Metadata cache hits and misses for this read. */
  cache: CacheStats;
}

export class BalancesArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BalancesArgError";
  }
}

export interface BalanceArgs {
  owner: Address;
  tokens: Address[];
  /** Lowercased token address → label from the token list file. */
  labels: Map<string, string>;
  /** Tokens per Multicall3 request. */
  batchSize: number;
  /** Fixed sub-call cap per Multicall3 request, independent of cache state. */
  maxSubCalls: number | null;
  /** Exit non-zero when any chunk needed a retry or individual fallback. */
  failOnRetry: boolean;
  /** Print one line per Multicall3 chunk, with its retry outcome, to stderr. */
  verbose: boolean;
  /** Refresh cached metadata older than this many milliseconds. */
  maxCacheAgeMs: number | null;
  /** Warn when cached metadata is older than this many milliseconds; never refreshes. */
  staleAfterMs: number | null;
  /** Non-fatal label conflicts found while merging token sources. */
  warnings: string[];
}

function readJsonList(
  path: string,
  kind: string,
  keys: string[],
  entryHint: string,
): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BalancesArgError(`cannot read ${kind} ${path}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BalancesArgError(`${path} is not valid JSON.`);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : keys.reduce<unknown>(
        (found, key) => found ?? (parsed as Record<string, unknown> | null)?.[key],
        undefined,
      );
  if (!Array.isArray(list)) {
    throw new BalancesArgError(
      `${path} must be a JSON array of ${entryHint}, or an object with a "${keys[0]}" array.`,
    );
  }
  return list;
}

/**
 * Read a saved address list: a JSON array of addresses, or an object holding one
 * of `keys` as that array (matching the tolerance of the ABI loader).
 */
export function loadAddressList(path: string, label: string, keys: string[]): Address[] {
  return readJsonList(path, label, keys, "addresses").map((entry, index) => {
    if (typeof entry !== "string" || !isAddress(entry)) {
      throw new BalancesArgError(`${path}: entry ${index + 1} is not an EVM address.`);
    }
    return getAddress(entry);
  });
}

export interface TokenListEntry {
  address: Address;
  label: string | null;
}

/** Parse an inline token spec: `0xAddress:Label` or `0xAddress=Label`. */
export function parseTokenSpec(raw: string): TokenListEntry {
  const candidate = raw.trim();
  const separator = candidate.search(/[:=]/);
  const address = (separator === -1 ? candidate : candidate.slice(0, separator)).trim();
  const label = separator === -1 ? "" : candidate.slice(separator + 1).trim();

  if (!isAddress(address)) {
    throw new BalancesArgError(`"${address}" is not a valid token address.`);
  }
  if (label.length > 64) {
    throw new BalancesArgError("token label longer than 64 characters.");
  }
  return { address: getAddress(address), label: label.length > 0 ? label : null };
}

/** Record the last label for a token, warning when a different one was present. */
export function rememberTokenLabel(
  entry: TokenListEntry,
  labels: Map<string, string>,
  warnings: string[],
): void {
  if (!entry.label) return;
  const key = entry.address.toLowerCase();
  const previous = labels.get(key);
  if (previous !== undefined && previous !== entry.label) {
    warnings.push(
      `token ${shortAddress(entry.address)} is listed with conflicting labels ${JSON.stringify(previous)} and ${JSON.stringify(entry.label)}; using ${JSON.stringify(entry.label)}.`,
    );
  }
  labels.set(key, entry.label);
}

/**
 * Merge ad-hoc and file labels. Inline `--token` labels win over the token
 * file, and a differing file label is reported once rather than silently lost.
 */
export function mergeTokenLabels(
  inlineLabels: ReadonlyMap<string, string>,
  fileLabels: ReadonlyMap<string, string>,
  warnings: string[],
): Map<string, string> {
  const labels = new Map(fileLabels);
  for (const [key, label] of inlineLabels) {
    const fileLabel = fileLabels.get(key);
    if (fileLabel !== undefined && fileLabel !== label) {
      warnings.push(
        `token ${shortAddress(getAddress(key))} inline label ${JSON.stringify(label)} overrides file label ${JSON.stringify(fileLabel)}.`,
      );
    }
    labels.set(key, label);
  }
  return labels;
}

/**
 * Saved token list: a JSON array of addresses, or `{ address, label }` objects,
 * or an object with a `tokens` array of either.
 */
export function loadTokenList(path: string): TokenListEntry[] {
  return readJsonList(
    path,
    "token list",
    ["tokens"],
    "addresses (or {address, label} entries)",
  ).map((entry, index) => {
    if (typeof entry === "string") {
      if (!isAddress(entry)) {
        throw new BalancesArgError(`${path}: entry ${index + 1} is not an EVM address.`);
      }
      return { address: getAddress(entry), label: null };
    }

    if (entry && typeof entry === "object") {
      const record = entry as { address?: unknown; label?: unknown };
      if (typeof record.address !== "string" || !isAddress(record.address)) {
        throw new BalancesArgError(`${path}: entry ${index + 1} is not an EVM address.`);
      }
      if (record.label !== undefined && record.label !== null && typeof record.label !== "string") {
        throw new BalancesArgError(`${path}: entry ${index + 1} has a non-string label.`);
      }
      const label = typeof record.label === "string" ? record.label.trim() : "";
      if (label.length > 64) {
        throw new BalancesArgError(
          `${path}: entry ${index + 1} has a label longer than 64 characters.`,
        );
      }
      return { address: getAddress(record.address), label: label.length > 0 ? label : null };
    }

    throw new BalancesArgError(
      `${path}: entry ${index + 1} is not an EVM address or {address, label} object.`,
    );
  });
}

function parseBatchSize(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new BalancesArgError(`--batch-size must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_BATCH_SIZE) {
    throw new BalancesArgError(`--batch-size must be between 1 and ${MAX_BATCH_SIZE}.`);
  }
  return value;
}

function parseMaxCacheAge(raw: string): number {
  const parsed = parseCacheAge(raw);
  if (!parsed.ok) throw new BalancesArgError(parsed.message);
  return parsed.ms;
}

function parseStaleAfter(raw: string): number {
  const parsed = parseCacheAge(raw, "--stale-after");
  if (!parsed.ok) throw new BalancesArgError(parsed.message);
  return parsed.ms;
}

function parseMaxSubCalls(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new BalancesArgError(`--max-subcalls must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_SUB_CALLS) {
    throw new BalancesArgError(`--max-subcalls must be between 1 and ${MAX_SUB_CALLS}.`);
  }
  return value;
}

export function parseBalanceArgs(argv: string[]): BalanceArgs {
  const positional: string[] = [];
  const rawTokens: string[] = [];
  const tokenFiles: string[] = [];
  let batchSize = TOKENS_PER_BATCH;
  let maxSubCalls: number | null = null;
  let failOnRetry = false;
  let verbose = false;
  let maxCacheAgeMs: number | null = null;
  let staleAfterMs: number | null = null;
  let sawBatchSize = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--token") {
      const value = argv[index + 1];
      if (!value) throw new BalancesArgError("--token requires an address.");
      rawTokens.push(value);
      index += 1;
    } else if (arg.startsWith("--token=")) {
      rawTokens.push(arg.slice("--token=".length));
    } else if (arg === "--tokens") {
      const value = argv[index + 1];
      if (!value) throw new BalancesArgError("--tokens requires a comma-separated list.");
      rawTokens.push(...value.split(","));
      index += 1;
    } else if (arg.startsWith("--tokens=")) {
      rawTokens.push(...arg.slice("--tokens=".length).split(","));
    } else if (arg === "--tokens-file") {
      const value = argv[index + 1];
      if (!value) throw new BalancesArgError("--tokens-file requires a path.");
      tokenFiles.push(value);
      index += 1;
    } else if (arg.startsWith("--tokens-file=")) {
      const value = arg.slice("--tokens-file=".length);
      if (!value) throw new BalancesArgError("--tokens-file requires a path.");
      tokenFiles.push(value);
    } else if (arg === "--batch-size") {
      const value = argv[index + 1];
      if (!value) throw new BalancesArgError("--batch-size requires a value.");
      batchSize = parseBatchSize(value);
      sawBatchSize = true;
      index += 1;
    } else if (arg.startsWith("--batch-size=")) {
      batchSize = parseBatchSize(arg.slice("--batch-size=".length));
      sawBatchSize = true;
    } else if (arg === "--max-subcalls") {
      const value = argv[index + 1];
      if (!value) throw new BalancesArgError("--max-subcalls requires a value.");
      maxSubCalls = parseMaxSubCalls(value);
      index += 1;
    } else if (arg.startsWith("--max-subcalls=")) {
      maxSubCalls = parseMaxSubCalls(arg.slice("--max-subcalls=".length));
    } else if (arg === "--fail-on-retry") {
      failOnRetry = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--max-cache-age") {
      const value = argv[index + 1];
      if (!value) throw new BalancesArgError("--max-cache-age requires a duration.");
      maxCacheAgeMs = parseMaxCacheAge(value);
      index += 1;
    } else if (arg.startsWith("--max-cache-age=")) {
      maxCacheAgeMs = parseMaxCacheAge(arg.slice("--max-cache-age=".length));
    } else if (arg === "--stale-after") {
      const value = argv[index + 1];
      if (!value) throw new BalancesArgError("--stale-after requires a duration.");
      staleAfterMs = parseStaleAfter(value);
      index += 1;
    } else if (arg.startsWith("--stale-after=")) {
      staleAfterMs = parseStaleAfter(arg.slice("--stale-after=".length));
    } else if (arg.startsWith("-")) {
      // Other flags (e.g. --json) are handled by the caller.
      continue;
    } else {
      positional.push(arg);
    }
  }

  const ownerRaw = positional[0];
  if (!ownerRaw) {
    throw new BalancesArgError(
      "An owner address is required: lwc balances <0xaddress> [--token 0x…]",
    );
  }
  if (positional.length > 1) {
    throw new BalancesArgError(`Unexpected extra argument: ${positional[1]}.`);
  }
  if (!isAddress(ownerRaw)) {
    throw new BalancesArgError(`"${ownerRaw}" is not a valid EVM address.`);
  }

  const tokens: Address[] = [];
  const warnings: string[] = [];
  const inlineLabels = new Map<string, string>();
  const fileLabels = new Map<string, string>();
  for (const raw of rawTokens) {
    const candidate = raw.trim();
    if (!candidate) continue;
    const entry = parseTokenSpec(candidate);
    tokens.push(entry.address);
    rememberTokenLabel(entry, inlineLabels, warnings);
  }

  for (const file of tokenFiles) {
    for (const entry of loadTokenList(file)) {
      tokens.push(entry.address);
      rememberTokenLabel(entry, fileLabels, warnings);
    }
  }
  const labels = mergeTokenLabels(inlineLabels, fileLabels, warnings);

  if (sawBatchSize && maxSubCalls !== null) {
    throw new BalancesArgError("use either --batch-size or --max-subcalls, not both.");
  }

  return {
    owner: getAddress(ownerRaw),
    tokens: [...new Set(tokens)],
    labels,
    batchSize,
    maxSubCalls,
    failOnRetry,
    verbose,
    maxCacheAgeMs,
    staleAfterMs,
    warnings,
  };
}

/** Render a base-unit value without trailing zeros. */
export function formatTokenAmount(value: bigint, decimals: number): string {
  const raw = formatUnits(value, decimals);
  if (!raw.includes(".")) return raw;
  return raw.replace(/0+$/, "").replace(/\.$/, "");
}

/** Compact age for cached metadata: `45s`, `12m`, `5h`, `3d`. */
/**
 * Warn-only check for cached metadata older than `staleAfterMs`. Freshly read
 * tokens and undated legacy entries carry no age, so they never warn.
 */
export function staleMetadataWarnings(
  tokens: readonly TokenBalance[],
  staleAfterMs: number | null,
): string[] {
  if (staleAfterMs === null) return [];

  return tokens.flatMap((token) => {
    const age = token.cacheAgeMs;
    if (age === null || age <= staleAfterMs) return [];
    const name = token.label
      ? `${token.symbol} [${token.label}]`
      : token.symbol || shortAddress(token.address);
    return [
      `${name} (${shortAddress(token.address)}) metadata is ${formatCacheAge(age)} old, stale after ${formatCacheAge(staleAfterMs)}`,
    ];
  });
}

export function formatCacheAge(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** One stderr line per chunk for `--verbose`, matching `scan`'s progress text. */
export function formatChunkProgress(chunk: ChunkProgress): string {
  const status =
    chunk.status === "batched"
      ? "ok"
      : chunk.status === "recovered"
        ? "retried, recovered"
        : chunk.status === "partial"
          ? "retried, partial"
          : "failed";
  const individual =
    chunk.individual.length > 0 ? `, ${chunk.individual.length} individual` : "";
  return `  chunk ${shortAddress(chunk.owner)} ${chunk.index}/${chunk.total} (${chunk.tokens} token${chunk.tokens === 1 ? "" : "s"}) ${status}${individual}`;
}

/** Highest standard EVM precompile (0x0a, point evaluation). */
const PRECOMPILE_MAX = 0x0a;

/**
 * Precompiles live at 0x…01–0x…0a. They have no code, so they can never be
 * ERC-20s, and some (notably 0x05 modexp) read a 4-byte selector as an enormous
 * operand length and burn every unit of gas available — which reverts the whole
 * aggregate3 batch with "out of gas". They are answered locally instead.
 */
export function isPrecompileAddress(address: Address): boolean {
  const trimmed = address.slice(2).toLowerCase().replace(/^0+/, "");
  if (trimmed.length === 0 || trimmed.length > 2) return false;
  const value = Number.parseInt(trimmed, 16);
  return value >= 1 && value <= PRECOMPILE_MAX;
}

function unreadableToken(token: Address, issue = "no data returned for this address"): TokenBalance {
  return {
    address: token,
    symbol: shortAddress(token),
    label: null,
    decimals: null,
    balance: null,
    cacheAgeMs: null,
    issue,
  };
}

interface CallResult {
  success: boolean;
  returnData: Hex;
}

function decodeDecimals(result: CallResult | undefined): number | null {
  if (!result?.success) return null;
  try {
    const value = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "decimals",
      data: result.returnData,
    });
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function decodeSymbol(result: CallResult | undefined): string | null {
  if (!result?.success) return null;
  try {
    const value = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "symbol",
      data: result.returnData,
    });
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function decodeErc20Balance(result: CallResult | undefined): bigint | null {
  if (!result?.success) return null;
  try {
    const value = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      data: result.returnData,
    });
    return typeof value === "bigint" ? value : null;
  } catch {
    return null;
  }
}

function decodeTotalSupply(result: CallResult | undefined): bigint | null {
  if (!result?.success) return null;
  try {
    const value = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "totalSupply",
      data: result.returnData,
    });
    return typeof value === "bigint" ? value : null;
  } catch {
    return null;
  }
}

function decodeNativeBalance(result: CallResult | undefined): bigint | null {
  if (!result?.success) return null;
  try {
    const value = decodeFunctionResult({
      abi: multicall3BatchAbi,
      functionName: "getEthBalance",
      data: result.returnData,
    });
    return typeof value === "bigint" ? value : null;
  } catch {
    return null;
  }
}

const EMPTY_DATA = "0x";

/** Decode a bytes32 word holding ASCII text, the pre-`string` symbol convention. */
function bytes32Text(data: Hex): string | null {
  if (data.length !== 66) return null;
  const body = data.slice(2);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 2) {
    bytes.push(Number.parseInt(body.slice(index, index + 2), 16));
  }
  const terminator = bytes.indexOf(0);
  const text = terminator === -1 ? bytes : bytes.slice(0, terminator);
  if (text.length === 0 || text.some((byte) => byte < 0x20 || byte > 0x7e)) return null;
  return String.fromCharCode(...text);
}

/**
 * Classify one token from its raw sub-call results. A null field alone cannot
 * say whether an address is a real ERC-20: an EOA answers every call with no
 * data, a plain contract reverts, and a token can return a bytes32 symbol or a
 * decimals value that is not a uint8 while still reporting a balance.
 */
function inspectToken(
  decimalsResult: CallResult | undefined,
  symbolResult: CallResult | undefined,
  balanceResult: CallResult | undefined,
  supplyResult: CallResult | undefined,
): { decimals: number | null; symbol: string | null; balance: bigint | null; issue: string | null } {
  const decimals = decodeDecimals(decimalsResult);
  const symbol = decodeSymbol(symbolResult);
  const balance = decodeErc20Balance(balanceResult);
  const totalSupply = decodeTotalSupply(supplyResult);

  const results = [decimalsResult, symbolResult, balanceResult, supplyResult];
  const allEmpty = results.every(
    (result) => result?.success === true && result.returnData === EMPTY_DATA,
  );
  const answered = results.filter((result) => result?.success === true).length;

  let issue: string | null = null;
  if (allEmpty) {
    issue = "no contract code (every call returned no data)";
  } else if (answered === 0) {
    issue = "reverted on decimals, symbol, balanceOf and totalSupply (not an ERC-20)";
  } else {
    const problems: string[] = [];
    if (decimals === null) {
      problems.push(decimalsResult?.success ? "decimals is not a uint8" : "decimals reverted");
    } else if (decimals > 36) {
      problems.push(`implausible decimals (${decimals})`);
    }
    if (symbol === null) {
      const text = symbolResult?.success ? bytes32Text(symbolResult.returnData) : null;
      if (text) problems.push(`symbol is bytes32 (${text}), not a string`);
      else if (symbolResult?.success) problems.push("symbol is neither a string nor bytes32 text");
      else problems.push("symbol reverted");
    } else if (symbol.trim().length === 0) {
      problems.push("symbol is empty");
    }
    if (balance === null) {
      problems.push(balanceResult?.success ? "balanceOf is not a uint256" : "balanceOf reverted");
    }
    if (totalSupply === null) {
      problems.push(supplyResult?.success ? "totalSupply is not a uint256" : "totalSupply reverted");
    } else if (balance !== null && balance > totalSupply) {
      problems.push(`balanceOf exceeds totalSupply (${balance} > ${totalSupply} base units)`);
    }
    if (problems.length > 0) issue = problems.join("; ");
  }

  return { decimals, symbol, balance, issue };
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function readTokenIndividually(
  client: PublicClient,
  token: Address,
  owner: Address,
): Promise<{ result: TokenBalance; metadata: TokenMetadata | null }> {
  const [decimals, symbol, balance, totalSupply] = await Promise.all([
    attempt(() =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ),
    attempt(() =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ),
    attempt(() =>
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
    attempt(() =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    ),
  ]);

  const problems: string[] = [];
  if (decimals === null) problems.push("decimals failed");
  if (symbol === null) problems.push("symbol failed");
  if (balance === null) problems.push("balanceOf failed");
  if (totalSupply === null) {
    problems.push("totalSupply failed");
  } else if (typeof balance === "bigint" && balance > totalSupply) {
    problems.push(`balanceOf exceeds totalSupply (${balance} > ${totalSupply} base units)`);
  }

  const result: TokenBalance = {
    address: token,
    symbol:
      typeof symbol === "string" && symbol.trim().length > 0
        ? symbol.trim()
        : shortAddress(token),
    label: null,
    decimals: typeof decimals === "number" ? decimals : null,
    balance: typeof balance === "bigint" ? balance : null,
    cacheAgeMs: null,
    issue: problems.length > 0 ? `individual reads: ${problems.join(", ")}` : null,
  };

  const metadata: TokenMetadata | null =
    typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 &&
    typeof symbol === "string" && symbol.trim().length > 0
      ? { symbol: symbol.trim(), decimals }
      : null;

  return { result, metadata };
}

/**
 * One eth_call: native balance plus decimals/symbol/balanceOf/totalSupply for
 * every token, through Multicall3 aggregate3. Returns null when the batch cannot
 * be used at all, so the caller can fall back to individual reads.
 */
/** Default tokens per Multicall3 request: 12 uncached tokens is 49 sub-calls,
 * comfortably within the 50M eth_call gas cap that a gas-burning address can
 * otherwise exhaust. `--batch-size` lowers it for stricter RPCs. */
export const TOKENS_PER_BATCH = 12;
/** Cached tokens need only balanceOf and totalSupply, so 24 still fits 49. */
export const CACHED_TOKENS_PER_BATCH = 24;
export const MAX_BATCH_SIZE = 100;
/** Upper bound for `--max-subcalls`: a fixed request budget, cache independent. */
export const MAX_SUB_CALLS = 1000;

/** Chunk by a per-item sub-call cost so a request budget, not a count, is fixed. */
function chunkByCost<T>(items: T[], maxSubCalls: number, cost: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let used = 0;

  for (const item of items) {
    if (current.length > 0 && used + cost > maxSubCalls) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function chunkTokens<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`batch size must be a positive integer, got ${size}.`);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Sub-calls one token needs: cached metadata skips decimals and symbol. */
function tokenSubCalls(token: Address, cache?: MetadataCache): number {
  return cache?.get(token) === null ? 4 : cache ? 2 : 4;
}

/**
 * Fill each request up to a fixed sub-call budget instead of a token count, so
 * the cap does not grow when metadata is cached. The first request also carries
 * the native balance and starts with one sub-call spent; a single token always
 * gets a request of its own.
 */
function chunkBySubCalls(
  tokens: Address[],
  maxSubCalls: number,
  cache?: MetadataCache,
): Address[][] {
  const chunks: Address[][] = [];
  let current: Address[] = [];
  let used = 1;

  for (const token of tokens) {
    const cost = tokenSubCalls(token, cache);
    if (current.length > 0 && used + cost > maxSubCalls) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(token);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function batchErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return short;
    return error.message;
  }
  return String(error);
}

export async function readOwnerBatch(
  client: PublicClient,
  owner: Address,
  tokens: Address[],
  includeNative = true,
  cache?: MetadataCache,
): Promise<
  | {
      ok: true;
      native: bigint | null;
      tokens: TokenBalance[];
      metadata: Map<string, TokenMetadata>;
    }
  | { ok: false; error: string }
> {
  const calls = [
    ...(includeNative
      ? [
          {
            target: MULTICALL3_ADDRESS,
            allowFailure: true,
            callData: encodeFunctionData({
              abi: multicall3BatchAbi,
              functionName: "getEthBalance",
              args: [owner],
            }),
          },
        ]
      : []),
  ];

  // Cached tokens contribute only their balanceOf and totalSupply sub-calls,
  // which are the parts that actually change between reads.
  const slots: Array<{
    token: Address;
    cached: TokenMetadata | null;
    decimalsIndex: number | null;
    symbolIndex: number | null;
    balanceIndex: number;
    supplyIndex: number;
  }> = [];

  for (const token of tokens) {
    const cached = cache?.get(token) ?? null;
    let decimalsIndex: number | null = null;
    let symbolIndex: number | null = null;

    if (!cached) {
      decimalsIndex = calls.length;
      calls.push({
        target: token,
        allowFailure: true,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
      });
      symbolIndex = calls.length;
      calls.push({
        target: token,
        allowFailure: true,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }),
      });
    }

    const balanceIndex = calls.length;
    calls.push({
      target: token,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    });
    const supplyIndex = calls.length;
    calls.push({
      target: token,
      allowFailure: true,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" }),
    });

    slots.push({ token, cached, decimalsIndex, symbolIndex, balanceIndex, supplyIndex });
  }

  let results: readonly CallResult[];
  try {
    results = await readTyped(
      client,
      { address: MULTICALL3_ADDRESS, abi: multicall3BatchAbi },
      "aggregate3",
      calls,
    );
  } catch (error) {
    return { ok: false, error: batchErrorMessage(error) };
  }

  const metadataFound = new Map<string, TokenMetadata>();
  const tokenBalances: TokenBalance[] = slots.map((slot) => {
    const decimalsResult: CallResult | undefined = slot.cached
      ? {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "decimals",
            result: slot.cached.decimals,
          }),
        }
      : results[slot.decimalsIndex as number];
    const symbolResult: CallResult | undefined = slot.cached
      ? {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "symbol",
            result: slot.cached.symbol,
          }),
        }
      : results[slot.symbolIndex as number];
    const reading = inspectToken(
      decimalsResult,
      symbolResult,
      results[slot.balanceIndex],
      results[slot.supplyIndex],
    );

    if (reading.decimals !== null && reading.symbol !== null && reading.symbol.trim().length > 0) {
      metadataFound.set(slot.token.toLowerCase(), {
        symbol: reading.symbol.trim(),
        decimals: reading.decimals,
      });
    }

    return {
      address: slot.token,
      symbol:
        reading.symbol && reading.symbol.trim().length > 0
          ? reading.symbol.trim()
          : shortAddress(slot.token),
      label: null,
      decimals: reading.decimals,
      balance: reading.balance,
      cacheAgeMs: null,
      issue: reading.issue,
    };
  });

  return {
    ok: true,
    native: includeNative ? decodeNativeBalance(results[0]) : null,
    tokens: tokenBalances,
    metadata: metadataFound,
  };
}

/**
 * Read `decimals`/`symbol` once for every token missing from the cache. `scan`
 * calls this before fanning out to owners so concurrent owners do not each
 * re-read the same metadata.
 */
export async function prefetchMetadata(
  client: PublicClient,
  tokens: Address[],
  cache: MetadataCache,
  batchSize: number = TOKENS_PER_BATCH,
  maxSubCalls?: number,
): Promise<number> {
  const missing = tokens.filter(
    (token) => !isPrecompileAddress(token) && cache.get(token) === null,
  );
  if (missing.length === 0) return 0;

  // Prefetch only reads missing metadata: decimals plus symbol, two per token.
  const perBatch = maxSubCalls === undefined ? batchSize : Math.max(1, Math.floor(maxSubCalls / 2));

  await Promise.all(
    chunkTokens(missing, perBatch).map(async (batch) => {
      const calls = batch.flatMap((token) => [
        {
          target: token,
          allowFailure: true,
          callData: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
        },
        {
          target: token,
          allowFailure: true,
          callData: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }),
        },
      ]);

      try {
        const results = await readTyped(
          client,
          { address: MULTICALL3_ADDRESS, abi: multicall3BatchAbi },
          "aggregate3",
          calls,
        );
        batch.forEach((token, index) => {
          const decimals = decodeDecimals(results[index * 2]);
          const symbol = decodeSymbol(results[index * 2 + 1]);
          if (decimals !== null && symbol !== null && symbol.trim().length > 0) {
            cache.set(token, { symbol: symbol.trim(), decimals });
          }
        });
      } catch {
        // Prefetch is an optimization; per-owner reads still fill the cache.
      }
    }),
  );

  return missing.length;
}

/** Count unique ERC-20 metadata lookups the cache can answer. */
export function countCacheStats(tokens: Address[], cache?: MetadataCache): CacheStats {
  if (!cache) return { hits: 0, misses: 0 };

  let hits = 0;
  let misses = 0;
  const seen = new Set<string>();
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key) || isPrecompileAddress(token)) continue;
    seen.add(key);
    if (cache.get(token) === null) misses += 1;
    else hits += 1;
  }
  return { hits, misses };
}

export interface TokenCheck {
  address: Address;
  symbol: string | null;
  decimals: number | null;
  /** Why this address does not look like a usable ERC-20; null when it does. */
  issue: string | null;
}

export interface TokenCheckOptions {
  /** Tokens per Multicall3 request. */
  batchSize?: number;
  /** Fixed sub-call budget per request (3 per token), ignoring `batchSize`. */
  maxSubCalls?: number;
}

/** Verification checks plus the request budget that produced them. */
export interface TokenCheckReport {
  checks: TokenCheck[];
  /** Multicall3 verification requests sent; 0 when every address was local. */
  chunkCount: number;
  /** The sub-call cap used, or null when the default token batch size applied. */
  maxSubCalls: number | null;
}

/**
 * Classify a token from decimals, symbol and totalSupply alone, without an
 * owner. Mirrors `inspectToken`, minus the balance checks.
 */
function inspectTokenMetadata(
  decimalsResult: CallResult | undefined,
  symbolResult: CallResult | undefined,
  supplyResult: CallResult | undefined,
): { decimals: number | null; symbol: string | null; issue: string | null } {
  const decimals = decodeDecimals(decimalsResult);
  const symbol = decodeSymbol(symbolResult);
  const totalSupply = decodeTotalSupply(supplyResult);

  const results = [decimalsResult, symbolResult, supplyResult];
  const allEmpty = results.every(
    (result) => result?.success === true && result.returnData === EMPTY_DATA,
  );
  const answered = results.filter((result) => result?.success === true).length;

  let issue: string | null = null;
  if (allEmpty) {
    issue = "no contract code (every call returned no data)";
  } else if (answered === 0) {
    issue = "reverted on decimals, symbol and totalSupply (not an ERC-20)";
  } else {
    const problems: string[] = [];
    if (decimals === null) {
      problems.push(decimalsResult?.success ? "decimals is not a uint8" : "decimals reverted");
    } else if (decimals > 36) {
      problems.push(`implausible decimals (${decimals})`);
    }
    if (symbol === null) {
      const text = symbolResult?.success ? bytes32Text(symbolResult.returnData) : null;
      if (text) problems.push(`symbol is bytes32 (${text}), not a string`);
      else if (symbolResult?.success) problems.push("symbol is neither a string nor bytes32 text");
      else problems.push("symbol reverted");
    } else if (symbol.trim().length === 0) {
      problems.push("symbol is empty");
    }
    if (totalSupply === null) {
      problems.push(
        supplyResult?.success ? "totalSupply is not a uint256" : "totalSupply reverted",
      );
    }
    if (problems.length > 0) issue = problems.join("; ");
  }

  return {
    decimals,
    symbol: symbol !== null && symbol.trim().length > 0 ? symbol.trim() : null,
    issue,
  };
}

/** Wrap decoded individual reads back into sub-call results for the classifier. */
function decodedResults(values: {
  decimals: number | null;
  symbol: string | null;
  supply: bigint | null;
}): [CallResult | undefined, CallResult | undefined, CallResult | undefined] {
  const decimals =
    values.decimals === null
      ? undefined
      : {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "decimals",
            result: values.decimals,
          }),
        };
  const symbol =
    values.symbol === null
      ? undefined
      : {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "symbol",
            result: values.symbol,
          }),
        };
  const supply =
    values.supply === null
      ? undefined
      : {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "totalSupply",
            result: values.supply,
          }),
        };
  return [decimals, symbol, supply];
}

/**
 * Read decimals, symbol and totalSupply for each address and classify it, so
 * `tokens` can warn about entries that are not readable ERC-20s before saving
 * them. Nothing here throws for a bad address: reverts, empty answers and batch
 * failures all become an `issue`. The report also carries the number of
 * Multicall3 verification requests and the cap that shaped them.
 */
export async function checkTokenAddressesReport(
  client: PublicClient,
  tokens: Address[],
  options: TokenCheckOptions = {},
): Promise<TokenCheckReport> {
  const batchSize = options.batchSize ?? TOKENS_PER_BATCH;
  const checks = new Map<string, TokenCheck>();

  const record = (
    token: Address,
    decimalsResult: CallResult | undefined,
    symbolResult: CallResult | undefined,
    supplyResult: CallResult | undefined,
  ): void => {
    const reading = inspectTokenMetadata(decimalsResult, symbolResult, supplyResult);
    checks.set(token.toLowerCase(), { address: token, ...reading });
  };

  const checkable = tokens.filter((token) => !isPrecompileAddress(token));
  const batches =
    options.maxSubCalls === undefined
      ? chunkTokens(checkable, batchSize)
      : chunkByCost(checkable, options.maxSubCalls, 3);

  await Promise.all(
    batches.map(async (batch) => {
      const calls = batch.flatMap((token) => [
        {
          target: token,
          allowFailure: true,
          callData: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
        },
        {
          target: token,
          allowFailure: true,
          callData: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }),
        },
        {
          target: token,
          allowFailure: true,
          callData: encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" }),
        },
      ]);

      try {
        const results = await readTyped(
          client,
          { address: MULTICALL3_ADDRESS, abi: multicall3BatchAbi },
          "aggregate3",
          calls,
        );
        batch.forEach((token, index) => {
          record(token, results[index * 3], results[index * 3 + 1], results[index * 3 + 2]);
        });
        return;
      } catch {
        // A failed aggregate (gas-heavy address, strict RPC) falls through to
        // individual reads so one bad entry does not flag its whole batch.
      }

      await Promise.all(
        batch.map(async (token) => {
          const [decimals, symbol, supply] = await Promise.all([
            attempt(() =>
              client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
            ),
            attempt(() =>
              client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
            ),
            attempt(() =>
              client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
            ),
          ]);
          const [decimalsResult, symbolResult, supplyResult] = decodedResults({
            decimals: typeof decimals === "number" ? decimals : null,
            symbol: typeof symbol === "string" ? symbol : null,
            supply: typeof supply === "bigint" ? supply : null,
          });
          record(token, decimalsResult, symbolResult, supplyResult);
        }),
      );
    }),
  );

  const classified = tokens.map(
    (token) =>
      checks.get(token.toLowerCase()) ?? {
        address: token,
        symbol: null,
        decimals: null,
        issue: isPrecompileAddress(token)
          ? "precompile address: no code, cannot be an ERC-20"
          : "no data returned for this address",
      },
  );

  return {
    checks: classified,
    chunkCount: batches.length,
    maxSubCalls: options.maxSubCalls ?? null,
  };
}

/** The classified checks only, for callers that do not need the request count. */
export async function checkTokenAddresses(
  client: PublicClient,
  tokens: Address[],
  options: TokenCheckOptions = {},
): Promise<TokenCheck[]> {
  return (await checkTokenAddressesReport(client, tokens, options)).checks;
}

export interface BalancesOptions {
  /** Reuse `decimals`/`symbol` seen on earlier runs instead of re-reading them. */
  cache?: MetadataCache;
  /** Ignore cached metadata for the requested tokens and re-read it. */
  refreshCache?: boolean;
  /** Refresh cached metadata older than this many milliseconds. */
  maxCacheAgeMs?: number;
  /** Lowercased address → label, shown next to the symbol in output. */
  labels?: ReadonlyMap<string, string>;
  /** Tokens per Multicall3 request; smaller values fit stricter gas caps. */
  batchSize?: number;
  /** Fixed sub-call cap per request; takes precedence over `batchSize`. */
  maxSubCalls?: number;
  /** Called once per chunk with its final status and fallback tokens. */
  onChunkProgress?: (progress: ChunkProgress) => void;
}

export async function readBalances(
  client: PublicClient,
  config: ChainConfig,
  owner: Address,
  tokens: Address[],
  options: BalancesOptions = {},
): Promise<BalancesReport> {
  if (options.cache && options.refreshCache) {
    for (const token of tokens) options.cache.invalidate(token);
  }
  if (options.cache && options.maxCacheAgeMs !== undefined) {
    options.cache.invalidateStale(options.maxCacheAgeMs);
  }
  const cacheStats = countCacheStats(tokens, options.cache);
  // Ages are captured before the read: tokens fetched in this run have no
  // pre-existing entry, so they are not misreported as freshly cached.
  const cacheAges = new Map<string, number>();
  if (options.cache) {
    for (const token of tokens) {
      const age = options.cache.ageMs(token);
      if (age !== null) cacheAges.set(token.toLowerCase(), age);
    }
  }

  const blockNumberPromise = client.getBlockNumber();
  const batchable = tokens.filter((token) => !isPrecompileAddress(token));
  const batchSize =
    options.batchSize ??
    (options.cache && cacheStats.hits > 0 && cacheStats.misses === 0
      ? CACHED_TOKENS_PER_BATCH
      : TOKENS_PER_BATCH);
  const batches =
    options.maxSubCalls === undefined
      ? chunkTokens(batchable, batchSize)
      : chunkBySubCalls(batchable, options.maxSubCalls, options.cache);
  const chunkReports: ChunkReport[] = batches.map((batch, index) => ({
    index: index + 1,
    total: batches.length,
    tokens: batch.length,
    status: "batched",
    error: null,
    individual: [],
  }));

  // Chunks go out together: a batch that reverts costs only its own tokens.
  const outcomes = await Promise.all(
    batches.map((batch, index) => readOwnerBatch(client, owner, batch, index === 0, options.cache)),
  );

  const discovered = new Map<string, TokenMetadata>();
  const byAddress = new Map<string, TokenBalance>();
  const warnings: string[] = [];
  let nativeBalance: bigint | null = null;

  const ingest = (outcome: {
    native: bigint | null;
    tokens: TokenBalance[];
    metadata: Map<string, TokenMetadata>;
  }): void => {
    for (const token of outcome.tokens) {
      byAddress.set(token.address.toLowerCase(), token);
    }
    for (const [address, metadata] of outcome.metadata) {
      discovered.set(address, metadata);
    }
    if (outcome.native !== null) nativeBalance = outcome.native;
  };

  const failed: Array<{ index: number; error: string }> = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.ok) {
      ingest(outcome);
      return;
    }
    failed.push({ index, error: outcome.error });
    const report = chunkReports[index];
    if (report) {
      report.status = "failed";
      report.error = outcome.error;
    }
  });

  // One retry per failed chunk, split in half: a gas-heavy aggregate often
  // succeeds once its sub-call count is halved. There is no second retry; any
  // tokens still missing after this go through individual reads below.
  const retries: Array<{
    batch: Address[];
    includeNative: boolean;
    chunkIndex: number;
  }> = [];
  for (const failure of failed) {
    const batch = batches[failure.index] ?? [];
    if (batch.length < 2) continue;
    const half = Math.ceil(batch.length / 2);
    retries.push(
      { batch: batch.slice(0, half), includeNative: failure.index === 0, chunkIndex: failure.index },
      { batch: batch.slice(half), includeNative: false, chunkIndex: failure.index },
    );
  }

  const retryOutcomes = await Promise.all(
    retries.map((retry) =>
      readOwnerBatch(client, owner, retry.batch, retry.includeNative, options.cache),
    ),
  );
  const retryAttempts = new Map<number, number>();
  const retrySuccesses = new Map<number, number>();
  retryOutcomes.forEach((outcome, index) => {
    const retry = retries[index];
    if (!retry) return;
    retryAttempts.set(retry.chunkIndex, (retryAttempts.get(retry.chunkIndex) ?? 0) + 1);
    if (!outcome.ok) return;
    retrySuccesses.set(retry.chunkIndex, (retrySuccesses.get(retry.chunkIndex) ?? 0) + 1);
    ingest(outcome);
  });

  for (const report of chunkReports) {
    if (report.status !== "failed") continue;
    const attempts = retryAttempts.get(report.index - 1) ?? 0;
    const successes = retrySuccesses.get(report.index - 1) ?? 0;
    if (attempts > 0 && successes === attempts) report.status = "recovered";
    else if (successes > 0) report.status = "partial";
  }

  // Re-read only the tokens still missing after the retry; the rest keep their
  // batched results. Record exactly which chunk each fallback came from.
  const missing = batchable.filter((token) => !byAddress.has(token.toLowerCase()));
  const chunkOf = new Map<string, ChunkReport>();
  batches.forEach((batch, index) => {
    const report = chunkReports[index];
    if (!report) return;
    for (const token of batch) chunkOf.set(token.toLowerCase(), report);
  });
  for (const token of missing) {
    chunkOf.get(token.toLowerCase())?.individual.push(token);
  }

  // Warn once per original chunk that is still incomplete. A chunk fully
  // recovered by its retry is not reported as a failure at all.
  for (const failure of failed) {
    const report = chunkReports[failure.index];
    if (!report || report.individual.length === 0) continue;
    warnings.push(
      batches.length > 1
        ? `batch ${failure.index + 1}/${batches.length}: ${failure.error}`
        : failure.error,
    );
  }

  for (const report of chunkReports) {
    options.onChunkProgress?.({ owner, ...report });
  }

  const recovered = await Promise.all(
    missing.map((token) => readTokenIndividually(client, token, owner)),
  );
  for (const entry of recovered) {
    byAddress.set(entry.result.address.toLowerCase(), entry.result);
    if (entry.metadata) discovered.set(entry.result.address.toLowerCase(), entry.metadata);
  }

  if (nativeBalance === null) {
    nativeBalance = await client.getBalance({ address: owner });
  }

  const tokenBalances: TokenBalance[] = tokens.map((token) => {
    const label = options.labels?.get(token.toLowerCase()) ?? null;
    const base = isPrecompileAddress(token)
      ? unreadableToken(token, "precompile address: no code, cannot be an ERC-20")
      : (byAddress.get(token.toLowerCase()) ?? unreadableToken(token));
    return { ...base, label, cacheAgeMs: cacheAges.get(token.toLowerCase()) ?? null };
  });

  if (options.cache) {
    for (const [address, metadata] of discovered) options.cache.set(address, metadata);
  }

  const batchWarning = warnings.length > 0 ? warnings.join("; ") : null;

  return {
    owner,
    chainId: config.chainId,
    chainName: config.name,
    native: {
      symbol: config.nativeCurrency.symbol,
      decimals: config.nativeCurrency.decimals,
      balance: nativeBalance,
    },
    tokens: tokenBalances,
    blockNumber: await blockNumberPromise,
    batchWarning,
    batchSize,
    chunkCount: chunkReports.length,
    chunks: chunkReports,
    recovery: {
      failedChunks: failed.length,
      retryRequests: retries.length,
      recoveredChunks: chunkReports.filter((report) => report.status === "recovered").length,
    },
    cache: cacheStats,
  };
}

function describeToken(token: TokenBalance): string {
  const tag = token.label ? ` [${token.label}]` : "";
  const base =
    token.balance === null
      ? `unreadable (${token.address})${tag}`
      : token.decimals === null
        ? `${token.balance} raw (${token.address})${tag}`
        : `${formatTokenAmount(token.balance, token.decimals)} ${token.symbol}${tag} (${token.address})`;
  const cached =
    token.cacheAgeMs == null ? "" : ` [cached ${formatCacheAge(token.cacheAgeMs)}]`;
  return token.issue ? `${base}${cached} — ${token.issue}` : `${base}${cached}`;
}

export function formatBalances(report: BalancesReport): string {
  const lines = [
    "lwc — balances",
    "",
    `  owner         ${report.owner}`,
    `  chain         ${report.chainName} (${report.chainId})`,
    `  block         ${report.blockNumber}`,
    "",
    `  native        ${formatTokenAmount(report.native.balance, report.native.decimals)} ${report.native.symbol}`,
  ];

  if (report.tokens.length === 0) {
    lines.push("  tokens        none requested (pass --token 0x… to include ERC-20s)");
  } else {
    for (const token of report.tokens) {
      lines.push(`  token         ${describeToken(token)}`);
    }
  }

  const flagged = report.tokens.filter((token) => token.issue !== null);
  if (flagged.length > 0) {
    lines.push("");
    lines.push(
      `  flagged       ${flagged.length} of ${report.tokens.length} ${flagged.length === 1 ? "address does" : "addresses do"} not look like a working ERC-20`,
    );
  }

  if (report.recovery.failedChunks > 0) {
    const failed = report.recovery.failedChunks;
    const retries = report.recovery.retryRequests;
    const recovered = report.recovery.recoveredChunks;
    lines.push("");
    lines.push(
      `  recovery      ${failed} failed chunk${failed === 1 ? "" : "s"}, ${retries} retry request${retries === 1 ? "" : "s"}, ${recovered} recovered`,
    );
  }

  if (report.batchWarning) {
    lines.push("");
    lines.push(`  batch         unavailable, read individually: ${report.batchWarning}`);
  }

  return lines.join("\n");
}

export function toBalancesJson(report: BalancesReport): Record<string, unknown> {
  return {
    ok: true,
    chain: { id: report.chainId, name: report.chainName },
    blockNumber: report.blockNumber.toString(),
    owner: report.owner,
    batchWarning: report.batchWarning,
    batchSize: report.batchSize,
    chunkCount: report.chunkCount,
    recovery: {
      failedChunks: report.recovery.failedChunks,
      retryRequests: report.recovery.retryRequests,
      recoveredChunks: report.recovery.recoveredChunks,
    },
    cache: { hits: report.cache.hits, misses: report.cache.misses },
    native: {
      symbol: report.native.symbol,
      decimals: report.native.decimals,
      balance: report.native.balance.toString(),
      formatted: formatTokenAmount(report.native.balance, report.native.decimals),
    },
    tokens: report.tokens.map((token) => ({
      address: token.address,
      symbol: token.symbol,
      label: token.label,
      decimals: token.decimals,
      issue: token.issue,
      cacheAgeMs: token.cacheAgeMs,
      balance: token.balance === null ? null : token.balance.toString(),
      formatted:
        token.balance === null || token.decimals === null
          ? null
          : formatTokenAmount(token.balance, token.decimals),
    })),
  };
}
