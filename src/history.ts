import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Address } from "viem";

import { formatTokenAmount, shortAddress } from "./balances.ts";
import { csvCell } from "./scan.ts";

export class HistoryArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryArgError";
  }
}

export interface HistoryArgs {
  /** Watch log to read. */
  path: string;
  /** Where to write CSV, "-" for stdout, or null for the table. */
  csvPath: string | null;
  /** Only rows from this session id. */
  session: string | null;
  /** Pivot to one column per asset instead of one row per asset. */
  wide: boolean;
  /** Add a USD value column per asset to the wide CSV. */
  usd: boolean;
  /** Emit only the USD-valued asset columns, dropping the raw balances. */
  usdOnly: boolean;
}

export function parseHistoryArgs(argv: string[]): HistoryArgs {
  const positional: string[] = [];
  let csvPath: string | null = null;
  let session: string | null = null;
  let wide = false;
  let usd = false;
  let usdOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--csv") {
      const value = argv[index + 1];
      if (!value || (value.startsWith("-") && value !== "-")) {
        throw new HistoryArgError("--csv requires a path, or - for stdout.");
      }
      csvPath = value;
      index += 1;
    } else if (arg.startsWith("--csv=")) {
      const value = arg.slice("--csv=".length);
      if (!value) throw new HistoryArgError("--csv requires a path, or - for stdout.");
      csvPath = value;
    } else if (arg === "--wide") {
      wide = true;
    } else if (arg === "--usd") {
      usd = true;
    } else if (arg === "--usd-only") {
      usdOnly = true;
    } else if (arg === "--session") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new HistoryArgError("--session requires an id.");
      session = value;
      index += 1;
    } else if (arg.startsWith("--session=")) {
      const value = arg.slice("--session=".length);
      if (!value) throw new HistoryArgError("--session requires an id.");
      session = value;
    } else if (arg.startsWith("-")) {
      continue; // --json and other global flags are handled by the CLI.
    } else {
      positional.push(arg);
    }
  }

  const [path] = positional;
  if (!path) {
    throw new HistoryArgError(
      "A watch log path is required: lwc history <log.ndjson> [--csv out.csv]",
    );
  }
  if (positional.length > 1) {
    throw new HistoryArgError(`Unexpected extra argument: ${positional[1]}.`);
  }
  if (wide && csvPath === null) {
    throw new HistoryArgError("--wide needs CSV output: use --csv <path> or --csv -.");
  }
  if (usd && !wide) {
    throw new HistoryArgError("--usd needs --wide so there are asset columns to value.");
  }
  if (usdOnly && !wide) {
    throw new HistoryArgError("--usd-only needs --wide so there is a pivot to value.");
  }

  return { path, csvPath, session, wide, usd, usdOnly };
}

export function readHistoryLog(path: string): string {
  if (!existsSync(path)) {
    throw new HistoryArgError(`watch log not found: ${path}`);
  }
  return readFileSync(path, "utf8");
}

export interface HistoryRow {
  session: string;
  /** Epoch milliseconds of the portfolio sample. */
  at: number;
  blockNumber: bigint | null;
  asset: "native" | "token";
  /** Token address, or null for the native balance. */
  address: Address | null;
  symbol: string;
  label: string | null;
  decimals: number | null;
  balance: bigint | null;
  /** Change since the previous sample; null for the first one. */
  delta: bigint | null;
  /** USD value at the sample's prices; null when the asset was not priced. */
  usd: number | null;
  /** Total of the priced holdings for this sample; null when nothing was priced. */
  usdTotal: number | null;
}

