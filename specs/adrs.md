# Architecture Decision Records

This document contains architectural decisions made during the development of SyncGuard. These records document key design choices, their rationale, and consequences.

**Date format:** All dates use `YYYY-MM` format, reflecting when the decision was accepted.

---

## Writing ADRs

### Structure Template

```markdown
## ADR-NNN: Decision Title

**Date:** YYYY-MM
**Status:** Accepted

**Context**: [Problem being solved, constraints, prior approach, why change was needed]

**Decision**: [What was decided - high-level requirement or design choice]

**Rationale**:

[Structured explanation of WHY this decision was made:]

- **Why [aspect]**: [Design reasoning, tradeoffs, impact]
- **Alternatives considered and rejected**: [What was evaluated but not chosen, and why]

**Consequences**:

- **Breaking changes**: [If any, with justification]
- **Impact areas**: [Where normative requirements are documented]
- **Cross-references**: [Links to interface.md, backend specs with section anchors]
```

### What Belongs in ADRs vs Specifications

| Content Type              | Belongs In                       | Example                              |
| ------------------------- | -------------------------------- | ------------------------------------ |
| MUST/SHOULD requirements  | interface.md, backend specs      | "MUST use 15-digit format"           |
| Implementation algorithms | interface.md (with anchor links) | `makeStorageKey()` specification     |
| Script signatures/formats | Backend specs (redis-backend.md) | Lua script KEYS/ARGV details         |
| Type definitions          | interface.md, backend specs      | `type Fence = string`                |
| **Decision rationale**    | **ADRs**                         | Why 15 digits vs 19 digits           |
| **Design tradeoffs**      | **ADRs**                         | Precision safety vs capacity         |
| **Alternatives rejected** | **ADRs**                         | Why not BigInt format                |
| **Problem context**       | **ADRs**                         | What bug/limitation triggered change |

### Writing Guidelines

**DO:**

- Explain **why** the decision was made and **what problem** it solves
- Include **alternatives considered** with reasons for rejection
- Reference normative specifications for implementation details
- Use structured rationale with clear subsections (e.g., "Why X matters:", "Why Y was insufficient:")
- Document tradeoffs explicitly
- Keep consequences focused on impact areas and cross-references

**DON'T:**

- Repeat implementation details already in interface.md or backend specs
- Include code snippets unless illustrating a concept (not normative)
- Mix requirements (MUST/SHOULD) with rationale prose
- Provide step-by-step implementation instructions
- Duplicate algorithm specifications

### Example: Good vs Bad ADR Content

**❌ Bad (Too implementation-heavy):**

```markdown
**Decision**: Use 15-digit fence format.

**Implementation**:

- Redis: `string.format("%015d", redis.call('INCR', fenceKey))`
- TypeScript: `String(n).padStart(15, '0')`
- Overflow: throw when fence > 999999999999999
```

**✅ Good (Rationale-focused):**

```markdown
**Decision**: Use 15-digit fence format for guaranteed precision safety.

**Rationale**:

**Why 15 digits specifically:**

- Stays within Lua's 53-bit IEEE 754 precision (2^53-1 ≈ 9.007e15)
- Provides 10^15 capacity = ~31.7 years at 1M locks/sec
- Zero rounding risk across all platforms

**Alternatives considered:**

- 19-digit format: Exceeds Lua precision, would break monotonicity
- BigInt format: Not JSON-safe, poor cross-language support

**Consequences**:

- See interface.md §Fence Token Format for normative specification
- See redis-backend.md for Lua implementation details
```

---

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

**Context**: The original fence design claimed tokens were "opaque" while simultaneously mandating specific formatting and shipping comparison helper functions. This contradiction increased API surface area and created potential for misuse. More critically, the initial 19-digit format created a **precision safety issue** in Redis Lua implementations: Lua numbers use IEEE 754 doubles with ~53 bits of mantissa precision (≈15-16 exact decimal digits). Fence values exceeding 2^53-1 (~9e15) would suffer precision loss, breaking monotonicity guarantees—the core correctness property of fencing tokens.

