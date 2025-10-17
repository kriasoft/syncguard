# Common Lock Interface Specification

This document defines the core interface and behavioral requirements that all SyncGuard backend implementations must follow.

---

## Document Structure

This specification uses a **normative vs rationale** pattern:

- **Requirements** sections contain MUST/SHOULD/MAY/NEVER statements defining the contract
- **Rationale & Notes** sections provide background, design decisions, and operational guidance

**Backend Delta Pattern:**

Backend-specific specifications (redis-backend.md, postgres-backend.md, firestore-backend.md) extend this common interface specification. To enhance machine-parseability and prevent agent drift:

- Backend specs MUST restate key inherited requirements (e.g., authoritative expiresAtMs) in their operation requirement sections
- Restatements provide explicit MUST/SHOULD bullets in normative tables for agent parsing
- Cross-references to this specification (e.g., "see ADR-010") provide rationale without redundancy
- This pattern ensures agents can verify compliance from backend-specific operation tables alone

---

## Core Constants

### Requirements

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

- Backends MUST validate user-supplied key length after `key.normalize('NFC')` and UTF-8 encoding
- User keys exceeding `MAX_KEY_LENGTH_BYTES` MUST throw `LockError('InvalidArgument')`
- This limit applies to the user-supplied key before any backend-specific prefixing or namespacing
- Validation MUST occur before any lock operations (acquire, isLocked, etc.)

### Rationale & Notes

**Why 512 bytes**: Balances expressiveness with DoS protection. Prevents resource exhaustion from excessively large keys while accommodating complex namespacing patterns.

**Why normalize first**: Unicode NFC normalization ensures consistent byte length calculations across platforms and prevents ambiguous key matching.

---

## Standardized Storage Key Generation {#storage-key-generation}

### Requirements

**NORMATIVE IMPLEMENTATION**: See `makeStorageKey()` in `common/crypto.ts`

All backends MUST use the canonical `makeStorageKey()` function from common utilities. Custom implementations are FORBIDDEN.

**Hash Truncation Algorithm** (when key exceeds backend limits):

1. **Compute SHA-256**: Hash the full prefixed key `<prefix + ':' + normalizedKey>` using SHA-256 (produces 256-bit/32-byte digest)
2. **Truncate to 128 bits**: Take the **first 16 bytes** of the SHA-256 digest (big-endian byte order)
3. **Encode as base64url**: Convert the 16-byte truncated digest to base64url encoding (no padding) → 22 characters
4. **Construct storage key**: Combine as `<prefix + ':' + base64url_hash>` or just `<base64url_hash>` if no prefix

**Collision Resistance**: The 128-bit truncated digest provides ~2.8e-39 collision probability at 10^9 distinct keys.

**Function Characteristics:**

- **Byte-accurate limits**: Measures UTF-8 byte length, not string length
- **Reserve capacity**: Accounts for derived key suffixes (fence, index) via `reserveBytes` parameter
- **Namespace-safe**: Hashes full prefixed key to prevent cross-prefix collisions
- **Deterministic**: Same inputs always produce same output
- **Compact encoding**: Base64url format (22 chars for 128-bit hash vs. 32 for hex)
- **Defensive normalization**: Applies Unicode NFC normalization for canonical hashing
- **Fail-fast validation**: Throws if prefix + reserve makes valid keys impossible

**Backend-Specific Parameters:**

- **Redis**: 26 bytes reserve (`":id:" (4) + lockId (22) = 26`) for dual-key storage pattern
- **Firestore**: 0 bytes reserve (independent document IDs for all key types)
- See `RESERVE_BYTES` and `BACKEND_LIMITS` constants in `common/constants.ts`

**Storage Key Limits:**

When the prefixed storage key `prefix:userKey` exceeds the backend's storage limit, backends MUST apply the standardized hash-truncation scheme. Backends MUST throw `LockError('InvalidArgument')` only if even the truncated form exceeds the backend's absolute limit (e.g., prefix too long).

### Rationale & Notes

**Why centralized function**: Single implementation ensures cross-backend consistency. Prevents subtle bugs from implementation drift.

**Why hash truncation**: Allows predictable behavior across backends. Same user key produces same storage key regardless of backend, enabling consistent testing and debugging.

**Why reserve bytes**: Different backends have different derived key patterns. Redis needs suffix space for index keys, Firestore uses independent document IDs. Reserve parameter makes this explicit.

---

## Two-Step Fence Key Derivation Pattern {#fence-key-derivation}

### Requirements

**NORMATIVE SPECIFICATION**: To ensure 1:1 mapping between lock keys and fence counters, ALL backends MUST use this two-step derivation pattern:

```typescript
// Step 1: Compute base storage key for the lock
const baseKey = makeStorageKey(
  prefix,
  normalizedUserKey,
  backendLimit,
  reserveBytes,
);

// Step 2: Derive fence key from the base storage key
const fenceKey = makeStorageKey(
  prefix,
  `fence:${baseKey}`,
  backendLimit,
  reserveBytes,
);
```

**Critical Requirement**: Fence keys MUST be derived from the **base storage key** (not directly from the user key).

**Application**: This pattern applies to:

- **Main lock keys**: Direct use of `baseKey = makeStorageKey(prefix, userKey, limit, reserve)`
- **Reverse index keys**: `indexKey = makeStorageKey(prefix, 'id:${lockId}', limit, reserve)` (independent of baseKey)
- **Fence counter keys**: `fenceKey = makeStorageKey(prefix, 'fence:${baseKey}', limit, reserve)` (derived from baseKey)

**Backend Implementation Mandate**: All backend specifications reference this normative pattern; backends MUST NOT implement custom key derivation logic.

### Rationale & Notes

**Why two-step derivation**: Ensures that when truncation occurs, both lock and fence keys hash the user key identically. This guarantees each distinct user key maps to a unique fence counter.

**Without this pattern**: Different user keys could map to the same fence counter when hash truncation occurs, violating the monotonicity guarantee for fencing tokens.

**1:1 mapping guarantee**: Critical for fence token correctness. Each resource must have its own independent counter to maintain strict ordering.

---

## Public Types (Normative)

This section defines the **normative type shapes** for SyncGuard's public API. These types establish the contract that all implementations MUST follow.

**TypeScript Reference Implementation**: See `common/types.ts` for the canonical TypeScript definitions that implement this specification.

### Hash Identifier Format

```typescript
type Hash = string; // 24-character hex string (96-bit non-cryptographic hash)
```

**Requirements:**

- **Algorithm**: Triple-hash (3×32-bit) for 96-bit collision resistance
- **Encoding**: Lowercase hexadecimal, exactly 24 characters
- **Normalization**: Input MUST be Unicode NFC normalized before hashing
- **Collision Probability**: ~6.3e-12 at 10^9 distinct keys
- **Canonical Implementation**: `hashKey()` in `common/crypto.ts`
- **Use Case**: Sanitized identifiers for telemetry, logging, and UI (non-cryptographic)

**Security Note**: This is a **non-cryptographic hash** for observability only. Do NOT use for security-sensitive collision resistance.

---

### Lock Information Types

#### LockInfo (Sanitized Output)

```typescript
interface LockInfo<C extends BackendCapabilities> {
  keyHash: Hash; // 24-char hex hash of the key
  lockIdHash: Hash; // 24-char hex hash of the lockId
  expiresAtMs: number; // Unix timestamp (milliseconds)
  acquiredAtMs: number; // Unix timestamp (milliseconds)
  fence?: Fence; // Present when C["supportsFencing"] === true
}
```

**Requirements:**

- All `lookup()` operations MUST return this sanitized shape (never raw keys/lockIds)
- `keyHash` and `lockIdHash` MUST be computed via `hashKey()` from `common/crypto.ts`
- `expiresAtMs` and `acquiredAtMs` MUST be Unix timestamps in milliseconds
- `fence` MUST be included if and only if `backend.capabilities.supportsFencing === true`
- Returns `null` for both expired and not-found locks (no distinction in public API)

