// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Fence Overflow Enforcement Tests
 *
 * Verifies ADR-004 overflow enforcement requirements:
 * - Backends MUST throw LockError("Internal") when fence > 9e14
 * - Backends SHOULD warn when fence > 9e13
 *
 * Prerequisites:
 * - Redis server running on localhost:6379
 * - Firestore emulator running on localhost:8080
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Firestore } from "@google-cloud/firestore";
import Redis from "ioredis";
import { LockError } from "../../common/errors.js";
import { createRedisBackend } from "../../redis";
import { createFirestoreBackend } from "../../firestore";

describe("Fence Overflow Enforcement (ADR-004)", () => {
  describe("Redis Backend", () => {
    let redis: Redis;
    const testKeyPrefix = "test:overflow:redis:";

    beforeAll(async () => {
      redis = new Redis({
        host: "localhost",
        port: 6379,
        db: 15,
        lazyConnect: true,
      });

      try {
        await redis.ping();
      } catch (error) {
        console.warn(
          "⚠️  Redis not available - overflow tests will be skipped",
        );
      }
    });

    afterAll(async () => {
      // Clean up test keys
      const keys = await redis.keys(`${testKeyPrefix}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      await redis.quit();
    });

    it("should throw LockError('Internal') when fence exceeds 9e14", async () => {
      const backend = createRedisBackend(redis, { keyPrefix: testKeyPrefix });
      const key = "overflow:test:exceed-limit";
      const overflowLimit = 900000000000000; // 9e14 (as number for Redis INCR)

      // Manually set fence counter to the limit
      // Fence key follows: makeStorageKey(keyPrefix, `fence:${baseKey}`, 1000)
      const fenceKey = `${testKeyPrefix}fence:${testKeyPrefix}${key}`;
      const lockKey = `${testKeyPrefix}${key}`;

      // Clean up any existing state first
      await redis.del(fenceKey, lockKey);

      await redis.set(fenceKey, overflowLimit);

      // Next acquire should throw due to overflow (fence will be 9e14 + 1)
      // Verify the error code is "Internal"
      try {
        await backend.acquire({ key, ttlMs: 30000 });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof LockError).toBe(true);
        if (error instanceof LockError) {
          expect(error.code).toBe("Internal");
          expect(error.message).toMatch(/Fence counter overflow/);
        }
      }

      // Clean up
      await redis.del(fenceKey, lockKey);
    });

    it("should log warning when fence exceeds 9e13 but allow operation", async () => {
      const backend = createRedisBackend(redis, { keyPrefix: testKeyPrefix });
      const key = "overflow:test:warning-threshold";
      const warningThreshold = 90000000000000; // 9e13 (as number for Redis INCR)

      // Clean up any existing state first
      const fenceKey = `${testKeyPrefix}fence:${testKeyPrefix}${key}`;
      const lockKey = `${testKeyPrefix}${key}`;
      await redis.del(fenceKey, lockKey);

      // Manually set fence counter to just above warning threshold
      await redis.set(fenceKey, warningThreshold);

      // Capture console.warn output
      const originalWarn = console.warn;
      let warnCalled = false;
      let warnMessage = "";
      console.warn = (...args: any[]) => {
        warnCalled = true;
        warnMessage = args.join(" ");
      };

      try {
        // Next acquire should warn but succeed
        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        // Verify warning was logged
        expect(warnCalled).toBe(true);
        expect(warnMessage).toMatch(/Fence counter approaching limit/);

        if (result.ok) {
          await backend.release({ lockId: result.lockId });
        }
      } finally {
        console.warn = originalWarn;
        await redis.del(fenceKey, lockKey);
      }
    });

    it("should handle fence values near limit correctly", async () => {
      const backend = createRedisBackend(redis, { keyPrefix: testKeyPrefix });
      const key = "overflow:test:near-limit";

      // Clean up any existing state first
      const fenceKey = `${testKeyPrefix}fence:${testKeyPrefix}${key}`;
      const lockKey = `${testKeyPrefix}${key}`;
      await redis.del(fenceKey, lockKey);

      // Set fence to a value just under warning threshold
      await redis.set(fenceKey, 89999999999999); // Just under 9e13 (as number for Redis INCR)

      // Should succeed without warnings
      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.fence).toBe("090000000000000");
        await backend.release({ lockId: result.lockId });
      }

      // Clean up
      await redis.del(fenceKey, lockKey);
    });
  });

  describe("Firestore Backend", () => {
    let db: Firestore;
    const testCollection = "test_overflow_locks";
    const testFenceCollection = "test_overflow_fences";

    beforeAll(() => {
      db = new Firestore({
        projectId: "test-project",
        host: "localhost:8080",
        ssl: false,
        customHeaders: {
          Authorization: "Bearer owner",
        },
      });
    });

    afterAll(async () => {
      // Clean up test documents
      const lockSnapshot = await db.collection(testCollection).get();
      const fenceSnapshot = await db.collection(testFenceCollection).get();

      const batch = db.batch();
      lockSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
      fenceSnapshot.docs.forEach((doc) => batch.delete(doc.ref));

      await batch.commit();
    });

    it("should throw LockError('Internal') when fence exceeds 9e14", async () => {
      const backend = createFirestoreBackend(db, {
        collection: testCollection,
        fenceCollection: testFenceCollection,
      });
      const key = "overflow:firestore:exceed-limit";
      const overflowLimit = "900000000000000"; // 9e14

      // Manually set fence counter to the limit (ADR-006: two-step pattern)
      const fenceDocId = `fence:${key}`; // Two-step pattern
      const fenceDoc = db.collection(testFenceCollection).doc(fenceDocId);
      await fenceDoc.set({ fence: overflowLimit, keyDebug: key });

      // Next acquire should throw due to overflow (fence will be 9e14 + 1)
      // Verify the error code is "Internal" and error message
      try {
        await backend.acquire({ key, ttlMs: 30000 });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof LockError).toBe(true);
        if (error instanceof LockError) {
          expect(error.code).toBe("Internal");
          expect(error.message).toMatch(
            /Fence counter overflow.*exceeded operational limit/,
          );
        }
      }

      // Clean up
      await fenceDoc.delete();
    });

    it("should log warning when fence exceeds 9e13 but allow operation", async () => {
      const backend = createFirestoreBackend(db, {
        collection: testCollection,
        fenceCollection: testFenceCollection,
      });
      const key = "overflow:firestore:warning-threshold";
      const warningThreshold = "090000000000000"; // 9e13 (15-digit format)

      // Manually set fence counter to just above warning threshold (ADR-006: two-step pattern)
      const fenceDocId = `fence:${key}`; // Two-step pattern
      const fenceDoc = db.collection(testFenceCollection).doc(fenceDocId);
      await fenceDoc.set({ fence: warningThreshold, keyDebug: key });

      // Capture console.warn output
      const originalWarn = console.warn;
      let warnCalled = false;
      let warnMessage = "";
      console.warn = (...args: any[]) => {
        warnCalled = true;
        warnMessage = args.join(" ");
      };

      try {
        // Next acquire should warn but succeed
        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        // Verify warning was logged
        expect(warnCalled).toBe(true);
        expect(warnMessage).toMatch(/Fence counter approaching limit/);

        if (result.ok) {
          await backend.release({ lockId: result.lockId });
        }
      } finally {
        console.warn = originalWarn;
        await fenceDoc.delete();
        await db.collection(testCollection).doc(key).delete();
      }
    });

    it("should handle fence values near limit correctly", async () => {
      const backend = createFirestoreBackend(db, {
        collection: testCollection,
        fenceCollection: testFenceCollection,
      });
      const key = "overflow:firestore:near-limit";

      // Set fence to a value just under warning threshold (ADR-006: two-step pattern)
      const fenceDocId = `fence:${key}`; // Two-step pattern
      const fenceDoc = db.collection(testFenceCollection).doc(fenceDocId);
      await fenceDoc.set({
        fence: "089999999999999", // Just under 9e13
        keyDebug: key,
      });

      // Should succeed without warnings
      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.fence).toBe("090000000000000");
        await backend.release({ lockId: result.lockId });
      }

      // Clean up
      await fenceDoc.delete();
      await db.collection(testCollection).doc(key).delete();
    });
  });
});
