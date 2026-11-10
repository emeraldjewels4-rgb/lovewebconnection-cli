import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import { MARKET_PAGE_HTML } from "./market-page.ts";
import {
  DEFAULT_MARKET_RATE_LIMIT,
  MarketArgError,
  MarketError,
  MarketPool,
  MIN_MARKET_KEY_LENGTH,
  type MarketCapacity,
  type MarketServeOptions,
  type MarketSide,
  type MarketState,
  type SwapQuote,
  formatMarketAmount,
  parseMarketAmount,
  savePoolFile,
  toMarketJson,
  toSwapQuoteJson,
} from "./market.ts";

/**
 * A small JSON API over one fixed-price pool, so a website can ask for a quote
 * and submit a swap without touching the pool file itself. The server owns the
 * file while it runs: every swap is written back before it is reported, and the
 * in-memory pool is the source of truth until the process stops.
 */

const MAX_BODY_BYTES = 64 * 1024;

/** Failed access-key attempts one client may make before it is blocked. */
const MAX_AUTH_FAILURES = 10;
/** Both the failure window and the block a client earns by filling it. */
const FAILURE_WINDOW_MS = 60_000;
/** The window the per-client request limit is measured over. */
const RATE_WINDOW_MS = 60_000;

/**
 * Compare two secrets without leaking where they differ, or how long they are:
 * both sides are hashed first, so the comparison is fixed-size.
 */
function sameSecret(candidate: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

/** An error that maps straight to an HTTP status. */
export class MarketApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "MarketApiError";
    this.status = status;
    this.code = code;
  }
}

