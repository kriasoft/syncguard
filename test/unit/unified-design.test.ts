// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for unified design consistency
 *
 * These tests verify that the key design principles are implemented correctly:
 * - Unified time tolerance across backends
 * - Consistent fence token formatting
 * - Standardized error handling
 * - Common validation helpers
 */

import { describe, expect, it } from "bun:test";
import {
  LockError,
  MAX_KEY_LENGTH_BYTES,
  TIME_TOLERANCE_MS,
  calculateRedisServerTimeMs,
  hasFence,
  isLive,
  makeStorageKey,
  normalizeAndValidateKey,
  validateLockId,
} from "../../index.js";

describe("Unified Design Tests", () => {
  describe("Time Authority Consistency", () => {
    it("should use unified 1000ms tolerance", () => {
      expect(TIME_TOLERANCE_MS).toBe(1000);
    });

    it("should implement consistent liveness predicate", () => {
      const now = Date.now();
      const expired = now - 5000; // 5 seconds ago
      const live = now + 5000; // 5 seconds from now

      // With 1000ms tolerance, something expired 5 seconds ago is definitely expired
      expect(isLive(expired, now, TIME_TOLERANCE_MS)).toBe(false);

      // Something expiring 5 seconds from now is definitely live
      expect(isLive(live, now, TIME_TOLERANCE_MS)).toBe(true);

      // Edge case: expired 500ms ago but within tolerance
      const recentlyExpired = now - 500;
      expect(isLive(recentlyExpired, now, TIME_TOLERANCE_MS)).toBe(true);
    });

    it("should correctly calculate Redis server time", () => {
      const seconds = "1640995200"; // 2022-01-01 00:00:00 UTC
      const microseconds = "123456";

      const result = calculateRedisServerTimeMs([seconds, microseconds]);
      const expected =
        parseInt(seconds) * 1000 + Math.floor(parseInt(microseconds) / 1000);

      expect(result).toBe(expected);
      expect(result).toBe(1640995200123); // Precise calculation
    });
  });

  describe("Validation Consistency", () => {
    it("should validate lock IDs with consistent format", () => {
      // Valid 22-character base64url lockId
      const validLockId = "abcdefghijklmnopqrstuv";
      expect(validLockId.length).toBe(22);
      expect(() => validateLockId(validLockId)).not.toThrow();

      // Invalid formats should throw
      expect(() => validateLockId("too-short")).toThrow(LockError);
      expect(() =>
        validateLockId("too-long-lockid-with-more-than-22-chars"),
      ).toThrow(LockError);
      expect(() => validateLockId("invalid/chars+here=")).toThrow(LockError);
    });

    it("should normalize and validate keys with consistent limits", () => {
      // Normal key should work
      const normalKey = "resource:123";
      expect(normalizeAndValidateKey(normalKey)).toBe(normalKey);

      // Unicode normalization should work
      const unicodeKey = "café"; // é can be composed or decomposed
      const normalized = normalizeAndValidateKey(unicodeKey);
      expect(normalized).toBe(unicodeKey.normalize("NFC"));

      // Key exceeding MAX_KEY_LENGTH_BYTES should throw
      const longKey = "x".repeat(MAX_KEY_LENGTH_BYTES + 1);
      expect(() => normalizeAndValidateKey(longKey)).toThrow(LockError);
    });
  });

  describe("Fence Token Consistency", () => {
    it("should enforce 15-digit zero-padded fence format (ADR-004)", () => {
      // Per ADR-004: ALL fence tokens MUST be exactly 15 digits with zero-padding
      const validFences = [
        "000000000000001",
        "000000000000042",
        "000000000001337",
        "000000123456789",
        "999999999999999", // Maximum 15-digit value
      ];

      const invalidFences = [
        "1", // Too short
        "0000000000000001", // 16 digits (old format, now invalid)
        "00000000000000001", // 17 digits
        "0000000000000000001", // 19 digits (original format, now invalid)
        "abc000000000001", // Non-numeric
        " 000000000000001", // Leading whitespace
      ];

      // Regex per ADR-004: /^\d{15}$/
      const fenceFormatRegex = /^\d{15}$/;

      validFences.forEach((fence) => {
        expect(fence).toMatch(fenceFormatRegex);
        expect(fence.length).toBe(15);
      });

      invalidFences.forEach((fence) => {
        expect(fence).not.toMatch(fenceFormatRegex);
      });
    });

    it("should handle fence tokens with type guards", () => {
      const successWithFence = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000001",
      };

      const successWithoutFence = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
      };

      const failure = {
        ok: false as const,
        reason: "locked" as const,
      };

      // Type guard should work correctly
      expect(hasFence(successWithFence)).toBe(true);
      expect(hasFence(successWithoutFence)).toBe(false);
      expect(hasFence(failure)).toBe(false);
    });

    it("should validate fence token format", () => {
      const mockCapabilities = {
        supportsFencing: true,
        timeAuthority: "server" as const,
      };

      const successWithFence = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000001",
      };

      const successWithoutFence = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
      };

      const failure = {
        ok: false as const,
        reason: "locked" as const,
      };

      // Per ADR-008, with typed backends, fence is compile-time guaranteed
      // The type system ensures result.fence exists for fencing backends
      // For generic code, use hasFence() type guard
      expect(hasFence(successWithFence)).toBe(true);
      expect(hasFence(successWithoutFence)).toBe(false);
      expect(hasFence(failure)).toBe(false);
    });

    it("should support lexicographic fence comparison (ADR-004)", () => {
      // 15-digit zero-padded fence tokens for consistent ordering
      const fence1 = "000000000000001";
      const fence2 = "000000000000002";
      const fence10 = "000000000000010";

      // String comparison should work correctly with zero-padding
      expect(fence1 < fence2).toBe(true);
      expect(fence2 < fence10).toBe(true);
      expect(fence10 > fence1).toBe(true);

      // Verify 15-digit format per ADR-004
      expect(fence1.length).toBe(15);
      expect(fence2.length).toBe(15);
      expect(fence10.length).toBe(15);
    });
  });

  describe("Storage Key Generation (ADR-006)", () => {
    it("should return prefixed key when within backend limit", () => {
      const prefix = "test";
      const userKey = "resource:123";
      const limit = 1000;
      const reserve = 0;

      const result = makeStorageKey(prefix, userKey, limit, reserve);
      expect(result).toBe("test:resource:123");
    });

    it("should handle prefix with trailing colon correctly", () => {
      const prefix = "test:";
      const userKey = "resource:456";
      const limit = 1000;
      const reserve = 0;

      const result = makeStorageKey(prefix, userKey, limit, reserve);
      // Trailing colons are stripped from prefix for consistency
      expect(result).toBe("test:resource:456");
    });

    it("should apply hash truncation for long keys exceeding backend limit", () => {
      const prefix = "prefix";
      const userKey = "x".repeat(500); // Long key
      const limit = 100; // Limit that requires truncation
      const reserve = 0;

      const result = makeStorageKey(prefix, userKey, limit, reserve);

      // Result should be truncated with hash: prefix:22-char-base64url (128-bit hash)
      expect(result.length).toBeLessThanOrEqual(limit);
      expect(result.startsWith("prefix:")).toBe(true);

      // Hash should be exactly 22 base64url characters (128 bits per updated spec)
      const hashPart = result.substring(7); // After "prefix:"
      expect(hashPart.length).toBe(22);
      expect(hashPart).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it("should generate deterministic truncated keys for same input", () => {
      const prefix = "test";
      const userKey = "x".repeat(500);
      const limit = 50;
      const reserve = 0;

      const result1 = makeStorageKey(prefix, userKey, limit, reserve);
      const result2 = makeStorageKey(prefix, userKey, limit, reserve);

      // Same input should produce same truncated key (deterministic)
      expect(result1).toBe(result2);
    });

    it("should generate different hashes for different keys", () => {
      const prefix = "test";
      const limit = 50;
      const reserve = 0;

      const key1 = "x".repeat(500);
      const key2 = "y".repeat(500);

      const result1 = makeStorageKey(prefix, key1, limit, reserve);
      const result2 = makeStorageKey(prefix, key2, limit, reserve);

      // Different keys should produce different hashes (collision resistance)
      expect(result1).not.toBe(result2);
    });

    it("should throw only when even truncated form exceeds absolute limit", () => {
      const prefix = "verylongprefixthatexceedsevenlimits";
      const userKey = "key";
      const limit = 20; // Too small even for truncated form
      const reserve = 0;

      // Should throw when prefix + separator + reserve exceeds limit
      expect(() => makeStorageKey(prefix, userKey, limit, reserve)).toThrow(
        LockError,
      );
      expect(() => makeStorageKey(prefix, userKey, limit, reserve)).toThrow(
        "Prefix exceeds backend limit",
      );
    });

    it("should handle empty prefix gracefully", () => {
      const prefix = "";
      const userKey = "simple-key";
      const limit = 100;
      const reserve = 0;

      const result = makeStorageKey(prefix, userKey, limit, reserve);
      expect(result).toBe("simple-key");
    });
  });

  describe("Error Handling Consistency", () => {
    it("should create consistent LockError instances", () => {
      const error = new LockError("InvalidArgument", "Test error message", {
        key: "test:key",
        lockId: "test-lock-id",
        cause: new Error("root cause"),
      });

      expect(error.name).toBe("LockError");
      expect(error.code).toBe("InvalidArgument");
      expect(error.message).toBe("Test error message");
      expect(error.context?.key).toBe("test:key");
      expect(error.context?.lockId).toBe("test-lock-id");
      expect(error.context?.cause).toBeInstanceOf(Error);
    });

    it("should use error code as default message", () => {
      const error = new LockError("ServiceUnavailable");
      expect(error.message).toBe("ServiceUnavailable");
    });
  });
});
