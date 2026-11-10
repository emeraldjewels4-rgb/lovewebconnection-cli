import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  callViewFunction,
  coerceArgs,
  formatValue,
  serializeValue,
  signatureOf,
  type CallArgError,
} from "./call.ts";
import { MAX_SUB_CALLS } from "./balances.ts";
import { MULTICALL3_ADDRESS, multicall3BatchAbi } from "./contract.ts";

type EncodeCallArgs = Parameters<typeof encodeFunctionData>[0];
type DecodeCallArgs = Parameters<typeof decodeFunctionResult>[0];
type ReadContractArgs = Parameters<PublicClient["readContract"]>[0];
type Aggregate3Result = readonly { success: boolean; returnData: Hex }[];

/** Standard Solidity revert payloads, decoded so `revert("...")` keeps its reason. */
const revertErrorAbi = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
] as const;

export class ViewsArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewsArgError";
  }
}

export type ViewsArgsSpec =
  | { kind: "array"; args: unknown[] }
  | { kind: "map"; args: Record<string, unknown[]> }
  | null;

export interface ViewsArgs {
  address: Address;
  /** null means no `--abi` was given, so the built-in ERC-20 ABI applies. */
  abiPath: string | null;
  spec: ViewsArgsSpec;
  /** Block to read at, or "latest" to use the head at run time. */
  block: "latest" | bigint;
  /** Fixed sub-call budget per Multicall3 request, or null for one request. */
  maxSubCalls: number | null;
}

