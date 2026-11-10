import type {
  Abi,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  PublicClient,
} from "viem";

import { ChainMismatchError, type ChainConfig } from "./chain.ts";

type ReadArgs = Parameters<PublicClient["readContract"]>[0];

async function callRead<
  TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, "pure" | "view">,
>(
  client: PublicClient,
  contract: { address: Address; abi: TAbi },
  functionName: TFunctionName,
  args: readonly unknown[],
): Promise<ContractFunctionReturnType<TAbi, "pure" | "view", TFunctionName>> {
  const result = await client.readContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  } as unknown as ReadArgs);

  return result as ContractFunctionReturnType<TAbi, "pure" | "view", TFunctionName>;
}

/**
 * ABI-typed read: functionName and args are checked against the ABI, and the
 * return type is derived from the function's outputs.
 */
export async function readTyped<
  const TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, "pure" | "view">,
>(
  client: PublicClient,
  contract: { address: Address; abi: TAbi },
  functionName: TFunctionName,
  ...args: ContractFunctionArgs<TAbi, "pure" | "view", TFunctionName> & readonly unknown[]
): Promise<ContractFunctionReturnType<TAbi, "pure" | "view", TFunctionName>> {
  return callRead(client, contract, functionName, args);
}

/** Bind a client and contract once, then call typed view functions directly. */
export function createReader<const TAbi extends Abi>(
  client: PublicClient,
  contract: { address: Address; abi: TAbi },
) {
  return <TFunctionName extends ContractFunctionName<TAbi, "pure" | "view">>(
    functionName: TFunctionName,
    ...args: ContractFunctionArgs<TAbi, "pure" | "view", TFunctionName> & readonly unknown[]
  ): Promise<ContractFunctionReturnType<TAbi, "pure" | "view", TFunctionName>> =>
    callRead(client, contract, functionName, args);
}

export class ContractCallError extends Error {
  readonly address: Address;

  constructor(message: string, address: Address) {
    super(message);
    this.name = "ContractCallError";
    this.address = address;
  }
}

/** Canonical Multicall3 deployment, present on most EVM chains. */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const multicall3Abi = [
  {
    type: "function",
    name: "getChainId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "chainid", type: "uint256" }],
  },
  {
    type: "function",
    name: "getBlockNumber",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "blockNumber", type: "uint256" }],
  },
  {
    type: "function",
    name: "getCurrentBlockTimestamp",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "timestamp", type: "uint256" }],
  },
] as const;

/** Multicall3 batching surface: aggregate3 plus the native-balance helper. */
export const multicall3BatchAbi = [
  {
    type: "function",
    name: "aggregate3",
    // aggregate3 is payable on-chain, but this kit only ever reaches it through
    // eth_call, so it is declared view to stay inside the typed read surface.
    stateMutability: "view",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

export interface ExampleCallResult {
  contract: Address;
  chainId: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
}

/**
 * Example call against the configured chain: three view functions on Multicall3.
 * These are self-verifying — getChainId() must agree with LWC_CHAIN_ID.
 */
export async function readExampleCall(client: PublicClient): Promise<ExampleCallResult> {
  const code = await client.getCode({ address: MULTICALL3_ADDRESS });
  if (!code || code === "0x" || code === "0x0") {
    throw new ContractCallError(
      `No contract deployed at ${MULTICALL3_ADDRESS} on this chain; Multicall3 is missing.`,
      MULTICALL3_ADDRESS,
    );
  }

  const contract = { address: MULTICALL3_ADDRESS, abi: multicall3Abi } as const;

  const [chainId, blockNumber, blockTimestamp] = await Promise.all([
    readTyped(client, contract, "getChainId"),
    readTyped(client, contract, "getBlockNumber"),
    readTyped(client, contract, "getCurrentBlockTimestamp"),
  ]);

  return { contract: MULTICALL3_ADDRESS, chainId, blockNumber, blockTimestamp };
}

/** Cross-check the contract's answer against the configured chain id. */
export function assertContractChain(result: ExampleCallResult, config: ChainConfig): void {
  const reported = Number(result.chainId);
  if (reported !== config.chainId) {
    throw new ChainMismatchError(config.chainId, reported, "Multicall3 getChainId()");
  }
}

function describeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function formatExampleCall(
  result: ExampleCallResult,
  config: ChainConfig,
  latencyMs: number,
): string {
  const reported = Number(result.chainId);
  const matches = reported === config.chainId;
  const age = Math.max(0, Math.floor(Date.now() / 1000) - Number(result.blockTimestamp));

  const rows: Array<[string, string]> = [
    [
      "getChainId()",
      `${reported}  ${matches ? "matches LWC_CHAIN_ID" : `MISMATCH, expected ${config.chainId}`}`,
    ],
    ["getBlockNumber()", `${result.blockNumber}`],
    ["getCurrentBlockTimestamp()", `${result.blockTimestamp} (${describeAge(age)} old)`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  return [
    "lwc — example contract call",
    "",
    `  contract      Multicall3 (${result.contract})`,
    `  chain         ${config.name} (${config.chainId})`,
    `  latency       ${latencyMs} ms`,
    "",
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  ].join("\n");
}

export function toExampleCallJson(
  result: ExampleCallResult,
  config: ChainConfig,
  latencyMs: number,
): Record<string, unknown> {
  return {
    ok: true,
    contract: { name: "Multicall3", address: result.contract },
    chain: { id: config.chainId, name: config.name },
    latencyMs,
    chainIdMatches: Number(result.chainId) === config.chainId,
    calls: {
      getChainId: result.chainId.toString(),
      getBlockNumber: result.blockNumber.toString(),
      getCurrentBlockTimestamp: result.blockTimestamp.toString(),
    },
  };
}
