import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  type Abi,
  type AbiFunction,
  type Hex,
  type PublicClient,
} from "viem";

import {
  ViewsArgError,
  formatViews,
  listViewFunctions,
  parseViewsArgs,
  runViewFunctions,
  toViewsJson,
  type ViewsReport,
} from "./views.ts";

const TOKEN = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";
const OWNER = "0x000000000000000000000000000000000000dEaD";
const SPENDER = "0x000000000000000000000000000000000000bEEF";

const abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "remaining", type: "uint256" }],
  },
  {
    type: "function",
    name: "legacyTotal",
    constant: true,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [],
  },
] as unknown as Abi;

function expectArgError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof ViewsArgError && pattern.test(error.message),
  );
}

const revertAbi = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
] as const;

type EncodeResultArgs = Parameters<typeof encodeFunctionResult>[0];

/** Answers aggregate3 from the same fixture map, as the chain would. */
function makeClient(
  values: Record<string, unknown>,
  options: { abi?: Abi; failBatch?: boolean } = {},
) {
  const callAbi = options.abi ?? abi;
  const callFunctions = callAbi.filter(
    (item): item is AbiFunction => item.type === "function",
  );
  const calls: string[] = [];
  const subCalls: string[] = [];
  const blocks: Array<bigint | undefined> = [];
  let blockReads = 0;

  const client = {
    readContract: async (args: {
      functionName: string;
      args?: unknown[];
      blockNumber?: bigint;
    }) => {
      calls.push(args.functionName);
      blocks.push(args.blockNumber);

      if (args.functionName === "aggregate3") {
        if (options.failBatch) throw new Error("out of gas");
        const subs = (args.args?.[0] ?? []) as Array<{ callData: Hex }>;
        return subs.map((sub) => {
          const decoded = decodeFunctionData({ abi: callAbi, data: sub.callData });
          const name = decoded.functionName;
          subCalls.push(name);
          const value = values[name];

          if (value instanceof Error) {
            return {
              success: false,
              returnData: encodeErrorResult({
                abi: revertAbi,
                errorName: "Error",
                args: [value.message],
              }),
            };
          }

          const fn = callFunctions.find((item) => item.name === name);
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: [fn],
              functionName: name,
              result: value,
            } as unknown as EncodeResultArgs),
          };
        });
      }

      const value = values[args.functionName];
      if (value instanceof Error) throw value;
      return value;
    },
    getBlockNumber: async () => {
      blockReads += 1;
      return 500n;
    },
  } as unknown as PublicClient;

  return { client, calls, subCalls, blocks, blockReads: () => blockReads };
}

test("lists only view and pure functions, including legacy constant", () => {
  const names = listViewFunctions(abi).map((fn) => fn.name);

  assert.deepEqual(names, ["name", "decimals", "balanceOf", "allowance", "legacyTotal"]);
  assert.equal(names.includes("transfer"), false, "nonpayable is excluded");
});

test("parses the contract, the ABI, and an optional argument spec", () => {
  const plain = parseViewsArgs([TOKEN.toLowerCase(), "--abi", "abi.json"]);
  assert.equal(plain.address, TOKEN, "address is checksummed");
  assert.equal(plain.spec, null);

  const list = parseViewsArgs([TOKEN, "--abi=abi.json", "--args", `["${OWNER}"]`]);
  assert.deepEqual(list.spec, { kind: "array", args: [OWNER] });

  const map = parseViewsArgs([TOKEN, "--abi", "abi.json", "--args", `{"allowance":["${OWNER}"]}`]);
  assert.deepEqual(map.spec, { kind: "map", args: { allowance: [OWNER] } });

  assert.equal(parseViewsArgs([TOKEN]).block, "latest", "the head block is the default");
  assert.equal(parseViewsArgs([TOKEN, "--block", "123"]).block, 123n);
  assert.equal(parseViewsArgs([TOKEN, "--block=75416693"]).block, 75416693n);
  assert.equal(parseViewsArgs([TOKEN, "--block", "latest"]).block, "latest");
  assert.equal(parseViewsArgs([TOKEN]).maxSubCalls, null, "one batch by default");
  assert.equal(parseViewsArgs([TOKEN, "--max-subcalls", "10"]).maxSubCalls, 10);
  assert.equal(parseViewsArgs([TOKEN, "--max-subcalls=3"]).maxSubCalls, 3);
  expectArgError(
    () => parseViewsArgs([TOKEN, "--max-subcalls", "0"]),
    /--max-subcalls must be between 1 and 1000/,
  );
  expectArgError(() => parseViewsArgs([TOKEN, "--max-subcalls", "1001"]), /between 1 and 1000/);
  expectArgError(() => parseViewsArgs([TOKEN, "--max-subcalls", "nope"]), /whole number/);
  expectArgError(() => parseViewsArgs([TOKEN, "--max-subcalls"]), /requires a value/);
  expectArgError(
    () => parseViewsArgs([TOKEN, "--block", "0x10"]),
    /--block must be "latest" or a block number/,
  );
});