**Rationale**: Prevents accidental logging of sensitive identifiers. Security-first design with compile-time guarantees.

---

#### LockInfoDebug (Raw Identifiers for Debugging)

```typescript
interface LockInfoDebug<C extends BackendCapabilities> extends LockInfo<C> {
  key: string; // Raw user-provided key (SENSITIVE)
  lockId: string; // Raw lock identifier (SENSITIVE)
}
```

**Requirements:**

- Available ONLY via `getByKeyRaw()` and `getByIdRaw()` helper functions (NOT from `backend.lookup()`)
- MUST include all fields from `LockInfo<C>` plus raw identifiers
- **SECURITY WARNING**: Contains sensitive data - use only for debugging/diagnostics

**Rationale**: Explicit opt-in for raw data access. Prevents accidental exposure in production logs.

---

### Telemetry Event Types

```typescript
type LockEvent = {
  type: "acquire" | "release" | "extend" | "isLocked" | "lookup";
  result: "ok" | "fail";
  keyHash?: Hash; // Present when operation involves a key
  lockIdHash?: Hash; // Present when operation involves a lockId
  reason?: "locked" | "expired" | "not-found";
  key?: string; // Raw key (only when includeRaw permits)
  lockId?: string; // Raw lockId (only when includeRaw permits)
};
```

**Requirements:**

- Emitted by `withTelemetry()` decorator when telemetry is enabled
- `type` MUST be one of the five core operations
- `result` MUST be either "ok" (success) or "fail" (failure)
- `keyHash`/`lockIdHash` computed lazily only when telemetry active (zero-cost when disabled)
- `reason` field semantics:
  - **"locked"**: Acquire failed due to contention (key already held)
  - **"expired"**: Operation failed because lock expired before mutation
  - **"not-found"**: Operation failed because lock doesn't exist
- `key` and `lockId` raw fields MUST only be present when `includeRaw` configuration permits
- Telemetry callbacks MUST NOT be awaited; errors MUST NOT affect lock operations (async isolation)

**Operation-Specific Reason Values:**

| Operation  | Success (`ok: true`) | Failure (`ok: false`) Reasons |
| ---------- | -------------------- | ----------------------------- |
| `acquire`  | No reason            | `"locked"`                    |
| `release`  | No reason            | `"expired"` \| `"not-found"`  |
| `extend`   | No reason            | `"expired"` \| `"not-found"`  |
| `isLocked` | No reason            | No reason (boolean result)    |
| `lookup`   | No reason            | No reason (null result)       |

**Rationale**:

- Detailed reasons for operational monitoring without cluttering public API
- "expired" vs "not-found" distinction helps diagnose cleanup lag vs logic errors
- Zero-cost abstraction when telemetry disabled (no hash computation overhead)

---

## Backend Capabilities

### Requirements

```typescript
// Backend capability declaration for type-safe feature detection
interface BackendCapabilities {
  supportsFencing: boolean; // Whether backend generates fence tokens
  timeAuthority: "server" | "client"; // Time authority model used
}
```

All backends MUST declare their capabilities for compile-time type safety and runtime introspection.

### Rationale & Notes

**Compile-time benefits**: TypeScript can enforce presence/absence of optional fields (e.g., fence tokens) based on capabilities.

**Runtime introspection**: Applications can query capabilities to adapt behavior or provide appropriate warnings.

---

## LockBackend Interface

### Requirements

```typescript
// Base operation types for consistent parameter patterns
type KeyOp = Readonly<{ key: string; signal?: AbortSignal }>;
type LockOp = Readonly<{ lockId: string; signal?: AbortSignal }>;

// Lookup operation types
type KeyLookup = {
  key: string; // O(1) direct access
  signal?: AbortSignal;
};

type OwnershipLookup = {
  lockId: string; // reverse lookup + verification
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
```

**Lookup Invariants:**

- Always returns sanitized data (keyHash/lockIdHash, never raw keys/lockIds)
- Consistent return shape regardless of lookup method (key vs lockId)
- Prevents accidental logging of sensitive identifiers
- Includes expiresAtMs and acquiredAtMs timestamps (Unix ms)
- Includes fence when backend.capabilities.supportsFencing === true
- Returns null for both expired and not-found locks (no distinction)
- For raw key/lockId access, use `getByKeyRaw()`/`getByIdRaw()` helper functions

**CRITICAL SANITIZATION REQUIREMENT:**

- Implementations MUST sanitize data before returning from public lookup() methods
- Internal/raw transport (e.g., Lua script returns, internal JSON) is an implementation detail
- Raw keys/lockIds MUST NEVER surface to users through the public API
- Only sanitized keyHash/lockIdHash via hashKey() may be exposed
- Violation of this requirement is a security and API contract failure

### Rationale & Notes

**Why discriminated overloads**: Provides compile-time safety and better IntelliSense. TypeScript enforces correct parameter combinations.

**Why sanitized by default**: Prevents accidental logging of sensitive identifiers. Security-first design.

**Why lookup is required**: Essential for ownership checking, diagnostics, and operational monitoring. Not an optional feature.

---

## Result Types

### Requirements

```typescript
// Success or Contention only (acquisition timeout throws LockError)
export type AcquireOk<C extends BackendCapabilities> = {
  ok: true;
  lockId: string;
  expiresAtMs: number;
} & (C["supportsFencing"] extends true ? { fence: Fence } : {});

export type AcquireResult<C extends BackendCapabilities> =
  | AcquireOk<C>
  | {
      ok: false;
      reason: "locked";
    };

// Simplified release/extend results
export type ReleaseResult =
  | { ok: true } // release success never includes expiresAtMs
  | { ok: false }; // lock was absent (expired or never existed)

export type ExtendResult =
  | { ok: true; expiresAtMs: number } // expiresAtMs required for heartbeat scheduling
  | { ok: false }; // lock was absent (expired or never existed)
```

**Fence Token Compile-Time Guarantee**: Fence tokens are required in the type system when `backend.capabilities.supportsFencing === true`. All v1 backends (Redis, PostgreSQL, Firestore) provide fencing tokens. Non-fencing backends are out of scope for v1.

**Time fields:** All core types use `expiresAtMs` / `acquiredAtMs` (Unix ms) for consistency and wire/JSON optimization. Helper utilities MAY provide Date conversion when convenient for consumers.

**Simplified Semantics:** With lockId-only operations, ownership conflicts cannot occur since each lockId maps to exactly one key via reverse mapping. Failed operations indicate the lock was absent for any reason.

### Rationale & Notes

**Why compile-time fence**: Eliminates runtime assertions for backends that always provide fencing. Better developer experience.

**Why simplified results**: Public API focuses on success/failure. Internal conditions (expired vs not-found) tracked cheaply for telemetry but not exposed in primary API.

**Why expiresAtMs in extend**: Critical for heartbeat scheduling. Callers need to know exact expiry to schedule next extend operation.

---

## Resource Management (Optional)

Acquire results MAY implement `AsyncDisposable` for automatic cleanup with `await using` syntax (Node.js ≥20).

### Requirements

- Disposal MUST be idempotent (safe to call multiple times)
- Disposal MUST NOT throw (errors routed to optional `onReleaseError` callback)
- When `ok: true`: disposal delegates to `release({ lockId })`
- When `ok: false`: disposal is a no-op

### Handle Methods

Successful acquisitions (`ok: true`) provide handle methods for manual control:

