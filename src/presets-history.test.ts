import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PresetsHistoryArgError,
  appendPresetHistory,
  comparePresetHistory,
  formatPresetHistory,
  formatPresetHistoryComparison,
  mergePresetHistory,
  parsePresetHistoryArgs,
  presetHistoryCsv,
  presetComparisonMarkdown,
  presetHistoryTimelineCsv,
  presetRegressionWarnings,
  presetsBelowUptime,
  providerRegressionWarnings,
  readPresetHistory,
  savePresetHistory,
  summarizePresetGate,
  summarizePresetHistory,
  summarizeProviderHistory,
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

test("mergePresetHistory unions two copies of the same record, oldest first", () => {
  const shared = record("2026-11-02T06:17:00.000Z", [endpoint("base", 8453)]);
  const cache = [record("2026-11-01T06:17:00.000Z", [endpoint("base", 8453)]), shared];
  const release = [shared, record("2026-11-03T06:17:00.000Z", [endpoint("base", 8453)])];

  const merge = mergePresetHistory([release, cache]);

  assert.deepEqual(
    merge.records.map((entry) => entry.at),
    ["2026-11-01T06:17:00.000Z", "2026-11-02T06:17:00.000Z", "2026-11-03T06:17:00.000Z"],
  );
  assert.equal(merge.duplicates, 1);
  assert.deepEqual(merge.counts, [2, 2]);
});

test("a merge keeps two runs recorded at the same time when they differ", () => {
  const merge = mergePresetHistory([
    [record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)])],
    [
      record("2026-11-08T06:17:00.000Z", [
        endpoint("base", 8453, { ok: false, latencyMs: null, blockNumber: null, error: "down" }),
      ]),
    ],
  ]);

  assert.equal(merge.records.length, 2);
  assert.equal(merge.duplicates, 0);
});

test("savePresetHistory writes the file readPresetHistory reads back", (t) => {
  const path = join(tempDir(t), "merged", "presets.jsonl");
  const records = [
    record("2026-11-01T06:17:00.000Z", [endpoint("base", 8453)]),
    record("2026-11-02T06:17:00.000Z", [endpoint("optimism", 10)]),
  ];

  savePresetHistory(path, records);
  const read = readPresetHistory(path);
  assert.deepEqual(
    read.map((entry) => entry.at),
    records.map((entry) => entry.at),
  );
  assert.equal(read[0]?.endpoints[0]?.preset, "base");

  savePresetHistory(path, []);
  assert.equal(readFileSync(path, "utf8"), "");
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
  assert.deepEqual(parsePresetHistoryArgs(["history.jsonl"]), {
    path: "history.jsonl",
    since: null,
    until: null,
    limit: null,
    failUnder: null,
    csvPath: null,
    timelinePath: null,
    compare: null,
    merge: [],
    out: null,
  });
  assert.deepEqual(parsePresetHistoryArgs(["history.jsonl", "--json"]), {
    path: "history.jsonl",
    since: null,
    until: null,
    limit: null,
    failUnder: null,
    csvPath: null,
    timelinePath: null,
    compare: null,
    merge: [],
    out: null,
  });
  assert.deepEqual(parsePresetHistoryArgs(["history.jsonl", "--csv", "-"]), {
    path: "history.jsonl",
    since: null,
    until: null,
    limit: null,
    failUnder: null,
    csvPath: "-",
    timelinePath: null,
    compare: null,
    merge: [],
    out: null,
  });
  assert.equal(parsePresetHistoryArgs(["h.jsonl", "--timeline", "-"]).timelinePath, "-");

  for (const argv of [
    [],
    ["a.jsonl", "b.jsonl"],
    ["--bogus"],
    ["-x"],
    ["h.jsonl", "--csv"],
    ["h.jsonl", "--timeline"],
    ["h.jsonl", "--csv", "a.csv", "--timeline", "b.csv"],
  ]) {
    assert.throws(
      () => parsePresetHistoryArgs(argv),
      (error: unknown) => error instanceof PresetsHistoryArgError,
      argv.join(" "),
    );
  }
});

