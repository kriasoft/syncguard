// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { LockError } from "../common/backend.js";

/**
 * Maps Firestore SDK errors to standardized LockError codes.
 *
 * @param error - Firestore SDK error or string
 * @returns LockError with appropriate code and context
 * @see specs/interface.md
 */
export function mapFirestoreError(error: any): LockError {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Authentication and authorization errors
  if (
    errorMessage.includes("PERMISSION_DENIED") ||
    errorMessage.includes("UNAUTHENTICATED")
  ) {
    return new LockError(
      "AuthFailed",
      `Firestore auth error: ${errorMessage}`,
      { cause: error },
    );
  }

  // ABORTED treated as transient - transaction conflicts are retryable
  if (
    errorMessage.includes("UNAVAILABLE") ||
    errorMessage.includes("DEADLINE_EXCEEDED") ||
    errorMessage.includes("INTERNAL") ||
    errorMessage.includes("ABORTED")
  ) {
    return new LockError(
      "ServiceUnavailable",
      `Firestore service error: ${errorMessage}`,
      { cause: error },
    );
  }

  // Request validation errors
  if (
    errorMessage.includes("INVALID_ARGUMENT") ||
    errorMessage.includes("FAILED_PRECONDITION")
  ) {
    return new LockError(
      "InvalidArgument",
      `Firestore validation error: ${errorMessage}`,
      { cause: error },
    );
  }

  // Rate limiting
  if (errorMessage.includes("RESOURCE_EXHAUSTED")) {
    return new LockError(
      "RateLimited",
      `Firestore rate limit: ${errorMessage}`,
      { cause: error },
    );
  }

  // Default to Internal for all unmapped error codes
  return new LockError("Internal", `Firestore error: ${errorMessage}`, {
    cause: error,
  });
}
