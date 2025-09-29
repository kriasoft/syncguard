# Firestore Backend Requirements

## Document Storage Strategy

### Lock Documents

- **Document ID**: Generated using `makeStorageKey()` helper from common utilities with 1500-byte limit
- **Collection**: Default `"locks"`, configurable via `collection` option
- **Document Schema**:

  ```typescript
  interface LockDocument {
    lockId: string; // For ownership verification
    expiresAtMs: number; // Expiration timestamp (ms)
    acquiredAtMs: number; // Acquisition timestamp (ms)
    key: string; // Lock key
    fence: string; // Current fence value (copy from counter for convenience)
  }
  ```

### Fence Counter Documents (Lifecycle-Independent)

- **Document ID**: Generated using `makeStorageKey()` helper from common utilities (same key naming as lock documents)
- **Collection**: Default `"fence_counters"`, configurable via `fenceCollection` option
- **Document Schema**:

  ```typescript
  interface FenceCounterDocument {
    fence: string; // Monotonic counter (19-digit zero-padded string for lexicographic ordering)
    keyDebug?: string; // Original key for debugging (optional)
  }
  ```

**Critical Requirement**: Fence counters MUST be independent of lock lifecycle. Cleanup operations delete only lock documents; counter documents are never deleted.

## Client Time Authority

```typescript
interface FirestoreBackendConfig {
  collection?: string; // Lock documents collection, default: "locks"
  fenceCollection?: string; // Fence counter documents collection, default: "fence_counters"
  cleanupInIsLocked?: boolean; // Enable cleanup in isLocked operation, default: false
  // ... other config options
}

// Consistent behavior with unified tolerance
const firestoreBackend = createFirestoreBackend(); // 1000ms tolerance
```

**Time Authority Model**: Firestore uses client time with unified 1000ms tolerance. Requires NTP synchronization in production. If reliable time sync cannot be guaranteed, use Redis backend instead.

## Backend Capabilities and Type Safety

Firestore backends MUST declare their specific capabilities for enhanced type safety:

```typescript
interface FirestoreCapabilities extends BackendCapabilities {
  backend: "firestore"; // Backend type discriminant
  supportsFencing: true; // Firestore always provides fencing tokens
  timeAuthority: "client"; // Uses client time with unified tolerance
}

// Example backend creation with specific capability types
const firestoreBackend: LockBackend<FirestoreCapabilities> =
  createFirestoreBackend(config);
```

### Ergonomic Usage with Firestore

Firestore always provides fencing tokens with compile-time type guarantees:

```typescript
// Direct access - TypeScript knows fence exists at compile time
const backend = createFirestoreBackend(config);
const result = await backend.acquire({ key: "resource", ttlMs: 30000 });

if (result.ok) {
  // No assertions or type guards needed!
  console.log("Fence:", result.fence);

  // Direct comparison works
  if (result.fence > lastKnownFence) {
    await updateResource(data, result.fence);
  }
}
```

## Fencing Token Implementation Pattern

Firestore backends MUST always generate restart-survivable monotonic fencing tokens using the following pattern with separate counter documents:

```typescript
// In acquire transaction: read-then-write pattern following Firestore transaction rules
await db.runTransaction(async (trx) => {
  const lockDoc = collection.doc(key);
  const fenceCounterDoc = fenceCounterCollection.doc(key); // Same key, different collection

  // READ PHASE: All reads must come first (Firestore requirement)
  const currentLockDoc = await trx.get(lockDoc);
  const currentCounterDoc = await trx.get(fenceCounterDoc);

  // Check for existing lock (contention logic)...

  // Calculate next fence value from persistent counter using BigInt for precision safety
  const currentFenceStr =
    currentCounterDoc.data()?.fence || "0000000000000000000";
  const currentFence = BigInt(currentFenceStr);
  const nextFence = currentFence + 1n;

  // Format using common formatter pattern (backend MUST use formatFence() from common utilities)
  const nextFenceStr = nextFence.toString().padStart(19, "0");

  // WRITE PHASE: Update both counter and lock documents atomically
  await trx.set(fenceCounterDoc, {
    fence: nextFenceStr,
    keyDebug: key, // For debugging (optional)
  });

  await trx.set(lockDoc, {
    lockId,
    expiresAtMs,
    acquiredAtMs,
    key,
    fence: nextFenceStr, // Copy of counter for convenience
  });

  return { ok: true, lockId, expiresAtMs, fence: nextFenceStr };
});
```

