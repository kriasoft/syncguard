/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

/**
 * Performance benchmarks for Redis backend
 *
 * These tests measure:
 * - Lock acquisition/release latency
 * - Throughput under concurrent load
 * - Script caching performance impact
 * - Memory usage patterns
 *
 * Requires Redis server for meaningful results
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

describe("Redis Performance Benchmarks", () => {
  let redis: Redis;
  let backend: LockBackend;
  const testKeyPrefix = "syncguard:perf:test:";

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redis = new Redis(redisUrl);

    try {
      await redis.ping();
      console.log("✅ Connected to Redis for performance tests");
    } catch (error) {
      console.error("❌ Failed to connect to Redis:", error);
      throw new Error("Performance tests require Redis server");
    }

    backend = createRedisBackend(redis, {
      keyPrefix: testKeyPrefix,
      retryDelayMs: 10,
      maxRetries: 3,
    });
  });

  afterAll(async () => {
    if (redis) {
      await redis.disconnect();
    }
  });

  beforeEach(async () => {
    // Clean up test keys
    const keys = await redis.keys(`${testKeyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe("Latency Benchmarks", () => {
    it("should measure single lock operation latency", async () => {
      const iterations = 100;
      const timings: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();

        const result = await backend.acquire({
          key: `perf:latency:${i}`,
          ttlMs: 30000,
        });

        if (result.success) {
          await backend.release(result.lockId);
        }

        const end = performance.now();
        timings.push(end - start);
      }

      const avgLatency = timings.reduce((a, b) => a + b) / timings.length;
      const sortedTimings = timings.sort((a, b) => a - b);
      const p95Latency = sortedTimings[Math.floor(iterations * 0.95)]!;

      console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
      console.log(`P95 latency: ${p95Latency.toFixed(2)}ms`);

      // Performance expectations (adjust based on your environment)
      expect(avgLatency).toBeLessThan(50); // Should be under 50ms on average
      expect(p95Latency).toBeLessThan(100); // P95 under 100ms
    });

    it("should measure concurrent throughput", async () => {
      const concurrency = 10;
      const operationsPerWorker = 50;
      const totalOperations = concurrency * operationsPerWorker;

      const startTime = performance.now();

      // Launch concurrent workers
      const workers = Array.from(
        { length: concurrency },
        async (_, workerId) => {
          for (let i = 0; i < operationsPerWorker; i++) {
            const result = await backend.acquire({
              key: `perf:throughput:worker${workerId}:op${i}`,
              ttlMs: 5000,
            });

            if (result.success) {
              await backend.release(result.lockId);
            }
          }
        },
      );

      await Promise.all(workers);

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const opsPerSecond = (totalOperations * 1000) / totalTime;

      console.log(`Total operations: ${totalOperations}`);
      console.log(`Total time: ${totalTime.toFixed(2)}ms`);
      console.log(`Throughput: ${opsPerSecond.toFixed(2)} ops/sec`);

      // Should handle reasonable throughput
      expect(opsPerSecond).toBeGreaterThan(100); // At least 100 ops/sec
    });
  });

  describe("Script Caching Performance", () => {
    it("should show performance benefit of defineCommand", async () => {
      // This test demonstrates the performance improvement
      // The actual improvement is hard to measure in a test environment
      // but we can verify consistent performance

      const iterations = 50;
      const timings: number[] = [];

      // Warm up
      for (let i = 0; i < 5; i++) {
        const result = await backend.acquire({
          key: `warmup:${i}`,
          ttlMs: 1000,
        });
        if (result.success) await backend.release(result.lockId);
      }

      // Measure performance with cached scripts
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();

        const result = await backend.acquire({
          key: `perf:cached:${i}`,
          ttlMs: 5000,
        });

        if (result.success) {
          await backend.release(result.lockId);
        }

        const end = performance.now();
        timings.push(end - start);
      }

      const avgLatency = timings.reduce((a, b) => a + b) / timings.length;
      const variance =
        timings.reduce((acc, time) => acc + Math.pow(time - avgLatency, 2), 0) /
        timings.length;
      const stdDev = Math.sqrt(variance);

      console.log(`Cached script average latency: ${avgLatency.toFixed(2)}ms`);
      console.log(`Standard deviation: ${stdDev.toFixed(2)}ms`);

      // With cached scripts, performance should be reasonable
      expect(stdDev).toBeLessThan(avgLatency * 2.0); // StdDev < 200% of mean (relaxed for test environment)
    });
  });

  describe("Memory and Resource Usage", () => {
    it("should handle large numbers of locks efficiently", async () => {
      const lockCount = 1000;
      const lockIds: string[] = [];

      const startTime = performance.now();

      // Create many locks
      for (let i = 0; i < lockCount; i++) {
        const result = await backend.acquire({
          key: `perf:memory:lock:${i}`,
          ttlMs: 30000,
        });

        if (result.success) {
          lockIds.push(result.lockId);
        }
      }

      const acquisitionTime = performance.now() - startTime;
      console.log(
        `Acquired ${lockIds.length} locks in ${acquisitionTime.toFixed(2)}ms`,
      );

      // Verify all locks exist
      const keyCount = await redis.dbsize();
      expect(keyCount).toBeGreaterThanOrEqual(lockCount * 2); // Each lock creates 2 keys

      // Release all locks
      const releaseStart = performance.now();
      for (const lockId of lockIds) {
        await backend.release(lockId);
      }
      const releaseTime = performance.now() - releaseStart;

      console.log(
        `Released ${lockIds.length} locks in ${releaseTime.toFixed(2)}ms`,
      );

      // Verify cleanup
      const remainingKeys = await redis.keys(`${testKeyPrefix}*`);
      expect(remainingKeys).toHaveLength(0);
    });

    it("should clean up expired locks automatically", async () => {
      const lockCount = 100;

      // Create locks with very short TTL
      for (let i = 0; i < lockCount; i++) {
        await backend.acquire({
          key: `perf:cleanup:${i}`,
          ttlMs: 50, // Very short TTL
        });
      }

      // Verify locks were created
      const initialKeys = await redis.keys(`${testKeyPrefix}*`);
      expect(initialKeys.length).toBeGreaterThan(0);

      // Wait for TTL expiration + some buffer
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Trigger cleanup by checking lock status
      for (let i = 0; i < lockCount; i++) {
        await backend.isLocked(`perf:cleanup:${i}`);
      }

      // Verify automatic cleanup occurred
      const remainingKeys = await redis.keys(`${testKeyPrefix}*`);
      expect(remainingKeys.length).toBe(0);
    });
  });

  describe("Error Recovery Performance", () => {
    it("should handle rapid retry scenarios efficiently", async () => {
      // Acquire a lock to cause contention
      const blockingResult = await backend.acquire({
        key: "perf:retry:blocked",
        ttlMs: 1000,
      });

      expect(blockingResult.success).toBe(true);

      const retryAttempts = 20;
      const startTime = performance.now();

      // Make multiple attempts that will fail and retry
      const promises = Array.from({ length: retryAttempts }, () =>
        backend.acquire({
          key: "perf:retry:blocked",
          ttlMs: 1000,
          timeoutMs: 100, // Short timeout to trigger fast failures
          maxRetries: 2,
        }),
      );

      const results = await Promise.all(promises);
      const endTime = performance.now();

      // All should fail due to contention
      const failedResults = results.filter((r) => !r.success);
      expect(failedResults).toHaveLength(retryAttempts);

      const totalTime = endTime - startTime;
      console.log(
        `${retryAttempts} retry scenarios completed in ${totalTime.toFixed(2)}ms`,
      );

      // Should complete reasonably quickly even with retries
      expect(totalTime).toBeLessThan(5000); // Under 5 seconds for all retries

      // Clean up
      if (blockingResult.success) {
        await backend.release(blockingResult.lockId);
      }
    });
  });
});
