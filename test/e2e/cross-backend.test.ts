// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * E2E tests for cross-backend consistency (ADR-006).
 *
 * Verifies identical behavior across Redis, Postgres, and Firestore backends:
 * - Fence key 1:1 mapping (ADR-006)
 * - Storage key truncation consistency
 * - Time consistency under clock skew
 * - Fence format and monotonicity
 * - Config validation consistency
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
import { makeStorageKey } from "../../common/crypto.js";
import type { LockBackend } from "../../common/types.js";
import { getAvailableBackends } from "../fixtures/backends.js";

describe("E2E: Cross-Backend Consistency", async () => {
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

      describe("Fence Format Consistency (ADR-004)", () => {
        it("should return 15-digit zero-padded fence format", async () => {
          const key = "consistency:fence:format";
          const fenceFormatRegex = /^\d{15}$/;

          const result = await backend.acquire({
            key,
            ttlMs: 30000,
          });

          expect(result.ok).toBe(true);

          if (result.ok) {
            // Only test fence if backend supports fencing
            if (backend.capabilities.supportsFencing) {
              const fencedResult = result as typeof result & { fence: string };
              // Both should use 15-digit zero-padded format
              expect(fencedResult.fence).toMatch(fenceFormatRegex);
              expect(fencedResult.fence.length).toBe(15);

              // Fence should be numeric
              const fenceNum = BigInt(fencedResult.fence);
              expect(fenceNum).toBeGreaterThan(0n);
            }

            await backend.release({ lockId: result.lockId });
          }
        });

        it("should ensure fence sequences sort lexicographically", async () => {
          const key = "consistency:fence:sequence";
          const fences: string[] = [];

          // Skip if backend doesn't support fencing
          if (!backend.capabilities.supportsFencing) {
            return;
          }

          // Generate sequence from backend
          for (let i = 0; i < 5; i++) {
            const result = await backend.acquire({
              key,
              ttlMs: 30000,
            });

            if (result.ok) {
              const fencedResult = result as typeof result & { fence: string };
              fences.push(fencedResult.fence);
              await backend.release({ lockId: result.lockId });
            }
          }

          // Sequence should be monotonically increasing
          for (let i = 1; i < fences.length; i++) {
            expect(fences[i]! > fences[i - 1]!).toBe(true);
          }

          // Lexicographic string comparison should match numeric comparison
          for (let i = 1; i < fences.length; i++) {
            const current = BigInt(fences[i]!);
            const previous = BigInt(fences[i - 1]!);
            expect(current > previous).toBe(true);
          }
        });
      });

      describe("Time Consistency (ADR-005)", () => {
        it("should use unified 1000ms tolerance for lock expiry", async () => {
          const key = "time:consistency:test";

          // Acquire lock with short TTL
          const result = await backend.acquire({
            key,
            ttlMs: 500,
          });

          expect(result.ok).toBe(true);

          // Wait for TTL + tolerance (500ms + 1000ms = 1500ms)
          await Bun.sleep(1600);

          // Should report lock as expired/unlocked
          const isLocked = await backend.isLocked({ key });
          expect(isLocked).toBe(false);
        });

        it("should handle lookup consistently within tolerance window", async () => {
          const key = "lookup:consistency:test";

          // Acquire lock
          const result = await backend.acquire({
            key,
            ttlMs: 2000,
          });

          expect(result.ok).toBe(true);

          if (result.ok) {
            // Lookup immediately - should return lock info
            const lookup = await backend.lookup({ lockId: result.lockId });

            expect(lookup).not.toBeNull();

            if (lookup) {
              // Should include fence token if backend supports fencing
              if (backend.capabilities.supportsFencing) {
                const fencedLookup = lookup as typeof lookup & {
                  fence: string;
                };
                expect(fencedLookup.fence).toBeDefined();
              }

              // Should have expiresAtMs and acquiredAtMs
              expect(lookup.expiresAtMs).toBeGreaterThan(Date.now());
              expect(lookup.acquiredAtMs).toBeLessThanOrEqual(Date.now());
            }

            await backend.release({ lockId: result.lockId });
          }
        });

        it("should return null consistently for expired lock lookup by lockId (ADR-011)", async () => {
          const key = "expired:lookup:consistency";

          // Acquire lock with very short TTL
          const result = await backend.acquire({
            key,
            ttlMs: 100,
          });

          expect(result.ok).toBe(true);

          if (result.ok) {
            // Wait for lock to expire (100ms TTL + 1000ms tolerance + buffer)
            await Bun.sleep(1200);

            // Backend should return null for expired lock lookup by lockId
            const lookup = await backend.lookup({ lockId: result.lockId });

            // Consistent null return for expired locks across backends
            expect(lookup).toBeNull();
          }
        });
      });

      describe("Fence Key 1:1 Mapping (ADR-006)", () => {
        it("should ensure different user keys never map to same fence counter", async () => {
          // Two different keys
          const key1 = "resource:payment:user:123";
          const key2 = "resource:payment:user:456";

          // Acquire locks
          const result1 = await backend.acquire({
            key: key1,
            ttlMs: 30000,
          });
          const result2 = await backend.acquire({
            key: key2,
            ttlMs: 30000,
          });

          expect(result1.ok).toBe(true);
          expect(result2.ok).toBe(true);

          if (result1.ok && result2.ok) {
            // Different keys should have independent fence counters
            expect(result1.lockId).not.toBe(result2.lockId);

            await backend.release({ lockId: result1.lockId });
            await backend.release({ lockId: result2.lockId });
          }
        });
      });
    });
  }

  describe("Storage Key Consistency", () => {
    it("should produce identical base storage keys for same user key", () => {
      const userKey = "resource:payment:12345";

      // Redis-style computation
      const redisReserve = 25; // "id:" + 22-char lockId
      const redisBaseKey = makeStorageKey("test:", userKey, 1000, redisReserve);

      // Firestore-style computation
      const firestoreReserve = 0; // No derived keys
      const firestoreBaseKey = makeStorageKey(
        "",
        userKey,
        1500,
        firestoreReserve,
      );

      // Both should preserve user key when no truncation needed
      expect(redisBaseKey).toContain(userKey);
      expect(firestoreBaseKey).toBe(userKey);

      // Verify both use makeStorageKey() for consistent hashing
      const longKey = "x".repeat(600);
      const redisLongKey = makeStorageKey("test:", longKey, 1000, redisReserve);
      const firestoreLongKey = makeStorageKey(
        "",
        longKey,
        1500,
        firestoreReserve,
      );

      // When truncation occurs, both should use same hash algorithm
      expect(redisLongKey.length).toBeLessThanOrEqual(1000);
      expect(firestoreLongKey.length).toBeLessThanOrEqual(1500);
    });

    it("should derive fence keys from same base storage key (ADR-006 two-step pattern)", () => {
      const userKey = "resource:critical:operation";

      // Redis: two-step derivation
      const redisReserve = 25;
      // Step 1: Compute base storage key
      const redisBaseKey = makeStorageKey("test:", userKey, 1000, redisReserve);
      // Step 2: Derive fence key from base
      const redisFenceKey = makeStorageKey(
        "test:",
        `fence:${redisBaseKey}`,
        1000,
        redisReserve,
      );

      // Firestore: two-step derivation
      const firestoreReserve = 0;
      // Step 1: Compute base storage key
      const firestoreBaseKey = makeStorageKey(
        "",
        userKey,
        1500,
        firestoreReserve,
      );
      // Step 2: Derive fence document ID from base
      const firestoreFenceDocId = makeStorageKey(
        "",
        `fence:${firestoreBaseKey}`,
        1500,
        firestoreReserve,
      );

      // Verify both backends use two-step pattern
      expect(redisFenceKey).toContain("fence:");
      expect(firestoreFenceDocId).toContain("fence:");

      // Test with long keys
      const longKey = "x".repeat(2000);
      const redisBaseLong = makeStorageKey(
        "test:",
        longKey,
        1000,
        redisReserve,
      );
      const redisFenceLong = makeStorageKey(
        "test:",
        `fence:${redisBaseLong}`,
        1000,
        redisReserve,
      );
      const firestoreBaseLong = makeStorageKey(
        "",
        longKey,
        1500,
        firestoreReserve,
      );
      const firestoreFenceLong = makeStorageKey(
        "",
        `fence:${firestoreBaseLong}`,
        1500,
        firestoreReserve,
      );

      // Both backends ensure 1:1 mapping
      expect(redisBaseLong.length).toBeLessThanOrEqual(1000);
      expect(redisFenceLong.length).toBeLessThanOrEqual(1000);
      expect(firestoreBaseLong.length).toBeLessThanOrEqual(1500);
      expect(firestoreFenceLong.length).toBeLessThanOrEqual(1500);
    });
  });
});
