import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { formatUnits, parseUnits } from "viem";

/**
 * A fixed-price market: every swap settles at one price that never moves, so a
 * trade can never reprice (devalue) the token. The pool's job is settlement, not
 * price discovery.
 *
 * A constant-product AMM needs `k` worth of reserves to absorb a trade, so a
 * $1 pool answers a $1 trade and dies. Here the price is a fixed rational, the
 * pool holds inventory at that price, and a buy is reversed exactly by a sell of
 * the same size: the reserves return to where they started, minus nothing but
 * the fee. Cumulative volume is therefore bounded by swap count, not by the
 * dollars deposited — a $1 pool that is traded round trip a billion times has
 * settled a billion dollars' worth of volume while its reserves never moved.
 *
 * The one honest limit is net directional flow: a buy the pool cannot fill from
 * its base inventory, or a sell it cannot pay from its quote inventory, is
 * refused with a reason instead of being silently repriced.
 */

/** Which leg the trader sends: `buy` sends quote for base, `sell` sends base for quote. */
export type MarketSide = "buy" | "sell";

export type MarketErrorCode =
  | "invalid-amount"
  | "insufficient-liquidity"
  | "insufficient-shares"
  | "invalid-pool";

export class MarketError extends Error {
  readonly code: MarketErrorCode;

  constructor(code: MarketErrorCode, message: string) {
    super(message);
    this.name = "MarketError";
    this.code = code;
  }
}

export class MarketArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketArgError";
  }
}

/** Why a quote cannot be executed, or `null` when it can. */
export type MarketIssue = "amount-too-small" | "insufficient-liquidity" | null;

export interface MarketConfig {
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Fixed price as a reduced rational: quote base units per base base unit. */
  priceNum: bigint;
  priceDen: bigint;
  /** Fee taken from the input leg and left in the pool for liquidity providers. */
  feeBps: number;
}

export interface ReservePair {
  base: bigint;
  quote: bigint;
}

export interface SwapQuote {
  side: MarketSide;
  /** What the trader sends, in that token's base units. */
  amountIn: bigint;
  /** What the trader receives, in the other token's base units. */
  amountOut: bigint;
  /** Fee taken from `amountIn`, left in the pool. */
  fee: bigint;
  /** Notional value of the trade in quote base units. */
  notional: bigint;
  /** Reserves the pool holds if this quote is executed. */
  reservesAfter: ReservePair;
  /** Always zero: a fixed-price fill cannot move the price. */
  priceImpactBps: 0;
  executable: boolean;
  issue: MarketIssue;
  /** Human-readable reason when `executable` is false. */
  reason: string | null;
}

export interface LiquidityReceipt {
  kind: "add" | "remove";
  base: bigint;
  quote: bigint;
  shares: bigint;
  sharesAfter: bigint;
  liquidityValueQuote: bigint;
}

export interface MarketState {
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  priceNum: bigint;
  priceDen: bigint;
  /** The fixed price as a decimal string, quote per one whole base token. */
  price: string;
  feeBps: number;
  baseReserve: bigint;
  quoteReserve: bigint;
  /** Value of both reserves at the fixed price, in quote base units. */
  liquidityValueQuote: bigint;
  shares: bigint;
  /** Cumulative traded notional in quote base units. */
  volumeQuote: bigint;
  swaps: number;
  /** Volume settled per unit of deposited liquidity — the turnover multiple. */
  turnover: number;
  /** Inventory drift from the opening reserves: the market's net exposure. */
  netBase: bigint;
  netQuote: bigint;
}

export interface MarketCapacity {
  /** Most base one buy can take out right now. */
  maxBuyBase: bigint;
  /** Most base one sell can hand in right now, before quote reserves run out. */
  maxSellBase: bigint;
  /** Quote the pool can pay out in total. */
  payQuote: bigint;
  /** Value of the pool at the fixed price. */
  liquidityValueQuote: bigint;
}

const BPS = 10_000n;
const MAX_FEE_BPS = 1_000;
const MAX_DECIMALS = 36;

/** Where `lwc market --serve` listens unless told otherwise. */
export const DEFAULT_MARKET_HOST = "127.0.0.1";
export const DEFAULT_MARKET_PORT = 8787;
export const MAX_MARKET_PORT = 65_535;
/** Requests per minute one client may make unless `--rate-limit` says otherwise. */
export const DEFAULT_MARKET_RATE_LIMIT = 120;
const MAX_RATE_LIMIT = 100_000;

