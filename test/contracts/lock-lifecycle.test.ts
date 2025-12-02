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

describe("Lock Lifecycle", async () => {
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

      it("should successfully perform complete lock lifecycle", async () => {
        const key = "lifecycle:basic:test";

        // 1. Acquire lock
        const acquireResult = await backend.acquire({
          key,
          ttlMs: 30000,
        });

        expect(acquireResult.ok).toBe(true);

        if (acquireResult.ok) {
          // Verify lock properties
          expect(acquireResult.lockId).toBeDefined();
          expect(typeof acquireResult.lockId).toBe("string");
          expect(acquireResult.expiresAtMs).toBeGreaterThan(Date.now());
          expect(typeof acquireResult.expiresAtMs).toBe("number");

          // 2. Verify resource is locked
          const isLocked = await backend.isLocked({ key });
          expect(isLocked).toBe(true);

          // 3. Release lock
          const releaseResult = await backend.release({
            lockId: acquireResult.lockId,
          });
          expect(releaseResult.ok).toBe(true);

          // 4. Verify resource is unlocked
          const isLockedAfter = await backend.isLocked({ key });
          expect(isLockedAfter).toBe(false);
        }
      });

      it("should return fence token on successful acquire", async () => {
        const key = "lifecycle:fence:test";

        const result = await backend.acquire({
          key,
          ttlMs: 30000,
        });

        expect(result.ok).toBe(true);

        if (result.ok) {
          // Verify fence token exists (if backend supports fencing)
          if (backend.capabilities.supportsFencing) {
            expect("fence" in result).toBe(true);
            if ("fence" in result) {
              const fence = result.fence as string;
              // Verify 15-digit zero-padded format (ADR-004)
              expect(fence).toMatch(/^\d{15}$/);
              expect(fence.length).toBe(15);
              expect(Number(fence)).toBeGreaterThan(0);
            }
          }

          await backend.release({ lockId: result.lockId });
        }
      });

      it("should handle multiple lock operations on different resources", async () => {
        const keys = [
          "lifecycle:multi:resource1",
          "lifecycle:multi:resource2",
          "lifecycle:multi:resource3",
        ];

        // Acquire locks on all resources simultaneously
        const results = await Promise.all(
          keys.map((key) => backend.acquire({ key, ttlMs: 20000 })),
        );

        // All acquisitions should succeed
        results.forEach((result) => {
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.lockId).toBeDefined();
          }
        });

        // Verify all resources are locked
        const lockStatuses = await Promise.all(
          keys.map((key) => backend.isLocked({ key })),
        );
        expect(lockStatuses).toEqual([true, true, true]);

        // Release all locks
        const releaseResults = await Promise.all(
          results.map((result) => {
            if (result.ok) {
              return backend.release({ lockId: result.lockId });
            }
            return { ok: false as const };
          }),
        );

        // All releases should succeed
        releaseResults.forEach((result) => {
          expect(result.ok).toBe(true);
        });

        // Verify all resources are unlocked
        const finalStatuses = await Promise.all(
          keys.map((key) => backend.isLocked({ key })),
        );
        expect(finalStatuses).toEqual([false, false, false]);
      });

      it("should handle double release gracefully", async () => {
        const key = "lifecycle:double-release:test";

        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          // First release should succeed
          const released1 = await backend.release({ lockId: result.lockId });
          expect(released1.ok).toBe(true);

          // Second release should fail gracefully
          const released2 = await backend.release({ lockId: result.lockId });
          expect(released2.ok).toBe(false);
        }
      });

      it("should handle release of non-existent lock", async () => {
        const released = await backend.release({
          lockId: "AAAAAAAAAAAAAAAAAAAAAA", // Valid format but non-existent
        });
        expect(released.ok).toBe(false);
      });

      it("should handle rapid acquire/release cycles", async () => {
        const key = "lifecycle:rapid:test";
        const cycles = 10;

        for (let i = 0; i < cycles; i++) {
          const result = await backend.acquire({ key, ttlMs: 30000 });
          expect(result.ok).toBe(true);

          if (result.ok) {
            // Verify lock is held
            expect(await backend.isLocked({ key })).toBe(true);

            // Release immediately
            const released = await backend.release({ lockId: result.lockId });
            expect(released.ok).toBe(true);

            // Verify lock is released
            expect(await backend.isLocked({ key })).toBe(false);
          }
        }
      });
    });
  }
});