**Decision**: Fence tokens are **fixed-width decimal strings with lexicographic ordering**, using a **15-digit format** for guaranteed precision safety.

**Rationale**:

**Why strings over numbers:**

- **Simplest possible API**: Direct string comparison (`fenceA > fenceB`) eliminates need for helper functions
- **Intuitive developer experience**: String comparison matches expectations for ordered values
- **JSON-safe**: Strings serialize naturally without BigInt precision issues
- **Cross-language compatible**: All languages support lexicographic string comparison
- **Eliminates contradictions**: No "opaque" claims while mandating specific formats

**Why 15 digits specifically:**

- **Precision safety**: Stays well within Lua's 53-bit IEEE 754 precision limit (2^53-1 ≈ 9.007e15)
- **Practical capacity**: 10^15 operations = ~31.7 years at 1M locks/sec (ample for production use)
- **Zero rounding risk**: Guarantees exact integer representation in IEEE 754 doubles across all platforms
- **Correctness over optimization**: Aligns with project principle "prioritize correctness and safety over micro-optimizations"

**Why fixed-width zero-padding:**

- **Reliable ordering**: "000000000000002" > "000000000000001" without parsing
- **Cross-backend consistency**: All backends produce identical formats for same fence value
- **Deterministic behavior**: String comparison = chronological comparison, always

**Alternatives considered and rejected:**

- **BigInt format**: Not JSON-safe, poor cross-language support
- **19-digit format**: Exceeds Lua precision limits, would break monotonicity
- **Variable-width strings**: Lexicographic comparison fails ("9" > "10")
- **Helper functions for comparison**: Unnecessary complexity when strings work natively

**Consequences**:

- **Breaking change**: Existing fence values incompatible (acceptable pre-1.0)
- **Simpler public API**: Remove `compareFence()` and `isNewerFence()` helpers
- **Simplified documentation**: One comparison rule replaces complex usage patterns
- **Backend contract**: All backends must return identical 15-digit zero-padded format (see interface.md Fence Token Format for normative specification)
- **Overflow handling**: Backends enforce `FENCE_THRESHOLDS.MAX` internally with warnings at `FENCE_THRESHOLDS.WARN` (see common/constants.ts)
- **Cleanup safety**: Fence counters must never be deleted during cleanup operations (only lock data)
- **Cross-references**: See interface.md for normative fence format requirements

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

**Context**: Originally, Redis acquire/extend Lua scripts returned only success indicators and fence tokens, forcing the TypeScript wrapper to approximate `expiresAtMs` using client-side calculations (`Date.now() + ttlMs`). This created two critical problems:

1. **Time authority inconsistency**: Redis uses server time for all lock operations and liveness checks, but expiresAtMs was computed from client time, creating subtle drift between authoritative state and reported expiry
2. **Heartbeat scheduling inaccuracy**: Callers scheduling extend operations based on approximate expiry could miss the window (extending too late) or waste resources (extending unnecessarily early), especially with clock skew

This violated the principle that timestamps should originate from the backend's designated time authority.

**Decision**: All backend mutation operations (acquire, extend) MUST return authoritative `expiresAtMs` computed from the backend's designated time source—no client-side approximation permitted.

**Rationale**:

**Why time authority consistency matters:**

- **Single source of truth**: All timestamps (stored expiry, returned expiry, liveness checks) originate from the same authoritative clock
- **Eliminates skew-induced bugs**: Client clock drift doesn't create divergence between "what the backend thinks" and "what the client reports"
- **Predictable semantics**: `expiresAtMs` always reflects the backend's view of expiration, matching liveness predicate behavior

**Why approximation is insufficient:**

- **Accumulating drift**: Repeated client-side calculations compound errors over time
- **Clock skew sensitivity**: Client/server clock differences make approximations unreliable
- **Debugging complexity**: Discrepancies between reported and actual expiry complicate troubleshooting

**Why heartbeat scheduling needs precision:**

- **Auto-extend patterns**: Reliable heartbeating requires knowing exact server-time expiry
- **Avoid premature extension**: Extending too early wastes backend round-trips
- **Avoid missed windows**: Extending too late risks lock expiration and loss of ownership

