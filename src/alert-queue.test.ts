import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AlertQueue, type AlertTarget } from "./alert-queue.ts";
import { AlertStore, type StoredAlert } from "./alert-store.ts";

function target(event: string): AlertTarget {
  return { url: "https://ops.example/hook", payload: { event } };
}

function memoryStore(initial: StoredAlert[] = []) {
  let saved = [...initial];
  return {
    load: () => [...saved],
    save: (alerts: StoredAlert[]) => {
      saved = [...alerts];
    },
    alerts: () => saved,
  };
}

test("retries with exponential backoff until the receiver accepts", async () => {
  const sleeps: number[] = [];
  const retries: Array<[number, number]> = [];
  let calls = 0;

  const queue = new AlertQueue({
    deliver: async () => {
      calls += 1;
      return calls < 3
        ? { ok: false, message: "HTTP 503" }
        : { ok: true, message: null };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 100,
    maxDelayMs: 1000,
    onRetry: (_target, attempt, delayMs) => retries.push([attempt, delayMs]),
  });

  queue.enqueue(target("alert"));
  await queue.flush();

  assert.equal(calls, 3, "two failures then a success");
  assert.deepEqual(sleeps, [100, 200], "the delay doubles after each failure");
  assert.deepEqual(retries, [
    [1, 100],
    [2, 200],
  ]);
  assert.equal(queue.pending, 0);
});

test("caps the backoff at maxDelayMs", async () => {
  const sleeps: number[] = [];
  let calls = 0;

  const queue = new AlertQueue({
    deliver: async () => {
      calls += 1;
      return calls < 4 ? { ok: false, message: "HTTP 500" } : { ok: true, message: null };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 100,
    maxDelayMs: 250,
  });

  queue.enqueue(target("alert"));
  await queue.flush();

  assert.deepEqual(sleeps, [100, 200, 250]);
});

test("delivers one alert at a time in enqueue order", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const startedFirst = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });

  const queue = new AlertQueue({
    deliver: async (item) => {
      const event = String(item.payload.event);
      if (event === "first") {
        firstStarted();
        await firstGate;
      }
      events.push(event);
      return { ok: true, message: null };
    },
  });

  queue.enqueue(target("first"));
  queue.enqueue(target("second"));
  await startedFirst;
  assert.deepEqual(events, [], "the first alert is still in flight");
  assert.equal(queue.pending, 2);

  releaseFirst();
  await queue.flush();
  assert.deepEqual(events, ["first", "second"]);
  assert.equal(queue.pending, 0);
});

test("keeps alerts queued while an earlier one is retrying", async () => {
  const order: string[] = [];
  let attempts = 0;

  const queue = new AlertQueue({
    deliver: async (item) => {
      const event = String(item.payload.event);
      order.push(event);
      if (event === "first" && attempts++ === 0) {
        return { ok: false, message: "HTTP 502" };
      }
      return { ok: true, message: null };
    },
    sleep: async () => {},
  });

  queue.enqueue(target("first"));
  queue.enqueue(target("second"));
  await queue.flush();

  assert.deepEqual(order, ["first", "first", "second"], "the retry precedes the next alert");
  assert.equal(queue.pending, 0);
});

test("treats a thrown delivery as a failure and retries", async () => {
  let calls = 0;
  const queue = new AlertQueue({
    deliver: async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return { ok: true, message: null };
    },
    sleep: async () => {},
  });

  queue.enqueue(target("alert"));
  await queue.flush();

  assert.equal(calls, 2);
  assert.equal(queue.pending, 0);
});

test("maxAttempts bounds retries for a permanently failing receiver", async () => {
  const gaveUp: number[] = [];
  let calls = 0;

  const queue = new AlertQueue({
    deliver: async () => {
      calls += 1;
      return { ok: false, message: "HTTP 500" };
    },
    sleep: async () => {},
    maxAttempts: 3,
    onGiveUp: (_target, attempts) => gaveUp.push(attempts),
  });

  queue.enqueue(target("alert"));
  await queue.flush();

  assert.equal(calls, 3);
  assert.deepEqual(gaveUp, [3]);
  assert.equal(queue.pending, 0);
});

test("persists an enqueued alert before delivery and clears it on success", async () => {
  const store = memoryStore();
  const queue = new AlertQueue({
    deliver: async () => ({ ok: true, message: null }),
    store,
  });

  queue.enqueue(target("alert"));
  assert.equal(store.alerts().length, 1, "the alert is durable before the POST finishes");
  assert.equal(store.alerts()[0]?.url, "https://ops.example/hook");
  assert.equal(store.alerts()[0]?.payload.event, "alert");

  await queue.flush();
  assert.deepEqual(store.alerts(), [], "an accepted alert is removed from the store");
});

test("restore replays undelivered alerts and empties the store", async () => {
  const stored: StoredAlert = {
    id: "kept",
    url: "https://ops.example/hook",
    payload: { event: "alert" },
    attempts: 4,
    queuedAt: "2026-11-09T12:00:00.000Z",
  };
  const store = memoryStore([stored]);
  const delivered: string[] = [];
  const queue = new AlertQueue({
    deliver: async (item) => {
      delivered.push(String(item.payload.event));
      return { ok: true, message: null };
    },
    store,
  });

  assert.equal(queue.restore(), 1, "one alert survived the previous run");
  await queue.flush();

  assert.deepEqual(delivered, ["alert"]);
  assert.deepEqual(store.alerts(), []);
});

test("a failed delivery stays on disk for the next run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lwc-alert-queue-"));
  try {
    const path = join(dir, "nested", "queue.json");
    let queue!: AlertQueue;
    queue = new AlertQueue({
      deliver: async () => ({ ok: false, message: "down" }),
      sleep: async () => {
        queue.stop();
      },
      store: new AlertStore(path),
    });

    queue.enqueue(target("alert"));
    await queue.flush();

    assert.equal(queue.pending, 0, "stop clears memory");
    assert.equal(existsSync(path), true, "but the alert remains on disk");

    const replayed: AlertTarget[] = [];
    const next = new AlertQueue({
      deliver: async (item) => {
        replayed.push(item);
        return { ok: true, message: null };
      },
      store: new AlertStore(path),
    });

    assert.equal(next.restore(), 1);
    await next.flush();
    assert.deepEqual(replayed.map((item) => item.payload.event), ["alert"]);
    assert.equal(existsSync(path), false, "the file disappears once the alert is accepted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop clears the queue and interrupts a pending backoff", async () => {
  let calls = 0;
  const queue = new AlertQueue({
    deliver: async () => {
      calls += 1;
      return { ok: false, message: "down" };
    },
    baseDelayMs: 10_000,
    maxDelayMs: 10_000,
  });

  queue.enqueue(target("alert"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(queue.pending, 1, "the alert waits for its retry");

  queue.stop();
  await queue.flush();

  assert.equal(calls, 1, "no retry after stop");
  assert.equal(queue.pending, 0);
});
