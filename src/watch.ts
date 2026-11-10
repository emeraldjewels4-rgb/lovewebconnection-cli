import { formatGwei, getAddress, isAddress, type Address, type PublicClient } from "viem";

import {
  formatTokenAmount,
  loadTokenList,
  MAX_SUB_CALLS,
  readBalances,
  type BalancesReport,
  type ChunkProgress,
  type ChunkStatus,
} from "./balances.ts";
import type { ChainConfig } from "./chain.ts";
import { MetadataCache } from "./metadata-cache.ts";
import {
  DEFAULT_METRICS_WINDOW,
  computeMetrics,
  computeSessionMetrics,
  createMetricsState,
  formatMetrics,
  formatSeconds,
  recordBlockTime,
  recordFailure,
  recordLatency,
  type SessionMetrics,
  type WatchMetrics,
} from "./metrics.ts";
import { PriceSource, priceChainSlug, usdValue, type PriceBook } from "./prices.ts";

export interface WatchOptions {
  /** Delay between polls. */
  intervalMs: number;
  /** How long the head may stay unchanged before a stall is reported. */
  stallAfterSeconds: number;
  /** Stop after this many successful samples; 0 runs until interrupted. */
  maxSamples: number;
  /** Percentage above the rolling gas baseline that counts as a surge. */
  gasSurgePercent: number;
  /** Rolling window size for latency and block-time statistics. */
  windowSize: number;
  /** Emit a rolling metrics line every n samples; 0 disables it. */
  reportEvery: number;
  /** Append every event to this file as one JSON object per line; null disables it. */
  logPath: string | null;
  /** Rotate the log to <path>.1 when it would grow past this many bytes; 0 disables it. */
  logMaxBytes: number;
  /** Re-launch in the background, logging to logPath, then exit. */
  detach: boolean;
  /** Alert when rolling p95 latency exceeds this many ms; null disables it. */
  alertLatencyMs: number | null;
  /** Alert when rolling median block time exceeds this many seconds; null disables it. */
  alertBlockTimeSeconds: number | null;
  /** Alert when a portfolio asset moves more than this percent between samples; null disables it. */
  alertBalancePercent: number | null;
  /** POST alert events here; null only prints and logs them. */
  webhookUrl: string | null;
  /** Authorization header sent with alert POSTs; null sends none. */
  alertAuthHeader: string | null;
  /** Durable alert queue file; null derives one from the log path. */
  alertQueuePath: string | null;
  /** Where alertAuthHeader came from; only used to word validation errors. */
  /** Owner whose portfolio is read; null disables portfolio sampling. */
  owner: Address | null;
  /** Portfolio tokens, loaded from --tokens-file. */
  tokens: Address[];
  /** Lowercased token address → label from the token list file. */
  labels: Map<string, string>;
  /** Sample the portfolio every n polls. */
  portfolioEvery: number;
  /**
   * Tokens per Multicall3 request when reading the portfolio; null uses
   * readBalances' automatic 12 uncached / 24 fully cached chunking.
   */
  batchSize: number | null;
  /** Fixed sub-call cap per portfolio request; null uses batchSize. */
  maxSubCalls: number | null;
  /** Print one line per portfolio Multicall3 chunk to stderr. */
  verbose: boolean;
  /** Value the portfolio in USD using DefiLlama prices. */
  usd: boolean;
}

export const DEFAULT_WATCH_OPTIONS: WatchOptions = {
  intervalMs: 3000,
  stallAfterSeconds: 30,
  maxSamples: 0,
  gasSurgePercent: 50,
  windowSize: DEFAULT_METRICS_WINDOW,
  reportEvery: 0,
  logPath: null,
  logMaxBytes: 0,
  detach: false,
  alertLatencyMs: null,
  alertBlockTimeSeconds: null,
  alertBalancePercent: null,
  webhookUrl: null,
  alertAuthHeader: null,
  alertQueuePath: null,
  owner: null,
  tokens: [],
  labels: new Map<string, string>(),
  portfolioEvery: 1,
  batchSize: null,
  maxSubCalls: null,
  verbose: false,
  usd: false,
};

const MAX_INTERVAL_SECONDS = 300;
const MAX_STALL_SECONDS = 3600;
const MAX_SAMPLES = 100_000;
const MAX_GAS_SURGE_PERCENT = 10_000;
const MAX_WINDOW = 1000;
const MAX_REPORT_EVERY = 10_000;
const MAX_ALERT_MS = 600_000;
const MAX_ALERT_BLOCK_SECONDS = 3600;
const MAX_ALERT_BALANCE_PERCENT = 10_000;
const MAX_BATCH_SIZE = 100;
const MIN_LOG_MAX_BYTES = 1024;
const MAX_LOG_MAX_BYTES = 10 * 1024 ** 3;
const MAX_CONSECUTIVE_ERRORS = 5;
const GAS_WINDOW = 10;