**Why minimal overhead:**

- **Trivial cost**: Adding one number to return payload (8 bytes) has negligible impact
- **Already available**: Backends computing expiry for storage can return it at no extra cost
- **Composability win**: Enables higher-level patterns (auto-extend, adaptive heartbeats) without compromise

**Alternatives considered and rejected:**

- **Client-side approximation with tolerance buffer**: Still suffers from drift; band-aids the problem
- **Separate getExpiry() operation**: Extra round-trip overhead; doesn't solve scheduling race
- **Backend-neutral timestamps**: Impossible—time authority differs by backend design

**Consequences**:

- **Time authority requirement**: Documented in interface.md Time Authority
- **Backend compliance**: All backends must return authoritative expiresAtMs from mutations (see redis-backend.md and firestore-backend.md operation specs)
- **TypeScript wrappers updated**: Parse and validate returned expiresAtMs with robustness checks
- **Test coverage**: Unit tests verify no client-side approximation; integration tests verify heartbeat accuracy
- **Cross-references**: See interface.md for normative authoritative expiresAtMs requirement

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

**Context**: The Redis backend's reverse mapping logic contained a **correctness bug** when key truncation occurred. Per ADR-006, `makeStorageKey()` hashes and truncates long prefixed keys to a 22-character base64url string when they exceed the backend's storage limit. However, the acquire script stored the **original user key** in the reverse index, while release/extend scripts **reconstructed** the main lock key by concatenating `{prefix}:{originalKey}`.

This created a critical mismatch when truncation occurred:

- **During acquire**: Main lock key is truncated form (e.g., `syncguard:<22-char-hash>`)
- **During release/extend**: Reconstruction uses original key (e.g., `syncguard:<long-original-key>`), which doesn't match

**Result**: Release/extend operations would fail to find the lock (returning "not found") or, in worst cases, target an unrelated key. This violated TOCTOU protection and ownership verification (ADR-003), breaking the core correctness guarantee for mutations.

Truncation triggers when `len(prefix + ':' + userKey) + 26 > 1000` bytes (roughly when `len(prefix) > 461` bytes with a 512-byte user key). While uncommon with the default prefix ("syncguard"), it's possible with custom namespaces, making this a latent safety issue.

**Decision**: The reverse index MUST store the full computed storage key (post-truncation), not the original user key. Eliminate key reconstruction entirely.

**Rationale**:

**Why reconstruction was fundamentally broken:**

- **Mismatch under truncation**: Original key reconstruction produces different result than truncated key
- **Silent failure**: Bug only manifests with long prefixes/keys, making it hard to catch in typical testing
- **Violates TOCTOU protection**: Operations target wrong key, bypassing atomic verification guarantees
- **Composability failure**: Valid configurations (long prefix + max key) produced incorrect behavior

**Why storing full storage key fixes it:**

- **Eliminates reconstruction**: No string concatenation, no mismatch possible
- **Consistency guarantee**: Index always returns exactly the key used during acquire
- **Works under all conditions**: Truncated or not, index lookup returns correct target
- **Defense-in-depth**: Even if truncation logic changes, reverse index remains correct

**Why minimal overhead:**

- **Storage cost**: Negligible—Redis values handle 1000-byte strings efficiently
- **Performance cost**: None—GET operation works identically regardless of value length
- **Complexity reduction**: Removing reconstruction logic simplifies scripts

**Why testability matters:**

- **Previously untestable**: Hard to simulate truncation without long prefixes in tests
- **Now verifiable**: Unit tests can use long prefix + max key to exercise truncation path
- **Regression prevention**: Tests ensure future changes don't reintroduce bug

**Alternatives considered and rejected:**

- **Fix reconstruction logic**: Still fragile; any future truncation changes risk re-breaking
- **Disable truncation for reverse index**: Doesn't solve mismatch; creates inconsistent key handling
- **Separate truncation for index**: Complexity explosion; hard to reason about correctness

**Consequences**:

- **Breaking change**: Reverse index format changed (acceptable pre-1.0)
- **Script simplification**: Remove all prefix reconstruction logic and `keyPrefix` parameter
- **Redis implementation updated**: Acquire stores full lockKey; release/extend/lookup retrieve it directly (see redis-backend.md for script specifications)
- **Test coverage**: Added `test/unit/redis-truncation-correctness.test.ts` to verify truncation handling
- **No data migration**: Existing locks in production expire naturally or need manual cleanup
- **Cross-references**: See interface.md Standardized Storage Key Generation for truncation algorithm

## ADR-014: Defensive Detection of Duplicate LockId Documents (Firestore)

**Date:** 2025-10
**Status:** Accepted
**Context**: Firestore lacks database-level unique indexes on fields. The library queries locks by lockId using `where("lockId", "==", lockId).limit(1)`, relying on correct implementation to prevent duplicate documents with the same lockId. However, in real-world operations, bugs, race conditions during migrations, or manual interventions could create duplicates. If this occurs:

- **Query ambiguity**: `.limit(1)` returns an arbitrary document when duplicates exist
- **Ownership verification helps but isn't sufficient**: ADR-003's explicit verification prevents wrong-lock mutations, but doesn't address the underlying data inconsistency
- **Observability blind spot**: Duplicates remain invisible without defensive checks, complicating debugging and cleanup
- **State drift accumulation**: Without detection, duplicate documents could accumulate over time

While this shouldn't happen in normal operation, defensive programming principles require handling operational foot-guns.

**Decision**: Add defensive SHOULD requirement for Firestore operations that query by lockId:

- **Query adjustment**: Remove `.limit(1)` from lockId queries to enable duplicate detection
- **Detection**: When transaction reads return `querySnapshot.docs.length > 1`, treat as internal inconsistency
- **Telemetry**: Log warning with key and lockId context (not error, since this is defensive)
- **Safe cleanup**: MAY delete expired duplicate documents within the same transaction (NEVER delete live locks)
- **Fail-safe mutation**: When duplicates detected and any are live, operations SHOULD return `{ ok: false }` to avoid mutating ambiguous state
- **Scope**: Applies to release, extend, and lookup operations (acquire uses direct document access by key)
- **Performance note**: Removing `.limit(1)` has negligible impact since Firestore uses indexed queries and duplicates shouldn't exist in normal operation

**Rationale**:

- **Defense-in-depth**: Catches data inconsistencies that shouldn't exist but might occur in production
- **Operational visibility**: Telemetry provides early warning for investigation/cleanup
- **Safety first**: Failing mutations on ambiguous state prevents cascading errors
- **No false positives**: Detection only triggers on genuine duplicates (legitimate case: zero or one document)
- **Minimal performance impact**: Removing `.limit(1)` adds negligible overhead since indexed queries are fast and duplicates are rare
- **Composable cleanup**: Optional expired-document deletion reduces state drift without risking live locks
- **Correct detection semantics**: `.limit(1)` would prevent detection by capping results at 1 document

**Consequences**:

- **Specification updates**: Add section in `firestore-backend.md` with SHOULD requirements
- **Implementation**: See JSDoc comments in `firestore/operations/*.ts` for detection patterns
- **Testing**: Integration tests SHOULD verify duplicate handling
- **Backward compatibility**: SHOULD requirement allows gradual adoption

## ADR-015: Async RAII for Locks

**Date:** 2025-10
**Status:** Accepted

**Context**: Lock management requires careful cleanup on all code paths—including early returns, exceptions, and normal completion. Manual cleanup patterns (`try/finally`) are error-prone and verbose. JavaScript's `await using` syntax (AsyncDisposable, Node.js ≥20) provides RAII (Resource Acquisition Is Initialization) for automatic cleanup, but integrating it with the existing lock API required design decisions around error handling, signal propagation, and state management.

**Decision**: Integrate AsyncDisposable support into all backend `acquire()` results, providing automatic lock release on scope exit:

