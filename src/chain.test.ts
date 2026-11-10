import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicClient } from "viem";

import {
  CHAIN_PRESETS,
  ChainConfigError,
  buildClient,
  connectionWarnings,
  formatHealth,
  parseChainConfig,
  probeWithFallback,
  publicEndpoint,
  toJsonPayload,
  type ChainHealth,
} from "./chain.ts";

const validEnv = {
  LWC_CHAIN_ID: "8453",
  LWC_RPC_URL: "https://mainnet.base.org",
};

function expectConfigError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof ChainConfigError && pattern.test(error.message),
  );
}

test("publicEndpoint keeps the provider host and drops credentials", () => {
  assert.equal(publicEndpoint("https://xlayer.drpc.org"), "https://xlayer.drpc.org");
  assert.equal(
    publicEndpoint("https://user:pass@rpc.example.org/key?apikey=secret#frag"),
    "https://rpc.example.org/key",
  );
  assert.equal(
    publicEndpoint("https://rpc.example.org/v2/SECRETKEY123456789012345678901234"),
    "https://rpc.example.org/v2/<redacted>",
  );
  assert.equal(publicEndpoint("http://127.0.0.1:8545"), "http://127.0.0.1:8545");
  assert.equal(publicEndpoint("not a url"), "<invalid>");
});

test("parses a minimal config and applies defaults", () => {
  const config = parseChainConfig(validEnv);

  assert.equal(config.chainId, 8453);
  assert.equal(config.rpcUrl, "https://mainnet.base.org");
  assert.equal(config.name, "lwc-8453");
  assert.equal(config.nativeCurrency.symbol, "ETH");
  assert.equal(config.nativeCurrency.decimals, 18);
  assert.equal(config.authHeader, null);
  assert.equal(config.timeoutMs, 10_000);
});

test("resolves built-in chain presets", () => {
  const xlayer = parseChainConfig({}, "xlayer");
  assert.equal(xlayer.chainId, 196);
  assert.equal(xlayer.name, "xlayer");
  assert.equal(xlayer.rpcUrl, "https://xlayer.drpc.org");
  assert.equal(xlayer.nativeCurrency.symbol, "OKB");
  assert.equal(xlayer.preset, "xlayer");

  const base = parseChainConfig({ LWC_CHAIN: "base" });
  assert.equal(base.chainId, 8453);
  assert.equal(base.name, "base");
  assert.equal(base.rpcUrl, "https://mainnet.base.org");
  assert.equal(base.nativeCurrency.symbol, "ETH");
  assert.equal(base.preset, "base");
});

test("resolves the extended chain presets", () => {
  const cases = [
    ["ethereum", 1, "ETH", "https://ethereum-rpc.publicnode.com"],
    ["arbitrum", 42_161, "ETH", "https://arb1.arbitrum.io/rpc"],
    ["optimism", 10, "ETH", "https://mainnet.optimism.io"],
    ["polygon", 137, "POL", "https://polygon-bor-rpc.publicnode.com"],
  ] as const;

  for (const [selector, chainId, symbol, rpcUrl] of cases) {
    const byName = parseChainConfig({}, selector);
    assert.equal(byName.chainId, chainId, selector);
    assert.equal(byName.preset, selector);
    assert.equal(byName.name, selector);
    assert.equal(byName.nativeCurrency.symbol, symbol, selector);
    assert.equal(byName.rpcUrl, rpcUrl, selector);

    const byId = parseChainConfig({}, String(chainId));
    assert.equal(byId.preset, selector, `${chainId} resolves to ${selector}`);
  }
});