test("parses --merge inputs and --out as one combined history", () => {
  const args = parsePresetHistoryArgs([
    "presets.jsonl",
    "--merge",
    "laptop.jsonl",
    "--merge=server.jsonl",
    "--out",
    "combined.jsonl",
  ]);

  assert.deepEqual(args.merge, ["laptop.jsonl", "server.jsonl"]);
  assert.equal(args.out, "combined.jsonl");
});

test("--out writes a merge, so it needs a --merge and a file path", () => {
  assert.throws(
    () => parsePresetHistoryArgs(["presets.jsonl", "--out", "combined.jsonl"]),
    /at least one --merge/,
  );
  assert.throws(
    () => parsePresetHistoryArgs(["presets.jsonl", "--merge", "other.jsonl", "--out", "-"]),
    /needs a file path/,
  );
  assert.throws(
    () => parsePresetHistoryArgs(["presets.jsonl", "--merge"]),
    /requires a history file/,
  );
});

test("a merged history windows the union, not each copy", () => {
  const cache = [record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)])];
  const release = [
    record("2026-11-07T06:17:00.000Z", [endpoint("base", 8453)]),
    record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)]),
  ];

  const merge = mergePresetHistory([cache, release]);
  const summary = summarizePresetHistory(merge.records, {
    since: Date.parse("2026-11-08T00:00:00Z"),
  });

  // The duplicate is dropped before the window applies, so one run survives.
  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.runs, 1);
  assert.equal(summary.presets[0]?.runs, 1);
});

test("parses --since as an ISO time or a span, and --limit as a positive count", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");

  assert.equal(
    parsePresetHistoryArgs(["h.jsonl", "--since", "2026-11-09T12:00:00Z"], now).since,
    Date.parse("2026-11-09T12:00:00Z"),
  );
  assert.equal(parsePresetHistoryArgs(["h.jsonl", "--since=24h"], now).since, now - 86_400_000);
  assert.equal(parsePresetHistoryArgs(["--limit=3", "h.jsonl"], now).limit, 3);
  assert.deepEqual(parsePresetHistoryArgs(["h.jsonl", "--since", "7d", "--limit", "2"], now), {
    path: "h.jsonl",
    since: now - 7 * 86_400_000,
    until: null,
    limit: 2,
    failUnder: null,
    csvPath: null,
    timelinePath: null,
    compare: null,
    merge: [],
    out: null,
  });

  for (const argv of [
    ["h.jsonl", "--since", "soon"],
    ["h.jsonl", "--since"],
    ["h.jsonl", "--limit", "0"],
    ["h.jsonl", "--limit", "two"],
    ["h.jsonl", "--limit"],
  ]) {
    assert.throws(
      () => parsePresetHistoryArgs(argv, now),
      (error: unknown) => error instanceof PresetsHistoryArgError,
      argv.join(" "),
    );
  }
});

test("parses --until as a closed end, and rejects an inverted window", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");

  assert.equal(
    parsePresetHistoryArgs(["h.jsonl", "--until", "2026-11-09T12:00:00Z"], now).until,
    Date.parse("2026-11-09T12:00:00Z"),
  );
  assert.equal(parsePresetHistoryArgs(["h.jsonl", "--until=1d"], now).until, now - 86_400_000);
  assert.deepEqual(parsePresetHistoryArgs(["h.jsonl", "--since", "2d", "--until", "1d"], now), {
    path: "h.jsonl",
    since: now - 2 * 86_400_000,
    until: now - 86_400_000,
    limit: null,
    failUnder: null,
    csvPath: null,
    timelinePath: null,
    compare: null,
    merge: [],
    out: null,
  });

  for (const argv of [
    ["h.jsonl", "--until", "soon"],
    ["h.jsonl", "--until"],
    ["h.jsonl", "--since", "1d", "--until", "2d"],
  ]) {
    assert.throws(
      () => parsePresetHistoryArgs(argv, now),
      (error: unknown) => error instanceof PresetsHistoryArgError,
      argv.join(" "),
    );
  }
});

