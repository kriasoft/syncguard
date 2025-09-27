# Redis Backend Instructions

## Critical Redis Requirements

### Dual-Key Storage Pattern

- **Main lock**: `{keyPrefix}{userKey}` stores JSON lock data
- **Index key**: `{keyPrefix}id:{lockId}` stores `userKey` for reverse lookup
- Both keys MUST have identical TTL for consistency
- Use `redis.call('SET', key, data, 'EX', ttlSeconds)` for atomic set-with-TTL

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
- Pass all required data as KEYS and ARGV to avoid closure issues

### Script Implementation Patterns

**Acquisition Script** (`redis/scripts.ts`):

```lua
-- 1. Check existing lock and expiration
local existingData = redis.call('GET', lockKey)
if existingData then
  local data = cjson.decode(existingData)
  if data.expiresAt > currentTime then
    return 0  -- Still locked
  end
  -- Clean up expired lockId index
  if data.lockId then
    redis.call('DEL', keyPrefix .. 'id:' .. data.lockId)
  end
end
-- 2. Atomically set both keys with identical TTL
redis.call('SET', lockKey, lockData, 'EX', ttlSeconds)
redis.call('SET', lockIdKey, lockKey, 'EX', ttlSeconds)
return 1
```

**Release/Extend Pattern**:

```lua
-- 1. Get lockKey from lockId index
local lockKey = redis.call('GET', lockIdKey)
-- 2. Verify ownership by comparing lockId in lock data
local lockData = redis.call('GET', lockKey)
local data = cjson.decode(lockData)
if data.lockId ~= lockId then return 0 end
-- 3. Perform operation (delete for release, update for extend)
-- 4. Handle race conditions gracefully
```

### Redis Error Handling

Treat as transient: `ECONNRESET`, `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `Connection lost`, `Broken pipe`, `timeout`, `network`

### TTL Management

- Convert milliseconds to seconds: `Math.ceil(ttlMs / 1000)`
- Use Redis `EX` option, not separate `EXPIRE` calls
- Cleanup expired locks in `isLocked` operation (fire-and-forget)

### Implementation Architecture

- **Backend creation**: `createRedisBackend()` defines commands via `redis.defineCommand()`
- **Operations**: Use defined commands (e.g., `redis.acquireLock()`) when available
- **Test compatibility**: Falls back to `redis.eval()` for mocked Redis instances
- **Performance**: Sub-millisecond latency, 25k+ ops/sec with cached scripts

### Key Naming

- Main: `{config.keyPrefix}{userKey}`
- Index: `{config.keyPrefix}id:{lockId}`
- Default prefix: `"syncguard:"`

### Required Lock Data Structure

```typescript
interface LockData {
  lockId: string; // For ownership verification
  expiresAt: number; // Millisecond timestamp
  createdAt: number; // Millisecond timestamp
  key: string; // Original user key
}
```

### Testing Strategy

- **Unit tests**: Mock Redis with `eval` method, no external dependencies
- **Integration tests**: Real Redis instance, validates `defineCommand()` caching
- **Performance tests**: Benchmarks latency, throughput, and script caching benefits
