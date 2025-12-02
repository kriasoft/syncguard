// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for crypto utilities
 *
 * Tests makeStorageKey, generateLockId, hashKey, and formatFence
 */

import { describe, expect, it } from "bun:test";
import {
  formatFence,
  generateLockId,
  hashKey,
  makeStorageKey,
} from "../../../common/crypto.js";
import { LockError } from "../../../common/errors.js";

describe("generateLockId", () => {
  it("should generate 22-character base64url string", () => {
    const lockId = generateLockId();

    expect(lockId.length).toBe(22);
    expect(lockId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("should generate unique values", () => {
    const ids = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      ids.add(generateLockId());
    }

    // All should be unique
    expect(ids.size).toBe(1000);
  });

  it("should not contain standard base64 characters", () => {
    for (let i = 0; i < 100; i++) {
      const lockId = generateLockId();

      expect(lockId).not.toContain("+");
      expect(lockId).not.toContain("/");
      expect(lockId).not.toContain("=");
    }
  });
});

describe("makeStorageKey", () => {
  it("should preserve user key when no truncation needed", () => {
    const userKey = "resource:payment:12345";

    // Redis-style (prefix with reserve for derived keys)
    const redisReserve = 25; // "id:" + 22-char lockId
    const redisKey = makeStorageKey("test", userKey, 1000, redisReserve);

    // Firestore-style (no prefix, no reserve)
    const firestoreKey = makeStorageKey("", userKey, 1500, 0);

    expect(redisKey).toBe("test:resource:payment:12345");
    expect(firestoreKey).toBe(userKey);
  });

  it("should hash keys that exceed backend limits", () => {
    const longKey = "x".repeat(2000);
    const redisReserve = 25;

    const redisKey = makeStorageKey("test", longKey, 1000, redisReserve);
    const firestoreKey = makeStorageKey("", longKey, 1500, 0);

    // When truncation occurs, both should use hashed form (base64url)
    expect(redisKey.length).toBeLessThanOrEqual(1000 - redisReserve);
    expect(firestoreKey.length).toBeLessThanOrEqual(1500);
    // Hashed keys use base64url chars
    expect(redisKey).toMatch(/^test:[A-Za-z0-9_-]+$/);
    expect(firestoreKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("should derive fence keys from base storage key (two-step pattern)", () => {
    const userKey = "resource:critical:operation";

    // Redis: two-step derivation
    const redisReserve = 25;
    const redisBaseKey = makeStorageKey("test", userKey, 1000, redisReserve);
    const redisFenceKey = makeStorageKey(
      "test",
      `fence:${redisBaseKey}`,
      1000,
      redisReserve,
    );

    // Firestore: two-step derivation
    const firestoreBaseKey = makeStorageKey("", userKey, 1500, 0);
    const firestoreFenceDocId = makeStorageKey(
      "",
      `fence:${firestoreBaseKey}`,
      1500,
      0,
    );

    // Verify both backends use two-step pattern
    expect(redisFenceKey).toContain("fence:");
    expect(firestoreFenceDocId).toContain("fence:");
  });

  it("should ensure 1:1 mapping for long keys with hash truncation", () => {
    const longKey = "x".repeat(2000);
    const redisReserve = 25;

    const redisBaseLong = makeStorageKey("test", longKey, 1000, redisReserve);
    const redisFenceLong = makeStorageKey(
      "test",
      `fence:${redisBaseLong}`,
      1000,
      redisReserve,
    );
    const firestoreBaseLong = makeStorageKey("", longKey, 1500, 0);
    const firestoreFenceLong = makeStorageKey(
      "",
      `fence:${firestoreBaseLong}`,
      1500,
      0,
    );

    // Both backends ensure keys stay within limits
    expect(redisBaseLong.length).toBeLessThanOrEqual(1000 - redisReserve);
    expect(redisFenceLong.length).toBeLessThanOrEqual(1000 - redisReserve);
    expect(firestoreBaseLong.length).toBeLessThanOrEqual(1500);
    expect(firestoreFenceLong.length).toBeLessThanOrEqual(1500);
  });

  it("should strip trailing colons from prefix", () => {
    const key = "resource";

    // Both should produce the same result
    const withColon = makeStorageKey("prefix:", key, 1000, 0);
    const withoutColon = makeStorageKey("prefix", key, 1000, 0);

    expect(withColon).toBe("prefix:resource");
    expect(withoutColon).toBe("prefix:resource");
  });

  it("should throw on empty key", () => {
    expect(() => makeStorageKey("test", "", 1000, 0)).toThrow(
      "Key must not be empty",
    );
  });

  it("should throw when prefix exceeds backend limit", () => {
    const longPrefix = "x".repeat(500);
    expect(() => makeStorageKey(longPrefix, "key", 100, 0)).toThrow(
      "Prefix exceeds backend limit",
    );
  });
});

describe("hashKey", () => {
  it("should produce 24-character hex string", () => {
    const hash = hashKey("test-key");

    expect(hash.length).toBe(24);
    expect(hash).toMatch(/^[0-9a-f]{24}$/);
  });

  it("should be deterministic", () => {
    const hash1 = hashKey("same-key");
    const hash2 = hashKey("same-key");

    expect(hash1).toBe(hash2);
  });

  it("should produce different hashes for different keys", () => {
    const hash1 = hashKey("key-one");
    const hash2 = hashKey("key-two");

    expect(hash1).not.toBe(hash2);
  });

  it("should normalize Unicode before hashing", () => {
    // Composed form: café (U+00E9)
    const composed = "café";
    // Decomposed form: cafe + combining acute accent (U+0301)
    const decomposed = "cafe\u0301";

    const hash1 = hashKey(composed);
    const hash2 = hashKey(decomposed);

    // Both should produce same hash after NFC normalization
    expect(hash1).toBe(hash2);
  });

  it("should handle empty string", () => {
    const hash = hashKey("");

    expect(hash.length).toBe(24);
    expect(hash).toMatch(/^[0-9a-f]{24}$/);
  });

  it("should handle Unicode characters", () => {
    const hash = hashKey("🔒锁鍵");

    expect(hash.length).toBe(24);
    expect(hash).toMatch(/^[0-9a-f]{24}$/);
  });

  it("should handle very long keys", () => {
    const longKey = "x".repeat(10000);
    const hash = hashKey(longKey);

    expect(hash.length).toBe(24);
    expect(hash).toMatch(/^[0-9a-f]{24}$/);
  });

  it("should have good distribution (no obvious patterns)", () => {
    const hashes = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      hashes.add(hashKey(`key-${i}`));
    }

    // All should be unique (collision resistance)
    expect(hashes.size).toBe(1000);
  });
});

describe("formatFence", () => {
  it("should format number as 15-digit zero-padded string", () => {
    expect(formatFence(1)).toBe("000000000000001");
    expect(formatFence(42)).toBe("000000000000042");
    expect(formatFence(123456789)).toBe("000000123456789");
  });

  it("should format bigint correctly", () => {
    expect(formatFence(1n)).toBe("000000000000001");
    expect(formatFence(999999999999999n)).toBe("999999999999999");
  });

  it("should handle zero", () => {
    expect(formatFence(0)).toBe("000000000000000");
    expect(formatFence(0n)).toBe("000000000000000");
  });

  it("should handle maximum 15-digit value", () => {
    expect(formatFence(999_999_999_999_999)).toBe("999999999999999");
    expect(formatFence(999_999_999_999_999n)).toBe("999999999999999");
  });

  it("should truncate floating point numbers", () => {
    expect(formatFence(42.9)).toBe("000000000000042");
    expect(formatFence(42.1)).toBe("000000000000042");
  });

  it("should throw for negative values", () => {
    expect(() => formatFence(-1)).toThrow(LockError);
    expect(() => formatFence(-1)).toThrow("Fence must be non-negative");
    expect(() => formatFence(-1n)).toThrow("Fence must be non-negative");
  });

  it("should throw for values exceeding 15-digit limit", () => {
    expect(() => formatFence(1_000_000_000_000_000)).toThrow(LockError);
    expect(() => formatFence(1_000_000_000_000_000)).toThrow(
      /exceeds 15-digit limit/,
    );
    expect(() => formatFence(1_000_000_000_000_000n)).toThrow(
      /exceeds 15-digit limit/,
    );
  });

  it("should produce lexicographically sortable strings", () => {
    const fences = [42, 1, 999, 100, 5].map(formatFence);
    const sorted = [...fences].sort();

    expect(sorted).toEqual([
      "000000000000001",
      "000000000000005",
      "000000000000042",
      "000000000000100",
      "000000000000999",
    ]);
  });

  it("should work with string comparison for ordering", () => {
    const fence1 = formatFence(100);
    const fence2 = formatFence(200);
    const fence3 = formatFence(50);

    expect(fence1 < fence2).toBe(true);
    expect(fence1 > fence3).toBe(true);
    expect(fence2 > fence1).toBe(true);
    expect(fence3 < fence1).toBe(true);
  });
});
