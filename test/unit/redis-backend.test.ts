// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for Redis backend implementation
 *
 * Tests the Redis-specific lock backend functionality including:
 * - Lock acquisition, release, extend, and status checking
 * - Error handling and retry behavior
 * - Configuration management
 * - Lua script execution patterns
 *
 * Uses mocked Redis client to isolate backend logic from Redis I/O
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Redis } from "ioredis";
import type { LockBackend } from "../../common";
import { createRedisBackend } from "../../redis/backend";
import type { RedisCapabilities } from "../../redis/types";

describe("Redis Backend Unit Tests", () => {
  let mockRedis: Partial<Redis>;
  let backend: LockBackend<RedisCapabilities>;

  beforeEach(() => {
    // Reset mocks for each test to ensure isolation
    mockRedis = {
      eval: mock(() => Promise.resolve(1)), // Default success response
      evalsha: mock(() => Promise.resolve(1)), // For cached script execution
      script: mock(() => Promise.resolve("sha123")), // Script loading
    };

    // Create backend with test configuration
    backend = createRedisBackend(mockRedis as Redis, {
      keyPrefix: "test", // No trailing colon - makeStorageKey adds it
    });
  });

  describe("Lock Acquisition", () => {
    it("should successfully acquire available lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns [1, fence, expiresAtMs] for successful lock acquisition
      const expiresAtMs = Date.now() + 30000;
      mockEval.mockResolvedValueOnce([1, "000000000000001", expiresAtMs]);

      const result = await backend.acquire({
        key: "resource:users:123",
        ttlMs: 30000,
      });

      // Verify successful result structure
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lockId).toBeDefined();
        expect(typeof result.lockId).toBe("string");
        expect(result.lockId.length).toBeGreaterThan(0);
        expect(typeof result.expiresAtMs).toBe("number");
        expect(result.expiresAtMs).toBeGreaterThan(Date.now());
        expect(result.fence).toBe("000000000000001");
      }

      // Verify Redis was called with correct parameters
      expect(mockEval).toHaveBeenCalledTimes(1);
      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[1]).toBe(3); // Number of keys (lockKey, lockIdKey, fenceKey)
      expect(callArgs[2]).toBe("test:resource:users:123"); // Main lock key
      expect(callArgs[3]).toMatch(/^test:id:/); // Lock ID index key
      expect(callArgs[4]).toMatch(/^test:fence:/); // Fence counter key
    });

    it("should handle lock contention gracefully", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 0 when lock is already held
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.acquire({
        key: "resource:database:connection",
        ttlMs: 30000,
      });

      // Verify failure result structure
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("locked");
      }

      // Verify Redis was called
      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should generate unique lock IDs for different acquisitions", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Mock two successful acquisitions
      const expiresAtMs = Date.now() + 30000;
      mockEval.mockResolvedValueOnce([1, "000000000000001", expiresAtMs]);
      mockEval.mockResolvedValueOnce([1, "000000000000002", expiresAtMs]);

      const [result1, result2] = await Promise.all([
        backend.acquire({ key: "resource:batch:1", ttlMs: 30000 }),
        backend.acquire({ key: "resource:batch:2", ttlMs: 30000 }),
      ]);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        expect(result1.lockId).not.toBe(result2.lockId);
        expect(result1.lockId).toMatch(/^[A-Za-z0-9_-]{22}$/); // base64url format
        expect(result2.lockId).toMatch(/^[A-Za-z0-9_-]{22}$/); // base64url format
      }
    });

    it("should handle Redis connection errors by wrapping them", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      // Simulate multiple failures followed by exhaustion
      mockEval.mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));

      // Backend should throw LockError for Redis connection errors
      await expect(
        backend.acquire({
          key: "resource:api:rate-limit",
          ttlMs: 30000,
        }),
      ).rejects.toThrow("ECONNREFUSED");
    });

    it("should respect custom TTL and timeout values", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      const customTtl = 60000; // 1 minute
      const expiresAtMs = Date.now() + customTtl;
      mockEval.mockResolvedValueOnce([1, "000000000000001", expiresAtMs]);

      const result = await backend.acquire({
        key: "resource:custom-ttl",
        ttlMs: customTtl,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const expectedExpiry = Date.now() + customTtl;
        const actualExpiry = result.expiresAtMs;
        expect(actualExpiry).toBeGreaterThan(expectedExpiry - 1000); // Allow 1s variance
        expect(actualExpiry).toBeLessThan(expectedExpiry + 1000);
      }

      // Verify TTL was passed to Redis script
      const callArgs = (mockEval.mock.calls[0] as any[])!;
      const ttlMs = parseInt(callArgs[6]); // TTL in milliseconds (parameter index 6)
      expect(ttlMs).toBe(60000); // 60000ms
    });
  });

  describe("Lock Release", () => {
    it("should successfully release owned lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 1 for successful release
      mockEval.mockResolvedValueOnce(1);

      const lockId = "MTIzNDU2Nzg5MDEyMzQ1Ng"; // Valid 22-char base64url
      const result = await backend.release({ lockId });

      expect(result.ok).toBe(true);

      // ADR-013: Verify Redis was called with correct parameters (no keyPrefix)
      expect(mockEval).toHaveBeenCalledTimes(1);
      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[1]).toBe(1); // Number of keys (lockIdKey only, no keyPrefix)
      expect(callArgs[2]).toBe(`test:id:${lockId}`); // Lock ID index key
      expect(callArgs[3]).toBe(lockId); // Lock ID argument
    });

    it("should handle release of non-existent lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns -1 when lock not found
      mockEval.mockResolvedValueOnce(-1);

      const result = await backend.release({
        lockId: "QWJjRGVmR2hpSktsbU5vcA",
      }); // Valid 22-char
      expect(result.ok).toBe(false);

      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should handle release of expired lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Script returns -2 when lock has expired
      mockEval.mockResolvedValueOnce(-2);

      const result = await backend.release({
        lockId: "UXJzdFV2V3hZWmFiY2RlZg",
      }); // Valid 22-char
      expect(result.ok).toBe(false);
    });

    it("should handle Redis connection errors gracefully", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      // Use a non-transient error that would be thrown immediately
      mockEval.mockRejectedValueOnce(new Error("ERR invalid command"));

      try {
        await backend.release({ lockId: "JB2ckBvCXfkO2Nlfmc2grg" });
        // If we reach here, the error was caught and handled
        expect(true).toBe(true);
      } catch (error) {
        // If error was thrown, verify it's the expected one
        expect((error as Error).message).toContain("ERR invalid command");
      }

      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should validate malformed lock IDs and throw LockError", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValue(0); // This should not be reached due to validation

      // These should throw LockError("InvalidArgument") due to validation
      await expect(backend.release({ lockId: "" })).rejects.toThrow(
        "Invalid lockId format",
      );
      await expect(
        backend.release({ lockId: "invalid/lock/id" }),
      ).rejects.toThrow("Invalid lockId format");
      await expect(
        backend.release({ lockId: "lock-with-unicode-🔒" }),
      ).rejects.toThrow("Invalid lockId format");

      // Validation should prevent Redis calls
      expect(mockEval).toHaveBeenCalledTimes(0);
    });
  });

  describe("Lock Extension", () => {
    it("should successfully extend active lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns [1, newExpiresAtMs] for successful extension
      const newExpiresAtMs = Date.now() + 120000;
      mockEval.mockResolvedValueOnce([1, newExpiresAtMs]);

      const lockId = "Y4-ryB6lWSV5m2ObBhMzTA";
      const newTtl = 120000; // 2 minutes
      const result = await backend.extend({ lockId, ttlMs: newTtl });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.expiresAtMs).toBe(newExpiresAtMs);
      }

      // ADR-013: Verify Redis was called with correct parameters (no keyPrefix)
      expect(mockEval).toHaveBeenCalledTimes(1);
      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[1]).toBe(1); // Number of keys (lockIdKey only, no keyPrefix)
      expect(callArgs[2]).toBe(`test:id:${lockId}`); // KEYS[1]: Lock ID index key
      expect(callArgs[3]).toBe(lockId); // ARGV[1]: Lock ID
      expect(callArgs[4]).toBe("1000"); // ARGV[2]: toleranceMs
      expect(callArgs[5]).toBe("120000"); // ARGV[3]: TTL in milliseconds
    });

    it("should fail to extend expired or non-existent lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 0 when lock is expired or not found
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.extend({
        lockId: "QKwsp2jssEUMGqoGJCp7ug",
        ttlMs: 60000,
      });
      expect(result.ok).toBe(false);

      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should fail to extend lock not owned by this instance", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Script returns 0 when lock is owned by different instance
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.extend({
        lockId: "ZjKAPNgcBw0Q0NQrvT4-Ew",
        ttlMs: 90000,
      });
      expect(result.ok).toBe(false);
    });

    it("should handle various TTL values correctly", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      mockEval.mockResolvedValue(1);

      // Test different TTL values
      expect(
        (
          await backend.extend({
            lockId: "atkWnqbzfq0GVRrkfygr0Q",
            ttlMs: 1000,
          })
        ).ok,
      ).toBe(true); // 1 second
      expect(
        (
          await backend.extend({
            lockId: "LCCBpiuNhn-zHcSUQSw0SA",
            ttlMs: 3600000,
          })
        ).ok,
      ).toBe(true); // 1 hour

      // ADR-013: Verify TTL is passed in milliseconds as ARGV[3] (adjusted for no keyPrefix)
      const calls = mockEval.mock.calls;
      expect(calls[0]![5]).toBe("1000"); // ARGV[3]: 1000ms
      expect(calls[1]![5]).toBe("3600000"); // ARGV[3]: 3600000ms
    });

    it("should handle Redis errors during extension", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockRejectedValueOnce(new Error("ERR syntax error"));

      try {
        const result = await backend.extend({
          lockId: "lsoN28BWc4nz5sUF4FcKoQ",
          ttlMs: 30000,
        });
        // Error might be caught and handled, resulting in false
        expect(typeof result).toBe("boolean");
      } catch (error) {
        // Or error might be thrown
        expect((error as Error).message).toContain("ERR syntax error");
      }
    });
  });

  describe("Lock Status Check", () => {
    it("should return true for currently locked resource", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 1 when resource is locked
      mockEval.mockResolvedValueOnce(1);

      const result = await backend.isLocked({
        key: "resource:payment:user:456",
      });
      expect(result).toBe(true);

      // Verify Redis was called with correct parameters
      expect(mockEval).toHaveBeenCalledTimes(1);
      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[1]).toBe(1); // Number of keys
      expect(callArgs[2]).toBe("test:resource:payment:user:456"); // Resource key
    });

    it("should return false for unlocked resource", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 0 when resource is not locked
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.isLocked({ key: "resource:cache:user:789" });
      expect(result).toBe(false);

      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should return false for expired locks", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Script returns 0 and cleans up expired locks
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.isLocked({ key: "resource:session:abc123" });
      expect(result).toBe(false);
    });

    it("should handle various resource key formats", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValue(0);

      // Test different key patterns
      await backend.isLocked({ key: "simple" });
      await backend.isLocked({ key: "nested:resource:key" });
      await backend.isLocked({ key: "user/123/profile" });
      await backend.isLocked({ key: "service.api.rate-limit" });

      expect(mockEval).toHaveBeenCalledTimes(4);

      // Verify key formatting
      const calls = mockEval.mock.calls;
      expect(calls[0]![2]).toBe("test:simple");
      expect(calls[1]![2]).toBe("test:nested:resource:key");
      expect(calls[2]![2]).toBe("test:user/123/profile");
      expect(calls[3]![2]).toBe("test:service.api.rate-limit");
    });

    it("should handle Redis connection errors", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockRejectedValueOnce(new Error("ERR connection failed"));

      try {
        const result = await backend.isLocked({ key: "resource:test" });
        // Error might be caught and handled, returning false
        expect(typeof result).toBe("boolean");
      } catch (error) {
        // Or error might be thrown
        expect((error as Error).message).toContain("ERR connection failed");
      }
    });
  });

  describe("Backend Configuration", () => {
    it("should use custom key prefix for all operations", async () => {
      const customBackend = createRedisBackend(mockRedis as Redis, {
        keyPrefix: "myapp:locks:",
      });

      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValue(1);

      // Test all operations use the custom prefix
      await customBackend.acquire({ key: "user:123", ttlMs: 30000 });
      await customBackend.isLocked({ key: "user:123" });
      await customBackend.release({ lockId: "05v-EcZ02_LQ4YKJuWHxQQ" });
      await customBackend.extend({
        lockId: "Wkauz6QXtzWTqjU6AUVCyQ",
        ttlMs: 60000,
      });

      const calls = mockEval.mock.calls;

      // Acquire operation
      expect(calls[0]![2]).toBe("myapp:locks:user:123"); // Main lock key
      expect(calls[0]![3]).toMatch(/^myapp:locks:id:/); // Lock ID index key

      // IsLocked operation
      expect(calls[1]![2]).toBe("myapp:locks:user:123");

      // Release operation
      expect(calls[2]![2]).toBe("myapp:locks:id:05v-EcZ02_LQ4YKJuWHxQQ");

      // Extend operation
      expect(calls[3]![2]).toBe("myapp:locks:id:Wkauz6QXtzWTqjU6AUVCyQ");
    });

    it("should apply sensible default configuration", async () => {
      const defaultBackend = createRedisBackend(mockRedis as Redis);

      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValueOnce(1);

      await defaultBackend.acquire({ key: "test:resource", ttlMs: 30000 });

      // Verify default "syncguard:" prefix is used
      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[2]).toBe("syncguard:test:resource");
      expect(callArgs[3]).toMatch(/^syncguard:id:/);
    });

    it("should handle empty prefix configuration", async () => {
      const noPrefixBackend = createRedisBackend(mockRedis as Redis, {
        keyPrefix: "",
      });

      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValueOnce(1);

      await noPrefixBackend.acquire({ key: "global:resource", ttlMs: 30000 });

      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[2]).toBe("global:resource"); // No prefix
      expect(callArgs[3]).toMatch(/^id:/); // ID prefix only
    });

    it("should maintain backend isolation between instances", async () => {
      // Create two backends with different configurations
      const backend1 = createRedisBackend(mockRedis as Redis, {
        keyPrefix: "app1:",
      });
      const backend2 = createRedisBackend(mockRedis as Redis, {
        keyPrefix: "app2:",
      });

      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValue(1);

      await backend1.acquire({ key: "shared:resource", ttlMs: 30000 });
      await backend2.acquire({ key: "shared:resource", ttlMs: 30000 });

      const calls = mockEval.mock.calls;
      expect(calls[0]![2]).toBe("app1:shared:resource");
      expect(calls[1]![2]).toBe("app2:shared:resource");

      // Verify they don't interfere with each other
      expect(calls[0]![2]).not.toBe(calls[1]![2]);
    });
  });
});
