# Core Concepts

Understand how distributed locks work in SyncGuard.

::: info Architecture & Design Decisions
Curious about _why_ things work this way? See [ADRs](https://github.com/kriasoft/syncguard/tree/main/docs/adr) for architectural decision records explaining the rationale behind key design choices.
:::

## Lock Lifecycle

Every lock follows a three-phase lifecycle:

1. **Acquire** — Request exclusive access with a unique key
2. **Execute** — Run your critical section while holding the lock
3. **Release** — Free the lock for others (or let TTL expire)

```typescript
// Automatic lifecycle management
await lock(
  async () => {
    // Execute phase (critical section)
  },
  { key: "resource:123" },
);

// Manual lifecycle control with automatic cleanup (Node.js ≥20)
{
  await using lock = await backend.acquire({
    key: "resource:123",
    ttlMs: 30000,
  });
  if (lock.ok) {
    // Execute phase
    // Lock automatically released on scope exit
  }
}
```

::: info Contention Handling
If another process holds the lock, acquisition returns `{ ok: false, reason: "locked" }` (manual mode) or retries automatically (auto mode).
:::

::: tip Crash Safety
Locks expire via TTL even if your process crashes. No manual cleanup required.
:::

## Lock Keys

Keys identify the resource being locked. Choose keys that uniquely represent your protected operation:

**Good keys** ✅

```typescript
`payment:${paymentId}` // Unique per payment
`job:daily-report:${date}` // Unique per day
`deploy:${environment}` // One deploy at a time per env
`webhook:${eventId}`; // Idempotent webhook handling
```

**Bad keys** ❌

```typescript
"lock" // Too generic, serializes everything
`user:${userId}`; // Too broad, blocks all user operations
Math.random().toString(); // Random keys defeat the purpose
```

**Key constraints**:

- Maximum 512 bytes after UTF-8 encoding
- Automatically normalized to NFC form
- Hashed when prefixed keys exceed backend limits (transparent to you)

::: tip Namespacing
Backend prefixes prevent cross-app collisions:

- Redis: `"syncguard:payment:123"`
- PostgreSQL: row in `"syncguard_locks"` table
- Firestore: document ID in `"locks"` collection
  :::

## Ownership & Lock IDs

Every lock gets a unique `lockId` (22-character base64url string, 128 bits of entropy). Only the owner can release or extend the lock.

```typescript
const result = await backend.acquire({ key: "resource:123", ttlMs: 30000 });
if (result.ok) {
  const { lockId } = result;
  // Only this lockId can release/extend this specific lock
  await backend.extend({ lockId, ttlMs: 30000 });
  await backend.release({ lockId });
}
```

**Why lock IDs matter**:

- **Idempotency** — Same `lockId` can't accidentally release someone else's lock
- **Concurrent safety** — Two processes acquiring locks on the same key get different lock IDs
- **Explicit ownership** — Operations require proof of ownership via `lockId`

**Checking ownership** — Use the helper functions for better discoverability:

```typescript
import { owns, getById } from "syncguard";

// Quick boolean check - simple and clear
if (await owns(backend, lockId)) {
  console.log("Still own the lock");
}

// Detailed info - includes expiration and fence tokens
const info = await getById(backend, lockId);
if (info) {
  console.log(`Expires in ${info.expiresAtMs - Date.now()}ms`);
  console.log(`Fence token: ${info.fence}`);
}
```

## TTL & Expiration

Locks expire automatically after `ttlMs` milliseconds. This prevents orphaned locks when processes crash.

**Choosing TTL**:

```typescript
// Short critical sections (default: 30s)
await lock(
  async () => {
    // Your work
  },
  { key: "quick-task", ttlMs: 30000 },
);

// Long-running batch jobs
await lock(
  async () => {
    // Your work
  },
  { key: "daily-report", ttlMs: 300000 },
); // 5 minutes
```

**Guidelines**:

- **Too short** ⚠️ — Lock expires mid-work → potential race conditions
- **Too long** ⚠️ — Crashed processes block others for longer
- **Sweet spot** ✅ — 2-3x your expected work duration

**Extending locks** (for work that takes longer than expected):

```typescript
// With automatic cleanup (Node.js ≥20)
{
  await using lock = await backend.acquire({
    key: "batch:report",
    ttlMs: 60000,
  });

  if (lock.ok) {
    // TypeScript narrows lock to include handle methods after ok check
    await processFirstBatch();

    // Extend lock before it expires
    await lock.extend(60000); // Reset to 60s from now
    await processSecondBatch();

    // Lock automatically released
  }
}
```

::: warning TTL Replacement Behavior
`extend()` replaces the TTL entirely—it doesn't add to the remaining time. Extending with `ttlMs: 60000` resets expiration to 60 seconds from _now_, not from the original acquisition.
:::

**Heartbeat pattern** (for very long-running work):

```typescript
{
  await using lock = await backend.acquire({ key: "long-task", ttlMs: 60000 });
  if (!lock.ok) throw new Error("Failed to acquire lock");

  // TypeScript narrows lock to include handle methods after ok check

  // Extend every 30s (half the TTL)
  const heartbeat = setInterval(async () => {
    const extended = await lock.extend(60000);
    if (!extended.ok) {
      clearInterval(heartbeat);
      throw new Error("Lost lock ownership");
    }
  }, 30000);

  try {
    await doLongRunningWork();
  } finally {
    clearInterval(heartbeat);
    // Lock automatically released
  }
}
```

## Retry Strategy

When locks are contended, the `lock()` helper retries automatically using exponential backoff with jitter.

**Default retry behavior**:

```typescript
await lock(
  async () => {
    // Your work function
  },
  {
    key: "resource:123",
    acquisition: {
      maxRetries: 10, // Try up to 10 times (default)
      retryDelayMs: 100, // Start with 100ms delay (default)
      timeoutMs: 5000, // Give up after 5s total (default)
    },
  },
);
```

**How it works**:

1. First attempt fails → wait 100ms
2. Second attempt fails → wait ~200ms (± jitter)
3. Third attempt fails → wait ~400ms (± jitter)
4. Continue doubling until success or timeout

::: info Jitter Prevents Thundering Herd
**Jitter** (50% randomization) prevents all processes from retrying simultaneously:

- Without jitter: 10 processes retry at exactly 100ms, 200ms, 400ms...
- With jitter: processes spread out between 50-150ms, 100-300ms, 200-600ms...
  :::

**Custom retry strategies**:

```typescript
// More patient (higher contention tolerance)
await lock(
  async () => {
    // Your work
  },
  {
    key: "hot-resource",
    acquisition: {
      maxRetries: 20,
      timeoutMs: 10000,
    },
  },
);

// Less patient (fail fast)
await lock(
  async () => {
    // Your work
  },
  {
    key: "quick-check",
    acquisition: {
      maxRetries: 3,
      timeoutMs: 1000,
    },
  },
);

// No retries (single attempt)
const result = await backend.acquire({ key: "resource:123", ttlMs: 30000 });
if (!result.ok) {
  // Handle contention immediately
}
```

**When acquisition fails**:

```typescript
try {
  await lock(
    async () => {
      // Your work
    },
    { key: "resource:123" },
  );
} catch (error) {
  if (error instanceof LockError && error.code === "AcquisitionTimeout") {
    // Exceeded timeoutMs after all retries
    console.log("Resource too contended, try again later");
  }
}
```

## Ownership Checking

::: warning Diagnostic Use Only
Ownership checks are for **diagnostics, UI, and monitoring** — NOT correctness guards. Never use `check → mutate` patterns. Correctness relies on atomic ownership verification built into `release()` and `extend()` operations.
:::

**Recommended approach** — Use the helper functions for clarity and discoverability:

**Check if a resource is locked**:

```typescript
import { getByKey } from "syncguard";

const info = await getByKey(backend, "resource:123");
if (info) {
  console.log(`Locked until ${new Date(info.expiresAtMs)}`);
  console.log(`Fence token: ${info.fence}`);
} else {
  console.log("Resource is available");
}
```

**Check if you still own a lock**:

```typescript
import { owns, getById } from "syncguard";

// Simple boolean check
const stillOwned = await owns(backend, lockId);
if (!stillOwned) {
  throw new Error("Lost lock ownership");
}

// Or get detailed information
const info = await getById(backend, lockId);
if (info) {
  console.log(
    `Still own the lock, expires in ${info.expiresAtMs - Date.now()}ms`,
  );
}
```

::: tip Helper Functions vs Direct Method
The helpers (`getByKey`, `getById`, `owns`) provide better discoverability and clearer intent than calling `backend.lookup()` directly. They're the **recommended approach** for lock diagnostics. For advanced cases, you can still use `backend.lookup({ key })` or `backend.lookup({ lockId })` directly.
:::

::: info Security Note
Helpers return sanitized data with hashed keys/lockIds by default. For debugging with raw values, use `getByKeyRaw()` or `getByIdRaw()` helpers.
:::

**When to use ownership checking**:

- ✅ **Diagnostics**: "Why is this resource locked?"
- ✅ **Monitoring**: Track lock expiration times
- ✅ **Conditional logic**: "Should I wait or skip?"
- ✅ **UI display**: Show lock status to users

**When NOT to use ownership checking**:

- ❌ Pre-checking before `extend()` or `release()` (operations are idempotent)
- ❌ Gating mutations (use fencing tokens instead, see [Fencing Tokens](/fencing))
- ❌ Polling for lock availability (use retry logic in `lock()` instead)
