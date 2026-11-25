import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PROBE_CACHE_MS } from "../explorer/lookup-state.js";

/**
 * Browser-level coverage for the explorer page. A local HTTP server serves the
 * real page files and answers rpc.php with fixed results, so the test needs no
 * chain endpoints. The page is driven through a headless Chromium-family
 * browser over the DevTools protocol, using Node's built-in WebSocket.
 *
 * Set CHROME_PATH to a Chrome, Edge or Chromium binary when none of the usual
 * locations has one; without a browser the test is skipped.
 */

const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const PROXY = "0x1111111111111111111111111111111111111111";
const EOA = `0x${"33".repeat(20)}`;
const MISSING_BLOCK = "0xffffffff";
const IMPLEMENTATION = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"12".repeat(32)}`;
const FROM = `0x${"aa".repeat(20)}`;
const EIP1967_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ERC20 = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
};
const DELAYED_BLOCK = "0x121eac0"; // 19,000,000, the block the test looks up
// The same window explorer/rpc.php counts per address, so a page that made more
// calls than the real proxy allows inside a minute is refused here too.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
// A page that boots and probes all six presets is twelve calls, and the stub shares
// its CPU with every other suite file. Alone that finishes in about a second, but
// under a full `npm test` the same load has been seen past ten, so a page-state
// wait gets a deadline that a busy machine can meet and a broken page still cannot.
const PAGE_READY_MS = 60_000;
// The same ten methods explorer/rpc.php allows. The stub refuses everything else so a
// page change that asks for a shape the real proxy rejects fails here as well.
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_call",
]);

type SocketEvent = { data: unknown };
type Socket = {
  addEventListener(
    type: "open" | "message" | "error",
    listener: (event: SocketEvent) => void,
    options?: { once?: boolean },
  ): void;
  send(data: string): void;
  close(): void;
};

const WebSocketCtor = (
  globalThis as unknown as { WebSocket?: new (url: string) => Socket }
).WebSocket;

function browserCandidates(): string[] {
  const candidates: Array<string | undefined> = [process.env.CHROME_PATH];
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  return candidates.filter((value): value is string => Boolean(value));
}

const browserPath = browserCandidates().find((candidate) => existsSync(candidate)) ?? null;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class Session {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: { message?: string };
        result?: unknown;
      };
      if (typeof message.id !== "number") return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "cdp error"));
      else waiter.resolve(message.result);
    });
  }

  send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send<{
      result: { value: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (answer.exceptionDetails) {
      throw new Error(
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "evaluate failed",
      );
    }
    return answer.result.value;
  }

  close(): void {
    this.socket.close();
  }
}

async function connect(url: string): Promise<Session> {
  if (!WebSocketCtor) throw new Error("this Node build has no global WebSocket");
  const socket = new WebSocketCtor(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the browser did not answer the DevTools socket")),
      15_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("could not connect to the browser"));
      },
      { once: true },
    );
  });
  return new Session(socket);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(session: Session, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = await session.evaluate<string>(`document.getElementById("status").textContent`);
    if (pattern.test(text)) return text;
    await sleep(50);
  }
  throw new Error(`status never matched ${pattern}`);
}

async function waitFor(session: Session, expression: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await session.evaluate<boolean>(expression)) return;
    } catch {
      // The page can be mid-navigation; try again.
    }
    await sleep(100);
  }
  // The expression alone does not say why it timed out: a table still waiting on
  // probes, a table whose rows all failed, and a page that never booted are
  // different problems. Report the page's own state with the timeout.
  let state: string;
  try {
    state = await session.evaluate<string>(
      `(() => {
        const summary = document.getElementById("summary")?.textContent ?? "";
        const rows = document.getElementById("chains")?.innerText ?? "";
        const stuck = performance
          .getEntriesByType("resource")
          .filter((entry) => entry.responseEnd === 0)
          .map((entry) => entry.name.replace(location.origin, ""));
        return \`ready=\${document.readyState} summary="\${summary}" rows="\${rows.slice(0, 600)}" unfinished=\${JSON.stringify(stuck.slice(0, 8))}\`;
      })()`,
    );
  } catch {
    state = "(the page could not be read)";
  }
  throw new Error(`timed out waiting for: ${expression}; ${state}`);
}

