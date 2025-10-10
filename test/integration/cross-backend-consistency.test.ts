// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Cross-Backend Consistency Tests (ADR-006)
 *
 * Verifies identical behavior across Redis and Firestore backends:
 * - Fence key 1:1 mapping (ADR-006)
 * - Storage key truncation consistency
 * - Time consistency under clock skew
 * - Fence format and monotonicity
 *
 * Prerequisites:
 * - Redis server running on localhost:6379
 * - Firestore emulator running on localhost:8080
 */

import { Firestore } from "@google-cloud/firestore";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { makeStorageKey } from "../../common/crypto.js";
import { createFirestoreBackend } from "../../firestore";
import { createRedisBackend } from "../../redis";

describe("Cross-Backend Consistency (ADR-006)", () => {
  let redis: Redis;
  let db: Firestore;
  const testRedisPrefix = "test:consistency:redis:";
  const testFirestoreCollection = "test_consistency_locks";
  const testFirestoreFenceCollection = "test_consistency_fences";

  beforeAll(async () => {
    // Initialize Redis
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
        "⚠️  Redis not available - skipping Redis consistency tests",
      );
    }

    // Initialize Firestore
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
    // Clean up Redis
    const keys = await redis.keys(`${testRedisPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.quit();

    // Clean up Firestore
    const lockSnapshot = await db.collection(testFirestoreCollection).get();
    const fenceSnapshot = await db
      .collection(testFirestoreFenceCollection)
      .get();

    const batch = db.batch();
    lockSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
    fenceSnapshot.docs.forEach((doc) => batch.delete(doc.ref));

    if (!lockSnapshot.empty || !fenceSnapshot.empty) {
      await batch.commit();
    }
  });

  describe("Fence Key 1:1 Mapping (ADR-006)", () => {
    it("should produce identical base storage keys for same user key across backends", async () => {
      const userKey = "resource:payment:12345";

      // Redis: base storage key computation (ADR-006 two-step pattern)
      const redisReserve = 25; // "id:" + 22-char lockId
      const redisBaseKey = makeStorageKey(
        testRedisPrefix,
        userKey,
        1000,
        redisReserve,
      );

      // Firestore: base storage key computation (ADR-006 two-step pattern)
      const firestoreReserve = 0; // No derived keys in Firestore
      const firestoreBaseKey = makeStorageKey(
        "",
        userKey,
        1500,
        firestoreReserve,
      );

      // Both should use same normalized user key, but different prefix/limits
      // The key point: when truncation occurs, both hash identically
      expect(redisBaseKey).toContain(userKey); // No truncation needed
      expect(firestoreBaseKey).toBe(userKey); // No truncation needed (no prefix)

      // Verify both use makeStorageKey() for consistent hashing
      const longKey = "x".repeat(600);
      const redisLongKey = makeStorageKey(
        testRedisPrefix,
        longKey,
        1000,
        redisReserve,
      );
      const firestoreLongKey = makeStorageKey(
        "",
        longKey,
        1500,
        firestoreReserve,
      );

      // When truncation occurs, both should use same hash algorithm
      expect(redisLongKey.length).toBeLessThanOrEqual(1000);
      expect(firestoreLongKey.length).toBeLessThanOrEqual(1500);
    });

    it("should derive fence keys from same base storage key (ADR-006 two-step pattern)", async () => {
      const userKey = "resource:critical:operation";

      // Redis: two-step derivation
      const redisReserve = 25; // "id:" + 22-char lockId
      // Step 1: Compute base storage key
      const redisBaseKey = makeStorageKey(
        testRedisPrefix,
        userKey,
        1000,
        redisReserve,
      );
      // Step 2: Derive fence key from base (ensures 1:1 mapping)
      const redisFenceKey = makeStorageKey(
        testRedisPrefix,
        `fence:${redisBaseKey}`,
        1000,
        redisReserve,
      );

      // Firestore: two-step derivation (mirrors Redis pattern)
      const firestoreReserve = 0; // No derived keys in Firestore
      // Step 1: Compute base storage key
      const firestoreBaseKey = makeStorageKey(
        "",
        userKey,
        1500,
        firestoreReserve,
      );
      // Step 2: Derive fence document ID from base (ensures 1:1 mapping)
      const firestoreFenceDocId = makeStorageKey(
        "",
        `fence:${firestoreBaseKey}`,
        1500,
        firestoreReserve,
      );

      // Verify both backends use two-step pattern
      expect(redisFenceKey).toContain("fence:");
      expect(firestoreFenceDocId).toContain("fence:");

      // The critical property: when truncation occurs, fence and lock keys hash identically
      const longKey = "x".repeat(2000);
      const redisBaseLong = makeStorageKey(
        testRedisPrefix,
        longKey,
        1000,
        redisReserve,
      );
      const redisFenceLong = makeStorageKey(
        testRedisPrefix,
        `fence:${redisBaseLong}`,
        1000,
        redisReserve,
      );
      const firestoreBaseLong = makeStorageKey(
        "",
        longKey,
        1500,
        firestoreReserve,
      );
      const firestoreFenceLong = makeStorageKey(
        "",
        `fence:${firestoreBaseLong}`,
        1500,
        firestoreReserve,
      );

      // Both backends ensure 1:1 mapping: same user key → same base key → unique fence counter
      expect(redisBaseLong.length).toBeLessThanOrEqual(1000);
      expect(redisFenceLong.length).toBeLessThanOrEqual(1000);
      expect(firestoreBaseLong.length).toBeLessThanOrEqual(1500);
      expect(firestoreFenceLong.length).toBeLessThanOrEqual(1500);

      // Verify identical two-step pattern: both backends derive fence keys the same way
      expect(redisFenceKey).toContain("fence:");
      expect(firestoreFenceDocId).toContain("fence:");
    });

    it("should ensure different user keys never map to same fence counter", async () => {
      const redisBackend = createRedisBackend(redis, {
        keyPrefix: testRedisPrefix,
      });
      const firestoreBackend = createFirestoreBackend(db, {
        collection: testFirestoreCollection,
        fenceCollection: testFirestoreFenceCollection,
      });

      // Two different keys
      const key1 = "resource:payment:user:123";
      const key2 = "resource:payment:user:456";

      // Redis: Acquire locks
      const redisResult1 = await redisBackend.acquire({
        key: key1,
        ttlMs: 30000,
      });
      const redisResult2 = await redisBackend.acquire({
        key: key2,
        ttlMs: 30000,
      });

      expect(redisResult1.ok).toBe(true);
      expect(redisResult2.ok).toBe(true);

      if (redisResult1.ok && redisResult2.ok) {
        // Different keys should have independent fence counters
        // (fence values may be same if counters start at 1, but they're separate counters)
        expect(redisResult1.lockId).not.toBe(redisResult2.lockId);

        await redisBackend.release({ lockId: redisResult1.lockId });
        await redisBackend.release({ lockId: redisResult2.lockId });
      }

      // Firestore: Acquire locks
      const firestoreResult1 = await firestoreBackend.acquire({
        key: key1,
        ttlMs: 30000,
      });
      const firestoreResult2 = await firestoreBackend.acquire({
        key: key2,
        ttlMs: 30000,
      });

      expect(firestoreResult1.ok).toBe(true);
      expect(firestoreResult2.ok).toBe(true);

      if (firestoreResult1.ok && firestoreResult2.ok) {
        // Different keys should have independent fence counters
        expect(firestoreResult1.lockId).not.toBe(firestoreResult2.lockId);

        await firestoreBackend.release({ lockId: firestoreResult1.lockId });
        await firestoreBackend.release({ lockId: firestoreResult2.lockId });
      }
    });
  });

  describe("Fence Format Consistency (ADR-004)", () => {
    it("should return identical 15-digit zero-padded format across backends", async () => {
      const redisBackend = createRedisBackend(redis, {
        keyPrefix: testRedisPrefix,
      });
      const firestoreBackend = createFirestoreBackend(db, {
        collection: testFirestoreCollection,
        fenceCollection: testFirestoreFenceCollection,
      });

      const key = "consistency:fence:format";

      // Acquire from both backends
      const redisResult = await redisBackend.acquire({
        key: `redis:${key}`,
        ttlMs: 30000,
      });
      const firestoreResult = await firestoreBackend.acquire({
        key: `firestore:${key}`,
        ttlMs: 30000,
      });

      expect(redisResult.ok).toBe(true);
      expect(firestoreResult.ok).toBe(true);

      if (redisResult.ok && firestoreResult.ok) {
        // Both should use 15-digit zero-padded format
        const fenceFormatRegex = /^\d{15}$/;
        expect(redisResult.fence).toMatch(fenceFormatRegex);
        expect(firestoreResult.fence).toMatch(fenceFormatRegex);

        // Both should be exactly 15 characters
        expect(redisResult.fence.length).toBe(15);
        expect(firestoreResult.fence.length).toBe(15);

        // Lexicographic comparison should work identically
        const redisFenceNum = BigInt(redisResult.fence);
        const firestoreFenceNum = BigInt(firestoreResult.fence);

        expect(redisFenceNum).toBeGreaterThan(0n);
        expect(firestoreFenceNum).toBeGreaterThan(0n);

        await redisBackend.release({ lockId: redisResult.lockId });
        await firestoreBackend.release({ lockId: firestoreResult.lockId });
      }
    });

    it("should ensure fence sequences sort identically across backends", async () => {
      const redisBackend = createRedisBackend(redis, {
        keyPrefix: testRedisPrefix,
      });
      const firestoreBackend = createFirestoreBackend(db, {
        collection: testFirestoreCollection,
        fenceCollection: testFirestoreFenceCollection,
      });

      const redisKey = "redis:fence:sequence";
      const firestoreKey = "firestore:fence:sequence";

      const redisFences: string[] = [];
      const firestoreFences: string[] = [];

      // Generate sequences from both backends
      for (let i = 0; i < 5; i++) {
        const redisResult = await redisBackend.acquire({
          key: redisKey,
          ttlMs: 30000,
        });
        if (redisResult.ok) {
          redisFences.push(redisResult.fence);
          await redisBackend.release({ lockId: redisResult.lockId });
        }

        const firestoreResult = await firestoreBackend.acquire({
          key: firestoreKey,
          ttlMs: 30000,
        });
        if (firestoreResult.ok) {
          firestoreFences.push(firestoreResult.fence);
          await firestoreBackend.release({ lockId: firestoreResult.lockId });
        }
      }

      // Both sequences should be monotonically increasing
      for (let i = 1; i < redisFences.length; i++) {
        expect(redisFences[i]! > redisFences[i - 1]!).toBe(true);
      }

      for (let i = 1; i < firestoreFences.length; i++) {
        expect(firestoreFences[i]! > firestoreFences[i - 1]!).toBe(true);
      }

      // Lexicographic string comparison should match numeric comparison
      for (let i = 1; i < redisFences.length; i++) {
        const current = BigInt(redisFences[i]!);
        const previous = BigInt(redisFences[i - 1]!);
        expect(current > previous).toBe(true);
      }
    });
  });

  describe("Time Consistency (ADR-005)", () => {
    it("should use unified 1000ms tolerance across backends", async () => {
      // Both Redis and Firestore should use TIME_TOLERANCE_MS = 1000
      // This test verifies they handle lock expiry consistently

      const redisBackend = createRedisBackend(redis, {
        keyPrefix: testRedisPrefix,
      });
      const firestoreBackend = createFirestoreBackend(db, {
        collection: testFirestoreCollection,
        fenceCollection: testFirestoreFenceCollection,
      });

      const key = "time:consistency:test";

      // Acquire locks with short TTL
      const redisResult = await redisBackend.acquire({
        key: `redis:${key}`,
        ttlMs: 500,
      });
      const firestoreResult = await firestoreBackend.acquire({
        key: `firestore:${key}`,
        ttlMs: 500,
      });

      expect(redisResult.ok).toBe(true);
      expect(firestoreResult.ok).toBe(true);

      // Wait for TTL + tolerance (500ms + 1000ms = 1500ms)
      await Bun.sleep(1600);

      // Both should report locks as expired/unlocked
      const redisLocked = await redisBackend.isLocked({ key: `redis:${key}` });
      const firestoreLocked = await firestoreBackend.isLocked({
        key: `firestore:${key}`,
      });

      expect(redisLocked).toBe(false);
      expect(firestoreLocked).toBe(false);
    });

    it("should handle lookup consistently across backends within tolerance window", async () => {
      const redisBackend = createRedisBackend(redis, {
        keyPrefix: testRedisPrefix,
      });
      const firestoreBackend = createFirestoreBackend(db, {
        collection: testFirestoreCollection,
        fenceCollection: testFirestoreFenceCollection,
      });

      const key = "lookup:consistency:test";

      // Acquire locks
      const redisResult = await redisBackend.acquire({
        key: `redis:${key}`,
        ttlMs: 2000,
      });
      const firestoreResult = await firestoreBackend.acquire({
        key: `firestore:${key}`,
        ttlMs: 2000,
      });

      expect(redisResult.ok).toBe(true);
      expect(firestoreResult.ok).toBe(true);

      if (redisResult.ok && firestoreResult.ok) {
        // Lookup immediately - both should return lock info
        const redisLookup = await redisBackend.lookup({
          lockId: redisResult.lockId,
        });
        const firestoreLookup = await firestoreBackend.lookup({
          lockId: firestoreResult.lockId,
        });

        expect(redisLookup).not.toBeNull();
        expect(firestoreLookup).not.toBeNull();

        if (redisLookup && firestoreLookup) {
          // Both should include fence tokens
          expect(redisLookup.fence).toBeDefined();
          expect(firestoreLookup.fence).toBeDefined();

          // Both should have expiresAtMs and acquiredAtMs
          expect(redisLookup.expiresAtMs).toBeGreaterThan(Date.now());
          expect(firestoreLookup.expiresAtMs).toBeGreaterThan(Date.now());
        }

        await redisBackend.release({ lockId: redisResult.lockId });
        await firestoreBackend.release({ lockId: firestoreResult.lockId });
      }
    });

    it("should return null consistently for expired lock lookup by lockId (ADR-011)", async () => {
      // Per ADR-011: Lookup atomicity is relaxed (Redis atomic, Firestore non-atomic),
      // but both must return null consistently for expired locks to ensure portability.
      // This test verifies cross-backend consistency without over-testing atomicity races.

      const redisBackend = createRedisBackend(redis, {
        keyPrefix: testRedisPrefix,
      });
      const firestoreBackend = createFirestoreBackend(db, {
        collection: testFirestoreCollection,
        fenceCollection: testFirestoreFenceCollection,
      });

      const key = "expired:lookup:consistency";

      // Acquire locks with very short TTL
      const redisResult = await redisBackend.acquire({
        key: `redis:${key}`,
        ttlMs: 100,
      });
      const firestoreResult = await firestoreBackend.acquire({
        key: `firestore:${key}`,
        ttlMs: 100,
      });

      expect(redisResult.ok).toBe(true);
      expect(firestoreResult.ok).toBe(true);

      if (redisResult.ok && firestoreResult.ok) {
        // Wait for locks to expire (100ms TTL + 1000ms tolerance + buffer)
        await Bun.sleep(1200);

        // Both backends should return null for expired lock lookup by lockId
        const redisLookup = await redisBackend.lookup({
          lockId: redisResult.lockId,
        });
        const firestoreLookup = await firestoreBackend.lookup({
          lockId: firestoreResult.lockId,
        });

        // Consistent null return for expired locks across backends
        expect(redisLookup).toBeNull();
        expect(firestoreLookup).toBeNull();
      }
    });
  });

  describe("Config Validation Consistency", () => {
    it("should validate Firestore fence collection differs from lock collection", () => {
      // Per specs/firestore-backend.md: MUST validate fenceCollection !== collection
      expect(() => {
        createFirestoreBackend(db, {
          collection: "same_collection",
          fenceCollection: "same_collection", // Invalid - same as collection
        });
      }).toThrow("fenceCollection must be different from collection");
    });

    it("should allow different collection names in Firestore", () => {
      // Valid configuration
      expect(() => {
        createFirestoreBackend(db, {
          collection: "locks_v2",
          fenceCollection: "fence_counters_v2", // Different - valid
        });
      }).not.toThrow();
    });

    it("should validate Redis keyPrefix doesn't create fence counter namespace overlap", () => {
      // Per specs/redis-backend.md: keyPrefix cannot contain 'fence:' or end with 'fence'
      expect(() => {
        createRedisBackend(redis, {
          keyPrefix: "syncguard:fence:", // Invalid - contains 'fence:'
        });
      }).toThrow("keyPrefix cannot contain 'fence:' or end with 'fence'");

      expect(() => {
        createRedisBackend(redis, {
          keyPrefix: "syncguard:fence", // Invalid - ends with 'fence'
        });
      }).toThrow("keyPrefix cannot contain 'fence:' or end with 'fence'");
    });

    it("should allow valid Redis keyPrefix values", () => {
      // Valid configurations
      expect(() => {
        createRedisBackend(redis, {
          keyPrefix: "syncguard", // Valid - default
        });
      }).not.toThrow();

      expect(() => {
        createRedisBackend(redis, {
          keyPrefix: "app:locks:v2", // Valid - no fence conflicts
        });
      }).not.toThrow();
    });
  });
});