test("the preset table stays internally consistent", () => {
  const presets = Object.entries(CHAIN_PRESETS);
  assert.ok(presets.length >= 6, "the extended presets are registered");

  const ids = new Set(presets.map(([, preset]) => preset.chainId));
  const names = new Set(presets.map(([, preset]) => preset.name));
  assert.equal(ids.size, presets.length, "every chain id is unique");
  assert.equal(names.size, presets.length, "every name is unique");

  for (const [key, preset] of presets) {
    assert.equal(preset.name, key, `${key} key and name agree`);
    assert.match(preset.rpcUrl, /^https:\/\//, `${key} uses https`);
    assert.match(preset.fallbackRpcUrl, /^https:\/\//, `${key} backup uses https`);
    assert.notEqual(
      preset.fallbackRpcUrl,
      preset.rpcUrl,
      `${key} backup differs from the primary`,
    );
    assert.notEqual(
      new URL(preset.fallbackRpcUrl).host,
      new URL(preset.rpcUrl).host,
      `${key} backup is a different host`,
    );
    assert.match(preset.nativeSymbol, /^[A-Z0-9]{2,6}$/, `${key} has a plain symbol`);
  }
});

test("accepts a preset chain id as the selector", () => {
  const config = parseChainConfig({}, "196");

  assert.equal(config.chainId, 196);
  assert.equal(config.preset, "xlayer");
  assert.equal(config.name, "xlayer");
});

test("lets env values override preset defaults", () => {
  const config = parseChainConfig({
    LWC_CHAIN: "xlayer",
    LWC_CHAIN_ID: "196",
    LWC_RPC_URL: "https://rpc.example.org",
    LWC_CHAIN_NAME: "xlayer-private",
    LWC_NATIVE_SYMBOL: "USDT",
  });

  assert.equal(config.chainId, 196);
  assert.equal(config.rpcUrl, "https://rpc.example.org");
  assert.equal(config.name, "xlayer-private");
  assert.equal(config.nativeCurrency.symbol, "USDT");
  assert.equal(config.preset, "xlayer");
});

test("the --chain selector wins over LWC_CHAIN", () => {
  const config = parseChainConfig({ LWC_CHAIN: "base" }, "xlayer");

  assert.equal(config.chainId, 196);
  assert.equal(config.preset, "xlayer");
  assert.equal(config.rpcUrl, "https://xlayer.drpc.org");
});

test("an explicit preset ignores env values configured for another chain", () => {
  const config = parseChainConfig(
    {
      LWC_CHAIN: "xlayer",
      LWC_CHAIN_ID: "196",
      LWC_RPC_URL: "https://xlayer.example.org",
      LWC_CHAIN_NAME: "xlayer-renamed",
      LWC_NATIVE_SYMBOL: "USDT",
    },
    "base",
  );

  assert.equal(config.chainId, 8453);
  assert.equal(config.rpcUrl, "https://mainnet.base.org");
  assert.equal(config.name, "base");
  assert.equal(config.nativeCurrency.symbol, "ETH");
});

test("an explicit preset still uses an endpoint for the same chain", () => {
  const config = parseChainConfig(
    { LWC_CHAIN_ID: "196", LWC_RPC_URL: "https://xlayer.example.org" },
    "xlayer",
  );

  assert.equal(config.chainId, 196);
  assert.equal(config.rpcUrl, "https://xlayer.example.org");
});

test("keeps supporting fully custom chains", () => {
  const byEnv = parseChainConfig({
    LWC_CHAIN_ID: "1",
    LWC_RPC_URL: "https://eth.example.org",
  });
  assert.equal(byEnv.chainId, 1);
  assert.equal(byEnv.preset, null);
  assert.equal(byEnv.name, "lwc-1");

  // 999 is deliberately not a preset: preset ids (1, 10, 137, 8453, 42161)
  // resolve to a preset and are covered above.
  const byId = parseChainConfig({
    LWC_CHAIN: "999",
    LWC_RPC_URL: "https://arb.example.org",
  });
  assert.equal(byId.chainId, 999);
  assert.equal(byId.preset, null);
  assert.equal(byId.nativeCurrency.symbol, "ETH");
});

test("rejects an unknown preset, a conflicting chain id, and a presetless rpc", () => {
  expectConfigError(
    () => parseChainConfig({ LWC_CHAIN: "solana" }),
    /unknown chain "solana".*xlayer, base, ethereum, arbitrum, optimism, polygon/s,
  );
  expectConfigError(
    () => parseChainConfig({ LWC_CHAIN: "xlayer", LWC_CHAIN_ID: "8453" }),
    /LWC_CHAIN is xlayer \(196\), but LWC_CHAIN_ID is 8453/,
  );
  expectConfigError(
    () => parseChainConfig({ LWC_CHAIN: "999" }),
    /LWC_RPC_URL is required for a custom chain/,
  );
});

test("honours explicit name, symbol, auth header, and timeout", () => {
  const config = parseChainConfig({
    ...validEnv,
    LWC_CHAIN_NAME: "base",
    LWC_NATIVE_SYMBOL: "USDC",
    LWC_RPC_AUTH: "Bearer test-token",
    LWC_TIMEOUT_MS: "2500",
  });

  assert.equal(config.name, "base");
  assert.equal(config.nativeCurrency.symbol, "USDC");
  assert.equal(config.authHeader, "Bearer test-token");
  assert.equal(config.timeoutMs, 2500);
});

test("rejects missing chain id and rpc url", () => {
  expectConfigError(() => parseChainConfig({}), /LWC_CHAIN_ID is required/);
  expectConfigError(
    () => parseChainConfig({ LWC_CHAIN_ID: "1" }),
    /LWC_RPC_URL is required/,
  );
  expectConfigError(
    () => parseChainConfig({ ...validEnv, LWC_RPC_URL: "   " }),
    /LWC_RPC_URL is required/,
  );
});

test("rejects non-numeric and out-of-range chain ids", () => {
  for (const value of ["abc", "0x2105", "-1", "1.5", "0"]) {
    expectConfigError(
      () => parseChainConfig({ ...validEnv, LWC_CHAIN_ID: value }),
      /LWC_CHAIN_ID/,
    );
  }
  expectConfigError(
    () => parseChainConfig({ ...validEnv, LWC_CHAIN_ID: "99999999999999999999" }),
    /LWC_CHAIN_ID/,
  );
});

test("rejects malformed urls and unsupported protocols", () => {
  expectConfigError(
    () => parseChainConfig({ ...validEnv, LWC_RPC_URL: "not a url" }),
    /not a valid URL/,
  );
  expectConfigError(
    () => parseChainConfig({ ...validEnv, LWC_RPC_URL: "ws://rpc.example.org" }),
    /must use http or https/,
  );
  expectConfigError(
    () => parseChainConfig({ ...validEnv, LWC_RPC_URL: "file:///etc/passwd" }),
    /must use http or https/,
  );
});

test("rejects multi-line auth headers", () => {
  expectConfigError(
    () => parseChainConfig({ ...validEnv, LWC_RPC_AUTH: "Bearer a\r\nX-Other: b" }),
    /single line/,
  );
});

test("rejects out-of-range timeouts", () => {
  for (const value of ["10", "0", "999999", "soon"]) {
    expectConfigError(
      () => parseChainConfig({ ...validEnv, LWC_TIMEOUT_MS: value }),
      /LWC_TIMEOUT_MS/,
    );
  }
});

test("warns about plaintext http to a remote host", () => {
  const config = parseChainConfig({ ...validEnv, LWC_RPC_URL: "http://rpc.example.org" });
  const warnings = connectionWarnings(config);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /plaintext http/);
});

test("does not warn about https or loopback http", () => {
  assert.deepEqual(connectionWarnings(parseChainConfig(validEnv)), []);
  assert.deepEqual(
    connectionWarnings(
      parseChainConfig({ ...validEnv, LWC_RPC_URL: "http://127.0.0.1:8545" }),
    ),
    [],
  );
  assert.deepEqual(
    connectionWarnings(
      parseChainConfig({ ...validEnv, LWC_RPC_URL: "http://localhost:8545" }),
    ),
    [],
  );
});

test("warns when an auth header is configured", () => {
  const config = parseChainConfig({ ...validEnv, LWC_RPC_AUTH: "Bearer t" });

  assert.ok(connectionWarnings(config).some((w) => /LWC_RPC_AUTH/.test(w)));
});

test("buildClient binds the client to the configured chain", () => {
  const config = parseChainConfig(validEnv);
  const client = buildClient(config);

  assert.equal(client.chain?.id, 8453);
  assert.equal(client.chain?.name, "lwc-8453");
});

const health: ChainHealth = {
  chainId: 8453,
  expectedChainId: 8453,
  blockNumber: 12_345_678n,
  blockTimestamp: 1_793_879_400n,
  blockAgeSeconds: 125,
  gasPriceWei: 20_000_000n,
  clientVersion: "Geth/v1.14.0",
  latencyMs: 84,
  rpcHost: "mainnet.base.org",
};

test("formatHealth renders the connection summary", () => {
  const output = formatHealth(health, parseChainConfig(validEnv));

  assert.match(output, /status {8}connected/);
  assert.match(output, /chain {9}lwc-8453 \(8453\)/);
  assert.match(output, /rpc {11}mainnet\.base\.org/);
  assert.match(output, /block {9}12345678 \(2m old\)/);
  assert.match(output, /gas {11}0\.02 gwei/);
  assert.match(output, /latency {7}84 ms/);
});

test("formatHealth handles a missing gas price and appends warnings", () => {
  const output = formatHealth(
    { ...health, gasPriceWei: null, clientVersion: null },
    parseChainConfig(validEnv),
    ["endpoint is plaintext"],
  );

  assert.match(output, /gas {11}unavailable/);
  assert.match(output, /client {8}unavailable/);
  assert.match(output, /warning: endpoint is plaintext/);
});

test("toJsonPayload stringifies bigints and redacts the auth header", () => {
  const config = parseChainConfig({ ...validEnv, LWC_RPC_AUTH: "Bearer secret" });
  const payload = toJsonPayload(health, config, []);

  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("Bearer secret"));
  assert.match(serialized, /"blockNumber":"12345678"/);
  assert.match(serialized, /"gasPriceWei":"20000000"/);
  assert.match(serialized, /"auth":"configured"/);
  assert.match(serialized, /"preset":null/);
});

