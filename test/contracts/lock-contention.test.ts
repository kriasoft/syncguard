// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

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

describe("Lock Contention", async () => {
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

      // TIME_TOLERANCE_MS is 1000ms, so lock expiry = TTL + 1000ms
      // Firestore is slower due to HTTP round-trips - use longer base timeouts
      const shortTtl = fixture.kind === "firestore" ? 2000 : 1000;
      // Sleep must exceed TTL + TIME_TOLERANCE_MS (1000ms) + network buffer
      const sleepBuffer = fixture.kind === "firestore" ? 5000 : 2500;
      // Firestore tests need longer timeout and retry for network variability on CI
      const slowTestOpts =
        fixture.kind === "firestore" ? { timeout: 20000, retry: 2 } : {};

      beforeAll(async () => {
        const result = await fixture.setup();
        backend = result.createBackend();
        cleanup = result.cleanup;
        teardown = result.teardown;
      });

      beforeEach(async () => {
        await cleanup();
      });

      afterAll(async () => {
        await teardown();
      });

      it("should prevent concurrent acquisition of same resource", async () => {
        const key = "contention:concurrent:test";

        // First acquisition should succeed
        const result1 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result1.ok).toBe(true);

        if (result1.ok) {
          // Second acquisition should fail (locked)
          const result2 = await backend.acquire({ key, ttlMs: 30000 });
          expect(result2.ok).toBe(false);
          if (!result2.ok) {
            expect(result2.reason).toBe("locked");
          }

          // Verify lock is still held
          expect(await backend.isLocked({ key })).toBe(true);

          // Clean up
          await backend.release({ lockId: result1.lockId });
        }
      });

      it("should allow concurrent access to different resources", async () => {
        const startTime = Date.now();
        const sleepDuration = 50;

        // Lock different resources concurrently
        await Promise.all([
          (async () => {
            const result = await backend.acquire({
              key: "contention:parallel:resource1",
              ttlMs: 30000,
            });
            if (result.ok) {
              await Bun.sleep(sleepDuration);
              await backend.release({ lockId: result.lockId });
            }
          })(),
          (async () => {
            const result = await backend.acquire({
              key: "contention:parallel:resource2",
              ttlMs: 30000,
            });
            if (result.ok) {
              await Bun.sleep(sleepDuration);
              await backend.release({ lockId: result.lockId });
            }
          })(),
          (async () => {
            const result = await backend.acquire({
              key: "contention:parallel:resource3",
              ttlMs: 30000,
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

      it("should allow acquisition after lock is released", async () => {
        const key = "contention:after-release:test";

        // First acquisition
        const result1 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result1.ok).toBe(true);

        if (result1.ok) {
          // Release the lock
          await backend.release({ lockId: result1.lockId });

          // Second acquisition should now succeed
          const result2 = await backend.acquire({ key, ttlMs: 30000 });
          expect(result2.ok).toBe(true);

          if (result2.ok) {
            await backend.release({ lockId: result2.lockId });
          }
        }
      });

      it(
        "should handle contention with multiple waiters",
        async () => {
          const key = "contention:multiple-waiters:test";

          // First acquisition holds the lock
          const result1 = await backend.acquire({ key, ttlMs: shortTtl });
          expect(result1.ok).toBe(true);

          if (result1.ok) {
            // Multiple subsequent acquisitions should fail
            const waiters = await Promise.all([
              backend.acquire({ key, ttlMs: 30000 }),
              backend.acquire({ key, ttlMs: 30000 }),
              backend.acquire({ key, ttlMs: 30000 }),
            ]);

            // All should fail with locked reason
            waiters.forEach((result) => {
              expect(result.ok).toBe(false);
              if (!result.ok) {
                expect(result.reason).toBe("locked");
              }
            });

            // Wait for first lock to expire (with generous buffer)
            await Bun.sleep(sleepBuffer);

            // Now acquisition should succeed
            const result2 = await backend.acquire({ key, ttlMs: 30000 });
            expect(result2.ok).toBe(true);

            if (result2.ok) {
              await backend.release({ lockId: result2.lockId });
            }
          }
        },
        slowTestOpts,
      );

      it(
        "should demonstrate lock contention behavior under concurrent load",
        async () => {
          const numOperations = 5;
          const key = "contention:stress:test";
          let successfulOperations = 0;

          // Create concurrent lock operations
          const promises = Array.from({ length: numOperations }, async () => {
            const result = await backend.acquire({
              key,
              ttlMs: shortTtl,
            });

            if (result.ok) {
              successfulOperations++;
              await Bun.sleep(10); // Brief critical section
              await backend.release({ lockId: result.lockId });
            }

            return result;
          });

          const results = await Promise.all(promises);

          // At least one operation should succeed
          expect(successfulOperations).toBeGreaterThan(0);
          expect(successfulOperations).toBeLessThanOrEqual(numOperations);

          // Firestore serializes requests, so may not see contention in all cases
          if (fixture.kind !== "firestore") {
            // Verify contention was encountered
            const failedResults = results.filter((r) => !r.ok);
            expect(failedResults.length).toBeGreaterThan(0);
          }

          // Verify no dangling locks remain (with generous buffer)
          await Bun.sleep(sleepBuffer); // Wait for TTL to expire
          expect(await backend.isLocked({ key })).toBe(false);
        },
        slowTestOpts,
      );
    });
  }
});