export class WatchArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchArgError";
  }
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new WatchArgError(`${flag} must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new WatchArgError(`${flag} must be between ${min} and ${max}.`);
  }
  return value;
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/** `512kb`, `10mb`, `1gb`, or a bare number of megabytes. */
export function parseLogSize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(raw.trim());
  if (!match) {
    throw new WatchArgError(`--log-max-size must look like "512kb" or "10mb", got "${raw}".`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "mb").toLowerCase();
  const bytes = Math.round(amount * (SIZE_UNITS[unit] ?? 1));

  if (!Number.isFinite(bytes) || bytes < MIN_LOG_MAX_BYTES) {
    throw new WatchArgError(`--log-max-size must be at least ${MIN_LOG_MAX_BYTES} bytes.`);
  }
  if (bytes > MAX_LOG_MAX_BYTES) {
    throw new WatchArgError(`--log-max-size must be at most ${MAX_LOG_MAX_BYTES / 1024 ** 3}gb.`);
  }

  return bytes;
}

export function parseWatchArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): WatchOptions {
  const options: WatchOptions = { ...DEFAULT_WATCH_OPTIONS };
  // .env is loaded before this runs, so the variable is the normal source and
  // the flag is only an explicit override.
  options.alertAuthHeader = env.LWC_WEBHOOK_AUTH?.trim() || null;
  let authSource = "LWC_WEBHOOK_AUTH";
  let sawBatchSize = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readValue = (flag: string): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new WatchArgError(`${flag} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === "--interval") {
      options.intervalMs =
        parseInteger(readValue("--interval"), "--interval", 1, MAX_INTERVAL_SECONDS) * 1000;
    } else if (arg === "--stall-after") {
      options.stallAfterSeconds = parseInteger(
        readValue("--stall-after"),
        "--stall-after",
        2,
        MAX_STALL_SECONDS,
      );
    } else if (arg === "--samples") {
      options.maxSamples = parseInteger(readValue("--samples"), "--samples", 0, MAX_SAMPLES);
    } else if (arg === "--gas-surge") {
      options.gasSurgePercent = parseInteger(
        readValue("--gas-surge"),
        "--gas-surge",
        1,
        MAX_GAS_SURGE_PERCENT,
      );
    } else if (arg === "--window") {
      options.windowSize = parseInteger(readValue("--window"), "--window", 5, MAX_WINDOW);
    } else if (arg === "--report-every") {
      options.reportEvery = parseInteger(
        readValue("--report-every"),
        "--report-every",
        0,
        MAX_REPORT_EVERY,
      );
    } else if (arg === "--alert-latency") {
      options.alertLatencyMs = parseInteger(
        readValue("--alert-latency"),
        "--alert-latency",
        1,
        MAX_ALERT_MS,
      );
    } else if (arg === "--alert-block-time") {
      options.alertBlockTimeSeconds = parseInteger(
        readValue("--alert-block-time"),
        "--alert-block-time",
        1,
        MAX_ALERT_BLOCK_SECONDS,
      );
    } else if (arg === "--alert-balance" || arg.startsWith("--alert-balance=")) {
      const value = arg.startsWith("--alert-balance=")
        ? arg.slice("--alert-balance=".length)
        : readValue("--alert-balance");
      options.alertBalancePercent = parseInteger(
        value,
        "--alert-balance",
        1,
        MAX_ALERT_BALANCE_PERCENT,
      );
    } else if (arg === "--alert-webhook-auth") {
      const value = readValue("--alert-webhook-auth").trim();
      if (!value) throw new WatchArgError("--alert-webhook-auth requires a header value.");
      options.alertAuthHeader = value;
      authSource = "--alert-webhook-auth";
    } else if (arg.startsWith("--alert-webhook-auth=")) {
      const value = arg.slice("--alert-webhook-auth=".length).trim();
      if (!value) throw new WatchArgError("--alert-webhook-auth requires a header value.");
      options.alertAuthHeader = value;
      authSource = "--alert-webhook-auth";
    } else if (arg === "--alert-queue" || arg.startsWith("--alert-queue=")) {
      const value = arg.startsWith("--alert-queue=")
        ? arg.slice("--alert-queue=".length)
        : readValue("--alert-queue");
      if (!value.trim()) throw new WatchArgError("--alert-queue requires a file path.");
      options.alertQueuePath = value;
    } else if (arg === "--alert-webhook") {
      options.webhookUrl = readValue("--alert-webhook");
    } else if (arg.startsWith("--alert-webhook=")) {
      const value = arg.slice("--alert-webhook=".length);
      if (!value) throw new WatchArgError("--alert-webhook requires a URL.");
      options.webhookUrl = value;
    } else if (arg === "--owner" || arg.startsWith("--owner=")) {
      const value = arg.startsWith("--owner=")
        ? arg.slice("--owner=".length)
        : readValue("--owner");
      if (!isAddress(value)) {
        throw new WatchArgError(`"${value}" is not a valid owner address.`);
      }
      options.owner = getAddress(value);
    } else if (arg === "--tokens-file" || arg.startsWith("--tokens-file=")) {
      const value = arg.startsWith("--tokens-file=")
        ? arg.slice("--tokens-file=".length)
        : readValue("--tokens-file");
      if (!value) throw new WatchArgError("--tokens-file requires a path.");
      try {
        const entries = loadTokenList(value);
        options.tokens = entries.map((entry) => entry.address);
        options.labels = new Map(
          entries.flatMap((entry) =>
            entry.label ? [[entry.address.toLowerCase(), entry.label] as [string, string]] : [],
          ),
        );
      } catch (error) {
        throw new WatchArgError(error instanceof Error ? error.message : String(error));
      }
    } else if (arg === "--portfolio-every") {
      options.portfolioEvery = parseInteger(
        readValue("--portfolio-every"),
        "--portfolio-every",
        1,
        MAX_SAMPLES,
      );
    } else if (arg === "--batch-size" || arg.startsWith("--batch-size=")) {
      if (options.maxSubCalls !== null) {
        throw new WatchArgError("use either --batch-size or --max-subcalls, not both.");
      }
      const value = arg.startsWith("--batch-size=")
        ? arg.slice("--batch-size=".length)
        : readValue("--batch-size");
      options.batchSize = parseInteger(value, "--batch-size", 1, MAX_BATCH_SIZE);
      sawBatchSize = true;
    } else if (arg === "--max-subcalls" || arg.startsWith("--max-subcalls=")) {
      if (sawBatchSize) {
        throw new WatchArgError("use either --batch-size or --max-subcalls, not both.");
      }
      const value = arg.startsWith("--max-subcalls=")
        ? arg.slice("--max-subcalls=".length)
        : readValue("--max-subcalls");
      options.maxSubCalls = parseInteger(value, "--max-subcalls", 1, MAX_SUB_CALLS);
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--usd") {
      options.usd = true;
    } else if (arg === "--log") {
      options.logPath = readValue("--log");
    } else if (arg.startsWith("--log=")) {
      const value = arg.slice("--log=".length);
      if (!value) throw new WatchArgError("--log requires a file path.");
      options.logPath = value;
    } else if (arg === "--log-max-size") {
      options.logMaxBytes = parseLogSize(readValue("--log-max-size"));
    } else if (arg.startsWith("--log-max-size=")) {
      const value = arg.slice("--log-max-size=".length);
      if (!value) throw new WatchArgError("--log-max-size requires a size, e.g. 10mb.");
      options.logMaxBytes = parseLogSize(value);
    } else if (arg === "--detach") {
      options.detach = true;
    }
  }

  if (options.detach && !options.logPath) {
    throw new WatchArgError("--detach requires --log <path> so the output is not lost.");
  }

  if (options.logMaxBytes > 0 && options.logPath === null) {
    throw new WatchArgError("--log-max-size needs --log <path> so it has a file to rotate.");
  }

  if (options.webhookUrl !== null) {
    if (!/^https?:\/\/\S+$/.test(options.webhookUrl)) {
      throw new WatchArgError(
        `--alert-webhook must be an http(s) URL, got "${options.webhookUrl}".`,
      );
    }
    if (
      options.alertLatencyMs === null &&
      options.alertBlockTimeSeconds === null &&
      options.alertBalancePercent === null
    ) {
      throw new WatchArgError(
        "--alert-webhook needs --alert-latency, --alert-block-time or --alert-balance so it knows when to fire.",
      );
    }
  }

  if (options.alertAuthHeader !== null) {
    if (/[\r\n]/.test(options.alertAuthHeader)) {
      throw new WatchArgError(`${authSource} must be a single line.`);
    }
    // The variable is global to the shell, so it is simply unused when there is
    // no webhook; an explicit flag without one is still a mistake.
    if (options.webhookUrl === null && authSource === "--alert-webhook-auth") {
      throw new WatchArgError("--alert-webhook-auth needs --alert-webhook <url>.");
    }
  }

  if (
    options.alertBalancePercent !== null &&
    (options.owner === null || options.tokens.length === 0)
  ) {
    throw new WatchArgError(
      "--alert-balance needs --owner and --tokens-file so it has balances to compare.",
    );
  }

  if (options.usd && (options.owner === null || options.tokens.length === 0)) {
    throw new WatchArgError(
      "--usd needs --owner and --tokens-file so it has a portfolio to value.",
    );
  }

  if (options.owner === null && options.tokens.length > 0) {
    throw new WatchArgError(
      "--tokens-file needs --owner <address> so it knows whose balances to read.",
    );
  }
  if (options.owner !== null && options.tokens.length === 0) {
    throw new WatchArgError("--owner needs --tokens-file with at least one token.");
  }

  if (options.stallAfterSeconds * 1000 < options.intervalMs) {
    throw new WatchArgError(
      `--stall-after (${options.stallAfterSeconds}s) must be at least the poll interval (${options.intervalMs / 1000}s).`,
    );
  }

  return options;
}