- **Automatic disposal**: All `AcquireResult<C>` objects implement `Symbol.asyncDispose` for `await using` compatibility
- **Two configuration patterns**: Backend-level callbacks for low-level API (`await using`), lock-level callbacks for high-level helper (`lock()`)
- **Stateless handle design**: No local state tracking—delegate idempotency and ownership verification to backend
- **Full signal support**: Handle methods (`release`, `extend`) accept optional `AbortSignal` for per-operation cancellation
- **Error callback integration**: `onReleaseError` callback for disposal failures (never throws from disposal per spec)
- **Type narrowing**: TypeScript's discriminated unions provide automatic narrowing after `if (lock.ok)` check

**Rationale**:

**Why AsyncDisposable integration:**

- **Correctness guarantee**: Ensures cleanup on all code paths without manual try/finally
- **Ergonomic API**: `await using` is concise and familiar to developers using modern JavaScript
- **Error resilience**: Cleanup happens even when scope exits with exceptions
- **Composable**: Works with both backend.acquire() (low-level) and lock() helper (high-level)

**Why two configuration patterns:**

- **Pattern A (backend-level)**: Configure `onReleaseError` once for all acquisitions—ideal for low-level `await using` API
- **Pattern B (lock-level)**: Configure `onReleaseError` per-call—ideal for high-level `lock()` helper with fine-grained control
- **Independence**: These serve different APIs, not meant to be mixed (choose based on usage pattern)
- **No duplication**: Each pattern targets a specific use case

**Why stateless handle design:**

- **Race-free**: Eliminates potential race conditions from mutable `released` boolean flag
- **Simpler code**: No local state to synchronize or reason about
- **Trust backend**: Backend already provides atomic idempotency—don't duplicate checks
- **Correctness over optimization**: Aligns with project principle; duplicate backend calls are rare and cheap

**Why full signal support:**

- **API consistency**: Handle methods mirror backend method signatures (all accept optional `signal`)
- **Per-operation control**: Independent cancellation of different operations (release vs extend)
- **Composability**: Enables advanced patterns like timeout-guarded releases
- **Backward compatible**: Optional parameters don't break existing code

**Why error callbacks never throw:**

- **Disposal safety**: `Symbol.asyncDispose` must never throw per JavaScript spec
- **Observable failures**: Callbacks provide visibility without disrupting cleanup
- **Silent fallback**: Without callback, disposal errors are silently ignored (best-effort cleanup)

**Why manual operations throw but disposal swallows:**

- **API consistency**: `handle.release()` and `handle.extend()` behave identically to `backend.release()` and `backend.extend()` (both throw on system errors)
- **RAII semantics**: Manual operations report errors for actionable handling; automatic disposal is best-effort cleanup
- **Predictable behavior**: Users can rely on consistent error propagation across manual operations
- **Safety**: System errors (network failures, auth errors) are visible and distinguishable from domain failures (lock not found)

**Alternatives considered and rejected:**

- **Implicit signal capture (Option B for Issue 1)**: Hidden state reduces flexibility and testability
- **Mutable released flag with promise serialization (Option B for Issue 2)**: Over-engineering; adds complexity for marginal benefit
- **Separate disposable wrapper type**: Extra API surface; violates "smallest possible API" principle
- **Throwing from disposal**: Violates AsyncDisposable contract; masks original errors

**Consequences**:

- **Breaking changes**: None—AsyncDisposable is additive to existing API
- **New exports**: `decorateAcquireResult()` and `acquireHandle()` in `common/disposable.ts`
- **Backend integration**: All backends (Redis, Postgres, Firestore) call `decorateAcquireResult()` in acquire operations
- **Type changes**: `AcquireResult<C>` includes `Symbol.asyncDispose` on both success and failure results
- **Error handling contract**: Manual `release()` and `extend()` throw on system errors (consistent with backend API); only `Symbol.asyncDispose` swallows errors and routes to `onReleaseError` callback
- **Documentation**: See interface.md Resource Management section for normative specification
- **Test coverage**: 24 disposal unit tests, 18 integration tests across all backends
- **Cross-references**: See `common/disposable.ts` for implementation, `specs/interface.md` for usage examples

## ADR-016: Opt-In Disposal Timeout