function abiString(text: string): string {
  const data = Buffer.from(text, "utf8").toString("hex");
  const offset = (32).toString(16).padStart(64, "0");
  const length = BigInt(data.length / 2).toString(16).padStart(64, "0");
  return `0x${offset}${length}${data.padEnd(64, "0")}`;
}

function answer(method: string, params: unknown[], chainId: number): unknown {
  switch (method) {
    case "eth_chainId":
      return `0x${chainId.toString(16)}`;
    case "eth_blockNumber":
      return "0x121eac1";
    case "eth_getBlockByNumber": {
      if (params[0] === MISSING_BLOCK) return null;
      const number = BigInt(String(params[0]));
      return {
        number: `0x${number.toString(16)}`,
        hash: `0x${"ab".repeat(32)}`,
        parentHash: `0x${"cd".repeat(32)}`,
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
        transactions: [],
        gasUsed: "0x5208",
        gasLimit: "0x1c9c380",
        baseFeePerGas: "0x3b9aca00",
        miner: `0x${"11".repeat(20)}`,
        size: "0x220",
      };
    }
    case "eth_getBalance":
      return "0x0";
    case "eth_getTransactionCount":
      return "0x1";
    case "eth_getCode":
      return [TOKEN, PROXY].includes(String(params[0]).toLowerCase()) ? "0x6080604052" : "0x";
    case "eth_call": {
      const call = params[0] as { data?: string } | undefined;
      const data = call?.data ?? "";
      if (data.startsWith(ERC20.name)) return abiString("USD Coin");
      if (data.startsWith(ERC20.symbol)) return abiString("USDC");
      if (data.startsWith(ERC20.decimals)) return `0x${"0".repeat(63)}6`;
      if (data.startsWith(ERC20.totalSupply)) return `0x${1234567890000n.toString(16).padStart(64, "0")}`;
      return "0x";
    }
    case "eth_getTransactionByHash":
      return params[0] === TX_HASH
        ? {
            from: FROM,
            to: TOKEN,
            value: "0xde0b6b3a7640000",
            blockNumber: "0x121eac0",
            nonce: "0x7",
            gasPrice: "0x3b9aca00",
            hash: TX_HASH,
          }
        : null;
    case "eth_getTransactionReceipt":
      return params[0] === TX_HASH
        ? { status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" }
        : null;
    case "eth_getStorageAt": {
      const [account, slot] = params as [string, string, string];
      if (account.toLowerCase() === PROXY && slot.toLowerCase() === EIP1967_IMPLEMENTATION) {
        return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2)}`;
      }
      return `0x${"0".repeat(64)}`;
    }
    default:
      return null;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

/** The body explorer/rpc.php sends with a refusal, so the page's error path is real. */
function rpcError(message: string): unknown {
  return { jsonrpc: "2.0", id: null, error: { code: -32600, message } };
}

/**
 * The gate explorer/rpc.php applies before anything else but the method: the
 * caller must be the page the proxy is served with, so an Origin naming this host
 * (port included) or a `Sec-Fetch-Site: same-origin` signal. A script sends
 * neither and is refused.
 */
function fromExplorer(request: IncomingMessage): boolean {
  const host = String(request.headers.host ?? "").toLowerCase();
  if (host === "") return false;
  const origin = String(request.headers.origin ?? "");
  if (origin !== "") {
    try {
      // URL.host carries the port when the origin names one, as the real proxy's
      // host-and-port comparison does.
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  return request.headers["sec-fetch-site"] === "same-origin";
}

/**
 * The sixty-calls-a-minute counter explorer/rpc.php keeps per address, held in
 * memory rather than one locked temp file. It counts every POST that reaches it,
 * refusals included, because the real proxy counts before it looks at the body.
 */
function rateLimited(
  counters: Map<string, { start: number; count: number }>,
  request: IncomingMessage,
): { limited: boolean; retryAfter: number } {
  const address = request.socket.remoteAddress ?? "";
  if (address === "") return { limited: false, retryAfter: 0 };
  const now = Date.now();
  const state = counters.get(address) ?? { start: now, count: 0 };
  if (now - state.start >= RATE_WINDOW_MS) {
    state.start = now;
    state.count = 0;
  }
  if (state.count >= RATE_LIMIT) {
    return {
      limited: true,
      retryAfter: Math.max(1, Math.ceil((state.start + RATE_WINDOW_MS - now) / 1000)),
    };
  }
  state.count += 1;
  counters.set(address, state);
  return { limited: false, retryAfter: 0 };
}

function stopBrowser(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    // The detached browser leads its own process group, so this reaches helpers too.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function launchBrowser(
  executable: string,
): Promise<{ child: ChildProcess; wsUrl: string; profile: string; logPath: string }> {
  return new Promise((resolve, reject) => {
    const stamp = `${process.pid}-${Date.now()}`;
    const profile = join(tmpdir(), `lwc-explorer-${stamp}`);
    const logPath = join(tmpdir(), `lwc-explorer-${stamp}.log`);
    // A pipe is inherited by Chrome's helper processes and can outlive the test,
    // keeping Node alive. A file carries the same DevTools line without a handle.
    const logFd = openSync(logPath, "w");
    const child = spawn(
      executable,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        ...(process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", logFd],
        detached: process.platform !== "win32",
      },
    );
    closeSync(logFd);

    let settled = false;
    let wsUrl = "";
    let timer: NodeJS.Timeout | null = null;
    let poller: NodeJS.Timeout | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      if (error) {
        stopBrowser(child);
        reject(error);
        return;
      }
      resolve({ child, wsUrl, profile, logPath });
    };

    poller = setInterval(() => {
      try {
        const match = readFileSync(logPath, "utf8").match(/DevTools listening on (ws:\/\/\S+)/);
        if (match?.[1]) {
          wsUrl = match[1];
          finish();
        }
      } catch {
        // The log appears as soon as the browser starts writing.
      }
    }, 100);

    timer = setTimeout(
      () => finish(new Error("the browser did not report a DevTools endpoint")),
      20_000,
    );
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(new Error(`the browser exited with code ${code}`)));
  });
}

test(
  "explorer deep links, history and lookup cancellation work in a browser",
  {
    skip: process.env.LWC_SKIP_BROWSER
      ? "run by the dedicated browser step"
      : browserPath
        ? false
        : "no Chrome, Edge or Chromium found; set CHROME_PATH",
    timeout: 180_000,
  },
  async () => {
    assert.ok(browserPath);
    // Stage markers make a CI hang locatable, and the watchdog makes sure a
    // stuck browser cannot hold the job open past its own timeout.
    const stage = (message: string) => console.log(`[explorer-browser] ${message}`);
    const watchdog = setTimeout(() => {
      console.error("[explorer-browser] watchdog expired");
      process.exit(1);
    }, 150_000);
    watchdog.unref();
    stage("starting");
    const explorerDir = fileURLToPath(new URL("../explorer/", import.meta.url));
    const presets = JSON.parse(
      await readFile(join(explorerDir, "presets.json"), "utf8"),
    ) as { chains: Array<{ name: string; chainId: number }> };
    const chainIds = new Map(presets.chains.map((chain) => [chain.name, chain.chainId]));

    // The methods the stub answered, so a test can tell a cached probe from a fresh
    // one by the calls it did not make.
    const stats: { delayed: number; aborted: number; counts: Record<string, number> } = {
      delayed: 0,
      aborted: 0,
      counts: {},
    };
    const files = new Map<string, { body: Buffer; type: string }>();
    for (const [route, name, type] of [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/index.html", "index.html", "text/html; charset=utf-8"],
      ["/app.js", "app.js", "text/javascript; charset=utf-8"],
      ["/lookup-state.js", "lookup-state.js", "text/javascript; charset=utf-8"],
      ["/presets.json", "presets.json", "application/json; charset=utf-8"],
      ["/style.css", "style.css", "text/css; charset=utf-8"],
    ] as const) {
      files.set(route, { body: await readFile(join(explorerDir, name)), type });
    }

    // One window per address, as rpc.php has one file per address.
    const rateCounters = new Map<string, { start: number; count: number }>();

    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__stats") {
        sendJson(response, stats);
        return;
      }
      if (url.pathname === "/__reset-rate") {
        // A test control, not part of the proxy: the test runs a minute's worth of
        // lookups in seconds, so it clears the window where a visitor would have
        // waited the minute out.
        rateCounters.clear();
        sendJson(response, { ok: true });
        return;
      }
      if (url.pathname === "/rpc.php") {
        if (request.method !== "POST") {
          sendJson(response, rpcError("use POST"), 405);
          return;
        }
        // Ordered as the real proxy orders them, so the stub's 403 is reachable
        // only for a caller that would reach the real one's 403 as well, and the
        // counter sees the same calls the real one counts.
        if (!fromExplorer(request)) {
          sendJson(
            response,
            rpcError("this proxy answers the explorer page it is served with, not other callers"),
            403,
          );
          return;
        }
        const allowance = rateLimited(rateCounters, request);
        if (allowance.limited) {
          response.setHeader("retry-after", String(allowance.retryAfter));
          sendJson(
            response,
            rpcError(
              `too many calls from this address; try again in ${allowance.retryAfter} seconds`,
            ),
            429,
          );
          return;
        }
        if (!String(request.headers["content-type"] ?? "").includes("application/json")) {
          sendJson(response, rpcError("content-type must be application/json"), 415);
          return;
        }
        const body = JSON.parse(await readBody(request)) as { method: string; params?: unknown[] };
        stats.counts[body.method] = (stats.counts[body.method] ?? 0) + 1;
        const chainId = chainIds.get(url.searchParams.get("chain") ?? "") ?? 1;
        const params = body.params ?? [];

        if (!READ_METHODS.has(body.method)) {
          sendJson(response, rpcError("that method is not part of the explorer's read-only set"), 400);
          return;
        }
        // The page reads a block for its header and its transaction count, so the
        // real proxy refuses the full-transaction shape; so does this stub.
        if (body.method === "eth_getBlockByNumber" && params[1] !== false) {
          sendJson(
            response,
            rpcError("blocks are read with their transactions as hashes, so the second param must be false"),
            400,
          );
          return;
        }

        if (body.method === "eth_getBlockByNumber" && params[0] === DELAYED_BLOCK) {
          stats.delayed += 1;
          const timer = setTimeout(() => {
            sendJson(response, {
              jsonrpc: "2.0",
              id: 1,
              result: answer(body.method, params, chainId),
            });
          }, 1500);
          response.on("close", () => {
            if (response.writableEnded) return;
            clearTimeout(timer);
            stats.aborted += 1;
          });
          return;
        }

        sendJson(response, { jsonrpc: "2.0", id: 1, result: answer(body.method, params, chainId) });
        return;
      }

      const file = files.get(url.pathname);
      if (file) {
        response.writeHead(200, { "content-type": file.type });
        response.end(file.body);
        return;
      }
      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the stub server did not start")), 10_000);
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    stage("stub server ready");

    const { child, wsUrl, profile, logPath } = await launchBrowser(browserPath!);
    stage("browser launched");
    const port = new URL(wsUrl).port;
    // Without a timeout this request can wait forever when Chrome accepts the
    // DevTools port but has not finished starting its HTTP endpoint.
    const target = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(15_000),
    }).then((response) => response.json())) as { webSocketDebuggerUrl: string };
    const session = await connect(target.webSocketDebuggerUrl);
    stage("devtools connected");

    try {
      await session.send("Page.enable");
      await session.send("Runtime.enable");
      await session.send("Page.navigate", {
        url: `${base}/?chain=ethereum&type=token&q=${TOKEN}`,
      });

      await waitFor(
        session,
        `document.readyState === "complete" && document.getElementById("result").innerText.includes("USD Coin")`,
        PAGE_READY_MS,
      );
      stage("deep link rendered");
      const deepLink = await session.evaluate<{ kind: string; chain: string; search: string }>(
        `({ kind: document.getElementById("kind").value, chain: document.getElementById("chain").value, search: location.search })`,
      );
      assert.equal(deepLink.chain, "ethereum");
      assert.equal(deepLink.kind, "token");
      assert.match(deepLink.search, /type=token/);

      const tokenText = await session.evaluate<string>(`document.getElementById("result").innerText`);
      assert.match(tokenText, /USDC · USD Coin/);
      assert.match(tokenText, /Decimals\s+6/);
      assert.match(tokenText, /Total supply\s+1,234,567\.89 USDC/);
      assert.match(tokenText, /Contract\s+5 bytes of code/);

      // The stub mirrors explorer/rpc.php, so its refusal branches are only
      // exercised by something that asks for a refused shape. The page never does;
      // this asks from the page's own origin and checks the answers a reader would
      // get, including the wording rpc() would print in the status line.
      const refusals = await session.evaluate<Array<{ status: number; message: string }>>(`
        (async () => {
          const ask = async (init) => {
            const response = await fetch("rpc.php?chain=ethereum", init);
            const body = await response.json();
            return { status: response.status, message: body.error?.message ?? "" };
          };
          const json = { "content-type": "application/json" };
          const call = (method, params) =>
            JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
          return [
            await ask({ method: "GET" }),
            await ask({ method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }),
            await ask({ method: "POST", headers: json, body: call("eth_feeHistory", []) }),
            await ask({ method: "POST", headers: json, body: call("eth_getBlockByNumber", ["latest", true]) }),
          ];
        })()
      `);
      assert.deepEqual(
        refusals.map((refusal) => refusal.status),
        [405, 415, 400, 400],
        "the stub must refuse what the real proxy refuses",
      );
      const refusalMessages = refusals.map((refusal) => refusal.message).join("\n");
      assert.match(refusalMessages, /use POST/);
      assert.match(refusalMessages, /application\/json/);
      assert.match(refusalMessages, /read-only set/);
      assert.match(refusalMessages, /second param must be false/);

      // The origin gate cannot be probed from the page: a browser attaches Origin
      // (and Sec-Fetch-Site) to its own POSTs and forbids a script from setting
      // either, so the caller that gets 403 has to be one from outside the page.
      const outside = await fetch(`${base}/rpc.php?chain=ethereum`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      assert.equal(outside.status, 403, "the stub must refuse a caller that is not the page");
      assert.match(await outside.text(), /answers the explorer page it is served with/);

      // The page counts against the same window, so the probe gets one of its own,
      // and the page goes on in a fresh one afterwards — what waiting out the minute
      // would give it. Everything the page does after this is inside the sixty.
      await fetch(`${base}/__reset-rate`, { method: "POST" });
      const limiter = await session.evaluate<{
        allowed: number[];
        status: number;
        retryAfter: number;
        message: string;
      }>(`
        (async () => {
          const send = () =>
            fetch("rpc.php?chain=ethereum", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
            });
          const allowed = [];
          for (let index = 1; index <= ${RATE_LIMIT}; index += 1) {
            allowed.push((await send()).status);
          }
          const refused = await send();
          const body = await refused.json();
          return {
            allowed,
            status: refused.status,
            retryAfter: Number(refused.headers.get("retry-after")),
            message: body.error?.message ?? "",
          };
        })()
      `);
      assert.deepEqual(
        limiter.allowed.filter((status) => status !== 200),
        [],
        "the first sixty calls in the window are answered",
      );
      assert.equal(limiter.status, 429, "the sixty-first call in the window is refused");
      assert.ok(limiter.retryAfter > 0, "the refusal carries Retry-After");
      assert.match(limiter.message, /too many calls from this address/);
      await fetch(`${base}/__reset-rate`, { method: "POST" });
      stage("stub refusals checked");

      await session.evaluate(
        `(() => {
          const kind = document.getElementById("kind");
          kind.value = "block";
          kind.dispatchEvent(new Event("change"));
          document.getElementById("query").value = "19000000";
          document.getElementById("lookup").requestSubmit();
          return true;
        })()`,
      );
      await waitFor(
        session,
        `document.getElementById("result").innerText.includes("Block 19,000,000")`,
        PAGE_READY_MS,
      );
      assert.match(await session.evaluate<string>("location.search"), /type=block/);

      await session.evaluate("history.back()");
      await waitFor(
        session,
        `location.search.includes("type=token") && document.getElementById("result").innerText.includes("USD Coin")`,
        PAGE_READY_MS,
      );
      assert.equal(await session.evaluate<string>(`document.getElementById("kind").value`), "token");

      await session.evaluate(
        `(() => {
          const kind = document.getElementById("kind");
          kind.value = "transaction";
          kind.dispatchEvent(new Event("change"));
          document.getElementById("query").value = "${TX_HASH}";
          document.getElementById("lookup").requestSubmit();
          return true;
        })()`,
      );
      await waitFor(
        session,
        `document.getElementById("result").innerText.includes("Transaction")`,
        PAGE_READY_MS,
      );
      const transactionText = await session.evaluate<string>(`document.getElementById("result").innerText`);
      assert.match(transactionText, /Transaction 0x1212/);
      assert.match(transactionText, /succeeded/);
      assert.match(transactionText, /From\s+0xaaaa/i);
      assert.match(transactionText, /To\s+0xa0b8/i);
      assert.match(transactionText, /Value\s+1 ETH/);
      assert.match(transactionText, /Block\s+19,000,000/);
      assert.match(transactionText, /Confirmations\s+2/);
      assert.match(transactionText, /Fee\s+0\.000021 ETH/);
      assert.match(await session.evaluate<string>("location.search"), /type=transaction/);

      await session.evaluate(
        `(() => {
          const kind = document.getElementById("kind");
          kind.value = "address";
          kind.dispatchEvent(new Event("change"));
          document.getElementById("query").value = "${TOKEN}";
          document.getElementById("lookup").requestSubmit();
          return true;
        })()`,
      );
      await waitFor(session, `document.getElementById("result").innerText.includes("Balance")`, PAGE_READY_MS);
      const addressText = await session.evaluate<string>(`document.getElementById("result").innerText`);
      assert.match(addressText, /Balance\s+0 ETH/);
      assert.match(addressText, /Nonce\s+1/);
      assert.match(addressText, /Contract\s+yes · 5 bytes of code/);
      assert.match(await session.evaluate<string>("location.search"), /type=address/);

      await session.evaluate(
        `(() => {
          const kind = document.getElementById("kind");
          kind.value = "contract";
          kind.dispatchEvent(new Event("change"));
          document.getElementById("query").value = "${PROXY}";
          document.getElementById("lookup").requestSubmit();
          return true;
        })()`,
      );
      await waitFor(
        session,
        `document.getElementById("result").innerText.includes("proxy (EIP-1967)")`,
        PAGE_READY_MS,
      );
      const contractText = await session.evaluate<string>(`document.getElementById("result").innerText`);
      assert.match(contractText, /Code\s+5 bytes/);
      assert.match(contractText, /Kind\s+proxy \(EIP-1967\)/);
      assert.match(contractText, /Implementation\s+0x2222/);
      assert.match(await session.evaluate<string>("location.search"), /type=contract/);

      await session.evaluate(
        `(() => {
          const kind = document.getElementById("kind");
          kind.value = "block";
          kind.dispatchEvent(new Event("change"));
          document.getElementById("query").value = "19000000";
          document.getElementById("lookup").requestSubmit();
          return true;
        })()`,
      );
      await sleep(200);
      await session.evaluate(
        `(() => {
          const kind = document.getElementById("kind");
          kind.value = "address";
          kind.dispatchEvent(new Event("change"));
          document.getElementById("query").value = "${TOKEN}";
          document.getElementById("lookup").requestSubmit();
          return true;
        })()`,
      );

      await waitFor(session, `document.getElementById("result").innerText.includes("Balance")`, PAGE_READY_MS);
      await sleep(2000);
      const finalText = await session.evaluate<string>(`document.getElementById("result").innerText`);
      assert.match(finalText, /Balance/, "the address lookup stays on screen");
      assert.doesNotMatch(finalText, /Block 19,000,000/, "the aborted block never rendered");
      assert.match(await session.evaluate<string>("location.search"), /type=address/);

      const counts = (await fetch(`${base}/__stats`, {
        signal: AbortSignal.timeout(10_000),
      }).then((response) => response.json())) as {
        delayed: number;
        aborted: number;
      };
      assert.ok(counts.delayed >= 2, "the page requested the delayed block");
      assert.ok(counts.aborted >= 1, "the superseded block request was aborted at the server");
      stage("cancellation verified");

      await session.evaluate(
        `(() => {
          const kind = document.getElementById("kind");
          kind.value = "block";
          kind.dispatchEvent(new Event("change"));
          document.getElementById("query").value = "4294967295";
          document.getElementById("lookup").requestSubmit();
          return true;
        })()`,
      );
      await waitFor(
        session,
        `document.getElementById("status").textContent.includes("no block")`,
        PAGE_READY_MS,
      );
      assert.match(
        await session.evaluate<string>(`document.getElementById("status").textContent`),
        /no block 0xffffffff on ethereum/,
      );
      assert.equal(await session.evaluate<boolean>(`document.getElementById("result").hidden`), true);
      assert.equal(await session.evaluate<boolean>(`document.getElementById("go").disabled`), false);
      assert.match(await session.evaluate<string>("location.search"), /type=block/);

      await session.evaluate(
        `(() => {
          const kind = document.getElementById("kind");
          kind.value = "contract";
          kind.dispatchEvent(new Event("change"));
          document.getElementById("query").value = "${EOA}";
          document.getElementById("lookup").requestSubmit();
          return true;
        })()`,
      );
      await waitFor(
        session,
        `document.getElementById("status").textContent.includes("no contract")`,
        PAGE_READY_MS,
      );
      assert.match(
        await session.evaluate<string>(`document.getElementById("status").textContent`),
        /no contract at 0x33333333/,
      );
      assert.equal(await session.evaluate<boolean>(`document.getElementById("result").hidden`), true);
      assert.match(await session.evaluate<string>("location.search"), /type=contract/);

      const beforeValidation = await session.evaluate<string>("location.search");
      const submit = (kind: string, query: string) =>
        session.evaluate(
          `(() => {
            const kind = document.getElementById("kind");
            kind.value = ${JSON.stringify(kind)};
            kind.dispatchEvent(new Event("change"));
            document.getElementById("query").value = ${JSON.stringify(query)};
            document.getElementById("lookup").requestSubmit();
            return true;
          })()`,
        );
      const invalid: Array<[string, string, RegExp]> = [
        ["auto", "", /enter a value to look up/],
        ["auto", "not-a-lookup", /not a block number, 20-byte address or 32-byte transaction hash/],
        ["transaction", "0x1234", /a transaction hash is 32 bytes of hex/],
        ["address", "0xnope", /an address is 20 bytes of hex/],
        ["block", "abc", /a block is a decimal number or a 0x quantity/],
      ];
      for (const [kind, query, expected] of invalid) {
        await submit(kind, query);
        const status = await waitForStatus(session, expected);
        assert.match(status, expected);
        assert.equal(await session.evaluate<boolean>(`document.getElementById("result").hidden`), true);
        assert.equal(await session.evaluate<string>("location.search"), beforeValidation);
      }

      // A cold table is twelve calls, most of a visitor's minute, so the page keeps
      // the probe for a short window. The stub counts the methods it answered, so
      // this is about calls the page did not make, not about what it rendered.
      const rpcCounts = async () =>
        (await fetch(`${base}/__stats`, { signal: AbortSignal.timeout(10_000) }).then((response) =>
          response.json(),
        )) as { counts: Record<string, number> };
      const table = `document.querySelector("#chains tbody").innerText.includes("19,000,001")`;
      const cold = await rpcCounts();
      assert.ok(
        await session.evaluate<boolean>(
          `(() => {
            const stored = JSON.parse(localStorage.getItem("lwc-explorer-probes") ?? "null");
            return typeof stored?.savedAt === "number" && Object.keys(stored.probes).length === 6;
          })()`,
        ),
        "a fresh probe is kept for the next load",
      );

      // The reload renders the cache instead of probing six presets again.
      await session.send("Page.navigate", { url: `${base}/` });
      await waitFor(session, table, PAGE_READY_MS);
      assert.deepEqual((await rpcCounts()).counts, cold.counts, "a reload inside the window makes no calls");

      // A second tab is the case sessionStorage would miss: the cache is shared.
      const secondTarget = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: "PUT",
        signal: AbortSignal.timeout(15_000),
      }).then((response) => response.json())) as { webSocketDebuggerUrl: string };
      const second = await connect(secondTarget.webSocketDebuggerUrl);
      try {
        await second.send("Page.enable");
        await second.send("Runtime.enable");
        await second.send("Page.navigate", { url: `${base}/` });
        await waitFor(second, table, PAGE_READY_MS);
        assert.deepEqual((await rpcCounts()).counts, cold.counts, "a second tab reuses the cached probe");
      } finally {
        second.close();
      }

      // Past the window the table is paid for again, which is what keeps the cache
      // from becoming a stale health reading.
      await session.evaluate(
        `(() => {
          const stored = JSON.parse(localStorage.getItem("lwc-explorer-probes"));
          stored.savedAt = Date.now() - ${PROBE_CACHE_MS + 1_000};
          localStorage.setItem("lwc-explorer-probes", JSON.stringify(stored));
          return true;
        })()`,
      );
      await session.send("Page.navigate", { url: `${base}/` });
      await waitFor(session, table, PAGE_READY_MS);
      const stale = await rpcCounts();
      assert.equal(stale.counts.eth_chainId, (cold.counts.eth_chainId ?? 0) + 6, "an expired cache probes again");
      assert.equal(stale.counts.eth_blockNumber, (cold.counts.eth_blockNumber ?? 0) + 6);
      stage("probe cache checked");
    } finally {
      stage("teardown");
      clearTimeout(watchdog);
      session.close();
      stopBrowser(child);
      // Chrome can still hold keep-alive sockets to the stub server, which would
      // make server.close() wait forever; drop them and bound the wait.
      server.closeAllConnections();
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        sleep(5000),
      ]);
      rmSync(logPath, { force: true });
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // A browser that is still shutting down can hold its profile; the OS cleans the temp dir.
      }
    }
  },
);
