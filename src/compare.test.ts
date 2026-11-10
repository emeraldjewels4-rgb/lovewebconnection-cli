import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicClient } from "viem";

import {
  CompareArgError,
  compareEndpoints,
  endpointAuthEnvName,
  formatCompare,
  parseCompareArgs,
  summarizeLatency,
  toCompareJson,
  toCompareLogRecord,
  type CompareEndpoint,
  type CompareReport,
} from "./compare.ts";
import type { ChainConfig } from "./chain.ts";

const config: ChainConfig = {
  chainId: 196,
  name: "xlayer",
  rpcUrl: "https://xlayer.drpc.org",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  authHeader: null,
  preset: "xlayer",
  timeoutMs: 15_000,
};

function endpoint(
  url: string,
  label: string | null = null,
  authHeader: string | null = null,
): CompareEndpoint {
  return { url, label, authHeader };
}

function expectArgError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof CompareArgError && pattern.test(error.message),
  );
}

function stubClient(options: {
  chainId?: number | Error;
  blocks: bigint[];
  delayMs?: number;
  clock?: { t: number };
  ageSeconds?: number;
}): PublicClient {
  let index = 0;
  return {
    getChainId: async () => {
      if (options.chainId instanceof Error) throw options.chainId;
      return options.chainId ?? 196;
    },
    getBlockNumber: async () => {
      const block = options.blocks[index];
      if (block === undefined) throw new Error("rpc unavailable");
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      index += 1;
      return block;
    },
    getBlock: async () => ({
      timestamp: BigInt(
        Math.floor((options.clock?.t ?? Date.now()) / 1000) - (options.ageSeconds ?? 0),
      ),
    }),
  } as unknown as PublicClient;
}

test("parses two endpoints with sampling options", () => {
  const args = parseCompareArgs([
    "https://a.example",
    "https://b.example",
    "--samples",
    "3",
    "--interval",
    "2",
  ]);

  assert.deepEqual(args.endpoints, [
    endpoint("https://a.example"),
    endpoint("https://b.example"),
  ]);
  assert.equal(args.samples, 3);
  assert.equal(args.intervalMs, 2000);

  const defaults = parseCompareArgs(["https://a.example", "https://b.example"]);
  assert.equal(defaults.samples, 5);
  assert.equal(defaults.intervalMs, 1000);
  assert.equal(defaults.logPath, null);
  assert.equal(defaults.logMaxBytes, 0);
});

test("parses compare logging flags", () => {
  const args = parseCompareArgs([
    "https://a.example",
    "https://b.example",
    "--log",
    "./compare.ndjson",
    "--log-max-size",
    "2kb",
  ]);
  assert.equal(args.logPath, "./compare.ndjson");
  assert.equal(args.logMaxBytes, 2048);

  const inline = parseCompareArgs([
    "https://a.example",
    "https://b.example",
    "--log=./other.ndjson",
    "--log-max-size=1mb",
  ]);
  assert.equal(inline.logPath, "./other.ndjson");
  assert.equal(inline.logMaxBytes, 1024 ** 2);

  expectArgError(
    () => parseCompareArgs(["https://a.example", "https://b.example", "--log-max-size", "1kb"]),
    /needs --log/,
  );
  expectArgError(
    () => parseCompareArgs(["https://a.example", "https://b.example", "--log="]),
    /requires a file path/,
  );
  expectArgError(
    () =>
      parseCompareArgs([
        "https://a.example",
        "https://b.example",
        "--log",
        "./c.ndjson",
        "--log-max-size",
        "huge",
      ]),
    /must look like/,
  );
});

test("parses labels and per-endpoint auth headers", () => {
  const args = parseCompareArgs([
    "drpc=https://a.example",
    "https://b.example",
    "--endpoint-auth",
    "drpc=Bearer one",
    "--endpoint-auth=https://b.example=Bearer two",
  ]);

  assert.deepEqual(args.endpoints, [
    endpoint("https://a.example", "drpc", "Bearer one"),
    endpoint("https://b.example", null, "Bearer two"),
  ]);
});

test("resolves per-endpoint auth from named environment variables", () => {
  const args = parseCompareArgs(
    [
      "drpc=https://a.example",
      "okx=https://b.example",
      "--endpoint-auth",
      "drpc=env:DRPC_AUTH",
    ],
    { DRPC_AUTH: "  Bearer from-env  " },
  );

  assert.deepEqual(args.endpoints, [
    endpoint("https://a.example", "drpc", "Bearer from-env"),
    endpoint("https://b.example", "okx"),
  ]);
});

