import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  HISTORY_CSV_HEADER,
  HistoryArgError,
  extractBalanceHistory,
  formatHistory,
  historyCsv,
  historyWideCsv,
  parseHistoryArgs,
  saveHistoryCsv,
  toHistoryJson,
} from "./history.ts";

const USDT = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";
const WOKB = "0xe538905cf8410324e03A5A23C1c177a474D59b2b";

const LOG = [
  JSON.stringify({ session: "s1", event: "start", at: "2026-11-09T12:00:00.000Z" }),
  JSON.stringify({
    session: "s1",
    event: "advance",
    at: "2026-11-09T12:00:01.000Z",
    blockNumber: "100",
    delta: "1",
  }),
  JSON.stringify({
    session: "s1",
    event: "portfolio",
    at: "2026-11-09T12:00:01.000Z",
    blockNumber: "100",
    native: {
      symbol: "OKB",
      decimals: 18,
      balance: "1000000000000000000",
      delta: null,
      usd: 100.5,
    },
    tokens: [
      {
        address: USDT,
        symbol: "USDT",
        label: "Tether, USD",
        decimals: 6,
        balance: "1000000",
        delta: null,
        usd: 1,
      },
      {
        address: WOKB,
        symbol: "WOKB",
        label: null,
        decimals: null,
        balance: "7",
        delta: null,
        usd: null,
      },
    ],
    usdTotal: 101.5,
    error: null,
  }),
  JSON.stringify({
    session: "s1",
    event: "portfolio",
    at: "2026-11-09T12:00:31.000Z",
    blockNumber: "101",
    native: {
      symbol: "OKB",
      decimals: 18,
      balance: "900000000000000000",
      delta: "-100000000000000000",
      usd: 90.5,
    },
    tokens: [
      {
        address: USDT,
        symbol: "USDT",
        label: "Tether, USD",
        decimals: 6,
        balance: "2500000",
        delta: "1500000",
        usd: 2.5,
      },
      {
        address: WOKB,
        symbol: "WOKB",
        label: null,
        decimals: null,
        balance: "9",
        delta: "2",
        usd: null,
      },
    ],
    usdTotal: 93,
    error: null,
  }),
  JSON.stringify({
    session: "s1",
    event: "portfolio",
    at: "2026-11-09T12:01:01.000Z",
    blockNumber: null,
    native: null,
    tokens: [],
    error: "balances unavailable",
  }),
  JSON.stringify({
    session: "s2",
    event: "portfolio",
    at: "2026-11-09T13:00:00.000Z",
    blockNumber: "200",
    native: {
      symbol: "OKB",
      decimals: 18,
      balance: "500000000000000000",
      delta: null,
      usd: 50,
    },
    tokens: [],
    usdTotal: 50,
    error: null,
  }),
  "{not json",
].join("\n");

test("extracts one row per asset per portfolio sample", () => {
  const report = extractBalanceHistory(LOG);

  assert.equal(report.rows.length, 7, "3 native rows plus 4 token rows");
  assert.deepEqual(report.sessions, ["s1", "s2"]);
  assert.equal(report.skippedSamples, 1, "the errored sample has no balances");
  assert.equal(report.skippedLines, 1, "the malformed line is counted");

  const native = report.rows[0];
  assert.equal(native?.asset, "native");
  assert.equal(native?.address, null);
  assert.equal(native?.symbol, "OKB");
  assert.equal(native?.decimals, 18);
  assert.equal(native?.balance, 10n ** 18n);
  assert.equal(native?.delta, null, "the first sample has no previous reading");

  const usdt = report.rows[1];
  assert.equal(usdt?.asset, "token");
  assert.equal(usdt?.address, USDT);
  assert.equal(usdt?.label, "Tether, USD");
  assert.equal(usdt?.blockNumber, 100n);
  assert.equal(usdt?.balance, 1_000_000n);

  const later = report.rows.find(
    (row) => row.asset === "native" && row.blockNumber === 101n,
  );
  assert.equal(later?.delta, -100_000_000_000_000_000n);
});

