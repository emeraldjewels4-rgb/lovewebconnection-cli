import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { toPresetsJson, type PresetsReport } from "./presets.ts";
import { csvCell } from "./scan.ts";

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

/** The window `--since`, `--until` and `--limit` narrow a history file to. */
export interface PresetsHistorySelection {
  /** Epoch-ms cutoff: keep runs recorded at or after this time. */
  since?: number | null;
  /** Epoch-ms bound: keep runs recorded at or before this time. */
  until?: number | null;
  /** Keep only the newest N runs left inside the window. */
  limit?: number | null;
}

/** What the file the runs came from says about itself. */
export interface PresetsHistoryContext {
  /** Retention declared by the file's header, or null when it declares none. */
  retainMs?: number | null;
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
  /** The applied --until bound in epoch ms, or null. */
  until: number | null;
  /** The applied --limit, or null. */
  limit: number | null;
  healthyRuns: number;
  failedRuns: number;
  failoverRuns: number;
  /** Oldest run in the file, before the window was applied. */
  availableFrom: string | null;
  /** Newest run in the file, before the window was applied. */
  availableTo: string | null;
  /** Retention the source file declares, or null when it declares none. */
  retainMs: number | null;
  presets: PresetHistoryRow[];
}

/** The earlier window `--compare <from>..<to>` reads as the "before" side. */
export interface PresetsHistoryWindow {
  /** Epoch-ms start, inclusive, reusing the --since syntax. */
  since: number;
  /** Epoch-ms end, inclusive, reusing the --until syntax. */
  until: number;
}

/** One preset's uptime on each side of a comparison. */
export interface PresetUptimeChange {
  preset: string;
  chainId: number;
  nativeSymbol: string;
  /** This preset in the earlier window, or null when it was not probed then. */
  before: PresetHistoryRow | null;
  /** This preset in the current window, or null when it was not probed now. */
  after: PresetHistoryRow | null;
  /** Percentage-point change (after − before), or null when a side is missing. */
  deltaPct: number | null;
}

export interface PresetsHistoryComparison {
  /** The earlier window, with the same shape as any other summary. */
  before: PresetsHistorySummary;
  /** The current window (`--since`/`--until`, no `--limit`). */
  after: PresetsHistorySummary;
  /** One row per preset seen on either side, worst regression first. */
  presets: PresetUptimeChange[];
  /** The same comparison pooled per provider host, worst regression first. */
  providers: ProviderUptimeChange[];
}

/** One RPC provider across every preset that probes it in a window. */
export interface ProviderHistoryRow {
  /** Host of the primary endpoint: the provider being judged. */
  host: string;
  /** Preset probes attributed to this provider. */
  probes: number;
  /** Probes this provider's own endpoint answered. */
  healthy: number;
  /** Probes where it failed and a backup answered instead. */
  failovers: number;
  /** Probes where neither endpoint answered. */
  failed: number;
  /** Presets this provider serves in the window, sorted. */
  presets: string[];
  /** Share of probes the provider answered itself; a failover does not count. */
  uptimePct: number;
}

/** One provider's uptime on each side of a comparison. */
export interface ProviderUptimeChange {
  /** Host of the primary endpoint, which identifies the provider. */
  host: string;
  /** This provider in the earlier window, or null when it was not probed then. */
  before: ProviderHistoryRow | null;
  /** This provider in the current window, or null when it is gone now. */
  after: ProviderHistoryRow | null;
  /** Percentage-point change (after − before), or null when a side is missing. */
  deltaPct: number | null;
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

/** A history file's runs plus the retention it was written with. */
export interface PresetHistoryFile {
  records: PresetHistoryRecord[];
  /** Retention span declared in the file's header, or null when it has none. */
  retainMs: number | null;
}

/**
 * Read a history file, oldest first. A truncated or hand-edited line is skipped
 * rather than losing every run that came before it. The first line may be a
 * `lwc_history` header recording the retention the file was trimmed to, so a
 * read that happens later can still explain which runs are simply gone.
 */
export function readPresetHistoryFile(path: string): PresetHistoryFile {
  const records: PresetHistoryRecord[] = [];
  let retainMs: number | null = null;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value !== null && typeof value === "object" && "lwc_history" in value) {
        const header = value.lwc_history as { retainMs?: unknown } | null;
        if (typeof header?.retainMs === "number" && header.retainMs > 0) {
          retainMs = header.retainMs;
        }
        continue;
      }
      const record = value as Partial<PresetHistoryRecord>;
      if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) continue;
      if (typeof record.total !== "number" || !Array.isArray(record.endpoints)) continue;
      records.push(record as PresetHistoryRecord);
    } catch {
      // Malformed line: keep reading.
    }
  }

  return {
    records: records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    retainMs,
  };
}

/** The runs in a history file, oldest first; its retention header is ignored. */
export function readPresetHistory(path: string): PresetHistoryRecord[] {
  return readPresetHistoryFile(path).records;
}

/** The union of several history files, with what the merge had to drop. */
export interface PresetHistoryMerge {
  /** Every run from every input, oldest first, duplicates removed. */
  records: PresetHistoryRecord[];
  /** Runs that appeared in more than one input. */
  duplicates: number;
  /** Runs each input contributed, in the order they were passed. */
  counts: number[];
  /** Runs dropped by the retention window. */
  pruned: number;
}

/**
 * A record's identity for merging, independent of key order: two copies of one
 * run serialise the same fields, while two runs recorded at the same instant
 * with different results stay separate runs.
 */
function recordKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(recordKey).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${recordKey(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Combine history files into one. The cache and the release asset each keep
 * runs the other may have lost, so restore their union instead of whichever
 * file happens to be longer. Identical runs are kept once, oldest first.
 */
/**
 * Warns when a window being read starts before the runs retention kept.
 *
 * A trimmed history looks exactly like a provider that went quiet: the earlier
 * side of a comparison has no runs for it, so its uptime is missing and no
 * regression is reported. Naming the cutoff keeps that silence from being read
 * as an outage.
 */
export function retentionWindowWarnings(
  newestAt: string | null,
  retainMs: number | null,
  windows: Array<{ label: string; since: number | null }>,
): string[] {
  if (newestAt === null || retainMs === null) return [];
  const cutoff = Date.parse(newestAt) - retainMs;
  const retainedFrom = stamp(new Date(cutoff).toISOString());

  return windows
    .filter(
      (window): window is { label: string; since: number } =>
        window.since !== null && window.since < cutoff,
    )
    .map(
      (window) =>
        `${window.label} starts at ${stamp(new Date(window.since).toISOString())}, before the history retention keeps (${retainedFrom}); runs missing from it may have been pruned by --retain, not failed.`,
    );
}

export function mergePresetHistory(
  inputs: PresetHistoryRecord[][],
  options: { retainMs?: number | null } = {},
): PresetHistoryMerge {
  const seen = new Set<string>();
  const records: PresetHistoryRecord[] = [];
  const counts = inputs.map((input) => input.length);

  for (const input of inputs) {
    for (const record of input) {
      const key = recordKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
    }
  }

  records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // The release is the durable copy, not an unbounded one. Retention is
  // measured from the newest run rather than from now, so a paused schedule
  // cannot prune the very record it stopped updating.
  const retainMs = options.retainMs ?? null;
  const newest = records.at(-1);
  const kept =
    retainMs === null || newest === undefined
      ? records
      : records.filter((record) => Date.parse(record.at) >= Date.parse(newest.at) - retainMs);

  return {
    records: kept,
    duplicates: counts.reduce((sum, count) => sum + count, 0) - records.length,
    counts,
    pruned: records.length - kept.length,
  };
}

/**
 * The tightest retention declared by the files being combined. A merge cannot
 * hold runs that one input already pruned, so the union is bounded by the
 * narrowest window rather than the widest.
 */
export function narrowestRetentionMs(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * Write a whole history file, replacing it, and create its directory. A
 * retention window is recorded as the header readPresetHistoryFile returns, so
 * the file itself says what it does not keep.
 */
export function savePresetHistory(
  path: string,
  records: PresetHistoryRecord[],
  options: { retainMs?: number | null } = {},
): void {
  const retainMs = options.retainMs ?? null;
  const header =
    retainMs === null ? "" : `${JSON.stringify({ lwc_history: { v: 1, retainMs } })}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    header + records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
}

/** Nearest-rank percentile, matching the compare and sessions reports. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/**
 * Apply --since/--until/--limit to a history, oldest first. A limit is only
 * ever used to look at recent runs, so it keeps the tail.
 */
export function selectPresetHistory(
  records: PresetHistoryRecord[],
  selection: PresetsHistorySelection = {},
): PresetHistoryRecord[] {
  const since = selection.since ?? null;
  const until = selection.until ?? null;
  const limit = selection.limit ?? null;
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const inRange = sorted.filter((record) => {
    const at = Date.parse(record.at);
    if (since !== null && at < since) return false;
    if (until !== null && at > until) return false;
    return true;
  });
  return limit === null ? inRange : inRange.slice(Math.max(0, inRange.length - limit));
}

/**
 * Attribute each probe to the host of the endpoint the preset is configured
 * with, and pool those by provider: one host that serves several chains is
 * judged once. A failover counts against the provider, because the backup
 * answering is the same fact as the provider under test not answering.
 */
export function summarizeProviderHistory(
  records: PresetHistoryRecord[],
  selection: PresetsHistorySelection = {},
): ProviderHistoryRow[] {
  interface Bucket {
    probes: number;
    healthy: number;
    failovers: number;
    failed: number;
    presets: Set<string>;
  }

  const buckets = new Map<string, Bucket>();

  for (const record of selectPresetHistory(records, selection)) {
    for (const endpoint of record.endpoints) {
      const host = endpoint.primaryHost;
      if (!host) continue;
      const bucket = buckets.get(host) ?? {
        probes: 0,
        healthy: 0,
        failovers: 0,
        failed: 0,
        presets: new Set<string>(),
      };

      bucket.probes += 1;
      bucket.presets.add(endpoint.preset);
      if (!endpoint.ok) bucket.failed += 1;
      else if (endpoint.viaFallback) bucket.failovers += 1;
      else bucket.healthy += 1;

      buckets.set(host, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([host, bucket]): ProviderHistoryRow => ({
      host,
      probes: bucket.probes,
      healthy: bucket.healthy,
      failovers: bucket.failovers,
      failed: bucket.failed,
      presets: [...bucket.presets].sort(),
      uptimePct: round1((bucket.healthy / bucket.probes) * 100),
    }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

export function summarizePresetHistory(
  records: PresetHistoryRecord[],
  selection: PresetsHistorySelection = {},
  context: PresetsHistoryContext = {},
): PresetsHistorySummary {
  const totalRuns = records.length;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const at = Date.parse(record.at);
    if (at < oldest) oldest = at;
    if (at > newest) newest = at;
  }
  const since = selection.since ?? null;
  const until = selection.until ?? null;
  const limit = selection.limit ?? null;
  const ordered = selectPresetHistory(records, selection);

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
    availableFrom: totalRuns === 0 ? null : new Date(oldest).toISOString(),
    availableTo: totalRuns === 0 ? null : new Date(newest).toISOString(),
    retainMs: context.retainMs ?? null,
    since,
    until,
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
    summary.until === null ? null : `until ${stamp(new Date(summary.until).toISOString())}`,
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

/** "from → to" for the whole file, or null when it has no runs. */
function coverageOf(summary: PresetsHistorySummary): string | null {
  return summary.availableFrom === null || summary.availableTo === null
    ? null
    : `${stamp(summary.availableFrom)} → ${stamp(summary.availableTo)}`;
}

/** The date a declared retention cuts at, or null when the file has none. */
function retainedCutoff(summary: PresetsHistorySummary): number | null {
  return summary.retainMs === null || summary.availableTo === null
    ? null
    : Date.parse(summary.availableTo) - summary.retainMs;
}

/** "3 days (nothing older than …)", or null when the file declares none. */
function describeRetention(summary: PresetsHistorySummary): string | null {
  const cutoff = retainedCutoff(summary);
  return summary.retainMs === null || cutoff === null
    ? null
    : `${formatRetention(summary.retainMs)} (nothing older than ${stamp(new Date(cutoff).toISOString())})`;
}

/** A freshness age as the largest whole unit it covers, so `1 day` reads. */
function formatAge(ms: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, name] of units) {
    if (ms >= size) {
      const count = Math.floor(ms / size);
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** A retention span in the largest unit it divides exactly, so `180d` reads. */
function formatRetention(ms: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1000, "second"],
  ];
  for (const [size, name] of units) {
    if (ms % size === 0) {
      const count = ms / size;
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return `${ms} ms`;
}

export function formatPresetHistory(summary: PresetsHistorySummary): string {
  if (summary.runs === 0) {
    if (summary.totalRuns > 0) {
      return [
        "lwc — preset health history",
        "",
        `  no runs in this window (${summary.totalRuns} recorded); widen the window or raise --limit.`,
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
    summary.until === null ? null : `until ${stamp(new Date(summary.until).toISOString())}`,
    summary.limit === null ? null : `last ${summary.limit} runs`,
  ].filter((part): part is string => part !== null);

  // The file's own coverage and the retention it declares, so a windowed or
  // trimmed view says what was left out instead of looking like the whole record.
  const coverage = coverageOf(summary);
  const retained = describeRetention(summary);

  const lines = [
    "lwc — preset health history",
    "",
    `  runs          ${runs} (${stamp(summary.from)} → ${stamp(summary.to)})`,
    ...(summary.runs === summary.totalRuns || coverage === null
      ? []
      : [`  covers        ${coverage} (${summary.totalRuns} recorded)`]),
    ...(window.length === 0 ? [] : [`  window        ${window.join(", ")}`]),
    ...(retained === null ? [] : [`  retained      ${retained}`]),
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

/** One local pass over a history file: the gate plus what the file can cover. */
export interface PresetsHistoryCheck {
  /** The history file the report was made from. */
  path: string;
  /** Runs the gate judged. */
  runs: number;
  /** Presets judged in the window. */
  presets: number;
  /** The whole file's span and recorded count, before the window was applied. */
  coverage: { from: string | null; to: string | null; recorded: number };
  /** The retention the file declares, or null when it declares none. */
  retention: { ms: number; label: string; cutoff: string } | null;
  /** The freshness bound the gate applied, or null when it does not check age. */
  maxAge: { ms: number; label: string } | null;
  /** The newest run's age when it exceeds maxAge, or null when the file is fresh. */
  stale: { newest: string; ageMs: number; age: string } | null;
  /** The filters the gate window applied. */
  window: { since: number | null; until: number | null; limit: number | null };
  gate: { threshold: number; passed: boolean; shortfalls: UptimeShortfall[] };
  /** Why the window may be missing runs retention pruned, or null. */
  note: string | null;
}

/**
 * Build the local check: the gate over the selected window plus the file's
 * coverage and declared retention, so one command answers "did it pass, and
 * what was it able to see?" without a CI run to assemble the pieces.
 */
export function presetHistoryCheck(
  path: string,
  summary: PresetsHistorySummary,
  threshold: number,
  options: { maxAgeMs?: number | null; now?: number } = {},
): PresetsHistoryCheck {
  const gate = summarizePresetGate(summary, threshold);
  const cutoff = retainedCutoff(summary);
  const maxAgeMs = options.maxAgeMs ?? null;
  const now = options.now ?? Date.now();
  // Retention is anchored to the newest run, but freshness cannot be: the gate
  // has to know how long ago that run happened, or a file nobody appends to
  // would keep passing on week-old evidence.
  const newest = summary.availableTo;
  const ageMs =
    maxAgeMs === null || newest === null ? null : Math.max(0, now - Date.parse(newest));
  const stale =
    maxAgeMs !== null && newest !== null && ageMs !== null && ageMs > maxAgeMs
      ? { newest, ageMs, age: formatAge(ageMs) }
      : null;

  return {
    path,
    runs: summary.runs,
    presets: summary.presets.length,
    coverage: {
      from: summary.availableFrom,
      to: summary.availableTo,
      recorded: summary.totalRuns,
    },
    retention:
      summary.retainMs === null || cutoff === null
        ? null
        : {
            ms: summary.retainMs,
            label: formatRetention(summary.retainMs),
            cutoff: new Date(cutoff).toISOString(),
          },
    maxAge: maxAgeMs === null ? null : { ms: maxAgeMs, label: formatRetention(maxAgeMs) },
    stale,
    window: { since: summary.since, until: summary.until, limit: summary.limit },
    gate: { threshold, passed: gate.passed && stale === null, shortfalls: gate.shortfalls },
    note:
      cutoff !== null && summary.since !== null && summary.since < cutoff
        ? `the window starts ${stamp(new Date(summary.since).toISOString())}, before the retained history (${stamp(new Date(cutoff).toISOString())}); missing runs may have been pruned, not failed.`
        : null,
  };
}

/**
 * One line per reason the check failed, in the order the report reads: a stale
 * file first, then an empty window, then each preset below the threshold. The
 * pre-commit hook prints these and CI annotates them, so both say the same
 * thing without copying the wording.
 */
export function presetHistoryFailureReasons(check: PresetsHistoryCheck): string[] {
  const reasons: string[] = [];
  if (check.stale !== null) {
    reasons.push(
      `newest run ${check.stale.newest} is ${check.stale.age} old, past the ${check.maxAge?.label ?? "maximum"} maximum.`,
    );
  }
  if (check.runs === 0) {
    reasons.push(
      `no runs in the window (${check.coverage.recorded} recorded), so ${check.gate.threshold}% cannot be verified.`,
    );
  } else {
    for (const row of check.gate.shortfalls) {
      reasons.push(
        `${row.preset} uptime ${row.uptimePct}% over ${row.runs} run${row.runs === 1 ? "" : "s"} is below ${check.gate.threshold}%.`,
      );
    }
  }
  return reasons;
}

interface PresetFreshnessRow {
  at: string;
  age: string;
  presets: number;
  failed: number;
}

/**
 * The newest runs with their age, newest first, or null when there is no bound
 * to report or nothing recorded. Both the CI table and the hook report read
 * this one list, so their rows cannot disagree.
 */
function freshnessRows(
  check: PresetsHistoryCheck,
  records: readonly PresetHistoryRecord[],
  options: { now?: number; limit?: number } = {},
): { rows: PresetFreshnessRow[]; total: number; newestAge: string } | null {
  if (check.maxAge === null || records.length === 0) return null;
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 5;
  const newestFirst = records
    .map((entry) => ({ entry, at: Date.parse(entry.at) }))
    .sort((left, right) => right.at - left.at);
  const newest = newestFirst[0];
  if (newest === undefined) return null;
  return {
    rows: newestFirst.slice(0, limit).map(({ entry, at }) => ({
      at: stamp(entry.at),
      age: formatAge(Math.max(0, now - at)),
      presets: entry.endpoints.length,
      failed: entry.failed,
    })),
    total: newestFirst.length,
    newestAge: formatAge(Math.max(0, now - newest.at)),
  };
}

/**
 * The newest runs with their age, as a markdown table for the CI summary. A
 * verdict line cannot show that every row is old; a table can. The gate uses it
 * only for a stale file, but the table reports either verdict so the wording
 * lives in one tested place.
 */
export function presetFreshnessMarkdown(
  check: PresetsHistoryCheck,
  records: readonly PresetHistoryRecord[],
  options: { now?: number; limit?: number } = {},
): string | null {
  const maxAge = check.maxAge;
  const freshness = freshnessRows(check, records, options);
  if (maxAge === null || freshness === null) return null;
  const staleAge = check.stale?.age ?? null;
  const lines = [
    `### Preset freshness — ${staleAge === null ? "PASS" : "FAIL"}`,
    "",
    "| Newest runs (UTC) | Age | Presets | Failed |",
    "| --- | --- | --- | --- |",
    ...freshness.rows.map(
      (row) => `| ${row.at} | ${row.age} | ${row.presets} | ${row.failed} |`,
    ),
    "",
    staleAge === null
      ? `Newest recorded run is ${freshness.newestAge} old, within the ${maxAge.label} maximum.`
      : `Newest recorded run is ${staleAge} old, past the ${maxAge.label} maximum, so the gate fails on freshness alone.`,
  ];
  if (freshness.rows.length < freshness.total) {
    lines.push(
      `Showing the newest ${freshness.rows.length} of ${freshness.total} recorded runs.`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the local check as one aligned pass, ending in the verdict. Passing the
 * records replaces the single stale line with the newest runs and their age, so
 * a stopped schedule is visible row by row (five by default, or `rows`); without
 * them the summary line stays.
 */
export function formatPresetHistoryCheck(
  check: PresetsHistoryCheck,
  records?: readonly PresetHistoryRecord[],
  options: { rows?: number } = {},
): string {
  const field = (label: string, value: string): string => `  ${label.padEnd(9)}${value}`;
  const { coverage, retention, gate, window: applied } = check;
  const runs =
    check.runs === 0
      ? `no runs (${coverage.recorded} recorded)`
      : `${check.runs} run${check.runs === 1 ? "" : "s"}`;
  const lines = ["lwc — preset health check", "", field("file", check.path), field("runs", runs)];

  if (coverage.from !== null && coverage.to !== null) {
    lines.push(
      field(
        "covers",
        `${stamp(coverage.from)} → ${stamp(coverage.to)} (${coverage.recorded} recorded)`,
      ),
    );
  }
  const filters = [
    applied.since === null ? null : `since ${stamp(new Date(applied.since).toISOString())}`,
    applied.until === null ? null : `until ${stamp(new Date(applied.until).toISOString())}`,
    applied.limit === null ? null : `newest ${applied.limit}`,
  ].filter((part): part is string => part !== null);
  if (filters.length > 0) lines.push(field("window", filters.join(", ")));
  if (retention !== null) {
    lines.push(
      field("retained", `${retention.label} (nothing older than ${stamp(retention.cutoff)})`),
    );
  }
  if (check.note !== null) lines.push(field("note", check.note));
  if (check.maxAge !== null) lines.push(field("max age", check.maxAge.label));
  if (check.stale !== null && check.maxAge !== null) {
    // Anchor the rows to the same instant the check judged, so the table's newest
    // age is the age the verdict used rather than a few milliseconds later.
    const freshness = freshnessRows(check, records ?? [], {
      now: Date.parse(check.stale.newest) + check.stale.ageMs,
      limit: options.rows,
    });
    if (freshness === null) {
      lines.push(
        field(
          "stale",
          `newest run ${stamp(check.stale.newest)} is ${check.stale.age} old, past the ${check.maxAge.label} maximum.`,
        ),
      );
    } else {
      lines.push(
        field("newest", `${check.stale.age} old, past the ${check.maxAge.label} maximum.`),
        `  freshness newest first`,
      );
      for (const row of freshness.rows) {
        lines.push(
          `    ${row.at.padEnd(17)}${row.age.padEnd(9)}${row.presets} preset${row.presets === 1 ? "" : "s"}, ${row.failed} failed`,
        );
      }
      if (freshness.rows.length < freshness.total) {
        lines.push(
          `    showing the newest ${freshness.rows.length} of ${freshness.total} recorded runs`,
        );
      }
    }
  }

  if (check.runs === 0) {
    lines.push(
      field(
        "gate",
        `FAIL — no runs in the window (${coverage.recorded} recorded), so ${gate.threshold}% cannot be verified.`,
      ),
    );
    return lines.join("\n");
  }
  if (gate.passed) {
    const presets = `${check.presets} preset${check.presets === 1 ? "" : "s"}`;
    lines.push(
      field("gate", `PASS — all ${presets} stayed at or above ${gate.threshold}% across ${runs}.`),
    );
    return lines.join("\n");
  }

  if (gate.shortfalls.length === 0) {
    // Freshness is the only reason left: every preset cleared the threshold,
    // but the newest run is too old for that verdict to cover today.
    lines.push(field("gate", "FAIL — newest run is past the maximum age, so there is nothing fresh to judge."));
    return lines.join("\n");
  }

  if (gate.shortfalls.length === 0) {
    // Freshness is the only reason left: every preset cleared the threshold,
    // but the newest run is too old for that verdict to cover today.
    lines.push(
      field("gate", "FAIL — newest run is past the maximum age, so there is nothing fresh to judge."),
    );
    return lines.join("\n");
  }

  const below = gate.shortfalls.length;
  lines.push(
    field(
      "gate",
      `FAIL — ${below} preset${below === 1 ? "" : "s"} below ${gate.threshold}% across ${runs}.`,
    ),
    "",
  );
  const rows = gate.shortfalls.map((row) => [
    row.preset,
    String(row.chainId),
    String(row.runs),
    `${row.uptimePct}%`,
    String(row.failed),
  ]);
  const headers = ["preset", "chain", "runs", "uptime", "failed"];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]!.length)),
  );
  const table = (cells: string[]): string =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}`;

  lines.push(table(headers), ...rows.map(table));
  return lines.join("\n");
}

/**
 * Judge a provider change by reading the same presets in two windows: the
 * current one from the usual filters, and an explicit earlier one. Both sides
 * are ordinary summaries, so a delta cannot disagree with either table.
 */
export function comparePresetHistory(
  records: PresetHistoryRecord[],
  selection: PresetsHistorySelection,
  compare: PresetsHistoryWindow,
  context: PresetsHistoryContext = {},
): PresetsHistoryComparison {
  const after = summarizePresetHistory(records, selection, context);
  const before = summarizePresetHistory(
    records,
    { since: compare.since, until: compare.until },
    context,
  );
  const earlier = new Map(before.presets.map((row) => [row.preset, row]));
  const later = new Map(after.presets.map((row) => [row.preset, row]));
  const names = [...new Set([...earlier.keys(), ...later.keys()])];

  const presets = names
    .map((preset): PresetUptimeChange => {
      const was = earlier.get(preset) ?? null;
      const now = later.get(preset) ?? null;
      const known = (now ?? was)!;
      return {
        preset,
        chainId: known.chainId,
        nativeSymbol: known.nativeSymbol,
        before: was,
        after: now,
        deltaPct: was === null || now === null ? null : round1(now.uptimePct - was.uptimePct),
      };
    })
    // A regression is what a provider change is judged on, so it reads first.
    // Presets only present on one side have no delta and close the table.
    .sort((a, b) => {
      if (a.deltaPct === null || b.deltaPct === null) {
        if (a.deltaPct !== b.deltaPct) return a.deltaPct === null ? 1 : -1;
        return a.preset.localeCompare(b.preset);
      }
      return a.deltaPct - b.deltaPct || a.preset.localeCompare(b.preset);
    });

  const providers = compareProviders(
    summarizeProviderHistory(records, { since: compare.since, until: compare.until }),
    summarizeProviderHistory(records, selection),
  );

  return { before, after, presets, providers };
}

/** Pair two provider windows by host, listing a fall first, as presets do. */
function compareProviders(
  earlier: ProviderHistoryRow[],
  later: ProviderHistoryRow[],
): ProviderUptimeChange[] {
  const was = new Map(earlier.map((row) => [row.host, row]));
  const now = new Map(later.map((row) => [row.host, row]));
  const hosts = [...new Set([...was.keys(), ...now.keys()])];

  return hosts
    .map((host): ProviderUptimeChange => {
      const before = was.get(host) ?? null;
      const after = now.get(host) ?? null;
      return {
        host,
        before,
        after,
        deltaPct: before === null || after === null ? null : round1(after.uptimePct - before.uptimePct),
      };
    })
    .sort((a, b) => {
      if (a.deltaPct === null || b.deltaPct === null) {
        if (a.deltaPct !== b.deltaPct) return a.deltaPct === null ? 1 : -1;
        return a.host.localeCompare(b.host);
      }
      return a.deltaPct - b.deltaPct || a.host.localeCompare(b.host);
    });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A percentage-point change with its sign, so an improvement reads as one. */
function pp(value: number): string {
  const rounded = round1(value);
  if (rounded === 0) return "0pp";
  return `${rounded > 0 ? "+" : ""}${rounded}pp`;
}

/** Overall uptime of a window to one decimal, or null when it has no runs. */
function windowUptime(summary: PresetsHistorySummary): number | null {
  return summary.runs === 0 ? null : round1((summary.healthyRuns / summary.runs) * 100);
}

export function formatPresetHistoryComparison(comparison: PresetsHistoryComparison): string {
  const { before, after } = comparison;
  const lines = ["lwc — preset health comparison", ""];

  const describe = (label: string, summary: PresetsHistorySummary): string => {
    const uptime = windowUptime(summary);
    if (uptime === null) {
      return `  ${label.padEnd(9)}no runs (${summary.totalRuns} recorded)`;
    }
    const runs = `${summary.runs} run${summary.runs === 1 ? "" : "s"}`;
    return `  ${label.padEnd(9)}${runs} (${stamp(summary.from)} → ${stamp(summary.to)}), uptime ${uptime}%`;
  };

  lines.push(describe("before", before), describe("after", after));

  // The file's coverage and declared retention, and a warning when the earlier
  // window starts before the retained history: without it a short before side
  // reads as a provider fading out rather than as a trim.
  const coverage = coverageOf(after);
  const retained = describeRetention(after);
  const cutoff = retainedCutoff(after);
  if (coverage !== null) {
    lines.push(`  ${"covers".padEnd(9)}${coverage} (${after.totalRuns} recorded)`);
  }
  if (retained !== null) {
    lines.push(`  ${"retained".padEnd(9)}${retained}`);
  }
  if (cutoff !== null && before.since !== null && before.since < cutoff) {
    lines.push(
      `  ${"note".padEnd(9)}the earlier window starts ${stamp(new Date(before.since).toISOString())}, before the retained history (${stamp(new Date(cutoff).toISOString())}), so its delta only covers the runs that remain.`,
    );
  }

  if (after.runs === 0) {
    lines.push("", "  no runs in the current window; widen the window and try again.");
    return lines.join("\n");
  }

  const earlierUptime = windowUptime(before);
  const overall = earlierUptime === null ? null : round1((windowUptime(after) ?? 0) - earlierUptime);
  const changes: string[] = [];
  if (overall !== null) changes.push(`${pp(overall)} overall`);
  const worse = comparison.presets.filter((row) => row.deltaPct !== null && row.deltaPct < 0).length;
  const better = comparison.presets.filter((row) => row.deltaPct !== null && row.deltaPct > 0).length;
  if (worse > 0) changes.push(`${worse} preset${worse === 1 ? "" : "s"} worse`);
  if (better > 0) changes.push(`${better} better`);
  lines.push(`  ${"change".padEnd(9)}${changes.length === 0 ? "—" : changes.join(", ")}`, "");

  const rows = comparison.presets.map((row) => [
    row.preset,
    String(row.chainId),
    row.before === null ? "—" : String(row.before.runs),
    row.before === null ? "—" : `${row.before.uptimePct}%`,
    row.after === null ? "—" : String(row.after.runs),
    row.after === null ? "—" : `${row.after.uptimePct}%`,
    row.deltaPct === null ? "—" : pp(row.deltaPct),
  ]);
  const headers = [
    "preset",
    "chain",
    "before runs",
    "before uptime",
    "after runs",
    "after uptime",
    "change",
  ];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]): string =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}`;

  lines.push(line(headers), ...rows.map(line));
  return lines.join("\n");
}

