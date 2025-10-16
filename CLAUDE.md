# SyncGuard - Distributed Lock Library

TypeScript library for preventing race conditions across microservices using Redis, PostgreSQL, or Firestore backends.

## Commands

```bash
bun run build      # Build to dist/
bun run typecheck  # Type check without emit
bun run format     # Prettier auto-format
bun run dev        # Watch mode
```

## Architecture

### Core API Design

See `specs/interface.md` for complete API examples, usage patterns, LockBackend interface specification, and type definitions.

### Project Structure

```text
Core:
  index.ts               → Public API exports for custom backends
  common/                → Shared utilities, types, and core functionality
    (See common/README.md for detailed structure)

Backends:
  redis/                 → Redis backend implementation (see redis/README.md)
  postgres/              → PostgreSQL backend implementation (see postgres/README.md)
  firestore/             → Firestore backend implementation (see firestore/README.md)

Documentation:
  specs/                 → Technical specifications
    README.md            → Spec navigation & reading order
    interface.md         → LockBackend API contracts & usage examples
    redis-backend.md     → Redis backend specification
    postgres-backend.md  → PostgreSQL backend specification
    firestore-backend.md → Firestore backend specification
    adrs.md              → Architectural decision records
  docs/                  → Documentation site (https://kriasoft.com/syncguard/)
```

## Implementation Requirements

**Backend-specific requirements**: See `specs/interface.md`, `specs/redis-backend.md`, `specs/postgres-backend.md`, and `specs/firestore-backend.md`

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
- Submodules: `syncguard/redis`, `syncguard/postgres`, `syncguard/firestore`, `syncguard/common`
- All exports use ES modules with TypeScript declarations

## Testing Approach

**Hybrid testing strategy** - See `test/README.md` for details

Assume that:

- Redis server is already running on localhost:6379
- PostgreSQL server is already running on localhost:5432
- Firestore emulator is already running on localhost:8080

### Development workflow

1. **Unit tests**: `bun run test:unit` (fast, mocked dependencies)
2. **Build/typecheck**: `bun run build && bun run typecheck`
3. **Integration tests**: `bun run test:integration` (requires Redis, PostgreSQL, and Firestore emulator)
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
