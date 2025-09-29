# Common Lock Interface Specification

This document defines the core interface and behavioral requirements that all SyncGuard backend implementations must follow.

## LockBackend Interface Requirements

### Core Constants

```typescript
// Maximum key length after Unicode NFC normalization and UTF-8 encoding
export const MAX_KEY_LENGTH_BYTES = 512;

// Backend defaults - used by all backend implementations
export const BACKEND_DEFAULTS = {
  ttlMs: 30_000, // 30 seconds
} as const;

// Note: For retry configuration, see the lock() helper function.
// Backends do not implement retries - they perform single-attempt operations only.
```

**Key Validation Requirements**:

- Backends MUST validate user-supplied key length after `key.normalize('NFC')` and UTF-8 encoding
- User keys exceeding `MAX_KEY_LENGTH_BYTES` MUST throw `LockError('InvalidArgument')`
- This limit applies to the user-supplied key before any backend-specific prefixing or namespacing
- **Storage Key Generation**: When the prefixed storage key `prefix:userKey` exceeds the backend's storage limit, backends MUST apply the standardized hash-truncation scheme below. Backends MUST throw `LockError('InvalidArgument')` only if even the truncated form exceeds the backend's absolute limit (e.g., prefix too long)
- This prevents DoS attacks via huge keys and ensures consistent behavior across backends
- Validation MUST occur before any lock operations (acquire, isLocked, etc.)

### Standardized Storage Key Generation

All backends MUST use this deterministic algorithm for generating storage keys:

```typescript
// Step 1: Try normal prefixed key first
const prefixedKey = `${prefix}:${key.normalize("NFC")}`;
if (prefixedKey.length <= backendLimit) {
  return prefixedKey;
}

// Step 2: Apply hash truncation when prefixed key exceeds limit
const normalizedKey = key.normalize("NFC");
const utf8Bytes = new TextEncoder().encode(normalizedKey);
const hash = sha256(utf8Bytes);
const truncatedHash = hash.substring(0, 24); // 24 hex chars = 96 bits

// Step 3: Construct truncated storage key
const storageKey = `${prefix}:${truncatedHash}`;

// Step 4: Final validation - throw only if even truncated form exceeds limits
if (storageKey.length > backendLimit) {
  throw new LockError(
    "InvalidArgument",
    "Key exceeds backend limits even after truncation",
  );
}
```

**Requirements**:

- **Mandatory truncation**: When `prefix:userKey` exceeds backend limits, truncation is REQUIRED (not optional)
- **Deterministic**: Same `userKey` always produces same `storageKey`
- **Collision-resistant**: 96-bit hash space provides ~6.3e-12 collision probability at 10^9 distinct keys
- **Consistent**: All backends MUST use identical algorithm for cross-backend consistency
- **Separator**: Use `:` to distinguish prefix from hash component
- **Common implementation**: Backends SHOULD use `makeStorageKey()` helper from common utilities
- **Throw only as last resort**: Only when even truncated form exceeds absolute backend limits

**Implementation**: All backends MUST implement this logic for main lock keys, reverse index keys, and fence counter keys to ensure uniform behavior across all storage operations.

### Backend Capabilities

```typescript
// Backend capability declaration for type-safe feature detection
interface BackendCapabilities {
  supportsFencing: boolean; // Whether backend generates fence tokens
  timeAuthority: "server" | "client"; // Time authority model used
}
```

### Core Interface Definition

````typescript
// Base operation types for consistent parameter patterns
type KeyOp = Readonly<{ key: string; signal?: AbortSignal }>;
type LockOp = Readonly<{ lockId: string; signal?: AbortSignal }>;

// Lookup operation types
type KeyLookup = {
  key: string;                // O(1) direct access
  signal?: AbortSignal;
};

type OwnershipLookup = {
  lockId: string;             // reverse lookup + verification
  signal?: AbortSignal;
};

interface LockBackend<C extends BackendCapabilities = BackendCapabilities> {
  acquire: (opts: KeyOp & { ttlMs: number }) => Promise<AcquireResult<C>>;
  release: (opts: LockOp) => Promise<ReleaseResult>;
  extend: (opts: LockOp & { ttlMs: number }) => Promise<ExtendResult>;
  isLocked: (opts: KeyOp) => Promise<boolean>;

  /** Lookup lock information by key (direct O(1) access) */
  lookup(opts: KeyLookup): Promise<LockInfo<C> | null>;
  /** Lookup lock information by lockId (reverse lookup + verification) */
  lookup(opts: OwnershipLookup): Promise<LockInfo<C> | null>;
  // Implementation signature
  lookup(opts: KeyLookup | OwnershipLookup): Promise<LockInfo<C> | null>;

  readonly capabilities: Readonly<C>; // Required capability introspection
}

/**
 * Lookup Invariants:
 * - Always returns sanitized data (keyHash/lockIdHash, never raw keys/lockIds)
 * - Consistent return shape regardless of lookup method (key vs lockId)
 * - Prevents accidental logging of sensitive identifiers
 * - Includes expiresAtMs and acquiredAtMs timestamps (Unix ms)
 * - Includes fence when backend.capabilities.supportsFencing === true
 * - Returns null for both expired and not-found locks (no distinction)
 * - For raw key/lockId access, use lookupDebug() helper function
 */

// Success or Contention only (acquisition timeout throws LockError)
export type AcquireOk<C extends BackendCapabilities> = {
  ok: true;
  lockId: string;
  expiresAtMs: number;
} & (C['supportsFencing'] extends true ? { fence: Fence } : {});

export type AcquireResult<C extends BackendCapabilities> =
  | AcquireOk<C>
  | {
      ok: false;
      reason: "locked";
    };

// **Fence Token Compile-Time Guarantee**: Fence tokens are required in the type system when
// `backend.capabilities.supportsFencing === true`. All v1 backends (Redis, Firestore) provide
// fencing tokens. Non-fencing backends are out of scope for v1.
// **Type Safety**: TypeScript automatically knows fence exists for fencing-capable backends.

// **Time fields:** All core types use `expiresAtMs` / `acquiredAtMs` (Unix ms) for consistency and wire/JSON optimization. Helper utilities MAY provide Date conversion when convenient for consumers.

// Fencing token types
export type Fence = string; // Fixed-width decimal strings with lexicographic ordering
// **Format Contract:** 19-digit zero-padded decimal strings (e.g., "0000000000000000001")
// **Ordering Guarantee:** Higher fence values are lexicographically larger strings
// **Comparison Rule:** Use direct string comparison: `fenceA > fenceB`, `fenceA === fenceB`
// **Cross-Backend Consistency:** All backends use identical 19-digit zero-padded format
// **JSON Safety:** String representation ensures consistent serialization and precision
// **Range:** 19 digits accommodate Redis's signed 64-bit INCR limit (2^63-1 ≈ 9.2e18)
// **Overflow:** Backends SHOULD warn when fence > 9e18; actual overflow maps to LockError("Internal")
// **Rationale:** See ADR-004-R2 for why the format is fixed (eliminates helper functions, ensures portability)

