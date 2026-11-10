import assert from "node:assert/strict";
import { test } from "node:test";

import { erc20Abi, type PublicClient } from "viem";

import {
  ContractCallError,
  MULTICALL3_ADDRESS,
  assertContractChain,
  createReader,
  formatExampleCall,
  multicall3Abi,
  readExampleCall,
  readTyped,
  toExampleCallJson,
  type ExampleCallResult,
} from "./contract.ts";
import { ChainMismatchError, type ChainConfig } from "./chain.ts";

const OWNER = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const config: ChainConfig = {
  chainId: 196,
  name: "xlayer",
  rpcUrl: "https://xlayer.drpc.org",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  authHeader: null,
  preset: "xlayer",
  timeoutMs: 15_000,
};

function stubClient(readContract: (args: unknown) => Promise<unknown>): {
  client: PublicClient;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const client = {
    readContract: async (args: unknown) => {
      calls.push(args);
      return readContract(args);
    },
  } as unknown as PublicClient;
  return { client, calls };
}

test("readTyped forwards the call and returns the decoded value", async () => {
  const { client, calls } = stubClient(async () => 196n);

  const value = await readTyped(
    client,
    { address: MULTICALL3_ADDRESS, abi: multicall3Abi },
    "getChainId",
  );

  assert.equal(value, 196n);
  assert.equal(calls.length, 1);
  const recorded = calls[0] as { address: string; functionName: string; args: unknown[] };
  assert.equal(recorded.address, MULTICALL3_ADDRESS);
  assert.equal(recorded.functionName, "getChainId");
  assert.deepEqual(recorded.args, []);
});

test("readTyped forwards positional arguments", async () => {
  const { client, calls } = stubClient(async () => 2_500_000n);

  const value = await readTyped(
    client,
    { address: USDC, abi: erc20Abi },
    "balanceOf",
    OWNER,
  );

  assert.equal(value, 2_500_000n);
  const recorded = calls[0] as { functionName: string; args: readonly string[] };
  assert.equal(recorded.functionName, "balanceOf");
  assert.deepEqual(recorded.args, [OWNER]);
});

test("createReader binds the contract for repeated calls", async () => {
  const { client, calls } = stubClient(async (args) => {
    const { functionName } = args as { functionName: string };
    return functionName === "decimals" ? 6 : "USDC";
  });
  const read = createReader(client, { address: USDC, abi: erc20Abi });

  assert.equal(await read("decimals"), 6);
  assert.equal(await read("symbol"), "USDC");
  assert.equal(calls.length, 2);
});

test("readExampleCall reads three view functions", async () => {
  const { client, calls } = stubClient(async (args) => {
    const { functionName } = args as { functionName: string };
    if (functionName === "getChainId") return 196n;
    if (functionName === "getBlockNumber") return 75_416_480n;
    return 1_794_185_600n;
  });
  (client as unknown as { getCode: () => Promise<string> }).getCode = async () => "0x6080";

  const result = await readExampleCall(client);

  assert.equal(result.contract, MULTICALL3_ADDRESS);
  assert.equal(result.chainId, 196n);
  assert.equal(result.blockNumber, 75_416_480n);
  assert.equal(result.blockTimestamp, 1_794_185_600n);
  assert.equal(calls.length, 3);
});

test("readExampleCall fails clearly when Multicall3 is absent", async () => {
  const { client } = stubClient(async () => 196n);
  (client as unknown as { getCode: () => Promise<string> }).getCode = async () => "0x";

  await assert.rejects(
    () => readExampleCall(client),
    (error: unknown) =>
      error instanceof ContractCallError && /Multicall3 is missing/.test(error.message),
  );
});

const result: ExampleCallResult = {
  contract: MULTICALL3_ADDRESS,
  chainId: 196n,
  blockNumber: 75_416_480n,
  blockTimestamp: 1_794_185_600n,
};

test("assertContractChain accepts a matching chain and rejects a mismatch", () => {
  assert.doesNotThrow(() => assertContractChain(result, config));

  assert.throws(
    () => assertContractChain({ ...result, chainId: 1n }, config),
    (error: unknown) =>
      error instanceof ChainMismatchError &&
      /Multicall3 getChainId\(\) answered chainId 1/.test(error.message),
  );
});

test("formatExampleCall renders the calls and the chain check", () => {
  const output = formatExampleCall(result, config, 412);

  assert.match(output, /contract {6}Multicall3 \(0xcA11bde05977b3631167028862bE2a173976CA11\)/);
  assert.match(output, /chain {9}xlayer \(196\)/);
  assert.match(output, /latency {7}412 ms/);
  assert.match(output, /getChainId\(\) +196 +matches LWC_CHAIN_ID/);
  assert.match(output, /getBlockNumber\(\) +75416480/);
  assert.match(output, /getCurrentBlockTimestamp\(\) +1794185600 \(\d+[smhd] old\)/);
});

test("formatExampleCall flags a mismatch", () => {
  const output = formatExampleCall({ ...result, chainId: 1n }, config, 10);

  assert.match(output, /getChainId\(\) +1 +MISMATCH, expected 196/);
});

test("toExampleCallJson stringifies bigints and records the match", () => {
  const payload = toExampleCallJson(result, config, 412);
  const serialized = JSON.stringify(payload);

  assert.match(serialized, /"chainIdMatches":true/);
  assert.match(serialized, /"getChainId":"196"/);
  assert.match(serialized, /"getBlockNumber":"75416480"/);
  assert.match(serialized, /"getCurrentBlockTimestamp":"1794185600"/);
});
