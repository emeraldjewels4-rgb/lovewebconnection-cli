import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SESSIONS_CSV_HEADER,
  SessionsArgError,
  formatSessions,
  parseSessionsArgs,
  saveSessionsCsv,
  sessionsCsv,
  summarizeWatchLog,
  toSessionsJson,
} from "./sessions.ts";

function line(session: string, event: string, at: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ session, event, at, ...extra });
}

const SESSION_A = "m1abc2-x9y8z";
const SESSION_B = "m1def4-q1w2e";
const RPC = "https://xlayer.drpc.org";

function logText(): string {
  return [
    line(SESSION_A, "start", "2026-11-09T12:00:00.000Z", {
      chain: { id: 196, name: "xlayer" },
      endpoint: RPC,
      options: { intervalMs: 3000 },
    }),
    line(SESSION_A, "advance", "2026-11-09T12:00:03.000Z", {
      blockNumber: "100",
      delta: "0",
      latencyMs: 100,
    }),
    line(SESSION_A, "advance", "2026-11-09T12:00:06.000Z", {
      blockNumber: "101",
      delta: "1",
      latencyMs: 200,
    }),
    line(SESSION_A, "hold", "2026-11-09T12:00:09.000Z", {
      blockNumber: "101",
      staleSeconds: 3,
      latencyMs: 300,
    }),
    line(SESSION_A, "advance", "2026-11-09T12:00:12.000Z", {
      blockNumber: "102",
      delta: "1",
      latencyMs: 400,
    }),
    line(SESSION_A, "stall", "2026-11-09T12:00:40.000Z", {
      blockNumber: "102",
      staleSeconds: 28,
    }),
    line(SESSION_A, "gas-surge", "2026-11-09T12:00:40.000Z", {
      gasPriceWei: "63000000",
      baselineWei: "21000000",
      increasePercent: 200,
    }),
    // A real summary line carries no `at`: watch writes it from the in-memory summary.
    JSON.stringify({
      session: SESSION_A,
      event: "summary",
      samples: 4,
      errors: 1,
      firstBlock: "100",
      lastBlock: "102",
      advancedBy: "2",
      chainDrift: false,
      stalls: 1,
      gasSurges: 1,
      alerts: 0,
      durationMs: 42_000,
      aborted: false,
    }),
    "",
    line(SESSION_B, "start", "2026-11-09T12:10:00.000Z", {
      chain: { id: 196, name: "xlayer" },
      endpoint: RPC,
    }),
    line(SESSION_B, "advance", "2026-11-09T12:10:03.000Z", {
      blockNumber: "200",
      delta: "0",
      latencyMs: 500,
    }),
    line(SESSION_B, "error", "2026-11-09T12:10:04.000Z", { message: "socket hang up" }),
    "{not json",
    JSON.stringify({ event: "error", at: "2026-11-09T12:10:05.000Z", message: "no session" }),
  ].join("\n");
}

test("groups lines by session and derives percentiles from every poll", () => {
  const { sessions, skippedLines } = summarizeWatchLog(logText());

  assert.equal(sessions.length, 2);
  assert.equal(skippedLines, 2, "malformed JSON and a line without a session are skipped");

  const [first, second] = sessions;
  assert.equal(first?.id, SESSION_A);
  assert.equal(first?.state, "complete");
  assert.equal(first?.samples, 4);
  assert.deepEqual(first?.latency, { count: 4, p50: 200, p95: 400, max: 400 });
  assert.deepEqual(first?.blockTime, { count: 2, medianSeconds: 3, minSeconds: 3, maxSeconds: 6 });
  assert.equal(first?.stalls, 1);
  assert.equal(first?.gasSurges, 1);
  assert.equal(first?.errors, 1);
  assert.equal(first?.chainDrift, false);
  assert.equal(first?.durationMs, 42_000);
  assert.equal(first?.startedAt, Date.parse("2026-11-09T12:00:00.000Z"));
  assert.equal(first?.endedAt, Date.parse("2026-11-09T12:00:42.000Z"));
  assert.deepEqual(first?.chain, { id: 196, name: "xlayer" });
  assert.equal(first?.endpoint, RPC);
  assert.equal(first?.firstBlock, 100n);
  assert.equal(first?.lastBlock, 102n);
  assert.equal(first?.advancedBy, 2n);

  assert.equal(second?.id, SESSION_B);
  assert.equal(second?.state, "partial", "no summary line means the run did not finish cleanly");
  assert.equal(second?.samples, 1);
  assert.deepEqual(second?.latency, { count: 1, p50: 500, p95: 500, max: 500 });
  assert.equal(second?.errors, 1);
  assert.equal(second?.durationMs, 4_000, "falls back to the span of the logged events");
});