test("parses --compare as an earlier window that ends before --since", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const day = 86_400_000;

  assert.deepEqual(
    parsePresetHistoryArgs([
      "h.jsonl",
      "--since",
      "7d",
      "--compare",
      "14d..7d",
    ], now).compare,
    { since: now - 14 * day, until: now - 7 * day },
  );
  assert.deepEqual(
    parsePresetHistoryArgs(
      ["h.jsonl", "--since=2026-11-08T00:00:00Z", "--compare=2026-11-01T00:00:00Z..2026-11-08T00:00:00Z"],
      now,
    ).compare,
    {
      since: Date.parse("2026-11-01T00:00:00Z"),
      until: Date.parse("2026-11-08T00:00:00Z"),
    },
  );
  // CI gates the current window and compares it in the same run.
  const gated = parsePresetHistoryArgs(
    ["h.jsonl", "--since", "7d", "--compare", "14d..7d", "--fail-under", "90"],
    now,
  );
  assert.equal(gated.failUnder, 90);
  assert.deepEqual(gated.compare, { since: now - 14 * day, until: now - 7 * day });

  for (const argv of [
    ["h.jsonl", "--compare", "14d"],
    ["h.jsonl", "--compare", "14d.."],
    ["h.jsonl", "--compare", "..7d"],
    ["h.jsonl", "--compare", "14d..7d..2d"],
    ["h.jsonl", "--compare", "soon..7d"],
    ["h.jsonl", "--compare"],
    ["h.jsonl", "--compare", "7d..14d"],
    ["h.jsonl", "--compare", "14d..7d"],
    ["h.jsonl", "--since", "8d", "--compare", "14d..7d"],
    ["h.jsonl", "--since", "7d", "--compare", "14d..7d", "--limit", "2"],
    ["h.jsonl", "--since", "7d", "--compare", "14d..7d", "--csv", "-"],
    ["h.jsonl", "--since", "7d", "--compare", "14d..7d", "--timeline", "-"],
  ]) {
    assert.throws(
      () => parsePresetHistoryArgs(argv, now),
      (error: unknown) => error instanceof PresetsHistoryArgError,
      argv.join(" "),
    );
  }
});

test("parses --fail-under as a percentage from 0 to 100", () => {
  assert.equal(parsePresetHistoryArgs(["h.jsonl", "--fail-under", "99"]).failUnder, 99);
  assert.equal(parsePresetHistoryArgs(["h.jsonl", "--fail-under=66.7"]).failUnder, 66.7);
  assert.equal(parsePresetHistoryArgs(["h.jsonl", "--fail-under", "0"]).failUnder, 0);

  for (const argv of [
    ["h.jsonl", "--fail-under", "101"],
    ["h.jsonl", "--fail-under", "high"],
    ["h.jsonl", "--fail-under", "-1"],
    ["h.jsonl", "--fail-under"],
    ["h.jsonl", "--fail-under="],
  ]) {
    assert.throws(
      () => parsePresetHistoryArgs(argv),
      (error: unknown) => error instanceof PresetsHistoryArgError,
      argv.join(" "),
    );
  }
});

test("--fail-under names every preset under the threshold, worst first", () => {
  const down = endpoint("base", 8453, {
    ok: false,
    latencyMs: null,
    blockNumber: null,
    error: "down",
  });
  const summary = summarizePresetHistory([
    record("2026-11-10T06:17:00.000Z", [
      endpoint("base", 8453),
      endpoint("ethereum", 1, { ...down, preset: "ethereum", chainId: 1 }),
      endpoint("xlayer", 196),
    ]),
    record("2026-11-11T06:17:00.000Z", [
      endpoint("base", 8453, { ...down, preset: "base", chainId: 8453 }),
      endpoint("ethereum", 1, { ...down, preset: "ethereum", chainId: 1 }),
      endpoint("xlayer", 196),
    ]),
  ]);

  assert.deepEqual(presetsBelowUptime(summary, 100), [
    { preset: "ethereum", chainId: 1, uptimePct: 0, runs: 2, failed: 2 },
    { preset: "base", chainId: 8453, uptimePct: 50, runs: 2, failed: 1 },
  ]);
  // Meeting the threshold exactly counts as clearing it.
  assert.deepEqual(presetsBelowUptime(summary, 50), [
    { preset: "ethereum", chainId: 1, uptimePct: 0, runs: 2, failed: 2 },
  ]);
  assert.deepEqual(presetsBelowUptime(summary, 0), []);
});

