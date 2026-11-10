import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MarketArgError,
  MarketError,
  MarketPool,
  type MarketConfig,
  fixedPrice,
  formatMarketAmount,
  formatMarketState,
  formatSwapQuote,
  humanPrice,
  loadPoolFile,
  parseMarketAmount,
  parseMarketArgs,
  parseShares,
  poolFromJson,
  rationalToDecimal,
  savePoolFile,
  toMarketJson,
  toSwapQuoteJson,
} from "./market.ts";

/** ZPC priced at 28.842 AUD, 8 base decimals, 6 quote decimals, no fee. */
function zpcConfig(feeBps = 0): MarketConfig {
  const price = fixedPrice("28.842", 8, 6);
  return {
    baseSymbol: "ZPC",
    quoteSymbol: "AUD",
    baseDecimals: 8,
    quoteDecimals: 6,
    priceNum: price.num,
    priceDen: price.den,
    feeBps,
  };
}

/** A flat 1:1 pool with 6 decimals on both sides, so every amount is exact. */
function flatConfig(feeBps = 0): MarketConfig {
  const price = fixedPrice("1", 6, 6);
  return {
    baseSymbol: "ZPC",
    quoteSymbol: "AUD",
    baseDecimals: 6,
    quoteDecimals: 6,
    priceNum: price.num,
    priceDen: price.den,
    feeBps,
  };
}

test("a fixed price is the same rational however it is written", () => {
  const price = fixedPrice("28.842", 8, 6);

  // 1 whole ZPC (1e8 raw) is worth 28.842 AUD (28,842,000 raw in 6 decimals).
  assert.equal((100_000_000n * price.num) / price.den, 28_842_000n);
  assert.equal(humanPrice(price.num, price.den, 8, 6), "28.842");
  assert.deepEqual(fixedPrice("28.8420", 8, 6), price);
  assert.equal(rationalToDecimal(1n, 3n, 6), "0.333333");
});

test("a sell pays the fixed price less the fee, which stays in the pool", () => {
  const pool = new MarketPool(zpcConfig(30));
  pool.addLiquidity({ quote: 100_000_000n, base: 500_000_000n });

  const fill = pool.swap("sell", 100_000_000n); // 1 whole ZPC

  assert.equal(fill.fee, 300_000n); // 0.003 ZPC
  assert.equal(fill.amountOut, 28_755_474n); // 28.755474 AUD
  assert.equal(fill.priceImpactBps, 0);
  assert.equal(pool.state().price, "28.842");
  assert.equal(fill.reservesAfter.base, 600_000_000n);
});

test("a buy spends quote at the same fixed price", () => {
  const pool = new MarketPool(zpcConfig());
  pool.addLiquidity({ quote: 1_000_000n, base: 500_000_000n });

  const quote = pool.quote("buy", 28_842_000n); // 28.842 AUD

  assert.equal(quote.executable, true);
  assert.equal(quote.amountOut, 100_000_000n); // 1 whole ZPC
  assert.equal(quote.priceImpactBps, 0);
});

test("a buy followed by a sell returns the reserves exactly, so price never moves", () => {
  // A 1:1 price divides evenly, so even the integer rounding cancels out.
  const pool = MarketPool.create(flatConfig(), 1_000_000n);
  const before = pool.state();
  assert.equal(before.liquidityValueQuote, 1_000_000n);

  const bought = pool.swap("buy", 250_000n);
  pool.swap("sell", bought.amountOut);
  const after = pool.state();

  assert.equal(after.price, before.price);
  assert.equal(after.baseReserve, before.baseReserve);
  assert.equal(after.quoteReserve, before.quoteReserve);
  assert.equal(after.netBase, 0n);
  assert.equal(after.netQuote, 0n);
});

test("a round trip under a fee leaves only the fees behind", () => {
  const pool = MarketPool.create(zpcConfig(25), 100_000_000n);
  const before = pool.state();

  const bought = pool.swap("buy", 500_000n);
  pool.swap("sell", bought.amountOut);
  const after = pool.state();

  assert.equal(after.price, before.price);
  assert.equal(after.baseReserve, before.baseReserve);
  assert.ok(after.quoteReserve > before.quoteReserve); // the two fees, kept in the pool
});

