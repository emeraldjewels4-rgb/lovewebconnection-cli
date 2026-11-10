import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { percentile } from "./metrics.ts";
import { csvCell } from "./scan.ts";

export class SessionsArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionsArgError";
  }
}

export interface SessionsArgs {
  path: string;
  /** Only sessions that started at or after this epoch-ms time; null for no limit. */
  since: number | null;
  /** Only sessions whose id starts with one of these prefixes; empty for all. */
  sessionPrefixes: string[];
  /** Where to write the per-session CSV, "-" for stdout, or null for the table. */
  csvPath: string | null;
}

const SINCE_UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `--since` takes an ISO timestamp or a span relative to now, e.g. `24h`. */
function parseSince(raw: string): number {
  const relative = /^(\d+)([smhd])$/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = SINCE_UNITS_MS[relative[2] as keyof typeof SINCE_UNITS_MS];
    return Date.now() - amount * unit;
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new SessionsArgError(
      `--since must be an ISO timestamp or a span like 24h, got "${raw}".`,
    );
  }
  return parsed;
}

export function parseSessionsArgs(argv: string[]): SessionsArgs {
  const positional: string[] = [];
  let since: number | null = null;
  const sessionPrefixes: string[] = [];
  let csvPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readValue = (flag: string): string => {
      const value = argv[index + 1];
      if (!value) throw new SessionsArgError(`${flag} requires a value.`);
      index += 1;
      return value;
    };

    if (arg === "--since" || arg.startsWith("--since=")) {
      const value = arg.startsWith("--since=") ? arg.slice("--since=".length) : readValue("--since");
      since = parseSince(value);
    } else if (arg === "--session" || arg.startsWith("--session=")) {
      const value = arg.startsWith("--session=") ? arg.slice("--session=".length) : readValue("--session");
      if (!value) throw new SessionsArgError("--session requires a prefix.");
      sessionPrefixes.push(value);
    } else if (arg === "--csv") {
      const value = argv[index + 1];
      if (!value || (value.startsWith("-") && value !== "-")) {
        throw new SessionsArgError("--csv requires a path, or - for stdout.");
      }
      csvPath = value;
      index += 1;
    } else if (arg.startsWith("--csv=")) {
      const value = arg.slice("--csv=".length);
      if (!value) throw new SessionsArgError("--csv requires a path, or - for stdout.");
      csvPath = value;
    } else if (arg.startsWith("-")) {
      // --json and any other global flags are handled by the CLI.
      continue;
    } else {
      positional.push(arg);
    }
  }

  const [path] = positional;
  if (!path) {
    throw new SessionsArgError("A watch log path is required: lwc sessions <log.ndjson>");
  }
  if (positional.length > 1) {
    throw new SessionsArgError(`Unexpected extra argument: ${positional[1]}.`);
  }

  return { path, since, sessionPrefixes, csvPath };
}

export function readWatchLog(path: string): string {
  if (!existsSync(path)) {
    throw new SessionsArgError(`watch log not found: ${path}`);
  }
  return readFileSync(path, "utf8");
}

export interface SessionLatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface SessionBlockTimeStats {
  count: number;
  medianSeconds: number;
  minSeconds: number;
  maxSeconds: number;
}

export type SessionState = "complete" | "aborted" | "partial";

export interface SessionSummary {
  id: string;
  chain: { id: number; name: string } | null;
  /** Sanitised RPC endpoint from the `start` line; null in older logs. */
  endpoint: string | null;
  state: SessionState;
  /** Epoch milliseconds of the `start` line; null when the log is missing it. */
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  samples: number;
  latency: SessionLatencyStats;
  blockTime: SessionBlockTimeStats;
  stalls: number;
  gasSurges: number;
  alerts: number;
  errors: number;
  chainDrift: boolean;
  firstBlock: bigint | null;
  lastBlock: bigint | null;
  advancedBy: bigint;
}