function reduce(num: bigint, den: bigint): { num: bigint; den: bigint } {
  const left = num < 0n ? -num : num;
  const right = den < 0n ? -den : den;
  let a = left;
  let b = right;
  while (b !== 0n) {
    const rest = a % b;
    a = b;
    b = rest;
  }
  const divisor = a === 0n ? 1n : a;
  return { num: num / divisor, den: den / divisor };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Render a rational as a decimal string, without trailing zeros. */
export function rationalToDecimal(num: bigint, den: bigint, maxDecimals = 18): string {
  if (den === 0n) throw new MarketArgError("cannot render a price over zero");
  const negative = num < 0n !== den < 0n;
  const top = num < 0n ? -num : num;
  const bottom = den < 0n ? -den : den;
  const whole = top / bottom;
  let remainder = top % bottom;
  let fraction = "";
  for (let digit = 0; digit < maxDecimals && remainder !== 0n; digit += 1) {
    remainder *= 10n;
    fraction += String(remainder / bottom);
    remainder %= bottom;
  }
  const text = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${text}` : text;
}

/**
 * Turn a human price into the pool's rational. `"28.842"` with 8 base decimals
 * and 6 quote decimals means one whole base token is worth 28.842 quote tokens,
 * and the rational is expressed in raw units of each token.
 */
export function fixedPrice(
  human: string,
  baseDecimals: number,
  quoteDecimals: number,
): { num: bigint; den: bigint } {
  const trimmed = human.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new MarketArgError(`price must be a positive decimal number, got "${human}".`);
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const value = BigInt(`${whole}${fraction}`);
  if (value === 0n) throw new MarketArgError("price must be greater than zero.");
  return reduce(value * pow10(quoteDecimals), pow10(fraction.length) * pow10(baseDecimals));
}

/** Share counts are whole units, so they never take decimals. */
export function parseShares(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new MarketArgError(`shares must be a whole number, got "${value}".`);
  }
  const shares = BigInt(trimmed);
  if (shares <= 0n) throw new MarketArgError("shares must be greater than zero.");
  return shares;
}

/** Human price of a rational, quote per one whole base token. */
export function humanPrice(
  num: bigint,
  den: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): string {
  return rationalToDecimal(num * pow10(baseDecimals), den * pow10(quoteDecimals));
}

/** A decimal amount as base units, with the pool's own decimals. */
export function parseMarketAmount(value: string, decimals: number, label: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new MarketArgError(`${label} must be a positive decimal amount, got "${value}".`);
  }
  const point = trimmed.indexOf(".");
  const places = point === -1 ? 0 : trimmed.length - point - 1;
  if (places > decimals) {
    throw new MarketArgError(
      `${label} "${value}" needs at most ${decimals} decimal place${decimals === 1 ? "" : "s"}.`,
    );
  }
  let amount: bigint;
  try {
    amount = parseUnits(trimmed, decimals);
  } catch (error) {
    throw new MarketArgError(
      `${label} "${value}" needs at most ${decimals} decimal place${decimals === 1 ? "" : "s"}.`,
    );
  }
  if (amount <= 0n) throw new MarketArgError(`${label} must be greater than zero.`);
  return amount;
}

/** Base units as a trimmed decimal string. */
export function formatMarketAmount(value: bigint, decimals: number): string {
  const text = formatUnits(value, decimals);
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

function assertDecimals(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DECIMALS) {
    throw new MarketArgError(`${label} must be a whole number between 0 and ${MAX_DECIMALS}.`);
  }
}

function assertFeeBps(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_FEE_BPS) {
    throw new MarketArgError(`fee must be a whole number of basis points between 0 and ${MAX_FEE_BPS}.`);
  }
}

/** The on-disk shape, with every bigint written as a decimal string. */
export interface MarketPoolJson {
  version: 1;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  priceNum: string;
  priceDen: string;
  feeBps: number;
  baseReserve: string;
  quoteReserve: string;
  shares: string;
  volumeQuote: string;
  swaps: number;
  openedBase: string;
  openedQuote: string;
}

function bigintField(raw: unknown, name: string): bigint {
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
    throw new MarketArgError(`pool file field "${name}" must be a decimal integer string.`);
  }
  return BigInt(raw);
}

function stringField(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new MarketArgError(`pool file field "${name}" must be a non-empty string.`);
  }
  return raw;
}

function numberField(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new MarketArgError(`pool file field "${name}" must be a number.`);
  }
  return raw;
}

/** Convert a parsed pool file into runtime state, validating every field. */
export function poolFromJson(raw: unknown): MarketPool {
  if (typeof raw !== "object" || raw === null) {
    throw new MarketArgError("pool file must contain a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    throw new MarketArgError(`unsupported pool file version ${String(record.version)}; expected 1.`);
  }
  const config: MarketConfig = {
    baseSymbol: stringField(record.baseSymbol, "baseSymbol"),
    quoteSymbol: stringField(record.quoteSymbol, "quoteSymbol"),
    baseDecimals: numberField(record.baseDecimals, "baseDecimals"),
    quoteDecimals: numberField(record.quoteDecimals, "quoteDecimals"),
    priceNum: bigintField(record.priceNum, "priceNum"),
    priceDen: bigintField(record.priceDen, "priceDen"),
    feeBps: numberField(record.feeBps, "feeBps"),
  };
  return new MarketPool(config, {
    baseReserve: bigintField(record.baseReserve, "baseReserve"),
    quoteReserve: bigintField(record.quoteReserve, "quoteReserve"),
    shares: bigintField(record.shares, "shares"),
    volumeQuote: bigintField(record.volumeQuote, "volumeQuote"),
    swaps: numberField(record.swaps, "swaps"),
    openedBase: bigintField(record.openedBase, "openedBase"),
    openedQuote: bigintField(record.openedQuote, "openedQuote"),
  });
}

/** Read a pool file from disk, validating every field. */
export function loadPoolFile(path: string): MarketPool {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MarketArgError(`cannot read pool file ${path}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MarketArgError(`pool file ${path} is not valid JSON.`);
  }

  return poolFromJson(parsed);
}

