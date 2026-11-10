import type { PublicClient } from "viem";

import {
  CHAIN_PRESETS,
  ChainMismatchError,
  buildClient,
  probeWithFallback,
  type ChainConfig,
  type ChainPreset,
} from "./chain.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MIN_PROBE_TIMEOUT_MS = 250;
const MAX_PROBE_TIMEOUT_MS = 120_000;

export class PresetsArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetsArgError";
  }
}

export interface PresetProbeResult {
  preset: string;
  chainId: number;
  nativeSymbol: string;
  /** Host that answered: the backup endpoint when the primary could not. */
  rpcHost: string;
  /** Host of the configured (primary) endpoint, for failover reporting. */
  primaryHost: string;
  /** True when the primary failed and the backup answered instead. */
  viaFallback: boolean;
  /** Why the primary was skipped, when viaFallback is true. */
  primaryError: string | null;
  ok: boolean;
  latencyMs: number | null;
  blockNumber: bigint | null;
  error: string | null;
}

export interface PresetsReport {
  total: number;
  healthy: number;
  failed: number;
  endpoints: PresetProbeResult[];
}

export interface PresetProbeDeps {
  /** Defaults to the real viem client; tests inject a stub. */
  clientFor?: (config: ChainConfig) => PublicClient;
  timeoutMs?: number;
  /** Defaults to the built-in table; tests can narrow it. */
  presets?: Record<string, ChainPreset>;
}

function describeFailure(error: unknown): string {
  if (error instanceof ChainMismatchError) return `chain mismatch: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function hostOf(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return "<invalid>";
  }
}

/**
 * Probe every built-in preset in parallel and report each one separately, so a
 * single dead endpoint cannot hide the others. A failed probe is data here, not
 * an exception: the caller decides what an unhealthy endpoint means.
 */
export async function probePresets(deps: PresetProbeDeps = {}): Promise<PresetsReport> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const clientFor = deps.clientFor ?? buildClient;
  const presets = deps.presets ?? CHAIN_PRESETS;
  const names = Object.keys(presets).sort();

  const endpoints = await Promise.all(
    names.map(async (name): Promise<PresetProbeResult> => {
      const preset = presets[name]!;
      const config: ChainConfig = {
        chainId: preset.chainId,
        name: preset.name,
        rpcUrl: preset.rpcUrl,
        fallbackRpcUrl: preset.fallbackRpcUrl,
        nativeCurrency: {
          name: preset.nativeSymbol,
          symbol: preset.nativeSymbol,
          decimals: 18,
        },
        authHeader: null,
        timeoutMs,
        preset: preset.name,
      };
      const base = {
        preset: name,
        chainId: preset.chainId,
        nativeSymbol: preset.nativeSymbol,
        primaryHost: hostOf(preset.rpcUrl),
      };

      try {
        // The backup endpoint is part of the preset, so a dead primary still
        // reports the chain as reachable and says which endpoint answered.
        const outcome = await probeWithFallback(clientFor, config);
        return {
          ...base,
          rpcHost: outcome.health.rpcHost,
          viaFallback: outcome.usedFallback,
          primaryError: outcome.primaryError,
          ok: true,
          latencyMs: outcome.health.latencyMs,
          blockNumber: outcome.health.blockNumber,
          error: null,
        };
      } catch (error) {
        return {
          ...base,
          rpcHost: hostOf(preset.rpcUrl),
          viaFallback: false,
          primaryError: null,
          ok: false,
          latencyMs: null,
          blockNumber: null,
          error: describeFailure(error),
        };
      }
    }),
  );

  const healthy = endpoints.filter((endpoint) => endpoint.ok).length;
  return {
    total: endpoints.length,
    healthy,
    failed: endpoints.length - healthy,
    endpoints,
  };
}

export function formatPresets(report: PresetsReport): string {
  const rows = report.endpoints.map((endpoint) => [
    endpoint.preset,
    String(endpoint.chainId),
    endpoint.ok ? "healthy" : "failed",
    endpoint.ok && endpoint.latencyMs !== null ? `${endpoint.latencyMs} ms` : "—",
    endpoint.ok && endpoint.blockNumber !== null ? String(endpoint.blockNumber) : "—",
    endpoint.ok ? (endpoint.viaFallback ? "backup" : "primary") : "—",
  ]);
  const headers = ["preset", "chain", "status", "latency", "block", "via"];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]): string =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}`;

  const lines = ["lwc — built-in presets", "", line(headers), ...rows.map(line)];

  for (const endpoint of report.endpoints) {
    if (!endpoint.ok) {
      lines.push(`  ${endpoint.preset}: ${endpoint.error ?? "unknown error"}`);
    } else if (endpoint.viaFallback) {
      lines.push(
        `  ${endpoint.preset}: primary failed (${endpoint.primaryError ?? "unknown error"}); answered by ${endpoint.rpcHost}`,
      );
    }
  }

  lines.push("", `${report.healthy} of ${report.total} endpoints healthy`);
  return lines.join("\n");
}

export function toPresetsJson(report: PresetsReport): {
  total: number;
  healthy: number;
  failed: number;
  endpoints: Array<Omit<PresetProbeResult, "blockNumber"> & { blockNumber: string | null }>;
} {
  return {
    total: report.total,
    healthy: report.healthy,
    failed: report.failed,
    endpoints: report.endpoints.map((endpoint) => ({
      ...endpoint,
      blockNumber: endpoint.blockNumber === null ? null : endpoint.blockNumber.toString(),
    })),
  };
}

function parseTimeout(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new PresetsArgError(`--timeout must be whole milliseconds, got "${raw}".`);
  }
  const timeoutMs = Number(raw);
  if (timeoutMs < MIN_PROBE_TIMEOUT_MS || timeoutMs > MAX_PROBE_TIMEOUT_MS) {
    throw new PresetsArgError(
      `--timeout must be between ${MIN_PROBE_TIMEOUT_MS} and ${MAX_PROBE_TIMEOUT_MS} ms.`,
    );
  }
  return timeoutMs;
}

/** `lwc presets` takes --json and --timeout; --chain is meaningless here. */
export function parsePresetsArgs(argv: string[]): { timeoutMs: number } {
  let timeoutMs = DEFAULT_PROBE_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") continue;
    if (arg === "--timeout") {
      const value = argv[index + 1];
      if (!value) throw new PresetsArgError("--timeout requires a value.");
      timeoutMs = parseTimeout(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      timeoutMs = parseTimeout(arg.slice("--timeout=".length));
      continue;
    }
    throw new PresetsArgError(`unexpected argument "${arg}".`);
  }

  return { timeoutMs };
}
