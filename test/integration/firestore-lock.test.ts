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

      // Wait for Firestore operations to settle (prevents state leakage between tests)
      await Bun.sleep(100);
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

      // Wait for Firestore operations to settle (prevents state leakage between tests)
      await Bun.sleep(100);
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

      // Release all locks sequentially to avoid Firestore transaction conflicts
      for (const result of results) {
        if (result.ok) {
          const releaseResult = await backend.release({
            lockId: result.lockId,
          });
          expect(releaseResult.ok).toBe(true);
        }
      }

      // Verify all resources are unlocked
      const finalStatuses = await Promise.all(
        resources.map((key) => backend.isLocked({ key })),
      );
      expect(finalStatuses).toEqual([false, false, false]);
    }, 10000); // Extended timeout for Firestore operations
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
    it("should generate fence tokens in 15-digit zero-padded format", async () => {
      const key = "fence:format:test";
      const fenceFormatRegex = /^\d{15}$/; // ADR-004: exactly 15 digits for precision safety

      const result = await backend.acquire({ key, ttlMs: 30000 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Verify fence format compliance per ADR-004
        expect(result.fence).toMatch(fenceFormatRegex);
        expect(result.fence.length).toBe(15);
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
    }, 10000); // Extended timeout for Firestore emulator operations

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
    }, 10000); // Extended timeout for Firestore emulator operations

    it("should respect acquisition timeout and fail gracefully", async () => {
      const resourceKey = "resource:timeout-test";

      // Note: Firestore emulator has ~450ms latency per transaction on local dev,
      // but can be much higher (1000ms+) on CI/CD shared runners. Timeouts must
      // account for variable latency to prevent flaky tests.
      // Timing: First lock holds for 4000ms. After 1000ms delay, second lock starts
      // and has 2000ms timeout. Second lock will wait 3000ms (4000-1000) which exceeds
      // its 2000ms timeout, so it will fail as expected.

      // Start first lock
      const longRunningLock = lock(
        async () => {
          await Bun.sleep(4000); // Hold lock for 4 seconds (increased for CI/CD stability)
        },
        {
          key: resourceKey,
          ttlMs: 60000, // Long TTL so it doesn't expire
        },
      );

      // Give first lock time to acquire (needs longer delay for slow CI/CD emulator)
      await Bun.sleep(1000);

      // Start second lock AFTER delay - this ensures first lock has acquired
      const shortTimeoutLock = lock(
        async () => {
          throw new Error("This should not execute");
        },
        {
          key: resourceKey,
          acquisition: {
            timeoutMs: 2000, // Will timeout before first lock releases (2000ms < 3000ms wait time)
            maxRetries: 20,
            retryDelayMs: 100,
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
    }, 20000); // Extended timeout for CI/CD Firestore emulator latency (4000ms lock + 1000ms delay + 2000ms timeout + overhead)
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
      const promises = Array.from({ length: numOperations }, async () => {
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
                timeoutMs: 8000, // Increased timeout for Firestore emulator
              },
            },
          );
        } catch (error) {
          errors.push(error as Error);
        }
      });

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
    }, 15000); // Extended timeout for Firestore emulator operations

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

  describe("Time Authority & ADR-010", () => {
    it("should return authoritative expiresAtMs from acquire operation", async () => {
      const key = "time:acquire:test";
      const ttlMs = 5000;

      // Capture time before operation
      const beforeMs = Date.now();

      const result = await backend.acquire({ key, ttlMs });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Capture time after operation
        const afterMs = Date.now();

        // expiresAtMs should be authoritative (computed inside transaction)
        // It should be within reasonable bounds: beforeMs + ttlMs <= expiresAtMs <= afterMs + ttlMs
        const minExpiry = beforeMs + ttlMs;
        const maxExpiry = afterMs + ttlMs;

        expect(result.expiresAtMs).toBeGreaterThanOrEqual(minExpiry);
        expect(result.expiresAtMs).toBeLessThanOrEqual(maxExpiry);

        // Verify it's a precise value, not approximated
        expect(Number.isInteger(result.expiresAtMs)).toBe(true);

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should return authoritative expiresAtMs from extend operation", async () => {
      const key = "time:extend:test";
      const initialTtlMs = 2000;
      const extendTtlMs = 5000;

      // Acquire lock
      const result = await backend.acquire({ key, ttlMs: initialTtlMs });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait a bit
        await Bun.sleep(100);

        // Capture time before extend
        const beforeExtendMs = Date.now();

        const extendResult = await backend.extend({
          lockId: result.lockId,
          ttlMs: extendTtlMs,
        });
        expect(extendResult.ok).toBe(true);

        if (extendResult.ok) {
          // Capture time after extend
          const afterExtendMs = Date.now();

          // expiresAtMs should be authoritative (computed inside transaction)
          // It should be within reasonable bounds: beforeExtendMs + extendTtlMs <= expiresAtMs <= afterExtendMs + extendTtlMs
          const minExpiry = beforeExtendMs + extendTtlMs;
          const maxExpiry = afterExtendMs + extendTtlMs;

          expect(extendResult.expiresAtMs).toBeGreaterThanOrEqual(minExpiry);
          expect(extendResult.expiresAtMs).toBeLessThanOrEqual(maxExpiry);

          // Verify it's a precise value, not approximated
          expect(Number.isInteger(extendResult.expiresAtMs)).toBe(true);

          // Verify extend actually reset the TTL (not added to original)
          expect(extendResult.expiresAtMs).toBeGreaterThan(result.expiresAtMs);

          await backend.release({ lockId: result.lockId });
        }
      }
    });
  });

  describe("Cleanup Behavior", () => {
    it("should clean up expired locks during isLocked check when enabled", async () => {
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

    it("should NOT clean up expired locks when cleanupInIsLocked is false (default)", async () => {
      // Create backend with cleanup disabled (default behavior)
      const noCleanupBackend = createFirestoreBackend(db, {
        collection: testCollection,
        fenceCollection: testFenceCollection,
        cleanupInIsLocked: false, // Explicitly disabled
      });

      const key = "resource:no-cleanup";

      // Acquire lock with short TTL
      const result = await noCleanupBackend.acquire({ key, ttlMs: 200 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait for it to expire beyond tolerance + safety guard
        await Bun.sleep(2300);

        // isLocked should return false (lock is expired)
        const isLocked = await noCleanupBackend.isLocked({ key });
        expect(isLocked).toBe(false);

        // Wait for any fire-and-forget cleanup transaction to complete (shouldn't happen with cleanupInIsLocked: false)
        await Bun.sleep(200);

        // Verify lock document still exists in Firestore (not cleaned up)
        const lockDoc = await db.collection(testCollection).doc(key).get();
        expect(lockDoc.exists).toBe(true);

        // Manual cleanup
        await lockDoc.ref.delete();
      }
    }, 10000);

    it("should default to cleanup disabled when cleanupInIsLocked is omitted", async () => {
      // Create backend without specifying cleanupInIsLocked (should default to false)
      const defaultBackend = createFirestoreBackend(db, {
        collection: testCollection,
        fenceCollection: testFenceCollection,
        // cleanupInIsLocked omitted - should default to false
      });

      const key = "resource:default-cleanup";

      // Acquire lock with short TTL
      const result = await defaultBackend.acquire({ key, ttlMs: 200 });
      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait for it to expire
        await Bun.sleep(2300);

        // isLocked should return false (lock is expired)
        const isLocked = await defaultBackend.isLocked({ key });
        expect(isLocked).toBe(false);

        // Wait for any fire-and-forget cleanup transaction to complete (shouldn't happen with default cleanupInIsLocked: false)
        await Bun.sleep(200);

        // Verify lock document still exists (cleanup is disabled by default)
        const lockDoc = await db.collection(testCollection).doc(key).get();
        expect(lockDoc.exists).toBe(true);

        // Manual cleanup
        await lockDoc.ref.delete();
      }
    }, 10000);
  });

  describe("Fence Counter Protection", () => {
    it("should NEVER delete fence counter documents during cleanup", async () => {
      const key = "fence:cleanup:test";

      // Acquire and release lock to establish fence counter
      const result1 = await backend.acquire({ key, ttlMs: 200 });
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        const fence1 = result1.fence;

        // Release the lock
        await backend.release({ lockId: result1.lockId });

        // Wait for lock to expire completely + safety guard (200ms TTL + 1000ms tolerance + 1000ms guard = 2200ms minimum)
        await Bun.sleep(2300);

        // Trigger cleanup via isLocked
        const isLocked = await backend.isLocked({ key });
        expect(isLocked).toBe(false);

        // Wait for fire-and-forget cleanup transaction to complete
        await Bun.sleep(200);

        // Acquire new lock - fence counter MUST persist
        const result2 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result2.ok).toBe(true);

        if (result2.ok) {
          // Fence MUST be monotonically increasing (fence counter survived cleanup)
          expect(BigInt(result2.fence)).toBeGreaterThan(BigInt(fence1));

          // Clean up
          await backend.release({ lockId: result2.lockId });
        }
      }
    }, 10000);

    it("should maintain fence monotonicity across multiple cleanup cycles", async () => {
      const key = "fence:cleanup:monotonic";
      const fences: string[] = [];

      // Run multiple acquire-cleanup-acquire cycles
      for (let i = 0; i < 3; i++) {
        // Acquire lock with short TTL
        const result = await backend.acquire({ key, ttlMs: 200 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          fences.push(result.fence);
          await backend.release({ lockId: result.lockId });
        }

        // Wait for cleanup (200ms TTL + 1000ms tolerance + 1000ms guard = 2200ms minimum)
        await Bun.sleep(2300);

        // Trigger cleanup
        await backend.isLocked({ key });

        // Wait for fire-and-forget cleanup transaction to complete
        await Bun.sleep(200);
      }

      // Verify fence monotonicity across cleanup cycles
      expect(fences).toHaveLength(3);
      for (let i = 1; i < fences.length; i++) {
        expect(BigInt(fences[i]!)).toBeGreaterThan(BigInt(fences[i - 1]!));
      }
    }, 15000);

    it("should protect fence counter from direct database access during cleanup", async () => {
      const key = "fence:cleanup:protection";

      // Acquire initial lock to create fence counter
      const result1 = await backend.acquire({ key, ttlMs: 200 });
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        await backend.release({ lockId: result1.lockId });

        // Wait for cleanup window
        await Bun.sleep(2300);

        // Trigger cleanup
        await backend.isLocked({ key });

        // Wait for fire-and-forget cleanup transaction to complete
        await Bun.sleep(200);

        // Verify fence counter document still exists
        const fenceDocId = `fence:${key}`;
        const fenceDoc = await db
          .collection(testFenceCollection)
          .doc(fenceDocId)
          .get();

        // Fence counter MUST still exist after cleanup
        expect(fenceDoc.exists).toBe(true);

        // Clean up
        await fenceDoc.ref.delete();
      }
    }, 10000);
  });
});
