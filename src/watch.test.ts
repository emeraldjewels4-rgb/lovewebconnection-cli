import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { encodeFunctionData, encodeFunctionResult, erc20Abi, type Address, type PublicClient } from "viem";

import type { BalancesReport } from "./balances.ts";
import type { ChainConfig } from "./chain.ts";
import {
  DEFAULT_WATCH_OPTIONS,
  WatchArgError,
  createAlertState,
  createTracker,
  describeBalanceChange,
  evaluateAlerts,
  evaluateSample,
  formatWatchEvent,
  formatWatchSummary,
  parseWatchArgs,
  toWatchEventJson,
  toWatchSummaryJson,
  watchChain,
  type WatchEvent,
  type WatchOptions,
} from "./watch.ts";
import type { SessionMetrics, WatchMetrics } from "./metrics.ts";
import { MULTICALL3_ADDRESS, multicall3BatchAbi } from "./contract.ts";

const config: ChainConfig = {
  chainId: 196,
  name: "xlayer",
  rpcUrl: "https://xlayer.drpc.org",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  authHeader: null,
  preset: "xlayer",
  timeoutMs: 15_000,
};

const BASE_GAS = 21_000_000n; // 0.021 gwei, the X Layer level observed live
const OWNER = "0x000000000000000000000000000000000000dEaD";
const PORTFOLIO_TOKEN = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";

