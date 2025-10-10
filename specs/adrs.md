# Architecture Decision Records

This document contains architectural decisions made during the development of SyncGuard. These records document key design choices, their rationale, and consequences.

**Date format:** All dates use `YYYY-MM` format, reflecting when the decision was accepted.

## ADR-003: Explicit Ownership Re-Verification in Mutations

**Date:** 2025-09
**Status:** Accepted
**Context**: Backend implementations perform release/extend operations by reverse mapping `lockId → key` then querying/mutating the lock. While the atomic transaction/script pattern already provides TOCTOU protection, explicit ownership verification adds defense-in-depth.

**Decision**: ALL backends MUST perform explicit ownership verification after reverse mapping lookup:

```typescript
// After fetching document via reverse mapping
if (data?.lockId !== lockId) {
  return { ok: false, reason: "not-found" };
}
```

**Rationale**:

- **Defense-in-depth**: Additional safety layer with negligible performance cost
- **Cross-backend consistency**: Ensures Redis and Firestore implement identical ownership checking
- **TOCTOU protection**: Guards against any edge cases in the atomic resolve→validate→mutate flow
- **Code clarity**: Makes ownership verification explicit rather than implicit in the transaction logic

**Consequences**:

- Backends must implement explicit verification (not just index trust)
- Cross-backend consistency ensures Redis and Firestore handle edge cases identically
- Protection against rare but catastrophic wrong-lock mutations
- Documentation of security-critical decision for future maintainers

## ADR-004: Lexicographic Fence Comparison

**Date:** 2025-09
**Status:** Accepted
**Context**: ADR-004-R1 claimed fences were "opaque" while mandating specific formatting and shipping comparison helpers. This contradiction increased API surface area and created potential for misuse. Additionally, the original 19-digit format created a **critical precision safety issue** in Redis Lua implementations: Lua numbers use IEEE 754 doubles (~53 bits mantissa precision ≈ 15-16 exact decimal digits), causing precision loss for fence values > 2^53-1 (~9e15), which breaks monotonicity guarantees.

**Decision**: Fence tokens are **fixed-width decimal strings with lexicographic ordering**, using **15-digit format** for precision safety (reduced from original 19-digit proposal):

- **Public API**: `export type Fence = string` with explicit comparison rule
- **Format**: 15-digit zero-padded decimal strings (e.g., "000000000000001")
- **Comparison**: Direct string comparison (`fenceA > fenceB`) works correctly
- **Backend Contract**: All backends return identical 15-digit zero-padded format
- **Precision Safety**: 15-digit format guarantees full safety within Lua's 53-bit precision (2^53-1 ≈ 9.007e15; capacity up to 9.999e14)
- **Practical Capacity**: 10^15 operations = ~31.7 years at 1M locks/sec (ample for production use)
- **Overflow Handling**: Backends MUST parse returned fence values and throw `LockError("Internal")` if fence > `FENCE_THRESHOLDS.MAX`; backends MUST log warnings when fence > `FENCE_THRESHOLDS.WARN` for early operational signals via the shared `logFenceWarning()` utility in common. See `common/constants.ts` for canonical threshold values.

**Rationale**:

- **Simplest possible API**: One comparison rule instead of helper functions and complex usage patterns
- **Intuitive**: String comparison matches developer expectations for ordered values
- **Eliminates contradictions**: No "opaque" claims while mandating specific formats
- **JSON-safe**: Strings serialize naturally without BigInt precision issues
- **Cross-language compatible**: All languages can compare strings lexicographically
- **Consistent format**: Fixed-width padding ensures reliable ordering across backends
- **Precision safety**: 15-digit format eliminates ALL risk of Lua floating-point precision loss (stays well within 2^53-1 ≈ 9.007e15)
- **Practical range**: 10^15 capacity provides ample production lifetime (31.7 years at 1M/sec)
- **Correctness over optimization**: Aligns with "prioritize correctness and safety over micro-optimizations" principle
- **Zero rounding risk**: Format guarantees exact integer representation in IEEE 754 doubles across all platforms

**Consequences**:

