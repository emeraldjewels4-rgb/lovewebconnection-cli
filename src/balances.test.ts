import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { encodeFunctionResult, erc20Abi, type Address, type PublicClient } from "viem";

import {
  BalancesArgError,
  checkTokenAddresses,
  checkTokenAddressesReport,
  formatBalances,
  formatChunkProgress,
  formatTokenAmount,
  CACHED_TOKENS_PER_BATCH,
  TOKENS_PER_BATCH,
  isPrecompileAddress,
  loadTokenList,
  parseBalanceArgs,
  readBalances,
  shortAddress,
  staleMetadataWarnings,
  toBalancesJson,
  type BalancesReport,
  type TokenBalance,
} from "./balances.ts";
import { MULTICALL3_ADDRESS, multicall3BatchAbi } from "./contract.ts";
import { MetadataCache } from "./metadata-cache.ts";
import type { ChainConfig } from "./chain.ts";

const OWNER = "0x000000000000000000000000000000000000dEaD";
const USDT = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";
const WOKB = "0xe538905cf8410324e03A5A23C1c177a474D59b2b";
const TOKEN_A = USDT;
const TOKEN_B = WOKB;

const config: ChainConfig = {
  chainId: 196,
  name: "xlayer",
  rpcUrl: "https://xlayer.drpc.org",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  authHeader: null,
  preset: "xlayer",
  timeoutMs: 15_000,
};

function expectArgError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof BalancesArgError && pattern.test(error.message),
  );
}

test("parses an owner with no tokens", () => {
  const args = parseBalanceArgs([OWNER]);

  assert.equal(args.owner, "0x000000000000000000000000000000000000dEaD");
  assert.deepEqual(args.tokens, []);
});

test("parses a batch size for Multicall3 chunks", () => {
  assert.equal(parseBalanceArgs([OWNER]).batchSize, TOKENS_PER_BATCH);
  assert.equal(parseBalanceArgs([OWNER, "--batch-size", "4"]).batchSize, 4);
  assert.equal(parseBalanceArgs([OWNER, "--batch-size=1"]).batchSize, 1);
  expectArgError(() => parseBalanceArgs([OWNER, "--batch-size", "0"]), /between 1 and 100/);
  expectArgError(() => parseBalanceArgs([OWNER, "--batch-size", "101"]), /between 1 and 100/);
  expectArgError(() => parseBalanceArgs([OWNER, "--batch-size", "many"]), /whole number/);
  expectArgError(() => parseBalanceArgs([OWNER, "--batch-size"]), /requires a value/);
});

test("parses --fail-on-retry for CI checks", () => {
  assert.equal(parseBalanceArgs([OWNER]).failOnRetry, false);
  assert.equal(parseBalanceArgs([OWNER, "--fail-on-retry"]).failOnRetry, true);
});

test("parses --stale-after as a warning threshold", () => {
  assert.equal(parseBalanceArgs([OWNER]).staleAfterMs, null);
  assert.equal(parseBalanceArgs([OWNER, "--stale-after", "30m"]).staleAfterMs, 1_800_000);
  assert.equal(parseBalanceArgs([OWNER, "--stale-after=7d"]).staleAfterMs, 604_800_000);
  expectArgError(() => parseBalanceArgs([OWNER, "--stale-after", "30"]), /must look like 30m/);
  expectArgError(() => parseBalanceArgs([OWNER, "--stale-after"]), /requires a duration/);
  expectArgError(() => parseBalanceArgs([OWNER, "--stale-after", "0d"]), /positive duration/);
});

test("warns when cached metadata is older than --stale-after", () => {
  const day = 86_400_000;
  const tokens: TokenBalance[] = [
    {
      address: USDT,
      symbol: "USDT",
      label: null,
      decimals: 6,
      balance: 1n,
      cacheAgeMs: 2 * day,
      issue: null,
    },
    {
      address: WOKB,
      symbol: "WOKB",
      label: "Wrapped OKB",
      decimals: 18,
      balance: 1n,
      cacheAgeMs: 30 * 60_000,
      issue: null,
    },
    {
      address: OWNER,
      symbol: "???",
      label: null,
      decimals: null,
      balance: null,
      cacheAgeMs: null,
      issue: "no data returned for this address",
    },
  ];

  assert.deepEqual(staleMetadataWarnings(tokens, day), [
    "USDT (0x1E4a…D41d) metadata is 2d old, stale after 24h",
  ]);
  assert.deepEqual(staleMetadataWarnings(tokens, 2 * day), [], "only ages over the threshold warn");
  assert.deepEqual(staleMetadataWarnings(tokens, null), [], "no flag, no warnings");
  assert.deepEqual(staleMetadataWarnings([tokens[1]!], day), [], "fresh cached metadata is quiet");
});

test("parses --verbose for per-chunk progress", () => {
  assert.equal(parseBalanceArgs([OWNER]).verbose, false);
  assert.equal(parseBalanceArgs([OWNER, "--verbose"]).verbose, true);
});

test("formats per-chunk progress for --verbose", () => {
  const base = {
    owner: OWNER as Address,
    index: 2,
    total: 3,
    tokens: 4,
    error: null,
    individual: [] as Address[],
  };

  assert.equal(
    formatChunkProgress({ ...base, status: "batched" }),
    "  chunk 0x0000…dEaD 2/3 (4 tokens) ok",
  );
  assert.equal(
    formatChunkProgress({ ...base, status: "recovered" }),
    "  chunk 0x0000…dEaD 2/3 (4 tokens) retried, recovered",
  );
  assert.equal(
    formatChunkProgress({ ...base, status: "partial", individual: [USDT] }),
    "  chunk 0x0000…dEaD 2/3 (4 tokens) retried, partial, 1 individual",
  );
  assert.equal(
    formatChunkProgress({ ...base, status: "failed", individual: [USDT, WOKB] }),
    "  chunk 0x0000…dEaD 2/3 (4 tokens) failed, 2 individual",
  );
  assert.equal(
    formatChunkProgress({ ...base, index: 1, tokens: 1, status: "batched" }),
    "  chunk 0x0000…dEaD 1/3 (1 token) ok",
  );
});

test("parses a sub-call cap as an alternative to batch size", () => {
  assert.equal(parseBalanceArgs([OWNER]).maxSubCalls, null);
  assert.equal(parseBalanceArgs([OWNER, "--max-subcalls", "7"]).maxSubCalls, 7);
  assert.equal(parseBalanceArgs([OWNER, "--max-subcalls=49"]).maxSubCalls, 49);
  expectArgError(() => parseBalanceArgs([OWNER, "--max-subcalls", "0"]), /between 1 and 1000/);
  expectArgError(() => parseBalanceArgs([OWNER, "--max-subcalls", "1001"]), /between 1 and 1000/);
  expectArgError(() => parseBalanceArgs([OWNER, "--max-subcalls", "many"]), /whole number/);
  expectArgError(() => parseBalanceArgs([OWNER, "--max-subcalls"]), /requires a value/);
  expectArgError(
    () => parseBalanceArgs([OWNER, "--batch-size", "4", "--max-subcalls", "9"]),
    /not both/,
  );
  expectArgError(
    () => parseBalanceArgs([OWNER, "--max-subcalls", "9", "--batch-size=4"]),
    /not both/,
  );
});

