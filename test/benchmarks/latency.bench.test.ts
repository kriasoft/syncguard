// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Latency benchmarks for SyncGuard backends
 *
 * Measures:
 * - Lock acquisition/release latency
 * - Script caching performance impact
 * - Latency consistency and variance
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

describe.skipIf(!BENCHMARKS_ENABLED)("Latency Benchmarks", () => {
  let redis: Redis;
  let backend: LockBackend;
  const testKeyPrefix = "syncguard:bench:latency:";

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redis = new Redis(redisUrl);

    try {
      await redis.ping();
      console.log("✅ Connected to Redis for latency benchmarks");
    } catch (error) {
      console.error("❌ Failed to connect to Redis:", error);
      throw new Error("Latency benchmarks require Redis server");
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

  it("should measure single lock operation latency", async () => {
    const iterations = 100;
    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();

      const result = await backend.acquire({
        key: `latency:${i}`,
        ttlMs: 30000,
      });

      if (result.ok) {
        await backend.release({ lockId: result.lockId });
      }

      const end = performance.now();
      timings.push(end - start);
    }

    const avgLatency = timings.reduce((a, b) => a + b) / timings.length;
    const sortedTimings = timings.sort((a, b) => a - b);
    const p95Latency = sortedTimings[Math.floor(iterations * 0.95)]!;

    console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
    console.log(`P95 latency: ${p95Latency.toFixed(2)}ms`);
    console.log(`CI multiplier: ${CI_MULTIPLIER}x`);

    // Performance expectations (adjusted for CI)
    expect(avgLatency).toBeLessThan(50 * CI_MULTIPLIER);
    expect(p95Latency).toBeLessThan(100 * CI_MULTIPLIER);
  });

  it("should show consistent performance with cached scripts", async () => {
    const iterations = 50;
    const timings: number[] = [];

    // Warm up to ensure scripts are cached
    for (let i = 0; i < 5; i++) {
      const result = await backend.acquire({
        key: `warmup:${i}`,
        ttlMs: 1000,
      });
      if (result.ok) await backend.release({ lockId: result.lockId });
    }

    // Measure performance with cached scripts
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();

      const result = await backend.acquire({
        key: `cached:${i}`,
        ttlMs: 5000,
      });

      if (result.ok) {
        await backend.release({ lockId: result.lockId });
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
    console.log(
      `Coefficient of variation: ${((stdDev / avgLatency) * 100).toFixed(1)}%`,
    );

    // With cached scripts, performance should be consistent
    // StdDev should be less than 200% of mean (relaxed for test variance)
    expect(stdDev).toBeLessThan(avgLatency * 2.0 * CI_MULTIPLIER);
  });
});
