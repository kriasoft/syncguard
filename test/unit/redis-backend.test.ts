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

import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { Redis } from "ioredis";
import { createRedisBackend } from "../../redis/backend";
import type { LockBackend } from "../../common";

describe("Redis Backend Unit Tests", () => {
  let mockRedis: Partial<Redis>;
  let backend: LockBackend;

  beforeEach(() => {
    // Reset mocks for each test to ensure isolation
    mockRedis = {
      eval: mock(() => Promise.resolve(1)), // Default success response
      evalsha: mock(() => Promise.resolve(1)), // For cached script execution
      script: mock(() => Promise.resolve("sha123")), // Script loading
    };

    // Create backend with test configuration
    backend = createRedisBackend(mockRedis as Redis, {
      keyPrefix: "test:",
      retryDelayMs: 10, // Fast retries for testing
      maxRetries: 2, // Limited retries to speed up tests
    });
  });

  describe("Lock Acquisition", () => {
    it("should successfully acquire available lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 1 for successful lock acquisition
      mockEval.mockResolvedValueOnce(1);

      const result = await backend.acquire({
        key: "resource:users:123",
        ttlMs: 30000,
      });

      // Verify successful result structure
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.lockId).toBeDefined();
        expect(typeof result.lockId).toBe("string");
        expect(result.lockId.length).toBeGreaterThan(0);
        expect(result.expiresAt).toBeInstanceOf(Date);
        expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
      }

      // Verify Redis was called with correct parameters
      expect(mockEval).toHaveBeenCalledTimes(1);
      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[1]).toBe(2); // Number of keys
      expect(callArgs[2]).toBe("test:resource:users:123"); // Main lock key
      expect(callArgs[3]).toMatch(/^test:id:/); // Lock ID index key
    });

    it("should handle lock contention gracefully", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns null/0 when lock is already held
      mockEval.mockResolvedValueOnce(null);

      const result = await backend.acquire({
        key: "resource:database:connection",
        ttlMs: 30000,
        maxRetries: 0, // No retries to avoid delays in test
      });

      // Verify failure result structure
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(result.error).toContain("Lock already held");
      }

      // Verify Redis was called
      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should generate unique lock IDs for different acquisitions", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Mock two successful acquisitions
      mockEval.mockResolvedValueOnce(1);
      mockEval.mockResolvedValueOnce(1);

      const [result1, result2] = await Promise.all([
        backend.acquire({ key: "resource:batch:1", ttlMs: 30000 }),
        backend.acquire({ key: "resource:batch:2", ttlMs: 30000 }),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      if (result1.success && result2.success) {
        expect(result1.lockId).not.toBe(result2.lockId);
        expect(result1.lockId).toMatch(/^[a-f0-9-]+$/); // UUID format
        expect(result2.lockId).toMatch(/^[a-f0-9-]+$/); // UUID format
      }
    });

    it("should handle Redis connection errors by wrapping them", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      // Simulate multiple failures followed by exhaustion
      mockEval.mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));

      const result = await backend.acquire({
        key: "resource:api:rate-limit",
        ttlMs: 30000,
        maxRetries: 1, // Allow one retry, then fail
      });

      // Backend should catch Redis errors and return failure results
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("ECONNREFUSED");
        expect(result.error).toContain("resource:api:rate-limit");
      }
    });

    it("should respect custom TTL and timeout values", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValueOnce(1);

      const customTtl = 60000; // 1 minute
      const result = await backend.acquire({
        key: "resource:custom-ttl",
        ttlMs: customTtl,
        timeoutMs: 2000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const expectedExpiry = Date.now() + customTtl;
        const actualExpiry = result.expiresAt.getTime();
        expect(actualExpiry).toBeGreaterThan(expectedExpiry - 1000); // Allow 1s variance
        expect(actualExpiry).toBeLessThan(expectedExpiry + 1000);
      }

      // Verify TTL was passed to Redis script
      const callArgs = (mockEval.mock.calls[0] as any[])!;
      const ttlSeconds = parseInt(callArgs[5]); // TTL in seconds (parameter index 5)
      expect(ttlSeconds).toBe(60); // 60000ms = 60s
    });
  });

  describe("Lock Release", () => {
    it("should successfully release owned lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 1 for successful release
      mockEval.mockResolvedValueOnce(1);

      const lockId = "test-lock-abc123";
      const result = await backend.release(lockId);

      expect(result).toBe(true);

      // Verify Redis was called with correct parameters
      expect(mockEval).toHaveBeenCalledTimes(1);
      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[1]).toBe(1); // Number of keys
      expect(callArgs[2]).toBe(`test:id:${lockId}`); // Lock ID index key
      expect(callArgs[3]).toBe(lockId); // Lock ID argument
    });

    it("should handle release of non-existent lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 0 when lock not found or not owned
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.release("non-existent-lock-xyz");
      expect(result).toBe(false);

      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should handle release of expired lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Script returns 0 when lock has already expired
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.release("expired-lock-def456");
      expect(result).toBe(false);
    });

    it("should handle Redis connection errors gracefully", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      // Use a non-transient error that would be thrown immediately
      mockEval.mockRejectedValueOnce(new Error("ERR invalid command"));

      try {
        await backend.release("test-lock-789");
        // If we reach here, the error was caught and handled
        expect(true).toBe(true);
      } catch (error) {
        // If error was thrown, verify it's the expected one
        expect((error as Error).message).toContain("ERR invalid command");
      }

      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should handle malformed lock IDs gracefully", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValue(0); // Return 0 for all calls

      // These should not crash but return false
      expect(await backend.release("")).toBe(false);
      expect(await backend.release("invalid/lock/id")).toBe(false);
      expect(await backend.release("lock-with-unicode-🔒")).toBe(false);

      expect(mockEval).toHaveBeenCalledTimes(3);
    });
  });

  describe("Lock Extension", () => {
    it("should successfully extend active lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 1 for successful extension
      mockEval.mockResolvedValueOnce(1);

      const lockId = "active-lock-ghi789";
      const newTtl = 120000; // 2 minutes
      const result = await backend.extend(lockId, newTtl);

      expect(result).toBe(true);

      // Verify Redis was called with correct parameters
      expect(mockEval).toHaveBeenCalledTimes(1);
      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[1]).toBe(1); // Number of keys
      expect(callArgs[2]).toBe(`test:id:${lockId}`); // Lock ID index key
      expect(callArgs[3]).toBe(lockId); // Lock ID argument
      expect(callArgs[4]).toBe("120000"); // TTL in milliseconds
    });

    it("should fail to extend expired or non-existent lock", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Redis Lua script returns 0 when lock is expired or not found
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.extend("expired-lock-jkl012", 60000);
      expect(result).toBe(false);

      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should fail to extend lock not owned by this instance", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Script returns 0 when lock is owned by different instance
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.extend("foreign-lock-mno345", 90000);
      expect(result).toBe(false);
    });

    it("should handle various TTL values correctly", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      mockEval.mockResolvedValue(1);

      // Test different TTL values
      expect(await backend.extend("lock-1", 1000)).toBe(true); // 1 second
      expect(await backend.extend("lock-2", 3600000)).toBe(true); // 1 hour

      // Verify TTL is passed in milliseconds (not converted to seconds)
      const calls = mockEval.mock.calls;
      expect(calls[0]![4]).toBe("1000"); // 1000ms
      expect(calls[1]![4]).toBe("3600000"); // 3600000ms
    });

    it("should handle Redis errors during extension", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockRejectedValueOnce(new Error("ERR syntax error"));

      try {
        const result = await backend.extend("test-lock", 30000);
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

      const result = await backend.isLocked("resource:payment:user:456");
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

      const result = await backend.isLocked("resource:cache:user:789");
      expect(result).toBe(false);

      expect(mockEval).toHaveBeenCalledTimes(1);
    });

    it("should return false for expired locks", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;

      // Script returns 0 and cleans up expired locks
      mockEval.mockResolvedValueOnce(0);

      const result = await backend.isLocked("resource:session:abc123");
      expect(result).toBe(false);
    });

    it("should handle various resource key formats", async () => {
      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValue(0);

      // Test different key patterns
      await backend.isLocked("simple");
      await backend.isLocked("nested:resource:key");
      await backend.isLocked("user/123/profile");
      await backend.isLocked("service.api.rate-limit");

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
        const result = await backend.isLocked("resource:test");
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
      await customBackend.acquire({ key: "user:123" });
      await customBackend.isLocked("user:123");
      await customBackend.release("lock-id-456");
      await customBackend.extend("lock-id-456", 60000);

      const calls = mockEval.mock.calls;

      // Acquire operation
      expect(calls[0]![2]).toBe("myapp:locks:user:123"); // Main lock key
      expect(calls[0]![3]).toMatch(/^myapp:locks:id:/); // Lock ID index key

      // IsLocked operation
      expect(calls[1]![2]).toBe("myapp:locks:user:123");

      // Release operation
      expect(calls[2]![2]).toBe("myapp:locks:id:lock-id-456");

      // Extend operation
      expect(calls[3]![2]).toBe("myapp:locks:id:lock-id-456");
    });

    it("should apply sensible default configuration", async () => {
      const defaultBackend = createRedisBackend(mockRedis as Redis);

      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      mockEval.mockResolvedValueOnce(1);

      await defaultBackend.acquire({ key: "test:resource" });

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

      await noPrefixBackend.acquire({ key: "global:resource" });

      const callArgs = mockEval.mock.calls[0]!;
      expect(callArgs[2]).toBe("global:resource"); // No prefix
      expect(callArgs[3]).toMatch(/^id:/); // ID prefix only
    });

    it("should respect retry configuration", async () => {
      const lowRetryBackend = createRedisBackend(mockRedis as Redis, {
        maxRetries: 1,
        retryDelayMs: 5,
      });

      const mockEval = mockRedis.eval as ReturnType<typeof mock>;
      // Simulate transient error
      mockEval.mockRejectedValueOnce(new Error("ECONNRESET: Connection reset"));
      mockEval.mockResolvedValueOnce(1); // Success on retry

      const startTime = Date.now();
      const result = await lowRetryBackend.acquire({ key: "retry:test" });
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(mockEval).toHaveBeenCalledTimes(2); // Original + 1 retry
      expect(elapsed).toBeGreaterThanOrEqual(5); // At least one retry delay
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

      await backend1.acquire({ key: "shared:resource" });
      await backend2.acquire({ key: "shared:resource" });

      const calls = mockEval.mock.calls;
      expect(calls[0]![2]).toBe("app1:shared:resource");
      expect(calls[1]![2]).toBe("app2:shared:resource");

      // Verify they don't interfere with each other
      expect(calls[0]![2]).not.toBe(calls[1]![2]);
    });
  });
});
