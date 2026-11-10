import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeMetrics,
  computeSessionMetrics,
  createMetricsState,
  formatMetrics,
  formatSeconds,
  percentile,
  recordBlockTime,
  recordFailure,
  recordLatency,
} from "./metrics.ts";

test("percentile uses nearest rank", () => {
  const sorted = [10, 20, 30, 40, 50];

  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 50), 30);
  assert.equal(percentile(sorted, 95), 50);
  assert.equal(percentile(sorted, 100), 50);
  assert.equal(percentile([], 50), 0);
});

test("empty state produces zeroed stats and no error", () => {
  const metrics = computeMetrics(createMetricsState());

  assert.equal(metrics.latency.count, 0);
  assert.equal(metrics.latency.p50, 0);
  assert.equal(metrics.blockTime.count, 0);
  assert.equal(metrics.blockTime.medianSeconds, 0);
  assert.equal(metrics.errorRate, 0);
  assert.equal(metrics.windowPolls, 0);
});

test("records latency percentiles, min, max, and mean", () => {
  let state = createMetricsState(20);
  for (const latency of [100, 200, 300, 400, 1000]) {
    state = recordLatency(state, latency);
  }

  const metrics = computeMetrics(state);
  assert.equal(metrics.latency.count, 5);
  assert.equal(metrics.latency.min, 100);
  assert.equal(metrics.latency.max, 1000);
  assert.equal(metrics.latency.p50, 300);
  assert.equal(metrics.latency.p95, 1000);
  assert.equal(metrics.latency.mean, 400);
  assert.equal(metrics.samples, 5);
});

test("rolling window keeps only the newest readings", () => {
  let state = createMetricsState(3);
  for (const latency of [10, 20, 30, 40, 50]) {
    state = recordLatency(state, latency);
  }

  const metrics = computeMetrics(state);
  assert.equal(metrics.latency.count, 3, "window is 3");
  assert.equal(metrics.latency.min, 30);
  assert.equal(metrics.latency.max, 50);
  assert.equal(metrics.samples, 5, "total sample count keeps growing");
});

test("records block times and ignores negatives", () => {
  let state = createMetricsState();
  state = recordBlockTime(state, 0.9);
  state = recordBlockTime(state, 1.2);
  state = recordBlockTime(state, -1);

  const metrics = computeMetrics(state);
  assert.equal(metrics.blockTime.count, 3);
  assert.equal(metrics.blockTime.minSeconds, 0);
  assert.equal(metrics.blockTime.maxSeconds, 1.2);
  assert.equal(metrics.blockTime.medianSeconds, 0.9);
  assert.equal(metrics.blockTime.meanSeconds, 0.7);
});

test("error rate is windowed while totals keep counting", () => {
  let state = createMetricsState(4);
  state = recordFailure(state);
  state = recordFailure(state);
  for (let index = 0; index < 4; index += 1) {
    state = recordLatency(state, 100);
  }

  const metrics = computeMetrics(state);
  assert.equal(metrics.windowFailures, 0, "failures fell out of the window");
  assert.equal(metrics.windowPolls, 4);
  assert.equal(metrics.errorRate, 0);
  assert.equal(state.errors, 2, "total errors are preserved");
});

test("session metrics pool the whole run instead of the window", () => {
  let state = createMetricsState(2);
  for (const latency of [100, 200, 300, 400]) {
    state = recordLatency(state, latency);
  }
  state = recordBlockTime(state, 0.5);
  state = recordBlockTime(state, 1.5);
  state = recordFailure(state);

  const rolling = computeMetrics(state);
  const cumulative = computeSessionMetrics(state);

  assert.equal(rolling.latency.count, 2);
  assert.equal(rolling.latency.p50, 300);
  assert.equal(cumulative.latency.count, 4, "every successful poll, not just the window");
  assert.equal(cumulative.latency.p50, 200);
  assert.equal(cumulative.latency.max, 400);
  assert.equal(cumulative.blockTime.count, 2);
  assert.equal(cumulative.blockTime.meanSeconds, 1);
  assert.equal(cumulative.samples, 4);
  assert.equal(cumulative.failures, 1);
  assert.equal(cumulative.polls, 5);
  assert.equal(cumulative.errorRate, 0.2);
});

test("error rate reflects failures inside the window", () => {
  let state = createMetricsState(4);
  state = recordLatency(state, 100);
  state = recordFailure(state);
  state = recordLatency(state, 100);
  state = recordFailure(state);

  const metrics = computeMetrics(state);
  assert.equal(metrics.windowPolls, 4);
  assert.equal(metrics.windowFailures, 2);
  assert.equal(metrics.errorRate, 0.5);
});

test("formatSeconds switches from seconds to minutes", () => {
  assert.equal(formatSeconds(0.86), "0.9s");
  assert.equal(formatSeconds(12), "12.0s");
  assert.equal(formatSeconds(62.4), "1m02s");
  assert.equal(formatSeconds(600), "10m00s");
});

test("formatMetrics renders a single rolling line", () => {
  let state = createMetricsState();
  for (const latency of [200, 400, 900]) {
    state = recordLatency(state, latency);
  }
  state = recordBlockTime(state, 0.9);
  state = recordBlockTime(state, 1.1);

  const line = formatMetrics(computeMetrics(state));

  assert.match(line, /latency p50 400 ms, p95 900 ms, max 900 ms/);
  assert.match(line, /block time median 0\.9s/);
  assert.match(line, /errors 0\/3/);
});

test("formatMetrics appends whole-session totals", () => {
  let state = createMetricsState(2);
  for (const latency of [200, 400, 900]) {
    state = recordLatency(state, latency);
  }
  state = recordBlockTime(state, 0.9);
  state = recordFailure(state);

  const line = formatMetrics(computeMetrics(state), computeSessionMetrics(state));

  assert.match(line, /errors 1\/2/, "the window only sees the recent polls");
  assert.match(line, /session latency p50 400 ms, p95 900 ms, max 900 ms/);
  assert.match(line, /session block time median 0\.9s/);
  assert.match(line, /session errors 1\/4/, "the session counts every poll");
});

test("formatMetrics handles an empty window", () => {
  const line = formatMetrics(computeMetrics(createMetricsState()));

  assert.match(line, /latency n\/a/);
  assert.match(line, /block time n\/a/);
  assert.match(line, /errors 0\/0/);
});
