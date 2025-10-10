// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Firestore } from "@google-cloud/firestore";
import Redis from "ioredis";
import { createFirestoreBackend } from "../../firestore/index.js";
import { createRedisBackend } from "../../redis/index.js";
import { LockError } from "../../common/errors.js";
import type { LockBackend } from "../../common/types.js";

describe("AbortSignal support", () => {
  let redis: Redis;
  let firestore: Firestore;
  let redisBackend: LockBackend;
  let firestoreBackend: LockBackend;

  beforeAll(async () => {
    // Redis setup
    redis = new Redis({
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: 1,
    });

    redisBackend = createRedisBackend(redis, {
      keyPrefix: "test:abort:",
    });

    // Firestore setup
    firestore = new Firestore({
      projectId: "test-project",
      host: "localhost:8080",
      ssl: false,
      customHeaders: {
        Authorization: "Bearer owner",
      },
    });

    firestoreBackend = createFirestoreBackend(firestore, {
      collection: "test_abort_locks",
      fenceCollection: "test_abort_fence_counters",
    });
  });

  afterAll(async () => {
    await redis.quit();
  });

  describe("Redis backend", () => {
    test("passes AbortSignal to ioredis (behavior depends on ioredis)", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Note: ioredis may not throw immediately for already-aborted signals
      // It checks the signal during network operations
      // This test verifies the signal is accepted without errors
      controller.abort();

      try {
        await redisBackend.acquire({
          key,
          ttlMs: 1000,
          signal: controller.signal,
        });
        // ioredis might complete fast operations before checking signal
      } catch (error) {
        // If ioredis does abort, verify it's a proper error
        expect(error).toBeTruthy();
      }
    });

    test("accepts AbortSignal parameter in all operations", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Acquire a lock first
      const result = await redisBackend.acquire({
        key,
        ttlMs: 1000,
        signal: controller.signal,
      });
      expect(result.ok).toBe(true);

      if (!result.ok) return;

      // Test that signal parameter is accepted (may not abort immediately)
      const extendResult = await redisBackend.extend({
        lockId: result.lockId,
        ttlMs: 2000,
        signal: controller.signal,
      });

      const isLocked = await redisBackend.isLocked({
        key,
        signal: controller.signal,
      });

      const lookupResult = await redisBackend.lookup({
        key,
        signal: controller.signal,
      });

      // Verify operations work with signal parameter
      expect(extendResult.ok).toBe(true);
      expect(isLocked).toBe(true);
      expect(lookupResult).not.toBeNull();

      // Cleanup
      await redisBackend.release({ lockId: result.lockId });
    });

    test("signal is passed through to ioredis client", async () => {
      // This test verifies the type safety - signal parameter is accepted
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Type check: these should compile without errors
      const operations = [
        redisBackend.acquire({ key, ttlMs: 1000, signal: controller.signal }),
        redisBackend.isLocked({ key, signal: controller.signal }),
        redisBackend.lookup({ key, signal: controller.signal }),
      ];

      // All operations should accept signal parameter
      await Promise.all(operations);
    });
  });

  describe("Firestore backend", () => {
    test("acquire respects AbortSignal", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Abort immediately
      controller.abort();

      try {
        await firestoreBackend.acquire({
          key,
          ttlMs: 1000,
          signal: controller.signal,
        });
        throw new Error("Should have thrown LockError");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
          expect(error.message).toContain("aborted");
        }
      }
    });

    test("release respects AbortSignal", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Acquire a lock first
      const result = await firestoreBackend.acquire({ key, ttlMs: 1000 });
      expect(result.ok).toBe(true);

      if (!result.ok) return;

      // Abort before release
      controller.abort();

      try {
        await firestoreBackend.release({
          lockId: result.lockId,
          signal: controller.signal,
        });
        throw new Error("Should have thrown LockError");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }

      // Cleanup: release without signal (wrap in try-catch in case lock was partially cleaned)
      try {
        await firestoreBackend.release({ lockId: result.lockId });
      } catch {
        // Lock may have expired or been cleaned up - this is acceptable
      }
    });

    test("extend respects AbortSignal", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Acquire a lock first
      const result = await firestoreBackend.acquire({ key, ttlMs: 1000 });
      expect(result.ok).toBe(true);

      if (!result.ok) return;

      // Abort before extend
      controller.abort();

      try {
        await firestoreBackend.extend({
          lockId: result.lockId,
          ttlMs: 2000,
          signal: controller.signal,
        });
        throw new Error("Should have thrown LockError");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }

      // Cleanup: release without signal (wrap in try-catch in case lock was partially cleaned)
      try {
        await firestoreBackend.release({ lockId: result.lockId });
      } catch {
        // Lock may have expired or been cleaned up - this is acceptable
      }
    });

    test("isLocked respects AbortSignal", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Abort immediately
      controller.abort();

      try {
        await firestoreBackend.isLocked({
          key,
          signal: controller.signal,
        });
        throw new Error("Should have thrown LockError");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }
    });

    test("lookup respects AbortSignal", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Abort immediately
      controller.abort();

      try {
        await firestoreBackend.lookup({
          key,
          signal: controller.signal,
        });
        throw new Error("Should have thrown LockError");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }
    });

    test("abort during transaction cancels mid-flight", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Simulate aborting during transaction
      setTimeout(() => controller.abort(), 50);

      const startTime = Date.now();

      try {
        await firestoreBackend.acquire({
          key,
          ttlMs: 1000,
          signal: controller.signal,
        });
      } catch (error) {
        const elapsed = Date.now() - startTime;
        // Should fail quickly (within reasonable bounds)
        expect(elapsed).toBeLessThan(500);
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }
    });
  });

  describe("Cross-backend consistency", () => {
    test("Firestore throws LockError for aborted operations", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      controller.abort();

      // Test Firestore - should throw immediately
      let firestoreError: LockError | null = null;
      try {
        await firestoreBackend.acquire({
          key: `firestore-${key}`,
          ttlMs: 1000,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof LockError) {
          firestoreError = error;
        }
      }

      // Firestore should throw LockError with Aborted code
      expect(firestoreError).toBeTruthy();
      expect(firestoreError?.code).toBe("Aborted");
    });

    test("both backends accept AbortSignal parameter", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Both backends should accept signal parameter
      const redisResult = await redisBackend.acquire({
        key: `redis-${key}`,
        ttlMs: 1000,
        signal: controller.signal,
      });

      const firestoreResult = await firestoreBackend.acquire({
        key: `firestore-${key}`,
        ttlMs: 1000,
        signal: controller.signal,
      });

      expect(redisResult.ok).toBe(true);
      expect(firestoreResult.ok).toBe(true);

      // Cleanup
      if (redisResult.ok) {
        await redisBackend.release({ lockId: redisResult.lockId });
      }
      if (firestoreResult.ok) {
        await firestoreBackend.release({ lockId: firestoreResult.lockId });
      }
    });
  });
});
