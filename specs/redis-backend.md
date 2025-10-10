# Redis Backend Specification

This document defines Redis-specific implementation requirements that extend the [common interface specification](./interface.md).

---

> 🚫 **CRITICAL: Never Delete Fence Counters**
>
> Fence counter keys (`{prefix}:fence:{key}`) MUST NEVER be deleted or assigned TTL. Deleting fence counters breaks monotonicity guarantees and violates fencing safety. Cleanup operations MUST only target lock data keys (main lock and reverse index), never fence counters.

---

## Document Structure

This specification uses a **normative vs rationale** pattern:

- **Requirements** sections contain MUST/SHOULD/MAY/NEVER statements defining the contract
- **Rationale & Notes** sections provide background, design decisions, and operational guidance

---

## Dual-Key Storage Pattern

### Requirements

**Main lock key**: `{keyPrefix}:{key}` stores JSON lock data
**Index key**: `{keyPrefix}:id:{lockId}` stores full `lockKey` for reverse lookup (ADR-013)

- Both keys MUST have identical TTL for consistency
- Use `redis.call('SET', key, data, 'PX', ttlMs)` for atomic set-with-TTL
- **Storage Key Generation**: MUST call `makeStorageKey()` from common utilities (see [Storage Key Generation](interface.md#storage-key-generation))
- **Backend-specific limit**: `EFFECTIVE_KEY_BUDGET_BYTES = 1000` (chosen for predictable memory/ops headroom; not a Redis hard limit)
- **Reserve Bytes Requirement**: Redis operations MUST reserve 26 bytes for derived keys when calling `makeStorageKey()`:
  - Formula: `":id:" (4 bytes) + lockId (22 bytes) = 26 bytes`
  - Purpose: Ensures derived keys like `${prefix}:id:${lockId}` fit within the effective budget

### Rationale & Notes

**Why dual-key pattern**: Enables fast reverse lookup (lockId → key) required for release/extend operations. Single-key approaches would require scanning or secondary indexes.

**Why identical TTL**: Prevents orphaned index keys. If index outlives lock, lookup returns stale data. If lock outlives index, release/extend fail incorrectly.

**Why 26-byte reserve**: Redis constructs multiple keys from base (main lock + reverse index). Reserve ensures all derived keys fit within the effective budget when base key is at maximum length.

---

## Script Caching for Performance

### Requirements

- **Primary approach**: Use ioredis `defineCommand()` for automatic EVALSHA caching
- **Fallback**: Graceful fallback to `redis.eval()` for test mocks
- Scripts defined once during backend initialization for optimal performance
- ioredis handles SCRIPT LOAD + EVALSHA + NOSCRIPT error recovery automatically

### Rationale & Notes

**Why defineCommand**: ioredis manages the entire caching lifecycle automatically. First call loads script via SCRIPT LOAD, subsequent calls use EVALSHA. If Redis restarts and loses scripts, ioredis automatically reloads via NOSCRIPT error handling.

**Why fallback to eval**: Test mocks often don't implement full Redis command set. Fallback enables unit testing without external dependencies.

**Performance impact**: EVALSHA reduces network overhead from ~1KB (full script) to ~40 bytes (SHA hash). At 10K ops/sec, saves ~9.6MB/sec network bandwidth.

---

## Lua Scripts for Atomicity

### Requirements

- ALL mutating operations MUST use Lua scripts
- Scripts centralized in `redis/scripts.ts` with descriptive comments
- Use `cjson.decode()/cjson.encode()` for JSON handling in Lua
- Return 1 for success, 0 for failure from scripts
- Scripts handle lock contention (return 0), backend throws LockError for Redis errors
- Pass all required data as KEYS and ARGV to avoid closure issues

### Rationale & Notes

**Why Lua scripts**: Redis Lua scripts execute atomically. Provides ACID guarantees without complex client-side transaction logic.

**Why centralized scripts**: Single source of truth. Prevents script duplication and drift across operations.

**Why KEYS/ARGV pattern**: Lua closures over external variables can cause subtle bugs. Explicit parameters make data flow visible and testable.

---

## Explicit Ownership Verification (ADR-003)

### Requirements

**ALL Redis scripts MUST include explicit ownership verification**:

```lua
-- After loading lock data
if data.lockId ~= lockId then return 0 end  -- Ownership mismatch
```

This verification is MANDATORY even when using atomic scripts.

### Rationale & Notes

**Why required despite atomicity**: Defense-in-depth. While atomic scripts prevent most race conditions, explicit verification guards against:

- **Stale reverse mappings**: Cleanup race conditions where index key exists but points to wrong lock
- **Cross-backend consistency**: Both Redis and Firestore must implement identical ownership checking
- **Security requirement**: Prevents wrong-lock mutations in all scenarios (ADR-003 compliance)

**Edge case example**: Index key survives TTL cleanup due to timing window. Without explicit verification, release could affect unrelated lock that reused the same key.

---

## Time Authority & Liveness Predicate

### Requirements

**MUST use [unified liveness predicate](interface.md#time-authority)** from `common/time-predicates.ts`:

```typescript
import {
  isLive,
  calculateRedisServerTimeMs,
  TIME_TOLERANCE_MS,
} from "../common/time-predicates.js";

const serverTimeMs = calculateRedisServerTimeMs(await redis.call("TIME"));
const live = isLive(storedExpiresAtMs, serverTimeMs, TIME_TOLERANCE_MS);
```

**Time Authority Model**: Redis uses **server time** via `redis.call('TIME')` (ADR-005).

### Rationale & Notes

**Why server time**: All lock operations use a single authoritative time source, eliminating client clock skew issues.

**Server Time Reliability**:

- **Single source of truth**: All clients query the same Redis server time for consistency
- **No NTP requirements**: Client clock accuracy is irrelevant for lock operations
- **Predictable behavior**: Lock liveness checks are deterministic across all clients
- **High consistency**: Eliminates race conditions caused by multi-client clock skew (unlike Firestore's client-time model)

**Unified Tolerance**: See `TIME_TOLERANCE_MS` in interface.md for normative tolerance specification.

**Operational Considerations**: See [Time Authority Tradeoffs](interface.md#time-authority-tradeoffs) for:

- When to choose Redis vs Firestore based on time authority requirements
- Pre-production checklists and production monitoring guidance
- Failure scenarios and mitigation strategies for server time authority
- When Redis server time might fail (e.g., Redis cluster clock sync issues)

---

## Backend Capabilities and Type Safety

### Requirements

Redis backends MUST declare their specific capabilities for enhanced type safety:

```typescript
interface RedisCapabilities extends BackendCapabilities {
  backend: "redis"; // Backend type discriminant
  supportsFencing: true; // Redis always provides fencing tokens
  timeAuthority: "server"; // Uses Redis server time
}

const redisBackend: LockBackend<RedisCapabilities> = createRedisBackend(config);
```

### Rationale & Notes

**Ergonomic Usage**: Since Redis always supports fencing, TypeScript provides compile-time guarantees:

```typescript
const result = await redisBackend.acquire({ key: "resource", ttlMs: 30000 });
if (result.ok) {
  result.fence; // No assertion needed - TypeScript knows this exists
}
```

**Type discriminant benefits**: Enables pattern matching and type-safe backend switching in generic code.

---

## Script Implementation Patterns

### Acquisition Script Requirements

```lua
-- Acquire Script Signature:
-- KEYS[1] = lockKey (e.g., "syncguard:resource:123")
-- KEYS[2] = lockIdKey (e.g., "syncguard:id:abc123xyz")
-- KEYS[3] = fenceKey (e.g., "syncguard:fence:resource:123")
-- ARGV[1] = lockId
-- ARGV[2] = ttlMs
-- ARGV[3] = toleranceMs
-- ARGV[4] = storageKey (full lockKey post-truncation, for index storage per ADR-013)
-- ARGV[5] = userKey (original normalized key, for lockData)
--
-- @returns {1, fence, expiresAtMs} on success, 0 on contention

local lockKey = KEYS[1]
local lockIdKey = KEYS[2]
local fenceKey = KEYS[3]
local lockId = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local toleranceMs = tonumber(ARGV[3])
local storageKey = ARGV[4]  -- Full lockKey for index (ADR-013)
local userKey = ARGV[5]     -- Original key for lockData

-- 1. Get server time and check existing lock expiration (using canonical time calculation)
local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000) -- See calculateRedisServerTimeMs()
local existingData = redis.call('GET', lockKey)
if existingData then
  local data = cjson.decode(existingData)
  if data.expiresAtMs > (nowMs - toleranceMs) then -- See isLive() predicate
    return 0  -- Still locked (locked)
  end
  -- Clean up expired lockId index
  if data.lockId then
    redis.call('DEL', lockIdKey)
  end
end

-- 2. Generate monotonic fencing token (always)
-- Format immediately as 15-digit string for guaranteed Lua precision safety
local fence = string.format("%015d", redis.call('INCR', fenceKey))
-- Backend MUST parse returned fence and throw LockError("Internal") if fence > FENCE_THRESHOLDS.MAX
-- Backend MUST log warnings via logFenceWarning() when fence > FENCE_THRESHOLDS.WARN
-- See common/constants.ts for canonical threshold values

-- 3. Atomically set both keys with identical TTL
local expiresAtMs = nowMs + ttlMs
local lockData = cjson.encode({
  lockId=lockId,
  expiresAtMs=expiresAtMs,
  acquiredAtMs=nowMs,
  key=userKey,  -- Store original user key in lockData for diagnostics
  fence=fence   -- fence is string to avoid precision loss
})
redis.call('SET', lockKey, lockData, 'PX', ttlMs)
redis.call('SET', lockIdKey, storageKey, 'PX', ttlMs)  -- ADR-013: Store full lockKey for reverse lookup
return {1, fence, expiresAtMs}  -- Success with fence token and authoritative expiresAtMs
```

### Release/Extend Script Requirements

```lua
-- Release Script Signature:
-- KEYS[1] = lockIdKey (e.g., "syncguard:id:abc123xyz")
-- ARGV[1] = lockId
-- ARGV[2] = toleranceMs

-- Extend Script Signature (includes ARGV[3]):
-- ARGV[3] = ttlMs (extend only)
--
-- @returns 1 (release success) or {1, newExpiresAtMs} (extend success), 0 (ownership mismatch), -1 (not found), -2 (expired)

local lockIdKey = KEYS[1]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3]) -- Only for extend operation

-- 1. Get server time (using canonical time calculation)
local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

-- 2. Get lockKey from index (ADR-013: index stores full lockKey directly)
local lockKey = redis.call('GET', lockIdKey)
if not lockKey then return -1 end  -- Lock not found

-- 3. Verify lock data exists and parse
local lockData = redis.call('GET', lockKey)
if not lockData then return -1 end  -- Lock not found

local data = cjson.decode(lockData)

-- 4. Check expiration (using canonical liveness predicate)
if data.expiresAtMs <= (nowMs - toleranceMs) then
  -- Clean up expired lock
  redis.call('DEL', lockKey, lockIdKey)
  return -2  -- Lock expired
end

-- 5. Verify ownership (ADR-003: explicit verification required)
if data.lockId ~= lockId then return 0 end  -- Ownership mismatch

-- 6. Perform operation
-- For release: delete both keys
if not ttlMs then
  redis.call('DEL', lockKey, lockIdKey)
  return 1  -- Release success
end

-- For extend: update TTL (replaces remaining TTL entirely)
local newExpiresAtMs = nowMs + ttlMs
data.expiresAtMs = newExpiresAtMs
redis.call('SET', lockKey, cjson.encode(data), 'PX', ttlMs)
redis.call('SET', lockIdKey, lockKey, 'PX', ttlMs)  -- ADR-013: Re-store full lockKey
return {1, newExpiresAtMs}  -- Extend success with authoritative expiresAtMs
```

### Atomic Lookup Script Requirements

```lua
-- Lookup Script Signature:
-- KEYS[1] = lockIdKey (e.g., "syncguard:id:abc123xyz")
-- ARGV[1] = lockId
-- ARGV[2] = toleranceMs

local lockIdKey = KEYS[1]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])

-- 1. Get server time for expiry check
local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

-- 2. Get lockKey from index (ADR-013: index stores full lockKey directly)
local lockKey = redis.call('GET', lockIdKey)
if not lockKey then return nil end  -- Lock not found

-- 3. Fetch main lock data
local lockData = redis.call('GET', lockKey)
if not lockData then return nil end  -- Lock not found

-- 4. Parse and verify ownership
local data = cjson.decode(lockData)
if data.lockId ~= lockId then return nil end  -- Ownership mismatch

-- 5. Check expiration using canonical predicate
if data.expiresAtMs <= (nowMs - toleranceMs) then return nil end  -- Expired

-- 6. Return lock info (backend converts to LockInfo)
return lockData  -- Contains all fields needed for LockInfo
```

### Rationale & Notes

**Why return lockData as JSON**: TypeScript layer handles sanitization. Lua returns raw data for atomicity, TypeScript converts to `LockInfo<C>` with sanitized hashes.

**Why multiple return codes**: Enables cheap internal condition tracking for telemetry without additional I/O.

**Script Return Code Semantics**:

- Acquire: `0` → contention, `[1, fence, expiresAtMs]` → success with authoritative server-time expiry
- Release: `1` → success, `0` → ownership mismatch, `-1` → not found, `-2` → expired
- Extend: `[1, newExpiresAtMs]` → success with authoritative server-time expiry, `0` → ownership mismatch, `-1` → not found, `-2` → expired

---

## Error Handling

### Requirements

**MUST follow [common spec ErrorMappingStandard](interface.md#centralized-error-mapping)**.

**Key Redis mappings**:

- **ServiceUnavailable**: Connection errors (`ECONNRESET`, `ENOTFOUND`, `ECONNREFUSED`)
- **AuthFailed**: `NOAUTH`, `WRONGPASS`, `NOPERM`
- **InvalidArgument**: `WRONGTYPE`, `SYNTAX`, `INVALID`
- **NetworkTimeout**: Client/operation timeouts
- **Aborted**: Operation cancelled via AbortSignal

**Implementation Pattern**:

```typescript
import {
  isLive,
  calculateRedisServerTimeMs,
} from "../common/time-predicates.js";

// Release/extend operations use script return codes
const scriptReturnCode = await redis.evalsha(/* script */);

// Public API: simplified boolean result
const success = scriptReturnCode === 1;

// Internal detail tracking (best-effort, for decorator consumption if telemetry enabled)
const detail = !success
  ? scriptReturnCode === -2
    ? "expired"
    : "not-found"
  : undefined;

return { ok: success };
```

**Release/Extend Script Return Codes**:

- `1` → success
- `0` → ownership mismatch (ADR-003) → internal: "not-found"
- `-1` → never existed/cleaned up → internal: "not-found"
- `-2` → deterministically observed expired → internal: "expired"

### Rationale & Notes

**Why return codes instead of error strings**: More efficient. Numbers are cheaper to parse than strings in Lua/JSON.

**Why track internal details**: Enables rich telemetry when decorator is enabled, without cluttering public API.

---

## TTL Management

### Requirements

- Use milliseconds directly with PX: `ttlMs`
- Use Redis `PX` option, not separate `EXPIRE` calls
- **Cleanup Configuration**: Optional `cleanupInIsLocked: boolean` (default: `false`) - when enabled, allows fire-and-forget cleanup in isLocked operation
  - **CRITICAL**: Cleanup MUST ONLY delete lock data keys (main lock key and reverse index key), NEVER fence counter keys
  - **Configuration Validation**: Backend MUST validate at initialization that `keyPrefix` configuration does not create overlap between lock data and fence counter namespaces
  - If misconfiguration could result in fence counter deletion, backend MUST throw `LockError("InvalidArgument")` with descriptive message

### Rationale & Notes

**Why PX not EXPIRE**: Single atomic operation. `SET key value PX ttl` is atomic; `SET` then `EXPIRE` creates race window.

**Why validate fence counter namespace**: Prevents catastrophic bugs where cleanup accidentally deletes fence counters, breaking monotonicity guarantees.

---

## Operation-Specific Behavior

### Acquire Operation Requirements

**Direct script return mapping** (not semantic helper):

| Script Return             | Backend Result                                       |
| ------------------------- | ---------------------------------------------------- |
| `0`                       | `{ ok: false, reason: "locked" }` (contention)       |
| `[1, fence, expiresAtMs]` | `{ ok: true, lockId, expiresAtMs, fence }` (success) |

- **MUST return authoritative expiresAtMs**: Computed from Redis server time authority (`redis.call('TIME')`) to ensure consistency and accurate heartbeat scheduling. No client-side approximation allowed (see ADR-010).
- **System Errors**: Backend throws `LockError` for Redis connection/command failures
- **Single-attempt operations**: Redis backends perform single attempts only; retry logic is handled by the lock() helper

### Release Operation Requirements

**MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via atomic Lua scripts. Return simplified `{ ok: boolean }` results. Track internal details cheaply when available for potential telemetry decorator consumption.

### Extend Operation Requirements

- **MUST return authoritative expiresAtMs**: Computed from Redis server time authority (`redis.call('TIME')`) to ensure consistency and accurate heartbeat scheduling. No client-side approximation allowed (see ADR-010).
- **MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via atomic Lua scripts. TTL semantics: replaces remaining TTL entirely (`now + ttlMs`).

### IsLocked Operation Requirements

- **Use Case**: Simple boolean checks (prefer `lookup()` for diagnostics)
- **Locked/Unlocked**: Backend returns `true`/`false` based on key existence and expiry
- **Read-Only by Default**: Cleanup disabled by default to maintain pure read semantics
- **Optional Cleanup**: When `cleanupInIsLocked: true` configured, MAY perform fire-and-forget cleanup following common spec guidelines
- **System Errors**: Backend throws `LockError` for Redis failures

### Lookup Operation Requirements

**Runtime Validation**: MUST validate inputs before any I/O operations:

- **Key mode**: Call `normalizeAndValidateKey(key)` and fail fast on invalid keys
- **LockId mode**: Call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input

**Key Lookup Mode**:

- **Implementation**: Direct access to main lock key: `redis.call('GET', lockKey)`
- **Complexity**: O(1) direct access (single operation)
- **Atomicity**: Single GET operation (inherently atomic)
- **Performance**: Direct key-value access, sub-millisecond latency

**LockId Lookup Mode**:

- **Implementation**: MUST use atomic Lua script that reads reverse index and main lock in single operation
- **Complexity**: Multi-step (reverse mapping + verification)
- **Atomicity**: MUST be atomic via Lua script to prevent TOCTOU races
- **Performance**: Atomic script execution, consistent sub-millisecond performance

**Common Requirements**:

- **Ownership Verification**: Script MUST verify `data.lockId === lockId` after parsing lock data
- **Expiry Check**: Parse JSON and apply `isLive()` predicate using `calculateRedisServerTimeMs()` and `TIME_TOLERANCE_MS`
- **Data Transformation Requirement**: Lua script returns full JSON lockData. TypeScript lookup method MUST parse, compute keyHash and lockIdHash using `hashKey()`, and return sanitized `LockInfo<C>`
- **⚠️ FORBIDDEN: Raw Data Pass-Through**: TypeScript layer MUST sanitize all data before returning. Raw Lua JSON MUST NEVER surface through public API
- **Return Value**: Return `null` if key doesn't exist or is expired; return `LockInfo<C>` for live locks (MUST include `fence`)

### Rationale & Notes

**Why atomic lookup script**: Multi-key reads need atomicity. Without script, lock could expire between reading index and reading main key.

**Why sanitize in TypeScript**: Lua optimizes for atomicity, TypeScript optimizes for security. Clean separation of concerns.

---

## Implementation Architecture

### Requirements

- **Backend creation**: `createRedisBackend()` defines commands via `redis.defineCommand()`
- **Operations**: Use defined commands (e.g., `redis.acquireLock()`) when available
- **Test compatibility**: Falls back to `redis.eval()` for mocked Redis instances
- **Fence Type**: Redis backend uses `string` fence type to avoid JSON precision loss beyond 2^53-1

### Performance Characteristics

- Sub-millisecond latency
- 25k+ ops/sec with cached scripts
- Direct key-value access provides consistently fast operations
- lookup Implementation: Required - supports both key and lockId lookup patterns

### Rationale & Notes

**Why defineCommand at creation**: ioredis caches script SHAs globally per client. Defining at initialization ensures EVALSHA available for all subsequent calls.

**Why string fence type**: JavaScript numbers lose precision beyond 2^53-1. Strings preserve full 15-digit fence values without precision loss.

---

## Configuration Options

### Requirements

```typescript
interface RedisBackendConfig {
  keyPrefix?: string; // Default: "syncguard"
  cleanupInIsLocked?: boolean; // Default: false
  // ... other Redis-specific options
}

// Consistent behavior with unified tolerance
const redisBackend = createRedisBackend(); // Uses TIME_TOLERANCE_MS

// Add telemetry if needed
const observed = withTelemetry(redisBackend, {
  onEvent: (e) => console.log(e),
  includeRaw: false,
});
```

**Unified tolerance**: See `TIME_TOLERANCE_MS` in interface.md for normative specification

### Rationale & Notes

**Why default prefix "syncguard"**: Namespace collision prevention. Allows multiple libraries to coexist in same Redis instance.

**Why cleanupInIsLocked optional**: Read-only expectation by default. Cleanup opt-in preserves predictable behavior.

---

## Key Naming

### Requirements

All key types MUST use `makeStorageKey()` from common utilities with backend-specific effective key budget (`EFFECTIVE_KEY_BUDGET_BYTES = 1000`) and 26-byte reserve:

- **Main lock**: `baseKey = makeStorageKey(config.keyPrefix, key, 1000, 26)`
  - Reserve: 26 bytes for derived keys (index keys)
- **Index key**: `makeStorageKey(config.keyPrefix, `id:${lockId}`, 1000, 26)`
  - Reserve: 26 bytes (same reserve for consistency)
- **Fence key**: MUST use [Two-Step Fence Key Derivation Pattern](interface.md#fence-key-derivation):

  ```typescript
  const baseKey = makeStorageKey(config.keyPrefix, normalizedKey, 1000, 26);
  const fenceKey = makeStorageKey(
    config.keyPrefix,
    `fence:${baseKey}`,
    1000,
    26,
  );
  ```

  - Reserve: 26 bytes (ensures fence keys don't exceed budget when derived from base)

- **Default prefix**: `"syncguard"`
- **Reserve bytes constant**: 26

### Rationale & Notes

**Why two-step fence derivation**: Guarantees 1:1 mapping between user keys and fence counters. See interface.md for complete rationale.

---

## Required Lock Data Structure

### Requirements

```typescript
interface LockData {
  lockId: string; // For ownership verification
  expiresAtMs: number; // Millisecond timestamp
  acquiredAtMs: number; // Millisecond timestamp
  key: string; // Original user key
  fence: string; // Monotonic fencing token (15-digit zero-padded string)
}
```

### Rationale & Notes

**Why include key in lock data**: Debugging and telemetry. Allows reconstruction of full lock state from main key alone.

**Why fence as string**: Preserves precision. JavaScript/Lua number precision limits don't affect string representation.

---

## Fencing Token Implementation

### Requirements

```lua
-- Fence Counter Increment Pattern (within acquire script):
local fenceKey = KEYS[3]  -- Pre-constructed via two-step pattern
-- Format immediately as 15-digit string for guaranteed Lua precision safety
local fence = string.format("%015d", redis.call('INCR', fenceKey))
-- Store fence in lock data JSON and return with AcquireResult
```

**Required Implementation Details:**

- **Fence Key Generation**: MUST use [Two-Step Fence Key Derivation Pattern](interface.md#fence-key-derivation) from interface.md
- **Atomicity**: `INCR` MUST be called within the same Lua script as lock acquisition
- **Persistence**: Fence counters survive Redis restarts (no TTL on fence keys)
- **Monotonicity**: Each successful `acquire()` increments the counter, ensuring strict ordering
- **Storage**: Store the fence value in `LockData.fence` and return in `AcquireResult.fence`
- **Format**: 15-digit zero-padded decimal strings for lexicographic ordering and JSON safety
- **Overflow Enforcement (ADR-004)**: Backend MUST parse returned fence value and throw `LockError("Internal")` if fence > `FENCE_THRESHOLDS.MAX`; MUST log warnings via `logFenceWarning()` when fence > `FENCE_THRESHOLDS.WARN`. Canonical threshold values defined in `common/constants.ts`.

### Rationale & Notes

**Why format in Lua**: Guarantees precision safety. Lua's 53-bit precision accommodates 15-digit decimals without loss.

**Why no TTL on fence keys**: Monotonicity requires persistence. Deleting fence counter would allow reuse, violating safety guarantees.

---

## Fence Key Lifecycle and Memory Considerations

### Requirements

**CRITICAL: Fence keys are intentionally persistent** and MUST NOT have TTL or be deleted:

```lua
-- ❌ NEVER do this - breaks monotonicity guarantee
redis.call('DEL', fenceKey)  -- Violates fencing safety
redis.call('EXPIRE', fenceKey, ttl)  -- Violates fencing safety
```

### Rationale & Notes

**Memory Growth**: Fence counters accumulate over Redis instance lifetime. This is correct behavior for fencing safety.

**Bounded key spaces**: Most applications use predictable lock keys → minimal memory impact
**Unbounded key spaces**: Applications generating unlimited unique keys → fence keys grow indefinitely
**Mitigation**: For unbounded scenarios, consider key normalization or application-level limits

**Operational Guidance**:

- Monitor fence key count via `redis-cli --scan --pattern "syncguard:fence:*" | wc -l`
- Each fence key is ~50-100 bytes (key name + 8-byte counter)
- 1M fence keys ≈ 50-100MB memory (typically acceptable)

**When to be concerned**: If your application generates >10M unique lock keys annually, evaluate key design patterns.

---

## Testing Strategy

### Requirements

- **Unit tests**: Mock Redis with `eval` method, no external dependencies
- **Integration tests**: Real Redis instance, validates `defineCommand()` caching
- **Performance tests**: Benchmarks latency, throughput, and script caching benefits
- **Behavioral compliance testing**: Unit tests MUST verify backend imports and uses `isLive()` and `calculateRedisServerTimeMs()` from `common/time-predicates.ts`
- **Cross-backend consistency**: Integration tests MUST verify identical outcomes given same tolerance values between Redis and other backends

### Rationale & Notes

**Why unit tests with mocks**: Fast feedback loop. No external dependencies for basic correctness checks.

**Why integration tests with real Redis**: Validates script caching, network behavior, actual atomicity guarantees.

**Why cross-backend tests**: Ensures API consistency. Users should get identical behavior regardless of backend choice (accounting for time authority differences).