test("orders sessions chronologically and handles an empty log", () => {
  const reversed = [
    logText(),
    // Appending a third session that starts earlier must sort to the front.
  ].join("\n");
  const { sessions } = summarizeWatchLog(reversed);
  assert.deepEqual(
    sessions.map((session) => session.id),
    [SESSION_A, SESSION_B],
  );

  const empty = summarizeWatchLog("\n\n");
  assert.deepEqual(empty, { sessions: [], endpoints: [], skippedLines: 0 });
});

test("formatSessions shows a comparison row per session", () => {
  const report = { path: "./watch.ndjson", ...summarizeWatchLog(logText()) };
  const text = formatSessions(report);

  assert.match(text, /lwc — watch sessions/);
  assert.match(text, /\.\/watch\.ndjson/);
  assert.match(text, /2 \(1 partial\)/);
  assert.match(text, /2 malformed line\(s\)/);
  assert.ok(text.includes(`${SESSION_A}`) && text.includes("xlayer (196)") && text.includes("xlayer.drpc.org") && text.includes("11-09 12:00:00"), "row shows session, chain, endpoint, and start time");
  assert.match(text, /\s200\s+400\s+1\s+1\s+1\s+complete/);
  assert.match(text, new RegExp(`${SESSION_B}.*partial`));
  assert.match(text, /by endpoint/);
  assert.match(text, /xlayer\.drpc\.org\s+2\s+5\s+300\s+500\s+1\s+20\.0%/);
});

test("exports one CSV row per session", () => {
  const csv = sessionsCsv(summarizeWatchLog(logText()));
  const lines = csv.trimEnd().split("\n");

  assert.equal(lines[0], SESSIONS_CSV_HEADER.join(","));
  assert.equal(lines.length, 3, "two sessions plus the header");
  assert.equal(
    lines[1],
    "m1abc2-x9y8z,2026-11-09T12:00:00.000Z,2026-11-09T12:00:42.000Z,complete,xlayer,196,https://xlayer.drpc.org,42000,4,200,400,400,3,3,6,1,1,0,1,false,100,102,2",
  );
  assert.equal(
    lines[2],
    "m1def4-q1w2e,2026-11-09T12:10:00.000Z,2026-11-09T12:10:04.000Z,partial,xlayer,196,https://xlayer.drpc.org,4000,1,500,500,500,,,,0,0,0,1,false,200,200,0",
    "a session with no block-time samples leaves those cells empty",
  );
  assert.ok(csv.endsWith("\n"));
});

test("CSV quotes session ids and endpoints containing commas", () => {
  const log = [
    line("s,1", "start", "2026-11-09T12:00:00.000Z", {
      chain: { id: 196, name: "xlayer" },
      endpoint: "https://rpc.example.org/a,b",
    }),
    line("s,1", "advance", "2026-11-09T12:00:03.000Z", {
      blockNumber: "1",
      delta: "1",
      latencyMs: 5,
    }),
  ].join("\n");

  const csv = sessionsCsv(summarizeWatchLog(log));
  assert.match(csv, /^"s,1",/m);
  assert.ok(csv.includes('"https://rpc.example.org/a,b"'));
});