export interface PortfolioHolding {
  address: Address;
  symbol: string;
  label: string | null;
  decimals: number | null;
  balance: bigint | null;
  /** Change since the previous portfolio sample; null for the first one. */
  delta: bigint | null;
  /** USD value at this sample's prices; null when the asset could not be priced. */
  usd: number | null;
}

export interface PortfolioNative {
  symbol: string;
  decimals: number;
  balance: bigint;
  delta: bigint | null;
  usd: number | null;
}

export type WatchEvent =
  | {
      type: "advance";
      at: number;
      blockNumber: bigint;
      delta: bigint;
      gasPriceWei: bigint | null;
      latencyMs: number;
    }
  | {
      type: "hold";
      at: number;
      blockNumber: bigint;
      staleSeconds: number;
      gasPriceWei: bigint | null;
      latencyMs: number;
    }
  | { type: "stall"; at: number; blockNumber: bigint; staleSeconds: number }
  | {
      type: "recovered";
      at: number;
      from: bigint;
      to: bigint;
      stalledForSeconds: number;
    }
  | {
      type: "chain-drift";
      at: number;
      expected: number;
      previous: number | null;
      actual: number;
    }
  | {
      type: "gas-surge";
      at: number;
      gasPriceWei: bigint;
      baselineWei: bigint;
      increasePercent: number;
    }
  | { type: "gas-normal"; at: number; gasPriceWei: bigint; baselineWei: bigint }
  | {
      type: "alert";
      at: number;
      metric: "latency" | "block-time";
      direction: "breach" | "clear";
      value: number;
      threshold: number;
      /** Rolling metrics snapshot that triggered this alert. */
      metrics: WatchMetrics;
      /** Whole-session totals at the moment of the alert. */
      cumulative: SessionMetrics;
    }
  | {
      type: "balance-alert";
      at: number;
      asset: "native" | "token";
      /** Token address, or null for the native balance. */
      address: Address | null;
      symbol: string;
      label: string | null;
      decimals: number | null;
      previous: bigint;
      balance: bigint;
      delta: bigint;
      /** Percent moved, rounded; null when the previous balance was zero. */
      changePercent: number | null;
      thresholdPercent: number;
    }
  | {
      type: "portfolio";
      at: number;
      blockNumber: bigint | null;
      /** Tokens per Multicall3 request for this sample; null when it failed. */
      batchSize: number | null;
      /** Multicall3 chunks used by this sample; null when it failed. */
      chunkCount: number | null;
      native: PortfolioNative | null;
      tokens: PortfolioHolding[];
      /** Sum of the priced holdings, or null when nothing could be priced. */
      usdTotal: number | null;
      /** Why prices were unavailable; null when they were not needed or worked. */
      priceError: string | null;
      error: string | null;
    }
  | {
      type: "chunk-recovery";
      at: number;
      /** Portfolio owner whose chunks were read. */
      owner: Address;
      /** 1-based position of the chunk that needed a retry, and the chunk count. */
      chunk: number;
      chunks: number;
      /** Tokens assigned to the chunk. */
      tokens: number;
      status: ChunkStatus;
      /** Why the chunk's first Multicall3 request failed; null when unknown. */
      error: string | null;
      /** Tokens from the chunk that had to be re-read individually. */
      individual: Address[];
    }
  | {
      type: "metrics";
      at: number;
      /** Rolling window snapshot. */
      metrics: WatchMetrics;
      /** Whole-session totals at the same moment. */
      cumulative: SessionMetrics;
    }
  | { type: "error"; at: number; message: string };

export interface WatchTrackerState {
  lastBlock: bigint | null;
  lastChainId: number | null;
  lastAdvanceAt: number;
  stalledSince: number | null;
  gasHistory: bigint[];
  gasSurge: boolean;
}

export interface WatchSample {
  at: number;
  blockNumber: bigint;
  chainId: number;
  gasPriceWei: bigint | null;
  latencyMs: number;
}

export function createTracker(): WatchTrackerState {
  return {
    lastBlock: null,
    lastChainId: null,
    lastAdvanceAt: 0,
    stalledSince: null,
    gasHistory: [],
    gasSurge: false,
  };
}

function median(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2n;
}

/**
 * Pure state machine: given the previous state and a fresh sample, decide which
 * events happened. Chain drift is reported when the observed id differs from the
 * configured one and from the previous observation. Gas surges compare the
 * current price against the median of the last readings, with hysteresis so a
 * price hovering at the threshold does not flap.
 */