test("the gate report passes a window every preset cleared", () => {
  const summary = summarizePresetHistory([
    record("2026-11-10T06:17:00.000Z", [endpoint("base", 8453), endpoint("xlayer", 196)]),
  ]);
  const gate = summarizePresetGate(summary, 95);

  assert.equal(gate.passed, true);
  assert.equal(gate.threshold, 95);
  assert.deepEqual(gate.shortfalls, []);
  assert.match(gate.markdown, /^### Preset uptime gate/);
  assert.match(
    gate.markdown,
    /\*\*PASS\*\* — all 2 presets stayed at or above 95% across 1 run \(2026-11-10 06:17 → 2026-11-10 06:17\)\./,
  );
});

test("the gate report lists each preset below the threshold", () => {
  const down = {
    ok: false,
    latencyMs: null,
    blockNumber: null,
    error: "down",
  };
  const summary = summarizePresetHistory(
    [
      record("2026-11-09T06:17:00.000Z", [
        endpoint("base", 8453, down),
        endpoint("ethereum", 1, down),
      ]),
      record("2026-11-10T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1, down)]),
    ],
    { since: Date.parse("2026-11-09T00:00:00Z"), limit: 2 },
  );
  const gate = summarizePresetGate(summary, 100);

  assert.equal(gate.passed, false);
  assert.deepEqual(
    gate.shortfalls.map((row) => [row.preset, row.uptimePct]),
    [
      ["ethereum", 0],
      ["base", 50],
    ],
  );
  assert.match(
    gate.markdown,
    /\*\*FAIL\*\* — 2 presets below 100% across 2 runs \(2026-11-09 06:17 → 2026-11-10 06:17\), since 2026-11-09 00:00, newest 2\./,
  );
  assert.match(gate.markdown, /\| `ethereum` \| 1 \| 2 \| 0% \| 2 \|/);
  assert.match(gate.markdown, /\| `base` \| 8453 \| 2 \| 50% \| 1 \|/);
});

test("the gate cannot pass an empty window", () => {
  const summary = summarizePresetHistory(
    [record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)])],
    { since: Date.parse("2026-11-09T00:00:00Z") },
  );
  const gate = summarizePresetGate(summary, 80);

  assert.equal(gate.passed, false);
  assert.match(
    gate.markdown,
    /no runs in the window \(1 recorded\), so a 80% minimum cannot be verified/,
  );
});

test("--since and --limit narrow the summary to the newest runs", () => {
  const records = [
    record("2026-11-08T06:00:00.000Z", [endpoint("base", 8453, { latencyMs: 10 })]),
    record("2026-11-09T06:00:00.000Z", [
      endpoint("base", 8453, {
        ok: false,
        latencyMs: null,
        blockNumber: null,
        error: "down",
      }),
    ]),
    record("2026-11-10T06:00:00.000Z", [endpoint("base", 8453, { latencyMs: 30 })]),
  ];

  const cutoff = Date.parse("2026-11-09T00:00:00Z");
  const since = summarizePresetHistory(records, { since: cutoff });
  assert.equal(since.totalRuns, 3);
  assert.equal(since.runs, 2);
  assert.equal(since.failedRuns, 1);
  assert.equal(since.since, cutoff);
  assert.equal(since.presets[0]?.uptimePct, 50);

  const limited = summarizePresetHistory(records, { limit: 1 });
  assert.equal(limited.totalRuns, 3);
  assert.equal(limited.runs, 1);
  assert.equal(limited.failedRuns, 0);
  assert.equal(limited.from, "2026-11-10T06:00:00.000Z");
  assert.equal(limited.limit, 1);

  // --since applies first, then --limit takes the tail of what is left.
  const both = summarizePresetHistory(records, {
    since: Date.parse("2026-11-08T12:00:00Z"),
    limit: 1,
  });
  assert.equal(both.runs, 1);
  assert.equal(both.from, "2026-11-10T06:00:00.000Z");

  const none = summarizePresetHistory(records, { since: Date.parse("2027-01-01T00:00:00Z") });
  assert.equal(none.runs, 0);
  assert.equal(none.totalRuns, 3);
});