test("writes the sessions CSV to a nested path", () => {
  const dir = mkdtempSync(join(tmpdir(), "lwc-sessions-csv-"));
  try {
    const path = join(dir, "nested", "sessions.csv");
    saveSessionsCsv(path, sessionsCsv(summarizeWatchLog(logText())));

    assert.match(readFileSync(path, "utf8"), /^session,started_at,ended_at,state/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregates sessions by RPC endpoint with pooled percentiles", () => {
  const { endpoints } = summarizeWatchLog(logText());

  assert.equal(endpoints.length, 1, "both runs used the same provider");
  const [only] = endpoints;
  assert.equal(only?.endpoint, "xlayer.drpc.org");
  assert.equal(only?.sessions, 2);
  assert.equal(only?.samples, 5);
  assert.deepEqual(only?.latency, { count: 5, p50: 300, p95: 500, max: 500 });
  assert.equal(only?.stalls, 1);
  assert.equal(only?.stallRate, 0.2);
  assert.equal(only?.errors, 2);
});

test("compares providers on pooled latency and stall rate", () => {
  const log = [
    line("a1", "start", "2026-11-09T12:00:00.000Z", { endpoint: "https://a.example" }),
    line("a1", "advance", "2026-11-09T12:00:03.000Z", {
      blockNumber: "1",
      delta: "1",
      latencyMs: 100,
    }),
    line("a1", "stall", "2026-11-09T12:00:09.000Z", { blockNumber: "1", staleSeconds: 6 }),
    line("a2", "start", "2026-11-09T12:00:10.000Z", { endpoint: "https://a.example" }),
    line("a2", "advance", "2026-11-09T12:00:13.000Z", {
      blockNumber: "2",
      delta: "1",
      latencyMs: 300,
    }),
    line("b1", "start", "2026-11-09T12:00:20.000Z", { endpoint: "https://b.example" }),
    line("b1", "advance", "2026-11-09T12:00:23.000Z", {
      blockNumber: "3",
      delta: "1",
      latencyMs: 500,
    }),
  ].join("\n");

  const { endpoints } = summarizeWatchLog(log);

  assert.deepEqual(
    endpoints.map((item) => [item.endpoint, item.sessions, item.samples, item.stallRate]),
    [
      ["a.example", 2, 2, 0.5],
      ["b.example", 1, 1, 0],
    ],
    "busiest provider first, stalls divided by polls",
  );
  assert.equal(endpoints[0]?.latency.p50, 100);
  assert.equal(endpoints[0]?.latency.p95, 300);
  assert.equal(endpoints[1]?.latency.p95, 500);
  assert.equal(endpoints[0]?.stalls, 1);
});

test("shows ? for sessions logged before endpoints were recorded", () => {
  const legacy = JSON.stringify({
    session: "old",
    event: "start",
    at: "2026-11-09T11:00:00.000Z",
    chain: { id: 196, name: "xlayer" },
  });
  const summary = summarizeWatchLog(legacy);
  const { sessions } = summary;

  assert.equal(sessions[0]?.endpoint, null);
  assert.match(
    formatSessions({ path: "w.ndjson", ...summary }),
    /old\s+xlayer \(196\)\s+\?/,
  );
});

test("toSessionsJson serialises bigints and marks partial runs", () => {
  const report = { path: "./watch.ndjson", ...summarizeWatchLog(logText()) };
  const json = toSessionsJson(report);

  assert.equal(json.ok, false, "a partial session makes the report incomplete");
  assert.equal(json.skippedLines, 2);
  const sessions = json.sessions as Array<Record<string, unknown>>;
  assert.equal(sessions[0]?.advancedBy, "2");
  assert.equal(sessions[0]?.endpoint, RPC);
  assert.equal(sessions[0]?.firstBlock, "100");
  assert.equal(sessions[0]?.startedAt, "2026-11-09T12:00:00.000Z");
  assert.equal((sessions[1]?.latency as Record<string, unknown>).p95, 500);

  const endpoints = json.endpoints as Array<Record<string, unknown>>;
  assert.equal(endpoints[0]?.endpoint, "xlayer.drpc.org");
  assert.equal(endpoints[0]?.sessions, 2);
  assert.equal(endpoints[0]?.samples, 5);
  assert.equal(endpoints[0]?.stallRate, 0.2);
  assert.equal((endpoints[0]?.latency as Record<string, unknown>).p95, 500);
});

test("narrows a long log by session prefix before comparing", () => {
  const { sessions, skippedLines } = summarizeWatchLog(logText(), {
    sessionPrefixes: ["m1abc2"],
  });

  assert.deepEqual(sessions.map((session) => session.id), [SESSION_A]);
  assert.equal(skippedLines, 2, "malformed lines are still counted");

  const both = summarizeWatchLog(logText(), {
    sessionPrefixes: ["m1abc2", "m1def"],
  });
  assert.equal(both.sessions.length, 2, "repeated prefixes are OR-ed");
});

test("keeps only sessions that started at or after --since", () => {
  const since = Date.parse("2026-11-09T12:05:00.000Z");
  const { sessions } = summarizeWatchLog(logText(), { since });

  assert.deepEqual(sessions.map((session) => session.id), [SESSION_B]);
  assert.deepEqual(
    summarizeWatchLog(logText(), { since: Date.parse("2026-11-09T12:10:00.000Z") }).sessions.map(
      (session) => session.id,
    ),
    [SESSION_B],
    "the threshold is inclusive",
  );
});

test("a session with no timestamps is dropped by --since", () => {
  const undated = JSON.stringify({
    session: "no-date",
    event: "advance",
    blockNumber: "1",
    delta: "1",
  });

  assert.equal(summarizeWatchLog(undated).sessions.length, 1);
  assert.equal(summarizeWatchLog(undated, { since: 0 }).sessions.length, 0);
});

test("parses --since as an ISO time or a relative span", () => {
  assert.equal(
    parseSessionsArgs(["./w.ndjson", "--since", "2026-11-09T12:00:00Z"]).since,
    Date.parse("2026-11-09T12:00:00Z"),
  );

  const relative = parseSessionsArgs(["./w.ndjson", "--since=2h"]).since;
  assert.ok(relative !== null);
  assert.ok(
    Math.abs(Date.now() - 2 * 3_600_000 - relative) < 2_000,
    "a span is measured back from now",
  );
});

test("parses --csv as a file or stdout", () => {
  assert.equal(parseSessionsArgs(["./w.ndjson", "--csv", "-"]).csvPath, "-");
  assert.equal(
    parseSessionsArgs(["./w.ndjson", "--csv=./sessions.csv"]).csvPath,
    "./sessions.csv",
  );
  assert.throws(
    () => parseSessionsArgs(["./w.ndjson", "--csv"]),
    (error: unknown) => error instanceof SessionsArgError && /--csv requires/.test(error.message),
  );
  assert.throws(
    () => parseSessionsArgs(["./w.ndjson", "--csv", "--json"]),
    (error: unknown) => error instanceof SessionsArgError && /--csv requires/.test(error.message),
  );
});

test("collects repeated --session prefixes", () => {
  const parsed = parseSessionsArgs(["./w.ndjson", "--session", "m1abc2", "--session=m1def4"]);

  assert.deepEqual(parsed.sessionPrefixes, ["m1abc2", "m1def4"]);
  assert.throws(
    () => parseSessionsArgs(["./w.ndjson", "--since", "soon"]),
    (error: unknown) => error instanceof SessionsArgError && /ISO timestamp or a span/.test(error.message),
  );
  assert.throws(() => parseSessionsArgs(["./w.ndjson", "--since"]), SessionsArgError);
  assert.throws(() => parseSessionsArgs(["./w.ndjson", "--session"]), SessionsArgError);
});

test("parseSessionsArgs requires exactly one log path", () => {
  assert.deepEqual(parseSessionsArgs(["./watch.ndjson"]), {
    path: "./watch.ndjson",
    since: null,
    sessionPrefixes: [],
    csvPath: null,
  });
  assert.deepEqual(parseSessionsArgs(["./watch.ndjson", "--json"]), {
    path: "./watch.ndjson",
    since: null,
    sessionPrefixes: [],
    csvPath: null,
  });

  assert.throws(
    () => parseSessionsArgs([]),
    (error: unknown) => error instanceof SessionsArgError && /log path is required/.test(error.message),
  );
  assert.throws(
    () => parseSessionsArgs(["a.ndjson", "b.ndjson"]),
    (error: unknown) => error instanceof SessionsArgError && /extra argument/.test(error.message),
  );
});
