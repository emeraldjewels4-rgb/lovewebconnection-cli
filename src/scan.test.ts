import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { encodeFunctionData, encodeFunctionResult, erc20Abi, type PublicClient } from "viem";

import {
  ScanArgError,
  csvCell,
  formatScan,
  parseScanArgs,
  scanBalances,
  scanCsv,
  toScanJson,
  type ScanReport,
} from "./scan.ts";
import { MULTICALL3_ADDRESS, multicall3BatchAbi } from "./contract.ts";
import { MetadataCache } from "./metadata-cache.ts";
import type { ChainConfig } from "./chain.ts";

const OWNER_A = "0x000000000000000000000000000000000000dEaD";
const OWNER_B = "0x000000000000000000000000000000000000bEEF";
const TOKEN = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";

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
    (error: unknown) => error instanceof ScanArgError && pattern.test(error.message),
  );
}

function withTempJson(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lwc-scan-"));
  try {
    const path = join(dir, "list.json");
    writeFileSync(path, contents);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function report(): ScanReport {
  return {
    chainId: 196,
    chainName: "xlayer",
    blockNumber: 75_418_547n,
    nativeSymbol: "OKB",
    nativeDecimals: 18,
    owners: [OWNER_A, OWNER_B],
    batchSize: 12,
    chunkCount: 0,
    tokens: [
      {
        address: TOKEN,
        symbol: "USDT",
        label: null,
        decimals: 6,
        balance: 1n,
        cacheAgeMs: null,
        issue: null,
      },
      {
        address: "0x0000000000000000000000000000000000000009",
        symbol: "0x0000…0009",
        label: null,
        decimals: null,
        balance: null,
        cacheAgeMs: null,
        issue: "no contract code (every call returned no data)",
      },
    ],
    rows: [
      { owner: OWNER_A, native: 61_997_998_034_799_592_649n, balances: [28_275n, null] },
      { owner: OWNER_B, native: 1_000_000_000_000_000_000n, balances: [0n, null] },
    ],
    warnings: [],
    chunks: [],
    fallbacks: [],
    recovery: { failedChunks: 0, retryRequests: 0, recoveredChunks: 0 },
    cache: { hits: 0, misses: 0 },
  };
}

test("parses owners, tokens, and the CSV target", () => {
  withTempJson(JSON.stringify([TOKEN]), (path) => {
    const args = parseScanArgs([
      OWNER_A,
      "--owner",
      OWNER_B.toLowerCase(),
      "--tokens-file",
      path,
      "--csv",
      "./out.csv",
    ]);

    assert.deepEqual(args.owners, [OWNER_A, OWNER_B], "positional and --owner merge, checksummed");
    assert.deepEqual(args.tokens, [TOKEN]);
    assert.equal(args.csvPath, "./out.csv");
  });

  const fileArgs = parseScanArgs([OWNER_A, `--token=${TOKEN}`]);
  assert.equal(fileArgs.tokens.length, 1);
  assert.equal(fileArgs.csvPath, null);
});

test("parses a batch size for Multicall3 chunks", () => {
  assert.equal(parseScanArgs([OWNER_A]).batchSize, 12);
  assert.equal(parseScanArgs([OWNER_A, "--batch-size", "1"]).batchSize, 1);
  assert.equal(parseScanArgs([OWNER_A, "--batch-size=50"]).batchSize, 50);
  expectArgError(() => parseScanArgs([OWNER_A, "--batch-size", "0"]), /between 1 and 100/);
  expectArgError(() => parseScanArgs([OWNER_A, "--batch-size", "many"]), /whole number/);
  expectArgError(() => parseScanArgs([OWNER_A, "--batch-size"]), /requires a value/);
});

test("reads owner lists from a file and dedupes", () => {
  withTempJson(JSON.stringify([OWNER_A, OWNER_B]), (path) => {
    const args = parseScanArgs([OWNER_A, "--owners-file", path]);
    assert.deepEqual(args.owners, [OWNER_A, OWNER_B]);
  });
  withTempJson(JSON.stringify({ addresses: [OWNER_B] }), (path) => {
    assert.deepEqual(parseScanArgs([`--owners-file=${path}`]).owners, [OWNER_B]);
  });
  withTempJson(JSON.stringify({ owners: [OWNER_A] }), (path) => {
    assert.deepEqual(parseScanArgs([`--owners-file=${path}`]).owners, [OWNER_A]);
  });
});

test("a bad list file surfaces as a scan usage error", () => {
  withTempJson(JSON.stringify([{ owners: [OWNER_A] }]), (path) => {
    expectArgError(() => parseScanArgs([`--owners-file=${path}`]), /entry 1 is not an EVM address/);
  });
});

test("rejects a scan with no owners or a bad CSV value", () => {
  expectArgError(() => parseScanArgs([`--token=${TOKEN}`]), /at least one owner/);
  expectArgError(() => parseScanArgs([OWNER_A, "--csv"]), /--csv requires a path/);
  expectArgError(() => parseScanArgs(["0xnot-an-address"]), /not a valid owner address/);
  expectArgError(() => parseScanArgs([OWNER_A, "--owner"]), /--owner requires an address/);
});

test("CSV has one header, one row per owner, and blank unreadable cells", () => {
  const csv = scanCsv(report());
  const lines = csv.trimEnd().split("\n");

  assert.equal(lines.length, 3, "header plus two owners");
  assert.equal(
    lines[0],
    "owner,native (OKB),USDT (0x1E4a…D41d),0x0000…0009,labels,flag",
  );
  assert.equal(
    lines[1],
    `${OWNER_A},61.997998034799592649,0.028275,,,0x0000…0009: no contract code (every call returned no data)`,
  );
  assert.equal(
    lines[2],
    `${OWNER_B},1,0,,,0x0000…0009: no contract code (every call returned no data)`,
  );
  assert.ok(csv.endsWith("\n"));
});

test("CSV joins multiple flags and leaves a clean token set blank", () => {
  const multiple = report();
  multiple.tokens[0] = {
    ...multiple.tokens[0]!,
    issue: "symbol is bytes32 (FAKE), not a string",
  };
  const lines = scanCsv(multiple).trimEnd().split("\n");
  assert.equal(
    lines[1],
    `${OWNER_A},61.997998034799592649,0.028275,,,"USDT (0x1E4a…D41d): symbol is bytes32 (FAKE), not a string | 0x0000…0009: no contract code (every call returned no data)"`,
  );

  const clean = report();
  clean.tokens = [clean.tokens[0]!];
  clean.rows = clean.rows.map((row) => ({ ...row, balances: [row.balances[0]!] }));
  const cleanLines = scanCsv(clean).trimEnd().split("\n");
  assert.equal(cleanLines[0], "owner,native (OKB),USDT (0x1E4a…D41d),labels,flag");
  assert.equal(cleanLines[1], `${OWNER_A},61.997998034799592649,0.028275,,`);
});

test("CSV puts labels in a separate column", () => {
  const labelled = report();
  labelled.tokens[0] = { ...labelled.tokens[0]!, label: "Tether USD" };

  const lines = scanCsv(labelled).trimEnd().split("\n");
  assert.equal(
    lines[0],
    "owner,native (OKB),USDT (0x1E4a…D41d),0x0000…0009,labels,flag",
  );
  assert.doesNotMatch(lines[0] ?? "", /Tether USD/);
  assert.equal(
    lines[1],
    `${OWNER_A},61.997998034799592649,0.028275,,USDT (0x1E4a…D41d): Tether USD,0x0000…0009: no contract code (every call returned no data)`,
  );
});

test("CSV quotes fields containing commas or quotes", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
});

test("parses --fail-on-retry for CI checks", () => {
  assert.equal(parseScanArgs([OWNER_A]).failOnRetry, false);
  assert.equal(parseScanArgs([OWNER_A, "--fail-on-retry"]).failOnRetry, true);
});

test("parses a sub-call cap for Multicall3 chunks", () => {
  assert.equal(parseScanArgs([OWNER_A]).maxSubCalls, null);
  assert.equal(parseScanArgs([OWNER_A, "--max-subcalls", "40"]).maxSubCalls, 40);
  assert.equal(parseScanArgs([OWNER_A, "--max-subcalls=40"]).maxSubCalls, 40);
  expectArgError(
    () => parseScanArgs([OWNER_A, "--max-subcalls", "0"]),
    /between 1 and 1000/,
  );
  expectArgError(() => parseScanArgs([OWNER_A, "--max-subcalls", "many"]), /whole number/);
  expectArgError(() => parseScanArgs([OWNER_A, "--max-subcalls"]), /requires a value/);
  expectArgError(
    () => parseScanArgs([OWNER_A, "--batch-size", "4", "--max-subcalls", "9"]),
    /not both/,
  );
});

test("parses --stale-after as a warning threshold", () => {
  assert.equal(parseScanArgs([OWNER_A]).staleAfterMs, null);
  assert.equal(parseScanArgs([OWNER_A, "--stale-after", "30m"]).staleAfterMs, 1_800_000);
  assert.equal(parseScanArgs([OWNER_A, "--stale-after=7d"]).staleAfterMs, 604_800_000);
  expectArgError(() => parseScanArgs([OWNER_A, "--stale-after", "30"]), /must look like 30m/);
  expectArgError(() => parseScanArgs([OWNER_A, "--stale-after"]), /requires a duration/);
  expectArgError(() => parseScanArgs([OWNER_A, "--stale-after", "0d"]), /positive duration/);
});

test("parses --max-cache-age as a duration", () => {
  assert.equal(parseScanArgs([OWNER_A, "--max-cache-age", "30m"]).maxCacheAgeMs, 1_800_000);
  assert.equal(parseScanArgs([OWNER_A, "--max-cache-age=2w"]).maxCacheAgeMs, 1_209_600_000);
  expectArgError(
    () => parseScanArgs([OWNER_A, "--max-cache-age", "30"]),
    /must look like 30m/,
  );
  expectArgError(() => parseScanArgs([OWNER_A, "--max-cache-age"]), /requires a duration/);
});

test("parses --quiet for per-chunk progress", () => {
  assert.equal(parseScanArgs([OWNER_A]).quiet, false);
  assert.equal(parseScanArgs([OWNER_A, "--quiet"]).quiet, true);
  assert.equal(parseScanArgs([OWNER_A, "--quiet", "--json"]).quiet, true);
});

test("scanBalances sends one Multicall3 call per owner", async () => {
  const amountByOwner: Record<string, bigint> = {
    [OWNER_A.toLowerCase()]: 28_275n,
    [OWNER_B.toLowerCase()]: 0n,
  };
  const batchSizes: number[] = [];

  const client = {
    getBlockNumber: async () => 75_418_547n,
    getBalance: async () => 0n,
    readContract: async (args: { args?: unknown[] }) => {
      const subCalls = args.args?.[0] as Array<{ callData: string; target: string }>;
      const owner = `0x${subCalls[0]?.callData.slice(-40)}`;
      assert.equal(subCalls[0]?.target, MULTICALL3_ADDRESS);
      batchSizes.push(subCalls.length);
      return [
        {
          success: true,
          returnData: encodeFunctionResult({
            abi: multicall3BatchAbi,
            functionName: "getEthBalance",
            result: 1n,
          }),
        },
        {
          success: true,
          returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 }),
        },
        {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "symbol",
            result: "USDT",
          }),
        },
        {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "balanceOf",
            result: amountByOwner[owner.toLowerCase()] ?? 0n,
          }),
        },
        {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "totalSupply",
            result: 1_000_000_000n,
          }),
        },
      ];
    },
  } as unknown as PublicClient;

  const result = await scanBalances(client, config, [OWNER_A, OWNER_B], [TOKEN]);

  assert.deepEqual(
    batchSizes,
    [5, 5],
    "native + decimals/symbol/balanceOf/totalSupply, once per owner",
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.native, 1n);
  assert.equal(result.rows[0]?.balances[0], 28_275n);
  assert.equal(result.rows[1]?.balances[0], 0n);
  assert.equal(result.tokens[0]?.symbol, "USDT");
  assert.equal(result.blockNumber, 75_418_547n);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.chunks.length, 2);
  assert.ok(result.chunks.every((chunk) => chunk.status === "batched"));
  assert.deepEqual(result.fallbacks, []);
});

