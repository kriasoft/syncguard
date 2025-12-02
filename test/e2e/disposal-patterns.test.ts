// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * E2E tests for AsyncDisposable (`await using`) patterns.
 *
 * Tests real-world disposal patterns with actual backend instances:
 * - Automatic cleanup on scope exit
 * - Disposal behavior with errors
 * - Manual operations with disposal handle
 * - Consistent disposal behavior across backends
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

describe("E2E: Disposal Patterns", async () => {
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

      it("should automatically release lock on scope exit", async () => {
        const key = "disposal:auto-release";

        {
          await using lock = await backend.acquire({ key, ttlMs: 30000 });

          if (lock.ok) {
            // Lock should be held
            expect(await backend.isLocked({ key })).toBe(true);
          }
        }

        // Lock should be automatically released
        expect(await backend.isLocked({ key })).toBe(false);
      });

      it("should release lock even if scope exits with error", async () => {
        const key = "disposal:error-release";

        const testFn = async () => {
          await using lock = await backend.acquire({ key, ttlMs: 30000 });

          if (lock.ok) {
            expect(await backend.isLocked({ key })).toBe(true);
            throw new Error("Test error");
          }
        };

        await expect(testFn()).rejects.toThrow("Test error");

        // Lock should still be released
        expect(await backend.isLocked({ key })).toBe(false);
      });

      it("should support manual release with disposal handle", async () => {
        const key = "disposal:manual-release";

        await using lock = await backend.acquire({ key, ttlMs: 30000 });

        if (lock.ok) {
          expect(await backend.isLocked({ key })).toBe(true);

          // Manual release
          const result = await lock.release();
          expect(result.ok).toBe(true);

          // Lock should be released
          expect(await backend.isLocked({ key })).toBe(false);
        }
      });

      it("should support extend operation with disposal handle", async () => {
        const key = "disposal:extend";

        await using lock = await backend.acquire({ key, ttlMs: 500 });

        if (lock.ok) {
          const originalExpiry = lock.expiresAtMs;

          // Wait a bit
          await Bun.sleep(200);

          // Extend lock
          const extendResult = await lock.extend(5000);
          expect(extendResult.ok).toBe(true);

          if (extendResult.ok) {
            expect(extendResult.expiresAtMs).toBeGreaterThan(originalExpiry);
          }

          // Wait past original TTL
          await Bun.sleep(400);

          // Lock should still be held
          expect(await backend.isLocked({ key })).toBe(true);
        }
      });

      it("should handle failed acquisition gracefully", async () => {
        const key = "disposal:contended";

        // Hold lock
        const firstLock = await backend.acquire({ key, ttlMs: 30000 });
        expect(firstLock.ok).toBe(true);

        {
          // Try to acquire same lock (should fail)
          await using lock = await backend.acquire({ key, ttlMs: 100 });

          expect(lock.ok).toBe(false);

          // No disposal should happen for failed acquisition
        }

        // First lock should still be held
        expect(await backend.isLocked({ key })).toBe(true);

        // Clean up
        if (firstLock.ok) {
          await firstLock.release();
        }
      });

      it("should handle double release gracefully", async () => {
        const key = "disposal:double-release";

        await using lock = await backend.acquire({ key, ttlMs: 30000 });

        if (lock.ok) {
          // First manual release
          const release1 = await lock.release();
          expect(release1.ok).toBe(true);

          // Second manual release
          const release2 = await lock.release();
          expect(release2.ok).toBe(false);
        }

        // Disposal should handle already-released lock gracefully
      });

      it("should allow nested disposal scopes", async () => {
        const key1 = "disposal:nested:1";
        const key2 = "disposal:nested:2";

        {
          await using lock1 = await backend.acquire({
            key: key1,
            ttlMs: 30000,
          });

          if (lock1.ok) {
            expect(await backend.isLocked({ key: key1 })).toBe(true);

            {
              await using lock2 = await backend.acquire({
                key: key2,
                ttlMs: 30000,
              });

              if (lock2.ok) {
                expect(await backend.isLocked({ key: key2 })).toBe(true);
              }
            }

            // Inner lock should be released
            expect(await backend.isLocked({ key: key2 })).toBe(false);

            // Outer lock should still be held
            expect(await backend.isLocked({ key: key1 })).toBe(true);
          }
        }

        // Both locks should be released
        expect(await backend.isLocked({ key: key1 })).toBe(false);
        expect(await backend.isLocked({ key: key2 })).toBe(false);
      });

      it("should provide consistent disposal behavior across manual operations", async () => {
        const key = "disposal:manual-ops";

        await using lock = await backend.acquire({ key, ttlMs: 30000 });

        if (lock.ok) {
          // Manual release
          const releaseResult = await lock.release();
          expect(releaseResult.ok).toBe(true);

          // Subsequent release delegates to backend (returns ok: false - lock absent)
          const releaseResult2 = await lock.release();
          expect(releaseResult2.ok).toBe(false);

          // Extend after release delegates to backend (returns ok: false - lock absent)
          const extendResult = await lock.extend(5000);
          expect(extendResult.ok).toBe(false);
        }
      });

      it("should handle concurrent disposal correctly", async () => {
        const keys = [
          "disposal:concurrent:1",
          "disposal:concurrent:2",
          "disposal:concurrent:3",
        ];

        await Promise.all(
          keys.map(async (key) => {
            await using lock = await backend.acquire({ key, ttlMs: 30000 });

            if (lock.ok) {
              expect(await backend.isLocked({ key })).toBe(true);
              await Bun.sleep(50);
            }
          }),
        );

        // All locks should be released
        for (const key of keys) {
          expect(await backend.isLocked({ key })).toBe(false);
        }
      });
    });
  }
});