```typescript
interface DisposableLockHandle {
  release(signal?: AbortSignal): Promise<ReleaseResult>;
  extend(ttlMs: number, signal?: AbortSignal): Promise<ExtendResult>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

- Both `release()` and `extend()` accept optional `AbortSignal` for operation cancellation
- Signal parameters maintain API consistency with backend methods (`release(opts: LockOp)`, `extend(opts: LockOp & { ttlMs })`)
- Methods forward signals to backend operations for responsive cancellation
- Per-operation signal control enables independent cancellation of different operations

### Configuration

Error callbacks can be configured at two levels:

- **Backend-level**: `createBackend({ onReleaseError })` - applies to `await using` disposal
- **Lock-level**: `lock({ onReleaseError })` - applies to `lock()` helper cleanup

These are independent configurations for different usage patterns. See `common/disposable.ts` for usage examples.

### Runtime Support

`await using` requires Node.js ≥20. For older runtimes, use `try/finally` patterns.

### Rationale & Notes

**Why optional**: Additive feature that doesn't change existing contracts. Enhances DX without breaking compatibility.

**Why dual configuration**: Backend-level suits low-level `await using` API; lock-level suits high-level `lock()` helper. Users typically choose one pattern.

**Why idempotent**: Safe disposal on all code paths, including early returns and exceptions.

---

## Fence Token Format

### Requirements

```typescript
// Fencing token types
export type Fence = string; // Fixed-width decimal strings with lexicographic ordering
```

**Format Contract:**

- 15-digit zero-padded decimal strings (e.g., "000000000000001")
- Higher fence values are lexicographically larger strings
- Use direct string comparison: `fenceA > fenceB`, `fenceA === fenceB`
- All backends use identical 15-digit zero-padded format

**Overflow Enforcement:**

- Backends MUST throw LockError("Internal") if fence > `FENCE_THRESHOLDS.MAX`
- Backends MUST log warnings via `logFenceWarning()` when fence > `FENCE_THRESHOLDS.WARN`
- Canonical threshold values are defined in `common/constants.ts` as `FENCE_THRESHOLDS.MAX` and `FENCE_THRESHOLDS.WARN`

**Rationale:** Fence format and overflow guard are defined by ADR-004; this document normatively references that ADR.

### Fence Token Usage Patterns

#### ✅ Correct Usage

```typescript
// Compare fence tokens using lexicographic string comparison
// IMPORTANT: Don't parse - compare as strings only (per ADR-004)
const newer = fenceA > fenceB;
const same = fenceA === fenceB;
const older = fenceA < fenceB;

// Store/transmit as strings (JSON-safe, no precision loss)
localStorage.setItem("lastFence", fence);
await api.updateResource({ fence });

// Sort fences lexicographically
const sortedFences = fences.sort(); // Lexicographic = chronological order
```

#### ❌ Avoid These Patterns

```typescript
// DON'T: Parse as numbers (not needed and may lose precision)
const num = parseInt(fence); // ❌ Unnecessary

// DON'T: Modify the format (breaks ordering)
const trimmed = fence.replace(/^0+/, ""); // ❌ Breaks comparison
```

### Rationale & Notes

**Why strings**: JSON-safe, cross-language compatible, no precision loss. All platforms can compare strings lexicographically.

**Why 15 digits**: Guarantees full safety within Lua's 53-bit precision (2^53-1 ≈ 9.007e15). Provides 10^15 capacity = ~31.7 years at 1M locks/sec.

**Why lexicographic**: Simplest possible API. One comparison rule instead of helper functions. Matches developer intuition.

**See ADR-004** for complete rationale on format choice and precision safety requirements.

---

## Unified Time Handling and Liveness Predicate {#time-authority}

### Requirements

**Critical Requirement**: All backends MUST use the unified liveness predicate with internal constants to ensure consistent behavior across implementations.

**Single Liveness Predicate:**

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
// **NORMATIVE SOURCE**: This constant is the single source of truth for time tolerance.
// All backend specifications and ADRs reference this definition.
export const TIME_TOLERANCE_MS = 1000; // 1000ms - safe for all backends and time authorities
```

**Authoritative ExpiresAtMs in Mutations:**

All backend mutation operations (acquire, extend) MUST return server-authoritative `expiresAtMs` computed from the backend's designated time source. Backends MUST NOT approximate expiry time using client-side calculations (e.g., `Date.now() + ttlMs`). This ensures:

- **Accurate heartbeat scheduling**: Callers can schedule next extend operation based on authoritative server time
- **Time authority consistency**: All timestamps originate from the same time source (server or client) declared in `capabilities.timeAuthority`
- **No approximation drift**: Eliminates accumulating errors from repeated client-side calculations

**Time Authority Models:**

Backends use different time sources but the same liveness predicate with internal constants:

#### Server Time Authority (Redis)

- **Time Source**: Redis server time via `redis.call('TIME')`
- **Tolerance**: See `TIME_TOLERANCE_MS` constant above (single source of truth)
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
- **Tolerance**: See `TIME_TOLERANCE_MS` constant above (single source of truth)
- **Requirements**: NTP synchronization recommended for production

```typescript
// Firestore implementation pattern
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";

const nowMs = Date.now();
const live = isLive(storedExpiresAtMs, nowMs, TIME_TOLERANCE_MS);
```

**Consistent Behavior Across Backends:**

All backends use `TIME_TOLERANCE_MS` for identical liveness semantics:

```typescript
// Consistent behavior - both backends use TIME_TOLERANCE_MS
const redisBackend = createRedisBackend(); // Uses TIME_TOLERANCE_MS
const firestoreBackend = createFirestoreBackend(); // Uses TIME_TOLERANCE_MS
```

### Implementation Requirements {#time-implementation-requirements}

- **Single Predicate**: ALL backends MUST use `isLive()` from `common/time-predicates.ts` across ALL operations
- **No Custom Logic**: Custom time logic implementations are FORBIDDEN
- **Unified Tolerance**: Backends MUST use `TIME_TOLERANCE_MS` constant from `common/time-predicates.ts`
- **Capability Declaration**: Backends MUST expose `timeAuthority` in capabilities
- **Time Consistency**: All timestamps MUST use the backend's designated time authority
- **Cross-Backend Testing**: Test suites MUST verify identical outcomes with unified tolerance

### Rationale & Notes

**Why unified tolerance**: Eliminates confusion. "Strict" mode was misleading - didn't mean the same thing across backends. See ADR-005 for detailed rationale.

**Why single predicate**: Prevents implementation drift. Ensures all backends make identical liveness decisions given same timestamps.

**Why not user-configurable**: Operational consistency and testing simplicity outweigh flexibility. Expert users can fork if needed.

---

## Time Authority Tradeoffs {#time-authority-tradeoffs}

Different backends use different time authorities, each with distinct operational characteristics. This section provides guidance for choosing and operating backends based on time authority models.

### Comparison Matrix

| Aspect                      | Redis (Server Time)                       | Firestore (Client Time)                   |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Time Source**             | Redis server `TIME` command               | Client `Date.now()`                       |
| **Consistency**             | High - single time source                 | Lower - multi-client clocks               |
| **Clock Skew Risk**         | Minimal - single server clock             | Significant - requires NTP                |
| **NTP Requirements**        | None - client clocks irrelevant           | **CRITICAL** - all clients MUST sync      |
| **Determinism**             | Full - all clients see same time          | Variable - depends on client sync         |
| **Single Point of Failure** | Redis server clock                        | Distributed - each client independent     |
| **Clock Sync Monitoring**   | Optional - low risk                       | **MANDATORY** - fail deployments on drift |
| **Ideal Use Cases**         | High consistency, controlled environments | Distributed clients, NTP-synced fleets    |
| **When to Avoid**           | Redis cluster clock issues (rare)         | Unreliable NTP, IoT/edge devices          |

### Operational Checklists

#### Redis (Server Time Authority) Operations

**Pre-Production:**