test("scan reports chunk outcomes and every fallback token", async () => {
  const amountByOwner: Record<string, bigint> = {
    [OWNER_A.toLowerCase()]: 28_275n,
    [OWNER_B.toLowerCase()]: 0n,
  };
  let aggregateCalls = 0;

  const client = {
    getBlockNumber: async () => 75_418_547n,
    getBalance: async () => 123n,
    readContract: async (args: { functionName?: string; args?: unknown[] }) => {
      if (args.functionName === "aggregate3") {
        aggregateCalls += 1;
        if (aggregateCalls === 1) {
          throw new Error("out of gas: gas required exceeds 50000000");
        }

        const subCalls = args.args?.[0] as Array<{ callData: string }>;
        const owner = `0x${subCalls[0]?.callData.slice(-40)}`;
        return [
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: multicall3BatchAbi,
              functionName: "getEthBalance",
              result: 1n,
            }),
          },
          {
            success: true,
            returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 }),
          },
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "symbol",
              result: "USDT",
            }),
          },
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "balanceOf",
              result: amountByOwner[owner.toLowerCase()] ?? 0n,
            }),
          },
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "totalSupply",
              result: 1_000_000_000n,
            }),
          },
        ];
      }

      if (args.functionName === "decimals") return 6;
      if (args.functionName === "symbol") return "USDT";
      if (args.functionName === "totalSupply") return 1_000_000_000n;
      if (args.functionName === "balanceOf") {
        const owner = typeof args.args?.[0] === "string" ? args.args[0].toLowerCase() : "";
        return amountByOwner[owner] ?? 0n;
      }
      throw new Error(`unexpected call: ${args.functionName}`);
    },
  } as unknown as PublicClient;

  const result = await scanBalances(client, config, [OWNER_A, OWNER_B], [TOKEN]);

  assert.equal(result.fallbacks.length, 1);
  const fallback = result.fallbacks[0];
  assert.equal(fallback?.owner, OWNER_A);
  assert.equal(fallback?.token, TOKEN);
  assert.equal(fallback?.symbol, "USDT");
  assert.equal(fallback?.chunk, 1);
  assert.equal(fallback?.chunks, 1);

  const ownerA = result.chunks.find((chunk) => chunk.owner === OWNER_A);
  const ownerB = result.chunks.find((chunk) => chunk.owner === OWNER_B);
  assert.equal(ownerA?.status, "failed");
  assert.deepEqual(ownerA?.individual, [TOKEN]);
  assert.equal(ownerB?.status, "batched");
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.recovery, {
    failedChunks: 1,
    retryRequests: 0,
    recoveredChunks: 0,
  });
});

