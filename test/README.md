# Testing Guide

## Quick Reference

| Test Type       | Command                    | Requirements | Use Case                 |
| --------------- | -------------------------- | ------------ | ------------------------ |
| **Unit**        | `bun run test:unit`        | None         | Development, CI/CD       |
| **Integration** | `bun run test:integration` | Redis        | End-to-end validation    |
| **Performance** | `bun run test:performance` | Redis        | Benchmarks, optimization |

## Commands

```bash
# Development (fast)
bun run test:unit          # Unit tests only (~100ms)
bun run test:watch         # Watch mode

# Full validation
bun run test:integration   # Real Redis required
bun run test:performance   # Benchmarks
bun run test:all           # Everything

# Redis management
bun run redis:start        # Start Docker Redis
bun run redis:stop         # Stop Docker Redis
```

## Test Structure

```bash
test/
├── unit/           # Mocked, fast, no dependencies
├── integration/    # Real Redis, end-to-end scenarios
└── performance/    # Latency, throughput, optimization
```

## Redis Setup

**Docker (recommended):**

```bash
bun run redis:start
```

**Local Redis:**

```bash
brew install redis && redis-server
```

**Remote Redis:**

```bash
export REDIS_URL="redis://host:6379"
```

## When to Use Each Test Type

- **Unit**: Business logic, error handling, config validation
- **Integration**: Redis compatibility, concurrency, data verification
- **Performance**: Optimization validation, regression detection

## Troubleshooting

**Redis issues:**

```bash
redis-cli ping                               # Test connection
docker-compose -f docker-compose.test.yml ps # Check container
bun run redis:logs                           # View logs
```

**Test debugging:**

```bash
bun test test/unit/redis-backend.test.ts     # Specific file
bun test --testNamePattern="acquire lock"    # Single test
bun test --verbose                           # Detailed output
```