- ✅ Verify Redis server has stable system clock
- ✅ Monitor Redis server time via health checks (optional but recommended)
- ✅ Document Redis server timezone and time source for ops team

**Production Monitoring:**

- ✅ Alert on Redis server restarts (time continuity check)
- ✅ Monitor lock acquisition/release patterns for anomalies
- ✅ No client-side clock monitoring needed

**Migration Considerations:**

- ✅ When moving to Redis cluster, verify all nodes use synchronized time
- ✅ Test lock behavior during Redis failover scenarios

**Failure Scenarios & Mitigations:**

- **Redis server clock jumps backward**: Locks may appear expired prematurely
  - _Mitigation_: Use NTP on Redis server, monitor system time jumps
- **Redis server clock drift**: Lock expiry becomes less predictable
  - _Mitigation_: Standard NTP sync on Redis host (typical target: ±100 ms accuracy)
- **Clock sync issues in Redis cluster**: Different nodes disagree on lock state
  - _Mitigation_: Ensure cluster nodes share time source, test failover behavior

#### Firestore (Client Time Authority) Operations

**Pre-Production:**

- ✅ **MANDATORY**: Deploy NTP synchronization on ALL clients
- ✅ **MANDATORY**: Implement NTP sync monitoring in deployment pipeline per [Firestore Clock Synchronization Requirements](firestore-backend.md#firestore-clock-sync-requirements)
- ✅ **MANDATORY**: Add application health checks to detect clock skew
- ✅ Test lock behavior with simulated clock skew scenarios

**Production Monitoring:**

- ✅ **CRITICAL**: Monitor client clock drift via system metrics per [Firestore Clock Synchronization Requirements](firestore-backend.md#firestore-clock-sync-requirements)
- ✅ Track lock contention patterns (may indicate clock skew issues)
- ✅ Monitor lock acquisition failures and correlate with client time drift

**Migration Considerations:**

- ✅ When adding new client types, verify NTP support and sync quality
- ✅ Test multi-region deployments with simulated clock skew
- ✅ Consider Redis backend if client time sync cannot be guaranteed

**Failure Scenarios & Mitigations:**

- **Client clock skew exceeds safety margin**: Lock safety violations, race conditions
  - _Mitigation_: MANDATORY NTP sync, deployment checks per [Firestore Clock Synchronization Requirements](firestore-backend.md#firestore-clock-sync-requirements)
- **One client's clock ahead**: May see other clients' locks as expired early
  - _Mitigation_: TIME_TOLERANCE_MS (1000 ms) provides safety margin; enforce operational policy ladder
- **One client's clock behind**: May fail to acquire locks when they're actually free
  - _Mitigation_: Clock monitoring alerts per operational policy, automated remediation
- **NTP service outage**: Gradual clock drift across clients
  - _Mitigation_: Monitor NTP health, alert on sync failures, consider Redis fallback

### Backend Selection Guidelines

**Choose Redis (Server Time) when:**

- You need maximum consistency and deterministic lock behavior
- All clients connect to same Redis instance/cluster
- You control the Redis server environment
- Client-side time sync is unreliable or unavailable
- Simplicity in operations is a priority

**Choose Firestore (Client Time) when:**

- You already use Firestore and can guarantee NTP sync across all clients
- You need globally distributed lock backend
- You have robust NTP infrastructure and monitoring
- Your deployment pipeline can enforce clock sync requirements
- You can afford the operational overhead of client clock monitoring

**When time authority might fail - consider these alternatives:**

- **Redis server clock issues**: Switch to Redis Cluster with time-synced nodes
- **Unreliable client NTP**: Switch to Redis backend for centralized time authority
- **Global distribution needs**: Use Firestore with strict NTP requirements
- **Hybrid approach**: Use Redis for high-consistency locks, Firestore for lower-stakes coordination

---

## Telemetry and Observability (Optional) {#telemetry-semantics}

### Requirements

**Telemetry Model**: Telemetry is **opt-in** via the `withTelemetry()` decorator. Core backends do NOT emit events or compute hashes. When telemetry is enabled, the decorator wraps backend operations and emits `LockEvent` for monitoring and diagnostics.

**Enabling Telemetry**:

```typescript
import { withTelemetry } from "syncguard/common";

const backend = createRedisBackend(config);
const telemetryBackend = withTelemetry(backend, {
  onEvent: (event) => console.log(event),
  includeRaw: false, // default: only emit sanitized hashes
});
```

**Core Backend Responsibilities**: Backends MAY track internal conditions (expired vs not-found) when cheaply available but SHOULD NOT compute hashes or construct event payloads. This internal tracking is consumed by the telemetry decorator when enabled.

**Internal Condition Tracking (Best-Effort):**

Backends MAY track internal conditions cheaply for consumption by telemetry decorators:

| Internal Condition | Public API Result | Available for Telemetry                 |
| ------------------ | ----------------- | --------------------------------------- |
| Success            | `{ ok: true }`    | Always                                  |
| Observable expiry  | `{ ok: false }`   | When cheaply detectable → `"expired"`   |
| Not found/other    | `{ ok: false }`   | When cheaply detectable → `"not-found"` |
| Unknown/ambiguous  | `{ ok: false }`   | No detail provided                      |

**Important**: Backends MUST NOT perform additional I/O solely to distinguish failure reasons.

**Implementation Guidance:**

- **Core Backends**: Return simple `{ ok: boolean }` results, track cheap internal details
- **Telemetry Decorator**: Wraps backend via `withTelemetry()`, emits events with hashes and reasons when configured
- **Async Isolation**: Event callbacks within the decorator MUST NOT be awaited; errors MUST NOT affect lock operations

### Rationale & Notes

**Why opt-in**: Zero-cost abstraction when disabled. No performance impact for applications that don't need telemetry.

**Why decorator pattern**: Clean separation of concerns. Core backends focus on correctness, telemetry is a composable layer.

**Benefits When Enabled:**

- **"expired" events**: Indicate cleanup lag or time synchronization issues
- **"not-found" events**: Indicate normal cleanup, ownership conflicts, or missing locks
- **Zero-cost abstraction**: No performance impact when telemetry is disabled

**See ADR-007** for complete rationale on opt-in telemetry design.

---

## Error Handling

### Requirements

```typescript
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
      | "Aborted" // raised when operation is cancelled via AbortSignal
      | "Internal",
    message?: string,
    public context?: { key?: string; lockId?: string; cause?: unknown },
  ) {
    super(message ?? code);
    this.name = "LockError";
  }
}
```

### Error Handling Patterns

SyncGuard provides multiple complementary mechanisms for error handling. Choose the patterns that match your application's needs.

#### Pattern 1: Simple Error Handling

For basic applications, use try/catch for acquisition errors and the `onReleaseError` callback for disposal errors:

```typescript
try {
  await using lock = await backend.lock("key", {
    onReleaseError: (err, ctx) => {
      logger.error("Failed to release lock", {
        error: err,
        lockId: ctx.lockId,
        key: ctx.key,
        source: ctx.source,
      });
    },
  });
  // Critical section
} catch (err) {
  if (err instanceof LockError) {
    logger.error("Failed to acquire lock", {
      code: err.code,
      message: err.message,
    });
  }
  throw err;
}
```

**⚠️ Important: Disposal Errors and `using`/`await using`**

When using `using` or `await using`, disposal errors (including timeouts and cleanup failures) are routed to the `onReleaseError` callback. The disposal process itself never throws to avoid disrupting your application's control flow.

**Default Error Handling Behavior (NEW):**

SyncGuard now provides a **safe-by-default** error handler that prevents silent disposal failures:

- **Development** (`NODE_ENV !== 'production'`): Disposal errors are logged to `console.error`
- **Production**: Silent by default to avoid log noise; enable via `SYNCGUARD_DEBUG=true` environment variable
- **Security**: Default logs omit sensitive data (key, lockId) to prevent accidental PII exposure

```typescript
// Default behavior - errors are observable without explicit callback
await using lock = await backend.acquire({ key, ttlMs });
// Development: Disposal errors logged to console.error
// Production: Silent unless SYNCGUARD_DEBUG=true

// Recommended: Provide custom callback in production for proper observability
await using lock = await backend.lock("key", {
  onReleaseError: (err, ctx) => {
    // This callback receives:
    // - Release failures during disposal
    // - Timeout errors (if disposeTimeoutMs configured)
    // - Network errors during cleanup
    logger.error("Disposal failed", {
      error: err.message,
      lockId: ctx.lockId,
      key: ctx.key,
      source: ctx.source,
    });
    metrics.increment("syncguard.disposal.error", { source: ctx.source });
  },
});
// If disposal fails, onReleaseError is called but this code continues normally
```

**Production Best Practice:** Always configure a custom `onReleaseError` callback integrated with your logging and metrics infrastructure. The default callback is a safety net for development and should not be relied upon in production systems.

#### Pattern 2: Centralized Observability with Telemetry

For production systems, wrap your backend with `withTelemetry()` to capture all lock operations in a centralized monitoring system:

```typescript
import { withTelemetry } from "syncguard/common";

const backend = withTelemetry(redisBackend, {
  onEvent: (event) => {
    // Send to your metrics/logging system
    metrics.recordLockOperation(event.type, event.result);

    if (event.result === "fail") {
      logger.warn("Lock operation failed", {
        operation: event.type,
        reason: event.reason,
        keyHash: event.keyHash,
        lockIdHash: event.lockIdHash,
      });
    }
  },
  includeRaw: false, // Only emit sanitized hashes (default)
});

// All operations are now automatically instrumented
await using lock = await backend.lock("key", {
  onReleaseError: globalErrorHandler,
});
```

**Telemetry captures all operations with zero overhead when disabled.**

#### Pattern 3: Global Error Handler

Define a reusable error handler for consistent error logging across your application:

```typescript
// Global error handler
const globalErrorHandler: OnReleaseError = (err, ctx) => {
  logger.error("Lock release failed", {
    error: err.message,
    code: err instanceof LockError ? err.code : "Unknown",
    lockId: ctx.lockId,
    key: ctx.key,
    source: ctx.source,
  });

  // Emit metric
  metrics.increment("lock.release.error", {
    source: ctx.source,
    code: err instanceof LockError ? err.code : "unknown",
  });
};

// Use across your application
const backend = createRedisBackend(redis, {
  onReleaseError: globalErrorHandler,
});

// Or per-lock basis
await using lock = await backend.lock("key", {
  onReleaseError: globalErrorHandler,
});
```

#### Pattern 4: Manual Control with Result Checking

For fine-grained control, use the manual API and check result objects:

```typescript
const result = await backend.acquire({ key: "resource:123", ttlMs: 30000 });

if (!result.ok) {
  // Handle contention
  logger.warn("Lock contention", {
    key: "resource:123",
    reason: result.reason,
  });
  return { status: "retry-later" };
}

try {
  // Critical section
  await processResource();
} finally {
  const releaseResult = await backend.release({ lockId: result.lockId });
  if (!releaseResult.ok) {
    logger.warn("Release failed - lock was absent", { lockId: result.lockId });
  }
}
```

#### Disposal Timeout Behavior

Configure `disposeTimeoutMs` at the backend level to abort slow disposal operations:

```typescript
const backend = createRedisBackend(redis, {
  disposeTimeoutMs: 5000, // Abort disposal after 5 seconds
  onReleaseError: (err, ctx) => {
    if (err instanceof LockError && err.code === "NetworkTimeout") {
      logger.error("Disposal timeout exceeded", {
        timeoutMs: 5000,
        lockId: ctx.lockId,
      });
    }
  },
});

await using lock = await backend.lock("key");
// If disposal takes >5s, it's aborted and onReleaseError is called
```

**Note:** Most applications should rely on backend client timeout settings. Only use `disposeTimeoutMs` for disposal-specific timeout behavior.

#### Error Handling Decision Matrix

| Use Case              | Recommended Pattern                    | Why                                                    |
| --------------------- | -------------------------------------- | ------------------------------------------------------ |
| Simple application    | Pattern 1 (try/catch + onReleaseError) | Minimal setup, covers all error paths                  |
| Production monitoring | Pattern 2 (withTelemetry)              | Centralized observability, zero overhead when disabled |
| Multiple lock sites   | Pattern 3 (global handler)             | Consistent error handling across codebase              |
| Fine-grained control  | Pattern 4 (manual API)                 | Explicit result checking, no implicit behavior         |
| High reliability      | Pattern 2 + Pattern 3                  | Telemetry for monitoring + global handler for errors   |

### Troubleshooting Guide

**Not seeing disposal errors?**

- ✅ Check that `onReleaseError` is configured (backend-level or lock-level)
- ✅ Verify the callback is actually being invoked (add console.log)
- ✅ Remember: `ok: false` results are normal (lock expired) - only system errors trigger callback

**Disposal taking too long?**

- ✅ Configure `disposeTimeoutMs` at backend level
- ✅ Check backend client timeout settings (Redis socket timeout, PostgreSQL query timeout)
- ✅ Monitor network latency to backend service

**Want to see all lock activity?**

- ✅ Use `withTelemetry()` to wrap your backend
- ✅ Configure `onEvent` callback to send to your logging/metrics system
- ✅ Enable `includeRaw: true` only for debugging (exposes sensitive identifiers)

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
    Aborted: "Operation cancelled via AbortSignal (user-initiated cancellation)";
    Internal: "Unexpected backend errors, unclassified system failures, unknown conditions (includes rare backend limit scenarios)";
  };

  // Domain outcome reasons for telemetry (exact strings required for events)
  telemetryReasons: ["expired", "not-found"]; // MUST use only these strings for *-failed events
  acquisitionReasons: ["locked"]; // MUST use only this string for acquire contention
}
```

**Backend Implementation Requirements:**

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
- **Observability**: When wrapped by `withTelemetry()`, emit `LockEvent` for monitoring and diagnostics, with detailed telemetry reasons preserved in events

### Rationale & Notes

**Why centralized mapping**: Prevents drift between backends. Ensures users get consistent error codes for equivalent failures.

**Why contention as result**: Domain outcome, not system error. Allows callers to handle gracefully without try/catch.

**Why throw for system errors**: Exceptional conditions that typically require retry or intervention. Natural error propagation in async code.

---

## Storage Requirements

### Requirements

**Reverse Mapping**: All backends MUST provide a mechanism to atomically resolve `lockId → key` for the lifetime of each lock. This capability is established at acquisition and used by `release` and `extend` operations to atomically load the key from `lockId` for ownership verification.

**CRITICAL: TOCTOU Protection**: To prevent Time-of-Check-Time-of-Use race conditions, ALL `release` and `extend` operations MUST execute these steps atomically within a single transaction/script:

1. **Resolve mapping**: Load the key from lockId via reverse mapping
2. **Validate state**: Verify lock exists and is not expired
3. **Perform mutation**: Delete (release) or update TTL (extend)

**Implementation Options**: Backends MAY implement this requirement through:

- **Explicit mapping**: Separate `lockId → key` storage (e.g., Redis index keys)
- **Indexed queries**: Database queries on indexed `lockId` fields (e.g., Firestore single-field index)

The chosen approach MUST support atomic ownership verification within the same transaction/script as the mutation operation.

### Rationale & Notes

**Why reverse mapping required**: Enables keyless API design where `lockId` serves as sufficient handle for all lock operations. Callers don't need to track which key corresponds to which lock.

**Race Condition Example**: Without atomicity, between steps 1-2 and step 3, another process could expire/delete the original lock and acquire a new lock on the same key, causing the first process to accidentally operate on the wrong lock.

**Why implementation flexibility**: Different storage systems have different strengths. Redis excels at dual-key patterns, Firestore at indexed queries. Both work correctly with proper atomicity.

---

## Operation Requirements

### Acquire Operation Requirements

- **Atomicity**: Operations MUST be atomic (transaction/script/CAS) with **no race window** between setting ownership and TTL. Single round-trip is RECOMMENDED but not REQUIRED.
- **Lock ID Generation**: MUST use 16 bytes of cryptographically strong randomness from a CSPRNG (e.g., `crypto.getRandomValues()`). Lock IDs MUST be base64url encoded strings with exactly 22 characters (16 bytes of entropy). No timestamp fallback. If the runtime lacks a secure RNG, SyncGuard MUST provide one.
- **Lock ID Validation**: Backends MUST validate `lockId` format in all operations (release, extend, lookup) and throw `LockError("InvalidArgument")` for malformed lockIds. Valid format: exactly 22 base64url characters matching `^[A-Za-z0-9_-]{22}$`.
- **TTL Handling**: Respect `config.ttlMs` for automatic expiration
- **TTL Authority**: Expiration SHOULD be enforced by backend server time when natively available (e.g., Redis TIME). For backends without native server time (e.g., Firestore), use client time with documented skew tolerance and NTP synchronization recommended.
- **Contention Behavior**: Return `{ ok: false, reason: "locked" }` when lock is held by another process. No fairness or ordering guarantees.
- **Error Distinction**: Contention returns `AcquireResult`, system errors throw `LockError`
- **Fencing Tokens**: Backends that support fencing MUST always generate fence tokens. Fence tokens MUST be atomically persisted with acquisition and be strictly increasing per key (no repeats, no decreases), even across restarts
- **Monotonicity Guarantee**: `fence` values MUST increase for each successful acquisition of the same key, surviving backend restarts
- **API Format**: Fence values MUST be returned as exactly 15-digit zero-padded decimal strings (format: `String(n).padStart(15, '0')`). For Lua implementations, use `string.format("%015d", redis.call('INCR', fenceKey))` to format immediately.
- **Storage Flexibility**: Backends MAY store fence values as numbers internally but MUST preserve full precision and convert to 15-digit zero-padded strings at API boundary
- **Overflow Enforcement**: Backends MUST parse/validate returned fence values and throw `LockError("Internal")` if fence > `FENCE_THRESHOLDS.MAX`; backends MUST log warnings via the shared `logFenceWarning()` utility when fence > `FENCE_THRESHOLDS.WARN` for early operational signals. Canonical values in `common/constants.ts`.
- **Validation**: `ttlMs` MUST be a positive integer (ms); otherwise throw `LockError("InvalidArgument")`. Helper functions MAY apply defaults before calling backend operations.
- **Storage Key Limits**: Backends MUST document their effective storage-key byte limits after prefixing/namespacing. If user key + prefix exceeds the backend's storage limit, backend MUST apply standardized hash-truncation as defined in [Standardized Storage Key Generation](#storage-key-generation). Backends MAY throw `LockError("InvalidArgument")` only if even the truncated form exceeds the backend's absolute limit (e.g., prefix too long). All backends MUST enforce the common 512-byte user key limit first.
- **Performance**: Fast indexed lookups are the target; backends SHOULD document expected performance characteristics

### Acquire Operation Rationale & Notes

**Why CSPRNG**: Prevents lockId prediction attacks. Ensures uniqueness even with high acquisition rates.

**Why format validation**: Fail fast on invalid input. Prevents expensive storage lookups with malformed keys.

**Why contention as result**: Normal operation outcome, not exceptional. Allows graceful handling without try/catch.

**Why fence overflow enforcement**: Prevents silent wraparound. Operations continue to work until explicit limit, then fail safely. See ADR-004 for overflow rationale.

---

### Release Operation Requirements

- **TOCTOU Protection**: MUST follow the CRITICAL TOCTOU Protection requirement above - all three steps (resolve mapping, validate state, perform mutation) MUST be atomic within a single transaction/script
- **Ownership Verification**: MUST verify lock existence and validity before release via the lockId→key reverse mapping
- **Ownership Binding**: At acquisition, the backend MUST bind `lockId → key` and store this mapping for the lock's lifetime. `release` MUST atomically load the key from `lockId` and verify that the lock still exists and is not expired.
- **Return Value**: Return `{ ok: true }` when the mutation was applied. Return `{ ok: false }` otherwise. System/validation/auth/transport failures MUST throw `LockError`; domain outcomes use `ReleaseResult`.
- **Telemetry**: Emit `release-failed` events with detailed `reason` ("expired" | "not-found") for operational monitoring while keeping public API simple.
- **LockId-Only Semantics**: Since release operates via `lockId` with reverse mapping to find the key, ownership conflicts are eliminated in normal operation. However, backends MAY transiently observe ownership mismatches due to stale indices (cleanup race conditions, TTL drift, etc.).
- **At-most-once effect**: Only one `release` may succeed. Concurrent or repeated `release(lockId)` calls for the same lock MUST NOT delete any other owner's lock and MUST return `{ ok: false }` once the lock is gone. The telemetry decorator MAY emit detailed reasons ("expired" | "not-found") via events for operational monitoring.

### Release Operation Rationale & Notes

**Why TOCTOU protection**: Without atomicity, another process could acquire a new lock between lookup and delete, causing wrong-lock deletion.

**Why simplified result**: Public API focuses on success/failure. Internal reasons available for telemetry when enabled.

**Why at-most-once**: Idempotency guarantee. Safe to retry release operations without fear of affecting unrelated locks.

---

### Extend Operation Requirements

- **TOCTOU Protection**: MUST follow the CRITICAL TOCTOU Protection requirement above - all three steps (resolve mapping, validate state, perform mutation) MUST be atomic within a single transaction/script
- **Ownership Verification**: MUST verify lock existence and validity before extending via the lockId→key reverse mapping
- **Ownership Binding**: Same requirement as release - MUST atomically load the key from `lockId` and verify that the lock still exists and is not expired
- **No Resurrection**: `extend` MUST NOT recreate an expired lock. Extend operations MUST succeed only if `current_server_time < stored_expiresAt_server`, checked atomically within the same transaction/script.
- **TTL Update Semantics**: `extend(ttlMs)` resets the expiration to **now + ttlMs** (replaces remaining TTL, does NOT add). Implementations MUST set new expiry to `current_server_time + ttlMs` atomically.
- **TTL Update**: Update expiration time atomically
- **Return Value**: Return `{ ok: true, expiresAtMs: number }` when the mutation was applied (includes new server-based expiry time for heartbeat scheduling). Return `{ ok: false }` otherwise.
- **Telemetry**: Emit `extend-failed` events with detailed `reason` ("expired" | "not-found") for operational monitoring while keeping public API simple.
- **LockId-Only Semantics**: Since extend operates via `lockId` with reverse mapping to find the key, ownership conflicts are eliminated in normal operation.
- **Validation**: `ttlMs` MUST be a positive integer number of milliseconds; otherwise throw `LockError("InvalidArgument")`

### Extend Operation Rationale & Notes

**Why no resurrection**: Expired locks should stay expired. Prevents confusion and maintains clear lifecycle semantics.

**Why reset (not add)**: Simpler mental model. Caller specifies desired total lifetime, not incremental extension.

**Why include expiresAtMs**: Critical for heartbeat scheduling. Callers need exact expiry to schedule next extend operation safely.

---

### IsLocked Operation Requirements

- **Use Case**: Simple boolean checks for control flow (prefer `lookup()` when you need diagnostic context)
- **Performance**: Target fast indexed lookups where possible
- **Read-Only Expectation**: Users expect `isLocked()` to be a pure read operation with no side effects. To honor this expectation, cleanup is **disabled by default**.
- **Optional Cleanup**: Backends MAY support opt-in cleanup via configuration (e.g., `cleanupInIsLocked: true`). When enabled:
  - MUST NOT affect the return value of the current call
  - MUST NOT block, affect, or modify live locks in any way
  - MUST NOT perform any writes that could alter live lock TTL or timestamps
  - MAY perform best-effort, non-blocking cleanup of expired locks as fire-and-forget operations with rate limiting
  - **CRITICAL: Fence Counter Protection**: Cleanup operations MUST ONLY delete lock data (main lock keys/documents and reverse index keys/documents), NEVER fence counter keys/documents
  - **Configuration Validation**: Backends MUST validate cleanup configuration at initialization time and throw `LockError("InvalidArgument")` if misconfiguration could result in fence counter deletion
  - **Cleanup Safety Guard**: MUST use safety guards to prevent race conditions with concurrent extend operations:
    - **Server Time Backends (Redis)**: Only delete when `server_time_ms - stored_expiresAtMs > guard_ms` where `guard_ms >= 2000ms`
    - **Client-Skew Backends (Firestore)**: Only delete when `Date.now() - stored_expiresAtMs > (skew_tolerance_ms + guard_ms)` where `guard_ms >= 1000ms`
  - **Documentation**: Backends that support cleanup MUST clearly document the trade-offs and testing implications
- **Return Value**: `true` if actively locked, `false` otherwise
- **Security**: MUST NOT leak lockId or owner identity information
- **TTL Constraints**: MUST NOT indirectly prolong lock lifetime (e.g., via touched/updated timestamps or triggers)

### IsLocked Operation Rationale & Notes

**Why read-only by default**: Users expect `isLocked()` to be a pure query with no side effects. Automatic cleanup violates this expectation.

**Why optional cleanup**: Some deployments may benefit from opportunistic cleanup to reduce storage bloat. Opt-in preserves predictability.

**Why fence counter protection**: Deleting fence counters breaks monotonicity guarantees and fencing safety. Cleanup must be surgical.

**Why safety guards**: Prevents race conditions where cleanup deletes a lock that's being extended concurrently. Conservative buffer provides safety margin.

---

### Lookup Operation Requirements (Required)

#### Lookup Modes & Guarantees

**Key Mode** (`{ key }`):

- **Complexity**: O(1) direct access (single operation)
- **Atomicity**: Not applicable (inherently atomic read)
- **Use case**: "Is this resource currently locked?"
- **Performance**: Fast indexed lookups, single backend operation

**Ownership Mode** (`{ lockId }`):

- **Complexity**: Multi-step (reverse mapping + verification)
- **Atomicity**: SHOULD be atomic for stores requiring multi-key reads (e.g., Redis via Lua script). MAY use a single indexed query with post-read ownership verification for indexed stores (e.g., Firestore), as lookup is diagnostic-only and does not provide TOCTOU protection for mutations.
- **Use case**: "Do I still own this lock?"
- **Performance**: Index traversal + verification overhead

#### Implementation Requirements

- **Dual Lookup**: Discriminated overloads provide compile-time safety and better IntelliSense
- **Runtime Validation**: MUST validate inputs before any I/O operations:
  - Key mode: Call `normalizeAndValidateKey(key)` and fail fast on invalid keys
  - LockId mode: Call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input
- **Key Lookup**: Return the live lock for the specified key via direct access
- **LockId Lookup**: Return the live lock associated with the specified lockId (enables ownership checking)
- **Ownership Verification**: When looking up by `lockId` via index-based reverse mapping (e.g., Firestore), implementations MUST verify `data.lockId === lockId` after document retrieval; return `null` if verification fails.
- **Atomicity Requirement**: Backends that require multi-key reads (e.g., Redis lockId lookup) SHOULD implement lookup atomically via scripts or transactions. Backends with indexed queries and post-read verification (e.g., Firestore) MAY use non-atomic reads, as lookup is diagnostic-only and does not provide TOCTOU protection for mutations.
- **Null Semantics**: Return `null` if the lock does not exist or is expired; do not attempt to infer distinction between expired vs not-found
- **Read-Only**: MUST be read-only and MUST NOT mutate TTL, timestamps, or any lock state
- **Diagnostic Purpose**: ⚠️ Intended for ownership checking, diagnostics, UI, and monitoring ONLY. Lookup is NOT a correctness guard—NEVER use it to gate release/extend operations (use their built-in atomic verification instead). See [Ownership Checking](#ownership-checking) for proper usage patterns.
- **Performance**: Key lookup SHOULD be optimized for direct access; lockId lookup MAY be slower but SHOULD be reasonably fast
- **Security**: `lookup()` always returns sanitized data (no raw keys/lockIds). Use `getByKeyRaw()`/`getByIdRaw()` helpers for raw data access when debugging.

### Lookup Operation Rationale & Notes

**Why required**: Essential for ownership checking and operational diagnostics. Not optional functionality.

**Why dual modes**: Key lookup for resource status, lockId lookup for ownership checking. Different use cases, different performance characteristics.

**Why sanitized by default**: Prevents accidental logging of sensitive identifiers. Security-first design.

**Why atomicity for lockId**: Multi-step operations need TOCTOU protection. Single atomic operation prevents race conditions.

---

## First-Class Diagnostic Helpers

**Developer Experience**: SyncGuard provides these diagnostic functions as **first-class exports** and the **recommended API** for lock diagnostics. While `backend.lookup()` remains available as a lower-level primitive, developers should prefer these helpers for better discoverability and clearer intent.

### Requirements

```typescript
/**
 * Lookup lock by key (direct O(1) access) - returns sanitized data
 */
export function getByKey<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null>;

/**
 * Lookup lock by lockId (reverse lookup + verification) - returns sanitized data
 */
export function getById<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null>;

/**
 * Lookup lock by key with raw data (for debugging)
 */
export function getByKeyRaw<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfoDebug<C> | null>;

/**
 * Lookup lock by lockId with raw data (for debugging)
 */
export function getByIdRaw<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfoDebug<C> | null>;

/**
 * Quick ownership check - returns boolean
 *
 * ⚠️ WARNING: This is for DIAGNOSTIC/UI purposes only, NOT a correctness guard!
 * Never use `owns() → mutate` patterns. Correctness relies on atomic release/extend
 * with explicit ownership verification (ADR-003).
 */
export function owns<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
): Promise<boolean>;
```

### Rationale & Notes

**Why explicit helpers**: Discoverable. Explicit verbs appear in IDE autocomplete. Better developer experience than overloaded method.

**Why minimal core API**: `LockBackend` interface stays lean with one method. Helpers provide convenience without bloating interface.

**Why owns() warning**: Prevents TOCTOU anti-pattern. Ownership checks are for diagnostics, not pre-mutation guards.

---

## Ownership Checking

> ⚠️ **CRITICAL: Diagnostic Use Only**
> Ownership checks (`owns()` and `lookup({ lockId })`) are for **diagnostics, UI, and monitoring** — NOT for correctness guarantees before mutations. Correctness relies on the atomic ownership verification built into `release()` and `extend()` operations (ADR-003). Never use `lookup() → mutate` patterns as pre-guards.

### Requirements

**✅ Official Ownership Check Methods:**

**Recommended: Use the explicit helper function:**

```typescript
import { owns } from "syncguard";
const owned = await owns(backend, lockId);
```

**Alternative: Direct method for advanced cases:**

```typescript
const owned = !!(await backend.lookup({ lockId }));
```

**Idempotent Operations:**

`extend()` and `release()` are idempotent and safe to call without ownership:

```typescript
// Safe to call even if not owned - operations are idempotent
const extendResult = await backend.extend({ lockId, ttlMs });
if (!extendResult.ok) {
  // Handle not-owned case: lock was absent (expired or never existed)
}