test("scan prefetches metadata once instead of per owner", async () => {
  const cache = new MetadataCache({ chainId: 196, persist: false });
  const WOKB = "0xe538905cf8410324e03A5A23C1c177a474D59b2b";
  const sizes: number[] = [];
  const amountByOwner: Record<string, bigint> = {
    [OWNER_A.toLowerCase()]: 28_275n,
    [OWNER_B.toLowerCase()]: 0n,
  };

  const client = {
    getBlockNumber: async () => 75_418_547n,
    getBalance: async () => 0n,
    readContract: async (args: { args?: unknown[] }) => {
      const subCalls = args.args?.[0] as Array<{ callData: string; target: string }>;
      sizes.push(subCalls.length);

      // Metadata prefetch: all sub-calls target tokens.
      if (subCalls[0]?.target !== MULTICALL3_ADDRESS) {
        return [
          { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 }) },
          { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "USDT" }) },
          { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 18 }) },
          { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "WOKB" }) },
        ];
      }

      const balanceCalls = subCalls.slice(1);
      const owner = `0x${balanceCalls[0]?.callData.slice(-40)}`;
      const totalSupplyCall = encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" });
      return [
        {
          success: true,
          returnData: encodeFunctionResult({
            abi: multicall3BatchAbi,
            functionName: "getEthBalance",
            result: 1n,
          }),
        },
        ...balanceCalls.map((call) => ({
          success: true,
          returnData:
            call.callData === totalSupplyCall
              ? encodeFunctionResult({
                  abi: erc20Abi,
                  functionName: "totalSupply",
                  result: 1_000_000_000n,
                })
              : encodeFunctionResult({
                  abi: erc20Abi,
                  functionName: "balanceOf",
                  result: amountByOwner[owner.toLowerCase()] ?? 0n,
                }),
        })),
      ];
    },
  } as unknown as PublicClient;

  const result = await scanBalances(client, config, [OWNER_A, OWNER_B], [TOKEN, WOKB], { cache });

  assert.equal(sizes[0], 4, "one prefetch for both tokens: decimals + symbol each");
  assert.deepEqual(
    sizes.slice(1).sort(),
    [5, 5],
    "owners read native plus balanceOf and totalSupply for each cached token",
  );
  assert.equal(result.rows[0]?.balances[0], 28_275n);
  assert.equal(result.rows[1]?.balances[0], 0n);
  assert.deepEqual(cache.get(TOKEN), { symbol: "USDT", decimals: 6 });
  assert.deepEqual(cache.get(WOKB), { symbol: "WOKB", decimals: 18 });
  assert.deepEqual(result.cache, { hits: 0, misses: 2 });
  assert.deepEqual(
    (toScanJson(result) as { cache: { hits: number; misses: number } }).cache,
    { hits: 0, misses: 2 },
  );

  const repeat = await scanBalances(client, config, [OWNER_A, OWNER_B], [TOKEN, WOKB], { cache });
  assert.deepEqual(repeat.cache, { hits: 2, misses: 0 });
});

