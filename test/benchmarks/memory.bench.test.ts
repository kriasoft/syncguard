// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Memory and resource usage benchmarks for SyncGuard backends
 *
 * Measures:
 * - Large numbers of concurrent locks
 * - Memory efficiency under load
 * - Automatic cleanup of expired locks
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

describe.skipIf(!BENCHMARKS_ENABLED)(
  "Memory and Resource Usage Benchmarks",
  () => {
    let redis: Redis;
    let backend: LockBackend;
    const testKeyPrefix = "syncguard:bench:memory:";

    beforeAll(async () => {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
      redis = new Redis(redisUrl);

      try {
        await redis.ping();
        console.log("✅ Connected to Redis for memory benchmarks");
      } catch (error) {
        console.error("❌ Failed to connect to Redis:", error);
        throw new Error("Memory benchmarks require Redis server");
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

    it("should handle large numbers of locks efficiently", async () => {
      const lockCount = 1000;
      const lockIds: string[] = [];

      const startTime = performance.now();

      // Create many locks
      for (let i = 0; i < lockCount; i++) {
        const result = await backend.acquire({
          key: `lock:${i}`,
          ttlMs: 30000,
        });

        if (result.ok) {
          lockIds.push(result.lockId);
        }
      }

      const acquisitionTime = performance.now() - startTime;
      console.log(
        `Acquired ${lockIds.length} locks in ${acquisitionTime.toFixed(2)}ms`,
      );
      console.log(
        `Average time per lock: ${(acquisitionTime / lockIds.length).toFixed(2)}ms`,
      );

      // Verify all locks exist
      const keyCount = await redis.dbsize();
      expect(keyCount).toBeGreaterThanOrEqual(lockCount * 2); // Each lock creates 2 keys

      // Release all locks
      const releaseStart = performance.now();
      const releaseResults: boolean[] = [];
      for (const lockId of lockIds) {
        const result = await backend.release({ lockId });
        releaseResults.push(result.ok);
      }
      const releaseTime = performance.now() - releaseStart;

      const successfulReleases = releaseResults.filter((ok) => ok).length;
      console.log(
        `Released ${successfulReleases}/${lockIds.length} locks in ${releaseTime.toFixed(2)}ms`,
      );
      console.log(
        `Average time per release: ${(releaseTime / lockIds.length).toFixed(2)}ms`,
      );

      // Verify cleanup (fence keys are expected to persist)
      const remainingKeys = await redis.keys(`${testKeyPrefix}*`);
      const fenceKeys = remainingKeys.filter((key) => key.includes(":fence:"));
      const lockKeys = remainingKeys.filter((key) => !key.includes(":fence:"));

      // Debug: show what keys remain
      if (lockKeys.length > 0) {
        console.log(`Remaining lock keys: ${lockKeys.length}`);
        console.log(`Failed releases: ${lockIds.length - successfulReleases}`);
        const lockIdKeys = lockKeys.filter((k) => k.includes(":id:"));
        const dataKeys = lockKeys.filter((k) => !k.includes(":id:"));
        console.log(`  - lockId keys: ${lockIdKeys.length}`);
        console.log(`  - data keys: ${dataKeys.length}`);
      }

      expect(lockKeys).toHaveLength(0); // Lock and lockId keys should be cleaned up
      // Fence keys are expected to persist for monotonicity
    }, 10000); // Increase timeout to 10 seconds

    it("should clean up expired locks automatically", async () => {
      const lockCount = 100;

      // Create locks with very short TTL
      for (let i = 0; i < lockCount; i++) {
        await backend.acquire({
          key: `cleanup:${i}`,
          ttlMs: 50, // Very short TTL
        });
      }

      // Verify locks were created
      const initialKeys = await redis.keys(`${testKeyPrefix}*`);
      expect(initialKeys.length).toBeGreaterThan(0);
      console.log(`Created ${initialKeys.length} keys`);

      // Wait for TTL expiration + some buffer
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Trigger cleanup by checking lock status
      for (let i = 0; i < lockCount; i++) {
        await backend.isLocked({ key: `cleanup:${i}` });
      }

      // Verify automatic cleanup occurred (fence keys are expected to persist)
      const remainingKeys = await redis.keys(`${testKeyPrefix}*`);
      const fenceKeys = remainingKeys.filter((key) => key.includes(":fence:"));
      const lockKeys = remainingKeys.filter((key) => !key.includes(":fence:"));

      console.log(
        `Remaining keys after cleanup: ${lockKeys.length} lock keys, ${fenceKeys.length} fence keys`,
      );

      expect(lockKeys.length).toBe(0); // Lock and lockId keys should be cleaned up
      // Fence keys are expected to persist for monotonicity
    });
  },
);
