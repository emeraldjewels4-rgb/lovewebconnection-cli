#!/usr/bin/env node
// Combines preset history files into one, dropping runs more than one copy
// already has. The Actions cache and the `preset-history` release asset each
// keep runs the other may have lost, so CI restores and publishes their union
// rather than choosing the longer file.
//
// usage: node scripts/presets-history-merge.mjs <output> <input>... [--retain <span>]
// A missing input is skipped: on a first run there is nothing to restore.
// --retain caps the union at a span measured back from its newest run, so the
// published asset stays bounded without a paused schedule erasing its record.
// Exits 1 only when an input exists but cannot be read or a flag is malformed.
import { existsSync } from "node:fs";

import {
  mergePresetHistory,
  narrowestRetentionMs,
  parseRetentionMs,
  readPresetHistoryFile,
  savePresetHistory,
} from "../src/presets-history.ts";

function usage(message) {
  console.error(`usage error: ${message}`);
  console.error(
    "  example: node scripts/presets-history-merge.mjs .lwc-history/presets.jsonl .lwc-history/presets.jsonl .lwc-history/durable.jsonl --retain 180d",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
let retainMs = null;
const paths = [];

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? "";
  if (arg === "--retain" || arg.startsWith("--retain=")) {
    const inline = arg.startsWith("--retain=") ? arg.slice("--retain=".length) : null;
    const value = inline ?? argv[index + 1] ?? "";
    if (inline === null) index += 1;
    try {
      retainMs = parseRetentionMs(value);
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  } else if (arg.startsWith("-")) {
    usage(`unexpected flag "${arg}".`);
  } else {
    paths.push(arg);
  }
}

const [output, ...inputs] = paths;
if (!output) usage("an output path is required.");
if (inputs.length === 0) usage("at least one input history file is required.");

const groups = [];
const read = [];
const declared = [];
for (const path of inputs) {
  if (!existsSync(path)) {
    console.log(`skipped ${path} (missing)`);
    continue;
  }
  try {
    const file = readPresetHistoryFile(path);
    groups.push(file.records);
    declared.push(file.retainMs);
    read.push(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cannot read ${path}: ${message}`);
    process.exit(1);
  }
}

const merged = mergePresetHistory(groups, { retainMs });
// Reading and writing the same path is the normal case: the union replaces the
// cache file the probe then appends this run to. The written file records the
// retention it was trimmed to, so later reads know what it no longer holds.
savePresetHistory(output, merged.records, {
  retainMs: retainMs ?? narrowestRetentionMs(declared),
});

const runs = `${merged.records.length} run${merged.records.length === 1 ? "" : "s"}`;
const files = `${read.length} file${read.length === 1 ? "" : "s"}`;
const dropped =
  merged.duplicates === 0
    ? ""
    : `, ${merged.duplicates} duplicate${merged.duplicates === 1 ? "" : "s"} dropped`;
const pruned =
  merged.pruned === 0 ? "" : `, ${merged.pruned} older run${merged.pruned === 1 ? "" : "s"} pruned`;
console.log(`merged ${runs} from ${files}${dropped}${pruned}`);