/** Table cells in a CI summary cannot hold pipes or newlines. */
function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Markdown for a CI run summary: the current window beside an earlier one, so
 * a scheduled run reports the week-over-week delta without anyone asking.
 */
export function presetComparisonMarkdown(
  comparison: PresetsHistoryComparison,
  heading = "Preset comparison",
): string {
  const { before, after } = comparison;
  const lines = [`### ${heading}`, ""];
  const coverage = coverageOf(after);
  const retained = describeRetention(after);
  const cutoff = retainedCutoff(after);
  const short = cutoff !== null && before.since !== null && before.since < cutoff;
  const span = (summary: PresetsHistorySummary): string =>
    summary.runs === 0
      ? `no runs (${summary.totalRuns} recorded)`
      : `${summary.runs} run${summary.runs === 1 ? "" : "s"} (${stamp(summary.from)} → ${stamp(summary.to)})`;
  // What the file holds is true of every branch, including the ones with no
  // earlier runs to compare against.
  const facts = [
    ...(coverage === null ? [] : [`Coverage: ${coverage} (${after.totalRuns} recorded).`]),
    ...(retained === null ? [] : [`Retained: ${retained}.`]),
  ];

  if (after.runs === 0) {
    lines.push(
      `**No runs in the current window** — ${span(after)}; nothing to compare.`,
      ...facts,
    );
    return lines.join("\n");
  }

  if (before.runs === 0) {
    lines.push(
      `**No earlier runs to compare against** — ${span(before)}; the current window is ${span(after)}.`,
      ...facts,
      ...(short && cutoff !== null
        ? [
            `The earlier window starts before the retained history (${stamp(new Date(cutoff).toISOString())}), so its runs may have been pruned rather than missing.`,
          ]
        : []),
    );
    return lines.join("\n");
  }

  const regressions = comparison.presets.filter((row) => row.deltaPct !== null && row.deltaPct < 0);
  const improvements = comparison.presets.filter((row) => row.deltaPct !== null && row.deltaPct > 0);
  const overall = round1((windowUptime(after) ?? 0) - (windowUptime(before) ?? 0));

  lines.push(
    `**${regressions.length} regressed, ${improvements.length} improved** across ${comparison.presets.length} preset${comparison.presets.length === 1 ? "" : "s"}.`,
    "",
    `Earlier: ${span(before)} — current: ${span(after)}. Overall uptime ${pp(overall)}.`,
    ...facts,
    ...(short && cutoff !== null
      ? [
          `The earlier window starts before the retained history (${stamp(new Date(cutoff).toISOString())}), so its delta only covers the runs that remain.`,
        ]
      : []),
    "",
    "| preset | chain | before runs | before uptime | after runs | after uptime | change |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...comparison.presets.map((row) => {
      const beforeRuns = row.before === null ? "—" : String(row.before.runs);
      const beforeUptime = row.before === null ? "—" : `${row.before.uptimePct}%`;
      const afterRuns = row.after === null ? "—" : String(row.after.runs);
      const afterUptime = row.after === null ? "—" : `${row.after.uptimePct}%`;
      const change = row.deltaPct === null ? "—" : pp(row.deltaPct);
      return `| \`${mdCell(row.preset)}\` | ${row.chainId} | ${beforeRuns} | ${beforeUptime} | ${afterRuns} | ${afterUptime} | ${change} |`;
    }),
  );

  return lines.join("\n");
}

