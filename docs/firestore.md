# Firestore Backend

Distributed locking using Google Cloud Firestore as the backend. Ideal for applications already using Firestore or requiring serverless infrastructure.

::: danger CRITICAL: Never Delete Fence Counters
Fence counter documents in the `fence_counters` collection MUST NEVER be deleted. Deleting fence counters breaks monotonicity guarantees and violates fencing safety. Cleanup operations MUST only target lock documents in the `locks` collection, never fence counter documents.

See [Fence Counter Lifecycle](#fence-counter-lifecycle) section for complete details.
:::

::: tip Technical Specifications
For backend implementers: See [specs/firestore-backend.md](https://github.com/kriasoft/syncguard/blob/main/specs/firestore-backend.md) for complete implementation requirements, transaction patterns, and architecture decisions.
:::

## Installation

```bash
npm install syncguard @google-cloud/firestore
```

## Quick Start

```ts
import { createLock } from "syncguard/firestore";
import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();
const lock = createLock(db);

await lock(
  async () => {
    // Your critical section
    await processPayment(paymentId);
  },
  { key: `payment:${paymentId}`, ttlMs: 30000 },
);
```

## Required Index

::: warning Critical Setup Step
Firestore backend **requires** a single-field index on the `lockId` field for optimal performance.
:::

Create the index before production use:

```bash
# Via Firebase Console
1. Navigate to Firestore > Indexes
2. Create single-field index: collection="locks", field="lockId", mode="Ascending"

# Via Terraform
resource "google_firestore_index" "lock_id" {
  collection = "locks"
  fields {
    field_path = "lockId"
    order      = "ASCENDING"
  }
}
```

Without this index, `release()` and `extend()` operations will be slow and may hit quota limits.

## Configuration

### Backend Options

```ts
import { createFirestoreBackend } from "syncguard/firestore";

const backend = createFirestoreBackend(db, {
  collection: "app_locks", // Lock documents (default: "locks")
  fenceCollection: "fence_counters", // Fence counters (default: "fence_counters")
  cleanupInIsLocked: false, // Enable cleanup in isLocked (default: false)
});
```

**Collections**: Lock documents and fence counters use separate collections. Configure both to match your project structure:

```ts
const prefix = process.env.NODE_ENV === "production" ? "prod" : "dev";

const backend = createFirestoreBackend(db, {
  collection: `${prefix}_locks`,
  fenceCollection: `${prefix}_fence_counters`,
});
```

**Cleanup in isLocked**: When enabled, expired locks may be cleaned up during `isLocked()` checks. Disabled by default to maintain pure read semantics.

::: warning Index Requirements
Create indexes for **both** collections if using custom names.
:::

### Lock Options

```ts
await lock(workFn, {
  key: "resource:123", // Required: unique identifier
  ttlMs: 30000, // Lock duration (default: 30s)
  timeoutMs: 5000, // Max acquisition wait (default: 5s)
  maxRetries: 10, // Retry attempts (default: 10)
});
```

## Time Synchronization

Firestore uses **client time** for expiration checks. NTP synchronization is **required** in production environments.

### Requirements

- **Unified Tolerance**: Fixed 1000ms tolerance (same as Redis) for consistent cross-backend behavior (ADR-005)
- **NTP Sync (REQUIRED)**: Deploy NTP synchronization on ALL clients
- **Deployment Monitoring (REQUIRED)**: Implement NTP sync monitoring in deployment pipeline
- **Health Checks (REQUIRED)**: Add application-level health checks that detect and alert on clock skew
- **Non-configurable**: Tolerance is internal and cannot be changed to prevent semantic drift

**Operational Policy**: See [specs/firestore-backend.md § Clock Synchronization Requirements](https://github.com/kriasoft/syncguard/blob/main/specs/firestore-backend.md#firestore-clock-sync-requirements) for the complete operational policy ladder (target/warn/block thresholds) and their relationship to TIME_TOLERANCE_MS.

### Checking Time Sync

```bash
# Linux/macOS - check NTP status
timedatectl status

# Expected: "System clock synchronized: yes"
# Check offset is within operational targets (see spec for thresholds)
```

::: danger Production Requirement
If reliable time synchronization cannot be guaranteed, **use Redis backend instead**. See the [Clock Synchronization Requirements](https://github.com/kriasoft/syncguard/blob/main/specs/firestore-backend.md#firestore-clock-sync-requirements) spec for specific deployment and monitoring thresholds.
:::

### Why Client Time?

Firestore doesn't provide server time queries. All expiration logic uses `Date.now()`. This works reliably when:

1. Servers are NTP-synchronized (see operational policy in specs)
2. Combined clock drift stays within TIME_TOLERANCE_MS (1000ms)
3. Operations complete within expected timeframes

## Performance

Firestore backend provides solid performance for most distributed locking scenarios:

- **Latency**: 2-10ms per operation depending on region
- **Throughput**: 100-500 ops/sec per collection
- **Transactions**: All mutations use atomic transactions

### Transaction Overhead

Each operation involves:

1. Start transaction
2. Read lock document(s)
3. Verify expiration and ownership
4. Write updates
5. Commit transaction

Total latency: ~5-20ms including network round-trips.

### Scaling Considerations

- **Hot keys**: Avoid >500 ops/sec on a single lock key
- **Collection limits**: Firestore handles 10k+ concurrent locks easily
- **Document size**: Lock documents are <1KB each

## Firestore-Specific Features

### Document Storage

Firestore backend uses two collections:

```text
locks/{docId}             → Lock document (lockId, key, timestamps, fence)
fence_counters/{docId}    → Monotonic counter (persists indefinitely)
```

Document IDs are generated using the same key truncation as Redis (max 1500 bytes).

### Atomic Transactions

All mutations execute atomically via `runTransaction()`:

- **Acquire**: Read lock + counter → verify expiration → increment fence → write both
- **Release**: Query by lockId → verify ownership → delete lock document
- **Extend**: Query by lockId → verify ownership → update expiration

Firestore guarantees no race conditions within transactions.

### Fence Counter Lifecycle

**CRITICAL**: Fence counters are intentionally persistent and MUST NOT be deleted:

```typescript
// ❌ NEVER do this - breaks monotonicity guarantee and fencing safety
await db.collection("fence_counters").doc(docId).delete(); // Violates fencing safety
```

**Why This Is Critical**:

- **Monotonicity guarantee**: Deleting counters breaks the strictly increasing fence token requirement
- **Cross-backend consistency**: Firestore must match Redis's fence counter persistence behavior
- **Fencing safety**: Counter reset would allow fence token reuse, violating safety guarantees
- **Cleanup configuration**: The `cleanupInIsLocked` option MUST NOT affect fence counter documents

**Lifecycle Requirements**:

- Lock documents are deleted on release or expiration
- Fence counters survive indefinitely (required for fencing safety)
- Cleanup operations **never** delete fence counters
- Both collections MUST be separate (enforced via config validation)

**Configuration Safety**: The backend validates that `fenceCollection` differs from `collection` to prevent accidental deletion. Attempting to use the same collection for both will throw `LockError("InvalidArgument")`.

::: info Dual Document Pattern
See [specs/firestore-backend.md § Fencing Token Implementation](https://github.com/kriasoft/syncguard/blob/main/specs/firestore-backend.md#fencing-token-implementation-pattern) for the complete dual-document pattern specification and atomic transaction requirements.
:::

## Common Patterns

### Distributed Job Processing

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

// Safe for multiple Cloud Functions to call simultaneously
```

### Preventing Duplicate Webhooks

```ts
const handleWebhook = async (webhookId: string, payload: unknown) => {
  await lock(
    async () => {
      const processed = await checkIfProcessed(webhookId);
      if (!processed) {
        await processWebhook(payload);
        await markProcessed(webhookId);
      }
    },
    { key: `webhook:${webhookId}`, ttlMs: 60000 },
  );
};
```

### Scheduled Task Coordination

```ts
// Multiple Cloud Scheduler jobs, only one executes
export async function dailyReport(req: Request, res: Response) {
  const today = new Date().toISOString().split("T")[0];

  const acquired = await lock(
    async () => {
      await generateDailyReport();
      return true;
    },
    { key: `daily-report:${today}`, ttlMs: 3600000 }, // 1 hour
  );

  res.status(200).send({ executed: acquired });
}
```

### Monitoring Lock Status

```ts
import { getByKey, getById, owns } from "syncguard";

// Check if a resource is currently locked
const info = await getByKey(backend, "resource:123");
if (info) {
  console.log(`Resource locked until ${new Date(info.expiresAtMs)}`);
  console.log(`Fence token: ${info.fence}`);
}

// Quick ownership check
if (await owns(backend, lockId)) {
  console.log("Still own the lock");
}

// Detailed ownership info
const owned = await getById(backend, lockId);
if (owned) {
  console.log(`Expires in ${owned.expiresAtMs - Date.now()}ms`);
}
```

## Troubleshooting

### Missing Index Error

If you see `FAILED_PRECONDITION` or slow queries:

```text
Error: The query requires an index. You can create it here:
https://console.firebase.google.com/project/.../firestore/indexes?create_composite=...
```

**Solution**: Create the required single-field index on `lockId` (see [Required Index](#required-index) section).

### Permission Denied

Firestore requires read/write permissions on the lock collections:

```javascript
// Firestore Security Rules
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /locks/{lockId} {
      allow read, write: if request.auth != null;
    }
    match /fence_counters/{lockId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Adjust rules based on your authentication strategy.

### Time Skew Issues

If locks expire unexpectedly or stay locked too long:

```bash
# Check NTP synchronization
timedatectl status

# On Docker/K8s, ensure NTP is available in containers
# Add to Dockerfile:
RUN apt-get update && apt-get install -y ntpdate
```

**Symptoms of time skew**:

- Locks expire immediately after acquisition
- Locks never expire despite TTL passing
- `extend()` operations fail with "expired" errors

**Solution**: Verify all servers have NTP sync within operational thresholds. See [Clock Synchronization Requirements](https://github.com/kriasoft/syncguard/blob/main/specs/firestore-backend.md#firestore-clock-sync-requirements) for deployment policy (target/warn/block thresholds).

### Transaction Conflicts

High contention on the same key may cause `ABORTED` transaction errors:

```ts
// SyncGuard automatically retries ABORTED transactions
// If you see frequent conflicts, reduce concurrency:

await lock(workFn, {
  key: "resource:123",
  maxRetries: 20, // Increase retries
  retryDelayMs: 200, // Increase delay
  timeoutMs: 10000, // Increase timeout
});
```

### Document Size Limits

Firestore document IDs have a 1500-byte limit. SyncGuard automatically truncates long keys:

```ts
// Long keys are automatically truncated using hash-based truncation
const result = await backend.acquire({
  key: "x".repeat(2000), // Automatically truncated to fit 1500-byte limit
  ttlMs: 30000,
});
```

User-supplied keys are capped at 512 bytes after normalization.

::: tip Cost Optimization
Firestore charges per document operation. For high-throughput scenarios (>1000 locks/sec), consider Redis backend for lower operational costs.
:::
