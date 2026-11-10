import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { toPresetsJson, type PresetsReport } from "./presets.ts";

type PresetsJson = ReturnType<typeof toPresetsJson>;
type PresetEndpoint = PresetsJson["endpoints"][number];

/** One probe run, appended to a JSONL file. */
export interface PresetHistoryRecord extends PresetsJson {
  /** When the probe ran, ISO 8601. */
  at: string;
}

export class PresetsHistoryArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetsHistoryArgError";
  }
}

/** The window `--since` and `--limit` narrow a history file to. */
export interface PresetsHistorySelection {
  /** Epoch-ms cutoff: keep runs recorded at or after this time. */
  since?: number | null;
  /** Keep only the newest N runs left after the cutoff. */
  limit?: number | null;
}

export interface PresetHistoryRow {
  preset: string;
  chainId: number;
  nativeSymbol: string;
  runs: number;
  healthy: number;
  failed: number;
  /** Runs where the backup answered for this chain. */
  failovers: number;
  uptimePct: number;
  p50LatencyMs: number | null;
  maxLatencyMs: number | null;
  lastAt: string | null;
  lastFailureAt: string | null;
}

export interface PresetsHistorySummary {
  /** Runs inside the window. */
  runs: number;
  /** Runs in the file before the window was applied. */
  totalRuns: number;
  from: string | null;
  to: string | null;
  /** The applied --since cutoff in epoch ms, or null. */
  since: number | null;
  /** The applied --limit, or null. */
  limit: number | null;
  healthyRuns: number;
  failedRuns: number;
  failoverRuns: number;
  presets: PresetHistoryRow[];
}

/** Append this run's report, creating the file and its directory if needed. */
export function appendPresetHistory(
  path: string,
  report: PresetsReport,
  now: Date = new Date(),
): PresetHistoryRecord {
  const record: PresetHistoryRecord = { at: now.toISOString(), ...toPresetsJson(report) };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
  return record;
}

/**
 * Read a history file, oldest first. A truncated or hand-edited line is skipped
 * rather than losing every run that came before it.
 */
export function readPresetHistory(path: string): PresetHistoryRecord[] {
  const records: PresetHistoryRecord[] = [];

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as Partial<PresetHistoryRecord>;
      if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) continue;
      if (typeof value.total !== "number" || !Array.isArray(value.endpoints)) continue;
      records.push(value as PresetHistoryRecord);
    } catch {
      // Malformed line: keep reading.
    }
  }

  return records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Nearest-rank percentile, matching the compare and sessions reports. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function summarizePresetHistory(
  records: PresetHistoryRecord[],
  selection: PresetsHistorySelection = {},
): PresetsHistorySummary {
  const totalRuns = records.length;
  const since = selection.since ?? null;
  const limit = selection.limit ?? null;
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const afterCutoff =
    since === null ? sorted : sorted.filter((record) => Date.parse(record.at) >= since);
  // A limit is only ever used to look at recent runs, so it keeps the tail.
  const ordered =
    limit === null ? afterCutoff : afterCutoff.slice(Math.max(0, afterCutoff.length - limit));

  interface Bucket {
    chainId: number;
    nativeSymbol: string;
    latencies: number[];
    runs: number;
    healthy: number;
    failed: number;
    failovers: number;
    lastAt: string | null;
    lastFailureAt: string | null;
  }

  const buckets = new Map<string, Bucket>();
  let healthyRuns = 0;
  let failedRuns = 0;
  let failoverRuns = 0;

  for (const record of ordered) {
    if (record.failed === 0) healthyRuns += 1;
    else failedRuns += 1;
    if (record.endpoints.some((endpoint) => endpoint.ok && endpoint.viaFallback)) {
      failoverRuns += 1;
    }

    for (const endpoint of record.endpoints) {
      const bucket: Bucket = buckets.get(endpoint.preset) ?? {
        chainId: endpoint.chainId,
        nativeSymbol: endpoint.nativeSymbol,
        latencies: [],
        runs: 0,
        healthy: 0,
        failed: 0,
        failovers: 0,
        lastAt: null,
        lastFailureAt: null,
      };

      bucket.runs += 1;
      bucket.chainId = endpoint.chainId;
      bucket.nativeSymbol = endpoint.nativeSymbol;
      bucket.lastAt = record.at;

      if (endpoint.ok) {
        bucket.healthy += 1;
        if (endpoint.viaFallback) bucket.failovers += 1;
        if (typeof endpoint.latencyMs === "number") bucket.latencies.push(endpoint.latencyMs);
      } else {
        bucket.failed += 1;
        bucket.lastFailureAt = record.at;
      }

      buckets.set(endpoint.preset, bucket);
    }
  }

  const presets = [...buckets.entries()]
    .map(([preset, bucket]): PresetHistoryRow => ({
      preset,
      chainId: bucket.chainId,
      nativeSymbol: bucket.nativeSymbol,
      runs: bucket.runs,
      healthy: bucket.healthy,
      failed: bucket.failed,
      failovers: bucket.failovers,
      uptimePct: Math.round((bucket.healthy / bucket.runs) * 1000) / 10,
      p50LatencyMs: percentile(bucket.latencies, 50),
      maxLatencyMs: bucket.latencies.length === 0 ? null : Math.max(...bucket.latencies),
      lastAt: bucket.lastAt,
      lastFailureAt: bucket.lastFailureAt,
    }))
    .sort((a, b) => a.preset.localeCompare(b.preset));

  return {
    runs: ordered.length,
    totalRuns,
    from: ordered[0]?.at ?? null,
    to: ordered.at(-1)?.at ?? null,
    since,
    limit,
    healthyRuns,
    failedRuns,
    failoverRuns,
    presets,
  };
}