export interface EndpointSummary {
  /** RPC host from the session's `start` line; null in older logs. */
  endpoint: string | null;
  sessions: number;
  samples: number;
  /** Percentiles pooled from every poll, so busy sessions weigh more. */
  latency: SessionLatencyStats;
  stalls: number;
  gasSurges: number;
  errors: number;
  /** Stalls per poll across these sessions; 0 when there were no polls. */
  stallRate: number;
}

export interface SessionsReport {
  path: string;
  sessions: SessionSummary[];
  /** Sessions pooled by the RPC host that served them. */
  endpoints: EndpointSummary[];
  /** Lines that were not valid JSON objects, or had no session id. */
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

function bigintField(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function timeField(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function latencyStats(values: number[]): SessionLatencyStats {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function blockTimeStats(values: number[]): SessionBlockTimeStats {
  if (values.length === 0) return { count: 0, medianSeconds: 0, minSeconds: 0, maxSeconds: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianSeconds: percentile(sorted, 50),
    minSeconds: sorted[0] ?? 0,
    maxSeconds: sorted[sorted.length - 1] ?? 0,
  };
}

function summaryOf(lines: RawLine[]): RawLine | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.event === "summary") return lines[index] ?? null;
  }
  return null;
}

function buildSession(id: string, lines: RawLine[]): SessionSummary {
  const start = lines.find((line) => line.event === "start") ?? null;
  const summary = summaryOf(lines);
  const advances = lines.filter((line) => line.event === "advance");
  const holds = lines.filter((line) => line.event === "hold");
  const latencyValues = [...advances, ...holds]
    .map((line) => numberField(line.latencyMs))
    .filter((value): value is number => value !== null);

  // Block time is the gap between consecutive advances that moved the head,
  // which is what the watch run itself samples.
  const blockTimes: number[] = [];
  for (let index = 1; index < advances.length; index += 1) {
    const delta = bigintField(advances[index]?.delta);
    const at = timeField(advances[index]?.at);
    const previousAt = timeField(advances[index - 1]?.at);
    if (delta !== null && delta > 0n && at !== null && previousAt !== null) {
      blockTimes.push(Math.max(0, (at - previousAt) / 1000));
    }
  }

  const startTime = timeField(start?.at);
  const eventTimes = lines
    .map((line) => timeField(line.at))
    .filter((value): value is number => value !== null);
  const firstEventTime = eventTimes.length > 0 ? Math.min(...eventTimes) : null;
  const lastEventTime = eventTimes.length > 0 ? Math.max(...eventTimes) : null;
  const startedAt = startTime ?? firstEventTime;

  const summaryDuration = summary === null ? null : numberField(summary.durationMs);
  const durationMs =
    summaryDuration ??
    (startedAt !== null && lastEventTime !== null ? Math.max(0, lastEventTime - startedAt) : 0);

  const blockNumbers = [...advances, ...holds]
    .map((line) => bigintField(line.blockNumber))
    .filter((value): value is bigint => value !== null);
  const firstBlock = summary === null ? null : bigintField(summary.firstBlock);
  const lastBlock = summary === null ? null : bigintField(summary.lastBlock);

  const chainRaw = start === null ? null : objectOf(start.chain);
  const chainId = chainRaw === null ? null : numberField(chainRaw.id);
  const chainName =
    chainRaw !== null && typeof chainRaw.name === "string" ? chainRaw.name : null;

  const firstBlockNumber = blockNumbers[0] ?? null;
  const lastBlockNumber = blockNumbers[blockNumbers.length - 1] ?? null;
  const rawFirst = firstBlock ?? firstBlockNumber;
  const rawLast = lastBlock ?? lastBlockNumber;
  const advancedBy =
    summary === null
      ? rawFirst !== null && rawLast !== null
        ? rawLast - rawFirst
        : 0n
      : (bigintField(summary.advancedBy) ?? 0n);

  return {
    id,
    chain: chainId === null ? null : { id: chainId, name: chainName ?? "?" },
    endpoint: start !== null && typeof start.endpoint === "string" ? start.endpoint : null,
    state:
      summary === null ? "partial" : summary.aborted === true ? "aborted" : "complete",
    startedAt,
    endedAt: startedAt === null ? lastEventTime : startedAt + durationMs,
    durationMs,
    samples:
      (summary === null ? null : numberField(summary.samples)) ?? advances.length + holds.length,
    latency: latencyStats(latencyValues),
    blockTime: blockTimeStats(blockTimes),
    stalls:
      (summary === null ? null : numberField(summary.stalls)) ??
      lines.filter((line) => line.event === "stall").length,
    gasSurges:
      (summary === null ? null : numberField(summary.gasSurges)) ??
      lines.filter((line) => line.event === "gas-surge").length,
    alerts:
      (summary === null ? null : numberField(summary.alerts)) ??
      lines.filter((line) => line.event === "alert" || line.event === "balance-alert").length,
    errors:
      (summary === null ? null : numberField(summary.errors)) ??
      lines.filter((line) => line.event === "error").length,
    chainDrift:
      summary === null
        ? lines.some((line) => line.event === "chain-drift")
        : summary.chainDrift === true,
    firstBlock: rawFirst,
    lastBlock: rawLast,
    advancedBy,
  };
}

function buildEndpoint(
  endpoint: string | null,
  sessions: SessionSummary[],
  latencyValues: number[],
): EndpointSummary {
  const total = (pick: (session: SessionSummary) => number): number =>
    sessions.reduce((sum, session) => sum + pick(session), 0);
  const samples = total((session) => session.samples);
  const stalls = total((session) => session.stalls);

  return {
    endpoint,
    sessions: sessions.length,
    samples,
    latency: latencyStats(latencyValues),
    stalls,
    gasSurges: total((session) => session.gasSurges),
    errors: total((session) => session.errors),
    stallRate: samples > 0 ? stalls / samples : 0,
  };
}

export interface SessionsFilter {
  /** Drop sessions that started before this epoch-ms time. */
  since?: number | null;
  /** Keep only sessions whose id starts with one of these prefixes. */
  sessionPrefixes?: string[];
}

/**
 * Group a watch NDJSON log by session id and summarise each run. Latency
 * percentiles are computed from every poll in the session rather than the
 * watch run's rolling window, so two sessions with different `--window`
 * values are still comparable. A session without a `summary` line (killed, or
 * still running) is kept and marked partial. `filter` narrows a long log before
 * the comparison: prefixes drop non-matching lines, and `since` drops completed
 * sessions that started too early.
 */
export function summarizeWatchLog(
  text: string,
  filter: SessionsFilter = {},
): { sessions: SessionSummary[]; endpoints: EndpointSummary[]; skippedLines: number } {
  const groups = new Map<string, RawLine[]>();
  const prefixes = filter.sessionPrefixes ?? [];
  let skippedLines = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }

    const record = objectOf(parsed);
    const session = record !== null && typeof record.session === "string" ? record.session : null;
    if (record === null || session === null) {
      skippedLines += 1;
      continue;
    }

    // A session narrowed away by a prefix is not malformed, so it is not counted.
    if (prefixes.length > 0 && !prefixes.some((prefix) => session.startsWith(prefix))) {
      continue;
    }

    const existing = groups.get(session);
    if (existing) existing.push(record);
    else groups.set(session, [record]);
  }

  const sessions = [...groups.entries()]
    .map(([id, lines]) => buildSession(id, lines))
    .filter(
      (session) =>
        filter.since == null ||
        (session.startedAt !== null && session.startedAt >= filter.since),
    );
  sessions.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  // Pool by RPC host: percentiles over all polls are fairer than averaging the
  // per-session percentiles, and the host keeps API keys out of the summary.
  const byEndpoint = new Map<
    string,
    { endpoint: string | null; sessions: SessionSummary[]; latencies: number[] }
  >();
  for (const session of sessions) {
    const lines = groups.get(session.id) ?? [];
    const start = lines.find((line) => line.event === "start") ?? null;
    const rawEndpoint =
      start !== null && typeof start.endpoint === "string" ? start.endpoint : null;
    const endpoint = rawEndpoint === null ? null : endpointHost(rawEndpoint);
    const key = endpoint ?? "";

    let group = byEndpoint.get(key);
    if (!group) {
      group = { endpoint, sessions: [], latencies: [] };
      byEndpoint.set(key, group);
    }
    group.sessions.push(session);

    for (const line of lines) {
      if (line.event !== "advance" && line.event !== "hold") continue;
      const latency = numberField(line.latencyMs);
      if (latency !== null) group.latencies.push(latency);
    }
  }

  const endpoints = [...byEndpoint.values()]
    .map((group) => buildEndpoint(group.endpoint, group.sessions, group.latencies))
    .sort(
      (a, b) =>
        b.samples - a.samples ||
        b.sessions - a.sessions ||
        (a.endpoint ?? "").localeCompare(b.endpoint ?? ""),
    );

  return { sessions, endpoints, skippedLines };
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function endpointHost(endpoint: string | null): string {
  if (endpoint === null) return "?";
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function formatStart(at: number | null): string {
  if (at === null) return "—";
  // UTC keeps the table stable regardless of the machine's timezone.
  return new Date(at).toISOString().slice(5, 19).replace("T", " ");
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

const NA = "n/a";

export function formatSessions(report: SessionsReport): string {
  const idWidth = Math.max(7, ...report.sessions.map((session) => session.id.length));
  const chainWidth = Math.max(
    5,
    ...report.sessions.map((session) =>
      session.chain === null ? 1 : `${session.chain.name} (${session.chain.id})`.length,
    ),
  );
  const rpcWidth = Math.max(
    3,
    ...report.sessions.map((session) => endpointHost(session.endpoint).length),
  );
  const partial = report.sessions.filter((session) => session.state === "partial").length;

  const header = [
    "session".padEnd(idWidth),
    "chain".padEnd(chainWidth),
    "rpc".padEnd(rpcWidth),
    "started (UTC)".padEnd(15),
    "duration".padStart(8),
    "polls".padStart(5),
    "p50".padStart(5),
    "p95".padStart(5),
    "stalls".padStart(6),
    "surges".padStart(6),
    "errors".padStart(6),
    "state".padEnd(8),
  ].join("  ");

  const rows = report.sessions.map((session) => {
    const chain = session.chain === null ? "?" : `${session.chain.name} (${session.chain.id})`;
    const latency = session.latency;
    return [
      session.id.padEnd(idWidth),
      chain.padEnd(chainWidth),
      endpointHost(session.endpoint).padEnd(rpcWidth),
      formatStart(session.startedAt).padEnd(15),
      formatDuration(session.durationMs).padStart(8),
      String(session.samples).padStart(5),
      (latency.count > 0 ? String(latency.p50) : NA).padStart(5),
      (latency.count > 0 ? String(latency.p95) : NA).padStart(5),
      String(session.stalls).padStart(6),
      String(session.gasSurges).padStart(6),
      String(session.errors).padStart(6),
      session.state.padEnd(8),
    ].join("  ");
  });

  const lines = [
    "lwc — watch sessions",
    "",
    `  ${"log".padEnd(14)}${report.path}`,
    `  ${"sessions".padEnd(14)}${report.sessions.length}${partial > 0 ? ` (${partial} partial)` : ""}`,
  ];
  if (report.skippedLines > 0) {
    lines.push(`  ${"skipped".padEnd(14)}${report.skippedLines} malformed line(s)`);
  }
  lines.push("", header, ...rows);

  if (report.endpoints.length > 0) {
    const hostWidth = Math.max(
      8,
      ...report.endpoints.map((item) => (item.endpoint ?? "?").length),
    );
    const endpointHeader = [
      "endpoint".padEnd(hostWidth),
      "sessions".padStart(8),
      "polls".padStart(6),
      "p50".padStart(5),
      "p95".padStart(5),
      "stalls".padStart(6),
      "stall rate".padStart(10),
    ].join("  ");

    lines.push("", "by endpoint", "", endpointHeader);
    for (const item of report.endpoints) {
      const latency = item.latency;
      lines.push(
        [
          (item.endpoint ?? "?").padEnd(hostWidth),
          String(item.sessions).padStart(8),
          String(item.samples).padStart(6),
          (latency.count > 0 ? String(latency.p50) : NA).padStart(5),
          (latency.count > 0 ? String(latency.p95) : NA).padStart(5),
          String(item.stalls).padStart(6),
          (item.samples > 0 ? `${(item.stallRate * 100).toFixed(1)}%` : NA).padStart(10),
        ].join("  "),
      );
    }
  }

  return lines.join("\n");
}

export const SESSIONS_CSV_HEADER = [
  "session",
  "started_at",
  "ended_at",
  "state",
  "chain",
  "chain_id",
  "endpoint",
  "duration_ms",
  "samples",
  "latency_p50_ms",
  "latency_p95_ms",
  "latency_max_ms",
  "block_time_median_s",
  "block_time_min_s",
  "block_time_max_s",
  "stalls",
  "gas_surges",
  "alerts",
  "errors",
  "chain_drift",
  "first_block",
  "last_block",
  "advanced_by",
] as const;

/**
 * One row per session: identity, chain, RPC endpoint, and the same latency,
 * block-time, and counter fields as the table. Missing measurements are empty
 * cells rather than zeroes, so a spreadsheet can tell `no polls` from `0 ms`.
 */
export function sessionsCsv(report: Pick<SessionsReport, "sessions">): string {
  const lines = [SESSIONS_CSV_HEADER.join(",")];

  for (const session of report.sessions) {
    const latency = session.latency.count > 0 ? session.latency : null;
    const blockTime = session.blockTime.count > 0 ? session.blockTime : null;
    lines.push(
      [
        session.id,
        session.startedAt === null ? "" : iso(session.startedAt),
        session.endedAt === null ? "" : iso(session.endedAt),
        session.state,
        session.chain?.name ?? "",
        session.chain === null ? "" : String(session.chain.id),
        session.endpoint ?? "",
        String(session.durationMs),
        String(session.samples),
        latency === null ? "" : String(latency.p50),
        latency === null ? "" : String(latency.p95),
        latency === null ? "" : String(latency.max),
        blockTime === null ? "" : String(blockTime.medianSeconds),
        blockTime === null ? "" : String(blockTime.minSeconds),
        blockTime === null ? "" : String(blockTime.maxSeconds),
        String(session.stalls),
        String(session.gasSurges),
        String(session.alerts),
        String(session.errors),
        session.chainDrift ? "true" : "false",
        session.firstBlock === null ? "" : session.firstBlock.toString(),
        session.lastBlock === null ? "" : session.lastBlock.toString(),
        session.advancedBy.toString(),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Write the CSV, creating parent directories; an existing file is replaced. */
export function saveSessionsCsv(path: string, csv: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, csv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SessionsArgError(`cannot write ${path}: ${reason}`);
  }
}

export function toSessionsJson(report: SessionsReport): Record<string, unknown> {
  return {
    ok: report.sessions.every((session) => session.state !== "partial"),
    log: report.path,
    skippedLines: report.skippedLines,
    sessions: report.sessions.map((session) => ({
      id: session.id,
      chain: session.chain,
      endpoint: session.endpoint,
      state: session.state,
      startedAt: session.startedAt === null ? null : new Date(session.startedAt).toISOString(),
      endedAt: session.endedAt === null ? null : new Date(session.endedAt).toISOString(),
      durationMs: session.durationMs,
      samples: session.samples,
      latency: session.latency,
      blockTime: session.blockTime,
      stalls: session.stalls,
      gasSurges: session.gasSurges,
      alerts: session.alerts,
      errors: session.errors,
      chainDrift: session.chainDrift,
      firstBlock: session.firstBlock === null ? null : session.firstBlock.toString(),
      lastBlock: session.lastBlock === null ? null : session.lastBlock.toString(),
      advancedBy: session.advancedBy.toString(),
    })),
    endpoints: report.endpoints.map((item) => ({
      endpoint: item.endpoint,
      sessions: item.sessions,
      samples: item.samples,
      latency: item.latency,
      stalls: item.stalls,
      gasSurges: item.gasSurges,
      errors: item.errors,
      stallRate: item.stallRate,
    })),
  };
}