test("toJsonPayload names the preset in use", () => {
  const payload = toJsonPayload(health, parseChainConfig({ LWC_CHAIN: "base" }), []);

  assert.match(JSON.stringify(payload), /"preset":"base"/);
});

function stubClient(options: { chainId?: number; error?: string } = {}): PublicClient {
  if (options.error !== undefined) {
    const message = options.error;
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

  return {
    getChainId: async () => options.chainId ?? 8453,
    getBlockNumber: async () => 100n,
    getGasPrice: async () => 1_000_000_000n,
    request: async () => "test/v1",
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as PublicClient;
}

test("a preset config carries its backup endpoint", () => {
  const base = parseChainConfig({ LWC_CHAIN: "base" });
  assert.equal(base.rpcUrl, "https://mainnet.base.org");
  assert.equal(base.fallbackRpcUrl, "https://base-rpc.publicnode.com");

  const custom = parseChainConfig({ ...validEnv });
  assert.equal(custom.fallbackRpcUrl, null, "a custom chain has no backup");
});

test("a preset keeps its backup when the endpoint is overridden", () => {
  const overridden = parseChainConfig({
    LWC_CHAIN: "base",
    LWC_RPC_URL: "https://rpc.example.org",
  });
  assert.equal(overridden.rpcUrl, "https://rpc.example.org");
  assert.equal(overridden.fallbackRpcUrl, "https://base-rpc.publicnode.com");

  const same = parseChainConfig({
    LWC_CHAIN: "base",
    LWC_RPC_URL: "https://base-rpc.publicnode.com",
  });
  assert.equal(same.fallbackRpcUrl, null, "a backup never repeats the primary");
});

test("probeWithFallback reports the primary when it answers", async () => {
  const config = parseChainConfig({ LWC_CHAIN: "base" });
  const outcome = await probeWithFallback(() => stubClient(), config);

  assert.equal(outcome.usedFallback, false);
  assert.equal(outcome.primaryError, null);
  assert.equal(outcome.primaryEndpoint, null);
  assert.equal(outcome.config.rpcUrl, "https://mainnet.base.org");
  assert.equal(outcome.health.rpcHost, "mainnet.base.org");
  assert.equal(outcome.health.chainId, 8453);
});

test("probeWithFallback uses the preset's backup when the primary is unreachable", async () => {
  const config = parseChainConfig({ LWC_CHAIN: "base" });
  const tried: string[] = [];
  const outcome = await probeWithFallback((candidate) => {
    tried.push(candidate.rpcUrl);
    return candidate.rpcUrl === config.rpcUrl
      ? stubClient({ error: "connect ECONNREFUSED 127.0.0.1:443" })
      : stubClient();
  }, config);

  assert.deepEqual(tried, [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
  ]);
  assert.equal(outcome.usedFallback, true);
  assert.match(outcome.primaryError ?? "", /ECONNREFUSED/);
  assert.equal(outcome.primaryEndpoint, "https://mainnet.base.org");
  assert.equal(outcome.config.rpcUrl, "https://base-rpc.publicnode.com");
  assert.equal(outcome.health.rpcHost, "base-rpc.publicnode.com");
});

test("probeWithFallback fails over when the primary answers the wrong chain", async () => {
  const config = parseChainConfig({ LWC_CHAIN: "base" });
  const outcome = await probeWithFallback(
    (candidate) =>
      candidate.rpcUrl === config.rpcUrl ? stubClient({ chainId: 1 }) : stubClient(),
    config,
  );

  assert.equal(outcome.usedFallback, true);
  assert.match(outcome.primaryError ?? "", /answered chainId 1, but LWC_CHAIN_ID is 8453/);
});

test("probeWithFallback names both endpoints when neither answers", async () => {
  const config = parseChainConfig({ LWC_CHAIN: "base" });
  await assert.rejects(
    () => probeWithFallback(() => stubClient({ error: "socket hang up" }), config),
    (error: unknown) =>
      error instanceof ChainConfigError &&
      /both endpoints failed for base \(8453\)/.test(error.message) &&
      error.message.includes("https://mainnet.base.org") &&
      error.message.includes("https://base-rpc.publicnode.com"),
  );
});

test("probeWithFallback never sends a credential to the backup", async () => {
  const config = parseChainConfig({
    LWC_CHAIN: "base",
    LWC_RPC_AUTH: "Bearer paid-endpoint-key",
  });
  const tried: string[] = [];

  await assert.rejects(
    () =>
      probeWithFallback((candidate) => {
        tried.push(candidate.rpcUrl);
        return stubClient({ error: "connect ECONNREFUSED" });
      }, config),
    /ECONNREFUSED/,
  );
  assert.deepEqual(
    tried,
    ["https://mainnet.base.org"],
    "an authenticated endpoint is never bypassed for another operator",
  );
});

test("probeWithFallback keeps the original error when there is no backup", async () => {
  const config = parseChainConfig(validEnv);
  assert.equal(config.fallbackRpcUrl, null);

  await assert.rejects(
    () => probeWithFallback(() => stubClient({ error: "boom" }), config),
    /boom/,
  );
});

test("toJsonPayload records the endpoint that answered", () => {
  const config = parseChainConfig({ LWC_CHAIN: "base" });
  const payload = toJsonPayload(
    { ...health, rpcHost: "base-rpc.publicnode.com" },
    { ...config, rpcUrl: config.fallbackRpcUrl!, fallbackRpcUrl: null },
    [],
    {
      usedFallback: true,
      primaryEndpoint: "https://mainnet.base.org",
      primaryError: "timeout",
    },
  ) as { rpc: Record<string, unknown> };

  assert.equal(payload.rpc.host, "base-rpc.publicnode.com");
  assert.equal(payload.rpc.usedFallback, true);
  assert.equal(payload.rpc.primaryHost, "https://mainnet.base.org");
  assert.equal(payload.rpc.primaryError, "timeout");
  assert.equal(payload.rpc.fallbackHost, null);
});