test("picks up per-endpoint auth from label-based environment variables", () => {
  const args = parseCompareArgs(
    ["drpc=https://a.example", "my-node=https://b.example", "https://c.example"],
    {
      LWC_RPC_AUTH_DRPC: "  Bearer drpc-key  ",
      LWC_RPC_AUTH_MY_NODE: "Bearer node-key",
      LWC_RPC_AUTH_UNUSED: "Bearer unused",
    },
  );

  assert.deepEqual(args.endpoints, [
    endpoint("https://a.example", "drpc", "Bearer drpc-key"),
    endpoint("https://b.example", "my-node", "Bearer node-key"),
    endpoint("https://c.example"),
  ]);
  assert.equal(endpointAuthEnvName("drpc"), "LWC_RPC_AUTH_DRPC");
  assert.equal(endpointAuthEnvName("my-node"), "LWC_RPC_AUTH_MY_NODE");
  assert.equal(endpointAuthEnvName("a.b_c"), "LWC_RPC_AUTH_A_B_C");
});

test("an explicit endpoint header wins over the label variable", () => {
  const args = parseCompareArgs(
    [
      "drpc=https://a.example",
      "https://b.example",
      "--endpoint-auth",
      "drpc=Bearer explicit",
    ],
    { LWC_RPC_AUTH_DRPC: "Bearer automatic" },
  );

  assert.equal(args.endpoints[0]?.authHeader, "Bearer explicit");
});

test("ignores empty label variables and rejects multi-line ones", () => {
  const empty = parseCompareArgs(["drpc=https://a.example", "https://b.example"], {
    LWC_RPC_AUTH_DRPC: "   ",
  });
  assert.equal(empty.endpoints[0]?.authHeader, null, "an empty variable means no header");

  expectArgError(
    () =>
      parseCompareArgs(["drpc=https://a.example", "https://b.example"], {
        LWC_RPC_AUTH_DRPC: "Bearer x\ny",
      }),
    /LWC_RPC_AUTH_DRPC must be a single line/,
  );
});

test("rejects unresolved or malformed environment auth names", () => {
  expectArgError(
    () =>
      parseCompareArgs(
        [
          "https://a.example",
          "https://b.example",
          "--endpoint-auth",
          "https://a.example=env:MISSING_AUTH",
        ],
        {},
      ),
    /MISSING_AUTH.*unset or empty/,
  );
  expectArgError(
    () =>
      parseCompareArgs(
        [
          "https://a.example",
          "https://b.example",
          "--endpoint-auth",
          "https://a.example=env:NOT A NAME",
        ],
        { "NOT A NAME": "Bearer x" },
      ),
    /environment variable name/,
  );
  expectArgError(
    () =>
      parseCompareArgs(
        [
          "https://a.example",
          "https://b.example",
          "--endpoint-auth",
          "https://a.example=env:MULTI_LINE",
        ],
        { MULTI_LINE: "Bearer x\ny" },
      ),
    /single line/,
  );
});

test("leaves a URL containing = in its query intact", () => {
  const args = parseCompareArgs(["https://a.example/?x=1", "https://b.example"]);

  assert.equal(args.endpoints[0]?.url, "https://a.example/?x=1");
  assert.equal(args.endpoints[0]?.label, null);
});

test("rejects unusable endpoint lists", () => {
  expectArgError(() => parseCompareArgs(["https://a.example"]), /two RPC URLs are required/);
  expectArgError(
    () => parseCompareArgs(["https://a.example", "https://a.example"]),
    /same endpoint/,
  );
  expectArgError(() => parseCompareArgs(["https://a.example", "ftp://b.example"]), /http\(s\)/);
  expectArgError(() => parseCompareArgs(["a.example", "https://b.example"]), /not a valid URL/);
  expectArgError(
    () => parseCompareArgs(["https://a.example", "https://b.example", "--samples", "0"]),
    /--samples must be between/,
  );
  expectArgError(
    () => parseCompareArgs(["https://a.example", "https://b.example", "--interval"]),
    /requires a value/,
  );
});

