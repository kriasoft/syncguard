# Getting Started

Get your first distributed lock running in under 5 minutes.

## Installation

::: code-group

```bash [Redis]
npm install syncguard ioredis
```

```bash [PostgreSQL]
npm install syncguard postgres
```

```bash [Firestore]
npm install syncguard @google-cloud/firestore
```

:::

Install only the backend you need. Peer dependencies are optional.

## Quick Start (Redis)

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
      await chargeCard(payment.amount);
      await updateStatus(paymentId, "completed");
    }
  },
  { key: `payment:${paymentId}` },
);
```

## Quick Start (PostgreSQL)

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

::: tip PostgreSQL Schema Setup
Call `setupSchema()` once during application initialization to create required tables and indexes. This is an idempotent operation safe to call multiple times. See `postgres/schema.sql` for complete table and index definitions.
:::

## Quick Start (Firestore)

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

::: tip Firestore Index Required
For optimal performance, create a single-field ascending index on the `lockId` field in your `locks` collection. Firestore typically auto-creates this for equality queries, but verify in production.
:::

That's it. The `lock()` function handles acquisition, retries, execution, and release automatically.

## Configuration Basics

Customize lock behavior with inline options:

```typescript
await lock(workFn, {
  key: "job:daily-report", // Required: unique lock identifier
  ttlMs: 60000, // Lock expires after 60s (default: 30s)
  timeoutMs: 10000, // Give up acquisition after 10s (default: 5s)
  maxRetries: 20, // Retry up to 20 times on contention (default: 10)
});
```

**Key guidelines**:

- `ttlMs`: Short enough to minimize impact of crashed processes, long enough for your work
- `timeoutMs`: How long to wait for contended locks before giving up
- `maxRetries`: Higher = more patient under load; uses exponential backoff with jitter

Backend-specific config (collection names, key prefixes):

::: code-group

```typescript [Redis]
const lock = createLock(redis, {
  keyPrefix: "my-app", // Default: "syncguard"
});
```

```typescript [PostgreSQL]
// Setup schema with custom table names
await setupSchema(sql, {
  tableName: "app_locks",
  fenceTableName: "app_fence_counters",
});

// Create lock with matching config
const lock = createLock(sql, {
  tableName: "app_locks", // Default: "syncguard_locks"
  fenceTableName: "app_fence_counters", // Default: "syncguard_fence_counters"
});
```

```typescript [Firestore]
const lock = createLock(db, {
  collection: "app_locks", // Default: "locks"
  fenceCollection: "app_fences", // Default: "fence_counters"
});
```

:::

## Manual Lock Control

For long-running tasks or custom retry logic, use the backend directly:

```typescript
import { createRedisBackend } from "syncguard/redis";

const backend = createRedisBackend(redis);

// Acquire lock manually
const result = await backend.acquire({
  key: "batch:daily-report",
  ttlMs: 300000, // 5 minutes
});

if (result.ok) {
  try {
    const { lockId, fence } = result;
    await generateReport(fence);

    // Extend lock for long-running tasks
    const extended = await backend.extend({
      lockId,
      ttlMs: 300000, // Another 5 minutes
    });

    if (!extended.ok) {
      throw new Error("Failed to extend lock");
    }

    await sendReportEmail();
  } finally {
    await backend.release({ lockId: result.lockId });
  }
} else {
  console.log("Resource locked by another process");
}
```

**Why manual mode?**

- Extending locks during long-running work
- Custom retry strategies
- Conditional lock release
- Access to fencing tokens (see [Fencing Tokens](/fencing))

## Error Handling

Lock operations throw `LockError` for system failures:

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
    console.error(`[${error.code}] ${error.message}`);

    // Handle specific error codes
    if (error.code === "AcquisitionTimeout") {
      // Contention exceeded timeout
    } else if (error.code === "ServiceUnavailable") {
      // Backend unavailable, retry later
    }
  }
}
```

**Common error codes**:

- `AcquisitionTimeout`: Couldn't acquire lock within `timeoutMs` (contention)
- `ServiceUnavailable`: Backend unavailable (network/connection issues)
- `NetworkTimeout`: Operation timed out (client-side timeout)
- `InvalidArgument`: Invalid parameters (malformed key/lockId)

::: tip
See [API Reference](/api#lockerror) for all error codes. For backend error mapping specifications, see [specs/interface.md § Error Handling](https://github.com/kriasoft/syncguard/blob/main/specs/interface.md#error-handling-standards).
:::