test("--until closes the window without dropping older runs", () => {
  const records = [
    record("2026-11-08T06:00:00.000Z", [endpoint("base", 8453, { latencyMs: 10 })]),
    record("2026-11-09T06:00:00.000Z", [endpoint("base", 8453, { latencyMs: 20 })]),
    record("2026-11-10T06:00:00.000Z", [
      endpoint("base", 8453, { ok: false, latencyMs: null, blockNumber: null, error: "down" }),
    ]),
  ];

  const closed = summarizePresetHistory(records, {
    since: Date.parse("2026-11-08T00:00:00Z"),
    until: Date.parse("2026-11-09T12:00:00Z"),
  });
  assert.equal(closed.totalRuns, 3);
  assert.equal(closed.runs, 2);
  assert.equal(closed.failedRuns, 0);
  assert.equal(closed.from, "2026-11-08T06:00:00.000Z");
  assert.equal(closed.to, "2026-11-09T06:00:00.000Z");
  assert.equal(closed.until, Date.parse("2026-11-09T12:00:00Z"));
  assert.equal(closed.presets[0]?.uptimePct, 100);

  // Without --since, an --until keeps the whole earlier history.
  const early = summarizePresetHistory(records, {
    until: Date.parse("2026-11-08T06:00:00Z"),
  });
  assert.equal(early.runs, 1);
  assert.equal(early.from, "2026-11-08T06:00:00.000Z");
});

test("formatPresetHistory prints both ends of a closed window", () => {
  const text = formatPresetHistory(
    summarizePresetHistory(
      [
        record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)]),
        record("2026-11-10T06:17:00.000Z", [endpoint("base", 8453)]),
      ],
      {
        since: Date.parse("2026-11-08T00:00:00Z"),
        until: Date.parse("2026-11-09T00:00:00Z"),
      },
    ),
  );

  assert.match(text, /runs {10}1 of 2 \(2026-11-08 06:17 → 2026-11-08 06:17\)/);
  assert.match(text, /window {8}since 2026-11-08 00:00, until 2026-11-09 00:00/);
});

test("formatPresetHistory names the window it applied", () => {
  const text = formatPresetHistory(
    summarizePresetHistory(
      [
        record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)]),
        record("2026-11-11T06:17:00.000Z", [endpoint("base", 8453)]),
      ],
      { since: Date.parse("2026-11-09T00:00:00Z"), limit: 5 },
    ),
  );

  assert.match(text, /runs {10}1 of 2 \(2026-11-11 06:17 → 2026-11-11 06:17\)/);
  assert.match(text, /window {8}since 2026-11-09 00:00, last 5 runs/);
});

test("formatPresetHistory explains an empty window", () => {
  const text = formatPresetHistory(
    summarizePresetHistory([record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)])], {
      since: Date.parse("2026-11-09T00:00:00Z"),
    }),
  );

  assert.match(text, /no runs in this window \(1 recorded\)/);
  assert.match(text, /widen the window or raise --limit/);
});

