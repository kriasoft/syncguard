---
applyTo: "redis/**/*"
---

# Redis Backend Instructions

## Critical Redis Requirements

### Dual-Key Storage Pattern

- **Main lock**: `{keyPrefix}{userKey}` stores JSON lock data
- **Index key**: `{keyPrefix}id:{lockId}` stores `userKey` for reverse lookup
- Both keys MUST have identical TTL for consistency
- Use `redis.call('SET', key, data, 'EX', ttlSeconds)` for atomic set-with-TTL

### Lua Scripts for Atomicity

- ALL mutating operations MUST use Lua scripts
- Scripts MUST be stored as const strings with descriptive comments
- Use `cjson.decode()/cjson.encode()` for JSON handling in Lua
- Return 1 for success, 0 for failure from scripts
- Pass all required data as KEYS and ARGV to avoid closure issues

### Lock Acquisition Pattern

```lua
-- Check existing lock expiration before acquisition
local existingData = redis.call('GET', lockKey)
if existingData then
  local data = cjson.decode(existingData)
  if data.expiresAt > currentTime then
    return 0  -- Still locked
  end
  -- Clean up expired lockId index before overwriting
end
-- Atomically set both keys with TTL
```

### Release/Extend Pattern

```lua
-- 1. Get lockKey from lockId index
-- 2. Verify ownership by comparing lockId in lock data
-- 3. Perform operation only if ownership verified
-- 4. Handle race conditions (missing keys, changed ownership)
```

### Redis Error Handling

Treat as transient: `ECONNRESET`, `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `Connection lost`, `Broken pipe`, `timeout`, `network`

### TTL Management

- Convert milliseconds to seconds: `Math.ceil(ttlMs / 1000)`
- Use Redis `EX` option, not separate `EXPIRE` calls
- Cleanup expired locks in `isLocked` operation (fire-and-forget)

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