test("maxCacheAgeMs refreshes stale metadata before prefetching", async () => {
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.now() - 2 * day;
  const cache = new MetadataCache({ chainId: 196, persist: false, now: () => clock });
  cache.set(TOKEN, { symbol: "OLD", decimals: 6 });
  clock = Date.now();

  const sizes: number[] = [];
  const client = {
    getBlockNumber: async () => 75_418_547n,
    getBalance: async () => 0n,
    readContract: async (args: { args?: unknown[] }) => {
      const subCalls = args.args?.[0] as Array<{ callData: string; target: string }>;
      sizes.push(subCalls.length);

      if (subCalls[0]?.target !== MULTICALL3_ADDRESS) {
        return [
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "decimals",
              result: 6,
            }),
          },
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "symbol",
              result: "USDT",
            }),
          },
        ];
      }

      const totalSupplyCall = encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" });
      return [
        {
          success: true,
          returnData: encodeFunctionResult({
            abi: multicall3BatchAbi,
            functionName: "getEthBalance",
            result: 1n,
          }),
        },
        ...subCalls.slice(1).map((call) => ({
          success: true,
          returnData:
            call.callData === totalSupplyCall
              ? encodeFunctionResult({
                  abi: erc20Abi,
                  functionName: "totalSupply",
                  result: 1_000_000n,
                })
              : encodeFunctionResult({
                  abi: erc20Abi,
                  functionName: "balanceOf",
                  result: 0n,
                }),
        })),
      ];
    },
  } as unknown as PublicClient;

  const result = await scanBalances(client, config, [OWNER_A], [TOKEN], {
    cache,
    maxCacheAgeMs: day,
  });

  assert.deepEqual(sizes, [2, 3], "stale entry is prefetched, then reused by the owner");
  assert.equal(result.tokens[0]?.symbol, "USDT");
  assert.deepEqual(cache.get(TOKEN), { symbol: "USDT", decimals: 6 });
  assert.deepEqual(result.cache, { hits: 0, misses: 1 });
});

