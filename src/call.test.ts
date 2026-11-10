import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import type { Abi, AbiFunction, PublicClient } from "viem";

import {
  CallArgError,
  callViewFunction,
  coerceArgs,
  extractAbi,
  findFunction,
  formatCall,
  formatValue,
  loadAbi,
  parseCallArgs,
  resolveAbi,
  signatureOf,
  toCallJson,
} from "./call.ts";
import { DEFAULT_ABI_LABEL } from "./default-abi.ts";

const OWNER = "0x000000000000000000000000000000000000dEaD";
const TOKEN = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";

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
    stateMutability: "view",
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
    name: "scale",
    stateMutability: "view",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "delta",
    stateMutability: "view",
    inputs: [{ name: "amount", type: "int256" }],
    outputs: [{ name: "", type: "int256" }],
  },
  {
    type: "function",
    name: "setFlag",
    stateMutability: "nonpayable",
    inputs: [{ name: "flag", type: "bool" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "batch",
    stateMutability: "view",
    inputs: [{ name: "accounts", type: "address[]" }],
    outputs: [{ name: "total", type: "uint256" }],
  },
  {
    type: "function",
    name: "pair",
    stateMutability: "view",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "ok", type: "bool" }],
  },
  {
    type: "function",
    name: "tag",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "", type: "string" }],
  },
] as unknown as Abi;

function expectCallError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof CallArgError && pattern.test(error.message),
  );
}

test("parses address, function, and --abi with no arguments", () => {
  const parsed = parseCallArgs([TOKEN, "decimals", "--abi", "abi.json"]);

  assert.equal(parsed.address, TOKEN);
  assert.equal(parsed.functionName, "decimals");
  assert.equal(parsed.abiPath, "abi.json");
  assert.deepEqual(parsed.args, []);
  assert.equal(parsed.block, "latest");
});

test("parses --args JSON and --block", () => {
  const parsed = parseCallArgs([
    TOKEN.toLowerCase(),
    "balanceOf",
    "--abi",
    "abi.json",
    "--args",
    `["${OWNER}"]`,
    "--block",
    "12345",
  ]);

  assert.equal(parsed.address, TOKEN, "address is checksummed");
  assert.deepEqual(parsed.args, [OWNER]);
  assert.equal(parsed.block, 12_345n);
});

test("parses repeated --arg values, treating non-JSON as strings", () => {
  const parsed = parseCallArgs([
    TOKEN,
    "allowance",
    "--abi",
    "abi.json",
    "--arg",
    OWNER,
    "--arg",
    "100",
  ]);

  assert.deepEqual(parsed.args, [OWNER, 100]);
});

test("rejects missing or malformed call inputs", () => {
  expectCallError(() => parseCallArgs([]), /contract address is required/);
  expectCallError(() => parseCallArgs(["0xnotanaddress", "name"]), /not a valid EVM address/);
  expectCallError(() => parseCallArgs([TOKEN]), /function name or signature is required/);
  assert.equal(parseCallArgs([TOKEN, "name"]).abiPath, null, "--abi is optional");
  expectCallError(() => parseCallArgs([TOKEN, "name", "extra", "--abi", "a.json"]), /extra argument/);
  expectCallError(() => parseCallArgs([TOKEN, "name", "--abi"]), /--abi requires a value/);
});

test("rejects conflicting or malformed argument inputs", () => {
  expectCallError(
    () => parseCallArgs([TOKEN, "name", "--abi", "a.json", "--args", "[]", "--arg", "1"]),
    /either --args or --arg/,
  );
  expectCallError(
    () => parseCallArgs([TOKEN, "name", "--abi", "a.json", "--args", "not json"]),
    /not valid JSON/,
  );
  expectCallError(
    () => parseCallArgs([TOKEN, "name", "--abi", "a.json", "--args", '{"a":1}']),
    /must be a JSON array/,
  );
  expectCallError(
    () => parseCallArgs([TOKEN, "name", "--abi", "a.json", "--block", "soon"]),
    /--block must be "latest" or a block number/,
  );
});

