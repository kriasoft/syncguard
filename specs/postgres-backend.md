# PostgreSQL Backend Specification

This document defines PostgreSQL-specific implementation requirements that extend the [common interface specification](./interface.md).

---

> 🚫 **CRITICAL: Never Delete Fence Counters**
>
> Fence counter records in the fence table MUST NEVER be deleted. Deleting fence counters breaks monotonicity guarantees and violates fencing safety. Cleanup operations MUST only target lock records in the lock table, never fence counter records.

---

## Document Structure

This specification uses a **normative vs rationale** pattern:

- **Requirements** sections contain MUST/SHOULD/MAY/NEVER statements defining the contract
- **Rationale & Notes** sections provide background, design decisions, and operational guidance

---

## Table-Based Storage Pattern

### Lock Table Requirements

- **Table Name**: Default `"syncguard_locks"`, configurable via `tableName` option
- **Primary Key**: `key` column (TEXT) - storage key generated via `makeStorageKey()`
- **Required Indexes**:
  - UNIQUE B-tree index on `lock_id` (TEXT) for reverse lookup and uniqueness enforcement
  - B-tree index on `expires_at_ms` (BIGINT) for efficient cleanup and monitoring
- **Backend-specific limit**: 1700 bytes (see `BACKEND_LIMITS.POSTGRES` in `common/constants.ts`)
  - **Rationale**: Based on PostgreSQL B-tree index tuple size limits (~2704 bytes theoretical maximum per 8KB page), with conservative margin for tuple header overhead, multi-column indexes, and UTF-8 encoding variations
  - **NOT related to**: PostgreSQL identifier limit (63 bytes) which applies only to schema object names (tables, columns), not row data
- **Reserve Bytes Requirement**: PostgreSQL operations MUST use 0 reserve bytes when calling `makeStorageKey()`
  - Formula: `0 bytes` (no derived keys requiring suffixes; see `RESERVE_BYTES.POSTGRES`)
  - Purpose: PostgreSQL uses separate tables with independent primary keys
- **Table Schema**:

  ```sql
  CREATE TABLE syncguard_locks (
    key TEXT PRIMARY KEY,
    lock_id TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL,
    acquired_at_ms BIGINT NOT NULL,
    fence TEXT NOT NULL,
    user_key TEXT NOT NULL
  );

  CREATE UNIQUE INDEX idx_syncguard_locks_lock_id ON syncguard_locks(lock_id);
  CREATE INDEX idx_syncguard_locks_expires ON syncguard_locks(expires_at_ms);
  ```

### Lock Table Rationale & Notes

**Why primary key on key**: O(1) lookups for acquire/isLocked operations. Fastest possible access pattern for key-based operations.

**Why UNIQUE index on lock_id**:

- **Reverse lookup**: Enables efficient release/extend/lookup operations by lockId
- **Uniqueness enforcement**: Enforces invariant that each lockId appears at most once in the table
- **Correctness guarantee**: Catches implementation bugs where lockIds might be accidentally reused
- **Query optimization**: PostgreSQL optimizer knows exactly 0 or 1 row matches, enabling faster lookups
- **Negligible overhead**: Same index traversal cost as non-unique, constraint check is O(1)
- **Defense-in-depth**: Database enforces what should be cryptographically impossible (lockId collision probability ~2^-128)

**Why index on expires_at_ms**: Enables efficient cleanup queries and operational monitoring. Allows fast queries like `SELECT * FROM locks WHERE expires_at_ms < NOW()` for cleanup operations and `SELECT COUNT(*) WHERE expires_at_ms > NOW()` for active lock counting.

**Why 0 reserve bytes**: PostgreSQL tables are completely independent. Lock records, fence counter records, and any other metadata use separate tables without key concatenation.

**Why user_key column**: Preserves original user key for diagnostics and `LockInfo` sanitization. Storage key may be truncated/hashed.

---

### Fence Counter Table Requirements