test("scan refreshes cached metadata before prefetching", async () => {
  const cache = new MetadataCache({ chainId: 196, persist: false });
  cache.set(TOKEN, { symbol: "OLD", decimals: 6 });

  const sizes: number[] = [];
  const client = {
    getBlockNumber: async () => 75_418_547n,
    getBalance: async () => 0n,
    readContract: async (args: { args?: unknown[] }) => {
      const subCalls = args.args?.[0] as Array<{ callData: string; target: string }>;
      sizes.push(subCalls.length);

      if (subCalls[0]?.target !== MULTICALL3_ADDRESS) {
        return [
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "decimals",
              result: 6,
            }),
          },
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "symbol",
              result: "NEW",
            }),
          },
        ];
      }

      const totalSupplyCall = encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" });
      return [
        {
          success: true,
          returnData: encodeFunctionResult({
            abi: multicall3BatchAbi,
            functionName: "getEthBalance",
            result: 1n,
          }),
        },
        ...subCalls.slice(1).map((call) => ({
          success: true,
          returnData:
            call.callData === totalSupplyCall
              ? encodeFunctionResult({
                  abi: erc20Abi,
                  functionName: "totalSupply",
                  result: 1_000_000n,
                })
              : encodeFunctionResult({
                  abi: erc20Abi,
                  functionName: "balanceOf",
                  result: 0n,
                }),
        })),
      ];
    },
  } as unknown as PublicClient;

  const result = await scanBalances(client, config, [OWNER_A], [TOKEN], {
    cache,
    refreshCache: true,
  });

  assert.deepEqual(sizes, [2, 3], "one prefetch, then one owner batch reusing it");
  assert.equal(result.tokens[0]?.symbol, "NEW");
  assert.deepEqual(cache.get(TOKEN), { symbol: "NEW", decimals: 6 });
  assert.deepEqual(result.cache, { hits: 0, misses: 1 });
});

