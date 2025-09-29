// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { LockError } from "../common/backend.js";

/**
 * Maps Redis client errors to standardized LockError codes.
 *
 * @param error - Redis client error or string
 * @returns LockError with appropriate code and context
 * @see specs/interface.md
 */
export function mapRedisError(error: any): LockError {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Connection and network errors
  if (
    errorMessage.includes("ECONNRESET") ||
    errorMessage.includes("ENOTFOUND") ||
    errorMessage.includes("ECONNREFUSED") ||
    errorMessage.includes("timeout")
  ) {
    return new LockError(
      "ServiceUnavailable",
      `Redis connection error: ${errorMessage}`,
      { cause: error },
    );
  }

  // Authentication errors
  if (
    errorMessage.includes("NOAUTH") ||
    errorMessage.includes("WRONGPASS") ||
    errorMessage.includes("NOPERM")
  ) {
    return new LockError(
      "AuthFailed",
      `Redis authentication error: ${errorMessage}`,
      { cause: error },
    );
  }

  // Command errors
  if (
    errorMessage.includes("WRONGTYPE") ||
    errorMessage.includes("SYNTAX") ||
    errorMessage.includes("INVALID")
  ) {
    return new LockError(
      "InvalidArgument",
      `Redis command error: ${errorMessage}`,
      { cause: error },
    );
  }

  // Script errors
  if (errorMessage.includes("SCRIPT_ERROR")) {
    return new LockError("Internal", `Redis script error: ${errorMessage}`, {
      cause: error,
    });
  }

  // Default to Internal for unknown errors
  return new LockError("Internal", `Redis error: ${errorMessage}`, {
    cause: error,
  });
}
