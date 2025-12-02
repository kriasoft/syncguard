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

describe("Fence Monotonicity (ADR-004)", async () => {
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

      it("should generate fence tokens in 15-digit zero-padded format", async () => {
        if (!backend.capabilities.supportsFencing) {
          // Skip test if backend doesn't support fencing
          return;
        }

        const key = "fence:format:test";
        const fenceFormatRegex = /^\d{15}$/; // ADR-004: exactly 15 digits

        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok && "fence" in result) {
          // Verify fence format compliance
          const fence = result.fence as string;
          expect(fence).toMatch(fenceFormatRegex);
          expect(fence.length).toBe(15);
          expect(Number(fence)).toBeGreaterThan(0);

          await backend.release({ lockId: result.lockId });
        }
      });

      it("should generate monotonically increasing fences with lexicographic ordering", async () => {
        if (!backend.capabilities.supportsFencing) {
          return;
        }

        const key = "fence:monotonic:test";
        const fences: string[] = [];

        // Acquire and release locks multiple times
        for (let i = 0; i < 5; i++) {
          const result = await backend.acquire({ key, ttlMs: 30000 });
          expect(result.ok).toBe(true);

          if (result.ok && "fence" in result) {
            fences.push(result.fence as string);
            await backend.release({ lockId: result.lockId });
          }
        }

        // Verify monotonicity and lexicographic ordering
        expect(fences).toHaveLength(5);
        for (let i = 1; i < fences.length; i++) {
          // String comparison should work due to zero-padding
          expect(fences[i]! > fences[i - 1]!).toBe(true);

          // Numeric comparison should also hold
          const current = BigInt(fences[i]!);
          const previous = BigInt(fences[i - 1]!);
          expect(current > previous).toBe(true);
        }
      });

      it("should maintain fence monotonicity per key", async () => {
        if (!backend.capabilities.supportsFencing) {
          return;
        }

        const key1 = "fence:per-key:test1";
        const key2 = "fence:per-key:test2";

        // Acquire locks on both keys
        const result1 = await backend.acquire({ key: key1, ttlMs: 30000 });
        const result2 = await backend.acquire({ key: key2, ttlMs: 30000 });

        expect(result1.ok).toBe(true);
        expect(result2.ok).toBe(true);

        if (
          result1.ok &&
          result2.ok &&
          "fence" in result1 &&
          "fence" in result2
        ) {
          const fence1_1 = result1.fence as string;
          const fence2_1 = result2.fence as string;

          // Release both locks
          await backend.release({ lockId: result1.lockId });
          await backend.release({ lockId: result2.lockId });

          // Acquire again
          const result1_2 = await backend.acquire({ key: key1, ttlMs: 30000 });
          const result2_2 = await backend.acquire({ key: key2, ttlMs: 30000 });

          expect(result1_2.ok).toBe(true);
          expect(result2_2.ok).toBe(true);

          if (
            result1_2.ok &&
            result2_2.ok &&
            "fence" in result1_2 &&
            "fence" in result2_2
          ) {
            const fence1_2 = result1_2.fence as string;
            const fence2_2 = result2_2.fence as string;

            // Fences should increase per key
            expect(BigInt(fence1_2) > BigInt(fence1_1)).toBe(true);
            expect(BigInt(fence2_2) > BigInt(fence2_1)).toBe(true);

            await backend.release({ lockId: result1_2.lockId });
            await backend.release({ lockId: result2_2.lockId });
          }
        }
      });

      it("should persist fence counter across acquire cycles", async () => {
        if (!backend.capabilities.supportsFencing) {
          return;
        }

        const key = "fence:persistence:test";

        // First acquire
        const result1 = await backend.acquire({ key, ttlMs: 1000 });
        expect(result1.ok).toBe(true);

        if (result1.ok && "fence" in result1) {
          const fence1 = result1.fence as string;
          await backend.release({ lockId: result1.lockId });

          // Wait for lock to expire (with generous buffer)
          await Bun.sleep(1500);

          // Second acquire after expiration
          const result2 = await backend.acquire({ key, ttlMs: 30000 });
          expect(result2.ok).toBe(true);

          if (result2.ok && "fence" in result2) {
            // Fence counter must persist across cleanup
            expect(BigInt(result2.fence as string) > BigInt(fence1)).toBe(true);

            await backend.release({ lockId: result2.lockId });
          }
        }
      });

      it("should never delete fence counter keys during cleanup", async () => {
        if (!backend.capabilities.supportsFencing) {
          return;
        }

        const key = "fence:cleanup:protection:test";

        // Acquire and release lock to establish fence counter
        const result1 = await backend.acquire({ key, ttlMs: 1000 });
        expect(result1.ok).toBe(true);

        if (result1.ok && "fence" in result1) {
          const fence1 = result1.fence as string;

          // Release the lock
          await backend.release({ lockId: result1.lockId });

          // Wait for lock to expire completely (with generous buffer)
          await Bun.sleep(1500);

          // Trigger cleanup via isLocked
          const isLocked = await backend.isLocked({ key });
          expect(isLocked).toBe(false);

          // Acquire new lock - fence counter MUST persist
          const result2 = await backend.acquire({ key, ttlMs: 30000 });
          expect(result2.ok).toBe(true);

          if (result2.ok && "fence" in result2) {
            // Fence MUST be monotonically increasing (fence counter survived cleanup)
            expect(BigInt(result2.fence as string) > BigInt(fence1)).toBe(true);

            await backend.release({ lockId: result2.lockId });
          }
        }
      });

      it("should maintain fence monotonicity across multiple cleanup cycles", async () => {
        if (!backend.capabilities.supportsFencing) {
          return;
        }

        const key = "fence:multiple-cleanup:test";
        const fences: string[] = [];

        // Run multiple acquire-cleanup-acquire cycles
        for (let i = 0; i < 3; i++) {
          // Acquire lock with short TTL (1 second for slow backends)
          const result = await backend.acquire({ key, ttlMs: 1000 });
          expect(result.ok).toBe(true);

          if (result.ok && "fence" in result) {
            fences.push(result.fence as string);
            await backend.release({ lockId: result.lockId });
          }

          // Wait for cleanup (with generous buffer)
          await Bun.sleep(1500);

          // Trigger cleanup
          await backend.isLocked({ key });
        }

        // Verify fence monotonicity across cleanup cycles
        expect(fences).toHaveLength(3);
        for (let i = 1; i < fences.length; i++) {
          expect(BigInt(fences[i]!) > BigInt(fences[i - 1]!)).toBe(true);
        }
      });
    });
  }
});
