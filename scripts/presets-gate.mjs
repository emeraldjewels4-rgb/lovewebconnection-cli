#!/usr/bin/env node
// Enforces the uptime gate for the scheduled preset run and writes its outcome
// to the job summary. It reuses the same summary functions as
// `lwc presets-history`, so the CI verdict cannot drift from the CLI view.
//
// usage: node scripts/presets-gate.mjs .lwc-history/presets.jsonl --since 7d --compare 14d..7d --fail-under 95
// Writes to $GITHUB_STEP_SUMMARY when set, otherwise prints to stdout.
// Exits 1 when a preset is below the threshold or the window cannot be checked.
// --compare adds the earlier window to the summary; the verdict still comes from
// the current one, so a week-over-week delta is published without weakening the gate.
import { appendFileSync } from "node:fs";

import {
  PresetsHistoryArgError,
  comparePresetHistory,
  parsePresetHistoryArgs,
  presetComparisonMarkdown,
  readPresetHistory,
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
    "  example: node scripts/presets-gate.mjs .lwc-history/presets.jsonl --since 7d --compare 14d..7d --fail-under 95",
  );
  process.exit(1);
}

let args;
try {
  args = parsePresetHistoryArgs(process.argv.slice(2));
} catch (error) {
  if (error instanceof PresetsHistoryArgError) usage(error.message);
  throw error;
}

if (args.failUnder === null) usage("--fail-under is required for the gate.");

let records;
try {
  records = readPresetHistory(args.path);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  write(
    `### Preset uptime gate\n\n**FAIL** — could not read \`${args.path}\` (${message}), so ${args.failUnder}% cannot be verified.`,
  );
  console.log("::error title=Preset uptime gate::history file unreadable");
  process.exit(1);
}

const summary = summarizePresetHistory(records, {
  since: args.since,
  until: args.until,
  limit: args.limit,
});
const gate = summarizePresetGate(summary, args.failUnder);
const comparison =
  args.compare === null
    ? null
    : comparePresetHistory(records, { since: args.since, until: args.until }, args.compare);
const markdown = [
  gate.markdown,
  comparison === null ? null : presetComparisonMarkdown(comparison, "Preset week over week"),
]
  .filter((part) => part !== null)
  .join("\n\n");
write(`${markdown}\n`);

for (const row of gate.shortfalls) {
  const detail = `${row.preset} uptime ${row.uptimePct}% over ${row.runs} run${row.runs === 1 ? "" : "s"} is below ${args.failUnder}%`;
  console.log(`::error title=Preset uptime gate::${escapeAnnotation(detail)}`);
}

if (summary.runs === 0) {
  console.log("::error title=Preset uptime gate::no runs in the window to check");
}

// The verdict is the whole point of the step, so a shortfall fails the job.
process.exit(gate.passed ? 0 : 1);