**Required Implementation Details:**

- **Dual Document Pattern**: Fence counters stored in separate collection from lock documents
- **Lifecycle Independence**: Counter documents persist indefinitely; cleanup operations MUST NOT delete counter documents
- **Atomicity**: Fence increment and lock creation MUST occur within the same `runTransaction()`
- **Transaction Pattern**: All reads MUST occur before writes. Read both lock and counter documents, then write both
- **Document Naming**: Counter documents MUST use identical key generation as lock documents (via common `makeStorageKey()` helper)
- **Precision Safety**: Use BigInt arithmetic to prevent JavaScript precision loss beyond 2^53-1
- **Persistence**: Counter values survive Firestore restarts and lock cleanup operations
- **Monotonicity**: Each successful `acquire()` increments the counter, ensuring strict ordering per key
- **Initialization**: Start counter at "0000000000000000001" for new keys
- **Storage Format**: Store counters as `string` in counter documents and copy to lock documents
- **Format**: Return 19-digit zero-padded decimal strings for lexicographic ordering
- **Overflow Monitoring**: Log warnings when fence > 9e18 to provide early operational signals
- **Collection Configuration**: Both lock and fence counter collections MUST be configurable

## Critical Requirements

### ⚠️ **Explicit Ownership Verification (ADR-003)**

**CRITICAL SECURITY REQUIREMENT**: All release/extend operations MUST include explicit ownership verification after index lookup:

```typescript
if (data?.lockId !== lockId) {
  return { ok: false, reason: "not-found" };
}
```

**Why This Is Critical**:

- **Defense-in-depth**: Additional safety layer with negligible performance cost
- **Cross-backend consistency**: Ensures Firestore matches Redis's explicit ownership checking
- **TOCTOU protection**: Guards against any edge cases in the atomic resolve→validate→mutate flow
- **Code clarity**: Makes ownership verification explicit in the transaction logic

See complete implementation examples in Release and Extend operation sections below.

### Required Index

MUST ensure the single-field index on `lockId` is available for release/extend/lookup performance. Firestore typically auto-manages single-field indexes for equality queries; if index management is customized, create the index explicitly. This is a MUST requirement for all Firestore backends.

### Time Authority & Liveness Predicate