test("lowercases are checksummed", () => {
  const args = parseBalanceArgs([OWNER.toLowerCase(), "--token", TOKEN_A.toLowerCase()]);

  assert.equal(args.tokens[0], TOKEN_A);
});

function withTempJson(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lwc-tokens-"));
  try {
    const path = join(dir, "tokens.json");
    writeFileSync(path, contents);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loads a saved token list from a JSON array or a tokens object", () => {
  withTempJson(JSON.stringify([TOKEN_A.toLowerCase(), TOKEN_B]), (path) => {
    assert.deepEqual(loadTokenList(path), [
      { address: TOKEN_A, label: null },
      { address: TOKEN_B, label: null },
    ], "addresses are checksummed");
  });
  withTempJson(JSON.stringify({ tokens: [TOKEN_A] }), (path) => {
    assert.deepEqual(loadTokenList(path), [{ address: TOKEN_A, label: null }]);
  });
  withTempJson("[]", (path) => {
    assert.deepEqual(loadTokenList(path), []);
  });
});

test("token entries accept an optional label", () => {
  withTempJson(
    JSON.stringify([
      { address: TOKEN_A.toLowerCase(), label: "  Tether USD  " },
      { address: TOKEN_B },
      { address: TOKEN_A, label: "   " },
    ]),
    (path) => {
      assert.deepEqual(loadTokenList(path), [
        { address: TOKEN_A, label: "Tether USD" },
        { address: TOKEN_B, label: null },
        { address: TOKEN_A, label: null },
      ]);
    },
  );
});

test("rejects a malformed inline token label", () => {
  expectArgError(
    () => parseBalanceArgs([OWNER, "--token", `${TOKEN_A}:${'x'.repeat(65)}`]),
    /label longer than 64/,
  );
  expectArgError(
    () => parseBalanceArgs([OWNER, "--token", "0x123:Tether"]),
    /not a valid token address/,
  );
});

test("warns when duplicate token labels conflict", () => {
  const args = parseBalanceArgs([
    OWNER,
    "--token",
    `${TOKEN_A}:First`,
    "--token",
    `${TOKEN_A}:Second`,
  ]);

  assert.deepEqual(args.tokens, [TOKEN_A]);
  assert.equal(args.labels.get(TOKEN_A.toLowerCase()), "Second");
  assert.equal(args.warnings.length, 1);
  assert.match(args.warnings[0] ?? "", /conflicting labels "First" and "Second"/);

  const same = parseBalanceArgs([
    OWNER,
    "--token",
    `${TOKEN_A}:Same`,
    "--token",
    `${TOKEN_A}:Same`,
  ]);
  assert.deepEqual(same.warnings, [], "an identical repeated label is not a conflict");
});

test("inline labels override token-file labels", () => {
  withTempJson(JSON.stringify([{ address: TOKEN_A, label: "File Label" }]), (path) => {
    const args = parseBalanceArgs([
      OWNER,
      "--token",
      `${TOKEN_A}:Inline Label`,
      "--tokens-file",
      path,
    ]);

    assert.equal(args.labels.get(TOKEN_A.toLowerCase()), "Inline Label");
    assert.equal(args.warnings.length, 1);
    assert.match(
      args.warnings[0] ?? "",
      /inline label "Inline Label" overrides file label "File Label"/,
    );
  });
});

test("rejects a malformed labelled entry", () => {
  withTempJson(JSON.stringify([{ address: TOKEN_A, label: 42 }]), (path) => {
    expectArgError(() => loadTokenList(path), /entry 1 has a non-string label/);
  });
  withTempJson(JSON.stringify([{ label: "no address" }]), (path) => {
    expectArgError(() => loadTokenList(path), /entry 1 is not an EVM address/);
  });
  withTempJson(JSON.stringify([{ address: TOKEN_A, label: "x".repeat(65) }]), (path) => {
    expectArgError(() => loadTokenList(path), /label longer than 64 characters/);
  });
});

