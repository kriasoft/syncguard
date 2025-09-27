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
   bun test      # All tests
   ```

### Testing Strategy

- **Unit tests**: `bun run test` - Fast, mocked dependencies
- **Integration tests**: `bun run test:integration` - Requires Redis
- **Performance tests**: `bun run test:performance` - Optional benchmarks

To run integration tests locally:

```bash
bun run redis:start    # Start Redis via Docker
bun run test:integration
bun run redis:stop     # Clean up
```

### Code Standards

- **TypeScript**: Strict mode, functional style preferred
- **Formatting**: Prettier handles this automatically
- **Exports**: Named exports, tree-shakable modules
- **Comments**: JSDoc for public APIs only
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
src/
├── common/         # Core interfaces and utilities
├── firestore/      # Firestore backend implementation
├── redis/          # Redis backend implementation
└── index.ts        # Main exports

test/
├── unit/           # Fast unit tests
├── integration/    # Backend integration tests
└── performance/    # Performance benchmarks
```

## Types of Contributions

- **Bug fixes**: Always welcome
- **New backends**: Follow existing backend patterns
- **Performance improvements**: Include benchmarks
- **Documentation**: Especially examples and edge cases
- **Tests**: Better coverage is always good

## Getting Help

- **Questions**: Open a GitHub discussion or join our [Discord](https://discord.gg/EnbEa7Gsxg)
- **Bugs**: Check existing issues first
- **Ideas**: Start with a discussion before coding

## Code of Conduct

Be respectful, inclusive, and constructive. We're all here to build something useful together.

---

**Questions?** Feel free to ask in issues or discussions. Thanks for contributing! 🎉
