import { existsSync, readFileSync } from "node:fs";

import {
  getAddress,
  isAddress,
  isHex,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type PublicClient,
} from "viem";

import { DEFAULT_ABI_LABEL, DEFAULT_ERC20_ABI } from "./default-abi.ts";

type ReadArgs = Parameters<PublicClient["readContract"]>[0];

/** Tuple parameters carry their field definitions in `components`. */
type TupleParameter = AbiParameter & { components?: readonly AbiParameter[] };

export class CallArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallArgError";
  }
}

export interface CallArgs {
  address: Address;
  functionName: string;
  /** null means no `--abi` was given, so the built-in ERC-20 ABI applies. */
  abiPath: string | null;
  args: unknown[];
  block: "latest" | bigint;
}

function parseBlock(raw: string): "latest" | bigint {
  if (raw === "latest") return "latest";
  if (!/^\d+$/.test(raw)) {
    throw new CallArgError(`--block must be "latest" or a block number, got "${raw}".`);
  }
  return BigInt(raw);
}

function parseArgsJson(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CallArgError(`--args is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(parsed)) {
    throw new CallArgError(`--args must be a JSON array, e.g. --args '["0xabc…"]'.`);
  }
  return parsed;
}

export function parseCallArgs(argv: string[]): CallArgs {
  const positional: string[] = [];
  const singleArgs: string[] = [];
  let abiPath: string | null = null;
  let argsJson: string | null = null;
  let block: "latest" | bigint = "latest";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readValue = (flag: string): string => {
      const value = argv[index + 1];
      if (!value) throw new CallArgError(`${flag} requires a value.`);
      index += 1;
      return value;
    };

    if (arg === "--abi") {
      abiPath = readValue("--abi");
    } else if (arg === "--args") {
      argsJson = readValue("--args");
    } else if (arg === "--arg") {
      singleArgs.push(readValue("--arg"));
    } else if (arg === "--block") {
      block = parseBlock(readValue("--block"));
    } else if (arg.startsWith("-")) {
      // Other flags (e.g. --json) are handled by the caller.
      continue;
    } else {
      positional.push(arg);
    }
  }

  const [addressRaw, functionName] = positional;
  if (!addressRaw) {
    throw new CallArgError(
      "A contract address is required: lwc call <address> <function> [--abi <file>]",
    );
  }
  if (!isAddress(addressRaw)) {
    throw new CallArgError(`"${addressRaw}" is not a valid EVM address.`);
  }
  if (!functionName) {
    throw new CallArgError(
      "A function name or signature is required: lwc call <address> <function|signature> [--abi <file>]",
    );
  }
  if (positional.length > 2) {
    throw new CallArgError(`Unexpected extra argument: ${positional[2]}.`);
  }

  if (argsJson !== null && singleArgs.length > 0) {
    throw new CallArgError("Use either --args or --arg, not both.");
  }

  let args: unknown[] = [];
  if (argsJson !== null) {
    args = parseArgsJson(argsJson);
  } else if (singleArgs.length > 0) {
    args = singleArgs.map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        // Not JSON, so treat it as a literal string (e.g. 0xabc… or hello).
        return raw;
      }
    });
  }

  return { address: getAddress(addressRaw), functionName, abiPath, args, block };
}

export function extractAbi(raw: unknown): Abi {
  if (Array.isArray(raw)) return raw as Abi;
  if (raw && typeof raw === "object" && Array.isArray((raw as { abi?: unknown }).abi)) {
    return (raw as { abi: Abi }).abi;
  }
  throw new CallArgError(
    'ABI file must be a JSON array of ABI items, or an object with an "abi" array.',
  );
}

export function loadAbi(path: string): Abi {
  if (!existsSync(path)) {
    throw new CallArgError(`ABI file not found: ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CallArgError(`ABI file is not valid JSON: ${path}`);
  }

  return extractAbi(raw);
}

export interface ResolvedAbi {
  abi: Abi;
  /** The path given to `--abi`, or the built-in label when none was given. */
  source: string;
}

/** `--abi` is optional: without it the built-in ERC-20 ABI is used. */
export function resolveAbi(abiPath: string | null): ResolvedAbi {
  if (abiPath === null) return { abi: DEFAULT_ERC20_ABI, source: DEFAULT_ABI_LABEL };
  return { abi: loadAbi(abiPath), source: abiPath };
}