- Remove `compareFence()` and `isNewerFence()` from public API
- Update backend specs: require identical 15-digit zero-padded format (reduced from original 19-digit design for guaranteed precision safety)
- Update Lua scripts: implement `string.format("%015d", redis.call('INCR', fenceKey))` for 15-digit format
- Update TypeScript helpers: implement `String(n).padStart(15, '0')` for 15-digit format
- Remove `FenceOverflow` from public API; backends enforce overflow limit internally
- Backends MUST parse and validate fence values, throwing `LockError("Internal")` when fence > `FENCE_THRESHOLDS.MAX`; backends MUST log warnings via `logFenceWarning()` when fence > `FENCE_THRESHOLDS.WARN`
- Export canonical thresholds in `common/constants.ts` as `FENCE_THRESHOLDS.MAX` and `FENCE_THRESHOLDS.WARN`
- Simplify documentation: one comparison rule replaces complex usage patterns
- Backend implementations updated to use 15-digit format for complete precision safety
- Cleanup operations MUST only delete lock data, never fence counters
- **Breaking change**: Existing fence values incompatible (pre-1.0 acceptable)

## ADR-005: Unified Time Tolerance

**Date:** 2025-09
**Status:** Accepted
**Context**: The original `timeMode` design created inconsistent semantics across backends: `timeMode: "strict"` meant 0ms tolerance on Redis (server-time) but 1000ms tolerance on Firestore (client-time minimum safe). This violated the principle of predictable cross-backend behavior and created operational risks when switching backends.

**Decision**: Remove `timeMode` configuration entirely and use unified tolerance across all backends:

- **Single tolerance**: See `TIME_TOLERANCE_MS` in interface.md (normative definition)
- **Consistent behavior**: Same configuration produces identical liveness semantics
- **No modes**: Remove `timeMode` from capabilities and configuration
- **Cross-backend portability**: Backend switching preserves lock behavior

**Rationale**:

- **Eliminates confusion**: "Strict" mode was misleading - didn't mean the same thing across backends
- **Predictable behavior**: Users can reason about lock liveness without backend-specific knowledge
- **Operational safety**: Backend migration doesn't change lock semantics subtly
- **Testing simplicity**: Cross-backend tests work without tolerance adjustments
- **Realistic precision**: See `TIME_TOLERANCE_MS` rationale in interface.md

**Consequences**:

- Remove `timeMode` from `BackendCapabilities` interface
- Establish `TIME_TOLERANCE_MS` in interface.md as single normative source
- Update Redis and Firestore specs to reference interface.md constant
- Simplify backend implementation - no conditional tolerance mapping
- Cross-backend consistency tests become straightforward
- Documentation focuses on time authority differences, not tolerance modes

## ADR-006: Mandatory Uniform Key Truncation

**Date:** 2025-09
**Status:** Accepted
**Context**: Original specs allowed backends to either truncate or throw when prefixed storage keys exceeded backend limits, creating inconsistent cross-backend behavior. This made the library unpredictable and difficult to test, as the same user key could produce different outcomes on different backends.

**Decision**: Make truncation **mandatory** when `prefix:userKey` exceeds backend storage limits:

- **Mandatory truncation**: All backends MUST apply standardized hash-truncation when prefixed keys exceed limits
- **Throw only as last resort**: `InvalidArgument` only when even truncated form exceeds absolute backend limits
- **Canonical algorithm**: See [Standardized Storage Key Generation](interface.md#storage-key-generation) in interface.md for the normative `makeStorageKey()` specification
- **Universal application**: Applies to main lock keys, reverse index keys, and fence counter keys
- **Fence key consistency**: See [Two-Step Fence Key Derivation Pattern](interface.md#fence-key-derivation) in interface.md for the normative fence key generation specification

**Rationale**:

- **Predictable behavior**: Same user key produces same outcome across all backends
- **Testable**: Cross-backend tests work without special-casing backend limits
- **Composable**: Applications can rely on uniform truncation behavior
- **Safe**: Maintains DoS protection while ensuring consistency
- **Simple**: Eliminates "either/or" complexity in backend implementations
- **1:1 fence mapping**: Guarantees each distinct user key maps to a unique fence counter
- **Single normative source**: interface.md defines the canonical algorithm; ADRs provide rationale only

**Consequences**:

- Remove "either throw or truncate" language from all backend specs
- Create common `makeStorageKey()` helper implementing the interface.md specification
- Update backend specs to reference interface.md rather than repeating algorithm details
- Simplify cross-backend testing (no need to handle different outcomes)
- Ensure all key types (main, index, fence) use identical truncation logic with proper composition
- Backend specs maintain only backend-specific byte limits (e.g., 1500 for Firestore, 1000 for Redis)

## ADR-007: Opt-In Telemetry

**Date:** 2025-09
**Status:** Accepted
**Context**: Original specification mandated telemetry for all operations, requiring backends to compute hashes and emit events even when no consumer existed. This created unnecessary overhead, complicated the core API with redaction policies, and made testing more difficult due to side effects in every operation.

**Decision**: Make telemetry **opt-in** via a decorator pattern:

- **Telemetry OFF by default**: Backends track cheap internal details but don't compute hashes or emit events
- **Decorator pattern**: `withTelemetry(backend, options)` wraps backends to add observability
- **Simplified lookup**: `lookup()` always returns sanitized data; `getByKeyRaw()`/`getByIdRaw()` provide raw access
- **Unified redaction**: Single `includeRaw` option in decorator, no per-call overrides
- **Async isolation**: Event callbacks never block operations or propagate errors

**Rationale**:

- **Zero-cost abstraction**: No performance impact when telemetry disabled
- **Cleaner separation**: Core backends focus on correctness; telemetry is a composable layer
- **Simpler API**: Removes `includeRaw` from core config and per-call parameters
- **Better testing**: Pure functions without side effects by default
- **Tree-shakable**: Applications without telemetry can exclude the decorator entirely

**Consequences**:

- **Breaking change**: `onEvent` in `LockConfig` deprecated; use decorator instead
- **Migration required**: Applications using telemetry must wrap backends
- **New helpers**: Add `withTelemetry()` decorator and `getByKeyRaw()`/`getByIdRaw()` functions
- **Simplified backends**: Remove hash computation and event emission from core operations
- **Documentation update**: Clearly mark telemetry as optional feature

## ADR-008: Compile-Time Fencing Contract

**Date:** 2025-10
**Status:** Accepted
**Context**: The specification claimed that with Redis/Firestore "TypeScript knows fence exists," yet the type system required optional fence fields, forcing runtime assertions (`expectFence`/`hasFence`) even when backends guaranteed fencing support. This created unnecessary boilerplate and contradicted the promised ergonomics.

**Decision**: Parameterize result types by capabilities so fence is **required** when `supportsFencing: true`:

- **Type-level guarantee**: `AcquireResult<C>` includes required `fence` when `C['supportsFencing'] extends true`
- **No runtime assertions**: Direct access to `result.fence` for fencing backends
- **Simplified helpers**: Keep only `hasFence()` for generic code accepting unknown backends
- **v1 scope**: All bundled backends (Redis, Firestore) provide fencing; non-fencing backends out of scope

**Implementation**:

```typescript
type AcquireOk<C extends BackendCapabilities> = {
  ok: true;
  lockId: string;
  expiresAtMs: number;
} & (C["supportsFencing"] extends true ? { fence: Fence } : {});

type AcquireResult<C extends BackendCapabilities> =
  | AcquireOk<C>
  | { ok: false; reason: "locked"; retryAfterMs?: number };

interface LockBackend<C extends BackendCapabilities> {
  acquire(opts: KeyOp & { ttlMs: number }): Promise<AcquireResult<C>>;
  // ...
}
```

**Rationale**:

- **Zero boilerplate**: Fencing backends provide fence at compile-time, no assertions needed
- **Type safety**: TypeScript prevents accessing fence on non-fencing backends
- **Cleaner API**: Removes `expectFence()` and `supportsFencing()` helpers from public API
- **Delivers promise**: Matches ergonomic examples in backend documentation
- **Forward compatible**: Capabilities field remains for potential future non-fencing adapters

**Consequences**:

- **Breaking change**: `AcquireResult` becomes generic, parameterized by capabilities
- **Improved DX**: Direct `result.fence` access for Redis/Firestore backends
- **Simplified surface**: Remove two helper functions from public API
- **Documentation update**: Show direct fence access in all examples
- **Migration**: Applications using `expectFence()` can remove it; `hasFence()` remains for generic code

## ADR-009: Retries Live in Helpers, Core Backends are Single-Attempt

**Date:** 2025-10
**Status:** Accepted
**Context**: Users expect transparent retry on contention, but we want to keep backends minimal and composable. The initial spec included retry configuration in core constants, creating confusion about where retry logic lives.

**Decision**:

- **`lock()` helper handles all retry logic** and is the primary export
- **Backends perform single-attempt operations only** - no retry logic in backends
- **Split constants**: `BACKEND_DEFAULTS` (ttlMs only) from `LOCK_DEFAULTS` (retry config)
- **Default retry strategy**: Exponential backoff with equal jitter (50% randomization)
- **Removed `retryAfterMs`** field - no current backends can provide meaningful hints

**Rationale**:

- **Clear layering**: Backends stay minimal, helpers add smart behavior
- **Predictable API**: Single-attempt semantics at backend level
- **Composable**: Users can build custom retry strategies if needed
- **No dead fields**: Removing `retryAfterMs` simplifies the interface
- **Discoverable**: Making `lock()` primary export guides users to the happy path

**Consequences**:

- **Breaking change**: Remove `retryAfterMs` from `AcquireResult`
- **Smaller core API**: Backends have simpler contract
- **Easier onboarding**: Users discover `lock()` first
- **Clearer responsibilities**: Retry logic centralized in helper
- **Simpler test matrix**: Backend tests don't need retry scenarios

## ADR-010: Authoritative ExpiresAtMs from Mutations

**Date:** 2025-10
**Status:** Accepted
**Context**: Originally, Redis acquire/extend Lua scripts returned only success indicators and fence tokens, forcing the TypeScript wrapper to approximate `expiresAtMs` using client-side `Date.now() + ttlMs`. This created two problems:

1. **Time authority inconsistency**: Redis uses server time for all lock operations, but expiresAtMs was computed from client time, creating subtle drift
2. **Heartbeat scheduling inaccuracy**: Callers scheduling extend operations based on approximate expiry could miss the window or extend too early

**Decision**: All backend mutation operations (acquire, extend) MUST return authoritative `expiresAtMs` computed from the backend's designated time source:

- **Redis**: Lua scripts compute and return `expiresAtMs` from Redis server time
  - Acquire: `return {1, fence, expiresAtMs}`
  - Extend: `return {1, newExpiresAtMs}`
- **Firestore**: Operations compute and return `expiresAtMs` from client time
- **No client-side approximation**: Backends MUST NOT use `Date.now() + ttlMs` to approximate expiry

**Rationale**:

- **Time authority consistency**: All timestamps originate from the same authoritative source declared in `capabilities.timeAuthority`
- **Accurate heartbeat scheduling**: Callers can schedule next extend operation based on true server-time expiry
- **Eliminates approximation drift**: No accumulating errors from repeated client-side calculations
- **Minimal overhead**: Adding one number to script return array (8 bytes) has negligible performance impact
- **Composability**: Enables reliable auto-extend patterns based on precise timing

**Consequences**:

- **Breaking change**: Redis scripts return different formats
  - Acquire: `[1, fence]` → `[1, fence, expiresAtMs]`
  - Extend: `1` → `[1, newExpiresAtMs]`
- **TypeScript wrapper updates**: Parse and validate returned expiresAtMs
- **Robustness checks**: Add validation for malformed script returns
- **Specification updates**: Document new return formats in redis-backend.md
- **Interface clarification**: Add note in interface.md Time Authority section about authoritative expiresAtMs requirement
- **Test updates**: Update unit test mocks to return new format

## ADR-011: Relaxed Atomicity for Diagnostic Lookup

**Date:** 2025-10
**Status:** Accepted
**Context**: The original interface.md specification stated that ownership-mode lookup (`lookup({ lockId })`) MUST be atomic to prevent TOCTOU races. However, this requirement was inconsistent across backends:

- **interface.md**: Required atomicity ("MUST use atomic script/transaction")
- **redis-backend.md**: Correctly implemented atomic Lua script for multi-key reads (index + main lock)
- **firestore-backend.md**: Described non-atomic indexed query as "inherently safe" without transaction

This inconsistency created confusion and incompatible guarantees, despite the spec explicitly stating that lookup is diagnostic-only and NOT a correctness guard for mutations.

**Decision**: Relax the atomicity requirement to match the diagnostic nature of lookup:

- **SHOULD be atomic** for stores requiring multi-key reads (e.g., Redis via Lua script)
- **MAY be non-atomic** for indexed stores with post-read ownership verification (e.g., Firestore single indexed query)
- **Reinforce diagnostic nature**: Add strong warning that lookup is for diagnostics/UI/monitoring ONLY—NEVER use to gate release/extend operations

**Rationale**:

- **Aligns with pragmatic safety**: Strict atomicity unneeded for read-only diagnostic operations
- **Reflects actual correctness model**: Release/extend provide atomic TOCTOU protection; lookup is for observation only
- **Improves consistency**: Removes spec contradiction between common interface and backend implementations
- **Simplifies Firestore**: Single indexed query is natural and efficient; transaction overhead unnecessary
- **Preserves Redis strength**: Atomic Lua script remains correct and efficient for multi-key pattern
- **Clear guidance**: "SHOULD/MAY" based on backend characteristics provides implementation flexibility

**Consequences**:

- **Specification updates**:
  - interface.md: Change "MUST be atomic" → "SHOULD be atomic for multi-key stores, MAY use single indexed query for indexed stores"
  - interface.md: Enhance diagnostic warning with explicit cross-reference to atomic release/extend operations
  - firestore-backend.md: Reference relaxed rule and clarify non-atomic is acceptable for diagnostic use
- **No implementation changes**: Current Redis (atomic) and Firestore (non-atomic) implementations already correct
- **Testing enhancement**: Add cross-backend test for "lookup expired lock by lockId returns null consistently" (ensures portability without over-testing races)
- **Documentation clarity**: Makes explicit that lookup atomicity is implementation detail, not correctness requirement

## ADR-012: Explicit Restatement of Authoritative expiresAtMs in Backend Specs

**Date:** 2025-10
**Status:** Accepted
**Context**: ADR-010 and interface.md established that acquire/extend operations MUST return authoritative `expiresAtMs` from the backend's time authority (no client-side approximation). However, the top-level operation requirement tables in redis-backend.md and firestore-backend.md didn't explicitly restate this as a bold **MUST** bullet, making it easy for agents to miss during compliance checks.

**Decision**: Backend specifications MUST restate key inherited requirements in operation sections:

- **Add explicit MUST bullets** to Acquire and Extend operation requirements in both backend specs
- **Reference ADR-010** for rationale to avoid redundant prose
- **Update interface.md** with Backend Delta Pattern guidance: backend specs MUST restate inherited requirements for agent parseability

**Rationale**:

- **Machine-parseability**: Agents can verify compliance from backend-specific operation tables without cross-referencing interface.md
- **Prevents drift**: Explicit restatements reduce risk of agents missing critical requirements
- **Minimal redundancy**: Cross-references to ADR-010/interface.md provide "why" without repeating rationale
- **Consistency**: Follows normative/rationale pattern (tables = normative, ADRs = rationale)

**Consequences**:

- **redis-backend.md updated**: Added "**MUST return authoritative expiresAtMs**" bullets to Acquire and Extend sections
- **firestore-backend.md updated**: Added "**MUST return authoritative expiresAtMs**" bullets to Acquire and Extend sections
- **interface.md updated**: Added Backend Delta Pattern section explaining restatement requirement
- **Future backend implementations**: Must follow this pattern for all inherited requirements
- **Testing enhancement**: Can add cross-backend tests to verify "Acquire/Extend returns expiresAtMs from authority (no approximation)" using mocked time sources

## ADR-013: Store Full Storage Key in Reverse Index

**Date:** 2025-10
**Status:** Accepted
**Context**: The Redis backend's reverse mapping logic contained a correctness bug when key truncation occurred. Per ADR-006, `makeStorageKey()` hashes and truncates the full prefixed key (`<prefix>:<normalizedKey>`) to a base64url string (22 characters) when the effective length exceeds the backend's budget (1000 bytes for Redis, after reserving 26 bytes). However, the acquire script stored the **original user key** in the reverse index (`{prefix}:id:{lockId}`), and the release/extend scripts reconstructed the main lock key as `{keyPrefix}:{key}` using that original value.

This created a mismatch:

- **During acquire**: The main lock key is the truncated/hashed form (e.g., `syncguard:<22-char-hash>`)
- **During release/extend**: Reconstruction uses the original key, resulting in a non-truncated key (e.g., `syncguard:<long-original-key>`), which doesn't match the stored lock

As a result, release/extend would fail to find the lock (returning "not found") or, in worst cases, target an unrelated key if collisions occur. This violated TOCTOU protection and ownership verification (ADR-003), breaking the core contract for mutating operations.

Truncation triggers when `len(prefix + ':' + userKey.encode('utf-8')) + 26 > 1000`, or roughly when `len(prefix) > 461` bytes with a 512-byte user key. While uncommon with the default prefix ("syncguard"), it's possible with custom namespaces (e.g., app-specific long prefixes), making this a latent correctness issue.

**Decision**: The reverse index MUST store the full computed storage key (post-truncation), not the original user key:

- **Acquire script**: Store full `lockKey` in index: `redis.call('SET', lockIdKey, storageKey, 'PX', ttlMs)` where `storageKey = ARGV[4]` is the full lockKey passed from TypeScript
- **Release/extend/lookup scripts**: Retrieve full `lockKey` directly from index: `local lockKey = redis.call('GET', lockIdKey)` (no reconstruction)
- **Remove keyPrefix parameter**: Release, extend, and lookup-by-lockId scripts no longer need `KEYS[2] = keyPrefix` since reconstruction is eliminated
- **Script simplification**: Remove all prefix handling logic (`if string.sub(keyPrefix, -1) == ":" then ...`)

**Rationale**:

- **Eliminates reconstruction mismatch**: Storing the post-truncation key ensures release/extend always target the correct lock
- **Ensures consistency under truncation**: Closes the safety hole without API changes
- **Improves composability**: Robust to any valid config (long prefixes, max keys)
- **Enhances testability**: Unit tests can now simulate truncation (long prefix + max key) to verify release/extend
- **Negligible overhead**: Redis values handle 1000-byte strings efficiently; no performance impact
- **Surgical fix**: Minimal changes to scripts and TypeScript wrappers; no public API changes

**Consequences**:

- **Script updates**:
  - `ACQUIRE_SCRIPT`: Changed ARGV[4] from `key` to `storageKey`; stores full lockKey in index
  - `RELEASE_SCRIPT`: Changed KEYS from `[lockIdKey, keyPrefix]` to `[lockIdKey]`; retrieves lockKey directly
  - `EXTEND_SCRIPT`: Changed KEYS from `[lockIdKey, keyPrefix]` to `[lockIdKey]`; retrieves lockKey directly; re-stores lockKey in index
  - `LOOKUP_BY_LOCKID_SCRIPT`: Changed KEYS from `[lockIdKey, keyPrefix]` to `[lockIdKey]`; retrieves lockKey directly
- **TypeScript updates**:
  - `acquire.ts`: Pass `lockKey` (not `normalizedKey`) as ARGV[4]
  - `release.ts`: Remove `config.keyPrefix` from script call; change numKeys from 2 to 1
  - `extend.ts`: Remove `config.keyPrefix` from script call; change numKeys from 2 to 1
  - `lookup.ts`: Remove `config.keyPrefix` from lookup-by-lockId script call; change numKeys from 2 to 1
- **Interface updates**: Update cached script signatures to remove `keyPrefix` parameter
- **Test coverage**: Added `test/unit/redis-truncation-correctness.test.ts` to verify fix handles truncation correctly
- **No data migration**: Breaking change acceptable in pre-1.0 (existing locks in production would need to expire or be manually cleaned up)
