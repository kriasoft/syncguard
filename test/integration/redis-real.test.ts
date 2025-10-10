// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Integration tests for Redis backend with real Redis instance
 *
 * These tests verify:
 * - End-to-end functionality with actual Redis
 * - defineCommand() script caching works correctly
 * - Lua script execution and error handling
 * - Real-world concurrency scenarios
 * - Performance characteristics
 *
 * Requires Redis server running on localhost:6379 or REDIS_URL env var
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import Redis from "ioredis";
import type { LockBackend } from "../../common/backend.js";
import { createRedisBackend } from "../../redis/backend.js";

describe("Redis Integration Tests", () => {
  let redis: Redis;
  let backend: LockBackend;
  const testKeyPrefix = "syncguard:integration:test:";

  beforeAll(async () => {
    // Connect to Redis (use REDIS_URL env var or default to localhost)
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
    });

    // Verify Redis connection
    try {
      await redis.ping();
      console.log("✅ Connected to Redis for integration tests");
    } catch (error) {
      console.error("❌ Failed to connect to Redis:", error);
      throw new Error(
        "Redis integration tests require a Redis server. " +
          "Start Redis locally or set REDIS_URL environment variable.",
      );
    }

    // Create backend with test-specific prefix
    backend = createRedisBackend(redis, {
      keyPrefix: testKeyPrefix,
    });
  });

  afterAll(async () => {
    if (redis) {
      await redis.disconnect();
    }
  });

  beforeEach(async () => {
    // Clean up any test keys before each test
    const keys = await redis.keys(`${testKeyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe("Basic Lock Operations", () => {
    it("should acquire and release locks with real Redis", async () => {
      const result = await backend.acquire({
        key: "integration:basic:lock",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.lockId).toBe("string");
        expect(typeof result.expiresAtMs).toBe("number");
        expect(result.expiresAtMs).toBeGreaterThan(Date.now());

        // Verify lock exists in Redis
        const isLocked = await backend.isLocked({
          key: "integration:basic:lock",
        });
        expect(isLocked).toBe(true);

        // Release the lock
        const released = await backend.release({ lockId: result.lockId });
        expect(released.ok).toBe(true);

        // Verify lock is gone
        const isLockedAfter = await backend.isLocked({
          key: "integration:basic:lock",
        });
        expect(isLockedAfter).toBe(false);
      }
    });

    it("should handle lock contention correctly", async () => {
      // Acquire first lock
      const lock1 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock1.ok).toBe(true);

      // Try to acquire same resource - should fail
      const lock2 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock2.ok).toBe(false);
      if (!lock2.ok) {
        expect(lock2.reason).toBe("locked");
      }

      // Release first lock
      if (lock1.ok) {
        await backend.release({ lockId: lock1.lockId });
      }

      // Now should be able to acquire
      const lock3 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock3.ok).toBe(true);

      if (lock3.ok) {
        await backend.release({ lockId: lock3.lockId });
      }
    });

    it("should extend locks properly", async () => {
      const result = await backend.acquire({
        key: "integration:extend:test",
        ttlMs: 2000, // Short initial TTL
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const initialExpiry = result.expiresAtMs;

        // Wait a bit then extend
        await new Promise((resolve) => setTimeout(resolve, 500));

        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 5000,
        });
        expect(extended.ok).toBe(true);

        // Verify lock still exists and has longer TTL
        const isLocked = await backend.isLocked({
          key: "integration:extend:test",
        });
        expect(isLocked).toBe(true);

        await backend.release({ lockId: result.lockId });
      }
    });
  });

  describe("defineCommand() Script Caching", () => {
    it("should use defineCommand when available", async () => {
      // Verify that defineCommand was called during backend creation
      expect(typeof (redis as any).acquireLock).toBe("function");
      expect(typeof (redis as any).releaseLock).toBe("function");
      expect(typeof (redis as any).extendLock).toBe("function");
      expect(typeof (redis as any).checkLock).toBe("function");
    });

    it("should execute cached scripts efficiently", async () => {
      const startTime = Date.now();

      // Perform multiple operations to test script caching
      for (let i = 0; i < 10; i++) {
        const result = await backend.acquire({
          key: `integration:cache:test:${i}`,
          ttlMs: 30000,
        });

        if (result.ok) {
          await backend.release({ lockId: result.lockId });
        }
      }

      const elapsed = Date.now() - startTime;
      console.log(`10 acquire/release cycles took ${elapsed}ms`);

      // Should complete reasonably quickly with cached scripts
      expect(elapsed).toBeLessThan(1000); // Less than 1 second for 10 cycles
    });
  });

  describe("Concurrency and Race Conditions", () => {
    it("should handle concurrent lock attempts", async () => {
      const resourceKey = "integration:concurrent:resource";
      const attempts = 5;
      const promises = [];

      // Launch multiple concurrent lock attempts
      for (let i = 0; i < attempts; i++) {
        promises.push(
          backend.acquire({
            key: resourceKey,
            ttlMs: 1000,
          }),
        );
      }

      const results = await Promise.all(promises);

      // Exactly one should succeed
      const successful = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(attempts - 1);

      // Clean up the successful lock
      if (successful[0] && successful[0].ok) {
        await backend.release({ lockId: successful[0].lockId });
      }
    });

    it("should handle rapid acquire/release cycles", async () => {
      const resourceKey = "integration:rapid:cycles";

      for (let i = 0; i < 20; i++) {
        const result = await backend.acquire({
          key: resourceKey,
          ttlMs: 1000,
        });

        expect(result.ok).toBe(true);

        if (result.ok) {
          const released = await backend.release({ lockId: result.lockId });
          expect(released.ok).toBe(true);
        }
      }
    });
  });

  describe("Error Handling and Edge Cases", () => {
    it("should handle expired locks gracefully", async () => {
      const result = await backend.acquire({
        key: "integration:expiry:test",
        ttlMs: 100, // Very short TTL
      });

      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait for lock to expire
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Lock should be automatically cleaned up
        const isLocked = await backend.isLocked({
          key: "integration:expiry:test",
        });
        expect(isLocked).toBe(false);

        // Trying to extend expired lock should fail
        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 5000,
        });
        expect(extended.ok).toBe(false);

        // Release should be idempotent (no error)
        const released = await backend.release({ lockId: result.lockId });
        expect(released.ok).toBe(false); // Returns false for non-existent locks
      }
    });

    it("should handle malformed lock IDs", async () => {
      // These should throw LockError("InvalidArgument") per the interface specification
      await expect(backend.release({ lockId: "" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(backend.release({ lockId: "invalid-uuid" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(backend.extend({ lockId: "", ttlMs: 1000 })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(
        backend.extend({ lockId: "invalid-uuid", ttlMs: 1000 }),
      ).rejects.toThrow("Invalid lockId format");
    });
  });

  describe("Real Redis Data Verification", () => {
    it("should store lock data correctly in Redis", async () => {
      const result = await backend.acquire({
        key: "integration:data:verification",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);

      if (result.ok) {
        // Check main lock key
        const lockKey = `${testKeyPrefix}integration:data:verification`;
        const lockData = await redis.get(lockKey);
        expect(lockData).toBeTruthy();

        if (lockData) {
          const parsedData = JSON.parse(lockData);
          expect(parsedData.lockId).toBe(result.lockId);
          expect(parsedData.key).toBe("integration:data:verification");
          expect(typeof parsedData.expiresAtMs).toBe("number");
          expect(typeof parsedData.acquiredAtMs).toBe("number");

          // Check lockId index (ADR-013: stores full storage key, not user key)
          const lockIdKey = `${testKeyPrefix}id:${result.lockId}`;
          const indexData = await redis.get(lockIdKey);
          expect(indexData).toBe(lockKey); // ADR-013: Index stores full lockKey to handle truncation

          // Clean up
          await backend.release({ lockId: result.lockId });

          // Verify cleanup
          expect(await redis.get(lockKey)).toBeNull();
          expect(await redis.get(lockIdKey)).toBeNull();
        }
      }
    });

    it("should verify lookup operation works with cached scripts", async () => {
      const result = await backend.acquire({
        key: "integration:lookup:test",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Test key lookup
        const keyLookup = await backend.lookup({
          key: "integration:lookup:test",
        });
        expect(keyLookup).not.toBeNull();
        if (keyLookup) {
          expect(typeof keyLookup.keyHash).toBe("string");
          expect(typeof keyLookup.lockIdHash).toBe("string");
          // Allow small timing differences between client and server time
          expect(
            Math.abs(keyLookup.expiresAtMs - result.expiresAtMs),
          ).toBeLessThan(50);
          expect(typeof keyLookup.acquiredAtMs).toBe("number");

          // Verify fence token exists (Redis always supports fencing)
          expect("fence" in keyLookup).toBe(true);
          if ("fence" in keyLookup && "fence" in result) {
            expect(keyLookup.fence).toBe(result.fence);
          }
        }

        // Test lockId lookup (ownership check)
        const ownershipLookup = await backend.lookup({ lockId: result.lockId });
        expect(ownershipLookup).not.toBeNull();
        if (ownershipLookup) {
          expect(typeof ownershipLookup.keyHash).toBe("string");
          expect(typeof ownershipLookup.lockIdHash).toBe("string");
          // Allow small timing differences between client and server time
          expect(
            Math.abs(ownershipLookup.expiresAtMs - result.expiresAtMs),
          ).toBeLessThan(50);

          // Verify fence token exists (Redis always supports fencing)
          expect("fence" in ownershipLookup).toBe(true);
          if ("fence" in ownershipLookup && "fence" in result) {
            expect(ownershipLookup.fence).toBe(result.fence);
          }
        }

        await backend.release({ lockId: result.lockId });
      }
    });
  });
});
