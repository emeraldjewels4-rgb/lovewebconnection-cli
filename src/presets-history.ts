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
  runs: number;
  from: string | null;
  to: string | null;
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

export function summarizePresetHistory(records: PresetHistoryRecord[]): PresetsHistorySummary {
  const ordered = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

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
    from: ordered[0]?.at ?? null,
    to: ordered.at(-1)?.at ?? null,
    healthyRuns,
    failedRuns,
    failoverRuns,
    presets,
  };
}

function stamp(iso: string | null): string {
  return iso === null ? "—" : iso.slice(0, 16).replace("T", " ");
}

export function formatPresetHistory(summary: PresetsHistorySummary): string {
  if (summary.runs === 0) {
    return "lwc — preset health history\n\n  no runs recorded yet; record one with `lwc presets --history <file>`.";
  }

  const lines = [
    "lwc — preset health history",
    "",
    `  runs          ${summary.runs} (${stamp(summary.from)} → ${stamp(summary.to)})`,
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

export function parsePresetHistoryArgs(argv: string[]): { path: string } {
  let path: string | null = null;

  for (const arg of argv) {
    if (arg === "--json") continue;
    if (arg.startsWith("-")) throw new PresetsHistoryArgError(`unexpected flag "${arg}".`);
    if (path !== null) throw new PresetsHistoryArgError("takes a single history file.");
    path = arg;
  }

  if (path === null) throw new PresetsHistoryArgError("a history file is required.");
  return { path };
}

export type { PresetsReport, PresetEndpoint };
