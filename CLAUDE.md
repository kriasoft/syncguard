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

See `specs/interface.md` for complete API examples,usage patterns, LockBackend interface specification, and type definitions.

### File Structure

```text
Core:
  index.ts              → Public API exports for custom backends
  common/
    backend.ts          → Main entry point re-exporting from focused modules
    index.ts            → Re-exports from common module
    types.ts            → Core interfaces, types & capabilities
    constants.ts        → Configuration constants & defaults
    errors.ts           → LockError class & error handling
    validation.ts       → Key & lockId validation helpers
    crypto.ts           → Cryptographic functions (lockId generation, hashing)
    helpers.ts          → Utility functions (getByKey, owns, sanitizeLockInfo)
    auto-lock.ts        → Auto-managed lock functionality (createAutoLock, lock)
    config.ts           → Configuration merge helpers
    telemetry.ts        → Observability & telemetry decorators

Backends:
  firestore/
    backend.ts          → Firestore LockBackend implementation
    index.ts            → Convenience wrapper with Firestore client setup
    config.ts           → Firestore-specific configuration & validation
    types.ts            → Firestore document schemas (LockDocument, etc.)
    errors.ts           → Centralized Firestore error mapping
    operations/
      acquire.ts        → Atomic acquire operation
      release.ts        → Atomic release operation
      extend.ts         → Atomic extend operation
      is-locked.ts      → Lock status check operation
      lookup.ts         → Lock lookup by key/lockId (renamed from get-lock-info.ts)
      index.ts          → Operation exports
  redis/
    backend.ts          → Redis LockBackend implementation using Lua scripts
    index.ts            → Convenience wrapper with Redis client setup
    scripts.ts          → Centralized Lua scripts for optimal caching
    config.ts           → Redis-specific configuration & validation
    types.ts            → Redis data structures (LockData, etc.)
    errors.ts           → Centralized Redis error mapping
    operations/
      acquire.ts        → Atomic acquire operation
      release.ts        → Atomic release operation
      extend.ts         → Atomic extend operation
      is-locked.ts      → Lock status check operation
      lookup.ts         → Lock lookup by key/lockId (renamed from get-lock-info.ts)
      index.ts          → Operation exports

Documentation:
  specs/
    interface.md        → LockBackend API contracts & usage examples
    firestore.md        → Firestore backend implementation requirements
    redis.md            → Redis backend implementation requirements
    adrs.md             → Architectural decision records
  docs/                 → Documentation site (https://kriasoft.com/syncguard/)
```

## Implementation Requirements

**Backend-specific requirements**: See `specs/interface.md`, `specs/firestore.md` and `specs/redis.md`

### Key Design Principles

- No over-engineering - keep it simple and pragmatic.
- Design APIs that are predictable, composable, and hard to misuse.
- Record decisions in lightweight ADRs as you go, not retroactively.
- Make testability a first-class design constraint, not an afterthought.
- Performance: O(1) acquire/isLocked, O(log n) release/extend acceptable
- Prioritize correctness and safety over micro-optimizations.
- Expose the smallest possible public API that solves the problem.
- Prioritize optimal, simple and elegant API over backwards compatibility.

### Module Exports

- Main: `syncguard` → Core types/utilities
- Submodules: `syncguard/firestore`, `syncguard/redis`, `syncguard/common`
- All exports use ES modules with TypeScript declarations

## Testing Approach

**Hybrid testing strategy** - See `test/README.md` for details

Assume that:

- Redis server is already running on localhost:6379
- Firestore emulator is already running on localhost:8080

### Development workflow

1. **Unit tests**: `bun run test:unit` (fast, mocked dependencies)
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