## Fence Token Usage

### ✅ **Correct Usage**
```typescript
// Compare fence tokens using lexicographic string comparison
// IMPORTANT: Don't parse - compare as strings only (per ADR-004-R2)
const newer = fenceA > fenceB;
const same = fenceA === fenceB;
const older = fenceA < fenceB;

// Store/transmit as strings (JSON-safe)
localStorage.setItem('lastFence', fence);
await api.updateResource({ fence });

// Sort fences
const sortedFences = fences.sort(); // Lexicographic = chronological order
````

### ❌ **Avoid These Patterns**

```typescript
// DON'T: Parse as numbers (not needed and may lose precision)
const num = parseInt(fence); // ❌ Unnecessary

// DON'T: Modify the format (breaks ordering)
const trimmed = fence.replace(/^0+/, ""); // ❌ Breaks comparison
```

## Unified Time Handling and Liveness Predicate {#time-authority}

**Critical Requirement**: All backends MUST use the unified liveness predicate with internal constants to ensure consistent behavior across implementations.

### Single Liveness Predicate

All backends MUST use this canonical predicate with backend-specific time sources and internal tolerance constants:

```typescript
// common/time-predicates.ts - single source of truth
export function isLive(
  expiresAtMs: number,
  nowMs: number,
  toleranceMs: number,
): boolean {
  return expiresAtMs > nowMs - toleranceMs;
}

// Time source helpers
export function calculateRedisServerTimeMs(
  timeTuple: [string, string],
): number {
  return (
    parseInt(timeTuple[0]) * 1000 + Math.floor(parseInt(timeTuple[1]) / 1000)
  );
}

// Unified time tolerance constant (not user-configurable)
export const TIME_TOLERANCE_MS = 1000; // 1000ms - safe for all backends and time authorities
```

### Time Authority Models

Backends use different time sources but the same liveness predicate with internal constants:

#### Server Time Authority (Redis)

- **Time Source**: Redis server time via `redis.call('TIME')`
- **Tolerance**: Unified 1000ms tolerance for predictable behavior
- **Consistency**: High - single time source eliminates most clock drift

```typescript
// Redis implementation pattern
import {
  isLive,
  calculateRedisServerTimeMs,
  TIME_TOLERANCE_MS,
} from "../common/time-predicates.js";

const time = await redis.call("TIME");
const nowMs = calculateRedisServerTimeMs(time);
const live = isLive(storedExpiresAtMs, nowMs, TIME_TOLERANCE_MS);
```

#### Client Time Authority (Firestore)

- **Time Source**: Client time via `Date.now()`
- **Tolerance**: Unified 1000ms tolerance for predictable behavior
- **Requirements**: NTP synchronization recommended for production

```typescript
// Firestore implementation pattern
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";

const nowMs = Date.now();
const live = isLive(storedExpiresAtMs, nowMs, TIME_TOLERANCE_MS);
```

### Consistent Behavior Across Backends

All backends use unified 1000ms tolerance, providing identical liveness semantics:

```typescript
// Consistent behavior - both backends use 1000ms tolerance
const redisBackend = createRedisBackend(); // 1000ms tolerance
const firestoreBackend = createFirestoreBackend(); // 1000ms tolerance
```

### Implementation Requirements {#time-implementation-requirements}

- **Single Predicate**: ALL backends MUST use `isLive()` from `common/time-predicates.ts` across ALL operations
- **No Custom Logic**: Custom time logic implementations are FORBIDDEN
- **Unified Tolerance**: Backends MUST use `TIME_TOLERANCE_MS` constant from `common/time-predicates.ts`
- **Capability Declaration**: Backends MUST expose `timeAuthority` in capabilities
- **Time Consistency**: All timestamps MUST use the backend's designated time authority
- **Cross-Backend Testing**: Test suites MUST verify identical outcomes with unified tolerance

// Simplified release/extend results
export type ReleaseResult =
| { ok: true } // release success never includes expiresAtMs
| { ok: false }; // lock was absent (expired or never existed)

// Specific result types for operations that require different return values
export type ExtendResult =
| { ok: true; expiresAtMs: number } // expiresAtMs required for heartbeat scheduling
| { ok: false }; // lock was absent (expired or never existed)

// **Simplified Semantics:** With lockId-only operations, ownership conflicts cannot occur since each lockId maps to exactly one key via reverse mapping. Failed operations indicate the lock was absent for any reason.

## Telemetry and Observability (Optional) {#telemetry-semantics}

**Telemetry Model**: Backends MAY track internal conditions (expired vs not-found) when cheaply available but SHOULD NOT compute hashes or construct event payloads unless telemetry is explicitly enabled. Telemetry is opt-in via the `withTelemetry` decorator.

### Internal Condition Tracking (Best-Effort)

Backends MAY track internal conditions cheaply for consumption by telemetry decorators:

| Internal Condition | Public API Result | Available for Telemetry                 |
| ------------------ | ----------------- | --------------------------------------- |
| Success            | `{ ok: true }`    | Always                                  |
| Observable expiry  | `{ ok: false }`   | When cheaply detectable → `"expired"`   |
| Not found/other    | `{ ok: false }`   | When cheaply detectable → `"not-found"` |
| Unknown/ambiguous  | `{ ok: false }`   | No detail provided                      |

**Important**: Backends MUST NOT perform additional I/O solely to distinguish failure reasons.

### Telemetry Benefits (When Enabled)

- **"expired" events**: Indicate cleanup lag or time synchronization issues
- **"not-found" events**: Indicate normal cleanup, ownership conflicts, or missing locks
- **Zero-cost abstraction**: No performance impact when telemetry is disabled

### Implementation Guidance

**Core Backends**: Return simple `{ ok: boolean }` results, track cheap internal details
**Telemetry Decorator**: Wraps backend, emits events with hashes and reasons when configured
**Async Isolation**: `onEvent` callbacks MUST NOT be awaited; errors MUST NOT affect lock operations

// System errors and acquisition timeouts throw LockError
export class LockError extends Error {
constructor(
public code:
| "ServiceUnavailable"
| "AuthFailed"
| "InvalidArgument"
| "RateLimited"
| "NetworkTimeout" // raised by backend/network operations due to network/backend timeouts
| "AcquisitionTimeout" // raised only by lock() helper when its retry loop exceeds timeoutMs
| "Internal",
message?: string,
public context?: { key?: string; lockId?: string; cause?: unknown }
) {
super(message ?? code);
this.name = "LockError";
}
}

// Fence Token Type Safety

/\*\*

- Type guard for generic code that accepts unknown backend types.
- Not needed when using properly typed backends (Redis/Firestore).
-
- @param result - The acquire result to check
- @returns true if result is successful and has a fence token
  \*/
  export function hasFence<C extends BackendCapabilities>(
  result: AcquireResult<C>
  ): result is AcquireOk<C> & { fence: Fence } {
  return result.ok && 'fence' in result && !!result.fence;
  }

## Fence Token Usage Patterns

### Basic Usage with Typed Backends

```typescript
// Redis and Firestore backends have compile-time fence guarantees
const backend = createRedisBackend(config); // or createFirestoreBackend
const result = await backend.acquire({ key: "resource", ttlMs: 30000 });