export function evaluateSample(
  state: WatchTrackerState,
  sample: WatchSample,
  options: Pick<WatchOptions, "stallAfterSeconds" | "gasSurgePercent">,
  expectedChainId: number,
): { state: WatchTrackerState; events: WatchEvent[] } {
  const events: WatchEvent[] = [];

  if (sample.chainId !== expectedChainId && sample.chainId !== state.lastChainId) {
    events.push({
      type: "chain-drift",
      at: sample.at,
      expected: expectedChainId,
      previous: state.lastChainId,
      actual: sample.chainId,
    });
  }

  let lastAdvanceAt = state.lastAdvanceAt;
  let stalledSince = state.stalledSince;

  if (state.lastBlock === null || sample.blockNumber > state.lastBlock) {
    const delta = state.lastBlock === null ? 0n : sample.blockNumber - state.lastBlock;

    if (stalledSince !== null) {
      events.push({
        type: "recovered",
        at: sample.at,
        from: state.lastBlock ?? sample.blockNumber,
        to: sample.blockNumber,
        stalledForSeconds: Math.max(0, Math.round((sample.at - stalledSince) / 1000)),
      });
      stalledSince = null;
    }

    lastAdvanceAt = sample.at;
    events.push({
      type: "advance",
      at: sample.at,
      blockNumber: sample.blockNumber,
      delta,
      gasPriceWei: sample.gasPriceWei,
      latencyMs: sample.latencyMs,
    });
  } else {
    const staleSeconds = Math.max(0, Math.floor((sample.at - lastAdvanceAt) / 1000));

    if (staleSeconds >= options.stallAfterSeconds && stalledSince === null) {
      stalledSince = lastAdvanceAt;
      events.push({
        type: "stall",
        at: sample.at,
        blockNumber: state.lastBlock ?? sample.blockNumber,
        staleSeconds,
      });
    } else if (stalledSince === null) {
      events.push({
        type: "hold",
        at: sample.at,
        blockNumber: state.lastBlock ?? sample.blockNumber,
        staleSeconds,
        gasPriceWei: sample.gasPriceWei,
        latencyMs: sample.latencyMs,
      });
    }
  }

  let gasHistory = state.gasHistory;
  let gasSurge = state.gasSurge;

  if (sample.gasPriceWei !== null) {
    const baseline = median(gasHistory);
    const current = sample.gasPriceWei;

    if (baseline !== null && baseline > 0n) {
      const increasePercent = Math.round(
        (Number(current - baseline) * 100) / Number(baseline),
      );
      const threshold = options.gasSurgePercent;

      if (!gasSurge && increasePercent >= threshold) {
        gasSurge = true;
        events.push({
          type: "gas-surge",
          at: sample.at,
          gasPriceWei: current,
          baselineWei: baseline,
          increasePercent,
        });
      } else if (gasSurge && increasePercent < threshold / 2) {
        gasSurge = false;
        events.push({
          type: "gas-normal",
          at: sample.at,
          gasPriceWei: current,
          baselineWei: baseline,
        });
      }
    }

    gasHistory = [...gasHistory, current].slice(-GAS_WINDOW);
  }

  return {
    state: {
      lastBlock:
        state.lastBlock === null || sample.blockNumber > state.lastBlock
          ? sample.blockNumber
          : state.lastBlock,
      lastChainId: sample.chainId,
      lastAdvanceAt,
      stalledSince,
      gasHistory,
      gasSurge,
    },
    events,
  };
}

export interface AlertState {
  latencyBreaching: boolean;
  blockTimeBreaching: boolean;
}

export function createAlertState(): AlertState {
  return { latencyBreaching: false, blockTimeBreaching: false };
}

export type AlertThresholds = Pick<WatchOptions, "alertLatencyMs" | "alertBlockTimeSeconds">;

interface AlertSignal {
  metric: "latency" | "block-time";
  direction: "breach" | "clear";
  value: number;
  threshold: number;
}

/**
 * Edge-triggered thresholds: one alert when a metric rises above its limit and
 * one when it falls back under it, so a sustained breach does not repeat on
 * every sample.
 */
export function evaluateAlerts(
  metrics: WatchMetrics,
  thresholds: AlertThresholds,
  state: AlertState,
): { state: AlertState; alerts: AlertSignal[] } {
  const alerts: AlertSignal[] = [];
  const next: AlertState = { ...state };

  if (thresholds.alertLatencyMs !== null && metrics.latency.count > 0) {
    const value = metrics.latency.p95;
    const threshold = thresholds.alertLatencyMs;
    if (!next.latencyBreaching && value > threshold) {
      next.latencyBreaching = true;
      alerts.push({ metric: "latency", direction: "breach", value, threshold });
    } else if (next.latencyBreaching && value <= threshold) {
      next.latencyBreaching = false;
      alerts.push({ metric: "latency", direction: "clear", value, threshold });
    }
  }

  if (thresholds.alertBlockTimeSeconds !== null && metrics.blockTime.count > 0) {
    const value = metrics.blockTime.medianSeconds;
    const threshold = thresholds.alertBlockTimeSeconds;
    if (!next.blockTimeBreaching && value > threshold) {
      next.blockTimeBreaching = true;
      alerts.push({ metric: "block-time", direction: "breach", value, threshold });
    } else if (next.blockTimeBreaching && value <= threshold) {
      next.blockTimeBreaching = false;
      alerts.push({ metric: "block-time", direction: "clear", value, threshold });
    }
  }

  return { state: next, alerts };
}

export interface WatchSummary {
  samples: number;
  errors: number;
  firstBlock: bigint | null;
  lastBlock: bigint | null;
  advancedBy: bigint;
  chainDrift: boolean;
  stalls: number;
  gasSurges: number;
  alerts: number;
  lastGasWei: bigint | null;
  peakGasWei: bigint | null;
  metrics: WatchMetrics;
  /** Whole-run totals, independent of the rolling window. */
  session: SessionMetrics;
  durationMs: number;
  aborted: boolean;
  portfolio: PortfolioSummary | null;
}

export interface PortfolioSummary {
  samples: number;
  native: {
    symbol: string;
    decimals: number;
    first: bigint;
    last: bigint;
    delta: bigint;
  } | null;
  tokens: Array<{
    address: Address;
    symbol: string;
    label: string | null;
    decimals: number | null;
    first: bigint | null;
    last: bigint | null;
    delta: bigint | null;
  }>;
}

export interface WatchDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected portfolio reader; defaults to readBalances with an in-memory cache. */
  readPortfolio?: () => Promise<BalancesReport>;
  /** Injected price reader; defaults to DefiLlama with a 60 s cache. */
  readPrices?: (tokens: Address[]) => Promise<PriceBook>;
  /** Receives each portfolio Multicall3 chunk as it settles. */
  onChunkProgress?: (progress: ChunkProgress) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function describeWatchError(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return short;
    return error.message;
  }
  return String(error);
}

