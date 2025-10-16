# Testing Guide

## Quick Reference

| Test Type       | Command                    | Requirements | Use Case                 |
| --------------- | -------------------------- | ------------ | ------------------------ |
| **Unit**        | `bun run test:unit`        | None         | Development, CI/CD       |
| **Integration** | `bun run test:integration` | Redis        | End-to-end validation    |
| **Performance** | `bun run test:performance` | Redis        | Benchmarks, optimization |

## Commands

```bash
bun run redis              # Launch Redis via Docker
run run firestore          # Launch Firestore emulator

# Development (fast)
bun run test:unit          # Unit tests only (~100ms)
bun run test:watch         # Watch mode

# Full validation
bun run test:integration   # Real Redis required
bun run test:performance   # Benchmarks
bun run test:all           # Everything
```

## Test Structure

```bash
test/
├── unit/           # Mocked, fast, no dependencies
├── integration/    # Real Redis, end-to-end scenarios
└── performance/    # Latency, throughput, optimization
```

## Connection Settings

```bash
POSTGRES_URL=postgres://postgres@localhost:5432/syncguard
REDIS_URL=redis://host:6379
```

## When to Use Each Test Type

- **Unit**: Business logic, error handling, config validation
- **Integration**: Redis compatibility, concurrency, data verification
- **Performance**: Optimization validation, regression detection

## Troubleshooting

**Redis issues:**

```bash
redis-cli ping                               # Test connection
docker ps                                    # Check container
docker logs redis-test                       # View logs
```

**Test debugging:**

```bash
bun test test/unit/redis-backend.test.ts     # Specific file
bun test --testNamePattern="acquire lock"    # Single test
bun test --verbose                           # Detailed output
```