test("rejects bad labels and auth specs", () => {
  expectArgError(
    () => parseCompareArgs(["a=https://x.example", "a=https://y.example"]),
    /labels must be unique/,
  );
  expectArgError(
    () => parseCompareArgs(["bad label=https://x.example", "https://y.example"]),
    /endpoint label "bad label"/,
  );
  expectArgError(
    () =>
      parseCompareArgs([
        "a=https://x.example",
        "https://y.example",
        "--endpoint-auth",
        "nokey",
      ]),
    /must look like/,
  );
  expectArgError(
    () =>
      parseCompareArgs([
        "a=https://x.example",
        "https://y.example",
        "--endpoint-auth",
        "zzz=Bearer x",
      ]),
    /matches no endpoint/,
  );
  expectArgError(
    () =>
      parseCompareArgs([
        "a=https://x.example",
        "https://y.example",
        "--endpoint-auth",
        "a=Bearer x\ny",
      ]),
    /single line/,
  );
  expectArgError(
    () =>
      parseCompareArgs([
        "a=https://x.example",
        "https://y.example",
        "--endpoint-auth",
        "a=Bearer x",
        "--endpoint-auth",
        "a=Bearer y",
      ]),
    /given twice/,
  );
});

test("summarizeLatency uses nearest-rank percentiles", () => {
  const summary = summarizeLatency([100, 200, 300, 400, 1000]);

  assert.equal(summary.p50, 300);
  assert.equal(summary.p95, 1000);
  assert.equal(summary.min, 100);
  assert.equal(summary.max, 1000);
  assert.equal(summary.mean, 400);
  assert.deepEqual(summarizeLatency([]), { p50: 0, p95: 0, min: 0, max: 0, mean: 0 });
});

test("compareEndpoints reports latency and head freshness per endpoint", async () => {
  const clients: Record<string, PublicClient> = {
    "https://fast.example": stubClient({ blocks: [100n, 101n, 102n], delayMs: 40 }),
    "https://slow.example": stubClient({ blocks: [98n, 99n, 100n], delayMs: 160 }),
  };

  const report = await compareEndpoints(
    config,
    {
      endpoints: [endpoint("https://fast.example"), endpoint("https://slow.example")],
      samples: 3,
      intervalMs: 10,
      logPath: null,
      logMaxBytes: 0,
    },
    { clientFor: (target) => clients[target.rpcUrl] as PublicClient, sleep: async () => {} },
  );

  const [fast, slow] = report.endpoints;
  assert.ok(
    (fast?.latency.p50 ?? 999) < (slow?.latency.p50 ?? 0),
    `fast ${fast?.latency.p50}ms should beat slow ${slow?.latency.p50}ms`,
  );
  assert.ok((fast?.latency.p50 ?? 0) >= 30, "each round trip is actually measured");
  assert.ok((slow?.latency.p50 ?? 0) >= 120, "slow endpoint reflects its own delay");
  assert.equal(fast?.head, 102n);
  assert.equal(slow?.head, 100n);
  assert.equal(fast?.headLag, 0);
  assert.equal(slow?.headLag, 2, "slow endpoint is two blocks behind at the end");
  assert.equal(slow?.roundsBehind, 3, "behind in every round");
  assert.equal(report.fastest, "https://fast.example");
  assert.equal(report.freshest, "https://fast.example");
  assert.ok(report.endpoints.every((entry) => entry.ok));
  assert.equal(report.newBlocks, 2);
  assert.equal(fast?.delivery.wins, 2);
  assert.equal(fast?.delivery.p50Ms, 0);
  assert.equal(slow?.delivery.observed, 0);
  assert.equal(slow?.delivery.misses, 2);
  assert.equal(slow?.delivery.p50Ms, null);
});