/**
 * Render an ABI parameter the way Solidity writes it: tuple components are
 * expanded, and array suffixes are kept, so `f((uint256,address))` and
 * `f((bool,bytes))` no longer both collapse to `f(tuple)`.
 */
function parameterType(param: AbiParameter): string {
  const tuple = /^tuple(.*)$/.exec(param.type);
  const components = (param as TupleParameter).components;
  if (!tuple || components === undefined) return param.type;
  return `(${components.map(parameterType).join(",")})${tuple[1] ?? ""}`;
}

export function signatureOf(fn: AbiFunction): string {
  return `${fn.name}(${(fn.inputs ?? []).map(parameterType).join(", ")})`;
}

function normalizeSignature(value: string): string {
  return value.replace(/\s+/g, "");
}

function availableFunctions(functions: AbiFunction[]): string {
  const signatures = functions.map(signatureOf).sort();
  return signatures.length > 0 ? signatures.join(", ") : "(none)";
}

/**
 * Resolve a function by bare name or by full signature. A bare name works only
 * when the ABI has one candidate: overloads are never guessed from the first
 * entry, since that silently calls the wrong function when argument types line
 * up. `balanceOf(address)` and `balanceOf( address )` are equivalent.
 */
export function findFunction(abi: Abi, nameOrSignature: string): AbiFunction {
  const functions = abi.filter((item): item is AbiFunction => item.type === "function");
  const selector = normalizeSignature(nameOrSignature);
  let match: AbiFunction;

  if (selector.includes("(")) {
    const exact = functions.find((fn) => normalizeSignature(signatureOf(fn)) === selector);
    if (!exact) {
      throw new CallArgError(
        `ABI has no function "${nameOrSignature}". Available: ${availableFunctions(functions)}.`,
      );
    }
    match = exact;
  } else {
    const overloads = functions.filter((fn) => fn.name === selector);
    if (overloads.length === 0) {
      throw new CallArgError(
        `ABI has no function "${nameOrSignature}". Available: ${availableFunctions(functions)}.`,
      );
    }
    if (overloads.length > 1) {
      throw new CallArgError(
        `"${nameOrSignature}" is overloaded; pass a full signature: ${overloads
          .map(signatureOf)
          .sort()
          .join(", ")}.`,
      );
    }
    match = overloads[0] as AbiFunction;
  }

  const mutability = match.stateMutability;
  if (mutability !== "view" && mutability !== "pure") {
    throw new CallArgError(
      `${signatureOf(match)} is ${mutability}; only view and pure functions can be called read-only.`,
    );
  }

  return match;
}

/** JSON.stringify throws on a bigint, which would hide the coercion error. */
function previewValue(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  try {
    return previewValue(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toBigInt(value: unknown, path: string, type: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new CallArgError(`${path} must be an integer for ${type}, got ${value}.`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return BigInt(trimmed);
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed);
  }
  throw new CallArgError(`${path} must be an integer for ${type}, got ${previewValue(value)}.`);
}

function coerceValue(value: unknown, param: AbiParameter, path: string): unknown {
  const type = param.type;

  const arrayMatch = /^(.*)\[(\d*)\]$/.exec(type);
  if (arrayMatch) {
    const innerType = arrayMatch[1] ?? "";
    const fixedLength = arrayMatch[2] ? Number(arrayMatch[2]) : null;

    if (!Array.isArray(value)) {
      throw new CallArgError(`${path} expects an array for type ${type}.`);
    }
    if (fixedLength !== null && value.length !== fixedLength) {
      throw new CallArgError(
        `${path} expects ${fixedLength} items for type ${type}, got ${value.length}.`,
      );
    }

    const innerParam = { ...param, type: innerType } as AbiParameter;
    return value.map((item, index) => coerceValue(item, innerParam, `${path}[${index}]`));
  }

  if (type === "tuple") {
    const components = (param as TupleParameter).components ?? [];

    if (Array.isArray(value)) {
      if (value.length !== components.length) {
        throw new CallArgError(
          `${path} expects ${components.length} tuple fields, got ${value.length}.`,
        );
      }
      return components.map((component, index) =>
        coerceValue(value[index], component, `${path}.${component.name || index}`),
      );
    }

    if (!value || typeof value !== "object") {
      throw new CallArgError(`${path} expects an object or array for a tuple.`);
    }

    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      components.map((component, index) => {
        const key = component.name && component.name.length > 0 ? component.name : String(index);
        if (!(key in record)) {
          throw new CallArgError(`${path} is missing tuple field "${key}".`);
        }
        return [key, coerceValue(record[key], component, `${path}.${key}`)];
      }),
    );
  }

  if (/^u?int\d*$/.test(type)) {
    const amount = toBigInt(value, path, type);
    if (type.startsWith("u") && amount < 0n) {
      throw new CallArgError(`${path} must not be negative for type ${type}.`);
    }
    return amount;
  }

  if (type === "bool") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1 || value === "1") return true;
    if (value === "false" || value === 0 || value === "0") return false;
    throw new CallArgError(`${path} expects true or false, got ${previewValue(value)}.`);
  }

  if (type === "address") {
    if (typeof value !== "string" || !isAddress(value)) {
      throw new CallArgError(`${path} expects an EVM address, got ${previewValue(value)}.`);
    }
    return getAddress(value);
  }

  if (type.startsWith("bytes")) {
    const size = type === "bytes" ? null : Number(type.slice(5));
    if (typeof value !== "string" || !isHex(value)) {
      throw new CallArgError(`${path} expects a 0x-prefixed hex string for ${type}.`);
    }
    if (size !== null && value.length !== size * 2 + 2) {
      throw new CallArgError(`${path} expects ${size} bytes for ${type}.`);
    }
    return value;
  }

  if (type === "string") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    throw new CallArgError(`${path} expects a string, got ${previewValue(value)}.`);
  }

  return value;
}

