# Contract Tests

Contract tests verify that each backend correctly implements the `LockBackend` interface according to the specifications. These tests ensure API guarantees are satisfied consistently across all backends.

## What Contract Tests Verify

- **API Compliance**: Each backend implements all required operations correctly
- **Semantic Guarantees**: Operations behave as specified (atomicity, ownership, TTL, etc.)
- **Error Handling**: Backends handle invalid inputs and edge cases consistently
- **Feature Requirements**: Fence tokens, monotonicity, expiration, lookup operations
- **Cross-Backend Consistency**: All backends satisfy the same behavioral contracts

## How They Differ from Integration Tests

| Aspect       | Contract Tests               | Integration Tests                |
| ------------ | ---------------------------- | -------------------------------- |
| **Focus**    | API guarantees               | Real-world scenarios             |
| **Scope**    | Backend interface compliance | End-to-end workflows             |
| **Coverage** | All backends via fixtures    | Specific backend implementations |
| **Pattern**  | Parameterized (registry)     | Backend-specific                 |
| **Goal**     | Ensure interface correctness | Validate integration behavior    |

## Running Contract Tests

```bash
# Run all contract tests for available backends
bun test test/contracts

# Run specific contract test
bun test test/contracts/lock-lifecycle.test.ts

# Run with specific backend only
TEST_REDIS=true bun test test/contracts
TEST_POSTGRES=true bun test test/contracts
TEST_FIRESTORE=true bun test test/contracts
```

## Test Organization

- `lock-lifecycle.test.ts` - Basic acquire/release/isLocked operations
- `lock-contention.test.ts` - Concurrent acquisition and retry behavior
- `lock-expiration.test.ts` - TTL enforcement and extend operations
- `fence-monotonicity.test.ts` - Fence token format and ordering (ADR-004)
- `lookup-operations.test.ts` - Key and lockId lookup functionality
- `abort-signal.test.ts` - AbortSignal support across operations
- `ownership.test.ts` - Ownership verification for release/extend (ADR-003)
- `error-handling.test.ts` - Invalid inputs and error conditions

## Writing Contract Tests

Contract tests use the backend fixture registry pattern:

```typescript
import {
  getAvailableBackends,
  type BackendFixture,
} from "../fixtures/backends.js";

describe("Contract Name", async () => {
  const availableBackends = await getAvailableBackends();

  if (availableBackends.length === 0) {
    it.skip("No backends available", () => {});
    return;
  }

  for (const fixture of availableBackends) {
    describe(`${fixture.name}`, () => {
      let backend: LockBackend;

      beforeAll(async () => {
        const result = await fixture.setup();
        backend = result.createBackend();
      });

      beforeEach(async () => {
        const result = await fixture.setup();
        await result.cleanup();
      });

      afterAll(async () => {
        const result = await fixture.setup();
        await result.teardown();
      });

      it("should verify API guarantee", async () => {
        // Test implementation
      });
    });
  }
});
```