- **Table Name**: Default `"syncguard_fence_counters"`, configurable via `fenceTableName` option
- **Primary Key**: Generated using [Two-Step Fence Key Derivation Pattern](interface.md#fence-key-derivation) for consistent hash mapping (ADR-006)
- **Table Schema**:

  ```sql
  CREATE TABLE syncguard_fence_counters (
    fence_key TEXT PRIMARY KEY,
    fence BIGINT NOT NULL DEFAULT 0
  );
  ```

**Critical Requirements**:

- **Lifecycle Independence**: Fence counters MUST be independent of lock lifecycle. Cleanup operations delete only lock records; counter records are NEVER deleted
- **⚠️ CRITICAL: Fence counters are intentionally persistent** and MUST NOT be deleted:

  ```sql
  -- ❌ NEVER do this - breaks monotonicity guarantee
  DELETE FROM syncguard_fence_counters WHERE fence_key = $1;  -- Violates fencing safety
  ```

- **Fence Key Generation**: MUST follow two-step pattern:

  ```typescript
  import { BACKEND_LIMITS, RESERVE_BYTES } from "../common/constants.js";

  const baseKey = makeStorageKey(
    "",
    normalizedKey,
    BACKEND_LIMITS.POSTGRES,
    RESERVE_BYTES.POSTGRES,
  );
  const fenceKey = makeStorageKey(
    "",
    `fence:${baseKey}`,
    BACKEND_LIMITS.POSTGRES,
    RESERVE_BYTES.POSTGRES,
  );
  ```

  - Reserve: 0 bytes (PostgreSQL tables are independent; see `RESERVE_BYTES.POSTGRES`)

- **Storage Format**: Counter stored as `BIGINT` for efficient atomic increment. Converted to 15-digit zero-padded string in application layer.

### Fence Counter Table Rationale & Notes

**Why lifecycle independence**: Monotonicity guarantee requires persistent counters. Deleting fence counter would allow reuse, violating safety guarantees.

**Why separate table**: Isolation prevents accidental deletion during cleanup. Configuration validation ensures tables remain distinct.

**Why two-step derivation**: Ensures 1:1 mapping between user keys and fence counters. When truncation occurs, both lock and fence keys hash identically. See interface.md for complete rationale.

**Why BIGINT in counter table**: PostgreSQL's BIGINT supports 64-bit integers natively for efficient atomic increment (`fence + 1`). Conversion to string happens once at API boundary.

**Why TEXT in locks table**: API requires fence as 15-digit zero-padded string. No SQL-level fence comparisons needed (all comparison happens in application layer), so storing as TEXT simplifies read operations.

**Critical for correctness**:

- **Monotonicity guarantee**: Deleting counters breaks strictly increasing fence token requirement
- **Cross-backend consistency**: PostgreSQL must match Redis and Firestore's fence counter persistence behavior
- **Fencing safety**: Counter reset would allow fence token reuse, violating safety guarantees

---

## Configuration and Validation

### Requirements

```typescript
interface PostgresBackendOptions {
  tableName?: string; // Lock table, default: "syncguard_locks"
  fenceTableName?: string; // Fence counter table, default: "syncguard_fence_counters"
  cleanupInIsLocked?: boolean; // Enable cleanup in isLocked, default: false
  autoCreateTables?: boolean; // Auto-create tables, default: true
}
```

**CRITICAL: Configuration Validation Requirements**

Backend MUST validate configuration at initialization time and throw `LockError("InvalidArgument")` if:

1. **Table Overlap**: `fenceTableName === tableName` (prevents accidental fence counter deletion)
2. **Table Naming**: Either table name is empty or contains invalid SQL identifier characters
3. **SQL Injection Safety**: Table names MUST be validated against SQL injection patterns

**Implementation Pattern**:

```typescript
// At backend initialization
if (config.fenceTableName === config.tableName) {
  throw new LockError(
    "InvalidArgument",
    "Fence counter table must differ from lock table",
  );
}

// Consistent behavior with unified tolerance
const postgresBackend = createPostgresBackend(sql); // Uses TIME_TOLERANCE_MS
```

### Rationale & Notes

**Why validate at initialization**: Fail-fast principle. Configuration errors should be caught before any operations occur.

**Why require distinct tables**: Prevents catastrophic bugs where cleanup accidentally deletes fence counters, breaking monotonicity.

**Why SQL safety validation**: PostgreSQL table names are used in dynamic SQL. Validation prevents SQL injection vulnerabilities.

---

## Time Authority & Liveness Predicate

### Requirements

**MUST use [unified liveness predicate](interface.md#time-authority)** from `common/time-predicates.ts`:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";
const serverTimeMs = Math.floor(Number(result[0].now_ms));
const live = isLive(storedExpiresAtMs, serverTimeMs, TIME_TOLERANCE_MS);
```

**Time Authority Model**: PostgreSQL uses **server time** via `EXTRACT(EPOCH FROM NOW()) * 1000` (ADR-005).

**Server Time Reliability**:

- **Single source of truth**: All operations query PostgreSQL server time for consistency
- **No NTP requirements**: Client clock accuracy is irrelevant for lock operations
- **Predictable behavior**: Lock liveness checks are deterministic across all clients
- **High consistency**: Eliminates race conditions caused by multi-client clock skew

**Unified Tolerance**: See `TIME_TOLERANCE_MS` in interface.md for normative tolerance specification.

### Rationale & Notes

**Why server time**: PostgreSQL's `NOW()` function provides authoritative time source, eliminating client clock skew issues (same model as Redis).

**Multi-Client Clock Skew Handling**: All clients use same PostgreSQL server time, preventing race conditions from client clock differences.

**Operational Guidance**: See [Time Authority Tradeoffs](interface.md#time-authority-tradeoffs) for:

- When to choose PostgreSQL vs Redis/Firestore based on time authority requirements
- Pre-production checklists and production monitoring guidance
- Failure scenarios and mitigation strategies for server time authority
- When PostgreSQL server time might fail (e.g., clock jumps, NTP sync issues)

---

## Backend Capabilities and Type Safety

### Requirements

PostgreSQL backends MUST declare their specific capabilities for enhanced type safety:

```typescript
interface PostgresCapabilities extends BackendCapabilities {
  backend: "postgres"; // Backend type discriminant
  supportsFencing: true; // PostgreSQL always provides fencing tokens
  timeAuthority: "server"; // Uses PostgreSQL server time
}

const postgresBackend: LockBackend<PostgresCapabilities> =
  await createPostgresBackend(sql);
```

### Rationale & Notes

**Ergonomic Usage**: PostgreSQL always provides fencing tokens with compile-time guarantees:

```typescript
const backend = await createPostgresBackend(sql);
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

## Transaction-Based Atomicity

### Requirements

**ALL mutating operations MUST use postgres.js transactions**:

```typescript
await sql.begin(async (sql) => {
  // 1. Capture server time inside transaction
  const nowMs = Math.floor(
    Number(
      (await sql`SELECT EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms`)[0].now_ms,
    ),
  );

  // 2. Read with row-level locks using FOR UPDATE
  const rows = await sql`SELECT * FROM locks WHERE key = ${key} FOR UPDATE`;

  // 3. Process data and check conditions
  // ...

  // 4. Perform atomic mutations
  await sql`INSERT ... ON CONFLICT ... DO UPDATE ...`;

  return result;
});
```

**Required Transaction Characteristics**:

- **Isolation Level**: READ COMMITTED (postgres.js default) is sufficient
- **Row-Level Locking**: Use `FOR UPDATE` clause to prevent TOCTOU races
- **Time Authority**: MUST capture `NOW()` inside transaction for authoritative timestamps
- **Automatic Rollback**: postgres.js automatically rolls back on errors
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper at strategic points

### Rationale & Notes

**Why sql.begin()**: Provides ACID guarantees with automatic rollback on errors. PostgreSQL's transaction model is well-proven for distributed systems.

**Why FOR UPDATE**: Prevents other transactions from modifying locked rows. Essential for TOCTOU protection in release/extend operations.

**Why capture time in transaction**: Ensures authoritative timestamp consistent with transaction isolation. Prevents clock skew between time capture and data mutation.

---

## Explicit Ownership Verification (ADR-003)

### Requirements

**CRITICAL SECURITY REQUIREMENT**: All release/extend operations MUST include explicit ownership verification after row fetch:

```typescript
if (data?.lock_id !== lockId) {
  return { ok: false };
}
```

This verification is MANDATORY even when using FOR UPDATE row locks.

### Rationale & Notes

**Why required despite row locks**: Defense-in-depth. While FOR UPDATE prevents most race conditions, explicit verification guards against:

- **Defense-in-depth**: Additional safety layer with negligible performance cost
- **Cross-backend consistency**: Ensures PostgreSQL matches Redis and Firestore's explicit ownership checking
- **TOCTOU protection**: Guards against edge cases in atomic read→validate→mutate flow
- **Code clarity**: Makes ownership verification explicit in transaction logic

**See ADR-003** for complete rationale and cross-backend consistency requirements.

---

## Fencing Token Implementation

**NORMATIVE IMPLEMENTATION**: See `postgres/operations/acquire.ts` for canonical transaction pattern with inline documentation.

### Required Characteristics

- **Dual Table Pattern**: Fence counters in separate table (`fence_counters`) from lock records (`locks`)
- **Fence Key Generation**: MUST use [Two-Step Fence Key Derivation Pattern](interface.md#fence-key-derivation)
- **Lifecycle Independence**: Counter records persist indefinitely; cleanup operations MUST NOT delete counter records
- **Atomicity**: Fence increment and lock creation MUST occur within same `sql.begin()` transaction
- **Server Time Authority**: MUST capture `EXTRACT(EPOCH FROM NOW()) * 1000` inside transaction
- **Persistence**: Counter values survive PostgreSQL restarts and lock cleanup operations
- **Monotonicity**: Each successful `acquire()` increments counter atomically using two-step pattern (see Canonical Fence Increment Pattern below)
- **Absent-Row Race Protection**: MUST use canonical pattern to prevent duplicate fence values when counter row doesn't exist
- **Initialization**: Start counter at 0, first acquire returns "000000000000001"
- **Storage Format**: Store as `BIGINT` in counter table, convert to 15-digit zero-padded string for API
- **Format**: Return 15-digit zero-padded decimal strings for lexicographic ordering
- **Overflow Enforcement (ADR-004)**: Backend MUST validate fence value and throw `LockError("Internal")` if fence > `FENCE_THRESHOLDS.MAX`; MUST log warnings via `logFenceWarning()` when fence > `FENCE_THRESHOLDS.WARN`. Canonical threshold values defined in `common/constants.ts`.
- **Table Configuration**: Both lock and fence counter tables MUST be configurable

### Canonical Fence Increment Pattern

**CRITICAL: Absent-Row Race Protection**

When the fence counter row does not exist, a naive `INSERT ... ON CONFLICT ... DO UPDATE` allows concurrent transactions to both see "row absent" and both INSERT with fence=1, causing duplicate fence tokens.

**REQUIRED Implementation Pattern**:

```typescript
// Inside sql.begin() transaction

// Step 0: Acquire advisory lock on storage key (serializes concurrent acquires)
await sql`SELECT pg_advisory_xact_lock(hashtext(${storageKey}))`;

// Step 1: Ensure row exists (idempotent initialization)
await sql`
  INSERT INTO ${sql(config.fenceTableName)} (fence_key, fence, key_debug)
  VALUES (${fenceKey}, 0, ${normalizedKey})
  ON CONFLICT (fence_key) DO NOTHING
`;

// Step 2: Increment with implicit row lock (serializes concurrent updates)
const fenceResult = await sql<Array<{ fence: string }>>`
  UPDATE ${sql(config.fenceTableName)}
  SET fence = fence + 1
  WHERE fence_key = ${fenceKey}
  RETURNING fence
`;
```

**Why this works**:

1. **Advisory lock**: `pg_advisory_xact_lock()` serializes all concurrent transactions working on the same storage key. Transaction-scoped lock is automatically released on commit/rollback.
2. **INSERT with DO NOTHING**: Ensures row exists. Multiple concurrent INSERTs are safe - winner creates row with fence=0, losers do nothing.
3. **UPDATE with implicit lock**: PostgreSQL's UPDATE acquires row-level lock, serializing all concurrent increments. Each transaction waits its turn and gets unique fence value.
4. **Correctness guarantee**: Even when row is initially absent, all concurrent acquires receive monotonically increasing fence tokens and only one acquires the lock.

**Alternative patterns that are INCORRECT**:

```typescript
// ❌ WRONG: Race on absent row
INSERT ... VALUES (${fenceKey}, 1, ...)
ON CONFLICT (fence_key) DO UPDATE SET fence = fence + 1
RETURNING fence;
// Problem: Both see absent row, both INSERT fence=1

// ❌ WRONG: FOR UPDATE on absent row
SELECT fence FROM fence_counters WHERE fence_key = ${fenceKey} FOR UPDATE;
// Then INSERT or UPDATE
// Problem: FOR UPDATE returns empty set for absent row, doesn't block

// ❌ WRONG: No advisory lock
// Without pg_advisory_xact_lock(), even with two-step pattern, concurrent
// transactions can all succeed at incrementing fence but then race on
// INSERT ... ON CONFLICT DO UPDATE for the lock record itself
```

### Rationale & Notes

**Why BIGINT**: PostgreSQL's BIGINT supports 64-bit integers without precision loss. No need for string-based arithmetic.

**Why convert to string at API boundary**: JavaScript numbers lose precision beyond 2^53-1. String representation preserves full 15-digit values.

**Why advisory lock + two-step pattern**: Prevents both absent-row race condition AND concurrent lock acquisition. Advisory lock serializes entire acquire operation per storage key. Two-step INSERT+UPDATE pattern ensures monotonic fence increments. Together they guarantee exactly one winner even under high concurrency.

**See implementation**: `postgres/operations/acquire.ts` contains complete transaction logic with defensive guards and error handling.

---

## Operation-Specific Behavior

### Acquire Operation Requirements

- **MUST return authoritative expiresAtMs**: Computed from PostgreSQL server time authority to ensure consistency and accurate heartbeat scheduling. No approximation allowed (see ADR-010).
- **MUST compute `expiresAtMs` inside the transaction using `NOW()` captured there; NEVER pre-compute outside the transaction.**
- Use `sql.begin()` for atomicity
- Row-level locking: `FOR UPDATE` when checking existing locks
- **Time Authority**: MUST use `isLive()` from `common/time-predicates.ts` with server time and `TIME_TOLERANCE_MS`
- Overwrite expired locks atomically with `INSERT ... ON CONFLICT ... DO UPDATE`
- **Contention**: Return `{ ok: false, reason: "locked" }` when lock is held
- **System Errors**: Throw `LockError` with appropriate error code
- **Fencing Tokens**: Always include monotonic fence token in successful results
- **Storage Key Generation**: MUST call `makeStorageKey()` from common utilities (see [Storage Key Generation](interface.md#storage-key-generation))
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper at strategic points (before transaction, after reads, before writes)

### Acquire Operation Rationale & Notes

**Why sql.begin()**: PostgreSQL's transaction primitive. Provides ACID guarantees with automatic rollback on connection errors.

**Why FOR UPDATE**: Locks row during expiry check. Prevents race where two clients simultaneously see expired lock and both try to acquire.

---

### Release Operation Requirements

- **LockId Validation**: MUST call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input
- **MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via PostgreSQL transactions:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";

await sql.begin(async (sql) => {
  const nowMs = Math.floor(
    Number(
      (await sql`SELECT EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms`)[0].now_ms,
    ),
  );

  // Query by lock_id index with row lock
  const rows = await sql`
    SELECT * FROM ${sql(config.tableName)}
    WHERE lock_id = ${lockId}
    FOR UPDATE
  `;

  const data = rows[0];

  // Check conditions
  const documentExists = rows.length > 0;
  const ownershipValid = data?.lock_id === lockId;
  const isLockLive = data
    ? isLive(Number(data.expires_at_ms), nowMs, TIME_TOLERANCE_MS)
    : false;

  if (!documentExists || !ownershipValid || !isLockLive) {
    return { ok: false };
  }

  // Atomically delete the record
  await sql`DELETE FROM ${sql(config.tableName)} WHERE key = ${data.key}`;
  return { ok: true };
});
```

- **System Errors**: Throw `LockError` for transaction failures
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper at strategic points

### Release Operation Rationale & Notes

**Why query by lock_id**: Enables keyless API. Caller doesn't need to track which key corresponds to which lockId.

**Why explicit ownership verification**: Defense-in-depth. See ADR-003 rationale.

---

### Extend Operation Requirements

- **LockId Validation**: MUST call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input
- **MUST return authoritative expiresAtMs**: Computed from PostgreSQL server time authority to ensure consistency and accurate heartbeat scheduling. No approximation allowed (see ADR-010).
- **MUST compute `expiresAtMs` inside the transaction using `NOW()` captured there; NEVER pre-compute outside the transaction.**
- **MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via PostgreSQL transactions:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";

await sql.begin(async (sql) => {
  const nowMs = Math.floor(
    Number(
      (await sql`SELECT EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms`)[0].now_ms,
    ),
  );

  // Query by lock_id index with row lock
  const rows = await sql`
    SELECT * FROM ${sql(config.tableName)}
    WHERE lock_id = ${lockId}
    FOR UPDATE
  `;

  const data = rows[0];

  // Check conditions
  const documentExists = rows.length > 0;
  const ownershipValid = data?.lock_id === lockId;
  const isLockLive = data
    ? isLive(Number(data.expires_at_ms), nowMs, TIME_TOLERANCE_MS)
    : false;

  if (!documentExists || !ownershipValid || !isLockLive) {
    return { ok: false };
  }

  // Compute new expiresAtMs from authoritative time captured inside transaction
  const newExpiresAtMs = nowMs + ttlMs;

  // Atomically update TTL
  await sql`
    UPDATE ${sql(config.tableName)}
    SET expires_at_ms = ${newExpiresAtMs}
    WHERE key = ${data.key}
  `;

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
- Direct row access by key: `SELECT expires_at_ms FROM locks WHERE key = $1`
- **Read-Only by Default**: Cleanup disabled by default to maintain pure read semantics
- **Optional Cleanup**: When `cleanupInIsLocked: true` configured, MAY perform fire-and-forget cleanup following common spec guidelines
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper before and after read operations

### IsLocked Operation Rationale & Notes

**Why read-only by default**: Users expect `isLocked()` to be pure query with no side effects. Automatic cleanup violates this expectation.

**Why optional cleanup**: Some deployments may benefit from opportunistic cleanup to reduce table bloat. Opt-in preserves predictability.

---

### Lookup Operation Requirements

**Runtime Validation**: MUST validate inputs before any I/O operations:

- **Key mode**: Call `normalizeAndValidateKey(key)` and fail fast on invalid keys
- **LockId mode**: Call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input

**Key Lookup Mode**:

- **Implementation**: Direct row access by primary key: `SELECT * FROM locks WHERE key = $1`
- **Complexity**: O(1) direct access via primary key
- **Atomicity**: Single row read (inherently atomic)
- **Performance**: Primary key lookup, consistently fast

**LockId Lookup Mode**:

- **Implementation**: Query by lock_id index: `SELECT * FROM locks WHERE lock_id = $1`
- **Complexity**: Index traversal + verification
- **Atomicity**: Single indexed query (non-atomic is acceptable per interface.md, as lookup is diagnostic-only; release/extend use transactions for full TOCTOU safety)
- **Performance**: Indexed equality query, requires lock_id index

**Common Requirements**:

- **Ownership Verification**: For lockId lookup, MUST verify `data.lock_id === lockId` after row retrieval; return `null` if verification fails
- **TOCTOU Safety**: PostgreSQL lookups are inherently safe for diagnostic use - single row/query operations with post-read verification. Per interface.md, non-atomic lookup is acceptable because lookup is diagnostic-only; release/extend operations use transactions for full TOCTOU protection against mutations.
- **Expiry Check**: MUST use `isLive()` from `common/time-predicates.ts` with server time and `TIME_TOLERANCE_MS`
- **Data Transformation Requirement**: TypeScript lookup method MUST compute keyHash and lockIdHash using `hashKey()`, and return sanitized `LockInfo<C>`
- **Return Value**: Return `null` if row doesn't exist or is expired; return `LockInfo<C>` for live locks (MUST include `fence`)
- **AbortSignal Support**: MUST check `signal.aborted` via `checkAborted()` helper before and after read operations

### Lookup Operation Rationale & Notes

**Why ownership verification**: Defense-in-depth. Ensures returned lock actually matches requested lockId, even when using indexed queries.

**Why sanitize in TypeScript**: PostgreSQL retrieves raw data. TypeScript layer sanitizes for security before returning.

---

## AbortSignal Requirements

### Requirements

Since `postgres` library does not natively support AbortSignal, backend MUST implement manual cancellation checks using `checkAborted()` helper from `common/helpers.ts`.

**Implementation Pattern**:

```typescript
import { checkAborted } from "../../common/helpers.js";

// In acquire/release/extend operations using transactions
await sql.begin(async (sql) => {
  checkAborted(opts.signal); // Before transaction work

  const rows = await sql`SELECT ...`;
  checkAborted(opts.signal); // After reads

  // Process data...
  checkAborted(opts.signal); // Before writes

  await sql`INSERT ...`;
  return result;
});

// In isLocked/lookup operations without transactions
const rows = await sql`SELECT ...`;
checkAborted(opts.signal); // After read
```

**Required Cancellation Points**:

1. **Before transaction work**: Check immediately upon entering transaction to fail fast
2. **After reads**: Check after PostgreSQL read operations complete
3. **Before writes**: Check before performing PostgreSQL write operations

**Error Handling**:

- `checkAborted(signal)` throws `LockError("Aborted", "Operation aborted by signal")` when signal is aborted
- Provides consistent error semantics across operations

**Testing Requirements**:

- Integration tests MUST verify all operations respect AbortSignal
- Tests MUST verify `LockError("Aborted")` is thrown when signal is aborted
- Tests SHOULD verify operations fail quickly when aborted (< 500ms from abort)

### Rationale & Notes

**Why manual checks**: postgres.js doesn't support AbortSignal natively. Manual checks provide reasonable cancellation granularity.

**Why multiple check points**: Provides responsive cancellation without excessive overhead. Strategic placement balances performance and responsiveness.

**Minimal overhead**: Simple boolean checks. No significant performance impact.

**Consistent with other backends**: Redis and Firestore backends use same approach where native support unavailable.

---

## Error Handling

### Requirements

**MUST follow [common spec ErrorMappingStandard](interface.md#centralized-error-mapping)**.

**Key PostgreSQL mappings**:

- **ServiceUnavailable**: Connection errors (`ECONNREFUSED`, `ECONNRESET`), `53000` (insufficient resources)
- **NetworkTimeout**: Connection timeouts, query timeouts
- **AuthFailed**: `28000` (invalid authorization), `28P01` (invalid password)
- **InvalidArgument**: `22000` (data exception), `23000` (integrity constraint violation)
- **RateLimited**: Connection pool exhaustion
- **Aborted**: Operation cancelled via AbortSignal

**Implementation Pattern**:

```typescript
import { isLive, TIME_TOLERANCE_MS } from "../common/time-predicates.js";

// Determine conditions
const documentExists = rows.length > 0;
const ownershipValid = data?.lock_id === lockId;
const isLockLive = data
  ? isLive(Number(data.expires_at_ms), nowMs, TIME_TOLERANCE_MS)
  : false;

// Public API: simplified boolean result
const success = documentExists && ownershipValid && isLockLive;

return { ok: success };
```

### Rationale & Notes

**Why map PostgreSQL error codes**: Ensures consistent error codes across backends. Users get predictable error handling.

**Key Observations**:

- `rows.length > 0` → row exists check
- `data?.lock_id === lockId` → ownership verification (ADR-003)
- `isLive(...)` → expiry check using unified liveness predicate

---

## Performance Characteristics

### Requirements

- **Primary key access**: Fast row lookups for acquire and isLocked operations (O(1))
- **Indexed equality queries**: Fast indexed lookups for release and extend operations (requires lock_id index)
- **Transaction overhead**: ~2-5ms per operation depending on PostgreSQL configuration and load
- **Expected throughput**: 500-2000 ops/sec depending on hardware and connection pooling
- **Connection pooling**: Use postgres.js connection pooling for optimal performance

### Rationale & Notes

**Performance targets**: Guide optimization without creating artificial constraints. Actual performance varies by deployment, network, hardware.

**Why competitive with Redis**: PostgreSQL's transaction isolation and MVCC provide excellent concurrency. Local PostgreSQL instances achieve sub-millisecond latency.

**Why connection pooling critical**: Transaction overhead amortized across pooled connections. Single connection becomes bottleneck under load.

---

## Configuration and Testing

### Backend Configuration Requirements

- **Unified tolerance**: See `TIME_TOLERANCE_MS` in interface.md for normative specification
- **Lock table**: Configurable via `tableName` option (default: "syncguard_locks")
- **Fence counter table**: Configurable via `fenceTableName` option (default: "syncguard_fence_counters")
- **Configuration Validation**: Backend MUST validate at initialization:
  - `fenceTableName !== tableName`
  - Both table names are valid SQL identifiers
  - Throw `LockError("InvalidArgument")` with descriptive message on validation failure
- **Index requirements**:
  - UNIQUE B-tree index on `lock_id` (required for release/extend/lookup by lockId, enforces uniqueness invariant)
  - B-tree index on `expires_at_ms` (required for efficient cleanup and monitoring queries)
- **Cleanup Configuration**: Optional `cleanupInIsLocked: boolean` (default: `false`)
  - **CRITICAL**: Cleanup MUST ONLY delete lock records, NEVER fence counter records
- **Auto-create tables**: Optional `autoCreateTables: boolean` (default: `true`)
- **lookup Implementation**: Required - supports both key and lockId lookup patterns

### Backend Configuration Rationale & Notes

**Why separate tables**: Prevents accidental fence counter deletion. Validation ensures this separation is maintained.

**Why UNIQUE lock_id index**:

- Without index, lock_id queries require full table scans (catastrophic at scale)
- UNIQUE constraint enforces correctness: each lockId appears at most once
- Query optimizer benefits: knows exactly 0 or 1 row will match
- Negligible overhead: constraint check is O(1) for B-tree index

**Why expires_at_ms index**: Enables efficient cleanup queries (`WHERE expires_at_ms < NOW()`) and monitoring queries (`COUNT(*) WHERE expires_at_ms > NOW()`). Without index, these operations require full table scans.

**Why auto-create by default**: Developer convenience. Production deployments should pre-create tables via migrations.

---

### Testing Strategy Requirements

- **Unit tests**: Mock postgres.js with in-memory transactions, no external dependencies
- **Integration tests**: Real PostgreSQL instance, validates transaction behavior and indexing
- **Performance tests**: Measures transaction latency and throughput under load
- **Index validation**: Ensures required lock_id index exists and performs correctly
- **Behavioral compliance testing**: Unit tests MUST verify backend imports and uses `isLive()` from `common/time-predicates.ts`
- **Cross-backend consistency**: Integration tests MUST verify identical outcomes given same tolerance values between PostgreSQL and other backends

### Testing Strategy Rationale & Notes

**Why unit tests with mocks**: Fast feedback loop. No external dependencies for basic correctness checks.

**Why integration tests with real PostgreSQL**: Validates transaction behavior, index performance, actual atomicity guarantees under production-like conditions.

**Why cross-backend tests**: Ensures API consistency. Users should get identical behavior regardless of backend choice (accounting for time authority differences).