test("falls back to the built-in ERC-20 ABI without --abi", () => {
  const parsed = parseCallArgs([TOKEN, "balanceOf", "--args", `["${OWNER}"]`]);
  const { abi: builtIn, source } = resolveAbi(parsed.abiPath);

  assert.equal(source, DEFAULT_ABI_LABEL);
  assert.equal(signatureOf(findFunction(builtIn, "decimals")), "decimals()");
  assert.equal(signatureOf(findFunction(builtIn, "balanceOf")), "balanceOf(address)");
  expectCallError(() => findFunction(builtIn, "transfer"), /only view and pure/);

  const fromFile = resolveAbi(null);
  assert.equal(fromFile.source, DEFAULT_ABI_LABEL, "null and an omitted --abi behave alike");
});

test("extractAbi accepts raw arrays and wrapper objects", () => {
  assert.equal(extractAbi(abi).length, abi.length);
  assert.equal(extractAbi({ abi }).length, abi.length);
  expectCallError(() => extractAbi({ notAbi: [] }), /JSON array of ABI items/);
  expectCallError(() => extractAbi("nope"), /JSON array of ABI items/);
});

test("loadAbi reads a file and reports missing or invalid ones", () => {
  const path = ".tmp-call-abi.json";
  writeFileSync(path, JSON.stringify({ abi }));
  try {
    assert.equal(loadAbi(path).length, abi.length);
  } finally {
    unlinkSync(path);
  }

  expectCallError(() => loadAbi(".does-not-exist.json"), /ABI file not found/);

  const bad = ".tmp-call-abi-bad.json";
  writeFileSync(bad, "{not json");
  try {
    expectCallError(() => loadAbi(bad), /not valid JSON/);
  } finally {
    unlinkSync(bad);
  }
});

