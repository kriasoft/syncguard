# Redis Backend Instructions

## Critical Redis Requirements

### Dual-Key Storage Pattern

- **Main lock**: `{keyPrefix}:{key}` stores JSON lock data
- **Index key**: `{keyPrefix}:id:{lockId}` stores `key` for reverse lookup
- Both keys MUST have identical TTL for consistency
- Use `redis.call('SET', key, data, 'PX', ttlMs)` for atomic set-with-TTL
- **Storage Key Generation**: User keys are capped at 512 bytes per common validation. Redis keys should be < 1KB for practical purposes. When `prefix:key` approaches 1KB, backend MUST apply the standardized hash-truncation scheme defined in interface.md using the common `makeStorageKey()` helper.

### Script Caching for Performance

- **Primary approach**: Use ioredis `defineCommand()` for automatic EVALSHA caching
- **Fallback**: Graceful fallback to `redis.eval()` for test mocks
- Scripts defined once during backend initialization for optimal performance
- ioredis handles SCRIPT LOAD + EVALSHA + NOSCRIPT error recovery automatically

### Lua Scripts for Atomicity

- ALL mutating operations MUST use Lua scripts
- Scripts centralized in `redis/scripts.ts` with descriptive comments
- Use `cjson.decode()/cjson.encode()` for JSON handling in Lua
- Return 1 for success, 0 for failure from scripts
- Scripts handle lock contention (return 0), backend throws LockError for Redis errors
- Pass all required data as KEYS and ARGV to avoid closure issues

### ⚠️ **Critical: Explicit Ownership Verification (ADR-003)**

**ALL Redis scripts MUST include explicit ownership verification**:

```lua
-- After loading lock data
if data.lockId ~= lockId then return 0 end  -- Ownership mismatch
```

**Why This Is Required**:

- **Cross-backend consistency**: Both Redis and Firestore must implement identical ownership checking
- **Handles edge cases**: Stale reverse mappings from cleanup race conditions
- **Security requirement**: Prevents wrong-lock mutations in all scenarios
- **ADR-003 compliance**: Documented architecture decision for explicit verification

### Time Authority & Liveness Predicate

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

**Unified Tolerance**: Redis uses 1000ms tolerance for consistent cross-backend behavior.

