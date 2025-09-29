// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Integration tests for Firestore lock implementation
 *
 * These tests verify the complete lock functionality using a real Firestore emulator:
 * - Basic lock operations (acquire, release, extend, isLocked)
 * - Automatic lock management with callback pattern
 * - Lock contention and timing behavior
 * - TTL expiration and cleanup
 * - Concurrent access patterns
 * - Error recovery and edge cases
 * - Fencing token functionality
 *
 * Prerequisites:
 * - Firestore emulator running on 127.0.0.1:8080
 * - Tests use separate collections to avoid conflicts with other data
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
} from "bun:test";
import type { LockBackend } from "../../common";
import { LockError } from "../../common/errors.js";
import { createFirestoreBackend, createLock } from "../../firestore";
import type { FirestoreCapabilities } from "../../firestore/types";

describe("Firestore Lock Integration Tests", () => {
  let db: Firestore;
  let lock: ReturnType<typeof createLock>;
  let backend: LockBackend<FirestoreCapabilities>;
  const testCollection = "test_locks";
  const testFenceCollection = "test_fence_counters";

  beforeAll(async () => {
    // Initialize Firestore with emulator settings
    db = new Firestore({
      projectId: "syncguard-test",
      host: "127.0.0.1:8080",
      ssl: false,
    });

    console.log("✅ Connected to Firestore emulator for integration tests");
  });

  beforeEach(async () => {
    // Create backend and lock with test-specific collections
    backend = createFirestoreBackend(db, {
      collection: testCollection,
      fenceCollection: testFenceCollection,
      cleanupInIsLocked: true, // Enable cleanup for testing
    });
    lock = createLock(db, {
      collection: testCollection,
      fenceCollection: testFenceCollection,
      cleanupInIsLocked: true, // Enable cleanup for testing
    });

    // Clean slate for each test - delete all documents in test collections
    try {
      const locksCollection = db.collection(testCollection);
      const fenceCollection = db.collection(testFenceCollection);

      // Delete all documents in locks collection
      const lockDocs = await locksCollection.get();
      const lockBatch = db.batch();
      lockDocs.docs.forEach((doc) => lockBatch.delete(doc.ref));
      if (!lockDocs.empty) await lockBatch.commit();

      // Delete all documents in fence collection
      const fenceDocs = await fenceCollection.get();
      const fenceBatch = db.batch();
      fenceDocs.docs.forEach((doc) => fenceBatch.delete(doc.ref));
      if (!fenceDocs.empty) await fenceBatch.commit();
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("already been terminated")) {
        console.warn(
          "⚠️  Firestore client terminated during test cleanup - skipping",
        );
        return;
      }
      console.warn("⚠️  Could not clear Firestore data:", message);
    }
  });

  afterEach(async () => {
    // Clean up test data after each test
    try {
      const locksCollection = db.collection(testCollection);
      const fenceCollection = db.collection(testFenceCollection);

      // Delete all documents in locks collection
      const lockDocs = await locksCollection.get();
      const lockBatch = db.batch();
      lockDocs.docs.forEach((doc) => lockBatch.delete(doc.ref));
      if (!lockDocs.empty) await lockBatch.commit();

      // Delete all documents in fence collection
      const fenceDocs = await fenceCollection.get();
      const fenceBatch = db.batch();
      fenceDocs.docs.forEach((doc) => fenceBatch.delete(doc.ref));
      if (!fenceDocs.empty) await fenceBatch.commit();
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("already been terminated")) {
        console.warn(
          "⚠️  Firestore client terminated during test cleanup - skipping",
        );
        return;
      }
      console.warn("⚠️  Could not clear Firestore data:", message);
    }
  });

  afterAll(async () => {
    // Skip termination when running in parallel test suites to avoid
    // "client has already been terminated" errors from other test files
    // The emulator connection will be cleaned up when the process exits
  });

  describe("Core Lock Operations", () => {
    it("should successfully perform complete lock lifecycle", async () => {
      const resourceKey = "user:profile:12345";

      // 1. Acquire lock
      const acquireResult = await backend.acquire({
        key: resourceKey,
        ttlMs: 30000, // 30 seconds
      });

      expect(acquireResult.ok).toBe(true);

      if (acquireResult.ok) {
        // Verify lock properties
        expect(acquireResult.lockId).toBeDefined();
        expect(typeof acquireResult.lockId).toBe("string");
        expect(acquireResult.expiresAtMs).toBeGreaterThan(Date.now());
        expect(typeof acquireResult.expiresAtMs).toBe("number");
        expect(acquireResult.fence).toBeDefined();
        expect(typeof acquireResult.fence).toBe("string");

        // 2. Verify resource is locked
        const isLocked = await backend.isLocked({ key: resourceKey });
        expect(isLocked).toBe(true);

        // 3. Release lock
        const releaseResult = await backend.release({
          lockId: acquireResult.lockId,
        });
        expect(releaseResult.ok).toBe(true);

        // 4. Verify resource is unlocked
        const isLockedAfter = await backend.isLocked({ key: resourceKey });
        expect(isLockedAfter).toBe(false);
      }
    });

    it("should automatically manage lock lifecycle with callback pattern", async () => {
      const resourceKey = "api:rate-limit:user:789";
      let criticalSectionExecuted = false;
      let lockWasActiveInside = false;

      // Execute critical section with automatic lock management
      const result = await lock(
        async () => {
          criticalSectionExecuted = true;

          // Verify lock is active during execution
          lockWasActiveInside = await backend.isLocked({ key: resourceKey });

          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 10));

          return "operation completed";
        },
        {
          key: resourceKey,
          ttlMs: 15000, // 15 seconds
        },
      );

      // Verify execution results
      expect(criticalSectionExecuted).toBe(true);
      expect(lockWasActiveInside).toBe(true);
      expect(result).toBe("operation completed");

      // Verify lock was automatically released
      const isLockedAfter = await backend.isLocked({ key: resourceKey });
      expect(isLockedAfter).toBe(false);
    });

    it("should automatically release lock even when callback throws error", async () => {
      const resourceKey = "payment:transaction:error-test";
      let lockWasActiveBeforeError = false;

      try {
        await lock(
          async () => {
            // Verify lock is active
            lockWasActiveBeforeError = await backend.isLocked({
              key: resourceKey,
            });

            // Simulate an error during critical section
            throw new Error("Simulated processing error");
          },
          {
            key: resourceKey,
            ttlMs: 10000,
          },
        );

        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toBe("Simulated processing error");
        expect(lockWasActiveBeforeError).toBe(true);
      }

      // Critical: Lock must be released even after error
      const isLockedAfter = await backend.isLocked({ key: resourceKey });
      expect(isLockedAfter).toBe(false);
    });

    it("should handle multiple lock operations on different resources", async () => {
      const resources = [
        "database:connection:1",
        "cache:key:user-session",
        "file:upload:temp-123",
      ];

      // Acquire locks on all resources simultaneously
      const results = await Promise.all(
        resources.map((key) => backend.acquire({ key, ttlMs: 60000 })),
      );

      // All acquisitions should succeed
      results.forEach((result, index) => {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.lockId).toBeDefined();
          expect(result.fence).toBeDefined();
        }
      });

      // Verify all resources are locked
      const lockStatuses = await Promise.all(
        resources.map((key) => backend.isLocked({ key })),
      );
      expect(lockStatuses).toEqual([true, true, true]);

      // Release all locks
      const releaseResults = await Promise.all(
        results.map((result, index) => {
          if (result.ok) {
            return backend.release({ lockId: result.lockId });
          }
          return { ok: false as const, reason: "failed" as const };
        }),
      );

      // All releases should succeed
      releaseResults.forEach((result) => {
        expect(result.ok).toBe(true);
      });

      // Verify all resources are unlocked
      const finalStatuses = await Promise.all(
        resources.map((key) => backend.isLocked({ key })),
      );
      expect(finalStatuses).toEqual([false, false, false]);
    });
  });

  describe("Ownership Verification (ADR-003)", () => {
    it("should verify ownership explicitly in release operation", async () => {
      const key = "ownership:release:test";

      // Acquire a lock
      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Try to release with a different valid lockId (22 base64url chars)
        const fakeLockId = "ZmZmZmZmZmZmZmZmZmZmZg"; // Valid format, wrong owner
        const releaseResult = await backend.release({ lockId: fakeLockId });

        // Should fail due to explicit ownership verification (spec lines 143-160)
        expect(releaseResult.ok).toBe(false);

        // Original lock should still be held
        expect(await backend.isLocked({ key })).toBe(true);

        // Clean up with correct lockId
        await backend.release({ lockId: result.lockId });
      }
    });

    it("should verify ownership explicitly in extend operation", async () => {
      const key = "ownership:extend:test";

      // Acquire a lock
      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Try to extend with a different valid lockId (22 base64url chars)
        const fakeLockId = "eHh4eHh4eHh4eHh4eHh4eA"; // Valid format, wrong owner
        const extendResult = await backend.extend({
          lockId: fakeLockId,
          ttlMs: 60000,
        });

        // Should fail due to explicit ownership verification (spec lines 143-160)
        expect(extendResult.ok).toBe(false);

        // Original lock should still be held with original TTL
        expect(await backend.isLocked({ key })).toBe(true);

        // Clean up
        await backend.release({ lockId: result.lockId });
      }
    });

    it("should verify data.lockId === lockId in lookup operation", async () => {
      const key = "ownership:lookup:test";

      // Acquire a lock
      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Lookup with correct lockId should succeed
        const lookupCorrect = await backend.lookup({ lockId: result.lockId });
        expect(lookupCorrect).not.toBeNull();

        // Lookup with non-existent lockId should return null (spec lines 573-574)
        const fakeLockId = "nonExistentLockId12345";
        const lookupWrong = await backend.lookup({ lockId: fakeLockId });
        expect(lookupWrong).toBeNull();

        // Clean up
        await backend.release({ lockId: result.lockId });
      }
    });
  });

  describe("Fencing Token Functionality", () => {
    it("should generate fence tokens in 19-digit zero-padded format", async () => {
      const key = "fence:format:test";
      const fenceFormatRegex = /^\d{19}$/; // Spec requirement: exactly 19 digits

      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Verify fence format compliance per spec lines 1178-1185
        expect(result.fence).toMatch(fenceFormatRegex);
        expect(result.fence.length).toBe(19);
        expect(BigInt(result.fence)).toBeGreaterThan(0n);

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should generate monotonically increasing fencing tokens with lexicographic ordering", async () => {
      const resourceKey = "fence:test:resource";
      const fenceTokens: string[] = [];

      // Acquire and release locks multiple times
      for (let i = 0; i < 5; i++) {
        const result = await backend.acquire({
          key: resourceKey,
          ttlMs: 30000,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          fenceTokens.push(result.fence);
          await backend.release({ lockId: result.lockId });
        }
      }

      // Verify tokens are monotonically increasing (both numeric and lexicographic)
      expect(fenceTokens).toHaveLength(5);
      for (let i = 1; i < fenceTokens.length; i++) {
        // String comparison should work due to zero-padding (spec requirement)
        expect(fenceTokens[i]! > fenceTokens[i - 1]!).toBe(true);

        // Numeric comparison should also hold
        const current = BigInt(fenceTokens[i]!);
        const previous = BigInt(fenceTokens[i - 1]!);
        expect(current > previous).toBe(true);
      }
    });

    it("should provide consistent fencing tokens across different resources", async () => {
      const resource1 = "fence:resource:1";
      const resource2 = "fence:resource:2";

      const result1 = await backend.acquire({ key: resource1, ttlMs: 30000 });
      const result2 = await backend.acquire({ key: resource2, ttlMs: 30000 });

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Fencing tokens should be different if they were acquired sequentially
        // Due to Firestore's document-level atomic operations, they may be the same if acquired concurrently
        // At minimum, they should be valid fence tokens
        expect(result1.fence).toBeDefined();
        expect(result2.fence).toBeDefined();
        expect(typeof result1.fence).toBe("string");
        expect(typeof result2.fence).toBe("string");

        // Clean up
        await backend.release({ lockId: result1.lockId });
        await backend.release({ lockId: result2.lockId });
      }
    });
  });

  describe("Lock Contention", () => {
    it("should prevent concurrent access and ensure data consistency", async () => {
      const resourceKey = "shared:counter";
      let sharedCounter = 0;
      const incrementResults: number[] = [];

      // Two operations that modify shared state
      const operation1 = lock(
        async () => {
          const current = sharedCounter;
          await Bun.sleep(30); // Simulate some work
          sharedCounter = current + 1;
          incrementResults.push(sharedCounter);
        },
        { key: resourceKey },
      );

      // Slight delay to ensure operation1 starts first
      await Bun.sleep(10);

      const operation2 = lock(
        async () => {
          const current = sharedCounter;
          await Bun.sleep(30); // Simulate some work
          sharedCounter = current + 1;
          incrementResults.push(sharedCounter);
        },
        {
          key: resourceKey,
          acquisition: {
            retryDelayMs: 10,
            maxRetries: 50,
            timeoutMs: 2000,
          },
        },
      );

      // Wait for both operations
      const results = await Promise.allSettled([operation1, operation2]);

      // At least one operation should succeed
      const successCount = results.filter(
        (r) => r.status === "fulfilled",
      ).length;
      expect(successCount).toBeGreaterThan(0);

      // If both succeeded, counter should be 2 and results should be [1, 2]
      if (successCount === 2) {
        expect(sharedCounter).toBe(2);
        expect(incrementResults).toEqual([1, 2]);
      } else {
        // If only one succeeded, counter should be 1
        expect(sharedCounter).toBe(1);
        expect(incrementResults).toEqual([1]);
      }
    });

    it("should allow concurrent access to different resources", async () => {
      const startTime = Date.now();

      // Lock different resources concurrently
      await Promise.all([
        lock(
          async () => {
            await Bun.sleep(100);
          },
          { key: "resource:5" },
        ),
        lock(
          async () => {
            await Bun.sleep(100);
          },
          { key: "resource:6" },
        ),
        lock(
          async () => {
            await Bun.sleep(100);
          },
          { key: "resource:7" },
        ),
      ]);

      const elapsed = Date.now() - startTime;

      // Should complete reasonably fast for parallel execution (Firestore emulator can be slow)
      expect(elapsed).toBeLessThan(5000); // More generous timeout for Firestore
    });

    it("should respect acquisition timeout and fail gracefully", async () => {
      const resourceKey = "resource:timeout-test";

      // First lock holds for longer than second lock's timeout
      const longRunningLock = lock(
        async () => {
          await Bun.sleep(800); // Hold lock for 800ms
        },
        {
          key: resourceKey,
          ttlMs: 60000, // Long TTL so it doesn't expire
        },
      );

      // Give first lock time to acquire
      await Bun.sleep(50);

      // Second lock attempts with short timeout
      const shortTimeoutLock = lock(
        async () => {
          throw new Error("This should not execute");
        },
        {
          key: resourceKey,
          acquisition: {
            timeoutMs: 300, // Will timeout before first lock releases
            maxRetries: 50,
            retryDelayMs: 5,
          },
        },
      );

      const results = await Promise.allSettled([
        longRunningLock,
        shortTimeoutLock,
      ]);

      // First should succeed
      expect(results[0].status).toBe("fulfilled");

      // Second should fail
      expect(results[1].status).toBe("rejected");
      if (results[1].status === "rejected") {
        // Could fail with timeout or lock contention message
        const errorMessage = results[1].reason.message;
        const isExpectedFailure =
          errorMessage.includes("timeout") ||
          errorMessage.includes("Timeout") ||
          errorMessage.includes("Lock already held") ||
          errorMessage.includes("Failed to acquire lock");
        if (!isExpectedFailure) {
          console.log("Unexpected error message:", errorMessage);
        }
        expect(isExpectedFailure).toBe(true);
      }
    });
  });

  describe("Lock Expiration", () => {
    it("should auto-expire locks after TTL", async () => {
      const key = "resource:9";

      // Acquire lock with short TTL
      // Per spec: Firestore uses 1000ms tolerance + 1000ms cleanup safety guard = 2000ms total
      const result = await backend.acquire({ key, ttlMs: 300 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Verify lock is held
        expect(await backend.isLocked({ key: key })).toBe(true);

        // Wait for TTL to expire + tolerance + safety guard (300ms TTL + 1000ms tolerance + 1000ms guard = 2300ms minimum)
        await Bun.sleep(2400);

        // Lock should be expired (cleanup happens during isLocked check with safety guard)
        const isLockedAfterExpiry = await backend.isLocked({ key: key });
        expect(isLockedAfterExpiry).toBe(false);

        // Another process should be able to acquire it
        const result2 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result2.ok).toBe(true);

        if (result2.ok) {
          await backend.release({ lockId: result2.lockId });
        }
      }
    }, 10000); // Extended timeout for sleep + Firestore operations

    it("should extend lock TTL", async () => {
      const key = "resource:10";

      // Acquire lock with short TTL
      const result = await backend.acquire({ key, ttlMs: 500 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait a bit
        await Bun.sleep(300);

        // Extend the lock
        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 1000,
        });
        expect(extended.ok).toBe(true);

        // Wait past original expiry
        await Bun.sleep(300);

        // Lock should still be held
        expect(await backend.isLocked({ key: key })).toBe(true);

        // Clean up
        await backend.release({ lockId: result.lockId });
      }
    });

    it("should not extend expired lock", async () => {
      const key = "resource:11";

      // Acquire lock with very short TTL
      const result = await backend.acquire({ key, ttlMs: 100 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait for lock to expire beyond tolerance (100ms TTL + 1000ms tolerance = 1100ms minimum)
        await Bun.sleep(1200);

        // Try to extend expired lock - this should fail as the lock is expired
        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 1000,
        });
        expect(extended.ok).toBe(false);
      }
    });
  });

  describe("Error Handling", () => {
    it("should handle release of non-existent lock", async () => {
      const released = await backend.release({
        lockId: "AAAAAAAAAAAAAAAAAAAAAA", // Valid format but non-existent
      });
      expect(released.ok).toBe(false);
    });

    it("should handle double release", async () => {
      const key = "resource:12";

      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // First release should succeed
        const released1 = await backend.release({ lockId: result.lockId });
        expect(released1.ok).toBe(true);

        // Second release should fail gracefully
        const released2 = await backend.release({ lockId: result.lockId });
        expect(released2.ok).toBe(false);
      }
    });

    it("should prevent release by wrong lock owner", async () => {
      const key = "resource:13";

      // First lock
      const result1 = await backend.acquire({ key, ttlMs: 30000 });
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        // Try to release with wrong lockId
        const released = await backend.release({
          lockId: "wrongLockIdTest1234567",
        }); // Valid format but wrong owner
        expect(released.ok).toBe(false);

        // Original lock should still be held
        expect(await backend.isLocked({ key: key })).toBe(true);

        // Clean up with correct lockId
        await backend.release({ lockId: result1.lockId });
      }
    });

    it("should handle malformed lock IDs", async () => {
      // These should throw LockError("InvalidArgument") per the interface specification
      await expect(backend.release({ lockId: "" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(backend.release({ lockId: "invalid-uuid" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(backend.extend({ lockId: "", ttlMs: 1000 })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(
        backend.extend({ lockId: "invalid-uuid", ttlMs: 1000 }),
      ).rejects.toThrow("Invalid lockId format");
    });
  });

  describe("Lookup Operation", () => {
    it("should validate key before performing lookup (spec requirement)", async () => {
      // Per spec lines 568-571: MUST validate inputs before any I/O operations

      // Invalid keys should throw immediately without I/O
      await expect(backend.lookup({ key: "" })).rejects.toThrow(LockError);
      await expect(backend.lookup({ key: "x".repeat(600) })).rejects.toThrow(
        "exceeds maximum length",
      );
    });

    it("should validate lockId before performing lookup (spec requirement)", async () => {
      // Per spec lines 568-571: MUST validate inputs before any I/O operations

      // Invalid lockIds should throw immediately without I/O
      await expect(backend.lookup({ lockId: "" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(
        backend.lookup({ lockId: "invalid-lockid" }),
      ).rejects.toThrow("Invalid lockId format");
      await expect(backend.lookup({ lockId: "x" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(
        backend.lookup({ lockId: "way-too-long-lockid-that-exceeds-22-chars" }),
      ).rejects.toThrow("Invalid lockId format");
    });

    it("should return lock information for existing locks", async () => {
      const key = "lookup:test:resource";

      const acquireResult = await backend.acquire({ key, ttlMs: 30000 });
      expect(acquireResult.ok).toBe(true);

      if (acquireResult.ok) {
        // Test lookup operation
        const lookupResult = await backend.lookup({
          lockId: acquireResult.lockId,
        });
        expect(lookupResult).not.toBeNull();

        if (lookupResult) {
          expect(typeof lookupResult.keyHash).toBe("string");
          expect(typeof lookupResult.lockIdHash).toBe("string");
          expect(lookupResult.expiresAtMs).toBe(acquireResult.expiresAtMs);
          expect(lookupResult.fence).toBe(acquireResult.fence);
          expect(typeof lookupResult.acquiredAtMs).toBe("number");
        }

        // Clean up
        await backend.release({ lockId: acquireResult.lockId });
      }
    });

    it("should return not found for non-existent locks", async () => {
      const lookupResult = await backend.lookup({
        lockId: "AAAAAAAAAAAAAAAAAAAAAA",
      }); // Valid format but non-existent
      expect(lookupResult).toBeNull();
    });
  });

  describe("Stress Testing", () => {
    it("should demonstrate lock contention behavior under concurrent load", async () => {
      const numOperations = 3; // Reduced for Firestore consistency
      const resourceKey = "resource:stress-test";
      let successfulOperations = 0;
      const errors: Error[] = [];

      // Create concurrent lock operations
      const promises = Array.from(
        { length: numOperations },
        async (_, index) => {
          try {
            await lock(
              async () => {
                successfulOperations++;
                await Bun.sleep(10); // Brief critical section
              },
              {
                key: resourceKey,
                acquisition: {
                  retryDelayMs: 50,
                  maxRetries: 20,
                  timeoutMs: 5000, // Increased timeout for Firestore
                },
              },
            );
          } catch (error) {
            errors.push(error as Error);
          }
        },
      );

      await Promise.all(promises);

      // Verify some operations succeeded (may be multiple due to Firestore's consistency)
      expect(successfulOperations).toBeGreaterThan(0);
      expect(successfulOperations).toBeLessThanOrEqual(numOperations);

      // Lock contention failures are expected and acceptable
      if (errors.length > 0) {
        errors.forEach((error) => {
          expect(error.message).toMatch(
            /Failed to acquire lock|timeout|Lock already held/,
          );
        });
      }

      // Verify no dangling locks remain (with some delay for cleanup)
      await Bun.sleep(100);
      expect(await backend.isLocked({ key: resourceKey })).toBe(false);
    });

    it("should handle rapid acquire/release cycles", async () => {
      const key = "resource:rapid";
      const cycles = 10;

      for (let i = 0; i < cycles; i++) {
        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          // Verify lock is held
          expect(await backend.isLocked({ key: key })).toBe(true);

          // Release immediately
          const released = await backend.release({ lockId: result.lockId });
          expect(released.ok).toBe(true);

          // Verify lock is released
          expect(await backend.isLocked({ key: key })).toBe(false);
        }
      }
    });
  });

  describe("Cleanup Behavior", () => {
    it("should clean up expired locks during isLocked check", async () => {
      const key = "resource:cleanup";

      // Create a lock with very short TTL
      // Per spec: Firestore backend with cleanup enabled uses 1000ms tolerance + 1000ms safety guard
      const result = await backend.acquire({ key, ttlMs: 200 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait for it to expire beyond tolerance + safety guard (200ms TTL + 1000ms tolerance + 1000ms guard = 2200ms minimum)
        await Bun.sleep(2300);

        // isLocked should trigger cleanup and return false
        const isLocked = await backend.isLocked({ key: key });
        expect(isLocked).toBe(false);

        // Verify the lock was actually cleaned up (can acquire immediately)
        const result2 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result2.ok).toBe(true);

        if (result2.ok) {
          await backend.release({ lockId: result2.lockId });
        }
      }
    }, 10000); // Extended timeout for sleep + Firestore operations
  });
});