if (result.ok) {
  // TypeScript knows fence exists - no assertions needed!
  const fence = result.fence;

  // Compare fences using string comparison
  if (fence > lastKnownFence) {
    await updateResourceWithFence(resource, fence);
    lastKnownFence = fence;
  }
}
```

### Generic Code Pattern

```typescript
// Only needed when accepting unknown backend types
function processWithAnyBackend<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  result: AcquireResult<C>,
) {
  if (hasFence(result)) {
    // Type guard for generic contexts
    console.log("Fence:", result.fence);
  }
}
```

// Hash identifier type for observability
export type HashId = string; // SHA-256 truncated to 96 bits (24 hex chars)

// Hash ID Generation Algorithm (Simplified):
// Step 1: Unicode normalization
// normalizedValue = value.normalize('NFC')
//
// Step 2: Hash generation
// hashId = sha256(utf8(normalizedValue)).substring(0, 24)
//
// This provides 96-bit collision resistance with ~6.3e-12 probability at 10^9 distinct IDs.
// Uses SHA-256 for simplicity - no configuration or secrets required.

// Telemetry decorator types (not part of core API)
export interface TelemetryOptions {
onEvent: (event: LockEvent) => void;
includeRaw?: boolean | ((event: LockEvent) => boolean);
}

// Minimal event structure when telemetry is enabled
type LockEvent = {
type: string; // Operation type
keyHash?: HashId; // Computed only when telemetry active
lockIdHash?: HashId; // Computed only when telemetry active
result: "ok" | "fail";
reason?: "expired" | "not-found"; // Best-effort from backend
// Raw fields included only when includeRaw allows
key?: string;
lockId?: string;
};

// Public validation helpers remain in core
export function validateLockId(lockId: string): void;
export function normalizeAndValidateKey(key: string): string;

/\*\*

- Canonical hash function used by all backends for consistent sanitization.
- MUST be used by all backend implementations to ensure cross-backend consistency.
- Uses same algorithm as storage key generation for uniform behavior.
  \*/
  export function hashKey(value: string): HashId;

// Internal fence formatting helper (NOT part of public API)
// Backends MUST use this helper to ensure consistent fence formatting
function formatFence(value: bigint | number): Fence {
return String(value).padStart(19, '0');
}

// Internal helper for backends to sanitize raw lock data
export function sanitizeLockInfo<C extends BackendCapabilities>(
rawData: { key: string; lockId: string; expiresAtMs: number; acquiredAtMs: number; fence?: string },
capabilities: C
): LockInfo<C>;

// **Scope Note**: Non-fencing backends are out of scope for v1. All bundled backends
// (Redis, Firestore) provide fencing tokens. The capabilities field remains for
// forward compatibility with potential future non-fencing adapters.

// Telemetry decorator factory (separate from core backend)
export function withTelemetry(
backend: LockBackend,
options: TelemetryOptions
): LockBackend;

// Debug helper for raw data access
export function lookupDebug<C extends BackendCapabilities>(
backend: LockBackend<C>,
query: { key: string } | { lockId: string }
): Promise<LockInfoDebug<C> | null>;

// Telemetry Decorator Behavior (when enabled):
// - Hash computation: Only performed when telemetry is active via decorator
// - Event emission: Non-blocking, errors isolated from lock operations
// - Redaction: Controlled by decorator's `includeRaw` option (not global config)
// - Backend integration: Consumes cheap internal details when available
// - Performance: Zero-cost when decorator not applied
//
// Security Requirements (when telemetry enabled):
// - Default `includeRaw: false` - require explicit opt-in for raw data
// - Consider environment-based allowlists (e.g., dev-only raw data)
// - Keys matching denylist patterns (`token`, `secret`, etc.) stay redacted
// - No sensitive config (connection strings, credentials) in events

````

### Storage Requirements

**Reverse Mapping**: All backends MUST provide a mechanism to atomically resolve `lockId → key` for the lifetime of each lock. This capability is established at acquisition and used by `release` and `extend` operations to atomically load the key from `lockId` for ownership verification. This requirement enables the keyless API design where `lockId` serves as a sufficient handle for all lock operations.

**CRITICAL: TOCTOU Protection**: To prevent Time-of-Check-Time-of-Use race conditions, ALL `release` and `extend` operations MUST execute these steps atomically within a single transaction/script:

1. **Resolve mapping**: Load the key from lockId via reverse mapping
2. **Validate state**: Verify lock exists and is not expired
3. **Perform mutation**: Delete (release) or update TTL (extend)

**Race Condition Example**: Without atomicity, between steps 1-2 and step 3, another process could expire/delete the original lock and acquire a new lock on the same key, causing the first process to accidentally operate on the wrong lock.

**Implementation Options**: Backends MAY implement this requirement through:
- **Explicit mapping**: Separate `lockId → key` storage (e.g., Redis index keys)
- **Indexed queries**: Database queries on indexed `lockId` fields (e.g., Firestore single-field index)

The chosen approach MUST support atomic ownership verification within the same transaction/script as the mutation operation.

### Operation Requirements

#### Acquire Operation

- **Atomicity**: Operations MUST be atomic (transaction/script/CAS) with **no race window** between setting ownership and TTL. Single round-trip is RECOMMENDED but not REQUIRED.
- **Lock ID Generation**: MUST use 16 bytes of cryptographically strong randomness from a CSPRNG (e.g., `crypto.getRandomValues()`). Lock IDs MUST be base64url encoded strings with exactly 22 characters (16 bytes of entropy). No timestamp fallback. If the runtime lacks a secure RNG, SyncGuard MUST provide one.
- **Lock ID Validation**: Backends MUST validate `lockId` format in all operations (release, extend, lookup) and throw `LockError("InvalidArgument")` for malformed lockIds. Validation prevents expensive lookups on invalid input and provides clear error messages. Valid format: exactly 22 base64url characters matching `^[A-Za-z0-9_-]{22}$`.
- **TTL Handling**: Respect `config.ttlMs` for automatic expiration
- **TTL Authority**: Expiration SHOULD be enforced by backend server time when natively available (e.g., Redis TIME). For backends without native server time (e.g., Firestore), use client time with documented skew tolerance of ±2 seconds and NTP synchronization recommended. Backends using eventual cleanup MUST atomically verify ownership by comparing current time against stored expiry.
- **Contention Behavior**: Return `{ ok: false, reason: "locked" }` when lock is held by another process. No fairness or ordering guarantees.
- **Error Distinction**: Contention returns `AcquireResult`, system errors throw `LockError`
- **Fencing Tokens**: Backends that support fencing MUST always generate fence tokens. Fence tokens MUST be atomically persisted with acquisition and be strictly increasing per key (no repeats, no decreases), even across restarts
- **Monotonicity Guarantee**: `fence` values MUST increase for each successful acquisition of the same key, surviving backend restarts
- **API Format**: Fence values MUST be returned as exactly 19-digit zero-padded decimal strings (format: `String(fenceNumber).padStart(19, '0')`)
- **Storage Flexibility**: Backends MAY store fence values as numbers internally but MUST preserve full 64-bit precision and convert to 19-digit zero-padded strings at API boundary
- **Validation**: `ttlMs` MUST be a positive integer (ms); otherwise throw `LockError("InvalidArgument")`. Helper functions MAY apply defaults before calling backend operations.
- **Storage Key Limits**: Backends MUST document their effective storage-key byte limits after prefixing/namespacing. If user key + prefix exceeds the backend's storage limit, backend MUST either throw `LockError("InvalidArgument")` or use collision-safe truncation with hashing. All backends MUST enforce the common 512-byte user key limit first.
- **Performance**: Fast indexed lookups are the target; backends SHOULD document expected performance characteristics

#### Release Operation

- **TOCTOU Protection**: MUST follow the CRITICAL TOCTOU Protection requirement above - all three steps (resolve mapping, validate state, perform mutation) MUST be atomic within a single transaction/script
- **Ownership Verification**: MUST verify lock existence and validity before release via the lockId→key reverse mapping
- **Ownership Binding**: At acquisition, the backend MUST bind `lockId → key` and store this mapping for the lock's lifetime. `release` MUST atomically load the key from `lockId` and verify that the lock still exists and is not expired. The reverse mapping ensures each `lockId` is valid for exactly one key.
- **Return Value**: Return `{ ok: true }` when the mutation was applied. Return `{ ok: false }` otherwise. System/validation/auth/transport failures MUST throw `LockError`; domain outcomes use `ReleaseResult`.
- **Telemetry**: Emit `release-failed` events with detailed `reason` ("expired" | "not-found") for operational monitoring while keeping public API simple.
- **LockId-Only Semantics**: Since release operates via `lockId` with reverse mapping to find the key, ownership conflicts are eliminated in normal operation. However, backends MAY transiently observe ownership mismatches due to stale indices (cleanup race conditions, TTL drift, etc.).
- **At-most-once effect**: Only one `release` may succeed. Concurrent or repeated `release(lockId)` calls for the same lock MUST NOT delete any other owner's lock and SHOULD return `{ ok: false, reason: "not-found" }` once the lock is gone.

#### Extend Operation

- **TOCTOU Protection**: MUST follow the CRITICAL TOCTOU Protection requirement above - all three steps (resolve mapping, validate state, perform mutation) MUST be atomic within a single transaction/script
- **Ownership Verification**: MUST verify lock existence and validity before extending via the lockId→key reverse mapping
- **Ownership Binding**: Same requirement as release - MUST atomically load the key from `lockId` and verify that the lock still exists and is not expired
- **No Resurrection**: `extend` MUST NOT recreate an expired lock. Extend operations MUST succeed only if `current_server_time < stored_expiresAt_server`, checked atomically within the same transaction/script. If the lock is absent or expired, follow the CRITICAL REQUIREMENT above for expired vs not-found semantics.
- **TTL Update Semantics**: `extend(ttlMs)` resets the expiration to **now + ttlMs** (replaces remaining TTL, does NOT add). Implementations MUST set new expiry to `current_server_time + ttlMs` atomically. This replaces any remaining TTL entirely.
- **TTL Update**: Update expiration time atomically
- **Return Value**: Return `{ ok: true, expiresAtMs: number }` when the mutation was applied (includes new server-based expiry time for heartbeat scheduling). Return `{ ok: false }` otherwise. System/validation/auth/transport failures MUST throw `LockError`; domain outcomes use `ExtendResult`.
- **Telemetry**: Emit `extend-failed` events with detailed `reason` ("expired" | "not-found") for operational monitoring while keeping public API simple.
- **LockId-Only Semantics**: Since extend operates via `lockId` with reverse mapping to find the key, ownership conflicts are eliminated in normal operation. However, backends MAY transiently observe ownership mismatches due to stale indices (cleanup race conditions, TTL drift, etc.).
- **Validation**: `ttlMs` MUST be a positive integer number of milliseconds; otherwise throw `LockError("InvalidArgument")`

#### IsLocked Operation

- **Use Case**: Simple boolean checks for control flow (prefer `lookup()` when you need diagnostic context)
- **Performance**: Target fast indexed lookups where possible
- **Read-Only Expectation**: Users expect `isLocked()` to be a pure read operation with no side effects. To honor this expectation, cleanup is **disabled by default**.
- **Optional Cleanup**: Backends MAY support opt-in cleanup via configuration (e.g., `cleanupInIsLocked: true`). When enabled:
  - MUST NOT affect the return value of the current call
  - MUST NOT block, affect, or modify live locks in any way
  - MUST NOT perform any writes that could alter live lock TTL or timestamps
  - MAY perform best-effort, non-blocking cleanup of expired locks as fire-and-forget operations with rate limiting
  - **Cleanup Safety Guard**: MUST use safety guards to prevent race conditions with concurrent extend operations:
    - **Server Time Backends (Redis)**: Only delete when `server_time_ms - stored_expiresAtMs > guard_ms` where `guard_ms >= 2000ms`
    - **Client-Skew Backends (Firestore)**: Only delete when `Date.now() - stored_expiresAtMs > (skew_tolerance_ms + guard_ms)` where `guard_ms >= 1000ms`
  - **Documentation**: Backends that support cleanup MUST clearly document the trade-offs and testing implications
- **Return Value**: `true` if actively locked, `false` otherwise
- **Security**: MUST NOT leak lockId or owner identity information
- **TTL Constraints**: MUST NOT indirectly prolong lock lifetime (e.g., via touched/updated timestamps or triggers)

### Lookup Operation (Required)

#### Lookup Modes & Guarantees

**Key Mode** (`{ key }`):
- **Complexity**: O(1) direct access (single operation)
- **Atomicity**: Not applicable (inherently atomic read)
- **Use case**: "Is this resource currently locked?"
- **Performance**: Fast indexed lookups, single backend operation

**Ownership Mode** (`{ lockId }`):
- **Complexity**: Multi-step (reverse mapping + verification)
- **Atomicity**: MUST use atomic script/transaction to prevent TOCTOU races
- **Use case**: "Do I still own this lock?"
- **Performance**: Index traversal + verification overhead

#### Implementation Requirements

- **Dual Lookup**: Discriminated overloads provide compile-time safety and better IntelliSense
- **Runtime Validation**: MUST validate inputs before any I/O operations:
  - Key mode: Call `normalizeAndValidateKey(key)` and fail fast on invalid keys
  - LockId mode: Call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input
- **Key Lookup**: Return the live lock for the specified key via direct access
- **LockId Lookup**: Return the live lock associated with the specified lockId (enables ownership checking)
- **Ownership Verification**: When looking up by `lockId` via index-based reverse mapping (e.g., Firestore), implementations MUST verify `data.lockId === lockId` after document retrieval; return `null` if verification fails. This provides defense-in-depth and ensures consistent behavior across backends.
- **Atomicity Requirement**: Backends that require multi-key reads (e.g., Redis lockId lookup) MUST implement lookup atomically via scripts or transactions to prevent TOCTOU races
- **Null Semantics**: Return `null` if the lock does not exist or is expired; do not attempt to infer distinction between expired vs not-found
- **Read-Only**: MUST be read-only and MUST NOT mutate TTL, timestamps, or any lock state
- **Diagnostic Purpose**: Intended for ownership checking and diagnostics; MUST NOT be used to gate subsequent mutations
- **Performance**: Key lookup SHOULD be optimized for direct access; lockId lookup MAY be slower but SHOULD be reasonably fast
- **Security**: `lookup()` always returns sanitized data (no raw keys/lockIds). Use `lookupDebug()` helper for raw data access when debugging.

#### Usage Examples

**✅ Recommended: Use Helper Functions**:
```typescript
import { getByKey, getById, owns } from 'syncguard';

