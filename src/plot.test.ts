import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  DEFAULT_PLOT_WIDTH,
  PlotArgError,
  buildPlotReport,
  formatPlot,
  parseCsv,
  parsePlotArgs,
  readHistoryCsv,
  sparkline,
  toPlotJson,
} from "./plot.ts";

const USDT = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";

const HEADER =
  "session,at,block,asset,address,symbol,label,decimals,balance,delta,usd,usd_total";

const CSV = [
  HEADER,
  "s1,2026-11-09T12:00:01.000Z,100,native,,OKB,,18,1,,1.00,10.00",
  `s1,2026-11-09T12:00:01.000Z,100,token,${USDT},USDT,"Tether, USD",6,1,,9.00,10.00`,
  "s1,2026-11-09T12:00:31.000Z,101,native,,OKB,,18,1,,1.00,20.00",
  `s1,2026-11-09T12:00:31.000Z,101,token,${USDT},USDT,,6,1,,19.00,20.00`,
  "s1,2026-11-09T12:01:01.000Z,102,native,,OKB,,18,1,,1.00,",
  `s1,2026-11-09T12:01:01.000Z,102,token,${USDT},USDT,,6,1,,4.00,`,
].join("\n");

test("parses quoted CSV cells with commas and newlines", () => {
  const rows = parseCsv('a,b\n"one, two","line\nbreak"\n"say ""hi"""\n');

  assert.deepEqual(rows[0], ["a", "b"]);
  assert.deepEqual(rows[1], ["one, two", "line\nbreak"]);
  assert.deepEqual(rows[2], ['say "hi"']);
});

test("builds one point per sample from repeated long-format rows", () => {
  const report = buildPlotReport(CSV, { path: "./balances.csv", width: 20 });

  assert.equal(report.samples.length, 3, "each sample appears once");
  assert.deepEqual(
    report.samples.map((sample) => sample.total),
    [10, 20, 5],
  );
  assert.deepEqual(report.sessions, ["s1"]);
  assert.equal(report.skippedSamples, 0);
  assert.equal(report.first, 10);
  assert.equal(report.last, 5);
  assert.equal(report.min, 5);
  assert.equal(report.max, 20);
  assert.equal(report.change, -5);
  assert.equal(report.changePercent, -50);
  assert.equal(report.firstAt, Date.parse("2026-11-09T12:00:01.000Z"));
  assert.equal(report.width, 20);
});

test("sums row usd values when usd_total is empty", () => {
  const report = buildPlotReport(CSV, { path: "x.csv" });

  assert.equal(report.samples[2]?.total, 5, "1.00 + 4.00");
});

test("counts samples with no priced holdings", () => {
  const csv = [
    HEADER,
    "s1,2026-11-09T12:00:01.000Z,100,native,,OKB,,18,1,,,",
    "s1,2026-11-09T12:00:31.000Z,101,native,,OKB,,18,1,,2.00,2.00",
  ].join("\n");
  const report = buildPlotReport(csv, { path: "x.csv" });

  assert.equal(report.samples.length, 1);
  assert.equal(report.skippedSamples, 1);
});

test("charts a wide history CSV from its usd_total column", () => {
  const wide = [
    "session,at,block,OKB,USDT,WOKB,usd_total",
    "mw8,2026-11-09T12:31:05.000Z,75418547,1.25,2.5,280.07,126.71",
    "mw8,2026-11-09T12:31:35.000Z,75418548,1.2,2.5,281.57,123.93",
  ].join("\n");
  const report = buildPlotReport(wide, { path: "balances-wide.csv", width: 8 });

  assert.equal(report.samples.length, 2, "one row per sample needs no grouping");
  assert.deepEqual(
    report.samples.map((sample) => sample.total),
    [126.71, 123.93],
  );
  assert.deepEqual(report.sessions, ["mw8"]);
  assert.equal(report.skippedSamples, 0);

  const usdOnly = [
    "session,at,block,OKB (USD),USDT (USD),WOKB (USD),usd_total",
    "mw8,2026-11-09T12:31:05.000Z,75418547,113.83,2.50,10.38,126.71",
  ].join("\n");
  assert.equal(
    buildPlotReport(usdOnly, { path: "usd-only.csv" }).last,
    126.71,
    "the --usd-only pivot charts from the same column",
  );
});

