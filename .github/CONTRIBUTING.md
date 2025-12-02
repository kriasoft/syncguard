# Contributing to SyncGuard

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- **Node.js** 20+ (matches `engines` in package.json)
- **Bun** (for install/scripts): [bun.sh](https://bun.sh)
- **Docker** (optional): Runs Redis via `bun run redis`
- **PostgreSQL** 14+ on `localhost:5432` (for integration tests)
- **Firestore emulator** (`bun run firestore`) for Firestore integration tests

## Quick Start

1. **Fork and clone**:

   ```bash
   git clone https://github.com/your-username/syncguard.git
   cd syncguard
   ```

2. **Install dependencies**:

   ```bash
   bun install
   ```

3. **Run tests**:

   ```bash
   bun run test        # Unit tests (fast)
   bun run test:all    # Full suite (unit, integration, performance)
   ```

## Development Workflow

### Making Changes

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Write your code** following existing patterns
3. **Add tests** for new functionality
4. **Validate locally**:

   ```bash
   bun run format      # Prettier
   bun run typecheck   # Both tsconfig targets
   bun run test        # Unit tests
   bun run test:all    # Optional: full suite before PR
   ```

### Testing Strategy

- **Unit tests**: `bun run test:unit` - Fast, mocked dependencies
- **Integration tests**: `bun run test:integration` - Requires Redis, PostgreSQL, and Firestore
- **Performance tests**: `bun run test:performance` - Optional benchmarks

To run integration tests locally:

```bash
# Start backends (in separate terminals or as background services)
bun run redis       # Redis on localhost:6379
bun run firestore   # Firestore emulator on localhost:8080
# PostgreSQL on localhost:5432 (install separately)

# Run integration tests
bun run test:integration
```

### Code Standards

- **TypeScript**: Strict, ESNext, `noUncheckedIndexedAccess` enabled
- **Formatting**: Prettier (`bun run format`); pre-commit hooks run prettier + targeted `tsc` on touched backend files
- **Headers**: SPDX license identifiers on source files
- **Exports**: Prefer named exports; keep modules tree-shakable
- **Error handling**: Public API throws `LockError` for system errors; mutation ops return `{ ok: boolean }` results
- **JSDoc**: Required for public APIs
- **Tests**: Add coverage for new behavior and edge cases

## Submitting Changes

1. **Commit your changes**:

   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

   Pre-commit hooks will format staged files and run targeted type checks.

2. **Push and create PR**:

   ```bash
   git push origin feature/your-feature-name
   ```

3. **PR checklist**:
   - [ ] Tests pass locally
   - [ ] Code is formatted
   - [ ] TypeScript compiles without errors
   - [ ] New functionality has tests
   - [ ] Documentation updated if needed

## Project Structure

```bash
# Source files at project root (not in src/)
common/             # Core interfaces and utilities
firestore/          # Firestore backend implementation
postgres/           # PostgreSQL backend implementation
redis/              # Redis backend implementation
index.ts            # Main exports

test/
├── unit/           # Fast unit tests
├── integration/    # Backend integration tests
└── performance/    # Performance benchmarks

docs/               # VitePress documentation site
├── specs/          # Technical specifications
└── adr/            # Architectural decision records
```

## Types of Contributions

- **Bug fixes**: Always welcome (include test case demonstrating the bug)
- **New backends**: Follow `docs/specs/interface.md` and existing patterns (Redis/PostgreSQL/Firestore)
- **Performance improvements**: Include benchmarks showing improvement
- **Documentation**: Especially examples, edge cases, and troubleshooting
- **Tests**: Better coverage is always good
- **Spec reviews & improvements**: Review `docs/specs/` and `docs/adr/` directories and propose architectural improvements
  - Identify inconsistencies or ambiguities in specs
  - Suggest new ADRs for design decisions
  - Improve spec clarity and completeness
  - Validate that implementation matches specs

## Design Principles

When contributing, follow these key principles from CLAUDE.md:

- **No over-engineering** - Keep it simple and pragmatic
- **Design APIs that are predictable, composable, and hard to misuse**
- **Record decisions in ADRs** (`docs/adr/`) as you go, not retroactively
- **Make testability a first-class design constraint**
- **Prioritize correctness and safety over micro-optimizations**
- **Expose the smallest possible public API that solves the problem**

### Backend Implementation Requirements

If contributing a new backend, ensure:

- [ ] Implements full `LockBackend` interface (`docs/specs/interface.md`)
- [ ] Uses `isLive()` from `common/time-predicates.ts` (no custom time logic)
- [ ] Uses `makeStorageKey()` for key generation with two-step fence pattern (`docs/specs/interface.md#fence-key-derivation`, ADR-006)
- [ ] Uses `formatFence()` for 15-digit zero-padded fence tokens (ADR-004)
- [ ] Implements TOCTOU protection for release/extend (ADR-003)
- [ ] Explicit ownership verification after reverse mapping
- [ ] Comprehensive unit and integration tests
- [ ] Backend-specific spec document (follow `docs/specs/redis-backend.md`, `docs/specs/postgres-backend.md`, or `docs/specs/firestore-backend.md` pattern)

## Getting Help

- **Questions**: Open a [discussion](https://github.com/kriasoft/syncguard/discussions)
- **Discord**: Join [Kriasoft Discord](https://discord.gg/EnbEa7Gsxg) #syncguard channel
- **Bugs**: Check [existing issues](https://github.com/kriasoft/syncguard/issues) first
- **Ideas**: Start with a discussion before coding to align on approach
- **Documentation**: See [docs site](https://kriasoft.com/syncguard/) and `docs/specs/` directory

## Code of Conduct

Be respectful, inclusive, and constructive. We're all here to build something useful together.