export interface HistoryReport {
  path: string;
  rows: HistoryRow[];
  /** Sessions that contributed rows, in log order. */
  sessions: string[];
  /** Portfolio samples that carried an error and no balances. */
  skippedSamples: number;
  /** Lines that were not JSON objects with a session id. */
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
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function timeField(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Turn the `portfolio` events of a watch NDJSON log into one row per asset per
 * sample. A log holds every event type, so anything else is ignored; an errored
 * sample has no balances and is counted instead of emitting blank rows.
 */
export function extractBalanceHistory(
  text: string,
  options: { session?: string | null } = {},
): Omit<HistoryReport, "path"> {
  const rows: HistoryRow[] = [];
  const sessions: string[] = [];
  let skippedSamples = 0;
  let skippedLines = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
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
    if (options.session && session !== options.session) continue;
    if (record.event !== "portfolio") continue;

    const at = timeField(record.at);
    if (at === null) {
      skippedLines += 1;
      continue;
    }
    if (record.error !== null && record.error !== undefined) {
      skippedSamples += 1;
      continue;
    }

    const blockNumber = bigintField(record.blockNumber);
    const usdTotal = numberField(record.usdTotal);
    const native = objectOf(record.native);
    if (native !== null && typeof native.symbol === "string") {
      rows.push({
        session,
        at,
        blockNumber,
        asset: "native",
        address: null,
        symbol: native.symbol,
        label: null,
        decimals: numberField(native.decimals),
        balance: bigintField(native.balance),
        delta: bigintField(native.delta),
        usd: numberField(native.usd),
        usdTotal,
      });
    }

    const tokens = Array.isArray(record.tokens) ? record.tokens : [];
    for (const value of tokens) {
      const token = objectOf(value);
      if (token === null || typeof token.address !== "string") continue;
      rows.push({
        session,
        at,
        blockNumber,
        asset: "token",
        address: token.address as Address,
        symbol: typeof token.symbol === "string" ? token.symbol : token.address,
        label: typeof token.label === "string" ? token.label : null,
        decimals: numberField(token.decimals),
        balance: bigintField(token.balance),
        delta: bigintField(token.delta),
        usd: numberField(token.usd),
        usdTotal,
      });
    }

    if (!sessions.includes(session)) sessions.push(session);
  }

  return { rows, sessions, skippedSamples, skippedLines };
}

function amount(value: bigint, decimals: number | null): string {
  return decimals === null ? value.toString() : formatTokenAmount(value, decimals);
}

function usdCell(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

export const HISTORY_CSV_HEADER = [
  "session",
  "at",
  "block",
  "asset",
  "address",
  "symbol",
  "label",
  "decimals",
  "balance",
  "delta",
  "usd",
  "usd_total",
] as const;

/**
 * Long-format CSV: one row per asset per sample, with an ISO timestamp, the
 * human-readable balance, and the change since the previous sample. Long format
 * keeps the columns stable as tokens come and go, so a chart can group by
 * `symbol` or `address`.
 */
export function historyCsv(report: Pick<HistoryReport, "rows">): string {
  const lines = [HISTORY_CSV_HEADER.join(",")];

  for (const row of report.rows) {
    lines.push(
      [
        row.session,
        new Date(row.at).toISOString(),
        row.blockNumber === null ? "" : row.blockNumber.toString(),
        row.asset,
        row.address ?? "",
        row.symbol,
        row.label ?? "",
        row.decimals === null ? "" : String(row.decimals),
        row.balance === null ? "" : amount(row.balance, row.decimals),
        row.delta === null ? "" : amount(row.delta, row.decimals),
        usdCell(row.usd),
        usdCell(row.usdTotal),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

interface WideColumn {
  key: string;
  name: string;
}

function assetKey(row: HistoryRow): string {
  return row.asset === "native" ? "native" : `token:${(row.address ?? "").toLowerCase()}`;
}

/**
 * One column per asset, in first-appearance order. A symbol shared by more than
 * one asset is disambiguated with its short contract address (or `native`) so
 * each holding keeps its own series.
 */
function wideColumns(rows: HistoryRow[]): WideColumn[] {
  const seen = new Map<string, { symbol: string; suffix: string }>();
  for (const row of rows) {
    const key = assetKey(row);
    if (seen.has(key)) continue;
    seen.set(key, {
      symbol: row.symbol,
      suffix: row.asset === "native" ? "(native)" : `(${shortAddress(row.address ?? "")})`,
    });
  }

  const counts = new Map<string, number>();
  for (const { symbol } of seen.values()) {
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }

  return [...seen].map(([key, { symbol, suffix }]) => ({
    key,
    name: (counts.get(symbol) ?? 0) > 1 ? `${symbol} ${suffix}` : symbol,
  }));
}

/**
 * Wide-format CSV: one row per portfolio sample and one column per asset, for
 * tools that expect a single time series per column. `session`, `at`, and
 * `block` stay first so samples from different runs remain distinguishable; an
 * asset missing from a sample leaves its cell empty rather than repeating it.
 * `usd_total` closes every row. With `options.usd`, a `SYMBOL (USD)` column
 * follows each asset column and uses the values priced by `watch --usd`. With
 * `options.usdOnly`, the raw balance columns are dropped and only those
 * `SYMBOL (USD)` columns remain, for a purely value-based series.
 */
export function historyWideCsv(
  report: Pick<HistoryReport, "rows">,
  options: { usd?: boolean; usdOnly?: boolean } = {},
): string {
  const columns = wideColumns(report.rows);
  const usdOnly = options.usdOnly === true;
  const withUsd = usdOnly || options.usd === true;
  const header = ["session", "at", "block"];
  if (!usdOnly) header.push(...columns.map((column) => column.name));
  if (withUsd) {
    header.push(...columns.map((column) => `${column.name} (USD)`));
  }
  header.push("usd_total");
  const lines = [header.map(csvCell).join(",")];

  interface WideSample {
    session: string;
    at: number;
    blockNumber: bigint | null;
    cells: Map<string, string>;
    usdCells: Map<string, string>;
    usdTotal: number | null;
  }
  const samples = new Map<string, WideSample>();

  for (const row of report.rows) {
    const sampleKey = `${row.session}\u0000${row.at}`;
    let sample = samples.get(sampleKey);
    if (sample === undefined) {
      sample = {
        session: row.session,
        at: row.at,
        blockNumber: row.blockNumber,
        cells: new Map(),
        usdCells: new Map(),
        usdTotal: row.usdTotal,
      };
      samples.set(sampleKey, sample);
    }
    if (sample.blockNumber === null) sample.blockNumber = row.blockNumber;
    if (sample.usdTotal === null) sample.usdTotal = row.usdTotal;
    sample.cells.set(
      assetKey(row),
      row.balance === null ? "" : amount(row.balance, row.decimals),
    );
    sample.usdCells.set(assetKey(row), usdCell(row.usd));
  }

  for (const sample of samples.values()) {
    lines.push(
      [
        sample.session,
        new Date(sample.at).toISOString(),
        sample.blockNumber === null ? "" : sample.blockNumber.toString(),
        ...(usdOnly
          ? []
          : columns.map((column) => sample.cells.get(column.key) ?? "")),
        ...(withUsd
          ? columns.map((column) => sample.usdCells.get(column.key) ?? "")
          : []),
        usdCell(sample.usdTotal),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Write the CSV, creating parent directories; a derived file is overwritten. */
export function saveHistoryCsv(path: string, csv: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, csv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HistoryArgError(`cannot write ${path}: ${reason}`);
  }
}

function clockTime(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

function assetName(row: HistoryRow): string {
  if (row.asset === "native") return `native ${row.symbol}`;
  return row.label ? `${row.symbol} [${row.label}]` : row.symbol;
}

export function formatHistory(report: HistoryReport): string {
  const samples = new Set(report.rows.map((row) => `${row.session}\u0000${row.at}`)).size;
  const lines = [
    "lwc — balance history",
    "",
    `  ${"log".padEnd(14)}${report.path}`,
    `  ${"rows".padEnd(14)}${report.rows.length} (${samples} portfolio sample${samples === 1 ? "" : "s"}, ${report.sessions.length} session${report.sessions.length === 1 ? "" : "s"})`,
  ];
  if (report.skippedSamples > 0) {
    lines.push(`  ${"skipped".padEnd(14)}${report.skippedSamples} sample(s) without balances`);
  }
  if (report.skippedLines > 0) {
    lines.push(`  ${"malformed".padEnd(14)}${report.skippedLines} line(s)`);
  }

  if (report.rows.length === 0) {
    lines.push("", "  no portfolio samples here (run watch with --owner and --tokens-file)");
    return lines.join("\n");
  }

  const timeWidth = 10;
  const blockWidth = Math.max(5, ...report.rows.map((row) => (row.blockNumber ?? "").toString().length));
  const assetWidth = Math.max(5, ...report.rows.map((row) => assetName(row).length));
  const balanceWidth = Math.max(
    7,
    ...report.rows.map((row) => (row.balance === null ? 3 : amount(row.balance, row.decimals).length)),
  );
  const deltaWidth = Math.max(
    5,
    ...report.rows.map((row) => (row.delta === null ? 3 : amount(row.delta, row.decimals).length)),
  );
  const usdWidth = Math.max(
    3,
    ...report.rows.map((row) => (row.usd === null ? 3 : `$${row.usd.toFixed(2)}`.length)),
  );
  const totalWidth = Math.max(
    5,
    ...report.rows.map((row) => (row.usdTotal === null ? 3 : `$${row.usdTotal.toFixed(2)}`.length)),
  );

  const header = [
    "time (UTC)".padEnd(timeWidth),
    "block".padEnd(blockWidth),
    "asset".padEnd(assetWidth),
    "balance".padStart(balanceWidth),
    "delta".padStart(deltaWidth),
    "usd".padStart(usdWidth),
    "total".padStart(totalWidth),
  ].join("  ");

  lines.push("", header);

  for (const row of report.rows) {
    lines.push(
      [
        clockTime(row.at).padEnd(timeWidth),
        (row.blockNumber === null ? "n/a" : row.blockNumber.toString()).padEnd(blockWidth),
        assetName(row).padEnd(assetWidth),
        (row.balance === null ? "n/a" : amount(row.balance, row.decimals)).padStart(balanceWidth),
        (row.delta === null ? "n/a" : amount(row.delta, row.decimals)).padStart(deltaWidth),
        (row.usd === null ? "n/a" : `$${row.usd.toFixed(2)}`).padStart(usdWidth),
        (row.usdTotal === null ? "n/a" : `$${row.usdTotal.toFixed(2)}`).padStart(totalWidth),
      ].join("  "),
    );
  }

  return lines.join("\n");
}

export function toHistoryJson(report: HistoryReport): Record<string, unknown> {
  return {
    ok: true,
    log: report.path,
    sessions: report.sessions,
    rows: report.rows.length,
    skippedSamples: report.skippedSamples,
    skippedLines: report.skippedLines,
    balances: report.rows.map((row) => ({
      session: row.session,
      at: new Date(row.at).toISOString(),
      blockNumber: row.blockNumber === null ? null : row.blockNumber.toString(),
      asset: row.asset,
      address: row.address,
      symbol: row.symbol,
      label: row.label,
      decimals: row.decimals,
      balance: row.balance === null ? null : row.balance.toString(),
      delta: row.delta === null ? null : row.delta.toString(),
      formatted: row.balance === null ? null : amount(row.balance, row.decimals),
      usd: row.usd,
      usdTotal: row.usdTotal,
    })),
  };
}
