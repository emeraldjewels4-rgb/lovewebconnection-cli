import { existsSync, readFileSync } from "node:fs";

export class PlotArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlotArgError";
  }
}

export interface PlotArgs {
  /** History CSV written by `history --csv`, in long or `--wide` format. */
  path: string;
  /** Sparkline width in characters. */
  width: number;
}

export interface PlotSample {
  session: string;
  /** Epoch milliseconds of the portfolio sample. */
  at: number;
  /** USD total of the priced holdings. */
  total: number;
}

export interface PlotReport {
  path: string;
  width: number;
  samples: PlotSample[];
  /** Sessions that contributed samples, in time order. */
  sessions: string[];
  /** Samples whose holdings were all unpriced. */
  skippedSamples: number;
  firstAt: number | null;
  lastAt: number | null;
  first: number | null;
  last: number | null;
  min: number | null;
  max: number | null;
  change: number | null;
  changePercent: number | null;
  /** Sparkline of the totals, one character per sample or bucket. */
  chart: string;
}

export const DEFAULT_PLOT_WIDTH = 48;
const MIN_PLOT_WIDTH = 10;
const MAX_PLOT_WIDTH = 200;

function parseWidth(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new PlotArgError(
      `--width must be an integer between ${MIN_PLOT_WIDTH} and ${MAX_PLOT_WIDTH}.`,
    );
  }
  const width = Number(raw);
  if (width < MIN_PLOT_WIDTH || width > MAX_PLOT_WIDTH) {
    throw new PlotArgError(
      `--width must be between ${MIN_PLOT_WIDTH} and ${MAX_PLOT_WIDTH}, got ${width}.`,
    );
  }
  return width;
}

export function parsePlotArgs(argv: string[]): PlotArgs {
  const positional: string[] = [];
  let width = DEFAULT_PLOT_WIDTH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--width") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new PlotArgError("--width requires a number.");
      }
      width = parseWidth(value);
      index += 1;
    } else if (arg.startsWith("--width=")) {
      width = parseWidth(arg.slice("--width=".length));
    } else if (arg.startsWith("-")) {
      continue; // --json and other global flags are handled by the CLI.
    } else {
      positional.push(arg);
    }
  }

  const [path] = positional;
  if (!path) {
    throw new PlotArgError(
      "A history CSV path is required: lwc plot ./balances.csv [--width 60]",
    );
  }
  if (positional.length > 1) {
    throw new PlotArgError(`Unexpected extra argument: ${positional[1]}.`);
  }

  return { path, width };
}

export function readHistoryCsv(path: string): string {
  if (!existsSync(path)) {
    throw new PlotArgError(`history CSV not found: ${path}`);
  }
  return readFileSync(path, "utf8");
}

/**
 * Minimal RFC 4180 reader: quoted cells may hold commas, newlines, and doubled
 * quotes, which is exactly what the history CSV writes for labels and flags.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index] ?? "";

    if (quoted) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => entry.length > 1 || (entry[0] ?? "") !== "");
}

interface PartialSample {
  session: string;
  at: number;
  total: number | null;
  usdSum: number;
  hasUsd: boolean;
}

/**
 * Turn a history CSV into one point per portfolio sample. The long format
 * repeats `usd_total` on every asset row of a sample, so rows are grouped by
 * session and timestamp; when `usd_total` is empty, that sample's row-level
 * `usd` values are summed instead so a partly priced portfolio still charts.
 * The `--wide` pivot is read the same way, except its `usd_total` column is
 * already one value per sample: `--wide`, `--wide --usd`, and `--wide
 * --usd-only` all chart from it without summing asset columns.
 */
export function buildPlotReport(
  text: string,
  options: { path: string; width?: number },
): PlotReport {
  const width = options.width ?? DEFAULT_PLOT_WIDTH;
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const atIndex = header.indexOf("at");
  const sessionIndex = header.indexOf("session");
  const totalIndex = header.indexOf("usd_total");
  const usdIndex = header.indexOf("usd");

  if (atIndex === -1) {
    throw new PlotArgError(
      `not a history CSV: ${options.path} has no at column (write it with history --csv).`,
    );
  }
  if (totalIndex === -1 && usdIndex === -1) {
    throw new PlotArgError(
      `no usd_total column in ${options.path}; write it with history --csv, long or --wide, from a watch --usd run.`,
    );
  }

  const cell = (row: string[], index: number): string =>
    index === -1 ? "" : (row[index] ?? "").trim();

  const partials = new Map<string, PartialSample>();
  for (const row of rows.slice(1)) {
    const atText = cell(row, atIndex);
    if (atText === "") continue;
    const at = Date.parse(atText);
    if (!Number.isFinite(at)) continue;

    const session = cell(row, sessionIndex);
    const key = `${session}\u0000${at}`;
    let partial = partials.get(key);
    if (partial === undefined) {
      partial = { session, at, total: null, usdSum: 0, hasUsd: false };
      partials.set(key, partial);
    }

    const totalText = cell(row, totalIndex);
    if (totalText !== "" && Number.isFinite(Number(totalText))) {
      partial.total = Number(totalText);
    }
    const usdText = cell(row, usdIndex);
    if (usdText !== "" && Number.isFinite(Number(usdText))) {
      partial.usdSum += Number(usdText);
      partial.hasUsd = true;
    }
  }

  const samples: PlotSample[] = [];
  let skippedSamples = 0;
  for (const partial of partials.values()) {
    if (partial.total !== null) {
      samples.push({ session: partial.session, at: partial.at, total: partial.total });
    } else if (partial.hasUsd) {
      samples.push({
        session: partial.session,
        at: partial.at,
        total: Math.round(partial.usdSum * 100) / 100,
      });
    } else {
      skippedSamples += 1;
    }
  }
  samples.sort((a, b) => a.at - b.at || a.session.localeCompare(b.session));

  const sessions: string[] = [];
  for (const sample of samples) {
    if (!sessions.includes(sample.session)) sessions.push(sample.session);
  }

  const totals = samples.map((sample) => sample.total);
  const bounds = totals.length > 0 ? extent(totals) : null;
  const first = samples[0]?.total ?? null;
  const last = samples[samples.length - 1]?.total ?? null;
  const change = first !== null && last !== null ? last - first : null;
  const changePercent =
    change !== null && first !== null && first !== 0
      ? (change / Math.abs(first)) * 100
      : null;

  return {
    path: options.path,
    width,
    samples,
    sessions,
    skippedSamples,
    firstAt: samples[0]?.at ?? null,
    lastAt: samples[samples.length - 1]?.at ?? null,
    first,
    last,
    min: bounds?.min ?? null,
    max: bounds?.max ?? null,
    change,
    changePercent,
    chart: sparkline(totals, width),
  };
}