test("rejects a CSV without a usd_total column", () => {
  const plain = "session,at,block,OKB,USDT\ns1,2026-11-09T12:00:01.000Z,100,1,1\n";

  assert.throws(
    () => buildPlotReport(plain, { path: "plain.csv" }),
    (error: unknown) => error instanceof PlotArgError && /usd_total/.test(error.message),
  );
  assert.throws(
    () => buildPlotReport("a,b\n1,2\n", { path: "other.csv" }),
    /not a history CSV/,
  );
});

test("draws a sparkline and averages long series into the width", () => {
  assert.equal(sparkline([], 10), "");
  assert.equal(sparkline([5, 5, 5], 10), "▄▄▄");
  assert.equal(sparkline([0, 1], 10), "▁█");
  assert.equal(sparkline(Array.from({ length: 500 }, (_, index) => index), 12).length, 12);
  assert.equal(sparkline([1, 2, 3], 50).length, 3, "never pads a short series");
  assert.equal(DEFAULT_PLOT_WIDTH, 48);
});

test("formats the summary and chart", () => {
  const text = formatPlot(buildPlotReport(CSV, { path: "./balances.csv", width: 8 }));

  assert.match(text, /lwc — portfolio USD total/);
  assert.match(text, /csv {9}\.\/balances\.csv/);
  assert.match(text, /\$10\.00 → \$5\.00 {2}\(-?\$5\.00, -50\.00%\)/);
  assert.match(text, /range {7}\$5\.00 – \$20\.00/);
  assert.match(text, /\$20\.00 ┤/);
  assert.match(text, /└─ 12:00:01 → 12:01:01 UTC/);
});

test("explains an unpriced history instead of drawing an empty chart", () => {
  const text = formatPlot(buildPlotReport(HEADER, { path: "empty.csv" }));

  assert.match(text, /no priced portfolio samples here/);
});

test("reports the series and summary as JSON", () => {
  const json = toPlotJson(buildPlotReport(CSV, { path: "./balances.csv" })) as {
    samples: number;
    samplesSeries?: unknown;
    series: Array<{ at: string; usdTotal: number }>;
    change: number;
    chart: string;
  };

  assert.equal(json.samples, 3);
  assert.equal(json.change, -5);
  assert.equal(json.series[0]?.at, "2026-11-09T12:00:01.000Z");
  assert.equal(json.series[0]?.usdTotal, 10);
  assert.equal(json.chart.length, 3);
});

test("parses the CSV path and width", () => {
  assert.deepEqual(parsePlotArgs(["./balances.csv"]), {
    path: "./balances.csv",
    width: DEFAULT_PLOT_WIDTH,
  });
  assert.equal(parsePlotArgs(["./b.csv", "--width", "60"]).width, 60);
  assert.equal(parsePlotArgs(["--width=12", "./b.csv"]).width, 12);
  assert.equal(parsePlotArgs(["./b.csv", "--json"]).path, "./b.csv");

  assert.throws(() => parsePlotArgs([]), PlotArgError);
  assert.throws(() => parsePlotArgs(["./a.csv", "./b.csv"]), PlotArgError);
  assert.throws(() => parsePlotArgs(["./a.csv", "--width"]), PlotArgError);
  for (const value of ["0", "9", "201", "wide"]) {
    assert.throws(() => parsePlotArgs(["./a.csv", `--width=${value}`]), /--width/);
  }
});

test("reports a missing CSV with a usage error", () => {
  assert.throws(
    () => readHistoryCsv(join(tmpdir(), "lwc-does-not-exist", "nope.csv")),
    /history CSV not found/,
  );
});
