// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { Firestore } from "@google-cloud/firestore";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { LockError } from "../../common/errors.js";
import type { LockBackend } from "../../common/types.js";
import { createFirestoreBackend } from "../../firestore/index.js";
import { createRedisBackend } from "../../redis/index.js";

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
    test("respects pre-dispatch AbortSignal (already aborted)", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Abort before calling
      controller.abort();

      try {
        await redisBackend.acquire({
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

    test("pre-dispatch abort check in all operations", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Acquire a lock first (without signal)
      const result = await redisBackend.acquire({
        key,
        ttlMs: 1000,
      });
      expect(result.ok).toBe(true);

      if (!result.ok) return;

      // Abort the controller
      controller.abort();

      // Test that all operations throw when signal is already aborted
      try {
        await redisBackend.extend({
          lockId: result.lockId,
          ttlMs: 2000,
          signal: controller.signal,
        });
        throw new Error("extend should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }

      try {
        await redisBackend.isLocked({
          key,
          signal: controller.signal,
        });
        throw new Error("isLocked should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }

      try {
        await redisBackend.lookup({
          key,
          signal: controller.signal,
        });
        throw new Error("lookup should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }

      try {
        await redisBackend.release({
          lockId: result.lockId,
          signal: controller.signal,
        });
        throw new Error("release should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        if (error instanceof LockError) {
          expect(error.code).toBe("Aborted");
        }
      }

      // Cleanup without signal
      await redisBackend.release({ lockId: result.lockId });
    });

    test("operations succeed when signal is not aborted", async () => {
      // This test verifies that passing a non-aborted signal doesn't break operations
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Type check: these should compile without errors
      const result = await redisBackend.acquire({
        key,
        ttlMs: 1000,
        signal: controller.signal,
      });
      expect(result.ok).toBe(true);

      if (!result.ok) return;

      const isLocked = await redisBackend.isLocked({
        key,
        signal: controller.signal,
      });
      expect(isLocked).toBe(true);

      const lookupResult = await redisBackend.lookup({
        key,
        signal: controller.signal,
      });
      expect(lookupResult).not.toBeNull();

      // Cleanup
      await redisBackend.release({ lockId: result.lockId });
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

    // Note: Firestore emulator can be slow to release locks (up to 30s per docs)
    // Use extended timeout to accommodate emulator's lock release behavior
    // Increased timeout for CI/CD environments where emulator can be particularly slow
    test(
      "release respects AbortSignal",
      async () => {
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
      },
      { timeout: 20000 },
    );

    // Note: Firestore emulator can be slow to release locks (up to 30s per docs)
    // Use extended timeout to accommodate emulator's lock release behavior
    test(
      "extend respects AbortSignal",
      async () => {
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
      },
      { timeout: 20000 },
    );

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
    test("both backends throw LockError('Aborted') for pre-aborted operations", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      controller.abort();

      // Test Redis - should throw on pre-dispatch check
      let redisError: LockError | null = null;
      try {
        await redisBackend.acquire({
          key: `redis-${key}`,
          ttlMs: 1000,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof LockError) {
          redisError = error;
        }
      }

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

      // Both should throw LockError with Aborted code
      expect(redisError).toBeTruthy();
      expect(redisError?.code).toBe("Aborted");
      expect(firestoreError).toBeTruthy();
      expect(firestoreError?.code).toBe("Aborted");
    });

    test("both backends accept AbortSignal parameter when not aborted", async () => {
      const controller = new AbortController();
      const key = `abort-test-${Date.now()}`;

      // Both backends should accept signal parameter and succeed when not aborted
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