test("rejects a missing address or malformed arguments", () => {
  expectArgError(() => parseViewsArgs(["--abi", "abi.json"]), /contract address is required/);
  expectArgError(() => parseViewsArgs(["0xnope", "--abi", "abi.json"]), /not a valid EVM address/);
  assert.equal(parseViewsArgs([TOKEN]).abiPath, null, "--abi is optional");
  assert.equal(parseViewsArgs([TOKEN, "--abi", "abi.json"]).abiPath, "abi.json");
  expectArgError(() => parseViewsArgs([TOKEN, "extra", "--abi", "abi.json"]), /extra argument/);
  expectArgError(() => parseViewsArgs([TOKEN, "--abi"]), /--abi requires a value/);
  expectArgError(() => parseViewsArgs([TOKEN, "--abi=abi.json", "--args", "nope"]), /not valid JSON/);
  expectArgError(() => parseViewsArgs([TOKEN, "--abi=abi.json", "--args", '"x"']), /JSON array/);
  expectArgError(
    () => parseViewsArgs([TOKEN, "--abi=abi.json", "--args", '{"allowance":"x"}']),
    /must be an array of arguments/,
  );
});

test("runs zero-argument functions and skips ones that need arguments", async () => {
  const { client, calls, subCalls } = makeClient({
    name: "USDT",
    decimals: 6,
    legacyTotal: 1_000_000n,
  });

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json");

  assert.equal(report.blockNumber, 500n);
  assert.deepEqual(calls, ["aggregate3"], "every getter rides in one aggregate3 call");
  assert.deepEqual(subCalls, ["name", "decimals", "legacyTotal"]);
  assert.equal(report.called, 3);
  assert.equal(report.skipped, 2);
  assert.equal(report.failed, 0);

  const skipped = report.results.find((result) => result.fn.name === "balanceOf");
  assert.equal(skipped?.status, "skipped");
  assert.equal(skipped?.reason, "needs 1 argument(s)");
});

test("an argument array runs the functions whose arity matches", async () => {
  const { client, calls } = makeClient({
    name: "USDT",
    decimals: 6,
    balanceOf: 28_275n,
    legacyTotal: 1n,
  });

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json", {
    kind: "array",
    args: [OWNER],
  });
  const byName = new Map(report.results.map((result) => [result.fn.name, result]));

  assert.equal(byName.get("name")?.status, "ok", "zero-argument functions still run");
  assert.equal(byName.get("balanceOf")?.status, "ok");
  assert.equal(byName.get("balanceOf")?.value, 28_275n);
  assert.deepEqual(byName.get("balanceOf")?.args, [OWNER]);
  assert.equal(byName.get("allowance")?.status, "skipped", "arity 2 does not match one argument");
  assert.deepEqual(calls, ["aggregate3"]);
});

test("a per-function map targets exactly the function named", async () => {
  const { client, subCalls } = makeClient({
    name: "USDT",
    decimals: 6,
    allowance: 0n,
    balanceOf: 28_275n,
    legacyTotal: 1n,
  });

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json", {
    kind: "map",
    args: { allowance: [OWNER, SPENDER] },
  });
  const byName = new Map(report.results.map((result) => [result.fn.name, result]));

  assert.ok(subCalls.includes("allowance"));
  assert.equal(byName.get("allowance")?.status, "ok");
  assert.equal(byName.get("balanceOf")?.status, "skipped", "not named in the map");
});