type Headers = Record<string, string>;

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Headers): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, html: string, headers: Headers): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(html);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new MarketApiError(413, `request body is larger than ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) throw new MarketApiError(400, "request body must be JSON.");

  try {
    return JSON.parse(text);
  } catch {
    throw new MarketApiError(400, "request body is not valid JSON.");
  }
}

/** A quote with the same amounts in human units, ready to render. */
function quoteResponse(quote: SwapQuote, state: MarketState, pool: MarketPool) {
  const inDecimals = quote.side === "buy" ? state.quoteDecimals : state.baseDecimals;
  const outDecimals = quote.side === "buy" ? state.baseDecimals : state.quoteDecimals;
  return {
    ...toSwapQuoteJson(quote, state),
    amountInFormatted: formatMarketAmount(quote.amountIn, inDecimals),
    amountOutFormatted: formatMarketAmount(quote.amountOut, outDecimals),
    feeFormatted: formatMarketAmount(quote.fee, inDecimals),
    notionalFormatted: formatMarketAmount(quote.notional, state.quoteDecimals),
    liquidityValueFormatted: formatMarketAmount(state.liquidityValueQuote, state.quoteDecimals),
    executable: quote.executable,
    // What the pool could still settle if this quote were filled, so a page can
    // say how much depth is left instead of guessing from the reserves.
    capacityAfter: capacityJson(pool.capacityAfter(quote)),
  };
}

function capacityJson(capacity: MarketCapacity) {
  return {
    maxBuyBase: capacity.maxBuyBase.toString(),
    maxSellBase: capacity.maxSellBase.toString(),
    payQuote: capacity.payQuote.toString(),
    liquidityValueQuote: capacity.liquidityValueQuote.toString(),
  };
}

function capacityResponse(pool: MarketPool) {
  return capacityJson(pool.capacity());
}

export interface MarketServerInfo {
  /** URL to call, with the port actually bound (useful when `port: 0`). */
  url: string;
  port: number;
}

export class MarketServer {
  private readonly pool: MarketPool;
  private readonly poolPath: string;
  private readonly options: MarketServeOptions;
  /** Where counters are kept between runs; null keeps them in memory only. */
  private readonly limitsPath: string | null;
  private limitsWriteFailed = false;
  private server: Server | null = null;

  constructor(pool: MarketPool, poolPath: string, options: MarketServeOptions) {
    if (options.host.trim().length === 0) {
      throw new MarketArgError("--host cannot be empty.");
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new MarketArgError("--port must be a whole number between 0 and 65535.");
    }
    if (options.accessKey !== null && options.accessKey.length < MIN_MARKET_KEY_LENGTH) {
      throw new MarketArgError(
        `--api-key must be at least ${MIN_MARKET_KEY_LENGTH} characters.`,
      );
    }
    this.pool = pool;
    this.poolPath = poolPath;
    this.options = options;
    this.limitsPath =
      options.limitsPath === undefined ? `${poolPath}.limits.json` : options.limitsPath;
    this.loadLimits();
  }

  listen(): Promise<MarketServerInfo> {
    if (this.server !== null) {
      return Promise.reject(new MarketApiError(500, "the market api is already listening."));
    }

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    return new Promise<MarketServerInfo>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        this.server = null;
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const address = server.address();
        const port =
          typeof address === "object" && address !== null ? address.port : this.options.port;
        const wildcard = this.options.host === "0.0.0.0" || this.options.host === "::";
        const host = wildcard ? "127.0.0.1" : this.options.host;
        resolve({ url: `http://${host}:${port}`, port });
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host);
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.saveLimits();
    if (server === null) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // A browser keeps connections alive; do not wait for them to time out.
      server.closeAllConnections();
    });
  }

  /** True while the listener is accepting requests. */
  get listening(): boolean {
    return this.server !== null;
  }

  /** Requests and failed key attempts per client. */
  private readonly clients = new Map<
    string,
    { hits: number[]; failures: number[]; blockedUntil: number }
  >();

  /**
   * Read the counters a previous run left behind. A missing, corrupt or expired
   * file is not an error: the API simply starts with a clean slate.
   */
  private loadLimits(): void {
    const path = this.limitsPath;
    if (path === null) return;

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }

    try {
      const parsed = JSON.parse(text) as { clients?: unknown };
      const clients = parsed.clients;
      if (typeof clients !== "object" || clients === null) return;

      const now = Date.now();
      for (const [address, value] of Object.entries(clients as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        const hits = Array.isArray(record.hits)
          ? record.hits.filter(
              (at): at is number => typeof at === "number" && now - at < RATE_WINDOW_MS,
            )
          : [];
        const failures = Array.isArray(record.failures)
          ? record.failures.filter(
              (at): at is number => typeof at === "number" && now - at < FAILURE_WINDOW_MS,
            )
          : [];
        const blockedUntil =
          typeof record.blockedUntil === "number" && record.blockedUntil > now
            ? record.blockedUntil
            : 0;
        if (hits.length === 0 && failures.length === 0 && blockedUntil === 0) continue;
        this.clients.set(address, { hits, failures, blockedUntil });
      }
    } catch {
      // A half-written file is not worth failing a startup over.
    }
  }

  /** Write the counters back, pruning anything that can no longer matter. */
  private saveLimits(): void {
    const path = this.limitsPath;
    if (path === null) return;

    const now = Date.now();
    const clients: Record<
      string,
      { hits: number[]; failures: number[]; blockedUntil: number }
    > = {};
    for (const [address, record] of this.clients) {
      const hits = record.hits.filter((at) => now - at < RATE_WINDOW_MS);
      const failures = record.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
      const blockedUntil = record.blockedUntil > now ? record.blockedUntil : 0;
      if (hits.length === 0 && failures.length === 0 && blockedUntil === 0) continue;
      clients[address] = { hits, failures, blockedUntil };
    }

    try {
      writeFileSync(path, `${JSON.stringify({ version: 1, clients }, null, 2)}\n`);
    } catch (error) {
      // A read-only directory is a supported place to run: warn once, keep going.
      if (!this.limitsWriteFailed) {
        this.limitsWriteFailed = true;
        console.error(
          `lwc: cannot write ${path} (${error instanceof Error ? error.message : String(error)}); rate limits stay in memory.`,
        );
      }
    }
  }

  private corsHeaders(origin: string | undefined): Headers {
    const allowed = this.options.corsOrigins;
    if (allowed.length === 0) return {};

    const any = allowed.includes("*");
    if (!any && (origin === undefined || !allowed.includes(origin))) {
      // No header: the browser refuses the response, which is the point.
      return {};
    }

    return {
      "access-control-allow-origin": any ? "*" : (origin as string),
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-market-key, authorization",
      "access-control-max-age": "600",
      vary: "origin",
    };
  }

  /** True when no key is configured, or the request carries the right one. */
  private authorized(request: IncomingMessage, url: URL): boolean {
    const expected = this.options.accessKey;
    if (expected === null) return true;

    const header = request.headers["x-market-key"];
    const supplied = Array.isArray(header) ? header[0] : header;
    if (typeof supplied === "string" && sameSecret(supplied, expected)) return true;

    const authorization = request.headers.authorization;
    if (typeof authorization === "string" && /^bearer /i.test(authorization)) {
      const token = authorization.slice(7).trim();
      if (token !== "" && sameSecret(token, expected)) return true;
    }

    // A plain link cannot send a header, so the query string is accepted too; the
    // page moves the key into sessionStorage and removes it from the address bar.
    const query = url.searchParams.get("key");
    return query !== null && sameSecret(query, expected);
  }

  private clientRecord(address: string) {
    let record = this.clients.get(address);
    if (record === undefined) {
      record = { hits: [], failures: [], blockedUntil: 0 };
      this.clients.set(address, record);
    }
    return record;
  }

  /** Seconds this client must wait for guessing the key, or 0 when it may try. */
  private blockedSeconds(address: string): number {
    const record = this.clients.get(address);
    if (record === undefined) return 0;

    const now = Date.now();
    if (record.blockedUntil > now) return Math.ceil((record.blockedUntil - now) / 1000);

    record.failures = record.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    if (record.failures.length < MAX_AUTH_FAILURES) return 0;

    record.blockedUntil = now + FAILURE_WINDOW_MS;
    record.failures = [];
    this.saveLimits();
    return Math.ceil(FAILURE_WINDOW_MS / 1000);
  }

  private noteFailure(address: string): void {
    const record = this.clientRecord(address);
    const now = Date.now();
    record.failures = record.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    record.failures.push(now);
    this.saveLimits();
  }

  /** Seconds until this client may make another request, or 0 for this one. */
  private rateLimitWait(address: string): number {
    const limit = this.options.rateLimitPerMinute ?? DEFAULT_MARKET_RATE_LIMIT;
    if (limit <= 0) return 0;

    const record = this.clientRecord(address);
    const now = Date.now();
    record.hits = record.hits.filter((at) => now - at < RATE_WINDOW_MS);
    if (record.hits.length >= limit) {
      const oldest = record.hits[0] ?? now;
      return Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000));
    }

    record.hits.push(now);
    this.saveLimits();
    return 0;
  }

  private amountFor(side: MarketSide, value: string, state: MarketState): bigint {
    const decimals = side === "buy" ? state.quoteDecimals : state.baseDecimals;
    try {
      return parseMarketAmount(value, decimals, "amount");
    } catch (error) {
      if (error instanceof MarketArgError) throw new MarketApiError(400, error.message);
      throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cors = this.corsHeaders(request.headers.origin);
    const method = request.method ?? "GET";

    if (method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      sendJson(response, 400, { error: "the request URL is not valid." }, cors);
      return;
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    // The page shell carries no pool data, so it stays reachable: it is where a
    // browser enters the key. Every route that reads or moves the pool needs it.
    const publicRoute = path === "/" || path === "/favicon.ico";
    const address = request.socket.remoteAddress ?? "unknown";

    if (!publicRoute) {
      const blocked = this.blockedSeconds(address);
      if (blocked > 0) {
        sendJson(
          response,
          429,
          {
            error: "too many failed access key attempts; try again shortly.",
            code: "too-many-attempts",
          },
          { ...cors, "retry-after": String(blocked) },
        );
        return;
      }
    }

    if (!publicRoute && !this.authorized(request, url)) {
      this.noteFailure(address);
      sendJson(
        response,
        401,
        { error: "an access key is required.", code: "unauthorized" },
        cors,
      );
      return;
    }

    if (!publicRoute) {
      const wait = this.rateLimitWait(address);
      if (wait > 0) {
        sendJson(
          response,
          429,
          { error: "too many requests; slow down.", code: "rate-limited" },
          { ...cors, "retry-after": String(wait) },
        );
        return;
      }
    }

    const state = this.pool.state();

    try {
      if (method === "GET" && path === "/") {
        sendHtml(response, MARKET_PAGE_HTML, cors);
        return;
      }

      if (method === "GET" && path === "/favicon.ico") {
        response.writeHead(204, cors);
        response.end();
        return;
      }

      if (method === "GET" && path === "/health") {
        sendJson(
          response,
          200,
          {
            ok: true,
            service: "lwc market",
            price: state.price,
            base: state.baseSymbol,
            quote: state.quoteSymbol,
            feeBps: state.feeBps,
          },
          cors,
        );
        return;
      }

      if (method === "GET" && path === "/market") {
        sendJson(
          response,
          200,
          { ...toMarketJson(state, this.poolPath), capacity: capacityResponse(this.pool) },
          cors,
        );
        return;
      }

      if (method === "GET" && path === "/quote") {
        const side = url.searchParams.get("side");
        if (side !== "buy" && side !== "sell") {
          throw new MarketApiError(400, "side must be buy or sell.");
        }
        const amount = url.searchParams.get("amount");
        if (amount === null) throw new MarketApiError(400, "amount is required.");

        const quote = this.pool.quote(side, this.amountFor(side, amount, state));
        sendJson(response, 200, quoteResponse(quote, state, this.pool), cors);
        return;
      }

      if (path === "/swap") {
        if (method !== "POST") {
          sendJson(
            response,
            405,
            { error: "swap is a POST route." },
            { ...cors, allow: "POST" },
          );
          return;
        }

        const body = await readJsonBody(request);
        if (typeof body !== "object" || body === null) {
          throw new MarketApiError(400, "the body must be a JSON object.");
        }

        const record = body as Record<string, unknown>;
        const side = record.side;
        if (side !== "buy" && side !== "sell") {
          throw new MarketApiError(400, "side must be buy or sell.");
        }

        const rawAmount = record.amount;
        if (typeof rawAmount !== "string" && typeof rawAmount !== "number") {
          throw new MarketApiError(400, "amount must be a decimal string.");
        }

        const amount = this.amountFor(side, String(rawAmount), state);

        let filled;
        try {
          filled = this.pool.swap(side, amount);
        } catch (error) {
          if (error instanceof MarketError) {
            // The quote already explains the refusal; hand it back with the error.
            const quote = quoteResponse(this.pool.quote(side, amount), state, this.pool);
            sendJson(response, 422, { error: error.message, code: error.code, quote }, cors);
            return;
          }
          throw error;
        }

        savePoolFile(this.poolPath, this.pool, { force: true });
        sendJson(
          response,
          201,
          {
            ...quoteResponse(filled, state, this.pool),
            state: {
              ...toMarketJson(this.pool.state(), this.poolPath),
              capacity: capacityResponse(this.pool),
            },
          },
          cors,
        );
        return;
      }

      sendJson(response, 404, { error: `no route for ${method} ${path}.` }, cors);
    } catch (error) {
      if (error instanceof MarketApiError) {
        sendJson(
          response,
          error.status,
          { error: error.message, ...(error.code === null ? {} : { code: error.code }) },
          cors,
        );
        return;
      }
      sendJson(
        response,
        500,
        { error: error instanceof Error ? error.message : String(error) },
        cors,
      );
    }
  }
}