test("measures which endpoint delivers a new head first", async () => {
  // Simulated latency on a shared clock rather than real timers. The fast client
  // answers at the current tick; the slow one yields once, so the caller has
  // already recorded its start time, then advances the clock by its delay. The
  // measured gap is therefore exactly the delay, no matter how loaded or slow
  // the machine is — the old version slept on setTimeout and failed whenever
  // parallel test execution compressed the 80ms gap.
  const clock = { t: 1_000 };
  const client = (blocks: bigint[], delayMs: number): PublicClient => {
    let index = 0;
    return {
      getChainId: async () => 196,
      getBlockNumber: async () => {
        const block = blocks[index];
        if (block === undefined) throw new Error("rpc unavailable");
        if (delayMs > 0) {
          await Promise.resolve();
          clock.t += delayMs;
        }
        index += 1;
        return block;
      },
      getBlock: async () => ({ timestamp: BigInt(Math.floor(clock.t / 1000)) }),
    } as unknown as PublicClient;
  };

  const clients: Record<string, PublicClient> = {
    "https://quick.example": client([100n, 101n], 0),
    "https://slow.example": client([100n, 101n], 80),
  };

  const report = await compareEndpoints(
    config,
    {
      endpoints: [endpoint("https://quick.example"), endpoint("https://slow.example")],
      samples: 2,
      intervalMs: 10,
      logPath: null,
      logMaxBytes: 0,
    },
    {
      clientFor: (target) => clients[target.rpcUrl] as PublicClient,
      sleep: async () => {},
      now: () => clock.t,
    },
  );

  const [quick, slow] = report.endpoints;
  assert.equal(report.newBlocks, 1);
  assert.equal(quick?.delivery.wins, 1);
  assert.equal(quick?.delivery.observed, 1);
  assert.equal(quick?.delivery.p50Ms, 0);
  assert.equal(slow?.delivery.wins, 0);
  assert.equal(slow?.delivery.observed, 1);
  assert.equal(slow?.delivery.misses, 0);
  assert.ok(
    (slow?.delivery.p50Ms ?? 0) >= 40,
    `slow endpoint delay ${slow?.delivery.p50Ms}ms should follow the quick one`,
  );
});

test("passes labels and per-endpoint auth headers to clients", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const clients: Record<string, PublicClient> = {
    "https://a.example": stubClient({ blocks: [10n] }),
    "https://b.example": stubClient({ blocks: [10n] }),
  };

  const report = await compareEndpoints(
    { ...config, authHeader: "Bearer global" },
    {
      endpoints: [
        endpoint("https://a.example", "alpha", "Bearer key-a"),
        endpoint("https://b.example", "beta"),
      ],
      samples: 1,
      intervalMs: 10,
      logPath: null,
      logMaxBytes: 0,
    },
    {
      clientFor: (target) => {
        seen.push({ url: target.rpcUrl, auth: target.authHeader });
        return clients[target.rpcUrl] as PublicClient;
      },
      sleep: async () => {},
    },
  );

  assert.deepEqual(seen, [
    { url: "https://a.example", auth: "Bearer key-a" },
    { url: "https://b.example", auth: "Bearer global" },
  ]);
  assert.deepEqual(
    report.endpoints.map((entry) => entry.label),
    ["alpha", "beta"],
  );
});

test("a wrong chain and an unreachable endpoint are both flagged", async () => {
  const clock = { t: 5_000_000 };
  const clients: Record<string, PublicClient> = {
    "https://good.example": stubClient({ blocks: [10n, 11n], delayMs: 20, clock }),
    "https://wrong-chain.example": stubClient({
      blocks: [10n, 11n],
      delayMs: 20,
      clock,
      chainId: 1,
    }),
    "https://dead.example": stubClient({ blocks: [], clock }),
  };

  const report = await compareEndpoints(
    config,
    {
      endpoints: [
        endpoint("https://good.example"),
        endpoint("https://wrong-chain.example"),
        endpoint("https://dead.example"),
      ],
      samples: 2,
      intervalMs: 1000,
      logPath: null,
      logMaxBytes: 0,
    },
    {
      clientFor: (target) => clients[target.rpcUrl] as PublicClient,
      now: () => clock.t,
      sleep: async () => {},
    },
  );

  const [good, wrong, dead] = report.endpoints;
  assert.equal(good?.ok, true);
  assert.equal(wrong?.chainMismatch, true);
  assert.equal(wrong?.chainId, 1);
  assert.equal(wrong?.ok, false);
  assert.equal(dead?.errors, 2);
  assert.equal(dead?.head, null);
  assert.equal(dead?.ok, false);
  assert.match(dead?.error ?? "", /rpc unavailable/);
});

function sampleReport(): CompareReport {
  return {
    chainId: 196,
    chainName: "xlayer",
    samples: 4,
    intervalMs: 1000,
    newBlocks: 3,
    fastest: "https://fast.example",
    freshest: "https://fresh.example",
    endpoints: [
      {
        url: "https://fast.example",
        label: null,
        ok: true,
        samples: 4,
        errors: 0,
        latency: { p50: 120, p95: 400, min: 100, max: 400, mean: 180 },
        delivery: { wins: 2, observed: 3, misses: 0, p50Ms: 12, p95Ms: 20 },
        head: 75419100n,
        headLag: 3,
        roundsBehind: 4,
        headAgeSeconds: 9,
        chainId: 196,
        chainMismatch: false,
        error: null,
      },
      {
        url: "https://fresh.example",
        label: null,
        ok: true,
        samples: 4,
        errors: 0,
        latency: { p50: 300, p95: 350, min: 280, max: 350, mean: 305 },
        delivery: { wins: 1, observed: 3, misses: 0, p50Ms: 0, p95Ms: 30 },
        head: 75419103n,
        headLag: 0,
        roundsBehind: 0,
        headAgeSeconds: 2,
        chainId: 196,
        chainMismatch: false,
        error: null,
      },
    ],
  };
}

