import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One queued webhook alert as it appears in the durable queue file. */
export interface StoredAlert {
  id: string;
  url: string;
  payload: Record<string, unknown>;
  /** Delivery attempts so far; informational, replay starts a fresh backoff. */
  attempts: number;
  /** ISO 8601 time the alert was first queued. */
  queuedAt: string;
}

export const DEFAULT_ALERT_QUEUE_PATH = ".lwc-cache/webhook-queue.json";

/**
 * Flag path wins, then a path derived from the watch log, then the
 * project-local default. A log-adjacent file keeps separate services apart
 * without needing another flag.
 */
export function resolveAlertQueuePath(
  flagPath: string | null = null,
  logPath: string | null = null,
): string {
  const flag = flagPath?.trim();
  if (flag) return flag;
  return logPath ? `${logPath}.alerts.json` : DEFAULT_ALERT_QUEUE_PATH;
}

function usableAlert(value: unknown): StoredAlert | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const alert = value as Record<string, unknown>;

  if (typeof alert.id !== "string" || alert.id.length === 0) return null;
  if (typeof alert.url !== "string" || !/^https?:\/\/\S+$/.test(alert.url)) return null;

  const payload = alert.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  const attempts =
    typeof alert.attempts === "number" && Number.isInteger(alert.attempts) && alert.attempts >= 0
      ? alert.attempts
      : 0;

  return {
    id: alert.id,
    url: alert.url,
    payload: payload as Record<string, unknown>,
    attempts,
    queuedAt:
      typeof alert.queuedAt === "string" ? alert.queuedAt : new Date(0).toISOString(),
  };
}

/**
 * JSON-file store for undelivered alerts. Writes go to a temporary file that is
 * renamed over the real one, so a crash never leaves a half-written queue; an
 * empty queue removes the file. Loading tolerates a missing, malformed or
 * partially invalid file and keeps only usable entries.
 */
export class AlertStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(): StoredAlert[] {
    if (!existsSync(this.path)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return [];
    }

    const alerts = (parsed as { alerts?: unknown } | null)?.alerts;
    if (!Array.isArray(alerts)) return [];

    return alerts
      .map(usableAlert)
      .filter((alert): alert is StoredAlert => alert !== null);
  }

  save(alerts: StoredAlert[]): void {
    if (alerts.length === 0) {
      rmSync(this.path, { force: true });
      return;
    }

    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, alerts }, null, 2)}\n`);
    renameSync(temporary, this.path);
  }
}