export interface BalanceChange {
  delta: bigint;
  /** Percent of the previous balance, rounded; null when it was zero. */
  changePercent: number | null;
  direction: "up" | "down";
}

/**
 * Compare two readings of the same balance. Returns null unless the move is
 * strictly larger than `thresholdPercent`. A balance that was zero has no
 * percentage baseline, so any move away from zero alerts.
 */
export function describeBalanceChange(
  previous: bigint,
  balance: bigint,
  thresholdPercent: number,
): BalanceChange | null {
  const delta = balance - previous;
  if (delta === 0n) return null;
  const direction = delta > 0n ? "up" : "down";
  if (previous === 0n) return { delta, changePercent: null, direction };

  const percent = (Number(delta) * 100) / Number(previous);
  if (Math.abs(percent) <= thresholdPercent) return null;
  return { delta, changePercent: Math.round(percent), direction };
}

export async function watchChain(
  client: PublicClient,
  config: ChainConfig,
  options: WatchOptions,
  onEvent: (event: WatchEvent) => unknown,
  signal?: AbortSignal,
  deps: WatchDeps = {},
): Promise<WatchSummary> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;

  const summary: WatchSummary = {
    samples: 0,
    errors: 0,
    firstBlock: null,
    lastBlock: null,
    advancedBy: 0n,
    chainDrift: false,
    stalls: 0,
    gasSurges: 0,
    alerts: 0,
    lastGasWei: null,
    peakGasWei: null,
    metrics: computeMetrics(createMetricsState(options.windowSize)),
    session: computeSessionMetrics(createMetricsState(options.windowSize)),
    durationMs: 0,
    aborted: false,
    portfolio: null,
  };

  const startedAt = now();
  let tracker = createTracker();
  let alertState = createAlertState();
  let metricsState = createMetricsState(options.windowSize);
  let consecutiveErrors = 0;
  let previousAdvanceAt: number | null = null;

  const portfolioState = new Map<
    string,
    {
      address: Address;
      symbol: string;
      label: string | null;
      decimals: number | null;
      first: bigint | null;
      last: bigint | null;
    }
  >();
  let portfolioSamples = 0;
  let lastBalances: Map<string, bigint | null> | null = null;
  let lastNative: bigint | null = null;
  let firstNative: bigint | null = null;
  let nativeMeta: { symbol: string; decimals: number } | null = null;
  const metadataCache = new MetadataCache({ chainId: config.chainId, persist: false });
  const readPortfolio =
    deps.readPortfolio ??
    ((): Promise<BalancesReport> =>
      readBalances(client, config, options.owner as Address, options.tokens, {
        cache: metadataCache,
        labels: options.labels,
        batchSize: options.batchSize ?? undefined,
        maxSubCalls: options.maxSubCalls ?? undefined,
        onChunkProgress: deps.onChunkProgress,
      }));
  const priceSlug = options.usd ? priceChainSlug(config.chainId) : null;
  const priceSource = priceSlug === null ? null : new PriceSource({ chainSlug: priceSlug });
  const readPrices =
    deps.readPrices ??
    (priceSource === null
      ? undefined
      : (tokens: Address[]): Promise<PriceBook> => priceSource.prices(tokens));

  while (!signal?.aborted) {
    if (options.maxSamples > 0 && summary.samples >= options.maxSamples) break;

    const callStarted = now();
    try {
      const [blockNumber, gasPriceWei, chainId] = await Promise.all([
        client.getBlockNumber(),
        client.getGasPrice().catch(() => null),
        client.getChainId(),
      ]);

      const at = now();
      const latencyMs = Math.max(0, at - callStarted);

      const evaluated = evaluateSample(
        tracker,
        { at, blockNumber, chainId, gasPriceWei, latencyMs },
        options,
        config.chainId,
      );
      tracker = evaluated.state;
      metricsState = recordLatency(metricsState, latencyMs);

      for (const event of evaluated.events) {
        if (event.type === "stall") summary.stalls += 1;
        if (event.type === "chain-drift") summary.chainDrift = true;
        if (event.type === "gas-surge") summary.gasSurges += 1;
        if (event.type === "advance") {
          if (event.delta > 0n && previousAdvanceAt !== null) {
            metricsState = recordBlockTime(
              metricsState,
              Math.max(0, (event.at - previousAdvanceAt) / 1000),
            );
          }
          previousAdvanceAt = event.at;
        }
        await onEvent(event);
      }

      const currentMetrics = computeMetrics(metricsState);
      const cumulativeMetrics = computeSessionMetrics(metricsState);
      const evaluatedAlerts = evaluateAlerts(currentMetrics, options, alertState);
      alertState = evaluatedAlerts.state;
      for (const alert of evaluatedAlerts.alerts) {
        summary.alerts += 1;
        await onEvent({
          type: "alert",
          at,
          ...alert,
          metrics: currentMetrics,
          cumulative: cumulativeMetrics,
        });
      }

      const sampleIndex = summary.samples + 1;
      if (
        options.owner !== null &&
        options.tokens.length > 0 &&
        sampleIndex % options.portfolioEvery === 0
      ) {
        try {
          const report = await readPortfolio();
          portfolioSamples += 1;

          // A chunk that needed a sub-batch retry or an individual fallback is
          // reported before the sample it belongs to, so a log reader sees the
          // recovery ahead of the balances it recovered.
          for (const chunk of report.chunks) {
            if (chunk.status === "batched") continue;
            await onEvent({
              type: "chunk-recovery",
              at: now(),
              owner: report.owner,
              chunk: chunk.index,
              chunks: chunk.total,
              tokens: chunk.tokens,
              status: chunk.status,
              error: chunk.error,
              individual: chunk.individual,
            });
          }

          let priceBook: PriceBook | null = null;
          let priceError: string | null = null;
          if (options.usd) {
            if (readPrices === undefined) {
              priceError = `no price feed for chain ${config.chainId}`;
            } else {
              try {
                priceBook = await readPrices(report.tokens.map((token) => token.address));
                priceError = priceBook.error;
              } catch (error) {
                priceError = describeWatchError(error);
              }
            }
          }

          const balanceAlerts: WatchEvent[] = [];
          const tokens: PortfolioHolding[] = report.tokens.map((token) => {
            const key = token.address.toLowerCase();
            const before = lastBalances?.get(key) ?? null;
            const delta = before !== null && token.balance !== null ? token.balance - before : null;
            const known = portfolioState.get(key);
            portfolioState.set(key, {
              address: token.address,
              symbol: token.symbol,
              label: token.label,
              decimals: token.decimals,
              first: known?.first ?? token.balance,
              last: token.balance,
            });
            if (
              options.alertBalancePercent !== null &&
              before !== null &&
              token.balance !== null
            ) {
              const change = describeBalanceChange(
                before,
                token.balance,
                options.alertBalancePercent,
              );
              if (change !== null) {
                balanceAlerts.push({
                  type: "balance-alert",
                  at: now(),
                  asset: "token",
                  address: token.address,
                  symbol: token.symbol,
                  label: token.label,
                  decimals: token.decimals,
                  previous: before,
                  balance: token.balance,
                  delta: change.delta,
                  changePercent: change.changePercent,
                  thresholdPercent: options.alertBalancePercent,
                });
              }
            }
            return {
              address: token.address,
              symbol: token.symbol,
              label: token.label,
              decimals: token.decimals,
              balance: token.balance,
              delta,
              usd: usdValue(token.balance, token.decimals, priceBook?.tokens.get(key)?.price ?? null),
            };
          });
          lastBalances = new Map(
            report.tokens.map((token) => [token.address.toLowerCase(), token.balance]),
          );

          const previousNative = lastNative;
          const nativeDelta =
            previousNative === null ? null : report.native.balance - previousNative;
          lastNative = report.native.balance;
          if (options.alertBalancePercent !== null && previousNative !== null) {
            const change = describeBalanceChange(
              previousNative,
              report.native.balance,
              options.alertBalancePercent,
            );
            if (change !== null) {
              balanceAlerts.push({
                type: "balance-alert",
                at: now(),
                asset: "native",
                address: null,
                symbol: report.native.symbol,
                label: null,
                decimals: report.native.decimals,
                previous: previousNative,
                balance: report.native.balance,
                delta: change.delta,
                changePercent: change.changePercent,
                thresholdPercent: options.alertBalancePercent,
              });
            }
          }
          if (firstNative === null) firstNative = report.native.balance;
          nativeMeta = { symbol: report.native.symbol, decimals: report.native.decimals };

          const nativeUsd = usdValue(
            report.native.balance,
            report.native.decimals,
            priceBook?.native?.price ?? null,
          );
          const priced = [...tokens.map((token) => token.usd), nativeUsd].filter(
            (value): value is number => value !== null,
          );
          const usdTotal = priced.length === 0 ? null : priced.reduce((sum, value) => sum + value, 0);

          await onEvent({
            type: "portfolio",
            at: now(),
            blockNumber: report.blockNumber,
            batchSize: report.batchSize,
            chunkCount: report.chunkCount,
            native: {
              symbol: report.native.symbol,
              decimals: report.native.decimals,
              balance: report.native.balance,
              delta: nativeDelta,
              usd: nativeUsd,
            },
            tokens,
            usdTotal,
            priceError,
            error: null,
          });

          for (const alert of balanceAlerts) {
            summary.alerts += 1;
            await onEvent(alert);
          }
        } catch (error) {
          await onEvent({
            type: "portfolio",
            at: now(),
            blockNumber: null,
            batchSize: null,
            chunkCount: null,
            native: null,
            tokens: [],
            usdTotal: null,
            priceError: null,
            error: describeWatchError(error),
          });
        }
      }

      summary.samples += 1;
      consecutiveErrors = 0;
      if (summary.firstBlock === null) summary.firstBlock = blockNumber;
      summary.lastBlock = blockNumber;

      if (gasPriceWei !== null) {
        summary.lastGasWei = gasPriceWei;
        if (summary.peakGasWei === null || gasPriceWei > summary.peakGasWei) {
          summary.peakGasWei = gasPriceWei;
        }
      }

      if (options.reportEvery > 0 && summary.samples % options.reportEvery === 0) {
        summary.metrics = currentMetrics;
        await onEvent({
          type: "metrics",
          at,
          metrics: currentMetrics,
          cumulative: cumulativeMetrics,
        });
      }
    } catch (error) {
      consecutiveErrors += 1;
      summary.errors += 1;
      metricsState = recordFailure(metricsState);
      await onEvent({ type: "error", at: now(), message: describeWatchError(error) });
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
    }

    if (options.maxSamples > 0 && summary.samples >= options.maxSamples) break;
    if (signal?.aborted) break;
    await sleep(options.intervalMs);
  }

  summary.aborted = signal?.aborted ?? false;
  summary.durationMs = Math.max(0, now() - startedAt);
  if (summary.firstBlock !== null && summary.lastBlock !== null) {
    summary.advancedBy = summary.lastBlock - summary.firstBlock;
  }
  summary.metrics = computeMetrics(metricsState);
  summary.session = computeSessionMetrics(metricsState);

  if (options.owner !== null && options.tokens.length > 0) {
    summary.portfolio = {
      samples: portfolioSamples,
      native:
        nativeMeta && firstNative !== null && lastNative !== null
          ? {
              symbol: nativeMeta.symbol,
              decimals: nativeMeta.decimals,
              first: firstNative,
              last: lastNative,
              delta: lastNative - firstNative,
            }
          : null,
      tokens: [...portfolioState.values()].map((entry) => ({
        address: entry.address,
        symbol: entry.symbol,
        label: entry.label,
        decimals: entry.decimals,
        first: entry.first,
        last: entry.last,
        delta: entry.first !== null && entry.last !== null ? entry.last - entry.first : null,
      })),
    };
  }

  return summary;
}

