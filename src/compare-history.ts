import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { csvCell } from "./scan.ts";

export class CompareHistoryArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompareHistoryArgError";
  }
}

export interface CompareHistoryArgs {
  /** Compare NDJSON log to read. */
  path: string;
  /** Where to write the per-run CSV, "-" for stdout, or null for the table. */
  csvPath: string | null;
}

export function parseCompareHistoryArgs(argv: string[]): CompareHistoryArgs {
  const positional: string[] = [];
  let csvPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--csv") {
      const value = argv[index + 1];
      if (!value || (value.startsWith("-") && value !== "-")) {
        throw new CompareHistoryArgError("--csv requires a path, or - for stdout.");
      }
      csvPath = value;
      index += 1;
    } else if (arg.startsWith("--csv=")) {
      const value = arg.slice("--csv=".length);
      if (!value) throw new CompareHistoryArgError("--csv requires a path, or - for stdout.");
      csvPath = value;
    } else if (arg.startsWith("-")) {
      continue; // --json and other global flags.
    } else {
      positional.push(arg);
    }
  }

  const [path] = positional;
  if (!path) {
    throw new CompareHistoryArgError(
      "A compare log path is required: lwc compare-history <compare.ndjson>",
    );
  }
  if (positional.length > 1) {
    throw new CompareHistoryArgError(`Unexpected extra argument: ${positional[1]}.`);
  }

  return { path, csvPath };
}

export function readCompareLog(path: string): string {
  if (!existsSync(path)) {
    throw new CompareHistoryArgError(`compare log not found: ${path}`);
  }
  return readFileSync(path, "utf8");
}

export interface CompareRunProvider {
  url: string;
  label: string | null;
  wins: number;
  observed: number;
  misses: number;
  /** This run's median head delay in ms; null when it observed no new heads. */
  delayMs: number | null;
  errors: number;
  ok: boolean;
}

export interface CompareRun {
  session: string;
  /** Epoch milliseconds of the record. */
  at: number;
  chainId: number | null;
  chainName: string | null;
  samples: number;
  newBlocks: number;
  providers: CompareRunProvider[];
}

export interface ProviderHistory {
  url: string;
  label: string | null;
  /** Label when the log carried one, otherwise the sanitized URL. */
  name: string;
  /** Runs that included this provider. */
  runs: number;
  wins: number;
  /** Wins as a share of the new blocks in those runs; null when none. */
  winRate: number | null;
  /** Median across runs of each run's own median head delay. */
  delayMs: number | null;
  /** Delay from the newest run that observed heads; null when none did. */
  lastDelayMs: number | null;
  /** Epoch milliseconds of the newest run that included this provider. */
  lastSeen: number;
}

export interface CompareHistoryReport {
  path: string;
  runs: CompareRun[];
  providers: ProviderHistory[];
  firstAt: number | null;
  lastAt: number | null;
  /** Sum of distinct new heads across runs. */
  newBlocks: number;
  /** Chains seen in the log, in first-appearance order. */
  chains: Array<{ id: number | null; name: string | null }>;
  /** Malformed lines, or compare records without a session or timestamp. */
  skippedLines: number;
}

type RawLine = Record<string, unknown>;

function objectOf(value: unknown): RawLine | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawLine)
    : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timeField(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return Math.round(value);
}

/**
 * Read the `compare` records of an NDJSON log and pool them by endpoint. Other
 * event types are ignored so a mixed log can be passed without noise.
 */