/** Write a pool file atomically, refusing to replace one without `force`. */
export function savePoolFile(
  path: string,
  pool: MarketPool,
  options: { force?: boolean } = {},
): MarketPoolJson {
  const json = pool.toJson();
  const text = `${JSON.stringify(json, null, 2)}\n`;

  if (!options.force && existsSync(path)) {
    throw new MarketArgError(`${path} already exists; pass --force to replace it.`);
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MarketArgError(`cannot write ${path}: ${reason}`);
  }

  return json;
}

export interface MarketPoolState {
  baseReserve: bigint;
  quoteReserve: bigint;
  shares: bigint;
  volumeQuote: bigint;
  swaps: number;
  openedBase: bigint;
  openedQuote: bigint;
}

/**
 * A fixed-price settlement pool. Reserves only move when flow is net
 * directional, so matched volume costs the pool nothing.
 */
export class MarketPool {
  readonly config: MarketConfig;
  private baseReserve: bigint;
  private quoteReserve: bigint;
  private sharesOut: bigint;
  private volumeQuote: bigint;
  private swapCount: number;
  private readonly openedBase: bigint;
  private readonly openedQuote: bigint;

  constructor(config: MarketConfig, state?: Partial<MarketPoolState>) {
    assertDecimals(config.baseDecimals, "base decimals");
    assertDecimals(config.quoteDecimals, "quote decimals");
    assertFeeBps(config.feeBps);
    if (config.priceNum <= 0n || config.priceDen <= 0n) {
      throw new MarketArgError("price numerator and denominator must both be positive.");
    }
    if (config.baseSymbol.trim().length === 0 || config.quoteSymbol.trim().length === 0) {
      throw new MarketArgError("base and quote symbols are required.");
    }

    this.config = config;
    this.baseReserve = state?.baseReserve ?? 0n;
    this.quoteReserve = state?.quoteReserve ?? 0n;
    this.sharesOut = state?.shares ?? 0n;
    this.volumeQuote = state?.volumeQuote ?? 0n;
    this.swapCount = state?.swaps ?? 0;
    this.openedBase = state?.openedBase ?? this.baseReserve;
    this.openedQuote = state?.openedQuote ?? this.quoteReserve;

    for (const [label, value] of [
      ["base reserve", this.baseReserve],
      ["quote reserve", this.quoteReserve],
      ["shares", this.sharesOut],
      ["volume", this.volumeQuote],
    ] as const) {
      if (value < 0n) throw new MarketArgError(`pool file ${label} cannot be negative.`);
    }
    if (!Number.isInteger(this.swapCount) || this.swapCount < 0) {
      throw new MarketArgError("pool file swap count must be a whole number.");
    }
  }

  /**
   * Create a pool worth `liquidity` of the quote token, split evenly between the
   * two legs at the fixed price, so one dollar on deposit really is one dollar.
   */
  static create(config: MarketConfig, liquidity: bigint): MarketPool {
    if (liquidity <= 0n) throw new MarketArgError("seed liquidity must be greater than zero.");
    const quoteSide = liquidity / 2n;
    const quoteRemainder = liquidity - quoteSide;
    // Round the base leg up so the pool never opens a raw unit short of the seed.
    const baseSide = (quoteRemainder * config.priceDen + config.priceNum - 1n) / config.priceNum;
    if (baseSide <= 0n || quoteSide <= 0n) {
      throw new MarketArgError(
        "seed liquidity is too small to fund both legs at this price; use a larger --seed.",
      );
    }
    const shares = quoteSide + (baseSide * config.priceNum) / config.priceDen;
    return new MarketPool(config, { baseReserve: baseSide, quoteReserve: quoteSide, shares });
  }

