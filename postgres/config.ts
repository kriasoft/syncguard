// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { LockError } from "../common/backend.js";
import type { PostgresBackendOptions, PostgresConfig } from "./types.js";

/**
 * Creates and validates PostgreSQL backend configuration.
 *
 * @param options - User-provided configuration options
 * @returns Validated configuration with defaults applied
 * @throws {LockError} If configuration is invalid
 */
export function createPostgresConfig(
  options: PostgresBackendOptions = {},
): PostgresConfig {
  const tableName = options.tableName || "syncguard_locks";
  const fenceTableName = options.fenceTableName || "syncguard_fence_counters";
  const cleanupInIsLocked = options.cleanupInIsLocked ?? false;

  // Validate: fence table must differ from lock table
  if (fenceTableName === tableName) {
    throw new LockError(
      "InvalidArgument",
      "Fence counter table must differ from lock table to prevent accidental deletion",
    );
  }

  // Validate: table names are non-empty
  if (!tableName || !fenceTableName) {
    throw new LockError(
      "InvalidArgument",
      "Table names must be non-empty strings",
    );
  }

  // Validate: basic SQL identifier safety (prevent obvious injection attempts)
  const sqlIdentifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!sqlIdentifierPattern.test(tableName)) {
    throw new LockError(
      "InvalidArgument",
      "Invalid table name - must be a valid SQL identifier",
    );
  }
  if (!sqlIdentifierPattern.test(fenceTableName)) {
    throw new LockError(
      "InvalidArgument",
      "Invalid fence table name - must be a valid SQL identifier",
    );
  }

  return {
    tableName,
    fenceTableName,
    cleanupInIsLocked,
    onReleaseError: options.onReleaseError,
    disposeTimeoutMs: options.disposeTimeoutMs,
  };
}
