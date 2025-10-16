# Firestore Backend Specification

This document defines Firestore-specific implementation requirements that extend the [common interface specification](./interface.md).

---

> 🚫 **CRITICAL: Never Delete Fence Counters**
>
> Fence counter documents in the `fence_counters` collection MUST NEVER be deleted. Deleting fence counters breaks monotonicity guarantees and violates fencing safety. Cleanup operations MUST only target lock documents in the `locks` collection, never fence counter documents.

---

## Document Structure

This specification uses a **normative vs rationale** pattern:

- **Requirements** sections contain MUST/SHOULD/MAY/NEVER statements defining the contract
- **Rationale & Notes** sections provide background, design decisions, and operational guidance

---

## Document Storage Strategy

### Lock Documents Requirements

- **Document ID**: MUST use `makeStorageKey()` from common utilities (see [Storage Key Generation](interface.md#storage-key-generation))
- **Backend-specific limit**: 1500 bytes (Firestore document ID limit)
- **Reserve Bytes Requirement**: Firestore operations MUST use 0 reserve bytes when calling `makeStorageKey()`
  - Formula: `0 bytes` (no derived keys requiring suffixes)
  - Purpose: Firestore uses independent document IDs for all key types
- **Collection**: Default `"locks"`, configurable via `collection` option
- **Document Schema**:

  ```typescript
  interface LockDocument {
    lockId: string; // For ownership verification
    expiresAtMs: number; // Expiration timestamp (ms)
    acquiredAtMs: number; // Acquisition timestamp (ms)
    key: string; // Lock key
    fence: string; // Current fence value (15-digit zero-padded string)
  }
  ```

### Lock Documents Rationale & Notes

**Why independent document IDs**: Unlike Redis, Firestore doesn't need suffix space for derived keys. Each key type gets its own document with independent ID.

**Why 0 reserve bytes**: Firestore document IDs are completely independent. Lock documents, fence counter documents, and any other metadata use separate IDs without string concatenation.

---

### Fence Counter Documents Requirements

- **Document ID**: Generated using [Two-Step Fence Key Derivation Pattern](interface.md#fence-key-derivation) for consistent hash mapping (ADR-006)
- **Collection**: Default `"fence_counters"`, configurable via `fenceCollection` option
- **Document Schema**:

  ```typescript
  interface FenceCounterDocument {
    fence: string; // Monotonic counter (15-digit zero-padded string)
    keyDebug?: string; // Original key for debugging (optional)
  }
  ```

**Critical Requirements**:

- **Lifecycle Independence**: Fence counters MUST be independent of lock lifecycle. Cleanup operations delete only lock documents; counter documents are NEVER deleted
- **⚠️ CRITICAL: Fence counters are intentionally persistent** and MUST NOT be deleted:

  ```typescript
  // ❌ NEVER do this - breaks monotonicity guarantee
  await fenceCounterDoc.delete(); // Violates fencing safety
  await fenceCounterDoc.update({
    /* add TTL */
  }); // Violates fencing safety
  ```

- **Fence Document ID Generation**: MUST follow two-step pattern:

  ```typescript
  const baseKey = makeStorageKey("", normalizedKey, 1500, 0);
  const fenceDocId = makeStorageKey("", `fence:${baseKey}`, 1500, 0);
  ```

  - Reserve: 0 bytes (Firestore document IDs are independent)

### Fence Counter Documents Rationale & Notes

**Why lifecycle independence**: Monotonicity guarantee requires persistent counters. Deleting fence counter would allow reuse, violating safety guarantees.

**Why separate collection**: Isolation prevents accidental deletion during cleanup. Configuration validation ensures collections remain distinct.

**Why two-step derivation**: Ensures 1:1 mapping between user keys and fence counters. When truncation occurs, both lock and fence keys hash identically. See interface.md for complete rationale.

**Critical for correctness**:

- **Monotonicity guarantee**: Deleting counters breaks strictly increasing fence token requirement
- **Cross-backend consistency**: Firestore must match Redis's fence counter persistence behavior
- **Fencing safety**: Counter reset would allow fence token reuse, violating safety guarantees

---

## Configuration and Validation

### Requirements

```typescript
interface FirestoreBackendConfig {
  collection?: string; // Lock documents collection, default: "locks"
  fenceCollection?: string; // Fence counter collection, default: "fence_counters"
  cleanupInIsLocked?: boolean; // Enable cleanup in isLocked, default: false
  // ... other config options
}
```

**CRITICAL: Configuration Validation Requirements**

Backend MUST validate configuration at initialization time and throw `LockError("InvalidArgument")` if:

1. **Collection Overlap**: `fenceCollection === collection` (prevents accidental fence counter deletion)
2. **Collection Naming**: Either collection name is empty or contains invalid Firestore path characters
3. **Cleanup Safety**: When `cleanupInIsLocked: true`, verify cleanup queries cannot accidentally target fence counter collection

**Implementation Pattern**:

```typescript
// At backend initialization
if (config.fenceCollection === config.collection) {
  throw new LockError(
    "InvalidArgument",
    "Fence counter collection must differ from lock collection",
  );
}

// Consistent behavior with unified tolerance
const firestoreBackend = createFirestoreBackend(); // Uses TIME_TOLERANCE_MS
```

### Rationale & Notes

**Why validate at initialization**: Fail-fast principle. Configuration errors should be caught before any operations occur.

**Why require distinct collections**: Prevents catastrophic bugs where cleanup accidentally deletes fence counters, breaking monotonicity.

**Why validate cleanup config**: When cleanup enabled, ensure implementation cannot accidentally target fence counter collection through misconfigured queries.

---

## Time Authority & Liveness Predicate

### Requirements

**MUST use [unified liveness predicate](interface.md#time-authority)** from `common/time-predicates.ts`:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";
const nowMs = Date.now();
const live = isLive(storedExpiresAtMs, nowMs, TIME_TOLERANCE_MS);
```

**Time Authority Model**: Firestore uses **client time** (`Date.now()`) with tolerance per `TIME_TOLERANCE_MS` in interface.md (ADR-005).

**Production Requirements**:

- **MUST**: Deploy NTP synchronization on ALL clients
- **MUST**: Implement NTP sync monitoring in deployment pipeline
- **MUST**: Add application-level health checks that detect and alert on clock skew
- **SHOULD**: Monitor client clock drift via system metrics or health checks
- **SHOULD**: Use Redis backend instead if reliable time sync cannot be guaranteed across all clients

**Clock Synchronization Policy**: See [Firestore Clock Synchronization Requirements](#firestore-clock-sync-requirements) below for the normative operational policy ladder and its relationship to TIME_TOLERANCE_MS

**Unified Tolerance**: See `TIME_TOLERANCE_MS` in interface.md for normative tolerance specification.

### Rationale & Notes

**Why client time**: Firestore has no native server time command like Redis. Each client uses local clock with NTP synchronization.

**Why MANDATORY NTP**: Client time authority only works safely with synchronized clocks. Without NTP, clock skew >1000ms causes safety violations.

**Multi-Client Clock Skew Handling**:

- **Race condition risk**: Client A may see lock as expired while Client B sees it as live
- **Mitigation 1**: Enforce NTP sync monitoring in deployment pipeline (see [Clock Synchronization Requirements](#firestore-clock-sync-requirements))
- **Mitigation 2**: Use Redis backend for environments where client time sync is unreliable
- **Mitigation 3**: Add application-level health checks that detect and alert on clock skew

**Operational Guidance**: See [Time Authority Tradeoffs](interface.md#time-authority-tradeoffs) for:

- When to choose Firestore vs Redis based on time authority requirements
- Pre-production checklists including MANDATORY NTP requirements
- Production monitoring guidance for client clock drift
- Failure scenarios and mitigation strategies for client time authority
- When to switch to Redis backend for centralized time authority

---

## Firestore Clock Synchronization Requirements {#firestore-clock-sync-requirements}

### Requirements

**Operational Policy Ladder** (graduated clock drift thresholds):

```
Target:  ≤ ±100 ms  → Optimal operational target for production systems
Warn:    ≥ ±200 ms  → Trigger alerts, investigate clock sync issues
Block:   ≥ ±500 ms  → Fail deployment, prevent unsafe operations
```

**Relationship to TIME_TOLERANCE_MS (1000 ms)**:

- `TIME_TOLERANCE_MS = 1000 ms` is the **library's internal safety margin** that accommodates clock skew up to the operational limits
- The operational policy ladder (100/200/500) defines **deployment and monitoring SLOs** within this safety margin
- The safety margin (1000 ms) is intentionally larger than the block threshold (500 ms) to provide operational buffer

**Operational Implementation**:

- **MUST**: Configure deployment pipeline to block deployments when client clock drift ≥ ±500 ms
- **MUST**: Configure monitoring to alert when client clock drift ≥ ±200 ms (early warning)
- **SHOULD**: Target ≤ ±100 ms clock accuracy for optimal behavior and safety margin

### Rationale & Notes

**Why graduated policy**: Provides clear operational stages (target/warn/block) for different severity levels, following industry best practices for alert escalation.

**Why 1000 ms safety margin**: Accommodates the operational policy ladder (up to 500 ms block threshold) while providing additional buffer for transient clock skew during NTP resync events.

**Why these specific thresholds**:

- **100 ms target**: Matches typical NTP sync accuracy, provides comfortable safety margin
- **200 ms warning**: Early signal to investigate before reaching block threshold
- **500 ms block**: Conservative deployment safety limit within TIME_TOLERANCE_MS buffer

---

## Backend Capabilities and Type Safety

### Requirements

Firestore backends MUST declare their specific capabilities for enhanced type safety:

```typescript
interface FirestoreCapabilities extends BackendCapabilities {
  backend: "firestore"; // Backend type discriminant
  supportsFencing: true; // Firestore always provides fencing tokens
  timeAuthority: "client"; // Uses client time with unified tolerance
}

const firestoreBackend: LockBackend<FirestoreCapabilities> =
  createFirestoreBackend(config);
```

### Rationale & Notes

**Ergonomic Usage**: Firestore always provides fencing tokens with compile-time guarantees:

```typescript
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

**Type discriminant benefits**: Enables pattern matching and type-safe backend switching in generic code.

---

## Fencing Token Implementation

**NORMATIVE IMPLEMENTATION**: See `firestore/operations/acquire.ts` for canonical transaction pattern with inline documentation.

### Required Characteristics

- **Dual Document Pattern**: Fence counters in separate collection (`fence_counters`) from lock documents (`locks`)
- **Fence Document ID Generation**: MUST use [Two-Step Fence Key Derivation Pattern](interface.md#fence-key-derivation)
- **Lifecycle Independence**: Counter documents persist indefinitely; cleanup operations MUST NOT delete counter documents
- **Atomicity**: Fence increment and lock creation MUST occur within same `runTransaction()`
- **Transaction Pattern**: All reads MUST occur before writes (Firestore requirement)
- **Precision Safety**: Use BigInt arithmetic to prevent JavaScript precision loss beyond 2^53-1
- **Persistence**: Counter values survive Firestore restarts and lock cleanup operations
- **Monotonicity**: Each successful `acquire()` increments counter, ensuring strict ordering per key
- **Initialization**: Start counter at "000000000000000" (15 digits)
- **Storage Format**: Store counters as `string` in counter documents and copy to lock documents
- **Format**: Return 15-digit zero-padded decimal strings for lexicographic ordering
- **Overflow Enforcement (ADR-004)**: Backend MUST validate fence value and throw `LockError("Internal")` if fence > `FENCE_THRESHOLDS.MAX`; MUST log warnings via `logFenceWarning()` when fence > `FENCE_THRESHOLDS.WARN`. Canonical threshold values defined in `common/constants.ts`.
- **Collection Configuration**: Both lock and fence counter collections MUST be configurable
- **Time Authority (ADR-010)**: MUST capture `Date.now()` inside transaction for authoritative client-time expiresAtMs

### Rationale & Notes

**Why BigInt**: JavaScript numbers lose precision beyond 2^53-1. BigInt handles 15-digit fence values without precision loss.

**Why read-then-write**: Firestore transactions require all reads before any writes. Violating this causes transaction failures.

**Why copy fence to lock document**: Convenience. Allows lock info retrieval without secondary counter document lookup.

**See implementation**: `firestore/operations/acquire.ts` contains complete transaction logic with defensive guards and error handling.

---

## Explicit Ownership Verification (ADR-003)

### Requirements

**CRITICAL SECURITY REQUIREMENT**: All release/extend operations MUST include explicit ownership verification after index lookup:

```typescript
if (data?.lockId !== lockId) {
  return { ok: false };
}
```

This verification is MANDATORY even when using atomic transactions.

### Rationale & Notes

**Why required despite atomicity**: Defense-in-depth. While atomic transactions prevent most race conditions, explicit verification guards against:

- **Defense-in-depth**: Additional safety layer with negligible performance cost
- **Cross-backend consistency**: Ensures Firestore matches Redis's explicit ownership checking
- **TOCTOU protection**: Guards against edge cases in atomic resolve→validate→mutate flow
- **Code clarity**: Makes ownership verification explicit in transaction logic

**See ADR-003** for complete rationale and cross-backend consistency requirements.

---

## Required Index

### Requirements

MUST ensure single-field index on `lockId` is available for release/extend/lookup performance.

- Firestore typically auto-manages single-field indexes for equality queries
- If index management is customized, create index explicitly
- This is a MUST requirement for all Firestore backends

### Rationale & Notes

**Why lockId index required**: Release/extend operations query by lockId. Without index, these operations would require full collection scans.

**Performance impact**: Indexed queries: ~5-10ms. Full collection scan: 100ms-1000ms+.

---

## Defensive Duplicate LockId Detection

### Requirements

**SHOULD Requirements for Operations Querying by LockId** (release, extend, lookup):

- Operations SHOULD omit `.limit(1)` from lockId queries to enable duplicate detection (ADR-014)
- Operations SHOULD detect and handle duplicate lockId documents defensively
- When duplicates detected: log warning, optionally cleanup expired duplicates, fail-safe on live duplicates

**Implementation guidance**: See JSDoc comments in `firestore/operations/*.ts` for detection patterns and cleanup strategies.

### Rationale & Notes

**Why SHOULD not MUST**: Defensive feature for operational resilience, not a correctness requirement.

**Why remove .limit(1)**: Firestore's `.limit(1)` caps results at 1 document, preventing duplicate detection.

**See ADR-014** for complete rationale and design decisions.

---

## Operation-Specific Behavior

### Acquire Operation Requirements

- **MUST return authoritative expiresAtMs**: Computed from client time authority (`Date.now()`) to ensure consistency and accurate heartbeat scheduling. No approximation allowed (see ADR-010).
- **MUST compute `expiresAtMs` inside the transaction using `Date.now()` captured there; NEVER pre-compute outside the transaction.**
- Use `db.runTransaction()` for atomicity
- Direct document access: `collection.doc(key).get()`
- **Time Authority**: MUST use `isLive()` from `common/time-predicates.ts` with client time source and `TIME_TOLERANCE_MS`
- Overwrite expired locks atomically with `trx.set()` after expiry check
- **Contention**: Return `{ ok: false, reason: "locked" }` when lock is held
- **System Errors**: Throw `LockError` with appropriate error code
- **Fencing Tokens**: Always include monotonic fence token in successful results
- **Storage Key Generation**: MUST call `makeStorageKey()` from common utilities (see [Storage Key Generation](interface.md#storage-key-generation))
- **Single-attempt operations**: Firestore backends perform single attempts from API perspective; retry logic handled by `lock()` helper
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper at strategic points (before reads, after reads, before writes)

### Acquire Operation Rationale & Notes

**Why runTransaction**: Firestore's atomic operation primitive. Provides ACID guarantees with automatic retry on conflicts.

**Why direct document access**: O(1) lookup by key. Fastest possible access pattern.

**Internal retries (ADR-009)**: Firestore's `runTransaction()` may retry internally for atomicity (platform behavior), but this is transparent to backend API contract.

---

### Release Operation Requirements

- **LockId Validation**: MUST call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input
- **Defensive Duplicate Detection**: SHOULD implement duplicate lockId detection per [Defensive Duplicate LockId Detection](#defensive-duplicate-lockid-detection) section (ADR-014)
- **MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via Firestore transactions:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";

await db.runTransaction(async (trx) => {
  // Query by lockId index (no .limit(1) to enable duplicate detection per ADR-014)
  const querySnapshot = await trx.get(collection.where("lockId", "==", lockId));

  const doc = querySnapshot.docs[0];
  const data = doc?.data();
  const nowMs = Date.now();

  // Check conditions
  const documentExists = !querySnapshot.empty;
  const ownershipValid = data?.lockId === lockId;
  const isLockLive = data
    ? isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)
    : false;

  // Simplified public API result
  if (!documentExists || !ownershipValid || !isLockLive) {
    return { ok: false };
  }

  // Atomically delete the document
  await trx.delete(doc.ref);
  return { ok: true };
});
```

- **System Errors**: Throw `LockError` for transaction failures
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper at strategic points

### Release Operation Rationale & Notes

**Why query by lockId**: Enables keyless API. Caller doesn't need to track which key corresponds to which lockId.

**Why explicit ownership verification**: Defense-in-depth. See ADR-003 rationale.

---

### Extend Operation Requirements

- **LockId Validation**: MUST call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input
- **Defensive Duplicate Detection**: SHOULD implement duplicate lockId detection per [Defensive Duplicate LockId Detection](#defensive-duplicate-lockid-detection) section (ADR-014)
- **MUST return authoritative expiresAtMs**: Computed from client time authority (`Date.now()`) to ensure consistency and accurate heartbeat scheduling. No approximation allowed (see ADR-010).
- **MUST compute `expiresAtMs` inside the transaction using `Date.now()` captured there; NEVER pre-compute outside the transaction.**
- **MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via Firestore transactions:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";

await db.runTransaction(async (trx) => {
  // MUST capture nowMs inside transaction for authoritative client-time (ADR-010)
  const nowMs = Date.now();

  // Query by lockId index (no .limit(1) to enable duplicate detection per ADR-014)
  const querySnapshot = await trx.get(collection.where("lockId", "==", lockId));

  const doc = querySnapshot.docs[0];
  const data = doc?.data();

  // Check conditions
  const documentExists = !querySnapshot.empty;
  const ownershipValid = data?.lockId === lockId;
  const isLockLive = data
    ? isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)
    : false;

  // Simplified public API result
  if (!documentExists || !ownershipValid || !isLockLive) {
    return { ok: false };
  }

  // Compute new expiresAtMs from authoritative time captured inside transaction
  const newExpiresAtMs = nowMs + ttlMs;

  // Atomically update TTL
  await trx.update(doc.ref, { expiresAtMs: newExpiresAtMs });
  return { ok: true, expiresAtMs: newExpiresAtMs };
});
```

- **System Errors**: Throw `LockError` for transaction failures
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper at strategic points

### Extend Operation Rationale & Notes

**Why return expiresAtMs**: Critical for heartbeat scheduling. Caller needs exact expiry to schedule next extend operation safely.

**Why reset (not add)**: Simpler mental model. Caller specifies desired total lifetime, not incremental extension.

---

### IsLocked Operation Requirements

- **Use Case**: Simple boolean checks (prefer `lookup()` for diagnostics)
- Direct document access by key: `collection.doc(key).get()`
- **Read-Only by Default**: Cleanup disabled by default to maintain pure read semantics
- **Optional Cleanup**: When `cleanupInIsLocked: true` configured, MAY perform fire-and-forget cleanup following common spec guidelines
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper before and after read operations

### IsLocked Operation Rationale & Notes

**Why read-only by default**: Users expect `isLocked()` to be pure query with no side effects. Automatic cleanup violates this expectation.

**Why optional cleanup**: Some deployments may benefit from opportunistic cleanup to reduce storage bloat. Opt-in preserves predictability.

---

### Lookup Operation Requirements

**Runtime Validation**: MUST validate inputs before any I/O operations:

- **Key mode**: Call `normalizeAndValidateKey(key)` and fail fast on invalid keys
- **LockId mode**: Call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input

**Key Lookup Mode**:

- **Implementation**: Direct document access by key: `collection.doc(key).get()`
- **Complexity**: O(1) direct access
- **Atomicity**: Single document read (inherently atomic)
- **Performance**: Direct document access, consistently fast

**LockId Lookup Mode**:

- **Implementation**: Query by lockId index: `collection.where('lockId', '==', lockId).get()` (no `.limit(1)` per ADR-014)
- **Defensive Duplicate Detection**: SHOULD implement duplicate lockId detection per [Defensive Duplicate LockId Detection](#defensive-duplicate-lockid-detection) section (ADR-014)
- **Complexity**: Index traversal + verification
- **Atomicity**: Single indexed query (non-atomic is acceptable per interface.md, as lookup is diagnostic-only; release/extend use transactions for full TOCTOU safety)
- **Performance**: Indexed equality query, requires lockId field index

**Common Requirements**:

- **Ownership Verification**: For lockId lookup, MUST verify `data.lockId === lockId` after document retrieval; return `null` if verification fails
- **TOCTOU Safety**: Firestore lookups are inherently safe for diagnostic use - single document/query operations with post-read verification. Per interface.md, non-atomic lookup is acceptable because lookup is diagnostic-only; release/extend operations use transactions for full TOCTOU protection against mutations.
- **Expiry Check**: MUST use `isLive()` from `common/time-predicates.ts` with `Date.now()` and `TIME_TOLERANCE_MS`
- **Data Transformation Requirement**: TypeScript lookup method MUST compute keyHash and lockIdHash using `hashKey()`, and return sanitized `LockInfo<C>`
- **Return Value**: Return `null` if document doesn't exist or is expired; return `LockInfo<C>` for live locks (MUST include `fence`)
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper before and after read operations

### Lookup Operation Rationale & Notes

**Why ownership verification**: Defense-in-depth. Ensures returned lock actually matches requested lockId, even when using indexed queries.

**Why sanitize in TypeScript**: Firestore retrieves raw data. TypeScript layer sanitizes for security before returning.

---

## AbortSignal Requirements

### Requirements

Since `@google-cloud/firestore` does not natively support AbortSignal, backend MUST implement manual cancellation checks using `checkAborted()` helper from `common/helpers.ts`.

**Implementation Pattern**:

```typescript
import { checkAborted } from "../../common/helpers.js";

// In acquire/release/extend operations using transactions
await db.runTransaction(async (trx) => {
  checkAborted(opts.signal); // Before transaction work

  const doc = await trx.get(docRef);
  checkAborted(opts.signal); // After reads

  // Process data...
  checkAborted(opts.signal); // Before writes

  await trx.set(docRef, data);
  return result;
});

// In isLocked/lookup operations without transactions
const doc = await collection.doc(key).get();
checkAborted(opts.signal); // After read
```

**Required Cancellation Points**:

1. **Before transaction work**: Check immediately upon entering transaction to fail fast
2. **After reads**: Check after Firestore read operations complete
3. **Before writes**: Check before performing Firestore write operations

**Error Handling**:

- `checkAborted(signal)` throws `LockError("Aborted", "Operation aborted by signal")` when signal is aborted
- Provides consistent error semantics across operations

**Testing Requirements**:

- Integration tests MUST verify all operations respect AbortSignal
- Tests MUST verify `LockError("Aborted")` is thrown when signal is aborted
- Tests SHOULD verify operations fail quickly when aborted (< 500ms from abort)

### Rationale & Notes

**Why manual checks**: Firestore's `runTransaction()` doesn't support AbortSignal natively. Manual checks provide reasonable cancellation granularity.

**Why multiple check points**: Provides responsive cancellation without excessive overhead. Strategic placement balances performance and responsiveness.

**Minimal overhead**: Simple boolean checks. No significant performance impact.

**Consistent with Redis**: Redis backend passes signal to ioredis (native support). Firestore manual checks achieve equivalent behavior.

---

## Error Handling

### Requirements

**MUST follow [common spec ErrorMappingStandard](interface.md#centralized-error-mapping)**.

**Key Firestore mappings**:

- **ServiceUnavailable**: `UNAVAILABLE`, `INTERNAL`, `ABORTED` (transaction conflicts)
- **NetworkTimeout**: `DEADLINE_EXCEEDED`
- **AuthFailed**: `PERMISSION_DENIED`, `UNAUTHENTICATED`
- **InvalidArgument**: `INVALID_ARGUMENT`, `FAILED_PRECONDITION`
- **RateLimited**: `RESOURCE_EXHAUSTED`
- **Aborted**: Operation cancelled via AbortSignal

**Implementation Pattern**:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";

// Determine conditions
const documentExists = !querySnapshot.empty;
const ownershipValid = data?.lockId === lockId;
const isLockLive = data
  ? isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)
  : false;

// Public API: simplified boolean result
const success = documentExists && ownershipValid && isLockLive;

// Internal detail tracking (best-effort, for decorator if telemetry enabled)
if (!success) {
  const detail = !documentExists || !ownershipValid ? "not-found" : "expired";
}

return { ok: success };
```

### Rationale & Notes

**Why map Firestore codes**: Ensures consistent error codes across backends. Users get predictable error handling.

**Why track internal details**: Enables rich telemetry when decorator enabled, without cluttering public API.

**Key Observations**:

- `!querySnapshot.empty` → document exists check
- `data?.lockId === lockId` → ownership verification (ADR-003)
- `isLive(...)` → expiry check using unified liveness predicate

---

## Performance Characteristics

### Requirements

- **Direct document access**: Fast document lookups for acquire and isLocked operations
- **Indexed equality queries**: Fast indexed lookups for release and extend operations (requires lockId index)
- **Transaction overhead**: ~2-5ms per operation depending on Firestore latency
- **Expected throughput**: 100-500 ops/sec depending on region and network
- **Single-attempt operations**: Firestore backends perform single attempts only; retry logic handled by `lock()` helper

### Rationale & Notes

**Performance targets**: Guide optimization without creating artificial constraints. Actual performance varies by deployment, network, hardware.

**Why lower than Redis**: Network latency to Firestore service + transaction overhead. Redis is typically local or same datacenter.

**Throughput considerations**: Firestore has per-document write limits. High-contention scenarios may require rate limiting.

---

## Configuration and Testing

### Backend Configuration Requirements

- **Unified tolerance**: See `TIME_TOLERANCE_MS` in interface.md for normative specification
- **Lock collection**: Configurable via `collection` option (default: "locks")
- **Fence counter collection**: Configurable via `fenceCollection` option (default: "fence_counters")
- **Configuration Validation**: Backend MUST validate at initialization:
  - `fenceCollection !== collection`
  - Both collection names are valid Firestore paths
  - When cleanup enabled, verify cleanup operations cannot target fence counter collection
  - Throw `LockError("InvalidArgument")` with descriptive message on validation failure
- **Index requirement**: Single-field ascending index on `lockId` field (required for release/extend/lookup by lockId)
- **Cleanup Configuration**: Optional `cleanupInIsLocked: boolean` (default: `false`)
  - **CRITICAL**: Cleanup MUST ONLY delete lock documents, NEVER fence counter documents
- **lookup Implementation**: Required - supports both key and lockId lookup patterns

### Backend Configuration Rationale & Notes

**Why separate collections**: Prevents accidental fence counter deletion. Validation ensures this separation is maintained.

**Why index requirement**: Without index, lockId queries require full collection scans. Performance degrades catastrophically at scale.

---

### Testing Strategy Requirements

- **Unit tests**: Mock Firestore with in-memory transactions, no external dependencies
- **Integration tests**: Real Firestore instance, validates transaction behavior and indexing
- **Performance tests**: Measures transaction latency and throughput under load
- **Index validation**: Ensures required lockId index exists and performs correctly
- **Behavioral compliance testing**: Unit tests MUST verify backend imports and uses `isLive()` from `common/time-predicates.ts`
- **Cross-backend consistency**: Integration tests MUST verify identical outcomes given same tolerance values between Firestore and other backends

### Testing Strategy Rationale & Notes

**Why unit tests with mocks**: Fast feedback loop. No external dependencies for basic correctness checks.

**Why integration tests with real Firestore**: Validates transaction behavior, index performance, actual atomicity guarantees under production-like conditions.

**Why cross-backend tests**: Ensures API consistency. Users should get identical behavior regardless of backend choice (accounting for time authority differences).