test("labels reach the table and the JSON", async () => {
  withTempJson(JSON.stringify([{ address: TOKEN_A, label: "Tether USD" }]), (path) => {
    const args = parseBalanceArgs([OWNER, "--tokens-file", path]);
    assert.deepEqual(args.tokens, [TOKEN_A]);
    assert.equal(args.labels.get(TOKEN_A.toLowerCase()), "Tether USD");
  });

  const inline = parseBalanceArgs([OWNER, "--token", `${TOKEN_A}:Tether USD`]);
  assert.deepEqual(inline.tokens, [TOKEN_A]);
  assert.equal(inline.labels.get(TOKEN_A.toLowerCase()), "Tether USD");

  const labels = inline.labels;
  const { client } = readingStub([
    ok(nativeData),
    ok(decimals6),
    ok(symbolUsdt),
    ok(balanceUsdt),
    ok(supplyUsdt),
  ]);
  const result = await readBalances(client, config, OWNER, [TOKEN_A], { labels });

  assert.equal(result.tokens[0]?.label, "Tether USD");
  assert.match(formatBalances(result), /0\.028275 USDT \[Tether USD\] \(0x1E4a/);
  const json = toBalancesJson(result) as { tokens: Array<{ label: string | null }> };
  assert.equal(json.tokens[0]?.label, "Tether USD");
});

test("--tokens-file merges with --token and dedupes", () => {
  withTempJson(JSON.stringify([TOKEN_A, TOKEN_B]), (path) => {
    assert.deepEqual(parseBalanceArgs([OWNER, "--token", TOKEN_A, "--tokens-file", path]).tokens, [
      TOKEN_A,
      TOKEN_B,
    ]);
    assert.deepEqual(
      parseBalanceArgs([OWNER, `--tokens-file=${path}`]).tokens,
      [TOKEN_A, TOKEN_B],
      "--tokens-file= works too",
    );
  });
});

test("rejects an unusable token list, naming the file and the entry", () => {
  withTempJson("{not json", (path) => {
    expectArgError(() => loadTokenList(path), /not valid JSON/);
  });
  withTempJson(JSON.stringify({ nope: [] }), (path) => {
    expectArgError(() => loadTokenList(path), /must be a JSON array of addresses/);
  });
  withTempJson(JSON.stringify([TOKEN_A, "0xnot-an-address"]), (path) => {
    expectArgError(() => loadTokenList(path), /entry 2 is not an EVM address/);
  });
  expectArgError(() => parseBalanceArgs([OWNER, "--tokens-file"]), /requires a path/);
  expectArgError(() => loadTokenList("definitely-not-here.json"), /cannot read token list/);
});

test("accepts --token, --token=, --tokens, and --tokens=", () => {
  assert.deepEqual(parseBalanceArgs([OWNER, "--token", TOKEN_A]).tokens, [TOKEN_A]);
  assert.deepEqual(parseBalanceArgs([OWNER, `--token=${TOKEN_A}`]).tokens, [TOKEN_A]);
  assert.deepEqual(parseBalanceArgs([OWNER, "--tokens", `${TOKEN_A},${TOKEN_B}`]).tokens, [
    TOKEN_A,
    TOKEN_B,
  ]);
  assert.deepEqual(parseBalanceArgs([OWNER, `--tokens=${TOKEN_A},${TOKEN_B}`]).tokens, [
    TOKEN_A,
    TOKEN_B,
  ]);
});

test("deduplicates tokens and ignores unrelated flags", () => {
  const args = parseBalanceArgs([
    OWNER,
    "--json",
    "--token",
    TOKEN_A,
    "--token",
    TOKEN_A.toLowerCase(),
  ]);

  assert.deepEqual(args.tokens, [TOKEN_A]);
});

test("rejects a missing or malformed owner", () => {
  expectArgError(() => parseBalanceArgs([]), /owner address is required/);
  expectArgError(() => parseBalanceArgs(["--token", TOKEN_A]), /owner address is required/);
  expectArgError(() => parseBalanceArgs(["0x123"]), /not a valid EVM address/);
});

test("rejects a malformed token and dangling --token", () => {
  expectArgError(() => parseBalanceArgs([OWNER, "--token"]), /--token requires an address/);
  expectArgError(() => parseBalanceArgs([OWNER, "--token", "nope"]), /not a valid token address/);
  expectArgError(() => parseBalanceArgs([OWNER, "--tokens"]), /comma-separated list/);
});

test("rejects extra positional arguments", () => {
  expectArgError(() => parseBalanceArgs([OWNER, TOKEN_A]), /Unexpected extra argument/);
});

test("formats base units without trailing zeros", () => {
  assert.equal(formatTokenAmount(0n, 18), "0");
  assert.equal(formatTokenAmount(1n, 18), "0.000000000000000001");
  assert.equal(formatTokenAmount(10n ** 18n, 18), "1");
  assert.equal(formatTokenAmount(1_234_500n, 6), "1.2345");
  assert.equal(formatTokenAmount(1_000_000n, 6), "1");
  assert.equal(formatTokenAmount(42n, 0), "42");
  assert.equal(formatTokenAmount(1_500_000_000_000_000_000n, 18), "1.5");
});

test("shortAddress truncates in the middle", () => {
  assert.equal(shortAddress(TOKEN_A), "0x1E4a…D41d");
});

const report: BalancesReport = {
  owner: "0x000000000000000000000000000000000000dEaD",
  chainId: 196,
  chainName: "xlayer",
  native: { symbol: "OKB", decimals: 18, balance: 1_234_500_000_000_000_000n },
  tokens: [
    {
      address: TOKEN_A,
      symbol: "USDT",
      label: null,
      decimals: 6,
      balance: 2_500_000n,
      cacheAgeMs: null,
      issue: null,
    },
    {
      address: TOKEN_B,
      symbol: shortAddress(TOKEN_B),
      label: null,
      decimals: null,
      balance: 7n,
      cacheAgeMs: null,
      issue: "decimals is not a uint8",
    },
    {
      address: "0x0000000000000000000000000000000000000001",
      symbol: "BAD",
      label: null,
      decimals: 18,
      balance: null,
      cacheAgeMs: null,
      issue: "balanceOf reverted",
    },
  ],
  blockNumber: 75_416_262n,
  batchWarning: null,
  batchSize: 12,
  chunkCount: 0,
  chunks: [],
  recovery: { failedChunks: 0, retryRequests: 0, recoveredChunks: 0 },
  cache: { hits: 0, misses: 0 },
};

test("formatBalances renders native, tokens, and degraded reads", () => {
  const output = formatBalances(report);

  assert.match(output, /owner {9}0x000000000000000000000000000000000000dEaD/);
  assert.match(output, /chain {9}xlayer \(196\)/);
  assert.match(output, /block {9}75416262/);
  assert.match(output, /native {8}1\.2345 OKB/);
  assert.match(output, /token {9}2\.5 USDT \(0x1E4a5963aBFD975d8c9021ce480b42188849D41d\)/);
  assert.match(output, /token {9}7 raw \(0xe538905cf8410324e03A5A23C1c177a474D59b2b\) — decimals is not a uint8/);
  assert.match(
    output,
    /token {9}unreadable \(0x0000000000000000000000000000000000000001\) — balanceOf reverted/,
  );
  assert.match(output, /flagged {7}2 of 3 addresses do not look like a working ERC-20/);
});

test("formatBalances explains when no tokens were requested", () => {
  const output = formatBalances({ ...report, tokens: [] });

  assert.match(output, /none requested/);
});

test("toBalancesJson stringifies bigints and keeps nulls for degraded reads", () => {
  const payload = toBalancesJson(report);
  const serialized = JSON.stringify(payload);

  assert.match(serialized, /"balance":"1234500000000000000"/);
  assert.match(serialized, /"formatted":"1\.2345"/);
  assert.match(serialized, /"balance":"2500000"/);
  assert.match(serialized, /"decimals":null/);
  assert.match(serialized, /"balance":null/);
  assert.match(serialized, /"blockNumber":"75416262"/);
  assert.deepEqual(payload.cache, { hits: 0, misses: 0 });
});

// --- batching -------------------------------------------------------------

const nativeData = encodeFunctionResult({
  abi: multicall3BatchAbi,
  functionName: "getEthBalance",
  result: 100n,
});
const decimals6 = encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 });
const decimals18 = encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 18 });
const symbolUsdt = encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "USDT" });
const symbolWokb = encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "WOKB" });
const balanceUsdt = encodeFunctionResult({
  abi: erc20Abi,
  functionName: "balanceOf",
  result: 28_275n,
});
const balanceWokb = encodeFunctionResult({
  abi: erc20Abi,
  functionName: "balanceOf",
  result: 280_072_887_730_740_496_648n,
});
const supplyUsdt = encodeFunctionResult({
  abi: erc20Abi,
  functionName: "totalSupply",
  result: 1_000_000_000n,
});
const supplyWokb = encodeFunctionResult({
  abi: erc20Abi,
  functionName: "totalSupply",
  result: 1_000n * 10n ** 18n,
});

function ok(returnData: `0x${string}`) {
  return { success: true, returnData };
}

function readingStub(results: Array<{ success: boolean; returnData: string }>) {
  return stub(async (args) => {
    if (args.functionName === "aggregate3") return results;
    throw new Error(`unexpected individual call: ${args.functionName}`);
  });
}

test("flags a wrong-typed symbol but still reports the balance", async () => {
  const bytes32Fake = `0x${Buffer.from("FAKE").toString("hex").padEnd(64, "0")}` as `0x${string}`;
  const { client } = readingStub([
    ok(nativeData),
    ok(decimals6),
    ok(bytes32Fake),
    ok(balanceUsdt),
    ok(supplyUsdt),
  ]);

  const result = await readBalances(client, config, OWNER, [USDT]);
  const token = result.tokens[0];

  assert.equal(token?.balance, 28_275n, "the balance still decodes");
  assert.equal(token?.decimals, 6);
  assert.equal(token?.symbol, shortAddress(USDT), "a bytes32 symbol falls back to the address");
  assert.match(token?.issue ?? "", /symbol is bytes32 \(FAKE\), not a string/);
  assert.match(formatBalances(result), /— symbol is bytes32 \(FAKE\), not a string/);

  const json = toBalancesJson(result) as { tokens: Array<{ issue: string | null }> };
  assert.match(json.tokens[0]?.issue ?? "", /bytes32/);
});