/**
 * One line per preset whose uptime fell, worst first, for a CI annotation. A
 * provider change that looks fine in this week's numbers still shows up here if
 * it made any preset worse than the week it replaced.
 */
export function presetRegressionWarnings(comparison: PresetsHistoryComparison): string[] {
  const line = (row: PresetUptimeChange): string | null => {
    if (row.deltaPct === null || row.deltaPct >= 0 || row.before === null || row.after === null) {
      return null;
    }
    const runs = (count: number): string => `${count} run${count === 1 ? "" : "s"}`;
    return `${row.preset} uptime ${pp(row.deltaPct)}: ${row.before.uptimePct}% over ${runs(row.before.runs)} → ${row.after.uptimePct}% over ${runs(row.after.runs)}`;
  };

  return comparison.presets
    .map(line)
    .filter((value): value is string => value !== null);
}

/**
 * One line per provider host whose uptime fell, worst first. The same week can
 * regress several presets for one reason; this names the upstream once, so the
 * run log says which provider got worse rather than only which chains did.
 */
export function providerRegressionWarnings(comparison: PresetsHistoryComparison): string[] {
  const line = (row: ProviderUptimeChange): string | null => {
    if (row.deltaPct === null || row.deltaPct >= 0 || row.before === null || row.after === null) {
      return null;
    }
    const probes = (count: number): string => `${count} probe${count === 1 ? "" : "s"}`;
    return `${row.host} uptime ${pp(row.deltaPct)}: ${row.before.uptimePct}% over ${probes(row.before.probes)} → ${row.after.uptimePct}% over ${probes(row.after.probes)}`;
  };

  return comparison.providers
    .map(line)
    .filter((value): value is string => value !== null);
}

