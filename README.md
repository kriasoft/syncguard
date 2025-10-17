# SyncGuard

[![npm version](https://badge.fury.io/js/syncguard.svg)](https://badge.fury.io/js/syncguard)
[![npm downloads](https://img.shields.io/npm/dm/syncguard.svg)](https://npmjs.com/package/syncguard)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/kriasoft/syncguard/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Discord](https://img.shields.io/discord/643523529131950086?label=Discord&logo=discord&logoColor=white)](https://discord.gg/EnbEa7Gsxg)

TypeScript distributed lock library that prevents race conditions across services. Supports Redis, PostgreSQL, and Firestore backends with automatic cleanup, fencing tokens, and bulletproof concurrency control.

## Installation

```bash
# Redis backend (recommended)
npm install syncguard ioredis

# PostgreSQL backend
npm install syncguard postgres

# Firestore backend
npm install syncguard @google-cloud/firestore
```

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
const backend = createRedisBackend(redis);

// Lock automatically released on scope exit
{
  await using lock = await backend.acquire({
    key: "batch:daily-report",
    ttlMs: 300000, // 5 minutes
  });

  if (lock.ok) {
    // TypeScript narrows lock to include handle methods after ok check
    const { fence } = lock; // Fencing token for stale lock protection

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

### Ownership Checking

```typescript
import { owns, getByKey } from "syncguard";

// Check if you still own the lock
const stillOwned = await owns(backend, lockId);

// Get lock info by resource key
const info = await getByKey(backend, "resource:123");
if (info) {
  console.log(`Lock expires in ${info.expiresAtMs - Date.now()}ms`);
}
```

## Configuration

```typescript
// Basic lock options
await lock(
  async () => {
    // Your critical section
  },
  {
    key: "resource:123", // Required: unique identifier
    ttlMs: 30000, // Lock duration (default: 30s)
    acquisition: {
      timeoutMs: 5000, // Max acquisition wait (default: 5s)
      maxRetries: 10, // Retry attempts (default: 10)
      retryDelayMs: 100, // Initial retry delay (default: 100ms)
      backoff: "exponential", // Backoff strategy: "exponential" | "fixed" (default: "exponential")
      jitter: "equal", // Jitter strategy: "equal" | "full" | "none" (default: "equal")
    },
  },
);
```

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
});

// Firestore
const lock = createLock(db, {
  collection: "app_locks", // Default: "locks"
  fenceCollection: "app_fences", // Default: "fence_counters"
});
```

::: warning Backend-Specific Setup

- **PostgreSQL**: Call `setupSchema(sql)` once during initialization to create required tables and indexes.
- **Firestore**: Requires a single-field ascending index on the `lockId` field. See [setup docs](https://kriasoft.com/syncguard/firestore#required-index).
  :::

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
    // Error codes: AcquisitionTimeout, ServiceUnavailable, NetworkTimeout, etc.
  }
}
```

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

  // Don't release - let it expire naturally
  return performOperation(userId);
};
```

## Features

- 🔒 **Bulletproof concurrency** - Atomic operations prevent race conditions
- 🛡️ **Fencing tokens** - Monotonic counters protect against stale writes
- 🧹 **Automatic cleanup** - TTL-based expiration + `await using` (AsyncDisposable) support
- 🔄 **Backend flexibility** - Redis (performance), PostgreSQL (zero overhead), or Firestore (serverless)
- 🔁 **Smart retries** - Exponential backoff with jitter handles contention
- 💙 **TypeScript-first** - Full type safety with compile-time guarantees
- 📊 **Optional telemetry** - Opt-in observability via decorator pattern

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