test("format shows latency, lag, and the winners", () => {
  const text = formatCompare(sampleReport());

  assert.match(text, /p50/);
  assert.match(text, /new blocks\s+3/);
  assert.match(text, /https:\/\/fast\.example\s+120ms\s+400ms\s+75419100\s+3\s+4\/4\s+2\s+12ms\s+9s\s+0/);
  assert.match(text, /fastest {7}https:\/\/fast\.example \(p50 120 ms\)/);
  assert.match(text, /freshest {6}https:\/\/fresh\.example \(head 75419103\)/);
});

test("format uses labels when the endpoints are named", () => {
  const report = sampleReport();
  report.endpoints[0]!.label = "drpc";
  report.endpoints[1]!.label = "okx";

  const text = formatCompare(report);

  assert.match(text, /drpc\s+120ms\s+400ms/);
  assert.match(text, /okx\s+300ms\s+350ms/);
  assert.match(text, /fastest {7}drpc \(p50 120 ms\)/);
  assert.match(text, /freshest {6}okx \(head 75419103\)/);
});

test("compare log records the winner with sanitised URLs", () => {
  const report = sampleReport();
  report.fastest = "https://fast.example/rpc?api_key=SECRET";
  report.endpoints[0]!.url = "https://fast.example/rpc?api_key=SECRET";
  report.endpoints[0]!.label = "drpc";
  report.endpoints[0]!.error =
    "request to https://fast.example/rpc?api_key=SECRET failed";

  const record = toCompareLogRecord(
    report,
    "sess-1",
    Date.parse("2026-11-09T12:00:00.000Z"),
  ) as {
    session: string;
    event: string;
    at: string;
    fastest: string;
    freshest: string;
    newBlocks: number;
    endpoints: Array<{
      url: string;
      label: string | null;
      p50: number;
      head: string | null;
      error: string | null;
      delivery: { wins: number; observed: number };
    }>;
  };

  assert.equal(record.session, "sess-1");
  assert.equal(record.event, "compare");
  assert.equal(record.at, "2026-11-09T12:00:00.000Z");
  assert.equal(record.fastest, "https://fast.example/rpc");
  assert.equal(record.freshest, "https://fresh.example");
  assert.equal(record.newBlocks, 3);
  assert.equal(record.endpoints[0]?.delivery.wins, 2);
  assert.equal(record.endpoints[0]?.url, "https://fast.example/rpc");
  assert.equal(record.endpoints[0]?.label, "drpc");
  assert.equal(record.endpoints[0]?.p50, 120);
  assert.equal(record.endpoints[0]?.head, "75419100");
  assert.equal(
    record.endpoints[0]?.error,
    "request to https://fast.example/rpc failed",
  );
  assert.equal(record.endpoints[1]?.p50, 300);
  assert.doesNotMatch(JSON.stringify(record), /SECRET/);
});

test("JSON keeps bigints as strings and exposes labels and the verdict", () => {
  const report = sampleReport();
  report.endpoints[0]!.label = "drpc";
  const json = toCompareJson(report) as {
    ok: boolean;
    freshest: string;
    newBlocks: number;
    endpoints: Array<{
      head: string;
      label: string | null;
      headLag: number;
      latency: { p50: number };
      delivery: { wins: number; observed: number; misses: number };
    }>;
  };

  assert.equal(json.ok, true);
  assert.equal(json.freshest, "https://fresh.example");
  assert.equal(json.newBlocks, 3);
  assert.equal(json.endpoints[0]?.head, "75419100");
  assert.equal(json.endpoints[0]?.delivery.wins, 2);
  assert.equal(json.endpoints[0]?.label, "drpc");
  assert.equal(json.endpoints[1]?.label, null);
  assert.equal(json.endpoints[1]?.latency.p50, 300);
});
