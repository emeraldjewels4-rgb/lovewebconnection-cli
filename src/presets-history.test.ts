import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PresetsHistoryArgError,
  appendPresetHistory,
  formatPresetHistory,
  parsePresetHistoryArgs,
  readPresetHistory,
  summarizePresetHistory,
  type PresetHistoryRecord,
} from "./presets-history.ts";
import { toPresetsJson, type PresetProbeResult, type PresetsReport } from "./presets.ts";

function endpoint(
  preset: string,
  chainId: number,
  overrides: Partial<PresetProbeResult> = {},
): PresetProbeResult {
  return {
    preset,
    chainId,
    nativeSymbol: preset === "polygon" ? "POL" : "ETH",
    rpcHost: "primary.example.org",
    primaryHost: "primary.example.org",
    viaFallback: false,
    primaryError: null,
    ok: true,
    latencyMs: 100,
    blockNumber: 1000n,
    error: null,
    ...overrides,
  };
}

function report(endpoints: PresetProbeResult[]): PresetsReport {
  const failed = endpoints.filter((entry) => !entry.ok).length;
  return {
    total: endpoints.length,
    healthy: endpoints.length - failed,
    failed,
    endpoints,
  };
}

function record(at: string, endpoints: PresetProbeResult[]): PresetHistoryRecord {
  return { at, ...toPresetsJson(report(endpoints)) };
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "lwc-presets-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("appendPresetHistory records one line per run and creates the directory", (t) => {
  const path = join(tempDir(t), "nested", "presets.jsonl");

  const first = appendPresetHistory(
    path,
    report([endpoint("base", 8453)]),
    new Date("2026-11-10T06:17:00Z"),
  );
  assert.equal(first.at, "2026-11-10T06:17:00.000Z");
  assert.equal(first.total, 1);
  assert.equal(first.endpoints[0]?.blockNumber, "1000", "bigints are stored as strings");

  appendPresetHistory(path, report([endpoint("base", 8453)]), new Date("2026-11-11T06:17:00Z"));

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).at, "2026-11-10T06:17:00.000Z");
  assert.equal(readPresetHistory(path).length, 2);
});

test("readPresetHistory skips damaged lines and orders by time", (t) => {
  const path = join(tempDir(t), "presets.jsonl");
  const later = record("2026-11-11T06:17:00.000Z", [endpoint("base", 8453)]);
  const earlier = record("2026-11-10T06:17:00.000Z", [endpoint("xlayer", 196)]);

  writeFileSync(
    path,
    [
      JSON.stringify(later),
      "{ not json",
      JSON.stringify({ at: "not a date", total: 1, endpoints: [] }),
      "",
      JSON.stringify(earlier),
    ].join("\n"),
  );

  const records = readPresetHistory(path);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.at, "2026-11-10T06:17:00.000Z");
  assert.equal(records[1]?.at, "2026-11-11T06:17:00.000Z");
});

test("summarizePresetHistory derives uptime, failovers and latency", () => {
  const summary = summarizePresetHistory([
    record("2026-11-10T06:17:00.000Z", [endpoint("base", 8453, { latencyMs: 100 })]),
    record("2026-11-11T06:17:00.000Z", [
      endpoint("base", 8453, {
        latencyMs: 300,
        viaFallback: true,
        rpcHost: "backup.example.org",
        primaryError: "HTTP request failed.",
      }),
    ]),
    record("2026-11-12T06:17:00.000Z", [
      endpoint("base", 8453, {
        ok: false,
        latencyMs: null,
        blockNumber: null,
        error: "both endpoints failed",
      }),
    ]),
    record("2026-11-12T06:17:00.000Z", [endpoint("xlayer", 196, { latencyMs: 50 })]),
  ]);

  assert.equal(summary.runs, 4);
  assert.equal(summary.healthyRuns, 3);
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.failoverRuns, 1);
  assert.equal(summary.from, "2026-11-10T06:17:00.000Z");
  assert.equal(summary.to, "2026-11-12T06:17:00.000Z");

  const base = summary.presets.find((row) => row.preset === "base");
  assert.equal(base?.runs, 3);
  assert.equal(base?.healthy, 2);
  assert.equal(base?.failed, 1);
  assert.equal(base?.failovers, 1);
  assert.equal(base?.uptimePct, 66.7);
  // Nearest rank with two samples takes the lower one, as summarizeLatency does.
  assert.equal(base?.p50LatencyMs, 100, "nearest rank over successful latencies");
  assert.equal(base?.maxLatencyMs, 300);
  assert.equal(base?.lastFailureAt, "2026-11-12T06:17:00.000Z");

  const xlayer = summary.presets.find((row) => row.preset === "xlayer");
  assert.equal(xlayer?.uptimePct, 100);
  assert.equal(xlayer?.lastFailureAt, null);
});

test("formatPresetHistory renders the totals and one row per preset", () => {
  const text = formatPresetHistory(
    summarizePresetHistory([
      record("2026-11-10T06:17:00.000Z", [endpoint("base", 8453, { latencyMs: 120 })]),
      record("2026-11-11T06:17:00.000Z", [
        endpoint("base", 8453, {
          viaFallback: true,
          rpcHost: "backup.example.org",
          primaryError: "timeout",
        }),
      ]),
    ]),
  );

  assert.match(text, /^lwc — preset health history/);
  assert.match(text, /runs {10}2 \(2026-11-10 06:17 → 2026-11-11 06:17\)/);
  assert.match(text, /healthy {7}2 of 2 runs/);
  assert.match(text, /failovers {5}1 runs served by a backup/);
  assert.match(text, /base\s+8453\s+2\s+100%\s+1\s+100 ms\s+120 ms\s+—/);
});

test("formatPresetHistory explains an empty history", () => {
  const text = formatPresetHistory(summarizePresetHistory([]));

  assert.match(text, /no runs recorded yet/);
  assert.match(text, /lwc presets --history/);
});

test("parsePresetHistoryArgs takes one path and rejects anything else", () => {
  assert.deepEqual(parsePresetHistoryArgs(["history.jsonl"]), { path: "history.jsonl" });
  assert.deepEqual(parsePresetHistoryArgs(["history.jsonl", "--json"]), {
    path: "history.jsonl",
  });

  for (const argv of [[], ["a.jsonl", "b.jsonl"], ["--since", "1d"], ["-x"]]) {
    assert.throws(
      () => parsePresetHistoryArgs(argv),
      (error: unknown) => error instanceof PresetsHistoryArgError,
      argv.join(" "),
    );
  }
});

test("a recorded run is what the history view reads back", (t) => {
  const path = join(tempDir(t), "presets.jsonl");
  appendPresetHistory(
    path,
    report([
      endpoint("base", 8453, { latencyMs: 500 }),
      endpoint("polygon", 137, {
        viaFallback: true,
        rpcHost: "polygon.drpc.org",
        primaryError: "timeout",
        latencyMs: 800,
        nativeSymbol: "POL",
      }),
    ]),
    new Date("2026-11-10T06:17:00Z"),
  );

  const summary = summarizePresetHistory(readPresetHistory(path));
  assert.equal(summary.runs, 1);
  assert.equal(summary.failoverRuns, 1);

  const polygon = summary.presets.find((row) => row.preset === "polygon");
  assert.equal(polygon?.failovers, 1);
  assert.equal(polygon?.nativeSymbol, "POL");
  assert.equal(polygon?.uptimePct, 100);
});