  /** Price of the base token in quote units, in raw units of each token. */
  private get ratio(): { num: bigint; den: bigint } {
    return { num: this.config.priceNum, den: this.config.priceDen };
  }

  /** Quote base units for a given base amount, at the fixed price (rounded down). */
  quoteForBase(baseAmount: bigint): bigint {
    return (baseAmount * this.ratio.num) / this.ratio.den;
  }

  /** Base units for a given quote amount, at the fixed price (rounded down). */
  baseForQuote(quoteAmount: bigint): bigint {
    return (quoteAmount * this.ratio.den) / this.ratio.num;
  }

  /** Value of both reserves at the fixed price, in quote base units. */
  liquidityValueQuote(): bigint {
    return this.quoteReserve + this.quoteForBase(this.baseReserve);
  }

  /**
   * Price a trade without touching the pool. A well-formed amount always gets a
   * quote; `executable` and `reason` say whether the pool can settle it.
   */
  quote(side: MarketSide, amountIn: bigint): SwapQuote {
    if (amountIn <= 0n) {
      throw new MarketError("invalid-amount", "amountIn must be greater than zero.");
    }

    const fee = (amountIn * BigInt(this.config.feeBps)) / BPS;
    const net = amountIn - fee;
    const notional = side === "buy" ? amountIn : this.quoteForBase(amountIn);

    let amountOut: bigint;
    let reservesAfter: ReservePair;

    if (side === "sell") {
      // Base in: the fee stays in base, the rest is paid at the fixed price.
      amountOut = this.quoteForBase(net);
      reservesAfter = {
        base: this.baseReserve + amountIn,
        quote: this.quoteReserve - amountOut,
      };
    } else {
      // Quote in: the fee stays in quote, the rest buys base at the fixed price.
      amountOut = this.baseForQuote(net);
      reservesAfter = {
        base: this.baseReserve - amountOut,
        quote: this.quoteReserve + amountIn,
      };
    }

    let issue: MarketIssue = null;
    let reason: string | null = null;
    if (amountOut <= 0n) {
      issue = "amount-too-small";
      reason = `amount is too small to receive one unit of ${this.outSymbol(side)} at this price`;
    } else if (reservesAfter.base < 0n) {
      issue = "insufficient-liquidity";
      reason = `the pool holds ${this.describe(this.baseReserve, "base")} and cannot sell ${this.describe(amountOut, "base")}`;
    } else if (reservesAfter.quote < 0n) {
      issue = "insufficient-liquidity";
      reason = `the pool holds ${this.describe(this.quoteReserve, "quote")} and cannot pay ${this.describe(amountOut, "quote")}`;
    }

    return {
      side,
      amountIn,
      amountOut: issue === null ? amountOut : 0n,
      fee,
      notional,
      reservesAfter:
        issue === null
          ? reservesAfter
          : { base: this.baseReserve, quote: this.quoteReserve },
      priceImpactBps: 0,
      executable: issue === null,
      issue,
      reason,
    };
  }

  /** Execute a trade at the fixed price and return the fill. */
  swap(side: MarketSide, amountIn: bigint): SwapQuote {
    const filled = this.quote(side, amountIn);
    if (!filled.executable) {
      const code: MarketErrorCode =
        filled.issue === "amount-too-small" ? "invalid-amount" : "insufficient-liquidity";
      throw new MarketError(code, filled.reason ?? "swap cannot be settled");
    }
    this.baseReserve = filled.reservesAfter.base;
    this.quoteReserve = filled.reservesAfter.quote;
    this.volumeQuote += filled.notional;
    this.swapCount += 1;
    return filled;
  }

  /** Deposit one or both legs and mint shares at the pre-deposit value. */
  addLiquidity(input: Partial<ReservePair>): LiquidityReceipt {
    const base = input.base ?? 0n;
    const quote = input.quote ?? 0n;
    if (base < 0n || quote < 0n) {
      throw new MarketError("invalid-amount", "liquidity amounts cannot be negative.");
    }
    if (base === 0n && quote === 0n) {
      throw new MarketError("invalid-amount", "deposit at least one of base or quote.");
    }

    const value = quote + this.quoteForBase(base);
    if (value <= 0n) {
      throw new MarketError(
        "invalid-amount",
        "deposit is too small to be worth one unit of the quote token at this price.",
      );
    }

    const existingValue = this.liquidityValueQuote();
    const shares =
      this.sharesOut === 0n ? value : (value * this.sharesOut) / (existingValue === 0n ? 1n : existingValue);

    this.baseReserve += base;
    this.quoteReserve += quote;
    this.sharesOut += shares;

    return {
      kind: "add",
      base,
      quote,
      shares,
      sharesAfter: this.sharesOut,
      liquidityValueQuote: this.liquidityValueQuote(),
    };
  }