test("distinguishes no-code, reverting, and malformed-decimals addresses", async () => {
  const noCode = await readBalances(
    readingStub([ok(nativeData), ok("0x"), ok("0x"), ok("0x"), ok("0x")]).client,
    config,
    OWNER,
    [USDT],
  );
  assert.match(noCode.tokens[0]?.issue ?? "", /no contract code/);
  assert.equal(noCode.tokens[0]?.balance, null);

  const reverted = { success: false, returnData: "0x" };
  const reverting = await readBalances(
    readingStub([ok(nativeData), reverted, reverted, reverted, reverted]).client,
    config,
    OWNER,
    [USDT],
  );
  assert.match(
    reverting.tokens[0]?.issue ?? "",
    /reverted on decimals, symbol, balanceOf and totalSupply \(not an ERC-20\)/,
  );

  const shortDecimals = "0x1234" as `0x${string}`;
  const malformed = await readBalances(
    readingStub([
      ok(nativeData),
      ok(shortDecimals),
      ok(symbolUsdt),
      ok(balanceUsdt),
      ok(supplyUsdt),
    ]).client,
    config,
    OWNER,
    [USDT],
  );
  assert.equal(malformed.tokens[0]?.decimals, null);
  assert.match(malformed.tokens[0]?.issue ?? "", /decimals is not a uint8/);
  assert.equal(malformed.tokens[0]?.balance, 28_275n, "a bad decimals field does not hide the balance");

  const badSupply = await readBalances(
    readingStub([
      ok(nativeData),
      ok(decimals6),
      ok(symbolUsdt),
      ok(balanceUsdt),
      ok("0x1234" as `0x${string}`),
    ]).client,
    config,
    OWNER,
    [USDT],
  );
  assert.match(badSupply.tokens[0]?.issue ?? "", /totalSupply is not a uint256/);
});

test("cached metadata skips the decimals and symbol sub-calls", async () => {
  const cache = new MetadataCache({ chainId: 196, persist: false });
  cache.set(USDT, { symbol: "USDT", decimals: 6 });

  const sizes: number[] = [];
  const client = {
    readContract: async (args: { functionName?: string; args?: unknown[] }) => {
      if (args.functionName !== "aggregate3") throw new Error(`unexpected: ${args.functionName}`);
      sizes.push((args.args?.[0] as unknown[]).length);
      return [ok(nativeData), ok(balanceUsdt), ok(supplyUsdt)];
    },
    getBalance: async () => 123n,
    getBlockNumber: async () => 75_418_000n,
  } as unknown as PublicClient;

  const result = await readBalances(client, config, OWNER, [USDT], { cache });

  assert.deepEqual(sizes, [3], "native plus balanceOf and totalSupply");
  assert.equal(result.tokens[0]?.symbol, "USDT");
  assert.equal(result.tokens[0]?.decimals, 6);
  assert.equal(result.tokens[0]?.balance, 28_275n);
  assert.equal(result.tokens[0]?.issue, null);
  assert.equal(typeof result.tokens[0]?.cacheAgeMs, "number");
  assert.equal(result.batchSize, CACHED_TOKENS_PER_BATCH);
  assert.equal(result.chunkCount, 1);
  assert.match(formatBalances(result), /\[cached \d+[smhd]\]/);
  assert.equal(
    (toBalancesJson(result) as { tokens: Array<{ cacheAgeMs: unknown }> }).tokens[0]
      ?.cacheAgeMs,
    result.tokens[0]?.cacheAgeMs,
  );
  assert.deepEqual(
    (({ batchSize, chunkCount }) => ({ batchSize, chunkCount }))(toBalancesJson(result) as {
      batchSize: number;
      chunkCount: number;
    }),
    { batchSize: CACHED_TOKENS_PER_BATCH, chunkCount: 1 },
  );
  assert.deepEqual(result.cache, { hits: 1, misses: 0 });
  assert.deepEqual(
    (toBalancesJson(result) as { cache: { hits: number; misses: number } }).cache,
    { hits: 1, misses: 0 },
  );
});

test("parses --max-cache-age as a duration", () => {
  assert.equal(parseBalanceArgs([OWNER, "--max-cache-age", "30m"]).maxCacheAgeMs, 1_800_000);
  assert.equal(parseBalanceArgs([OWNER, "--max-cache-age=7d"]).maxCacheAgeMs, 604_800_000);
  expectArgError(
    () => parseBalanceArgs([OWNER, "--max-cache-age", "30"]),
    /must look like 30m/,
  );
  expectArgError(() => parseBalanceArgs([OWNER, "--max-cache-age"]), /requires a duration/);
  expectArgError(() => parseBalanceArgs([OWNER, "--max-cache-age", "0d"]), /positive duration/);
});

test("maxCacheAgeMs refreshes stale metadata and keeps fresh entries", async () => {
  const day = 24 * 60 * 60 * 1000;
  const stale = new MetadataCache({
    chainId: 196,
    persist: false,
    now: () => Date.now() - 2 * day,
  });
  stale.set(USDT, { symbol: "OLD", decimals: 6 });

  const sizes: number[] = [];
  const client = {
    readContract: async (args: { functionName?: string; args?: unknown[] }) => {
      if (args.functionName !== "aggregate3") throw new Error(`unexpected: ${args.functionName}`);
      sizes.push((args.args?.[0] as unknown[]).length);
      return [ok(nativeData), ok(decimals6), ok(symbolUsdt), ok(balanceUsdt), ok(supplyUsdt)];
    },
    getBalance: async () => 123n,
    getBlockNumber: async () => 75_418_000n,
  } as unknown as PublicClient;

  const result = await readBalances(client, config, OWNER, [USDT], {
    cache: stale,
    maxCacheAgeMs: day,
  });

  assert.deepEqual(sizes, [5], "stale metadata is re-read with the balance");
  assert.deepEqual(result.cache, { hits: 0, misses: 1 });
  assert.equal(result.tokens[0]?.cacheAgeMs, null, "refreshed metadata is not reported as cached");
  assert.deepEqual(stale.get(USDT), { symbol: "USDT", decimals: 6 });

  const fresh = new MetadataCache({ chainId: 196, persist: false });
  fresh.set(USDT, { symbol: "USDT", decimals: 6 });
  const hits: number[] = [];
  const freshClient = {
    readContract: async (args: { functionName?: string; args?: unknown[] }) => {
      hits.push((args.args?.[0] as unknown[]).length);
      return [ok(nativeData), ok(balanceUsdt), ok(supplyUsdt)];
    },
    getBalance: async () => 123n,
    getBlockNumber: async () => 75_418_000n,
  } as unknown as PublicClient;

  const kept = await readBalances(freshClient, config, OWNER, [USDT], {
    cache: fresh,
    maxCacheAgeMs: day,
  });
  assert.deepEqual(hits, [3], "fresh metadata keeps the two-sub-call saving");
  assert.deepEqual(kept.cache, { hits: 1, misses: 0 });
  assert.equal(typeof kept.tokens[0]?.cacheAgeMs, "number");
});

