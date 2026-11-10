import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MarketPool,
  type MarketConfig,
  fixedPrice,
  loadPoolFile,
  parseMarketArgs,
  savePoolFile,
} from "./market.ts";
import { MarketServer } from "./market-server.ts";

/** A flat 1:1 pool, 6 decimals on both sides, so amounts are exact. */
function flatConfig(): MarketConfig {
  const price = fixedPrice("1", 6, 6);
  return {
    baseSymbol: "ZPC",
    quoteSymbol: "AUD",
    baseDecimals: 6,
    quoteDecimals: 6,
    priceNum: price.num,
    priceDen: price.den,
    feeBps: 0,
  };
}

interface Running {
  server: MarketServer;
  base: string;
  path: string;
  pool: MarketPool;
}

/** Start a server worth exactly 1 AUD on an ephemeral port. */
async function start(
  corsOrigins: string[] = [],
  accessKey: string | null = null,
  rateLimitPerMinute?: number,
): Promise<Running> {
  const directory = mkdtempSync(join(tmpdir(), "lwc-api-"));
  const path = join(directory, "pool.json");
  const pool = MarketPool.create(flatConfig(), 1_000_000n);
  savePoolFile(path, pool);

  const server = new MarketServer(pool, path, {
    host: "127.0.0.1",
    port: 0,
    corsOrigins,
    accessKey,
    ...(rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute }),
  });
  const info = await server.listen();
  return { server, base: info.url, path, pool };
}

async function withServer(
  run: (ctx: Running) => Promise<void>,
  corsOrigins: string[] = [],
  accessKey: string | null = null,
  rateLimitPerMinute?: number,
): Promise<void> {
  const ctx = await start(corsOrigins, accessKey, rateLimitPerMinute);
  try {
    await run(ctx);
  } finally {
    await ctx.server.close();
  }
}