/** A preset whose uptime in the window sits below the --fail-under threshold. */
export interface UptimeShortfall {
  preset: string;
  chainId: number;
  uptimePct: number;
  runs: number;
  failed: number;
}

/** Presets below the threshold, worst first; empty when every preset clears it. */
export function presetsBelowUptime(
  summary: PresetsHistorySummary,
  threshold: number,
): UptimeShortfall[] {
  return summary.presets
    .filter((row) => row.uptimePct < threshold)
    .map((row) => ({
      preset: row.preset,
      chainId: row.chainId,
      uptimePct: row.uptimePct,
      runs: row.runs,
      failed: row.failed,
    }))
    .sort((a, b) => a.uptimePct - b.uptimePct || a.preset.localeCompare(b.preset));
}

export interface PresetsGateReport {
  /** False when any preset is below the threshold or the window is empty. */
  passed: boolean;
  threshold: number;
  shortfalls: UptimeShortfall[];
  /** The outcome as markdown for a CI run summary. */
  markdown: string;
}

/**
 * Judge a window against a minimum uptime for CI: markdown for the run summary
 * plus the verdict the caller exits on. An empty window fails, because there is
 * no run left that could clear the threshold.
 */
export function summarizePresetGate(
  summary: PresetsHistorySummary,
  threshold: number,
): PresetsGateReport {
  const shortfalls = presetsBelowUptime(summary, threshold);
  const lines = ["### Preset uptime gate", ""];

  if (summary.runs === 0) {
    lines.push(
      `**FAIL** — no runs in the window (${summary.totalRuns} recorded), so a ${threshold}% minimum cannot be verified.`,
    );
    return { passed: false, threshold, shortfalls, markdown: lines.join("\n") };
  }

  const filter = [
    summary.since === null ? null : `since ${stamp(new Date(summary.since).toISOString())}`,
    summary.limit === null ? null : `newest ${summary.limit}`,
  ].filter((part): part is string => part !== null);
  const runs = `${summary.runs} run${summary.runs === 1 ? "" : "s"} (${stamp(summary.from)} → ${stamp(summary.to)})`;
  const scope = filter.length === 0 ? runs : `${runs}, ${filter.join(", ")}`;

  if (shortfalls.length === 0) {
    const presets = `${summary.presets.length} preset${summary.presets.length === 1 ? "" : "s"}`;
    lines.push(`**PASS** — all ${presets} stayed at or above ${threshold}% across ${scope}.`);
  } else {
    lines.push(
      `**FAIL** — ${shortfalls.length} preset${shortfalls.length === 1 ? "" : "s"} below ${threshold}% across ${scope}.`,
      "",
      "| preset | chain | runs | uptime | failed runs |",
      "| --- | --- | --- | --- | --- |",
      ...shortfalls.map(
        (row) =>
          `| \`${row.preset}\` | ${row.chainId} | ${row.runs} | ${row.uptimePct}% | ${row.failed} |`,
      ),
    );
  }

  return {
    passed: shortfalls.length === 0,
    threshold,
    shortfalls,
    markdown: lines.join("\n"),
  };
}

function stamp(iso: string | null): string {
  return iso === null ? "—" : iso.slice(0, 16).replace("T", " ");
}

