#!/usr/bin/env node
// Blocks a commit when the recorded preset history fails its uptime gate.
//
// It reads what `lwc presets --history` wrote, judges the selected window with
// the same `presetHistoryCheck` behind `lwc presets-history --check`, and exits
// on the verdict. It writes nothing, sends no credential and makes no RPC call.
//
// usage:
//   node scripts/pre-commit-presets.mjs --history .lwc-history/presets.jsonl \
//     --since 7d --fail-under 95
//
// Exit codes are the contract a hook relies on:
//   0  the gate passed, or there is no history yet to gate
//   1  the gate failed, so the commit is blocked
//   2  the hook itself is misconfigured, which also blocks the commit
//
// Success is silent in the default mode. A failure prints the same report
// `--check` prints. --json writes one JSON document to stdout in every
// outcome and keeps the explanation on stderr, so a wrapper can parse stdout.
// --strict-missing fails when the history file is absent instead of skipping.
import {
  PresetsHistoryArgError,
  formatPresetHistoryCheck,
  parsePresetHistoryArgs,
  parseRetentionMs,
  presetHistoryCheck,
  readPresetHistoryFile,
  summarizePresetHistory,
} from "../src/presets-history.ts";

const DEFAULT_HISTORY = ".lwc-history/presets.jsonl";
const DEFAULT_THRESHOLD = "95";

function usage(message) {
  console.error(`usage error: ${message}`);
  console.error(
    "  example: node scripts/pre-commit-presets.mjs --history .lwc-history/presets.jsonl --since 7d --fail-under 95",
  );
  process.exit(2);
}

let history = process.env.LWC_PRESETS_HISTORY || DEFAULT_HISTORY;
let thresholdRaw = process.env.LWC_FAIL_UNDER?.trim() || null;
let strictMissing = false;
let json = false;
const passthrough = [];
const argv = process.argv.slice(2);

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? "";
  const readValue = (flag) => {
    const value = argv[index + 1];
    if (!value) usage(`${flag} requires a value.`);
    index += 1;
    return value;
  };

  if (arg === "--history" || arg.startsWith("--history=")) {
    history = arg.startsWith("--history=")
      ? arg.slice("--history=".length)
      : readValue("--history");
    if (!history) usage("--history requires a path.");
  } else if (arg === "--strict-missing") {
    strictMissing = true;
  } else if (arg === "--json") {
    json = true;
  } else if (arg === "--fail-under" || arg.startsWith("--fail-under=")) {
    thresholdRaw = arg.startsWith("--fail-under=")
      ? arg.slice("--fail-under=".length)
      : readValue("--fail-under");
  } else if (arg === "--check" || arg === "--quiet") {
    // The hook always checks, and is already quiet when the gate passes.
  } else {
    passthrough.push(arg);
  }
}

if (thresholdRaw === null || thresholdRaw === "") {
  usage("--fail-under (or LWC_FAIL_UNDER) is required; the threshold is never guessed.");
}

let args;
try {
  args = parsePresetHistoryArgs([
    history,
    ...passthrough,
    "--check",
    "--fail-under",
    thresholdRaw || DEFAULT_THRESHOLD,
  ]);
} catch (error) {
  if (error instanceof PresetsHistoryArgError) usage(error.message);
  throw error;
}

// Merging is a separate operation with its own output; a hook that silently
// gated a union would judge something other than the file it names.
if (args.merge.length > 0 || args.out !== null) {
  usage("the hook gates one history file; merge the copies before committing.");
}
if (args.failUnder === null) usage("--fail-under (or LWC_FAIL_UNDER) is required.");

let file;
try {
  file = readPresetHistoryFile(args.path);
} catch (error) {
  if (error?.code === "ENOENT") {
    if (strictMissing) {
      console.error(`error: no preset history at ${args.path}; --strict-missing was requested.`);
      process.exit(1);
    }
    console.error(
      `presets: no history at ${args.path}; skipping the preset gate (pass --strict-missing to fail instead).`,
    );
    process.exit(0);
  }
  console.error(
    `error: could not read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

// The file's header is what it was actually trimmed to; RETAIN_WINDOW is the
// fallback for copies from before that header existed, as in the CI gate.
let retainMs = file.retainMs;
const retainRaw = process.env.RETAIN_WINDOW ?? "";
if (retainMs === null && retainRaw !== "") {
  try {
    retainMs = parseRetentionMs(retainRaw);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
}

const summary = summarizePresetHistory(
  file.records,
  { since: args.since, until: args.until, limit: args.limit },
  { retainMs },
);
const check = presetHistoryCheck(args.path, summary, args.failUnder);

if (json) console.log(JSON.stringify(check, null, 2));
if (check.gate.passed) process.exit(0);

if (json) {
  // The report stays on stderr so stdout is still a single parsed document.
  const shortfalls =
    check.runs === 0
      ? [
          `no runs in the window (${check.coverage.recorded} recorded), so ${check.gate.threshold}% cannot be verified.`,
        ]
      : check.gate.shortfalls.map(
          (row) =>
            `${row.preset} uptime ${row.uptimePct}% over ${row.runs} run${row.runs === 1 ? "" : "s"} is below ${check.gate.threshold}%.`,
        );
  for (const line of shortfalls) console.error(`error: ${line}`);
} else {
  console.error(formatPresetHistoryCheck(check));
}
process.exit(1);
