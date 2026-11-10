import type { Address } from "viem";

export interface PriceQuote {
  price: number;
  symbol: string | null;
  /** Source timestamp in epoch seconds, when it provides one. */
  timestamp: number | null;
}

export interface PriceBook {
  /** Lowercased token address → quote. A token the feed cannot price is absent. */
  tokens: Map<string, PriceQuote>;
  native: PriceQuote | null;
  /** Why the last refresh failed; null when it succeeded. */
  error: string | null;
}

export interface PriceSourceOptions {
  /** DefiLlama chain slug, e.g. "xlayer". */
  chainSlug?: string;
  /** Coin id used for the native balance. */
  nativeId?: string;
  baseUrl?: string;
  /** Quotes older than this are refreshed. Default 60 s. */
  ttlMs?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_PRICE_BASE_URL = "https://coins.llama.fi";
export const DEFAULT_PRICE_TTL_MS = 60_000;
/** OKB is the native currency of X Layer; DefiLlama prices it by CoinGecko id. */
export const DEFAULT_NATIVE_PRICE_ID = "coingecko:okb";

const DEFAULT_TIMEOUT_MS = 5000;

/** DefiLlama chain slug for a chain id; null when this kit has no feed for it. */
export function priceChainSlug(chainId: number): string | null {
  return chainId === 196 ? "xlayer" : null;
}

/**
 * USD value of a base-unit balance. Null when the balance, its decimals, or the
 * price is missing, so an unpriced asset never counts as zero.
 */
export function usdValue(
  balance: bigint | null,
  decimals: number | null,
  price: number | null,
): number | null {
  if (balance === null || decimals === null || price === null) return null;
  if (!Number.isFinite(price) || decimals < 0 || decimals > 36) return null;
  return (Number(balance) / 10 ** decimals) * price;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function describePriceError(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return short;
    return error.message;
  }
  return String(error);
}

/**
 * Batched USD prices from DefiLlama's free coins API, cached for a TTL so a
 * watch loop polling every few seconds makes at most one price request a minute.
 * A refresh covers every requested token plus the native balance in one call.
 * Failures never throw: the last known quotes are kept and `error` says why.
 */
export class PriceSource {
  private readonly chainSlug: string;
  private readonly nativeId: string;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  private readonly tokenQuotes = new Map<
    string,
    { quote: PriceQuote | null; at: number }
  >();
  private nativeQuote: { quote: PriceQuote | null; at: number } | null = null;
  private error: string | null = null;

  constructor(options: PriceSourceOptions = {}) {
    this.chainSlug = options.chainSlug ?? "xlayer";
    this.nativeId = options.nativeId ?? DEFAULT_NATIVE_PRICE_ID;
    this.baseUrl = (options.baseUrl ?? DEFAULT_PRICE_BASE_URL).replace(/\/+$/, "");
    this.ttlMs = options.ttlMs ?? DEFAULT_PRICE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async prices(tokens: Address[]): Promise<PriceBook> {
    const unique = [...new Map(tokens.map((token) => [token.toLowerCase(), token])).values()];
    const now = this.now();

    const stale = unique.some((token) => {
      const cached = this.tokenQuotes.get(token.toLowerCase());
      return cached === undefined || now - cached.at >= this.ttlMs;
    });
    const nativeStale = this.nativeQuote === null || now - this.nativeQuote.at >= this.ttlMs;

    if (stale || nativeStale) await this.refresh(unique);

    const quotes = new Map<string, PriceQuote>();
    for (const token of unique) {
      const cached = this.tokenQuotes.get(token.toLowerCase());
      if (cached?.quote) quotes.set(token.toLowerCase(), cached.quote);
    }

    return {
      tokens: quotes,
      native: this.nativeQuote?.quote ?? null,
      error: this.error,
    };
  }

  private async refresh(tokens: Address[]): Promise<void> {
    const keys = [
      ...tokens.map((token) => `${this.chainSlug}:${token.toLowerCase()}`),
      this.nativeId,
    ];
    const url = `${this.baseUrl}/prices/current/${keys.join(",")}`;

    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        this.error = `HTTP ${response.status}`;
        this.markChecked(tokens, this.now());
        return;
      }

      const payload = (await response.json()) as { coins?: unknown };
      const coins = objectOf(payload.coins);
      if (coins === null) {
        this.error = "unexpected response from the price feed";
        this.markChecked(tokens, this.now());
        return;
      }

      // Keys come back in the feed's casing, so compare them lowercased.
      const byKey = new Map<string, Record<string, unknown> | null>();
      for (const [key, value] of Object.entries(coins)) {
        byKey.set(key.toLowerCase(), objectOf(value));
      }

      const at = this.now();
      for (const token of tokens) {
        const raw = byKey.get(`${this.chainSlug}:${token.toLowerCase()}`.toLowerCase()) ?? null;
        const price = numberField(raw?.price);
        this.tokenQuotes.set(token.toLowerCase(), {
          quote: price === null ? null : this.quoteOf(price, raw),
          at,
        });
      }

      const nativeRaw = byKey.get(this.nativeId.toLowerCase()) ?? null;
      const nativePrice = numberField(nativeRaw?.price);
      this.nativeQuote = {
        quote: nativePrice === null ? null : this.quoteOf(nativePrice, nativeRaw),
        at,
      };
      this.error = null;
    } catch (error) {
      this.error = describePriceError(error);
      this.markChecked(tokens, this.now());
    }
  }

  /** Remember that these assets were checked, so a failure waits for the TTL. */
  private markChecked(tokens: Address[], at: number): void {
    for (const token of tokens) {
      const key = token.toLowerCase();
      this.tokenQuotes.set(key, { quote: this.tokenQuotes.get(key)?.quote ?? null, at });
    }
    this.nativeQuote = { quote: this.nativeQuote?.quote ?? null, at };
  }

  private quoteOf(price: number, raw: Record<string, unknown> | null): PriceQuote {
    return {
      price,
      symbol: stringField(raw?.symbol),
      timestamp: numberField(raw?.timestamp),
    };
  }
}
