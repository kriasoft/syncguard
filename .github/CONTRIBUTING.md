# Contributing to SyncGuard

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- **Bun**: Install from [bun.sh](https://bun.sh)
- **Docker** (for integration tests): Any recent version
- **Node.js**: 18+ (Bun handles this, but good to have)

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
   bun test            # All tests including integration
   ```

## Development Workflow

### Making Changes

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Write your code** following existing patterns
3. **Add tests** for new functionality
4. **Run the full test suite**:

   ```bash
   bun run typecheck   # Type checking
   bun run format      # Auto-format code
   bun test            # All tests
   ```

### Testing Strategy

- **Unit tests**: `bun run test:unit` - Fast, mocked dependencies
- **Integration tests**: `bun run test:integration` - Requires Redis
- **Performance tests**: `bun run test:performance` - Optional benchmarks

To run integration tests locally:

```bash
# Start backends (in separate terminals)
bun run redis       # Redis on localhost:6379
bun run firestore   # Firestore emulator on localhost:8080

# Run integration tests
bun run test:integration
```

### Code Standards

- **Functional style**: Pure functions, immutable data, `const` over `let`, avoid classes
- **TypeScript**: Strict mode, ESNext target, noUncheckedIndexedAccess
- **Formatting**: Prettier with default config (auto-runs on commit)
- **Headers**: SPDX license identifiers required
- **Exports**: Named exports preferred, tree-shakable modules
- **JSDoc**: Required for all public APIs
- **Error handling**: Primary API throws `LockError`, manual ops return `LockResult`
- **Tests**: Cover new functionality, especially edge cases

## Submitting Changes

1. **Commit your changes**:

   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

   Pre-commit hooks will automatically format code and run type checks.

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
redis/              # Redis backend implementation
index.ts            # Main exports

test/
├── unit/           # Fast unit tests
├── integration/    # Backend integration tests
└── performance/    # Performance benchmarks

docs/               # VitePress documentation site
specs/              # Technical specifications and ADRs
```

## Types of Contributions

- **Bug fixes**: Always welcome (include test case demonstrating the bug)
- **New backends**: Follow `specs/interface.md` and existing patterns (Redis/Firestore)
- **Performance improvements**: Include benchmarks showing improvement
- **Documentation**: Especially examples, edge cases, and troubleshooting
- **Tests**: Better coverage is always good
- **Spec reviews & improvements**: Review `specs/` directory and propose architectural improvements
  - Identify inconsistencies or ambiguities in specs
  - Suggest new ADRs for design decisions
  - Improve spec clarity and completeness
  - Validate that implementation matches specs

## Design Principles

When contributing, follow these key principles from CLAUDE.md:

- **No over-engineering** - Keep it simple and pragmatic
- **Design APIs that are predictable, composable, and hard to misuse**
- **Record decisions in ADRs** (specs/adrs.md) as you go, not retroactively
- **Make testability a first-class design constraint**
- **Prioritize correctness and safety over micro-optimizations**
- **Expose the smallest possible public API that solves the problem**

### Backend Implementation Requirements

If contributing a new backend, ensure:

- [ ] Implements full `LockBackend` interface (specs/interface.md)
- [ ] Uses `isLive()` from `common/time-predicates.ts` (no custom time logic)
- [ ] Uses `makeStorageKey()` for key truncation (ADR-006)
- [ ] Uses `formatFence()` for 19-digit zero-padded fence tokens (ADR-004-R2)
- [ ] Implements TOCTOU protection for release/extend (ADR-003)
- [ ] Explicit ownership verification after reverse mapping
- [ ] Comprehensive unit and integration tests
- [ ] Backend-specific spec document (follow specs/redis.md or specs/firestore.md pattern)

## Getting Help

- **Questions**: Open a [discussion](https://github.com/kriasoft/syncguard/discussions)
- **Discord**: Join [Kriasoft Discord](https://discord.gg/EnbEa7Gsxg) #syncguard channel
- **Bugs**: Check [existing issues](https://github.com/kriasoft/syncguard/issues) first
- **Ideas**: Start with a discussion before coding to align on approach
- **Documentation**: See [docs site](https://kriasoft.com/syncguard/) and specs/ directory

## Code of Conduct

Be respectful, inclusive, and constructive. We're all here to build something useful together.
