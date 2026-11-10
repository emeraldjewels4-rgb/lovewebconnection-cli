export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

export interface BlockTimeStats {
  count: number;
  medianSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  meanSeconds: number;
}

export interface WatchMetrics {
  samples: number;
  windowSize: number;
  latency: LatencyStats;
  blockTime: BlockTimeStats;
  windowFailures: number;
  windowPolls: number;
  /** Fraction of polls in the window that failed, 0..1. */
  errorRate: number;
}

export interface MetricsState {
  windowSize: number;
  latencies: number[];
  blockTimes: number[];
  outcomes: boolean[];
  samples: number;
  errors: number;
  /** Untrimmed history for session totals; absent on window-only states. */
  sessionLatencies?: number[];
  sessionBlockTimes?: number[];
}

/** Whole-run totals, as opposed to the rolling `WatchMetrics` window. */
export interface SessionMetrics {
  /** Successful polls in the run. */
  samples: number;
  /** Failed polls in the run. */
  failures: number;
  /** Successful plus failed polls. */
  polls: number;
  errorRate: number;
  latency: LatencyStats;
  blockTime: BlockTimeStats;
}

export const DEFAULT_METRICS_WINDOW = 20;

function emptyLatency(): LatencyStats {
  return { count: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 };
}

function emptyBlockTime(): BlockTimeStats {
  return { count: 0, medianSeconds: 0, minSeconds: 0, maxSeconds: 0, meanSeconds: 0 };
}

export function createMetricsState(windowSize = DEFAULT_METRICS_WINDOW): MetricsState {
  return {
    windowSize,
    latencies: [],
    blockTimes: [],
    outcomes: [],
    samples: 0,
    errors: 0,
    sessionLatencies: [],
    sessionBlockTimes: [],
  };
}

function trim<T>(values: T[], windowSize: number): T[] {
  return values.length > windowSize ? values.slice(-windowSize) : values;
}

export function recordLatency(state: MetricsState, latencyMs: number): MetricsState {
  const value = Math.max(0, Math.round(latencyMs));
  return {
    ...state,
    latencies: trim([...state.latencies, value], state.windowSize),
    outcomes: trim([...state.outcomes, true], state.windowSize),
    sessionLatencies: [...(state.sessionLatencies ?? []), value],
    samples: state.samples + 1,
  };
}

export function recordFailure(state: MetricsState): MetricsState {
  return {
    ...state,
    outcomes: trim([...state.outcomes, false], state.windowSize),
    errors: state.errors + 1,
  };
}

export function recordBlockTime(state: MetricsState, seconds: number): MetricsState {
  const value = Math.max(0, seconds);
  return {
    ...state,
    blockTimes: trim([...state.blockTimes, value], state.windowSize),
    sessionBlockTimes: [...(state.sessionBlockTimes ?? []), value],
  };
}

/** Nearest-rank percentile over an already sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

function latencyStatsFrom(sorted: number[]): LatencyStats {
  if (sorted.length === 0) return emptyLatency();

  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function blockTimeStatsFrom(sorted: number[]): BlockTimeStats {
  if (sorted.length === 0) return emptyBlockTime();

  return {
    count: sorted.length,
    medianSeconds: percentile(sorted, 50),
    minSeconds: sorted[0] ?? 0,
    maxSeconds: sorted[sorted.length - 1] ?? 0,
    meanSeconds: Number(
      (sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3),
    ),
  };
}

export function computeMetrics(state: MetricsState): WatchMetrics {
  const latencies = [...state.latencies].sort((a, b) => a - b);
  const blockTimes = [...state.blockTimes].sort((a, b) => a - b);
  const windowPolls = state.outcomes.length;
  const windowFailures = state.outcomes.filter((ok) => !ok).length;

  return {
    samples: state.samples,
    windowSize: state.windowSize,
    latency: latencyStatsFrom(latencies),
    blockTime: blockTimeStatsFrom(blockTimes),
    windowFailures,
    windowPolls,
    errorRate: windowPolls === 0 ? 0 : windowFailures / windowPolls,
  };
}

/** Totals over the whole run, independent of the rolling window. */
export function computeSessionMetrics(state: MetricsState): SessionMetrics {
  const latencies = [...(state.sessionLatencies ?? state.latencies)].sort((a, b) => a - b);
  const blockTimes = [...(state.sessionBlockTimes ?? state.blockTimes)].sort((a, b) => a - b);
  const polls = state.samples + state.errors;

  return {
    samples: state.samples,
    failures: state.errors,
    polls,
    errorRate: polls === 0 ? 0 : state.errors / polls,
    latency: latencyStatsFrom(latencies),
    blockTime: blockTimeStatsFrom(blockTimes),
  };
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

/**
 * One-line metrics report: the rolling window, plus whole-session totals when
 * they are supplied, so recent health and the full run appear together.
 */
export function formatMetrics(metrics: WatchMetrics, session?: SessionMetrics): string {
  const parts: string[] = [];

  parts.push(
    metrics.latency.count > 0
      ? `latency p50 ${metrics.latency.p50} ms, p95 ${metrics.latency.p95} ms, max ${metrics.latency.max} ms`
      : "latency n/a",
  );

  parts.push(
    metrics.blockTime.count > 0
      ? `block time median ${formatSeconds(metrics.blockTime.medianSeconds)}`
      : "block time n/a",
  );

  parts.push(`errors ${metrics.windowFailures}/${metrics.windowPolls}`);

  if (session) {
    parts.push(
      session.latency.count > 0
        ? `session latency p50 ${session.latency.p50} ms, p95 ${session.latency.p95} ms, max ${session.latency.max} ms`
        : "session latency n/a",
    );
    parts.push(
      session.blockTime.count > 0
        ? `session block time median ${formatSeconds(session.blockTime.medianSeconds)}`
        : "session block time n/a",
    );
    parts.push(`session errors ${session.failures}/${session.polls}`);
  }

  return parts.join(" | ");
}
