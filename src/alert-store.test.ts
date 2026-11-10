import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AlertStore,
  DEFAULT_ALERT_QUEUE_PATH,
  resolveAlertQueuePath,
  type StoredAlert,
} from "./alert-store.ts";

const alert: StoredAlert = {
  id: "a1",
  url: "https://ops.example/hook",
  payload: { event: "alert" },
  attempts: 2,
  queuedAt: "2026-11-09T12:00:00.000Z",
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lwc-alert-store-"));
}

test("derives the queue path from the flag, the log, or the default", () => {
  assert.equal(resolveAlertQueuePath("./q.json", "./watch.ndjson"), "./q.json");
  assert.equal(resolveAlertQueuePath(null, "./watch.ndjson"), "./watch.ndjson.alerts.json");
  assert.equal(resolveAlertQueuePath(null, null), DEFAULT_ALERT_QUEUE_PATH);
  assert.equal(resolveAlertQueuePath("  ", "./watch.ndjson"), "./watch.ndjson.alerts.json");
});

test("round-trips queued alerts through a nested path", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "nested", "queue.json");
    const store = new AlertStore(path);
    assert.deepEqual(store.load(), [], "a missing file means nothing is pending");

    store.save([alert]);
    assert.deepEqual(store.load(), [alert]);

    store.save([]);
    assert.equal(existsSync(path), false, "an empty queue removes the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores a malformed file instead of throwing", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "queue.json");
    writeFileSync(path, "{not json");
    assert.deepEqual(new AlertStore(path).load(), []);
    assert.equal(existsSync(path), true, "an unreadable file is left for inspection");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps only usable entries from a mixed file", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "queue.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        alerts: [
          alert,
          { id: "bad" },
          { ...alert, id: "b2", url: "ftp://nope" },
          { ...alert, id: "b3", payload: ["array"] },
          { ...alert, id: "b4", attempts: -1 },
          "nope",
        ],
      }),
    );

    const loaded = new AlertStore(path).load();
    assert.deepEqual(
      loaded.map((item) => item.id),
      ["a1", "b4"],
      "only alerts with an id, an http(s) URL, and an object payload survive",
    );
    assert.equal(loaded[1]?.attempts, 0, "an invalid attempt count falls back to zero");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fills defaults for a minimal entry", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "queue.json");
    writeFileSync(
      path,
      JSON.stringify({ alerts: [{ id: "x", url: "https://ops.example/hook", payload: {} }] }),
    );

    const [loaded] = new AlertStore(path).load();
    assert.equal(loaded?.attempts, 0);
    assert.equal(typeof loaded?.queuedAt, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
