import assert from "node:assert/strict";
import { test } from "node:test";

import type { Abi } from "viem";

import {
  SignaturesArgError,
  callableSignatures,
  formatSignatures,
  parseSignaturesArgs,
  toSignaturesJson,
} from "./signatures.ts";

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
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
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
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "stamp",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "event", name: "Transfer", inputs: [] },
] as unknown as Abi;

test("lists only callable signatures, sorted and tuple-aware", () => {
  assert.deepEqual(callableSignatures(abi), [
    "get((address,uint256))",
    "get(uint256)",
    "name()",
    "stamp()",
  ]);
});

test("formats a copy-pasteable list", () => {
  const signatures = callableSignatures(abi);
  const text = formatSignatures(signatures, "examples/erc20.abi.json");

  assert.match(text, /^lwc — callable signatures/);
  assert.match(text, /abi {11}examples\/erc20\.abi\.json/);
  assert.match(text, /signatures {4}4 view\/pure/);
  const lines = text.split("\n");
  for (const signature of signatures) {
    assert.ok(lines.includes(`  ${signature}`), `${signature} is on its own line`);
  }
  assert.equal(text.includes("transfer"), false, "nonpayable entries are not listed");
});

test("an ABI with no callable functions says so", () => {
  const empty = [{ type: "event", name: "Transfer", inputs: [] }] as unknown as Abi;

  assert.match(
    formatSignatures(callableSignatures(empty), "empty.json"),
    /no view or pure functions/,
  );
});

test("parses an optional ABI path and ignores global flags", () => {
  assert.deepEqual(parseSignaturesArgs([]), { abiPath: null });
  assert.deepEqual(parseSignaturesArgs(["./abi.json"]), { abiPath: "./abi.json" });
  assert.deepEqual(parseSignaturesArgs(["abi.json", "--json"]), { abiPath: "abi.json" });
  assert.throws(
    () => parseSignaturesArgs(["a.json", "b.json"]),
    (error: unknown) =>
      error instanceof SignaturesArgError && /extra argument/.test(error.message),
  );
});

test("JSON output carries the source and the list", () => {
  assert.deepEqual(toSignaturesJson(["a()", "b(uint256)"], "built-in ERC-20"), {
    ok: true,
    abi: "built-in ERC-20",
    count: 2,
    signatures: ["a()", "b(uint256)"],
  });
});