const overloaded = [
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
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "get",
    stateMutability: "view",
    inputs: [
      { name: "who", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as unknown as Abi;

test("resolves an overloaded name by full signature", () => {
  assert.equal(signatureOf(findFunction(overloaded, "get(address)")), "get(address)");
  assert.equal(
    signatureOf(findFunction(overloaded, "get( address )")),
    "get(address)",
    "whitespace in the signature is ignored",
  );
  assert.equal(signatureOf(findFunction(overloaded, "get(uint256)")), "get(uint256)");
  assert.equal(
    signatureOf(findFunction(overloaded, "get(address, uint256)")),
    "get(address, uint256)",
  );
});

test("renders tuple components so tuple-only overloads differ", () => {
  const tupleAbi = [
    {
      type: "function",
      name: "submit",
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
      name: "submit",
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
    {
      type: "function",
      name: "submitMany",
      stateMutability: "view",
      inputs: [
        {
          name: "orders",
          type: "tuple[]",
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
      name: "nested",
      stateMutability: "view",
      inputs: [
        {
          name: "pair",
          type: "tuple",
          components: [
            { name: "inner", type: "tuple", components: [{ name: "id", type: "uint256" }] },
            { name: "tags", type: "bytes32[2]" },
          ],
        },
      ],
      outputs: [{ name: "", type: "bool" }],
    },
  ] as unknown as Abi;

  assert.equal(signatureOf(tupleAbi[0] as AbiFunction), "submit((address,uint256))");
  assert.equal(signatureOf(tupleAbi[1] as AbiFunction), "submit((bool,bytes))");
  assert.equal(
    signatureOf(tupleAbi[2] as AbiFunction),
    "submitMany((address,uint256)[])",
    "an array of tuples keeps its suffix",
  );
  assert.equal(
    signatureOf(tupleAbi[3] as AbiFunction),
    "nested(((uint256),bytes32[2]))",
    "nested tuples expand recursively",
  );

  assert.equal(
    signatureOf(findFunction(tupleAbi, "submit((bool,bytes))")),
    "submit((bool,bytes))",
    "a tuple overload is addressable by its components",
  );
  assert.equal(
    signatureOf(findFunction(tupleAbi, "submitMany((address, uint256)[])")),
    "submitMany((address,uint256)[])",
    "whitespace is ignored",
  );
  expectCallError(
    () => findFunction(tupleAbi, "submit"),
    /submit\(\(address,uint256\)\), submit\(\(bool,bytes\)\)/,
  );
});

test("refuses to guess between overloads", () => {
  expectCallError(
    () => findFunction(overloaded, "get"),
    /"get" is overloaded; pass a full signature: get\(address\), get\(address, uint256\), get\(uint256\)/,
  );
  expectCallError(() => findFunction(overloaded, "get(bool)"), /ABI has no function "get\(bool\)"/);
  expectCallError(
    () => findFunction(overloaded, "get()"),
    /Available: get\(address\), get\(address, uint256\), get\(uint256\)/,
  );
});

test("parseCallArgs accepts a signature as the function", () => {
  const parsed = parseCallArgs([
    TOKEN,
    "get(address)",
    "--abi",
    "abi.json",
    "--args",
    `["${OWNER}"]`,
  ]);

  assert.equal(parsed.functionName, "get(address)");
  assert.deepEqual(parsed.args, [OWNER]);
});

test("findFunction finds view functions and rejects the rest", () => {
  const fn = findFunction(abi, "balanceOf");
  assert.equal(signatureOf(fn), "balanceOf(address)");

  expectCallError(() => findFunction(abi, "missing"), /Available: .*balanceOf\(address\)/);

  assert.throws(
    () => findFunction(abi, "setFlag"),
    (error: unknown) =>
      error instanceof CallArgError && /is nonpayable; only view and pure/.test(error.message),
  );
});

test("coerces integers from strings, numbers, and hex", () => {
  assert.deepEqual(coerceArgs(findFunction(abi, "balanceOf"), [OWNER]), [OWNER]);
  assert.deepEqual(coerceArgs(findFunction(abi, "scale"), ["100"]), [100n]);
  assert.deepEqual(coerceArgs(findFunction(abi, "scale"), [0x10]), [16n]);
  assert.deepEqual(coerceArgs(findFunction(abi, "scale"), ["0xff"]), [255n]);
  assert.deepEqual(coerceArgs(findFunction(abi, "delta"), ["-5"]), [-5n], "int256 allows negatives");

  expectCallError(
    () => coerceArgs(findFunction(abi, "scale"), ["-5"]),
    /must not be negative for type uint256/,
  );
  expectCallError(
    () => coerceArgs(findFunction(abi, "scale"), ["1.5"]),
    /must be an integer for uint256/,
  );
  expectCallError(
    () => coerceArgs(findFunction(abi, "allowance"), [OWNER, "100"]),
    /spender expects an EVM address/,
  );
});

test("coerces addresses, booleans, strings, bytes, arrays, and tuples", () => {
  assert.deepEqual(
    coerceArgs(findFunction(abi, "balanceOf"), [TOKEN.toLowerCase()]),
    [TOKEN],
    "addresses are checksummed",
  );
  expectCallError(
    () => coerceArgs(findFunction(abi, "balanceOf"), ["0xnope"]),
    /expects an EVM address/,
  );

  assert.deepEqual(coerceArgs(findFunction(abi, "name"), []), []);
  assert.deepEqual(
    coerceArgs(findFunction(abi, "batch"), [[TOKEN, OWNER]]),
    [[TOKEN, OWNER]],
  );
  expectCallError(() => coerceArgs(findFunction(abi, "batch"), [TOKEN]), /expects an array/);

  assert.deepEqual(
    coerceArgs(findFunction(abi, "pair"), [{ token: TOKEN, amount: "7" }]),
    [{ token: TOKEN, amount: 7n }],
  );
  expectCallError(
    () => coerceArgs(findFunction(abi, "pair"), [{ token: TOKEN }]),
    /missing tuple field "amount"/,
  );

  assert.deepEqual(
    coerceArgs(findFunction(abi, "tag"), [`0x${"ab".repeat(32)}`]),
    [`0x${"ab".repeat(32)}`],
  );
  expectCallError(() => coerceArgs(findFunction(abi, "tag"), ["0xabcd"]), /expects 32 bytes/);
});

test("rejects the wrong number of arguments", () => {
  expectCallError(
    () => coerceArgs(findFunction(abi, "allowance"), [OWNER]),
    /allowance\(address, address\) takes 2 argument\(s\), got 1/,
  );
});

test("formatValue renders bigints, arrays, and nested values", () => {
  assert.equal(formatValue(28_275n), "28275");
  assert.equal(formatValue("USDT"), "USDT");
  assert.equal(formatValue(true), "true");
  assert.equal(formatValue([1n, 2n]), "[1, 2]");
  assert.equal(formatValue({ a: 1n }), "{a: 1}");
});

test("formatCall renders a single output", () => {
  const output = formatCall({
    contract: TOKEN,
    fn: findFunction(abi, "balanceOf"),
    blockNumber: 75_417_295n,
    result: 28_275n,
  });

  assert.match(output, /contract {6}0x1E4a5963aBFD975d8c9021ce480b42188849D41d/);
  assert.match(output, /function {6}balanceOf\(address\)/);
  assert.match(output, /block {9}75417295/);
  assert.match(output, /result {8}28275/);
});

test("formatCall names each output when there are several", () => {
  const multiAbi = [
    {
      type: "function",
      name: "stats",
      stateMutability: "view",
      inputs: [],
      outputs: [
        { name: "supply", type: "uint256" },
        { name: "paused", type: "bool" },
      ],
    },
  ] as unknown as Abi;

  const output = formatCall({
    contract: TOKEN,
    fn: multiAbi[0] as AbiFunction,
    blockNumber: 1n,
    result: [1_000n, false],
  });

  assert.match(output, /supply {8}1000/);
  assert.match(output, /paused {8}false/);
});

test("toCallJson stringifies bigints and names outputs", () => {
  const payload = toCallJson({
    contract: TOKEN,
    fn: findFunction(abi, "allowance"),
    blockNumber: 75_417_295n,
    result: 42n,
  });
  const serialized = JSON.stringify(payload);

  assert.match(serialized, /"signature":"allowance\(address, address\)"/);
  assert.match(serialized, /"blockNumber":"75417295"/);
  assert.match(serialized, /"name":"remaining"/);
  assert.match(serialized, /"value":"42"/);
});

test("callViewFunction forwards ABI, args, and block, and reports the block", async () => {
  const calls: unknown[] = [];
  const client = {
    readContract: async (args: unknown) => {
      calls.push(args);
      return 28_275n;
    },
    getBlockNumber: async () => 999n,
  } as unknown as PublicClient;

  const fn = findFunction(abi, "balanceOf");

  const latest = await callViewFunction(client, TOKEN, abi, fn, [OWNER], "latest");
  assert.equal(latest.result, 28_275n);
  assert.equal(latest.blockNumber, 999n);

  const recorded = calls[0] as {
    address: string;
    functionName: string;
    args: unknown[];
    blockNumber?: bigint;
  };
  assert.equal(recorded.address, TOKEN);
  assert.equal(recorded.functionName, "balanceOf");
  assert.deepEqual(recorded.args, [OWNER]);
  assert.equal(recorded.blockNumber, undefined);

  const pinned = await callViewFunction(client, TOKEN, abi, fn, [OWNER], 100n);
  assert.equal(pinned.blockNumber, 100n);
  assert.equal((calls[1] as { blockNumber?: bigint }).blockNumber, 100n);
});
