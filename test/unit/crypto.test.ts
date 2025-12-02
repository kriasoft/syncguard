// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for crypto utilities (makeStorageKey, generateLockId, etc.)
 */

import { describe, expect, it } from "bun:test";
import {
  formatFence,
  generateLockId,
  hashKey,
  makeStorageKey,
} from "../../common/crypto.js";

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
    // Hashed keys don't contain "xxxx" patterns - they use base64url chars
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

describe("generateLockId", () => {
  it("should generate 22-character base64url lock IDs", () => {
    const lockId = generateLockId();
    expect(lockId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("should generate unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateLockId());
    }
    expect(ids.size).toBe(100);
  });
});

describe("hashKey", () => {
  it("should produce 24-character hex hash", () => {
    const hash = hashKey("test-key");
    expect(hash).toMatch(/^[0-9a-f]{24}$/);
  });

  it("should produce deterministic output", () => {
    const hash1 = hashKey("same-key");
    const hash2 = hashKey("same-key");
    expect(hash1).toBe(hash2);
  });

  it("should produce different hashes for different keys", () => {
    const hash1 = hashKey("key-1");
    const hash2 = hashKey("key-2");
    expect(hash1).not.toBe(hash2);
  });
});

describe("formatFence", () => {
  it("should format fence as 15-digit zero-padded string", () => {
    expect(formatFence(1)).toBe("000000000000001");
    expect(formatFence(123456)).toBe("000000000123456");
    expect(formatFence(999999999999999n)).toBe("999999999999999");
  });

  it("should throw on negative values", () => {
    expect(() => formatFence(-1)).toThrow("non-negative");
  });

  it("should throw on values exceeding 15 digits", () => {
    expect(() => formatFence(1000000000000000n)).toThrow("exceeds 15-digit");
  });
});