test("writes long-format CSV with formatted amounts and quoted labels", () => {
  const csv = historyCsv(extractBalanceHistory(LOG));
  const lines = csv.trimEnd().split("\n");

  assert.equal(lines[0], HISTORY_CSV_HEADER.join(","));
  assert.equal(
    lines[1],
    "s1,2026-11-09T12:00:01.000Z,100,native,,OKB,,18,1,,100.50,101.50",
  );
  assert.ok(csv.includes('"Tether, USD"'), "a label with a comma stays one cell");
  assert.ok(csv.includes(",0.9,-0.1,90.50,93.00"), "native balance and change are human units");
  assert.ok(csv.includes(",2.5,1.5,2.50,93.00"), "token amounts are scaled by decimals");
  assert.ok(csv.includes(",9,2,,"), "an unpriced token keeps raw units and an empty usd");
});

test("pivots to one column per asset with --wide", () => {
  const csv = historyWideCsv(extractBalanceHistory(LOG));
  const lines = csv.trimEnd().split("\n");

  assert.equal(lines[0], "session,at,block,OKB,USDT,WOKB,usd_total");
  assert.equal(lines[1], "s1,2026-11-09T12:00:01.000Z,100,1,1,7,101.50");
  assert.equal(lines[2], "s1,2026-11-09T12:00:31.000Z,101,0.9,2.5,9,93.00");
  assert.equal(
    lines[3],
    "s2,2026-11-09T13:00:00.000Z,200,0.5,,,50.00",
    "an asset absent from a sample leaves its cell empty",
  );
  assert.equal(lines.length, 4, "one row per portfolio sample");
});

test("adds optional per-asset USD columns to wide CSV", () => {
  const csv = historyWideCsv(extractBalanceHistory(LOG), { usd: true });
  const lines = csv.trimEnd().split("\n");

  assert.equal(
    lines[0],
    "session,at,block,OKB,USDT,WOKB,OKB (USD),USDT (USD),WOKB (USD),usd_total",
  );
  assert.equal(
    lines[1],
    "s1,2026-11-09T12:00:01.000Z,100,1,1,7,100.50,1.00,,101.50",
  );
  assert.equal(
    lines[2],
    "s1,2026-11-09T12:00:31.000Z,101,0.9,2.5,9,90.50,2.50,,93.00",
  );
  assert.equal(
    lines[3],
    "s2,2026-11-09T13:00:00.000Z,200,0.5,,,50.00,,,50.00",
  );
});

test("emits only the USD-valued asset columns with --usd-only", () => {
  const csv = historyWideCsv(extractBalanceHistory(LOG), { usdOnly: true });
  const lines = csv.trimEnd().split("\n");

  assert.equal(
    lines[0],
    "session,at,block,OKB (USD),USDT (USD),WOKB (USD),usd_total",
    "raw balance columns are dropped, the identifiers and total stay",
  );
  assert.equal(lines[1], "s1,2026-11-09T12:00:01.000Z,100,100.50,1.00,,101.50");
  assert.equal(lines[2], "s1,2026-11-09T12:00:31.000Z,101,90.50,2.50,,93.00");
  assert.equal(lines[3], "s2,2026-11-09T13:00:00.000Z,200,50.00,,,50.00");
  assert.equal(lines.length, 4, "one row per portfolio sample");
});