test("scan uses dense chunks for a fully cached token list", async () => {
  const tokens = Array.from(
    { length: 25 },
    (_, index) => `0x${(index + 0x100).toString(16).padStart(40, "0")}`,
  ) as `0x${string}`[];
  const cache = new MetadataCache({ chainId: 196, persist: false });
  for (const token of tokens) cache.set(token, { symbol: "TKN", decimals: 6 });

  const batchSizes: number[] = [];
  const client = {
    getBlockNumber: async () => 75_418_547n,
    getBalance: async () => 0n,
    readContract: async (args: { args?: unknown[] }) => {
      const subCalls = args.args?.[0] as Array<{ callData: string; target: string }>;
      batchSizes.push(subCalls.length);
      const withNative = subCalls.length % 2 === 1;
      const results: Array<{ success: boolean; returnData: string }> = [];
      if (withNative) {
        results.push({
          success: true,
          returnData: encodeFunctionResult({
            abi: multicall3BatchAbi,
            functionName: "getEthBalance",
            result: 1n,
          }),
        });
      }
      const tokenCalls = subCalls.length - (withNative ? 1 : 0);
      for (let index = 0; index < tokenCalls; index += 2) {
        results.push(
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "balanceOf",
              result: 0n,
            }),
          },
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "totalSupply",
              result: 1_000_000n,
            }),
          },
        );
      }
      return results;
    },
  } as unknown as PublicClient;

  const result = await scanBalances(client, config, [OWNER_A], tokens, { cache });

  assert.deepEqual(batchSizes, [49, 2], "one owner batch per cached chunk");
  assert.deepEqual(result.cache, { hits: 25, misses: 0 });
  assert.equal(result.batchSize, 24, "fully cached tokens use the denser batch");
  assert.equal(result.chunkCount, 2);
  assert.equal(typeof result.tokens[0]?.cacheAgeMs, "number");
  assert.match(formatScan(result), /\[cached \d+[smhd]\]/);
  assert.equal(result.rows[0]?.balances.length, 25);
});

test("scan accepts inline --token labels", () => {
  const args = parseScanArgs([OWNER_A, "--token", `${TOKEN}:USD Tether`]);
  assert.deepEqual(args.tokens, [TOKEN]);
  assert.equal(args.labels.get(TOKEN.toLowerCase()), "USD Tether");

  const equals = parseScanArgs([OWNER_A, "--token", `${TOKEN}=USD Tether`]);
  assert.equal(equals.labels.get(TOKEN.toLowerCase()), "USD Tether");

  expectArgError(
    () => parseScanArgs([OWNER_A, "--token", `${TOKEN}:${'x'.repeat(65)}`]),
    /label longer than 64/,
  );
});

test("scan inline labels override token-file labels", () => {
  withTempJson(JSON.stringify([{ address: TOKEN, label: "File Label" }]), (path) => {
    const args = parseScanArgs([
      OWNER_A,
      "--token",
      `${TOKEN}:Inline Label`,
      "--tokens-file",
      path,
    ]);

    assert.deepEqual(args.tokens, [TOKEN]);
    assert.equal(args.labels.get(TOKEN.toLowerCase()), "Inline Label");
    assert.equal(args.warnings.length, 1);
    assert.match(
      args.warnings[0] ?? "",
      /inline label "Inline Label" overrides file label "File Label"/,
    );
  });
});

