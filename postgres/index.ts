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
 * Creates distributed lock with PostgreSQL backend via postgres.js client.
 *
 * IMPORTANT: Call setupSchema() once before creating locks to set up schema.
 *
 * @param sql - postgres.js SQL instance
 * @param options - Table names and cleanup config
 * @returns Auto-managed lock function (see: common/auto-lock.ts)
 *
 * @example
 * ```typescript
 * import postgres from 'postgres';
 * import { createLock, setupSchema } from 'syncguard/postgres';
 *
 * const sql = postgres('postgresql://localhost:5432/myapp');
 *
 * // Setup schema (once, during initialization)
 * await setupSchema(sql);
 *
 * // Create lock function (synchronous)
 * const lock = createLock(sql);
 *
 * // Use lock
 * await lock(async () => {
 *   // Your code here
 * }, { key: 'my-lock', ttlMs: 30_000 });
 * ```
 */
export function createLock(sql: Sql, options: PostgresBackendOptions = {}) {
  const backend = createPostgresBackend(sql, options);
  return <T>(
    fn: () => Promise<T> | T,
    config: LockConfig & { acquisition?: AcquisitionOptions },
  ): Promise<T> => {
    return lock(backend, fn, config);
  };
}

// Re-exports for custom backend implementations
export { createPostgresBackend } from "./backend.js";
export { setupSchema } from "./schema.js";
export type {
  PostgresBackendOptions,
  PostgresCapabilities,
  PostgresConfig,
} from "./types.js";
