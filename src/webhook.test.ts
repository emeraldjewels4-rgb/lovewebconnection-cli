import assert from "node:assert/strict";
import { test } from "node:test";

import { WatchArgError, parseWatchArgs } from "./watch.ts";
import { postWebhook } from "./webhook.ts";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function capture(status: number, calls: CapturedCall[], throws = false): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (throws) throw new Error("connection refused");
    return new Response(null, { status });
  }) as typeof fetch;
}

function headersOf(call: CapturedCall | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

test("sends the auth header, content type, and JSON body", async () => {
  const calls: CapturedCall[] = [];
  const result = await postWebhook(
    "https://ops.example/hook",
    { event: "alert", metric: "latency" },
    { authHeader: "Bearer live-token", fetchImpl: capture(204, calls) },
  );

  assert.deepEqual(result, { ok: true, message: null });
  assert.equal(calls[0]?.url, "https://ops.example/hook");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headersOf(calls[0]).authorization, "Bearer live-token");
  assert.equal(headersOf(calls[0])["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    event: "alert",
    metric: "latency",
  });
});

test("omits the auth header when none is configured", async () => {
  const calls: CapturedCall[] = [];
  await postWebhook("https://ops.example/hook", { event: "alert" }, { fetchImpl: capture(200, calls) });
  assert.equal("authorization" in headersOf(calls[0]), false);

  const blank: CapturedCall[] = [];
  await postWebhook("https://ops.example/hook", {}, { authHeader: "   ", fetchImpl: capture(200, blank) });
  assert.equal("authorization" in headersOf(blank[0]), false, "blank values send no header");
});

test("reports HTTP failures without throwing", async () => {
  const calls: CapturedCall[] = [];
  const result = await postWebhook(
    "https://ops.example/hook",
    { event: "alert" },
    { authHeader: "Bearer t", fetchImpl: capture(403, calls) },
  );

  assert.deepEqual(result, { ok: false, message: "HTTP 403" });
});

test("reports transport failures without throwing", async () => {
  const result = await postWebhook(
    "https://ops.example/hook",
    { event: "alert" },
    { fetchImpl: capture(200, [], true) },
  );

  assert.deepEqual(result, { ok: false, message: "connection refused" });
});

test("watch requires a webhook for an auth header and a single-line value", () => {
  const options = parseWatchArgs(
    [
      "--alert-latency",
      "1",
      "--alert-webhook",
      "https://ops.example/hook",
      "--alert-webhook-auth",
      "Bearer t",
    ],
    {},
  );
  assert.equal(options.alertAuthHeader, "Bearer t");
  assert.equal(
    parseWatchArgs(["--alert-latency", "1"], {}).alertAuthHeader,
    null,
    "off by default",
  );

  const authWithoutWebhook = [
    "--alert-latency",
    "1",
    "--alert-webhook-auth",
    "Bearer t",
  ];
  assert.throws(
    () => parseWatchArgs(authWithoutWebhook, {}),
    (error: unknown) => error instanceof WatchArgError && /needs --alert-webhook/.test(error.message),
  );
  assert.throws(
    () =>
      parseWatchArgs(
        [
          "--alert-latency",
          "1",
          "--alert-webhook",
          "https://ops.example/hook",
          "--alert-webhook-auth",
          "a\nb",
        ],
        {},
      ),
    (error: unknown) => error instanceof WatchArgError && /single line/.test(error.message),
  );
  assert.throws(
    () =>
      parseWatchArgs(
        [
          "--alert-latency",
          "1",
          "--alert-webhook",
          "https://ops.example/hook",
          "--alert-webhook-auth=",
        ],
        {},
      ),
    (error: unknown) => error instanceof WatchArgError,
  );
});

test("reads the webhook Authorization header from LWC_WEBHOOK_AUTH", () => {
  const env = { LWC_WEBHOOK_AUTH: "Bearer env-token" };
  const withWebhook = ["--alert-latency", "1", "--alert-webhook", "https://ops.example/hook"];

  assert.equal(
    parseWatchArgs(withWebhook, env).alertAuthHeader,
    "Bearer env-token",
    "the variable supplies the header without a flag",
  );
  assert.equal(
    parseWatchArgs([...withWebhook, "--alert-webhook-auth", "Bearer flag"], env).alertAuthHeader,
    "Bearer flag",
    "an explicit flag wins over the variable",
  );
  assert.equal(
    parseWatchArgs(["--interval", "5"], env).alertAuthHeader,
    "Bearer env-token",
    "a shell-wide variable is harmless without a webhook",
  );
  assert.throws(
    () => parseWatchArgs(withWebhook, { LWC_WEBHOOK_AUTH: "a\nb" }),
    (error: unknown) =>
      error instanceof WatchArgError && /LWC_WEBHOOK_AUTH must be a single line/.test(error.message),
  );
});
