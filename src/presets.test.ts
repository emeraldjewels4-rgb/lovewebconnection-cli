import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicClient } from "viem";

import { CHAIN_PRESETS, type ChainConfig } from "./chain.ts";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  PresetsArgError,
  formatPresets,
  parsePresetsArgs,
  probePresets,
  toPresetsJson,
  type PresetsReport,
} from "./presets.ts";

function healthyClient(chainId: number, blockNumber = 42n): PublicClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => blockNumber,
    getGasPrice: async () => 1_000_000_000n,
    request: async () => "test/v1.0.0",
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as PublicClient;
}

function failingClient(message: string): PublicClient {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    getChainId: fail,
    getBlockNumber: fail,
    getGasPrice: fail,
    request: fail,
    getBlock: fail,
  } as unknown as PublicClient;
}

test("probes every built-in preset and reports each one healthy", async () => {
  const report = await probePresets({
    clientFor: (config: ChainConfig) => healthyClient(config.chainId),
  });

  assert.equal(report.total, Object.keys(CHAIN_PRESETS).length);
  assert.equal(report.healthy, report.total);
  assert.equal(report.failed, 0);
  assert.deepEqual(
    report.endpoints.map((endpoint) => endpoint.preset),
    Object.keys(CHAIN_PRESETS).sort(),
    "results are sorted by preset name",
  );
  for (const endpoint of report.endpoints) {
    assert.equal(endpoint.ok, true, endpoint.preset);
    assert.equal(endpoint.error, null);
    assert.equal(endpoint.blockNumber, 42n);
    assert.equal(typeof endpoint.latencyMs, "number");
    assert.equal(endpoint.chainId, CHAIN_PRESETS[endpoint.preset]?.chainId);
  }

  const polygon = report.endpoints.find((endpoint) => endpoint.preset === "polygon");
  assert.equal(polygon?.nativeSymbol, "POL");
});

/**
 * Every call rejects, as a dead endpoint does. All of them must be handled: an
 * unhandled rejection here would crash the process instead of reporting health.
 */
test("one failing endpoint does not stop the others", async () => {
  const report = await probePresets({
    clientFor: (config: ChainConfig) =>
      config.preset === "base"
        ? failingClient("timeout after 10000 ms")
        : healthyClient(config.chainId),
  });

  assert.equal(report.failed, 1);
  assert.equal(report.healthy, report.total - 1);

  const base = report.endpoints.find((endpoint) => endpoint.preset === "base");
  assert.equal(base?.ok, false);
  assert.equal(base?.error, "timeout after 10000 ms");
  assert.equal(base?.latencyMs, null);
  assert.equal(base?.blockNumber, null);
  assert.equal(base?.chainId, 8453, "a failed probe still identifies the chain");

  assert.ok(report.endpoints.some((endpoint) => endpoint.ok && endpoint.preset !== "base"));
});

test("a chain id mismatch is reported as one", async () => {
  const report = await probePresets({
    clientFor: (config: ChainConfig) => healthyClient(config.chainId + 1),
    presets: { base: CHAIN_PRESETS.base! },
  });

  assert.equal(report.total, 1);
  assert.equal(report.failed, 1);
  assert.match(report.endpoints[0]?.error ?? "", /^chain mismatch:/);
  assert.match(report.endpoints[0]?.error ?? "", /answered chainId 8454/);
});

test("the table names every preset and summarizes health", () => {
  const report: PresetsReport = {
    total: 2,
    healthy: 1,
    failed: 1,
    endpoints: [
      {
        preset: "base",
        chainId: 8453,
        nativeSymbol: "ETH",
        rpcHost: "mainnet.base.org",
        ok: false,
        latencyMs: null,
        blockNumber: null,
        error: "rpc unavailable",
      },
      {
        preset: "xlayer",
        chainId: 196,
        nativeSymbol: "OKB",
        rpcHost: "xlayer.drpc.org",
        ok: true,
        latencyMs: 120,
        blockNumber: 12_345_678n,
        error: null,
      },
    ],
  };

  const text = formatPresets(report);
  assert.match(text, /^lwc — built-in presets/);
  assert.match(text, /xlayer\s+196\s+healthy\s+120 ms\s+12345678/);
  assert.match(text, /base\s+8453\s+failed/);
  assert.match(text, /base: rpc unavailable/);
  assert.match(text, /1 of 2 endpoints healthy/);
});

test("JSON keeps bigints as strings and failures as nulls", () => {
  const json = toPresetsJson({
    total: 2,
    healthy: 1,
    failed: 1,
    endpoints: [
      {
        preset: "xlayer",
        chainId: 196,
        nativeSymbol: "OKB",
        rpcHost: "xlayer.drpc.org",
        ok: true,
        latencyMs: 5,
        blockNumber: 12_345_678n,
        error: null,
      },
      {
        preset: "base",
        chainId: 8453,
        nativeSymbol: "ETH",
        rpcHost: "mainnet.base.org",
        ok: false,
        latencyMs: null,
        blockNumber: null,
        error: "boom",
      },
    ],
  });

  assert.equal(json.endpoints[0]?.blockNumber, "12345678");
  assert.equal(json.endpoints[1]?.blockNumber, null);
  assert.equal(json.endpoints[1]?.error, "boom");
  assert.equal(json.healthy, 1);
  assert.doesNotThrow(() => JSON.stringify(json));
});

test("parses --timeout in both forms and rejects bad values", () => {
  assert.equal(parsePresetsArgs([]).timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  assert.equal(parsePresetsArgs(["--json"]).timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  assert.equal(parsePresetsArgs(["--timeout", "5000"]).timeoutMs, 5000);
  assert.equal(parsePresetsArgs(["--timeout=500"]).timeoutMs, 500);

  for (const argv of [["--timeout"], ["--timeout", "0"], ["--timeout", "abc"], ["--timeout", "999999"], ["--chain", "base"]]) {
    assert.throws(
      () => parsePresetsArgs(argv),
      (error: unknown) => error instanceof PresetsArgError,
      argv.join(" "),
    );
  }
});