export function summarizeCompareLog(text: string): Omit<CompareHistoryReport, "path"> {
  const runs: CompareRun[] = [];
  const chains: Array<{ id: number | null; name: string | null }> = [];
  let skippedLines = 0;

  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skippedLines += 1;
      continue;
    }

    const record = objectOf(parsed);
    if (record === null || typeof record.event !== "string") {
      skippedLines += 1;
      continue;
    }
    if (record.event !== "compare") continue;

    const session = typeof record.session === "string" ? record.session : null;
    const at = timeField(record.at);
    if (session === null || at === null) {
      skippedLines += 1;
      continue;
    }

    const chain = objectOf(record.chain);
    const chainId = numberField(chain?.id);
    const chainName = chain !== null && typeof chain.name === "string" ? chain.name : null;
    if (!chains.some((entry) => entry.id === chainId && entry.name === chainName)) {
      chains.push({ id: chainId, name: chainName });
    }

    const providers: CompareRunProvider[] = [];
    for (const value of Array.isArray(record.endpoints) ? record.endpoints : []) {
      const endpoint = objectOf(value);
      if (endpoint === null || typeof endpoint.url !== "string") continue;
      const delivery = objectOf(endpoint.delivery);
      providers.push({
        url: endpoint.url,
        label: typeof endpoint.label === "string" ? endpoint.label : null,
        wins: numberField(delivery?.wins) ?? 0,
        observed: numberField(delivery?.observed) ?? 0,
        misses: numberField(delivery?.misses) ?? 0,
        delayMs: numberField(delivery?.p50Ms),
        errors: numberField(endpoint.errors) ?? 0,
        ok: endpoint.ok === true,
      });
    }

    runs.push({
      session,
      at,
      chainId,
      chainName,
      samples: numberField(record.samples) ?? 0,
      newBlocks: numberField(record.newBlocks) ?? 0,
      providers,
    });
  }

  runs.sort((a, b) => a.at - b.at);

  const grouped = new Map<
    string,
    {
      url: string;
      label: string | null;
      runs: number;
      wins: number;
      blocks: number;
      delays: number[];
      lastDelayMs: number | null;
      lastDelayAt: number;
      lastSeen: number;
    }
  >();

  for (const run of runs) {
    for (const provider of run.providers) {
      let entry = grouped.get(provider.url);
      if (!entry) {
        entry = {
          url: provider.url,
          label: null,
          runs: 0,
          wins: 0,
          blocks: 0,
          delays: [],
          lastDelayMs: null,
          lastDelayAt: Number.NEGATIVE_INFINITY,
          lastSeen: run.at,
        };
        grouped.set(provider.url, entry);
      }

      entry.runs += 1;
      entry.wins += provider.wins;
      entry.blocks += run.newBlocks;
      if (provider.label !== null) entry.label = provider.label;
      if (provider.delayMs !== null) {
        entry.delays.push(provider.delayMs);
        if (run.at >= entry.lastDelayAt) {
          entry.lastDelayAt = run.at;
          entry.lastDelayMs = provider.delayMs;
        }
      }
      if (run.at >= entry.lastSeen) entry.lastSeen = run.at;
    }
  }

  const providers: ProviderHistory[] = [...grouped.values()].map((entry) => ({
    url: entry.url,
    label: entry.label,
    name: entry.label ?? entry.url,
    runs: entry.runs,
    wins: entry.wins,
    winRate: entry.blocks === 0 ? null : entry.wins / entry.blocks,
    delayMs: median(entry.delays),
    lastDelayMs: entry.lastDelayMs,
    lastSeen: entry.lastSeen,
  }));

  providers.sort(
    (a, b) =>
      b.wins - a.wins ||
      (a.delayMs ?? Number.POSITIVE_INFINITY) - (b.delayMs ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name),
  );

  return {
    runs,
    providers,
    firstAt: runs[0]?.at ?? null,
    lastAt: runs[runs.length - 1]?.at ?? null,
    newBlocks: runs.reduce((sum, run) => sum + run.newBlocks, 0),
    chains,
    skippedLines,
  };
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function stamp(at: number): string {
  return iso(at).slice(5, 16).replace("T", " ");
}