test("one dollar of liquidity settles a billion units of volume", () => {
  // Exactly 1.000000 AUD of liquidity, price 1:1, no fee.
  const pool = MarketPool.create(flatConfig(), 1_000_000n);
  const opening = pool.state();
  assert.equal(opening.liquidityValueQuote, 1_000_000n);
  assert.equal(opening.baseReserve, 500_000n);
  assert.equal(opening.quoteReserve, 500_000n);

  // Each round trip trades the whole buffer both ways: 1.000000 AUD of volume.
  // 1,000 round trips therefore settle 1,000,000,000 base units on the same one
  // dollar, and nothing stops the count from growing.
  for (let round = 0; round < 1_000; round += 1) {
    const bought = pool.swap("buy", 500_000n);
    pool.swap("sell", bought.amountOut);
  }

  const state = pool.state();
  assert.equal(state.volumeQuote, 1_000_000_000n);
  assert.equal(state.swaps, 2_000);
  assert.equal(state.baseReserve, opening.baseReserve);
  assert.equal(state.quoteReserve, opening.quoteReserve);
  assert.equal(state.liquidityValueQuote, opening.liquidityValueQuote);
  assert.equal(state.turnover, 1_000); // 1e9 of volume on 1e6 of liquidity
  assert.equal(state.price, "1");
});

test("a one-sided trade is refused when the reserve cannot cover it", () => {
  const pool = MarketPool.create(flatConfig(), 1_000_000n);

  const quote = pool.quote("buy", 5_000_000n);

  assert.equal(quote.executable, false);
  assert.equal(quote.issue, "insufficient-liquidity");
  assert.equal(quote.amountOut, 0n);
  assert.match(quote.reason ?? "", /cannot sell 5 ZPC/);
  assert.throws(() => pool.swap("buy", 5_000_000n), (error: unknown) => {
    assert.ok(error instanceof MarketError);
    assert.equal(error.code, "insufficient-liquidity");
    return true;
  });
});

test("a sell larger than the quote reserve is refused, not repriced", () => {
  const pool = MarketPool.create(flatConfig(), 1_000_000n);
  pool.swap("buy", 500_000n); // pool now holds all 1 AUD of quote and no base

  const state = pool.state();
  assert.equal(state.baseReserve, 0n);

  const quote = pool.quote("sell", 3_000_000n);
  assert.equal(quote.executable, false);
  assert.equal(quote.issue, "insufficient-liquidity");
  assert.match(quote.reason ?? "", /cannot pay 3 AUD/);
});

test("too small an amount reports a quote instead of throwing", () => {
  // Whole-token base units: one raw quote unit cannot buy a whole ZPC at 28.842.
  const price = fixedPrice("28.842", 0, 6);
  const pool = MarketPool.create(
    {
      baseSymbol: "ZPC",
      quoteSymbol: "AUD",
      baseDecimals: 0,
      quoteDecimals: 6,
      priceNum: price.num,
      priceDen: price.den,
      feeBps: 0,
    },
    100_000_000n,
  );

  const quote = pool.quote("buy", 1n);

  assert.equal(quote.executable, false);
  assert.equal(quote.issue, "amount-too-small");
  assert.equal(quote.amountOut, 0n);
  assert.match(quote.reason ?? "", /too small/);
  assert.equal(quote.priceImpactBps, 0);
});

test("shares are minted and burned at the pool's value", () => {
  const pool = MarketPool.create(flatConfig(), 1_000_000n);
  assert.equal(pool.state().shares, 1_000_000n);

  const added = pool.addLiquidity({ quote: 1_000_000n, base: 1_000_000n });
  assert.equal(added.shares, 2_000_000n);
  assert.equal(added.sharesAfter, 3_000_000n);

  const removed = pool.removeLiquidity(2_000_000n);
  assert.equal(removed.base, 1_000_000n);
  assert.equal(removed.quote, 1_000_000n);
  assert.equal(removed.sharesAfter, 1_000_000n);

  pool.removeLiquidity(1_000_000n);
  const empty = pool.state();
  assert.equal(empty.shares, 0n);
  assert.equal(empty.baseReserve, 0n);
  assert.equal(empty.quoteReserve, 0n);
});

test("burning more shares than exist is an error", () => {
  const pool = MarketPool.create(flatConfig(), 1_000_000n);

  assert.throws(() => pool.removeLiquidity(5_000_000n), (error: unknown) => {
    assert.ok(error instanceof MarketError);
    assert.equal(error.code, "insufficient-shares");
    return true;
  });
});

test("a pool survives a JSON round trip with its bigints intact", () => {
  const pool = MarketPool.create(zpcConfig(30), 1_000_000n);
  pool.swap("sell", 100_000n);

  const restored = poolFromJson(JSON.parse(JSON.stringify(pool.toJson())));

  assert.deepEqual(restored.state(), pool.state());
  assert.deepEqual(restored.quote("buy", 500_000n), pool.quote("buy", 500_000n));
});