// Diagnostic: "Is this resource locked?"
const resourceInfo = await getByKey(backend, "resource:123");
if (resourceInfo) {
  console.log(`Resource locked until ${new Date(resourceInfo.expiresAtMs)}`);
}

// Ownership check: "Do I still own this lock?"
const owned = await owns(backend, myLockId);
if (owned) {
  console.log("Still own the lock");
}

// Detailed ownership info with raw data
const lockInfo = await getByIdRaw(backend, myLockId);
if (lockInfo) {
  console.log(`Lock expires in ${lockInfo.expiresAtMs - Date.now()}ms`);
}
````

**Advanced: Direct Backend Methods**:

```typescript
// Direct key lookup
const resourceInfo = await backend.lookup({ key: "resource:123" });

// Direct ownership check
const stillOwned = !!(await backend.lookup({ lockId }));

// With cancellation signal
const info = await backend.lookup({
  key: "resource:123",
  signal: abortController.signal,
});
```

#### API Usage Patterns

```typescript
// ✅ Recommended: Use explicit helpers
import { getByKey, getById, getByIdRaw, owns } from "syncguard";

const info = await getByKey(backend, "resource:123");
const owned = await owns(backend, lockId);
const diagnostics = await getByIdRaw(backend, lockId);

// ✅ Advanced: Direct lookup method
await backend.lookup({ key: "resource:123" }); // Key mode
await backend.lookup({ lockId: "abc123xyz" }); // Ownership mode

// ❌ Compile errors - TypeScript prevents misuse
await backend.lookup({ key: "foo", lockId: "bar" }); // Both provided (impossible)
await backend.lookup({}); // Neither key nor lockId provided (impossible)
```

