// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Throughput benchmarks for SyncGuard backends
 *
 * Measures:
 * - Concurrent load handling
 * - Operations per second under contention
 * - Error recovery performance
 *
 * Requires backend services (Redis, PostgreSQL, Firestore)
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

// Opt-in guard: benchmarks only run when explicitly enabled
const BENCHMARKS_ENABLED =
  process.env.RUN_BENCHMARKS === "1" || process.env.RUN_BENCHMARKS === "true";

// CI environments have higher variance - apply 2x multiplier to thresholds
const CI_MULTIPLIER = process.env.CI ? 2 : 1;

describe.skipIf(!BENCHMARKS_ENABLED)("Throughput Benchmarks", () => {
  let redis: Redis;
  let backend: LockBackend;
  const testKeyPrefix = "syncguard:bench:throughput:";

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redis = new Redis(redisUrl);

    try {
      await redis.ping();
      console.log("✅ Connected to Redis for throughput benchmarks");
    } catch (error) {
      console.error("❌ Failed to connect to Redis:", error);
      throw new Error("Throughput benchmarks require Redis server");
    }

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
    // Clean up test keys
    const keys = await redis.keys(`${testKeyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  it("should measure concurrent throughput", async () => {
    const concurrency = 10;
    const operationsPerWorker = 50;
    const totalOperations = concurrency * operationsPerWorker;

    const startTime = performance.now();

    // Launch concurrent workers
    const workers = Array.from({ length: concurrency }, async (_, workerId) => {
      for (let i = 0; i < operationsPerWorker; i++) {
        const result = await backend.acquire({
          key: `worker${workerId}:op${i}`,
          ttlMs: 5000,
        });

        if (result.ok) {
          await backend.release({ lockId: result.lockId });
        }
      }
    });

    await Promise.all(workers);

    const endTime = performance.now();
    const totalTime = endTime - startTime;
    const opsPerSecond = (totalOperations * 1000) / totalTime;

    console.log(`Total operations: ${totalOperations}`);
    console.log(`Total time: ${totalTime.toFixed(2)}ms`);
    console.log(`Throughput: ${opsPerSecond.toFixed(2)} ops/sec`);
    console.log(`CI multiplier: ${CI_MULTIPLIER}x`);

    // Should handle reasonable throughput (adjusted for CI)
    const minThroughput = 100 / CI_MULTIPLIER;
    expect(opsPerSecond).toBeGreaterThan(minThroughput);
  });

  it("should handle rapid retry scenarios efficiently", async () => {
    // Acquire a lock to cause contention
    const blockingResult = await backend.acquire({
      key: "retry:blocked",
      ttlMs: 1000,
    });

    expect(blockingResult.ok).toBe(true);

    const retryAttempts = 20;
    const startTime = performance.now();

    // Make multiple attempts that will fail due to contention
    const promises = Array.from({ length: retryAttempts }, () =>
      backend.acquire({
        key: "retry:blocked",
        ttlMs: 1000,
      }),
    );

    const results = await Promise.all(promises);
    const endTime = performance.now();

    // All should fail due to contention
    const failedResults = results.filter((r) => !r.ok);
    expect(failedResults).toHaveLength(retryAttempts);

    const totalTime = endTime - startTime;
    console.log(
      `${retryAttempts} retry scenarios completed in ${totalTime.toFixed(2)}ms`,
    );
    console.log(
      `Average time per failed attempt: ${(totalTime / retryAttempts).toFixed(2)}ms`,
    );

    // Should complete reasonably quickly even with retries (adjusted for CI)
    expect(totalTime).toBeLessThan(5000 * CI_MULTIPLIER);

    // Clean up
    if (blockingResult.ok) {
      await backend.release({ lockId: blockingResult.lockId });
    }
  });
});