test("a full signature in the --args map targets one overload", async () => {
  const overloadAbi = [
    {
      type: "function",
      name: "get",
      stateMutability: "view",
      inputs: [{ name: "id", type: "uint256" }],
      outputs: [{ name: "", type: "uint256" }],
    },
    {
      type: "function",
      name: "get",
      stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as unknown as Abi;

  const { client, subCalls } = makeClient({ get: 43n }, { abi: overloadAbi });
  const report = await runViewFunctions(client, TOKEN, overloadAbi, "overloads.json", {
    kind: "map",
    args: { "get( uint256 )": [7n] },
  });
  const bySignature = new Map(report.results.map((result) => [result.signature, result]));

  assert.deepEqual(subCalls, ["get"], "only the named overload was sent");
  assert.equal(bySignature.get("get(uint256)")?.status, "ok");
  assert.equal(bySignature.get("get(uint256)")?.value, 43n);
  assert.deepEqual(bySignature.get("get(uint256)")?.args, [7n]);
  assert.equal(bySignature.get("get(address)")?.status, "skipped");
  assert.equal(bySignature.get("get(address)")?.reason, "needs 1 argument(s)");
});

test("a bare name applies to every overload, so signatures disambiguate", async () => {
  const overloadAbi = [
    {
      type: "function",
      name: "get",
      stateMutability: "view",
      inputs: [{ name: "id", type: "uint256" }],
      outputs: [{ name: "", type: "uint256" }],
    },
    {
      type: "function",
      name: "get",
      stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as unknown as Abi;

  const { client } = makeClient({ get: 43n }, { abi: overloadAbi });
  const report = await runViewFunctions(client, TOKEN, overloadAbi, "overloads.json", {
    kind: "map",
    args: { get: [7n] },
  });
  const bySignature = new Map(report.results.map((result) => [result.signature, result]));

  assert.equal(bySignature.get("get(uint256)")?.status, "ok");
  assert.equal(bySignature.get("get(address)")?.status, "error");
  assert.match(bySignature.get("get(address)")?.error ?? "", /expects an EVM address/);
});

test("tuple signatures keep tuple-only overloads apart", async () => {
  const tupleAbi = [
    {
      type: "function",
      name: "set",
      stateMutability: "view",
      inputs: [
        {
          name: "order",
          type: "tuple",
          components: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
      ],
      outputs: [{ name: "", type: "bool" }],
    },
    {
      type: "function",
      name: "set",
      stateMutability: "view",
      inputs: [
        {
          name: "order",
          type: "tuple",
          components: [
            { name: "ok", type: "bool" },
            { name: "data", type: "bytes" },
          ],
        },
      ],
      outputs: [{ name: "", type: "bool" }],
    },
  ] as unknown as Abi;

  const { client, subCalls } = makeClient({ set: true }, { abi: tupleAbi });
  const report = await runViewFunctions(client, TOKEN, tupleAbi, "tuples.json", {
    kind: "map",
    args: { "set((bool,bytes))": [[true, "0x1234"]] },
  });
  const bySignature = new Map(report.results.map((result) => [result.signature, result]));

  assert.deepEqual(subCalls, ["set"], "only the tuple overload named was sent");
  assert.equal(bySignature.get("set((address,uint256))")?.status, "skipped");
  assert.equal(bySignature.get("set((bool,bytes))")?.status, "ok");
  assert.equal(bySignature.get("set((bool,bytes))")?.value, true);
});

test("one reverting call is reported without stopping the others", async () => {
  const { client, calls } = makeClient({
    name: new Error("execution reverted"),
    decimals: 6,
    legacyTotal: 1n,
  });

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json");

  assert.equal(report.failed, 1);
  assert.deepEqual(calls, ["aggregate3"], "one batch carries the healthy calls too");
  assert.equal(report.called, 2, "the healthy calls still ran");
  assert.equal(toViewsJson(report).ok, false);

  const bad = report.results.find((result) => result.fn.name === "name");
  assert.equal(bad?.status, "error");
  assert.match(bad?.error ?? "", /execution reverted/);
});

test("a bad argument type fails that call only", async () => {
  const { client } = makeClient({ name: "USDT", decimals: 6, balanceOf: 1n, legacyTotal: 1n });

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json", {
    kind: "array",
    args: ["not-an-address"],
  });

  const balance = report.results.find((result) => result.fn.name === "balanceOf");
  assert.equal(balance?.status, "error");
  assert.match(balance?.error ?? "", /expects an EVM address/);
});

test("reads the block once for the whole run", async () => {
  const { client, blockReads } = makeClient({ name: "USDT", decimals: 6, legacyTotal: 1n });

  await runViewFunctions(client, TOKEN, abi, "abi.json");

  assert.equal(blockReads(), 1);
});

test("--block pins the run and skips the head lookup", async () => {
  const { client, blocks, blockReads } = makeClient({
    name: "USDT",
    decimals: 6,
    legacyTotal: 1n,
  });

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json", null, 75416693n);

  assert.equal(report.blockNumber, 75416693n);
  assert.equal(blockReads(), 0, "a pinned run never asks the RPC for its head");
  assert.deepEqual(blocks, [75416693n], "the aggregate is read at the requested block");
});

test("a wide ABI is still one Multicall3 round trip", async () => {
  const wideAbi = Array.from({ length: 40 }, (_, index) => ({
    type: "function",
    name: `get${index}`,
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  })) as unknown as Abi;
  const values = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`get${index}`, BigInt(index)]),
  );

  const { client, calls, subCalls } = makeClient(values, { abi: wideAbi });
  const report = await runViewFunctions(client, TOKEN, wideAbi, "wide.json");

  assert.equal(calls.length, 1, "40 getters, one eth_call");
  assert.equal(calls[0], "aggregate3");
  assert.equal(subCalls.length, 40);
  assert.equal(report.called, 40);
});

