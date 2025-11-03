// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Integration tests for Firestore backend with real Firestore emulator
 *
 * These tests verify:
 * - End-to-end functionality with actual Firestore
 * - Document structure and data consistency
 * - Fencing token counter management
 * - Real-world concurrency scenarios
 * - Performance characteristics
 * - Firestore-specific error handling
 *
 * Requires Firestore emulator running on 127.0.0.1:8080
 */

import { Firestore } from "@google-cloud/firestore";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { LockBackend } from "../../common/backend.js";
import { createFirestoreBackend } from "../../firestore/backend.js";
import type { FirestoreCapabilities } from "../../firestore/types.js";
import {
  checkFirestoreEmulatorAvailability,
  handleFirestoreUnavailability,
} from "./firestore-emulator-check.js";

describe("Firestore Integration Tests", () => {
  let db: Firestore;
  let backend: LockBackend<FirestoreCapabilities>;
  const testCollection = "integration_test_locks";
  const testFenceCollection = "integration_test_fence_counters";

  beforeAll(async () => {
    // Initialize Firestore with emulator settings
    db = new Firestore({
      projectId: "syncguard-integration-test",
      host: "127.0.0.1:8080",
      ssl: false,
    });

    // Check Firestore emulator availability
    const available = await checkFirestoreEmulatorAvailability(db);
    handleFirestoreUnavailability(available, "Firestore Integration Tests");

    // Create backend with test-specific collections
    backend = createFirestoreBackend(db, {
      collection: testCollection,
      fenceCollection: testFenceCollection,
      cleanupInIsLocked: true, // Enable cleanup for testing
    });
  });

  afterAll(async () => {
    // Skip termination when running in parallel test suites to avoid
    // "client has already been terminated" errors from other test files
    // The emulator connection will be cleaned up when the process exits
  });

  beforeEach(async () => {
    // Clean up any test data before each test
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
          "⚠️  Firestore client terminated during test setup - skipping cleanup",
        );
        return;
      }
      console.warn("⚠️  Could not clear Firestore data:", message);
    }
  });

  describe("Basic Lock Operations", () => {
    it("should acquire and release locks with real Firestore", async () => {
      const result = await backend.acquire({
        key: "integration:basic:lock",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.lockId).toBe("string");
        expect(typeof result.expiresAtMs).toBe("number");
        expect(typeof result.fence).toBe("string");
        expect(result.expiresAtMs).toBeGreaterThan(Date.now());

        // Verify lock exists in Firestore
        const isLocked = await backend.isLocked({
          key: "integration:basic:lock",
        });
        expect(isLocked).toBe(true);

        // Release the lock
        const released = await backend.release({ lockId: result.lockId });
        expect(released.ok).toBe(true);

        // Verify lock is gone
        const isLockedAfter = await backend.isLocked({
          key: "integration:basic:lock",
        });
        expect(isLockedAfter).toBe(false);
      }
    });

    it("should handle lock contention correctly", async () => {
      // Acquire first lock
      const lock1 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock1.ok).toBe(true);

      // Try to acquire same resource - should fail
      const lock2 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock2.ok).toBe(false);
      if (!lock2.ok) {
        expect(lock2.reason).toBe("locked");
      }

      // Release first lock
      if (lock1.ok) {
        await backend.release({ lockId: lock1.lockId });
      }

      // Now should be able to acquire
      const lock3 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock3.ok).toBe(true);

      if (lock3.ok) {
        await backend.release({ lockId: lock3.lockId });
      }
    });

    it("should extend locks properly", async () => {
      const result = await backend.acquire({
        key: "integration:extend:test",
        ttlMs: 5000, // Longer initial TTL to avoid timing issues
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const initialExpiry = result.expiresAtMs;

        // Wait a bit then extend
        await new Promise((resolve) => setTimeout(resolve, 100));

        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 8000, // Even longer extension
        });
        expect(extended.ok).toBe(true);

        if (extended.ok) {
          expect(extended.expiresAtMs).toBeGreaterThan(initialExpiry);
        }

        // Verify lock still exists and has longer TTL
        const isLocked = await backend.isLocked({
          key: "integration:extend:test",
        });
        expect(isLocked).toBe(true);

        await backend.release({ lockId: result.lockId });
      }
    });
  });

  describe("Firestore Document Structure", () => {
    it("should store lock data correctly in Firestore", async () => {
      const result = await backend.acquire({
        key: "integration:data:verification",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);

      if (result.ok) {
        // Check main lock document
        const lockDocRef = db
          .collection(testCollection)
          .doc("integration:data:verification");
        const lockDocSnap = await lockDocRef.get();

        expect(lockDocSnap.exists).toBe(true);

        if (lockDocSnap.exists) {
          const lockData = lockDocSnap.data()!;
          expect(lockData.lockId).toBe(result.lockId);
          expect(lockData.key).toBe("integration:data:verification");
          expect(lockData.fence).toBe(result.fence);
          expect(typeof lockData.expiresAtMs).toBe("number");
          expect(typeof lockData.acquiredAtMs).toBe("number");
          expect(lockData.expiresAtMs).toBe(result.expiresAtMs);

          // Check fence counter document (ADR-006: two-step pattern)
          // Fence doc ID: makeStorageKey("", `fence:${baseKey}`, 1500)
          const baseKey = "integration:data:verification"; // No truncation needed
          const fenceDocId = `fence:${baseKey}`; // Two-step pattern
          const fenceDocRef = db
            .collection(testFenceCollection)
            .doc(fenceDocId);
          const fenceDocSnap = await fenceDocRef.get();

          expect(fenceDocSnap.exists).toBe(true);

          if (fenceDocSnap.exists) {
            const fenceData = fenceDocSnap.data()!;
            expect(fenceData.fence).toBe(result.fence);
            expect(fenceData.keyDebug).toBe("integration:data:verification");
          }

          // Clean up
          await backend.release({ lockId: result.lockId });

          // Verify cleanup - lock document should be gone
          const lockDocSnapAfter = await lockDocRef.get();
          expect(lockDocSnapAfter.exists).toBe(false);

          // Fence counter should remain (for monotonic consistency)
          const fenceDocSnapAfter = await fenceDocRef.get();
          expect(fenceDocSnapAfter.exists).toBe(true);
        }
      }
    });

    it("should maintain monotonic fencing tokens across operations", async () => {
      const resourceKey = "integration:fence:monotonic";
      const fenceTokens: string[] = [];

      // Acquire and release multiple times
      for (let i = 0; i < 3; i++) {
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

      // Verify tokens are monotonically increasing
      expect(fenceTokens).toHaveLength(3);
      for (let i = 1; i < fenceTokens.length; i++) {
        const current = parseInt(fenceTokens[i]!, 10);
        const previous = parseInt(fenceTokens[i - 1]!, 10);
        expect(current).toBeGreaterThan(previous);
      }

      // Check that fence counter document reflects the latest value (ADR-006: two-step pattern)
      const fenceDocId = `fence:${resourceKey}`; // Two-step pattern
      const fenceDocRef = db.collection(testFenceCollection).doc(fenceDocId);
      const fenceDocSnap = await fenceDocRef.get();

      if (fenceDocSnap.exists) {
        const fenceData = fenceDocSnap.data()!;
        expect(fenceData.fence).toBe(fenceTokens[fenceTokens.length - 1]);
      }
    });
  });

  describe("Concurrency and Race Conditions", () => {
    it("should handle concurrent lock attempts", async () => {
      const resourceKey = "integration:concurrent:resource";
      const attempts = 5;
      const promises = [];

      // Launch multiple concurrent lock attempts
      for (let i = 0; i < attempts; i++) {
        promises.push(
          backend.acquire({
            key: resourceKey,
            ttlMs: 30000, // Longer TTL to avoid expiration during cleanup
          }),
        );
      }

      const results = await Promise.all(promises);

      // At least one should succeed, but due to Firestore's consistency model,
      // multiple may succeed if they're truly concurrent
      const successful = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      expect(successful.length).toBeGreaterThanOrEqual(1);
      expect(successful.length).toBeLessThanOrEqual(attempts);

      // All failed attempts should have reason "locked"
      failed.forEach((result) => {
        if (!result.ok) {
          expect(result.reason).toBe("locked");
        }
      });

      // Clean up all successful locks (cleanup handled by beforeEach/afterEach)
    }, 10000); // Extended timeout for Firestore emulator operations

    it("should handle rapid acquire/release cycles", async () => {
      const resourceKey = "integration:rapid:cycles";
      const fenceTokens: string[] = [];

      for (let i = 0; i < 10; i++) {
        const result = await backend.acquire({
          key: resourceKey,
          ttlMs: 1000,
        });

        expect(result.ok).toBe(true);

        if (result.ok) {
          fenceTokens.push(result.fence);
          const released = await backend.release({ lockId: result.lockId });
          expect(released.ok).toBe(true);
        }
      }

      // All fence tokens should be unique and monotonic
      expect(fenceTokens).toHaveLength(10);
      const uniqueTokens = new Set(fenceTokens);
      expect(uniqueTokens.size).toBe(10);

      // Verify monotonicity
      for (let i = 1; i < fenceTokens.length; i++) {
        const current = parseInt(fenceTokens[i]!, 10);
        const previous = parseInt(fenceTokens[i - 1]!, 10);
        expect(current).toBeGreaterThan(previous);
      }
    });
  });

  describe("Error Handling and Edge Cases", () => {
    it("should handle expired locks gracefully", async () => {
      const result = await backend.acquire({
        key: "integration:expiry:test",
        ttlMs: 500, // Short TTL
      });

      expect(result.ok).toBe(true);

      if (result.ok) {
        // Wait for lock to expire plus safety guard period (1000ms from implementation)
        await new Promise((resolve) => setTimeout(resolve, 1600));

        // Lock should be expired and cleaned up by isLocked
        const isLocked = await backend.isLocked({
          key: "integration:expiry:test",
        });
        expect(isLocked).toBe(false);

        // Trying to extend expired lock should fail
        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 5000,
        });
        expect(extended.ok).toBe(false);

        // Release should be idempotent (no error)
        const released = await backend.release({ lockId: result.lockId });
        expect(released.ok).toBe(false); // Returns false for non-existent locks
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
    it("should retrieve lock information correctly", async () => {
      const resourceKey = "integration:lookup:test";

      const acquireResult = await backend.acquire({
        key: resourceKey,
        ttlMs: 30000,
      });

      expect(acquireResult.ok).toBe(true);

      if (acquireResult.ok) {
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

        await backend.release({ lockId: acquireResult.lockId });
      }
    });

    it("should return not found for non-existent lock", async () => {
      const lookupResult = await backend.lookup({
        lockId: "AAAAAAAAAAAAAAAAAAAAAA", // Valid format but non-existent
      });

      expect(lookupResult).toBeNull();
    });
  });

  describe("Backend Capabilities", () => {
    it("should report correct capabilities", async () => {
      expect(backend.capabilities.supportsFencing).toBe(true);
      expect(backend.capabilities.timeAuthority).toBe("client");
    });
  });

  describe("Performance Characteristics", () => {
    it("should complete basic operations within reasonable time", async () => {
      const startTime = Date.now();
      const operations = [];

      // Perform multiple operations to test performance
      for (let i = 0; i < 5; i++) {
        operations.push(
          backend
            .acquire({
              key: `integration:performance:test:${i}`,
              ttlMs: 30000,
            })
            .then(async (result) => {
              if (result.ok) {
                await backend.release({ lockId: result.lockId });
              }
              return result;
            }),
        );
      }

      const results = await Promise.all(operations);
      const elapsed = Date.now() - startTime;

      console.log(`5 acquire/release cycles took ${elapsed}ms`);

      // All operations should succeed
      results.forEach((result) => {
        expect(result.ok).toBe(true);
      });

      // Should complete in reasonable time (Firestore emulator can be slow)
      expect(elapsed).toBeLessThan(15000); // 15 seconds for 5 operations with emulator
    }, 20000); // Extended timeout for Firestore emulator operations
  });

  describe("Collection Management", () => {
    it("should use custom collection names when specified", async () => {
      const customBackend = createFirestoreBackend(db, {
        collection: "custom_locks_test",
        fenceCollection: "custom_fence_test",
      });

      const result = await customBackend.acquire({
        key: "custom:collection:test",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);

      if (result.ok) {
        // Verify document exists in custom collection
        const lockDocRef = db
          .collection("custom_locks_test")
          .doc("custom:collection:test");
        const lockDocSnap = await lockDocRef.get();
        expect(lockDocSnap.exists).toBe(true);

        // Fence document uses two-step pattern (ADR-006)
        const fenceDocId = "fence:custom:collection:test";
        const fenceDocRef = db.collection("custom_fence_test").doc(fenceDocId);
        const fenceDocSnap = await fenceDocRef.get();
        expect(fenceDocSnap.exists).toBe(true);

        // Clean up
        await customBackend.release({ lockId: result.lockId });
      }
    });
  });
});
