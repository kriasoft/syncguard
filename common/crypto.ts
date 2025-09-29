// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { LockError } from "./errors.js";
import type { HashId } from "./types.js";

/**
 * Generates cryptographically strong lock ID (22-char base64url from 16 CSPRNG bytes).
 * @returns 22-character base64url encoded lock identifier
 * @throws {LockError} "Internal" if no CSPRNG available
 */
export function generateLockId(): string {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Base64url encoding: + → -, / → _, strip padding
    return btoa(String.fromCharCode.apply(null, Array.from(bytes)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  throw new LockError(
    "Internal",
    "No secure random number generator available",
  );
}

/**
 * Canonical 96-bit hash for user keys (NFC normalized, 24 hex chars).
 * Collision probability: ~6.3e-12 at 10^9 distinct IDs.
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
 * Formats fence token as 19-digit zero-padded string for lexicographic ordering.
 * Internal helper - backends use this for consistent fence formatting.
 * @param value - Fence counter (bigint or number)
 * @returns 19-digit string (e.g., "0000000000000000001")
 */
export function formatFence(value: bigint | number): string {
  return String(value).padStart(19, "0");
}

/**
 * Generates backend storage key with automatic hash truncation when exceeding limits.
 * @param prefix - Backend namespace (e.g., "syncguard")
 * @param userKey - User-provided key (already normalized/validated)
 * @param backendLimit - Max storage key length in characters
 * @returns Storage key, hash-truncated if `prefix:userKey` exceeds limit
 * @throws {LockError} "InvalidArgument" if even `prefix:hash` exceeds limit
 * @see specs/adrs.md ADR-006
 */
export function makeStorageKey(
  prefix: string,
  userKey: string,
  backendLimit: number,
): string {
  // Auto-add colon separator if prefix exists and doesn't end with one
  const separator = prefix && !prefix.endsWith(":") ? ":" : "";
  const prefixedKey = prefix ? `${prefix}${separator}${userKey}` : userKey;

  if (prefixedKey.length <= backendLimit) {
    return prefixedKey;
  }

  // Truncate using 24-char hash when full key exceeds limit
  const hash = hashKey(userKey);
  const storageKey = prefix ? `${prefix}${separator}${hash}` : hash;

  if (storageKey.length > backendLimit) {
    throw new LockError(
      "InvalidArgument",
      "Key exceeds backend limits even after truncation",
    );
  }

  return storageKey;
}
