// Per-key token-bucket rate limiter. In-memory only — fine for the single
// Vercel region we ship today. If the chat fan-out goes multi-region this
// must move to Upstash Redis (one bucket per user is small but the bucket
// table itself isn't shared across functions).
//
// Defaults are intentional: 20 msgs/min per user matches the TODO. Bursts up
// to the bucket capacity are allowed so a rep typing fast doesn't trip it.

type Bucket = {
  tokens: number;
  updatedAt: number;
};

type Limit = {
  capacity: number; // max tokens (== burst size)
  refillPerSec: number; // tokens added per second
};

const DEFAULT_LIMIT: Limit = { capacity: 20, refillPerSec: 20 / 60 };

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

// Periodic sweep so an idle bucket doesn't sit in memory forever. Cheap —
// O(n) across users, run at most every 5 minutes.
function maybeSweep(now: number) {
  if (now - lastSweep < 5 * 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > 30 * 60_000) buckets.delete(key);
  }
}

export type RateLimitResult =
  | { allowed: true; remaining: number; resetSeconds: number }
  | { allowed: false; remaining: 0; resetSeconds: number };

export function checkRateLimit(
  key: string,
  limit: Limit = DEFAULT_LIMIT,
): RateLimitResult {
  const now = Date.now();
  maybeSweep(now);
  const existing = buckets.get(key);
  const bucket: Bucket = existing
    ? refill(existing, now, limit)
    : { tokens: limit.capacity, updatedAt: now };

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetSeconds: Math.ceil((limit.capacity - bucket.tokens) / limit.refillPerSec),
    };
  }
  buckets.set(key, bucket);
  return {
    allowed: false,
    remaining: 0,
    resetSeconds: Math.ceil((1 - bucket.tokens) / limit.refillPerSec),
  };
}

function refill(bucket: Bucket, now: number, limit: Limit): Bucket {
  const elapsedSec = (now - bucket.updatedAt) / 1000;
  return {
    tokens: Math.min(limit.capacity, bucket.tokens + elapsedSec * limit.refillPerSec),
    updatedAt: now,
  };
}