export function formatPresetHistory(summary: PresetsHistorySummary): string {
  if (summary.runs === 0) {
    if (summary.totalRuns > 0) {
      return [
        "lwc — preset health history",
        "",
        `  no runs in this window (${summary.totalRuns} recorded); widen --since or raise --limit.`,
      ].join("\n");
    }
    return "lwc — preset health history\n\n  no runs recorded yet; record one with `lwc presets --history <file>`.";
  }

  const runs =
    summary.runs === summary.totalRuns
      ? String(summary.runs)
      : `${summary.runs} of ${summary.totalRuns}`;
  const window = [
    summary.since === null ? null : `since ${stamp(new Date(summary.since).toISOString())}`,
    summary.limit === null ? null : `last ${summary.limit} runs`,
  ].filter((part): part is string => part !== null);

  const lines = [
    "lwc — preset health history",
    "",
    `  runs          ${runs} (${stamp(summary.from)} → ${stamp(summary.to)})`,
    ...(window.length === 0 ? [] : [`  window        ${window.join(", ")}`]),
    `  healthy       ${summary.healthyRuns} of ${summary.runs} runs`,
    `  failed        ${summary.failedRuns} runs`,
    `  failovers     ${summary.failoverRuns} runs served by a backup`,
    "",
  ];

  const rows = summary.presets.map((row) => [
    row.preset,
    String(row.chainId),
    String(row.runs),
    `${row.uptimePct}%`,
    String(row.failovers),
    row.p50LatencyMs === null ? "—" : `${row.p50LatencyMs} ms`,
    row.maxLatencyMs === null ? "—" : `${row.maxLatencyMs} ms`,
    stamp(row.lastFailureAt),
  ]);
  const headers = [
    "preset",
    "chain",
    "runs",
    "uptime",
    "failovers",
    "p50",
    "max",
    "last failure",
  ];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]): string =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}`;

  lines.push(line(headers), ...rows.map(line));
  return lines.join("\n");
}

export function toPresetHistoryJson(summary: PresetsHistorySummary): PresetsHistorySummary {
  return summary;
}

export interface PresetsHistoryArgs {
  path: string;
  /** Epoch-ms cutoff from --since, or null for the whole file. */
  since: number | null;
  /** Newest N runs to keep, or null for all of them. */
  limit: number | null;
  /** Exit non-zero below this uptime percentage, or null to only report. */
  failUnder: number | null;
}

const SINCE_UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `--since` takes an ISO timestamp or a span measured back from now, e.g. `24h`. */
function parseSince(raw: string, now: number): number {
  const relative = /^(\d+)([smhd])$/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = SINCE_UNITS_MS[relative[2] as keyof typeof SINCE_UNITS_MS];
    return now - amount * unit;
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new PresetsHistoryArgError(
      `--since must be an ISO timestamp or a span like 24h, got "${raw}".`,
    );
  }
  return parsed;
}

export function parsePresetHistoryArgs(
  argv: string[],
  now: number = Date.now(),
): PresetsHistoryArgs {
  let path: string | null = null;
  let since: number | null = null;
  let limit: number | null = null;
  let failUnder: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readValue = (flag: string): string => {
      const value = argv[index + 1];
      if (!value) throw new PresetsHistoryArgError(`${flag} requires a value.`);
      index += 1;
      return value;
    };

    if (arg === "--json") continue;
    if (arg === "--since" || arg.startsWith("--since=")) {
      const value = arg.startsWith("--since=")
        ? arg.slice("--since=".length)
        : readValue("--since");
      if (!value) {
        throw new PresetsHistoryArgError("--since requires a timestamp or a span like 24h.");
      }
      since = parseSince(value, now);
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg.startsWith("--limit=")
        ? arg.slice("--limit=".length)
        : readValue("--limit");
      if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new PresetsHistoryArgError(
          `--limit must be a positive whole number, got "${value}".`,
        );
      }
      limit = Number(value);
    } else if (arg === "--fail-under" || arg.startsWith("--fail-under=")) {
      const value = arg.startsWith("--fail-under=")
        ? arg.slice("--fail-under=".length)
        : readValue("--fail-under");
      const percentage = Number(value);
      if (!/^\d+(\.\d+)?$/.test(value) || percentage > 100) {
        throw new PresetsHistoryArgError(
          `--fail-under must be a percentage from 0 to 100, got "${value}".`,
        );
      }
      failUnder = percentage;
    } else if (arg.startsWith("-")) {
      throw new PresetsHistoryArgError(`unexpected flag "${arg}".`);
    } else if (path !== null) {
      throw new PresetsHistoryArgError("takes a single history file.");
    } else {
      path = arg;
    }
  }

  if (path === null) throw new PresetsHistoryArgError("a history file is required.");
  return { path, since, limit, failUnder };
}

export type { PresetsReport, PresetEndpoint };