function clockTime(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function formatGas(wei: bigint | null): string {
  return wei === null ? "gas n/a" : `${formatGwei(wei)} gwei`;
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDelta(delta: bigint | null, decimals: number | null): string {
  if (delta === null) return "";
  if (delta === 0n) return " (no change)";
  const text = decimals === null ? delta.toString() : formatTokenAmount(delta, decimals);
  return ` (${delta > 0n ? "+" : ""}${text})`;
}

export function formatWatchEvent(event: WatchEvent, config: ChainConfig): string {
  const stamp = clockTime(event.at);

  switch (event.type) {
    case "advance":
      return `${stamp}  block ${event.blockNumber} (+${event.delta})  ${formatGas(event.gasPriceWei)}  ${event.latencyMs} ms`;
    case "hold":
      return `${stamp}  block ${event.blockNumber} (unchanged ${event.staleSeconds}s)  ${formatGas(event.gasPriceWei)}  ${event.latencyMs} ms`;
    case "stall":
      return `${stamp}  STALL: block ${event.blockNumber} has not advanced for ${event.staleSeconds}s`;
    case "recovered":
      return `${stamp}  RECOVERED: ${event.from} → ${event.to} after ${event.stalledForSeconds}s`;
    case "chain-drift":
      return `${stamp}  CHAIN DRIFT: expected ${event.expected} (${config.name}), RPC answered ${event.actual}`;
    case "gas-surge":
      return `${stamp}  GAS SURGE: ${formatGwei(event.gasPriceWei)} gwei, +${event.increasePercent}% over ${formatGwei(event.baselineWei)} gwei baseline`;
    case "gas-normal":
      return `${stamp}  GAS NORMAL: ${formatGwei(event.gasPriceWei)} gwei (baseline ${formatGwei(event.baselineWei)} gwei)`;
    case "alert": {
      const label = event.metric === "latency" ? "latency p95" : "block time";
      const unit = event.metric === "latency" ? "ms" : "s";
      return event.direction === "breach"
        ? `${stamp}  ALERT: ${label} ${event.value} ${unit} is above ${event.threshold} ${unit}`
        : `${stamp}  ALERT CLEARED: ${label} ${event.value} ${unit} back under ${event.threshold} ${unit}`;
    }
    case "balance-alert": {
      const name = event.label ? `${event.symbol} [${event.label}]` : event.symbol;
      const amount = (value: bigint): string =>
        event.decimals === null ? value.toString() : formatTokenAmount(value, event.decimals);
      const move =
        event.changePercent === null
          ? `${amount(event.previous)} → ${amount(event.balance)} (from zero)`
          : `${event.changePercent > 0 ? "+" : ""}${event.changePercent}% (${amount(event.previous)} → ${amount(event.balance)})`;
      return `${stamp}  BALANCE ALERT: ${name} ${move} exceeds ${event.thresholdPercent}%`;
    }
    case "chunk-recovery": {
      const status =
        event.status === "recovered"
          ? "recovered"
          : event.status === "partial"
            ? "partly recovered"
            : "failed";
      const individual =
        event.individual.length > 0
          ? `, ${event.individual.length} read individually`
          : "";
      const reason = event.error === null ? "" : `  ${event.error}`;
      return `${stamp}  PORTFOLIO CHUNK ${event.chunk}/${event.chunks} (${event.tokens} token${event.tokens === 1 ? "" : "s"}) ${status}${individual}${reason}`;
    }
    case "portfolio": {
      const head = `${stamp}  PORTFOLIO  block ${event.blockNumber ?? "n/a"}${event.usdTotal === null ? "" : `  total ${formatUsd(event.usdTotal)}`}`;
      if (event.error) return `${head}\n  error: ${event.error}`;
      const rows: string[] = [];
      if (event.native) {
        rows.push(
          `  native ${formatTokenAmount(event.native.balance, event.native.decimals)} ${event.native.symbol}${formatDelta(event.native.delta, event.native.decimals)}${event.native.usd === null ? "" : `  ≈ ${formatUsd(event.native.usd)}`}`,
        );
      }
      for (const token of event.tokens) {
        const name = token.label ? `${token.symbol} [${token.label}]` : token.symbol;
        const value =
          token.balance === null
            ? "unreadable"
            : token.decimals === null
              ? `${token.balance} raw`
              : formatTokenAmount(token.balance, token.decimals);
        rows.push(
          `  ${name} ${value}${formatDelta(token.delta, token.decimals)}${token.usd === null ? "" : `  ≈ ${formatUsd(token.usd)}`}`,
        );
      }
      if (event.priceError) rows.push(`  prices ${event.priceError}`);
      return [head, ...rows].join("\n");
    }
    case "metrics":
      return `${stamp}  METRICS: ${formatMetrics(event.metrics, event.cumulative)}`;
    case "error":
      return `${stamp}  error: ${event.message}`;
  }
}

export function formatWatchSummary(summary: WatchSummary): string {
  const lines = [
    "lwc — watch summary",
    "",
    `  samples       ${summary.samples}`,
    `  duration      ${formatDuration(summary.durationMs)}`,
  ];

  if (summary.firstBlock !== null && summary.lastBlock !== null) {
    lines.push(
      `  block         ${summary.firstBlock} → ${summary.lastBlock} (+${summary.advancedBy})`,
    );
  }

  if (summary.lastGasWei !== null) {
    const peak = summary.peakGasWei === null ? "n/a" : `${formatGwei(summary.peakGasWei)} gwei`;
    lines.push(`  gas           ${formatGwei(summary.lastGasWei)} gwei (peak ${peak})`);
  }

  const { latency, blockTime } = summary.metrics;
  const session = summary.session;
  if (latency.count > 0) {
    lines.push(
      `  ${"latency".padEnd(14)}p50 ${latency.p50} ms, p95 ${latency.p95} ms, max ${latency.max} ms (${latency.count} samples)`,
    );
    if (session.latency.count > 0) {
      lines.push(
        `  ${"".padEnd(14)}session p50 ${session.latency.p50} ms, p95 ${session.latency.p95} ms, max ${session.latency.max} ms (${session.latency.count} samples)`,
      );
    }
  }
  if (blockTime.count > 0) {
    lines.push(
      `  ${"block time".padEnd(14)}median ${formatSeconds(blockTime.medianSeconds)}, min ${formatSeconds(blockTime.minSeconds)}, max ${formatSeconds(blockTime.maxSeconds)} (${blockTime.count} intervals)`,
    );
    if (session.blockTime.count > 0) {
      lines.push(
        `  ${"".padEnd(14)}session median ${formatSeconds(session.blockTime.medianSeconds)}, min ${formatSeconds(session.blockTime.minSeconds)}, max ${formatSeconds(session.blockTime.maxSeconds)} (${session.blockTime.count} intervals)`,
      );
    }
  }
  if (summary.metrics.windowPolls > 0) {
    lines.push(
      `  ${"failures".padEnd(14)}${summary.metrics.windowFailures} of ${summary.metrics.windowPolls} polls (${Math.round(summary.metrics.errorRate * 100)}%)`,
    );
    if (session.polls > 0) {
      lines.push(
        `  ${"".padEnd(14)}session ${session.failures} of ${session.polls} polls (${Math.round(session.errorRate * 1000) / 10}%)`,
      );
    }
  }

  if (summary.portfolio) {
    lines.push(`  ${"portfolio".padEnd(14)}${summary.portfolio.samples} samples`);
    if (summary.portfolio.native) {
      const native = summary.portfolio.native;
      lines.push(
        `  ${"".padEnd(14)}${native.symbol} ${formatTokenAmount(native.last, native.decimals)}${formatDelta(native.delta, native.decimals)}`,
      );
    }
    for (const token of summary.portfolio.tokens) {
      const value =
        token.last === null
          ? "unreadable"
          : token.decimals === null
            ? `${token.last} raw`
            : formatTokenAmount(token.last, token.decimals);
      lines.push(
        `  ${"".padEnd(14)}${token.symbol} ${value}${formatDelta(token.delta, token.decimals)}`,
      );
    }
  }

  lines.push(`  gas surges    ${summary.gasSurges}`);
  lines.push(`  ${"alerts".padEnd(14)}${summary.alerts}`);
  lines.push(`  stalls        ${summary.stalls}`);
  lines.push(`  chain drift   ${summary.chainDrift ? "detected" : "none"}`);
  lines.push(`  errors        ${summary.errors}`);

  return lines.join("\n");
}

export function toWatchEventJson(event: WatchEvent): Record<string, unknown> {
  const base = { at: new Date(event.at).toISOString() };

  switch (event.type) {
    case "advance":
      return {
        ...base,
        event: "advance",
        blockNumber: event.blockNumber.toString(),
        delta: event.delta.toString(),
        gasPriceWei: event.gasPriceWei === null ? null : event.gasPriceWei.toString(),
        latencyMs: event.latencyMs,
      };
    case "hold":
      return {
        ...base,
        event: "hold",
        blockNumber: event.blockNumber.toString(),
        staleSeconds: event.staleSeconds,
        gasPriceWei: event.gasPriceWei === null ? null : event.gasPriceWei.toString(),
        latencyMs: event.latencyMs,
      };
    case "stall":
      return {
        ...base,
        event: "stall",
        blockNumber: event.blockNumber.toString(),
        staleSeconds: event.staleSeconds,
      };
    case "recovered":
      return {
        ...base,
        event: "recovered",
        from: event.from.toString(),
        to: event.to.toString(),
        stalledForSeconds: event.stalledForSeconds,
      };
    case "chain-drift":
      return {
        ...base,
        event: "chain-drift",
        expected: event.expected,
        previous: event.previous,
        actual: event.actual,
      };
    case "gas-surge":
      return {
        ...base,
        event: "gas-surge",
        gasPriceWei: event.gasPriceWei.toString(),
        baselineWei: event.baselineWei.toString(),
        increasePercent: event.increasePercent,
      };
    case "gas-normal":
      return {
        ...base,
        event: "gas-normal",
        gasPriceWei: event.gasPriceWei.toString(),
        baselineWei: event.baselineWei.toString(),
      };
    case "alert":
      return {
        ...base,
        event: "alert",
        metric: event.metric,
        direction: event.direction,
        value: event.value,
        threshold: event.threshold,
        metrics: event.metrics,
        cumulative: event.cumulative,
      };
    case "balance-alert":
      return {
        ...base,
        event: "balance-alert",
        asset: event.asset,
        address: event.address,
        symbol: event.symbol,
        label: event.label,
        decimals: event.decimals,
        previous: event.previous.toString(),
        balance: event.balance.toString(),
        delta: event.delta.toString(),
        changePercent: event.changePercent,
        thresholdPercent: event.thresholdPercent,
      };
    case "chunk-recovery":
      return {
        ...base,
        event: "chunk-recovery",
        owner: event.owner,
        chunk: event.chunk,
        chunks: event.chunks,
        tokens: event.tokens,
        status: event.status,
        error: event.error,
        individual: event.individual,
      };
    case "portfolio":
      return {
        ...base,
        event: "portfolio",
        blockNumber: event.blockNumber === null ? null : event.blockNumber.toString(),
        batchSize: event.batchSize,
        chunkCount: event.chunkCount,
        native:
          event.native === null
            ? null
            : {
                symbol: event.native.symbol,
                decimals: event.native.decimals,
                balance: event.native.balance.toString(),
                delta: event.native.delta === null ? null : event.native.delta.toString(),
                usd: event.native.usd,
              },
        tokens: event.tokens.map((token) => ({
          address: token.address,
          symbol: token.symbol,
          label: token.label,
          decimals: token.decimals,
          balance: token.balance === null ? null : token.balance.toString(),
          delta: token.delta === null ? null : token.delta.toString(),
          usd: token.usd,
        })),
        usdTotal: event.usdTotal,
        priceError: event.priceError,
        error: event.error,
      };
    case "metrics":
      return {
        ...base,
        event: "metrics",
        metrics: event.metrics,
        cumulative: event.cumulative,
      };
    case "error":
      return { ...base, event: "error", message: event.message };
  }
}

export function toWatchSummaryJson(summary: WatchSummary): Record<string, unknown> {
  return {
    ok:
      summary.errors === 0 &&
      !summary.chainDrift &&
      summary.stalls === 0 &&
      summary.gasSurges === 0,
    event: "summary",
    samples: summary.samples,
    errors: summary.errors,
    firstBlock: summary.firstBlock === null ? null : summary.firstBlock.toString(),
    lastBlock: summary.lastBlock === null ? null : summary.lastBlock.toString(),
    advancedBy: summary.advancedBy.toString(),
    chainDrift: summary.chainDrift,
    stalls: summary.stalls,
    gasSurges: summary.gasSurges,
    alerts: summary.alerts,
    lastGasWei: summary.lastGasWei === null ? null : summary.lastGasWei.toString(),
    peakGasWei: summary.peakGasWei === null ? null : summary.peakGasWei.toString(),
    metrics: summary.metrics,
    session: summary.session,
    durationMs: summary.durationMs,
    aborted: summary.aborted,
    portfolio:
      summary.portfolio === null
        ? null
        : {
            samples: summary.portfolio.samples,
            native:
              summary.portfolio.native === null
                ? null
                : {
                    symbol: summary.portfolio.native.symbol,
                    decimals: summary.portfolio.native.decimals,
                    first: summary.portfolio.native.first.toString(),
                    last: summary.portfolio.native.last.toString(),
                    delta: summary.portfolio.native.delta.toString(),
                  },
            tokens: summary.portfolio.tokens.map((token) => ({
              address: token.address,
              symbol: token.symbol,
              label: token.label,
              decimals: token.decimals,
              first: token.first === null ? null : token.first.toString(),
              last: token.last === null ? null : token.last.toString(),
              delta: token.delta === null ? null : token.delta.toString(),
            })),
          },
  };
}
