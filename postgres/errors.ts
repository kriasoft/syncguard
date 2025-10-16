// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { LockError } from "../common/backend.js";

/**
 * PostgreSQL error codes mapped to LockError codes.
 * Based on https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const PG_ERROR_CODE_MAP: Record<string, string> = {
  // Connection errors
  "08000": "ServiceUnavailable", // connection_exception
  "08003": "ServiceUnavailable", // connection_does_not_exist
  "08006": "ServiceUnavailable", // connection_failure
  "08001": "ServiceUnavailable", // sqlclient_unable_to_establish_sqlconnection
  "08004": "ServiceUnavailable", // sqlserver_rejected_establishment_of_sqlconnection

  // Authentication errors
  "28000": "AuthFailed", // invalid_authorization_specification
  "28P01": "AuthFailed", // invalid_password

  // Invalid argument errors
  "22000": "InvalidArgument", // data_exception
  "22001": "InvalidArgument", // string_data_right_truncation
  "22003": "InvalidArgument", // numeric_value_out_of_range
  "22P02": "InvalidArgument", // invalid_text_representation
  "23502": "InvalidArgument", // not_null_violation
  "23503": "InvalidArgument", // foreign_key_violation
  "23514": "InvalidArgument", // check_violation
  "42P01": "InvalidArgument", // undefined_table
  "42703": "InvalidArgument", // undefined_column
  "42883": "InvalidArgument", // undefined_function

  // Transaction conflicts (retry-able)
  "40001": "ServiceUnavailable", // serialization_failure
  "40P01": "ServiceUnavailable", // deadlock_detected
  "40003": "ServiceUnavailable", // statement_completion_unknown

  // Resource exhaustion
  "53000": "RateLimited", // insufficient_resources
  "53100": "RateLimited", // disk_full
  "53200": "RateLimited", // out_of_memory
  "53300": "RateLimited", // too_many_connections

  // Timeout
  "57014": "NetworkTimeout", // query_canceled
};

/**
 * Maps PostgreSQL errors to LockError instances.
 *
 * @param error - Error from postgres.js
 * @returns LockError with appropriate code
 */
export function mapPostgresError(error: unknown): LockError {
  if (error instanceof LockError) {
    return error;
  }

  if (error && typeof error === "object" && "code" in error) {
    const pgError = error as { code: string; message?: string };
    const errorCode = PG_ERROR_CODE_MAP[pgError.code];

    if (errorCode) {
      return new LockError(
        errorCode as
          | "ServiceUnavailable"
          | "AuthFailed"
          | "InvalidArgument"
          | "RateLimited"
          | "NetworkTimeout",
        pgError.message || `PostgreSQL error: ${pgError.code}`,
        { cause: error },
      );
    }
  }

  // Connection/network errors
  if (
    error instanceof Error &&
    (error.message.includes("ECONNREFUSED") ||
      error.message.includes("ENOTFOUND") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("ECONNRESET"))
  ) {
    return new LockError("ServiceUnavailable", error.message, {
      cause: error,
    });
  }

  // Unknown errors
  return new LockError(
    "Internal",
    error instanceof Error ? error.message : "Unknown PostgreSQL error",
    { cause: error },
  );
}

/**
 * Throws LockError("Aborted") if signal is aborted.
 * Used for manual AbortSignal checking since postgres.js doesn't natively support it.
 *
 * @param signal - Optional AbortSignal to check
 * @throws {LockError} With code "Aborted" if signal is aborted
 */
export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LockError("Aborted", "Operation aborted by signal");
  }
}
