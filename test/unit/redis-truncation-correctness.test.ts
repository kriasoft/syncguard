// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * ADR-013: Redis Backend Truncation Correctness Test
 *
 * This test verifies the fix for the key truncation mismatch bug:
 * - BEFORE: acquire stored original key in index, release/extend reconstructed using it
 * - AFTER: acquire stores full lockKey (post-truncation), release/extend retrieve directly
 *
 * The bug occurred when key truncation triggered (prefix + key > 974 bytes for Redis),
 * causing release/extend to fail to find locks or target wrong keys.
 */

import { describe, expect, it, mock } from "bun:test";
import { createAcquireOperation } from "../../redis/operations/acquire.js";
import { createExtendOperation } from "../../redis/operations/extend.js";
import { createReleaseOperation } from "../../redis/operations/release.js";
import type { RedisConfig } from "../../redis/types.js";

describe("ADR-013: Redis Backend Truncation Correctness", () => {
  describe("Key Truncation Scenario", () => {
    it("should correctly release lock when key truncation occurs", async () => {
      // Simulate truncation: long prefix (500 bytes) + max user key (512 bytes)
      // Total: 500 + 1 (":") + 512 = 1013 bytes > 1000 - 26 (reserve) = 974 bytes
      const longPrefix = "x".repeat(500);
      const maxUserKey = "y".repeat(512);

      // Mock Redis client
      const mockRedis = {
        eval: mock(
          async (script: string, numKeys: number, ...args: unknown[]) => {
            const scriptStr = script.toString();

            // ACQUIRE script
            if (scriptStr.includes("INCR")) {
              const lockKey = args[0] as string;
              const lockIdKey = args[1] as string;
              const storageKey = args[6] as string; // ARGV[4] = storageKey

              // Verify that storageKey matches lockKey (post-truncation)
              expect(storageKey).toBe(lockKey);

              // Simulate storage: store lockKey in index
              mockRedis.storage.set(lockIdKey, storageKey);

              // Simulate lock data storage
              const lockId = args[3] as string;
              const ttlMs = args[4] as string;
              const expiresAtMs = Date.now() + Number.parseInt(ttlMs);
              const lockData = JSON.stringify({
                lockId,
                expiresAtMs,
                acquiredAtMs: Date.now(),
                fence: "000000000000001",
              });
              mockRedis.storage.set(lockKey, lockData);

              return [1, "000000000000001", expiresAtMs];
            }

            // RELEASE script
            if (scriptStr.includes("redis.call('DEL', lockKey, lockIdKey)")) {
              const lockIdKey = args[0] as string;
              const lockId = args[1] as string;

              // ADR-013: Retrieve full lockKey from index
              const lockKey = mockRedis.storage.get(lockIdKey);
              if (!lockKey) return -1; // Not found

              const lockData = mockRedis.storage.get(lockKey);
              if (!lockData) return -1;

              const data = JSON.parse(lockData);
              if (data.lockId !== lockId) return 0; // Ownership mismatch

              // Success: delete both keys
              mockRedis.storage.delete(lockKey);
              mockRedis.storage.delete(lockIdKey);
              return 1;
            }

            throw new Error(
              `Unexpected script: ${scriptStr.substring(0, 100)}`,
            );
          },
        ),
        storage: new Map<string, string>(), // Simulated Redis storage
      };

      const config: RedisConfig = {
        keyPrefix: longPrefix,
        cleanupInIsLocked: false,
      };

      // Acquire lock
      const acquire = createAcquireOperation(mockRedis, config);
      const acquireResult = await acquire({ key: maxUserKey, ttlMs: 5000 });

      expect(acquireResult.ok).toBe(true);
      if (!acquireResult.ok) throw new Error("Acquire failed");

      const { lockId } = acquireResult;

      // Release lock - this should succeed with ADR-013 fix
      const release = createReleaseOperation(mockRedis, config);
      const releaseResult = await release({ lockId });

      expect(releaseResult.ok).toBe(true);
    });

    it("should correctly extend lock when key truncation occurs", async () => {
      const longPrefix = "x".repeat(500);
      const maxUserKey = "y".repeat(512);

      const mockRedis = {
        eval: mock(
          async (script: string, numKeys: number, ...args: unknown[]) => {
            const scriptStr = script.toString();

            // ACQUIRE script
            if (scriptStr.includes("INCR")) {
              const lockKey = args[0] as string;
              const lockIdKey = args[1] as string;
              const storageKey = args[6] as string; // ARGV[4] = storageKey

              expect(storageKey).toBe(lockKey);

              mockRedis.storage.set(lockIdKey, storageKey);

              const lockId = args[3] as string;
              const ttlMs = args[4] as string;
              const expiresAtMs = Date.now() + Number.parseInt(ttlMs);
              const lockData = JSON.stringify({
                lockId,
                expiresAtMs,
                acquiredAtMs: Date.now(),
                fence: "000000000000001",
              });
              mockRedis.storage.set(lockKey, lockData);

              return [1, "000000000000001", expiresAtMs];
            }

            // EXTEND script
            if (scriptStr.includes("data.expiresAtMs = newExpiresAtMs")) {
              const lockIdKey = args[0] as string;
              const lockId = args[1] as string;
              const ttlMs = args[3] as string;

              // ADR-013: Retrieve full lockKey from index
              const lockKey = mockRedis.storage.get(lockIdKey);
              if (!lockKey) return 0;

              const lockData = mockRedis.storage.get(lockKey);
              if (!lockData) return 0;

              const data = JSON.parse(lockData);
              if (data.lockId !== lockId) return 0;

              // Success: update expiresAtMs
              const newExpiresAtMs = Date.now() + Number.parseInt(ttlMs);
              data.expiresAtMs = newExpiresAtMs;
              mockRedis.storage.set(lockKey, JSON.stringify(data));

              // Re-store lockKey in index (as per script)
              mockRedis.storage.set(lockIdKey, lockKey);

              return [1, newExpiresAtMs];
            }

            throw new Error(
              `Unexpected script: ${scriptStr.substring(0, 100)}`,
            );
          },
        ),
        storage: new Map<string, string>(),
      };

      const config: RedisConfig = {
        keyPrefix: longPrefix,
        cleanupInIsLocked: false,
      };

      // Acquire lock
      const acquire = createAcquireOperation(mockRedis, config);
      const acquireResult = await acquire({ key: maxUserKey, ttlMs: 5000 });

      expect(acquireResult.ok).toBe(true);
      if (!acquireResult.ok) throw new Error("Acquire failed");

      const { lockId } = acquireResult;

      // Extend lock - this should succeed with ADR-013 fix
      const extend = createExtendOperation(mockRedis, config);
      const extendResult = await extend({ lockId, ttlMs: 10000 });

      expect(extendResult.ok).toBe(true);
    });

    it("should handle no truncation case (short prefix + key)", async () => {
      // No truncation: short prefix + short key = well under limit
      const shortPrefix = "syncguard";
      const shortKey = "resource:user:123";

      const mockRedis = {
        eval: mock(
          async (script: string, numKeys: number, ...args: unknown[]) => {
            const scriptStr = script.toString();

            if (scriptStr.includes("INCR")) {
              const lockKey = args[0] as string;
              const lockIdKey = args[1] as string;
              const storageKey = args[6] as string;

              // No truncation: storageKey should equal full "prefix:key"
              expect(storageKey).toBe(`${shortPrefix}:${shortKey}`);
              expect(storageKey).toBe(lockKey);

              mockRedis.storage.set(lockIdKey, storageKey);

              const lockId = args[3] as string;
              const ttlMs = args[4] as string;
              const expiresAtMs = Date.now() + Number.parseInt(ttlMs);
              const lockData = JSON.stringify({
                lockId,
                expiresAtMs,
                acquiredAtMs: Date.now(),
                fence: "000000000000001",
              });
              mockRedis.storage.set(lockKey, lockData);

              return [1, "000000000000001", expiresAtMs];
            }

            if (scriptStr.includes("redis.call('DEL', lockKey, lockIdKey)")) {
              const lockIdKey = args[0] as string;
              const lockId = args[1] as string;

              const lockKey = mockRedis.storage.get(lockIdKey);
              if (!lockKey) return -1;

              // Verify lockKey is the full, non-truncated key
              expect(lockKey).toBe(`${shortPrefix}:${shortKey}`);

              const lockData = mockRedis.storage.get(lockKey);
              if (!lockData) return -1;

              const data = JSON.parse(lockData);
              if (data.lockId !== lockId) return 0;

              mockRedis.storage.delete(lockKey);
              mockRedis.storage.delete(lockIdKey);
              return 1;
            }

            throw new Error(
              `Unexpected script: ${scriptStr.substring(0, 100)}`,
            );
          },
        ),
        storage: new Map<string, string>(),
      };

      const config: RedisConfig = {
        keyPrefix: shortPrefix,
        cleanupInIsLocked: false,
      };

      const acquire = createAcquireOperation(mockRedis, config);
      const acquireResult = await acquire({ key: shortKey, ttlMs: 5000 });

      expect(acquireResult.ok).toBe(true);
      if (!acquireResult.ok) throw new Error("Acquire failed");

      const { lockId } = acquireResult;

      const release = createReleaseOperation(mockRedis, config);
      const releaseResult = await release({ lockId });

      expect(releaseResult.ok).toBe(true);
    });
  });

  describe("Index Storage Consistency", () => {
    it("should always store full lockKey in index, regardless of truncation", async () => {
      const testCases = [
        {
          name: "short prefix + short key (no truncation)",
          prefix: "app",
          key: "resource:123",
          expectTruncation: false,
        },
        {
          name: "long prefix + max key (truncation)",
          prefix: "x".repeat(500),
          key: "y".repeat(512),
          expectTruncation: true,
        },
        {
          name: "medium prefix + medium key (boundary)",
          prefix: "namespace",
          key: "x".repeat(400),
          expectTruncation: false,
        },
      ];

      for (const testCase of testCases) {
        const mockRedis = {
          eval: mock(
            async (script: string, numKeys: number, ...args: unknown[]) => {
              if (script.includes("INCR")) {
                const lockKey = args[0] as string;
                const lockIdKey = args[1] as string;
                const storageKey = args[6] as string;

                // Critical invariant: storageKey MUST equal lockKey
                expect(storageKey).toBe(lockKey);

                // Store for later verification
                mockRedis.captured = { lockKey, storageKey };

                return [1, "000000000000001", Date.now() + 5000];
              }
              return 0;
            },
          ),
          captured: null as { lockKey: string; storageKey: string } | null,
        };

        const config: RedisConfig = {
          keyPrefix: testCase.prefix,
          cleanupInIsLocked: false,
        };
        const acquire = createAcquireOperation(mockRedis, config);

        await acquire({ key: testCase.key, ttlMs: 5000 });

        expect(mockRedis.captured).not.toBeNull();
        expect(mockRedis.captured?.lockKey).toBe(
          mockRedis.captured?.storageKey,
        );
      }
    });
  });
});
