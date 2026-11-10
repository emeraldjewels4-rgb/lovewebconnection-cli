export interface WebhookOptions {
  /** Value for the Authorization header; null or blank sends none. */
  authHeader?: string | null;
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface WebhookResult {
  ok: boolean;
  /** Failure reason when ok is false, else null. */
  message: string | null;
}

const DEFAULT_TIMEOUT_MS = 3000;

function describe(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return short;
    return error.message;
  }
  return String(error);
}

/**
 * POST an alert payload. Delivery never throws, so a receiver that rejects the
 * call cannot end a watch run; the caller decides how to report the failure.
 */
export async function postWebhook(
  url: string,
  payload: Record<string, unknown>,
  options: WebhookOptions = {},
): Promise<WebhookResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = options.authHeader?.trim();
  if (auth) headers.authorization = auth;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    return response.ok
      ? { ok: true, message: null }
      : { ok: false, message: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}
