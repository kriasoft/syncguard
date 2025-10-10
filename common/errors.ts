// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Thrown by all lock operations for system errors, timeouts, and failures.
 * Use `code` to distinguish error types and `context` for debugging details.
 */
export class LockError extends Error {
  constructor(
    public code:
      | "ServiceUnavailable" // Backend unreachable or returning 5xx
      | "AuthFailed" // Invalid credentials or insufficient permissions
      | "InvalidArgument" // Invalid key/lockId format or configuration
      | "RateLimited" // Backend rate limit exceeded
      | "NetworkTimeout" // Backend operation exceeded timeout
      | "AcquisitionTimeout" // lock() retry loop exceeded timeoutMs
      | "Aborted" // Operation cancelled via AbortSignal
      | "Internal", // Unexpected backend errors or quota limits
    message?: string,
    /** Debugging context: lock key, ID, and underlying error */
    public context?: { key?: string; lockId?: string; cause?: unknown },
  ) {
    super(message ?? code);
    this.name = "LockError";
  }
}
