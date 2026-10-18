// Demo-grade in-memory token-bucket rate limiter.
// DEMO LIMITATION (explicit): single-process memory, resets on restart,
// no persistence, no clustering. For a real deployment, replace with a
// shared store (Redis/Upstash) and set limits via config.
// API: createRateLimiter({ limit, windowSec }) → { check, reset }.
// check(key) consumes one token; returns { allowed, remaining, retryAfterSec }.

import { NextRequest, NextResponse } from "next/server";

export interface RateLimitOptions {
  /** Max requests per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Tokens left in the bucket after this request (0 when denied). */
  remaining: number;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const MAX_BUCKETS = 10_000;

export function createRateLimiter({ limit, windowSec }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const tokensPerMs = limit / (windowSec * 1000);

  function pruneIdle(nowMs: number): void {
    // Bound memory: drop buckets idle for more than two windows.
    for (const [key, b] of buckets) {
      if (nowMs - b.lastRefillMs > windowSec * 2000) buckets.delete(key);
      if (buckets.size <= MAX_BUCKETS) break;
    }
  }

  function check(key: string, nowMs: number = Date.now()): RateLimitResult {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: limit, lastRefillMs: nowMs };
      buckets.set(key, b);
    } else if (nowMs > b.lastRefillMs) {
      b.tokens = Math.min(limit, b.tokens + (nowMs - b.lastRefillMs) * tokensPerMs);
      b.lastRefillMs = nowMs;
    }

    if (buckets.size > MAX_BUCKETS) pruneIdle(nowMs);

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    const retryAfterSec = Math.max(
      1,
      Math.ceil((1 - b.tokens) / tokensPerMs / 1000)
    );
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  function reset(key?: string): void {
    if (key === undefined) buckets.clear();
    else buckets.delete(key);
  }

  function size(): number {
    return buckets.size;
  }

  return { check, reset, size };
}

// Brute-force protection for the demo login: 10 attempts per minute per IP.
// Login is passwordless (demo identities), so this is belt-and-braces, but
// it also throttles automated probing of demo user ids.
export const loginRateLimiter = createRateLimiter({ limit: 10, windowSec: 60 });

// Scan submission throttle: 60 per minute per authenticated user.
export const scanRateLimiter = createRateLimiter({ limit: 60, windowSec: 60 });

/**
 * Best-effort client IP for rate-limit keys. Trusts x-forwarded-for only
 * for keying (demo); in production sit behind a proxy that sets it.
 */
export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "direct";
}

/** Standardized 429 response with Retry-After, in the API error envelope. */
export function rateLimitExceeded(
  retryAfterSec: number,
  message = "Too many requests. Please try again shortly."
): NextResponse {
  return NextResponse.json(
    { error: { code: "rate_limited", message } },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec) },
    }
  );
}