test("pool files are written atomically and never overwritten unasked", () => {
  const directory = mkdtempSync(join(tmpdir(), "lwc-market-"));
  const path = join(directory, "zpc.json");
  const pool = MarketPool.create(zpcConfig(), 1_000_000n);

  savePoolFile(path, pool);
  assert.equal(existsSync(path), true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).priceNum, pool.config.priceNum.toString());
  assert.deepEqual(loadPoolFile(path).state(), pool.state());

  assert.throws(() => savePoolFile(path, pool), (error: unknown) => {
    assert.ok(error instanceof MarketArgError);
    assert.match(error.message, /already exists; pass --force/);
    return true;
  });

  savePoolFile(path, pool, { force: true });
});

test("a malformed pool file is rejected by name", () => {
  assert.throws(() => poolFromJson({ version: 1 }), (error: unknown) => {
    assert.ok(error instanceof MarketArgError);
    assert.match(error.message, /baseSymbol/);
    return true;
  });
  assert.throws(() => poolFromJson({ version: 2 }), /unsupported pool file version/);
  assert.throws(() => poolFromJson(null), /JSON object/);
});

test("amounts parse and format against the pool's own decimals", () => {
  assert.equal(parseMarketAmount("1.5", 6, "--buy"), 1_500_000n);
  assert.equal(formatMarketAmount(1_500_000n, 6), "1.5");
  assert.equal(formatMarketAmount(2_000_000n, 6), "2");
  assert.throws(() => parseMarketAmount("0", 6, "--buy"), MarketArgError);
  assert.throws(() => parseMarketAmount("1.1234567", 6, "--buy"), /at most 6 decimal places/);
  assert.throws(() => parseMarketAmount("abc", 6, "--buy"), /positive decimal amount/);
  assert.equal(parseShares("250"), 250n);
  assert.throws(() => parseShares("1.5"), /whole number/);
  assert.throws(() => parseShares("0"), /greater than zero/);
});

test("market arguments require a pool and exactly one operation", () => {
  assert.throws(() => parseMarketArgs([]), /--pool <path> is required/);
  assert.throws(() => parseMarketArgs(["--pool", "p.json", "--buy", "1", "--sell", "2"]), /one operation at a time/);
  assert.throws(
    () => parseMarketArgs(["--pool", "p.json", "--price", "1"]),
    /only apply with --init/,
  );
  assert.throws(() => parseMarketArgs(["--pool", "p.json", "--init"]), /--init requires --price/);
  assert.throws(
    () => parseMarketArgs(["--pool", "p.json", "--init", "--price", "1", "--base", "A", "--quote", "B", "--seed", "1", "--buy", "1"]),
    /--init creates the pool/,
  );

  const init = parseMarketArgs([
    "--init", "--pool", "p.json", "--price", "28.842", "--base", "ZPC", "--quote", "AUD", "--seed", "1",
  ]);
  assert.deepEqual(init.init, {
    price: "28.842",
    baseSymbol: "ZPC",
    quoteSymbol: "AUD",
    baseDecimals: 18,
    quoteDecimals: 6,
    feeBps: 30,
    seed: "1",
  });
  assert.equal(init.operation.kind, "state");

  assert.deepEqual(parseMarketArgs(["--pool", "p.json", "--buy=5"]).operation, {
    kind: "swap",
    side: "buy",
    amount: "5",
  });
  assert.deepEqual(parseMarketArgs(["--pool", "p.json", "--add-base", "2"]).operation, {
    kind: "add",
    quote: null,
    base: "2",
    remove: "",
  });
  assert.deepEqual(parseMarketArgs(["--pool", "p.json", "--remove", "all"]).operation, {
    kind: "add",
    quote: null,
    base: null,
    remove: "all",
  });
  assert.equal(parseMarketArgs(["--pool", "p.json", "--sell", "1", "--dry-run"]).dryRun, true);
});

test("the reports stay readable and JSON-safe", () => {
  const pool = MarketPool.create(zpcConfig(), 100_000_000n);
  const fill = pool.swap("sell", 100_000n);
  const state = pool.state();

  const json = toMarketJson(state, "zpc.json");
  assert.equal(json.price.value, "28.842");
  assert.equal(json.price.fixed, true);
  assert.equal(json.volume.swaps, 1);
  assert.equal(typeof json.volume.quote, "string");
  assert.equal(json.pool, "zpc.json");
  assert.deepEqual(JSON.parse(JSON.stringify(toSwapQuoteJson(fill, state))).executable, true);

  const report = formatMarketState(state, "zpc.json");
  assert.match(report, /lwc — market/);
  assert.match(report, /28\.842 AUD per ZPC \(fixed\)/);
  assert.match(formatSwapQuote(fill, state), /28\.842 AUD per ZPC — no price impact/);
});