See [Time Implementation Requirements](interface.md#time-implementation-requirements) for complete enforcement details.

## Backend Capabilities and Type Safety

Redis backends MUST declare their specific capabilities for enhanced type safety:

```typescript
interface RedisCapabilities extends BackendCapabilities {
  backend: "redis"; // Backend type discriminant
  supportsFencing: true; // Redis always provides fencing tokens
  timeAuthority: "server"; // Uses Redis server time
}

// Example backend creation with specific capability types
const redisBackend: LockBackend<RedisCapabilities> = createRedisBackend(config);
```

### Ergonomic Usage with Redis

Since Redis always supports fencing, you can use the most ergonomic patterns:

```typescript
// Pattern 1: Direct access (TypeScript knows fence exists)
const result = await redisBackend.acquire({ key: "resource", ttlMs: 30000 });
if (result.ok) {
  result.fence; // No assertion needed - TypeScript knows this exists
}

// Pattern 2: Assertion function for explicit validation
const result = await redisBackend.acquire({ key: "resource", ttlMs: 30000 });
expectFence(result, redisBackend.capabilities);
const fence = result.fence; // TypeScript knows this is non-null
```

### Script Implementation Patterns

**Acquisition Script** (`redis/scripts.ts`):

```lua
-- Acquire Script Signature:
-- KEYS[1] = lockKey (e.g., "syncguard:resource:123")
-- KEYS[2] = lockIdKey (e.g., "syncguard:id:abc123xyz")
-- KEYS[3] = fenceKey (e.g., "syncguard:fence:resource:123")
-- ARGV[1] = lockId
-- ARGV[2] = ttlMs
-- ARGV[3] = toleranceMs
-- ARGV[4] = key (original user key)

local lockKey = KEYS[1]
local lockIdKey = KEYS[2]
local fenceKey = KEYS[3]
local lockId = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local toleranceMs = tonumber(ARGV[3])
local key = ARGV[4]

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
local fenceNumber = redis.call('INCR', fenceKey)
-- Format using common formatter pattern (equivalent to formatFence() from common utilities)
local fence = string.format("%019d", fenceNumber)  -- 19-digit format enables string comparison
-- Warn if approaching limit (backend should log this)
if fenceNumber > 9e18 then
  -- Backend logs warning when extracting result
end
-- 3. Atomically set both keys with identical TTL
-- Backend translates return 0 to { ok: false, reason: "locked" }
-- Backend throws LockError for Redis command failures
local expiresAtMs = nowMs + ttlMs
local lockData = cjson.encode({lockId=lockId, expiresAtMs=expiresAtMs, acquiredAtMs=nowMs, key=key, fence=fence})  -- fence is string to avoid precision loss
redis.call('SET', lockKey, lockData, 'PX', ttlMs)
redis.call('SET', lockIdKey, key, 'PX', ttlMs)  -- Store key for reverse lookup
return {1, fence, fenceNumber}  -- Success with fence token and raw number for monitoring
```

**Release/Extend Pattern**:

```lua
-- Release Script Signature:
-- KEYS[1] = lockIdKey (e.g., "syncguard:id:abc123xyz")
-- KEYS[2] = keyPrefix (e.g., "syncguard")
-- ARGV[1] = lockId
-- ARGV[2] = toleranceMs

-- Extend Script Signature:
-- KEYS[1] = lockIdKey (e.g., "syncguard:id:abc123xyz")
-- KEYS[2] = keyPrefix (e.g., "syncguard")
-- ARGV[1] = lockId
-- ARGV[2] = toleranceMs
-- ARGV[3] = ttlMs (extend only)

local lockIdKey = KEYS[1]
local keyPrefix = KEYS[2]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3]) -- Only for extend operation

-- 1. Get server time (using canonical time calculation)
local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000) -- See calculateRedisServerTimeMs()

-- 2. Get key from lockId index
local key = redis.call('GET', lockIdKey)
if not key then return -1 end  -- Lock not found

-- 3. Construct main lock key
local lockKey = keyPrefix .. ":" .. key

-- 4. Verify lock data exists and parse
local lockData = redis.call('GET', lockKey)
if not lockData then return -1 end  -- Lock not found

local data = cjson.decode(lockData)

-- 5. Check expiration (using canonical liveness predicate)
if data.expiresAtMs <= (nowMs - toleranceMs) then -- See isLive() predicate (inverted)
  -- Clean up expired lock
  redis.call('DEL', lockKey, lockIdKey)
  return -2  -- Lock expired
end

-- 6. Verify ownership (ADR-003: explicit verification required for all backends)
if data.lockId ~= lockId then return 0 end  -- Ownership mismatch (defense-in-depth)

-- 7. Perform operation
-- For release: delete both keys
if not ttlMs then
  redis.call('DEL', lockKey, lockIdKey)
  return 1  -- Release success
end

-- For extend: update TTL (replaces remaining TTL entirely)
local newExpiresAtMs = nowMs + ttlMs
data.expiresAtMs = newExpiresAtMs
redis.call('SET', lockKey, cjson.encode(data), 'PX', ttlMs)
redis.call('SET', lockIdKey, key, 'PX', ttlMs)
return 1  -- Extend success
-- Backend tracks internal conditions cheaply for potential telemetry consumption
```

**Atomic Lookup Script** (for lockId-based lookup):

```lua
-- Lookup Script Signature:
-- KEYS[1] = lockIdKey (e.g., "syncguard:id:abc123xyz")
-- KEYS[2] = keyPrefix (e.g., "syncguard")
-- ARGV[1] = lockId
-- ARGV[2] = toleranceMs

local lockIdKey = KEYS[1]
local keyPrefix = KEYS[2]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])

-- 1. Get server time for expiry check
local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

-- 2. Get key from lockId index
local key = redis.call('GET', lockIdKey)
if not key then return nil end  -- Lock not found

-- 3. Construct and fetch main lock key atomically
local lockKey = keyPrefix .. ":" .. key
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

## Error Handling

**MUST follow [common spec ErrorMappingStandard](interface.md#centralized-error-mapping)**. Key Redis mappings:

- **ServiceUnavailable**: Connection errors (`ECONNRESET`, `ENOTFOUND`, `ECONNREFUSED`)
- **AuthFailed**: `NOAUTH`, `WRONGPASS`, `NOPERM`
- **InvalidArgument**: `WRONGTYPE`, `SYNTAX`, `INVALID`
- **NetworkTimeout**: Client/operation timeouts

**Implementation Pattern**: Simplified public API with telemetry preservation:

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

### TTL Management

- Use milliseconds directly with PX: `ttlMs`
- Use Redis `PX` option, not separate `EXPIRE` calls
- **Cleanup Configuration**: Optional `cleanupInIsLocked: boolean` (default: `false`) - when enabled, allows fire-and-forget cleanup in isLocked operation following common spec guidelines. **CRITICAL**: Cleanup MUST ONLY delete lock data keys, never fence counter keys.

## Operation-Specific Behavior

### Acquire Operation

**Acquire operations use direct script return mapping** (not the semantic helper):

| Script Return | Backend Result                                       |
| ------------- | ---------------------------------------------------- |
| `0`           | `{ ok: false, reason: "locked" }` (contention)       |
| `[1, fence]`  | `{ ok: true, lockId, expiresAtMs, fence }` (success) |

- **System Errors**: Backend throws `LockError` for Redis connection/command failures
- **Single-attempt operations**: Redis backends perform single attempts only; retry logic is handled by the lock() helper

### Release Operation

**MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via atomic Lua scripts. Return simplified `{ ok: boolean }` results. Track internal details cheaply when available for potential telemetry decorator consumption.

### Extend Operation

**MUST implement [TOCTOU Protection](interface.md#storage-requirements)** via atomic Lua scripts. TTL semantics: replaces remaining TTL entirely (`now + ttlMs`).

### IsLocked Operation

- **Use Case**: Simple boolean checks (prefer `lookup()` for diagnostics)
- **Locked/Unlocked**: Backend returns `true`/`false` based on key existence and expiry
- **Read-Only by Default**: Follows common spec expectation - cleanup is disabled by default to maintain pure read semantics
- **Optional Cleanup**: When `cleanupInIsLocked: true` is configured, MAY perform fire-and-forget cleanup of expired locks following common spec guidelines (non-blocking, rate-limited, never affects live locks or return values)
- **System Errors**: Backend throws `LockError` for Redis failures

### Lookup Operation (Required)

**Runtime Validation**: MUST validate inputs before any I/O operations:

- **Key mode**: Call `normalizeAndValidateKey(key)` and fail fast on invalid keys
- **LockId mode**: Call `validateLockId(lockId)` and throw `LockError("InvalidArgument")` on malformed input

**Key Lookup Mode**:

- **Implementation**: Direct access to main lock key: `redis.call('GET', lockKey)`
- **Complexity**: O(1) direct access (single operation)
- **Atomicity**: Single GET operation (inherently atomic)
- **Performance**: Direct key-value access, sub-millisecond latency

**LockId Lookup Mode**:

- **Implementation**: MUST use atomic Lua script that reads reverse index and main lock in single operation to prevent TOCTOU races
- **Complexity**: Multi-step (reverse mapping + verification)
- **Atomicity**: MUST be atomic via Lua script or MULTI/EXEC to prevent TOCTOU races
- **Performance**: Atomic script execution, consistent sub-millisecond performance

**Common Requirements**:

- **Ownership Verification**: Script MUST verify `data.lockId === lockId` after parsing lock data (consistent with other backends and provides defense-in-depth)
- **Expiry Check**: Parse JSON and apply `isLive()` predicate using `calculateRedisServerTimeMs()` and internal tolerance constant from `common/time-predicates.ts`
- **Data Transformation Requirement**: The Lua script returns full JSON lockData for atomicity. The backend's TypeScript lookup method MUST then parse this data, compute the required keyHash and lockIdHash using `hashKey()`, and return a sanitized `LockInfo<C>` object to the caller, strictly adhering to the common interface specification.
- **Return Value**: Return `null` if key doesn't exist or is expired; return `LockInfo<C>` for live locks (MUST include `fence` since Redis backend supports fencing)
- **Null Semantics**: Do not attempt to infer distinction between expired vs not-found in lookup results

## Implementation Architecture

- **Backend creation**: `createRedisBackend()` defines commands via `redis.defineCommand()`
- **Operations**: Use defined commands (e.g., `redis.acquireLock()`) when available
- **Test compatibility**: Falls back to `redis.eval()` for mocked Redis instances
- **Performance**: Sub-millisecond latency, 25k+ ops/sec with cached scripts
- **Lookup performance**: Direct key-value access provides consistently fast operations
- **lookup Implementation**: Required - supports both key and lockId lookup patterns for ownership checking using existing dual-key storage
- **Fence Type**: Redis backend uses `string` fence type to avoid JSON precision loss beyond 2^53-1

### Configuration Options

```typescript
interface RedisBackendConfig {
  keyPrefix?: string; // Default: "syncguard"
  cleanupInIsLocked?: boolean; // Default: false
  // ... other Redis-specific options
}

// Consistent behavior with unified tolerance
const redisBackend = createRedisBackend(); // 1000ms tolerance

// Add telemetry if needed
const observed = withTelemetry(redisBackend, {
  onEvent: (e) => console.log(e),
  includeRaw: false,
});
```

- **Unified tolerance**: 1000ms tolerance for consistent cross-backend behavior
- **keyPrefix**: Redis key prefix for namespacing
- **cleanupInIsLocked**: Enable optional cleanup in isLocked operation

### Key Naming

All key types use the common `makeStorageKey()` helper with 1KB practical limit:

- Main: `makeStorageKey(config.keyPrefix, key, 1000)`
- Index: `makeStorageKey(config.keyPrefix, `id:${lockId}`, 1000)`
- Fence: `makeStorageKey(config.keyPrefix, `fence:${key}`, 1000)`
- Default prefix: `"syncguard"`

### Required Lock Data Structure

```typescript
interface LockData {
  lockId: string; // For ownership verification
  expiresAtMs: number; // Millisecond timestamp
  acquiredAtMs: number; // Millisecond timestamp
  key: string; // Original user key
  fence: string; // Monotonic fencing token (19-digit zero-padded string)
}
```

### Fencing Token Implementation Pattern

Redis backends MUST always generate restart-survivable monotonic fencing tokens using the following pattern:

```lua
-- Fence Counter Increment Pattern (within acquire script):
-- fenceKey constructed from KEYS[3] parameter
-- key comes from ARGV[4] parameter

local fenceKey = KEYS[3]  -- Pre-constructed: "syncguard:fence:resource:123"
local fenceNumber = redis.call('INCR', fenceKey)
-- Format using common formatter pattern (backend MUST use consistent formatting)
-- Equivalent to formatFence() from common utilities: String(n).padStart(19, '0')
local fence = string.format("%019d", fenceNumber)
-- Store fence in lock data JSON and return with AcquireResult
```

**Required Implementation Details:**

- **Fence Key**: `{keyPrefix}:fence:{key}` (e.g., `"syncguard:fence:resource:123"`)
- **Key Consistency**: Fence keys MUST use identical key generation as lock keys (via common `makeStorageKey()` helper)
- **Atomicity**: `INCR` MUST be called within the same Lua script as lock acquisition
- **Persistence**: Fence counters survive Redis restarts (no TTL on fence keys)
- **Monotonicity**: Each successful `acquire()` increments the counter, ensuring strict ordering
- **Storage**: Store the fence value in `LockData.fence` and return in `AcquireResult.fence`
- **Format**: Redis uses 19-digit zero-padded decimal strings for lexicographic ordering and JSON safety

### Fence Key Lifecycle and Memory Considerations

**CRITICAL: Fence keys are intentionally persistent** and MUST NOT have TTL or be deleted:

```lua
-- ❌ NEVER do this - breaks monotonicity guarantee
redis.call('DEL', fenceKey)  -- Violates fencing safety
redis.call('EXPIRE', fenceKey, ttl)  -- Violates fencing safety
```

**Memory Growth**: Fence counters accumulate over the lifetime of the Redis instance. This is the correct behavior for fencing safety, but operators should consider:

- **Bounded key spaces**: Most applications use predictable lock keys → minimal memory impact
- **Unbounded key spaces**: Applications generating unlimited unique keys → fence keys grow indefinitely
- **Mitigation**: For unbounded scenarios, consider key normalization or application-level limits

**Operational Guidance**:

- Monitor fence key count via `redis-cli --scan --pattern "syncguard:fence:*" | wc -l`
- Each fence key is ~50-100 bytes (key name + 8-byte counter)
- 1M fence keys ≈ 50-100MB memory (typically acceptable)

**When to be concerned**: If your application generates >10M unique lock keys annually, evaluate key design patterns.

### Testing Strategy

- **Unit tests**: Mock Redis with `eval` method, no external dependencies
- **Integration tests**: Real Redis instance, validates `defineCommand()` caching
- **Performance tests**: Benchmarks latency, throughput, and script caching benefits
- **Behavioral compliance testing**: Unit tests MUST verify backend imports and uses `isLive()` and `calculateRedisServerTimeMs()` from `common/time-predicates.ts`, not custom implementations
- **Cross-backend consistency**: Integration tests MUST verify identical outcomes given same tolerance values between Redis and other backends
