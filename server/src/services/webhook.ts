import type { FastifyBaseLogger } from "fastify";

/** Reject anything that is not an https URL. */
export function validateWebhookUrl(url: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "webhook URL must use HTTPS" };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: "webhook URL has no hostname" };
  }
  return { ok: true };
}

export interface WebhookDelivery {
  ok: boolean;
  status: "success" | "error" | "skipped";
  response: string;
}

/** POST a JSON payload to a webhook with a Bearer token. */
export async function postToWebhook(
  url: string,
  token: string,
  payload: unknown,
  log?: FastifyBaseLogger,
): Promise<WebhookDelivery> {
  const validation = validateWebhookUrl(url);
  if (!validation.ok) {
    return { ok: false, status: "error", response: `webhook URL invalid: ${validation.reason}` };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text().catch(() => "");
    if (res.ok) {
      return {
        ok: true,
        status: "success",
        response: `webhook ${res.status}: ${body.slice(0, 1000)}`,
      };
    }
    return {
      ok: false,
      status: "error",
      response: `webhook ${res.status}: ${body.slice(0, 1000)}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error({ err }, "webhook delivery failed");
    return { ok: false, status: "error", response: `webhook delivery failed: ${message}` };
  }
}

/**
 * Simple in-memory rate limiter for webhook/prompt-thread calls. Limits each
 * key (webhook URL) to `maxCalls` within a rolling `windowMs`. Designed for a
 * single-process server; not shared across instances.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly maxCalls: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.maxCalls) {
      const oldest = arr[0]!;
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { allowed: true };
  }
}
