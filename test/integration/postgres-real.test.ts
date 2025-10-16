// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Integration tests for PostgreSQL backend with real PostgreSQL instance
 *
 * These tests verify:
 * - End-to-end functionality with actual PostgreSQL
 * - Transaction atomicity and isolation
 * - Fence token monotonicity
 * - Real-world concurrency scenarios
 * - Server-side time authority
 *
 * Requires PostgreSQL server at postgres://postgres@localhost:5432/syncguard
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { Sql } from "postgres";
import postgres from "postgres";
import type { LockBackend } from "../../common/backend.js";
import { createPostgresBackend } from "../../postgres/backend.js";
import type { PostgresCapabilities } from "../../postgres/types.js";

describe("PostgreSQL Integration Tests", () => {
  let sql: Sql;
  let backend: LockBackend<PostgresCapabilities>;
  const testTablePrefix = "test_";

  beforeAll(async () => {
    // Connect to PostgreSQL (use env var or default)
    const dbUrl =
      process.env.POSTGRES_URL ||
      "postgres://postgres@localhost:5432/syncguard";

    sql = postgres(dbUrl, {
      max: 10, // Connection pool size
    });

    // Verify PostgreSQL connection
    try {
      await sql`SELECT 1 as ok`;
      console.log("✅ Connected to PostgreSQL for integration tests");
    } catch (error) {
      console.error("❌ Failed to connect to PostgreSQL:", error);
      throw new Error(
        "PostgreSQL integration tests require a PostgreSQL server. " +
          "Ensure postgres://postgres@localhost:5432/syncguard is accessible.",
      );
    }

    // Create backend with test-specific table names
    backend = await createPostgresBackend(sql, {
      tableName: `${testTablePrefix}syncguard_locks`,
      fenceTableName: `${testTablePrefix}syncguard_fence_counters`,
      autoCreateTables: true,
    });
  });

  afterAll(async () => {
    if (sql) {
      await sql.end();
    }
  });

  beforeEach(async () => {
    // Clean up test tables before each test
    await sql.unsafe(`DELETE FROM ${testTablePrefix}syncguard_locks`);
    await sql.unsafe(`DELETE FROM ${testTablePrefix}syncguard_fence_counters`);
  });

  describe("Basic Lock Operations", () => {
    it("should acquire and release locks properly", async () => {
      const result = await backend.acquire({
        key: "integration:acquire-release",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Verify lock exists in database
        const rows = await sql`
          SELECT * FROM ${sql(testTablePrefix + "syncguard_locks")}
          WHERE lock_id = ${result.lockId}
        `;
        expect(rows).toHaveLength(1);

        // Release the lock
        const released = await backend.release({ lockId: result.lockId });
        expect(released.ok).toBe(true);

        // Verify lock is gone from database
        const rowsAfter = await sql`
          SELECT * FROM ${sql(testTablePrefix + "syncguard_locks")}
          WHERE lock_id = ${result.lockId}
        `;
        expect(rowsAfter).toHaveLength(0);
      }
    });

    it("should acquire locks with fence tokens", async () => {
      const result = await backend.acquire({
        key: "integration:basic:lock",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.lockId).toBe("string");
        expect(result.lockId).toHaveLength(22); // base64url encoded 16 bytes
        expect(typeof result.expiresAtMs).toBe("number");
        expect(result.expiresAtMs).toBeGreaterThan(Date.now());
        expect(typeof result.fence).toBe("string");
        expect(result.fence).toHaveLength(15); // 15-digit zero-padded
        expect(result.fence).toMatch(/^\d{15}$/);

        // Verify first fence token
        expect(result.fence).toBe("000000000000001");
      }
    });

    it("should store lock data correctly in database", async () => {
      const result = await backend.acquire({
        key: "integration:data:verification",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Query database directly to verify storage
        const rows = await sql`
          SELECT * FROM ${sql(testTablePrefix + "syncguard_locks")}
          WHERE lock_id = ${result.lockId}
        `;

        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row).toBeDefined();
        if (row) {
          expect(row.lock_id).toBe(result.lockId);
          expect(row.user_key).toBe("integration:data:verification");
          expect(Number(row.expires_at_ms)).toBe(result.expiresAtMs);
          expect(row.fence).toBe(result.fence);
        }
      }
    });

    it("should handle lock contention correctly", async () => {
      // Acquire first lock
      const lock1 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock1.ok).toBe(true);

      // Try to acquire same resource - should fail with contention
      const lock2 = await backend.acquire({
        key: "integration:contention:resource",
        ttlMs: 5000,
      });
      expect(lock2.ok).toBe(false);
      if (!lock2.ok) {
        expect(lock2.reason).toBe("locked");
      }

      // Different key should succeed
      const lock3 = await backend.acquire({
        key: "integration:contention:different",
        ttlMs: 5000,
      });
      expect(lock3.ok).toBe(true);
    });
  });

  describe("Fence Token Monotonicity", () => {
    it("should generate strictly increasing fence tokens", async () => {
      const key = "integration:fence:monotonic";
      const fences: string[] = [];

      // Acquire and release 5 times
      for (let i = 0; i < 5; i++) {
        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          fences.push(result.fence);

          // Release properly using the release operation
          const released = await backend.release({ lockId: result.lockId });
          expect(released.ok).toBe(true);
        }
      }

      // Verify monotonicity
      expect(fences).toHaveLength(5);
      expect(fences[0]).toBe("000000000000001");
      expect(fences[1]).toBe("000000000000002");
      expect(fences[2]).toBe("000000000000003");
      expect(fences[3]).toBe("000000000000004");
      expect(fences[4]).toBe("000000000000005");

      // Verify lexicographic ordering
      for (let i = 1; i < fences.length; i++) {
        const current = fences[i];
        const previous = fences[i - 1];
        if (current && previous) {
          expect(current > previous).toBe(true);
        }
      }
    });

    it("should maintain separate fence counters per key", async () => {
      const key1 = "integration:fence:key1";
      const key2 = "integration:fence:key2";

      const lock1a = await backend.acquire({ key: key1, ttlMs: 30000 });
      const lock2a = await backend.acquire({ key: key2, ttlMs: 30000 });

      expect(lock1a.ok && lock2a.ok).toBe(true);

      if (lock1a.ok && lock2a.ok) {
        // Both should start at fence 1
        expect(lock1a.fence).toBe("000000000000001");
        expect(lock2a.fence).toBe("000000000000001");

        // Release both
        await backend.release({ lockId: lock1a.lockId });
        await backend.release({ lockId: lock2a.lockId });

        // Acquire again
        const lock1b = await backend.acquire({ key: key1, ttlMs: 30000 });
        const lock2b = await backend.acquire({ key: key2, ttlMs: 30000 });

        if (lock1b.ok && lock2b.ok) {
          // Each should increment independently
          expect(lock1b.fence).toBe("000000000000002");
          expect(lock2b.fence).toBe("000000000000002");
        }
      }
    });

    it("should persist fence counters across lock releases", async () => {
      const key = "integration:fence:persistence";

      // Acquire, release, acquire again
      const lock1 = await backend.acquire({ key, ttlMs: 30000 });
      expect(lock1.ok && lock1.fence).toBe("000000000000001");

      if (lock1.ok) {
        await backend.release({ lockId: lock1.lockId });
      }

      const lock2 = await backend.acquire({ key, ttlMs: 30000 });
      expect(lock2.ok && lock2.fence).toBe("000000000000002");

      // Verify fence counter still exists in database
      const fenceRows = await sql`
        SELECT fence FROM ${sql(testTablePrefix + "syncguard_fence_counters")}
        WHERE fence_key LIKE ${"fence:%"}
      `;
      expect(fenceRows.length).toBeGreaterThan(0);
    });

    it("should prevent absent-row race when multiple clients acquire simultaneously", async () => {
      // CRITICAL: This test verifies the two-step fence increment pattern
      // prevents duplicate fence=1 when fence counter row doesn't exist yet
      const key = "integration:fence:absent-row-race";
      const concurrentAttempts = 10;

      // Launch multiple concurrent acquire attempts on fresh key (no fence counter yet)
      const promises = Array.from({ length: concurrentAttempts }, () =>
        backend.acquire({ key, ttlMs: 30000 }),
      );

      const results = await Promise.all(promises);

      // Exactly one should succeed (the rest hit lock contention)
      const successful = results.filter((r) => r.ok);
      expect(successful).toHaveLength(1);

      // Winner should get fence=1 (first fence for this key)
      const winner = successful[0];
      if (winner && winner.ok) {
        expect(winner.fence).toBe("000000000000001");

        // Release and acquire again to verify monotonicity
        await backend.release({ lockId: winner.lockId });

        const secondAcquire = await backend.acquire({ key, ttlMs: 30000 });
        expect(secondAcquire.ok).toBe(true);
        if (secondAcquire.ok) {
          expect(secondAcquire.fence).toBe("000000000000002");
          await backend.release({ lockId: secondAcquire.lockId });
        }
      }

      // Verify fence counter exists and has correct value
      const fenceRows = await sql`
        SELECT fence FROM ${sql(testTablePrefix + "syncguard_fence_counters")}
        WHERE key_debug = ${key}
      `;
      expect(fenceRows).toHaveLength(1);
      const fenceRow = fenceRows[0];
      expect(fenceRow).toBeDefined();
      if (fenceRow) {
        expect(Number(fenceRow.fence)).toBe(2); // Two successful acquires
      }
    });
  });

  describe("Transaction Atomicity", () => {
    it("should prevent race conditions in concurrent acquires", async () => {
      const key = "integration:atomic:race";
      const concurrentAttempts = 5;

      // Launch multiple concurrent acquire attempts
      const promises = Array.from({ length: concurrentAttempts }, () =>
        backend.acquire({ key, ttlMs: 5000 }),
      );

      const results = await Promise.all(promises);

      // Exactly one should succeed
      const successful = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(concurrentAttempts - 1);

      // Verify failed attempts have correct reason
      failed.forEach((result) => {
        if (!result.ok) {
          expect(result.reason).toBe("locked");
        }
      });

      // Verify only one lock exists in database
      const rows = await sql`
        SELECT * FROM ${sql(testTablePrefix + "syncguard_locks")}
        WHERE user_key = ${key}
      `;
      expect(rows).toHaveLength(1);
    });

    it("should handle expired lock overwrite atomically", async () => {
      const key = "integration:atomic:expired";

      // Acquire with very short TTL
      const lock1 = await backend.acquire({ key, ttlMs: 100 });
      expect(lock1.ok).toBe(true);

      if (lock1.ok) {
        const fence1 = lock1.fence;

        // Wait for expiry + tolerance (TIME_TOLERANCE_MS = 1000ms)
        // Lock expires at T+100ms, but isLive() considers it live until T+1100ms
        await new Promise((resolve) => setTimeout(resolve, 1200));

        // Acquire again - should overwrite expired lock
        const lock2 = await backend.acquire({ key, ttlMs: 30000 });
        expect(lock2.ok).toBe(true);

        if (lock2.ok) {
          const fence2 = lock2.fence;

          // Fence should increment
          expect(Number(fence2)).toBe(Number(fence1) + 1);

          // Verify only one lock in database
          const rows = await sql`
            SELECT * FROM ${sql(testTablePrefix + "syncguard_locks")}
            WHERE user_key = ${key}
          `;
          expect(rows).toHaveLength(1);
          const row = rows[0];
          expect(row).toBeDefined();
          if (row) {
            expect(row.lock_id).toBe(lock2.lockId);
            expect(row.fence).toBe(fence2);
          }
        }
      }
    });
  });

  describe("Server-Side Time Authority", () => {
    it("should use PostgreSQL server time for expiresAtMs", async () => {
      const clientTimeBefore = Date.now();

      const result = await backend.acquire({
        key: "integration:time:server",
        ttlMs: 10000,
      });

      const clientTimeAfter = Date.now();

      expect(result.ok).toBe(true);
      if (result.ok) {
        // expiresAtMs should be server time + ttlMs
        const expectedExpiry = result.expiresAtMs - 10000;

        // Server time should be close to client time (within 1 second tolerance)
        expect(expectedExpiry).toBeGreaterThanOrEqual(clientTimeBefore - 1000);
        expect(expectedExpiry).toBeLessThanOrEqual(clientTimeAfter + 1000);

        // Verify stored timestamp matches
        const rows = await sql`
          SELECT expires_at_ms, acquired_at_ms
          FROM ${sql(testTablePrefix + "syncguard_locks")}
          WHERE lock_id = ${result.lockId}
        `;

        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row).toBeDefined();
        if (row) {
          expect(Number(row.expires_at_ms)).toBe(result.expiresAtMs);
        }
      }
    });
  });

  describe("Error Handling", () => {
    it("should throw InvalidArgument for invalid ttlMs", async () => {
      await expect(backend.acquire({ key: "test", ttlMs: -1 })).rejects.toThrow(
        "ttlMs must be a positive integer",
      );

      await expect(backend.acquire({ key: "test", ttlMs: 0 })).rejects.toThrow(
        "ttlMs must be a positive integer",
      );

      await expect(
        backend.acquire({ key: "test", ttlMs: 1.5 }),
      ).rejects.toThrow("ttlMs must be a positive integer");
    });

    it("should throw InvalidArgument for invalid keys", async () => {
      await expect(
        backend.acquire({ key: "", ttlMs: 30000 }),
      ).rejects.toThrow();

      // Key too long (> 512 bytes)
      const longKey = "x".repeat(600);
      await expect(
        backend.acquire({ key: longKey, ttlMs: 30000 }),
      ).rejects.toThrow();
    });
  });

  describe("Extend Operation", () => {
    it("should extend lock TTL successfully", async () => {
      const result = await backend.acquire({
        key: "integration:extend:basic",
        ttlMs: 5000, // 5 seconds
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Extend the lock
        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 10000, // 10 seconds
        });

        expect(extended.ok).toBe(true);
        if (extended.ok) {
          // New expiry should be ~10 seconds from now
          const expectedExpiry = Date.now() + 10000;
          expect(Math.abs(extended.expiresAtMs - expectedExpiry)).toBeLessThan(
            1000,
          ); // Within 1 second

          // Verify in database
          const rows = await sql`
            SELECT expires_at_ms FROM ${sql(testTablePrefix + "syncguard_locks")}
            WHERE lock_id = ${result.lockId}
          `;
          expect(rows).toHaveLength(1);
          const row = rows[0];
          expect(row).toBeDefined();
          if (row) {
            expect(Number(row.expires_at_ms)).toBe(extended.expiresAtMs);
          }
        }

        // Clean up
        await backend.release({ lockId: result.lockId });
      }
    });

    it("should fail to extend non-existent lock", async () => {
      const fakeLockId = "C".repeat(22); // Valid format but doesn't exist
      const result = await backend.extend({ lockId: fakeLockId, ttlMs: 5000 });
      expect(result.ok).toBe(false);
    });

    it("should fail to extend with invalid lockId format", async () => {
      await expect(backend.extend({ lockId: "", ttlMs: 5000 })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(
        backend.extend({ lockId: "invalid", ttlMs: 5000 }),
      ).rejects.toThrow("Invalid lockId format");
    });

    it("should fail to extend with invalid ttlMs", async () => {
      const result = await backend.acquire({
        key: "integration:extend:invalid-ttl",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(
          backend.extend({ lockId: result.lockId, ttlMs: -1 }),
        ).rejects.toThrow("ttlMs must be a positive integer");
        expect(
          backend.extend({ lockId: result.lockId, ttlMs: 0 }),
        ).rejects.toThrow("ttlMs must be a positive integer");
        expect(
          backend.extend({ lockId: result.lockId, ttlMs: 1.5 }),
        ).rejects.toThrow("ttlMs must be a positive integer");

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should fail to extend expired lock", async () => {
      const result = await backend.acquire({
        key: "integration:extend:expired",
        ttlMs: 100,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Wait for lock to expire (+ tolerance)
        await new Promise((resolve) => setTimeout(resolve, 1200));

        // Try to extend - should fail because lock expired
        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 10000,
        });
        expect(extended.ok).toBe(false);
      }
    });

    it("should verify ownership before extending", async () => {
      const lock1 = await backend.acquire({
        key: "integration:extend:ownership",
        ttlMs: 30000,
      });

      expect(lock1.ok).toBe(true);
      if (lock1.ok) {
        // Try to extend with wrong lockId (but valid format)
        const fakeLockId = "D".repeat(22);
        const extended = await backend.extend({
          lockId: fakeLockId,
          ttlMs: 10000,
        });
        expect(extended.ok).toBe(false);

        // Original lock should still have original expiry
        const rows = await sql`
          SELECT expires_at_ms FROM ${sql(testTablePrefix + "syncguard_locks")}
          WHERE lock_id = ${lock1.lockId}
        `;
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row).toBeDefined();
        if (row) {
          expect(Number(row.expires_at_ms)).toBe(lock1.expiresAtMs);
        }

        // Proper extend should work
        const properExtend = await backend.extend({
          lockId: lock1.lockId,
          ttlMs: 15000,
        });
        expect(properExtend.ok).toBe(true);

        await backend.release({ lockId: lock1.lockId });
      }
    });

    it("should use server time for authoritative expiresAtMs", async () => {
      const result = await backend.acquire({
        key: "integration:extend:server-time",
        ttlMs: 5000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const clientTimeBefore = Date.now();

        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 10000,
        });

        const clientTimeAfter = Date.now();

        expect(extended.ok).toBe(true);
        if (extended.ok) {
          // expiresAtMs should be server time + 10000
          const expectedExpiry = extended.expiresAtMs - 10000;

          // Server time should be close to client time (within 1 second tolerance)
          expect(expectedExpiry).toBeGreaterThanOrEqual(
            clientTimeBefore - 1000,
          );
          expect(expectedExpiry).toBeLessThanOrEqual(clientTimeAfter + 1000);
        }

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should replace TTL entirely (not additive)", async () => {
      const result = await backend.acquire({
        key: "integration:extend:ttl-replacement",
        ttlMs: 5000, // 5 seconds
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Wait 2 seconds (3 seconds remaining)
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Extend with 10 seconds (should be 10 seconds from now, NOT 13 seconds)
        const extended = await backend.extend({
          lockId: result.lockId,
          ttlMs: 10000,
        });

        expect(extended.ok).toBe(true);
        if (extended.ok) {
          // New expiry should be ~10 seconds from now (not 13)
          const expectedExpiry = Date.now() + 10000;
          const timeDiff = Math.abs(extended.expiresAtMs - expectedExpiry);
          expect(timeDiff).toBeLessThan(1000); // Within 1 second

          // Should definitely NOT be 13 seconds from now
          const notExpectedExpiry = Date.now() + 13000;
          expect(
            Math.abs(extended.expiresAtMs - notExpectedExpiry),
          ).toBeGreaterThan(2000);
        }

        await backend.release({ lockId: result.lockId });
      }
    });
  });

  describe("IsLocked Operation", () => {
    it("should return true for live locks", async () => {
      const result = await backend.acquire({
        key: "integration:islocked:live",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isLocked = await backend.isLocked({
          key: "integration:islocked:live",
        });
        expect(isLocked).toBe(true);

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should return false for non-existent locks", async () => {
      const isLocked = await backend.isLocked({
        key: "integration:islocked:nonexistent",
      });
      expect(isLocked).toBe(false);
    });

    it("should return false for released locks", async () => {
      const result = await backend.acquire({
        key: "integration:islocked:released",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        await backend.release({ lockId: result.lockId });

        const isLocked = await backend.isLocked({
          key: "integration:islocked:released",
        });
        expect(isLocked).toBe(false);
      }
    });

    it("should return false for expired locks", async () => {
      const result = await backend.acquire({
        key: "integration:islocked:expired",
        ttlMs: 100,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Wait for lock to expire (+ tolerance)
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const isLocked = await backend.isLocked({
          key: "integration:islocked:expired",
        });
        expect(isLocked).toBe(false);
      }
    });

    it("should throw on invalid key", async () => {
      await expect(backend.isLocked({ key: "" })).rejects.toThrow();

      // Key too long (> 512 bytes)
      const longKey = "x".repeat(600);
      await expect(backend.isLocked({ key: longKey })).rejects.toThrow();
    });

    it("should be read-only by default (no side effects)", async () => {
      const result = await backend.acquire({
        key: "integration:islocked:readonly",
        ttlMs: 100,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Wait for lock to expire
        await new Promise((resolve) => setTimeout(resolve, 1200));

        // Check isLocked (default: no cleanup)
        const isLocked = await backend.isLocked({
          key: "integration:islocked:readonly",
        });
        expect(isLocked).toBe(false);

        // Lock should still exist in database (not cleaned up)
        const rows = await sql`
          SELECT * FROM ${sql(testTablePrefix + "syncguard_locks")}
          WHERE lock_id = ${result.lockId}
        `;
        expect(rows).toHaveLength(1); // Still in DB
      }
    });
  });

  describe("Release Operation", () => {
    it("should fail to release non-existent lock", async () => {
      const fakeLockId = "A".repeat(22); // Valid format but doesn't exist
      const result = await backend.release({ lockId: fakeLockId });
      expect(result.ok).toBe(false);
    });

    it("should fail to release with invalid lockId format", async () => {
      await expect(backend.release({ lockId: "" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(backend.release({ lockId: "invalid" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(backend.release({ lockId: "too-short" })).rejects.toThrow(
        "Invalid lockId format",
      );
    });

    it("should fail to release expired lock", async () => {
      const result = await backend.acquire({
        key: "integration:release:expired",
        ttlMs: 100,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Wait for lock to expire (+ tolerance)
        await new Promise((resolve) => setTimeout(resolve, 1200));

        // Try to release - should fail because lock expired
        const released = await backend.release({ lockId: result.lockId });
        expect(released.ok).toBe(false);
      }
    });

    it("should be idempotent (releasing twice)", async () => {
      const result = await backend.acquire({
        key: "integration:release:idempotent",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // First release should succeed
        const released1 = await backend.release({ lockId: result.lockId });
        expect(released1.ok).toBe(true);

        // Second release should fail (lock already gone)
        const released2 = await backend.release({ lockId: result.lockId });
        expect(released2.ok).toBe(false);
      }
    });

    it("should verify ownership before releasing", async () => {
      const lock1 = await backend.acquire({
        key: "integration:release:ownership",
        ttlMs: 30000,
      });

      expect(lock1.ok).toBe(true);
      if (lock1.ok) {
        // Try to release with wrong lockId (but valid format)
        const fakeLockId = "B".repeat(22);
        const released = await backend.release({ lockId: fakeLockId });
        expect(released.ok).toBe(false);

        // Original lock should still exist
        const rows = await sql`
          SELECT * FROM ${sql(testTablePrefix + "syncguard_locks")}
          WHERE lock_id = ${lock1.lockId}
        `;
        expect(rows).toHaveLength(1);

        // Proper release should work
        const properRelease = await backend.release({ lockId: lock1.lockId });
        expect(properRelease.ok).toBe(true);
      }
    });
  });

  describe("Lookup Operation", () => {
    it("should lookup lock by key", async () => {
      const result = await backend.acquire({
        key: "integration:lookup:by-key",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const lockInfo = await backend.lookup({
          key: "integration:lookup:by-key",
        });

        expect(lockInfo).not.toBeNull();
        if (lockInfo) {
          expect(typeof lockInfo.keyHash).toBe("string");
          expect(typeof lockInfo.lockIdHash).toBe("string");
          expect(typeof lockInfo.expiresAtMs).toBe("number");
          expect(typeof lockInfo.acquiredAtMs).toBe("number");
          expect(typeof lockInfo.fence).toBe("string");
          expect(lockInfo.fence).toMatch(/^\d{15}$/);

          // Should match fence from acquire
          expect(lockInfo.fence).toBe(result.fence);
        }

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should lookup lock by lockId", async () => {
      const result = await backend.acquire({
        key: "integration:lookup:by-lockid",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const lockInfo = await backend.lookup({
          lockId: result.lockId,
        });

        expect(lockInfo).not.toBeNull();
        if (lockInfo) {
          expect(typeof lockInfo.keyHash).toBe("string");
          expect(typeof lockInfo.lockIdHash).toBe("string");
          expect(typeof lockInfo.expiresAtMs).toBe("number");
          expect(typeof lockInfo.acquiredAtMs).toBe("number");
          expect(typeof lockInfo.fence).toBe("string");

          // Verify ownership match
          expect(lockInfo.expiresAtMs).toBe(result.expiresAtMs);
          expect(lockInfo.fence).toBe(result.fence);
        }

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should return null for non-existent key", async () => {
      const lockInfo = await backend.lookup({
        key: "integration:lookup:nonexistent",
      });
      expect(lockInfo).toBeNull();
    });

    it("should return null for non-existent lockId", async () => {
      const fakeLockId = "E".repeat(22);
      const lockInfo = await backend.lookup({
        lockId: fakeLockId,
      });
      expect(lockInfo).toBeNull();
    });

    it("should return null for expired locks", async () => {
      const result = await backend.acquire({
        key: "integration:lookup:expired",
        ttlMs: 100,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Wait for lock to expire
        await new Promise((resolve) => setTimeout(resolve, 1200));

        // Lookup by key
        const lockInfoByKey = await backend.lookup({
          key: "integration:lookup:expired",
        });
        expect(lockInfoByKey).toBeNull();

        // Lookup by lockId
        const lockInfoByLockId = await backend.lookup({
          lockId: result.lockId,
        });
        expect(lockInfoByLockId).toBeNull();
      }
    });

    it("should throw on invalid key format", async () => {
      await expect(backend.lookup({ key: "" })).rejects.toThrow();

      const longKey = "x".repeat(600);
      await expect(backend.lookup({ key: longKey })).rejects.toThrow();
    });

    it("should throw on invalid lockId format", async () => {
      await expect(backend.lookup({ lockId: "" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(backend.lookup({ lockId: "invalid" })).rejects.toThrow(
        "Invalid lockId format",
      );
    });

    it("should sanitize returned data (hashed keys)", async () => {
      const result = await backend.acquire({
        key: "integration:lookup:sanitize",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const lockInfo = await backend.lookup({
          key: "integration:lookup:sanitize",
        });

        expect(lockInfo).not.toBeNull();
        if (lockInfo) {
          // Should have hashed keys (not raw values) - 24 hex chars (96 bits)
          expect(lockInfo.keyHash).toMatch(/^[0-9a-f]{24}$/);
          expect(lockInfo.lockIdHash).toMatch(/^[0-9a-f]{24}$/);

          // Should NOT have raw key/lockId in public interface
          expect((lockInfo as any).key).toBeUndefined();
          expect((lockInfo as any).lockId).toBeUndefined();
        }

        await backend.release({ lockId: result.lockId });
      }
    });

    it("should include fence token in lookup results", async () => {
      const key = "integration:lookup:fence";

      // Acquire multiple times to increment fence
      const lock1 = await backend.acquire({ key, ttlMs: 30000 });
      expect(lock1.ok).toBe(true);
      if (lock1.ok) {
        await backend.release({ lockId: lock1.lockId });
      }

      const lock2 = await backend.acquire({ key, ttlMs: 30000 });
      expect(lock2.ok).toBe(true);
      if (lock2.ok) {
        const lockInfo = await backend.lookup({ key });
        expect(lockInfo).not.toBeNull();
        if (lockInfo) {
          expect(lockInfo.fence).toBe(lock2.fence);
          expect(lockInfo.fence).toBe("000000000000002"); // Second fence
        }

        await backend.release({ lockId: lock2.lockId });
      }
    });
  });

  describe("Performance Characteristics", () => {
    it("should complete acquire operations in reasonable time", async () => {
      const iterations = 10;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        const result = await backend.acquire({
          key: `integration:perf:${i}`,
          ttlMs: 30000,
        });
        expect(result.ok).toBe(true);
      }

      const elapsed = Date.now() - startTime;
      const avgLatency = elapsed / iterations;

      console.log(
        `Average acquire latency: ${avgLatency.toFixed(2)}ms (${iterations} operations in ${elapsed}ms)`,
      );

      // Should average less than 100ms per operation (local PostgreSQL)
      expect(avgLatency).toBeLessThan(100);
    });
  });
});