export function coerceArgs(fn: AbiFunction, rawArgs: unknown[]): unknown[] {
  const inputs = fn.inputs ?? [];

  if (rawArgs.length !== inputs.length) {
    throw new CallArgError(
      `${signatureOf(fn)} takes ${inputs.length} argument(s), got ${rawArgs.length}.`,
    );
  }

  return inputs.map((input, index) =>
    coerceValue(
      rawArgs[index],
      input,
      input.name && input.name.length > 0 ? input.name : `arg${index + 1}`,
    ),
  );
}

export interface CallOutcome {
  blockNumber: bigint;
  result: unknown;
}

export async function callViewFunction(
  client: PublicClient,
  contract: Address,
  abi: Abi,
  fn: AbiFunction,
  args: unknown[],
  block: "latest" | bigint,
): Promise<CallOutcome> {
  const result = await client.readContract({
    address: contract,
    abi,
    functionName: fn.name,
    args,
    ...(block === "latest" ? {} : { blockNumber: block }),
  } as unknown as ReadArgs);

  return {
    blockNumber: block === "latest" ? await client.getBlockNumber() : block,
    result,
  };
}

export function formatValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${key}: ${formatValue(item)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return String(value);
}

export interface CallDisplay {
  contract: Address;
  fn: AbiFunction;
  blockNumber: bigint;
  result: unknown;
}

export function formatCall(display: CallDisplay): string {
  const outputs = display.fn.outputs ?? [];
  const values = Array.isArray(display.result) ? display.result : [display.result];

  const lines = [
    "lwc — contract call",
    "",
    `  ${"contract".padEnd(14)}${display.contract}`,
    `  ${"function".padEnd(14)}${signatureOf(display.fn)}`,
    `  ${"block".padEnd(14)}${display.blockNumber}`,
    "",
  ];

  if (outputs.length <= 1) {
    lines.push(`  ${"result".padEnd(14)}${formatValue(values[0])}`);
  } else {
    outputs.forEach((output, index) => {
      const label = output.name && output.name.length > 0 ? output.name : `[${index}]`;
      lines.push(`  ${label.padEnd(14)}${formatValue(values[index])}`);
    });
  }

  return lines.join("\n");
}

export function serializeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        serializeValue(item),
      ]),
    );
  }
  return value;
}

export function toCallJson(display: CallDisplay): Record<string, unknown> {
  const outputs = display.fn.outputs ?? [];
  const values = Array.isArray(display.result) ? display.result : [display.result];

  return {
    ok: true,
    contract: display.contract,
    function: { name: display.fn.name, signature: signatureOf(display.fn) },
    blockNumber: display.blockNumber.toString(),
    result: serializeValue(display.result),
    outputs: outputs.map((output, index) => ({
      name: output.name && output.name.length > 0 ? output.name : null,
      type: output.type,
      value: serializeValue(outputs.length === 1 ? display.result : values[index]),
    })),
  };
}