  /** Burn shares for their pro-rata slice of both reserves. */
  removeLiquidity(shares: bigint): LiquidityReceipt {
    if (shares <= 0n) {
      throw new MarketError("invalid-amount", "shares must be greater than zero.");
    }
    if (shares > this.sharesOut) {
      throw new MarketError(
        "insufficient-shares",
        `cannot burn ${shares} shares; the pool has ${this.sharesOut}.`,
      );
    }

    const outBase = (shares * this.baseReserve) / this.sharesOut;
    const outQuote = (shares * this.quoteReserve) / this.sharesOut;

    this.baseReserve -= outBase;
    this.quoteReserve -= outQuote;
    this.sharesOut -= shares;

    // Rounding dust is worthless to a zero-share pool, so it is cleared rather
    // than left as inventory nobody can claim.
    if (this.sharesOut === 0n) {
      this.baseReserve = 0n;
      this.quoteReserve = 0n;
    }

    return {
      kind: "remove",
      base: outBase,
      quote: outQuote,
      shares,
      sharesAfter: this.sharesOut,
      liquidityValueQuote: this.liquidityValueQuote(),
    };
  }

  /** What the pool can settle right now, and how much volume its liquidity backs. */
  capacity(): MarketCapacity {
    const liquidity = this.liquidityValueQuote();
    return {
      maxBuyBase: this.baseReserve,
      maxSellBase: this.baseForQuote(this.quoteReserve),
      payQuote: this.quoteReserve,
      liquidityValueQuote: liquidity,
    };
  }

  /** What the pool could settle right after `quote`, without applying it. */
  capacityAfter(quote: SwapQuote): MarketCapacity {
    const base = quote.reservesAfter.base;
    const reserve = quote.reservesAfter.quote;
    return {
      maxBuyBase: base,
      maxSellBase: this.baseForQuote(reserve),
      payQuote: reserve,
      liquidityValueQuote: reserve + this.quoteForBase(base),
    };
  }

  state(): MarketState {
    const liquidity = this.liquidityValueQuote();
    return {
      baseSymbol: this.config.baseSymbol,
      quoteSymbol: this.config.quoteSymbol,
      baseDecimals: this.config.baseDecimals,
      quoteDecimals: this.config.quoteDecimals,
      priceNum: this.config.priceNum,
      priceDen: this.config.priceDen,
      price: humanPrice(
        this.config.priceNum,
        this.config.priceDen,
        this.config.baseDecimals,
        this.config.quoteDecimals,
      ),
      feeBps: this.config.feeBps,
      baseReserve: this.baseReserve,
      quoteReserve: this.quoteReserve,
      liquidityValueQuote: liquidity,
      shares: this.sharesOut,
      volumeQuote: this.volumeQuote,
      swaps: this.swapCount,
      turnover: liquidity === 0n ? 0 : Number(this.volumeQuote) / Number(liquidity),
      netBase: this.baseReserve - this.openedBase,
      netQuote: this.quoteReserve - this.openedQuote,
    };
  }

  toJson(): MarketPoolJson {
    return {
      version: 1,
      baseSymbol: this.config.baseSymbol,
      quoteSymbol: this.config.quoteSymbol,
      baseDecimals: this.config.baseDecimals,
      quoteDecimals: this.config.quoteDecimals,
      priceNum: this.config.priceNum.toString(),
      priceDen: this.config.priceDen.toString(),
      feeBps: this.config.feeBps,
      baseReserve: this.baseReserve.toString(),
      quoteReserve: this.quoteReserve.toString(),
      shares: this.sharesOut.toString(),
      volumeQuote: this.volumeQuote.toString(),
      swaps: this.swapCount,
      openedBase: this.openedBase.toString(),
      openedQuote: this.openedQuote.toString(),
    };
  }

  private outSymbol(side: MarketSide): string {
    return side === "sell" ? this.config.quoteSymbol : this.config.baseSymbol;
  }

  private describe(amount: bigint, leg: "base" | "quote"): string {
    return leg === "base"
      ? `${formatMarketAmount(amount, this.config.baseDecimals)} ${this.config.baseSymbol}`
      : `${formatMarketAmount(amount, this.config.quoteDecimals)} ${this.config.quoteSymbol}`;
  }
}

