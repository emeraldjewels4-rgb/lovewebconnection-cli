#!/usr/bin/env node
// Combines preset history files into one, dropping runs more than one copy
// already has. The Actions cache and the `preset-history` release asset each
// keep runs the other may have lost, so CI restores and publishes their union
// rather than choosing the longer file.
//
// usage: node scripts/presets-history-merge.mjs <output> <input>...
// A missing input is skipped: on a first run there is nothing to restore.
// Exits 1 only when an input exists but cannot be read.
import { existsSync } from "node:fs";

import {
  mergePresetHistory,
  readPresetHistory,
  savePresetHistory,
} from "../src/presets-history.ts";

const [output, ...inputs] = process.argv.slice(2);

function usage(message) {
  console.error(`usage error: ${message}`);
  console.error(
    "  example: node scripts/presets-history-merge.mjs .lwc-history/presets.jsonl .lwc-history/presets.jsonl .lwc-history/durable.jsonl",
  );
  process.exit(1);
}

if (!output) usage("an output path is required.");
if (inputs.length === 0) usage("at least one input history file is required.");

const groups = [];
const read = [];
for (const path of inputs) {
  if (!existsSync(path)) {
    console.log(`skipped ${path} (missing)`);
    continue;
  }
  try {
    groups.push(readPresetHistory(path));
    read.push(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cannot read ${path}: ${message}`);
    process.exit(1);
  }
}

const merged = mergePresetHistory(groups);
// Reading and writing the same path is the normal case: the union replaces the
// cache file the probe then appends this run to.
savePresetHistory(output, merged.records);

const runs = `${merged.records.length} run${merged.records.length === 1 ? "" : "s"}`;
const files = `${read.length} file${read.length === 1 ? "" : "s"}`;
const dropped =
  merged.duplicates === 0
    ? ""
    : `, ${merged.duplicates} duplicate${merged.duplicates === 1 ? "" : "s"} dropped`;
console.log(`merged ${runs} from ${files}${dropped}`);