**Date:** 2025-10
**Status:** Accepted

**Context**: The `Symbol.asyncDispose` method in disposable lock handles calls `release()` without any timeout or AbortSignal. If a backend's release operation hangs (e.g., network latency in Firestore/Redis, slow PostgreSQL query under load), disposal could block indefinitely. While backend clients should have their own timeouts (Redis socket timeout, PostgreSQL statement_timeout, Firestore client timeout), there was no mechanism to enforce disposal-specific timeout behavior independent of general backend timeouts.

This creates a potential inconsistency: manual `release()` supports `AbortSignal` for cancellation, but automatic disposal (via `await using`) doesn't, leading to different cancellation behavior between explicit and automatic cleanup.

**Decision**: Add **opt-in** `disposeTimeoutMs` configuration with no default:

- **Opt-in configuration**: New `disposeTimeoutMs` field in `BackendConfig` interface (optional, no default value)
- **Timeout mechanism**: When configured, disposal creates internal `AbortController` with `setTimeout`, passes signal to `release()`
- **Error handling**: Timeout errors flow through existing `onReleaseError` callback with normalized error context
- **Backend-agnostic**: Applies uniformly to Redis, PostgreSQL, and Firestore backends
- **Manual operations unaffected**: Timeout only applies to automatic disposal; manual `release()` uses caller-provided signal

**Rationale**:

**Why opt-in (no default):**

- **Pragmatic**: Keeps default behavior simple (status quo), adds safety only when users need it
- **Minimal API growth**: Single optional field in existing config interface
- **Avoids false timeouts**: No risk of premature timeout in slow but valid operations
- **User choice**: High-reliability environments can enable it; others rely on backend-level timeouts

**Why timeout disposal specifically:**

- **Responsiveness guarantee**: Prevents indefinite hangs on scope exit in RAII pattern
- **Consistent with signal support**: Uses existing `AbortSignal` infrastructure from ADR-015
- **Observable failures**: Timeout errors reported via `onReleaseError` callback for visibility
- **Defense-in-depth**: Additional safety layer when backend client timeouts insufficient

**Why not global signal approach:**

- **Too complex**: Requires users to manage global signals, easy to forget
- **No per-lock granularity**: Cannot configure different timeouts for different lock types
- **Error handling burden**: If signal aborts, error handling is user-dependent, potentially unlogged

**Why not status quo:**

- **Safety concern**: Legitimate risk of hangs in distributed systems with unreliable networks
- **Inconsistent behavior**: Manual `release()` has cancellation support, automatic disposal doesn't
- **Operational risk**: Silent hangs reduce observability and reliability in production

**Why minimal complexity:**

- **Reuses existing infrastructure**: `AbortController`, `onReleaseError`, backend signal support
- **No new abstractions**: Timeout is implementation detail of disposal, not exposed API
- **Clear semantics**: Timeout = abort disposal after N milliseconds, report via callback

**Alternatives considered and rejected:**

- **Default timeout (e.g., 5s)**: Forces timeout behavior on all users; might cause false timeouts
- **Global signal configuration**: Too complex for users to manage; no per-lock control
- **Do nothing**: Ignores legitimate safety concerns in high-reliability systems

**Consequences**:

- **Breaking changes**: None—`disposeTimeoutMs` is optional with no default
- **API addition**: Single field in `BackendConfig`, `RedisBackendOptions`, `PostgresBackendOptions`, `FirestoreBackendOptions`
- **Implementation**: Updated `common/disposable.ts` to support timeout parameter, passed through backend `decorateAcquireResult()` calls
- **Backend updates**: Redis, PostgreSQL, Firestore backends pass `config.disposeTimeoutMs` to `decorateAcquireResult()`
- **Test coverage**: 5 new unit tests in `test/unit/disposable.test.ts` covering timeout behavior, signal handling, and error reporting
- **Documentation**: JSDoc in `common/types.ts` explains opt-in nature, use cases, and recommends backend-level timeouts as primary approach
- **Cross-references**: See `common/disposable.ts` for implementation, `common/types.ts` for configuration
