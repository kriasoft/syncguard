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

describe("Lock Expiration", async () => {
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

      it(
        "should auto-expire locks after TTL",
        async () => {
          const key = "expiration:auto-expire:test";

          // Acquire lock with short TTL
          const result = await backend.acquire({ key, ttlMs: shortTtl });
          expect(result.ok).toBe(true);

          if (result.ok) {
            // Verify lock is held
            expect(await backend.isLocked({ key })).toBe(true);

            // Wait for TTL to expire (with generous buffer for slow backends)
            await Bun.sleep(sleepBuffer);

            // Lock should be expired
            expect(await backend.isLocked({ key })).toBe(false);

            // Another process should be able to acquire it
            const result2 = await backend.acquire({ key, ttlMs: 30000 });
            expect(result2.ok).toBe(true);

            if (result2.ok) {
              await backend.release({ lockId: result2.lockId });
            }
          }
        },
        slowTestOpts,
      );

      it("should extend lock TTL", async () => {
        const key = "expiration:extend:test";

        // Acquire lock with short TTL
        const result = await backend.acquire({ key, ttlMs: 500 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          // Wait a bit
          await Bun.sleep(300);

          // Extend the lock
          const extended = await backend.extend({
            lockId: result.lockId,
            ttlMs: 1000,
          });
          expect(extended.ok).toBe(true);

          if (extended.ok) {
            // Verify new expiry is returned
            expect(extended.expiresAtMs).toBeGreaterThan(Date.now());
            expect(extended.expiresAtMs).toBeGreaterThan(result.expiresAtMs);
          }

          // Wait past original expiry
          await Bun.sleep(300);

          // Lock should still be held
          expect(await backend.isLocked({ key })).toBe(true);

          // Clean up
          await backend.release({ lockId: result.lockId });
        }
      });

      it(
        "should not extend expired lock",
        async () => {
          const key = "expiration:extend-expired:test";

          // Acquire lock with short TTL
          const result = await backend.acquire({ key, ttlMs: shortTtl });
          expect(result.ok).toBe(true);

          if (result.ok) {
            // Wait for lock to expire (with generous buffer)
            await Bun.sleep(sleepBuffer);

            // Try to extend expired lock
            const extended = await backend.extend({
              lockId: result.lockId,
              ttlMs: 1000,
            });
            expect(extended.ok).toBe(false);
          }
        },
        slowTestOpts,
      );

      it(
        "should clean up expired locks during isLocked check",
        async () => {
          const key = "expiration:cleanup:test";

          // Create a lock with short TTL
          const result = await backend.acquire({ key, ttlMs: shortTtl });
          expect(result.ok).toBe(true);

          if (result.ok) {
            // Wait for it to expire (with generous buffer)
            await Bun.sleep(sleepBuffer);

            // isLocked should trigger cleanup and return false
            const isLocked = await backend.isLocked({ key });
            expect(isLocked).toBe(false);

            // Verify the lock was actually cleaned up (can acquire immediately)
            const result2 = await backend.acquire({ key, ttlMs: 30000 });
            expect(result2.ok).toBe(true);

            if (result2.ok) {
              await backend.release({ lockId: result2.lockId });
            }
          }
        },
        slowTestOpts,
      );

      it("should handle multiple extends", async () => {
        const key = "expiration:multiple-extends:test";

        const result = await backend.acquire({ key, ttlMs: 2000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          // First extend
          await Bun.sleep(500);
          const extend1 = await backend.extend({
            lockId: result.lockId,
            ttlMs: 2000,
          });
          expect(extend1.ok).toBe(true);

          // Second extend
          await Bun.sleep(500);
          const extend2 = await backend.extend({
            lockId: result.lockId,
            ttlMs: 2000,
          });
          expect(extend2.ok).toBe(true);

          // Lock should still be held after multiple extends
          expect(await backend.isLocked({ key })).toBe(true);

          await backend.release({ lockId: result.lockId });
        }
      });

      it(
        "should respect TTL boundaries",
        async () => {
          const key = "expiration:boundaries:test";

          // Test with short TTL
          const result1 = await backend.acquire({ key, ttlMs: shortTtl });
          expect(result1.ok).toBe(true);

          if (result1.ok) {
            await Bun.sleep(sleepBuffer);
            expect(await backend.isLocked({ key })).toBe(false);
          }

          // Test with larger TTL (30 seconds)
          const result2 = await backend.acquire({ key, ttlMs: 30000 });
          expect(result2.ok).toBe(true);

          if (result2.ok) {
            await Bun.sleep(100);
            expect(await backend.isLocked({ key })).toBe(true);
            await backend.release({ lockId: result2.lockId });
          }
        },
        slowTestOpts,
      );
    });
  }
});