### ❌ **DO NOT: Extend-for-Ownership Anti-Pattern**

```typescript
// WRONG: This mutates TTL and has side effects!
const owned = (await backend.extend({ lockId, ttlMs: 1 })).ok; // ❌ DON'T DO THIS
```

**Why the anti-pattern is dangerous**:

- Unintended side effects (TTL mutation when you wanted read-only check)
- Could accidentally shorten lock lifetime
- Semantically incorrect (extend ≠ ownership check)
- Race conditions with other code expecting unchanged TTL

**Use the official ownership checking method instead** → See [Ownership Checking](#ownership-checking) section.

## First-Class Diagnostic Helpers

For enhanced developer experience, SyncGuard provides these diagnostic functions as first-class exports:

```typescript
/**
 * Lookup lock by key (direct O(1) access) - returns sanitized data
 * Available as: import { getByKey } from 'syncguard';
 */
export function getByKey<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null>;

/**
 * Lookup lock by lockId (reverse lookup + verification) - returns sanitized data
 * Available as: import { getById } from 'syncguard';
 */
export function getById<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null>;

/**
 * Lookup lock by key with raw data (for debugging)
 * Available as: import { getByKeyRaw } from 'syncguard';
 */
export function getByKeyRaw<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfoDebug<C> | null>;

/**
 * Lookup lock by lockId with raw data (for debugging)
 * Available as: import { getByIdRaw } from 'syncguard';
 */
export function getByIdRaw<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfoDebug<C> | null>;

/**
 * Quick ownership check - returns boolean
 * Available as: import { owns } from 'syncguard';
 */
export function owns<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
): Promise<boolean>;
```

**Usage patterns**:

```typescript
import { getByKey, getById, owns } from "syncguard";

// ✅ Recommended: Explicit helpers (clear intent)
const resourceInfo = await getByKey(backend, "resource:123");
const ownershipInfo = await getById(backend, currentLockId);

// Quick boolean ownership check
if (await owns(backend, lockId)) {
  // Still own the lock
}

// ✅ Advanced: Direct method (when helpers aren't sufficient)
const info = await backend.lookup({ key: "resource:123" });
const owned = !!(await backend.lookup({ lockId }));
```

**Benefits**:

- **Discoverable**: Explicit verbs appear in IDE autocomplete
- **Minimal core API**: `LockBackend` interface stays lean with one method
- **Type-safe**: Full TypeScript support with clear parameter types
- **Consistent**: All helpers delegate to the core `lookup()` method

## LockFunction Helper Specification

**Note**: The `lock()` function is a helper that adds automatic retry and release management on top of the core backend interface. **Backends perform single-attempt operations only.**

### Automatic Lock Management

```typescript
// Primary API - auto-managed locks with retries
await lock(async () => {
  // Critical section
}, config);
```

#### Helper-Specific Configuration

```typescript
// Lock helper defaults (NOT part of backend interface)
export const LOCK_DEFAULTS = {
  maxRetries: 10, // Retry attempts
  retryDelayMs: 100, // Base delay (ms)
  timeoutMs: 5_000, // Acquisition timeout (ms)
  backoff: "exponential", // Backoff strategy
  jitter: "equal", // Jitter type (50% randomization)
} as const;
```

#### Reentrancy Semantics

- **Reentrancy**: The common API is **non-reentrant** by default. Non-reentrancy is enforced at the **key** level only. Backends do not attempt to identify callers; a second `acquire(key)` while a live lock exists is treated as contention regardless of caller identity. Higher-level helpers MAY provide opt-in reentrancy policies; backends remain non-reentrant.

#### Lifecycle Requirements

1. **Acquisition**: Call `backend.acquire(config)` with merged configuration
2. **Retry Logic**: Handle `{ ok: false, reason: "locked" }` with configured retry strategy
3. **Timeout Handling**: Throw `LockError("AcquisitionTimeout")` if `timeoutMs` exceeded
4. **Cancellation Semantics**: Acquisition is aborted if **either** `config.signal` or `config.acquisition?.signal` is aborted (logical OR). Helpers MUST forward `config.signal` to backend calls when their client supports cancellation; backends SHOULD honor signals for predictable cancellation behavior.
5. **Execution**: Execute user function only after successful acquisition (`ok: true`)
6. **Release**: ALWAYS attempt release in finally block, regardless of function outcome
7. **Error Handling**: Function errors take precedence over release errors
8. **Observability**: Emit appropriate `LockEvent` instances throughout lifecycle

#### Release Error Handling

- **With onReleaseError**: Call user-provided callback with `(error, { lockId, key })`
- **Without onReleaseError**: Silently ignore release errors (locks expire via TTL)
- **Error Conversion**: Convert non-Error objects to Error instances
- **No Masking**: Never mask function execution errors with release errors

### Manual Lock Operations

Direct access to backend operations:

- `backend.acquire({ key, ttlMs })` - Returns `AcquireResult`
- `backend.release({ lockId })` - Returns `ReleaseResult`
- `backend.extend({ lockId, ttlMs })` - Returns `ExtendResult`
- `backend.isLocked({ key })` - Returns `boolean` (simple checks)
- `backend.lookup({ key })` or `backend.lookup({ lockId })` - Required; returns `LockInfo | null` (ownership checking, diagnostics, monitoring)

## Configuration Management

### LockConfig Interface

```typescript
interface LockConfig {
  key: string; // Required: Unique lock identifier
  ttlMs?: number; // Default: 30000 (30 seconds)
  signal?: AbortSignal; // Optional: Cancel in-flight operations
  onReleaseError?: (
    error: Error,
    context: { lockId: string; key: string },
  ) => void;
  onEvent?: (event: LockEvent) => void; // Deprecated: Use withTelemetry decorator instead
}

type AcquisitionOptions = {
  maxRetries?: number; // default 10
  retryDelayMs?: number; // base delay, default 100ms
  backoff?: "exponential" | "fixed"; // default "exponential"
  jitter?: "equal" | "full" | "none"; // default "equal"
  timeoutMs?: number; // hard wall for acquisition loop, default 5000ms
  signal?: AbortSignal; // abort the acquisition loop
};

// Enhanced lock function signature
export async function lock<T>(
  fn: () => Promise<T> | T,
  config: LockConfig & { acquisition?: AcquisitionOptions },
): Promise<T>;

// Primary sanitized lock information structure returned by lookup()
export type LockInfo<C extends BackendCapabilities> = {
  keyHash: HashId; // Hash identifier for the key
  lockIdHash: HashId; // Hash identifier for the lockId
  expiresAtMs: number; // Unix timestamp in milliseconds - required for live locks
  acquiredAtMs: number; // Unix timestamp in milliseconds - required for live locks
} & (C["supportsFencing"] extends true ? { fence: Fence } : {}); // Fence is required for fencing backends

// Debug variant with raw data (via lookupDebug helper)
export interface LockInfoDebug<C extends BackendCapabilities>
  extends LockInfo<C> {
  key: string; // Raw key for debugging
  lockId: string; // Raw lockId for debugging
}
```

### Configuration Merging

- **Backend Defaults**: Apply `BACKEND_DEFAULTS` for backend operations
- **Helper Defaults**: Apply `LOCK_DEFAULTS` for the lock() helper only
- **Preservation**: Preserve user-provided values exactly
- **Type Safety**: Ensure merged config satisfies type requirements

## Error Handling Standards

### Error Classification

#### Transient Errors (Retry)

- Network timeouts and connection failures
- Temporary service unavailability
- Transaction conflicts (e.g., Firestore ABORTED)
- Rate limiting responses
- Backend-specific transient errors (see individual specs)

#### Permanent Errors (Fail Fast)

- Authentication and authorization failures
- Invalid arguments or malformed requests
- Backend control-plane resource missing (e.g., table/collection/script not deployed)
- Configuration errors

### Centralized Error Mapping

All backends MUST implement consistent error mapping to prevent implementation drift. Use these exact mappings:

```typescript
// Error mapping standard - backends MUST implement consistent classification
interface ErrorMappingStandard {
  // Classification rules for LockError codes (MUST throw LockError)
  mappingRules: {
    ServiceUnavailable: "Network failures, service unavailable, connection issues, infrastructure timeouts, transaction conflicts (ABORTED)";
    AuthFailed: "Authentication failures, authorization denied, credential issues";
    InvalidArgument: "Malformed requests, invalid parameters, data validation failures";
    RateLimited: "Rate limiting responses, quota exceeded, throttling";
    NetworkTimeout: "Client-side timeouts, network timeouts, operation timeouts";
    AcquisitionTimeout: "Retry loop exceeded timeoutMs (generated by auto API only)";
    Internal: "Unexpected backend errors, unclassified system failures, unknown conditions (includes rare backend limit scenarios)";
  };

  // Domain outcome reasons for telemetry (exact strings required for events)
  telemetryReasons: ["expired", "not-found"]; // MUST use only these strings for *-failed events
  acquisitionReasons: ["locked"]; // MUST use only this string for acquire contention
}
```

**Backend Implementation Requirements**:

- Backends MUST map their specific errors according to the classification rules above
- Error mapping should follow the spirit of each category rather than exact string matching
- Backend specs SHOULD include mapping examples but focus on error categories
- Use this standard to ensure consistent error handling across all implementations

### Error Reporting

- **Lock Contention**: Return `{ ok: false, reason: "locked" }` from acquire operations
- **Acquisition Timeout**: Throw `LockError("AcquisitionTimeout")` when retry loop exceeds `timeoutMs`
- **System Failures**: Throw `LockError` with descriptive message and specific error code
- **Mutation Failures**: Return simplified `{ ok: false }` from release/extend operations
- **Release Failures**: Use `onReleaseError` callback for system errors during release
- **Error Context**: Include relevant context (key, lockId, cause) in LockError instances
- **Retry Strategy**: The lock() helper implements configurable retry with exponential backoff and jitter. Backends do not implement retries.
- **Observability**: Emit `LockEvent` via `onEvent` callback for monitoring and diagnostics, with detailed telemetry reasons preserved in events

## Recommended Configuration (Getting Started)

For most applications, use these recommended defaults that provide robust behavior out of the box:

```typescript
// Recommended: Exponential backoff with equal jitter
const config = {
  key: "resource:123",
  ttlMs: 30_000, // 30 seconds
  acquisition: {
    maxRetries: 10, // Retry up to 10 times
    retryDelayMs: 100, // Start with 100ms
    backoff: "exponential", // Double delay each attempt
    jitter: "equal", // Add 50% random jitter
    timeoutMs: 5_000, // Give up after 5 seconds
  },
};
```

**Why these defaults work well:**

- **Exponential backoff**: Quickly backs off from contention
- **Equal jitter**: Prevents thundering herd while maintaining predictable timing
- **Reasonable timeout**: Balances responsiveness with persistence

**Note**: The lock() helper uses exponential backoff with equal jitter (50% randomization) by default. This provides the best balance between predictability and collision avoidance. Advanced users can configure fixed backoff if needed.

## Performance Requirements

**MUST implement**: AbortSignal support for cancellation

**Guidance** (target latencies, not requirements):

- **Acquire/IsLocked**: < 10ms local, < 50ms remote
- **Release/Extend**: < 20ms acceptable
- **Redis**: 1000+ ops/sec, **Firestore**: 100-500 ops/sec

**MUST optimize**: Memory usage (< 1KB per active lock), efficient connection pooling

**No fairness guarantees**: Lock acquisition order is not specified. Clients MUST handle arbitrary patterns.

### Diagnostic Interface Requirements

- **lookup SLA**: Core `lookup()` always returns sanitized data (hash IDs only); use `lookupDebug()` helper for raw key/lockId access; MUST include `fence` when `backend.capabilities.supportsFencing === true`; response is eventually consistent
- **Read-only**: `lookup` MUST be read-only and MUST NOT mutate TTL or update timestamps
- **Performance**: lookup operations SHOULD be fast but MAY be slower than core lock operations
- **Availability**: Required interface - all backends MUST implement this functionality for operability
- **Dual Lookup**: MUST support both key-based and lockId-based queries for ownership checking
- **Consistency Model**: Redis achieves intra-lookup consistency via atomic scripts; Firestore prevents wrong-doc returns via post-read lockId verification; both eliminate races within lookup operations while maintaining eventually consistent semantics across the system

## Ownership Checking

### ✅ **Official Ownership Check Methods**

**Recommended: Use the explicit helper function**:

```typescript
import { owns } from "syncguard";
const owned = await owns(backend, lockId);
```

**Alternative: Direct method for advanced cases**:

```typescript
const owned = !!(await backend.lookup({ lockId }));
```

**Why this is the preferred approach**:

- **Read-only**: No side effects or TTL mutations
- **Clear semantics**: Returns lock info or null
- **Optimizable**: Backends can optimize specifically for ownership checks
- **Extensible**: Can return additional metadata without affecting mutations

**CRITICAL: Not a Pre-Mutation Guard**:

- lookup() is for diagnostics and read-only ownership checks
- NEVER use `lookup() → mutate` patterns as safety guards
- For critical sections, rely on fencing tokens and idempotent mutation results
- Mutations (release/extend) provide authoritative state via their return values

### ✅ **Idempotent Operations**

**extend() and release() are idempotent and safe to call without ownership**:

```typescript
// Safe to call even if not owned - operations are idempotent
const extendResult = await backend.extend({ lockId, ttlMs });
if (!extendResult.ok) {
  // Handle not-owned case: lock was absent (expired or never existed)
  // For detailed diagnostics, use the withTelemetry() decorator
}

const releaseResult = await backend.release({ lockId });
if (!releaseResult.ok) {
  // Handle not-owned case: lock was absent (expired or never existed)
  // For detailed diagnostics, use the withTelemetry() decorator
}
```

**Benefits of explicit idempotency**:

- Safe to call without pre-checking ownership
- Structured error responses for debugging
- No risk of accidental damage
- Eliminates need for "probe by mutating" anti-patterns

## Validation Helpers

### Runtime Validation Helpers

#### `validateLockId(lockId: string): void`

**Client-side validation helper for immediate feedback**:

```typescript
export function validateLockId(lockId: string): void {
  if (typeof lockId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(lockId)) {
    throw new LockError(
      "InvalidArgument",
      `Invalid lockId format. Expected 22 base64url characters, got: ${lockId}`,
    );
  }
}
```

#### `normalizeAndValidateKey(key: string): string`

**Key normalization and validation helper**:

```typescript
export function normalizeAndValidateKey(key: string): string {
  if (typeof key !== "string") {
    throw new LockError("InvalidArgument", "Key must be a string");
  }

  const normalized = key.normalize("NFC");
  const utf8Bytes = new TextEncoder().encode(normalized);

  if (utf8Bytes.length > MAX_KEY_LENGTH_BYTES) {
    throw new LockError(
      "InvalidArgument",
      `Key exceeds maximum length of ${MAX_KEY_LENGTH_BYTES} bytes after normalization`,
    );
  }

  return normalized;
}
```

**Usage patterns**:

```typescript
// Validate lockId before backend operations
validateLockId(userProvidedLockId); // Immediate feedback
await backend.release({ lockId: userProvidedLockId });

// Validate and normalize keys before backend operations
const normalizedKey = normalizeAndValidateKey(userKey); // Fail fast on invalid keys
await backend.acquire({ key: normalizedKey, ttlMs: 30000 });

// Defensive programming in application code
function storeLockId(lockId: string) {
  validateLockId(lockId); // Fail fast on format issues
  localStorage.setItem("currentLock", lockId);
}
```

**Benefits**:

- **Immediate feedback**: Catches format errors before network round-trip
- **Better DX**: Clear error messages at call site vs backend failures
- **Composable**: Can be used independently in application code
- **Discoverable**: Makes format requirements explicit and self-documenting
- **Error classification**: Separates client validation from backend/system errors

## Retry Strategy Specification

### Scope

The retry strategy is implemented by the auto API helper `lock()`. Backends MUST NOT implement acquisition retries.

### Algorithm Formulas

The `lock()` helper MUST implement retry strategies using these exact formulas for consistency:

#### Exponential Backoff (default)

```javascript
// Base delay calculation (attemptNumber is 1-based; first failed attempt uses attemptNumber = 1)
// attemptNumber is 1-based and MUST be capped by maxRetries and timeoutMs
baseDelay = retryDelayMs * Math.pow(2, attemptNumber - 1);

// With equal jitter (default)
actualDelay = baseDelay / 2 + Math.random() * (baseDelay / 2);

// With full jitter
actualDelay = Math.random() * baseDelay;

// With no jitter
actualDelay = baseDelay;

// Before sleeping, clamp actualDelay so elapsedTime + actualDelay <= timeoutMs
actualDelay = Math.min(actualDelay, Math.max(0, timeoutMs - elapsedTime));
if (actualDelay === 0)
  throw new LockError("AcquisitionTimeout", "Acquire exceeded timeoutMs");
```

#### Fixed Backoff

```javascript
// With equal jitter
actualDelay = retryDelayMs / 2 + Math.random() * (retryDelayMs / 2);

// With full jitter
actualDelay = Math.random() * retryDelayMs;

// With no jitter
actualDelay = retryDelayMs;

// Before sleeping, clamp actualDelay so elapsedTime + actualDelay <= timeoutMs
actualDelay = Math.min(actualDelay, Math.max(0, timeoutMs - elapsedTime));
if (actualDelay === 0)
  throw new LockError("AcquisitionTimeout", "Acquire exceeded timeoutMs");
```

// Apply normal backoff + equal jitter (50% randomization)
baseDelay = retryDelayMs _ Math.pow(2, attemptNumber - 1);
actualDelay = baseDelay / 2 + Math.random() _ (baseDelay / 2);

// Always respect timeout
actualDelay = Math.min(actualDelay, Math.max(0, timeoutMs - elapsedTime));
if (actualDelay === 0)
throw new LockError("AcquisitionTimeout", "Acquire exceeded timeoutMs");

```

## Testing Requirements

### Unit Test Coverage

#### Backend Implementation Tests

- All four operations (acquire, release, extend, isLocked)
- Error handling for both transient and permanent failures
- Configuration validation and merging
- Edge cases (expired locks, invalid lock IDs, etc.)

#### Lock Function Tests

- Automatic lock management lifecycle
- Release error handling with and without callbacks
- Function error propagation
- Backward compatibility

### Integration Test Requirements

- Real backend connectivity and operations
- Concurrent access patterns and race condition handling
- TTL expiration and cleanup behavior
- Performance under load

### Cross-Backend Consistency Requirements

- **Behavioral Equivalence**: Test suites MUST verify that both Redis and Firestore backends produce identical results for the same scenarios (accounting for time authority differences)
- **Error Mapping Consistency**: Verify that equivalent error conditions map to the same `LockError` codes across backends
- **Expired vs Not-Found**: Test that both backends follow the exact semantic rules for distinguishing expired from not-found states
- **Fence Token Consistency**: Verify fence tokens increment monotonically and follow the 19-digit zero-padded format across backends
- **Time Authority Awareness**: Tests MUST account for different time authority models when comparing cross-backend behavior
- **Event Consistency**: Verify that both backends emit structurally equivalent events for the same operations

### Fence Token Conformance Requirements

All backend implementations MUST include these specific fence token tests:

- **Format Invariant**: Every returned fence MUST match `/^\d{19}$/` regex (exactly 19 digits)
- **Monotonicity Invariant**: For sequential acquisitions A then B on the same key, `fenceA < fenceB` (string comparison)
- **Cross-Backend Invariant**: Fence sequences from Redis vs Firestore backends MUST sort identically when compared as strings
- **Lexicographic Ordering**: Fence comparison using `>`, `<`, `===` operators MUST match chronological acquisition order
- **JSON Safety**: Fence values MUST serialize/deserialize through JSON without precision loss or format changes

### Mock Interface Standards

- Mock backends MUST implement full LockBackend interface
- Use controllable return values for testing error conditions
- Support both success and failure scenarios
- Enable testing of retry logic and timeout behavior

## Backend Implementation Checklist

When implementing a new backend, ensure:

- [ ] All four LockBackend operations implemented
- [ ] Required lookup operation implemented with key and lockId lookup support
- [ ] Atomic operations used for all mutations
- [ ] **CRITICAL: TOCTOU protection implemented** - release/extend operations execute resolve mapping, validate state, and perform mutation atomically within single transaction/script
- [ ] **CRITICAL: Explicit ownership verification** - after reverse mapping lookup, MUST verify `data.lockId === lockId` for defense-in-depth (ADR-003: prevents wrong-lock mutations via explicit verification)
- [ ] **CRITICAL: Unified liveness predicate** - MUST import and use `isLive()` from `common/time-predicates.ts` with appropriate time source - custom time logic is FORBIDDEN
- [ ] **LockId validation implemented** - validate format `^[A-Za-z0-9_-]{22}$` and throw `LockError("InvalidArgument")` for malformed input
- [ ] **Cleanup safety guards implemented** - if cleanup in isLocked, use safety buffer to prevent race conditions with extend operations
- [ ] Proper error classification using exact strings from ErrorMappingStandard
- [ ] TTL-based expiration handling with consistent Liveness Predicate
- [ ] Ownership verification in release/extend via lockId→key reverse mapping
- [ ] Required indexes/performance optimizations for fast lookups (e.g., Firestore lockId index, Redis script caching)
- [ ] **Idempotency documented** - extend/release operations clearly documented as safe to call without ownership
- [ ] **validateLockId() helper provided** - public utility function for client-side validation and better DX
- [ ] **Behavioral compliance testing** - tests MUST verify backend uses `isLive()` with appropriate time source and declared tolerance
- [ ] **Cross-backend consistency** - integration tests MUST verify identical API outcomes (ignoring telemetry differences)
- [ ] Comprehensive unit and integration tests
- [ ] Backend-specific configuration options documented
- [ ] Storage key limits documented with examples
- [ ] **Fence format standardized** - if fencing tokens supported, MUST return 19-digit zero-padded decimal strings; tests verify monotonicity and lexicographic ordering
- [ ] **Consistent hashing** - MUST use `hashKey()` from common utilities for all sanitized output
- [ ] Clear documentation of backend-specific requirements

## Versioning and Compatibility

### Interface Stability

- **LockBackend**: Core interface is stable, additions require major version bump
- **LockConfig**: New optional fields allowed in minor versions
- **Error Handling**: Changes to error behavior require major version bump

### Backward Compatibility

- Existing code MUST continue working without modification
- New features MUST be opt-in via configuration
- Deprecated features require advance warning and migration path

## Security Considerations

### Lock ID Security and Ownership

- lockId MUST be cryptographically strong (128+ bits entropy)
- lockId MUST be unique per acquisition (never reused)
- lockId MUST be verified atomically against stored owner
- lockId MUST NOT be predictable or sequential
- Use 16 bytes from a CSPRNG encoded as base64url (22 chars)

### Fencing Tokens

- All v1 backends (Redis, Firestore) MUST always include monotonic `fence` tokens in acquire results
- Fencing tokens provide protection against stale owner problems
- Applications SHOULD validate fence tokens when accessing guarded resources
- Higher fence numbers indicate more recent acquisitions
- All backends MUST return exactly 19-digit zero-padded decimal strings for fence values to enable direct string comparison and ensure consistent JSON serialization
- The 19-digit format accommodates Redis's signed 64-bit counter range (2^63-1)
- Backends SHOULD emit warnings when fence values exceed 9e18 to provide early operational signals
- Consider key namespace rotation if approaching the theoretical limit

### Key Namespace Best Practices

- Stored keys SHOULD be namespaced (e.g., `syncguard:{env}:{key}`) to avoid cross-app collisions
- Use environment-specific prefixes for multi-environment deployments
- Consider versioning in key names for schema evolution
- Avoid user-controlled content in key names to prevent injection attacks
- Backends MUST normalize keys to a canonical form (e.g., byte/string) and reject keys above 512 bytes to avoid DOS via huge keys
- Key length limits apply to the **byte length** of the normalized key

### TTL and Heartbeat Guidance

- `ttlMs` should be **short** (e.g., 10-60 seconds) to minimize impact of failed releases
- For long-running tasks, consider implementing periodic `extend()` calls rather than very long TTLs
- Future versions MAY provide `autoExtend: boolean` helper mode for automatic heartbeating

### Access Control

- Backends SHOULD support authentication/authorization
- Document security best practices for each backend
- Validate user-provided configuration for security issues
- Backends MAY honor `signal` to cancel in-flight RPCs; helpers SHOULD pass it through.

### Data Protection

- Never log sensitive information (credentials, user data)
- Use secure communication channels (TLS) for remote backends
- Follow principle of least privilege for backend permissions

## Architecture Decision Records

See [specs/adrs.md](adrs.md) for architectural decisions and design rationale.
```
