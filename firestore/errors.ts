// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { LockError } from "../common/backend.js";

/**
 * Internal error type used to signal non-retryable abort from within Firestore transactions.
 * When thrown inside a transaction callback, Firestore will not retry the transaction.
 * This prevents infinite retry loops when AbortSignal is triggered.
 *
 * @internal Used only within Firestore operation implementations
 */
export class FirestoreAbortError extends Error {
  readonly __firestoreAbortMarker = true;

  constructor(message: string = "Operation aborted by signal") {
    super(message);
    this.name = "FirestoreAbortError";
  }
}

/**
 * Checks if an AbortSignal has been aborted and throws FirestoreAbortError if so.
 * Use this inside Firestore transaction callbacks to prevent automatic retries.
 *
 * @param signal - Optional AbortSignal to check
 * @throws FirestoreAbortError if signal is aborted (non-retryable by Firestore)
 * @internal Used by Firestore operation implementations
 */
export function checkAbortedForTransaction(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FirestoreAbortError();
  }
}

/**
 * Maps Firestore SDK errors to standardized LockError codes.
 *
 * @param error - Firestore SDK error or string
 * @returns LockError with appropriate code and context
 * @see specs/interface.md
 */
export function mapFirestoreError(error: any): LockError {
  // Handle internal abort error (check multiple properties for maximum robustness)
  if (
    error instanceof FirestoreAbortError ||
    error?.__firestoreAbortMarker === true ||
    error?.name === "FirestoreAbortError"
  ) {
    return new LockError("Aborted", "Operation aborted by signal");
  }

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

  // Network timeout errors
  if (errorMessage.includes("DEADLINE_EXCEEDED")) {
    return new LockError(
      "NetworkTimeout",
      `Firestore timeout: ${errorMessage}`,
      { cause: error },
    );
  }

  // Transaction timeout errors (Firestore emulator can cause long transaction retries)
  if (
    errorMessage.includes("invalid or closed") ||
    errorMessage.includes("Transaction is invalid")
  ) {
    return new LockError(
      "NetworkTimeout",
      `Firestore transaction timeout: ${errorMessage}`,
      { cause: error },
    );
  }

  // ABORTED treated as transient - transaction conflicts are retryable
  if (
    errorMessage.includes("UNAVAILABLE") ||
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
