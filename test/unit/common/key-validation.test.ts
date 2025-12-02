// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Storage key validation tests
 *
 * Tests for key validation and storage key generation:
 * - makeStorageKey function (ADR-006)
 * - normalizeAndValidateKey function
 * - Key length limits and Unicode handling
 */

import { describe, expect, it } from "bun:test";
import {
  LockError,
  MAX_KEY_LENGTH_BYTES,
  makeStorageKey,
  normalizeAndValidateKey,
} from "../../../index.js";

describe("Storage Key Generation (ADR-006)", () => {
  describe("Basic Key Generation", () => {
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

    it("should handle empty prefix gracefully", () => {
      const prefix = "";
      const userKey = "simple-key";
      const limit = 100;
      const reserve = 0;

      const result = makeStorageKey(prefix, userKey, limit, reserve);
      expect(result).toBe("simple-key");
    });
  });

  describe("Hash Truncation", () => {
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
  });

  describe("Error Handling", () => {
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

    it("should throw when prefix + reserve makes valid keys impossible", () => {
      const prefix = "test";
      const userKey = "key";
      const limit = 30;
      const reserve = 26; // test: (5 bytes) + reserve (26) = 31 > limit (30)

      expect(() => makeStorageKey(prefix, userKey, limit, reserve)).toThrow(
        LockError,
      );
      expect(() => makeStorageKey(prefix, userKey, limit, reserve)).toThrow(
        "Prefix exceeds backend limit",
      );
    });

    it("should throw when user key is empty", () => {
      const prefix = "test";
      const limit = 100;
      const reserve = 0;

      expect(() => makeStorageKey(prefix, "", limit, reserve)).toThrow(
        LockError,
      );
      expect(() => makeStorageKey(prefix, "", limit, reserve)).toThrow(
        "Key must not be empty",
      );
    });
  });
});

describe("Key Validation", () => {
  describe("normalizeAndValidateKey", () => {
    it("should accept normal keys", () => {
      const normalKey = "resource:123";
      expect(normalizeAndValidateKey(normalKey)).toBe(normalKey);
    });

    it("should normalize Unicode", () => {
      // Unicode normalization test: "café" can be represented two ways
      const unicodeKey = "café"; // é can be composed or decomposed
      const normalized = normalizeAndValidateKey(unicodeKey);
      expect(normalized).toBe(unicodeKey.normalize("NFC"));
    });

    it("should normalize composed and decomposed forms to same value", () => {
      // Composed: café (U+00E9)
      const composed = "café";
      // Decomposed: cafe\u0301 (e + combining acute accent)
      const decomposed = "cafe\u0301";

      const normalizedComposed = normalizeAndValidateKey(composed);
      const normalizedDecomposed = normalizeAndValidateKey(decomposed);

      expect(normalizedComposed).toBe(normalizedDecomposed);
    });

    it("should reject empty keys", () => {
      expect(() => normalizeAndValidateKey("")).toThrow(LockError);
      expect(() => normalizeAndValidateKey("")).toThrow(
        "Key must not be empty",
      );
    });

    it("should reject keys exceeding MAX_KEY_LENGTH_BYTES", () => {
      const longKey = "x".repeat(MAX_KEY_LENGTH_BYTES + 1);
      expect(() => normalizeAndValidateKey(longKey)).toThrow(LockError);
      expect(() => normalizeAndValidateKey(longKey)).toThrow(/exceeds maximum/);
    });

    it("should accept keys at exactly MAX_KEY_LENGTH_BYTES", () => {
      const maxKey = "x".repeat(MAX_KEY_LENGTH_BYTES);
      expect(() => normalizeAndValidateKey(maxKey)).not.toThrow();
      expect(normalizeAndValidateKey(maxKey)).toBe(maxKey);
    });

    it("should handle multi-byte Unicode characters in length calculation", () => {
      // "🔒" is 4 bytes in UTF-8
      const encoder = new TextEncoder();
      const emojiKey = "🔒".repeat(128); // 512 bytes total

      const keyBytes = encoder.encode(emojiKey).byteLength;
      expect(keyBytes).toBe(512);

      if (keyBytes > MAX_KEY_LENGTH_BYTES) {
        expect(() => normalizeAndValidateKey(emojiKey)).toThrow(LockError);
      } else {
        expect(() => normalizeAndValidateKey(emojiKey)).not.toThrow();
      }
    });
  });

  describe("Key Length Limits", () => {
    it("should enforce MAX_KEY_LENGTH_BYTES constant", () => {
      expect(MAX_KEY_LENGTH_BYTES).toBe(512);
    });

    it("should count bytes, not characters", () => {
      const encoder = new TextEncoder();

      // ASCII: 1 byte per character
      const asciiKey = "a".repeat(100);
      expect(encoder.encode(asciiKey).byteLength).toBe(100);

      // UTF-8 emoji: 4 bytes per character
      const emojiKey = "🔒".repeat(100);
      expect(encoder.encode(emojiKey).byteLength).toBe(400);

      // Mixed
      const mixedKey = "a🔒"; // 1 + 4 = 5 bytes
      expect(encoder.encode(mixedKey).byteLength).toBe(5);
    });
  });
});
