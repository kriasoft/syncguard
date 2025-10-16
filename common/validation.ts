// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { MAX_KEY_LENGTH_BYTES } from "./constants.js";
import { LockError } from "./errors.js";

/**
 * Validates lock ID format (22 base64url characters from 16 bytes CSPRNG).
 * Client-side validation for immediate feedback before backend operations.
 * Prevents round-trip latency for malformed inputs.
 *
 * @param lockId - Lock identifier to validate
 * @throws {LockError} InvalidArgument for format violations (empty, wrong length, invalid characters)
 * @see specs/interface.md#acquire-operation-requirements - Normative lockId validation requirement
 * @see specs/interface.md#security-considerations - Lock ID security and CSPRNG requirements
 */
export function validateLockId(lockId: string): void {
  if (
    !lockId ||
    typeof lockId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(lockId)
  ) {
    throw new LockError(
      "InvalidArgument",
      `Invalid lockId format. Expected 22 base64url characters, got: ${lockId || "empty/null"}`,
    );
  }
}

/**
 * Normalizes key to Unicode NFC and validates length constraints.
 * Prevents encoding-based key collisions (e.g., "café" vs "cafe\u0301").
 *
 * @param key - User-provided lock key
 * @returns Normalized key safe for backend storage
 * @throws {LockError} InvalidArgument for empty/oversized keys (max 512 bytes after NFC normalization)
 * @see specs/interface.md#core-constants - Normative MAX_KEY_LENGTH_BYTES requirement
 * @see common/constants.ts - MAX_KEY_LENGTH_BYTES constant definition
 */
export function normalizeAndValidateKey(key: string): string {
  if (typeof key !== "string") {
    throw new LockError("InvalidArgument", "Key must be a string");
  }

  if (key.length === 0) {
    throw new LockError("InvalidArgument", "Key must not be empty");
  }

  const normalized = key.normalize("NFC");
  const utf8Bytes = new TextEncoder().encode(normalized);

  if (utf8Bytes.length > MAX_KEY_LENGTH_BYTES) {
    throw new LockError(
      "InvalidArgument",
      `Key exceeds maximum length of ${MAX_KEY_LENGTH_BYTES} bytes after normalization`,
    );
  }

  return normalized;
}