test("--compare reads an earlier window beside the current one", () => {
  const down = { ok: false, latencyMs: null, blockNumber: null, error: "down" };
  const records = [
    record("2026-11-01T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1)]),
    record("2026-11-02T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1)]),
    record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1, down)]),
    record("2026-11-09T06:17:00.000Z", [
      endpoint("base", 8453),
      endpoint("ethereum", 1, down),
      endpoint("polygon", 137),
    ]),
  ];
  const comparison = comparePresetHistory(
    records,
    { since: Date.parse("2026-11-08T00:00:00Z") },
    { since: Date.parse("2026-11-01T00:00:00Z"), until: Date.parse("2026-11-03T00:00:00Z") },
  );

  assert.equal(comparison.before.runs, 2);
  assert.equal(comparison.after.runs, 2);
  assert.deepEqual(
    comparison.presets.map((row) => [row.preset, row.deltaPct]),
    [
      ["ethereum", -100],
      ["base", 0],
      ["polygon", null],
    ],
  );
  assert.equal(comparison.presets[0]?.before?.uptimePct, 100);
  assert.equal(comparison.presets[0]?.after?.uptimePct, 0);
  assert.equal(comparison.presets[2]?.before, null);
  assert.equal(comparison.presets[2]?.after?.runs, 1);

  const text = formatPresetHistoryComparison(comparison);
  assert.match(text, /^lwc — preset health comparison/);
  assert.match(text, /before\s+2 runs \(2026-11-01 06:17 → 2026-11-02 06:17\), uptime 100%/);
  assert.match(text, /after\s+2 runs \(2026-11-08 06:17 → 2026-11-09 06:17\), uptime 0%/);
  assert.match(text, /change\s+-100pp overall, 1 preset worse/);
  assert.match(text, /preset\s+chain\s+before runs\s+before uptime\s+after runs\s+after uptime\s+change/);
  assert.match(text, /ethereum\s+1\s+2\s+100%\s+2\s+0%\s+-100pp/);
  assert.match(text, /base\s+8453\s+2\s+100%\s+2\s+100%\s+0pp/);
  assert.match(text, /polygon\s+137\s+—\s+—\s+1\s+100%\s+—/);
  // The regression is listed above the steady preset, not by name.
  assert.ok(text.indexOf("ethereum") < text.indexOf("base"));
});

test("--compare explains an empty current window", () => {
  const comparison = comparePresetHistory(
    [record("2026-11-01T06:17:00.000Z", [endpoint("base", 8453)])],
    { since: Date.parse("2026-11-09T00:00:00Z") },
    { since: Date.parse("2026-11-01T00:00:00Z"), until: Date.parse("2026-11-02T00:00:00Z") },
  );
  const text = formatPresetHistoryComparison(comparison);

  assert.equal(comparison.after.runs, 0);
  assert.equal(comparison.before.runs, 1);
  assert.match(text, /after\s+no runs \(1 recorded\)/);
  assert.match(text, /no runs in the current window; widen the window and try again/);
});

test("presetComparisonMarkdown renders the delta for a CI summary", () => {
  const down = { ok: false, latencyMs: null, blockNumber: null, error: "down" };
  const comparison = comparePresetHistory(
    [
      record("2026-11-01T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1)]),
      record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1, down)]),
      record("2026-11-09T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1, down)]),
    ],
    { since: Date.parse("2026-11-08T00:00:00Z") },
    { since: Date.parse("2026-11-01T00:00:00Z"), until: Date.parse("2026-11-02T00:00:00Z") },
  );
  const markdown = presetComparisonMarkdown(comparison, "Preset week over week");

  assert.match(markdown, /^### Preset week over week/);
  assert.match(markdown, /\*\*1 regressed, 0 improved\*\* across 2 presets/);
  assert.match(markdown, /Earlier: 1 run .* — current: 2 runs .*\. Overall uptime -100pp\./);
  assert.match(
    markdown,
    /\| preset \| chain \| before runs \| before uptime \| after runs \| after uptime \| change \|/,
  );
  assert.match(markdown, /\| `ethereum` \| 1 \| 1 \| 100% \| 2 \| 0% \| -100pp \|/);
  assert.match(markdown, /\| `base` \| 8453 \| 1 \| 100% \| 2 \| 100% \| 0pp \|/);
});

test("presetRegressionWarnings names each preset whose uptime fell", () => {
  const down = { ok: false, latencyMs: null, blockNumber: null, error: "down" };
  const comparison = comparePresetHistory(
    [
      record("2026-11-01T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1)]),
      record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453), endpoint("ethereum", 1, down)]),
      record("2026-11-09T06:17:00.000Z", [
        endpoint("base", 8453),
        endpoint("ethereum", 1, down),
        endpoint("polygon", 137),
      ]),
    ],
    { since: Date.parse("2026-11-08T00:00:00Z") },
    { since: Date.parse("2026-11-01T00:00:00Z"), until: Date.parse("2026-11-02T00:00:00Z") },
  );

  // Only the fall: a flat preset and one that is absent earlier are not news.
  assert.deepEqual(presetRegressionWarnings(comparison), [
    "ethereum uptime -100pp: 100% over 1 run → 0% over 2 runs",
  ]);

  const improved = comparePresetHistory(
    [
      record("2026-11-01T06:17:00.000Z", [endpoint("base", 8453, down)]),
      record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)]),
    ],
    { since: Date.parse("2026-11-08T00:00:00Z") },
    { since: Date.parse("2026-11-01T00:00:00Z"), until: Date.parse("2026-11-02T00:00:00Z") },
  );
  assert.deepEqual(presetRegressionWarnings(improved), []);
});

