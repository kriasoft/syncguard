# SyncGuard

[![npm version](https://badge.fury.io/js/syncguard.svg)](https://badge.fury.io/js/syncguard)
[![npm downloads](https://img.shields.io/npm/dm/syncguard.svg)](https://npmjs.com/package/syncguard)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/kriasoft/syncguard/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Discord](https://img.shields.io/discord/643523529131950086?label=Discord&logo=discord&logoColor=white)](https://discord.gg/EnbEa7Gsxg)

TypeScript distributed lock library that prevents race conditions across services. Supports Redis, PostgreSQL, and Firestore backends with automatic cleanup, fencing tokens, and bulletproof concurrency control.

## Requirements

- **Node.js** ≥20.0.0 (targets AsyncDisposable/`await using`; older runtimes require try/finally plus a polyfill, but official support is 20+)

## Installation

SyncGuard is backend-agnostic. Install the base package plus any backends you need:

```bash
# Base package (always required)
npm install syncguard

# Choose one or more backends (optional peer dependencies):
npm install ioredis          # for Redis backend
npm install postgres         # for PostgreSQL backend
npm install @google-cloud/firestore  # for Firestore backend
```

Only install the backend packages you actually use. If you attempt to use a backend without its package installed, you'll get a clear error message.

## Usage

### Quick Start (Redis)

```typescript
import { createLock } from "syncguard/redis";
import Redis from "ioredis";

const redis = new Redis();
const lock = createLock(redis);

// Prevent duplicate payment processing
await lock(
  async () => {
    const payment = await getPayment(paymentId);
    if (payment.status === "pending") {
      await processPayment(payment);
      await updatePaymentStatus(paymentId, "completed");
    }
  },
  { key: `payment:${paymentId}`, ttlMs: 60000 },
);
```

### Using PostgreSQL

```typescript
import { createLock, setupSchema } from "syncguard/postgres";
import postgres from "postgres";

const sql = postgres("postgresql://localhost:5432/myapp");

// Setup schema (once, during initialization)
await setupSchema(sql);

// Create lock function (synchronous)
const lock = createLock(sql);

await lock(
  async () => {
    // Your critical section
  },
  { key: "resource:123" },
);
```

### Using Firestore

```typescript
import { createLock } from "syncguard/firestore";
import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();
const lock = createLock(db);

await lock(
  async () => {
    // Your critical section
  },
  { key: "resource:123" },
);
```

### Manual Lock Control with Automatic Cleanup

Use `await using` for automatic cleanup on all code paths (Node.js ≥20):

```typescript
import { createRedisBackend } from "syncguard/redis";
import Redis from "ioredis";

const redis = new Redis();
const backend = createRedisBackend(redis);

// Lock automatically released on scope exit
{
  await using lock = await backend.acquire({
    key: "batch:daily-report",
    ttlMs: 300000, // 5 minutes
  });

  if (lock.ok) {
    // TypeScript narrows lock to include handle methods after ok check
    const { lockId, fence } = lock; // lockId for ownership checks, fence for stale lock protection

    await generateDailyReport(fence);

    // Extend lock for long-running tasks
    await lock.extend(300000);
    await sendReportEmail();

    // Lock released automatically here
  } else {
    console.log("Resource is locked by another process");
  }
}
```

**For older runtimes (Node.js <20)**, use try/finally:

```typescript
const result = await backend.acquire({
  key: "batch:daily-report",
  ttlMs: 300000,
});

if (result.ok) {
  try {
    const { lockId, fence } = result;
    await generateDailyReport(fence);

    const extended = await backend.extend({ lockId, ttlMs: 300000 });
    if (!extended.ok) {
      throw new Error("Failed to extend lock");
    }

    await sendReportEmail();
  } finally {
    await backend.release({ lockId: result.lockId });
  }
} else {
  console.log("Resource is locked by another process");
}
```

**Error callbacks** for disposal failures:

```typescript
const backend = createRedisBackend(redis, {
  onReleaseError: (error, context) => {
    logger.error("Failed to release lock", {
      error,
      lockId: context.lockId,
      key: context.key,
    });
  },
});

// All acquisitions automatically use the error callback
await using lock = await backend.acquire({ key: "resource", ttlMs: 30000 });
```

**Note:** SyncGuard provides a safe-by-default error handler that automatically logs disposal failures in development mode (`NODE_ENV !== 'production'`). In production, enable logging with `SYNCGUARD_DEBUG=true` or provide a custom `onReleaseError` callback integrated with your observability stack.

## Configuration

### Lock Options

```typescript
import { createLock } from "syncguard/redis";
import Redis from "ioredis";

const redis = new Redis();
const lock = createLock(redis);

// All lock options shown with their defaults
await lock(
  async () => {
    // Your critical section
  },
  {
    key: "resource:123", // Required: unique identifier
    ttlMs: 30000, // Lock duration in milliseconds (default: 30s)
    acquisition: {
      timeoutMs: 5000, // Max acquisition wait (default: 5s)
      maxRetries: 10, // Retry attempts (default: 10)
      retryDelayMs: 100, // Initial retry delay (default: 100ms)
      backoff: "exponential", // Strategy: "exponential" | "fixed" (default: "exponential")
      jitter: "equal", // Strategy: "equal" | "full" | "none" (default: "equal")
    },
  },
);
```

**Backoff & Jitter Strategy:**

- `backoff: "exponential"` - Double the delay each retry (100ms → 200ms → 400ms...). Recommended for handling contention gracefully.
- `backoff: "fixed"` - Keep delay constant (100ms → 100ms → 100ms).
- `jitter: "equal"` - Add ±50% random variance. Prevents thundering herd in high-contention scenarios.
- `jitter: "full"` - Add 0-100% random variance. Maximum randomization.
- `jitter: "none"` - No randomization.

**Timeout Behavior:**
The `timeoutMs` is a hard limit for the entire acquisition loop. If the lock hasn't been acquired within `timeoutMs` milliseconds, `AcquisitionTimeout` error is thrown.

### Backend Configuration

```typescript
// Redis
const lock = createLock(redis, {
  keyPrefix: "myapp", // Default: "syncguard"
});

// PostgreSQL
await setupSchema(sql, {
  tableName: "app_locks",
  fenceTableName: "app_fences",
});
const lock = createLock(sql, {
  tableName: "app_locks", // Default: "syncguard_locks"
  fenceTableName: "app_fences", // Default: "syncguard_fence_counters"
  // ⚠️ Use the same table names in both setupSchema and createLock
});

// Firestore
const lock = createLock(db, {
  collection: "app_locks", // Default: "locks"
  fenceCollection: "app_fences", // Default: "fence_counters"
});
```

### Backend-Specific Setup

**PostgreSQL:**
Call `setupSchema(sql)` once during initialization to create required tables and indexes.

**Firestore:**
Ensure the single-field index on `lockId` remains enabled (Firestore creates these by default). If you have disabled single-field indexes, add one:

```bash
gcloud firestore indexes create --collection-group=locks --field-config=field-path=lockId,order=ASCENDING
```

See [Firestore setup guide](./firestore/README.md) for details.

## Error Handling

```typescript
import { LockError } from "syncguard";

try {
  await lock(
    async () => {
      // Critical section
    },
    { key: "resource:123" },
  );
} catch (error) {
  if (error instanceof LockError) {
    console.error(`Lock error [${error.code}]:`, error.message);
    // Handle specific error codes
    switch (error.code) {
      case "AcquisitionTimeout":
        // Retry timeout exceeded
        break;
      case "ServiceUnavailable":
        // Backend temporarily unavailable
        break;
      // ... other cases
    }
  }
}
```

### Error Codes

SyncGuard throws `LockError` with one of these error codes:

| Code                 | Meaning                                | When Thrown                                               |
| -------------------- | -------------------------------------- | --------------------------------------------------------- |
| `AcquisitionTimeout` | Retry loop exceeded timeoutMs          | Lock acquisition didn't succeed within the timeout window |
| `ServiceUnavailable` | Backend service unavailable            | Network failures, service unreachable, 5xx responses      |
| `AuthFailed`         | Authentication or authorization failed | Invalid credentials, insufficient permissions for backend |
| `InvalidArgument`    | Invalid argument or malformed request  | Invalid key/lockId format, bad configuration              |
| `RateLimited`        | Rate limit exceeded on backend         | Quota exceeded, throttling applied by backend             |
| `NetworkTimeout`     | Network operation timed out            | Client-side or network timeouts to backend                |
| `Aborted`            | Operation cancelled via AbortSignal    | User-initiated cancellation during acquisition            |
| `Internal`           | Unexpected backend error               | Unclassified failures, server-side errors                 |

## Common Patterns

### Preventing Duplicate Job Processing

```typescript
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

### Rate Limiting

```typescript
const backend = createRedisBackend(redis);

const checkRateLimit = async (userId: string) => {
  const result = await backend.acquire({
    key: `rate:${userId}`,
    ttlMs: 60000, // 1 minute window
  });

  if (!result.ok) {
    throw new Error("Rate limit exceeded");
  }

  // Note: Intentionally NOT releasing the lock here!
  // The lock auto-expires after ttlMs, preventing the same user from
  // acquiring another lock within that window. This implements basic
  // rate limiting without manual release overhead.
  return performOperation(userId);
};
```

**Important:** This pattern intentionally doesn't release the lock. It's appropriate for rate-limiting because:

- The lock auto-expires after `ttlMs`, naturally cleaning up without needing explicit release
- Other users trying to acquire the same key before expiration will fail, enforcing the rate limit
- This is different from critical section protection, where you always release the lock after the operation completes

## Key Concepts

### Fencing Tokens

Fencing tokens are monotonic counters that prevent stale writes in distributed systems. Each successful lock acquisition returns a `fence` token—a 15-digit zero-padded decimal string that increases with each new acquisition of the same resource.

**Why use them?** In distributed systems, a slow operation might complete after its lock has expired and been acquired by another process. Without fencing tokens, a stale write from the old operation could corrupt data. With fencing tokens, the backend/application can reject stale writes.

**Usage pattern:**

```typescript
const { fence } = await backend.acquire({ key: "resource:123", ttlMs: 30000 });

// Use fence when performing operations on the backend
await updateResource(resourceId, newValue, fence); // Backend verifies fence before accepting
```

**Ownership checking (diagnostic use only):**

```typescript
import { owns, getByKey } from "syncguard";

// Check if you still own the lock (for monitoring/diagnostics)
const stillOwned = await owns(backend, lockId);

// Get lock info by resource key
// Returns { lockId, fence, expiresAtMs } or undefined if not locked
const info = await getByKey(backend, "resource:123");
if (info) {
  console.log(`Lock expires in ${info.expiresAtMs - Date.now()}ms`);
}
```

**⚠️ Important:** Don't check ownership before calling `release()` or `extend()`. These operations are safe to call without pre-checking—they return `{ ok: false }` if the lock was already released or expired.

### Lock TTL (Time-to-Live)

The `ttlMs` parameter controls automatic lock expiration. Locks automatically expire if not released before the TTL elapses, providing critical protection against process crashes.

**Recommended TTL values:**

- **Short operations** (< 10 seconds): `ttlMs: 30000` (30 seconds)
- **Medium operations** (10-60 seconds): `ttlMs: 120000` (2 minutes)
- **Long-running tasks** (> 1 minute): Use `extend()` to periodically renew instead of setting a very long TTL

**For long-running operations, use heartbeat pattern:**

```typescript
const { lockId, fence } = await backend.acquire({
  key: "batch:long-report",
  ttlMs: 30000, // Short TTL
});

try {
  // Periodically extend the lock every 20 seconds
  const heartbeat = setInterval(async () => {
    const extended = await backend.extend({ lockId, ttlMs: 30000 });
    if (!extended.ok) {
      console.warn("Failed to extend lock, stopping operation");
      clearInterval(heartbeat);
    }
  }, 20000);

  await performLongRunningOperation();
  clearInterval(heartbeat);
} finally {
  await backend.release({ lockId });
}
```

### Time Authority and Clock Synchronization

Different backends use different time sources, which affects consistency guarantees:

**Redis (Server Time Authority):**

- Uses Redis server time for all lock expirations
- Highest consistency guarantee—no client-side clock synchronization needed
- Ideal for high-consistency use cases and multi-region deployments

**PostgreSQL (Server Time Authority):**

- Uses PostgreSQL server time for lock expirations
- Similar consistency to Redis
- No client-side clock sync required

**Firestore (Client Time Authority):**

- Uses client-side `Date.now()` for lock expirations
- ⚠️ Requires NTP synchronization on all clients (critical!)
- If client clocks drift >1000ms, locks may behave unexpectedly
- Operational monitoring of client clock health is essential for production deployments

## Features

- 🔒 **Bulletproof concurrency** - Atomic operations prevent race conditions
- 🛡️ **Fencing tokens** - Monotonic counters protect against stale writes
- 🧹 **Automatic cleanup** - TTL-based expiration + `await using` (AsyncDisposable) support
- 🔄 **Backend flexibility** - Redis (performance), PostgreSQL (zero overhead), or Firestore (serverless)
- 🔁 **Smart retries** - Exponential backoff with jitter handles contention
- 💙 **TypeScript-first** - Full type safety with compile-time guarantees
- 📊 **Optional telemetry** - Opt-in observability via decorator pattern

## Troubleshooting

### Locks Not Being Released

**Symptoms:** Locks remain held longer than expected, or onReleaseError callbacks show disposal errors.

**Diagnosis:**

1. Check that `await using` blocks complete or try/finally blocks execute `release()`
2. Look for infinite loops or unhandled promise rejections
3. Review `onReleaseError` callback logs for specific errors

**Solutions:**

```typescript
// ✓ Correct: Lock always released
await using lock = await backend.acquire({ key: "resource", ttlMs: 30000 });
// Lock released here even if error occurs

// ✗ Wrong: Infinite loop prevents release
await using lock = await backend.acquire({ key: "resource", ttlMs: 30000 });
while (true) {
  // Never exits!
  await someOperation();
}
```

### Lock Acquisition Times Out

**Symptoms:** `AcquisitionTimeout` errors when trying to acquire locks.

**Diagnosis:**

1. Is the `timeoutMs` value too short for your contention level?
2. Is the resource legitimately locked by another process?
3. Are there network issues to the backend?

**Solutions:**

```typescript
// Increase timeout for high-contention resources
await lock(fn, {
  key: "hot-resource",
  ttlMs: 30000,
  acquisition: {
    timeoutMs: 30000, // Was 5000, now 30 seconds
    maxRetries: 20,
  },
});

// Or use exponential backoff with jitter (default)
// This handles contention more gracefully
```

### Backend Connection Failures

**Symptoms:** `ServiceUnavailable` or `NetworkTimeout` errors.

**Diagnosis:**

1. Verify backend is running and accessible
2. Check network connectivity from your application
3. Review backend logs for errors

**For Redis:** Verify `redis-cli ping` returns PONG
**For PostgreSQL:** Verify `psql -U user -h localhost` connects successfully
**For Firestore:** Verify credentials and emulator status if using emulator

### Multiple Processes Acquiring the Same Lock

**Symptoms:** Two processes seem to hold the same lock simultaneously.

**Diagnosis:**

1. Are all processes using the same lock key?
2. Did the first process release the lock?
3. Did the TTL expire before release?

**Verify lock ownership:**

```typescript
import { owns } from "syncguard";

// Check who currently owns this lock
const stillOwned = await owns(backend, lockId);
if (!stillOwned) {
  console.warn("Lock was released or expired");
}

// Get lock info by key
const info = await getByKey(backend, "payment:123");
if (info && info.expiresAtMs > Date.now()) {
  console.log("Lock is currently held");
}
```

### Performance Issues

**Symptoms:** Lock operations are slow or cause high backend load.

**Considerations:**

- **Contention:** High contention naturally causes retries. Consider sharding keys.
- **TTL:** Very long TTLs increase backend memory usage
- **Polling:** Frequent `isLocked()` or `getByKey()` calls can overload the backend

**Solutions:**

```typescript
// Shard hot keys across multiple lock instances
const shardIndex = hashUserId(userId) % 10;
const lock = await backend.acquire({
  key: `payment:${shardIndex}:${userId}`,
  ttlMs: 30000,
});

// Use smart retry strategy
acquisition: {
  backoff: 'exponential',  // Reduce retry frequency over time
  jitter: 'equal',         // Prevent thundering herd
  maxRetries: 20,
  retryDelayMs: 100,
}
```

## Contributing

We welcome contributions! Here's how you can help:

- 🐛 **Bug fixes** - Include test cases
- 🚀 **New backends** - Follow [specs/interface.md](./specs/interface.md)
- 📖 **Documentation** - Examples, guides, troubleshooting
- 📋 **Spec reviews** - Validate specs match implementation, propose improvements
- ✅ **Tests** - Improve coverage

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for detailed guidelines.

## Support & Documentation

- **Docs**: [Full documentation](https://kriasoft.com/syncguard/)
- **Specs**: [Technical specifications](./specs/) - Architecture decisions and backend requirements
- **Discord**: [Join our community](https://discord.gg/EnbEa7Gsxg)
- **Issues**: [GitHub Issues](https://github.com/kriasoft/syncguard/issues)

## Backers

<a href="https://reactstarter.com/b/1"><img src="https://reactstarter.com/b/1.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/2"><img src="https://reactstarter.com/b/2.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/3"><img src="https://reactstarter.com/b/3.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/4"><img src="https://reactstarter.com/b/4.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/5"><img src="https://reactstarter.com/b/5.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/6"><img src="https://reactstarter.com/b/6.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/7"><img src="https://reactstarter.com/b/7.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/8"><img src="https://reactstarter.com/b/8.png" height="60" /></a>

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
