# SyncGuard - Distributed Lock Library

TypeScript library for preventing race conditions across microservices using Firestore or Redis backends.

## Commands

```bash
npm run build      # Build to dist/
npm run typecheck  # Type check without emit
npm run format     # Prettier auto-format
npm run dev        # Watch mode
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
  index.ts         → createLock() wrapper with Redis client
  config.ts        → Redis-specific configuration
  retry.ts         → Retry logic
  types.ts         → Redis types (LockData, etc.)
```

## Implementation Requirements

### Performance (O(1) required)

- **Acquire/IsLocked**: Direct document access by key
- **Release/Extend**: Query by lockId field, then atomic update (O(log n) acceptable)

### Lock Operations

- **Acquire**: Atomic transaction, distinguish contention vs errors, cleanup expired locks
- **Release**: Query-then-verify ownership, idempotent, atomic deletion
- **Extend**: Query-then-verify ownership, reject expired locks
- **IsLocked**: Non-mutating, opportunistic cleanup

### Configuration Defaults

- TTL: 30 seconds
- Timeout: 5 seconds
- Max retries: 10
- Retry delay: 100ms

### Critical Behaviors

- Lock IDs: `crypto.randomUUID()` with timestamp fallback
- Firestore: Requires index on `lockId` field, uses key as document ID
- Redis: Uses atomic Lua scripts for race-free operations
- Both: Automatic TTL-based cleanup
- Error handling: Release failures logged but don't throw

### Module Exports

- Main: `syncguard` → Core types/utilities
- Submodules: `syncguard/firestore`, `syncguard/redis`, `syncguard/common`
- All exports use ES modules with TypeScript declarations

## Testing Approach

When testing changes:

1. Build the project: `npm run build`
2. Type check: `npm run typecheck`
3. Test examples manually:
   - `bun example/firestore.ts` (requires Firestore emulator or credentials)
   - `bun example/redis.ts` (requires local Redis)

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