test("refreshCache re-reads a rebranded token's symbol", async () => {
  const cache = new MetadataCache({ chainId: 196, persist: false });
  cache.set(USDT, { symbol: "OLD", decimals: 6 });

  const symbolRebranded = encodeFunctionResult({
    abi: erc20Abi,
    functionName: "symbol",
    result: "NEW",
  });
  const sizes: number[] = [];
  const client = {
    readContract: async (args: { functionName?: string; args?: unknown[] }) => {
      if (args.functionName !== "aggregate3") throw new Error(`unexpected: ${args.functionName}`);
      sizes.push((args.args?.[0] as unknown[]).length);
      return [
        ok(nativeData),
        ok(decimals6),
        ok(symbolRebranded),
        ok(balanceUsdt),
        ok(supplyUsdt),
      ];
    },
    getBalance: async () => 123n,
    getBlockNumber: async () => 75_418_000n,
  } as unknown as PublicClient;

  const result = await readBalances(client, config, OWNER, [USDT], {
    cache,
    refreshCache: true,
  });

  assert.deepEqual(sizes, [5], "refresh re-reads decimals and symbol");
  assert.equal(result.tokens[0]?.symbol, "NEW");
  assert.equal(result.tokens[0]?.cacheAgeMs, null, "a refreshed entry is not reported as cached");
  assert.deepEqual(cache.get(USDT), { symbol: "NEW", decimals: 6 });
  assert.deepEqual(result.cache, { hits: 0, misses: 1 });
});

test("a first read fills the cache and the next one uses it", async () => {
  const cache = new MetadataCache({ chainId: 196, persist: false });
  const sizes: number[] = [];
  let pass = 0;

  const client = {
    readContract: async (args: { functionName?: string; args?: unknown[] }) => {
      if (args.functionName !== "aggregate3") throw new Error(`unexpected: ${args.functionName}`);
      sizes.push((args.args?.[0] as unknown[]).length);
      return pass++ === 0
        ? [ok(nativeData), ok(decimals6), ok(symbolUsdt), ok(balanceUsdt), ok(supplyUsdt)]
        : [ok(nativeData), ok(balanceUsdt), ok(supplyUsdt)];
    },
    getBalance: async () => 123n,
    getBlockNumber: async () => 75_418_000n,
  } as unknown as PublicClient;

  const first = await readBalances(client, config, OWNER, [USDT], { cache });
  assert.deepEqual(cache.get(USDT), { symbol: "USDT", decimals: 6 });
  assert.deepEqual(first.cache, { hits: 0, misses: 1 });

  const second = await readBalances(client, config, OWNER, [USDT], { cache });

  assert.deepEqual(sizes, [5, 3], "the second read skips decimals and symbol but rereads supply");
  assert.deepEqual(second.cache, { hits: 1, misses: 0 });
  assert.equal(second.tokens[0]?.symbol, "USDT");
  assert.equal(second.tokens[0]?.decimals, 6);
  assert.equal(second.tokens[0]?.balance, 28_275n);
});

test("malformed metadata is never cached", async () => {
  const cache = new MetadataCache({ chainId: 196, persist: false });
  const bytes32Fake = `0x${Buffer.from("FAKE").toString("hex").padEnd(64, "0")}` as `0x${string}`;
  const { client } = readingStub([
    ok(nativeData),
    ok(decimals6),
    ok(bytes32Fake),
    ok(balanceUsdt),
    ok(supplyUsdt),
  ]);

  const result = await readBalances(client, config, OWNER, [USDT], { cache });

  assert.match(result.tokens[0]?.issue ?? "", /bytes32/);
  assert.equal(cache.get(USDT), null, "a wrong-typed symbol is not remembered as valid");
});

test("a genuine token carries no issue", async () => {
  const { client } = readingStub([
    ok(nativeData),
    ok(decimals6),
    ok(symbolUsdt),
    ok(balanceUsdt),
    ok(supplyUsdt),
  ]);

  const result = await readBalances(client, config, OWNER, [USDT]);

  assert.equal(result.tokens[0]?.issue, null);
  assert.equal((toBalancesJson(result) as { tokens: Array<{ issue: string | null }> }).tokens[0]?.issue, null);
});

test("flags a balance above totalSupply", async () => {
  const supply = encodeFunctionResult({
    abi: erc20Abi,
    functionName: "totalSupply",
    result: 1_000n,
  });
  const { client } = readingStub([
    ok(nativeData),
    ok(decimals6),
    ok(symbolUsdt),
    ok(balanceUsdt),
    ok(supply),
  ]);

  const result = await readBalances(client, config, OWNER, [USDT]);

  assert.match(
    result.tokens[0]?.issue ?? "",
    /balanceOf exceeds totalSupply \(28275 > 1000 base units\)/,
  );
  assert.match(formatBalances(result), /— balanceOf exceeds totalSupply/);

  const equalSupply = encodeFunctionResult({
    abi: erc20Abi,
    functionName: "totalSupply",
    result: 28_275n,
  });
  const equal = await readBalances(
    readingStub([
      ok(nativeData),
      ok(decimals6),
      ok(symbolUsdt),
      ok(balanceUsdt),
      ok(equalSupply),
    ]).client,
    config,
    OWNER,
    [USDT],
  );
  assert.equal(equal.tokens[0]?.issue, null, "a balance equal to supply is valid");
});

test("flags a failed totalSupply read", async () => {
  const { client } = readingStub([
    ok(nativeData),
    ok(decimals6),
    ok(symbolUsdt),
    ok(balanceUsdt),
    { success: false, returnData: "0x" },
  ]);

  const result = await readBalances(client, config, OWNER, [USDT]);

  assert.match(result.tokens[0]?.issue ?? "", /totalSupply reverted/);
});

function stub(handler: (args: { functionName?: string }) => Promise<unknown>) {
  const calls: Array<{ address?: string; functionName?: string }> = [];
  const client = {
    readContract: async (args: unknown) => {
      calls.push(args as { functionName?: string });
      return handler(args as { functionName?: string });
    },
    getBalance: async () => 123n,
    getBlockNumber: async () => 75_417_088n,
  } as unknown as PublicClient;
  return { client, calls };
}

test("two tokens plus native resolve through a single aggregate3 call", async () => {
  const results = [
    ok(nativeData),
    ok(decimals6),
    ok(symbolUsdt),
    ok(balanceUsdt),
    ok(supplyUsdt),
    ok(decimals18),
    ok(symbolWokb),
    ok(balanceWokb),
    ok(supplyWokb),
  ];
  const { client, calls } = stub(async (args) => {
    if (args.functionName === "aggregate3") return results;
    throw new Error(`unexpected individual call: ${args.functionName}`);
  });

  const result = await readBalances(client, config, OWNER, [USDT, WOKB]);

  assert.equal(calls.length, 1, "exactly one RPC call for native + 2 tokens");
  assert.equal(calls[0]?.address, MULTICALL3_ADDRESS);
  assert.equal(calls[0]?.functionName, "aggregate3");

  assert.equal(result.native.balance, 100n, "native balance came from the batch");
  assert.equal(result.native.symbol, "OKB");
  assert.equal(result.tokens.length, 2);

  const [usdt, wokb] = result.tokens;
  assert.equal(usdt?.symbol, "USDT");
  assert.equal(usdt?.decimals, 6);
  assert.equal(usdt?.balance, 28_275n);
  assert.equal(wokb?.symbol, "WOKB");
  assert.equal(wokb?.decimals, 18);
  assert.equal(wokb?.balance, 280_072_887_730_740_496_648n);
});