test("--max-subcalls splits work across several Multicall3 requests", async () => {
  const { client, calls, subCalls } = makeClient({
    name: "USDT",
    decimals: 6,
    legacyTotal: 1_000_000n,
  });

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json", null, "latest", 2);

  assert.deepEqual(calls, ["aggregate3", "aggregate3"], "3 getters at 2 per request");
  assert.deepEqual(subCalls, ["name", "decimals", "legacyTotal"]);
  assert.equal(report.called, 3);
  assert.equal(report.failed, 0);
  assert.equal(report.chunks, 2);
  assert.equal(report.maxSubCalls, 2);
  assert.equal(toViewsJson(report).chunkCount, 2);
  assert.match(formatViews(report), /2 multicall3 requests, max 2 sub-calls/);
});

test("a failed capped batch falls back to individual reads per chunk", async () => {
  const { client, calls } = makeClient(
    { name: "USDT", decimals: 6, legacyTotal: 1_000_000n },
    { failBatch: true },
  );

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json", null, "latest", 2);

  assert.deepEqual(calls, ["aggregate3", "name", "decimals", "aggregate3", "legacyTotal"]);
  assert.equal(report.called, 3);
  assert.equal(report.failed, 0);
});

test("falls back to individual reads when the batch cannot be used", async () => {
  const { client, calls } = makeClient(
    { name: "USDT", decimals: 6, legacyTotal: 1_000_000n },
    { failBatch: true },
  );

  const report = await runViewFunctions(client, TOKEN, abi, "abi.json");

  assert.deepEqual(calls, ["aggregate3", "name", "decimals", "legacyTotal"]);
  assert.equal(report.called, 3);
  assert.equal(report.failed, 0);
});

test("formatViews renders results, skips, and failures", async () => {
  const { client } = makeClient({
    name: new Error("execution reverted"),
    decimals: 6,
    legacyTotal: 1_000_000n,
  });
  const report = await runViewFunctions(client, TOKEN, abi, "./examples/erc20.abi.json");

  const text = formatViews(report);
  assert.match(text, /contract {6}0x1E4a5963aBFD975d8c9021ce480b42188849D41d/);
  assert.match(text, /functions {5}5 view\/pure: 2 called, 1 failed, 2 skipped/);
  assert.match(text, /decimals\(\)\s+6/);
  assert.match(text, /legacyTotal\(\)\s+1000000/);
  assert.match(text, /balanceOf\(address\)\s+skipped: needs 1 argument\(s\)/);
  assert.match(text, /name\(\)\s+error: execution reverted/);
});

test("toViewsJson keeps signatures and stringifies bigints", () => {
  const report: ViewsReport = {
    contract: TOKEN,
    abiPath: "abi.json",
    blockNumber: 500n,
    chunks: 0,
    maxSubCalls: null,
    results: [
      {
        fn: listViewFunctions(abi)[0]!,
        signature: "name()",
        status: "ok" as const,
        value: "USDT",
        error: null,
        reason: null,
        args: [],
      },
      {
        fn: listViewFunctions(abi)[2]!,
        signature: "balanceOf(address)",
        status: "skipped" as const,
        value: null,
        error: null,
        reason: "needs 1 argument(s)",
        args: [],
      },
    ],
    called: 1,
    failed: 0,
    skipped: 1,
  };

  const json = toViewsJson(report) as {
    ok: boolean;
    blockNumber: string;
    functions: Array<{ signature: string; status: string; value: unknown }>;
  };

  assert.equal(json.ok, true);
  assert.equal(json.blockNumber, "500");
  assert.equal(json.functions[0]?.value, "USDT");
  assert.equal(json.functions[1]?.status, "skipped");
});
