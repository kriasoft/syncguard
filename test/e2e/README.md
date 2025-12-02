# E2E Tests

End-to-end tests that verify real-world usage patterns with actual backend instances.

## Test Files

### concurrent-workers.test.ts

Tests parallel workers competing for the same lock:

- Multiple concurrent lock attempts on same key
- Sequential execution under high contention
- Data integrity under concurrent load
- Rapid acquire/release cycles
- Parallel access to different resources

### cross-backend.test.ts

Tests cross-backend consistency (ADR-006):

- Fence format consistency (15-digit zero-padded)
- Time consistency (1000ms tolerance)
- Fence key 1:1 mapping
- Storage key truncation
- Monotonic fence sequences

### disposal-patterns.test.ts

Tests AsyncDisposable (`await using`) patterns:

- Automatic cleanup on scope exit
- Disposal behavior with errors
- Manual operations with disposal handle
- Nested disposal scopes
- Concurrent disposal

### lock-callback.test.ts

Tests high-level lock wrapper with callback pattern:

- Basic callback execution
- Error propagation from callback
- Return value from callback
- Automatic lock management
- Retry and timeout behavior

## Running Tests

```bash
# Run all E2E tests
bun test test/e2e/

# Run specific test file
bun test test/e2e/concurrent-workers.test.ts

# Run with longer timeout (for slow Firestore emulator)
bun test test/e2e/ --timeout 30000
```

## Prerequisites

Tests require running backend services:

- Redis server on localhost:6379
- PostgreSQL server on localhost:5432
- Firestore emulator on localhost:8080

Use `bun run redis` and `bun run firestore` to start services.

## Backend Selection

By default, tests run against all available backends. Use environment variables to select specific backends:

```bash
# Run only Redis tests
TEST_REDIS=true bun test test/e2e/

# Run Redis and Postgres only
TEST_REDIS=true TEST_POSTGRES=true bun test test/e2e/
```

## Test Pattern

All E2E tests follow this pattern:

```typescript
describe("E2E: Feature Name", async () => {
  const availableBackends = await getAvailableBackends();

  if (availableBackends.length === 0) {
    it.skip("No backends available", () => {});
    return;
  }

  for (const fixture of availableBackends) {
    describe(`${fixture.name}`, () => {
      let backend: LockBackend;
      let cleanup: () => Promise<void>;
      let teardown: () => Promise<void>;

      beforeAll(async () => {
        const setup = await fixture.setup();
        backend = setup.createBackend() as LockBackend;
        cleanup = setup.cleanup;
        teardown = setup.teardown;
      });

      beforeEach(async () => {
        await cleanup();
      });

      afterAll(async () => {
        await teardown();
      });

      // Tests here
    });
  }
});
```

## Known Issues

Firestore emulator can be slow, causing timing-sensitive tests to fail:

- Tests with tight timing expectations may need longer timeouts
- Parallel execution tests may serialize on slow emulators
- Use `--timeout 30000` flag when running Firestore tests