function withTempJson(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lwc-watch-"));
  try {
    const path = join(dir, "tokens.json");
    writeFileSync(path, contents);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function portfolioReport(block: bigint, amount: bigint): BalancesReport {
  return {
    owner: OWNER,
    chainId: 196,
    chainName: "xlayer",
    native: { symbol: "OKB", decimals: 18, balance: 10n ** 18n },
    tokens: [
      {
        address: PORTFOLIO_TOKEN,
        symbol: "USDT",
        label: "Tether USD",
        decimals: 6,
        balance: amount,
        cacheAgeMs: null,
        issue: null,
      },
    ],
    blockNumber: block,
    batchWarning: null,
    batchSize: 12,
    chunkCount: 0,
    chunks: [],
    recovery: { failedChunks: 0, retryRequests: 0, recoveredChunks: 0 },
    cache: { hits: 0, misses: 0 },
  };
}

function options(over: Partial<WatchOptions> = {}): WatchOptions {
  return { ...DEFAULT_WATCH_OPTIONS, ...over };
}

function metricsAt(p95: number, medianSeconds: number): WatchMetrics {
  return metricsLiteral({
    latency: { count: 10, p50: 300, p95, min: 100, max: p95, mean: 400 },
    blockTime: {
      count: 5,
      medianSeconds,
      minSeconds: medianSeconds,
      maxSeconds: medianSeconds,
      meanSeconds: medianSeconds,
    },
  });
}

function metricsLiteral(over: Partial<WatchMetrics> = {}): WatchMetrics {
  return {
    samples: 12,
    windowSize: 20,
    latency: { count: 12, p50: 344, p95: 718, min: 180, max: 1097, mean: 420 },
    blockTime: {
      count: 10,
      medianSeconds: 0.9,
      minSeconds: 0.6,
      maxSeconds: 2.1,
      meanSeconds: 1.05,
    },
    windowFailures: 1,
    windowPolls: 12,
    errorRate: 1 / 12,
    ...over,
  };
}

function sessionLiteral(over: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    samples: 340,
    failures: 2,
    polls: 342,
    errorRate: 2 / 342,
    latency: { count: 340, p50: 302, p95: 640, min: 88, max: 4820, mean: 355 },
    blockTime: {
      count: 338,
      medianSeconds: 0.9,
      minSeconds: 0.4,
      maxSeconds: 9.8,
      meanSeconds: 1.1,
    },
    ...over,
  };
}

function sample(
  at: number,
  blockNumber: bigint,
  chainId = 196,
  gasPriceWei: bigint | null = BASE_GAS,
) {
  return { at, blockNumber, chainId, gasPriceWei, latencyMs: 40 };
}

test("parses watch flags and applies defaults", () => {
  assert.deepEqual(parseWatchArgs([], {}), DEFAULT_WATCH_OPTIONS);
  assert.equal(
    parseWatchArgs(["--alert-queue", "./alerts.json"], {}).alertQueuePath,
    "./alerts.json",
  );
  assert.equal(parseWatchArgs(["--alert-queue=./alerts.json"], {}).alertQueuePath, "./alerts.json");
  assert.throws(
    () => parseWatchArgs(["--alert-queue="], {}),
    /--alert-queue requires a file path/,
  );
  assert.deepEqual(
    parseWatchArgs([
      "--interval",
      "5",
      "--stall-after",
      "60",
      "--samples",
      "3",
      "--gas-surge",
      "80",
    ]),
    {
      intervalMs: 5000,
      stallAfterSeconds: 60,
      maxSamples: 3,
      gasSurgePercent: 80,
      windowSize: 20,
      reportEvery: 0,
      logPath: null,
      logMaxBytes: 0,
      detach: false,
      alertLatencyMs: null,
      alertBlockTimeSeconds: null,
      alertBalancePercent: null,
      webhookUrl: null,
      alertAuthHeader: null,
      alertQueuePath: null,
      owner: null,
      tokens: [],
      labels: new Map(),
      portfolioEvery: 1,
      batchSize: null,
      maxSubCalls: null,
      verbose: false,
      usd: false,
    },
  );
});

test("parses a portfolio batch size", () => {
  assert.equal(parseWatchArgs([]).batchSize, null, "automatic batching by default");
  assert.equal(parseWatchArgs(["--batch-size", "4"]).batchSize, 4);
  assert.equal(parseWatchArgs(["--batch-size=1"]).batchSize, 1);
  assert.throws(() => parseWatchArgs(["--batch-size", "0"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--batch-size", "101"]), WatchArgError);
});

test("parses --verbose for portfolio chunk progress", () => {
  assert.equal(parseWatchArgs([]).verbose, false);
  assert.equal(parseWatchArgs(["--verbose"]).verbose, true);
});

test("parses a portfolio sub-call cap", () => {
  assert.equal(parseWatchArgs([]).maxSubCalls, null);
  assert.equal(parseWatchArgs(["--max-subcalls", "40"]).maxSubCalls, 40);
  assert.equal(parseWatchArgs(["--max-subcalls=7"]).maxSubCalls, 7);
  assert.throws(() => parseWatchArgs(["--max-subcalls", "0"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--max-subcalls", "1001"]), WatchArgError);
  assert.throws(
    () => parseWatchArgs(["--batch-size", "4", "--max-subcalls", "9"]),
    /not both/,
  );
  assert.throws(
    () => parseWatchArgs(["--max-subcalls", "9", "--batch-size=4"]),
    /not both/,
  );
});

test("ignores unrelated flags such as --json", () => {
  assert.equal(parseWatchArgs(["--json", "--interval", "2"]).intervalMs, 2000);
});

test("rejects bad or missing watch values", () => {
  assert.throws(() => parseWatchArgs(["--interval"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--interval", "zero"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--interval", "0"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--interval", "301"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--stall-after", "1"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--samples", "abc"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--gas-surge", "0"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--gas-surge", "nope"]), WatchArgError);
});

test("rejects a stall threshold below the poll interval", () => {
  assert.throws(
    () => parseWatchArgs(["--interval", "10", "--stall-after", "5"]),
    (error: unknown) =>
      error instanceof WatchArgError && /must be at least the poll interval/.test(error.message),
  );
});

test("loads a portfolio token list with labels", () => {
  withTempJson(
    JSON.stringify([
      { address: PORTFOLIO_TOKEN, label: "Tether USD" },
      "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
    ]),
    (path) => {
      const parsed = parseWatchArgs([
        "--owner",
        OWNER.toLowerCase(),
        "--tokens-file",
        path,
        "--portfolio-every",
        "3",
      ]);

      assert.equal(parsed.owner, OWNER);
      assert.deepEqual(parsed.tokens, [
        PORTFOLIO_TOKEN,
        "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
      ]);
      assert.equal(parsed.labels.get(PORTFOLIO_TOKEN.toLowerCase()), "Tether USD");
      assert.equal(parsed.portfolioEvery, 3);
    },
  );
});

test("parses the balance alert threshold", () => {
  withTempJson(JSON.stringify([PORTFOLIO_TOKEN]), (path) => {
    const portfolio = ["--owner", OWNER, "--tokens-file", path];

    assert.equal(parseWatchArgs([]).alertBalancePercent, null);
    assert.equal(
      parseWatchArgs([...portfolio, "--alert-balance", "25"]).alertBalancePercent,
      25,
    );
    assert.equal(
      parseWatchArgs([...portfolio, "--alert-balance=5"]).alertBalancePercent,
      5,
    );

    assert.throws(() => parseWatchArgs(["--alert-balance", "0"]), WatchArgError);
    assert.throws(() => parseWatchArgs(["--alert-balance", "many"]), WatchArgError);
    assert.throws(() => parseWatchArgs(["--alert-balance", "25"]), WatchArgError);

    const hooked = parseWatchArgs([
      ...portfolio,
      "--alert-balance",
      "25",
      "--alert-webhook",
      "https://example.com/hook",
    ]);
    assert.equal(hooked.webhookUrl, "https://example.com/hook", "a balance threshold arms the webhook");
  });
});

test("--usd needs a portfolio", () => {
  assert.equal(parseWatchArgs([]).usd, false);

  withTempJson(JSON.stringify([PORTFOLIO_TOKEN]), (path) => {
    assert.equal(
      parseWatchArgs(["--owner", OWNER, "--tokens-file", path, "--usd"]).usd,
      true,
    );
  });

  assert.throws(() => parseWatchArgs(["--usd"]), WatchArgError);
});

test("describeBalanceChange compares a move against its threshold", () => {
  assert.equal(describeBalanceChange(100n, 100n, 10), null, "no move, no alert");
  assert.equal(describeBalanceChange(100n, 110n, 10), null, "exactly at the threshold is not a breach");
  assert.deepEqual(describeBalanceChange(100n, 111n, 10), {
    delta: 11n,
    changePercent: 11,
    direction: "up",
  });
  assert.deepEqual(describeBalanceChange(100n, 80n, 10), {
    delta: -20n,
    changePercent: -20,
    direction: "down",
  });
  assert.deepEqual(
    describeBalanceChange(0n, 5n, 10),
    { delta: 5n, changePercent: null, direction: "up" },
    "a zero baseline has no percentage but still alerts",
  );
});

test("watchChain alerts when a balance moves past the threshold", async () => {
  const client = makeClient([{ block: 100n }, { block: 101n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];
  const reports = [portfolioReport(100n, 1_000_000n), portfolioReport(101n, 2_500_000n)];

  const summary = await watchChain(
    client,
    config,
    options({
      maxSamples: 2,
      owner: OWNER,
      tokens: [PORTFOLIO_TOKEN],
      labels: new Map([[PORTFOLIO_TOKEN.toLowerCase(), "Tether USD"]]),
      alertBalancePercent: 100,
    }),
    (event) => events.push(event),
    undefined,
    { ...deps, readPortfolio: async () => reports.shift() as BalancesReport },
  );

  const alerts = events.filter(
    (event): event is Extract<WatchEvent, { type: "balance-alert" }> =>
      event.type === "balance-alert",
  );
  assert.equal(alerts.length, 1, "the first sample has no baseline to compare");
  assert.equal(alerts[0]?.asset, "token");
  assert.equal(alerts[0]?.address, PORTFOLIO_TOKEN);
  assert.equal(alerts[0]?.previous, 1_000_000n);
  assert.equal(alerts[0]?.balance, 2_500_000n);
  assert.equal(alerts[0]?.delta, 1_500_000n);
  assert.equal(alerts[0]?.changePercent, 150);
  assert.equal(summary.alerts, 1);
  assert.match(
    formatWatchEvent(alerts[0] as WatchEvent, config),
    /BALANCE ALERT: USDT \[Tether USD\] \+150% \(1 → 2\.5\) exceeds 100%/,
  );

  const json = toWatchEventJson(alerts[0] as WatchEvent);
  assert.equal(json.event, "balance-alert");
  assert.equal(json.delta, "1500000");
  assert.equal(json.changePercent, 150);
  assert.equal(json.thresholdPercent, 100);
});

test("a move at or under the balance threshold stays quiet", async () => {
  const client = makeClient([{ block: 100n }, { block: 101n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];
  const reports = [portfolioReport(100n, 1_000_000n), portfolioReport(101n, 1_900_000n)];

  const summary = await watchChain(
    client,
    config,
    options({
      maxSamples: 2,
      owner: OWNER,
      tokens: [PORTFOLIO_TOKEN],
      alertBalancePercent: 90,
    }),
    (event) => events.push(event),
    undefined,
    { ...deps, readPortfolio: async () => reports.shift() as BalancesReport },
  );

  assert.equal(
    events.filter((event) => event.type === "balance-alert").length,
    0,
    "a move exactly at the threshold does not alert",
  );
  assert.equal(summary.alerts, 0);
});

test("a balance that starts from zero alerts with no percentage", async () => {
  const client = makeClient([{ block: 100n }, { block: 101n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];
  const reports = [portfolioReport(100n, 0n), portfolioReport(101n, 500_000n)];

  await watchChain(
    client,
    config,
    options({
      maxSamples: 2,
      owner: OWNER,
      tokens: [PORTFOLIO_TOKEN],
      alertBalancePercent: 10,
    }),
    (event) => events.push(event),
    undefined,
    { ...deps, readPortfolio: async () => reports.shift() as BalancesReport },
  );

  const alert = events.find(
    (event): event is Extract<WatchEvent, { type: "balance-alert" }> =>
      event.type === "balance-alert",
  );
  assert.equal(alert?.changePercent, null);
  assert.match(formatWatchEvent(alert as WatchEvent, config), /\(from zero\) exceeds 10%/);
});

test("a portfolio needs both an owner and a token file", () => {
  withTempJson(JSON.stringify([PORTFOLIO_TOKEN]), (path) => {
    assert.throws(() => parseWatchArgs(["--tokens-file", path]), WatchArgError);
    assert.throws(() => parseWatchArgs(["--owner", OWNER]), WatchArgError);
    assert.throws(() => parseWatchArgs(["--owner", "0xnope", "--tokens-file", path]), WatchArgError);
    assert.throws(
      () => parseWatchArgs(["--owner", OWNER, "--tokens-file", path, "--portfolio-every", "0"]),
      WatchArgError,
    );
    assert.throws(
      () => parseWatchArgs(["--owner", OWNER, "--tokens-file", path, "--portfolio-every"]),
      WatchArgError,
    );
  });
});

test("requires an owner for a token file and a token for an owner", () => {
  withTempJson(JSON.stringify([PORTFOLIO_TOKEN]), (path) => {
    assert.throws(
      () => parseWatchArgs(["--tokens-file", path]),
      (error: unknown) =>
        error instanceof WatchArgError && /needs --owner/.test(error.message),
    );
    assert.throws(
      () => parseWatchArgs(["--owner", OWNER]),
      (error: unknown) =>
        error instanceof WatchArgError && /needs --tokens-file/.test(error.message),
    );
  });
});

test("watch portfolio batches densely once metadata is cached", async () => {
  const tokens = Array.from(
    { length: 13 },
    (_, index) => `0x${(index + 0x100).toString(16).padStart(40, "0")}` as Address,
  );
  const sizes: number[] = [];
  const client = {
    getBlockNumber: async () => 100n,
    getChainId: async () => 196,
    getGasPrice: async () => BASE_GAS,
    readContract: async (args: { args?: unknown[] }) => {
      const calls = (args.args?.[0] ?? []) as Array<{ target: string; callData: string }>;
      sizes.push(calls.length);
      const decimals = encodeFunctionData({ abi: erc20Abi, functionName: "decimals" });
      const symbol = encodeFunctionData({ abi: erc20Abi, functionName: "symbol" });
      const balanceOf = encodeFunctionData({
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [OWNER],
      });
      const totalSupply = encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" });

      return calls.map((call) => {
        if (call.target === MULTICALL3_ADDRESS) {
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: multicall3BatchAbi,
              functionName: "getEthBalance",
              result: 1n,
            }),
          };
        }
        if (call.callData === decimals) {
          return {
            success: true,
            returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 }),
          };
        }
        if (call.callData === symbol) {
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "symbol",
              result: "TKN",
            }),
          };
        }
        if (call.callData === balanceOf) {
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "balanceOf",
              result: 0n,
            }),
          };
        }
        if (call.callData === totalSupply) {
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "totalSupply",
              result: 1n,
            }),
          };
        }
        throw new Error(`unexpected call ${call.callData}`);
      });
    },
  } as unknown as PublicClient;
  const { deps } = fakeClock();

  await watchChain(
    client,
    config,
    options({ maxSamples: 2, owner: OWNER, tokens }),
    () => {},
    undefined,
    deps,
  );

  assert.deepEqual(
    sizes.slice(0, 2).sort((a, b) => a - b),
    [4, 49],
    "first sample reads 12 tokens, then 1, with metadata",
  );
  assert.deepEqual(sizes.slice(2), [27], "cached sample packs all 13 tokens into one chunk");
});

test("watchChain reports portfolio balances and their change", async () => {
  const client = makeClient([{ block: 100n }, { block: 101n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];
  const reports = [portfolioReport(100n, 1_000_000n), portfolioReport(101n, 2_500_000n)];

  const summary = await watchChain(
    client,
    config,
    options({
      maxSamples: 2,
      owner: OWNER,
      tokens: [PORTFOLIO_TOKEN],
      labels: new Map([[PORTFOLIO_TOKEN.toLowerCase(), "Tether USD"]]),
    }),
    (event) => events.push(event),
    undefined,
    { ...deps, readPortfolio: async () => reports.shift() as BalancesReport },
  );

  const portfolios = events.filter(
    (event): event is Extract<WatchEvent, { type: "portfolio" }> => event.type === "portfolio",
  );
  assert.equal(portfolios.length, 2);
  assert.equal(portfolios[0]?.tokens[0]?.delta, null, "the first sample has nothing to compare");
  assert.equal(portfolios[1]?.tokens[0]?.balance, 2_500_000n);
  assert.equal(portfolios[1]?.tokens[0]?.delta, 1_500_000n);
  assert.equal(portfolios[1]?.native?.delta, 0n);
  assert.match(formatWatchEvent(portfolios[1] as WatchEvent, config), /USDT \[Tether USD\] 2\.5 \(\+1\.5\)/);

  assert.equal(summary.portfolio?.samples, 2);
  assert.equal(summary.portfolio?.tokens[0]?.first, 1_000_000n);
  assert.equal(summary.portfolio?.tokens[0]?.last, 2_500_000n);
  assert.equal(summary.portfolio?.tokens[0]?.delta, 1_500_000n);
  assert.match(formatWatchSummary(summary), /portfolio {5}2 samples/);
  assert.match(formatWatchSummary(summary), /USDT 2\.5 \(\+1\.5\)/);

  const json = toWatchSummaryJson(summary) as {
    portfolio: { tokens: Array<{ delta: string }> };
  };
  assert.equal(json.portfolio.tokens[0]?.delta, "1500000");
});

test("watchChain values the portfolio in USD", async () => {
  const client = makeClient([{ block: 100n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];
  const reports = [portfolioReport(100n, 2_500_000n)];

  await watchChain(
    client,
    config,
    options({ maxSamples: 1, owner: OWNER, tokens: [PORTFOLIO_TOKEN], usd: true }),
    (event) => events.push(event),
    undefined,
    {
      ...deps,
      readPortfolio: async () => reports.shift() as BalancesReport,
      readPrices: async () => ({
        tokens: new Map([
          [PORTFOLIO_TOKEN.toLowerCase(), { price: 2, symbol: "USDT", timestamp: null }],
        ]),
        native: { price: 100, symbol: "OKB", timestamp: null },
        error: null,
      }),
    },
  );

  const portfolio = events.find(
    (event): event is Extract<WatchEvent, { type: "portfolio" }> =>
      event.type === "portfolio",
  );
  assert.equal(portfolio?.tokens[0]?.usd, 5, "2.5 USDT at $2");
  assert.equal(portfolio?.native?.usd, 100, "1 OKB at $100");
  assert.equal(portfolio?.usdTotal, 105);
  assert.equal(portfolio?.priceError, null);

  const rendered = formatWatchEvent(portfolio as WatchEvent, config);
  assert.match(rendered, /total \$105\.00/);
  assert.match(rendered, /≈ \$5\.00/);
  assert.match(rendered, /≈ \$100\.00/);

  const json = toWatchEventJson(portfolio as WatchEvent) as {
    usdTotal: number;
    batchSize: number;
    chunkCount: number;
    native: { usd: number };
    tokens: Array<{ usd: number }>;
  };
  assert.equal(json.usdTotal, 105);
  assert.equal(json.batchSize, 12);
  assert.equal(json.chunkCount, 0);
  assert.equal(json.native.usd, 100);
  assert.equal(json.tokens[0]?.usd, 5);
});

test("emits portfolio chunk recovery as chunk-recovery events", async () => {
  const client = makeClient([{ block: 100n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];
  const FALLBACK = "0x2222222222222222222222222222222222222222";
  const report: BalancesReport = {
    ...portfolioReport(100n, 2_500_000n),
    chunkCount: 3,
    chunks: [
      { index: 1, total: 3, tokens: 12, status: "batched", error: null, individual: [] },
      {
        index: 2,
        total: 3,
        tokens: 12,
        status: "recovered",
        error: "execution reverted",
        individual: [PORTFOLIO_TOKEN],
      },
      {
        index: 3,
        total: 3,
        tokens: 2,
        status: "partial",
        error: "gas limit exceeded",
        individual: [FALLBACK],
      },
    ],
    recovery: { failedChunks: 2, retryRequests: 4, recoveredChunks: 1 },
  };

  await watchChain(
    client,
    config,
    options({ maxSamples: 1, owner: OWNER, tokens: [PORTFOLIO_TOKEN] }),
    (event) => events.push(event),
    undefined,
    { ...deps, readPortfolio: async () => report },
  );

  const recoveries = events.filter(
    (event): event is Extract<WatchEvent, { type: "chunk-recovery" }> =>
      event.type === "chunk-recovery",
  );
  assert.equal(recoveries.length, 2, "a batched chunk emits no event");
  assert.deepEqual(
    recoveries.map((event) => [event.chunk, event.status, event.tokens]),
    [
      [2, "recovered", 12],
      [3, "partial", 2],
    ],
  );

  const firstRecovery = events.findIndex((event) => event.type === "chunk-recovery");
  const firstPortfolio = events.findIndex((event) => event.type === "portfolio");
  assert.ok(
    firstRecovery >= 0 && firstRecovery < firstPortfolio,
    "the recovery is emitted before the sample it belongs to",
  );

  const json = toWatchEventJson(recoveries[0] as WatchEvent) as Record<string, unknown>;
  assert.equal(json.event, "chunk-recovery");
  assert.equal(json.owner, OWNER);
  assert.equal(json.chunk, 2);
  assert.equal(json.chunks, 3);
  assert.equal(json.status, "recovered");
  assert.deepEqual(json.individual, [PORTFOLIO_TOKEN]);

  const line = formatWatchEvent(recoveries[1] as WatchEvent, config);
  assert.match(
    line,
    /PORTFOLIO CHUNK 3\/3 \(2 tokens\) partly recovered, 1 read individually/,
  );
  assert.match(line, /gas limit exceeded/);
});

test("a price failure is reported without losing the balances", async () => {
  const client = makeClient([{ block: 100n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];
  const reports = [portfolioReport(100n, 2_500_000n)];

  await watchChain(
    client,
    config,
    options({ maxSamples: 1, owner: OWNER, tokens: [PORTFOLIO_TOKEN], usd: true }),
    (event) => events.push(event),
    undefined,
    {
      ...deps,
      readPortfolio: async () => reports.shift() as BalancesReport,
      readPrices: async () => ({ tokens: new Map(), native: null, error: "HTTP 503" }),
    },
  );

  const portfolio = events.find(
    (event): event is Extract<WatchEvent, { type: "portfolio" }> =>
      event.type === "portfolio",
  );
  assert.equal(portfolio?.tokens[0]?.balance, 2_500_000n, "balances still arrived");
  assert.equal(portfolio?.usdTotal, null, "nothing priced is not zero");
  assert.equal(portfolio?.priceError, "HTTP 503");
  assert.match(formatWatchEvent(portfolio as WatchEvent, config), /prices HTTP 503/);
});

test("a portfolio read failure is reported without stopping the watch", async () => {
  const client = makeClient([{ block: 100n }, { block: 101n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];

  const summary = await watchChain(
    client,
    config,
    options({ maxSamples: 2, owner: OWNER, tokens: [PORTFOLIO_TOKEN] }),
    (event) => events.push(event),
    undefined,
    {
      ...deps,
      readPortfolio: async () => {
        throw new Error("balances unavailable");
      },
    },
  );

  const portfolios = events.filter(
    (event): event is Extract<WatchEvent, { type: "portfolio" }> => event.type === "portfolio",
  );
  assert.equal(portfolios.length, 2);
  assert.match(portfolios[0]?.error ?? "", /balances unavailable/);
  assert.equal(summary.samples, 2, "the chain watch kept going");
  assert.equal(summary.portfolio?.samples, 0);
  assert.match(formatWatchEvent(portfolios[0] as WatchEvent, config), /error: balances unavailable/);
});

test("parses the rolling-report flags", () => {
  const parsed = parseWatchArgs(["--window", "50", "--report-every", "10"]);

  assert.equal(parsed.windowSize, 50);
  assert.equal(parsed.reportEvery, 10);

  assert.throws(() => parseWatchArgs(["--window", "2"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--window", "2000"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--report-every", "-1"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--report-every"]), WatchArgError);
});

test("first sample advances from nothing", () => {
  const { state, events } = evaluateSample(createTracker(), sample(1000, 100n), options(), 196);

  assert.equal(events.length, 1);
  const event = events[0] as Extract<WatchEvent, { type: "advance" }>;
  assert.equal(event.type, "advance");
  assert.equal(event.delta, 0n);
  assert.equal(event.blockNumber, 100n);
  assert.equal(event.gasPriceWei, BASE_GAS);
  assert.equal(state.lastBlock, 100n);
  assert.equal(state.lastAdvanceAt, 1000);
});

test("reports a hold while the head is unchanged below the threshold", () => {
  const first = evaluateSample(createTracker(), sample(0, 100n), options(), 196);
  const second = evaluateSample(
    first.state,
    sample(3000, 100n),
    options({ stallAfterSeconds: 6 }),
    196,
  );

  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]?.type, "hold");
  assert.equal(second.state.stalledSince, null);
});

test("reports a stall once, then a recovery", () => {
  let state = createTracker();
  state = evaluateSample(state, sample(0, 100n), options({ stallAfterSeconds: 6 }), 196).state;
  state = evaluateSample(state, sample(3000, 100n), options({ stallAfterSeconds: 6 }), 196).state;

  const stalled = evaluateSample(state, sample(6000, 100n), options({ stallAfterSeconds: 6 }), 196);
  assert.equal(stalled.events[0]?.type, "stall");
  const stall = stalled.events[0] as Extract<WatchEvent, { type: "stall" }>;
  assert.equal(stall.staleSeconds, 6);
  assert.equal(stall.blockNumber, 100n);

  const repeated = evaluateSample(
    stalled.state,
    sample(9000, 100n),
    options({ stallAfterSeconds: 6 }),
    196,
  );
  assert.equal(repeated.events.length, 0);

  const recovered = evaluateSample(
    repeated.state,
    sample(12000, 101n),
    options({ stallAfterSeconds: 6 }),
    196,
  );
  const recovery = recovered.events[0] as Extract<WatchEvent, { type: "recovered" }>;
  assert.equal(recovery.type, "recovered");
  assert.equal(recovery.from, 100n);
  assert.equal(recovery.to, 101n);
  assert.equal(recovery.stalledForSeconds, 12);
  assert.equal(recovered.state.stalledSince, null);
});

test("reports chain drift and does not repeat it while it persists", () => {
  const first = evaluateSample(createTracker(), sample(0, 100n, 1), options(), 196);
  const drift = first.events.find((event) => event.type === "chain-drift");
  assert.ok(drift);
  const event = drift as Extract<WatchEvent, { type: "chain-drift" }>;
  assert.equal(event.expected, 196);
  assert.equal(event.actual, 1);
  assert.equal(event.previous, null);

  const second = evaluateSample(first.state, sample(3000, 101n, 1), options(), 196);
  assert.equal(second.events.some((item) => item.type === "chain-drift"), false);

  const third = evaluateSample(second.state, sample(6000, 102n, 2), options(), 196);
  assert.equal(third.events.some((item) => item.type === "chain-drift"), true);
});

test("treats a lower block number as no advance and keeps the highest seen", () => {
  const first = evaluateSample(createTracker(), sample(0, 100n), options(), 196);
  const regression = evaluateSample(
    first.state,
    sample(3000, 98n),
    options({ stallAfterSeconds: 30 }),
    196,
  );

  assert.equal(regression.events[0]?.type, "hold");
  assert.equal(regression.state.lastBlock, 100n);
});

test("flags a gas surge above the rolling baseline", () => {
  let state = createTracker();
  for (const at of [0, 3000, 6000]) {
    state = evaluateSample(state, sample(at, 100n), options(), 196).state;
  }

  const surged = evaluateSample(state, sample(9000, 101n, 196, 42_000_000n), options(), 196);
  const surge = surged.events.find((event) => event.type === "gas-surge");
  assert.ok(surge);
  const event = surge as Extract<WatchEvent, { type: "gas-surge" }>;
  assert.equal(event.gasPriceWei, 42_000_000n);
  assert.equal(event.baselineWei, BASE_GAS);
  assert.equal(event.increasePercent, 100);
  assert.equal(surged.state.gasSurge, true);
});

test("does not flag a rise below the surge threshold", () => {
  let state = createTracker();
  for (const at of [0, 3000, 6000]) {
    state = evaluateSample(state, sample(at, 100n), options(), 196).state;
  }

  // +42% is below the 50% default.
  const mild = evaluateSample(state, sample(9000, 101n, 196, 30_000_000n), options(), 196);

  assert.equal(mild.events.some((event) => event.type === "gas-surge"), false);
  assert.equal(mild.state.gasSurge, false);
});

test("normalizes gas with hysteresis after a surge", () => {
  let state = createTracker();
  for (const at of [0, 3000, 6000]) {
    state = evaluateSample(state, sample(at, 100n), options(), 196).state;
  }
  const surged = evaluateSample(state, sample(9000, 101n, 196, 42_000_000n), options(), 196);
  assert.equal(surged.state.gasSurge, true);

  const stillHigh = evaluateSample(surged.state, sample(12000, 102n, 196, 30_000_000n), options(), 196);
  assert.equal(stillHigh.events.some((event) => event.type === "gas-normal"), false);

  const calm = evaluateSample(stillHigh.state, sample(15000, 103n, 196, BASE_GAS), options(), 196);
  const normal = calm.events.find((event) => event.type === "gas-normal");
  assert.ok(normal);
  const event = normal as Extract<WatchEvent, { type: "gas-normal" }>;
  assert.equal(event.gasPriceWei, BASE_GAS);
  assert.equal(calm.state.gasSurge, false);
});

test("tolerates an unavailable gas price", () => {
  let state = createTracker();
  state = evaluateSample(state, sample(0, 100n, 196, null), options(), 196).state;

  const next = evaluateSample(state, sample(3000, 101n, 196, null), options(), 196);

  assert.equal(next.events.some((event) => event.type === "gas-surge"), false);
  assert.equal(next.state.gasHistory.length, 0);
});

function makeClient(
  entries: Array<{ block: bigint; chainId?: number; gas?: bigint | null } | Error>,
): PublicClient {
  let reads = 0;
  const read = () => {
    const entry = entries[Math.min(Math.floor(reads / 3), entries.length - 1)];
    reads += 1;
    if (!entry) throw new Error("no entries");
    return entry;
  };

  return {
    getBlockNumber: async () => {
      const entry = read();
      if (entry instanceof Error) throw entry;
      return entry.block;
    },
    getChainId: async () => {
      const entry = read();
      if (entry instanceof Error) throw entry;
      return entry.chainId ?? 196;
    },
    getGasPrice: async () => {
      const entry = read();
      if (entry instanceof Error) throw entry;
      return entry.gas === undefined ? BASE_GAS : entry.gas;
    },
  } as unknown as PublicClient;
}

function fakeClock(start = 0) {
  const clock = { value: start };
  return {
    clock,
    deps: {
      now: () => clock.value,
      sleep: async (ms: number) => {
        clock.value += ms;
      },
    },
  };
}

test("watchChain samples, detects a stall and a recovery, then summarizes", async () => {
  const client = makeClient([{ block: 100n }, { block: 100n }, { block: 100n }, { block: 101n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];

  const summary = await watchChain(
    client,
    config,
    options({ intervalMs: 3000, stallAfterSeconds: 6, maxSamples: 4 }),
    (event) => events.push(event),
    undefined,
    deps,
  );

  assert.equal(summary.samples, 4);
  assert.equal(summary.stalls, 1);
  assert.equal(summary.firstBlock, 100n);
  assert.equal(summary.lastBlock, 101n);
  assert.equal(summary.advancedBy, 1n);
  assert.equal(summary.chainDrift, false);
  assert.equal(summary.gasSurges, 0);
  assert.equal(summary.lastGasWei, BASE_GAS);
  assert.equal(summary.peakGasWei, BASE_GAS);
  assert.equal(events.filter((event) => event.type === "stall").length, 1);
  assert.equal(events.filter((event) => event.type === "recovered").length, 1);
});

test("watchChain records a gas surge in the summary", async () => {
  const client = makeClient([
    { block: 100n, gas: BASE_GAS },
    { block: 101n, gas: BASE_GAS },
    { block: 102n, gas: 60_000_000n },
  ]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];

  const summary = await watchChain(
    client,
    config,
    options({ maxSamples: 3 }),
    (event) => events.push(event),
    undefined,
    deps,
  );

  assert.equal(summary.gasSurges, 1);
  assert.equal(summary.peakGasWei, 60_000_000n);
  assert.equal(summary.lastGasWei, 60_000_000n);
  assert.equal(events.filter((event) => event.type === "gas-surge").length, 1);
});

test("watchChain counts transient errors and continues", async () => {
  const client = makeClient([new Error("boom"), { block: 100n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];

  const summary = await watchChain(
    client,
    config,
    options({ maxSamples: 1 }),
    (event) => events.push(event),
    undefined,
    deps,
  );

  assert.equal(summary.errors, 1);
  assert.equal(summary.samples, 1);
  assert.equal(events.filter((event) => event.type === "error").length, 1);
});

test("watchChain stops after five consecutive errors", async () => {
  const client = makeClient([new Error("always down")]);
  const { deps } = fakeClock();

  const summary = await watchChain(
    client,
    config,
    options({ maxSamples: 20 }),
    () => {},
    undefined,
    deps,
  );

  assert.equal(summary.errors, 5);
  assert.equal(summary.samples, 0);
});

test("watchChain records chain drift in the summary", async () => {
  const client = makeClient([{ block: 100n, chainId: 1 }]);
  const { deps } = fakeClock();

  const summary = await watchChain(
    client,
    config,
    options({ maxSamples: 1 }),
    () => {},
    undefined,
    deps,
  );

  assert.equal(summary.chainDrift, true);
});

test("watchChain emits one alert when block time crosses its threshold", async () => {
  const client = makeClient([{ block: 100n }, { block: 101n }, { block: 102n }]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];

  const summary = await watchChain(
    client,
    config,
    options({ intervalMs: 3000, maxSamples: 3, alertBlockTimeSeconds: 1 }),
    (event) => {
      events.push(event);
    },
    undefined,
    deps,
  );

  const alerts = events.filter(
    (event): event is Extract<WatchEvent, { type: "alert" }> => event.type === "alert",
  );

  assert.equal(alerts.length, 1, "one breach, not one per sample");
  assert.equal(alerts[0]?.metric, "block-time");
  assert.equal(alerts[0]?.direction, "breach");
  assert.equal(alerts[0]?.value, 3);
  assert.equal(alerts[0]?.threshold, 1);
  assert.equal(alerts[0]?.cumulative.samples, 2, "totals as of the alert, not the final run");
  assert.equal(alerts[0]?.cumulative.polls, 2);
  assert.equal(alerts[0]?.cumulative.failures, 0);
  assert.equal(alerts[0]?.cumulative.latency.count, 2);
  assert.equal(alerts[0]?.cumulative.blockTime.count, 1);
  assert.equal(summary.alerts, 1);
});

test("watchChain records rolling latency and block-time metrics", async () => {
  const client = makeClient([{ block: 100n }, { block: 101n }, { block: 102n }]);
  const { deps } = fakeClock();

  const summary = await watchChain(
    client,
    config,
    options({ intervalMs: 3000, maxSamples: 3 }),
    () => {},
    undefined,
    deps,
  );

  assert.equal(summary.metrics.latency.count, 3);
  assert.equal(summary.metrics.samples, 3);
  assert.equal(summary.metrics.blockTime.count, 2, "one interval per real advance");
  assert.equal(summary.metrics.blockTime.medianSeconds, 3);
  assert.equal(summary.metrics.windowPolls, 3);
  assert.equal(summary.metrics.windowFailures, 0);
});

test("parses alert thresholds and the webhook", () => {
  const parsed = parseWatchArgs([
    "--alert-latency",
    "1500",
    "--alert-block-time",
    "5",
    "--alert-webhook",
    "https://example.com/hook",
  ]);

  assert.equal(parsed.alertLatencyMs, 1500);
  assert.equal(parsed.alertBlockTimeSeconds, 5);
  assert.equal(parsed.webhookUrl, "https://example.com/hook");
  assert.equal(
    parseWatchArgs(["--alert-webhook=http://localhost:9000/x", "--alert-latency", "500"]).webhookUrl,
    "http://localhost:9000/x",
  );

  assert.throws(
    () => parseWatchArgs(["--alert-webhook", "https://example.com/hook"]),
    WatchArgError,
    "a webhook needs a threshold",
  );
  assert.throws(() => parseWatchArgs(["--alert-latency", "0"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--alert-block-time", "0"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--alert-webhook", "ftp://example.com"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--alert-latency"]), WatchArgError);
});

test("throttled alerts fire on the rising edge and clear on the way down", () => {
  const thresholds = { alertLatencyMs: 1000, alertBlockTimeSeconds: 5 };
  let state = createAlertState();

  const first = evaluateAlerts(metricsAt(1200, 4), thresholds, state);
  state = first.state;
  assert.deepEqual(
    first.alerts.map((alert) => `${alert.metric}:${alert.direction}:${alert.value}`),
    ["latency:breach:1200"],
  );

  const sustained = evaluateAlerts(metricsAt(1800, 4), thresholds, state);
  state = sustained.state;
  assert.deepEqual(sustained.alerts, [], "no repeat while still above");

  const mixed = evaluateAlerts(metricsAt(900, 7), thresholds, state);
  state = mixed.state;
  assert.deepEqual(
    mixed.alerts.map((alert) => `${alert.metric}:${alert.direction}`),
    ["latency:clear", "block-time:breach"],
  );

  const cleared = evaluateAlerts(metricsAt(500, 3), thresholds, state);
  assert.deepEqual(
    cleared.alerts.map((alert) => `${alert.metric}:${alert.direction}`),
    ["block-time:clear"],
  );
});

test("thresholds without samples stay quiet", () => {
  const empty = metricsLiteral({
    latency: { count: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 },
    blockTime: { count: 0, medianSeconds: 0, minSeconds: 0, maxSeconds: 0, meanSeconds: 0 },
  });
  const result = evaluateAlerts(empty, { alertLatencyMs: 1, alertBlockTimeSeconds: 1 }, createAlertState());

  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.state, createAlertState());
});

test("parses --log and --detach for service runs", () => {
  const parsed = parseWatchArgs(["--log", "./watch.ndjson", "--detach"]);
  assert.equal(parsed.logPath, "./watch.ndjson");
  assert.equal(parsed.detach, true);
  assert.equal(parseWatchArgs(["--log=./other.ndjson"]).logPath, "./other.ndjson");

  const defaults = parseWatchArgs([]);
  assert.equal(defaults.logPath, null);
  assert.equal(defaults.detach, false);

  assert.throws(() => parseWatchArgs(["--detach"]), WatchArgError, "detach needs a log file");
  assert.throws(() => parseWatchArgs(["--log"]), WatchArgError);
  assert.throws(() => parseWatchArgs(["--log="]), WatchArgError);
});

test("--report-every emits rolling metrics events", async () => {
  const client = makeClient([
    { block: 100n },
    { block: 101n },
    { block: 102n },
    { block: 103n },
  ]);
  const { deps } = fakeClock();
  const events: WatchEvent[] = [];

  await watchChain(
    client,
    config,
    options({ maxSamples: 4, reportEvery: 2 }),
    (event) => events.push(event),
    undefined,
    deps,
  );

  const reports = events.filter((event) => event.type === "metrics");
  assert.equal(reports.length, 2);

  const first = reports[0] as Extract<WatchEvent, { type: "metrics" }>;
  assert.equal(first.metrics.latency.count, 2);
  assert.equal(first.metrics.blockTime.count, 1);
  assert.equal(first.cumulative.latency.count, 2, "session totals travel with the event");
  assert.equal(first.cumulative.polls, 2);
  assert.equal(first.cumulative.blockTime.count, 1);
});

test("formatWatchEvent renders each event type", () => {
  const at = new Date(2026, 10, 9, 12, 0, 3).getTime();

  assert.match(
    formatWatchEvent(
      { type: "advance", at, blockNumber: 100n, delta: 1n, gasPriceWei: BASE_GAS, latencyMs: 40 },
      config,
    ),
    /^\d{2}:\d{2}:\d{2} {2}block 100 \(\+1\) {2}0\.021 gwei {2}40 ms$/,
  );
  assert.match(
    formatWatchEvent(
      {
        type: "hold",
        at,
        blockNumber: 100n,
        staleSeconds: 3,
        gasPriceWei: BASE_GAS,
        latencyMs: 40,
      },
      config,
    ),
    /block 100 \(unchanged 3s\) {2}0\.021 gwei {2}40 ms/,
  );
  assert.match(
    formatWatchEvent({ type: "stall", at, blockNumber: 100n, staleSeconds: 31 }, config),
    /STALL: block 100 has not advanced for 31s/,
  );
  assert.match(
    formatWatchEvent(
      { type: "recovered", at, from: 100n, to: 102n, stalledForSeconds: 35 },
      config,
    ),
    /RECOVERED: 100 → 102 after 35s/,
  );
  assert.match(
    formatWatchEvent(
      { type: "chain-drift", at, expected: 196, previous: 196, actual: 1 },
      config,
    ),
    /CHAIN DRIFT: expected 196 \(xlayer\), RPC answered 1/,
  );
  assert.match(
    formatWatchEvent(
      {
        type: "gas-surge",
        at,
        gasPriceWei: 42_000_000n,
        baselineWei: BASE_GAS,
        increasePercent: 100,
      },
      config,
    ),
    /GAS SURGE: 0\.042 gwei, \+100% over 0\.021 gwei baseline/,
  );
  assert.match(
    formatWatchEvent(
      { type: "gas-normal", at, gasPriceWei: BASE_GAS, baselineWei: BASE_GAS },
      config,
    ),
    /GAS NORMAL: 0\.021 gwei \(baseline 0\.021 gwei\)/,
  );
  assert.match(
    formatWatchEvent({ type: "advance", at, blockNumber: 100n, delta: 0n, gasPriceWei: null, latencyMs: 40 }, config),
    /gas n\/a/,
  );
  assert.match(
    formatWatchEvent(
      { type: "metrics", at, metrics: metricsLiteral(), cumulative: sessionLiteral() },
      config,
    ),
    /METRICS: latency p50 344 ms, p95 718 ms, max 1097 ms \| block time median 0\.9s \| errors 1\/12 \| session latency p50 302 ms, p95 640 ms, max 4820 ms \| session block time median 0\.9s \| session errors 2\/342/,
  );
  assert.match(
    formatWatchEvent({ type: "error", at, message: "timeout" }, config),
    /error: timeout/,
  );
});

test("formatWatchSummary reports block movement, gas, stalls, drift, and errors", () => {
  const output = formatWatchSummary({
    samples: 12,
    errors: 1,
    firstBlock: 100n,
    lastBlock: 112n,
    advancedBy: 12n,
    chainDrift: false,
    stalls: 2,
    gasSurges: 1,
    alerts: 2,
    lastGasWei: 42_000_000n,
    peakGasWei: 60_000_000n,
    metrics: metricsLiteral(),
    session: sessionLiteral(),
    durationMs: 36_000,
    aborted: false,
    portfolio: null,
  });

  assert.match(output, /samples {7}12/);
  assert.match(output, /duration {6}36s/);
  assert.match(output, /block {9}100 → 112 \(\+12\)/);
  assert.match(output, /gas {11}0\.042 gwei \(peak 0\.06 gwei\)/);
  assert.match(output, /latency {7}p50 344 ms, p95 718 ms, max 1097 ms \(12 samples\)/);
  assert.match(output, /block time {4}median 0\.9s, min 0\.6s, max 2\.1s \(10 intervals\)/);
  assert.match(output, /failures {6}1 of 12 polls \(8%\)/);
  assert.match(output, /session p50 302 ms, p95 640 ms, max 4820 ms \(340 samples\)/);
  assert.match(
    output,
    /session median 0\.9s, min 0\.4s, max 9\.8s \(338 intervals\)/,
  );
  assert.match(output, /session 2 of 342 polls \(0\.6%\)/);
  assert.match(output, /gas surges {4}1/);
  assert.match(output, /alerts {8}2/);
  assert.match(output, /stalls {8}2/);
  assert.match(output, /chain drift {3}none/);
  assert.match(output, /errors {8}1/);
});

test("JSON helpers stringify bigints and flag unhealthy summaries", () => {
  const event = toWatchEventJson({
    type: "advance",
    at: Date.UTC(2026, 10, 9, 12, 0, 3),
    blockNumber: 75_416_693n,
    delta: 1n,
    gasPriceWei: BASE_GAS,
    latencyMs: 40,
  });
  assert.equal(event.at, "2026-11-09T12:00:03.000Z");
  assert.equal(event.blockNumber, "75416693");
  assert.equal(event.delta, "1");
  assert.equal(event.gasPriceWei, "21000000");

  const healthy = toWatchSummaryJson({
    samples: 4,
    errors: 0,
    firstBlock: 100n,
    lastBlock: 104n,
    advancedBy: 4n,
    chainDrift: false,
    stalls: 0,
    gasSurges: 0,
    alerts: 0,
    lastGasWei: BASE_GAS,
    peakGasWei: BASE_GAS,
    metrics: metricsLiteral(),
    session: sessionLiteral(),
    durationMs: 9000,
    aborted: false,
    portfolio: null,
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.advancedBy, "4");
  assert.equal(healthy.lastGasWei, "21000000");
  assert.equal((healthy.session as { polls: number }).polls, 342);

  const surging = toWatchSummaryJson({
    samples: 4,
    errors: 0,
    firstBlock: 100n,
    lastBlock: 104n,
    advancedBy: 4n,
    chainDrift: false,
    stalls: 0,
    gasSurges: 1,
    alerts: 0,
    lastGasWei: 60_000_000n,
    peakGasWei: 60_000_000n,
    metrics: metricsLiteral(),
    session: sessionLiteral(),
    durationMs: 9000,
    aborted: false,
    portfolio: null,
  });
  assert.equal(surging.ok, false);
  assert.equal(surging.gasSurges, 1);
});
