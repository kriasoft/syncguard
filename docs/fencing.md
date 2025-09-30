# Fencing Tokens

Monotonic counters that protect against stale lock holders corrupting data.

::: tip Technical Deep Dive
For the complete fence token specification including format contracts, overflow handling, and cross-backend consistency requirements, see [specs/interface.md § Fence Token Types](https://github.com/kriasoft/syncguard/blob/main/specs/interface.md#fence-token-types).
:::

## What are Fencing Tokens?

Every successful lock acquisition returns a **fence token**—a strictly increasing number that identifies the lock generation:

```typescript
const result = await backend.acquire({ key: "document:123", ttlMs: 30000 });

if (result.ok) {
  const { lockId, fence } = result;
  console.log(fence); // "0000000000000000001"
}
```

Fence tokens are 19-digit zero-padded strings that compare lexicographically (ADR-004-R2):

```typescript
const first = "0000000000000000001";
const second = "0000000000000000002";

console.log(second > first); // true (string comparison works!)
console.log(first === second); // false
```

**Key properties**:

- **Monotonic**: Each acquisition increments the counter (`fence2 > fence1`)
- **Persistent**: Counters survive backend restarts
- **Per-key**: Each lock key has its own independent counter
- **Lexicographic**: Direct string comparison (`>`, `<`, `===`) reflects chronological order
- **No helpers needed**: Fixed 19-digit format enables direct comparison without utility functions

## The Stale Lock Problem

Distributed locks can expire while work is still in progress. Without fencing tokens, a stale lock holder can corrupt data:

```typescript
// ❌ Without fencing: stale writes can corrupt data
await lock(
  async () => {
    const data = await fetchData(); // Process 1 acquires lock
    await slowNetworkCall(); // Takes 40s (lock TTL was 30s!)
    await writeData(data); // Process 1 lost lock; Process 2 already wrote!
  },
  { key: "document:123", ttlMs: 30000 },
);
```

**Timeline without fencing**:

1. **0s**: Process 1 acquires lock, starts work
2. **30s**: Lock expires (TTL reached)
3. **31s**: Process 2 acquires lock, completes quickly
4. **40s**: Process 1 (stale) overwrites Process 2's correct data

**Timeline with fencing**:

1. **0s**: Process 1 acquires lock with `fence: "001"`
2. **30s**: Lock expires
3. **31s**: Process 2 acquires lock with `fence: "002"`
4. **40s**: Process 1 attempts write with `fence: "001"` → **rejected** (stale)

Fencing tokens let your backend reject stale operations, even if the lock holder doesn't realize it lost the lock.

## Using Fencing Tokens

### Basic Pattern: Check-and-Write

Store the latest fence token with your data. Reject writes from older fences:

```typescript
const result = await backend.acquire({ key: "document:123", ttlMs: 30000 });

if (result.ok) {
  try {
    const { fence } = result;

    // Fetch current document
    const doc = await getDocument("123");

    // Check if our fence is newer (we haven't lost the lock)
    if (doc.fence && fence <= doc.fence) {
      throw new Error(`Stale lock: our fence ${fence} <= current ${doc.fence}`);
    }

    // Safe: we hold the newest lock
    await updateDocument("123", {
      data: processData(),
      fence, // Store fence with the data
    });
  } finally {
    await backend.release({ lockId: result.lockId });
  }
}
```

### Database-Enforced Fencing

For Firestore, use transactions to atomically verify the fence:

```typescript
const result = await backend.acquire({ key: "document:123", ttlMs: 30000 });

if (result.ok) {
  const { fence } = result;

  await db.runTransaction(async (trx) => {
    const docRef = db.collection("documents").doc("123");
    const doc = await trx.get(docRef);
    const currentFence = doc.data()?.fence || "0000000000000000000";

    // Reject stale writes atomically
    if (fence <= currentFence) {
      throw new Error("Stale fence token");
    }

    // Safe: atomic check-and-write
    await trx.update(docRef, {
      data: newData,
      fence,
      updatedAt: Date.now(),
    });
  });
}
```

### External API Protection

Pass fence tokens to external services that support conditional writes:

```typescript
const result = await backend.acquire({ key: "job:456", ttlMs: 60000 });

if (result.ok) {
  const { fence } = result;

  // External API with conditional update
  await apiClient.updateResource({
    resourceId: "456",
    data: newData,
    ifMatch: fence, // Only update if server fence matches
  });
}
```

## TypeScript Guarantees

Both Redis and Firestore backends provide fencing tokens at compile time—no runtime assertions needed:

```typescript
import { createRedisBackend } from "syncguard/redis";

const backend = createRedisBackend(redis);
const result = await backend.acquire({ key: "resource:123", ttlMs: 30000 });

if (result.ok) {
  // TypeScript knows fence exists!
  const fence = result.fence; // Type: string (no undefined)

  // Direct comparison works
  if (fence > lastKnownFence) {
    await updateWithFence(data, fence);
  }
}
```

**No boilerplate required**:

- ✅ `result.fence` is required (TypeScript enforces this)
- ❌ No need for `hasFence()` or optional chaining (`result.fence?`)
- ❌ No runtime assertions or type guards needed

### Generic Code with Unknown Backends

If you're writing generic functions that accept any backend type, use the `hasFence()` helper:

```typescript
import { hasFence } from "syncguard";
import type { LockBackend, BackendCapabilities } from "syncguard";

function processWithAnyBackend<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  result: AcquireResult<C>,
) {
  if (hasFence(result)) {
    // Type guard for generic contexts
    console.log("Fence token:", result.fence);
  }
}
```

Most application code uses typed backends directly and doesn't need `hasFence()`.

## Common Patterns

### Monotonic Version Counter

Use fences as version numbers for optimistic concurrency:

```typescript
const result = await backend.acquire({ key: "counter", ttlMs: 30000 });

if (result.ok) {
  const { fence } = result;

  // Fetch current value
  const current = await redis.get("counter:value");
  const currentFence = await redis.get("counter:fence");

  // Increment only if we hold the newest lock
  if (!currentFence || fence > currentFence) {
    await redis.set("counter:value", parseInt(current || "0") + 1);
    await redis.set("counter:fence", fence);
  }
}
```

### Heartbeat with Fence Validation

For long-running tasks, validate fence tokens before each operation:

```typescript
const result = await backend.acquire({ key: "batch-job", ttlMs: 60000 });

if (!result.ok) throw new Error("Failed to acquire lock");

let currentFence = result.fence;

// Extend every 30s
const heartbeat = setInterval(async () => {
  const extended = await backend.extend({
    lockId: result.lockId,
    ttlMs: 60000,
  });

  if (!extended.ok) {
    clearInterval(heartbeat);
    throw new Error("Lost lock ownership");
  }

  // Note: extend doesn't return a new fence (same lock instance)
}, 30000);

try {
  for (const batch of largeBatches) {
    // Check if our fence is still valid before each batch
    const info = await backend.lookup({ key: "batch-job" });
    if (!info || info.fence !== currentFence) {
      throw new Error("Lock fence changed (lost ownership)");
    }

    await processBatch(batch, currentFence);
  }
} finally {
  clearInterval(heartbeat);
  await backend.release({ lockId: result.lockId });
}
```

### Comparing Fences from Different Sources

Fences are lexicographically ordered strings—direct comparison works:

```typescript
const fenceA = "0000000000000000100";
const fenceB = "0000000000000000200";

// String comparison reflects chronological order
console.log(fenceB > fenceA); // true
console.log(fenceA === fenceB); // false

// Sort fences chronologically
const fences = [
  "0000000000000000003",
  "0000000000000000001",
  "0000000000000000002",
];
const sorted = fences.sort(); // ["001", "002", "003"]
```

::: tip Why Zero-Padded Strings? (ADR-004-R2)
19-digit zero-padding ensures lexicographic order matches numeric order. Without padding, `"2" > "10"` (lexicographic), but we need `"0000000000000000002" < "0000000000000000010"` (correct). The fixed-width format eliminates the need for comparison helper functions—direct string comparison just works.
:::

## When to Use Fencing

### ✅ Use Fencing When

- **Stale writes risk data corruption**: Payment processing, inventory updates
- **External systems need protection**: APIs that support conditional writes
- **Lock TTL might expire mid-work**: Long-running batch jobs
- **Multiple writers compete**: Document editing, configuration updates

### ❌ Skip Fencing When

- **Single writer per key**: Only one process ever writes to the resource
- **Short critical sections**: Lock expires well after work completes (no stale risk)
- **Idempotent operations**: Writing the same data twice is safe
- **Eventually consistent data**: Last-write-wins semantics are acceptable

**Example: Fencing not needed**

```typescript
// Idempotent: writing status="completed" multiple times is safe
await lock(
  async () => {
    await updateJobStatus(jobId, "completed");
  },
  { key: `job:${jobId}` },
);
```

**Example: Fencing required**

```typescript
// Not idempotent: balance changes must be fenced
const result = await backend.acquire({ key: `account:${id}`, ttlMs: 30000 });

if (result.ok) {
  const { fence } = result;
  const account = await getAccount(id);

  // Reject if our fence is stale
  if (fence <= account.fence) {
    throw new Error("Stale lock");
  }

  await updateAccount(id, {
    balance: account.balance - amount,
    fence,
  });
}
```

## Fence Token Format

SyncGuard uses **19-digit zero-padded decimal strings** across all backends:

```typescript
"0000000000000000001"; // First lock
"0000000000000000002"; // Second lock
"0000000000000009999"; // 9,999th lock
```

**Why 19 digits?**

- Accommodates Redis's signed 64-bit INCR limit (`2^63-1 ≈ 9.2e18`)
- Consistent format across Redis and Firestore
- Lexicographic comparison works correctly
- JSON-safe (no precision loss from BigInt serialization)

**Practical limits**:

- **9e18 fence tokens** per key before overflow
- At **1 million locks/day**, takes **24 billion years** to overflow
- Backends log warnings when approaching theoretical limits

::: info Counter Lifecycle
Fence counters are **persistent** and survive backend restarts. They accumulate over the lifetime of the backend instance. For most applications (bounded key spaces), memory impact is negligible (~50-100 bytes per unique key).
:::

## Troubleshooting

**Q: How do I reset a fence counter?**

You can't reset counters safely in production—monotonicity is the security guarantee. If you need to reset for testing:

- **Redis**: `DEL syncguard:fence:resource:123`
- **Firestore**: Delete the document in the `fence_counters` collection

Never reset production counters.

**Q: What happens if two backends use the same key?**

Each backend maintains independent counters. Don't mix backends for the same key—fence tokens won't be comparable.

**Q: Do I need to clean up old fences?**

No. Counters are per-key and accumulate slowly. Deleting fence counters breaks monotonicity and can cause data corruption.
