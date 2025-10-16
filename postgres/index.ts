// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import { lock } from "../common/auto-lock.js";
import type { AcquisitionOptions, LockConfig } from "../common/types.js";
import { createPostgresBackend } from "./backend.js";
import type { PostgresBackendOptions } from "./types.js";

/**
 * PostgreSQL backend for SyncGuard distributed locking.
 *
 * Uses postgres.js (porsager/postgres) for transaction-based locking
 * with table storage, server-side time authority, and fence tokens.
 *
 * @module syncguard/postgres
 */

/**
 * Creates distributed lock with PostgreSQL backend via postgres.js client
 * @param sql - postgres.js SQL instance
 * @param options - Table names, cleanup, and auto-create config
 * @returns Auto-managed lock function (see: common/auto-lock.ts)
 */
export async function createLock(
  sql: Sql,
  options: PostgresBackendOptions = {},
) {
  const backend = await createPostgresBackend(sql, options);
  return <T>(
    fn: () => Promise<T> | T,
    config: LockConfig & { acquisition?: AcquisitionOptions },
  ): Promise<T> => {
    return lock(backend, fn, config);
  };
}

// Re-exports for custom backend implementations
export { createPostgresBackend } from "./backend.js";
export type {
  PostgresBackendOptions,
  PostgresCapabilities,
  PostgresConfig,
} from "./types.js";
