// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Comprehensive lockId format validation tests
 *
 * Per interface.md lines 729-730:
 * - MUST be exactly 22 characters (128-bit base64url encoded)
 * - MUST match pattern: ^[A-Za-z0-9_-]{22}$
 * - MUST NOT contain standard base64 characters (+, /, =)
 *
 * These tests verify edge cases beyond basic validation
 */

import type { Firestore } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Redis } from "ioredis";
import type { LockBackend } from "../../common";
import { LockError } from "../../common/errors.js";
import { createFirestoreBackend } from "../../firestore/backend";
import { createRedisBackend } from "../../redis/backend";

describe("LockId Format Validation (interface.md lines 729-730)", () => {
  // Mock clients for validation testing
  let mockRedis: Partial<Redis>;
  let mockFirestore: Partial<Firestore>;
  let redisBackend: LockBackend;
  let firestoreBackend: LockBackend;

  beforeEach(() => {
    // Create mocked Redis client
    mockRedis = {
      eval: mock(() => Promise.resolve(1)), // Default success response
      evalsha: mock(() => Promise.resolve(1)),
      script: mock(() => Promise.resolve("sha123")),
    };

    // Create mocked Firestore client with runTransaction support
    mockFirestore = {
      collection: mock(() => ({
        doc: mock(() => ({
          get: mock(() => Promise.resolve({ exists: false })),
          set: mock(() => Promise.resolve()),
          delete: mock(() => Promise.resolve()),
        })),
        where: mock(() => ({
          limit: mock(() => ({})),
        })),
      })),
      runTransaction: mock(async (callback: any) => {
        const mockTrx = {
          get: mock(() =>
            Promise.resolve({
              empty: false,
              docs: [
                {
                  ref: {},
                  data: () => ({
                    lockId: "test",
                    expiresAtMs: Date.now() + 30000,
                  }),
                },
              ],
            }),
          ),
          delete: mock(() => Promise.resolve()),
        };
        return await callback(mockTrx);
      }),
    } as any;

    redisBackend = createRedisBackend(mockRedis as Redis, {
      keyPrefix: "test:lockid:",
    });

    firestoreBackend = createFirestoreBackend(mockFirestore as Firestore, {
      collection: "test_lockid_validation",
      fenceCollection: "test_lockid_fence",
    });
  });

  describe("Valid LockId Formats", () => {
    it("should accept exactly 22 base64url characters", async () => {
      const validLockId = "ABCDEFGHIJKLMNOPQRSTUv"; // 22 chars, base64url

      // Should not throw for valid format
      await expect(
        redisBackend.release({ lockId: validLockId }),
      ).resolves.toBeDefined();
      await expect(
        firestoreBackend.release({ lockId: validLockId }),
      ).resolves.toBeDefined();
    });

    it("should accept all valid base64url characters", async () => {
      // Test all allowed character sets
      const lockIds = [
        "ABCDEFGHIJKLMNOPQRSTUV", // All uppercase
        "abcdefghijklmnopqrstuv", // All lowercase
        "0123456789ABCDEFGHIJKL", // Numbers and letters
        "___---_-_-_-_-_-_-_-_-", // Underscores and hyphens
        "aA0-_bB1-_cC2-_dD3-_eE", // Mixed valid chars
      ];

      for (const lockId of lockIds) {
        expect(lockId.length).toBe(22);
        await expect(redisBackend.release({ lockId })).resolves.toBeDefined();
        await expect(
          firestoreBackend.release({ lockId }),
        ).resolves.toBeDefined();
      }
    });
  });

  describe("Invalid LockId Formats - Length", () => {
    it("should reject empty lockId", async () => {
      await expect(redisBackend.release({ lockId: "" })).rejects.toThrow(
        LockError,
      );
      await expect(redisBackend.release({ lockId: "" })).rejects.toThrow(
        /Invalid lockId format/,
      );

      await expect(firestoreBackend.release({ lockId: "" })).rejects.toThrow(
        LockError,
      );
      await expect(firestoreBackend.release({ lockId: "" })).rejects.toThrow(
        /Invalid lockId format/,
      );
    });

    it("should reject lockId shorter than 22 characters", async () => {
      const shortLockIds = [
        "A", // 1 char
        "ABCDEFG", // 7 chars
        "ABCDEFGHIJKLMNOPQRSTU", // 21 chars (one short)
      ];

      for (const lockId of shortLockIds) {
        await expect(redisBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
        await expect(firestoreBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
      }
    });

    it("should reject lockId longer than 22 characters", async () => {
      const longLockIds = [
        "ABCDEFGHIJKLMNOPQRSTUVW", // 23 chars (one extra)
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ", // 26 chars
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", // 36 chars
      ];

      for (const lockId of longLockIds) {
        await expect(redisBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
        await expect(firestoreBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
      }
    });
  });

  describe("Invalid LockId Formats - Characters", () => {
    it("should reject standard base64 characters (+ / =)", async () => {
      const invalidLockIds = [
        "ABCDEFGHIJKLMNOPQRST+V", // Contains + (22 chars)
        "ABCDEFGHIJKLMNOPQRST/V", // Contains / (22 chars)
        "ABCDEFGHIJKLMNOPQRST=V", // Contains = (22 chars)
        "++++++++++++++++++++V+", // All + (22 chars)
        "//////////////////////", // All / (22 chars)
        "======================", // All = (22 chars)
      ];

      for (const lockId of invalidLockIds) {
        expect(lockId.length).toBe(22);
        await expect(redisBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
        await expect(firestoreBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
      }
    });

    it("should reject special characters", async () => {
      const invalidLockIds = [
        "ABCDEFGHIJKLMNOPQRST@V", // Contains @
        "ABCDEFGHIJKLMNOPQRST!V", // Contains !
        "ABCDEFGHIJKLMNOPQRST#V", // Contains #
        "ABCDEFGHIJKLMNOPQRST$V", // Contains $
        "ABCDEFGHIJKLMNOPQRST%V", // Contains %
        "ABCDEFGHIJKLMNOPQRST&V", // Contains &
        "ABCDEFGHIJKLMNOPQRST*V", // Contains *
      ];

      for (const lockId of invalidLockIds) {
        expect(lockId.length).toBe(22);
        await expect(redisBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
        await expect(firestoreBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
      }
    });

    it("should reject whitespace characters", async () => {
      const invalidLockIds = [
        "ABCDEFGHIJKLMNOPQRST V", // Contains space
        "ABCDEFGHIJKLMNOPQRST\tV", // Contains tab
        "ABCDEFGHIJKLMNOPQRST\nV", // Contains newline
        "                      ", // All spaces
      ];

      for (const lockId of invalidLockIds) {
        expect(lockId.length).toBe(22);
        await expect(redisBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
        await expect(firestoreBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
      }
    });

    it("should reject Unicode lookalikes", async () => {
      // These characters look similar to valid base64url chars but are different Unicode
      const invalidLockIds = [
        "ABCDEFGHIJKLMNOPQRSTႬV", // Contains Cyrillic A lookalike
        "АBCDEFGHIJKLMNOPQRSTUV", // First char is Cyrillic A (U+0410)
        "ABCDEFGHIJKLMNOPQRSТUV", // Contains Cyrillic T (U+0422)
      ];

      for (const lockId of invalidLockIds) {
        await expect(redisBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
        await expect(firestoreBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
      }
    });
  });

  describe("Edge Cases", () => {
    it("should reject null and undefined", async () => {
      await expect(
        redisBackend.release({ lockId: null as any }),
      ).rejects.toThrow(/Invalid lockId format/);
      await expect(
        redisBackend.release({ lockId: undefined as any }),
      ).rejects.toThrow(/Invalid lockId format/);

      await expect(
        firestoreBackend.release({ lockId: null as any }),
      ).rejects.toThrow(/Invalid lockId format/);
      await expect(
        firestoreBackend.release({ lockId: undefined as any }),
      ).rejects.toThrow(/Invalid lockId format/);
    });

    it("should reject numeric lockIds", async () => {
      await expect(
        redisBackend.release({ lockId: 123456789012345678901 as any }),
      ).rejects.toThrow(/Invalid lockId format/);
      await expect(
        firestoreBackend.release({ lockId: 123456789012345678901 as any }),
      ).rejects.toThrow(/Invalid lockId format/);
    });

    it("should reject lockIds with leading/trailing whitespace", async () => {
      const invalidLockIds = [
        " ABCDEFGHIJKLMNOPQRSTUV", // Leading space (23 chars total)
        "ABCDEFGHIJKLMNOPQRSTUV ", // Trailing space (23 chars total)
        " ABCDEFGHIJKLMNOPQRSTU", // Leading space (22 chars total)
      ];

      for (const lockId of invalidLockIds) {
        await expect(redisBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
        await expect(firestoreBackend.release({ lockId })).rejects.toThrow(
          /Invalid lockId format/,
        );
      }
    });
  });

  describe("Cross-Backend Consistency", () => {
    it("should validate identically across Redis and Firestore backends", async () => {
      const testCases = [
        { lockId: "ABCDEFGHIJKLMNOPQRSTUV", shouldPass: true },
        { lockId: "", shouldPass: false },
        { lockId: "SHORT", shouldPass: false },
        { lockId: "ABCDEFGHIJKLMNOPQRST+V", shouldPass: false },
        { lockId: "ABCDEFGHIJKLMNOPQRST/V", shouldPass: false },
        { lockId: "ABCDEFGHIJKLMNOPQRST@V", shouldPass: false },
      ];

      for (const { lockId, shouldPass } of testCases) {
        const redisPromise = redisBackend.release({ lockId });
        const firestorePromise = firestoreBackend.release({ lockId });

        if (shouldPass) {
          // Both should succeed (or fail with not found, but not validation error)
          await expect(redisPromise).resolves.toBeDefined();
          await expect(firestorePromise).resolves.toBeDefined();
        } else {
          // Both should fail with same validation error
          await expect(redisPromise).rejects.toThrow(/Invalid lockId format/);
          await expect(firestorePromise).rejects.toThrow(
            /Invalid lockId format/,
          );
        }
      }
    });
  });
});
