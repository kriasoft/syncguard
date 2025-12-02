// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * E2E tests for createLock() callback pattern.
 *
 * Tests the high-level lock wrapper with automatic acquisition and release:
 * - Basic callback execution
 * - Error propagation from callback
 * - Return value from callback
 * - Automatic lock management
 * - Retry and timeout behavior
 *
 * Prerequisites:
 * - Redis server running on localhost:6379
 * - PostgreSQL server running on localhost:5432
 * - Firestore emulator running on localhost:8080
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { lock as lockWithBackend } from "../../common/auto-lock.js";
import type { LockBackend } from "../../common/types.js";
import { getAvailableBackends } from "../fixtures/backends.js";

describe("E2E: Lock Callback Pattern", async () => {
  const availableBackends = await getAvailableBackends();

  if (availableBackends.length === 0) {
    it.skip("No backends available", () => {});
    return;
  }

  for (const fixture of availableBackends) {
    describe(`${fixture.name}`, () => {
      let backend: LockBackend;
      let lock: <T>(
        fn: () => Promise<T> | T,
        config: Parameters<typeof lockWithBackend>[2],
      ) => Promise<T>;
      let cleanup: () => Promise<void>;
      let teardown: () => Promise<void>;

      beforeAll(async () => {
        const setup = await fixture.setup();
        backend = setup.createBackend() as LockBackend;
        cleanup = setup.cleanup;
        teardown = setup.teardown;

        // Create lock wrapper using common auto-lock
        lock = <T>(
          fn: () => Promise<T> | T,
          config: Parameters<typeof lockWithBackend>[2],
        ) => lockWithBackend(backend, fn, config);
      });

      beforeEach(async () => {
        await cleanup();
      });

      afterAll(async () => {
        await teardown();
      });

      it("should execute callback with automatic lock management", async () => {
        const key = "callback:basic";
        let callbackExecuted = false;
        let lockWasActiveInside = false;

        const result = await lock(
          async () => {
            callbackExecuted = true;

            // Verify lock is active during execution
            lockWasActiveInside = await backend.isLocked({ key });

            // Simulate some work
            await Bun.sleep(10);

            return "success";
          },
          {
            key,
            ttlMs: 15000,
          },
        );

        // Verify execution results
        expect(callbackExecuted).toBe(true);
        expect(lockWasActiveInside).toBe(true);
        expect(result).toBe("success");

        // Verify lock was automatically released
        expect(await backend.isLocked({ key })).toBe(false);
      });

      it("should return callback value", async () => {
        const key = "callback:return-value";

        const stringResult = await lock(
          async () => {
            return "hello";
          },
          { key, ttlMs: 10000 },
        );
        expect(stringResult).toBe("hello");

        const numberResult = await lock(
          async () => {
            return 42;
          },
          { key, ttlMs: 10000 },
        );
        expect(numberResult).toBe(42);

        const objectResult = await lock(
          async () => {
            return { status: "ok", data: [1, 2, 3] };
          },
          { key, ttlMs: 10000 },
        );
        expect(objectResult).toEqual({ status: "ok", data: [1, 2, 3] });
      });

      it("should propagate errors from callback", async () => {
        const key = "callback:error-propagation";
        let lockWasActiveBeforeError = false;

        try {
          await lock(
            async () => {
              // Verify lock is active
              lockWasActiveBeforeError = await backend.isLocked({ key });

              // Throw error during execution
              throw new Error("Callback error");
            },
            {
              key,
              ttlMs: 10000,
            },
          );

          // Should not reach here
          expect(true).toBe(false);
        } catch (error) {
          expect((error as Error).message).toBe("Callback error");
          expect(lockWasActiveBeforeError).toBe(true);
        }

        // Lock should be released even after error
        expect(await backend.isLocked({ key })).toBe(false);
      });

      it("should handle async errors in callback", async () => {
        const key = "callback:async-error";

        try {
          await lock(
            async () => {
              await Bun.sleep(10);
              throw new Error("Async error");
            },
            { key, ttlMs: 10000 },
          );

          expect(true).toBe(false);
        } catch (error) {
          expect((error as Error).message).toBe("Async error");
        }

        // Lock should be released
        expect(await backend.isLocked({ key })).toBe(false);
      });

      it("should respect acquisition timeout", async () => {
        const key = "callback:timeout";

        // First lock holds for longer than second lock's timeout
        const longRunningLock = lock(
          async () => {
            await Bun.sleep(800);
          },
          {
            key,
            ttlMs: 60000,
          },
        );

        // Give first lock time to acquire
        await Bun.sleep(50);

        // Second lock attempts with short timeout
        const shortTimeoutLock = lock(
          async () => {
            throw new Error("This should not execute");
          },
          {
            key,
            acquisition: {
              timeoutMs: 300,
              maxRetries: 50,
              retryDelayMs: 5,
            },
          },
        );

        const results = await Promise.allSettled([
          longRunningLock,
          shortTimeoutLock,
        ]);

        // First should succeed
        expect(results[0].status).toBe("fulfilled");

        // Second should fail
        expect(results[1].status).toBe("rejected");
      }, 10000);

      it("should retry on lock contention", async () => {
        const key = "callback:retry";
        let operation1Completed = false;
        let operation2Completed = false;

        // Two operations competing for same lock
        const operation1 = lock(
          async () => {
            operation1Completed = true;
            await Bun.sleep(30);
          },
          { key, ttlMs: 10000 },
        );

        // Slight delay to ensure operation1 starts first
        await Bun.sleep(10);

        const operation2 = lock(
          async () => {
            operation2Completed = true;
            await Bun.sleep(30);
          },
          {
            key,
            ttlMs: 10000,
            acquisition: {
              retryDelayMs: 10,
              maxRetries: 50,
              timeoutMs: 2000,
            },
          },
        );

        await Promise.all([operation1, operation2]);

        // Both should complete (operation2 waits for operation1)
        expect(operation1Completed).toBe(true);
        expect(operation2Completed).toBe(true);

        // Lock should be released
        expect(await backend.isLocked({ key })).toBe(false);
      }, 10000);

      it("should handle multiple sequential calls", async () => {
        const key = "callback:sequential";
        const results: number[] = [];

        for (let i = 0; i < 3; i++) {
          const result = await lock(
            async () => {
              await Bun.sleep(10);
              return i;
            },
            { key, ttlMs: 10000 },
          );
          results.push(result);
        }

        expect(results).toEqual([0, 1, 2]);

        // Lock should be released
        expect(await backend.isLocked({ key })).toBe(false);
      });

      it("should allow concurrent calls on different keys", async () => {
        const startTime = Date.now();
        const sleepDuration = 100;

        await Promise.all([
          lock(
            async () => {
              await Bun.sleep(sleepDuration);
            },
            { key: "callback:parallel:1", ttlMs: 10000 },
          ),
          lock(
            async () => {
              await Bun.sleep(sleepDuration);
            },
            { key: "callback:parallel:2", ttlMs: 10000 },
          ),
          lock(
            async () => {
              await Bun.sleep(sleepDuration);
            },
            { key: "callback:parallel:3", ttlMs: 10000 },
          ),
        ]);

        const elapsed = Date.now() - startTime;

        // Should complete in ~100ms (parallel), not 300ms (sequential)
        expect(elapsed).toBeLessThan(200);
      });

      it("should execute callback with void return", async () => {
        const key = "callback:void";
        let sideEffect = 0;

        await lock(
          async () => {
            sideEffect = 42;
          },
          { key, ttlMs: 10000 },
        );

        expect(sideEffect).toBe(42);
      });
    });
  }
});