/** A raw request, because `fetch` may drop a forbidden `origin` header. */
function rawRequest(
  url: string,
  options: { method: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.headers,
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("reports the fixed price, liquidity and capacity", async () => {
  await withServer(async ({ base }) => {
    const health = (await fetch(`${base}/health`).then((response) => response.json())) as Record<
      string,
      unknown
    >;
    assert.equal(health.ok, true);
    assert.equal(health.price, "1");

    const market = (await fetch(`${base}/market`).then((response) => response.json())) as any;
    assert.equal(market.price.fixed, true);
    assert.equal(market.price.priceImpactBps, 0);
    assert.equal(market.liquidity.valueQuote, "1000000");
    assert.equal(market.capacity.maxBuyBase, "500000");
    assert.equal(market.volume.swaps, 0);
  });
});

test("answers a quote with human amounts at the fixed price", async () => {
  await withServer(async ({ base }) => {
    const quote = (await fetch(`${base}/quote?side=buy&amount=0.4`).then((response) =>
      response.json(),
    )) as any;

    assert.equal(quote.executable, true);
    assert.equal(quote.amountOutFormatted, "0.4");
    assert.equal(quote.inSymbol, "AUD");
    assert.equal(quote.outSymbol, "ZPC");
    assert.equal(quote.priceImpactBps, 0);
    assert.equal(quote.capacityAfter.maxBuyBase, quote.reservesAfter.base);
    assert.equal(quote.capacityAfter.payQuote, quote.reservesAfter.quote);
    assert.equal(quote.capacityAfter.maxBuyBase, "100000");
  });
});

test("a swap fills at the fixed price and is written to the pool file", async () => {
  await withServer(async ({ base, path }) => {
    const response = await fetch(`${base}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ side: "buy", amount: "0.4" }),
    });

    assert.equal(response.status, 201);
    const fill = (await response.json()) as any;
    assert.equal(fill.amountOutFormatted, "0.4");
    assert.equal(fill.priceImpactBps, 0);
    assert.equal(fill.state.volume.swaps, 1);
    // The response state is complete, so a page can re-render from it directly.
    assert.equal(fill.state.capacity.maxBuyBase, "100000");
    assert.equal(loadPoolFile(path).state().volumeQuote, 400_000n);
  });
});

test("refuses a swap the reserves cannot settle, and changes nothing", async () => {
  await withServer(async ({ base, path }) => {
    const response = await fetch(`${base}/swap`, {
      method: "POST",
      body: JSON.stringify({ side: "buy", amount: "5" }),
    });

    assert.equal(response.status, 422);
    const body = (await response.json()) as any;
    assert.equal(body.code, "insufficient-liquidity");
    assert.match(body.error, /cannot sell/);
    assert.equal(body.quote.executable, false);
    assert.match(body.quote.reason, /cannot sell 5 ZPC/);
    assert.equal(loadPoolFile(path).state().swaps, 0);
  });
});

test("rejects bad routes and bodies with JSON errors", async () => {
  await withServer(async ({ base }) => {
    const noSide = await fetch(`${base}/quote?amount=1`);
    assert.equal(noSide.status, 400);
    assert.match(((await noSide.json()) as any).error, /side must be buy or sell/);

    const missingAmount = await fetch(`${base}/quote?side=buy`);
    assert.equal(missingAmount.status, 400);

    const tooPrecise = await fetch(`${base}/swap`, {
      method: "POST",
      body: JSON.stringify({ side: "buy", amount: "1.1234567" }),
    });
    assert.equal(tooPrecise.status, 400);
    assert.match(((await tooPrecise.json()) as any).error, /at most 6 decimal places/);

    const badJson = await fetch(`${base}/swap`, { method: "POST", body: "{nope" });
    assert.equal(badJson.status, 400);

    const wrongMethod = await fetch(`${base}/swap`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");

    const unknown = await fetch(`${base}/nope`);
    assert.equal(unknown.status, 404);
    assert.match(((await unknown.json()) as any).error, /no route for GET \/nope/);
  });
});

test("only allows preflights from permitted origins", async () => {
  await withServer(async ({ base }) => {
    const allowed = await rawRequest(`${base}/quote?side=buy&amount=1`, {
      method: "OPTIONS",
      headers: { origin: "https://example.com", "access-control-request-method": "GET" },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers["access-control-allow-origin"], "https://example.com");
    assert.match(String(allowed.headers["access-control-allow-methods"]), /POST/);
    assert.match(String(allowed.headers["access-control-allow-headers"]), /x-market-key/);

    const denied = await rawRequest(`${base}/quote?side=buy&amount=1`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.test" },
    });
    assert.equal(denied.status, 204);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  }, ["https://example.com"]);
});

test("requires the access key on every route that touches the pool", async () => {
  const KEY = "test-key-1234";
  await withServer(async ({ base }) => {
    for (const path of ["/health", "/market", "/quote?side=buy&amount=1", "/nope"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 401, `${path} stays closed without a key`);
      assert.equal(((await response.json()) as any).code, "unauthorized");
    }

    const swap = await fetch(`${base}/swap`, {
      method: "POST",
      body: JSON.stringify({ side: "buy", amount: "0.4" }),
    });
    assert.equal(swap.status, 401);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200, "the page shell is where the key is entered");

    const header = await fetch(`${base}/market`, { headers: { "x-market-key": KEY } });
    assert.equal(header.status, 200);

    const bearer = await fetch(`${base}/quote?side=buy&amount=0.4`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    assert.equal(bearer.status, 200);

    const query = await fetch(`${base}/quote?side=buy&amount=0.4&key=${KEY}`);
    assert.equal(query.status, 200);

    const wrong = await fetch(`${base}/market`, { headers: { "x-market-key": "nope-nope" } });
    assert.equal(wrong.status, 401);
  }, [], KEY);
});

test("a keyed swap still fills and persists", async () => {
  const KEY = "test-key-1234";
  await withServer(async ({ base, path }) => {
    const response = await fetch(`${base}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-market-key": KEY },
      body: JSON.stringify({ side: "buy", amount: "0.4" }),
    });

    assert.equal(response.status, 201);
    assert.equal(((await response.json()) as any).state.volume.swaps, 1);
    assert.equal(loadPoolFile(path).state().volumeQuote, 400_000n);
  }, [], KEY);
});

test("slows a client down once it passes the rate limit", async () => {
  await withServer(async ({ base }) => {
    for (let index = 0; index < 2; index += 1) {
      assert.equal((await fetch(`${base}/health`)).status, 200);
    }

    const limited = await fetch(`${base}/health`);
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as any).code, "rate-limited");
    assert.match(String(limited.headers.get("retry-after")), /^\d+$/);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200, "the page shell is never rate limited");
  }, [], null, 2);
});