function normalizeSignatureKey(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * A map entry may name the bare function or a full signature, so overloads are
 * addressable. Signatures are matched first so `get(uint256)` beats a `get`
 * entry regardless of key order, and whitespace in a key is ignored.
 */
function lookupMapArgs(
  args: Record<string, unknown[]>,
  fn: AbiFunction,
): unknown[] | undefined {
  const signature = normalizeSignatureKey(signatureOf(fn));
  const name = normalizeSignatureKey(fn.name);

  for (const [key, value] of Object.entries(args)) {
    if (normalizeSignatureKey(key) === signature) return value;
  }
  for (const [key, value] of Object.entries(args)) {
    if (normalizeSignatureKey(key) === name) return value;
  }
  return undefined;
}

function parseBlock(raw: string): "latest" | bigint {
  if (raw === "latest") return "latest";
  if (!/^\d+$/.test(raw)) {
    throw new ViewsArgError(`--block must be "latest" or a block number, got "${raw}".`);
  }
  return BigInt(raw);
}

function parseMaxSubCalls(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ViewsArgError(`--max-subcalls must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_SUB_CALLS) {
    throw new ViewsArgError(`--max-subcalls must be between 1 and ${MAX_SUB_CALLS}.`);
  }
  return value;
}

function parseArgSpec(raw: string): ViewsArgsSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ViewsArgError(`--args is not valid JSON: ${raw}`);
  }

  if (Array.isArray(parsed)) return { kind: "array", args: parsed };

  if (parsed && typeof parsed === "object") {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return null;
    for (const [name, value] of entries) {
      if (!Array.isArray(value)) {
        throw new ViewsArgError(`--args.${name} must be an array of arguments.`);
      }
    }
    return { kind: "map", args: Object.fromEntries(entries) as Record<string, unknown[]> };
  }

  throw new ViewsArgError("--args must be a JSON array or an object of name → argument array.");
}

export function parseViewsArgs(argv: string[]): ViewsArgs {
  const positional: string[] = [];
  let abiPath: string | null = null;
  let spec: ViewsArgsSpec = null;
  let block: "latest" | bigint = "latest";
  let maxSubCalls: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readValue = (flag: string): string => {
      const value = argv[index + 1];
      if (!value) throw new ViewsArgError(`${flag} requires a value.`);
      index += 1;
      return value;
    };

    if (arg === "--abi" || arg.startsWith("--abi=")) {
      abiPath = arg.startsWith("--abi=") ? arg.slice("--abi=".length) : readValue("--abi");
      if (!abiPath) throw new ViewsArgError("--abi requires a file path.");
    } else if (arg === "--args" || arg.startsWith("--args=")) {
      const value = arg.startsWith("--args=") ? arg.slice("--args=".length) : readValue("--args");
      if (!value) throw new ViewsArgError("--args requires JSON.");
      spec = parseArgSpec(value);
    } else if (arg === "--block" || arg.startsWith("--block=")) {
      const value = arg.startsWith("--block=") ? arg.slice("--block=".length) : readValue("--block");
      block = parseBlock(value);
    } else if (arg === "--max-subcalls") {
      maxSubCalls = parseMaxSubCalls(readValue("--max-subcalls"));
    } else if (arg.startsWith("--max-subcalls=")) {
      maxSubCalls = parseMaxSubCalls(arg.slice("--max-subcalls=".length));
    } else if (arg.startsWith("-")) {
      // Other flags (e.g. --json) are handled by the caller.
      continue;
    } else {
      positional.push(arg);
    }
  }

  const [addressRaw] = positional;
  if (!addressRaw) {
    throw new ViewsArgError("A contract address is required: lwc views <address> [--abi <file>]");
  }
  if (!isAddress(addressRaw)) {
    throw new ViewsArgError(`"${addressRaw}" is not a valid EVM address.`);
  }
  if (positional.length > 1) {
    throw new ViewsArgError(`Unexpected extra argument: ${positional[1]}.`);
  }

  return { address: getAddress(addressRaw), abiPath, spec, block, maxSubCalls };
}

/** Every function in the ABI that can be called read-only, in ABI order. */
export function listViewFunctions(abi: Abi): AbiFunction[] {
  return abi.filter((item): item is AbiFunction => {
    if (item.type !== "function") return false;
    const fn = item as AbiFunction & { constant?: boolean };
    return (
      fn.stateMutability === "view" ||
      fn.stateMutability === "pure" ||
      (fn.stateMutability === undefined && fn.constant === true)
    );
  });
}

export type ViewCallStatus = "ok" | "error" | "skipped";

export interface ViewCallResult {
  fn: AbiFunction;
  signature: string;
  status: ViewCallStatus;
  /** Decoded result when status is "ok". */
  value: unknown;
  /** Failure message when status is "error". */
  error: string | null;
  /** Why the call was not attempted, when status is "skipped". */
  reason: string | null;
  args: unknown[];
}

export interface ViewsReport {
  contract: Address;
  /** Display source: the `--abi` path, or the built-in ABI label. */
  abiPath: string;
  blockNumber: bigint;
  results: ViewCallResult[];
  called: number;
  failed: number;
  skipped: number;
  /** Multicall3 requests sent; 1 without a cap, more when chunked. */
  chunks: number;
  maxSubCalls: number | null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return short;
    return error.message;
  }
  return String(error);
}

function resultOf(
  plan: PlannedViewCall,
  status: ViewCallStatus,
  value: unknown,
  error: string | null,
  reason: string | null,
): ViewCallResult {
  return {
    fn: plan.fn,
    signature: plan.signature,
    status,
    value,
    error,
    reason,
    args: plan.args ?? plan.rawArgs,
  };
}

interface PlannedViewCall {
  fn: AbiFunction;
  signature: string;
  /** Coerced arguments once the call is ready to send. */
  args: unknown[] | null;
  /** Raw arguments, kept for error rows. */
  rawArgs: unknown[];
  /** Encoded calldata, or null when the call is skipped or failed to prepare. */
  callData: Hex | null;
  skipReason: string | null;
  prepError: string | null;
}

/** Work out arguments and calldata before any network read, so a wide ABI is one batch. */
function planViewCall(fn: AbiFunction, spec: ViewsArgsSpec): PlannedViewCall {
  const signature = signatureOf(fn);
  const inputs = fn.inputs ?? [];
  let rawArgs: unknown[];

  if (inputs.length === 0) {
    rawArgs = [];
  } else if (spec === null) {
    return {
      fn,
      signature,
      args: null,
      rawArgs: [],
      callData: null,
      skipReason: `needs ${inputs.length} argument(s)`,
      prepError: null,
    };
  } else if (spec.kind === "array") {
    if (spec.args.length !== inputs.length) {
      return {
        fn,
        signature,
        args: null,
        rawArgs: [],
        callData: null,
        skipReason: `needs ${inputs.length} argument(s), --args has ${spec.args.length}`,
        prepError: null,
      };
    }
    rawArgs = spec.args;
  } else {
    const entry = lookupMapArgs(spec.args, fn);
    if (entry === undefined) {
      return {
        fn,
        signature,
        args: null,
        rawArgs: [],
        callData: null,
        skipReason: `needs ${inputs.length} argument(s)`,
        prepError: null,
      };
    }
    rawArgs = entry;
  }

  try {
    const args = coerceArgs(fn, rawArgs);
    const callData = encodeFunctionData({
      abi: [fn],
      functionName: fn.name,
      args,
    } as unknown as EncodeCallArgs);
    return { fn, signature, args, rawArgs, callData, skipReason: null, prepError: null };
  } catch (error) {
    return {
      fn,
      signature,
      args: null,
      rawArgs,
      callData: null,
      skipReason: null,
      prepError: describeError(error),
    };
  }
}

function revertMessage(data: Hex | undefined): string {
  if (!data || data === "0x") return "execution reverted (no data)";

  try {
    const decoded = decodeErrorResult({ abi: revertErrorAbi, data });
    const args = decoded.args as readonly unknown[] | undefined;
    if (decoded.errorName === "Error" && typeof args?.[0] === "string") {
      return `execution reverted: ${args[0]}`;
    }
    if (decoded.errorName === "Panic" && typeof args?.[0] === "bigint") {
      return `execution reverted: panic 0x${(args[0] as bigint).toString(16)}`;
    }
  } catch {
    // Not a standard Error(string) or Panic(uint256) payload.
  }

  return `execution reverted (${data.length > 10 ? `${data.slice(0, 10)}…` : data})`;
}

function decodeReturn(plan: PlannedViewCall, data: Hex): ViewCallResult {
  try {
    const value = decodeFunctionResult({
      abi: [plan.fn],
      functionName: plan.fn.name,
      data,
    } as unknown as DecodeCallArgs);
    return resultOf(plan, "ok", value, null, null);
  } catch (error) {
    return resultOf(plan, "error", null, describeError(error), null);
  }
}

/**
 * One eth_call: every callable function as an aggregate3 sub-call, pinned to
 * the same block. Returns null when the batch cannot be used at all, so the
 * caller can fall back to individual reads.
 */
async function callBatch(
  client: PublicClient,
  contract: Address,
  plans: PlannedViewCall[],
  blockNumber: bigint,
): Promise<ViewCallResult[] | null> {
  const calls = plans.map((plan) => ({
    target: contract,
    allowFailure: true,
    callData: plan.callData as Hex,
  }));

  let results: Aggregate3Result;
  try {
    results = (await client.readContract({
      address: MULTICALL3_ADDRESS,
      abi: multicall3BatchAbi,
      functionName: "aggregate3",
      args: [calls],
      blockNumber,
    } as unknown as ReadContractArgs)) as Aggregate3Result;
  } catch {
    return null;
  }

  if (!Array.isArray(results) || results.length !== plans.length) return null;

  return plans.map((plan, index) => {
    const result = results[index];
    if (!result || result.success !== true) {
      return resultOf(plan, "error", null, revertMessage(result?.returnData), null);
    }
    return decodeReturn(plan, result.returnData);
  });
}

/** Split calls into request-sized groups; one group when no cap is set. */
function chunkPlans(
  plans: PlannedViewCall[],
  maxSubCalls: number | null,
): PlannedViewCall[][] {
  if (plans.length === 0) return [];
  if (maxSubCalls === null) return [plans];

  const chunks: PlannedViewCall[][] = [];
  for (let index = 0; index < plans.length; index += maxSubCalls) {
    chunks.push(plans.slice(index, index + maxSubCalls));
  }
  return chunks;
}

async function callOneByOne(
  client: PublicClient,
  contract: Address,
  abi: Abi,
  plans: PlannedViewCall[],
  blockNumber: bigint,
): Promise<ViewCallResult[]> {
  return Promise.all(
    plans.map(async (plan): Promise<ViewCallResult> => {
      try {
        const outcome = await callViewFunction(
          client,
          contract,
          abi,
          plan.fn,
          plan.args ?? [],
          blockNumber,
        );
        return resultOf(plan, "ok", outcome.result, null, null);
      } catch (error) {
        return resultOf(plan, "error", null, describeError(error), null);
      }
    }),
  );
}

/**
 * Call every view function once, packed into a single Multicall3 aggregate3
 * request at one block. Functions that need arguments are skipped unless `spec`
 * supplies them, a reverting getter is reported in its own row, and if a
 * batch itself fails that group's calls are retried individually. A
 * `maxSubCalls` cap splits the work across several Multicall3 requests.
 */
export async function runViewFunctions(
  client: PublicClient,
  contract: Address,
  abi: Abi,
  abiPath: string,
  spec: ViewsArgsSpec = null,
  block: "latest" | bigint = "latest",
  maxSubCalls: number | null = null,
): Promise<ViewsReport> {
  const planned = listViewFunctions(abi).map((fn) => planViewCall(fn, spec));
  const blockNumber = block === "latest" ? await client.getBlockNumber() : block;

  const callable = planned.filter((plan) => plan.callData !== null);
  const batches = chunkPlans(callable, maxSubCalls);
  const outcomes: ViewCallResult[] = [];
  for (const batch of batches) {
    outcomes.push(
      ...((await callBatch(client, contract, batch, blockNumber)) ??
        (await callOneByOne(client, contract, abi, batch, blockNumber))),
    );
  }

  let next = 0;
  const results = planned.map((plan): ViewCallResult => {
    if (plan.skipReason !== null) return resultOf(plan, "skipped", null, null, plan.skipReason);
    if (plan.prepError !== null) return resultOf(plan, "error", null, plan.prepError, null);
    const outcome = outcomes[next];
    next += 1;
    return outcome ?? resultOf(plan, "error", null, "no result returned for this call", null);
  });

  return {
    contract,
    abiPath,
    blockNumber,
    results,
    called: results.filter((result) => result.status === "ok").length,
    failed: results.filter((result) => result.status === "error").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    chunks: batches.length,
    maxSubCalls,
  };
}

export function formatViews(report: ViewsReport): string {
  const width = Math.max(8, ...report.results.map((result) => result.signature.length));
  const lines = [
    "lwc — view calls",
    "",
    `  ${"contract".padEnd(14)}${report.contract}`,
    `  ${"abi".padEnd(14)}${report.abiPath}`,
    `  ${"functions".padEnd(14)}${report.results.length} view/pure: ${report.called} called, ${report.failed} failed, ${report.skipped} skipped`,
    `  ${"block".padEnd(14)}${report.blockNumber}`,
  ];

  if (report.maxSubCalls !== null) {
    lines.push(
      `  ${"requests".padEnd(14)}${report.chunks} multicall3 request${report.chunks === 1 ? "" : "s"}, max ${report.maxSubCalls} sub-calls`,
    );
  }

  lines.push("");

  for (const result of report.results) {
    const detail =
      result.status === "ok"
        ? formatValue(result.value)
        : result.status === "error"
          ? `error: ${result.error}`
          : `skipped: ${result.reason}`;
    lines.push(`  ${result.signature.padEnd(width)}  ${detail}`);
  }

  return lines.join("\n");
}

export function toViewsJson(report: ViewsReport): Record<string, unknown> {
  return {
    ok: report.failed === 0,
    contract: report.contract,
    abi: report.abiPath,
    blockNumber: report.blockNumber.toString(),
    called: report.called,
    failed: report.failed,
    skipped: report.skipped,
    chunkCount: report.chunks,
    maxSubCalls: report.maxSubCalls,
    functions: report.results.map((result) => ({
      name: result.fn.name,
      signature: result.signature,
      stateMutability: result.fn.stateMutability ?? null,
      inputs: (result.fn.inputs ?? []).map((input) => ({
        name: input.name && input.name.length > 0 ? input.name : null,
        type: input.type,
      })),
      outputs: (result.fn.outputs ?? []).map((output) => ({
        name: output.name && output.name.length > 0 ? output.name : null,
        type: output.type,
      })),
      status: result.status,
      args: serializeValue(result.args),
      value: result.status === "ok" ? serializeValue(result.value) : null,
      error: result.error,
      reason: result.reason,
    })),
  };
}

/** Exported only so callers can share the error type in their own checks. */
export type { CallArgError };
