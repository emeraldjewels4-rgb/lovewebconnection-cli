import { randomUUID } from "node:crypto";

import type { StoredAlert } from "./alert-store.ts";
import type { WebhookResult } from "./webhook.ts";

export interface AlertTarget {
  url: string;
  payload: Record<string, unknown>;
}

/** Durable backing for the queue; keeps undelivered alerts across restarts. */
export interface AlertQueuePersistence {
  load(): StoredAlert[];
  save(alerts: StoredAlert[]): void;
}

export interface AlertQueueOptions {
  deliver: (target: AlertTarget) => Promise<WebhookResult>;
  /** Injected for tests; defaults to a cancellable timer. */
  sleep?: (ms: number) => Promise<void>;
  /** First retry delay, doubled per attempt. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff wait. Default 30 s. */
  maxDelayMs?: number;
  /**
   * Attempts per alert before giving up. 0 (the default) retries until the
   * receiver accepts, so a transient outage never drops an alert. A positive
   * value is mainly useful in tests.
   */
  maxAttempts?: number;
  /** When set, every queue change is written here and `restore()` replays it. */
  store?: AlertQueuePersistence;
  onRetry?: (target: AlertTarget, attempt: number, delayMs: number, message: string) => void;
  onGiveUp?: (target: AlertTarget, attempts: number, message: string) => void;
  /** A failed durable write is reported here; in-memory delivery continues. */
  onPersistError?: (error: unknown) => void;
}

interface QueueItem {
  id: string;
  target: AlertTarget;
  attempts: number;
  queuedAt: string;
}

/**
 * Serial alert delivery: one POST at a time, in enqueue order. A failed delivery
 * stays at the head of the queue and is retried with exponential backoff, so a
 * burst during an outage waits instead of firing concurrently and no alert is
 * skipped. With a `store`, the pending queue is rewritten after every change:
 * `stop()` clears memory but leaves the file intact, and `restore()` on the next
 * run replays those alerts. Delivery is at-least-once — a crash between a
 * successful POST and the store rewrite can resend one alert.
 */
export class AlertQueue {
  private readonly items: QueueItem[] = [];
  private readonly deliver: AlertQueueOptions["deliver"];
  private readonly customSleep: AlertQueueOptions["sleep"];
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly store: AlertQueuePersistence | undefined;
  private readonly onRetry: AlertQueueOptions["onRetry"];
  private readonly onGiveUp: AlertQueueOptions["onGiveUp"];
  private readonly onPersistError: AlertQueueOptions["onPersistError"];
  private loop: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(options: AlertQueueOptions) {
    this.deliver = options.deliver;
    this.customSleep = options.sleep;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 0;
    this.store = options.store;
    this.onRetry = options.onRetry;
    this.onGiveUp = options.onGiveUp;
    this.onPersistError = options.onPersistError;
  }

  get pending(): number {
    return this.items.length;
  }

  /**
   * Load alerts left by an earlier run and start delivering them. Attempts
   * restart at zero so a restart tries immediately instead of waiting out the
   * previous run's backoff.
   */
  restore(): number {
    if (!this.store) return 0;

    for (const alert of this.store.load()) {
      this.items.push({
        id: alert.id,
        target: { url: alert.url, payload: alert.payload },
        attempts: 0,
        queuedAt: alert.queuedAt,
      });
    }

    if (this.items.length > 0) this.start();
    return this.items.length;
  }

  enqueue(target: AlertTarget): void {
    if (this.stopped) return;
    this.items.push({
      id: randomUUID(),
      target,
      attempts: 0,
      queuedAt: new Date().toISOString(),
    });
    this.persist();
    this.start();
  }

  /** Resolves once the current delivery loop has ended. */
  async flush(): Promise<void> {
    while (this.loop !== null) await this.loop;
  }

  stop(): void {
    this.stopped = true;
    this.items.length = 0;
    this.wake?.();
  }

  private start(): void {
    if (this.stopped || this.loop !== null) return;
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped && this.items.length > 0) {
      const item = this.items[0];
      if (item === undefined) break;
      item.attempts += 1;
      this.persist();

      let result: WebhookResult;
      try {
        result = await this.deliver(item.target);
      } catch (error) {
        result = {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (this.stopped) break;

      if (result.ok) {
        this.items.shift();
        this.persist();
        continue;
      }

      const message = result.message ?? "unknown error";

      if (this.maxAttempts > 0 && item.attempts >= this.maxAttempts) {
        this.items.shift();
        this.persist();
        this.onGiveUp?.(item.target, item.attempts, message);
        continue;
      }

      const delayMs = Math.min(
        this.maxDelayMs,
        this.baseDelayMs * 2 ** Math.max(0, item.attempts - 1),
      );
      this.onRetry?.(item.target, item.attempts, delayMs, message);
      await this.wait(delayMs);
    }
  }

  private persist(): void {
    if (!this.store) return;

    try {
      this.store.save(
        this.items.map((item) => ({
          id: item.id,
          url: item.target.url,
          payload: item.target.payload,
          attempts: item.attempts,
          queuedAt: item.queuedAt,
        })),
      );
    } catch (error) {
      this.onPersistError?.(error);
    }
  }

  private wait(ms: number): Promise<void> {
    if (this.customSleep) return this.customSleep(ms);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
