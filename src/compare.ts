import type { PublicClient } from "viem";

import { buildClient, publicEndpoint, type ChainConfig } from "./chain.ts";
import { parseLogSize } from "./watch.ts";

export class CompareArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompareArgError";
  }
}

export interface CompareEndpoint {
  url: string;
  /** Display name for this provider; null falls back to the URL. */
  label: string | null;
  /** Authorization header for this endpoint; null inherits LWC_RPC_AUTH. */
  authHeader: string | null;
}

export interface CompareArgs {
  endpoints: CompareEndpoint[];
  samples: number;
  intervalMs: number;
  /** Append one JSON record per run here; null disables logging. */
  logPath: string | null;
  /** Rotate the log to <path>.1 past this many bytes; 0 disables it. */
  logMaxBytes: number;
}

export interface LatencySummary {
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

export interface HeadDeliveryStats {
  /** New heads this endpoint reported before any other endpoint. */
  wins: number;
  /** New heads it reported at all. */
  observed: number;
  /** New heads it never reported during the run. */
  misses: number;
  /** Median ms after the first report of the same head; null if none observed. */
  p50Ms: number | null;
  /** p95 ms after the first report of the same head; null if none observed. */
  p95Ms: number | null;
}

export interface EndpointStats {
  url: string;
  /** Provider label from the endpoint spec, or null when unnamed. */
  label: string | null;
  ok: boolean;
  /** Rounds attempted. */
  samples: number;
  errors: number;
  latency: LatencySummary;
  head: bigint | null;
  /** Blocks behind the freshest endpoint at the end of the run. */
  headLag: number;
  /** Rounds in which this endpoint was behind the round's freshest head. */
  roundsBehind: number;
  headAgeSeconds: number | null;
  /** How quickly this endpoint delivered each new head relative to the first. */
  delivery: HeadDeliveryStats;
  chainId: number | null;
  chainMismatch: boolean;
  error: string | null;
}

export interface CompareReport {
  chainId: number;
  chainName: string;
  samples: number;
  intervalMs: number;
  /** Distinct heads that first appeared after the baseline round. */
  newBlocks: number;
  endpoints: EndpointStats[];
  fastest: string | null;
  freshest: string | null;
}

export interface CompareDeps {
  clientFor?: (config: ChainConfig) => PublicClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MIN_SAMPLES = 1;
const MAX_SAMPLES = 100;
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 60;

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new CompareArgError(`${flag} must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new CompareArgError(`${flag} must be between ${min} and ${max}.`);
  }
  return value;
}

function parseEndpointSpec(raw: string): CompareEndpoint {
  let label: string | null = null;
  let urlValue = raw;

  // `label=https://…` names a provider. A URL that merely contains `=` in its
  // query is left alone because the part after the first `=` is not a URL.
  const separator = raw.indexOf("=");
  if (separator > 0) {
    const candidate = raw.slice(0, separator);
    const rest = raw.slice(separator + 1);
    if (/^https?:\/\//i.test(rest)) {
      if (!/^[A-Za-z0-9._-]+$/.test(candidate)) {
        throw new CompareArgError(
          `endpoint label "${candidate}" must use letters, digits, dot, dash, or underscore.`,
        );
      }
      label = candidate;
      urlValue = rest;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new CompareArgError(`"${urlValue}" is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CompareArgError(`${urlValue} must be an http(s) endpoint.`);
  }

  return { url: urlValue, label, authHeader: null };
}

const ENV_AUTH_PREFIX = "env:";

/**
 * Environment variable that supplies a labeled endpoint's header: the label is
 * uppercased and any dot, dash, or underscore becomes an underscore, so `drpc`
 * reads LWC_RPC_AUTH_DRPC and `my-node` reads LWC_RPC_AUTH_MY_NODE.
 */
export function endpointAuthEnvName(label: string): string {
  return `LWC_RPC_AUTH_${label.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Resolve `env:NAME` to the named environment variable so the secret stays out
 * of argv. Any other value is a literal header and is returned unchanged.
 */
function resolveEndpointAuth(
  raw: string,
  env: Record<string, string | undefined>,
): string {
  if (!raw.startsWith(ENV_AUTH_PREFIX)) return raw;

  const name = raw.slice(ENV_AUTH_PREFIX.length).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new CompareArgError(
      `--endpoint-auth env: expects an environment variable name, got "${name}".`,
    );
  }

  const value = env[name]?.trim();
  if (!value) {
    throw new CompareArgError(
      `--endpoint-auth names environment variable ${name}, but it is unset or empty.`,
    );
  }
  return value;
}

export function parseCompareArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): CompareArgs {
  const rawEndpoints: string[] = [];
  const rawAuth: string[] = [];
  let samples = 5;
  let intervalMs = 1000;
  let logPath: string | null = null;
  let logMaxBytes = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readValue = (flag: string): string => {
      const value = argv[index + 1];
      if (!value) throw new CompareArgError(`${flag} requires a value.`);
      index += 1;
      return value;
    };

    if (arg === "--samples") {
      samples = parseInteger(readValue("--samples"), "--samples", MIN_SAMPLES, MAX_SAMPLES);
    } else if (arg === "--interval") {
      intervalMs =
        parseInteger(
          readValue("--interval"),
          "--interval",
          MIN_INTERVAL_SECONDS,
          MAX_INTERVAL_SECONDS,
        ) * 1000;
    } else if (arg === "--endpoint-auth" || arg.startsWith("--endpoint-auth=")) {
      const value = arg.startsWith("--endpoint-auth=")
        ? arg.slice("--endpoint-auth=".length)
        : readValue("--endpoint-auth");
      if (!value) throw new CompareArgError("--endpoint-auth requires a value.");
      rawAuth.push(value);
    } else if (arg === "--log" || arg.startsWith("--log=")) {
      const value = arg.startsWith("--log=")
        ? arg.slice("--log=".length)
        : readValue("--log");
      if (!value) throw new CompareArgError("--log requires a file path.");
      logPath = value;
    } else if (arg === "--log-max-size" || arg.startsWith("--log-max-size=")) {
      const value = arg.startsWith("--log-max-size=")
        ? arg.slice("--log-max-size=".length)
        : readValue("--log-max-size");
      if (!value) throw new CompareArgError("--log-max-size requires a size, e.g. 10mb.");
      try {
        logMaxBytes = parseLogSize(value);
      } catch (error) {
        throw new CompareArgError(error instanceof Error ? error.message : String(error));
      }
    } else if (arg.startsWith("-")) {
      // Other flags (e.g. --json) are handled by the caller.
      continue;
    } else {
      rawEndpoints.push(arg);
    }
  }

  if (rawEndpoints.length < 2) {
    throw new CompareArgError(
      "two RPC URLs are required: lwc compare <urlA> <urlB> [--samples 5] [--interval 1]",
    );
  }
  if (rawEndpoints.length > 8) {
    throw new CompareArgError("compare accepts at most 8 endpoints.");
  }

  const endpoints = rawEndpoints.map(parseEndpointSpec);

  if (new Set(endpoints.map((endpoint) => endpoint.url)).size !== endpoints.length) {
    throw new CompareArgError("the same endpoint was given twice; comparison needs two distinct URLs.");
  }

  const labels = endpoints
    .map((endpoint) => endpoint.label)
    .filter((label): label is string => label !== null);
  if (new Set(labels).size !== labels.length) {
    throw new CompareArgError("endpoint labels must be unique.");
  }

  for (const entry of rawAuth) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new CompareArgError(
        '--endpoint-auth must look like "label=Bearer <token>" or "https://…=Bearer <token>".',
      );
    }
    const key = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    if (!key || !rawValue) {
      throw new CompareArgError("--endpoint-auth needs both an endpoint and a header value.");
    }
    const value = resolveEndpointAuth(rawValue, env);
    if (/[\r\n]/.test(value)) {
      throw new CompareArgError("--endpoint-auth must be a single line.");
    }

    const target = endpoints.find(
      (endpoint) => endpoint.label === key || endpoint.url === key,
    );
    if (!target) {
      throw new CompareArgError(
        `--endpoint-auth names "${key}", which matches no endpoint. Use a label or a full URL.`,
      );
    }
    if (target.authHeader !== null) {
      throw new CompareArgError(`--endpoint-auth was given twice for "${key}".`);
    }
    target.authHeader = value;
  }

  // Labeled endpoints with no explicit --endpoint-auth pick up their own key,
  // so one .env can hold keys for several providers without long argv lists.
  // An explicit flag and LWC_RPC_AUTH both take precedence over this.
  for (const target of endpoints) {
    if (target.label === null || target.authHeader !== null) continue;
    const name = endpointAuthEnvName(target.label);
    const value = env[name]?.trim();
    if (!value) continue;
    if (/[\r\n]/.test(value)) {
      throw new CompareArgError(`${name} must be a single line.`);
    }
    target.authHeader = value;
  }

  if (logMaxBytes > 0 && logPath === null) {
    throw new CompareArgError("--log-max-size needs --log <path> so it has a file to rotate.");
  }

  return { endpoints, samples, intervalMs, logPath, logMaxBytes };
}

/** Nearest-rank percentile, matching the watch metrics. */
function pick(sorted: number[], percentile: number): number {
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

export function summarizeLatency(values: number[]): LatencySummary {
  if (values.length === 0) return { p50: 0, p95: 0, min: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    p50: pick(sorted, 50),
    p95: pick(sorted, 95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: Math.round(total / values.length),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return short;
    return error.message;
  }
  return String(error);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe every endpoint in the same round, in parallel, so the latency and head
 * numbers describe the same wall-clock window on each RPC.
 */
export async function compareEndpoints(
  config: ChainConfig,
  args: CompareArgs,
  deps: CompareDeps = {},
): Promise<CompareReport> {
  const clientFor = deps.clientFor ?? ((target: ChainConfig) => buildClient(target));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const count = args.endpoints.length;

  const clients = args.endpoints.map((endpoint) =>
    clientFor({
      ...config,
      rpcUrl: endpoint.url,
      // A per-endpoint header overrides LWC_RPC_AUTH; null inherits it.
      authHeader: endpoint.authHeader ?? config.authHeader,
    }),
  );
  const chainIds: (number | null)[] = new Array(count).fill(null);
  const setupErrors: (string | null)[] = new Array(count).fill(null);
  const latencies: number[][] = args.endpoints.map(() => []);
  const heads: bigint[][] = args.endpoints.map(() => []);
  const errors: number[] = new Array(count).fill(0);
  const roundsBehind: number[] = new Array(count).fill(0);
  const lastError: (string | null)[] = new Array(count).fill(null);
  const headAges: (number | null)[] = new Array(count).fill(null);
  const observations: Array<Map<bigint, number>> = args.endpoints.map(() => new Map());
  let baselineHead: bigint | null = null;

  await Promise.all(
    clients.map(async (client, index) => {
      try {
        chainIds[index] = await client.getChainId();
      } catch (error) {
        setupErrors[index] = describe(error);
      }
    }),
  );

  for (let round = 0; round < args.samples; round += 1) {
    const results = await Promise.all(
      clients.map(async (client, index) => {
        const started = now();
        try {
          // viem caches eth_blockNumber for a few seconds by default; a benchmark
          // must hit the network on every round or the latency reads as zero.
          const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
          const observedAt = now();
          latencies[index]?.push(Math.max(0, observedAt - started));
          // Keep the first time this endpoint served each head; the earliest
          // sighting across endpoints is the delivery baseline for that head.
          const seen = observations[index];
          if (seen && !seen.has(blockNumber)) seen.set(blockNumber, observedAt);
          return { ok: true as const, blockNumber };
        } catch (error) {
          errors[index] = (errors[index] ?? 0) + 1;
          lastError[index] = describe(error);
          return { ok: false as const };
        }
      }),
    );

    const freshest = results.reduce<bigint | null>(
      (best, result) =>
        result.ok && (best === null || result.blockNumber > best) ? result.blockNumber : best,
      null,
    );

    // The head present in the first round is the baseline; anything above it
    // was produced during the run and can be raced for first delivery.
    if (round === 0) baselineHead = freshest;

    results.forEach((result, index) => {
      if (!result.ok) return;
      heads[index]?.push(result.blockNumber);
      if (freshest !== null && result.blockNumber < freshest) {
        roundsBehind[index] = (roundsBehind[index] ?? 0) + 1;
      }
    });

    if (round < args.samples - 1) await sleep(args.intervalMs);
  }

  await Promise.all(
    clients.map(async (client, index) => {
      try {
        const block = await client.getBlock();
        headAges[index] = Math.max(0, Math.round(now() / 1000 - Number(block.timestamp)));
      } catch {
        // Age is a bonus metric; the head number already shows freshness.
      }
    }),
  );

  const finalHeads = heads.map((values) =>
    values.length === 0 ? null : values.reduce((best, value) => (value > best ? value : best)),
  );
  const freshestHead = finalHeads.reduce<bigint | null>(
    (best, head) => (head !== null && (best === null || head > best) ? head : best),
    null,
  );

  const observedBlocks = new Set<bigint>();
  for (const seen of observations) {
    for (const block of seen.keys()) observedBlocks.add(block);
  }
  const newHeads = [...observedBlocks]
    .filter((block) => baselineHead === null || block > baselineHead)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const deliveries: HeadDeliveryStats[] = args.endpoints.map(() => ({
    wins: 0,
    observed: 0,
    misses: 0,
    p50Ms: null,
    p95Ms: null,
  }));
  const delayValues: number[][] = args.endpoints.map(() => []);

  for (const block of newHeads) {
    const sightings = observations
      .map((seen, index) => ({ index, at: seen.get(block) }))
      .filter(
        (sighting): sighting is { index: number; at: number } => sighting.at !== undefined,
      );
    if (sightings.length === 0) continue;

    const earliest = Math.min(...sightings.map((sighting) => sighting.at));
    for (const sighting of sightings) {
      const delivery = deliveries[sighting.index]!;
      delivery.observed += 1;
      delayValues[sighting.index]?.push(sighting.at - earliest);
      if (sighting.at === earliest) delivery.wins += 1;
    }
  }

  deliveries.forEach((delivery, index) => {
    delivery.misses = newHeads.length - delivery.observed;
    const delays = delayValues[index] ?? [];
    if (delays.length > 0) {
      const summary = summarizeLatency(delays);
      delivery.p50Ms = summary.p50;
      delivery.p95Ms = summary.p95;
    }
  });

  const endpoints: EndpointStats[] = args.endpoints.map((target, index) => {
    const head = finalHeads[index] ?? null;
    const chainId = chainIds[index] ?? null;
    const chainMismatch = chainId !== null && chainId !== config.chainId;
    const errorCount = errors[index] ?? 0;
    const latency = summarizeLatency(latencies[index] ?? []);

    return {
      url: target.url,
      label: target.label,
      ok: errorCount === 0 && !chainMismatch && head !== null,
      samples: args.samples,
      errors: errorCount,
      latency,
      head,
      headLag:
        head === null || freshestHead === null ? 0 : Number(freshestHead - head),
      roundsBehind: roundsBehind[index] ?? 0,
      headAgeSeconds: headAges[index] ?? null,
      delivery: deliveries[index] ?? {
        wins: 0,
        observed: 0,
        misses: 0,
        p50Ms: null,
        p95Ms: null,
      },
      chainId,
      chainMismatch,
      error: lastError[index] ?? setupErrors[index] ?? null,
    };
  });

  const fastest = endpoints
    .filter((endpoint) => endpoint.head !== null || endpoint.latency.max > 0)
    .reduce<EndpointStats | null>(
      (best, endpoint) => (best === null || endpoint.latency.p50 < best.latency.p50 ? endpoint : best),
      null,
    );

  const freshest = endpoints.find((endpoint) => endpoint.head !== null && endpoint.head === freshestHead);

  return {
    chainId: config.chainId,
    chainName: config.name,
    samples: args.samples,
    intervalMs: args.intervalMs,
    newBlocks: newHeads.length,
    endpoints,
    fastest: fastest?.url ?? null,
    freshest: freshest?.url ?? null,
  };
}

export function formatCompare(report: CompareReport): string {
  const nameOf = (endpoint: EndpointStats): string => endpoint.label ?? endpoint.url;
  const urlWidth = Math.max(24, ...report.endpoints.map((endpoint) => nameOf(endpoint).length));
  const lines = [
    "lwc — compare",
    "",
    `  ${"chain".padEnd(14)}${report.chainName} (${report.chainId})`,
    `  ${"samples".padEnd(14)}${report.samples} every ${report.intervalMs / 1000}s`,
    `  ${"new blocks".padEnd(14)}${report.newBlocks}`,
    "",
    `  ${"endpoint".padEnd(urlWidth)}  ${"p50".padStart(6)}  ${"p95".padStart(6)}  ${"head".padStart(10)}  ${"lag".padStart(4)}  ${"behind".padStart(7)}  ${"wins".padStart(5)}  ${"delay".padStart(6)}  ${"age".padStart(5)}  ${"err".padStart(4)}`,
  ];

  for (const endpoint of report.endpoints) {
    const head = endpoint.head === null ? "n/a" : endpoint.head.toString();
    const age = endpoint.headAgeSeconds === null ? "n/a" : `${endpoint.headAgeSeconds}s`;
    const delay =
      endpoint.delivery.p50Ms === null ? "n/a" : `${endpoint.delivery.p50Ms}ms`;
    lines.push(
      `  ${nameOf(endpoint).padEnd(urlWidth)}  ${`${endpoint.latency.p50}ms`.padStart(6)}  ${`${endpoint.latency.p95}ms`.padStart(6)}  ${head.padStart(10)}  ${String(endpoint.headLag).padStart(4)}  ${`${endpoint.roundsBehind}/${report.samples}`.padStart(7)}  ${String(endpoint.delivery.wins).padStart(5)}  ${delay.padStart(6)}  ${age.padStart(5)}  ${String(endpoint.errors).padStart(4)}`,
    );
  }

  lines.push("");
  const fastest = report.endpoints.find((endpoint) => endpoint.url === report.fastest);
  if (fastest) {
    lines.push(`  ${"fastest".padEnd(14)}${nameOf(fastest)} (p50 ${fastest.latency.p50} ms)`);
  }
  const freshest = report.endpoints.find((endpoint) => endpoint.url === report.freshest);
  if (freshest) {
    lines.push(`  ${"freshest".padEnd(14)}${nameOf(freshest)} (head ${freshest.head})`);
  }

  for (const endpoint of report.endpoints) {
    if (endpoint.chainMismatch) {
      lines.push(
        `  warning       ${nameOf(endpoint)} answered chain ${endpoint.chainId}, expected ${report.chainId}`,
      );
    }
  }
  for (const endpoint of report.endpoints) {
    if (endpoint.errors > 0 && endpoint.error) {
      lines.push(`  warning       ${nameOf(endpoint)}: ${endpoint.error} (${endpoint.errors} rounds)`);
    }
  }

  return lines.join("\n");
}

function sanitizeMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => publicEndpoint(url));
}

/**
 * One NDJSON record per comparison run. URLs are reduced to origin and path so
 * a provider URL carrying an API key never reaches the log, and error text is
 * scrubbed the same way.
 */
export function toCompareLogRecord(
  report: CompareReport,
  session: string,
  at: number = Date.now(),
): Record<string, unknown> {
  return {
    session,
    event: "compare",
    at: new Date(at).toISOString(),
    chain: { id: report.chainId, name: report.chainName },
    samples: report.samples,
    intervalMs: report.intervalMs,
    newBlocks: report.newBlocks,
    fastest: report.fastest === null ? null : publicEndpoint(report.fastest),
    freshest: report.freshest === null ? null : publicEndpoint(report.freshest),
    endpoints: report.endpoints.map((endpoint) => ({
      url: publicEndpoint(endpoint.url),
      label: endpoint.label,
      ok: endpoint.ok,
      p50: endpoint.latency.p50,
      p95: endpoint.latency.p95,
      head: endpoint.head === null ? null : endpoint.head.toString(),
      headLag: endpoint.headLag,
      roundsBehind: endpoint.roundsBehind,
      headAgeSeconds: endpoint.headAgeSeconds,
      delivery: endpoint.delivery,
      errors: endpoint.errors,
      chainMismatch: endpoint.chainMismatch,
      error: endpoint.error === null ? null : sanitizeMessage(endpoint.error),
    })),
  };
}

export function toCompareJson(report: CompareReport): Record<string, unknown> {
  return {
    ok: report.endpoints.every((endpoint) => endpoint.ok),
    chain: { id: report.chainId, name: report.chainName },
    samples: report.samples,
    intervalMs: report.intervalMs,
    newBlocks: report.newBlocks,
    fastest: report.fastest,
    freshest: report.freshest,
    endpoints: report.endpoints.map((endpoint) => ({
      url: endpoint.url,
      label: endpoint.label,
      ok: endpoint.ok,
      samples: endpoint.samples,
      errors: endpoint.errors,
      latency: endpoint.latency,
      head: endpoint.head === null ? null : endpoint.head.toString(),
      headLag: endpoint.headLag,
      roundsBehind: endpoint.roundsBehind,
      headAgeSeconds: endpoint.headAgeSeconds,
      delivery: endpoint.delivery,
      chainId: endpoint.chainId,
      chainMismatch: endpoint.chainMismatch,
      error: endpoint.error,
    })),
  };
}
