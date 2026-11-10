import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getAddress, type Address } from "viem";

import {
  BalancesArgError,
  MAX_SUB_CALLS,
  loadTokenList,
  parseTokenSpec,
  rememberTokenLabel,
  type TokenListEntry,
} from "./balances.ts";

export class TokenFileArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenFileArgError";
  }
}

/** One entry as written to the file: a label when the input carried one. */
export interface TokenFileEntry {
  address: Address;
  label: string | null;
}

export interface TokenFileArgs {
  /** Unique addresses, checksummed, in the order given (or the merged order). */
  addresses: Address[];
  /** The same addresses with their labels, ready to write. */
  entries: TokenFileEntry[];
  /** Where to write the list, or "-" for stdout. */
  outPath: string;
  force: boolean;
  /** Keep the entries already in the file and append only new addresses. */
  merge: boolean;
  /** Fixed sub-call budget for the verification reads, or null for the default. */
  maxSubCalls: number | null;
  /** Non-fatal label conflicts found while merging duplicate addresses. */
  warnings: string[];
}

/** Parse one address spec (`0xAddress`, `0xAddress=Label`, `0xAddress:Label`). */
function parseMaxSubCalls(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new TokenFileArgError(`--max-subcalls must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_SUB_CALLS) {
    throw new TokenFileArgError(`--max-subcalls must be between 1 and ${MAX_SUB_CALLS}.`);
  }
  return value;
}

function parseEntry(raw: string): TokenListEntry {
  try {
    return parseTokenSpec(raw);
  } catch (error) {
    if (error instanceof BalancesArgError) throw new TokenFileArgError(error.message);
    throw error;
  }
}

/** Normalize addresses and `{address, label}` entries to labeled entries. */
function normalizeEntries(
  entries: readonly (Address | TokenFileEntry)[],
): TokenFileEntry[] {
  return entries.map((entry) => {
    if (typeof entry === "string") return { address: getAddress(entry), label: null };
    const label = entry.label?.trim() ?? "";
    return { address: getAddress(entry.address), label: label.length > 0 ? label : null };
  });
}

/**
 * Keep the entries already in a list — same order, same labels — then append the
 * addresses that are not there yet. A new label for an existing address replaces
 * the old one, and a differing pair is reported in `warnings`.
 */
export function mergeTokenEntries(
  existing: readonly (Address | TokenFileEntry)[],
  added: readonly (Address | TokenFileEntry)[],
  warnings: string[] = [],
): TokenFileEntry[] {
  const order: Address[] = [];
  const seen = new Set<string>();
  const labels = new Map<string, string>();

  for (const entry of [...normalizeEntries(existing), ...normalizeEntries(added)]) {
    const key = entry.address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      order.push(entry.address);
    }
    // Present labels win in order, so an existing label survives an unlabeled
    // repeat and a later label replaces an earlier one.
    rememberTokenLabel(entry, labels, warnings);
  }

  return order.map((address) => ({
    address,
    label: labels.get(address.toLowerCase()) ?? null,
  }));
}

/**
 * Build a `--tokens-file` list from command-line addresses. Pure local work: no
 * RPC call is needed, and labels are carried through to the written file. With
 * `--merge` the existing file is read so only new addresses are appended.
 */
export function parseTokenFileArgs(argv: string[]): TokenFileArgs {
  const raw: string[] = [];
  let outPath: string | null = null;
  let force = false;
  let merge = false;
  let maxSubCalls: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--out") {
      const value = argv[index + 1];
      if (!value || (value.startsWith("-") && value !== "-")) {
        throw new TokenFileArgError("--out requires a path, or - for stdout.");
      }
      outPath = value;
      index += 1;
    } else if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);
      if (!value) throw new TokenFileArgError("--out requires a path, or - for stdout.");
      outPath = value;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--merge") {
      merge = true;
    } else if (arg === "--max-subcalls") {
      const value = argv[index + 1];
      if (!value) throw new TokenFileArgError("--max-subcalls requires a value.");
      maxSubCalls = parseMaxSubCalls(value);
      index += 1;
    } else if (arg.startsWith("--max-subcalls=")) {
      maxSubCalls = parseMaxSubCalls(arg.slice("--max-subcalls=".length));
    } else if (arg === "--token") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new TokenFileArgError("--token requires an address.");
      raw.push(value);
      index += 1;
    } else if (arg.startsWith("--token=")) {
      raw.push(arg.slice("--token=".length));
    } else if (arg === "--tokens") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new TokenFileArgError("--tokens requires a comma-separated list.");
      }
      raw.push(...value.split(","));
      index += 1;
    } else if (arg.startsWith("--tokens=")) {
      raw.push(...arg.slice("--tokens=".length).split(","));
    } else if (arg.startsWith("-")) {
      continue; // --json and other global flags are handled by the caller.
    } else {
      raw.push(arg);
    }
  }

  if (outPath === null) {
    throw new TokenFileArgError("--out <path> is required (use --out - for stdout).");
  }
  if (merge && outPath === "-") {
    throw new TokenFileArgError("--merge needs a file path; it cannot append to --out -.");
  }

  const addresses: Address[] = [];
  const labels = new Map<string, string>();
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const value of raw) {
    const candidate = value.trim();
    if (!candidate) continue;
    const entry = parseEntry(candidate);
    // Duplicates keep the first position but the last label, and a differing
    // label is reported rather than silently dropped.
    rememberTokenLabel(entry, labels, warnings);
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(entry.address);
  }

  if (addresses.length === 0) {
    throw new TokenFileArgError("at least one token address is required.");
  }

  const given: TokenFileEntry[] = addresses.map((address) => ({
    address,
    label: labels.get(address.toLowerCase()) ?? null,
  }));

  let entries = given;
  if (merge && existsSync(outPath)) {
    let existing: TokenListEntry[];
    try {
      existing = loadTokenList(outPath);
    } catch (error) {
      throw new TokenFileArgError(error instanceof Error ? error.message : String(error));
    }
    entries = mergeTokenEntries(existing, given, warnings);
  }

  return {
    addresses: entries.map((entry) => entry.address),
    entries,
    outPath,
    force,
    merge,
    maxSubCalls,
    warnings,
  };
}

/**
 * The written shape: a checksummed address string when there is no label, and an
 * `{ address, label }` object when there is — both forms `--tokens-file` reads.
 */
export function tokenListItems(
  entries: readonly (Address | TokenFileEntry)[],
): Array<Address | { address: Address; label: string }> {
  return normalizeEntries(entries).map((entry) =>
    entry.label === null ? entry.address : { address: entry.address, label: entry.label },
  );
}

/** JSON array in the format `--tokens-file` reads, labels included. */
export function buildTokenListJson(
  entries: readonly (Address | TokenFileEntry)[],
): string {
  return `${JSON.stringify(tokenListItems(entries), null, 2)}\n`;
}

/** Write the list (or return it for "-"), never replacing a file without force. */
export function saveTokenList(
  outPath: string,
  entries: readonly (Address | TokenFileEntry)[],
  options: { force?: boolean } = {},
): string {
  const json = buildTokenListJson(entries);
  if (outPath === "-") return json;

  if (!options.force && existsSync(outPath)) {
    throw new TokenFileArgError(`${outPath} already exists; pass --force to replace it.`);
  }

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    const temporary = `${outPath}.tmp`;
    writeFileSync(temporary, json);
    renameSync(temporary, outPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TokenFileArgError(`cannot write ${outPath}: ${reason}`);
  }

  return json;
}