test("disambiguates assets that share a symbol in wide CSV", () => {
  const log = [
    {
      session: "s1",
      event: "portfolio",
      at: "2026-11-09T12:00:01.000Z",
      blockNumber: "1",
      native: { symbol: "USDC", decimals: 18, balance: "1" },
      tokens: [
        { address: "0x1111111111111111111111111111111111111111", symbol: "USDC", decimals: 6, balance: "2" },
        { address: "0x2222222222222222222222222222222222222222", symbol: "USDC", decimals: 6, balance: null },
      ],
      error: null,
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");

  const header = historyWideCsv(extractBalanceHistory(log)).split("\n")[0];

  assert.ok(header?.includes("USDC (native)"), header);
  assert.ok(header?.includes("USDC (0x1111…1111)"), header);
  assert.ok(header?.includes("USDC (0x2222…2222)"), header);
});

test("filters by session without counting other sessions' errors", () => {
  const only = extractBalanceHistory(LOG, { session: "s2" });

  assert.equal(only.rows.length, 1);
  assert.deepEqual(only.sessions, ["s2"]);
  assert.equal(only.skippedSamples, 0);
  assert.equal(only.skippedLines, 1, "malformed lines are still counted");
});

test("an empty log or a session-less line yields no rows", () => {
  assert.deepEqual(extractBalanceHistory(""), {
    rows: [],
    sessions: [],
    skippedSamples: 0,
    skippedLines: 0,
  });
  assert.equal(extractBalanceHistory(JSON.stringify({ event: "portfolio" })).skippedLines, 1);
  assert.match(
    formatHistory({ path: "./w.ndjson", ...extractBalanceHistory("") }),
    /no portfolio samples here/,
  );
});

test("parses the log path, CSV target, and session filter", () => {
  assert.deepEqual(parseHistoryArgs(["./watch.ndjson"]), {
    path: "./watch.ndjson",
    csvPath: null,
    session: null,
    wide: false,
    usd: false,
    usdOnly: false,
  });
  assert.equal(parseHistoryArgs(["./w.ndjson", "--csv", "-", "--wide"]).wide, true);
  assert.equal(parseHistoryArgs(["./w.ndjson", "--wide", "--csv=out.csv"]).wide, true);
  assert.equal(
    parseHistoryArgs(["./w.ndjson", "--csv", "-", "--wide", "--usd"]).usd,
    true,
  );
  assert.equal(
    parseHistoryArgs(["./w.ndjson", "--csv", "-", "--wide", "--usd-only"])
      .usdOnly,
    true,
  );
  assert.equal(parseHistoryArgs(["./w.ndjson", "--csv", "out.csv"]).csvPath, "out.csv");
  assert.equal(parseHistoryArgs(["./w.ndjson", "--csv=-"]).csvPath, "-");
  assert.equal(parseHistoryArgs(["./w.ndjson", "--session", "s1"]).session, "s1");
  assert.equal(parseHistoryArgs(["./w.ndjson", "--session=s2", "--json"]).session, "s2");

  assert.throws(() => parseHistoryArgs([]), HistoryArgError);
  assert.throws(() => parseHistoryArgs(["./w.ndjson", "./other.ndjson"]), HistoryArgError);
  assert.throws(() => parseHistoryArgs(["./w.ndjson", "--csv"]), HistoryArgError);
  assert.throws(() => parseHistoryArgs(["./w.ndjson", "--session"]), HistoryArgError);
  assert.throws(
    () => parseHistoryArgs(["./w.ndjson", "--wide"]),
    /--wide needs CSV output/,
  );
  assert.throws(
    () => parseHistoryArgs(["./w.ndjson", "--usd", "--csv", "-"]),
    /--usd needs --wide/,
  );
  assert.throws(
    () => parseHistoryArgs(["./w.ndjson", "--usd-only", "--csv", "-"]),
    /--usd-only needs --wide/,
  );
});

test("writes the CSV to a nested path", () => {
  const dir = mkdtempSync(join(tmpdir(), "lwc-history-"));
  try {
    const path = join(dir, "nested", "balances.csv");
    saveHistoryCsv(path, historyCsv({ rows: [] }));

    assert.equal(readFileSync(path, "utf8"), `${HISTORY_CSV_HEADER.join(",")}\n`);
    assert.equal(existsSync(join(dir, "nested")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formats the table and the JSON summary", () => {
  const report = { path: "./watch.ndjson", ...extractBalanceHistory(LOG) };
  const text = formatHistory(report);

  assert.match(text, /rows +7 \(3 portfolio samples, 2 sessions\)/);
  assert.match(text, /native OKB/);
  assert.match(text, /USDT \[Tether, USD\]/);
  assert.match(text, /\$101\.50/, "the table shows each asset's USD value");
  assert.match(text, /1 sample\(s\) without balances/);

  const json = toHistoryJson(report) as {
    rows: number;
    balances: Array<{ balance: string; formatted: string; at: string }>;
  };
  assert.equal(json.rows, 7);
  assert.equal(json.balances[0]?.balance, "1000000000000000000");
  assert.equal(json.balances[0]?.formatted, "1");
  assert.equal((json.balances[0] as { usd?: number }).usd, 100.5);
  assert.equal((json.balances[0] as { usdTotal?: number }).usdTotal, 101.5);
  assert.equal(json.balances[0]?.at, "2026-11-09T12:00:01.000Z");
});