test("provider history pools the presets behind one host and counts a failover against it", () => {
  const down = { ok: false, latencyMs: null, blockNumber: null, error: "down" };
  const rows = summarizeProviderHistory([
    record("2026-11-09T06:17:00.000Z", [
      endpoint("base", 8453, { primaryHost: "mainnet.example.org" }),
      endpoint("optimism", 10, {
        primaryHost: "mainnet.example.org",
        viaFallback: true,
        primaryError: "HTTP request failed.",
        rpcHost: "backup.example.org",
      }),
      endpoint("ethereum", 1, {
        ...down,
        primaryHost: "eth.example.org",
        rpcHost: "eth.example.org",
      }),
    ]),
  ]);

  // A backup answering is this provider failing, not a probe the provider passed.
  assert.deepEqual(
    rows.map((row) => [row.host, row.probes, row.healthy, row.failovers, row.failed, row.uptimePct]),
    [
      ["eth.example.org", 1, 0, 0, 1, 0],
      ["mainnet.example.org", 2, 1, 1, 0, 50],
    ],
  );
  assert.deepEqual(rows[1]?.presets, ["base", "optimism"]);
});

test("provider comparisons name the host that fell, once per provider", () => {
  const down = { ok: false, latencyMs: null, blockNumber: null, error: "down" };
  const host = "mainnet.example.org";
  const comparison = comparePresetHistory(
    [
      record("2026-11-01T06:17:00.000Z", [
        endpoint("base", 8453, { primaryHost: host }),
        endpoint("optimism", 10, { primaryHost: host }),
      ]),
      record("2026-11-08T06:17:00.000Z", [
        endpoint("base", 8453, { ...down, primaryHost: host }),
        endpoint("optimism", 10, { ...down, primaryHost: host }),
      ]),
    ],
    { since: Date.parse("2026-11-08T00:00:00Z") },
    { since: Date.parse("2026-11-01T00:00:00Z"), until: Date.parse("2026-11-02T00:00:00Z") },
  );

  assert.deepEqual(
    comparison.providers.map((row) => [row.host, row.deltaPct]),
    [[host, -100]],
  );
  assert.equal(comparison.providers[0]?.before?.probes, 2);
  assert.equal(comparison.providers[0]?.after?.failed, 2);
  // Two presets fell for one reason, so the run log names the host once.
  assert.deepEqual(providerRegressionWarnings(comparison), [
    "mainnet.example.org uptime -100pp: 100% over 2 probes → 0% over 2 probes",
  ]);

  const flat = comparePresetHistory(
    [
      record("2026-11-01T06:17:00.000Z", [endpoint("base", 8453)]),
      record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)]),
    ],
    { since: Date.parse("2026-11-08T00:00:00Z") },
    { since: Date.parse("2026-11-01T00:00:00Z"), until: Date.parse("2026-11-02T00:00:00Z") },
  );
  assert.deepEqual(providerRegressionWarnings(flat), []);
});

test("presetComparisonMarkdown explains what it cannot compare", () => {
  const records = [record("2026-11-08T06:17:00.000Z", [endpoint("base", 8453)])];
  const markdown = presetComparisonMarkdown(
    comparePresetHistory(
      records,
      { since: Date.parse("2026-11-08T00:00:00Z") },
      { since: Date.parse("2026-10-01T00:00:00Z"), until: Date.parse("2026-10-08T00:00:00Z") },
    ),
  );
  assert.match(markdown, /\*\*No earlier runs to compare against\*\*/);

  const empty = presetComparisonMarkdown(
    comparePresetHistory(
      records,
      { since: Date.parse("2026-12-01T00:00:00Z") },
      { since: Date.parse("2026-10-01T00:00:00Z"), until: Date.parse("2026-10-08T00:00:00Z") },
    ),
  );
  assert.match(empty, /\*\*No runs in the current window\*\*/);
});

