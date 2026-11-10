import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  COMPARE_HISTORY_CSV_HEADER,
  CompareHistoryArgError,
  compareHistoryCsv,
  formatCompareHistory,
  parseCompareHistoryArgs,
  readCompareLog,
  saveCompareHistoryCsv,
  summarizeCompareLog,
  toCompareHistoryJson,
} from "./compare-history.ts";

function run(
  at: string,
  options: {
    drpcWins: number;
    okxWins: number;
    drpcDelay: number | null;
    okxDelay: number | null;
  },
): string {
  return JSON.stringify({
    session: `s-${at}`,
    event: "compare",
    at,
    chain: { id: 196, name: "xlayer" },
    samples: 5,
    intervalMs: 1000,
    newBlocks: 4,
    endpoints: [
      {
        url: "https://xlayer.drpc.org",
        label: "drpc",
        ok: true,
        delivery: { wins: options.drpcWins, observed: 4, misses: 0, p50Ms: options.drpcDelay },
        errors: 0,
      },
      {
        url: "https://xlayerrpc.okx.com",
        label: "okx",
        ok: true,
        delivery: { wins: options.okxWins, observed: 4, misses: 0, p50Ms: options.okxDelay },
        errors: 0,
      },
    ],
  });
}

const LOG = [
  run("2026-11-09T12:00:00.000Z", { drpcWins: 3, okxWins: 1, drpcDelay: 0, okxDelay: 40 }),
  run("2026-11-09T12:05:00.000Z", { drpcWins: 2, okxWins: 2, drpcDelay: 10, okxDelay: null }),
  run("2026-11-09T12:10:00.000Z", { drpcWins: 4, okxWins: 0, drpcDelay: 20, okxDelay: 30 }),
  "not json",
  JSON.stringify({ session: "missing-at", event: "compare" }),
].join("\n");

test("summarizes wins and median head delay across runs", () => {
  const report = summarizeCompareLog(LOG);

  assert.equal(report.runs.length, 3);
  assert.equal(report.newBlocks, 12);
  assert.equal(report.skippedLines, 2);
  assert.equal(report.firstAt, Date.parse("2026-11-09T12:00:00.000Z"));
  assert.equal(report.lastAt, Date.parse("2026-11-09T12:10:00.000Z"));
  assert.deepEqual(report.chains, [{ id: 196, name: "xlayer" }]);

  const [drpc, okx] = report.providers;
  assert.equal(drpc?.name, "drpc");
  assert.equal(drpc?.runs, 3);
  assert.equal(drpc?.wins, 9);
  assert.equal(drpc?.winRate, 0.75);
  assert.equal(drpc?.delayMs, 10, "median of the run medians 0, 10, 20");
  assert.equal(drpc?.lastDelayMs, 20);
  assert.equal(drpc?.lastSeen, Date.parse("2026-11-09T12:10:00.000Z"));

  assert.equal(okx?.name, "okx");
  assert.equal(okx?.wins, 3);
  assert.equal(okx?.winRate, 0.25);
  assert.equal(okx?.delayMs, 35, "even count averages the middle medians 30 and 40");
  assert.equal(okx?.lastDelayMs, 30, "the newest run that observed heads");
});

test("format renders the provider summary and skipped count", () => {
  const text = formatCompareHistory({
    path: "./compare.ndjson",
    ...summarizeCompareLog(LOG),
  });

  assert.match(text, /lwc — compare history/);
  assert.match(text, /runs\s+3 \(2026-11-09T12:00:00\.000Z → 2026-11-09T12:10:00\.000Z\)/);
  assert.match(text, /new blocks\s+12/);
  assert.match(text, /chain\s+xlayer \(196\)/);
  assert.match(text, /2 malformed line\(s\)/);
  assert.match(text, /drpc\s+3\s+9\s+75%\s+10ms\s+20ms\s+11-09 12:10/);
  assert.match(text, /okx\s+3\s+3\s+25%\s+35ms\s+30ms\s+11-09 12:10/);
});

test("JSON adds the per-run series", () => {
  const json = toCompareHistoryJson({
    path: "./compare.ndjson",
    ...summarizeCompareLog(LOG),
  }) as {
    runs: number;
    newBlocks: number;
    providers: Array<{ name: string; wins: number; delayMs: number | null }>;
    history: Array<{
      at: string;
      newBlocks: number;
      endpoints: Array<{ label: string | null; wins: number; delayMs: number | null }>;
    }>;
  };

  assert.equal(json.runs, 3);
  assert.equal(json.newBlocks, 12);
  assert.equal(json.providers[0]?.delayMs, 10);
  assert.equal(json.history.length, 3);
  assert.equal(json.history[0]?.at, "2026-11-09T12:00:00.000Z");
  assert.equal(json.history[0]?.newBlocks, 4);
  assert.equal(json.history[0]?.endpoints[0]?.label, "drpc");
  assert.equal(json.history[0]?.endpoints[0]?.wins, 3);
  assert.equal(json.history[2]?.endpoints[1]?.delayMs, 30);
});

