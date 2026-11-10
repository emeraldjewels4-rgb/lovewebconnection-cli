import type { Abi } from "viem";

import { signatureOf } from "./call.ts";
import { listViewFunctions } from "./views.ts";

export class SignaturesArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignaturesArgError";
  }
}

export interface SignaturesArgs {
  /** ABI file to read, or null for the built-in ERC-20 ABI. */
  abiPath: string | null;
}

export function parseSignaturesArgs(argv: string[]): SignaturesArgs {
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("-")) continue; // --json is handled by the caller.
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new SignaturesArgError(`Unexpected extra argument: ${positional[1]}.`);
  }

  return { abiPath: positional[0] ?? null };
}

/** Every callable signature, sorted so overloads are easy to scan and copy. */
export function callableSignatures(abi: Abi): string[] {
  return listViewFunctions(abi).map(signatureOf).sort();
}

export function formatSignatures(signatures: string[], source: string): string {
  const lines = [
    "lwc — callable signatures",
    "",
    `  ${"abi".padEnd(14)}${source}`,
    `  ${"signatures".padEnd(14)}${signatures.length} view/pure`,
    "",
  ];

  if (signatures.length === 0) {
    lines.push("  (no view or pure functions)");
  } else {
    lines.push(...signatures.map((signature) => `  ${signature}`));
  }

  return lines.join("\n");
}

export function toSignaturesJson(
  signatures: string[],
  source: string,
): Record<string, unknown> {
  return { ok: true, abi: source, count: signatures.length, signatures };
}