/** JSON form of a market state, with bigints as decimal strings. */
export function toMarketJson(state: MarketState, path: string | null = null) {
  return {
    pool: path,
    base: {
      symbol: state.baseSymbol,
      decimals: state.baseDecimals,
      reserve: state.baseReserve.toString(),
    },
    quote: {
      symbol: state.quoteSymbol,
      decimals: state.quoteDecimals,
      reserve: state.quoteReserve.toString(),
    },
    price: {
      value: state.price,
      num: state.priceNum.toString(),
      den: state.priceDen.toString(),
      fixed: true,
      priceImpactBps: 0,
    },
    feeBps: state.feeBps,
    liquidity: {
      valueQuote: state.liquidityValueQuote.toString(),
      shares: state.shares.toString(),
    },
    volume: {
      quote: state.volumeQuote.toString(),
      swaps: state.swaps,
      turnover: state.turnover,
    },
    netFlow: {
      base: state.netBase.toString(),
      quote: state.netQuote.toString(),
    },
  };
}

/** JSON form of a swap quote, with bigints as decimal strings. */
export function toSwapQuoteJson(quote: SwapQuote, state: MarketState) {
  return {
    side: quote.side,
    amountIn: quote.amountIn.toString(),
    amountOut: quote.amountOut.toString(),
    fee: quote.fee.toString(),
    notional: quote.notional.toString(),
    inSymbol: quote.side === "buy" ? state.quoteSymbol : state.baseSymbol,
    outSymbol: quote.side === "buy" ? state.baseSymbol : state.quoteSymbol,
    price: state.price,
    priceImpactBps: quote.priceImpactBps,
    executable: quote.executable,
    issue: quote.issue,
    reason: quote.reason,
    reservesAfter: {
      base: quote.reservesAfter.base.toString(),
      quote: quote.reservesAfter.quote.toString(),
    },
  };
}

