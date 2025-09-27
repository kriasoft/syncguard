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
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import Redis from "ioredis";
import { createLock } from "../../redis";
import type { LockFunction } from "../../common";

describe("Redis Lock Integration Tests", () => {
  let redis: Redis;
  let lock: LockFunction;
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
    // Create lock instance with test-optimized settings
    lock = createLock(redis, {
      keyPrefix: testKeyPrefix,
      retryDelayMs: 25, // Faster retries for testing
      maxRetries: 10, // More retries for reliable tests
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
      const acquireResult = await lock.acquire({
        key: resourceKey,
        ttlMs: 30000, // 30 seconds
      });

      expect(acquireResult.success).toBe(true);

      if (acquireResult.success) {
        // Verify lock properties
        expect(acquireResult.lockId).toBeDefined();
        expect(typeof acquireResult.lockId).toBe("string");
        expect(acquireResult.expiresAt).toBeInstanceOf(Date);
        expect(acquireResult.expiresAt.getTime()).toBeGreaterThan(Date.now());

        // 2. Verify resource is locked
        const isLocked = await lock.isLocked(resourceKey);
        expect(isLocked).toBe(true);

        // 3. Release lock
        const released = await lock.release(acquireResult.lockId);
        expect(released).toBe(true);

        // 4. Verify resource is unlocked
        const isLockedAfter = await lock.isLocked(resourceKey);
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
          lockWasActiveInside = await lock.isLocked(resourceKey);

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
      const isLockedAfter = await lock.isLocked(resourceKey);
      expect(isLockedAfter).toBe(false);
    });

    it("should automatically release lock even when callback throws error", async () => {
      const resourceKey = "payment:transaction:error-test";
      let lockWasActiveBeforeError = false;

      try {
        await lock(
          async () => {
            // Verify lock is active
            lockWasActiveBeforeError = await lock.isLocked(resourceKey);

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
      const isLockedAfter = await lock.isLocked(resourceKey);
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
        resources.map((key) => lock.acquire({ key, ttlMs: 20000 })),
      );

      // All acquisitions should succeed
      results.forEach((result, index) => {
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.lockId).toBeDefined();
        }
      });

      // Verify all resources are locked
      const lockStatuses = await Promise.all(
        resources.map((key) => lock.isLocked(key)),
      );
      expect(lockStatuses).toEqual([true, true, true]);

      // Release all locks
      const releaseResults = await Promise.all(
        results.map((result, index) => {
          if (result.success) {
            return lock.release(result.lockId);
          }
          return false;
        }),
      );

      // All releases should succeed
      expect(releaseResults).toEqual([true, true, true]);

      // Verify all resources are unlocked
      const finalStatuses = await Promise.all(
        resources.map((key) => lock.isLocked(key)),
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
          retryDelayMs: 10,
          maxRetries: 50,
          timeoutMs: 2000,
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
          timeoutMs: 300, // Will timeout before first lock releases
          maxRetries: 50,
          retryDelayMs: 5,
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
          errorMessage.includes("Lock already held") ||
          errorMessage.includes("Failed to acquire lock");
        expect(isExpectedFailure).toBe(true);
      }
    });
  });

  describe("lock expiration", () => {
    it("should auto-expire locks after TTL", async () => {
      const key = "resource:9";

      // Acquire lock with short TTL
      const result = await lock.acquire({ key, ttlMs: 200 });
      expect(result.success).toBe(true);

      if (result.success) {
        // Verify lock is held
        expect(await lock.isLocked(key)).toBe(true);

        // Wait for TTL to expire
        await Bun.sleep(250);

        // Lock should be expired
        expect(await lock.isLocked(key)).toBe(false);

        // Another process should be able to acquire it
        const result2 = await lock.acquire({ key });
        expect(result2.success).toBe(true);

        if (result2.success) {
          await lock.release(result2.lockId);
        }
      }
    });

    it("should extend lock TTL", async () => {
      const key = "resource:10";

      // Acquire lock with short TTL
      const result = await lock.acquire({ key, ttlMs: 500 });
      expect(result.success).toBe(true);

      if (result.success) {
        // Wait a bit
        await Bun.sleep(300);

        // Extend the lock
        const extended = await lock.extend(result.lockId, 1000);
        expect(extended).toBe(true);

        // Wait past original expiry
        await Bun.sleep(300);

        // Lock should still be held
        expect(await lock.isLocked(key)).toBe(true);

        // Clean up
        await lock.release(result.lockId);
      }
    });

    it("should not extend expired lock", async () => {
      const key = "resource:11";

      // Acquire lock with very short TTL
      const result = await lock.acquire({ key, ttlMs: 100 });
      expect(result.success).toBe(true);

      if (result.success) {
        // Wait for lock to expire
        await Bun.sleep(150);

        // Try to extend expired lock
        const extended = await lock.extend(result.lockId, 1000);
        expect(extended).toBe(false);
      }
    });
  });

  describe("error handling", () => {
    it("should handle release of non-existent lock", async () => {
      const released = await lock.release("non-existent-lock-id");
      expect(released).toBe(false);
    });

    it("should handle double release", async () => {
      const key = "resource:12";

      const result = await lock.acquire({ key });
      expect(result.success).toBe(true);

      if (result.success) {
        // First release should succeed
        const released1 = await lock.release(result.lockId);
        expect(released1).toBe(true);

        // Second release should fail gracefully
        const released2 = await lock.release(result.lockId);
        expect(released2).toBe(false);
      }
    });

    it("should prevent release by wrong lock owner", async () => {
      const key = "resource:13";

      // First lock
      const result1 = await lock.acquire({ key });
      expect(result1.success).toBe(true);

      if (result1.success) {
        // Try to release with wrong lockId
        const released = await lock.release("wrong-lock-id");
        expect(released).toBe(false);

        // Original lock should still be held
        expect(await lock.isLocked(key)).toBe(true);

        // Clean up with correct lockId
        await lock.release(result1.lockId);
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
                retryDelayMs: 15,
                maxRetries: 30,
                timeoutMs: 3000,
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
      expect(await lock.isLocked(resourceKey)).toBe(false);
    });

    it("should handle rapid acquire/release cycles", async () => {
      const key = "resource:rapid";
      const cycles = 10;

      for (let i = 0; i < cycles; i++) {
        const result = await lock.acquire({ key });
        expect(result.success).toBe(true);

        if (result.success) {
          // Verify lock is held
          expect(await lock.isLocked(key)).toBe(true);

          // Release immediately
          const released = await lock.release(result.lockId);
          expect(released).toBe(true);

          // Verify lock is released
          expect(await lock.isLocked(key)).toBe(false);
        }
      }
    });
  });

  describe("cleanup behavior", () => {
    it("should clean up expired locks during isLocked check", async () => {
      const key = "resource:cleanup";

      // Create a lock with very short TTL
      const result = await lock.acquire({ key, ttlMs: 100 });
      expect(result.success).toBe(true);

      if (result.success) {
        // Wait for it to expire
        await Bun.sleep(150);

        // isLocked should trigger cleanup and return false
        const isLocked = await lock.isLocked(key);
        expect(isLocked).toBe(false);

        // Verify the lock was actually cleaned up (can acquire immediately)
        const result2 = await lock.acquire({ key });
        expect(result2.success).toBe(true);

        if (result2.success) {
          await lock.release(result2.lockId);
        }
      }
    });

    it("should handle orphaned index entries", async () => {
      const key = "resource:orphan";

      // Acquire a lock
      const result = await lock.acquire({ key });
      expect(result.success).toBe(true);

      if (result.success) {
        // Manually delete the main lock key, leaving orphaned index
        await redis.del(`${testKeyPrefix}${key}`);

        // Release should handle the orphaned index gracefully
        const released = await lock.release(result.lockId);
        expect(released).toBe(false); // Can't release non-existent lock

        // Should be able to acquire new lock
        const result2 = await lock.acquire({ key });
        expect(result2.success).toBe(true);

        if (result2.success) {
          await lock.release(result2.lockId);
        }
      }
    });
  });
});
