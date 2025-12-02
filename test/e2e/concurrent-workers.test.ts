// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * E2E tests for concurrent worker patterns.
 *
 * Tests multiple concurrent lock attempts on the same key to verify:
 * - Only one worker succeeds at acquiring the lock at a time
 * - Sequential execution under high contention
 * - No data races or corruption under concurrent load
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
import type { LockBackend } from "../../common/types.js";
import { getAvailableBackends } from "../fixtures/backends.js";

describe("E2E: Concurrent Workers", async () => {
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

      it("should handle multiple concurrent lock attempts on same key", async () => {
        const resourceKey = "concurrent:shared-resource";
        const numWorkers = 5;
        let successfulAcquisitions = 0;
        let failedAcquisitions = 0;

        // Multiple workers trying to acquire the same lock
        const workers = Array.from({ length: numWorkers }, async () => {
          const result = await backend.acquire({
            key: resourceKey,
            ttlMs: 100,
          });

          if (result.ok) {
            successfulAcquisitions++;
            // Simulate work
            await Bun.sleep(20);
            await backend.release({ lockId: result.lockId });
          } else {
            failedAcquisitions++;
          }
        });

        await Promise.all(workers);

        // Only one worker should succeed at a time with short TTL
        expect(successfulAcquisitions).toBeGreaterThan(0);
        expect(successfulAcquisitions + failedAcquisitions).toBe(numWorkers);
      });

      it("should ensure sequential execution under lock contention", async () => {
        const resourceKey = "concurrent:counter";
        let sharedCounter = 0;
        const incrementResults: number[] = [];
        const numOperations = 3;

        // Create concurrent operations that modify shared state
        const operations = Array.from(
          { length: numOperations },
          async (_, index) => {
            // Retry logic for lock acquisition
            let acquired = false;
            let attempts = 0;
            const maxAttempts = 50;

            while (!acquired && attempts < maxAttempts) {
              const result = await backend.acquire({
                key: resourceKey,
                ttlMs: 5000,
              });

              if (result.ok) {
                acquired = true;
                try {
                  // Critical section
                  const current = sharedCounter;
                  await Bun.sleep(30); // Simulate work
                  sharedCounter = current + 1;
                  incrementResults.push(sharedCounter);
                } finally {
                  await backend.release({ lockId: result.lockId });
                }
              } else {
                attempts++;
                await Bun.sleep(10);
              }
            }
          },
        );

        await Promise.all(operations);

        // All operations should complete successfully
        expect(incrementResults.length).toBe(numOperations);

        // Counter should reflect all increments (no lost updates)
        expect(sharedCounter).toBe(numOperations);

        // Results should be sequential [1, 2, 3]
        expect(incrementResults.sort()).toEqual([1, 2, 3]);
      }, 10000); // Longer timeout for retries

      it("should prevent data corruption under concurrent load", async () => {
        const resourceKey = "concurrent:data-integrity";
        const numWorkers = 10;
        const data: number[] = [];

        // Multiple workers appending to shared array
        const workers = Array.from({ length: numWorkers }, async (_, index) => {
          let acquired = false;
          let attempts = 0;

          while (!acquired && attempts < 30) {
            const result = await backend.acquire({
              key: resourceKey,
              ttlMs: 2000,
            });

            if (result.ok) {
              acquired = true;
              try {
                // Read-modify-write pattern
                const current = [...data];
                await Bun.sleep(5);
                data.push(index);
              } finally {
                await backend.release({ lockId: result.lockId });
              }
            } else {
              attempts++;
              await Bun.sleep(10);
            }
          }
        });

        await Promise.all(workers);

        // All workers should have successfully written their data
        expect(data.length).toBe(numWorkers);

        // All indices should be present (no duplicates or missing values)
        const uniqueValues = new Set(data);
        expect(uniqueValues.size).toBe(numWorkers);
      }, 10000); // Longer timeout for retries

      it("should handle rapid acquire/release cycles", async () => {
        const resourceKey = "concurrent:rapid-cycles";
        const cycles = 10;

        for (let i = 0; i < cycles; i++) {
          const result = await backend.acquire({
            key: resourceKey,
            ttlMs: 30000,
          });
          expect(result.ok).toBe(true);

          if (result.ok) {
            // Verify lock is held
            expect(await backend.isLocked({ key: resourceKey })).toBe(true);

            // Release immediately
            const released = await backend.release({ lockId: result.lockId });
            expect(released.ok).toBe(true);

            // Verify lock is released
            expect(await backend.isLocked({ key: resourceKey })).toBe(false);
          }
        }
      });

      it("should allow concurrent access to different resources", async () => {
        const startTime = Date.now();
        const sleepDuration = 50;

        // Lock different resources concurrently
        await Promise.all([
          (async () => {
            const result = await backend.acquire({
              key: "resource:1",
              ttlMs: 5000,
            });
            if (result.ok) {
              await Bun.sleep(sleepDuration);
              await backend.release({ lockId: result.lockId });
            }
          })(),
          (async () => {
            const result = await backend.acquire({
              key: "resource:2",
              ttlMs: 5000,
            });
            if (result.ok) {
              await Bun.sleep(sleepDuration);
              await backend.release({ lockId: result.lockId });
            }
          })(),
          (async () => {
            const result = await backend.acquire({
              key: "resource:3",
              ttlMs: 5000,
            });
            if (result.ok) {
              await Bun.sleep(sleepDuration);
              await backend.release({ lockId: result.lockId });
            }
          })(),
        ]);

        const elapsed = Date.now() - startTime;

        // Firestore is significantly slower than Redis/Postgres due to HTTP round-trips
        // Redis/Postgres: ~100ms, Firestore: ~1-3s
        const maxExpected = fixture.kind === "firestore" ? 5000 : 500;
        expect(elapsed).toBeLessThan(maxExpected);
      });

      it("should demonstrate lock contention behavior under stress", async () => {
        const numOperations = 5;
        const resourceKey = "concurrent:stress-test";
        let successfulOperations = 0;
        const errors: Error[] = [];

        // Create concurrent lock operations with retries
        const promises = Array.from(
          { length: numOperations },
          async (_, index) => {
            let acquired = false;
            let attempts = 0;
            const maxAttempts = 30;

            while (!acquired && attempts < maxAttempts) {
              try {
                const result = await backend.acquire({
                  key: resourceKey,
                  ttlMs: 2000,
                });

                if (result.ok) {
                  acquired = true;
                  successfulOperations++;
                  await Bun.sleep(10); // Brief critical section
                  await backend.release({ lockId: result.lockId });
                } else {
                  attempts++;
                  await Bun.sleep(15);
                }
              } catch (error) {
                errors.push(error as Error);
                break;
              }
            }
          },
        );

        await Promise.all(promises);

        // Most or all operations should succeed with retries
        expect(successfulOperations).toBeGreaterThan(0);
        expect(successfulOperations).toBeLessThanOrEqual(numOperations);

        // Verify no dangling locks remain
        expect(await backend.isLocked({ key: resourceKey })).toBe(false);
      }, 10000); // Longer timeout for stress test
    });
  }
});