test("blocks a client that keeps guessing the key", async () => {
  await withServer(async ({ base }) => {
    for (let index = 0; index < 10; index += 1) {
      const wrong = await fetch(`${base}/health`, {
        headers: { "x-market-key": "wrong-key-0000" },
      });
      assert.equal(wrong.status, 401);
    }

    const blocked = await fetch(`${base}/health`, {
      headers: { "x-market-key": "right-key-1234" },
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as any).code, "too-many-attempts");

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200, "a blocked client can still reach the unlock form");
  }, [], "right-key-1234");
});

test("close stops the listener", async () => {
  const ctx = await start();
  assert.equal(ctx.server.listening, true);

  await ctx.server.close();
  assert.equal(ctx.server.listening, false);
  await assert.rejects(fetch(`${ctx.base}/health`));
});

test("serve flags parse and are validated", () => {
  const args = parseMarketArgs([
    "--pool",
    "p.json",
    "--serve",
    "--port",
    "9000",
    "--cors",
    "https://example.com",
  ]);    assert.deepEqual(args.serve, {
      host: "127.0.0.1",
      port: 9000,
      corsOrigins: ["https://example.com"],
      accessKey: null,
      rateLimitPerMinute: 120,
      limitsPath: "p.json.limits.json",
    });
    assert.equal(
      parseMarketArgs(["--pool", "p.json", "--serve", "--rate-limit", "30"]).serve
        ?.rateLimitPerMinute,
      30,
    );
    assert.throws(
      () => parseMarketArgs(["--pool", "p.json", "--rate-limit", "30"]),
      /only apply with --serve/,
    );
    assert.equal(
      parseMarketArgs(["--pool", "p.json", "--serve", "--api-key", "long-enough-key"])
        .serve?.accessKey,
      "long-enough-key",
    );
    assert.throws(
      () => parseMarketArgs(["--pool", "p.json", "--serve", "--api-key", "short"]),
      /at least 8 characters/,
    );
    assert.throws(
      () => parseMarketArgs(["--pool", "p.json", "--api-key", "long-enough-key"]),
      /only apply with --serve/,
    );
  assert.equal(args.operation.kind, "state");

  assert.throws(
    () => parseMarketArgs(["--pool", "p.json", "--port", "1"]),
    /only apply with --serve/,
  );
  assert.throws(
    () => parseMarketArgs(["--pool", "p.json", "--serve", "--buy", "1"]),
    /cannot be combined with a single operation/,
  );
  assert.throws(
    () => parseMarketArgs(["--pool", "p.json", "--serve", "--cors", "example.com"]),
    /http\(s\) origin/,
  );
  assert.throws(
    () => parseMarketArgs(["--pool", "p.json", "--serve", "--port", "70000"]),
    /at most 65535/,
  );
});

test("serves a self-contained swap page at the root", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const html = await response.text();
    assert.match(html, /<title>Swap<\/title>/);
    assert.match(html, /\/quote\?side=/);
    assert.match(html, /\/swap/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /id="unlock"/);
    assert.match(html, /id="max"/);
    assert.match(html, /id="liquidity-note"/);
    assert.match(html, /id="depth-after"/);
    assert.match(html, /id="net-flow"/);
    assert.match(html, /id="cover-warning"/);
    assert.match(html, /id="backing"/);
    assert.match(html, /x-market-key/);
    assert.match(html, /class="row"/);
    // Self-contained: no external script, style or font is fetched.
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    assert.doesNotMatch(html, /https?:\/\/[a-z]/i);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get("content-type") ?? "", /application\/json/);

    const favicon = await fetch(`${base}/favicon.ico`);
    assert.equal(favicon.status, 204);
  });
});
