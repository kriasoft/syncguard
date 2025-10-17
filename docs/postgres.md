# PostgreSQL Backend

Distributed locking using PostgreSQL as the backend. Ideal for applications already using PostgreSQL or requiring ACID transaction guarantees with relational database infrastructure.

::: danger CRITICAL: Never Delete Fence Counters
Fence counter records in the fence table MUST NEVER be deleted. Deleting fence counters breaks monotonicity guarantees and violates fencing safety. Cleanup operations MUST only target lock records in the lock table, never fence counter records.

See [Fence Counter Lifecycle](#fence-counter-lifecycle) section for complete details.
:::

::: tip Technical Specifications
For backend implementers: See [specs/postgres-backend.md](https://github.com/kriasoft/syncguard/blob/main/specs/postgres-backend.md) for complete implementation requirements, transaction patterns, and architecture decisions.
:::

## Installation

```bash
npm install syncguard postgres
```

## Quick Start

```ts
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
    await processPayment(paymentId);
  },
  { key: `payment:${paymentId}`, ttlMs: 30000 },
);
```

## Schema Setup

::: tip Recommended Setup Pattern
Call `setupSchema()` once during application initialization to create required tables and indexes. This is an idempotent operation that's safe to call multiple times.
:::

### Quick Start

```ts
import postgres from "postgres";
import { setupSchema, createLock } from "syncguard/postgres";

const sql = postgres("postgresql://localhost:5432/myapp");

// Setup schema (once, during initialization)
await setupSchema(sql);

// Create lock (synchronous, can be called multiple times)
const lock = createLock(sql);
```

The `setupSchema()` function creates:

- **syncguard_locks** table with primary key on `key`
- **UNIQUE INDEX** on `lock_id` (enables fast reverse lookups)
- **INDEX** on `expires_at_ms` (enables efficient cleanup)
- **syncguard_fence_counters** table with primary key on `fence_key`

### Production Setup (Manual Migrations)

For production deployments, use database migrations instead of `setupSchema()`:

```bash
# 1. Create schema via migrations (before deployment)
psql -U postgres -d myapp < postgres/schema.sql

# 2. Deploy application code (no setupSchema() call needed)
```

**Why manual migrations in production?**

- Explicit control over schema changes
- Version controlled database changes
- Avoid schema drift between environments
- Better separation between deployment and application startup

### Complete Schema Reference

::: details Click to view complete schema definition

```sql
-- ============================================================================
-- Lock Table: Primary storage for active locks
-- ============================================================================
CREATE TABLE syncguard_locks (
  -- Primary key: O(1) lookups for acquire/isLocked
  key TEXT PRIMARY KEY,
  -- Lock identifier: 22-char base64url (cryptographically random)
  lock_id TEXT NOT NULL,
  -- Timestamps: Milliseconds since epoch
  expires_at_ms BIGINT NOT NULL,
  acquired_at_ms BIGINT NOT NULL,
  -- Fence token: 15-digit zero-padded string (e.g., "000000000000042")
  fence TEXT NOT NULL,
  -- Original user key: For debugging and sanitization
  user_key TEXT NOT NULL
);

-- ============================================================================
-- Required Indexes
-- ============================================================================
-- Index for reverse lookup by lockId (release/extend/lookup operations)
CREATE UNIQUE INDEX idx_syncguard_locks_lock_id ON syncguard_locks (lock_id);

-- Index for cleanup queries and operational monitoring
-- Enables efficient: SELECT * FROM locks WHERE expires_at_ms < NOW()
CREATE INDEX idx_syncguard_locks_expires ON syncguard_locks (expires_at_ms);

-- ============================================================================
-- Fence Counter Table: Monotonic counters (NEVER deleted)
-- ============================================================================
CREATE TABLE syncguard_fence_counters (
  -- Primary key: Derived via two-step pattern (see ADR-006)
  fence_key TEXT PRIMARY KEY,
  -- Monotonic counter: Starts at 0, incremented on each acquire
  fence BIGINT NOT NULL DEFAULT 0,
  -- Original key for debugging (optional)
  key_debug TEXT
);

-- ============================================================================
-- Optional: Human-Readable Timestamps (for debugging/monitoring)
-- ============================================================================
-- These are truly optional and can be added without code changes
-- Useful for manual queries: SELECT * FROM locks WHERE expires_at_ts < NOW()
ALTER TABLE syncguard_locks
ADD COLUMN IF NOT EXISTS expires_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(expires_at_ms / 1000.0)) STORED,
ADD COLUMN IF NOT EXISTS acquired_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(acquired_at_ms / 1000.0)) STORED;
```

**Key Points:**

- **syncguard_locks**: Stores active lock records (deleted on release/expiration)
- **syncguard_fence_counters**: Stores persistent fence counters (never deleted)
- **Required indexes**: UNIQUE on `lock_id`, B-tree on `expires_at_ms`
- **Optional columns**: Human-readable timestamp columns for debugging

:::

## Configuration

### Backend Options

```ts
import { setupSchema, createPostgresBackend } from "syncguard/postgres";

// Setup with custom table names
await setupSchema(sql, {
  tableName: "app_locks",
  fenceTableName: "app_fence_counters",
});

// Create backend with matching config
const backend = createPostgresBackend(sql, {
  tableName: "app_locks", // Lock table (default: "syncguard_locks")
  fenceTableName: "app_fence_counters", // Fence counter table (default: "syncguard_fence_counters")
  cleanupInIsLocked: false, // Enable cleanup in isLocked (default: false)
});
```

**Table Names**: Lock records and fence counters use separate tables. Configure both to match your project structure:

```ts
const prefix = process.env.NODE_ENV === "production" ? "prod" : "dev";

await setupSchema(sql, {
  tableName: `${prefix}_locks`,
  fenceTableName: `${prefix}_fence_counters`,
});

const backend = createPostgresBackend(sql, {
  tableName: `${prefix}_locks`,
  fenceTableName: `${prefix}_fence_counters`,
});
```

**Cleanup in isLocked**: When enabled, expired locks may be cleaned up during `isLocked()` checks. Disabled by default to maintain pure read semantics.

::: warning Index Requirements
Create indexes for **both** tables if using custom names. See `postgres/schema.sql` for complete schema definitions.
:::

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

PostgreSQL backend provides excellent performance for distributed locking:

- **Latency**: Sub-millisecond for local PostgreSQL, <10ms for remote
- **Throughput**: 500-2000 ops/sec depending on hardware and connection pooling
- **Transactions**: All mutations use ACID transactions with row-level locking

### Transaction Overhead

Each operation involves:

1. Start transaction (`BEGIN`)
2. Capture server time (`NOW()`)
3. Read with row-level locks (`FOR UPDATE`)
4. Verify expiration and ownership
5. Write updates
6. Commit transaction

Total latency: ~2-5ms for local connections, ~5-20ms for remote connections.

### Connection Pooling

Use postgres.js connection pooling for optimal performance:

```ts
const sql = postgres("postgresql://localhost:5432/myapp", {
  max: 20, // Connection pool size
  idle_timeout: 60, // Seconds before idle connections are closed
  connect_timeout: 30, // Seconds before connection attempt times out
});
```

Without connection pooling, each operation creates a new connection, significantly increasing latency.

## PostgreSQL-Specific Features

### Server Time Authority

PostgreSQL uses **server time** (`EXTRACT(EPOCH FROM NOW())`) for all expiration checks, eliminating clock drift issues:

```ts
// PostgreSQL server's clock is the source of truth
// No NTP synchronization required on clients
const result = await backend.acquire({ key: "task:123", ttlMs: 60000 });
```

**Unified Tolerance** (ADR-005): All backends use a fixed 1000ms tolerance for predictable, consistent behavior across PostgreSQL, Redis, and Firestore. This tolerance is internal and not user-configurable.

### Atomic Operations via Transactions

All mutations execute atomically via PostgreSQL transactions with row-level locking:

- **Acquire**: Lock row (`FOR UPDATE`) → check expiration → **two-step fence increment** → upsert lock
- **Release**: Query by lockId (`FOR UPDATE`) → verify ownership → delete lock
- **Extend**: Query by lockId (`FOR UPDATE`) → verify ownership → update TTL

PostgreSQL guarantees no race conditions within transactions.

**Fence Counter Atomicity**: The acquire operation uses **advisory lock + two-step pattern** to prevent race conditions:

1. **Serialize per key**: `pg_advisory_xact_lock()` ensures only one transaction proceeds per storage key
2. **Ensure row exists**: `INSERT ... ON CONFLICT DO NOTHING` (idempotent initialization)
3. **Increment with lock**: `UPDATE fence = fence + 1` (implicit row lock serializes concurrent updates)

This pattern guarantees:

- **Monotonic fence tokens**: Even when fence counter row doesn't exist yet
- **Single winner**: Only one client acquires the lock, others get contention
- **No duplicate fence=1**: Advisory lock prevents concurrent initialization race

### Storage Pattern

PostgreSQL backend uses a dual-table pattern:

```text
syncguard_locks (lock records)
  key                → PRIMARY KEY
  lock_id            → UNIQUE INDEX (enables keyless release/extend)
  expires_at_ms      → INDEX (enables efficient cleanup)
  acquired_at_ms     → Timestamp
  fence              → Fencing token (15-digit string)
  user_key           → Original user key for diagnostics

syncguard_fence_counters (fence counters)
  fence_key          → PRIMARY KEY (derived from user key)
  fence              → BIGINT counter (persists indefinitely)
```

Lock records are deleted on release or expiration. Fence counters persist indefinitely (required for fencing safety).

### Fence Counter Lifecycle

**CRITICAL**: Fence counters are intentionally persistent and MUST NOT be deleted:

```sql
-- ❌ NEVER do this - breaks monotonicity guarantee and fencing safety
DELETE FROM syncguard_fence_counters WHERE fence_key = $1; -- Violates fencing safety
```

**Why This Is Critical**:

- **Monotonicity guarantee**: Deleting counters breaks the strictly increasing fence token requirement
- **Cross-backend consistency**: PostgreSQL must match Redis/Firestore's fence counter persistence behavior
- **Fencing safety**: Counter reset would allow fence token reuse, violating safety guarantees
- **Cleanup configuration**: The `cleanupInIsLocked` option MUST NOT affect fence counter records

**Lifecycle Requirements**:

- Lock records are deleted on release or expiration
- Fence counters survive indefinitely (required for fencing safety)
- Cleanup operations **never** delete fence counters
- Both tables MUST be separate (enforced via config validation)

**Configuration Safety**: The backend validates that `fenceTableName` differs from `tableName` to prevent accidental deletion. Attempting to use the same table for both will throw `LockError("InvalidArgument")`.

::: info Dual Table Pattern
See [specs/postgres-backend.md § Fencing Token Implementation](https://github.com/kriasoft/syncguard/blob/main/specs/postgres-backend.md#fencing-token-implementation) for the complete dual-table pattern specification and atomic transaction requirements.
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

// Safe for multiple workers to call simultaneously
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

### Long-Running Tasks with Heartbeat

```ts
import { owns, setupSchema, createPostgresBackend } from "syncguard/postgres";

await setupSchema(sql);
const backend = createPostgresBackend(sql);
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

### Connection Issues

If you see `ServiceUnavailable` errors:

```ts
const sql = postgres("postgresql://localhost:5432/myapp", {
  max: 20, // Connection pool size
  connect_timeout: 30, // Connection timeout (seconds)
  idle_timeout: 60, // Idle connection timeout (seconds)
  max_lifetime: 3600, // Max connection lifetime (seconds)
});
```

**Symptoms of connection issues**:

- `ECONNREFUSED`: PostgreSQL server not running or wrong host/port
- `ECONNRESET`: Network interruption or server restart
- `Connection timeout`: Server unreachable or under heavy load

**Solution**: Check PostgreSQL server status, network connectivity, and connection pool configuration.

### Missing Index Errors

If you see slow queries or query timeouts:

```text
-- Check if required indexes exist
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'syncguard_locks';

-- Expected indexes:
-- - PRIMARY KEY on key
-- - UNIQUE INDEX on lock_id
-- - INDEX on expires_at_ms
```

**Solution**: Create the required indexes using `postgres/schema.sql` as reference.

### Transaction Conflicts

Under high contention, PostgreSQL may serialize transactions:

```ts
// SyncGuard automatically retries failed transactions
// If you see frequent conflicts, adjust retry configuration:

await lock(
  async () => {
    // Your work
  },
  {
    key: "resource:123",
    acquisition: {
      maxRetries: 20, // Increase retries
      retryDelayMs: 200, // Increase delay
      timeoutMs: 10000, // Increase timeout
    },
  },
);
```

### Key Length Limits

PostgreSQL identifiers have a 1500-byte limit. SyncGuard automatically truncates keys exceeding limits:

```ts
// Long keys are automatically truncated using hash-based truncation
const result = await backend.acquire({
  key: "x".repeat(2000), // Automatically truncated
  ttlMs: 30000,
});
```

User-supplied keys are capped at 512 bytes after normalization.

### Table Management

Monitor lock and fence counter table sizes:

```sql
-- Check table sizes
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE tablename LIKE 'syncguard%';

-- Count active locks
SELECT COUNT(*) FROM syncguard_locks WHERE expires_at_ms > EXTRACT(EPOCH FROM NOW()) * 1000;

-- Count fence counters
SELECT COUNT(*) FROM syncguard_fence_counters;
```

**Memory considerations**:

- Each lock record: ~200-300 bytes
- Each fence counter: ~100-150 bytes
- 1M fence counters: ~100-150MB (typically acceptable)

For applications generating >10M unique lock keys annually, consider key normalization or periodic fence counter archival (if monotonicity can be guaranteed through other means).

::: info Fence Counter Persistence
Fence counters are intentionally persistent. See [specs/postgres-backend.md § Fence Counter Table Requirements](https://github.com/kriasoft/syncguard/blob/main/specs/postgres-backend.md#fence-counter-table-requirements) for the complete rationale and operational guidance.
:::

::: tip Performance Tip
Use a dedicated PostgreSQL database or schema for locks to isolate lock operations from application queries and simplify monitoring.
:::
