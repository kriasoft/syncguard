# Testing Guide

## Quick Reference

| Test Type      | Command                   | Requirements | Use Case                   |
| -------------- | ------------------------- | ------------ | -------------------------- |
| **Unit**       | `bun run test:unit`       | None         | Development, CI/CD         |
| **Contracts**  | `bun run test:contracts`  | Backend(s)   | API compliance per backend |
| **E2E**        | `bun run test:e2e`        | All backends | Real-world patterns        |
| **Benchmarks** | `bun run test:benchmarks` | Redis        | Performance validation     |

## Test Structure

```
test/
├── unit/                   # Fast tests (mocks only) - always runs
│   ├── common/             # Common module tests
│   ├── disposable/         # Disposal pattern tests
│   ├── backends/           # Backend-specific unit tests (mocked I/O)
│   └── *.test.ts           # Other unit tests
│
├── fixtures/               # Shared test infrastructure
│   ├── backends.ts         # Backend fixture registry
│   ├── redis.fixture.ts    # Redis lifecycle helpers
│   ├── postgres.fixture.ts # Postgres lifecycle helpers
│   └── firestore.fixture.ts# Firestore lifecycle helpers
│
├── contracts/              # Backend API contract tests
│   ├── lock-lifecycle.ts   # acquire → release flow
│   ├── lock-contention.ts  # Concurrent access
│   ├── lock-expiration.ts  # TTL and extend
│   ├── fence-monotonicity.ts # ADR-004 compliance
│   └── ...                 # Other contract tests
│
├── e2e/                    # Multi-step end-to-end flows
│   ├── concurrent-workers.ts   # Parallel workers
│   ├── cross-backend.ts        # ADR-006 consistency
│   ├── disposal-patterns.ts    # Real await using
│   └── lock-callback.ts        # createLock() pattern
│
└── benchmarks/             # Performance benchmarks (opt-in)
    ├── latency.bench.ts    # Single operation latency
    ├── throughput.bench.ts # Concurrent load
    └── memory.bench.ts     # Resource usage
```

## Commands

```bash
# Start backends
bun run redis              # Launch Redis via Docker
bun run firestore          # Launch Firestore emulator

# Development (fast)
bun run test:unit          # Unit tests only (~500ms)
bun run test:watch         # Watch mode

# Contract tests (per-backend API compliance)
bun run test:contracts     # All available backends

# E2E tests (real-world flows)
bun run test:e2e           # Requires all backends

# Full validation
bun run test:ci            # Unit + contracts + e2e
bun run test:all           # Same as test:ci

# Benchmarks (opt-in)
bun run test:benchmarks    # Requires RUN_BENCHMARKS=1
```

## Folder Semantics

| Folder        | Purpose                                  | Backends         | CI Behavior            |
| ------------- | ---------------------------------------- | ---------------- | ---------------------- |
| `unit/`       | Pure logic, mocked I/O                   | None             | Always runs            |
| `contracts/`  | API guarantees each backend must satisfy | One per test run | Matrix: one per job    |
| `e2e/`        | Multi-step flows, real-world patterns    | As available     | Runs with all backends |
| `benchmarks/` | Performance measurement                  | As available     | Opt-in via env var     |

## Environment Variables

| Variable         | Default     | Purpose                 |
| ---------------- | ----------- | ----------------------- |
| `TEST_REDIS`     | `true`      | Enable Redis tests      |
| `TEST_POSTGRES`  | `true`      | Enable Postgres tests   |
| `TEST_FIRESTORE` | `true`      | Enable Firestore tests  |
| `REDIS_URL`      | `localhost` | Redis server URL        |
| `POSTGRES_URL`   | `localhost` | Postgres connection URL |
| `RUN_BENCHMARKS` | `false`     | Enable benchmark tests  |

## Backend Fixtures

Tests use a fixture registry pattern for backend-agnostic testing:

```typescript
import { getAvailableBackends } from "../fixtures/backends.js";

describe("My Contract", async () => {
  const backends = await getAvailableBackends();

  for (const fixture of backends) {
    describe(fixture.name, () => {
      let backend: LockBackend;

      beforeAll(async () => {
        backend = await fixture.setup();
      });

      afterAll(async () => {
        await fixture.teardown();
      });

      it("should work", async () => {
        // Test code
      });
    });
  }
});
```

## Contracts vs E2E

**Contract tests** verify each backend implements `LockBackend` correctly:

- Single operations (acquire, release, extend, isLocked, lookup)
- Edge cases (invalid inputs, expired locks, ownership)
- Format compliance (fence tokens, error codes)

**E2E tests** verify real-world usage patterns:

- Multiple operations in sequence
- Cross-backend portability
- Integration with disposal patterns

## Troubleshooting

**Backend issues:**

```bash
redis-cli ping                           # Test Redis
psql $POSTGRES_URL -c "SELECT 1"         # Test Postgres
curl -s http://localhost:8080            # Test Firestore
```

**Test debugging:**

```bash
bun test test/unit/disposable/           # Specific folder
bun test --testNamePattern="acquire"     # By name pattern
bun test --verbose                       # Detailed output
```

**Running single backend:**

```bash
TEST_REDIS=true TEST_POSTGRES=false TEST_FIRESTORE=false bun run test:contracts
```
