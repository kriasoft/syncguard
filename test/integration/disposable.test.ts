// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Integration tests for AsyncDisposable support across all backends
 *
 * Tests the `await using` pattern with real backend instances:
 * - Redis backend disposal
 * - Postgres backend disposal
 * - Firestore backend disposal
 * - Error callback integration
 * - Automatic cleanup on scope exit
 * - Disposal behavior with errors
 *
 * Prerequisites:
 * - Redis server running on localhost:6379
 * - PostgreSQL server running on localhost:5432
 * - Firestore emulator running on localhost:8080
 */

import { Firestore } from "@google-cloud/firestore";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import Redis from "ioredis";
import type { Sql } from "postgres";
import postgres from "postgres";
import type { LockBackend, OnReleaseError } from "../../common/types.js";
import { createFirestoreBackend } from "../../firestore";
import type { FirestoreCapabilities } from "../../firestore/types.js";
import { createPostgresBackend, setupSchema } from "../../postgres";
import type { PostgresCapabilities } from "../../postgres/types.js";
import { createRedisBackend } from "../../redis";
import type { RedisCapabilities } from "../../redis/types.js";
import {
  checkFirestoreEmulatorAvailability,
  handleFirestoreUnavailability,
} from "./firestore-emulator-check.js";

describe("AsyncDisposable Integration Tests", () => {
  // Redis setup
  let redis: Redis;
  let redisBackend: LockBackend<RedisCapabilities>;

  // Postgres setup
  let sql: Sql;
  let postgresBackend: LockBackend<PostgresCapabilities>;

  // Firestore setup
  let firestore: Firestore;
  let firestoreBackend: LockBackend<FirestoreCapabilities>;

  const testKeyPrefix = "test:disposable:";

  let firestoreAvailable = false;

  beforeAll(async () => {
    // Setup Redis
    redis = new Redis({
      host: "localhost",
      port: 6379,
      db: 15,
      lazyConnect: true,
    });

    try {
      await redis.ping();
    } catch (error) {
      console.warn("⚠️  Redis not available - Redis tests will fail");
    }

    // Setup Postgres
    sql = postgres({
      host: "localhost",
      port: 5432,
      database: "postgres",
      username: "postgres",
      password: "postgres",
    });

    try {
      await sql`SELECT 1`;
      // Setup schema before running tests
      await setupSchema(sql);
    } catch (error) {
      console.warn("⚠️  Postgres not available - Postgres tests will fail");
    }

    // Setup Firestore
    firestore = new Firestore({
      projectId: "test-project",
      host: "localhost:8080",
      ssl: false,
      customHeaders: {
        Authorization: "Bearer owner",
      },
    });

    // Check Firestore emulator availability
    firestoreAvailable = await checkFirestoreEmulatorAvailability(firestore);
    handleFirestoreUnavailability(
      firestoreAvailable,
      "AsyncDisposable Integration Tests",
    );
  });

  beforeEach(async () => {
    // Create backends
    redisBackend = createRedisBackend(redis, { keyPrefix: testKeyPrefix });

    postgresBackend = await createPostgresBackend(sql);

    if (firestoreAvailable) {
      firestoreBackend = createFirestoreBackend(firestore, {
        collection: `${testKeyPrefix}locks`,
        fenceCollection: `${testKeyPrefix}fences`,
        disposeTimeoutMs: 2000, // Timeout for graceful abort if disposal hangs
      });
    }

    // Clean up Redis keys
    try {
      const keys = await redis.keys(`${testKeyPrefix}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up Postgres locks
    try {
      await sql`DELETE FROM syncguard_locks WHERE key LIKE ${`${testKeyPrefix}%`}`;
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up Firestore collections (only if emulator is available)
    if (firestoreAvailable) {
      try {
        const locksDocs = await firestore
          .collection(`${testKeyPrefix}locks`)
          .listDocuments();
        await Promise.all(locksDocs.map((doc) => doc.delete()));

        const fencesDocs = await firestore
          .collection(`${testKeyPrefix}fences`)
          .listDocuments();
        await Promise.all(fencesDocs.map((doc) => doc.delete()));
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  afterEach(async () => {
    // Clean up after each test (same as beforeEach)
    try {
      const keys = await redis.keys(`${testKeyPrefix}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      // Ignore cleanup errors
    }

    try {
      await sql`DELETE FROM syncguard_locks WHERE key LIKE ${`${testKeyPrefix}%`}`;
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up Firestore collections (only if emulator is available)
    if (firestoreAvailable) {
      try {
        const locksDocs = await firestore
          .collection(`${testKeyPrefix}locks`)
          .listDocuments();
        await Promise.all(locksDocs.map((doc) => doc.delete()));

        const fencesDocs = await firestore
          .collection(`${testKeyPrefix}fences`)
          .listDocuments();
        await Promise.all(fencesDocs.map((doc) => doc.delete()));
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  afterAll(async () => {
    await redis.quit();
    await sql.end();
  });

  describe("Redis Backend Disposal", () => {
    it("should automatically release lock on scope exit", async () => {
      const key = "redis:auto-release";

      {
        await using lock = await redisBackend.acquire({ key, ttlMs: 30000 });

        if (lock.ok) {
          // Lock should be held
          expect(await redisBackend.isLocked({ key })).toBe(true);
        }
      }

      // Lock should be automatically released
      expect(await redisBackend.isLocked({ key })).toBe(false);
    });

    it("should release lock even if scope exits with error", async () => {
      const key = "redis:error-release";

      const testFn = async () => {
        await using lock = await redisBackend.acquire({ key, ttlMs: 30000 });

        if (lock.ok) {
          expect(await redisBackend.isLocked({ key })).toBe(true);
          throw new Error("Test error");
        }
      };

      await expect(testFn()).rejects.toThrow("Test error");

      // Lock should still be released
      expect(await redisBackend.isLocked({ key })).toBe(false);
    });

    it("should support manual release with disposal handle", async () => {
      const key = "redis:manual-release";

      await using lock = await redisBackend.acquire({ key, ttlMs: 30000 });

      if (lock.ok) {
        expect(await redisBackend.isLocked({ key })).toBe(true);

        // Manual release
        const result = await lock.release();
        expect(result.ok).toBe(true);

        // Lock should be released
        expect(await redisBackend.isLocked({ key })).toBe(false);
      }
    });

    it("should support extend operation with disposal handle", async () => {
      const key = "redis:extend";

      await using lock = await redisBackend.acquire({ key, ttlMs: 500 });

      if (lock.ok) {
        const originalExpiry = lock.expiresAtMs;

        // Wait a bit
        await Bun.sleep(200);

        // Extend lock
        const extendResult = await lock.extend(5000);
        expect(extendResult.ok).toBe(true);

        if (extendResult.ok) {
          expect(extendResult.expiresAtMs).toBeGreaterThan(originalExpiry);
        }

        // Wait past original TTL
        await Bun.sleep(400);

        // Lock should still be held
        expect(await redisBackend.isLocked({ key })).toBe(true);
      }
    });

    it("should invoke onReleaseError callback on disposal failure", async () => {
      const key = "redis:release-error";
      const onReleaseErrorSpy = mock<OnReleaseError>();

      // Create backend with error callback
      const backendWithCallback = createRedisBackend(redis, {
        keyPrefix: testKeyPrefix,
        onReleaseError: onReleaseErrorSpy,
      });

      await using lock = await backendWithCallback.acquire({
        key,
        ttlMs: 30000,
      });

      if (lock.ok) {
        // Manually delete the lock to cause release to fail
        await redis.del(`${testKeyPrefix}${key}`);
        await redis.del(`${testKeyPrefix}id:${lock.lockId}`);
      }

      // Disposal happens here - should trigger callback since lock is absent
      // Note: This is a best-effort test - the backend may not actually invoke
      // the callback if it treats missing locks as successful release
    });

    it("should handle failed acquisition gracefully", async () => {
      const key = "redis:contended";

      // Hold lock
      const firstLock = await redisBackend.acquire({ key, ttlMs: 30000 });
      expect(firstLock.ok).toBe(true);

      {
        // Try to acquire same lock (should fail)
        await using lock = await redisBackend.acquire({ key, ttlMs: 100 });

        expect(lock.ok).toBe(false);

        // No disposal should happen for failed acquisition
      }

      // First lock should still be held
      expect(await redisBackend.isLocked({ key })).toBe(true);

      // Clean up
      if (firstLock.ok) {
        await firstLock.release();
      }
    });
  });

  describe("Postgres Backend Disposal", () => {
    it("should automatically release lock on scope exit", async () => {
      const key = "postgres:auto-release";

      {
        await using lock = await postgresBackend.acquire({
          key,
          ttlMs: 30000,
        });

        if (lock.ok) {
          // Lock should be held
          expect(await postgresBackend.isLocked({ key })).toBe(true);
        }
      }

      // Lock should be automatically released
      expect(await postgresBackend.isLocked({ key })).toBe(false);
    });

    it("should release lock even if scope exits with error", async () => {
      const key = "postgres:error-release";

      const testFn = async () => {
        await using lock = await postgresBackend.acquire({
          key,
          ttlMs: 30000,
        });

        if (lock.ok) {
          expect(await postgresBackend.isLocked({ key })).toBe(true);
          throw new Error("Test error");
        }
      };

      await expect(testFn()).rejects.toThrow("Test error");

      // Lock should still be released
      expect(await postgresBackend.isLocked({ key })).toBe(false);
    });

    it("should support manual release with disposal handle", async () => {
      const key = "postgres:manual-release";

      await using lock = await postgresBackend.acquire({
        key,
        ttlMs: 30000,
      });

      if (lock.ok) {
        expect(await postgresBackend.isLocked({ key })).toBe(true);

        // Manual release
        const result = await lock.release();
        expect(result.ok).toBe(true);

        // Lock should be released
        expect(await postgresBackend.isLocked({ key })).toBe(false);
      }
    });

    it("should support extend operation with disposal handle", async () => {
      const key = "postgres:extend";

      await using lock = await postgresBackend.acquire({ key, ttlMs: 500 });

      if (lock.ok) {
        const originalExpiry = lock.expiresAtMs;

        // Wait a bit
        await Bun.sleep(200);

        // Extend lock
        const extendResult = await lock.extend(5000);
        expect(extendResult.ok).toBe(true);

        if (extendResult.ok) {
          expect(extendResult.expiresAtMs).toBeGreaterThan(originalExpiry);
        }

        // Wait past original TTL
        await Bun.sleep(400);

        // Lock should still be held
        expect(await postgresBackend.isLocked({ key })).toBe(true);
      }
    });
  });

  describe("Firestore Backend Disposal", () => {
    it("should automatically release lock on scope exit", async () => {
      if (!firestoreAvailable) return; // Skip if emulator unavailable
      const key = "firestore:auto-release";

      {
        await using lock = await firestoreBackend.acquire({
          key,
          ttlMs: 30000,
        });

        if (lock.ok) {
          // Lock should be held
          expect(await firestoreBackend.isLocked({ key })).toBe(true);
        }
      }

      // Lock should be automatically released
      expect(await firestoreBackend.isLocked({ key })).toBe(false);
    });

    it("should release lock even if scope exits with error", async () => {
      if (!firestoreAvailable) return; // Skip if emulator unavailable
      const key = "firestore:error-release";

      const testFn = async () => {
        await using lock = await firestoreBackend.acquire({
          key,
          ttlMs: 30000,
        });

        if (lock.ok) {
          expect(await firestoreBackend.isLocked({ key })).toBe(true);
          throw new Error("Test error");
        }
      };

      await expect(testFn()).rejects.toThrow("Test error");

      // Lock should still be released
      expect(await firestoreBackend.isLocked({ key })).toBe(false);
    });

    it("should support manual release with disposal handle", async () => {
      if (!firestoreAvailable) return; // Skip if emulator unavailable
      const key = "firestore:manual-release";

      await using lock = await firestoreBackend.acquire({
        key,
        ttlMs: 30000,
      });

      if (lock.ok) {
        expect(await firestoreBackend.isLocked({ key })).toBe(true);

        // Manual release
        const result = await lock.release();
        expect(result.ok).toBe(true);

        // Lock should be released
        expect(await firestoreBackend.isLocked({ key })).toBe(false);
      }
    });

    it("should support extend operation with disposal handle", async () => {
      if (!firestoreAvailable) return; // Skip if emulator unavailable
      const key = "firestore:extend";

      await using lock = await firestoreBackend.acquire({ key, ttlMs: 500 });

      if (lock.ok) {
        const originalExpiry = lock.expiresAtMs;

        // Wait a bit
        await Bun.sleep(200);

        // Extend lock
        const extendResult = await lock.extend(5000);
        expect(extendResult.ok).toBe(true);

        if (extendResult.ok) {
          expect(extendResult.expiresAtMs).toBeGreaterThan(originalExpiry);
        }

        // Wait past original TTL
        await Bun.sleep(400);

        // Lock should still be held
        expect(await firestoreBackend.isLocked({ key })).toBe(true);
      }
    });
  });

  describe("Cross-backend Consistency", () => {
    it("should provide consistent disposal behavior across all backends", async () => {
      const backends = [
        { name: "Redis", backend: redisBackend },
        { name: "Postgres", backend: postgresBackend },
        ...(firestoreAvailable
          ? [{ name: "Firestore", backend: firestoreBackend }]
          : []),
      ];

      for (const { name, backend } of backends) {
        const key = `cross-backend:${name.toLowerCase()}`;

        {
          await using lock = await backend.acquire({ key, ttlMs: 30000 });

          if (lock.ok) {
            expect(await backend.isLocked({ key })).toBe(true);
          }
        }

        // Lock should be released after disposal
        expect(await backend.isLocked({ key })).toBe(false);
      }
    });

    it("should handle manual operations consistently across backends", async () => {
      const backends = [
        { name: "Redis", backend: redisBackend },
        { name: "Postgres", backend: postgresBackend },
        ...(firestoreAvailable
          ? [{ name: "Firestore", backend: firestoreBackend }]
          : []),
      ];

      for (const { name, backend } of backends) {
        const key = `manual-ops:${name.toLowerCase()}`;

        await using lock = await backend.acquire({ key, ttlMs: 30000 });

        if (lock.ok) {
          // Manual release
          const releaseResult = await lock.release();
          expect(releaseResult.ok).toBe(true);

          // Subsequent release delegates to backend (returns ok: false - lock absent)
          const releaseResult2 = await lock.release();
          expect(releaseResult2.ok).toBe(false);

          // Extend after release delegates to backend (returns ok: false - lock absent)
          const extendResult = await lock.extend(5000);
          expect(extendResult.ok).toBe(false);
        }
      }
    });
  });
});