test("exports one CSV row per run and provider", () => {
  const csv = compareHistoryCsv(summarizeCompareLog(LOG));
  const lines = csv.trimEnd().split("\n");

  assert.equal(lines[0], COMPARE_HISTORY_CSV_HEADER.join(","));
  assert.equal(lines.length, 7, "3 runs × 2 providers plus the header");
  assert.equal(
    lines[1],
    "s-2026-11-09T12:00:00.000Z,2026-11-09T12:00:00.000Z,xlayer,196,5,4,drpc,https://xlayer.drpc.org,3,4,0,0,0,true",
  );
  assert.equal(
    lines[2],
    "s-2026-11-09T12:00:00.000Z,2026-11-09T12:00:00.000Z,xlayer,196,5,4,okx,https://xlayerrpc.okx.com,1,4,0,40,0,true",
  );
  assert.ok(
    csv.includes("okx,https://xlayerrpc.okx.com,2,4,0,,0,true"),
    "an unobserved delay leaves the cell empty",
  );
});

function csvLog(): string {
  return JSON.stringify({
    session: "s1",
    event: "compare",
    at: "2026-11-09T12:00:00.000Z",
    chain: { id: 196, name: "xlayer" },
    samples: 5,
    newBlocks: 4,
    endpoints: [
      {
        url: "https://rpc.example.org/a,b",
        label: null,
        ok: false,
        delivery: { wins: 0, observed: 0, misses: 4, p50Ms: null },
        errors: 2,
      },
    ],
  });
}

function writeTemp(contents: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lwc-compare-csv-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CSV quotes URLs and falls back to the URL without a label", () => {
  const csv = compareHistoryCsv(summarizeCompareLog(csvLog()));

  assert.match(csv, /,"https:\/\/rpc\.example\.org\/a,b",0,0,4,,2,false/);
  assert.match(csv, /^s1,2026-11-09T12:00:00\.000Z,xlayer,196,5,4,/m);
});

test("writes the CSV to a nested path", () => {
  writeTemp(csvLog(), (dir) => {
    const path = join(dir, "nested", "providers.csv");
    saveCompareHistoryCsv(path, compareHistoryCsv(summarizeCompareLog(csvLog())));

    assert.match(readFileSync(path, "utf8"), /^session,at,chain,chain_id,samples,new_blocks/);
  });
});

test("an empty log is a summary with no records", () => {
  const report = { path: "./empty.ndjson", ...summarizeCompareLog("\n") };

  assert.equal(report.runs.length, 0);
  assert.deepEqual(report.providers, []);
  assert.match(formatCompareHistory(report), /\(no compare records\)/);
});

test("requires a path and rejects extras and missing files", () => {
  assert.deepEqual(parseCompareHistoryArgs(["./compare.ndjson", "--json"]), {
    path: "./compare.ndjson",
    csvPath: null,
  });
  assert.equal(
    parseCompareHistoryArgs(["./c.ndjson", "--csv", "providers.csv"]).csvPath,
    "providers.csv",
  );
  assert.equal(parseCompareHistoryArgs(["./c.ndjson", "--csv=-"]).csvPath, "-");
  assert.throws(() => parseCompareHistoryArgs([]), CompareHistoryArgError);
  assert.throws(
    () => parseCompareHistoryArgs(["./a.ndjson", "./b.ndjson"]),
    /Unexpected extra argument/,
  );
  assert.throws(
    () => parseCompareHistoryArgs(["./a.ndjson", "--csv"]),
    /--csv requires a path/,
  );
  assert.throws(
    () => parseCompareHistoryArgs(["./a.ndjson", "--csv", "--json"]),
    /--csv requires a path/,
  );

  const dir = mkdtempSync(join(tmpdir(), "lwc-compare-history-"));
  try {
    assert.throws(
      () => readCompareLog(join(dir, "missing.ndjson")),
      /compare log not found/,
    );

    const path = join(dir, "compare.ndjson");
    writeFileSync(path, LOG);
    assert.equal(readCompareLog(path), LOG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
