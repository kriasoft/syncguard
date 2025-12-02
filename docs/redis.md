# Redis Backend

High-performance distributed locking using Redis as the backend. Ideal for sub-millisecond latency requirements and high-throughput scenarios.

::: tip Technical Specifications
For backend implementers: See [docs/specs/redis-backend.md](https://github.com/kriasoft/syncguard/blob/main/docs/specs/redis-backend.md) for complete implementation requirements, Lua script patterns, and architecture decisions.
:::

## Installation

```bash
npm install syncguard ioredis
```

## Quick Start

```ts
import { createLock } from "syncguard/redis";
import Redis from "ioredis";

const redis = new Redis();
const lock = createLock(redis);

await lock(
  async () => {
    // Your critical section
    await processPayment(paymentId);
  },
  { key: `payment:${paymentId}`, ttlMs: 30000 },
);
```

## Configuration

### Backend Options

```ts
import { createRedisBackend } from "syncguard/redis";

const backend = createRedisBackend(redis, {
  keyPrefix: "myapp", // Namespace for all keys (default: "syncguard")
  cleanupInIsLocked: false, // Enable cleanup in isLocked (default: false)
});
```

**Key Prefix**: All Redis keys use the format `{keyPrefix}:{key}`. Use environment-specific prefixes to avoid collisions:

```ts
const prefix =
  process.env.NODE_ENV === "production" ? "prod:locks" : "dev:locks";

const backend = createRedisBackend(redis, { keyPrefix: prefix });
```

**Cleanup in isLocked**: When enabled, expired locks may be cleaned up during `isLocked()` checks. Disabled by default to maintain pure read semantics.

### Lock Options

```ts
await lock(
  async () => {
    // Your work function
  },
  {
    key: "resource:123", // Required: unique identifier
    ttlMs: 30000, // Lock duration (default: 30s)
    acquisition: {
      timeoutMs: 5000, // Max acquisition wait (default: 5s)
      maxRetries: 10, // Retry attempts (default: 10)
    },
  },
);
```

## Performance

Redis backend provides exceptional performance for distributed locking:

- **Latency**: Sub-millisecond for local Redis, <10ms for remote
- **Throughput**: 25,000+ ops/sec with script caching
- **Script Caching**: Automatically uses `EVALSHA` for optimal performance

### How Script Caching Works

SyncGuard uses `ioredis.defineCommand()` to automatically cache Lua scripts:

1. First call: Script loaded via `SCRIPT LOAD`
2. Subsequent calls: Execute via `EVALSHA` (faster)
3. Fallback: Gracefully falls back to `EVAL` if needed

No configuration required—it just works.

## Redis-Specific Features

### Server Time Authority

Redis uses server time (`TIME` command) for all expiration checks, eliminating most clock drift issues:

```ts
// Redis server's clock is the source of truth
// No NTP synchronization required on clients
const result = await backend.acquire({ key: "task:123", ttlMs: 60000 });
```

**Unified Tolerance** (ADR-005): All backends use a fixed 1000ms tolerance for predictable, consistent behavior across Redis, PostgreSQL, and Firestore. This tolerance is internal and not user-configurable.

### Atomic Operations via Lua Scripts

All mutations execute atomically via Lua scripts:

- **Acquire**: Check expiration → increment fence → set lock + index
- **Release**: Reverse lookup → verify ownership → delete both keys
- **Extend**: Reverse lookup → verify ownership → update TTL

This guarantees no race conditions between operations.

### Storage Pattern

Redis backend uses a dual-key pattern:

```text
syncguard:resource:123       → Lock data (JSON with lockId, fence, timestamps)
syncguard:id:{lockId}        → Reverse index (maps lockId → key)
syncguard:fence:resource:123 → Monotonic counter (persists indefinitely)
```

Both lock and index keys expire together. Fence counters survive restarts.

## Common Patterns

### Rate Limiting

```ts
const backend = createRedisBackend(redis);

async function checkRateLimit(userId: string) {
  const result = await backend.acquire({
    key: `rate:${userId}`,
    ttlMs: 60000, // 1-minute window
  });

  if (!result.ok) {
    throw new Error("Rate limit exceeded. Try again later.");
  }

  // Don't release—let it expire naturally
  return performOperation(userId);
}
```

### Job Deduplication

```ts
const processJob = async (jobId: string) => {
  await lock(
    async () => {
      const job = await getJob(jobId);
      if (job.status === "pending") {
        await executeJob(job);
        await markJobComplete(jobId);
      }
    },
    { key: `job:${jobId}`, ttlMs: 300000 },
  );
};
```

### Long-Running Tasks with Heartbeat

```ts
import { owns } from "syncguard";

const backend = createRedisBackend(redis);
const result = await backend.acquire({ key: "batch:report", ttlMs: 60000 });

if (result.ok) {
  const { lockId } = result;

  // Extend lock periodically
  const heartbeat = setInterval(async () => {
    const extended = await backend.extend({ lockId, ttlMs: 60000 });
    if (!extended.ok) {
      clearInterval(heartbeat);
      console.error("Lost lock ownership");
    }
  }, 30000); // Extend every 30s

  try {
    await generateReport();
  } finally {
    clearInterval(heartbeat);
    await backend.release({ lockId });
  }
}
```

### Monitoring Lock Status

```ts
import { getByKey, getById } from "syncguard";

// Check if a resource is currently locked
const info = await getByKey(backend, "resource:123");
if (info) {
  console.log(`Resource locked until ${new Date(info.expiresAtMs)}`);
  console.log(`Fence token: ${info.fence}`);
}

// Check if you still own a lock
const owned = await getById(backend, lockId);
if (owned) {
  console.log(
    `Still own the lock, expires in ${owned.expiresAtMs - Date.now()}ms`,
  );
}
```

## Troubleshooting

### Connection Issues

If you see `ServiceUnavailable` errors:

```ts
const redis = new Redis({
  host: "localhost",
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3,
});
```

### Script Loading Errors

In rare cases, Redis may report `NOSCRIPT` errors. This is automatically handled by `ioredis`, but if using custom Redis clients:

```ts
// ioredis handles this automatically
// For custom clients, ensure EVAL fallback is implemented
```

### Key Length Limits

Redis keys should stay under 1KB. SyncGuard automatically truncates keys exceeding limits:

```ts
// Long keys are automatically truncated using hash-based truncation
const result = await backend.acquire({
  key: "x".repeat(2000), // Automatically truncated
  ttlMs: 30000,
});
```

User-supplied keys are capped at 512 bytes after normalization.

### Memory Management

Fence counters persist indefinitely (required for fencing safety). Monitor memory usage:

```bash
# Count fence keys
redis-cli --scan --pattern "syncguard:fence:*" | wc -l

# Each fence key ≈ 50-100 bytes
# 1M fence keys ≈ 50-100MB (typically acceptable)
```

For applications generating >10M unique lock keys annually, consider key normalization.

::: info Fence Counter Lifecycle
Fence counters are intentionally persistent. See [docs/specs/redis-backend.md § Fence Key Lifecycle](https://github.com/kriasoft/syncguard/blob/main/docs/specs/redis-backend.md#fence-key-lifecycle-and-memory-considerations) for the complete rationale and operational guidance.
:::

::: tip Performance Tip
Use a dedicated Redis instance for locks to avoid contention with application cache data.
:::
