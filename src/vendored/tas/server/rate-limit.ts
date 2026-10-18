/**
 * lib/server/rate-limit.ts
 *
 * Tiny in-memory token-bucket rate limiter (no dependencies).
 * Default budget: 60 requests / minute / IP / route.
 *
 * DEMO-ONLY: state lives in the process, is lost on restart, and is
 * not shared across instances. A production deployment needs a
 * shared store (Redis etc.) and should sit behind a proper edge
 * limiter; this exists to stop accidental abuse of the demo API.
 */

export interface RateLimitConfig {
  /** Bucket capacity (burst). */
  capacity: number;
  /** Tokens refilled per minute. */
  refillPerMinute: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  capacity: 60,
  refillPerMinute: 60,
};

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

/** Best-effort client IP (proxy-aware). */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  /** ms until one token is available (when denied). */
  retryAfterMs: number;
}

/**
 * Consume one token for (ip, route). Returns whether the request may
 * proceed. Pure in-memory; safe to call from any route handler.
 */
export function checkRateLimit(
  ip: string,
  route: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
  nowMs: number = Date.now(),
): RateLimitResult {
  const key = `${route}|${ip}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: config.capacity, lastRefillMs: nowMs };
    buckets.set(key, bucket);
  }
  const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
  const refill = (elapsedMs / 60000) * config.refillPerMinute;
  bucket.tokens = Math.min(config.capacity, bucket.tokens + refill);
  bucket.lastRefillMs = nowMs;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  const msPerToken = 60000 / config.refillPerMinute;
  return { allowed: false, retryAfterMs: Math.ceil(msPerToken) };
}

/** Test/reset hook only. */
export function clearRateLimits(): void {
  buckets.clear();
}
