// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Integration tests for Redis lock implementation
 *
 * These tests verify the complete lock functionality using a real Redis instance:
 * - Basic lock operations (acquire, release, extend, isLocked)
 * - Automatic lock management with callback pattern
 * - Lock contention and timing behavior
 * - TTL expiration and cleanup
 * - Concurrent access patterns
 * - Error recovery and edge cases
 *
 * Prerequisites:
 * - Redis server running on localhost:6379
 * - Tests use database 15 to avoid conflicts with other data
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import Redis from "ioredis";
import type { LockBackend } from "../../common";
import { LockError } from "../../common/errors.js";
import { createLock, createRedisBackend } from "../../redis";
import type { RedisCapabilities } from "../../redis/types.js";

describe("Redis Lock Integration Tests", () => {
  let redis: Redis;
  let lock: ReturnType<typeof createLock>;
  let backend: LockBackend<RedisCapabilities>;
  const testKeyPrefix = "test:syncguard:";

  beforeAll(async () => {
    // Connect to local Redis instance for testing
    redis = new Redis({
      host: "localhost",
      port: 6379,
      db: 15, // Dedicated test database
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    // Verify Redis connectivity
    try {
      await redis.ping();
    } catch (error) {
      console.warn("⚠️  Redis not available - integration tests will fail");
      console.warn("   Please ensure Redis is running on localhost:6379");
    }
  });

  beforeEach(async () => {
    // Create backend and lock with test-optimized settings
    backend = createRedisBackend(redis, {
      keyPrefix: testKeyPrefix,
    });
    lock = createLock(redis, {
      keyPrefix: testKeyPrefix,
    });

    // Clean slate for each test
    const keys = await redis.keys(`${testKeyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterEach(async () => {
    // Clean up all test locks
    const keys = await redis.keys(`${testKeyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  describe("Core Lock Operations", () => {
    it("should successfully perform complete lock lifecycle", async () => {
      const resourceKey = "user:profile:12345";

      // 1. Acquire lock
      const acquireResult = await backend.acquire({
        key: resourceKey,
        ttlMs: 30000, // 30 seconds
      });

      expect(acquireResult.ok).toBe(true);

      if (acquireResult.ok) {
        // Verify lock properties
        expect(acquireResult.lockId).toBeDefined();
        expect(typeof acquireResult.lockId).toBe("string");
        expect(acquireResult.expiresAtMs).toBeGreaterThan(Date.now());
        expect(typeof acquireResult.expiresAtMs).toBe("number");

        // 2. Verify resource is locked
        const isLocked = await backend.isLocked({ key: resourceKey });
        expect(isLocked).toBe(true);

        // 3. Release lock
        const releaseResult = await backend.release({
          lockId: acquireResult.lockId,
        });
        expect(releaseResult.ok).toBe(true);

        // 4. Verify resource is unlocked
        const isLockedAfter = await backend.isLocked({ key: resourceKey });
        expect(isLockedAfter).toBe(false);
      }
    });

    it("should automatically manage lock lifecycle with callback pattern", async () => {
      const resourceKey = "api:rate-limit:user:789";
      let criticalSectionExecuted = false;
      let lockWasActiveInside = false;

      // Execute critical section with automatic lock management
      const result = await lock(
        async () => {
          criticalSectionExecuted = true;

          // Verify lock is active during execution
          lockWasActiveInside = await backend.isLocked({ key: resourceKey });

          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 10));

          return "operation completed";
        },
        {
          key: resourceKey,
          ttlMs: 15000, // 15 seconds
        },
      );

      // Verify execution results
      expect(criticalSectionExecuted).toBe(true);
      expect(lockWasActiveInside).toBe(true);
      expect(result).toBe("operation completed");

      // Verify lock was automatically released
      const isLockedAfter = await backend.isLocked({ key: resourceKey });
      expect(isLockedAfter).toBe(false);
    });

    it("should automatically release lock even when callback throws error", async () => {
      const resourceKey = "payment:transaction:error-test";
      let lockWasActiveBeforeError = false;

      try {
        await lock(
          async () => {
            // Verify lock is active
            lockWasActiveBeforeError = await backend.isLocked({
              key: resourceKey,
            });

            // Simulate an error during critical section
            throw new Error("Simulated processing error");
          },
          {
            key: resourceKey,
            ttlMs: 10000,
          },
        );

        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toBe("Simulated processing error");
        expect(lockWasActiveBeforeError).toBe(true);
      }

      // Critical: Lock must be released even after error
      const isLockedAfter = await backend.isLocked({ key: resourceKey });
      expect(isLockedAfter).toBe(false);
    });

    it("should handle multiple lock operations on different resources", async () => {
      const resources = [
        "database:connection:1",
        "cache:key:user-session",
        "file:upload:temp-123",
      ];

      // Acquire locks on all resources simultaneously
      const results = await Promise.all(
        resources.map((key) => backend.acquire({ key, ttlMs: 20000 })),
      );

      // All acquisitions should succeed
      results.forEach((result, index) => {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.lockId).toBeDefined();
        }
      });

      // Verify all resources are locked
      const lockStatuses = await Promise.all(
        resources.map((key) => backend.isLocked({ key })),
      );
      expect(lockStatuses).toEqual([true, true, true]);

      // Release all locks
      const releaseResults = await Promise.all(
        results.map((result, index) => {
          if (result.ok) {
            return backend.release({ lockId: result.lockId });
          }
          return { ok: false as const, reason: "failed" as const };
        }),
      );

      // All releases should succeed
      releaseResults.forEach((result) => {
        expect(result.ok).toBe(true);
      });

      // Verify all resources are unlocked
      const finalStatuses = await Promise.all(
        resources.map((key) => backend.isLocked({ key })),
      );
      expect(finalStatuses).toEqual([false, false, false]);
    });
  });

  describe("Lock Contention", () => {
    it("should prevent concurrent access and ensure data consistency", async () => {
      const resourceKey = "shared:counter";
      let sharedCounter = 0;
      const incrementResults: number[] = [];

      // Two operations that modify shared state
      const operation1 = lock(
        async () => {
          const current = sharedCounter;
          await Bun.sleep(30); // Simulate some work
          sharedCounter = current + 1;
          incrementResults.push(sharedCounter);
        },
        { key: resourceKey },
      );

      // Slight delay to ensure operation1 starts first
      await Bun.sleep(10);

      const operation2 = lock(
        async () => {
          const current = sharedCounter;
          await Bun.sleep(30); // Simulate some work
          sharedCounter = current + 1;
          incrementResults.push(sharedCounter);
        },
        {
          key: resourceKey,
          acquisition: {
            retryDelayMs: 10,
            maxRetries: 50,
            timeoutMs: 2000,
          },
        },
      );

      // Wait for both operations
      const results = await Promise.allSettled([operation1, operation2]);

      // At least one operation should succeed
      const successCount = results.filter(
        (r) => r.status === "fulfilled",
      ).length;
      expect(successCount).toBeGreaterThan(0);

      // If both succeeded, counter should be 2 and results should be [1, 2]
      if (successCount === 2) {
        expect(sharedCounter).toBe(2);
        expect(incrementResults).toEqual([1, 2]);
      } else {
        // If only one succeeded, counter should be 1
        expect(sharedCounter).toBe(1);
        expect(incrementResults).toEqual([1]);
      }
    });

    it("should allow concurrent access to different resources", async () => {
      const startTime = Date.now();

      // Lock different resources concurrently
      await Promise.all([
        lock(
          async () => {
            await Bun.sleep(100);
          },
          { key: "resource:5" },
        ),
        lock(
          async () => {
            await Bun.sleep(100);
          },
          { key: "resource:6" },
        ),
        lock(
          async () => {
            await Bun.sleep(100);
          },
          { key: "resource:7" },
        ),
      ]);

      const elapsed = Date.now() - startTime;

      // Should complete in ~100ms (parallel), not 300ms (sequential)
      expect(elapsed).toBeLessThan(200);
    });

    it("should respect acquisition timeout and fail gracefully", async () => {
      const resourceKey = "resource:timeout-test";

      // First lock holds for longer than second lock's timeout
      const longRunningLock = lock(
        async () => {
          await Bun.sleep(800); // Hold lock for 800ms
        },
        {
          key: resourceKey,
          ttlMs: 60000, // Long TTL so it doesn't expire
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
          key: resourceKey,
          acquisition: {
            timeoutMs: 300, // Will timeout before first lock releases
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
      if (results[1].status === "rejected") {
        // Could fail with timeout or lock contention message
        const errorMessage = results[1].reason.message;
        const isExpectedFailure =
          errorMessage.includes("timeout") ||
          errorMessage.includes("Timeout") ||
          errorMessage.includes("Lock already held") ||
          errorMessage.includes("Failed to acquire lock");
        if (!isExpectedFailure) {
          console.log("Unexpected error message:", errorMessage);
        }
        expect(isExpectedFailure).toBe(true);
      }
    });
  });

  describe("lock expiration", () => {
    it("should auto-expire locks after TTL", async () => {
      const key = "resource:9";

      // Acquire lock with short TTL
      const result = await backend.acquire({ key, ttlMs: 200 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Verify lock is held
        expect(await backend.isLocked({ key: key })).toBe(true);

        // Wait for TTL to expire
        await Bun.sleep(250);

        // Lock should be expired
        expect(await backend.isLocked({ key: key })).toBe(false);

        // Another process should be able to acquire it
        const result2 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result2.ok).toBe(true);

        if (result2.ok) {
          await backend.release({ lockId: result2.lockId });
        }
      }
    });

    it("should extend lock TTL", async () => {
      const key = "resource:10";

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

        // Wait past original expiry
        await Bun.sleep(300);

        // Lock should still be held
        expect(await backend.isLocked({ key: key })).toBe(true);

        // Clean up
        await backend.release({ lockId: result.lockId });
      }
    });

    it("should not extend expired lock", async () => {
      const key = "resource:11";

      // Acquire lock with very short TTL
      const result = await backend.acquire({ key, ttlMs: 100 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait for lock to expire
        await Bun.sleep(150);

        // Try to extend expired lock
        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 1000,
        });
        expect(extended.ok).toBe(false);
      }
    });
  });

  describe("error handling", () => {
    it("should handle release of non-existent lock", async () => {
      const released = await backend.release({
        lockId: "AAAAAAAAAAAAAAAAAAAAAA", // Valid format but non-existent
      });
      expect(released.ok).toBe(false);
    });

    it("should handle double release", async () => {
      const key = "resource:12";

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

    it("should prevent release by wrong lock owner", async () => {
      const key = "resource:13";

      // First lock
      const result1 = await backend.acquire({ key, ttlMs: 30000 });
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        // Try to release with wrong lockId
        const released = await backend.release({
          lockId: "wrongLockIdTest1234567",
        }); // Valid format but wrong owner
        expect(released.ok).toBe(false);

        // Original lock should still be held
        expect(await backend.isLocked({ key: key })).toBe(true);

        // Clean up with correct lockId
        await backend.release({ lockId: result1.lockId });
      }
    });
  });

  describe("Stress Testing", () => {
    it("should demonstrate lock contention behavior under concurrent load", async () => {
      const numOperations = 5; // Moderate load for consistent testing
      const resourceKey = "resource:stress-test";
      let successfulOperations = 0;
      const errors: Error[] = [];

      // Create concurrent lock operations
      const promises = Array.from(
        { length: numOperations },
        async (_, index) => {
          try {
            await lock(
              async () => {
                successfulOperations++;
                await Bun.sleep(10); // Brief critical section
              },
              {
                key: resourceKey,
                acquisition: {
                  retryDelayMs: 15,
                  maxRetries: 30,
                  timeoutMs: 3000,
                },
              },
            );
          } catch (error) {
            errors.push(error as Error);
          }
        },
      );

      await Promise.all(promises);

      // Verify some operations succeeded (exact number depends on timing)
      expect(successfulOperations).toBeGreaterThan(0);
      expect(successfulOperations).toBeLessThanOrEqual(numOperations);

      // Lock contention failures are expected and acceptable
      if (errors.length > 0) {
        errors.forEach((error) => {
          expect(error.message).toMatch(
            /Failed to acquire lock|timeout|Lock already held/,
          );
        });
      }

      // Verify no dangling locks remain
      expect(await backend.isLocked({ key: resourceKey })).toBe(false);
    });

    it("should handle rapid acquire/release cycles", async () => {
      const key = "resource:rapid";
      const cycles = 10;

      for (let i = 0; i < cycles; i++) {
        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          // Verify lock is held
          expect(await backend.isLocked({ key: key })).toBe(true);

          // Release immediately
          const released = await backend.release({ lockId: result.lockId });
          expect(released.ok).toBe(true);

          // Verify lock is released
          expect(await backend.isLocked({ key: key })).toBe(false);
        }
      }
    });
  });

  describe("cleanup behavior", () => {
    it("should clean up expired locks during isLocked check", async () => {
      const key = "resource:cleanup";

      // Create a lock with very short TTL
      const result = await backend.acquire({ key, ttlMs: 100 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait for it to expire
        await Bun.sleep(150);

        // isLocked should trigger cleanup and return false
        const isLocked = await backend.isLocked({ key: key });
        expect(isLocked).toBe(false);

        // Verify the lock was actually cleaned up (can acquire immediately)
        const result2 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result2.ok).toBe(true);

        if (result2.ok) {
          await backend.release({ lockId: result2.lockId });
        }
      }
    });

    it("should handle orphaned index entries", async () => {
      const key = "resource:orphan";

      // Acquire a lock
      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Manually delete the main lock key, leaving orphaned index
        await redis.del(`${testKeyPrefix}${key}`);

        // Release should handle the orphaned index gracefully
        const released = await backend.release({ lockId: result.lockId });
        expect(released.ok).toBe(false); // Can't release non-existent lock

        // Should be able to acquire new lock
        const result2 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result2.ok).toBe(true);

        if (result2.ok) {
          await backend.release({ lockId: result2.lockId });
        }
      }
    });
  });

  describe("Ownership Verification (ADR-003)", () => {
    it("should verify ownership explicitly in release operation", async () => {
      const key = "ownership:release:test";

      // Acquire a lock
      const result1 = await backend.acquire({ key, ttlMs: 30000 });
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        // Try to release with a different valid lockId
        const fakeLockId = "abcdefghijklmnopqrstuv"; // Valid format, wrong owner
        const releaseResult = await backend.release({ lockId: fakeLockId });

        // Should fail due to explicit ownership verification in Lua script
        expect(releaseResult.ok).toBe(false);

        // Original lock should still be held
        expect(await backend.isLocked({ key })).toBe(true);

        // Clean up with correct lockId
        await backend.release({ lockId: result1.lockId });
      }
    });

    it("should verify ownership explicitly in extend operation", async () => {
      const key = "ownership:extend:test";

      // Acquire a lock
      const result1 = await backend.acquire({ key, ttlMs: 30000 });
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        // Try to extend with a different valid lockId (22 base64url chars)
        const fakeLockId = "eHh4eHh4eHh4eHh4eHh4eA"; // Valid format, wrong owner
        const extendResult = await backend.extend({
          lockId: fakeLockId,
          ttlMs: 60000,
        });

        // Should fail due to explicit ownership verification in Lua script
        expect(extendResult.ok).toBe(false);

        // Original lock should still be held with original TTL
        expect(await backend.isLocked({ key })).toBe(true);

        // Clean up
        await backend.release({ lockId: result1.lockId });
      }
    });

    it("should handle stale reverse index gracefully via explicit verification", async () => {
      const key = "ownership:stale-index:test";

      // Acquire a lock
      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Manually corrupt the reverse index (simulate race condition)
        // Point the lockId index to a different key
        await redis.set(
          `${testKeyPrefix}id:${result.lockId}`,
          "different:key:value",
          "PX",
          30000,
        );

        // Release should fail due to explicit ownership verification
        // Even though the index exists, the actual lock has different data
        const releaseResult = await backend.release({ lockId: result.lockId });
        expect(releaseResult.ok).toBe(false);

        // Clean up: restore correct state
        await redis.del(`${testKeyPrefix}id:${result.lockId}`);
        await redis.del(`${testKeyPrefix}${key}`);
      }
    });
  });

  describe("Fence Token Compliance", () => {
    it("should generate fence tokens in 15-digit zero-padded format", async () => {
      const key = "fence:format:test";
      const fenceFormatRegex = /^\d{15}$/; // ADR-004: exactly 15 digits for precision safety

      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Verify fence format compliance
        expect(result.fence).toMatch(fenceFormatRegex);
        expect(result.fence.length).toBe(15);
        expect(Number(result.fence)).toBeGreaterThan(0);

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should generate monotonically increasing fences with lexicographic ordering", async () => {
      const key = "fence:monotonic:test";
      const fences: string[] = [];

      // Acquire and release locks multiple times
      for (let i = 0; i < 5; i++) {
        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          fences.push(result.fence);
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
  });

  describe("Time Authority & ADR-010 Compliance", () => {
    it("should return authoritative expiresAtMs from acquire operation (Redis server time)", async () => {
      const key = "time:acquire:test";
      const ttlMs = 5000;

      // Capture time before operation
      const beforeMs = Date.now();

      const result = await backend.acquire({ key, ttlMs });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Capture time after operation
        const afterMs = Date.now();

        // expiresAtMs should be authoritative (computed from Redis TIME command)
        // Per redis-backend.md line 241: MUST return authoritative expiresAtMs
        // Redis TIME command has microsecond precision, but conversion to ms truncates
        // Allow 100ms tolerance for precision loss, timing differences, and clock skew
        const minExpiry = beforeMs + ttlMs - 100;
        const maxExpiry = afterMs + ttlMs + 100;

        expect(result.expiresAtMs).toBeGreaterThanOrEqual(minExpiry);
        expect(result.expiresAtMs).toBeLessThanOrEqual(maxExpiry);

        // Verify it's a precise value, not approximated
        expect(Number.isInteger(result.expiresAtMs)).toBe(true);

        // Verify it's based on Redis server time (should be close to Date.now() + ttl)
        // Allow for clock skew between client and Redis server plus network latency
        const expectedExpiry = afterMs + ttlMs;
        const timeDiff = Math.abs(result.expiresAtMs - expectedExpiry);
        expect(timeDiff).toBeLessThan(1000); // 1000ms tolerance for clock skew + network/processing

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should return authoritative expiresAtMs from extend operation (Redis server time)", async () => {
      const key = "time:extend:test";
      const initialTtlMs = 2000;
      const extendTtlMs = 5000;

      // Acquire lock
      const result = await backend.acquire({ key, ttlMs: initialTtlMs });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait a bit
        await Bun.sleep(100);

        // Capture time before extend
        const beforeExtendMs = Date.now();

        const extendResult = await backend.extend({
          lockId: result.lockId,
          ttlMs: extendTtlMs,
        });
        expect(extendResult.ok).toBe(true);

        if (extendResult.ok) {
          // Capture time after extend
          const afterExtendMs = Date.now();

          // expiresAtMs should be authoritative (computed from Redis TIME command)
          // Per redis-backend.md line 303: MUST return authoritative expiresAtMs
          // Redis TIME command has microsecond precision, but conversion to ms truncates
          // Allow 100ms tolerance for precision loss, timing differences, and clock skew
          const minExpiry = beforeExtendMs + extendTtlMs - 100;
          const maxExpiry = afterExtendMs + extendTtlMs + 100;

          expect(extendResult.expiresAtMs).toBeGreaterThanOrEqual(minExpiry);
          expect(extendResult.expiresAtMs).toBeLessThanOrEqual(maxExpiry);

          // Verify it's a precise value, not approximated
          expect(Number.isInteger(extendResult.expiresAtMs)).toBe(true);

          // Verify extend actually reset the TTL (not added to original)
          expect(extendResult.expiresAtMs).toBeGreaterThan(result.expiresAtMs);

          // Verify it's based on Redis server time
          // Allow for clock skew between client and Redis server plus network latency
          const expectedExpiry = afterExtendMs + extendTtlMs;
          const timeDiff = Math.abs(extendResult.expiresAtMs - expectedExpiry);
          expect(timeDiff).toBeLessThan(1000); // 1000ms tolerance for clock skew + network/processing

          await backend.release({ lockId: result.lockId });
        }
      }
    });

    it("should use Redis server time consistently across operations", async () => {
      const key = "time:consistency:test";

      // Acquire lock
      const acquireResult = await backend.acquire({ key, ttlMs: 10000 });
      expect(acquireResult.ok).toBe(true);

      if (acquireResult.ok) {
        const acquireExpiry = acquireResult.expiresAtMs;

        // Extend lock
        await Bun.sleep(50);
        const extendResult = await backend.extend({
          lockId: acquireResult.lockId,
          ttlMs: 10000,
        });
        expect(extendResult.ok).toBe(true);

        if (extendResult.ok) {
          // Extended expiry should be later than original
          expect(extendResult.expiresAtMs).toBeGreaterThan(acquireExpiry);

          // Both should be based on same time authority (Redis server)
          // The difference should roughly match the sleep duration
          const timeDiff = extendResult.expiresAtMs - acquireExpiry;
          expect(timeDiff).toBeGreaterThan(0);
          expect(timeDiff).toBeLessThan(200); // Account for network latency

          await backend.release({ lockId: acquireResult.lockId });
        }
      }
    });
  });

  describe("Lookup Operations", () => {
    it("should validate key before performing lookup (spec requirement)", async () => {
      // Per spec lines 568-571: MUST validate inputs before any I/O operations

      // Invalid keys should throw immediately without I/O
      await expect(backend.lookup({ key: "" })).rejects.toThrow(LockError);
      await expect(backend.lookup({ key: "x".repeat(600) })).rejects.toThrow(
        "exceeds maximum length",
      );
    });

    it("should validate lockId before performing lookup (spec requirement)", async () => {
      // Per spec lines 568-571: MUST validate inputs before any I/O operations

      // Invalid lockIds should throw immediately without I/O
      await expect(backend.lookup({ lockId: "" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(
        backend.lookup({ lockId: "invalid-lockid" }),
      ).rejects.toThrow("Invalid lockId format");
      await expect(backend.lookup({ lockId: "too-short" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(
        backend.lookup({ lockId: "this-is-way-too-long-for-valid-lockid" }),
      ).rejects.toThrow("Invalid lockId format");
    });

    it("should lookup lock by key and return sanitized data", async () => {
      const resourceKey = "lookup:test:resource";

      // Acquire a lock
      const acquireResult = await backend.acquire({
        key: resourceKey,
        ttlMs: 30000,
      });
      expect(acquireResult.ok).toBe(true);

      if (acquireResult.ok) {
        // Test lookup operation
        const lookupResult = await backend.lookup({ key: resourceKey });
        expect(lookupResult).not.toBeNull();

        if (lookupResult) {
          // Verify sanitized data structure
          expect(typeof lookupResult.keyHash).toBe("string");
          expect(typeof lookupResult.lockIdHash).toBe("string");
          // Allow small timing differences between client and server time
          expect(
            Math.abs(lookupResult.expiresAtMs - acquireResult.expiresAtMs),
          ).toBeLessThan(15);
          expect(typeof lookupResult.acquiredAtMs).toBe("number");

          // Verify fence token exists (Redis always supports fencing)
          expect("fence" in lookupResult).toBe(true);
          if ("fence" in lookupResult && "fence" in acquireResult) {
            expect(lookupResult.fence).toBe(acquireResult.fence);
          }

          // Verify no raw data is included (sanitized)
          expect((lookupResult as any).key).toBeUndefined();
          expect((lookupResult as any).lockId).toBeUndefined();
        }

        // Clean up
        await backend.release({ lockId: acquireResult.lockId });
      }
    });

    it("should lookup lock by lockId (ownership check)", async () => {
      const resourceKey = "lookup:ownership:test";

      // Acquire a lock
      const acquireResult = await backend.acquire({
        key: resourceKey,
        ttlMs: 30000,
      });
      expect(acquireResult.ok).toBe(true);

      if (acquireResult.ok) {
        // Test ownership lookup
        const lookupResult = await backend.lookup({
          lockId: acquireResult.lockId,
        });
        expect(lookupResult).not.toBeNull();

        if (lookupResult) {
          // Verify sanitized data structure
          expect(typeof lookupResult.keyHash).toBe("string");
          expect(typeof lookupResult.lockIdHash).toBe("string");
          // Allow small timing differences between client and server time
          expect(
            Math.abs(lookupResult.expiresAtMs - acquireResult.expiresAtMs),
          ).toBeLessThan(15);
          expect(typeof lookupResult.acquiredAtMs).toBe("number");

          // Verify fence token exists (Redis always supports fencing)
          expect("fence" in lookupResult).toBe(true);
          if ("fence" in lookupResult && "fence" in acquireResult) {
            expect(lookupResult.fence).toBe(acquireResult.fence);
          }

          // Verify no raw data is included (sanitized)
          expect((lookupResult as any).key).toBeUndefined();
          expect((lookupResult as any).lockId).toBeUndefined();
        }

        // Clean up
        await backend.release({ lockId: acquireResult.lockId });
      }
    });

    it("should return null for non-existent lock (key lookup)", async () => {
      const lookupResult = await backend.lookup({
        key: "non-existent:lock:key",
      });
      expect(lookupResult).toBeNull();
    });

    it("should return null for non-existent lock (lockId lookup)", async () => {
      const lookupResult = await backend.lookup({
        lockId: "AAAAAAAAAAAAAAAAAAAAAA",
      }); // Valid format but non-existent
      expect(lookupResult).toBeNull();
    });

    it("should return null for expired lock", async () => {
      const resourceKey = "lookup:expired:test";

      // Acquire lock with very short TTL
      const acquireResult = await backend.acquire({
        key: resourceKey,
        ttlMs: 100,
      });
      expect(acquireResult.ok).toBe(true);

      if (acquireResult.ok) {
        // Wait for lock to expire
        await Bun.sleep(150);

        // Lookup should return null for expired lock
        const lookupResult = await backend.lookup({ key: resourceKey });
        expect(lookupResult).toBeNull();

        // Ownership lookup should also return null
        const ownershipResult = await backend.lookup({
          lockId: acquireResult.lockId,
        });
        expect(ownershipResult).toBeNull();
      }
    });
  });

  describe("Fence Counter Protection", () => {
    it("should NEVER delete fence counter keys during cleanup", async () => {
      const key = "fence:cleanup:test";

      // Acquire and release lock to establish fence counter
      const result1 = await backend.acquire({ key, ttlMs: 100 });
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        const fence1 = result1.fence;

        // Release the lock
        await backend.release({ lockId: result1.lockId });

        // Wait for lock to expire completely (100ms TTL + buffer)
        await Bun.sleep(150);

        // Trigger cleanup via isLocked
        const isLocked = await backend.isLocked({ key });
        expect(isLocked).toBe(false);

        // Acquire new lock - fence counter MUST persist
        const result2 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result2.ok).toBe(true);

        if (result2.ok) {
          // Fence MUST be monotonically increasing (fence counter survived cleanup)
          expect(BigInt(result2.fence)).toBeGreaterThan(BigInt(fence1));

          // Clean up
          await backend.release({ lockId: result2.lockId });
        }
      }
    });

    it("should maintain fence monotonicity across multiple cleanup cycles", async () => {
      const key = "fence:cleanup:monotonic";
      const fences: string[] = [];

      // Run multiple acquire-cleanup-acquire cycles
      for (let i = 0; i < 3; i++) {
        // Acquire lock with short TTL
        const result = await backend.acquire({ key, ttlMs: 100 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          fences.push(result.fence);
          await backend.release({ lockId: result.lockId });
        }

        // Wait for cleanup (100ms TTL + buffer)
        await Bun.sleep(150);

        // Trigger cleanup
        await backend.isLocked({ key });
      }

      // Verify fence monotonicity across cleanup cycles
      expect(fences).toHaveLength(3);
      for (let i = 1; i < fences.length; i++) {
        expect(BigInt(fences[i]!)).toBeGreaterThan(BigInt(fences[i - 1]!));
      }
    });

    it("should protect fence counter from direct Redis access during cleanup", async () => {
      const key = "fence:cleanup:protection";

      // Acquire initial lock to create fence counter
      const result1 = await backend.acquire({ key, ttlMs: 100 });
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        await backend.release({ lockId: result1.lockId });

        // Wait for cleanup window
        await Bun.sleep(150);

        // Trigger cleanup
        await backend.isLocked({ key });

        // Verify fence counter key still exists
        const fenceKey = `${testKeyPrefix}fence:${testKeyPrefix}${key}`;
        const fenceValue = await redis.get(fenceKey);

        // Fence counter MUST still exist after cleanup
        expect(fenceValue).not.toBeNull();
        expect(Number(fenceValue)).toBeGreaterThan(0);

        // Clean up
        await redis.del(fenceKey);
      }
    });
  });
});