test("precompile addresses are recognised and never batched", async () => {
  assert.equal(isPrecompileAddress("0x0000000000000000000000000000000000000001"), true);
  assert.equal(isPrecompileAddress("0x000000000000000000000000000000000000000a"), true);
  assert.equal(isPrecompileAddress("0x000000000000000000000000000000000000000b"), false);
  assert.equal(isPrecompileAddress(TOKEN_A), false);
  assert.equal(isPrecompileAddress(OWNER), false);

  // 0x…05 is modexp: calling decimals() on it exhausts the whole eth_call gas cap.
  const PRECOMPILE = "0x0000000000000000000000000000000000000005";
  const results = [
    ok(nativeData),
    ok(decimals6),
    ok(symbolUsdt),
    ok(balanceUsdt),
    ok(supplyUsdt),
  ];
  const { client, calls } = stub(async (args) => {
    if (args.functionName === "aggregate3") return results;
    throw new Error(`precompile must not reach the network: ${args.functionName}`);
  });

  const result = await readBalances(client, config, OWNER, [PRECOMPILE, TOKEN_A]);

  assert.equal(calls.length, 1, "still exactly one aggregate3 call");
  assert.equal(result.tokens.length, 2);
  assert.equal(result.tokens[0]?.address, PRECOMPILE);
  assert.equal(result.tokens[0]?.balance, null);
  assert.equal(result.tokens[0]?.decimals, null);
  assert.equal(result.tokens[0]?.symbol, shortAddress(PRECOMPILE));
  assert.equal(result.tokens[1]?.balance, 28_275n, "the real token still resolves");
  assert.equal(result.batchWarning, null, "skipping a precompile is not a batch failure");
  assert.match(
    formatBalances(result),
    /token {9}unreadable \(0x0000000000000000000000000000000000000005\)/,
  );
});

test("an all-precompile list makes no batch call at all", async () => {
  const { client, calls } = stub(async (args) => {
    throw new Error(`no batch expected: ${args.functionName}`);
  });

  const result = await readBalances(client, config, OWNER, [
    "0x0000000000000000000000000000000000000005",
  ]);

  assert.equal(calls.length, 0, "nothing is batched");
  assert.equal(result.native.balance, 123n, "native still comes from getBalance");
  assert.equal(result.tokens[0]?.balance, null);
  assert.equal(result.batchWarning, null);
});

test("checkTokenAddresses flags non-ERC-20 addresses and keeps their order", async () => {
  const bytes32Fake = `0x${Buffer.from("FAKE").toString("hex").padEnd(64, "0")}` as `0x${string}`;
  const results = [
    ok(decimals6),
    ok(symbolUsdt),
    ok(supplyUsdt),
    ok("0x"),
    ok("0x"),
    ok("0x"),
    ok(decimals6),
    ok(bytes32Fake),
    ok(supplyUsdt),
  ];

  const { client } = readingStub(results);
  const checks = await checkTokenAddresses(client, [USDT, OWNER, WOKB]);

  assert.deepEqual(
    checks.map((check) => check.address),
    [USDT, OWNER, WOKB],
    "results stay in the requested order",
  );
  assert.equal(checks[0]?.issue, null);
  assert.equal(checks[0]?.symbol, "USDT");
  assert.equal(checks[0]?.decimals, 6);
  assert.match(checks[1]?.issue ?? "", /no contract code/);
  assert.match(checks[2]?.issue ?? "", /symbol is bytes32 \(FAKE\)/);
});

test("checkTokenAddresses falls back to individual reads when the batch fails", async () => {
  const client = {
    readContract: async (args: { functionName?: string }) => {
      if (args.functionName === "aggregate3") throw new Error("out of gas");
      throw new Error("execution reverted");
    },
  } as unknown as PublicClient;

  const checks = await checkTokenAddresses(client, [USDT]);

  assert.match(checks[0]?.issue ?? "", /reverted on decimals, symbol and totalSupply/);
});

test("checkTokenAddresses caps sub-calls per aggregate3 request", async () => {
  const sizes: number[] = [];
  const client = {
    readContract: async (args: { functionName: string; args?: readonly unknown[] }) => {
      assert.equal(args.functionName, "aggregate3");
      const subs = (args.args?.[0] ?? []) as unknown[];
      sizes.push(subs.length);
      return subs.map(() => ({ success: false, returnData: "0x" }));
    },
  } as unknown as PublicClient;

  const report = await checkTokenAddressesReport(client, [USDT, OWNER, WOKB], {
    maxSubCalls: 6,
  });

  assert.deepEqual(sizes, [6, 3], "two tokens per request, then the last one");
  assert.equal(report.chunkCount, 2, "two verification requests were sent");
  assert.equal(report.maxSubCalls, 6);
  assert.equal(report.checks.length, 3);
  assert.ok(report.checks.every((check) => check.issue !== null));
});

test("reports one default verification request and a null cap", async () => {
  const client = {
    readContract: async (args: { functionName: string; args?: readonly unknown[] }) => {
      assert.equal(args.functionName, "aggregate3");
      const subs = (args.args?.[0] ?? []) as unknown[];
      return subs.map(() => ({ success: false, returnData: "0x" }));
    },
  } as unknown as PublicClient;

  const report = await checkTokenAddressesReport(client, [USDT, OWNER]);

  assert.equal(report.chunkCount, 1);
  assert.equal(report.maxSubCalls, null);
});

test("checkTokenAddresses answers precompiles without a network call", async () => {
  const PRECOMPILE = "0x0000000000000000000000000000000000000005";
  let calls = 0;
  const client = {
    readContract: async () => {
      calls += 1;
      throw new Error("a precompile must not reach the network");
    },
  } as unknown as PublicClient;

  const report = await checkTokenAddressesReport(client, [PRECOMPILE]);

  assert.equal(calls, 0);
  assert.equal(report.chunkCount, 0, "a precompile needs no verification request");
  assert.equal(report.maxSubCalls, null);
  assert.match(report.checks[0]?.issue ?? "", /precompile address/);
});

const MANY_TOKENS = Array.from(
  { length: 25 },
  (_, index) => `0x${(index + 0x100).toString(16).padStart(40, "0")}`,
) as Address[];

