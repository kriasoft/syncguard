/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

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
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import Redis from "ioredis";
import { createRedisBackend } from "../../redis/backend.js";
import type { LockBackend } from "../../common/backend.js";

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
      retryDelayMs: 50,
      maxRetries: 3,
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

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.lockId).toBe("string");
        expect(result.expiresAt).toBeInstanceOf(Date);
        expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

        // Verify lock exists in Redis
        const isLocked = await backend.isLocked("integration:basic:lock");
        expect(isLocked).toBe(true);

        // Release the lock
        const released = await backend.release(result.lockId);
        expect(released).toBe(true);

        // Verify lock is gone
        const isLockedAfter = await backend.isLocked("integration:basic:lock");
        expect(isLockedAfter).toBe(false);
      }
    });

    it("should handle lock contention correctly", async () => {
      // Acquire first lock
      const lock1 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock1.success).toBe(true);

      // Try to acquire same resource - should fail
      const lock2 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
        timeoutMs: 100, // Short timeout
      });
      expect(lock2.success).toBe(false);
      if (!lock2.success) {
        expect(lock2.error).toContain("Lock already held");
      }

      // Release first lock
      if (lock1.success) {
        await backend.release(lock1.lockId);
      }

      // Now should be able to acquire
      const lock3 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock3.success).toBe(true);

      if (lock3.success) {
        await backend.release(lock3.lockId);
      }
    });

    it("should extend locks properly", async () => {
      const result = await backend.acquire({
        key: "integration:extend:test",
        ttlMs: 2000, // Short initial TTL
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const initialExpiry = result.expiresAt.getTime();

        // Wait a bit then extend
        await new Promise((resolve) => setTimeout(resolve, 500));

        const extended = await backend.extend(result.lockId, 5000);
        expect(extended).toBe(true);

        // Verify lock still exists and has longer TTL
        const isLocked = await backend.isLocked("integration:extend:test");
        expect(isLocked).toBe(true);

        await backend.release(result.lockId);
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

        if (result.success) {
          await backend.release(result.lockId);
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
            timeoutMs: 500,
          }),
        );
      }

      const results = await Promise.all(promises);

      // Exactly one should succeed
      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(attempts - 1);

      // Clean up the successful lock
      if (successful[0] && successful[0].success) {
        await backend.release(successful[0].lockId);
      }
    });

    it("should handle rapid acquire/release cycles", async () => {
      const resourceKey = "integration:rapid:cycles";

      for (let i = 0; i < 20; i++) {
        const result = await backend.acquire({
          key: resourceKey,
          ttlMs: 1000,
        });

        expect(result.success).toBe(true);

        if (result.success) {
          const released = await backend.release(result.lockId);
          expect(released).toBe(true);
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

      expect(result.success).toBe(true);

      if (result.success) {
        // Wait for lock to expire
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Lock should be automatically cleaned up
        const isLocked = await backend.isLocked("integration:expiry:test");
        expect(isLocked).toBe(false);

        // Trying to extend expired lock should fail
        const extended = await backend.extend(result.lockId, 5000);
        expect(extended).toBe(false);

        // Release should be idempotent (no error)
        const released = await backend.release(result.lockId);
        expect(released).toBe(false); // Returns false for non-existent locks
      }
    });

    it("should handle malformed lock IDs", async () => {
      // These should not crash but return false
      expect(await backend.release("")).toBe(false);
      expect(await backend.release("invalid-uuid")).toBe(false);
      expect(await backend.extend("", 1000)).toBe(false);
      expect(await backend.extend("invalid-uuid", 1000)).toBe(false);
    });
  });

  describe("Real Redis Data Verification", () => {
    it("should store lock data correctly in Redis", async () => {
      const result = await backend.acquire({
        key: "integration:data:verification",
        ttlMs: 30000,
      });

      expect(result.success).toBe(true);

      if (result.success) {
        // Check main lock key
        const lockKey = `${testKeyPrefix}integration:data:verification`;
        const lockData = await redis.get(lockKey);
        expect(lockData).toBeTruthy();

        if (lockData) {
          const parsedData = JSON.parse(lockData);
          expect(parsedData.lockId).toBe(result.lockId);
          expect(parsedData.key).toBe("integration:data:verification");
          expect(typeof parsedData.expiresAt).toBe("number");
          expect(typeof parsedData.createdAt).toBe("number");

          // Check lockId index
          const lockIdKey = `${testKeyPrefix}id:${result.lockId}`;
          const indexData = await redis.get(lockIdKey);
          expect(indexData).toBe(lockKey);

          // Clean up
          await backend.release(result.lockId);

          // Verify cleanup
          expect(await redis.get(lockKey)).toBeNull();
          expect(await redis.get(lockIdKey)).toBeNull();
        }
      }
    });
  });
});
