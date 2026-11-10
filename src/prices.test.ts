import assert from "node:assert/strict";
import { test } from "node:test";

import type { Address } from "viem";

import {
  DEFAULT_NATIVE_PRICE_ID,
  PriceSource,
  priceChainSlug,
  usdValue,
} from "./prices.ts";

const USDT = "0x1E4a5963aBFD975d8c9021ce480b42188849D41d";

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

test("values a base-unit balance at a USD price", () => {
  assert.equal(usdValue(2_500_000n, 6, 2), 5);
  assert.equal(usdValue(10n ** 18n, 18, 100), 100);
  assert.equal(usdValue(0n, 6, 2), 0);

  assert.equal(usdValue(null, 6, 2), null, "no balance, no value");
  assert.equal(usdValue(1n, null, 2), null, "decimals are required to scale");
  assert.equal(usdValue(1n, 6, null), null, "an unpriced asset is not zero");
  assert.equal(usdValue(1n, 99, 2), null, "implausible decimals are refused");
});

test("maps chain ids to price-feed slugs", () => {
  assert.equal(priceChainSlug(196), "xlayer");
  assert.equal(priceChainSlug(1), null);
});

test("fetches every token plus the native price in one call", async () => {
  const calls: string[] = [];
  const source = new PriceSource({
    chainSlug: "xlayer",
    now: () => 0,
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return response({
        coins: {
          [`xlayer:${USDT.toLowerCase()}`]: {
            price: 0.99,
            symbol: "USDT",
            timestamp: 1,
          },
          [DEFAULT_NATIVE_PRICE_ID]: { price: 100, symbol: "OKB", timestamp: 2 },
        },
      });
    }) as typeof fetch,
  });

  const book = await source.prices([USDT, USDT.toLowerCase() as Address]);

  assert.equal(calls.length, 1, "one request for both assets");
  assert.ok(calls[0]?.includes(`xlayer:${USDT.toLowerCase()}`));
  assert.ok(calls[0]?.includes(DEFAULT_NATIVE_PRICE_ID));
  assert.equal(book.tokens.get(USDT.toLowerCase())?.price, 0.99);
  assert.equal(book.tokens.get(USDT.toLowerCase())?.symbol, "USDT");
  assert.equal(book.native?.price, 100);
  assert.equal(book.error, null);
});

test("reuses quotes inside the TTL and refetches after it", async () => {
  const calls: string[] = [];
  let clock = 0;
  const source = new PriceSource({
    chainSlug: "xlayer",
    now: () => clock,
    ttlMs: 1000,
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return response({
        coins: { [DEFAULT_NATIVE_PRICE_ID]: { price: 10, symbol: "OKB" } },
      });
    }) as typeof fetch,
  });

  await source.prices([USDT]);
  clock = 500;
  await source.prices([USDT]);
  assert.equal(calls.length, 1, "inside the TTL nothing is fetched");

  clock = 1000;
  await source.prices([USDT]);
  assert.equal(calls.length, 2, "a stale quote is refreshed");
});

test("reports a failed refresh and keeps the last quotes", async () => {
  const calls: string[] = [];
  let clock = 0;
  let fail = false;
  const source = new PriceSource({
    chainSlug: "xlayer",
    now: () => clock,
    ttlMs: 1000,
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (fail) return response({}, 503);
      return response({
        coins: {
          [`xlayer:${USDT.toLowerCase()}`]: { price: 2, symbol: "USDT" },
          [DEFAULT_NATIVE_PRICE_ID]: { price: 100, symbol: "OKB" },
        },
      });
    }) as typeof fetch,
  });

  await source.prices([USDT]);

  fail = true;
  clock = 1000;
  const failed = await source.prices([USDT]);
  assert.equal(failed.error, "HTTP 503");
  assert.equal(failed.tokens.get(USDT.toLowerCase())?.price, 2, "the last quote survives");
  assert.equal(failed.native?.price, 100);

  clock = 1500;
  const cached = await source.prices([USDT]);
  assert.equal(calls.length, 2, "a failed refresh is not retried inside the TTL");
  assert.equal(cached.error, "HTTP 503");
});

test("a token the feed cannot price stays absent", async () => {
  const source = new PriceSource({
    chainSlug: "xlayer",
    now: () => 0,
    fetchImpl: (async () =>
      response({
        coins: {
          [DEFAULT_NATIVE_PRICE_ID]: { price: 100, symbol: "OKB" },
        },
      })) as typeof fetch,
  });

  const book = await source.prices([USDT]);

  assert.equal(book.tokens.has(USDT.toLowerCase()), false);
  assert.equal(book.error, null, "a missing quote is not a feed failure");
  assert.equal(book.native?.price, 100);
});