**MUST use [unified liveness predicate](interface.md#time-authority)** from `common/time-predicates.ts`:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";
const nowMs = Date.now();
const live = isLive(storedExpiresAtMs, nowMs, TIME_TOLERANCE_MS);
```

**Unified Tolerance**: Firestore uses 1000ms tolerance for consistent cross-backend behavior and safe client time authority.

**Requirements**: NTP synchronization recommended for production. If reliable time sync cannot be guaranteed within ±500ms, use Redis backend instead.

See [Time Implementation Requirements](interface.md#time-implementation-requirements) for complete enforcement details.

### Acquire Operation

- Use `db.runTransaction()` for atomicity
- Direct document access: `collection.doc(key).get()`
- **Time Authority**: MUST use `isLive()` from `common/time-predicates.ts` with client time source and configured tolerance
- Overwrite expired locks atomically with `trx.set()` after expiry check
- **Contention**: Return `{ ok: false, reason: "locked" }` when lock is held
- **System Errors**: Throw `LockError` with appropriate error code
- **Fencing Tokens**: Always include monotonic fence token in successful results (TypeScript knows fence exists at compile time)
- **Storage Key Generation**: User keys are capped at 512 bytes per common validation. Firestore document IDs are limited to 1500 bytes. When `prefix:userKey` exceeds 1500 bytes, backend MUST apply the standardized hash-truncation scheme defined in interface.md using the common `makeStorageKey()` helper.

### Release Operation

**MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via Firestore transactions:

```typescript
import { isLive } from "../common/time-predicates.js";

// REQUIRED: Explicit ownership verification pattern
await db.runTransaction(async (trx) => {
  // Query by lockId index
  const querySnapshot = await trx.get(
    collection.where("lockId", "==", lockId).limit(1),
  );

  const doc = querySnapshot.docs[0];
  const data = doc?.data();
  const nowMs = Date.now();

  // Check conditions for telemetry purposes
  const documentExists = !querySnapshot.empty;
  const ownershipValid = data?.lockId === lockId;
  const isLockLive = data
    ? isLive(data.expiresAtMs, nowMs, toleranceMs)
    : false;

  // Simplified public API result
  if (!documentExists || !ownershipValid || !isLockLive) {
    // Track internal detail (best-effort, for decorator consumption if telemetry enabled)
    const detail = !documentExists || !ownershipValid ? "not-found" : "expired";
    return { ok: false };
  }

  // Atomically delete the document
  await trx.delete(doc.ref);
  return { ok: true };
});
```

- **System Errors**: Throw `LockError` for transaction failures

### Extend Operation

**MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via Firestore transactions:

```typescript
import { isLive } from "../common/time-predicates.js";

// REQUIRED: Explicit ownership verification pattern
await db.runTransaction(async (trx) => {
  // Query by lockId index
  const querySnapshot = await trx.get(
    collection.where("lockId", "==", lockId).limit(1),
  );

  const doc = querySnapshot.docs[0];
  const data = doc?.data();
  const nowMs = Date.now();

  // Check conditions for telemetry purposes
  const documentExists = !querySnapshot.empty;
  const ownershipValid = data?.lockId === lockId;
  const isLockLive = data
    ? isLive(data.expiresAtMs, nowMs, toleranceMs)
    : false;

  // Simplified public API result
  if (!documentExists || !ownershipValid || !isLockLive) {
    // Track internal detail (best-effort, for decorator consumption if telemetry enabled)
    const detail = !documentExists || !ownershipValid ? "not-found" : "expired";
    return { ok: false };
  }

  // Atomically update TTL
  const newExpiresAtMs = nowMs + ttlMs;
  await trx.update(doc.ref, { expiresAtMs: newExpiresAtMs });
  return { ok: true, expiresAtMs: newExpiresAtMs };
});
```

- **System Errors**: Throw `LockError` for transaction failures

### IsLocked Operation

- **Use Case**: Simple boolean checks (prefer `lookup()` for diagnostics)
- Direct document access by key: `collection.doc(key).get()`
- **Read-Only by Default**: Follows common spec expectation - cleanup is disabled by default to maintain pure read semantics
- **Optional Cleanup**: When `cleanupInIsLocked: true` is configured, MAY perform fire-and-forget cleanup of expired locks following common spec guidelines (non-blocking, rate-limited, never affects live locks or return values)

### Lookup Operation (Required)

**Runtime Validation**: MUST validate inputs before any I/O operations:

- **Key mode**: Call `normalizeAndValidateKey(key)` and fail fast on invalid keys
- **LockId mode**: Call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input

**Key Lookup Mode**:

- **Implementation**: Direct document access by key: `collection.doc(key).get()`
- **Complexity**: O(1) direct access
- **Atomicity**: Single document read (inherently atomic)
- **Performance**: Direct document access, consistently fast

**LockId Lookup Mode**:

- **Implementation**: Query by lockId index: `collection.where('lockId', '==', lockId).limit(1).get()`
- **Complexity**: Index traversal + verification
- **Atomicity**: Single indexed query; no additional atomicity required (unlike Redis multi-key pattern)
- **Performance**: Indexed equality query, requires lockId field index

**Common Requirements**:

- **Ownership Verification**: For lockId lookup, MUST verify `data.lockId === lockId` after document retrieval for defense-in-depth; return `null` if verification fails
- **TOCTOU Safety**: Firestore lookups are inherently safe - single document/query operations with post-read verification eliminate race conditions
- **Expiry Check**: MUST use `isLive()` from `common/time-predicates.ts` with `Date.now()` and internal tolerance constant to determine if lock is live
- **Data Transformation Requirement**: While Firestore operations retrieve the raw document data, the backend's TypeScript lookup method MUST compute the required keyHash and lockIdHash using `hashKey()`, and return a sanitized `LockInfo<C>` object to the caller, strictly adhering to the common interface specification.
- **Return Value**: Return `null` if document doesn't exist or is expired; return `LockInfo<C>` for live locks (MUST include `fence` since Firestore backend supports fencing)
- **Null Semantics**: Do not attempt to infer distinction between expired vs not-found in lookup results

## Error Handling

**MUST follow [common spec ErrorMappingStandard](interface.md#centralized-error-mapping)**. Key Firestore mappings:

- **ServiceUnavailable**: `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`, `ABORTED` (transaction conflicts)
- **AuthFailed**: `PERMISSION_DENIED`, `UNAUTHENTICATED`
- **InvalidArgument**: `INVALID_ARGUMENT`, `FAILED_PRECONDITION`
- **RateLimited**: `RESOURCE_EXHAUSTED`

**Implementation Pattern**: Simplified public API with internal detail tracking:

```typescript
import { isLive } from "../common/time-predicates.js";

// Determine conditions for API result and internal tracking
const documentExists = !querySnapshot.empty;
const ownershipValid = data?.lockId === lockId;
const isLockLive = data ? isLive(data.expiresAtMs, nowMs, toleranceMs) : false;

// Public API: simplified boolean result
const success = documentExists && ownershipValid && isLockLive;

// Internal detail tracking (best-effort, for decorator consumption if telemetry enabled)
if (!success) {
  const detail = !documentExists || !ownershipValid ? "not-found" : "expired";
}

return { ok: success };
```

**Key Observations**:

- `!querySnapshot.empty` → document exists check
- `data?.lockId === lockId` → ownership verification (ADR-003)
- `isLive(...)` → expiry check using unified liveness predicate
- **Internal tracking**: "not-found" for missing/ownership issues, "expired" for time-based failures (when cheaply available)

## Implementation Architecture

### Performance Characteristics

- **Direct document access**: Fast document lookups for acquire and isLocked operations
- **Indexed equality queries**: Fast indexed lookups for release and extend operations (requires lockId index)
- **Transaction overhead**: ~2-5ms per operation depending on Firestore latency
- **Lookup performance**: Document access and indexed equality queries provide fast, predictable performance
- **Expected throughput**: 100-500 ops/sec depending on region and network
- **Single-attempt operations**: Firestore backends perform single attempts only; retry logic is handled by the lock() helper

### Backend Configuration

- **Unified tolerance**: 1000ms tolerance for consistent cross-backend behavior
- **Lock collection**: Configurable via `collection` option (default: "locks")
- **Fence counter collection**: Configurable via `fenceCollection` option (default: "fence_counters")
- **Index requirement**: Single-field ascending index on `lockId` field (required for release/extend/lookup by lockId). MUST be created before production use.
- **Retry configuration**: Exponential backoff for transient errors
- **Cleanup Configuration**: Optional `cleanupInIsLocked: boolean` (default: `false`) - when enabled, allows fire-and-forget cleanup in isLocked operation following common spec guidelines. **CRITICAL**: Cleanup MUST ONLY delete lock documents, never fence counter documents.
- **lookup Implementation**: Required - supports both key and lockId lookup patterns for ownership checking and operational diagnostics

### Testing Strategy

- **Unit tests**: Mock Firestore with in-memory transactions, no external dependencies
- **Integration tests**: Real Firestore instance, validates transaction behavior and indexing
- **Performance tests**: Measures transaction latency and throughput under load
- **Index validation**: Ensures required lockId index exists and performs correctly
- **Behavioral compliance testing**: Unit tests MUST verify backend imports and uses `isLive()` from `common/time-predicates.ts`, not custom implementations
- **Cross-backend consistency**: Integration tests MUST verify identical outcomes given same tolerance values between Firestore and other backends