export function formatCompareHistory(report: CompareHistoryReport): string {
  const lines = ["lwc — compare history", ""];
  lines.push(`  ${"log".padEnd(12)}${report.path}`);

  const first = report.firstAt;
  const last = report.lastAt;
  const range =
    first === null
      ? "—"
      : last === null || last === first
        ? iso(first)
        : `${iso(first)} → ${iso(last)}`;
  lines.push(`  ${"runs".padEnd(12)}${report.runs.length} (${range})`);
  lines.push(`  ${"new blocks".padEnd(12)}${report.newBlocks}`);

  if (report.chains.length === 1) {
    const chain = report.chains[0];
    lines.push(
      `  ${"chain".padEnd(12)}${chain?.name ?? "?"}${chain?.id == null ? "" : ` (${chain.id})`}`,
    );
  } else if (report.chains.length > 1) {
    const names = report.chains.map(
      (chain) => `${chain.name ?? "?"}${chain.id == null ? "" : ` (${chain.id})`}`,
    );
    lines.push(`  ${"chains".padEnd(12)}${names.join(", ")}`);
  }

  if (report.skippedLines > 0) {
    lines.push(`  ${"skipped".padEnd(12)}${report.skippedLines} malformed line(s)`);
  }
  lines.push("");

  if (report.providers.length === 0) {
    lines.push(report.runs.length === 0 ? "  (no compare records)" : "  (no endpoint records)");
    return lines.join("\n");
  }

  const width = Math.max(8, ...report.providers.map((provider) => provider.name.length));
  lines.push(
    `  ${"provider".padEnd(width)}  ${"runs".padStart(4)}  ${"wins".padStart(4)}  ${"win%".padStart(5)}  ${"delay".padStart(6)}  ${"last".padStart(6)}  ${"last seen".padStart(11)}`,
  );

  for (const provider of report.providers) {
    const winRate =
      provider.winRate === null ? "n/a" : `${Math.round(provider.winRate * 100)}%`;
    const delay = provider.delayMs === null ? "n/a" : `${provider.delayMs}ms`;
    const last = provider.lastDelayMs === null ? "n/a" : `${provider.lastDelayMs}ms`;
    lines.push(
      `  ${provider.name.padEnd(width)}  ${String(provider.runs).padStart(4)}  ${String(provider.wins).padStart(4)}  ${winRate.padStart(5)}  ${delay.padStart(6)}  ${last.padStart(6)}  ${stamp(provider.lastSeen).padStart(11)}`,
    );
  }

  return lines.join("\n");
}

export const COMPARE_HISTORY_CSV_HEADER = [
  "session",
  "at",
  "chain",
  "chain_id",
  "samples",
  "new_blocks",
  "provider",
  "provider_url",
  "wins",
  "observed",
  "misses",
  "delay_ms",
  "errors",
  "ok",
] as const;

/**
 * One row per run and provider: the run's identity and chain are repeated for
 * each of its endpoints, so a spreadsheet can pivot by provider, session, or
 * time without parsing nested JSON. `delay_ms` is empty when that provider saw
 * no new heads in the run.
 */
export function compareHistoryCsv(report: Pick<CompareHistoryReport, "runs">): string {
  const lines = [COMPARE_HISTORY_CSV_HEADER.join(",")];

  for (const run of report.runs) {
    for (const provider of run.providers) {
      lines.push(
        [
          run.session,
          iso(run.at),
          run.chainName ?? "",
          run.chainId === null ? "" : String(run.chainId),
          String(run.samples),
          String(run.newBlocks),
          provider.label ?? provider.url,
          provider.url,
          String(provider.wins),
          String(provider.observed),
          String(provider.misses),
          provider.delayMs === null ? "" : String(provider.delayMs),
          String(provider.errors),
          provider.ok ? "true" : "false",
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Write the CSV, creating parent directories; an existing file is replaced. */
export function saveCompareHistoryCsv(path: string, csv: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, csv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CompareHistoryArgError(`cannot write ${path}: ${reason}`);
  }
}

export function toCompareHistoryJson(report: CompareHistoryReport): Record<string, unknown> {
  return {
    path: report.path,
    runs: report.runs.length,
    firstAt: report.firstAt === null ? null : iso(report.firstAt),
    lastAt: report.lastAt === null ? null : iso(report.lastAt),
    newBlocks: report.newBlocks,
    chains: report.chains,
    skippedLines: report.skippedLines,
    providers: report.providers.map((provider) => ({
      url: provider.url,
      label: provider.label,
      name: provider.name,
      runs: provider.runs,
      wins: provider.wins,
      winRate: provider.winRate,
      delayMs: provider.delayMs,
      lastDelayMs: provider.lastDelayMs,
      lastSeen: iso(provider.lastSeen),
    })),
    history: report.runs.map((run) => ({
      session: run.session,
      at: iso(run.at),
      chain: { id: run.chainId, name: run.chainName },
      samples: run.samples,
      newBlocks: run.newBlocks,
      endpoints: run.providers.map((provider) => ({
        url: provider.url,
        label: provider.label,
        ok: provider.ok,
        wins: provider.wins,
        observed: provider.observed,
        misses: provider.misses,
        delayMs: provider.delayMs,
        errors: provider.errors,
      })),
    })),
  };
}