export function toPresetHistoryJson(summary: PresetsHistorySummary): PresetsHistorySummary {
  return summary;
}

/** One CSV row per preset in the window, for charting uptime and latency. */
export function presetHistoryCsv(summary: PresetsHistorySummary): string {
  const header = [
    "preset",
    "chain",
    "native",
    "runs",
    "healthy",
    "failed",
    "failovers",
    "uptime_pct",
    "p50_latency_ms",
    "max_latency_ms",
    "last_run",
    "last_failure",
  ];
  const rows = summary.presets.map((row) => [
    csvCell(row.preset),
    String(row.chainId),
    csvCell(row.nativeSymbol),
    String(row.runs),
    String(row.healthy),
    String(row.failed),
    String(row.failovers),
    String(row.uptimePct),
    row.p50LatencyMs === null ? "" : String(row.p50LatencyMs),
    row.maxLatencyMs === null ? "" : String(row.maxLatencyMs),
    row.lastAt ?? "",
    row.lastFailureAt ?? "",
  ]);

  return [header.join(","), ...rows.map((cells) => cells.join(","))].join("\n");
}

/** Write the CSV to a file, creating its directory. */
export function savePresetHistoryCsv(path: string, csv: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${csv}\n`);
}

/**
 * One CSV row per preset per run, oldest first, for charting health over time
 * rather than summarizing it: a failure keeps its latency and via cells blank.
 */
export function presetHistoryTimelineCsv(
  records: PresetHistoryRecord[],
  selection: PresetsHistorySelection = {},
): string {
  const header = [
    "at",
    "preset",
    "chain",
    "native",
    "ok",
    "via",
    "latency_ms",
    "block_number",
    "rpc_host",
    "error",
    "primary_error",
  ];
  const rows = selectPresetHistory(records, selection).flatMap((record) =>
    record.endpoints.map((endpoint) => [
      record.at,
      csvCell(endpoint.preset),
      String(endpoint.chainId),
      csvCell(endpoint.nativeSymbol),
      endpoint.ok ? "true" : "false",
      endpoint.ok ? (endpoint.viaFallback ? "backup" : "primary") : "",
      endpoint.latencyMs === null ? "" : String(endpoint.latencyMs),
      endpoint.blockNumber ?? "",
      csvCell(endpoint.rpcHost),
      csvCell(endpoint.error ?? ""),
      csvCell(endpoint.primaryError ?? ""),
    ]),
  );

  return [header.join(","), ...rows.map((cells) => cells.join(","))].join("\n");
}

export interface PresetsHistoryArgs {
  path: string;
  /** Epoch-ms cutoff from --since, or null for the whole file. */
  since: number | null;
  /** Epoch-ms bound from --until, or null to keep everything after --since. */
  until: number | null;
  /** Newest N runs to keep, or null for all of them. */
  limit: number | null;
  /** Exit non-zero below this uptime percentage, or null to only report. */
  failUnder: number | null;
  /** Where to write the per-preset CSV, "-" for stdout, or null for the table. */
  csvPath: string | null;
  /** Where to write the per-run timeline CSV, "-" for stdout, or null. */
  timelinePath: string | null;
  /** The earlier window from --compare, or null to report one window. */
  compare: PresetsHistoryWindow | null;
  /** Extra history files from --merge, folded into `path` before anything reads it. */
  merge: string[];
  /** Where --out writes the merged history, or null to only read it. */
  out: string | null;
  /** Epoch-ms retention window for the merge from --retain, or null to keep everything. */
  retain: number | null;
  /** Epoch-ms freshness bound from --max-age, or null to judge the gate on uptime alone. */
  maxAge: number | null;
  /** Rows the stale report prints from --freshness-rows, or null for the default. */
  freshnessRows: number | null;
  /** Report the file's coverage and retention beside the gate in one local pass. */
  check: boolean;
}

const SINCE_UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * A window bound: an ISO timestamp, or a span measured back from now (`24h`),
 * so `--since 7d --until 1d` keeps the week before yesterday.
 */
function parseBound(raw: string, now: number, flag: string): number {
  const relative = /^(\d+)([smhd])$/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = SINCE_UNITS_MS[relative[2] as keyof typeof SINCE_UNITS_MS];
    return now - amount * unit;
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new PresetsHistoryArgError(
      `${flag} must be an ISO timestamp or a span like 24h, got "${raw}".`,
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
  let until: number | null = null;
  let limit: number | null = null;
  let failUnder: number | null = null;
  let csvPath: string | null = null;
  let timelinePath: string | null = null;
  let compare: PresetsHistoryWindow | null = null;
  const merge: string[] = [];
  let out: string | null = null;
  let retain: number | null = null;
  let maxAge: number | null = null;
  let freshnessRows: number | null = null;
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readValue = (flag: string): string => {
      const value = argv[index + 1];
      if (!value) throw new PresetsHistoryArgError(`${flag} requires a value.`);
      index += 1;
      return value;
    };

    if (arg === "--json") continue;
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--since" || arg.startsWith("--since=")) {
      const value = arg.startsWith("--since=")
        ? arg.slice("--since=".length)
        : readValue("--since");
      if (!value) {
        throw new PresetsHistoryArgError("--since requires a timestamp or a span like 24h.");
      }
      since = parseBound(value, now, "--since");
    } else if (arg === "--until" || arg.startsWith("--until=")) {
      const value = arg.startsWith("--until=")
        ? arg.slice("--until=".length)
        : readValue("--until");
      if (!value) {
        throw new PresetsHistoryArgError("--until requires a timestamp or a span like 24h.");
      }
      until = parseBound(value, now, "--until");
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
    } else if (arg === "--csv" || arg.startsWith("--csv=")) {
      const inline = arg.startsWith("--csv=") ? arg.slice("--csv=".length) : null;
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      if (!value) throw new PresetsHistoryArgError("--csv requires a path, or - for stdout.");
      csvPath = value;
    } else if (arg === "--timeline" || arg.startsWith("--timeline=")) {
      const inline = arg.startsWith("--timeline=") ? arg.slice("--timeline=".length) : null;
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      if (!value) {
        throw new PresetsHistoryArgError("--timeline requires a path, or - for stdout.");
      }
      timelinePath = value;
    } else if (arg === "--compare" || arg.startsWith("--compare=")) {
      const inline = arg.startsWith("--compare=") ? arg.slice("--compare=".length) : null;
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      if (!value) throw new PresetsHistoryArgError("--compare requires a window like 14d..7d.");
      const parts = value.split("..");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new PresetsHistoryArgError(
          `--compare must be a window like 14d..7d, got "${value}".`,
        );
      }
      const from = parseBound(parts[0], now, "--compare");
      const to = parseBound(parts[1], now, "--compare");
      if (to < from) throw new PresetsHistoryArgError("--compare must start before it ends.");
      compare = { since: from, until: to };
    } else if (arg === "--merge" || arg.startsWith("--merge=")) {
      const inline = arg.startsWith("--merge=") ? arg.slice("--merge=".length) : null;
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      if (!value) {
        throw new PresetsHistoryArgError("--merge requires a history file to fold in.");
      }
      merge.push(value);
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const inline = arg.startsWith("--out=") ? arg.slice("--out=".length) : null;
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      if (!value) {
        throw new PresetsHistoryArgError("--out requires a path for the merged history.");
      }
      if (value === "-") {
        throw new PresetsHistoryArgError(
          "--out writes history JSONL, so it needs a file path; - is already the table's output.",
        );
      }
      out = value;
    } else if (arg === "--retain" || arg.startsWith("--retain=")) {
      const inline = arg.startsWith("--retain=") ? arg.slice("--retain=".length) : null;
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      retain = parseRetentionMs(value);
    } else if (arg === "--max-age" || arg.startsWith("--max-age=")) {
      const inline = arg.startsWith("--max-age=") ? arg.slice("--max-age=".length) : null;
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      maxAge = parseMaxAgeMs(value);
    } else if (arg === "--freshness-rows" || arg.startsWith("--freshness-rows=")) {
      const inline = arg.startsWith("--freshness-rows=")
        ? arg.slice("--freshness-rows=".length)
        : null;
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      freshnessRows = parseFreshnessRows(value);
    } else if (arg.startsWith("-")) {
      throw new PresetsHistoryArgError(`unexpected flag "${arg}".`);
    } else if (path !== null) {
      throw new PresetsHistoryArgError("takes a single history file.");
    } else {
      path = arg;
    }
  }

  if (path === null) throw new PresetsHistoryArgError("a history file is required.");
  if (since !== null && until !== null && until < since) {
    throw new PresetsHistoryArgError("--until must not be earlier than --since.");
  }
  if (csvPath !== null && timelinePath !== null) {
    throw new PresetsHistoryArgError("--csv and --timeline are different exports; pass one.");
  }
  if (out !== null && merge.length === 0) {
    throw new PresetsHistoryArgError(
      "--out writes the combined history, so pass at least one --merge <file>.",
    );
  }
  if (retain !== null && merge.length === 0) {
    throw new PresetsHistoryArgError(
      "--retain bounds the combined history, so pass at least one --merge <file>.",
    );
  }
  if (maxAge !== null && !check) {
    throw new PresetsHistoryArgError("--max-age bounds the gate, so pass --check with it.");
  }
  if (freshnessRows !== null && !check) {
    throw new PresetsHistoryArgError(
      "--freshness-rows shapes the check report, so pass --check with it.",
    );
  }
  if (check) {
    // The check report is the output, so an export has nowhere to go, and a
    // comparison is a different report rather than part of this one.
    if (failUnder === null) {
      throw new PresetsHistoryArgError(
        "--check reports a gate, so pass --fail-under <pct> with it.",
      );
    }
    if (csvPath !== null || timelinePath !== null) {
      throw new PresetsHistoryArgError("--check cannot be combined with --csv or --timeline.");
    }
    if (compare !== null) {
      throw new PresetsHistoryArgError("--check reports one window; use --compare without it.");
    }
  }
  if (compare !== null) {
    if (csvPath !== null || timelinePath !== null) {
      throw new PresetsHistoryArgError("--compare cannot be combined with --csv or --timeline.");
    }
    if (limit !== null) {
      throw new PresetsHistoryArgError("--compare cannot be combined with --limit.");
    }
    // The two windows have to be tellable apart, so the current one needs a
    // start and the earlier one has to end before it.
    if (since === null) {
      throw new PresetsHistoryArgError(
        "--compare needs --since to mark where the current window starts.",
      );
    }
    if (compare.until > since) {
      throw new PresetsHistoryArgError("--compare must end at or before --since.");
    }
  }
  return {
    path,
    since,
    until,
    limit,
    failUnder,
    csvPath,
    timelinePath,
    compare,
    merge,
    out,
    retain,
    maxAge,
    freshnessRows,
    check,
  };
}

/** A retention window as a positive span (`180d`), for --retain and the CI merge. */
export function parseRetentionMs(raw: string): number {
  const match = /^([1-9]\d*)([smhd])$/.exec(raw.trim());
  if (!match) {
    throw new PresetsHistoryArgError(
      `--retain must be a positive span like 180d, got "${raw}".`,
    );
  }
  const unit = SINCE_UNITS_MS[match[2] as keyof typeof SINCE_UNITS_MS];
  return Number(match[1]) * unit;
}

/** A freshness row count as a positive whole number (`5`), for --freshness-rows. */
export function parseFreshnessRows(raw: string): number {
  const match = /^([1-9]\d*)$/.exec(raw.trim());
  if (!match) {
    throw new PresetsHistoryArgError(
      `--freshness-rows must be a positive whole number like 5, got "${raw}".`,
    );
  }
  return Number(match[1]);
}

/** A freshness bound as a positive span (`7d`), for --max-age. */
export function parseMaxAgeMs(raw: string): number {
  const match = /^([1-9]\d*)([smhd])$/.exec(raw.trim());
  if (!match) {
    throw new PresetsHistoryArgError(
      `--max-age must be a positive span like 7d, got "${raw}".`,
    );
  }
  const unit = SINCE_UNITS_MS[match[2] as keyof typeof SINCE_UNITS_MS];
  return Number(match[1]) * unit;
}

export type { PresetsReport, PresetEndpoint };
