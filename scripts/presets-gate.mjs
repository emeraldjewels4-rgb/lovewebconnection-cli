#!/usr/bin/env node
// Enforces the uptime gate for the scheduled preset run and writes its outcome
// to the job summary. It reuses the same summary functions as
// `lwc presets-history`, so the CI verdict cannot drift from the CLI view.
//
// usage: node scripts/presets-gate.mjs .lwc-history/presets.jsonl --since 7d --max-age 7d --compare 14d..7d --fail-under 95
// Writes to $GITHUB_STEP_SUMMARY when set, otherwise prints to stdout.
// Exits 1 when a preset is below the threshold, the newest recorded run is
// older than --max-age (or MAX_AGE, one week by default), or the window cannot
// be checked: a healthy file nobody appends to proves nothing about today.
// --compare adds the earlier window to the summary; the verdict still comes from
// the current one, so a week-over-week delta is published without weakening the gate.
import { appendFileSync } from "node:fs";

import {
  PresetsHistoryArgError,
  comparePresetHistory,
  parseMaxAgeMs,
  parsePresetHistoryArgs,
  parseRetentionMs,
  presetComparisonMarkdown,
  presetFreshnessMarkdown,
  presetHistoryCheck,
  presetHistoryFailureReasons,
  presetRegressionWarnings,
  providerRegressionWarnings,
  readPresetHistoryFile,
  retentionWindowWarnings,
  summarizePresetGate,
  summarizePresetHistory,
} from "../src/presets-history.ts";
import { escapeAnnotation } from "../src/presets-summary.ts";

const summaryPath = process.env.GITHUB_STEP_SUMMARY;

function write(line) {
  if (summaryPath) {
    appendFileSync(summaryPath, `${line}\n`);
  } else {
    console.log(line);
  }
}

function usage(message) {
  console.error(`usage error: ${message}`);
  console.error(
    "  example: node scripts/presets-gate.mjs .lwc-history/presets.jsonl --since 7d --max-age 7d --compare 14d..7d --fail-under 95",
  );
  process.exit(1);
}

// --max-age is a gate bound rather than a history filter, so the shared parser
// rejects it without --check. Lift it out here, as the hook does, and hand it
// to the check that produces the verdict.
const argv = process.argv.slice(2);
let maxAgeRaw = process.env.MAX_AGE?.trim() || "7d";
const gateArgv = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? "";
  if (arg === "--max-age" || arg.startsWith("--max-age=")) {
    maxAgeRaw = arg.startsWith("--max-age=")
      ? arg.slice("--max-age=".length)
      : argv[++index] ?? "";
  } else {
    gateArgv.push(arg);
  }
}

let maxAgeMs;
try {
  maxAgeMs = parseMaxAgeMs(maxAgeRaw);
} catch (error) {
  if (error instanceof PresetsHistoryArgError) usage(error.message);
  throw error;
}

let args;
try {
  args = parsePresetHistoryArgs(gateArgv);
} catch (error) {
  if (error instanceof PresetsHistoryArgError) usage(error.message);
  throw error;
}

if (args.failUnder === null) usage("--fail-under is required for the gate.");

let file;
try {
  file = readPresetHistoryFile(args.path);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  write(
    `### Preset uptime gate\n\n**FAIL** — could not read \`${args.path}\` (${message}), so ${args.failUnder}% cannot be verified.`,
  );
  console.log("::error title=Preset uptime gate::history file unreadable");
  process.exit(1);
}

const records = file.records;

// The file records the retention it was actually written with; RETAIN_WINDOW is
// the fallback for a file from before that header existed.
const retainRaw = process.env.RETAIN_WINDOW ?? "";
let envRetain = null;
if (retainRaw !== "") {
  try {
    envRetain = parseRetentionMs(retainRaw);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
}
const retainMs = file.retainMs ?? envRetain;

const summary = summarizePresetHistory(
  records,
  { since: args.since, until: args.until, limit: args.limit },
  { retainMs },
);
const check = presetHistoryCheck(args.path, summary, args.failUnder, { maxAgeMs });
const gate = summarizePresetGate(summary, args.failUnder);
const comparison =
  args.compare === null
    ? null
    : comparePresetHistory(records, { since: args.since, until: args.until }, args.compare, {
        retainMs,
      });
// A stale file gets its newest runs as a table, so the summary shows every row
// growing old instead of one line asserting it. A fresh file keeps the uptime
// table alone.
const freshness = check.stale === null ? null : presetFreshnessMarkdown(check, records);
const markdown = [
  freshness,
  gate.markdown,
  comparison === null ? null : presetComparisonMarkdown(comparison, "Preset week over week"),
]
  .filter((part) => part !== null)
  .join("\n\n");
write(`${markdown}\n`);

// A gate or comparison window that reaches past the retention is short for a
// reason that is not provider failure.
for (const warning of retentionWindowWarnings(
  records.at(-1)?.at ?? null,
  retainMs,
  [
    { label: "the gate window", since: args.since },
    { label: "the comparison window", since: comparison?.before.since ?? null },
  ],
)) {
  console.log(`::warning title=Retention window::${escapeAnnotation(warning)}`);
}

// A regression is not a gate failure on its own, but it is the thing a provider
// change is judged on, so it gets its own annotation in the run log.
if (comparison !== null) {
  for (const warning of presetRegressionWarnings(comparison)) {
    console.log(`::warning title=Preset regression::${escapeAnnotation(warning)}`);
  }
  // The preset lines say which chain fell; these say which upstream behind it
  // did, so a provider serving several presets is named once instead of thrice.
  for (const warning of providerRegressionWarnings(comparison)) {
    console.log(`::warning title=Provider regression::${escapeAnnotation(warning)}`);
  }
}

// The same reasons the pre-commit hook prints, as annotations: a stale file and
// an empty window are gate failures too, not just a low uptime.
for (const reason of presetHistoryFailureReasons(check)) {
  console.log(`::error title=Preset uptime gate::${escapeAnnotation(reason)}`);
}

// The verdict is the whole point of the step, so a shortfall fails the job.
process.exit(check.gate.passed ? 0 : 1);
