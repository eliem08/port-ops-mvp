/**
 * lib/server/idempotency.ts
 *
 * DEMO-ONLY in-memory idempotency store. NOT a production store:
 * it lives in the Node process, is lost on restart, and is not shared
 * across instances. A production implementation must persist
 * (key -> hashed request + response) in a durable store with a TTL
 * and compare the request body hash on key reuse.
 */

/** Idempotency record for one creation request. */
export interface IdempotencyRecord {
  /** The response body that was returned for the original request. */
  response: unknown;
  /** HTTP status used for the original request (201 for creates). */
  status: number;
  /** Epoch ms when the record was stored. */
  storedAtMs: number;
}

export class IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  /** Return the stored record for a key, or undefined. */
  get(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  /** Store the response for a key (first write wins — never overwrite). */
  setIfAbsent(key: string, record: IdempotencyRecord): IdempotencyRecord {
    const existing = this.records.get(key);
    if (existing) return existing;
    this.records.set(key, record);
    return record;
  }

  get size(): number {
    return this.records.size;
  }

  /** Test/reset hook only — production stores would not expose this. */
  clear(): void {
    this.records.clear();
  }
}

/** Normalize the Idempotency-Key header value (trim, ignore empties). */
export function readIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get("idempotency-key");
  if (!raw) return null;
  const key = raw.trim();
  return key.length > 0 && key.length <= 256 ? key : null;
}

/** Singleton idempotency store for booking creation (demo-only). */
export const bookingIdempotency = new IdempotencyStore();

/** Singleton idempotency store for recommendation creation (demo-only). */
export const recommendationIdempotency = new IdempotencyStore();
