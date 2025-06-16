# SyncGuard

TypeScript distributed lock library that prevents race conditions across services. Because nobody wants their payment processed twice! 💸

Supports Firestore and Redis backends with automatic cleanup and bulletproof concurrency control.

## Installation

```bash
npm install syncguard @google-cloud/firestore
# or with Redis (for the speed demons 🏎️)
npm install syncguard ioredis
```

## Usage

### Basic Example - Preventing Race Conditions

```typescript
import { createLock } from "syncguard/firestore";
import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();
const lock = createLock(db);

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

### Manual Lock Control

```typescript
// For long-running operations that need more control
const result = await lock.acquire({
  key: "batch:daily-report",
  ttlMs: 300000, // 5 minutes
  timeoutMs: 10000, // Wait up to 10s to acquire
});

if (result.success) {
  try {
    await generateDailyReport();

    // Extend lock if needed (critical: handle failures!)
    const extended = await lock.extend(result.lockId, 300000);
    if (!extended) {
      throw new Error(
        "Failed to extend lock - aborting to prevent race conditions",
      );
    }

    await sendReportEmail();
  } finally {
    await lock.release(result.lockId);
  }
} else {
  console.error("Could not acquire lock:", result.error);
}
```

### Multiple Backends

```typescript
// Firestore
import { createLock } from "syncguard/firestore";
const firestoreLock = createLock(new Firestore());

// Redis
import { createLock } from "syncguard/redis";
const redisLock = createLock(redisClient);

// Custom backend
import { createLock } from "syncguard";
const customLock = createLock(myBackend);
```

## Configuration

All the knobs and dials you need to tune your locks to perfection:

```typescript
interface LockConfig {
  key: string; // Unique lock identifier
  ttlMs?: number; // Lock duration (default: 30s)
  timeoutMs?: number; // Max wait time to acquire (default: 5s)
  maxRetries?: number; // Retry attempts (default: 10)
  retryDelayMs?: number; // Delay between retries (default: 100ms)
}
```

### Firestore Backend Options

```typescript
const lock = createLock(db, {
  collection: "app_locks", // Custom collection name (default: "locks")
  retryDelayMs: 200, // Override retry delay
  maxRetries: 15, // More aggressive retries
});
```

**⚠️ Important:** Firestore backend requires an index on the `lockId` field for optimal performance. Without it, your locks will be slower than a sleepy sloth! 🦥

## Error Handling

When things go sideways (and they will), handle it gracefully:

```typescript
import { LockError } from "syncguard";

try {
  await lock(
    async () => {
      // Your critical section here
    },
    { key: "resource:123" },
  );
} catch (error) {
  if (error instanceof LockError) {
    console.error("Lock operation failed:", error.code, error.message);
    // Handle specific error types: ACQUISITION_FAILED, TIMEOUT, etc.
  }
}
```

## Common Patterns

### Preventing Duplicate Job Processing

"I said do it once, not twice!" - Every developer ever

```typescript
const processJob = async (jobId: string) => {
  await lock(
    async () => {
      const job = await getJob(jobId);
      if (job.status === "pending") {
        await executeJob(job);
        await markJobComplete(jobId);
      }
      // If job was already processed, this is a no-op (which is perfect!)
    },
    { key: `job:${jobId}`, ttlMs: 300000 }, // 5 minute timeout
  );
};
```

### Rate Limiting

Because some users think your API is a free-for-all

```typescript
const checkRateLimit = async (userId: string) => {
  const result = await lock.acquire({
    key: `rate:${userId}`,
    ttlMs: 60000, // 1 minute window
    timeoutMs: 0, // Fail immediately if locked
    maxRetries: 0, // No retries for rate limiting
  });

  if (!result.success) {
    throw new Error("Rate limit exceeded. Slow down there, speed racer! 🏁");
  }

  // Don't release - let it expire naturally for rate limiting
  return performOperation(userId);
};
```

### Database Migration Lock

Single-file migrations only, please

```typescript
const runMigration = async (version: string) => {
  await lock(
    async () => {
      const currentVersion = await getCurrentDbVersion();
      if (currentVersion < version) {
        console.log(`Running migration to version ${version}...`);
        await runMigrationScripts(version);
        await updateDbVersion(version);
      } else {
        console.log("Migration already applied, skipping");
      }
    },
    { key: "db:migration", ttlMs: 600000 }, // 10 minutes for safety
  );
};
```

## Custom Backends

Implement the `LockBackend` interface for custom storage:

```typescript
import { LockBackend, createLock } from "syncguard";

const myBackend: LockBackend = {
  async acquire(config) {
    /* your implementation */
  },
  async release(lockId) {
    /* your implementation */
  },
  async extend(lockId, ttl) {
    /* your implementation */
  },
  async isLocked(key) {
    /* your implementation */
  },
};

const lock = createLock(myBackend);
```

## Support

Got questions? Hit a snag? Or just want to share your awesome WebSocket creation? Find us on [Discord](https://discord.com/invite/bSsv7XM). We promise we don't bite (usually 😉).

## Backers

<a href="https://reactstarter.com/b/1"><img src="https://reactstarter.com/b/1.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/2"><img src="https://reactstarter.com/b/2.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/3"><img src="https://reactstarter.com/b/3.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/4"><img src="https://reactstarter.com/b/4.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/5"><img src="https://reactstarter.com/b/5.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/6"><img src="https://reactstarter.com/b/6.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/7"><img src="https://reactstarter.com/b/7.png" height="60" /></a>&nbsp;&nbsp;<a href="https://reactstarter.com/b/8"><img src="https://reactstarter.com/b/8.png" height="60" /></a>

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