function extent(values: number[]): { min: number; max: number } {
  let min = values[0] ?? 0;
  let max = min;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const FLAT_CHAR = SPARK_CHARS[3] ?? "▄";

/** Average a longer series into `width` buckets so the chart fits one line. */
function resample(values: number[], width: number): number[] {
  if (values.length <= width) return values;

  const buckets: number[] = [];
  for (let index = 0; index < width; index += 1) {
    const start = Math.floor((index * values.length) / width);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / width));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      sum += values[cursor] ?? 0;
    }
    buckets.push(sum / (end - start));
  }
  return buckets;
}

/** One line of block characters: the smallest value is lowest, the largest is full. */
export function sparkline(values: number[], width = DEFAULT_PLOT_WIDTH): string {
  if (values.length === 0) return "";

  const points = resample(values, Math.max(1, width));
  const { min, max } = extent(values);
  if (max === min) return FLAT_CHAR.repeat(points.length);

  return points
    .map((value) => {
      const position = Math.round(((value - min) / (max - min)) * (SPARK_CHARS.length - 1));
      const index = Math.max(0, Math.min(SPARK_CHARS.length - 1, position));
      return SPARK_CHARS[index] ?? FLAT_CHAR;
    })
    .join("");
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signedUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

function clockTime(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

const LABEL_WIDTH = 12;

function line(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}

export function formatPlot(report: PlotReport): string {
  const lines = ["lwc — portfolio USD total", "", line("csv", report.path)];

  if (
    report.samples.length === 0 ||
    report.first === null ||
    report.last === null ||
    report.min === null ||
    report.max === null ||
    report.firstAt === null ||
    report.lastAt === null
  ) {
    lines.push(line("samples", "0"));
    if (report.skippedSamples > 0) {
      lines.push(line("unpriced", `${report.skippedSamples} sample(s) skipped`));
    }
    lines.push("", "  no priced portfolio samples here (run watch with --usd)");
    return lines.join("\n");
  }

  const percent =
    report.changePercent === null
      ? "n/a"
      : `${report.changePercent >= 0 ? "+" : ""}${report.changePercent.toFixed(2)}%`;
  const change = report.change === null ? "n/a" : signedUsd(report.change);

  lines.push(
    line(
      "samples",
      `${report.samples.length}${
        report.sessions.length > 1 ? ` (${report.sessions.length} sessions)` : ""
      }`,
    ),
    line(
      "window",
      `${new Date(report.firstAt).toISOString()} → ${new Date(report.lastAt).toISOString()}`,
    ),
    line(
      "total",
      `${formatUsd(report.first)} → ${formatUsd(report.last)}  (${change}, ${percent})`,
    ),
    line("range", `${formatUsd(report.min)} – ${formatUsd(report.max)}`),
  );
  if (report.skippedSamples > 0) {
    lines.push(line("unpriced", `${report.skippedSamples} sample(s) skipped`));
  }

  const maxLabel = formatUsd(report.max);
  const minLabel = formatUsd(report.min);
  const labelWidth = Math.max(maxLabel.length, minLabel.length);

  lines.push(
    "",
    `  ${maxLabel.padStart(labelWidth)} ┤${report.chart}`,
    `  ${minLabel.padStart(labelWidth)} ┤`,
    `  ${" ".repeat(labelWidth)} └─ ${clockTime(report.firstAt)} → ${clockTime(report.lastAt)} UTC`,
  );

  return lines.join("\n");
}

export function toPlotJson(report: PlotReport): Record<string, unknown> {
  return {
    ok: true,
    csv: report.path,
    width: report.width,
    sessions: report.sessions,
    samples: report.samples.length,
    skippedSamples: report.skippedSamples,
    first: report.first,
    last: report.last,
    change: report.change,
    changePercent: report.changePercent,
    min: report.min,
    max: report.max,
    chart: report.chart,
    series: report.samples.map((sample) => ({
      session: sample.session,
      at: new Date(sample.at).toISOString(),
      usdTotal: sample.total,
    })),
  };
}
