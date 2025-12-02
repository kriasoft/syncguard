# Test Fixtures

Backend fixture infrastructure for SyncGuard integration tests.

## Overview

This directory contains test fixtures for all supported backends (Redis, PostgreSQL, Firestore). Fixtures provide:

- **Availability checking**: Test if backend is accessible before running tests
- **Setup/teardown lifecycle**: Clean initialization and cleanup of test environments
- **Backend creation**: Factory methods that return properly configured backend instances
- **Environment filtering**: Enable/disable backends via environment variables

## Quick Start

```typescript
import { getAvailableBackends, setupBackend } from "./fixtures/backends.js";

// Get all available backends (checks connectivity)
const available = await getAvailableBackends();

// Setup a backend for testing
const fixture = await setupBackend(available[0]);

try {
  // Use fixture.backend for tests
  const result = await fixture.backend.acquire({
    key: "test-key",
    ttlMs: 30000,
  });
  // ... test code ...
} finally {
  // Always cleanup and teardown
  await fixture.cleanup();
  await fixture.teardown();
}
```

## Fixture Structure

Each backend fixture implements:

- `name`: Human-readable backend name
- `kind`: Backend type discriminant ("redis" | "postgres" | "firestore")
- `envVar`: Environment variable to enable/disable backend
- `available()`: Async check for backend connectivity
- `setup()`: Initialize backend and return lifecycle methods
  - `createBackend()`: Factory for backend instance
  - `cleanup()`: Remove test data (between tests)
  - `teardown()`: Close connections (after all tests)

## Environment Variables

Control which backends are tested via environment variables:

```bash
# Test all available backends (default)
bun test

# Test only Redis
TEST_REDIS=true bun test

# Test Redis and Firestore
TEST_REDIS=true TEST_FIRESTORE=true bun test
```

Available environment variables:

- `TEST_REDIS`: Enable Redis backend tests
- `TEST_POSTGRES`: Enable PostgreSQL backend tests
- `TEST_FIRESTORE`: Enable Firestore backend tests

If no environment variables are set, all backends are tested (if available).

## Backend Configuration

### Redis

- Host: `localhost:6379`
- Database: 15 (dedicated test database)
- Key prefix: `syncguard:test:`

### PostgreSQL

- URL: `postgres://postgres@localhost:5432/syncguard` (default)
- Override via `POSTGRES_URL` environment variable
- Table prefix: `syncguard_test_`

### Firestore

- Host: `localhost:8080` (emulator)
- Project ID: `syncguard-test`
- Collection: `syncguard_test_locks`
- Fence collection: `syncguard_test_fences`

## API Reference

### `getEnabledBackends()`

Returns backends enabled via environment variables. If no env vars are set, returns all backends.

```typescript
const enabled = getEnabledBackends();
// Returns: BackendFixture[]
```

### `getAvailableBackends()`

Returns backends that are both enabled and actually available (performs async connectivity checks).

```typescript
const available = await getAvailableBackends();
// Returns: Promise<BackendFixture[]>
```

### `setupBackend(fixture)`

Initializes a backend fixture for testing.

```typescript
const result = await setupBackend(fixture);
// Returns: Promise<BackendFixtureResult>
```

**BackendFixtureResult**:

```typescript
{
  name: string;
  kind: "redis" | "postgres" | "firestore";
  backend: LockBackend<Capabilities>;
  cleanup(): Promise<void>;  // Remove test data
  teardown(): Promise<void>; // Close connections
}
```

## Usage Patterns

### Single Backend Test

```typescript
import { describe, it } from "bun:test";
import { redisFixture } from "./fixtures/redis.fixture.js";

describe("Redis-specific tests", () => {
  let fixture: Awaited<ReturnType<typeof redisFixture.setup>>;

  beforeAll(async () => {
    fixture = await redisFixture.setup();
  });

  afterAll(async () => {
    await fixture.teardown();
  });

  beforeEach(async () => {
    await fixture.cleanup();
  });

  it("should test something", async () => {
    const backend = fixture.createBackend();
    // ... test code ...
  });
});
```

### Multi-Backend Test

```typescript
import { describe, it } from "bun:test";
import { getAvailableBackends, setupBackend } from "./fixtures/backends.js";

const backends = await getAvailableBackends();

backends.forEach((fixture) => {
  describe(`${fixture.name} backend`, () => {
    let result: Awaited<ReturnType<typeof setupBackend>>;

    beforeAll(async () => {
      result = await setupBackend(fixture);
    });

    afterAll(async () => {
      await result.teardown();
    });

    beforeEach(async () => {
      await result.cleanup();
    });

    it("should acquire and release locks", async () => {
      const lock = await result.backend.acquire({
        key: "test",
        ttlMs: 30000,
      });
      // ... test code ...
    });
  });
});
```

## Implementation Details

### Redis Fixture

- Uses ioredis client
- Database 15 isolation prevents conflicts with other data
- Connection pooling disabled for test isolation
- 2-second timeout for availability checks

### PostgreSQL Fixture

- Uses postgres.js client
- Dedicated test tables with prefix
- Schema setup via `setupSchema()`
- Connection pooling for performance

### Firestore Fixture

- Uses @google-cloud/firestore client
- Dedicated test collections
- Emulator-specific configuration
- Health check with 2-second timeout
- Force terminate to prevent hanging

## Troubleshooting

### Tests Timeout

If tests timeout during availability checks:

1. Verify backend is running:

   ```bash
   # Redis
   redis-cli ping

   # PostgreSQL
   psql postgres://postgres@localhost:5432/syncguard -c "SELECT 1"

   # Firestore
   curl http://localhost:8080
   ```

2. Check firewall/network settings

3. Increase test timeouts (see `backends.test.ts` for examples)

### Cleanup Failures

If cleanup between tests fails:

1. Check backend is still responsive
2. Verify test data is properly namespaced
3. Ensure no lingering connections from previous tests

### Connection Leaks

If you see "too many connections" errors:

1. Always call `teardown()` in `afterAll`
2. Use `finally` blocks to ensure cleanup
3. Check for uncaught exceptions that skip teardown