const releaseResult = await backend.release({ lockId });
if (!releaseResult.ok) {
  // Handle not-owned case: lock was absent (expired or never existed)
}
```

### ❌ DO NOT: Extend-for-Ownership Anti-Pattern

```typescript
// WRONG: This mutates TTL and has side effects!
const owned = (await backend.extend({ lockId, ttlMs: 1 })).ok; // ❌ DON'T DO THIS
```

**Why the anti-pattern is dangerous:**

- Unintended side effects (TTL mutation when you wanted read-only check)
- Could accidentally shorten lock lifetime
- Semantically incorrect (extend ≠ ownership check)
- Race conditions with other code expecting unchanged TTL

### Rationale & Notes

**Why diagnostic only**: Read-only checks can't provide correctness guarantees due to TOCTOU. Atomic operations provide authoritative state.

**Why idempotent**: Safe to call without pre-checking. Structured responses for debugging. No risk of accidental damage.

**Why explicit warning**: Prevents common TOCTOU mistake where developers check ownership then mutate, creating race window.

---

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

---

## Performance Requirements

### Requirements

**MUST implement**: AbortSignal support for cancellation

- All backend operations (acquire, release, extend, isLocked, lookup) MUST accept optional `signal?: AbortSignal` parameter
- **Redis backend**: Check `signal.aborted` before issuing commands and throw `LockError("Aborted")` if aborted. After dispatch, mid-flight abort cannot be guaranteed—ioredis does not accept AbortSignal parameters. Best-effort cancellation only.
- **Firestore backend**: Manual cancellation checks via `checkAborted()` helper at strategic points (before reads, after reads, before writes)
- Operations MUST throw `LockError("Aborted")` when signal is aborted
- See backend-specific specs for detailed implementation patterns

**Guidance** (target latencies, not requirements):

- **Acquire/IsLocked**: < 10ms local, < 50ms remote
- **Release/Extend**: < 20ms acceptable
- **Redis**: 1000+ ops/sec, **Firestore**: 100-500 ops/sec

**MUST optimize**: Memory usage (< 1KB per active lock), efficient connection pooling

**No fairness guarantees**: Lock acquisition order is not specified. Clients MUST handle arbitrary patterns.

### Diagnostic Interface Requirements

- **lookup SLA**: Core `lookup()` always returns sanitized data (hash IDs only); use `getByKeyRaw()`/`getByIdRaw()` helpers for raw key/lockId access; MUST include 15-digit `fence` when `backend.capabilities.supportsFencing === true`; response is eventually consistent
- **Read-only**: `lookup` MUST be read-only and MUST NOT mutate TTL or update timestamps
- **Performance**: lookup operations SHOULD be fast but MAY be slower than core lock operations
- **Availability**: Required interface - all backends MUST implement this functionality for operability
- **Dual Lookup**: MUST support both key-based and lockId-based queries for ownership checking
- **Consistency Model**: Redis achieves intra-lookup consistency via atomic scripts; Firestore prevents wrong-doc returns via post-read lockId verification; both eliminate races within lookup operations while maintaining eventually consistent semantics across the system

### Rationale & Notes

**Why AbortSignal**: Enables responsive cancellation. Prevents wasted work when client no longer needs result.

**Why guidance not requirements**: Performance varies by deployment, network, hardware. Targets guide optimization without creating artificial constraints.

**Why no fairness**: Fairness adds complexity and overhead. Applications that need fairness can implement queuing at higher level.

---

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
- [ ] **Tolerance constant enforcement** - tests MUST fail if backend hard-codes any tolerance value other than `TIME_TOLERANCE_MS` from `common/time-predicates.ts`
- [ ] **Cross-backend consistency** - integration tests MUST verify identical API outcomes (ignoring telemetry differences)
- [ ] **Lookup consistency test** - cross-backend test MUST verify `lookup({ lockId })` returns `null` consistently for expired locks (ensures portability without over-testing atomicity races, per ADR-011)
- [ ] Comprehensive unit and integration tests
- [ ] Backend-specific configuration options documented
- [ ] Storage key limits documented with examples
- [ ] **Fence format standardized** - if fencing tokens supported, MUST return 15-digit zero-padded decimal strings; tests verify monotonicity and lexicographic ordering
- [ ] **Fence overflow enforcement** - MUST parse/validate fence values and throw `LockError("Internal")` when fence > `FENCE_THRESHOLDS.MAX`; MUST log warnings via `logFenceWarning()` when fence > `FENCE_THRESHOLDS.WARN` (see `common/constants.ts`)
- [ ] **Consistent hashing** - MUST use `hashKey()` from common utilities for all sanitized output
- [ ] Clear documentation of backend-specific requirements

---

## Security Considerations

### Requirements

**Lock ID Security and Ownership:**

- lockId MUST be cryptographically strong (128+ bits entropy)
- lockId MUST be unique per acquisition (never reused)
- lockId MUST be verified atomically against stored owner
- lockId MUST NOT be predictable or sequential
- Use 16 bytes from a CSPRNG encoded as base64url (22 chars)

**Fencing Tokens:**

- All v1 backends (Redis, PostgreSQL, Firestore) MUST always include monotonic `fence` tokens in acquire results
- Fencing tokens provide protection against stale owner problems
- Applications SHOULD validate fence tokens when accessing guarded resources
- Higher fence numbers indicate more recent acquisitions
- All backends MUST return exactly 15-digit zero-padded decimal strings for fence values
- Backends SHOULD emit warnings when fence values approach `FENCE_THRESHOLDS.MAX` to provide early operational signals (via `logFenceWarning()` when fence > `FENCE_THRESHOLDS.WARN`)
- Consider key namespace rotation if approaching the theoretical limit

**Key Namespace Best Practices:**

- Stored keys SHOULD be namespaced (e.g., `syncguard:{env}:{key}`) to avoid cross-app collisions
- Use environment-specific prefixes for multi-environment deployments
- Consider versioning in key names for schema evolution
- Avoid user-controlled content in key names to prevent injection attacks
- Backends MUST normalize keys to a canonical form and reject keys above 512 bytes to avoid DOS via huge keys
- Key length limits apply to the **byte length** of the normalized key

**TTL and Heartbeat Guidance:**

- `ttlMs` should be **short** (e.g., 10-60 seconds) to minimize impact of failed releases
- For long-running tasks, consider implementing periodic `extend()` calls rather than very long TTLs
- Future versions MAY provide `autoExtend: boolean` helper mode for automatic heartbeating

**Access Control:**

- Backends SHOULD support authentication/authorization
- Document security best practices for each backend
- Validate user-provided configuration for security issues
- Backends MAY honor `signal` to cancel in-flight RPCs; helpers SHOULD pass it through

**Data Protection:**

- Never log sensitive information (credentials, user data)
- Use secure communication channels (TLS) for remote backends
- Follow principle of least privilege for backend permissions

### Rationale & Notes

**Why CSPRNG**: Prevents lockId prediction attacks. Ensures uniqueness even with high acquisition rates.

**Why 128+ bits**: Collision probability negligible for practical use. Industry standard for unique identifiers.

**Why namespacing**: Prevents accidental collisions across applications or environments. Operational safety.

**Why short TTLs**: Failed releases leave locks orphaned. Short TTLs minimize impact. Heartbeats allow long-running tasks.

**Why 15-digit fence format**: Guarantees full safety within Lua's 53-bit precision. Provides 10^15 capacity = ~31.7 years at 1M locks/sec. See ADR-004.

---

## Architecture Decision Records

See [specs/adrs.md](adrs.md) for architectural decisions and design rationale.