function chunkStub(failChunks: number | number[] | null) {
  const failing = new Set(
    failChunks === null ? [] : Array.isArray(failChunks) ? failChunks : [failChunks],
  );
  const calls: Array<{ functionName?: string; args?: unknown[] }> = [];
  let aggregateCalls = 0;

  const client = {
    readContract: async (args: { functionName?: string; args?: unknown[] }) => {
      calls.push(args);

      if (args.functionName === "decimals") return 6;
      if (args.functionName === "symbol") return "TKN";
      if (args.functionName === "balanceOf") return 7n;
      if (args.functionName === "totalSupply") return 1_000_000n;
      if (args.functionName !== "aggregate3") {
        throw new Error(`unexpected call: ${args.functionName}`);
      }

      const index = aggregateCalls;
      aggregateCalls += 1;
      if (failing.has(index)) throw new Error("out of gas: gas required exceeds 50000000");

      const subCalls = (args.args?.[0] ?? []) as unknown[];
      const withNative = subCalls.length % 4 === 1;
      const results: Array<{ success: boolean; returnData: string }> = [];
      if (withNative) results.push({ success: true, returnData: nativeData });
      for (let token = 0; token < (subCalls.length - (withNative ? 1 : 0)) / 4; token += 1) {
        results.push(
          { success: true, returnData: decimals6 },
          { success: true, returnData: symbolUsdt },
          { success: true, returnData: balanceUsdt },
          { success: true, returnData: supplyUsdt },
        );
      }
      return results;
    },
    getBalance: async () => 123n,
    getBlockNumber: async () => 75_418_000n,
  } as unknown as PublicClient;

  return { client, calls, aggregateCount: () => aggregateCalls };
}

function cacheAll(tokens: Address[]): MetadataCache {
  const cache = new MetadataCache({ chainId: 196, persist: false });
  for (const token of tokens) cache.set(token, { symbol: "TKN", decimals: 6 });
  return cache;
}

function cachedChunkStub() {
  const calls: Array<{ functionName?: string; args?: unknown[] }> = [];
  const subCallSizes: number[] = [];

  const client = {
    readContract: async (args: { functionName?: string; args?: unknown[] }) => {
      calls.push(args);
      if (args.functionName !== "aggregate3") {
        throw new Error(`unexpected call: ${args.functionName}`);
      }

      const subCalls = (args.args?.[0] ?? []) as unknown[];
      subCallSizes.push(subCalls.length);
      const withNative = subCalls.length % 2 === 1;
      const results: Array<{ success: boolean; returnData: string }> = [];
      if (withNative) results.push({ success: true, returnData: nativeData });
      const tokenCalls = subCalls.length - (withNative ? 1 : 0);
      for (let index = 0; index < tokenCalls; index += 2) {
        results.push(
          { success: true, returnData: balanceUsdt },
          { success: true, returnData: supplyUsdt },
        );
      }
      return results;
    },
    getBalance: async () => 123n,
    getBlockNumber: async () => 75_418_000n,
  } as unknown as PublicClient;

  return { client, calls, subCallSizes };
}

test(`splits large lists into ${TOKENS_PER_BATCH}-token parallel batches`, async () => {
  const { client, calls } = chunkStub(null);

  const result = await readBalances(client, config, OWNER, MANY_TOKENS);

  assert.equal(TOKENS_PER_BATCH, 12);
  assert.equal(calls.filter((call) => call.functionName === "aggregate3").length, 3);
  assert.equal(result.tokens.length, 25);
  assert.equal(result.tokens[24]?.address, MANY_TOKENS[24]);
  assert.equal(result.native.balance, 100n, "native still comes from the first batch");
  assert.equal(result.batchWarning, null);
  assert.equal(result.tokens[0]?.cacheAgeMs, null, "fresh metadata has no cached age");
});

test("fully cached lists use 24-token chunks", async () => {
  const { client, calls, subCallSizes } = cachedChunkStub();
  const result = await readBalances(client, config, OWNER, MANY_TOKENS, {
    cache: cacheAll(MANY_TOKENS),
  });

  assert.equal(CACHED_TOKENS_PER_BATCH, 24);
  assert.deepEqual(subCallSizes, [49, 2], "native + 24 cached tokens, then the last token");
  assert.equal(calls.filter((call) => call.functionName === "aggregate3").length, 2);
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[0]?.tokens, 24);
  assert.equal(result.tokens[24]?.balance, 28_275n);
  assert.deepEqual(result.cache, { hits: 25, misses: 0 });
});

test("an explicit batch size overrides cached density", async () => {
  const { client, subCallSizes } = cachedChunkStub();
  const result = await readBalances(client, config, OWNER, MANY_TOKENS, {
    cache: cacheAll(MANY_TOKENS),
    batchSize: 12,
  });

  assert.deepEqual(subCallSizes, [25, 24, 2], "explicit 12 still wins over cached density");
  assert.equal(result.chunks.length, 3);
});

test("a sub-call cap ignores cached token density", async () => {
  const { client, subCallSizes } = cachedChunkStub();
  const result = await readBalances(client, config, OWNER, MANY_TOKENS, {
    cache: cacheAll(MANY_TOKENS),
    maxSubCalls: 5,
  });

  assert.deepEqual(
    subCallSizes,
    [5, ...new Array(11).fill(4), 2],
    "native + 4 sub-calls per request stays fixed despite a full cache",
  );
  assert.equal(result.chunks.length, 13);
  assert.deepEqual(result.cache, { hits: 25, misses: 0 });
});

test("a custom batch size re-chunks the same tokens", async () => {
  const { client, calls } = chunkStub(null);

  const result = await readBalances(client, config, OWNER, MANY_TOKENS, { batchSize: 5 });

  assert.equal(calls.filter((call) => call.functionName === "aggregate3").length, 5);
  assert.equal(result.tokens.length, 25);
  assert.equal(result.tokens[24]?.balance, 28_275n);
  assert.equal(result.batchWarning, null);
  assert.equal(result.chunks.length, 5);
  assert.ok(result.chunks.every((chunk) => chunk.status === "batched"));
});

test("retries a failed chunk once with two smaller sub-batches", async () => {
  const { client, calls } = chunkStub(1);

  const result = await readBalances(client, config, OWNER, MANY_TOKENS);

  assert.equal(calls.filter((call) => call.functionName === "aggregate3").length, 5);
  assert.equal(
    calls.filter((call) => call.functionName !== "aggregate3").length,
    0,
    "a successful retry needs no individual reads",
  );
  assert.equal(result.tokens[12]?.balance, 28_275n, "the retried chunk kept its batch result");
  assert.equal(result.tokens[24]?.balance, 28_275n, "chunk 3 kept its batched result");
  assert.equal(result.native.balance, 100n, "native survived in the healthy first chunk");
  assert.equal(result.batchWarning, null, "a recovered chunk is not a warning");
  assert.equal(result.chunks[1]?.status, "recovered");
  assert.deepEqual(result.chunks[1]?.individual, []);
  assert.deepEqual(result.recovery, {
    failedChunks: 1,
    retryRequests: 2,
    recoveredChunks: 1,
  });
  assert.match(
    formatBalances(result),
    /recovery\s+1 failed chunk, 2 retry requests, 1 recovered/,
  );
  assert.deepEqual(
    (toBalancesJson(result) as { recovery: unknown }).recovery,
    { failedChunks: 1, retryRequests: 2, recoveredChunks: 1 },
  );
});