test("scan warns when duplicate token labels conflict", () => {
  const args = parseScanArgs([
    OWNER_A,
    "--token",
    `${TOKEN}:First`,
    "--token",
    `${TOKEN}:Second`,
  ]);

  assert.deepEqual(args.tokens, [TOKEN]);
  assert.equal(args.labels.get(TOKEN.toLowerCase()), "Second");
  assert.equal(args.warnings.length, 1);
  assert.match(args.warnings[0] ?? "", /conflicting labels "First" and "Second"/);
});

test("scan reads labels from the token list file", () => {
  withTempJson(JSON.stringify([{ address: TOKEN, label: "USD Tether" }]), (path) => {
    const args = parseScanArgs([OWNER_A, "--tokens-file", path]);
    assert.deepEqual(args.tokens, [TOKEN]);
    assert.equal(args.labels.get(TOKEN.toLowerCase()), "USD Tether");
  });
});

test("a label appears in the scan header and JSON", () => {
  const labelled = report();
  labelled.tokens[0] = { ...labelled.tokens[0]!, label: "Tether USD" };

  const text = formatScan(labelled);
  assert.match(text, /USDT \[Tether USD\] \(0x1E4a…D41d\)/);

  const json = toScanJson(labelled) as { tokens: Array<{ label: string | null }> };
  assert.equal(json.tokens[0]?.label, "Tether USD");
});

test("format and JSON list chunk fallbacks", () => {
  const value = report();
  value.chunks = [
    {
      owner: OWNER_A,
      index: 2,
      total: 3,
      tokens: 12,
      status: "partial",
      error: "out of gas",
      individual: [TOKEN],
    },
    {
      owner: OWNER_B,
      index: 1,
      total: 1,
      tokens: 1,
      status: "batched",
      error: null,
      individual: [],
    },
  ];
  value.fallbacks = [
    {
      owner: OWNER_A,
      token: TOKEN,
      symbol: "USDT",
      label: null,
      chunk: 2,
      chunks: 3,
      error: "out of gas",
    },
  ];

  const text = formatScan(value);
  assert.match(text, /chunks {8}2 \(0 recovered, 1 partial, 0 failed\)/);
  assert.match(text, /fallbacks {5}1 token read individually/);
  assert.match(
    text,
    /0x0000…dEaD {2}chunk 2\/3 {2}0x1E4a5963aBFD975d8c9021ce480b42188849D41d USDT/,
  );

  const json = toScanJson(value) as {
    chunks: Array<{ status: string; individual: string[] }>;
    fallbacks: Array<{ token: string; chunk: number }>;
  };
  assert.equal(json.chunks[0]?.status, "partial");
  assert.deepEqual(json.chunks[0]?.individual, [TOKEN]);
  assert.equal(json.fallbacks[0]?.token, TOKEN);
  assert.equal(json.fallbacks[0]?.chunk, 2);
});

test("scan exposes retry and recovery counts even when chunks recover", () => {
  const value = report();
  value.recovery = { failedChunks: 1, retryRequests: 2, recoveredChunks: 1 };

  assert.match(
    formatScan(value),
    /recovery\s+1 failed chunk, 2 retry requests, 1 recovered/,
  );
  assert.deepEqual(
    (toScanJson(value) as { recovery: unknown }).recovery,
    { failedChunks: 1, retryRequests: 2, recoveredChunks: 1 },
  );
});

test("format and JSON expose the same numbers", () => {
  const text = formatScan(report());
  assert.match(text, /owners {8}2/);
  assert.match(text, /native {6}61\.997998034799592649 OKB/);
  assert.match(text, /USDT \(0x1E4a…D41d\) {2}0\.028275/);
  assert.match(text, /0x0000…0009 {2}unreadable/);
  assert.match(text, /flag {10}token 0x0000…0009: no contract code/);

  const json = toScanJson(report()) as {
    cache: { hits: number; misses: number };
    rows: Array<{ native: string; balances: (string | null)[] }>;
    tokens: Array<{ symbol: string }>;
  };
  assert.deepEqual(json.cache, { hits: 0, misses: 0 });
  assert.equal(json.rows[0]?.native, "61997998034799592649");
  assert.deepEqual(json.rows[1]?.balances, ["0", null]);
  assert.equal(json.tokens[0]?.symbol, "USDT");
});
