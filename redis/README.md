# Redis Backend

High-performance distributed locking using Redis as the backend. Ideal for sub-millisecond latency requirements and high-throughput scenarios.

## File Structure

```text
redis/
  backend.ts           → Redis LockBackend implementation using Lua scripts
  index.ts             → Convenience wrapper with Redis client setup
  scripts.ts           → Centralized Lua scripts for optimal caching
  config.ts            → Redis-specific configuration & validation
  types.ts             → Redis data structures (LockData, etc.)
  errors.ts            → Centralized Redis error mapping
  operations/
    acquire.ts         → Atomic acquire operation
    release.ts         → Atomic release operation
    extend.ts          → Atomic extend operation
    is-locked.ts       → Lock status check operation
    lookup.ts          → Lock lookup by key/lockId
    index.ts           → Operation exports
```

## Key Design Decisions

### Lua Scripts for Atomicity

All mutating operations use Lua scripts to ensure atomicity:

- **acquire**: Check expiration → increment fence → set lock + index
- **release**: Reverse lookup → verify ownership → delete both keys
- **extend**: Reverse lookup → verify ownership → update TTL

Scripts are cached via `ioredis.defineCommand()` for optimal performance (automatic `EVALSHA` usage).

### Dual-Key Storage Pattern

```text
syncguard:resource:123       → Lock data (JSON with lockId, fence, timestamps)
syncguard:id:{lockId}        → Reverse index (maps lockId → key)
syncguard:fence:resource:123 → Monotonic counter (persists indefinitely)
```

- **Main lock key**: Direct O(1) access for acquire/isLocked
- **Reverse index**: Enables keyless release/extend operations
- **Fence counter**: Persistent counter for fencing tokens (never deleted)

### Server Time Authority

Redis uses server time (`TIME` command) for all expiration checks, eliminating client clock drift issues. No NTP synchronization required on clients.

### Script Caching

`ioredis.defineCommand()` automatically caches Lua scripts:

1. First call: Script loaded via `SCRIPT LOAD`
2. Subsequent calls: Execute via `EVALSHA` (faster)
3. Fallback: Gracefully falls back to `EVAL` if needed

## Local Development

### Prerequisites

```bash
# Redis server running on localhost:6379
redis-server
```

### Testing

```bash
# Unit tests (mocked Redis client)
bun run test:unit redis

# Integration tests (requires Redis server)
bun run test:integration redis
```

## Configuration

```typescript
import { createRedisBackend } from "syncguard/redis";
import Redis from "ioredis";

const redis = new Redis();
const backend = createRedisBackend(redis, {
  keyPrefix: "myapp", // Namespace for all keys (default: "syncguard")
  cleanupInIsLocked: false, // Enable cleanup in isLocked (default: false)
});
```

## Performance Characteristics

- **Latency**: Sub-millisecond for local Redis, <10ms for remote
- **Throughput**: 25,000+ ops/sec with script caching
- **Script Caching**: Automatically uses `EVALSHA` for optimal performance

## Common Patterns

### Key Limits and Truncation

Redis keys should stay under 1KB. SyncGuard automatically truncates keys exceeding limits using hash-based truncation (see `common/crypto.ts` → `makeStorageKey()`).

### Memory Management

Fence counters persist indefinitely (required for fencing safety). Monitor memory usage:

```bash
# Count fence keys
redis-cli --scan --pattern "syncguard:fence:*" | wc -l

# Each fence key ≈ 50-100 bytes
# 1M fence keys ≈ 50-100MB (typically acceptable)
```

## Implementation References

- **Specification**: See `docs/specs/redis-backend.md` for complete implementation requirements
- **Common Interface**: See `docs/specs/interface.md` for shared LockBackend contract
- **ADRs**: See `docs/adr/` for architectural decisions