test("a failed first chunk retries and recovers its native balance", async () => {
  const { client, calls } = chunkStub(0);

  const result = await readBalances(client, config, OWNER, MANY_TOKENS);

  assert.equal(calls.filter((call) => call.functionName === "aggregate3").length, 5);
  assert.equal(calls.filter((call) => call.functionName !== "aggregate3").length, 0);
  assert.equal(result.native.balance, 100n, "native recovered in the retried first half");
  assert.equal(result.tokens[0]?.balance, 28_275n);
  assert.equal(result.tokens[24]?.balance, 28_275n, "the last chunk still batched");
  assert.equal(result.batchWarning, null);
  assert.equal(result.chunks[0]?.status, "recovered");
});

test("a chunk that fails its retry falls back to individual reads", async () => {
  const { client, calls } = chunkStub([0, 3, 4]);

  const result = await readBalances(client, config, OWNER, MANY_TOKENS);

  assert.equal(calls.filter((call) => call.functionName === "aggregate3").length, 5);
  assert.equal(
    calls.filter((call) => call.functionName !== "aggregate3").length,
    48,
    "the 12 tokens in the failed chunk are re-read individually, four calls each",
  );
  assert.equal(result.native.balance, 123n, "native falls back when both batch attempts fail");
  assert.equal(result.tokens[0]?.balance, 7n);
  assert.equal(result.tokens[24]?.balance, 28_275n, "the last chunk still batched");
  assert.match(result.batchWarning ?? "", /^batch 1\/3: out of gas/);
  assert.equal(result.chunks[0]?.status, "failed");
  assert.deepEqual(result.chunks[0]?.individual, MANY_TOKENS.slice(0, 12));
  assert.deepEqual(result.recovery, {
    failedChunks: 1,
    retryRequests: 2,
    recoveredChunks: 0,
  });
});

test("a partly recovered chunk only falls back for its remaining tokens", async () => {
  const { client, calls } = chunkStub([1, 3]);

  const result = await readBalances(client, config, OWNER, MANY_TOKENS);

  assert.equal(calls.filter((call) => call.functionName === "aggregate3").length, 5);
  assert.equal(
    calls.filter((call) => call.functionName !== "aggregate3").length,
    24,
    "the failed half of six tokens is read individually",
  );
  assert.equal(result.tokens[12]?.balance, 7n, "the failed half fell back");
  assert.equal(result.tokens[18]?.balance, 28_275n, "the successful half kept its batch");
  assert.equal(result.native.balance, 100n);
  assert.match(result.batchWarning ?? "", /^batch 2\/3: out of gas/);
  assert.equal(result.chunks[1]?.status, "partial");
  assert.deepEqual(result.chunks[1]?.individual, MANY_TOKENS.slice(12, 18));
});

test("a one-token chunk goes straight to individual fallback", async () => {
  const { client, calls } = chunkStub(2);

  const result = await readBalances(client, config, OWNER, MANY_TOKENS);

  assert.equal(calls.filter((call) => call.functionName === "aggregate3").length, 3);
  assert.equal(calls.filter((call) => call.functionName !== "aggregate3").length, 4);
  assert.equal(result.tokens[24]?.balance, 7n);
  assert.match(result.batchWarning ?? "", /^batch 3\/3: out of gas/);
  assert.equal(result.chunks[2]?.status, "failed");
  assert.deepEqual(result.chunks[2]?.individual, [MANY_TOKENS[24]]);
});

test("reports progress for every chunk with its fallback tokens", async () => {
  const seen: Array<{ index: number; status: string; individual: number }> = [];
  const { client } = chunkStub([1, 3]);

  await readBalances(client, config, OWNER, MANY_TOKENS, {
    onChunkProgress: (chunk) => {
      seen.push({
        index: chunk.index,
        status: chunk.status,
        individual: chunk.individual.length,
      });
    },
  });

  assert.deepEqual(seen, [
    { index: 1, status: "batched", individual: 0 },
    { index: 2, status: "partial", individual: 6 },
    { index: 3, status: "batched", individual: 0 },
  ]);
});

test("a failed sub-call degrades that field instead of the report", async () => {
  const results = [
    ok(nativeData),
    ok(decimals18),
    { success: false, returnData: "0x" as const },
    { success: false, returnData: "0x" as const },
    { success: false, returnData: "0x" as const },
  ];
  const { client } = stub(async () => results);

  const result = await readBalances(client, config, OWNER, [TOKEN_A]);
  const token = result.tokens[0];

  assert.equal(token?.decimals, 18);
  assert.equal(token?.balance, null);
  assert.equal(token?.symbol, shortAddress(TOKEN_A));
  assert.equal(result.native.balance, 100n);
});

test("falls back to individual reads when aggregate3 is unavailable", async () => {
  const { client, calls } = stub(async (args) => {
    if (args.functionName === "aggregate3") throw new Error("Multicall3 not deployed");
    if (args.functionName === "decimals") return 6;
    if (args.functionName === "symbol") return "USDT";
    if (args.functionName === "balanceOf") return 28_275n;
    if (args.functionName === "totalSupply") return 1_000_000_000n;
    throw new Error(`unexpected call: ${args.functionName}`);
  });

  const result = await readBalances(client, config, OWNER, [TOKEN_A]);

  assert.equal(calls.length, 5, "one failed batch, then four individual reads");
  assert.equal(result.tokens[0]?.symbol, "USDT");
  assert.equal(result.tokens[0]?.balance, 28_275n);
  assert.equal(result.native.balance, 123n, "native falls back to getBalance");
  assert.match(
    result.batchWarning ?? "",
    /Multicall3 not deployed/,
    "the batch failure reason is reported, not swallowed",
  );
  assert.match(formatBalances(result), /batch {9}unavailable, read individually: Multicall3 not deployed/);
  assert.equal(toBalancesJson(result).batchWarning, "Multicall3 not deployed");
});

test("a successful batch reports no warning", async () => {
  const results = [
    ok(nativeData),
    ok(decimals6),
    ok(symbolUsdt),
    ok(balanceUsdt),
    ok(supplyUsdt),
  ];
  const { client } = stub(async () => results);

  const result = await readBalances(client, config, OWNER, [TOKEN_A]);

  assert.equal(result.batchWarning, null);
  assert.doesNotMatch(formatBalances(result), /unavailable, read individually/);
});

test("falls back when the batch returns no usable results", async () => {
  const results = [
    { success: false, returnData: "0x" as const },
    ok(decimals6),
    ok(symbolUsdt),
    ok(balanceUsdt),
    ok(supplyUsdt),
  ];
  const { client } = stub(async () => results);

  const result = await readBalances(client, config, OWNER, [TOKEN_A]);

  assert.equal(result.native.balance, 123n, "native read individually when the batch entry fails");
  assert.equal(result.tokens[0]?.symbol, "USDT");
});

test("no token list means no contract calls at all", async () => {
  const { client, calls } = stub(async () => {
    throw new Error("should not be called");
  });

  const result = await readBalances(client, config, OWNER, []);

  assert.equal(calls.length, 0);
  assert.equal(result.native.balance, 123n);
  assert.deepEqual(result.tokens, []);
  assert.equal(result.blockNumber, 75_417_088n);
});
