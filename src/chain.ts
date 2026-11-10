import {
  createPublicClient,
  defineChain,
  formatGwei,
  http,
  type PublicClient,
} from "viem";

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Authorization header value for the RPC, or null when unauthenticated. */
  authHeader: string | null;
  timeoutMs: number;
  /** Name of the built-in preset this config came from, or null for a custom chain. */
  preset: string | null;
  /**
   * Endpoint to try when rpcUrl cannot answer. A preset supplies one, and
   * LWC_FALLBACK_RPC_URL replaces it; null when there is none.
   */
  fallbackRpcUrl?: string | null;
}

export interface ChainPreset {
  chainId: number;
  name: string;
  rpcUrl: string;
  /** Second public endpoint from a different operator, used when rpcUrl is down. */
  fallbackRpcUrl: string;
  nativeSymbol: string;
}

/**
 * Built-in chains. A preset supplies the chain id, endpoint, and native
 * currency; LWC_RPC_URL, LWC_CHAIN_NAME, and LWC_NATIVE_SYMBOL still override
 * individual values, so a preset is a starting point rather than a lock-in.
 */
export const CHAIN_PRESETS: Record<string, ChainPreset> = {
  xlayer: {
    chainId: 196,
    name: "xlayer",
    rpcUrl: "https://xlayer.drpc.org",
    // OKX's own endpoint, a different operator from the primary.
    fallbackRpcUrl: "https://rpc.xlayer.tech",
    nativeSymbol: "OKB",
  },
  base: {
    chainId: 8453,
    name: "base",
    rpcUrl: "https://mainnet.base.org",
    fallbackRpcUrl: "https://base-rpc.publicnode.com",
    nativeSymbol: "ETH",
  },
  ethereum: {
    chainId: 1,
    name: "ethereum",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    fallbackRpcUrl: "https://cloudflare-eth.com",
    nativeSymbol: "ETH",
  },
  arbitrum: {
    chainId: 42_161,
    name: "arbitrum",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    fallbackRpcUrl: "https://arbitrum-one-rpc.publicnode.com",
    nativeSymbol: "ETH",
  },
  optimism: {
    chainId: 10,
    name: "optimism",
    rpcUrl: "https://mainnet.optimism.io",
    fallbackRpcUrl: "https://optimism-rpc.publicnode.com",
    nativeSymbol: "ETH",
  },
  polygon: {
    chainId: 137,
    name: "polygon",
    // polygon-rpc.com answers 401 now; this endpoint was probed live.
    rpcUrl: "https://polygon-bor-rpc.publicnode.com",
    fallbackRpcUrl: "https://polygon.drpc.org",
    // POL since the chain renamed its token from MATIC.
    nativeSymbol: "POL",
  },
};

export function chainPresetNames(): string[] {
  return Object.keys(CHAIN_PRESETS);
}

/** Find a preset by name (case-insensitive) or by its chain id. */
export function resolveChainPreset(selector: string): ChainPreset | null {
  const key = selector.trim().toLowerCase();
  const byName = CHAIN_PRESETS[key];
  if (byName) return byName;
  if (!/^\d+$/.test(key)) return null;
  const chainId = Number(key);
  return (
    Object.values(CHAIN_PRESETS).find((preset) => preset.chainId === chainId) ?? null
  );
}

export interface ChainHealth {
  chainId: number;
  expectedChainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  blockAgeSeconds: number;
  gasPriceWei: bigint | null;
  clientVersion: string | null;
  latencyMs: number;
  rpcHost: string;
}

export class ChainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainConfigError";
  }
}

