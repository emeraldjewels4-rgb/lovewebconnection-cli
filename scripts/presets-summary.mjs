#!/usr/bin/env node
// Turns `lwc presets --json` output into a CI run summary plus one ::warning::
// per failover, so a backup taking over is visible in the run history.
//
// usage: node scripts/presets-summary.mjs [presets.json]
// Writes to $GITHUB_STEP_SUMMARY when set, otherwise prints to stdout.
import { appendFileSync, readFileSync } from "node:fs";

import { summarizePresets } from "../src/presets-summary.ts";

const reportPath = process.argv[2] ?? "presets.json";
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

function write(line) {
  if (summaryPath) {
    appendFileSync(summaryPath, `${line}\n`);
  } else {
    console.log(line);
  }
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  // Presentation only: the probe's own exit code is what fails the run.
  write(`### Built-in preset health\n\nNo report was produced (${error.message}).`);
  process.exit(0);
}

const { markdown, warnings } = summarizePresets(report);
write(`${markdown}\n`);

for (const warning of warnings) {
  console.log(`::warning title=Preset failover::${warning}`);
}
