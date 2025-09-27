# SyncGuard - Distributed Lock Library

TypeScript library for preventing race conditions across microservices using Firestore or Redis backends.

## Commands

```bash
bun run build      # Build to dist/
bun run typecheck  # Type check without emit
bun run format     # Prettier auto-format
bun run dev        # Watch mode
```

## Architecture

### Core API Design

```typescript
// Primary pattern - auto-managed locks
const lock = createLock(backend);
await lock(
  async () => {
    // critical section
  },
  { key: "resource:123" },
);

// Manual control when needed
const result = await lock.acquire({ key: "resource:123" });
if (result.success) {
  try {
    /* work */
  } finally {
    await lock.release(result.lockId);
  }
}
```

### Backend Interface

```typescript
interface LockBackend {
  acquire: (config: LockConfig) => Promise<LockResult>;
  release: (lockId: string) => Promise<boolean>;
  extend: (lockId: string, ttl: number) => Promise<boolean>;
  isLocked: (key: string) => Promise<boolean>;
}

type LockResult =
  | { success: true; lockId: string; expiresAt: Date }
  | { success: false; error: string };
```

### File Structure

```text
index.ts           → Core exports for custom backends
specs/
  firestore.md     → Firestore backend implementation requirements
  redis.md         → Redis backend implementation requirements
common/
  backend.ts       → LockBackend interface, createLock factory, utilities
  index.ts         → Re-exports
firestore/
  backend.ts       → Firestore implementation of LockBackend
  index.ts         → createLock() wrapper with Firestore instance
  config.ts        → Firestore-specific configuration
  retry.ts         → Retry logic with exponential backoff
  types.ts         → Firestore types (LockDocument, etc.)
redis/
  backend.ts       → Redis implementation using Lua scripts
  scripts.ts       → Centralized Lua scripts for script caching
  index.ts         → createLock() wrapper with Redis client
  config.ts        → Redis-specific configuration
  retry.ts         → Retry logic
  types.ts         → Redis types (LockData, etc.)
```

## Implementation Requirements

**Backend-specific requirements**: See `specs/firestore.md` and `specs/redis.md`

### Key Design Principles

- **Performance**: O(1) acquire/isLocked, O(log n) release/extend acceptable
- **Atomicity**: All operations use transactions (Firestore) or Lua scripts (Redis)
- **Lock IDs**: `crypto.randomUUID()` with timestamp fallback
- **TTL-based cleanup**: Automatic expiration handling
- **Error distinction**: Separate lock contention from system errors

### Module Exports

- Main: `syncguard` → Core types/utilities
- Submodules: `syncguard/firestore`, `syncguard/redis`, `syncguard/common`
- All exports use ES modules with TypeScript declarations

## Testing Approach

**Hybrid testing strategy** - See `test/README.md` for details

### Development workflow

1. **Unit tests**: `bun run test` (fast, mocked dependencies)
2. **Build/typecheck**: `bun run build && bun run typecheck`
3. **Integration tests**: `bun run test:integration` (requires Redis)
4. **Performance validation**: `bun run test:performance` (optional)

## Code Standards

- **Functional style**: Pure functions, immutable data, `const` over `let`, avoid classes
- **TypeScript**: Strict mode, ESNext target, noUncheckedIndexedAccess
- **Formatting**: Prettier with default config
- **Headers**: SPDX license identifiers required
- **Exports**: Named exports preferred, tree-shakable modules
- **Error handling**: Primary API throws `LockError`, manual ops return `LockResult`
- **Error messages**: Include context (key, lockId) in all errors
- **Peer dependencies**: Optional - users install only what they need
- **JSDoc**: Required for all public APIs
