// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { createHash, randomBytes } from "node:crypto";
import { LockError } from "./errors.js";
import type { HashId } from "./types.js";

// Reusable TextEncoder instance (stateless, safe to share)
const encoder = new TextEncoder();

// Separator constant for storage key generation
const SEPARATOR = ":" as const;

/**
 * Converts bytes to base64url encoding (Node.js/Bun only).
 * @param bytes - Input bytes to encode
 * @returns Base64url string (padding removed, +/→-_)
 */
function toBase64Url(bytes: Uint8Array): string {
  // Buffer is available in Node.js and Bun
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Generates cryptographically strong lock ID (22-char base64url from 16 CSPRNG bytes).
 * @returns 22-character base64url encoded lock identifier
 */
export function generateLockId(): string {
  return toBase64Url(randomBytes(16));
}

/**
 * Canonical 96-bit hash for user keys (NFC normalized, 24 hex chars).
 * Collision probability: ~6.3e-12 at 10^9 distinct IDs.
 *
 * @remarks **Non-cryptographic hash for observability only.**
 * This function uses a fast, non-cryptographic hash algorithm suitable for
 * sanitization, telemetry, and UI display. Do NOT use for security-sensitive
 * collision resistance or any cryptographic purposes.
 *
 * @param value - User-provided key string
 * @returns 24-character hex hash identifier
 */
export function hashKey(value: string): HashId {
  const normalizedValue = value.normalize("NFC");

  // Triple-hash for collision resistance (3x32-bit = 96 bits)
  let h1 = 0,
    h2 = 0,
    h3 = 0;

  for (let i = 0; i < normalizedValue.length; i++) {
    const char = normalizedValue.charCodeAt(i);
    h1 = ((h1 << 5) - h1 + char) | 0;
    h2 = ((h2 << 7) - h2 + char * 3) | 0;
    h3 = ((h3 << 11) - h3 + char * 7) | 0;
  }

  const p1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const p2 = (h2 >>> 0).toString(16).padStart(8, "0");
  const p3 = (h3 >>> 0).toString(16).padStart(8, "0");

  return (p1 + p2 + p3).slice(0, 24);
}

/**
 * Formats fence token as 15-digit zero-padded string for lexicographic ordering.
 * Internal helper - backends use this for consistent fence formatting.
 * 15-digit format guarantees full safety within Lua's 53-bit precision limit
 * (2^53-1 ≈ 9.007e15) while providing 10^15 capacity (~31.7 years at 1M locks/sec).
 * @param value - Fence counter (bigint or number)
 * @returns 15-digit string (e.g., "000000000000001")
 * @throws {LockError} "InvalidArgument" if value is negative or exceeds 15-digit limit
 */
export function formatFence(value: bigint | number): string {
  // Convert to bigint and enforce integer + range
  const n = typeof value === "number" ? BigInt(Math.trunc(value)) : value;

  if (n < 0n) {
    throw new LockError("InvalidArgument", "Fence must be non-negative");
  }

  if (n > 999_999_999_999_999n) {
    // 15 digits max (10^15 - 1)
    throw new LockError(
      "InvalidArgument",
      `Fence exceeds 15-digit limit: ${n}`,
    );
  }

  return n.toString().padStart(15, "0");
}

/**
 * SHA-256 hash function (Node.js/Bun only).
 * @param data - Input bytes to hash
 * @returns SHA-256 digest as bytes (32 bytes)
 */
function sha256Sync(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

/**
 * Canonical storage key generation algorithm (NORMATIVE).
 * NORMATIVE: All backends MUST use this algorithm (or a byte-for-byte equivalent).
 *
 * This is the single source of truth for storage key generation across all backends.
 * All backends MUST use this function; custom implementations are FORBIDDEN.
 *
 * **Requirements:**
 * - Measures byte length (UTF-8), not string length, for accurate backend limit checks
 * - Reserves bytes for backend suffixes (e.g., ":id:" + 22-char lockId ≈ 26 bytes) to prevent derived key overflows
 * - Hashes the FULL prefixed key when truncation is required to preserve namespace boundaries and avoid collisions
 * - Uses base64url encoding for hashed output compactness (128 bits → 22 chars vs. 32 hex chars)
 * - Normalizes key to Unicode NFC form for canonical hashing
 * - Fails fast if prefix + reserve makes valid keys impossible
 * - Uses fixed 128-bit hash truncation for strong collision resistance (~2.8e-39 prob at 10^9 keys)
 * - Synchronous implementation for Node.js/Bun (no async overhead)
 * - O(1) performance: Negligible for small keys (TextEncoder/hash/loop are fast)
 *
 * **Two-Step Fence Key Pattern**: When generating fence keys, backends MUST:
 * 1. Compute base storage key: `baseKey = makeStorageKey(prefix, userKey, limit, reserve)`
 * 2. Derive fence key from base: `fenceKey = makeStorageKey(prefix, "fence:${baseKey}", limit, reserve)`
 *
 * This ensures 1:1 mapping between user keys and fence counters when hash truncation occurs.
 *
 * @param prefix - Backend-specific prefix (e.g., "syncguard"); can be empty
 * @param key - User-provided key; MUST NOT be empty (validated upstream)
 * @param backendLimitBytes - Backend-specific byte limit (e.g., 1500 for Firestore, 1000 for Redis)
 * @param reserveBytes - Bytes reserved for suffixes in derived keys (e.g., Redis index/fence keys)
 * @returns Storage key, truncated/hashed if necessary
 * @throws {LockError} "InvalidArgument" if prefix + reserve exceeds limit, or if even hashed form exceeds limit
 * @see specs/interface.md#storage-key-generation - Normative specification
 * @see specs/interface.md#fence-key-derivation - Two-step fence key pattern
 * @see specs/adrs.md ADR-006 - Mandatory uniform key truncation rationale
 */
export function makeStorageKey(
  prefix: string,
  key: string,
  backendLimitBytes: number,
  reserveBytes: number,
): string {
  // Validate key is not empty
  if (!key) {
    throw new LockError("InvalidArgument", "Key must not be empty");
  }

  // Always normalize for canonical form; done here to ensure safety even if caller forgets
  key = key.normalize("NFC");

  // Strip trailing colon from prefix if present (defensive - prefix shouldn't end with colon)
  while (prefix.endsWith(":")) {
    prefix = prefix.slice(0, -1);
  }

  // Fail fast if config makes valid keys impossible (prioritizes correctness)
  const prefixBytes = encoder.encode(prefix).byteLength;
  const separatorBytes = prefix ? 1 : 0; // ":" is 1 byte (ASCII)
  if (prefixBytes + separatorBytes + reserveBytes > backendLimitBytes) {
    throw new LockError(
      "InvalidArgument",
      "Prefix exceeds backend limit after accounting for reserved bytes. Use a shorter prefix.",
    );
  }

  // Step 1: Try normal prefixed key (byte check)
  const prefixed = prefix ? `${prefix}${SEPARATOR}${key}` : key;
  const prefixedUtf8 = encoder.encode(prefixed); // Encode once, reuse for both checks
  if (prefixedUtf8.byteLength + reserveBytes <= backendLimitBytes) {
    return prefixed;
  }

  // Step 2: Hash full prefixed string (preserves namespace in hash domain; avoids cross-prefix collisions)
  // Reuse prefixedUtf8 from above (already encoded)
  const digestBytes = sha256Sync(prefixedUtf8); // 32-byte SHA-256 digest

  // Fixed 128 bits (16 bytes) for balance: strong safety, compact output
  // Collision probability: ~2.8e-39 at 10^9 distinct keys (per ADR-006)
  const truncatedBytes = digestBytes.subarray(0, 16);

  // Bytes to base64url (strips padding, replaces +/ for URL-safety)
  // Base64url chosen over hex for ~30% space savings in tight limits
  const base64url = toBase64Url(truncatedBytes);

  // Step 3: Construct hashed key
  const storageKey = prefix ? `${prefix}${SEPARATOR}${base64url}` : base64url;

  // Final byte check (safety)
  const storageKeyBytes = encoder.encode(storageKey).byteLength;
  if (storageKeyBytes + reserveBytes > backendLimitBytes) {
    throw new LockError(
      "InvalidArgument",
      "Key exceeds backend limits even after hashing (prefix too long).",
    );
  }

  return storageKey;
}