/** Human report for `lwc market`. */
export function formatMarketState(state: MarketState, path: string | null): string {
  const base = (value: bigint) => formatMarketAmount(value, state.baseDecimals);
  const quote = (value: bigint) => formatMarketAmount(value, state.quoteDecimals);
  const pct = (value: number) =>
    Number.isFinite(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}×` : "—";

  const lines = [
    "lwc — market",
    "",
    `  pool          ${path ?? "(in memory)"}`,
    `  base          ${state.baseSymbol} (${state.baseDecimals} decimals)`,
    `  quote         ${state.quoteSymbol} (${state.quoteDecimals} decimals)`,
    `  price         ${state.price} ${state.quoteSymbol} per ${state.baseSymbol} (fixed)`,
    `  fee           ${state.feeBps} bps`,
    "",
    `  reserve       ${quote(state.quoteReserve)} ${state.quoteSymbol} + ${base(state.baseReserve)} ${state.baseSymbol}`,
    `  liquidity     ${quote(state.liquidityValueQuote)} ${state.quoteSymbol} in ${state.shares} shares`,
    "",
    `  volume        ${quote(state.volumeQuote)} ${state.quoteSymbol} over ${state.swaps} swap${state.swaps === 1 ? "" : "s"}`,
    `  turnover      ${pct(state.turnover)} liquidity settled`,
    `  net flow      ${base(state.netBase)} ${state.baseSymbol}, ${quote(state.netQuote)} ${state.quoteSymbol}`,
  ];
  return lines.join("\n");
}

/** Human report for one fill or quote. */
export function formatSwapQuote(quote: SwapQuote, state: MarketState, options: { applied?: boolean } = {}): string {
  const inSymbol = quote.side === "buy" ? state.quoteSymbol : state.baseSymbol;
  const outSymbol = quote.side === "buy" ? state.baseSymbol : state.quoteSymbol;
  const inDecimals = quote.side === "buy" ? state.quoteDecimals : state.baseDecimals;
  const outDecimals = quote.side === "buy" ? state.baseDecimals : state.quoteDecimals;
  const inLabel = `  ${options.applied ? "swapped" : "quote  "}       ${formatMarketAmount(quote.amountIn, inDecimals)} ${inSymbol} → `;

  if (!quote.executable) {
    return `${inLabel}not executable — ${quote.reason ?? quote.issue ?? "unknown reason"}`;
  }

  return [
    `${inLabel}${formatMarketAmount(quote.amountOut, outDecimals)} ${outSymbol}`,
    `  fee           ${formatMarketAmount(quote.fee, inDecimals)} ${inSymbol} (left in the pool)`,
    `  price         ${state.price} ${state.quoteSymbol} per ${state.baseSymbol} — no price impact`,
    `  reserves      ${formatMarketAmount(quote.reservesAfter.quote, state.quoteDecimals)} ${state.quoteSymbol} + ${formatMarketAmount(quote.reservesAfter.base, state.baseDecimals)} ${state.baseSymbol}`,
  ].join("\n");
}

/** Human report for a liquidity deposit or withdrawal. */
export function formatLiquidity(receipt: LiquidityReceipt, state: MarketState): string {
  const base = formatMarketAmount(receipt.base, state.baseDecimals);
  const quote = formatMarketAmount(receipt.quote, state.quoteDecimals);
  const verb = receipt.kind === "add" ? "deposited" : "withdrew";
  return [
    `  ${verb}${receipt.kind === "add" ? "  " : " "}     ${quote} ${state.quoteSymbol} + ${base} ${state.baseSymbol} → ${receipt.shares} shares`,
    `  shares        ${receipt.sharesAfter}`,
    `  liquidity     ${formatMarketAmount(receipt.liquidityValueQuote, state.quoteDecimals)} ${state.quoteSymbol}`,
  ].join("\n");
}

/** Shortest access key `--api-key` accepts before the API is exposed. */
export const MIN_MARKET_KEY_LENGTH = 8;

export interface MarketServeOptions {
  host: string;
  port: number;
  /** Browser origins allowed to call the API, or `["*"]` for any. */
  corsOrigins: string[];
  /** Key every pool route requires; null leaves the API open. */
  accessKey: string | null;
  /** Requests per minute one client may make; 0 turns the limiter off. */
  rateLimitPerMinute?: number;
  /**
   * Where the per-client counters are kept between runs. Defaults to a file
   * beside the pool; null keeps them in memory only.
   */
  limitsPath?: string | null;
}

export type MarketOperation =
  | { kind: "state" }
  | { kind: "swap"; side: MarketSide; amount: string }
  | { kind: "add"; quote: string | null; base: string | null; remove: string };

export interface MarketArgs {
  poolPath: string;
  init: {
    price: string;
    baseSymbol: string;
    quoteSymbol: string;
    baseDecimals: number;
    quoteDecimals: number;
    feeBps: number;
    seed: string;
  } | null;
  /** The single operation this run performs, after any init. */
  operation: MarketOperation;
  force: boolean;
  /** Price the trade without applying it. */
  dryRun: boolean;
  /** Serve the pool over HTTP instead of running one operation. */
  serve: MarketServeOptions | null;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new MarketArgError(`${flag} requires a value.`);
  }
  return value;
}

function wholeNumber(raw: string, flag: string, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new MarketArgError(`${flag} must be a whole number, got "${raw}".`);
  }
  const value = Number(raw);
  if (value > max) throw new MarketArgError(`${flag} must be at most ${max}, got ${value}.`);
  return value;
}

function parseCorsOrigin(raw: string): string {
  const value = raw.trim();
  if (value === "*") return "*";
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(value)) {
    throw new MarketArgError(`--cors must be "*" or an http(s) origin, got "${raw}".`);
  }
  return value;
}

export function parseMarketArgs(argv: string[]): MarketArgs {
  let poolPath: string | null = null;
  let force = false;
  let dryRun = false;
  let serve = false;
  let port: number | null = null;
  let host: string | null = null;
  const corsOrigins: string[] = [];
  let accessKey: string | null = null;
  let rateLimit: number | null = null;
  let limitsPath: string | null = null;

  let price: string | null = null;
  let baseSymbol: string | null = null;
  let quoteSymbol: string | null = null;
  let baseDecimals: number | null = null;
  let quoteDecimals: number | null = null;
  let feeBps: number | null = null;
  let seed: string | null = null;
  let init = false;

  let buy: string | null = null;
  let sell: string | null = null;
  let addQuote: string | null = null;
  let addBase: string | null = null;
  let remove: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, null];
    const take = () => {
      if (inline !== null) return inline;
      const value = requiredValue(argv, index, flag);
      index += 1;
      return value;
    };

    switch (flag) {
      case "--json":
        break;
      case "--serve":
        serve = true;
        break;
      case "--port":
        port = wholeNumber(take(), flag, MAX_MARKET_PORT);
        break;
      case "--host":
        host = take();
        break;
      case "--cors":
        corsOrigins.push(parseCorsOrigin(take()));
        break;
      case "--api-key":
        accessKey = take();
        break;
      case "--rate-limit":
        rateLimit = wholeNumber(take(), flag, MAX_RATE_LIMIT);
        break;
      case "--limits-file":
        limitsPath = take();
        break;
      case "--pool":
        poolPath = take();
        break;
      case "--init":
        init = true;
        break;
      case "--force":
        force = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--price":
        price = take();
        break;
      case "--base":
        baseSymbol = take();
        break;
      case "--quote":
        quoteSymbol = take();
        break;
      case "--base-decimals":
        baseDecimals = wholeNumber(take(), flag, MAX_DECIMALS);
        break;
      case "--quote-decimals":
        quoteDecimals = wholeNumber(take(), flag, MAX_DECIMALS);
        break;
      case "--fee-bps":
        feeBps = wholeNumber(take(), flag, MAX_FEE_BPS);
        break;
      case "--seed":
        seed = take();
        break;
      case "--buy":
        buy = take();
        break;
      case "--sell":
        sell = take();
        break;
      case "--add":
        addQuote = take();
        break;
      case "--add-base":
        addBase = take();
        break;
      case "--remove":
        remove = take();
        break;
      default:
        if (arg.startsWith("-")) throw new MarketArgError(`unknown flag ${arg}.`);
        throw new MarketArgError(`unexpected argument "${arg}"; amounts are passed to a flag.`);
    }
  }

  if (poolPath === null) {
    throw new MarketArgError("--pool <path> is required (the pool file to read or create).");
  }

  let initArgs: MarketArgs["init"] = null;
  if (init) {
    if (price === null) throw new MarketArgError("--init requires --price <quote per base>.");
    if (baseSymbol === null) throw new MarketArgError("--init requires --base <symbol>.");
    if (quoteSymbol === null) throw new MarketArgError("--init requires --quote <symbol>.");
    if (seed === null) throw new MarketArgError("--init requires --seed <quote liquidity>.");
    initArgs = {
      price,
      baseSymbol,
      quoteSymbol,
      baseDecimals: baseDecimals ?? 18,
      quoteDecimals: quoteDecimals ?? 6,
      feeBps: feeBps ?? 30,
      seed,
    };
  } else if (price !== null || seed !== null || baseSymbol !== null || quoteSymbol !== null) {
    throw new MarketArgError("--price, --base, --quote and --seed only apply with --init.");
  }

  const operations = [
    buy !== null ? "--buy" : null,
    sell !== null ? "--sell" : null,
    addQuote !== null || addBase !== null ? "--add" : null,
    remove !== null ? "--remove" : null,
  ].filter((entry): entry is string => entry !== null);

  if (operations.length > 1) {
    throw new MarketArgError(`run one operation at a time, got ${operations.join(" and ")}.`);
  }
  if (init && operations.length > 0) {
    throw new MarketArgError("--init creates the pool; run it without a trade.");
  }
  if (serve && init) {
    throw new MarketArgError("--serve runs an existing pool; it cannot be combined with --init.");
  }
  if (serve && operations.length > 0) {
    throw new MarketArgError("--serve runs the API; it cannot be combined with a single operation.");
  }
  if (serve && dryRun) {
    throw new MarketArgError("--dry-run only prices a swap; it cannot be combined with --serve.");
  }
  if (accessKey !== null) {
    if (accessKey.length < MIN_MARKET_KEY_LENGTH) {
      throw new MarketArgError(
        `--api-key must be at least ${MIN_MARKET_KEY_LENGTH} characters.`,
      );
    }
    if (/\s/.test(accessKey)) {
      throw new MarketArgError("--api-key cannot contain spaces.");
    }
  }
  if (
    !serve &&
    (port !== null ||
      host !== null ||
      corsOrigins.length > 0 ||
      accessKey !== null ||
      rateLimit !== null ||
      limitsPath !== null)
  ) {
    throw new MarketArgError(
      "--port, --host, --cors, --api-key, --rate-limit and --limits-file only apply with --serve.",
    );
  }

  let operation: MarketOperation = { kind: "state" };
  if (buy !== null) operation = { kind: "swap", side: "buy", amount: buy };
  else if (sell !== null) operation = { kind: "swap", side: "sell", amount: sell };
  else if (addQuote !== null || addBase !== null) {
    operation = { kind: "add", quote: addQuote, base: addBase, remove: "" };
  } else if (remove !== null) {
    operation = { kind: "add", quote: null, base: null, remove };
  }

  return {
    poolPath,
    init: initArgs,
    operation,
    force,
    dryRun,
    serve: serve
      ? {
          host: host ?? DEFAULT_MARKET_HOST,
          port: port ?? DEFAULT_MARKET_PORT,
          corsOrigins,
          accessKey,
          rateLimitPerMinute: rateLimit ?? DEFAULT_MARKET_RATE_LIMIT,
          limitsPath: limitsPath ?? (poolPath === null ? null : `${poolPath}.limits.json`),
        }
      : null,
  };
}