export class ChainMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;
  readonly source: string;

  constructor(expected: number, actual: number, source = "RPC") {
    super(
      `${source} answered chainId ${actual}, but LWC_CHAIN_ID is ${expected}. Refusing to use a mismatched endpoint.`,
    );
    this.name = "ChainMismatchError";
    this.expected = expected;
    this.actual = actual;
    this.source = source;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 120_000;

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ChainConfigError(
      `${key} is required. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function validateRpcUrl(raw: string, key: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new ChainConfigError(`${key} is not a valid URL: "${raw}".`);
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new ChainConfigError(
      `${key} must use http or https, got "${endpoint.protocol}".`,
    );
  }
}

function parseChainId(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ChainConfigError(
      `LWC_CHAIN_ID must be a positive integer, got "${raw}".`,
    );
  }
  const chainId = Number(raw);
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new ChainConfigError(`LWC_CHAIN_ID is out of range: "${raw}".`);
  }
  return chainId;
}

/**
 * Build the chain config from a preset name, a chain id, or explicit
 * LWC_CHAIN_ID/LWC_RPC_URL values. An explicit selector (the --chain flag)
 * wins over LWC_CHAIN.
 */
export function parseChainConfig(
  env: Record<string, string | undefined>,
  selector?: string | null,
): ChainConfig {
  const explicit = selector?.trim() || null;
  const chosen = explicit ?? (env.LWC_CHAIN?.trim() || null);
  const preset = chosen === null ? null : resolveChainPreset(chosen);
  const numericSelector =
    chosen !== null && /^\d+$/.test(chosen) && preset === null ? chosen : null;

  if (chosen !== null && preset === null && numericSelector === null) {
    throw new ChainConfigError(
      `unknown chain "${chosen}". Known presets: ${chainPresetNames().join(", ")}. ` +
        "Use a preset name or chain id, or set LWC_CHAIN_ID and LWC_RPC_URL for a custom chain.",
    );
  }

  const envChainId = env.LWC_CHAIN_ID?.trim() || null;
  const presetConflictsWithEnv =
    preset !== null &&
    envChainId !== null &&
    parseChainId(envChainId) !== preset.chainId;
  if (presetConflictsWithEnv && explicit === null) {
    throw new ChainConfigError(
      `LWC_CHAIN is ${chosen} (${preset.chainId}), but LWC_CHAIN_ID is ${envChainId}. ` +
        `Remove LWC_CHAIN_ID or set it to ${preset.chainId}.`,
    );
  }

  let chainId: number;
  if (preset !== null) {
    chainId = preset.chainId;
  } else if (envChainId !== null) {
    chainId = parseChainId(envChainId);
  } else if (numericSelector !== null) {
    chainId = parseChainId(numericSelector);
  } else {
    throw new ChainConfigError(
      "LWC_CHAIN_ID is required when LWC_CHAIN is not set. Use a preset " +
        `(${chainPresetNames().join(", ")}) or copy .env.example to .env and fill it in.`,
    );
  }

  // The env endpoint is the override for a custom chain and for a preset whose
  // configured chain id matches it. An explicit --chain preset switches
  // networks, so an endpoint configured for another chain is not inherited.
  const envRpcUrl = env.LWC_RPC_URL?.trim() || null;
  const rpcUrl =
    (presetConflictsWithEnv ? null : envRpcUrl) || preset?.rpcUrl || null;
  if (rpcUrl === null) {
    throw new ChainConfigError(
      "LWC_RPC_URL is required for a custom chain. Set it, or pick a preset with " +
        `LWC_CHAIN (${chainPresetNames().join(", ")}).`,
    );
  }
  validateRpcUrl(rpcUrl, "LWC_RPC_URL");

  const authHeader = env.LWC_RPC_AUTH?.trim() || null;
  if (authHeader && /[\r\n]/.test(authHeader)) {
    throw new ChainConfigError(
      "LWC_RPC_AUTH must be a single line and must not contain newlines.",
    );
  }

  const rawTimeout = env.LWC_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new ChainConfigError(
      `LWC_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`,
    );
  }

  // Cosmetic overrides follow the same rule as the endpoint: they describe the
  // chain configured in .env, not a chain chosen explicitly with --chain.
  const name =
    (presetConflictsWithEnv ? null : env.LWC_CHAIN_NAME?.trim()) ||
    preset?.name ||
    `lwc-${chainId}`;
  const symbol =
    (presetConflictsWithEnv ? null : env.LWC_NATIVE_SYMBOL?.trim()) ||
    preset?.nativeSymbol ||
    "ETH";

  // The backup is a preset default that LWC_FALLBACK_RPC_URL replaces, so a
  // custom chain (or a private endpoint in .env) can name its own second URL.
  // Like LWC_RPC_URL it describes the chain configured in .env, not one chosen
  // explicitly with --chain, and it never repeats the primary.
  const envFallback = presetConflictsWithEnv
    ? null
    : env.LWC_FALLBACK_RPC_URL?.trim() || null;
  if (envFallback !== null) validateRpcUrl(envFallback, "LWC_FALLBACK_RPC_URL");

  const fallbackCandidate = envFallback ?? preset?.fallbackRpcUrl ?? null;
  const fallbackRpcUrl =
    fallbackCandidate !== null && fallbackCandidate !== rpcUrl
      ? fallbackCandidate
      : null;

  return {
    chainId,
    name,
    rpcUrl,
    fallbackRpcUrl,
    nativeCurrency: { name: symbol, symbol, decimals: 18 },
    authHeader,
    timeoutMs,
    preset: preset?.name ?? null,
  };
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

const KEY_LIKE_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;

/**
 * A log-safe endpoint label: origin plus path, with query, fragment, and any
 * key-like path segment removed. Provider attribution needs the host, not the
 * credential that happens to sit in the URL.
 */
export function publicEndpoint(rpcUrl: string): string {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return "<invalid>";
  }

  const path = url.pathname
    .split("/")
    .map((segment) => (KEY_LIKE_SEGMENT.test(segment) ? "<redacted>" : segment))
    .join("/");
  const origin = `${url.protocol}//${url.host}`;

  return path === "" || path === "/" ? origin : `${origin}${path}`;
}

/** Non-fatal advisories about the configured endpoint. */
export function connectionWarnings(config: ChainConfig): string[] {
  const warnings: string[] = [];
  const endpoints: Array<[string, string]> = [["LWC_RPC_URL", config.rpcUrl]];
  if (config.fallbackRpcUrl) {
    endpoints.push(["LWC_FALLBACK_RPC_URL", config.fallbackRpcUrl]);
  }

  for (const [key, url] of endpoints) {
    const endpoint = new URL(url);
    if (endpoint.protocol === "http:" && !isLoopbackHost(endpoint.hostname)) {
      warnings.push(
        `${key} uses plaintext http to ${endpoint.hostname}; RPC traffic is unencrypted. Use https.`,
      );
    }
  }
  if (config.authHeader) {
    warnings.push(
      "LWC_RPC_AUTH is being sent to this endpoint; only use it with an operator you trust.",
    );
    if (config.fallbackRpcUrl) {
      warnings.push(
        "LWC_RPC_AUTH pins this connection to its endpoint, so the backup endpoint is not used.",
      );
    }
  }
  return warnings;
}

export function buildClient(config: ChainConfig): PublicClient {
  const chain = defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  return createPublicClient({
    chain,
    transport: http(config.rpcUrl, {
      timeout: config.timeoutMs,
      retryCount: 1,
      fetchOptions: config.authHeader
        ? { headers: { authorization: config.authHeader } }
        : undefined,
    }),
  });
}

/**
 * Read live state from the endpoint and verify it is the chain we expect.
 * Throws ChainMismatchError when the RPC reports a different chainId.
 */
export async function probe(
  client: PublicClient,
  config: ChainConfig,
): Promise<ChainHealth> {
  const startedAt = performance.now();

  // allSettled, not all: a dead endpoint fails several calls at once, and the
  // rejections Promise.all discards would surface as unhandled rejections.
  const [chainIdCall, blockCall, gasPriceCall, versionCall] = await Promise.allSettled([
    client.getChainId(),
    client.getBlockNumber(),
    client.getGasPrice(),
    client.request({ method: "web3_clientVersion" }),
  ]);

  if (chainIdCall.status === "rejected") throw chainIdCall.reason;
  if (blockCall.status === "rejected") throw blockCall.reason;

  const chainId = chainIdCall.value;
  const blockNumber = blockCall.value;
  const gasPriceWei = gasPriceCall.status === "fulfilled" ? gasPriceCall.value : null;
  const clientVersion =
    versionCall.status === "fulfilled" && typeof versionCall.value === "string"
      ? versionCall.value
      : null;

  const block = await client.getBlock({ blockNumber });
  const latencyMs = Math.round(performance.now() - startedAt);

  if (chainId !== config.chainId) {
    throw new ChainMismatchError(config.chainId, chainId);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  return {
    chainId,
    expectedChainId: config.chainId,
    blockNumber,
    blockTimestamp: block.timestamp,
    blockAgeSeconds: Math.max(0, nowSeconds - Number(block.timestamp)),
    gasPriceWei,
    clientVersion,
    latencyMs,
    rpcHost: new URL(config.rpcUrl).host,
  };
}

export interface ProbeOutcome {
  health: ChainHealth;
  /** The endpoint that answered: the backup when the primary was unhealthy. */
  config: ChainConfig;
  usedFallback: boolean;
  /** Redacted primary endpoint, set only when the backup answered. */
  primaryEndpoint: string | null;
  /** Why the primary was skipped, set only when the backup answered. */
  primaryError: string | null;
}

function describeError(error: unknown): string {
  // viem's own message spans several lines; its one-line summary keeps the
  // failover note readable in a single table row.
  const short = (error as { shortMessage?: unknown } | null)?.shortMessage;
  if (typeof short === "string" && short.length > 0) return short;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Probe the configured endpoint, falling back to the preset's second endpoint
 * when the first cannot be used: unreachable, timing out, or answering with the
 * wrong chain id. A configured auth header pins the probe to the primary, since
 * sending someone's credentials to another operator would be a leak.
 */
export async function probeWithFallback(
  clientFor: (config: ChainConfig) => PublicClient,
  config: ChainConfig,
): Promise<ProbeOutcome> {
  try {
    const health = await probe(clientFor(config), config);
    return {
      health,
      config,
      usedFallback: false,
      primaryEndpoint: null,
      primaryError: null,
    };
  } catch (error) {
    const fallback = config.fallbackRpcUrl?.trim() || null;
    if (fallback === null || fallback === config.rpcUrl || config.authHeader !== null) {
      throw error;
    }

    const backupConfig: ChainConfig = { ...config, rpcUrl: fallback, fallbackRpcUrl: null };
    try {
      const health = await probe(clientFor(backupConfig), backupConfig);
      return {
        health,
        config: backupConfig,
        usedFallback: true,
        primaryEndpoint: publicEndpoint(config.rpcUrl),
        primaryError: describeError(error),
      };
    } catch (fallbackError) {
      throw new ChainConfigError(
        `both endpoints failed for ${config.name} (${config.chainId}): ` +
          `${publicEndpoint(config.rpcUrl)} — ${describeError(error)}; ` +
          `${publicEndpoint(fallback)} — ${describeError(fallbackError)}`,
      );
    }
  }
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function formatHealth(
  health: ChainHealth,
  config: ChainConfig,
  warnings: string[] = [],
): string {
  const gas =
    health.gasPriceWei === null
      ? "unavailable"
      : `${formatGwei(health.gasPriceWei)} gwei`;

  const lines = [
    "lwc — chain connection",
    "",
    "  status        connected",
    `  chain         ${config.name} (${health.chainId})`,
    `  rpc           ${health.rpcHost}`,
    `  client        ${health.clientVersion ?? "unavailable"}`,
    `  block         ${health.blockNumber} (${formatAge(health.blockAgeSeconds)} old)`,
    `  gas           ${gas}`,
    `  latency       ${health.latencyMs} ms`,
  ];

  if (warnings.length > 0) {
    lines.push("", ...warnings.map((warning) => `  warning: ${warning}`));
  }

  return lines.join("\n");
}

export function toJsonPayload(
  health: ChainHealth,
  config: ChainConfig,
  warnings: string[],
  outcome?: Pick<ProbeOutcome, "usedFallback" | "primaryEndpoint" | "primaryError">,
): Record<string, unknown> {
  return {
    ok: true,
    chain: {
      id: config.chainId,
      name: config.name,
      nativeSymbol: config.nativeCurrency.symbol,
      preset: config.preset,
    },
    rpc: {
      host: new URL(config.rpcUrl).host,
      auth: config.authHeader ? "configured" : "none",
      fallbackHost: config.fallbackRpcUrl
        ? new URL(config.fallbackRpcUrl).host
        : null,
      usedFallback: outcome?.usedFallback ?? false,
      primaryHost: outcome?.primaryEndpoint ?? null,
      primaryError: outcome?.primaryError ?? null,
    },
    health: {
      ...health,
      blockNumber: health.blockNumber.toString(),
      blockTimestamp: health.blockTimestamp.toString(),
      gasPriceWei: health.gasPriceWei === null ? null : health.gasPriceWei.toString(),
    },
    warnings,
  };
}