test("presetHistoryCsv exports one row per preset with blanks for missing values", () => {
  const summary = summarizePresetHistory([
    record("2026-11-10T06:17:00.000Z", [
      endpoint("base", 8453),
      endpoint("polygon", 137, {
        ok: false,
        latencyMs: null,
        blockNumber: null,
        error: "down",
      }),
    ]),
  ]);
  const lines = presetHistoryCsv(summary).split("\n");

  assert.equal(
    lines[0],
    "preset,chain,native,runs,healthy,failed,failovers,uptime_pct,p50_latency_ms,max_latency_ms,last_run,last_failure",
  );
  assert.equal(lines[1], "base,8453,ETH,1,1,0,0,100,100,100,2026-11-10T06:17:00.000Z,");
  assert.equal(
    lines[2],
    "polygon,137,POL,1,0,1,0,0,,,2026-11-10T06:17:00.000Z,2026-11-10T06:17:00.000Z",
  );
  assert.equal(lines.length, 3, "no trailing blank line");
});

test("presetHistoryCsv follows the window it is given", () => {
  const summary = summarizePresetHistory(
    [
      record("2026-11-09T06:17:00.000Z", [
        endpoint("base", 8453, { ok: false, latencyMs: null, blockNumber: null, error: "down" }),
      ]),
      record("2026-11-10T06:17:00.000Z", [endpoint("base", 8453, { latencyMs: 40 })]),
    ],
    { since: Date.parse("2026-11-10T00:00:00Z") },
  );

  assert.equal(
    presetHistoryCsv(summary).split("\n")[1],
    "base,8453,ETH,1,1,0,0,100,40,40,2026-11-10T06:17:00.000Z,",
  );
});

test("presetHistoryTimelineCsv exports one row per preset per run, oldest first", () => {
  const lines = presetHistoryTimelineCsv([
    record("2026-11-10T06:17:00.000Z", [
      endpoint("base", 8453, { latencyMs: 100 }),
      endpoint("ethereum", 1, { latencyMs: 150 }),
    ]),
    record("2026-11-09T06:17:00.000Z", [
      endpoint("base", 8453, {
        viaFallback: true,
        primaryError: "HTTP request failed.",
        rpcHost: "base-rpc.publicnode.com",
        latencyMs: 5000,
        blockNumber: 1100n,
      }),
      endpoint("ethereum", 1, {
        ok: false,
        latencyMs: null,
        blockNumber: null,
        rpcHost: "ethereum.example.org",
        error: "both endpoints failed for ethereum (1)",
      }),
    ]),
  ]).split("\n");

  assert.equal(
    lines[0],
    "at,preset,chain,native,ok,via,latency_ms,block_number,rpc_host,error,primary_error",
  );
  assert.equal(
    lines[1],
    "2026-11-09T06:17:00.000Z,base,8453,ETH,true,backup,5000,1100,base-rpc.publicnode.com,,HTTP request failed.",
  );
  assert.equal(
    lines[2],
    "2026-11-09T06:17:00.000Z,ethereum,1,ETH,false,,,,ethereum.example.org,both endpoints failed for ethereum (1),",
  );
  assert.equal(
    lines[3],
    "2026-11-10T06:17:00.000Z,base,8453,ETH,true,primary,100,1000,primary.example.org,,",
  );
  assert.equal(lines.length, 5);
});

test("presetHistoryTimelineCsv follows the window it is given", () => {
  const records = [
    record("2026-11-09T06:17:00.000Z", [endpoint("base", 8453)]),
    record("2026-11-10T06:17:00.000Z", [endpoint("base", 8453)]),
  ];

  const limited = presetHistoryTimelineCsv(records, { limit: 1 }).split("\n");
  assert.equal(limited.length, 2);
  assert.match(limited[1] ?? "", /^2026-11-10T06:17:00\.000Z,base,/);

  const since = presetHistoryTimelineCsv(records, {
    since: Date.parse("2026-11-10T00:00:00Z"),
  }).split("\n");
  assert.equal(since.length, 2);
  assert.match(since[1] ?? "", /^2026-11-10T06:17:00\.000Z,base,/);
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
